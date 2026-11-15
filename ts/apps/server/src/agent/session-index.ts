/**
 * 会话列表（标题 / 项目归属 / 记忆视图 / 统计 / 列表与导出）
 *
 * 2026-11-13 从 session.ts 的 L1884–L2261 整段切出；正文原文搬运，未改一行实现。
 */

import { memoryExtractMode, preferenceExtractionEnabled } from "../memory-extract.ts";
import { projectsStore } from "../projects.ts";
import { readLlmConfig } from "../provider.ts";
import { memoryEngine } from "./assist.ts";
import { getHarness } from "./lifecycle.ts";
import { CTX, ChatKinds, ChatProjects, Chats, TASK_CONVERSATION_PREFIX } from "./shared.ts";
import { contentText } from "@earendil-works/pi-ai";
import type { MemoryKind, MemoryRecord } from "@lifediary/memory";
import { parseFileManifest } from "@lifediary/shared";
import { chatKindOfInternal } from "./session-open.ts";
import { archiveChat, readChatMeta } from "./session-meta.ts";
import type { ChatIndexEntry, ChatMeta } from "./session-meta.ts";

export function chatTitles(): Record<string, string> {
	return { ...readChatMeta().titles };
}

const PARTNER_CONVERSATION_PREFIX = "partner-";

export function projectChatExternalIds(
	chatProjects: Record<string, string>,
	chatsByExternal: Record<string, number>,
	projectId: string,
): string[] {
	const externalByInternal = new Map<number, string>();
	for (const [externalId, internalId] of Object.entries(chatsByExternal)) {
		externalByInternal.set(Number(internalId), externalId);
	}
	const result: string[] = [];
	for (const [internalId, mappedProjectId] of Object.entries(chatProjects)) {
		if (mappedProjectId !== projectId) continue;
		const externalId = externalByInternal.get(Number(internalId));
		if (!externalId) continue;
		if (externalId.startsWith(TASK_CONVERSATION_PREFIX)) continue;
		if (externalId.startsWith(PARTNER_CONVERSATION_PREFIX)) continue;
		result.push(externalId);
	}
	return result;
}

export async function archiveChatsOfProject(projectId: string): Promise<number> {
	if (!projectId) return 0;
	const harness = await getHarness();
	const [chats, chatProjects] = await Promise.all([
		harness.snapshot(Chats, CTX),
		harness.snapshot(ChatProjects, CTX),
	]);
	const externalIds = projectChatExternalIds(
		chatProjects?.byInternal ?? {},
		chats?.byExternal ?? {},
		projectId,
	);
	const at = Date.now();
	for (const externalId of externalIds) archiveChat(externalId, at);
	return externalIds.length;
}

export interface MemoryView {
	id: string;
	kind: string;
	scope: string;
	content: string;
	importance: number;
	veracity: string;
	source: string;
	createdAt: string;
	recallCount: number;
	supersededBy: string | null;
	/** 上次被召回 / 使用时间（2026-11-13 A 版页脚与行内元信息用；老库为 null）。 */
	lastRecalledAt: string | null;
	usageCount: number;
	/** 意图的到期时间（只有 kind=intention 有意义）。 */
	expiresAt: string | null;
}

export interface MemoryOverview {
	enabled: boolean;
	/** 抽取档位：llm / rule / auto 实际生效的结果 */
	extract: string;
	/** 当前过滤条件下的真实条数（不是本页条数）；2026-11-13 起改口径。 */
	total: number;
	/** 兼容旧客户端：同 counts.byKind（真实计数）。 */
	byKind: Record<string, number>;
	/** 2026-11-13：真实分类计数 + 已被取代条数。 */
	counts: { all: number; byKind: Record<string, number>; superseded: number };
	items: MemoryView[];
	offset: number;
	limit: number;
	hasMore: boolean;
}

function memoryView(record: MemoryRecord): MemoryView {
	return {
		id: record.id,
		kind: record.kind,
		scope: record.scope,
		content: record.content,
		importance: record.importance,
		veracity: record.veracity,
		source: record.source,
		createdAt: record.createdAt,
		recallCount: record.recallCount,
		supersededBy: record.supersededBy,
		lastRecalledAt: record.lastRecalledAt,
		usageCount: record.usageCount ?? 0,
		expiresAt: record.expiresAt ?? null,
	};
}

