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

import { basename } from "node:path";
import {
	INJECTION_ORDER,
	type InjectionContext,
	type InjectionEntry,
	type InjectionProvider,
} from "./injection.ts";
import {
	CHIEF_PARTNER_ID,
	COMPANIONS_ENABLED,
	effectivePartnerIdOfSession,
	partnersStore,
	resolvePersona,
} from "../partners.ts";
import { clarifyContractEnabled, clarifyContractFor } from "../delegation.ts";
import { TOPICS_ENABLED, topicsStore } from "../topics.ts";
import {
	MAX_TURNS,
	TURN_LIMIT_APPROACHING_INSTRUCTION,
	TURN_LIMIT_INSTRUCTION,
	TURN_LIMIT_WARN_ROUNDS,
	VERIFICATION_IRON_LAW,
	lifecycleOwnsVerification,
} from "./turn-gate.ts";
import { currentProject, sessionBoundCwd, sessionCwd } from "./shared.ts";
import { currentProjectEnabled, projectsStore } from "../projects.ts";
import { wrapUntrustedObjective } from "./injection-guard.ts";
import { PERSONA, memoryRecallProvider, projectIndexProvider, skillStore } from "./assist.ts";
import { readWorkerPersona, WORKER_PERSONA_CHAT_TOOLS } from "../worker-persona.ts";
import { skillSlashOf } from "../skills.ts";
import { recordSkillUse } from "../skill-usage.ts";
import { buildPartnerTurnContext } from "./partner-context.ts";
import { workSummaryFor } from "../work-record.ts";
import { takeRecoverNote } from "./recover-note.ts";
import { toolIndexEnabled, toolIndexText } from "../tool-index.ts";

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

/**
 * 技能按人可见用的 partnerId（2026-11-15）。
 * 执事会话直接用 ctx.partnerId；主对话没有链接记录，回落 effectivePartnerIdOfSession（= chief）。
 * 读不到就按无 partner 处理（只走全局启停位）。
 */
