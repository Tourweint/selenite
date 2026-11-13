/**
 * openai-compat-agent-chat
 *
 * 2026-11-14 从 openai-compat.ts 的 L336–L602 整段切出；正文原文搬运，未改一行实现。
 * 内含：agentChat
 */

import { TASK_CONVERSATION_PREFIX, applyChatMode, chatStream, configureTaskChat, conversationThinkingLevel, openChat, openOrCreateChat } from "./agent.ts";
import { chatModelRef, readLlmConfig, taskModelRef } from "./provider.ts";
import { stallWatchdog } from "./watchdog.ts";
import { streamSSE } from "hono/streaming";
import { Context } from "hono";
import { UPSTREAM_ERROR_TEXT, conversationIdFor, decideMode, observeRoute } from "./openai-compat-mount-open-ai-compat.ts";
import type { OpenAiChatRequest, PlainMessage, TaskContext } from "./openai-compat-mount-open-ai-compat.ts";

/** Agent 路径：会话制、有记忆与工具（手机聊天走这条） */async function agentChat(
	c: Context,
	body: OpenAiChatRequest,
	messages: PlainMessage[],
	task?: TaskContext,
) {
	const conversationId = task
		? conversationIdFor(c.req.header("X-Conversation-Id"), messages, {
				freshPrefixedWith: TASK_CONVERSATION_PREFIX,
			})
		: conversationIdFor(c.req.header("X-Conversation-Id"), messages);
	// OpenAI 协议是无状态的：每次带全量 messages，但我们只把最后一条用户消息交给会话。
	// 更早的历史已经在服务端的 transcript 里了，重复塞进去反而会打架。
	const lastUser = [...messages].reverse().find((message) => message.role === "user");
	if (!lastUser) {
		return c.json(
			{ error: { message: "没有用户消息", type: "invalid_request_error" } },
			400,
		);
	}

	// 新会话先按思考军建（最便宜），档位随后每轮再定 —— durable 的 `configure()` 支持
	// 会话中途换模型/换思考变体，"开局判死、后面换不了"的问题不存在（2026-10-29 实读 API 确认）。
	// 2026-10-31 方案 D2：默认档 = 思考关变体（不再用 fastModel 装配，那是部署别名了）。
	const chat =
		(await openChat(conversationId)) ??
		(await openOrCreateChat(conversationId, readLlmConfig() ? chatModelRef("off") : undefined));

	if (task) {
		// 任务通道：不判快/深档（任务一律用深档 + 客户端给的采样参数），
		// 先把渲染好的模板和参数配进会话，再提交那一句输入。
		try {
			await configureTaskChat(chat, task.prompt, taskModelRef({
				temperature: body.temperature,
				maxTokens: body.max_tokens,
				responseFormat: body.response_format,
			}));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[compat task ${task.label}] 会话配置失败: ${detail}`);
			return c.json(
				{ error: { code: "task_config_failed", message: "任务通道配置失败", type: "server_error" } },
				500,
			);
		}
		console.log(
			`[compat task ${task.label}] 会话 ${conversationId}（内部 ${chat.internalId}）` +
				` 参数 t=${body.temperature ?? "-"} max=${body.max_tokens ?? "-"}` +
				` rf=${body.response_format ? "on" : "-"}`,
		);
	} else {
		const level = await decideMode(
			c.req.header("X-Mode"),
			conversationId,
			chat.internalId,
			await conversationThinkingLevel(chat),
			messages,
		);
		await applyChatMode(chat, level);
	}

	const input = {
		conversation: chat.conversation,
		// 任务会话的输入是那句固定指令（"请整理成稿"），不是整份 prompt ——
		// 整份 prompt 在 instructions 里，写进 transcript 只会让回读变成一堵墙。
		text: lastUser.content,
	};

	if (!task) observeRoute(conversationId, messages);

	// ── 非流式：聚合后一次性返回 ──────────────────
	if (body.stream !== true) {
		let text = "";
		try {
			for await (const event of chatStream(input)) {
				if (
					event.type === "progress" ||
					event.type === "tool" ||
					event.type === "delegate" ||
					event.type === "attention" ||
					// 思考增量 / 内部用量事件（2026-11-04 批次一）：OpenAI 协议没有对应位，跳过
					event.type === "thinking" ||
					event.type === "usage" ||
					// 系统提示行（2026-11-07 消息即引导）：OpenAI 协议没有对应位，跳过
					event.type === "notice" ||
					// 审批（2026-11-04 批次二）：手机不进聊天流，审批走全局待办轮询
					// （GET /agent/approvals 不带 conversationId），非流式响应不注入审批正文。
					event.type === "approval"
				) {
					continue;
				}
				text += event.type === "delta" ? event.text : event.message;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[compat ${conversationId}] 生成失败: ${detail}`);
			return c.json({ error: { message: UPSTREAM_ERROR_TEXT, type: "upstream_error" } }, 502);
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
		// 看门狗（2026-11-12 扩面，口径见 watchdog.ts 头注释）：与 /chat 同一 chatStream
		// 引擎、同一上游阻塞点。首帧要等引擎第一个事件，流一开就先记一笔，
		// 首帧前的窗口（openChat 后引擎迟迟不出声）不漏记；"open" 不是事件类型，
		// 表示"流已开、还没发过帧"。
		const stallWatch = stallWatchdog();
		stallWatch.note(chat.internalId, "open");
		try {
			for await (const event of chatStream(input)) {
				// 断线不中止那一轮（跟自有端点一致），这里只是没人读了
				if (stream.aborted) break;
				// thinking / usage / notice 在 OpenAI 协议里不产帧，按"没有 SSE 事件"的
				// 口径不刷新计时（与 /chat 的 usage 不记账一致）；其余产出帧的事件都记。
				if (event.type !== "thinking" && event.type !== "usage" && event.type !== "notice") {
					stallWatch.note(chat.internalId, event.type);
				}
				// 进度帧：不带正文，只带一个非标准字段（客户端的 OpenAI chunk 解析会忽略未知字段）
				if (event.type === "progress") {
					await stream.writeSSE({
						data: JSON.stringify({
							object: "chat.completion.chunk",
							lifediary_progress: event.phase,
						}),
					});
					continue;
				}
				// 派活进度：跟 progress 一样走非标准字段，客户端解析器会忽略未知字段
				if (event.type === "delegate") {
					await stream.writeSSE({
						data: JSON.stringify({
							object: "chat.completion.chunk",
							lifediary_delegate: {
								// 2026-11-03：补任务单字段，App 才能把多张单分开、显示领域与阶段
								ticketId: event.ticketId,
								domain: event.domain,
								phase: event.phase,
								done: event.done,
								total: event.total,
								current: event.current,
								message: event.message ?? null,
								// 2026-11-04：任务中心需要的字段；缺省为 null，客户端不用判 undefined。
								project: event.project ?? null,
								lastAction: event.lastAction ?? null,
								lastHeartbeat: event.lastHeartbeat ?? null,
								waitingOn: event.waitingOn ?? null,
							},
						}),
					});
					continue;
				}
				// 思考增量 / 内部用量事件（2026-11-04 批次一）与系统提示行（2026-11-07）：
				// OpenAI 协议没有对应位，跳过
				if (event.type === "thinking" || event.type === "usage" || event.type === "notice") continue;
				// 工具起止：同样走非标准字段，让兼容层的客户端也能画"正在读 xxx"
				if (event.type === "tool") {
					await stream.writeSSE({
						data: JSON.stringify({
							object: "chat.completion.chunk",
							lifediary_tool: {
								name: event.name,
								status: event.status,
								label: event.label ?? null,
								ok: event.ok ?? null,
								output: event.output ?? null,
								args: event.args ?? null,
							},
						}),
					});
					continue;
				}
				// 需要人回答：把问题原文给客户端，让它出卡片而不是猜
				if (event.type === "attention") {
					await stream.writeSSE({
						data: JSON.stringify({
							object: "chat.completion.chunk",
							lifediary_attention: {
								ticketId: event.ticketId,
								domain: event.domain,
								kind: event.kind,
								question: event.question,
							},
						}),
					});
					continue;
				}
				// 审批（2026-11-04 批次二）：照 lifediary_attention 的惯例透传非标字段。
				// 手机不进聊天流，审批改走全局待办轮询；这个字段保留只为兼容，手机不再依赖。
				if (event.type === "approval") {
					await stream.writeSSE({
						data: JSON.stringify({
							object: "chat.completion.chunk",
							lifediary_approval: {
								callId: event.callId,
								tool: event.tool,
								args: event.args,
								deadlineAt: event.deadlineAt,
								...(event.origin ? { origin: event.origin } : {}),
							},
						}),
					});
					continue;
				}
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
			// 错误按"一条正常消息"回给客户端：这里不发 error 帧。
			// 原因（2026-10-29 实测）：客户端只认 choices[0].delta.content 和 [DONE]，
			// 独立的 error 帧会被当成噪音丢掉，最终表现为"空回复 / 半截回复"，比明说更坏。
			await stream
				.writeSSE({
					data: JSON.stringify({
						id: conversationId,
						object: "chat.completion.chunk",
						choices: [
							{ index: 0, delta: { content: UPSTREAM_ERROR_TEXT }, finish_reason: null },
						],
					}),
				})
				.catch(() => undefined);
			await stream
				.writeSSE({
					data: JSON.stringify({
						id: conversationId,
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					}),
				})
				.catch(() => undefined);
			await stream.writeSSE({ data: "[DONE]" }).catch(() => undefined);
		} finally {
			// 流结束（正常 / 报错 / 客户端断开），移出卡死跟踪
			stallWatch.finish(chat.internalId);
		}
	});
}

export { agentChat };
