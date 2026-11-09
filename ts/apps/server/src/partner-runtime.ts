import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, defineDoc, type ConversationId, type Cursor, type EntryDraft, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import {
	CHIEF_PARTNER_ID,
	COMPANIONS_ENABLED,
	partnersStore,
	type PartnerRow,
} from "./partners.ts";
import { markAutonomyTurn, unmarkAutonomyTurn } from "./autonomy-state.ts";
import {
	clearUnattendedSkips,
	markRoutineTurn,
	takeUnattendedSkips,
	unmarkRoutineTurn,
} from "./unattended.ts";
import {
	assessRoutineOutput,
	ROUTINE_QUIET_INSTRUCTION,
	routineQuietEnabled,
} from "./routine-quiet.ts";
import { nextChainCandidate } from "./model-chain.ts";
import type { SettledSubmissionRecord } from "@earendil-works/pi-durable";
import {
	chatStream,
	configureTaskChat,
	openOrCreateChat,
	type ResolvedChat,
} from "./agent.ts";

/** 与 agent.ts 同一背景上下文：跑在后台、不绑任何请求 */
const CTX = BACKGROUND_CONTEXT;

/**
 * 执事的**会话运行时**（2026-11-05 批次B B2）。
 *
 * 单独成文件的原因：它要 import agent.ts（openOrCreateChat / chatStream），
 * 而 agent.ts 不能反向 import 它（装配方向 partners ← agent ← partner-runtime，
 * 反过来就成环）。storage 在 partners.ts，"怎么跑"在这里。
 *
 * 身份契约（照 cindy，双层）：每轮开跑前对一次版本——
 *   会话链接上记 `appliedVersion`（最近一次配进会话的身份版本），
 *   档案上记 `currentVersion`（最新快照）；两者不等 = SOUL 改过还没生效 →
 *   开跑前 configure 一次。**改完 SOUL 下一轮生效**，这是设计出来的不一致。
 */

/** 执事主会话的对外 id 约定。它是一条真会话：历史可回读、出现在会话列表里。 */
export function partnerCanonicalExternalId(partnerId: string): string {
	return `partner-${partnerId}`;
}

/** 执事身份提示词：SOUL 快照（认版本号）+ USER.md 摘要 + 技能索引。 */
export function renderPartnerIdentity(partner: PartnerRow, soulSource: string): string {
	const store = partnersStore();
	const sections: string[] = [soulSource.trim()];

	const userMd = store.readUserMd(partner.id);
	if (userMd && userMd.trim()) {
		sections.push(
			["# 主人画像（memories/USER.md）", userMd.trim()].join("\n\n"),
		);
	}

	const skills = partnerSkillsIndex(partner.id);
	if (skills) sections.push(skills);

	sections.push(
		[
			"# 运行边界",
			"- 你的记忆与技能独立于主人的助手；写文件默认落在你的 workspace/。",
			"- 需要长期记住的事用 remember（会自动记到你的键空间）；把流程沉淀成技能用 partner_skill_write。",
		].join("\n"),
	);
	return sections.join("\n\n");
}

/** 执事技能索引：目录约定与全局 skills/ 相同（*.md，第 1 行 = 索引摘要）。 */
function partnerSkillsIndex(partnerId: string): string | undefined {
	const dir = partnersStore().skillsDirOf(partnerId);
	if (!existsSync(dir)) return undefined;
	const names = readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
	if (names.length === 0) return undefined;
	const lines = names.map((file) => {
		const raw = partnersStore().readHomeFile(partnerId, join("skills", file)) ?? "";
		const summary = raw.split("\n", 1)[0]?.trim() || file.replace(/\.md$/, "");
		return `- ${file.replace(/\.md$/, "")}：${summary.slice(0, 72)}`;
	});
	return ["# 技能索引（完整手册用 partner 技能名取，直接读 skills/<名>.md）", ...lines].join(
		"\n",
	);
}

/**
 * 同 partner 的 canonical 创建单飞（2026-11-06 侧栏调整 B3）。
 *
 * `openOrCreateChat` 是 check-then-create：两个并发的 open（双击 / 多标签页）都会看到
 * "还没有"，各建一条 `partner-<id>` 会话，链接表只记住后写的一条，前一条就成了孤儿。
 * 这不是全局调度，只收敛同一 partner 的创建窗口（窗口结束立刻出表）。
 */
