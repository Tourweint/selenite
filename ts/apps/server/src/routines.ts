import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineTask } from "@earendil-works/pi-durable";
import type { GlobalAgentEvent } from "./agent.ts";
import { watchAllDelegationEvents, type DelegationEvent } from "./delegation.ts";
import {
	COMPANIONS_ENABLED,
	partnersStore,
	type RoutineDef,
	type RoutineTrigger,
} from "./partners.ts";
import { ensurePartnerSession, runPartnerTurn } from "./partner-runtime.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/**
 * 例行任务引擎（2026-11-05 批次B B3）。
 *
 * **架构适配（与 cindy 的关键差异）**：cindy 的 RoutineEngine 用自转 tick 循环做 cron 比对；
 * 本仓库 `系统架构.md` §3 刻意没有"定时扫描型 cron（用 durable 的 sleepUntil）"。
 * 所以这里只移植它的纯逻辑内核（回执去重 / 单规则串行 / deferred / 状态机 / 中断不重放），
 * **触发层全部换血为 durable 任务**（`RoutineTask`，范式 = reminder.ts）：
 *   - 到点 = durable 任务醒来（睡眠状态落库，重启照样响）；
 *   - 醒来先对 revision：对不上（规则被改/停/删）就作废——没有"取消任务"API 的替代；
 *   - 响完在 deliver 的同一个事务里排下一个任务，链就续上了。
 *
 * 事件触发走进程内全局事件口（watchAllEvents / watchAllDelegationEvents）：
 * 24h 回执去重 + `originRoutineId` 防自环（v1 实现：**执事自己会话发出的事件一律不触发**——
 * 执事事件只可能来自自主轮，让它再唤醒例行任务是自环的根）。
 *
 * 可靠性铁律（照抄 cindy 踩坑产物）：
 *   - 同一规则串行（上一次没跑完，下一次标 deferred 等待）；
 *   - 终态落盘失败期间后续触发只能排队不能执行（宁可漏跑不可丢账）；
 *   - 重启时 running 一律 interrupted，**不自动重放**（外部副作用无法断言是否已发生）。
 */

const DEFAULT_STATE_PATH = ".data/routines.json";
const PROMPT_LIMIT = 100_000;
/** 执行历史最多留多少条（状态文件有界） */
const RUN_HISTORY_LIMIT = 50;
/** deferred 重试间隔（执事忙/上一轮没跑完） */
const DEFERRED_RETRY_MS = 30_000;
/** 回执去重窗口 */
const RECEIPT_TTL_MS = 24 * 60 * 60_000;

export interface RoutineRunRecord {
	id: string;
	routineId: string;
	partnerId: string;
	/** queued 不落盘（内存里等）；落盘的都是终态或在跑 */
	status: "running" | "success" | "failed" | "interrupted" | "skipped";
	trigger: string;
	startedAt: string;
	endedAt?: string;
	/** 结果摘要（≤200 字，枚举口径：不给正文） */
	summary?: string;
	error?: string;
}

interface RoutineState {
	version: 1;
	/** 回执：key → 最近一次时间（ISO）。24h 滑窗清理。 */
	receipts: Record<string, string>;
	runs: RoutineRunRecord[];
	/** 每规则"最近一次开始跑"的标记：重启后 running → interrupted 的判定依据 */
	running: Record<string, { runId: string; startedAt: string }>;
}

function emptyState(): RoutineState {
	return { version: 1, receipts: {}, runs: [], running: {} };
}

// ── durable 任务：alarm-only ─────────────────────────────
export interface RoutineTaskInput {
	routineId: string;
	/** 计划触发时刻（epoch 毫秒），回执去重的 key 之一 */
	fireAt: number;
	/** 建任务时的规则版本；醒来对不上号 = 规则已被改/停/删，作废 */
	revision: number;
}

/**
 * 到点即响的闹钟任务。**模型执行不在这事务里**——deliver 只负责：
 * ① 触发引擎（fire-and-forget，跑在任务图外）；② 排下一个任务；③ 本任务终态。
 * 长跑放任务图里会把会话的任务队列堵死（一次模型执行几分钟），这是刻意的。
 */
