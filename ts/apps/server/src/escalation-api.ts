/**
 * 决策上报的 HTTP 面板（2026-11-19 批2）。
 *
 * 两个动作 + 一个只读列表，都盖在 `/api/v1/*` 的鉴权中间件之下（批1 教训：
 * 裸路径 = 无鉴权注入口，本文件全部走主 app 的挂载，不另开路由）：
 * - `GET  /api/v1/agent/escalations`                活跃上报列表（上报卡刷新用）
 * - `POST /api/v1/agent/escalations/:ticketId/route` 上报卡动作：总管代答 / 升级给用户
 *
 * 答复本身不经 HTTP：总管代答走 respond_escalation 工具，升级后的答复走
 * 既有 `POST /agent/approvals/:callId/answer`（approval-api 的 onAskAnswered 钩子）。
 *（ESCALATION_CHAIN_ENABLED 回滚开关 2026-11-21 退役，两个端点恒挂。）
 *
 * 刻意不做：上报的持久化列表（活跃集在 escalation.ts 的进程内存；历史读 SSE 事件）。
 */

import type { Hono } from "hono";
import {
	escalateToUser,
	listActiveEscalations,
	triggerChiefTurn,
} from "./escalation.ts";

export { initEscalationRouting } from "./escalation.ts";

export function mountEscalationApi(app: Hono): void {
	app.get("/api/v1/agent/escalations", (c) => {
		const raw = (c.req.query("conversationId") ?? "").trim();
		const conversationId = /^\d+$/.test(raw) ? Number(raw) : undefined;
		return c.json({
			ok: true,
			escalations: listActiveEscalations(conversationId),
		});
	});

	app.post("/api/v1/agent/escalations/:ticketId/route", async (c) => {
		const ticketId = c.req.param("ticketId").trim();
		if (!ticketId) return c.json({ ok: false, error: "bad_request" }, 400);
		const body = (await c.req.json().catch(() => null)) as { action?: unknown } | null;
		if (body?.action !== "chief" && body?.action !== "user") {
			return c.json(
				{ ok: false, error: "bad_request", message: "action 只能是 chief（总管代答）/ user（升级给我）" },
				400,
			);
		}
		if (body.action === "chief") {
			const result = triggerChiefTurn(ticketId);
			if (!result.ok) {
				const status = result.error === "no_active_escalation" ? 404 : 400;
				return c.json({ ok: false, error: result.error }, status);
			}
			return c.json({ ok: true, ticketId, action: "chief", status: "wake_sent" });
		}
		const result = escalateToUser(ticketId);
		if (!result.ok) {
			const status = result.error === "no_active_escalation" ? 404 : 400;
			return c.json(
				{ ok: false, error: result.error, ...(result.message ? { message: result.message } : {}) },
				status,
			);
		}
		return c.json({
			ok: true,
			ticketId,
			action: "user",
			status: "ask_created",
			...(result.callId ? { callId: result.callId } : {}),
		});
	});
}
