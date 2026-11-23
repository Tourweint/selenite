import type { spawn } from "node:child_process";
import { flagEnabled } from "./flags.ts";
import {
	askPersona,
	askPersonaAvailable,
	askPersonaCatalog,
	personaAskEnabled,
	PERSONA_GROUP_ORDER,
	type PersonaGroup,
	type PersonaHit,
} from "./persona-ask.ts";

/**
 * 一生记忆库外挂注入（2026-11-22 记忆外挂源批，方案 §2.2 / §2.3）。
 *
 * 背景：大库（persona-metric）此前只有 persona_recall 工具——赌模型每轮"记得去查"，
 * 忘一次大库就等于不存在。本模块把大库接进每轮自动召回，但**大库条目不进小库打分池**
 * （两库条目不同构，分层配额比统一打分干净）：
 *   - 轻召回 `personaLightRecall`：每轮消息尾部 ≤3 条 / 800 字，独立于 memory 召回的
 *     16 条 / 2000 字预算，分组标题由接线处（lifecycle-injections）拼；
 *   - 库目录 `refreshPersonaCatalogInjection` + `personaCatalogCachedText`：
 *     ask.py --catalog-only 的库边界裁到 ≤600 字，system 段常驻。
 *
 * 只读契约（D-甲 / D-丙）不破：唯一入口仍是 ask.py 子进程（经 persona-ask.ts 的
 * askPersona / askPersonaCatalog），本模块绝不直接碰 persona.db。
 *
 * 放 server 不放 memory 包：spawn python 是 server 的装配事，依赖方向单向
 * `shared ← memory ← server`，memory 包不 import persona-ask。
 *
 * 日志纪律：只记字数 / ok / 组数 / 条数 / 耗时，不记 query 原文与条目正文（硬约束）。
 */

/**
 * 总闸 + 父闸一起判（2026-11-22 记忆外挂源批）：任一不过，轻召回与目录都整段消失。
 *
 * 总闸 `PERSONA_MEMORY_INJECT` 默认开——ASK 已配置即有库，注入是它的自然延伸；
 * `false` 一行回到"只有 persona_recall 工具"的今日形态。父闸 = `PERSONA_MEMORY_ASK`
 * 已配置 + `PERSONA_MEMORY_ENABLED` 未显式关（与 persona_recall 工具注册双闸同口径）。
 */
export function personaInjectGatesClosed(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!flagEnabled("PERSONA_MEMORY_INJECT", env)) return true;
	if (!askPersonaAvailable(env) || !personaAskEnabled(env)) return true;
	return false;
}

// ── 轻召回（personaLightRecall，方案 §2.2）──────────────────

/** 60s 节流：一个 user 轮里有多个工具回合，beforeRequest 每个回合都会来取，
 *  不能每次都起 python（实测 0.8s/次）。措施与 provider.ts 的探活 in-flight Map 同款。 */
const LIGHT_THROTTLE_MS = 60_000;
/** 少于这个数有效汉字不 spawn："嗯""哈哈"不值得起 python，0 成本直接空（方案 §2.2 步骤 2）。 */
const LIGHT_MIN_HANZI = 6;
/** ask.py 每组限 2：六组最多 12 条原始候选，门槛 / 去重之后截到 ≤3 条足够。 */
const LIGHT_ASK_LIMIT = 2;
const LIGHT_MAX_LINES = 3;
/** 单条正文超长截断带省略号，总长 ≤120（含省略号）。 */
const LIGHT_MAX_LINE_CHARS = 120;
/** 轻召回组总预算（字）；≤3 条 × ≤120 字的行放得下，这层是兜底不是常态。 */
const LIGHT_MAX_TOTAL_CHARS = 800;
/** 节流账本上限：按会话记账，超出的丢最旧（与 context-inspect 的 LRU 同款保险）。 */
const LIGHT_LAST_MAX = 256;

const lightLast = new Map<string, { at: number; lines: string[] }>();
const lightInflight = new Map<string, Promise<string[]>>();

function rememberLight(key: string, at: number, lines: string[]): void {
	lightLast.set(key, { at, lines });
	while (lightLast.size > LIGHT_LAST_MAX) {
		const oldest = lightLast.keys().next().value;
		if (oldest === undefined) break;
		lightLast.delete(oldest);
	}
}

/** 测试用：清空轻召回节流账本（单测之间互不串味）。 */
export function resetPersonaLightRecallForTests(): void {
	lightLast.clear();
	lightInflight.clear();
}

