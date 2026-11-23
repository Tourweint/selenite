/**
 * 端点挂载（mountDelegationApi：票据列表 / 详情 / 取消与重试入口）
 *
 * 2026-11-13 从 delegation-api.ts 的 L644–L1052 整段切出；正文原文搬运，未改一行实现。
 */

import { listManagers } from "../../../packages/chancellor/src/manager/registry.ts";
import { readJson, Store } from "../../../packages/chancellor/src/store.ts";
import { Ticket } from "../../../packages/chancellor/src/types.ts";
import { bashJobsDir, listBgJobs } from "./bash-background.ts";
import { DelegationReceipts, TERMINAL_TICKET_STATUS } from "./delegation-receipts.ts";
import { chancellorWorkRoot, startDelegation } from "./delegation.ts";
import { appendTaskEvent, ensureTaskConversation, getTaskConversation, setTaskBaselineProvider, submitTaskReply } from "./task-conversation.ts";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { delegationCancelEnabled, fanoutGroupEnabled } from "./delegation-gates.ts";
import { CANCEL_TERMINAL_STATUSES, projectTicketBgJobs, ticketBgJobsEnabled } from "./delegation-checks.ts";
import { applyCancelProjection, deadLetterStore, messagesOf, runSourceOfTicket } from "./delegation-jobs.ts";
import type { TicketLocation, TicketSummary } from "./delegation-jobs.ts";
import { chiefNamesLoader, conversationIdOf, conversationTitlesLoader, externalChatIdsLoader, summarizeFanoutGroup, summarizeTickets } from "./delegation-summary.ts";
import type { DelegationApiOptions } from "./delegation-summary.ts";
import { cancelTicketAction, defaultRetryRuntime, forwardWorkerMessageAction, internalConversationId, retryTicketAction } from "./delegation-actions.ts";
import { createDirectTask } from "./direct-task.ts";

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

	// 前端直派任务（2026-11-22）：新建任务不再先开宿主助手会话；直接建票 + 强制池。
	// 回滚 `DIRECT_TASK_POOL=false` → 执行器跟随设置（见 direct-task.ts）。
	app.post("/api/v1/agent/tasks", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { requirement?: unknown; project?: unknown }
			| null;
		const result = await createDirectTask({
			requirement: typeof body?.requirement === "string" ? body.requirement : "",
			projectRef: typeof body?.project === "string" ? body.project : undefined,
		});
		if (!result.ok) return c.json(result.body, result.status);
		return c.json(result, 201);
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

	/**
	 * 多副本聚合（2026-11-10 批 26 §二）：一组副本到齐了没有。
	 *
	 * 只读、只数事实：`groupId` = 同一次 requestId 扇出的那几张单（批 19 已把它们标成同一组）。
	 * `status = settled` 仅当**全部都终态**（终态表同任务中心，含作废位——作废后 harness
	 * 不再搬这张单的结果，等待方没必要再等它）。**不自动消费、不改任何单**。
	 *
	 * **人的消息不在这组里**：主人回话走 `POST /tickets/:id/say`（单线），不进组、
	 * 不影响 settled 判定；所以要等的只有执行端那几张副本。
	 * 开关沿用 `DELEGATION_FANOUT_GROUP`：关着时组这个概念不存在 → 404。
	 */
	app.get("/api/v1/tickets/groups/:groupId", (c) => {
		const groupId = c.req.param("groupId").trim();
		if (!fanoutGroupEnabled() || !groupId) {
			return c.json({ ok: false, error: "not_found" }, 404);
		}
		let canceledIds: Set<string> = new Set();
		try {
			canceledIds = storeOf().canceledTicketIds();
		} catch {
			/* 簿记库挂了不挡聚合：按"没有作废位"数，最多把一张已作废的单多等一会儿 */
		}
		const summary = summarizeFanoutGroup(workRootOf(), groupId, canceledIds);
		if (summary.total === 0) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true, ...summary });
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
			const groupId = fanoutGroupEnabled()
				? String(found.ticket.idempotencyKey ?? "").trim() || null
				: null;
			// 后台任务投影（批 23 §二）：只列该单时间窗口内的摘要，日志正文另走 bg-jobs 端点。
			const bgJobs = ticketBgJobsEnabled()
				? (() => {
						try {
							return projectTicketBgJobs(found.ticket, listBgJobs(bashJobsDir()));
						} catch {
							return [];
						}
					})()
				: [];
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
				// 后台任务摘要（批 23 §二）：开关关 / 窗口内没有时**不出现**（正文在 /bg-jobs/:id/log）。
				...(bgJobs.length > 0 ? { bgJobs } : {}),
				cancelEnabled: delegationCancelEnabled(),
				// 任务专线（2026-11-08 扫尾批 8g）：确定性会话 id（`task-<票号>`）。
				// 未建过时也会给 id；前端回读 GET messages 得到 404 就按"还没有记录"展示。
				//（TASK_AS_CONVERSATION 回滚开关 2026-11-21 退役，恒 true，字段留给旧客户端。）
				taskConversationEnabled: true,
				taskConversationId: getTaskConversation(found.ticket.id)?.conversationId ?? null,
				// 派活留言（2026-11-07）：谁在什么时候说了什么。老单没有记录 = 空数组。
				messages: messagesOf(found.ticket.id),
				// 路径只给相对项目信息，不把 workRoot 绝对路径下发给客户端。
				project: found.ticket.options.project ?? null,
				// 计划附件（2026-11-09 §2.3）：可选字段，不出现 = 前端零影响。
				...(Array.isArray(found.ticket.steps) && found.ticket.steps.length > 0
					? { steps: found.ticket.steps }
					: {}),
				tasks: found.store.tasksOf(found.ticket.id).map((task) => {
					// attempt 链（2026-11-22 M3）：sqlite 不存这一列，任务目录里的
					// attempt-<n>.json 明文才是事实源；老单没有这些文件 = 不出现额外字段。
					const last = lastAttemptOf(
						path.join(found.store.ticketDir(found.ticket.id), task.dir),
					);
					return last === null ? task : { ...task, ...last };
				}),
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

	// ── worker 插话通道（2026-11-19 插话统一 批1）────────────
	// 人的插话入口：把一条消息经 native 通道转给**正在跑**的 worker 子进程。
	// mode 默认 steer（插进当前轮）；回滚 WORKER_STEER_ENABLED=false → 端点 400
	// （通道下架但路由保留——404 是"没有这个功能"，400 是"功能被关了"，两者分开）。
	// 外部 CLI 打手没有注入口，命中时 400 worker_not_running（边界如实写）。
	app.post("/api/v1/agent/delegations/:ticketId/message", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { mode?: unknown; text?: unknown }
			| null;
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		if (!text) return c.json({ ok: false, error: "bad_request", message: "需要 text" }, 400);
		const mode =
			body?.mode === undefined || body.mode === null
				? "steer"
				: body.mode === "steer" || body.mode === "followUp"
					? body.mode
					: null;
		if (mode === null) {
			return c.json({ ok: false, error: "bad_request", message: "mode 只能是 steer / followUp" }, 400);
		}
		const result = await forwardWorkerMessageAction(
			workRootOf(),
			c.req.param("ticketId"),
			{ mode, text },
			null,
		);
		return c.json(result.body, result.status);
	});

	// ── 任务回话（2026-11-08 扫尾批 8g）──────────────────────
	// 一次 POST 驱动两件事：① 以用户条目写进 `task-<票号>` 专线（忙时 followUp）；
	// ② 走既有续跑链路把这句话交给执行端（resumeOnly：被拒不改派新单）。
	//（TASK_AS_CONVERSATION 回滚开关 2026-11-21 退役，路由恒挂。）
	{
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
				// 2026-11-22 前端直派任务：老单 / 直派单没有来源会话时，任务专线本身就是
				// 它的宿主线程——先把它建出来（幂等），再以它为回写目标。
				let host = internalConversationId(found.ticket, ticketId, storeOf());
				if (host === null) {
					const direct = await ensureTaskConversation(ticketId);
					host = direct?.internalId ?? null;
				}
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

/**
 * 任务目录里最近一次 attempt 的投影（2026-11-22 M3）。
 *
 * 只读 `attempt-<n>.json` 的 seq / attempt / class：`class` 是失败枚举，
 * 成功执行写的是 unknown，这里不展示（成功的任务不该带失败类）。
 * 文件缺失 / 坏了都不影响详情：返回 null，调用方原样给任务行。
 */
function lastAttemptOf(taskDir: string): { attempt: number; failureClass?: string } | null {
	let names: string[];
	try {
		names = fs.readdirSync(taskDir);
	} catch {
		return null;
	}
	let best: { attempt: number; failureClass?: string } | null = null;
	for (const name of names) {
		const matched = /^attempt-(\d+)\.json$/.exec(name);
		if (!matched) continue;
		const fileAttempt = Number(matched[1]);
		if (!Number.isFinite(fileAttempt)) continue;
		if (best !== null && fileAttempt <= best.attempt) continue;
		const record = readJson<{ attempt?: unknown; class?: unknown }>(
			path.join(taskDir, name),
		);
		if (record === null) continue;
		const attempt =
			typeof record.attempt === "number" ? record.attempt : fileAttempt;
		const cls = typeof record.class === "string" ? record.class : "";
		best = {
			attempt,
			...(cls !== "" && cls !== "unknown" ? { failureClass: cls } : {}),
		};
	}
	return best;
}

export { findTicket, readTicket, ticketStats };
