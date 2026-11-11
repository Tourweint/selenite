import assert from "node:assert/strict";
import { test } from "node:test";
import {
	evalCases,
	runApprovalPool,
	runAutonomyEscalationPool,
	runDelegateRoutingPool,
	runRunSourcePool,
	runUnattendedPool,
	type EvalCase,
	type EvalPoolName,
	type EvalOutcome,
} from "./eval-pool.ts";

/**
 * 纯判定函数回归集（2026-11-10 批 20 §三；2026-11-12 扩容补三个池）。
 *
 * tune 与 holdout 都跑（任务书 §3.2），但用途不同：
 *   - tune：跟着需求改；
 *   - holdout：只在发布前跑，红了先怀疑实现，不改期望。
 */

const POOLS: EvalPoolName[] = ["tune", "holdout"];

function assertAllPass(outcomes: EvalOutcome[], label: string): void {
	const failed = outcomes.filter((outcome) => !outcome.ok);
	assert.equal(
		failed.length,
		0,
		`${label} 有 ${failed.length} 条没过：${failed
			.map((item) => `${item.id} 期望 ${item.expected} 实际 ${item.actual}`)
			.join("; ")}`,
	);
}

function assertPoolShape(cases: EvalCase<unknown>[], label: string): void {
	assert.ok(cases.length >= 10 && cases.length <= 15, `${label} 应有 10–15 条，实际 ${cases.length}`);
	const ids = new Set(cases.map((item) => item.id));
	assert.equal(ids.size, cases.length, `${label} 的 id 必须唯一`);
	for (const pool of POOLS) {
		const count = cases.filter((item) => item.pool === pool).length;
		assert.equal(count * 2, cases.length, `${label} 的 ${pool} 应占一半，实际 ${count}/${cases.length}`);
	}
}

test("审批判定：案例表 10–15 条，tune / holdout 各半", () => {
	assertPoolShape(evalCases().approval as EvalCase<unknown>[], "needsApproval");
});

test("无人值守三态：案例表 10–15 条，tune / holdout 各半", () => {
	assertPoolShape(evalCases().unattended as EvalCase<unknown>[], "resolveUnattendedVerdict");
});

test("审批判定：两个池全过", () => {
	for (const pool of POOLS) assertAllPass(runApprovalPool(pool), `needsApproval/${pool}`);
	assert.equal(runApprovalPool().length, evalCases().approval.length, "不传池 = 两池都跑");
});

test("无人值守三态：两个池全过", () => {
	for (const pool of POOLS) {
		assertAllPass(runUnattendedPool(pool), `resolveUnattendedVerdict/${pool}`);
	}
	assert.equal(runUnattendedPool().length, evalCases().unattended.length);
});

test("执事直派四象限：案例表 10–15 条，tune / holdout 各半", () => {
	assertPoolShape(evalCases().delegateRouting as EvalCase<unknown>[], "resolveDelegateRouting");
});

test("自主轮结构性拒绝：案例表 10–15 条，tune / holdout 各半", () => {
	assertPoolShape(evalCases().escalation as EvalCase<unknown>[], "autonomyEscalationBlockReason");
});

test("派单来源优先级：案例表 10–15 条，tune / holdout 各半", () => {
	assertPoolShape(evalCases().runSource as EvalCase<unknown>[], "delegationRunSource");
});

test("执事直派四象限：两个池全过", () => {
	for (const pool of POOLS) {
		assertAllPass(runDelegateRoutingPool(pool), `resolveDelegateRouting/${pool}`);
	}
	assert.equal(runDelegateRoutingPool().length, evalCases().delegateRouting.length, "不传池 = 两池都跑");
});

test("自主轮结构性拒绝：两个池全过", () => {
	for (const pool of POOLS) {
		assertAllPass(runAutonomyEscalationPool(pool), `autonomyEscalationBlockReason/${pool}`);
	}
	assert.equal(runAutonomyEscalationPool().length, evalCases().escalation.length);
});

test("派单来源优先级：两个池全过", () => {
	for (const pool of POOLS) {
		assertAllPass(runRunSourcePool(pool), `delegationRunSource/${pool}`);
	}
	assert.equal(runRunSourcePool().length, evalCases().runSource.length);
});
