/**
 * 请求级缓存统计（2026-11-19，方案 `docs/设计方案/2026-11-19-提示词前缀锁定与请求缓存统计.md`）
 *
 * 不落新存储：全部从 durable 已有的 `pi.assistant` entry 还原——
 *   列表 = 最近的模型请求（带 usage 的 assistant entry）；
 *   详情 = `conversation.context({ at })` 重放那一条请求当时的固定前缀 + 已存档消息。
 *
 * 诚实边界：请求时临时拼装的注入（记忆召回 / 当前项目 / 执事上下文）
 * 不写进 durable，历史详情里看不到；页面会写明。要判断"是不是前缀变了"，
 * 详情里的 `compare` 直接对比相邻两条请求的 system 文本与工具面。
 */

import { getCurrentSystemMessage, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import type { ContextView, Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
	contextInspectViewOf,
	contextSectionLabel,
	type ContextInspectView,
} from "./context-inspect.ts";
import { flagEnabled } from "./flags.ts";
import { estimateTokens } from "./token-estimate.ts";

/** durable 的读取上下文（`BACKGROUND_CONTEXT`）；从方法签名取，不另造一份类型。 */
type ReadContext = Parameters<Conversation["entries"]>[3];

/** 默认保留的请求条数（用户口径：默认 500 条）。 */
export const CACHE_STATS_MAX_REQUESTS = 500;
/** 每页条数（用户口径：100 条一页）。 */
export const CACHE_STATS_PAGE_SIZE = 100;
/** 详情里最多带多少条消息（从最新往回取）；完整计数仍按全量算。 */
export const CACHE_STATS_DETAIL_ENTRIES = 200;
/** 详情找"上一条请求"时最多翻多少页 entry（每页 256 条）。 */
const PREV_SCAN_PAGES = 4;

export type RequestFlag =
	| "prefix_change_drop"
	| "prefix_change"
	| "tools_change_drop"
	| "tools_change"
	| "drop_unchanged"
	| "compacted";

export interface RequestStatRow {
	/** durable entry id；详情端点用它定位。 */
	entryId: number;
	/** 模型回复时间（epoch ms）。 */
	at: number;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** 完整 prompt = input + cacheRead + cacheWrite。 */
	promptTokens: number;
	/** cacheRead / promptTokens（0–1）。 */
	hitRate: number;
	/** 整个会话里的时序（1 = 最早一条请求）。 */
	seq: number;
	/** system 前缀相对上一条请求变了（sections / 正文）。 */
	systemChanged: boolean;
	/** 工具面相对上一条请求变了。 */
	toolsChanged: boolean;
	/** 任一项变了 = 缓存前缀变了。 */
	prefixChanged: boolean;
	/** 两条请求之间新增了几条 pi.system（首条请求 = 1 条 baseline）。 */
	systemPatches: number;
	/** 命中率从 ≥50% 掉到 <20%。 */
	drop: boolean;
	/** 给页面看的单一结论（见 REQUEST_FLAG 口径）。 */
	flag: RequestFlag | null;
}

export interface RequestStatsSummary {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	promptTokens: number;
	/** 加权命中率：ΣcacheRead / Σprompt。 */
	hitRate: number;
	/** 几乎整段未命中的请求数（cacheRead < 5%）。 */
	fullMisses: number;
	/** 命中率骤降次数（≥50% → <20%）。 */
	drops: number;
	/** 骤降且 system 前缀同时变了——最该查的。 */
	suspects: number;
	/** system 前缀变化次数（不含压缩/重置那条）。 */
	prefixChanges: number;
}

export interface RequestStatsPayload {
	conversationId: string;
	/** 保留窗口内的请求数（≤ max）。 */
	total: number;
	/** 会话里还有更早的请求没列出来。 */
	truncated: boolean;
	page: number;
	pages: number;
	pageSize: number;
	max: number;
	summary: RequestStatsSummary;
	items: RequestStatRow[];
}

export interface RequestSystemSection {
	key: string;
	label: string;
	chars: number;
	tokens: number;
}

export interface RequestSystemSnapshot {
	chars: number;
	tokens: number;
	/** 固定前缀的指纹（system 正文 + sections + 工具声明）；相邻请求相同 = 前缀没动。 */
	hash: string;
	sections: RequestSystemSection[];
	tools: number;
}

export interface RequestCompare {
	entryId: number;
	at: number;
	systemChanged: boolean;
	changedSections: string[];
	addedSections: string[];
	removedSections: string[];
	orderChanged: boolean;
	toolsChanged: boolean;
	toolsAdded: string[];
	toolsRemoved: string[];
}

export interface RequestContextPayload {
	conversationId: string;
	request: RequestStatRow;
	context: ContextInspectView & { entriesTotal: number; entriesOmitted: number };
	system: RequestSystemSnapshot;
	compare: RequestCompare | null;
	note: string;
}

/** `CHAT_CACHE_STATS=false` 一行回滚：两个端点 404、页面不画这一块。 */
export function cacheStatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("CHAT_CACHE_STATS", env);
}

