import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import {
	aggregateUsageWindow,
	localDayKey,
	startOfUsageWindow,
	usageSampleOf,
	type UsageSample,
} from "./usage-range.ts";

/**
 * 纯函数测试：不启动 durable，只验证"时间窗口怎么切、样本怎么并"。
 * 真实扫描（`usageInWindow`）靠 HTTP 探针看真库输出，不在单测里起 SQLite。
 */

function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
	return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function sample(model: string, when: number, total: number): UsageSample {
	return {
		model,
		at: when,
		usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

test("startOfUsageWindow：近 7 天 = 今天与之前 6 个自然日，从第 1 天 00:00 起", () => {
	const now = at(2026, 11, 15, 18, 30);
	assert.equal(startOfUsageWindow(7, now), at(2026, 11, 9, 0, 0));
	assert.equal(startOfUsageWindow(30, now), at(2026, 10, 17, 0, 0));
});

test("startOfUsageWindow：常量当天也落在今天 00:00（不会按小时滑窗）", () => {
	const morning = at(2026, 11, 15, 8, 0);
	const night = at(2026, 11, 15, 23, 59);
	assert.equal(startOfUsageWindow(7, morning), startOfUsageWindow(7, night));
});

test("aggregateUsageWindow：只收窗口内、按模型合并、数活跃日", () => {
	const since = at(2026, 11, 9, 0, 0);
	const samples = [
		sample("magpie/deepseek-v4.1-flash", at(2026, 11, 9, 0, 0), 100), // 边界含
		sample("magpie/deepseek-v4.1-flash", at(2026, 11, 10, 21, 0), 200), // 同模型跨天
		sample("openai/gpt-5", at(2026, 11, 12, 9, 0), 300),
		sample("magpie/deepseek-v4.1-flash", at(2026, 11, 8, 23, 59), 999), // 窗口外
	];
	const result = aggregateUsageWindow(samples, since);
	assert.equal(result.activeDays, 3);
	assert.equal(result.models.length, 2);
	assert.deepEqual(
		{ model: result.models[0].model, total: result.models[0].total },
		{ model: "magpie/deepseek-v4.1-flash", total: 300 },
	);
	assert.deepEqual(
		{ model: result.models[1].model, total: result.models[1].total },
		{ model: "openai/gpt-5", total: 300 },
	);
});

test("aggregateUsageWindow：累计为 0 的模型（播报类）不进区间表", () => {
	const since = at(2026, 11, 9, 0, 0);
	const result = aggregateUsageWindow(
		[sample("lifediary/lifediary.say", at(2026, 11, 10, 10, 0), 0)],
		since,
	);
	assert.deepEqual(result, { models: [], activeDays: 0 });
});

test("usageSampleOf：assistant 的 timestamp + usage 才成样本", () => {
	const entry = {
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: "hi",
				provider: "magpie",
				model: "deepseek-v4.1-flash#think-off",
				timestamp: at(2026, 11, 10, 10, 0),
				usage: {
					input: 10,
					output: 20,
					cacheRead: 5,
					cacheWrite: 1,
					totalTokens: 36,
				},
			},
		],
	} as unknown as EntryRecord;
	const sample = usageSampleOf(entry);
	assert.ok(sample);
	assert.equal(sample.model, "magpie/deepseek-v4.1-flash#think-off");
	assert.equal(sample.usage.total, 36);

	assert.equal(
		usageSampleOf({ kind: "pi.user", model: [{ role: "user", content: "x" }] } as unknown as EntryRecord),
		null,
	);
	assert.equal(
		usageSampleOf({
			kind: "pi.assistant",
			model: [{ role: "assistant", content: "x", provider: "m", model: "m", usage: {} }],
		} as unknown as EntryRecord),
		null,
	);
});

test("localDayKey：按本地日历日归组，不按 UTC", () => {
	assert.equal(localDayKey(at(2026, 11, 9, 0, 30)), "2026-11-09");
	assert.equal(localDayKey(at(2026, 11, 9, 23, 30)), "2026-11-09");
	assert.equal(localDayKey(at(2026, 11, 10, 0, 1)), "2026-11-10");
});
