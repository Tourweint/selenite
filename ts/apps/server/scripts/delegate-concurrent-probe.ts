// 同会话并发派单探针（2026-11-07 扫尾批 1 A28，补 2026-11-03「同会话并发多张没测」的欠账）。
//
// 借 phone-worker-probe 的 env 全隔离 + check() 断言骨架，但用假 runner（delegate 注入）
// 让两张单**并发在飞**，不碰真模型、不碰 chancellor 磁盘执行：
//   同会话两单并发 → 各自受理 / 回执两条 / 事件按 ticketId 归并不串台 / 都到达终态。
//
// 用法：`pnpm --filter @lifediary/server concurrent`
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ChancellorOptions,
	ChancellorRequest,
	TicketResult,
} from "../../../packages/chancellor/src/index.ts";
import type { DelegationEvent } from "../src/delegation.ts";

const temp = mkdtempSync(join(tmpdir(), "lifediary-concurrent-"));
const RUNS = join(temp, "work");
process.env.DELEGATION_ASYNC = "true";
process.env.DELEGATION_PROJECT_REQUIRED = "false";
process.env.DELEGATION_AUTO_REPORT = "true";
process.env.DELEGATIONS_DB_PATH = join(temp, "delegations.sqlite");
process.env.CHANCELLOR_WORK_ROOT = RUNS;
process.env.AGENT_DB_PATH = join(temp, "agent.sqlite");
mkdirSync(RUNS, { recursive: true });

// 必须先设 env 再 import：受理回执库等单例都在首次用到时才按 env 落盘。
const { createTools } = await import("../src/tools.ts");
const { watchDelegation } = await import("../src/delegation.ts");
const { DelegationReceipts } = await import("../src/delegation-receipts.ts");

type Runner = (req: ChancellorRequest, opts?: ChancellorOptions) => Promise<TicketResult>;
type DelegateFrame = Extract<DelegationEvent, { type: "delegate" }>;

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假 runner：同步段把单号发出去（startDelegation 靠它同步拿号），Promise 一直挂着 = 在飞。 */
interface InFlight {
	ticketId: string;
	resolve: (result: TicketResult) => void;
}
function makeRunner() {
	const calls: ChancellorRequest[] = [];
	const inFlight: InFlight[] = [];
	let seq = 0;
	const run: Runner = (req, opts) => {
		calls.push(req);
		const ticketId = `T-concurrent-${(seq += 1)}`;
		opts?.onEvent?.({ type: "ticket", ticketId, message: "已受理" });
		opts?.onEvent?.({ type: "planned", ticketId, total: 1 });
		return new Promise<TicketResult>((resolve) => {
			inFlight.push({ ticketId, resolve });
		});
	};
	return { run, calls, inFlight };
}

function makeTools(run: Runner) {
	const delegate = createTools({
		memory: null,
		scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
		delegateRun: run,
	}).find((tool) => tool.name === "delegate");
	if (!delegate) throw new Error("delegate 没挂上");
	return async (conversationId: number, requirement: string): Promise<string> => {
		const result = await delegate.execute(
			{ requirement } as never,
			{ conversationId } as never,
			{} as never,
		);
		return (result.output ?? [])
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("");
	};
}

const CONVERSATION = 9001;
const fake = makeRunner();
const call = makeTools(fake.run);
const events: DelegationEvent[] = [];
const stopWatch = watchDelegation(CONVERSATION, (event) => events.push(event));

// 两张单同一会话、并发在飞：两个 execute 同时挂起，谁也不等谁先跑完。
const [replyA, replyB] = await Promise.all([
	call(CONVERSATION, "整理 A 的活"),
	call(CONVERSATION, "整理 B 的活"),
]);

check(
	fake.calls.length === 2 && fake.calls.every((req) => req.resumeTicketId === undefined),
	"同会话并发发起两张新单",
	`calls=${fake.calls.length}`,
);
check(
	replyA.includes("已受理") && replyB.includes("已受理") && replyA !== replyB,
	"两单各自受理、返回不同单号",
	`${replyA.slice(0, 28)} / ${replyB.slice(0, 28)}`,
);
check(
	fake.inFlight.length === 2 && fake.inFlight[0].ticketId !== fake.inFlight[1].ticketId,
	"两张单同时在飞、单号互不相同",
	fake.inFlight.map((entry) => entry.ticketId).join(" / "),
);

// 两单都收尾（仍并发：一次性全部 resolve），等 settle 跑完再验事件与回执。
for (const entry of fake.inFlight) {
	entry.resolve({
		ticketId: entry.ticketId,
		status: "done",
		line: `完成 ${entry.ticketId}`,
		tasks: [],
	});
}
await sleep(60);
stopWatch();

const [idA, idB] = fake.inFlight.map((entry) => entry.ticketId);
const delegateFrames = events.filter(
	(event): event is DelegateFrame => event.type === "delegate",
);
const framesOf = (id: string): DelegateFrame[] =>
	delegateFrames.filter((event) => event.ticketId === id);

// 事件按 ticketId 归并不串台：每张单都有自己的受理帧与终态帧，且不存在第三种 ticketId。
check(
	new Set(delegateFrames.map((event) => event.ticketId)).size === 2,
	"事件里只出现这两张单的 ticketId（不串台）",
	[...new Set(delegateFrames.map((event) => event.ticketId))].join(" / "),
);
for (const id of [idA, idB]) {
	const frames = framesOf(id);
	check(
		frames.some((frame) => frame.phase === "accepted") && frames.some((frame) => frame.phase === "done"),
		`${id} 的受理帧与终态帧都归到自己名下`,
		`${frames.length} 帧`,
	);
}
check(
	framesOf(idA).length > 0 && framesOf(idB).length > 0 && framesOf(idA).length + framesOf(idB).length === delegateFrames.length,
	"两张单的事件互不混淆、都到达终态",
);

// 回执两条：各自 requestId 独立、都挂在同一会话（回执 accept 带 conversation_id）。
const receipts = new DelegationReceipts();
try {
	const receiptA = receipts.lookupByTicket(idA);
	const receiptB = receipts.lookupByTicket(idB);
	check(Boolean(receiptA) && Boolean(receiptB), "两张单各有一条受理回执");
	check(
		receiptA?.requestId !== receiptB?.requestId,
		"两条回执 requestId 不撞车",
		`${receiptA?.requestId} / ${receiptB?.requestId}`,
	);
	check(
		receiptA?.conversationId === CONVERSATION && receiptB?.conversationId === CONVERSATION,
		"两条回执都挂到同一条来源对话",
	);
} finally {
	receipts.close();
}

try {
	rmSync(temp, { recursive: true, force: true });
} catch {
	/* sqlite 句柄可能还开着；临时目录留着无害 */
}

console.log(failures === 0 ? "\n✓ 同会话并发派单全部通过" : `\n✗ 并发派单有 ${failures} 项不对`);
process.exit(failures === 0 ? 0 : 1);
