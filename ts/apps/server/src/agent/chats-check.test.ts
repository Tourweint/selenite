import assert from "node:assert/strict";
import { test } from "node:test";
import { missingChatIds } from "./chats-check.ts";

/**
 * 会话存活核对纯判定（2026-11-17，手机同步回收）。
 *
 * 只钉判定口径：不在会话表 / 已归档 / 任务专线 → 回收；在的 → 不动；
 * 重复 id 去重、垃圾输入忽略。真正的 durable 快照在 `missingChats`（session-index）。
 */

const base = {
	byExternal: { alive: 1, "task-42": 2 },
	archived: new Set(["archived"]),
	taskPrefix: "task-",
};

test("空请求与空表都不回收", () => {
	assert.deepEqual(missingChatIds([], base), []);
	assert.deepEqual(missingChatIds(["alive"], { ...base, byExternal: {} }), ["alive"]);
});

test("在会话表里的不动，不在的回收", () => {
	assert.deepEqual(missingChatIds(["alive"], base), []);
	assert.deepEqual(missingChatIds(["gone"], base), ["gone"]);
	assert.deepEqual(missingChatIds(["alive", "gone", "also-gone"], base), ["gone", "also-gone"]);
});

test("归档过的回收（活跃列表也已不出现）", () => {
	assert.deepEqual(missingChatIds(["archived"], { ...base, byExternal: { archived: 3 } }), [
		"archived",
	]);
});

test("任务专线回收（active 列表本就过滤）", () => {
	assert.deepEqual(missingChatIds(["task-42"], base), ["task-42"]);
});

test("重复 id 只回一次，非字符串忽略", () => {
	const ids = ["gone", "gone", "", null as unknown as string, 7 as unknown as string];
	assert.deepEqual(missingChatIds(ids, base), ["gone"]);
});
