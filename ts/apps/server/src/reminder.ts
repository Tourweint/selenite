import { defineTask } from "@earendil-works/pi-durable";

/**
 * 定时提醒。
 *
 * 关键不是"定时器"，而是**睡眠状态要落库**：进程重启、手机断线、机器关机，
 * 醒来之后仍然到点触发。这正是 durable 的 `sleepUntil()` 提供的东西 ——
 * 自己用 setTimeout 做不到（进程一挂就没了），cron 也只能做到"每分钟扫一次库"。
 *
 * 触发时写一条 entry 进会话：客户端下次拉会话就能看到，不需要 push 通道。
 */

export interface ReminderInput {
	/** 提醒内容 */
	text: string;
	/** 触发时间，epoch 毫秒 */
	at: number;
	/**
	 * 频率（2026-11-12）：`none` = 一次性（缺省）；`daily` = 每天同一时刻，到点交付后自动排下一天。
	 */
	repeat?: "none" | "daily";
	/**
	 * 稳定提醒 id（2026-11-12）：每日续排沿用同一个值；列表按它归组，
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

/** 下一次每日触发：从上次的 at 往前推到最近的未来 24h 边界（不因进程晚醒而漏天）。 */
export function nextDailyAt(at: number, now: number): number {
	let next = at + 24 * 60 * 60 * 1000;
	while (next <= now) next += 24 * 60 * 60 * 1000;
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
			await runtime.commit(
				async (tx) => {
					await tx.appendEntry(runtime.conversationId, {
						kind: REMINDER_ENTRY_KIND,
						data: { text: task.input.text, at: task.input.at },
					});
					// 每日提醒：同事务里排下一天（先排再终态，崩在中间最多漏一次，不会断链）
					if (task.input.repeat === "daily") {
						await tx.createTask(
							ReminderTask,
							{
								...task.input,
								at: nextDailyAt(task.input.at, Date.now()),
							},
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
			// 到点开口（2026-11-13）：在会话里写一条 assistant 消息，客户端一打开就看到
			// “执事来找你了”；失败不影响已落的提醒记录与手机本地通知。
			if (deliverer) {
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
