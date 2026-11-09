import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	ToolTask,
	type Conversation,
	type Extension,
	type HookApi,
	LiveDoc,
	type ToolHookCall,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ThinkingLevel } from "@lifediary/shared";
import { approvalStore, type ApprovalOutcome } from "../approvals.ts";
import {
	ASK_USER_TOOL_NAME,
	ASK_USER_WAITING_MESSAGE,
	askUserEnabled,
	createAskUserPending,
} from "../ask-user.ts";
import {
	approvalTimeoutSeconds,
	denialReason,
	needsApproval,
	type ApprovalVerdict,
} from "../approval-policy.ts";
import { isAutonomyTurn } from "../autonomy-state.ts";
import { autonomyEscalationBlockReason, autonomyRiskVerdict } from "../autonomy-risk.ts";
import { emitDelegation, type DelegationReport } from "../delegation.ts";
import { auditGateBlock, type GateBlockCategory } from "../gate-audit.ts";
// 任务专线双写（2026-11-08 扫尾批 8g）：只有真正的装配层注入 mirror；
// createTools 的探针/单测调用不传，避免去开真实 durable。
import { taskConversationMirror } from "../task-conversation.ts";
import { loopGuardEnabled, loopGuardFor, resetLoopGuard } from "../loop-guard.ts";
import {
	CHIEF_PARTNER_ID,
	COMPANIONS_ENABLED,
	partnersStore,
	resolvePersona,
} from "../partners.ts";
import { pathGuardBlockReason } from "../path-guard.ts";
// 只读白名单（2026-11-09 任务书 T3 §2）：只能把 ask 变 allow，碰不到 block。
import { isReadOnlyShellCommand, readAllowlistEnabled } from "../read-allowlist.ts";
// bash 超时转后台（2026-11-09 任务书 T3 §3）：识别内核超时文案 + 起 detached 子进程。
import {
	bashBackgroundEnabled,
	moveToBackground,
	replacedResult,
	timeoutSecondsFromResult,
} from "../bash-background.ts";
// 恢复注记（2026-11-09 任务书 T3 §5）：续跑的下一轮模型请求前注入一次「先查再动」。
import { markRecoverResume, takeRecoverNote } from "./recover-note.ts";
// 执事间递话（2026-11-08 扫尾批 8d）：状态与话术在 partner-relay.ts，
// 送达（submit 进目标会话）在这里——本文件才持有 harness。
import {
	RELAY_AUTONOMY_BLOCK_MESSAGE,
	RELAY_CALLER_BLOCK_MESSAGE,
	RELAY_CHIEF_BLOCK_MESSAGE,
	RELAY_GROUP_BLOCK_MESSAGE,
	RELAY_HOP_BLOCK_MESSAGE,
	RELAY_TOOL_NAME,
	beginRelayRun,
	claimRelayTarget,
	clearRelayTarget,
	currentRelayRunKey,
	isRelayRun,
	markRelayRun,
	markRelayTarget,
	partnerRelayEnabled,
	type RelayDeliverResult,
} from "../partner-relay.ts";
import { currentProjectEnabled, projectsStore, workspaceRootReal } from "../projects.ts";
import {
	chatModelRef,
	clampThinkingLevel,
	currentModels,
	currentThinkingLevels,
	readLlmConfig,
} from "../provider.ts";
import { buildHarnessSettings, reliabilitySummary } from "../reliability.ts";
import { ReminderTask } from "../reminder.ts";
import { RoutineTask, routineEngine, routineSelfServiceEnabled } from "../routines.ts";
import { searchModule } from "../search.ts";
import { createTools } from "../tools.ts";
import { TOPICS_ENABLED, topicsStore } from "../topics.ts";
import { TopicTask } from "../topic-runtime.ts";
import { skillSlashOf } from "../skills.ts";
// 会话考古（2026-11-09 T4 §4）：检索实现只依赖 shared，不会与本文件成环。
import { recallSessionsEnabled, searchSessions } from "./session-search.ts";
// persona-metric 记忆库检索（2026-11-09 persona 接入批一）：双闸都过才上架工具。
import { askPersona, askPersonaAvailable, personaAskEnabled } from "../persona-ask.ts";
import {
	CHANCELLOR_ENABLED,
	PERSONA,
	WORKER_PERSONA,
	memoryEngine,
	recallContext,
	scopeOf,
	skillStore,
} from "./assist.ts";
import { approvalArgsHash } from "./approval-key.ts";
import { INJECTION_GUARD, injectionGuardEnabled, wrapUntrustedObjective } from "./injection-guard.ts";
import { buildPartnerTurnContext } from "./partner-context.ts";
// 执事轮装配的履历摘要读口（2026-11-08 刀二 E2）：结构化查询 work 记录，不走语义召回。
import { workSummaryFor } from "../work-record.ts";
import { BASH_TIMEOUT_S, approvalMode, policy, readOnlyBlockReason } from "./policy.ts";
import {
	CTX,
	DB_PATH,
	ChatKinds,
	ResolvedChat,
	currentProject,
	emitPhase,
	emitTool,
	sessionCwd,
	toolArgs,
	toolLabel,
	toolOutput,
} from "./shared.ts";
import {
	APPROVAL_WAITING_MESSAGE,
	HARD_STOP_GRACE,
	LOOP_GUARD_BLOCK_MESSAGE,
	MAX_TURNS,
	TURN_LIMIT_INSTRUCTION,
	aborting,
	limitHits,
	runTurns,
	toolsBlocked,
	waitForApproval,
} from "./turn-gate.ts";

/**
 * Agent 装配。
 *
 * 这里是整个服务端的重心，换到 durable 之后职责很清晰：
 *
 *   Harness           一个进程一个，持有一份 SQLite 存储
 *   Conversation      一次聊天，历史/压缩/中断恢复都归它
 *   Extension         工具 + 提示词 + 钩子 + 自定义任务的打包单位
 *   watch()           唯一的数据出口 —— SSE 只是把它转成文本增量
 *
 * 我们**不自己维护 transcript、不自己拼消息、不自己做压缩**。
 * 上一版这些全是手写的，还抄了 pi coding-agent 的阈值判断；
 * 现在这些都在 durable 里，而且带 overflow 兜底和崩溃恢复。
 *
 * 跟 pi 的默认行为不一样的两处，都在这里显式写明：
 *   - 工具闸门（beforeTool）：pi 没有权限系统，我们自己挂
 *   - 记忆注入（beforeRequest）+ 记住/回忆/提醒三个工具
 */

