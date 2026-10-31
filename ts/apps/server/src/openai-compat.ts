import { createHash, randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Context, Hono } from "hono";
import type { ChatMessage } from "@lifediary/shared";
import {
	applyChatMode,
	chatStream,
	configureTaskChat,
	isThinkingOn,
	openChat,
	openOrCreateChat,
	TASK_CONVERSATION_PREFIX,
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
 * 两条路径（2026-10-29 实测后分流，见 docs/基线文档/接口文档.md §2.4.1）：
 *
 * **A. 直通（请求里带非空 `system`）** —— 原样转给上游模型，不建会话、无工具、无记忆。
 *    App 的模板类任务（收敛 / 周报 / 分段 / 记忆策展 / 题目 / 深挖 / 回忆开场白）都属于这一类：
 *    它们的整份 prompt 在 `system` 里，交给 Agent 会被丢掉（只喂最后一条 user 的"请整理成稿"），
 *    实测那次请求跑了 129 秒、产出为空。直通模式把 `temperature` / `max_tokens` /
 *    `response_format` / `reasoning_effort` 一并转给上游，客户端的预算因此真正生效。
 *
 * **B. Agent（没有 `system`）** —— 对话走 durable 会话：历史在服务端、有记忆、有工具。
 *    App 的聊天就是这条，客户端每次带全量 messages 也只取最后一条 user。
 *
 * 代价（如实登记）：A 路径没有会话概念，因此**不认 `X-Conversation-Id`**，也不落库、不写记忆。
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
	/** 以下四个只在直通路径生效；Agent 路径由服务端配置决定（接口文档 §2.4.1） */
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

function isFaux(): boolean {
	return (process.env.LLM_PROVIDER ?? "").trim().toLowerCase() === "faux";
}

interface UpstreamConfig {
	url: string;
	apiKey: string;
	model: string;
}

/** 直通路径要的上游三要素；没配 key 时返回 null（与 Agent 路径同口径：503） */
function upstreamConfig(): UpstreamConfig | null {
	const apiKey = process.env.LLM_API_KEY?.trim();
	if (!apiKey) return null;
	const baseUrl = (
		process.env.LLM_BASE_URL?.trim() ||
		"https://dashscope.aliyuncs.com/compatible-mode/v1"
	).replace(/\/+$/, "");
	return {
		url: `${baseUrl}/chat/completions`,
		apiKey,
		model: process.env.LLM_MODEL?.trim() || "qwen-plus",
	};
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
			return agentChat(c, body, messages, { label: taskLabel(task), prompt });
		}

		const hasSystem = messages.some((m) => m.role === "system");
		if (hasSystem) {
			return passthrough(c, body, messages);
		}

		return agentChat(c, body, messages);
	});
}

/**
 * 直通上游：整套 messages（含 system）原样转发，参数照抄。
 *
 * 不建会话、不落库、不写记忆 —— 这些任务（收敛/周报/分段…）本来就不该进对话历史，
 * 更不该被 Agent 的人格和工具污染。
 *
 * **deprecated（2026-10-31 方案 D10）**：日记类任务已全部迁到 `X-Task` 任务通道，
 * 直通只剩 `question`（等记忆块/画像数据源落地后切 v2）和未知的旧客户端。
 * 每次直通都打一行告警——观察期（方案 §6 步骤 4）结束后删除本分支。
 */
