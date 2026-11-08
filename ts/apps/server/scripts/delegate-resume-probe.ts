// 续跑路由探针（v0.6）：验 harness 这头怎么把「用户的回答」送回原单。
//
// 不碰真模型、不碰 chancellor 磁盘：用 ToolDeps.delegateRun 注入假入口，
// 只断言路由本身（会话隔离、resume 参数、没单可续的兜底、进度/需要人帧）。
//
// 用法：`pnpm --filter @lifediary/server resume`
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ChancellorOptions,
	ChancellorRequest,
	TicketResult,
} from "../../../../../chancellor/src/index.ts";
import {
	startDelegation,
	watchDelegation,
	type DelegationEvent,
	type DelegationReport,
	type DelegationRuntime,
} from "../src/delegation.ts";
import { createTools } from "../src/tools.ts";
import { DelegationReceipts } from "../src/delegation-receipts.ts";
import { DelegationMessages } from "../src/delegation-messages.ts";
import {
	applyCancelProjection,
	cancelTicketAction,
	retryTicketAction,
} from "../src/delegation-api.ts";

// 这个探针验的是路由（resume / 新派 / 会话隔离），要同步拿结论；
// 异步受理与后台回灌由 `src/delegation.test.ts` 覆盖。
process.env.DELEGATION_ASYNC = "false";
// 项目前置由 `src/projects.test.ts` 覆盖；这里只验路由，不注入项目登记表。
process.env.DELEGATION_PROJECT_REQUIRED = "false";
// 取消/重试（扫尾批 1 A1）要落作废位与回执；整份探针隔离到临时目录，别碰真实 .data。
const TEMP = mkdtempSync(join(tmpdir(), "lifediary-resume-"));
const RUNS = join(TEMP, "work");
const DB = join(TEMP, "delegations.sqlite");
process.env.DELEGATIONS_DB_PATH = DB;
process.env.CHANCELLOR_WORK_ROOT = RUNS;
process.env.DELEGATION_CANCEL = "true";
mkdirSync(RUNS, { recursive: true });

type Runner = (req: ChancellorRequest, opts?: ChancellorOptions) => Promise<TicketResult>;

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function makeFake(options: { resumeThrows?: boolean; prefix?: string } = {}) {
	const calls: ChancellorRequest[] = [];
	const prefix = options.prefix ?? "t";
	let newTickets = 0;
	let resumeThrows = options.resumeThrows ?? false;

	const run: Runner = async (req, opts) => {
		calls.push(req);
		// 与 chancellor 一致：单子已完成/找不到时，续跑在派活前就抛错，不发任何事件。
		if (req.resumeTicketId && resumeThrows) throw new Error("这单没有在等回答的任务");

		if (req.resumeTicketId) {
			opts?.onEvent?.({ type: "planned", ticketId: req.resumeTicketId, total: 1 });
			opts?.onEvent?.({ type: "task-start", ticketId: req.resumeTicketId, slug: "do-it" });
			opts?.onEvent?.({ type: "task-done", ticketId: req.resumeTicketId, slug: "do-it" });
			return {
				ticketId: req.resumeTicketId,
				status: "done",
				line: `续上了：${req.answer ?? ""}`,
				tasks: [],
			};
		}

		// 新派：单号同时进事件与返回值（事件里的 ticketId 是"同步段拿单号"的唯一来源，
		// 用常量会让调用方记错单——改派回执这类断言就落在错单上）
		newTickets += 1;
		const ticket = `${prefix}${newTickets}`;
		opts?.onEvent?.({ type: "ticket", ticketId: ticket, message: "已受理" });
		opts?.onEvent?.({ type: "planned", ticketId: ticket, total: 1 });
		opts?.onEvent?.({ type: "task-start", ticketId: ticket, slug: "do-it" });
		opts?.onEvent?.({ type: "task-done", ticketId: ticket, slug: "do-it" });

		return {
			ticketId: ticket,
			status: "needs_you",
			line: "⚠ 需要你：验证码是啥？",
			tasks: [],
			attention: { kind: "need_input", question: "验证码是啥？" },
		};
	};

	return {
		run,
		calls,
		get newTickets() {
			return newTickets;
		},
		setResumeThrows(value: boolean) {
			resumeThrows = value;
		},
	};
}

