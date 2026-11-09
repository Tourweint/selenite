import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TERMINATION_CONDITIONS } from "./turn-termination.ts";

/**
 * 条件终止清单守卫（2026-11-10 批 16 §4.3）：`where` 指向的文件必须真的存在。
 *
 * 目的只有一条——**防清单腐化**。文件改名 / 机制删掉时，这张表会静默变成
 * 一份"看起来很权威但指向空气"的文档；没有这条断言，没人会发现。
 * 字段本身也是逐条断言的：多一个 key、少一个 note 都算表被改坏。
 */

const SRC = dirname(fileURLToPath(import.meta.url));

test("每条条件的 where 文件都存在", () => {
	for (const condition of TERMINATION_CONDITIONS) {
		const file = join(SRC, condition.where);
		assert.ok(
			existsSync(file),
			`${condition.key} 的 where 指向不存在的文件：${condition.where}（改过名就同步这张表）`,
		);
	}
});

test("key 不重复，字段都非空且不含日期 / 时刻", () => {
	const keys = TERMINATION_CONDITIONS.map((condition) => condition.key);
	assert.equal(new Set(keys).size, keys.length, "key 必须唯一");
	for (const condition of TERMINATION_CONDITIONS) {
		for (const field of ["key", "label", "where", "note"] as const) {
			assert.ok(condition[field].trim().length > 0, `${condition.key}.${field} 不能为空`);
		}
		assert.equal(/20\d{2}-\d{1,2}-\d{1,2}/.test(condition.note), false, `${condition.key} 不含日期`);
		assert.equal(/\d{1,2}:\d{2}/.test(condition.note), false, `${condition.key} 不含时刻`);
	}
});
