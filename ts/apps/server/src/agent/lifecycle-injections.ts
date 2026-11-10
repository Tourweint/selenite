/**
 * lifecycle 的注入 provider（2026-11-10 批 27 §一/§三）。
 *
 * 这里放 lifecycle 原来自己拼的所有注入：
 *   - B 期 6 个 section（persona / verification_iron_law / clarify_contract /
 *     current_project / skills / topics）—— **channel: "system"**，物理位置仍由
 *     lifecycle `sections` 数组下标决定；
 *   - D 期 5 处 `extra.push`（记忆召回 / 技能斜杠 / 恢复注记 / 回合上限 / 执事上下文）——
 *     **channel: "message"**，装配处按收集结果依次压入，位置与改造前逐字节一致。
 *
 * provider 保持同步：需要异步快照的（会话种类）由 render 取好放进 ctx，provider 只拼文本。
 * 各段开关、身份分流、冻结 / 现渲染语义一律照搬改造前实现，逐字节不变。
 */

import { INJECTION_ORDER, type InjectionEntry, type InjectionProvider } from "./injection.ts";
import {
	CHIEF_PARTNER_ID,
	COMPANIONS_ENABLED,
	partnersStore,
	resolvePersona,
} from "../partners.ts";
import { clarifyContractEnabled, clarifyContractFor } from "../delegation.ts";
import { TOPICS_ENABLED, topicsStore } from "../topics.ts";
import {
	MAX_TURNS,
	TURN_LIMIT_INSTRUCTION,
	VERIFICATION_IRON_LAW,
	lifecycleOwnsVerification,
} from "./turn-gate.ts";
import { currentProject } from "./shared.ts";
import { currentProjectEnabled } from "../projects.ts";
import { wrapUntrustedObjective } from "./injection-guard.ts";
import { PERSONA, WORKER_PERSONA, memoryRecallProvider, skillStore } from "./assist.ts";
import { skillSlashOf } from "../skills.ts";
import { buildPartnerTurnContext } from "./partner-context.ts";
import { workSummaryFor } from "../work-record.ts";
import { takeRecoverNote } from "./recover-note.ts";

function entry(
	id: string,
	text: string,
	order: number,
	channel: "system" | "message",
	scope: "session" | "once" | "turn" = "session",
): InjectionEntry {
	return { id, text, order, scope, channel };
}

/** 非 chief 的执事会话：persona / 验证铁律 / 课题都不由 lifecycle 注（他们走 partner-context）。 */
function isNonChiefPartner(partnerId: string | null | undefined): boolean {
	return Boolean(partnerId && partnerId !== CHIEF_PARTNER_ID);
}

// ── B 期：6 个 section ───────────────────────────────────────

/**
 * 人格（2026-11-06 B2 分流，2026-11-10 批 27 接管）：
 *  - 非 chief 执事会话不注总管 persona；
 *  - worker → 普通任务助手提示；
 *  - chief / 无记录旧会话 → 总管 SOUL 当前版本快照，读不到回落 PERSONA。
 */
export const personaProvider: InjectionProvider = (ctx) => {
	if (isNonChiefPartner(ctx.partnerId)) return undefined;
	const text = ctx.chatKind === "worker" ? WORKER_PERSONA : resolvePersona(partnersStore, PERSONA);
	return entry("persona", text, INJECTION_ORDER.persona, "system");
};

/** 验证铁律：紧跟 persona，固定字节；非 chief 执事的同段由 partner-context 注入。 */
export const verificationIronLawProvider: InjectionProvider = (ctx) => {
	const partnerId = ctx.partnerId ?? null;
	if (!lifecycleOwnsVerification(partnerId)) return undefined;
	return entry(
		"verification_iron_law",
		VERIFICATION_IRON_LAW,
		INJECTION_ORDER.verification_iron_law,
		"system",
	);
};

/** 开工前先问清：只给总管 / 主对话；普通执事的提问纪律在 partner-context。 */
export const clarifyContractProvider: InjectionProvider = (ctx) => {
	if (!clarifyContractEnabled()) return undefined;
	const partnerId = ctx.partnerId ?? null;
	if (isNonChiefPartner(partnerId)) return undefined;
	if (ctx.chatKind === "worker") return undefined;
	const text = clarifyContractFor(partnerId);
	if (!text) return undefined;
	return entry("clarify_contract", text, INJECTION_ORDER.clarify_contract, "system");
};

/** 当前项目：每轮现渲染，不写进对话历史。 */
export const currentProjectProvider: InjectionProvider = () => {
	if (!currentProjectEnabled()) return undefined;
	const project = currentProject();
	const text = project
		? [
				`当前项目：${project.name}`,
				`根路径：${project.rootPath}`,
				"文件操作默认在此项目内。",
			].join("\n")
		: "当前无特定项目（杂事模式）。文件操作默认在主工作区。";
	return entry("current_project", text, INJECTION_ORDER.current_project, "system");
};

/**
 * L1 技能索引：按会话冻结（`indexFor` 内部冻结），首轮渲染后技能目录再变也不改写本会话。
 * 审计（dryRun）不冻结——读端点不改会话状态。
 */
export const skillsProvider: InjectionProvider = (ctx) => {
	if (ctx.dryRun) return undefined;
	const text = skillStore?.indexFor(Number(ctx.conversationId));
	if (!text) return undefined;
	return entry("skills", text, INJECTION_ORDER.skills, "system");
};