/** 字符二元组集合（与 memory 包 recall.ts 的 bigrams 同口径；那边是内部函数不导出，就地实现）。 */
function bigrams(text: string): Set<string> {
	const set = new Set<string>();
	for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
	return set;
}

function jaccard(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	const [small, large] = left.size <= right.size ? [left, right] : [right, left];
	for (const gram of small) if (large.has(gram)) shared += 1;
	return shared / (left.size + right.size - shared);
}

/**
 * 双字片段的"虚词剥离"（2026-11-22 记忆外挂源批 P3 冒烟校准）。
 *
 * 实测（真库冒烟）：闲聊"今天天气真不错啊"会漏 2 条无关片——query 的「真不」「不错」
 * 这类含功能字的片段恰是正文高频，双字交集照直放行。判相关必须看**内容词**有没有
 * 命中，不看虚词碰巧重叠。功能字表取常见虚词（不含「时/候」这类时间词——「时间」「时候」
 * 本身是内容词，剥掉会误伤）。
 */
const INFORMATIVE_FILLER = new Set(
	"的了是么吗呢吧啊不真呀哦哎太也还就只这那和跟与很把被给对从到为会要能想我你他她它又且或与及了个什怎".split(""),
);

/** 含任一虚词的双字不算内容词；全被剥掉（纯虚词 query）返回空集 → 关键词命中类一律拦。 */
function informativeBigrams(text: string): Set<string> {
	const set = new Set<string>();
	for (let i = 0; i < text.length - 1; i += 1) {
		const gram = text.slice(i, i + 2);
		if (!INFORMATIVE_FILLER.has(gram[0]) && !INFORMATIVE_FILLER.has(gram[1])) set.add(gram);
	}
	return set;
}

/** 一条命中是否与 query 有**内容词**命中：任一内容双字出现在正文里（2026-11-22 P3 校准）。 */
function hasInformativeMatch(body: string, query: string): boolean {
	const grams = informativeBigrams(query);
	if (grams.size === 0) return false;
	return [...grams].some((gram) => body.includes(gram));
}

/**
 * 一条命中渲染成注入行：`- [日期] 正文（组 · 来源）`（方案 §2.2 步骤 7 的示例格式）。
 * fact 组 conf=user 的条目标「用户亲口确认」——mapHit 不透传 conf（persona-ask 的导出
 * 形状不动），但这类条目的 why 固定带「用户亲口确认」，用它判别与 conf=user 一一对应。
 * 正文取 text，缺了回落 title（entity / tension 的正文在 title 里）；两者皆空不渲染。
 */
function renderHitLine(hit: PersonaHit, group: PersonaGroup): string | null {
	const body = (hit.text ?? hit.title ?? "").replace(/\s+/g, " ").trim();
	if (!body) return null;
	const suffix =
		group === "fact" && (hit.why ?? "").includes("用户亲口确认")
			? "用户亲口确认"
			: hit.source
				? `${group} · ${hit.source}`
				: group;
	const date = hit.date ? `${hit.date} ` : "";
	const prefix = `- ${date}`;
	const suffixLen = `（${suffix}）`.length;
	// 单条 ≤120 是**整行**口径（含日期前缀与组标注）：正文按余量截断带省略号，
	// 保证渲染出的每一行都不超预算，模型侧无需再猜。
	const bodyBudget = LIGHT_MAX_LINE_CHARS - prefix.length - suffixLen;
	const clipped =
		body.length <= bodyBudget ? body : `${body.slice(0, bodyBudget - 1)}…`;
	return `${prefix}${clipped}（${suffix}）`;
}

export interface PersonaLightRecallOptions {
	/** 会话 id（必传）：60s 节流按会话记账。 */
	conversationId: string | number;
	/** 测试注入口：假 spawn（生产不传）。 */
	spawnFn?: typeof spawn;
	/** 测试 / 探针注入 env（生产走 process.env）。 */
	env?: NodeJS.ProcessEnv;
	/** 时间源（测试注入口）。 */
	now?: () => number;
}

/**
 * 每轮轻召回：给定本轮 user 文本，返回大库命中行（已过相关性门槛、已去重、已限额）。
 *
 * 流程（方案 §2.2）：闸门 → 短文本前置过滤 → 60s 节流 / 单飞 → ask.py（每组限 2）→
 * echo 抑制 → 相关性门槛 → 条目去重 → 限额截断 → 渲染。
 *
 * 未配置 / 总闸关 / 短文本 / 超时 / 失败 —— 一律静默返回 []，**绝不抛异常**
 * （与 recallContext 同口径：记忆永远不能把对话卡住）。
 */
