/**
 * eval-pool-delegate-routing-cases
 *
 * 2026-11-14 从 eval-pool.ts 的 L227–L446 整段切出；正文原文搬运，未改一行实现。
 * 内含：DELEGATE_ROUTING_CASES / runDelegateRoutingCase / EscalationEvalInput / ESCALATION_CASES …
 */

import { autonomyEscalationBlockReason } from "./autonomy-risk.ts";
import { resolveDelegateRouting } from "./delegate-routing.ts";
import type { DelegateRoutingEvalInput, EvalCase } from "./eval-pool-approval-cases.ts";

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

export interface RunSourceEvalInput {
	device?: boolean;
	routineTurn?: boolean;
	/** 必填：不传就会读开发机 env（测试进程里 NODE_TEST_CONTEXT 恒命中，全表会变成 test） */
	env: NodeJS.ProcessEnv;
}

export { DELEGATE_ROUTING_CASES, ESCALATION_CASES, runDelegateRoutingCase, runEscalationCase };
