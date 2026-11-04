import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	AUTONOMY_CAP_PER_DAY,
	AutonomyReceipts,
	autonomyEventId,
	type AutonomyEventShape,
	type AutonomyEventType,
} from "./autonomy-core.ts";
import { classifyUnanswered } from "./model-chain.ts";
import { watchAllEvents, sayInConversation, type GlobalAgentEvent } from "./agent.ts";
import { watchAllDelegationEvents, type DelegationEvent } from "./delegation.ts";
import { approvalStore } from "./approvals.ts";
import { partnersStore } from "./partners.ts";

/**
 * 任务观察层（2026-11-05 批次C C1）。
 *
 * 纯程序级：盯全局事件口（phase/tool/delegation）+ 轮次结算 + 审批 pending，
 * 五类事件（stuck / waiting / errored / usage-limit / sweep）——**没有 finished**：
 * 本仓库没有"模型报交付"机制，聊天轮次 done ≠ 交付（会把你每次的日常回答都当事件），
 * 派单终态的"已完成"汇报由 formatReport 写会话，观察层只结清状态不重复提醒。
 *
 * 提醒 = `sayInConversation` 写会话行（桌面/手机拉 transcript 可见），**不经模型**；
 * 文案枚举化（≤140 字），不含对话内容与工具参数（D8：上游原文可能带 key 片段）。
 *
 * 防自叫醒（cindy 的头号坑）：**伙伴会话（含例行专线）一律不是观察对象**——
 * 伙伴出错再提醒伙伴就是自己叫醒自己。v1 没有跟进者，观察对象只剩主人会话。
 *
 * 总开关 `AUTONOMY_ENABLED` 默认 false：false 时 observe() 不订阅、账本不建、
 * sweep 定时器不启、自主轮标记不生效——全部行为为零。
 */

const DEFAULT_STATE_PATH = ".data/autonomy-state.json";
/** stuck：working 持续无活动（cindy 10min） */
const STUCK_MS = 10 * 60_000;
/** 前台工具在途时的放宽（cindy 45min：bash 长任务是合法的） */
const TOOL_IN_FLIGHT_STUCK_MS = 45 * 60_000;
/** waiting：审批挂起超过 5 分钟才算"等你" */
const WAITING_MS = 5 * 60_000;
/** sweep 兜底扫描间隔 */
const SWEEP_TICK_MS = 30_000;
/** 提醒行上限（formatReport ≤80 字的同族口径，这里给观察行 140） */
const REMIND_LIMIT = 140;

export function autonomyEnabled(): boolean {
	const raw = process.env.AUTONOMY_ENABLED?.trim().toLowerCase();
	if (!raw) return false;
	return raw !== "false" && raw !== "0";
}

function stuckTimeoutMs(): number {
	const raw = Number(process.env.AUTONOMY_STUCK_MIN_S);
	return Number.isFinite(raw) && raw > 0 ? raw * 1000 : STUCK_MS;
}

interface ConversationWatch {
	lastActivityAt: number;
	/** working 阶段的进入时刻（thinking/working 切换重置） */
	workingSince: number | null;
	/** 在途工具的起始时刻（tool start 无 end） */
	toolInFlightSince: number | null;
}

class AutonomyObserver {
	private receipts = new AutonomyReceipts();
	private watches = new Map<number, ConversationWatch>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private subscribed = false;

	subscribe(): void {
		if (this.subscribed || !autonomyEnabled()) return;
		this.subscribed = true;
		this.load();
		watchAllEvents((event) => this.onAgentEvent(event));
		watchAllDelegationEvents((event, conversationId) => this.onDelegationEvent(event, conversationId));
	}

	/** 轮次结算（index.ts 的 onSettled 处喂进来）：errored / usage-limit 两类的事件源。 */
	onTurnSettled(conversationId: number, status: string, reason: string): void {
		if (!autonomyEnabled() || !this.subscribed) return;
		if (this.excluded(conversationId)) return;
		if (status !== "unanswered") {
			// 正常结束：清 stuck 观察态（本轮有结论了）
			this.watches.delete(conversationId);
			return;
		}
		const type: AutonomyEventType = /429|rate.?limit|quota|exceeded|overloaded/i.test(reason)
			? "usage-limit"
			: "errored";
		const detail =
			type === "usage-limit"
				? "模型用量受限（配额/容量），稍后再试或换候选模型"
				: "上一轮没有生成回复（上游出错），需要的话重新发送";
		this.remind({ type, conversationId, key: String(Date.now()) }, detail);
	}

	// ── 事件入口 ──
	private onAgentEvent(event: GlobalAgentEvent): void {
		if (this.excluded(event.conversationId)) return;
		const watch = this.watches.get(event.conversationId) ?? {
			lastActivityAt: Date.now(),
			workingSince: null,
			toolInFlightSince: null,
		};
		watch.lastActivityAt = Date.now();
		if (event.kind === "phase") {
			watch.workingSince = event.phase === "working" ? Date.now() : null;
			if (event.phase === "thinking") watch.toolInFlightSince = null;
		} else if (event.kind === "tool") {
			if (event.tool?.status === "start") watch.toolInFlightSince = Date.now();
			else watch.toolInFlightSince = null;
		}
		this.watches.set(event.conversationId, watch);
		this.syncSweepTimer();
	}