const sessionOpenings = new Map<string, Promise<ResolvedChat | null>>();

export function ensurePartnerSession(partnerId: string): Promise<ResolvedChat | null> {
	const inflight = sessionOpenings.get(partnerId);
	if (inflight) return inflight;
	const opening = openPartnerSession(partnerId).finally(() => {
		sessionOpenings.delete(partnerId);
	});
	sessionOpenings.set(partnerId, opening);
	return opening;
}

/**
 * 取/建执事主会话，并把身份对齐到当前版本。
 * 返回 null = 执事不存在或已暂停/归档（调用方回 404 / 409）。
 */
async function openPartnerSession(partnerId: string): Promise<ResolvedChat | null> {
	if (!COMPANIONS_ENABLED) return null;
	const store = partnersStore();
	const partner = store.get(partnerId);
	if (!partner || partner.status !== "active") return null;

	const chat = await openOrCreateChat(partnerCanonicalExternalId(partnerId));
	// 主会话链接：一次登记，之后 scopeOf / partnerOfConversation 靠它识别这条会话归谁
	if (!store.findSessionLink(partnerId, "canonical", "canonical")) {
		store.linkSession({
			partnerId,
			role: "canonical",
			routeKey: "canonical",
			sessionId: chat.internalId,
		});
	}

	// 身份对齐：appliedVersion ≠ currentVersion 才 configure（改 SOUL 下一轮生效的记账位）
	const current = store.currentVersion(partnerId);
	const applied = store.appliedVersionOf(partnerId, chat.internalId);
	if (current && current.version !== applied) {
		await chat.conversation.configure(
			{ instructions: renderPartnerIdentity(partner, current.soulSource) },
			CTX,
		);
		store.setAppliedVersion(partnerId, chat.internalId, current.version);
	}
	return chat;
}

export interface PartnerTurnOptions {
	/**
	 * 自主身份（cindy teammate-authority 同款口径）：autonomous = 例行任务/事件唤醒的自主轮，
	 * entrusted = 主人显式设的规则。文本头注入是透明性，进程内标记才是 C2 判定的事实源。
	 */
	authority?: "autonomous" | "entrusted";
	/** persistent = 复用主会话（默认）；fresh = 每次全新专线会话（跑完留着，task- 前缀不进列表） */
	sessionMode?: "persistent" | "fresh";
}

export interface PartnerTurnResult {
	ok: boolean;
	/** 模型这一轮说的话（聚合 delta；quiet 时已剔除 [[no-update]] 标记） */
	text: string;
	/** 例行轮"没有值得报告的内容"（2026-11-09 T2 安静契约）；调用方据此不写摘要 */
	quiet?: boolean;
	/**
	 * 无人值守下被跳过的工具名（枚举，不含参数；2026-11-10 批 13 §二.2）。
	 * 空数组 = 没有跳过任何步骤。
	 */
	skipped?: string[];
	/** 失败原因（执事不存在 / 未启用 / 模型未配置等），大白话给调用方 */
	error?: string;
}

/**
 * 跑执事的一轮（run 端点与例行任务引擎共用这个入口）。
 *
 * 走的就是聊天主链路 chatStream：闸门、审批、工作区边界、防打转全部原样生效——
 * 执事不是第二套权限系统，就是一条带身份提示词的真会话。
 */
