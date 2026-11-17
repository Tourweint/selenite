import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHAT_MAP_ANSWER_PREVIEW,
	chatMapEnabled,
	projectChatMapTurns,
	resolveBranchStart,
	type ChatMapTurn,
} from "./chat-map.ts";
import type { FoldedTranscriptMessage } from "./session-transcript.ts";

interface MessageOptions {
	id?: string;
	at?: number;
	steps?: Array<{ name: string; ok: boolean }>;
	hidden?: boolean;
	endedAt?: number;
	images?: Array<{ mimeType: string; data: string }>;
}

/** 合成一条投影后的消息（只带画板关心的字段）。 */
function message(
	role: "user" | "assistant",
	text: string,
	options: MessageOptions = {},
): FoldedTranscriptMessage {
	return {
		role,
		text,
		at: options.at ?? 1000,
		...(options.id ? { id: options.id } : {}),
		...(options.steps ? { steps: options.steps } : {}),
		...(options.hidden ? { hidden: true } : {}),
		...(options.endedAt ? { endedAt: options.endedAt } : {}),
		...(options.images ? { images: options.images } : {}),
	} as FoldedTranscriptMessage;
}

function turn(index: number, question: string, at: number, answer?: string, id?: string): ChatMapTurn {
	return {
		index,
		question: { text: question, at },
		...(answer ? { answer: { text: answer, at: at + 100, ...(id ? { id } : {}) } } : {}),
	};
}

test("回合投影：一问一答两张卡，工具只计数", () => {
	const turns = projectChatMapTurns([
		message("user", "第一问", { id: "u1", at: 1000 }),
		message("assistant", "先看看", {
			id: "a1",
			at: 1100,
			endedAt: 1500,
			steps: [
				{ name: "say", ok: true },
				{ name: "read", ok: true },
				{ name: "grep", ok: true },
			],
		}),
		message("assistant", "第一答", { id: "a1b", at: 1600, endedAt: 1800 }),
		message("user", "第二问", { id: "u2", at: 2000 }),
	]);
	assert.equal(turns.length, 2);
	assert.equal(turns[0]?.index, 0);
	// 最后一条有正文的 assistant 胜出；工具数跨同轮 assistant 累计（say 不算）
	assert.equal(turns[0]?.answer?.text, "第一答");
	assert.equal(turns[0]?.answer?.tools, 2);
	assert.equal(turns[0]?.answer?.endedAt, 1800);
	assert.equal(turns[1]?.answer, undefined);
});

test("回合投影：隐藏的定时触发开一轮、不给正文也不给 id", () => {
	const turns = projectChatMapTurns([
		message("user", "[lifediary.proactive]\n到点提醒", { id: "u1", hidden: true, at: 1000 }),
		message("assistant", "好的", { id: "a1", at: 1100 }),
		message("user", "我在问", { id: "u2", at: 2000 }),
		message("assistant", "回答", { id: "a2", at: 2100 }),
	]);
	assert.equal(turns.length, 2);
	assert.equal(turns[0]?.question.hidden, true);
	assert.equal(turns[0]?.question.text, "");
	assert.equal(turns[0]?.question.id, undefined);
	assert.equal(turns[0]?.answer?.text, "好的");
	assert.equal(turns[1]?.question.text, "我在问");
});

test("回合投影：纯附件问句标 hasAttachments，开头孤立的回答补空问卡", () => {
	const turns = projectChatMapTurns([
		message("assistant", "开门见山", { id: "a0", at: 500 }),
		message("user", "", { id: "u1", at: 1000, images: [{ mimeType: "image/png", data: "x" }] }),
		message("assistant", "看图", { id: "a1", at: 1100 }),
	]);
	assert.equal(turns.length, 2);
	assert.equal(turns[0]?.question.text, "");
	assert.equal(turns[0]?.answer?.text, "开门见山");
	assert.equal(turns[1]?.question.hasAttachments, true);
	assert.equal(turns[1]?.question.text, "");
});

test("回合投影：回答预览截断到上限", () => {
	const turns = projectChatMapTurns([
		message("user", "问", { at: 1000 }),
		message("assistant", "长".repeat(CHAT_MAP_ANSWER_PREVIEW + 10), { at: 1100 }),
	]);
	assert.equal(turns[0]?.answer?.text.length, CHAT_MAP_ANSWER_PREVIEW + 1);
	assert.ok(turns[0]?.answer?.text.endsWith("…"));
});

test("分叉点：优先按 atMessageId 在母会话里找答卡", () => {
	const parent = [turn(0, "一", 1000, "一答", "a1"), turn(1, "二", 2000, "二答", "a2")];
	const child = [
		turn(0, "一", 1000, "一答", "b1"),
		turn(1, "二", 2000, "二答", "b2"),
		turn(2, "分支新问", 3000),
	];
	const result = resolveBranchStart({ at: 2500, atMessageId: "a1" }, parent, child);
	assert.equal(result.start, 1);
	assert.equal(result.branchTurn, 0);
});

test("分叉点：老数据没有 atMessageId 时按时间戳数复制前缀", () => {
	const child = [
		turn(0, "一", 1000, "一答"),
		turn(1, "二", 2000, "二答"),
		turn(2, "分支新问", 9000),
	];
	const result = resolveBranchStart({ at: 5000 }, null, child);
	assert.equal(result.start, 2);
	assert.equal(result.branchTurn, 1);
});

test("分叉点：两条都读不出来时不猜，当作没有新回合", () => {
	const child = [turn(0, "一", 0, "一答")];
	const result = resolveBranchStart({ at: 5000 }, null, child);
	assert.equal(result.start, 1);
	assert.equal(result.branchTurn, null);
});

test("画板开关：缺省开，false/0/off 关（回滚 = 一行 env）", () => {
	const env = (value?: string) => (value === undefined ? {} : { CHAT_MAP_ENABLED: value });
	assert.equal(chatMapEnabled(), true);
	assert.equal(chatMapEnabled({} as NodeJS.ProcessEnv), true);
	assert.equal(chatMapEnabled({ CHAT_MAP_ENABLED: "true" } as NodeJS.ProcessEnv), true);
	assert.equal(chatMapEnabled(env("false") as NodeJS.ProcessEnv), false);
	assert.equal(chatMapEnabled(env("0") as NodeJS.ProcessEnv), false);
	assert.equal(chatMapEnabled(env("off") as NodeJS.ProcessEnv), false);
	assert.equal(chatMapEnabled(env("  FALSE ") as NodeJS.ProcessEnv), false);
});
