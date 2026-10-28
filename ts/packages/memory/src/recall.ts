import type { MemoryRecord, RecallHit, RecallQuery } from "./types.ts";
import type { MemoryStore } from "./store.ts";

/**
 * 召回层：给定"这次要聊什么"，挑出该被记起来的东西。
 *
 * 打分当前是三路的加权和（重要性 / 新近度 / 关键词），刻意保持可解释——
 * 以后加向量、加图召回，只要把新路数并进 score 即可，接口不变。
 *
 * TODO(细节):
 *   - 语义召回（embedding 或 FTS5；当前是子串匹配）
 *   - MMR 去冗余（mnemopi 有实现，召回 10 条里有 8 条说同一件事很浪费预算）
 *   - 时间感知（"上周说的"这类相对时间）
 */

export interface Retriever {
	recall(query: RecallQuery, store: MemoryStore, now?: Date): RecallHit[];
}

const DAY_MS = 86_400_000;

/** 记忆的"保鲜期"：超过这个天数，新近度几乎归零 */
const RECENCY_HALFLIFE_DAYS = 21;

export class WeightedRetriever implements Retriever {
	recall(query: RecallQuery, store: MemoryStore, now: Date = new Date()): RecallHit[] {
		const limit = query.limit ?? 8;
		const candidates = store.search({
			scopes: query.scopes,
			since: query.since,
			// 多取一些再排序，避免 SQL 的 LIMIT 提前把高分项切掉
			limit: Math.max(limit * 5, 50),
		});

		const keywords = extractKeywords(query.text);
		const hits: RecallHit[] = [];

		for (const record of candidates) {
			if (record.validUntil && record.validUntil < now.toISOString()) continue;

			const recency = recencyScore(record.createdAt, now);
			const keyword = keywordScore(record.content, keywords);
			const timesRecalled = Math.min(1, record.recallCount / 10);

			// 权重是拍的，改了也不算错 —— 但要有理由地改，别随手调。
			const score =
				record.importance * 0.45 + recency * 0.3 + keyword * 0.2 + timesRecalled * 0.05;

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

export function touchRecall(store: MemoryStore, record: MemoryRecord, now: Date): void {
	store.patch(record.id, {
		recallCount: record.recallCount + 1,
		lastRecalledAt: now.toISOString(),
	});
}
