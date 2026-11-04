import assert from "node:assert/strict";
import { test } from "node:test";
import { cronMatches, nextCronFire } from "./cron.ts";

test("cron：通配/字段/步进/列表", () => {
	// 星期几不写死：用被测日期自己的 getDay()（写死会在"换日期跑测试"时翻车）
	const d = new Date(2026, 10, 5, 9, 30, 0);
	const dow = d.getDay();
	const otherDow = (dow + 1) % 7;
	assert.equal(cronMatches("* * * * *", d), true);
	assert.equal(cronMatches("30 9 * * *", d), true);
	assert.equal(cronMatches("31 9 * * *", d), false);
	assert.equal(cronMatches("*/30 9 * * *", d), true);
	assert.equal(cronMatches("*/45 9 * * *", d), false, "30 不在 45 的步进点上");
	assert.equal(cronMatches("0,30,45 9 * * *", d), true);
	assert.equal(cronMatches("30 9-18 * * *", d), true);
	assert.equal(cronMatches("30 10-18 * * *", d), false);
	assert.equal(cronMatches("30 9 5 11 *", d), true);
	assert.equal(cronMatches("30 9 5 10 *", d), false);
	assert.equal(cronMatches(`30 9 * * ${dow}`, d), true, "今天自己的星期几必须命中");
	assert.equal(cronMatches(`30 9 * * ${otherDow}`, d), false, "别的星期几不该命中");
});

test("cron：非法表达式一律不匹配、不排程", () => {
	const d = new Date(2026, 10, 5, 9, 30, 0);
	assert.equal(cronMatches("30 9 * *", d), false, "4 段不算");
	assert.equal(cronMatches("abc * * * *", d), false, "非数字字段判不匹配");
	assert.equal(nextCronFire("30 9 * *", d), null, "非法表达式不排程");
});

test("cron：nextCronFire 从下一分钟起找，跨日/跨月都能找到", () => {
	// 09:30:30 起，每天 09:31 → 下一分钟就命中
	const from = new Date(2026, 10, 5, 9, 30, 30);
	const next = nextCronFire("31 9 * * *", from);
	assert.ok(next);
	assert.equal(next.getHours(), 9);
	assert.equal(next.getMinutes(), 31);
	assert.equal(next.getDate(), 5);

	// 当天 09:31 已过 → 明天
	const later = new Date(2026, 10, 5, 9, 31, 30);
	const tomorrow = nextCronFire("31 9 * * *", later);
	assert.ok(tomorrow);
	assert.equal(tomorrow.getDate(), 6);

	// 秒要清零：排出来的时刻必须是整分
	const fired = nextCronFire("* * * * *", new Date(2026, 10, 5, 9, 30, 59));
	assert.ok(fired);
	assert.equal(fired.getSeconds(), 0);
});
