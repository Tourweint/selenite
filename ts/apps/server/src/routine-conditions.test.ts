import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ROUTINE_DONE_MARKER,
	buildRoutinePrompt,
	extractRoutineDone,
	routineConditionalEnabled,
	routineRunVerdict,
} from "./routine-conditions.ts";

/**
 * 例行任务条件门控单测（2026-11-10 批 13 §四）。
 *
 * 三件事全部是纯逻辑：上次结局透出 / until 达成即停 / maxRuns 跑满即停。
 * 引擎侧的落盘与置停由 routines.ts 组合这些函数，探针覆盖真链路。
 */

test("开关：默认开；false/0/off 才关", () => {
	assert.equal(routineConditionalEnabled({}), true);
	assert.equal(routineConditionalEnabled({ ROUTINE_CONDITIONAL: "" }), true);
	assert.equal(routineConditionalEnabled({ ROUTINE_CONDITIONAL: "false" }), false);
	assert.equal(routineConditionalEnabled({ ROUTINE_CONDITIONAL: "0" }), false);
	assert.equal(routineConditionalEnabled({ ROUTINE_CONDITIONAL: "off" }), false);
	assert.equal(routineConditionalEnabled({ ROUTINE_CONDITIONAL: "true" }), true);
});

test("提示词：开关关着 = 原文逐字节不变（回滚口径）", () => {
	const prompt = "整理今天的记录。\n";
	const out = buildRoutinePrompt({
		prompt,
		lastOutcome: "success",
		untilNote: "所有记录都整理完",
		conditional: false,
	});
	assert.equal(out, prompt);
});

test("提示词：上一次的结局 + 完成条件都带给模型（顺序固定）", () => {
	const out = buildRoutinePrompt({
		prompt: "整理今天的记录",
		lastOutcome: "quiet",
		untilNote: "所有记录都整理完",
		conditional: true,
	});
	assert.match(out, /^上一次的结果是 quiet。/);
	assert.match(out, /整理今天的记录/);
	assert.match(out, /\[完成条件\] 所有记录都整理完/);
	assert.ok(out.includes(ROUTINE_DONE_MARKER), "必须告诉模型达成时怎么写标记");
	assert.ok(out.indexOf("上一次的结果") < out.indexOf("[完成条件]"), "上次结局在前");
});

test("提示词：没有历史 / 没有条件时不凭空加段", () => {
	const out = buildRoutinePrompt({ prompt: "做点事", conditional: true });
	assert.equal(out, "做点事");
});

test("完成标记：认出后从正文剔除（标记不写进摘要）", () => {
	const done = extractRoutineDone(`都办完了。\n${ROUTINE_DONE_MARKER}`);
	assert.equal(done.done, true);
	assert.equal(done.text, "都办完了。");
	assert.ok(!done.text.includes(ROUTINE_DONE_MARKER));

	const notDone = extractRoutineDone("还有两件没做");
	assert.equal(notDone.done, false);
	assert.equal(notDone.text, "还有两件没做");
});

test("结局：成功 / 安静 / 跳过 / 失败四类", () => {
	const base = {
		untilMet: false,
		conditional: true,
		completedRunsBefore: 0,
	};
	assert.deepEqual(routineRunVerdict({ ...base, ok: true, quiet: false, skippedToolCount: 0 }), {
		outcome: "success",
		stop: false,
	});
	assert.equal(
		routineRunVerdict({ ...base, ok: true, quiet: true, skippedToolCount: 0 }).outcome,
		"quiet",
	);
	assert.equal(
		routineRunVerdict({ ...base, ok: true, quiet: false, skippedToolCount: 1 }).outcome,
		"skipped",
		"跳过过步骤比安静更该被看见",
	);
	assert.deepEqual(routineRunVerdict({ ...base, ok: false, quiet: false, skippedToolCount: 0 }), {
		outcome: "failed",
		stop: false,
	});
});

test("until 达成：结局 done 且停表（不删规则）", () => {
	const verdict = routineRunVerdict({
		ok: true,
		quiet: false,
		skippedToolCount: 0,
		untilMet: true,
		conditional: true,
		completedRunsBefore: 2,
	});
	assert.deepEqual(verdict, { outcome: "done", stop: true });
});

test("until 在开关关着时被忽略", () => {
	const verdict = routineRunVerdict({
		ok: true,
		quiet: false,
		skippedToolCount: 0,
		untilMet: true,
		conditional: false,
		completedRunsBefore: 2,
	});
	assert.deepEqual(verdict, { outcome: "success", stop: false });
});

test("maxRuns：跑满 N 次自动停，最后一条记 done", () => {
	const nth = routineRunVerdict({
		ok: true,
		quiet: false,
		skippedToolCount: 0,
		untilMet: false,
		conditional: true,
		maxRuns: 3,
		completedRunsBefore: 2,
	});
	assert.deepEqual(nth, { outcome: "done", stop: true });

	const before = routineRunVerdict({
		ok: true,
		quiet: false,
		skippedToolCount: 0,
		untilMet: false,
		conditional: true,
		maxRuns: 3,
		completedRunsBefore: 1,
	});
	assert.deepEqual(before, { outcome: "success", stop: false });
});

test("maxRuns：失败也计数且会停，但结局不能写成 done", () => {
	const verdict = routineRunVerdict({
		ok: false,
		quiet: false,
		skippedToolCount: 0,
		untilMet: false,
		conditional: true,
		maxRuns: 2,
		completedRunsBefore: 1,
	});
	assert.deepEqual(verdict, { outcome: "failed", stop: true });
});

test("maxRuns：开关关着时完全忽略", () => {
	const verdict = routineRunVerdict({
		ok: true,
		quiet: false,
		skippedToolCount: 0,
		untilMet: false,
		conditional: false,
		maxRuns: 1,
		completedRunsBefore: 0,
	});
	assert.deepEqual(verdict, { outcome: "success", stop: false });
});
