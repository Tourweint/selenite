import assert from "node:assert/strict";
import { test } from "node:test";
import { autonomyRiskVerdict, AUTONOMY_RISK_TOOLS } from "./autonomy-risk.ts";

test("自主轮风险表：六类映射的三类可达工具在自主轮一律强制 ask", () => {
	for (const tool of ["set_reminder", "delegate", "propose_project", "write", "edit", "bash", "powershell", "partner_skill_write"]) {
		const verdict = autonomyRiskVerdict(tool, true);
		assert.equal(verdict.forceAsk, true, `${tool} 在自主轮必须强制 ask`);
		assert.ok(verdict.category, `${tool} 必须带风险类别`);
	}
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
