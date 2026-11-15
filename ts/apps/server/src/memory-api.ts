import type { Hono } from "hono";
import type { MemoryKind } from "@lifediary/memory";
import { forgetMemory, memoryOverview, supersedeMemory } from "./agent.ts";
import {
	applyProposal,
	consolidateJobEnabled,
	consolidateLlmEnabled,
	dismissProposal,
	importMemory,
	memoryImportEnabled,
	reviewState,
	startReview,
	validTargetScope,
	type EvidenceFinder,
	type ReviewGenerator,
} from "./memory-consolidate.ts";
import { readConsolidateDiff, runConsolidatePass } from "./memory-consolidate-pass.ts";
import { listMemoryImportSources, memoryImportSourcesEnabled, runMemoryImportSource } from "./memory-import-sources.ts";
import { deleteMemoryNightlyTask, memoryNightlyAt, memoryNightlyEnabled, memoryNightlyScopes, nextNightlyAt, restartMemoryNightlyScheduler, setMemoryNightlyAt, setMemoryNightlyTaskEnabled } from "./memory-nightly.ts";
import { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { projectsStore } from "./projects.ts";
import { askPersonaAvailable, askPersonaCatalog, personaAskEnabled } from "./persona-ask.ts";

/** 记忆管理端点接受的 kind 全集（2026-11-13：列表过滤与排除都只认这些）。 */
const ALL_MEMORY_KINDS: MemoryKind[] = [
	"preference",
	"intention",
	"fact",
	"entity",
	"episode",
	"experience",
	"work",
	"impression",
];

function parseKindList(raw: string | undefined): MemoryKind[] | null {
	if (!raw) return null;
	const out: MemoryKind[] = [];
	for (const part of raw.split(",")) {
		const value = part.trim() as MemoryKind;
		if (!value) continue;
		if (!ALL_MEMORY_KINDS.includes(value)) return []; // 空数组 = 非法（调用方 400）
		if (!out.includes(value)) out.push(value);
	}
	return out.length > 0 ? out : null;
}

/** 外接记忆库页脚开关（2026-11-13）：`MEMORY_EXTERNAL=false` 时整块不显示、端点 404。 */
function memoryExternalEnabled(): boolean {
	const value = (process.env.MEMORY_EXTERNAL ?? "").trim().toLowerCase();
	return value !== "false" && value !== "0" && value !== "off";
}

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
	/** 测试/探针注入的假证据查找；不传 = 真扫跨会话记录（`MEMORY_REVIEW_EVIDENCE=false` 可关）。 */
	findEvidence?: EvidenceFinder;
}