async function abortRun(conversationId: number): Promise<void> {
	try {
		const harness = await getHarness();
		const conversation = await harness.conversation(conversationId as never, CTX);
		await conversation?.abort(CTX);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[agent] 硬停会话 ${conversationId} 失败: ${detail}`);
	}
}

// ── 装配 ─────────────────────────────────────────────────
let opening: Promise<Harness> | null = null;

/**
 * 当前可用的 Harness（成功打开后才有）。`opening` 是 Promise，成功与失败长得一样，
 * 所以"这份是不是已经废了"只能拿对象本身来判断，另存一个引用。
 */
let opened: Harness | null = null;

/** 正在关闭的旧 Harness（收尸中）。新实例要等它把 SQLite 句柄交出来再开。 */
let closing: Promise<void> | null = null;

/**
 * 我们自己的扩展（人格 + 技能索引 + 工具 + 钩子）。
 *
 * 提到模块作用域是为了**任务会话能把它摘掉**：日记任务（收敛/周报/分段…）不需要人格、
 * 不需要技能、不需要记忆注入、也不该有工具（它只产出文本），见 `configureTaskChat`。
 */
export let lifediaryExt: Extension | null = null;
/**
 * 课题研究专线的最小扩展（2026-11-07 长期课题跟进）：只装 `web_search`。
 * 研究回合会摘掉 `lifediaryExt`（不要人格 / 技能 / 记忆），但搜索必须还在——
 * 两件事拆成两个扩展，才能"摘掉主扩展的同时保留搜索"。
 */
export let researchExt: Extension | null = null;

/**
 * 丢掉当前 Harness，下一个 `getHarness()` 重新打开（2026-11-07）。
 *
 * **为什么必须能自愈**：pi-durable 的 Session 把"存储错误"当终局——第一次 Storage 抛错就
 * 整份 Session 进 failed 态，之后**每一次** commit / 读快照都立刻 reject，错误是
 * `SessionFailed: Session failed after a storage error; close and reopen it`
 * （见 pi-durable `session.d.ts` 类注释）。而我们是常驻进程、库是本地 SQLite 文件，
 * 一次瞬时 IO 失败（WAL 被抢、磁盘抖动、杀毒扫描锁文件）不该要求用户手按重启。
 * 内核文档自己写着 "Reopening recovers from what was committed"，照做即可。
 *
 * **为什么要真正 close**：只把 `opening` 置空的话，旧 Session 仍握着 SQLite 句柄和内存里的
 * 任务图，新开一份会和它抢同一个库（WAL 下互相阻塞），句柄还会越积越多。
 * failed 态下 `close()` 自己也可能 reject——吞掉，我们只是来收尸的。
 *
 * **并发**：多个请求可能同时撞到同一个失败。用对象判等 `opened !== dead` 让只有第一个真去关，
 * 其余直接返回（它们随后取到的已经是新实例）。
 */
function discardHarness(dead: Harness, reason: string): void {
	if (opened !== dead) return; // 别人已经换过了
	opened = null;
	opening = null;
	console.warn(`[agent] Harness 失效（${reason}），已弃用，下次取用时重新打开`);
	// 记下"正在关"，`getHarness()` 会等它把库交出来再开新实例——
	// 否则新旧两份会同时挂在一个 SQLite 文件上（WAL 下互相阻塞，还可能读到半截状态）。
	closing = dead
		.close(BACKGROUND_CONTEXT)
		.catch((error: unknown) => {
			console.warn(
				`[agent] 关闭失效 Harness 时报错（忽略）: ${error instanceof Error ? error.message : error}`,
			);
		})
		.finally(() => {
			closing = null;
		});
}

export function getHarness(): Promise<Harness> {
	if (opening) return opening;
	// 上一次的收尸还没结束：等它。`closing` 兑现后库里没有旧句柄了，新实例才安全。
	if (!closing) {
		opening = openHarness().then(
			(harness) => {
				opened = harness;
				// 失败是"静默"的：不挂这个监听，就只能等某个请求撞上 SessionFailed 才知道。
				// 挂上之后，库里一出事就地丢掉，下一个请求自然重开——不用等用户刷新页面。
				// 只在开出来这一处挂一次（`closed` 只兑现一次），不要放进每次调用里。
				void harness.closed.then(() => discardHarness(harness, "Session 已关闭或存储失败"));
				return harness;
			},
			(error: unknown) => {
				// 首次打开就失败：不能把这份 reject 永久缓存。
				// 否则一次瞬时失败（库被锁 / .data 还没就绪）会让之后每个请求都拿到同一个
				// 已 reject 的 Promise，全站 500 且不再重试，只有重启能救。
				opening = null;
				throw error;
			},
		);
		return opening;
	}
	return closing.then(() => getHarness());
}

/**
 * 执事间递话的送达（2026-11-08 扫尾批 8d）。
 *
 * 送达 = 向目标执事**主会话**提交一条 user 输入（durable 语义，零新增存储）：
 * 目标忙 → followUp 排队到下一个边界；空闲 → 直接起一轮。没有信箱表，
 * 消息本体就是对方 transcript 里的那句话（方案 §一.2）。
 *
 * 目标会话 id 来自 `partner_session_links`（`sessionIdOfPartner`，只读）。
 * **没建过会话就明确报错、不代建**：建会话要跑身份对齐（partner-runtime 的
 * ensurePartnerSession，import agent），那是装配层；而且"从没打开过的执事"
 * 递过去也没人看。模型收到的是可执行的引导（先点开一次），不是静默失败。
 */
async function deliverPartnerRelay(
	targetPartnerId: string,
	body: string,
): Promise<RelayDeliverResult> {
	const target = partnersStore().get(targetPartnerId);
	if (!target) return { ok: false, error: "这位执事已经不在了" };
	const sessionId = partnersStore().sessionIdOfPartner(targetPartnerId);
	if (sessionId === null) {
		return {
			ok: false,
			error: `「${target.name}」还没有自己的会话——先在侧栏点开它一次，再递话`,
		};
	}
	try {
		const harness = await getHarness();
		const live = await harness.snapshot(LiveDoc, sessionId as never, CTX);
		const busy = Boolean(live?.run);
		const conversation = await harness.conversation(sessionId as never, CTX);
		if (!conversation) return { ok: false, error: "对方会话已经不在了（可能被删）" };
		// **先标记再提交**：目标那一轮的第一个 beforeRequest 要认领它，
		// 否则"递话触发的轮次摘掉工具"会漏（提交后才标记已经晚了一步）。
		markRelayTarget(sessionId);
		try {
			await conversation.submit(
				{ type: "input", content: body, whenBusy: "followUp" },
				CTX,
			);
		} catch (error) {
			clearRelayTarget(sessionId);
			throw error;
		}
		return { ok: true, busy };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `提交失败：${detail.slice(0, 200)}` };
	}
}

/**
 * `send_to_agent` 的通道闸（2026-11-08 扫尾批 8d，方案 §一.4/§一.5/§一.7）。
 *
 * 这是**结构保证**，不是提示词保证：符合条件的轮次里工具被 beforeTool 直接摘掉，
 * 模型再怎么想递也递不出去。四条按顺序：
 *   1. 例行/自主轮 → 不可用（没有主人语境，批次C D14 口径）；
 *   2. 群会话 → 不可用（方案 §二：不做群内定向私聊）；
 *   3. 不是执事主会话（主人对话 / 总管）→ 不可用（主人直接说要谁干嘛就行）；
 *   4. 本 run 是递话触发的 → 不可用（hop 恒为 1，断乒乓）。
 *
 * 第 4 条靠进程内 run 标记（beforeRequest 认领），不读库、不受存储抖动影响。
 */
function relayToolBlockReason(conversationId: number): string | undefined {
	if (!COMPANIONS_ENABLED) return RELAY_CALLER_BLOCK_MESSAGE;
	if (isAutonomyTurn(conversationId)) return RELAY_AUTONOMY_BLOCK_MESSAGE;
	let store: ReturnType<typeof partnersStore>;
	try {
		store = partnersStore();
	} catch {
		return "执事档案读不到，暂时不能递话。";
	}
	if (store.isGroupSession(conversationId)) return RELAY_GROUP_BLOCK_MESSAGE;
	const partnerId = store.partnerIdOfSession(conversationId);
	if (!partnerId) return RELAY_CALLER_BLOCK_MESSAGE;
	if (partnerId === CHIEF_PARTNER_ID) return RELAY_CHIEF_BLOCK_MESSAGE;
	const runKey = currentRelayRunKey(conversationId);
	// run 键由 beforeRequest 写；缺失说明这一轮没走过正常装配（理论上不可能），
	// fail-closed：宁可拒一次递话，也不让"防乒乓"在未知形态下失守。
	if (!runKey) return "这一轮的状态读不出来，暂时不能递话。";
	if (isRelayRun(conversationId, runKey)) return RELAY_HOP_BLOCK_MESSAGE;
	return undefined;
}

async function openHarness(): Promise<Harness> {
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置：设 LLM_API_KEY 之后再启动");

	mkdirSync(dirname(DB_PATH), { recursive: true });
	const storage = await openNodeSqliteStorage(DB_PATH);

	const registry = createRegistry();
	// pi 自带的那套读写改跑命令：走执行环境，比我们自己写的完整
	registry.install(CodingTools);
	const lifediaryTools = createTools({
		memory: memoryEngine,
		scopeOf,
		skills: skillStore,
		delegate: CHANCELLOR_ENABLED,
		// 项目前置（2026-11-03 方案 §5.5）：派新活前先过登记表。
		projects: projectsStore(),
		// 任务单跑完回灌会话：空闲就自动出现一轮汇报，正忙则由 durable
		// 排到本轮结束（见 sayInChat 的取舍说明）。
		reportDelegation: (conversationId, report) => {
			void reportDelegationResult(conversationId, report);
		},
		// 任务专线双写（2026-11-08 扫尾批 8g）：进度 / REPORT / out 留言同步一份
		// 进 `task-<票号>` 会话。开关在 task-conversation 内部（TASK_AS_CONVERSATION）。
		mirrorDelegation: taskConversationMirror,
		// 课题（2026-11-07）：createTools 内按 TOPICS_ENABLED / 依赖缺失决定注不注册。
		topics: topicsStore(),
		search: searchModule,
		// 执事间递话（2026-11-08 扫尾批 8d）：执事能力 + 通道开关**双闸**，
		// 关任一个 → `send_to_agent` 不上架（模型侧 tool_unavailable = 本批的回滚形态）。
		relay:
			COMPANIONS_ENABLED && partnerRelayEnabled()
				? { deliver: deliverPartnerRelay }
				: null,
		// 自建巡逻（2026-11-08 刀二 E4）：ROUTINE_SELF_SERVICE=false → 工具不上架；
		// 上架时把排链函数注入工具，避免 tools.ts 反向 import routines.ts 绕成环。
		routineSelfService: routineSelfServiceEnabled(),
		scheduleRoutine: (routineId) => routineEngine().ensureScheduled(routineId),
		// 会话考古（2026-11-09 T4 §4）：默认开；AGENT_RECALL_SESSIONS=false → 不传，
		// `recall_sessions` 整块不注册（模型侧 tool_unavailable，一行回滚）。
		// 用 getHarness() 惰性取：createTools 执行时 harness 还没 open，真正调用时已就绪。
		recallSessions: recallSessionsEnabled()
			? (query, options) =>
					getHarness().then((harness) => searchSessions(harness, query, options))
			: null,
		// persona-metric 记忆库检索（2026-11-09 persona 接入批一，方案 D-甲/D-乙/D-己）：
		// `PERSONA_MEMORY_ASK` 配置 = 启用（默认未配置 = 工具不上架）；`PERSONA_MEMORY_ENABLED=false`
		// = 显式关。双闸都过才注入，`persona_recall` 才注册（模型侧 tool_unavailable，一行回滚）。
		// 本批只走按需工具，不进 recallContext / buildContext 的每轮注入链。
		personaAsk:
			personaAskEnabled() && askPersonaAvailable()
				? (question, options) => askPersona(question, options)
				: null,
	});
	registry.install(
		(lifediaryExt = defineExtension({
			name: "lifediary",
			tools: lifediaryTools,
			sections: [
				// 人格（2026-11-06 B2 改为按会话种类分流）：
				//  - 非 chief 的执事会话 → 不注入总管 persona（身份来自其 configure instructions）；
				//  - worker → 独立的普通任务助手提示；
				//  - chief / 无记录旧会话 → 总管 SOUL 当前版本快照，读不到回落原 PERSONA 常量。
				{
					key: "persona",
					render: async (input) => {
						if (COMPANIONS_ENABLED) {
							try {
								const partnerId = partnersStore().partnerIdOfSession(Number(input.conversationId));
								if (partnerId && partnerId !== CHIEF_PARTNER_ID) return undefined;
							} catch {
								// 档案库读失败：按总管处理，主对话不能哑
							}
						}
						const kinds = await input.read.snapshot(ChatKinds, CTX);
						if (kinds?.byInternal?.[String(input.conversationId)] === "worker") return WORKER_PERSONA;
						return resolvePersona(partnersStore, PERSONA);
					},
				},
				// 注入防线（2026-11-09 T2）：紧跟在 persona 之后，固定字节、不含动态内容。
				// 关掉时整段省略（不注空壳）。
				{
					key: "injection_guard",
					render: () => (injectionGuardEnabled() ? INJECTION_GUARD : undefined),
				},
				// 当前项目（2026-11-04 方案 §2.3）：每轮现渲染，不写进对话历史。
				// 切换项目后 durable 会按 section 差异追加新的 pi.system，下一轮即生效。
				{
					key: "current_project",
					render: () => {
						if (!currentProjectEnabled()) return undefined;
						const project = currentProject();
						if (!project) return "当前无特定项目（杂事模式）。文件操作默认在主工作区。";
						return [
							`当前项目：${project.name}`,
							`根路径：${project.rootPath}`,
							"文件操作默认在此项目内。",
						].join("\n");
					},
				},
				// L1 技能索引（2026-10-31 方案 D5）：排在 persona 后（"会话后部"），按会话冻结——
				// 首轮渲染后技能目录再变也不改写本会话，否则 durable 会追加新 pi.system、缓存前缀整段作废。
				// 没有技能时 render 返回 undefined，整个 section 省略。
				{
					key: "skills",
					render: (input) => skillStore?.indexFor(Number(input.conversationId)),
				},
				// 课题（2026-11-07 长期课题跟进 §六）：清单 + 嗅探判据 + 攒着的简报。
				// **每轮现渲染**（durable 只在 section 值变化时追加 pi.system）：
				//   - 只给总管主对话：非 chief 执事 / worker / 群会话一律 undefined；
				//   - 有 pendingPush 的课题在这里把简报带进本轮，并**渲染即标记已推送**
				//     （每课题每次活跃只报一次；研究专线摘掉了本扩展，不会误触）；
				//   - 没有在跟的课题也输出判据段，让总管知道"有这个口"。
				{
					key: "topics",
					render: async (input) => {
						if (!TOPICS_ENABLED) return undefined;
						const conversationId = Number(input.conversationId);
						if (COMPANIONS_ENABLED) {
							try {
								if (partnersStore().isGroupSession(conversationId)) return undefined;
								const partnerId = partnersStore().partnerIdOfSession(conversationId);
								if (partnerId && partnerId !== CHIEF_PARTNER_ID) return undefined;
							} catch {
								// 档案库读失败：按总管处理（主对话不能哑，与 persona 同口径）
							}
						}
						const kinds = await input.read.snapshot(ChatKinds, CTX);
						if (kinds?.byInternal?.[String(conversationId)] === "worker") return undefined;

						const store = topicsStore();
						const pushes = store.drainPendingPushes();
						const digest = store.digestForInjection();
						const lines: string[] = [];
						if (digest) {
							lines.push("在跟的课题：", digest);
						} else {
							lines.push("在跟的课题：（暂无）");
						}
						if (pushes.length > 0) {
							// 只记条数，不记课题内容（日志纪律）
							console.log(`[topics] 简报注入 ${pushes.length} 条`);
							lines.push(
								"",
								"课题简报（攒着的，随本轮自然汇报给用户，别复述全文）：",
								...pushes.map((topic) => {
									const latest = topic.findings[0];
									// 课题问题是用户可控文本：注入时标成不可信目标（§3.4）
									return `- ${wrapUntrustedObjective(topic.question)}：${latest?.summary ?? "有新发现"}`;
								}),
							);
						}
						lines.push(
							"",
							"课题嗅探（从严，宁缺毋滥）：开放性问题 + 今天给不了定论 + 值得隔几天回头看 + 用户显出兴趣，四条都满足才用 propose_topic 提交提议；",
							"同一话题单会话最多提一次；只提交提议、永不自动建课题（用户确认后才建）。",
						);
						return lines.join("\n");
					},
				},
			],
			hooks: [
				// 权限闸门：pi 本身不带，这是唯一能拦下工具调用的地方
				hook(ToolTask, {
					beforeTool: async (call: ToolHookCall, api, context) => {
						// 闸门留痕（2026-11-09 保证实现纵深 §5）：所有拦下都经这里收口，
						// 保证"模型看得到、账上也有一行"。只记工具名 + 类别，**不记参数**。
						const blocked = (
							reason: string,
							category: GateBlockCategory,
							source: string,
						) => {
							auditGateBlock({
								conversationId: api.conversationId,
								tool: call.name,
								category,
								source,
							});
							return { block: reason };
						};
						if (toolsBlocked.has(api.conversationId)) {
							return blocked(
								"本轮工具调用已达上限，请直接用已有信息回答",
								"turn-limit",
								"turn-limit",
							);
						}
						// 结构化提问（2026-11-09 §3）：借审批 pending 管线挂一张问题卡，
						// 本轮到此收尾；人答复后由答复端点 followUp 续跑。
						// 校验失败只回给模型（不建 pending、不算闸门拦下）。
						if (call.name === ASK_USER_TOOL_NAME && askUserEnabled()) {
							const created = createAskUserPending({
								conversationId: api.conversationId,
								callId: call.id,
								args: call.arguments,
							});
							return { block: created.ok ? ASK_USER_WAITING_MESSAGE : created.message };
						}
						// 自动化永不扩权（2026-11-09 T2 §4）：自主轮里结构性拒绝
						// routine_manage / partner_manage / group_manage / send_to_agent，
						// 以及带 targetDevice 或缺 project 的 delegate。**不是 ask，是 block**。
						// 放在递话通道闸之前：自主轮的 send_to_agent 统一回"不能扩权"的理由。
						const autonomous = isAutonomyTurn(api.conversationId);
						if (autonomous) {
							const escalation = autonomyEscalationBlockReason(
								call.name,
								call.arguments,
								autonomous,
							);
							if (escalation) return { block: escalation };
						}
						// 执事间递话的通道闸（2026-11-08 扫尾批 8d）：先于通用闸门。
						// 防乒乓是结构保证 —— 递话触发的轮次里工具在这里被摘掉（方案 §一.5），
						// 与模型说了什么无关。主人对话 / 群会话 / 自主轮同样在这条拦下。
						if (call.name === RELAY_TOOL_NAME && partnerRelayEnabled()) {
							const relayBlock = relayToolBlockReason(api.conversationId);
							if (relayBlock) return blocked(relayBlock, "relay", "relay");
						}
						const readOnly = readOnlyBlockReason(call.name);
						// 自主轮高危审批（批次C C2）：例行轮（autonomyTurns 事实源）里
						// RISK_TOOLS 一律强制 ask——普通轮行为完全不变（D6 口径不动）。
						const risk = autonomyRiskVerdict(call.name, autonomous);
						let verdict: ApprovalVerdict = risk.forceAsk
							? ({ kind: "ask" } as const)
							: needsApproval(policy, call.name, readOnly);
						if (verdict.kind === "block") {
							return blocked(verdict.reason, "policy", "policy");
						}
						// 最大工作区物理边界（2026-11-04 方案 §2.4）：write/edit 的目标路径
						// 解析后必须落在工作区根内。未设工作区时旁路（不把没配的人锁死）。
						// 放在审批之前：越界是硬拒绝，没有"确认后就能写"的说法。
						const pathBlock = pathGuardBlockReason({
							tool: call.name,
							args: call.arguments,
							workspaceRoot: workspaceRootReal(),
							cwd: sessionCwd(),
						});
						if (pathBlock) return blocked(pathBlock, "path", "path-guard");
						// 防打转守卫（2026-11-05 批次A A1）：放在闸门之后——被拦的调用没执行，
						// 不喂守卫；铁证在执行前拦下，省掉一次注定无意义的执行。
						// 只统计顶层调用（嵌套不喂，防放大误判）；≥30s 节奏轮询在守卫内豁免。
						if (loopGuardEnabled() && call.parent === undefined) {
							const guardHit = loopGuardFor(api.conversationId).before(call.name, call.arguments);
							if (guardHit !== "ok") {
								console.warn(
									`[loop-guard] 会话 ${api.conversationId} 铁证中断 pattern=${guardHit.pattern} count=${guardHit.count} tool=${call.name}`,
								);
								return blocked(LOOP_GUARD_BLOCK_MESSAGE, "loop-guard", "loop-guard");
							}
						}
						// bash 默认超时（2026-11-04 批次一 A4）：只补模型没传的 timeout。
						// 内核会拿返回的 arguments 重新校验（types.d.ts 的 ToolHooks.beforeTool）；
						// `timeout=0` 绝不能注入 —— 内核 validateTimeout 对 <=0 直接抛错。
						let injected: { timeout?: number } | undefined;
						if (call.name === "bash" && BASH_TIMEOUT_S > 0) {
							const a = call.arguments as { timeout?: number };
							if (a.timeout === undefined) injected = { ...a, timeout: BASH_TIMEOUT_S };
						}
						// 只读白名单（2026-11-09 任务书 T3 §2，默认关）：只降噪，不放宽封锁。
						// 位置刻意在 block / pathBlock / loop-guard 之后：那些判定已经把该拦的拦了，
						// 这里只把剩下的 `ask` 降成 `allow`。自主轮的强制问（risk.forceAsk）不在此列。
						if (
							verdict.kind === "ask" &&
							!risk.forceAsk &&
							readAllowlistEnabled() &&
							isReadOnlyShellCommand(call.name, call.arguments, workspaceRootReal(), sessionCwd())
						) {
							verdict = { kind: "allow" };
						}
						// 审批（2026-11-04 批次二；2026-11-08 扫尾批 8c 默认为「等待态落库」形态）：
						//   - 先查一次性放行清单：人批准过的「同工具 + 同参数」重发 → 核销并放行；
						//     换参数就不命中，重新走审批（批了 A 不能执行 B）。
						//   - 没命中 → 落 pending：blocking 形态挂起等答复（旧行为），
						//     async 形态回拒绝性答复、本轮照常收尾，答复后由服务端 followUp 续跑。
						// 本会话记住过的工具直接放行（进程内，重启失效）。
						// 自主轮禁"记住"绕过（批次C C2）：例行轮的每次写/派都必须真人答复。
						if (verdict.kind === "ask" && (autonomous || !approvalStore().isRemembered(api.conversationId, call.name))) {
							const mode = approvalMode();
							const timeoutS = approvalTimeoutSeconds(process.env);
							// 指纹拿**原始 arguments** 算（不能拿截断后的 args 摘要，否则长参数永远对不上）
							const argsHash = approvalArgsHash(call.arguments);
							const openPending = () => {
								const pending = approvalStore().create({
									callId: call.id,
									conversationId: api.conversationId,
									tool: call.name,
									// 与 tool 事件同一口径截断；这份摘要会落盘（有意），永不进日志
									args: toolArgs(call.arguments).args ?? "",
									argsHash,
									// async 形态下 deadlineAt 只作展示（旧客户端倒计时），不据此结算
									timeoutMs: timeoutS * 1000,
									...(autonomous ? { origin: "autonomous" as const } : {}),
								});
								// 借派活通道发给对话流（见 delegation.ts 模块头注释）
								emitDelegation(api.conversationId, {
									type: "approval",
									callId: pending.record.callId,
									tool: pending.record.tool,
									args: pending.record.args,
									deadlineAt: pending.record.deadlineAt,
									...(autonomous ? { origin: "autonomous" as const } : {}),
								});
								return pending;
							};
							if (mode === "async" && approvalStore().consumeGrant(api.conversationId, call.name, argsHash)) {
								// 命中：批准的调用，复判等待期里可能变了的策略与边界（与旧路径同一口径）
								const recheck = readOnlyBlockReason(call.name);
								if (recheck) return blocked(recheck, "policy", "policy-recheck");
								const recheckPath = pathGuardBlockReason({
									tool: call.name,
									args: call.arguments,
									workspaceRoot: workspaceRootReal(),
									cwd: sessionCwd(),
								});
								if (recheckPath) return blocked(recheckPath, "path", "path-guard-recheck");
							} else if (mode === "blocking") {
								const status = await waitForApproval(openPending(), timeoutS, context.abortSignal);
								if (status !== "approved") {
									// 拒绝带指导语（2026-11-09 §4.1）：blocking 形态的答复在记录里，
									// 不带 feedback 时 denialReason 逐字节等于旧文案。
									// ask_user 走 /answer，不会进 blocking；万一出现按中止处理。
									const denial =
										status === "answered" ? ("aborted" as const) : status;
									return blocked(
										denialReason(
											denial,
											call.name,
											timeoutS,
											approvalStore().recordOf(call.id)?.feedback,
										),
										"approval",
										"approval",
									);
								}
								// 批准后复判：等待期间可能被切到只读 / 拉黑 / 换工作区
								const recheck = readOnlyBlockReason(call.name);
								if (recheck) return blocked(recheck, "policy", "policy-recheck");
								const recheckPath = pathGuardBlockReason({
									tool: call.name,
									args: call.arguments,
									workspaceRoot: workspaceRootReal(),
									cwd: sessionCwd(),
								});
								if (recheckPath) return blocked(recheckPath, "path", "path-guard-recheck");
							} else {
								// async：同一件事只挂一张卡（模型重试同参数时不再重复弹），
								// 然后回拒绝性答复让本轮收尾——零挂起、零等待。
								if (!approvalStore().findPending(api.conversationId, call.name, argsHash)) {
									openPending();
								}
								return { block: APPROVAL_WAITING_MESSAGE };
							}
						}
						// 告诉客户端"现在开始动手了"（工具可能跑几十秒，界面上不能一直空白）
						emitPhase(api.conversationId, "working");
						emitTool(api.conversationId, {
							name: call.name,
							status: "start",
							label: toolLabel(call.arguments),
							...toolArgs(call.arguments),
						});
						// 首次动工具时按 D3 切一次思考档（短会话才切，切了就保持）
						await switchThinkingOnTool(api, context);
						// 唯一出口：批准后也走这里，保住上面算好的 bash 超时注入
						return injected ? { arguments: injected } : undefined;
					},
					// 工具跑完、把结果交回模型 → 又回到"在思考"
					afterTool: (call: ToolHookCall, result, api) => {
						// 恢复注记（2026-11-09 任务书 T3 §5）：`delegate resume:true` = 一次续跑，
						// 记一笔；下一次模型请求前由 beforeRequest 注入一次「先查再动」。
						// 放在这里而不是 tools.ts：工具侧不必知道 agent/ 的存在。
						if (call.name === "delegate" && (call.arguments as { resume?: boolean }).resume === true) {
							markRecoverResume(api.conversationId);
						}
						// 防打转守卫记账（批次A A1）：铁证已由 beforeTool 拦下，这里只出疑似告警。
						// 被闸门拦下的调用走不到这里（beforeTool 提前 return），天然不喂守卫。
						if (loopGuardEnabled() && call.parent === undefined) {
							const warned = loopGuardFor(api.conversationId).after(call.name, call.arguments, {
								isError: result.isError,
								output: result.output,
							});
							if (warned !== "ok") {
								console.warn(
									`[loop-guard] 会话 ${api.conversationId} 疑似打转 pattern=${warned.pattern} count=${warned.count} tool=${call.name}`,
								);
							}
						}
						// bash 超时转后台（2026-11-09 任务书 T3 §3，默认关）：超时 ≠ 失败。
						// 只认内核固定文案（`Command timed out after N seconds`），然后由服务端
						// 自己 spawn 同一条命令继续跑；工具结果换成"已转到后台"这一句。
						// 先决定再发工具帧——否则 UI 先看到一个失败帧、模型却收到"已转到后台"。
						let backgrounded: ReturnType<typeof replacedResult> | undefined;
						if (bashBackgroundEnabled() && (call.name === "bash" || call.name === "powershell")) {
							const timeoutS = timeoutSecondsFromResult(result);
							const command = (call.arguments as { command?: unknown }).command;
							if (timeoutS !== null && typeof command === "string" && command.trim()) {
								const moved = moveToBackground({
									command,
									cwd: sessionCwd(),
									timeoutSeconds: timeoutS,
									onFinished: (record, logTail) => {
										const tail = logTail.trim();
										void sayInConversation(
											api.conversationId,
											`后台任务 ${record.id} 已结束（退出码 ${record.exitCode ?? "未知"}）。` +
												(tail ? `\n最后一段输出：\n${tail}` : ""),
										).catch(() => undefined);
									},
								});
								backgrounded = replacedResult(moved.message);
							}
						}
						const finalResult = backgrounded ?? result;
						emitPhase(api.conversationId, "thinking");
						emitTool(api.conversationId, {
							name: call.name,
							status: "end",
							ok: finalResult.isError !== true,
							...toolOutput(finalResult),
						});
						return backgrounded;
					},
				}),
				// 每次请求前：注入记忆 + 数这是本轮的第几个工具回合
				hook(GenerationTask, {
					beforeRequest: async (request, api, ctx) => {
						const extra: { role: "system"; content: string; timestamp: number }[] = [];

						const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
						const memory = recallContext(
							api.conversationId,
							lastUser ? contentText(lastUser.content) : "",
						);
						if (memory) {
							extra.push({ role: "system", content: memory, timestamp: Date.now() });
						}

						// 技能斜杠调用（2026-11-09 用户口径：对话框输入「/技能名」就能用）：
						// 本轮用户消息以 /技能名 开头 → 手册整份注入本轮（D5 的"正文按需取"，这就是那一次）。
						// 开着（在启停名单里）才注入——关着的技能 tool 侧取不到，这里同样不给。
						const slashName = skillSlashOf(lastUser ? contentText(lastUser.content) : "");
						const slashManual = slashName ? skillStore?.manual(slashName) : undefined;
						if (slashName && slashManual) {
							extra.push({
								role: "system",
								content:
									`【技能调用 · ${slashName}】\n${slashManual}\n（用户消息开头的 /${slashName} 就是调用这份手册；其余文字是这一轮的指令。）`,
								timestamp: Date.now(),
							});
						}

						// 恢复注记（2026-11-09 任务书 T3 §5）：续跑（delegate resume / 启动自动续跑）
						// 之后的模型请求补一次「先查再动」；取走即核销，每张单最多一次。
						const recoverNote = takeRecoverNote(api.conversationId);
						if (recoverNote) {
							extra.push({ role: "system", content: recoverNote, timestamp: Date.now() });
						}

						// 一次模型请求 = 一个工具回合。run 一换，预算就重新算。
						//
						// 拿 `run.inputs[0]` 当 run 身份：run.taskId 每一轮都会变
						// （每一轮是一个新的 generation 任务），用它计数永远归零，
						// 上限就形同虚设 —— 这个坑是实测踩出来的。
						const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
						const runId = live?.run?.inputs?.[0] ?? live?.run?.taskId;
						const key = `${api.conversationId}:${String(runId ?? "none")}`;
						const used = (runTurns.get(key) ?? 0) + 1;
						runTurns.set(key, used);

						// 执事间递话（2026-11-08 扫尾批 8d）：把 run 身份记给通道，并认领
						// "这一轮由递话触发"的一次性标记。认领放在这里而不是 beforeTool，
						// 是因为一次模型请求对应一轮里**第一个**必到的点；mid-run 被 followUp
						// 插进来的递话也在这里认领（那时 used>1，标记落到同一个 run 键上）。
						beginRelayRun(api.conversationId, key);
						if (claimRelayTarget(api.conversationId)) {
							markRelayRun(api.conversationId, key);
						}

						if (MAX_TURNS > 0 && used > MAX_TURNS) {
							toolsBlocked.add(api.conversationId);
							limitHits.set(api.conversationId, (limitHits.get(api.conversationId) ?? 0) + 1);
							extra.push({
								role: "system",
								content: TURN_LIMIT_INSTRUCTION,
								timestamp: Date.now(),
							});
							console.warn(
								`[agent] 会话 ${api.conversationId}（run ${String(live?.run?.taskId)}）工具回合达上限 ${MAX_TURNS}`,
							);
							if (used > MAX_TURNS + HARD_STOP_GRACE && !aborting.has(key)) {
								aborting.add(key);
								console.warn(`[agent] 会话 ${api.conversationId} 无视上限，硬停这一轮`);
								void abortRun(api.conversationId);
							}
						} else if (used === 1) {
							// 新的一轮，把上一轮封掉的工具放开
							toolsBlocked.delete(api.conversationId);
							// 防打转守卫同步清零（批次A A1）：判据按轮计，不跨轮累计
							resetLoopGuard(api.conversationId);
						}

						// 执事轮输入（2026-11-08 员工人格化刀一 E1/E5）：岗位契约 + 当前在办。
						//
						// **两类执事轮都走这一条**：私聊/例行（partner-runtime.runPartnerTurn）与
						// 群成员轮（group-runtime.buildMemberInput）用的都是同一条 harness +
						// 同一个扩展，所以在这里按会话认执事即可——不必在两处装配代码里各写一遍
						// （写两遍反而会让群轮看到两份）。总管 / 主人会话（partnerIdOfSession=null）
						// 不注入；SOUL 仍在 instructions 里，这里只补契约与状态。
						//
						// 只在本轮**第一次**模型请求时算（used===1）：在办清单要扫 chancellor 的
						// runs/ 目录、开 sqlite，一轮里几十次工具回合各算一遍纯属浪费；这一轮开始
						// 时看到的在办，就是这一轮的"当前在办"。
						//
						// 走 system 消息而不是拼进用户正文：状态每轮都变，拼进正文会被固化进
						// transcript（既污染历史，又让模型每轮重读一段旧状态）。
						if (used === 1 && COMPANIONS_ENABLED) {
							try {
								const partnerId = partnersStore().partnerIdOfSession(api.conversationId);
								if (partnerId) {
									const turnContext = buildPartnerTurnContext(
										partnerId,
										api.conversationId,
										{ workSummary: workSummaryFor },
									);
									if (turnContext.text) {
										extra.push({
											role: "system",
											content: turnContext.text,
											timestamp: Date.now(),
										});
									}
								}
							} catch (error) {
								// 档案 / 任务中心读失败：这一轮少一段状态，但对话不能哑
								console.warn(
									`[partner] 会话 ${api.conversationId} 上下文装配失败: ${
										error instanceof Error ? error.message : String(error)
									}`,
								);
							}
						}

						if (extra.length === 0) return undefined;
						return { messages: [...extra, ...request.messages] };
					},
				}),
			],
			tasks: [ReminderTask, RoutineTask, TopicTask],
		})),
	);

	// 课题研究专线的最小扩展：摘掉 lifediaryExt（人格 / 技能 / 课题 section 全不要）后，
	// 仍然要能拿到 web_search。TOPICS_ENABLED=false 时整块不装（一行回滚）。
	if (TOPICS_ENABLED) {
		researchExt = defineExtension({
			name: "lifediary-research",
			tools: lifediaryTools.filter((tool) => tool.name === "web_search"),
		});
		registry.install(researchExt);
	}

	// 可靠性旋钮（2026-11-04 批次一 A4）：全空时 settings 为 undefined，就是"不传"。
	const settings = buildHarnessSettings(process.env);
	const reliability = reliabilitySummary(process.env);
	console.log(
		`[可靠性] bash默认超时=${reliability.bashTimeoutS > 0 ? `${reliability.bashTimeoutS}s` : "禁用"} ` +
			`stream.timeoutMs=${reliability.streamTimeoutMs ?? "未设(SDK默认10min)"} ` +
			`afterFailedRun=${reliability.afterFailedRun ?? "未设"}`,
	);

	const harness = await Harness.open(
		storage,
		{
			// 传访问器而不是快照：配置换了（CRUD / 外部改文件）下一个使用点就拿到新目录，
			// 不用重开 Harness，也不会每请求重建（审查 S2）
			models: currentModels,
			registry,
			// 每个会话的执行环境：cwd 跟着会话走；当前项目非空时用项目根（每轮现读）。
			// 会话显式配了 cwd 仍以它优先，保持"会话自己的设置不被全局状态覆盖"。
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? sessionCwd() }),
			...(settings ? { settings } : {}),
			onReport: (error, info) => {
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[agent] ${info.type}: ${detail}`);
			},
		},
		CTX,
	);

	// 审批状态先加载。2026-11-08 扫尾批 8c 起缺省**保留**遗留 pending（等待态落库，
	// 人随时回来批）；只有 blocking 回滚形态才把遗留 pending 置 timeout（fail-closed）。
	// 必须早于 resume()——恢复重走 beforeTool 时会复用 callId 生成/覆盖审批记录。
	approvalStore().load({ expireLeftover: approvalMode() === "blocking" });

	// 上次进程没跑完的活（包括睡着的提醒）接着跑
	harness.resume();
	return harness;
}

