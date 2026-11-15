import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextView } from "@earendil-works/pi-durable";
import {
	chatContextInspectEnabled,
	clearRequestInjections,
	contextInspectPayloadOf,
	contextInspectViewOf,
	lastRequestInjectionsOf,
	noteRequestInjections,
} from "./context-inspect.ts";

/**
 * 设置 → 上下文（2026-11-16）。
 *
 * 钉三件事：
 *   1. system/tools 走 pi-ai 重放后的当前状态（section 覆盖、skills 单拎）；
 *   2. 会变部分只计数，不搬正文；
 *   3. 注入记录只留最新一轮、最多 64 个会话，且不重跑召回。
 */

function viewOf(messages: unknown[]): ContextView {
	return { messages } as unknown as ContextView;
}

const tool = {
	name: "bash",
	description: "执行命令",
	parameters: { type: "object", properties: { command: { type: "string" } } },
};

test("开关：默认开，只有显式 false 才关", () => {
	assert.equal(chatContextInspectEnabled({}), true);
	assert.equal(chatContextInspectEnabled({ CHAT_CONTEXT_INSPECT: "" }), true);
	assert.equal(chatContextInspectEnabled({ CHAT_CONTEXT_INSPECT: "0" }), true);
	assert.equal(chatContextInspectEnabled({ CHAT_CONTEXT_INSPECT: "false" }), false);
});

test("固定块：section 按名覆盖；skills 单拎；工具与字符数对齐", () => {
	const view = viewOf([
		{
			role: "system",
			content: "底稿",
			sections: {
				persona: "旧人设",
				verification_iron_law: "验证",
				skills: "- 写周报：把本周的事写清楚\n- 查资料：先搜再答",
			},
			toolsAdded: [tool],
		},
		{ role: "system", content: "", sections: { persona: "新人设" } },
	]);

	const out = contextInspectViewOf(view);
	assert.equal(out.system.content, "底稿");
	assert.deepEqual(
		out.system.sections.map((section) => [section.key, section.text, section.stability]),
		[
			["persona", "新人设", "fixed"],
			["verification_iron_law", "验证", "fixed"],
		],
	);
	assert.equal(out.system.chars, "底稿".length + "新人设".length + "验证".length);
	// skills 不进系统提示词块
	assert.equal(out.system.sections.some((section) => section.key === "skills"), false);
	assert.equal(out.skills.count, 2);
	assert.equal(out.skills.chars, "- 写周报：把本周的事写清楚\n- 查资料：先搜再答".length);
	assert.equal(out.tools.count, 1);
	assert.equal(out.tools.items[0].name, "bash");
	assert.ok(out.tools.items[0].schema.includes('"command"'));
	assert.equal(out.tools.chars, JSON.stringify(tool).length);
});

test("会变部分：只计条数与字符，不搬正文", () => {
	const out = contextInspectViewOf(
		viewOf([
			{ role: "system", content: "", sections: {} },
			{ role: "user", content: "你好" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "我看看" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
				],
			},
			{ role: "toolResult", content: [{ type: "text", text: "a.ts\nb.ts" }] },
		]),
	);
	assert.deepEqual(out.changing.messages, { count: 2, chars: "你好".length + "我看看".length });
	assert.equal(out.changing.toolCalls.count, 1);
	assert.ok(out.changing.toolCalls.chars > 0);
	assert.deepEqual(out.changing.toolResults, { count: 1, chars: "a.ts\nb.ts".length });
});

test("注入记录：每会话只留最新一轮；空记录也能覆盖旧记忆", () => {
	clearRequestInjections();
	noteRequestInjections(1, [{ id: "memory_recall", text: "- 你爱吃面" }], 100);
	assert.deepEqual(lastRequestInjectionsOf(1)?.items, [{ id: "memory_recall", text: "- 你爱吃面" }]);

	noteRequestInjections(1, [{ id: "project_index", text: "项目索引" }], 200);
	assert.equal(lastRequestInjectionsOf(1)?.at, 200);
	assert.equal(lastRequestInjectionsOf(1)?.items[0].id, "project_index");

	noteRequestInjections(1, [], 300);
	assert.deepEqual(lastRequestInjectionsOf(1)?.items, []);
	assert.equal(lastRequestInjectionsOf(1)?.at, 300);
});

test("注入记录：超过 64 个会话按 LRU 丢最旧", () => {
	clearRequestInjections();
	for (let index = 1; index <= 65; index += 1) {
		noteRequestInjections(index, [{ id: "memory_recall", text: `第 ${index} 条` }], index);
	}
	assert.equal(lastRequestInjectionsOf(1), null);
	assert.equal(lastRequestInjectionsOf(2)?.at, 2);
	assert.equal(lastRequestInjectionsOf(65)?.at, 65);
	clearRequestInjections();
});

test("响应：记忆只取 memory_recall，其它注入列 id 与字数；无记录为 null", () => {
	const base = {
		conversationId: "uuid",
		title: "会话",
		chatKind: "chief",
		usage: { used: 100, window: 1000 },
		view: viewOf([{ role: "system", content: "", sections: { persona: "人设" } }]),
		memoryEnabled: true,
		env: { MEMORY_INJECT_LIMIT: "16", MEMORY_INJECT_MAX_CHARS: "2000" },
		now: 500,
	};

	const empty = contextInspectPayloadOf({ ...base, lastInjections: null });
	assert.equal(empty.memory.last, null);
	assert.equal(empty.memory.limit, 16);
	assert.equal(empty.memory.maxChars, 2000);

	const emptyRecall = contextInspectPayloadOf({
		...base,
		lastInjections: { at: 400, items: [{ id: "memory_recall", text: "" }] },
	});
	assert.deepEqual(emptyRecall.memory.last, {
		at: 400,
		items: 0,
		chars: 0,
		text: "",
		others: [],
	});

	const recalled = contextInspectPayloadOf({
		...base,
		lastInjections: {
			at: 400,
			items: [
				{ id: "memory_recall", text: "- 你爱吃面\n- 你在呼和浩特" },
				{ id: "project_index", text: "项目索引" },
			],
		},
	});
	assert.equal(recalled.memory.last?.items, 2);
	assert.equal(recalled.memory.last?.chars, "- 你爱吃面\n- 你在呼和浩特".length);
	assert.deepEqual(recalled.memory.last?.others, [{ id: "project_index", chars: "项目索引".length }]);
	assert.equal(recalled.updatedAt, 500);
});
