/**
 * durable-delete-mount-durable-delete
 *
 * 2026-11-14 从 durable-delete.ts 的 L587–L617 整段切出；正文原文搬运，未改一行实现。
 * 内含：mountDurableDelete
 */

import { Hono } from "hono";
import { deleteChatForever, previewChatDeletion } from "./durable-delete-plan-chat-deletion.ts";

export function mountDurableDelete(app: Hono): void {
	app.get("/api/v1/agent/chat/:conversationId/deletion-preview", async (c) => {
		const result = await previewChatDeletion(c.req.param("conversationId"));
		if (!result.ok) {
			return c.json(
				{
					error: result.error,
					message: result.message,
					...(result.blocked ? { blocked: result.blocked } : {}),
				},
				result.status,
			);
		}
		return c.json(result.preview);
	});

	app.post("/api/v1/agent/chat/:conversationId/delete", async (c) => {
		const result = await deleteChatForever(c.req.param("conversationId"));
		if (!result.ok) {
			return c.json(
				{
					error: result.error,
					message: result.message,
					...(result.blocked ? { blocked: result.blocked } : {}),
				},
				result.status,
			);
		}
		return c.json({ ok: true, deleted: result.deleted });
	});
}
