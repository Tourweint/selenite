/**
 * 决策上报的路由与台账（2026-11-19 批2：worker→总管→用户上报链，方案 §2）。
 *
 * worker 的 escalation 事件到达宿主后有三跳：
 * 1. **事件到会话**：chancellor → translate → emitDelegation（delegation-start-delegation.ts），
 *    派活方会话出上报卡（SSE escalation 帧，shared 契约）；
 * 2. **路由到上级**（本模块，经 watchAllDelegationEvents 全局订阅）：
 *    派活方会话所属执事 → 批3 的 `wakeOnAgentMessage` 信封（source=agent-message，
 *    kind=escalation）唤起一轮；派活方是总管主对话（执事体系外的普通会话）→
 *    `continueConversation` 直接起一轮。两者都让上级用 `respond_escalation` 工具
 *    决定"我答"还是"升级给主人"；
 * 3. **答复回 worker**：answer 经批1 插话通道（`forwardWorkerMessageAction` → steer）
 *    投回 worker，worker 续跑；升级 = 现有 ask_user 问答链，用户答复后同路投回。
 *
 * 限流：每张单同时 1 条活跃上报（重复直接拒给 worker 一句"继续干"）；
 * 每张单上限 `ESCALATION_MAX_PER_TASK`（默认 5），超限**跳过总管**直达用户。
 * 台账：谁答的（总管/主人）写进 delegation_messages 现有留言表（direction=in），
 * 答复正文带署名进 worker 上下文，最终汇报自然带出。
 *
 * 刻意不做（方案 §明确不做）：持久化状态机 / 投递结算——注册表是**进程内存**，
 * 重启丢活跃记录（worker 侧等待由"宿主管道关闭即退场"兜底）；上报列表读 SSE
 * 事件即可，这里只存"活跃中"的最小集。
 *
 * 依赖纪律：本模块被 tools.ts / approval-api.ts / escalation-api.ts 引用。
 * agent.ts / delegation-actions.ts / delegation-wake.ts 都**懒加载动态 import**
 * （它们的加载面会拉回 tools.ts，静态引就成环；delegation-actions 的 report
 * 回调、lifecycle-harness 的 workerSteer 注入是同一先例）。ask-user /
 * delegation-messages / delegation-delegation-kickoff 无环，静态引。
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { watchAllDelegationEvents, type DelegationEvent } from "./delegation.ts";
import { delegationMessages } from "./delegation-messages.ts";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { approvalStore } from "./approvals.ts";
import { approvalTimeoutSeconds } from "./approval-policy.ts";
import { askUserArgsSummary, validateAskUserArgs } from "./ask-user.ts";
import { encodeToolResult, err, ok, type ToolResult } from "./tool-result.ts";

/** 统一契约形态的工具输出（与 tools.ts 的 textToolResult 同构；tools.ts 那份不导出）。 */
function textToolResult<T>(result: ToolResult<T>) {
	return { output: [{ type: "text" as const, text: encodeToolResult(result) }] };
}

/** chancellor 派活总闸：与 agent/assist.ts 的 CHANCELLOR_ENABLED 同一读法。 */
function chancellorEnabled(): boolean {
	return (process.env.CHANCELLOR_ENABLED?.trim() || "true").toLowerCase() !== "false";
}

/** chancellorWorkRoot（delegation-delegation-kickoff 同一落点）；本模块只给转发用。 */
function chancellorWorkRootOf(): string {
	const configured = process.env.CHANCELLOR_WORK_ROOT?.trim();
	// 与 delegation-delegation-kickoff.chancellorWorkRoot 同口径（resolve(cwd 相对 runs)）。
	// 不静态 import 是为了少一条加载边；口径漂移由这条注释钉住（文档滞后即 bug）。
	return resolve(configured || join(process.cwd(), "runs"));
}

/** 每张单的上报上限；0 = 不限（不推荐，仅测试用）。非数字 / 负数回落默认 5。 */
export function escalationMaxPerTask(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.ESCALATION_MAX_PER_TASK?.trim();
	if (raw === undefined || raw === "") return 5;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return 5;
	return Math.floor(value);
}

