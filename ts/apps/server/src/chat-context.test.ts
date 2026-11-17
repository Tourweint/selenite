import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTEXT_DEFAULT_RADIUS,
	chatContextLookupEnabled,
	contextMessageOf,
	parseAroundIndex,
	parseContextRadius,
	sliceAroundIndex,
} from "./chat-context.ts";

/**
 * 旧会话定点找回（2026-11-10 批 20 §四）。
 *
 * 内核没有 seq，这里钉的是"按数组下标切窗口"的边界：越界不能静默补零，
 * 窗口两端要如实给出真实下标。
 */

const MESSAGES = Array.from({ length: 10 }, (_, index) => ({
	role: index % 2 === 0 ? "user" : "assistant",
	text: `第 ${index} 条`,
	at: 1_000 + index,
}));

test("开关：默认开，false / 0 / off 才关（2026-11-18 起走插件清单统一口径）", () => {
	assert.equal(chatContextLookupEnabled({}), true);
	assert.equal(chatContextLookupEnabled({ CHAT_CONTEXT_LOOKUP: "" }), true);
	assert.equal(chatContextLookupEnabled({ CHAT_CONTEXT_LOOKUP: "0" }), false);
	assert.equal(chatContextLookupEnabled({ CHAT_CONTEXT_LOOKUP: "false" }), false);
});

test("aroundIndex：必填，非负整数", () => {
	assert.equal(parseAroundIndex(undefined), null);
	assert.equal(parseAroundIndex(""), null);
	assert.equal(parseAroundIndex("-1"), null);
	assert.equal(parseAroundIndex("1.5"), null);
	assert.equal(parseAroundIndex("abc"), null);
	assert.equal(parseAroundIndex("0"), 0);
	assert.equal(parseAroundIndex("9"), 9);
});

test("radius：默认 5；0–50 的整数", () => {
	assert.equal(parseContextRadius(undefined), CONTEXT_DEFAULT_RADIUS);
	assert.equal(parseContextRadius(""), CONTEXT_DEFAULT_RADIUS);
	assert.equal(parseContextRadius("0"), 0);
	assert.equal(parseContextRadius("50"), 50);
	assert.equal(parseContextRadius("-1"), null);
	assert.equal(parseContextRadius("51"), null);
	assert.equal(parseContextRadius("2.5"), null);
});

test("窗口：中间含两端；上边界截断；下边界截断", () => {
	const middle = sliceAroundIndex(MESSAGES, 5, 2);
	assert.equal(middle.from, 3);
	assert.equal(middle.to, 7);
	assert.deepEqual(
		middle.messages.map((message) => message.text),
		["第 3 条", "第 4 条", "第 5 条", "第 6 条", "第 7 条"],
	);

	const head = sliceAroundIndex(MESSAGES, 1, 5);
	assert.equal(head.from, 0);
	assert.equal(head.to, 6);

	const tail = sliceAroundIndex(MESSAGES, 9, 5);
	assert.equal(tail.from, 4);
	assert.equal(tail.to, 9);
});

test("radius=0 只取中心那一条；空会话给空窗口", () => {
	const one = sliceAroundIndex(MESSAGES, 4, 0);
	assert.equal(one.from, 4);
	assert.equal(one.to, 4);
	assert.equal(one.messages.length, 1);

	assert.deepEqual(sliceAroundIndex([], 0, 5), { from: 0, to: -1, messages: [] });
});

test("响应消息：带绝对下标与角色 / 时间；图片与步骤不回放", () => {
	const out = contextMessageOf(
		{ role: "user", text: "你好", at: 123, id: "uuid", images: [{ mimeType: "image/png", data: "x" }] },
		7,
	);
	assert.deepEqual(out, { role: "user", text: "你好", at: 123, index: 7, id: "uuid" });
});
