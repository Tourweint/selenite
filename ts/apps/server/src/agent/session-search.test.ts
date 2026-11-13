import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTools } from "../tools.ts";
import {
	SNIPPET_MAX_CHARS,
	findAroundIndex,
	parseSessionSearchQuery,
	recallSessionsEnabled,
	searchSessions,
	searchSessionsPage,
	searchTranscriptLines,
	searchTranscriptPage,
	sessionSearchApiEnabled,
	type SessionReader,
	type TranscriptSource,
} from "./session-search.ts";

/**
 * 会话考古（2026-11-09 T4 §4）单测。
 *
 * 两段：
 *   1. 纯检索核心：跨两个会话命中、snippet 截断、days/limit、无命中空数组、snippet 打码；
 *   2. durable 适配层（假 reader）：任务专线/b 也纳入、标题取首句；外加条件注册开关。
 *
 * 不真起 durable，不碰真实 .data。
 */

const DAY = 86_400_000;
const NOW = new Date("2026-11-09T12:00:00.000Z").getTime();

function source(id: string, title: string, lines: TranscriptSource["lines"]): TranscriptSource {
	return { conversationId: id, title, lines };
}

test("会话考古：跨两个会话命中两条，snippet ≤200 且包含命中词", () => {
	const longLine = `${"甲".repeat(150)}马拉松${"乙".repeat(150)}`;
	const hits = searchTranscriptLines(
		[
			source("conv-a", "跑步计划", [
				{ role: "user", text: longLine, at: NOW - 2 * DAY },
				{ role: "assistant", text: "那我们先把每周三次定下来", at: NOW - 2 * DAY + 1000 },
			]),
			source("conv-b", "群聊", [
				{ role: "user", text: "马拉松报名截止日是月底，别忘了", at: NOW - 1 * DAY },
			]),
		],
		"马拉松",
		{},
		NOW,
	);

	assert.equal(hits.length, 2, "两个会话各命中一条");
	assert.deepEqual(
		new Set(hits.map((hit) => hit.conversationId)),
		new Set(["conv-a", "conv-b"]),
		"跨会话都命中",
	);
	for (const hit of hits) {
		assert.ok(hit.snippet.length <= SNIPPET_MAX_CHARS, `snippet 不得超过 200 字：${hit.snippet.length}`);
		assert.ok(hit.snippet.includes("马拉松"), "snippet 应包含命中词");
	}
	// 长句两边都够 100 字：正好裁到 200，且命中词前面留了约 100 字
	const long = hits.find((hit) => hit.conversationId === "conv-a")!;
	assert.equal(long.snippet.length, 200, "长文命中应裁满 200 字");
	assert.equal(long.snippet.indexOf("马拉松"), 100, "命中词前应留 100 字");
	assert.equal(hits[0]!.conversationId, "conv-b", "结果按时间倒序（新的在前）");
});

test("会话考古：days / limit 生效；无命中返回空数组", () => {
	const old = "很久以前聊过的旧事";
	const sources = [
		source("conv-a", "旧会话", [{ role: "user", text: old, at: NOW - 40 * DAY }]),
		source("conv-b", "新会话", [{ role: "user", text: "旧事重提一下", at: NOW - 1 * DAY }]),
	];

	assert.equal(searchTranscriptLines(sources, "旧事", {}, NOW).length, 1, "默认 30 天只给新的那条");
	const wider = searchTranscriptLines(sources, "旧事", { days: 60 }, NOW);
	assert.equal(wider.length, 2, "days=60 应把 40 天前的也捞回来");

	const limited = searchTranscriptLines(sources, "旧事", { days: 60, limit: 1 }, NOW);
	assert.equal(limited.length, 1, "limit 生效");
	assert.equal(limited[0]!.conversationId, "conv-b", "limit 截断保留最新的");

	assert.deepEqual(searchTranscriptLines(sources, "量子纠缠", {}, NOW), [], "无命中返回空数组");
	assert.deepEqual(searchTranscriptLines(sources, "旧", {}, NOW), [], "短于 2 字不发散");
});

test("会话考古：时间窗上限放到一百年（搜索页「查看更多/更早的历史」）", () => {
	const sources = [
		source("conv-old", "两年前", [{ role: "user", text: "很久以前聊过的那件事", at: NOW - 800 * DAY }]),
	];
	assert.equal(searchTranscriptLines(sources, "很久", { days: 365 }, NOW).length, 0, "一年以内搜不到");
	assert.equal(
		searchTranscriptLines(sources, "很久", { days: 36_500 }, NOW).length,
		1,
		"放宽到一百年后能捞回来",
	);
});