/** 一条活跃上报（进程内存；重启即清，worker 侧等待由管道关闭兜底）。 */
export interface ActiveEscalation {
	escalationId: string;
	ticketId: string;
	/** 派活方会话（内部 id）：上报卡所在、ask 卡要落的会话。 */
	conversationId: number;
	domain: string;
	question: string;
	context: string;
	options: string[];
	urgency: "low" | "normal" | "high";
	at: string;
	/** true = 已升级给用户（ask 卡已挂，等 /answer）；总管代答轮不再重复起。 */
	escalatedToUser: boolean;
}

const activeByTicket = new Map<string, ActiveEscalation>();
/** 每张单累计受理的上报数（限流用；进程内存，重启清零——与注册表同寿命）。 */
const countsByTicket = new Map<string, number>();
/** 升级给用户的 ask callId → 单号（/answer 答复后据此把答案投回 worker）。 */
const askLinkByCallId = new Map<string, string>();

export function activeEscalationOf(ticketId: string): ActiveEscalation | null {
	return activeByTicket.get(ticketId) ?? null;
}

export function activeEscalationByAskCallId(callId: string): ActiveEscalation | null {
	const ticketId = askLinkByCallId.get(callId);
	return ticketId ? (activeByTicket.get(ticketId) ?? null) : null;
}

/** 活跃上报投影（上报卡刷新 / 列表端点）；conversationId 缺省 = 全部。 */
export function listActiveEscalations(conversationId?: number): ActiveEscalation[] {
	return [...activeByTicket.values()]
		.filter((record) => conversationId === undefined || record.conversationId === conversationId)
		.sort((a, b) => (a.at < b.at ? -1 : 1));
}

/** 测试用：清空注册表（生产不需要）。 */
export function resetEscalationState(): void {
	activeByTicket.clear();
	countsByTicket.clear();
	askLinkByCallId.clear();
}

/** 可注入的内部实现（单测换假件，不起服务）。 */
export interface EscalationRoutingDeps {
	companionsEnabled(): boolean;
	canonicalPartnerIdOfSession(conversationId: number): string | null;
	partnerStatus(partnerId: string): string | null;
	/** 每张单的上报上限（缺省读 ESCALATION_MAX_PER_TASK）；注入是为单测隔离 env。 */
	maxPerTask(): number;
	/** 批3 信封唤醒（执事派单方）；实现方懒加载 delegation-wake。 */
	wakePartner(targetPartnerId: string, payload: Record<string, unknown>): void;
	/** 总管主对话（非执事体系）的续跑轮；实现方懒加载 agent。 */
	continueTurn(conversationId: number, text: string): void;
	/** 现有 ask_user 管线：落 pending + 发卡。 */
	createAsk(input: {
		conversationId: number;
		question: string;
		options?: string[];
	}): { ok: true; callId: string } | { ok: false; message: string };
	/** 批1 插话通道：答复投回 worker。 */
	forwardToWorker(
		ticketId: string,
		text: string,
	): Promise<{ ok: boolean; error?: string; message?: string }>;
	log(line: string): void;
}

export const defaultEscalationDeps: EscalationRoutingDeps = {
	companionsEnabled: () => COMPANIONS_ENABLED,
	maxPerTask: () => escalationMaxPerTask(),
	canonicalPartnerIdOfSession: (conversationId) => {
		try {
			return partnersStore().canonicalPartnerIdOfSession(conversationId);
		} catch {
			return null;
		}
	},
	partnerStatus: (partnerId) => {
		try {
			return partnersStore().get(partnerId)?.status ?? null;
		} catch {
			return null;
		}
	},
	wakePartner: (targetPartnerId, payload) => {
		void import("./delegation-wake.ts").then((wake) =>
			wake.wakeOnAgentMessage(
				targetPartnerId,
				payload as unknown as Parameters<typeof wake.wakeOnAgentMessage>[1],
			),
		);
	},
	continueTurn: (conversationId, text) => {
		// continueConversation 在 agent/session-transcript.ts（agent.ts 不再转出口）。
		void import("./agent/session-transcript.ts").then(({ continueConversation }) =>
			continueConversation(conversationId, text),
		);
	},
	createAsk: (input) => createAskUserPendingForEscalation({ ...input, callId: randomUUID() }),
	forwardToWorker: (ticketId, text) =>
		import("./delegation-actions.ts")
			.then(({ forwardWorkerMessageAction }) =>
				forwardWorkerMessageAction(chancellorWorkRootOf(), ticketId, { mode: "steer", text }, null),
			)
			.then((result) => {
				const body = result.body as { ok?: boolean; error?: string; message?: string };
				return { ok: body.ok === true, error: body.error, message: body.message };
			}),
	log: (line) => console.log(line),
};

