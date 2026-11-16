import { defineTask } from "@earendil-works/pi-durable";
import { flagEnabled } from "./flags.ts";
import { invokeScheduledRun } from "./scheduled-run-deliverer.ts";

/**
 * 定时提醒。
 *
 * 关键不是"定时器"，而是**睡眠状态要落库**：进程重启、手机断线、机器关机，
 * 醒来之后仍然到点触发。这正是 durable 的 `sleepUntil()` 提供的东西 ——
 * 自己用 setTimeout 做不到（进程一挂就没了），cron 也只能做到"每分钟扫一次库"。
 *
 * 触发时写一条 entry 进会话：客户端下次拉会话就能看到，不需要 push 通道。
 */

/** 频率（2026-11-14）：none = 一次性；daily = 每天；weekly = 每周几；monthly = 每月几号。 */
export type ReminderRepeat = "none" | "daily" | "weekly" | "monthly";

export interface ReminderInput {
	/** 提醒内容 */
	text: string;
	/** 首次触发时间，epoch 毫秒 */
	at: number;
	/** 频率；缺省按一次性处理 */
	repeat?: ReminderRepeat;
	/** 每周重复的日子：0 = 周日，6 = 周六（可多选） */
	weekdays?: number[];
	/** 每月重复的日子：1–31；没有这一天的月份按月末算 */
	dayOfMonth?: number;
	/** 区间结束（含当天最后一毫秒）；到点续排时超过它就停。仅 daily 区间用 */
	until?: number;
	/**
	 * 稳定提醒 id（2026-11-12）：续排沿用同一个值；列表按它归组，
	 * 不会因为每天换任务而堆出一串"已结束"。
	 */
	reminderId?: string;
	/** 目标执事（2026-11-12）：任务建在该执事会话；仅作展示与追溯。 */
	partnerId?: string | null;
}

/** 提醒写进会话时用的 entry 类型，客户端按它渲染 */
export const REMINDER_ENTRY_KIND = "lifediary.reminder";

/**
 * 到点的「开口」钩子（2026-11-13）。
 *
 * 用户口径：这不是提醒，是**定时任务**——到点执事主动来找你、跟你说一句话，你点开就聊。
 * 实际写消息的 `sayInConversation` 在 agent 层；这里用注册回调，避免
 * `reminder.ts ↔ lifecycle.ts` 的循环 import（lifecycle 静态 import 本文件）。
 */
export type ReminderDeliverer = (conversationId: number, text: string) => Promise<void>;
let deliverer: ReminderDeliverer | null = null;

