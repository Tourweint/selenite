import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_CRITICAL_TOOLS,
	WRITE_TOOLS,
	approvalCriticalTools,
	approvalTimeoutSeconds,
	denialReason,
	needsApproval,
	type ApprovalLevel,
} from "./approval-policy.ts";

/**
 * 审批判定的三档矩阵（2026-11-08 扫尾批 10-C）。
 * 这一层是纯函数：拦优先、ask-all 问写类、ask-critical 只问高危、none 全放。
 */

const LEVELS: ApprovalLevel[] = ["ask-all", "ask-critical", "none"];

/** 常规写（ask-critical 下应自动放行） */
const ROUTINE_WRITE_TOOLS = ["write", "edit", "propose_project", "partner_skill_write", "group_manage"];
/** 高危（ask-critical 下也要问） */
const CRITICAL_TOOLS = ["bash", "powershell", "delegate", "partner_manage", "send_to_agent"];

function verdict(level: ApprovalLevel, tool: string, critical?: ReadonlySet<string>) {
	return needsApproval({ approvalLevel: level }, tool, undefined, critical);
}

test("只读档：写类工具直接拦，不进入审批", () => {
	for (const level of LEVELS) {
		assert.deepEqual(needsApproval({ approvalLevel: level }, "bash", "当前是「只读」模式"), {
			kind: "block",
			reason: "当前是「只读」模式",
		});
	}
});

test("黑名单 / 不跑命令：先拦，不问", () => {
	for (const level of LEVELS) {
		assert.equal(needsApproval({ approvalLevel: level }, "bash", "工具 bash 已被禁用").kind, "block");
		assert.equal(needsApproval({ approvalLevel: level }, "powershell", "不能执行命令").kind, "block");
	}
});

test("ask-all：写类工具全问，且包含高危清单（三档单调）", () => {
	for (const tool of WRITE_TOOLS) {
		assert.deepEqual(verdict("ask-all", tool), { kind: "ask" }, tool);
	}
	// send_to_agent 不在 WRITE_TOOLS，但会起一轮对方模型调用：
	// 「全部问我」必须包含「只问重要的」会问的，否则档位不单调
	for (const tool of CRITICAL_TOOLS) {
		assert.deepEqual(verdict("ask-all", tool), { kind: "ask" }, tool);
	}
	assert.deepEqual(verdict("ask-all", "delegate"), { kind: "ask" });
	assert.deepEqual(verdict("ask-all", "write"), { kind: "ask" });
});

test("ask-all：读类 / 记忆类工具不问", () => {
	for (const tool of ["read", "remember", "recall", "skill"]) {
		assert.deepEqual(verdict("ask-all", tool), { kind: "allow" }, tool);
	}
});

test("ask-critical：只问高危清单，常规写自动放行", () => {
	for (const tool of CRITICAL_TOOLS) {
		assert.deepEqual(verdict("ask-critical", tool), { kind: "ask" }, tool);
	}
	for (const tool of ROUTINE_WRITE_TOOLS) {
		assert.deepEqual(verdict("ask-critical", tool), { kind: "allow" }, tool);
	}
	for (const tool of ["read", "recall", "remember"]) {
		assert.deepEqual(verdict("ask-critical", tool), { kind: "allow" }, tool);
	}
});

test("none：什么都不问（写类 / 命令 / 派活全放行）", () => {
	for (const tool of [...WRITE_TOOLS, ...CRITICAL_TOOLS, "read", "recall"]) {
		assert.deepEqual(verdict("none", tool), { kind: "allow" }, tool);
	}
});

test("critical 清单：缺省五项；env 逗号分隔整体覆盖；空串回落缺省", () => {
	const fallback = approvalCriticalTools({});
	assert.deepEqual([...fallback].sort(), [...DEFAULT_CRITICAL_TOOLS].sort());

	const overridden = approvalCriticalTools({ AGENT_APPROVAL_CRITICAL_TOOLS: " write , edit ,," });
	assert.deepEqual([...overridden].sort(), ["edit", "write"]);
	assert.deepEqual(verdict("ask-critical", "bash", overridden), { kind: "allow" });
	assert.deepEqual(verdict("ask-critical", "write", overridden), { kind: "ask" });

	const blank = approvalCriticalTools({ AGENT_APPROVAL_CRITICAL_TOOLS: "  " });
	assert.deepEqual([...blank].sort(), [...DEFAULT_CRITICAL_TOOLS].sort());
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