function makeTools(run: Runner) {
	const tools = createTools({
		memory: null,
		scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
		delegateRun: run,
	});
	const delegate = tools.find((tool) => tool.name === "delegate");
	if (!delegate) throw new Error("delegate 没挂上");

	return async (
		conversationId: number,
		args: { requirement: string; resume?: boolean; requestId?: string },
	) => {
		const result = await delegate.execute(args as never, { conversationId } as never, {} as never);
		return (result.output ?? [])
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("");
	};
}

function watch(conversationId: number): { events: DelegationEvent[]; stop: () => void } {
	const events: DelegationEvent[] = [];
	const stop = watchDelegation(conversationId, (event) => events.push(event));
	return { events, stop };
}

// 1. 不带 resume 连派两次 → 两张单（行为不变）
{
	const fake = makeFake();
	const call = makeTools(fake.run);
	await call(101, { requirement: "整理 A" });
	await call(101, { requirement: "整理 B" });
	check(fake.newTickets === 2, "不带 resume 连派两次 → 两张单");
	check(
		fake.calls.every((req) => req.resumeTicketId === undefined),
		"两次都是新派",
	);
}

// 2. needs_you → resume:true 回答 → 同一张单继续，ticket 数不变
{
	const fake = makeFake();
	const call = makeTools(fake.run);
	const { events, stop } = watch(201);
	const first = await call(201, { requirement: "打开设置改时区" });
	const second = await call(201, { requirement: "验证码 1234", resume: true });
	stop();

	check(first.includes("需要你"), "第一次派活卡在 needs_you");
	check(fake.newTickets === 1, "resume 后 ticket 数不变", `新单数=${fake.newTickets}`);
	check(fake.calls[1]?.resumeTicketId === "t1", "resume 带上原单 id");
	check(fake.calls[1]?.answer === "验证码 1234", "answer 就是用户那句回答");
	check(
		second.includes("续上了：验证码 1234") && !second.includes("没有可续的单"),
		"返回原单结论，不带兜底说明",
		second.replace(/\n/g, " / "),
	);
	check(
		events.some((event) => event.type === "delegate"),
		"进度帧照旧要发",
	);
	check(
		events.some((event) => event.type === "attention"),
		"attention 帧照旧要发",
	);
}

// 3. 空会话里 resume:true → 正常派新活，返回里带说明，不报错
{
	const fake = makeFake();
	const call = makeTools(fake.run);
	const reply = await call(301, { requirement: "1234", resume: true });
	check(fake.newTickets === 1, "空会话 resume → 按新活派");
	check(fake.calls[0]?.resumeTicketId === undefined, "没有可续的单时不传 resumeTicketId");
	check(reply.includes("（没有可续的单，已按新活派）"), "返回里带兜底说明");
}

// 4. A 会话的单不会被 B 会话 resume
{
	const fake = makeFake();
	const call = makeTools(fake.run);
	await call(401, { requirement: "A 的活" });
	await call(402, { requirement: "B 的回答", resume: true });
	await call(401, { requirement: "A 的回答", resume: true });

	check(fake.calls[1]?.resumeTicketId === undefined, "B 不会续到 A 的单");
	check(fake.calls[2]?.resumeTicketId === "t1", "A 仍能续自己的单");
}

// 5. 重启后 resume:true → 走「没单可续」分支，不崩
{
	const fake = makeFake();
	const beforeRestart = makeTools(fake.run);
	await beforeRestart(501, { requirement: "先派一单" });

	// 进程重启：内存 Map 随 createTools 一起没了（chancellor 的磁盘单还在，但会话已断）。
	const afterRestart = makeTools(fake.run);
	const reply = await afterRestart(501, { requirement: "验证码 1234", resume: true });

	check(fake.calls[2]?.resumeTicketId === undefined, "重启后 resume 不再指向老单");
	check(reply.includes("（没有可续的单，已按新活派）"), "重启后走没单可续分支");
	check(fake.newTickets === 2, "重启后按新活派");
}