export async function runPartnerTurn(
	partnerId: string,
	text: string,
	opts: PartnerTurnOptions = {},
): Promise<PartnerTurnResult> {
	if (!COMPANIONS_ENABLED) {
		return { ok: false, text: "", error: "执事能力未启用（COMPANIONS_ENABLED=false）" };
	}
	if (!text.trim()) return { ok: false, text: "", error: "跑一轮需要正文" };
	const partner = partnersStore().get(partnerId);
	if (!partner) return { ok: false, text: "", error: "执事不存在" };
	if (partner.status !== "active") {
		return { ok: false, text: "", error: `执事当前是「${partner.status}」，先恢复再跑` };
	}

	const chat =
		opts.sessionMode === "fresh"
			? await ensureFreshPartnerSession(partnerId)
			: await ensurePartnerSession(partnerId);
	if (!chat) return { ok: false, text: "", error: "执事会话取不到（未启用或未配置模型）" };

	const authority = opts.authority ?? "entrusted";
	// 安静契约只对例行轮生效（手动试跑 = 用户主动要，必须给产出）
	const quietEligible = authority === "autonomous" && routineQuietEnabled();
	// 文本头（透明性）：模型知道这一轮是谁发起的；判定事实源在 autonomy-state.ts。
	// 例行轮尾部多一行"没内容就回标记"的出口（固定字节，见 routine-quiet.ts）。
	const body = authority === "autonomous"
		? `[Scheduled run context]
turnAuthority: autonomous

${text}${quietEligible ? `\n\n${ROUTINE_QUIET_INSTRUCTION}` : ""}`
		: text;

	const pieces: string[] = [];
	/** 本轮是否真的产出了模型正文（unanswered 的说明不算，别把错误当"安静"） */
	let sawDelta = false;
	// 无人值守标记（2026-11-10 批 13 §一）：例行轮不必依赖 AUTONOMY_ENABLED——
	// 那个总闸默认关，但例行任务照常跑，判定必须独立成立。
	if (authority === "autonomous") markRoutineTurn(chat.internalId);
	// 每轮开头清一次跳过账：只统计本轮，不把上一轮的残留带进 run 记录。
	clearUnattendedSkips(chat.internalId);
	if (authority === "autonomous") markAutonomyTurn(chat.internalId);
	try {
		// 结算记录拿来看 unanswered 的 reason（候选链要不要切就看它）
		const settled: { record: SettledSubmissionRecord | null } = { record: null };
		const runOnce = async (): Promise<void> => {
			for await (const event of chatStream({
				conversation: chat.conversation,
				text: body,
				requestId: randomUUID(),
				onSettled: (record) => {
					settled.record = record;
				},
			})) {
				if (event.type === "delta") {
					pieces.push(event.text);
					sawDelta = true;
				} else if (event.type === "unanswered") pieces.push(event.message);
			}
		};
		await runOnce();

		// 候选链重试（批次B B4）：上一轮 unanswered 且原因可切 → 按链换路由重跑。
		// 每个候选最多跑一次；fallback 只改本轮，不暗改档案（下一轮仍从链头试）。
		let chain = partnersStore().getModelChain(partnerId);
		while (
			chain.length > 0 &&
			settled.record?.status === "unanswered" &&
			pieces.join("").length === 0
		) {
			const verdict = await stepChain(chat, chain, settled.record.reason ?? "");
			if (!verdict) break;
			// stepChain 已 configure 成新路由：剔除用过的候选，重跑一轮
			chain = chain.filter((item) => item !== verdict);
			pieces.length = 0;
			await runOnce();
		}

		// 安静契约（2026-11-09 T2）：判定是确定性的，不调模型；标记从产出里剔除。
		// 判为 quiet 时调用方不写摘要、不额外汇报（run 记录 summary="quiet"）。
		// 边界：模型这一轮的 assistant 条目由 durable 内核落盘，服务端没有撤回 API；
		// 这里保证的是"服务端不再写第二遍"，不是"transcript 里绝对没有痕迹"。
		const joined = pieces.join("");
		// 只在"真跑完了"的轮次上判安静：unanswered 的说明/错误不能当"没内容"吞掉。
		const canJudge = quietEligible && (sawDelta || settled.record?.status === "done");
		const verdict = canJudge ? assessRoutineOutput(joined) : { quiet: false, text: joined };
		const skipped = takeUnattendedSkips(chat.internalId);
		return verdict.quiet
			? { ok: true, text: verdict.text, quiet: true, skipped }
			: { ok: true, text: verdict.text, skipped };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			text: pieces.join(""),
			error: `这一轮没跑完：${detail}`,
			skipped: takeUnattendedSkips(chat.internalId),
		};
	} finally {
		if (authority === "autonomous") {
			unmarkAutonomyTurn(chat.internalId);
			unmarkRoutineTurn(chat.internalId);
		}
	}
}

/**
 * 按候选链走一步（B4）：挑下一个可用候选并 configure 过去，返回被采用的链项；
 * null = 不再重试（链尾 / 原因不可切 / 候选都没有 env 值 / configure 失败）。
 * 只切用户显式配置的链，fallback 只影响本轮。
 */