let routingDeps: EscalationRoutingDeps = defaultEscalationDeps;

/** 测试注入换件。 */
export function setEscalationRoutingDeps(deps: EscalationRoutingDeps): void {
	routingDeps = deps;
}

/** createAskUserPending 的薄封装：callId 由路由层生成（工具调用没有真实 api.callId 可借）。 */
function createAskUserPendingForEscalation(input: {
	conversationId: number;
	callId: string;
	question: string;
	options?: string[];
}): { ok: true; callId: string } | { ok: false; message: string } {
	const validation = validateAskUserArgs({
		question: input.question,
		...(input.options && input.options.length >= 2 ? { options: input.options.slice(0, 3) } : {}),
	});
	if (!validation.ok) return { ok: false, message: validation.message };
	const store = approvalStore();
	const existing = store
		.pendingOf(input.conversationId)
		.find((record) => record.kind === "ask_user");
	if (existing) {
		return { ok: false, message: "已经有一个问题在等用户回答；一次只问一个。" };
	}
	const timeoutS = approvalTimeoutSeconds(process.env);
	const pending = store.create({
		callId: input.callId,
		conversationId: input.conversationId,
		tool: "ask_user",
		args: askUserArgsSummary(validation.value),
		timeoutMs: timeoutS * 1000,
		kind: "ask_user",
	});
	// 与 ask_user 工具同一事件通道：客户端把 tool=ask_user 画成问题卡。
	void import("./delegation.ts").then(({ emitDelegation }) =>
		emitDelegation(input.conversationId, {
			type: "approval",
			callId: pending.record.callId,
			tool: pending.record.tool,
			args: pending.record.args,
			deadlineAt: pending.record.deadlineAt,
		}),
	);
	return { ok: true, callId: pending.record.callId };
}

// ── 路由核心 ─────────────────────────────────────────────────

/**
 * 全局订阅入口（index.ts 启动段调一次；重复调用幂等）。
 * escalation 事件在这里做注册 / 限流 / 唤醒；其余事件原样忽略。
 */
let routingInitialized = false;

