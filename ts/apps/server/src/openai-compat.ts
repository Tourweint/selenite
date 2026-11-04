import { createHash, randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Context, Hono } from "hono";
import type { ChatMessage, ThinkingLevel } from "@lifediary/shared";
import {
	applyChatMode,
	chatStream,
	configureTaskChat,
	conversationThinkingLevel,
	openChat,
	openOrCreateChat,
	stickyThinkingLevel,
	TASK_CONVERSATION_PREFIX,
	taskMemoryBlock,
} from "./agent.ts";
import { chatModelRef, readLlmConfig, taskModelRef } from "./provider.ts";
import { renderTask, resolveTask, taskLabel, taskNames, TaskRenderError } from "./tasks.ts";
import { classifyTurn, jevMode } from "./typesafe.ts";

/**
 * OpenAI 兼容端点：`POST /api/v1/llm/chat/completions`
 *
 * 存在的理由是**客户端已经在按这个协议说话了**。
 * 手机 App（Kotlin）的设计是"LLM 唯一通道 = 内置服务"，请求路径固定为
 * `{baseUrl}/chat/completions`，SSE 解析固定读 `choices[0].delta.content` 和 `[DONE]`。
 *
 * **只剩两条路（2026-10-31，方案 D10 步骤 5 删掉了"直通"）**，见 `接口文档.md` §2.4.1：
 *
 * **A. 任务通道（`X-Task` / body `task`）** —— 服务端按任务名渲染模板，走 durable 会话（建会话、落库、可回读）；
 *    无人格、无工具，`question` / `diary_review` 额外注入 `<memory>` 近况块。
 *    这类请求的 `temperature` / `max_tokens` / `response_format` 仍然生效（派生模型透传）。
 *
 * **B. 聊天（不带 task）** —— durable 会话：有历史、有记忆、有工具、有技能。
 *    客户端每次带全量 messages，但只取最后一条 user。
 *
 * **带 `system` 的请求一律 400（`system_prompt_not_supported`）。**
 * 原因：直通分支（"整套 system 原样转发、不建会话"）已于 2026-10-31 删除——生产端 12 个任务
 * 全部改走任务通道、聊天从不带 system，它已无调用方。留一个"带 system 就静默降级"的后门
 * 比报错更危险：模板会被当普通消息丢掉，产出看着成功、其实是残废。
 */

interface OpenAiMessage {
	role?: string;
	content?: unknown;
}

interface OpenAiChatRequest {
	model?: string;
	messages?: OpenAiMessage[];
	stream?: boolean;
	/**
	 * 任务模板变量（仅 `X-Task` 通道）。
	 *
	 * 为什么变量走请求体而不是头/URL：日记原文动辄几 KB，头放不下；
	 * 也刻意不让客户端再发一份渲染好的 `system`（那就是"模板没上移"）。
	 * 形状 = `{ "user_messages": "- 今天…", "entry_types": "…" }`，值必须是字符串。
	 */
	task_vars?: Record<string, unknown>;
	/** 采样参数：任务通道会透传（派生模型）；聊天路径由服务端配置决定（接口文档 §2.4.1） */
	temperature?: number;
	max_tokens?: number;
	response_format?: unknown;
	reasoning_effort?: string;
}

/** 失败时回给客户端的文案：按"一条正常消息"呈现，不制造空气泡 */
const UPSTREAM_ERROR_TEXT = "生成失败，请稍后重试";

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
 * 从请求里推导会话 id（仅 Agent 路径用）。
 *
 * OpenAI 协议没有会话概念，但客户端的**第一条用户消息**在一段对话里是固定的，
 * 用它做哈希就能把"同一段对话"稳定映射到同一个会话 —— 服务端的会话、
 * 压缩、记忆作用域都能正常累积，而客户端什么都不用改。
 *
 * 想精确控制的话可以带 `X-Conversation-Id` 头，优先于推导值。
 */
function conversationIdFor(
	rawHeader: string | undefined,
	messages: ChatMessage[],
	options?: { freshPrefixedWith?: string },
): string {
	if (rawHeader?.trim()) return rawHeader.trim();
	// 任务通道：**一次调用一个会话**。任务之间没有对话关系，复用同一个 id 只会把
	// 同一个任务的多次调用挤成一条（实测：三次收敛滚进 186099d，token 越滚越长、
	// 回读也分不清哪次是哪次）。要续跑就显式带 X-Conversation-Id。
	if (options?.freshPrefixedWith) {
		return `${options.freshPrefixedWith}${randomUUID()}`;
	}
	const firstUser = messages.find((message) => message.role === "user")?.content ?? "";
	const digest = createHash("sha256").update(firstUser).digest("hex").slice(0, 32);
	return `oa-${digest}`;
}

