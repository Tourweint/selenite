/**
 * harness 装配与维护（开闭缓存 / 维护窗口 / 伙伴中继 / openHarness / 生命周期小节）
 *
 * 2026-11-13 从 lifecycle.ts 的 L1–L1160 整段切出；正文原文搬运，未改一行实现。
 */

import type { ApprovalVerdict } from "../approval-policy.ts";
import { approvalTimeoutSeconds, denialReason, needsApproval } from "../approval-policy.ts";
import { approvalStore } from "../approvals.ts";
import { ASK_USER_TOOL_NAME, ASK_USER_WAITING_MESSAGE, askUserEnabled, createAskUserPending } from "../ask-user.ts";
import { autonomyEscalationBlockReason, autonomyRiskVerdict } from "../autonomy-risk.ts";
import { isAutonomyTurn } from "../autonomy-state.ts";
import { bashBackgroundEnabled, moveToBackground, replacedResult, timeoutSecondsFromResult } from "../bash-background.ts";
import { setApprovalLevelSource } from "../delegation-authority.ts";
import { wakeOnDelegationReport } from "../delegation-wake.ts";
import { emitDelegation } from "../delegation.ts";
import { failureStreak } from "../failure-streak.ts";
import type { GateBlockCategory } from "../gate-audit.ts";
import { auditGateBlock } from "../gate-audit.ts";
import { loopGuardEnabled, loopGuardFor, resetLoopGuard } from "../loop-guard.ts";
import type { RelayDeliverResult, RelaySenderContext } from "../partner-relay.ts";
import { RELAY_AUTONOMY_BLOCK_MESSAGE, RELAY_CALLER_BLOCK_MESSAGE, RELAY_CHIEF_BLOCK_MESSAGE, RELAY_GROUP_BLOCK_MESSAGE, RELAY_HOP_BLOCK_MESSAGE, RELAY_TOOL_NAME, beginRelayRun, claimRelayTarget, clearRelayTarget, currentRelayRunKey, emitRelayReceipt, isRelayRun, markRelayRun, markRelayTarget, partnerRelayEnabled, partnerRelayReceiptEnabled, relayEntryOf, relayOutcomeEntry, relaySettledText } from "../partner-relay.ts";
import { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, partnersStore } from "../partners.ts";
import { pathGuardBlockReason } from "../path-guard.ts";
import { askPersona, askPersonaAvailable, personaAskEnabled } from "../persona-ask.ts";
import { PROGRESS_TOOL_NAME, progressReportAllowed, progressReportEnabled } from "../progress-report.ts";
import { projectsStore, workspaceRootsReal } from "../projects.ts";
import { currentModels, contextWindowsByRef, readLlmConfig } from "../provider.ts";
import { compactionSummary, readCompactionConfig } from "../compaction-settings.ts";
import { isReadOnlyShellCommand, readAllowlistEnabled } from "../read-allowlist.ts";
import { noteRequestInjections } from "../context-inspect.ts";
import { buildHarnessSettings, reliabilitySummary } from "../reliability.ts";
import { ReminderTask } from "../reminder.ts";
import { RoutineTask, routineEngine, routineSelfServiceEnabled } from "../routines.ts";
import { runIdentityKey } from "../run-key.ts";
import { searchModule } from "../search.ts";
import { makeSkillAdviceSaver, skillAdviceEnabled, skillAdvicePath } from "../skill-advice.ts";
import { mirrorTaskNotice, taskConversationMirror } from "../task-conversation.ts";
import { capabilityOf } from "../tool-capability.ts";
import { createTools } from "../tools.ts";
import { TopicTask } from "../topic-runtime.ts";
import { TOPICS_ENABLED, topicsStore } from "../topics.ts";
import { UNATTENDED_SKIP_MESSAGE, isUnattended, noteTurnToolError, noteUnattendedSkip, resolveUnattendedVerdict, unattendedDenyReason, unattendedPolicyEnabled } from "../unattended.ts";
import { WORLD_STATE_TOOLS, confirmWorldStateEnabled, verifyWorldState, worldStateTarget } from "../world-state.ts";
import { approvalArgsHash } from "./approval-key.ts";
import { CHANCELLOR_ENABLED, memoryEngine, scopeOf, skillStore } from "./assist.ts";
import { setChatKindsSource, setProjectBindingsSource, setProjectLabelResolver } from "./project-scope.ts";
import { guardRelayDelivery } from "./injection-guard.ts";
import { collectInjections, guardProvider } from "./injection.ts";
import { LIFECYCLE_MESSAGE_PROVIDERS, clarifyContractProvider, currentProjectProvider, personaProvider, skillsProvider, topicsProvider, verificationIronLawProvider } from "./lifecycle-injections.ts";
import { BASH_TIMEOUT_S, approvalMode, policy, readOnlyBlockReason } from "./policy.ts";
import { markRecoverResume } from "./recover-note.ts";
import { recallSessionsEnabled, searchSessions } from "./session-search.ts";
import { CTX, ChatKinds, ChatProjects, Chats, DB_PATH, emitPhase, emitTool, noteSessionCwd, sessionCwd, toolArgs, toolDiff, toolLabel, toolOutput } from "./shared.ts";
import { APPROVAL_WAITING_MESSAGE, HARD_STOP_GRACE, LOOP_GUARD_BLOCK_MESSAGE, MAX_TURNS, aborting, limitHits, runTurns, toolsBlocked, waitForApproval } from "./turn-gate.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { setProjectionDeps, wrapShellTool } from "../tool-projection.ts";
import type { Extension, PromptSection, ToolHookCall } from "@earendil-works/pi-durable";
import { GenerationTask, Harness, LiveDoc, ToolTask, createRegistry, defineExtension, hook } from "@earendil-works/pi-durable";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { reportDelegationResult, sayInChat, sayInConversation, switchThinkingOnTool } from "./lifecycle-thinking.ts";

