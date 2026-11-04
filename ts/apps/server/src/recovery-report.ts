import type { RecoveredTicket } from "../../../../../chancellor/src/index.ts";
import { truncate } from "./delegation.ts";

/**
 * 恢复结算的状态行回灌（2026-11-04 批次四 A3b）。
 *
 * 单独成模块的原因：`index.ts` 顶层就 `serve`、`agent.ts` 顶层就建库，
 * 单测 import 它们等于顺手起服务；这里只留纯函数与可注入依赖，测试能直接跑。
 *
 * 口径：**一行状态，不是任务结果正文**。恢复时手里只有 status / error，
 * 复述正文既没有内容也没有意义。
 */

/** 对外 5 态。只有落在这里的才回灌；still_running / unknown 是 chancellor 的内部占位。 */
const TERMINAL_STATUSES = new Set(["done", "needs_you", "failed", "idle", "aborted"]);

/** 回执表里 A3b 需要的那一个查询，收窄成接口方便测试注入。 */
export interface RecoveryReceiptLookup {
	lookupByTicket(ticketId: string): { conversationId: number | null } | null;
}

export interface RecoveryReportDeps {
	receipts: RecoveryReceiptLookup;
	/** 内部会话 id → 往这个会话写一句话；失败可以抛，调用方会吞掉并 warn。 */
	say: (conversationId: number, text: string) => void | Promise<void>;
	/** 只在需要排查时给；默认静默。 */
	log?: (line: string) => void;
}

/** 回滚开关：只有明确写 false 才关；不配 = 开。每次调用都读 env，单测可在同进程里切。 */
export function recoverReportEnabled(): boolean {
	return (process.env.DELEGATION_RECOVER_REPORT?.trim() || "true").toLowerCase() !== "false";
}

/**
 * 一行话怎么写（≤80 字）。
 *
 * 按 status 原词输出：failed / aborted 不能写成「已完成」——用户看的是这一句，
 * 措辞错了比不写更糟。error 只在有值时附在括号里，原文压成一行再截断。
 */
export function formatRecoveryLine(entry: RecoveredTicket): string {
	const error = entry.error?.replace(/\s+/g, " ").trim() ?? "";
	const detail = error ? `（${error}）` : "";
	return truncate(
		`上一进程留下的派活单 ${entry.ticketId} 已终态：${entry.status}${detail}`,
		80,
	);
}

/**
 * 逐单查回执 → 找会话 → 写一行。返回真正写出去的条数。
 *
 * 静默与 warn 的分界：
 * - 开关关 / 非终态 / 单号为空：静默跳过（分母为零，不是异常）；
 * - 没有回执、回执没有会话映射：warn 一次（说明这张单回灌不到，值得排查）；
 * - 写回抛异常：warn 后继续下一条（一条失败不能拖住别的单）。
 */
export async function reportRecoveredTickets(
	entries: RecoveredTicket[],
	deps: RecoveryReportDeps,
): Promise<number> {
	if (!recoverReportEnabled()) return 0;
	const log = deps.log ?? (() => {});
	let sent = 0;

	for (const entry of entries) {
		if (!entry.ticketId || !TERMINAL_STATUSES.has(entry.status)) continue;

		const receipt = deps.receipts.lookupByTicket(entry.ticketId);
		if (!receipt) {
			log(`[恢复回灌] 单 ${entry.ticketId} 没有受理回执，跳过`);
			continue;
		}
		if (receipt.conversationId === null) {
			log(`[恢复回灌] 单 ${entry.ticketId} 的回执没有会话映射，跳过`);
			continue;
		}

		try {
			await deps.say(receipt.conversationId, formatRecoveryLine(entry));
			sent += 1;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			log(`[恢复回灌] 单 ${entry.ticketId} 写回会话失败: ${detail}`);
		}
	}

	return sent;
}

// ── 迟到子单死信（2026-11-05 批次A A2）──────────────────────
/** 子单的最小形状（chancellor Store.childrenOf 的投影，收窄方便注入测试）。 */
export interface DeadLetterChild {
	id: string;
	status: string;
}

export interface DeadLetterRecord {
	parentTicketId: string;
	childTicketId: string;
	childStatus: string;
	note: string;
}

export interface DeadLetterDeps {
	/** 父单的子单查询（含分管 runs_dir 的聚合），由调用方注入；没有返回空数组。 */
	childrenOf: (parentTicketId: string) => DeadLetterChild[];
	/** 死信落库；返回 false = 重复（主键幂等撞了），不计入新增数。 */
	record: (entry: DeadLetterRecord) => boolean;
	log?: (line: string) => void;
}

const CHILD_TERMINAL = new Set(["done", "needs_you", "failed", "idle", "aborted"]);

/**
 * 扫"父单已终态、子单结果无处并入"的死信（2026-11-05 批次A A2）。
 *
 * 背景：父单收口那一刻 `enforceChildClosure` 只读一次子单；父单被中止后子单才跑完的，
 * 结果没人看（A2 细化 §4.2 已核实的洞）。死信只记账不处置——不自动重派、不自动并入，
 * 与"中断不自动重放"同一原则。
 *
 * v1 判定（对每个**已终态**父单）：
 *   - 子单仍未终态 → 死信（父单不在收了，它跑完也没人要）；
 *   - 父单 aborted 且子单已终态 → 死信（结果有，但中止路径没有并入通道）。
 * 父单非 aborted 且子单已终态：正常收口路径，enforceChildClosure 已覆盖，不记。
 * 时间戳比较（"子单晚于父单落终态"）做不了：RecoveredTicket 没带 updated_at，
 * 如实登记为 v1 限制，不硬造。
 */
export function collectDeadLetters(
	entries: RecoveredTicket[],
	deps: DeadLetterDeps,
): number {
	if (!recoverReportEnabled()) return 0;
	const log = deps.log ?? (() => {});
	let recorded = 0;

	for (const entry of entries) {
		if (!entry.ticketId || !TERMINAL_STATUSES.has(entry.status)) continue;
		const children = deps.childrenOf(entry.ticketId);
		for (const child of children) {
			const note = !CHILD_TERMINAL.has(child.status)
				? `父单已终态（${entry.status}），子单仍未终态`
				: entry.status === "aborted"
					? `父单已中止，子单结果无处并入`
					: "";
			if (!note) continue;
			const inserted = deps.record({
				parentTicketId: entry.ticketId,
				childTicketId: child.id,
				childStatus: child.status,
				note,
			});
			if (inserted) {
				recorded += 1;
				log(`[恢复死信] 父单 ${entry.ticketId} 的子单 ${child.id}（${child.status}）入死信：${note}`);
			}
		}
	}

	return recorded;
}
