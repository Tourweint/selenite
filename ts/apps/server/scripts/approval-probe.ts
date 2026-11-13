/**
 * 审批 ask 流探针（2026-11-04 批次二 A1；2026-11-08 扫尾批 8c 扩六场景）。
 *
 * 与单测的分工：单测验"判定 / store 语义 / 参数指纹"，这里验**真装配**——真起服务、真 SSE、
 * 真 HTTP 答复。
 *
 * 两段：
 *   A. 新形态（缺省 async，等待态落库）：①不阻塞收尾 ②批准 → followUp → 重发 → 核销放行 → 执行
 *      ③换参数重发 → 重新审批（防骗）④拒绝 → 继续 ⑤重启后 pending 仍在且可答
 *   B. 回滚形态（AGENT_APPROVAL_MODE=blocking）：2026-11-04 起的旧 9 个场景**逐条原样**重跑，
 *      证明"回滚等于旧行为一字不变"。
 *
 * faux 只会调工具、不肯收尾（`LLM_FAUX_TOOL=bash`），所以新形态段把 `AGENT_MAX_TURNS` 压到 3，
 * 让"本轮自己收尾"在几秒内发生；`LLM_FAUX_ARGS` 用来给命令塞一个可验证的副作用（写文件）。
 *
 *   pnpm --filter @lifediary/server approval
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = ".data/probe-approval.sqlite";
const APPROVALS = ".data/probe-approval-approvals.json";
const POLICY = ".data/probe-approval-policy.json";
/** 新形态段：批准后工具真的执行 → 这个文件出现（命令由 LLM_FAUX_ARGS 注入） */
const RAN_ASYNC = ".data/probe-approval-ran.txt";
/** 换参数段：旧参数写这个文件、新参数写 RAN_SWAP */
const RAN_MISMATCH = ".data/probe-approval-ran-old.txt";
const RAN_SWAP = ".data/probe-approval-ran2.txt";
/** 三档矩阵段：write 工具真的落盘 */
const RAN_WRITE = ".data/probe-approval-write.txt";
/** 三档矩阵段的项目库（delegate 的 needs_project 判定用，绝不碰真实 .data） */
const PROJECTS_DB = ".data/probe-approval-projects.sqlite";

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

/** 回滚段的额外 env（blocking 形态）；A 段为空 */
let modeEnv: NodeJS.ProcessEnv = {};

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
		AUTONOMY_ENABLED: "false", // 探针显式关（默认已于 2026-11-13 翻成开）
		AGENT_POLICY_PATH: POLICY,
		AGENT_CHAT_META_PATH: ".data/probe-approval-chat-meta.json",
		CHANCELLOR_ENABLED: "false",
		// 三档矩阵段会真调 delegate（none 档放行）：项目库必须隔离，
		// 空库 = 没有工作区 = needs_project，不会真起 chancellor 进程。
		PROJECTS_DB_PATH: PROJECTS_DB,
		// faux 只发一个工具调用：没有合法参数时内核在校验阶段就挡掉，根本走不到 beforeTool
		LLM_FAUX_TOOL: "bash",
		LLM_FAUX_ARGS: "",
		// 显式清空：别让开发机上的 env 混进探针
		AGENT_CONFIRM_WRITES: "",
		AGENT_APPROVAL_TIMEOUT_S: "",
		AGENT_APPROVAL_MODE: "",
		AGENT_BASH_TIMEOUT_S: "900",
		NODE_OPTIONS: "",
		...modeEnv,
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

let server: ChildProcess | null = null;

/** 单独包一层：模块顶层的 `server` 只在 boot() 里赋值，TS 的控制流收窄会把它当常量 null */
function killServer(): void {
	server?.kill();
}

/** 换 env 重启（faux 的参数与形态都是进程级的，只能重启） */
async function boot(extra: NodeJS.ProcessEnv = {}): Promise<void> {
	if (server) {
		killServer();
		await sleep(700);
	}
	server = startServer(extra);
	await waitForReady();
}

