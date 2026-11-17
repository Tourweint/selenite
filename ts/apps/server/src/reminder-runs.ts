/**
 * 定时任务执行历史（2026-11-17 定时任务重做）。
 *
 * 为什么不从 durable 任务图反推：终态任务只能说明"到点投递过"，说不出模型这一轮
 * 跑成没跑成、回了什么。用户要的是"可能做也可能做不到"的可见性，所以单独记一笔。
 *
 * 边界：
 *   - 同步读改写（进程内单线程；deliver 是长跑，但记账这段很短），避免并发丢更新；
 *   - 全局上限 500 条（有界文件，不随运行时间无限长）；
 *   - 只存枚举 + ≤200 字摘要，**不存原始错误**（日志纪律：原始错误只进服务端日志）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type ReminderRunTrigger = "scheduled" | "manual";
export type ReminderRunStatus = "success" | "failed";

export interface ReminderRunRecord {
	id: string;
	reminderId: string;
	partnerId: string | null;
	trigger: ReminderRunTrigger;
	status: ReminderRunStatus;
	/** 计划触发时刻（epoch 毫秒） */
	at: number;
	/** 这一轮结束时间（ISO） */
	endedAt: string;
	/** ≤200 字摘要；失败时是一句人话，不含原始错误。 */
	summary?: string;
}

interface ReminderRunsState {
	version: 1;
	runs: ReminderRunRecord[];
}

const DEFAULT_STATE_PATH = ".data/reminder-runs.json";
const MAX_RUNS = 500;
const SUMMARY_LIMIT = 200;

function statePath(): string {
	return process.env.REMINDER_RUNS_STATE_PATH?.trim() || DEFAULT_STATE_PATH;
}

function emptyState(): ReminderRunsState {
	return { version: 1, runs: [] };
}

function load(): ReminderRunsState {
	const path = statePath();
	if (!existsSync(path)) return emptyState();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReminderRunsState>;
		if (parsed.version !== 1 || !Array.isArray(parsed.runs)) return emptyState();
		return {
			version: 1,
			runs: parsed.runs.filter(
				(run): run is ReminderRunRecord =>
					Boolean(run) &&
					typeof run === "object" &&
					typeof (run as ReminderRunRecord).reminderId === "string" &&
					typeof (run as ReminderRunRecord).at === "number",
			),
		};
	} catch {
		// 文件坏了就当没有历史：不为一条记账挡住定时任务本身。
		return emptyState();
	}
}

function save(state: ReminderRunsState): void {
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(temp, path);
}

function clampSummary(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.slice(0, SUMMARY_LIMIT);
}

/** 记一笔执行结果。写入失败静默（定时任务本身比记账重要）。 */
export function recordReminderRun(input: {
	reminderId: string;
	partnerId?: string | null;
	trigger: ReminderRunTrigger;
	status: ReminderRunStatus;
	at: number;
	summary?: string;
}): void {
	if (!input.reminderId) return;
	try {
		const state = load();
		state.runs.push({
			id: randomUUID(),
			reminderId: input.reminderId,
			partnerId: input.partnerId ?? null,
			trigger: input.trigger,
			status: input.status,
			at: input.at,
			endedAt: new Date().toISOString(),
			...(clampSummary(input.summary) ? { summary: clampSummary(input.summary) } : {}),
		});
		if (state.runs.length > MAX_RUNS) {
			state.runs.splice(0, state.runs.length - MAX_RUNS);
		}
		save(state);
	} catch {
		/* 记账失败不挡执行 */
	}
}

/** 某条提醒的最近执行记录（新的在前，≤limit 条）。 */
export function listReminderRuns(reminderId: string, limit = 20): ReminderRunRecord[] {
	if (!reminderId) return [];
	const runs = load().runs.filter((run) => run.reminderId === reminderId);
	return runs.slice(-Math.max(1, Math.min(limit, 100))).reverse();
}
