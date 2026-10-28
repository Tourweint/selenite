import type { MemoryCandidate, MemoryRecord } from "./types.ts";
import type { MemoryStore } from "./store.ts";

/**
 * 巩固层：决定新候选怎么和已有记忆相处。
 *
 * 这是记忆系统真正的分水岭。没有这一层，库只会越写越大，
 * 最后召回出来的全是重复和过时信息。
 *
 * 当前只做两条最保守的规则（框架优先，策略留空）：
 *   1. 同 scope 下内容完全相同的 → 不新增，只提升 importance（重复 = 更重要）
 *   2. 其余 → 直接入库
 *
 * TODO(细节): 这里未来要长出真正的巩固逻辑——
 *   - 语义去重（不是字符串相等，是意思相同）
 *   - 冲突消解（"我住北京" vs "我搬到上海了" → 旧记录 supersededBy）
 *   - 遗忘曲线（久未被召回且 importance 低的降级/归档）
 *   - 时间衰减（参考 mnemopi 的 weibull.ts）
 */

export interface ConsolidateResult {
	added: MemoryRecord[];
	reinforced: MemoryRecord[];
	skipped: MemoryCandidate[];
}

export interface Consolidator {
	consolidate(
		candidates: MemoryCandidate[],
		store: MemoryStore,
		now?: Date,
	): ConsolidateResult;
}

export class BasicConsolidator implements Consolidator {
	consolidate(
		candidates: MemoryCandidate[],
		store: MemoryStore,
		now: Date = new Date(),
	): ConsolidateResult {
		const added: MemoryRecord[] = [];
		const reinforced: MemoryRecord[] = [];
		const skipped: MemoryCandidate[] = [];

		for (const candidate of candidates) {
			const existing = store
				.search({ scopes: [candidate.scope], limit: 200 })
				.find((record) => record.content === candidate.content);

			if (existing) {
				// 同类内容再次出现：说明这不是一次性事件，重要性上浮。
				const bumped = Math.min(1, existing.importance + 0.1);
				store.patch(existing.id, { importance: bumped });
				reinforced.push({ ...existing, importance: bumped });
				continue;
			}

			if (!candidate.content.trim()) {
				skipped.push(candidate);
				continue;
			}

			const record: MemoryRecord = {
				id: crypto.randomUUID(),
				kind: candidate.kind,
				scope: candidate.scope,
				content: candidate.content,
				importance: candidate.importance,
				veracity: candidate.veracity,
				source: candidate.source,
				createdAt: now.toISOString(),
				validUntil: candidate.validUntil ?? null,
				supersededBy: null,
				recallCount: 0,
				lastRecalledAt: null,
			};

			store.put(record);
			added.push(record);
		}

		return { added, reinforced, skipped };
	}
}
