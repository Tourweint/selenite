/**
 * 定时主动轮的到点投递槽（2026-11-17）。
 *
 * 为什么单独一个模块：`reminder.ts` 需要到点"跑一轮模型"，而 `runPartnerTurn`
 * 在 agent → lifecycle-harness → reminder 的依赖链下游。reminder 直接 import 它会成环。
 * 沿用提醒 deliverer 的回调注册思路——这里只放回调槽与类型，不 import 任何业务模块，
 * 由 index.ts 在装配时把实现注入，从而解环。
 */

/** 到点那一轮的入参。partnerId 可空：解析逻辑在注入的实现里（含 chief 兜底）。 */
export interface ScheduledRunInput {
	/** 建任务的会话内部 id（用于回滚形态写回原会话、以及反查目标执事） */
	conversationId: number;
	/** 任务显式指定的目标执事（可能为空，由实现层反查/兜底） */
	partnerId: string | null | undefined;
	/** 到点要说的话（原提醒正文） */
	text: string;
	/**
	 * 触发指令是否对用户可见（2026-11-17 定时任务重做）。
	 * false/缺省 = 加 `[lifediary.proactive]` 隐藏标记（旧行为）；true = 原样保留。
	 */
	visible?: boolean;
}

/** 一轮跑完的结果；`invokeScheduledRun` 把它原样交给调用方记账/回 HTTP。 */
export interface ScheduledRunResult {
	ok: boolean;
	text?: string;
	error?: string;
}

export type ScheduledRunHandler = (input: ScheduledRunInput) => Promise<ScheduledRunResult | void>;

let handler: ScheduledRunHandler | null = null;

/** 装配时注入实现；重复注入以最后一次为准（与 setReminderDeliverer 同款）。 */
export function setScheduledRunHandler(fn: ScheduledRunHandler | null): void {
	handler = fn;
}

/** reminder.deliver 到点调用；未注入（测试/未装配）时静默返回，不抛。 */
export async function invokeScheduledRun(
	input: ScheduledRunInput,
): Promise<ScheduledRunResult | void> {
	if (!handler) return;
	return handler(input);
}
