/**
 * 会话画板（2026-11-17）：把一条会话投影成"回合卡 + 分支树"。
 *
 * 只读投影，不改会话、不跑模型、不写布局（布局在前端 localStorage）。
 * 作用域写死在参数里：一个根会话 id，不接受工作区 / 会话列表。
 *
 * 三个契约端点（`index.ts` 挂载）：
 *   GET /api/v1/agent/chat/:conversationId/map?turns=N              （每个节点只回最近 N 轮）
 *   GET /api/v1/agent/chat/:conversationId/map/turns?floor=&before=&limit=  （逐段往前展开）
 *   GET /api/v1/agent/chat/:conversationId/messages/:messageId     （详情取全文）
 *
 * 参照 dsh-synapse 的投影口径：一问一答两张卡、工具只计数、分支挂回分叉那一轮。
 * 本文件的前半段（`projectChatMapTurns` / `resolveBranchStart` / `windowChatMapTurns` /
 * `earlierChatMapTurns`）是纯函数，单测直接 import。
 */

import type { ChatKind } from "@lifediary/shared";
import { partnersStore } from "../partners.ts";
import { sideSessionsEnabled } from "../partner-session-role.ts";
import { flagEnabled } from "../flags.ts";
import type { ResolvedChat } from "./shared.ts";
import { CTX, ChatOrigins } from "./shared.ts";
import { getHarness } from "./lifecycle.ts";
import { chatTitles } from "./session-index.ts";
import { readChatMeta } from "./session-meta.ts";
import { chatKindOf, openChat } from "./session-open.ts";
import {
	foldTranscriptEntries,
	type FoldedTranscriptMessage,
	type TranscriptMessage,
} from "./session-transcript.ts";

/** 一张画布最多装多少条会话（根 + 后代）；超了标 truncated，不悄悄丢。 */
export const CHAT_MAP_MAX_NODES = 24;
/** 画板默认只画每条会话最近多少轮（2026-11-19 折叠批；前端可经 `?turns=` 覆盖）。 */
export const CHAT_MAP_DEFAULT_WINDOW = 10;
/** 单次请求最多取多少轮（初始窗口与逐段展开共用上界）。 */
export const CHAT_MAP_MAX_WINDOW = 100;
/** 卡片预览长度：问句短、回答长；详情再取全文。 */
export const CHAT_MAP_QUESTION_PREVIEW = 400;
export const CHAT_MAP_ANSWER_PREVIEW = 1200;

export interface ChatMapQuestion {
	/** 用户消息的可寻址 id；隐藏的定时触发不给 id（正文也不给出去）。 */
	id?: string;
	text: string;
	at: number;
	/** 定时主动轮：会话里不显示这句，画板只留一个"自动"标记。 */
	hidden?: boolean;
	/** 纯附件消息：正文可能是空的，前端据此画「（附件）」。 */
	hasAttachments?: boolean;
}

export interface ChatMapAnswer {
	id?: string;
	text: string;
	at: number;
	endedAt?: number;
	/** 这一轮调用了几次工具（不含中间「说」的步骤）。 */
	tools?: number;
}

export interface ChatMapTurn {
	/** 会话内的绝对轮次（从 0 起）；子会话只回分叉点之后，但序号保持绝对。 */
	index: number;
	question: ChatMapQuestion;
	answer?: ChatMapAnswer;
}

export interface ChatMapOrigin {
	source: string;
	sourceTitle?: string;
	at: number;
	atMessageId?: string;
}

export interface ChatMapNode {
	id: string;
	title: string;
	chatKind: ChatKind | "unknown";
	/** 执事专线才有：canonical / side；其它会话为 null。 */
	sessionRole: "canonical" | "side" | null;
	root: boolean;
	branchable: boolean;
	archived: boolean;
	/** 会话在 durable 里已经打不开（删了 / 对不上）。仍保留节点，画成占位。 */
	missing: boolean;
	origin?: ChatMapOrigin;
	/** 分叉点：母会话 id + 母会话里的绝对轮次；找不到就是 null。 */
	branchFrom: { conversationId: string; turnIndex: number } | null;
	/** 本节点第一张卡对应的绝对轮次（分支 = 分叉点之后第一轮；也是逐段展开的 floor）。 */
	startTurn: number;
	/** 本次下发窗口第一轮的绝对轮次；没有回合时等于 startTurn / totalTurns。 */
	windowStart: number;
	/** 这条会话的总轮次（绝对，含复制前缀）。 */
	totalTurns: number;
	/** 窗口前面还有没有自己的回合（分叉点之后、窗口之前）。 */
	hasEarlier: boolean;
	updatedAt?: number;
	turns: ChatMapTurn[];
}