export function mountMemoryApi(app: Hono, deps: MemoryApiDeps): void {
	app.get("/api/v1/agent/memory", (c) => {
		const scope = (c.req.query("scope") ?? "").trim();
		const rawLimit = Number(c.req.query("limit") ?? 300);
		// 2026-11-13：limit=0 = 只回计数（A 版首屏先拉概览，再按分组懒加载）。
		const limit = Number.isFinite(rawLimit)
			? Math.max(0, Math.min(2000, Math.floor(rawLimit)))
			: 300;
		const rawOffset = Number(c.req.query("offset") ?? 0);
		const offset = Number.isFinite(rawOffset)
			? Math.max(0, Math.min(1_000_000, Math.floor(rawOffset)))
			: 0;
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const kinds = parseKindList(c.req.query("kind"));
		const excludeKinds = parseKindList(c.req.query("excludeKinds"));
		if (kinds !== null && kinds.length === 0) {
			return c.json({ error: "bad_request", message: "kind 里有认不出的记忆类型" }, 400);
		}
		if (excludeKinds !== null && excludeKinds.length === 0) {
			return c.json({ error: "bad_request", message: "excludeKinds 里有认不出的记忆类型" }, 400);
		}
		const q = (c.req.query("q") ?? "").trim().slice(0, 200);
		const overview = memoryOverview({
			...(scope ? { scope } : {}),
			limit,
			offset,
			...(q ? { q } : {}),
			...(kinds ? { kinds } : {}),
			...(excludeKinds ? { excludeKinds } : {}),
		});
		// canConsolidate / canImport 是能力位（2026-11-08）：前端据此决定渲不渲染按钮。
		// 纯增量字段，老客户端忽略即可；与 GET /agent/policy 的 attachments 同口径。
		return c.json({
			ok: true,
			...overview,
			limit,
			offset,
			canConsolidate: consolidateLlmEnabled(),
			canImport: memoryImportEnabled(),
			// 后台整理能力位（2026-11-13）：true = 前端可以用 ?background=1 并轮询 state。
			consolidateJob: consolidateJobEnabled(),
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

	// ── 记忆范围清单（2026-11-14）──────────────────────────────
	// A 版改成"一排人"后，页面一次拿全：我的记忆 + 每个在职执事 + 各自条数。
	// 只读、只算计数（limit=0），不返回正文；执事列表拿不到时只剩"我的记忆"，不挡页面。
	app.get("/api/v1/agent/memory/scopes", (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const scopes: Array<{ scope: string; label: string; count: number; kind: "mine" | "partner" | "project" }> = [
			{
				scope: "global",
				label: "我的记忆",
				// 与列表默认口径一致：work 是履历台账，不算"记忆条数"（否则页签数字比列表多）
				count: memoryOverview({ scope: "global", limit: 0, excludeKinds: ["work"] }).counts.all,
				kind: "mine",
			},
		];
		if (COMPANIONS_ENABLED) {
			try {
				for (const partner of partnersStore().list()) {
					if (!partner.id || partner.id === CHIEF_PARTNER_ID) continue;
					if (partner.status === "archived") continue;
					const scope = `partner:${partner.id}`;
					scopes.push({
						scope,
						label: partner.name || "执事",
						count: memoryOverview({ scope, limit: 0, excludeKinds: ["work"] }).counts.all,
						kind: "partner",
					});
				}
			} catch (error) {
				// 执事库读不到（还没建 / 迁移中）不影响看自己的记忆
				console.warn(`[memory] 范围清单读执事失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// 项目记忆（2026-11-15 项目记忆方案）：有记忆的项目才列（免得空 tab 一排），
		// 软删（archived）项目里还存着记忆的也列出来——记忆还在，就该有地方看。
		try {
			for (const project of projectsStore().listProjects(true)) {
				const scope = `project:${project.id}`;
				const count = memoryOverview({ scope, limit: 0, excludeKinds: ["work"] }).counts.all;
				if (count <= 0) continue;
				scopes.push({ scope, label: project.name, count, kind: "project" });
			}
		} catch (error) {
			console.warn(`[memory] 范围清单读项目失败: ${error instanceof Error ? error.message : String(error)}`);
		}
		// 外部导入伪 scope（__imported__）2026-11-15 当天撤回：用户拍板「导入了就是自己的记忆」，
		// 导入条目就落在 global / 项目 scope 里照常显示与召回，不再单开一个查看区。
		return c.json({ ok: true, scopes });
	});

	// ── 每晚整理（2026-11-14）：定时任务页要看见"谁在什么时候整理记忆" ──
	// 读 + 单人暂停/启用/删除；真正执行仍是 memory-nightly 的进程内定时器，不在 routine 表里。
	app.get("/api/v1/agent/memory/nightly", (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const at = memoryNightlyAt();
		return c.json({
			ok: true,
			enabled: memoryNightlyEnabled(),
			at,
			nextAt: nextNightlyAt(new Date(), at).toISOString(),
			scopes: memoryNightlyScopes(),
		});
	});
	app.patch("/api/v1/agent/memory/nightly", async (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as { at?: unknown } | null;
		if (typeof body?.at !== "string" || !setMemoryNightlyAt(body.at)) {
			return c.json({ error: "bad_request", message: "时间只能是 HH:MM" }, 400);
		}
		restartMemoryNightlyScheduler();
		const at = memoryNightlyAt();
		return c.json({ ok: true, at, nextAt: nextNightlyAt(new Date(), at).toISOString() });
	});
	app.patch("/api/v1/agent/memory/nightly/:scope", async (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
		if (typeof body?.enabled !== "boolean") {
			return c.json({ error: "bad_request", message: "enabled 只能是 true 或 false" }, 400);
		}
		const scope = decodeURIComponent(c.req.param("scope") || "");
		if (!setMemoryNightlyTaskEnabled(scope, body.enabled)) {
			return c.json({ error: "not_found", message: "没有这个整理任务" }, 404);
		}
		return c.json({ ok: true, scope, enabled: body.enabled });
	});
	app.delete("/api/v1/agent/memory/nightly/:scope", (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const scope = decodeURIComponent(c.req.param("scope") || "");
		if (!deleteMemoryNightlyTask(scope)) {
			return c.json({ error: "not_found", message: "没有这个整理任务" }, 404);
		}
		return c.json({ ok: true, deleted: scope });
	});

	// ── 外接记忆库 · 库边界（2026-11-13 A 版页脚）──────────────
	// 只读：`ask.py --catalog-only`，不碰 persona.db、不调模型。未配置不 spawn。
	app.get("/api/v1/agent/memory/external", async (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memoryExternalEnabled()) return c.json({ error: "not_found" }, 404);

		const configured = askPersonaAvailable();
		const enabled = personaAskEnabled();
		const provider = { id: "persona", name: "一生记忆库" } as const;
		if (!configured || !enabled) {
			return c.json({
				ok: true,
				configured,
				ready: false,
				provider,
				reason: configured ? "disabled" : "not_configured",
			});
		}

		const catalog = await askPersonaCatalog();
		return c.json({
			ok: true,
			configured: true,
			ready: catalog.ok,
			provider,
			...(catalog.lines.length ? { catalog: { lines: catalog.lines } } : {}),
			...(catalog.ok ? {} : { reason: catalog.error || "unavailable" }),
		});
	});

	// ── 整理记忆（2026-11-08 扫尾批 6 §二；2026-11-13 后台任务）────
	// 开关关着一律 404（"未启用"，与其它能力端点同口径）；前端按 canConsolidate 不渲染按钮。
	// `?background=1` = 立即 202 + 后台跑（A 版记忆页）；不带 = 同步返回（旧页/旧探针兼容）。
	app.post("/api/v1/agent/memory/consolidate/review", async (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!consolidateLlmEnabled()) return c.json({ error: "not_found" }, 404);

		const body = (await c.req.json().catch(() => null)) as { scope?: unknown } | null;
		const scope = typeof body?.scope === "string" ? body.scope.trim() : "";
		if (!scope) return c.json({ error: "bad_request", message: "需要 scope" }, 400);
		if (!validTargetScope(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global 或 partner:<id>" }, 400);
		}

		const background =
			consolidateJobEnabled() && (c.req.query("background") === "1" || c.req.query("background") === "true");
		const job = startReview(scope, {
			...(deps.generate ? { generate: deps.generate } : {}),
			...(deps.findEvidence ? { findEvidence: deps.findEvidence } : {}),
			// 本次整理同时跑一遍**确定性审计**（2026-11-10 批 17 §三）：只写 diff 文件，不删任何一条。
			// 放在任务成功回调里：模型挂掉时没必要留一份"看起来整理过"的快照。
			onSuccess: () => {
				runConsolidatePass(scope);
			},
		});

		if (background) {
			// 不 await：任务在后台跑，结果由 GET /consolidate/state 读。
			return c.json(
				{
					ok: true,
					scope,
					running: true,
					startedAt: job.startedAt,
					...(job.alreadyRunning ? { alreadyRunning: true } : {}),
				},
				202,
			);
		}
		if (job.alreadyRunning) {
			return c.json(
				{ error: "review_running", message: "这个范围正在整理，请稍候再点", startedAt: job.startedAt },
				409,
			);
		}

		const result = await job.promise!;
		if (!result.ok) {
			return c.json({ error: result.error, message: result.message }, result.status as 400 | 404 | 502 | 503);
		}
		return c.json({
			ok: true,
			scope: result.scope,
			total: result.total,
			generatedAt: result.generatedAt,
			proposals: result.proposals,
		});
	});

	// 整理状态（2026-11-13 A 版）：切页回来能看到"在跑 / 上次结果 / 失败原因"。
	app.get("/api/v1/agent/memory/consolidate/state", (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!consolidateLlmEnabled()) return c.json({ error: "not_found" }, 404);
		const scope = (c.req.query("scope") ?? "").trim();
		if (!scope) return c.json({ error: "bad_request", message: "需要 scope" }, 400);
		if (!validTargetScope(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global 或 partner:<id>" }, 400);
		}
		const state = reviewState(scope);
		const diff = readConsolidateDiff();
		const audit = diff && diff.scope === scope ? diff : null;
		return c.json({ ok: true, ...state, audit });
	});

	// 忽略一条整理建议（2026-11-13）：从待决文件与内存结果里摘掉，刷新不再回来。
	app.post("/api/v1/agent/memory/consolidate/dismiss", async (c) => {
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
		if (!validTargetScope(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global 或 partner:<id>" }, 400);
		}
		return c.json({ ok: true, dismissed: dismissProposal(scope, keepId, dropId) });
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

	// ── 导入的本机来源（2026-11-15，方案 docs/设计方案/2026-11-15-记忆导入（接入别家AI的记忆）.md）
	// 别家 AI 已积累的记忆条目一键并进来。路径白名单在 memory-import-sources.ts，
	// 客户端只报来源 id，不传路径——防退化成任意文件读取。
	const sourcesAllowed = () => deps.enabled && memoryImportEnabled() && memoryImportSourcesEnabled();
	app.get("/api/v1/agent/memory/import/sources", (c) => {
		if (!deps.enabled) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memoryImportEnabled() || !memoryImportSourcesEnabled()) {
			return c.json({ error: "not_found" }, 404);
		}
		return c.json({ ok: true, sources: listMemoryImportSources() });
	});

	app.post("/api/v1/agent/memory/import/sources/:id", (c) => {
		if (!sourcesAllowed()) return c.json({ error: "not_found" }, 404);
		const result = runMemoryImportSource(c.req.param("id"));
		if (!result.ok) {
			return c.json({ error: result.error, message: result.message }, (result.status ?? 400) as 400 | 404 | 503);
		}
		// 与手工导入同一日志口径：只记条数（D8），不记条目内容
		console.log(`[memory] 来源导入 source=${c.req.param("id")} 新增=${result.added} 跳过=${result.skipped} 共=${result.total}`);
		return c.json({ ok: true, source: c.req.param("id"), added: result.added, skipped: result.skipped, total: result.total });
	});
}