setApprovalLevelSource(() => policy.approvalLevel);

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

let opening: Promise<Harness> | null = null;

let opened: Harness | null = null;

let closing: Promise<void> | null = null;

export let lifediaryExt: Extension | null = null;

export let researchExt: Extension | null = null;

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
	// 维护互斥（2026-11-13 永久删除批A）：删除会话期间新请求在这里排队等，
	// 而不是重开 Harness 去和临时 SQLite 连接抢同一个库文件（见 beginHarnessMaintenance）。
	if (maintenanceDrained) return maintenanceDrained.then(() => getHarness());
	return openOrReuseHarness();
}

function openOrReuseHarness(): Promise<Harness> {
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
	return closing.then(() => openOrReuseHarness());
}

let maintenanceCount = 0;

let maintenanceDrained: Promise<void> | null = null;

let maintenanceDrain: (() => void) | null = null;

let maintenanceChain: Promise<void> = Promise.resolve();

export function harnessMaintenanceActive(): boolean {
	return maintenanceCount > 0;
}

export function beginHarnessMaintenance(): void {
	maintenanceCount += 1;
	if (maintenanceDrained === null) {
		maintenanceDrained = new Promise<void>((resolve) => {
			maintenanceDrain = resolve;
		});
	}
}

export function endHarnessMaintenance(): void {
	if (maintenanceCount === 0) return;
	maintenanceCount -= 1;
	if (maintenanceCount === 0 && maintenanceDrain) {
		const drain = maintenanceDrain;
		maintenanceDrain = null;
		maintenanceDrained = null;
		drain();
	}
}

