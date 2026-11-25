/**
 * goal-mode.ts — 目标模式运行时（2026-11-25，默认关，`GOAL_MODE=false` 回到"目标只是一行文本"）。
 *
 * 纯判定全在 goal-settlement.ts；这里只有 I/O：状态行读写、轮末结算的接线、续跑任务、用户动作。
 *
 * **没有裁判轮**（D13 不变）：完成由执行方自报（末行 `[[goal-done]]`），
 * 宿主只管确定性硬闸——轮数上限、token 预算、零工具连击。
 *
 * 续跑是 durable 任务（`lifediary.goal-continue`，范式 = routines.ts 的 RoutineTask）：
 *   - 挂在执事主会话的任务图上；醒来先对 token（`partner_goals.updated_at`）与状态，对不上即作废；
 *   - 模型执行不在任务事务里，照 `runPartnerTurn` 走，身份 autonomous（过 C2 审批）；
 *   - 重启不自动重放：任务带着排它时的进程启动号，跨进程醒来一律作废（与例行任务
 *     `routines.ts` 的「running → interrupted」同一个口径，例 `接口-端点4` 的"重启不重放"）；
 *   - 最坏情况是重启后目标停在 active 但没人推，主人点一次「继续」即可。
 *
 * 结算的入口有两个（都经 settleGoalTurn）：
 *   ① `runPartnerTurn` 的轮末（经 partner-runtime 的 sink 注入，避免两文件循环导入）；
 *   ② 首页主对话的轮末（index.ts 的 /chat 流，只对总管会话）。
 *
 * 日志只记枚举与数字（outcome / 轮数 / 连击），不记目标正文与回复。
 */

import { defineTask } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ResolvedChat } from "./agent.ts";
import { chatKindOf } from "./agent/session-open.ts";
import { conversationIsBusy } from "./agent/session.ts";
import { approvalStore } from "./approvals.ts";
import { flagEnabled, flagValue } from "./flags.ts";
import {
	buildGoalContinuationPrompt,
	clampGoalMaxRounds,
	decideGoalSettlement,
	isSameBoot,
	newGoalState,
	planGoalAction,
	type GoalState,
	type GoalUsage,
} from "./goal-settlement.ts";
import { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import {
	ensurePartnerSession,
	runPartnerTurn,
	setGoalTurnSink,
	type GoalTurnSignal,
} from "./partner-runtime.ts";

const CTX = BACKGROUND_CONTEXT;

/** 轮末结算到续跑之间的间隔：给"主人紧接着再发一句"留一点余地。 */
export const GOAL_CONTINUE_DELAY_MS = 3_000;
const GOAL_MAX_ROUNDS_DEFAULT = 10;

/** 本进程的启动号。续跑任务带着它；重启前排的任务醒来时对不上，即作废（不自动重放）。 */
const BOOT_ID = `${Date.now()}:${process.pid}`;

/** 目标模式总开关：执事能力关着时一律关（没有执事会话就谈不上目标续跑）。 */
export function goalModeEnabled(): boolean {
	if (!COMPANIONS_ENABLED) return false;
	return flagEnabled("GOAL_MODE");
}

/** `GOAL_MAX_ROUNDS`（缺省 10）：只在**新建**状态行时取用，已建的不受影响。 */
export function goalMaxRounds(): number {
	const raw = Number(flagValue("GOAL_MAX_ROUNDS"));
	return clampGoalMaxRounds(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : GOAL_MAX_ROUNDS_DEFAULT);
}

// ── durable 任务 ─────────────────────────────────────────

interface GoalContinueInput {
	partnerId: string;
	fireAt: number;
	/** 建任务时的 `partner_goals.updated_at`；醒来对不上 = 状态已被改过，作废 */
	token: string;
	/** 建任务时的进程启动号；醒来对不上 = 中间重启过，作废（不自动重放） */
	boot: string;
}

/** 与 RoutineTask 同款：到点醒来 → 对号 → 终态；模型执行在任务图之外（fire-and-forget）。 */
export const GoalContinueTask = defineTask<
	GoalContinueInput,
	{ phase: "wait" } | { phase: "deliver" },
	string
>({
	name: "lifediary.goal-continue",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, context) =>
			runtime.sleepUntil(task.input.fireAt, { phase: "deliver" }, context),
		deliver: async (task, runtime, context) => {
			const live = continuationLive(task.input);
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result: live ? "fired" : "stale" },
				}),
				context,
			);
			// 续跑轮跑在任务图外，这个 promise 没人接：必须自己兜底，否则一次 reject 就是
			// 未处理的 Promise rejection（Node 缺省会连累整个进程）。日志只带错误消息，不带正文。
			if (live) {
				void runGoalContinuation(task.input).catch((error: unknown) => {
					console.warn(
						`[goal] 续跑轮异常（已吞，不影响进程；partner=${task.input.partnerId.slice(0, 8)}）：${
							error instanceof Error ? error.message.slice(0, 120) : "unknown"
						}`,
					);
				});
			}
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function continuationLive(input: GoalContinueInput): boolean {
	if (!goalModeEnabled()) return false;
	if (!isSameBoot(input.boot, BOOT_ID)) return false;
	const goal = partnersStore().goals.get(input.partnerId);
	return goal !== null && goal.status === "active" && goal.updatedAt === input.token;
}

