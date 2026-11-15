import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { isRelayEntryKind } from "../partner-relay.ts";
import { CTX, type ResolvedChat } from "./shared.ts";
import { foldTranscriptEntries, type TranscriptMessage } from "./session.ts";

/**
 * 一轮的开头（2026-11-15 作者标记方案 D6）：主人输入，或执事递来的话。
 *
 * 递话会触发一整轮 run，所以它必须和 `pi.user` 一样切轮；不切的话来信会和
 * 上一轮的步骤、上一轮的回答黏在同一轮里。
 */
function startsTurn(kind: string): boolean {
	return kind === "pi.user" || isRelayEntryKind(kind);
}

/**
 * 对话历史的倒序游标分页（2026-11-13 方案「按天分组·上滑加载」）。
 *
 * 为什么不在 `readTranscript` 上直接加 offset：那条路是"整段 context() 读进来再切"，
 * 对话越长每次打开越慢。这里走 pi-durable 的 `Conversation.entries()`——SQLite 上有
 * `(conversation_id, id DESC)` 索引，只读这一页涉及的行。
 *
 * 三条硬约束：
 * 1. **不切轮**：一页的最小单位是"轮"（`pi.user` 开头，含工具步骤和最终回答）。
 *    在一轮中间切，历史里的工具步骤会丢掉一半。
 * 2. **按天优先**：累计够 `HISTORY_PAGE_MIN` 条后，遇到上一天就在日界收页；
 *    某一天特别长则按 `limit` 当天分段。日期标签由前端按 `at` 渲染，服务端只决定边界。
 * 3. **活跃上下文**：`entries()` 是 fork-aware 全历史（含 reset/压缩之前的旧段），
 *    而 `context()` 只给最新 head 之后的部分。倒扫遇到第一个带 `head` 的 entry 就停，
 *    保持与老 `readTranscript` 完全相同的"历史"含义。
 *
 * 游标不透明：AES-256-GCM 加密 `{c: 会话对外 uuid, m: entry 上界}`。durable 的
 * 自增整数不进响应；跨会话、改过 AGENT_TOKEN、随手编的游标一律解不开（端点回 400）。
 */

export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 200;
/** 一页至少凑这么多条再考虑日界，避免"今天只有 1 句"时首屏太空。 */
export const HISTORY_PAGE_MIN = 20;

/** 单次向 durable 要多少条 entry；多取几条比多次往返便宜。 */
const ENTRY_BATCH = 200;
/**
 * 一页最多扫多少 entry 的保险丝：正常一页几十条 entry 就够；
 * 真遇到一轮里几千个工具结果，宁可这一页少收几轮，也不把请求拖死。
 */
const MAX_SCAN_ENTRIES = 4000;

export interface TranscriptPage {
	messages: TranscriptMessage[];
	hasMore: boolean;
	/** 下一页的游标（不透明）；没有更早的消息时不带。 */
	nextBefore?: string;
}

interface Turn {
	/** 升序（最老的在最前），第一项通常是 pi.user */
	entries: EntryRecord[];
	messages: TranscriptMessage[];
}

