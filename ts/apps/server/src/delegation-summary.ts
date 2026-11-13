/**
 * 票据摘要（消息库 / 会话映射 / 标题与主伙伴名 / 群发汇总）
 *
 * 2026-11-13 从 delegation-api.ts 的 L367–L643 整段切出；正文原文搬运，未改一行实现。
 */

import { JUDGE_FILE } from "../../../../../chancellor/src/index.ts";
import { judgeCallsOf } from "../../../../../chancellor/src/judge.ts";
import { listManagers } from "../../../../../chancellor/src/manager/registry.ts";
import { Store, TicketRow } from "../../../../../chancellor/src/store.ts";
import { Ticket } from "../../../../../chancellor/src/types.ts";
import { DelegationReceipts, TERMINAL_TICKET_STATUS } from "./delegation-receipts.ts";
import type { DelegationRuntime } from "./delegation.ts";
import { partnersStore } from "./partners.ts";
import fs from "node:fs";
import path from "node:path";
import { fanoutGroupEnabled } from "./delegation-gates.ts";
import { applyCancelProjection, deadLetterStore } from "./delegation-jobs.ts";
import type { TicketSummary } from "./delegation-jobs.ts";

function externalChatIdsLoader(): () => Promise<Map<number, string>> {
	let pending: Promise<Map<number, string>> | null = null;
	return () => {
		pending ??= import("./agent.ts")
			.then((module) => module.externalChatIds())
			.catch(() => new Map<number, string>());
		return pending;
	};
}

async function resolveConversationId(
	raw: string | number | null | undefined,
	loadExternal: () => Promise<Map<number, string>>,
): Promise<string | null> {
	if (raw === null || raw === undefined) return null;
	const text = String(raw).trim();
	if (!text) return null;
	if (!/^\d+$/.test(text)) return text;
	return (await loadExternal()).get(Number(text)) ?? null;
}

async function conversationIdOf(
	ticket: Ticket,
	loadExternal: () => Promise<Map<number, string>>,
): Promise<string | null> {
	let raw: string | number | null | undefined = ticket.originConversationId;
	if (raw === null || raw === undefined || raw === "") {
		try {
			raw = deadLetterStore().lookupByTicket(ticket.id)?.conversationId ?? null;
		} catch {
			raw = null;
		}
	}
	return resolveConversationId(raw, loadExternal);
}

function conversationTitlesLoader(
	maxChats: number,
): (conversationIds: Array<string | null>) => Promise<Map<string, string>> {
	let pendingNamed: Promise<Record<string, string>> | null = null;
	let pendingFirstText: Promise<Map<string, string>> | null = null;
	const namedOf = (): Promise<Record<string, string>> => {
		pendingNamed ??= import("./agent.ts")
			.then((module) => module.chatTitles())
			.catch(() => ({}));
		return pendingNamed;
	};
	const firstTextOf = (): Promise<Map<string, string>> => {
		pendingFirstText ??= import("./agent.ts")
			.then(async (module) => {
				const map = new Map<string, string>();
				for (const entry of await module.listChats(maxChats)) {
					const text = (entry.title ?? entry.firstText).trim();
					if (text) map.set(entry.conversationId, text);
				}
				return map;
			})
			.catch(() => new Map<string, string>());
		return pendingFirstText;
	};
	return async (conversationIds) => {
		const wanted = [...new Set(conversationIds.filter((id): id is string => Boolean(id)))];
		const found = new Map<string, string>();
		if (!wanted.length) return found;
		const named = await namedOf();
		for (const id of wanted) {
			const title = named[id]?.trim();
			if (title) found.set(id, title);
		}
		if (found.size === wanted.length) return found;
		const firstText = await firstTextOf();
		for (const id of wanted) {
			const text = found.get(id) ?? firstText.get(id);
			if (text) found.set(id, text);
		}
		return found;
	};
}

function chiefNamesLoader(): (domain: string | null | undefined) => string | null {
	const cache = new Map<string, string | null>();
	return (domain) => {
		const key = (domain ?? "").trim();
		if (!key) return null;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		let name: string | null = null;
		try {
			const store = partnersStore();
			const partnerId = store.partnerIdByDomain(key);
			name = partnerId ? store.get(partnerId)?.name ?? null : null;
		} catch {
			name = null;
		}
		cache.set(key, name);
		return name;
	};
}