interface UsageOf {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

interface AssistantMessageOf {
	role?: string;
	api?: string;
	provider?: string;
	model?: string;
	timestamp?: number;
	usage?: UsageOf;
}

function assistantMessageOf(record: EntryRecord): AssistantMessageOf | null {
	if (record.kind !== "pi.assistant") return null;
	const message = record.model?.[0] as AssistantMessageOf | undefined;
	if (!message || message.role !== "assistant") return null;
	return message;
}

function rowOf(entryId: number, message: AssistantMessageOf): RequestStatRow | null {
	const usage = message.usage;
	if (!usage) return null;
	const inputTokens = Number(usage.input) || 0;
	const outputTokens = Number(usage.output) || 0;
	const cacheReadTokens = Number(usage.cacheRead) || 0;
	const cacheWriteTokens = Number(usage.cacheWrite) || 0;
	const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
	// 0 token 的 assistant（提醒 / [[no-update]] 之类的本地合成消息）不算模型请求。
	if (promptTokens <= 0) return null;
	return {
		entryId,
		at: Number(message.timestamp) || 0,
		model: message.model || message.provider || "unknown",
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		promptTokens,
		hitRate: cacheReadTokens / promptTokens,
		seq: 0,
		systemChanged: false,
		toolsChanged: false,
		prefixChanged: false,
		systemPatches: 0,
		drop: false,
		flag: null,
	};
}

interface SystemPatchMessage {
	role?: string;
	content?: unknown;
	sections?: Record<string, string | null>;
	toolsRemoved?: Array<{ name?: string }>;
	toolsAdded?: Array<{ name?: string; description?: string; parameters?: unknown }>;
}

function sha1(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/**
 * 增量重放 `pi.system`（2026-11-19 骤降定位）：
 * 从会话最早一条 entry 按 id 顺序往后走，维护 system sections / tools 的当前值；
 * 每条模型请求拿一次指纹。**不读整份 ContextView**，所以 500 条请求也只是线性扫一遍。
 *
 * 语义照搬 pi-ai 的 `getCurrentSystemMessage` / `getCurrentTools`：
 * content 追加、sections 按名覆盖（null 删除）、tools 先 remove 再 add。
 */
class PrefixTracker {
	private readonly contents: string[] = [];
	private readonly sections = new Map<string, string>();
	private readonly tools = new Map<string, { name: string; description: string; parameters: unknown }>();
	private patches = 0;
	private compacted = false;
	private dirty = true;
	private systemHash = "";
	private toolsHash = "";

	applySystem(record: EntryRecord): void {
		const message = record.model?.[0] as SystemPatchMessage | undefined;
		if (!message || message.role !== "system") return;
		const content = typeof message.content === "string" ? message.content : "";
		if (content) this.contents.push(content);
		for (const [key, value] of Object.entries(message.sections ?? {})) {
			if (value === null) this.sections.delete(key);
			else this.sections.set(key, value);
		}
		for (const tool of message.toolsRemoved ?? []) {
			if (tool.name) this.tools.delete(tool.name);
		}
		for (const tool of message.toolsAdded ?? []) {
			if (!tool.name) continue;
			this.tools.set(tool.name, {
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.parameters ?? {},
			});
		}
		this.patches += 1;
		this.dirty = true;
	}

	markCompacted(): void {
		this.compacted = true;
		// 压缩 / 重置后新的上下文从 head 重新开始：旧 sections / contents / tools 都不再重放，
		// 后面会追加一条完整 baseline。不清空就会把旧段残留在指纹里。
		this.contents.length = 0;
		this.sections.clear();
		this.tools.clear();
		this.dirty = true;
	}

	takePatches(): number {
		const value = this.patches;
		this.patches = 0;
		return value;
	}

	takeCompacted(): boolean {
		const value = this.compacted;
		this.compacted = false;
		return value;
	}

	hashes(): { system: string; tools: string } {
		if (this.dirty) {
			const text = [...this.contents, ...this.sections.values()].filter(Boolean).join("\n\n");
			this.systemHash = sha1(text);
			this.toolsHash = sha1(JSON.stringify([...this.tools.values()]));
			this.dirty = false;
		}
		return { system: this.systemHash, tools: this.toolsHash };
	}
}

/**
 * 最近的模型请求（新 → 旧），最多 `max` 条；同时给每条打上「前缀是否变了 / 是否骤降」。
 *
 * 扫描按 id 升序（前缀状态只能往后增量重放）；只保留最后 `max` 条，`seq` 仍是整条会话的时序。
 */
export async function recentRequestsOf(
	conversation: Conversation,
	context: ReadContext,
	max: number = CACHE_STATS_MAX_REQUESTS,
): Promise<{ rows: RequestStatRow[]; truncated: boolean }> {
	const wanted = Math.max(1, Math.floor(max));
	const tracker = new PrefixTracker();
	const kept: RequestStatRow[] = [];
	let previous: RequestStatRow | null = null;
	let previousSystemHash = "";
	let previousToolsHash = "";
	let total = 0;
	let cursor: Parameters<Conversation["entries"]>[2];
	for (;;) {
		const page = await conversation.entries({ order: "ascending" }, 256, cursor, context);
		for (const record of page.items) {
			if (record.kind === "pi.system") {
				tracker.applySystem(record);
				continue;
			}
			// 压缩 / 重置会重写上下文，前缀变化是必然的：单独标记，不算「运行中偷偷改前缀」。
			if (record.kind === "pi.compaction" || record.kind === "pi.reset") {
				tracker.markCompacted();
				continue;
			}
			const message = assistantMessageOf(record);
			if (!message) continue;
			const row = rowOf(record.id, message);
			if (!row) continue;

			const hashes = tracker.hashes();
			row.systemChanged = previous !== null && previousSystemHash !== hashes.system;
			row.toolsChanged = previous !== null && previousToolsHash !== hashes.tools;
			row.prefixChanged = row.systemChanged || row.toolsChanged;
			row.systemPatches = tracker.takePatches();
			const compacted = tracker.takeCompacted();
			row.drop = previous !== null && previous.hitRate >= 0.5 && row.hitRate < 0.2;
			row.flag = compacted
				? "compacted"
				: row.drop && row.systemChanged
					? "prefix_change_drop"
					: row.systemChanged
						? "prefix_change"
						: row.drop && row.toolsChanged
							? "tools_change_drop"
							: row.toolsChanged
								? "tools_change"
								: row.drop
									? "drop_unchanged"
									: null;

			if (kept.length >= wanted) kept.shift();
			kept.push(row);
			total += 1;
			previous = row;
			previousSystemHash = hashes.system;
			previousToolsHash = hashes.tools;
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	const offset = total - kept.length;
	kept.forEach((row, index) => {
		row.seq = offset + index + 1;
	});
	return { rows: kept.slice().reverse(), truncated: total > wanted };
}

function summarize(rows: readonly RequestStatRow[]): RequestStatsSummary {
	const summary: RequestStatsSummary = {
		requests: rows.length,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		promptTokens: 0,
		hitRate: 0,
		fullMisses: 0,
		drops: 0,
		suspects: 0,
		prefixChanges: 0,
	};
	for (const row of rows) {
		summary.inputTokens += row.inputTokens;
		summary.outputTokens += row.outputTokens;
		summary.cacheReadTokens += row.cacheReadTokens;
		summary.cacheWriteTokens += row.cacheWriteTokens;
		summary.promptTokens += row.promptTokens;
		if (row.hitRate < 0.05) summary.fullMisses += 1;
		if (row.drop) summary.drops += 1;
		if (row.flag === "prefix_change_drop") summary.suspects += 1;
		if (row.systemChanged && row.flag !== "compacted") summary.prefixChanges += 1;
	}
	summary.hitRate = summary.promptTokens > 0 ? summary.cacheReadTokens / summary.promptTokens : 0;
	return summary;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 列表端点：最近 500 条请求，100 条一页（新 → 旧）。 */
export async function requestStatsOf(
	conversation: Conversation,
	context: ReadContext,
	conversationId: string,
	options: { page?: number; pageSize?: number; max?: number } = {},
): Promise<RequestStatsPayload> {
	const max = clamp(options.max ?? CACHE_STATS_MAX_REQUESTS, 1, CACHE_STATS_MAX_REQUESTS);
	const pageSize = clamp(options.pageSize ?? CACHE_STATS_PAGE_SIZE, 1, CACHE_STATS_PAGE_SIZE);
	const { rows, truncated } = await recentRequestsOf(conversation, context, max);
	const pages = Math.max(1, Math.ceil(rows.length / pageSize));
	const page = clamp(options.page ?? 1, 1, pages);
	const items = rows.slice((page - 1) * pageSize, page * pageSize);
	return {
		conversationId,
		total: rows.length,
		truncated,
		page,
		pages,
		pageSize,
		max,
		summary: summarize(rows),
		items,
	};
}

function sectionMapOf(view: ContextView): Map<string, string> {
	const current = getCurrentSystemMessage(view.messages);
	const map = new Map<string, string>();
	for (const [key, value] of Object.entries(current?.sections ?? {})) {
		if (typeof value === "string") map.set(key, value);
	}
	return map;
}

function toolDeclarationsOf(view: ContextView): string {
	const tools = getCurrentTools(view.messages).map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	return JSON.stringify(tools);
}

function systemSnapshotOf(view: ContextView): {
	snapshot: RequestSystemSnapshot;
	declarations: string;
	textHash: string;
} {
	const current = getCurrentSystemMessage(view.messages);
	const text = current ? getSystemMessageText(current) : "";
	const sections: RequestSystemSection[] = [];
	for (const [key, value] of Object.entries(current?.sections ?? {})) {
		if (typeof value !== "string") continue;
		sections.push({
			key,
			label: contextSectionLabel(key),
			chars: value.length,
			tokens: estimateTokens(value),
		});
	}
	const tools = getCurrentTools(view.messages);
	const declarations = toolDeclarationsOf(view);
	const textHash = createHash("sha1").update(text).digest("hex").slice(0, 12);
	return {
		snapshot: {
			chars: text.length,
			tokens: estimateTokens(text),
			hash: createHash("sha1")
				.update(text)
				.update("\u0000")
				.update(declarations)
				.digest("hex")
				.slice(0, 12),
			sections,
			tools: tools.length,
		},
		declarations,
		textHash,
	};
}

/** 找 `entryId` 之前最近的一条模型请求（含当前这条之前的 assistant）。 */
async function previousRequestOf(
	conversation: Conversation,
	context: ReadContext,
	entryId: number,
): Promise<RequestStatRow | null> {
	let cursor: Parameters<Conversation["entries"]>[2];
	for (let attempt = 0; attempt < PREV_SCAN_PAGES; attempt += 1) {
		// 第一页用 maxEntryId 截断；之后只带 cursor——durable 的 cursor 自带续扫位置，
		// 再叠一个改过的 maxEntryId 会被当成不同查询。
		const page =
			cursor === undefined
				? await conversation.entries(
						{ maxEntryId: (entryId - 1) as EntryId, order: "descending" },
						256,
						undefined,
						context,
					)
				: await conversation.entries({ order: "descending" }, 256, cursor, context);
		for (const record of page.items) {
			if (record.id >= entryId) continue;
			const message = assistantMessageOf(record);
			if (!message) continue;
			const row = rowOf(record.id, message);
			if (row) return row;
		}
		if (page.next === undefined) return null;
		cursor = page.next;
	}
	return null;
}

interface SnapshotBundle {
	snapshot: RequestSystemSnapshot;
	declarations: string;
	textHash: string;
	sections: Map<string, string>;
}

function compareSystem(current: SnapshotBundle, previous: SnapshotBundle, previousRow: RequestStatRow): RequestCompare {
	const changedSections: string[] = [];
	for (const [key, value] of current.sections) {
		const old = previous.sections.get(key);
		if (old !== undefined && old !== value) changedSections.push(key);
	}
	const addedSections = [...current.sections.keys()].filter((key) => !previous.sections.has(key));
	const removedSections = [...previous.sections.keys()].filter((key) => !current.sections.has(key));
	const currentKeys = [...current.sections.keys()];
	const previousKeys = [...previous.sections.keys()];
	const orderChanged =
		addedSections.length === 0 &&
		removedSections.length === 0 &&
		currentKeys.some((key, index) => previousKeys[index] !== key);
	const toolsChanged = current.declarations !== previous.declarations;
	const currentNames = new Set(
		(JSON.parse(current.declarations) as { name: string }[]).map((tool) => tool.name),
	);
	const previousNames = new Set(
		(JSON.parse(previous.declarations) as { name: string }[]).map((tool) => tool.name),
	);
	return {
		entryId: previousRow.entryId,
		at: previousRow.at,
		// 只看 system 正文；工具面单独报 toolsChanged。
		systemChanged: current.textHash !== previous.textHash,
		changedSections,
		addedSections,
		removedSections,
		orderChanged,
		toolsChanged,
		toolsAdded: [...currentNames].filter((name) => !previousNames.has(name)),
		toolsRemoved: [...previousNames].filter((name) => !currentNames.has(name)),
	};
}

/**
 * 单条请求详情：当时的固定前缀 + 已存档消息 + 与上一条请求的差异。
 * `entryId` 不是模型请求 → null（路由 404）。
 */
export async function requestContextOf(
	conversation: Conversation,
	context: ReadContext,
	conversationId: string,
	entryId: number,
): Promise<RequestContextPayload | null> {
	if (!Number.isFinite(entryId) || entryId <= 0) return null;
	const page = await conversation.entries(
		{ minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId, order: "ascending" },
		1,
		undefined,
		context,
	);
	const record = page.items[0];
	const message = record ? assistantMessageOf(record) : null;
	const row = record && message ? rowOf(record.id, message) : null;
	if (!record || !message || !row) return null;

	const view = await conversation
		.context(context, { at: entryId as EntryId })
		.catch(() => null);
	// entry 在 compaction / 分叉后的当前上下文里不可见：按"不是可读请求"处理，别让端点 500。
	if (!view) return null;
	const inspect = contextInspectViewOf(view);
	const entriesTotal = inspect.entries.length;
	const entries = inspect.entries.slice(-CACHE_STATS_DETAIL_ENTRIES);
	const current = systemSnapshotOf(view);
	const currentSections = sectionMapOf(view);

	const previousRow = await previousRequestOf(conversation, context, entryId);
	let compare: RequestCompare | null = null;
	if (previousRow) {
		const previousView = await conversation
			.context(context, { at: previousRow.entryId as EntryId })
			.catch(() => null);
		if (previousView) {
			compare = compareSystem(
				{ ...current, sections: currentSections },
				{ ...systemSnapshotOf(previousView), sections: sectionMapOf(previousView) },
				previousRow,
			);
		}
	}

	return {
		conversationId,
		request: row,
		context: {
			...inspect,
			entries,
			entriesTotal,
			entriesOmitted: Math.max(0, entriesTotal - entries.length),
		},
		system: current.snapshot,
		compare,
		note: "请求时的临时注入（记忆召回 / 当前项目 / 执事上下文）不写进对话存档，这里只能看到固定前缀与已存档消息。",
	};
}
