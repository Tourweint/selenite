/**
 * 恢复注记：先查再动（2026-11-09 任务书 T3 §5）。
 *
 * 场景：一轮活被打断（进程重启 / 审批答复续跑 / 派单续跑），模型接着往下干时
 * 最容易做的事就是**把已经做完的再补一遍**。这里在续跑的下一轮模型请求前，
 * 注入一段固定文案，把它扳回"先看现场，再决定下一步"。
 *
 * 记账口径（刻意不新建存储）：
 * - 与 `resumeCount` 同族——**进程内**计数，重启清零；不落库、不加表。
 * - 键是会话，值是"还有几条恢复注记没注入"。
 * - `takeRecoverNote()` 取一次就核销；同一张单重复标记也不会重复注入，
 *   因为注入点只在"标记之后的下一次模型请求"。
 *
 * 开关 `AGENT_RECOVER_NOTE`（缺省开）：关掉 = 完全不注入，行为回到改动前。
 */

/** 固定文案（≤300 字，不含任何任务内容）。 */
export const RECOVER_NOTE =
	"你刚从一次中断里恢复。**先查再动**：先看目录里已有什么、`git log` / `git status` 有什么、" +
	"任务单上已经完成了哪几件，再决定下一步。已经成功做过的事**不要再做一遍**。" +
	"恢复注记每张单最多用一次。";

/** 缺省开；只有明确 false / 0 / off 才关（与其它"默认开"能力同口径）。 */
export function recoverNoteEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env.AGENT_RECOVER_NOTE?.trim().toLowerCase();
	return !(raw === "false" || raw === "0" || raw === "off");
}

/** 会话 → 待注入条数（= 同族 resumeCount 的进程内记账）。 */
const pending = new Map<number, number>();

/**
 * 标记"这个会话刚刚恢复过一次"。由续跑入口调用：
 * `delegate resume:true`（afterTool 里认）与启动时的自动续跑（index.ts 恢复段）。
 */
export function markRecoverResume(conversationId: number): void {
	pending.set(conversationId, (pending.get(conversationId) ?? 0) + 1);
}

/** 取一次注记（取走即核销）。开关关着时顺手清账，避免开回来时补发旧注记。 */
export function takeRecoverNote(
	conversationId: number,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (!recoverNoteEnabled(env)) {
		pending.delete(conversationId);
		return undefined;
	}
	const left = pending.get(conversationId) ?? 0;
	if (left <= 0) return undefined;
	if (left === 1) pending.delete(conversationId);
	else pending.set(conversationId, left - 1);
	return RECOVER_NOTE;
}

/** 单测 / 探针清理用：不跨进程，不需要落盘清理。 */
export function resetRecoverNotes(): void {
	pending.clear();
}