export async function personaLightRecall(
	text: string,
	options: PersonaLightRecallOptions,
): Promise<string[]> {
	const env = options.env ?? process.env;
	// 闸门在最前：关着时连 spawn 都不该有（rollback = 逐字节回到今日形态）。
	if (personaInjectGatesClosed(env)) return [];
	// 前置过滤（0 成本，不 spawn）：有效汉字不足直接空。
	const hanzi = (text.match(/\p{Script=Han}/gu) ?? []).length;
	if (hanzi < LIGHT_MIN_HANZI) return [];

	const key = String(options.conversationId);
	const now = options.now ?? Date.now;
	const cached = lightLast.get(key);
	if (cached && now() - cached.at < LIGHT_THROTTLE_MS) return cached.lines;
	const pending = lightInflight.get(key);
	if (pending) return pending;

	const startedAt = now();
	const task = askPersona(text, { limit: LIGHT_ASK_LIMIT }, { env, spawnFn: options.spawnFn })
		.then((result) => {
			const lines = result.ok ? pickLightLines(result.groups ?? {}, text) : [];
			rememberLight(key, now(), lines);
			const groupCount = result.groups ? Object.keys(result.groups).length : 0;
			// 只记字数 / 状态 / 组数 / 条数 / 耗时，不记 query 原文与正文（硬约束）。
			console.log(
				`[persona-light] q=${text.length}字 ok=${result.ok} groups=${groupCount} lines=${lines.length} ${now() - startedAt}ms`,
			);
			return lines;
		})
		.catch(() => {
			// askPersona 理论上不抛，兜一层：检索失败也按 60s 记账，别每轮都去撞坏掉的 python。
			rememberLight(key, now(), []);
			return [] as string[];
		})
		.finally(() => {
			lightInflight.delete(key);
		});
	lightInflight.set(key, task);
	return task;
}

interface FlatHit {
	hit: PersonaHit;
	group: PersonaGroup;
	body: string;
}

/**
 * 组装轻召回行（方案 §2.2 步骤 4–7）：echo 抑制 → 相关性门槛 → 条目去重 → 限额 → 渲染。
 *
 * 相关性门槛只拦 why=「关键词命中」的条目（闲聊的 FTS 噪声全在这类里）；
 * 时间锁（日记忆命中）/ 类型命中 / 用户亲口确认等其它理由放行——那是"问到那个时段了"，
 * 不是关键词碰巧撞上。
 */
function pickLightLines(
	groups: Partial<Record<PersonaGroup, PersonaHit[]>>,
	query: string,
): string[] {
	const q = query.replace(/\s+/g, " ").trim();
	const qGrams = bigrams(q);
	const flat: FlatHit[] = [];
	for (const group of PERSONA_GROUP_ORDER) {
		for (const hit of groups[group] ?? []) {
			const body = (hit.text ?? hit.title ?? "").replace(/\s+/g, " ").trim();
			if (!body) continue;
			flat.push({ hit, group, body });
		}
	}

	const kept: string[] = [];
	let used = 0;
	for (const item of flat) {
		if (kept.length >= LIGHT_MAX_LINES) break;
		const grams = bigrams(item.body);
		// echo trap：用户在复述旧事而不是在问——与 query 近重复（Jaccard ≥0.8 或正文
		// 包含 query 全文）的条目整条抑制，相似分再高也不该注回去。
		if (item.body.includes(q) || jaccard(qGrams, grams) >= 0.8) continue;
		// 相关性门槛：正文必须与 query 有**内容词**命中（hasInformativeMatch，2026-11-22
		// P3 冒烟校准——双字虚词重叠不算相关，见 informativeBigrams 头注）。
		// 与 memory 召回的"直接相关"同源思想：关键词命中类放行的唯一标准是话题词真的碰上了。
		if ((item.hit.why ?? "").includes("关键词命中") && !hasInformativeMatch(item.body, q)) continue;
		// 条目去重：同一件事多种说法只留一条（与 recall 的 dedupeRecallHits 同阈值 0.8）。
		if (kept.some((prev) => jaccard(bigrams(prev), grams) >= 0.8)) continue;
		const line = renderHitLine(item.hit, item.group);
		if (!line) continue;
		// 总预算：放不下就停（预算按整条算，与 engine.buildContext 同款）。
		if (used + line.length > LIGHT_MAX_TOTAL_CHARS) break;
		kept.push(line);
		used += line.length;
	}
	return kept;
}

