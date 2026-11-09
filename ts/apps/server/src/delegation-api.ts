import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { runChancellor, JUDGE_FILE } from "../../../../../chancellor/src/index.ts";
import { judgeCallsOf, judgeEnabled } from "../../../../../chancellor/src/judge.ts";
import { Store } from "../../../../../chancellor/src/store.ts";
import type { TicketRow } from "../../../../../chancellor/src/store.ts";
import type { Ticket } from "../../../../../chancellor/src/types.ts";
import { listManagers } from "../../../../../chancellor/src/manager/registry.ts";
import type { ProjectRef } from "./projects.ts";
import {
	chancellorWorkRoot,
	emitDelegation,
	startDelegation,
	type DelegationRuntime,
} from "./delegation.ts";
import { DelegationReceipts, requestFingerprint } from "./delegation-receipts.ts";
import { currentApprovalLevel, currentAuthority } from "./delegation-authority.ts";
import { projectRunSource, type RunSource } from "./run-source.ts";
// 证据裁判（2026-11-10 批 14）：重派 / 回话续跑出来的新单同样带裁判。
import { withDelegationJudge } from "./delegation-judge.ts";
import { partnersStore } from "./partners.ts";
import { DelegationMessages } from "./delegation-messages.ts";
// 重试 / 回话续跑的终态同样落一条 work 履历（刀二 E2）。
import { recordWorkSettlement } from "./work-record.ts";
import {
	appendTaskEvent,
	getTaskConversation,
	setTaskBaselineProvider,
	submitTaskReply,
	taskAsConversationEnabled,
	taskConversationMirror,
} from "./task-conversation.ts";

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

/**
 * 取消/重试回滚开关（扫尾批 1 A1）：`DELEGATION_CANCEL=false` 时两个端点一个都不挂（404），
 * 前端也从列表响应里读到 cancelEnabled=false 而不渲染按钮。缺省开。
 */
export function delegationCancelEnabled(): boolean {
	const raw = (process.env.DELEGATION_CANCEL?.trim() || "true").toLowerCase();
	return raw !== "false" && raw !== "0";
}

/** 过程关口投影开关（2026-11-10 批 19 §四）：默认开；`TICKET_GATES=false` → 详情不带 gates。 */
export function ticketGatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.TICKET_GATES ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 多副本归并开关（2026-11-10 批 19 §五）：默认开；`DELEGATION_FANOUT_GROUP=false` → 不带 groupId。 */
export function fanoutGroupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.DELEGATION_FANOUT_GROUP ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 任务过程关口（2026-11-10 批 19 §四.1）：只投影已有事实，不新增判定。 */
export interface TicketGate {
	name: string;
	passed: boolean;
	note?: string;
}

