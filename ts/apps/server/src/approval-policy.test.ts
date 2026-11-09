import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { approvalRejectedInstruction } from "./agent/turn-gate.ts";

/**
 * 审批判定的三档矩阵（2026-11-08 扫尾批 10-C）。
 * 这一层是纯函数：拦优先、ask-all 问写类、ask-critical 只问高危、none 全放。
 */

const LEVELS: ApprovalLevel[] = ["ask-all", "ask-critical", "none"];

/** 常规写（ask-critical 下应自动放行） */
const ROUTINE_WRITE_TOOLS = ["write", "edit", "propose_project", "partner_skill_write", "group_manage"];
/** 高危（ask-critical 下也要问） */
const CRITICAL_TOOLS = ["bash", "powershell", "delegate", "partner_manage", "send_to_agent", "routine_manage"];

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

test("未登记的工具（2026-11-10 批 21 §1.3）：一律按最严处理，绝不静默放行", () => {
	// 声明表里没有 → 当作 destructive + critical：两个档位都要问，none 仍不问（与旧口径一致）
	assert.deepEqual(verdict("ask-all", "brand_new_tool"), { kind: "ask" });
	assert.deepEqual(verdict("ask-critical", "brand_new_tool"), { kind: "ask" });
	assert.deepEqual(verdict("none", "brand_new_tool"), { kind: "allow" });
	// 显式清单覆盖仍然生效（人配的优先于"保守兜底"）
	assert.deepEqual(verdict("ask-critical", "brand_new_tool", new Set(["write"])), { kind: "allow" });
});

test("拒绝理由：三种终态各给一句人话，且不带参数内容", () => {
	assert.match(denialReason("rejected", "bash", 120), /拒绝.*bash/);
	assert.match(denialReason("timeout", "bash", 120), /120 秒.*拒绝/);
	assert.match(denialReason("aborted", "bash", 120), /停止/);
});

test("拒绝带反馈（2026-11-09 §4.1）：不带时逐字节等于旧文案，带时换成指导语", () => {
	// 不带 feedback：与改动前的字符串完全一致（单测按字节断言）
	assert.equal(
		denialReason("rejected", "bash", 120),
		"你拒绝了这次 bash 调用，工具没有执行。",
	);
	// 带 feedback：换成「主人的要求」那一句，且不掺旧后缀
	assert.equal(
		denialReason("rejected", "bash", 120, "先只改 src/app.ts，别动样式"),
		"你拒绝了这次 bash 调用。主人的要求：先只改 src/app.ts，别动样式",
	);
	// 空白 feedback 视为没带
	assert.equal(
		denialReason("rejected", "bash", 120, "   "),
		"你拒绝了这次 bash 调用，工具没有执行。",
	);
	// 只对 rejected 生效：超时/中止传了也不用
	assert.match(denialReason("timeout", "bash", 120, "随便改"), /120 秒/);
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

test("拒绝续跑指令同样带反馈（async 路径）", () => {
	const legacy =
		"用户拒绝了 `write`：这个调用不要执行，也不要原样重试。" +
		"请继续其余工作，能做多少做多少；确实有必要换个做法，就提出新的调用（它仍会重新征求用户批准）。";
	assert.equal(approvalRejectedInstruction("write"), legacy);
	assert.equal(
		approvalRejectedInstruction("write", "只动 README"),
		"你拒绝了这次 write 调用。主人的要求：只动 README",
	);
});

// ── persona_recall（2026-11-09 persona 接入批一）────────────
test("persona_recall：进 WRITE_TOOLS；ask-all 问、none 放行、不进高危清单", () => {
	assert.ok(WRITE_TOOLS.has("persona_recall"), "起 python 子进程的工具必须进闸门");
	assert.ok(
		!(DEFAULT_CRITICAL_TOOLS as readonly string[]).includes("persona_recall"),
		"命令拼死、只有 query 文本，不该按高危打断用户",
	);
	assert.deepEqual(verdict("ask-all", "persona_recall"), { kind: "ask" });
	assert.deepEqual(verdict("ask-critical", "persona_recall"), { kind: "allow" });
	assert.deepEqual(verdict("none", "persona_recall"), { kind: "allow" });
});

test("persona_recall：read-only 档被 readOnlyBlockReason 拦下", async () => {
	// policy 的 access 在模块加载时读 env：先设好只读档与不存在 policy.json 的路径，
	// 再动态 import，避免读到本机 .data/policy.json。
	process.env.AGENT_TOOL_POLICY = "read-only";
	process.env.AGENT_POLICY_PATH = join(tmpdir(), "lifediary-approval-policy-no-policy.json");
	const { readOnlyBlockReason } = await import("./agent/policy.ts");
	assert.notEqual(readOnlyBlockReason("persona_recall"), undefined, "只读档应拦 persona_recall");
});
