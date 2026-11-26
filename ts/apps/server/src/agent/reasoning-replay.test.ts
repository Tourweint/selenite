import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { replayThinkingEnabled, stripReplayedThinking } from "./reasoning-replay.ts";

/** 历史 assistant 的 thinking 不回放（2026-11-25 上下文瘦身）。 */

function assistantMessage(content: unknown[], extra: Record<string, unknown> = {}): Message {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...extra,
	} as unknown as Message;
}

test("剥离 thinking：text + toolCall 保留且顺序不变", () => {
	const toolCall = { type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "q" } };
	const message = assistantMessage([
		{ type: "thinking", thinking: "先想一想", thinkingSignature: "reasoning_content" },
		{ type: "text", text: "给你答案" },
		toolCall,
	]);
	const stripped = stripReplayedThinking([message]);
	assert.equal(stripped.changed, true);
	const content = (stripped.messages[0] as unknown as { content: unknown[] }).content;
	assert.deepEqual(content, [{ type: "text", text: "给你答案" }, toolCall]);
});

test("剥离 thinking：原数组与原消息对象都不被修改", () => {
	const content = [
		{ type: "thinking", thinking: "旧思考", thinkingSignature: "reasoning_content" },
		{ type: "text", text: "正文" },
	];
	const message = assistantMessage(content);
	const original = JSON.parse(JSON.stringify(message));
	const messages = [message];
	const stripped = stripReplayedThinking(messages);
	assert.equal(messages[0], message);
	assert.deepEqual(message, original);
	assert.notEqual(stripped.messages, messages);
	assert.notEqual(stripped.messages[0], message);
});

test("剥离 thinking：assistant 上的 reasoning_content 字段一并删掉", () => {
	const message = assistantMessage([{ type: "text", text: "正文" }], { reasoning_content: "残留" });
	const stripped = stripReplayedThinking([message]);
	assert.equal(stripped.changed, true);
	assert.equal("reasoning_content" in (stripped.messages[0] as object), false);
	assert.deepEqual(
		(stripped.messages[0] as unknown as { content: unknown[] }).content,
		[{ type: "text", text: "正文" }],
	);
});

test("没有 thinking 的消息：changed=false，消息对象原样保留", () => {
	const assistant = assistantMessage([{ type: "text", text: "正文" }]);
	const user = { role: "user", content: "你好", timestamp: 1 } as unknown as Message;
	const stripped = stripReplayedThinking([user, assistant]);
	assert.equal(stripped.changed, false);
	assert.equal(stripped.messages[0], user);
	assert.equal(stripped.messages[1], assistant);
});

test("非 assistant 消息（user / system / toolResult）一律不动", () => {
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "web_search",
		content: [{ type: "text", text: "结果" }],
		isError: false,
		timestamp: 2,
	} as unknown as Message;
	const stripped = stripReplayedThinking([toolResult]);
	assert.equal(stripped.changed, false);
	assert.equal(stripped.messages[0], toolResult);
});

test("回放开关：只有 true / 1 / on 才回放，缺省与其它值是剥离", () => {
	assert.equal(replayThinkingEnabled({}), false);
	assert.equal(replayThinkingEnabled({ CHAT_REPLAY_THINKING: "" }), false);
	assert.equal(replayThinkingEnabled({ CHAT_REPLAY_THINKING: "false" }), false);
	assert.equal(replayThinkingEnabled({ CHAT_REPLAY_THINKING: "0" }), false);
	assert.equal(replayThinkingEnabled({ CHAT_REPLAY_THINKING: "true" }), true);
	assert.equal(replayThinkingEnabled({ CHAT_REPLAY_THINKING: "1" }), true);
	assert.equal(replayThinkingEnabled({ CHAT_REPLAY_THINKING: " ON " }), true);
});
