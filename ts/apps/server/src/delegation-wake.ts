/**
 * 派活完成即唤醒（2026-11-10 批 29，方案 `docs/设计方案/2026-11-10-方案（派活完成即唤醒）.md`）。
 *
 * 汇报写回只解决"结果不丢"，不解决"派活方知道"。本模块补最后一环：任务到终态、
 * 汇报写回会话之后，把**派活的那条会话**叫起来跑一轮，接住结果（转述 / 追问 / 继续派）。
 *
 * 规则只有一条：**汇报写了就唤醒，没写就不唤醒。** 挂点在装配层
 * （`agent/lifecycle.ts` 的 `reportDelegation` 回调），两条结算路径都从那里过。
 *
 * 唤醒目标只认 **canonical 主会话**（`canonicalPartnerIdOfSession`）：群成员会话
 * （role=group）、例行专线（role=routine）、课题专线（role=topic）都不是"执事的门面
 * 会话"，派活终态不在那里主动开口（2026-11-10 批 29 返工裁决）。
 *
 * 为什么忙时退避而不是直接排队：`runPartnerTurn` 的 autonomous 标记是**会话级**的，
 * 在 `chatStream` 排队之前就生效；若直接提交，用户正在跑的那一轮也会被无人值守策略罩住。
 * 先等空闲再起轮，风险为零（方案 §2.2）。
 *
 * 依赖方向：只 import partner-runtime / partners / delegation（类型）/ agent/session，
 * **不 import agent/lifecycle**（lifecycle 反向 import 本模块，再加一条就是明确的环）。
 */

import type { Conversation } from "@earendil-works/pi-durable";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import {
	ensurePartnerSession,
	runPartnerTurn,
	type PartnerTurnOptions,
	type PartnerTurnResult,
} from "./partner-runtime.ts";
import type { DelegationReport } from "./delegation.ts";
import { conversationIsBusy } from "./agent/session.ts";

/** 防抖：同一时刻结算的多张单合成一轮 */
const DEBOUNCE_MS = 2_000;
/** 忙退避间隔：与防抖同值，每 2 秒重查一次 */
const BUSY_RETRY_MS = 2_000;
/** 忙退避上限：150 × 2 秒 ≈ 5 分钟；超限放弃（汇报本身已在会话里，不丢） */
const MAX_BUSY_RETRIES = 150;
/**
 * 单次触发链的连续 flush 上限。方案 §2.2 只写了 while，这是实现层保险丝：
 * 唤醒轮自己再派活会产出新汇报，正常是合法链；这个上限只防 `while` 缺陷把进程拖死。
 */
const MAX_CHAIN_FLUSHES = 5;

export type WakeTimerHandle = unknown;

/**
 * 可注入的内部参数（默认全走真实实现）。单测用假时钟 / 假执事库驱动，
 * 不需要起服务、也不碰磁盘。
 */
export interface DelegationWakeDeps {
	/** `DELEGATION_WAKE_ENABLED`，每次 flush 现读（flags 是 hot） */
	wakeEnabled(): boolean;
	/** 执事体系总闸（`COMPANIONS_ENABLED`，模块常量） */
	companionsEnabled(): boolean;
	/** 只认 canonical 主会话（`canonicalPartnerIdOfSession`），群 / 专线链接返回 null */
	partnerIdOfSession(conversationId: number): string | null;
	partnerStatus(partnerId: string): string | null;
	ensureSession(partnerId: string): Promise<{ conversation: Conversation } | null>;
	isBusy(chat: { conversation: Conversation }): Promise<boolean>;
	runTurn(
		partnerId: string,
		prompt: string,
		opts: PartnerTurnOptions,
	): Promise<PartnerTurnResult>;
	setTimer(fn: () => void, ms: number): WakeTimerHandle;
	clearTimer(handle: WakeTimerHandle): void;
}

/**
 * 开关（回滚形态）：`DELEGATION_WAKE_ENABLED=false` → 只写汇报不唤醒，与改动前一致。
 * 读法照 `partners.ts:40`：只有明确写 false 才关，拼错值不会把能力误关。
 * 写成函数而不是模块常量：flags 里标了 hot，设置页切了要立即生效。
 */
