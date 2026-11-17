import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMessageClock } from "../web/msg-clock.js";

/**
 * 消息时刻的显示口径（2026-11-17，对齐 ZCode）。DOM 挂载在浏览器里，
 * 这里守住最容易回退的四件事：今天只写时分、昨天带"昨天"、同年省年份、跨年才带年份。
 */

const at = new Date(2026, 10, 17, 14, 3).getTime(); // 2026-11-17 14:03 本地

test("今天只写 HH:mm", () => {
	assert.equal(formatMessageClock(at, new Date(2026, 10, 17, 20, 0).getTime()), "14:03");
});

test("昨天带「昨天」，跨月也成立", () => {
	assert.equal(formatMessageClock(at, new Date(2026, 10, 18, 9, 0).getTime()), "昨天 14:03");
	const monthEdge = new Date(2026, 10, 1, 8, 0).getTime(); // 11 月 1 日早上
	assert.equal(
		formatMessageClock(new Date(2026, 9, 31, 14, 3).getTime(), monthEdge),
		"昨天 14:03",
	);
});

test("同年更早只写月日不写年份", () => {
	assert.equal(
		formatMessageClock(new Date(2026, 10, 15, 14, 3).getTime(), new Date(2026, 10, 17, 9).getTime()),
		"11月15日 14:03",
	);
});

test("跨年才带年份", () => {
	assert.equal(
		formatMessageClock(new Date(2025, 10, 16, 14, 3).getTime(), new Date(2026, 10, 17, 9).getTime()),
		"2025年11月16日 14:03",
	);
});

test("无效时间返回空串，不写 0 点", () => {
	assert.equal(formatMessageClock(0), "");
	assert.equal(formatMessageClock("not-a-time"), "");
	assert.equal(formatMessageClock(undefined), "");
});
