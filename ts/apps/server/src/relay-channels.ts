import { randomUUID } from "node:crypto";
import type { ChatIndexEntry } from "./agent.ts";
import type { ChatEventStore } from "./chat-events.ts";
import type { ApprovalStore } from "./approvals.ts";
import type { MatrixChannels } from "./relay-matrix.ts";
import { RelayInvokeError } from "./relay-client.ts";

/**
 * 中继通道层（2026-11-05 多端同步方案块1，阶段一）。
 *
 * 被控端的权威校验层：**白名单默认拒绝**——不在这张表里的通道一律
 * `channel_not_allowed`（兼作能力探测信号）。cindy 的三道 gate 里 v1 取两道：
 * 总开关（RELAY_ENABLED）+ 通道白名单；逐设备撤权在中继侧（撤销 → 中继踢连接）。
 *
 * 事件订阅走"读重放库"而非挂内核热路径：聊天事件本来就是先落库再外发
 * （persist-before-publish），250ms 轮询重放库就是完整事件流，热路径零改动。
 * 窗口滑过（from > lastSeq+1）时整段重发并标 resync，客户端按全量重建处理。
 */

export const RELAY_INVOKE_CHANNELS = [
	"info/probe",
	"sessions/list",
	"chat/send",
	"events/subscribe",
	"events/unsubscribe",
	"approvals/pending",
	"approvals/answer",
] as const;

/** 阶段二（设备矩阵）通道：仅 DEVICE_MATRIX_ENABLED 时进白名单。 */
export const RELAY_MATRIX_CHANNELS = [
	"delegation/accept",
	"delegation/status",
	// 自动挑机的忙碌位查询（2026-11-05）：发起端问目标机"你在跑几单"
	"delegation/busy",
] as const;

const SUB_POLL_INTERVAL_MS = 250;

export interface RelayChannelDeps {
	version: string;
	listChats: (limit?: number) => Promise<ChatIndexEntry[]>;
	/** 对外 uuid → 内部自增 id（猜不到的 uuid 才能防越权读） */
	resolveInternalId: (conversationId: string) => Promise<number | null>;
	/** 内部自增 id → 对外 uuid（审批清单回给控制端时用） */
	externalOf: (internalId: number) => Promise<string | null>;
	sayInConversation: (internalId: number, text: string) => Promise<boolean>;
	eventStore: ChatEventStore | null;
	approvals: () => ApprovalStore;
	/** 阶段三：chat/send 前的执事降级守卫；返回非空字符串 = 拒绝原因 */
	chatSendGuard?: (conversationId: string) => Promise<string | null>;
}

interface Subscription {
	id: string;
	src: string;
	conversationId: string;
	internalId: number;
	lastSeq: number;
	timer: ReturnType<typeof setInterval>;
}

export class RelayChannelHub {
	private readonly subs = new Map<string, Subscription>();

	constructor(
		private readonly deps: RelayChannelDeps,
		private readonly push: (dst: string, channel: string, payload: unknown) => void,
		private readonly matrix?: MatrixChannels,
	) {}

