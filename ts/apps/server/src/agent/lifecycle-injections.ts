/**
 * lifecycle 的注入 provider（2026-11-10 批 27 §一/§三）。
 *
 * 这里放 lifecycle 原来自己拼的所有注入：
 *   - B 期 5 个 section（persona / verification_iron_law / clarify_contract /
 *     current_project / skills）—— **channel: "system"**，物理位置仍由
 *     lifecycle `sections` 数组下标决定；
 *   - D 期 5 处 `extra.push`（记忆召回 / 技能斜杠 / 恢复注记 / 回合上限 / 执事上下文）——
 *     **channel: "message"**，装配处按收集结果依次压入，位置与改造前逐字节一致。
 *
 * provider 保持同步：需要异步快照的（会话种类）由 render 取好放进 ctx，provider 只拼文本。
 * 各段开关、身份分流、冻结 / 现渲染语义一律照搬改造前实现，逐字节不变。
 */

import { basename } from "node:path";
import type { spawn } from "node:child_process";
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
import { PERSONA, memoryRecallProvider, projectIndexProvider, skillStore } from "./assist.ts";
import { readUserProfile, renderUserProfileSection, userProfileEnabled } from "../user-profile.ts";
import { readWorkerPersona, WORKER_PERSONA_CHAT_TOOLS } from "../worker-persona.ts";
import { skillSlashOf } from "../skills.ts";
import { WORKER_SKILL_OWNER, workerSkillScopeEnabled } from "../skill-state.ts";
import { recordSkillUse } from "../skill-usage.ts";
import { buildPartnerTurnContext } from "./partner-context.ts";
import { workSummaryFor } from "../work-record.ts";
import { takeRecoverNote } from "./recover-note.ts";
import { toolIndexText } from "../tool-index.ts";
import {
	personaInjectGatesClosed,
	EXTERNAL_BANK_CATALOG_TITLE,
	personaLightRecall,
} from "../persona-inject.ts";
import {
	bankCatalogCachedText,
} from "../memory-bank.ts";

function entry(
	id: string,
	text: string,
	order: number,
	channel: "system" | "message",
	scope: "session" | "once" | "turn" = "session",
): InjectionEntry {
	return { id, text, order, scope, channel };
}

/** 非 chief 的执事会话：persona / 验证铁律都不由 lifecycle 注（他们走 partner-context）。 */
function isNonChiefPartner(partnerId: string | null | undefined): boolean {
	return Boolean(partnerId && partnerId !== CHIEF_PARTNER_ID);
}

/**
 * 技能按人可见用的 partnerId（2026-11-15；2026-11-21 普通助手独立）。
 * 执事会话直接用 ctx.partnerId；worker 会话走保留键 `worker`（不再回落 chief，
 * 普通助手有自己的技能勾选）；主对话没有链接记录，回落 effectivePartnerIdOfSession（= chief）。
 * 读不到就按无 partner 处理（只走全局启停位）。
 */