test("会话考古：offset 分页与 total（查看更多）", () => {
	const sources = [
		source("conv-a", "多命中", [
			{ role: "user", text: "第1条 爬山", at: NOW - 3 * DAY },
			{ role: "user", text: "第2条 爬山", at: NOW - 2 * DAY },
			{ role: "user", text: "第3条 爬山", at: NOW - 1 * DAY },
		]),
	];

	const first = searchTranscriptPage(sources, "爬山", { limit: 2 }, NOW);
	assert.equal(first.total, 3, "total 是未分页的总数");
	assert.equal(first.hits.length, 2, "第一页按 limit 截断");
	assert.ok(first.hits[0]!.snippet.includes("第3条"), "第一页从最新的开始");

	const second = searchTranscriptPage(sources, "爬山", { limit: 2, offset: 2 }, NOW);
	assert.equal(second.total, 3, "翻页不改变总数");
	assert.equal(second.hits.length, 1, "第二页只剩一条");
	assert.ok(second.hits[0]!.snippet.includes("第1条"), "offset 跳过最新的两条");

	const beyond = searchTranscriptPage(sources, "爬山", { limit: 2, offset: 99 }, NOW);
	assert.equal(beyond.hits.length, 0, "offset 超出范围 = 空页");
	assert.equal(beyond.total, 3, "空页仍带总数");
});

test("会话考古：snippet 出模型前打码", () => {
	const hits = searchTranscriptLines(
		[
			source("conv-a", "配置", [
				{ role: "user", text: "报名表在共享盘，api_key=abcdef123456 别外传", at: NOW - DAY },
			]),
		],
		"报名表",
		{},
		NOW,
	);
	assert.equal(hits.length, 1);
	assert.ok(hits[0]!.snippet.includes("«redacted»"), "凭据应被打码");
	assert.ok(!hits[0]!.snippet.includes("abcdef123456"), "凭据值不应出现在 snippet 里");
});

test("会话考古：读全部会话（含 task- 专线），标题没有改名时取首句", async () => {
	// 不读真实 .data/chat-meta.json
	process.env.AGENT_CHAT_META_PATH = join(tmpdir(), "lifediary-no-such-chat-meta.json");

	const entry = (kind: "pi.user" | "pi.assistant", text: string, at: number) => ({
		kind,
		model: [{ role: kind === "pi.user" ? "user" : "assistant", content: [{ type: "text", text }], timestamp: at }],
	});
	const reader: SessionReader = {
		async snapshot() {
			return { byExternal: { "conv-main": 1, "task-T-9": 2 } };
		},
		async conversation(id: never) {
			const entries =
				Number(id) === 1
					? [entry("pi.user", "周末去爬山吧", NOW - 2 * DAY)]
					: [entry("pi.user", "整理纪要：爬山装备清单", NOW - 1 * DAY)];
			return { context: async () => ({ entries }) } as never;
		},
	};

	const hits = await searchSessions(reader, "爬山", {}, NOW);
	assert.equal(hits.length, 2, "普通会话与任务专线都在检索范围内");
	const task = hits.find((hit) => hit.conversationId === "task-T-9");
	assert.ok(task, "任务专线应被命中");
	assert.equal(task!.title, "整理纪要：爬山装备清单", "没有改名时标题取首句");
	assert.ok(hits.some((hit) => hit.conversationId === "conv-main"));
});

test("会话考古：searchSessionsPage 同一份读取，额外回 total；工具侧形状不变", async () => {
	process.env.AGENT_CHAT_META_PATH = join(tmpdir(), "lifediary-no-such-chat-meta-page.json");
	const entry = (kind: "pi.user" | "pi.assistant", text: string, at: number) => ({
		kind,
		model: [{ role: kind === "pi.user" ? "user" : "assistant", content: [{ type: "text", text }], timestamp: at }],
	});
	const reader: SessionReader = {
		async snapshot() {
			return { byExternal: { "conv-main": 1, "task-T-9": 2 } };
		},
		async conversation(id: never) {
			const entries =
				Number(id) === 1
					? [entry("pi.user", "周末去爬山吧", NOW - 2 * DAY)]
					: [entry("pi.user", "整理纪要：爬山装备清单", NOW - 1 * DAY)];
			return { context: async () => ({ entries }) } as never;
		},
	};

	const page = await searchSessionsPage(reader, "爬山", { limit: 1 }, NOW);
	assert.equal(page.total, 2, "total 是全部命中数，不受 limit 影响");
	assert.equal(page.hits.length, 1, "hits 仍按 limit 分页");
	const page2 = await searchSessionsPage(reader, "爬山", { limit: 1, offset: 1 }, NOW);
	assert.equal(page2.total, 2);
	assert.equal(page2.hits.length, 1);
	assert.notEqual(page2.hits[0]!.conversationId, page.hits[0]!.conversationId, "第二页拿到另一条");

	const toolShaped = await searchSessions(reader, "爬山", { limit: 1 }, NOW);
	assert.ok(Array.isArray(toolShaped), "工具侧仍是数组（recall_sessions 不感知分页）");
	assert.equal(toolShaped.length, 1);
});

