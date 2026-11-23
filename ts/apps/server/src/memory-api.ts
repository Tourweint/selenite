import type { Hono } from "hono";
import type { MemoryKind } from "@lifediary/memory";
import { forgetMemory, memoryEngine, memoryOverview, supersedeMemory } from "./agent.ts";
import {
	applyProposal,
	consolidateLlmEnabled,
	dismissProposal,
	importMemory,
	memoryImportEnabled,
	reviewState,
	startReview,
	validTargetScope,
	type ReviewGenerator,
} from "./memory-consolidate.ts";
import { readConsolidateDiff, runConsolidatePass } from "./memory-consolidate-pass.ts";
import { listMemoryImportSources, memoryImportSourcesEnabled, runMemoryImportSource } from "./memory-import-sources.ts";
import { deleteMemoryNightlyTask, memoryNightlyAt, memoryNightlyEnabled, memoryNightlyScopes, nextNightlyAt, restartMemoryNightlyScheduler, setMemoryNightlyAt, setMemoryNightlyTaskEnabled } from "./memory-nightly.ts";
import { applySplitPlan, buildSplitPlan, memorySplitEnabled } from "./memory-split.ts";
import { applySmartSplit, MAX_SMART_SPLIT_RECORDS, resolveSplitModel, runSmartSplit, type SmartSplitRecord } from "./memory-split-smart.ts";
import { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { projectsStore } from "./projects.ts";
import { askPersonaAvailable, askPersonaCatalog, personaAskEnabled } from "./persona-ask.ts";
import { flagEnabled } from "./flags.ts";
import { memoryScopeMoveEnabled, moveScopeChecked } from "./memory-scope-move.ts";

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
	return flagEnabled("MEMORY_EXTERNAL");
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
	/** 布尔或活读函数（2026-11-16）：函数形式让运行期关闭 `MEMORY_ENABLED` 立刻 404，
	 *  不再只认启动时的 `memoryEngine !== null` 快照。 */
	enabled: boolean | (() => boolean);
	/** 测试/探针注入的假模型输出；不传 = 真模型（faux / 未配置 → 503）。 */
	generate?: ReviewGenerator;
}

function memoryApiEnabled(deps: MemoryApiDeps): boolean {
	return typeof deps.enabled === "function" ? deps.enabled() : deps.enabled;
}

