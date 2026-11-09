/**
 * 任务专线会话（2026-11-08 扫尾批 8g「任务即对话」）。
 *
 * 一张任务单 = 一条 `task-<ticketId>` 专线会话：
 *   - 建会话沿用研究回合的先例（`task-topic-`）：外部 id 以 `task-` 开头，
 *     侧栏 `listChats` 的既有前缀过滤会把它藏起来；
 *   - 会话配置走 `configureTaskChat`（摘掉 `lifediaryExt`）：没有人格、没有工具、
 *     不注入记忆——"任务卡 / 记忆"这两处的跳过不是新判定，而是复用任务会话的既有形态；
 *   - 进度 / 汇报 / 留言以 `pi.assistant` 条目写进去（形状同 `sayInChat`），
 *     主人的回话走 `submit({ type:"input", whenBusy:"followUp" })`。
 *
 * 顺序保证：同一张单的所有写入都排在同一条进程内 Promise 队列上——
 * 事件回调是同步的，入队也同步，所以会话里的条目顺序 = delegation 事件发生的顺序。
 * 进程重启后队列丢失，但下一次写入会重新 ensure（幂等），不会写丢。
 *
 * 回滚：`TASK_AS_CONVERSATION=false` 时 ensure/get/append 全部旁路，
 * delegation 仍只写留言表、`POST /tickets/:id/say` 不挂（404）。
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryDraft } from "@earendil-works/pi-durable";
import type { ResolvedChat } from "./agent.ts";
import type { DelegationMirrorEntry } from "./delegation.ts";
import { TASK_CONVERSATION_PREFIX } from "./agent/shared.ts";

const CTX = BACKGROUND_CONTEXT;

/** 回滚开关：缺省开；`false` / `0` / `off` 时整体旁路。 */
export function taskAsConversationEnabled(): boolean {
	const raw = (process.env.TASK_AS_CONVERSATION?.trim() || "true").toLowerCase();
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 对外会话 id：`task-` + 任务单号。确定性，重启后照样算得出来（回读靠 GET messages）。 */
export function taskConversationExternalId(ticketId: string): string {
	return `${TASK_CONVERSATION_PREFIX}${ticketId}`;
}

/**
 * 专线会话的提示词：它是这张单的"回声"，不是第二个执行者。
 * 会话里的进度/汇报由系统写入，所以模型只需要围着已有内容说话；
 * 工具面被 `configureTaskChat` 清空，不需要在提示词里重复恐吓。
 */
export function renderTaskConversationPrompt(ticketId: string): string {
	return [
		`你是任务单 ${ticketId} 的专线会话，只陪主人看这张单的进展。`,
		"",
		"# 规则",
		"- 进度和汇报由系统写进本会话；你只根据会话里已有的内容回应，不编造、不假装自己执行。",
		"- 你没有任何工具：不改文件、不派活、不碰任务中心。",
		"- 主人的每句话都会由系统转给执行端；你只需简短确认或解释，不要承诺完成时间。",
	].join("\n");
}

/** 进程内缓存：同一张单只 open 一次；重启后由 ensure 重新打开（幂等）。 */
const chats = new Map<string, ResolvedChat>();
/** 并发 ensure 的合并位：双击 / 事件同时到达时不要建出两条会话。 */
const creating = new Map<string, Promise<ResolvedChat | null>>();
/** 每张单的写入队列（保证 ordering）。 */
const queues = new Map<string, Promise<void>>();
/** 没模型时只告警一次，别每条进度都刷一行。 */
const warned = new Set<string>();

function short(ticketId: string): string {
	return ticketId.slice(0, 12);
}

async function llmReady(): Promise<boolean> {
	try {
		const { readLlmConfig } = await import("./provider.ts");
		return Boolean(readLlmConfig());
	} catch {
		return false;
	}
}

function warnOnce(ticketId: string, reason: string): void {
	if (warned.has(ticketId)) return;
	warned.add(ticketId);
	console.warn(`[task-conv] 专线会话不可用 ticket=${short(ticketId)} reason=${reason}`);
}

/**
 * 打开或新建这张单的专线会话（幂等：同单复用同会话）。
 *
 * 没配模型 / 存储打不开时返回 null，**不抛**：专线是旁路，不能把派活主链路拖下水。
 */
export async function ensureTaskConversation(ticketId: string): Promise<ResolvedChat | null> {
	if (!taskAsConversationEnabled()) return null;
	const cached = chats.get(ticketId);
	if (cached) return cached;
	const pending = creating.get(ticketId);
	if (pending) return pending;

	const task = (async (): Promise<ResolvedChat | null> => {
		try {
			if (!(await llmReady())) {
				warnOnce(ticketId, "llm_not_configured");
				return null;
			}
			const agent = await import("./agent.ts");
			const chat = await agent.openOrCreateChat(taskConversationExternalId(ticketId));
			// 与研究回合同一套"跳过"：摘掉 lifediaryExt = 不注入记忆 / 不挂工具 / 不带人格。
			await agent.configureTaskChat(chat, renderTaskConversationPrompt(ticketId));
			chats.set(ticketId, chat);
			return chat;
		} catch (error) {
			// 原始错误只进服务端日志（可能带上游地址）；这里只记一行枚举式原因。
			warnOnce(ticketId, error instanceof Error ? error.message.slice(0, 120) : "unknown");
			return null;
		} finally {
			creating.delete(ticketId);
		}
	})();
	creating.set(ticketId, task);
	return task;
}

/**
 * 专线会话的对外 id（给前端回读用）。
 *
 * 刻意**不打开 durable**：外部 id 是确定性的 `task-<ticketId>`，未建过时
 * `GET /agent/chat/:id/messages` 自然 404。这样详情接口在无模型 / 单测环境里
 * 也不会拉起 Harness（拉起来会 resume 真实任务，代价与风险都不该由一次只读详情承担）。
 */
export function getTaskConversation(ticketId: string): { conversationId: string } | null {
	if (!taskAsConversationEnabled()) return null;
	return { conversationId: taskConversationExternalId(ticketId) };
}

/** 与 `sayInChat` 同款 assistant 条目形状：带 model 才进上下文，也能被 GET messages 回读。 */
function buildEntry(text: string): EntryDraft {
	const at = Date.now();
	return {
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
	};
}

async function writeTaskEvent(ticketId: string, entry: DelegationMirrorEntry): Promise<void> {
	const chat = await ensureTaskConversation(ticketId);
	if (!chat) return;
	try {
		await chat.conversation.submit({ type: "write", entry: buildEntry(entry.text) }, CTX);
	} catch (error) {
		// 缓存可能挂在已失效的 Harness 上：丢掉，下一次写入按自愈路径重开。
		chats.delete(ticketId);
		console.warn(
			`[task-conv] 写入失败 ticket=${short(ticketId)} kind=${entry.kind} reason=${
				error instanceof Error ? error.message.slice(0, 120) : "unknown"
			}`,
		);
	}
}

/**
 * 追加一条单的动态（进度 / 汇报 / 留言）。
 *
 * 返回 Promise 方便调用方按需等待；delegation 侧通过 `mirror` 同步调用、不等待
 * ——派活主链路不能被旁路簿记拖住。
 */
export function appendTaskEvent(ticketId: string, entry: DelegationMirrorEntry): Promise<void> {
	if (!taskAsConversationEnabled()) return Promise.resolve();
	const previous = queues.get(ticketId) ?? Promise.resolve();
	// 前一条失败也必须接着写：用 then 的两个分支，队列永不断链。
	const next = previous.then(
		() => writeTaskEvent(ticketId, entry),
		() => writeTaskEvent(ticketId, entry),
	);
	queues.set(ticketId, next);
	const done = (): void => {
		if (queues.get(ticketId) === next) queues.delete(ticketId);
	};
	void next.then(done, done);
	return next;
}

/** delegation 的 mirror 缝：签名与 `DelegationRuntime.mirror` 对齐。 */
export function taskConversationMirror(ticketId: string, entry: DelegationMirrorEntry): void {
	void appendTaskEvent(ticketId, entry);
}

/**
 * agent 中途播报的任务专线镜像（2026-11-10 批 13 §三.2）。
 *
 * 只有当前会话**正好是一条任务专线**时才写（没有这张单 = 什么也不做）。
 * 专线本身由系统写入，不伪造用户发言；播报仍以 `pi.assistant` 条目落，与进度同形。
 */
export function mirrorTaskNotice(conversationId: number, text: string): void {
	for (const [ticketId, chat] of chats) {
		if (chat.internalId === conversationId) {
			void appendTaskEvent(ticketId, { kind: "notice", text });
			return;
		}
	}
}

/**
 * 把主人的回话写进专线（真用户输入，忙时 followUp）。
 *
 * 只负责"进会话"这一半；"送到执行端"那一半仍由调用方走 `startDelegation` 的
 * 续跑链路——两件事由同一次 POST 驱动，语义分开，失败也能各自说明。
 */
export async function submitTaskReply(
	ticketId: string,
	text: string,
): Promise<ResolvedChat | null> {
	const chat = await ensureTaskConversation(ticketId);
	if (!chat) return null;
	try {
		await chat.conversation.submit(
			{ type: "input", content: text, whenBusy: "followUp" },
			CTX,
		);
		return chat;
	} catch (error) {
		chats.delete(ticketId);
		console.warn(
			`[task-conv] 回话写入失败 ticket=${short(ticketId)} reason=${
				error instanceof Error ? error.message.slice(0, 120) : "unknown"
			}`,
		);
		return null;
	}
}
