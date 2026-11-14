import assert from "node:assert/strict";
import test from "node:test";
import { nextDailyAt, nextReminderAt } from "./reminder.ts";

test("nextDailyAt：正常 24h 后", () => {
	const at = new Date("2026-11-12T21:30:00+08:00").getTime();
	const now = new Date("2026-11-12T21:30:05+08:00").getTime();
	assert.equal(nextDailyAt(at, now), at + 24 * 60 * 60 * 1000);
});

test("nextDailyAt：机器睡过头跨过好几天，落在未来而不是把过去再排一次", () => {
	const at = new Date("2026-11-12T21:30:00+08:00").getTime();
	const now = new Date("2026-11-15T09:00:00+08:00").getTime();
	const next = nextDailyAt(at, now);
	assert.ok(next > now, "必须落在未来");
	assert.equal(next, new Date("2026-11-15T21:30:00+08:00").getTime());
});

test("nextReminderAt：每周只落在选中的星期几", () => {
	// 2026-11-15 是周日；选周一/周五，下一次应是周一。
	const at = new Date(2026, 10, 15, 9, 0, 0, 0).getTime();
	const next = nextReminderAt(
		{ text: "x", at, repeat: "weekly", weekdays: [1, 5] },
		at + 1000,
	);
	assert.equal(next, new Date(2026, 10, 16, 9, 0, 0, 0).getTime());
});

test("nextReminderAt：每月 31 号遇到小月落到月末，下个月再回到 31", () => {
	// 2026 年 1 月 31 日 → 2 月 28 日（2026 非闰年）。
	const jan = new Date(2026, 0, 31, 9, 0, 0, 0).getTime();
	const feb = nextReminderAt(
		{ text: "x", at: jan, repeat: "monthly", dayOfMonth: 31 },
		jan + 1000,
	);
	assert.equal(feb, new Date(2026, 1, 28, 9, 0, 0, 0).getTime());
	// 2 月 28 日之后仍按锚点 31 号算 → 3 月 31 日，而不是 3 月 28 日。
	const mar = nextReminderAt(
		{ text: "x", at: feb!, repeat: "monthly", dayOfMonth: 31 },
		feb! + 1000,
	);
	assert.equal(mar, new Date(2026, 2, 31, 9, 0, 0, 0).getTime());
});

test("nextReminderAt：区间结束（until）之后不再续排", () => {
	const at = new Date(2026, 10, 15, 9, 0, 0, 0).getTime();
	const until = new Date(2026, 10, 16, 23, 59, 59, 999).getTime();
	const inRange = nextReminderAt(
		{ text: "x", at, repeat: "daily", until },
		at + 1000,
	);
	assert.equal(inRange, new Date(2026, 10, 16, 9, 0, 0, 0).getTime());
	const pastRange = nextReminderAt(
		{ text: "x", at, repeat: "daily", until },
		new Date(2026, 10, 16, 9, 0, 1).getTime(),
	);
	assert.equal(pastRange, null);
});
