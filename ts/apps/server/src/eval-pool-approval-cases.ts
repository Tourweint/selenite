/**
 * 纯判定函数的小回归集（2026-11-10 批 20 §三）。
 *
 * 这是**测试资产**，不是运行时功能：服务端不 import 本模块，也没有开关。
 *
 * 为什么单独成池：`needsApproval()` 与 `resolveUnattendedVerdict()` 决定"谁会被拦 /
 * 被问 / 被跳过"，改一个 if 就可能把安全语义改反；但它们没有任何外部依赖，适合用
 * 一份小而全的案例表钉住。tune / holdout 两池用来防"照着测试改代码"：
 *   - `tune`：日常开发跟着改，允许在需求变化时更新期望；
 *   - `holdout`：**只在发布前跑**，平时不改；如果它突然红了，先怀疑实现而不是改期望。
 *
 * 2026-11-10 批两个池都跑（任务书 §3.2），但用途按上面的口径标清楚。
 *
 * 2026-11-12 扩容（总账 #34"其余函数待补"）：新增三个池，照同款 12 条 6/6 分法——
 *   - `resolveDelegateRouting`（执事直派四象限 + 总闸回滚，`delegate-routing.ts`）；
 *   - `autonomyEscalationBlockReason`（自主轮结构性拒绝：扩权表 / 遥控设备 / project，`autonomy-risk.ts`）；
 *   - `delegationRunSource`（派单来源优先级：测试 > 设备 > 例行轮 > 人，`run-source.ts`）。
 * 入选口径：同输入同输出、无 IO、无时钟；env / 开关一律显式传，不读开发机环境。
 * 调查过但**没有**入池的：`LoopGuard`（状态类且读 `Date.now()`，不是纯函数）、
 * `readOnlyBlockReason`（读模块级可变 `policy`，import 时读盘 / env）。
 */

import type { ApprovalLevel, ApprovalVerdict } from "./approval-policy.ts";
import { needsApproval } from "./approval-policy.ts";
import type { DelegateCaller } from "./delegate-routing.ts";
import type { UnattendedVerdict } from "./unattended.ts";
import { resolveUnattendedVerdict } from "./unattended.ts";

export type EvalPoolName = "tune" | "holdout";

export interface EvalCase<I> {
	/** 稳定 id：改名 / 调整期望时不要改，方便回看历史 */
	id: string;
	pool: EvalPoolName;
	input: I;
	expected: string;
}

export interface EvalOutcome extends EvalCase<unknown> {
	actual: string;
	ok: boolean;
}

export interface ApprovalEvalInput {
	level: ApprovalLevel;
	tool: string;
	blockReason?: string;
	/** 覆盖高危清单（默认走 `approvalCriticalTools()`，测试里不读开发机 env） */
	critical?: string[];
}

