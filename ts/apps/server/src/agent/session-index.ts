/**
 * 会话列表（标题 / 项目归属 / 记忆视图 / 统计 / 列表与导出）
 *
 * 2026-11-13 从 session.ts 的 L1884–L2261 整段切出；正文原文搬运，未改一行实现。
 */

import { memoryExtractMode, preferenceExtractionEnabled } from "../memory-extract.ts";
import { partnersStore } from "../partners.ts";
import type { PartnerSessionLinkRow } from "../partner-types.ts";
import { projectsStore } from "../projects.ts";
import { readLlmConfig } from "../provider.ts";
import { memoryEngine } from "./assist.ts";
import { resolveChatWorkdir } from "./chat-workdir.ts";
import type { ChatWorkdir } from "./chat-workdir.ts";
import { getHarness } from "./lifecycle.ts";
import { CTX, ChatKinds, ChatProjects, Chats, TASK_CONVERSATION_PREFIX, sessionCwd } from "./shared.ts";
import type { ResolvedChat } from "./shared.ts";
import { contentText } from "@earendil-works/pi-ai";
import type { MemoryKind, MemoryRecord } from "@lifediary/memory";
import { parseFileManifest } from "@lifediary/shared";
import { chatKindOfInternal } from "./session-open.ts";
import { archiveChat, readChatMeta } from "./session-meta.ts";
import { missingChatIds } from "./chats-check.ts";
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

/**
 * 把某个项目下的会话改挂到另一个项目（2026-11-17 项目合并）。
 *
 * 只改 `ChatProjects.byInternal` 的映射，**不动会话本身、不碰消息、不改标题**。
 * 与归档不同：这里不区分 task-/partner- 前缀，全部改挂——项目合并后这些会话的
 * 记忆键空间本来就该跟着目标项目走。
 */
export async function rebindChatsOfProject(sourceProjectId: string, targetProjectId: string): Promise<number> {
	if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId) return 0;
	const harness = await getHarness();
	const chatProjects = await harness.snapshot(ChatProjects, CTX);
	let rebound = 0;
	for (const [internalId, mappedProjectId] of Object.entries(chatProjects?.byInternal ?? {})) {
		if (mappedProjectId === sourceProjectId) rebound += 1;
	}
	if (rebound === 0) return 0;
	await harness.commit(async (tx) => {
		const projects = await tx.doc(ChatProjects);
		for (const [internalId, mappedProjectId] of Object.entries(projects.byInternal ?? {})) {
			if (mappedProjectId === sourceProjectId) projects.byInternal[internalId] = targetProjectId;
		}
	}, CTX);
	return rebound;
}

export type { ChatWorkdir, ChatWorkdirKind } from "./chat-workdir.ts";

/**
 * 读一条会话的工作归属。只读 durable / 项目库，不写、不改会话。
 *
 * cwd 的真源是 `pi.agent.cwd`（创建时快照）；读不到时：
 * - 有项目绑定 → 用项目主文件夹（**不要**用 `sessionCwd()` 的运行期回落，
 *   那会把“当前项目”误当成创建时归属）；
 * - 没项目绑定 → 用 `sessionCwd()`（老会话 / 任务会话的实际运行目录）。
 */
export async function chatWorkdirOf(chat: ResolvedChat): Promise<ChatWorkdir | null> {
	const harness = await getHarness();
	const [agent, snapshot] = await Promise.all([
		chat.conversation.agent(CTX).catch(() => null),
		harness.snapshot(ChatProjects, CTX),
	]);
	const projectId = snapshot?.byInternal?.[String(chat.internalId)] ?? null;
	let project: { id: string; name: string; rootPath: string } | null = null;
	let workspaceRoot: string | null = null;
	try {
		const store = projectsStore();
		const found = projectId ? store.findProject(projectId) : null;
		if (found) project = { id: found.id, name: found.name, rootPath: found.rootPath };
		workspaceRoot = store.getWorkspace()?.rootPath ?? null;
	} catch {
		// 项目库坏了只影响这个标签，不影响会话读写
	}
	const snapshotCwd = typeof agent?.cwd === "string" ? agent.cwd.trim() : "";
	const cwd = snapshotCwd || (project ? null : sessionCwd(chat.internalId));
	return resolveChatWorkdir({ cwd, project, workspaceRoot });
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
	/** 原子化（2026-11-16）：原文档案 id；非空表示这条是拆出来的原子。 */
	docId: string | null;
	/** 原子在原文里的逐字依据。 */
	quote: string | null;
	/** 归档时间；列表默认不返回已归档，老客户端忽略即可。 */
	archivedAt: string | null;
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
		docId: record.docId ?? null,
		quote: record.quote ?? null,
		archivedAt: record.archivedAt ?? null,
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

/**
 * 空会话零值兜底（2026-11-17 复核修正）：`readChatStats` 对 turns=0 的会话返回 null
 * （新建副会话还没发第一条消息；canonical 只有问候也是 assistant、不计 turns）。
 * 对"明确请求且确实存在于 Chats 的 id"用零值照常出条目，保留 title / pinned / link；
 * `listChats` 的活跃清单仍默认跳过空壳（includeEmpty=false）。
 */
const ZERO_CHAT_STATS: ChatStats = { firstText: "", turns: 0, createdAt: 0, lastAt: 0 };

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

type SessionLinkHint = {
	partnerId: string;
	role: PartnerSessionLinkRow["role"];
	routeKey: string | null;
};

function chatEntryOf(
	conversationId: string,
	internalId: number,
	stats: ChatStats,
	meta: ChatMeta,
	kinds: Record<string, "chief" | "worker">,
	link?: SessionLinkHint,
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
		// 归属链接（2026-11-17 批1）：调用方一次取快照后逐条传入，chatEntryOf 自己不查库。
		...(link
			? {
					partnerId: link.partnerId,
					sessionRole: link.role,
					isCanonical: link.role === "canonical",
				}
			: {}),
	};
}