	private onDelegationEvent(event: DelegationEvent, conversationId: number): void {
		if (this.excluded(conversationId)) return;
		if (event.type === "delegate" && event.phase === "failed") {
			this.remind(
				{ type: "errored", conversationId, key: event.ticketId || String(Date.now()) },
				`派单失败：任务 ${event.ticketId || "(受理中)"} 未能完成`,
			);
		}
		// done：formatReport 已写"已完成"，这里只结清观察态，不重复提醒
		if (event.type === "delegate" && event.phase === "done") {
			this.watches.delete(conversationId);
		}
	}

	// ── sweep ──
	private needsSweep(): boolean {
		if (this.watches.size > 0) return true;
		// 有挂着的审批也值得扫（waiting 事件的来源）
		try {
			return approvalStore().pendingRecords().length > 0;
		} catch {
			return false;
		}
	}

	private syncSweepTimer(): void {
		if (this.needsSweep() && this.timer === null) {
			this.timer = setInterval(() => this.sweep(), SWEEP_TICK_MS);
			this.timer.unref?.();
		} else if (!this.needsSweep() && this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private sweep(): void {
		if (!autonomyEnabled()) return;
		// 没有观察对象也没有挂审批：定时器按需存在（批次C细化 §3.2），清掉
		if (!this.needsSweep()) {
			if (this.timer !== null) {
				clearInterval(this.timer);
				this.timer = null;
			}
			return;
		}
		const now = Date.now();
		for (const [conversationId, watch] of this.watches) {
			if (this.excluded(conversationId)) continue;
			const stuckLimit = watch.toolInFlightSince !== null ? TOOL_IN_FLIGHT_STUCK_MS : stuckTimeoutMs();
			const workingMs = watch.workingSince !== null ? now - watch.workingSince : 0;
			if (workingMs > stuckLimit) {
				this.remind(
					{ type: "stuck", conversationId, key: String(watch.workingSince) },
					`任务可能卡住了：已经持续动手超过 ${Math.round(stuckLimit / 60_000)} 分钟没有新进展`,
				);
			}
		}
		// waiting：审批 pending 超过 5 分钟（id = waiting:callId，跨重启稳定）
		try {
			for (const pending of approvalStore().pendingRecords()) {
				if (now - pending.createdAt < WAITING_MS) continue;
				this.remind(
					{ type: "waiting", conversationId: pending.conversationId, key: pending.callId },
					`有一项工具调用等你批准：${pending.tool}`,
				);
			}
		} catch {
			// 审批 store 不可用不挡 sweep
		}
		// sweep 兜底：有未结清状态时按 2h 桶提醒一次汇总
		if (this.watches.size > 0) {
			this.remind(
				{ type: "sweep", conversationId: 0, key: "" },
				`有 ${this.watches.size} 个会话仍在动手，没人看管；不需要的话可以停掉对应任务`,
				0,
			);
		}
	}

	// ── 提醒 ──
	private remind(event: AutonomyEventShape, detail: string, conversationIdOverride?: number): void {
		if (!this.receipts.shouldRemind(event)) return;
		this.receipts.record(event);
		this.save();
		const target = conversationIdOverride ?? event.conversationId;
		if (target <= 0) return; // sweep 汇总行没落点时只记账
		const text = `【需要你】${detail}`.slice(0, REMIND_LIMIT);
		void sayInConversation(target, text).catch(() => {
			// 写不进去（会话没了）就算了：账已记，不重试不报错
		});
	}

	/** 防自叫醒：伙伴会话不是观察对象；观察层 v1 只盯主人会话。 */
	private excluded(conversationId: number): boolean {
		try {
			return partnersStore().partnerIdOfSession(conversationId) !== null;
		} catch {
			return false;
		}
	}

	// ── 状态落盘（原子写；坏文件当空账）──
	private load(): void {
		const path = process.env.AUTONOMY_STATE_PATH?.trim() || DEFAULT_STATE_PATH;
		if (!existsSync(path)) return;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				receipts?: Record<string, string>;
				caps?: Record<string, number[]>;
			};
			this.receipts = new AutonomyReceipts(parsed);
		} catch {
			this.receipts = new AutonomyReceipts();
		}
	}

	private save(): void {
		const path = process.env.AUTONOMY_STATE_PATH?.trim() || DEFAULT_STATE_PATH;
		try {
			mkdirSync(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.receipts.toJSON()), "utf8");
			try {
				renameSync(tmp, path);
			} catch {
				try {
					if (existsSync(tmp)) rmSync(tmp, { force: true });
				} catch {
					/* 清理失败就算了 */
				}
			}
		} catch {
			// 账本写不进去不挡提醒（提醒是即时的，账丢了最多 24h 内多提醒一次）
		}
	}

	/** 测试与排查用：当前观察态快照。 */
	snapshot(): { watches: number; receipts: ReturnType<AutonomyReceipts["toJSON"]> } {
		return { watches: this.watches.size, receipts: this.receipts.toJSON() };
	}

	/** 测试注入：清空观察态。 */
	resetForTest(): void {
		this.watches.clear();
		this.receipts = new AutonomyReceipts();
	}
}

// ── 单例（observe() 在 index.ts 启动时调）────────────────
let observer: AutonomyObserver | null = null;

export function autonomyObserver(): AutonomyObserver {
	observer ??= new AutonomyObserver();
	return observer;
}

export const AUTONOMY_MAX_PER_DAY = AUTONOMY_CAP_PER_DAY;
export { autonomyEventId };