// 6. 单子已完成时续跑被 chancellor 拒 → 同样不报错，按新活派
{
	const fake = makeFake();
	const call = makeTools(fake.run);
	await call(601, { requirement: "先派一单" });
	fake.setResumeThrows(true);
	const reply = await call(601, { requirement: "验证码 1234", resume: true });

	check(reply.includes("（没有可续的单，已按新活派）"), "续跑被拒后返回兜底说明");
	check(fake.newTickets === 2, "续跑被拒后派了新单");
}

// 7. 续跑回执（2026-11-08 扫尾批 7a）：resume 补写会话映射
//
// 单号前缀用 R，避开前面几组的 t1/t2（同一份回执库，别让旧行混进断言）。
// "原会话 ≠ 续跑会话"用现有代码路径构造：同一显式 requestId 从另一条会话再提一次
// → 冲突分支把原单指针交给那条会话（`lastTicketByConversation`），它再 resume 就是
// 一次"从别的对话续跑别人的单"——正是这条映射要覆盖的情形。
{
	const store = new DelegationReceipts(DB);
	const { reportRecoveredTickets } = await import("../src/recovery-report.ts");
	const fake = makeFake({ prefix: "R" });
	const call = makeTools(fake.run);
	const KEY = "probe-shared-request";
	try {
		// 7.1 原会话 802 派单 → 回执挂在 802
		await call(802, { requirement: "整理 A", requestId: KEY });
		check(
			store.lookupByTicket("R1")?.conversationId === 802,
			"原单回执仍挂在派单会话 802",
			String(store.lookupByTicket("R1")?.conversationId),
		);

		// 7.2 会话 803 用同一个 requestId 再提（内容不同 → 冲突）→ 拿回原单 → 它 resume
		const adopted = await call(803, { requirement: "B 的活", requestId: KEY });
		check(adopted.includes("返回原单 R1"), "冲突分支把原单指针交给 803", adopted.slice(0, 40));
		const resumeReply = await call(803, { requirement: "验证码 1234", resume: true });
		check(resumeReply.includes("续上了"), "803 续跑的是原单 R1", resumeReply.replace(/\n/g, " / "));

		// ① resume 后该单回执存在，且指向发起 resume 的会话（不是原派单会话）
		const afterResume = store.lookupByTicket("R1");
		check(
			afterResume?.requestId === "resume:R1:1" && afterResume?.conversationId === 803,
			"resume 回执存在并指向发起会话 803",
			`requestId=${afterResume?.requestId} conversationId=${afterResume?.conversationId}`,
		);
		check(
			store.lookupByTicket("R1")?.conversationId !== 802,
			"最新回执不再指向原派单会话",
		);

		// ② 模拟重启恢复（A3b 同一函数 + 同一查询）→ 回灌落到 resume 会话
		const said: Array<[number, string]> = [];
		const sent = await reportRecoveredTickets([{ ticketId: "R1", status: "done" }], {
			receipts: store,
			say: (conversationId, line) => {
				said.push([conversationId, line]);
			},
		});
		check(
			sent === 1 && said[0]?.[0] === 803,
			"重启恢复回灌落到 resume 会话 803（不是原会话 802）",
			JSON.stringify(said),
		);

		// ③ 同一单二次 resume → 不炸；次数递增、最新一行说了算
		const again = await call(803, { requirement: "再答一次", resume: true });
		check(again.includes("续上了"), "同一单第二次 resume 不报错", again.replace(/\n/g, " / "));
		check(
			store.lookup("resume:R1:1") !== null &&
				store.lookup("resume:R1:2") !== null &&
				store.lookupByTicket("R1")?.requestId === "resume:R1:2",
			"两次 resume 各留一行（resume:R1:1 / :2），反查取最新",
			String(store.lookupByTicket("R1")?.requestId),
		);
		check(store.countResumes("R1") === 2, "resume 次数累计为 2", String(store.countResumes("R1")));

		// 7.3 第四次：换一条会话续跑（同一 requestId 再撞一次）→ 映射跟着人走
		await call(804, { requirement: "C 的活", requestId: KEY });
		await call(804, { requirement: "验证码 5678", resume: true });
		check(
			store.lookupByTicket("R1")?.requestId === "resume:R1:3" &&
				store.lookupByTicket("R1")?.conversationId === 804,
			"再次换会话 resume → 最新回执指向 804（latest-wins）",
			`requestId=${store.lookupByTicket("R1")?.requestId} conversationId=${store.lookupByTicket("R1")?.conversationId}`,
		);

		// 7.4 续跑被拒改派（2026-11-08 批 10-A）：改派出的**新单**也要有映射，
		// 否则完成 / 重启回灌按单号查不到人，提问的那条对话永远收不到下文。
		{
			const fallbackFake = makeFake({ prefix: "F" });
			const fallbackCall = makeTools(fallbackFake.run);
			await fallbackCall(806, { requirement: "先派一单" });
			fallbackFake.setResumeThrows(true);
			const reply = await fallbackCall(806, { requirement: "验证码 9999", resume: true });
			// 同步形态直接回结果正文，不含单号（单号由下面回执断言守住）
			check(
				reply.includes("没有可续的单，已按新活派"),
				"续跑被拒 → 走「没有可续的单，已按新活派」分支",
				reply.replace(/\n/g, " / "),
			);
			check(
				store.lookupByTicket("F2")?.conversationId === 806,
				"改派新单的回执指向发起续跑的会话 806",
				String(store.lookupByTicket("F2")?.conversationId),
			);
			const saidFallback: Array<[number, string]> = [];
			const sentFallback = await reportRecoveredTickets([{ ticketId: "F2", status: "done" }], {
				receipts: store,
				say: (conversationId, line) => {
					saidFallback.push([conversationId, line]);
				},
			});
			check(
				sentFallback === 1 && saidFallback[0]?.[0] === 806,
				"重启回灌按新单号落到 806",
				JSON.stringify(saidFallback),
			);
		}

		// 7.5 回滚开关：DELEGATION_MAP_PERSIST=false → 一行 resume 回执都不落（回到改动前）
		process.env.DELEGATION_MAP_PERSIST = "false";
		await call(805, { requirement: "再答一次", resume: true });
		check(
			store.countResumes("R1") === 3 && store.lookupByTicket("R1")?.conversationId === 804,
			"DELEGATION_MAP_PERSIST=false → 不落 resume 回执，映射保持原样",
			`count=${store.countResumes("R1")}`,
		);
		delete process.env.DELEGATION_MAP_PERSIST;
	} finally {
		store.close();
	}
}

