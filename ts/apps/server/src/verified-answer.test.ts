import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryEngine, RememberInput } from "@lifediary/memory";
import {
	questionOfArgs,
	recordVerifiedAnswer,
	verifiedAnswerContent,
	verifiedAnswerEnabled,
} from "./verified-answer.ts";

/**
 * 批 19 §二：ask_user 答复沉淀为记忆。纯函数 + 注入假引擎，不碰真实记忆库。
 */

function fakeEngine(sink: RememberInput[]): MemoryEngine {
	return {
		remember: (input: RememberInput) => {
			sink.push(input);
			return { id: "fake" } as never;
		},
	} as unknown as MemoryEngine;
}

test("答案沉淀：kind=fact / source=verified_answer / 会话 scope", () => {
	const sink: RememberInput[] = [];
	const wrote = recordVerifiedAnswer({
		conversationId: 42,
		question: "账号用哪个？",
		answer: "用工作号",
		engine: fakeEngine(sink),
		isGroup: () => false,
	});
	assert.equal(wrote, true);
	assert.equal(sink.length, 1);
	const record = sink[0]!;
	assert.equal(record.kind, "fact");
	assert.equal(record.source, "verified_answer");
	assert.equal(record.veracity, "stated");
	assert.deepEqual(record.scope, { type: "session", id: "42" });
	assert.equal(record.content, verifiedAnswerContent("账号用哪个？", "用工作号"));
	assert.match(record.content, /^问：账号用哪个？\n答：用工作号$/);
});

test("群会话不落：群不进个人记忆", () => {
	const sink: RememberInput[] = [];
	const wrote = recordVerifiedAnswer({
		conversationId: 7,
		question: "选哪个",
		answer: "A",
		engine: fakeEngine(sink),
		isGroup: () => true,
	});
	assert.equal(wrote, false);
	assert.equal(sink.length, 0);
});

test("开关旁路 + 空问题不落", () => {
	const sink: RememberInput[] = [];
	const saved = process.env.AGENT_VERIFIED_ANSWER;
	process.env.AGENT_VERIFIED_ANSWER = "false";
	try {
		assert.equal(
			recordVerifiedAnswer({
				conversationId: 1,
				question: "问",
				answer: "答",
				engine: fakeEngine(sink),
				isGroup: () => false,
			}),
			false,
		);
	} finally {
		if (saved === undefined) delete process.env.AGENT_VERIFIED_ANSWER;
		else process.env.AGENT_VERIFIED_ANSWER = saved;
	}
	assert.equal(sink.length, 0);
	assert.equal(verifiedAnswerEnabled({} as NodeJS.ProcessEnv), true);
	assert.equal(
		verifiedAnswerEnabled({ AGENT_VERIFIED_ANSWER: "off" } as NodeJS.ProcessEnv),
		false,
	);

	assert.equal(
		recordVerifiedAnswer({
			conversationId: 1,
			question: " ",
			answer: "答",
			engine: fakeEngine(sink),
			isGroup: () => false,
		}),
		false,
	);
	assert.equal(sink.length, 0);
});

test("问题解析：坏 JSON / 缺字段返回空串", () => {
	assert.equal(questionOfArgs('{"question":"用哪个号？","options":["A","B"]}'), "用哪个号？");
	assert.equal(questionOfArgs("{bad json"), "");
	assert.equal(questionOfArgs("{}"), "");
	assert.equal(questionOfArgs("null"), "");
});
