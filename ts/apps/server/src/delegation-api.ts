import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { Store } from "../../../../../chancellor/src/store.ts";
import type { TicketRow } from "../../../../../chancellor/src/store.ts";
import type { Ticket } from "../../../../../chancellor/src/types.ts";
import { listManagers } from "../../../../../chancellor/src/manager/registry.ts";
import { chancellorWorkRoot } from "./delegation.ts";

/**
 * 只读任务中心接口（2026-11-03 方案 §5.9）。
 * 界面这次不做；这里先把领域与单 ticket 的读取口子留好，字段口径以这里为准。
 */

const TERMINAL_TICKET_STATUS = new Set([
	"done",
	"needs_you",
	"failed",
	"idle",
	"aborted",
]);

interface TicketLocation {
	ticket: Ticket;
	store: Store;
	domain: string | null;
}

/** 看板列表行：只给界面需要的字段，不带 workRoot 绝对路径与 prompt 全文。 */
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
}

function summarizeTickets(
	runsDir: string,
	domain: string | null,
	limit: number,
): TicketSummary[] {
	const store = new Store(runsDir);
	try {
		return store.listTickets(limit).map((row: TicketRow) => {
			const ticket = readTicketJson(runsDir, row.id);
			return {
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
			};
		});
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

export function mountDelegationApi(app: Hono, opts: { workRoot?: string } = {}): void {
	const workRootOf = (): string => path.resolve(opts.workRoot ?? chancellorWorkRoot());

	app.get("/api/v1/domains", (c) => {
		const workRoot = workRootOf();
		const managers = listManagers(workRoot).map((entry) => {
			const runsDir = entry.meta?.runs_dir;
			const stats = runsDir && fs.existsSync(runsDir)
				? ticketStats(runsDir)
				: { active: 0, total: 0 };
			return {
				domain: entry.domain,
				updatedAt: entry.meta?.updated_at ?? "",
				conversationId: entry.meta?.conversation_id ?? null,
				activeTickets: stats.active,
				totalTickets: stats.total,
				error: entry.error,
			};
		});
		return c.json({ workRoot, domains: managers });
	});

	app.get("/api/v1/tickets", (c) => {
		const workRoot = workRootOf();
		const domainFilter = (c.req.query("domain") ?? "").trim();
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 300);
		const rows: TicketSummary[] = [];

		// 顶层 workRoot：不分管的老单（domain = null）
		rows.push(...summarizeTickets(workRoot, null, limit));
		for (const entry of listManagers(workRoot)) {
			const runsDir = entry.meta?.runs_dir;
			if (!runsDir || !fs.existsSync(runsDir)) continue;
			rows.push(...summarizeTickets(runsDir, entry.domain, limit));
		}

		const filtered = domainFilter
			? rows.filter((row) => row.domain === domainFilter)
			: rows;
		filtered.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
		return c.json({ ok: true, tickets: filtered.slice(0, limit) });
	});

	app.get("/api/v1/tickets/:id", (c) => {
		const found = findTicket(workRootOf(), c.req.param("id"));
		if (!found) return c.json({ ok: false, error: "not_found" }, 404);
		try {
			return c.json({
				ok: true,
				ticket: found.ticket,
				domain: found.domain,
				// 路径只给相对项目信息，不把 workRoot 绝对路径下发给客户端。
				project: found.ticket.options.project ?? null,
				tasks: found.store.tasksOf(found.ticket.id),
				reviews: found.store.reviewsOf(found.ticket.id),
				children: found.store.childrenOf(found.ticket.id).map((child) => ({
					id: child.id,
					status: child.status,
					parentTicketId: child.parentTicketId ?? found.ticket.id,
					updated_at: child.updated_at,
				})),
			});
		} finally {
			found.store.close();
		}
	});
}

function findTicket(workRoot: string, ticketId: string): TicketLocation | null {
	const safeId = ticketId.trim();
	if (!safeId || safeId.includes("/") || safeId.includes("\\") || safeId.includes("..")) {
		return null;
	}
	const direct = readTicket(workRoot, safeId);
	if (direct) return { ticket: direct.ticket, store: direct.store, domain: null };
	for (const entry of listManagers(workRoot)) {
		const runsDir = entry.meta?.runs_dir;
		if (!runsDir) continue;
		const found = readTicket(runsDir, safeId);
		if (found) return { ticket: found.ticket, store: found.store, domain: entry.domain };
	}
	return null;
}

function readTicket(
	runsDir: string,
	ticketId: string,
): { ticket: Ticket; store: Store } | null {
	const file = path.join(runsDir, ticketId, "ticket.json");
	if (!fs.existsSync(file)) return null;
	try {
		const ticket = JSON.parse(fs.readFileSync(file, "utf8")) as Ticket;
		return { ticket, store: new Store(runsDir) };
	} catch {
		return null;
	}
}

/** 一次查询同时给出在办与总数，避免为同一个领域开两次库。 */
function ticketStats(runsDir: string): { active: number; total: number } {
	const store = new Store(runsDir);
	try {
		const tickets = store.listTickets(500);
		return {
			active: tickets.filter((ticket) => !TERMINAL_TICKET_STATUS.has(ticket.status)).length,
			total: tickets.length,
		};
	} catch {
		return { active: 0, total: 0 };
	} finally {
		store.close();
	}
}
