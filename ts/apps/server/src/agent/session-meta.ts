/**
 * 会话元信息（索引条目 / ChatMeta 读写 / 改名 / 归档护栏 / 孤儿清理）
 *
 * 2026-11-13 从 session.ts 的 L1623–L1883 整段切出；正文原文搬运，未改一行实现。
 */

import { getHarness } from "./lifecycle.ts";
import { CTX, Chats } from "./shared.ts";
import { ChatKind } from "@lifediary/shared";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openChat } from "./session-open.ts";
import { conversationIsBusy } from "./session-stream.ts";

export interface ChatIndexEntry {
	conversationId: string;
	createdAt: number;
	lastAt: number;
	firstText: string;
	turns: number;
	/** 用户改过的名字；没有就用 firstText */
	title?: string;
	/** 是否置顶（2026-11-04 批次一）；置顶的排前面由客户端处理 */
	pinned?: boolean;
	/** 会话种类（2026-11-06 侧栏调整 B2，纯增量）：前端据此筛"总管"入口，不按 id 猜身份 */
	chatKind: ChatKind;
	/**
	 * 以下四个是归档清单（2026-11-12 归档模块 §3）的增量字段：
	 * 活跃清单不改变现有字段，只有 `GET /agent/chats/archived` 保证带 `archived` / `archivedAt`。
	 */
	archived?: boolean;
	archivedAt?: number;
	projectId?: string;
	projectName?: string;
}

export interface ChatMeta {
	titles: Record<string, string>;
	archived: string[];
	/** 归档时间（epoch 毫秒）；旧数据可能没有，读不到就回退到最后一句时间 */
	archivedAt: Record<string, number>;
	/** 置顶的会话 id，按置顶先后排（2026-11-04 批次一） */
	pins: string[];
}

const CHAT_META_PATH =
	process.env.AGENT_CHAT_META_PATH?.trim() || ".data/chat-meta.json";

export function readChatMeta(): ChatMeta {
	try {
		const parsed = JSON.parse(readFileSync(CHAT_META_PATH, "utf8")) as Partial<ChatMeta> & {
			hidden?: unknown;
		};
		// 兼容旧键：2026-11-12 之前叫 hidden
		const archived = Array.isArray(parsed.archived)
			? parsed.archived.filter((id): id is string => typeof id === "string")
			: Array.isArray(parsed.hidden)
				? parsed.hidden.filter((id): id is string => typeof id === "string")
				: [];
		const archivedAt: Record<string, number> = {};
		if (parsed.archivedAt && typeof parsed.archivedAt === "object" && !Array.isArray(parsed.archivedAt)) {
			for (const [id, at] of Object.entries(parsed.archivedAt)) {
				if (typeof at === "number" && Number.isFinite(at)) archivedAt[id] = at;
			}
		}
		return {
			titles:
				parsed.titles && typeof parsed.titles === "object" ? parsed.titles : {},
			archived,
			archivedAt,
			pins: Array.isArray(parsed.pins) ? parsed.pins : [],
		};
	} catch {
		// 文件不存在或坏了：当作没改过名、没归档过，不影响会话本身
		return { titles: {}, archived: [], archivedAt: {}, pins: [] };
	}
}

function writeChatMeta(meta: ChatMeta): void {
	// 原子写（2026-11-13 永久删除批A，参照 flags.ts 的 atomicWrite）：临时文件 + rename。
	// 以前是就地 writeFileSync，进程中途被杀会留下半截 JSON，重启后整份 chat-meta 当空处理
	// （标题/归档/置顶全丢）。永久删除也走这条路，写失败代价变高了，先补上这层。
	mkdirSync(dirname(CHAT_META_PATH), { recursive: true });
	const temp = `${CHAT_META_PATH}.tmp-${process.pid}-${Date.now()}`;
	try {
		// 只写新键：旧 `hidden` 不回写，回滚代码仍能读新键
		writeFileSync(temp, JSON.stringify(meta, null, 2), "utf8");
		renameSync(temp, CHAT_META_PATH);
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			/* 清理失败就算了，别盖住原始错误 */
		}
		throw error;
	}
}

