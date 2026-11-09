import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
	FAILURE_STREAK_THRESHOLD,
	FailureStreak,
	failureStreak,
	takeoverHintEnabled,
	type FailureCategory,
} from "./failure-streak.ts";

/**
 * 同类失败连击（2026-11-10 批 12 §一.4）：三次触发一次建议接管 / 成功清零 /
 * 类别互不干扰 / 开关旁路 / 快照可往返。
 */

function failTimes(streak: FailureStreak, n: number, category: FailureCategory = "needs_you") {
	return Array.from({ length: n }, () => streak.recordFailure("partner-a", category));
}

test("连击：第 3 次触发接管、之后不再重复触发", () => {
	const streak = new FailureStreak();
	const first = failTimes(streak, 2);
	assert.deepEqual(first.map((x) => x.suggestTakeover), [false, false]);
	const third = streak.recordFailure("partner-a", "needs_you");
	assert.equal(third.count, FAILURE_STREAK_THRESHOLD);
	assert.equal(third.suggestTakeover, true);
	// 第 4 次继续计数，但一次连击只建议一次
	const fourth = streak.recordFailure("partner-a", "needs_you");
	assert.equal(fourth.count, 4);
	assert.equal(fourth.suggestTakeover, false);
});

test("成功一次即清零：中间成功过就不触发，清零后重新数三次", () => {
	const streak = new FailureStreak();
	streak.recordFailure("partner-a", "needs_you");
	streak.recordFailure("partner-a", "needs_you");
	streak.recordSuccess("partner-a");
	assert.equal(streak.countOf("partner-a", "needs_you"), 0, "成功清零");
	assert.equal(streak.recordFailure("partner-a", "needs_you").suggestTakeover, false);
	assert.equal(streak.recordFailure("partner-a", "needs_you").suggestTakeover, false);
	assert.equal(
		streak.recordFailure("partner-a", "needs_you").suggestTakeover,
		true,
		"清零后重新连到三次再触发",
	);
});

test("类别互不干扰：needs_you 两次 + unresolved 一次不触发", () => {
	const streak = new FailureStreak();
	streak.recordFailure("partner-a", "needs_you");
	streak.recordFailure("partner-a", "needs_you");
	assert.equal(streak.recordFailure("partner-a", "unresolved").suggestTakeover, false);
	assert.equal(streak.countOf("partner-a", "needs_you"), 2);
	assert.equal(streak.countOf("partner-a", "unresolved"), 1);
	// 来源也互不干扰
	assert.equal(streak.recordFailure("partner-b", "needs_you").suggestTakeover, false);
});

test("开关：缺省开；false / 0 / off 关；true / 1 开", () => {
	const previous = process.env.AGENT_TAKEOVER_HINT;
	try {
		delete process.env.AGENT_TAKEOVER_HINT;
		assert.equal(takeoverHintEnabled(), true);
		for (const value of ["false", "FALSE", "0", "off"]) {
			process.env.AGENT_TAKEOVER_HINT = value;
			assert.equal(takeoverHintEnabled(), false, value);
		}
		for (const value of ["true", "1", "on", ""]) {
			process.env.AGENT_TAKEOVER_HINT = value;
			assert.equal(takeoverHintEnabled(), true, value);
		}
	} finally {
		if (previous === undefined) delete process.env.AGENT_TAKEOVER_HINT;
		else process.env.AGENT_TAKEOVER_HINT = previous;
	}
});

test("可序列化：快照往返后连击与已提示位都还在；坏行丢弃", () => {
	const streak = new FailureStreak();
	streak.recordFailure("partner-a", "timeout");
	streak.recordFailure("partner-a", "timeout");
	streak.recordFailure("partner-a", "timeout");

	const snapshot = streak.serialize();
	const restored = FailureStreak.restore(snapshot);
	assert.equal(restored.countOf("partner-a", "timeout"), 3);
	assert.equal(
		restored.recordFailure("partner-a", "timeout").suggestTakeover,
		false,
		"已提示过的连击不重复触发",
	);

	const dirty = FailureStreak.restore({ counts: { "partner-a\u0000bogus": 9, bad: 2 }, hinted: [] });
	assert.equal(dirty.serialize().counts["bad"] ?? 0, 0, "坏键丢弃");
	assert.equal(dirty.serialize().counts["partner-a\u0000bogus"] ?? 0, 0, "坏类别丢弃");
});

test("进程内单例可读：failureStreak() 返回同一份状态", () => {
	assert.equal(failureStreak(), failureStreak());
});

/**
 * 接线守卫（2026-11-10 补全批 12 遗留）：模块再好，没人调用等于没做。
 * 断言 lifecycle.ts 真的把 tool-error / timeout / rejected 三类接上了——
 * 以后谁把这行删了，这里会红。
 */
test("接线：lifecycle 里 tool-error / timeout / rejected 都真的在记账", () => {
  const source = readFileSync(new URL("./agent/lifecycle.ts", import.meta.url), "utf8");
  assert.ok(source.includes("tool-error"), "afterTool 应记录 tool-error");
  assert.ok(source.includes("isTimeout ? \"timeout\" : \"tool-error\""), "afterTool 应按 isError 分流");
  assert.ok(source.includes("status === \"rejected\" ? \"rejected\" : \"timeout\""), "审批拒绝应记 rejected");
  assert.ok(source.includes("failureStreak().recordSuccess(streakSource)"), "工具跑通应清零");
});
