import { decayedImportance, RECALL_BOOST, reinforcedImportance } from "./decay.ts";
import { normalizeContent } from "./consolidate.ts";
import type { MemoryRecord, RecallHit, RecallQuery } from "./types.ts";
import type { MemoryStore } from "./store.ts";

/**
 * 召回层：给定"这次要聊什么"，挑出该被记起来的东西。
 *
 * 打分当前是三路的加权和（重要性 / 新近度 / 关键词），刻意保持可解释——
 * 以后加向量、加图召回，只要把新路数并进 score 即可，接口不变。
 *
 * TODO(细节):
 *   - 语义召回（embedding；FTS5 trigram 已用于候选集，2026-11-04 批次三）
 *   - MMR 去冗余（mnemopi 有实现，召回 10 条里有 8 条说同一件事很浪费预算）
 *   - 时间感知（"上周说的"这类相对时间）
 */

export interface Retriever {
	recall(query: RecallQuery, store: MemoryStore, now?: Date): RecallHit[];
}

const DAY_MS = 86_400_000;

/** 记忆的"保鲜期"：超过这个天数，新近度几乎归零 */
const RECENCY_HALFLIFE_DAYS = 21;

/**
 * 候选窗口下限的默认值（2026-11-04 批次一 A2-S）。
 *
 * 200 是 **global + 当前会话合并后**的总窗口：近期会话记忆多时，
 * 老 global 记忆仍可能被挤出窗口（真修复是文本检索入口，批次三）。
 */
const DEFAULT_CANDIDATE_FLOOR = 200;

export interface WeightedRetrieverOptions {
	/** 候选窗口下限；50 = A2-S 之前的旧行为。 */
	candidateFloor?: number;
	/**
	 * 日衰减系数（2026-11-08 扫尾批 6）：打分时把 importance 按距锚点的天数衰减。
	 * 不传 / `0` = 不衰减（旧行为）。锚点 = `lastRecallAt ?? createdAt`。
	 */
	decayDaily?: number;
}

export class WeightedRetriever implements Retriever {
	private readonly candidateFloor: number;
	private readonly decayDaily: number;

	constructor(options: WeightedRetrieverOptions = {}) {
		this.candidateFloor = options.candidateFloor ?? DEFAULT_CANDIDATE_FLOOR;
		this.decayDaily = options.decayDaily ?? 0;
	}

	recall(query: RecallQuery, store: MemoryStore, now: Date = new Date()): RecallHit[] {
		const limit = query.limit ?? 8;
		// 多取一些再排序，避免 SQL 的 LIMIT 提前把高分项切掉
		const windowLimit = Math.max(limit * 5, this.candidateFloor);
		const text = query.text?.trim() ? query.text : undefined;

		// gated scopes（2026-11-15 项目记忆多挂载）：只从「字面命中」路径进候选、
		// 不吃最近窗口——"聊到才浮出"由这层保证，不是打分巧合。重复 key 以更严的 gated 为准。
		const gatedKeys = new Set(query.gatedScopes ?? []);
		const windowScopes = query.scopes.filter((scope) => !gatedKeys.has(scope));
		const allScopes = [...windowScopes, ...gatedKeys];

		// text 只是候选集来源提示（2026-11-04 批次三）：store 自己决定用不用，
		// 短查询 / 没有 FTS 时它会忽略 text 走原窗口 SQL。
		const baseSearch = {
			scopes: windowScopes,
			since: query.since,
			limit: windowLimit,
		};
		// 候选集 = 文本命中 ∪ 最近窗口（2026-11-04 验收修订）：FTS 捞回相关的老条目，
		// 窗口保住"最近的上下文"，两者都要——只用文本命中时，命中 1 条候选池就从 200 缩到 1。
		// 文本命中覆盖 gated scopes：能被文本捞回的本来就是"聊到了"。
		const byId = new Map<string, MemoryRecord>();
		if (text) {
			for (const record of store.search({ ...baseSearch, scopes: allScopes, text }))
				byId.set(record.id, record);
		}
		for (const record of store.search(baseSearch)) byId.set(record.id, record);
		// work 是 append-only 履历台账（2026-11-08 刀二 E2）：**召回默认排除**，不污染日常记忆。
		// 装配与盘点走 store.search({ kinds:["work"] }) 的结构化查询，不走语义召回。
		// impression（2026-11-15 批2）同理：印象块由执事轮装配按 subject 结构化读取，
		// 混进语义召回会让同一条印象既在【印象】块又在本轮召回里出现两遍。
		// 排除在候选集这一层做，两者因此也不进 hits、不触发 touchRecall 的衰减 / 强化写回。
		// gated 来源的候选再过一道字面相关过滤：FTS 不可用时 store 会静默回落窗口
		// SQL（text 变提示），gated 记录可能经那条路进来——这里兜住，闸门不留缝。
		const candidates = [...byId.values()].filter((record) => {
			if (record.kind === "work" || record.kind === "impression") return false;
			if (gatedKeys.has(record.scope) && !directlyRelevant(record.content, query.text))
				return false;
			return true;
		});

		const keywords = extractKeywords(query.text);
		const hits: RecallHit[] = [];

		for (const record of candidates) {
			if (record.validUntil && record.validUntil < now.toISOString()) continue;

			const recency = recencyScore(record.createdAt, now);
			const keyword = keywordScore(record.content, keywords);
			const timesRecalled = Math.min(1, record.recallCount / 10);
			// 衰减后的重要性参与打分（2026-11-08）：久未想起的旧事自然排后。
			// 打分按 0..1 归一一档——重要性可以涨过 1（使用强化），但那一维最多记满分。
			// intention 不参与时间衰减（2026-11-09 T4 §3）：它有自己的 expiresAt，
			// 未到期前不该因为"放了两周"被打低；到期由引擎降级为 fact。
			// experience 同理（2026-11-10 批 17 §一）：经验不该过期。
			const importance = Math.min(
				1,
				record.kind === "intention" || record.kind === "experience"
					? record.importance
					: decayedImportance(
							record.importance,
							record.lastRecalledAt ?? record.createdAt,
							now,
							this.decayDaily,
						),
			);

			// 权重是拍的，改了也不算错 —— 但要有理由地改，别随手调。
			// experience 与 fact 同组、权重略高（×1.08，2026-11-10 批 17 §一.3）：
			// 可复用的做法比一次性事实更值得先被想起。
			const kindBoost = record.kind === "experience" ? 1.08 : 1;
			const score =
				(importance * 0.45 + recency * 0.3 + keyword * 0.2 + timesRecalled * 0.05) *
				kindBoost;

			hits.push({ record, score });
		}

		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}
}

