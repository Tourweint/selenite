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

import {
	needsApproval,
	type ApprovalLevel,
	type ApprovalVerdict,
} from "./approval-policy.ts";
import { resolveUnattendedVerdict, type UnattendedVerdict } from "./unattended.ts";
import { resolveDelegateRouting, type DelegateCaller } from "./delegate-routing.ts";
import { autonomyEscalationBlockReason } from "./autonomy-risk.ts";
import { delegationRunSource } from "./run-source.ts";

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

// ── needsApproval ────────────────────────────────────────

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

// ── resolveUnattendedVerdict ─────────────────────────────

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

// ── resolveDelegateRouting ───────────────────────────────

export interface DelegateRoutingEvalInput {
	caller: DelegateCaller;
	requestedDomain: string;
	/** 直派总闸环境；缺省 `{}` = 总闸开（测试里不读开发机 env） */
	env?: NodeJS.ProcessEnv;
}

/**
 * 投影口径：`direct:<domain>` / `managed:identity=<identityDomain>` / `managed:bare` / `rejected`。
 * managed 一档把 identityDomain 也钉进来——"直派不注入身份、分管才注入"正是这次改动的核心语义。
 */
const DELEGATE_ROUTING_CASES: EvalCase<DelegateRoutingEvalInput>[] = [
	// tune：四象限主干
	{
		id: "routing-chief-managed",
		pool: "tune",
		input: { caller: { partnerId: "chief", domain: null }, requestedDomain: "frontend" },
		expected: "managed:identity=frontend",
	},
	{
		id: "routing-owner-empty-domain-bare",
		pool: "tune",
		input: { caller: { partnerId: null, domain: null }, requestedDomain: "" },
		expected: "managed:bare",
	},
	{
		id: "routing-minister-own-domain-direct",
		pool: "tune",
		input: { caller: { partnerId: "p-1", domain: "frontend" }, requestedDomain: "frontend" },
		expected: "direct:frontend",
	},
	{
		id: "routing-minister-empty-request-direct-own",
		pool: "tune",
		// 没填 domain = 在自己领域里干活，直派自己，不退化成"再叫一遍自己"
		input: { caller: { partnerId: "p-1", domain: "frontend" }, requestedDomain: "" },
		expected: "direct:frontend",
	},
	{
		id: "routing-minister-cross-domain-rejected",
		pool: "tune",
		input: { caller: { partnerId: "p-1", domain: "frontend" }, requestedDomain: "backend" },
		expected: "rejected",
	},
	{
		id: "routing-minister-without-domain-managed",
		pool: "tune",
		// 普通执事（没记 domain）：原样分管，不参与直派
		input: { caller: { partnerId: "p-2", domain: null }, requestedDomain: "frontend" },
		expected: "managed:identity=frontend",
	},

	// holdout：回滚与边界（发布前跑，平时不改）
	{
		id: "routing-rollback-false-managed",
		pool: "holdout",
		input: {
			caller: { partnerId: "p-1", domain: "frontend" },
			requestedDomain: "frontend",
			env: { MINISTER_DIRECT_DISPATCH: "false" },
		},
		expected: "managed:identity=frontend",
	},
	{
		id: "routing-rollback-0-swallows-rejection",
		pool: "holdout",
		// 回滚路径连跨域拒绝一起吞掉：旧行为里本来就没有"拒绝"这一路
		input: {
			caller: { partnerId: "p-1", domain: "frontend" },
			requestedDomain: "coding",
			env: { MINISTER_DIRECT_DISPATCH: "0" },
		},
		expected: "managed:identity=coding",
	},
	{
		id: "routing-request-whitespace-trimmed",
		pool: "holdout",
		input: { caller: { partnerId: "p-1", domain: "frontend" }, requestedDomain: " frontend " },
		expected: "direct:frontend",
	},
	{
		id: "routing-domain-case-sensitive-rejected",
		pool: "holdout",
		// 领域匹配是精确比较（domain 约定小写 ASCII），不折大小写
		input: { caller: { partnerId: "p-1", domain: "frontend" }, requestedDomain: "Frontend" },
		expected: "rejected",
	},
	{
		id: "routing-blank-own-domain-as-non-minister",
		pool: "holdout",
		// own trim 后为空 = 当普通会话走分管，不能拿着空白领域去比对
		input: { caller: { partnerId: "p-3", domain: "  " }, requestedDomain: "frontend" },
		expected: "managed:identity=frontend",
	},
	{
		id: "routing-rollback-env-parsing",
		pool: "holdout",
		// 总闸读法与 directDispatchEnabled 同口径：trim + 小写后才是 false
		input: {
			caller: { partnerId: "p-1", domain: "frontend" },
			requestedDomain: "frontend",
			env: { MINISTER_DIRECT_DISPATCH: " FALSE " },
		},
		expected: "managed:identity=frontend",
	},
];

