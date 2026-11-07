import assert from "node:assert/strict";
import { test } from "node:test";
import { createSseDecoder, encodeSseEvent, type ChatEvent } from "@lifediary/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatReport,
	startDelegation,
	type DelegationEvent,
	type DelegationReport,
} from "./delegation.ts";
import { DelegationMessages } from "./delegation-messages.ts";
import type {
	ChancellorEvent,
	ChancellorRequest,
	TicketResult,
} from "../../../../../chancellor/src/index.ts";

function result(overrides: Partial<TicketResult> = {}): TicketResult {
	return {
		ticketId: "T-1",
		status: "done",
		line: "改完了",
		tasks: [],
		...overrides,
	};
}

/**
 * 假 chancellor：`sync` 在返回 Promise 之前先发事件，模拟 `runChancellor`
 * "第一次 await 之前就拿到单号"的行为。
 */
function fakeRun(
	sync: (emit: (event: ChancellorEvent) => void) => void,
	finish: Promise<TicketResult>,
): (request: ChancellorRequest, options: { onEvent?: (event: ChancellorEvent) => void }) => Promise<TicketResult> {
	return (_request, options) => {
		sync((event) => options.onEvent?.(event));
		return finish;
	};
}

test("立即返回任务单号，并把 domain 传给负责人", async () => {
	const events: DelegationEvent[] = [];
	let seen: ChancellorRequest | undefined;
	let resolveFinish: (value: TicketResult) => void = () => undefined;
	const finish = new Promise<TicketResult>((resolve) => {
		resolveFinish = resolve;
	});

	const { ticketId, outcome } = startDelegation(
		{ conversationId: 7, domain: "前端", requirement: "把按钮改成蓝色" },
		{
			run: (request, options) => {
				seen = request;
				options.onEvent?.({ type: "ticket", ticketId: "T-1", message: "已受理" });
				return finish;
			},
			emit: (_conversationId, event) => events.push(event),
			report: () => undefined,
			autoReport: false,
		},
	);

	// 关键：返回的时候单号已经有了，没有等后台跑完。
	assert.equal(ticketId, "T-1");
	assert.equal(seen?.requirement, "把按钮改成蓝色");
	assert.equal(seen?.domain, "前端");
	assert.equal(events.length, 1);
	assert.deepEqual(
		{
			type: events[0]?.type,
			ticketId: events[0]?.type === "delegate" ? events[0].ticketId : "",
			domain: events[0]?.type === "delegate" ? events[0].domain : "",
			phase: events[0]?.type === "delegate" ? events[0].phase : "",
			done: events[0]?.type === "delegate" ? events[0].done : -1,
			total: events[0]?.type === "delegate" ? events[0].total : -1,
			current: events[0]?.type === "delegate" ? events[0].current : "",
			lastAction: events[0]?.type === "delegate" ? events[0].lastAction : "",
		},
		{
			type: "delegate",
			ticketId: "T-1",
			domain: "前端",
			phase: "accepted",
			done: 0,
			total: 0,
			current: "已受理",
			lastAction: "已受理",
		},
	);
	assert.match(events[0]?.type === "delegate" ? events[0].lastHeartbeat ?? "" : "", /^\d{4}-/);

	resolveFinish(result({ ticketId: "T-1" }));
	await outcome;
});

test("执事直派：managers=false 传给 chancellor，且不注入身份", async () => {
	// 2026-11-07 消息即引导与执事直派：执事在自己领域内派活时，
	// 不再为该领域起一个分管宰相——请求带 managers:false，managerIdentity 不出现。
	let seen: ChancellorRequest | undefined;
	const { outcome } = startDelegation(
		{
			conversationId: 11,
			domain: "frontend",
			requirement: "把登录页的按钮对齐",
			managers: false,
		},
		{
			run: (request, options) => {
				seen = request;
				options.onEvent?.({ type: "ticket", ticketId: "T-9", message: "已受理" });
				return Promise.resolve(result({ ticketId: "T-9" }));
			},
			emit: () => undefined,
			// 即使装配层给了身份缝，直派也不该去取（取不到就没有）
			identityHitFor: () => ({ name: "不该被用", soul: "不该被用" }),
			report: () => undefined,
			autoReport: false,
		},
	);
	await outcome;

	assert.equal(seen?.managers, false, "直派必须显式关掉分管");
	assert.equal(seen?.domain, "frontend", "domain 仍保留，任务中心看得出是哪个领域派的");
	assert.equal(seen?.managerIdentity, undefined, "直派不注入身份（他就是该领域负责人）");
});

