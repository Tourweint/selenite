import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionSettings, compactionSummary, readCompactionConfig } from "./compaction-settings.ts";

/** 128K 主模型 + 一个思考变体 + 100K（用户举的那个例子）+ 32K 小窗口 */
const WINDOWS = new Map([
	["p/m", 131072],
	["p/m#think-off", 131072],
	["p/mid", 102400],
	["p/small", 32768],
]);

test("压缩：什么都不设 = 按百分比 70%（用户 2026-11-14 拍板）", () => {
	const config = readCompactionConfig({});
	assert.equal(config.enabled, true);
	assert.equal(config.mode, "percent");
	assert.equal(config.percent, 70);
	const settings = compactionSettings(config, WINDOWS);
	assert.equal(settings.enabled, true);
	// 131072 × 70% = 91750 → reserve = 131072 - 91750 = 39322
	assert.equal(settings.modelOverrides?.["p/m"]?.reserveTokens, 131072 - Math.round(131072 * 0.7));
	// 思考变体一并拿到（会话里存的就是它）
	assert.equal(
		settings.modelOverrides?.["p/m#think-off"]?.reserveTokens,
		131072 - Math.round(131072 * 0.7),
	);
});

test("压缩：按 token —— 窗口 100K、填 70 → 到 70K 时压一次", () => {
	const config = readCompactionConfig({
		AGENT_COMPACT_TRIGGER_MODE: "tokens",
		AGENT_COMPACT_TRIGGER_K: "70",
	});
	assert.equal(config.tokens, 70 * 1024);
	const settings = compactionSettings(config, WINDOWS);
	// 触发点 71680 → reserve = 102400 - 71680 = 30720（内核判据即"到 71680 压"）
	assert.equal(settings.modelOverrides?.["p/mid"]?.reserveTokens, 30720);
	assert.equal(102400 - 30720, 70 * 1024);
	// 128K 窗口同样在 71680 处压：reserve = 59392
	assert.equal(settings.modelOverrides?.["p/m"]?.reserveTokens, 131072 - 70 * 1024);
});

test("压缩：按 token 填得比窗口还大 → 夹到「窗口减 1K」，不会变负数", () => {
	const config = readCompactionConfig({
		AGENT_COMPACT_TRIGGER_MODE: "tokens",
		AGENT_COMPACT_TRIGGER_K: "100",
	});
	const settings = compactionSettings(config, WINDOWS);
	// 32K 窗口装不下 100K：reserve 夹到下限 1024
	assert.equal(settings.modelOverrides?.["p/small"]?.reserveTokens, 1024);
	// 100K 窗口刚好相等：reserve 也夹到 1024（不是 0）
	assert.equal(settings.modelOverrides?.["p/mid"]?.reserveTokens, 1024);
});

test("压缩：百分比越界夹回 5–95，非法整数回落 70", () => {
	assert.equal(readCompactionConfig({ AGENT_COMPACT_TRIGGER_PERCENT: "200" }).percent, 95);
	assert.equal(readCompactionConfig({ AGENT_COMPACT_TRIGGER_PERCENT: "1" }).percent, 5);
	assert.equal(readCompactionConfig({ AGENT_COMPACT_TRIGGER_PERCENT: "abc" }).percent, 70);
	assert.equal(readCompactionConfig({ AGENT_COMPACT_TRIGGER_PERCENT: "1.5" }).percent, 70);
	assert.equal(readCompactionConfig({ AGENT_COMPACT_TRIGGER_PERCENT: "" }).percent, 70);
});

test("压缩：旧的 mode=default 回落到按百分比（不把老值当开关）", () => {
	const config = readCompactionConfig({ AGENT_COMPACT_TRIGGER_MODE: "default" });
	assert.equal(config.mode, "percent");
	assert.equal(compactionSettings(config, WINDOWS).modelOverrides?.["p/mid"]?.reserveTokens, 102400 - Math.round(102400 * 0.7));
});

test("压缩：显式 false 关掉自动压缩，不发按模型覆盖", () => {
	const config = readCompactionConfig({ AGENT_COMPACT_ENABLED: "false" });
	const settings = compactionSettings(config, WINDOWS);
	assert.equal(settings.enabled, false);
	assert.equal(settings.modelOverrides, undefined);
	for (const off of ["0", "off", "FALSE"]) {
		assert.equal(readCompactionConfig({ AGENT_COMPACT_ENABLED: off }).enabled, false);
	}
});

test("压缩：按 token 但没填 K → 不落地（回落内核默认白）", () => {
	const config = readCompactionConfig({ AGENT_COMPACT_TRIGGER_MODE: "tokens" });
	assert.equal(config.tokens, undefined);
	const settings = compactionSettings(config, WINDOWS);
	assert.equal(settings.modelOverrides, undefined);
	assert.equal(compactionSummary(config, WINDOWS).trigger, "触发未设(回落内核默认)");
});

test("压缩：没有窗口表时只有全局 enabled，不编造覆盖", () => {
	const settings = compactionSettings(readCompactionConfig({}), new Map());
	assert.deepEqual(settings, { enabled: true });
});

test("压缩：K 必须是 ≥1 的整数（0 / 负数 / 小数一律当没填）", () => {
	for (const bad of ["0", "-3", "1.5", "abc"]) {
		assert.equal(
			readCompactionConfig({ AGENT_COMPACT_TRIGGER_K: bad }).tokens,
			undefined,
			`${bad} 应被拒`,
		);
	}
	assert.equal(readCompactionConfig({ AGENT_COMPACT_TRIGGER_K: "70" }).tokens, 71680);
});

test("压缩：summary 打印生效档位而不是原始 env", () => {
	assert.equal(compactionSummary(readCompactionConfig({}), WINDOWS).trigger, "窗口 70%");
	assert.equal(
		compactionSummary(
			readCompactionConfig({ AGENT_COMPACT_TRIGGER_MODE: "tokens", AGENT_COMPACT_TRIGGER_K: "70" }),
			WINDOWS,
		).trigger,
		"触发 70K",
	);
	assert.equal(
		compactionSummary(readCompactionConfig({ AGENT_COMPACT_ENABLED: "false" }), WINDOWS).trigger,
		"关闭",
	);
	// 覆盖了几个模型 = 有窗口且该档能算出来的引用数
	assert.equal(compactionSummary(readCompactionConfig({}), WINDOWS).overridden, WINDOWS.size);
});
