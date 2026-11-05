import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { Store } from "../../../../../chancellor/src/store.ts";
import type { TicketRow } from "../../../../../chancellor/src/store.ts";
import type { Ticket } from "../../../../../chancellor/src/types.ts";
import { listManagers } from "../../../../../chancellor/src/manager/registry.ts";
import { chancellorWorkRoot } from "./delegation.ts";
import { DelegationReceipts } from "./delegation-receipts.ts";
import { partnersStore } from "./partners.ts";

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

/**
 * 死信投影用的懒建单例（2026-11-05 批次A A2）。与 tools.ts 里的回执实例是两个连接，
 * 同一 SQLite 文件多连接同进程打开没有问题；探针隔离靠 DELEGATIONS_DB_PATH env。
 */
let deadLetterStoreInstance: DelegationReceipts | null = null;
function deadLetterStore(): DelegationReceipts {
	deadLetterStoreInstance ??= new DelegationReceipts();
	return deadLetterStoreInstance;
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
	/** 发起这张单的宿主对话（对外 uuid）；子单继承父单。查不到 → null。 */
	conversationId: string | null;
	/** 来源对话的显示标题：改过名用 chat-meta，否则首句 40 字。无来源/查不到 → null。 */
	conversationTitle: string | null;
	/** 负责这张单的总管名：ticket.options.domain → partners 表 name。直派/查不到 → null。 */
	chiefName: string | null;
}

/**
 * 内部自增会话 id → 对外 uuid（2026-11-05）。
 *
 * ticket.json / 回执里存的是 durable 内部 id；接口对外只能给 uuid（对外 id 一律 uuid）。
 * 这里懒加载 agent，避免只读接口在启动/单测被导入时拉起整个运行时。
 */
function externalChatIdsLoader(): () => Promise<Map<number, string>> {
	let pending: Promise<Map<number, string>> | null = null;
	return () => {
		pending ??= import("./agent.ts")
			.then((module) => module.externalChatIds())
			.catch(() => new Map<number, string>());
		return pending;
	};
}

/**
 * 把 ticket.json / 回执里的来源会话值收敛成对外 uuid。
 * 非数字原样当 uuid（新单透传的就是宿主对话 id）；数字是内部 id，查映射；
 * 查不到（会话已不存在 / 旧进程没落映射）→ null，前端按"无来源对话"处理。
 */
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

/**
 * 来源对话取值顺序（2026-11-05）：新单看 ticket.json 的 originConversationId（含子单继承），
 * 历史单回查派单回执（receipts 只覆盖第一层，子单永远没有回执）。
 */
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

/**
 * 对外 uuid → 显示标题（2026-11-05 L1）。
 *
 * 标题口径与手机端会话列表一致：`chat-meta` 里改过名的优先，否则用 `listChats` 的
 * firstText（首句前 40 字）。listChats 要逐会话 open，所以每次请求只建一次缓存；
 * 只有 chat-meta 没覆盖到的 id 才会触发它。
 */
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

/**
 * domain → 总管名（2026-11-05 L1）。单次请求内按 domain 记忆，避免逐行开库；
 * 库打不开 / 领域没有对应执事都按 null（旧单、直派单照常展示）。
 */
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
			})),
		);
		// 标题只用本请求出现过的 conversationId 批量查一次（listChats 逐会话 open，不能逐行调）。
		const titles = await loadTitles(summaries.map((summary) => summary.conversationId));
		return summaries.map((summary) => ({
			...summary,
			conversationTitle: summary.conversationId
				? titles.get(summary.conversationId) ?? null
				: null,
		}));
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

	app.get("/api/v1/tickets", async (c) => {
		const workRoot = workRootOf();
		const domainFilter = (c.req.query("domain") ?? "").trim();
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 300);
		const rows: TicketSummary[] = [];
		const loadExternal = externalChatIdsLoader();
		const loadTitles = conversationTitlesLoader(300);
		const chiefNameOf = chiefNamesLoader();

		// 顶层 workRoot：不分管的老单（domain = null）
		rows.push(
			...(await summarizeTickets(workRoot, null, limit, loadExternal, loadTitles, chiefNameOf)),
		);
		for (const entry of listManagers(workRoot)) {
			const runsDir = entry.meta?.runs_dir;
			if (!runsDir || !fs.existsSync(runsDir)) continue;
			rows.push(
				...(await summarizeTickets(
					runsDir,
					entry.domain,
					limit,
					loadExternal,
					loadTitles,
					chiefNameOf,
				)),
			);
		}

		const filtered = domainFilter
			? rows.filter((row) => row.domain === domainFilter)
			: rows;
		filtered.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
		return c.json({ ok: true, tickets: filtered.slice(0, limit) });
	});

	app.get("/api/v1/tickets/:id", async (c) => {
		const found = findTicket(workRootOf(), c.req.param("id"));
		if (!found) return c.json({ ok: false, error: "not_found" }, 404);
		try {
			// 对外的来源对话给 uuid；ticket 原文里的内部 id 不下发（对外 id 一律 uuid）。
			const conversationId = await conversationIdOf(found.ticket, externalChatIdsLoader());
			const titles = await conversationTitlesLoader(300)(
				conversationId ? [conversationId] : [],
			);
			const ticketView = { ...found.ticket };
			delete ticketView.originConversationId;
			return c.json({
				ok: true,
				ticket: ticketView,
				domain: found.domain,
				conversationId,
				conversationTitle: conversationId ? titles.get(conversationId) ?? null : null,
				chiefName: chiefNamesLoader()(found.ticket.options.domain),
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
				// 迟到子单死信（2026-11-05 批次A A2）：父单已终态后子单结果无处并入的记账。
				// 只读投影：库打不开时给空数组，明细接口不能因为记账库挂了就 500。
				deadLetters: (() => {
					try {
						return deadLetterStore().listDeadLetters(found.ticket.id);
					} catch {
						return [];
					}
				})(),
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
