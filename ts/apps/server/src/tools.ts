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
import { runChancellor } from "../../../../../chancellor/src/index.ts";
import {
	DOMAIN_PATTERN,
	listManagers,
	validateDomain,
} from "../../../../../chancellor/src/manager/registry.ts";
import {
	REPORT_FOUR_LINES,
	WORK_REVIEW_GUIDANCE,
	chancellorWorkRoot,
	emitDelegation,
	normalizeDelegationSteps,
	startDelegation,
	type DelegationMirrorEntry,
	type DelegationReport,
} from "./delegation.ts";
// 证据裁判（2026-11-10 批 14）：验收 fail 时起 read-only 子会话，结论回传 chancellor 返工判定。
import { withDelegationJudge } from "./delegation-judge.ts";
// 裁决纪律（2026-11-10 批 12 §一.2）：与执事轮输入同一份文本，接在 delegate 描述尾部。
import { RULING_DISCIPLINE } from "./agent/turn-gate.ts";
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
import { delegationRunSource, runSourceEnabled } from "./run-source.ts";
import { isRoutineTurn } from "./unattended.ts";
import { pruneSessionMemory } from "./memory-prune.ts";
// 工作履历：派单终态结算落一条 work 记录（2026-11-08 刀二 E2）。
import { recordWorkSettlement } from "./work-record.ts";
// 技能用量账（2026-11-10 批 17 §四）：skill 工具每取一次手册 +1（旁路审计，失败不挡工具）。
import { recordSkillUse } from "./skill-usage.ts";
// 执事间递话（2026-11-08 扫尾批 8d）：通道与工具定义在 partner-relay.ts，
// 送达函数由装配层注入（本文件不持有 harness）。
import { createSendToAgentTool, type PartnerRelayDeps } from "./partner-relay.ts";
// agent 中途播报（2026-11-10 批 13 §三）：工具定义在 progress-report.ts，送达走 delegation 通道。
import { createReportProgressTool } from "./progress-report.ts";
import {
	ProjectError,
	resolveDelegationProject,
	type ProjectRef,
	type ProjectsStore,
} from "./projects.ts";
// 派活路由（2026-11-07 消息即引导与执事直派）：执事在自己领域内不再绕回分管宰相。
import {
	resolveDelegateRouting,
	routingToRequestFields,
} from "./delegate-routing.ts";
// 设备矩阵（2026-11-05 阶段二）：远程分支晚绑定取中继客户端。
// relay-matrix → agent → tools 的环是运行期安全的（agent 绑定只在函数体内解引用）。
import {
	currentRelayClient,
	deviceAutoDispatchEnabled,
	deviceMatrixEnabled,
} from "./relay-config.ts";
import { RelayInvokeError } from "./relay-client.ts";
import { dispatchRemoteDelegation } from "./relay-matrix.ts";
import { ReminderTask } from "./reminder.ts";
import type { SkillStore } from "./skills.ts";
// 课题工具（2026-11-07 长期课题跟进）：存储 / 搜索都从 deps 注入，测试可替换、缺失不注册。
import { TOPICS_ENABLED, type TopicsStore } from "./topics.ts";
import type { SearchModule } from "./search.ts";
// 会话考古（2026-11-09 T4 §4）：检索实现留在 agent/session-search.ts（只依赖 shared），
// 这里只收注入函数，避免 tools.ts 反向 import session.ts 绕成环。
import type { SessionSearchHit } from "./agent/session-search.ts";
// 工具返回统一契约（2026-11-10 批 16 §一）：当前只给 recall_sessions 用，旧工具仍然 text()。
import { encodeToolResult, err, ok, type ToolResult } from "./tool-result.ts";

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
}

