/**
 * 自主跟进的纯核（2026-11-05 批次C C1）。
 *
 * 防风暴三件套的账本部分（cindy bot-autonomy 同款）：
 *   - 事件 id 含"状态进入时刻"（观察层给），同一状态只提醒一次，跨重启稳定；
 *   - 同会话同类型 24h 内最多 6 次，第 7 次起只记日志（occurrence 由调用方记）；
 *   - sweep 按 2h 时间桶分 id。
 *
 * 单独成文件的原因：autonomy.ts 连着 agent/approvals 的装配链，import 它等于
 * 顺手建库——账本必须能无副作用地单测（与 cron.ts 同一纪律）。
 */

export type AutonomyEventType = "stuck" | "waiting" | "errored" | "usage-limit" | "sweep";

/** 同会话同类型 24h 内的提醒上限（cindy 实测值照抄） */
export const AUTONOMY_CAP_PER_DAY = 6;
/** sweep 的时间桶（同一桶一次） */
export const SWEEP_BUCKET_MS = 2 * 60 * 60_000;

export interface AutonomyEventShape {
	type: AutonomyEventType;
	conversationId: number;
	/** 状态进入时刻（epoch 毫秒）或 waiting 的 callId —— id 跨重启稳定的锚 */
	key: string;
}

/**
 * 事件 id：`类型:会话:状态锚`。sweep 用 2h 时间桶当锚（同一桶一次）。
 */
export function autonomyEventId(event: AutonomyEventShape, now: Date = new Date()): string {
	if (event.type === "sweep") {
		const bucket = Math.floor(now.getTime() / SWEEP_BUCKET_MS);
		return `sweep:${event.conversationId}:${bucket}`;
	}
	return `${event.type}:${event.conversationId}:${event.key}`;
}

/** 回执账本：事件 id 去重 + 每日上限。可序列化（.data/autonomy-state.json）。 */
export class AutonomyReceipts {
	private receipts: Record<string, string>;
	private caps: Record<string, number[]>;

	constructor(
		initial: { receipts?: Record<string, string>; caps?: Record<string, number[]> } = {},
		private readonly now: () => Date = () => new Date(),
	) {
		this.receipts = { ...(initial.receipts ?? {}) };
		this.caps = {};
		for (const [key, times] of Object.entries(initial.caps ?? {})) {
			if (Array.isArray(times)) this.caps[key] = [...times];
		}
	}

	/** 是否应该提醒：事件 id 没见过 && 该 (类型,会话) 24h 内没到上限。 */
	shouldRemind(event: AutonomyEventShape): boolean {
		const id = autonomyEventId(event, this.now());
		if (this.receipts[id] !== undefined) return false;
		const at = this.now().getTime();
		const capKey = `${event.type}:${event.conversationId}`;
		const times = (this.caps[capKey] ?? []).filter((t) => at - t < 24 * 60 * 60_000);
		if (times.length >= AUTONOMY_CAP_PER_DAY) return false;
		return true;
	}

	/** 记账（提醒真的发出去之后才调）。 */
	record(event: AutonomyEventShape): void {
		const at = this.now();
		this.receipts[autonomyEventId(event, at)] = at.toISOString();
		const capKey = `${event.type}:${event.conversationId}`;
		const times = (this.caps[capKey] ?? []).filter(
			(t) => at.getTime() - t < 24 * 60 * 60_000,
		);
		times.push(at.getTime());
		this.caps[capKey] = times;
		// 回执窗口修剪：账本有界
		for (const [id, iso] of Object.entries(this.receipts)) {
			if (Date.parse(iso) < at.getTime() - 48 * 60 * 60_000) delete this.receipts[id];
		}
	}

	toJSON(): { receipts: Record<string, string>; caps: Record<string, number[]> } {
		return { receipts: this.receipts, caps: this.caps };
	}
}
