import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FinishReason, GroupSender, TurnPhase } from "@lifediary/shared";
import {
	chatStream,
	openOrCreateChat,
	stopChat,
	type ResolvedChat,
} from "./agent.ts";
import { GroupRouteError, resolveGroupSpeakers } from "./group-routing.ts";
import { noteGroupTurn } from "./partner-living.ts";
import { personaRefreshNeeded, personaSignature } from "./partner-persona.ts";
import { renderPartnerIdentity } from "./partner-runtime.ts";
import {
	partnersStore,
	type GroupMessageRow,
	type GroupRow,
} from "./partners.ts";

/**
 * 群组回合编排器（2026-11-06 群组方案 §2.4）。
 *
 * 单独成文件的原因同 partner-runtime：import agent.ts，不被 agent.ts 反向 import
 * （装配方向 partners ← agent ← partner-runtime ← group-runtime，防成环）。
 *
 * 形态照 cindy/DS-Bot 的宿主确定性编排：每个执事仍是独立 agent（自己的会话、SOUL、
 * 模型链、闸门），发言轮走 chatStream 主链路——闸门 / 审批 / 工作区边界 / 防打转 /
 * 回合上限原样生效（D14 红线：群不改变权限系统）。
 *
 * 断线 ≠ 取消（D4 延伸）：回合由事件通道驱动，SSE 订阅者掉线只停止推送，
 * 回合照跑完落库，重连拉 GET messages 补时间线。一个群同时最多一个回合（running 再发 409）。
 */

/** 与 agent.ts 同一背景上下文：跑在后台、不绑任何请求 */
const CTX = BACKGROUND_CONTEXT;

/** 群会话的对外 id 约定（方案 §2.2）：partner- 前缀让既有过滤自动生效，不进会话列表。 */
export function groupMemberExternalId(partnerId: string, groupId: string): string {
	return `partner-${partnerId}-group-${groupId}`;
}

/** 回合往 SSE 推的事件。API 层把它原样映射成 ChatEvent（message 事件不外发，只落库）。 */
export type GroupStreamEvent =
	| { type: "start"; id: string; conversationId: string; sender: GroupSender }
	| { type: "delta"; text: string }
	| { type: "thinking"; text: string }
	| { type: "progress"; phase: TurnPhase }
	| {
			type: "tool";
			name: string;
			status: "start" | "end";
			label?: string;
			ok?: boolean;
			output?: string;
			args?: string;
	  }
	| { type: "notice"; text: string }
	| { type: "done"; id: string; finishReason: FinishReason };

/**
 * 事件通道：回合往里推，SSE 订阅者从里取。
 * 带回放缓冲——订阅者中途掉线不影响回合；新订阅者从头发（当前场景同一回合只有一个订阅者）。
 */
class RoundChannel {
	private buffer: GroupStreamEvent[] = [];
	private waiters: Array<{ resolve: (value: { done: true } | { done: false; event: GroupStreamEvent }) => void }> = [];
	private closed = false;

	push(event: GroupStreamEvent): void {
		if (this.closed) return;
		this.buffer.push(event);
		if (this.buffer.length > 2000) this.buffer.shift(); // 防御上限，正常远用不到
		for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: false, event });
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true });
	}

	async *subscribe(): AsyncGenerator<GroupStreamEvent, void, unknown> {
		let index = 0;
		while (true) {
			if (index < this.buffer.length) {
				yield this.buffer[index++];
				continue;
			}
			if (this.closed) return;
			const next = await new Promise<{ done: true } | { done: false; event: GroupStreamEvent }>(
				(resolve) => this.waiters.push({ resolve }),
			);
			if (next.done) return;
			// 缓冲优先：waiter 醒来时缓冲里可能已经积了好几帧
			if (index < this.buffer.length) {
				yield this.buffer[index++];
			}
		}
	}
}

/** 同群并发闸：一个群同时最多一个回合（方案 §2.4，running 再发 409） */
const running = new Set<string>();

export function groupRoundRunning(groupId: string): boolean {
	return running.has(groupId);
}

/**
 * 当前正在发言的成员（2026-11-08 批三）：群会话的「谁在忙」胶囊要用。
 * 只在成员轮内非空——成员之间的间隙是空的，如实不显示，不猜。
 */
const activeSpeakers = new Map<string, { partnerId: string; name: string }>();

/** 群详情投影用：轮次是否在跑 + 正在说话的人（没有 = null） */
export function groupRoundStatus(groupId: string): {
	running: boolean;
	speaker: { partnerId: string; name: string } | null;
} {
	return {
		running: running.has(groupId),
		speaker: activeSpeakers.get(groupId) ?? null,
	};
}