export function setReminderDeliverer(fn: ReminderDeliverer | null): void {
	deliverer = fn;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function atTimeOf(day: Date, reference: number): number {
	const time = new Date(reference);
	return new Date(
		day.getFullYear(),
		day.getMonth(),
		day.getDate(),
		time.getHours(),
		time.getMinutes(),
		time.getSeconds(),
		time.getMilliseconds(),
	).getTime();
}

function dayOfMonthFor(day: Date, dayOfMonth: number): number {
	const last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
	return Math.min(dayOfMonth, last);
}

/** 每天的下一次：先看今天（或 at 当天），不晚于 now 就往后推一天。 */
function nextDailyOccurrence(input: ReminderInput, now: number): number | null {
	let next =
		input.at > now
			? input.at
			: atTimeOf(new Date(now), input.at);
	while (next <= now) next = atTimeOf(new Date(next + DAY_MS), input.at);
	return next;
}

/** 每周的下一次：在 now 之后的 7 天里找第一个选中的星期几。 */
function nextWeeklyAt(input: ReminderInput, now: number): number | null {
	const weekdays = (input.weekdays ?? [])
		.map((value) => Math.trunc(value))
		.filter((value) => value >= 0 && value <= 6);
	if (weekdays.length === 0) return null;
	for (let offset = 0; offset <= 7; offset += 1) {
		const day = new Date(now);
		day.setDate(day.getDate() + offset);
		if (!weekdays.includes(day.getDay())) continue;
		const candidate = atTimeOf(day, input.at);
		if (candidate > now) return candidate;
	}
	return null;
}

/** 每月的下一次：按锚定的几号算（31 号遇到小月落到月末），过了就翻到下个月。 */
function nextMonthlyAt(input: ReminderInput, now: number): number | null {
	const anchor = Math.trunc(input.dayOfMonth ?? new Date(input.at).getDate());
	if (anchor < 1 || anchor > 31) return null;
	for (let offset = 0; offset <= 13; offset += 1) {
		const month = new Date(now);
		month.setDate(1);
		month.setMonth(month.getMonth() + offset);
		const day = dayOfMonthFor(month, anchor);
		const candidate = atTimeOf(
			new Date(month.getFullYear(), month.getMonth(), day),
			input.at,
		);
		if (candidate > now) return candidate;
	}
	return null;
}

/**
 * 计算下一次触发；一次性或已经超出区间（`until`）返回 null。
 *
 * 为什么按「now 之后」而不是「at + 一个周期」：进程可能睡过头几天，
 * 跳过已经错过的那些次，不能补发一串。
 */
export function nextReminderAt(input: ReminderInput, now = Date.now()): number | null {
	const repeat = input.repeat ?? "none";
	if (repeat === "none") return null;
	let next: number | null = null;
	if (repeat === "daily") next = nextDailyOccurrence(input, now);
	else if (repeat === "weekly") next = nextWeeklyAt(input, now);
	else if (repeat === "monthly") next = nextMonthlyAt(input, now);
	if (next === null) return null;
	if (input.until !== undefined && next > input.until) return null;
	return next;
}

/** 兼容旧导出：每天的下一次触发（2026-11-12 起的调用点）。 */
export function nextDailyAt(at: number, now: number): number {
	let next = at + DAY_MS;
	while (next <= now) next += DAY_MS;
	return next;
}

export const ReminderTask = defineTask<
	ReminderInput,
	{ phase: "wait" } | { phase: "deliver" },
	string
>({
	name: "lifediary.reminder",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		// 睡到点为止。返回时睡眠状态已经提交，进程这期间可以死。
		wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
		deliver: async (task, runtime, context) => {
			// 2026-11-17 定时主动轮：默认到点让目标执事跑一轮模型（触发消息对用户隐藏）。
			// SCHEDULED_TASK_MODEL_RUN=false 逐字节回到旧闹钟：写提醒 entry + 写死消息。
			const runModel = flagEnabled("SCHEDULED_TASK_MODEL_RUN");
			await runtime.commit(
				async (tx) => {
					// 旧形态才写提醒 entry（回滚分支）；新形态的"开口"由模型回复承担。
					if (!runModel) {
						await tx.appendEntry(runtime.conversationId, {
							kind: REMINDER_ENTRY_KIND,
							data: { text: task.input.text, at: task.input.at },
						});
					}
					// 周期提醒：同事务里排下一次（先排再终态，崩在中间最多漏一次，不会断链）。
					const next = nextReminderAt(task.input, Date.now());
					if (next !== null) {
						await tx.createTask(
							ReminderTask,
							{ ...task.input, at: next },
							{ ownership: { kind: "conversation" } },
						);
					}
					return {
						status: "terminal",
						outcome: { status: "completed", result: task.input.text },
					};
				},
				context,
			);
			if (runModel) {
				// 新形态：跑一轮模型（实现由 index.ts 注入，解环）。失败只 warn，不影响续排链。
				try {
					await invokeScheduledRun({
						conversationId: runtime.conversationId,
						partnerId: task.input.partnerId,
						text: task.input.text,
					});
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					console.warn(`[reminder] 会话 ${runtime.conversationId} 到点跑模型失败: ${detail}`);
				}
			} else if (deliverer) {
				// 回滚形态（2026-11-13）：在会话里写一条 assistant 消息，客户端一打开就看到
				// “执事来找你了”；失败不影响已落的提醒记录与手机本地通知。
				try {
					await deliverer(runtime.conversationId, task.input.text);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					console.warn(`[reminder] 会话 ${runtime.conversationId} 到点开口失败: ${detail}`);
				}
			}
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