async function stepChain(
	chat: ResolvedChat,
	chain: Parameters<typeof nextChainCandidate>[0],
	reason: string,
): Promise<(Parameters<typeof nextChainCandidate>[0])[number] | null> {
	const current = await chat.conversation
		.agent(CTX)
		.then((agent) => agent.model ?? null)
		.catch(() => null);
	const verdict = nextChainCandidate(chain, current, reason);
	if (verdict.action !== "retry" || !verdict.target) {
		console.warn(`[model-chain] 不再重试：${verdict.reason}`);
		return null;
	}
	const target = verdict.target;
	if (!process.env[target.keyEnv]?.trim()) {
		console.warn(
			`[model-chain] 候选 ${target.providerId}/${target.modelId} 的 ${target.keyEnv} 没有 env 值，跳过`,
		);
		return null;
	}
	try {
		// v1 限制：候选按裸模型 id 配（不带思考后缀变体）；thinkingLevel 字段先落库，接线后置
		await chat.conversation.configure(
			{ model: { provider: target.providerId, modelId: target.modelId } },
			CTX,
		);
	} catch (error) {
		console.warn(
			`[model-chain] 切到 ${target.providerId}/${target.modelId} 失败: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
	console.warn(
		`[model-chain] 本轮 unanswered（${reason.slice(0, 80)}）→ 换 ${target.providerId}/${target.modelId} 重跑（${verdict.reason}）`,
	);
	return target;
}

/**
 * fresh 专线：每次全新会话，task- 前缀不进会话列表（listChats 口径）。
 * 检查类例行任务用：不污染主会话上下文；链接表照记（可追溯），跑完不回收（量小，留观察）。
 */
async function ensureFreshPartnerSession(partnerId: string): Promise<ResolvedChat | null> {
	const store = partnersStore();
	const partner = store.get(partnerId);
	if (!partner || partner.status !== "active") return null;
	const externalId = `task-routine-${partnerId.slice(0, 8)}-${Date.now()}`;
	const chat = await openOrCreateChat(externalId);
	store.linkSession({
		partnerId,
		role: "routine",
		routeKey: `routine:fresh:${externalId}`,
		sessionId: chat.internalId,
	});
	const current = store.currentVersion(partnerId);
	if (current) {
		await chat.conversation.configure(
			{ instructions: renderPartnerIdentity(partner, current.soulSource) },
			CTX,
		);
	}
	return chat;
}

// ── 首次问候（2026-11-06 侧栏调整 B3）──────────────────────
//
// 产品口径：第一次点开没有历史的执事时，主动说一句开场问候；之后点开就是普通会话。
// 三条硬约束：
//   1. **真实生成**，不是模板拼接（问候要像这个执事，不是像系统通知）；
//   2. **只写一条 assistant**，绝不伪造 user 消息（自动 prompt 会污染上下文，也会让"用户说过"的
//      历史判定失真）；
//   3. **不重复**：并发双击、多标签页、刷新、重启都只发一次。去重落在 durable doc +
//      canonical 提交里，不依赖前端 localStorage。
//
// 生成跑在隔离的 `task-` 会话里（无工具、无扩展、无记忆），身份只用当前 SOUL 快照。
// 生成结果先落 `ready`，再在一个事务里检查"用户是否已经说话 / 已经入队"，最后 appendEntry + 标 sent。

const GREETING_REQUIREMENTS = [
	"# 这次要做什么",
	"这是你第一次和主人说话。请主动说一句开场问候。",
	"要求：2–3 句，最多问一个问题；用你自己的身份和说话方式，不要客套模板。",
	"你就是这个执事本人，不是某个大模型的客服：不报模型名、不提供应商或公司（实测模型会自称「商汤日日新」这类名字，主人不想看到）。",
	"不编造经历，不宣称任何外部服务已经接通，不要调用任何工具。",
].join("\n");

const GREETING_REQUEST = "请按上面的要求，现在写下这句开场问候。";

/** 开关（B3 回滚）：false = 仍然建/打开空会话，但不生成问候。默认开。 */
export function partnerGreetingEnabled(): boolean {
	const raw = process.env.PARTNER_GREETING_ENABLED?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

export type PartnerGreetingOutcome = "sent" | "existing" | "skipped" | "disabled";

export type OpenPartnerConversationResult =
	| { ok: true; chat: ResolvedChat; greeting: PartnerGreetingOutcome }
	| { ok: false; reason: "not_found" | "chief" | "inactive" | "unavailable" | "failed" };

/** 问候状态机（durable，conversation scope）：idle → pending → ready → sent（或 skipped / failed）。 */
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

/** 同 partner 的 open 请求复用同一个 promise：双击不会变成两条并行生成。 */
const greetingOpenings = new Map<string, Promise<OpenPartnerConversationResult>>();

/**
 * POST /api/v1/partners/:id/open 的核心（端点只做形状映射）。
 *
 * 顺序即语义：先确认身份与状态 → 建/取 canonical → **一个 canonical 事务**里认领
 * （历史 / 已发起尝试 / 用户抢先输入 / 新 attempt 全部在这里判）→ 需要时生成 → 事务投递。
 * 不再有事务外的 history 快路径：那是第二份快照，返回 existing 却把 doc 留在 ready。
 * 任一步失败都不阻止之后手工打开空会话聊天。
 */
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

/**
 * 事务内扫全部历史（分页，不以最新一页代表全部）。
 * 必须是 tx 读取：commit 回调里调 harness.snapshot / conversation.context 会排在同一条
 * 会话语义线上，直接死锁。
 */
async function hasDialogueInTx(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries(
			{ conversationId, order: "ascending" },
			200,
			cursor,
		);
		if (page.items.some((entry) => entry.kind === "pi.user" || entry.kind === "pi.assistant")) {
			return true;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return false;
}

/**
 * 用户是否已经"先说了"：落成 entry 的 user / assistant，或内核已受理但还没落成 entry 的输入。
 * InboxDoc 是内核自己的队列 doc：写类（mode=write）不算用户发言。
 */
async function userSpokeInTx(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	if (await hasDialogueInTx(tx, conversationId)) return true;
	const inbox = await tx.doc(InboxDoc, conversationId);
	return inbox.items.some((item) => item.mode !== "write");
}

/**
 * 事务认领：**一个事务**决定"已投递 / 终止 / 投递 ready / 沿用 pending / 开新 attempt"。
 *
 * 三类状态收敛（2026-11-06 返修）：
 *   - sent，或从未发起过问候就有历史 → existing（不写 doc）；
 *   - pending / ready 的尝试碰上用户抢先输入（历史或 Inbox 已受理）→ 原子标 skipped 并返回 skipped；
 *   - skipped 是终态，之后 open 只回报 skipped，绝不新生成。
 * attempt / requestId / 生成会话一律不动：跳过不是重派，重启后仍能按原现场收敛。
 */
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

/**
 * 隔离生成：task- 会话 + configureTaskChat（工具清空、扩展摘掉）+ 只有当前 SOUL 快照。
 * 不含 USER.md / 技能 / 历史——问候不读私人资料，也不给工具。
 */
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
		partnersStore().currentVersion(partnerId)?.soulSource.trim() ||
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

/** pending → ready（只推进自己这一 attempt；状态已被别处改写就不动）。 */
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

/** 终态失败（模型明确没给出回答）：标 failed；下次显式点开才 attempt+1。 */
async function markGreetingFailed(chat: ResolvedChat, attempt: number): Promise<void> {
	await chat.conversation.commit(async (tx) => {
		const doc = await tx.doc(PartnerGreetingDoc, chat.conversation.id);
		if (doc.attempt !== attempt || doc.status !== "pending") return;
		doc.status = "failed";
		doc.updatedAt = new Date().toISOString();
	}, CTX);
}

/**
 * 投递：**一个事务**里复核历史 / 队列 → appendEntry(pi.assistant) → 标 sent。
 *
 * 为什么不能先读后写、再走普通 sayInChat：这中间用户可能刚好发出第一条消息，
 * 那就会出现"用户先说话，问候后到"的错位。commit 是会话唯一的原子边界，读和写必须在里面。
 * 只在此处用 tx 读取（scanEntries / InboxDoc），不碰 harness.snapshot（会死锁）。
 */
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