export interface ChatMapPayload {
	rootId: string;
	nodes: ChatMapNode[];
	/** 只在节点数超过 CHAT_MAP_MAX_NODES 时为 true；回合窗口是正常视图，不算截断。 */
	truncated: boolean;
	/** 本次应用的窗口大小（回显 `?turns=`，前端用它做逐段展开的步长）。 */
	window: number;
}

/** 回滚开关：`CHAT_MAP_ENABLED=false|0|off` → 端点 404、前端按钮不挂。默认开。 */
export function chatMapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("CHAT_MAP_ENABLED", env);
}

function asTurnIndex(value: unknown, fallback: number): number {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.trunc(parsed);
}

/** 窗口大小：缺省 10，夹在 1–100（`?turns=` / `?limit=` 共用）。 */
export function clampMapWindow(value: unknown, fallback = CHAT_MAP_DEFAULT_WINDOW): number {
	const parsed = asTurnIndex(value, fallback);
	return Math.max(1, Math.min(CHAT_MAP_MAX_WINDOW, parsed));
}

export interface ChatMapTurnWindow {
	turns: ChatMapTurn[];
	/** 这条会话自己的回合起点（分支 = 分叉点之后第一轮）。 */
	startTurn: number;
	windowStart: number;
	totalTurns: number;
	hasEarlier: boolean;
}

/** 初始窗口：取 [startTurn, total) 的最后 N 轮，并回窗口元数据。 */
export function windowChatMapTurns(
	turns: readonly ChatMapTurn[],
	startTurn: number,
	window: number,
): ChatMapTurnWindow {
	const totalTurns = turns.length;
	const start = Math.max(0, Math.min(totalTurns, asTurnIndex(startTurn, 0)));
	const size = clampMapWindow(window);
	const windowStart = Math.max(start, totalTurns - size);
	return {
		turns: turns.slice(windowStart),
		startTurn: start,
		windowStart: turns[windowStart]?.index ?? windowStart,
		totalTurns,
		hasEarlier: windowStart > start,
	};
}

/** 逐段展开：取 [floor, before) 的最后 limit 轮；before 缺省/越界时取到会话末尾。 */
export function earlierChatMapTurns(
	turns: readonly ChatMapTurn[],
	floor: number,
	before: number,
	limit: number,
): ChatMapTurnWindow {
	const totalTurns = turns.length;
	const start = Math.max(0, Math.min(totalTurns, asTurnIndex(floor, 0)));
	const edge = Math.max(start, Math.min(totalTurns, asTurnIndex(before, totalTurns)));
	const size = clampMapWindow(limit);
	const windowStart = Math.max(start, edge - size);
	return {
		turns: turns.slice(windowStart, edge),
		startTurn: start,
		windowStart: turns[windowStart]?.index ?? windowStart,
		totalTurns,
		hasEarlier: windowStart > start,
	};
}

function preview(text: string, limit: number): string {
	const one = text.trim();
	return one.length > limit ? `${one.slice(0, limit)}…` : one;
}

/**
 * 回合投影：一问一答两张卡。
 *
 * - 一条 user / 来信消息开一轮；隐藏的定时触发（`hidden: true`）也开一轮，只是没有正文。
 * - 同一轮里可能落多条 assistant 正文（中间说过话、最后收尾），**最后一条有正文的胜出**。
 * - 工具只计数（`steps` 里 name !== "say"），工具内容不进卡片。
 * - 会话开头就有 assistant（老数据 / 直接回灌）：补一张空问卡，不让回答掉进上一轮。
 */
export function projectChatMapTurns(messages: readonly FoldedTranscriptMessage[]): ChatMapTurn[] {
	const turns: ChatMapTurn[] = [];
	let current: ChatMapTurn | null = null;
	let tools = 0;

	const pushTurn = (question: ChatMapQuestion): ChatMapTurn => {
		const turn: ChatMapTurn = { index: turns.length, question };
		tools = 0;
		turns.push(turn);
		return turn;
	};

	for (const message of messages) {
		if (message.role === "user") {
			current = pushTurn({
				...(message.id && !message.hidden ? { id: message.id } : {}),
				text: message.hidden ? "" : preview(message.text, CHAT_MAP_QUESTION_PREVIEW),
				at: message.at,
				...(message.hidden ? { hidden: true } : {}),
				...(message.images?.length || message.files?.length ? { hasAttachments: true } : {}),
			});
			continue;
		}
		const text = message.text.trim();
		const stepCount = (message.steps ?? []).filter((step) => step.name !== "say").length;
		if (!current) {
			if (!text) continue;
			current = pushTurn({ text: "", at: message.at });
		}
		const turn = current;
		tools += stepCount;
		if (!text) continue;
		turn.answer = {
			...(message.id ? { id: message.id } : {}),
			text: preview(text, CHAT_MAP_ANSWER_PREVIEW),
			at: message.at,
			...(message.endedAt ? { endedAt: message.endedAt } : {}),
			...(tools > 0 ? { tools } : {}),
		};
	}
	return turns;
}

