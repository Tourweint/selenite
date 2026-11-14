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
import {
	buildRoutinePrompt,
	effectiveMaxRuns,
	emptyRoutineWatchFile,
	evaluateTriggerGate,
	extractRoutineDone,
	planRoutineWatch,
	releaseRoutineWatch,
	routineConditionalEnabled,
	routineConditionNotes,
	routineRunVerdict,
	routineTriggerGatesEnabled,
	shouldAdvanceCursor,
	triggerEndedAt,
	type RoutineOutcome,
	type RoutineWatchFile,
	type TriggerGateState,
} from "./routine-conditions.ts";
import { evaluateRoutineCondition } from "./routine-gate.ts";
import { routineQuietEnabled } from "./routine-quiet.ts";
import {
	PERSONA_DIGEST_INSTRUCTION,
	applyRoutineDigest,
	isReviewRoutine,
	livingModuleOn,
} from "./partner-living.ts";
import { reflectVoiceWeekly } from "./partner-learning.ts";
import { maybeScheduleNudge } from "./partner-proactive.ts";
import { runSourceEnabled, type RunSource } from "./run-source.ts";
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
const DEFAULT_WATCH_PATH = ".data/routine-watch.json";
const PROMPT_LIMIT = 100_000;

/**
 * 自建巡逻总开关（2026-11-08 员工人格化刀二 E4）：`ROUTINE_SELF_SERVICE=false`
 * → `routine_manage` 工具不上架，回到"只有 HTTP 能建例行规则"的形态（一行回滚）。
 * 执事能力整体关时也一并关（没有执事会话就谈不上"自己建"）。
 * 只有明确写 false/0 才关，拼错一个值不会把能力误关掉。
 */
export function routineSelfServiceEnabled(): boolean {
	if (!COMPANIONS_ENABLED) return false;
	const raw = (process.env.ROUTINE_SELF_SERVICE ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0";
}

/**
 * 看护单例交接开关（2026-11-10 批 15 §四）：默认开；
 * `ROUTINE_WATCH_SINGLETON=false` → 不读不写 watch.json，行为回到改动前。
 */
export function routineWatchSingletonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.ROUTINE_WATCH_SINGLETON ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}
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
	/**
	 * 结构化结局（2026-11-10 批 13 §四.2）：下一次触发带给模型，"接着上次往下做"。
	 * `ROUTINE_CONDITIONAL=false` 时不写（新字段被忽略，行为回到改动前）。
	 */
	outcome?: RoutineOutcome;
	/** 无人值守下跳过了步骤（2026-11-10 批 13 §二.2）；只记工具名枚举，不记正文 */
	skipped?: boolean;
	skipReason?: string;
	error?: string;
	/**
	 * 触发来源（2026-11-10 批 15 §三，`RUN_SOURCE` 默认开）。
	 * 老记录没有这个字段 = 视为 human / 未知；开关关着时不写。
	 */
	runSource?: RunSource;
}

interface RoutineState {
	version: 1;
	/** 回执：key → 最近一次时间（ISO）。24h 滑窗清理。 */
	receipts: Record<string, string>;
	runs: RoutineRunRecord[];
	/** 每规则"最近一次开始跑"的标记：重启后 running → interrupted 的判定依据 */
	running: Record<string, { runId: string; startedAt: string }>;
	/** 事件触发器三件门的状态：`${routineId}:${triggerIndex}` → 状态 */
	gates: Record<string, TriggerGateState>;
	/** 自建规则（routine_manage 建的）标记：它们的首轮 runSource 记 routine_self */
	selfCreated: Record<string, true>;
	/**
	 * 每规则的"上次看到哪里"（2026-11-10 批 21 §六）：上一轮**产出被保留**的 endedAt。
	 * 没有 = 还没成功保留过任何一轮（下次从头看）。quiet / skipped / failed 不推进。
	 */
	cursors: Record<string, string>;
}

