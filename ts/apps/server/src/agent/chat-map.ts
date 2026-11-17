/**
 * 会话画板（2026-11-17）：把一条会话投影成"回合卡 + 分支树"。
 *
 * 只读投影，不改会话、不跑模型、不写布局（布局在前端 localStorage）。
 * 作用域写死在参数里：一个根会话 id，不接受工作区 / 会话列表。
 *
 * 两个契约端点（`index.ts` 挂载）：
 *   GET /api/v1/agent/chat/:conversationId/map
 *   GET /api/v1/agent/chat/:conversationId/messages/:messageId   （详情取全文）
 *
 * 参照 dsh-synapse 的投影口径：一问一答两张卡、工具只计数、分支挂回分叉那一轮。
 * 本文件的前半段（`projectChatMapTurns` / `resolveBranchStart`）是纯函数，单测直接 import。
 */

import type { ChatKind } from "@lifediary/shared";
import { partnersStore } from "../partners.ts";
import { sideSessionsEnabled } from "../partner-session-role.ts";
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
/** 每条会话最多回多少轮（超了取最后 N 轮）。 */
export const CHAT_MAP_MAX_TURNS = 400;
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
	/** 本节点第一张卡对应的绝对轮次（调试 / 前端兜底用）。 */
	startTurn: number;
	updatedAt?: number;
	turns: ChatMapTurn[];
}

export interface ChatMapPayload {
	rootId: string;
	nodes: ChatMapNode[];
	truncated: boolean;
}

/** 回滚开关：`CHAT_MAP_ENABLED=false|0|off` → 端点 404、前端按钮不挂。默认开。 */
export function chatMapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.CHAT_MAP_ENABLED?.trim().toLowerCase();
	return value !== "false" && value !== "0" && value !== "off";
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
 * 执事 canonical / side 看副会话开关；群 / 例行 / 课题 / 派活（有非 canonical/side 链接）不能分；
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
export async function buildChatMap(requestedId: string): Promise<ChatMapPayload | null> {
	const requested = await openChat(requestedId);
	if (!requested) return null;

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

		if (origin && !node.missing) {
			const parentId = origin.source;
			const parentTurns = fullTurnsById.get(parentId) ?? null;
			const { start, branchTurn } = resolveBranchStart(origin, parentTurns, loaded.fullTurns);
			node.branchFrom = branchTurn === null ? null : { conversationId: parentId, turnIndex: branchTurn };
			node.startTurn = start;
			let visible = loaded.fullTurns.slice(start);
			if (visible.length > CHAT_MAP_MAX_TURNS) {
				visible = visible.slice(-CHAT_MAP_MAX_TURNS);
				node.startTurn = loaded.fullTurns.length - visible.length;
				truncated = true;
			}
			node.turns = visible;
		} else if (!node.missing) {
			let visible = loaded.fullTurns;
			if (visible.length > CHAT_MAP_MAX_TURNS) {
				visible = visible.slice(-CHAT_MAP_MAX_TURNS);
				node.startTurn = loaded.fullTurns.length - visible.length;
				truncated = true;
			}
			node.turns = visible;
		}

		nodes.push(node);
		for (const childId of childrenOf.get(id) ?? []) {
			if (!visited.has(childId)) queue.push(childId);
		}
	}

	return { rootId, nodes, truncated };
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
