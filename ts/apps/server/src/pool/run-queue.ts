import type { EscalationInput } from "./pool-tools.ts";

/**
 * 池进程的长度 1 队列（设计文档 §4.3「隔离单位 = 活跃会话」、§5.2 IPC 契约）。
 *
 * 纯状态机：不碰 IO、不碰 Harness。真正跑一票的 `runTicket` 由装配层注入，
 * 单测塞 fake。每个池进程同一时刻最多一个 runner 在跑，结束（成功 / 抛错）后自动拉下一票。
 *
 * 事件流按票缓冲：`subscribe` 先同步回放缓冲、再接实时推送，因此「先 /run 后连 SSE」
 * 也不丢前面的 progress。结算后缓冲仍保留，晚连的订阅者还能看到 `settled`。
 */

/** 一票的事件。SSE 按顺序推给宿主，同时进缓冲供后连的订阅者回放。 */
export type TicketEvent =
	| { type: "progress"; message: string }
	| { type: "escalation"; escalation: EscalationInput & { escalationId: string } }
	| { type: "report"; raw: string }
	| { type: "settled"; ok: boolean; reason: string };

export interface QueuedRun {
	ticketId: string;
	dir: string;
	workDir: string;
	instruction: string;
	doneWhen: string;
	upstream?: string;
	model?: string;
	/**
	 * 这一票用哪个供应商端点（2026-11-19 模型分工的同一条 route，2026-11-22 补到池）：
	 * `baseUrl` 给池内 provider，`keyEnv` 只是变量名——池进程从自己的 env 里取 key，
	 * 密钥本身不过 HTTP、不进日志。
	 */
	modelRoute?: { baseUrl: string; keyEnv: string };
	tools?: string[];
}

/** runner 拿到的一票的运行时把手。 */
export interface RunHandle {
	emit: (event: TicketEvent) => void;
	/** 取消信号：abort 时必须让 runner 停下 */
	signal: AbortSignal;
	/** runner 收话（对应 `say()`）；返回退订函数。 */
	onSay: (listener: (text: string, mode: "steer" | "followUp") => void) => () => void;
}

export type RunResult = { ok: true } | { ok: false; reason: string };

export interface RunQueueOptions {
	/** 队列上限（不含正在跑的那一票），默认 64 */
	maxQueue?: number;
	/** 每票缓冲多少条事件供回放，默认 200 */
	eventBuffer?: number;
	runTicket: (run: QueuedRun, handle: RunHandle) => Promise<RunResult>;
	/** 可注入时钟，默认 Date.now（单测不用） */
	now?: () => number;
}

export type EnqueueResult =
	| { accepted: true; ticketId: string; queued: number }
	| { accepted: false; reason: "queue_full" | "duplicate" };

export interface QueueSnapshot {
	activeTicket: string | null;
	queued: string[];
	finishedTickets: number;
}

/** 默认队列上限，只算排队、不算正在跑的那一票。 */
const DEFAULT_MAX_QUEUE = 64;
/** 默认每票缓冲条数。 */
const DEFAULT_EVENT_BUFFER = 200;
/**
 * 已结算票的缓冲保留上限。超了淘汰最老的已结算票——
 * 晚连的 SSE 仍能回放最近这些票，内存又有界。正在跑 / 排队中的票永不淘汰。
 */
export const MAX_RETAINED_SETTLED = 64;
/** 失败原因摘要上限，避免把上游长文塞进事件。 */
const MAX_REASON_CHARS = 200;

interface TicketRecord {
	readonly run: QueuedRun;
	readonly events: TicketEvent[];
	readonly listeners: Set<(event: TicketEvent) => void>;
	readonly sayListeners: Set<(text: string, mode: "steer" | "followUp") => void>;
	settled: boolean;
	controller?: AbortController;
}

