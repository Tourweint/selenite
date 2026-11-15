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
 * 送达兜底（2026-11-15，方案 `docs/设计方案/2026-11-15-派活回信送达兜底` §C）：
 * - pending 队列每次变化原子写 `.data/wake-pending.json`，启动由
 *   `restoreDelegationWakeQueue` 读回重排——重启不再丢唤醒；
 * - 忙退避耗尽 / 链保险丝 / 唤醒轮失败从"清空放弃"改为**有限次重排**（10 分钟 × 3 次），
 *   放弃必留一行日志。翻案登记：批 29 的"耗尽即放弃"按用户"确保收到回信"口径收紧。
 *
 * 依赖方向：只 import partner-runtime / partners / delegation（类型）/ agent/session，
 * **不 import agent/lifecycle**（lifecycle 反向 import 本模块，再加一条就是明确的环）。
 */

import type { Conversation } from "@earendil-works/pi-durable";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import {
	ensurePartnerSession,
	runPartnerTurn,
	type PartnerTurnOptions,
	type PartnerTurnResult,
} from "./partner-runtime.ts";
import type { DelegationReport } from "./delegation.ts";
import { conversationIsBusy } from "./agent/session.ts";
import { maybeScheduleNudge } from "./partner-proactive.ts";

/** 防抖：同一时刻结算的多张单合成一轮 */
const DEBOUNCE_MS = 2_000;
/** 忙退避间隔：与防抖同值，每 2 秒重查一次 */
const BUSY_RETRY_MS = 2_000;
/** 忙退避上限：150 × 2 秒 ≈ 5 分钟；超限不再原地等，改重排（2026-11-15 送达兜底 §C） */
const MAX_BUSY_RETRIES = 150;
/**
 * 单次触发链的连续 flush 上限。方案 §2.2 只写了 while，这是实现层保险丝：
 * 唤醒轮自己再派活会产出新汇报，正常是合法链；这个上限只防 `while` 缺陷把进程拖死。
 */
const MAX_CHAIN_FLUSHES = 5;
/** 重排间隔（2026-11-15 送达兜底 §C）：耗尽 / 失败后 10 分钟再试一轮。 */
const REQUEUE_MS = 10 * 60_000;
/** 连续重排上限：超过就真放弃（正文仍在会话里，损失只是转述轮），防宿主卡死时无限轮询。 */
const MAX_REQUEUES = 3;

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
	/** 批3：唤醒轮成功后的挂念检查（自判 proactivity / 子开关 / 一天一条）。 */
	nudge?(partnerId: string): Promise<boolean> | void;
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
/** 连续重排计数（2026-11-15 送达兜底 §C）：唤醒轮成功即清零 */
const requeues = new Map<number, number>();

/** 队列文件路径（懒读 env：单测用 AGENT_WAKE_PENDING_PATH 钉到临时目录）。 */
function wakeQueuePath(): string {
	return process.env.AGENT_WAKE_PENDING_PATH?.trim() || ".data/wake-pending.json";
}

/**
 * 队列落盘（原子写，照 chat-meta 的临时文件 + rename）。落盘失败只 warn——
 * 它是兜底不是主链路，不能拖累唤醒；失败的最坏结果退回"重启丢唤醒"的旧行为。
 * 日志纪律：只记条数，不落汇报正文。
 */
