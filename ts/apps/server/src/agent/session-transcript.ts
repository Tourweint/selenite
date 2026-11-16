/**
 * 续写与转写（continueConversation / 折叠 / 用量 / 提醒）
 *
 * 2026-11-13 从 session.ts 的 L1112–L1622 整段切出；正文原文搬运，未改一行实现。
 */

import { currentModels, readLlmConfig } from "../provider.ts";
import { ReminderTask, type ReminderRepeat } from "../reminder.ts";
import { getHarness } from "./lifecycle.ts";
import { turnSettledHandler } from "./settled.ts";
import { CTX, Chats, ResolvedChat, TOOL_OUTPUT_LIMIT, toolArgs, toolLabel } from "./shared.ts";
import { usageInWindow } from "./usage-range.ts";
import { contentText } from "@earendil-works/pi-ai";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import type { ContextView, Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { configure } from "@earendil-works/pi-durable";
import { TranscriptStep, TurnUsage, parseFileManifest, type TranscriptAuthor } from "@lifediary/shared";
import { createHash, randomUUID } from "node:crypto";
import { isRelayEntryKind, relayDisplayText, relayFromOf } from "../partner-relay.ts";
import { externalChatIds, openChat } from "./session-open.ts";
import { chatStream } from "./session-stream.ts";

export async function continueConversation(conversationId: number, text: string): Promise<void> {
	try {
		const harness = await getHarness();
		const conversation = await harness.conversation(conversationId as never, CTX);
		if (!conversation) {
			console.warn(`[agent] 会话 ${conversationId} 已不存在，跳过审批后的续跑`);
			return;
		}
		// 续跑这轮的用户侧只有这一句指令；对外 id 只用于任务专线过滤（读不到就当普通会话，
		// 绝不让一次映射读取失败把续跑本身拦掉）
		const externalId =
			(await externalChatIds().catch(() => new Map<number, string>())).get(conversationId) ?? "";
		for await (const _event of chatStream({
			conversation,
			text,
			onSettled: turnSettledHandler(
				{ internalId: conversationId, externalId },
				[{ role: "user", content: text }],
			),
		})) {
			// 没有客户端读这条流：事件只为驱动主链路，丢弃即可
		}
	} catch (error) {
		console.warn(
			`[agent] 会话 ${conversationId} 审批后续跑失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
	/** 消息时间，epoch 毫秒 */
	at: number;
	/**
	 * 可寻址 id（2026-11-08 扫尾批 4a）：只给 user 消息，编辑重发拿它指位置。
	 * uuid 形状、不含 durable 内部自增 id（见 {@link messageIdOf}）。
	 */
	id?: string;
	/** 用户消息带的图片（2026-11-08 扫尾批 4a）；文字仍走 `text` */
	images?: { mimeType: string; data: string }[];
	/** 用户消息带的文件（2026-11-13 附件走路径）：只有路径，没有内容 */
	files?: { path: string; name: string; mimeType?: string; bytes?: number }[];
	/** 这一轮的工作步骤（2026-11-07）；没有工具调用就不带 */
	steps?: TranscriptStep[];
	/** 那一轮从提问到收尾的墙钟时长（毫秒） */
	workMs?: number;
	/**
	 * 非主人来源的作者（2026-11-15 作者标记方案）。
	 *
	 * 带头 = 这条不是主人说的（目前只有执事间递话）。**与 `id` 互斥**：
	 * 带 author 的消息不给可寻址 id，于是编辑重发拿不到它（主人能看不能改）。
	 */
	author?: TranscriptAuthor;
}

export function messageIdOf(externalId: string, entryId: number): string {
	const hex = createHash("sha256").update(`${externalId}:${entryId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const STEP_OUTPUT_LIMIT = TOOL_OUTPUT_LIMIT;

const STEP_DIFF_LIMIT = 2000;

function clampText(text: string, limit: number): string | undefined {
	const one = text.trim();
	if (!one) return undefined;
	return one.length > limit
		? `${one.slice(0, limit)}\n…（还有 ${one.length - limit} 字符）`
		: one;
}

function stepDiff(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const diff = (details as { diff?: unknown }).diff;
	return typeof diff === "string" ? clampText(diff, STEP_DIFF_LIMIT) : undefined;
}

/**
 * 从 `relay.message` 条目里还原作者（2026-11-15 作者标记方案 §3.2）。
 *
 * 先读结构（`entry.data`，宿主盖章那一份）；结构缺了退回正文前缀——正文前缀是
 * 给模型看的那一句，随消息本体永远在。两条口径都说不出来时才返回 undefined，
 * 此时这条来信会掉成"没有作者、也没有 id"的一句话（仍进不了编辑入口）。
 */
export function relayAuthorOf(entry: EntryRecord): TranscriptAuthor | undefined {
	const data = entry.data;
	if (data && typeof data === "object" && !Array.isArray(data)) {
		const record = data as Record<string, unknown>;
		if (record.kind === "partner" && typeof record.name === "string" && record.name) {
			return {
				kind: "partner",
				id: typeof record.id === "string" ? record.id : "",
				name: record.name,
				...(typeof record.domain === "string" && record.domain ? { domain: record.domain } : {}),
				...(typeof record.hop === "number" ? { hop: record.hop } : {}),
			};
		}
	}
	const message = entry.model?.[0];
	if (!message) return undefined;
	const from = relayFromOf(contentText(message.content as Parameters<typeof contentText>[0]));
	if (!from) return undefined;
	return {
		kind: "partner",
		// 正文里没有 id（前缀只写名字与领域）：结构缺了时作者仍是"那个人"，但不可寻址
		id: "",
		name: from.name,
		...(from.domain ? { domain: from.domain } : {}),
		hop: from.hop,
	};
}

export function foldTranscriptEntries(
	externalId: string,
	entries: readonly EntryRecord[],
): TranscriptMessage[] {
	const messages: TranscriptMessage[] = [];

	/** 本轮的步骤，按 toolCallId 索引；回答落盘时整段挂上去 */
	let pending: TranscriptStep[] = [];
	const byCallId = new Map<string, { step: TranscriptStep; settled: boolean }>();
	/** 助手条目里模型侧看到的正文；entries 的类型是 Message 联合，取用前要收窄 */
	/** 本轮提问的时间（算 workMs 用）；没有 user 开头就留 undefined */
	let turnStartAt: number | undefined;

	for (const entry of entries) {
		// 2026-11-15：递话条目同样是一轮的开头（它触发一轮 run），只是作者不是主人。
		// 不认它的话，`relay.message` 会落进下面所有分支的 continue 里——整条从历史消失。
		const isRelay = isRelayEntryKind(entry.kind);
		if (entry.kind === "pi.user" || isRelay) {
			// 新一轮：上一轮没等到回答的步骤没有挂靠点，直接丢掉（见函数头注释）
			pending = [];
			byCallId.clear();
			const message = entry.model?.[0];
			if (!message) continue;
			// 2026-11-13 附件走路径：文件清单写在正文第一行，回读时折成 files 并从 text 剥掉
			const raw = contentText(message.content);
			const manifest = parseFileManifest(raw);
			// 2026-11-15：来信展示时剥掉模型侧那三段说明（抬头已写清谁发来的）；存储与模型上下文不动
			const text = isRelay ? relayDisplayText(manifest.text) : manifest.text.trim();
			const at = typeof message.timestamp === "number" ? message.timestamp : 0;
			// 2026-11-08 4a：纯图消息没有文本，也要下发（老逻辑会把它整条丢掉）
			const parts = Array.isArray(message.content) ? message.content : [];
			const images = parts
				.filter(
					(part): part is { type: "image"; mimeType: string; data: string } =>
						part.type === "image",
				)
				.map((part) => ({ mimeType: part.mimeType, data: part.data }));
			if (!text && images.length === 0 && manifest.files.length === 0) continue;
			turnStartAt = at || undefined;
			const outgoing: TranscriptMessage = { role: "user", text, at };
			if (isRelay) {
				// 作者进结构；**不给 id** → 前端拿不到可编辑的锚点（服务端 `forkForEdit` 也只认 pi.user）
				const author = relayAuthorOf(entry);
				if (author) outgoing.author = author;
			} else {
				outgoing.id = messageIdOf(externalId, Number(entry.id));
			}
			if (images.length > 0) outgoing.images = images;
			if (manifest.files.length > 0) outgoing.files = manifest.files;
			messages.push(outgoing);
			continue;
		}

		if (entry.kind === "pi.tool-result") {
			const message = entry.model?.[0];
			if (!message || message.role !== "toolResult") continue;
			const slot = byCallId.get(message.toolCallId);
			if (!slot) continue;
			const { step } = slot;
			step.ok = !message.isError;
			const output = clampText(contentText(message.content), STEP_OUTPUT_LIMIT);
			if (output) step.output = output;
			const diff = stepDiff((message as { details?: unknown }).details);
			if (diff) step.diff = diff;
			if (typeof message.durationMs === "number") step.ms = Math.round(message.durationMs);
			slot.settled = true;
			continue;
		}

		if (entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0];
		if (!message || message.role !== "assistant") continue;
		const at = typeof message.timestamp === "number" ? message.timestamp : 0;
		// assistant 的 timestamp 是"请求开始"，收尾时刻要再加 durationMs（pi-ai 的口径）；
		// 没有 durationMs 的旧记录退回 timestamp，宁可少算也不编一个数出来。
		const endedAt =
			at + (typeof message.durationMs === "number" ? Math.max(0, Math.round(message.durationMs)) : 0);

		// 带工具调用的中间回合：收步骤；正文不为空就作为一步「说」下发（批 32）。
		// 模型动手前常先说话（"我先看看这个文件…"），以前直接丢掉，历史回读
		// 就看不到这段——现场有、翻历史没有，会让人怀疑记录被裁过。
		const parts = Array.isArray(message.content) ? message.content : [];
		const calls = parts.filter((item) => item.type === "toolCall");
		if (calls.length > 0) {
			const spoken = contentText(
				parts.filter((item) => item.type !== "toolCall"),
			).trim();
			if (spoken) {
				const say: TranscriptStep = { name: "say", ok: true, format: "md" };
				const text = clampText(spoken, STEP_OUTPUT_LIMIT);
				if (text) say.output = text;
				pending.push(say);
			}
			for (const call of calls) {
				const step: TranscriptStep = { name: call.name, ok: true };
				const label = toolLabel(call.arguments);
				if (label) step.label = label;
				const args = toolArgs(call.arguments).args;
				if (args) step.args = args;
				pending.push(step);
				byCallId.set(call.id, { step, settled: false });
			}
			continue;
		}

		const text = contentText(message.content).trim();
		if (!text) continue;
		const outgoing: TranscriptMessage = { role: "assistant", text, at };
		if (pending.length > 0) {
			// 没配到结果的（中断 / 崩在工具里）在这里定案：ok=false，避免历史把它画成成功。
			// 判据是 settled 而不是"有没有输出"——成功的 `read` 也可能一字不吐。
			for (const slot of byCallId.values()) {
				if (!slot.settled) slot.step.ok = false;
			}
			outgoing.steps = pending;
			if (turnStartAt !== undefined && endedAt > turnStartAt) outgoing.workMs = endedAt - turnStartAt;
		}
		messages.push(outgoing);
		pending = [];
		byCallId.clear();
	}

	// 收尾兜底：一轮因为撞工具回合上限 / 被停 / 崩在工具里而没能产出正文时，
	// 上面那条"挂在回答上"的路就没有挂靠点，整轮步骤会凭空消失——
	// 而这恰恰是最需要看过程的一轮。这里给它们一条只有步骤、正文为空的 assistant，
	// 客户端照常渲染工作过程块（正文是空的，自然不显示字）。
	if (pending.length > 0) {
		for (const slot of byCallId.values()) {
			if (!slot.settled) slot.step.ok = false;
		}
		const lastAt =
			typeof entries.at(-1)?.model?.[0]?.timestamp === "number"
				? (entries.at(-1)?.model?.[0]?.timestamp as number)
				: 0;
		const outgoing: TranscriptMessage = { role: "assistant", text: "", at: lastAt, steps: pending };
		if (turnStartAt !== undefined && lastAt > turnStartAt) outgoing.workMs = lastAt - turnStartAt;
		messages.push(outgoing);
	}

	return messages;
}

export async function readTranscript(
	chat: ResolvedChat,
	limit = 50,
): Promise<TranscriptMessage[]> {
	const view = await chat.conversation.context(CTX);
	const messages = foldTranscriptEntries(chat.externalId, view.entries);
	return limit > 0 ? messages.slice(-limit) : messages;
}

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

/** 上下文构成标签（2026-11-14，对齐 ZCode「上下文来源」）：前端按 chars 占比画条。 */
export type ContextSource =
	| "messages"
	| "system_prompt"
	| "skills"
	| "tool_prompt"
	| "tool_calls"
	| "tool_results";

export interface ContextBreakdownItem {
	readonly source: ContextSource;
	readonly chars: number;
}

function textCharsOf(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const typed = part as { type?: string; text?: unknown };
		// thinking 不进上下文、image 不计字符：和 ZCode 一样只按「发送出去的字符」分摊
		if (typed.type === "text" && typeof typed.text === "string") total += typed.text.length;
	}
	return total;
}

/**
 * 按上下文实文估算构成比例。
 *
 * 口径与 ZCode 一致：**按字符数**分摊，不拿 token 数硬凑——used 只用于顶部
 * 「已用 / 总量」，构成条回答的是「这一窗里什么东西在占地方」。
 * 技能段由 harness 以 section 名 `skills` 注入，单独拎出来；工具定义取 toolsAdded，
 * 工具调用取 assistant 的 toolCall 参数，工具结果取 toolResult 正文。
 */
export function contextBreakdownOf(view: ContextView): ContextBreakdownItem[] {
	const totals = new Map<ContextSource, number>();
	const add = (source: ContextSource, chars: number) => {
		if (!Number.isFinite(chars) || chars <= 0) return;
		totals.set(source, (totals.get(source) ?? 0) + chars);
	};
	for (const message of view.messages) {
		if (message.role === "system") {
			const system = message as SystemMessage;
			add("system_prompt", textCharsOf(system.content));
			for (const [name, body] of Object.entries(system.sections ?? {})) {
				if (!body) continue;
				add(/skill/i.test(name) ? "skills" : "system_prompt", body.length);
			}
			for (const tool of system.toolsAdded ?? []) {
				// 工具定义在请求里是 JSON schema，大小按序列化后的字符算，贴近实际占用
				try {
					add("tool_prompt", JSON.stringify(tool).length);
				} catch {
					// 序列化不了就不计，不让一块坏定义把整张卡算成空
				}
			}
			continue;
		}
		if (message.role === "user") {
			add("messages", textCharsOf(message.content));
			continue;
		}
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") {
					add("messages", textCharsOf([part]));
				} else if (part.type === "toolCall") {
					let args = 0;
					try {
						args = JSON.stringify(part.arguments ?? {}).length;
					} catch {
						args = 0;
					}
					add("tool_calls", part.name.length + args);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			add("tool_results", textCharsOf(message.content));
		}
	}
	return [...totals.entries()]
		.map(([source, chars]) => ({ source, chars }))
		.sort((a, b) => b.chars - a.chars);
}

/** 本地读数多带一个缓存写入：上下文用量要把它算进完整 prompt，但 SSE 契约里的 TurnUsage 不变。 */
type LocalTurnUsage = TurnUsage & { cacheWrite: number };

function lastTurnUsageOf(view: ContextView): LocalTurnUsage | null {
	for (let index = view.entries.length - 1; index >= 0; index -= 1) {
		const entry = view.entries[index];
		if (!entry || entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0] as
			| { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }
			| undefined;
		const usage = message?.usage;
		if (usage) {
			return {
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
			};
		}
	}
	return null;
}

async function readLastTurnUsage(conversation: Conversation): Promise<TurnUsage | null> {
	try {
		return lastTurnUsageOf(await conversation.context(CTX));
	} catch {
		// 读不到就算了：用量是锦上添花，不该让它影响对话
	}
	return null;
}

async function logTurnUsage(conversation: Conversation, internalId: number): Promise<void> {
	const usage = await readLastTurnUsage(conversation);
	if (usage) {
		console.log(
			`[usage] 会话 ${internalId} input=${usage.input} cacheRead=${usage.cacheRead} output=${usage.output}`,
		);
	}
}

export async function contextUsageOf(
	conversation: Conversation,
	// 设置 → 上下文会先读同一份 view（要取 system/tools 原文），传进来复用，
	// 避免头和身子两次读之间刚好落一条新消息。其它调用方不传，行为不变。
	view?: ContextView | null,
): Promise<{ used: number | null; window: number | null; breakdown: ContextBreakdownItem[] }> {
	// 一次读上下文视图：用量取最后一条 assistant 的 usage，构成按同一份实文分摊，
	// 避免两次读之间刚好落一条新消息、头和身子对不上。
	const currentView = view ?? (await conversation.context(CTX).catch(() => null));
	const usage = currentView ? lastTurnUsageOf(currentView) : null;
	// 上下文已用 = 完整 prompt token。pi-ai 的 input 是「未命中缓存」的部分：
	// OpenAI 系 = prompt_tokens - cached - write；Anthropic 的 input_tokens 也不含 cache。
	// 只取 input 会在命中缓存时严重低报，全命中时甚至变成 0（ring 直接消失）。
	const used = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
	if (!usage || used <= 0) return { used: null, window: null, breakdown: [] };
	const windowOf = (provider: string | undefined, modelId: string | undefined): number | null => {
		if (!provider || !modelId) return null;
		try {
			// 会话里存的是派生模型引用（`#think-*` / `#t…`），窗口按基座模型查
			const model = currentModels().getModel(provider, modelId.split("#")[0]);
			const value = (model as { contextWindow?: number } | undefined)?.contextWindow;
			return typeof value === "number" && value > 0 ? value : null;
		} catch {
			return null;
		}
	};
	const config = readLlmConfig();
	const agent = await conversation.agent(CTX).catch(() => null);
	// 先按会话自己的模型取；会话模型被删 / 还没 configure（例如旧会话停在已移除的
	// 供应商上）才回退全局默认——绝不因为查不到会话模型就把整块徽标藏掉。
	const window =
		windowOf(agent?.model?.provider, agent?.model?.modelId) ??
		windowOf(config?.model.provider, config?.model.modelId);
	return { used, window, breakdown: currentView ? contextBreakdownOf(currentView) : [] };
}

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
	/** 统计区间：`all` = 全部累计；`7d` / `30d` = 近 N 个自然日（2026-11-15 新增） */
	range: "all" | "7d" | "30d";
	/** 区间起点（本地 00:00，epoch ms）；`all` 不带 */
	since?: number;
	/** 区间内有消耗的自然日数；`all` 不带 */
	activeDays?: number;
}

/**
 * 用量汇总（2026-11-15 扩区间）。
 *
 * - 不带参数 = 原行为：durable 的 `pi.usage` 按会话相加，全部累计。
 * - `days: 7 | 30` = 近 N 个自然日：`pi.usage` 没有逐日流水，改从每条 assistant entry
 *   自带的 `timestamp` + `usage` 还原（见 `usage-range.ts` 的口径说明）。
 */
export async function usageSummary(options: { days?: number } = {}): Promise<UsageSummary> {
	const days = options.days;
	if (typeof days === "number" && Number.isFinite(days) && days > 0) {
		const window = await usageInWindow(days);
		return {
			range: days === 7 ? "7d" : "30d",
			since: window.since,
			activeDays: window.activeDays,
			models: window.models.map((row) => ({
				model: row.model,
				inputTokens: row.input,
				outputTokens: row.output,
				cacheReadTokens: row.cacheRead,
				cacheWriteTokens: row.cacheWrite,
				totalTokens: row.total,
			})),
		};
	}
	const harness = await getHarness();
	const state = await harness.usage(CTX);
	return {
		range: "all",
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
	/** 稳定提醒 id（每日续排沿用；列表按它归组） */
	reminderId: string;
	status: "pending" | "running" | "waiting" | "sleeping" | "completing" | "terminal";
	text: string;
	at: number;
	/** 频率（2026-11-14）：none = 一次性；daily = 每天；weekly = 每周几；monthly = 每月几号 */
	repeat: ReminderRepeat;
	/** 每周重复的日子（0 = 周日 … 6 = 周六） */
	weekdays?: number[];
	/** 每月重复的日子（1–31） */
	dayOfMonth?: number;
	/** 区间结束（含当天）；仅 daily 区间用 */
	until?: number;
	/** 目标执事（2026-11-12）；null = 建在普通会话里 */
	partnerId: string | null;
	/** 对外会话 id（客户端存的是这个） */
	conversationId: string;
}

export async function listReminders(): Promise<ReminderSummary[]> {
	const harness = await getHarness();
	const [inspection, chats] = await Promise.all([harness.inspect(CTX), harness.snapshot(Chats, CTX)]);
	const externalByInternal = new Map<number, string>();
	for (const [externalId, internalId] of Object.entries(chats?.byExternal ?? {})) {
		externalByInternal.set(Number(internalId), externalId);
	}
	type Row = {
		id: number;
		input: {
			text: string;
			at: number;
			repeat?: ReminderRepeat;
			weekdays?: number[];
			dayOfMonth?: number;
			until?: number;
			reminderId?: string;
			partnerId?: string | null;
		};
		conversationId: number;
		live: boolean;
		until?: number;
	};
	const groups = new Map<string, Row[]>();
	for (const task of inspection.tasks) {
		if (task.record.kind !== ReminderTask.definition.name) continue;
		const record = task.record as unknown as {
			id: number;
			input: {
				text: string;
				at: number;
				repeat?: ReminderRepeat;
				weekdays?: number[];
				dayOfMonth?: number;
				until?: number;
				reminderId?: string;
				partnerId?: string | null;
			};
			conversationId: number;
		};
		const live = task.state.kind !== "blocked";
		const row: Row = {
			id: record.id,
			input: record.input,
			conversationId: record.conversationId,
			live,
			...(task.state.kind === "sleeping" ? { until: task.state.until } : {}),
		};
		const key = record.input.reminderId ?? `legacy-${record.id}`;
		const bucket = groups.get(key);
		if (bucket) bucket.push(row);
		else groups.set(key, [row]);
	}

	const result: ReminderSummary[] = [];
	for (const [reminderId, rows] of groups) {
		const live = rows
			.filter((row) => row.live)
			.sort((a, b) => a.input.at - b.input.at)[0];
		const chosen = live ?? rows.sort((a, b) => b.input.at - a.input.at)[0];
		if (!chosen) continue;
		const repeat = chosen.input.repeat ?? "none";
		result.push({
			id: chosen.id,
			reminderId,
			status: chosen.live ? (chosen.until === undefined ? "pending" : "sleeping") : "terminal",
			text: chosen.input.text,
			at: chosen.input.at,
			repeat,
			...(repeat === "weekly" ? { weekdays: chosen.input.weekdays ?? [] } : {}),
			...(repeat === "monthly"
				? { dayOfMonth: chosen.input.dayOfMonth ?? new Date(chosen.input.at).getDate() }
				: {}),
			...(chosen.input.until !== undefined ? { until: chosen.input.until } : {}),
			partnerId: chosen.input.partnerId ?? null,
			conversationId:
				externalByInternal.get(chosen.conversationId) ?? `#${chosen.conversationId}`,
		});
	}
	return result.sort((a, b) => a.at - b.at);
}

export async function addReminder(
	chat: ResolvedChat,
	input: {
		text: string;
		at: number;
		repeat?: ReminderRepeat;
		weekdays?: number[];
		dayOfMonth?: number;
		until?: number;
		partnerId?: string | null;
		reminderId?: string;
	},
): Promise<number> {
	const reminderId = input.reminderId ?? randomUUID();
	const id = await chat.conversation.commit(
		(tx) =>
			tx.createTask(
				ReminderTask,
				{ ...input, reminderId },
				{ ownership: { kind: "conversation" } },
			),
		CTX,
	);
	return Number(id);
}

export async function cancelReminder(taskId: number): Promise<boolean> {
	const reminders = await listReminders();
	if (!reminders.some((reminder) => reminder.id === taskId && reminder.status !== "terminal")) {
		return false;
	}
	const harness = await getHarness();
	await harness.abortTask(taskId as never, CTX);
	return true;
}

/**
 * 改时间（2026-11-14）：取消原任务，用同一个 `reminderId` 重排一条。
 *
 * 为什么不原地改任务：durable 的睡眠状态是提交过的，直接改输入需要内核级支持；
 * 重排一条同 id 的任务更稳，而且列表按 `reminderId` 归组，不会多出一行"已结束"。
 * 内容与执事沿用原任务，只有时间规则变。
 */
export async function rescheduleReminder(
	taskId: number,
	input: {
		at: number;
		repeat?: ReminderRepeat;
		weekdays?: number[];
		dayOfMonth?: number;
		until?: number;
	},
): Promise<number | null> {
	const reminders = await listReminders();
	const origin = reminders.find((reminder) => reminder.id === taskId && reminder.status !== "terminal");
	if (!origin) return null;
	const chat = await openChat(origin.conversationId);
	if (!chat) return null;
	const harness = await getHarness();
	await harness.abortTask(taskId as never, CTX);
	return addReminder(chat, {
		text: origin.text,
		at: input.at,
		repeat: input.repeat ?? "none",
		weekdays: input.weekdays,
		dayOfMonth: input.dayOfMonth,
		until: input.until,
		partnerId: origin.partnerId,
		reminderId: origin.reminderId,
	});
}

export { STEP_DIFF_LIMIT, STEP_OUTPUT_LIMIT, answerText, clampText, logTurnUsage, readLastTurnUsage, stepDiff };