/** 同一个 token 只排一次（连点两次「继续」不重复排）。 */
const scheduled = new Map<string, string>();

/** 给目标排一轮续跑。返回 false = 没排上（会话取不到 / 提交失败），状态不变。保证不 reject。 */
export async function scheduleGoalContinuation(
	partnerId: string,
	token: string,
	delayMs: number = GOAL_CONTINUE_DELAY_MS,
): Promise<boolean> {
	if (!goalModeEnabled() || scheduled.get(partnerId) === token) return false;
	// 取会话这一步自己不兜底（开会话 / configure 都可能抛），这里接住：动作端点那条路是 void 调用，
	// 没人接这个 promise（2026-11-25 返工，与续跑轮同类缺口）。失败 = 没排上，状态不变。
	let chat: ResolvedChat | null;
	try {
		chat = await ensurePartnerSession(partnerId);
	} catch (error) {
		console.warn(
			`[goal] 执事会话打不开，续跑没排上（partner=${partnerId.slice(0, 8)}）：${
				error instanceof Error ? error.message.slice(0, 120) : "unknown"
			}`,
		);
		return false;
	}
	if (!chat) {
		console.warn(`[goal] 执事会话取不到，续跑没排上（partner=${partnerId.slice(0, 8)}）`);
		return false;
	}
	scheduled.set(partnerId, token);
	try {
		await chat.conversation.commit(
			(tx) =>
				tx.createTask(
					GoalContinueTask,
					{ partnerId, fireAt: Date.now() + delayMs, token, boot: BOOT_ID },
					{ ownership: { kind: "conversation" } },
				),
			CTX,
		);
	} catch (error) {
		if (scheduled.get(partnerId) === token) scheduled.delete(partnerId);
		console.warn(
			`[goal] 续跑任务提交失败（partner=${partnerId.slice(0, 8)}）：${
				error instanceof Error ? error.message.slice(0, 120) : "unknown"
			}`,
		);
		return false;
	}
	return true;
}

/** 任务醒来：对号 → 没有挂着的审批 → 会话不忙 → 跑一轮。任何一道不过都是"状态不变、不跑"。 */
async function runGoalContinuation(input: GoalContinueInput): Promise<void> {
	if (scheduled.get(input.partnerId) === input.token) scheduled.delete(input.partnerId);
	if (!continuationLive(input)) return;
	const chat = await ensurePartnerSession(input.partnerId);
	if (!chat) return;
	if (approvalStore().pendingOf(chat.internalId).length > 0) {
		console.warn(`[goal] 有待批审批，本轮不续跑（partner=${input.partnerId.slice(0, 8)}）`);
		return;
	}
	if (await conversationIsBusy(chat.conversation)) {
		console.warn(`[goal] 会话忙，本轮不续跑（partner=${input.partnerId.slice(0, 8)}）`);
		return;
	}
	const store = partnersStore();
	const partner = store.get(input.partnerId);
	const goal = store.goals.get(input.partnerId);
	if (!partner?.currentGoal || !goal) return;
	await runPartnerTurn(input.partnerId, buildGoalContinuationPrompt(partner.currentGoal, goal), {
		authority: "autonomous",
		quiet: false,
		goalContinuation: true,
	});
}