// ── 库目录常驻段（persona_catalog 注入，方案 §2.3）──────────

export const PERSONA_CATALOG_TITLE =
	"以下是主人一生记忆库的边界（可用 persona_recall 工具查询，查不到 ≠ 没有）：";

/** 目录段预算：system 段常驻，超长会把固定前缀撑肥；空月行先砍（对模型信息密度最低）。 */
const PERSONA_CATALOG_MAX_CHARS = 600;

/**
 * catalog 裁剪：join 后超预算先砍「空月」行（ask.py 的缺口统计行）；还超就硬截断带
 * 省略号——预算是硬的，目录是锦上添花段，宁可少几行也不能把前缀撑爆。
 */
export function personaCatalogTrim(
	lines: readonly string[],
	maxChars = PERSONA_CATALOG_MAX_CHARS,
): string {
	const join = (items: readonly string[]): string => items.join("\n");
	if (join(lines).length <= maxChars) return join(lines);
	const withoutGaps = lines.filter((line) => !line.startsWith("空月"));
	const text = join(withoutGaps);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 1)}…`;
}

/** 最近一次成功拉取并裁剪好的目录文本（provider 的同步取数口；null = 整段不注，零字节）。 */
let catalogInjectionCache: string | null = null;
/** 拉取失败后的冷却：ask.py 的 10 分钟缓存只缓存成功，失败每次 render 都会重 spawn——
 *  60s 内不再试，别让一个坏掉的库把每个模型请求都拖慢 0.8s。 */
const CATALOG_FAILURE_COOLDOWN_MS = 60_000;
let catalogFailedAt = 0;

/** 注入 provider 的同步取数口；没成功拉取过 = null。 */
export function personaCatalogCachedText(): string | null {
	return catalogInjectionCache;
}

/**
 * 拉一次目录并落裁剪缓存（persona_catalog section 的 render 调；成功结果 10 分钟内是
 * askPersonaCatalog 内部缓存直读）。总闸关 / 未配置 / 失败：不动缓存、不抛——
 * 失败时保留上一份成功文本（前缀抖动比旧 10 分钟更伤缓存），没有上一份 = 整段不注。
 */
export async function refreshPersonaCatalogInjection(
	deps: { env?: NodeJS.ProcessEnv; spawnFn?: typeof spawn } = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	if (personaInjectGatesClosed(env)) return;
	if (Date.now() - catalogFailedAt < CATALOG_FAILURE_COOLDOWN_MS) return;
	try {
		const result = await askPersonaCatalog(deps);
		if (!result.ok || result.lines.length === 0) {
			catalogFailedAt = Date.now();
			return;
		}
		catalogInjectionCache = personaCatalogTrim(result.lines);
		catalogFailedAt = 0;
	} catch {
		// 不抛：目录失败不该让 section render 挂掉（askPersonaCatalog 理论上也不抛）
		catalogFailedAt = Date.now();
	}
}

/** 测试用：清目录缓存与失败冷却（单测之间互不串味）。 */
export function resetPersonaCatalogForTests(): void {
	catalogInjectionCache = null;
	catalogFailedAt = 0;
}

/**
 * 目录定期刷新（2026-11-22 记忆外挂源批）：section 的 render 是同步契约，
 * catalog 又要 spawn python，取数只能异步预取进缓存，render 同步读。
 *
 * 启动先拉一次（harness open 后），此后每 10 分钟一次——与 askPersonaCatalog 的
 * 成功缓存窗口一致，多数 tick 是缓存直读，不会再起 python。定时器 unref：
 * 不挂进程退出；关停时 unref 之外还要 clearInterval（stopPersonaCatalogTimer）。
 */
const PERSONA_CATALOG_REFRESH_MS = 10 * 60_000;
let catalogTimer: ReturnType<typeof setInterval> | null = null;

export function startPersonaCatalogRefresh(): void {
	if (catalogTimer) return;
	void refreshPersonaCatalogInjection();
	catalogTimer = setInterval(() => void refreshPersonaCatalogInjection(), PERSONA_CATALOG_REFRESH_MS);
	catalogTimer.unref?.();
}

export function stopPersonaCatalogTimer(): void {
	if (catalogTimer) {
		clearInterval(catalogTimer);
		catalogTimer = null;
	}
}