function emptyState(): RoutineState {
	return {
		version: 1,
		receipts: {},
		runs: [],
		running: {},
		gates: {},
		selfCreated: {},
		cursors: {},
	};
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
	private deferred = new Map<string, Array<{ trigger: string; dedupeKey: string; source: RunSource }>>();
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
				gates: parsed.gates && typeof parsed.gates === "object" ? parsed.gates : {},
				selfCreated:
					parsed.selfCreated && typeof parsed.selfCreated === "object"
						? parsed.selfCreated
						: {},
				cursors:
					parsed.cursors && typeof parsed.cursors === "object" ? parsed.cursors : {},
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

	// ── 看护单例（批 15 §四）──────────────────────────────
	/** 看护账本路径；`ROUTINE_WATCH_PATH` 只给单测 / 探针换落点。 */
	private watchPath(): string {
		return process.env.ROUTINE_WATCH_PATH?.trim() || DEFAULT_WATCH_PATH;
	}

	private readWatch(): RoutineWatchFile {
		const path = this.watchPath();
		if (!existsSync(path)) return emptyRoutineWatchFile();
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RoutineWatchFile>;
			return {
				version: 1,
				watches:
					parsed.watches && typeof parsed.watches === "object" ? parsed.watches : {},
				handedTo:
					parsed.handedTo && typeof parsed.handedTo === "object" ? parsed.handedTo : {},
			};
		} catch {
			// 坏文件当空账：宁可重新认领，也不要让看护卡死。
			return emptyRoutineWatchFile();
		}
	}

	private writeWatch(file: RoutineWatchFile): void {
		const path = this.watchPath();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(file), "utf8");
		renameSync(tmp, path);
	}

	/**
	 * 这一轮开始前的看护认领。**同一执事同一时刻最多一个看护**：
	 * 已有别的看护在盯 → 旧规则只暂停（enabled=false，revision+1 让在飞闹钟作废），
	 * 并在 watch.json 的 handedTo 记一次；旧规则不删除。
	 * 写失败只 warn：看护账是旁路，不能把例行主链路拖下水。
	 */
	private claimWatch(routine: RoutineDef): void {
		if (!routineWatchSingletonEnabled()) return;
		// 用**当前**定义判断：交接刚把旧规则停掉时，旧规则的迟到触发不该再把看护抢回去。
		const current = partnersStore().getRoutine(routine.id);
		if (!current || !current.enabled || !current.until?.note) return;
		try {
			const file = this.readWatch();
			const plan = planRoutineWatch({
				file,
				key: current.partnerId,
				routineId: current.id,
				name: current.name,
				now: new Date().toISOString(),
				wantsWatch: true,
				enabled: true,
			});
			if (!plan.takeOver) return;
			if (plan.handoffFrom) {
				const previous = partnersStore().getRoutine(plan.handoffFrom);
				if (previous && previous.enabled) {
					// 只暂停不删；revision+1 由 updateRoutine 负责，在飞闹钟醒来会自动作废。
					partnersStore().updateRoutine(previous.id, { enabled: false });
				}
				console.log(
					`[routine] 看护交接 ${plan.handoffFrom.slice(0, 8)} → ${current.id.slice(0, 8)}（旧的只暂停）`,
				);
			}
			if (plan.file !== file) this.writeWatch(plan.file);
		} catch (error) {
			console.warn(
				`[routine] 看护账写入失败（规则 ${routine.id.slice(0, 8)}）：${
					error instanceof Error ? error.message.slice(0, 120) : "unknown"
				}`,
			);
		}
	}

	/** 规则置停（until 达成 / 跑满 maxRuns）：从看护账里摘掉（handedTo 保留，便于追溯）。 */
	private releaseWatch(routineId: string): void {
		if (!routineWatchSingletonEnabled()) return;
		try {
			const file = this.readWatch();
			const next = releaseRoutineWatch(file, routineId);
			if (next !== file) this.writeWatch(next);
		} catch {
			/* 旁路账，失败不影响置停 */
		}
	}

	/**
	 * 自建规则标记（routine_manage 建的）：它的**首轮** runSource 记 `routine_self`，
	 * 之后回到 `routine`。开关关着时不记（行为回到改动前）。
	 */
	markSelfCreated(routineId: string): void {
		if (!runSourceEnabled()) return;
		const state = this.load();
		state.selfCreated[routineId] = true;
		this.save();
	}

	/** 取本轮的来源：自建规则的首轮升级为 routine_self；开关关着不写。 */
	private takeRunSource(routine: RoutineDef, base: RunSource): RunSource | undefined {
		if (!runSourceEnabled()) return undefined;
		const state = this.load();
		if (base === "routine" && state.selfCreated[routine.id]) {
			delete state.selfCreated[routine.id];
			return "routine_self";
		}
		return base;
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

	/**
	 * 前置条件没成立 / 判不出来：记一条 skipped run（批 21 §三.2）。
	 * 只记枚举口径，条件原文不进日志。`skipReason` 让 `completedRunCount` 认出
	 * "这不是一次真跑"，不消耗 maxRuns / ends.after 的额度。
	 */
	private recordConditionSkip(routine: RoutineDef, trigger: string, unavailable: boolean): void {
		const now = new Date().toISOString();
		this.recordRun({
			id: randomUUID(),
			routineId: routine.id,
			partnerId: routine.partnerId,
			status: "skipped",
			trigger,
			startedAt: now,
			endedAt: now,
			summary: unavailable ? "前置条件判定不可用，按不成立跳过" : "前置条件不成立，跳过本轮",
			outcome: "skipped",
			skipReason: "condition_not_met",
		});
		console.log(
			`[routine] 前置条件${unavailable ? "判定不可用" : "不成立"}，跳过本轮（规则 ${routine.id.slice(0, 8)}）`,
		);
	}

	/**
	 * 上一轮的结构化结局（2026-11-10 批 13 §四.2）：只认有 outcome 的终态记录，
	 * 跳过 running 与老记录（老记录没有 outcome，不能拿它冒充"上一次"）。
	 */
	private lastOutcomeOf(routineId: string): RoutineOutcome | undefined {
		const runs = this.load().runs;
		for (let i = runs.length - 1; i >= 0; i -= 1) {
			const run = runs[i];
			if (!run || run.routineId !== routineId || run.status === "running") continue;
			if (run.outcome) return run.outcome;
		}
		return undefined;
	}

	/**
	 * 上次看到哪里（批 21 §六）：上一轮产出被保留时的 endedAt。
	 * 开关 `ROUTINE_QUIET` 关着时不读不写（回到"每轮都从头看"的旧形态）。
	 */
	private cursorOf(routineId: string): string | undefined {
		if (!routineQuietEnabled()) return undefined;
		const cursor = this.load().cursors[routineId];
		return typeof cursor === "string" && cursor ? cursor : undefined;
	}

	/**
	 * 已自动完成的次数（不含本轮与手动试跑）。按 run id 去重——历史记录里同一条 run
	 * 可能因"开跑先落盘、收尾再落一次"出现两次，不能把 maxRuns 算翻倍。
	 * 前置条件没成立而跳过的轮次（批 21 §三）不算"跑过一次"：它们没消耗执行。
	 */
	private completedRunCount(routineId: string): number {
		const ids = new Set<string>();
		for (const run of this.load().runs) {
			if (
				run.routineId === routineId &&
				run.status !== "running" &&
				run.trigger !== "手动" &&
				run.skipReason !== "condition_not_met"
			) {
				ids.add(run.id);
			}
		}
		return ids.size;
	}

	/** 条件达成 / 跑满上限：置停（enabled=false），不删规则；revision+1 让在飞闹钟作废。 */
	private stopRoutine(routineId: string, reason: RoutineOutcome): void {
		try {
			const current = partnersStore().getRoutine(routineId);
			if (!current || !current.enabled) return;
			partnersStore().updateRoutine(routineId, { enabled: false });
			this.releaseWatch(routineId);
			console.log(`[routine] 规则 ${routineId.slice(0, 8)} 已置停（${reason}）`);
		} catch (error) {
			// 置停失败不覆盖本轮已落盘的结局；下一次触发会再判一次。
			console.warn(
				`[routine] 置停失败（规则 ${routineId.slice(0, 8)}）：${
					error instanceof Error ? error.message.slice(0, 120) : "unknown"
				}`,
			);
		}
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
			for (const [triggerIndex, trigger] of routine.triggers.entries()) {
				if (trigger.type !== "event" || trigger.kind !== kind) continue;
				// 结束时间已过（批 21 §三）：这个触发器不再被事件唤醒。
				if (routineConditionalEnabled() && triggerEndedAt(trigger)) continue;
				const match = trigger.match ?? {};
				const matched = Object.entries(match).every(
					([key, value]) => (fields[key] ?? "") === value,
				);
				// 三件门（批 15 §一）：cooldown → edge → baseline → 原 match。
				// 状态按"规则 + 触发器序号"落 routines.json；开关关着时只看 matched。
				const gatesOn = routineTriggerGatesEnabled();
				const gateKey = `${routine.id}:${triggerIndex}`;
				const gate = evaluateTriggerGate({
					spec: {
						...(trigger.baseline ? { baseline: trigger.baseline } : {}),
						...(trigger.edge === true ? { edge: true as const } : {}),
						...(typeof trigger.cooldownSec === "number"
							? { cooldownSec: trigger.cooldownSec }
							: {}),
					},
					...(this.load().gates[gateKey] ? { state: this.load().gates[gateKey] } : {}),
					now: Date.now(),
					matched,
					...(trigger.baseline
						? { observed: Number(fields[trigger.baseline.key]) }
						: {}),
					enabled: gatesOn,
				});
				if (gatesOn) {
					const previousGate = this.load().gates[gateKey];
					if (JSON.stringify(previousGate ?? null) !== JSON.stringify(gate.state)) {
						this.load().gates[gateKey] = gate.state;
						try {
							this.save();
						} catch (error) {
							// 门状态是旁路账：写不进去就按内存里的继续，不吞掉本轮事件。
							console.warn(
								`[routine] 门状态落盘失败（规则 ${routine.id.slice(0, 8)}）：${
									error instanceof Error ? error.message.slice(0, 120) : "unknown"
								}`,
							);
						}
					}
				}
				if (!gate.fire) continue;
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
			// 结束时间已过（批 21 §三）：这个触发器不再排下一次。
			if (routineConditionalEnabled() && triggerEndedAt(trigger, from.getTime())) continue;
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
	async fire(
		routine: RoutineDef,
		trigger: string,
		dedupeKey: string,
		source: RunSource = "routine",
	): Promise<void> {
		if (this.receiptLive(dedupeKey)) return;
		this.rememberReceipt(dedupeKey);
		const previous = this.lanes.get(routine.id) ?? Promise.resolve();
		const lane = previous
			.then(() => this.runOnce(routine, trigger, source))
			.catch(() => undefined)
			.finally(() => {
				if (this.lanes.get(routine.id) === lane) this.lanes.delete(routine.id);
				// deferred 的再触发：lane 清空后补跑（30s 重试语义由触发方决定，这里只补一次）
				const pending = this.deferred.get(routine.id);
				if (pending && this.lanes.has(routine.id) === false) {
					this.deferred.delete(routine.id);
					const next = pending[0];
					if (next) {
						void this.fire(routine, next.trigger, `${next.dedupeKey}:retry`, next.source);
					}
				}
			});
		this.lanes.set(routine.id, lane);
		await lane;
	}

	private async runOnce(routine: RoutineDef, trigger: string, source: RunSource): Promise<void> {
		const state = this.load();
		// 终态落盘失败期间：宁可漏跑不可丢账——上一条还没记账就不开新的
		const lastRun = state.runs[state.runs.length - 1];
		if (lastRun && lastRun.status === "running") {
			const pending = this.deferred.get(routine.id) ?? [];
			pending.push({ trigger, dedupeKey: `${routine.id}:${Date.now()}`, source });
			this.deferred.set(routine.id, pending);
			return;
		}

		// 条件门控开关（2026-11-10 批 13 §四.3）：关着时下面所有新字段一律不参与。
		const conditional = routineConditionalEnabled();

		// 前置条件（2026-11-10 批 21 §三）：触发前问一次模型"成立吗"。
		// 失败 / 解析失败一律当不成立（fail-closed）；不成立就记 skipped、不建 run、不占额度。
		if (conditional) {
			for (const note of routineConditionNotes(routine.triggers)) {
				const verdict = await evaluateRoutineCondition({ note, prompt: routine.prompt });
				if (verdict !== "met") {
					this.recordConditionSkip(routine, trigger, verdict === "unavailable");
					return;
				}
			}
		}

		// 看护单例（批 15 §四）：新的一轮开始前认领；旧看护只暂停不删。
		this.claimWatch(routine);

		const runId = randomUUID();
		const startedAt = new Date().toISOString();
		const completedBefore = this.completedRunCount(routine.id);
		const runSource = this.takeRunSource(routine, source);
		state.running[routine.id] = { runId, startedAt };
		const run: RoutineRunRecord = {
			id: runId,
			routineId: routine.id,
			partnerId: routine.partnerId,
			status: "running",
			trigger,
			startedAt,
			...(runSource ? { runSource } : {}),
		};
		state.runs.push(run);
		if (state.runs.length > RUN_HISTORY_LIMIT) {
			state.runs.splice(0, state.runs.length - RUN_HISTORY_LIMIT);
		}
		this.save();

		try {
			// 条件门控（2026-11-10 批 13 §四）：上次结局 + 完成条件进提示词。
			// 开关关着时 buildRoutinePrompt 原样返回规则正文（逐字节回到改动前）。
			const prompt = buildRoutinePrompt({
				prompt: routine.prompt.slice(0, PROMPT_LIMIT),
				lastOutcome: conditional ? this.lastOutcomeOf(routine.id) : undefined,
				untilNote: conditional ? routine.until?.note : undefined,
				cursorAt: conditional ? this.cursorOf(routine.id) : undefined,
				conditional,
			});
			// 人格活模块（2026-11-15 批2）：heart 开 + 盘点例行 → 提示词末尾加"你自己的记录"段。
			// 不新造调度：还是这条例行规则、这次触发，只是产出格式多三段。
			const partnerRow = partnersStore().get(routine.partnerId);
			const heartDigestWanted =
				Boolean(partnerRow) && isReviewRoutine(routine) && livingModuleOn(partnerRow!, "heart");
			const finalPrompt = heartDigestWanted
				? `${prompt}\n\n${PERSONA_DIGEST_INSTRUCTION}`
				: prompt;
			const result = await runPartnerTurn(routine.partnerId, finalPrompt, {
				authority: "autonomous",
				sessionMode: routine.sessionMode,
			});
			// 人格批3：盘点例行跑完 = 既有"主动开口时机"之一。
			// 学习：用执事自己的模型链把本周统计 + 短例句提炼成规则；挂念：经既有提醒链发一条。
			// 两者都自判模块开关，失败只 warn；不新造调度。
			if (result.ok && isReviewRoutine(routine)) {
				void reflectVoiceWeekly(routine.partnerId);
				void maybeScheduleNudge(routine.partnerId);
			}
			// 人格活模块（2026-11-15 批2）：heart 开着的**盘点例行**才挂"他自己的话"，
			// 生成结果由 applyRoutineDigest 摘出日记 / 成长笔记；周报一句留在正文末尾。
			const digest =
				result.ok && heartDigestWanted
					? applyRoutineDigest({ partnerId: routine.partnerId, text: result.text ?? "" })
					: null;
			const replyText = digest?.text ?? (result.text ?? "");
			const finished = this.load();
			const mark = finished.running[routine.id];
			if (mark?.runId !== runId) return; // 期间被重启结算过，不再覆盖
			delete finished.running[routine.id];
			run.status = result.ok ? "success" : "failed";
			run.endedAt = new Date().toISOString();
			const skipped = result.skipped ?? [];
			if (skipped.length > 0) {
				// 只记枚举与步骤名，不记正文（批 13 §二.2 / 日志纪律）。
				run.skipped = true;
				run.skipReason = `unattended:${skipped.join(",")}`;
			}
			const doneMarker = conditional
				? extractRoutineDone(replyText)
				: { text: replyText, done: false };
			// ends.after 是 maxRuns 的别名（批 21 §三）：两者同时存在取更小的。
			const maxRuns = conditional
				? effectiveMaxRuns(routine.maxRuns, routine.triggers)
				: routine.maxRuns;
			const verdict = routineRunVerdict({
				ok: result.ok,
				quiet: result.quiet === true,
				skippedToolCount: skipped.length,
				untilMet: doneMarker.done,
				conditional,
				...(maxRuns !== undefined ? { maxRuns } : {}),
				completedRunsBefore: completedBefore,
			});
			if (conditional) run.outcome = verdict.outcome;
			// 工具报错的轮（批 21 §三"读失败不当无新"）：安静已被压制，这里把报错工具
			// 记成枚举前缀，run 记录一眼看出"这轮为什么没算安静"。不记报错正文（日志纪律）。
			const toolErrors = result.toolErrors ?? [];
			const errorTag = toolErrors.length > 0 ? `[工具报错:${toolErrors.join(",")}] ` : "";
			// 安静轮（2026-11-09 T2）：只记枚举，不把"无事发生"的正文写进摘要
			run.summary = result.quiet
				? "quiet"
				: (errorTag + (doneMarker.text || result.error || "")).replace(/\s+/g, " ").slice(0, 200);
			if (skipped.length > 0) {
				console.log(
					`[routine] 本轮跳过 ${skipped.length} 个需要花钱/批准的步骤（规则 ${routine.id.slice(0, 8)}）`,
				);
			}
			if (result.quiet) {
				// 日志纪律：只说"这轮安静"，不记产出正文
				console.log(`[routine] 本轮无更新（规则 ${routine.id.slice(0, 8)}），不写摘要`);
			}
			if (!result.ok) run.error = result.error;
			// 游标（批 21 §六）：只有产出被保留才推进；quiet / skipped / failed 原地不动，
			// 下一轮仍从同一处看（读失败已记 failed，不会被当成"无新内容"）。
			if (
				run.endedAt &&
				shouldAdvanceCursor({
					ok: result.ok,
					quiet: result.quiet === true,
					skippedToolCount: skipped.length,
				}) &&
				routineQuietEnabled()
			) {
				finished.cursors[routine.id] = run.endedAt;
			}
			finished.runs.push(run);
			if (finished.runs.length > RUN_HISTORY_LIMIT) {
				finished.runs.splice(0, finished.runs.length - RUN_HISTORY_LIMIT);
			}
			this.save();
			// 达成条件 / 跑满上限 → 置停（不删，保留历史）。停完在飞的闹钟醒来对不上 revision 自动作废。
			if (verdict.stop) this.stopRoutine(routine.id, verdict.outcome);
		} catch (error) {
			const finished = this.load();
			const mark = finished.running[routine.id];
			if (mark?.runId !== runId) return;
			delete finished.running[routine.id];
			run.status = "failed";
			run.endedAt = new Date().toISOString();
			run.error = error instanceof Error ? error.message : String(error);
			// 抛异常也是"上一次的结果"，不能让下一轮看不到失败。
			if (conditional) run.outcome = "failed";
			finished.runs.push(run);
			this.save();
		}
	}

	/** 手动跑一次（run_now）：用户/脚本发起，按 entrusted 记，不占定时链。 */
	async runNow(
		routineId: string,
		source: RunSource = "script",
	): Promise<{ ok: boolean; text: string; error?: string }> {
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
				const skipped = run.skipped ?? [];
				const outcome: RoutineOutcome = run.ok
					? skipped.length > 0
						? "skipped"
						: "success"
					: "failed";
				const runSource = runSourceEnabled() ? source : undefined;
				state.runs.push({
					id: randomUUID(),
					routineId,
					partnerId: routine.partnerId,
					status: run.ok ? "success" : "failed",
					trigger: "手动",
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
					summary: (run.text || run.error || "").replace(/\s+/g, " ").slice(0, 200),
					// 手动试跑不判 until / 不占 maxRuns 的"自动停"语义，但结局照记，
					// 下一次定时触发仍能看到"上一次的结果"。
					...(routineConditionalEnabled() ? { outcome } : {}),
					...(runSource ? { runSource } : {}),
					...(skipped.length > 0
						? { skipped: true, skipReason: `unattended:${skipped.join(",")}` }
						: {}),
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
	// 中途播报（批13 §三）不是可触发事件：给一个中性字段，别被当成审批。
	if (event.type === "notice") return { type: "notice" };
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