/**
 * 分叉点 → 该会话从第几轮开始属于"分支自己的新内容"。
 *
 * 优先用 `origin.atMessageId` 在母会话的回合里找答卡；老数据没有它，就按时间戳：
 * 提问时间 ≤ 分叉创建时间的回合都是复制过来的前缀，分叉点 = 前缀最后一轮。
 * 两条都读不出来时（时间戳缺失）**不猜**：当作没有新回合，画成空分支占位卡。
 */
export function resolveBranchStart(
	origin: Pick<ChatMapOrigin, "at" | "atMessageId">,
	parentTurns: readonly ChatMapTurn[] | null,
	childTurns: readonly ChatMapTurn[],
): { start: number; branchTurn: number | null } {
	if (origin.atMessageId && parentTurns) {
		const index = parentTurns.findIndex((turn) => turn.answer?.id === origin.atMessageId);
		if (index >= 0) return { start: index + 1, branchTurn: index };
	}
	let copied = 0;
	for (const turn of childTurns) {
		if (turn.question.at > 0 && turn.question.at <= origin.at) copied += 1;
		else break;
	}
	if (copied > 0) return { start: copied, branchTurn: copied - 1 };
	return { start: childTurns.length, branchTurn: null };
}

function firstQuestionLine(turns: readonly ChatMapTurn[]): string {
	for (const turn of turns) {
		const text = turn.question.text.trim();
		if (text) return text.split("\n")[0]!.trim().slice(0, 24);
	}
	return "";
}

function lastAtOf(turns: readonly ChatMapTurn[]): number | undefined {
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index];
		if (!turn) continue;
		const at = turn.answer?.endedAt ?? turn.answer?.at ?? turn.question.at;
		if (at > 0) return at;
	}
	return undefined;
}

function sessionRoleOf(link: { role?: string } | null): "canonical" | "side" | null {
	if (!link) return null;
	return link.role === "canonical" || link.role === "side" ? link.role : null;
}

/**
 * 与 `POST /chat/:id/branches` / 会话页 `canBranchHere()` 同一套判据：
 * 执事 canonical / side 看副会话开关；群 / 例行 / 派活（有非 canonical/side 链接）不能分；
 * 无链接的普通会话与总管可以分，task- 专线除外。
 */
function branchableOf(externalId: string, link: { role?: string } | null): boolean {
	if (link) {
		const role = sessionRoleOf(link);
		return Boolean(role) && sideSessionsEnabled();
	}
	return !externalId.startsWith("task-");
}

function linkOf(chat: ResolvedChat): { role?: string } | null {
	try {
		return partnersStore().linkOfSession(chat.internalId) ?? null;
	} catch {
		// 人设库没起来时按"无链接"处理：画板照画，分支按钮可能多给一次 400
		return null;
	}
}

interface LoadedNode {
	node: ChatMapNode;
	fullTurns: ChatMapTurn[];
}

async function loadNode(
	externalId: string,
	origin: ChatMapOrigin | undefined,
	root: boolean,
	titles: Record<string, string>,
	archivedIds: readonly string[],
): Promise<LoadedNode> {
	const title = titles[externalId] ?? "";
	const base: Omit<ChatMapNode, "turns" | "chatKind" | "sessionRole" | "branchable" | "missing"> = {
		id: externalId,
		title,
		root,
		archived: archivedIds.includes(externalId),
		branchFrom: null,
		startTurn: 0,
		windowStart: 0,
		totalTurns: 0,
		hasEarlier: false,
		...(origin ? { origin } : {}),
	};

	const chat = await openChat(externalId);
	if (!chat) {
		return {
			node: {
				...base,
				title: title || origin?.sourceTitle || "已删除的会话",
				chatKind: "unknown",
				sessionRole: null,
				branchable: false,
				missing: true,
				turns: [],
			},
			fullTurns: [],
		};
	}

	const view = await chat.conversation.context(CTX);
	const messages = foldTranscriptEntries(chat.externalId, view.entries, { includeHidden: true });
	const fullTurns = projectChatMapTurns(messages);
	const link = linkOf(chat);
	const role = sessionRoleOf(link);
	return {
		node: {
			...base,
			title: title || firstQuestionLine(fullTurns) || "一条会话",
			chatKind: await chatKindOf(chat),
			sessionRole: role,
			branchable: branchableOf(externalId, link),
			missing: false,
			updatedAt: lastAtOf(fullTurns),
			turns: [],
		},
		fullTurns,
	};
}

