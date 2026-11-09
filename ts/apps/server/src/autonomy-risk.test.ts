import assert from "node:assert/strict";
import { test } from "node:test";
import {
	autonomyEscalationBlockReason,
	autonomyNoEscalationEnabled,
	autonomyRiskVerdict,
	AUTONOMY_NO_ESCALATION_TOOLS,
	AUTONOMY_RISK_TOOLS,
} from "./autonomy-risk.ts";

test("自主轮风险表：六类映射的三类可达工具在自主轮一律强制 ask", () => {
	for (const tool of ["set_reminder", "delegate", "propose_project", "partner_manage", "routine_manage", "write", "edit", "bash", "powershell", "partner_skill_write"]) {
		const verdict = autonomyRiskVerdict(tool, true);
		assert.equal(verdict.forceAsk, true, `${tool} 在自主轮必须强制 ask`);
		assert.ok(verdict.category, `${tool} 必须带风险类别`);
	}
});

test("自主轮风险表：partner_manage 建/停执事属 new_task（D14 备忘兑现）", () => {
	assert.equal(AUTONOMY_RISK_TOOLS.partner_manage, "new_task");
	const auto = autonomyRiskVerdict("partner_manage", true);
	assert.equal(auto.forceAsk, true, "自主轮里总管建/停执事必须弹卡（禁记住绕过）");
	assert.equal(auto.category, "new_task");
	const normal = autonomyRiskVerdict("partner_manage", false);
	assert.equal(normal.forceAsk, false, "普通轮按 AGENT_CONFIRM_WRITES 口径，不归风险表管");
});

test("自主轮风险表：routine_manage 自建巡逻属 new_task（刀二 E4，D14 备忘兑现）", () => {
	assert.equal(AUTONOMY_RISK_TOOLS.routine_manage, "new_task");
	const auto = autonomyRiskVerdict("routine_manage", true);
	assert.equal(auto.forceAsk, true, "自主轮里执事自建常驻轮必须弹卡（禁记住绕过）");
	assert.equal(auto.category, "new_task");
	const normal = autonomyRiskVerdict("routine_manage", false);
	assert.equal(normal.forceAsk, false, "普通轮按审批档口径，不归风险表管");
});

test("自主轮风险表：普通轮行为完全不变（D6 口径不动）", () => {
	for (const tool of Object.keys(AUTONOMY_RISK_TOOLS)) {
		assert.equal(autonomyRiskVerdict(tool, false).forceAsk, false, `${tool} 在普通轮不归风险表管`);
	}
});

test("自主轮风险表：自主轮的只读工具不拦", () => {
	for (const tool of ["read", "recall", "remember", "skill"]) {
		assert.equal(autonomyRiskVerdict(tool, true).forceAsk, false, `${tool} 是只读，自主轮也不该拦`);
	}
});

// ── 自动化永不扩权（2026-11-09 T2 §4.3）────────────────────

test("永不扩权：自主轮里四个扩权工具结构性拒绝（是 block 不是 ask）", () => {
	for (const tool of ["routine_manage", "partner_manage", "group_manage", "send_to_agent"]) {
		assert.equal(AUTONOMY_NO_ESCALATION_TOOLS.has(tool), true, `${tool} 应在拒绝清单`);
		const reason = autonomyEscalationBlockReason(tool, {}, true);
		assert.ok(reason, `${tool} 必须被 block`);
		assert.match(reason ?? "", /自动化不能给自己扩权/, `${tool} 理由口径`);
	}
});

test("永不扩权：delegate 带 targetDevice 被 block；缺 project 的新派被 block；带 project 放行", () => {
	const byDevice = autonomyEscalationBlockReason(
		"delegate",
		{ requirement: "x", project: "p", targetDevice: "device-b" },
		true,
	);
	assert.match(byDevice ?? "", /不能遥控别的设备/);

	const noProject = autonomyEscalationBlockReason("delegate", { requirement: "x" }, true);
	assert.match(noProject ?? "", /必须带 project/);

	assert.equal(
		autonomyEscalationBlockReason(
			"delegate",
			{ requirement: "x", project: "proj-1" },
			true,
		),
		undefined,
		"带 project 的本机派活仍然允许（派活是本分）",
	);
	assert.equal(
		autonomyEscalationBlockReason("delegate", { requirement: "x", resume: true }, true),
		undefined,
		"续跑沿用原单项目，可以不带 project",
	);
});

test("永不扩权：非自主轮逐条不受影响", () => {
	for (const tool of ["routine_manage", "partner_manage", "group_manage", "send_to_agent"]) {
		assert.equal(autonomyEscalationBlockReason(tool, {}, false), undefined, `${tool} 普通轮放行`);
	}
	assert.equal(
		autonomyEscalationBlockReason(
			"delegate",
			{ requirement: "x", targetDevice: "device-b" },
			false,
		),
		undefined,
		"普通轮的设备派活不归这张表管",
	);
	assert.equal(autonomyEscalationBlockReason("delegate", { requirement: "x" }, false), undefined);
});

test("永不扩权：AUTONOMY_NO_ESCALATION=false 回滚到今天的行为", () => {
	const previous = process.env.AUTONOMY_NO_ESCALATION;
	try {
		delete process.env.AUTONOMY_NO_ESCALATION;
		assert.equal(autonomyNoEscalationEnabled(), true, "缺省开");
		for (const value of ["false", "FALSE", "0", "off"]) {
			process.env.AUTONOMY_NO_ESCALATION = value;
			assert.equal(autonomyNoEscalationEnabled(), false, value);
			assert.equal(
				autonomyEscalationBlockReason("routine_manage", {}, true),
				undefined,
				`${value}：回滚后不拦`,
			);
		}
		process.env.AUTONOMY_NO_ESCALATION = "true";
		assert.equal(autonomyNoEscalationEnabled(), true);
	} finally {
		if (previous === undefined) delete process.env.AUTONOMY_NO_ESCALATION;
		else process.env.AUTONOMY_NO_ESCALATION = previous;
	}
});