export function runExclusiveMaintenance<T>(fn: () => Promise<T>): Promise<T> {
	const run = maintenanceChain.then(async () => {
		beginHarnessMaintenance();
		try {
			return await fn();
		} finally {
			endHarnessMaintenance();
		}
	});
	maintenanceChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export function getHarnessForMaintenance(): Promise<Harness> {
	return openOrReuseHarness();
}

export async function closeHarnessForMaintenance(): Promise<void> {
	const dead = opened;
	if (dead && !closing) {
		opened = null;
		opening = null;
		console.warn("[agent] 维护窗口：主动关闭 Harness，SQLite 句柄交出后做删除手术");
		closing = dead
			.close(BACKGROUND_CONTEXT)
			.catch((error: unknown) => {
				console.warn(
					`[agent] 维护关闭 Harness 时报错（忽略）: ${error instanceof Error ? error.message : error}`,
				);
			})
			.finally(() => {
				closing = null;
			});
	}
	if (closing) await closing;
}

async function deliverPartnerRelay(
	targetPartnerId: string,
	body: string,
	sender: RelaySenderContext,
): Promise<RelayDeliverResult> {
	// 批 21 §二：递话正文是"别人说的话"，送达前包 untrusted_objective（数据非指令）；
	// 开关沿用 AGENT_INJECTION_GUARD，关时逐字节不变。
	const guardedBody = guardRelayDelivery(body);
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
		let submission;
		try {
			// 2026-11-15 作者标记：落成 `relay.message` 应用条目（作者进 data），
			// 落进 `pi.user` 就会被当成主人说的话（方案 §3.2）。开关关时 entry 为 null，
			// `submit` 逐字节回到 8d 形态。
			const entry = relayEntryOf({
				id: sender.partnerId,
				name: sender.name,
				domain: sender.domain,
			});
			submission = await conversation.submit(
				{
					type: "input",
					content: guardedBody,
					whenBusy: "followUp",
					...(entry ? { entry } : {}),
				},
				CTX,
			);
		} catch (error) {
			clearRelayTarget(sessionId);
			throw error;
		}
		// 两态回执（批 15 §五）：提交成功 = queued；对方那一轮真的结算 = settled。
		// **不 await**：回执要等对方跑完，不能把发送方的工具调用挂住。
		if (partnerRelayReceiptEnabled()) {
			void (async () => {
				try {
					const record = await submission.wait(CTX);
					let line = "";
					if (record.status === "done") {
						const view = await conversation.context(CTX);
						const answer = view.entries.find((entry) => entry.id === record.answer);
						line = answer?.model?.[0]
							? contentText(answer.model[0].content as Parameters<typeof contentText>[0])
							: "";
					}
					const text = relaySettledText(target.name, line);
					// ① 回流到发送方**正在流式**的那条会话（没开流就收不到，不伪造时间线）
					emitRelayReceipt(sender.conversationId, text);
					// ② 发送方 transcript 记一条留言（与 8g 的留言镜像同款 assistant 条目）
					const senderConversation = await harness.conversation(
						sender.conversationId as never,
						CTX,
					);
					if (senderConversation) {
						await senderConversation.submit(
							{ type: "write", entry: relayOutcomeEntry(`【留言】${text}`) },
							CTX,
						);
					}
				} catch (error) {
					// 回执是旁路：失败只记枚举式原因，不影响已经送出去的这条话。
					console.warn(
						`[relay] 两态回执回流失败（不挡递话）：${
							error instanceof Error ? error.message.slice(0, 120) : "unknown"
						}`,
					);
				}
			})();
		}
		return { ok: true, busy };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `提交失败：${detail.slice(0, 200)}` };
	}
}

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

function partnerOfSession(conversationId: number): string | null {
	if (!COMPANIONS_ENABLED) return null;
	try {
		return partnersStore().partnerIdOfSession(conversationId);
	} catch {
		return null;
	}
}

type SectionInput = Parameters<NonNullable<PromptSection["render"]>>[0];

async function chatKindOfSection(input: SectionInput): Promise<"chief" | "worker"> {
	const kinds = await input.read.snapshot(ChatKinds, CTX);
	return kinds?.byInternal?.[String(input.conversationId)] === "worker" ? "worker" : "chief";
}

function groupOfSession(conversationId: number): boolean {
	if (!COMPANIONS_ENABLED) return false;
	try {
		return partnersStore().isGroupSession(conversationId);
	} catch {
		return false;
	}
}