async function summarizeTickets(
	runsDir: string,
	domain: string | null,
	limit: number,
	loadExternal: () => Promise<Map<number, string>>,
	loadTitles: (conversationIds: Array<string | null>) => Promise<Map<string, string>>,
	chiefNameOf: (domain: string | null | undefined) => string | null,
	canceledIds: Set<string>,
): Promise<TicketSummary[]> {
	const store = new Store(runsDir);
	try {
		const rows = store.listTickets(limit).map((row: TicketRow) => ({
			row,
			ticket: readTicketJson(runsDir, row.id),
		}));
		const summaries = await Promise.all(
			rows.map(async ({ row, ticket }) => ({
				id: row.id,
				prompt: row.prompt,
				status: row.status,
				domain,
				project: ticket?.options.project?.name ?? null,
				total: row.total,
				passed: row.passed,
				employee: row.employee,
				updated_at: ticket?.updated_at ?? ticket?.created_at ?? "",
				error: ticket?.error ?? null,
				parentTicketId: ticket?.parentTicketId ?? null,
				// 2026-11-04：近况字段落盘在 ticket.json，列表与详情都必须能直接看到。
				lastAction: ticket?.lastAction ?? null,
				lastHeartbeat: ticket?.lastHeartbeat ?? null,
				waitingOn: ticket?.waitingOn ?? null,
				conversationId: ticket ? await conversationIdOf(ticket, loadExternal) : null,
				chiefName: chiefNameOf(ticket?.options.domain),
				// 多副本归并（批 19 §五）：requestId 就是 groupId；开关关 / 没 requestId → null。
				groupId: fanoutGroupEnabled()
					? String(ticket?.idempotencyKey ?? "").trim() || null
					: null,
			})),
		);
		// 标题只用本请求出现过的 conversationId 批量查一次（listChats 逐会话 open，不能逐行调）。
		const titles = await loadTitles(summaries.map((summary) => summary.conversationId));
		return summaries.map((summary) =>
			applyCancelProjection(
				{
					...summary,
					conversationTitle: summary.conversationId
						? titles.get(summary.conversationId) ?? null
						: null,
				},
				// 作废位投影：status 显示成 canceled，原始状态留在 originStatus。
				// 没作废的单也带 canceled:false（纯增量，老客户端按字段忽略即可）。
				canceledIds.has(summary.id),
			),
		);
	} catch {
		return [];
	} finally {
		store.close();
	}
}

function readTicketJson(runsDir: string, ticketId: string): Ticket | null {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(runsDir, ticketId, "ticket.json"), "utf8"),
		) as Ticket;
	} catch {
		return null;
	}
}

interface FanoutGroupSummary {
	groupId: string;
	total: number;
	done: number;
	pending: number;
	status: "settled" | "pending";
}

function summarizeFanoutGroup(
	workRoot: string,
	groupId: string,
	canceledIds: Set<string>,
): FanoutGroupSummary {
	const runsDirs = [workRoot];
	for (const entry of listManagers(workRoot)) {
		if (entry.meta?.runs_dir) runsDirs.push(entry.meta.runs_dir);
	}
	let total = 0;
	let done = 0;
	for (const runsDir of runsDirs) {
		const store = new Store(runsDir);
		try {
			for (const row of store.listTickets(500)) {
				const ticket = readTicketJson(runsDir, row.id);
				if (!ticket) continue;
				if (String(ticket.idempotencyKey ?? "").trim() !== groupId) continue;
				total += 1;
				if (TERMINAL_TICKET_STATUS.has(row.status) || canceledIds.has(row.id)) done += 1;
			}
		} catch {
			// 单个库打不开就跳过；少读一个库最多让等待方多等一轮，不会把 pending 说成 settled。
		} finally {
			store.close();
		}
	}
	return {
		groupId,
		total,
		done,
		pending: total - done,
		status: total > 0 && done === total ? "settled" : "pending",
	};
}

function judgeCallsOfTicket(store: Store, ticketId: string): Array<{
	round?: unknown;
	verdict?: unknown;
	reason?: unknown;
}> {
	try {
		const file = JSON.parse(
			fs.readFileSync(path.join(store.ticketDir(ticketId), JUDGE_FILE), "utf8"),
		) as Parameters<typeof judgeCallsOf>[0];
		return judgeCallsOf(file) as Array<{ round?: unknown; verdict?: unknown; reason?: unknown }>;
	} catch {
		return [];
	}
}

export interface DelegationApiOptions {
	workRoot?: string;
	store?: DelegationReceipts;
	retryRuntime?: () => DelegationRuntime;
	/** 回话端点（8g）的续跑运行时；探针替换成假 runner，生产走真 chancellor。 */
	sayRuntime?: () => DelegationRuntime;
}

export { chiefNamesLoader, conversationIdOf, conversationTitlesLoader, externalChatIdsLoader, judgeCallsOfTicket, readTicketJson, resolveConversationId, summarizeFanoutGroup, summarizeTickets };
export type { FanoutGroupSummary };
