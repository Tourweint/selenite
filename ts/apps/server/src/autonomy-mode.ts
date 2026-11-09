import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AutonomyEventType } from "./autonomy-core.ts";

/**
 * 主动性三档与观察记录（2026-11-09 主动性与例行 T2）。
 *
 * 单独成文件的原因：autonomy.ts 连着 agent/approvals 的装配链，import 它等于顺手建库；
 * 档位判定与观察记录必须能无副作用地单测（与 autonomy-core.ts 同一纪律）。
 *
 * `AUTONOMY_ENABLED`：
 *   - off（缺省 / false / 0）：与改动前逐字节一致，什么都不订阅；
 *   - observe：照常订阅、照常判定，但"本来会提醒"只记一条观察记录，**不写会话、不起模型调用**；
 *   - on：完整行为（写会话）。
 * 兼容旧值：true / 1 / 其它非空值一律按 on（老配置不用改）。
 */

export type AutonomyMode = "off" | "observe" | "on";

export const DEFAULT_OBSERVE_PATH = ".data/autonomy-observe.jsonl";
/** 提醒行上限（formatReport ≤80 字的同族口径，这里给观察行 140） */
export const REMIND_LIMIT = 140;
/** 观察记录的 24h 计数窗口 */
const OBSERVE_WINDOW_MS = 24 * 60 * 60_000;

export function autonomyMode(): AutonomyMode {
	const raw = process.env.AUTONOMY_ENABLED?.trim().toLowerCase();
	if (!raw || raw === "false" || raw === "0") return "off";
	if (raw === "observe") return "observe";
	return "on";
}

export function autonomyEnabled(): boolean {
	return autonomyMode() !== "off";
}

/** 提醒该走哪条路（单测直接断言它，remind() 只按结果分叉）。 */
export function autonomyRemindAction(mode: AutonomyMode): "skip" | "observe" | "say" {
	if (mode === "off") return "skip";
	if (mode === "observe") return "observe";
	return "say";
}

function observePath(): string {
	return process.env.AUTONOMY_OBSERVE_PATH?.trim() || DEFAULT_OBSERVE_PATH;
}

/**
 * 一条"本来会提醒"的观察记录（append-only JSONL，字段固定）。
 * 只存枚举与计数用的信息：type / conversationId / action / ≤140 字枚举文案，**不存对话内容**。
 */
export interface AutonomyObserveRecord {
	at: string;
	type: AutonomyEventType;
	conversationId: number;
	action: "would-remind";
	summary: string;
}

/** 追加一条观察记录；写不进去不挡后续判定（观察档的账丢一行不影响真实行为）。 */
export function recordObserve(record: Omit<AutonomyObserveRecord, "at" | "action">): void {
	const path = observePath();
	const line: AutonomyObserveRecord = {
		at: new Date().toISOString(),
		type: record.type,
		conversationId: record.conversationId,
		action: "would-remind",
		summary: record.summary.replace(/\s+/g, " ").slice(0, REMIND_LIMIT),
	};
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
	} catch {
		// 观察档的账写不进去就算了：它本来就不产生任何外部行为
	}
}

/** 24h 内的观察条数（status 端点用；坏行 / 坏文件按 0 算）。 */
export function observeCount24h(now: number = Date.now()): number {
	const path = observePath();
	if (!existsSync(path)) return 0;
	let count = 0;
	try {
		for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as { at?: unknown };
				const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
				if (Number.isFinite(at) && now - at <= OBSERVE_WINDOW_MS) count += 1;
			} catch {
				// 坏行跳过
			}
		}
	} catch {
		return 0;
	}
	return count;
}