async function waitFor(
	fn: () => boolean | Promise<boolean>,
	timeoutMs = 15_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (await fn()) return true;
		} catch {
			/* 轮询期间允许瞬时失败（服务刚起 / 一轮还没落库） */
		}
		await sleep(250);
	}
	return false;
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

	/** 这一轮有没有自己收尾（不阻塞形态的核心断言） */
	async ended(timeoutMs = 20_000): Promise<boolean> {
		return Promise.race([this.finishedPromise.then(() => true), sleep(timeoutMs).then(() => false)]);
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

async function getPending(conversationId: string): Promise<{ callId: string; tool: string; args: string }[]> {
	const response = await fetch(
		`${BASE}/api/v1/agent/approvals?conversationId=${encodeURIComponent(conversationId)}`,
	);
	if (!response.ok) return [];
	const data = (await response.json()) as {
		approvals?: { callId: string; tool: string; args: string }[];
	};
	return data.approvals ?? [];
}

async function transcript(conversationId: string): Promise<string> {
	const response = await fetch(
		`${BASE}/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages`,
	);
	if (!response.ok) return "";
	const data = (await response.json()) as { messages?: { text?: string }[] };
	return (data.messages ?? []).map((message) => message.text ?? "").join("\n");
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

/** POST /policy 的完整响应（三档兼容映射要同时看 status 与 body） */
async function postPolicy(
	body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${BASE}/api/v1/agent/policy`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

async function getPolicyBody(): Promise<Record<string, unknown>> {
	const response = await fetch(`${BASE}/api/v1/agent/policy`);
	return response.ok ? ((await response.json()) as Record<string, unknown>) : {};
}

interface StoredApproval {
	callId: string;
	status: string;
}

function readState(): { approvals: StoredApproval[]; grants: { callId: string }[] } {
	try {
		const parsed = JSON.parse(readFileSync(APPROVALS, "utf8")) as {
			approvals?: StoredApproval[];
			grants?: { callId: string }[];
		};
		return { approvals: parsed.approvals ?? [], grants: parsed.grants ?? [] };
	} catch {
		return { approvals: [], grants: [] };
	}
}

function storedApprovals(): StoredApproval[] {
	return readState().approvals;
}

function storedGrants(): { callId: string }[] {
	return readState().grants;
}

rmSync(DB, { force: true });
rmSync(APPROVALS, { force: true });
rmSync(POLICY, { force: true });
rmSync(RAN_ASYNC, { force: true });
rmSync(RAN_MISMATCH, { force: true });
rmSync(RAN_SWAP, { force: true });
rmSync(RAN_WRITE, { force: true });
rmSync(PROJECTS_DB, { force: true });

/** 新形态段的公共 env：确认开着、bash 不超时、faux 只在 3 个回合内打转 */
function asyncEnv(command: string): NodeJS.ProcessEnv {
	return {
		AGENT_CONFIRM_WRITES: "1",
		AGENT_BASH_TIMEOUT_S: "900",
		AGENT_MAX_TURNS: "3",
		LLM_FAUX_ARGS: JSON.stringify({ command }),
	};
}

const CMD_ASYNC = `echo approved > ${RAN_ASYNC}`;
const CMD_OLD = `echo old > ${RAN_MISMATCH}`;
const CMD_SWAP = `echo swap > ${RAN_SWAP}`;

try {
	// ══════════════════════════════════════════════════════
	// A. 新形态（缺省 = 等待态落库）
	// ══════════════════════════════════════════════════════
	await boot(asyncEnv(CMD_ASYNC));

	// ── A1. 审批不再阻塞本轮 ─────────────────────────────
	console.log("\n· 1. 不答复：本轮自己收尾，pending 落库（不阻塞）");
	const idle = new ChatStream({ text: "跑个命令" });
	await idle.next((event) => event.type === "start");
	const idleApproval = await idle.next<ApprovalEvent>((event) => event.type === "approval", 15_000);
	check(Boolean(idleApproval?.callId), "收到 approval 帧", idleApproval?.callId);
	check(idleApproval?.tool === "bash", "工具名是 bash", idleApproval?.tool);
	check(Boolean(idleApproval?.args.includes(RAN_ASYNC)), "args 带上了工具参数", idleApproval?.args);

	const idleEnded = await idle.ended(20_000);
	check(idleEnded, "未答复也在一轮内收尾（旧形态会挂 120s）");
	check(
		!idle.events.some((event) => event.type === "tool"),
		"没有任何 tool 事件（拦在动手之前）",
	);
	check(!existsSync(RAN_ASYNC), "没有执行副作用（文件没出现）");
	const idlePending = await getPending(idle.conversationId!);
	check(
		idlePending.some((item) => item.callId === idleApproval?.callId),
		"pending 落库且 GET 能查回",
		JSON.stringify(idlePending.map((item) => item.callId)),
	);
	const idleStored = storedApprovals().find((item) => item.callId === idleApproval?.callId);
	check(idleStored?.status === "pending", "状态文件里是 pending（没有超时结算）", idleStored?.status);
	await stop(idle.conversationId!);
	idle.abort();
	await sleep(300);

	// ── A2. 批准 → followUp → 重发 → 核销 → 执行 ─────────
	console.log("\n· 2. 批准 → 自动 followUp → 模型重发 → 放行清单核销 → 工具执行");
	const flow = new ChatStream({ text: "跑个命令" });
	await flow.next((event) => event.type === "start");
	const flowApproval = await flow.next<ApprovalEvent>((event) => event.type === "approval", 15_000);
	// 模拟"人回来的时候这一轮已经结束"（真实场景：人不在场，过一会儿才批）
	const flowEnded = await flow.ended(20_000);
	check(flowEnded, "本轮已收尾，卡片仍挂着");
	check(!existsSync(RAN_ASYNC), "批准前没有任何执行");

	const approved = await decide(flowApproval!.callId, "approve");
	check(
		approved.status === 200 && approved.body.status === "approved",
		"批准成功",
		JSON.stringify(approved),
	);
	const again = await decide(flowApproval!.callId, "approve");
	check(again.status === 200 && again.body.status === "approved", "重复 POST 幂等（返原决定）");

	const gotFollowUp = await waitFor(
		async () => (await transcript(flow.conversationId!)).includes("用户已批准"),
		15_000,
	);
	check(gotFollowUp, "服务端自动提交了 followUp 指令（会话里有「用户已批准」）");
	const ran = await waitFor(() => existsSync(RAN_ASYNC), 25_000);
	check(ran, "模型重发命中放行清单 → bash 真的执行（文件出现）");
	const consumed = await waitFor(() => storedGrants().length === 0, 8_000);
	check(consumed, "放行已核销（清单清空）", JSON.stringify(storedGrants()));
	await stop(flow.conversationId!);
	flow.abort();
	await sleep(300);

	// ── A3/A5. 重启保留 pending；换参数重发 → 重新审批 ─────
	console.log("\n· 3/5. 重启后 pending 仍在且可答；换参数重发不享受放行（防骗）");
	await boot(asyncEnv(CMD_OLD));
	const beforeKill = new ChatStream({ text: "跑个命令（旧参数）" });
	await beforeKill.next((event) => event.type === "start");
	const swapApproval = await beforeKill.next<ApprovalEvent>((event) => event.type === "approval", 15_000);
	check(Boolean(swapApproval?.callId), "旧参数会话挂上一条审批");
	const beforeKillEnded = await beforeKill.ended(20_000);
	check(beforeKillEnded, "本轮已收尾");
	beforeKill.abort();

	// 杀掉进程，换一个 faux 参数重启（模型"重发"时参数变了）
	await boot(asyncEnv(CMD_SWAP));
	const survived = await getPending(beforeKill.conversationId!);
	check(
		survived.some((item) => item.callId === swapApproval?.callId),
		"重启后 pending 仍在（不置 timeout，仍可答）",
		JSON.stringify(survived.map((item) => item.callId)),
	);
	check(
		storedApprovals().find((item) => item.callId === swapApproval?.callId)?.status === "pending",
		"状态文件里仍是 pending",
	);

	const swapApproved = await decide(swapApproval!.callId, "approve");
	check(swapApproved.body.status === "approved", "批准旧参数那条", JSON.stringify(swapApproved));
	check(
		(await waitFor(async () => (await transcript(beforeKill.conversationId!)).includes("用户已批准"), 15_000)),
		"批准后同样自动续跑",
	);

	// 模型重发的是**新参数**：放行清单（旧参数指纹）不该命中 → 重新挂一条审批
	const rePending = await waitFor(async () => {
		const list = await getPending(beforeKill.conversationId!);
		return list.some((item) => item.callId !== swapApproval?.callId);
	}, 20_000);
	check(rePending, "换参数重发 → 重新走审批（出现新的待批）");
	const afterSwap = await getPending(beforeKill.conversationId!);
	const fresh = afterSwap.find((item) => item.callId !== swapApproval?.callId);
	check(Boolean(fresh?.args.includes(RAN_SWAP)), "新待批的参数是换过的那份", fresh?.args);
	check(!existsSync(RAN_SWAP), "换参数的调用没有被执行");
	check(storedGrants().length === 1, "旧参数的放行还在、没被误核销", String(storedGrants().length));

	if (fresh) {
		// 批准新参数这条 → 这次重发才命中 → 真的执行
		const freshApproved = await decide(fresh.callId, "approve");
		check(freshApproved.body.status === "approved", "批准新参数那条");
		const swapRan = await waitFor(() => existsSync(RAN_SWAP), 25_000);
		check(swapRan, "新参数批准后执行落地（文件出现）");
		const swapConsumed = await waitFor(
			() => storedGrants().filter((grant) => grant.callId === fresh.callId).length === 0,
			8_000,
		);
		check(swapConsumed, "新参数那条放行已核销");
	} else {
		check(false, "批准新参数那条（前一步没出现新待批，跳过）");
	}
	await stop(beforeKill.conversationId!);
	await sleep(300);

	// ── A4. 拒绝 → 同样触发续跑 ──────────────────────────
	console.log("\n· 4. 拒绝 → followUp「请继续其余工作」，不卡死、不执行");
	// 上一步已经执行过 CMD_SWAP，删掉文件才能判断"这次没执行"
	rmSync(RAN_SWAP, { force: true });
	const rejected = new ChatStream({ text: "跑个命令（会被拒）" });
	await rejected.next((event) => event.type === "start");
	const rejectTarget = await rejected.next<ApprovalEvent>((event) => event.type === "approval", 15_000);
	await rejected.ended(20_000);
	const rejectDecide = await decide(rejectTarget!.callId, "reject");
	check(rejectDecide.body.status === "rejected", "拒绝成功", JSON.stringify(rejectDecide));
	const gotRejectFollowUp = await waitFor(
		async () => (await transcript(rejected.conversationId!)).includes("用户拒绝了"),
		15_000,
	);
	check(gotRejectFollowUp, "服务端自动提交了「用户拒绝了」的 followUp");
	const retried = await waitFor(async () => {
		const list = await getPending(rejected.conversationId!);
		return list.some((item) => item.callId !== rejectTarget?.callId);
	}, 20_000);
	check(retried, "模型确实又跑了一轮（不是卡死；faux 只会重试，所以又挂一条）");
	check(!existsSync(RAN_SWAP), "被拒绝的调用没有执行");
	await stop(rejected.conversationId!);
	rejected.abort();
	await sleep(300);

	// ══════════════════════════════════════════════════════
	// B. 回滚形态（AGENT_APPROVAL_MODE=blocking）= 旧行为一字不变
	// ══════════════════════════════════════════════════════
	console.log("\n════ 6. AGENT_APPROVAL_MODE=blocking 回滚：旧 9 场景原样重跑 ════");
	modeEnv = { AGENT_APPROVAL_MODE: "blocking" };
	await boot();

	// ── 6.1. 开关关：事件序列与改动前一致，而且没有 approval ──
	console.log("\n· 6.1 confirmWrites 关着 = 零行为变化（事件序列对照）");
	const off = new ChatStream({ text: "跑个命令" });
	await off.next((event) => event.type === "start");
	await off.next((event) => event.type === "tool" && event.status === "end", 15_000);
	const prefix = off.events.slice(0, 5).map((event) => {
		const tool = event as ToolEvent;
		return tool.type === "tool" ? `tool:${tool.status}` : event.type;
	});
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

	// 之后都开着确认；bash 默认 1 秒，用来证明"批准后超时注入还在"。
	// 命令故意用 sleep 8：1 秒超时必须把它砍在 5 秒内（Windows 下进程回收会多拖一两秒，
	// 但"注入生效"与"跑满 8 秒"仍然区分得开；用 sleep 2 时这点余量会被吃掉）。
	await boot({
		AGENT_CONFIRM_WRITES: "1",
		AGENT_BASH_TIMEOUT_S: "1",
		LLM_FAUX_ARGS: JSON.stringify({ command: "sleep 8" }),
	});

	// ── 6.2. 批准：工具真跑完，且默认超时注入仍在 ──────────
	console.log("\n· 6.2 批准 → 工具执行（超时注入保住）+ GET 补挂 + 幂等");
	const approvedOld = new ChatStream({ text: "跑个命令" });
	await approvedOld.next((event) => event.type === "start");
	const approvalOld = await approvedOld.next<ApprovalEvent>((event) => event.type === "approval");
	check(Boolean(approvalOld?.callId), "收到 approval 帧", approvalOld?.callId);
	check(approvalOld?.tool === "bash", "工具名是 bash", approvalOld?.tool);
	check(Boolean(approvalOld?.args.includes("sleep 8")), "args 带上了工具参数", approvalOld?.args);
	check(
		Number.isFinite(Date.parse(approvalOld?.deadlineAt ?? "")),
		"deadlineAt 是 ISO 时间",
		approvalOld?.deadlineAt,
	);

	const pendingOld = await getPending(approvedOld.conversationId!);
	check(
		pendingOld.some((item) => item.callId === approvalOld?.callId),
		"GET approvals 能补挂这条 pending",
		JSON.stringify(pendingOld),
	);

	const firstDecide = await decide(approvalOld!.callId, "approve");
	check(
		firstDecide.status === 200 && firstDecide.body.status === "approved",
		"批准成功",
		JSON.stringify(firstDecide),
	);
	const againOld = await decide(approvalOld!.callId, "approve");
	check(againOld.status === 200 && againOld.body.status === "approved", "重复 POST 幂等（返原决定）");

	const approvedAt = Date.now();
	const ranOld = await approvedOld.next<ToolEvent>(
		(event) => event.type === "tool" && event.status === "end",
		15_000,
	);
	const ranMs = Date.now() - approvedAt;
	check(Boolean(ranOld), "工具真的跑到了 end");
	// 超时消息在内核的 diagnostics 里，不进 tool 事件的 output；
	// 这里用"失败 + 远早于命令自然寿命就结束"证明注入的默认超时确实生效
	// （没有注入的话 sleep 8 会跑满 8 秒）。
	check(ranOld?.ok === false, "sleep 8 被超时杀掉（工具以错误结束）", String(ranOld?.ok));
	check(ranMs >= 900 && ranMs < 5_000, "1 秒超时生效：没有跑满 8 秒", `${ranMs}ms`);
	await stop(approvedOld.conversationId!);
	approvedOld.abort();
	await sleep(300);

	// ── 6.3. 拒绝：拦下（工具不执行，模型拿到理由后重试）─────
	console.log("\n· 6.3 拒绝 → 拦下（工具没执行）");
	const rejectedOld = new ChatStream({ text: "跑个命令" });
	await rejectedOld.next((event) => event.type === "start");
	const rejectTargetOld = await rejectedOld.next<ApprovalEvent>((event) => event.type === "approval");
	const markReject = rejectedOld.snapshot();
	const rejectDecideOld = await decide(rejectTargetOld!.callId, "reject");
	check(rejectDecideOld.body.status === "rejected", "拒绝成功", JSON.stringify(rejectDecideOld));

	const retriedOld = await rejectedOld.next<ApprovalEvent>((event) => event.type === "approval", 10_000);
	check(Boolean(retriedOld), "模型拿到拒绝理由后重试（出现下一条审批）");
	check(
		!rejectedOld.since(markReject).some((event) => event.type === "tool"),
		"没有任何 tool 事件（拦在动手之前）",
	);
	const pendingAfterReject = await getPending(rejectedOld.conversationId!);
	check(
		!pendingAfterReject.some((item) => item.callId === rejectTargetOld?.callId),
		"已决的审批不再挂在 pending 里",
		JSON.stringify(pendingAfterReject),
	);
	await stop(rejectedOld.conversationId!);
	rejectedOld.abort();
	await sleep(300);

	// ── 6.4. remember：同一个工具第二次不问 ─────────────────
	console.log("\n· 6.4 remember + 勾选 → 第二次不问");
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

	// ── 6.5. 并行：两条会话各等一条，互不阻塞 ──────────────
	console.log("\n· 6.5 并行两个审批互不阻塞");
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

	// ── 6.6. 批准前切只读：复判必须拦住 ────────────────────
	console.log("\n· 6.6 批准前切 read-only → 批准也不执行");
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

	// ── 6.7. 超时：不答复按拒绝处理 ─────────────────────────
	console.log("\n· 6.7 AGENT_APPROVAL_TIMEOUT_S=1 → 超时拒绝");
	await boot({
		AGENT_CONFIRM_WRITES: "1",
		AGENT_BASH_TIMEOUT_S: "1",
		AGENT_APPROVAL_TIMEOUT_S: "1",
	});

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

	// ── 6.8. pending 时 /stop：按 aborted 结算 ──────────────
	console.log("\n· 6.8 等审批时 /stop → aborted");
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

	// ── 6.9. 重启：遗留 pending 置 timeout ──────────────────
	console.log("\n· 6.9 进程被杀时还挂着 → blocking 形态启动按 timeout 结算");
	await boot({ AGENT_CONFIRM_WRITES: "1", AGENT_BASH_TIMEOUT_S: "1", AGENT_APPROVAL_TIMEOUT_S: "60" });

	const dying = new ChatStream({ text: "跑个命令" });
	await dying.next((event) => event.type === "start");
	const dyingTarget = await dying.next<ApprovalEvent>((event) => event.type === "approval");
	killServer();
	await sleep(900);
	dying.abort();

	// 用只读档重启：恢复重走 beforeTool 时会直接拦下，不会再生成同 callId 的审批，
	// 这样文件里留下的就是 load() 结算的 timeout。
	// policy.json 里还存着上一段的 full，必须清掉，env 的初值才生效。
	rmSync(POLICY, { force: true });
	await boot({
		AGENT_CONFIRM_WRITES: "1",
		AGENT_BASH_TIMEOUT_S: "1",
		AGENT_APPROVAL_TIMEOUT_S: "60",
		AGENT_TOOL_POLICY: "read-only",
		AGENT_MAX_TURNS: "5",
	});
	// 触发 openHarness：load() 先跑（遗留 pending → timeout），然后才 resume。
	// 只打 /healthz 不会开 harness，状态文件也还停在旧内容。
	await getPending(dying.conversationId!);
	await sleep(1_200);
	const leftover = storedApprovals().find((item) => item.callId === dyingTarget?.callId);
	check(leftover?.status === "timeout", "遗留 pending 在启动时被置 timeout", leftover?.status ?? "(没找到记录)");

	await boot({ AGENT_CONFIRM_WRITES: "1", AGENT_BASH_TIMEOUT_S: "1" });

	// ══════════════════════════════════════════════════════
	// C. 审批三档（2026-11-08 扫尾批 10-C）
	//    三档 × {write, bash, delegate} 真装配行为 + 旧布尔映射 + critical 清单 env 覆盖
	// ══════════════════════════════════════════════════════
	console.log("\n════ C. 审批三档（10-C）：三档 × 工具类矩阵 ════");
	modeEnv = {};
	rmSync(RAN_WRITE, { force: true });

	type Level = "ask-all" | "ask-critical" | "none";

	/** 每种工具一份合法参数（否则内核校验阶段就挡掉，走不到 beforeTool） */
	const gateArgs: Record<string, Record<string, string>> = {
		bash: { command: "echo three-level" },
		write: { path: RAN_WRITE, content: "three-level\n" },
		delegate: { requirement: "探针：只验闸门，不真派活（无项目会回 needs_project）" },
	};

	async function gateCase(
		level: Level,
		tool: "bash" | "write" | "delegate",
		expect: "ask" | "allow",
		expectOk?: boolean,
		extra: NodeJS.ProcessEnv = {},
	): Promise<void> {
		const label = `${level} × ${tool}`;
		// 每档现写：policy.json 会跨重启保留，先清掉才能让这一档从干净状态起步
		rmSync(POLICY, { force: true });
		await boot({
			AGENT_APPROVAL_MODE: "",
			AGENT_CONFIRM_WRITES: "",
			AGENT_MAX_TURNS: "3",
			AGENT_BASH_TIMEOUT_S: "900",
			LLM_FAUX_TOOL: tool,
			LLM_FAUX_ARGS: JSON.stringify(gateArgs[tool]),
			...extra,
		});
		const wrote = await setPolicy({ approvalLevel: level });
		check(wrote === 200, `${label}：审批档写入成功`, String(wrote));

		const stream = new ChatStream({ text: `${label} 探针` });
		await stream.next((event) => event.type === "start");
		// 谁先到就说明闸门怎么判的：approval = 问了；tool:start = 直接放行执行了
		const first = await stream.next(
			(event) =>
				event.type === "approval" ||
				(event.type === "tool" && (event as ToolEvent).status === "start"),
			15_000,
		);
		if (expect === "ask") {
			check(first?.type === "approval", `${label} → 弹审批`, first?.type);
			check(
				!stream.events.some((event) => event.type === "tool"),
				`${label} → 拦在动手之前（没有 tool 事件）`,
			);
		} else {
			check(first?.type === "tool", `${label} → 不弹审批，直接执行`, first?.type);
			check(
				!stream.events.some((event) => event.type === "approval"),
				`${label} → 没有任何 approval 帧`,
			);
			if (expectOk !== undefined) {
				const end = await stream.next<ToolEvent>(
					(event) => event.type === "tool" && event.status === "end",
					20_000,
				);
				check(end?.ok === expectOk, `${label} → 工具收尾 ok=${String(expectOk)}`, String(end?.ok));
				// delegate 放行后没有项目 → 工具返回 needs_project（仍是"执行过"的证据），
				// 同时证明探针没有真的起 chancellor 进程。
				if (tool === "delegate") {
					check(
						Boolean(end?.output?.includes("needs_project")),
						`${label} → 停在 needs_project（没有真派活）`,
						end?.output?.slice(0, 120),
					);
				}
			}
			if (tool === "write") {
				check(existsSync(RAN_WRITE), `${label} → 文件真的落盘（放行不是假放行）`);
				rmSync(RAN_WRITE, { force: true });
			}
		}
		await stop(stream.conversationId!);
		stream.abort();
		await sleep(250);
	}

	// ask-all：三个都要问
	await gateCase("ask-all", "bash", "ask");
	await gateCase("ask-all", "write", "ask");
	await gateCase("ask-all", "delegate", "ask", undefined, { CHANCELLOR_ENABLED: "true" });
	// ask-critical：只问命令 / 派活，write 自动放行
	await gateCase("ask-critical", "bash", "ask");
	await gateCase("ask-critical", "write", "allow", true);
	await gateCase("ask-critical", "delegate", "ask", undefined, { CHANCELLOR_ENABLED: "true" });
	// none：全部放行（delegate 落到 needs_project 即"执行过"的证据，不真起进程）
	await gateCase("none", "bash", "allow", true);
	await gateCase("none", "write", "allow", true);
	await gateCase("none", "delegate", "allow", true, { CHANCELLOR_ENABLED: "true" });

	// ── C2. 旧 confirmWrites 布尔映射 + 非法值 400 ──────────
	console.log("\n· C2 旧 confirmWrites POST 兼容映射 / GET 双字段 / 非法值 400");
	rmSync(POLICY, { force: true });
	await boot({
		AGENT_APPROVAL_MODE: "",
		AGENT_CONFIRM_WRITES: "",
		LLM_FAUX_TOOL: "bash",
		LLM_FAUX_ARGS: JSON.stringify({ command: "true" }),
		AGENT_MAX_TURNS: "2",
	});
	const initial = await getPolicyBody();
	check(
		initial.approvalLevel === "none" && initial.confirmWrites === false,
		"缺省档位 = none（旧布尔 false）",
		JSON.stringify(initial),
	);

	const legacyOn = await postPolicy({ confirmWrites: true });
	check(
		legacyOn.status === 200 && legacyOn.body.approvalLevel === "ask-all" && legacyOn.body.confirmWrites === true,
		"POST confirmWrites:true → ask-all（旧语义 1/true 映射）",
		JSON.stringify(legacyOn.body),
	);
	const readBack = await getPolicyBody();
	check(
		readBack.approvalLevel === "ask-all" && readBack.confirmWrites === true,
		"GET 同时回 approvalLevel 与派生的 confirmWrites",
		JSON.stringify(readBack),
	);

	const legacyOff = await postPolicy({ confirmWrites: false });
	check(
		legacyOff.status === 200 && legacyOff.body.approvalLevel === "none" && legacyOff.body.confirmWrites === false,
		"POST confirmWrites:false → none",
		JSON.stringify(legacyOff.body),
	);

	const critical = await postPolicy({ approvalLevel: "ask-critical" });
	check(
		critical.status === 200 && critical.body.approvalLevel === "ask-critical" && critical.body.confirmWrites === true,
		"POST approvalLevel:ask-critical → 落库，派生 confirmWrites=true",
		JSON.stringify(critical.body),
	);

	const bad = await postPolicy({ approvalLevel: "ask-some" });
	check(
		bad.status === 400 && bad.body.error === "bad_request",
		"非法 approvalLevel → 400",
		JSON.stringify(bad),
	);
	const badLegacy = await postPolicy({ confirmWrites: "yes" });
	check(
		badLegacy.status === 400 && badLegacy.body.error === "bad_request",
		"旧 confirmWrites 非布尔 → 400（兼容不等于放宽）",
		JSON.stringify(badLegacy),
	);

	// policy.json 落的是新字段；旧字段不再写
	const stored = JSON.parse(readFileSync(POLICY, "utf8")) as Record<string, unknown>;
	check(
		stored.approvalLevel === "ask-critical" && !("confirmWrites" in stored),
		"policy.json 存 approvalLevel、不再写 confirmWrites",
		JSON.stringify(stored),
	);

	// ── C3. 读旧 policy.json（只有 confirmWrites）→ 映射 ask-all ──
	console.log("\n· C3 老 policy.json（confirmWrites:true）→ ask-all");
	rmSync(POLICY, { force: true });
	writeFileSync(POLICY, JSON.stringify({ access: "full", blocked: [], confirmWrites: true }, null, 2));
	await boot({
		AGENT_APPROVAL_MODE: "",
		AGENT_CONFIRM_WRITES: "",
		LLM_FAUX_TOOL: "bash",
		LLM_FAUX_ARGS: JSON.stringify({ command: "true" }),
		AGENT_MAX_TURNS: "2",
	});
	const migrated = await getPolicyBody();
	check(
		migrated.approvalLevel === "ask-all" && migrated.confirmWrites === true,
		"旧字段读档兼容 → ask-all",
		JSON.stringify(migrated),
	);

	// ── C4. critical 清单 env 覆盖 ──────────────────────────
	console.log("\n· C4 AGENT_APPROVAL_CRITICAL_TOOLS 覆盖缺省清单");
	rmSync(POLICY, { force: true });
	await boot({
		AGENT_APPROVAL_MODE: "",
		AGENT_CONFIRM_WRITES: "",
		AGENT_APPROVAL_CRITICAL_TOOLS: "write",
		AGENT_MAX_TURNS: "3",
		LLM_FAUX_TOOL: "write",
		LLM_FAUX_ARGS: JSON.stringify(gateArgs.write),
	});
	await setPolicy({ approvalLevel: "ask-critical" });
	const customWrite = new ChatStream({ text: "自定义清单：write 该问" });
	await customWrite.next((event) => event.type === "start");
	const customAsk = await customWrite.next(
		(event) =>
			event.type === "approval" || (event.type === "tool" && (event as ToolEvent).status === "start"),
		15_000,
	);
	check(customAsk?.type === "approval", "清单改成 write → write 反而要问", customAsk?.type);
	check(!existsSync(RAN_WRITE), "问的时候不落盘");
	await stop(customWrite.conversationId!);
	customWrite.abort();
	await sleep(250);

	rmSync(POLICY, { force: true });
	await boot({
		AGENT_APPROVAL_MODE: "",
		AGENT_CONFIRM_WRITES: "",
		AGENT_APPROVAL_CRITICAL_TOOLS: "write",
		AGENT_MAX_TURNS: "3",
		LLM_FAUX_TOOL: "bash",
		LLM_FAUX_ARGS: JSON.stringify(gateArgs.bash),
	});
	await setPolicy({ approvalLevel: "ask-critical" });
	const customBash = new ChatStream({ text: "自定义清单：bash 不该问" });
	await customBash.next((event) => event.type === "start");
	const customAllow = await customBash.next(
		(event) =>
			event.type === "approval" || (event.type === "tool" && (event as ToolEvent).status === "start"),
		15_000,
	);
	check(customAllow?.type === "tool", "清单里的 bash 被移除 → 直接执行", customAllow?.type);
	check(
		!customBash.events.some((event) => event.type === "approval"),
		"没有任何 approval 帧",
	);
	await stop(customBash.conversationId!);
	customBash.abort();
	await sleep(250);
} finally {
	killServer();
	await sleep(300);
	rmSync(DB, { force: true });
	rmSync(`${DB}-wal`, { force: true });
	rmSync(`${DB}-shm`, { force: true });
	rmSync(APPROVALS, { force: true });
	rmSync(POLICY, { force: true });
	rmSync(RAN_ASYNC, { force: true });
	rmSync(RAN_MISMATCH, { force: true });
	rmSync(RAN_SWAP, { force: true });
	rmSync(RAN_WRITE, { force: true });
	rmSync(PROJECTS_DB, { force: true });
	rmSync(".data/probe-approval-chat-meta.json", { force: true });
}

console.log(failures === 0 ? "\n✓ 审批 ask 流全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