export function initEscalationRouting(deps: EscalationRoutingDeps = routingDeps): void {
	if (routingInitialized) return;
	routingInitialized = true;
	watchAllDelegationEvents((event: DelegationEvent, conversationId: number) => {
		if (event.type !== "escalation") return;
		try {
			onEscalationEvent(event, conversationId, deps);
		} catch (error) {
			deps.log(
				`[escalation] 路由失败 ticket=${event.ticketId.slice(0, 12)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	});
}

/** 单条上报的路由判定（导出方便单测直喂）。 */
export function onEscalationEvent(
	event: Extract<DelegationEvent, { type: "escalation" }>,
	conversationId: number,
	deps: EscalationRoutingDeps = routingDeps,
): void {
	if (activeByTicket.has(event.ticketId)) {
		// 限流一：每张单同时 1 条活跃上报。worker 侧本就该拦（escalate 工具），这里兜底。
		rejectToWorker(event.ticketId, "已有一条上报在等答复", deps);
		return;
	}
	const max = deps.maxPerTask();
	const count = countsByTicket.get(event.ticketId) ?? 0;
	if (max > 0 && count >= max) {
		// 限流二：超上限直达用户（跳过总管代答轮）。
		deps.log(
			`[escalation] 上报超限 ticket=${event.ticketId.slice(0, 12)} count=${count + 1}/${max}，直达用户`,
		);
		register(event, conversationId);
		escalateToUser(event.ticketId, deps);
		return;
	}

	register(event, conversationId);
	countsByTicket.set(event.ticketId, count + 1);
	// 自动总管代答轮：派活方是执事 → 批3 信封；是总管主对话 → 直接续跑一轮。
	const partnerId = deps.canonicalPartnerIdOfSession(conversationId);
	if (partnerId && deps.companionsEnabled() && deps.partnerStatus(partnerId) === "active") {
		deps.wakePartner(partnerId, escalationWakePayload(event));
		deps.log(
			`[escalation] 已唤醒执事代答 ticket=${event.ticketId.slice(0, 12)} partner=${partnerId}`,
		);
		return;
	}
	deps.continueTurn(conversationId, buildChiefEscalationPrompt(event));
	deps.log(
		`[escalation] 已在派活会话起总管代答轮 ticket=${event.ticketId.slice(0, 12)} conversation=${conversationId}`,
	);
}

function register(
	event: Extract<DelegationEvent, { type: "escalation" }>,
	conversationId: number,
): void {
	activeByTicket.set(event.ticketId, {
		escalationId: event.escalationId,
		ticketId: event.ticketId,
		conversationId,
		domain: event.domain,
		question: event.question,
		context: event.context,
		options: event.options ?? [],
		urgency: event.urgency,
		at: new Date().toISOString(),
		escalatedToUser: false,
	});
}

/** agent-message 信封的 escalation 载荷（批3 形状 + 批2 附加字段）。 */
function escalationWakePayload(
	event: Extract<DelegationEvent, { type: "escalation" }>,
): Record<string, unknown> {
	const options = event.options ?? [];
	return {
		fromPartnerId: "",
		fromName: "工人上报",
		fromDomain: event.domain || null,
		text: event.question,
		kind: "escalation",
		escalationId: event.escalationId,
		ticketId: event.ticketId,
		question: event.question,
		context: event.context,
		...(options.length > 0 ? { options } : {}),
		urgency: event.urgency,
	};
}

/** 总管主对话（非执事体系）用的上报提示词：与 delegation-wake 的上报段同一口径。 */
export function buildChiefEscalationPrompt(
	event: Pick<
		Extract<DelegationEvent, { type: "escalation" }>,
		"ticketId" | "domain" | "question" | "context" | "options" | "urgency"
	>,
): string {
	const options = event.options ?? [];
	const lines = [
		"[Escalation context]",
		"",
		`你派出去的工人（单 ${event.ticketId}，${event.domain || "无领域"}，紧急度 ${event.urgency}）上报了一个要拍板的问题，等答复才继续干活：`,
		`问题：${event.question}`,
		event.context ? `背景：${event.context}` : "",
		options.length > 0 ? `候选：${options.join(" / ")}` : "",
		"",
		"你能拍板的：用 respond_escalation 答复（action=\"answer\"）；答不了（要花钱 / 主人的私事 / 你没有上下文）就升级给主人（action=\"escalate\"），不要硬答。",
		"respond_escalation 在按需工具池里，没加载就先 tool_search({name:\"respond_escalation\"})。不要用 send_to_agent 直接给工人发消息。",
	];
	return lines.filter((line) => line !== "").join("\n");
}

/** 拒给 worker 一句（限流 / 关闸时别让它干等）：复用批1 steer 通道。 */
function rejectToWorker(ticketId: string, reason: string, deps: EscalationRoutingDeps): void {
	void deps
		.forwardToWorker(
			ticketId,
			`[插话]\n（系统）这次上报没有受理（${reason}）：不要等待答复，按已有信息继续推进；确实要人的部分写进 REPORT.md 的 attention（status 用 blocked + question）。`,
		)
		.then((result) => {
			deps.log(
				`[escalation] 上报被拒 ticket=${ticketId.slice(0, 12)} reason=${reason} 投回=${result.ok ? "ok" : "fail"}`,
			);
		})
		.catch((error: unknown) => {
			deps.log(
				`[escalation] 拒收回投失败 ticket=${ticketId.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
}

// ── 答复与升级（respond_escalation 工具 / 上报卡按钮 / ask /answer 共用）────

/**
 * 总管代答（或用户答复）后投回 worker：批1 steer 通道 + 署名 + 台账。
 * answeredBy: chief = 总管代答；user = 主人亲答（升级链的 /answer）。
 * 成功后清活跃记录、清 ask 关联。worker 不在跑（已退场）也照清——
 * 老通道（attention / 任务专线回话）会接管后续。
 */
export async function answerEscalation(
	ticketId: string,
	answer: string,
	answeredBy: "chief" | "user",
	deps: EscalationRoutingDeps = routingDeps,
): Promise<{ ok: boolean; error?: string }> {
	const record = activeByTicket.get(ticketId);
	if (!record) return { ok: false, error: "no_active_escalation" };
	if (answer.trim() === "") return { ok: false, error: "bad_request" };
	const label = answeredBy === "chief" ? "总管" : "主人";
	const steerText = `[上报答复·${label}] ${answer.trim()}`;
	const result = await deps.forwardToWorker(ticketId, steerText);
	// 台账（批2 审计口径）：谁答的、答了什么，落 delegation_messages（direction=in），
	// 任务详情的留言流里与 out/in 成对可读；正文照留言表惯例原样入库。
	try {
		delegationMessages().append({
			ticketId,
			direction: "in",
			fromKind: "system",
			fromName: label,
			body: steerText,
			createdAt: new Date().toISOString(),
		});
	} catch (error) {
		deps.log(
			`[escalation] 台账落库失败（不挡答复）: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	clearEscalation(ticketId);
	deps.log(
		`[escalation] 答复 ticket=${ticketId.slice(0, 12)} by=${label} chars=${answer.trim().length} 投回=${result.ok ? "ok" : "fail"}`,
	);
	return { ok: true, ...(result.ok ? {} : { error: result.error ?? "worker_not_running" }) };
}

/**
 * 升级给用户：现有 ask_user 管线，问题卡挂到派活方会话（用户在那里答）。
 * 成功后标记 escalatedToUser，并登记 callId → ticketId（/answer 据此投回 worker）。
 */
export function escalateToUser(
	ticketId: string,
	deps: EscalationRoutingDeps = routingDeps,
): { ok: boolean; callId?: string; error?: string; message?: string } {
	const record = activeByTicket.get(ticketId);
	if (!record) return { ok: false, error: "no_active_escalation" };
	const created = deps.createAsk({
		conversationId: record.conversationId,
		question: buildAskQuestion(record),
		...(record.options.length >= 2 ? { options: record.options.slice(0, 3) } : {}),
	});
	if (!created.ok) {
		deps.log(`[escalation] 升级失败 ticket=${ticketId.slice(0, 12)}: ${created.message}`);
		return { ok: false, error: "ask_rejected", message: created.message };
	}
	record.escalatedToUser = true;
	askLinkByCallId.set(created.callId, ticketId);
	deps.log(`[escalation] 已升级给用户 ticket=${ticketId.slice(0, 12)} callId=${created.callId}`);
	return { ok: true, callId: created.callId };
}

/** ask 卡的问题正文：问题 + 背景（超 ask_user 上限时由 validate 拒，这里先压行）。 */
function buildAskQuestion(record: ActiveEscalation): string {
	const head = `【工人上报 · 单 ${record.ticketId.slice(0, 12)}】${record.question}`;
	const body = record.context ? `\n背景：${record.context.replace(/\s+/g, " ").trim()}` : "";
	return `${head}${body}`;
}

/**
 * ask_user 的答复钩子（approval-api /answer 调）：这是升级链的答复，同路投回 worker。
 * 不在关联表里 → 不是上报升级，返回 false（调用方照旧走既有续跑）。
 */
export async function onAskAnswered(callId: string, answer: string): Promise<boolean> {
	const record = activeEscalationByAskCallId(callId);
	if (!record) return false;
	const result = await answerEscalation(record.ticketId, answer, "user");
	return result.ok || result.error === "worker_not_running";
}

/** 清活跃记录（答完即清；ask 关联一并摘除）。 */
export function clearEscalation(ticketId: string): void {
	for (const [callId, linked] of askLinkByCallId) {
		if (linked === ticketId) askLinkByCallId.delete(callId);
	}
	activeByTicket.delete(ticketId);
}

/** 手动"总管代答"（上报卡按钮）：代答轮没跑成 / 想再催一轮时重发唤醒。 */
export function triggerChiefTurn(
	ticketId: string,
	deps: EscalationRoutingDeps = routingDeps,
): { ok: boolean; error?: string } {
	const record = activeByTicket.get(ticketId);
	if (!record) return { ok: false, error: "no_active_escalation" };
	if (record.escalatedToUser) return { ok: false, error: "already_escalated" };
	const partnerId = deps.canonicalPartnerIdOfSession(record.conversationId);
	if (partnerId && deps.companionsEnabled() && deps.partnerStatus(partnerId) === "active") {
		deps.wakePartner(partnerId, {
			...escalationWakePayload({
				type: "escalation",
				ticketId: record.ticketId,
				domain: record.domain,
				escalationId: record.escalationId,
				question: record.question,
				context: record.context,
				options: record.options,
				urgency: record.urgency,
			}),
		});
		return { ok: true };
	}
	deps.continueTurn(
		record.conversationId,
		buildChiefEscalationPrompt({
			ticketId: record.ticketId,
			domain: record.domain,
			question: record.question,
			context: record.context,
			options: record.options,
			urgency: record.urgency,
		}),
	);
	return { ok: true };
}

/** respond_escalation 工具与本模块之间的装配开关：chancellor 关了就没有上报链。
 *  （ESCALATION_CHAIN_ENABLED 回滚开关 2026-11-21 退役，上报链恒开。） */
export function respondEscalationAvailable(): boolean {
	return chancellorEnabled();
}

// ── respond_escalation 工具 ──────────────────────────────────
//
// 放本模块不进 tools.ts：上报语义（谁在答、答给谁、怎么投回）都在这里，
// tools.ts 只负责注册。工具不写盘、不起进程、不派活——只经批1 steer 通道
// 投一条答复 / 把问题转挂 ask_user 卡，不进 WRITE_TOOLS / 高危清单。
// 按需池默认成员（tool-pool）：初始不进请求，唤醒提示词引导 tool_search 加载，
// 不打上游 prompt cache。

/** respond_escalation 工具描述原文（缓存前缀资产：改动要在变更记录单列）。 */
export const RESPOND_ESCALATION_DESCRIPTION =
	"答复一条工人上报（决策上报链）。工人上报问题后挂起等答复，你必须在**这一轮**给出结论：" +
	"自己能拍板的用 action=\"answer\"（答复要具体到工人能直接照做，不复述问题）；" +
	"答不了的（要花钱 / 主人的私事 / 你没有上下文）用 action=\"escalate\" 升级给主人，不要硬答。" +
	"一次只答一条上报；不要用 send_to_agent 直接给工人发消息。";

export function createRespondEscalationTool(): ToolRegistration {
	return defineTool({
		name: "respond_escalation",
		description: RESPOND_ESCALATION_DESCRIPTION,
		parameters: Type.Object({
			ticketId: Type.String({
				description: "上报的任务单号（上报卡 / 唤醒提示词里给的单号）",
			}),
			action: Type.Union([Type.Literal("answer"), Type.Literal("escalate")], {
				description: "answer=你拍板并给答复；escalate=升级给主人",
			}),
			answer: Type.Optional(
				Type.String({
					description: "action=answer 时必填：给工人的答复，具体到能直接照做（≤1000 字）",
				}),
			),
		}),
		execute: async (args) => {
			const ticketId = String(args.ticketId ?? "").trim();
			const record = activeEscalationOf(ticketId);
			if (!record) {
				return textToolResult(
					err(
						"no_active_escalation",
						"这张单当前没有在等答复的上报（可能已被答复、超限转用户，或服务重启过）。",
						"先确认单号；确实要给这张单补话，在任务详情的回话入口说。",
					),
				);
			}
			if (args.action === "answer") {
				const answer = typeof args.answer === "string" ? args.answer.trim() : "";
				if (!answer) {
					return textToolResult(
						err("bad_request", "action=answer 需要非空的 answer；答不了就用 action=escalate 升级。"),
					);
				}
				const result = await answerEscalation(ticketId, answer, "chief");
				if (!result.ok) {
					return textToolResult(
						err(result.error ?? "forward_failed", "答复没有送出去，工人侧可能已退场。"),
					);
				}
				return textToolResult(
					ok({
						status: "answered",
						by: "chief",
						message:
							result.error === "worker_not_running"
								? "答复已记账；工人此刻不在跑（可能已退场），这条答复没有插进它的上下文。"
								: "答复已投给工人，它会继续跑。",
					}),
				);
			}
			// 升级给用户：现有 ask_user 管线，问题卡挂到派活方会话。
			const escalated = escalateToUser(ticketId);
			if (!escalated.ok) {
				return textToolResult(
					err(escalated.error ?? "escalate_failed", escalated.message ?? "升级没有成功。"),
				);
			}
			return textToolResult(
				ok({
					status: "escalated",
					message: "问题已升级给主人（会话里会出现问题卡），主人答复后由系统投回工人；本轮可以先收尾。",
				}),
			);
		},
	});
}
