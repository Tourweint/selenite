/**
 * 会话打开与配置（聊天模式 / 压缩 / 模型同步 / 开聊 / 会话类型 / 编辑分叉）
 *
 * 2026-11-13 从 session.ts 的 L1–L572 整段切出；正文原文搬运，未改一行实现。
 */

import { auxPinnedModelId, auxiliaryEnabled } from "../auxiliary.ts";
import { COMPANIONS_ENABLED, partnersStore } from "../partners.ts";
import { projectsStore } from "../projects.ts";
import { chatModelRef, clampThinkingLevel, currentThinkingLevels, isFaux, levelFromModelId, readLlmConfig } from "../provider.ts";
import { markTaskSession } from "../unattended.ts";
import { getHarness, lifediaryExt, rememberLevel, researchExt, stickyThinkingLevel } from "./lifecycle.ts";
import { CTX, ChatKinds, ChatProjects, Chats, ResolvedChat, TASK_CONVERSATION_PREFIX } from "./shared.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Conversation, ToolRegistration, Tx } from "@earendil-works/pi-durable";
import { configure } from "@earendil-works/pi-durable";
import { ChatKind, NewChatKind, ThinkingLevel } from "@lifediary/shared";
import { randomUUID } from "node:crypto";
import { conversationIsBusy } from "./session-stream.ts";
import { messageIdOf } from "./session-transcript.ts";

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

export type CompactTaskId = Awaited<ReturnType<Conversation["compact"]>>;

let compactModelIgnoredWarned = false;

function warnCompactModelIgnored(env: NodeJS.ProcessEnv = process.env): void {
	if (compactModelIgnoredWarned) return;
	if (!auxiliaryEnabled(env)) return;
	if (!auxPinnedModelId("compact", env)) return;
	compactModelIgnoredWarned = true;
	console.warn("[aux] 当前内核不支持指定压缩模型，AUX_MODEL_COMPACT 未生效");
}

export async function startChatCompaction(
	chat: ResolvedChat,
	instructions?: string,
): Promise<CompactTaskId> {
	warnCompactModelIgnored();
	return chat.conversation.compact(instructions, CTX);
}

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

export async function conversationThinkingLevel(chat: ResolvedChat): Promise<ThinkingLevel | null> {
	const agent = await chat.conversation.agent(CTX).catch(() => null);
	return agent?.model ? levelFromModelId(agent.model.modelId) : null;
}

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
		//
		// 2026-11-13 会话绑定即快照：这里把"这一刻的主文件夹"钉进 `pi.agent.cwd`。
		// 之后用户换主文件夹 / 加文件夹都不影响这个会话——它始终在自己的那条路上跑，
		// 这是"智能体开发时分不清路"的根因修法（cwd 不再是全局单值）。
		// 只绑 `worker`（开发会话）；`chief` 是总管人格，留在杂事态（方案留了可调口）。
		let projectId: string | null = null;
		let projectRoot: string | null = null;
		if (chatKind === "worker") {
			try {
				const current = projectsStore().getCurrentProject();
				projectId = current?.id ?? null;
				projectRoot = current?.rootPath ?? null;
			} catch {
				projectId = null;
				projectRoot = null;
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
						if (projectRoot) await configure(tx, conversationId, { cwd: projectRoot });
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

export async function chatKindOf(chat: ResolvedChat): Promise<ChatKind> {
	const harness = await getHarness();
	const kinds = await harness.snapshot(ChatKinds, CTX);
	return chatKindOfInternal(chat.internalId, kinds?.byInternal ?? {});
}

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

export { compactModelIgnoredWarned, syncConversationModel, warnCompactModelIgnored };
