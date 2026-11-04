import assert from "node:assert/strict";
import { test } from "node:test";
import {
	WRITE_TOOLS,
	approvalTimeoutSeconds,
	denialReason,
	needsApproval,
} from "./approval-policy.ts";

/**
 * 审批判定的四态矩阵（2026-11-04 批次二）。
 * 这一层是纯函数：拦优先、关着不问、黑名单不问、写类工具才问。
 */

test("只读档：写类工具直接拦，不进入审批", () => {
	const verdict = needsApproval({ confirmWrites: true }, "bash", "当前是「只读」模式");
	assert.deepEqual(verdict, { kind: "block", reason: "当前是「只读」模式" });
});

test("confirmWrites 关着：写类工具照常放行", () => {
	for (const tool of WRITE_TOOLS) {
		assert.deepEqual(needsApproval({ confirmWrites: false }, tool), { kind: "allow" });
	}
});

test("黑名单 / 不跑命令：先拦，不问", () => {
	assert.equal(needsApproval({ confirmWrites: true }, "bash", "工具 bash 已被禁用").kind, "block");
	assert.equal(needsApproval({ confirmWrites: true }, "powershell", "不能执行命令").kind, "block");
});

test("开着确认：写类工具（含 delegate / propose_project）都要问", () => {
	for (const tool of ["write", "edit", "bash", "powershell", "delegate", "propose_project"]) {
		assert.deepEqual(needsApproval({ confirmWrites: true }, tool), { kind: "ask" });
	}
});

test("开着确认：读类 / 记忆类工具不问", () => {
	for (const tool of ["read", "remember", "recall", "skill"]) {
		assert.deepEqual(needsApproval({ confirmWrites: true }, tool), { kind: "allow" });
	}
});

test("拒绝理由：三种终态各给一句人话，且不带参数内容", () => {
	assert.match(denialReason("rejected", "bash", 120), /拒绝.*bash/);
	assert.match(denialReason("timeout", "bash", 120), /120 秒.*拒绝/);
	assert.match(denialReason("aborted", "bash", 120), /停止/);
});

test("审批超时：默认 120；0 / 负数 / 非法值都回落 120", () => {
	assert.equal(approvalTimeoutSeconds({}), 120);
	assert.equal(approvalTimeoutSeconds({ AGENT_APPROVAL_TIMEOUT_S: "" }), 120);
	assert.equal(approvalTimeoutSeconds({ AGENT_APPROVAL_TIMEOUT_S: "1" }), 1);
	assert.equal(approvalTimeoutSeconds({ AGENT_APPROVAL_TIMEOUT_S: "1.9" }), 1);
	assert.equal(approvalTimeoutSeconds({ AGENT_APPROVAL_TIMEOUT_S: "0" }), 120);
	assert.equal(approvalTimeoutSeconds({ AGENT_APPROVAL_TIMEOUT_S: "-5" }), 120);
	assert.equal(approvalTimeoutSeconds({ AGENT_APPROVAL_TIMEOUT_S: "abc" }), 120);
});
