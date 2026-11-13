import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import {
	LiveDoc,
	type Conversation,
	type ConversationView,
	type LiveState,
	type SettledSubmissionRecord,
	type Tx,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { locateEvidence, normalizeForGrounding, type MemoryRecord } from "@lifediary/memory";
import type {
	ChatKind,
	DelegationPhase,
	NewChatKind,
	StreamErrorCode,
	ThinkingLevel,
	TranscriptStep,
	TurnUsage,
} from "@lifediary/shared";
import { describeStreamError } from "../stream-error.ts";
import { approvalStore } from "../approvals.ts";
import type { OutgoingPart } from "../attachments.ts";
// 杂活模型（2026-11-10 批 26b §一）：compact 配置能解析，但内核不支持指定压缩模型，
// 配了要记一条明确日志（不静默失效）。开关沿用 AUX_LLM。
import { auxiliaryEnabled, auxPinnedModelId } from "../auxiliary.ts";
import { userInputSubmission } from "./user-input.ts";
import { watchDelegation, type DelegationEvent } from "../delegation.ts";
import { memoryExtractMode, preferenceExtractionEnabled } from "../memory-extract.ts";
import { COMPANIONS_ENABLED, partnersStore } from "../partners.ts";
// 执事间递话的主人通知口（2026-11-08 扫尾批 8d）：递话发生在别的会话里，
// 这里只订阅"主人能看到的那一条"（只报谁→谁，正文不展示）。
import { watchChiefNotice, watchRelayReceipt } from "../partner-relay.ts";
import {
	chatModelRef,
	clampThinkingLevel,
	currentModels,
	currentThinkingLevels,
	isFaux,
	levelFromModelId,
	readLlmConfig,
} from "../provider.ts";
import { ReminderTask } from "../reminder.ts";
// 项目归属（2026-11-12 归档模块 §5）：建普通会话时只读当前项目 id；项目库坏了不能挡建会话，
// 所以调用点一律 try/catch 旁路（见 openChat）。
import { projectsStore } from "../projects.ts";
import { markTaskSession } from "../unattended.ts";
import { memoryEngine } from "./assist.ts";
import { getHarness, lifediaryExt, rememberLevel, researchExt, stickyThinkingLevel } from "./lifecycle.ts";
import { turnSettledHandler } from "./settled.ts";
import {
	CTX,
	ChatKinds,
	ChatProjects,
	Chats,
	ResolvedChat,
	TASK_CONVERSATION_PREFIX,
	TOOL_OUTPUT_LIMIT,
	type ToolEvent,
	type TurnPhase,
	toolArgs,
	toolLabel,
	watchPhase,
	watchTool,
} from "./shared.ts";
import { TURN_LIMIT_MESSAGE, limitHits } from "./turn-gate.ts";

/**
 * 本轮思考档（2026-11-04 思考档位方案 D1/D3，替代快/深两档）。
 *
 * 档位是**同一个模型的四条思考变体**（换模型 = 上游缓存清零）：
 * `off` 思考关，`low/medium/high` 走 `reasoning_effort`。
 * 切档 = 请求头块变化 = 当前前缀整段重算（方案 §2.3），所以默认**按会话定档、中途不切**；
 * 例外是 D3 的"短会话首次调工具切一次"，在工具钩子里做（见 switchThinkingOnTool）。
 *
 * 越界档位（例如新模型不支持 medium）在这里落回支持域内的最高可用档——
 * 显式 `/mode` 走端点校验并 400，这里兜的是 X-Mode / D3 这类"服务端自己定的档"。
 */
export async function applyChatMode(chat: ResolvedChat, level: ThinkingLevel): Promise<void> {
	const config = readLlmConfig();
	if (!config) return;
	const target0 = clampThinkingLevel(level, currentThinkingLevels());
	if (target0 !== level) {
		console.log(
			`[agent] 会话 ${chat.internalId} 档位 ${level} 不在当前模型支持域，落回 ${target0}`,
		);
	}
	const target = chatModelRef(target0);
	const agent = await chat.conversation.agent(CTX);
	// 供应商与模型都要比：同名模型跨供应商是另一个上游，不能算"没变"（审查 S1）
	if (agent.model?.provider === target.provider && agent.model?.modelId === target.modelId) return;
	await chat.conversation.configure({ model: target }, CTX);
	rememberLevel(chat.internalId, target0);
	console.log(
		`[agent] 会话 ${chat.internalId} 档位 → ${target0}（${target.provider}/${target.modelId}）`,
	);
}

/** `Conversation.compact()` 受理即返回的 taskId（durable 内部自增整数，可 JSON 下发）。 */
export type CompactTaskId = Awaited<ReturnType<Conversation["compact"]>>;

/**
 * 压缩模型「配了但没生效」只记一次（2026-11-10 批 26b §一）。
 *
 * 内核 `Conversation.compact(instructions, context)` **不收模型参数**，压缩模型由当前
 * 会话模型与 compaction policy 决定 —— 这里没有可以接 `AUX_MODEL_COMPACT` 的入口。
 * 但配置不能静默失效：只要配了 `AUX_MODEL_COMPACT`（且 `AUX_LLM` 总开关开着），
 * 就明确记一条日志说清"内核不支持、没生效"，不要让人以为 pin 生效了。
 *
 * 只记一次：`startChatCompaction` 每次手动压缩都会调用，模块级标记防刷屏；日志只含
 * 用途枚举与变量名，不含对话内容。
 */
let compactModelIgnoredWarned = false;
function warnCompactModelIgnored(env: NodeJS.ProcessEnv = process.env): void {
	if (compactModelIgnoredWarned) return;
	if (!auxiliaryEnabled(env)) return;
	if (!auxPinnedModelId("compact", env)) return;
	compactModelIgnoredWarned = true;
	console.warn("[aux] 当前内核不支持指定压缩模型，AUX_MODEL_COMPACT 未生效");
}

/**
 * 手动压缩（扫尾批 1 B1）：把内核本来就有的 `Conversation.compact` 接成一个端点。
 * 它本就是「受理即返回」——压缩在后台做、在空闲/边界落摘要，与方案 §二一致。
 *
 * 2026-11-10 批 26b §一：`AUX_MODEL_COMPACT` 配了也没法接（内核不收模型），这里只补
 * 一条"未生效"日志；压缩调用本身逐字节不变，仍走 `compact(instructions, CTX)`。
 */
export async function startChatCompaction(
	chat: ResolvedChat,
	instructions?: string,
): Promise<CompactTaskId> {
	warnCompactModelIgnored();
	return chat.conversation.compact(instructions, CTX);
}

/**
 * `?wait=1`：等这次压缩任务的终局，最多 timeoutMs。
 * 超时不算失败——受理仍然有效，客户端可走 SSE / 刷新看结果；所以超时只回 false。
 * `waitForTask` 用 BACKGROUND_CONTEXT（不带 AbortSignal），兑现与否都挂了 catch，
 * 不会留未处理的 rejection；真正的上限交给外层 AGENT_COMPACT_WAIT_MS 的 race。
 */
export async function waitChatCompaction(
	taskId: CompactTaskId,
	timeoutMs: number,
): Promise<boolean> {
	const harness = await getHarness();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
	});
	try {
		return await Promise.race([
			harness.waitForTask(taskId, CTX).then(
				() => true,
				() => true,
			),
			timeout,
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * 会话当前的档位（从 durable 里的模型引用读，重启后照样准）。
 * 没跑过的新会话返回 null；更早的会话可能没有 `#think-` 后缀，也返回 null。
 */
export async function conversationThinkingLevel(chat: ResolvedChat): Promise<ThinkingLevel | null> {
	const agent = await chat.conversation.agent(CTX).catch(() => null);
	return agent?.model ? levelFromModelId(agent.model.modelId) : null;
}

/**
 * 把会话配成**任务会话**（2026-10-30，模板上移）。
 *
 * 三件事，缺一件输出就跑偏：
 * 1. `instructions` = 服务端渲染好的任务模板。它是 system 段（排在扩展段之后），
 *    durable 会持久化它 —— 进程重启后任务会话照样拿着同一份 prompt；
 * 2. `extensions.remove` 摘掉我们自己的扩展：任务不需要人格、不该注入记忆
 *    （收敛把记忆当事实写进草稿是真出过的事故，见日记收敛与记忆 §4），也不需要提醒工具；
 * 3. `tools: []` 关掉 pi 自带的读写改跑：任务只产出文本，让它能改文件是纯粹的意外来源。
 *
 * `model` 传派生模型引用（带 temperature / max_tokens / response_format），
 * 不传就沿用会话原档（快档）。
 */
export async function configureTaskChat(
	chat: ResolvedChat,
	prompt: string,
	model?: { provider: string; modelId: string },
): Promise<void> {
	await chat.conversation.configure(
		{
			instructions: prompt,
			tools: [],
			...(lifediaryExt ? { extensions: { remove: [lifediaryExt] } } : {}),
			...(model ? { model } : {}),
		},
		CTX,
	);
}

/**
 * 课题研究专线的会话配置（2026-11-07 长期课题跟进 §四.4）。
 *
 * 工具面收敛走**白名单**：只给 `read`（CodingTools）与 `web_search`（lifediary-research 扩展）。
 * 摘掉 `lifediaryExt` 后，write / edit / bash / delegate / skill / partner_* 一个都不在
 * agent.tools 里——不是"靠 hook 事后拦"，而是模型根本看不到它们。
 * 研究回合因此也不带人格、技能索引与课题 section（简报不会被研究轮误标已推送）。
 */
export async function configureResearchChat(
	chat: ResolvedChat,
	prompt: string,
): Promise<void> {
	const tools = [
		...(CodingTools.tools ?? []).filter((tool) => tool.name === "read"),
		...(researchExt?.tools ?? []),
	];
	await chat.conversation.configure(
		{
			instructions: prompt,
			tools,
			...(lifediaryExt ? { extensions: { remove: [lifediaryExt] } } : {}),
		},
		CTX,
	);
}

/**
 * 证据裁判会话的配置（2026-11-10 批 14）。
 *
 * 与 `configureResearchChat` 同一形态：工具面由调用方给**白名单**（只有 `read` 与
 * 只读 bash），摘掉 `lifediaryExt` 后 write / edit / delegate / skill / partner_*
 * 根本不在 agent.tools 里——不是"靠 hook 事后拦"，是模型看不到。
 *
 * `cwd` 指向**合并后的项目根**：裁判读到的必须是落盘事实，不是某个 worker 的工作副本。
 */
export async function configureJudgeChat(
	chat: ResolvedChat,
	prompt: string,
	tools: readonly ToolRegistration[],
	cwd?: string,
): Promise<void> {
	await chat.conversation.configure(
		{
			instructions: prompt,
			tools,
			...(lifediaryExt ? { extensions: { remove: [lifediaryExt] } } : {}),
			...(cwd ? { cwd } : {}),
		},
		CTX,
	);
}

/**
 * 运行时切模型后的会话对齐（2026-11-04，接口文档 §2.8）。
 *
 * durable 的会话存的是**模型引用**；设置页切换改的是全局默认（provider.ts 的覆盖值）。
 * 新建会话自然用新模型；已有会话在每轮开跑前对一次，还停在旧模型上就重配过去。
 * 思考档保持原样；当前档不在新模型支持域 → 落回支持域内 ≤ 当前档的最高档（`off` 兜底，
 * 2026-11-04 思考档位 D8）。机制同 D3 的思考切换。
 * 只挂在聊天流上：任务会话短命（跑完即弃），不值得追。
 */
async function syncConversationModel(
	conversation: Conversation,
	internalId: number,
): Promise<void> {
	const config = readLlmConfig();
	if (!config || isFaux()) return;
	const current = await conversation
		.agent(CTX)
		.then((agent) => agent.model ?? null)
		.catch(() => null);
	// 档位来源：引用里的后缀（含旧 `#think-on` = high）> 进程内粘性 > 默认 off
	const previous =
		(current ? levelFromModelId(current.modelId) : null) ??
		stickyThinkingLevel(internalId) ??
		"off";
	const level = clampThinkingLevel(previous, currentThinkingLevels());
	try {
		// 已经是当前供应商 + 当前模型：不用动。只比 modelId 会把
		// "同名模型换供应商"当成没变，切换就成了空操作（审查 S1）
		if (current?.provider === config.model.provider && current.modelId.split("#")[0] === config.model.modelId) {
			return;
		}
		const target = chatModelRef(level);
		if (current?.provider === target.provider && current?.modelId === target.modelId) return;
		await conversation.configure({ model: target }, CTX);
		if (level !== previous) {
			console.log(
				`[model] 会话 ${internalId} 的档位 ${previous} 不在新模型支持域，落回 ${level}`,
			);
		}
		console.log(
			`[model] 会话 ${internalId} 对齐到 ${config.model.provider}/${config.model.modelId}（档位 ${level}）`,
		);
	} catch (error) {
		// 旧会话引用的供应商可能已被删：**真回退默认供应商**，不能继续拿旧引用打 404（审查 S4）
		console.warn(
			`[model] 会话 ${internalId} 对齐失败，回退默认供应商: ${error instanceof Error ? error.message : String(error)}`,
		);
		try {
			const fallback = {
				provider: config.model.provider,
				modelId: config.model.modelId,
			};
			await conversation.configure({ model: fallback }, CTX);
			console.log(`[model] 会话 ${internalId} 已回退到 ${fallback.provider}/${fallback.modelId}`);
		} catch (fallbackError) {
			console.warn(
				`[model] 会话 ${internalId} 回退默认供应商也失败: ${
					fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
				}`,
			);
		}
	}
}

/**
 * 解析会话。`externalId` 为空表示新建。
 * 返回 null 表示"这个 id 我没发过" —— 调用方据此回 404，而不是偷偷建一个新的。
 *
 * `kind`（2026-11-06 侧栏调整 B2）：只对**新建**有意义，落进 ChatKinds doc，
 * 与对外 id 映射在同一个 init 事务里写（不会出现"会话建好了但身份没记上"）。
 * 缺省 = `chief`：手机与旧调用方不带这个参数，行为与改动前一致。
 */
export async function openChat(
	externalId: string | undefined,
	modelRef?: { provider: string; modelId: string },
	kind?: NewChatKind,
): Promise<ResolvedChat | null> {
	const harness = await getHarness();
	const config = readLlmConfig();
	if (!config) return null;

	if (!externalId) {
		const id = crypto.randomUUID();
		const chatKind: NewChatKind = kind ?? "chief";
		// 项目归属只记普通会话（2026-11-12 归档模块 §5）：执事 / 群 / 任务会话不该被
		// "项目归档"连带。当前项目每轮现读；项目库坏了只旁路归属，绝不让建会话失败。
		let projectId: string | null = null;
		if (chatKind === "worker") {
			try {
				projectId = projectsStore().getCurrentProject()?.id ?? null;
			} catch {
				projectId = null;
			}
		}
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				// 新会话默认思考关（2026-10-31 方案 D2：聊天一律不思考，首字 0.8~0.9s）
				agent: { model: modelRef ?? chatModelRef("off") },
				// 建会话、写映射、记种类（以及普通会话的项目归属）在同一个提交里，
				// 要么都在要么都不在
				init: async (tx, conversationId) => {
					const chats = await tx.doc(Chats);
					chats.byExternal[id] = Number(conversationId);
					const kinds = await tx.doc(ChatKinds);
					kinds.byInternal[String(conversationId)] = chatKind;
					if (projectId) {
						const chatProjects = await tx.doc(ChatProjects);
						chatProjects.byInternal[String(conversationId)] = projectId;
					}
				},
			},
			CTX,
		);
		return { conversation, externalId: id, internalId: Number(conversation.id) };
	}

	const chats = await harness.snapshot(Chats, CTX);
	const internalId = chats?.byExternal?.[externalId];
	if (internalId === undefined) return null;

	const conversation = await harness.conversation(internalId as never, CTX);
	if (!conversation) return null;
	// `task-` 前缀会话登记（2026-11-10 批 13 §一）：无人值守判定是同步的，
	// external→internal 的 durable 映射是异步的，打开时顺手记一笔。
	if (externalId.startsWith(TASK_CONVERSATION_PREFIX)) markTaskSession(Number(internalId));
	return { conversation, externalId, internalId };
}

/**
 * 有就打开，没有就用这个 id 新建。
 *
 * 只给 OpenAI 兼容端点用：那边的会话 id 是从首条用户消息哈希出来的，
 * 客户端从没收到过服务端发 id，所以只能"第一次自动建"。
 * `/api/v1/agent/chat` 不走这条，它必须严格要求 id 是发出去的。
 */
export async function openOrCreateChat(
	externalId: string,
	modelRef?: { provider: string; modelId: string },
): Promise<ResolvedChat> {
	const existing = await openChat(externalId);
	if (existing) return existing;

	const harness = await getHarness();
	const config = readLlmConfig();
	if (!config) throw new Error("LLM 未配置");

	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: modelRef ?? chatModelRef("off") },
			init: async (tx, conversationId) => {
				const chats = await tx.doc(Chats);
				chats.byExternal[externalId] = Number(conversationId);
			},
		},
		CTX,
	);
	const internalId = Number(conversation.id);
	if (externalId.startsWith(TASK_CONVERSATION_PREFIX)) markTaskSession(internalId);
	return { conversation, externalId, internalId };
}

