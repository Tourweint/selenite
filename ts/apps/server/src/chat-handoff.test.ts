import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptMessage } from "./agent/session.ts";
import {
	HANDOFF_DEFAULT_TURNS,
	HANDOFF_MEMORY_LIMIT,
	buildHandoff,
	chatExportHandoffEnabled,
	handoffFileName,
	parseHandoffLimit,
	sliceRecentTurns,
	type HandoffMemory,
} from "./chat-handoff.ts";

/**
 * 导出「接续文件」形状（2026-11-10 批 20 §一）。
 *
 * 钉三件事：文件里必须同时有角色 / 读取说明 / 记忆摘要 / 最近原文；
 * 截断与记忆读不到要**写清原因**；文件名不泄露标题。
 */

const MEMORY: HandoffMemory = {
	enabled: true,
	scope: "global",
	items: [
		{ kind: "preference", content: "喜欢简短回答" },
		{ kind: "experience", content: "上次部署失败是端口占用" },
	],
};

function messages(): TranscriptMessage[] {
	const base = Date.parse("2026-11-10T12:00:00Z");
	return [
		{ role: "user", text: "第一问", at: base },
		{ role: "assistant", text: "第一答", at: base + 1_000 },
		{ role: "user", text: "第二问", at: base + 2_000 },
		{ role: "assistant", text: "第二答", at: base + 3_000 },
		{ role: "user", text: "第三问", at: base + 4_000 },
		{ role: "assistant", text: "第三答", at: base + 5_000 },
	];
}

test("开关：默认开，false / 0 / off 才关（2026-11-18 起走插件清单统一口径）", () => {
	assert.equal(chatExportHandoffEnabled({}), true);
	assert.equal(chatExportHandoffEnabled({ CHAT_EXPORT_HANDOFF: "" }), true);
	assert.equal(chatExportHandoffEnabled({ CHAT_EXPORT_HANDOFF: "0" }), false);
	assert.equal(chatExportHandoffEnabled({ CHAT_EXPORT_HANDOFF: "false" }), false);
	assert.equal(chatExportHandoffEnabled({ CHAT_EXPORT_HANDOFF: "FALSE" }), false);
});

test("limit：默认 30；只收 1–200 的整数", () => {
	assert.equal(parseHandoffLimit(undefined), HANDOFF_DEFAULT_TURNS);
	assert.equal(parseHandoffLimit(""), HANDOFF_DEFAULT_TURNS);
	assert.equal(parseHandoffLimit("1"), 1);
	assert.equal(parseHandoffLimit("200"), 200);
	assert.equal(parseHandoffLimit("0"), null);
	assert.equal(parseHandoffLimit("201"), null);
	assert.equal(parseHandoffLimit("1.5"), null);
	assert.equal(parseHandoffLimit("abc"), null);
});

test("最近 N 轮：从 user 起算，不切一半回答；更早的条数如实报", () => {
	const sliced = sliceRecentTurns(messages(), 1);
	assert.deepEqual(
		sliced.messages.map((message) => message.text),
		["第三问", "第三答"],
	);
	assert.equal(sliced.omittedMessages, 4);

	const all = sliceRecentTurns(messages(), 30);
	assert.equal(all.messages.length, 6);
	assert.equal(all.omittedMessages, 0);
});

test("接续文件：四块齐全，状态如实", () => {
	const doc = buildHandoff({
		conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		title: "部署那晚",
		kind: "chief",
		messages: messages(),
		memory: MEMORY,
		turns: 2,
		generatedAt: new Date("2026-11-10T12:00:00Z"),
	});

	assert.match(doc.markdown, /^# 接续文件：部署那晚/m);
	assert.match(doc.markdown, /你是主人身边的 AI 助手（总管）/);
	assert.match(doc.markdown, /这份文件可以直接粘给任何 AI 继续聊/);
	assert.match(doc.markdown, /导出成功不等于对方已经收到/);
	assert.match(doc.markdown, /【偏好】喜欢简短回答/);
	assert.match(doc.markdown, /【经历】上次部署失败是端口占用/);
	assert.match(doc.markdown, /## 最近 2 轮对话/);
	assert.match(doc.markdown, /更早的 2 条消息未包含/);
	assert.match(doc.markdown, /\*\*主人\*\* · 2026-11-10T12:00:02\.000Z/);
	assert.match(doc.markdown, /> 第二问/);

	assert.equal(doc.includedTurns, 2);
	assert.equal(doc.omittedMessages, 2);
	assert.equal(doc.totalMessages, 6);
});

test("记忆最多 20 条；未启用 / 读取失败 / 空池各有说明", () => {
	const many: HandoffMemory = {
		enabled: true,
		scope: "global",
		items: Array.from({ length: 25 }, (_, index) => ({
			kind: "preference",
			content: `第 ${index} 条`,
		})),
	};
	const capped = buildHandoff({
		conversationId: "id",
		kind: "worker",
		messages: messages(),
		memory: many,
		turns: 1,
	});
	const bullets = capped.markdown.split("\n").filter((line) => line.startsWith("- 【"));
	assert.equal(bullets.length, HANDOFF_MEMORY_LIMIT);
	assert.ok(!capped.markdown.includes("第 24 条"));

	const disabled = buildHandoff({
		conversationId: "id",
		kind: "worker",
		messages: [],
		memory: { enabled: false, scope: "", items: [] },
		turns: 1,
	});
	assert.match(disabled.markdown, /记忆未启用/);
	assert.match(disabled.markdown, /还没有可导出的消息/);

	const failed = buildHandoff({
		conversationId: "id",
		kind: "worker",
		messages: [],
		memory: { enabled: true, scope: "global", items: [], note: "服务端读取记忆失败" },
		turns: 1,
	});
	assert.match(failed.markdown, /记忆读取失败：服务端读取记忆失败/);
});

test("文件名只带会话 uuid 前 8 位，不含标题 / 正文", () => {
	const name = handoffFileName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
	assert.equal(name, "lifediary-handoff-aaaaaaaa.md");
	assert.equal(handoffFileName("../../etc/passwd"), "lifediary-handoff-etcpassw.md");
});
