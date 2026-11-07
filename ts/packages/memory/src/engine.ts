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
	/** 召回候选窗口下限（2026-11-04 批次一 A2-S）；不传 = WeightedRetriever 的默认 200。 */
	candidateFloor?: number;
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
		this.retriever =
			options.retriever ?? new WeightedRetriever({ candidateFloor: options.candidateFloor });
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

	/**
	 * 会话边界调用：抽取 + 巩固。
	 *
	 * `preferenceScope`（2026-11-06）：偏好**不留在会话作用域**——"我不喜欢被追问"
	 * 换个会话就失效，等于没记住。凡是 `kind === "preference"` 的候选，写入前统一改挂到
	 * 这个更宽的 scope（主人在 `global`，执事在 `partner:<id>`）。
	 *
	 * 这个"重挂"刻意在 `Extractor` 之外做：抽取器只回答"这是不是偏好"，
	 * "偏好该存哪"是装配层的知识（谁在跟谁说话）。接口不变。
	 */
	async ingestTurn(
		messages: ExtractMessage[],
		scope: MemoryScope,
		options: { preferenceScope?: MemoryScope } = {},
	): Promise<ConsolidateResult> {
		const at = this.now();
		const candidates = await this.extractor.extract({ messages, scope, now: at });
		const preferenceScope = options.preferenceScope;
		if (preferenceScope) {
			const key = scopeKey(preferenceScope);
			for (const candidate of candidates) {
				if (candidate.kind === "preference") candidate.scope = key;
			}
		}
		return this.consolidator.consolidate(candidates, this.store, at);
	}

	/**
	 * 显式取代一条记忆（2026-11-06）。
	 *
	 * 为什么不自动做语义冲突消解：判断"我住北京" vs "我搬到上海了"需要语义理解，
	 * 交给 LLM 会误杀、交给规则必然误杀。`supersededBy` 字段本来就是给显式取代留的：
	 * 人（设置页）或模型（`remember` 时明确说"这条过时了"）来点一下。
	 *
	 * 不删旧记录：`superseded_by IS NULL` 只影响召回候选，历史链仍然可查
	 * （传 byId = null 表示"仅下线，没有替代者"）。
	 */
	supersede(id: string, byId: string | null = null): MemoryRecord | null {
		const record = this.store.get(id);
		if (!record) return null;
		if (byId) {
			// 替代者必须存在：指向一个不存在的 id 会让这条记忆永久消失且无从解释
			if (!this.store.get(byId)) return null;
			if (byId === id) return null;
		}
		this.store.patch(id, { supersededBy: byId ?? id });
		return { ...record, supersededBy: byId ?? id };
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
	 * 把召回的片段拼成可以直接塞进 systemPrompt 的一段话。
	 * 没有记忆时返回空串 —— 调用方不需要判断"有没有"。
	 *
	 * 2026-11-06 起**偏好单独成段、排在最前**：偏好是稳定且高价值的东西，
	 * 不该跟"今天面试挂了"抢同一段预算的排序。注意这只是**渲染分组**：
	 * 召回算法、候选集、打分权重都没变，同一批 hits 按 kind 稳定分组而已
	 * （所以 `RecallQuery` / `Retriever` 契约不动）。
	 */
	buildContext(query: RecallQuery, options: InjectOptions = {}): string {
		const maxChars = options.maxChars ?? 1200;
		const hits = this.recall(query);
		if (hits.length === 0) return "";

		const preferences = hits.filter((hit) => hit.record.kind === "preference");
		const others = hits.filter((hit) => hit.record.kind !== "preference");

		const lines: string[] = [];
		let used = 0;
		const push = (line: string): boolean => {
			if (used + line.length > maxChars) return false;
			lines.push(line);
			used += line.length;
			return true;
		};
		// 偏好里可能带 Why/How 两行：注入时压成一行（预算按整条算，别让换行白占额度）
		const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ").trim();

		if (preferences.length > 0) {
			push("【用户偏好】");
			for (const hit of preferences) {
				if (!push(`- ${flat(hit.record.content)}`)) break;
			}
		}
		if (others.length > 0) {
			// 只有偏好时不要空标题；只有其它时保持 2026-11-06 之前的形状（逐字节兼容）
			if (preferences.length > 0) push("【其它】");
			for (const hit of others) {
				if (!push(`- [${hit.record.kind}] ${flat(hit.record.content)}`)) break;
			}
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

	/**
	 * 会话/伙伴作用域封顶修剪（2026-11-07）。
	 *
	 * 只认 `session:` / `partner:` 前缀的 scope：`global` 永不自动删（store 层也会拒），
	 * 事实/经历按最旧优先淘汰，偏好与被 `supersededBy` 引用的行一律保留。
	 * `cap <= 0`（含 `MEMORY_SESSION_CAP=0`）直接不动——一行回滚。
	 * 返回删除总条数，供调用方只记条数、不记正文（D8）。
	 */
	pruneSessionScopes(cap: number): number {
		if (!Number.isFinite(cap) || cap <= 0) return 0;
		let pruned = 0;
		for (const scope of this.store.listScopes()) {
			if (!scope.startsWith("session:") && !scope.startsWith("partner:")) continue;
			pruned += this.store.pruneOldest(scope, cap, {
				protectKinds: ["preference"],
				protectReferenced: true,
			});
		}
		return pruned;
	}

	/** 删一条（2026-11-06，设置页）。返回是否真的删掉了。 */
	forget(id: string): boolean {
		return this.store.remove(id);
	}

	/**
	 * 按 scope 列记忆（设置页列表 / 排查用）。
	 *
	 * 默认**不返回已被取代的记录**：页面上列出来的是"现在还算数的记忆"。
	 * 排序按 kind 分组、组内按时间倒序——偏好排最前，和注入的优先级一致。
	 * 不在这里做关键词搜索：千级规模先给滚动，真需要再加（同设置页不做全局搜索的口径）。
	 */
	list(options: { scopes?: string[]; limit?: number; includeSuperseded?: boolean } = {}): MemoryRecord[] {
		const rows = this.store.search({
			...(options.scopes?.length ? { scopes: options.scopes } : {}),
			includeSuperseded: options.includeSuperseded ?? false,
			limit: Math.max(1, Math.min(2000, options.limit ?? 500)),
		});
		const order: Record<string, number> = { preference: 0, fact: 1, entity: 2, episode: 3 };
		return [...rows].sort((a, b) => {
			const rank = (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
			return rank !== 0 ? rank : a.createdAt < b.createdAt ? 1 : -1;
		});
	}

	close(): void {
		this.store.close();
	}
}
