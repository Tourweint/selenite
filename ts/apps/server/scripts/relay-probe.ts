/**
 * 中继链路端到端探针（2026-11-05 多端同步方案块1，阶段一）。
 *
 * 真起两个进程：中继（apps/relay）+ harness（faux 假模型），再加一个
 * 模拟"镜像控制台"的 WebSocket 控制端，全程经中继说话：
 *
 *   配对（加入码）→ harness 上线 → info/probe → sessions/list
 *   → 建会话（loopback HTTP）→ events/subscribe 拿重放
 *   → chat/send 经中继投递 → push/session 收到 faux 回复帧
 *   → 断线重连按 sinceSeq 补帧 → approvals/pending 通道形状
 *
 *   pnpm --filter @lifediary/server relay
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RELAY_PORT = Number(process.env.PROBE_RELAY_PORT ?? 8099);
const HARNESS_PORT = Number(process.env.PROBE_PORT ?? 8098);
const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`;
const HARNESS_BASE = `http://127.0.0.1:${HARNESS_PORT}`;
const TMP = join(".data", `probe-relay-${randomUUID().slice(0, 8)}`);

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function startRelay(): ChildProcess {
	const child = spawn(
		process.execPath,
		["../../node_modules/tsx/dist/cli.mjs", "../relay/src/index.ts"],
		{
			cwd: `${import.meta.dirname}/..`,
			env: {
				...process.env,
				RELAY_PORT: String(RELAY_PORT),
				RELAY_STORE_PATH: join(TMP, "relay-state.json"),
				RELAY_OWNER_TOKEN: "",
				RELAY_CODE_TTL_SECONDS: "120",
				NODE_OPTIONS: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stderr?.on("data", (c: Buffer) => process.stderr.write(`  [relay] ${c}`));
	return child;
}

function startHarness(relayToken: string): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: `${import.meta.dirname}/..`,
		env: {
			...process.env,
			PORT: String(HARNESS_PORT),
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_TOKEN: "",
			AGENT_DB_PATH: join(TMP, "agent.sqlite"),
			MEMORY_DB_PATH: join(TMP, "memory.db"),
			PROJECTS_DB_PATH: join(TMP, "projects.sqlite"),
			DIARY_DB_PATH: join(TMP, "diary.sqlite"),
			AGENT_SSE_SEQ_DB_PATH: join(TMP, "chat-events.sqlite"),
			PAIRING_STORE_PATH: join(TMP, "pairing.json"),
			AGENT_CHAT_META_PATH: join(TMP, "chat-meta.json"),
			AGENT_APPROVALS_PATH: join(TMP, "approvals.json"),
			PROVIDERS_PATH: join(TMP, "providers.json"),
			MODEL_RUNTIME_PATH: join(TMP, "runtime.json"),
			DELEGATIONS_DB_PATH: join(TMP, "delegations.sqlite"),
			CURRENT_PROJECT: "",
			CHANCELLOR_ENABLED: "false",
			RELAY_ENABLED: "1",
			RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}`,
			RELAY_TOKEN: relayToken,
			RELAY_DEVICE_NAME: "探针主机",
			NODE_OPTIONS: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (c: Buffer) => {
		const text = c.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [harness] ${text}`);
	});
	return child;
}

async function waitReady(base: string, path: string): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			const res = await fetch(`${base}${path}`);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error(`没能就绪：${base}${path}`);
}

/** 控制端：走中继 WebSocket 的最小客户端。 */
class ControlClient {
	private ws: WebSocket | null = null;
	private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private pushes: Array<{ channel: string; payload: unknown }> = [];
	private waiters: Array<() => void> = [];
	deviceId = "";

	constructor(private readonly relayBase: string, private readonly token: string) {}

