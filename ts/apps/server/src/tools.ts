import { Type } from "@earendil-works/pi-ai";
import { join } from "node:path";
import {
	CHIEF_PARTNER_ID,
	COMPANIONS_ENABLED,
	effectivePartnerIdOfSession,
	/** 派发权闸（2026-11-06）：开关关 → 不注入执事身份，派单等同旧领域。 */
	ministerDispatchAllowed,
	partnerIdentityForDomain,
	partnersStore,
} from "./partners.ts";
// 执事的建/停/列核心（批次D D3）：与 companion-api 端点共用，工具只做校验与文案包装。
import {
	createMinisterPartner,
	defaultMinisterContext,
	listMinisterPartners,
	setMinisterDispatchAuthority,
	stopMinisterPartner,
	type MinisterContext,
} from "./partner-manage.ts";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { askUserEnabled, createAskUserTool } from "./ask-user.ts";
import { createRespondEscalationTool, respondEscalationAvailable } from "./escalation.ts";
import { executorSummary } from "./executor-config.ts";
import { scopeKey, type MemoryEngine, type MemoryKind, type MemoryScope } from "@lifediary/memory";
// 群组核心（2026-11-07）：建群校验与落库的唯一实现，HTTP 端点共用同一份。
import {
	createGroupChecked,
	defaultGroupContext,
	groupsAvailable,
	resolvePartnerByName,
	resolvePartnersByName,
	type GroupContext,
} from "./group-manage.ts";
// 派活能力（chancellor）。相对路径是刻意的：chancellor 是独立仓库，
// 跑的是 .ts 源码，装进 node_modules 后 node 不会给里面的 .ts 剥类型
// （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），所以不能走 file: 依赖。
// 只有这一处引用它，挪仓库时改这一行。
import { runChancellor } from "../../../packages/chancellor/src/index.ts";
import {
	DOMAIN_PATTERN,
	listManagers,
	validateDomain,
} from "../../../packages/chancellor/src/manager/registry.ts";
import { MAX_TASKS_DEFAULT } from "../../../packages/chancellor/src/config.ts";
import { validateTaskInput } from "../../../packages/chancellor/src/plan.ts";
import {
	WORK_REVIEW_GUIDANCE,
	chancellorWorkRoot,
	emitDelegation,
	normalizeDelegationIsolation,
	normalizeDelegationSteps,
	startDelegation,
	type DelegationMirrorEntry,
	type DelegationReport,
} from "./delegation.ts";
// 证据裁判（2026-11-10 批 14）：验收 fail 时起 read-only 子会话，结论回传 chancellor 返工判定。
// 派活注入项目记忆（2026-11-16）：本机池与外部 CLI 都只读 TASK.md，
// 记忆只能随 requirement 送过去；只取单子所属项目的 scope。
import {
	appendDelegationProjectMemory,
	delegationProjectMemoryText,
} from "./delegation-project-memory.ts";
// 四行回报（REPORT_FOUR_LINES）与裁决纪律（RULING_DISCIPLINE）的全文已挪进内置技能
// skills/delegate.md（2026-11-16 工具裁剪 A），这里不再 import、不再拼进描述尾部。
// 执事自建巡逻核心（2026-11-08 刀二 E4）：与 HTTP 端点共用校验 / 归属 / 上限。
import {
	defaultRoutineManageContext,
	performRoutineAction,
	type RoutineManageAction,
	type RoutineManageResult,
} from "./routine-manage.ts";
import type { RoutineTrigger } from "./partners.ts";
import {
	autoRequestId,
	DelegationReceipts,
	requestFingerprint,
} from "./delegation-receipts.ts";
import { delegationRunSource, priorityOfRunSource, runSourceEnabled } from "./run-source.ts";
import { currentApprovalLevel, currentAuthority } from "./delegation-authority.ts";
import { isRoutineTurn } from "./unattended.ts";
import { pruneSessionMemory } from "./memory-prune.ts";
// 会话归属项目（2026-11-15 项目记忆方案）：remember/recall 的 project scope 解析。
// 零依赖小模块：不能从这里 carry assist（partner-work 等测试动态 import 本文件时
// 刻意不起全局记忆引擎，assist 一加载就握住它们的临时目录）。
import {
	isRecallableProjectId,
	personaProjectIdsOfConversationAsync,
	projectIdOfConversation,
	projectMemoryStateOf,
	recallableProjectIds,
	resolveProjectWriteTarget,
} from "./agent/project-scope.ts";
// 工作履历：派单终态结算落一条 work 记录（2026-11-08 刀二 E2）。
import { recordWorkSettlement } from "./work-record.ts";
// 技能用量账（2026-11-10 批 17 §四）：skill 工具每取一次手册 +1（旁路审计，失败不挡工具）。
import { recordSkillUse } from "./skill-usage.ts";
// 执事间递话（2026-11-08 扫尾批 8d）：通道与工具定义在 partner-relay.ts，
// 送达函数由装配层注入（本文件不持有 harness）。
import { createSendToAgentTool, type PartnerRelayDeps } from "./partner-relay.ts";
// 派活按单指定工作目录 / 权限档的回滚开关（2026-11-17）
// agent 中途播报（2026-11-10 批 13 §三）：工具定义在 progress-report.ts，送达走 delegation 通道。
import { createReportProgressTool } from "./progress-report.ts";
import {
	ProjectError,
	projectsStore,
	resolveChatDir,
	resolveDelegationProject,
	type Project,
	type ProjectRef,
	type ProjectsStore,
} from "./projects.ts";
// 派活路由（2026-11-07 消息即引导与执事直派）：执事在自己领域内不再绕回分管宰相。
import {
	resolveDelegateRouting,
	routingToRequestFields,
} from "./delegate-routing.ts";
// 领域派活入口（2026-11-23）：默认关 = 不暴露 domain、一律直派 worker；代码全保留。
import { domainDispatchEnabled } from "./flags.ts";
// 设备矩阵（2026-11-05 阶段二）：远程分支晚绑定取中继客户端。
// relay-matrix → agent → tools 的环是运行期安全的（agent 绑定只在函数体内解引用）。
import {
	currentRelayClient,
	deviceAutoDispatchEnabled,
	deviceMatrixEnabled,
} from "./relay-config.ts";
import { RelayInvokeError } from "./relay-client.ts";
import { dispatchRemoteDelegation } from "./relay-matrix.ts";
import { nextReminderAt, ReminderTask } from "./reminder.ts";
import type { SkillStore } from "./skills.ts";
import type { SkillAdviceSaveResult } from "./skill-advice.ts";
import { SAVE_REMINDER_ADVICE_DESCRIPTION, type ReminderAdviceSaveResult } from "./reminder-advice.ts";
// 搜索工具（2026-11-07 建；2026-11-20 与课题开关解耦）：从 deps 注入，测试可替换、缺失不注册。
import type { SearchHit, SearchModule } from "./search.ts";
// 会话考古（2026-11-09 T4 §4）：检索实现留在 agent/session-search.ts（只依赖 shared），
// 这里只收注入函数，避免 tools.ts 反向 import session.ts 绕成环。
import type { SessionSearchHit } from "./agent/session-search.ts";
// 工具返回统一契约（2026-11-10 批 16 §一；批 18 §五迁入只读四件）：
// 已迁 = recall_sessions / ask_user / report_progress / recall / web_search / skill。
import { encodeToolResult, err, ok, type ToolResult } from "./tool-result.ts";
import { isDeferredTool } from "./tool-index.ts";
import { recordToolLoad } from "./tool-usage.ts";
import { disabledToolsOfConversation } from "./tool-visibility.ts";

/**
 * 我们自己的工具。
 *
 * 读/写/改/跑命令这四个不再自己写 —— durable 的 `CodingTools` 已经有一版
 * 更完整的（走执行环境、输出分页、图片处理、edit 的差异化写入），
 * 而且它的路径语义跟沙箱/远程环境是一致的。自己重写只会更差。
 *
 * 所以这里是：**记住**、**回忆**、**提醒**（个人 Agent 区别于编码 Agent 的部分）
 * 加一个 **skill**（2026-10-31 方案 D5：技能正文按需取，不进 system）。
 */

const MEMORY_KINDS: MemoryKind[] = ["fact", "episode", "preference", "entity", "intention"];

// ── persona-metric 检索结果的形状（2026-11-09 persona 接入批一）──────
// 刻意不在本文件 import `persona-ask.ts`：工具只收注入函数，单测/探针不需要
// 真实 python 路径也能构造替身。字段与那边 `PersonaAskResult` 结构一致即可。
export type PersonaRecallGroup = "memory_day" | "event" | "segment" | "fact" | "entity" | "tension";

export interface PersonaRecallHit {
	id: string;
	date?: string;
	title?: string;
	text?: string;
	kind?: string;
	source?: string;
	why?: string;
	/** 外接库的原始组名（组名不固定）；内置六组不填。 */
	group?: string;
}

export interface PersonaRecallResult {
	ok: boolean;
	question: string;
	qtype?: string;
	groups?: Partial<Record<PersonaRecallGroup, PersonaRecallHit[]>>;
	/** 外接库的扁平命中（anyGroups 模式总会给，空库 = []）。 */
	hits?: PersonaRecallHit[];
	unknown?: string;
	coverage?: {
		not_searched?: string[];
		not_indexed?: string[];
		gaps?: string[];
		gap_months?: string[];
	};
	error?: string;
	/** 超时标记（2026-11-24）：只有超时置 true；工具层只对它透传 error 原文。 */
	timedOut?: boolean;
	/**
	 * 库不认 `--vector`（2026-11-24 命名统一）：persona-ask 已自动退回普通检索并成功。
	 * 不是失败，只在日志里留痕；工具描述与返回结构不变。
	 */
	vectorUnsupported?: boolean;
}

/**
 * 记忆库槽位的最小访问面（2026-11-23）。
 *
 * 结构同 lifecycle 注入的实现（memory-bank.ts）：active 决定这一次 `recall` / `remember`
 * 走哪个库；ask / write 只在 external 时被调用。`writable()` 供 remember 在起进程前
 * 先回「写入未开启」，不必真的调 repair.py。
 */
export interface MemoryBankAccess {
	active(): "builtin" | "external";
	ask(question: string, options?: { limit?: number }): Promise<PersonaRecallResult>;
	write(input: {
		body: string;
		why: string;
		about?: string;
		tag?: string;
	}): Promise<{ ok: boolean; line?: string; statementId?: string; error?: string }>;
	writable(): boolean;
}

/**
 * 这条派活该记成"谁说的"（2026-11-07 派活留言）。
 *
 * 口径与 `effectivePartnerIdOfSession` 一致：执事会话 → 该执事的名字；
 * 主人 / 总管会话 → 总管。查不到名字就返回 null（不记留言，不猜一个假名）。
 *
 * 为什么不在派单里现查：这里把"身份"和"领域"分开——领域是路由，
 * 身份是"这句话谁说的"，两件事不该共用一次查询。
 */
function senderOf(conversationId: number): { kind: "chief" | "partner"; name: string } | null {
	if (!COMPANIONS_ENABLED) return { kind: "chief", name: "总管" };
	try {
		const store = partnersStore();
		const partnerId = store.partnerIdOfSession(conversationId);
		if (!partnerId) return { kind: "chief", name: "总管" };
		const name = store.get(partnerId)?.name?.trim();
		return name ? { kind: "partner", name } : null;
	} catch {
		return { kind: "chief", name: "总管" };
	}
}

/**
 * 调用方会话所属执事的领域（2026-11-07 执事直派）。
 *
 * 只认链接表里真实的执事档案：总管（`chief`）与主人会话没有领域，
 * 返回 null —— 路由据此走"原样分管"。查库失败也返回 null（宁可按旧行为），
 * 不让一次读失败把派单挡下来。
 */
function callerDomainOf(conversationId: number): string | null {
	if (!COMPANIONS_ENABLED) return null;
	try {
		const partnerId = partnersStore().partnerIdOfSession(conversationId);
		if (!partnerId) return null;
		return partnersStore().get(partnerId)?.domain ?? null;
	} catch {
		return null;
	}
}

/**
 * 本机 delegate 才反查执事身份（批次D D2）。
 * 执事能力关闭 / 执事库不可用时返回 null —— 请求不带身份，兼容旧领域，不让派单因查库失败而挂掉。
 * 远程锚点会话（relay-matrix）不装配这个缝，因此「不做跨电脑执事」在装配层就成立。
 */
function localIdentityHit(domain: string): { name: string; soul: string } | null {
	if (!COMPANIONS_ENABLED) return null;
	try {
		// 派发权闸（2026-11-06）：开关关（或 env 总闸关）时不命中，请求不带 managerIdentity，
		// chancellor 以默认路径（总管直派）办单——等同旧领域，不拒单。
		if (!ministerDispatchAllowed(partnersStore(), domain)) return null;
		return partnerIdentityForDomain(partnersStore(), domain);
	} catch {
		return null;
	}
}

