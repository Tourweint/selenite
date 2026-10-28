import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	ToolTask,
	type Conversation,
	type ConversationView,
	LiveDoc,
	type LiveState,
	type SettledSubmissionRecord,
	type ToolHookCall,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	createMemoryEngine,
	scopeKey,
	type MemoryEngine,
	type MemoryScope,
} from "@lifediary/memory";
import { readLlmConfig } from "./provider.ts";
import { ReminderTask } from "./reminder.ts";
import { createTools } from "./tools.ts";

/**
 * Agent 装配。
 *
 * 这里是整个服务端的重心，换到 durable 之后职责很清晰：
 *
 *   Harness           一个进程一个，持有一份 SQLite 存储
 *   Conversation      一次聊天，历史/压缩/中断恢复都归它
 *   Extension         工具 + 提示词 + 钩子 + 自定义任务的打包单位
 *   watch()           唯一的数据出口 —— SSE 只是把它转成文本增量
 *
 * 我们**不自己维护 transcript、不自己拼消息、不自己做压缩**。
 * 上一版这些全是手写的，还抄了 pi coding-agent 的阈值判断；
 * 现在这些都在 durable 里，而且带 overflow 兜底和崩溃恢复。
 *
 * 跟 pi 的默认行为不一样的两处，都在这里显式写明：
 *   - 工具闸门（beforeTool）：pi 没有权限系统，我们自己挂
 *   - 记忆注入（beforeRequest）+ 记住/回忆/提醒三个工具
 */

const CTX = BACKGROUND_CONTEXT;

const DB_PATH = process.env.AGENT_DB_PATH?.trim() || ".data/agent.sqlite";
/** 工具读写文件的基准目录。默认是服务进程的工作目录 */
const WORKDIR = process.env.AGENT_WORKDIR?.trim() || process.cwd();

/** full = 全部放行；read-only = 只允许读（写文件/跑命令一律拦住） */
const TOOL_POLICY = (process.env.AGENT_TOOL_POLICY?.trim() || "full").toLowerCase();
/** 额外拉黑名单，逗号分隔，例如 "bash,powershell" */
const BLOCKED_TOOLS = new Set(
	(process.env.AGENT_BLOCKED_TOOLS ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean),
);

const WRITE_TOOLS = new Set(["write", "edit", "bash", "powershell"]);

/**
 * 一轮对话最多几个工具回合。
 *
 * 为什么要有：客户端断开之后那一轮还在跑（见 chatStream），
 * 没人看着的时候如果模型陷进"读文件 → 又读文件"的循环，它会一直烧 token，
 * 而没有任何人在场能按下停止。上限是唯一不需要人盯着的兜底。
 *
 * 为什么是自己实现：pi-durable 1.4.0 **没有** `maxTurns`（那是上游 main 里的东西，
 * 还没发版）。所以这里用"数一数这个 run 请求了几次模型"来做等价限制 ——
 * 一次请求 = 一个工具回合。设 0 表示不限。
 */
const MAX_TURNS = (() => {
	const raw = Number(process.env.AGENT_MAX_TURNS ?? 30);
	if (!Number.isFinite(raw) || raw < 0) return 30;
	return Math.floor(raw);
})();

/** 撞上限时给用户看的话 */
export const TURN_LIMIT_MESSAGE = "工具调用已达到上限，请重新发送请求。";

/** 撞上限之后告诉模型的：别再动手了，用人话收尾 */
const TURN_LIMIT_INSTRUCTION =
	`本轮的可用工具调用次数已经用完（上限 ${MAX_TURNS} 次）。` +
	"不要再调用任何工具，直接用已经拿到的信息回答；" +
	"如果信息确实不够，就照实说明缺什么，并请对方重新发送请求。";

/** 每个 run 已经用掉的回合数。key = `会话id:run任务id`，进程内有效 */
const runTurns = new Map<string, number>();
/** 撞过上限的会话 → 自增序号（聊天流靠它判断"这一轮是不是撞了"） */
const limitHits = new Map<number, number>();
/** 撞上限后暂时封掉工具的会话 */
const toolsBlocked = new Set<number>();
/**
 * 撞上限之后还赖着不走的，再给几次机会就硬停。
 *
 * 正常模型收到"别再调工具了"就会收尾；但万一它不听（或者 provider 抽风），
 * 光是"工具被拦住"还不够——它仍然会一轮一轮地请求模型，照样烧钱。
 * 所以这里必须有一条不依赖模型自觉的出路。
 */
