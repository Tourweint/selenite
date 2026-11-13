/**
 * 归档列表与检索（列表 / 搜索 / 证据命中）
 *
 * 2026-11-13 从 session.ts 的 L2262–L2457 整段切出；正文原文搬运，未改一行实现。
 */

import { projectsStore } from "../projects.ts";
import { readLlmConfig } from "../provider.ts";
import { getHarness } from "./lifecycle.ts";
import { CTX, ChatKinds, ChatProjects, Chats } from "./shared.ts";
import { locateEvidence, normalizeForGrounding } from "@lifediary/memory";
import { openChat } from "./session-open.ts";
import { readTranscript } from "./session-transcript.ts";
import { pruneChatMetaOrphans, readChatMeta } from "./session-meta.ts";
import type { ChatIndexEntry } from "./session-meta.ts";
import { archivedChatPairs, chatEntryOf, listChats, readChatStats } from "./session-index.ts";

export async function listArchivedChats(limit = 200): Promise<ChatIndexEntry[]> {
	if (!readLlmConfig()) return [];
	// 先自愈孤儿（2026-11-13）：清库后 chat-meta 里的 id 会指向不存在的会话，
	// 不剔除的话调用方拿到的 total 是 120、列表是 0 条。没有孤儿时不写文件。
	await pruneChatMetaOrphans().catch((error) => {
		console.warn(
			`[chats] 归档清单自愈失败，按现状返回: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const meta = readChatMeta();
	// 种类表读一次（与 listChats 同口径）
	const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
	const chatProjects = (await harness.snapshot(ChatProjects, CTX))?.byInternal ?? {};
	const byExternal = chats?.byExternal ?? {};

	const projectNames = new Map<string, string>();
	if (Object.keys(chatProjects).length > 0) {
		try {
			// 项目库读不出来就不显示项目标签，不影响归档清单本身
			for (const project of projectsStore().listProjects(true)) {
				projectNames.set(project.id, project.name);
			}
		} catch {
			/* 同上 */
		}
	}

	const entries: ChatIndexEntry[] = [];
	for (const { conversationId, internalId } of archivedChatPairs(meta.archived, byExternal)) {
		try {
			const stats = await readChatStats(harness, internalId);
			if (!stats) continue;
			const projectId = chatProjects[String(internalId)];
			const projectName = projectId ? projectNames.get(projectId) : undefined;
			entries.push({
				...chatEntryOf(conversationId, internalId, stats, meta, kinds),
				archived: true,
				// 旧数据没有归档时间：按方案回退到最后一句时间（不是 0，排序才有意义）
				archivedAt: meta.archivedAt[conversationId] ?? stats.lastAt,
				...(projectId && projectName ? { projectId, projectName } : {}),
			});
		} catch (error) {
			// 单个会话读失败不该让整张归档清单失败
			console.warn(
				`[chats] 读取归档会话 ${conversationId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
	return entries
		.sort((a, b) => (b.archivedAt ?? b.lastAt) - (a.archivedAt ?? a.lastAt))
		.slice(0, cap);
}

export interface SearchHit {
	conversationId: string;
	/** 会话标题（没有就用首句），展示用 */
	title: string;
	role: "user" | "assistant";
	at: number;
	/** 命中处附近 ±40/80 字的片段，前端做高亮 */
	text: string;
}

export async function searchTranscripts(q: string, limit = 20): Promise<SearchHit[]> {
	const needle = q.trim().toLowerCase();
	if (needle.length < 2) return [];
	const chats = await listChats(200);
	const hits: SearchHit[] = [];
	for (const chat of chats) {
		try {
			const resolved = await openChat(chat.conversationId);
			if (!resolved) continue;
			const messages = await readTranscript(resolved, 200);
			for (const message of messages) {
				const index = message.text.toLowerCase().indexOf(needle);
				if (index === -1) continue;
				hits.push({
					conversationId: chat.conversationId,
					title: chat.title || chat.firstText,
					role: message.role,
					at: message.at,
					text: message.text.slice(Math.max(0, index - 40), index + needle.length + 80),
				});
				if (hits.length >= limit) return hits;
			}
		} catch (error) {
			// 单会话读失败不挡整查
			console.warn(
				`[search] 会话 ${chat.conversationId} 读取失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return hits;
}

export interface EvidenceHit {
	conversationId: string;
	at: number;
	role: "user" | "assistant";
	text: string;
}

export async function findEvidence(
	needles: string[],
	options: { chatLimit?: number; transcriptLimit?: number } = {},
): Promise<Map<string, EvidenceHit>> {
	const found = new Map<string, EvidenceHit>();
	// 键用原始串；匹配用首行。归一化后不足 4 字的锚点太泛（两个字就能撞上一堆闲聊），直接跳过。
	const pending = needles.filter(
		(needle) => typeof needle === "string" && normalizeForGrounding(needle.split("\n")[0] ?? "").length >= 4,
	);
	if (pending.length === 0) return found;

	let chats: ChatIndexEntry[];
	try {
		chats = await listChats(options.chatLimit ?? 200);
	} catch {
		// 列表读不出来 = 这次没证据，建议照常返回
		return found;
	}

	for (const chat of chats) {
		if (pending.length === 0) break;
		try {
			const resolved = await openChat(chat.conversationId);
			if (!resolved) continue;
			const messages = await readTranscript(resolved, options.transcriptLimit ?? 200);
			for (const message of messages) {
				if (pending.length === 0) break;
				// 逐条剥离已命中的：一条正文只需要一个出处
				for (let index = pending.length - 1; index >= 0; index -= 1) {
					const needle = pending[index]!;
					const snippet = locateEvidence(message.text, needle);
					if (!snippet) continue;
					found.set(needle, {
						conversationId: chat.conversationId,
						at: message.at,
						role: message.role,
						text: snippet,
					});
					pending.splice(index, 1);
				}
			}
		} catch (error) {
			// 单会话读失败不挡整查（与 searchTranscripts 同口径）
			console.warn(
				`[evidence] 会话 ${chat.conversationId} 读取失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return found;
}
