import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ROUTINE_DONE_MARKER,
	buildRoutinePrompt,
	effectiveMaxRuns,
	emptyRoutineWatchFile,
	evaluateTriggerGate,
	extractRoutineDone,
	planRoutineWatch,
	releaseRoutineWatch,
	routineConditionNotes,
	routineConditionalEnabled,
	routineRunVerdict,
	routineTriggerGatesEnabled,
	shouldAdvanceCursor,
	triggerEndedAt,
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

// ── 批 15 §一：事件触发器三件门 ───────────────────────────

test("触发器门开关：默认开；false/0/off 才关", () => {
	assert.equal(routineTriggerGatesEnabled({}), true);
	assert.equal(routineTriggerGatesEnabled({ ROUTINE_TRIGGER_GATES: "" }), true);
	assert.equal(routineTriggerGatesEnabled({ ROUTINE_TRIGGER_GATES: "false" }), false);
	assert.equal(routineTriggerGatesEnabled({ ROUTINE_TRIGGER_GATES: "0" }), false);
	assert.equal(routineTriggerGatesEnabled({ ROUTINE_TRIGGER_GATES: "off" }), false);
});

test("门：开关关着 = 只看 match，状态原样（回滚口径）", () => {
	const state = { cooldownUntil: 9_999, lastMatch: true, lastValue: 1 };
	const out = evaluateTriggerGate({
		spec: { cooldownSec: 60, edge: true, baseline: { key: "n", delta: 5 } },
		state,
		now: 1_000,
		matched: true,
		observed: 100,
		enabled: false,
	});
	assert.equal(out.fire, true);
	assert.equal(out.state, state, "关着时状态对象原样返回");
});

test("cooldown：触发后 N 秒内不再触发，过点恢复", () => {
	const first = evaluateTriggerGate({
		spec: { cooldownSec: 60 },
		now: 1_000,
		matched: true,
		enabled: true,
	});
	assert.equal(first.fire, true);
	assert.equal(first.state.cooldownUntil, 61_000);

	const blocked = evaluateTriggerGate({
		spec: { cooldownSec: 60 },
		state: first.state,
		now: 30_000,
		matched: true,
		enabled: true,
	});
	assert.equal(blocked.fire, false);
	assert.equal(blocked.state, first.state, "冷却期内状态不动");

	const later = evaluateTriggerGate({
		spec: { cooldownSec: 60 },
		state: first.state,
		now: 61_001,
		matched: true,
		enabled: true,
	});
	assert.equal(later.fire, true);
});

test("edge：只在假 → 真那一下触发；持续为真只算一次", () => {
	const first = evaluateTriggerGate({
		spec: { edge: true },
		now: 1,
		matched: true,
		enabled: true,
	});
	assert.equal(first.fire, true);

	const again = evaluateTriggerGate({
		spec: { edge: true },
		state: first.state,
		now: 2,
		matched: true,
		enabled: true,
	});
	assert.equal(again.fire, false, "一直为真不再触发");

	const falseRound = evaluateTriggerGate({
		spec: { edge: true },
		state: again.state,
		now: 3,
		matched: false,
		enabled: true,
	});
	assert.equal(falseRound.fire, false);
	assert.equal(falseRound.state.lastMatch, false);

	const redge = evaluateTriggerGate({
		spec: { edge: true },
		state: falseRound.state,
		now: 4,
		matched: true,
		enabled: true,
	});
	assert.equal(redge.fire, true, "再变真时重新触发");
});

test("baseline：首次记基线，之后变化超过 delta 才触发（相等不算）", () => {
	const first = evaluateTriggerGate({
		spec: { baseline: { key: "pending", delta: 5 } },
		now: 1,
		matched: true,
		observed: 10,
		enabled: true,
	});
	assert.equal(first.fire, true);
	assert.equal(first.state.lastValue, 10);

	const small = evaluateTriggerGate({
		spec: { baseline: { key: "pending", delta: 5 } },
		state: first.state,
		now: 2,
		matched: true,
		observed: 15,
		enabled: true,
	});
	assert.equal(small.fire, false, "变化正好 5 = 没超过 delta");

	const big = evaluateTriggerGate({
		spec: { baseline: { key: "pending", delta: 5 } },
		state: small.state,
		now: 3,
		matched: true,
		observed: 16,
		enabled: true,
	});
	assert.equal(big.fire, true);
	assert.equal(big.state.lastValue, 16);
});

