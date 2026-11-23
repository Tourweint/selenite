import assert from "node:assert/strict";
import { test } from "node:test";
import {
	answerEscalation,
	buildChiefEscalationPrompt,
	defaultEscalationDeps,
	escalateToUser,
	escalationMaxPerTask,
	initEscalationRouting,
	onEscalationEvent,
	resetEscalationState,
	triggerChiefTurn,
	type EscalationRoutingDeps,
} from "./escalation.ts";
import type { DelegationEvent } from "./delegation.ts";

/** 上报事件构造器（形状与 DelegationEvent 的 escalation 成员一致）。 */
function escalationEvent(overrides: Partial<Extract<DelegationEvent, { type: "escalation" }>> = {}) {
	return {
		type: "escalation" as const,
		ticketId: overrides.ticketId ?? "ticket-1",
		domain: overrides.domain ?? "frontend",
		escalationId: overrides.escalationId ?? "esc-1",
		question: overrides.question ?? "目录结构选 A 还是 B？",
		context: overrides.context ?? "两种都可行",
		options: overrides.options ?? ["A", "B"],
		urgency: overrides.urgency ?? ("normal" as const),
	};
}

interface FakeCalls {
	wake: Array<{ partnerId: string; payload: Record<string, unknown> }>;
	continueTurn: Array<{ conversationId: number; text: string }>;
	forward: Array<{ ticketId: string; text: string }>;
	ask: Array<{ conversationId: number; question: string; options?: string[] }>;
	log: string[];
}

/** 假 deps：记录 wake / continue / forward / ask 的调用，不碰真件。 */
function fakeDeps(overrides: Partial<EscalationRoutingDeps> = {}): EscalationRoutingDeps & {
	calls: FakeCalls;
} {
	const calls: FakeCalls = {
		wake: [],
		continueTurn: [],
		forward: [],
		ask: [],
		log: [],
	};
	const deps: EscalationRoutingDeps = {
		companionsEnabled: () => true,
		canonicalPartnerIdOfSession: () => "partner-1",
		partnerStatus: () => "active",
		maxPerTask: () => 2,
		wakePartner: (partnerId, payload) => calls.wake.push({ partnerId, payload }),
		continueTurn: (conversationId, text) => calls.continueTurn.push({ conversationId, text }),
		createAsk: (input) => {
			calls.ask.push({ conversationId: input.conversationId, question: input.question, options: input.options });
			return { ok: true, callId: `call-${calls.ask.length}` };
		},
		forwardToWorker: (ticketId, text) => {
			calls.forward.push({ ticketId, text });
			return Promise.resolve({ ok: true });
		},
		log: (line) => calls.log.push(line),
		...overrides,
	};
	return { ...deps, calls } as never;
}

test("escalationMaxPerTask：缺省与 env 读法（ESCALATION_CHAIN_ENABLED 回滚开关 2026-11-21 退役）", () => {
	assert.equal(escalationMaxPerTask({}), 5);
	assert.equal(escalationMaxPerTask({ ESCALATION_MAX_PER_TASK: "2" }), 2);
	assert.equal(escalationMaxPerTask({ ESCALATION_MAX_PER_TASK: "0" }), 0);
	assert.equal(escalationMaxPerTask({ ESCALATION_MAX_PER_TASK: "bogus" }), 5);
});

test("路由：执事派单方 → 批3 agent-message 信封（kind=escalation），不直接问用户", () => {
	resetEscalationState();
	const { calls, ...deps } = fakeDeps();
	onEscalationEvent(escalationEvent(), 42, deps);
	assert.equal(calls.wake.length, 1);
	assert.equal(calls.wake[0].partnerId, "partner-1");
	assert.equal(calls.wake[0].payload.kind, "escalation");
	assert.equal(calls.wake[0].payload.ticketId, "ticket-1");
	assert.equal(calls.wake[0].payload.question, "目录结构选 A 还是 B？");
	assert.equal(calls.wake[0].payload.fromName, "工人上报");
	assert.equal(calls.ask.length, 0, "总管代答轮先行，不直接挂用户卡");
});

