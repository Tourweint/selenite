/**
 * partner-runtime-do-open-partner-conversation
 *
 * 2026-11-14 从 partner-runtime.ts 的 L419–L781 整段切出；正文原文搬运，未改一行实现。
 * 内含：GreetingStatus / GreetingState / PartnerGreetingDoc / Claim …
 */

import type { ResolvedChat } from "./agent.ts";
import { chatStream, configureTaskChat, openOrCreateChat } from "./agent.ts";
import type { PartnerRow } from "./partners.ts";
import { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { isRelayEntryKind } from "./partner-relay.ts";
import type { ConversationId, Cursor, EntryDraft, JsonObject, Tx } from "@earendil-works/pi-durable";
import { InboxDoc, SettledSubmissionRecord, defineDoc } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CTX, GREETING_REQUEST, GREETING_REQUIREMENTS, ensurePartnerSession, partnerGreetingEnabled } from "./partner-runtime-run-partner-turn.ts";
import type { OpenPartnerConversationResult } from "./partner-runtime-run-partner-turn.ts";

type GreetingStatus = "idle" | "pending" | "ready" | "sent" | "skipped" | "failed";

interface GreetingState extends JsonObject {
	attempt: number;
	status: GreetingStatus;
	/** 生成用的隔离会话对外 id（task- 前缀，不进列表） */
	generationExternalId: string;
	/** 这一 attempt 的稳定 requestId：重启后复用同一 submission，不另跑模型 */
	requestId: string;
	text: string;
	updatedAt: string;
}

const PartnerGreetingDoc = defineDoc<GreetingState>({
	kind: "lifediary.partner-greeting",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({
		attempt: 0,
		status: "idle",
		generationExternalId: "",
		requestId: "",
		text: "",
		updatedAt: "",
	}),
	checkpointWhen: () => false,
});

type Claim =
	| { action: "existing" }
	| { action: "skipped" }
	| { action: "deliver"; text: string }
	| { action: "generate"; attempt: number; generationExternalId: string; requestId: string };

const greetingOpenings = new Map<string, Promise<OpenPartnerConversationResult>>();

export function openPartnerConversation(partnerId: string): Promise<OpenPartnerConversationResult> {
	const inflight = greetingOpenings.get(partnerId);
	if (inflight) return inflight;
	const opening = doOpenPartnerConversation(partnerId).finally(() => {
		greetingOpenings.delete(partnerId);
	});
	greetingOpenings.set(partnerId, opening);
	return opening;
}