function clipNote(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 关口投影（纯函数，单测直接断言）：验收关口（reviews[]）+ 裁判结论（开了才投影）
 * + 返工轮次。**不判断"应该怎样"**，只把落盘事实换成人能读的徽章。
 */
export function buildTicketGates(input: {
	reviews: Array<{ slug?: unknown; verdict?: unknown; reason?: unknown }>;
	judgeCalls?: Array<{ round?: unknown; verdict?: unknown; reason?: unknown }>;
	repairRound?: number;
	judgeOn?: boolean;
}): TicketGate[] {
	const gates: TicketGate[] = [];
	for (const review of input.reviews) {
		const slug = String(review.slug ?? "").trim();
		const verdict = String(review.verdict ?? "").trim();
		const reason = String(review.reason ?? "").trim();
		gates.push({
			name: slug ? `验收：${slug}` : "验收",
			passed: verdict === "pass",
			...(reason ? { note: clipNote(reason) } : {}),
		});
	}
	if (input.judgeOn && input.judgeCalls && input.judgeCalls.length > 0) {
		const last = input.judgeCalls[input.judgeCalls.length - 1]!;
		const verdict = String(last.verdict ?? "").trim();
		const reason = String(last.reason ?? "").trim();
		const round = Number(last.round);
		const note = [Number.isFinite(round) && round > 0 ? `第 ${round} 轮` : "", verdict, reason]
			.filter(Boolean)
			.join(" · ");
		gates.push({
			name: "裁判",
			passed: verdict === "done",
			...(note ? { note: clipNote(note) } : {}),
		});
	}
	const repairRound = Number(input.repairRound);
	if (Number.isInteger(repairRound) && repairRound > 0) {
		gates.push({ name: "返工", passed: true, note: `已返工 ${repairRound} 轮` });
	}
	return gates;
}

/** 已终态：取消 400（done/failed/aborted）。needs_you / idle / canceled 仍可作废。 */
const CANCEL_TERMINAL_STATUSES = new Set(["done", "failed", "aborted"]);
/** 可重试：failed / aborted；canceled 由作废位单独判（ticket.json 里不会写 canceled）。 */
const RETRYABLE_STATUSES = new Set(["failed", "aborted"]);

export type ActionStatus = 200 | 400 | 404 | 409;
export interface TicketActionResult {
	status: ActionStatus;
	body: Record<string, unknown>;
}

/**
 * 作废位投影（列表行 / 详情共用，抽成纯函数给探针直接断言）：
 * 已作废 → `canceled:true` + `status:"canceled"` + 原始状态放进 `originStatus`（不丢事实）；
 * 未作废 → 只叠加 `canceled:false`。
 */
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

/**
 * 死信投影用的懒建单例（2026-11-05 批次A A2）。与 tools.ts 里的回执实例是两个连接，
 * 同一 SQLite 文件多连接同进程打开没有问题；探针隔离靠 DELEGATIONS_DB_PATH env。
 */
let deadLetterStoreInstance: DelegationReceipts | null = null;
function deadLetterStore(): DelegationReceipts {
	deadLetterStoreInstance ??= new DelegationReceipts();
	return deadLetterStoreInstance;
}

/**
 * 任务详情里的触发来源（2026-11-10 批 15 §三）：
 * 读回执的 `run_source`；老数据 null → 视为 human；没有回执 / 开关关着 → 不出现。
 * 簿记库挂了不挡详情（与留言 / 死信同一口径）。
 */
function runSourceOfTicket(ticketId: string): RunSource | undefined {
	try {
		const receipt = deadLetterStore().lookupByTicket(ticketId);
		// 没有回执 → 不出现；有回执但列为 null（老数据）→ human；开关关着 → 不出现。
		return receipt ? projectRunSource(receipt.runSource) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 派活留言的只读出口（2026-11-07）。
 *
 * 与 `deadLetterStore()` 同一个懒建口径：同一个 SQLite 文件多连接同进程打开没有问题，
 * 库打不开时给空数组——详情接口不能因为簿记库挂了就 500（历史单本来也没有留言）。
 */
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
	/** 作废位（扫尾批 1 A1）：harness 侧不再搬运这张单的结果。 */
	canceled: boolean;
	/** 多副本归并（批 19 §五）：同一 requestId 的单共用这个值；没有 requestId → null。 */
	groupId: string | null;
	/** 作废单显示 status="canceled"，原始状态放在这里不丢事实。 */
	originStatus?: string;
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

/**
 * 裁判记录读口（批 19 §四）：judge.json 是 chancellor 落盘的审计事实，宿主管道只读。
 * 文件缺失 / 坏 JSON → 空数组（老单没有裁判，不是错误）。
 */
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

/** 探针可注入隔离库与假重派运行时；生产不传，走真 chancellor + 真汇报。 */
export interface DelegationApiOptions {
	workRoot?: string;
	store?: DelegationReceipts;
	retryRuntime?: () => DelegationRuntime;
	/** 回话端点（8g）的续跑运行时；探针替换成假 runner，生产走真 chancellor。 */
	sayRuntime?: () => DelegationRuntime;
}

export function mountDelegationApi(app: Hono, opts: DelegationApiOptions = {}): void {
	const workRootOf = (): string => path.resolve(opts.workRoot ?? chancellorWorkRoot());
	// 与只读投影同一个懒建口径：注入了就用注入的，否则用进程内单例。
	const storeOf = (): DelegationReceipts => opts.store ?? deadLetterStore();

	// 键控基线的票面来源（2026-11-10 批 21 §四）：验收标准 = ticket.json 的 steps
	// + plan.json 里各任务的 writes。专线模块不 import 任务中心，由这里注入。
	// 任何读取失败都返回 null（不写基线），绝不挡专线本身的写入。
	setTaskBaselineProvider((ticketId) => {
		try {
			const found = findTicket(workRootOf(), ticketId);
			if (!found) return null;
			try {
				const steps = Array.isArray(found.ticket.steps) ? found.ticket.steps : [];
				let writes: string[] = [];
				try {
					const plan = JSON.parse(
						fs.readFileSync(path.join(found.store.ticketDir(ticketId), "plan.json"), "utf8"),
					) as { tasks?: Array<{ writes?: unknown }> };
					writes = (plan.tasks ?? []).flatMap((task) =>
						Array.isArray(task.writes)
							? task.writes.filter((item): item is string => typeof item === "string")
							: [],
					);
				} catch {
					// 还没规划 / 坏文件：只写 steps
				}
				return { id: ticketId, steps, writes: [...new Set(writes)] };
			} finally {
				found.store.close();
			}
		} catch {
			return null;
		}
	});

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
		const canceledIds = (() => {
			try {
				return storeOf().canceledTicketIds();
			} catch {
				return new Set<string>();
			}
		})();

		// 顶层 workRoot：不分管的老单（domain = null）
		rows.push(
			...(await summarizeTickets(workRoot, null, limit, loadExternal, loadTitles, chiefNameOf, canceledIds)),
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
					canceledIds,
				)),
			);
		}

		const filtered = domainFilter
			? rows.filter((row) => row.domain === domainFilter)
			: rows;
		filtered.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
		return c.json({
			ok: true,
			tickets: filtered.slice(0, limit),
			// 回滚开关下发：前端据此决定渲不渲染取消/重试按钮（开关关时不渲染）。
			cancelEnabled: delegationCancelEnabled(),
		});
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
			// 作废位投影（扫尾批 1 A1）：详情同样叠加 canceled + status=canceled，
			// 原始状态放 originStatus，不丢事实。
			let canceled = false;
			try {
				canceled = storeOf().isCanceled(found.ticket.id);
			} catch {
				/* 簿记库挂了不挡详情 */
			}
			const projected = applyCancelProjection(ticketView, canceled);
			const runSource = runSourceOfTicket(found.ticket.id);
			// 过程关口（批 19 §四）：只读 reviews / judge.json / repairRound 三处落盘事实；
			// 开关关着就不出现这个键（前端零影响）。
			const reviews = found.store.reviewsOf(found.ticket.id);
			const gates = ticketGatesEnabled()
				? buildTicketGates({
						reviews,
						judgeCalls: judgeCallsOfTicket(found.store, found.ticket.id),
						repairRound: found.ticket.repairRound,
						judgeOn: judgeEnabled(),
					})
				: null;
			const groupId = fanoutGroupEnabled()
				? String(found.ticket.idempotencyKey ?? "").trim() || null
				: null;
			return c.json({
				ok: true,
				ticket: projected,
				domain: found.domain,
				conversationId,
				conversationTitle: conversationId ? titles.get(conversationId) ?? null : null,
				chiefName: chiefNamesLoader()(found.ticket.options.domain),
				// 触发来源（2026-11-10 批 15 §三，纯增量）：老数据 null 视为 human；
				// 没有回执 / RUN_SOURCE=false 时**不出现**这个键（前端零影响）。
				...(runSource ? { runSource } : {}),
				// 多副本归并（批 19 §五）：同 requestId 的单带同一个 groupId。
				...(groupId ? { groupId } : {}),
				// 过程关口（批 19 §四）：过了哪些关，纯投影。
				...(gates ? { gates } : {}),
				cancelEnabled: delegationCancelEnabled(),
				// 任务专线（2026-11-08 扫尾批 8g）：启用开关 + 确定性会话 id（`task-<票号>`）。
				// 未建过时也会给 id；前端回读 GET messages 得到 404 就按"还没有记录"展示。
				taskConversationEnabled: taskAsConversationEnabled(),
				taskConversationId: getTaskConversation(found.ticket.id)?.conversationId ?? null,
				// 派活留言（2026-11-07）：谁在什么时候说了什么。老单没有记录 = 空数组。
				messages: messagesOf(found.ticket.id),
				// 路径只给相对项目信息，不把 workRoot 绝对路径下发给客户端。
				project: found.ticket.options.project ?? null,
				// 计划附件与返工轮次（2026-11-09 §2.3 / §1.5）：可选字段，不出现 = 前端零影响。
				...(Array.isArray(found.ticket.steps) && found.ticket.steps.length > 0
					? { steps: found.ticket.steps }
					: {}),
				...(typeof found.ticket.repairRound === "number" && found.ticket.repairRound > 0
					? { repairRound: found.ticket.repairRound }
					: {}),
				tasks: found.store.tasksOf(found.ticket.id),
				reviews,
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

	// ── 取消 / 重试（扫尾批 1 A1）────────────────────────────
	// 回滚开关关着时两个端点一个都不挂（404）；前端由列表的 cancelEnabled 同步不渲染。
	if (delegationCancelEnabled()) {
		app.post("/api/v1/tickets/:id/cancel", (c) => {
			const result = cancelTicketAction(storeOf(), workRootOf(), c.req.param("id"));
			return c.json(result.body, result.status);
		});
		app.post("/api/v1/tickets/:id/retry", (c) => {
			const runtime = opts.retryRuntime?.() ?? defaultRetryRuntime(storeOf());
			const result = retryTicketAction(storeOf(), workRootOf(), c.req.param("id"), runtime);
			return c.json(result.body, result.status);
		});
	}

	// ── 任务回话（2026-11-08 扫尾批 8g）──────────────────────
	// 一次 POST 驱动两件事：① 以用户条目写进 `task-<票号>` 专线（忙时 followUp）；
	// ② 走既有续跑链路把这句话交给执行端（resumeOnly：被拒不改派新单）。
	// 回滚开关关着时整条路由不挂 → 404（与 cancel/retry 同一口径）。
	if (taskAsConversationEnabled()) {
		app.post("/api/v1/tickets/:id/say", async (c) => {
			const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
			const text = typeof body?.text === "string" ? body.text.trim() : "";
			if (!text) return c.json({ ok: false, error: "bad_request", message: "需要 text" }, 400);

			const found = findTicket(workRootOf(), c.req.param("id"));
			if (!found) return c.json({ ok: false, error: "not_found" }, 404);
			try {
				const ticketId = found.ticket.id;
				const status = String(found.ticket.status ?? "");
				if (CANCEL_TERMINAL_STATUSES.has(status)) {
					return c.json(
						{
							ok: false,
							error: "ticket_terminal",
							message: `任务已终态（${status}），不能再回话`,
						},
						400,
					);
				}
				let canceled = false;
				try {
					canceled = storeOf().isCanceled(ticketId);
				} catch {
					/* 簿记库挂了不挡回话 */
				}
				if (canceled) {
					return c.json(
						{ ok: false, error: "ticket_canceled", message: "这张单已作废，回话不会送到执行端" },
						400,
					);
				}
				// 续跑必须有宿主对话（事件与汇报回那里）；与 retry 同口径，字段不够如实 400。
				const host = internalConversationId(found.ticket, ticketId, storeOf());
				if (host === null) {
					return c.json(
						{
							ok: false,
							error: "missing_conversation",
							message: "原单没有来源会话信息，无法确定回写目标",
						},
						400,
					);
				}

				const chat = await submitTaskReply(ticketId, text);
				if (!chat) {
					return c.json(
						{
							ok: false,
							error: "conversation_unavailable",
							message: "专线会话建不出来（模型未配置或存储不可用）",
						},
						503,
					);
				}

				const runtime = opts.sayRuntime?.() ?? defaultRetryRuntime(storeOf());
				const { fellBack } = startDelegation(
					{
						conversationId: host,
						domain: String(found.ticket.options?.domain ?? ""),
						requirement: text,
						resumeTicketId: ticketId,
						// 主人是回答这张单，不是重开一件；被拒只提示，不偷偷改派。
						resumeOnly: true,
						// 用户条目已经进了专线，留言不再镜像第二遍（留言表照写）。
						skipMessageMirror: true,
						sender: { kind: "chief", name: "主人" },
					},
					runtime,
				);
				if (fellBack) {
					// 异步收口：回话已记进会话，但执行端没接住——在专线里如实留一句。
					void appendTaskEvent(ticketId, {
						kind: "notice",
						text: "【系统】这张单已经不在等回答，回话没有送到执行端。",
					});
				}
				// 只记单号、字数与是否续上（不记回话正文）。
				console.log(
					`[ticket] 回话 ticket=${ticketId.slice(0, 12)} chars=${text.length} resume=${
						fellBack ? "rejected" : "sent"
					}`,
				);
				return c.json(
					{
						ok: true,
						ticketId,
						conversationId: chat.externalId,
						status: "accepted",
					},
					202,
				);
			} finally {
				found.store.close();
			}
		});
	}
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

// ── 取消 / 重试的动作逻辑（抽成导出函数，探针可直接用假 runner 断言）──────

/**
 * 原单的宿主会话**内部自增整数**：`startDelegation` / `reportDelegationResult` 都吃这个。
 * 取值顺序：ticket.json 的 originConversationId（数字）→ 受理回执 → 作废位记录。
 * 非数字的 originConversationId 是对外 uuid，没法直接换算，只能回退后两条。
 */
function internalConversationId(
	ticket: Ticket,
	ticketId: string,
	store: DelegationReceipts,
): number | null {
	const raw = ticket.originConversationId;
	if (raw !== null && raw !== undefined && /^\d+$/.test(String(raw).trim())) {
		return Number(String(raw).trim());
	}
	const receipt = store.lookupByTicket(ticketId);
	if (receipt?.conversationId !== null && receipt?.conversationId !== undefined) {
		return receipt.conversationId;
	}
	const cancel = store.cancelInfo(ticketId);
	if (cancel?.conversationId !== null && cancel?.conversationId !== undefined) {
		return cancel.conversationId;
	}
	return null;
}

/** ticket.json 里的项目引用 → 宿主 ProjectRef（重派时原样沿用，不重新走项目前置）。 */
function toProjectRef(project: Ticket["options"]["project"]): ProjectRef | undefined {
	if (!project?.id || !project.rootPath) return undefined;
	return {
		id: project.id,
		name: project.name,
		rootPath: project.rootPath,
		vcs: project.vcs === "git" ? "git" : "none",
		...(project.head !== undefined ? { head: project.head } : {}),
		...(project.dataDir !== undefined ? { dataDir: project.dataDir } : {}),
	};
}

/** 生产用的重派运行时：真 chancellor + 真回灌，与 tools.ts 的 delegate 装配同口径。 */
function defaultRetryRuntime(store: DelegationReceipts): DelegationRuntime {
	return {
		run: (request, options) =>
			runChancellor(
				{ ...request, workRoot: chancellorWorkRoot() },
				withDelegationJudge(options),
			),
		emit: emitDelegation,
		// 回话续跑同样双写进专线（8g）：重试出来的新单也自带同一条单的会话。
		mirror: taskConversationMirror,
		// 汇报回原会话是异步动作，懒加载 agent 避免只读接口在启动期拉起整个运行时。
		report: (conversationId, report) => {
			void import("./agent.ts")
				.then((module) => module.reportDelegationResult(conversationId, report))
				.catch(() => undefined);
		},
		autoReport: (process.env.DELEGATION_AUTO_REPORT?.trim() || "true").toLowerCase() !== "false",
		isCanceled: (id) => store.isCanceled(id),
		// 重派 / 回话续跑出来的新单也是一张真单，终态照样结算落履历（刀二 E2）。
		recordWork: recordWorkSettlement,
		// 续跑授权重验（批 19 §六）：受理档位取回执，现在档位取运行时策略。
		authorityAtAccept: (id) => store.lookupByTicket(id)?.authority?.level ?? null,
		approvalLevelNow: () => currentApprovalLevel(),
		log: (line) => console.warn(line),
	};
}

/** 取消：终态 400，其余（含 needs_you / canceled 重复）记作废位回 200。 */
export function cancelTicketAction(
	store: DelegationReceipts,
	workRoot: string,
	ticketId: string,
): TicketActionResult {
	const found = findTicket(workRoot, ticketId);
	if (!found) return { status: 404, body: { ok: false, error: "not_found" } };
	try {
		const originStatus = String(found.ticket.status ?? "");
		if (CANCEL_TERMINAL_STATUSES.has(originStatus)) {
			return {
				status: 400,
				body: {
					ok: false,
					error: "ticket_terminal",
					message: `任务已终态（${originStatus}），不能再作废`,
				},
			};
		}
		store.cancelTicket(ticketId, internalConversationId(found.ticket, ticketId, store));
		return { status: 200, body: { ok: true, status: "canceled" } };
	} finally {
		found.store.close();
	}
}

/**
 * 重试：仅 failed / aborted / canceled（作废位）。从原单 ticket.json 读需求/领域/项目，
 * 走既有 startDelegation 重派**新单**，requestId = `retry:<原单id>:<次数>` 防撞幂等键，
 * 回执 accept 带原单 conversation_id（新单因此回写进同一条对话）。字段不够如实 400。
 */
export function retryTicketAction(
	store: DelegationReceipts,
	workRoot: string,
	ticketId: string,
	runtime: DelegationRuntime,
): TicketActionResult {
	const found = findTicket(workRoot, ticketId);
	if (!found) return { status: 404, body: { ok: false, error: "not_found" } };
	try {
		const ticket = found.ticket;
		const originStatus = String(ticket.status ?? "");
		const canceled = store.isCanceled(ticketId);
		if (!RETRYABLE_STATUSES.has(originStatus) && !canceled) {
			return {
				status: 400,
				body: { ok: false, error: "not_retryable", message: "只有失败 / 中止 / 已作废的单能重试" },
			};
		}
		const requirement = String(ticket.prompt ?? "").trim();
		if (!requirement) {
			return {
				status: 400,
				body: { ok: false, error: "missing_requirement", message: "原单没有需求正文（prompt），无法重派" },
			};
		}
		const conversationId = internalConversationId(ticket, ticketId, store);
		if (conversationId === null) {
			return {
				status: 400,
				body: { ok: false, error: "missing_conversation", message: "原单没有来源会话信息，无法确定回写目标" },
			};
		}

		const domain = String(ticket.options?.domain ?? "");
		const project = toProjectRef(ticket.options?.project);
		const retryCount = store.countRetries(ticketId) + 1;
		const requestId = `retry:${ticketId}:${retryCount}`;
		const fingerprint = requestFingerprint({ ticketId, requirement, domain, retryCount });
		const begun = store.begin(requestId, fingerprint, {
			explicit: true,
			workRoot,
			// HTTP 重试端点直接触发 → script（RUN_SOURCE=false 时 begin 不落列）。
			runSource: "script",
			// 授权依据（批 19 §六）：重试也是一次受理，记下当时的审批档位。
			authority: currentAuthority(),
		});
		if (begun.kind !== "new") {
			return {
				status: 409,
				body: { ok: false, error: "retry_conflict", message: "这次重派已经受理过，返回原单" },
			};
		}

		const { ticketId: newTicketId } = startDelegation(
			{
				conversationId,
				domain,
				requirement,
				requestId,
				...(project ? { project } : {}),
			},
			runtime,
		);
		if (newTicketId) store.accept(requestId, newTicketId, conversationId);
		else store.markFailed(requestId);
		return { status: 200, body: { ok: true, ticketId: newTicketId } };
	} finally {
		found.store.close();
	}
}

/**
 * 项目删除守卫：chancellor 工作目录（顶层 + 各领域 runs）里是否还有该项目的非终态单。
 * 复用任务中心同一套读取（Store.listTickets + readTicketJson），别在 projects.ts 里另拼路径。
 */
export function projectHasInFlightTickets(workRoot: string, projectId: string): boolean {
	const dirs = [workRoot];
	for (const entry of listManagers(workRoot)) {
		const runsDir = entry.meta?.runs_dir;
		if (runsDir && fs.existsSync(runsDir)) dirs.push(runsDir);
	}
	for (const dir of dirs) {
		const store = new Store(dir);
		try {
			for (const row of store.listTickets(500)) {
				if (TERMINAL_TICKET_STATUS.has(row.status)) continue;
				const ticket = readTicketJson(dir, row.id);
				if (ticket?.options?.project?.id === projectId) return true;
			}
		} catch {
			/* 单个 runs 目录读不出来不当成「有在飞单」，别把删除卡死 */
		} finally {
			store.close();
		}
	}
	return false;
}
