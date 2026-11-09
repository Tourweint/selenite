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
	/** 只搜最近多少天，默认 30，收敛到 1..365。 */
	days?: number;
	/** 最多几条命中，默认 5，收敛到 1..20。 */
	limit?: number;
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
const MAX_DAYS = 365;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
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

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * 纯检索核心：给定若干会话的 transcript 行，返回命中片段。
 *
 * 抽成纯函数是为了让 §4.4 的用例不必真起 durable：跨两个会话建数据、
 * 验 days/limit/snippet 截断都在这里完成；durable 适配层只负责"把库读成这个形状"。
 */
export function searchTranscriptLines(
	sources: TranscriptSource[],
	query: string,
	options: SessionSearchOptions = {},
	now: number = Date.now(),
): SessionSearchHit[] {
	const needle = query.trim().toLowerCase();
	// 1 个字会把整个库捞出来；与 searchTranscripts 同口径，短于 2 字直接空。
	if (needle.length < 2) return [];
	const days = clampInt(options.days, DEFAULT_DAYS, 1, MAX_DAYS);
	const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
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

	return hits.sort((a, b) => b.at - a.at).slice(0, limit);
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

	return searchTranscriptLines(sources, query, options, now);
}
