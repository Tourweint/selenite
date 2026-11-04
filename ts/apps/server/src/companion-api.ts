import type { Hono } from "hono";
import {
	COMPANIONS_ENABLED,
	partnersStore,
	type PartnerStatus,
	type RoutineTrigger,
} from "./partners.ts";
import { runPartnerTurn } from "./partner-runtime.ts";
import { routineEngine } from "./routines.ts";
import { validateModelChain, type ModelChainItem } from "./model-chain.ts";

/**
 * 伙伴管理接口（2026-11-05 批次B B2）。
 *
 * 档案的建/改/删是**用户操作**，模型没有对应工具——身份的编辑权在人手里。
 * `COMPANIONS_ENABLED=false` 时本模块一个路由都不挂：404 语义 = 未启用
 * （鉴权失败才是 403 空体；业务拒绝才 400 带说明）。
 */

export function mountCompanions(app: Hono): void {
	if (!COMPANIONS_ENABLED) return;
	const store = () => partnersStore();

	// 建伙伴：只必填 name。创建即建家 + 首个身份版本，创建后可直接跑一轮。
	app.post("/api/v1/partners", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
		const name = body?.name?.trim() ?? "";
		if (!name || name.length > 40) {
			return c.json({ error: "bad_request", message: "name 必填且不超过 40 字" }, 400);
		}
		const partner = store().create(name);
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
			| { name?: string; status?: string; soul?: string; modelChain?: ModelChainItem[] }
			| null;
		const partner = store().get(id);
		if (!partner) return c.json({ ok: false, error: "not_found" }, 404);

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
		const id = c.req.param("id");
		// 删除 = 档案 + 版本 + 链接 + 家目录一起没。二次确认由客户端做；
		// 服务端只认"这个 id 存在"。
		const removed = store().delete(id);
		if (!removed) return c.json({ ok: false, error: "not_found" }, 404);
		return c.json({ ok: true });
	});

	// 手动跑一轮（试跑入口；例行任务引擎走 runPartnerTurn 同一条路）
	app.post("/api/v1/partners/:id/run", async (c) => {
		const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
		const result = await runPartnerTurn(c.req.param("id"), body?.text?.trim() ?? "");
		if (!result.ok && result.error === "伙伴不存在") {
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
	if (!body?.partnerId || !partnersStore().get(body.partnerId)) return "partnerId 必须指向已存在的伙伴";
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
function projection(partner: { id: string; name: string; status: string; currentVersion: number | null; createdAt: string; updatedAt: string }) {
	return {
		id: partner.id,
		name: partner.name,
		status: partner.status,
		soulVersion: partner.currentVersion,
		createdAt: partner.createdAt,
		updatedAt: partner.updatedAt,
	};
}
