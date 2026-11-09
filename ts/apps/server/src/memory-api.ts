import type { Hono } from "hono";
import { forgetMemory, memoryOverview, supersedeMemory } from "./agent.ts";
import {
	applyProposal,
	consolidateLlmEnabled,
	importMemory,
	memoryImportEnabled,
	reviewScope,
	type ReviewGenerator,
} from "./memory-consolidate.ts";
import { readConsolidateDiff, runConsolidatePass } from "./memory-consolidate-pass.ts";

/**
 * 记忆管理接口（2026-11-06；2026-11-08 扫尾批 6 补整理与导入）。
 *
 * 动作都是**人对自己的记忆**的操作：
 *   GET    /api/v1/agent/memory?scope=global&limit=300   看
 *   DELETE /api/v1/agent/memory/:id                      删（硬删）
 *   POST   /api/v1/agent/memory/:id/supersede            标过时（body 可带 byId）
 *   POST   /api/v1/agent/memory/consolidate/review             让模型出"整理建议"（只建议、不执行）
 *   POST   /api/v1/agent/memory/consolidate/apply              逐条应用一条建议（幂等 supersede）
 *   POST   /api/v1/agent/memory/import                         把旧记忆只增不改地并进来
 *
 * 口径照本项目其它管理端点：
 *   - 记忆库未启用（`MEMORY_ENABLED=false` / 初始化失败）→ 404 `memory_disabled`。
 *     不用 503：这不是"依赖不可用"，是这个能力在这台机器上没开。
 *   - 找不到 id → 404 `not_found`；body 不合法 → 400 带说明。
 *   - 鉴权失败仍是 403 空体（auth 中间件统一处理，这里不碰）。
 *
 * 为什么不做编辑：编辑记忆等于让它变成第二个人格——用户想改，删了重说一遍更干净。
 * 为什么不做搜索：千级规模先给分组滚动；真上千再加（同设置页不做全局搜索的口径）。
 *
 * 2026-11-08 两条硬边界（D18）：
 *   - 整理**只出建议**，一条都不自动执行；应用必须由人逐条点（没有"全部应用"）。
 *   - 导入**只增不改**：规范化等价即跳过，绝不覆盖 / 删除已有记录。
 */
export interface MemoryApiDeps {
	enabled: boolean;
	/** 测试/探针注入的假模型输出；不传 = 真模型（faux / 未配置 → 503）。 */
	generate?: ReviewGenerator;
}

export function mountMemoryApi(app: Hono, deps: MemoryApiDeps): void {
	app.get("/api/v1/agent/memory", (c) => {
		const scope = (c.req.query("scope") ?? "").trim();
		const rawLimit = Number(c.req.query("limit") ?? 300);
		const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 300;
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const overview = memoryOverview({ ...(scope ? { scope } : {}), limit });
		// canConsolidate / canImport 是能力位（2026-11-08）：前端据此决定渲不渲染按钮。
		// 纯增量字段，老客户端忽略即可；与 GET /agent/policy 的 attachments 同口径。
		return c.json({
			ok: true,
			...overview,
			limit,
			canConsolidate: consolidateLlmEnabled(),
			canImport: memoryImportEnabled(),
		});
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

	// ── 整理记忆（2026-11-08 扫尾批 6 §二）────────────────────
	// 开关关着一律 404（"未启用"，与其它能力端点同口径）；前端按 canConsolidate 不渲染按钮。
	app.post("/api/v1/agent/memory/consolidate/review", async (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!consolidateLlmEnabled()) return c.json({ error: "not_found" }, 404);

		const body = (await c.req.json().catch(() => null)) as { scope?: unknown } | null;
		const scope = typeof body?.scope === "string" ? body.scope.trim() : "";
		if (!scope) return c.json({ error: "bad_request", message: "需要 scope" }, 400);

		const result = await reviewScope(scope, deps.generate ? { generate: deps.generate } : {});
		if (!result.ok) {
			return c.json({ error: result.error, message: result.message }, result.status as 400 | 404 | 502 | 503);
		}
		// 本次整理同时跑一遍**确定性审计**（2026-11-10 批 17 §三）：只写 diff 文件，不删任何一条。
		// 放在模型成功之后：模型挂掉时没必要留一份"看起来整理过"的快照。
		runConsolidatePass(scope);
		return c.json({
			ok: true,
			scope: result.scope,
			total: result.total,
			generatedAt: result.generatedAt,
			proposals: result.proposals,
		});
	});

	app.post("/api/v1/agent/memory/consolidate/apply", async (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!consolidateLlmEnabled()) return c.json({ error: "not_found" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			scope?: unknown;
			keepId?: unknown;
			dropId?: unknown;
		} | null;
		const scope = typeof body?.scope === "string" ? body.scope.trim() : "";
		const keepId = typeof body?.keepId === "string" ? body.keepId.trim() : "";
		const dropId = typeof body?.dropId === "string" ? body.dropId.trim() : "";
		if (!scope || !keepId || !dropId) {
			return c.json({ error: "bad_request", message: "需要 scope / keepId / dropId" }, 400);
		}

		const result = applyProposal(scope, keepId, dropId);
		if (!result.ok) {
			return c.json({ error: result.error, message: result.message }, result.status as 400 | 404 | 502 | 503);
		}
		return c.json({
			ok: true,
			scope: result.scope,
			keepId: result.keepId,
			dropId: result.dropId,
			alreadyApplied: result.alreadyApplied,
		});
	});

	// ── 巩固审计（2026-11-10 批 17 §三）──────────────────────
	// 确定性、只读：产出 { merged, retired, kept } 并落 .data/memory-consolidate-diff.json。
	// **淘汰只出建议，绝不自动删**——没有"应用"端点，删一条仍走 DELETE /memory/:id。
	app.post("/api/v1/agent/memory/consolidate/pass", async (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as { scope?: unknown } | null;
		const scope = typeof body?.scope === "string" ? body.scope.trim() : "";
		if (!scope) return c.json({ error: "bad_request", message: "需要 scope" }, 400);
		if (!/^(global|partner:.+)$/.test(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global 或 partner:<id>" }, 400);
		}
		const diff = runConsolidatePass(scope);
		if (!diff) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		return c.json({ ok: true, ...diff });
	});

	app.get("/api/v1/agent/memory/consolidate/diff", (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const diff = readConsolidateDiff();
		if (!diff) return c.json({ error: "not_found", message: "还没跑过巩固审计" }, 404);
		return c.json({ ok: true, ...diff });
	});

	// ── 导入（2026-11-08 扫尾批 6 §三）──────────────────────
	app.post("/api/v1/agent/memory/import", async (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memoryImportEnabled()) return c.json({ error: "not_found" }, 404);

		const body = (await c.req.json().catch(() => null)) as {
			scope?: unknown;
			items?: unknown;
		} | null;
		const scope = typeof body?.scope === "string" ? body.scope.trim() : "";
		if (!scope) return c.json({ error: "bad_request", message: "需要 scope" }, 400);

		const result = importMemory(scope, body?.items);
		if (!result.ok) {
			return c.json({ error: result.error, message: result.message }, result.status as 400 | 404 | 502 | 503);
		}
		return c.json({
			ok: true,
			scope: result.scope,
			added: result.added,
			skipped: result.skipped,
			total: result.total,
		});
	});
}