export interface ToolDeps {
	/** 记忆引擎；为 null 时 remember / recall 会明确报错而不是静默失败 */
	memory: MemoryEngine | null;
	/** 内部会话 id → 记忆作用域 */
	scopeOf: (conversationId: number) => MemoryScope;
	/** 技能库；为 null 时 skill 工具不上（技能目录不存在/为空，索引也不会渲染） */
	skills?: SkillStore | null;
	/**
	 * 技能可见性归属（2026-11-21 普通助手技能独立）：
	 * worker 会话返回保留键 `worker`；执事 / 主对话按原口径（执事 uuid / chief）。
	 * 不传 = 旧行为（`effectivePartnerIdOfSession`），单测 / 探针零改动。
	 */
	skillOwnerOf?: (conversationId: number) => string | null | Promise<string | null>;
	/**
	 * 派活能力；为 false 时 delegate 工具不上。
	 *
	 * 2026-11-02：默认开。装上 chancellor 之后主 agent 才有"把活派出去"的手。
	 * 关掉它（`CHANCELLOR_ENABLED=false`）时工具清单回到 8 个，行为与改动前完全一致。
	 */
	delegate?: boolean;
	/** 测试用：替换真正跑 chancellor 的入口；生产不传，直接用 runChancellor。 */
	delegateRun?: typeof runChancellor;
	/**
	 * 任务单跑完后回灌会话（2026-11-03）。
	 *
	 * 工具不直接碰会话对象：由 `agent.ts` 传入，内部走 `sayInChat`。
	 * 会话忙时 durable 会把这条写入排到本轮结束，不打断当前对话。
	 */
	reportDelegation?: (conversationId: number, report: DelegationReport) => void;
	/**
	 * 任务专线双写（2026-11-08 扫尾批 8g）。
	 *
	 * 装配层（`agent/lifecycle.ts`）传 `taskConversationMirror`；不传 = 只写留言表。
	 * 刻意用注入而不是在 tools.ts 里直接 import task-conversation：探针/单测也调
	 * `createTools`，那里没有 durable 上下文，不能因为"带了个默认值"就去开真实 Harness。
	 */
	mirrorDelegation?: (ticketId: string, entry: DelegationMirrorEntry) => void;
	/**
	 * 项目/工作区登记表（2026-11-03 方案 §5.5）。
	 * 派新活必须先过这里：没有已登记且仍在工作区内的项目一律返回 `needs_project`，
	 * 不建目录、不写文件、不建任务单。
	 */
	projects?: ProjectsStore | null;
	/**
	 * 执事能力（2026-11-05 批次B B2）：为 true 时 `partner_skill_write` 上架。
	 * agent.ts 传 `COMPANIONS_ENABLED`——开关关掉时工具不注册，行为与改动前一致（回滚开关）。
	 */
	partners?: boolean;
	/**
	 * 执事管理工具的存储 / chancellor 工作根（批次D D3）。测试注入临时目录，
	 * 不碰真实 .data/；不传用全局 partnersStore() + chancellorWorkRoot()。
	 */
	ministerContext?: () => MinisterContext;
	/**
	 * 群组能力（2026-11-07 群组入口统一）：为 true 时 `group_manage` 上架。
	 * agent.ts 不传 → 回落 `groupsAvailable()`（GROUPS_ENABLED + COMPANIONS_ENABLED 双闸）；
	 * 关掉任一个时工具不注册，模型也够不到建群（一行回滚）。
	 */
	groups?: boolean;
	/** 群组核心的存储（2026-11-07）。测试注入临时 store，不碰真实 .data/。 */
	groupContext?: () => GroupContext;
	/** 派单回执表；不传用默认 `.data/delegations.sqlite`。测试可注入临时库。 */
	receipts?: DelegationReceipts | null;
	/** 搜索适配层（2026-11-07）。测试注入假上游；缺省时不注册 `web_search`。 */
	search?: SearchModule | null;
	/**
	 * 执事间递话（2026-11-08 扫尾批 8d）：传了才注册 `send_to_agent`。
	 * 装配层按 `COMPANIONS_ENABLED && PARTNER_RELAY_ENABLED` 决定传不传
	 * ——不传 = 工具不上架（一行回滚），模型侧报 `tool_unavailable`。
	 */
	relay?: PartnerRelayDeps | null;
	/**
	 * 会话考古（2026-11-09 T4 §4）：传了才注册 `recall_sessions`。
	 * 装配层按 `AGENT_RECALL_SESSIONS`（默认开）决定传不传——不传 = 工具不上架
	 * （模型侧 tool_unavailable，一行回滚）。实现由 lifecycle 注入，tools 不碰 durable。
	 */
	recallSessions?: ((query: string, options: { days?: number; limit?: number }) => Promise<SessionSearchHit[]>) | null;
	/**
	 * 记忆库槽位（2026-11-23 外部记忆库接入）：按槽位分发 recall / remember。
	 * 装配层（lifecycle）恒注入；不传 = 内置引擎形态（单测 / 探针不需要真 python 路径）。
	 *
	 * 结构在 tools 这边声明（不 import memory-bank.ts）：单测 / 探针不需要真 python 路径
	 * 也能构造替身。
	 */
	memoryBank?: MemoryBankAccess | null;
	/**
	 * 自建巡逻（2026-11-08 刀二 E4）：为 true 时 `routine_manage` 工具上架。
	 * 装配层（lifecycle）按 `routineSelfServiceEnabled()` 传入；**不传 = 不上架**
	 * （单测 / 探针零改动，避免工具全集快照误伤）。`ROUTINE_SELF_SERVICE=false`
	 * 或 `COMPANIONS_ENABLED=false` → 不上架（模型侧 tool_unavailable，一行回滚）。
	 */
	routineSelfService?: boolean;
	/** 排 durable 闹钟；生产由 lifecycle 注入 `routineEngine().ensureScheduled`。 */
	scheduleRoutine?: (routineId: string) => Promise<void>;
	/**
	 * 自建规则标记（2026-11-10 批 15 §三）：routine_manage 建出来的规则，首轮
	 * runSource 记 `routine_self`。生产由 lifecycle 注入 `routineEngine().markSelfCreated`；
	 * 不传 = 不记（单测 / 探针零副作用）。
	 */
	markSelfRoutine?: (routineId: string) => void;
	/**
	 * agent 中途播报（2026-11-10 批 13 §三）：为 true 时 `report_progress` 上架。
	 * 装配层按 `AGENT_PROGRESS_REPORT`（默认开）传入；**不传 = 不上架**
	 * （单测 / 探针零改动）。任务专线的镜像由 `mirrorTaskNotice` 注入。
	 */
	progressReport?: boolean;
	/**
	 * 技能分类建议落盘（2026-11-10 批 30 修订）：传了才注册 `save_skill_advice`。
	 * 装配层按 `SKILL_ADVICE`（默认开）决定传不传——不传 = 工具不上架（一行回滚）。
	 * 实现由 lifecycle 注入（包住 skill-advice.ts 的清洗与原子写），tools 不碰文件系统。
	 */
	skillAdviceSave?: ((items: Record<string, string[]>) => SkillAdviceSaveResult) | null;
	/**
	 * 提醒沉淀建议落盘（2026-11-19 批4）：传了才注册 `save_reminder_advice`。
	 * 装配层按 `REMINDER_DISTILL_ENABLED`（默认开）决定传不传——不传 = 工具不上架（一行回滚）。
	 * 实现由 lifecycle 注入（包住 reminder-advice.ts 的清洗与原子写），tools 不碰文件系统。
	 * 收集端（reminder-distill.ts）与采纳端点共用同一开关。
	 */
	reminderAdviceSave?: ((items: string[]) => ReminderAdviceSaveResult) | null;
	mirrorTaskNotice?: (conversationId: number, text: string) => void;
}

let sharedReceipts: DelegationReceipts | null = null;

function receiptsOf(deps: ToolDeps): DelegationReceipts {
	if (deps.receipts) return deps.receipts;
	if (!sharedReceipts) sharedReceipts = new DelegationReceipts();
	return sharedReceipts;
}

/** 读布尔 env；只有明确写 false/0 才关，避免拼错一个值把功能误关掉。 */
function envFlag(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	return raw !== "false" && raw !== "0";
}

/**
 * 合并两路中止信号（2026-11-22 M0）：同步回滚路径里，取消这张单（票级 controller）
 * 与用户中断本轮对话（聊天 abortSignal）任一发生都该停。空信号忽略；Node 支持
 * `AbortSignal.any` 就用它，否则手写一个监听两路的 controller。
 */
function combineAbortSignals(
	first?: AbortSignal,
	second?: AbortSignal,
): AbortSignal | undefined {
	if (!first) return second;
	if (!second || first === second) return first;
	const anySignals = (AbortSignal as unknown as {
		any?: (signals: AbortSignal[]) => AbortSignal;
	}).any;
	if (typeof anySignals === "function") return anySignals.call(AbortSignal, [first, second]);
	const controller = new AbortController();
	const onAbort = (): void => controller.abort();
	if (first.aborted || second.aborted) {
		controller.abort();
	} else {
		first.addEventListener("abort", onAbort, { once: true });
		second.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

/**
 * 设备 worker 判定（2026-11-08 扫尾批 3-H B3）：执行体是否"不落本机磁盘项目"。
 *
 * `delegate` 入参里没有 worker 字段（参数见本文件 `delegate.parameters`）。代码里
 * 设备执行体有两种表达，两种都不该过本机项目前置：
 *  1. `targetDevice` 明确点名另一台设备 —— 走本文件的远程分支，在 `return` 处就
 *     结束，天然到不了项目前置（注释「本机的项目前置不参与」）。"auto" 挑不出落回
 *     本机时不算设备活：那时是本机执行，仍要项目。
 *  2. chancellor 的雇员档 `CHANCELLOR_EMPLOYEE=phone`（chancellor `config.ts:9`
 *     的 `EMPLOYEE: WorkerKind`，`WorkerKind` 含 `"phone"`）——本机 chancellor 把活
 *     派给手机 worker，活去手机屏幕、不落本机磁盘（`plan.ts` 把 phone 单 writes
 *     置空、`review.ts` 按汇报验收）。这条**会**走到项目前置，正是被 `needs_project`
 *     硬拦的一条；本次豁免的就是它。
 *
 * 只判"执行体"，不改 `project` 本身的语义：设备活根本不进 `resolveDelegationProject`。
 */
export function isDeviceWorkerDelegation(
	args: { targetDevice?: string },
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const explicitDevice = (args.targetDevice ?? "").trim();
	if (explicitDevice && explicitDevice !== "auto") return true;
	return (env.CHANCELLOR_EMPLOYEE ?? "").trim().toLowerCase() === "phone";
}

/** 统一契约形态的工具输出（批 16 §一）：一行 JSON，只给新工具用。 */
function textToolResult<T>(result: ToolResult<T>) {
	return { output: [{ type: "text" as const, text: encodeToolResult(result) }] };
}

/**
 * `delegate` 的工具结果（2026-11-10 批 23b 五§八#1）：只包外层，人读 `message` 逐字不变。
 *
 * 业务分支的附加字段（`ticketId`、`needs_project` 的候选项目清单、幂等命中的原单号）
 * 放 `data`——模型靠它们决定下一步，塞进 `error` 就只剩一句话。真正的失败
 * （设备矩阵不可用 / 派单异常）走 `err`。
 */
function delegateResult(message: string, extra: Record<string, unknown> = {}) {
	return textToolResult(ok({ message, ...extra }));
}

/**
 * 派活没成（业务上没受理）的工具结果（2026-11-25 用户口径：成功还是失败要看得见）。
 *
 * JSON 形状照旧——模型要的 `projects` / `ticketId` 都还在 `data` 里；只在外层加
 * `isError: true`。聊天里的灰块据此画成失败（不再把"没派出去"画成一个绿勾），
 * 同类失败连击也按工具失败记账。真正受理成功的分支走 delegateResult，不加这个标记。
 */
function delegateFailedResult<T>(result: ToolResult<T>) {
	return { ...textToolResult(result), isError: true };
}

/** `needs_project` 的失败回话：候选项目清单原样保留，只在 message 开头说清"没派成"。 */
function delegateNeedsProject(gateText: string) {
	const data = delegateJsonData(gateText);
	const message = typeof data.message === "string" ? data.message : gateText;
	return delegateFailedResult(ok({ ...data, message: `派活失败：${message}` }));
}

/**
 * 写类工具的统一成功形状（2026-11-10 批 25 §一）：只包外层，`message` 逐字不变。
 * 与 `delegateResult` 同构；分开命名只是让调用点读得出"这是哪一类工具"。
 */
function writeToolResult(message: string, extra: Record<string, unknown> = {}) {
	return textToolResult(ok({ message, ...extra }));
}

/**
 * `needs_project` 这类分支迁移前就是一段 JSON（`{error, message, projects}`）。
 * "原样进 data" = 连字段名一起保留，只去掉内层的 `ok`（外层已经有 `ok: true`）。
 */
function delegateJsonData(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const data = { ...(parsed as Record<string, unknown>) };
			delete data.ok;
			return data;
		}
	} catch {
		// 不是 JSON（旧文案）→ 只当 message
	}
	return { message: raw };
}

// ── 外接库检索结果的六组渲染（2026-11-09 persona 接入批一；recall 外部槽复用）──
const PERSONA_GROUP_LABELS: Record<PersonaRecallGroup, string> = {
	memory_day: "日记忆",
	event: "事件",
	segment: "片段",
	fact: "事实",
	entity: "人物",
	tension: "张力",
};
const PERSONA_GROUP_ORDER: PersonaRecallGroup[] = [
	"memory_day",
	"event",
	"fact",
	"segment",
	"entity",
	"tension",
];
/** 单条正文摘要上限（任务书 §2.3）。 */
const PERSONA_HIT_MAX_CHARS = 160;

function clipPersonaText(value: string): string {
	return value.length > PERSONA_HIT_MAX_CHARS ? `${value.slice(0, PERSONA_HIT_MAX_CHARS)}…` : value;
}

/**
 * 按组列条目：`- [组名] 日期｜标题：正文摘要（出处 id）`，组间空行。
 * `unknown` 是 ask.py 的"查不到 ≠ 没有这回事"说明，**必须原文透传**；
 * coverage 的 gaps / gap_months 提醒哪些时段没有记录。
 */
export function renderPersonaAsk(result: PersonaRecallResult): string {
	const blocks: string[] = [];
	for (const group of PERSONA_GROUP_ORDER) {
		const hits = result.groups?.[group];
		if (!hits || hits.length === 0) continue;
		const lines = hits.map((hit) => {
			const when = hit.date?.trim();
			const title = hit.title?.trim();
			const body = hit.text?.trim();
			const detail = [title, body ? clipPersonaText(body) : ""].filter(Boolean).join("：");
			const head = [when, detail || "（无摘要）"].filter(Boolean).join("｜");
			return `- [${PERSONA_GROUP_LABELS[group]}] ${head}（${hit.id}）`;
		});
		blocks.push(lines.join("\n"));
	}

	let out = blocks.length > 0 ? blocks.join("\n\n") : "个人记忆库里没有查到相关记录。";
	if (result.unknown?.trim()) out += `\n\n注意：${result.unknown.trim()}`;
	const gaps = [...(result.coverage?.gaps ?? []), ...(result.coverage?.gap_months ?? [])];
	if (gaps.length > 0) {
		out += `\n\n记忆库在这些时段没有记录：${[...new Set(gaps)].join("、")}`;
	}
	return out;
}

/**
 * 外接库的扁平命中渲染（2026-11-23）：组名不固定，直接用 `hit.group` 做标签；
 * 其余预算 / unknown / coverage 口径与 `renderPersonaAsk` 一致。
 */
