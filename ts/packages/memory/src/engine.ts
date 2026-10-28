import { BasicConsolidator, type ConsolidateResult, type Consolidator } from "./consolidate.ts";
import { HeuristicExtractor, type ExtractMessage, type Extractor } from "./extract.ts";
import { touchRecall, WeightedRetriever, type Retriever } from "./recall.ts";
import type { MemoryStore } from "./store.ts";
import {
	scopeKey,
	type InjectOptions,
	type MemoryRecord,
	type MemoryScope,
	type RecallHit,
	type RecallQuery,
	type RememberInput,
} from "./types.ts";

/**
 * 记忆引擎 = 四层的装配点。
 *
 * 它只做编排，不含策略：换掉任何一个零件，其余三层不受影响。
 *
 *        ┌─────────┐   会话边界
 * 对话 ──▶│ Extract │──────────┐
 *        └─────────┘            ▼
 *                        ┌─────────────┐    ┌───────┐
 *                        │ Consolidate │───▶│ Store │
 *                        └─────────────┘    └───────┘
 *                                               ▲
 *        ┌─────────┐   每轮开头                  │
 * prompt◀─│ Inject  │◀── Recall ◀───────────────┘
 *        └─────────┘
 */

export interface MemoryEngineOptions {
	store: MemoryStore;
	extractor?: Extractor;
	consolidator?: Consolidator;
	retriever?: Retriever;
	now?: () => Date;
}

export class MemoryEngine {
	private readonly store: MemoryStore;
	private readonly extractor: Extractor;
	private readonly consolidator: Consolidator;
	private readonly retriever: Retriever;
	private readonly now: () => Date;

	constructor(options: MemoryEngineOptions) {
		this.store = options.store;
		this.extractor = options.extractor ?? new HeuristicExtractor();
		this.consolidator = options.consolidator ?? new BasicConsolidator();
		this.retriever = options.retriever ?? new WeightedRetriever();
		this.now = options.now ?? (() => new Date());
	}

	/** 直接写入一条记忆（用户明确要求"记住"时走这里，不经过抽取） */
	remember(input: RememberInput): MemoryRecord {
		const at = this.now();
		const record: MemoryRecord = {
			id: crypto.randomUUID(),
			kind: input.kind,
			scope: scopeKey(input.scope),
			content: input.content,
			importance: input.importance ?? 0.7,
			// 人自己说的，可信度最高
			veracity: input.veracity ?? "stated",
			source: input.source ?? "user",
			createdAt: at.toISOString(),
			validUntil: input.validUntil ?? null,
			supersededBy: null,
			recallCount: 0,
			lastRecalledAt: null,
		};
		this.store.put(record);
		return record;
	}

	/** 会话边界调用：抽取 + 巩固 */
	async ingestTurn(messages: ExtractMessage[], scope: MemoryScope): Promise<ConsolidateResult> {
		const at = this.now();
		const candidates = await this.extractor.extract({ messages, scope, now: at });
		return this.consolidator.consolidate(candidates, this.store, at);
	}

	/** 每轮开头调用；命中即回写强化信息 */
	recall(query: RecallQuery): RecallHit[] {
		const at = this.now();
		const hits = this.retriever.recall(query, this.store, at);
		for (const hit of hits) {
			touchRecall(this.store, hit.record, at);
		}
		return hits;
	}

	/**
	 * 注入层：把召回的片段拼成可以直接塞进 systemPrompt 的一段话。
	 * 没有记忆时返回空串 —— 调用方不需要判断"有没有"。
	 */
	buildContext(query: RecallQuery, options: InjectOptions = {}): string {
		const maxChars = options.maxChars ?? 1200;
		const hits = this.recall(query);
		if (hits.length === 0) return "";

		const lines: string[] = [];
		let used = 0;
		for (const hit of hits) {
			const line = `- [${hit.record.kind}] ${hit.record.content}`;
			if (used + line.length > maxChars) break;
			lines.push(line);
			used += line.length;
		}
		if (lines.length === 0) return "";

		return [
			"以下是你记得的关于这个人的信息（按相关度排序）。自然使用，不要逐条复述，也不要提及「记忆」这个词：",
			...lines,
		].join("\n");
	}

	stats(): { total: number; byScope: Record<string, number> } {
		const all = this.store.search({ includeSuperseded: true, limit: 100_000 });
		const byScope: Record<string, number> = {};
		for (const record of all) {
			byScope[record.scope] = (byScope[record.scope] ?? 0) + 1;
		}
		return { total: all.length, byScope };
	}

	close(): void {
		this.store.close();
	}
}