// 8. 取消 / 重试（扫尾批 1 A1）：作废位、投影、幂等、终态拒绝、settle 静默、重派挂原会话
{
	const store = new DelegationReceipts(DB);
	/** findTicket 从 chancellor 工作目录读 ticket.json：这里铺几张假单据。 */
	const writeTicket = (id: string, status: string, prompt: string): void => {
		mkdirSync(join(RUNS, id), { recursive: true });
		writeFileSync(
			join(RUNS, id, "ticket.json"),
			JSON.stringify({
				id,
				prompt,
				status,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				options: {
					dry: false,
					maxTasks: 1,
					workRoot: RUNS,
					domain: "frontend",
					project: { id: "p1", name: "示例项目", rootPath: join(TEMP, "p1") },
				},
				// 数字串 = 宿主内部会话 id（新单透传的就是它），接口层再换对外 uuid。
				originConversationId: "9001",
			}),
		);
	};
	writeTicket("T-cancel-open", "dispatching", "整理 A");
	writeTicket("T-terminal-done", "done", "整理 B");
	writeTicket("T-retry-failed", "failed", "整理 C");
	writeTicket("T-cancel-settle", "reviewing", "整理 D");

	// 7.1 投影：canceled:true + status:"canceled" + originStatus 保留原值
	const projected = applyCancelProjection({ status: "dispatching", id: "T-cancel-open" }, true);
	check(
		projected.canceled === true && projected.status === "canceled" && projected.originStatus === "dispatching",
		"作废投影：canceled + status=canceled + originStatus 不丢事实",
	);
	const plain = applyCancelProjection({ status: "running" }, false);
	check(
		plain.canceled === false && plain.status === "running" && !("originStatus" in plain),
		"未作废投影只叠加 canceled:false",
	);

	// 7.2 终态取消 → 400
	const terminal = cancelTicketAction(store, RUNS, "T-terminal-done");
	check(terminal.status === 400, "终态（done）取消 → 400", `status=${terminal.status}`);

	// 7.3 重复取消幂等：两次都 200，canceled_at 不被改写
	const first = cancelTicketAction(store, RUNS, "T-cancel-open");
	const at1 = store.cancelInfo("T-cancel-open")?.canceledAt;
	const second = cancelTicketAction(store, RUNS, "T-cancel-open");
	const at2 = store.cancelInfo("T-cancel-open")?.canceledAt;
	check(
		first.status === 200 && second.status === 200 && first.body.status === "canceled",
		"非终态取消 + 重复取消都回 200",
	);
	check(at1 === at2 && store.canceledTicketIds().has("T-cancel-open"), "重复取消幂等：作废位一行、时间不变");

	// 7.4 取消后 settle 不回写、不发事件（作废生效的两个点）
	cancelTicketAction(store, RUNS, "T-cancel-settle");
	const settleEmits: DelegationEvent[] = [];
	const settleReports: DelegationReport[] = [];
	let resolveSettle: (value: TicketResult) => void = () => undefined;
	const settleFinish = new Promise<TicketResult>((resolve) => {
		resolveSettle = resolve;
	});
	startDelegation(
		{ conversationId: 9001, domain: "frontend", requirement: "整理 D" },
		{
			run: (_request, options) => {
				options?.onEvent?.({ type: "ticket", ticketId: "T-cancel-settle", message: "已受理" });
				return settleFinish;
			},
			emit: (_conversationId, event) => settleEmits.push(event),
			report: (_conversationId, report) => settleReports.push(report),
			autoReport: true,
			isCanceled: (id) => store.isCanceled(id),
			log: () => undefined,
		},
	);
	resolveSettle({ ticketId: "T-cancel-settle", status: "done", line: "完成了", tasks: [] });
	await new Promise((resolve) => setTimeout(resolve, 30));
	const messageStore = new DelegationMessages(DB);
	const settleMessages = messageStore.list("T-cancel-settle");
	messageStore.close();
	check(settleReports.length === 0, "取消后 settle 不回写会话（report 不调用）");
	check(settleEmits.length === 0, "取消后 emitProgress / settle 都不发事件（SSE 安静）");
	check(
		settleMessages.every((message) => message.direction !== "in"),
		"取消后 settle 不 recordMessage('in') 回写",
	);

	// 7.5 重试：产出新单、挂原会话、新 requestId 防撞、回执带原单 conversation_id
	function makeRetryRuntime(): {
		calls: ChancellorRequest[];
		runtime: DelegationRuntime;
	} {
		const calls: ChancellorRequest[] = [];
		let seq = 0;
		const runtime: DelegationRuntime = {
			run: (request, options) => {
				calls.push(request);
				const ticketId = `T-retry-new-${(seq += 1)}`;
				options?.onEvent?.({ type: "ticket", ticketId, message: "已受理" });
				return Promise.resolve({ ticketId, status: "done", line: "重派完成", tasks: [] });
			},
			emit: () => undefined,
			report: () => undefined,
			autoReport: true,
			isCanceled: (id) => store.isCanceled(id),
			log: () => undefined,
		};
		return { calls, runtime };
	}
	const retry = makeRetryRuntime();
	const retried = retryTicketAction(store, RUNS, "T-retry-failed", retry.runtime);
	const newTicketId = String(retried.body.ticketId ?? "");
	check(
		retried.status === 200 && newTicketId !== "" && newTicketId !== "T-retry-failed",
		"重试产出一张新单",
		`newTicketId=${newTicketId}`,
	);
	check(
		retry.calls.length === 1 && retry.calls[0]?.requirement === "整理 C",
		"新单沿用原单需求正文",
	);
	check(
		retry.calls[0]?.originConversationId === "9001",
		"新单挂回原会话（originConversationId 透传）",
	);
	check(
		String(retry.calls[0]?.idempotencyKey ?? "").startsWith("retry:T-retry-failed:"),
		"新 requestId 用 retry:<原单id>:<次数> 防撞",
		String(retry.calls[0]?.idempotencyKey),
	);
	const newReceipt = store.lookupByTicket(newTicketId);
	check(newReceipt?.conversationId === 9001, "回执 accept 带原单 conversation_id");
	// 再重试一次：次数累加到 :2，不撞上一次的幂等键
	const again = makeRetryRuntime();
	const retriedAgain = retryTicketAction(store, RUNS, "T-retry-failed", again.runtime);
	check(
		retriedAgain.status === 200 &&
			String(again.calls[0]?.idempotencyKey ?? "").endsWith(":2"),
		"第二次重试用 :2，幂等键不撞车",
		String(again.calls[0]?.idempotencyKey),
	);

	store.close();
}

