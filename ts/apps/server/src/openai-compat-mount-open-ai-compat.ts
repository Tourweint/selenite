/**
 * openai-compat-mount-open-ai-compat
 *
 * 2026-11-14 从 openai-compat.ts 的 L28–L334 整段切出；正文原文搬运，未改一行实现。
 * 内含：PlainMessage / OpenAiMessage / OpenAiChatRequest / UPSTREAM_ERROR_TEXT …
 */

import { stickyThinkingLevel } from "./agent.ts";
import { taskMemoryProvider } from "./agent/assist.ts";
import { collectInjections } from "./agent/injection.ts";
import { readLlmConfig } from "./provider.ts";
import { TaskRenderError, renderTask, resolveTask, taskLabel, taskNames } from "./tasks.ts";
import { classifyTurn, jevMode } from "./typesafe.ts";
import { ChatMessage, ThinkingLevel } from "@lifediary/shared";
import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { agentChat } from "./openai-compat-agent-chat.ts";

type PlainMessage = { role: ChatMessage["role"]; content: string };

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

function conversationIdFor(
	rawHeader: string | undefined,
	messages: PlainMessage[],
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

		const messages: PlainMessage[] = body.messages
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
			// 2026-11-10 批 27 §二.1：正文改由注入框架取（`taskMemoryProvider`），内容逐字节不变。
			const memory =
				task.memory === "diary"
					? collectInjections([taskMemoryProvider], { conversationId: 0 }).system[0]?.text ?? ""
					: "";
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

async function decideMode(
	header: string | undefined,
	conversationId: string,
	internalId: number,
	current: ThinkingLevel | null,
	messages: PlainMessage[],
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

function levelFromHeader(header: string | undefined): ThinkingLevel | null {
	const value = header?.trim().toLowerCase();
	if (value === "off" || value === "low" || value === "medium" || value === "high") return value;
	if (value === "fast") return "off";
	if (value === "deep") return "high";
	return null;
}

function observeRoute(conversationId: string, messages: PlainMessage[]): void {
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

interface TaskContext {
	/** 日志/留痕用：`weekly@weekly_report_v3` */
	label: string;
	/** 渲染完成的整份 prompt（作为 system 段持久化到会话） */
	prompt: string;
}

export { UPSTREAM_ERROR_TEXT, contentOfChunk, conversationIdFor, decideMode, levelFromHeader, observeRoute, textOf };
export type { OpenAiChatRequest, OpenAiMessage, PlainMessage, TaskContext };
