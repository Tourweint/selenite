/**
 * run 身份键（2026-11-10 状态机清点收口；此前同一表达式在三个文件各写一份，靠注释互指"同一口径"）。
 *
 * 一次模型请求 = 一个工具回合，三个模块要认"现在是哪一轮"：回合上限计数（agent/lifecycle）、
 * 递话防乒乓（partner-relay）、播报配额（progress-report）。口径 = `run.inputs[0] ?? run.taskId`：
 * run.taskId 每一轮都变（每轮是一个新的 generation 任务），拿它计数永远归零、上限形同虚设——
 * 这个坑是实测踩出来的；inputs[0] 才是提交时定下的 run 身份。"none" 兜底给快照还没落 run 的时刻。
 *
 * 参数用结构类型，不引 durable 的 LiveDoc——三个使用方原本也都是这么写的。
 */
export function runIdentityKey(
	conversationId: number,
	live: { run?: { inputs?: readonly unknown[]; taskId?: unknown } } | null | undefined,
): string {
	return `${conversationId}:${String(live?.run?.inputs?.[0] ?? live?.run?.taskId ?? "none")}`;
}