export function renderExternalBankAsk(result: PersonaRecallResult): string {
	const hits = result.hits ?? [];
	const lines = hits.map((hit) => {
		const group = hit.group?.trim();
		const when = hit.date?.trim();
		const title = hit.title?.trim();
		const body = hit.text?.trim();
		const detail = [title, body ? clipPersonaText(body) : ""].filter(Boolean).join("：");
		const head = [when, detail || "（无摘要）"].filter(Boolean).join("｜");
		return `- ${group ? `[${group}] ` : ""}${head}（${hit.id}）`;
	});
	let out = lines.length > 0 ? lines.join("\n") : "当前外部记忆库里没有查到相关记录。";
	if (result.unknown?.trim()) out += `\n\n注意：${result.unknown.trim()}`;
	const gaps = [...(result.coverage?.gaps ?? []), ...(result.coverage?.gap_months ?? [])];
	if (gaps.length > 0) {
		out += `\n\n记忆库在这些时段没有记录：${[...new Set(gaps)].join("、")}`;
	}
	return out;
}

/**
 * `web_search` 结果总量上限（2026-11-25 上下文瘦身）：按 `hits` 序列化后的字符数算。
 *
 * 实测单次搜索 39,349 字符、`message` 又把命中抄一遍（19,484）——两处都在烧上下文。
 * 这里只裁条数：超上限时从排名最后的命中开始丢，至少保留 1 条；每条 title / url / summary
 * 的结构与内容都不动。32K 是「宁大勿小」的估算（CJK 最多 1 token/字）。
 */
export const WEB_SEARCH_MAX_RESULT_CHARS = 32_000;

export function shapeWebSearchHits(hits: readonly SearchHit[]): SearchHit[] {
	const kept = [...hits];
	while (kept.length > 1 && JSON.stringify(kept).length > WEB_SEARCH_MAX_RESULT_CHARS) {
		kept.pop();
	}
	return kept;
}

