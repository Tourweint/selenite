import { readFileSync } from "node:fs";
import { contentText } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { redactSecrets } from "@lifediary/memory";
import { CTX, Chats } from "./shared.ts";

/**
 * 会话考古：跨会话检索 transcript（2026-11-09 T4 §4）。
 *
 * 记忆四层记的是"提炼过的事实"，但用户经常问的是"上个月咱们是不是聊过 X"——
 * 这句话可能出现在执事会话、群聊、任务专线，而不在任何一条记忆里。
 * 这里直接在**本机 durable 的全部会话**里做子串检索，只读、不建索引、不做向量。
 *
 * 与 `session.ts:searchTranscripts` 的关系：那个是"历史对话列表"里的搜索，
 * 刻意跳过任务专线与已隐藏会话；本工具要覆盖"所有会话"，所以单独走一份
 * 读取逻辑（复用同一套 Chats 映射与 transcript 结构），不去改列表搜索的语义。
 *
 * 隐私：
 *   - 只读本机自己的库（没有远程/跨设备调用）；
 *   - snippet 落回模型前过一遍 `redactSecrets`（T4 §2 的同一把尺子）；
 *   - 日志只记 query 字数与命中条数，不记正文。
 */

export interface SessionSearchHit {
	/** 对外会话 uuid（与 listChats 同一个 id 空间） */
	conversationId: string;
	/** 会话标题；没有改过名就用首条用户消息 */
	title: string;
	/** 命中消息的时间（epoch ms） */
	at: number;
	/** 命中处前后各约 100 字，整段 ≤ 200 字；凭据已打码 */
	snippet: string;
}

export interface SessionSearchOptions {
	/** 只搜最近多少天，默认 30，收敛到 1..36500（约一百年 = 实际不设下限）。 */
	days?: number;
	/** 最多几条命中，默认 5，收敛到 1..20。 */
	limit?: number;
	/** 跳过最新的多少条命中（分页用），默认 0，收敛到 0..1000000。 */
	offset?: number;
}

/** 一条可检索的 transcript 行（角色不在工具输出里，留着给测试与将来扩展）。 */
export interface TranscriptLine {
	role: "user" | "assistant";
	text: string;
	at: number;
}

export interface TranscriptSource {
	conversationId: string;
	title: string;
	lines: TranscriptLine[];
}

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
/**
 * 时间窗上限（2026-11-12 搜索页要"查看更多 / 更早的历史"）：原来 365 天是给
 * `recall_sessions` 工具收着用的。一百年 = 实际不设下限；工具的默认窗口仍是 30 天。
 * 分页由 limit + offset 管，与时间窗正交。
 */
const MAX_DAYS = 36_500;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_OFFSET = 1_000_000;
/** snippet 硬上限：命中处前后各 100 字。 */
export const SNIPPET_MAX_CHARS = 200;

/**
 * 工具上架开关（`AGENT_RECALL_SESSIONS`，默认开）。false/0/off → 工具不上架，
 * 与 `send_to_agent` 的回滚形态一致（模型侧 tool_unavailable，一行回滚）。
 */
export function recallSessionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.AGENT_RECALL_SESSIONS?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * 只读搜索端点的回滚开关（2026-11-10 批 28 §二）：默认开。
 * `AGENT_SESSIONS_SEARCH=false` → `GET /api/v1/agent/sessions/search` 整组 404
 * （与工具上架开关同口径，一行退回"没有这个端点"的形态）。
 * 刻意与 `AGENT_RECALL_SESSIONS` 分开：关模型工具不等于要关掉界面「找旧事」。
 */
export function sessionSearchApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.AGENT_SESSIONS_SEARCH?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * 只读搜索端点的查询参数解析（2026-11-10 批 28 §二）：纯函数，单测不必起 Hono。
 * 空 / 短查询 → null（调用方回 400）；days / limit 透传给 `searchTranscriptLines` 收敛。
 */
