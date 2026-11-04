// 续跑路由探针（v0.6）：验 harness 这头怎么把「用户的回答」送回原单。
//
// 不碰真模型、不碰 chancellor 磁盘：用 ToolDeps.delegateRun 注入假入口，
// 只断言路由本身（会话隔离、resume 参数、没单可续的兜底、进度/需要人帧）。
//
// 用法：`pnpm --filter @lifediary/server resume`
import type {
	ChancellorOptions,
	ChancellorRequest,
	TicketResult,
} from "../../../../../chancellor/src/index.ts";
import { watchDelegation, type DelegationEvent } from "../src/delegation.ts";
import { createTools } from "../src/tools.ts";

// 这个探针验的是路由（resume / 新派 / 会话隔离），要同步拿结论；
// 异步受理与后台回灌由 `src/delegation.test.ts` 覆盖。
process.env.DELEGATION_ASYNC = "false";
// 项目前置由 `src/projects.test.ts` 覆盖；这里只验路由，不注入项目登记表。
process.env.DELEGATION_PROJECT_REQUIRED = "false";

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

function makeFake(options: { resumeThrows?: boolean } = {}) {
	const calls: ChancellorRequest[] = [];
	let newTickets = 0;
	let resumeThrows = options.resumeThrows ?? false;

	const run: Runner = async (req, opts) => {
		calls.push(req);
		// 与 chancellor 一致：单子已完成/找不到时，续跑在派活前就抛错，不发任何事件。
		if (req.resumeTicketId && resumeThrows) throw new Error("这单没有在等回答的任务");

		opts?.onEvent?.({ type: "planned", ticketId: "fake", total: 1 });
		opts?.onEvent?.({ type: "task-start", ticketId: "fake", slug: "do-it" });
		opts?.onEvent?.({ type: "task-done", ticketId: "fake", slug: "do-it" });

		if (req.resumeTicketId) {
			return {
				ticketId: req.resumeTicketId,
				status: "done",
				line: `续上了：${req.answer ?? ""}`,
				tasks: [],
			};
		}

		newTickets += 1;
		return {
			ticketId: `t${newTickets}`,
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

	return async (conversationId: number, args: { requirement: string; resume?: boolean }) => {
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

console.log(failures === 0 ? "\n✓ 续跑路由全部通过" : `\n✗ 续跑路由有 ${failures} 项不对`);
process.exit(failures === 0 ? 0 : 1);
