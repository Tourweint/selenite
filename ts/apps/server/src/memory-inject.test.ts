/**
 * 记忆注入预算开关（2026-11-15 追加批）：解析口径与边界。
 *
 * 这两条的关键性质是"填错不会把能力弄没"：非法值回落默认、越界 clamp 到边界，
 * 而不是关掉注入；要关记忆是 MEMORY_ENABLED=false，不在这层的语义里。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MEMORY_INJECT_DEFAULTS,
	memoryInjectDedupeEnabled,
	memoryInjectLimit,
	memoryInjectMaxChars,
} from "./memory-inject.ts";

const env = (pairs: Record<string, string> = {}): NodeJS.ProcessEnv =>
	pairs as unknown as NodeJS.ProcessEnv;

test("注入预算：缺省放宽到 16 条 / 2000 字", () => {
	assert.equal(memoryInjectLimit(env()), 16);
	assert.equal(memoryInjectMaxChars(env()), 2000);
	assert.equal(MEMORY_INJECT_DEFAULTS.limit, 16);
	assert.equal(MEMORY_INJECT_DEFAULTS.maxChars, 2000);
});

test("注入预算：显式 8 / 1200 = 逐字节回到旧形态（一行回滚）", () => {
	const rollback = env({ MEMORY_INJECT_LIMIT: "8", MEMORY_INJECT_MAX_CHARS: "1200" });
	assert.equal(memoryInjectLimit(rollback), 8);
	assert.equal(memoryInjectMaxChars(rollback), 1200);
});

test("注入预算：非法值回落默认，不关能力", () => {
	for (const bad of ["abc", "NaN", "--", "1e999"]) {
		assert.equal(memoryInjectLimit(env({ MEMORY_INJECT_LIMIT: bad })), 16, `limit 非法值 ${bad}`);
		assert.equal(
			memoryInjectMaxChars(env({ MEMORY_INJECT_MAX_CHARS: bad })),
			2000,
			`maxChars 非法值 ${bad}`,
		);
	}
	// 空串 / 纯空白 = 未设
	assert.equal(memoryInjectLimit(env({ MEMORY_INJECT_LIMIT: "   " })), 16);
	assert.equal(memoryInjectMaxChars(env({ MEMORY_INJECT_MAX_CHARS: "" })), 2000);
});

test("注入预算：越界 clamp 到边界（0 / 负数 / 超大都不会把注入弄没或撑爆）", () => {
	// 下限：0 和负数 → 1 条 / 200 字（不是关闭）
	assert.equal(memoryInjectLimit(env({ MEMORY_INJECT_LIMIT: "0" })), 1);
	assert.equal(memoryInjectLimit(env({ MEMORY_INJECT_LIMIT: "-5" })), 1);
	assert.equal(memoryInjectMaxChars(env({ MEMORY_INJECT_MAX_CHARS: "0" })), 200);
	// 上限：避免填成一个数把上下文撑爆
	assert.equal(memoryInjectLimit(env({ MEMORY_INJECT_LIMIT: "999" })), 40);
	assert.equal(memoryInjectMaxChars(env({ MEMORY_INJECT_MAX_CHARS: "999999" })), 8000);
});

test("注入预算：小数四舍五入到整数", () => {
	assert.equal(memoryInjectLimit(env({ MEMORY_INJECT_LIMIT: "12.6" })), 13);
	assert.equal(memoryInjectMaxChars(env({ MEMORY_INJECT_MAX_CHARS: "1500.4" })), 1500);
});

test("召回后去重开关：默认开，false / 0 / off 关", () => {
	assert.equal(memoryInjectDedupeEnabled(env()), true);
	assert.equal(memoryInjectDedupeEnabled(env({ MEMORY_INJECT_DEDUPE: "false" })), false);
	assert.equal(memoryInjectDedupeEnabled(env({ MEMORY_INJECT_DEDUPE: "0" })), false);
	assert.equal(memoryInjectDedupeEnabled(env({ MEMORY_INJECT_DEDUPE: "off" })), false);
	assert.equal(memoryInjectDedupeEnabled(env({ MEMORY_INJECT_DEDUPE: "true" })), true);
	assert.equal(memoryInjectDedupeEnabled(env({ MEMORY_INJECT_DEDUPE: "  " })), true);
});