/** 取一个 OpenAI chunk 里的增量文本（上游也按这个协议回，解析失败一律当无内容） */
function contentOfChunk(payload: string): string | null {
	try {
		const parsed = JSON.parse(payload) as {
			choices?: Array<{ delta?: { content?: unknown } }>;
		};
		const content = parsed.choices?.[0]?.delta?.content;
		return typeof content === "string" && content.length > 0 ? content : null;
	} catch {
		return null;
	}
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

		// 分流点（三路，2026-10-30 起）：
		// A. 带 `X-Task` → 任务通道：按任务名在**服务端**渲染模板，走 Agent 会话（建会话、落库、可回读）；
		// B. 带非空 `system` → 直通上游（不建会话，老客户端/纯 OpenAI 端点仍走这条）；
		// C. 都没有 → 通用聊天 Agent。
		const rawTask = c.req.header("X-Task")?.trim().toLowerCase();
		if (rawTask) {
			const task = resolveTask(rawTask);
			if (!task) {
				return c.json(
					{
						error: {
							code: "unknown_task",
							message: `未知任务 ${rawTask}；可用：${taskNames().join(" / ")}`,
							type: "invalid_request_error",
						},
					},
					400,
				);
			}
			// 先渲染再开会话：模板炸了就回 500，绝不留半条空会话（写库前失败才干净）
			let prompt: string;
			try {
				prompt = renderTask(task, body.task_vars ?? {});
			} catch (error) {
				const detail = error instanceof TaskRenderError ? error.reason : String(error);
				console.error(`[compat task ${rawTask}] 渲染失败: ${detail}`);
				return c.json(
					{
						error: {
							code: "task_render_failed",
							message: `任务 ${rawTask} 渲染失败`,
							type: "server_error",
						},
					},
					500,
				);
			}
			// 近况记忆（2026-10-31，记忆方案 §4）：只有声明了 `memory` 的任务才注入，
			// 且**拼在 instructions 尾部**——模板前缀不变，缓存照旧命中（方案 §2.3 实测）。
			const memory = task.memory === "diary" ? taskMemoryBlock() : "";
			const promptWithMemory = memory ? `${prompt}\n\n${memory}` : prompt;
			if (memory) {
				console.log(`[compat task ${taskLabel(task)}] 注入近况记忆 ${memory.length} 字符`);
			}
			return agentChat(c, body, messages, { label: taskLabel(task), prompt: promptWithMemory });
		}

	// 2026-10-31（方案 D10 步骤 5）：**直通分支已删除**。
	// 生产端已无调用方（12 个任务全走 X-Task，聊天从不带 system）。
	// 带 system 一律 400：宁可让旧客户端立刻报错，也不要静默降级成"聊天轨迹"——
	// 那样它的模板会被当普通消息丢掉，产出看着像成功、其实是残废（比报错更糟）。
	if (messages.some((m) => m.role === "system")) {
		return c.json(
			{
				error: {
					type: "invalid_request_error",
					code: "system_prompt_not_supported",
					message: "不再接受 system 提示词：任务请用 X-Task + task_vars（模板在服务端），聊天不要带 system。",
				},
			},
			400,
		);
	}

	// 剩下的都是聊天轨迹（无 task、无 system）
	return agentChat(c, body, messages);
	});
}

/**
 * 本轮档位（2026-11-04 思考档位方案 D4）。
 *
 * 优先级（`接口文档.md` §2.4.1）：`X-Mode` > 会话已是非 off 档 > Jev gate > 默认 off。
 * "会话已是非 off"读的是 durable 模型引用里的 `#think-<档>`，所以 D3 切过、
 * `/mode` 设过、进程重启过都认得（旧的 `#think-on` 按 high 解释）。
 * 越界档位由 applyChatMode 按支持域落回，这里只管"想要哪一档"。
 */