function truncateReason(reason: string): string {
	if (reason.length <= MAX_REASON_CHARS) return reason;
	return `${reason.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function summarizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return truncateReason(message || "runner failed");
}

export class RunQueue {
	private readonly maxQueue: number;
	private readonly eventBuffer: number;
	private readonly runTicket: RunQueueOptions["runTicket"];

	private readonly records = new Map<string, TicketRecord>();
	private readonly queue: TicketRecord[] = [];
	/** 已结算票，按结算顺序；用于淘汰最老的缓冲。 */
	private readonly retainedSettled: TicketRecord[] = [];
	private readonly idleWaiters: Array<() => void> = [];

	private active: TicketRecord | null = null;
	private finished = 0;

	constructor(options: RunQueueOptions) {
		this.maxQueue = Math.max(0, options.maxQueue ?? DEFAULT_MAX_QUEUE);
		this.eventBuffer = Math.max(1, options.eventBuffer ?? DEFAULT_EVENT_BUFFER);
		this.runTicket = options.runTicket;
	}

	enqueue(run: QueuedRun): EnqueueResult {
		const existing = this.records.get(run.ticketId);
		if (existing && !existing.settled) {
			return { accepted: false, reason: "duplicate" };
		}
		// 已结算过的票允许重派：丢掉旧缓冲，按新票重新开始。
		if (existing) {
			this.records.delete(run.ticketId);
			const index = this.retainedSettled.indexOf(existing);
			if (index >= 0) this.retainedSettled.splice(index, 1);
		}
		if (this.queue.length >= this.maxQueue) {
			return { accepted: false, reason: "queue_full" };
		}
		const record: TicketRecord = {
			run,
			events: [],
			listeners: new Set(),
			sayListeners: new Set(),
			settled: false,
		};
		this.records.set(run.ticketId, record);
		this.queue.push(record);
		this.pump();
		return { accepted: true, ticketId: run.ticketId, queued: this.queue.length };
	}

	/** 订阅一票的事件流；先回放缓冲，再实时推。返回退订函数。 */
	subscribe(ticketId: string, listener: (event: TicketEvent) => void): () => void {
		const record = this.records.get(ticketId);
		if (!record) return () => {};
		for (const event of record.events) {
			this.safeCall(() => listener(event));
		}
		if (record.settled) return () => {};
		record.listeners.add(listener);
		return () => {
			record.listeners.delete(listener);
		};
	}

	/** 插话：转给正在跑的那一票；不在跑返回 ok:false */
	say(ticketId: string, text: string, mode: "steer" | "followUp" = "steer"): { ok: boolean; message?: string } {
		const record = this.records.get(ticketId);
		if (!record || record.settled || this.active !== record) {
			return { ok: false, message: `票 ${ticketId} 当前不在跑` };
		}
		for (const listener of [...record.sayListeners]) {
			this.safeCall(() => listener(text, mode));
		}
		return { ok: true };
	}

	/** 中止：正在跑的 → abort signal；还在排队的 → 直接移出队列并结算为 settled(false) */
	abort(ticketId: string): { ok: boolean; message?: string } {
		const record = this.records.get(ticketId);
		if (!record || record.settled) {
			return { ok: false, message: `票 ${ticketId} 不在跑也不在队列` };
		}
		if (this.active === record) {
			// runner 的 settled 仍是权威：这里只发信号，不提前结算。
			record.controller?.abort();
			return { ok: true };
		}
		this.settle(record, false, "aborted");
		return { ok: true };
	}

	snapshot(): QueueSnapshot {
		return {
			activeTicket: this.active?.run.ticketId ?? null,
			queued: this.queue.map((record) => record.run.ticketId),
			finishedTickets: this.finished,
		};
	}

	/** 等队列彻底空掉（单测用） */
	idle(): Promise<void> {
		if (this.isIdle()) return Promise.resolve();
		return new Promise((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	private pump(): void {
		if (this.active) return;
		const next = this.queue.shift();
		if (!next) return;
		this.start(next);
	}

	private start(record: TicketRecord): void {
		this.active = record;
		const controller = new AbortController();
		record.controller = controller;
		const handle: RunHandle = {
			emit: (event) => {
				// settled 的发布权归队列：runner 晚到的尾巴一律忽略。
				if (record.settled || event.type === "settled") return;
				this.pushEvent(record, event);
			},
			signal: controller.signal,
			onSay: (listener) => {
				record.sayListeners.add(listener);
				return () => {
					record.sayListeners.delete(listener);
				};
			},
		};
		void (async () => {
			try {
				const result = await this.runTicket(record.run, handle);
				if (controller.signal.aborted) {
					this.settle(record, false, "aborted");
					return;
				}
				if (result.ok) {
					this.settle(record, true, "done");
				} else {
					this.settle(record, false, result.reason || "failed");
				}
			} catch (error) {
				this.settle(record, false, controller.signal.aborted ? "aborted" : summarizeError(error));
			}
		})();
	}

	private settle(record: TicketRecord, ok: boolean, reason: string): void {
		if (record.settled) return;
		record.settled = true;
		const event: TicketEvent = { type: "settled", ok, reason: truncateReason(reason) };
		this.pushEvent(record, event);
		if (ok) this.finished += 1;
		if (this.active === record) this.active = null;
		const index = this.queue.indexOf(record);
		if (index >= 0) this.queue.splice(index, 1);
		this.retainedSettled.push(record);
		this.evictSettled();
		this.pump();
		this.checkIdle();
	}

	private pushEvent(record: TicketRecord, event: TicketEvent): void {
		record.events.push(event);
		const overflow = record.events.length - this.eventBuffer;
		if (overflow > 0) record.events.splice(0, overflow);
		for (const listener of [...record.listeners]) {
			this.safeCall(() => listener(event));
		}
		if (event.type === "settled") record.listeners.clear();
	}

	private evictSettled(): void {
		while (this.retainedSettled.length > MAX_RETAINED_SETTLED) {
			const oldest = this.retainedSettled.shift();
			if (!oldest) break;
			if (this.records.get(oldest.run.ticketId) === oldest) {
				this.records.delete(oldest.run.ticketId);
			}
		}
	}

	private isIdle(): boolean {
		return this.active === null && this.queue.length === 0;
	}

	private checkIdle(): void {
		if (!this.isIdle()) return;
		for (const resolve of this.idleWaiters.splice(0)) resolve();
	}

	private safeCall(fn: () => void): void {
		try {
			fn();
		} catch {
			// 订阅者异常不能反噬队列状态机。
		}
	}
}