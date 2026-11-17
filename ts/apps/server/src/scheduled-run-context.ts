/**
 * 定时轮（例行 / 定时主动轮）的模型侧透明头（2026-11-17）。
 *
 * 为什么单独一个模块：`partner-runtime-run-partner-turn.ts` 拼这行给模型看，
 * `agent/session-transcript.ts` 与 `agent/session-search.ts` 回读时要把它剥掉——
 * 三者分属不同层，直接互相 import 会成环（runtime → agent → transcript）。
 * 这里只放纯常量与纯函数，零依赖，谁都能引。
 *
 * 只用于**回读展示 / 搜索索引**；落盘的 entries 与模型上下文保持原样。
 */

export const SCHEDULED_RUN_HEADER = "[Scheduled run context]\nturnAuthority: autonomous";

/** 去掉定时轮透明头；不是定时轮正文原样返回。 */
export function stripScheduledRunHeader(text: string): string {
	if (!text.startsWith(SCHEDULED_RUN_HEADER)) return text;
	// 头后面固定跟一个空行（runPartnerTurn 拼的是 `${HEADER}\n\n${text}`）。
	return text.slice(SCHEDULED_RUN_HEADER.length).replace(/^[ \t]*\n/, "").replace(/^\n/, "").trimStart();
}
