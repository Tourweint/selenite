import {
	partnersStore,
	type PartnersStore,
	type RoutineTrigger,
} from "./partners.ts";

/**
 * 执事自建巡逻的核心实现（2026-11-08 员工人格化刀二 E4）。
 *
 * 与 `partner-manage.ts` 同款分工：这里是**唯一的核心逻辑**（校验 / 归属 / 上限 / 落库），
 * `tools.ts` 的 `routine_manage` 工具只做参数形状与模型友好文案的包装。
 * 存储通过 `RoutineManageContext` 注入（生产 = 全局 partnersStore，单测 = 临时库），
 * 排定时链（durable 闹钟）由装配层在工具侧注入 `scheduleRoutine`，本模块不 import
 * `routines.ts`——那条链会绕回 agent，内核文件之间保持单向（与 settled.ts 的观察层同款）。
 *
 * 三条硬边界：
 *   - **只能动自己的**：partnerId 由调用者会话认出后绑定，动别人的规则一律
 *     `not_found`（不泄存在性——找不到与不是自己的，返回同一句话）；
 *   - **活动规则 ≤10 条 / 执事**：create 与 enable 都先数，超了 400 带说明；
 *   - **revision / durable 闹钟 / 防自环原样生效**：create / enable 后由装配层
 *     `ensureScheduled` 排链；disable 走 `updateRoutine` 的 revision+1 让在飞闹钟作废；
 *     delete 直接删定义，在飞闹钟醒来查不到规则自然作废（routines.ts 既有机制）。
 */

/** 每执事活动（enabled）规则上限。 */
export const ROUTINE_SELF_SERVICE_LIMIT = 10;

const NAME_LIMIT = 40;
const PROMPT_LIMIT = 100_000;

/**
 * triggers 形状校验。**从 companion-api.ts 上移到这里的唯一一份**：
 * HTTP `POST /api/v1/routines` 的 `validateRoutineInput`、PATCH 路由、
 * 与 `routine_manage` 工具共用，避免"端点一套、工具一套"漂移。
 */
export function validateTriggers(triggers: unknown): string | null {
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

export type RoutineManageAction = "create" | "disable" | "enable" | "delete";

export interface RoutineManageInput {
	action: RoutineManageAction;
	/** disable / enable / delete 必填：自己的规则 id */
	id?: string;
	/** create 必填 */
	name?: string;
	prompt?: string;
	triggers?: RoutineTrigger[];
	sessionMode?: "persistent" | "fresh";
}

export interface RoutineManageContext {
	store: PartnersStore;
	/** 调用者会话认出的执事 id（已绑定，绝不接受模型传进来的 partnerId） */
	partnerId: string;
}

export type RoutineManageCode = "ok" | "bad_request" | "not_found" | "limit";

export interface RoutineManageResult {
	ok: boolean;
	code: RoutineManageCode;
	/** 面向模型的中文文案；不含任何"别人的规则存在"的提示 */
	message: string;
	routineId?: string;
	/** true = 装配层要排 durable 闹钟（create / enable） */
	schedule?: boolean;
}

/** 活动规则计数（可排除某条，用于 enable 时"自己不算新占名额"）。 */
function activeCount(store: PartnersStore, partnerId: string, exceptId?: string): number {
	return store
		.listRoutines(partnerId)
		.filter((routine) => routine.enabled && routine.id !== exceptId).length;
}

/**
 * 执行一次自建巡逻动作。纯同步（只碰 store），排链由调用方按 `schedule` 处理。
 * 归属判定：**找不到 / 不是自己的 → 同一句 not_found**，不泄存在性。
 */
export function performRoutineAction(
	input: RoutineManageInput,
	ctx: RoutineManageContext,
): RoutineManageResult {
	const { store, partnerId } = ctx;
	const action = input.action;

	if (action === "create") {
		const name = (input.name ?? "").trim();
		if (!name || name.length > NAME_LIMIT) {
			return { ok: false, code: "bad_request", message: `name 必填且不超过 ${NAME_LIMIT} 字` };
		}
		const prompt = input.prompt ?? "";
		if (!prompt.trim()) {
			return { ok: false, code: "bad_request", message: "prompt 必填" };
		}
		if (prompt.length > PROMPT_LIMIT) {
			return { ok: false, code: "bad_request", message: `prompt 超过 ${PROMPT_LIMIT} 字上限` };
		}
		const triggerError = validateTriggers(input.triggers);
		if (triggerError) {
			return { ok: false, code: "bad_request", message: triggerError };
		}
		if (activeCount(store, partnerId) >= ROUTINE_SELF_SERVICE_LIMIT) {
			return {
				ok: false,
				code: "limit",
				message: `每个执事最多 ${ROUTINE_SELF_SERVICE_LIMIT} 条活动例行规则，先停用或删掉一条再建`,
			};
		}
		const routine = store.createRoutine({
			partnerId,
			name,
			prompt,
			triggers: input.triggers as RoutineTrigger[],
			sessionMode: input.sessionMode === "fresh" ? "fresh" : "persistent",
			enabled: true,
		});
		return {
			ok: true,
			code: "ok",
			message: `已建好例行规则「${routine.name}」（${routine.id}），按触发器周期执行。`,
			routineId: routine.id,
			schedule: true,
		};
	}

	const id = (input.id ?? "").trim();
	if (!id) {
		return { ok: false, code: "bad_request", message: `${action} 需要 id（自己的规则 id）` };
	}
	const routine = store.getRoutine(id);
	if (!routine || routine.partnerId !== partnerId) {
		// 不泄存在性：找不到与"是别人的"返回同一句话。
		return { ok: false, code: "not_found", message: "找不到这条例行规则（只能管理自己的）" };
	}

	if (action === "disable") {
		store.updateRoutine(id, { enabled: false });
		return {
			ok: true,
			code: "ok",
			message: `已停用「${routine.name}」；在飞的定时任务醒来会自动作废。`,
			routineId: id,
		};
	}

	if (action === "enable") {
		// 已经是启用态就不再占新名额，但仍走一次 revision+1 让旧闹钟作废并重排。
		if (!routine.enabled && activeCount(store, partnerId, id) >= ROUTINE_SELF_SERVICE_LIMIT) {
			return {
				ok: false,
				code: "limit",
				message: `每个执事最多 ${ROUTINE_SELF_SERVICE_LIMIT} 条活动例行规则，先停用或删掉一条再启用`,
			};
		}
		store.updateRoutine(id, { enabled: true });
		return {
			ok: true,
			code: "ok",
			message: `已启用「${routine.name}」，按触发器周期执行。`,
			routineId: id,
			schedule: true,
		};
	}

	if (action === "delete") {
		store.deleteRoutine(id);
		return {
			ok: true,
			code: "ok",
			message: `已删除「${routine.name}」；在飞的定时任务醒来会自动作废。`,
			routineId: id,
		};
	}

	return { ok: false, code: "bad_request", message: "action 只能是 create / disable / enable / delete" };
}

/** 生产用的默认 context：partnerId 由工具按调用者会话认出后填。 */
export function defaultRoutineManageContext(partnerId: string): RoutineManageContext {
	return { store: partnersStore(), partnerId };
}