test("baseline：观测值不是数字 → 不触发（不拿脏值硬比）", () => {
	const out = evaluateTriggerGate({
		spec: { baseline: { key: "pending", delta: 0 } },
		now: 1,
		matched: true,
		observed: Number.NaN,
		enabled: true,
	});
	assert.equal(out.fire, false);
});

test("组合顺序：cooldown 先短路，不消耗 edge 的记忆", () => {
	const armed = evaluateTriggerGate({
		spec: { cooldownSec: 60, edge: true },
		now: 1_000,
		matched: true,
		enabled: true,
	});
	assert.equal(armed.fire, true);

	// 冷却期内：即便 match 从真变假再变真，也不动 lastMatch（cooldown 先返回）。
	const blocked = evaluateTriggerGate({
		spec: { cooldownSec: 60, edge: true },
		state: armed.state,
		now: 2_000,
		matched: false,
		enabled: true,
	});
	assert.equal(blocked.fire, false);
	assert.equal(blocked.state.lastMatch, true, "冷却期不更新 edge 记忆");
});

// ── 批 15 §四：看护单例交接 ──────────────────────────────

test("看护：空账 → 新规则直接接手，没有交接", () => {
	const plan = planRoutineWatch({
		file: emptyRoutineWatchFile(),
		key: "p-1",
		routineId: "r-new",
		name: "新看护",
		now: "2026-11-10T00:00:00.000Z",
		wantsWatch: true,
		enabled: true,
	});
	assert.equal(plan.takeOver, true);
	assert.equal(plan.handoffFrom, undefined);
	assert.equal(plan.file.watches["p-1"]?.routineId, "r-new");
});

test("看护：同一规则重复认领 = 不重复交接", () => {
	const first = planRoutineWatch({
		file: emptyRoutineWatchFile(),
		key: "p-1",
		routineId: "r-a",
		name: "A",
		now: "t1",
		wantsWatch: true,
		enabled: true,
	});
	const second = planRoutineWatch({
		file: first.file,
		key: "p-1",
		routineId: "r-a",
		name: "A",
		now: "t2",
		wantsWatch: true,
		enabled: true,
	});
	assert.equal(second.takeOver, true);
	assert.equal(second.handoffFrom, undefined);
	assert.equal(second.file, first.file, "同一规则不重写文件");
});

test("看护：换规则只交接一次，handedTo 记一次", () => {
	const first = planRoutineWatch({
		file: emptyRoutineWatchFile(),
		key: "p-1",
		routineId: "r-old",
		name: "旧",
		now: "t1",
		wantsWatch: true,
		enabled: true,
	});
	const handoff = planRoutineWatch({
		file: first.file,
		key: "p-1",
		routineId: "r-new",
		name: "新",
		now: "t2",
		wantsWatch: true,
		enabled: true,
	});
	assert.equal(handoff.handoffFrom, "r-old");
	assert.equal(handoff.file.handedTo["r-old"], "r-new");
	assert.equal(handoff.file.watches["p-1"]?.routineId, "r-new");

	// 同一对 old→new 再走一遍（例如文件回滚后重放）：不再交接第二次。
	const replay = planRoutineWatch({
		file: { ...handoff.file, watches: { "p-1": first.file.watches["p-1"]! } },
		key: "p-1",
		routineId: "r-new",
		name: "新",
		now: "t3",
		wantsWatch: true,
		enabled: true,
	});
	assert.equal(replay.handoffFrom, undefined, "交接只交一次");
	assert.equal(replay.file.handedTo["r-old"], "r-new");
});

test("看护：开关关着 / 不是看护型 → 不认领", () => {
	const base = {
		file: emptyRoutineWatchFile(),
		key: "p-1",
		routineId: "r-a",
		name: "A",
		now: "t",
	};
	const off = planRoutineWatch({ ...base, wantsWatch: true, enabled: false });
	assert.equal(off.takeOver, false);
	assert.equal(off.file, base.file);

	const notWatch = planRoutineWatch({ ...base, wantsWatch: false, enabled: true });
	assert.equal(notWatch.takeOver, false);
});

