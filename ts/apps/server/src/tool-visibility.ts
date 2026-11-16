/**
 * 会话级工具可见性（2026-11-16 C 段）
 *
 * 只回答一个问题：**这条会话归属的人，在人设页取消勾选了哪些工具**。
 *
 * 为什么单独一个模块：`partner-tools.ts` 为了拿真实 extension 会 import
 * `agent/lifecycle-harness.ts`，而 harness 自己又要用这份名单来过滤 `tool_index` 段——
 * 放在这里，两个方向都只依赖 `partners.ts`，不制造 import 环。
 *
 * 归属口径与 `applyPartnerToolSelection` 一致：会话链接优先；没有链接时**只有总管主对话**
 * 回落总管行（worker / 任务专线不参与工具勾选）。开关关 / 读库失败 → 空集合。
 *
 * 会话种类从哪来：`chatStream` 每轮本来就解析一次（链接优先、其次 ChatKinds），
 * 解析完顺手 `noteSessionChatKind()` 记进进程内表；工具执行期（`tool_search`）只读这份记录。
 * 表很小、每会话一条、只留最近 256 个会话，不落盘、不进日志——与 `context-inspect` 的
 * 注入记录同一套做法（那里已经确立了"进程内小表 + LRU"的先例）。
 */

import { CHIEF_PARTNER_ID, partnersStore } from "./partners.ts";

export type SessionChatKind = "chief" | "worker" | "partner";

/** `PARTNER_TOOLS_ENABLED` 的口径与 partner-tools 保持一致：false / 0 / off 关。 */
function toolsSelectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = String(env.PARTNER_TOOLS_ENABLED ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0" && raw !== "off";
}

const MAX_TRACKED = 256;
const sessionKinds = new Map<string, SessionChatKind>();

/** `chatStream` 每轮解析完种类后调用；重复调用只刷新顺序（LRU）。 */
export function noteSessionChatKind(conversationId: number, kind: SessionChatKind): void {
	const key = String(conversationId);
	sessionKinds.delete(key);
	sessionKinds.set(key, kind);
	while (sessionKinds.size > MAX_TRACKED) {
		const oldest = sessionKinds.keys().next().value;
		if (oldest === undefined) break;
		sessionKinds.delete(oldest);
	}
}

export function sessionChatKindOf(conversationId: number): SessionChatKind | null {
	return sessionKinds.get(String(conversationId)) ?? null;
}

/** 测试与关停用。 */
export function clearSessionChatKinds(): void {
	sessionKinds.clear();
}

/**
 * 这条会话归属人的取消名单。
 *
 * `chatKind` 不给时读进程内记录（`noteSessionChatKind`）；两边都拿不到就只认会话链接——
 * 宁可少过滤，也不要把"读不到种类"当成 worker 而放过被取消的工具。
 */
export function disabledToolsOfConversation(
	conversationId: number,
	chatKind?: SessionChatKind | null,
): Set<string> {
	if (!toolsSelectionEnabled()) return new Set();
	try {
		const store = partnersStore();
		const kind = chatKind ?? sessionChatKindOf(conversationId);
		const ownerId =
			store.partnerIdOfSession(conversationId) ??
			(kind === "chief" ? CHIEF_PARTNER_ID : null);
		if (!ownerId) return new Set();
		return new Set(store.get(ownerId)?.disabledTools ?? []);
	} catch {
		return new Set();
	}
}
