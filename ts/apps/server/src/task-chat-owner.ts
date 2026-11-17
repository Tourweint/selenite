/**
 * 侧栏任务行的创建者归属（2026-11-15 侧栏对话按创建者分组，纯函数）。
 *
 * 单独成模块的理由：归属判定是开关无关的纯逻辑，单测要能直接测；
 * 放进 `task-chat-index.ts` 会连带拉起 agent 装配（单测会碰真实存储）。
 *
 * 口径：宿主会话对外 id 是 `partner-<id>` / `partner-<id>-side-<hex>` /
 * `partner-<id>-group-<gid>` → 该执事 uuid（走 partner-session-role 的解析器，
 * partnerId 含 `-` 也不会被拆错）；其余（总管主会话 / 普通对话 / 解析不到的旧单）
 * → `"chief"`。真实派活落进 ticket.json 的是宿主**内部数字 id**，调用方先用
 * Chats.byExternal 换成对外 id 再进来。
 */

import { flagEnabled } from "./flags.ts";
// 对外 id 解析收在纯函数模块（2026-11-17 一人多会话）：canonical / side / group 三种
// partner- 前缀都归到真正的 partnerId；顺手修掉群会话被当成 `<id>-group-<gid>` 的旧 bug。
import { parsePartnerExternalId } from "./partner-session-role.ts";

export function dispatchOwnerOf(hostExternalId: string | null): {
	dispatchedBy: string;
	isPartnerHost: boolean;
} {
	const parsed = parsePartnerExternalId(hostExternalId);
	if (parsed) return { dispatchedBy: parsed.partnerId, isPartnerHost: true };
	return { dispatchedBy: "chief", isPartnerHost: false };
}

/** 需求首行截断长度：一行人话，长了在侧栏里也读不完 */
export const TASK_CHAT_TITLE_MAX = 60;

/** 需求原文首行 → 任务行标题（压空格 + 截断；空 → 占位文案）。 */
export function taskChatTitle(prompt: string): string {
	const firstLine = String(prompt ?? "").split(/\r?\n/, 1)[0] ?? "";
	const text = firstLine.replace(/\s+/g, " ").trim();
	if (!text) return "（没有说明）";
	return text.length > TASK_CHAT_TITLE_MAX ? `${text.slice(0, TASK_CHAT_TITLE_MAX)}…` : text;
}

/**
 * 侧栏分组回滚开关（`SIDEBAR_TASK_GROUPS`，缺省开）：与服务端其它 hot 开关同口径——
 * 每次现读 env，只有明确写 false / 0 才关，拼错值不会把能力误关。
 * false 时 `/agent/chats` 不下发 `tasks` 键（回滚形态）。
 */
export function sidebarTaskGroupsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("SIDEBAR_TASK_GROUPS", env);
}