/**
 * 内部 id → 对外 uuid（2026-11-04 批次六）。
 *
 * 审批 store 的 key 是 durable 内部自增 id，全局待办要对外只能给 uuid。
 * `Chats.byExternal` 是 external→internal，这里只反向读一次快照，不逐会话 openChat。
 */
export async function externalChatIds(): Promise<Map<number, string>> {
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const map = new Map<number, string>();
	for (const [externalId, internalId] of Object.entries(chats?.byExternal ?? {})) {
		const id = Number(internalId);
		if (Number.isFinite(id)) map.set(id, externalId);
	}
	return map;
}

/**
 * 会话种类（2026-11-06 侧栏调整 B2，历史 / 列表响应用）。
 *
 * 顺序即语义：**执事链接优先**（partner 由服务端链接表判定，客户端不能自报）；
 * 其次 ChatKinds 记录；没有记录 = 本次改动前建的旧会话 = `chief`。
 */
export async function chatKindOf(chat: ResolvedChat): Promise<ChatKind> {
	const harness = await getHarness();
	const kinds = await harness.snapshot(ChatKinds, CTX);
	return chatKindOfInternal(chat.internalId, kinds?.byInternal ?? {});
}

/**
 * 列表批量版：种类表只读一次，不逐会话打开（listChats 的代价口径不变）。
 * 2026-11-13 起导出：自动归档与永久删除的"只收普通会话"判定用同一份（别再抄一份漂移）。
 */
export function chatKindOfInternal(
	internalId: number,
	byInternal: Record<string, "chief" | "worker">,
): ChatKind {
	if (COMPANIONS_ENABLED) {
		try {
			if (partnersStore().partnerIdOfSession(internalId)) return "partner";
		} catch {
			/* 同上 */
		}
	}
	return byInternal[String(internalId)] === "worker" ? "worker" : "chief";
}

/**
 * 编辑重发的前一半：校验 + 分叉（2026-11-08 扫尾批 4a，方案 §二）。
 *
 * 语义决策（照方案）：内核 append-only、没有 truncate/edit，所以"改一句重说" =
 * **fork 到那条消息之前 + 在新会话里提交新文本**。老会话完整保留（列表里会多一条
 * 分叉前的旧会话，是方案登记的已知边界）。
 *
 * fork 的 `at` 是**包含**该条目的（durable 的父链上界是 `id <= at`），所以这里传的是
 * 目标条目的**前一条**；编辑会话的第一条时没有"之前"可分叉，按同样的落地形态
 * （同模型、同种类）开一个空会话。
 *
 * 这里只分叉、不提交：提交由路由复用 `chatStream` 主链路（SSE/用量/记忆一套行为），
 * 这样 onSettled 的记忆抽取不会出现两份实现。
 */
export async function forkForEdit(
	chat: ResolvedChat,
	messageId: string,
): Promise<
	| { ok: true; chat: ResolvedChat }
	| { ok: false; status: 400 | 409; error: string; message: string }
> {
	// 会话在跑：与插话同口径（409），不排队——编辑的语义是"替换那一句"，排队会分叉两次
	if (await conversationIsBusy(chat.conversation)) {
		return {
			ok: false,
			status: 409,
			error: "conversation_busy",
			message: "这一轮还在跑，等它结束再改",
		};
	}

	const view = await chat.conversation.context(CTX);
	const index = view.entries.findIndex(
		(entry) =>
			entry.kind === "pi.user" &&
			messageIdOf(chat.externalId, Number(entry.id)) === messageId,
	);
	if (index < 0) {
		return {
			ok: false,
			status: 400,
			error: "message_not_found",
			message: "这条消息不在这个会话里，或不是用户消息",
		};
	}

	const harness = await getHarness();
	const externalId = crypto.randomUUID();
	const kind = await chatKindOf(chat);
	const previous = index > 0 ? view.entries[index - 1] : undefined;
	// 编辑分叉也是"在这个项目下新建的会话"：继承原会话的创建时归属，
	// 否则项目归档时这条分叉会漏在活跃列表里（2026-11-12 归档模块 §5）。
	const sourceProjectId =
		kind === "worker"
			? (await harness.snapshot(ChatProjects, CTX))?.byInternal?.[String(chat.internalId)]
			: undefined;

	// 新会话的两张表：对外 uuid ↔ 内部 id、内部 id → 种类。与 openChat 的新建分支同口径，
	// 写在 fork 的同一个事务里（不会出现"会话建好了但列表里找不到"）。
	const init = async (tx: Tx, conversationId: number) => {
		const chats = await tx.doc(Chats);
		chats.byExternal[externalId] = Number(conversationId);
		const kinds = await tx.doc(ChatKinds);
		kinds.byInternal[String(conversationId)] = kind === "worker" ? "worker" : "chief";
		if (sourceProjectId) {
			const chatProjects = await tx.doc(ChatProjects);
			chatProjects.byInternal[String(conversationId)] = sourceProjectId;
		}
	};

	const conversation = previous
		? await chat.conversation.fork(
				previous.id,
				{ ownership: { kind: "ownerless" }, init },
				CTX,
			)
		: await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					// 同模型（含思考档变体）：新会话不是"回到默认模型"，而是"这句话换个说法"
					agent: { model: (await chat.conversation.agent(CTX)).model },
					init,
				},
				CTX,
			);

	return {
		ok: true,
		chat: { conversation, externalId, internalId: Number(conversation.id) },
	};
}

