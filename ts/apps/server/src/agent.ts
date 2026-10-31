import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
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
	type Extension,
	type HookApi,
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
import { diaryStore } from "./diary.ts";
import { chatModelRef, readLlmConfig } from "./provider.ts";
import { ReminderTask } from "./reminder.ts";
import { createSkillStore, type SkillStore } from "./skills.ts";
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
 * 一轮对话最多几个工具回合。默认 100（实测 30 偏紧，hermes 那类给到 300）。
 *
 * 定 100 的取舍：这个数字是"一次提问里，模型最多能来回几次"。
 * 日常记录、查资料用不到 10 轮；真要做"整理一整个目录"这种活，
 * 30 会半路截断，100 基本够；再高就要开始担心一次对话跑十几分钟没人管。
 * 撞到上限不是死路——用户再发一句就是新一轮、预算重算。
 *
 * 为什么要有：客户端断开之后那一轮还在跑（见 chatStream），
 * 没人看着的时候如果模型陷进"读文件 → 又读文件"的循环，它会一直烧 token，
 * 而没有任何人在场能按下停止。上限是唯一不需要人盯着的兜底。
 *
 * 为什么是自己实现：pi-durable 1.4.0 **没有** `maxTurns`（那是上游 main 里的东西，
 * 还没发版）。所以这里用"数一数这个 run 请求了几次模型"来做等价限制 ——
 * 一次请求 = 一个工具回合。设 0 表示不限。
 *
 * TODO(pi-durable)：等用的版本带上 `maxTurns` 之后，这一整套可以整段删掉。
 * 要删的地方一共四处：
 *   1. MAX_TURNS / TURN_LIMIT_* / runTurns / limitHits / toolsBlocked / aborting 这些常量和状态
 *   2. beforeTool 里开头那个 `toolsBlocked.has(...)` 分支
 *   3. beforeRequest 里"数回合 + 撞上限"那段（记忆注入要留着）
 *   4. chatStream 结尾那个 `limitHits` 比较 + `turnLimit` 事件
 * 然后把 `agent: { model }` 改成 `agent: { model, maxTurns: 30 }` 即可。
 * 换句话说：这不是一个要长期维护的机制，是一次性的补丁。
 */
