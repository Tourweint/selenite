/**
 * 动作实现（项目引用 / 重试运行时 / 取消与重试 / 在飞票据判定）
 *
 * 2026-11-13 从 delegation-api.ts 的 L1053–L1243 整段切出；正文原文搬运，未改一行实现。
 */

import { runChancellor } from "../../../packages/chancellor/src/index.ts";
import { listManagers } from "../../../packages/chancellor/src/manager/registry.ts";
import { Store } from "../../../packages/chancellor/src/store.ts";
import { Ticket } from "../../../packages/chancellor/src/types.ts";
import { currentApprovalLevel, currentAuthority } from "./delegation-authority.ts";
import { withDelegationJudge } from "./delegation-judge.ts";
import { DelegationReceipts, TERMINAL_TICKET_STATUS, requestFingerprint } from "./delegation-receipts.ts";
import type { DelegationRuntime } from "./delegation.ts";
import { chancellorWorkRoot, emitDelegation, startDelegation } from "./delegation.ts";
import { ProjectRef } from "./projects.ts";
import { taskConversationMirror } from "./task-conversation.ts";
import { recordWorkSettlement } from "./work-record.ts";
import fs from "node:fs";
import { CANCEL_TERMINAL_STATUSES, RETRYABLE_STATUSES } from "./delegation-checks.ts";
import type { TicketActionResult } from "./delegation-checks.ts";
import { readTicketJson } from "./delegation-summary.ts";
import { findTicket } from "./delegation-mount.ts";

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
		// 唤醒（2026-11-15 回信送达兜底 §B）：重试单跑完同样要走"完成即唤醒"——
		// 以前这里只写汇报不唤醒，而且失败被静默吞掉，重试出来的结果执事永远不知道。
		report: (conversationId, report) => {
			void import("./agent.ts")
				.then((module) => module.reportDelegationResult(conversationId, report))
				.then(() =>
					import("./delegation-wake.ts").then((wake) =>
						wake.wakeOnDelegationReport(conversationId, report),
					),
				)
				.catch((error) => {
					// 原始错误只进服务端日志（可能带上游地址）。
					console.warn(
						`[delegate] 重试单汇报写回失败: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
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

export { defaultRetryRuntime, internalConversationId, toProjectRef };
