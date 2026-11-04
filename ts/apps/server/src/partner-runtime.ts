import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	COMPANIONS_ENABLED,
	partnersStore,
	type PartnerRow,
} from "./partners.ts";
import { markAutonomyTurn, unmarkAutonomyTurn } from "./autonomy-state.ts";
import { nextChainCandidate } from "./model-chain.ts";
import type { SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { chatStream, openOrCreateChat, type ResolvedChat } from "./agent.ts";

/** 与 agent.ts 同一背景上下文：跑在后台、不绑任何请求 */
const CTX = BACKGROUND_CONTEXT;

/**
 * 伙伴的**会话运行时**（2026-11-05 批次B B2）。
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

/** 伙伴主会话的对外 id 约定。它是一条真会话：历史可回读、出现在会话列表里。 */
export function partnerCanonicalExternalId(partnerId: string): string {
	return `partner-${partnerId}`;
}

/** 伙伴身份提示词：SOUL 快照（认版本号）+ USER.md 摘要 + 技能索引。 */
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

/** 伙伴技能索引：目录约定与全局 skills/ 相同（*.md，第 1 行 = 索引摘要）。 */
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
 * 取/建伙伴主会话，并把身份对齐到当前版本。
 * 返回 null = 伙伴不存在或已暂停/归档（调用方回 404 / 409）。
 */
export async function ensurePartnerSession(partnerId: string): Promise<ResolvedChat | null> {
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
	/** 模型这一轮说的话（聚合 delta） */
	text: string;
	/** 失败原因（伙伴不存在 / 未启用 / 模型未配置等），大白话给调用方 */
	error?: string;
}

/**
 * 跑伙伴的一轮（run 端点与例行任务引擎共用这个入口）。
 *
 * 走的就是聊天主链路 chatStream：闸门、审批、工作区边界、防打转全部原样生效——
 * 伙伴不是第二套权限系统，就是一条带身份提示词的真会话。
 */
export async function runPartnerTurn(
	partnerId: string,
	text: string,
	opts: PartnerTurnOptions = {},
): Promise<PartnerTurnResult> {
	if (!COMPANIONS_ENABLED) {
		return { ok: false, text: "", error: "伙伴能力未启用（COMPANIONS_ENABLED=false）" };
	}
	if (!text.trim()) return { ok: false, text: "", error: "跑一轮需要正文" };
	const partner = partnersStore().get(partnerId);
	if (!partner) return { ok: false, text: "", error: "伙伴不存在" };
	if (partner.status !== "active") {
		return { ok: false, text: "", error: `伙伴当前是「${partner.status}」，先恢复再跑` };
	}

	const chat =
		opts.sessionMode === "fresh"
			? await ensureFreshPartnerSession(partnerId)
			: await ensurePartnerSession(partnerId);
	if (!chat) return { ok: false, text: "", error: "伙伴会话取不到（未启用或未配置模型）" };

	const authority = opts.authority ?? "entrusted";
	// 文本头（透明性）：模型知道这一轮是谁发起的；判定事实源在 autonomy-state.ts
	const body = authority === "autonomous" ? `[Scheduled run context]
turnAuthority: autonomous

${text}` : text;

	const pieces: string[] = [];
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
				if (event.type === "delta") pieces.push(event.text);
				else if (event.type === "unanswered") pieces.push(event.message);
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

		return { ok: true, text: pieces.join("") };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, text: pieces.join(""), error: `这一轮没跑完：${detail}` };
	} finally {
		if (authority === "autonomous") unmarkAutonomyTurn(chat.internalId);
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