/**
 * 会话被切到过的非 off 档（2026-11-04 档位化：原来的 `thinkingSwitched: Set<number>`）。
 *
 * 进程内状态，但**不是唯一事实源**：会话的 durable 模型引用里就写着档位，
 * 所以重启后照样能读出"这会话是 low/high"，见 conversationThinkingLevel()。
 * 这个 Map 只是让"切过非 off 就保持"在引用还没读到时也有个依据。
 */
const stickyLevels = new Map<number, ThinkingLevel>();
/** 已判定"不切"的长会话：别每次工具调用都重读 usage */
const thinkingRefused = new Set<number>();

/** 这个会话的粘性档位（非 off 才有；openai-compat 的档位优先级用） */
export function stickyThinkingLevel(internalId: number): ThinkingLevel | null {
	return stickyLevels.get(internalId) ?? null;
}

/** 记一笔"切到过这个档"：off 等于清粘性（用户可以显式降回关） */
export function rememberLevel(internalId: number, level: ThinkingLevel): void {
	if (level === "off") stickyLevels.delete(internalId);
	else stickyLevels.set(internalId, level);
}

/** 短会话阈值（方案 D3 定 4000；风险表留了 4k→8k 的放宽口子，用环境变量调，不改代码） */
function thinkingTokenLimit(): number {
	const raw = Number(process.env.AGENT_THINK_TOKEN_LIMIT);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4000;
}