function skillPartnerOf(ctx: InjectionContext): string | null {
	if (ctx.partnerId) return ctx.partnerId;
	if (!COMPANIONS_ENABLED) return null;
	try {
		return effectivePartnerIdOfSession(partnersStore(), Number(ctx.conversationId));
	} catch {
		return null;
	}
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
	// 2026-11-16 worker 人设全局一份、每轮现读：改完下一轮生效；其它分支不动。
	// 同日批2 拆层：正文（共享层，派活同吃）+ 会话工具提示（只有会话有这三件工具）。
	const text =
		ctx.chatKind === "worker"
			? readWorkerPersona() + WORKER_PERSONA_CHAT_TOOLS
			: resolvePersona(partnersStore, PERSONA);
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

/**
 * Windows 路径比较：斜杠 / 反斜杠、盘符大小写都不算差异。
 * 只为判断「会话 cwd 是不是主工作区」，不参与任何路径拼接。
 */
function samePath(a: string, b: string): boolean {
	const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
	return norm(a) === norm(b);
}

/**
 * 当前项目 / 主工作区：每轮现渲染，不写进对话历史。
 *
 * 2026-11-16 定稿：普通对话就是 worker，**必须带项目记忆**，所以继续跟随「当前项目」；
 * 同时把**主工作区路径**写进提示（之前只说过"文件操作默认在主工作区"，路径从未出现过）。
 * 没选项目 → 落主工作区（杂事态）；已登记项目全列（项目少，名字 + 主文件夹路径）。
 *
 * 2026-11-13 项目容器口径：一个项目可以有多个文件夹，主文件夹是相对路径的唯一基准，
 * 其余文件夹一律写绝对路径；同名文件纪律一并保留。
 */
export const currentProjectProvider: InjectionProvider = (ctx) => {
	if (!currentProjectEnabled()) return undefined;
	const project = currentProject();
	// 会话创建时钉下的文件夹（快照）；换主文件夹不影响老会话，这里要说清楚"你在哪"。
	const bound = sessionBoundCwd(ctx.conversationId);
	const roots = project?.roots ?? [];
	let workspacePath: string | null = null;
	const projectLines: string[] = [];
	try {
		const store = projectsStore();
		workspacePath = store.getWorkspace()?.rootPath ?? null;
		for (const entry of store.listProjects()) {
			const entryRoots = entry.roots ?? [];
			const primary = entryRoots.find((root) => root.role === "primary") ?? entryRoots[0];
			if (!primary) continue;
			projectLines.push(`- ${entry.name}：${primary.path}`);
			for (const root of entryRoots) {
				if (root === primary) continue;
				projectLines.push(`  - ${root.label}：${root.path}`);
			}
		}
	} catch {
		// 项目库坏了不阻塞对话：只注入已知的部分
	}
	// 执事 / 例行轮（2026-11-17）：默认目录是主工作区，不跟界面里的「当前项目」。
	// 注意：默认目录只是相对路径基准，**不是边界**——勾选项目只决定记忆召回，
	// 能去哪些目录由 path-guard 的「主工作区 + 所有非归档项目根」决定。
	// 判据是「会话实际 cwd 是不是主工作区」——执事轮跑在 task- 会话里，
	// partnerId 解析不到（实测 fresh 轮注入走了 chief 分支，说"相对路径以主文件夹为基准"，
	// 和它真正的 cwd 直接打架），认"谁是会话"不如认"它到底在哪"。
	const boundIsWorkspace = bound !== null && workspacePath !== null && samePath(bound, workspacePath);
	const partnerSession = isNonChiefPartner(ctx.partnerId) || boundIsWorkspace;
	const lines: string[] = [];
	if (partnerSession) {
		if (workspacePath) {
			lines.push(`主工作区：${basename(workspacePath) || "工作区"}（${workspacePath}）`);
		}
		const workDir = bound ?? workspacePath ?? sessionCwd(ctx.conversationId);
		lines.push(`本会话的默认目录：${workDir}（相对路径按它解析；它不是边界）`);
		lines.push(
			"你能去的目录不止这一个：主工作区和下面所有已登记项目都在文件范围里，直接用绝对路径过去就行。",
		);
		lines.push(
			"设置里勾选的项目只决定「记忆能不能召回」，不限制你能去哪些目录——这两件事是分开的。",
		);
		if (projectLines.length > 0) {
			lines.push("全部已登记项目（都能去）：", ...projectLines);
			lines.push(
				"多个文件夹里可能有同名文件（README.md / build.gradle 之类）：动手前先看路径，别把同名文件当成同一个。",
			);
		}
		return entry("current_project", lines.join("\n"), INJECTION_ORDER.current_project, "system");
	}
	if (workspacePath) {
		lines.push(`主工作区：${basename(workspacePath) || "工作区"}（${workspacePath}）`);
	}
	lines.push(
		project
			? `当前项目：${project.name}（${roots.length || 1} 个文件夹）`
			: "当前无特定项目（杂事模式）。文件操作默认在主工作区。",
	);
	if (project) {
		lines.push(`主文件夹：${project.rootPath}`);
		if (bound && bound !== project.rootPath) {
			lines.push(
				`本会话的工作目录：${bound}（创建时的快照；主文件夹后来改过也不影响本会话）`,
			);
		}
		lines.push(
			...roots.map(
				(root) => `- ${root.label}${root.role === "primary" ? "（主）" : ""}：${root.path}`,
			),
		);
		lines.push("相对路径以主文件夹为基准；要动别的文件夹，写它的绝对路径。");
	} else if (bound) {
		lines.push(`本会话的工作目录：${bound}（创建时的快照）`);
		lines.push("相对路径以本会话的工作目录为基准。");
	} else if (workspacePath) {
		lines.push("相对路径以主工作区为基准。");
	}
	if (projectLines.length > 0) {
		lines.push("已登记项目（需要时用绝对路径）：", ...projectLines);
		lines.push(
			"多个文件夹里可能有同名文件（README.md / build.gradle 之类）：动手前先看路径，别把同名文件当成同一个。",
		);
	}
	return entry("current_project", lines.join("\n"), INJECTION_ORDER.current_project, "system");
};

/**
 * L1 技能索引：按会话冻结（`indexFor` 内部冻结），首轮渲染后技能目录再变也不改写本会话。
 * 审计（dryRun）不冻结——读端点不改会话状态。
 */
export const skillsProvider: InjectionProvider = (ctx) => {
	if (ctx.dryRun) return undefined;
	const text = skillStore?.indexFor(Number(ctx.conversationId), skillPartnerOf(ctx));
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

/**
 * 低频工具索引（2026-11-16 C 段）：只列当前会话还能加载的 deferred（render 从 agent.deferred 取来）。
 * 开关关 / 一个都没有 → 整段省略（不造空段）。末尾追加，位置由 lifecycle sections 数组决定。
 */
export const toolIndexProvider: InjectionProvider = (ctx) => {
	if (!toolIndexEnabled()) return undefined;
	const text = toolIndexText(ctx.deferred ?? []);
	if (!text) return undefined;
	return entry("tool_index", text, INJECTION_ORDER.tool_index, "system");
};

/** B 期登记表（顺序 = lifecycle sections 数组下标顺序；section 物理位置不由它决定）。 */
export const LIFECYCLE_SECTION_PROVIDERS: readonly InjectionProvider[] = [
	personaProvider,
	verificationIronLawProvider,
	clarifyContractProvider,
	currentProjectProvider,
	skillsProvider,
	topicsProvider,
	toolIndexProvider,
];

// ── D 期：5 处 extra.push（channel: "message"）────────────────

/** 技能斜杠调用：用户消息以 /技能名 开头 → 手册整份注入本轮。 */
export const skillSlashProvider: InjectionProvider = (ctx) => {
	const name = skillSlashOf(ctx.userText ?? "");
	const manual = name ? skillStore?.manual(name, skillPartnerOf(ctx)) : undefined;
	if (!name || !manual) return undefined;
	// 斜杠调用也计数（2026-11-17 补漏）：skill 工具取手册已记，这条路此前漏计。
	// 审计（dryRun = injection-preview）不记账，别让预览污染用量账。
	if (!ctx.dryRun) recordSkillUse(name);
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
 * 撞上限前提示（2026-11-13 工具层结果契约化批次三 §2.2）：剩最后 5 轮
 * （turn ∈ [MAX_TURNS-4, MAX_TURNS]）时注一行收尾提示，与硬上限的 turn_limit 不重叠
 * （MAX_TURNS ≤ 5 时永远不注——小上限下硬提示本身就够了）。
 */
export const turnLimitApproachingProvider: InjectionProvider = (ctx) => {
	const turn = ctx.turn ?? 0;
	if (!(MAX_TURNS > TURN_LIMIT_WARN_ROUNDS && turn >= MAX_TURNS - (TURN_LIMIT_WARN_ROUNDS - 1) && turn <= MAX_TURNS)) {
		return undefined;
	}
	return entry(
		"turn_limit_approaching",
		TURN_LIMIT_APPROACHING_INSTRUCTION,
		INJECTION_ORDER.turn_limit_approaching,
		"message",
		"turn",
	);
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
	projectIndexProvider,
	memoryRecallProvider,
	skillSlashProvider,
	recoverNoteProvider,
	turnLimitApproachingProvider,
	turnLimitProvider,
	partnerContextProvider,
];