export function purgeChatMetaEntries(conversationIds: readonly string[]): void {
	const meta = readChatMeta();
	let changed = false;
	for (const conversationId of conversationIds) {
		if (conversationId in meta.titles) {
			delete meta.titles[conversationId];
			changed = true;
		}
		const archivedIndex = meta.archived.indexOf(conversationId);
		if (archivedIndex !== -1) {
			meta.archived.splice(archivedIndex, 1);
			changed = true;
		}
		if (conversationId in meta.archivedAt) {
			delete meta.archivedAt[conversationId];
			changed = true;
		}
		const pinIndex = meta.pins.indexOf(conversationId);
		if (pinIndex !== -1) {
			meta.pins.splice(pinIndex, 1);
			changed = true;
		}
	}
	if (changed) writeChatMeta(meta);
}

export function renameChat(conversationId: string, title: string): { title?: string } {
	const meta = readChatMeta();
	const clean = title.trim().slice(0, 80);
	if (clean) meta.titles[conversationId] = clean;
	else delete meta.titles[conversationId];
	writeChatMeta(meta);
	return { title: clean || undefined };
}

export function archiveChat(conversationId: string, at = Date.now()): void {
	const meta = readChatMeta();
	if (!meta.archived.includes(conversationId)) meta.archived.push(conversationId);
	meta.archivedAt[conversationId] = at;
	writeChatMeta(meta);
}

export async function archiveChatGuarded(
	conversationId: string,
): Promise<{ ok: true } | { ok: false; status: 400; error: string; message: string }> {
	try {
		const chat = await openChat(conversationId);
		if (chat && (await conversationIsBusy(chat.conversation))) {
			return {
				ok: false,
				status: 400,
				error: "conversation_busy",
				message: "会话正在运行，请先停止再归档",
			};
		}
	} catch (error) {
		// harness 打不开（存储抖动 / 未配置模型）不该挡归档：按空闲处理，行为与改动前一致
		console.warn(
			`[chats] 归档前判忙失败，按空闲处理: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	archiveChat(conversationId);
	return { ok: true };
}

export const hideChat = archiveChat;

export function unarchiveChat(conversationId: string): void {
	const meta = readChatMeta();
	const index = meta.archived.indexOf(conversationId);
	const hadAt = conversationId in meta.archivedAt;
	if (index === -1 && !hadAt) return;
	if (index !== -1) meta.archived.splice(index, 1);
	delete meta.archivedAt[conversationId];
	writeChatMeta(meta);
}

export function pinChat(conversationId: string, pinned: boolean): boolean {
	const meta = readChatMeta();
	const index = meta.pins.indexOf(conversationId);
	if (pinned && index === -1) meta.pins.push(conversationId);
	if (!pinned && index !== -1) meta.pins.splice(index, 1);
	if (index !== -1 || pinned) writeChatMeta(meta);
	return pinned && meta.pins.includes(conversationId);
}

export function restoreArchivedChats(): number {
	const meta = readChatMeta();
	const count = meta.archived.length;
	meta.archived = [];
	meta.archivedAt = {};
	writeChatMeta(meta);
	return count;
}

export const restoreChats = restoreArchivedChats;

export function chatMetaSummary(): { archived: number } {
	return { archived: readChatMeta().archived.length };
}

export async function pruneChatMetaOrphans(): Promise<number> {
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const live = new Set(Object.keys(chats?.byExternal ?? {}));
	const meta = readChatMeta();
	const archived = meta.archived.filter((id) => live.has(id));
	const pins = meta.pins.filter((id) => live.has(id));
	const titles = Object.fromEntries(Object.entries(meta.titles).filter(([id]) => live.has(id)));
	const archivedAt = Object.fromEntries(
		Object.entries(meta.archivedAt).filter(([id]) => live.has(id)),
	);
	const removed =
		meta.archived.length -
		archived.length +
		(meta.pins.length - pins.length) +
		(Object.keys(meta.titles).length - Object.keys(titles).length);
	if (removed === 0) return 0;
	writeChatMeta({ titles, archived, archivedAt, pins });
	console.log(`[chats] 清理 chat-meta 孤儿条目：${removed} 条`);
	return removed;
}

export { CHAT_META_PATH, writeChatMeta };
