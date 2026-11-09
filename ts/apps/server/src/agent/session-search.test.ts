import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTools } from "../tools.ts";
import {
	SNIPPET_MAX_CHARS,
	recallSessionsEnabled,
	searchSessions,
	searchTranscriptLines,
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
