import { AUTONOMY_RISK_TOOLS } from "./autonomy-risk.ts";
import { isAutonomyTurn } from "./autonomy-state.ts";
import { capabilityOf, type ToolCapability } from "./tool-capability.ts";

/**
 * 无人值守权限语义（2026-11-10 批 13 §一，全景调研 #17 / #28）。
 *
 * 问题：没人看着的时候遇到"要花钱 / 要人批准"的事，现在的唯一策略是落 pending 等人。
 * 人在睡觉就卡死——async 审批零阻塞但本轮做不完，blocking 更是直接挂 120 秒。
 *
 * 本模块给**第二策：跳过并明说**。三态：
 *   - `allow`：纯读 / 只写内部状态，照常执行；
 *   - `skip` ：需要花钱或需要人点头（写盘、起进程、派活、递话、提问），**不执行**，
 *              回一句固定话术让模型继续做剩下的部分，并在结果里写明跳过了什么；
 *   - `deny` ：会让 agent 给自己扩权 / 影响系统（建停执事、建群、建例行规则、删除类），
 *              显式拒绝并给原因。
 *
 * **绝不挂起**：无人值守分支在 lifecycle 的 beforeTool 里先于审批判定执行，
 * 三态之外没有第四条路。`AGENT_UNATTENDED_POLICY` 默认 false——关着时一个字节都不参与判定，
 * 行为与今天逐字节一致。
 *
 * 本模块不 import agent/：只有进程内标记 + 纯判定，单测不需要真 harness。
 */

/** 无人值守下"跳过"回给模型的固定话术（任务书 §二.1 逐字）。 */
export const UNATTENDED_SKIP_MESSAGE =
	"现在是无人值守，这一步需要花钱 / 需要人批准，已跳过。" +
	"继续做不需要花钱的部分，最后在结果里明确写出你跳过了哪些步骤、为什么。";

export type UnattendedVerdict = "allow" | "skip" | "deny";

/**
 * 结构性拒绝（会让 agent 自己扩权或影响系统）。
 *
 * `routine_manage` 的 delete 动作也在这张表里（按工具名整条拒）——无人值守的删除
 * 没有人在场兜底，宁可不做。`send_to_agent` 会起对方一轮（花钱 + 影响别人的会话），
 * 与自主轮的结构性拒绝同口径。删除类工具按名字 `delete*` 兜底（当前没有独立删除工具）。
 */
const UNATTENDED_DENY_TOOLS = new Set([
	"partner_manage",
	"group_manage",
	"routine_manage",
	"send_to_agent",
	// 结构化提问必然挂起等人——无人值守下没人回答，当 skip 处理（见下方判定），
	// 这里刻意不列 deny：它不是扩权，只是这一步做不了。
]);

/** 回滚 / 启用开关：默认 **false**（关）。只有明确 1/true/on 才开。 */
export function unattendedPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.AGENT_UNATTENDED_POLICY ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

/** 一键全开（调试 / 夜间批处理）：`AGENT_UNATTENDED=1` 时任何会话都按没人看着算。 */
function unattendedForcedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.AGENT_UNATTENDED ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

// ── 进程内标记：例行轮 / 任务专线 ─────────────────────────

/**
 * 例行轮（authority=autonomous）标记。
 *
 * 刻意不复用 `autonomy-state.ts` 的 Set：那个 Set 受 `AUTONOMY_ENABLED` 总闸控制
 * （默认关），而例行任务本身在执事能力开的时候照常跑。无人值守要判的是
 * "这一轮是不是例行任务唤醒的"，与观察/主动性总闸无关。
 */
const routineTurns = new Set<number>();

export function markRoutineTurn(conversationId: number): void {
	routineTurns.add(conversationId);
}

export function unmarkRoutineTurn(conversationId: number): void {
	routineTurns.delete(conversationId);
}

export function isRoutineTurn(conversationId: number): boolean {
	return routineTurns.has(conversationId);
}

/**
 * `task-` 前缀会话（任务专线 / 例行 fresh 专线 / 隔离生成会话）的内部 id 登记。
 *
 * 为什么需要一张进程内表：`isUnattended` 是同步判定，而 durable 的
 * external→internal 映射（`Chats` doc）是异步快照。会话在 `agent/session.ts`
 * 打开时顺手登记一次即可——能跑工具的轮次，会话必然在本进程打开过。
 */