/**
 * 列活跃会话。`includeEmpty=true` 时对 turns=0 的会话也用零值出条目（2026-11-17 复核修正，
 * 给 chief 选择器用）——默认 false，既有调用方行为逐字节不变。
 */
export async function listChats(limit = 50, includeEmpty = false): Promise<ChatIndexEntry[]> {
	if (!readLlmConfig()) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	// 任务会话（`X-Task` 通道产生）不进"历史对话"：它们的首句是"请整理成稿"这类指令，
	// 不是用户说过的话（2026-10-31）。正文仍可按 id 回读，只是不在列表里露头。
	const meta = readChatMeta();
	const archived = new Set(meta.archived);
	// 种类表读一次（2026-11-06 B2）：逐会话查库会把列表代价再放大一倍
	const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
	// 链接表一次取快照（2026-11-17 批1）：50 条会话逐条查会变成 N+1
	const links = partnersStore().sessionLinksMap();
	const pairs = Object.entries(chats?.byExternal ?? {})
		.filter(([conversationId]) => !conversationId.startsWith(TASK_CONVERSATION_PREFIX))
		.filter(([conversationId]) => !archived.has(conversationId))
		.slice(-limit);
	const entries: ChatIndexEntry[] = [];

	for (const [conversationId, internalId] of pairs) {
		try {
			const stats = await readChatStats(harness, Number(internalId));
			if (!stats && !includeEmpty) continue;
			entries.push(
				chatEntryOf(
					conversationId,
					Number(internalId),
					stats ?? ZERO_CHAT_STATS,
					meta,
					kinds,
					links.get(Number(internalId)),
				),
			);
		} catch (error) {
			// 单个会话读失败不该让整张索引失败（重装场景下可能是残留的空会话）
			console.warn(
				`[chats] 读取会话 ${conversationId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return entries.sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * 按给定对外 id 取会话索引条目（2026-11-17 批1，给 /partners/:id/sessions 用）。
 * 按传入顺序返回；不存在的 id 跳过；已归档的也跳过（与活跃清单同口径）；同样带 link 字段。
 * 这样列表端点不用 `listChats(limit)`——后者会按 lastAt 截断，可能把老 canonical 丢掉。
 * 对 turns=0 的会话用零值兜底（2026-11-17 复核修正）：空副会话 / 只有问候的 canonical 也要能出现在选择器里。
 */
export async function chatIndexEntriesOf(ids: readonly string[]): Promise<ChatIndexEntry[]> {
	if (!readLlmConfig()) return [];
	if (ids.length === 0) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const meta = readChatMeta();
	const archived = new Set(meta.archived);
	const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
	const links = partnersStore().sessionLinksMap();
	const entries: ChatIndexEntry[] = [];
	for (const conversationId of ids) {
		const internalId = chats?.byExternal?.[conversationId];
		if (internalId === undefined || archived.has(conversationId)) continue;
		try {
			// 明确请求的 id 已在 Chats 里：turns=0 也照常出条目（零值兜底），
			// 否则新建的空副会话 / 只有问候的 canonical 在选择器里看不见。
			const stats = (await readChatStats(harness, Number(internalId))) ?? ZERO_CHAT_STATS;
			entries.push(
				chatEntryOf(
					conversationId,
					Number(internalId),
					stats,
					meta,
					kinds,
					links.get(Number(internalId)),
				),
			);
		} catch (error) {
			console.warn(
				`[chats] 读取会话 ${conversationId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return entries;
}

/**
 * 会话存活核对（2026-11-17，手机同步回收）：只回「已经不在电脑上」的 id。
 *
 * 两段判定：
 * 1. 便宜的三类（不在会话表 / 已归档 / 任务专线）走 `chats-check.ts` 的纯函数；
 * 2. 剩下的逐个看**有没有内容**——与 `listChats` 的可见性同口径（`readChatStats` 为 null =
 *    `turns == 0` 的空会话 = 列表里根本不出现）。2026-11-17 实机联调补：手机侧存的是"用户发过话"
 *    的行，而 durable 里可能只剩一条没有消息的空壳（首轮中断 / 旧客户端残留），
 *    只按会话表判定会让这些行永远留在手机上——正是用户要清掉的那批。
 *
 * 读失败（异常）不判死：宁可少回收，等下一次同步再试。LLM 未配置时返回 `[]`
 * 而不是「全部都不在」——列表接口此时也是空的，按空列表回收会把手机清单清空。
 */
export async function missingChats(ids: readonly string[]): Promise<string[]> {
	if (!readLlmConfig()) return [];
	if (ids.length === 0) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const byExternal = chats?.byExternal ?? {};
	const missing = missingChatIds(ids, {
		byExternal,
		archived: new Set(readChatMeta().archived),
		taskPrefix: TASK_CONVERSATION_PREFIX,
	});
	const gone = new Set(missing);
	for (const id of ids) {
		if (gone.has(id)) continue;
		const internalId = byExternal[id];
		let stats: ChatStats | null;
		try {
			stats = await readChatStats(harness, Number(internalId));
		} catch {
			continue; // 读不出来 = 不确定，留给下次同步
		}
		if (!stats) missing.push(id);
	}
	return missing;
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
	const links = partnersStore().sessionLinksMap();

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
			const entry = chatEntryOf(
				conversationId,
				Number(internalId),
				stats,
				meta,
				kinds,
				links.get(Number(internalId)),
			);
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