export function memoryOverview(
	options: {
		scope?: string;
		limit?: number;
		offset?: number;
		q?: string;
		kinds?: MemoryKind[];
		excludeKinds?: MemoryKind[];
	} = {},
): MemoryOverview {
	const empty = {
		enabled: false,
		extract: memoryExtractMode(),
		total: 0,
		byKind: {},
		counts: { all: 0, byKind: {}, superseded: 0 },
		items: [],
		offset: 0,
		limit: 0,
		hasMore: false,
	};
	if (!memoryEngine) return empty;
	try {
		const scope = options.scope?.trim() || "global";
		const q = options.q?.trim().slice(0, 200) || undefined;
		const offset = Math.max(0, Math.floor(options.offset ?? 0));
		const limit = Math.max(0, Math.min(2000, Math.floor(options.limit ?? 300)));

		const browse = memoryEngine.browse({
			scopes: [scope],
			...(options.kinds?.length ? { kinds: options.kinds } : {}),
			...(options.excludeKinds?.length ? { excludeKinds: options.excludeKinds } : {}),
			...(q ? { q } : {}),
			offset,
			limit,
		});
		const counts = memoryEngine.counts({
			scopes: [scope],
			...(options.excludeKinds?.length ? { excludeKinds: options.excludeKinds } : {}),
			...(q ? { q } : {}),
		});
		return {
			enabled: true,
			extract: preferenceExtractionEnabled() ? "llm" : "rule",
			total: browse.total,
			byKind: counts.byKind,
			counts,
			items: browse.items.map(memoryView),
			offset,
			limit,
			hasMore: limit > 0 && offset + browse.items.length < browse.total,
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 概览读取失败: ${detail}`);
		return { ...empty, enabled: true };
	}
}

export function forgetMemory(id: string): boolean {
	return memoryEngine?.forget(id) ?? false;
}

export function supersedeMemory(id: string, byId?: string | null): boolean {
	return Boolean(memoryEngine?.supersede(id, byId ?? null));
}

type HarnessHandle = Awaited<ReturnType<typeof getHarness>>;

export interface ChatStats {
	firstText: string;
	turns: number;
	createdAt: number;
	lastAt: number;
}

export async function readChatStats(
	harness: HarnessHandle,
	internalId: number,
): Promise<ChatStats | null> {
	const conversation = await harness.conversation(internalId as never, CTX);
	if (!conversation) return null;
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
			if (!firstText) {
				// 2026-11-13 附件走路径：清单不是人说的话，侧栏标题要用剥掉清单的正文；
				// 纯文件消息退回文件名，纯图/纯附件退回「附件」。
				const parsed = parseFileManifest(contentText(message.content));
				const plain = parsed.text.trim();
				firstText = (
					plain ||
					parsed.files.map((file) => file.name).join("、") ||
					"附件"
				).slice(0, 40);
			}
		}
		if (!createdAt && at) createdAt = at;
		if (at > lastAt) lastAt = at;
	}
	if (turns === 0) return null;
	return { firstText, turns, createdAt, lastAt };
}

function chatEntryOf(
	conversationId: string,
	internalId: number,
	stats: ChatStats,
	meta: ChatMeta,
	kinds: Record<string, "chief" | "worker">,
): ChatIndexEntry {
	return {
		conversationId,
		createdAt: stats.createdAt,
		lastAt: stats.lastAt,
		firstText: stats.firstText,
		turns: stats.turns,
		chatKind: chatKindOfInternal(internalId, kinds),
		...(meta.titles[conversationId] ? { title: meta.titles[conversationId] } : {}),
		...(meta.pins.includes(conversationId) ? { pinned: true } : {}),
	};
}

export async function listChats(limit = 50): Promise<ChatIndexEntry[]> {
	if (!readLlmConfig()) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	// 任务会话（`X-Task` 通道产生）不进"历史对话"：它们的首句是"请整理成稿"这类指令，
	// 不是用户说过的话（2026-10-31）。正文仍可按 id 回读，只是不在列表里露头。
	const meta = readChatMeta();
	const archived = new Set(meta.archived);
	// 种类表读一次（2026-11-06 B2）：逐会话查库会把列表代价再放大一倍
	const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
	const pairs = Object.entries(chats?.byExternal ?? {})
		.filter(([conversationId]) => !conversationId.startsWith(TASK_CONVERSATION_PREFIX))
		.filter(([conversationId]) => !archived.has(conversationId))
		.slice(-limit);
	const entries: ChatIndexEntry[] = [];

	for (const [conversationId, internalId] of pairs) {
		try {
			const stats = await readChatStats(harness, Number(internalId));
			if (!stats) continue;
			entries.push(chatEntryOf(conversationId, Number(internalId), stats, meta, kinds));
		} catch (error) {
			// 单个会话读失败不该让整张索引失败（重装场景下可能是残留的空会话）
			console.warn(
				`[chats] 读取会话 ${conversationId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return entries.sort((a, b) => b.lastAt - a.lastAt);
}

export function archivedChatPairs(
	archivedIds: readonly string[],
	chatsByExternal: Record<string, number>,
): { conversationId: string; internalId: number }[] {
	const pairs: { conversationId: string; internalId: number }[] = [];
	for (const conversationId of archivedIds) {
		const internalId = chatsByExternal[conversationId];
		if (internalId === undefined) continue;
		pairs.push({ conversationId, internalId: Number(internalId) });
	}
	return pairs;
}

export async function listChatsForExport(limit = 5000): Promise<ChatIndexEntry[]> {
	if (!readLlmConfig()) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const meta = readChatMeta();
	const archived = new Set(meta.archived);
	const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
	const chatProjects = (await harness.snapshot(ChatProjects, CTX))?.byInternal ?? {};

	const projectNames = new Map<string, string>();
	if (Object.keys(chatProjects).length > 0) {
		try {
			for (const project of projectsStore().listProjects(true)) {
				projectNames.set(project.id, project.name);
			}
		} catch {
			// 项目库读不出来就不带项目标签，不影响会话本身
		}
	}

	const pairs = Object.entries(chats?.byExternal ?? {})
		.filter(([conversationId]) => !conversationId.startsWith(TASK_CONVERSATION_PREFIX))
		.slice(-limit);
	const entries: ChatIndexEntry[] = [];

	for (const [conversationId, internalId] of pairs) {
		try {
			const stats = await readChatStats(harness, Number(internalId));
			if (!stats) continue;
			const entry = chatEntryOf(conversationId, Number(internalId), stats, meta, kinds);
			const projectId = chatProjects[String(internalId)];
			entries.push({
				...entry,
				...(archived.has(conversationId)
					? { archived: true, archivedAt: meta.archivedAt[conversationId] ?? stats.lastAt }
					: {}),
				...(projectId && projectNames.get(projectId)
					? { projectId, projectName: projectNames.get(projectId) }
					: {}),
			});
		} catch (error) {
			console.warn(
				`[chats] 导出读取会话 ${conversationId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return entries.sort((a, b) => b.lastAt - a.lastAt);
}

export { PARTNER_CONVERSATION_PREFIX, chatEntryOf, memoryView };
export type { HarnessHandle };
