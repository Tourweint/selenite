/**
 * 历史 assistant 的 thinking 是否回放给上游（2026-11-25 上下文瘦身）。
 *
 * 背景：durable 里的 assistant entry 带 thinking block（`thinkingSignature:
 * "reasoning_content"`），pi-ai 的 openai-completions 适配层会把它原样发成上游的
 * `reasoning_content`。实测同一会话 58 次请求里约 29k token 是每轮重复的思考；
 * DeepSeek 官方口径也不建议回传历史 `reasoning_content`。
 *
 * 默认剥离（只影响这一次请求的视图，durable entry 不动——UI 的步骤展示还要用）；
 * `CHAT_REPLAY_THINKING=true` / `1` / `on` 回到旧形态，作为模型行为变差时的回滚。
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

const TRUTHY = new Set(["true", "1", "on"]);

/** 显式开启才回放；缺省 / 其它值 = 剥离。 */
export function replayThinkingEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return TRUTHY.has((env.CHAT_REPLAY_THINKING ?? "").trim().toLowerCase());
}

/**
 * 返回剥离后的消息视图：对 assistant 去掉 `type:"thinking"` 的 block，并删掉多余的
 * `reasoning_content` 字段；text / toolCall / toolResult / system / user 一律不动。
 *
 * 不改原数组与原消息对象；没有可剥的内容时保留原引用并回 `changed:false`。
 */
export function stripReplayedThinking(messages: readonly Message[]): {
	messages: Message[];
	changed: boolean;
} {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "assistant") return message;
		const assistant = message as AssistantMessage & { reasoning_content?: unknown };
		const content = assistant.content.filter((block) => block.type !== "thinking");
		const hasReasoningField = "reasoning_content" in assistant;
		if (content.length === assistant.content.length && !hasReasoningField) return message;
		changed = true;
		const copy: Record<string, unknown> = { ...assistant, content };
		delete copy.reasoning_content;
		return copy as unknown as Message;
	});
	return { messages: next, changed };
}
