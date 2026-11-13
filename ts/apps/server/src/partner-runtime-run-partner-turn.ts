/**
 * partner-runtime-run-partner-turn
 *
 * 2026-11-14 从 partner-runtime.ts 的 L36–L416 整段切出；正文原文搬运，未改一行实现。
 * 内含：CTX / partnerCanonicalExternalId / renderPartnerIdentity / partnerSkillsIndex …
 */

import type { ResolvedChat } from "./agent.ts";
import { chatStream, openOrCreateChat } from "./agent.ts";
import { markAutonomyTurn, unmarkAutonomyTurn } from "./autonomy-state.ts";
import { nextChainCandidate } from "./model-chain.ts";
import type { PartnerRow } from "./partners.ts";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { ROUTINE_QUIET_INSTRUCTION, assessRoutineOutputGuarded, routineQuietEnabled } from "./routine-quiet.ts";
import { clearTurnToolErrors, clearUnattendedSkips, markRoutineTurn, takeTurnToolErrors, takeUnattendedSkips, unmarkRoutineTurn } from "./unattended.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CTX = BACKGROUND_CONTEXT;

export function partnerCanonicalExternalId(partnerId: string): string {
	return `partner-${partnerId}`;
}

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
	/**
	 * 安静契约是否适用于这一轮（2026-11-10 批 29）。
	 *
	 * 缺省 = 沿用"只有 autonomous 轮才判安静"的旧口径；显式 `false` = 这轮不适用安静契约
	 * （派活唤醒轮必有内容：接住汇报就是产出）。
	 */
	quiet?: boolean;
}

export interface PartnerTurnResult {
	ok: boolean;
	/** 模型这一轮说的话（聚合 delta；quiet 时已剔除 [[no-update]] 标记） */
	text: string;
	/** 例行轮"没有值得报告的内容"（2026-11-09 T2 安静契约）；调用方据此不写摘要 */
	quiet?: boolean;
	/**
	 * 本轮报过错的工具名（枚举，不含参数与报错正文；2026-11-10 批 21 §三）。
	 * 有它在手时安静判定已被压制（读失败不当"无新"）；空/缺省 = 本轮没有工具报错。
	 */
	toolErrors?: string[];
	/**
	 * 无人值守下被跳过的工具名（枚举，不含参数；2026-11-10 批 13 §二.2）。
	 * 空数组 = 没有跳过任何步骤。
	 */
	skipped?: string[];
	/** 失败原因（执事不存在 / 未启用 / 模型未配置等），大白话给调用方 */
	error?: string;
}

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
	// 安静契约只对例行轮生效（手动试跑 = 用户主动要，必须给产出）；
	// 唤醒轮显式传 quiet=false（接住汇报就是内容，不闭嘴）。
	const quietEligible = (opts.quiet ?? (authority === "autonomous")) && routineQuietEnabled();
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
		// 每轮开头清一次跳过账与工具报错账：只统计本轮，不把上一轮的残留带进 run 记录。
		clearUnattendedSkips(chat.internalId);
		clearTurnToolErrors(chat.internalId);
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
		// 工具报错账（批 21 §三）：本轮有任何工具报错，"看起来没内容"不当安静吞掉。
		const toolErrors = takeTurnToolErrors(chat.internalId);
		// 只在"真跑完了"的轮次上判安静：unanswered 的说明/错误不能当"没内容"吞掉。
		const canJudge = quietEligible && (sawDelta || settled.record?.status === "done");
		const verdict = canJudge
			? assessRoutineOutputGuarded(joined, toolErrors.length)
			: { quiet: false, text: joined };
		const skipped = takeUnattendedSkips(chat.internalId);
		return verdict.quiet
			? { ok: true, text: verdict.text, quiet: true, skipped }
			: {
					ok: true,
					text: verdict.text,
					skipped,
					...(toolErrors.length > 0 ? { toolErrors } : {}),
				};
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

const GREETING_REQUIREMENTS = [
	"# 这次要做什么",
	"这是你第一次和主人说话。请主动说一句开场问候。",
	"要求：2–3 句，最多问一个问题；用你自己的身份和说话方式，不要客套模板。",
	"你就是这个执事本人，不是某个大模型的客服：不报模型名、不提供应商或公司（实测模型会自称「商汤日日新」这类名字，主人不想看到）。",
	"不编造经历，不宣称任何外部服务已经接通，不要调用任何工具。",
].join("\n");

const GREETING_REQUEST = "请按上面的要求，现在写下这句开场问候。";

export function partnerGreetingEnabled(): boolean {
	const raw = process.env.PARTNER_GREETING_ENABLED?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

export type PartnerGreetingOutcome = "sent" | "existing" | "skipped" | "disabled";

export type OpenPartnerConversationResult =
	| { ok: true; chat: ResolvedChat; greeting: PartnerGreetingOutcome }
	| { ok: false; reason: "not_found" | "chief" | "inactive" | "unavailable" | "failed" };

export { CTX, GREETING_REQUEST, GREETING_REQUIREMENTS, ensureFreshPartnerSession, openPartnerSession, partnerSkillsIndex, sessionOpenings, stepChain };