export const RoutineTask = defineTask<RoutineTaskInput, { phase: "wait" } | { phase: "deliver" }, string>({
	name: "lifediary.routine",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, context) =>
			runtime.sleepUntil(task.input.fireAt, { phase: "deliver" }, context),
		deliver: async (task, runtime, context) => {
			const engine = routineEngine();
			const routine = partnersStore().getRoutine(task.input.routineId);
			const stillValid =
				routine !== null && routine.enabled && routine.revision === task.input.revision;
			await runtime.commit(
				async (tx) => {
					if (stillValid) {
						// 先排下一个，再触发本次：崩在中间最多漏一次触发，不会断链
						const next = await engine.nextFireFrom(routine);
						if (next) {
							await tx.createTask(
								RoutineTask,
								{ routineId: routine.id, fireAt: next.getTime(), revision: routine.revision },
								{ ownership: { kind: "conversation" } },
							);
						}
					}
					return {
						status: "terminal",
						outcome: { status: "completed", result: stillValid ? "fired" : "stale" },
					};
				},
				context,
			);
			if (stillValid) {
				void engine.fire(routine, `定时（${new Date(task.input.fireAt).toISOString()}）`, `alarm:${task.input.routineId}:${task.input.fireAt}`);
			}
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

// cron 判定抽在 cron.ts（纯文件可测，见文件头说明）
import { cronMatches, nextCronFire } from "./cron.ts";

// ── 引擎 ─────────────────────────────────────────────────
class RoutineEngine {
	private state: RoutineState = emptyState();
	private stateLoaded = false;
	private readonly statePath =
		process.env.ROUTINES_STATE_PATH?.trim() || DEFAULT_STATE_PATH;
	/** 每规则一条串行 lane：上一次没跑完，本次 deferred */
	private lanes = new Map<string, Promise<void>>();
	/** deferred 等待中的再触发（lane 清空后执行） */
	private deferred = new Map<string, Array<{ trigger: string; dedupeKey: string }>>();
	private subscribed = false;

	// ── 状态文件（原子写；坏文件当空账）──
	private load(): RoutineState {
		if (this.stateLoaded) return this.state;
		this.stateLoaded = true;
		if (!existsSync(this.statePath)) return this.state;
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<RoutineState>;
			this.state = {
				version: 1,
				receipts: parsed.receipts && typeof parsed.receipts === "object" ? parsed.receipts : {},
				runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-RUN_HISTORY_LIMIT) : [],
				running: parsed.running && typeof parsed.running === "object" ? parsed.running : {},
			};
		} catch {
			this.state = emptyState();
		}
		return this.state;
	}

	private save(): void {
		// 终态落盘失败是**全局红灯**：后续触发只能排队不能执行（cindy 铁律）。
		// 这里用"抛给调用方"表达——fire() 捕获后把本次触发放回 deferred。
		mkdirSync(dirname(this.statePath), { recursive: true });
		const tmp = `${this.statePath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.state), "utf8");
		try {
			renameSync(tmp, this.statePath);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* 清理失败就算了 */
			}
			throw error;
		}
	}

	/** 回执窗口清理 + 终态记账。 */
	private rememberReceipt(key: string): void {
		const state = this.load();
		const now = Date.now();
		state.receipts[key] = new Date(now).toISOString();
		for (const [k, at] of Object.entries(state.receipts)) {
			if (Date.parse(at) < now - RECEIPT_TTL_MS) delete state.receipts[k];
		}
	}

	private receiptLive(key: string): boolean {
		const state = this.load();
		const at = state.receipts[key];
		return typeof at === "string" && Date.parse(at) > Date.now() - RECEIPT_TTL_MS;
	}

	private recordRun(record: RoutineRunRecord): void {
		const state = this.load();
		state.runs.push(record);
		if (state.runs.length > RUN_HISTORY_LIMIT) {
			state.runs.splice(0, state.runs.length - RUN_HISTORY_LIMIT);
		}
		this.save();
	}

	// ── 订阅 ──
	/** 启动时调一次：接全局事件口 + 结算上一进程留下的 running。 */
	subscribe(): void {
		if (this.subscribed || !COMPANIONS_ENABLED) return;
		this.subscribed = true;
		const state = this.load();
		// 重启结算：running → interrupted，不自动重放（外部副作用无法断言）
		for (const [routineId, mark] of Object.entries(state.running)) {
			state.runs.push({
				id: mark.runId,
				routineId,
				partnerId: partnersStore().getRoutine(routineId)?.partnerId ?? "",
				status: "interrupted",
				trigger: "（上一进程遗留）",
				startedAt: mark.startedAt,
				endedAt: new Date().toISOString(),
				summary: "进程重启时仍在跑，按中断收口（不自动重放）",
			});
			delete state.running[routineId];
		}
		this.save();

		watchAllDelegationEvents((event, conversationId) => {
			this.onExternalEvent(conversationId, "delegation", delegateEventFields(event));
		});
		// phase/tool 的全局口在 agent.ts；动态 import 会造成环，改为注入——见 index.ts 装配
	}

	/** agent.ts 的 phase/tool 事件从这里喂进来（index.ts 装配，避免 routines → agent 循环导入）。 */
	onAgentEvent(event: GlobalAgentEvent): void {
		this.onExternalEvent(event.conversationId, event.kind, event.kind === "tool"
			? { name: event.tool?.name ?? "", status: event.tool?.status ?? "" }
			: { phase: event.phase ?? "" });
	}

	/** 事件触发：防自环（执事会话的事件一律不触发）+ 回执去重 + 匹配规则。 */
	private onExternalEvent(
		conversationId: number,
		kind: "delegation" | "tool" | "phase",
		fields: Record<string, string>,
	): void {
		if (!COMPANIONS_ENABLED || !this.subscribed) return;
		// 防自环：执事会话（含例行专线）发出的事件不再触发例行任务
		if (partnersStore().partnerIdOfSession(conversationId) !== null) return;

		for (const routine of partnersStore().listRoutines()) {
			if (!routine.enabled) continue;
			for (const trigger of routine.triggers) {
				if (trigger.type !== "event" || trigger.kind !== kind) continue;
				const match = trigger.match ?? {};
				const matched = Object.entries(match).every(
					([key, value]) => (fields[key] ?? "") === value,
				);
				if (!matched) continue;
				// 去重 key：规则 + 触发形状 + 来源会话 + 分钟桶（同一分钟的同形事件只算一次）
				const minute = Math.floor(Date.now() / 60_000);
				const dedupeKey = `evt:${routine.id}:${kind}:${JSON.stringify(match)}:${conversationId}:${minute}`;
				if (this.receiptLive(dedupeKey)) continue;
				this.rememberReceipt(dedupeKey);
				void this.fire(routine, `事件（${kind}）`, dedupeKey);
			}
		}
	}

	// ── 调度 ──
	/** 从现在起的下一次触发（cron / interval / once）。事件触发器不参与定时。 */
	async nextFireFrom(routine: RoutineDef, from: Date = new Date()): Promise<Date | null> {
		let best: Date | null = null;
		for (const trigger of routine.triggers) {
			let candidate: Date | null = null;
			if (trigger.type === "cron") {
				candidate = nextCronFire(trigger.expr, from);
			} else if (trigger.type === "interval") {
				const seconds = Math.max(60, Math.floor(trigger.seconds));
				candidate = new Date(from.getTime() + seconds * 1000);
			} else if (trigger.type === "once") {
				const at = new Date(trigger.at);
				candidate = at > from ? at : null;
			}
			if (candidate && (best === null || candidate < best)) best = candidate;
		}
		return best;
	}

	/**
	 * 给规则排定时任务（启用/创建/改期时调用）。挂在执事主会话的任务图上——
	 * 例行任务跟着会话走，会话在任务就在。
	 */
	async ensureScheduled(routineId: string): Promise<void> {
		if (!COMPANIONS_ENABLED) return;
		const routine = partnersStore().getRoutine(routineId);
		if (!routine || !routine.enabled) return;
		const next = await this.nextFireFrom(routine);
		if (!next) return;
		const chat = await ensurePartnerSession(routine.partnerId);
		if (!chat) throw new Error("执事会话取不到，例行任务排不上");
		await chat.conversation.commit(
			(tx) =>
				tx.createTask(
					RoutineTask,
					{ routineId, fireAt: next.getTime(), revision: routine.revision },
					{ ownership: { kind: "conversation" } },
				),
			CTX,
		);
	}

	// ── 执行 ──
	/** 触发一次（lane 串行 + 回执去重 + deferred）。 */
	async fire(routine: RoutineDef, trigger: string, dedupeKey: string): Promise<void> {
		if (this.receiptLive(dedupeKey)) return;
		this.rememberReceipt(dedupeKey);
		const previous = this.lanes.get(routine.id) ?? Promise.resolve();
		const lane = previous
			.then(() => this.runOnce(routine, trigger))
			.catch(() => undefined)
			.finally(() => {
				if (this.lanes.get(routine.id) === lane) this.lanes.delete(routine.id);
				// deferred 的再触发：lane 清空后补跑（30s 重试语义由触发方决定，这里只补一次）
				const pending = this.deferred.get(routine.id);
				if (pending && this.lanes.has(routine.id) === false) {
					this.deferred.delete(routine.id);
					const next = pending[0];
					if (next) void this.fire(routine, next.trigger, `${next.dedupeKey}:retry`);
				}
			});
		this.lanes.set(routine.id, lane);
		await lane;
	}

	private async runOnce(routine: RoutineDef, trigger: string): Promise<void> {
		const state = this.load();
		// 终态落盘失败期间：宁可漏跑不可丢账——上一条还没记账就不开新的
		const lastRun = state.runs[state.runs.length - 1];
		if (lastRun && lastRun.status === "running") {
			const pending = this.deferred.get(routine.id) ?? [];
			pending.push({ trigger, dedupeKey: `${routine.id}:${Date.now()}` });
			this.deferred.set(routine.id, pending);
			return;
		}

		const runId = randomUUID();
		const startedAt = new Date().toISOString();
		state.running[routine.id] = { runId, startedAt };
		const run: RoutineRunRecord = {
			id: runId,
			routineId: routine.id,
			partnerId: routine.partnerId,
			status: "running",
			trigger,
			startedAt,
		};
		state.runs.push(run);
		if (state.runs.length > RUN_HISTORY_LIMIT) {
			state.runs.splice(0, state.runs.length - RUN_HISTORY_LIMIT);
		}
		this.save();

		try {
			const result = await runPartnerTurn(
				routine.partnerId,
				routine.prompt.slice(0, PROMPT_LIMIT),
				{ authority: "autonomous", sessionMode: routine.sessionMode },
			);
			const finished = this.load();
			const mark = finished.running[routine.id];
			if (mark?.runId !== runId) return; // 期间被重启结算过，不再覆盖
			delete finished.running[routine.id];
			run.status = result.ok ? "success" : "failed";
			run.endedAt = new Date().toISOString();
			run.summary = (result.text || result.error || "").replace(/\s+/g, " ").slice(0, 200);
			if (!result.ok) run.error = result.error;
			finished.runs.push(run);
			if (finished.runs.length > RUN_HISTORY_LIMIT) {
				finished.runs.splice(0, finished.runs.length - RUN_HISTORY_LIMIT);
			}
			this.save();
		} catch (error) {
			const finished = this.load();
			const mark = finished.running[routine.id];
			if (mark?.runId !== runId) return;
			delete finished.running[routine.id];
			run.status = "failed";
			run.endedAt = new Date().toISOString();
			run.error = error instanceof Error ? error.message : String(error);
			finished.runs.push(run);
			this.save();
		}
	}

	/** 手动跑一次（run_now）：用户发起，按 entrusted 记，不占定时链。 */
	async runNow(routineId: string): Promise<{ ok: boolean; text: string; error?: string }> {
		const routine = partnersStore().getRoutine(routineId);
		if (!routine) return { ok: false, text: "", error: "例行任务不存在" };
		const previous = this.lanes.get(routine.id) ?? Promise.resolve();
		let result: { ok: boolean; text: string; error?: string } = { ok: true, text: "" };
		const lane = previous
			.then(async () => {
				const run = await runPartnerTurn(routine.partnerId, routine.prompt.slice(0, PROMPT_LIMIT), {
					authority: "entrusted",
					sessionMode: routine.sessionMode,
				});
				result = run;
				const state = this.load();
				state.runs.push({
					id: randomUUID(),
					routineId,
					partnerId: routine.partnerId,
					status: run.ok ? "success" : "failed",
					trigger: "手动",
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
					summary: (run.text || run.error || "").replace(/\s+/g, " ").slice(0, 200),
					...(run.error ? { error: run.error } : {}),
				});
				if (state.runs.length > RUN_HISTORY_LIMIT) {
					state.runs.splice(0, state.runs.length - RUN_HISTORY_LIMIT);
				}
				this.save();
			})
			.catch(() => undefined);
		this.lanes.set(routine.id, lane);
		await lane;
		return result;
	}

	runsOf(routineId: string, limit = 20): RoutineRunRecord[] {
		return this.load()
			.runs.filter((run) => run.routineId === routineId)
			.slice(-limit)
			.reverse();
	}
}

function delegateEventFields(event: DelegationEvent): Record<string, string> {
	if (event.type === "delegate") {
		return { type: "delegate", phase: event.phase, domain: event.domain, ticketId: event.ticketId };
	}
	if (event.type === "attention") {
		return { type: "attention", kind: event.kind, ticketId: event.ticketId };
	}
	return { type: "approval", tool: event.tool };
}

// ── 单例 ─────────────────────────────────────────────────
let engine: RoutineEngine | null = null;

/** 与 agent.ts 同一背景上下文 */
const CTX = BACKGROUND_CONTEXT;

export function routineEngine(): RoutineEngine {
	engine ??= new RoutineEngine();
	return engine;
}
