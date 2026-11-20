import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextView, Conversation } from "@earendil-works/pi-durable";
import { contextUsageOf } from "./agent/session-transcript.ts";
import {
	chatContextInspectEnabled,
	clearRequestInjections,
	contextInspectPayloadOf,
	contextInspectViewOf,
	lastRequestInjectionsOf,
	noteRequestInjections,
} from "./context-inspect.ts";
import { estimateTokens } from "./token-estimate.ts";

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

test("开关：默认开，false / 0 / off 才关（2026-11-18 起走插件清单统一口径）", () => {
	assert.equal(chatContextInspectEnabled({}), true);
	assert.equal(chatContextInspectEnabled({ CHAT_CONTEXT_INSPECT: "" }), true);
	assert.equal(chatContextInspectEnabled({ CHAT_CONTEXT_INSPECT: "0" }), false);
	assert.equal(chatContextInspectEnabled({ CHAT_CONTEXT_INSPECT: "false" }), false);
});

test("token 估算：中文一字一 token，ASCII 四字符一 token，空串为 0", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("人设"), 2);
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("abcdefgh"), 2);
	// 混合：两个汉字 + 8 个 ASCII = 2 + 2
	assert.equal(estimateTokens("汉字abcdefgh"), 4);
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
	assert.equal(
		out.system.tokens,
		estimateTokens("底稿") + estimateTokens("新人设") + estimateTokens("验证"),
	);
	assert.ok(out.system.sections.every((section) => section.tokens > 0));
	// skills 不进系统提示词块
	assert.equal(out.system.sections.some((section) => section.key === "skills"), false);
	assert.equal(out.skills.count, 2);
	assert.equal(out.skills.chars, "- 写周报：把本周的事写清楚\n- 查资料：先搜再答".length);
	assert.equal(out.skills.tokens, estimateTokens("- 写周报：把本周的事写清楚\n- 查资料：先搜再答"));
	assert.equal(out.tools.count, 1);
	assert.equal(out.tools.items[0].name, "bash");
	assert.ok(out.tools.items[0].schema.includes('"command"'));
	assert.equal(out.tools.chars, JSON.stringify(tool).length);
	assert.equal(out.tools.items[0].tokens, estimateTokens(JSON.stringify(tool)));
	assert.equal(out.tools.tokens, out.tools.items[0].tokens);
});

test("执事纪律拆节：每节独立命名并可编辑；主人数据红线单独只读", () => {
	const out = contextInspectViewOf(
		viewOf([
			{
				role: "system",
				content: "",
				sections: {
					partner_verification: "【验证铁律】\n先跑脚本",
					partner_ruling: "【裁决纪律】\n先调查",
					partner_owner_data: "【主人数据红线】\n只追加",
				},
				timestamp: 0,
			},
		]),
	);
	const verification = out.system.sections.find((section) => section.key === "partner_verification");
	assert.equal(verification?.label, "执事纪律 · 验证铁律");
	assert.equal(verification?.editable, true);
	assert.equal(
		out.system.sections.find((section) => section.key === "partner_ruling")?.label,
		"执事纪律 · 裁决纪律",
	);
	const ownerData = out.system.sections.find((section) => section.key === "partner_owner_data");
	assert.equal(ownerData?.label, "执事纪律 · 主人数据红线");
	assert.equal(ownerData?.editable, undefined, "红线不标可编辑");
});

test("执事身份拆节：说话方式单独命名；SOUL / 边界等六节各自成行", () => {
	const out = contextInspectViewOf(
		viewOf([
			{
				role: "system",
				content: "",
				sections: {
					partner_soul: "我是阿岚",
					partner_voice: "",
					partner_values: "",
					partner_scenario: "",
					partner_skill_index: "",
					partner_boundary: "运行边界",
				},
				timestamp: 0,
			},
		]),
	);
	assert.deepEqual(
		out.system.sections.map((section) => [section.key, section.label]),
		[
			["partner_soul", "执事身份 · SOUL"],
			["partner_voice", "执事人设 · 说话方式（口吻）"],
			["partner_values", "执事人设 · 里子"],
			["partner_scenario", "执事人设 · 处境"],
			["partner_skill_index", "执事身份 · 技能索引"],
			["partner_boundary", "执事身份 · 运行边界"],
		],
	);
	const voice = out.system.sections.find((section) => section.key === "partner_voice");
	assert.equal(voice?.empty, true, "说话方式为空也保留槽位");
	assert.equal(voice?.chars, 0);
});

