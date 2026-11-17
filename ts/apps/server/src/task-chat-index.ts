/**
 * 任务专线会话索引（2026-11-15 侧栏对话按创建者分组）。
 *
 * 方案：docs/设计方案/2026-11-15-侧栏对话按创建者分组.md。
 * `GET /agent/chats` 增量下发 `tasks` 键，把派活产生的 `task-<票号>` 专线会话
 * 带上"谁派的"（宿主会话 → 执事 / 总管）交给侧栏分文件夹。行粒度 = 每张根单
 * 一条任务专线（与任务中心"父单顶一行、子单收在行内"同口径）。
 *
 * 事实源口径：
 * - **会话存在性**以 durable `Chats.byExternal` 的 `task-` 键为准——
 *   `TASK_AS_CONVERSATION` 关闭或 8g 前的旧单天然不出现，不用前端猜；
 * - 归档排除与 listChats 同一份 chat-meta；
 * - 票在盘上找不到的孤儿会话跳过（终态单闲置后由自动归档收走，口径一致）；
 * - 标题用 ticket.prompt 首行（ticket.json intake 落盘），不用宿主对话标题——
 *   总管名下所有单的宿主都是同一条总管主会话，用宿主标题全是重名。
 *
 * 回滚：`SIDEBAR_TASK_GROUPS=false`（flags）→ 端点不下发 `tasks` 键。
 */

import type { Ticket } from "../../../packages/chancellor/src/types.ts";
import { externalChatIds, getHarness } from "./agent.ts";
import { readChatMeta } from "./agent/session-meta.ts";
import { PARTNER_CONVERSATION_PREFIX, readChatStats } from "./agent/session-index.ts";
import { Chats, CTX, TASK_CONVERSATION_PREFIX } from "./agent/shared.ts";
import { findTicket } from "./delegation-mount.ts";
import { applyCancelProjection, deadLetterStore } from "./delegation-jobs.ts";
import { chancellorWorkRoot } from "./delegation.ts";
import { partnersStore } from "./partners.ts";
import { dispatchOwnerOf, taskChatTitle } from "./task-chat-owner.ts";
import { readLlmConfig } from "./provider.ts";

export interface TaskChatEntry {
	/** 任务专线会话对外 id（`task-<票号>`），前端直接 openConversation 用它 */
	conversationId: string;
	ticketId: string;
	/** 票的需求原文首行（≤60 字）——不是宿主对话标题，总管名下不重名 */
	title: string;
	/** 单状态（作废投影后：canceled 单显示 canceled，原始状态留 originStatus） */
	status: string;
	canceled: boolean;
	originStatus?: string;
	/** 会话最近活动时间（readChatStats 口径，epoch 毫秒） */
	lastAt: number;
	/** 创建者：宿主会话是 `partner-<uuid>` → 该执事 uuid；其余（总管主会话 / 普通对话）→ "chief" */
	dispatchedBy: string;
	/** 执事的显示名（服务端解析好；chief 恒 null，前端用总管条目名） */
	dispatchedByName: string | null;
	/** 发起这张单的宿主会话对外 id；解析不到 → null */
	hostConversationId: string | null;
}

/** 作废簿记：读不到就当没有作废单（与 /tickets 的兜底同口径）。 */
function canceledTicketIds(): Set<string> {
	try {
		return deadLetterStore().canceledTicketIds();
	} catch {
		return new Set<string>();
	}
}

/**
 * 枚举侧栏要显示的任务专线会话。limit 与 /agent/chats 的 chats 同参（默认 50），
 * 按最近活动倒序截断。读单失败只跳过该条，不让整张索引失败（与 listChats 同口径）。
 */