/**
 * 课题（清单 + 嗅探判据 + 攒着的简报）：**每轮现渲染**。
 * 渲染即把 pendingPush 取走并标记已推送——审计（dryRun）跳过这一步，否则会吞掉简报。
 */
export const topicsProvider: InjectionProvider = (ctx) => {
	if (!TOPICS_ENABLED) return undefined;
	if (ctx.group) return undefined;
	if (isNonChiefPartner(ctx.partnerId)) return undefined;
	if (ctx.chatKind === "worker") return undefined;

	const store = topicsStore();
	const pushes = ctx.dryRun ? [] : store.drainPendingPushes();
	const digest = store.digestForInjection();
	const lines: string[] = [];
	if (digest) {
		lines.push("在跟的课题：", digest);
	} else {
		lines.push("在跟的课题：（暂无）");
	}
	if (pushes.length > 0) {
		// 只记条数，不记课题内容（日志纪律）
		console.log(`[topics] 简报注入 ${pushes.length} 条`);
		lines.push(
			"",
			"课题简报（攒着的，随本轮自然汇报给用户，别复述全文）：",
			...pushes.map((topic) => {
				const latest = topic.findings[0];
				// 课题问题是用户可控文本：注入时标成不可信目标（§3.4）
				return `- ${wrapUntrustedObjective(topic.question)}：${latest?.summary ?? "有新发现"}`;
			}),
		);
	}
	lines.push(
		"",
		"课题嗅探（从严，宁缺毋滥）：开放性问题 + 今天给不了定论 + 值得隔几天回头看 + 用户显出兴趣，四条都满足才用 propose_topic 提交提议；",
		"同一话题单会话最多提一次；只提交提议、永不自动建课题（用户确认后才建）。",
	);
	return entry("topics", lines.join("\n"), INJECTION_ORDER.topics, "system");
};

/** B 期登记表（顺序 = lifecycle sections 数组下标顺序；section 物理位置不由它决定）。 */
export const LIFECYCLE_SECTION_PROVIDERS: readonly InjectionProvider[] = [
	personaProvider,
	verificationIronLawProvider,
	clarifyContractProvider,
	currentProjectProvider,
	skillsProvider,
	topicsProvider,
];

// ── D 期：5 处 extra.push（channel: "message"）────────────────

/** 技能斜杠调用：用户消息以 /技能名 开头 → 手册整份注入本轮。 */
export const skillSlashProvider: InjectionProvider = (ctx) => {
	const name = skillSlashOf(ctx.userText ?? "");
	const manual = name ? skillStore?.manual(name) : undefined;
	if (!name || !manual) return undefined;
	return entry(
		"skill_slash",
		`【技能调用 · ${name}】\n${manual}\n（用户消息开头的 /${name} 就是调用这份手册；其余文字是这一轮的指令。）`,
		INJECTION_ORDER.skill_slash,
		"message",
		"turn",
	);
};

/** 恢复注记：取走即核销，每张单最多一次；审计不消费。 */
export const recoverNoteProvider: InjectionProvider = (ctx) => {
	if (ctx.dryRun) return undefined;
	const text = takeRecoverNote(Number(ctx.conversationId));
	if (!text) return undefined;
	return entry("recover_note", text, INJECTION_ORDER.recover_note, "message", "once");
};

/** 回合上限提示：`turn` 是本次模型请求的序号（1 = 本轮第一次）。 */
export const turnLimitProvider: InjectionProvider = (ctx) => {
	if (!(MAX_TURNS > 0 && (ctx.turn ?? 0) > MAX_TURNS)) return undefined;
	return entry("turn_limit", TURN_LIMIT_INSTRUCTION, INJECTION_ORDER.turn_limit, "message", "turn");
};

/**
 * 执事轮输入（岗位契约 + 当前在办等）：只在本轮第一次模型请求时算。
 * 档案 / 任务中心读失败只记日志，这一轮少一段状态，但对话不能哑（与改造前同口径）。
 */
export const partnerContextProvider: InjectionProvider = (ctx) => {
	if (ctx.dryRun || ctx.turn !== 1 || !COMPANIONS_ENABLED) return undefined;
	const conversationId = Number(ctx.conversationId);
	try {
		const partnerId = ctx.partnerId ?? partnersStore().partnerIdOfSession(conversationId);
		if (!partnerId) return undefined;
		const turnContext = buildPartnerTurnContext(partnerId, conversationId, {
			workSummary: workSummaryFor,
		});
		if (!turnContext.text) return undefined;
		return entry(
			"partner_context",
			turnContext.text,
			INJECTION_ORDER.partner_context,
			"message",
			"turn",
		);
	} catch (error) {
		// 档案 / 任务中心读失败：这一轮少一段状态，但对话不能哑
		console.warn(
			`[partner] 会话 ${conversationId} 上下文装配失败: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
};

/** D 期登记表（顺序 = 改造前 extra.push 的先后顺序）。 */
export const LIFECYCLE_MESSAGE_PROVIDERS: readonly InjectionProvider[] = [
	memoryRecallProvider,
	skillSlashProvider,
	recoverNoteProvider,
	turnLimitProvider,
	partnerContextProvider,
];