function recencyScore(createdAt: string, now: Date): number {
	const created = Date.parse(createdAt);
	if (Number.isNaN(created)) return 0;
	const ageDays = Math.max(0, (now.getTime() - created) / DAY_MS);
	return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALFLIFE_DAYS);
}

/** 中文没有空格分词，这里退化为"双字片段"匹配，够用且不引入分词库 */
function extractKeywords(text: string): string[] {
	const cleaned = text.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, " ").trim();
	if (!cleaned) return [];

	const words = new Set<string>();
	for (const chunk of cleaned.split(/\s+/)) {
		if (!chunk) continue;
		if (/\p{Script=Han}/u.test(chunk)) {
			for (let i = 0; i < chunk.length - 1; i++) words.add(chunk.slice(i, i + 2));
		} else if (chunk.length >= 3) {
			words.add(chunk.toLowerCase());
		}
	}
	return [...words].slice(0, 40);
}

function keywordScore(content: string, keywords: string[]): number {
	if (keywords.length === 0) return 0;
	const lower = content.toLowerCase();
	let matched = 0;
	for (const keyword of keywords) {
		if (lower.includes(keyword)) matched++;
	}
	return Math.min(1, matched / Math.max(3, keywords.length * 0.2));
}

/**
 * 这条记忆是否与当前话题**直接相关**（有任何一个双字片段命中）。
 *
 * 给注入层的「也许值得提起」分组用（2026-11-10 批 17 §二）：
 * 直接相关的进常规分组，不相关的旧记忆才进主动提起组。复用召回的打分口径，
 * 不另造一套"相关"定义。
 */
export function directlyRelevant(content: string, query: string): boolean {
	const keywords = extractKeywords(query);
	return keywords.length > 0 && keywordScore(content, keywords) > 0;
}

// ── 召回后去重（2026-11-15 上下文预算批）────────────────────
//
// 问题：同一件事被记过多次（"部署要跑探针" / "atlas 部署先跑探针" / "部署前记得探针"），
// 召回时按分数各占一个名额，注入出来像复读，还挤掉真正新的信息。
// 巩固层只在**入库时**合并"规范化后完全一样"的，措施辞不同的管不了；
// 这一层在**每轮召回之后**做一次轻量去重，只影响这一轮注入，不动库。
//
// 判重是纯规则的（不调模型、不能 async）：规范化全等 → 包含关系 → 二元组 Jaccard。
// 阈值取 0.8（2026-11-15 实测：中文只把"确认"改成"验证"两个字，Jaccard 就从 1 掉到 0.83，
// 0.85 会把同一件事判成两件）——仍偏保守：两条不同事实的长文本 Jaccard 通常远低于 0.5。
// 宁可漏掉一对近似重复，也不要把"两条相关但不同的事实"合并掉——合并错了，
// 模型这一轮就少知道一件事，而且不会有人发现。

