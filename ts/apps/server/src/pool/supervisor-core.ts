/**
 * 池监督者的全部判断逻辑（P2 池骨架 G1）。
 *
 * 监督者要起进程、开 HTTP、看心跳，那层没法单测；所以把判断抽成这里的纯函数，
 * 进程管理那层只剩"照着判断结果打动作"。零 IO：不读 env、不碰 child_process / fetch / fs。
 *
 * env 覆盖（`SUPERVISOR_POOL_SIZE` 之类）在下一批的 `supervisor.ts` 里读，这里只给常量与算法。
 */

/** 池里一个槽位的状态。槽位 = 一个池进程。 */
export interface SlotState {
	index: number;
	/** 池进程当前 PID；null = 没起 / 已退出 */
	pid: number | null;
	/** 监听的端口；null = 还没 ready */
	port: number | null;
	/** 这个进程已经跑完多少票（回收判据） */
	finishedTickets: number;
	/** 最近一次 /health 的 RSS（MB）；null = 还没探过 */
	rssMb: number | null;
	/** 这个槽位当前绑的票号；null = 空闲 */
	ticketId: string | null;
	/** 最近一次 /health 成功的时间戳（ms）；0 = 没探过 */
	lastSeenAt: number;
}

export interface SupervisorConfig {
	poolSize: number;
	recycleTickets: number;
	rssLimitMb: number;
	/** 进程崩溃后的重拉退避：base * 2^(n-1)，封顶 maxMs */
	backoffBaseMs: number;
	backoffMaxMs: number;
	/** 心跳超时：超过这么久没探到 → 判定卡死 */
	heartbeatTimeoutMs: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
	poolSize: 4,
	recycleTickets: 20,
	rssLimitMb: 1500,
	backoffBaseMs: 1000,
	backoffMaxMs: 30_000,
	heartbeatTimeoutMs: 60_000,
};

/** ready 行锚定整行：普通日志行、前后带别的字段的行、半行都不算。 */
const READY_LINE = /^\s*\[pool\] ready port=(\d+) index=(\d+)\s*$/;

/** 从池进程 stdout 行里解析 ready 行；不匹配返回 null */
export function parseReadyLine(line: string): { port: number; index: number } | null {
	const match = READY_LINE.exec(line);
	if (match === null) return null;
	const port = Number(match[1]);
	const index = Number(match[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
	if (!Number.isInteger(index) || index < 0 || index > 65_535) return null;
	return { port, index };
}

/** 第 n 次连续失败后的退避时长（n 从 1 开始） */
export function backoffDelayMs(config: SupervisorConfig, consecutiveFailures: number): number {
	const n = Number.isFinite(consecutiveFailures) ? Math.floor(consecutiveFailures) : 0;
	const attempt = n > 0 ? n : 1;
	const base = config.backoffBaseMs;
	const cap = config.backoffMaxMs;
	if (!(base > 0)) return 0;
	// 边翻倍边比较，避免 n 很大时算 2^1000：一旦够到上限就停。
	let delay = base;
	for (let i = 1; i < attempt && delay < cap; i += 1) {
		delay *= 2;
	}
	return Math.min(cap, delay);
}

/** 挑一个能接票的槽位：没绑票、pid/port 就绪、没超 RSS；优先 index 小的。没有返回 null */
export function pickIdleSlot(
	slots: readonly SlotState[],
	config: SupervisorConfig,
): SlotState | null {
	let best: SlotState | null = null;
	for (const slot of slots) {
		if (slot.pid === null || slot.port === null || slot.ticketId !== null) continue;
		if (slot.rssMb !== null && slot.rssMb >= config.rssLimitMb) continue;
		if (best === null || slot.index < best.index) best = slot;
	}
	return best;
}

/** 这个槽位现在该不该回收（跑满票数 / RSS 超阈值 / 心跳超时） */
export type RecycleReason = "tickets" | "rss" | "heartbeat" | null;

export function recycleReason(
	slot: SlotState,
	config: SupervisorConfig,
	nowMs: number,
): RecycleReason {
	// 例外：跑票中不因票数 / RSS 回收（要等这一票结算），但心跳卡死必须立刻处理。
	if (slot.ticketId === null) {
		if (slot.finishedTickets >= config.recycleTickets) return "tickets";
		if (slot.rssMb !== null && slot.rssMb >= config.rssLimitMb) return "rss";
	}
	if (slot.lastSeenAt > 0 && nowMs - slot.lastSeenAt > config.heartbeatTimeoutMs) {
		return "heartbeat";
	}
	return null;
}

/** 从内存绑定表里找出跑着某票的槽位；没有返回 null */
export function slotOfTicket(
	slots: readonly SlotState[],
	ticketId: string,
): SlotState | null {
	let best: SlotState | null = null;
	for (const slot of slots) {
		if (slot.ticketId !== ticketId) continue;
		if (best === null || slot.index < best.index) best = slot;
	}
	return best;
}

/**
 * 单票超时判定（M2a，2026-11-22）。返回哪个上限先到；都没到返回 null。
 *
 * 两种口径都从"这一票开始跑"算起：max 看 startedAt，idle 看 lastActivityAt
 * （每收到一条 SSE 事件就刷新）。按**到期时刻谁更早**判，而不是固定先判 max：
 * 静默 10 分钟先于 60 分钟总时长到期，报 idle 才是这票真实卡住的原因；
 * 持续有 progress 时 idle 永远不到期，到 60 分钟才报 max。
 * 同一刻两边都到期时按 max 处理（到期时刻相同 = max 的边界也踩到了）。
 *
 * maxMs / idleMs <= 0 表示该项不限（env 写 0 或负数）；非有限值按不限处理。
 */
export function runTimeoutReason(input: {
	startedAt: number;
	lastActivityAt: number;
	now: number;
	idleMs: number;
	maxMs: number;
}): "max" | "idle" | null {
	const maxDeadline =
		Number.isFinite(input.maxMs) && input.maxMs > 0 ? input.startedAt + input.maxMs : null;
	const idleDeadline =
		Number.isFinite(input.idleMs) && input.idleMs > 0
			? input.lastActivityAt + input.idleMs
			: null;
	// 先算 max：两边同一刻到期（或 max 更早）都归 max。
	if (maxDeadline !== null && input.now >= maxDeadline) return "max";
	if (idleDeadline !== null && input.now >= idleDeadline) return "idle";
	return null;
}