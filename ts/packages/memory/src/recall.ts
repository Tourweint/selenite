import { decayedImportance, RECALL_BOOST, reinforcedImportance } from "./decay.ts";
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

		// text 只是候选集来源提示（2026-11-04 批次三）：store 自己决定用不用，
		// 短查询 / 没有 FTS 时它会忽略 text 走原窗口 SQL。
		const baseSearch = {
			scopes: query.scopes,
			since: query.since,
			limit: windowLimit,
		};
		// 候选集 = 文本命中 ∪ 最近窗口（2026-11-04 验收修订）：FTS 捞回相关的老条目，
		// 窗口保住"最近的上下文"，两者都要——只用文本命中时，命中 1 条候选池就从 200 缩到 1。
		const byId = new Map<string, MemoryRecord>();
		if (text) {
			for (const record of store.search({ ...baseSearch, text })) byId.set(record.id, record);
		}
		for (const record of store.search(baseSearch)) byId.set(record.id, record);
		const candidates = [...byId.values()];

		const keywords = extractKeywords(query.text);
		const hits: RecallHit[] = [];

		for (const record of candidates) {
			if (record.validUntil && record.validUntil < now.toISOString()) continue;

			const recency = recencyScore(record.createdAt, now);
			const keyword = keywordScore(record.content, keywords);
			const timesRecalled = Math.min(1, record.recallCount / 10);
			// 衰减后的重要性参与打分（2026-11-08）：久未想起的旧事自然排后。
			// 打分按 0..1 归一一档——重要性可以涨过 1（使用强化），但那一维最多记满分。
			const importance = Math.min(
				1,
				decayedImportance(
					record.importance,
					record.lastRecalledAt ?? record.createdAt,
					now,
					this.decayDaily,
				),
			);

			// 权重是拍的，改了也不算错 —— 但要有理由地改，别随手调。
			const score =
				importance * 0.45 + recency * 0.3 + keyword * 0.2 + timesRecalled * 0.05;

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
	});
}