// ── 对话流 ───────────────────────────────────────────────
/**
 * 流里除了文本，还会有"这一轮没给出回答"的通知。
 * 现在只有一种：工具调用撞上限。以后要是加别的终止原因，往这里加成员。
 */
export type ChatStreamEvent =
	| { type: "delta"; text: string }
	/**
	 * 思考正文增量（2026-11-04 批次一）。
	 *
	 * `progress.phase=thinking` 只说"在想"，这个给"想了什么"：deep 档模型的
	 * thinking 块随生成流出，原样增量透传。快档不发这个事件。
	 */
	| { type: "thinking"; text: string }
	/**
	 * 这一轮此刻在干什么（2026-10-29）。
	 *
	 * 存在的理由：工具回合可能几十秒没有任何 token，客户端只看到"空白"，
	 * 用户不知道是卡死了还是在干活。这里把"思考 / 动手"这一层状态单独告诉客户端，
	 * 让它能显示"正在思考…"「正在读文件…」而不是干等。
	 */
	| { type: "progress"; phase: TurnPhase }
	/**
	 * 一次工具调用（2026-11-03）。
	 *
	 * 为什么 progress 不够：它只会说"在动手"，说不出动的是哪只手。
	 * 「正在读 agent.ts」和「正在跑 pnpm test」在界面上是两回事，出错时也完全
	 * 不同地处置。start / end 成对出现，中间可能夹着别的工具，客户端按 name 归并。
	 */
	| {
			type: "tool";
			name: string;
			status: "start" | "end";
			label?: string;
			ok?: boolean;
			/** 工具吐出来的文字（截断过），只在 end 上有 */
			output?: string;
			/** 调用参数（JSON，截断过），只在 start 上有 */
			args?: string;
			/** 编辑类工具的 unified diff（批 33，截断过），只在 end 上有；与历史 steps 同口径 */
			diff?: string;
	  }
	/**
	 * 派活的进度（2026-11-02；2026-11-03 补任务单字段）。
	 *
	 * 存在的理由跟 progress 一样：派活可能跑几分钟，客户端只看到空白。
	 * 但 progress 只有"在想/在动手"，说不出"第 2 件 / 共 3 件 / 写测试"。
	 *
	 * `ticketId` / `domain` / `phase` 是 2026-11-03 加的：前端要靠它们把多张单
	 * 分开归并、显示领域和阶段；没有单号时事件根本发不出来（见 `startDelegation`）。
	 */
	| {
			type: "delegate";
			ticketId: string;
			domain: string;
			phase: DelegationPhase;
			done: number;
			total: number;
			current: string;
			message?: string;
			project?: string;
			lastAction?: string;
			lastHeartbeat?: string;
			waitingOn?: string;
	  }
	/**
	 * 需要人回答（2026-11-02）。
	 *
	 * 一句话：「它在等你什么」。客户端据此出卡片，而不是让用户从结论那句里猜。
	 */
	| {
			type: "attention";
			ticketId: string;
			domain: string;
			kind: "need_input" | "need_decision" | "need_action";
			question: string;
	  }
	/**
	 * 写类工具要人确认（2026-11-04 批次二）。
	 *
	 * 与 attention 的分工：那个是任务单的问题，这个是权限确认；答复走 HTTP 审批端点，
	 * 不占用对话输入。`args` 已按 tool 事件口径截断。
	 */
	| {
			type: "approval";
			callId: string;
			tool: string;
			args: string;
			deadlineAt: string;
			/** 自主轮标记（批次C C2）：例行轮的审批卡；对外契约见 shared ChatEvent（纯增量） */
			origin?: "autonomous";
	  }
	| { type: "turnLimit"; message: string }
	/**
	 * 这一轮跑完了但没有回答（模型报错、被策略拦下等）。
	 *
	 * 必须显式吐出来：否则客户端只看到"空内容 + 正常结束"，等于给用户一个空气泡，
	 * 而且分不清是"模型没话说"还是"上游挂了"（实测：key 无效时就是这样）。
	 */
	| {
			type: "unanswered";
			message: string;
			/** 错误类别与脱敏摘要（2026-11-10 批 32）；index.ts 把它们透成 error 帧的 code/detail */
			code?: StreamErrorCode;
			detail?: string;
	  }
	/**
	 * 系统提示行（2026-11-07 消息即引导）。
	 *
	 * 只用于"这件事发生了变化但你不需要看模型说话"的时刻：插话请求落了队列、
	 * 补充已受理等。对外复用已有 `notice` 帧（群聊在用），不新增 SSE 类型。
	 * `steer` 是机器可读的插话落点（shared 契约），客户端据此决定要不要回读。
	 */
	| { type: "notice"; text: string; steer?: "inserted" | "new-turn" }
	/**
	 * 本轮 token 用量（2026-11-04 批次一）。**内部事件**：index.ts 捕获后挂到
	 * `done.usage` 上，不单独对外发帧——对外契约只加字段，不加类型。
	 */
	| { type: "usage"; usage: TurnUsage };

export interface ChatStreamInput {
	conversation: Conversation;
	text: string;
	/**
	 * 带图消息的分段（2026-11-08 扫尾批 4a）。有值就提交 parts（内核原生收
	 * `string | (TextContent|ImageContent)[]`），没有就仍提交 `text` 字符串。
	 * `text` 始终是"纯文本口径"，给记忆抽取、日志与回读用。
	 */
	parts?: OutgoingPart[];
	/** 客户端重试时带同一个 requestId，就不会重复扣 token、重复写记忆 */
	requestId?: string;
	/**
	 * 这一轮**真正结束**时回调（不是"这条连接结束"）。
	 *
	 * 关键区别：客户端关掉界面 / 断网，只是没人看这条流了，
	 * 那一轮还在服务端跑；它跑完才该触发记忆抽取、才该算数。
	 * 挂在这个回调上，就不会因为"用户关了个窗口"而漏记一轮对话。
	 *
	 * 第二个参数是**懒读取**：本轮最终 assistant 文本（2026-11-09 persona 接入批二）。
	 * 传函数而不是值，是为了让默认关闭的导出开关不产生额外 durable 读。
	 */
	onSettled?: (record: SettledSubmissionRecord, replyText?: () => Promise<string>) => void;
	/**
	 * 忙时投递方式（2026-11-07 消息即引导）：透传给内核的 `whenBusy`。
	 * 缺省 `followUp` = 改动前的排队行为。
	 */
	whenBusy?: "steer" | "followUp";
}

/**
 * 这个会话此刻有没有在跑的一轮（2026-11-07 消息即引导）。
 *
 * 只读 `pi.live.run`：它是内核"有一轮正在进行"的自有状态（不是我们自己记的布尔）。
 * 读不到就按空闲处理——插话在空闲时会自然变成普通输入，语义仍然正确。
 */
export async function conversationIsBusy(conversation: Conversation): Promise<boolean> {
	try {
		const harness = await getHarness();
		const live = await harness.snapshot(LiveDoc, conversation.id, CTX);
		return Boolean(live?.run);
	} catch {
		return false;
	}
}

/**
 * 把一轮对话变成一段文本流。
 *
 * 数据源是 `watch()`：durable 把"正在生成的那半句话"作为已提交状态的一部分发布出来。
 *
 * 这里**故意不接客户端的中断信号**。以前的写法是"socket 一断就 abort()"，
 * 那是把"传输断了"翻译成"用户要取消"，于是一个跑了一半的工具调用会被掐掉。
 * durable 的语义本来是对的（取消等待 ≠ 取消工作），是我们多接了一根线。
 *
 * 真要停，走 `stopChat()`：那是人的明确意图，不是 socket 的副作用。
 */
