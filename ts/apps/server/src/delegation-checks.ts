/**
 * 验收检查（前缀正则 / 状态类型 / 投影）
 *
 * 2026-11-13 从 delegation-api.ts 的 L131–L260 整段切出；正文原文搬运，未改一行实现。
 */

import { TERMINAL_TICKET_STATUS } from "./delegation-receipts.ts";
import { clipNote } from "./delegation-gates.ts";

const ACCEPTANCE_PREFIX_RE = /^验\s*[：:]\s*/;

export type AcceptanceCheckStatus = "passed" | "failed" | "unknown";

export interface AcceptanceCheck {
	/** 去掉 `验：` 前缀后的验收原文 */
	text: string;
	status: AcceptanceCheckStatus;
	note?: string;
}

export function projectAcceptanceChecks(
	steps: unknown,
	reviews: Array<{ slug?: unknown; verdict?: unknown }>,
): AcceptanceCheck[] {
	if (!Array.isArray(steps)) return [];
	const texts = steps
		.filter((step): step is string => typeof step === "string")
		.map((step) => step.trim())
		.map((step) => (ACCEPTANCE_PREFIX_RE.test(step) ? step.replace(ACCEPTANCE_PREFIX_RE, "").trim() : ""))
		.filter(Boolean);
	if (texts.length === 0) return [];

	const verdicts = reviews.map((review) => String(review.verdict ?? "").trim());
	const failedSlugs = reviews
		.filter((review) => String(review.verdict ?? "").trim() === "fail")
		.map((review) => String(review.slug ?? "").trim())
		.filter(Boolean);
	if (reviews.length === 0) {
		return texts.map((text) => ({
			text,
			status: "unknown",
			note: "没有验收记录（reviews 为空），无法逐项判定",
		}));
	}
	if (verdicts.every((verdict) => verdict === "pass")) {
		return texts.map((text) => ({ text, status: "passed" }));
	}
	if (failedSlugs.length > 0) {
		return texts.map((text) => ({
			text,
			status: "failed",
			note: clipNote(`验收未通过：${failedSlugs.join(" / ")}`),
		}));
	}
	// 有结论但既不是全 pass 也没有 fail（如 blocked）：如实标 unknown，不替它判失败。
	return texts.map((text) => ({
		text,
		status: "unknown",
		note: clipNote(`验收结论未定（${verdicts.join(" / ")}），无法逐项判定`),
	}));
}

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

export { ACCEPTANCE_PREFIX_RE, CANCEL_TERMINAL_STATUSES, RETRYABLE_STATUSES };