export function mountMemoryApi(app: Hono, deps: MemoryApiDeps): void {
	const enabled = () => memoryApiEnabled(deps);
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
		if (!enabled()) {
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
			// 长记忆拆分能力位（2026-11-16）：前端据此决定渲不渲染「拆分记忆」。
			canSplit: memorySplitEnabled(),
			// 后台整理能力位（2026-11-13）：true = 前端可以用 ?background=1 并轮询 state。
			//（MEMORY_CONSOLIDATE_JOB 回滚开关 2026-11-21 退役，恒 true。）
		consolidateJob: true,
		});
	});

	// ── 长记忆拆分（2026-11-16 原子化）──────────────────────
	// 预览 + 应用都只做机械拆分：摘要 / 短句进原子，原文进 memory_documents。
	// 语义拆分（模型提炼）后续单独接；这里没有模型调用，不需要 D18 的逐条应用。
	app.get("/api/v1/agent/memory/split/candidates", (c) => {
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memorySplitEnabled()) {
			return c.json({ error: "split_disabled", message: "长记忆拆分未启用（MEMORY_SPLIT=false）" }, 404);
		}
		if (!memoryEngine) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const scope = (c.req.query("scope") ?? "global").trim() || "global";
		if (!validTargetScope(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global、partner:<id> 或 project:<uuid>" }, 400);
		}
		const preview = buildSplitPlan(memoryEngine, scope);
		return c.json({
			ok: true,
			scope,
			scanned: preview.scanned,
			unmatched: preview.unmatched,
			total: preview.candidates.length,
			items: preview.candidates,
		});
	});

	app.post("/api/v1/agent/memory/split/apply", async (c) => {
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memorySplitEnabled()) {
			return c.json({ error: "split_disabled", message: "长记忆拆分未启用（MEMORY_SPLIT=false）" }, 404);
		}
		if (!memoryEngine) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as
			| { scope?: unknown; ids?: unknown }
			| null;
		const scope = typeof body?.scope === "string" ? body.scope.trim() || "global" : "global";
		if (!validTargetScope(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global、partner:<id> 或 project:<uuid>" }, 400);
		}
		if (
			body?.ids !== undefined &&
			(!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string"))
		) {
			return c.json({ error: "bad_request", message: "ids 必须是字符串数组" }, 400);
		}
		const ids = Array.isArray(body?.ids) ? (body.ids as string[]) : undefined;
		const splitOptions = ids === undefined ? {} : { ids };
		const preview = buildSplitPlan(memoryEngine, scope, splitOptions);
		const result = applySplitPlan(memoryEngine, preview, splitOptions);
		return c.json({
			ok: true,
			scope,
			candidates: preview.candidates.length,
			...result,
		});
	});

	// ── 智能拆分（2026-11-16）：用所选模型把长记忆拆成原子，只出候选 ──
	// 与代码拆分同一套落点（原文档案 + 原子 + 归档），区别只在"谁来切"。
	// 走辅助模型的独立一次性请求：不读对话历史、不写回主上下文，只花所选模型的额度。
	app.post("/api/v1/agent/memory/split/smart", async (c) => {
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memorySplitEnabled()) {
			return c.json({ error: "split_disabled", message: "长记忆拆分未启用（MEMORY_SPLIT=false）" }, 404);
		}
		if (!memoryEngine) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as
			| { scope?: unknown; ids?: unknown; model?: unknown }
			| null;
		const scope = typeof body?.scope === "string" ? body.scope.trim() || "global" : "global";
		if (!validTargetScope(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global、partner:<id> 或 project:<uuid>" }, 400);
		}
		if (
			body?.ids !== undefined &&
			(!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string"))
		) {
			return c.json({ error: "bad_request", message: "ids 必须是字符串数组" }, 400);
		}
		const ids = Array.isArray(body?.ids) ? (body.ids as string[]) : undefined;
		if (ids !== undefined && ids.length > MAX_SMART_SPLIT_RECORDS) {
			return c.json(
				{ error: "too_many_items", message: `一次最多智能拆分 ${MAX_SMART_SPLIT_RECORDS} 条` },
				400,
			);
		}
		const model =
			body?.model && typeof body.model === "object"
				? (() => {
						const row = body.model as Record<string, unknown>;
						const provider = typeof row.provider === "string" ? row.provider.trim() : "";
						const modelId = typeof row.modelId === "string" ? row.modelId.trim() : "";
						return provider && modelId ? { provider, modelId } : null;
					})()
				: null;
		if (body?.model !== undefined && body.model !== null && !model) {
			return c.json({ error: "bad_request", message: "model 必须是 {provider, modelId}" }, 400);
		}
		if (!resolveSplitModel(model)) {
			return c.json({ error: "llm_not_configured", message: "所选模型不可用（未配置或 faux）" }, 503);
		}
		const preview = buildSplitPlan(memoryEngine, scope, ids === undefined ? {} : { ids });
		if (preview.plans.length === 0) {
			return c.json({ ok: true, scope, model: null, calls: 0, records: [], candidates: 0 });
		}
		const result = await runSmartSplit(memoryEngine, preview.plans, {
			...(ids === undefined ? {} : { ids }),
			...(model ? { model } : {}),
		});
		if (!result.ok) {
			return c.json(
				{ error: "llm_failed", message: result.error ?? "智能拆分失败" },
				result.error === "model_unavailable" ? 503 : 502,
			);
		}
		return c.json({
			ok: true,
			scope,
			model: result.model,
			calls: result.calls,
			candidates: preview.candidates.length,
			records: result.records,
		});
	});

	app.post("/api/v1/agent/memory/split/smart/apply", async (c) => {
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memorySplitEnabled()) {
			return c.json({ error: "split_disabled", message: "长记忆拆分未启用（MEMORY_SPLIT=false）" }, 404);
		}
		if (!memoryEngine) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as
			| { scope?: unknown; records?: unknown }
			| null;
		const scope = typeof body?.scope === "string" ? body.scope.trim() || "global" : "global";
		if (!validTargetScope(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global、partner:<id> 或 project:<uuid>" }, 400);
		}
		if (!Array.isArray(body?.records)) {
			return c.json({ error: "bad_request", message: "records 必须是数组" }, 400);
		}
		const records: SmartSplitRecord[] = [];
		for (const item of body.records) {
			if (!item || typeof item !== "object") continue;
			const row = item as Record<string, unknown>;
			if (typeof row.recordId !== "string" || !Array.isArray(row.atoms)) continue;
			const atoms = row.atoms
				.filter((atom): atom is Record<string, unknown> => Boolean(atom) && typeof atom === "object")
				.map((atom) => ({
					content: typeof atom.content === "string" ? atom.content : "",
					quote: typeof atom.quote === "string" ? atom.quote : "",
					quoteStart: null,
					quoteEnd: null,
				}))
				.filter((atom) => atom.content && atom.quote);
			if (atoms.length === 0) continue;
			records.push({
				recordId: row.recordId,
				title: typeof row.title === "string" ? row.title : "",
				kind: (typeof row.kind === "string" ? row.kind : "fact") as SmartSplitRecord["kind"],
				chars: typeof row.chars === "number" ? row.chars : 0,
				atoms,
				dropped: 0,
			});
		}
		if (records.length === 0) {
			return c.json({ error: "bad_request", message: "没有可应用的原子" }, 400);
		}
		const preview = buildSplitPlan(memoryEngine, scope, { ids: records.map((record) => record.recordId) });
		const result = applySmartSplit(memoryEngine, preview.plans, records);
		return c.json({ ok: true, scope, ...result });
	});

	// ── 原文档案（2026-11-16 原子化）────────────────────────
	// 列表不带正文；单份读取才回 content。只读，不提供删除（原文是证据，删了就没法核对）。
	app.get("/api/v1/agent/memory/documents", (c) => {
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memoryEngine) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const scope = (c.req.query("scope") ?? "global").trim() || "global";
		if (!validTargetScope(scope)) {
			return c.json({ error: "bad_request", message: "scope 只能是 global、partner:<id> 或 project:<uuid>" }, 400);
		}
		const rawLimit = Number(c.req.query("limit") ?? 100);
		const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 100;
		const rawOffset = Number(c.req.query("offset") ?? 0);
		const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
		const docs = memoryEngine.listDocuments({ scopes: [scope], limit, offset, includeContent: false });
		return c.json({
			ok: true,
			scope,
			total: memoryEngine.countDocuments(scope),
			items: docs.map((doc) => ({
				id: doc.id,
				scope: doc.scope,
				title: doc.title,
				source: doc.source,
				sourceRef: doc.sourceRef,
				chars: doc.chars,
				createdAt: doc.createdAt,
			})),
			offset,
			limit,
		});
	});

	app.get("/api/v1/agent/memory/documents/:id", (c) => {
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memoryEngine) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const id = c.req.param("id").trim();
		if (!id) return c.json({ error: "bad_request", message: "缺少原文 id" }, 400);
		const document = memoryEngine.getDocument(id);
		if (!document) return c.json({ error: "not_found", message: "没有这份原文" }, 404);
		return c.json({ ok: true, document });
	});

	app.delete("/api/v1/agent/memory/:id", (c) => {
		const id = c.req.param("id").trim();
		if (!enabled()) {
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
		if (!enabled()) {
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
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const scopes: Array<{
			scope: string;
			label: string;
			count: number;
			kind: "mine" | "partner" | "project" | "orphan";
		}> = [
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
		// 孤儿 scope（2026-11-17 项目合并与记忆迁移）：项目登记已硬删，记忆还在。
		// 之前它们"不可见即无害"= 永久封存；这里让它们至少可读、可整理、可迁走。
		// label 只能给 uuid 前缀——项目行没了，名字无处可取（刻意不建墓碑表）。
		try {
			const known = new Set(projectsStore().listProjects(true).map((project) => project.id));
			const orphans = (memoryEngine?.listScopes() ?? [])
				.filter((scope) => scope.startsWith("project:"))
				.map((scope) => ({ scope, projectId: scope.slice("project:".length) }))
				.filter((item) => !known.has(item.projectId))
				.sort((a, b) => a.scope.localeCompare(b.scope));
			for (const orphan of orphans) {
				const count = memoryOverview({
					scope: orphan.scope,
					limit: 0,
					excludeKinds: ["work"],
				}).counts.all;
				if (count <= 0) continue;
				scopes.push({
					scope: orphan.scope,
					label: `已删除的项目 · ${orphan.projectId.slice(0, 8)}`,
					count,
					kind: "orphan",
				});
			}
		} catch (error) {
			console.warn(`[memory] 孤儿 scope 扫描失败: ${error instanceof Error ? error.message : String(error)}`);
		}
		// 外部导入伪 scope（__imported__）2026-11-15 当天撤回：用户拍板「导入了就是自己的记忆」，
		// 导入条目就落在 global / 项目 scope 里照常显示与召回，不再单开一个查看区。
		return c.json({ ok: true, scopes });
	});

	// ── 记忆迁移（2026-11-17 项目合并与记忆迁移）──────────────
	// 把一个 scope 的记忆整体改挂到另一个 scope：孤儿记忆归位 / 并入活项目 / 收进我的记忆。
	// 纯机械搬家：不去重（那是「整理」的职责）、不调模型、不动 superseded 引用。
	app.post("/api/v1/agent/memory/scope/move", async (c) => {
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memoryScopeMoveEnabled()) {
			return c.json({ error: "move_disabled", message: "记忆迁移未启用（MEMORY_SCOPE_MOVE=false）" }, 404);
		}
		const body = (await c.req.json().catch(() => null)) as
			| { from?: unknown; to?: unknown }
			| null;
		const from = typeof body?.from === "string" ? body.from.trim() : "";
		const to = typeof body?.to === "string" ? body.to.trim() : "";
		const result = moveScopeChecked(from, to);
		if (!result.ok) {
			return c.json({ error: result.error, message: result.message }, result.status);
		}
		return c.json({ ok: true, from, to, records: result.records, documents: result.documents });
	});

	// ── 每晚整理（2026-11-14）：定时任务页要看见"谁在什么时候整理记忆" ──
	// 读 + 单人暂停/启用/删除；真正执行仍是 memory-nightly 的进程内定时器，不在 routine 表里。
	app.get("/api/v1/agent/memory/nightly", (c) => {
		if (!enabled()) {
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
		if (!enabled()) {
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
		if (!enabled()) {
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
		if (!enabled()) {
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
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		if (!memoryExternalEnabled()) return c.json({ error: "not_found" }, 404);

		const configured = askPersonaAvailable();
		const askEnabled = personaAskEnabled();
		const provider = { id: "persona", name: "一生记忆库" } as const;
		if (!configured || !askEnabled) {
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
		if (!enabled()) {
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
			//（MEMORY_CONSOLIDATE_JOB 回滚开关 2026-11-21 退役，后台整理恒可用。）
			c.req.query("background") === "1" || c.req.query("background") === "true";
		const job = startReview(scope, {
			...(deps.generate ? { generate: deps.generate } : {}),
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
		if (!enabled()) {
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
		if (!enabled()) {
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
		if (!enabled()) {
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
		if (!enabled()) {
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
		if (!enabled()) {
			return c.json({ error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" }, 404);
		}
		const diff = readConsolidateDiff();
		if (!diff) return c.json({ error: "not_found", message: "还没跑过巩固审计" }, 404);
		return c.json({ ok: true, ...diff });
	});

	// ── 导入（2026-11-08 扫尾批 6 §三）──────────────────────
	app.post("/api/v1/agent/memory/import", async (c) => {
		if (!enabled()) {
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
	const sourcesAllowed = () => enabled() && memoryImportEnabled() && memoryImportSourcesEnabled();
	app.get("/api/v1/agent/memory/import/sources", (c) => {
		if (!enabled()) {
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