	/** 交给 RelayClient 的 onInvoke。 */
	async handle(src: string, channel: string, payload: unknown): Promise<unknown> {
		const matrixChannel = (RELAY_MATRIX_CHANNELS as readonly string[]).includes(channel);
		if (matrixChannel && !this.matrix) {
			throw new RelayInvokeError("channel_not_allowed", `通道未开放：${channel}`);
		}
		if (!matrixChannel && !(RELAY_INVOKE_CHANNELS as readonly string[]).includes(channel)) {
			throw new RelayInvokeError("channel_not_allowed", `通道未开放：${channel}`);
		}
		if (matrixChannel && this.matrix) {
			if (channel === "delegation/accept") return this.matrix.accept(payload);
			if (channel === "delegation/busy") return this.matrix.busy();
			return this.matrix.status(payload);
		}
		switch (channel) {
			case "info/probe":
				return {
					name: "lifediary-harness",
					version: this.deps.version,
					seqEnabled: this.deps.eventStore !== null,
				};
			case "sessions/list": {
				const limitRaw = (payload as { limit?: unknown } | null)?.limit;
				const limit =
					typeof limitRaw === "number" && Number.isFinite(limitRaw)
						? Math.min(Math.max(Math.floor(limitRaw), 1), 200)
						: 50;
				return { chats: await this.deps.listChats(limit) };
			}
			case "chat/send": {
				const body = payload as { conversationId?: unknown; text?: unknown } | null;
				const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
				const text = typeof body?.text === "string" ? body.text : "";
				if (!conversationId || !text.trim()) {
					throw new RelayInvokeError("bad_request", "需要 conversationId 与 text");
				}
				const guardReason = await this.deps.chatSendGuard?.(conversationId);
				if (guardReason) throw new RelayInvokeError("remote_disabled", guardReason);
				const internalId = await this.deps.resolveInternalId(conversationId);
				if (internalId === null) throw new RelayInvokeError("bad_request", "会话不存在");
				const accepted = await this.deps.sayInConversation(internalId, text);
				if (!accepted) throw new RelayInvokeError("bad_request", "会话不存在");
				return { accepted: true };
			}
			case "events/subscribe":
				return this.subscribe(src, payload);
			case "events/unsubscribe": {
				const id = (payload as { subscriptionId?: unknown } | null)?.subscriptionId;
				if (typeof id === "string") this.subs.delete(id);
				return { ok: true };
			}
			case "approvals/pending": {
				const raw = (payload as { conversationId?: unknown } | null)?.conversationId;
				const store = this.deps.approvals();
				const records =
					typeof raw === "string" && raw
						? await (async () => {
								const internalId = await this.deps.resolveInternalId(raw);
								return internalId === null ? [] : store.pendingOf(internalId);
							})()
						: store.pendingAll();
				const approvals = await Promise.all(
					records.map(async (record) => ({
						callId: record.callId,
						conversationId: await this.deps.externalOf(record.conversationId),
						tool: record.tool,
						args: record.args,
						createdAt: record.createdAt,
						deadlineAt: record.deadlineAt,
					})),
				);
				return { approvals };
			}
			case "approvals/answer": {
				const body = payload as { callId?: unknown; decision?: unknown; remember?: unknown } | null;
				const callId = typeof body?.callId === "string" ? body.callId : "";
				const decision = body?.decision === "approve" ? "approve" : body?.decision === "reject" ? "reject" : null;
				if (!callId || !decision) throw new RelayInvokeError("bad_request", "需要 callId 与 decision");
				const record = this.deps.approvals().decide(callId, decision, body?.remember === true);
				return { ok: record !== null, status: record?.status ?? null };
			}
			default:
				throw new RelayInvokeError("channel_not_allowed", `通道未开放：${channel}`);
		}
	}

	private async subscribe(src: string, payload: unknown): Promise<unknown> {
		const body = payload as { conversationId?: unknown; sinceSeq?: unknown } | null;
		const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
		if (!conversationId) throw new RelayInvokeError("bad_request", "需要 conversationId");
		const store = this.deps.eventStore;
		if (!store) throw new RelayInvokeError("internal", "SSE seq 已关闭（AGENT_SSE_SEQ=off），订阅不可用");
		const internalId = await this.deps.resolveInternalId(conversationId);
		if (internalId === null) throw new RelayInvokeError("bad_request", "会话不存在");

		const sinceSeq = typeof body?.sinceSeq === "number" && Number.isFinite(body.sinceSeq) ? Math.floor(body.sinceSeq) : 0;
		const subId = randomUUID();
		const replay = store.replaySince(internalId, sinceSeq);
		const lastSeq = replay.events.length > 0 ? replay.from + replay.events.length - 1 : sinceSeq;

		const timer = setInterval(() => void this.pump(subId), SUB_POLL_INTERVAL_MS);
		timer.unref?.();
		this.subs.set(subId, {
			id: subId,
			src,
			conversationId,
			internalId,
			lastSeq,
			timer,
		});
		return {
			subscriptionId: subId,
			from: replay.from,
			events: replay.events,
		};
	}

	private async pump(subId: string): Promise<void> {
		const sub = this.subs.get(subId);
		const store = this.deps.eventStore;
		if (!sub || !store) return;
		const replay = store.replaySince(sub.internalId, sub.lastSeq);
		if (replay.events.length === 0) return;
		// 窗口滑过：重放库只留最近 KEEP 条，from 跳跃说明有帧补不回来，
		// 整段从 0 重发并标 resync，控制端按全量重建处理（方案 §四阶段一）。
		const gap = replay.from > sub.lastSeq + 1;
		if (gap) {
			const full = store.replaySince(sub.internalId, 0);
			sub.lastSeq = full.events.length > 0 ? full.from + full.events.length - 1 : sub.lastSeq;
			this.push(sub.src, pushChannelOf(sub.conversationId), {
				conversationId: sub.conversationId,
				from: full.from,
				resync: true,
				events: full.events,
			});
			return;
		}
		sub.lastSeq = replay.from + replay.events.length - 1;
		this.push(sub.src, pushChannelOf(sub.conversationId), {
			conversationId: sub.conversationId,
			from: replay.from,
			events: replay.events,
		});
	}

	stop(): void {
		for (const [, sub] of this.subs) clearInterval(sub.timer);
		this.subs.clear();
	}

	get subscriptionCount(): number {
		return this.subs.size;
	}
}

/** 事件推送通道名：push/session:<对外 uuid> */
export function pushChannelOf(conversationId: string): string {
	return `push/session:${conversationId}`;
}
