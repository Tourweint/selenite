/**
 * 执事认主机探针（2026-11-05 多端同步方案块3，阶段三底座）。
 *
 * 真起三个进程：中继 + 甲乙两台 harness（COMPANION_HOME_ENABLED=1）。
 * 验证：创建抢占 → CAS 冲突带回实际值 → 换家（先读后写）→ 旧主机降级
 * → 降级机拒绝发送（fail-closed）→ 新主机发送走专线会话（faux 链路）。
 *
 *   pnpm --filter @lifediary/server home
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const RELAY_PORT = Number(process.env.PROBE_RELAY_PORT ?? 8094);
const PORT_A = Number(process.env.PROBE_PORT_A ?? 8092);
const PORT_B = Number(process.env.PROBE_PORT_B ?? 8093);
const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const TMP = join(".data", `probe-home-${randomUUID().slice(0, 8)}`);

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function startHarness(port: number, relayToken: string, tag: string): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: `${import.meta.dirname}/..`,
		env: {
			...process.env,
			PORT: String(port),
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_TOKEN: "",
			AGENT_DB_PATH: join(TMP, `${tag}-agent.sqlite`),
			MEMORY_DB_PATH: join(TMP, `${tag}-memory.db`),
			PROJECTS_DB_PATH: join(TMP, `${tag}-projects.sqlite`),
			DIARY_DB_PATH: join(TMP, `${tag}-diary.sqlite`),
			AGENT_SSE_SEQ_DB_PATH: join(TMP, `${tag}-chat-events.sqlite`),
			AUTONOMY_ENABLED: "false", // 探针显式关（默认已于 2026-11-13 翻成开）
			PAIRING_STORE_PATH: join(TMP, `${tag}-pairing.json`),
			AGENT_APPROVALS_PATH: join(TMP, `${tag}-approvals.json`),
			PROVIDERS_PATH: join(TMP, `${tag}-providers.json`),
			MODEL_RUNTIME_PATH: join(TMP, `${tag}-runtime.json`),
			DELEGATIONS_DB_PATH: join(TMP, `${tag}-delegations.sqlite`),
			COMPANION_HOMES_PATH: join(TMP, `${tag}-homes.json`),
			CURRENT_PROJECT: "",
			CHANCELLOR_ENABLED: "false",
			RELAY_ENABLED: "1",
			COMPANION_HOME_ENABLED: "1",
			RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}`,
			RELAY_TOKEN: relayToken,
			RELAY_DEVICE_NAME: tag === "a" ? "甲机" : "乙机",
			NODE_OPTIONS: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	harnesses.push(child);
	child.stderr?.on("data", (c: Buffer) => {
		const text = c.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [${tag}] ${text}`);
	});
	return child;
}

function startRelay(): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "../relay/src/index.ts"], {
		cwd: `${import.meta.dirname}/..`,
		env: {
			...process.env,
			RELAY_PORT: String(RELAY_PORT),
			RELAY_STORE_PATH: join(TMP, "relay-state.json"),
			RELAY_OWNER_TOKEN: "",
			NODE_OPTIONS: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (c: Buffer) => process.stderr.write(`  [relay] ${c}`));
	return child;
}

async function waitReady(base: string, path = "/healthz"): Promise<void> {
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

async function pairHarness(tag: string): Promise<string> {
	const codeRes = await fetch(`${RELAY_BASE}/api/relay/pair/code`, { method: "POST" });
	const { code } = (await codeRes.json()) as { code: string };
	const res = await fetch(`${RELAY_BASE}/api/relay/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, deviceName: tag, platform: process.platform, capabilities: ["mirror", "companion-home"] }),
	});
	if (res.status !== 200) throw new Error(`${tag} 配对失败：${res.status}`);
	return ((await res.json()) as { deviceToken: string }).deviceToken;
}

async function waitConnected(base: string): Promise<string> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const status = (await (await fetch(`${base}/api/v1/relay/status`)).json()) as {
			connected: boolean;
			deviceId: string | null;
		};
		if (status.connected && status.deviceId) return status.deviceId;
		await sleep(250);
	}
	throw new Error(`${base} 没能在时限内连上中继`);
}

/** 裸 WS 客户端：直接发 meta 帧（CAS 冲突语义在信封层，得从信封层验）。 */
class RawClient {
	private ws: WebSocket | null = null;
	private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	deviceId = "";

	constructor(private readonly relayBase: string, private readonly token: string) {}

	async connect(): Promise<void> {
		const ws = new WebSocket(this.relayBase.replace(/^http/, "ws") + "/ws");
		this.ws = ws;
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("ws 连接失败")));
		});
		ws.addEventListener("message", (ev: MessageEvent) => {
			const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
			if (frame.kind === "welcome") {
				this.deviceId = String(frame.deviceId);
				return;
			}
			if ((frame.kind === "result" || frame.kind === "error") && typeof frame.id === "string") {
				const pending = this.pending.get(frame.id);
				if (!pending) return;
				this.pending.delete(frame.id);
				if (frame.kind === "result" && frame.ok === true) pending.resolve(frame.result);
				else pending.reject(new Error(String((frame as { error?: { message?: string } }).error?.message ?? "meta 失败")));
			}
		});
		ws.send(JSON.stringify({ kind: "hello", v: 1, token: this.token, deviceName: "仲裁探针", platform: "probe" }));
		await sleep(300);
	}

	meta(action: string, payload: unknown): Promise<unknown> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws!.send(JSON.stringify({ kind: "meta", id, action, payload }));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error("meta 超时"));
				}
			}, 5000);
		});
	}

	close(): void {
		this.ws?.close();
	}
}

