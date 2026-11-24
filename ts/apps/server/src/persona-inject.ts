import type { spawn } from "node:child_process";
import { flagEnabled } from "./flags.ts";
import {
	askPersona,
	PERSONA_GROUP_ORDER,
	PERSONA_LIGHT_TIMEOUT_MS,
	type PersonaGroup,
	type PersonaHit,
} from "./persona-ask.ts";
// 读闸的唯一判据（2026-11-24）。循环 import：memory-bank 也 import 本模块的
// clearPersonaLightRecall / personaCatalogTrim / personaInjectGatesClosed；两边都只在
// 函数体内引用（函数声明提升），模块初始化期不取值，ESM 循环安全。
import { bankReadable } from "./memory-bank.ts";

/**
 * 一生记忆库外挂注入（2026-11-22 记忆外挂源批，方案 §2.2 / §2.3）。
 *
 * 背景：大库（persona-metric）此前只有按需工具——赌模型每轮"记得去查"，
 * 忘一次大库就等于不存在。本模块把大库接进每轮自动召回，但**大库条目不进小库打分池**
 * （两库条目不同构，分层配额比统一打分干净）：
 *   - 轻召回 `personaLightRecall`：每轮消息尾部 ≤3 条 / 800 字，独立于 memory 召回的
 *     16 条 / 2000 字预算，分组标题由接线处（lifecycle-injections）拼；
 *   - 库目录 `personaCatalogTrim`：给 memory-bank 的目录缓存做 ≤600 字裁剪。
 *
 * 只读契约（D-甲 / D-丙）不破：唯一入口仍是 ask.py 子进程（经 persona-ask.ts 的
 * askPersona），本模块绝不直接碰 persona.db。
 *
 * 2026-11-24 旧形态退役：轻召回只在**外接库槽位**跑（env 路径已删）；工具面恒为
 * recall / remember，闸门由 memory-bank 的 `bankReadable()` 统一判。
 *
 * 放 server 不放 memory 包：spawn python 是 server 的装配事，依赖方向单向
 * `shared ← memory ← server`，memory 包不 import persona-ask。
 *
 * 日志纪律：只记字数 / ok / 组数 / 条数 / 耗时，不记 query 原文与条目正文（硬约束）。
 */

/**
 * 总闸 + 读闸一起判（2026-11-22 记忆外挂源批；2026-11-24 改读槽位）：
 * 任一不过，轻召回整段消失。判据 = `PERSONA_MEMORY_INJECT` × `PERSONA_MEMORY_ENABLED`
 * × 当前槽位 external × 读入口存在（后三者由 memory-bank 的 `bankReadable()` 统一判）。
 */
export function personaInjectGatesClosed(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!flagEnabled("PERSONA_MEMORY_INJECT", env)) return true;
	return !bankReadable(env);
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
/** 槽位切换代次（2026-11-23）：清账本后，旧库的在飞结果不许再写回缓存。 */
let lightGeneration = 0;

function rememberLight(key: string, at: number, lines: string[]): void {
	lightLast.set(key, { at, lines });
	while (lightLast.size > LIGHT_LAST_MAX) {
		const oldest = lightLast.keys().next().value;
		if (oldest === undefined) break;
		lightLast.delete(oldest);
	}
}

/** 清空轻召回节流账本（2026-11-23 记忆库槽位切换后调：别拿上一个库的行缓存 60 秒）。 */
export function clearPersonaLightRecall(): void {
	lightGeneration += 1;
	lightLast.clear();
	lightInflight.clear();
}