let passthroughWarned = 0;
async function passthrough(c: Context, body: OpenAiChatRequest, messages: ChatMessage[]) {
	const stream = body.stream === true;
	passthroughWarned += 1;
	console.warn(
		`[compat passthrough] DEPRECATED 直通调用 #${passthroughWarned}（stream=${stream}）` +
			` system=${(messages.find((m) => m.role === "system")?.content ?? "").length} 字` +
			` —— 任务请改走 X-Task 通道；迁移完成后本分支将删除（方案 D10）`,
	);

	// faux 模式没有真实上游：给一句固定回复，保证链路形状能验
	if (isFaux()) {
		if (!stream) {
			return c.json({
				object: "chat.completion",
				model: "faux",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "（faux 模型）链路已通。" },
						finish_reason: "stop",
					},
				],
			});
		}
		return streamSSE(c, async (s) => {
			await s
				.writeSSE({
					data: JSON.stringify({
						object: "chat.completion.chunk",
						choices: [
							{ index: 0, delta: { content: "（faux 模型）链路已通。" }, finish_reason: null },
						],
					}),
				})
				.catch(() => undefined);
			await s.writeSSE({ data: "[DONE]" }).catch(() => undefined);
		});
	}

	const config = upstreamConfig();
	if (!config) {
		return c.json(
			{ error: { message: "服务端未配置 LLM_API_KEY", type: "invalid_request_error" } },
			503,
		);
	}

	const payload: Record<string, unknown> = {
		model: config.model,
		messages: messages.map((m) => ({ role: m.role, content: m.content })),
		stream,
	};
	if (typeof body.temperature === "number") payload.temperature = body.temperature;
	if (typeof body.max_tokens === "number") payload.max_tokens = body.max_tokens;
	if (body.response_format) payload.response_format = body.response_format;
	if (body.reasoning_effort) payload.reasoning_effort = body.reasoning_effort;

	const callUpstream = () =>
		fetch(config.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(payload),
		});

	if (!stream) {
		try {
			const response = await callUpstream();
			if (!response.ok) {
				// 上游错误原文只进日志：可能带上模型名/限额细节
				console.error(`[compat passthrough] 上游 ${response.status}: ${await response.text()}`);
				return c.json({ error: { message: UPSTREAM_ERROR_TEXT, type: "upstream_error" } }, 502);
			}
			return c.json((await response.json()) as unknown);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[compat passthrough] 请求失败: ${detail}`);
			return c.json({ error: { message: UPSTREAM_ERROR_TEXT, type: "upstream_error" } }, 502);
		}
	}

	return streamSSE(c, async (s) => {
		const chunk = (content: string) => ({
			object: "chat.completion.chunk",
			// 刻意不带 id：直通路径没有会话 uuid，给了会被客户端当成 conversationId 存下来
			choices: [{ index: 0, delta: { content }, finish_reason: null }],
		});
		const finish = {
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		};

		try {
			const response = await callUpstream();
			if (!response.ok || !response.body) {
				console.error(`[compat passthrough] 上游流式失败: ${response.status}`);
				await s.writeSSE({ data: JSON.stringify(chunk(UPSTREAM_ERROR_TEXT)) }).catch(() => undefined);
				await s.writeSSE({ data: JSON.stringify(finish) }).catch(() => undefined);
				await s.writeSSE({ data: "[DONE]" }).catch(() => undefined);
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let emitted = false;
			while (true) {
				if (s.aborted) break;
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let index = buffer.indexOf("\n");
				while (index >= 0) {
					const line = buffer.slice(0, index).trim();
					buffer = buffer.slice(index + 1);
					index = buffer.indexOf("\n");
					if (!line.startsWith("data:")) continue;
					const data = line.slice(5).trim();
					if (!data || data === "[DONE]") continue;
					const content = contentOfChunk(data);
					if (content) {
						emitted = true;
						await s.writeSSE({ data: JSON.stringify(chunk(content)) });
					}
				}
			}
			// 一个字都没吐（典型原因：max_tokens 被思考吃光）→ 明说一句，别给客户端一个空气泡
			if (!emitted) {
				await s.writeSSE({ data: JSON.stringify(chunk(UPSTREAM_ERROR_TEXT)) }).catch(() => undefined);
			}
			await s.writeSSE({ data: JSON.stringify(finish) }).catch(() => undefined);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[compat passthrough] 流式异常: ${detail}`);
			await s.writeSSE({ data: JSON.stringify(chunk(UPSTREAM_ERROR_TEXT)) }).catch(() => undefined);
			await s.writeSSE({ data: JSON.stringify(finish) }).catch(() => undefined);
		}
		// 客户端把 [DONE] 当作正常结束的标记，缺了会被判成断流
		await s.writeSSE({ data: "[DONE]" }).catch(() => undefined);
	});
}

/**
 * 给**新会话**选档：`fast`（思考关）还是 `deep`（思考开）。
 *
 * 2026-10-31 方案 D1/D2 起：快/深是**同一个模型**，区别只剩 `enable_thinking`
 * （applyChatMode 负责落到思考变体上）。判定顺序：
 * 1. 客户端显式 `X-Mode: fast|deep` —— 说了就听；
 * 2. 已按 D3 切过思考开的会话 → 保持 deep（切一次就保持，别抖回去）；
 * 3. `JEV_ROUTE=gate` —— 建会话前问一次 Jev（同步，约 1–2.7s，只付这一次）；
 *    `needs_tools` / `deep_think` → 深档；`reply_direct` → 快档；
 *    **confidence < 0.6 一律保守走深档**（判不准时宁可慢一点，别给错答案）；
 * 4. 都没有 → 默认 `fast`（日常聊天；要工具它照样能调，D3 会在首次调工具时切一次思考档）。
 */
async function decideMode(
	header: string | undefined,
	conversationId: string,
	internalId: number,
	messages: ChatMessage[],
): Promise<"fast" | "deep"> {
	const requested = header?.trim().toLowerCase();
	if (requested === "fast" || requested === "deep") return requested;
	// 这条会话已切到思考开（D3 切过）→ 保持，别在思考中间抖回快档
	if (isThinkingOn(internalId)) return "deep";
	if (jevMode() !== "gate") return "fast";

	const recent = messages
		.filter((m) => m.role === "user" || m.role === "assistant")
		.slice(-3)
		.map((m) => ({ role: m.role as "user" | "assistant", text: m.content }));
	// 超时兜底：Jev 经代理的实测延迟在 0.9–2.8s 之间抖，卡太久等于把"新会话第一句"拖慢。
	// 超过 JEV_TIMEOUT_MS（默认 1200）就当没判出来 → 直接走快档，宁可快也不要等。
	const timeoutMs = Number(process.env.JEV_TIMEOUT_MS ?? 1200);
	const verdict = await classifyTurn(
		{ recent, today: new Date().toISOString().slice(0, 10), turnCount: messages.length },
		Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1200,
	);
	if (!verdict) return "fast";

	const deep = verdict.choice !== "reply_direct" || verdict.confidence < 0.6;
	console.log(
		`[jev ${conversationId}] 新会话选档=${deep ? "deep" : "fast"} route=${verdict.choice} ` +
			`conf=${verdict.confidence.toFixed(2)} ms=${verdict.ms}`,
	);
	return deep ? "deep" : "fast";
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
		(await openOrCreateChat(conversationId, readLlmConfig() ? chatModelRef(false) : undefined));

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
		const mode = await decideMode(c.req.header("X-Mode"), conversationId, chat.internalId, messages);
		await applyChatMode(chat, mode);
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
				if (event.type === "progress") continue;
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