const MAX_TURNS = (() => {
	const raw = Number(process.env.AGENT_MAX_TURNS ?? 100);
	if (!Number.isFinite(raw) || raw < 0) return 100;
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
	// 2026-10-29 需求方定的硬约束：这条同时是"该动手时一定动手"的兜底 ——
	// 快档模型若为了省事直接编，用户会拿到假信息，比慢一点更糟。
	"凡是涉及真实文件、真实数据、真实日程或当前时间的事，必须先用工具去看，不许凭印象回答或编造；",
	"看不到就说看不到，并说明缺什么。闲聊和感受不需要调工具。",
	"记忆只在确有必要时检索（对方提到过去的事、需要接上以前的话），别每句都查。",
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

// ── 技能 ─────────────────────────────────────────────────
/** 技能目录：默认跟着代码走（apps/server/skills/），可用 AGENT_SKILLS_DIR 换 */
const SKILLS_DIR =
	process.env.AGENT_SKILLS_DIR?.trim() || fileURLToPath(new URL("../skills", import.meta.url));

export const skillStore: SkillStore | null = (() => {
	try {
		return createSkillStore(SKILLS_DIR);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`技能目录加载失败，本次无技能可用: ${detail}`);
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

/**
 * 任务会话的"近况记忆"块（2026-10-31，记忆方案 §3 的 B 路 + §4 注入例外）。
 *
 * 给**需要知道最近记了什么**的任务用（目前只有 `question` / `diary_review`）：
 * 数据源是日记镜像（`diary.sqlite` 近 N 天 `CONFIRMED`），不经过 App——
 * App 不再拼画像/近况（它是两处真相的源头，见方案 D7）。
 *
 * 位置：**拼在 instructions 的尾部**。这样模板那一大段前缀不变，缓存照旧命中，
 * 只有"近况"这一小段是新的（§2.3 实测：尾部追加不破坏前缀）。
 */
export function taskMemoryBlock(days = 3, limit = 12): string {
	try {
		const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
		const entries = diaryStore().recent(since, limit);
		if (entries.length === 0) return "";
		const lines = entries
			.filter((entry) => (entry.finalText ?? "").trim().length > 0)
			.map((entry) => {
				const text = String(entry.finalText).replace(/\s+/g, " ").trim().slice(0, 120);
				return `- ${entry.entryDate ?? "（无日期）"}：${text}`;
			});
		if (lines.length === 0) return "";
		return [
			"<memory>",
			`最近 ${days} 天你自己记下的（只作参考：可以呼应，不要逐条复述，也不要评价记多记少）：`,
			...lines,
			"</memory>",
		].join("\n");
	} catch (error) {
		// 记忆读失败绝不能让任务失败（日记镜像可能还没建库）
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 近况读取失败，本次不注入: ${detail}`);
		return "";
	}
}

// ── 对外会话 id ↔ 内部会话 id ────────────────────────────
/**
 * durable 的会话 id 是存储自增的整数，猜得到。
 * 所以对外的 id 仍是服务端生成的 uuid，存在这个 session 文档里做映射 ——
 * "id 不可猜"这条性质必须保住，否则谁都能编一个数字去读别人的历史。
 */
/**
 * 任务会话的 id 前缀（2026-10-31，与 `openai-compat.ts` 的 `X-Task` 通道约定）。
 *
 * 定义在这里是因为 `listChats` 要用它过滤——任务会话不该出现在"历史对话"列表里：
 * 它们的首句是"请整理成稿"这种**指令**，不是用户说过的话，混进列表只会让人莫名其妙。
 * 正文照旧能按 id 回读（`GET /api/v1/agent/chat/:id/messages`），只是不露头。
 */
export const TASK_CONVERSATION_PREFIX = "task-";

const Chats = defineDoc<{ byExternal: Record<string, number> }>({
	kind: "lifediary.chats",
	version: 1,
	scope: "session",
	initial: () => ({ byExternal: {} }),
	checkpointWhen: () => false,
});

// ── 装配 ─────────────────────────────────────────────────
let opening: Promise<Harness> | null = null;

/**
 * 我们自己的扩展（人格 + 技能索引 + 工具 + 钩子）。
 *
 * 提到模块作用域是为了**任务会话能把它摘掉**：日记任务（收敛/周报/分段…）不需要人格、
 * 不需要技能、不需要记忆注入、也不该有工具（它只产出文本），见 `configureTaskChat`。
 */
let lifediaryExt: Extension | null = null;

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
		(lifediaryExt = defineExtension({
			name: "lifediary",
			tools: createTools({ memory: memoryEngine, scopeOf, skills: skillStore }),
			sections: [
				{ key: "persona", render: () => PERSONA },
				// L1 技能索引（2026-10-31 方案 D5）：排在 persona 后（"会话后部"），按会话冻结——
				// 首轮渲染后技能目录再变也不改写本会话，否则 durable 会追加新 pi.system、缓存前缀整段作废。
				// 没有技能时 render 返回 undefined，整个 section 省略。
				{
					key: "skills",
					render: (input) => skillStore?.indexFor(Number(input.conversationId)),
				},
			],
			hooks: [
				// 权限闸门：pi 本身不带，这是唯一能拦下工具调用的地方
				hook(ToolTask, {
					beforeTool: async (call: ToolHookCall, api, context) => {
						if (toolsBlocked.has(api.conversationId)) {
							return { block: "本轮工具调用已达上限，请直接用已有信息回答" };
						}
						if (BLOCKED_TOOLS.has(call.name)) {
							return { block: `工具 ${call.name} 已被配置禁用` };
						}
						if (TOOL_POLICY === "read-only" && WRITE_TOOLS.has(call.name)) {
							return { block: "当前是只读模式（AGENT_TOOL_POLICY=read-only）" };
						}
						// 告诉客户端"现在开始动手了"（工具可能跑几十秒，界面上不能一直空白）
						emitPhase(api.conversationId, "working");
						// 首次动工具时按 D3 切一次思考档（短会话才切，切了就保持）
						await switchThinkingOnTool(api, context);
						return undefined;
					},
					// 工具跑完、把结果交回模型 → 又回到"在思考"
					afterTool: (_call: ToolHookCall, _result, api) => {
						emitPhase(api.conversationId, "thinking");
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
		})),
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

export type ChatMode = "fast" | "deep";

/**
 * 本轮的思考档（2026-10-31，方案 D1/D2）。
 *
 * 快档与深档是**同一个模型**（换模型 = 上游缓存清零，方案 §2.2 实测），
 * 区别只剩 `enable_thinking`：fast = 思考关（首字 0.8~0.9s），deep = 思考开。
 * 切档 = 请求头块变化 = 当前前缀整段重算（方案 §2.3），所以默认**按会话定档、中途不切**；
 * 唯一例外是 D3 的"短会话首次调工具切一次"，在工具钩子里做（见 switchThinkingOnTool）。
 */
export async function applyChatMode(chat: ResolvedChat, mode: ChatMode): Promise<void> {
	const config = readLlmConfig();
	if (!config) return;
	// 切过思考开的会话不再回快档：D3 允许"切一次"，切了就保持（不然下一条消息又抖回去）
	if (mode === "fast" && thinkingSwitched.has(chat.internalId)) return;
	const target = chatModelRef(mode === "deep");
	const agent = await chat.conversation.agent(CTX);
	if (agent.model?.modelId === target.modelId) return;
	await chat.conversation.configure({ model: target }, CTX);
	console.log(
		`[agent] 会话 ${chat.internalId} 档位 → ${mode === "deep" ? "思考开" : "思考关"}（${target.modelId}）`,
	);
}

/**
 * 把会话配成**任务会话**（2026-10-30，模板上移）。
 *
 * 三件事，缺一件输出就跑偏：
 * 1. `instructions` = 服务端渲染好的任务模板。它是 system 段（排在扩展段之后），
 *    durable 会持久化它 —— 进程重启后任务会话照样拿着同一份 prompt；
 * 2. `extensions.remove` 摘掉我们自己的扩展：任务不需要人格、不该注入记忆
 *    （收敛把记忆当事实写进草稿是真出过的事故，见日记收敛与记忆 §4），也不需要提醒工具；
 * 3. `tools: []` 关掉 pi 自带的读写改跑：任务只产出文本，让它能改文件是纯粹的意外来源。
 *
 * `model` 传派生模型引用（带 temperature / max_tokens / response_format），
 * 不传就沿用会话原档（快档）。
 */
export async function configureTaskChat(
	chat: ResolvedChat,
	prompt: string,
	model?: { provider: string; modelId: string },
): Promise<void> {
	await chat.conversation.configure(
		{
			instructions: prompt,
			tools: [],
			...(lifediaryExt ? { extensions: { remove: [lifediaryExt] } } : {}),
			...(model ? { model } : {}),
		},
		CTX,
	);
}

/**
 * 已切到思考开的会话（2026-10-31，方案 D3：切一次就保持）。
 *
 * 进程内状态；重启后按"还没切"处理 —— 长会话重启后照样会被阈值拒绝，
 * 短会话重启后多付一次重算，可接受（与旧升级链路的进程内记账同款取舍）。
 */
const thinkingSwitched = new Set<number>();
/** 已判定"不切"的长会话：别每次工具调用都重读 usage */
const thinkingRefused = new Set<number>();

/** 这个会话现在是否思考开（openai-compat 的档位粘性用） */
export function isThinkingOn(internalId: number): boolean {
	return thinkingSwitched.has(internalId);
}

/** 一轮里的两个可见阶段：在想 / 在动手（工具执行中） */
export type TurnPhase = "thinking" | "working";

/** 每个会话的"当前阶段"订阅者（由 chatStream 注册，工具钩子往里推） */
const phaseSinks = new Map<number, Set<(phase: TurnPhase) => void>>();

export function watchPhase(
	conversationId: number,
	sink: (phase: TurnPhase) => void,
): () => void {
	let set = phaseSinks.get(conversationId);
	if (!set) {
		set = new Set();
		phaseSinks.set(conversationId, set);
	}
	set.add(sink);
	return () => {
		set.delete(sink);
		if (set.size === 0) phaseSinks.delete(conversationId);
	};
}

function emitPhase(conversationId: number, phase: TurnPhase): void {
	const set = phaseSinks.get(conversationId);
	if (!set) return;
	for (const sink of set) {
		try {
			sink(phase);
		} catch {
			/* 订阅方异常不该影响工具执行 */
		}
	}
}

/** 短会话阈值（方案 D3 定 4000；风险表留了 4k→8k 的放宽口子，用环境变量调，不改代码） */
function thinkingTokenLimit(): number {
	const raw = Number(process.env.AGENT_THINK_TOKEN_LIMIT);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4000;
}

/**
 * 该会话上一轮的 prompt 规模（方案 D3a 的测量口径）。
 *
 * AssistantMessage.usage.input 就是那一轮的真实重算量（≈当前前缀大小）；
 * 没有任何带 usage 的 assistant 条目（首轮还没跑完过）→ 返回 null，按 D3a 视为短会话。
 */
async function lastTurnInputTokens(
	conversation: Conversation,
	context: Context,
): Promise<number | null> {
	const view = await conversation.context(context);
	for (let index = view.entries.length - 1; index >= 0; index -= 1) {
		const entry = view.entries[index];
		if (!entry || entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0] as { usage?: { input?: number } } | undefined;
		if (message && typeof message.usage?.input === "number") return message.usage.input;
	}
	return null;
}

/**
 * 工具第一次被调用时把该会话切到思考开（2026-10-31，方案 D2/D3）。
 *
 * 与旧"换模型升级"链路的差别：模型**不换**（D1），只切 `enable_thinking`；
 * 长会话（上一轮 prompt ≥ 阈值）**不切** —— 切一次就是整段前缀重算，长会话付不起；
 * 短会话也只切一次（thinkingSwitched 记账），切了就保持。
 * 为什么在**工具钩子**里切而不是开局预判：预判要额外一次判定（慢且可能判错），
 * 而"模型自己决定调工具"本身就是最准的信号。切换发生在工具结果回来之前，
 * 所以本轮的后续推理就用上了思考档；代价 = 当前前缀重算一次（D3 明码标价）。
 */
async function switchThinkingOnTool(api: HookApi, context: Context): Promise<void> {
	// 已经切过/已判定不切的，不再碰库（每次工具调用都去 configure/读上下文是白付的）
	if (thinkingSwitched.has(api.conversationId) || thinkingRefused.has(api.conversationId)) return;
	// 2026-10-31 命名整改（方案 D11）：这个名字以前叫 AGENT_TOOL_UPGRADE，
	// 语义是"升级到更贵的模型"，会把读代码的人（包括我自己）带偏成"换模型"；
	// 现在快深同款，它做的是"把思考打开"。旧名保留为兼容回退，下一轮删。
	if (((process.env.AGENT_THINK_ON_TOOL ?? process.env.AGENT_TOOL_UPGRADE) ?? "on").trim().toLowerCase() === "off") {
		return;
	}

	const config = readLlmConfig();
	if (!config) return;

	try {
		const harness = await getHarness();
		const conversation = await harness.conversation(api.conversationId as never, context);
		if (!conversation) return;
		const lastInput = await lastTurnInputTokens(conversation, context);
		const limit = thinkingTokenLimit();
		if (lastInput !== null && lastInput >= limit) {
			thinkingRefused.add(api.conversationId);
			console.log(
				`[agent] 会话 ${api.conversationId} 首次工具调用时 prompt≈${lastInput} ≥ ${limit}，保持思考关（长会话不切，方案 D3）`,
			);
			return;
		}
		const target = chatModelRef(true);
		const agent = await conversation.agent(context);
		if (agent.model?.modelId === target.modelId) {
			thinkingSwitched.add(api.conversationId);
			return;
		}
		await conversation.configure({ model: target }, context);
		thinkingSwitched.add(api.conversationId);
		console.log(
			`[agent] 会话 ${api.conversationId} 首次工具调用 → 思考开（prompt≈${lastInput ?? "首轮"} < ${limit}；本次前缀重算约 ${lastInput ?? "?"} token）`,
		);
	} catch (error) {
		// 切档失败不影响这一轮：大不了这轮继续不思考
		console.warn(
			`[agent] 会话 ${api.conversationId} 切思考档失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * 解析会话。`externalId` 为空表示新建。
 * 返回 null 表示"这个 id 我没发过" —— 调用方据此回 404，而不是偷偷建一个新的。
 */
export async function openChat(
	externalId: string | undefined,
	modelRef?: { provider: string; modelId: string },
): Promise<ResolvedChat | null> {
	const harness = await getHarness();
	const config = readLlmConfig();
	if (!config) return null;

	if (!externalId) {
		const id = crypto.randomUUID();
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				// 新会话默认思考关（2026-10-31 方案 D2：聊天一律不思考，首字 0.8~0.9s）
				agent: { model: modelRef ?? chatModelRef(false) },
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
export async function openOrCreateChat(
	externalId: string,
	modelRef?: { provider: string; modelId: string },
): Promise<ResolvedChat> {
	const existing = await openChat(externalId);
	if (existing) return existing;

	const harness = await getHarness();
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置");

	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: modelRef ?? chatModelRef(false) },
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
	/**
	 * 这一轮此刻在干什么（2026-10-29）。
	 *
	 * 存在的理由：工具回合可能几十秒没有任何 token，客户端只看到"空白"，
	 * 用户不知道是卡死了还是在干活。这里把"思考 / 动手"这一层状态单独告诉客户端，
	 * 让它能显示"正在思考…"「正在读文件…」而不是干等。
	 */
	| { type: "progress"; phase: TurnPhase }
	| { type: "turnLimit"; message: string }
	/**
	 * 这一轮跑完了但没有回答（模型报错、被策略拦下等）。
	 *
	 * 必须显式吐出来：否则客户端只看到"空内容 + 正常结束"，等于给用户一个空气泡，
	 * 而且分不清是"模型没话说"还是"上游挂了"（实测：key 无效时就是这样）。
	 */
	| { type: "unanswered"; message: string };

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
	/** 待推送的阶段变化（工具钩子写进来，本流取出去） */
	const phases: TurnPhase[] = [];
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
	// 订阅本会话的阶段变化：工具一开始执行就能立刻告诉客户端，不用等第一个 token
	const unwatchPhase = watchPhase(conversationId, (phase) => {
		phases.push(phase);
		notify();
	});

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
				// 每轮的 usage/cacheRead 验收数据（方案 §6 步骤 1 / §7）
				void logTurnUsage(input.conversation, conversationId);
			})
			.catch((error: unknown) => {
				outcome.error = error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				finished = true;
				notify();
			});

		while (!finished || queue.length > 0 || phases.length > 0) {
			if (queue.length === 0) {
				const phase = phases.shift();
				if (phase) {
					yield { type: "progress", phase };
					continue;
				}
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
			// 细节只进日志：里面可能带上游原文（含 key 片段）
			console.warn(
				`[agent] 本轮未回答: ${outcome.record.reason} ${JSON.stringify(outcome.record.detail ?? null)}`,
			);
			// 但用户得看到一句话，不能只收到"空回复"
			yield { type: "unanswered", message: "这次没能生成回复，请再试一次。" };
		}

		// 撞了工具上限：不管模型最后有没有收尾，这句提示都由我们补，
		// 保证用户看到的措辞跟配置一致，而不是模型自己发挥的版本。
		if ((limitHits.get(conversationId) ?? 0) > limitSeqBefore) {
			yield { type: "turnLimit", message: TURN_LIMIT_MESSAGE };
		}
	} finally {
		unwatchPhase();
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

/**
 * 每轮打一行 usage 日志（2026-10-31 方案 §6 步骤 1 的"日志打 cacheRead"）。
 *
 * 验收指标（方案 §7）全靠这行：`cacheRead > 0 且 ≥ 首轮 prompt 的 60%`、
 * `工具链每轮增量 < 600 token`，都得从日志里捞。挂在 settle 回调里，
 * 客户端断流也照样打 —— 那一轮在服务端照样跑完。取的是本轮最后一次
 * 模型请求的 usage（多工具回合时，中间回合的增量已被它累计在前缀里）。
 */
async function logTurnUsage(conversation: Conversation, internalId: number): Promise<void> {
	try {
		const view = await conversation.context(CTX);
		for (let index = view.entries.length - 1; index >= 0; index -= 1) {
			const entry = view.entries[index];
			if (!entry || entry.kind !== "pi.assistant") continue;
			const message = entry.model?.[0] as
				| { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }
				| undefined;
			const usage = message?.usage;
			if (usage) {
				console.log(
					`[usage] 会话 ${internalId} input=${usage.input ?? "-"} cacheRead=${usage.cacheRead ?? "-"} ` +
						`cacheWrite=${usage.cacheWrite ?? "-"} output=${usage.output ?? "-"}`,
				);
				return;
			}
		}
	} catch (error) {
		console.warn(`[usage] 读取失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ── 会话旁路能力 ─────────────────────────────────────────
export interface UsageSummary {
	models: {
		model: string;
		inputTokens: number;
		outputTokens: number;
		/** 缓存命中 token（2026-10-31 方案 §7 验收指标用） */
		cacheReadTokens: number;
		/** 缓存写入 token */
		cacheWriteTokens: number;
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
			cacheReadTokens: usage.cacheRead ?? 0,
			cacheWriteTokens: usage.cacheWrite ?? 0,
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

// ── 会话索引（2026-10-29 配对配套）────────────────────────
/**
 * 会话索引：**只返回元数据，不含正文**。
 *
 * 为什么需要：手机本地存会话清单，但重装/换机后清单会丢；这里给一份可恢复的索引，
 * 手机配对后拉一次就能把历史列表重建出来，正文仍按 id 现取（`GET .../messages`）。
 *
 * 为什么不做"列全部会话内容"：会话一多，一次性把所有正文吐出来太重。
 * 代价（如实登记）：这里为了拿首句与时间，会逐个打开会话读一遍 context，
 * **会话数量大时会变慢**；真到那时应改用 durable 的 entries 分页 + 单独维护索引表。
 */
export interface ChatIndexEntry {
	conversationId: string;
	createdAt: number;
	lastAt: number;
	firstText: string;
	turns: number;
}

export async function listChats(limit = 50): Promise<ChatIndexEntry[]> {
	if (!readLlmConfig()) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	// 任务会话（`X-Task` 通道产生）不进"历史对话"：它们的首句是"请整理成稿"这类指令，
	// 不是用户说过的话（2026-10-31）。正文仍可按 id 回读，只是不在列表里露头。
	const pairs = Object.entries(chats?.byExternal ?? {})
		.filter(([conversationId]) => !conversationId.startsWith(TASK_CONVERSATION_PREFIX))
		.slice(-limit);
	const entries: ChatIndexEntry[] = [];

	for (const [conversationId, internalId] of pairs) {
		try {
			const conversation = await harness.conversation(internalId as never, CTX);
			if (!conversation) continue;
			const view = await conversation.context(CTX);
			let firstText = "";
			let turns = 0;
			let createdAt = 0;
			let lastAt = 0;
			for (const entry of view.entries) {
				if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
				const message = entry.model?.[0];
				if (!message) continue;
				const at = typeof message.timestamp === "number" ? message.timestamp : 0;
				if (entry.kind === "pi.user") {
					turns += 1;
					if (!firstText) firstText = contentText(message.content).trim().slice(0, 40);
				}
				if (!createdAt && at) createdAt = at;
				if (at > lastAt) lastAt = at;
			}
			if (turns === 0) continue;
			entries.push({ conversationId, createdAt, lastAt, firstText, turns });
		} catch (error) {
			// 单个会话读失败不该让整张索引失败（重装场景下可能是残留的空会话）
			console.warn(
				`[chats] 读取会话 ${conversationId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return entries.sort((a, b) => b.lastAt - a.lastAt);
}