test("路由：总管主对话（无执事链接）→ continueConversation 起代答轮", () => {
	resetEscalationState();
	const { calls, ...deps } = fakeDeps({ canonicalPartnerIdOfSession: () => null });
	onEscalationEvent(escalationEvent(), 7, deps);
	assert.equal(calls.wake.length, 0);
	assert.equal(calls.continueTurn.length, 1);
	assert.equal(calls.continueTurn[0].conversationId, 7);
	assert.match(calls.continueTurn[0].text, /\[Escalation context\]/);
	assert.match(calls.continueTurn[0].text, /respond_escalation/);
});

test("限流一：每张单同时 1 条活跃上报 → 第二条被拒并回投 worker", async () => {
	resetEscalationState();
	const { calls, ...deps } = fakeDeps();
	onEscalationEvent(escalationEvent({ escalationId: "esc-1" }), 42, deps);
	onEscalationEvent(escalationEvent({ escalationId: "esc-2" }), 42, deps);
	assert.equal(calls.wake.length, 1, "只有第一条进了代答轮");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls.forward.length, 1, "第二条被拒，拒因 steer 回 worker");
	assert.match(calls.forward[0].text, /已有一条上报在等答复/);
});

test("限流二：答复清活跃后计数保留，超过上限 → 跳过总管直达用户（ask 卡）", async () => {
	resetEscalationState();
	const { calls, ...deps } = fakeDeps(); // maxPerTask=2
	onEscalationEvent(escalationEvent({ escalationId: "e1" }), 42, deps);
	assert.equal(calls.wake.length, 1);
	const answered1 = await answerEscalation("ticket-1", "答一：用 A", "chief", deps);
	assert.equal(answered1.ok, true);
	onEscalationEvent(escalationEvent({ escalationId: "e2" }), 42, deps);
	assert.equal(calls.wake.length, 2, "答复清活跃后，第二条照常进代答轮");
	await answerEscalation("ticket-1", "答二", "chief", deps);
	onEscalationEvent(escalationEvent({ escalationId: "e3" }), 42, deps);
	// 第 3 条（count=2 已达上限 2）：不再唤醒总管，直接挂用户卡
	assert.equal(calls.wake.length, 2, "超限直达用户，跳过总管");
	assert.equal(calls.ask.length, 1);
	assert.match(calls.ask[0].question, /【工人上报 · 单 ticket-1】/);
	assert.match(calls.ask[0].question, /目录结构选 A 还是 B？/);
	assert.deepEqual(calls.ask[0].options, ["A", "B"]);
});

test("答复台账与投回：署名进 steer 正文；worker 不在跑也照清活跃", async () => {
	resetEscalationState();
	const deps = fakeDeps({
		// 记录 + 返回失败：worker 已退场时答案照常记账、活跃照清（老通道接管）。
		forwardToWorker: (ticketId, text) => {
			deps.calls.forward.push({ ticketId, text });
			return Promise.resolve({ ok: false, error: "worker_not_running" });
		},
	});
	onEscalationEvent(escalationEvent(), 42, deps);
	const result = await answerEscalation("ticket-1", "用 A。", "user", deps);
	assert.equal(result.ok, true);
	assert.deepEqual(deps.calls.forward, [
		{ ticketId: "ticket-1", text: "[上报答复·主人] 用 A。" },
	]);
	// 清了活跃：再答一次 → no_active_escalation
	const again = await answerEscalation("ticket-1", "再答", "chief", deps);
	assert.equal(again.ok, false);
	assert.equal(again.error, "no_active_escalation");
});

test("escalateToUser / triggerChiefTurn：已升级后总管代答被拒；无活跃 → 404 形错误", () => {
	resetEscalationState();
	const { calls, ...deps } = fakeDeps();
	onEscalationEvent(escalationEvent({ question: "要花 500 元？", context: "预算" }), 42, deps);
	const escalated = escalateToUser("ticket-1", deps);
	assert.equal(escalated.ok, true);
	assert.ok(escalated.callId);
	const again = triggerChiefTurn("ticket-1", deps);
	assert.equal(again.ok, false);
	assert.equal(again.error, "already_escalated");

	resetEscalationState();
	const missing = triggerChiefTurn("ticket-x", deps);
	assert.equal(missing.ok, false);
	assert.equal(missing.error, "no_active_escalation");
	const noUser = escalateToUser("ticket-x", deps);
	assert.equal(noUser.ok, false);
	assert.equal(noUser.error, "no_active_escalation");
	assert.equal(calls.ask.length, 1);
});