const HARD_STOP_GRACE = 3;
const aborting = new Set<string>();

async function abortRun(conversationId: number): Promise<void> {
	try {
		const harness = await getHarness();
		const conversation = await harness.conversation(conversationId as never, CTX);
		await conversation?.abort(CTX);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[agent] 硬停会话 ${conversationId} 失败: ${detail}`);
	}
}

const PERSONA = [
	"你是一个个人助手，和一个具体的人长期相处。记录生活是你们最常一起做的事，",
	"但对方提出别的要求（查东西、整理、动手做事）时也要正常帮忙。",
	"回答简短、自然、有温度，不要客套和说教。",
	"需要长期记住的事用 remember；想不起对方说过什么用 recall；要定时提醒用 set_reminder。",
].join("");

// ── 记忆 ─────────────────────────────────────────────────
export const memoryEngine: MemoryEngine | null = (() => {
	if (process.env.MEMORY_ENABLED === "false") return null;
	try {
		return createMemoryEngine({ dbPath: process.env.MEMORY_DB_PATH });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`记忆库初始化失败，本次以无记忆运行: ${detail}`);
		return null;
	}
})();

/**
 * 记忆作用域跟着**内部会话 id** 走。
 *
 * 它是存储自己发的、重开进程也不变，所以作用域稳定。
 * 对外暴露的 conversationId 是另一个东西（下面 Chats 里的 uuid），
 * 用它会把"客户端标识"和"存储主键"绑在一起，以后换实现就麻烦了。
 */
function scopeOf(conversationId: number): MemoryScope {
	return { type: "session", id: String(conversationId) };
}

/** 召回失败绝不能让对话失败，所以一律吞掉并降级为空上下文。 */
function recallContext(conversationId: number, text: string): string {
	if (!memoryEngine || !text.trim()) return "";
	try {
		return memoryEngine.buildContext({
			text,
			scopes: ["global", scopeKey(scopeOf(conversationId))],
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`记忆召回失败，本轮不使用记忆: ${detail}`);
		return "";
	}
}

// ── 对外会话 id ↔ 内部会话 id ────────────────────────────
/**
 * durable 的会话 id 是存储自增的整数，猜得到。
 * 所以对外的 id 仍是服务端生成的 uuid，存在这个 session 文档里做映射 ——
 * "id 不可猜"这条性质必须保住，否则谁都能编一个数字去读别人的历史。
 */
const Chats = defineDoc<{ byExternal: Record<string, number> }>({
	kind: "lifediary.chats",
	version: 1,
	scope: "session",
	initial: () => ({ byExternal: {} }),
	checkpointWhen: () => false,
});

// ── 装配 ─────────────────────────────────────────────────
let opening: Promise<Harness> | null = null;

export function getHarness(): Promise<Harness> {
	opening ??= openHarness();
	return opening;
}

async function openHarness(): Promise<Harness> {
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置：设 LLM_API_KEY 之后再启动");

	mkdirSync(dirname(DB_PATH), { recursive: true });
	const storage = await openNodeSqliteStorage(DB_PATH);

	const registry = createRegistry();
	// pi 自带的那套读写改跑命令：走执行环境，比我们自己写的完整
	registry.install(CodingTools);
	registry.install(
		defineExtension({
			name: "lifediary",
			tools: createTools({ memory: memoryEngine, scopeOf }),
			sections: [{ key: "persona", render: () => PERSONA }],
			hooks: [
				// 权限闸门：pi 本身不带，这是唯一能拦下工具调用的地方
				hook(ToolTask, {
					beforeTool: (call: ToolHookCall, api) => {
						if (toolsBlocked.has(api.conversationId)) {
							return { block: "本轮工具调用已达上限，请直接用已有信息回答" };
						}
						if (BLOCKED_TOOLS.has(call.name)) {
							return { block: `工具 ${call.name} 已被配置禁用` };
						}
						if (TOOL_POLICY === "read-only" && WRITE_TOOLS.has(call.name)) {
							return { block: "当前是只读模式（AGENT_TOOL_POLICY=read-only）" };
						}
						return undefined;
					},
				}),
				// 每次请求前：注入记忆 + 数这是本轮的第几个工具回合
				hook(GenerationTask, {
					beforeRequest: async (request, api, ctx) => {
						const extra: { role: "system"; content: string; timestamp: number }[] = [];

						const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
						const memory = recallContext(
							api.conversationId,
							lastUser ? contentText(lastUser.content) : "",
						);
						if (memory) {
							extra.push({ role: "system", content: memory, timestamp: Date.now() });
						}

						// 一次模型请求 = 一个工具回合。run 一换，预算就重新算。
						//
						// 拿 `run.inputs[0]` 当 run 身份：run.taskId 每一轮都会变
						// （每一轮是一个新的 generation 任务），用它计数永远归零，
						// 上限就形同虚设 —— 这个坑是实测踩出来的。
						const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
						const runId = live?.run?.inputs?.[0] ?? live?.run?.taskId;
						const key = `${api.conversationId}:${String(runId ?? "none")}`;
						const used = (runTurns.get(key) ?? 0) + 1;
						runTurns.set(key, used);

						if (MAX_TURNS > 0 && used > MAX_TURNS) {
							toolsBlocked.add(api.conversationId);
							limitHits.set(api.conversationId, (limitHits.get(api.conversationId) ?? 0) + 1);
							extra.push({
								role: "system",
								content: TURN_LIMIT_INSTRUCTION,
								timestamp: Date.now(),
							});
							console.warn(
								`[agent] 会话 ${api.conversationId}（run ${String(live?.run?.taskId)}）工具回合达上限 ${MAX_TURNS}`,
							);
							if (used > MAX_TURNS + HARD_STOP_GRACE && !aborting.has(key)) {
								aborting.add(key);
								console.warn(`[agent] 会话 ${api.conversationId} 无视上限，硬停这一轮`);
								void abortRun(api.conversationId);
							}
						} else if (used === 1) {
							// 新的一轮，把上一轮封掉的工具放开
							toolsBlocked.delete(api.conversationId);
						}

						if (extra.length === 0) return undefined;
						return { messages: [...extra, ...request.messages] };
					},
				}),
			],
			tasks: [ReminderTask],
		}),
	);

	const harness = await Harness.open(
		storage,
		{
			models: config.models,
			registry,
			// 每个会话的执行环境：cwd 跟着会话走，以后要多目录也改这里
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? WORKDIR }),
			onReport: (error, info) => {
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[agent] ${info.type}: ${detail}`);
			},
		},
		CTX,
	);

	// 上次进程没跑完的活（包括睡着的提醒）接着跑
	harness.resume();
	return harness;
}

