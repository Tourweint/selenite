import { createMemoryEngine, scopeKey, type MemoryEngine, type MemoryScope } from "@lifediary/memory";
import { diaryStore } from "../diary.ts";
import { recentDiaryMemories, syncDiaryToMemory } from "../memory-ingest.ts";
import { memoryFallbackExtractor, preferenceExtractor } from "../memory-extract.ts";
import { INJECTION_ORDER, type InjectionEntry, type InjectionProvider } from "./injection.ts";
import {
	COMPANIONS_ENABLED,
	chiefPartnerEnabled,
	chiefSkillsDir,
	ensureChiefPartner,
	partnersStore,
	resolvePartnerScope,
} from "../partners.ts";
import { createSkillStore, resolveSkillsDir, skillsIndexSummaryChars, type SkillStore } from "../skills.ts";
import { getSkillState, skillStateEnabled } from "../skill-state.ts";
import { proactiveForTurn } from "../memory-proactive.ts";
import { memoryInjectDedupeEnabled, memoryInjectLimit, memoryInjectMaxChars } from "../memory-inject.ts";
import {
	partnerProjectMemoryEnabled,
	projectMemoryGateEnabled,
} from "../partner-contract.ts";
import {
	composeProjectRecallScopes,
	personaProjectIdsOfConversation,
	projectNameOf,
	projectScopeOfConversation,
} from "./project-scope.ts";

/**
 * 派活能力（chancellor）是否装。
 *
 * 默认装。关掉（`CHANCELLOR_ENABLED=false`）时工具清单回到 8 个，行为与改动前完全一致
 * ——这是回滚开关，不是功能开关：出问题时不用改代码，改一行环境变量就退回去。
 */
export const CHANCELLOR_ENABLED = (process.env.CHANCELLOR_ENABLED?.trim() || "true").toLowerCase() !== "false";

export const PERSONA = [
	"你是一个个人助手，和一个具体的人长期相处。记录生活是你们最常一起做的事，",
	"但对方提出别的要求（查东西、整理、动手做事）时也要正常帮忙。",
	// 2026-11-01 需求方：原来"有温度"读起来太软——像客服和哄人。
	// 口径改成"直接、克制、就事论事"：不撒娇、不堆情绪词、不和稀泥，也不说教。
	"说话直接、克制、就事论事，像个熟悉的朋友，不像客服。",
	"不撒娇、不堆情绪词、不为了安慰而安慰；对方情绪低时接住一句就够，不追问、不铺开。",
	"不说教、不打气、不总结人生道理。",
	// 2026-10-29 需求方定的硬约束：这条同时是"该动手时一定动手"的兜底 ——
	// 快档模型若为了省事直接编，用户会拿到假信息，比慢一点更糟。
	"凡是涉及真实文件、真实数据、真实日程或当前时间的事，必须先用工具去看，不许凭印象回答或编造；",
	"看不到就说看不到，并说明缺什么。闲聊和感受不需要调工具。",
	"记忆只在确有必要时检索（对方提到过去的事、需要接上以前的话），别每句都查。",
	"需要长期记住的事用 remember；想不起对方说过什么用 recall；要定时提醒用 set_reminder。",
].join("");

/**
 * 普通 worker 的人格（2026-11-06 侧栏调整 B2）。
 *
 * 为什么要单独一段：新建会话以前也走总管 persona——前端只是没把"总管"写进按钮，
 * 模型那边照样自称总管、默认维护执事档案。worker 是**普通任务助手**：
 * 不读总管 SOUL、不冒称总管、不建立执事身份，但工具闸门 / 工作区边界 / 审批一条不少。
 */
export const WORKER_PERSONA = [
	"你是一个普通任务助手，负责把交到你手上的具体事情办完。",
	"说话直接、克制、就事论事，给结论也给依据；不冒充总管，也不代表任何执事。",
	"涉及真实文件、真实数据、真实日程或当前时间的事，必须先用工具去看，不许凭印象回答或编造；看不到就说明缺什么。",
	"没有预设的私人档案，也不主动建立执事身份。",
	"需要长期记住的事用 remember；想不起对方说过什么用 recall；要定时提醒用 set_reminder。",
].join("");

/**
 * 新会话能不能开成 worker（2026-11-06 B2 回滚开关）：`WORKER_CHAT_ENABLED=false` 只拦**新建**，
 * 已经落盘的 worker 保持原身份（不把旧 worker 重解释成总管）。默认启用。
 */