test("buildChiefEscalationPrompt：总管口径与执事唤醒口径同一条纪律（respond_escalation）", () => {
	const text = buildChiefEscalationPrompt({
		ticketId: "t-1",
		domain: "qa",
		question: "q?",
		context: "c",
		options: ["x"],
		urgency: "high",
	});
	assert.match(text, /action="answer"/);
	assert.match(text, /action="escalate"/);
	assert.match(text, /候选：x/);
	assert.match(text, /紧急度 high/);
});

test("initEscalationRouting：订阅幂等（重复调用只挂一次）", () => {
	// 只验证不抛 + 幂等标记不重复（真实订阅副作用由装配层探针覆盖）。
	initEscalationRouting(defaultEscalationDeps);
	initEscalationRouting(defaultEscalationDeps);
	assert.ok(true);
});

// ── respond_escalation 工具（answer / escalate 两路）────────────

// 工具 execute 的类型签名要三参；本工具不读 api / context，测试桩给最小形状。
const stubApi = { conversationId: "42" } as never;
const stubContext = { abortSignal: new AbortController().signal } as never;

function toolOutput(raw: unknown): Record<string, unknown> {
	const payload = JSON.parse(String((raw as { output: Array<{ text: string }> }).output[0].text));
	return payload as Record<string, unknown>;
}

test("respond_escalation：answer 成功 → 答复投回 worker（带总管署名）；无活跃上报 → 可识别错误", async () => {
	const { setEscalationRoutingDeps } = await import("./escalation.ts");
	const { createRespondEscalationTool } = await import("./escalation.ts");
	resetEscalationState();
	const { calls, ...deps } = fakeDeps();
	setEscalationRoutingDeps(deps);
	try {
		onEscalationEvent(escalationEvent(), 42, deps);
		const tool = createRespondEscalationTool();
		const result = toolOutput(
			await tool.execute({ ticketId: "ticket-1", action: "answer", answer: "用 A。" }, stubApi, stubContext),
		);
		assert.equal(result.ok, true);
		assert.equal((result as { data?: { status?: string } }).data?.status, "answered");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(calls.forward, [{ ticketId: "ticket-1", text: "[上报答复·总管] 用 A。" }]);

		// 答完即清：再答 → no_active_escalation（模型可识别，不是笼统失败）
		const missing = toolOutput(
			await tool.execute({ ticketId: "ticket-1", action: "answer", answer: "再答" }, stubApi, stubContext),
		);
		assert.equal(missing.ok, false);
		assert.equal((missing as { error?: { code?: string } }).error?.code, "no_active_escalation");
	} finally {
		setEscalationRoutingDeps(defaultEscalationDeps);
	}
});

test("respond_escalation：escalate → ask 卡挂到派活方会话；answer 缺 answer → 400 形错误", async () => {
	const { setEscalationRoutingDeps, createRespondEscalationTool } = await import("./escalation.ts");
	resetEscalationState();
	const { calls, ...deps } = fakeDeps();
	setEscalationRoutingDeps(deps);
	try {
		onEscalationEvent(escalationEvent(), 42, deps);
		const tool = createRespondEscalationTool();
		const escalated = toolOutput(await tool.execute({ ticketId: "ticket-1", action: "escalate" }, stubApi, stubContext));
		assert.equal(escalated.ok, true);
		assert.equal((escalated as { data?: { status?: string } }).data?.status, "escalated");
		assert.equal(calls.ask.length, 1, "升级走现有 ask_user 管线");
		assert.match(calls.ask[0].question, /【工人上报/);

		// answer 动作没给 answer：可识别错误，引导用 escalate
		resetEscalationState();
		onEscalationEvent(escalationEvent(), 42, deps);
		const noAnswer = toolOutput(await tool.execute({ ticketId: "ticket-1", action: "answer" }, stubApi, stubContext));
		assert.equal(noAnswer.ok, false);
		assert.equal((noAnswer as { error?: { code?: string } }).error?.code, "bad_request");
	} finally {
		setEscalationRoutingDeps(defaultEscalationDeps);
	}
});
