import type { Hono } from "hono";
import {
	COMPANIONS_ENABLED,
	PARTNER_SLOT_LIMIT,
	partnersStore,
	type PartnerRow,
	type PartnerStatus,
	type RoutineTrigger,
} from "./partners.ts";
// 建/停执事的唯一核心实现（批次D D3）：端点与 partner_manage 工具共用，端点只做形状映射。
import { createMinisterPartner, stopMinisterPartner } from "./partner-manage.ts";
import { runPartnerTurn } from "./partner-runtime.ts";
import { routineEngine } from "./routines.ts";
import { validateModelChain, type ModelChainItem } from "./model-chain.ts";

/**
 * 执事管理接口（2026-11-05 批次B B2）。
 *
 * 档案的改（改名 / 暂停 / SOUL / 模型链）是**用户操作**，身份的编辑权在人手里。
 * 执事的建 / 停（批次D D3）另有模型侧入口 `partner_manage`，
 * 但核心逻辑与这里的端点共用 partner-manage.ts，本模块只做 HTTP 形状映射。
 * `COMPANIONS_ENABLED=false` 时本模块一个路由都不挂：404 语义 = 未启用
 * （鉴权失败才是 403 空体；业务拒绝才 400 带说明）。
 */

export function mountCompanions(app: Hono): void {
	if (!COMPANIONS_ENABLED) return;
	const store = () => partnersStore();

	// 建执事：只必填 name。带 domain = 建执事（批次D D2），不带 = 普通执事（行为不变）。
	// soul（E2 #0）：可选一句话身份，建档成功后落一次自定义版本；纯增量，老客户端不带即用原行为。
	app.post("/api/v1/partners", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| { name?: string; domain?: string; soul?: string }
			| null;
		const name = body?.name?.trim() ?? "";
		if (!name || name.length > 40) {
			return c.json({ error: "bad_request", message: "name 必填且不超过 40 字" }, 400);
		}
		const soul = typeof body?.soul === "string" ? body.soul : "";
		// 400 校验照 PATCH 的槽位上限（64KB）：在建档之前拦，避免不合格的 soul 留下半建的档案。
		if (soul && Buffer.byteLength(soul, "utf8") > PARTNER_SLOT_LIMIT) {
			return c.json(
				{ error: "bad_request", message: `内容超过 ${PARTNER_SLOT_LIMIT} 字节上限（槽位护栏）` },
				400,
			);
		}
		const domain = body?.domain?.trim() ?? "";
		let partner: PartnerRow;
		if (!domain) {
			// 普通执事：不带 domain、不碰 chancellor，行为不变。
			partner = store().create(name);
		} else {
			// 执事：核心复用（端点与 partner_manage 工具同一份，见 partner-manage.ts）。
			// error 文案与改动前的 domain 校验 / 回滚逐字一致，端点对外形状零变化。
			const result = createMinisterPartner({ name, domain });
			if (!result.ok) {
				return c.json({ error: "bad_request", message: result.error }, 400);
			}
			partner = result.value;
		}
		// 带 soul 时落一次 v2 自定义版本（把 E1 前端「建完补 PATCH」的两段式收敛成一段）。
		// bumpSoul 自带同一份上限校验，这里再兜住其它写盘错误，400 口径与 PATCH 一致。
		if (soul.trim()) {
			try {
				store().bumpSoul(partner.id, soul);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return c.json({ error: "bad_request", message: detail }, 400);
			}
		}
		return c.json({ ok: true, partner: projection(partner) }, 201);
	});

	app.get("/api/v1/partners", (c) => {
		return c.json({ ok: true, partners: store().list().map(projection) });
	});

	app.get("/api/v1/partners/:id", (c) => {
		const partner = store().get(c.req.param("id"));
		if (!partner) return c.json({ ok: false, error: "not_found" }, 404);
		const current = store().currentVersion(partner.id);
		return c.json({
			ok: true,
			partner: projection(partner),
			// SOUL 当前值（磁盘）与版本号一起给：界面编辑 SOUL 改的是磁盘，生效在下一轮
			soul: store().readSoulFromHome(partner.id) ?? current?.soulSource ?? "",
			soulVersion: current?.version ?? null,
			// 模型候选链（B4）：只含 keyEnv 名，绝不回显任何密钥值
			modelChain: store().getModelChain(partner.id),
		});
	});

	app.patch("/api/v1/partners/:id", async (c) => {
		const id = c.req.param("id");
		const body = (await c.req.json().catch(() => null)) as
			| { name?: string; status?: string; soul?: string; modelChain?: ModelChainItem[]; domain?: string }
			| null;
		const partner = store().get(id);
		if (!partner) return c.json({ ok: false, error: "not_found" }, 404);
		// domain 是执事的路由主键，建后固定；要换领域先删再建。
		if (body?.domain !== undefined) {
			return c.json({ error: "bad_request", message: "domain 建后固定，不可修改" }, 400);
		}

		const status = body?.status;
		if (status !== undefined && !["active", "paused", "archived"].includes(status)) {
			return c.json(
				{ error: "bad_request", message: "status 只能是 active / paused / archived" },
				400,
			);
		}
		const patch: { name?: string; status?: PartnerStatus } = {};
		if (body?.name !== undefined) patch.name = body.name;
		if (status !== undefined) patch.status = status as PartnerStatus;
		const updated = store().update(id, patch);
		if (!updated) return c.json({ ok: false, error: "not_found" }, 404);

		// SOUL 修改 = 磁盘当前值 + 新版本快照（不覆盖旧版本：演化链可追溯）
		let soulVersion: number | null = null;
		if (typeof body?.soul === "string" && body.soul.trim()) {
			try {
				soulVersion = store().bumpSoul(id, body.soul);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return c.json({ error: "bad_request", message: detail }, 400);
			}
		}

		// 模型候选链（B4）：只存 keyEnv 名（密钥纪律），写进新版本快照
		if (body?.modelChain !== undefined) {
			const invalid = validateModelChain(body.modelChain);
			if (invalid) return c.json({ error: "bad_request", message: invalid }, 400);
			soulVersion = store().setModelChain(id, body.modelChain);
		}

		return c.json({
			ok: true,
			partner: projection(updated),
			...(soulVersion !== null ? { soulVersion } : {}),
		});
	});

	app.delete("/api/v1/partners/:id", (c) => {
		// 停执事：执事归档 chancellor 领域目录后再删档案，普通执事直接删（行为不变）。
		// 核心逻辑与 partner_manage 的 stop 共用，见 partner-manage.ts。
		const result = stopMinisterPartner(c.req.param("id"));
		if (!result.ok) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true });
	});

	// 手动跑一轮（试跑入口；例行任务引擎走 runPartnerTurn 同一条路）
	app.post("/api/v1/partners/:id/run", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
		const result = await runPartnerTurn(c.req.param("id"), body?.text?.trim() ?? "");
		if (!result.ok && result.error === "执事不存在") {
			return c.json({ ok: false, error: "not_found" }, 404);
		}
		return c.json(result, result.ok ? 200 : 400);
	});

	// ── 例行任务（批次B B3）──────────────────────────────
	app.post("/api/v1/routines", async (c) => {
		const body = (await c.req.json().catch(() => null)) as
			| {
					partnerId?: string;
					name?: string;
					prompt?: string;
					triggers?: RoutineTrigger[];
					sessionMode?: string;
					enabled?: boolean;
			  }
			| null;
		const error = validateRoutineInput(body);
		if (error) return c.json({ error: "bad_request", message: error }, 400);
		const routine = store().createRoutine({
			partnerId: body?.partnerId as string,
			name: body?.name as string,
			prompt: body?.prompt as string,
			triggers: body?.triggers as RoutineTrigger[],
			sessionMode: body?.sessionMode === "fresh" ? "fresh" : "persistent",
			enabled: body?.enabled !== false,
		});
		// 排定时链：失败（会话取不到）不挡创建，任务状态照实返回
		let scheduleError: string | undefined;
		try {
			await routineEngine().ensureScheduled(routine.id);
		} catch (e) {
			scheduleError = e instanceof Error ? e.message : String(e);
		}
		return c.json({ ok: true, routine, ...(scheduleError ? { scheduleError } : {}) }, 201);
	});

	app.get("/api/v1/routines", (c) => {
		const partnerId = c.req.query("partnerId");
		return c.json({
			ok: true,
			routines: store().listRoutines(partnerId || undefined).map(routineProjection),
		});
	});

	app.get("/api/v1/routines/:id/runs", (c) => {
		const routine = store().getRoutine(c.req.param("id"));
		if (!routine) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true, runs: routineEngine().runsOf(routine.id) });
	});

	app.patch("/api/v1/routines/:id", async (c) => {
		const id = c.req.param("id");
		const body = (await c.req.json().catch(() => null)) as
			| { name?: string; prompt?: string; triggers?: RoutineTrigger[]; sessionMode?: string; enabled?: boolean }
			| null;
		if (body?.triggers !== undefined && validateTriggers(body.triggers)) {
			return c.json({ error: "bad_request", message: validateTriggers(body.triggers) }, 400);
		}
		const routine = store().updateRoutine(id, {
			...(body?.name !== undefined ? { name: body.name } : {}),
			...(body?.prompt !== undefined ? { prompt: body.prompt } : {}),
			...(body?.triggers !== undefined ? { triggers: body.triggers } : {}),
			...(body?.sessionMode !== undefined ? { sessionMode: body.sessionMode === "fresh" ? "fresh" : "persistent" } : {}),
			...(body?.enabled !== undefined ? { enabled: body.enabled } : {}),
		});
		if (!routine) return c.json({ ok: false, error: "not_found" }, 404);
		// 改动 = revision+1：旧任务醒来作废；还开着就按新触发器重排
		if (routine.enabled) {
			try {
				await routineEngine().ensureScheduled(routine.id);
			} catch (e) {
				return c.json(
					{ ok: true, routine: routineProjection(routine), scheduleError: e instanceof Error ? e.message : String(e) },
				);
			}
		}
		return c.json({ ok: true, routine: routineProjection(routine) });
	});

	app.delete("/api/v1/routines/:id", (c) => {
		const removed = store().deleteRoutine(c.req.param("id"));
		if (!removed) return c.json({ ok: false, error: "not_found" }, 404);
		// 在飞的 durable 任务醒来对不上规则 → 自动作废（revision 机制），无取消 API 也不残留
		return c.json({ ok: true });
	});

	app.post("/api/v1/routines/:id/run_now", async (c) => {
		const result = await routineEngine().runNow(c.req.param("id"));
		if (!result.ok && result.error === "例行任务不存在") {
			return c.json({ ok: false, error: "not_found" }, 404);
		}
		return c.json(result, result.ok ? 200 : 400);
	});
}

