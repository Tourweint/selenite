/**
 * 审批 ask 流探针（2026-11-04 批次二 A1）。
 *
 * 与单测的分工：单测验"判定 / store 语义"，这里验**真装配**——真起服务、真 SSE、真 HTTP 答复，
 * 覆盖开关关 / 批准 / 拒绝 / 超时 / 记住 / 幂等 / 补挂 / 停止 / 重启 / 并行 / 批准前切档。
 *
 * faux 只发一个工具调用（`LLM_FAUX_TOOL=bash` → `{command:"sleep 2"}`），所以批准之后模型还会
 * 再调一次；探针在每个用例结尾用 /stop 收尾，不让后台 run 一直转。
 *
 *   pnpm --filter @lifediary/server approval
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = ".data/probe-approval.sqlite";
const APPROVALS = ".data/probe-approval-approvals.json";
const POLICY = ".data/probe-approval-policy.json";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

interface ApprovalEvent {
	[key: string]: unknown;
	type: "approval";
	callId: string;
	tool: string;
	args: string;
	deadlineAt: string;
}

interface ToolEvent {
	[key: string]: unknown;
	type: "tool";
	name: string;
	status: "start" | "end";
	ok?: boolean;
	output?: string;
}

type SseEvent = { type: string; [key: string]: unknown };

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		PORT: String(PORT),
		LLM_PROVIDER: "faux",
		LLM_API_KEY: "",
		AGENT_TOKEN: "",
		AGENT_DB_PATH: DB,
		MEMORY_ENABLED: "false",
		AGENT_APPROVALS_PATH: APPROVALS,
		AGENT_POLICY_PATH: POLICY,
		AGENT_CHAT_META_PATH: ".data/probe-approval-chat-meta.json",
		CHANCELLOR_ENABLED: "false",
		// faux 只发一个工具调用：没有合法参数时内核在校验阶段就挡掉，根本走不到 beforeTool
		LLM_FAUX_TOOL: "bash",
		// 显式清空：别让开发机上的 env 混进探针
		AGENT_CONFIRM_WRITES: "",
		AGENT_APPROVAL_TIMEOUT_S: "",
		AGENT_BASH_TIMEOUT_S: "900",
		NODE_OPTIONS: "",
		...extra,
	};
}

function startServer(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: baseEnv(extraEnv),
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [server] ${text}`);
	});
	return child;
}

async function waitForReady(): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`${BASE}/healthz`);
			if (response.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("服务没能启动");
}

/** 一条聊天 SSE，按需等某个事件；不并发调用 next()。 */
class ChatStream {
	readonly events: SseEvent[] = [];
	conversationId?: string;
	private cursor = 0;
	private finished = false;
	private readonly waiters = new Set<() => void>();
	private readonly controller = new AbortController();
	readonly finishedPromise: Promise<void>;

	constructor(body: { conversationId?: string; text: string }) {
		this.finishedPromise = this.pump(body);
	}

	/** 已收到的事件条数（配合 since() 做区间断言） */
	snapshot(): number {
		return this.events.length;
	}

	since(index: number): SseEvent[] {
		return this.events.slice(index);
	}