/** 短于这个长度的正文不做"包含关系 / Jaccard"判重：太短则误杀率高。 */
const DEDUPE_MIN_CONTENT_CHARS = 12;

/** 长度比超过这个倍数的不可能是近似重复（Jaccard 上限被长度差压死），省一次集合运算。 */
const DEDUPE_MAX_LENGTH_RATIO = 2.5;

export interface DedupeOptions {
	/** Jaccard 阈值（0..1），默认 0.8。调低 = 更激进。 */
	similarity?: number;
}

/** 文本的字符二元组集合（中文按字符天然适用，英文按字符也可用）。 */
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
 * 两条记忆算不算"同一件事"（**同 kind 才算**：fact 与 experience 撞正文时
 * 一条是结论、一条是做法，都要留）。
 */
function sameish(left: MemoryRecord, right: MemoryRecord, threshold: number): boolean {
	if (left.kind !== right.kind) return false;
	const a = normalizeContent(left.content);
	const b = normalizeContent(right.content);
	if (!a || !b) return false;
	if (a === b) return true;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	if (shorter.length < DEDUPE_MIN_CONTENT_CHARS) return false;
	// 一条整段被另一条包含：短的是长的摘要（导入的长条目常见）
	if (longer.includes(shorter)) return true;
	if (longer.length / shorter.length > DEDUPE_MAX_LENGTH_RATIO) return false;
	return jaccard(bigrams(a), bigrams(b)) >= threshold;
}

/**
 * 召回结果去重：保留分数更高的那条（`hits` 已按 score 降序）。
 *
 * 只影响本轮注入的那一批，**不改库、不删记录**。注意一个已知副作用：
 * `recall()` 在返回前已经对每条命中做过 touchRecall（+1 次召回、重要性 +0.05），
 * 被这里去掉的那条也算"被想起过"——轻微的强化失真，换来的是不动召回主链路
 * （去重要发生在候选集阶段的话得改 WeightedRetriever 的候选预算，代价大得多）。
 */
export function dedupeRecallHits(hits: RecallHit[], options: DedupeOptions = {}): RecallHit[] {
	const threshold = Number.isFinite(options.similarity)
		? Math.min(1, Math.max(0, options.similarity as number))
		: 0.8;
	const kept: RecallHit[] = [];
	for (const hit of hits) {
		if (kept.some((existing) => sameish(existing.record, hit.record, threshold))) continue;
		kept.push(hit);
	}
	return kept;
}

export interface TouchOptions {
	/** 日衰减系数；`0` / 不传 = 不衰减。 */
	decayDaily?: number;
	/** 每次命中加多少重要性；`0` = 只记召回次数（2026-11-08 之前的旧行为）。 */
	reinforce?: number;
}

/**
 * 召回命中后的写回（2026-11-08 扫尾批 6 扩展）。
 *
 * 三件事一次做完，顺序不能换：
 *   1. 先把 importance 衰减到**此刻**（从 `lastRecallAt ?? createdAt` 起算）；
 *   2. 再按命中加一次强化（默认 +0.05，封顶 10）；
 *   3. 最后把 `lastRecalledAt` 推到 now —— 锚点跟着值一起走，下一次衰减从新锚点起算，
 *      不会把已经衰减过的值重复乘。
 */
export function touchRecall(
	store: MemoryStore,
	record: MemoryRecord,
	now: Date,
	options: TouchOptions = {},
): void {
	const decayed = decayedImportance(
		record.importance,
		record.lastRecalledAt ?? record.createdAt,
		now,
		options.decayDaily ?? 0,
	);
	const importance = reinforcedImportance(decayed, options.reinforce ?? RECALL_BOOST);
	store.patch(record.id, {
		recallCount: record.recallCount + 1,
		lastRecalledAt: now.toISOString(),
		importance,
		// 使用账（2026-11-10 批 17 §三）：只服务巩固排序，与 recallCount 同点 +1。
		usageCount: (record.usageCount ?? 0) + 1,
		lastUsedAt: now.toISOString(),
	});
}