export async function* chatStream(
	input: ChatStreamInput,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
	const watch = await input.conversation.watch(CTX);

	const queue: string[] = [];
	/** 待推送的思考增量（2026-11-04 批次一） */
	const thinkings: string[] = [];
	/** 待推送的阶段变化（工具钩子写进来，本流取出去） */
	const phases: TurnPhase[] = [];
	/** 待推送的派活事件（delegate 工具写进来，本流取出去） */
	const delegations: DelegationEvent[] = [];
	let emitted = "";
	let emittedThinking = "";
	/**
	 * 当前生成段的代号（2026-11-07 消息即引导）。
	 *
	 * 工具轮之后内核会起**新的一段**生成；新段的文本不是旧段的前缀，`offer` 会
	 * 直接把它挡掉（第二段永远发不出去）。所以按段重置基线，段与段之间补一条分隔线。
	 * 同一段内的重试（attempt 变化）**不重置**：重试是从头再生成同一段，仍按增量发。
	 */
	let emittedSegment: string | null = null;
	let wake: (() => void) | null = null;

	const notify = () => {
		const resume = wake;
		wake = null;
		resume?.();
	};

	/** 只在"新文本是在旧文本后面续上"时才吐增量，避免重试/回退导致重复输出 */
	const offer = (candidate: string) => {
		if (!candidate || candidate.length <= emitted.length) return;
		if (!candidate.startsWith(emitted)) return;
		queue.push(candidate.slice(emitted.length));
		emitted = candidate;
		notify();
	};

	/** 思考增量同款守卫；thinking 不在尾部补齐，流中能推多少推多少 */
	const offerThinking = (candidate: string) => {
		if (!candidate || candidate.length <= emittedThinking.length) return;
		if (!candidate.startsWith(emittedThinking)) return;
		thinkings.push(candidate.slice(emittedThinking.length));
		emittedThinking = candidate;
		notify();
	};

	const partialOf = (value: ConversationView): string => {
		const live = value.docs["pi.live"] as LiveState | undefined;
		const message = live?.generation?.message as { content?: unknown } | undefined;
		if (!message?.content) return "";
		return contentText(message.content as Parameters<typeof contentText>[0]);
	};

	/** 当前生成段的代号；没有正在生成的一段时返回 null。 */
	const segmentOf = (value: ConversationView): string | null => {
		const live = value.docs["pi.live"] as LiveState | undefined;
		if (!live?.generation) return null;
		return live.run?.taskId !== undefined ? String(live.run.taskId) : null;
	};

	/**
	 * 段切换时清空增量基线（2026-11-07）。
	 *
	 * 只在"之前已经发过正文、现在进了另一段"时插入分隔与重置；首段不插分隔。
	 * 不重置会怎样：工具轮后的第二段 `startsWith(emitted)` 恒假，整段静默丢失。
	 */
	const rollSegment = (value: ConversationView): void => {
		const segment = segmentOf(value);
		if (segment === null || segment === emittedSegment) return;
		const first = emittedSegment === null;
		emittedSegment = segment;
		if (first || emitted.length === 0) return;
		// 段与段之间空一行：客户端把它们拼成同一轮的正文，不能让两段糊在一起
		queue.push("\n\n");
		emitted = "";
		emittedThinking = "";
		notify();
	};

	/** 生成中的 thinking 块正文（2026-11-04 批次一；pi-ai 的块形状是 {type:"thinking", thinking}） */
	const thinkingOf = (value: ConversationView): string => {
		const live = value.docs["pi.live"] as LiveState | undefined;
		const message = live?.generation?.message as { content?: unknown } | undefined;
		if (!message?.content) return "";
		const parts: string[] = [];
		for (const block of message.content as Array<{ type?: string; thinking?: string }>) {
			if (block && block.type === "thinking" && typeof block.thinking === "string") {
				parts.push(block.thinking);
			}
		}
		return parts.join("");
	};

	// 用对象包着：闭包里赋值，TS 的收窄判断看不到
	const outcome: { record?: SettledSubmissionRecord; error?: Error } = {};
	let finished = false;
	// 这一轮开始前记一次；跑完对比，就知道期间有没有撞工具上限
	const conversationId = Number(input.conversation.id);
	const limitSeqBefore = limitHits.get(conversationId) ?? 0;
	// 订阅本会话的阶段变化：工具一开始执行就能立刻告诉客户端，不用等第一个 token
	const unwatchPhase = watchPhase(conversationId, (phase) => {
		phases.push(phase);
		notify();
	});
	const unwatchDelegation = watchDelegation(conversationId, (event) => {
		delegations.push(event);
		notify();
	});
	/**
	 * 执事间递话的主人通知（2026-11-08 扫尾批 8d）。
	 *
	 * 只有**主人的对话**订阅（`chatKindOfInternal === "chief"`）：执事自己那条流
	 * 已经在工具卡里看到"我递了话"，再弹一条只会让人以为收到了别人的话。
	 * 与派单进度同款——进程内轻事件，没开流就收不到、不落盘（不伪造主人的时间线）。
	 */
	const relayNotices: string[] = [];
	const kindsForNotice = COMPANIONS_ENABLED
		? await getHarness()
				.then((harness) => harness.snapshot(ChatKinds, CTX))
				.catch(() => null)
		: null;
	const unwatchRelayNotice =
		COMPANIONS_ENABLED &&
		chatKindOfInternal(conversationId, kindsForNotice?.byInternal ?? {}) === "chief"
			? watchChiefNotice((text) => {
					relayNotices.push(text);
					notify();
				})
			: () => {};
	/**
	 * 两态回执（2026-11-10 批 15 §五）：对方跑完后，settled 一句回流到**发送方
	 * 正在流式的会话**。与主人通知口同款：没开流就收不到、不落盘；持久那一份
	 * 在发送方 transcript 里（lifecycle 写 `pi.assistant` 留言条目）。
	 */
	const unwatchRelayReceipt = COMPANIONS_ENABLED
		? watchRelayReceipt(conversationId, (text) => {
				relayNotices.push(text);
				notify();
			})
		: () => {};
	/** 待推送的工具起止 */
	const tools: ToolEvent[] = [];
	const unwatchTool = watchTool(conversationId, (event) => {
		tools.push(event);
		notify();
	});

	try {
		// 运行时切模型后，还停在旧模型上的会话在这轮开跑前对齐过去（接口文档 §2.8）
		await syncConversationModel(input.conversation, conversationId);
		watch.start(async (value) => {
			rollSegment(value);
			offer(partialOf(value));
			offerThinking(thinkingOf(value));
		});
		rollSegment(watch.value);
		offer(partialOf(watch.value));
		offerThinking(thinkingOf(watch.value));

		// 提交前先看这轮是不是真的在跑：插话只对"正在跑的这一轮"有意义
		const busyBeforeSubmit = await conversationIsBusy(input.conversation);

		const submission = await input.conversation.submit(
			// 产品承诺（2026-11-09 T2 §5）：人的消息永远插得上话——忙时 followUp
			// 排队到本轮收尾，不拒、不丢。缺省值写死在 userInputSubmission，不靠内核默认。
			userInputSubmission(input),
			CTX,
		);

		// 回执诚实（2026-11-07）：请求插话不等于"已经插进去了"。内核的语义是
		// "在下一次边界消费"——本轮还有工具轮就落在 postTools，已经收尾就等价于下一轮。
		// 所以只承诺"会在这轮的下一个边界生效"，不承诺"模型马上看到了"。
		//
		// 空闲时提交的 steer 不只是一个"没插进去"的降级：它会成为**新的一轮**，
		// 而调用方（插话那条短连接）按约定只收回执、不画正文。所以这里必须说清
		// "这句话已经开了新一轮"，否则用户会以为它被吞了。
		if (input.whenBusy === "steer") {
			yield {
				type: "notice",
				text: busyBeforeSubmit
					? "补充已作为插话发出：这一轮的下一个边界会带上它；没赶上就是下一轮的第一句。"
					: "这一轮刚好收尾，这句补充已经作为新的一轮开始。",
				// 机器可读落点（2026-11-07 补）：`new-turn` 时这条短连接是新一轮正文的
				// 唯一来源，而它按约定只收回执——客户端要靠这个标记安排收尾后的回读，
				// 不能靠猜文案（那是给人看的，不是给程序看的）。
				steer: busyBeforeSubmit ? "inserted" : "new-turn",
			};
		}

		void submission
			.wait(CTX)
			.then((record) => {
				outcome.record = record;
				// 这一轮尘埃落定：即便上面的流早被客户端关掉了，这里照样会跑
				try {
					// 本轮最终回复用懒读取给 settle 回调（persona 导出用；不调 = 不读）
					input.onSettled?.(record, () => answerText(input.conversation));
				} catch (error) {
					console.warn(
						`[agent] onSettled 回调失败: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				// 每轮的 usage/cacheRead 验收数据（方案 §6 步骤 1 / §7）
				void logTurnUsage(input.conversation, conversationId);
			})
			.catch((error: unknown) => {
				outcome.error = error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				finished = true;
				notify();
			});

		while (
			!finished ||
			queue.length > 0 ||
			thinkings.length > 0 ||
			phases.length > 0 ||
			delegations.length > 0 ||
			relayNotices.length > 0 ||
			tools.length > 0
		) {
			if (queue.length === 0 && thinkings.length === 0) {
				const tool = tools.shift();
				if (tool) {
					yield {
						type: "tool",
						name: tool.name,
						status: tool.status,
						label: tool.label,
						ok: tool.ok,
						output: tool.output,
						args: tool.args,
						// 编辑类工具的 diff（批 33）：现场与历史 steps 同一份事实
						diff: tool.diff,
					};
					continue;
				}
				const delegation = delegations.shift();
				if (delegation) {
					// 按 type 分发：approval 借这条通道，形状和 attention 不同（三元会把它发成空单号）
					if (delegation.type === "delegate") {
						yield {
							type: "delegate",
							ticketId: delegation.ticketId,
							domain: delegation.domain,
							phase: delegation.phase,
							done: delegation.done,
							total: delegation.total,
							current: delegation.current,
							message: delegation.message,
							project: delegation.project,
							lastAction: delegation.lastAction,
							lastHeartbeat: delegation.lastHeartbeat,
							waitingOn: delegation.waitingOn,
						};
					} else if (delegation.type === "attention") {
						yield {
							type: "attention",
							ticketId: delegation.ticketId,
							domain: delegation.domain,
							kind: delegation.kind,
							question: delegation.question,
						};
					} else if (delegation.type === "notice") {
						// agent 中途播报（2026-11-10 批 13 §三）：只送到当前这条流，
						// 没开流就收不到、不落盘（不伪造主人的时间线）。
						yield { type: "notice", text: delegation.text };
					} else {
						yield {
							type: "approval",
							callId: delegation.callId,
							tool: delegation.tool,
							args: delegation.args,
							deadlineAt: delegation.deadlineAt,
						};
					}
					continue;
				}
				const phase = phases.shift();
				if (phase) {
					yield { type: "progress", phase };
					continue;
				}
				// 执事间递话：主人时间线上的"谁 → 谁递了一条"（正文不在这里）
				const relayNotice = relayNotices.shift();
				if (relayNotice) {
					yield { type: "notice", text: relayNotice };
					continue;
				}
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			const thinkDelta = thinkings.shift();
			if (thinkDelta) yield { type: "thinking", text: thinkDelta };
			const delta = queue.shift();
			if (delta) yield { type: "delta", text: delta };
		}

		if (outcome.error) throw outcome.error;

		// 收尾：流式增量可能停在半句（节流或直接给了完整 answer），把尾巴补齐
		if (outcome.record?.status === "done") {
			offer(await answerText(input.conversation));
			while (queue.length > 0) {
				const delta = queue.shift();
				if (delta) yield { type: "delta", text: delta };
			}
		} else if (outcome.record?.status === "unanswered") {
			// 完整原文只进日志：里面可能带上游地址甚至 key 片段
			console.warn(
				`[agent] 本轮未回答: ${outcome.record.reason} ${JSON.stringify(outcome.record.detail ?? null)}`,
			);
			// 分类 + 脱敏后给用户一句话（批 32）：aborted/reset 返回 null——
			// 人自己停的前端已有「已中断生成」，再发错误帧就是报二遍。
			const described = describeStreamError(outcome.record.reason, outcome.record.detail);
			if (described) {
				yield {
					type: "unanswered",
					message: described.message,
					code: described.code,
					detail: described.detail,
				};
			}
		}

		// 撞了工具上限：不管模型最后有没有收尾，这句提示都由我们补，
		// 保证用户看到的措辞跟配置一致，而不是模型自己发挥的版本。
		if ((limitHits.get(conversationId) ?? 0) > limitSeqBefore) {
			yield { type: "turnLimit", message: TURN_LIMIT_MESSAGE };
		}

		// 本轮 token 用量（内部事件；index.ts 捕获后挂到 done.usage）。读不到就算了
		const usage = await readLastTurnUsage(input.conversation);
		if (usage) yield { type: "usage", usage };
	} finally {
		unwatchPhase();
		unwatchDelegation();
		unwatchTool();
		unwatchRelayNotice();
		unwatchRelayReceipt();
		// 只关掉"看"这件事，不碰正在跑的那一轮
		await watch.stop().catch(() => undefined);
	}
}

/**
 * 手动停止当前这一轮。
 *
 * 跟"客户端断开"是两件事：这是人的明确意图，所以走 `abort()`，
 * 排队的输入会撤回、当前的任务会被撤销。之后再说一句话就是新一轮。
 */
export async function stopChat(chat: ResolvedChat): Promise<void> {
	// 先把挂着的审批按 aborted 结算：否则钩子里的 await 要等 abortSignal 才醒，
	// 客户端也还会看到一条永远批不掉的卡片（2026-11-04 批次二）
	approvalStore().expireAll(chat.internalId, "aborted");
	await chat.conversation.abort(CTX);
}

/**
 * 服务端主动给会话补一句话并**驱动它跑完**（2026-11-08 扫尾批 8c）。
 *
 * 审批答复后的续跑走这一条：把"已批准 / 已拒绝"作为一条用户消息提交进去，
 * 模型下一轮就会重发同一个调用（或改做别的），从而不需要人再说一句。
 *
 * 与 `sayInChat` 的区别：那是"以助手身份写一句、不调模型"；这里是一轮真对话。
 * 没有客户端看这条流，事件全部丢弃；会话正忙时内核按 followUp 排队到下一个边界。
 *
 * 2026-11-08 批 10-A：续跑轮挂上**与普通轮同一个** `turnSettledHandler`
 * （观察层 / 记忆抽取 / 会话记忆修剪），不再有"审批续跑不进记忆"的缺口。
 * 用的也是 `chatStream` 的 `onSettled`，不是另抄一份逻辑。
 */
export async function continueConversation(conversationId: number, text: string): Promise<void> {
	try {
		const harness = await getHarness();
		const conversation = await harness.conversation(conversationId as never, CTX);
		if (!conversation) {
			console.warn(`[agent] 会话 ${conversationId} 已不存在，跳过审批后的续跑`);
			return;
		}
		// 续跑这轮的用户侧只有这一句指令；对外 id 只用于任务专线过滤（读不到就当普通会话，
		// 绝不让一次映射读取失败把续跑本身拦掉）
		const externalId =
			(await externalChatIds().catch(() => new Map<number, string>())).get(conversationId) ?? "";
		for await (const _event of chatStream({
			conversation,
			text,
			onSettled: turnSettledHandler(
				{ internalId: conversationId, externalId },
				[{ role: "user", content: text }],
			),
		})) {
			// 没有客户端读这条流：事件只为驱动主链路，丢弃即可
		}
	} catch (error) {
		console.warn(
			`[agent] 会话 ${conversationId} 审批后续跑失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
	/** 消息时间，epoch 毫秒 */
	at: number;
	/**
	 * 可寻址 id（2026-11-08 扫尾批 4a）：只给 user 消息，编辑重发拿它指位置。
	 * uuid 形状、不含 durable 内部自增 id（见 {@link messageIdOf}）。
	 */
	id?: string;
	/** 用户消息带的图片（2026-11-08 扫尾批 4a）；文字仍走 `text` */
	images?: { mimeType: string; data: string }[];
	/** 这一轮的工作步骤（2026-11-07）；没有工具调用就不带 */
	steps?: TranscriptStep[];
	/** 那一轮从提问到收尾的墙钟时长（毫秒） */
	workMs?: number;
}

/**
 * 对外 messageId（2026-11-08 扫尾批 4a）。
 *
 * 为什么不直接下发 durable 的条目 id：硬约束是"对外 id 一律 uuid，内部自增整数不外泄"。
 * 这里用 `(会话对外 uuid, 条目 id)` 做 sha256 再切成 uuid 形状 —— 稳定、可反查
 * （读回条目时按同一函数重算），且离开会话 id 就没有意义。
 */
export function messageIdOf(externalId: string, entryId: number): string {
	const hex = createHash("sha256").update(`${externalId}:${entryId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 一步工作过程的截断上限：与 `tool` 事件的 `output` 同一口径（2000 字符）。
 * 现场看到多长，回头翻到就多长——两边不一致会让人怀疑历史被裁剪过。
 */
const STEP_OUTPUT_LIMIT = TOOL_OUTPUT_LIMIT;
/** 编辑类工具的 diff 单独给一档（比输出略短，面板里是一屏的事） */
const STEP_DIFF_LIMIT = 2000;

/** 与 toolOutput 同口径：先取文字、trim，再按上限截断并标注还剩多少 */
function clampText(text: string, limit: number): string | undefined {
	const one = text.trim();
	if (!one) return undefined;
	return one.length > limit
		? `${one.slice(0, limit)}\n…（还有 ${one.length - limit} 字符）`
		: one;
}

/**
 * 从 `tool-result` 的 details 里取编辑 diff（2026-11-07）。
 *
 * `edit` 工具把 `{ diff, patch, firstChangedLine }` 放在 details 里（读
 * `pi-durable` 的 `tools/edit.js` 确认），其它工具没有这个字段，所以这里
 * 只认 `diff`，不强求——读不到就当作"这一步没有差异可看"。
 */
function stepDiff(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const diff = (details as { diff?: unknown }).diff;
	return typeof diff === "string" ? clampText(diff, STEP_DIFF_LIMIT) : undefined;
}

/**
 * 读会话已有的对话记录。
 *
 * 存在的理由：一轮对话现在可以在**没有客户端看着**的情况下跑完（见 chatStream），
 * 所以客户端下次打开必须能把结果拉回来，否则"关掉界面它照样跑完"对用户没有意义。
 *
 * 2026-11-07 起连同**工作过程**一起回放：流式期间的 `tool` 事件只活在当轮 DOM 里，
 * 刷新就没了；而步骤本来就躺在 durable 里（`pi.assistant` 的 toolCall +
 * `pi.tool-result`），所以这里只是按调用顺序把它们配成对，不新增任何存储。
 *
 * 配对规则（与 durable 的落库顺序一一对应）：
 *   pi.user → [pi.assistant(带 toolCall) → pi.tool-result × n] × m → pi.assistant(正文)
 * 步骤挂在**它后面那条带正文的回答**上；一轮里没有工具调用，`steps` 字段就不下发。
 * 被中断、始终没等到回答的那一轮没有挂靠点，历史里不回放它的步骤（当轮界面上
 * 仍会显示"已中断生成"，只是不持久化——与那句提示自己的生命周期一致）。
 */
export async function readTranscript(
	chat: ResolvedChat,
	limit = 50,
): Promise<TranscriptMessage[]> {
	const view = await chat.conversation.context(CTX);
	const messages: TranscriptMessage[] = [];

	/** 本轮的步骤，按 toolCallId 索引；回答落盘时整段挂上去 */
	let pending: TranscriptStep[] = [];
	const byCallId = new Map<string, { step: TranscriptStep; settled: boolean }>();
	/** 助手条目里模型侧看到的正文；entries 的类型是 Message 联合，取用前要收窄 */
	/** 本轮提问的时间（算 workMs 用）；没有 user 开头就留 undefined */
	let turnStartAt: number | undefined;

	for (const entry of view.entries) {
		if (entry.kind === "pi.user") {
			// 新一轮：上一轮没等到回答的步骤没有挂靠点，直接丢掉（见函数头注释）
			pending = [];
			byCallId.clear();
			const message = entry.model?.[0];
			if (!message) continue;
			const text = contentText(message.content).trim();
			const at = typeof message.timestamp === "number" ? message.timestamp : 0;
			// 2026-11-08 4a：纯图消息没有文本，也要下发（老逻辑会把它整条丢掉）
			const parts = Array.isArray(message.content) ? message.content : [];
			const images = parts
				.filter(
					(part): part is { type: "image"; mimeType: string; data: string } =>
						part.type === "image",
				)
				.map((part) => ({ mimeType: part.mimeType, data: part.data }));
			if (!text && images.length === 0) continue;
			turnStartAt = at || undefined;
			const outgoing: TranscriptMessage = {
				role: "user",
				text,
				at,
				id: messageIdOf(chat.externalId, Number(entry.id)),
			};
			if (images.length > 0) outgoing.images = images;
			messages.push(outgoing);
			continue;
		}

		if (entry.kind === "pi.tool-result") {
			const message = entry.model?.[0];
			if (!message || message.role !== "toolResult") continue;
			const slot = byCallId.get(message.toolCallId);
			if (!slot) continue;
			const { step } = slot;
			step.ok = !message.isError;
			const output = clampText(contentText(message.content), STEP_OUTPUT_LIMIT);
			if (output) step.output = output;
			const diff = stepDiff((message as { details?: unknown }).details);
			if (diff) step.diff = diff;
			if (typeof message.durationMs === "number") step.ms = Math.round(message.durationMs);
			slot.settled = true;
			continue;
		}

		if (entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0];
		if (!message || message.role !== "assistant") continue;
		const at = typeof message.timestamp === "number" ? message.timestamp : 0;
		// assistant 的 timestamp 是"请求开始"，收尾时刻要再加 durationMs（pi-ai 的口径）；
		// 没有 durationMs 的旧记录退回 timestamp，宁可少算也不编一个数出来。
		const endedAt =
			at + (typeof message.durationMs === "number" ? Math.max(0, Math.round(message.durationMs)) : 0);

		// 带工具调用的中间回合：收步骤；正文不为空就作为一步「说」下发（批 32）。
		// 模型动手前常先说话（"我先看看这个文件…"），以前直接丢掉，历史回读
		// 就看不到这段——现场有、翻历史没有，会让人怀疑记录被裁过。
		const parts = Array.isArray(message.content) ? message.content : [];
		const calls = parts.filter((item) => item.type === "toolCall");
		if (calls.length > 0) {
			const spoken = contentText(
				parts.filter((item) => item.type !== "toolCall"),
			).trim();
			if (spoken) {
				const say: TranscriptStep = { name: "say", ok: true, format: "md" };
				const text = clampText(spoken, STEP_OUTPUT_LIMIT);
				if (text) say.output = text;
				pending.push(say);
			}
			for (const call of calls) {
				const step: TranscriptStep = { name: call.name, ok: true };
				const label = toolLabel(call.arguments);
				if (label) step.label = label;
				const args = toolArgs(call.arguments).args;
				if (args) step.args = args;
				pending.push(step);
				byCallId.set(call.id, { step, settled: false });
			}
			continue;
		}

		const text = contentText(message.content).trim();
		if (!text) continue;
		const outgoing: TranscriptMessage = { role: "assistant", text, at };
		if (pending.length > 0) {
			// 没配到结果的（中断 / 崩在工具里）在这里定案：ok=false，避免历史把它画成成功。
			// 判据是 settled 而不是"有没有输出"——成功的 `read` 也可能一字不吐。
			for (const slot of byCallId.values()) {
				if (!slot.settled) slot.step.ok = false;
			}
			outgoing.steps = pending;
			if (turnStartAt !== undefined && endedAt > turnStartAt) outgoing.workMs = endedAt - turnStartAt;
		}
		messages.push(outgoing);
		pending = [];
		byCallId.clear();
	}

	// 收尾兜底：一轮因为撞工具回合上限 / 被停 / 崩在工具里而没能产出正文时，
	// 上面那条"挂在回答上"的路就没有挂靠点，整轮步骤会凭空消失——
	// 而这恰恰是最需要看过程的一轮。这里给它们一条只有步骤、正文为空的 assistant，
	// 客户端照常渲染工作过程块（正文是空的，自然不显示字）。
	if (pending.length > 0) {
		for (const slot of byCallId.values()) {
			if (!slot.settled) slot.step.ok = false;
		}
		const lastAt =
			typeof view.entries.at(-1)?.model?.[0]?.timestamp === "number"
				? (view.entries.at(-1)?.model?.[0]?.timestamp as number)
				: 0;
		const outgoing: TranscriptMessage = { role: "assistant", text: "", at: lastAt, steps: pending };
		if (turnStartAt !== undefined && lastAt > turnStartAt) outgoing.workMs = lastAt - turnStartAt;
		messages.push(outgoing);
	}

	return limit > 0 ? messages.slice(-limit) : messages;
}

/** 最后一轮模型回答的纯文本（用于补齐流式没吐完的部分） */
async function answerText(conversation: Conversation): Promise<string> {
	const view = await conversation.context(CTX);
	for (let index = view.entries.length - 1; index >= 0; index -= 1) {
		const entry = view.entries[index];
		if (!entry || entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0];
		if (message) return contentText(message.content);
	}
	return "";
}

/**
 * 读本轮最后一条 assistant 消息的 token 用量（2026-11-04 批次一）。
 *
 * 挂在 settle 回调与 chatStream 收尾两处用。客户端断流也照样能读 ——
 * 那一轮在服务端照样跑完。取的是本轮最后一次模型请求的 usage
 * （多工具回合时，中间回合的增量已被它累计在前缀里）。
 * 验收指标（2026-10-31 方案 §7）：`cacheRead > 0 且 ≥ 首轮 prompt 的 60%`、
 * `工具链每轮增量 < 600 token`，都从 logTurnUsage 那行日志里捞。
 */
async function readLastTurnUsage(conversation: Conversation): Promise<TurnUsage | null> {
	try {
		const view = await conversation.context(CTX);
		for (let index = view.entries.length - 1; index >= 0; index -= 1) {
			const entry = view.entries[index];
			if (!entry || entry.kind !== "pi.assistant") continue;
			const message = entry.model?.[0] as
				| { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }
				| undefined;
			const usage = message?.usage;
			if (usage) {
				return {
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					cacheRead: usage.cacheRead ?? 0,
				};
			}
		}
	} catch {
		// 读不到就算了：用量是锦上添花，不该让它影响对话
	}
	return null;
}

async function logTurnUsage(conversation: Conversation, internalId: number): Promise<void> {
	const usage = await readLastTurnUsage(conversation);
	if (usage) {
		console.log(
			`[usage] 会话 ${internalId} input=${usage.input} cacheRead=${usage.cacheRead} output=${usage.output}`,
		);
	}
}

/**
 * 上下文占用（2026-11-04 批次二，给标题栏「已用/窗口」徽标用）。
 *
 * used 不自己数 token——直接取本轮最后一次请求的 `usage.input`，那是上游真实测量的
 * prompt 大小（压缩/截断后的效果都体现在里面），比拿 ContextView 自算准。
 *
 * window 取**这个会话自己绑定的模型**的 contextWindow（2026-11-13）：以前读全局
 * 默认模型，会话在 pill 里切过模型 / 旧会话还停在别的模型上时，环会按错的窗口
 * 算占比（也看起来像"上下文不是按这个会话加载的"）。会话模型还没 configure 时
 * 才回退全局默认；两处都读不到就给 null，前端隐藏徽标。
 */
export async function contextUsageOf(
	conversation: Conversation,
): Promise<{ used: number | null; window: number | null }> {
	const usage = await readLastTurnUsage(conversation);
	if (!usage || usage.input <= 0) return { used: null, window: null };
	const windowOf = (provider: string | undefined, modelId: string | undefined): number | null => {
		if (!provider || !modelId) return null;
		try {
			// 会话里存的是派生模型引用（`#think-*` / `#t…`），窗口按基座模型查
			const model = currentModels().getModel(provider, modelId.split("#")[0]);
			const value = (model as { contextWindow?: number } | undefined)?.contextWindow;
			return typeof value === "number" && value > 0 ? value : null;
		} catch {
			return null;
		}
	};
	const config = readLlmConfig();
	const agent = await conversation.agent(CTX).catch(() => null);
	// 先按会话自己的模型取；会话模型被删 / 还没 configure（例如旧会话停在已移除的
	// 供应商上）才回退全局默认——绝不因为查不到会话模型就把整块徽标藏掉。
	const window =
		windowOf(agent?.model?.provider, agent?.model?.modelId) ??
		windowOf(config?.model.provider, config?.model.modelId);
	return { used: usage.input, window };
}

// ── 会话旁路能力 ─────────────────────────────────────────
export interface UsageSummary {
	models: {
		model: string;
		inputTokens: number;
		outputTokens: number;
		/** 缓存命中 token（2026-10-31 方案 §7 验收指标用） */
		cacheReadTokens: number;
		/** 缓存写入 token */
		cacheWriteTokens: number;
		totalTokens: number;
	}[];
}

export async function usageSummary(): Promise<UsageSummary> {
	const harness = await getHarness();
	const state = await harness.usage(CTX);
	return {
		models: Object.entries(state.models).map(([model, usage]) => ({
			model,
			inputTokens: usage.input ?? 0,
			outputTokens: usage.output ?? 0,
			cacheReadTokens: usage.cacheRead ?? 0,
			cacheWriteTokens: usage.cacheWrite ?? 0,
			totalTokens: usage.totalTokens ?? 0,
		})),
	};
}

export interface ReminderSummary {
	id: number;
	/** 稳定提醒 id（每日续排沿用；列表按它归组） */
	reminderId: string;
	status: "pending" | "running" | "waiting" | "sleeping" | "completing" | "terminal";
	text: string;
	at: number;
	/** 频率（2026-11-12）：none = 一次性；daily = 每天 */
	repeat: "none" | "daily";
	/** 目标执事（2026-11-12）；null = 建在普通会话里 */
	partnerId: string | null;
	until?: number;
	conversationId: number;
}

/**
 * 提醒列表（直接读 durable 的任务图，不另存一份）。
 *
 * 2026-11-12：每日提醒会每天换一个任务，所以按 `reminderId` 归组——
 * 每组只返回一个代表：优先当前还活着的那个（sleeping/pending），都结束了才给最新一条终态。
 * 否则列表会一天多一行"已结束"，桌面页会被历史刷屏。
 */
export async function listReminders(): Promise<ReminderSummary[]> {
	const harness = await getHarness();
	const inspection = await harness.inspect(CTX);
	type Row = {
		id: number;
		input: { text: string; at: number; repeat?: "none" | "daily"; reminderId?: string; partnerId?: string | null };
		conversationId: number;
		live: boolean;
		until?: number;
	};
	const groups = new Map<string, Row[]>();
	for (const task of inspection.tasks) {
		if (task.record.kind !== ReminderTask.definition.name) continue;
		const record = task.record as unknown as {
			id: number;
			input: {
				text: string;
				at: number;
				repeat?: "none" | "daily";
				reminderId?: string;
				partnerId?: string | null;
			};
			conversationId: number;
		};
		const live = task.state.kind !== "blocked";
		const row: Row = {
			id: record.id,
			input: record.input,
			conversationId: record.conversationId,
			live,
			...(task.state.kind === "sleeping" ? { until: task.state.until } : {}),
		};
		const key = record.input.reminderId ?? `legacy-${record.id}`;
		const bucket = groups.get(key);
		if (bucket) bucket.push(row);
		else groups.set(key, [row]);
	}

	const result: ReminderSummary[] = [];
	for (const [reminderId, rows] of groups) {
		const live = rows
			.filter((row) => row.live)
			.sort((a, b) => a.input.at - b.input.at)[0];
		const chosen = live ?? rows.sort((a, b) => b.input.at - a.input.at)[0];
		if (!chosen) continue;
		result.push({
			id: chosen.id,
			reminderId,
			status: chosen.live ? (chosen.until === undefined ? "pending" : "sleeping") : "terminal",
			text: chosen.input.text,
			at: chosen.input.at,
			repeat: chosen.input.repeat === "daily" ? "daily" : "none",
			partnerId: chosen.input.partnerId ?? null,
			...(chosen.until !== undefined ? { until: chosen.until } : {}),
			conversationId: chosen.conversationId,
		});
	}
	return result.sort((a, b) => a.at - b.at);
}

/** 主动加一个提醒（HTTP 端调用；Agent 自己加走 set_reminder 工具） */
export async function addReminder(
	chat: ResolvedChat,
	input: { text: string; at: number; repeat?: "none" | "daily"; partnerId?: string | null },
): Promise<number> {
	const reminderId = randomUUID();
	const id = await chat.conversation.commit(
		(tx) =>
			tx.createTask(
				ReminderTask,
				{ ...input, reminderId },
				{ ownership: { kind: "conversation" } },
			),
		CTX,
	);
	return Number(id);
}

/**
 * 取消一条提醒（2026-11-12）。
 *
 * 只允许取消真实存在的提醒任务（先对列表校验），避免任意 taskId 把别人的对话轮 abort 掉。
 * 返回 false = 没有这条提醒（或已经结束）。
 */
export async function cancelReminder(taskId: number): Promise<boolean> {
	const reminders = await listReminders();
	if (!reminders.some((reminder) => reminder.id === taskId && reminder.status !== "terminal")) {
		return false;
	}
	const harness = await getHarness();
	await harness.abortTask(taskId as never, CTX);
	return true;
}

// ── 会话索引（2026-10-29 配对配套）────────────────────────
/**
 * 会话索引：**只返回元数据，不含正文**。
 *
 * 为什么需要：手机本地存会话清单，但重装/换机后清单会丢；这里给一份可恢复的索引，
 * 手机配对后拉一次就能把历史列表重建出来，正文仍按 id 现取（`GET .../messages`）。
 *
 * 为什么不做"列全部会话内容"：会话一多，一次性把所有正文吐出来太重。
 * 代价（如实登记）：这里为了拿首句与时间，会逐个打开会话读一遍 context，
 * **会话数量大时会变慢**；真到那时应改用 durable 的 entries 分页 + 单独维护索引表。
 */
export interface ChatIndexEntry {
	conversationId: string;
	createdAt: number;
	lastAt: number;
	firstText: string;
	turns: number;
	/** 用户改过的名字；没有就用 firstText */
	title?: string;
	/** 是否置顶（2026-11-04 批次一）；置顶的排前面由客户端处理 */
	pinned?: boolean;
	/** 会话种类（2026-11-06 侧栏调整 B2，纯增量）：前端据此筛"总管"入口，不按 id 猜身份 */
	chatKind: ChatKind;
	/**
	 * 以下四个是归档清单（2026-11-12 归档模块 §3）的增量字段：
	 * 活跃清单不改变现有字段，只有 `GET /agent/chats/archived` 保证带 `archived` / `archivedAt`。
	 */
	archived?: boolean;
	archivedAt?: number;
	projectId?: string;
	projectName?: string;
}

// ── 会话标题 / 归档 ─────────────────────────────────────
/**
 * durable 里没有「标题」这个概念（Conversation 只有 id / owner / model 这些），
 * 也没有删除接口。所以标题、以及我们自己的「归档」都记在这份小文件里，
 * 不往内核的表结构里塞东西 —— 那是升级时最容易痛的地方。
 *
 * 2026-11-12 归档模块：`hidden` → `archived`，并新增 `archivedAt`（归档时间）。
 * 读路径兼容旧键（`archived ?? hidden`），写路径只写新键；旧键在首次写入后消失。
 * 归档永不物理删除会话，恢复只改这份文件。
 */
export interface ChatMeta {
	titles: Record<string, string>;
	archived: string[];
	/** 归档时间（epoch 毫秒）；旧数据可能没有，读不到就回退到最后一句时间 */
	archivedAt: Record<string, number>;
	/** 置顶的会话 id，按置顶先后排（2026-11-04 批次一） */
	pins: string[];
}

const CHAT_META_PATH =
	process.env.AGENT_CHAT_META_PATH?.trim() || ".data/chat-meta.json";

export function readChatMeta(): ChatMeta {
	try {
		const parsed = JSON.parse(readFileSync(CHAT_META_PATH, "utf8")) as Partial<ChatMeta> & {
			hidden?: unknown;
		};
		// 兼容旧键：2026-11-12 之前叫 hidden
		const archived = Array.isArray(parsed.archived)
			? parsed.archived.filter((id): id is string => typeof id === "string")
			: Array.isArray(parsed.hidden)
				? parsed.hidden.filter((id): id is string => typeof id === "string")
				: [];
		const archivedAt: Record<string, number> = {};
		if (parsed.archivedAt && typeof parsed.archivedAt === "object" && !Array.isArray(parsed.archivedAt)) {
			for (const [id, at] of Object.entries(parsed.archivedAt)) {
				if (typeof at === "number" && Number.isFinite(at)) archivedAt[id] = at;
			}
		}
		return {
			titles:
				parsed.titles && typeof parsed.titles === "object" ? parsed.titles : {},
			archived,
			archivedAt,
			pins: Array.isArray(parsed.pins) ? parsed.pins : [],
		};
	} catch {
		// 文件不存在或坏了：当作没改过名、没归档过，不影响会话本身
		return { titles: {}, archived: [], archivedAt: {}, pins: [] };
	}
}

function writeChatMeta(meta: ChatMeta): void {
	// 原子写（2026-11-13 永久删除批A，参照 flags.ts 的 atomicWrite）：临时文件 + rename。
	// 以前是就地 writeFileSync，进程中途被杀会留下半截 JSON，重启后整份 chat-meta 当空处理
	// （标题/归档/置顶全丢）。永久删除也走这条路，写失败代价变高了，先补上这层。
	mkdirSync(dirname(CHAT_META_PATH), { recursive: true });
	const temp = `${CHAT_META_PATH}.tmp-${process.pid}-${Date.now()}`;
	try {
		// 只写新键：旧 `hidden` 不回写，回滚代码仍能读新键
		writeFileSync(temp, JSON.stringify(meta, null, 2), "utf8");
		renameSync(temp, CHAT_META_PATH);
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			/* 清理失败就算了，别盖住原始错误 */
		}
		throw error;
	}
}

/**
 * 清掉一批会话在 chat-meta 里的全部痕迹（2026-11-13 永久删除批A）：
 * `titles` / `archived` / `archivedAt` / `pins` 四组一起删。
 * 永久删除在 durable 行清完之后调它；没有痕迹就不写盘。
 */
export function purgeChatMetaEntries(conversationIds: readonly string[]): void {
	const meta = readChatMeta();
	let changed = false;
	for (const conversationId of conversationIds) {
		if (conversationId in meta.titles) {
			delete meta.titles[conversationId];
			changed = true;
		}
		const archivedIndex = meta.archived.indexOf(conversationId);
		if (archivedIndex !== -1) {
			meta.archived.splice(archivedIndex, 1);
			changed = true;
		}
		if (conversationId in meta.archivedAt) {
			delete meta.archivedAt[conversationId];
			changed = true;
		}
		const pinIndex = meta.pins.indexOf(conversationId);
		if (pinIndex !== -1) {
			meta.pins.splice(pinIndex, 1);
			changed = true;
		}
	}
	if (changed) writeChatMeta(meta);
}

export function renameChat(conversationId: string, title: string): { title?: string } {
	const meta = readChatMeta();
	const clean = title.trim().slice(0, 80);
	if (clean) meta.titles[conversationId] = clean;
	else delete meta.titles[conversationId];
	writeChatMeta(meta);
	return { title: clean || undefined };
}

/**
 * 归档：只是从活跃列表里拿掉，会话本身和记忆都还在（没有删除接口）。
 * 重复归档只更新时间，不产生重复条目；`at` 供批量场景注入同一时刻。
 */
export function archiveChat(conversationId: string, at = Date.now()): void {
	const meta = readChatMeta();
	if (!meta.archived.includes(conversationId)) meta.archived.push(conversationId);
	meta.archivedAt[conversationId] = at;
	writeChatMeta(meta);
}

/**
 * 归档端点的防误触入口（2026-11-13 对齐 ZCode 批A）：**运行中禁止归档**。
 *
 * 先解析 id 并判忙，忙则拒绝（400 带说明，与 forkForEdit 的 409 同款思路）；
 * 解析失败（不存在的 id）与忙态读不出来时按改动前行为归档——归档可恢复，
 * 不因为"多加了一道防误触"让老客户端的归档变得更不可用。归档仍不中断运行：
 * 是"先停止再归"，不是"归档即停止"。
 */
export async function archiveChatGuarded(
	conversationId: string,
): Promise<{ ok: true } | { ok: false; status: 400; error: string; message: string }> {
	try {
		const chat = await openChat(conversationId);
		if (chat && (await conversationIsBusy(chat.conversation))) {
			return {
				ok: false,
				status: 400,
				error: "conversation_busy",
				message: "会话正在运行，请先停止再归档",
			};
		}
	} catch (error) {
		// harness 打不开（存储抖动 / 未配置模型）不该挡归档：按空闲处理，行为与改动前一致
		console.warn(
			`[chats] 归档前判忙失败，按空闲处理: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	archiveChat(conversationId);
	return { ok: true };
}

/** 兼容别名：2026-11-12 之前叫 hideChat（旧调用方零改动）。 */
export const hideChat = archiveChat;

/** 从归档里恢复一条（幂等）：不在归档里也什么都不写、不报错。 */
export function unarchiveChat(conversationId: string): void {
	const meta = readChatMeta();
	const index = meta.archived.indexOf(conversationId);
	const hadAt = conversationId in meta.archivedAt;
	if (index === -1 && !hadAt) return;
	if (index !== -1) meta.archived.splice(index, 1);
	delete meta.archivedAt[conversationId];
	writeChatMeta(meta);
}

/** 置顶 / 取消置顶（2026-11-04 批次一）。只影响列表展示顺序，不碰会话本身 */
export function pinChat(conversationId: string, pinned: boolean): boolean {
	const meta = readChatMeta();
	const index = meta.pins.indexOf(conversationId);
	if (pinned && index === -1) meta.pins.push(conversationId);
	if (!pinned && index !== -1) meta.pins.splice(index, 1);
	if (index !== -1 || pinned) writeChatMeta(meta);
	return pinned && meta.pins.includes(conversationId);
}

/** 全部恢复：清空归档 id 与归档时间两组，返回恢复条数。 */
export function restoreArchivedChats(): number {
	const meta = readChatMeta();
	const count = meta.archived.length;
	meta.archived = [];
	meta.archivedAt = {};
	writeChatMeta(meta);
	return count;
}

/** 兼容别名：2026-11-12 之前叫 restoreChats（旧调用方零改动）。 */
export const restoreChats = restoreArchivedChats;

export function chatMetaSummary(): { archived: number } {
	return { archived: readChatMeta().archived.length };
}

/**
 * 改名表快照（2026-11-04 批次六）：全局审批列表要显示"哪个会话在等"。
 * 只读 chat-meta.json 的 `titles`——它不返回标题以外的任何东西，也不逐会话打开。
 */
export function chatTitles(): Record<string, string> {
	return { ...readChatMeta().titles };
}

// ── 项目归档连带（2026-11-12 归档模块 §5）───────────────
/** 群 / 执事会话的对外 id 前缀：与 group-runtime / partner-runtime 的约定一致，不该被项目连带归档。 */
const PARTNER_CONVERSATION_PREFIX = "partner-";

/**
 * 纯过滤：从 durable 的两张映射表里挑出"属于这个项目、且允许连带归档"的对外会话 id。
 *
 * 独立成纯函数是为了直接断言（单测不搭 durable）：只认 `ChatProjects` 里真的记了
 * `projectId` 的会话，不按目录 / 时间猜旧会话归属；`task-` 与 `partner-` 前缀跳过。
 */
export function projectChatExternalIds(
	chatProjects: Record<string, string>,
	chatsByExternal: Record<string, number>,
	projectId: string,
): string[] {
	const externalByInternal = new Map<number, string>();
	for (const [externalId, internalId] of Object.entries(chatsByExternal)) {
		externalByInternal.set(Number(internalId), externalId);
	}
	const result: string[] = [];
	for (const [internalId, mappedProjectId] of Object.entries(chatProjects)) {
		if (mappedProjectId !== projectId) continue;
		const externalId = externalByInternal.get(Number(internalId));
		if (!externalId) continue;
		if (externalId.startsWith(TASK_CONVERSATION_PREFIX)) continue;
		if (externalId.startsWith(PARTNER_CONVERSATION_PREFIX)) continue;
		result.push(externalId);
	}
	return result;
}

/**
 * 项目归档后连带归档"这个项目下新建的普通会话"（2026-11-12 归档模块 §5）。
 *
 * 只读 `ChatProjects` 的创建时归属，**旧会话不回溯**；只写 chat-meta，不碰正文 / 磁盘。
 * 返回实际归档条数（重复归档也算一次：它在归档里就是用户看到的结果）。
 */
export async function archiveChatsOfProject(projectId: string): Promise<number> {
	if (!projectId) return 0;
	const harness = await getHarness();
	const [chats, chatProjects] = await Promise.all([
		harness.snapshot(Chats, CTX),
		harness.snapshot(ChatProjects, CTX),
	]);
	const externalIds = projectChatExternalIds(
		chatProjects?.byInternal ?? {},
		chats?.byExternal ?? {},
		projectId,
	);
	const at = Date.now();
	for (const externalId of externalIds) archiveChat(externalId, at);
	return externalIds.length;
}

// ── 记忆（设置页，2026-11-06）──────────────────────────────
//
// 为什么放在 agent.ts 而不是新开一个模块：`memoryEngine` 是这里的模块级单例，
// 另起一个模块还得反过来 import 它，等于把装配关系绕一圈。
// 设置页只需要四个动作：看 / 删 / 标过时 / 看统计。

export interface MemoryView {
	id: string;
	kind: string;
	scope: string;
	content: string;
	importance: number;
	veracity: string;
	source: string;
	createdAt: string;
	recallCount: number;
	supersededBy: string | null;
}

export interface MemoryOverview {
	enabled: boolean;
	/** 抽取档位：llm / rule / auto 实际生效的结果 */
	extract: string;
	total: number;
	byKind: Record<string, number>;
	items: MemoryView[];
}

function memoryView(record: MemoryRecord): MemoryView {
	return {
		id: record.id,
		kind: record.kind,
		scope: record.scope,
		content: record.content,
		importance: record.importance,
		veracity: record.veracity,
		source: record.source,
		createdAt: record.createdAt,
		recallCount: record.recallCount,
		supersededBy: record.supersededBy,
	};
}

/**
 * 设置页的记忆列表。
 *
 * `scopes`：主对话看 `global`（偏好 + 日记摄入都在这里），执事看自己的键空间。
 * 不传 = global。刻意**不列 session scope**：那是原始对话的沉淀，条数增长快、
 * 对用户也没有"管理"的意义（真要清理走删会话）。
 */
export function memoryOverview(options: { scope?: string; limit?: number } = {}): MemoryOverview {
	if (!memoryEngine) {
		return { enabled: false, extract: memoryExtractMode(), total: 0, byKind: {}, items: [] };
	}
	try {
		const scope = options.scope?.trim() || "global";
		const records = memoryEngine.list({ scopes: [scope], limit: options.limit ?? 300 });
		const byKind: Record<string, number> = {};
		for (const record of records) byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
		return {
			enabled: true,
			extract: memoryEngine && preferenceExtractionEnabled() ? "llm" : "rule",
			total: records.length,
			byKind,
			items: records.map(memoryView),
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 概览读取失败: ${detail}`);
		return { enabled: true, extract: memoryExtractMode(), total: 0, byKind: {}, items: [] };
	}
}

/** 删除一条记忆。返回 false = 没有这条（404 由 API 层决定）。 */
export function forgetMemory(id: string): boolean {
	return memoryEngine?.forget(id) ?? false;
}

/** 标记一条记忆为过时（可指定替代者）。返回 false = 目标或替代者不存在。 */
export function supersedeMemory(id: string, byId?: string | null): boolean {
	return Boolean(memoryEngine?.supersede(id, byId ?? null));
}

type HarnessHandle = Awaited<ReturnType<typeof getHarness>>;

/** 列表 / 归档清单共用的会话元数据（不含种类与 chat-meta 字段）。 */
export interface ChatStats {
	firstText: string;
	turns: number;
	createdAt: number;
	lastAt: number;
}

/**
 * 读一个会话的首句 / 轮数 / 首末时间。
 * `turns === 0` 返回 null：空会话不进任何清单（原有 listChats 口径不变）。
 * 2026-11-13 起导出：自动归档的 lastAt 与永久删除预检的 rounds/lastAt 用同一口径（不另抄一份）。
 */
export async function readChatStats(
	harness: HarnessHandle,
	internalId: number,
): Promise<ChatStats | null> {
	const conversation = await harness.conversation(internalId as never, CTX);
	if (!conversation) return null;
	const view = await conversation.context(CTX);
	let firstText = "";
	let turns = 0;
	let createdAt = 0;
	let lastAt = 0;
	for (const entry of view.entries) {
		if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0];
		if (!message) continue;
		const at = typeof message.timestamp === "number" ? message.timestamp : 0;
		if (entry.kind === "pi.user") {
			turns += 1;
			if (!firstText) firstText = contentText(message.content).trim().slice(0, 40);
		}
		if (!createdAt && at) createdAt = at;
		if (at > lastAt) lastAt = at;
	}
	if (turns === 0) return null;
	return { firstText, turns, createdAt, lastAt };
}

/** 活跃清单与归档清单共用的 entry 构建（避免两份逻辑漂移）。 */
function chatEntryOf(
	conversationId: string,
	internalId: number,
	stats: ChatStats,
	meta: ChatMeta,
	kinds: Record<string, "chief" | "worker">,
): ChatIndexEntry {
	return {
		conversationId,
		createdAt: stats.createdAt,
		lastAt: stats.lastAt,
		firstText: stats.firstText,
		turns: stats.turns,
		chatKind: chatKindOfInternal(internalId, kinds),
		...(meta.titles[conversationId] ? { title: meta.titles[conversationId] } : {}),
		...(meta.pins.includes(conversationId) ? { pinned: true } : {}),
	};
}

export async function listChats(limit = 50): Promise<ChatIndexEntry[]> {
	if (!readLlmConfig()) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	// 任务会话（`X-Task` 通道产生）不进"历史对话"：它们的首句是"请整理成稿"这类指令，
	// 不是用户说过的话（2026-10-31）。正文仍可按 id 回读，只是不在列表里露头。
	const meta = readChatMeta();
	const archived = new Set(meta.archived);
	// 种类表读一次（2026-11-06 B2）：逐会话查库会把列表代价再放大一倍
	const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
	const pairs = Object.entries(chats?.byExternal ?? {})
		.filter(([conversationId]) => !conversationId.startsWith(TASK_CONVERSATION_PREFIX))
		.filter(([conversationId]) => !archived.has(conversationId))
		.slice(-limit);
	const entries: ChatIndexEntry[] = [];

	for (const [conversationId, internalId] of pairs) {
		try {
			const stats = await readChatStats(harness, Number(internalId));
			if (!stats) continue;
			entries.push(chatEntryOf(conversationId, Number(internalId), stats, meta, kinds));
		} catch (error) {
			// 单个会话读失败不该让整张索引失败（重装场景下可能是残留的空会话）
			console.warn(
				`[chats] 读取会话 ${conversationId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return entries.sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * 纯映射：把 `chat-meta.archived` 的对外 id 反查成 durable 内部 id，保持归档数组顺序。
 * 独立成纯函数是给单测钉"归档清单不从活跃清单截断"的结构（不搭 harness 也能断言条数）。
 */
export function archivedChatPairs(
	archivedIds: readonly string[],
	chatsByExternal: Record<string, number>,
): { conversationId: string; internalId: number }[] {
	const pairs: { conversationId: string; internalId: number }[] = [];
	for (const conversationId of archivedIds) {
		const internalId = chatsByExternal[conversationId];
		if (internalId === undefined) continue;
		pairs.push({ conversationId, internalId: Number(internalId) });
	}
	return pairs;
}

/**
 * 归档会话清单（2026-11-12 归档模块 §3）。
 *
 * 与 `listChats` 的关键区别：**按 `chat-meta.archived` 的 id 反查**，不走活跃清单的
 * `slice(-limit)`——归档的多是旧会话，按活跃清单截断会把它们漏掉。`limit` 只截最终结果。
 * 项目标签只在该会话有归属映射、且项目登记还在（含已归档项目）时给。
 */
export async function listArchivedChats(limit = 200): Promise<ChatIndexEntry[]> {
	if (!readLlmConfig()) return [];
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const meta = readChatMeta();
	// 种类表读一次（与 listChats 同口径）
	const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
	const chatProjects = (await harness.snapshot(ChatProjects, CTX))?.byInternal ?? {};
	const byExternal = chats?.byExternal ?? {};

	const projectNames = new Map<string, string>();
	if (Object.keys(chatProjects).length > 0) {
		try {
			// 项目库读不出来就不显示项目标签，不影响归档清单本身
			for (const project of projectsStore().listProjects(true)) {
				projectNames.set(project.id, project.name);
			}
		} catch {
			/* 同上 */
		}
	}

	const entries: ChatIndexEntry[] = [];
	for (const { conversationId, internalId } of archivedChatPairs(meta.archived, byExternal)) {
		try {
			const stats = await readChatStats(harness, internalId);
			if (!stats) continue;
			const projectId = chatProjects[String(internalId)];
			const projectName = projectId ? projectNames.get(projectId) : undefined;
			entries.push({
				...chatEntryOf(conversationId, internalId, stats, meta, kinds),
				archived: true,
				// 旧数据没有归档时间：按方案回退到最后一句时间（不是 0，排序才有意义）
				archivedAt: meta.archivedAt[conversationId] ?? stats.lastAt,
				...(projectId && projectName ? { projectId, projectName } : {}),
			});
		} catch (error) {
			// 单个会话读失败不该让整张归档清单失败
			console.warn(
				`[chats] 读取归档会话 ${conversationId} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
	return entries
		.sort((a, b) => (b.archivedAt ?? b.lastAt) - (a.archivedAt ?? a.lastAt))
		.slice(0, cap);
}

// ── 内容级搜索（2026-11-04 批次二）────────────────────────
export interface SearchHit {
	conversationId: string;
	/** 会话标题（没有就用首句），展示用 */
	title: string;
	role: "user" | "assistant";
	at: number;
	/** 命中处附近 ±40/80 字的片段，前端做高亮 */
	text: string;
}

/**
 * 跨会话搜正文：逐会话读 transcript 做 LIKE 过滤。
 * 代价与 `listChats` 同口径（逐会话打开，会话多时慢）——搜索是显式动作，慢一点可接受；
 * FTS5 等真变慢了再立项（记忆层召回的中文 LIKE 失效是每轮隐式动作，那边必须快，这边不必）。
 */
export async function searchTranscripts(q: string, limit = 20): Promise<SearchHit[]> {
	const needle = q.trim().toLowerCase();
	if (needle.length < 2) return [];
	const chats = await listChats(200);
	const hits: SearchHit[] = [];
	for (const chat of chats) {
		try {
			const resolved = await openChat(chat.conversationId);
			if (!resolved) continue;
			const messages = await readTranscript(resolved, 200);
			for (const message of messages) {
				const index = message.text.toLowerCase().indexOf(needle);
				if (index === -1) continue;
				hits.push({
					conversationId: chat.conversationId,
					title: chat.title || chat.firstText,
					role: message.role,
					at: message.at,
					text: message.text.slice(Math.max(0, index - 40), index + needle.length + 80),
				});
				if (hits.length >= limit) return hits;
			}
		} catch (error) {
			// 单会话读失败不挡整查
			console.warn(
				`[search] 会话 ${chat.conversationId} 读取失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return hits;
}

// ── 记忆证据引文（2026-11-10 对标 Anthropic「做梦」§一）────────────────
//
// 整理建议只看记忆库本身，回不到原始对话——抽取时记错的内容没有任何证据能发现
// 它错（Anthropic 纠正月见山那条错笔记，靠的正是回头翻原始记录）。findEvidence
// 补这半步：给建议卡上的每条记忆回原始对话里找"当初真是这么说的"的片段。
// 仍然只建议、人拍板（D18 不变），这半步只是把证据摆到人眼前。

/** 证据引文命中的一条。`text` 是原文片段（±40/80 字），给卡片直接渲染。 */
export interface EvidenceHit {
	conversationId: string;
	at: number;
	role: "user" | "assistant";
	text: string;
}

/**
 * 按记忆正文在跨会话记录里找**原始出处**。
 *
 * 与 `searchTranscripts` 的分工：那边是人输入的查询词、命中即返回（limit 条）；
 * 这边是 ≤50 条建议各自要一个出处，**单遍扫描**共享一次 pass，全部命中即早停。
 * 会话范围照 `listChats` 口径（任务专线与隐藏会话天然不在列表里）。
 *
 * 匹配在归一化层做（`locateEvidence`，与抽取侧引文校验同一套口径）：偏好是模型的
 * 转述，原话里找不到逐字片段很正常，找 4~12 字的归一化锚点；episode 是逐字句，
 * 通常一发命中。查不到 = 那条 `evidence` 为空，不挡应用。
 *
 * 代价与 `searchTranscripts` 同口径：**显式动作**（人点了"整理记忆"才跑这一次），
 * 慢一点可接受。
 *
 * @param needles 记忆正文原文（可带 Why/How 多行；内部只取首行）。返回 Map 以
 *   **传入的原始串**为键，调用方直接用 `proposal.drop.content` 取。
 */
export async function findEvidence(
	needles: string[],
	options: { chatLimit?: number; transcriptLimit?: number } = {},
): Promise<Map<string, EvidenceHit>> {
	const found = new Map<string, EvidenceHit>();
	// 键用原始串；匹配用首行。归一化后不足 4 字的锚点太泛（两个字就能撞上一堆闲聊），直接跳过。
	const pending = needles.filter(
		(needle) => typeof needle === "string" && normalizeForGrounding(needle.split("\n")[0] ?? "").length >= 4,
	);
	if (pending.length === 0) return found;

	let chats: ChatIndexEntry[];
	try {
		chats = await listChats(options.chatLimit ?? 200);
	} catch {
		// 列表读不出来 = 这次没证据，建议照常返回
		return found;
	}

	for (const chat of chats) {
		if (pending.length === 0) break;
		try {
			const resolved = await openChat(chat.conversationId);
			if (!resolved) continue;
			const messages = await readTranscript(resolved, options.transcriptLimit ?? 200);
			for (const message of messages) {
				if (pending.length === 0) break;
				// 逐条剥离已命中的：一条正文只需要一个出处
				for (let index = pending.length - 1; index >= 0; index -= 1) {
					const needle = pending[index]!;
					const snippet = locateEvidence(message.text, needle);
					if (!snippet) continue;
					found.set(needle, {
						conversationId: chat.conversationId,
						at: message.at,
						role: message.role,
						text: snippet,
					});
					pending.splice(index, 1);
				}
			}
		} catch (error) {
			// 单会话读失败不挡整查（与 searchTranscripts 同口径）
			console.warn(
				`[evidence] 会话 ${chat.conversationId} 读取失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return found;
}