const APPROVAL_CASES: EvalCase<ApprovalEvalInput>[] = [
	// tune：三档的主干语义
	{
		id: "approval-all-read-allow",
		pool: "tune",
		input: { level: "ask-all", tool: "read" },
		expected: "allow",
	},
	{
		id: "approval-all-write-ask",
		pool: "tune",
		input: { level: "ask-all", tool: "write" },
		expected: "ask",
	},
	{
		id: "approval-all-bash-ask",
		pool: "tune",
		input: { level: "ask-all", tool: "bash" },
		expected: "ask",
	},
	{
		id: "approval-critical-write-allow",
		pool: "tune",
		input: { level: "ask-critical", tool: "write" },
		expected: "allow",
	},
	{
		id: "approval-critical-delegate-ask",
		pool: "tune",
		input: { level: "ask-critical", tool: "delegate" },
		expected: "ask",
	},
	{
		id: "approval-none-bash-allow",
		pool: "tune",
		input: { level: "none", tool: "bash" },
		expected: "allow",
	},

	// holdout：边界与"看起来像但不该问"的组合（发布前跑，平时不改）
	{
		id: "approval-block-wins-over-level",
		pool: "holdout",
		input: { level: "none", tool: "bash", blockReason: "当前是「只读」模式" },
		expected: "block",
	},
	{
		id: "approval-all-send-to-agent-ask",
		pool: "holdout",
		// send_to_agent 不在 WRITE_TOOLS，但会起对方一轮（烧 token）——
		// ask-all 必须包含 ask-critical 会问的，否则档位不单调
		input: { level: "ask-all", tool: "send_to_agent" },
		expected: "ask",
	},
	{
		id: "approval-critical-custom-critical-hit",
		pool: "holdout",
		input: { level: "ask-critical", tool: "write", critical: ["write"] },
		expected: "ask",
	},
	{
		id: "approval-critical-custom-critical-miss",
		pool: "holdout",
		input: { level: "ask-critical", tool: "bash", critical: ["write"] },
		expected: "allow",
	},
	{
		id: "approval-all-ask-user-allow",
		pool: "holdout",
		// ask_user 不在两个清单：它本来就必然等一个人答复，套审批是套娃
		input: { level: "ask-all", tool: "ask_user" },
		expected: "allow",
	},
	{
		id: "approval-critical-routine-manage-ask",
		pool: "holdout",
		input: { level: "ask-critical", tool: "routine_manage" },
		expected: "ask",
	},
];

function runApprovalCase(input: ApprovalEvalInput): string {
	const critical = input.critical ? new Set(input.critical) : undefined;
	const verdict: ApprovalVerdict = needsApproval(
		{ approvalLevel: input.level },
		input.tool,
		input.blockReason,
		critical,
	);
	return verdict.kind;
}

export interface UnattendedEvalInput {
	tool: string;
}

const UNATTENDED_CASES: EvalCase<UnattendedEvalInput>[] = [
	// tune：三态主干
	{ id: "unattended-read-allow", pool: "tune", input: { tool: "read" }, expected: "allow" },
	{ id: "unattended-remember-allow", pool: "tune", input: { tool: "remember" }, expected: "allow" },
	{ id: "unattended-write-skip", pool: "tune", input: { tool: "write" }, expected: "skip" },
	{ id: "unattended-bash-skip", pool: "tune", input: { tool: "bash" }, expected: "skip" },
	{
		id: "unattended-partner-manage-deny",
		pool: "tune",
		input: { tool: "partner_manage" },
		expected: "deny",
	},
	{
		id: "unattended-send-to-agent-deny",
		pool: "tune",
		input: { tool: "send_to_agent" },
		expected: "deny",
	},

	// holdout：边界（发布前跑，平时不改）
	{
		id: "unattended-ask-user-skip",
		pool: "holdout",
		input: { tool: "ask_user" },
		expected: "skip",
	},
	{
		id: "unattended-delete-prefix-deny",
		pool: "holdout",
		input: { tool: "delete_everything" },
		expected: "deny",
	},
	{
		id: "unattended-unknown-skip",
		pool: "holdout",
		input: { tool: "totally_new_tool" },
		expected: "skip",
	},
	{ id: "unattended-skill-allow", pool: "holdout", input: { tool: "skill" }, expected: "allow" },
	{
		id: "unattended-routine-manage-deny",
		pool: "holdout",
		input: { tool: "routine_manage" },
		expected: "deny",
	},
	{
		id: "unattended-persona-recall-skip",
		pool: "holdout",
		input: { tool: "persona_recall" },
		expected: "skip",
	},
];

function runUnattendedCase(input: UnattendedEvalInput): string {
	const verdict: UnattendedVerdict = resolveUnattendedVerdict(input.tool);
	return verdict;
}

export interface DelegateRoutingEvalInput {
	caller: DelegateCaller;
	requestedDomain: string;
	/** 直派总闸环境；缺省 `{}` = 总闸开（测试里不读开发机 env） */
	env?: NodeJS.ProcessEnv;
}

export { APPROVAL_CASES, UNATTENDED_CASES, runApprovalCase, runUnattendedCase };