export interface ResolvedChat {
	conversation: Conversation;
	/** 对外 id，客户端存的是这个 */
	externalId: string;
	/** 存储内部 id，记忆作用域用它（稳定，且不对客户端暴露） */
	internalId: number;
}

/**
 * 解析会话。`externalId` 为空表示新建。
 * 返回 null 表示"这个 id 我没发过" —— 调用方据此回 404，而不是偷偷建一个新的。
 */
export async function openChat(externalId: string | undefined): Promise<ResolvedChat | null> {
	const harness = await getHarness();
	const config = readLlmConfig();
	if (!config) return null;

	if (!externalId) {
		const id = crypto.randomUUID();
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: config.model },
				// 建会话和写映射在同一个提交里，不会出现"会话建好了但映射没写上"
				init: async (tx, conversationId) => {
					const chats = await tx.doc(Chats);
					chats.byExternal[id] = Number(conversationId);
				},
			},
			CTX,
		);
		return { conversation, externalId: id, internalId: Number(conversation.id) };
	}

	const chats = await harness.snapshot(Chats, CTX);
	const internalId = chats?.byExternal?.[externalId];
	if (internalId === undefined) return null;

	const conversation = await harness.conversation(internalId as never, CTX);
	return conversation ? { conversation, externalId, internalId } : null;
}

/**
 * 有就打开，没有就用这个 id 新建。
 *
 * 只给 OpenAI 兼容端点用：那边的会话 id 是从首条用户消息哈希出来的，
 * 客户端从没收到过服务端发 id，所以只能"第一次自动建"。
 * `/api/v1/agent/chat` 不走这条，它必须严格要求 id 是发出去的。
 */
export async function openOrCreateChat(externalId: string): Promise<ResolvedChat> {
	const existing = await openChat(externalId);
	if (existing) return existing;

	const harness = await getHarness();
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置");

	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: config.model },
			init: async (tx, conversationId) => {
				const chats = await tx.doc(Chats);
				chats.byExternal[externalId] = Number(conversationId);
			},
		},
		CTX,
	);
	return { conversation, externalId, internalId: Number(conversation.id) };
}

