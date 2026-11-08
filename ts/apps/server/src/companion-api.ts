import type { Hono } from "hono";
import { inflateSync } from "node:zlib";
import {
	PARTNER_AVATAR_MAX_DIMENSION,
	PARTNER_AVATAR_PREFIX,
	PartnerAvatarPatchSchema,
} from "@lifediary/shared";
import {
	COMPANIONS_ENABLED,
	PARTNER_SLOT_LIMIT,
	partnerContractEnabled,
	partnersStore,
	type PartnerRow,
	type PartnerStatus,
	type RoutineTrigger,
} from "./partners.ts";
// 建/停执事的唯一核心实现（批次D D3）：端点与 partner_manage 工具共用，端点只做形状映射。
import { createMinisterPartner, stopMinisterPartner } from "./partner-manage.ts";
import { runPartnerTurn, openPartnerConversation } from "./partner-runtime.ts";
import { routineEngine } from "./routines.ts";
// triggers 校验上移到 routine-manage.ts：HTTP 端点与 routine_manage 工具共用一份。
import { validateTriggers } from "./routine-manage.ts";
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

/** 档案名上限：建（POST）与改（PATCH）同一口径。 */
const PARTNER_NAME_LIMIT = 40;
/** 当前目标上限（2026-11-08 刀二 E4）：不版本化、现取现用，仍给个护栏防无界正文。 */
const PARTNER_GOAL_LIMIT = 1000;

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
		if (!name || name.length > PARTNER_NAME_LIMIT) {
			return c.json(
				{ error: "bad_request", message: `name 必填且不超过 ${PARTNER_NAME_LIMIT} 字` },
				400,
			);
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
		// 2026-11-07：domain 是**可选标签**。不带 domain 也要能建"可派活的执事"，
		// 不再退化成"普通执事、不参与派单"——这是用户明确反馈的坑：
		// 他建了执事却不知道领域填什么、填完也没有任何可见作用。
		// 折中：仍然走 createMinisterPartner（同一份校验与播种），只是不建分管目录。
		const result = createMinisterPartner({ name, ...(domain ? { domain } : {}) });
		if (!result.ok) {
			return c.json({ error: "bad_request", message: result.error }, 400);
		}
		const partner: PartnerRow = result.value;
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
			// 岗位契约（2026-11-08 员工人格化刀一 E1）：纯增量字段，关掉开关时两列都不出现；
			// **列表端点形状不变**（手机端只读列表，不需要正文）。
			...(partnerContractEnabled()
				? {
						contract:
							store().readContractFromHome(partner.id) ??
							current?.contractSource ??
							"",
						contractVersion: current?.version ?? null,
					}
				: {}),
			// 模型候选链（B4）：只含 keyEnv 名，绝不回显任何密钥值
			modelChain: store().getModelChain(partner.id),
			// 当前目标（2026-11-08 刀二 E4）：纯增量、不版本化、现取现用。
			// **列表端点形状不变**（手机端只读列表，字段经 shared 暴露在刀三）。
			currentGoal: partner.currentGoal,
		});
	});

	/**
	 * 岗位契约编辑（2026-11-08 员工人格化刀一 E1）。
	 *
	 * 形态照 SOUL 的编辑口径（磁盘当前值 + 新版本快照，**下一轮生效**），但独立成一个端点：
	 * 调岗与改人格是两件事，放同一个 PATCH 里会让"我只想改职责"顺手带上人格 diff。
	 * 契约与 SOUL 共用版本号（一个身份版本 = 当时的 SOUL + CONTRACT 对）。
	 *
	 * `PARTNER_CONTRACT=false` → 400 带说明（不是 404：端点还在，只是功能关着，
	 * 与"执事能力整体未启用"的 404 语义区分开）。
	 */
	app.put("/api/v1/partners/:id/contract", async (c) => {
		if (!partnerContractEnabled()) {
			return c.json(
				{
					error: "bad_request",
					message: "岗位契约未启用（PARTNER_CONTRACT=false）",
				},
				400,
			);
		}
		const body = (await c.req.json().catch(() => null)) as { contract?: unknown } | null;
		if (typeof body?.contract !== "string") {
			return c.json({ error: "bad_request", message: "contract 必须是字符串" }, 400);
		}
		// 与 SOUL 同一个槽位护栏：在写盘之前拦，避免半写状态。
		if (Buffer.byteLength(body.contract, "utf8") > PARTNER_SLOT_LIMIT) {
			return c.json(
				{ error: "bad_request", message: `内容超过 ${PARTNER_SLOT_LIMIT} 字节上限（槽位护栏）` },
				400,
			);
		}
		const id = c.req.param("id");
		if (!store().get(id)) return c.json({ ok: false, error: "not_found" }, 404);
		try {
			const contractVersion = store().bumpContract(id, body.contract);
			return c.json({
				ok: true,
				contract: store().readContractFromHome(id) ?? body.contract,
				contractVersion,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return c.json({ error: "bad_request", message: detail }, 400);
		}
	});

	app.patch("/api/v1/partners/:id", async (c) => {
		const id = c.req.param("id");
		const body = (await c.req.json().catch(() => null)) as
			| {
					name?: unknown;
					status?: unknown;
					soul?: unknown;
					modelChain?: unknown;
					domain?: unknown;
					avatar?: unknown;
					dispatchAuthority?: unknown;
					currentGoal?: unknown;
			  }
			| null;
		const partner = store().get(id);
		if (!partner) return c.json({ ok: false, error: "not_found" }, 404);

		// ── 先校验整个 PATCH 对象；任何一项不合法都在写入之前返回 400 ──
		// 头像（2026-11-06 侧栏调整 B1）：语义 = 字段省略不改 / null 清除 / 字符串设置。
		// shared 只验 PNG 结构、块边界与 CRC；CRC 正确但 deflate 流坏掉的图交给下面的 zlib 复核。
		let avatar: string | null | undefined;
		if (body?.avatar !== undefined) {
			const parsed = PartnerAvatarPatchSchema.safeParse(body.avatar);
			if (!parsed.success) {
				return c.json(
					{
						error: "bad_request",
						message: parsed.error.issues[0]?.message ?? "avatar 不合法",
					},
					400,
				);
			}
			avatar = parsed.data;
			if (avatar !== null) {
				const problem = avatarPngDataProblem(avatar);
				if (problem) return c.json({ error: "bad_request", message: problem }, 400);
			}
		}
		// domain 现在是**可选标签**（2026-11-07），建后可改：
		// 它不再承载派活路由（路由按执事 id / 会话链接），所以改名不会让旧单找不到负责人。
		// 只做形状校验：小写 ASCII，与创建时同一套规则；空串 = 清掉标签。
		if (body?.domain !== undefined) {
			const next = typeof body.domain === "string" ? body.domain.trim() : null;
			if (next === null) {
				return c.json({ error: "bad_request", message: "domain 必须是字符串" }, 400);
			}
			if (next && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(next)) {
				return c.json(
					{
						error: "bad_request",
						message: "domain 必须是小写 ASCII（小写字母、数字、连字符，不能以连字符开头或结尾）",
					},
					400,
				);
			}
			const occupied = next ? store().partnerIdByDomain(next) : null;
			if (occupied && occupied !== id) {
				return c.json({ error: "bad_request", message: `domain「${next}」已被其他执事占用` }, 400);
			}
			if (!store().setDomain(id, next || null)) {
				return c.json({ error: "not_found" }, 404);
			}
		}
		// name：省略 / 全空白 = 不改（既有语义）；类型不对或超长 400——别让 update() 里的 trim 抛 500。
		if (body?.name !== undefined) {
			if (typeof body.name !== "string") {
				return c.json({ error: "bad_request", message: "name 必须是字符串" }, 400);
			}
			const name = body.name.trim();
			if (name && name.length > PARTNER_NAME_LIMIT) {
				return c.json(
					{ error: "bad_request", message: `name 不超过 ${PARTNER_NAME_LIMIT} 字` },
					400,
				);
			}
		}
		// status：原枚举校验，保持「省略 = 不改」。
		if (
			body?.status !== undefined &&
			(typeof body.status !== "string" ||
				!["active", "paused", "archived"].includes(body.status))
		) {
			return c.json(
				{ error: "bad_request", message: "status 只能是 active / paused / archived" },
				400,
			);
		}
		// soul：省略 / 空串 = 不改（既有语义）；先按 64KB 槽位上限拦下，避免写完头像/名字后 bumpSoul 才拒绝。
		if (body?.soul !== undefined) {
			if (typeof body.soul !== "string") {
				return c.json({ error: "bad_request", message: "soul 必须是字符串" }, 400);
			}
			if (body.soul.trim() && Buffer.byteLength(body.soul, "utf8") > PARTNER_SLOT_LIMIT) {
				return c.json(
					{ error: "bad_request", message: `内容超过 ${PARTNER_SLOT_LIMIT} 字节上限（槽位护栏）` },
					400,
				);
			}
		}
		// modelChain：省略 = 不改；非法链项在写入之前拒绝（原实现排在所有写入之后）。
		if (body?.modelChain !== undefined) {
			const invalid = validateModelChain(body.modelChain);
			if (invalid) return c.json({ error: "bad_request", message: invalid }, 400);
		}
		// 派发权（2026-11-06 执事派发权开关）：省略 = 不改；类型在写入前拦，避免部分写入。
		if (body?.dispatchAuthority !== undefined && typeof body.dispatchAuthority !== "boolean") {
			return c.json({ error: "bad_request", message: "dispatchAuthority 必须是布尔值" }, 400);
		}
		// 当前目标（2026-11-08 刀二 E4）：省略 = 不改；null / 空串（含全空白）= 清除；
		// 字符串 = 设置（trim 后存）。不版本化——目标不是身份，不 bump 版本、不动 SOUL / 契约。
		let currentGoal: string | null | undefined;
		if (body?.currentGoal !== undefined) {
			if (body.currentGoal === null) {
				currentGoal = null;
			} else if (typeof body.currentGoal === "string") {
				const trimmed = body.currentGoal.trim();
				if (trimmed.length > PARTNER_GOAL_LIMIT) {
					return c.json(
						{ error: "bad_request", message: `currentGoal 不超过 ${PARTNER_GOAL_LIMIT} 字` },
						400,
					);
				}
				currentGoal = trimmed || null;
			} else {
				return c.json({ error: "bad_request", message: "currentGoal 必须是字符串或 null" }, 400);
			}
		}

		// ── 全部合法，开始写 ──
		if (avatar !== undefined) store().setAvatar(id, avatar);
		const patch: { name?: string; status?: PartnerStatus } = {};
		if (typeof body?.name === "string") patch.name = body.name;
		if (typeof body?.status === "string") patch.status = body.status as PartnerStatus;
		const updated = store().update(id, patch);
		if (!updated) return c.json({ ok: false, error: "not_found" }, 404);
		// 派发权（2026-11-06）：只对带 domain 的执事有意义；普通执事 400。
		let refreshed = updated;
		if (body?.dispatchAuthority !== undefined) {
			if (!updated.domain) {
				return c.json({ error: "bad_request", message: "该执事不带 domain，没有派发权可切" }, 400);
			}
			refreshed = store().setDispatchAuthority(id, body.dispatchAuthority) ?? updated;
		}

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
			soulVersion = store().setModelChain(id, body.modelChain as ModelChainItem[]);
		}

		// 当前目标（刀二 E4）：一条 UPDATE，不碰身份版本。省略就完全不写。
		if (currentGoal !== undefined) {
			refreshed = store().setCurrentGoal(id, currentGoal) ?? refreshed;
		}

		return c.json({
			ok: true,
			partner: projection(refreshed),
			// 纯增量回显（不进列表投影）：PATCH 后能直接读回设成什么 / 是否清除。
			currentGoal: refreshed.currentGoal,
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

	/**
	 * 首次打开执事专线（2026-11-06 侧栏调整 B3）。
	 *
	 * 空历史：生成一次身份化问候并写进 canonical（助手消息）；已有历史：直接返回 existing。
	 * 幂等由 durable doc + canonical 事务保证（并发 / 刷新 / 重启都只有一条）。
	 * 错误只给通用中文，不回传上游原文；鉴权失败仍是 403 空体。
	 */
	app.post("/api/v1/partners/:id/open", async (c) => {
		const result = await openPartnerConversation(c.req.param("id"));
		if (result.ok) {
			return c.json({
				ok: true,
				conversationId: result.chat.externalId,
				greeting: result.greeting,
			});
		}
		switch (result.reason) {
			case "chief":
				return c.json({ error: "bad_request", message: "总管不走这个入口" }, 400);
			case "not_found":
				return c.json({ ok: false, error: "not_found" }, 404);
			case "inactive":
				return c.json(
					{ ok: false, error: "partner_inactive", message: "执事当前是暂停或归档状态，先恢复再打开" },
					409,
				);
			case "unavailable":
				return c.json(
					{ ok: false, error: "model_unavailable", message: "模型暂时不可用，稍后再试" },
					503,
				);
			case "failed":
				return c.json(
					{ ok: false, error: "greeting_failed", message: "问候没有生成成功，稍后再试" },
					503,
				);
		}
		return c.json({ ok: false, error: "greeting_failed" }, 503);
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

/** 解压输出上限：256×256 RGBA 16-bit 的扫描线约 525KiB；给足但不无限。 */
const PARTNER_AVATAR_MAX_INFLATED_BYTES = 1024 * 1024;

function channelsOfColorType(colorType: number): number | null {
	switch (colorType) {
		case 0:
			return 1;
		case 2:
			return 3;
		case 3:
			return 1;
		case 4:
			return 2;
		case 6:
			return 4;
		default:
			return null;
	}
}

/** 解压后每个扫描行的首字节必须是 PNG 规定的 0–4 过滤类型；否则图即使 CRC 对也渲染不了。 */
function pngFilterBytesValid(
	raw: Buffer,
	width: number,
	height: number,
	bitDepth: number,
	colorType: number,
	interlace: number,
): boolean {
	const channels = channelsOfColorType(colorType);
	if (!channels) return false;
	const bitsPerPixel = bitDepth * channels;
	const rowBytes = (w: number) => 1 + Math.ceil((w * bitsPerPixel) / 8);
	let offset = 0;
	const checkRows = (w: number, h: number): boolean => {
		const row = rowBytes(w);
		for (let y = 0; y < h; y += 1) {
			if (offset >= raw.length || raw[offset] > 4) return false;
			offset += row;
		}
		return true;
	};
	if (interlace === 0) {
		if (!checkRows(width, height)) return false;
		return offset === raw.length;
	}
	const startX = [0, 4, 0, 2, 0, 1, 0];
	const startY = [0, 0, 4, 0, 2, 0, 1];
	const stepX = [8, 8, 4, 4, 2, 2, 1];
	const stepY = [8, 8, 8, 4, 4, 2, 2];
	for (let pass = 0; pass < 7; pass += 1) {
		const passWidth = Math.ceil((width - startX[pass]) / stepX[pass]);
		const passHeight = Math.ceil((height - startY[pass]) / stepY[pass]);
		if (passWidth > 0 && passHeight > 0 && !checkRows(passWidth, passHeight)) return false;
	}
	return offset === raw.length;
}

/** 该 IHDR 应该解出多少字节（每行 1 字节 filter + 像素数据；Adam7 按 7 趟累加）。 */
function pngInflatedBytes(
	width: number,
	height: number,
	bitDepth: number,
	colorType: number,
	interlace: number,
): number {
	const channels = channelsOfColorType(colorType);
	if (!channels) return -1;
	const bitsPerPixel = bitDepth * channels;
	const rowBytes = (w: number) => 1 + Math.ceil((w * bitsPerPixel) / 8);
	if (interlace === 0) return height * rowBytes(width);
	if (interlace !== 1) return -1;
	const startX = [0, 4, 0, 2, 0, 1, 0];
	const startY = [0, 0, 4, 0, 2, 0, 1];
	const stepX = [8, 8, 4, 4, 2, 2, 1];
	const stepY = [8, 8, 8, 4, 4, 2, 2];
	let total = 0;
	for (let pass = 0; pass < 7; pass += 1) {
		const passWidth = Math.ceil((width - startX[pass]) / stepX[pass]);
		const passHeight = Math.ceil((height - startY[pass]) / stepY[pass]);
		if (passWidth > 0 && passHeight > 0) total += passHeight * rowBytes(passWidth);
	}
	return total;
}

/**
 * 服务端专用的压缩数据复核：shared 已经验完 PNG 结构 / 块边界 / CRC，
 * 但 CRC 正确不代表 IDAT 的 deflate 流真能解开（重新编码一份 CRC 正确的坏流即可骗过结构校验）。
 * 这里用 Node 内置 zlib 解压，长度必须等于 IHDR 推出来的扫描线字节数；输出上限现算，不信任声明值。
 */
function avatarPngDataProblem(value: string): string | null {
	const bytes = Buffer.from(value.slice(PARTNER_AVATAR_PREFIX.length), "base64");
	if (bytes.length < 45) return "头像不是完整的 PNG";
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idat: Buffer[] = [];
	let offset = 8;
	let first = true;
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const dataStart = offset + 8;
		const crcStart = dataStart + length;
		if (length > bytes.length || crcStart + 4 > bytes.length) return "PNG 数据不完整";
		const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
		if (first) {
			if (type !== "IHDR" || length !== 13) return "PNG 缺少 IHDR 块";
			width = bytes.readUInt32BE(dataStart);
			height = bytes.readUInt32BE(dataStart + 4);
			bitDepth = bytes[dataStart + 8];
			colorType = bytes[dataStart + 9];
			interlace = bytes[dataStart + 12];
			first = false;
		} else if (type === "IDAT") {
			idat.push(bytes.subarray(dataStart, crcStart));
		} else if (type === "IEND") {
			break;
		}
		offset = crcStart + 4;
	}
	if (idat.length === 0) return "PNG 缺少 IDAT 块";
	if (
		width < 1 ||
		height < 1 ||
		width > PARTNER_AVATAR_MAX_DIMENSION ||
		height > PARTNER_AVATAR_MAX_DIMENSION
	) {
		return "头像尺寸不合法";
	}
	const expected = pngInflatedBytes(width, height, bitDepth, colorType, interlace);
	if (expected <= 0 || expected > PARTNER_AVATAR_MAX_INFLATED_BYTES) {
		return "头像 IHDR 参数不合法";
	}
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
	} catch {
		return "头像 PNG 压缩数据无效";
	}
	if (raw.length !== expected) return "头像 PNG 压缩数据与尺寸不匹配";
	if (!pngFilterBytesValid(raw, width, height, bitDepth, colorType, interlace)) {
		return "头像 PNG 像素数据无效";
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
function projection(partner: { id: string; name: string; status: string; currentVersion: number | null; createdAt: string; updatedAt: string; domain?: string | null; avatar?: string | null; dispatchAuthority?: boolean }) {
	return {
		id: partner.id,
		name: partner.name,
		status: partner.status,
		soulVersion: partner.currentVersion,
		createdAt: partner.createdAt,
		updatedAt: partner.updatedAt,
		// 纯增量：普通执事不带这个字段（行为零变化），执事带 domain。
		...(partner.domain ? { domain: partner.domain } : {}),
		// 派发权（2026-11-06 执事派发权开关，纯增量）：只对带 domain 的执事给，默认关。
		...(partner.domain ? { dispatchAuthority: partner.dispatchAuthority } : {}),
		// 纯增量（2026-11-06 B1）：未设置给 null，前端据此回落名字首字。
		avatar: partner.avatar ?? null,
	};
}
