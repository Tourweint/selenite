import {
	AgentHarness,
	calculateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	JsonlSessionRepo,
	NodeExecutionEnv,
	shouldCompact,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ChatMessage } from "@lifediary/shared";

/**
 * 对话跑在 **pi 自己的会话流程** 上：
 *
 *   NodeExecutionEnv  → 执行环境（文件、进程）
 *   JsonlSessionRepo  → 会话存成 jsonl，历史天然可恢复
 *   AgentHarness      → 一轮对话、事件、压缩、分支
 *
 * 这里不再自己维护 transcript、不再自己拼消息数组。
 * 服务端只做三件事：把用户的一句话交给 harness、把 harness 的事件转成 SSE、
 * 在 systemPrompt 里塞进记忆。
 *
 * 之前那版用内存 Map<conversationId, Agent>，重启即丢 ——
 * 那是自找的，pi 本来就把历史落盘。
 */

export interface LlmRuntime {
	/** 用 Model<any> 而不是具体 api 类型：测试时可以塞 faux 模型进来 */
	model: Model<any>;
	apiKey: string;
}

/**
 * 密钥只从环境变量来，绝不进代码、不进库、不下发给 App。
 * 返回 null 表示未配置 —— 此时走 mock，链路照样能验证。
 */
export function readLlmConfig(): LlmRuntime | null {
	const apiKey = process.env.LLM_API_KEY?.trim();
	if (!apiKey) return null;

	const modelId = process.env.LLM_MODEL?.trim() || "qwen-plus";
	const baseUrl = (
		process.env.LLM_BASE_URL?.trim() ||
		"https://dashscope.aliyuncs.com/compatible-mode/v1"
	).replace(/\/+$/, "");

	return {
		apiKey,
		// 手工构造 Model：pi 内置模型表里没有百炼，但只要是 OpenAI 兼容端点，
		// 换 baseUrl + 指定 api="openai-completions" 就能复用同一套实现。
		model: {
			id: modelId,
			name: modelId,
			api: "openai-completions",
			provider: "openai",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 4096,
		},
	};
}

const CWD = process.cwd();
const SESSIONS_ROOT = process.env.SESSION_DIR?.trim() || ".data/sessions";

const env = new NodeExecutionEnv({ cwd: CWD });
const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: SESSIONS_ROOT });

interface SessionEntry {
	harness: AgentHarness;
	/** systemPrompt 是函数形式，每轮都会重新求值 —— 记忆就挂在这儿 */
	setSystemPrompt(prompt: string): void;
}

const liveSessions = new Map<string, SessionEntry>();

async function getSession(
	conversationId: string,
	runtime: LlmRuntime,
): Promise<SessionEntry> {
	const cached = liveSessions.get(conversationId);
	if (cached) return cached;

	// 先看磁盘上有没有这个会话；有就恢复，没有才新建。
	const metas = await repo.list({ cwd: CWD });
	const existing = metas.find((meta) => meta.id === conversationId);
	const session = existing
		? await repo.open(existing)
		: await repo.create({ cwd: CWD, id: conversationId });

	const holder = { systemPrompt: "" };

	const harness = new AgentHarness({
		env,
		session,
		model: runtime.model,
		// 传函数而不是字符串：每轮开始时重新求值，记忆变化能立刻生效
		systemPrompt: () => holder.systemPrompt,
		getApiKeyAndHeaders: async () => ({ apiKey: runtime.apiKey }),
	});

	const entry: SessionEntry = {
		harness,
		setSystemPrompt: (prompt) => {
			holder.systemPrompt = prompt;
		},
	};
	liveSessions.set(conversationId, entry);
	return entry;
}

export interface StreamOptionsInput {
	messages: ChatMessage[];
	conversationId: string;
	/** 记忆等外部注入的上下文，拼进 systemPrompt 最前面 */
	systemContext?: string;
	signal: AbortSignal;
}

export async function* streamChat(
	input: StreamOptionsInput,
): AsyncGenerator<string, void, unknown> {
	const runtime = readLlmConfig();
	if (!runtime) {
		yield* mockStream(input.messages, input.signal);
		return;
	}
	yield* harnessStream(runtime, input);
}