// ── 轮末结算 ─────────────────────────────────────────────

/**
 * 轮末结算（runPartnerTurn 的 sink 就是它）。只在执事**主会话**上结算：
 * 例行专线 / 副会话 / 群会话的轮次不计账、不触发续跑。
 * 任何异常都吞掉——结算失败不能影响已经跑完的那一轮。
 *
 * 返回值只回答一件事：**目标模式是不是开着**。true（2026-11-25 返工：结算抛异常时也返回 true）=
 * 调用方据此把工具数 / 用量带进返回值、剔掉末行标记；false = 开关关着。
 * 它**不表示结算成功**——失败只留一条 warn，这一轮不记账、不排续跑。
 * 之所以失败也要返回 true：门已经过了，回复里可能带着 `[[goal-done]]` / `[[goal-blocked:…]]`，
 * 当成"没开"就会把标记原样显示给主人。至于这一轮归不归目标管，在函数内部各自返回。
 * 这个函数保证不抛（开关判定也在 try 里）。
 */
export async function settleGoalTurn(
	signal: GoalTurnSignal,
	opts: { mainChat?: boolean } = {},
): Promise<boolean> {
	try {
		if (!goalModeEnabled()) return false;
		const store = partnersStore();
		const current = store.goals.get(signal.partnerId);
		if (!current || current.status !== "active") return true;
		if (!opts.mainChat && store.canonicalPartnerIdOfSession(signal.conversationId) !== signal.partnerId) {
			return true;
		}
		const decision = decideGoalSettlement({
			state: current,
			replyText: signal.replyText,
			toolCalls: signal.toolCalls,
			isContinuation: signal.isContinuation,
			...(signal.usage ? { usage: signal.usage } : {}),
		});
		if (decision.outcome === "none") return true;
		const saved = store.goals.upsert(signal.partnerId, decision.state);
		console.warn(
			`[goal] 结算 partner=${signal.partnerId.slice(0, 8)} outcome=${decision.outcome} rounds=${saved.roundsUsed}/${saved.maxRounds} streak=${saved.noProgressStreak}`,
		);
		if (decision.usageMissing) {
			console.warn(`[goal] 本轮读不到 usage，未计入预算（partner=${signal.partnerId.slice(0, 8)}）`);
		}
		if (decision.outcome !== "continue") return true;
		await scheduleGoalContinuation(signal.partnerId, saved.updatedAt);
		return true;
	} catch (error) {
		console.warn(
			`[goal] 结算失败（本轮不记账、不排续跑；partner=${signal.partnerId.slice(0, 8)}）：${
				error instanceof Error ? error.message.slice(0, 120) : "unknown"
			}`,
		);
		// 开关是开的才走到这里：仍按"开着"回，让调用方把末行标记剔掉。失败只体现在这条日志上。
		return true;
	}
}

/** 这条会话归谁的目标管：首页主对话 = 总管；执事主会话 = 那位执事；其余 = 不管。 */
async function goalOwnerOfChat(chat: ResolvedChat): Promise<string | null> {
	const kind = await chatKindOf(chat);
	if (kind === "chief") return CHIEF_PARTNER_ID;
	if (kind === "partner") return partnersStore().canonicalPartnerIdOfSession(chat.internalId);
	return null;
}