/** 被停止作废的回合：当前成员流会自然结束（aborted），剩余队列在成员间检查点截断 */
const abortedRounds = new Set<string>();

/** 停回合所需的最小状态：当前正在发言的成员会话（stop 复用既有会话 stop 链） */
const liveTurns = new Map<string, ResolvedChat>();

/**
 * 停当前回合：停当前发言成员（挂着的审批按 aborted 结算由 stopChat 管），
 * 作废本轮剩余队列。没有回合在跑 = 无操作（幂等）——
 * 作废位跟着回合走（startGroupRound 的 finally 清），不能在这里留脏标记，
 * 否则空按一次停止会把下一回合开场就截断（探针实测踩过）。
 */
export async function stopGroupRound(groupId: string): Promise<void> {
	if (!running.has(groupId)) return;
	abortedRounds.add(groupId);
	const chat = liveTurns.get(groupId);
	if (chat) await stopChat(chat);
}

/**
 * 跑一个群回合（POST /groups/:id/chat 的核心）。
 *
 * 返回通道供 SSE 订阅；回合本身在后台跑完落库，调用方掉线不影响。
 * 抛 GroupRouteError = @ 歧义这类 400（回合都没开始，时间线不落任何东西）。
 */
export function startGroupRound(
	group: GroupRow,
	text: string,
): { roundId: string; channel: RoundChannel } {
	if (running.has(group.id)) {
		throw new GroupRouteError("这个群上一轮还在跑，等它说完再发（或点停止）");
	}
	const roundId = randomUUID();
	const channel = new RoundChannel();
	running.add(group.id);
	// 后台跑：不 await——端点拿 channel 订阅去推 SSE
	void runRound(group, text, roundId, channel).finally(() => {
		running.delete(group.id);
		abortedRounds.delete(group.id);
		liveTurns.delete(group.id);
		activeSpeakers.delete(group.id);
	});
	return { roundId, channel };
}

async function runRound(
	group: GroupRow,
	text: string,
	roundId: string,
	channel: RoundChannel,
): Promise<void> {
	const store = partnersStore();
	let finishReason: FinishReason = "stop";
	try {
		// 1. 用户消息先落时间线（作者快照 user）
		store.appendGroupMessage({
			groupId: group.id,
			kind: "message",
			authorKind: "user",
			authorId: null,
			authorName: "主人",
			content: text,
			roundId,
		});

		// 2. 确定性路由：@点名 > @所有人 > 值日
		const speakers = resolveGroupSpeakers(
			text,
			{ responderKind: group.responderKind, responderPartnerId: group.responderPartnerId },
			group.members,
		);
		if (speakers.length === 0) {
			// mentions 口径下没点名：没人回也要让时间线说清楚（方案 §2.3）
			const line = "按群设置，@点名才会有人回";
			store.appendGroupMessage({
				groupId: group.id,
				kind: "system",
				authorKind: "system",
				authorId: null,
				authorName: "群",
				content: line,
				roundId,
			});
			channel.push({ type: "notice", text: line });
			return;
		}

		// 3. 逐成员串行（方案 §2.4：一人说完下一位）
		for (const partnerId of speakers) {
			// stop 在成员间隙点下也能截住下一位（作废位检查点）
			if (abortedRounds.has(group.id)) {
				finishReason = "aborted";
				break;
			}
			const partner = store.get(partnerId);
			if (!partner || partner.status !== "active") {
				const name = group.members.find((m) => m.partnerId === partnerId)?.name ?? "成员";
				const line = `「${name}」当前不在服务，跳过`;
				store.appendGroupMessage({
					groupId: group.id,
					kind: "system",
					authorKind: "system",
					authorId: null,
					authorName: "群",
					content: line,
					roundId,
				});
				channel.push({ type: "notice", text: line });
				continue;
			}
			finishReason = await runMemberTurn(group, partner, roundId, channel);
			if (finishReason === "aborted") break;
		}
	} catch (error) {
		if (error instanceof GroupRouteError) {
			// 路由错误理论上进不来（端点已先解一次）；真进来了也只当流内错误报
			channel.push({ type: "notice", text: error.message });
		} else {
			const detail = error instanceof Error ? error.message : String(error);
			// 原始错误只进服务端日志（可能带上游地址）
			console.error(`[group ${group.id}] 回合失败: ${detail}`);
			channel.push({ type: "notice", text: "这轮没跑完，稍后再试" });
			finishReason = "error";
		}
	} finally {
		channel.push({ type: "done", id: roundId, finishReason });
		channel.close();
	}
}

