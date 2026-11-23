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
 * 依赖方向：只 import partner-runtime / partners / delegation（类型）/ agent/session
 * / bash-background（类型，批3 载荷形状），**不 import agent/lifecycle**
 * （lifecycle 反向 import 本模块，再加一条就是明确的环）。
 *
 * 批3（2026-11-19 唤醒管道通用化与后台任务接线）：信封从"派活汇报专属"泛化为
 * `{source, targetPartnerId, payload}` 三来源（delegation / bgjob / agent-message）。
 * delegation 路径行为逐字节不变（回归 = 既有单测全绿）；新来源按 targetPartnerId
 * 路由 + 通用存在性检查。（回滚开关 WAKE_PIPELINE_V2 2026-11-21 退役，新来源恒投。）
 *
 * 批5（2026-11-19 无主会话唤醒）：bgjob 信封增加可选 `targetConversationId`（内部会话 id）。
 * **谁起的命令唤醒谁**：会话有执事归属 → 仍唤醒执事 canonical（批3 路径逐字节不变）；
 * 没有归属（worker 任务对话 / 普通对话）→ 直接续跑发起命令的会话本身
 * （`continueConversation`，忙时按批1 缺省 steer 插话），不再"只写记录"。
 * （BG_JOB_WAKE_SESSION 回滚开关 2026-11-21 退役，无主会话恒投。）
 *
 * 批5-C（2026-11-19 无主会话派活唤醒）：同一个"谁派的话唤醒谁"扩到 delegation。
 * canonical 解析为 null 的会话（普通 worker 对话 / 群成员 / 例行专线等**能派活**的
 * 会话）用 `delegate` 派活后，汇报写回时也唤醒它自己（delegation 信封带
 * `targetConversationId`，flush 走同一会话路径，提示词仍 `buildWakePrompt`）。
 * 有 canonical 归属的执事路径逐字节不变。（DELEGATION_WAKE_SESSION /
 * DELEGATION_WAKE_ENABLED 回滚开关 2026-11-21 退役，派活唤醒恒开。）
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
import type { BgJobWakePayload } from "./bash-background.ts";
import { continueConversation, conversationExists, conversationIsBusy } from "./agent/session.ts";
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

// ── 泛化信封（批3）────────────────────────────────────────────
//
// 管道本体（防抖 / 忙退避 / 落盘恢复 / 重排 / 链保险丝）不问来源，只认信封。
// delegation 载荷仍是 DelegationReport（旧形状）；bgjob / agent-message 载荷见各自接口。

/** 唤醒来源：delegation=派活汇报（批29 旧）；bgjob=后台任务终态/输出变化；agent-message=执事间递话。 */
export type WakeSource = "delegation" | "bgjob" | "agent-message";

/** agent-message 信封载荷：谁递了什么话。 */
export interface AgentMessageWakePayload {
	fromPartnerId: string;
	fromName: string;
	fromDomain: string | null;
	text: string;
	/**
	 * worker 决策上报（2026-11-19 批2）专用的附加字段：kind=escalation 时其余字段
	 * 必齐，唤醒提示词改走上报纪律（respond_escalation），不再是"用 send_to_agent 回话"。
	 * 不带 kind 的载荷与批3 前逐字节一致。
	 */
	kind?: "escalation";
	escalationId?: string;
	ticketId?: string;
	question?: string;
	context?: string;
	options?: string[];
	urgency?: "low" | "normal" | "high";
}

/**
 * 泛化唤醒信封（批3）。targetPartnerId = 唤醒轮要落的执事；delegation 的路由仍以
 * canonical 复查为准。
 *
 * 批5：`targetConversationId` 是**内部会话 id**（只进 .data 内部文件与进程内队列，
 * 不进对外 API——对外 id 一律 uuid 的硬约束不受影响）。无主会话路径会带：
 * 发起命令 / 派活的会话自己就是唤醒目标，此时 targetPartnerId 约定为空串。
 * 批5-C：delegation 与 bgjob 共用这个会话形态（提示词仍按来源分节）。
 */
type WakeEnvelopeBase = {
	targetPartnerId: string;
	targetConversationId?: number;
};