/** 未配置 key 时的回显流：证明 SSE 通路、首字节时机、中止行为都正常。 */
async function* mockStream(
	messages: ChatMessage[],
	signal: AbortSignal,
): AsyncGenerator<string, void, unknown> {
	const last = messages.at(-1)?.content ?? "";
	const reply =
		`（mock 模式，未配置 LLM_API_KEY）链路已通。你说的是：「${last}」。` +
		`配置 LLM_API_KEY 后这里会换成真实模型输出。`;

	for (const char of reply) {
		if (signal.aborted) return;
		await sleep(18);
		yield char;
	}
}

/** 导出是为了让 probe 能用假模型验证事件桥接（生产路径只走 streamChat） */
export async function* harnessStream(
	runtime: LlmRuntime,
	input: StreamOptionsInput,
): AsyncGenerator<string, void, unknown> {
	const systemPrompt = [
		"你是一个个人助手，和一个具体的人长期相处。记录生活是你们最常一起做的事，" +
			"但对方提出别的要求（查东西、整理、动手做事）时也要正常帮忙。" +
			"回答简短、自然、有温度，不要客套和说教。",
		input.systemContext,
		...input.messages.filter((m) => m.role === "system").map((m) => m.content),
	]
		.filter((part): part is string => Boolean(part?.trim()))
		.join("\n\n");

	const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
	if (!lastUser) return;

	const entry = await getSession(input.conversationId, runtime);
	entry.setSystemPrompt(systemPrompt);

	const abortOnSignal = () => void entry.harness.abort();
	input.signal.addEventListener("abort", abortOnSignal, { once: true });

	// harness 是事件驱动的，这里把事件桥成异步生成器 —— 上层只关心"吐文本"。
	const queue: string[] = [];
	let finished = false;
	let failure: Error | null = null;
	let wake: (() => void) | null = null;

	const notify = () => {
		const fn = wake;
		wake = null;
		fn?.();
	};

	const unsubscribe = entry.harness.subscribe((event) => {
		const assistantEvent = (event as {
			type: string;
			assistantMessageEvent?: { type: string; delta?: string };
		}).assistantMessageEvent;
		if (
			event.type === "message_update" &&
			assistantEvent?.type === "text_delta" &&
			assistantEvent.delta
		) {
			queue.push(assistantEvent.delta);
			notify();
		}
	});

	let assistantMessage: AssistantMessage | null = null;

	void entry.harness
		.prompt(lastUser.content)
		.then((message) => {
			assistantMessage = message;
		})
		.catch((error: unknown) => {
			failure = error instanceof Error ? error : new Error(String(error));
		})
		.finally(() => {
			finished = true;
			notify();
		});

	try {
		while (!finished || queue.length > 0) {
			if (queue.length === 0) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			const delta = queue.shift();
			if (delta) yield delta;
		}
		if (failure) throw failure;
	} finally {
		input.signal.removeEventListener("abort", abortOnSignal);
		unsubscribe();

		// 上下文快满了就压。刻意不 await：压缩要额外调一次 LLM，
		// 不该让用户在这儿等；失败也只是这轮不压，不影响对话本身。
		if (assistantMessage) {
			void maybeCompact(entry.harness, runtime.model, assistantMessage);
		}
	}
}

/**
 * 上下文压缩的触发条件 —— 这段逻辑抄自 pi 的 coding-agent
 * （`core/agent-session.ts` 的 `_checkCompaction`），因为它不在 core 里。
 *
 * 简化掉的部分：
 *   - overflow 兜底（请求超窗 → 压缩 → 自动重试）：需要错误分类，后面再补
 *   - 模型切换检测、压缩边界的时序判断
 *
 * 保留的核心是那一行：`shouldCompact(tokens, contextWindow, settings)`。
 */
async function maybeCompact(
	harness: AgentHarness,
	model: Model<any>,
	assistantMessage: AssistantMessage,
): Promise<void> {
	try {
		if (assistantMessage.stopReason === "aborted") return;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const contextTokens = calculateContextTokens(assistantMessage.usage);
		if (!shouldCompact(contextTokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;

		await harness.waitForIdle();
		const result = await harness.compact();
		// 只记规模，不记摘要内容
		console.log(
			`[compaction] ${contextTokens} → ${result.tokensBefore} tokens（摘要 ${result.summary.length} 字）`,
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[compaction] 本次跳过: ${detail}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
