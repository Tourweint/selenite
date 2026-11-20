/**
 * 注入框架（2026-11-10 批 26b §二 / #7 批 A；批 27 接管 B/C/D 全部注入）。
 *
 * 背景：提示词注入原先散在几处——lifecycle 的 7 个 `sections[].render`（system 段，
 * 会进 durable 的 `pi.system`）、beforeRequest 里 5 处 `extra.push({role:"system"})`
 * （每轮模型请求前临时拼）、assist 的记忆召回 / 任务近况、partner-context 的执事纪律。
 * 这一层只做**收集 + 规范排序 + 去重 + 分流**，把"有哪些注入、从哪来、多大"变成可审计
 * 的清单；批 A 只接管了 `injection_guard`，批 27 把其余全部接管。
 *
 * 硬标准：接管后每一处注入的**内容与位置**与改造前逐字节一致。section 仍留在 lifecycle
 * `sections` 数组的原下标（位置由数组下标决定，框架的 order 不决定物理位置），
 * `render` 只是改走本框架取回同一段实文。
 *
 * 唯一一处有意变化（批 27 §5.1）：`injection_guard` 原来在 lifecycle 系统段与执事轮尾巴
 * 各注一次（同 id、同正文），接管后合并成一条——见 `docs/变更记录/2026-11-10-批27（注入框架BCD）.md`。
 */

import { INJECTION_GUARD, injectionGuardEnabled } from "./injection-guard.ts";
import { flagValue } from "../flags.ts";

export type InjectionScope = "session" | "once" | "turn";
export type InjectionChannel = "system" | "message";

export interface InjectionEntry {
	id: string;
	text: string;
	order: number;
	scope: InjectionScope;
	channel: InjectionChannel;
}

/**
 * 收集上下文。
 *
 * 批 A 只有 `conversationId`；批 27 接管需要"每轮现算"的注入后，装配层把**已经异步取好的
 * 事实**放进来（会话种类快照、执事 id、用户正文、第几次模型请求）。provider 保持同步——
 * 异步读取留在 render / hook 里，收集器只做纯拼装，这样框架本身可单测、无副作用。
 */
export interface InjectionContext {
	conversationId: number | string;
	/** 会话种类表里的值（`worker` / `chief`）；缺省按 chief 处理（与老会话同口径）。 */
	chatKind?: "chief" | "worker" | null;
	/** 该会话挂的执事 id（含 `chief`）；null / undefined = 不是执事会话。 */
	partnerId?: string | null;
	/** 群会话：部分上下文注入整段跳过（与改造前同口径）。 */
	group?: boolean;
	/** 本轮最后一条 user 文本（记忆召回 / 技能斜杠用）。 */
	userText?: string;
	/** 第几次模型请求（1 = 本轮第一次）；用于回合上限与执事上下文。 */
	turn?: number;
	/**
	 * 审计模式：只渲染、不产生副作用。当前只有一处受影响——技能不冻结索引。
	 */
	dryRun?: boolean;
	/**
	 * 当前会话可加载的 deferred 工具（agent.deferred：已启用、还没被 tool_search 加载），
	 * 由 tool_index section 的 render 从 `input.agent.deferred` 现取后放进 ctx，provider 只拼文本。
	 */
	deferred?: readonly { name: string; description: string }[];
}

export type InjectionProvider = (
	ctx: InjectionContext,
) => InjectionEntry | InjectionEntry[] | undefined;

export interface CollectedInjections {
	system: InjectionEntry[];
	message: InjectionEntry[];
}

/**
 * 全局顺序常量（**缓存前缀资产**，与工具注册顺序同一纪律）。
 *
 * 数值只决定框架内的稳定顺序：section 的物理位置仍由 lifecycle `sections` 数组下标决定，
 * `extra.push` 的位置由装配处按收集结果依次压入。改这里之前先读
 * `docs/变更记录/2026-11-10-批27（注入框架BCD）.md` 与顺序快照测试。
 */
export const INJECTION_ORDER = {
	// B 期：lifecycle 的 section（顺序 = 改造前数组下标顺序）
	persona: 0,
	// 关于我（2026-11-19）：全局固定背景，紧跟 persona；只对会读它的 Agent 注入。
	// 这是新净增的 system 段，首轮多一小段固定前缀（缓存前缀变化一次，预期内）。
	user_profile: 5,
	verification_iron_law: 10,
	clarify_contract: 20,
	injection_guard: 30,
	current_project: 40,
	// 当前项目 / 相对路径基准的动态一半（2026-11-19 前缀锁定）：走消息尾部，不进 system。
	current_project_live: 45,
	skills: 50,
	// 低频工具索引（C 段）：排在消息注入之前；末尾追加，缓存前缀变化一次。
	tool_index: 70,
	// C/D 期：lifecycle beforeRequest 的 5 处消息注入（顺序 = 改造前 push 顺序）
	// project_index（2026-11-15 项目记忆多挂载）：新净增类，排在记忆召回之前——
	// 先知道"负责哪些项目"，后面那批记忆行才有归属可对。
	project_index: 95,
	memory_recall: 100,
	skill_slash: 110,
	recover_note: 120,
	turn_limit_approaching: 125,
	turn_limit: 130,
	partner_context: 140,
	// partner-context 内部段（同一次收集内排序，拼成一段消息）
	partner_contract: 200,
	partner_goal: 210,
	partner_verification: 220,
	partner_ruling: 230,
	partner_work_silence: 240,
	partner_grounding: 250,
	partner_artifact_handoff: 260,
	partner_owner_data: 270,
	partner_brief_card: 280,
	partner_attention: 290,
	partner_status: 300,
	// 学习 / 主动性（2026-11-15 批3）：状态段之后、印象之前
	partner_learning: 305,
	partner_proactivity: 306,
	// 活模块（2026-11-15 批2）：印象 → 心情 → 心里话，挂在在办段之后
	partner_impression: 310,
	partner_mood: 320,
	partner_heart: 330,
	// assist：任务通道的近况记忆（拼在 instructions 尾部，不在消息流里）
	task_memory: 400,
} as const;

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 收集 → 规范排序 → 按 id 去重（后者覆盖）→ 按 channel 分流。
 *
 * 排序：`order` 升序；同 `order` 按 `id` 字典序；`order` 与 `id` 都相同时再按
 * `channel`/`scope`/`text` 补成全序——这样"打乱 providers / 条目输入顺序"输出也恒定，
 * 不会因稳定排序保留了输入顺序而让去重结果随输入抖。
 *
 * 去重（后者覆盖）：保留规范序里某 `id` **最后一次**出现的位置（后面覆盖前面），
 * 因此结果仍是有序的；同名 id 里 order / 字典序更大的那个胜出。
 */