test("看护：规则停了就从账里摘掉（handedTo 保留）", () => {
	const plan = planRoutineWatch({
		file: { ...emptyRoutineWatchFile(), handedTo: { "r-older": "r-a" } },
		key: "p-1",
		routineId: "r-a",
		name: "A",
		now: "t",
		wantsWatch: true,
		enabled: true,
	});
	const released = releaseRoutineWatch(plan.file, "r-a");
	assert.equal(released.watches["p-1"], undefined);
	assert.equal(released.handedTo["r-older"], "r-a", "交接账保留便于追溯");
});

// ── if / ends（2026-11-10 批 21 §三）──────────────────────────

test("ends.at：到点后触发器过期；非法时间当没设（不误杀老规则）", () => {
	const at = "2026-11-10T12:00:00.000Z";
	const trigger = { ends: { at } };
	assert.equal(triggerEndedAt(trigger, Date.parse(at) - 1), false, "差 1ms 还该触发");
	assert.equal(triggerEndedAt(trigger, Date.parse(at)), true, "到点即过期");
	assert.equal(triggerEndedAt(trigger, Date.parse(at) + 1), true);
	assert.equal(triggerEndedAt({}, Date.parse(at)), false);
	assert.equal(triggerEndedAt({ ends: { at: "not-a-date" } }, Date.parse(at)), false);
});

test("ends.after 是 maxRuns 的别名：取更小的；都缺省 = 不设上限", () => {
	assert.equal(effectiveMaxRuns(undefined, [{ ends: { after: 5 } }]), 5);
	assert.equal(effectiveMaxRuns(3, [{ ends: { after: 5 } }]), 3, "maxRuns 更小");
	assert.equal(effectiveMaxRuns(8, [{ ends: { after: 5 } }, { ends: { after: 2 } }]), 2, "多个触发器取最小");
	assert.equal(effectiveMaxRuns(undefined, []), undefined);
	assert.equal(effectiveMaxRuns(0, [{ ends: { after: 0 } }]), undefined, "非正数等于没设");
});

test("if 条件去重保序：多个触发器各带 if 时全部要成立（由引擎逐条问）", () => {
	assert.deepEqual(
		routineConditionNotes([
			{ if: { note: "今天有雨吗" } },
			{ if: { note: " 今天有雨吗 " } },
			{ if: { note: "日历上有新会议吗" } },
			{},
		]),
		["今天有雨吗", "日历上有新会议吗"],
	);
	assert.deepEqual(routineConditionNotes([{}, { if: { note: "   " } }]), []);
});

// ── 游标推进时机（2026-11-10 批 21 §六）────────────────────

test("游标：只有产出被保留（非 quiet、非 skipped、成功）才推进", () => {
	const base = { ok: true, quiet: false, skippedToolCount: 0 };
	assert.equal(shouldAdvanceCursor(base), true);
	assert.equal(shouldAdvanceCursor({ ...base, quiet: true }), false, "quiet 不推进");
	assert.equal(shouldAdvanceCursor({ ...base, skippedToolCount: 1 }), false, "跳步不推进");
	assert.equal(shouldAdvanceCursor({ ...base, ok: false }), false, "失败（含读失败）不推进");
	// 2026-11-17：报错但产出为空时会被压成「非 quiet」，不能因此把这次失败记成"看过"
	assert.equal(shouldAdvanceCursor({ ...base, toolErrorCount: 1 }), false, "工具报错不推进");
	// 无报错的正常轮不受影响
	assert.equal(shouldAdvanceCursor({ ...base, toolErrorCount: 0 }), true);
});

test("提示词：[上次看到这里] 只在有游标且有条件门控时出现", () => {
	const withCursor = buildRoutinePrompt({
		prompt: "看新消息",
		cursorAt: "2026-11-10T08:00:00.000Z",
		conditional: true,
	});
	assert.match(withCursor, /\[上次看到这里\] 2026-11-10T08:00:00\.000Z/);
	assert.ok(withCursor.indexOf("[上次看到这里]") < withCursor.indexOf("看新消息"), "游标在原文之前");

	assert.equal(
		buildRoutinePrompt({ prompt: "看新消息", cursorAt: "2026-11-10T08:00:00.000Z", conditional: false }),
		"看新消息",
		"开关关着时逐字节不变",
	);
	assert.equal(buildRoutinePrompt({ prompt: "看新消息", conditional: true }), "看新消息", "没有游标不加段");
});