/** 首页主对话 / 执事主会话在 /chat 流里的轮末（index.ts 调）。这一轮永远是主人亲手发起的。 */
export async function settleGoalForChat(
	chat: ResolvedChat,
	signal: { replyText: string; toolCalls: number; usage?: GoalUsage },
): Promise<void> {
	if (!goalModeEnabled()) return;
	try {
		const partnerId = await goalOwnerOfChat(chat);
		if (!partnerId) return;
		await settleGoalTurn(
			{
				partnerId,
				conversationId: chat.internalId,
				replyText: signal.replyText,
				toolCalls: signal.toolCalls,
				isContinuation: false,
				...(signal.usage ? { usage: signal.usage } : {}),
			},
			{ mainChat: true },
		);
	} catch (error) {
		console.warn(`[goal] 主对话结算失败（不影响本轮）：${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
	}
}

/** 主人 Stop（/stop 端点）：目标在推进就暂停，reason=stopped。停了不再自动续。 */
export async function pauseGoalOnStop(chat: ResolvedChat): Promise<void> {
	if (!goalModeEnabled()) return;
	try {
		const partnerId = await goalOwnerOfChat(chat);
		if (partnerId) pauseActiveGoal(partnerId, "stopped");
	} catch (error) {
		console.warn(`[goal] Stop 暂停失败（不影响停止）：${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
	}
}

function pauseActiveGoal(partnerId: string, reason: "stopped"): void {
	const store = partnersStore();
	const goal = store.goals.get(partnerId);
	if (!goal || goal.status !== "active") return;
	store.goals.upsert(partnerId, { ...goal, status: "paused", reason });
	console.warn(`[goal] partner=${partnerId.slice(0, 8)} → paused(${reason})`);
}

// ── 用户动作 / 文本变更 ───────────────────────────────────

/** 对外投影（详情 / PATCH / 动作端点同一个形状）：不带 partnerId 与 updatedAt。 */
export interface GoalView {
	status: GoalState["status"];
	reason: GoalState["reason"];
	roundsUsed: number;
	maxRounds: number;
	tokensUsed: number;
	tokenBudget: number | null;
}

export function goalView(goal: GoalState | null): GoalView | null {
	if (!goal) return null;
	return {
		status: goal.status,
		reason: goal.reason,
		roundsUsed: goal.roundsUsed,
		maxRounds: goal.maxRounds,
		tokensUsed: goal.tokensUsed,
		tokenBudget: goal.tokenBudget,
	};
}

export type GoalActionResult =
	| { ok: true; goal: GoalState | null }
	| { ok: false; message: string };

/** 动作端点的全部业务（companion-api 只做形状映射）。执事不存在由端点先判 404。 */
export function applyGoalAction(
	partnerId: string,
	input: { action: unknown; maxRounds?: unknown; tokenBudget?: unknown },
): GoalActionResult {
	const store = partnersStore();
	const partner = store.get(partnerId);
	if (!partner) return { ok: false, message: "执事不存在" };
	const plan = planGoalAction({
		action: input.action,
		state: store.goals.get(partnerId),
		hasGoalText: Boolean(partner.currentGoal?.trim()),
		...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
		...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
		defaultMaxRounds: goalMaxRounds(),
	});
	if (!plan.ok) return { ok: false, message: plan.message };
	if (plan.state === null) {
		// 清除目标：状态行与正文同一事务删掉（setCurrentGoal 内）
		store.setCurrentGoal(partnerId, null);
		return { ok: true, goal: null };
	}
	const saved = store.goals.upsert(partnerId, plan.state);
	if (plan.reschedule) void scheduleGoalContinuation(partnerId, saved.updatedAt, 0);
	return { ok: true, goal: saved };
}

/**
 * `PATCH currentGoal` 写完正文之后调：
 *   - 清除 → 返回 null（状态行已由 setCurrentGoal 同事务删掉）；
 *   - 新设正文、没有状态行 → 建一行 paused / not_started（不自动开跑）；
 *   - 已有状态行（改了正文）→ 零工具连击清零，状态不变。
 */
export function onGoalTextChanged(partnerId: string, goalText: string | null): GoalState | null {
	if (!goalModeEnabled()) return null;
	const store = partnersStore();
	if (!goalText) return null;
	const existing = store.goals.get(partnerId);
	if (!existing) return store.goals.upsert(partnerId, newGoalState(goalMaxRounds()));
	return store.goals.upsert(partnerId, { ...existing, noProgressStreak: 0 });
}

/** 装配时调一次（index.ts）：把结算接进 runPartnerTurn 的轮末。 */
export function installGoalMode(): void {
	setGoalTurnSink(settleGoalTurn);
}