export async function listTaskChats(limit = 50): Promise<TaskChatEntry[]> {
	if (!readLlmConfig()) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const byExternal = chats?.byExternal ?? {};
	const archived = new Set(readChatMeta().archived);

	const canceled = canceledTicketIds();
	const externalByInternal = await externalChatIds();
	const workRoot = chancellorWorkRoot();

	// 先扫一遍拿到全部存在的任务专线键，根单判定要用（父单没有专线时孤儿子单顶一行）
	const taskInternalIds = new Map<number, string>();
	for (const [externalId, internalId] of Object.entries(byExternal)) {
		if (!externalId.startsWith(TASK_CONVERSATION_PREFIX)) continue;
		if (archived.has(externalId)) continue;
		const id = Number(internalId);
		if (Number.isFinite(id)) taskInternalIds.set(id, externalId);
	}
	const ticketIdsWithChat = new Set(
		[...taskInternalIds.values()].map((externalId) =>
			externalId.slice(TASK_CONVERSATION_PREFIX.length),
		),
	);

	const partnerNames = new Map<string, string | null>();
	const partnerNameOf = (partnerId: string): string | null => {
		if (!partnerNames.has(partnerId)) {
			try {
				partnerNames.set(partnerId, partnersStore().get(partnerId)?.name ?? null);
			} catch {
				partnerNames.set(partnerId, null);
			}
		}
		return partnerNames.get(partnerId) ?? null;
	};

	/** 宿主会话对外 id：origin 记的是宿主内部 id（数字串）居多，回执兜底；uuid 原样用。 */
	const hostExternalOf = (ticket: Ticket, ticketId: string): string | null => {
		let raw: string | number | null | undefined = ticket.originConversationId;
		if (raw === null || raw === undefined || raw === "") {
			try {
				raw = deadLetterStore().lookupByTicket(ticketId)?.conversationId ?? null;
			} catch {
				raw = null;
			}
		}
		if (raw === null || raw === undefined || raw === "") return null;
		const text = String(raw).trim();
		if (!text) return null;
		if (/^\d+$/.test(text)) return externalByInternal.get(Number(text)) ?? null;
		return text;
	};

	const entries: TaskChatEntry[] = [];
	for (const [internalId, externalId] of taskInternalIds) {
		const ticketId = externalId.slice(TASK_CONVERSATION_PREFIX.length);
		if (!ticketId) continue;
		try {
			const stats = await readChatStats(harness, internalId);
			if (!stats) continue;
			const ticket = findTicket(workRoot, ticketId)?.ticket;
			// 孤儿会话（票已被清掉）：侧栏不露头，终态后由自动归档收走
			if (!ticket) continue;
			// 根单口径：有父单且父单自己也有任务专线 → 收进行内，不单列
			const parentTicketId = typeof ticket.parentTicketId === "string" ? ticket.parentTicketId : "";
			if (parentTicketId && ticketIdsWithChat.has(parentTicketId)) continue;

			const hostExternal = hostExternalOf(ticket, ticketId);
			const { dispatchedBy, isPartnerHost } = dispatchOwnerOf(hostExternal);
			const projected = applyCancelProjection({ status: String(ticket.status) }, canceled.has(ticketId));
			entries.push({
				conversationId: externalId,
				ticketId,
				title: taskChatTitle(ticket.prompt),
				status: projected.status,
				canceled: projected.canceled,
				...(projected.originStatus ? { originStatus: projected.originStatus } : {}),
				lastAt: stats.lastAt,
				dispatchedBy,
				dispatchedByName: isPartnerHost ? partnerNameOf(dispatchedBy) : null,
				hostConversationId: hostExternal,
			});
		} catch (error) {
			// 单个会话读失败不该让整张索引失败（listChats 同款口径）
			console.warn(
				`[task-chats] 读取任务会话 ${externalId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// 盘上管得着的目录也要兜住"票存在但没有任务专线"的缺口吗？不用：
	// 本索引的事实源是"会话存在"，票存在而会话不存在的单（8g 前 / 开关关过）不进侧栏。
	return entries.sort((a, b) => b.lastAt - a.lastAt).slice(0, Math.max(1, limit));
}