export interface SessionSearchQuery {
	query: string;
	options: SessionSearchOptions;
}
export function parseSessionSearchQuery(raw: {
	q?: string;
	days?: string;
	limit?: string;
	offset?: string;
}): SessionSearchQuery | null {
	const query = (raw.q ?? "").trim();
	// 与检索核心同阈值（短于 2 字直接空），但这里有明确边界：空/短查询是 bad_request，
	// 不静默返回 `{hits:[]}` 让界面误以为"没有匹配"。
	if (query.length < 2) return null;
	const options: SessionSearchOptions = {};
	const daysRaw = raw.days?.trim();
	const limitRaw = raw.limit?.trim();
	const offsetRaw = raw.offset?.trim();
	const days = daysRaw ? Number(daysRaw) : undefined;
	const limit = limitRaw ? Number(limitRaw) : undefined;
	const offset = offsetRaw ? Number(offsetRaw) : undefined;
	if (days !== undefined && Number.isFinite(days)) options.days = days;
	if (limit !== undefined && Number.isFinite(limit)) options.limit = limit;
	if (offset !== undefined && Number.isFinite(offset)) options.offset = offset;
	return { query, options };
}

/**
 * 命中消息在会话正文（`readTranscript(chat, 0)` 口径）里的下标，供只读 UI 直接当
 * `GET .../context?aroundIndex=` 用（2026-11-10 批 28 §二）。
 *
 * `searchSessions` 的 hit 带 `at`（消息时间戳）与 snippet，但没有下标；定点找回端点
 * 用的是消息数组下标。这里用「时间一致 + 正文含命中词」精确定位，取不到再按时间就近。
 * 纯函数：不碰 durable，单测可直接造消息数组断言。
 */
export function findAroundIndex(
	messages: ReadonlyArray<{ text: string; at: number }>,
	hit: { at: number },
	query: string,
): number {
	const needle = query.trim().toLowerCase();
	if (needle.length >= 2) {
		const exact = messages.findIndex(
			(m) => m.at === hit.at && m.text.toLowerCase().includes(needle),
		);
		if (exact >= 0) return exact;
		const byText = messages.findIndex((m) => m.text.toLowerCase().includes(needle));
		if (byText >= 0) return byText;
	}
	if (messages.length === 0) return 0;
	let best = 0;
	let bestDelta = Math.abs(messages[0]!.at - hit.at);
	for (let i = 1; i < messages.length; i += 1) {
		const delta = Math.abs(messages[i]!.at - hit.at);
		if (delta < bestDelta) {
			best = i;
			bestDelta = delta;
		}
	}
	return best;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * 一次扫描：收集全部命中并按时间倒序（分页与计数共用）。
 * 扫描代价与 `sources` 大小同阶；只有显式搜索会走这里，不做后台预跑。
 */
function collectTranscriptHits(
	sources: TranscriptSource[],
	query: string,
	options: SessionSearchOptions,
	now: number,
): { sorted: SessionSearchHit[]; total: number } {
	const needle = query.trim().toLowerCase();
	// 1 个字会把整个库捞出来；与 searchTranscripts 同口径，短于 2 字直接空。
	if (needle.length < 2) return { sorted: [], total: 0 };
	const days = clampInt(options.days, DEFAULT_DAYS, 1, MAX_DAYS);
	const cutoff = now - days * DAY_MS;

	const hits: SessionSearchHit[] = [];
	for (const source of sources) {
		for (const line of source.lines) {
			if (!line.text || line.at < cutoff) continue;
			const index = line.text.toLowerCase().indexOf(needle);
			if (index === -1) continue;
			// 命中处前后各 100 字：从 index-100 起裁 200，保证整段不超过上限。
			const start = Math.max(0, index - 100);
			const snippet = redactSecrets(line.text.slice(start, start + SNIPPET_MAX_CHARS)).trim();
			hits.push({
				conversationId: source.conversationId,
				title: source.title,
				at: line.at,
				snippet,
			});
		}
	}

	const sorted = hits.sort((a, b) => b.at - a.at);
	return { sorted, total: sorted.length };
}

/**
 * 纯检索核心：给定若干会话的 transcript 行，返回**一页**命中片段。
 *
 * 抽成纯函数是为了让 §4.4 的用例不必真起 durable：跨两个会话建数据、
 * 验 days/limit/offset/snippet 截断都在这里完成；durable 适配层只负责"把库读成这个形状"。
 */
export function searchTranscriptLines(
	sources: TranscriptSource[],
	query: string,
	options: SessionSearchOptions = {},
	now: number = Date.now(),
): SessionSearchHit[] {
	const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = clampInt(options.offset, 0, 0, MAX_OFFSET);
	const { sorted } = collectTranscriptHits(sources, query, options, now);
	return sorted.slice(offset, offset + limit);
}

/**
 * 与 `searchTranscriptLines` 同一次扫描，额外回 `total`（命中总数，未分页）。
 * 搜索页要靠它显示"还有 N 处"；分开导出是为了不改变工具侧
 * `recall_sessions` 的函数形状（它只要数组）。
 */
export function searchTranscriptPage(
	sources: TranscriptSource[],
	query: string,
	options: SessionSearchOptions = {},
	now: number = Date.now(),
): { hits: SessionSearchHit[]; total: number } {
	const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = clampInt(options.offset, 0, 0, MAX_OFFSET);
	const { sorted, total } = collectTranscriptHits(sources, query, options, now);
	return { hits: sorted.slice(offset, offset + limit), total };
}

/** durable 的最小读取面：测试注入假实现，生产传 Harness。 */
export interface SessionReader {
	snapshot(
		doc: typeof Chats,
		ctx: typeof CTX,
	): Promise<{ byExternal?: Record<string, number> } | undefined>;
	conversation(id: never, ctx: typeof CTX): Promise<Conversation | undefined>;
}

/**
 * 会话标题存在 `.data/chat-meta.json`（durable 没有标题概念，见 session.ts）。
 *
 * 为什么在这里重读而不 import `chatTitles()`：`session.ts` 依赖 `lifecycle.ts`，
 * 而 `lifecycle.ts` 又要 import 本模块去装配工具——反向 import 会成环。
 * 读的是一份只有 `titles` 的 JSON，重复这一小段比拆环便宜。
 */
function readChatTitles(): Record<string, string> {
	const path = process.env.AGENT_CHAT_META_PATH?.trim() || ".data/chat-meta.json";
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { titles?: unknown };
		if (parsed.titles && typeof parsed.titles === "object") {
			return parsed.titles as Record<string, string>;
		}
	} catch {
		// 没有改名文件 = 全部用首句，不影响检索
	}
	return {};
}