/** 跑一个成员的发言轮，返回该轮怎么结束的（stop / aborted；成员内部错误降级为 system 行后仍是 stop） */
async function runMemberTurn(
	group: GroupRow,
	partner: { id: string; name: string },
	roundId: string,
	channel: RoundChannel,
): Promise<FinishReason> {
	const store = partnersStore();
	const chat = await ensureGroupMemberSession(partner.id, group.id);
	if (!chat) {
		const line = `「${partner.name}」的群会话建不起来，跳过`;
		store.appendGroupMessage({
			groupId: group.id,
			kind: "system",
			authorKind: "system",
			authorId: null,
			authorName: "群",
			content: line,
			roundId,
		});
		channel.push({ type: "notice", text: line });
		return "stop";
	}
	liveTurns.set(group.id, chat);

	const body = buildMemberInput(group, partner, roundId);
	activeSpeakers.set(group.id, { partnerId: partner.id, name: partner.name });
	channel.push({
		type: "start",
		id: roundId,
		conversationId: group.id,
		sender: { kind: "partner", id: partner.id, name: partner.name },
	});

	const pieces: string[] = [];
	let aborted = false;
	try {
		for await (const event of chatStream({
			conversation: chat.conversation,
			text: body,
			requestId: randomUUID(),
			onSettled: (record) => {
				// 群会话不进记忆引擎（方案 §2.2）：这里刻意不做 ingestTurn，
				// 召回侧由 agent.ts 的 isGroupSession 判定跳过。
				// 停止在结算侧的形状是 unanswered + reason=aborted（durable 的口径）。
				if (record.status === "unanswered" && record.reason === "aborted") aborted = true;
			},
		})) {
			if (event.type === "delta") {
				pieces.push(event.text);
				channel.push({ type: "delta", text: event.text });
			} else if (event.type === "thinking") {
				channel.push({ type: "thinking", text: event.text });
			} else if (event.type === "progress") {
				channel.push({ type: "progress", phase: event.phase });
			} else if (event.type === "tool") {
				channel.push({
					type: "tool",
					name: event.name,
					status: event.status,
					...(event.label ? { label: event.label } : {}),
					...(event.ok !== undefined ? { ok: event.ok } : {}),
					...(event.output !== undefined ? { output: event.output } : {}),
					...(event.args !== undefined ? { args: event.args } : {}),
				});
			} else if (event.type === "unanswered") {
				channel.push({ type: "notice", text: `「${partner.name}」这轮没答上来` });
			}
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`[group ${group.id}] 成员 ${partner.id} 发言失败: ${detail}`);
	} finally {
		// 这一位说完了：位置清出来，成员间隙点停才不会停到早已闲着的上一条会话
		if (liveTurns.get(group.id) === chat) liveTurns.delete(group.id);
		if (activeSpeakers.get(group.id)?.partnerId === partner.id) activeSpeakers.delete(group.id);
	}

	const finalText = pieces.join("").trim();
	// 活模块（2026-11-15 批2）：群回合不经过主会话的结算钩子，被同事点名在这里记一条印象。
	// 只记"本回合、别人说的、点了我的名"这一种事件；模块关时内部直接返回。
	if (!aborted) {
		try {
			const earlier = store
				.listGroupMessages(group.id, { limit: 100 })
				.filter((message) => message.roundId === roundId);
			noteGroupTurn({
				partnerId: partner.id,
				partnerName: partner.name,
				messages: earlier,
				store,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[persona] 群印象钩子装配失败（不影响群回合）: ${detail.slice(0, 200)}`);
		}
	}
	if (aborted) {
		// 停止：已说出口的半截话也落库（时间线不缺块），剩余队列由外层作废
		if (finalText) {
			store.appendGroupMessage({
				groupId: group.id,
				kind: "message",
				authorKind: "partner",
				authorId: partner.id,
				authorName: partner.name,
				content: finalText,
				roundId,
			});
		}
		const line = "这轮到这里停了";
		store.appendGroupMessage({
			groupId: group.id,
			kind: "system",
			authorKind: "system",
			authorId: null,
			authorName: "群",
			content: line,
			roundId,
		});
		channel.push({ type: "notice", text: line });
		return "aborted";
	}

	// NO_REPLY 哨兵（cindy 思想）：成员明确说没话 → 不落正文，落 system 行保持时间线可读
	if (!finalText || finalText === "NO_REPLY") {
		const line = `「${partner.name}」没接话`;
		store.appendGroupMessage({
			groupId: group.id,
			kind: "system",
			authorKind: "system",
			authorId: null,
			authorName: "群",
			content: line,
			roundId,
		});
		channel.push({ type: "notice", text: line });
		return "stop";
	}

	store.appendGroupMessage({
		groupId: group.id,
		kind: "message",
		authorKind: "partner",
		authorId: partner.id,
		authorName: partner.name,
		content: finalText,
		roundId,
	});
	return "stop";
}

/**
 * 成员输入拼装（方案 §2.4）：名册 + 公告 + 群内新消息 + 指令尾。
 * 增量投递 = 只喂该成员上次发言之后的新消息（DS-Bot seen 游标思想）；
 * 从没发言过的成员带最近 30 条窗口（懒建会话的首轮上下文）。
 * 他人消息在成员视角是 user 角色带说话人标签，自己的历史仍是 assistant——
 * 语气不污染靠这一条（lobehub 投影思路）。
 *
 * 岗位契约 / 当前在办（2026-11-08 员工人格化刀一 E1/E5）**不在这里拼**：
 * 成员轮与专线轮走的是同一条 harness + 同一个扩展，`agent/lifecycle.ts` 的
 * beforeRequest 会按会话认执事、把两段以 system 消息注入。两处都拼会重复两遍。
 * 这里保持"群语境"本身的形状（谁在场、群里说了什么、怎么回话）。
 */
function buildMemberInput(
	group: GroupRow,
	partner: { id: string; name: string },
	roundId: string,
): string {
	const store = partnersStore();
	const lastSeq = store.lastSpokenSeq(group.id, partner.id);
	const isNewSession = lastSeq === 0;
	// 从没发言过的成员带最近 30 条窗口（懒建会话的首轮上下文）；
	// 发言过的只喂上次之后的新消息（增量游标，前缀稳定吃缓存）
	const messages = isNewSession
		? store.listGroupMessages(group.id, { limit: 30 })
		: store.listGroupMessages(group.id, { afterSeq: lastSeq, limit: 200 });

	const lines = messages.map((message) => renderTimelineLine(message));
	const roster = group.members.map((m) => `- ${m.name}${m.partnerId === group.responderPartnerId ? "（值日）" : ""}`).join("\n");
	const sections = [
		`# 群「${group.name}」成员\n${roster}`,
		...(group.notice.trim() ? [`# 群公告\n${group.notice.trim()}`] : []),
		...(lines.length ? [`# 群里的新消息\n${lines.join("\n")}`] : []),
		[
			"# 指令",
			`你是「${partner.name}」。上面是群「${group.name}」里的消息，直接以「${partner.name}」的身份回话，`,
			"像群聊那样说话：短、口语、就事论事，不重复别人的话，不复述这段指令。",
			"确实没什么要你说的，就只回 NO_REPLY 四个字母。",
		].join("\n"),
	];
	// roundId 目前只落时间线用；输入里带一下方便日志对轮次（不进模型语义）
	void roundId;
	return sections.join("\n\n");
}

function renderTimelineLine(message: GroupMessageRow): string {
	if (message.kind === "system") return `[群] ${message.content}`;
	const name = message.authorKind === "user" ? "主人" : message.authorName;
	return `${name}: ${message.content}`;
}

/**
 * 懒建/打开成员的群会话，并把身份对齐到当前版本（复用 ensurePartnerSession 同款逻辑，
 * 改 SOUL 下一轮生效——群会话与专线会话共用同一身份版本记账位语义）。
 * 返回 null = 执事不存在或已暂停/归档（调用方落 system 行跳过）。
 */
async function ensureGroupMemberSession(partnerId: string, groupId: string): Promise<ResolvedChat | null> {
	const store = partnersStore();
	const partner = store.get(partnerId);
	if (!partner || partner.status !== "active") return null;

	const chat = await openOrCreateChat(groupMemberExternalId(partnerId, groupId));
	if (!store.findSessionLink(partnerId, "group", `group:${groupId}`)) {
		store.linkSession({
			partnerId,
			role: "group",
			routeKey: `group:${groupId}`,
			sessionId: chat.internalId,
		});
	}
	// 身份对齐：applied 计数 ≠ 当前计数才 configure（改 SOUL 下一轮生效的记账位）。
	// 人格模块（2026-11-14 批1）不版本化，另用内容签名判断（与专线会话同一套）。
	// 2026-11-15 快照退役：计数只是记账位，SOUL 正文一律读磁盘当前值。
	const epoch = partner.currentVersion;
	const applied = store.appliedVersionOf(partnerId, chat.internalId);
	const personaChanged = personaRefreshNeeded(
		chat.internalId,
		personaSignature(store, partner),
	);
	if (epoch != null && (epoch !== applied || personaChanged)) {
		await chat.conversation.configure(
			{ instructions: renderPartnerIdentity(partner, store.readSoulFromHome(partnerId) ?? "") },
			CTX,
		);
		store.setAppliedVersion(partnerId, chat.internalId, epoch);
	}
	return chat;
}