function persistWakeQueue(): void {
	try {
		const entries = [...pending.entries()].map(([conversationId, reports]) => ({
			conversationId,
			reports,
		}));
		mkdirSync(dirname(resolve(wakeQueuePath())), { recursive: true });
		const temp = `${wakeQueuePath()}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(temp, JSON.stringify({ version: 1, entries }), "utf8");
		renameSync(temp, wakeQueuePath());
	} catch (error) {
		console.warn(
			`[wake] 唤醒队列落盘失败（不影响本轮唤醒）: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** 单条待唤醒汇报的最小形状（读回时防脏数据）。 */
function isReportLike(value: unknown): value is DelegationReport {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { ticketId?: unknown }).ticketId === "string" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

/**
 * 启动恢复（2026-11-15 送达兜底 §C）：读回上一次进程没送完的唤醒队列并重排防抖。
 * 文件不存在 / 坏了 / 条目脏 → 当空队列，不抛。由 index.ts 启动段调用。
 */
export function restoreDelegationWakeQueue(deps: DelegationWakeDeps = defaultDeps): number {
	try {
		const parsed = JSON.parse(readFileSync(wakeQueuePath(), "utf8")) as {
			entries?: Array<{ conversationId?: unknown; reports?: unknown }>;
		};
		let restored = 0;
		for (const entry of Array.isArray(parsed.entries) ? parsed.entries : []) {
			const conversationId = Number(entry.conversationId);
			const reports = (Array.isArray(entry.reports) ? entry.reports : []).filter(isReportLike);
			if (!Number.isFinite(conversationId) || reports.length === 0) continue;
			pending.set(conversationId, reports);
			restored += reports.length;
			if (!timers.has(conversationId) && !running.has(conversationId)) {
				scheduleFlush(conversationId, deps);
			}
		}
		if (restored > 0) console.log(`[wake] 重启恢复唤醒队列 ${restored} 条`);
		return restored;
	} catch {
		return 0;
	}
}

const defaultDeps: DelegationWakeDeps = {
	wakeEnabled: () => delegationWakeEnabled(),
	companionsEnabled: () => COMPANIONS_ENABLED,
	partnerIdOfSession: (conversationId) =>
		partnersStore().canonicalPartnerIdOfSession(conversationId),
	partnerStatus: (partnerId) => partnersStore().get(partnerId)?.status ?? null,
	ensureSession: (partnerId) => ensurePartnerSession(partnerId),
	isBusy: (chat) => conversationIsBusy(chat.conversation),
	runTurn: (partnerId, prompt, opts) => runPartnerTurn(partnerId, prompt, opts),
	nudge: (partnerId) => maybeScheduleNudge(partnerId),
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
	const lines = reports.map((report) => {
		const line = `- 单 ${report.ticketId.slice(0, 6)}（${report.phase}）：${report.text}`;
		// 批 31：有产物目录才追加落点行；无指针时逐字节与改动前一致。
		let out = report.productDirs?.length ? `${line}\n  落点：${report.productDirs.join("、")}` : line;
		// 批次二（2026-11-13 工具层结果契约化）：失败 / 中断单带可续接信息，
		// 提醒父模型子会话还在、可续接——不强迫，只给指针。
		if (report.resume) {
			out += `\n  续接：子单 ${report.resume.id}，子会话 ${report.resume.conversationId} 仍在，已知进展：${report.resume.partialReport}`;
		}
		return out;
	});
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
	requeues.delete(conversationId);
	const timer = timers.get(conversationId);
	if (timer) {
		timer.cancel();
		timers.delete(conversationId);
	}
	persistWakeQueue();
}

/**
 * 有限次重排（2026-11-15 送达兜底 §C）：忙退避耗尽 / 链保险丝 / 唤醒轮失败时，
 * 保留 pending 排一个 10 分钟后的重试；连续超过 MAX_REQUEUES 次才真放弃（warn 一行）。
 * 翻案登记：批 29 的"耗尽即放弃"按用户"确保收到回信"口径收紧为"有限次重排"。
 */
function requeueConversation(
	conversationId: number,
	deps: DelegationWakeDeps,
	reason: string,
): void {
	const queued = pending.get(conversationId)?.length ?? 0;
	if (queued === 0) {
		clearConversation(conversationId);
		return;
	}
	const count = (requeues.get(conversationId) ?? 0) + 1;
	if (count > MAX_REQUEUES) {
		console.warn(
			`[wake] 会话 ${conversationId} 重排 ${MAX_REQUEUES} 次仍未成功（${reason}），放弃唤醒 tickets=${queued}`,
		);
		clearConversation(conversationId);
		return;
	}
	requeues.set(conversationId, count);
	const existing = timers.get(conversationId);
	if (existing) existing.cancel();
	const handle = deps.setTimer(() => {
		timers.delete(conversationId);
		void flushDelegationWake(conversationId, deps);
	}, REQUEUE_MS);
	timers.set(conversationId, { handle, cancel: () => deps.clearTimer(handle) });
	persistWakeQueue();
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
		persistWakeQueue();
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
					console.warn(
						`[wake] 会话 ${conversationId} 忙超 5 分钟，改 10 分钟后重试 tickets=${pending.get(conversationId)?.length ?? 0}`,
					);
					requeueConversation(conversationId, deps, "忙退避耗尽");
					return;
				}
				await sleep(deps, BUSY_RETRY_MS);
			}

			const queued = pending.get(conversationId) ?? [];
			if (queued.length === 0) return;
			if (rounds >= MAX_CHAIN_FLUSHES) {
				console.warn(
					`[wake] 会话 ${conversationId} 连续唤醒超过 ${MAX_CHAIN_FLUSHES} 轮，本链停止改重排 tickets=${queued.length}`,
				);
				requeueConversation(conversationId, deps, "链保险丝");
				return;
			}

			const reports = collectPending(pending, conversationId);
			persistWakeQueue();
			rounds += 1;
			const started = Date.now();
			const result = await deps.runTurn(partnerId, buildWakePrompt(reports), {
				authority: "autonomous",
				quiet: false,
				sessionMode: "persistent",
			});
			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			if (result.ok) {
				// 重排计数只在**队列真正清空**时归零：链式唤醒每一轮都是 ok 的，按轮清零
				// 会让保险丝重排永远攒不起次数（2026-11-15 首轮实现踩过，测试抓的）。
				if ((pending.get(conversationId)?.length ?? 0) === 0) requeues.delete(conversationId);
				console.log(
					`[wake] 会话 ${conversationId} 唤醒轮 ok tickets=${reports.length} 耗时${seconds}s`,
				);
				// 批3：这是既有"主动开口时机"之一——唤醒轮成功后再看要不要发一条挂念。
				// 内部自判模块 / 子开关 / 一天一条；失败只返回 false，不影响唤醒链。
				try {
					await deps.nudge?.(partnerId);
				} catch {
					// 挂念是增值动作，不外抛
				}
			} else {
				console.warn(
					`[wake] 会话 ${conversationId} 唤醒轮失败: ${oneLine(result.error ?? "未知错误")}`,
				);
				// 失败回灌队首 + 重排（2026-11-15 送达兜底 §C.4）：取走的汇报不放回去
				// 就真丢了；链尾的 finally 看到已有定时器不会重复排。
				const waiting = pending.get(conversationId) ?? [];
				pending.set(conversationId, [...reports, ...waiting]);
				requeueConversation(conversationId, deps, "唤醒轮失败");
				return;
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

/** 测试用：清 pending / 定时器 / 运行标记 / 重排计数（生产不需要调用；不落盘）。 */
export function resetDelegationWakeState(): void {
	for (const timer of timers.values()) timer.cancel();
	timers.clear();
	pending.clear();
	running.clear();
	requeues.clear();
}
