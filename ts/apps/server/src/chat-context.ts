/**
 * 旧会话定点找回（2026-11-10 批 20 §四，只做后端）。
 *
 * `recall_sessions`（批 11）能给 snippet，但要"从旧会话某一处往回看"就得有下标寻址。
 * transcript 没有 seq 字段（前置勘察确认），所以这里用**消息数组下标**（从 0 开始）：
 *   `GET .../context?aroundIndex=<n>&radius=5`
 * 返回该条前后各 `radius` 条（含角色与时间），并带上 `total` 让人知道边界。
 *
 * 不碰内核（不为这个加 seq）、不做界面、不做 fork。
 */

import type { TranscriptMessage } from "./agent/session.ts";
import { flagEnabled } from "./flags.ts";

/** 默认半径（前后各 5 条） */
export const CONTEXT_DEFAULT_RADIUS = 5;
/** 上限：一次最多看 50 条（前端一次也展示不了更多） */
export const CONTEXT_MAX_RADIUS = 50;

/** 回滚开关：默认开；只有显式 `false` 才关（关 = 端点 404）。 */
export function chatContextLookupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("CHAT_CONTEXT_LOOKUP", env);
}

/** `radius` 解析：未传 = 5；必须是 0–50 的整数，否则 null（调用方 400）。 */
export function parseContextRadius(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return CONTEXT_DEFAULT_RADIUS;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > CONTEXT_MAX_RADIUS) return null;
	return value;
}

/** `aroundIndex` 解析：必须是非负整数；缺省 / 非法 → null。 */
export function parseAroundIndex(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) return null;
	return value;
}

export interface ContextSlice<T> {
	/** 第一条的绝对下标（含） */
	from: number;
	/** 最后一条的绝对下标（含）；空窗口为 -1 */
	to: number;
	messages: T[];
}

/**
 * 以 `aroundIndex` 为中心切窗口（含两端）。
 *
 * 调用方已确认 `0 <= aroundIndex < messages.length`。窗口在边界处自然截断，
 * `from` / `to` 是**真实下标**——客户端据此知道"上面还有 / 下面还有"。
 */
export function sliceAroundIndex<T>(
	messages: T[],
	aroundIndex: number,
	radius: number,
): ContextSlice<T> {
	if (messages.length === 0) return { from: 0, to: -1, messages: [] };
	const from = Math.max(0, aroundIndex - radius);
	const to = Math.min(messages.length - 1, aroundIndex + radius);
	return { from, to, messages: messages.slice(from, to + 1) };
}

/** 响应里的单条消息：只给角色 / 时间 / 正文 / 绝对下标（图片与步骤不在这里回放）。 */
export interface ContextMessage {
	role: "user" | "assistant";
	text: string;
	at: number;
	index: number;
	/** user 消息的可寻址 id（与 §2.2 同源；assistant 没有） */
	id?: string;
}

export function contextMessageOf(
	message: TranscriptMessage,
	index: number,
): ContextMessage {
	return {
		role: message.role,
		text: message.text,
		at: message.at,
		index,
		...(message.id ? { id: message.id } : {}),
	};
}