/**
 * 该会话上一轮的 prompt 规模（方案 D3a 的测量口径）。
 *
 * AssistantMessage.usage.input 就是那一轮的真实重算量（≈当前前缀大小）；
 * 没有任何带 usage 的 assistant 条目（首轮还没跑完过）→ 返回 null，按 D3a 视为短会话。
 */
async function lastTurnInputTokens(
	conversation: Conversation,
	context: Context,
): Promise<number | null> {
	const view = await conversation.context(context);
	for (let index = view.entries.length - 1; index >= 0; index -= 1) {
		const entry = view.entries[index];
		if (!entry || entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0] as { usage?: { input?: number } } | undefined;
		if (message && typeof message.usage?.input === "number") return message.usage.input;
	}
	return null;
}

/**
 * 工具第一次被调用时把该会话切到目标档（2026-10-31 方案 D2/D3；2026-11-04 档位化）。
 *
 * 目标档 = `AGENT_THINK_TOOL_LEVEL`（默认 `low`，非法值回退 low；旧语义是固定 deep/high）。
 * 模型**不换**（D1），只换思考变体；长会话（上一轮 prompt ≥ 阈值）**不切** ——
 * 切一次就是整段前缀重算，长会话付不起；短会话也只切一次（粘性记账），切了就保持。
 * 为什么在**工具钩子**里切而不是开局预判：预判要额外一次判定（慢且可能判错），
 * 而"模型自己决定调工具"本身就是最准的信号。切换发生在工具结果回来之前，
 * 所以本轮的后续推理就用上了思考档；代价 = 当前前缀重算一次（D3 明码标价）。
 */