export function delegationWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.DELEGATION_WAKE_ENABLED?.trim() || "true").toLowerCase() !== "false";
}

/** 待唤醒的汇报，按会话合并；取走即清空 */
const pending = new Map<number, DelegationReport[]>();
/** 每会话最多一个防抖定时器 */
const timers = new Map<number, { handle: WakeTimerHandle; cancel: () => void }>();
/** 正在 flush 的会话：期间新汇报只追加，不再排定时器（链内会接住） */
const running = new Set<number>();

const defaultDeps: DelegationWakeDeps = {
	wakeEnabled: () => delegationWakeEnabled(),
	companionsEnabled: () => COMPANIONS_ENABLED,
	partnerIdOfSession: (conversationId) =>
		partnersStore().canonicalPartnerIdOfSession(conversationId),
	partnerStatus: (partnerId) => partnersStore().get(partnerId)?.status ?? null,
	ensureSession: (partnerId) => ensurePartnerSession(partnerId),
	isBusy: (chat) => conversationIsBusy(chat.conversation),
	runTurn: (partnerId, prompt, opts) => runPartnerTurn(partnerId, prompt, opts),
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 守卫链（顺序即语义）：任一不过 → 静默返回 null。
 *
 * 1. `DELEGATION_WAKE_ENABLED` 关 → 回滚形态；
 * 2. `COMPANIONS_ENABLED` 关 → 唤醒轮跑不了（runPartnerTurn 需要执事体系）；
 * 3. 非 canonical 主会话（群会话 role=group / 例行专线 role=routine / 课题专线 role=topic）→ 不唤醒；
 * 4. partner 不存在或不是 active → 不唤醒。
 *
 * **每次 flush 都要重新过一遍**：排队期间开关可能被切、执事可能被停。
 */
function guardPartner(
	conversationId: number,
	deps: DelegationWakeDeps,
): string | null {
	if (!deps.wakeEnabled()) return null;
	if (!deps.companionsEnabled()) return null;
	const partnerId = deps.partnerIdOfSession(conversationId);
	if (partnerId === null) return null;
	if (deps.partnerStatus(partnerId) !== "active") return null;
	return partnerId;
}

/**
 * 唤醒提示词（固定字节，可单测）。单号取前 6 位，`phase` / `text` 直用上游口径
 * （text 上限 80 字已由 delegation.ts 保证）。
 */
export function buildWakePrompt(reports: DelegationReport[]): string {
	const header = [
		"[Delegation wake context]",
		"turnAuthority: autonomous",
		"",
		"以下后台任务刚到终态，执行端汇报已写进本会话。逐条接住：",
		"- 完成了：一两句向主人转述结果与落点，不复读执行端原文；",
		"- 失败了：说清原因与下一步建议；",
		"- 需要主人拿主意的：把问题明确提出来。",
		"不要重新派同样的活。没有要补充的就一句话收尾。",
		"",
		"本批终态：",
	].join("\n");
	const lines = reports.map(
		(report) => `- 单 ${report.ticketId.slice(0, 6)}（${report.phase}）：${report.text}`,
	);
	return [header, ...lines].join("\n");
}

/**
 * 取走即清空（纯函数，单测直接调）。没有该会话的 pending → 空数组。
 */
export function collectPending(
	store: Map<number, DelegationReport[]>,
	conversationId: number,
): DelegationReport[] {
	const reports = store.get(conversationId);
	if (!reports || reports.length === 0) {
		store.delete(conversationId);
		return [];
	}
	store.delete(conversationId);
	return reports;
}

function clearConversation(conversationId: number): void {
	pending.delete(conversationId);
	const timer = timers.get(conversationId);
	if (timer) {
		timer.cancel();
		timers.delete(conversationId);
	}
}

function scheduleFlush(conversationId: number, deps: DelegationWakeDeps): void {
	const handle = deps.setTimer(() => {
		timers.delete(conversationId);
		void flushDelegationWake(conversationId, deps);
	}, DEBOUNCE_MS);
	timers.set(conversationId, {
		handle,
		cancel: () => deps.clearTimer(handle),
	});
}

function sleep(deps: DelegationWakeDeps, ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		deps.setTimer(() => resolve(), ms);
	});
}

