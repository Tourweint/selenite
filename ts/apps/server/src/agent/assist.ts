import { createMemoryEngine, scopeKey, type MemoryEngine, type MemoryScope } from "@lifediary/memory";
import { diaryStore } from "../diary.ts";
import { recentDiaryMemories, syncDiaryToMemory } from "../memory-ingest.ts";
import { preferenceExtractor } from "../memory-extract.ts";
import {
	COMPANIONS_ENABLED,
	chiefPartnerEnabled,
	chiefSkillsDir,
	ensureChiefPartner,
	partnersStore,
	resolvePartnerScope,
} from "../partners.ts";
import { APP_SKILLS_DIR, createSkillStore, resolveSkillsDir, type SkillStore } from "../skills.ts";

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
		const extractor = preferenceExtractor();
		return createMemoryEngine({
			dbPath: process.env.MEMORY_DB_PATH,
			candidateFloor: memoryCandidateFloor(),
			fts: memoryFtsEnabled(),
			decayDaily: memoryDecayDaily(),
			// 2026-11-06：不传 = 保持 memory 包的默认（HeuristicExtractor），
			// 即 `MEMORY_EXTRACT=rule` 与"模型不可用"这两种情况**逐字节回到旧行为**。
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
 * 技能目录（2026-11-08 扫尾批 9-S）：解析优先级 = AGENT_SKILLS_DIR 显式 → 用户目录
 * （%USERPROFILE%\.lifediary\skills，首访自动建）→ 应用目录兜底，见 skills.ts 的
 * resolveSkillsDir()。用户目录首访为空，所以 origin=user 时要并上应用目录
 * （先到先得），两条内置手册才不会消失。
 */
const resolvedSkills = resolveSkillsDir();
const SKILLS_DIRS: string[] =
	resolvedSkills.origin === "user" ? [resolvedSkills.dir, APP_SKILLS_DIR] : [resolvedSkills.dir];

export const skillStore: SkillStore | null = (() => {
	// 主对话（总管）技能（批次D D1）：总管技能目录优先、全局 skills/ 兜底，同名时总管覆盖全局
	// （createSkillStore 对目录数组按先到先得合并）。CHIEF_PARTNER=false 时只留全局目录 = 改动前。
	if (chiefPartnerEnabled()) {
		try {
			return createSkillStore([chiefSkillsDir(), ...SKILLS_DIRS]);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`总管技能目录加载失败，回落全局技能: ${detail}`);
		}
	}
	try {
		return createSkillStore(SKILLS_DIRS);
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
		const partner = partnerScopeOf(conversationId);
		return memoryEngine.buildContext({
			text,
			scopes: [
				"global",
				...(partner ? [scopeKey(partner)] : []),
				scopeKey({ type: "session", id: String(conversationId) }),
			],
		});
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
