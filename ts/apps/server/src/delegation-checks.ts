/**
 * 票据附加投影（2026-11-13 拆分；2026-11-19 删掉验收层，只留后台任务投影）
 */

import { TERMINAL_TICKET_STATUS } from "./delegation-receipts.ts";

export function ticketBgJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.TICKET_BG_JOBS ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export interface TicketBgJob {
	id: string;
	commandSummary: string;
	startedAt: string;
	endedAt?: string;
	exitCode?: number;
}

export function projectTicketBgJobs(
	ticket: { created_at?: string; updated_at?: string; status?: string },
	jobs: Array<{
		id: string;
		commandSummary: string;
		startedAt: string;
		endedAt: string | null;
		exitCode: number | null;
	}>,
	now: number = Date.now(),
): TicketBgJob[] {
	const start = Date.parse(String(ticket.created_at ?? ""));
	if (!Number.isFinite(start)) return [];
	const recordedEnd = Date.parse(String(ticket.updated_at ?? ""));
	const end =
		TERMINAL_TICKET_STATUS.has(String(ticket.status ?? "")) && Number.isFinite(recordedEnd)
			? recordedEnd
			: now;
	return jobs
		.filter((job) => {
			const at = Date.parse(job.startedAt);
			return Number.isFinite(at) && at >= start && at <= end;
		})
		.map((job) => ({
			id: job.id,
			commandSummary: job.commandSummary,
			startedAt: job.startedAt,
			...(job.endedAt ? { endedAt: job.endedAt } : {}),
			...(typeof job.exitCode === "number" ? { exitCode: job.exitCode } : {}),
		}));
}

const CANCEL_TERMINAL_STATUSES = new Set(["done", "failed", "aborted"]);

const RETRYABLE_STATUSES = new Set(["failed", "aborted"]);

export type ActionStatus = 200 | 400 | 404 | 409;

export interface TicketActionResult {
	status: ActionStatus;
	body: Record<string, unknown>;
}

export { CANCEL_TERMINAL_STATUSES, RETRYABLE_STATUSES };