export function workerChatEnabled(): boolean {
	const raw = process.env.WORKER_CHAT_ENABLED?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

// ── 记忆 ─────────────────────────────────────────────────
/** 召回候选窗口下限（2026-11-04 批次一 A2-S）：不配 = 200；设 50 = 旧行为。 */
function memoryCandidateFloor(): number | undefined {
	const raw = Number(process.env.MEMORY_CANDIDATE_FLOOR);
	return Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * 召回检索器（2026-11-04 批次三 A2-F）：`auto`（默认，FTS5 trigram 候选集） / `js`（批次一窗口路径）。
 * 只在装配处读 env —— memory 包本身不碰环境变量。
 */
function memoryFtsEnabled(): boolean {
	return (process.env.MEMORY_RETRIEVER ?? "").trim().toLowerCase() !== "js";
}

/**
 * 记忆时间衰减（2026-11-08 扫尾批 6 §一）：日衰减系数，默认 0.99；`0` = 关（回滚）。
 * 空串 / 非数字 / 越界一律回落默认值——衰减是后台机制，不该被一个坏 env 卡死。
 */
function memoryDecayDaily(): number {
	const raw = (process.env.MEMORY_DECAY_DAILY ?? "").trim();
	if (!raw) return 0.99;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 1) return 0.99;
	return value;
}

export const memoryEngine: MemoryEngine | null = (() => {
	if (process.env.MEMORY_ENABLED === "false") return null;
	try {
		const extractor = preferenceExtractor() ?? memoryFallbackExtractor();
		return createMemoryEngine({
			dbPath: process.env.MEMORY_DB_PATH,
			candidateFloor: memoryCandidateFloor(),
			fts: memoryFtsEnabled(),
			decayDaily: memoryDecayDaily(),
			// 2026-11-06：不传 = 保持 memory 包的默认（HeuristicExtractor），
			// 即 `MEMORY_EXTRACT=rule` 逐字节回到旧行为。
			// 2026-11-13：模型不可用时，若 `MEMORY_EXTRACT_NOISE` 开（默认），
			// 用带噪声过滤的规则抽取器；关掉 = 不传 = 旧行为。
			...(extractor ? { extractor } : {}),
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`记忆库初始化失败，本次以无记忆运行: ${detail}`);
		return null;
	}
})();

// ── 技能 ─────────────────────────────────────────────────
/**
 * 技能读取链（2026-11-08 批 10-A）：`resolveSkillsDir().dirs` 已经是完整的合并链——
 * AGENT_SKILLS_DIR 显式 / 用户目录（首访自动建）→ `%USERPROFILE%\.agents\skills`（只读）
 * → 应用目录兜底。主目录排第一，用户目录为空时内置手册仍然可见；同名先到先得。
 */
const resolvedSkills = resolveSkillsDir();
const SKILLS_DIRS: string[] = resolvedSkills.dirs.map((source) => source.dir);

// 技能启停位（2026-11-09 用户拍板：默认全关，界面上开）。SKILL_STATE=false 逃生门 = 回到全进索引。
// 注意 getSkillState() 在闭包里懒取（别在模块顶层解构）——首次调用发生在请求期，.env 已就绪。
const skillVisible = (name: string): boolean =>
	!skillStateEnabled() || getSkillState().isEnabled(name);

// 2026-11-15 按人可见：全局开 || 该人覆盖开。SKILL_STATE=false 逃生门仍 = 全进索引。
const skillVisibleFor = (partnerId: string, name: string): boolean =>
	!skillStateEnabled() || getSkillState().isEnabledFor(partnerId, name);

export const skillStore: SkillStore | null = (() => {
	// 主对话（总管）技能（批次D D1）：总管技能目录优先、全局 skills/ 兜底，同名时总管覆盖全局
	// （createSkillStore 对目录数组按先到先得合并）。CHIEF_PARTNER=false 时只留全局目录 = 改动前。
	if (chiefPartnerEnabled()) {
		try {
			return createSkillStore([chiefSkillsDir(), ...SKILLS_DIRS], {
				visible: skillVisible,
				visibleFor: skillVisibleFor,
				// 索引摘要截断（2026-11-15 上下文预算批）：传函数 = 每次首渲染现读 env，
				// 界面「行为开关」改完，新开的会话立即按新值渲染（老会话按冻结口径不变）。
				indexSummaryChars: skillsIndexSummaryChars,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`总管技能目录加载失败，回落全局技能: ${detail}`);
		}
	}
	try {
		return createSkillStore(SKILLS_DIRS, {
			visible: skillVisible,
			visibleFor: skillVisibleFor,
			indexSummaryChars: skillsIndexSummaryChars,
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`技能目录加载失败，本次无技能可用: ${detail}`);
		return null;
	}
})();

/**
 * 总管播种（服务启动时调一次）。CHIEF_PARTNER=false / 执事能力关闭时 ensureChiefPartner 内部旁路。
 * 播种失败只 warn：主对话的 persona 会回落 PERSONA 常量，绝不会被弄哑。
 */
export function seedChiefPartner(): void {
	try {
		ensureChiefPartner(PERSONA);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[chief] 总管播种失败（主对话回落 PERSONA）: ${detail}`);
	}
}

/**
 * 记忆作用域跟着**内部会话 id** 走。
 *
 * 它是存储自己发的、重开进程也不变，所以作用域稳定。
 * 对外暴露的 conversationId 是另一个东西（下面 Chats 里的 uuid），
 * 用它会把"客户端标识"和"存储主键"绑在一起，以后换实现就麻烦了。
 */
/**
 * 执事会话的执事 scope（批次B B1/B2）：会话挂在链接表上 → 它属于某个执事，
 * 记忆读写落到 `partner:<uuid>` 键空间（与主人记忆隔离）。查失败一律当普通会话，
 * 记忆永远不能把对话卡住。
 */
function partnerScopeOf(conversationId: number): MemoryScope | null {
	if (!COMPANIONS_ENABLED) return null;
	try {
		// D15 刻意差异：主对话就是总管，他继续读写 global + session，不吃 partner: 键空间。
		// partnerId === "chief" → null 的判定在 partners.ts 的 resolvePartnerScope（同名纯函数也供单测），
		// 别把它"修"成和普通执事一致；除总管外的执事会话行为完全不变。
		return resolvePartnerScope(partnersStore(), conversationId);
	} catch {
		return null;
	}
}

export function scopeOf(conversationId: number): MemoryScope {
	return partnerScopeOf(conversationId) ?? { type: "session", id: String(conversationId) };
}

/**
 * 偏好该落哪个 scope（2026-11-06）。
 *
 * - 主对话（总管 / 普通会话 / worker）→ `global`：偏好是**关于这个人**的，
 *   换个会话照样该生效；
 * - 执事会话 → `partner:<id>`：执事的记忆键空间与主人隔离（D15），
 *   偏好也该留在它自己的地盘里，不能写进主人的 global。
 */
export function preferenceScopeOf(conversationId: number): MemoryScope {
	return partnerScopeOf(conversationId) ?? { type: "global" };
}

/** 召回失败绝不能让对话失败，所以一律吞掉并降级为空上下文。 */
export function recallContext(conversationId: number, text: string): string {
	if (!memoryEngine || !text.trim()) return "";
	try {
		// 群会话不参与记忆引擎（2026-11-06 群组方案 §2.2）：召回整个跳过，
		// 群聊不写不读个人记忆防串台；群内连续性靠会话历史 + 群时间线本身。
		if (partnersStore().isGroupSession(conversationId)) return "";
		// 执事会话（批次B B1）：global + 执事键空间 + 本会话三条都进候选；
		// 键空间过滤是 store 的硬过滤（scope IN），执事键空间外的记录不会被召回。
		// 项目记忆（2026-11-15 项目记忆方案）：会话归属项目时项目键空间也进候选——
		// 项目口径只在聊这个项目的会话里浮出来，别的会话零打扰。
		// 人格挂载（2026-11-15 跟人走立项、同日多挂载方案扩化）：档案勾选的"负责项目"
		// 对该人格的全部对话生效——但只保证**可达**，不整包搬进上下文：
		// 绑定项目全权进池；其余挂载项目走 gatedScopes（字面命中才进候选，"聊到才注入"
		// 是硬规则不是打分巧合）。worker 跟文件夹走（上面的 project），两层互不干扰。
		// PROJECT_MEMORY_GATE=false 退回"挂载全权进池"（跟人走当日形态）。
		const partner = partnerScopeOf(conversationId);
		const project = projectScopeOfConversation(conversationId);
		const mounted = personaProjectIdsOfConversation(conversationId);
		// 项目 scope 组装收在纯函数里（可单测）：绑定全权进池，其余挂载走闸门。
		const boundProjectId = project?.type === "project" ? project.id : null;
		const { fullKeys: mountedFullKeys, gatedKeys } = composeProjectRecallScopes(
			boundProjectId,
			mounted,
			projectMemoryGateEnabled(),
		);
		// 注入预算（2026-11-15 追加批）：原先是 memory 包硬编码的 8 条 / 1200 字，
		// 偏好攒满 8 条后其余记忆（含项目记忆）一条进不来——默认放宽到 16 条 / 2000 字，
		// MEMORY_INJECT_LIMIT / MEMORY_INJECT_MAX_CHARS 可调，显式设回 8/1200 即旧形态。
		return memoryEngine.buildContext(
			{
				text,
				scopes: [
					"global",
					...(partner ? [scopeKey(partner)] : []),
					...(project ? [scopeKey(project)] : []),
					...mountedFullKeys,
					scopeKey({ type: "session", id: String(conversationId) }),
				],
				...(gatedKeys.length > 0 ? { gatedScopes: gatedKeys } : {}),
				limit: memoryInjectLimit(),
			},
			// 「也许值得提起」（2026-11-10 批 17 §二）：默认关；执事轮不注入，
			// 免得执事在干活时被旧事带走（总开关与执事判断都在 memory-proactive.ts）。
			{
				proactive: proactiveForTurn(partner !== null),
				maxChars: memoryInjectMaxChars(),
				// 召回后去重（2026-11-15）：同一件事的多种说法只留分数最高的一条，
				// 别让复读占名额。MEMORY_INJECT_DEDUPE=false 一行回滚。
				dedupe: memoryInjectDedupeEnabled(),
				// 项目来源的记忆行带项目名（2026-11-15 多挂载）：跨项目候选同池时
				// 模型才知道这条口径说的是哪个项目。解析不出名字 → 旧格式。
				scopeLabel: (key) => projectNameOf(key.slice("project:".length)),
			},
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`记忆召回失败，本轮不使用记忆: ${detail}`);
		return "";
	}
}

/**
 * 任务会话的"近况记忆"块（2026-10-31，记忆方案 §3 的 B 路 + §4 注入例外）。
 *
 * 给**需要知道最近记了什么**的任务用（目前只有 `question` / `diary_review`）：
 * 数据源是日记镜像（`diary.sqlite` 近 N 天 `CONFIRMED`），不经过 App——
 * App 不再拼画像/近况（它是两处真相的源头，见方案 D7）。
 *
 * 位置：**拼在 instructions 的尾部**。这样模板那一大段前缀不变，缓存照旧命中，
 * 只有"近况"这一小段是新的（§2.3 实测：尾部追加不破坏前缀）。
 */
export function taskMemoryBlock(days = 3, limit = 12): string {
	try {
		// 2026-10-31 二次收口：**先把镜像里的成稿摄入记忆，再从记忆取**。
		// 之前这里直接读 diary.sqlite，等于在记忆系统旁边开了条捷径——聊天走记忆、任务读镜像，
		// 两套并存，才会出现"记忆库是空的"这种怪事。现在两边同一个源。
		syncDiaryToMemory(days);
		let items = recentDiaryMemories(days, limit);
		if (items.length === 0) {
			// 兜底：记忆库还没就绪（例如 MEMORY_ENABLED=false）时，至少别让提问瞎问
			const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
			items = diaryStore()
				.recent(since, limit)
				.filter((entry) => (entry.finalText ?? "").trim().length > 0)
				.map((entry) => ({
					date: entry.entryDate ?? "",
					text: String(entry.finalText).replace(/\s+/g, " ").trim(),
				}));
		}
		if (items.length === 0) return "";
		const lines = items.map((item) => `- ${item.date || "（无日期）"}：${item.text.slice(0, 120)}`);
		return [
			"<memory>",
			`最近 ${days} 天你自己记下的（只作参考：可以呼应，不要逐条复述，也不要评价记多记少）：`,
			...lines,
			"</memory>",
		].join("\n");
	} catch (error) {
		// 记忆读失败绝不能让任务失败（镜像/记忆库可能都还没建）
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 近况读取失败，本次不注入: ${detail}`);
		return "";
	}
}

// ── 注入 provider（2026-11-10 批 27 §二）────────────────────
//
// 记忆的两个注入口都从这里出，装配层只收集、不再自己拼字符串：
//   1. `recallContext` → 每轮模型请求前的 system 消息（lifecycle beforeRequest 第 1 处）；
//   2. `taskMemoryBlock` → 任务通道 instructions 尾部（openai-compat 的 X-Task 分支）。
// 人格常量（PERSONA / WORKER_PERSONA）是 persona section 的实文来源，已在 B 期随
// `lifecycle-injections.ts` 接管——合起来就是"assist 涉及 3 处注入"的口径。

function memoryEntry(text: string): InjectionEntry {
	return {
		id: "memory_recall",
		text,
		order: INJECTION_ORDER.memory_recall,
		scope: "turn",
		channel: "message",
	};
}

/**
 * 聊天记忆召回：每轮现算，空串不注（与改造前 `if (memory)` 同口径）。
 *
 * 2026-11-15 人设页打磨二轮：这一位显式关掉「记忆」注入时（`persona_switches.memoryRecallEnabled=false`）
 * 整段不注——只关"自动带记忆"这一半，`recall` 工具照旧能主动查。解析不到执事（普通会话）
 * 或读库失败都不拦（宁可按旧行为带上记忆）。
 */
export const memoryRecallProvider: InjectionProvider = (ctx) => {
	if (memoryRecallOff(Number(ctx.conversationId))) return undefined;
	const text = recallContext(Number(ctx.conversationId), ctx.userText ?? "");
	return text ? memoryEntry(text) : undefined;
};

/**
 * 自动记忆注入是否被关（父子两级，2026-11-16）：
 *   父 = 全局总闸 `PARTNER_MEMORY_RECALL`（设置 → 插件；关 = 所有会话都不自动带）；
 *   子 = 该会话所属执事/总管的 `persona_switches.memoryRecallEnabled === false`（默认开）。
 * 读不到 / 不是执事会话 / 查库失败 → 只受父闸管（宁可按旧行为带上记忆）。
 */
function memoryRecallOff(conversationId: number): boolean {
	if ((process.env.PARTNER_MEMORY_RECALL?.trim() || "true").toLowerCase() === "false") return true;
	try {
		const partnerId = partnersStore().partnerIdOfSession(conversationId);
		if (!partnerId) return false;
		return partnersStore().get(partnerId)?.personaSwitches.memoryRecallEnabled === false;
	} catch {
		return false;
	}
}

/**
 * 负责项目索引（2026-11-15 项目记忆多挂载）：一行可达性感知。
 *
 * 挂载项目的记忆平时不整包进上下文（聊到才浮出，闸门在 recallContext）——模型得
 * 先知道"自己负责哪几摊"，才会在该查的时候去 recall、该记的时候指名写。
 * 一行几十个字，杂事聊天零负担。全名解析不出（项目库没接线 / 项目刚删）就不注。
 */
export const projectIndexProvider: InjectionProvider = (ctx) => {
	if (ctx.group) return undefined;
	if (!partnerProjectMemoryEnabled()) return undefined;
	const mounted = personaProjectIdsOfConversation(Number(ctx.conversationId));
	if (mounted.length === 0) return undefined;
	const names = mounted
		.map((id) => projectNameOf(id))
		.filter((name): name is string => Boolean(name));
	if (names.length === 0) return undefined;
	return {
		id: "project_index",
		text: [
			`你负责的项目：${names.join("、")}。`,
			"聊到哪个项目，相关的项目记忆会自动想起；拿不准就用 recall 主动查。",
			// 多挂载才需要指名：单挂载时 remember scope=project 自动落到唯一那个。
			...(mounted.length > 1
				? ["要记某个项目的口径（怎么构建 / 部署、踩过的坑），用 remember 的 project 参数指名写。"]
				: []),
		].join("\n"),
		order: INJECTION_ORDER.project_index,
		scope: "turn",
		channel: "message",
	};
};

/**
 * 任务近况记忆：拼在 instructions 尾部（不是消息流）。空 = 不注。
 * `channel: "system"` 表示"系统侧文本"，位置由调用方决定（openai-compat 的模板尾部）。
 * 审计（dryRun）不跑：`taskMemoryBlock` 会先摄入日记镜像（写库），读端点不该有副作用。
 */
export const taskMemoryProvider: InjectionProvider = (ctx) => {
	if (ctx.dryRun) return undefined;
	const text = taskMemoryBlock();
	if (!text) return undefined;
	return {
		id: "task_memory",
		text,
		order: INJECTION_ORDER.task_memory,
		scope: "turn",
		channel: "system",
	};
};