export const LIFECYCLE_SECTIONS: readonly PromptSection[] = [
	// 人格（2026-11-06 B2 分流）：非 chief 执事不注总管 persona；worker 用独立提示；
	// chief / 无记录旧会话用 SOUL 快照，读不到回落 PERSONA。
	{
		key: "persona",
		render: async (input) => {
			const conversationId = Number(input.conversationId);
			const chatKind = await chatKindOfSection(input);
			return collectInjections([personaProvider], {
				conversationId,
				partnerId: partnerOfSession(conversationId),
				chatKind,
			}).system[0]?.text;
		},
	},
	// 验证铁律（2026-11-10 批 12 §一.1）：紧跟 persona，固定字节。
	{
		key: "verification_iron_law",
		render: (input) => {
			const conversationId = Number(input.conversationId);
			return collectInjections([verificationIronLawProvider], {
				conversationId,
				partnerId: partnerOfSession(conversationId),
			}).system[0]?.text;
		},
	},
	// 开工前先问清（2026-11-10 批 19 §一）：只给总管 / 主对话。
	{
		key: "clarify_contract",
		render: async (input) => {
			const conversationId = Number(input.conversationId);
			const chatKind = await chatKindOfSection(input);
			return collectInjections([clarifyContractProvider], {
				conversationId,
				partnerId: partnerOfSession(conversationId),
				chatKind,
			}).system[0]?.text;
		},
	},
	// 注入防线（2026-11-09 T2）：固定字节；关掉时整段省略。
	{
		key: "injection_guard",
		render: (input) =>
			collectInjections([guardProvider], { conversationId: input.conversationId })
				.system[0]?.text,
	},
	// 当前项目（2026-11-04 方案 §2.3）：每轮现渲染，不写进对话历史。
	{
		key: "current_project",
		render: (input) =>
			collectInjections([currentProjectProvider], { conversationId: input.conversationId })
				.system[0]?.text,
	},
	// L1 技能索引（2026-10-31 方案 D5）：按会话冻结（provider 内部走 indexFor）。
	{
		key: "skills",
		render: (input) =>
			collectInjections([skillsProvider], { conversationId: input.conversationId })
				.system[0]?.text,
	},
	// 课题（2026-11-07 §六）：每轮现渲染 + drainPendingPushes；只给总管主对话。
	{
		key: "topics",
		render: async (input) => {
			const conversationId = Number(input.conversationId);
			const chatKind = await chatKindOfSection(input);
			return collectInjections([topicsProvider], {
				conversationId,
				partnerId: partnerOfSession(conversationId),
				group: groupOfSession(conversationId),
				chatKind,
			}).system[0]?.text;
		},
	},
];

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
			// 汇报写了就唤醒（批 29）：两条结算路径都汇到这个回调，结构保证不漏。
			void wakeOnDelegationReport(conversationId, report);
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
		// 自建规则的首轮来源标记（2026-11-10 批 15 §三）：routine_manage 建规则时落一笔。
		markSelfRoutine: (routineId) => routineEngine().markSelfCreated(routineId),
		// agent 中途播报（2026-11-10 批 13 §三）：默认开；AGENT_PROGRESS_REPORT=false → 不上架。
		// 任务专线镜像只在"当前会话正好是 task- 专线"时写一条，没有则什么也不做。
		progressReport: progressReportEnabled(),
		mirrorTaskNotice,
		// 技能分类建议落盘（2026-11-10 批 30 修订）：SKILL_ADVICE=false → save_skill_advice
		// 不上架。评估在总管对话里做（设置页预填提示词 → 总管逐条评估 → 本工具写快照），
		// 快照路径与 skills-api 的 advice 端点同一个文件（skillAdvicePath）。
		skillAdviceSave: skillAdviceEnabled() ? makeSkillAdviceSaver(skillAdvicePath()) : null,
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
	// 会话归属项目（2026-11-15 项目记忆方案）：给 project-scope 注入快照源（零依赖小模块，
	// assist/lifecycle-harness 都不反向 carry 它——环与测试加载面的坑见该文件头注释）。
	// getHarness() 惰性取：接线时 harness 还没 open，真正调用时已就绪。
	setProjectBindingsSource(async () => {
		const harness = await getHarness();
		const [chats, bindings] = await Promise.all([
			harness.snapshot(Chats, CTX),
			harness.snapshot(ChatProjects, CTX),
		]);
		const pairs: Array<readonly [number, string]> = [];
		for (const [conversationId, internalId] of Object.entries(chats?.byExternal ?? {})) {
			const projectId = bindings?.byInternal?.[String(internalId)];
			if (projectId) pairs.push([Number(conversationId), projectId] as const);
		}
		return pairs;
	});
	// 人格挂载（2026-11-15 项目记忆挂载跟人走方案）：kind 判定快照源。链接执事的会话
	// 由 partnersStore 现查（sync）；这里只补 chief / worker 的 durable 一半。
	setChatKindsSource(async () => {
		const harness = await getHarness();
		const kinds = await harness.snapshot(ChatKinds, CTX);
		return { ...(kinds?.byInternal ?? {}) };
	});
	// 项目名解析（2026-11-15 项目记忆多挂载）：uuid → 名字，供注入行归属标注与
	// 负责项目索引。含归档项目（挂载校验口径含归档——记忆还在，名字也该在）。
	setProjectLabelResolver((projectId) => {
		const project = projectsStore()
			.listProjects(true)
			.find((entry) => entry.id === projectId);
		return project?.name ?? null;
	});
	// 工具结果投影挂载判定依赖（2026-11-13 工具层结果契约化 §5）：store 与 ChatKinds 现查，
	// tool-projection 只收纯函数。getPartner 读不到（无 partners 行）时按 null 走默认判定。
	setProjectionDeps({
		partnerIdOfSession: (sessionId) => {
			if (!COMPANIONS_ENABLED) return null;
			try {
				return partnersStore().partnerIdOfSession(sessionId);
			} catch {
				return null;
			}
		},
		getPartner: (id) => partnersStore().get(id),
		chatKindOf: async (sessionId) => {
			try {
				const harness = await getHarness();
				const kinds = await harness.snapshot(ChatKinds, CTX);
				return kinds?.byInternal?.[String(sessionId)] ?? null;
			} catch {
				return null;
			}
		},
	});
	registry.install(
		(lifediaryExt = defineExtension({
			name: "lifediary",
			tools: lifediaryTools,
			sections: LIFECYCLE_SECTIONS,
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
						// 无人值守（2026-11-10 批 13 §一/§二）：**先于一切审批判定**。
						// 三态收口——allow / skip / deny；绝不落 pending 等人（人在睡觉）。
						// 开关默认 false：关着时这一整块不执行，行为与改动前逐字节一致。
						let unattendedAllow = false;
						if (unattendedPolicyEnabled() && isUnattended(api.conversationId)) {
							const verdict = resolveUnattendedVerdict(call.name, capabilityOf(call.name));
							if (verdict === "deny") {
								return blocked(unattendedDenyReason(call.name), "policy", "unattended");
							}
							if (verdict === "skip") {
								noteUnattendedSkip(api.conversationId, call.name);
								// 跳过不是失败：模型拿到固定话术，继续做不需要花钱的部分。
								return blocked(UNATTENDED_SKIP_MESSAGE, "policy", "unattended-skip");
							}
							// allow = 照常执行，**而且不再走下面的审批**：否则自定义的
							// `AGENT_APPROVAL_CRITICAL_TOOLS` 仍可能把 allow 的工具问成 pending。
							unattendedAllow = true;
						}
						// 中途播报的上架范围（2026-11-10 批 13 §三.4）：只在执事轮 / 任务专线；
						// 主人对话里不需要（人就在看着），结构性拦下而不是靠模型自觉。
						if (call.name === PROGRESS_TOOL_NAME && !progressReportAllowed(api.conversationId)) {
							return blocked(
								"这个会话不需要中途播报（主人就在对话里看着）；把结果直接写进回复即可。",
								"policy",
								"progress-scope",
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
						// 只读 / 在工作区内修改两档要判命令文本（2026-11-14）：查看类命令放行，
						// 其余照旧拦。上下文缺一不可——拿不到命令就退回"一律拦"。
						const readOnly = readOnlyBlockReason(call.name, {
							args: call.arguments,
							workspaceRoots: workspaceRootsReal(),
							cwd: sessionCwd(api.conversationId),
						});
						// 自主轮高危审批（批次C C2）：例行轮（autonomyTurns 事实源）里
						// RISK_TOOLS 一律强制 ask——普通轮行为完全不变（D6 口径不动）。
						const risk = autonomyRiskVerdict(call.name, autonomous);
						let verdict: ApprovalVerdict = risk.forceAsk && !unattendedAllow
							? ({ kind: "ask" } as const)
							: needsApproval(policy, call.name, readOnly);
						// 无人值守 allow：执行但不再问。显式 block（黑名单 / 只读档）仍然优先——
						// 那是用户写死的边界，不是"要不要人点头"。
						if (unattendedAllow && verdict.kind !== "block") verdict = { kind: "allow" };
						if (verdict.kind === "block") {
							return blocked(verdict.reason, "policy", "policy");
						}
						// 最大工作区物理边界（2026-11-04 方案 §2.4）：write/edit 的目标路径
						// 解析后必须落在工作区根内。未设工作区时旁路（不把没配的人锁死）。
						// 放在审批之前：越界是硬拒绝，没有"确认后就能写"的说法。
						const pathBlock = pathGuardBlockReason({
							tool: call.name,
							args: call.arguments,
							workspaceRoots: workspaceRootsReal(),
							cwd: sessionCwd(api.conversationId),
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
							isReadOnlyShellCommand(call.name, call.arguments, workspaceRootsReal(), sessionCwd(api.conversationId))
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
									// 世界状态快照（批 19 §七）：只对 write / edit，且开关打开时才拍；
									// 缺省不写 = 与改动前逐字节一致。
									...(() => {
										if (!confirmWorldStateEnabled()) return {};
										const world = worldStateTarget(call.name, call.arguments, sessionCwd(api.conversationId));
										return world ? { worldState: world } : {};
									})(),
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
							const grant = mode === "async"
								? approvalStore().consumeGrantEntry(api.conversationId, call.name, argsHash)
								: null;
							if (mode === "async" && grant) {
								// 命中：批准的调用，复判等待期里可能变了的策略与边界（与旧路径同一口径）
								const recheck = readOnlyBlockReason(call.name, {
									args: call.arguments,
									workspaceRoots: workspaceRootsReal(),
									cwd: sessionCwd(api.conversationId),
								});
								if (recheck) return blocked(recheck, "policy", "policy-recheck");
								const recheckPath = pathGuardBlockReason({
									tool: call.name,
									args: call.arguments,
									workspaceRoots: workspaceRootsReal(),
									cwd: sessionCwd(api.conversationId),
								});
								if (recheckPath) return blocked(recheckPath, "path", "path-guard-recheck");
								// 世界状态重验（批 19 §七）：批准后目标文件被改过 → 拒绝执行，让模型重新确认。
								// 只对 write / edit；开关默认关。
								if (confirmWorldStateEnabled() && WORLD_STATE_TOOLS.has(call.name)) {
									const verdict = verifyWorldState(
										grant.worldState,
										worldStateTarget(call.name, call.arguments, sessionCwd(api.conversationId)),
									);
									if (!verdict.ok) {
										return blocked(verdict.reason, "approval", "world-state");
									}
								}
							} else if (mode === "blocking") {
								const status = await waitForApproval(openPending(), timeoutS, context.abortSignal);
								if (status !== "approved") {
									// 拒绝带指导语（2026-11-09 §4.1）：blocking 形态的答复在记录里，
									// 不带 feedback 时 denialReason 逐字节等于旧文案。
									// ask_user 走 /answer，不会进 blocking；万一出现按中止处理。
									const denial =
										status === "answered" ? ("aborted" as const) : status;
									// 同类失败连击（批 12 遗留补全）：被拒 / 超时各算一类。
									// 同一个工具连着三次被拒，说明该换做法而不是继续要授权。
									failureStreak().recordFailure(
										`tool:${call.name}`,
										status === "rejected" ? "rejected" : "timeout",
									);
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
								const recheck = readOnlyBlockReason(call.name, {
									args: call.arguments,
									workspaceRoots: workspaceRootsReal(),
									cwd: sessionCwd(api.conversationId),
								});
								if (recheck) return blocked(recheck, "policy", "policy-recheck");
								const recheckPath = pathGuardBlockReason({
									tool: call.name,
									args: call.arguments,
									workspaceRoots: workspaceRootsReal(),
									cwd: sessionCwd(api.conversationId),
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
						// 同类失败连击（批 12 遗留补全）：工具报错 / 超时各算一类，连到 3 次建议人接管。
						// 来源用工具名——同一个工具反复栽才是可行动的信号；只记账，文案由调用方决定。
						if (call.parent === undefined) {
							const streakSource = `tool:${call.name}`;
							if (result.isError) {
								// 例行轮安静契约的"读失败不当无新"（批 21 §三）：本轮工具报过错，
								// 产出就不能当安静吞掉——partner-runtime 收轮时取走。
								noteTurnToolError(api.conversationId, call.name);
								const text = typeof result.output === "string" ? result.output : "";
								const isTimeout = /timed out|timeout/i.test(text);
								failureStreak().recordFailure(streakSource, isTimeout ? "timeout" : "tool-error");
							} else {
								failureStreak().recordSuccess(streakSource);
							}
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
									cwd: sessionCwd(api.conversationId),
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
							// 编辑类工具带 diff（批 33）：现场工具行与文件汇总和历史 steps 同一份事实
							...toolDiff(finalResult),
						});
						return backgrounded;
					},
				}),
				// 每次请求前：注入记忆 + 数这是本轮的第几个工具回合
				hook(GenerationTask, {
					beforeRequest: async (request, api, ctx) => {
						const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
						const userText = lastUser ? contentText(lastUser.content) : "";

						// 一次模型请求 = 一个工具回合。run 一换，预算就重新算。
						// run 身份口径（inputs[0] 优先；taskId 每轮都变的坑）统一在 run-key.ts。
						const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
						const key = runIdentityKey(api.conversationId, live);
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

						// 5 处消息注入（2026-11-10 批 27 §三）：记忆召回 / 技能斜杠 / 恢复注记 /
						// 回合上限 / 执事轮上下文。框架负责排序与去重，装配处按收集结果**依次压入**，
						// 位置与改造前一致（仍是本轮模型请求最前面的几条 system 消息）。
						// 执事轮输入只在本轮第一次请求时算（used===1），provider 内照旧判定。
						const collected = collectInjections(LIFECYCLE_MESSAGE_PROVIDERS, {
							conversationId: api.conversationId,
							turn: used,
							userText,
						});
						// 设置 → 上下文只读这份"首轮实文"：记忆召回会回写使用计数，
						// 读端点不能为了预览重跑，只能记真正发出去的那一轮。
						if (used === 1) {
							noteRequestInjections(
								api.conversationId,
								collected.message.map((item) => ({ id: item.id, text: item.text })),
							);
						}
						const extra = collected.message.map((item) => ({
							role: "system" as const,
							content: item.text,
							timestamp: Date.now(),
						}));

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

	// 可靠性旋钮（2026-11-04 批次一 A4）：stream / afterFailedRun 不设就不传。
	// 2026-11-14：settings 从**快照**改成**访问器**——压缩设置改完要下一轮就生效，
	// 而内核每次使用都重读（`harness.js:123` 实读）。窗口表也每轮现取：换模型 / 加模型后
	// 百分比才能落到新模型上（`contextWindowsByRef`）。压缩默认就按 70%，所以每次都带。
	const reliability = reliabilitySummary(process.env);
	const compaction = compactionSummary(readCompactionConfig(process.env), contextWindowsByRef());
	console.log(
		`[可靠性] bash默认超时=${reliability.bashTimeoutS > 0 ? `${reliability.bashTimeoutS}s` : "禁用"} ` +
			`stream.timeoutMs=${reliability.streamTimeoutMs ?? "未设(SDK默认10min)"} ` +
			`afterFailedRun=${reliability.afterFailedRun ?? "未设"}`,
	);
	console.log(
		`[压缩] 自动=${compaction.enabled ? "开" : "关"} 触发=${compaction.trigger} ` +
			`按模型覆盖=${compaction.overridden}`,
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
			env: ({ conversationId, cwd }) => {
				// 2026-11-13 会话绑定即快照：内核带着该会话 `pi.agent.cwd` 来（新建会话时钉死），
				// 顺手记进同步缓存，beforeTool 的 path-guard / 后台搬运才拿得到"这个会话的路"。
				// 没有绑定（杂事态 / 旧会话）时 cwd 为空，退回全局当前项目。
				if (cwd) noteSessionCwd(conversationId, cwd);
				return new NodeExecutionEnv({ cwd: cwd ?? sessionCwd(conversationId) });
			},
			// 每次使用现算（不是启动时快照）：压缩旋钮走 flags → env，改完下一轮即生效。
			// 全默认时返回 undefined，等价于"不传 settings"（构造上不改变行为）。
			settings: () => buildHarnessSettings(process.env, contextWindowsByRef()),
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

export { abortRun, chatKindOfSection, closing, deliverPartnerRelay, discardHarness, groupOfSession, maintenanceChain, maintenanceCount, maintenanceDrain, maintenanceDrained, openHarness, openOrReuseHarness, opened, opening, partnerOfSession, relayToolBlockReason };
export type { SectionInput };