async function switchThinkingOnTool(api: HookApi, context: Context): Promise<void> {
	// 已经切过/已判定不切的，不再碰库（每次工具调用都去 configure/读上下文是白付的）
	if (stickyThinkingLevel(api.conversationId) || thinkingRefused.has(api.conversationId)) return;
	// 2026-10-31 命名整改（方案 D11）：这个名字以前叫 AGENT_TOOL_UPGRADE，
	// 语义是"升级到更贵的模型"，会把读代码的人（包括我自己）带偏成"换模型"；
	// 现在它做的是"把思考档切上去"。旧别名 AGENT_TOOL_UPGRADE 已于 2026-11-07 删除。
	if ((process.env.AGENT_THINK_ON_TOOL ?? "on").trim().toLowerCase() === "off") {
		return;
	}

	const config = readLlmConfig();
	if (!config) return;
	// 目标档：非法值回退 low；off = "不切"，与总开关关掉同义（切一次只为了多思考）
	const wanted = thinkingToolLevel();
	if (wanted === "off") return;

	try {
		const harness = await getHarness();
		const conversation = await harness.conversation(api.conversationId as never, context);
		if (!conversation) return;
		const lastInput = await lastTurnInputTokens(conversation, context);
		const limit = thinkingTokenLimit();
		if (lastInput !== null && lastInput >= limit) {
			thinkingRefused.add(api.conversationId);
			console.log(
				`[agent] 会话 ${api.conversationId} 首次工具调用时 prompt≈${lastInput} ≥ ${limit}，保持当前档（长会话不切，方案 D3）`,
			);
			return;
		}
		// 目标档可能不在当前模型支持域（例如默认模型没有 medium）→ 按序落回
		const level = clampThinkingLevel(wanted, currentThinkingLevels());
		const target = chatModelRef(level);
		const agent = await conversation.agent(context);
		// 成对比较：同名模型换了供应商也要重配（审查 S1）
		if (agent.model?.provider === target.provider && agent.model?.modelId === target.modelId) {
			rememberLevel(api.conversationId, level);
			return;
		}
		await conversation.configure({ model: target }, context);
		rememberLevel(api.conversationId, level);
		console.log(
			`[agent] 会话 ${api.conversationId} 首次工具调用 → 档位 ${level}${
				level !== wanted ? `（${wanted} 不在支持域）` : ""
			}（prompt≈${lastInput ?? "首轮"} < ${limit}；本次前缀重算约 ${lastInput ?? "?"} token）`,
		);
	} catch (error) {
		// 切档失败不影响这一轮：大不了这轮继续按原来的档跑
		console.warn(
			`[agent] 会话 ${api.conversationId} 切思考档失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** D3 目标档：`AGENT_THINK_TOOL_LEVEL`（默认 low）；不认的值一律回退 low，不让拼错静默关掉能力 */
function thinkingToolLevel(): ThinkingLevel {
	const raw = (process.env.AGENT_THINK_TOOL_LEVEL ?? "").trim().toLowerCase();
	if (!raw) return "low";
	if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") return raw;
	console.warn(`[agent] AGENT_THINK_TOOL_LEVEL=${raw} 不是合法档位，按 low 处理`);
	return "low";
}

/**
 * 内部会话 id → 往这个会话里以助手身份写一句话（2026-11-04 批次四抽出）。
 *
 * 派活完成的汇报与启动恢复的状态行都走这一条；返回 false = 会话已不存在。
 * 这里只负责"找到会话 + 写进去"，错误留给调用方记日志（两边措辞不同）。
 */
export async function sayInConversation(
	conversationId: number,
	text: string,
): Promise<boolean> {
	const harness = await getHarness();
	const conversation = await harness.conversation(conversationId as never, CTX);
	if (!conversation) return false;
	await sayInChat({ conversation, externalId: "", internalId: conversationId }, text);
	return true;
}

/**
 * 任务单跑完后回灌会话（2026-11-03）。
 *
 * 为什么走 `sayInChat`：它就是"助手主动说一句话"的现成入口——写一条 `pi.assistant`
 * 进会话。会话空着时这句就是下一轮汇报的起点；会话正忙时 durable 会把它排到
 * 本轮结束，不打断当前对话。不额外调模型，也不碰上下文压缩。
 *
 * 失败只记日志、不抛：活已经跑完，汇报写不进去不该把工具或流拖下水。
 */
export async function reportDelegationResult(
	conversationId: number,
	report: DelegationReport,
): Promise<void> {
	try {
		const delivered = await sayInConversation(conversationId, report.text);
		if (!delivered) {
			console.warn(`[agent] 任务 ${report.ticketId} 的会话 ${conversationId} 已不存在，跳过汇报`);
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[agent] 任务 ${report.ticketId} 写回会话失败: ${detail}`);
	}
}

/**
 * 让助手**主动说一句话**（2026-11-01，手机端回顾页的钩子）。
 *
 * 场景：回顾页给出 2~3 个钩子问题（"新版本装好之后的回读结果跟预期一样吗？"），
 * 那本来就是**助手要问的**话。点一下应该由助说说出来、然后等用户接，而不是把这句话
 * 塞进用户输入框 —— 那样等于用户自问自答。
 *
 * 实现取舍：不调模型，直接把一条 `pi.assistant` entry 写进会话（走 `submit` 的 write，
 * 带 `model` 所以也会进模型上下文，之后再聊时它知道自己问过这句）。会话忙时由 durable
 * 排队到下一个边界落地，不会打断正在进行的一轮。
 */
export async function sayInChat(chat: ResolvedChat, text: string): Promise<void> {
	const at = Date.now();
	await chat.conversation.submit(
		{
			type: "write",
			entry: {
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [{ type: "text", text }],
						api: "lifediary.say",
						provider: "lifediary",
						model: "lifediary.say",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: at,
					},
				],
			},
		},
		CTX,
	);
}