function firstUserText(lines: TranscriptLine[]): string {
	const first = lines.find((line) => line.role === "user" && line.text);
	return first ? first.text.slice(0, 40) : "";
}

/**
 * 跨所有会话检索（含执事 / 群 / 任务专线）。
 *
 * 逐会话打开读 context，代价与 `listChats` 同口径：本机个人规模（几十到几百个会话）
 * 一次显式调用可接受；真慢了再上 FTS 索引，不在这一版引入。
 */
export async function searchSessions(
	reader: SessionReader,
	query: string,
	options: SessionSearchOptions = {},
	now: number = Date.now(),
): Promise<SessionSearchHit[]> {
	if (query.trim().length < 2) return [];
	return searchTranscriptLines(await readTranscriptSources(reader), query, options, now);
}

/**
 * 与 `searchSessions` 同一份读取 + 扫描，回 `{hits, total}`（2026-11-12 搜索页分页）。
 * 只读、无副作用；`total` 是未分页的命中总数。
 */
export async function searchSessionsPage(
	reader: SessionReader,
	query: string,
	options: SessionSearchOptions = {},
	now: number = Date.now(),
): Promise<{ hits: SessionSearchHit[]; total: number }> {
	if (query.trim().length < 2) return { hits: [], total: 0 };
	return searchTranscriptPage(await readTranscriptSources(reader), query, options, now);
}

/** 把 durable 的全部会话读成可检索行（逐会话打开；读失败跳过，不挡整查）。 */
async function readTranscriptSources(reader: SessionReader): Promise<TranscriptSource[]> {
	const chats = await reader.snapshot(Chats, CTX);
	const titles = readChatTitles();
	const sources: TranscriptSource[] = [];

	for (const [conversationId, internalId] of Object.entries(chats?.byExternal ?? {})) {
		try {
			const conversation = await reader.conversation(internalId as never, CTX);
			if (!conversation) continue;
			const view = await conversation.context(CTX);
			const lines: TranscriptLine[] = [];
			for (const entry of view.entries) {
				if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
				const message = entry.model?.[0];
				if (!message) continue;
				const text = contentText(message.content).trim();
				if (!text) continue;
				const at = typeof message.timestamp === "number" ? message.timestamp : 0;
				lines.push({ role: entry.kind === "pi.user" ? "user" : "assistant", text, at });
			}
			if (lines.length === 0) continue;
			sources.push({
				conversationId,
				// 标题可能来自用户首句（"我的 key 是 sk-…"），同一把尺子过一遍
				title: redactSecrets(titles[conversationId]?.trim() || firstUserText(lines)),
				lines,
			});
		} catch (error) {
			// 单个会话读失败不挡整查（与 listChats / searchTranscripts 同口径）；只记 id 与原因
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[recall_sessions] 会话 ${conversationId} 读取失败: ${detail}`);
		}
	}

	return sources;
}
