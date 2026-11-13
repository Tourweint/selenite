/**
 * 自主轮标记（2026-11-05 批次B/C 的接缝）。
 *
 * 进程内 Set 是**事实源**：例行任务/事件唤醒的轮次在跑的时候登记，
 * beforeTool 的 C2 风险判定读它。文本里的 `turnAuthority: autonomous` 只是
 * 给模型看的透明性说明，没有判定效力——判定必须代码生效，不靠提示词。
 *
 * 单独成文件的原因：partner-runtime（写）与 agent.ts（读）都要 import 它，
 * 而这两个互相不能依赖（装配方向 partner-runtime → agent.ts）。
 */

const autonomyTurns = new Set<number>();

/** 总开关：只有显式 `AUTONOMY_ENABLED=false / 0` 才关——2026-11-13 起默认开（与 autonomy-mode.ts 三档判定同口径），关着时自主轮标记永不生效。 */
function autonomyGate(): boolean {
	const raw = process.env.AUTONOMY_ENABLED?.trim().toLowerCase();
	return raw !== "false" && raw !== "0";
}

export function markAutonomyTurn(conversationId: number): void {
	if (!autonomyGate()) return;
	autonomyTurns.add(conversationId);
}

export function unmarkAutonomyTurn(conversationId: number): void {
	autonomyTurns.delete(conversationId);
}

export function isAutonomyTurn(conversationId: number): boolean {
	return autonomyTurns.has(conversationId);
}
