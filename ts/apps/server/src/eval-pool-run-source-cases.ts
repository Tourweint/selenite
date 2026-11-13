/**
 * eval-pool-run-source-cases
 *
 * 2026-11-14 从 eval-pool.ts 的 L448–L588 整段切出；正文原文搬运，未改一行实现。
 * 内含：RUN_SOURCE_CASES / runRunSourceCase / runCases / runApprovalPool …
 */

import { delegationRunSource } from "./run-source.ts";
import { APPROVAL_CASES, UNATTENDED_CASES, runApprovalCase, runUnattendedCase } from "./eval-pool-approval-cases.ts";
import type { ApprovalEvalInput, DelegateRoutingEvalInput, EvalCase, EvalOutcome, EvalPoolName, UnattendedEvalInput } from "./eval-pool-approval-cases.ts";
import { DELEGATE_ROUTING_CASES, ESCALATION_CASES, runDelegateRoutingCase, runEscalationCase } from "./eval-pool-delegate-routing-cases.ts";
import type { EscalationEvalInput, RunSourceEvalInput } from "./eval-pool-delegate-routing-cases.ts";

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

export function runApprovalPool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(APPROVAL_CASES, pool, runApprovalCase);
}

export function runUnattendedPool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(UNATTENDED_CASES, pool, runUnattendedCase);
}

export function runDelegateRoutingPool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(DELEGATE_ROUTING_CASES, pool, runDelegateRoutingCase);
}

export function runAutonomyEscalationPool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(ESCALATION_CASES, pool, runEscalationCase);
}

export function runRunSourcePool(pool?: EvalPoolName): EvalOutcome[] {
	return runCases(RUN_SOURCE_CASES, pool, runRunSourceCase);
}

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

export { RUN_SOURCE_CASES, runCases, runRunSourceCase };