async function decideMode(
	header: string | undefined,
	conversationId: string,
	internalId: number,
	current: ThinkingLevel | null,
	messages: ChatMessage[],
): Promise<ThinkingLevel> {
	const requested = levelFromHeader(header);
	if (requested) return requested;
	// 这条会话已经不在 off（D3 切过 / /mode 设过）→ 保持，别在思考中间抖回关
	if (current && current !== "off") return current;
	const sticky = stickyThinkingLevel(internalId);
	if (sticky) return sticky;
	if (jevMode() !== "gate") return "off";

	const recent = messages
		.filter((m) => m.role === "user" || m.role === "assistant")
		.slice(-3)
		.map((m) => ({ role: m.role as "user" | "assistant", text: m.content }));
	// 超时兜底：Jev 经代理的实测延迟在 0.9–2.8s 之间抖，卡太久等于把"新会话第一句"拖慢。
	// 超过 JEV_TIMEOUT_MS（默认 1200）就当没判出来 → 直接 off，宁可快也不要等。
	const timeoutMs = Number(process.env.JEV_TIMEOUT_MS ?? 1200);
	const verdict = await classifyTurn(
		{ recent, today: new Date().toISOString().slice(0, 10), turnCount: messages.length },
		Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1200,
	);
	if (!verdict) return "off";

	// deep_think → high；reply_direct（且够自信）→ off；其余/低置信 = 保守 → high
	const confidentDirect = verdict.choice === "reply_direct" && verdict.confidence >= 0.6;
	const level: ThinkingLevel = confidentDirect ? "off" : "high";
	console.log(
		`[jev ${conversationId}] 新会话选档=${level} route=${verdict.choice} ` +
			`conf=${verdict.confidence.toFixed(2)} ms=${verdict.ms}`,
	);
	return level;
}

/** `X-Mode` 解析：新值四档 + 旧别名 fast→off、deep→high；不认识当没给 */
function levelFromHeader(header: string | undefined): ThinkingLevel | null {
	const value = header?.trim().toLowerCase();
	if (value === "off" || value === "low" || value === "medium" || value === "high") return value;
	if (value === "fast") return "off";
	if (value === "deep") return "high";
	return null;
}

/**
 * 旁路观察（`JEV_ROUTE=advisory`）：不阻塞、不改变任何行为，只把 Jev 的判断写进日志。
 *
 * 为什么先只做旁路：经 socks 代理实测 **850–1150ms**，放到首字路径上等于每轮白等 1 秒；
 * 而它换来的只是"要不要工具、要不要深想"的选择。先攒几天分布（needs_tools 占多少），
 * 再决定要不要真按它切通道、切模型档（那时才值得付这 1 秒）。
 *
 * `JEV_ROUTE=gate`（真改路由）**尚未实现**：它要配合快/深双模型档位一起做，
 * 现在就切会变成"没有收益的额外延迟"，所以显式打日志说明并按 advisory 处理。
 */
function observeRoute(conversationId: string, messages: ChatMessage[]): void {
	// 只有 advisory 才每轮旁路判一次；gate 已经在建会话时判过，绝不重复付钱/付延迟
	if (jevMode() !== "advisory") return;
	const recent = messages
		.filter((m) => m.role === "user" || m.role === "assistant")
		.slice(-3)
		.map((m) => ({ role: m.role as "user" | "assistant", text: m.content }));
	void classifyTurn({
		recent,
		today: new Date().toISOString().slice(0, 10),
		turnCount: messages.length,
	}).then((verdict) => {
		if (!verdict) return;
		console.log(
			`[jev ${conversationId}] route=${verdict.choice} conf=${verdict.confidence.toFixed(2)} ` +
				`state=${verdict.sessionState ?? "-"} engage=${verdict.engagement ?? "-"} ` +
				`emotion=${verdict.emotion ?? "-"} ms=${verdict.ms}`,
		);
	});
}

/** 任务通道的上下文：模板已渲染好，参数已从请求里取出来 */
interface TaskContext {
	/** 日志/留痕用：`converge@diary_convergence_v2` */
	label: string;
	/** 渲染完成的整份 prompt（作为 system 段持久化到会话） */
	prompt: string;
}

/** Agent 路径：会话制、有记忆与工具（手机聊天走这条） */async function agentChat(
	c: Context,
	body: OpenAiChatRequest,
	messages: ChatMessage[],
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
		try {
			for await (const event of chatStream(input)) {
				// 断线不中止那一轮（跟自有端点一致），这里只是没人读了
				if (stream.aborted) break;
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
				// 思考增量 / 内部用量事件（2026-11-04 批次一）：OpenAI 协议没有对应位，跳过
				if (event.type === "thinking" || event.type === "usage") continue;
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
		}
	});
}
