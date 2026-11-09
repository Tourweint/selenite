import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTONOMY_RISK_TOOLS } from "./autonomy-risk.ts";
import { markAutonomyTurn, unmarkAutonomyTurn } from "./autonomy-state.ts";
import { TOOL_CAPABILITIES, capabilityOf } from "./tool-capability.ts";
import {
	UNATTENDED_SKIP_MESSAGE,
	clearUnattendedSkips,
	isTaskSession,
	isUnattended,
	markRoutineTurn,
	markTaskSession,
	noteUnattendedSkip,
	resetUnattendedState,
	resolveUnattendedVerdict,
	takeUnattendedSkips,
	unattendedDenyReason,
	unattendedPolicyEnabled,
	unmarkRoutineTurn,
} from "./unattended.ts";

/**
 * 无人值守权限语义单测（2026-11-10 批 13 §一/§二）。
 *
 * 最核心的一条钉在这里：**绝不挂起**——无人值守下每个工具都必须收口成
 * allow / skip / deny 三态之一，需要审批的那一类不可能落到 "allow" 去走审批流程。
 */

test("开关：默认关；只有 1/true/on 才生效", () => {
	assert.equal(unattendedPolicyEnabled({}), false);
	assert.equal(unattendedPolicyEnabled({ AGENT_UNATTENDED_POLICY: "" }), false);
	assert.equal(unattendedPolicyEnabled({ AGENT_UNATTENDED_POLICY: "0" }), false);
	assert.equal(unattendedPolicyEnabled({ AGENT_UNATTENDED_POLICY: "false" }), false);
	assert.equal(unattendedPolicyEnabled({ AGENT_UNATTENDED_POLICY: "1" }), true);
	assert.equal(unattendedPolicyEnabled({ AGENT_UNATTENDED_POLICY: "true" }), true);
	assert.equal(unattendedPolicyEnabled({ AGENT_UNATTENDED_POLICY: "ON" }), true);
});

test("isUnattended：例行轮 / 自主轮 / task- 会话 / AGENT_UNATTENDED=1 四种来源", () => {
	resetUnattendedState();
	const previous = process.env.AUTONOMY_ENABLED;
	try {
		assert.equal(isUnattended(11, {}), false);

		markRoutineTurn(11);
		assert.equal(isUnattended(11, {}), true, "例行轮必须算没人看着（不依赖 AUTONOMY_ENABLED）");
		unmarkRoutineTurn(11);
		assert.equal(isUnattended(11, {}), false);

		markTaskSession(12);
		assert.equal(isUnattended(12, {}), true, "task- 专线必须算没人看着");
		assert.equal(isTaskSession(12), true);

		process.env.AUTONOMY_ENABLED = "true";
		markAutonomyTurn(13);
		assert.equal(isUnattended(13, {}), true, "既有自主轮标记同样生效");
		unmarkAutonomyTurn(13);

		assert.equal(isUnattended(99, { AGENT_UNATTENDED: "1" }), true, "一键全开");
		assert.equal(isUnattended(99, { AGENT_UNATTENDED: "0" }), false);
	} finally {
		if (previous === undefined) delete process.env.AUTONOMY_ENABLED;
		else process.env.AUTONOMY_ENABLED = previous;
		resetUnattendedState();
	}
});

test("三态：纯读 allow / 花钱与要批准 skip / 扩权 deny", () => {
	// 纯读 / 只写内部状态
	for (const name of ["read", "recall", "remember", "skill", "web_search", "propose_topic"]) {
		assert.equal(resolveUnattendedVerdict(name), "allow", `${name} 应放行`);
	}
	// 写盘 / 起进程 / 派活 / 花钱 / 提问
	for (const name of [
		"write",
		"edit",
		"bash",
		"powershell",
		"delegate",
		"propose_project",
		"partner_skill_write",
		"persona_recall",
		"ask_user",
		"set_reminder",
	]) {
		assert.equal(resolveUnattendedVerdict(name), "skip", `${name} 应跳过并明说`);
	}
	// 扩权 / 影响系统（递话会起对方一轮，与自主轮结构性拒绝同口径）
	for (const name of ["partner_manage", "group_manage", "routine_manage", "send_to_agent"]) {
		assert.equal(resolveUnattendedVerdict(name), "deny", `${name} 应显式拒绝`);
	}
});

test("三态：不认识的工具按 skip 收口（宁可不跑，也不猜它安全）", () => {
	assert.equal(resolveUnattendedVerdict("totally_new_tool"), "skip");
	assert.equal(resolveUnattendedVerdict("delete_everything"), "deny", "删除类按名字兜底拒绝");
});

test("绝不挂起：需要审批的工具一律 skip/deny，不存在第四态", () => {
	for (const [name, capability] of Object.entries(TOOL_CAPABILITIES)) {
		const verdict = resolveUnattendedVerdict(name, capability);
		assert.ok(
			verdict === "allow" || verdict === "skip" || verdict === "deny",
			`${name} 返回了未知态 ${String(verdict)}`,
		);
		const wouldAsk =
			capability.needsApproval !== "never" ||
			capability.destructive ||
			Boolean(AUTONOMY_RISK_TOOLS[name]);
		if (wouldAsk) {
			assert.notEqual(
				verdict,
				"allow",
				`${name} 本来要人批准，无人值守下却放行——这就是挂起（落 pending 等人）的入口`,
			);
		}
	}
	// ask_user 一定不会 allow：问了没人答就是挂起。
	assert.equal(resolveUnattendedVerdict("ask_user", capabilityOf("ask_user")), "skip");
});

test("跳过话术固定，且不含任何工具参数 / 正文占位", () => {
	assert.match(UNATTENDED_SKIP_MESSAGE, /无人值守/);
	assert.match(UNATTENDED_SKIP_MESSAGE, /已跳过/);
	assert.match(UNATTENDED_SKIP_MESSAGE, /明确写出/);
	assert.match(unattendedDenyReason("routine_manage"), /routine_manage/);
	assert.doesNotMatch(unattendedDenyReason("routine_manage"), /triggers|prompt/);
});

test("跳过记账：只记工具名，取走即清空", () => {
	resetUnattendedState();
	noteUnattendedSkip(21, "bash");
	noteUnattendedSkip(21, "delegate");
	noteUnattendedSkip(21, "bash"); // 同名去重
	assert.deepEqual(takeUnattendedSkips(21), ["bash", "delegate"]);
	assert.deepEqual(takeUnattendedSkips(21), [], "取走即清空");
	noteUnattendedSkip(21, "write");
	clearUnattendedSkips(21);
	assert.deepEqual(takeUnattendedSkips(21), []);
});