// 9. 取消/重试的 HTTP 端点形状 + 回滚开关（Hono app.request 真过一遍路由）
{
	const { Hono } = await import("hono");
	const { mountDelegationApi } = await import("../src/delegation-api.ts");
	const store = new DelegationReceipts(DB);
	const runtime: DelegationRuntime = {
		run: (_request, options) => {
			const ticketId = "T-http-retry-1";
			options?.onEvent?.({ type: "ticket", ticketId, message: "已受理" });
			return Promise.resolve({ ticketId, status: "done", line: "重派完成", tasks: [] });
		},
		emit: () => undefined,
		report: () => undefined,
		autoReport: true,
		isCanceled: (id) => store.isCanceled(id),
		log: () => undefined,
	};
	const build = (): InstanceType<typeof Hono> => {
		const app = new Hono();
		mountDelegationApi(app, { workRoot: RUNS, store, retryRuntime: () => runtime });
		return app;
	};
	const app = build();
	const cancelRes = await app.request("/api/v1/tickets/T-cancel-open/cancel", { method: "POST" });
	check(cancelRes.status === 200, "POST cancel → 200", `status=${cancelRes.status}`);
	const terminalRes = await app.request("/api/v1/tickets/T-terminal-done/cancel", { method: "POST" });
	check(terminalRes.status === 400, "终态 POST cancel → 400", `status=${terminalRes.status}`);
	const retryRes = await app.request("/api/v1/tickets/T-retry-failed/retry", { method: "POST" });
	const retryBody = (await retryRes.json()) as { ticketId?: string };
	check(
		retryRes.status === 200 && Boolean(retryBody.ticketId),
		"POST retry → 200 带新单号",
		`status=${retryRes.status}`,
	);

	// 回滚：DELEGATION_CANCEL=false → 两个端点都不挂（404）
	process.env.DELEGATION_CANCEL = "false";
	const offApp = build();
	const offCancel = await offApp.request("/api/v1/tickets/T-cancel-open/cancel", { method: "POST" });
	const offRetry = await offApp.request("/api/v1/tickets/T-retry-failed/retry", { method: "POST" });
	check(
		offCancel.status === 404 && offRetry.status === 404,
		"DELEGATION_CANCEL=false → 两个端点都 404",
		`cancel=${offCancel.status} retry=${offRetry.status}`,
	);
	process.env.DELEGATION_CANCEL = "true";
	store.close();
}

try {
	rmSync(TEMP, { recursive: true, force: true });
} catch {
	/* sqlite 句柄还开着时删不掉；临时目录在 tmpdir 下，留着无害 */
}

console.log(failures === 0 ? "\n✓ 续跑路由 / 取消重试全部通过" : `\n✗ 有 ${failures} 项不对`);
process.exit(failures === 0 ? 0 : 1);