test("分管路径未回滚：不带 managers 时仍注入身份", async () => {
	let seen: ChancellorRequest | undefined;
	const { outcome } = startDelegation(
		{ conversationId: 12, domain: "frontend", requirement: "改个文案" },
		{
			run: (request, options) => {
				seen = request;
				options.onEvent?.({ type: "ticket", ticketId: "T-10", message: "已受理" });
				return Promise.resolve(result({ ticketId: "T-10" }));
			},
			emit: () => undefined,
			identityHitFor: () => ({ name: "小明", soul: "你是小明" }),
			report: () => undefined,
			autoReport: false,
		},
	);
	await outcome;

	assert.equal(seen?.managers, undefined, "总管 / 主人会话不能被悄悄改成直派");
	assert.equal(seen?.managerIdentity?.name, "小明");
});

test("派活留言：受理落一条 out（带发送者），终态落一条 in", async () => {
	// 2026-11-07 派活留言：任务详情要能回答"谁让我干这个"。
	const dir = mkdtempSync(join(tmpdir(), "lifediary-msg-"));
	const messages = new DelegationMessages(join(dir, "delegations.sqlite"));
	const realPath = process.env.DELEGATIONS_DB_PATH;
	process.env.DELEGATIONS_DB_PATH = join(dir, "delegations.sqlite");
	// delegation.ts 用模块级单例；探针里换落点，别写进真实 .data
	const { resetDelegationMessages } = await import("./delegation-messages.ts");
	resetDelegationMessages(join(dir, "delegations.sqlite"));
	try {
		const { outcome } = startDelegation(
			{
				conversationId: 21,
				domain: "frontend",
				requirement: "把登录页的按钮对齐",
				sender: { kind: "chief", name: "总管" },
			},
			{
				run: (_request, options) => {
					options.onEvent?.({ type: "ticket", ticketId: "T-MSG", message: "已受理" });
					return Promise.resolve(result({ ticketId: "T-MSG", line: "对齐了，三个文件" }));
				},
				emit: () => undefined,
				report: () => undefined,
				autoReport: false,
			},
		);
		await outcome;

		const stored = messages.list("T-MSG");
		assert.equal(stored.length >= 2, true, `至少 out + in 两条，实际 ${stored.length}`);
		const out = stored.find((m) => m.direction === "out");
		const back = stored.find((m) => m.direction === "in");
		assert.ok(out, "必须有派出去的那条");
		assert.equal(out?.fromKind, "chief");
		assert.equal(out?.fromName, "总管");
		assert.match(out?.body ?? "", /按钮对齐/);
		assert.ok(back, "必须有交回来的那条");
		assert.match(back?.body ?? "", /三个文件/);
		assert.equal(messages.list("T-NOT-EXIST").length, 0, "没有记录 = 空数组，不是错误");
	} finally {
		resetDelegationMessages();
		if (realPath === undefined) delete process.env.DELEGATIONS_DB_PATH;
		else process.env.DELEGATIONS_DB_PATH = realPath;
		messages.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("后台完成：发终态 +「需要你」并回灌会话", async () => {
	const events: DelegationEvent[] = [];
	const reports: DelegationReport[] = [];

	const { outcome } = startDelegation(
		{ conversationId: 9, domain: "文档", requirement: "整理变更记录" },
		{
			run: fakeRun(
				(emit) => emit({ type: "ticket", ticketId: "T-2", message: "已受理" }),
				Promise.resolve(
					result({
						ticketId: "T-2",
						status: "needs_you",
						line: "缺一份素材",
						attention: { kind: "need_input", question: "把原始素材发我？" },
					}),
				),
			),
			emit: (_conversationId, event) => events.push(event),
			report: (_conversationId, report) => reports.push(report),
			autoReport: true,
		},
	);

	await outcome;

	const terminal = events.filter((event) => event.type === "delegate").at(-1);
	assert.equal(terminal?.type, "delegate");
	if (terminal?.type === "delegate") {
		assert.equal(terminal.phase, "needs_you");
		assert.equal(terminal.ticketId, "T-2");
		assert.equal(terminal.domain, "文档");
		assert.equal(terminal.message, "缺一份素材");
	}
	const attention = events.find((event) => event.type === "attention");
	assert.ok(attention);
	if (attention?.type === "attention") {
		assert.equal(attention.ticketId, "T-2");
		assert.equal(attention.kind, "need_input");
		assert.equal(attention.question, "把原始素材发我？");
	}
	assert.equal(reports.length, 1);
	assert.equal(reports[0]?.phase, "needs_you");
	assert.match(reports[0]?.text ?? "", /T-2/);
	assert.match(reports[0]?.text ?? "", /文档/);
});

test("续跑的单号对不上时改派新单", async () => {
	const requests: ChancellorRequest[] = [];
	const events: DelegationEvent[] = [];

	const { ticketId, fellBack } = startDelegation(
		{ conversationId: 11, domain: "前端", requirement: "验证码 1234", resumeTicketId: "T-old" },
		{
			run: (request, options) => {
				requests.push(request);
				if (requests.length === 1) {
					// 续跑在派活前就被拒了：没有发任何带单号的事件。
					return Promise.reject(new Error("这张单已经结束"));
				}
				options.onEvent?.({ type: "manager", ticketId: "T-new" });
				return new Promise<TicketResult>(() => undefined);
			},
			emit: (_conversationId, event) => events.push(event),
			report: () => undefined,
			autoReport: false,
		},
	);

	assert.equal(requests.length, 2);
	assert.equal(requests[0]?.resumeTicketId, "T-old");
	assert.equal(requests[0]?.answer, "验证码 1234");
	assert.equal(requests[1]?.resumeTicketId, undefined);
	assert.equal(requests[1]?.requirement, "验证码 1234");
	assert.equal(requests[1]?.domain, "前端");
	// 第二次派活发了带单号的 manager 事件；返回的也应当是这张新单，
	// 这样调用方不会把它当成续跑成功。
	assert.equal(ticketId, "T-new");
	assert.equal(fellBack, true);

	// 让第一次的拒绝被消费掉，避免测试进程里留下未处理拒绝。
	await new Promise((resolve) => setImmediate(resolve));
});

test("formatReport 按 80 字截断，并写清单号与领域", () => {
	const report = formatReport(
		result({ ticketId: "T-9", status: "done", line: "x".repeat(200) }),
		"前端",
	);
	assert.equal(report.phase, "done");
	assert.ok(report.text.startsWith("【任务 T-9 · 前端】已完成："));
	assert.equal(report.text.length, 80);
	assert.ok(report.text.endsWith("…"));
});

test("SSE 编解码能往返 delegate / attention 的新字段", () => {
	const event: ChatEvent = {
		type: "delegate",
		ticketId: "T-3",
		domain: "桌面壳",
		phase: "running",
		done: 1,
		total: 3,
		current: "改窗口",
	};
	assert.deepEqual(createSseDecoder().push(encodeSseEvent(event)), [event]);

	const attention: ChatEvent = {
		type: "attention",
		ticketId: "T-3",
		domain: "桌面壳",
		kind: "need_action",
		question: "请点一下登录按钮",
	};
	assert.deepEqual(createSseDecoder().push(encodeSseEvent(attention)), [attention]);
});
