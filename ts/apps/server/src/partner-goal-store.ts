/**
 * partner-goal-store.ts — 目标状态行（2026-11-25 目标模式，默认关 `GOAL_MODE`）。
 *
 * 一个执事最多一行。目标**正文**在 `partners.current_goal`（注入逻辑不动）；
 * 这里只有状态机要的那几个数。建表在 partner-store.ts 的构造块里
 * （`CREATE TABLE IF NOT EXISTS partner_goals`，照 partners / routines 的写法）。
 *
 * `updated_at` 兼作续跑任务的 token：任何一次写状态都会让它变大，
 * 排在路上的续跑任务醒来时对不上号就作废（没有"取消任务"API 的替代，同例行任务的 revision）。
 */

import type { DatabaseSync } from "node:sqlite";
import type { GoalState } from "./goal-settlement.ts";

export interface PartnerGoalRow extends GoalState {
	partnerId: string;
	updatedAt: string;
}

const COLUMNS =
	"partner_id, status, reason, rounds_used, max_rounds, token_budget, tokens_used, no_progress_streak, updated_at";

export class PartnerGoalStore {
	constructor(private readonly db: DatabaseSync) {}

	get(partnerId: string): PartnerGoalRow | null {
		const row = this.db
			.prepare(
				`SELECT partner_id, status, reason, rounds_used, max_rounds, token_budget, tokens_used, no_progress_streak, updated_at
				 FROM partner_goals WHERE partner_id = ?`,
			)
			.get(partnerId) as Record<string, unknown> | undefined;
		return row ? toRow(row) : null;
	}

	/**
	 * 整行写入（INSERT … ON CONFLICT 更新）。`updated_at` 单调：与上一行同一毫秒就 +1ms，
	 * 保证它当 token 时不会两次写撞成同一个值。
	 */
	upsert(partnerId: string, state: GoalState): PartnerGoalRow {
		const previous = this.get(partnerId);
		let at = Date.now();
		if (previous) {
			const last = Date.parse(previous.updatedAt);
			if (Number.isFinite(last) && at <= last) at = last + 1;
		}
		const updatedAt = new Date(at).toISOString();
		this.db
			.prepare(
				`INSERT INTO partner_goals (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(partner_id) DO UPDATE SET
					status = excluded.status,
					reason = excluded.reason,
					rounds_used = excluded.rounds_used,
					max_rounds = excluded.max_rounds,
					token_budget = excluded.token_budget,
					tokens_used = excluded.tokens_used,
					no_progress_streak = excluded.no_progress_streak,
					updated_at = excluded.updated_at`,
			)
			.run(
				partnerId,
				state.status,
				state.reason,
				state.roundsUsed,
				state.maxRounds,
				state.tokenBudget,
				state.tokensUsed,
				state.noProgressStreak,
				updatedAt,
			);
		return this.get(partnerId) ?? { partnerId, updatedAt, ...state };
	}

	delete(partnerId: string): boolean {
		return Number(this.db.prepare("DELETE FROM partner_goals WHERE partner_id = ?").run(partnerId).changes) > 0;
	}
}

function toRow(row: Record<string, unknown>): PartnerGoalRow {
	return {
		partnerId: String(row.partner_id),
		status: row.status as PartnerGoalRow["status"],
		reason: row.reason as PartnerGoalRow["reason"],
		roundsUsed: Number(row.rounds_used ?? 0),
		maxRounds: Number(row.max_rounds ?? 0),
		tokenBudget: row.token_budget === null || row.token_budget === undefined ? null : Number(row.token_budget),
		tokensUsed: Number(row.tokens_used ?? 0),
		noProgressStreak: Number(row.no_progress_streak ?? 0),
		updatedAt: String(row.updated_at),
	};
}