export type WakeEnvelope =
	| (WakeEnvelopeBase & { source: "delegation"; payload: DelegationReport })
	| (WakeEnvelopeBase & { source: "bgjob"; payload: BgJobWakePayload })
	| (WakeEnvelopeBase & { source: "agent-message"; payload: AgentMessageWakePayload });

function isDelegationEnvelope(
	envelope: WakeEnvelope,
): envelope is Extract<WakeEnvelope, { source: "delegation" }> {
	return envelope.source === "delegation";
}

/**
 * 可注入的内部参数（默认全走真实实现）。单测用假时钟 / 假执事库驱动，
 * 不需要起服务、也不碰磁盘。
 */
export interface DelegationWakeDeps {
	/** 执事体系总闸（`COMPANIONS_ENABLED`，模块常量） */
	companionsEnabled(): boolean;
	/** 只认 canonical 主会话（`canonicalPartnerIdOfSession`），群 / 专线链接返回 null */
	partnerIdOfSession(conversationId: number): string | null;
	/**
	 * 批3：任意 role 链接的归属解析（`partnerIdOfSession`，"这条会话归谁"）。
	 * bgjob 的起点：命令在哪个会话跑的，就找哪个会话的执事（唤醒轮仍落 canonical 主会话）。
	 * 缺省未注入 = 解析不了 → 不投（新来源只有装配层真实链路会用）。
	 */
	partnerIdOfAnySession?(conversationId: number): string | null;
	/**
	 * 批3：对端执事 canonical 主会话的内部 id（`sessionIdOfPartner`）；还没建过会话 = null。
	 * agent-message 入队键用。缺省未注入 = 解析不了 → 不投。
	 */
	sessionIdOfPartner?(partnerId: string): number | null;
	/**
	 * 批5：目标会话是否还在（`conversationExists`）。会话路径 flush 前复查；
	 * 返回 false → 按 target_gone 丢弃，不重排。缺省未注入 = 无法确认 → 丢弃。
	 */
	sessionExists?(conversationId: number): Promise<boolean>;
	/**
	 * 批5：会话路径的唤醒轮（`continueConversation`）：直接续跑发起命令的会话本身。
	 * 忙时提交跟随批1 缺省 steer（不在这里等空闲）。抛错 → 回灌重排。
	 * 缺省未注入 = 会话路径跑不了 → 按失败重排（有上限）。
	 */
	continueSession?(conversationId: number, prompt: string): Promise<void>;
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

/** 待唤醒的信封（批3 泛化；delegation 载荷仍是 DelegationReport），按会话合并；取走即清空 */
const pending = new Map<number, WakeEnvelope[]>();
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
 * 日志纪律：只记条数，不落汇报正文（信封载荷同待遇，只落盘不进日志）。
 */
function persistWakeQueue(): void {
	try {
		const entries = [...pending.entries()].map(([conversationId, envelopes]) => ({
			conversationId,
			envelopes,
		}));
		mkdirSync(dirname(resolve(wakeQueuePath())), { recursive: true });
		const temp = `${wakeQueuePath()}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(temp, JSON.stringify({ version: 2, entries }), "utf8");
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

/** 单条信封的最小形状（读回时防脏数据；载荷按来源分查）。 */
function isEnvelopeLike(value: unknown): value is WakeEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const source = (value as { source?: unknown }).source;
	const targetPartnerId = (value as { targetPartnerId?: unknown }).targetPartnerId;
	const targetConversationId = (value as { targetConversationId?: unknown }).targetConversationId;
	if (typeof targetPartnerId !== "string") return false;
	// 批5 / 5-C：只有 bgjob 与 delegation 能带会话目标；带目标时 targetPartnerId 允许为空串
	// （无主会话约定）。不带目标的旧形状仍要求非空执事 id，免得脏数据被当成合法信封。
	if (targetConversationId !== undefined) {
		if (
			(source !== "bgjob" && source !== "delegation") ||
			typeof targetConversationId !== "number" ||
			!Number.isInteger(targetConversationId) ||
			targetConversationId <= 0
		) {
			return false;
		}
	} else if (targetPartnerId.length === 0) {
		return false;
	}
	const payload = (value as { payload?: unknown }).payload;
	if (typeof payload !== "object" || payload === null) return false;
	if (source === "delegation") return isReportLike(payload);
	if (source === "bgjob") {
		const bg = payload as { jobId?: unknown; commandSummary?: unknown; tail?: unknown };
		return typeof bg.jobId === "string" && typeof bg.commandSummary === "string" && typeof bg.tail === "string";
	}
	if (source === "agent-message") {
		const message = payload as { fromName?: unknown; text?: unknown };
		return typeof message.fromName === "string" && typeof message.text === "string";
	}
	return false;
}

/**
 * 启动恢复（2026-11-15 送达兜底 §C）：读回上一次进程没送完的唤醒队列并重排防抖。
 * 文件不存在 / 坏了 / 条目脏 → 当空队列，不抛。由 index.ts 启动段调用。
 *
 * 批3 兼容两种形状：`reports`（批3 前的 delegation 旧文件，包回 delegation 信封，
 * 行为不变）与 `envelopes`（泛化信封）。读旧形状不炸。
 */
export function restoreDelegationWakeQueue(deps: DelegationWakeDeps = defaultDeps): number {
	try {
		const parsed = JSON.parse(readFileSync(wakeQueuePath(), "utf8")) as {
			entries?: Array<{ conversationId?: unknown; reports?: unknown; envelopes?: unknown }>;
		};
		let restored = 0;
		for (const entry of Array.isArray(parsed.entries) ? parsed.entries : []) {
			const conversationId = Number(entry.conversationId);
			if (!Number.isFinite(conversationId)) continue;
			// 新形状（批3）：泛化信封，恢复后照常按 source 分支路由
			if (Array.isArray(entry.envelopes)) {
				const envelopes = entry.envelopes.filter(isEnvelopeLike);
				if (envelopes.length === 0) continue;
				pending.set(conversationId, envelopes);
				restored += envelopes.length;
				if (!timers.has(conversationId) && !running.has(conversationId)) {
					scheduleFlush(conversationId, deps);
				}
				continue;
			}
			// 旧形状（批3 前）：delegation 汇报，包回信封（targetPartnerId 由 flush 时的
			// canonical 复查现算，落盘里留空即可——delegation 路由从不读这个字段）
			const reports = (Array.isArray(entry.reports) ? entry.reports : []).filter(isReportLike);
			if (reports.length === 0) continue;
			pending.set(
				conversationId,
				reports.map((report) => ({
					source: "delegation" as const,
					targetPartnerId: "",
					payload: report,
				})),
			);
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
	companionsEnabled: () => COMPANIONS_ENABLED,
	partnerIdOfSession: (conversationId) =>
		partnersStore().canonicalPartnerIdOfSession(conversationId),
	partnerIdOfAnySession: (conversationId) => partnersStore().partnerIdOfSession(conversationId),
	sessionIdOfPartner: (partnerId) => partnersStore().sessionIdOfPartner(partnerId),
	sessionExists: (conversationId) => conversationExists(conversationId),
	continueSession: (conversationId, prompt) => continueConversation(conversationId, prompt),
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
 * 1. `COMPANIONS_ENABLED` 关 → 唤醒轮跑不了（runPartnerTurn 需要执事体系）；
 * 2. 非 canonical 主会话（群会话 role=group / 例行专线 role=routine / 课题专线 role=topic）→ 不唤醒；
 * 3. partner 不存在或不是 active → 不唤醒。
 *
 * **每次 flush 都要重新过一遍**：排队期间执事可能被停。
 * （唤醒回滚开关 2026-11-21 退役，原第 1 关撤下。）
 */
function guardPartner(
	conversationId: number,
	deps: DelegationWakeDeps,
): string | null {
	if (!deps.companionsEnabled()) return null;
	const partnerId = deps.partnerIdOfSession(conversationId);
	if (partnerId === null) return null;
	if (deps.partnerStatus(partnerId) !== "active") return null;
	return partnerId;
}

/**
 * flush 时的信封守卫（批3）：按 source 分支。
 *
 * - delegation（不含会话目标的旧批）：canonical 主会话存在 → 仍走 guardPartner 锁
 *   canonical（批 29 语义不动）；canonical 解析为 null（排队期间链接被删 / 恢复的旧
 *   队列）→ 批5-C 起回落"唤醒会话自己"。混批
 *   （delegation + bgjob）只可能发生在 canonical 主会话上——delegation 入队时已过
 *   canonical 锁，bgjob 的 targetPartnerId 必然同执事，以 canonical 口径判整批是安全的。
 * - bgjob / agent-message：按 targetPartnerId 路由 + 通用存在性检查
 *   （partnerStatus 查无此人返回 null、停用不是 active，都不投）。
 * - 批5 / 5-C：带 `targetConversationId` 的信封（bgjob / delegation）= 无主会话路径，
 *   返回会话目标让 flush 直接续跑该会话。整批必须都是同一会话的会话目标
 *   （混了 canonical 形态 / 别的会话 → 不投），目标与队列键也必须一致
 *   （防落盘文件被改脏后把 A 的队列跑进 B）。
 *   （唤醒回滚开关 2026-11-21 退役：来源专属与会话路径的闸都撤下，恒投。）
 */
type WakeTarget =
	| { kind: "partner"; partnerId: string }
	| { kind: "session"; conversationId: number };

function guardWake(
	conversationId: number,
	envelopes: WakeEnvelope[],
	deps: DelegationWakeDeps,
): WakeTarget | null {
	// 空批：沿用 delegation 的 canonical 守卫（flush 收尾时据此判队列还留不留）
	if (envelopes.length === 0) {
		const partnerId = guardPartner(conversationId, deps);
		return partnerId === null ? null : { kind: "partner", partnerId };
	}

	const hasDelegation = envelopes.some(isDelegationEnvelope);

	// 执事体系关着时不投（与 guardPartner 一致）；唤醒回滚开关 2026-11-21 已退役。
	if (hasDelegation && !deps.companionsEnabled()) return null;

	// 批5 / 5-C：无主会话路径（delegation / bgjob 同形）
	const sessionEnvelopes = envelopes.filter(
		(envelope) => envelope.targetConversationId !== undefined,
	);
	if (sessionEnvelopes.length > 0) {
		// 整批必须都是会话目标：混了 canonical 形态的旧信封 → fail closed
		if (sessionEnvelopes.length !== envelopes.length) return null;
		const targetConversationId = sessionEnvelopes[0]!.targetConversationId!;
		if (targetConversationId !== conversationId) return null;
		const consistent = envelopes.every(
			(envelope) =>
				(envelope.source === "delegation" || envelope.source === "bgjob") &&
				envelope.targetConversationId === targetConversationId &&
				envelope.targetPartnerId === "",
		);
		if (!consistent) return null;
		return { kind: "session", conversationId: targetConversationId };
	}

	// 原 delegation 路径（canonical 锁，批 29 语义不动）；混批也按 canonical 判。
	// 批5-C：canonical 解析为 null（排队期间链接被删 / 恢复的旧队列）→ 回落会话路径。
	if (hasDelegation) {
		const partnerId = deps.partnerIdOfSession(conversationId);
		if (partnerId !== null) {
			if (deps.partnerStatus(partnerId) !== "active") return null;
			return { kind: "partner", partnerId };
		}
		return { kind: "session", conversationId };
	}

	// 原 bgjob / agent-message 路径（批3）
	const partnerId = envelopes[0]!.targetPartnerId;
	if (!partnerId) return null;
	if (envelopes.some((envelope) => envelope.targetPartnerId !== partnerId)) return null;
	if (deps.partnerStatus(partnerId) !== "active") return null;
	return { kind: "partner", partnerId };
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
 * bgjob 唤醒提示词（批3，固定字节可单测）。信封只递纸条不代写：命令摘要 / 终态 /
 * 尾部输出是原料，说不说、怎么说由执事自己定（dim 教训）。尾部 ≤400 字由装配层
 * 的 tailForWake 保证，这里原样渲染。
 */
export function buildBgJobWakePrompt(payloads: BgJobWakePayload[]): string {
	const header = [
		"[Background job wake context]",
		"turnAuthority: autonomous",
		"",
		"以下后台任务刚到终态或有新输出。逐条接住：",
		"- 完成了：一句话说清结果与落点；",
		"- 失败了：说清原因与下一步建议；",
		"- 还在跑、只是有新输出的：看一眼尾部，判断要不要跟进，不必复述全文。",
		"不要重复执行同样的命令。没有要补充的就一句话收尾。",
		"",
		"本批任务：",
	].join("\n");
	const lines = payloads.map((payload) => {
		const state =
			payload.status === "running"
				? "还在跑"
				: `${payload.status}，退出码 ${payload.exitCode ?? "未知"}`;
		const head = `- 任务 ${payload.jobId}（${state}）：${payload.commandSummary}`;
		return payload.tail ? `${head}\n  尾部输出：\n${payload.tail}` : head;
	});
	return [header, ...lines].join("\n");
}

/**
 * agent-message 唤醒提示词（批3，固定字节可单测）。
 * 批2（决策上报链）接入第一个调用方：worker 的 escalation 走 agent-message 信封
 * 唤醒派活方执事，payload.kind=escalation 时换上报纪律段（respond_escalation）。
 */
export function buildAgentMessageWakePrompt(payloads: AgentMessageWakePayload[]): string {
	const escalations = payloads.filter((payload) => payload.kind === "escalation");
	if (escalations.length === payloads.length && escalations.length > 0) {
		return buildEscalationWakePrompt(escalations);
	}
	const header = [
		"[Agent message wake context]",
		"turnAuthority: autonomous",
		"",
		"你不在时，别的执事给你递了话。逐条接住：",
		"- 要动手的：自己安排；",
		"- 要回话的：用 send_to_agent 回给对方；",
		"- 要主人知情的：在回复里说清楚。",
		"不要把原文整段转述给主人。",
		"",
		"来信：",
	].join("\n");
	const lines = payloads.map((payload) => {
		const domain = payload.fromDomain?.trim() || "无领域";
		return `- 来自执事 ${payload.fromName}（${domain}）：${payload.text}`;
	});
	return [header, ...lines].join("\n");
}

/**
 * worker 决策上报的唤醒提示词（批2，固定字节可单测）。
 *
 * 派活方执事（或总管）收到后自己跑一轮决定答不答得了：
 * - 答得了 → respond_escalation {ticketId, action:"answer", answer}；
 * - 答不了（要花钱 / 主人私事 / 自己没上下文）→ action:"escalate" 升级给主人。
 * 工具在按需池里：没加载先 tool_search。全程不要直接给 worker 发消息
 * （send_to_agent 对非来源会话会被拒），答复只走 respond_escalation。
 */
export function buildEscalationWakePrompt(payloads: AgentMessageWakePayload[]): string {
	const header = [
		"[Escalation wake context]",
		"turnAuthority: autonomous",
		"",
		"你派出去的工人上报了一个要拍板 / 要问人的问题，等你的答复才继续干活。逐条处理：",
		"- 你能拍板的：用 respond_escalation 答复（action=\"answer\"），答复要具体到工人能直接照做；",
		"- 答不了的（要花钱 / 主人的私事 / 你没有上下文）：respond_escalation（action=\"escalate\"）升级给主人，不要硬答；",
		"- respond_escalation 在按需工具池里，没加载就先 tool_search({name:\"respond_escalation\"})。",
		"不要用 send_to_agent 直接给工人发消息（会被拒），也不要重复派单。",
		"",
		"本批上报：",
	].join("\n");
	const lines = payloads.map((payload) => {
		const domain = payload.fromDomain?.trim() || "无领域";
		const head = `- 单 ${payload.ticketId ?? "?"}（${domain}，紧急度 ${payload.urgency ?? "normal"}）：${payload.question ?? payload.text}`;
		const context = payload.context ? `\n  背景：${payload.context}` : "";
		const options =
			payload.options && payload.options.length > 0
				? `\n  候选：${payload.options.join(" / ")}`
				: "";
		return `${head}${context}${options}`;
	});
	return [header, ...lines].join("\n");
}

/**
 * 一批信封 → 唤醒提示词（批3）。纯 delegation 批逐字节走 buildWakePrompt（回归底线）；
 * 混批 / 纯新来源按来源分节拼接，每节自带固定头。
 */
export function buildEnvelopeWakePrompt(envelopes: WakeEnvelope[]): string {
	const delegationPayloads = envelopes.filter(isDelegationEnvelope).map((e) => e.payload);
	const bgPayloads = envelopes
		.filter((e): e is Extract<WakeEnvelope, { source: "bgjob" }> => e.source === "bgjob")
		.map((e) => e.payload);
	const messagePayloads = envelopes
		.filter((e): e is Extract<WakeEnvelope, { source: "agent-message" }> => e.source === "agent-message")
		.map((e) => e.payload);
	if (bgPayloads.length === 0 && messagePayloads.length === 0) {
		return buildWakePrompt(delegationPayloads);
	}
	const sections: string[] = [];
	if (delegationPayloads.length > 0) sections.push(buildWakePrompt(delegationPayloads));
	if (bgPayloads.length > 0) sections.push(buildBgJobWakePrompt(bgPayloads));
	if (messagePayloads.length > 0) sections.push(buildAgentMessageWakePrompt(messagePayloads));
	return sections.join("\n\n");
}

/**
 * 取走即清空（纯函数，单测直接调）。没有该会话的 pending → 空数组。
 * 批3 泛化为信封类型参数：delegation 测试仍可用 `Map<number, DelegationReport[]>` 直调。
 */
export function collectPending<T>(
	store: Map<number, T[]>,
	conversationId: number,
): T[] {
	const items = store.get(conversationId);
	if (!items || items.length === 0) {
		store.delete(conversationId);
		return [];
	}
	store.delete(conversationId);
	return items;
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

/** 入队共享段（批3）：追加信封 → 落盘 → 没有定时器 / 链在跑就排一个 2 秒防抖。 */
function enqueueWake(
	conversationId: number,
	envelope: WakeEnvelope,
	deps: DelegationWakeDeps,
): void {
	const list = pending.get(conversationId);
	if (list) list.push(envelope);
	else pending.set(conversationId, [envelope]);
	persistWakeQueue();
	// 已有定时器 / 正在跑链：只追加，接住由那条链负责
	if (timers.has(conversationId) || running.has(conversationId)) return;
	scheduleFlush(conversationId, deps);
}

/**
 * 派活汇报写回后的唤醒触发（fire-and-forget）。
 *
 * **绝不抛**：调用方在汇报回调里，唤醒出错不能拖累汇报。守卫不过 = 静默返回（= 改动前行为）。
 * 通过守卫后把汇报**包成 delegation 信封**追加进 pending（批3），该会话没有定时器就排一个
 * 2 秒防抖。
 *
 * 路由（批5-C 起两条）：
 * - 有 canonical 主会话 → 唤醒执事 canonical（批 29 提交不变，flush 时仍按 canonical 复查；
 *   信封里的 targetPartnerId 不参与 delegation 的路由判断）。
 * - canonical 解析为 null（普通 worker 对话 / 群成员 / 例行专线等能派活的会话）→
 *   唤醒**派活的会话自己**（targetConversationId）。（唤醒回滚开关 2026-11-21 退役。）
 */
export function wakeOnDelegationReport(
	conversationId: number,
	report: DelegationReport,
	deps: DelegationWakeDeps = defaultDeps,
): void {
	try {
		// 执事体系关着：不投（会话路径也属于派活体系）；唤醒回滚开关 2026-11-21 已退役
		if (!deps.companionsEnabled()) return;
		// 有 canonical 归属：沿用批 29 的守卫（active 检查）
		const partnerId = deps.partnerIdOfSession(conversationId);
		if (partnerId !== null) {
			if (deps.partnerStatus(partnerId) !== "active") return;
			enqueueWake(
				conversationId,
				{ source: "delegation", targetPartnerId: partnerId, payload: report },
				deps,
			);
			return;
		}
		// 批5-C：无 canonical 归属 → 唤醒派活会话自己（同一会话路径 / 同一提示词）
		enqueueWake(
			conversationId,
			{
				source: "delegation",
				targetPartnerId: "",
				targetConversationId: conversationId,
				payload: report,
			},
			deps,
		);
	} catch {
		// 唤醒是增值动作，任何异常都不外抛
	}
}

/**
 * 后台任务完成 / 输出变化的唤醒触发（批3，fire-and-forget，绝不抛）。
 *
 * 目标 = 发起该命令的会话所属执事（任意 role 链接都算归属，`partnerIdOfAnySession`），
 * 唤醒轮落在该执事的 canonical 主会话（flush 时 ensureSession 负责取/补建）。
 * 批5：命令在无主会话（worker 任务对话 / 普通对话）里跑的——解析不出执事——
 * 就**唤醒发起命令的会话本身**（`targetConversationId`，flush 走 continueConversation，
 * 忙时按批1 缺省 steer 插话）。（BG_JOB_WAKE_SESSION / WAKE_PIPELINE_V2 回滚开关
 * 2026-11-21 退役，无主会话恒投。）
 */
export function wakeOnBgJobFinish(
	conversationId: number,
	payload: BgJobWakePayload,
	deps: DelegationWakeDeps = defaultDeps,
): void {
	try {
		// 执事体系关着时不解析归属（回批3：整条 bgjob 唤醒不投）；但无主会话路径
		// 不依赖执事体系，下面照样可以投给会话自己。
		const partnerId = deps.companionsEnabled()
			? (deps.partnerIdOfAnySession?.(conversationId) ?? null)
			: null;
		if (partnerId === null) {
			enqueueWake(
				conversationId,
				{
					source: "bgjob",
					targetPartnerId: "",
					targetConversationId: conversationId,
					payload,
				},
				deps,
			);
			return;
		}
		if (deps.partnerStatus(partnerId) !== "active") return;
		enqueueWake(
			conversationId,
			{ source: "bgjob", targetPartnerId: partnerId, payload },
			deps,
		);
	} catch {
		// 唤醒是增值动作，任何异常都不外抛
	}
}

/**
 * agent→agent 递话的唤醒触发（批3 信封形状；**当前无调用方**）。
 *
 * 2026-11-19 核实：send_to_agent 的送达本身已能开轮（durable submit 空闲即 startRun、
 * 忙时进 inbox（批5 起缺省 steer）在本轮下一个边界自动带上），到达路径只剩
 * "对端还没有会话"一个空缺，由装配层 deliverPartnerRelay 补建会话解决——所以这条
 * 来源本批不接线。入口与提示词保留，给后续批次做确定性接线（例如递话失败后的兜底唤醒）。
 *
 * 入队键 = 对端 canonical 主会话的内部 id（`sessionIdOfPartner`）；对端还没有会话时
 * 不投（递话通道自己会报"还没有自己的会话"，与改动前一致）。
 */
export function wakeOnAgentMessage(
	targetPartnerId: string,
	payload: AgentMessageWakePayload,
	deps: DelegationWakeDeps = defaultDeps,
): void {
	try {
		if (!deps.companionsEnabled()) return;
		if (deps.partnerStatus(targetPartnerId) !== "active") return;
		const sessionId = deps.sessionIdOfPartner?.(targetPartnerId) ?? null;
		if (sessionId === null) return;
		enqueueWake(
			sessionId,
			{ source: "agent-message", targetPartnerId, payload },
			deps,
		);
	} catch {
		// 唤醒是增值动作，任何异常都不外抛
	}
}

/**
 * 会话路径的唤醒轮（批5）：直接续跑发起命令的会话本身。
 * `continueConversation` 内部会吞掉异常只 warn，所以这里只把**抛出**归为失败
 * （回灌 + 重排仍走既有链）；提交成功但模型轮失败时正文已 durable 落库，不重复投递。
 */
async function runSessionWake(
	conversationId: number,
	prompt: string,
	deps: DelegationWakeDeps,
): Promise<PartnerTurnResult> {
	if (!deps.continueSession) {
		return { ok: false, text: "", error: "会话唤醒路径未装配" };
	}
	try {
		await deps.continueSession(conversationId, prompt);
		return { ok: true, text: "" };
	} catch (error) {
		return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 执行一轮唤醒链（防抖到点 / 单测直接调）。
 *
 * 每轮重新过守卫链；执事路径忙则每 2 秒重查（上限 150 次）；会话路径不做忙退避
 * （提交按批1 缺省 steer 插话）。跑完若 pending 又有新货就继续，单链最多
 * `MAX_CHAIN_FLUSHES` 轮。全程兜异常，不向事件循环抛未捕获拒绝。
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
			// 批3：守卫按 source 分支（delegation 仍锁 canonical，新来源按 targetPartnerId 路由）
			// 批5：无主会话的 bgjob 返回 {kind:"session"}，直接续跑会话本身
			const target = guardWake(conversationId, pending.get(conversationId) ?? [], deps);
			if (target === null) {
				clearConversation(conversationId);
				return;
			}
			if (target.kind === "partner") {
				const chat = await deps.ensureSession(target.partnerId);
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
			} else {
				// 批5 会话路径：不做忙退避——continueConversation 的提交在忙时天然跟随
				// 批1 缺省 steer（插话式唤醒）。只复查目标会话还在不在：已删 → target_gone
				// 丢弃（重启恢复的条目不许炸）；检查本身读失败 ≠ 已删，交给重排留到下一轮。
				let exists: boolean | null;
				try {
					exists = deps.sessionExists ? await deps.sessionExists(target.conversationId) : false;
				} catch {
					exists = null;
				}
				if (exists === null) {
					console.warn(
						`[wake] 会话 ${conversationId} 唤醒目标存在性检查失败，改 10 分钟后重试 tickets=${pending.get(conversationId)?.length ?? 0}`,
					);
					requeueConversation(conversationId, deps, "存在性检查失败");
					return;
				}
				if (!exists) {
					console.log(
						`[wake] 会话 ${target.conversationId} 已不存在（target_gone），丢弃唤醒 tickets=${pending.get(conversationId)?.length ?? 0}`,
					);
					clearConversation(conversationId);
					return;
				}
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

			const envelopes = collectPending(pending, conversationId);
			persistWakeQueue();
			rounds += 1;
			const started = Date.now();
			const prompt = buildEnvelopeWakePrompt(envelopes);
			const result =
				target.kind === "partner"
					? await deps.runTurn(target.partnerId, prompt, {
							authority: "autonomous",
							quiet: false,
							sessionMode: "persistent",
						})
					: await runSessionWake(target.conversationId, prompt, deps);
			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			if (result.ok) {
				// 重排计数只在**队列真正清空**时归零：链式唤醒每一轮都是 ok 的，按轮清零
				// 会让保险丝重排永远攒不起次数（2026-11-15 首轮实现踩过，测试抓的）。
				if ((pending.get(conversationId)?.length ?? 0) === 0) requeues.delete(conversationId);
				console.log(
					`[wake] 会话 ${conversationId} 唤醒轮 ok tickets=${envelopes.length} 耗时${seconds}s`,
				);
				// 批3：这是既有"主动开口时机"之一——唤醒轮成功后再看要不要发一条挂念。
				// 内部自判模块 / 子开关 / 一天一条；失败只返回 false，不影响唤醒链。
				// 批5：挂念只属于执事；会话路径没有执事可挂念。
				if (target.kind === "partner") {
					try {
						await deps.nudge?.(target.partnerId);
					} catch {
						// 挂念是增值动作，不外抛
					}
				}
			} else {
				console.warn(
					`[wake] 会话 ${conversationId} 唤醒轮失败: ${oneLine(result.error ?? "未知错误")}`,
				);
				// 失败回灌队首 + 重排（2026-11-15 送达兜底 §C.4）：取走的信封不放回去
				// 就真丢了；链尾的 finally 看到已有定时器不会重复排。
				const waiting = pending.get(conversationId) ?? [];
				pending.set(conversationId, [...envelopes, ...waiting]);
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