test("会话考古：开关与条件注册（不传 = 工具不上架）", () => {
	assert.equal(recallSessionsEnabled({}), true, "缺省开");
	assert.equal(recallSessionsEnabled({ AGENT_RECALL_SESSIONS: "false" }), false, "false 关");
	assert.equal(recallSessionsEnabled({ AGENT_RECALL_SESSIONS: "0" }), false, "0 关");
	assert.equal(recallSessionsEnabled({ AGENT_RECALL_SESSIONS: "off" }), false, "off 关");

	const base = { memory: null, scopeOf: () => ({ type: "global" as const }), delegate: false };
	const withTool = createTools({ ...base, recallSessions: async () => [] });
	assert.ok(withTool.some((tool) => tool.name === "recall_sessions"), "注入后工具应上架");
	const without = createTools({ ...base, recallSessions: null });
	assert.ok(!without.some((tool) => tool.name === "recall_sessions"), "不注入则不上架（回滚形态）");
});

// ── 只读搜索端点（2026-11-10 批 28 §二，接口文档 §2.5）──────────────────
test("搜索端点参数：空/短查询 → null（400）；形状与 days·limit 收敛", () => {
	assert.equal(parseSessionSearchQuery({}), null, "缺 q → null");
	assert.equal(parseSessionSearchQuery({ q: "  " }), null, "空查询 → null（调用方回 400）");
	assert.equal(parseSessionSearchQuery({ q: "爬" }), null, "短于 2 字 → null");
	assert.deepEqual(parseSessionSearchQuery({ q: "  爬山  ", days: "60", limit: "3" }), {
		query: "爬山",
		options: { days: 60, limit: 3 },
	});
	assert.deepEqual(parseSessionSearchQuery({ q: "爬山", days: "36500", limit: "20", offset: "40" }), {
		query: "爬山",
		options: { days: 36500, limit: 20, offset: 40 },
	});
	assert.deepEqual(parseSessionSearchQuery({ q: "爬山", days: "abc", limit: "", offset: "-1x" }), {
		query: "爬山",
		options: {}, // 非数字 / 空串都不塞进 options，交给检索核心回落
	});
	assert.equal(sessionSearchApiEnabled({}), true, "缺省开");
	assert.equal(sessionSearchApiEnabled({ AGENT_SESSIONS_SEARCH: "false" }), false, "false 关");
	assert.equal(sessionSearchApiEnabled({ AGENT_SESSIONS_SEARCH: "0" }), false, "0 关");
	assert.equal(
		sessionSearchApiEnabled({ AGENT_RECALL_SESSIONS: "false" }),
		true,
		"与工具开关互不牵连：关模型工具不等于关界面找旧事",
	);
});

test("搜索端点结果：命中形状固定、snippet ≤200 不含整段正文；aroundIndex 与定点找回同源", async () => {
	process.env.AGENT_CHAT_META_PATH = join(tmpdir(), "lifediary-no-such-chat-meta-2.json");
	const longText = `${"甲".repeat(150)}马拉松${"乙".repeat(150)}`;
	const at = NOW - DAY;
	const reader: SessionReader = {
		async snapshot() {
			return { byExternal: { "conv-a": 1 } };
		},
		async conversation() {
			return {
				context: async () => ({
					entries: [
						{
							kind: "pi.user",
							model: [{ role: "user", content: [{ type: "text", text: "先聊点别的" }], timestamp: at - 1000 }],
						},
						{
							kind: "pi.user",
							model: [{ role: "user", content: [{ type: "text", text: longText }], timestamp: at }],
						},
					],
				}),
			} as never;
		},
	};
	const parsed = parseSessionSearchQuery({ q: "马拉松" })!;
	const hits = await searchSessions(reader, parsed.query, parsed.options, NOW);
	assert.equal(hits.length, 1);
	const hit = hits[0]!;
	// 形状：只有这四个字段，没有把整段正文塞进结果
	assert.deepEqual(Object.keys(hit).sort(), ["at", "conversationId", "snippet", "title"]);
	assert.ok(hit.snippet.length <= SNIPPET_MAX_CHARS, "snippet 不得超过 200 字");
	assert.ok(!hit.snippet.includes("乙".repeat(150)), "结果不含正文超长（不带整段）");
	assert.ok(hit.snippet.includes("马拉松"), "命中词仍在 snippet 里");

	// 模拟定点找回端点的 readTranscript 结果：命中那条在下标 1
	const messages = [
		{ text: "先聊点别的", at: at - 1000 },
		{ text: longText, at },
	];
	assert.equal(
		findAroundIndex(messages, hit, "马拉松"),
		1,
		"时间一致 + 正文含命中词 → 精确定位到 readTranscript 下标 1",
	);
});

test("findAroundIndex 兜底：命中词找不到时按时间就近；空消息回 0", () => {
	const messages = [
		{ text: "甲", at: 100 },
		{ text: "乙", at: 200 },
		{ text: "丙", at: 300 },
	];
	assert.equal(findAroundIndex(messages, { at: 210 }, "不存在的词"), 1);
	assert.equal(findAroundIndex([], { at: 0 }, "马拉松"), 0);
});
