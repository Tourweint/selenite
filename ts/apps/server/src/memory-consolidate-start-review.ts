/**
 * memory-consolidate-start-review
 *
 * 2026-11-14 从 memory-consolidate.ts 的 L662–L757 整段切出；正文原文搬运，未改一行实现。
 * 内含：startReview / reviewState / dismissProposal
 */

import { findEvidence } from "./agent.ts";
import { proposalsPath, readPending, writePending } from "./memory-consolidate-parse-proposal-json.ts";
import type { ReviewResult } from "./memory-consolidate-parse-proposal-json.ts";
import { activeReviews, forgetProposalInMemory, lastErrors, lastResults, readPendingProposals, reviewScope } from "./memory-consolidate-review-scope.ts";
import type { ReviewJobHandle, ReviewState, StartReviewOptions } from "./memory-consolidate-review-scope.ts";

export function startReview(scope: string, options: StartReviewOptions = {}): ReviewJobHandle {
	const active = activeReviews.get(scope);
	if (active) {
		return {
			running: true,
			alreadyRunning: true,
			startedAt: active.startedAt,
			promise: active.promise,
		};
	}

	const startedAt = new Date().toISOString();
	const promise = (async (): Promise<ReviewResult> => {
		let result: ReviewResult;
		try {
			result = await reviewScope(scope, {
				...(options.generate ? { generate: options.generate } : {}),
				...(options.findEvidence ? { findEvidence: options.findEvidence } : {}),
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[memory] 整理任务异常: ${detail.slice(0, 200)}`);
			result = { ok: false, status: 502, error: "llm_failed", message: "整理失败，请稍后重试" };
		}

		if (result.ok) {
			lastResults.set(scope, { generatedAt: result.generatedAt, proposals: result.proposals });
			lastErrors.delete(scope);
			try {
				options.onSuccess?.(result);
			} catch (error) {
				// 审计失败只影响 diff 文件，不影响已产出的建议
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[memory] 整理后审计失败: ${detail.slice(0, 200)}`);
			}
		} else {
			lastErrors.set(scope, {
				at: new Date().toISOString(),
				error: result.error,
				message: result.message,
			});
		}
		return result;
	})().finally(() => {
		activeReviews.delete(scope);
	});

	activeReviews.set(scope, { startedAt, promise });
	return { running: true, alreadyRunning: false, startedAt, promise };
}

export function reviewState(scope: string): ReviewState {
	const active = activeReviews.get(scope);
	const last = lastResults.get(scope);
	const pending = readPendingProposals(scope);
	const proposals = last?.proposals ?? pending?.proposals ?? [];
	const generatedAt = last?.generatedAt ?? pending?.generatedAt ?? null;
	const source: ReviewState["source"] = last ? "live" : pending ? "pending" : "none";
	return {
		scope,
		running: Boolean(active),
		startedAt: active?.startedAt ?? null,
		generatedAt,
		proposals,
		source,
		error: lastErrors.get(scope) ?? null,
	};
}

export function dismissProposal(scope: string, keepId: string, dropId: string): boolean {
	if (!keepId || !dropId || keepId === dropId) return false;
	let removed = forgetProposalInMemory(scope, keepId, dropId);

	try {
		const path = proposalsPath();
		const pending = readPending(path);
		const entry = pending[scope];
		if (entry) {
			const before = entry.proposals.length;
			entry.proposals = entry.proposals.filter(
				(item) => !(item.keepId === keepId && item.dropId === dropId),
			);
			if (entry.proposals.length !== before) {
				removed = true;
				writePending(path, pending);
			}
		}
	} catch (error) {
		console.warn(
			`[memory] 忽略建议落盘失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return removed;
}
