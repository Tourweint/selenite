/**
 * 票据后台任务与取消投影（状态表 / 位置 / 死信库）
 *
 * 2026-11-13 从 delegation-api.ts 的 L261–L366 整段切出；正文原文搬运，未改一行实现。
 */

import { Store } from "../../../../../chancellor/src/store.ts";
import { Ticket } from "../../../../../chancellor/src/types.ts";
import { DelegationMessages } from "./delegation-messages.ts";
import { DelegationReceipts } from "./delegation-receipts.ts";
import type { RunSource } from "./run-source.ts";
import { projectRunSource } from "./run-source.ts";

export function applyCancelProjection<T extends { status: string }>(
	view: T,
	canceled: boolean,
): T & { canceled: boolean; originStatus?: string } {
	if (!canceled) return Object.assign({}, view, { canceled: false as const });
	return Object.assign({}, view, {
		canceled: true as const,
		status: "canceled",
		originStatus: view.status,
	});
}

interface TicketLocation {
	ticket: Ticket;
	store: Store;
	domain: string | null;
}

let deadLetterStoreInstance: DelegationReceipts | null = null;

function deadLetterStore(): DelegationReceipts {
	deadLetterStoreInstance ??= new DelegationReceipts();
	return deadLetterStoreInstance;
}

function runSourceOfTicket(ticketId: string): RunSource | undefined {
	try {
		const receipt = deadLetterStore().lookupByTicket(ticketId);
		// 没有回执 → 不出现；有回执但列为 null（老数据）→ human；开关关着 → 不出现。
		return receipt ? projectRunSource(receipt.runSource) : undefined;
	} catch {
		return undefined;
	}
}

let messagesStoreInstance: DelegationMessages | null = null;

function messagesOf(ticketId: string): Array<{
	direction: string;
	fromKind: string;
	fromName: string;
	body: string;
	createdAt: string;
}> {
	try {
		messagesStoreInstance ??= new DelegationMessages();
		return messagesStoreInstance.list(ticketId).map((message) => ({
			direction: message.direction,
			fromKind: message.fromKind,
			fromName: message.fromName,
			body: message.body,
			createdAt: message.createdAt,
		}));
	} catch {
		return [];
	}
}

interface TicketSummary {
	id: string;
	prompt: string;
	status: string;
	domain: string | null;
	project: string | null;
	total: number;
	passed: number;
	employee: string | null;
	updated_at: string;
	error: string | null;
	parentTicketId: string | null;
	lastAction: string | null;
	lastHeartbeat: string | null;
	waitingOn: string | null;
	/** 发起这张单的宿主对话（对外 uuid）；子单继承父单。查不到 → null。 */
	conversationId: string | null;
	/** 来源对话的显示标题：改过名用 chat-meta，否则首句 40 字。无来源/查不到 → null。 */
	conversationTitle: string | null;
	/** 负责这张单的总管名：ticket.options.domain → partners 表 name。直派/查不到 → null。 */
	chiefName: string | null;
	/**
	 * 派活人（2026-11-16 任务中心分人）：originConversationId → 执事专线；
	 * 总管会话 / 查不到 → `{ id: null, name: "总管", kind: "chief" }`。
	 * 纯增量字段：老客户端忽略即可。
	 */
	dispatcher: { id: string | null; name: string; kind: "chief" | "partner" };
	/** 作废位（扫尾批 1 A1）：harness 侧不再搬运这张单的结果。 */
	canceled: boolean;
	/** 多副本归并（批 19 §五）：同一 requestId 的单共用这个值；没有 requestId → null。 */
	groupId: string | null;
	/** 作废单显示 status="canceled"，原始状态放在这里不丢事实。 */
	originStatus?: string;
}

export { deadLetterStore, deadLetterStoreInstance, messagesOf, messagesStoreInstance, runSourceOfTicket };
export type { TicketLocation, TicketSummary };