function runDelegateRoutingCase(input: DelegateRoutingEvalInput): string {
	const routing = resolveDelegateRouting(input.caller, input.requestedDomain, input.env ?? {});
	if (routing.kind === "rejected") return "rejected";
	if (routing.kind === "direct") return `direct:${routing.domain}`;
	return routing.identityDomain ? `managed:identity=${routing.identityDomain}` : "managed:bare";
}

// ── autonomyEscalationBlockReason ────────────────────────

export interface EscalationEvalInput {
	tool: string;
	args?: unknown;
	autonomous: boolean;
	/** 回滚开关；缺省 true = 开（测试里不读开发机 env） */
	enabled?: boolean;
}

const ESCALATION_CASES: EvalCase<EscalationEvalInput>[] = [
	// tune：主干——非自主轮不看表；扩权表整条拒；delegate 带 project 放行
	{
		id: "escalation-read-allow",
		pool: "tune",
		input: { tool: "read", autonomous: true },
		expected: "allow",
	},
	{
		id: "escalation-routine-manage-block",
		pool: "tune",
		input: { tool: "routine_manage", args: {}, autonomous: true },
		expected: "block",
	},
	{
		id: "escalation-send-to-agent-block",
		pool: "tune",
		input: { tool: "send_to_agent", args: {}, autonomous: true },
		expected: "block",
	},
	{
		id: "escalation-delegate-with-project-allow",
		pool: "tune",
		// 派活是本分：带 project 的本机新派放行
		input: { tool: "delegate", args: { requirement: "x", project: "proj-1" }, autonomous: true },
		expected: "allow",
	},
	{
		id: "escalation-delegate-no-project-block",
		pool: "tune",
		input: { tool: "delegate", args: { requirement: "x" }, autonomous: true },
		expected: "block",
	},
	{
		id: "escalation-normal-turn-allow",
		pool: "tune",
		// 非自主轮完全不看这张表，行为逐字节不变
		input: { tool: "routine_manage", args: {}, autonomous: false },
		expected: "allow",
	},

	// holdout：边界与回滚（发布前跑，平时不改）
	{
		id: "escalation-delegate-target-device-block",
		pool: "holdout",
		input: {
			tool: "delegate",
			args: { requirement: "x", project: "p", targetDevice: "device-b" },
			autonomous: true,
		},
		expected: "block",
	},
	{
		id: "escalation-delegate-resume-allow",
		pool: "holdout",
		// 续跑沿用原单项目，可以不带 project
		input: { tool: "delegate", args: { requirement: "x", resume: true }, autonomous: true },
		expected: "allow",
	},
	{
		id: "escalation-delegate-resume-device-block",
		pool: "holdout",
		// 设备检查先于续跑豁免：遥控别的设备不因 resume 放行
		input: { tool: "delegate", args: { resume: true, targetDevice: "pad" }, autonomous: true },
		expected: "block",
	},
	{
		id: "escalation-delegate-blank-project-block",
		pool: "holdout",
		// project trim 后为空 = 算没带
		input: { tool: "delegate", args: { project: "   " }, autonomous: true },
		expected: "block",
	},
	{
		id: "escalation-delegate-args-undefined-block",
		pool: "holdout",
		// args 缺省按空对象处理，新派照样要求 project
		input: { tool: "delegate", autonomous: true },
		expected: "block",
	},
	{
		id: "escalation-rollback-disabled-allow",
		pool: "holdout",
		// AUTONOMY_NO_ESCALATION=false 回滚到本批前行为
		input: { tool: "routine_manage", args: {}, autonomous: true, enabled: false },
		expected: "allow",
	},
];

function runEscalationCase(input: EscalationEvalInput): string {
	const reason = autonomyEscalationBlockReason(
		input.tool,
		input.args,
		input.autonomous,
		input.enabled ?? true,
	);
	return reason === undefined ? "allow" : "block";
}

// ── delegationRunSource ──────────────────────────────────

export interface RunSourceEvalInput {
	device?: boolean;
	routineTurn?: boolean;
	/** 必填：不传就会读开发机 env（测试进程里 NODE_TEST_CONTEXT 恒命中，全表会变成 test） */
	env: NodeJS.ProcessEnv;
}