function skillPartnerOf(ctx: InjectionContext): string | null {
	if (ctx.chatKind === "worker" && workerSkillScopeEnabled()) return WORKER_SKILL_OWNER;
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

/**
 * 关于我（2026-11-19）：全局固定背景，每轮注入，紧跟 persona。
 *
 * 硬边界：不进记忆、不参与召回；只对**会读它**的 Agent 注入。
 * - 普通 worker 会话不读（`chatKind === "worker"`）；派活工人没有会话，天然不在这条链上；
 * - 群会话不读（多人上下文不带个人档案，v1 明确跳过）；
 * - 执事用自己的 id，主对话 / 未链接会话回落总管；该行 `userProfileRead === false` 时不注。
 *
 * `deps` 只给单测：生产走文件 + partners 当前值，每轮现读。
 */
export interface UserProfileInjectionDeps {
	enabled?: () => boolean;
	content?: () => string;
	reads?: (agentId: string) => boolean;
}

export function userProfileProviderWith(
	deps: UserProfileInjectionDeps = {},
): InjectionProvider {
	const enabled = deps.enabled ?? (() => userProfileEnabled());
	const content = deps.content ?? (() => readUserProfile());
	const reads =
		deps.reads ??
		((agentId: string): boolean => {
			try {
				const row = partnersStore().get(agentId);
				return row ? row.userProfileRead !== false : true;
			} catch {
				// 档案库读失败按"读"处理：固定背景是净增能力，不能因目录故障静默丢；
				// 真正的安全边界在内容本身（主人手写，不是外部输入）。
				return true;
			}
		});
	return (ctx) => {
		if (ctx.group) return undefined;
		if (ctx.chatKind === "worker") return undefined;
		if (!enabled()) return undefined;
		const agentId =
			ctx.partnerId && ctx.partnerId !== CHIEF_PARTNER_ID ? ctx.partnerId : CHIEF_PARTNER_ID;
		if (!reads(agentId)) return undefined;
		const text = renderUserProfileSection(content());
		if (!text) return undefined;
		return entry("user_profile", text, INJECTION_ORDER.user_profile, "system");
	};
}

export const userProfileProvider: InjectionProvider = userProfileProviderWith();

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
 * 「执事 / 例行轮」判据：非 chief 执事会话，或会话实际 cwd 就是主工作区。
 * 两种情况下默认目录都不跟界面里的「当前项目」，因此不注 `current_project_live`。
 */
function isPartnerLikeSession(
	ctx: InjectionContext,
	bound: string | null,
	workspacePath: string | null,
): boolean {
	if (isNonChiefPartner(ctx.partnerId)) return true;
	return bound !== null && workspacePath !== null && samePath(bound, workspacePath);
}

/**
 * 当前项目 / 主工作区的**固定部分**（2026-11-19 前缀锁定拆分）：
 * 主工作区、本会话工作目录快照、全部已登记项目清单、同名文件纪律。
 *
 * 不自动变的东西才放 system：这里不再出现「当前项目 / 主文件夹 / 相对路径基准」——
 * 那几行会随侧栏切项目而变，改由 `currentProjectLiveProvider` 每轮从**消息尾部**注入。
 * 固定部分只在用户显式增删 / 改名项目时变，一次缓存重置是预期。
 *
 * 2026-11-16 定稿：普通对话就是 worker，**必须带项目记忆**，所以继续跟随「当前项目」；
 * 同时把**主工作区路径**写进提示（之前只说过"文件操作默认在主工作区"，路径从未出现过）。
 * 2026-11-13 项目容器口径：一个项目可以有多个文件夹，主文件夹是相对路径的唯一基准，
 * 其余文件夹一律写绝对路径；同名文件纪律一并保留。
 */
export const currentProjectProvider: InjectionProvider = (ctx) => {
	if (!currentProjectEnabled()) return undefined;
	// 会话创建时钉下的文件夹（快照）；换主文件夹不影响老会话，这里要说清楚"你在哪"。
	const bound = sessionBoundCwd(ctx.conversationId);
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
	const partnerSession = isPartnerLikeSession(ctx, bound, workspacePath);
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
	if (bound) {
		lines.push(`本会话的工作目录：${bound}（创建时的快照）`);
	}
	if (projectLines.length > 0) {
		lines.push("已登记项目（需要时用绝对路径）：", ...projectLines);
		lines.push(
			"多个文件夹里可能有同名文件（README.md / build.gradle 之类）：动手前先看路径，别把同名文件当成同一个。",
		);
	}
	// 什么都没有（没工作区、没绑定、没项目）：整段省略，别造空段；
	// 「当前无特定项目」由尾部动态行负责。
	if (lines.length === 0) return undefined;
	return entry("current_project", lines.join("\n"), INJECTION_ORDER.current_project, "system");
};

/**
 * 当前项目 / 相对路径基准：**每轮现算，走消息尾部**（2026-11-19 前缀锁定）。
 *
 * 为什么不在 system：侧栏一切项目这一行就变；留在 system 会让整段固定前缀作废。
 * 为什么每轮都发：注入不写进对话历史，工具回合的模型请求也必须看得见。
 * 执事 / 例行轮不注（它们的默认目录钉在主工作区，见上）。
 */
export const currentProjectLiveProvider: InjectionProvider = (ctx) => {
	if (!currentProjectEnabled()) return undefined;
	const bound = sessionBoundCwd(ctx.conversationId);
	let workspacePath: string | null = null;
	try {
		workspacePath = projectsStore().getWorkspace()?.rootPath ?? null;
	} catch {
		// 项目库坏了：这一轮少一段动态行，固定段仍会说明主工作区
	}
	if (isPartnerLikeSession(ctx, bound, workspacePath)) return undefined;
	const project = currentProject();
	const lines: string[] = [];
	if (project) {
		lines.push(`当前项目：${project.name}（${project.roots.length || 1} 个文件夹）`);
		lines.push(`主文件夹：${project.rootPath}`);
		lines.push("相对路径以主文件夹为基准；要动别的文件夹，写它的绝对路径。");
	} else {
		lines.push("当前无特定项目（杂事模式）。文件操作默认在主工作区。");
		if (bound) lines.push("相对路径以本会话的工作目录为基准。");
		else if (workspacePath) lines.push("相对路径以主工作区为基准。");
	}
	return entry(
		"current_project_live",
		lines.join("\n"),
		INJECTION_ORDER.current_project_live,
		"message",
		"turn",
	);
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
 * 低频工具索引（2026-11-16 C 段；2026-11-25 移出 system）。
 *
 * 只列当前会话还能加载的 deferred（装配处从 agent.deferred 取来）。
 * 一个都没有 → 整段省略（不造空段）。
 *
 * **2026-11-25 起走消息尾部**：加载工具会让这段变短，但工具面本身也变了；
 * 留在 system 里等于每加载一次就改固定前缀。移到尾部后它只影响本轮追加。
 *（AGENT_TOOL_INDEX 回滚开关 2026-11-21 退役，名单非空时恒渲染。）
 */
export const toolIndexProvider: InjectionProvider = (ctx) => {
	const text = toolIndexText(ctx.deferred ?? []);
	if (!text) return undefined;
	return entry("tool_index", text, INJECTION_ORDER.tool_index, "message", "turn");
};

/**
 * 外接记忆库的库目录常驻段（2026-11-23 外部记忆库接入；2026-11-24 旧形态退役后唯一目录来源）。
 *
 * 只在当前槽位 = external 时注入；文本来自 memory-bank 的 `bankCatalogCachedText()`
 * （10 分钟刷新；失败保留旧文本，取不到 = 整段不注）。内置槽位不注目录（契约 §1.3）。
 */
export const externalBankCatalogProvider: InjectionProvider = (ctx) => {
	if (ctx.group) return undefined;
	if (isNonChiefPartner(ctx.partnerId)) return undefined;
	// 总闸 / 读闸任一关：整段消失（PERSONA_MEMORY_INJECT × 当前槽位 external × 读入口）。
	if (personaInjectGatesClosed()) return undefined;
	const catalog = bankCatalogCachedText();
	if (!catalog) return undefined;
	return entry(
		"persona_catalog",
		`${EXTERNAL_BANK_CATALOG_TITLE}\n${catalog}`,
		INJECTION_ORDER.persona_catalog,
		"system",
	);
};

/** B 期登记表（顺序 = lifecycle sections 数组下标顺序；section 物理位置不由它决定）。 */
export const LIFECYCLE_SECTION_PROVIDERS: readonly InjectionProvider[] = [
	personaProvider,
	verificationIronLawProvider,
	clarifyContractProvider,
	currentProjectProvider,
	externalBankCatalogProvider,
	skillsProvider,
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

/**
 * 一生记忆库轻召回（2026-11-22 记忆外挂源批，方案 §2.2）：
 *
 * 大库命中行做**第二级**：小库 memory_recall 照旧第一级（16 条 / 2000 字），这里
 * ≤3 条 / 800 字独立预算，紧跟其后（order 105）——先最近与偏好，再一生库的旧事。
 * 分层不进打分池（两库条目不同构），分组标题【更早的记录】在这里拼（personaLightRecall
 * 只回行数组，标题属于接线层——它告诉模型"这是背景不是话题"）。
 *
 * async provider：`collectInjections` 的 provider 契约允许返回 Promise 吗——不允许，
 * provider 必须同步。所以本条不能直接进 LIFECYCLE_MESSAGE_PROVIDERS；它在
 * lifecycle-harness 的 beforeRequest 里 await 后以既有 ctx 拼条目（见该文件消息注入处）。
 * 群聊整段跳过（与 recall 的外部槽同口径）；执事会话照进（执事也该记得主人的旧事）。
 */
export const PERSONA_RECALL_LIGHT_HEADER =
	"【更早的记录】（来自主人一生的记忆库，背景不是话题；查不到 ≠ 没有这回事）";

export async function personaRecallLightTextFor(
	ctx: InjectionContext,
	deps: {
		spawnFn?: typeof spawn;
		env?: NodeJS.ProcessEnv;
		command?: string[];
		cwd?: string;
		/** 轻召回超时（2026-11-24）：外部槽位传 memory-bank 的 timeouts.lightMs；缺省 8s。 */
		timeoutMs?: number;
	} = {},
): Promise<string | undefined> {
	if (ctx.group) return undefined;
	// 2026-11-23：外部记忆库槽位用合成 env（bankSpawnEnv）把 ASK / ENABLED / INJECT 钉成
	// 当前 bank 的值；不传 env 时与今天逐字节一致。
	if (deps.env ? personaInjectGatesClosed(deps.env) : personaInjectGatesClosed()) return undefined;
	const text = ctx.userText ?? "";
	if (!text.trim()) return undefined;
	const lines = await personaLightRecall(text, {
		conversationId: ctx.conversationId,
		env: deps.env ?? process.env,
		// 传合成 env = 当前外接库：组名不固定，按扁平 hits 处理。
		anyGroups: Boolean(deps.env),
		...(deps.command ? { command: deps.command } : {}),
		...(deps.cwd ? { cwd: deps.cwd } : {}),
		...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
		...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
	});
	if (lines.length === 0) return undefined;
	return [PERSONA_RECALL_LIGHT_HEADER, ...lines].join("\n");
}

/**
 * 消息注入登记表（顺序 = 排序常量；2026-11-19 起实际发送位置改为**请求尾部**）。
 *
 * 2026-11-19 前缀锁定：这里的条目不再以 system 角色拼到请求最前面，而是合成一条
 * user 角色消息追加到 `request.messages` 尾部——见 `lifecycle-harness.ts` 的 beforeRequest。
 * 原因：OpenAI 兼容层会把任何位置的 system 折叠进第一条 system，等于改固定前缀。
 */
export const LIFECYCLE_MESSAGE_PROVIDERS: readonly InjectionProvider[] = [
	currentProjectLiveProvider,
	// 低频工具索引（2026-11-25）：order 70，排在消息注入之前、project_index 之前。
	toolIndexProvider,
	projectIndexProvider,
	memoryRecallProvider,
	skillSlashProvider,
	recoverNoteProvider,
	turnLimitApproachingProvider,
	turnLimitProvider,
	partnerContextProvider,
];

/**
 * 当前轮该跑的消息注入登记表（2026-11-23 记忆库槽位）。
 *
 * `skipInternalMemory=true`（外部记忆库槽位）：跳过内置 `memoryRecallProvider`——
 * 个人记忆已由当前 bank 的轻召回（ask.py）承担，两套一起注就是双份。
 * `projectIndexProvider` / `taskMemoryProvider` 不属于个人记忆库，一律不动。
 */
export function lifecycleMessageProviders(options: {
	skipInternalMemory?: boolean;
} = {}): readonly InjectionProvider[] {
	if (!options.skipInternalMemory) return LIFECYCLE_MESSAGE_PROVIDERS;
	return LIFECYCLE_MESSAGE_PROVIDERS.filter((provider) => provider !== memoryRecallProvider);
}
