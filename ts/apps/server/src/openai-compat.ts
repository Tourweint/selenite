import { createHash } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { ChatMessage } from "@lifediary/shared";
import { chatStream, openOrCreateChat } from "./agent.ts";
import { readLlmConfig } from "./provider.ts";

/**
 * OpenAI 兼容端点：`POST /api/v1/llm/chat/completions`
 *
 * 存在的理由是**客户端已经在按这个协议说话了**。
 * 手机 App（Kotlin）的设计是"LLM 唯一通道 = 内置服务"，请求路径固定为
 * `{baseUrl}/chat/completions`，SSE 解析固定读 `choices[0].delta.content` 和 `[DONE]`。
 *
 * 与其改客户端的协议层，不如在服务端加一层薄适配 —— 这样 App 只要把地址指过来，
 * 立刻就能用上记忆和工具（因为内部走的还是 agent 路径，不是无状态透传）。
 *
 * 代价：OpenAI 协议是无状态的（每次带全量 messages），而我们内部是会话制的。
 * 折中办法是从请求内容里推导一个稳定的会话 id（见 conversationIdFor）。
 */

interface OpenAiMessage {
	role?: string;
	content?: unknown;
}

interface OpenAiChatRequest {
	model?: string;
	messages?: OpenAiMessage[];
	stream?: boolean;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) {
					return String((part as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.join("");
	}
	return "";
}

/**
 * 从请求里推导会话 id。
 *
 * OpenAI 协议没有会话概念，但客户端的**第一条用户消息**在一段对话里是固定的，
 * 用它做哈希就能把"同一段对话"稳定映射到同一个会话 —— 服务端的会话、
 * 压缩、记忆作用域都能正常累积，而客户端什么都不用改。
 *
 * 想精确控制的话可以带 `X-Conversation-Id` 头，优先于推导值。
 */
function conversationIdFor(rawHeader: string | undefined, messages: ChatMessage[]): string {
	if (rawHeader?.trim()) return rawHeader.trim();
	const firstUser = messages.find((message) => message.role === "user")?.content ?? "";
	const digest = createHash("sha256").update(firstUser).digest("hex").slice(0, 32);
	return `oa-${digest}`;
}

export function mountOpenAiCompat(app: Hono): void {
	app.post("/api/v1/llm/chat/completions", async (c) => {
		const body = (await c.req.json().catch(() => null)) as OpenAiChatRequest | null;
		if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
			return c.json(
				{ error: { message: "messages 不能为空", type: "invalid_request_error" } },
				400,
			);
		}

		const messages: ChatMessage[] = body.messages
			.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
			.map((m) => ({
				role: m.role as ChatMessage["role"],
				content: textOf(m.content),
			}))
			.filter((m) => m.content.trim().length > 0);

		if (messages.length === 0) {
			return c.json(
				{ error: { message: "messages 里没有可用内容", type: "invalid_request_error" } },
				400,
			);
		}

		if (!readLlmConfig()) {
			return c.json(
				{ error: { message: "服务端未配置 LLM_API_KEY", type: "invalid_request_error" } },
				503,
			);
		}

		const conversationId = conversationIdFor(c.req.header("X-Conversation-Id"), messages);
		// OpenAI 协议是无状态的：每次带全量 messages，但我们只把最后一条用户消息交给会话。
		// 更早的历史已经在服务端的 transcript 里了，重复塞进去反而会打架。
		const lastUser = [...messages].reverse().find((message) => message.role === "user");
		if (!lastUser) {
			return c.json(
				{ error: { message: "没有用户消息", type: "invalid_request_error" } },
				400,
			);
		}

		const chat = await openOrCreateChat(conversationId);
		const input = {
			conversation: chat.conversation,
			text: lastUser.content,
		};

		// ── 非流式：聚合后一次性返回 ──────────────────
		if (body.stream !== true) {
			let text = "";
			try {
				for await (const event of chatStream(input)) {
					text += event.type === "delta" ? event.text : event.message;
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return c.json({ error: { message: detail, type: "upstream_error" } }, 502);
			}
			return c.json({
				id: conversationId,
				object: "chat.completion",
				model: body.model ?? "lifediary",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: text },
						finish_reason: "stop",
					},
				],
			});
		}

		// ── 流式：逐块转成 OpenAI 的 chunk 形状 ────────
		return streamSSE(c, async (stream) => {
			try {
				for await (const event of chatStream(input)) {
					// 断线不中止那一轮（跟自有端点一致），这里只是没人读了
					if (stream.aborted) break;
					const content = event.type === "delta" ? event.text : event.message;
					await stream.writeSSE({
						data: JSON.stringify({
							id: conversationId,
							object: "chat.completion.chunk",
							model: body.model ?? "lifediary",
							choices: [{ index: 0, delta: { content }, finish_reason: null }],
						}),
					});
				}
				await stream.writeSSE({
					data: JSON.stringify({
						id: conversationId,
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					}),
				});
				// 客户端把 [DONE] 当作正常结束的标记，缺了会被判成断流
				await stream.writeSSE({ data: "[DONE]" });
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				console.error(`[compat ${conversationId}] 生成失败: ${detail}`);
				await stream
					.writeSSE({
						data: JSON.stringify({
							error: { message: "生成失败，请稍后重试", type: "upstream_error" },
						}),
					})
					.catch(() => undefined);
				await stream.writeSSE({ data: "[DONE]" }).catch(() => undefined);
			}
		});
	});
}