	async next<T extends SseEvent>(
		predicate: (event: SseEvent) => boolean,
		timeoutMs = 10_000,
	): Promise<T | null> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			while (this.cursor < this.events.length) {
				const event = this.events[this.cursor];
				this.cursor += 1;
				if (event && predicate(event)) return event as T;
			}
			const left = deadline - Date.now();
			if (left <= 0 || this.finished) return null;
			await Promise.race([this.changed(), sleep(left)]);
		}
	}

	abort(): void {
		this.controller.abort();
	}

	private changed(): Promise<void> {
		return new Promise((resolve) => this.waiters.add(resolve));
	}

	private push(event: SseEvent): void {
		if (event.type === "start" && typeof event.conversationId === "string") {
			this.conversationId = event.conversationId;
		}
		this.events.push(event);
		for (const wake of this.waiters) wake();
		this.waiters.clear();
	}

	private async pump(body: { conversationId?: string; text: string }): Promise<void> {
		try {
			const response = await fetch(`${BASE}/api/v1/agent/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...(body.conversationId ? { conversationId: body.conversationId } : {}),
					messages: [{ role: "user", content: body.text }],
				}),
				signal: this.controller.signal,
			});
			if (!response.ok || !response.body) return;
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += value;
				let index = buffer.indexOf("\n\n");
				while (index >= 0) {
					const chunk = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					for (const line of chunk.split("\n")) {
						if (!line.startsWith("data:")) continue;
						try {
							this.push(JSON.parse(line.slice(5).trim()) as SseEvent);
						} catch {
							/* 畸形帧忽略 */
						}
					}
					index = buffer.indexOf("\n\n");
				}
			}
		} catch {
			/* 主动 abort / 断线都当流结束 */
		} finally {
			this.finished = true;
			for (const wake of this.waiters) wake();
			this.waiters.clear();
		}
	}
}

async function getPending(conversationId: string): Promise<{ callId: string; tool: string }[]> {
	const response = await fetch(
		`${BASE}/api/v1/agent/approvals?conversationId=${encodeURIComponent(conversationId)}`,
	);
	if (!response.ok) return [];
	const data = (await response.json()) as { approvals?: { callId: string; tool: string }[] };
	return data.approvals ?? [];
}

async function decide(
	callId: string,
	decision: "approve" | "reject",
	remember = false,
): Promise<{ status: number; body: { status?: string; error?: string } }> {
	const response = await fetch(`${BASE}/api/v1/agent/approvals/${encodeURIComponent(callId)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ decision, remember }),
	});
	return { status: response.status, body: (await response.json()) as { status?: string } };
}

async function stop(conversationId: string): Promise<void> {
	await fetch(`${BASE}/api/v1/agent/chat/${encodeURIComponent(conversationId)}/stop`, {
		method: "POST",
	}).catch(() => undefined);
}