// ── 对话流 ───────────────────────────────────────────────
/**
 * 流里除了文本，还会有"这一轮没给出回答"的通知。
 * 现在只有一种：工具调用撞上限。以后要是加别的终止原因，往这里加成员。
 */
export type ChatStreamEvent =
	| { type: "delta"; text: string }
	| { type: "turnLimit"; message: string };

export interface ChatStreamInput {
	conversation: Conversation;
	text: string;
	/** 客户端重试时带同一个 requestId，就不会重复扣 token、重复写记忆 */
	requestId?: string;
	/**
	 * 这一轮**真正结束**时回调（不是"这条连接结束"）。
	 *
	 * 关键区别：客户端关掉界面 / 断网，只是没人看这条流了，
	 * 那一轮还在服务端跑；它跑完才该触发记忆抽取、才该算数。
	 * 挂在这个回调上，就不会因为"用户关了个窗口"而漏记一轮对话。
	 */
	onSettled?: (record: SettledSubmissionRecord) => void;
}

/**
 * 把一轮对话变成一段文本流。
 *
 * 数据源是 `watch()`：durable 把"正在生成的那半句话"作为已提交状态的一部分发布出来。
 *
 * 这里**故意不接客户端的中断信号**。以前的写法是"socket 一断就 abort()"，
 * 那是把"传输断了"翻译成"用户要取消"，于是一个跑了一半的工具调用会被掐掉。
 * durable 的语义本来是对的（取消等待 ≠ 取消工作），是我们多接了一根线。
 *
 * 真要停，走 `stopChat()`：那是人的明确意图，不是 socket 的副作用。
 */
