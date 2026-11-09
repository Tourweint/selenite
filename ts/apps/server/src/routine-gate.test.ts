import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConditionAnswer } from "./routine-gate.ts";

/**
 * 前置条件判定的解析口径（2026-11-10 批 21 §三.2）。
 *
 * 只钉纯解析：**失败即不成立**（null 由调用方当"不成立"处理）。
 * 真模型调用不进单测（那要 key / 钱），端到端由探针覆盖。
 */

test("条件回答：只认明确的 YES / NO（中英都行）", () => {
	for (const yes of ["YES", "yes", "Yes.", " yes ", "是", "是的", "成立", "true", "1"]) {
		assert.equal(parseConditionAnswer(yes), true, yes);
	}
	for (const no of ["NO", "no", "No。", " 否 ", "不成立", "false", "0"]) {
		assert.equal(parseConditionAnswer(no), false, no);
	}
});

test("条件回答：解释性文本 / 空串 / 含糊说法 → null（不成立）", () => {
	for (const raw of ["", "   ", "条件已经满足了，所以做吧", "maybe", "不知道", "大概吧"]) {
		assert.equal(parseConditionAnswer(raw), null, raw);
	}
});