async function doOpenPartnerConversation(
	partnerId: string,
): Promise<OpenPartnerConversationResult> {
	if (!COMPANIONS_ENABLED) return { ok: false, reason: "not_found" };
	// 总管不走这个入口（他的会话不是一个"执事专线"，也不该被自动问候）
	if (partnerId === CHIEF_PARTNER_ID) return { ok: false, reason: "chief" };
	const partner = partnersStore().get(partnerId);
	if (!partner) return { ok: false, reason: "not_found" };
	if (partner.status !== "active") return { ok: false, reason: "inactive" };

	let chat: ResolvedChat | null;
	try {
		chat = await ensurePartnerSession(partnerId);
	} catch (error) {
		console.warn(
			`[partner] 打开 ${partnerId} 的主会话失败: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { ok: false, reason: "unavailable" };
	}
	if (!chat) return { ok: false, reason: "unavailable" };

	if (!partnerGreetingEnabled()) return { ok: true, chat, greeting: "disabled" };

	let claim: Claim;
	try {
		claim = await claimGreeting(chat, partnerId);
	} catch (error) {
		console.warn(
			`[partner] 认领问候失败 ${partnerId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { ok: false, reason: "failed" };
	}
	if (claim.action === "existing") return { ok: true, chat, greeting: "existing" };
	if (claim.action === "skipped") return { ok: true, chat, greeting: "skipped" };
	if (claim.action === "deliver") {
		const outcome = await deliverGreeting(chat, claim.text).catch((error: unknown) => {
			console.warn(
				`[partner] 投递问候失败 ${partnerId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		});
		if (!outcome) return { ok: false, reason: "failed" };
		return { ok: true, chat, greeting: outcome === "sent" ? "sent" : outcome };
	}

	const generated = await generateGreeting(partnerId, partner, chat, claim);
	if (generated.kind === "text") {
		const outcome = await deliverGreeting(chat, generated.text).catch((error: unknown) => {
			console.warn(
				`[partner] 投递问候失败 ${partnerId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		});
		if (!outcome) return { ok: false, reason: "failed" };
		return { ok: true, chat, greeting: outcome === "sent" ? "sent" : outcome };
	}
	if (generated.kind === "terminal") {
		await markGreetingFailed(chat, claim.attempt).catch(() => undefined);
	}
	// 结果不确定（网络 / 进程异常）时保持 pending：下次点开复用同一 requestId，不换 id 重派
	return { ok: false, reason: "failed" };
}

async function hasDialogueInTx(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries(
			{ conversationId, order: "ascending" },
			200,
			cursor,
		);
		if (
			page.items.some(
				(entry) =>
					entry.kind === "pi.user" ||
					entry.kind === "pi.assistant" ||
					// 2026-11-15：同事递来的话也算"有过往来"，不然只有来信的会话会被再插一条问候
					isRelayEntryKind(entry.kind),
			)
		) {
			return true;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return false;
}

async function userSpokeInTx(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	if (await hasDialogueInTx(tx, conversationId)) return true;
	const inbox = await tx.doc(InboxDoc, conversationId);
	return inbox.items.some((item) => item.mode !== "write");
}

async function claimGreeting(chat: ResolvedChat, partnerId: string): Promise<Claim> {
	const conversationId = chat.conversation.id;
	return chat.conversation.commit(async (tx) => {
		const doc = await tx.doc(PartnerGreetingDoc, conversationId);
		if (doc.status === "sent") return { action: "existing" } as const;
		if (doc.status === "skipped") return { action: "skipped" } as const;

		// 已发起、还没投递的尝试（pending / 有文本的 ready）
		const attemptInFlight =
			doc.status === "pending" || (doc.status === "ready" && !!doc.text.trim());
		if (attemptInFlight && (await userSpokeInTx(tx, conversationId))) {
			doc.status = "skipped";
			doc.updatedAt = new Date().toISOString();
			console.log(`[partner] 问候跳过：canonical 已有用户活动（会话 ${chat.internalId}）`);
			return { action: "skipped" } as const;
		}

		if (doc.status === "ready" && doc.text.trim()) {
			return { action: "deliver", text: doc.text } as const;
		}
		if (doc.status === "pending" && doc.generationExternalId && doc.requestId) {
			// 重启 / 并发：同一 attempt 的生成会话与 submission 都还在，不另跑模型
			return {
				action: "generate",
				attempt: doc.attempt,
				generationExternalId: doc.generationExternalId,
				requestId: doc.requestId,
			} as const;
		}
		// 从未发起过问候的普通会话：保持 existing，不写 doc
		if (await hasDialogueInTx(tx, conversationId)) return { action: "existing" } as const;

		const attempt = doc.attempt + 1;
		const generationExternalId = `task-greeting-${conversationId}-${attempt}`;
		const requestId = randomUUID();
		doc.attempt = attempt;
		doc.status = "pending";
		doc.generationExternalId = generationExternalId;
		doc.requestId = requestId;
		doc.text = "";
		doc.updatedAt = new Date().toISOString();
		console.log(`[partner] ${partnerId.slice(0, 8)} 首次问候 attempt=${attempt}`);
		return { action: "generate", attempt, generationExternalId, requestId } as const;
	}, CTX);
}

type GenerationResult = { kind: "text"; text: string } | { kind: "terminal" } | { kind: "unknown" };

async function generateGreeting(
	partnerId: string,
	partner: PartnerRow,
	chat: ResolvedChat,
	claim: Extract<Claim, { action: "generate" }>,
): Promise<GenerationResult> {
	let generation: ResolvedChat;
	try {
		generation = await openOrCreateChat(claim.generationExternalId);
	} catch (error) {
		console.warn(
			`[partner] 问候生成会话打不开 ${partnerId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { kind: "unknown" };
	}

	const soul =
		partnersStore().readSoulFromHome(partnerId)?.trim() ||
		partner.name;
	try {
		await configureTaskChat(generation, [soul, GREETING_REQUIREMENTS].join("\n\n"));
	} catch (error) {
		console.warn(
			`[partner] 问候会话配置失败 ${partnerId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { kind: "unknown" };
	}

	let text = "";
	let record: SettledSubmissionRecord | null = null;
	let unanswered = false;
	try {
		for await (const event of chatStream({
			conversation: generation.conversation,
			text: GREETING_REQUEST,
			// 稳定 requestId：重启后同一 attempt 的 submission 会被认成同一轮
			requestId: claim.requestId,
			onSettled: (settled) => {
				record = settled;
			},
		})) {
			if (event.type === "delta") text += event.text;
			else if (event.type === "unanswered") unanswered = true;
		}
	} catch (error) {
		// 结果不确定：保持 pending（不能换 id 重派，否则可能双跑）
		console.warn(
			`[partner] 问候生成异常 ${partnerId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { kind: "unknown" };
	}

	const settled = record as SettledSubmissionRecord | null;
	if (settled?.status === "unanswered" || unanswered) return { kind: "terminal" };
	if (!text.trim()) return settled?.status === "done" ? { kind: "terminal" } : { kind: "unknown" };

	const ready = await markGreetingReady(chat, claim.attempt, text.trim());
	if (!ready) return { kind: "unknown" };
	return { kind: "text", text: text.trim() };
}

async function markGreetingReady(
	chat: ResolvedChat,
	attempt: number,
	text: string,
): Promise<boolean> {
	try {
		await chat.conversation.commit(async (tx) => {
			const doc = await tx.doc(PartnerGreetingDoc, chat.conversation.id);
			if (doc.attempt !== attempt || doc.status !== "pending") return;
			doc.status = "ready";
			doc.text = text;
			doc.updatedAt = new Date().toISOString();
		}, CTX);
		return true;
	} catch (error) {
		console.warn(
			`[partner] 问候文本落盘失败: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

async function markGreetingFailed(chat: ResolvedChat, attempt: number): Promise<void> {
	await chat.conversation.commit(async (tx) => {
		const doc = await tx.doc(PartnerGreetingDoc, chat.conversation.id);
		if (doc.attempt !== attempt || doc.status !== "pending") return;
		doc.status = "failed";
		doc.updatedAt = new Date().toISOString();
	}, CTX);
}

async function deliverGreeting(
	chat: ResolvedChat,
	text: string,
): Promise<"sent" | "skipped" | "existing"> {
	return chat.conversation.commit(async (tx) => {
		const doc = await tx.doc(PartnerGreetingDoc, chat.conversation.id);
		if (doc.status === "sent") return "existing" as const;
		if (doc.status === "skipped") return "skipped" as const;
		if (doc.status !== "ready") return "existing" as const;

		// 生成期间用户抢先说了话（entry 或已受理未落盘的 input）→ 问候作废
		if (await userSpokeInTx(tx, chat.conversation.id)) {
			doc.status = "skipped";
			doc.updatedAt = new Date().toISOString();
			console.log(`[partner] 问候跳过：canonical 已有用户活动（会话 ${chat.internalId}）`);
			return "skipped" as const;
		}

		// 与 sayInChat 同一合法 entry 形状（pi.assistant，带 model 才进上下文）
		const entry: EntryDraft = {
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
					timestamp: Date.now(),
				},
			],
		};
		await tx.appendEntry(chat.conversation.id, entry);
		doc.status = "sent";
		doc.text = text;
		doc.updatedAt = new Date().toISOString();
		console.log(`[partner] 问候已写入会话 ${chat.internalId}（${text.length} 字）`);
		return "sent" as const;
	}, CTX);
}

export { PartnerGreetingDoc, claimGreeting, deliverGreeting, doOpenPartnerConversation, generateGreeting, greetingOpenings, hasDialogueInTx, markGreetingFailed, markGreetingReady, userSpokeInTx };
export type { Claim, GenerationResult, GreetingState, GreetingStatus };
