import assert from "node:assert/strict";
import test from "node:test";
import { memoryProactiveEnabled, proactiveForTurn } from "./memory-proactive.ts";

/**
 * 「也许值得提起」装配开关（2026-11-10 批 17 §二）。
 *
 * 三条纪律：默认关（观望型能力）、显式开才生效、执事轮一律不注入。
 * 分组渲染本身在记忆包 selftest §19 覆盖；这里只钉装配口径。
 */
test("MEMORY_PROACTIVE：默认关，只有 true / 1 / on 才开", () => {
	assert.equal(memoryProactiveEnabled({}), false, "缺省 = 关");
	assert.equal(memoryProactiveEnabled({ MEMORY_PROACTIVE: "" }), false);
	assert.equal(memoryProactiveEnabled({ MEMORY_PROACTIVE: "yes" }), false, "认不出的值按关");
	assert.equal(memoryProactiveEnabled({ MEMORY_PROACTIVE: "true" }), true);
	assert.equal(memoryProactiveEnabled({ MEMORY_PROACTIVE: "1" }), true);
	assert.equal(memoryProactiveEnabled({ MEMORY_PROACTIVE: "ON" }), true, "大小写不敏感");
});

test("proactiveForTurn：执事轮不注入，总管主对话才按开关", () => {
	const on = { MEMORY_PROACTIVE: "true" } as NodeJS.ProcessEnv;
	const off = {} as NodeJS.ProcessEnv;
	assert.equal(proactiveForTurn(true, on), false, "执事轮即使开了总开关也不注入");
	assert.equal(proactiveForTurn(false, on), true, "主对话 + 开关开 → 注入");
	assert.equal(proactiveForTurn(false, off), false, "主对话 + 开关关 → 不注入");
});