/** 测试用：清空轻召回节流账本（单测之间互不串味）。 */
export function resetPersonaLightRecallForTests(): void {
	clearPersonaLightRecall();
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
function renderHitLine(hit: PersonaHit, group: string): string | null {
	const body = (hit.text ?? hit.title ?? "").replace(/\s+/g, " ").trim();
	if (!body) return null;
	const suffix =
		group === "fact" && (hit.why ?? "").includes("用户亲口确认")
			? "用户亲口确认"
			: hit.source
				? group
					? `${group} · ${hit.source}`
					: hit.source
				: group || "记忆";
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
	/**
	 * 外接库模式（2026-11-23）：组名不固定，按扁平 hits 处理；
	 * 内置 persona 路径不传，保持六组口径。
	 */
	anyGroups?: boolean;
	/** 多语言入口的启动命令（外接库槽位传；内置 env 路径不传）。 */
	command?: string[];
	cwd?: string;
	/**
	 * 轻召回自己的超时预算（2026-11-24 两档超时）：缺省 = `PERSONA_LIGHT_TIMEOUT_MS`（8s）。
	 * 外接库槽位由 memory-bank 的 `timeouts.lightMs` 注入；**永远不传 vector**（轻召回不走向量检索）。
	 */
	timeoutMs?: number;
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
	const generation = lightGeneration;
	const task = askPersona(
		text,
		{ limit: LIGHT_ASK_LIMIT, anyGroups: options.anyGroups === true },
		{
			env,
			...(options.command ? { command: options.command } : {}),
			...(options.cwd ? { cwd: options.cwd } : {}),
			// 两档超时（2026-11-24）：轻召回默认 8s；外接库槽位由调用方传配置里的 lightMs。
			// 这里刻意不传 vector——每轮注入不走向量检索。
			timeoutMs: options.timeoutMs ?? PERSONA_LIGHT_TIMEOUT_MS,
			spawnFn: options.spawnFn,
		},
	)
		.then((result) => {
			const lines = result.ok
				? result.hits
					? pickLightLinesFromHits(result.hits, text)
					: pickLightLines(result.groups ?? {}, text)
				: [];
			// 库已经换了（clearPersonaLightRecall 加了一代）：旧结果不许写回新库的账本。
			if (generation === lightGeneration) rememberLight(key, now(), lines);
			const itemCount = result.hits
				? result.hits.length
				: result.groups
					? Object.keys(result.groups).length
					: 0;
			// 只记字数 / 状态 / 条数 / 耗时，不记 query 原文与正文（硬约束）。
			console.log(
				`[persona-light] q=${text.length}字 ok=${result.ok} items=${itemCount} lines=${lines.length} ${now() - startedAt}ms`,
			);
			return lines;
		})
		.catch(() => {
			// askPersona 理论上不抛，兜一层：检索失败也按 60s 记账，别每轮都去撞坏掉的 python。
			if (generation === lightGeneration) rememberLight(key, now(), []);
			return [] as string[];
		})
		.finally(() => {
			if (lightInflight.get(key) === task) lightInflight.delete(key);
		});
	lightInflight.set(key, task);
	return task;
}

interface FlatHit {
	hit: PersonaHit;
	/** 六组模式是 PersonaGroup；外接库模式是原始组名（可能为空）。 */
	group: string;
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
	const flat: FlatHit[] = [];
	for (const group of PERSONA_GROUP_ORDER) {
		for (const hit of groups[group] ?? []) {
			const body = (hit.text ?? hit.title ?? "").replace(/\s+/g, " ").trim();
			if (!body) continue;
			flat.push({ hit, group, body });
		}
	}
	return pickLightLinesFromFlat(flat, query);
}

/** 外接库的扁平命中（2026-11-23）：组名不固定，直接用 `hit.group` 做行尾标注。 */
function pickLightLinesFromHits(hits: PersonaHit[], query: string): string[] {
	const flat: FlatHit[] = [];
	for (const hit of hits) {
		const body = (hit.text ?? hit.title ?? "").replace(/\s+/g, " ").trim();
		if (!body) continue;
		flat.push({ hit, group: hit.group ?? "", body });
	}
	return pickLightLinesFromFlat(flat, query);
}

function pickLightLinesFromFlat(flat: FlatHit[], query: string): string[] {
	const q = query.replace(/\s+/g, " ").trim();
	const qGrams = bigrams(q);
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

// ── 库目录裁剪（persona_catalog 注入，方案 §2.3）──────────

/** 外接库槽位的目录标题（2026-11-23；2026-11-24 后是唯一目录来源）：工具名是 `recall`。 */
export const EXTERNAL_BANK_CATALOG_TITLE =
	"以下是当前外部记忆库的边界（可用 recall 工具查询，查不到 ≠ 没有）：";

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
