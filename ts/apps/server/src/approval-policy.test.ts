import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { accessBlockReason } from "./agent/policy.ts";

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

test("persona_recall：read-only 档被拦下", () => {
	// 断言纯函数 `accessBlockReason`，不看进程级 `policy.access`：那个值在模块加载时读 env
	// 与本机 `.data/policy.json`，和别的测试文件同进程跑时会串味（2026-11-14 修）。
	assert.notEqual(accessBlockReason("read-only", "persona_recall"), undefined, "只读档应拦 persona_recall");
	assert.equal(accessBlockReason("full", "persona_recall"), undefined, "完全访问档不拦");
});

// ── 查看命令进权限档（2026-11-14）────────────────────────────
test("只读 / 在工作区内修改：查看命令放行，动手的命令照旧拦", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-view-policy-")));
	writeFileSync(join(root, "a.md"), "x\n");
	const ctx = { args: { command: "ls -la" }, workspaceRoots: [root], cwd: root };
	const withCommand = (command: string) => ({ ...ctx, args: { command } });
	const at = (access: "full" | "read-only" | "no-shell", name: string, c?: typeof ctx) =>
		accessBlockReason(access, name, c);

	assert.equal(at("read-only", "bash", ctx), undefined, "只读档应放行 ls");
	assert.equal(at("read-only", "bash", withCommand("cat a.md")), undefined, "只读档应放行 cat");
	assert.equal(at("read-only", "bash", withCommand("grep -rn hello .")), undefined, "只读档应放行 grep");
	assert.notEqual(at("read-only", "bash", withCommand("rm -rf .")), undefined, "只读档应拦 rm");
	assert.notEqual(at("read-only", "bash", withCommand("npm test")), undefined, "只读档应拦 npm test");
	assert.notEqual(
		at("read-only", "bash", withCommand("find . -delete")),
		undefined,
		"只读档应拦带 -delete 的 find",
	);
	assert.notEqual(at("read-only", "write", ctx), undefined, "只读档应拦 write");
	assert.notEqual(at("read-only", "delegate", ctx), undefined, "只读档应拦 delegate");
	// 老调用点（没有上下文）→ 保守照旧拦，行为与改动前一致。
	assert.notEqual(at("read-only", "bash"), undefined, "无上下文时应保守拦截");

	// 在工作区内修改：命令同样只放行查看，文件改不拦（越界归 path-guard）。
	assert.equal(at("no-shell", "bash", ctx), undefined, "在工作区内修改档应放行查看命令");
	assert.notEqual(at("no-shell", "bash", withCommand("npm test")), undefined, "在工作区内修改档应拦非查看命令");
	assert.equal(at("no-shell", "write", ctx), undefined, "在工作区内修改档不拦 write");

	// 完全访问：命令与文件都不拦。
	assert.equal(at("full", "bash", withCommand("npm test")), undefined, "完全访问档不拦命令");
	assert.equal(at("full", "write", ctx), undefined, "完全访问档不拦 write");

	// 回滚开关：写 0 后两档回到"一条命令都不跑"。
	process.env.AGENT_READ_VIEW_COMMANDS = "0";
	assert.notEqual(at("read-only", "bash", ctx), undefined, "关掉开关后只读档应拦 ls");
	assert.notEqual(at("no-shell", "bash", ctx), undefined, "关掉开关后中间档应拦 ls");
	delete process.env.AGENT_READ_VIEW_COMMANDS;

	rmSync(root, { recursive: true, force: true });
});