export interface PersonaRecallResult {
	ok: boolean;
	question: string;
	qtype?: string;
	groups?: Partial<Record<PersonaRecallGroup, PersonaRecallHit[]>>;
	unknown?: string;
	coverage?: {
		not_searched?: string[];
		not_indexed?: string[];
		gaps?: string[];
		gap_months?: string[];
	};
	error?: string;
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
	/**
	 * 课题存储（2026-11-07 长期课题跟进）。可选注入：为 null / 缺省时
	 * `propose_topic` 与 `web_search` 都不注册（研究回合也拿不到搜索）。
	 */
	topics?: TopicsStore | null;
	/** 搜索适配层（2026-11-07）。测试注入假上游；缺省时不注册课题工具。 */
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
	 * persona-metric 记忆库检索（2026-11-09 persona 接入批一）：传了才注册 `persona_recall`。
	 * 装配层按 `PERSONA_MEMORY_ASK`（配置=启用）与 `PERSONA_MEMORY_ENABLED`（false=显式关）
	 * 双闸决定传不传——不传 = 工具不上架（模型侧 tool_unavailable，一行回滚）。
	 * 实现由 lifecycle 注入，tools 不 import persona-ask.ts（避免单测依赖真实 python 路径）。
	 */
	personaAsk?:
		| ((question: string, options?: { limit?: number }) => Promise<PersonaRecallResult>)
		| null;
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

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

/** 统一契约形态的工具输出（批 16 §一）：一行 JSON，只给新工具用。 */
function textToolResult<T>(result: ToolResult<T>) {
	return { output: [{ type: "text" as const, text: encodeToolResult(result) }] };
}

// ── persona_recall 渲染（2026-11-09 persona 接入批一）──────────────
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
			"适合：对方的偏好、家人朋友宠物、长期目标、重要经历。" +
			// 2026-11-09 T4 §3：前瞻意图单独一类，带有效期；过期自动降级为事实。
			"对方说「我打算 / 我准备 / 下周开始……」这类还没发生的计划时用 kind=intention，" +
			"并尽量给 expiresInDays——到期后它自动变成普通事实，不会一直挂在「打算」里。" +
			"不适合：一次性的琐事、马上就会变的信息。" +
			// 2026-11-08 员工人格化刀一 E3：被教诲必须落成偏好，不能只在当下照做。
			// 偏好层有"永不删"保护（记忆巩固的 protectKinds），教过的话不会被衰减掉。
			"**用户用「以后 / 记住 / 下次」这类话纠正你、或给你立规矩时，必须立刻用本工具记一条 " +
			"kind=preference、taught=true 的记忆**——不要只在这一次照做，也不要只是口头答应；" +
			"记的是那条规矩本身（做什么 / 不做什么），不是这次对话的经过。" +
			// 2026-11-08 员工人格化刀三 E3：教诲分两层，规矩与方法不互斥。
			"若教的是方法 / 步骤（「这类活怎么做」）而非规矩，在具备 partner_skill_write 工具时另写成技能文件沉淀；" +
			"规矩本身仍落 preference。两件事不互斥：规矩进偏好（永不删），方法进技能（按需取用）。",
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
					description:
						"用户教你规矩（「以后… / 记住… / 下次…」）时为 true：这条会标成 taught 来源。普通事实不填。",
				}),
			),
		}),
		execute: async (args, api) => {
			const engine = requireMemory();
			// 群会话不进个人记忆（2026-11-06 群组方案 §2.2）：群里听到的事写进执事私人记忆
			// 就是串台。模型侧明说原因，别让它对着一个会失败的接口反复重试。
			if (partnersStore().isGroupSession(api.conversationId)) {
				return text("群聊里的内容不进个人记忆；需要记住的事请主人在私聊里说。");
			}
			const record = engine.remember({
				kind: args.kind ?? "fact",
				scope: scopeOf(api.conversationId),
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
			return text(`已记住：${record.content}`);
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
			const engine = requireMemory();
			// 群会话不参与记忆引擎（群组方案 §2.2，v1 最简形态）：群聊查记忆也跳过
			if (partnersStore().isGroupSession(api.conversationId)) {
				return text("群聊不走个人记忆；答案以群里的聊天记录为准。");
			}
			const hits = engine.recall({
				text: args.query,
				scopes: ["global", scopeKey(scopeOf(api.conversationId))],
				limit: Math.max(1, Math.min(20, Math.floor(args.limit ?? 5))),
			});
			if (hits.length === 0) return text("没有找到相关记忆。");
			return text(
				hits
					.map((hit) => `- [${hit.record.kind}] ${hit.record.content}（${hit.record.createdAt.slice(0, 10)}）`)
					.join("\n"),
			);
		},
	});

	const remind = defineTool({
		name: "set_reminder",
		description:
			"定一个到点提醒。时间写 ISO 8601（带时区），例如 2026-10-29T08:00:00+08:00。" +
			"提醒会落库，进程重启也不会丢。",
		parameters: Type.Object({
			text: Type.String({ description: "到点要提醒的内容" }),
			at: Type.String({ description: "触发时间，ISO 8601" }),
		}),
		execute: async (args, api, context) => {
			const at = Date.parse(args.at);
			if (Number.isNaN(at)) throw new Error(`时间格式看不懂：${args.at}`);
			if (at <= api.now()) throw new Error(`这个时间已经过去了：${args.at}`);

			await api.commit(
				(tx) =>
					tx.createTask(
						ReminderTask,
						{ text: args.text, at },
						{ ownership: { kind: "conversation" } },
					),
				context,
			);
			return text(`好，${new Date(at).toLocaleString("zh-CN")} 提醒你：${args.text}`);
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
				return text(
					JSON.stringify({ ok: false, error: "needs_project", message: "项目登记表不可用" }),
				);
			}
			try {
				const proposal = deps.projects.proposeProject(args.name, args.path);
				return text(
					JSON.stringify({
						ok: true,
						proposalId: proposal.id,
						name: proposal.name,
						path: proposal.relativePath,
						message:
							"已提交待确认：用户在项目设置里确认后才会创建目录并登记。" +
							"确认之前不要派工到它，也不要自己建这个目录。",
					}),
				);
			} catch (error) {
				const code = error instanceof ProjectError ? error.code : "failed";
				const message = error instanceof Error ? error.message : String(error);
				return text(JSON.stringify({ ok: false, error: code, message }));
			}
		},
	});

	// 派活（2026-11-02）：主 agent 的"手"。它自己不动手，把活交给外面的工人，
	// 只拿回一句话。工具的 description 里"不适合"那半句比"适合"更重要——
	// 写宽了，主 agent 会把一次 read 就能答的事也派出去，每次都起 worker，比不用还贵。
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
			"把一件需要多步动手的活派给外面的工人（领域负责人/执行者）去做。" +
			"适合：要改多个文件、要跑命令、要查证之后再动手的任务；" +
			"**以及在手机上操作 App**——打开某个 App、点按钮、输入文字、翻页、看屏幕上显示了什么。" +
			"不适合：回答问题、闲聊、一次 read 就能答的事、需要边做边问对方的事。" +
			"**派出去后会立即返回任务单号，不会占住这一轮对话；后台跑完会有一条汇报写进会话。**" +
			"所以返回后直接告诉用户「已派发，完成后会汇报」即可，不要等结果、不要反复查询、不要重复派。" +
			"填 `domain` 把活交给对应领域的负责人。**领域名必须是小写 ASCII**（小写字母、数字、连字符，如 `frontend` / `desktop-shell`）；" +
			`当前已有领域：${domainList()}。不填则按旧路径直接派 worker。` +
			"**派新活时必须带 `project`（已登记的项目名或 id）**；手机/设备 worker 这类" +
			"不落本机磁盘的活可省 `project`（设备活豁免）；本机活没有可用项目时会返回 " +
			"`{\"error\":\"needs_project\"}` 并列出已有项目——先问用户要建哪个项目，" +
			"用 `propose_project` 提交、等用户在设置里确认，再派。" +
			"如果上一轮派出去的活卡住了、你问了用户一个问题、用户刚回答了你，用 `resume: true` 接着原单跑：" +
			"`requirement` 里只写用户的那句回答（比如「验证码 1234」），不要重述整个任务，" +
			"**更不要重新派**——重派会让对方从头再做一遍。" +
			"对方在回答你上一轮的问题时，他这句话本身就是要交回去的内容：直接拿它调 resume，" +
			"不要再反问一遍，也不要自己替它把剩下的事做完。" +
			"会话里没有可续的单时会按新活派，并在结果里告诉你。" +
			"**注意（只讲文件路径，不是能力限制）**：工人写文件时用相对路径（如 `summary.md`），" +
			"不要指定工作目录之外的绝对路径；产物最后落在 chancellor 的 runs/<ticket>/ 下，不在你指定的绝对位置。" +
			"工人在手机上干活时，它看到的是手机屏幕、点的是手机上的按钮——**它碰不到你电脑上的文件**；" +
			"反过来，它交回来的是一句话，不是手机里的截图或文件。" +
			// 2026-11-08 员工人格化刀一 E1 消费点 2（任务书四段）：描述层给口径，参数结构不变。
			"**任务书按四段写**：目标 / 怎么算好 / 可自主范围 / 必须请示。" +
			"你若带「岗位契约」，后两段直接按契约的「决策分级」「验收标准」填写；没有契约就按常理写清边界。" +
			// 2026-11-09 保证实现纵深 §2.2：计划附件与任务书四段并列，不替换。
			"**多步活要写 `steps`**：一件事如果有 ≥3 个动作、或者要跨文件改，就用 steps 列出可核对的动作序列" +
			"（≤12 条，每条一句话说清做什么、怎么算做到）；一句话就能说完的小活不写。" +
			"工人回报「需要你」（need_input / need_decision / need_action）时，答得了就答；" +
			"一时答不了，明确告诉它「这一项先跳过，继续其余部分，这项回头再补」，别让整单停在一件小事上。" +
			// 2026-11-10 批 12 §一.3：四行回报口径随派活一起交待下去，别让工人交流水账。
			"**派活前告诉工人按四行回报**（回报开头写「给<你的名字>：」，不要把任务原样发回给派活的人）：\n" +
			REPORT_FOUR_LINES +
			// 2026-11-10 批 12 §一.2：四停之外自己裁决、记一行账，别反复请示。
			"\n\n" +
			RULING_DISCIPLINE,
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
			domain: Type.Optional(
				Type.String({
					description:
						"领域负责人的领域名，**必须是小写 ASCII**（小写字母、数字、连字符，如 `frontend` / `desktop-shell`）。" +
						`当前已有领域：${domainList()}。` +
						"填了就把活交给该领域负责人；不填则直接派 worker（兼容旧行为）。",
				}),
			),
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
					description:
						"接着上一张单跑（上次派出去的活卡住了、你问了用户、用户刚回答时用）。不填 = 新派一件。",
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
						"多步活（≥3 个动作或跨文件）必写；一句话的小活不写。",
				}),
			),
		}),
		execute: async (args, api, context) => {
			// 派活的进度和「需要你」要能实时到客户端，否则那几分钟界面是死的。
			// 这里把 chancellor 的事件翻译成两种：正在办第几件、需要你回答什么。
			const conversationId = Number(api.conversationId);
			// 计划附件（2026-11-09 §2.1）：先校验，超限不建单、不发送任何副作用。
			const stepsCheck = normalizeDelegationSteps(args.steps);
			if (!stepsCheck.ok) {
				return text(
					JSON.stringify({ ok: false, error: "invalid_steps", message: stepsCheck.message }),
				);
			}
			const steps = stepsCheck.steps;
			const requestedDomain = (args.domain ?? "").trim();
			// 派活路由（2026-11-07）：执事在自己领域内直派，不再绕回分管宰相；
			// 跨领域明确拒绝，不静默改道。总管 / 主人会话维持原语义。
			const routing = resolveDelegateRouting(
				{
					partnerId: effectivePartnerIdOfSession(partnersStore(), conversationId),
					domain: callerDomainOf(conversationId),
				},
				requestedDomain,
			);
			if (routing.kind === "rejected") return text(routing.reason);
			const requestFields = routingToRequestFields(routing);
			const domain = requestFields.domain;
			// 远程分支（2026-11-05 阶段二）：点名另一台电脑执行。
			// 本机的项目前置不参与（project 语义归目标机）；离线直接失败不排队。
			const targetDevice = (args.targetDevice ?? "").trim();
			// 自动挑机落回本机时，给最终的派活回话加一行前缀（方案 §2.4：挑不出必须可见）
			let fallbackNotice = "";
			if (targetDevice) {
				// "auto" 是第三态：开关关着就按非法参数拒绝，不让它悄悄降级成本机
				if (targetDevice === "auto" && !deviceAutoDispatchEnabled()) {
					return text(
						JSON.stringify({
							ok: false,
							error: "auto_disabled",
							message: "自动挑机未开启（DEVICE_AUTO_DISPATCH）",
						}),
					);
				}
				const client = currentRelayClient();
				if (!deviceMatrixEnabled() || !client) {
					return text("设备矩阵未开启（DEVICE_MATRIX_ENABLED=off 或中继未连接），targetDevice 不可用。");
				}
				if (args.resume === true) {
					return text("远端单的续跑（resume）暂不支持：请直接重派一张新单到该设备。");
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
						return text(
							`已交由设备「${result.deviceName}」${tags.length > 0 ? `（${tags.join("，")}）` : ""}执行（远端请求 ${result.requestId.slice(0, 8)}）。` +
								"它在后台跑，完成后我会把汇报写进本会话。不要重复派、不要轮询。",
						);
					}
				} catch (error) {
					const code = error instanceof RelayInvokeError ? error.code : "internal";
					const message = error instanceof Error ? error.message.slice(0, 200) : "派发失败";
					return text(JSON.stringify({ ok: false, error: code, message }));
				}
			}
			// 非法领域名（尤其是中文）直接回可用清单，不建单、不让模型猜。
			if (domain) {
				try {
					validateDomain(domain, chancellorWorkRoot());
				} catch (error) {
					return text(error instanceof Error ? error.message : String(error));
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
					if (!gate.ok) return text(gate.text);
					project = gate.project;
				} else if (resumeTicketId === undefined) {
					const gate = resolveDelegationProject(undefined, deps.projects ?? null);
					if (!gate.ok) return text(gate.text);
					project = gate.project;
				} else {
					// 老会话重启后可能记不住项目；续跑本身不需要新项目。
					project = lastProjectByConversation.get(conversationId);
				}
			}

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
			if (receipts && requestId) {
				const begun = receipts.begin(requestId, fingerprint, {
					explicit: Boolean(explicitRequestId),
					workRoot: chancellorWorkRoot(),
					// 触发来源（批 15 §三）：例行轮 / 设备 / 人；开关关着不写。
					...(runSourceEnabled()
						? {
								runSource: delegationRunSource({
									device: deviceWork,
									routineTurn: isRoutineTurn(conversationId),
								}),
							}
						: {}),
				});
				if (begun.kind === "conflict") {
					// 同一 requestId 但内容不同：不报冲突、不让模型换号重派，直接把原单交回。
					const existing = begun.receipt?.ticketId ?? "";
					if (existing) lastTicketByConversation.set(conversationId, existing);
					return text(
						`该请求号已受理过，返回原单${existing ? ` ${existing}` : "（原单还在受理中）"}，没有重复派。` +
							"后台跑完会汇报。",
					);
				}
				if (begun.kind === "uncertain") {
					return text(
						JSON.stringify({
							ok: false,
							error: "uncertain",
							ticketId: begun.receipt?.ticketId ?? "",
							message:
								"这张单在受理时中断过，结果未知。先确认它是否已经在跑，不要盲目重派。",
						}),
					);
				}
				if (begun.kind === "existing") {
					const existing = begun.receipt?.ticketId ?? "";
					if (existing) lastTicketByConversation.set(conversationId, existing);
					return text(
						`这次派活已经受理过，沿用原任务单 ${existing || "(受理中)"}，没有重复派。` +
							"后台跑完会汇报。",
					);
				}
			}

			// 立即受理：同步拿到任务单号，后台跑完再发事件/回灌。
			const { ticketId, outcome, fellBack } = startDelegation(
				{
					conversationId,
					domain,
					requirement: args.requirement,
					resumeTicketId,
					project,
					...(steps ? { steps } : {}),
					...(requestId ? { requestId } : {}),
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
							withDelegationJudge({
								...options,
								// 后台执行不能挂本轮对话的 abortSignal：用户这一轮结束不该杀掉任务。
								...(asyncMode ? {} : { signal: context.abortSignal }),
							}),
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
					if (noTicket) return text(`${fallbackNotice}${line}\n（没有可续的单，已按新活派）`);
					if (resumeTicketId) {
						return text(`${fallbackNotice}${line}\n（已把用户的回答交回原单，它在接着做。）`);
					}
					return text(fallbackNotice + line);
				} catch {
					return text(`${fallbackNotice}派单失败，请稍后再试。`);
				}
			}

			if (noTicket) {
				return text(
					`${fallbackNotice}已按新活派：任务单 ${ticketId || "(受理中)"}` +
						`${domain ? `（领域：${domain}）` : ""}。它在后台执行，完成后我会汇报。`,
				);
			}
			if (resumeTicketId) {
				return text(
					`${fallbackNotice}已把回答交回原单 ${ticketId}，它继续在后台跑，完成后我会汇报。`,
				);
			}
			return text(
				`${fallbackNotice}已受理：任务单 ${ticketId || "(受理中)"}${domain ? `（领域：${domain}）` : ""}。` +
					"它在后台执行，完成后我会汇报；不要等，也不要重复派。",
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

	// persona-metric 记忆库检索（2026-11-09 persona 接入批一）：条件注册，不进基线。
	// 回滚：lifecycle 不传 deps.personaAsk（PERSONA_MEMORY_ASK 未配置 / ENABLED=false）
	// → 这里整块不执行。它起 python 子进程，按硬约束字面进了 WRITE_TOOLS（不进高危清单）。
	if (deps.personaAsk) {
		const personaAsk = deps.personaAsk;
		tools.push(
			defineTool({
				name: "persona_recall",
				description:
					"在**主人的个人记忆库**（跨越很多年的原始记录与分析）里检索证据条目，每条带出处 id。" +
					"适用：本地记忆想不起来 / 查很久以前（如去年、2024 年）的事 / 主人要求给原文出处。" +
					"**查不到 ≠ 没有这回事**：返回里有『不确定』说明时照转述，不要编。" +
					"与 recall 分工：recall 查最近与偏好，persona_recall 查一生；先 recall 再 persona_recall。",
				parameters: Type.Object({
					query: Type.String({ description: "要查什么，用关键词或一句话" }),
					limit: Type.Optional(
						Type.Number({ description: "每组最多返回几条，默认 5", minimum: 1, maximum: 20 }),
					),
				}),
				execute: async (args, api) => {
					// 与 recall 同款：群聊不走个人记忆。
					if (partnersStore().isGroupSession(api.conversationId)) {
						return text("群聊不走个人记忆；答案以群里的聊天记录为准。");
					}
					const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 5)));
					let result: PersonaRecallResult;
					try {
						result = await personaAsk(args.query, { limit });
					} catch {
						// 注入实现理论上不抛，这里兜一层：检索失败绝不打断裂对话轮。
						result = { ok: false, question: args.query };
					}
					const hits = result.groups
						? Object.values(result.groups).reduce((sum, group) => sum + (group?.length ?? 0), 0)
						: 0;
					// 只记字数 / 状态 / 条数，不记 query 原文与正文（日志纪律）。
					console.log(`[persona_recall] q=${args.query.length}字 ok=${result.ok} hits=${hits}`);
					if (!result.ok) {
						return text(
							"个人记忆库暂时查不了（原因已记日志），你可以说说想确认什么，我换个方式找。",
						);
					}
					return text(renderPersonaAsk(result));
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
				execute: async (args) => {
					const manual = skills.manual(args.name);
					if (!manual) {
						return text(
							`没有叫「${args.name}」的技能。可用：${skills.names().join("、") || "（无）"}`,
						);
					}
					// 取到才计数（2026-11-10 批 17 §四）：拿不到手册不算使用。
					recordSkillUse(args.name);
					return text(manual);
				},
			}),
		);
	}

	// 执事间递话（2026-11-08 扫尾批 8d）：装配层显式传 deps.relay 才上架。
	// 不做 deps 缺省回落——"主人对话不挂 / 回滚开关"必须由装配层一处决定（lifecycle）。
	if (deps.relay) tools.push(createSendToAgentTool(deps.relay));

	if (deps.delegate !== false) tools.push(delegate, proposeProject);

	// 结构化提问（2026-11-09 保证实现纵深 §3）：默认上架，AGENT_ASK_USER=false 一行回滚。
	// 它不写盘、不起进程，因此不在 WRITE_TOOLS / 高危清单里。
	if (askUserEnabled()) tools.push(createAskUserTool());

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
						return text("这个会话不属于任何执事，不能写执事技能。");
					}
					if (!/^[a-z0-9][a-z0-9-_]{0,63}$/.test(args.slug)) {
						return text("slug 只能是小写字母/数字/短横线，1-64 字符。");
					}
					if (!args.content.trim() || !args.content.trim().split("\n")[0]?.trim()) {
						return text("技能手册第一行是索引摘要，不能为空。");
					}
					try {
						partnersStore().atomicWrite(
							join(partnersStore().skillsDirOf(partnerId), `${args.slug}.md`),
							args.content,
						);
						return text(`技能 ${args.slug} 已写入执事技能库，下一轮进索引。`);
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						return text(`写入失败：${detail}`);
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
					"总管管理执事（chancellor 分管宰相）：create 建一个、stop 停一个、list 列出全部、set_dispatch 切某个执事的派发权（是否作为分管负责人接单，默认关）。" +
					"只有总管 / 主对话能用；执事自己的执事会话不能管理执事。" +
					"create 的 domain 是之后派活用的领域名，必须是小写 ASCII（小写字母、数字、连字符，如 frontend / desktop-shell），" +
					"name 是展示名（中文随意）。建好后用 delegate(domain=<domain>) 把活派给它。",
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
						return text("只有总管可以管理执事");
					}
					if (args.action === "create") {
						const name = (args.name ?? "").trim();
						const domain = (args.domain ?? "").trim();
						if (!name) return text("name 必填且不超过 40 字");
						if (args.soul && args.soul.length > 4000) {
							return text("soul 太长，一句话身份即可");
						}
						const result = createMinisterPartner(
							{ name, ...(domain ? { domain } : {}), soul: args.soul },
							ctx,
						);
						if (!result.ok) return text(result.error);
						// 领域只是标签（2026-11-07）：留空也要说清"照样能派活"，
						// 否则模型会以为建了个残缺的执事。
						return text(
							result.value.domain
								? `执事 ${result.value.name} 已就位（领域标签：${result.value.domain}）。之后 delegate(domain=${result.value.domain}) 或直接按名字派都行。`
								: `执事 ${result.value.name} 已就位（没有领域标签，不影响派活）。之后用 delegate 派给它就行。`,
						);
					}
					if (args.action === "stop") {
						const partnerId = (args.partnerId ?? "").trim();
						if (!partnerId) return text("stop 需要 partnerId（执事 id）");
						if (partnerId === CHIEF_PARTNER_ID) {
							return text("不能停总管自己：总管是主对话本体，不在可停用的执事里。");
						}
						const partner = ctx.store.get(partnerId);
						if (!partner || !partner.domain) {
							return text(`找不到 id 为 ${partnerId} 的执事（只能停带 domain 的执事）。`);
						}
						const result = stopMinisterPartner(partnerId, ctx);
						if (!result.ok) return text("执事不存在或已被停用。");
						return text(
							`执事 ${partner.name}（domain=${partner.domain}）已停用并归档，之后派活不要再指向它。`,
						);
					}
					if (args.action === "list") {
						const rows = listMinisterPartners(ctx, (args.partnerId ?? "").trim() || undefined);
						if (rows.length === 0) return text("（暂无执事；用 create 建一个）");
						return text(
							rows.map(
								(row) =>
									`${row.name} · ${row.domain} · ${row.status} · 派发权${row.dispatchAuthority ? "开" : "关"}`,
							).join("\n"),
						);
					}
					if (args.action === "set_dispatch") {
						const dispatchId = (args.partnerId ?? "").trim();
						if (!dispatchId) return text("set_dispatch 需要 partnerId（执事 id）");
						if (typeof args.enabled !== "boolean") {
							return text("set_dispatch 需要 enabled（true=开 / false=关）");
						}
						const result = setMinisterDispatchAuthority(dispatchId, args.enabled, ctx);
						if (!result.ok) return text(result.error);
						return text(
							`执事 ${result.value.name}（domain=${result.value.domain}）的派发权已${args.enabled ? "打开：之后 delegate(domain=…) 会以它的名义派分管" : "关闭：之后 delegate(domain=…) 不再经过它，等同无分管领域"}。`,
						);
					}
					return text("action 只能是 create / stop / list / set_dispatch");
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
					"总管管理群组（执事群聊）：create 建一个群、list 列出全部群。" +
					"只有总管 / 主对话能用；执事自己的会话不能建群。" +
					"成员用**名字**指定（2–6 位），必须是已有执事；值日执事不 @ 时回话，" +
					"缺省取第一位成员。建好后说话不 @ 就发给值日，@名字 就点名。",
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
						return text("只有总管可以建群");
					}
					if (args.action === "list") {
						const rows = ctx.store.listGroups();
						if (rows.length === 0) return text("（暂无群组；用 create 建一个）");
						return text(
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
						if (!name) return text("create 需要 name（群名，≤40 字）");
						if (name.length > 40) return text("群名不超过 40 字");
						const memberNames = (args.members ?? []).map((value) => String(value));
						const resolved = resolvePartnersByName(memberNames, ctx.store);
						if (!resolved.ok) return text(resolved.error);
						const duty = resolvePartnerByName(args.responder, ctx.store);
						if (!duty.ok) return text(duty.error);
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
						if (!created.ok) return text(created.error);
						const who = created.value.members.map((member) => member.name).join("、");
						const dutyName =
							created.value.members.find(
								(member) => member.partnerId === created.value.responderPartnerId,
							)?.name ?? "第一位成员";
						return text(
							`群组 ${created.value.name} 已建好：${who}；不 @ 时 ${dutyName} 回。` +
								"在群组页打开它就能说话（@名字 点名，@所有人 全员按顺序回）。",
						);
					}
					return text("action 只能是 create / list");
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
					"create 需要 name（≤40 字）、prompt（这一轮要做什么）、triggers（cron 五段 / interval≥60s / once ISO / event）、sessionMode（persistent 复用会话 / fresh 每轮全新），" +
					"可选 untilNote（完成条件，一句话；每轮跑完由你判断达成没有，达成即自动停用、保留历史）与 maxRuns（跑满 N 次自动停）。" +
					"其余动作带 id。例：主人说「你每周五自己盘点」，就用 create 建一条 cron「0 18 * * 5」的周盘点规则。\n" +
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
						return text("这个会话不属于任何执事，不能自建巡逻（只有执事能给自己建规则）。");
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
						return text(`操作失败：${detail.slice(0, 200)}`);
					}
					// 自建标记：这条规则的首轮 runSource 记 routine_self（批 15 §三）。
					if (result.ok && args.action === "create" && result.routineId) {
						deps.markSelfRoutine?.(result.routineId);
					}
					// create / enable 要排 durable 闹钟；排不上只 warn + 在回话里如实说，
					// 规则已经落库（revision / 防自环由 routines.ts 既有机制照常生效）。
					if (result.ok && result.schedule && result.routineId && scheduleRoutine) {
						try {
							await scheduleRoutine(result.routineId);
						} catch (error) {
							const detail = error instanceof Error ? error.message : String(error);
							console.warn(`[routine_manage] 排定时链失败（规则已建）: ${detail.slice(0, 200)}`);
							return text(`${result.message}（定时链没排上，需主人检查会话：${detail.slice(0, 80)}）`);
						}
					}
					return text(result.message);
				},
			}),
		);
	}

	// 课题（2026-11-07 长期课题跟进 §五）：`web_search` + `propose_topic`。
	// TOPICS_ENABLED=false 或依赖缺失 → 两个都不注册（一行回滚）。
	// web_search 是纯网络读，**不进 WRITE_TOOLS**（approval-policy.ts 不动）。
	const topicsDeps = TOPICS_ENABLED ? deps.topics ?? null : null;
	const searchDeps = TOPICS_ENABLED ? deps.search ?? null : null;
	if (topicsDeps && searchDeps) {
		const topics = topicsDeps;
		const search = searchDeps;
		tools.push(
			defineTool({
				name: "web_search",
				description:
					"查公开网络资料拿事实（新闻、行情、论文、文档、政策），适合课题研究与需要实时性的问题。" +
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
						return text(
							JSON.stringify({
								ok: false,
								error: result.error,
								message: result.message,
							}),
						);
					}
					if (result.hits.length === 0) return text("没有找到相关结果。");
					return text(
						result.hits
							.map((hit) => `${hit.title || "（无标题）"} — ${hit.url}\n${hit.summary}`)
							.join("\n\n"),
					);
				},
			}),
			defineTool({
				name: "propose_topic",
				description:
					"提议长期跟进一个课题。判据（从严，四条都满足才提）：开放性问题；今天给不了定论；" +
					"值得隔几天回头看；用户显出兴趣。**只提交待确认的提议，不创建课题**——" +
					"用户确认后才会建课题并开始按节奏研究。同一话题别重复提；用户直说「长期跟进 / 每周研究一下」时也用它。",
				parameters: Type.Object({
					question: Type.String({ description: "一句话问题，不超过 200 字" }),
					flavor: Type.Unsafe<"watch" | "dig">({
						type: "string",
						enum: ["watch", "dig"],
						description:
							"watch=盯梢型（盯政策/价格/论文/动态，重点看和上次比变了什么）；" +
							"dig=啃题型（搞懂一个大问题，每次往下啃一小块）",
					}),
					cron: Type.Optional(
						Type.String({
							description: "研究节奏，5 段 cron（分 时 日 月 周），默认「0 9 * * 1」= 每周一 09:00",
						}),
					),
					origin: Type.Optional(
						Type.Unsafe<"user" | "proposal">({
							type: "string",
							enum: ["user", "proposal"],
							description:
								"user=用户明确要求长期跟进；proposal=你自己嗅探到的（默认 proposal）",
						}),
					),
				}),
				execute: async (args, api) => {
					// 群会话不进课题（与 remember 同口径）：群里提的题不属于任何一个人的长期目标。
					if (partnersStore().isGroupSession(api.conversationId)) {
						return text("群聊里不提课题；要长期跟进的事请主人在私聊里说。");
					}
					const question = args.question.trim();
					if (!question) return text("question 不能为空");
					if (question.length > 200) return text("question 不超过 200 字");
					const result = topics.proposeTopic({
						question,
						flavor: args.flavor,
						...(args.cron ? { cron: args.cron } : {}),
						origin: args.origin === "user" ? "user" : "proposal",
					});
					if (!result.ok) {
						return text(
							JSON.stringify({
								ok: false,
								error: result.reason,
								...(result.existingTopicId ? { existingTopicId: result.existingTopicId } : {}),
								message: result.message,
							}),
						);
					}
					return text(
						JSON.stringify({
							ok: true,
							proposalId: result.proposal.id,
							question: result.proposal.question,
							flavor: result.proposal.flavor,
							cron: result.proposal.cron,
							message:
								"已提交待确认：用户确认后才会建课题并开始按节奏研究；" +
								"确认之前不要把它当成已经在跟的课题。",
						}),
					);
				},
			}),
		);
	}

	return tools;
}