const RUN_SOURCE_CASES: EvalCase<RunSourceEvalInput>[] = [
	// tune：优先级链主干（测试 > 设备 > 例行轮 > 人）
	{ id: "runsource-human-default", pool: "tune", input: { env: {} }, expected: "human" },
	{
		id: "runsource-routine-turn",
		pool: "tune",
		input: { routineTurn: true, env: {} },
		expected: "routine",
	},
	{
		id: "runsource-device",
		pool: "tune",
		input: { device: true, env: {} },
		expected: "device",
	},
	{
		id: "runsource-device-beats-routine",
		pool: "tune",
		// 跨机派发是结构性事实，比"哪个会话发起"更强
		input: { device: true, routineTurn: true, env: {} },
		expected: "device",
	},
	{
		id: "runsource-test-vitest",
		pool: "tune",
		input: { env: { VITEST: "1" } },
		expected: "test",
	},
	{
		id: "runsource-test-beats-device-and-routine",
		pool: "tune",
		input: { device: true, routineTurn: true, env: { VITEST: "1" } },
		expected: "test",
	},

	// holdout：测试标记的识别口径与显式 false（发布前跑，平时不改）
	{
		id: "runsource-test-node-test-context",
		pool: "holdout",
		input: { env: { NODE_TEST_CONTEXT: "child-v8" } },
		expected: "test",
	},
	{
		id: "runsource-test-node-env",
		pool: "holdout",
		input: { env: { NODE_ENV: "test" } },
		expected: "test",
	},
	{
		id: "runsource-node-env-trimmed-case",
		pool: "holdout",
		// NODE_ENV 判定 trim + 小写
		input: { env: { NODE_ENV: " TEST " } },
		expected: "test",
	},
	{
		id: "runsource-node-env-production",
		pool: "holdout",
		input: { env: { NODE_ENV: "production" } },
		expected: "human",
	},
	{
		id: "runsource-node-env-testing-not-test",
		pool: "holdout",
		// 前缀不算：testing !== test
		input: { env: { NODE_ENV: "testing" } },
		expected: "human",
	},
	{
		id: "runsource-explicit-false-fallthrough",
		pool: "holdout",
		// 显式 false 与缺省同路：都落到人
		input: { device: false, routineTurn: false, env: {} },
		expected: "human",
	},
];

function runRunSourceCase(input: RunSourceEvalInput): string {
	return delegationRunSource({
		device: input.device,
		routineTurn: input.routineTurn,
		env: input.env,
	});
}

// ── 运行器 ───────────────────────────────────────────────

function runCases<I>(
	cases: EvalCase<I>[],
	pool: EvalPoolName | undefined,
	run: (input: I) => string,
): EvalOutcome[] {
	return cases
		.filter((item) => pool === undefined || item.pool === pool)
		.map((item) => {
			const actual = run(item.input);
			return { ...item, actual, ok: actual === item.expected };
		});
}

/** 跑审批判定池；不传 `pool` = 两池都跑（本批单测用法）。 */
export function runApprovalPool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(APPROVAL_CASES, pool, runApprovalCase);
}

/** 跑无人值守三态池；不传 `pool` = 两池都跑。 */
export function runUnattendedPool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(UNATTENDED_CASES, pool, runUnattendedCase);
}

/** 跑执事直派四象限池；不传 `pool` = 两池都跑。 */
export function runDelegateRoutingPool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(DELEGATE_ROUTING_CASES, pool, runDelegateRoutingCase);
}

/** 跑自主轮结构性拒绝池；不传 `pool` = 两池都跑。 */
export function runAutonomyEscalationPool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(ESCALATION_CASES, pool, runEscalationCase);
}

/** 跑派单来源优先级池；不传 `pool` = 两池都跑。 */
export function runRunSourcePool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(RUN_SOURCE_CASES, pool, runRunSourceCase);
}

/** 案例表只读投影（单测检查条数 / 池划分用）。 */
export function evalCases(): {
	approval: readonly EvalCase<ApprovalEvalInput>[];
	unattended: readonly EvalCase<UnattendedEvalInput>[];
	delegateRouting: readonly EvalCase<DelegateRoutingEvalInput>[];
	escalation: readonly EvalCase<EscalationEvalInput>[];
	runSource: readonly EvalCase<RunSourceEvalInput>[];
} {
	return {
		approval: APPROVAL_CASES,
		unattended: UNATTENDED_CASES,
		delegateRouting: DELEGATE_ROUTING_CASES,
		escalation: ESCALATION_CASES,
		runSource: RUN_SOURCE_CASES,
	};
}