/** 本地日历日（服务端时区）：跨天边界用；时间戳缺失返回 null，不参与日界判断。 */
export function historyDayKeyOf(at: number | undefined): string | null {
	if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
	const d = new Date(at);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 一轮的提问时间（算日界用）；没有 user（或递话条目）就返回 undefined。 */
function turnStartOf(entries: readonly EntryRecord[]): number | undefined {
	for (const entry of entries) {
		if (!startsTurn(entry.kind)) continue;
		const timestamp = entry.model?.[0]?.timestamp;
		return typeof timestamp === "number" ? timestamp : undefined;
	}
	return undefined;
}

/** 把一次扫描到的 entry 按"轮"切开（入参升序，返回的每一轮也升序）。 */
function splitTurns(externalId: string, entries: readonly EntryRecord[]): Turn[] {
	const turns: Turn[] = [];
	let current: EntryRecord[] = [];
	for (const entry of entries) {
		current.push(entry);
		if (!startsTurn(entry.kind)) continue;
		turns.push({ entries: current, messages: foldTranscriptEntries(externalId, current) });
		current = [];
	}
	if (current.length > 0) {
		turns.push({ entries: current, messages: foldTranscriptEntries(externalId, current) });
	}
	return turns;
}

/**
 * 读一页历史（新的在后，与老 `/messages` 的顺序一致）。
 *
 * @param beforeMaxEntryId 上一页给的上界（含）；不传 = 从最新一头开始
 */
export async function readTranscriptPage(
	chat: ResolvedChat,
	options: { limit?: number; beforeMaxEntryId?: number } = {},
): Promise<TranscriptPage> {
	const limit = Math.min(
		HISTORY_PAGE_MAX,
		Math.max(1, Math.floor(options.limit ?? HISTORY_PAGE_DEFAULT)),
	);
	const minPage = Math.min(HISTORY_PAGE_MIN, limit);
	const turns: Turn[] = [];
	let messageCount = 0;
	let oldestDay: string | null = null;
	let scanned = 0;
	let reachedHead = false;
	let hasMore = false;
	let cursor: Cursor | undefined;
	/** 跨 batch 的半轮（倒序累的，等遇到 pi.user / 递话条目才成轮） */
	let pendingDesc: EntryRecord[] = [];

	scan: while (true) {
		const page = await chat.conversation.entries(
			{
				...(options.beforeMaxEntryId === undefined
					? {}
					: { maxEntryId: options.beforeMaxEntryId as never }),
				order: "descending",
			},
			ENTRY_BATCH,
			cursor,
			CTX,
		);

		for (let index = 0; index < page.items.length; index += 1) {
			const entry = page.items[index]!;
			scanned += 1;
			if (entry.head !== undefined) reachedHead = true;
			pendingDesc.push(entry);

			if (!startsTurn(entry.kind) && !reachedHead) continue;

			// 倒序累到一条 pi.user（或递话条目）= 这一轮收齐了；翻成升序再折叠
			const turnEntries = pendingDesc.slice().reverse();
			pendingDesc = [];
			const turnMessages = foldTranscriptEntries(chat.externalId, turnEntries);
			const turnDay = historyDayKeyOf(turnStartOf(turnEntries));

			// 先判断"这一轮要不要留到下一页"：日界到了 / 再加就超页上限
			const dayBreak =
				turns.length > 0 &&
				messageCount >= minPage &&
				oldestDay !== null &&
				turnDay !== null &&
				turnDay !== oldestDay;
			const overflow =
				turns.length > 0 && messageCount + turnMessages.length > limit;
			if (dayBreak || overflow) {
				hasMore = true;
				break scan;
			}

			turns.push({ entries: turnEntries, messages: turnMessages });
			messageCount += turnMessages.length;
			if (turnDay !== null) oldestDay = turnDay;

			if (reachedHead) break scan;
			if (messageCount >= limit) {
				// 这一轮收完就够页了；本条之后还有没有更老的，看同一批里还有没有剩
				hasMore = index < page.items.length - 1 || page.next !== undefined;
				break scan;
			}
		}

		if (scanned >= MAX_SCAN_ENTRIES) {
			hasMore = true;
			break;
		}
		if (!page.next) break;
		cursor = page.next;
	}

	// 扫到会话开头/head 边界，但还有半轮没闭合（例如只有系统 entry）：也折进来
	if (pendingDesc.length > 0 && !hasMore) {
		for (const turn of splitTurns(chat.externalId, pendingDesc.slice().reverse())) {
			turns.push(turn);
		}
	}

	// 如果是因为日界/超页停的，下一批还有东西；已经标了 hasMore。若停在 head 上则没有。
	if (reachedHead) hasMore = false;

	const ordered = turns.slice().reverse();
	const messages = ordered.flatMap((turn) => turn.messages);
	const oldest = ordered[0]?.entries[0];
	const nextBefore =
		hasMore && oldest !== undefined && Number(oldest.id) > 1
			? encodeHistoryCursor(chat.externalId, Number(oldest.id) - 1)
			: undefined;

	return { messages, hasMore: nextBefore !== undefined, ...(nextBefore ? { nextBefore } : {}) };
}

/** 游标密钥：跟 AGENT_TOKEN 绑，改令牌 = 旧游标作废（客户端回落到最新一页，不崩）。 */
function cursorKey(): Buffer {
	return createHash("sha256")
		.update(`lifediary-history-cursor:${process.env.AGENT_TOKEN ?? ""}`)
		.digest();
}

/** 把 entry 上界封进不透明串。对外只当游标用，不解析、不展示。 */
export function encodeHistoryCursor(conversationId: string, maxEntryId: number): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", cursorKey(), iv);
	const body = Buffer.concat([
		cipher.update(JSON.stringify({ v: 1, c: conversationId, m: maxEntryId }), "utf8"),
		cipher.final(),
	]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** 解游标；跨会话、被改过、格式不对一律 null（端点回 400，不猜也不回退）。 */
export function decodeHistoryCursor(
	conversationId: string,
	token: string,
): number | null {
	try {
		const raw = Buffer.from(token, "base64url");
		if (raw.length <= 28) return null;
		const iv = raw.subarray(0, 12);
		const tag = raw.subarray(12, 28);
		const body = raw.subarray(28);
		const decipher = createDecipheriv("aes-256-gcm", cursorKey(), iv);
		decipher.setAuthTag(tag);
		const parsed = JSON.parse(
			Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"),
		) as { v?: unknown; c?: unknown; m?: unknown };
		if (parsed.v !== 1) return null;
		if (parsed.c !== conversationId) return null;
		if (typeof parsed.m !== "number" || !Number.isSafeInteger(parsed.m) || parsed.m < 0) {
			return null;
		}
		return parsed.m;
	} catch {
		return null;
	}
}
