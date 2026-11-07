import type { Hono } from "hono";
import { forgetMemory, memoryOverview, supersedeMemory } from "./agent.ts";

/**
 * 记忆管理接口（2026-11-06）。
 *
 * 三个动作，都是**人对自己的记忆**的操作：
 *   GET    /api/v1/agent/memory?scope=global&limit=300   看
 *   DELETE /api/v1/agent/memory/:id                      删（硬删）
 *   POST   /api/v1/agent/memory/:id/supersede            标过时（body 可带 byId）
 *
 * 口径照本项目其它管理端点：
 *   - 记忆库未启用（`MEMORY_ENABLED=false` / 初始化失败）→ 404 `memory_disabled`。
 *     不用 503：这不是"依赖不可用"，是这个能力在这台机器上没开。
 *   - 找不到 id → 404 `not_found`；body 不合法 → 400 带说明。
 *   - 鉴权失败仍是 403 空体（auth 中间件统一处理，这里不碰）。
 *
 * 为什么不做编辑：编辑记忆等于让它变成第二个人格——用户想改，删了重说一遍更干净。
 * 为什么不做搜索：千级规模先给分组滚动；真上千再加（同设置页不做全局搜索的口径）。
 */
export function mountMemoryApi(app: Hono, deps: { enabled: boolean }): void {
	app.get("/api/v1/agent/memory", (c) => {
		const scope = (c.req.query("scope") ?? "").trim();
		const rawLimit = Number(c.req.query("limit") ?? 300);
		const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 300;
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const overview = memoryOverview({ ...(scope ? { scope } : {}), limit });
		return c.json({ ok: true, ...overview, limit });
	});

	app.delete("/api/v1/agent/memory/:id", (c) => {
		const id = c.req.param("id").trim();
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!id) return c.json({ error: "bad_request", message: "缺少记忆 id" }, 400);
		if (!forgetMemory(id)) {
			return c.json({ error: "not_found", message: "没有这条记忆" }, 404);
		}
		return c.json({ ok: true, deleted: id });
	});

	app.post("/api/v1/agent/memory/:id/supersede", async (c) => {
		const id = c.req.param("id").trim();
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!id) return c.json({ error: "bad_request", message: "缺少记忆 id" }, 400);
		const body = (await c.req.json().catch(() => null)) as { byId?: unknown } | null;
		// byId 允许为空：只下线、没有替代者（旧记录不再被召回，但仍可查）
		if (body && body.byId !== undefined && body.byId !== null && typeof body.byId !== "string") {
			return c.json({ error: "bad_request", message: "byId 只能是字符串或 null" }, 400);
		}
		const byId = typeof body?.byId === "string" && body.byId.trim() ? body.byId.trim() : null;
		if (!supersedeMemory(id, byId)) {
			// 目标不存在 / 替代者不存在 / 自指：统一 404，不细分（细分只会让调用方猜）
			return c.json({ error: "not_found", message: "记忆或替代者不存在" }, 404);
		}
		return c.json({ ok: true, superseded: id, byId });
	});
}