export async function* chatStream(
	input: ChatStreamInput,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
	const watch = await input.conversation.watch(CTX);

	const queue: string[] = [];
	let emitted = "";
	let wake: (() => void) | null = null;

	const notify = () => {
		const resume = wake;
		wake = null;
		resume?.();
	};

	/** 只在"新文本是在旧文本后面续上"时才吐增量，避免重试/回退导致重复输出 */
	const offer = (candidate: string) => {
		if (!candidate || candidate.length <= emitted.length) return;
		if (!candidate.startsWith(emitted)) return;
		queue.push(candidate.slice(emitted.length));
		emitted = candidate;
		notify();
	};

	const partialOf = (value: ConversationView): string => {
		const live = value.docs["pi.live"] as LiveState | undefined;
		const message = live?.generation?.message as { content?: unknown } | undefined;
		if (!message?.content) return "";
		return contentText(message.content as Parameters<typeof contentText>[0]);
	};

	// 用对象包着：闭包里赋值，TS 的收窄判断看不到
	const outcome: { record?: SettledSubmissionRecord; error?: Error } = {};
	let finished = false;
	// 这一轮开始前记一次；跑完对比，就知道期间有没有撞工具上限
	const conversationId = Number(input.conversation.id);
	const limitSeqBefore = limitHits.get(conversationId) ?? 0;

	try {
		watch.start(async (value) => {
			offer(partialOf(value));
		});
		offer(partialOf(watch.value));

		const submission = await input.conversation.submit(
			{ type: "input", content: input.text, requestId: input.requestId },
			CTX,
		);

		void submission
			.wait(CTX)
			.then((record) => {
				outcome.record = record;
				// 这一轮尘埃落定：即便上面的流早被客户端关掉了，这里照样会跑
				try {
					input.onSettled?.(record);
				} catch (error) {
					console.warn(
						`[agent] onSettled 回调失败: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			})
			.catch((error: unknown) => {
				outcome.error = error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				finished = true;
				notify();
			});

		while (!finished || queue.length > 0) {
			if (queue.length === 0) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			const delta = queue.shift();
			if (delta) yield { type: "delta", text: delta };
		}

		if (outcome.error) throw outcome.error;

		// 收尾：流式增量可能停在半句（节流或直接给了完整 answer），把尾巴补齐
		if (outcome.record?.status === "done") {
			offer(await answerText(input.conversation));
			while (queue.length > 0) {
				const delta = queue.shift();
				if (delta) yield { type: "delta", text: delta };
			}
		} else if (outcome.record?.status === "unanswered") {
			console.warn(
				`[agent] 本轮未回答: ${outcome.record.reason} ${JSON.stringify(outcome.record.detail ?? null)}`,
			);
		}

		// 撞了工具上限：不管模型最后有没有收尾，这句提示都由我们补，
		// 保证用户看到的措辞跟配置一致，而不是模型自己发挥的版本。
		if ((limitHits.get(conversationId) ?? 0) > limitSeqBefore) {
			yield { type: "turnLimit", message: TURN_LIMIT_MESSAGE };
		}
	} finally {
		// 只关掉"看"这件事，不碰正在跑的那一轮
		await watch.stop().catch(() => undefined);
	}
}

/**
 * 手动停止当前这一轮。
 *
 * 跟"客户端断开"是两件事：这是人的明确意图，所以走 `abort()`，
 * 排队的输入会撤回、当前的任务会被撤销。之后再说一句话就是新一轮。
 */
export async function stopChat(chat: ResolvedChat): Promise<void> {
	await chat.conversation.abort(CTX);
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
	/** 消息时间，epoch 毫秒 */
	at: number;
}

/**
 * 读会话已有的对话记录。
 *
 * 存在的理由：一轮对话现在可以在**没有客户端看着**的情况下跑完（见 chatStream），
 * 所以客户端下次打开必须能把结果拉回来，否则"关掉界面它照样跑完"对用户没有意义。
 * 只取模型看得见的那部分（用户说了什么、模型答了什么），工具调用细节不在这里。
 */
export async function readTranscript(
	chat: ResolvedChat,
	limit = 50,
): Promise<TranscriptMessage[]> {
	const view = await chat.conversation.context(CTX);
	const messages: TranscriptMessage[] = [];

	for (const entry of view.entries) {
		if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0];
		if (!message) continue;
		const text = contentText(message.content).trim();
		if (!text) continue;
		messages.push({
			role: entry.kind === "pi.user" ? "user" : "assistant",
			text,
			at: typeof message.timestamp === "number" ? message.timestamp : 0,
		});
	}

	return limit > 0 ? messages.slice(-limit) : messages;
}

/** 最后一轮模型回答的纯文本（用于补齐流式没吐完的部分） */
async function answerText(conversation: Conversation): Promise<string> {
	const view = await conversation.context(CTX);
	for (let index = view.entries.length - 1; index >= 0; index -= 1) {
		const entry = view.entries[index];
		if (!entry || entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0];
		if (message) return contentText(message.content);
	}
	return "";
}

// ── 会话旁路能力 ─────────────────────────────────────────
export interface UsageSummary {
	models: {
		model: string;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	}[];
}

export async function usageSummary(): Promise<UsageSummary> {
	const harness = await getHarness();
	const state = await harness.usage(CTX);
	return {
		models: Object.entries(state.models).map(([model, usage]) => ({
			model,
			inputTokens: usage.input ?? 0,
			outputTokens: usage.output ?? 0,
			totalTokens: usage.totalTokens ?? 0,
		})),
	};
}

export interface ReminderSummary {
	id: number;
	status: "pending" | "running" | "waiting" | "sleeping" | "completing" | "terminal";
	text: string;
	at: number;
	until?: number;
	conversationId: number;
}

/** 还没响的提醒（直接读 durable 的任务图，不另存一份） */
export async function listReminders(): Promise<ReminderSummary[]> {
	const harness = await getHarness();
	const inspection = await harness.inspect(CTX);
	return inspection.tasks
		.filter((task) => task.record.kind === ReminderTask.definition.name)
		.map((task) => {
			const record = task.record as unknown as {
				id: number;
				input: { text: string; at: number };
				conversationId: number;
			};
			return {
				id: record.id,
				status: task.state.kind === "sleeping" ? "sleeping" : task.state.kind === "blocked" ? "terminal" : "pending",
				text: record.input.text,
				at: record.input.at,
				...(task.state.kind === "sleeping" ? { until: task.state.until } : {}),
				conversationId: record.conversationId,
			};
		});
}

/** 主动加一个提醒（HTTP 端调用；Agent 自己加走 set_reminder 工具） */
export async function addReminder(
	chat: ResolvedChat,
	input: { text: string; at: number },
): Promise<number> {
	const id = await chat.conversation.commit(
		(tx) =>
			tx.createTask(ReminderTask, input, { ownership: { kind: "conversation" } }),
		CTX,
	);
	return Number(id);
}