function validateTriggers(triggers: unknown): string | null {
	if (!Array.isArray(triggers) || triggers.length === 0) {
		return "triggers 必须是非空数组";
	}
	for (const trigger of triggers) {
		const t = trigger as { type?: string; expr?: string; seconds?: number; at?: string; kind?: string };
		if (t.type === "cron") {
			if (typeof t.expr !== "string" || t.expr.trim().split(/\s+/).length !== 5) {
				return "cron 触发器需要 5 段表达式（分 时 日 月 周）";
			}
		} else if (t.type === "interval") {
			if (typeof t.seconds !== "number" || t.seconds < 60) {
				return "interval 触发器的 seconds 至少 60";
			}
		} else if (t.type === "once") {
			if (typeof t.at !== "string" || Number.isNaN(Date.parse(t.at))) {
				return "once 触发器需要合法的 at（ISO 时间）";
			}
		} else if (t.type === "event") {
			if (t.kind !== "delegation" && t.kind !== "tool" && t.kind !== "phase") {
				return "event 触发器的 kind 只能是 delegation / tool / phase";
			}
		} else {
			return "触发器 type 只能是 cron / interval / once / event";
		}
	}
	return null;
}

function validateRoutineInput(body: {
	partnerId?: string;
	name?: string;
	prompt?: string;
	triggers?: RoutineTrigger[];
} | null): string | null {
	if (!body?.partnerId || !partnersStore().get(body.partnerId)) return "partnerId 必须指向已存在的执事";
	if (!body.name?.trim() || body.name.length > 40) return "name 必填且不超过 40 字";
	if (!body.prompt?.trim()) return "prompt 必填";
	if (body.prompt.length > 100_000) return "prompt 超过 100k 上限";
	return validateTriggers(body.triggers);
}

function routineProjection(routine: {
	id: string;
	partnerId: string;
	name: string;
	triggers: RoutineTrigger[];
	sessionMode: string;
	enabled: boolean;
	revision: number;
	createdAt: string;
	updatedAt: string;
}) {
	return {
		id: routine.id,
		partnerId: routine.partnerId,
		name: routine.name,
		triggers: routine.triggers,
		sessionMode: routine.sessionMode,
		enabled: routine.enabled,
		revision: routine.revision,
		createdAt: routine.createdAt,
		updatedAt: routine.updatedAt,
	};
}

/** 对外投影：只给对外字段。canonical 会话的内部自增 id 不出网（对外 id 一律 uuid）。 */
function projection(partner: { id: string; name: string; status: string; currentVersion: number | null; createdAt: string; updatedAt: string; domain?: string | null }) {
	return {
		id: partner.id,
		name: partner.name,
		status: partner.status,
		soulVersion: partner.currentVersion,
		createdAt: partner.createdAt,
		updatedAt: partner.updatedAt,
		// 纯增量：普通执事不带这个字段（行为零变化），执事带 domain。
		...(partner.domain ? { domain: partner.domain } : {}),
	};
}