/** 错误只留一行（日志纪律：不记汇报正文，错误正文也不铺开） */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * 派活汇报写回后的唤醒触发（fire-and-forget）。
 *
 * **绝不抛**：调用方在汇报回调里，唤醒出错不能拖累汇报。守卫不过 = 静默返回（= 改动前行为）。
 * 通过守卫后把汇报追加进 pending，该会话没有定时器就排一个 2 秒防抖。
 */
export function wakeOnDelegationReport(
	conversationId: number,
	report: DelegationReport,
	deps: DelegationWakeDeps = defaultDeps,
): void {
	try {
		if (guardPartner(conversationId, deps) === null) return;
		const list = pending.get(conversationId);
		if (list) list.push(report);
		else pending.set(conversationId, [report]);
		// 已有定时器 / 正在跑链：只追加，接住由那条链负责
		if (timers.has(conversationId) || running.has(conversationId)) return;
		scheduleFlush(conversationId, deps);
	} catch {
		// 唤醒是增值动作，任何异常都不外抛
	}
}

/**
 * 执行一轮唤醒链（防抖到点 / 单测直接调）。
 *
 * 每轮重新过守卫链；忙则每 2 秒重查（上限 150 次）；跑完若 pending 又有新货就继续，
 * 单链最多 `MAX_CHAIN_FLUSHES` 轮。全程兜异常，不向事件循环抛未捕获拒绝。
 */
export async function flushDelegationWake(
	conversationId: number,
	deps: DelegationWakeDeps = defaultDeps,
): Promise<void> {
	const existing = timers.get(conversationId);
	if (existing) {
		existing.cancel();
		timers.delete(conversationId);
	}
	// 同一会话已有链在跑：这批 pending 归那条链接住
	if (running.has(conversationId)) return;
	running.add(conversationId);
	try {
		let rounds = 0;
		for (;;) {
			const partnerId = guardPartner(conversationId, deps);
			if (partnerId === null) {
				clearConversation(conversationId);
				return;
			}
			const chat = await deps.ensureSession(partnerId);
			if (!chat) {
				clearConversation(conversationId);
				return;
			}

			// 忙退避：标记是会话级的，必须等这一轮跑完再起轮
			let waits = 0;
			while (await deps.isBusy(chat)) {
				waits += 1;
				if (waits > MAX_BUSY_RETRIES) {
					const count = pending.get(conversationId)?.length ?? 0;
					console.warn(
						`[wake] 会话 ${conversationId} 忙超 5 分钟，本次唤醒放弃 tickets=${count}`,
					);
					clearConversation(conversationId);
					return;
				}
				await sleep(deps, BUSY_RETRY_MS);
			}

			const queued = pending.get(conversationId) ?? [];
			if (queued.length === 0) return;
			if (rounds >= MAX_CHAIN_FLUSHES) {
				console.warn(
					`[wake] 会话 ${conversationId} 连续唤醒超过 ${MAX_CHAIN_FLUSHES} 轮，停止本链 tickets=${queued.length}`,
				);
				clearConversation(conversationId);
				return;
			}

			const reports = collectPending(pending, conversationId);
			rounds += 1;
			const started = Date.now();
			const result = await deps.runTurn(partnerId, buildWakePrompt(reports), {
				authority: "autonomous",
				quiet: false,
				sessionMode: "persistent",
			});
			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			if (result.ok) {
				console.log(
					`[wake] 会话 ${conversationId} 唤醒轮 ok tickets=${reports.length} 耗时${seconds}s`,
				);
			} else {
				console.warn(
					`[wake] 会话 ${conversationId} 唤醒轮失败: ${oneLine(result.error ?? "未知错误")}`,
				);
			}
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[wake] 会话 ${conversationId} 唤醒轮失败: ${oneLine(detail)}`);
	} finally {
		running.delete(conversationId);
		// 链尾才到的新汇报：补一个防抖，别让它们卡在 pending 里
		if ((pending.get(conversationId)?.length ?? 0) > 0 && !timers.has(conversationId)) {
			scheduleFlush(conversationId, deps);
		}
	}
}

/** 测试用：清 pending / 定时器 / 运行标记（生产不需要调用）。 */
export function resetDelegationWakeState(): void {
	for (const timer of timers.values()) timer.cancel();
	timers.clear();
	pending.clear();
	running.clear();
}