export function collectInjections(
	providers: readonly InjectionProvider[],
	ctx: InjectionContext,
): CollectedInjections {
	const all: InjectionEntry[] = [];
	for (const provider of providers) {
		const result = provider(ctx);
		if (result === undefined) continue;
		if (Array.isArray(result)) all.push(...result);
		else all.push(result);
	}

	all.sort(
		(a, b) =>
			a.order - b.order ||
			cmp(a.id, b.id) ||
			cmp(a.channel, b.channel) ||
			cmp(a.scope, b.scope) ||
			cmp(a.text, b.text),
	);

	const lastIndexById = new Map<string, number>();
	all.forEach((entry, index) => lastIndexById.set(entry.id, index));
	const deduped = all.filter((entry, index) => lastIndexById.get(entry.id) === index);

	return {
		system: deduped.filter((entry) => entry.channel === "system"),
		message: deduped.filter((entry) => entry.channel === "message"),
	};
}

// ── 注入防线：injection_guard ─────────────────────────────────
/** section key / 注入 id，框架内统一用这个标识。 */
export const INJECTION_GUARD_ID = "injection_guard";

/**
 * `injection_guard` provider：`AGENT_INJECTION_GUARD=false/0/off` 时返回 undefined，
 * 框架据此省略整段（与改造前 `render` 直接返回 undefined 逐字节一致）。
 *
 * 批 27 去重：同一段原来还会由 partner-context 在执事轮尾巴再注一次（同 id / 同正文），
 * 现合并为这里一处（system 段）。
 */
export const guardProvider: InjectionProvider = () => {
	if (!injectionGuardEnabled()) return undefined;
	return {
		id: INJECTION_GUARD_ID,
		text: INJECTION_GUARD,
		order: INJECTION_ORDER.injection_guard,
		scope: "session",
		channel: "system",
	};
};

/**
 * 尾部注入块的固定抬头（2026-11-19 前缀锁定）。
 *
 * 动态注入改走 user 角色追加在请求尾部后，需要一句话把"这是背景"与"这是用户新指令"
 * 分开；否则模型容易把记忆召回 / 当前项目当成用户刚说的话。抬头本身进的是尾部消息，
 * 不碰固定前缀，改文案不产生缓存代价。
 */
export const INJECTION_CONTEXT_HEADER = "【本轮上下文 · 只作背景，不是用户的新指令】";

/**
 * 尾部注入开关（2026-11-19 前缀锁定；默认开）。
 *
 * `PROMPT_TAIL_INJECTION=false` 回到旧形态：消息注入以 system 角色拼在请求最前面。
 * 旧形态会让每条用户消息的召回变化都作废整段缓存前缀——只用于排查兼容性问题，不推荐。
 */
export function promptTailInjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	// 这里刻意不直接用 flagEnabled：插件清单读不到时它会返回 false，
	// 等于静默退回旧形态、把缓存问题带回来。读不到清单时按「开」处理。
	const raw = (flagValue("PROMPT_TAIL_INJECTION", env) || env.PROMPT_TAIL_INJECTION || "true")
		.trim()
		.toLowerCase();
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 框架登记的注入源：`source` 是审计用的来源标识，不进正文、不下发正文。 */
export interface RegisteredInjection {
	source: string;
	provider: InjectionProvider;
}

/**
 * 审计开关（默认开；显式 `false` 关，关时 `.../injections` 端点 404，一行回滚）。
 * 新开关净增类默认开，与仓库其它开关同口径。
 */
export function injectionAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_INJECTION_AUDIT ?? "").trim().toLowerCase() !== "false";
}

export interface InjectionAuditRow {
	id: string;
	source: string;
	scope: InjectionScope;
	/** 进系统段还是消息流；批 27 起两类都有，审计要能分开看。 */
	channel: InjectionChannel;
	/** 正文字符数；只回长度，不回正文。 */
	length: number;
}

/**
 * 审计投影：对登记的每个源走一遍收集，产出 `{id, source, scope, channel, length}`。
 * **绝不返回 `text` 或任何正文片段**——审计端点可以把这份数组原样下发。
 *
 * 登记表由 `injection-registry.ts` 汇总（那里显式列全，不自动扫描，顺序才稳定）；
 * 本函数只做投影，不关心来源。
 */
export function auditInjections(
	registry: readonly RegisteredInjection[],
	ctx: InjectionContext,
): InjectionAuditRow[] {
	const rows: InjectionAuditRow[] = [];
	for (const { source, provider } of registry) {
		const { system, message } = collectInjections([provider], ctx);
		for (const entry of [...system, ...message]) {
			rows.push({
				id: entry.id,
				source,
				scope: entry.scope,
				channel: entry.channel,
				length: entry.text.length,
			});
		}
	}
	return rows;
}