const TASK_SESSION_CAP = 2000;
const taskSessions = new Set<number>();

export function markTaskSession(conversationId: number): void {
	if (!Number.isFinite(conversationId) || conversationId <= 0) return;
	if (taskSessions.has(conversationId)) return;
	taskSessions.add(conversationId);
	if (taskSessions.size > TASK_SESSION_CAP) {
		// 有界：进程活很久也不让这张表无限涨（先丢最早登记的）。
		const oldest = taskSessions.values().next().value;
		if (typeof oldest === "number") taskSessions.delete(oldest);
	}
}

export function isTaskSession(conversationId: number): boolean {
	return taskSessions.has(conversationId);
}

/** 测试用：清空进程内标记，避免用例互相污染。 */
export function resetUnattendedState(): void {
	routineTurns.clear();
	taskSessions.clear();
	skips.clear();
}

// ── 三态判定 ─────────────────────────────────────────────

/** 删除类工具：当前没有独立工具，按名字兜底（routine_manage 的 delete 已整条拒）。 */
function looksLikeDeleteTool(tool: string): boolean {
	return /^delete([_-]|$)/i.test(tool);
}

/**
 * 无人值守下这个工具怎么办。**只有三态，没有"ask"这一路**。
 *
 * 顺序即语义：
 *   1. 扩权 / 影响系统 → deny；
 *   2. 没有能力声明 → skip（不认识的工具宁可不跑，明确说出来）；
 *   3. 提问工具 → skip（没人回答，问了就是挂起）；
 *   4. destructive（写盘 / 起进程 / 派活）→ skip；
 *   5. 本身要求审批（`needsApproval !== "never"`）或自主轮强制问 → skip；
 *   6. 其余（只读 / 只写内部状态）→ allow。
 */
export function resolveUnattendedVerdict(
	tool: string,
	capability: ToolCapability | undefined = capabilityOf(tool),
): UnattendedVerdict {
	if (UNATTENDED_DENY_TOOLS.has(tool) || looksLikeDeleteTool(tool)) return "deny";
	if (!capability) return "skip";
	if (tool === "ask_user") return "skip";
	if (capability.destructive) return "skip";
	if (capability.needsApproval !== "never") return "skip";
	if (AUTONOMY_RISK_TOOLS[tool]) return "skip";
	return "allow";
}

/** 显式拒绝的理由（只含工具名，不含参数）。 */
export function unattendedDenyReason(tool: string): string {
	return (
		`无人值守时不能调用 ${tool}（会给自己扩权或影响系统）。` +
		"这一步先不做，最后在结果里说明被拒绝的是哪一步。"
	);
}

/**
 * 这一轮是不是"没人看着"：
 *   - 例行任务轮（`authority=autonomous` 的进程内标记）；
 *   - 自主轮标记（`autonomy-state.ts`，AUTONOMY_ENABLED 开时才有）；
 *   - `task-` 前缀会话（任务专线 / 例行 fresh 专线）；
 *   - 显式 `AGENT_UNATTENDED=1`（一键全开）。
 */
export function isUnattended(
	conversationId: number,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (unattendedForcedByEnv(env)) return true;
	if (isAutonomyTurn(conversationId)) return true;
	if (isRoutineTurn(conversationId)) return true;
	return isTaskSession(conversationId);
}

// ── 跳过记账（例行 run 记录要能看出跳过了什么）────────────
//
// 只记**工具名枚举**，不记参数与正文（日志 / 摘要纪律）。key 是会话 id：
// 一轮开始时清空、跑完由 partner-runtime 取走。进程内 Map，不落盘。

const skips = new Map<number, Set<string>>();

export function clearUnattendedSkips(conversationId: number): void {
	skips.delete(conversationId);
}

export function noteUnattendedSkip(conversationId: number, tool: string): void {
	let set = skips.get(conversationId);
	if (!set) {
		set = new Set<string>();
		skips.set(conversationId, set);
	}
	set.add(tool);
}

/** 取走本轮跳过的工具名（取走即清空）；没有跳过 = 空数组。 */
export function takeUnattendedSkips(conversationId: number): string[] {
	const set = skips.get(conversationId);
	if (!set) return [];
	skips.delete(conversationId);
	return [...set].sort();
}