test("空字段：text 为空也保留一行并标记 empty（默认页用来显示 0 字槽位）", () => {
	const out = contextInspectViewOf(
		viewOf([
			{ role: "system", content: "", sections: { persona: "人设", empty_slot: "" }, timestamp: 0 },
		]),
	);
	const empty = out.system.sections.find((section) => section.key === "empty_slot");
	assert.ok(empty, "空字符串 section 不应被丢掉");
	assert.equal(empty.text, "");
	assert.equal(empty.chars, 0);
	assert.equal(empty.empty, true);
	assert.equal(out.system.sections.find((section) => section.key === "persona")?.empty, undefined);
});

test("会变部分：只计条数与字符；条目按真实顺序给出可读正文", () => {
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
			{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "a.ts\nb.ts" }] },
		]),
	);
	assert.deepEqual(out.changing.messages, {
		count: 2,
		chars: "你好".length + "我看看".length,
		tokens: estimateTokens("你好") + estimateTokens("我看看"),
	});
	assert.equal(out.changing.toolCalls.count, 1);
	assert.ok(out.changing.toolCalls.chars > 0);
	assert.ok(out.changing.toolCalls.tokens > 0);
	assert.deepEqual(out.changing.toolResults, {
		count: 1,
		chars: "a.ts\nb.ts".length,
		tokens: estimateTokens("a.ts\nb.ts"),
	});
	// 2026-11-17：正文条目（系统消息不进条目，其余按消息顺序）
	assert.deepEqual(
		out.entries.map((entry) => [entry.kind, entry.label, entry.index]),
		[
			["user", "用户", 1],
			["assistant", "助手", 2],
			["toolCall", "bash", 2],
			["toolResult", "bash", 3],
		],
	);
	assert.equal(out.entries[0]?.text, "你好");
	assert.equal(out.entries[3]?.text, "a.ts\nb.ts");
	assert.ok(out.entries[2]?.text.includes('"command"'), "调用正文是 pretty 参数");
	// 组内相加 = changing 口径
	assert.equal(
		out.entries.filter((entry) => entry.kind === "toolResult").reduce((sum, entry) => sum + entry.tokens, 0),
		out.changing.toolResults.tokens,
	);
});

test("会话条目：超过 4000 字截断正文，token / 字数仍按全文算", () => {
	const long = "字".repeat(4001);
	const out = contextInspectViewOf(
		viewOf([
			{ role: "system", content: "", sections: {} },
			{ role: "user", content: long },
		]),
	);
	const entry = out.entries[0];
	assert.equal(entry?.kind, "user");
	assert.equal(entry?.truncated, true);
	assert.equal(entry?.text.length, 4000);
	assert.equal(entry?.chars, 4001);
	assert.equal(entry?.tokens, 4001);
	assert.equal(out.changing.messages.chars, 4001, "计数仍按全文");
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

test("上下文已用：input + cacheRead + cacheWrite（命中缓存不低报）", async () => {
	const view = {
		messages: [],
		entries: [
			{
				kind: "pi.assistant",
				model: [{ usage: { input: 120, output: 30, cacheRead: 5000, cacheWrite: 200 } }],
			},
		],
	} as unknown as ContextView;
	const conversation = {
		context: async () => view,
		agent: async () => null,
	} as unknown as Conversation;
	const out = await contextUsageOf(conversation, view);
	assert.equal(out.used, 5320);
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
		tokens: 0,
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
	assert.equal(recalled.memory.last?.tokens, estimateTokens("- 你爱吃面\n- 你在呼和浩特"));
	assert.deepEqual(recalled.memory.last?.others, [
		{
			id: "project_index",
			label: "负责项目",
			chars: "项目索引".length,
			tokens: estimateTokens("项目索引"),
			text: "项目索引",
		},
	]);
	assert.equal(recalled.updatedAt, 500);
});
