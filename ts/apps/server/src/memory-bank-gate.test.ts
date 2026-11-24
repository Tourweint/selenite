import assert from "node:assert/strict";
import { test } from "node:test";
import { externalRememberApproval, needsApproval } from "./approval-policy.ts";
import {
	EXTERNAL_REMEMBER_CAPABILITY,
	accessBlockReason,
	externalRememberBlockReason,
} from "./agent/policy.ts";
import { capabilityOf } from "./tool-capability.ts";
import { resolveUnattendedVerdict } from "./unattended.ts";

/**
 * 外部记忆库槽位的闸门（2026-11-23；2026-11-24 旧形态退役后）。
 *
 * 纯函数断言，不起 harness：
 *   - 内置 remember 在只读档仍放行（行为不变）；
 *   - 外部 remember 按写工具拦，文案说明换档；
 *   - 外部 remember 按 critical 审批：ask-all / ask-critical 都问，approval=none 不问。
 * beforeTool 的接线（lifecycle-harness）调用同一对函数 / 同一份能力面。
 */

test("闸门：内置 remember 在只读档仍放行（行为不变）", () => {
	assert.equal(accessBlockReason("read-only", "remember"), undefined);
	assert.equal(
		needsApproval({ approvalLevel: "ask-critical" }, "remember", undefined).kind,
		"allow",
		"内置 remember 不是高危工具，ask-critical 不弹",
	);
});

test("闸门：外部 remember 按写工具拦，文案给出回退路径", () => {
	const reason = externalRememberBlockReason("read-only");
	assert.ok(reason, "read-only 档必须拦");
	assert.match(reason, /只读/);
	assert.match(reason, /换档/);
	assert.ok(!reason.includes("MEMORY_BANK"), "旧形态已退役，文案不再提回滚开关");
	// 受限但允许改文件的档（no-shell）与完全访问不放行拦截——与写工具同档。
	assert.equal(externalRememberBlockReason("no-shell"), undefined);
	assert.equal(externalRememberBlockReason("full"), undefined);
	// 只读档对真写工具同样拦（同一判据的对照）。
	assert.ok(accessBlockReason("read-only", "write"));
});

test("闸门：外部 remember 按 critical 审批（none 档显式不问）", () => {
	assert.equal(externalRememberApproval("ask-all"), "ask");
	assert.equal(externalRememberApproval("ask-critical"), "ask");
	assert.equal(externalRememberApproval("none"), "allow");
});

test("闸门：无人值守下外部 remember 按写工具能力面 → skip（不自动放行）", () => {
	assert.equal(resolveUnattendedVerdict("remember", capabilityOf("remember")), "allow");
	assert.equal(
		resolveUnattendedVerdict("remember", EXTERNAL_REMEMBER_CAPABILITY),
		"skip",
		"外部 remember 起进程写外部库，无人值守不能 allow",
	);
	assert.equal(EXTERNAL_REMEMBER_CAPABILITY.destructive, true);
	assert.equal(EXTERNAL_REMEMBER_CAPABILITY.needsApproval, "critical");
});