export function createTools(deps: ToolDeps) {
	const { memory, scopeOf } = deps;

	const requireMemory = (): MemoryEngine => {
		if (!memory) throw new Error("记忆库未启用（MEMORY_ENABLED=false 或初始化失败）");
		return memory;
	};

	const remember = defineTool({
		name: "remember",
		description:
			"把一件事写进长期记忆，以后每次对话都可能被想起来。" +
			"适合：偏好、家人朋友宠物、长期目标、重要经历；不适合：一次性琐事、马上会变的信息。" +
			// 2026-11-09 T4 §3：前瞻意图单独一类，带有效期；过期自动降级为事实。
			"还没发生的计划（「我打算 / 下周开始…」）用 kind=intention，并尽量给 expiresInDays（到期自动降级为事实）。" +
			// 2026-11-08 员工人格化刀一 E3：被教诲必须落成偏好，不能只在当下照做
			//（偏好层有"永不删"保护，教过的话不会被衰减掉）。
			"**用户用「以后 / 记住 / 下次」立规矩时，必须立刻记一条 kind=preference、taught=true**：" +
			"记的是规矩本身（做什么 / 不做什么），不是这次对话的经过。" +
			// 2026-11-08 刀三 E3：教诲分两层，规矩与方法不互斥：规矩进偏好（永不删），方法进技能（按需取用）。
			"教的是方法 / 步骤而非规矩时，另写成技能文件（partner_skill_write）；规矩本身仍落 preference。",
		parameters: Type.Object({
			content: Type.String({ description: "要记住的内容，一句话，用第三人称或原话" }),
			kind: Type.Optional(
				Type.Unsafe<MemoryKind>({
					type: "string",
					enum: MEMORY_KINDS,
					description:
						"fact=事实 / episode=经历过的事 / preference=偏好 / entity=人事物 / intention=打算（我打算…）",
				}),
			),
			// 2026-11-09 T4 §3：只对 kind=intention 有意义。其余 kind 传了也忽略。
			expiresInDays: Type.Optional(
				Type.Number({
					description:
						"kind=intention 时有效：多少天后这条打算自动降级为普通事实。1..365，不传 = 不过期。",
					minimum: 1,
					maximum: 365,
				}),
			),
			importance: Type.Optional(
				Type.Number({ description: "重要程度 0..1，默认 0.7", minimum: 0, maximum: 1 }),
			),
			// 2026-11-08 刀一 E3：教诲来源标记。store 的 source 是自由字符串（imported 先例），
			// 不需要改记忆 schema；巩固 / 召回都不按 source 分支，写进去只是留审计线索。
			taught: Type.Optional(
				Type.Boolean({
					description: "用户立规矩（「以后… / 记住…」）时为 true：这条标成 taught 来源。普通事实不填。",
				}),
			),
			// 项目记忆（2026-11-15 项目记忆方案）：scope="project" 把记忆挂到当前会话所属的
			// 项目上（构建方式 / 部署口径 / 踩过的坑这类只在该项目成立的事）。
			// 默认 auto = 现行为（执事会话进执事键空间，其余进会话键空间）。
			// 2026-11-15 多挂载方案：负责多个项目时用 project 参数按名指写。
				scope: Type.Optional(
					Type.Union([
						Type.Literal("auto"),
						Type.Literal("project"),
					], {
						description:
							"auto=默认归属；project=挂到项目记忆里（只在聊这个项目时被想起）。" +
							"项目相关的口径（怎么构建、怎么部署、踩过什么坑）用 project。",
					}),
				),
			project: Type.Optional(
				Type.String({
					description:
						"scope=project 时用：项目名（负责项目清单里的名字）。" +
						"你负责多个项目时必填；只负责一个或会话已绑定项目时不用填。",
				}),
			),
		}),
		execute: async (args, api) => {
			// 记忆库槽位（2026-11-23）：外部模式 = 起 repair.py 写外部库，**不写内置引擎**。
			// 工具名 / schema / 注册位置都不变；只换后面的库。
			const bank = deps.memoryBank;
			if (bank && bank.active() === "external") {
				if (partnersStore().isGroupSession(api.conversationId)) {
					return textToolResult(
						err(
							"group_session",
							"群聊里的内容不进个人记忆；需要记住的事请主人在私聊里说。",
							"在私聊里重新说一遍要记的事。",
						),
					);
				}
				if (!bank.writable()) {
					// PERSONA_WRITE_ENABLED=false / 只读库：明确回「写入未开启」，**不 spawn**。
					return textToolResult(
						err(
							"memory_write_disabled",
							"外部记忆库的写入未开启（PERSONA_WRITE_ENABLED=false，或这个库没有 repair.py）。",
							"让主人在 设置 → 一生记忆库（写）里打开写入。",
						),
					);
				}
				const content = args.content.trim();
				let result: { ok: boolean; line?: string; statementId?: string; error?: string };
				try {
					// 外部库只收原话：kind / scope / project / importance / expiresInDays / taught
					// 在本批都不生效（remember 没有 about / tag 参数，也不传）。
					result = await bank.write({ body: content, why: "用户让记住" });
				} catch {
					result = { ok: false };
				}
				// 只记字数 / 状态，不记 body 原文（日志纪律）。
				console.log(`[remember] bank=external body=${[...content].length}字 ok=${result.ok}`);
				if (!result.ok) {
					return textToolResult(
						err(
							"memory_write_failed",
							result.error ?? "外部记忆库写入没成功（原因已记日志）。",
							"把失败原因转告主人；不要编造「已经写入」。不要改写到本地记忆里。",
						),
					);
				}
				return textToolResult(
					ok({
						message:
							`已记住：${content}` +
							(result.statementId ? `（留痕 id：${result.statementId}）` : "") +
							"\n（外部记忆库只收原话；kind/scope 等参数未生效）",
					}),
				);
			}
			const engine = requireMemory();
			// 群会话不进个人记忆（2026-11-06 群组方案 §2.2）：群里听到的事写进执事私人记忆
			// 就是串台。模型侧明说原因，别让它对着一个会失败的接口反复重试。
			if (partnersStore().isGroupSession(api.conversationId)) {
				return textToolResult(
					err(
						"group_session",
						"群聊里的内容不进个人记忆；需要记住的事请主人在私聊里说。",
						"在私聊里重新说一遍要记的事。",
					),
				);
			}
			let scope = scopeOf(api.conversationId);
			if (args.scope === "project") {
				// 写入解析（2026-11-15 多挂载方案）：阶梯收在纯函数里（可单测），这里只把
				// 会话解析成三个入参：显式指名 / 绑定项目 / 负责清单（含项目名）。
				const bound = await projectIdOfConversation(api.conversationId);
				const mountedIds = await personaProjectIdsOfConversationAsync(api.conversationId);
				const registered = projectsStore().listProjects(true);
				const resolution = resolveProjectWriteTarget(
					args.project,
					bound,
					mountedIds
						.map((id) => registered.find((entry) => entry.id === id))
						.filter((entry): entry is Project => Boolean(entry)),
				);
				if (!resolution.ok) {
					return textToolResult(err(resolution.code, resolution.message, resolution.hint));
				}
				// 归档 / 删除的项目不再接收新记忆（2026-11-16 用户拍板）：写进去也召回不到，
				// 等于死账。归档期间不给写；恢复归档后照常写。删除的按"登记没了"提示。
				const state = projectMemoryStateOf(resolution.projectId);
				if (state !== "active") {
					const name = registered.find((entry) => entry.id === resolution.projectId)?.name;
					const label = name ? `「${name}」` : "这个项目";
					return textToolResult(
						err(
							"project_inactive",
							state === "archived"
								? `${label}已归档，不再接收新的项目记忆（归档期间写进去的也召回不到）。`
								: `${label}已经不在项目登记里，不能再写项目记忆。`,
							state === "archived"
								? "先恢复项目再记；或者把这条记成普通记忆（不带 scope 参数）。"
								: "把这条记成普通记忆（不带 scope 参数）。",
						),
					);
				}
				scope = { type: "project", id: resolution.projectId };
			}
			const record = engine.remember({
				kind: args.kind ?? "fact",
				scope,
				content: args.content,
				importance: args.importance,
				// 人自己说的（或当面转述的），可信度最高
				veracity: "stated",
				source: args.taught ? "taught" : "user",
				// 有效期只对 intention 生效（2026-11-09 T4 §3）：其它 kind 传了也忽略，
				// 不因为一个多余参数把普通事实变成"会过期"。
				expiresAt:
					(args.kind ?? "fact") === "intention" && typeof args.expiresInDays === "number"
						? new Date(
								api.now() +
									Math.min(365, Math.max(1, Math.floor(args.expiresInDays))) * 86_400_000,
							).toISOString()
						: null,
			});
			// 写入路径末尾同样按 cap 修剪（只记条数，见 memory-prune.ts）。
			const pruned = pruneSessionMemory(engine);
			if (pruned > 0) console.log(`[memory] 会话记忆修剪 -${pruned} 条`);
			return textToolResult(ok({ message: `已记住：${record.content}` }));
		},
	});

	const recall = defineTool({
		name: "recall",
		description:
			"在长期记忆里检索。和对方有关的事想不起来了，先用它查，不要猜。" +
			"当前对话的上下文里通常已经带了相关记忆，只有在不够用时才调用。",
		parameters: Type.Object({
			query: Type.String({ description: "要查什么，用关键词或一句话" }),
			limit: Type.Optional(Type.Number({ description: "最多返回几条，默认 5" })),
		}),
		execute: async (args, api) => {
			// 记忆库槽位（2026-11-23）：外部模式 = 经 ask.py 查外接库，输出仍走
			// `renderPersonaAsk()`，形状仍是 `{count, message}`（schema 不变）。
			// 外部失败明确报错，**不回落内置库**（两库条目不同构，悄悄换库比报错更糟）。
			const bank = deps.memoryBank;
			if (bank && bank.active() === "external") {
				if (partnersStore().isGroupSession(api.conversationId)) {
					return textToolResult(
						err(
							"group_session",
							"群聊不走个人记忆；答案以群里的聊天记录为准。",
							"按群里的聊天记录回答，不要当这里是私聊。",
						),
					);
				}
				const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 5)));
				let result: PersonaRecallResult;
				try {
					result = await bank.ask(args.query, { limit });
				} catch {
					// 注入实现理论上不抛，这里兜一层：检索失败绝不打断裂对话轮。
					result = { ok: false, question: args.query };
				}
				const flat = result.hits;
				const hits = flat
					? flat.length
					: result.groups
						? Object.values(result.groups).reduce((sum, group) => sum + (group?.length ?? 0), 0)
						: 0;
				// 只记字数 / 状态 / 条数，不记 query 原文与正文（日志纪律）。
				// vectorUnsupported = 库不认 --vector、已退回普通检索（不是失败，2026-11-24）。
				console.log(
					`[recall] bank=external q=${args.query.length}字 ok=${result.ok} hits=${hits}${result.vectorUnsupported === true ? " vectorUnsupported=true" : ""}`,
				);
				if (!result.ok) {
					const disabled = /已关闭/.test(result.error ?? "");
					// 超时是可行动信息（2026-11-24）：只对它透传 error 原文，其余失败仍走通用文案。
					if (result.timedOut === true) {
						return textToolResult(
							err(
								"memory_unavailable",
								result.error ?? "persona 检索超时",
								"告诉主人这次查得太慢、没查完；可以换更短的关键词再试一次，别连续重试同一个查询。",
							),
						);
					}
					return textToolResult(
						err(
							"memory_unavailable",
							disabled
								? "外部记忆库已关闭（PERSONA_MEMORY_ENABLED=false）。"
								: "外部记忆库暂时查不了（原因已记日志），你可以说说想确认什么，我换个方式找。",
							disabled
								? "让主人到 设置 → 一生记忆库（查）里重新打开。"
								: "稍后重试，或让主人检查外部记忆库脚本；不要当这里没有这回事。",
						),
					);
				}
				return textToolResult(
					ok({
						count: hits,
						message: flat ? renderExternalBankAsk(result) : renderPersonaAsk(result),
					}),
				);
			}
			const engine = requireMemory();
			// 群会话不参与记忆引擎（群组方案 §2.2，v1 最简形态）：群聊查记忆也跳过
			if (partnersStore().isGroupSession(api.conversationId)) {
				return textToolResult(
					err(
						"group_session",
						"群聊不走个人记忆；答案以群里的聊天记录为准。",
						"按群里的聊天记录回答，不要当这里是私聊。",
					),
				);
			}
			// 项目记忆（2026-11-15 项目记忆方案）：会话归属项目时项目键空间也进候选。
			// 人格挂载（2026-11-15 跟人走立项、同日多挂载方案扩化）：全部负责项目都可查
			// ——主动查不受注入闸门限制（闸门只管"自动浮出"，不管"伸手去查"）。
			const projectId = await projectIdOfConversation(api.conversationId);
			const mountedIds = await personaProjectIdsOfConversationAsync(api.conversationId);
			// 归档 / 删除的项目退出召回库（2026-11-16 用户拍板）：主动查也不放行——
			// 规则是"不进召回库"，不是"只是不自动注入"。
			const boundProjectId = projectId && isRecallableProjectId(projectId) ? projectId : null;
			const liveMountedIds = recallableProjectIds(mountedIds);
			const boundKey = boundProjectId ? scopeKey({ type: "project", id: boundProjectId }) : null;
			const projectKeys = [
				...(boundKey ? [boundKey] : []),
				...liveMountedIds.map((id) => scopeKey({ type: "project", id })),
			];
			const hits = engine.recall({
				text: args.query,
				scopes: ["global", ...new Set(projectKeys), scopeKey(scopeOf(api.conversationId))],
				limit: Math.max(1, Math.min(20, Math.floor(args.limit ?? 5))),
			});
			if (hits.length === 0) {
				return textToolResult(ok({ count: 0, message: "没有找到相关记忆。" }));
			}
			return textToolResult(
				ok({
					count: hits.length,
					// 正文只走 message（与迁移前逐字节一致）；不把 record 原样塞进 data，
					// 那里带 scope / id 等内部字段，模型不需要。
					message: hits
						.map(
							(hit) =>
								`- [${hit.record.kind}] ${hit.record.content}（${hit.record.createdAt.slice(0, 10)}）`,
						)
						.join("\n"),
				}),
			);
		},
	});

	const remind = defineTool({
		name: "set_reminder",
		description:
			"定一个定时任务：到点让目标执事自己跑一轮、主动来说一句（触发指令对你隐藏，看起来像它主动开口）。" +
			"时间写 ISO 8601 带时区（如 2026-10-29T08:00:00+08:00）；任务落库，进程重启不丢。" +
			"要重复时补 `repeat`（daily / weekly+weekdays / monthly+dayOfMonth，格式见参数）；" +
			"此时 `at` 只定「几点」，服务端自动推到下一次符合规则的时间；区间结束用 `until`。",
		parameters: Type.Object({
			text: Type.String({ description: "到点要让执事做的事（它会据此现场说一句，不是照念这段）" }),
			at: Type.String({ description: "第一次触发时间，ISO 8601" }),
			repeat: Type.Optional(
				Type.Union(
					[
						Type.Literal("none"),
						Type.Literal("daily"),
						Type.Literal("weekly"),
						Type.Literal("monthly"),
					],
					{ description: "频率；缺省 = 一次性" },
				),
			),
			weekdays: Type.Optional(
				Type.Array(Type.Number(), {
					description: "weekly 用：0 = 周日，1 = 周一 … 6 = 周六，可多选",
				}),
			),
			dayOfMonth: Type.Optional(
				Type.Number({ description: "monthly 用：1–31；没有这一天的月份按月末算" }),
			),
			until: Type.Optional(
				Type.String({ description: "区间结束日期，ISO 8601（含当天）" }),
			),
		}),
		execute: async (args, api, context) => {
			const rawAt = Date.parse(args.at);
			if (Number.isNaN(rawAt)) {
				return textToolResult(
					err(
						"bad_at",
						`时间格式看不懂：${args.at}`,
						"写 ISO 8601（带时区），例如 2026-10-29T08:00:00+08:00。",
					),
				);
			}
			const now = api.now();
			const repeat = args.repeat ?? "none";
			const weekdays =
				repeat === "weekly"
					? Array.from(new Set((args.weekdays ?? []).map((value) => Math.trunc(value)))).filter(
							(value) => value >= 0 && value <= 6,
						)
					: undefined;
			if (repeat === "weekly" && (!weekdays || weekdays.length === 0)) {
				return textToolResult(
					err(
						"weekdays_required",
						"每周提醒需要 weekdays（0 周日 … 6 周六）",
						"weekdays 给 0（周日）到 6（周六）的数字，可多选。",
					),
				);
			}
			const dayOfMonth =
				repeat === "monthly" && typeof args.dayOfMonth === "number"
					? Math.trunc(args.dayOfMonth)
					: undefined;
			if (repeat === "monthly" && (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31)) {
				return textToolResult(
					err(
						"day_of_month_required",
						"每月提醒需要 dayOfMonth（1–31）",
						"dayOfMonth 给 1 到 31 的数字；没有这一天的月份按月末算。",
					),
				);
			}
			const until = args.until ? Date.parse(args.until) : undefined;
			if (args.until && Number.isNaN(until)) {
				return textToolResult(
					err("bad_until", `until 时间格式看不懂：${args.until}`, "until 也写 ISO 8601，只取日期部分也行。"),
				);
			}

			// `at` 对周期提醒只是「几点」的锚点：按规则推到 now 之后的第一跳，
			// 否则每周/每月会先按一个不相干的日期错响一次。
			const at =
				repeat === "none"
					? rawAt
					: nextReminderAt({ text: args.text, at: rawAt, repeat, weekdays, dayOfMonth }, now);
			if (at === null) {
				return textToolResult(
					err("no_next_occurrence", "这个重复规则找不到下一次触发时间", "检查 repeat / weekdays / dayOfMonth 组合是否成立。"),
				);
			}
			if (at <= now) {
				return textToolResult(
					err("time_in_past", `这个时间已经过去了：${args.at}`, "给一个未来的时间，或检查时区。"),
				);
			}
			if (until !== undefined && until <= at) {
				return textToolResult(
					err("until_before_at", "until 必须晚于第一次触发", "把 until 改到第一次触发之后，或去掉 until。"),
				);
			}

			await api.commit(
				(tx) =>
					tx.createTask(
						ReminderTask,
						{ text: args.text, at, repeat, weekdays, dayOfMonth, until },
						{ ownership: { kind: "conversation" } },
					),
				context,
			);
			const label =
				repeat === "daily"
					? "每天"
					: repeat === "weekly"
						? `每周${weekdays?.map((value) => "日一二三四五六"[value]).join("、") ?? ""}`
						: repeat === "monthly"
							? `每月 ${dayOfMonth} 号`
							: "";
			return textToolResult(
				ok({
					message: `好，${label ? `${label} ` : ""}${new Date(at).toLocaleString("zh-CN")} 提醒你：${args.text}`,
				}),
			);
		},
	});

	// 按会话记最后一张单：resume 只可能发生在同一轮对话里。
	// 不落库——进程重启后会话已断，老单本来也接不上，落库只会多出迁移/过期/清理的常态成本。
	const lastTicketByConversation = new Map<number, string>();
	// 续跑被拒时可能改派新单：记住这轮用的项目，改派后仍然落在同一个项目里。
	const lastProjectByConversation = new Map<number, ProjectRef>();
	const run = deps.delegateRun ?? runChancellor;
	/** 回滚开关：`DELEGATION_PROJECT_REQUIRED=false` 回到 2026-11-02 的无项目行为。 */
	const projectRequired = envFlag("DELEGATION_PROJECT_REQUIRED", true);
	/**
	 * 设备活项目前置豁免（2026-11-08 扫尾批 3-H B3）：默认开。
	 * `DELEGATION_DEVICE_PROJECT_EXEMPT=false` → 设备活也要项目（回到本批前行为）。
	 */
	const deviceProjectExempt = envFlag("DELEGATION_DEVICE_PROJECT_EXEMPT", true);

	const proposeProject = defineTool({
		name: "propose_project",
		description:
			"在用户已选定工作区的前提下，提出新建一个项目根目录。" +
			"它只提交待用户确认的请求，**不会创建目录、也不会登记项目**；用户在项目设置里确认后才真正建目录。" +
			"只有用户明确要新建一个项目（新的根目录）时才调用；项目内部的子目录不需要、也不应该新建项目。",
		parameters: Type.Object({
			name: Type.String({ description: "项目名，给用户看的短名，例如 手机端 / 桌面壳 / 文档站" }),
			path: Type.String({
				description: "工作区内的相对路径，例如 projects/新的小工具；不要写绝对路径，不要包含 ..",
			}),
		}),
		execute: async (args) => {
			if (!deps.projects) {
				// 业务分支（不是调用失败）：保留旧字段名 error 与文案，只去掉内层 ok，
				// 外层由统一契约给 ok: true（同 delegate 的 needs_project 口径）。
				return writeToolResult("项目登记表不可用", { error: "needs_project" });
			}
			try {
				const proposal = deps.projects.proposeProject(args.name, args.path);
				return writeToolResult(
					"已提交待确认：用户在项目设置里确认后才会创建目录并登记。" +
						"确认之前不要派工到它，也不要自己建这个目录。",
					{
						proposalId: proposal.id,
						name: proposal.name,
						path: proposal.relativePath,
					},
				);
			} catch (error) {
				const code = error instanceof ProjectError ? error.code : "failed";
				const message = error instanceof Error ? error.message : String(error);
				// 没有工作区是"下一步该干什么"明确的失败：给 hint，别让模型反复重试。
				return textToolResult(
					err(
						code,
						message,
						code === "no_workspace"
							? "先让用户在设置里选定工作区，再提项目。"
							: undefined,
					),
				);
			}
		},
	});

	// 派活（2026-11-02）：主 agent 的"手"。它自己不动手，把活交给外面的工人，
	// 只拿回一句话。工具的 description 里"不适合"那半句比"适合"更重要——
	// 写宽了，主 agent 会把一次 read 就能答的事也派出去，每次都起 worker，比不用还贵。
	// 领域派活入口（2026-11-23）：读一次决定工具面（schema 随 harness 装载冻结）；
	// 执行层每次懒读，旧调用 / 旧会话带的 domain 也一律忽略。
	const domainDispatch = domainDispatchEnabled();
	const domainList = (): string => {
		try {
			const domains = listManagers(chancellorWorkRoot())
				.map((entry) => entry.domain)
				.filter((domain) => DOMAIN_PATTERN.test(domain));
			return domains.length > 0 ? domains.join(" / ") : "（暂无，可用小写英文新建）";
		} catch {
			return "（当前领域清单不可读）";
		}
	};
	const delegate = defineTool({
		name: "delegate",
		description:
			// 2026-11-16 裁剪 A：政策全文挪进 skills/delegate.md。2026-11-18 去重二刀：
			// 领域名规则与清单只在 domain 参数、resume 怎么填只在 requirement 参数、
			// steps 规则只在 steps 参数；描述只留「何时用、怎么调」+ 指路句
			//（delegate 是 core 技能，始终可取）。
			// 2026-11-23：领域派活入口默认关，关闭时描述不提「领域负责人」。
			"把一件需要多步动手的活派给外面的工人" +
			(domainDispatch ? "（领域负责人/执行者）。" : "（执行者）。") +
			"适合：改多个文件、跑命令、查证之后再动手、在手机上操作 App；" +
			"不适合：闲聊、一次 read 就能答的事、需要边做边问对方的事。" +
			"**派出去立即返回任务单号、后台汇报，不要等结果、不要重复派**；" +
			"**先看工具结果的第一句**：写「派活成功」才是发出去了，可以告诉用户「已派发，完成后会汇报」；" +
			"写「派活失败」/「派活已提交」就照实告诉用户没派成（或还在受理）与下一步，不要嘴上说已派出。" +
			"**新活必须带 `project`**（已登记项目名或 id；手机/设备活豁免）；" +
			"没有可用项目会返回 needs_project 和项目清单——先问用户、用 `propose_project` 提交、等确认再派。" +
			"上一轮的活卡住、或用户刚回答了你问的问题，用 `resume: true` 接原单跑，**不要重新派**。" +
			"多张单并行改同一项目时用 `isolation:\"worktree\"` 隔离副本；只读查证 / 单张小改可用 `isolation:\"direct\"`；不填 = auto（跟随全局默认）。" +
			"**注意**：写文件用相对路径；手机工人碰不到你电脑上的文件，交回来的是一句话。" +
			'**第一次派活前先调 skill({name:"delegate"}) 读完整手册**：任务书四段 / tasks / resume / 四行回报 / 裁决纪律。',
		parameters: Type.Object({
			requirement: Type.String({
				description:
					"要做的事，按四段写清：① 目标（要达成什么）② 怎么算好（验收标准）" +
					"③ 可自主范围（哪些你可以自己定）④ 必须请示（哪些要先问你）。" +
					"带岗位契约时，后两段照契约的「决策分级」「验收标准」写。" +
					"resume 时只写用户的那句回答，不要重述任务。" +
					"要写文件时给相对路径；要读的文件给绝对路径没问题。",
			}),
			project: Type.Optional(
				Type.String({
					description:
						"已登记的项目名或 id。派新活时必填；续跑（resume）时可以省略，沿用原单的项目。" +
						"不知道有哪些项目时，先不带，工具会返回 needs_project 和项目清单。",
				}),
			),
			// 领域派活入口（2026-11-23）：关闭时 domain 不进 schema（模型看不到参数；
			// 旧会话 / 旧调用硬传的也会在执行层被忽略）；打开才恢复领域负责人路径。
			...(domainDispatch
				? {
						domain: Type.Optional(
							Type.String({
								description:
									"领域负责人的领域名，**必须是小写 ASCII**（小写字母、数字、连字符，如 `frontend` / `desktop-shell`）。" +
									`当前已有领域：${domainList()}。` +
									"填了就把活交给该领域负责人；不填则直接派 worker（兼容旧行为）。",
							}),
						),
					}
				: {}),
			targetDevice: Type.Optional(
				Type.String({
					description:
						"把活派给**另一台电脑**的 harness 执行（设备矩阵）。填中结名册里的设备 id。" +
						"`\"auto\"` = 电脑自己挑一台（DEVICE_AUTO_DISPATCH 开启时）：**优先主机**（用户在设置里指定的那台），" +
						"主机满载或离线才按忙碌度外流到别的机器；挑不出就在本机执行并说明原因；不填仍是本机执行。" +
						"设备描述（如「存储机」）与主机位可在 /relay/overview 看到，供点名参考，不参与自动挑选。" +
						"填了就跑远程分支：本机的项目登记表不参与，`project` 由目标机判；" +
						"目标离线会直接失败（不排队）。",
				}),
			),
			resume: Type.Optional(
				Type.Boolean({
					description: "续跑上一张单（触发时机见描述；requirement 只写用户那句回答）。不填 = 新派一件。",
				}),
			),
			requestId: Type.Optional(
				Type.String({
					description:
						"幂等键。同一次派活在重试/重启后要用同一个 id，工具会返回原任务单号，" +
						"不会重复起一张单。不填时服务端按会话 + 需求自动生成。",
				}),
			),
			steps: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"这条要求拆成的可核对动作序列（≤12 条，每条 ≤200 字）。" +
						"多步活（≥3 个动作或跨文件）必写；一句话的小活不写。" +
						"验收项用 `验：` 开头写（如 `验：npm test 全绿`），其余每条算一个动作；" +
						"验收项会在任务详情里单独列出，不要和动作混在一句里。",
				}),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: "任务标题，一句话" }),
						slug: Type.String({ description: "小写字母/数字/连字符，如 write-hello" }),
						instruction: Type.String({ description: "这个任务具体要做什么" }),
						done_when: Type.String({ description: "可机械验证的完成标准" }),
						dependsOn: Type.Optional(
							Type.Array(Type.Number(), {
								description: "依赖的前置 seq（1 起，只能依赖更小的 seq）",
							}),
						),
						writes: Type.Array(Type.String(), {
							description: "这个任务会写的项目内相对路径；只读任务给空数组 []",
						}),
					}),
					{
						description:
							"多步活直接给出任务列表（1-5 个）；不传 = 整单一个任务。写同一个文件的任务必须串成依赖。格式与规则见 skill(delegate)。",
					},
				),
			),
			workdir: Type.Optional(
				Type.String({
					description:
						"这张单在哪个目录里干活。可以是绝对路径，也可以是相对项目主文件夹的路径；" +
						"必须落在已登记的项目 / 主工作区内（登记表外的一律拒绝）。" +
						"不填 = 项目主文件夹。续跑（resume）时不生效，沿用原单目录。",
				}),
			),
			permission: Type.Optional(
				Type.Union([Type.Literal("read"), Type.Literal("edit"), Type.Literal("full")], {
					description:
						"这张单的工具权限档：read=只读、edit=可改文件、full=可跑任意命令。只对 Claude / Codex / OpenCode / 豆包 / CodeBuddy / Qoder 执行器生效（豆包没有只读档，read 只是不额外放权）；" +
						"不填 = 跟随设置里「派活」的默认档。续跑不生效。",
				}),
			),
			isolation: Type.Optional(
				Type.Union(
					[Type.Literal("auto"), Type.Literal("worktree"), Type.Literal("direct")],
					{
						description:
							"这张单的隔离方式：auto=跟随全局默认（CHANCELLOR_TASK_ISOLATION，且只有 git 项目才开 worktree）；" +
							"worktree=这张单强制在副本里改（非 git 项目回落 direct，并在结果里如实说明）；direct=直接在项目目录干。" +
							"多张单并行改同一项目建议 worktree；只读查证 / 单张小改可用 direct。不填 = auto。续跑不生效（沿用原单快照）。",
					},
				),
			),
		}),
		execute: async (args, api, context) => {
			// 派活的进度和「需要你」要能实时到客户端，否则那几分钟界面是死的。
			// 这里把 chancellor 的事件翻译成两种：正在办第几件、需要你回答什么。
			const conversationId = Number(api.conversationId);
			// 计划附件（2026-11-09 §2.1）：先校验，超限不建单、不发送任何副作用。
			const stepsCheck = normalizeDelegationSteps(args.steps);
			if (!stepsCheck.ok) {
				return delegateFailedResult(
					ok({ error: "invalid_steps", message: `派活失败：${stepsCheck.message}` }),
				);
			}
			const steps = stepsCheck.steps;
			if (args.tasks !== undefined) {
				try {
					validateTaskInput(args.tasks, MAX_TASKS_DEFAULT);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return delegateFailedResult(ok({ error: "invalid_tasks", message: `派活失败：${message}` }));
				}
			}
			// 按单隔离（2026-11-23）：非法值明确拒绝，不静默改成 direct / worktree。
			const isolationCheck = normalizeDelegationIsolation(args.isolation);
			if (!isolationCheck.ok) {
				return delegateFailedResult(
					ok({ error: "invalid_isolation", message: `派活失败：${isolationCheck.message}` }),
				);
			}
			const isolation = isolationCheck.isolation;
			// 领域派活入口（2026-11-23，执行层懒读）：关闭时旧调用 / 旧会话带的 domain
			// 强制按空串处理，一律走「无领域直派 worker」；打开才参与路由。
			// domain 参数是条件进 schema 的，静态类型拿不到它（可能为空），这里按旧调用形状读。
			const domainDispatchNow = domainDispatchEnabled();
			const legacyDomain = (args as { domain?: string }).domain;
			const requestedDomain = domainDispatchNow ? (legacyDomain ?? "").trim() : "";
			// 派活路由（2026-11-07）：执事在自己领域内直派，不再绕回分管宰相；
			// 跨领域明确拒绝，不静默改道。总管 / 主人会话维持原语义。
			const routing = resolveDelegateRouting(
				{
					partnerId: effectivePartnerIdOfSession(partnersStore(), conversationId),
					domain: callerDomainOf(conversationId),
				},
				requestedDomain,
			);
			if (routing.kind === "rejected") {
				return delegateFailedResult(err("delegate_rejected", `派活失败：${routing.reason}`));
			}
			const requestFields = routingToRequestFields(routing);
			// 关闭领域派活入口时显式不起分管宰相：请求不带 domain，并带 managers:false。
			// 执事的「在自己领域内直派」仍由 resolveDelegateRouting 给出（D4 执事路由不动），
			// 它本来就带 managers:false，这里只补总管 / 主人会话那一路。
			if (!domainDispatchNow) requestFields.managers = false;
			const domain = requestFields.domain;
			// 远程分支（2026-11-05 阶段二）：点名另一台电脑执行。
			// 本机的项目前置不参与（project 语义归目标机）；离线直接失败不排队。
			const targetDevice = (args.targetDevice ?? "").trim();
			// 自动挑机落回本机时，给最终的派活回话加一行前缀（方案 §2.4：挑不出必须可见）
			let fallbackNotice = "";
			if (targetDevice) {
				// "auto" 是第三态：开关关着就按非法参数拒绝，不让它悄悄降级成本机
				if (targetDevice === "auto" && !deviceAutoDispatchEnabled()) {
					return delegateFailedResult(
						err("auto_disabled", "派活失败：自动挑机未开启（DEVICE_AUTO_DISPATCH）"),
					);
				}
				const client = currentRelayClient();
				if (!deviceMatrixEnabled() || !client) {
					return delegateFailedResult(
						err(
							"device_matrix_unavailable",
							"派活失败：设备矩阵未开启（DEVICE_MATRIX_ENABLED=off 或中继未连接），targetDevice 不可用。",
						),
					);
				}
				if (args.resume === true) {
					return delegateFailedResult(
						err(
							"remote_resume_unsupported",
							"派活失败：远端单的续跑（resume）暂不支持，请直接重派一张新单到该设备。",
						),
					);
				}
				try {
					const result = await dispatchRemoteDelegation(client, {
						targetDeviceId: targetDevice,
						requirement: args.requirement,
						project: args.project?.trim() || undefined,
						domain: domain || undefined,
						originInternalId: conversationId,
					});
					if ("fallbackToLocal" in result) {
						// 挑不出不是失败：本机照常走下面的本地派活路径，只把原因带到回话里。
						fallbackNotice = `自动挑机未成（${result.reason}），已在本机执行。\n`;
					} else {
						// 主机位与设备描述是"点名参考"：给模型/用户看活去了哪台、那台是干什么的
						// （描述只给人看，决策器不读——2026-11-05 主机优先制）。
						const tags = [
							result.pickedHome ? "主机" : "",
							result.deviceDescription ?? "",
						].filter(Boolean);
						return delegateResult(
							`派活成功：已交由设备「${result.deviceName}」${tags.length > 0 ? `（${tags.join("，")}）` : ""}执行（远端请求 ${result.requestId.slice(0, 8)}）。` +
								"它在后台跑，完成后我会把汇报写进本会话。不要重复派、不要轮询。",
							{
								deviceName: result.deviceName,
								requestId: result.requestId,
								...(result.pickedHome ? { pickedHome: true } : {}),
							},
						);
					}
				} catch (error) {
					const code = error instanceof RelayInvokeError ? error.code : "internal";
					const message = error instanceof Error ? error.message.slice(0, 200) : "派发失败";
					return delegateFailedResult(err(code, `派活失败：${message}`));
				}
			}
			// 非法领域名（尤其是中文）直接回可用清单，不建单、不让模型猜。
			if (domain) {
				try {
					validateDomain(domain, chancellorWorkRoot());
				} catch (error) {
					return delegateFailedResult(
						err(
							"invalid_domain",
							`派活失败：${error instanceof Error ? error.message : String(error)}`,
						),
					);
				}
			}
			const asyncMode = envFlag("DELEGATION_ASYNC", true);
			const autoReport = asyncMode && envFlag("DELEGATION_AUTO_REPORT", true);
			const resumeTicketId =
				args.resume === true ? lastTicketByConversation.get(conversationId) : undefined;
			if (args.resume === true) {
				console.log(
					`[delegate resume] 会话 ${conversationId} 续跑 ${resumeTicketId ?? "(无)"}` +
						`，回答=${JSON.stringify(args.requirement.slice(0, 120))}`,
				);
			}

			// 项目前置（方案 §5.5）：派新活必须过登记表；续跑沿用原单 / 上一轮的项目。
			// 没有项目时**不建单、不建目录、不写文件**，只把清单交回给模型。
			// 设备 worker（手机 / 点名设备的跨机派发）不落本机磁盘：豁免前置，按无项目单
			// 受理（2026-11-08 扫尾批 3-H B3）。豁免只放行这一段，resolveDelegationProject
			// 的 realpath / 工作区复核一点不动——设备活根本不该进那段。
			const deviceWork = deviceProjectExempt && isDeviceWorkerDelegation(args);
			let project: ProjectRef | undefined;
			if (projectRequired && !deviceWork) {
				if (args.project?.trim()) {
					const gate = resolveDelegationProject(args.project, deps.projects ?? null);
					// needs_project 是"没派成"：项目清单仍进 data（模型要用来问用户），
					// 但工具结果标 isError，界面不再画成成功。
					if (!gate.ok) return delegateNeedsProject(gate.text);
					project = gate.project;
				} else if (resumeTicketId === undefined) {
					const gate = resolveDelegationProject(undefined, deps.projects ?? null);
					if (!gate.ok) return delegateNeedsProject(gate.text);
					project = gate.project;
				} else {
					// 老会话重启后可能记不住项目；续跑本身不需要新项目。
					project = lastProjectByConversation.get(conversationId);
				}
			}

			// 工作目录（2026-11-17）：总管按单指定，不填 = 项目主文件夹。
			// 只对新派生效（续跑沿用原单快照）；必须落在已登记项目 / 主工作区内，
			// 登记表之外的路径直接拒绝建单——那是"目录越界"，不是能力限制。
			let workDir: string | undefined;
			const rawWorkDir = (args.workdir ?? "").trim();
			//（DELEGATE_WORKDIR 回滚开关 2026-11-21 退役，按单指定目录恒生效。）
			if (resumeTicketId === undefined && rawWorkDir) {
				const store = deps.projects ?? projectsStore();
				const base = project?.rootPath ?? store.getWorkspace()?.rootPath;
				const pick = resolveChatDir(rawWorkDir, store, base);
				if (!pick.ok) {
					return delegateFailedResult(
						ok({ error: "bad_workdir", message: `派活失败：${pick.message}` }),
					);
				}
				workDir = pick.pick.path;
			}

			// 派活注入项目记忆（2026-11-16）：只拼进交给 chancellor 的 requirement，
			// **不参与上面的幂等指纹**——同一请求不能因为记忆更新而变成"内容不同"。
			// 记忆库读不出来 / 开关关着 → 空串，requirement 原样。
			const projectMemory = delegationProjectMemoryText(deps.memory, project, args.requirement);
			const delegationRequirement = appendDelegationProjectMemory(args.requirement, projectMemory);
			// 总管直给 tasks 时拆单器不再分发 requirement，项目记忆必须显式拼进每个 task。
			const tasksForDispatch =
				args.tasks !== undefined && projectMemory !== ""
					? args.tasks.map((task) => ({
							...task,
							instruction: `${task.instruction}\n\n${projectMemory}`,
						}))
					: args.tasks;

			// 幂等回执（方案 §5.1）：新派先落回执再入队；续跑不建新单，
			// 只补一行 `resume:<原单id>:<次数>` 的会话映射（见下方受理之后那段）。
			const receipts = resumeTicketId === undefined ? receiptsOf(deps) : null;
			const explicitRequestId = (args.requestId ?? "").trim();
			const requestId = receipts
				? explicitRequestId || autoRequestId(conversationId, args.requirement)
				: "";
			const fingerprint = requestId
				? requestFingerprint({
						conversationId,
						requirement: args.requirement,
						domain,
						projectId: project?.id ?? "",
					})
				: "";
			// 触发来源（批 15 §三）：回执簿记与 ticket 准入优先级共用同一次判定。
			// 优先级是内部推导（2026-11-22 M1b），不给 delegate 工具加参数、不暴露给模型。
			const runSource = delegationRunSource({
				device: deviceWork,
				routineTurn: isRoutineTurn(conversationId),
			});
			if (receipts && requestId) {
				const begun = receipts.begin(requestId, fingerprint, {
					explicit: Boolean(explicitRequestId),
					workRoot: chancellorWorkRoot(),
					// 授权依据（批 19 §六）：受理这一刻的审批档位 + 时间，只记录不判定。
					authority: currentAuthority(),
					// 触发来源（批 15 §三）：例行轮 / 设备 / 人；开关关着不写。
					...(runSourceEnabled() ? { runSource } : {}),
				});
				if (begun.kind === "conflict") {
					// 同一 requestId 但内容不同：不报冲突、不让模型换号重派，直接把原单交回。
					const existing = begun.receipt?.ticketId ?? "";
					if (existing) lastTicketByConversation.set(conversationId, existing);
					return delegateResult(
						`派活成功（沿用原单）：该请求号已受理过，返回原单${existing ? ` ${existing}` : "（原单还在受理中）"}，没有重复派。` +
							"后台跑完会汇报。",
						existing ? { ticketId: existing } : {},
					);
				}
				if (begun.kind === "uncertain") {
					// 结果未知是**业务分支**：ticketId 必须留在 data 里，模型要先用它确认，不能重派。
					// 对外仍按"没确认成功"处理（isError），别在界面上画成派成功。
					return delegateFailedResult(
						ok({
							error: "uncertain",
							ticketId: begun.receipt?.ticketId ?? "",
							message:
								"派活未确认：这张单在受理时中断过，结果未知。先确认它是否已经在跑，不要盲目重派。",
						}),
					);
				}
				if (begun.kind === "existing") {
					const existing = begun.receipt?.ticketId ?? "";
					if (existing) lastTicketByConversation.set(conversationId, existing);
					return delegateResult(
						`派活成功（沿用原单）：这次派活已经受理过，沿用原任务单 ${existing || "(受理中)"}，没有重复派。` +
							"后台跑完会汇报。",
						existing ? { ticketId: existing } : {},
					);
				}
			}

			// 立即受理：同步拿到任务单号，后台跑完再发事件/回灌。
			const { ticketId, outcome, fellBack, executor } = startDelegation(
				{
					conversationId,
					domain,
					requirement: delegationRequirement,
					// ticket 准入优先级（2026-11-22 M1b）：按触发来源推导，不来自模型参数。
					priority: priorityOfRunSource(runSource),
					resumeTicketId,
					project,
					...(steps ? { steps } : {}),
					...(tasksForDispatch !== undefined ? { tasks: tasksForDispatch } : {}),
					...(requestId ? { requestId } : {}),
					// 工作目录与权限档（2026-11-17）：只写进新单；续跑由 chancellor 沿用原单。
					//（DELEGATE_WORKDIR 回滚开关 2026-11-21 退役，恒生效。）
					...(workDir ? { workDir } : {}),
					...(args.permission ? { employeePermission: args.permission } : {}),
					// 按单隔离（2026-11-23）：auto 也带上，由 startDelegation 决定不写快照。
					...(isolation ? { isolation } : {}),
					// 执事在自己领域内直派（2026-11-07）：不带 managers 就是既有分管路径
					...(requestFields.managers === false ? { managers: false as const } : {}),
					// 派活留言（2026-11-07）：谁在什么身份下说的这句话，落进任务详情
					...(senderOf(conversationId)
						? { sender: senderOf(conversationId)! }
						: {}),
				},
				{
					run: (request, options) =>
						run(
							{ ...request, workRoot: chancellorWorkRoot() },
							{
								...options,
								// 后台执行不能挂本轮对话的 abortSignal：用户这一轮结束不该杀掉任务。
								// M0（2026-11-22）：async 只挂每票的取消 controller（options.signal，
								// 由 startDelegation 传入并注册）；同步回滚路径两路都挂，任一中断都停。
								signal: combineAbortSignals(
									options.signal,
									asyncMode ? undefined : context.abortSignal,
								),
							},
						),
					emit: emitDelegation,
					report: deps.reportDelegation,
					autoReport,
					// 双写（8g）：进度 / REPORT / 留言同步进这张单的专线会话。
					// 不传 = 旧行为（探针/单测不碰 durable）。
					...(deps.mirrorDelegation ? { mirror: deps.mirrorDelegation } : {}),
					// 作废位（扫尾批 1 A1）：后台 settle / 进度帧现查一次，取消后立刻静默。
					// 用可选调用兜住单测注入的 receipts 替身（它可能没有这个方法）。
					isCanceled: (id) => receiptsOf(deps).isCanceled?.(id) ?? false,
					// 终态结算落一条 work 履历到发起执事 scope（刀二 E2）；中间态 / 无执事
					// / 写失败都在 work-record.ts 与 delegation.ts 内部兜住，不挡派单。
					recordWork: recordWorkSettlement,
					// 只有本机 delegate 按 domain 反查执事身份；远程锚点会话不装配这个缝。
					identityHitFor: localIdentityHit,
					// 续跑授权重验（批 19 §六）：受理档位取回执，现在档位取运行时策略。
					authorityAtAccept: (id) =>
						receiptsOf(deps).lookupByTicket(id)?.authority?.level ?? null,
					approvalLevelNow: () => currentApprovalLevel(),
					log: (line) => console.warn(line),
				},
			);
			if (ticketId) lastTicketByConversation.set(conversationId, ticketId);
			if (project) lastProjectByConversation.set(conversationId, project);
			// 续跑回执（2026-11-08 扫尾批 7a）：resume 沿用原单、不建新单，
			// 回执也必须写一行，把这张单映射到**这次发起 resume 的会话**——
			// 否则完成/重启恢复（A3b）按最初派单那行回灌，回答过的人看不到下文。
			// 键用 `resumeTicketId` 而不是 `ticketId`：后者要等事件同步段填，且续跑本来就
			// 只可能落在原单上（chancellor `resumeTicket()` 返回的就是 ticket.id）。
			if (resumeTicketId !== undefined && !fellBack) {
				receiptsOf(deps).recordResume(resumeTicketId, conversationId);
			}
			// 改派回执（2026-11-08 批 10-A，上位计划 §四⑤）：续跑被拒改派时，
			// `startDelegation` 建的是一张**新单**，而这条路径 `receipts` 为 null（上面按
			// "resume 不建新单"跳过 begin），新单就一条映射都没有——完成/重启回灌查
			// `lookupByTicket(新单号)` 落空。与 7a 同款键法补一行 `resume:<新单号>:<次数>`，
			// 指向**发起续跑的会话**，汇报才回得到提问的人。
			if (fellBack && ticketId) {
				receiptsOf(deps).recordResume(ticketId, conversationId);
			}
			if (receipts && requestId) {
				if (ticketId) receipts.accept(requestId, ticketId, conversationId);
				// 失败时回执要跟着落：拿到单号记 failed，没拿到记 uncertain（不自动重派）。
				void outcome
					.then((result) => {
						if (result.ticketId) receipts.accept(requestId, result.ticketId, conversationId);
					})
					.catch(() => receipts.markFailed(requestId));
			}

			// 想续跑但没有老单（空会话 / 重启后），也算走了"没单可续"。
			const noTicket = fellBack || (args.resume === true && resumeTicketId === undefined);

			// 回滚路径（DELEGATION_ASYNC=false）：保持 2026-11-02 的同步行为。
			if (!asyncMode) {
				try {
					const result = await outcome;
					lastTicketByConversation.set(conversationId, result.ticketId);
					const line = result.line || "派出去的活没有返回结论。";
					const ticket = result.ticketId ? { ticketId: result.ticketId } : {};
					// 同步路径等到了终态：成功 / 失败说在明面上（2026-11-25 用户口径）。
					const head =
						result.status === "done"
							? "派活成功："
							: result.status === "failed" || result.status === "aborted"
								? "派活失败："
								: `派活未完成（${result.status}）：`;
					if (noTicket) {
						return delegateResult(
							`${head}${fallbackNotice}${line}\n（没有可续的单，已按新活派）`,
							ticket,
						);
					}
					if (resumeTicketId) {
						return delegateResult(
							`${head}${fallbackNotice}${line}\n（已把用户的回答交回原单，它在接着做。）`,
							ticket,
						);
					}
					return delegateResult(head + fallbackNotice + line, ticket);
				} catch {
					return delegateFailedResult(
						err("delegate_failed", `${fallbackNotice}派活失败：派单失败，请稍后再试。`),
					);
				}
			}

			const ticket = ticketId ? { ticketId } : {};
			const domainField = domain ? { domain } : {};
			const executorText = executor
				? executorSummary(executor.employee, executor.profile)
				: "";
			// 还没拿到单号 ≠ 已受理：如实说"已提交、受理中"，不冒充成功。
			const ticketText = ticketId ? `任务单 ${ticketId}` : "任务单还在受理中（还没拿到单号）";
			if (noTicket) {
				return delegateResult(
					`${ticketId ? "派活成功" : "派活已提交"}（没有可续的单，已按新活派）：${fallbackNotice}${ticketText}` +
						`${domain ? `（领域：${domain}）` : ""}${executorText ? `；交给 ${executorText}` : ""}。` +
						"它在后台执行，完成后我会汇报。",
					{ ...ticket, ...domainField },
				);
			}
			if (resumeTicketId) {
				return delegateResult(
					`续跑成功：${fallbackNotice}已把回答交回原单 ${ticketId}（续跑沿用原单的工人），它继续在后台跑，完成后我会汇报。`,
					ticket,
				);
			}
			return delegateResult(
				`${ticketId ? "派活成功" : "派活已提交"}：${fallbackNotice}` +
					`${executorText ? `已派发到 ${executorText}` : "已受理"}；${ticketText}` +
					`${domain ? `（领域：${domain}）` : ""}。` +
					"它在后台执行，完成后我会汇报；不要等，也不要重复派。",
				{ ...ticket, ...domainField },
			);
		},
	});

	const tools: ToolRegistration[] = [remember, recall, remind];

	// 会话考古（2026-11-09 T4 §4）：条件注册，不进基线 10 个工具；只读，不进 WRITE_TOOLS。
	// 回滚：lifecycle 不传 deps.recallSessions（AGENT_RECALL_SESSIONS=false）→ 这里整块不执行。
	if (deps.recallSessions) {
		const searchSessions = deps.recallSessions;
		tools.push(
			defineTool({
				name: "recall_sessions",
				description:
					"在**以前所有对话的原文**里找一句话（含执事会话、群聊、任务专线）。" +
					"记忆想不起来、或者要确认「上次是不是聊过这件事」时用它；只读，不改任何东西。" +
					"返回会话标题、时间和命中处前后各约 100 字；查不到就返回空。",
				parameters: Type.Object({
					query: Type.String({ description: "要找的内容，至少 2 个字；用关键词或一句话" }),
					days: Type.Optional(
						Type.Number({
							description: "只搜最近多少天，默认 30",
							minimum: 1,
							maximum: 365,
						}),
					),
					limit: Type.Optional(
						Type.Number({ description: "最多返回几条，默认 5", minimum: 1, maximum: 20 }),
					),
				}),
				execute: async (args) => {
					let hits: SessionSearchHit[];
					try {
						hits = await searchSessions(args.query, {
							...(args.days === undefined ? {} : { days: args.days }),
							...(args.limit === undefined ? {} : { limit: args.limit }),
						});
					} catch (error) {
						// 只记原因，不记 query 原文（日志纪律）
						const detail = error instanceof Error ? error.message : String(error);
						console.warn(`[recall_sessions] 检索失败: ${detail.slice(0, 200)}`);
						return textToolResult(
							err("recall_failed", "会话检索这次没跑成。", "换个关键词再试；还不行就明说查不了，不要编。"),
						);
					}
					// 只记字数与条数，不记 query 原文与正文（D8 / 日志纪律）
					console.log(`[recall_sessions] q=${args.query.length}字 hits=${hits.length}`);
					if (hits.length === 0) {
						return textToolResult(
							ok({ count: 0, hits, message: "没有找到相关的对话记录。" }),
						);
					}
					return textToolResult(
						ok({
							count: hits.length,
							hits,
							message: hits
								.map((hit) => {
									const when = hit.at
										? new Date(hit.at).toISOString().slice(0, 10)
										: "日期未知";
									return `- ${when}｜${hit.title || "（无标题）"}（${hit.conversationId}）\n  …${hit.snippet}…`;
								})
								.join("\n"),
						}),
					);
				},
			}),
		);
	}

	if (deps.skills) {
		const skills = deps.skills;
		tools.push(
			defineTool({
				name: "skill",
				description:
					"取一份技能手册（完整流程）。会话的 skills 索引里列出了可用技能；" +
					"要按某个流程引导对方时，先调它拿到手册，再照着做。",
				parameters: Type.Object({
					name: Type.String({ description: "技能名，必须是索引里列出的名字" }),
				}),
				execute: async (args, context) => {
					// 2026-11-15 按人可见：执事会话用真实 uuid；主对话用 effective（= chief）。
					// 2026-11-21：worker 会话由装配层给保留键 `worker`，普通助手有自己的技能勾选。
					// 读不到就当无 partner（只走全局启停位），别让技能工具把整轮弄哑。
					let partnerId: string | null = null;
					try {
						partnerId = deps.skillOwnerOf
							? await deps.skillOwnerOf(Number(context.conversationId))
							: COMPANIONS_ENABLED
								? effectivePartnerIdOfSession(partnersStore(), Number(context.conversationId))
								: null;
					} catch {
						partnerId = null;
					}
					const manual = skills.manual(args.name, partnerId);
					if (!manual) {
						return textToolResult(
							err(
								"skill_not_found",
								`没有叫「${args.name}」的技能。可用：${skills.names(partnerId).join("、") || "（无）"}`,
								"从会话的 skills 索引里挑一个名字再取。",
							),
						);
					}
					// 取到才计数（2026-11-10 批 17 §四）：拿不到手册不算使用。
					recordSkillUse(args.name);
					return textToolResult(ok({ name: args.name, message: manual }));
				},
			}),
		);
	}

	// 执事间递话（2026-11-08 扫尾批 8d）：装配层显式传 deps.relay 才上架。
	// 不做 deps 缺省回落——"主人对话不挂 / 回滚开关"必须由装配层一处决定（lifecycle）。
	if (deps.relay) tools.push(createSendToAgentTool(deps.relay));

	// 技能分类建议落盘（2026-11-10 批 30 修订）：装配层显式传 deps.skillAdviceSave 才上架
	//（SKILL_ADVICE=false → 不传 = 不上架）。评估流程是"设置页 → 总管对话预填提示词 →
	// 总管逐条评估 → 本工具把 JSON 结果写进快照 → 用户回设置页采纳"，
	// 写的只是建议快照（.data/skills-advice.json），**不碰启停位**（采纳是人的动作，走 PUT）。
	if (deps.skillAdviceSave) {
		const saveAdvice = deps.skillAdviceSave;
		tools.push(
			defineTool({
				name: "save_skill_advice",
				description:
					"把技能分类评估的结果一次性写进建议快照（设置页的三栏与频率就是读它）。" +
					"只在主人让你评估技能库、并且你已经逐条判断完之后调用一次。" +
					"清单里没评估到的技能不会被覆盖——快照会保留它们原来的建议。" +
					"它不改变任何技能的开关：主人会回设置页自己决定采纳哪些。",
				parameters: Type.Object({
					items: Type.Record(
						Type.String(),
						Type.Array(Type.String(), { maxItems: 3, minItems: 3 }),
						{
							description:
								"技能名 → [bucket, frequency, reason] 三元素数组。" +
								"bucket: keep(建议开启)|scene(按场景)|skip(建议不开)；" +
								"frequency: daily|weekly|monthly|rare（rare 应配 skip）；reason ≤20 字",
						},
					),
				}),
				execute: async (args) => {
					const result = saveAdvice(args.items);
					if (!result.ok) {
						return textToolResult(err(result.error, result.message, result.hint));
					}
					const { saved, kept } = result;
					return textToolResult(
						ok({
							saved,
							kept,
							message:
								`已存 ${saved} 条建议${kept ? `（另保留快照里原有 ${kept} 条未被本次清单覆盖）` : ""}。` +
								"主人可以回设置页技能页查看分栏并采纳。",
						}),
					);
				},
			}),
		);
	}

	if (deps.delegate !== false) tools.push(delegate, proposeProject);

	// 结构化提问（2026-11-09 保证实现纵深 §3）：默认上架，AGENT_ASK_USER=false 一行回滚。
	// 它不写盘、不起进程，因此不在 WRITE_TOOLS / 高危清单里。
	if (askUserEnabled()) tools.push(createAskUserTool());

	// 决策上报答复（2026-11-19 批2）：总管 / 派活方执事对 worker 的 escalation 给结论。
	// 上架闸 = CHANCELLOR_ENABLED（ESCALATION_CHAIN_ENABLED 回滚开关 2026-11-21 退役）；
	// 按需池默认成员（tool-pool），初始不进请求、不打上游 prompt cache。
	if (respondEscalationAvailable()) tools.push(createRespondEscalationTool());

	// agent 中途播报（2026-11-10 批 13 §三）：装配层显式传 progressReport 才上架
	// （AGENT_PROGRESS_REPORT=false / 0 / off → 不上架，一行回滚）。
	// 它不写盘、不起进程：不进 WRITE_TOOLS / 高危清单，只登记能力声明。
	if (deps.progressReport === true) {
		tools.push(createReportProgressTool({ mirrorTaskNotice: deps.mirrorTaskNotice }));
	}

	// 执事技能写入（2026-11-05 批次B B2；批次D D1 扩到主对话=总管）。
	// 写的是 partner-homes/<id>/skills/<slug>.md（64KB 上限、原子写都在 partners.ts）。
	// 执事会话写该执事的技能；主对话（owner 会话）解析为 chief → 写总管技能库；
	// CHIEF_PARTNER=false 时 owner 会话照旧返回"不属于任何执事"（回滚到改动前）。
	//
	// 执事管理 partner_manage（批次D D3）与 partner_skill_write 一起挂在执事能力开时。
	// deps.partners 缺省回落 COMPANIONS_ENABLED：agent.ts 装配时不显式传 partners，
	// 主对话（总管）也能用；COMPANIONS_ENABLED=false 两件都不注册 = 一行回滚。
	const partnersOn = deps.partners ?? COMPANIONS_ENABLED;
	const ministerContext = deps.ministerContext ?? defaultMinisterContext;
	if (partnersOn) {
		tools.push(
			defineTool({
				name: "partner_skill_write",
				description:
					"把一份技能手册写进当前执事的技能库（skills/<slug>.md，首行 = 索引用的一句话摘要）。" +
					"执事会话写各自的技能库，主对话写总管技能库；写盘即生效，下一轮进身份提示词的技能索引。" +
					// 2026-11-08 员工人格化刀三 E3：被教新方法 / 自己总结出可复用做法时主动沉淀。
					"被主人教了新方法、或自己总结出可复用的做法时，写成技能文件" +
					"（文件名 = 活的名字，第一行 = 一句索引用摘要），下次同类任务书可直接引用。",
				parameters: Type.Object({
					slug: Type.String({
						description: "技能名，小写字母/数字/短横线，1-64 字符，如 daily-brief",
					}),
					content: Type.String({ description: "技能手册全文（Markdown）；第一行是索引用摘要" }),
				}),
				execute: async (args, context) => {
					// effectivePartnerIdOfSession：执事会话 → 真实 uuid；主对话 → "chief"（CHIEF 开时）。
					// 用 chief 感知的解析而非裸 partnerIdOfSession，是为了让主对话也能写总管技能；
					// 裸函数仍被 autonomy/routines 当"是否主人会话"用，语义不能改。
					const partnerId = effectivePartnerIdOfSession(
						partnersStore(),
						Number(context.conversationId),
					);
					if (!partnerId) {
						return textToolResult(
							err(
								"not_partner_session",
								"这个会话不属于任何执事，不能写执事技能。",
								"在执事自己的会话里再写；主对话写的是总管技能库，不是执事技能。",
							),
						);
					}
					if (!/^[a-z0-9][a-z0-9-_]{0,63}$/.test(args.slug)) {
						return textToolResult(
							err(
								"invalid_slug",
								"slug 只能是小写字母/数字/短横线，1-64 字符。",
								"用 daily-brief 这种短横线名字。",
							),
						);
					}
					if (!args.content.trim() || !args.content.trim().split("\n")[0]?.trim()) {
						return textToolResult(
							err("empty_summary", "技能手册第一行是索引摘要，不能为空。"),
						);
					}
					try {
						partnersStore().atomicWrite(
							join(partnersStore().skillsDirOf(partnerId), `${args.slug}.md`),
							args.content,
						);
						return writeToolResult(`技能 ${args.slug} 已写入执事技能库，下一轮进索引。`);
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						return textToolResult(err("write_failed", `写入失败：${detail}`));
					}
				},
			}),
		);
	}

	// 执事管理（批次D D3）：总管建 / 停 / 列执事。核心逻辑在 partner-manage.ts，
	// 与 companion-api 端点共用；这里只做参数校验、权限闸与模型友好的文案包装。
	if (partnersOn) {
		tools.push(
			defineTool({
				name: "partner_manage",
				description:
					"总管管理执事：create 建一个、stop 停一个、list 列出全部、set_dispatch 切某个执事的派发权（是否作为分管负责人接单，默认关）。" +
					"只有总管 / 主对话能用。" +
					(domainDispatch
						? "建好后用 delegate(domain=<domain>) 或直接按名字把活派给它。"
						: "建好后直接用 delegate 把活派给它（领域派活入口已停用，不需要 domain 参数）。"),
				parameters: Type.Object({
					action: Type.Unsafe<"create" | "stop" | "list" | "set_dispatch">({
						type: "string",
						enum: ["create", "stop", "list", "set_dispatch"],
						description: "create=建执事 / stop=停执事 / list=列出执事 / set_dispatch=切派发权",
					}),
					name: Type.Optional(Type.String({ description: "create 必填，展示名，≤40 字" })),
					domain: Type.Optional(
						Type.String({
							description:
								"create 可选，小写 ASCII 的领域标签（备注用，不是路由键）。" +
								"不确定填什么就留空——留空照样能建执事、照样能派活。",
						}),
					),
					soul: Type.Optional(Type.String({ description: "create 可选，一句话身份；缺省用默认播种" })),
				enabled: Type.Optional(
					Type.Boolean({ description: "set_dispatch 必填：true=开派发权 / false=关" }),
				),
					partnerId: Type.Optional(
						Type.String({ description: "stop/set_dispatch 必填（执事 id）；list 可选按 id 过滤" }),
					),
				}),
				execute: async (args, api) => {
					const ctx = ministerContext();
					const conversationId = Number(api.conversationId);
					// 只有总管 / 主对话能管理执事：effectivePartnerIdOfSession 落到非 chief 的真实
					// uuid（某执事的专线会话）一律拒；owner 会话解析为 chief / null，放行。
					const effective = effectivePartnerIdOfSession(ctx.store, conversationId);
					if (effective !== null && effective !== CHIEF_PARTNER_ID) {
						return textToolResult(err("forbidden", "只有总管可以管理执事"));
					}
					if (args.action === "create") {
						const name = (args.name ?? "").trim();
						const domain = (args.domain ?? "").trim();
						if (!name) return textToolResult(err("invalid_name", "name 必填且不超过 40 字"));
						if (args.soul && args.soul.length > 4000) {
							return textToolResult(err("soul_too_long", "soul 太长，一句话身份即可"));
						}
						const result = createMinisterPartner(
							{ name, ...(domain ? { domain } : {}), soul: args.soul },
							ctx,
						);
						if (!result.ok) {
							// 核心层只回一句中文；这里把它归到三个稳定码，模型据此决定改 domain 还是改名字。
							const code = result.error.includes("已被其他执事占用")
								? "domain_taken"
								: result.error.includes("domain 必须")
									? "invalid_domain"
									: "create_failed";
							return textToolResult(err(code, result.error));
						}
						// 领域只是标签（2026-11-07）：留空也要说清"照样能派活"，
						// 否则模型会以为建了个残缺的执事。
						// 2026-11-23：领域派活入口关闭时不再提 delegate(domain=…)，改为直接派给它。
						if (result.value.domain) {
							return writeToolResult(
								domainDispatch
									? `执事 ${result.value.name} 已就位（领域标签：${result.value.domain}）。之后 delegate(domain=${result.value.domain}) 或直接按名字派都行。`
									: `执事 ${result.value.name} 已就位（领域标签：${result.value.domain}）。之后直接用 delegate 派给它就行。`,
							);
						}
						return writeToolResult(
							`执事 ${result.value.name} 已就位（没有领域标签，不影响派活）。之后用 delegate 派给它就行。`,
						);
					}
					if (args.action === "stop") {
						const partnerId = (args.partnerId ?? "").trim();
						if (!partnerId) {
							return textToolResult(err("missing_partner_id", "stop 需要 partnerId（执事 id）"));
						}
						if (partnerId === CHIEF_PARTNER_ID) {
							return textToolResult(
								err(
									"forbidden",
									"不能停总管自己：总管是主对话本体，不在可停用的执事里。",
								),
							);
						}
						const partner = ctx.store.get(partnerId);
						if (!partner || !partner.domain) {
							return textToolResult(
								err(
									"not_found",
									`找不到 id 为 ${partnerId} 的执事（只能停带 domain 的执事）。`,
								),
							);
						}
						const result = stopMinisterPartner(partnerId, ctx);
						if (!result.ok) {
							return textToolResult(err("not_found", "执事不存在或已被停用。"));
						}
						return writeToolResult(
							`执事 ${partner.name}（domain=${partner.domain}）已停用并归档，之后派活不要再指向它。`,
						);
					}
					if (args.action === "list") {
						const rows = listMinisterPartners(ctx, (args.partnerId ?? "").trim() || undefined);
						if (rows.length === 0) return writeToolResult("（暂无执事；用 create 建一个）");
						return writeToolResult(
							rows.map(
								(row) =>
									`${row.name} · ${row.domain} · ${row.status} · 派发权${row.dispatchAuthority ? "开" : "关"}`,
							).join("\n"),
						);
					}
					if (args.action === "set_dispatch") {
						const dispatchId = (args.partnerId ?? "").trim();
						if (!dispatchId) {
							return textToolResult(
								err("missing_partner_id", "set_dispatch 需要 partnerId（执事 id）"),
							);
						}
						if (typeof args.enabled !== "boolean") {
							return textToolResult(
								err(
									"invalid_argument",
									"set_dispatch 需要 enabled（true=开 / false=关）",
								),
							);
						}
						const result = setMinisterDispatchAuthority(dispatchId, args.enabled, ctx);
						if (!result.ok) return textToolResult(err("not_found", result.error));
						// 领域派活入口关闭时，派发权只在开关打开后才接回分管路径；
						// 回话不能说成「delegate(domain=…) 会以它的名义派分管」。
						const dispatchText = domainDispatch
							? args.enabled
								? "打开：之后 delegate(domain=…) 会以它的名义派分管"
								: "关闭：之后 delegate(domain=…) 不再经过它，等同无分管领域"
							: args.enabled
								? "打开：领域派活入口目前关闭，派活仍走直派 worker；开关打开后才恢复分管"
								: "关闭：领域派活入口目前关闭，派活本来就不经过它";
						return writeToolResult(
							`执事 ${result.value.name}（domain=${result.value.domain}）的派发权已${dispatchText}。`,
						);
					}
					return textToolResult(
						err("invalid_action", "action 只能是 create / stop / list / set_dispatch"),
					);
				},
			}),
		);
	}

	// 群组管理 group_manage（2026-11-07 群组入口统一）：**总管在对话里建群**。
	// 之前只有界面按钮能建群，模型侧没有对应的手——总管说「建个群」只能干看着，
	// 与 partner_manage（总管能建/停执事）的能力面不对称。
	//
	// v1 只开 create / list：改名/加减人/删群留在界面由人点（删群不可恢复、改名歧义大，
	// 不值得给模型一只手）。详见 designs/2026-11-07-群组入口统一。
	//
	// 开关与端点同一个：GROUPS_ENABLED 或 COMPANIONS_ENABLED 任一个关着 → 工具不注册
	// （一行回滚，模型也够不到建群）。
	const groupsOn = deps.groups ?? groupsAvailable();
	const groupContext = deps.groupContext ?? defaultGroupContext;
	if (partnersOn && groupsOn) {
		tools.push(
			defineTool({
				name: "group_manage",
				description:
					"总管管理群组（执事群聊）：create 建一个群、list 列出全部群；只有总管 / 主对话能用。" +
					"成员用**名字**指定（个数与值日缺省见参数）。建好后说话不 @ 就发给值日，@名字 就点名。",
				parameters: Type.Object({
					action: Type.Unsafe<"create" | "list">({
						type: "string",
						enum: ["create", "list"],
						description: "create=建群 / list=列出群",
					}),
					name: Type.Optional(Type.String({ description: "create 必填，群名，≤40 字" })),
					members: Type.Optional(
						Type.Array(Type.String(), {
							description: "create 必填，2–6 位执事的名字（不是 id）",
						}),
					),
					responder: Type.Optional(
						Type.String({
							description: "create 可选，值日执事的名字（必须是成员）；不填取第一位成员",
						}),
					),
					notice: Type.Optional(
						Type.String({ description: "create 可选，群公告 ≤500 字（这个群是干什么的）" }),
					),
				}),
				execute: async (args, api) => {
					const ctx = groupContext();
					const conversationId = Number(api.conversationId);
					// 权限判据与 partner_manage 逐字一致：只有总管 / 主对话能建群。
					// effectivePartnerIdOfSession 落到非 chief 的真实 uuid = 某执事的会话 → 拒。
					const effective = effectivePartnerIdOfSession(ctx.store, conversationId);
					if (effective !== null && effective !== CHIEF_PARTNER_ID) {
						return textToolResult(err("forbidden", "只有总管可以建群"));
					}
					if (args.action === "list") {
						const rows = ctx.store.listGroups();
						if (rows.length === 0) return writeToolResult("（暂无群组；用 create 建一个）");
						return writeToolResult(
							rows
								.map((row) => {
									const duty = row.members.find(
										(member) => member.partnerId === row.responderPartnerId,
									);
									const who = row.members.map((member) => member.name).join("、");
									const reply =
										row.responderKind === "everyone"
											? "不 @ 全员回"
											: row.responderKind === "mentions"
												? "只回点名"
												: duty
													? `值日 ${duty.name}`
													: "值日未设";
									return `${row.name} · ${row.members.length} 人（${who}）· ${reply}`;
								})
								.join("\n"),
						);
					}
					if (args.action === "create") {
						const name = (args.name ?? "").trim();
						if (!name) {
							return textToolResult(err("invalid_name", "create 需要 name（群名，≤40 字）"));
						}
						if (name.length > 40) {
							return textToolResult(err("invalid_name", "群名不超过 40 字"));
						}
						const memberNames = (args.members ?? []).map((value) => String(value));
						const resolved = resolvePartnersByName(memberNames, ctx.store);
						// 成员名解析失败是参数非法（重名 / 查无此人），文案里已经带可用清单，
						// 不塞进 data：data 是成功后的结构化结果，不是错误容器。
						if (!resolved.ok) {
							return textToolResult(
								err(
									resolved.error.includes("不止一位") ? "ambiguous_member" : "member_not_found",
									resolved.error,
								),
							);
						}
						const duty = resolvePartnerByName(args.responder, ctx.store);
						if (!duty.ok) {
							return textToolResult(
								err(
									duty.error.includes("不止一位") ? "ambiguous_responder" : "member_not_found",
									duty.error,
								),
							);
						}
						// 缺省值日 = 第一位成员（模型最常这么建：拉两个人，让先说的那位接话）
						const dutyId = duty.value?.id ?? resolved.value[0]?.id ?? "";
						const created = createGroupChecked(
							{
								name,
								memberIds: resolved.value.map((partner) => partner.id),
								responderKind: "member",
								responderPartnerId: dutyId,
								notice: args.notice ?? "",
							},
							ctx.store,
						);
						if (!created.ok) return textToolResult(err("bad_request", created.error));
						const who = created.value.members.map((member) => member.name).join("、");
						const dutyName =
							created.value.members.find(
								(member) => member.partnerId === created.value.responderPartnerId,
							)?.name ?? "第一位成员";
						return writeToolResult(
							`群组 ${created.value.name} 已建好：${who}；不 @ 时 ${dutyName} 回。` +
								"在群组页打开它就能说话（@名字 点名，@所有人 全员按顺序回）。",
						);
					}
					return textToolResult(err("invalid_action", "action 只能是 create / list"));
				},
			}),
		);
	}

	// 自建巡逻 routine_manage（2026-11-08 员工人格化刀二 E4）：执事给自己建 / 停 / 删
	// 例行规则。装配层显式传 routineSelfService 才上架（照 partner_manage 的条件注册先例）：
	// ROUTINE_SELF_SERVICE=false / COMPANIONS_ENABLED=false → 不上架，一行回滚。
	// 核心逻辑（校验 / 归属 / 上限 / 落库）在 routine-manage.ts，这里只做形状与文案。
	if (deps.routineSelfService === true) {
		const scheduleRoutine = deps.scheduleRoutine;
		tools.push(
			defineTool({
				name: "routine_manage",
				description:
					"管理**你自己**的例行规则（到点自动跑一轮）：create 建、disable 停用、enable 启用、delete 删除。" +
					"只能动自己名下的规则，动别人的一律当找不到；每个执事最多 10 条活动规则。" +
					"create 的 name / prompt / triggers / sessionMode 与可选 untilNote、maxRuns 的格式见参数；其余动作带 id。" +
					"例：主人说「你每周五自己盘点」，就用 create 建一条 cron「0 18 * * 5」的周盘点规则。\n" +
					WORK_REVIEW_GUIDANCE,
				parameters: Type.Object({
					action: Type.Unsafe<RoutineManageAction>({
						type: "string",
						enum: ["create", "disable", "enable", "delete"],
						description: "create=建 / disable=停用 / enable=启用 / delete=删除",
					}),
					id: Type.Optional(Type.String({ description: "disable / enable / delete 必填：自己的规则 id" })),
					name: Type.Optional(Type.String({ description: "create 必填，规则名 ≤40 字" })),
					prompt: Type.Optional(Type.String({ description: "create 必填，每次触发要执行的指令正文" })),
					triggers: Type.Optional(
						Type.Unsafe<RoutineTrigger[]>({
							type: "array",
							items: { type: "object" },
							description:
								"create 必填，非空数组。cron={type:'cron',expr:'0 18 * * 5'} / " +
								"interval={type:'interval',seconds:3600} / once={type:'once',at:'ISO时间'} / " +
								"event={type:'event',kind:'delegation'|'tool'|'phase',match?:{}}",
						}),
					),
					sessionMode: Type.Optional(
						Type.Unsafe<"persistent" | "fresh">({
							type: "string",
							enum: ["persistent", "fresh"],
							description: "create 可选：persistent=复用主会话 / fresh=每轮全新（缺省 persistent）",
						}),
					),
					untilNote: Type.Optional(
						Type.String({
							description:
								"create 可选：完成条件的文字说明（≤200 字）。每轮跑完由你判断达成没有；" +
								"达成时在回复最后单独一行写 [[routine-done]]，规则会自动停用（不删）。",
						}),
					),
					maxRuns: Type.Optional(
						Type.Number({
							description: "create 可选：跑满 N 次自动停（1..1000）；不传 = 不限次数",
							minimum: 1,
							maximum: 1000,
						}),
					),
				}),
				execute: async (args, api) => {
					// partnerId 由**调用者会话**认出后绑定，绝不接受模型传进来的 partnerId
					// （防越权改别人的规则）。主人 / 总管会话没有执事链接 → 明确拒绝。
					let partnerId: string | null = null;
					try {
						partnerId = partnersStore().partnerIdOfSession(Number(api.conversationId));
					} catch {
						// 读库失败按"不属于任何执事"处理，不把原始错误回给模型
					}
					if (!partnerId) {
						return textToolResult(
							err(
								"not_partner_session",
								"这个会话不属于任何执事，不能自建巡逻（只有执事能给自己建规则）。",
								"让执事在自己的会话里建；主对话不代建。",
							),
						);
					}
					let result: RoutineManageResult;
					try {
						result = performRoutineAction(
							{
								action: args.action,
								...(args.id !== undefined ? { id: args.id } : {}),
								...(args.name !== undefined ? { name: args.name } : {}),
								...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
								...(args.triggers !== undefined ? { triggers: args.triggers } : {}),
								...(args.sessionMode !== undefined ? { sessionMode: args.sessionMode } : {}),
								...(args.untilNote !== undefined ? { untilNote: args.untilNote } : {}),
								...(args.maxRuns !== undefined ? { maxRuns: args.maxRuns } : {}),
							},
							defaultRoutineManageContext(partnerId),
						);
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						return textToolResult(err("failed", `操作失败：${detail.slice(0, 200)}`));
					}
					// 自建标记：这条规则的首轮 runSource 记 routine_self（批 15 §三）。
					if (result.ok && args.action === "create" && result.routineId) {
						deps.markSelfRoutine?.(result.routineId);
					}
					// 失败码直接用核心层的稳定枚举（bad_request / not_found / limit）。
					if (!result.ok) return textToolResult(err(result.code, result.message));
					// create / enable 要排 durable 闹钟；排不上只 warn + 在回话里如实说，
					// 规则已经落库（revision / 防自环由 routines.ts 既有机制照常生效）。
					if (result.schedule && result.routineId && scheduleRoutine) {
						try {
							await scheduleRoutine(result.routineId);
						} catch (error) {
							const detail = error instanceof Error ? error.message : String(error);
							console.warn(`[routine_manage] 排定时链失败（规则已建）: ${detail.slice(0, 200)}`);
							// 规则已落库，这是"部分成功"不是失败：message 保留旧文案，
							// scheduled=false 让模型知道闹钟没排上。
							return writeToolResult(
								`${result.message}（定时链没排上，需主人检查会话：${detail.slice(0, 80)}）`,
								{ scheduled: false },
							);
						}
					}
					return writeToolResult(result.message);
				},
			}),
		);
	}

	// 搜索（2026-11-07 建；2026-11-20 从课题开关解耦）：有搜索适配层就注册。
	// web_search 是纯网络读，**不进 WRITE_TOOLS**（approval-policy.ts 不动）。
	const search = deps.search ?? null;
	if (search) {
		tools.push(
			defineTool({
				name: "web_search",
				description:
					"查公开网络资料拿事实（新闻、行情、论文、文档、政策），适合需要实时性或外部资料的问题。" +
					"不适合：内部文件（用 read）、闲聊、以及一次搜索就能答完却反复搜；一次能答就别多搜。",
				parameters: Type.Object({
					query: Type.String({ description: "搜索关键词或一句话问题" }),
					count: Type.Optional(
						Type.Number({ description: "返回条数 1..10，默认 5", minimum: 1, maximum: 10 }),
					),
				}),
				execute: async (args) => {
					const result = await search.webSearch(args.query, args.count);
					if (!result.ok) {
						// code 直接用适配层的稳定枚举（search_not_configured / upstream_error / bad_response）
						return textToolResult(
							err(
								result.error,
								result.message,
								result.error === "search_not_configured"
									? "告诉主人去 设置 → 模型 → 搜索 添加搜索源，别用推理冒充搜索。"
									: undefined,
							),
						);
					}
					if (result.hits.length === 0) {
						return textToolResult(ok({ count: 0, message: "没有找到相关结果。" }));
					}
					// 正常命中只回结构化的 hits（2026-11-25 起不再拼重复的 message）；
					// count 取裁剪后的条数，与 hits.length 始终一致。
					const hits = shapeWebSearchHits(result.hits);
					return textToolResult(ok({ count: hits.length, hits }));
				},
			}),
		);
	}

	// 提醒沉淀建议落盘（2026-11-19 批4）：装配层显式传 deps.reminderAdviceSave 才上架
	//（REMINDER_DISTILL_ENABLED=false → 不传 = 不上架）。流程照技能评估批 30：记忆页 /
	// 人设页入口 → 预填提示词跳总管 → 总管合并同类蒸馏 → 本工具把候选教诲写进建议快照
	//（.data/reminder-advice.json）→ 主人回记忆页逐条采纳才写偏好（D18：只建议、人采纳）。
	// 按需池默认成员（tool-pool）：初始不进请求，不打上游 prompt cache。
	if (deps.reminderAdviceSave) {
		const saveReminderAdvice = deps.reminderAdviceSave;
		tools.push(
			defineTool({
				name: "save_reminder_advice",
				description: SAVE_REMINDER_ADVICE_DESCRIPTION,
				parameters: Type.Object({
					items: Type.Array(Type.String(), {
						minItems: 1,
						maxItems: 30,
						description:
							"蒸馏后的教诲条目，每条一句规矩（做什么 / 不做什么），≤200 字；" +
							"同一个意思已合并、一次性语境已去掉",
					}),
				}),
				execute: async (args) => {
					const result = saveReminderAdvice(args.items);
					if (!result.ok) {
						return textToolResult(err(result.error, result.message, result.hint));
					}
					return textToolResult(
						ok({
							saved: result.saved,
							message: `已存 ${result.saved} 条沉淀建议。主人会回设置 → 记忆页逐条采纳；采纳之前不会写进偏好。`,
						}),
					);
				},
			}),
		);
	}

	// 低频工具索引（2026-11-16 C 段）：默认开。末尾追加，既有工具的注册顺序一个不动
	// （注册顺序是缓存前缀资产）。只有确实存在「会被标 deferred」的工具时才注册，
	// 免得工具面本就没有低频工具时凭空多一个 tool_search。
	if (tools.some((tool) => isDeferredTool(tool.name))) {
		tools.push(
			defineTool({
				name: "tool_search",
				description:
					"按名字取一个低频工具的完整定义并加载它。系统提示词里的「按需工具」清单只给名字和一句话；" +
					"要用其中某个工具，先调本工具，下一轮起它就能正常调用。只接受清单里出现过的名字。",
				parameters: Type.Object({
					name: Type.String({ description: "工具名，必须是「按需工具」清单里列出的名字" }),
				}),
				execute: async (args, api, context) => {
					const name = String(args.name ?? "").trim();
					// 当前会话的真实 agent：deferred = 已启用、还没加载的延迟工具，
					// 天然随勾选变化，也天然排除已经加载进 tools 的那些（不新加全局可变状态）。
					const agent = await api.agent(context);
					// 人设页取消勾选的工具不允许被加载：内核的 deferred 是「延迟 − 已 offer」，
					// 取消勾选只是不 offer，它仍留在 deferred 里，所以这里要按名单再挡一层。
					const disabled = disabledToolsOfConversation(Number(api.conversationId));
					const available = agent.deferred.filter(
						(tool) => tool.name === name && !disabled.has(tool.name),
					);
					if (available.length === 0) {
						const names = agent.deferred
							.filter((tool) => !disabled.has(tool.name))
							.map((tool) => tool.name);
						return {
							...textToolResult(
								err(
									"tool_not_loaded",
									`工具 ${name || "(空)"} 不在可加载清单里，没有加载任何工具。`,
									names.length
										? `当前可加载：${names.join("、")}`
										: "当前没有可加载的按需工具。",
								),
							),
							isError: true,
						};
					}
					const tool = available[0]!;
					// 工具用量账（2026-11-17）：记一次"被搜出来"——loads ≠ count，
					// 加载了没调用也留痕，这正是"被藏起来但老被要用"的信号。
					recordToolLoad(name);
					const text = [
						tool.name,
						tool.description,
						`参数：${JSON.stringify(tool.parameters)}`,
						"已加载，下一轮起可直接调用。",
					].join("\n");
					return {
						output: [{ type: "text" as const, text }],
						control: { addTools: [name] },
					};
				},
			}),
		);
	}

	return tools;
}