	async connect(): Promise<void> {
		const wsUrl = this.relayBase.replace(/^http/, "ws") + "/ws";
		const ws = new WebSocket(wsUrl);
		this.ws = ws;
		const opened = new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("ws 连接失败")));
		});
		ws.addEventListener("message", (ev: MessageEvent) => {
			const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
			if (frame.kind === "welcome") {
				this.deviceId = String(frame.deviceId);
				const waiter = this.waiters.shift();
				if (waiter) waiter();
				return;
			}
			if (frame.kind === "routed" && String(frame.channel).startsWith("push/")) {
				this.pushes.push({ channel: String(frame.channel), payload: frame.payload });
				const waiter = this.waiters.shift();
				if (waiter) waiter();
				return;
			}
			if ((frame.kind === "result" || frame.kind === "error") && typeof frame.id === "string") {
				const pending = this.pending.get(frame.id);
				if (!pending) return;
				this.pending.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.kind === "result" && frame.ok === true) pending.resolve(frame.result);
				else pending.reject(new Error(`${(frame as { error?: { code?: string } }).error?.code ?? frame.kind}: ${(frame as { error?: { message?: string } }).error?.message ?? ""}`));
			}
		});
		await opened;
		this.ws.send(
			JSON.stringify({ kind: "hello", v: 1, token: this.token, deviceName: "探针控制端", platform: "probe", capabilities: ["mirror"] }),
		);
		await this.waitFor(() => this.deviceId !== "", 5000);
	}

	invoke(dst: string, channel: string, payload: unknown, timeoutMs = 15000): Promise<unknown> {
		const id = randomUUID();
		if (!this.ws) return Promise.reject(new Error("ws 未连接"));
		const ws = this.ws;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${channel} 超时`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify({ kind: "deliver", id, dst, channel, payload }));
		});
	}

	/** 等到下一个 push 帧（或超时）。 */
	async nextPush(timeoutMs = 10000): Promise<{ channel: string; payload: unknown }> {
		const existing = this.pushes.shift();
		if (existing) return existing;
		await this.waitFor(() => this.pushes.length > 0, timeoutMs);
		return this.pushes.shift()!;
	}

	private waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
		if (predicate()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.indexOf(checkFn);
				if (idx >= 0) this.waiters.splice(idx, 1);
				reject(new Error("等待超时"));
			}, timeoutMs);
			timer.unref?.();
			const checkFn = () => {
				if (predicate()) {
					clearTimeout(timer);
					resolve();
					return true;
				}
				this.waiters.push(checkFn);
				return false;
			};
			checkFn();
		});
	}

	close(): void {
		this.ws?.close();
	}
}

/** 走 harness loopback 建一次会话并收完 SSE（faux 链路），返回 conversationId。 */
async function chatOnce(text: string, existingId?: string): Promise<{ conversationId: string; events: string[] }> {
	const res = await fetch(`${HARNESS_BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			messages: [{ role: "user", content: text }],
			...(existingId ? { conversationId: existingId } : {}),
		}),
	});
	if (!res.ok || !res.body) throw new Error(`chat → ${res.status}`);
	const events: string[] = [];
	let conversationId = "";
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const line = frame.split("\n").find((l) => l.startsWith("data:"));
			if (line) {
				try {
					const event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
					events.push(String(event.type));
					if (typeof event.conversationId === "string") conversationId = event.conversationId;
				} catch {
					/* 忽略坏帧 */
				}
			}
			boundary = buffer.indexOf("\n\n");
		}
	}
	return { conversationId, events };
}

