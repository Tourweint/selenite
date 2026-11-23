/**
 * 调度状态只读投影（2026-11-22 调度层合并方案 §5.5 / M2b）。
 *
 * GET /api/v1/scheduler 的装配层：把三份**已经有的事实**拼成一份对外 JSON，
 * 不自己算容量、不自己读队列——闸门的真实状态只归 lane.ts / admission.ts，
 * 池的真实状态只归 supervisor。这里多算一遍迟早会两边对不上。
 *
 * 边界（硬规矩）：
 * - 只放枚举 / 数字 / 时间；不放 prompt、路径、密钥。
 * - ticketId 只给前 8 位（shortTicketId）：观测够用，完整票号不因这个端点外泄。
 * - 任何一份快照读失败都只让该段为空 / null，不让任务中心因为观测接口 500 而崩。
 * - 这是宿主内部 HTTP，不进 shared 契约（手机端不消费；2026-11-22 拍板）。
 */

import process from "node:process";
import type { AdmissionSnapshot } from "../../../packages/chancellor/src/admission.ts";
import type { LaneSnapshot } from "../../../packages/chancellor/src/lane.ts";

/** 车道快照 + 冷却截止（epoch ms）；冷却由 lane.ts 另一张表维护，调用方拼进来。 */
export interface SchedulerLaneSnapshot extends LaneSnapshot {
	cooldownUntil: number | null;
}

/** 池快照的结构子集：只取投影要用的字段，不 import supervisor（避免观测层绑定实现）。 */
export interface SchedulerPoolSnapshot {
	slots: ReadonlyArray<{
		index: number;
		pid: number | null;
		port: number | null;
		ticketId: string | null;
		finishedTickets: number;
		rssMb: number | null;
	}>;
	running: readonly string[];
}

export interface SchedulerStatusInput {
	enabled: boolean;
	tickets: AdmissionSnapshot;
	lanes: readonly SchedulerLaneSnapshot[];
	pool: SchedulerPoolSnapshot | null;
}

export interface SchedulerStatus {
	ok: true;
	enabled: boolean;
	tickets: {
		/** null = 不限（env 写 0 / 负数时闸门内部用 Infinity，JSON 里不能出现 Infinity）。 */
		max: number | null;
		active: number;
		queued: number;
		domains?: Record<string, number>;
	};
	lanes: Array<{
		lane: string;
		cap: number;
		running: number;
		queued: number;
		cooldownUntil: string | null;
	}>;
	pool: {
		slots: Array<{
			index: number;
			pid: number | null;
			port: number | null;
			ticketId: string | null;
			finishedTickets: number;
			rssMb: number | null;
		}>;
		running: string[];
	} | null;
}

/**
 * 纯装配：入参是已经读好的快照，不读 env、不 catch。
 * 需要「读失败兜底」走 `collectSchedulerStatus`。
 */
export function buildSchedulerStatus(input: SchedulerStatusInput): SchedulerStatus {
	return {
		ok: true,
		enabled: input.enabled,
		tickets: {
			// Infinity（不限）不能直接进 JSON：JSON.stringify 会写成 null，前端读到的
			// 是"没有上限"还是"没这个字段"就分不清了。用 null 显式表示不限。
			max: Number.isFinite(input.tickets.max) ? input.tickets.max : null,
			active: input.tickets.active,
			queued: input.tickets.queued,
			// 空表不出现这个键：前端 / 人看都是「没有领域占用」，而不是 `domains: {}`。
			...(input.tickets.domains && Object.keys(input.tickets.domains).length > 0
				? { domains: { ...input.tickets.domains } }
				: {}),
		},
		lanes: input.lanes.map((lane) => ({
			lane: lane.lane,
			cap: lane.cap,
			running: lane.running,
			queued: lane.queued,
			cooldownUntil: isoOrNull(lane.cooldownUntil),
		})),
		pool:
			input.pool === null
				? null
				: {
						slots: input.pool.slots.map((slot) => ({
							index: slot.index,
							pid: slot.pid,
							port: slot.port,
							ticketId: slot.ticketId === null ? null : shortTicketId(slot.ticketId),
							finishedTickets: slot.finishedTickets,
							rssMb: slot.rssMb,
						})),
						running: input.pool.running.map(shortTicketId),
					},
	};
}

/** 观测层的票据队列口径：读不到时给空队列（前端只消费 queued，不据此判断容量）。 */
const EMPTY_TICKETS: AdmissionSnapshot = { max: 0, active: 0, queued: 0 };

export interface SchedulerStatusSources {
	enabled: boolean;
	tickets: () => AdmissionSnapshot;
	lanes: () => readonly SchedulerLaneSnapshot[];
	pool: () => SchedulerPoolSnapshot | null;
}

/**
 * 端点用的收集器：三份快照各自兜错。
 * 观测接口的原则是「读不到就少显示一段」，而不是让任务中心因为一个旁路快照失败整页报错。
 */
export function collectSchedulerStatus(sources: SchedulerStatusSources): SchedulerStatus {
	return buildSchedulerStatus({
		enabled: sources.enabled,
		tickets: readOr(sources.tickets, EMPTY_TICKETS),
		lanes: readOr(sources.lanes, []),
		pool: readOr(sources.pool, null),
	});
}

/** 只给前 8 位：观测够用，完整票号不从这个端点外泄。 */
function shortTicketId(ticketId: string): string {
	return String(ticketId).slice(0, 8);
}

/** epoch ms → ISO；null / 非法值 / 超出 Date 范围一律 null（JSON 里就是「没冷却」）。 */
function isoOrNull(ms: number | null): string | null {
	if (ms === null || !Number.isFinite(ms)) return null;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readOr<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

/**
 * CHANCELLOR_SCHEDULER 是否开：默认开，只有显式 false / 0 / no / off 才关。
 * 口径必须与 lane.ts / admission.ts 的私有 schedulingEnabled 一致；那边没有导出，
 * 这里按同一规则重写一遍（只读一行 env，不复制任何闸门逻辑）。
 */
export function schedulerEnabledFromEnv(): boolean {
	const raw = process.env.CHANCELLOR_SCHEDULER;
	if (raw === undefined) return true;
	const value = raw.trim().toLowerCase();
	if (value === "") return true;
	return !["false", "0", "no", "off"].includes(value);
}