/**
 * 读一条会话的整棵树：请求的会话先向上走到顶（来源链），再从顶向下 BFS。
 * 请求的会话不存在 → null（端点回 404）；根不存在但子会话还在 → 根节点标 missing。
 */
export async function buildChatMap(
	requestedId: string,
	options: { window?: unknown } = {},
): Promise<ChatMapPayload | null> {
	const requested = await openChat(requestedId);
	if (!requested) return null;
	const window = clampMapWindow(options.window);

	const harness = await getHarness();
	const origins = ((await harness.snapshot(ChatOrigins, CTX))?.byExternal ?? {}) as Record<
		string,
		ChatMapOrigin | undefined
	>;
	const titles = chatTitles();
	const archivedIds = readChatMeta().archived;

	// 向上找根（防环；来源链理论上只有一跳，但从分支再分支会出现多跳）
	let rootId = requestedId;
	const walked = new Set<string>([requestedId]);
	for (let depth = 0; depth < 64; depth += 1) {
		const source = origins[rootId]?.source;
		if (!source || walked.has(source)) break;
		walked.add(source);
		rootId = source;
	}

	// 向下建子链（按分叉时间稳定排序）
	const childrenOf = new Map<string, string[]>();
	for (const [childId, origin] of Object.entries(origins)) {
		if (!origin?.source || origin.source === childId) continue;
		const list = childrenOf.get(origin.source) ?? [];
		list.push(childId);
		childrenOf.set(origin.source, list);
	}
	for (const [parentId, list] of childrenOf) {
		list.sort((left, right) => {
			const delta = (origins[left]?.at ?? 0) - (origins[right]?.at ?? 0);
			return delta !== 0 ? delta : left.localeCompare(right);
		});
		childrenOf.set(parentId, list);
	}

	const nodes: ChatMapNode[] = [];
	const fullTurnsById = new Map<string, ChatMapTurn[]>();
	const visited = new Set<string>();
	const queue: string[] = [rootId];
	let truncated = false;

	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		if (nodes.length >= CHAT_MAP_MAX_NODES) {
			truncated = true;
			break;
		}

		const origin = origins[id];
		const loaded = await loadNode(id, origin, id === rootId, titles, archivedIds);
		fullTurnsById.set(id, loaded.fullTurns);
		const node = loaded.node;

		if (!node.missing) {
			const parentTurns = origin ? (fullTurnsById.get(origin.source) ?? null) : null;
			const { start, branchTurn } = origin
				? resolveBranchStart(origin, parentTurns, loaded.fullTurns)
				: { start: 0, branchTurn: null };
			if (origin) {
				node.branchFrom =
					branchTurn === null ? null : { conversationId: origin.source, turnIndex: branchTurn };
			}
			const windowed = windowChatMapTurns(loaded.fullTurns, start, window);
			node.startTurn = windowed.startTurn;
			node.windowStart = windowed.windowStart;
			node.totalTurns = windowed.totalTurns;
			node.hasEarlier = windowed.hasEarlier;
			node.turns = windowed.turns;
		}

		nodes.push(node);
		for (const childId of childrenOf.get(id) ?? []) {
			if (!visited.has(childId)) queue.push(childId);
		}
	}

	return { rootId, nodes, truncated, window };
}

export interface ChatMapTurnsPayload extends ChatMapTurnWindow {
	nodeId: string;
}

/**
 * 画板逐段展开（2026-11-19 折叠批）：只取一条会话 [floor, before) 的最后 limit 轮。
 *
 * `floor` 由前端传节点的 `startTurn`（分支只展开自己的回合）；服务端只夹到 [0, total]，
 * 不重新解分叉——省一次母会话全文读取。这不是数据边界：同一客户端本来就能读这条会话全文。
 */
export async function loadChatMapTurns(
	conversationId: string,
	options: { floor?: unknown; before?: unknown; limit?: unknown } = {},
): Promise<ChatMapTurnsPayload | null> {
	const chat = await openChat(conversationId);
	if (!chat) return null;
	const view = await chat.conversation.context(CTX);
	const messages = foldTranscriptEntries(chat.externalId, view.entries, { includeHidden: true });
	const turns = projectChatMapTurns(messages);
	const windowed = earlierChatMapTurns(
		turns,
		asTurnIndex(options.floor, 0),
		asTurnIndex(options.before, turns.length),
		clampMapWindow(options.limit),
	);
	return { nodeId: conversationId, ...windowed };
}

/** 画板详情：按可寻址 id 取单条消息（隐藏的定时触发不返回，和正文口径一致）。 */
export async function readSingleTranscriptMessage(
	chat: ResolvedChat,
	messageId: string,
): Promise<TranscriptMessage | null> {
	const view = await chat.conversation.context(CTX);
	const messages = foldTranscriptEntries(chat.externalId, view.entries);
	return messages.find((message) => message.id === messageId) ?? null;
}