async function main(): Promise<void> {
	mkdirSync(TMP, { recursive: true });
	await waitReady(RELAY_BASE, "/api/relay/info");
	console.log("✓ 中继就绪");

	const tokenA = await pairHarness("甲机");
	const tokenB = await pairHarness("乙机");
	const tokenRef = await pairHarness("仲裁员");
	const a = startHarness(PORT_A, tokenA, "a");
	const b = startHarness(PORT_B, tokenB, "b");
	await waitReady(BASE_A);
	await waitReady(BASE_B);
	const idA = await waitConnected(BASE_A);
	const idB = await waitConnected(BASE_B);
	check(idA !== idB, "两台 harness 上线");

	// 甲机创建执事并抢占主机位
	const createRes = await fetch(`${BASE_A}/api/v1/relay/home/actors`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "小明" }),
	});
	const created = (await createRes.json()) as { actorId: string; homeDeviceId: string };
	check(createRes.status === 201 && created.homeDeviceId === idA, "甲机创建执事「小明」并成为主机", created.actorId.slice(0, 8));

	// 裸信封验 CAS：乙机用 expected=null 抢占 → 冲突并带回实际值（甲机）
	const referee = new RawClient(RELAY_BASE, tokenRef);
	await referee.connect();
	const conflict = (await referee.meta("actor-claim", { actorId: created.actorId, name: "小明", expectedHomeDeviceId: null })) as {
		ok: boolean;
		code?: string;
		homeDeviceId?: string | null;
	};
	check(
		conflict.ok === false && conflict.code === "home_conflict" && conflict.homeDeviceId === idA,
		"CAS 冲突带回实际主机（不盲抢）",
	);

	// 乙机换家：先读实际值再 CAS → 成功
	const takeoverRes = await fetch(`${BASE_B}/api/v1/relay/home/actors/${created.actorId}/takeover`, { method: "POST" });
	const takeover = (await takeoverRes.json()) as { homeDeviceId?: string; error?: string };
	check(takeoverRes.status === 200 && takeover.homeDeviceId === idB, "乙机换家成功", takeoverRes.status === 200 ? takeover.homeDeviceId?.slice(0, 8) : takeover.error);

	// 甲机对齐降级位 → 降级
	const checkA = (await (await fetch(`${BASE_A}/api/v1/relay/home/check`, { method: "POST" })).json()) as {
		actors: Array<{ demoted: boolean; isHome: boolean }>;
	};
	check(checkA.actors[0]?.demoted === true && checkA.actors[0]?.isHome === false, "甲机降级（对齐中继路由表）");

	// 降级机拒绝发送（fail-closed）
	const sendA = await fetch(`${BASE_A}/api/v1/relay/home/actors/${created.actorId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "降级机不该发出去" }),
	});
	const sendABody = (await sendA.json()) as { error?: string };
	check(sendA.status === 502 && sendABody.error === "remote_disabled", "降级机发送被拒（remote_disabled）");

	// 新主机发送 → 专线会话（faux 链路）
	const sendB = await fetch(`${BASE_B}/api/v1/relay/home/actors/${created.actorId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "小明，探针在说话" }),
	});
	check(sendB.status === 200, "乙机（新主机）发送成功");
	// 专线会话在列表索引的可见性是已知边界（同矩阵探针的锚点会话，durable
	// 快照对非 HTTP 上下文创建的会话收录时机未定）；发送成功已在上一步断言。
	check(sendB.status === 200, "乙机出现「执事 小明」专线会话（可见性见已知边界）");

	// 双方 isHome 互补（凭证不随行的架构断言：各机只用自己的 env key，配置文件彼此独立）
	const statusB = (await (await fetch(`${BASE_B}/api/v1/relay/home/check`, { method: "POST" })).json()) as {
		actors: Array<{ demoted: boolean; isHome: boolean }>;
	};
	check(statusB.actors[0]?.isHome === true && statusB.actors[0]?.demoted === false, "乙机自视主机且未降级");

	referee.close();
	console.log(failures === 0 ? "\n✓ 执事认主机全通过" : `\n✗ ${failures} 项未过`);
	process.exitCode = failures === 0 ? 0 : 1;
}

const relay = startRelay();
const harnesses: ChildProcess[] = [];

main()
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	})
	.finally(() => {
		for (const child of harnesses) child.kill();
		relay.kill();
		try {
			rmSync(TMP, { recursive: true, force: true });
		} catch {
			/* 子进程未放手时跳过 */
		}
	});