async function main(): Promise<void> {
	mkdirSync(TMP, { recursive: true });
	await waitReady(RELAY_BASE, "/api/relay/info");
	console.log(`✓ 中继就绪 :${RELAY_PORT}`);

	// harness 以设备身份配对加入
	const codeRes = await fetch(`${RELAY_BASE}/api/relay/pair/code`, { method: "POST" });
	const { code } = (await codeRes.json()) as { code: string };
	const redeemRes = await fetch(`${RELAY_BASE}/api/relay/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, deviceName: "探针主机", platform: process.platform, capabilities: ["mirror"] }),
	});
	if (redeemRes.status !== 200) throw new Error(`harness 配对失败：${redeemRes.status}`);
	const harnessCreds = (await redeemRes.json()) as { deviceToken: string; deviceId: string };

	harness = startHarness(harnessCreds.deviceToken);
	await waitReady(HARNESS_BASE, "/healthz");

	// 等中继连上（harness 出站长连 + 退避重试）
	let status: { connected: boolean; deviceId: string | null } = { connected: false, deviceId: null };
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const res = await fetch(`${HARNESS_BASE}/api/v1/relay/status`);
		status = (await res.json()) as typeof status;
		if (status.connected) break;
		await sleep(250);
	}
	check(status.connected, "harness 经中继上线（出站长连）", `self=${status.deviceId?.slice(0, 8)}`);

	// 控制端配对 + 上线
	const code2Res = await fetch(`${RELAY_BASE}/api/relay/pair/code`, { method: "POST" });
	const { code: code2 } = (await code2Res.json()) as { code: string };
	const ctrlRes = await fetch(`${RELAY_BASE}/api/relay/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: code2, deviceName: "探针控制端", platform: "probe", capabilities: ["mirror"] }),
	});
	const ctrlCreds = (await ctrlRes.json()) as { deviceToken: string };
	const ctrl = new ControlClient(RELAY_BASE, ctrlCreds.deviceToken);
	await ctrl.connect();
	check(ctrl.deviceId !== "", "控制端经中继上线");

	// 通道：info/probe
	const info = (await ctrl.invoke(status.deviceId!, "info/probe", {})) as { name: string };
	check(info.name === "lifediary-harness", "invoke info/probe", `name=${info.name}`);

	// 未知通道必须被白名单拒绝
	let denied = "";
	try {
		await ctrl.invoke(status.deviceId!, "admin/nuke", {});
	} catch (error) {
		denied = error instanceof Error ? error.message : String(error);
	}
	check(denied.startsWith("channel_not_allowed"), "白名单默认拒绝（channel_not_allowed）", denied.slice(0, 60));

	// 建会话（loopback 直连 harness）
	const first = await chatOnce("探针第一句话");
	check(first.conversationId !== "" && first.events.includes("done"), "faux 链路建会话", `cid=${first.conversationId.slice(0, 8)}`);

	// sessions/list 与事件订阅重放
	const chats = (await ctrl.invoke(status.deviceId!, "sessions/list", { limit: 10 })) as { chats: Array<{ conversationId: string }> };
	check(chats.chats.some((c) => c.conversationId === first.conversationId), "invoke sessions/list 看到会话");

	const sub = (await ctrl.invoke(status.deviceId!, "events/subscribe", { conversationId: first.conversationId, sinceSeq: 0 })) as {
		subscriptionId: string;
		from: number;
		events: Array<{ event: { type: string } }>;
	};
	check(sub.events.length > 0 && sub.events.some((e) => e.event.type === "done"), "events/subscribe 重放历史帧", `${sub.events.length} 帧`);

	// chat/send 经中继投递（投进 durable 队列即算受理；服务端直写的轮次
	// 不进事件重放库——v1 已知边界，见方案 §四阶段一）
	const sendRes = (await ctrl.invoke(status.deviceId!, "chat/send", { conversationId: first.conversationId, text: "探针经中继说一句话" })) as { accepted: boolean };
	check(sendRes.accepted === true, "invoke chat/send 投递成功");
	// 推送帧用同会话的 HTTP 轮次验证（重放库只收 HTTP 发起的轮次）
	const second = await chatOnce("探针的第二句话", first.conversationId);
	check(second.conversationId === first.conversationId, "同会话再走一轮 HTTP 聊天");
	const push = await ctrl.nextPush();
	const pushPayload = push.payload as { conversationId: string; events: Array<{ event: { type: string } }> };
	check(
		pushPayload.conversationId === first.conversationId && pushPayload.events.length > 0,
		"push/session 收到事件帧",
		push.channel,
	);
	// 等到 done 帧（faux 回复完；整轮帧可能一批全到）
	let sawDone = pushPayload.events.some((e) => e.event.type === "done");
	for (let attempt = 0; attempt < 20 && !sawDone; attempt += 1) {
		const next = await ctrl.nextPush();
		sawDone = (next.payload as { events: Array<{ event: { type: string } }> }).events.some((e) => e.event.type === "done");
	}
	check(sawDone, "push 流里等到 done（faux 回复经重放库推达）");

	// approvals/pending 形状
	const approvals = (await ctrl.invoke(status.deviceId!, "approvals/pending", {})) as { approvals: unknown[] };
	check(Array.isArray(approvals.approvals) && approvals.approvals.length === 0, "approvals/pending 通道可用", "空待办");

	// 断线重连 + sinceSeq 补帧
	ctrl.close();
	await sleep(300);
	const ctrl2 = new ControlClient(RELAY_BASE, ctrlCreds.deviceToken);
	await ctrl2.connect();
	const reSub = (await ctrl2.invoke(status.deviceId!, "events/subscribe", { conversationId: first.conversationId, sinceSeq: 1 })) as {
		from: number;
		events: unknown[];
	};
	check(reSub.from === 2 && reSub.events.length >= 1, "重连后 sinceSeq=1 从 2 续播", `from=${reSub.from} n=${reSub.events.length}`);

	ctrl2.close();
	console.log(failures === 0 ? "\n✓ 中继链路全通过" : `\n✗ ${failures} 项未过`);
	process.exitCode = failures === 0 ? 0 : 1;
}

const relay = startRelay();
let harness: ChildProcess | null = null;

main()
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	})
	.finally(() => {
		harness?.kill();
		relay.kill();
		try {
			rmSync(TMP, { recursive: true, force: true });
		} catch {
			/* Windows 上子进程还没放手就先跳过，.data 下的一次性目录 */
		}
	});
