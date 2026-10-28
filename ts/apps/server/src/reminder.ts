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
}

/** 提醒写进会话时用的 entry 类型，客户端按它渲染 */
export const REMINDER_ENTRY_KIND = "lifediary.reminder";

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
					return {
						status: "terminal",
						outcome: { status: "completed", result: task.input.text },
					};
				},
				context,
			);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