async function setPolicy(body: Record<string, unknown>): Promise<number> {
	const response = await fetch(`${BASE}/api/v1/agent/policy`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return response.status;
}

function storedApprovals(): { callId: string; status: string }[] {
	try {
		const parsed = JSON.parse(readFileSync(APPROVALS, "utf8")) as {
			approvals?: { callId: string; status: string }[];
		};
		return parsed.approvals ?? [];
	} catch {
		return [];
	}
}

rmSync(DB, { force: true });
rmSync(APPROVALS, { force: true });
rmSync(POLICY, { force: true });

let server = startServer();

try {
	await waitForReady();

	// ── 1. 开关关：事件序列与改动前一致，而且没有 approval ──
	console.log("\n· 1. confirmWrites 关着 = 零行为变化（事件序列对照）");
	const off = new ChatStream({ text: "跑个命令" });
	await off.next((event) => event.type === "start");
	await off.next((event) => event.type === "tool" && event.status === "end", 15_000);
	const prefix = off.events.slice(0, 5).map((event) => {
		const tool = event as ToolEvent;
		return tool.type === "tool" ? `tool:${tool.status}` : event.type;
	});
	// 对话流先取 tool 再取 progress（chatStream 的固定顺序），这段就是改动前的序列
	check(
		JSON.stringify(prefix) ===
			JSON.stringify(["start", "tool:start", "progress", "tool:end", "progress"]),
		"前五帧与改动前一致",
		prefix.join(","),
	);
	check(!off.events.some((event) => event.type === "approval"), "没有任何 approval 帧");
	const offToolEnd = off.events.find((event) => event.type === "tool" && event.status === "end") as
		| ToolEvent
		| undefined;
	check(offToolEnd?.ok === true, "bash 真的执行成功（默认 900s 超时不杀 sleep 2）");
	await stop(off.conversationId!);
	off.abort();
	await sleep(300);

	// 之后都开着确认；bash 默认 1 秒，用来证明"批准后超时注入还在"
	server.kill();
	await sleep(700);
	server = startServer({ AGENT_CONFIRM_WRITES: "1", AGENT_BASH_TIMEOUT_S: "1" });
	await waitForReady();

	// ── 2. 批准：工具真跑完，且默认超时注入仍在 ──────────
	console.log("\n· 2. 批准 → 工具执行（超时注入保住）+ GET 补挂 + 幂等");
	const approved = new ChatStream({ text: "跑个命令" });
	await approved.next((event) => event.type === "start");
	const approval = await approved.next<ApprovalEvent>((event) => event.type === "approval");
	check(Boolean(approval?.callId), "收到 approval 帧", approval?.callId);
	check(approval?.tool === "bash", "工具名是 bash", approval?.tool);
	check(Boolean(approval?.args.includes("sleep 2")), "args 带上了工具参数", approval?.args);
	check(
		Number.isFinite(Date.parse(approval?.deadlineAt ?? "")),
		"deadlineAt 是 ISO 时间",
		approval?.deadlineAt,
	);

	const pending = await getPending(approved.conversationId!);
	check(
		pending.some((item) => item.callId === approval?.callId),
		"GET approvals 能补挂这条 pending",
		JSON.stringify(pending),
	);

	const firstDecide = await decide(approval!.callId, "approve");
	check(firstDecide.status === 200 && firstDecide.body.status === "approved", "批准成功", JSON.stringify(firstDecide));
	const again = await decide(approval!.callId, "approve");
	check(again.status === 200 && again.body.status === "approved", "重复 POST 幂等（返原决定）");

	const approvedAt = Date.now();
	const ran = await approved.next<ToolEvent>(
		(event) => event.type === "tool" && event.status === "end",
		15_000,
	);
	const ranMs = Date.now() - approvedAt;
	check(Boolean(ran), "工具真的跑到了 end");
	// 超时消息在内核的 diagnostics 里，不进 tool 事件的 output；
	// 这里用"失败 + 约 1 秒就结束"证明注入的默认超时确实生效（否则 sleep 2 会跑满 2 秒）。
	check(ran?.ok === false, "sleep 2 被超时杀掉（工具以错误结束）", String(ran?.ok));
	check(ranMs >= 900 && ranMs < 1900, "耗时约 1 秒 = 批准路径仍带着 bash 默认超时", `${ranMs}ms`);
	await stop(approved.conversationId!);
	approved.abort();
	await sleep(300);

	// ── 3. 拒绝：拦下（工具不执行，模型拿到理由后重试）─────
	console.log("\n· 3. 拒绝 → 拦下（工具没执行）");
	const rejected = new ChatStream({ text: "跑个命令" });
	await rejected.next((event) => event.type === "start");
	const rejectTarget = await rejected.next<ApprovalEvent>((event) => event.type === "approval");
	const markReject = rejected.snapshot();
	const rejectDecide = await decide(rejectTarget!.callId, "reject");
	check(rejectDecide.body.status === "rejected", "拒绝成功", JSON.stringify(rejectDecide));

	// 被 block 的调用不走 afterTool，所以不会出现 tool 事件；
	// 模型拿到 block 理由后会重试 → 下一条审批就是"确实被拦了"的证据。
	const retried = await rejected.next<ApprovalEvent>((event) => event.type === "approval", 10_000);
	check(Boolean(retried), "模型拿到拒绝理由后重试（出现下一条审批）");
	check(
		!rejected.since(markReject).some((event) => event.type === "tool"),
		"没有任何 tool 事件（拦在动手之前）",
	);
	const pendingAfterReject = await getPending(rejected.conversationId!);
	check(
		!pendingAfterReject.some((item) => item.callId === rejectTarget?.callId),
		"已决的审批不再挂在 pending 里",
		JSON.stringify(pendingAfterReject),
	);
	await stop(rejected.conversationId!);
	rejected.abort();
	await sleep(300);

	// ── 4. remember：同一个工具第二次不问 ─────────────────
	console.log("\n· 4. remember + 勾选 → 第二次不问");
	const remembered = new ChatStream({ text: "跑个命令" });
	await remembered.next((event) => event.type === "start");
	const rememberTarget = await remembered.next<ApprovalEvent>((event) => event.type === "approval");
	await decide(rememberTarget!.callId, "approve", true);
	await remembered.next((event) => event.type === "tool" && event.status === "end", 15_000);
	const afterRemember = await remembered.next(
		(event) =>
			event.type === "approval" || (event.type === "tool" && (event as ToolEvent).status === "start"),
		10_000,
	);
	check(afterRemember?.type === "tool", "第二次直接执行，没有新审批", afterRemember?.type);
	await stop(remembered.conversationId!);
	remembered.abort();
	await sleep(300);

	// ── 5. 并行：两条会话各等一条，互不阻塞 ──────────────
	console.log("\n· 5. 并行两个审批互不阻塞");
	const parallelA = new ChatStream({ text: "跑个命令 A" });
	const parallelB = new ChatStream({ text: "跑个命令 B" });
	await Promise.all([
		parallelA.next((event) => event.type === "start"),
		parallelB.next((event) => event.type === "start"),
	]);
	const [approvalA, approvalB] = await Promise.all([
		parallelA.next<ApprovalEvent>((event) => event.type === "approval"),
		parallelB.next<ApprovalEvent>((event) => event.type === "approval"),
	]);
	check(Boolean(approvalA && approvalB), "两条会话各自挂起一条审批");

	const markB = parallelB.snapshot();
	await decide(approvalA!.callId, "approve");
	await parallelA.next((event) => event.type === "tool" && event.status === "end", 15_000);
	const pendingB = await getPending(parallelB.conversationId!);
	check(
		pendingB.some((item) => item.callId === approvalB?.callId),
		"A 批准后 B 仍然 pending",
		JSON.stringify(pendingB),
	);
	check(
		!parallelB.since(markB).some((event) => event.type === "tool"),
		"B 的工具没有被 A 的批准带起来",
	);
	await decide(approvalB!.callId, "reject");
	await stop(parallelA.conversationId!);
	await stop(parallelB.conversationId!);
	parallelA.abort();
	parallelB.abort();
	await sleep(300);

	// ── 6. 批准前切只读：复判必须拦住 ────────────────────
	console.log("\n· 6. 批准前切 read-only → 批准也不执行");
	const guarded = new ChatStream({ text: "跑个命令" });
	await guarded.next((event) => event.type === "start");
	const guardTarget = await guarded.next<ApprovalEvent>((event) => event.type === "approval");
	check((await setPolicy({ access: "read-only" })) === 200, "切到只读成功");
	const markGuard = guarded.snapshot();
	await decide(guardTarget!.callId, "approve");
	await sleep(1_500);
	check(
		!guarded.since(markGuard).some((event) => event.type === "tool" && (event as ToolEvent).status === "start"),
		"没有 tool:start（批准后复判拦下）",
	);
	check((await getPending(guarded.conversationId!)).length === 0, "pending 已清空");
	await setPolicy({ access: "full" });
	await stop(guarded.conversationId!);
	guarded.abort();
	await sleep(300);

	// ── 7. 超时：不答复按拒绝处理 ─────────────────────────
	console.log("\n· 7. AGENT_APPROVAL_TIMEOUT_S=1 → 超时拒绝");
	server.kill();
	await sleep(700);
	server = startServer({
		AGENT_CONFIRM_WRITES: "1",
		AGENT_BASH_TIMEOUT_S: "1",
		AGENT_APPROVAL_TIMEOUT_S: "1",
	});
	await waitForReady();

	const timed = new ChatStream({ text: "跑个命令" });
	await timed.next((event) => event.type === "start");
	const timedTarget = await timed.next<ApprovalEvent>((event) => event.type === "approval");
	// 故意不答复：等过截止时间，再补一次答复，应该看到 timeout（幂等返原决定）
	await sleep(2_000);
	const timedDecide = await decide(timedTarget!.callId, "approve");
	check(timedDecide.body.status === "timeout", "超时后这条已按 timeout 结算", JSON.stringify(timedDecide.body));
	const pendingAfterTimeout = await getPending(timed.conversationId!);
	check(
		!pendingAfterTimeout.some((item) => item.callId === timedTarget?.callId),
		"超时的那条不再挂在 pending 里",
		JSON.stringify(pendingAfterTimeout),
	);
	await stop(timed.conversationId!);
	timed.abort();
	await sleep(300);

	// ── 8. pending 时 /stop：按 aborted 结算 ──────────────
	console.log("\n· 8. 等审批时 /stop → aborted");
	const stopping = new ChatStream({ text: "跑个命令" });
	await stopping.next((event) => event.type === "start");
	const stopTarget = await stopping.next<ApprovalEvent>((event) => event.type === "approval");
	await stop(stopping.conversationId!);
	await sleep(300);
	check((await getPending(stopping.conversationId!)).length === 0, "停止后 pending 清空");
	const stopDecide = await decide(stopTarget!.callId, "approve");
	check(stopDecide.body.status === "aborted", "这条按 aborted 结算", JSON.stringify(stopDecide.body));
	stopping.abort();
	await sleep(300);

	// ── 9. 重启：遗留 pending 置 timeout ──────────────────
	console.log("\n· 9. 进程被杀时还挂着 → 启动按 timeout 结算");
	server.kill();
	await sleep(700);
	server = startServer({ AGENT_CONFIRM_WRITES: "1", AGENT_BASH_TIMEOUT_S: "1", AGENT_APPROVAL_TIMEOUT_S: "60" });
	await waitForReady();

	const dying = new ChatStream({ text: "跑个命令" });
	await dying.next((event) => event.type === "start");
	const dyingTarget = await dying.next<ApprovalEvent>((event) => event.type === "approval");
	server.kill();
	await sleep(900);
	dying.abort();

	// 用只读档重启：恢复重走 beforeTool 时会直接拦下，不会再生成同 callId 的审批，
	// 这样文件里留下的就是 load() 结算的 timeout。
	// policy.json 里还存着上一段的 full，必须清掉，env 的初值才生效。
	rmSync(POLICY, { force: true });
	server = startServer({
		AGENT_CONFIRM_WRITES: "1",
		AGENT_BASH_TIMEOUT_S: "1",
		AGENT_APPROVAL_TIMEOUT_S: "60",
		AGENT_TOOL_POLICY: "read-only",
		AGENT_MAX_TURNS: "5",
	});
	await waitForReady();
	// 触发 openHarness：load() 先跑（遗留 pending → timeout），然后才 resume。
	// 只打 /healthz 不会开 harness，状态文件也还停在旧内容。
	await getPending(dying.conversationId!);
	await sleep(1_200);
	const leftover = storedApprovals().find((item) => item.callId === dyingTarget?.callId);
	check(leftover?.status === "timeout", "遗留 pending 在启动时被置 timeout", leftover?.status ?? "(没找到记录)");

	server.kill();
	await sleep(700);
	server = startServer({ AGENT_CONFIRM_WRITES: "1", AGENT_BASH_TIMEOUT_S: "1" });
	await waitForReady();
} finally {
	server.kill();
	await sleep(300);
	rmSync(DB, { force: true });
	rmSync(`${DB}-wal`, { force: true });
	rmSync(`${DB}-shm`, { force: true });
	rmSync(APPROVALS, { force: true });
	rmSync(POLICY, { force: true });
	rmSync(".data/probe-approval-chat-meta.json", { force: true });
}

console.log(failures === 0 ? "\n✓ 审批 ask 流全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
