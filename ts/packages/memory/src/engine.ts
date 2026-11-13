import {
	BasicConsolidator,
	consolidateScope,
	importMemories,
	type ConsolidateDiff,
	type ConsolidateResult,
	type Consolidator,
	type ImportEntry,
	type ImportOutcome,
} from "./consolidate.ts";
import { RECALL_BOOST } from "./decay.ts";
import { HeuristicExtractor, type ExtractMessage, type Extractor } from "./extract.ts";
import { directlyRelevant, touchRecall, WeightedRetriever, type Retriever } from "./recall.ts";
import type { MemoryStore } from "./store.ts";
import {
	scopeKey,
	type InjectOptions,
	type MemoryKind,
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
	/**
	 * 日衰减系数（2026-11-08 扫尾批 6）：不传 / `0` = 不衰减（旧行为）。
	 * 打分用它算"这一刻的 importance"，召回命中时也用它把值衰减到此刻再强化。
	 */
	decayDaily?: number;
	now?: () => Date;
}

const DAY_MS = 86_400_000;

/** 列表 / 分组排序：偏好 → 打算 → 事实 → 经验 → 人事物 → 经历 → 履历（2026-11-13 补 experience/work）。 */
const KIND_RANK: Record<string, number> = {
	preference: 0,
	intention: 1,
	fact: 2,
	experience: 3,
	entity: 4,
	episode: 5,
	work: 6,
};

function sortByKind(rows: MemoryRecord[]): MemoryRecord[] {
	return [...rows].sort((a, b) => {
		const rank = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
		return rank !== 0 ? rank : a.createdAt < b.createdAt ? 1 : -1;
	});
}

/** 「也许值得提起」的上限：最多 2 条、每条 ≤80 字（2026-11-10 批 17 §二.1）。 */
const PROACTIVE_LIMIT = 2;
const PROACTIVE_MAX_CHARS = 80;
/** 进主动提起组的门槛：importance ≥ 0.7 且超过 7 天没被召回。 */
const PROACTIVE_MIN_IMPORTANCE = 0.7;
const PROACTIVE_STALE_DAYS = 7;

export class MemoryEngine {
	private readonly store: MemoryStore;
	private readonly extractor: Extractor;
	private readonly consolidator: Consolidator;
	private readonly retriever: Retriever;
	private readonly decayDaily: number;
	private readonly now: () => Date;

	constructor(options: MemoryEngineOptions) {
		this.store = options.store;
		this.extractor = options.extractor ?? new HeuristicExtractor();
		this.consolidator = options.consolidator ?? new BasicConsolidator();
		this.decayDaily = options.decayDaily ?? 0;
		this.retriever =
			options.retriever ??
			new WeightedRetriever({
				candidateFloor: options.candidateFloor,
				decayDaily: this.decayDaily,
			});
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
			expiresAt: input.expiresAt ?? null,
		};
		this.store.put(record);
		// 回读：store 在落盘前会做凭据打码（2026-11-09 T4 §2），
		// 调用方拿到的应是"真正入库的那份"，否则工具会把未打码原文再吐一遍。
		return this.store.get(record.id) ?? record;
	}

	/**
	 * 已存记忆导入（2026-11-08 扫尾批 6 §三）。
	 *
	 * 与 `ingestTurn` 的区别是**不抽取、不强化**：给什么存什么，
	 * 规范化等价的跳过并计数，绝不动已有行（"只增不改"）。
	 * scope 走 `scopeKey` 换算，与其它写入路径同一口径。
	 */
	importItems(input: { scope: MemoryScope; items: ImportEntry[]; now?: Date }): ImportOutcome {
		return importMemories(
			this.store,
			scopeKey(input.scope),
			input.items,
			input.now ?? this.now(),
		);
	}

	/**
	 * 会话边界调用：抽取 + 巩固。
	 *
	 * `preferenceScope`（2026-11-06；2026-11-10 起经验同待遇）：偏好与经验**不留在会话
	 * 作用域**——"我不喜欢被追问"、"这类活下次该怎么做"换个会话就失效，等于没记住。
	 * 凡是 `kind === "preference" || kind === "experience"` 的候选，写入前统一改挂到
	 * 这个更宽的 scope（主人在 `global`，执事在 `partner:<id>`）。
	 *
	 * 这个"重挂"刻意在 `Extractor` 之外做：抽取器只回答"是不是这两类"，
	 * "该存哪"是装配层的知识（谁在跟谁说话）。接口不变。
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
				if (candidate.kind === "preference" || candidate.kind === "experience") {
					candidate.scope = key;
				}
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
		// 意图过期降级（2026-11-09 T4 §3）：**读时惰性**，不建定时器。
		// 选读时而不是巩固入口：巩固只在会话边界触发，跨天回来打开应用可能先读后巩固；
		// 读时做，才能保证"看到的 kind 一定没过期"。降级 = 原地改 kind，不删记录。
		this.demoteExpiredIntentions(query.scopes, at);
		const hits = this.retriever.recall(query, this.store, at);
		for (const hit of hits) {
			// 衰减 + 使用强化同点落地（2026-11-08 扫尾批 6）：写回时锚点也推到 now，
			// 所以同一个值不会被反复衰减（见 decay.ts 头注）。
			// intention 不参与时间衰减（2026-11-09 T4 §3，与 work 同待遇）：到期由 expiresAt 管，
			// 不该再被 importance 衰减二次惩罚；命中强化照旧。
			// experience 同样不衰减（2026-11-10 批 17 §一.3）：经验不该过期。
			touchRecall(this.store, hit.record, at, {
				...(this.decayDaily > 0 &&
				hit.record.kind !== "intention" &&
				hit.record.kind !== "experience"
					? { decayDaily: this.decayDaily }
					: {}),
				reinforce: RECALL_BOOST,
			});		}
		return hits;
	}

	/**
	 * 把 `expiresAt` 已过的 intention 原地降级为 fact（保留 id / 正文 / 时间）。
	 *
	 * 只扫 `kinds:["intention"]` 的窗口，规模是"当前没兑现的打算"，不会随记忆总量增长。
	 * 时间解析不了（坏数据）不降级——宁可让它继续被当意图，也不要误改。
	 */
	private demoteExpiredIntentions(scopes: string[], at: Date): void {
		const now = at.getTime();
		for (const record of this.store.search({
			...(scopes.length ? { scopes } : {}),
			kinds: ["intention"],
			limit: 10_000,
		})) {
			if (!record.expiresAt) continue;
			const expires = Date.parse(record.expiresAt);
			if (Number.isNaN(expires) || expires >= now) continue;
			this.store.patch(record.id, { kind: "fact", expiresAt: null });
		}
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
		const at = this.now();
		const hits = this.recall(query);
		if (hits.length === 0) return "";

		const preferences = hits.filter((hit) => hit.record.kind === "preference");
		// 未过期的 intention 紧随偏好单独成组（2026-11-09 T4 §3）：
		// 过期的那批已在 recall() 里降级为 fact，到不了这里。
		const intentions = hits.filter((hit) => hit.record.kind === "intention");
		let others = hits.filter(
			(hit) => hit.record.kind !== "preference" && hit.record.kind !== "intention",
		);

		// 「也许值得提起」（2026-11-10 批 17 §二）：命中但当前话题用不上的旧记忆。
		// 判据全部确定性：importance ≥ 0.7、距 lastRecalledAt ?? createdAt 超过 7 天、
		// 与当前话题没有任何关键词交集；最多 2 条、每条 ≤80 字。
		// 被挑中的从「其它」移走，避免同一条出现两次。
		const proactive = options.proactive
			? others
					.filter((hit) => {
						const record = hit.record;
						if (record.importance < PROACTIVE_MIN_IMPORTANCE) return false;
						const anchor = Date.parse(record.lastRecalledAt ?? record.createdAt);
						if (Number.isNaN(anchor)) return false;
						if ((at.getTime() - anchor) / DAY_MS <= PROACTIVE_STALE_DAYS) return false;
						return !directlyRelevant(record.content, query.text);
					})
					.slice(0, PROACTIVE_LIMIT)
			: [];
		if (proactive.length > 0) {
			const picked = new Set(proactive.map((hit) => hit.record.id));
			others = others.filter((hit) => !picked.has(hit.record.id));
		}

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
		/** 主动提起组的一条：超 80 字截断（预算口径），并保留省略号。 */
		const clipped = (text: string): string => {
			const one = flat(text);
			return one.length <= PROACTIVE_MAX_CHARS
				? one
				: `${one.slice(0, PROACTIVE_MAX_CHARS - 1)}…`;
		};

		if (preferences.length > 0) {
			push("【用户偏好】");
			for (const hit of preferences) {
				if (!push(`- ${flat(hit.record.content)}`)) break;
			}
		}
		if (intentions.length > 0) {
			push("【打算】");
			for (const hit of intentions) {
				if (!push(`- ${flat(hit.record.content)}`)) break;
			}
		}
		if (others.length > 0) {
			// 只有偏好时不要空标题；只有其它时保持 2026-11-06 之前的形状（逐字节兼容）
			if (preferences.length > 0 || intentions.length > 0) push("【其它】");
			for (const hit of others) {
				if (!push(`- [${hit.record.kind}] ${flat(hit.record.content)}`)) break;
			}
		}
		// 固定放最后：主动提起是"顺带一句"，不该挤掉当轮真正相关的记忆。
		if (proactive.length > 0) {
			push("【也许值得提起】");
			for (const hit of proactive) {
				if (!push(`- [${hit.record.kind}] ${clipped(hit.record.content)}`)) break;
			}
		}
		if (lines.length === 0) return "";

		return [
			"以下是你记得的关于这个人的信息（按相关度排序）。自然使用，不要逐条复述，也不要提及「记忆」这个词：",
			...lines,
		].join("\n");
	}

	/**
	 * 巩固审计（2026-11-10 批 17 §三）：只读——算一份差异摘要，不改库、不删任何一条。
	 *
	 * `usageRanking=false`（`MEMORY_USAGE_RANKING` 回滚）= 按创建时间新旧决定保留优先级、
	 * 不给未用淘汰建议；diff 形状不变，`retired` 为空。
	 */
	auditConsolidation(scope: string, options: { usageRanking?: boolean } = {}): ConsolidateDiff {
		return consolidateScope(this.store, scope, {
			now: this.now(),
			usageRanking: options.usageRanking ?? true,
		});
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
				// intention 与 preference 同档保护（2026-11-09 T4 §3）：没兑现的打算
				// 不该因为会话记忆封顶被悄悄删掉；过期后它会自己降级为 fact，届时按普通规则走。
				// experience / work 同样保护（2026-11-10 批 17 §一.3）：经验不衰减；work 是
				// append-only 台账、有自己的 200 条封顶——都不该被这条通用修剪静默删掉。
				protectKinds: ["preference", "intention", "experience", "work"],
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
	 * 按 id 取一条（2026-11-08 扫尾批 6 整理建议的"应用"用）。
	 *
	 * 与 `list()` 的区别：不受列表窗口 / 条数上限影响，也**包含已被取代的**——
	 * 应用建议时要能回答"这条是不是已经被别的记录取代了"。
	 */
	getRecord(id: string): MemoryRecord | undefined {
		return this.store.get(id);
	}

	/**
	 * 设置页的分页浏览（2026-11-13 记忆页 A 版）。
	 *
	 * 与 `list()` 的分工：`list` 是"取一窗给旧界面"；这里同时回**真实总数**，
	 * 支持正文精确子串（`q`）、kind 白/黑名单与 offset，列表页才能做分类计数、
	 * 搜索与"加载更多"，且不把 limit 之外的数据谎报成总数。
	 */
	browse(
		options: {
			scopes?: string[];
			kinds?: MemoryKind[];
			excludeKinds?: MemoryKind[];
			q?: string;
			offset?: number;
			limit?: number;
			includeSuperseded?: boolean;
		} = {},
	): { items: MemoryRecord[]; total: number } {
		this.demoteExpiredIntentions(options.scopes ?? [], this.now());
		const q = options.q?.trim();
		const filter = {
			...(options.scopes?.length ? { scopes: options.scopes } : {}),
			...(options.kinds?.length ? { kinds: options.kinds } : {}),
			...(options.excludeKinds?.length ? { excludeKinds: options.excludeKinds } : {}),
			...(q ? { contains: q } : {}),
			includeSuperseded: options.includeSuperseded ?? false,
		};
		const total = this.store.countMatching(filter);
		const limit =
			options.limit === undefined
				? 500
				: Math.max(0, Math.min(2000, Math.floor(options.limit)));
		const offset = Math.max(0, Math.floor(options.offset ?? 0));
		const items =
			limit <= 0 || total === 0
				? []
				: this.store.search({ ...filter, limit, offset });
		return { items: sortByKind(items), total };
	}

	/**
	 * 设置页的真实计数（2026-11-13）：`all` / 分 kind / 已被取代的条数。
	 *
	 * `byKind` 忽略调用方的 kind 过滤（分类片要显示每类有多少），但尊重 `q` 与
	 * `excludeKinds`——搜索时计数跟着搜索走，设置页不把 work 履历算进来。
	 */
	counts(
		options: { scopes?: string[]; q?: string; excludeKinds?: MemoryKind[] } = {},
	): { all: number; byKind: Record<string, number>; superseded: number } {
		this.demoteExpiredIntentions(options.scopes ?? [], this.now());
		const q = options.q?.trim();
		const base = {
			...(options.scopes?.length ? { scopes: options.scopes } : {}),
			...(options.excludeKinds?.length ? { excludeKinds: options.excludeKinds } : {}),
			...(q ? { contains: q } : {}),
			includeSuperseded: false,
		};
		const all = this.store.countMatching(base);
		const withSuperseded = this.store.countMatching({ ...base, includeSuperseded: true });
		const byKind = this.store.countByKind(base);
		return { all, byKind, superseded: Math.max(0, withSuperseded - all) };
	}

	/**
	 * 按 scope 列记忆（设置页列表 / 排查用）。
	 *
	 * 默认**不返回已被取代的记录**：页面上列出来的是"现在还算数的记忆"。
	 * 排序按 kind 分组、组内按时间倒序——偏好排最前，和注入的优先级一致。
	 * 不在这里做关键词搜索：千级规模先给滚动，真需要再加（同设置页不做全局搜索的口径）。
	 */
	list(options: { scopes?: string[]; limit?: number; includeSuperseded?: boolean } = {}): MemoryRecord[] {
		// 列表同样做惰性降级（2026-11-09 T4 §3）：设置页不该把过期的"打算"还挂在意图组里。
		this.demoteExpiredIntentions(options.scopes ?? [], this.now());
		const rows = this.store.search({
			...(options.scopes?.length ? { scopes: options.scopes } : {}),
			includeSuperseded: options.includeSuperseded ?? false,
			limit: Math.max(1, Math.min(2000, options.limit ?? 500)),
		});
		return sortByKind(rows);
	}

	close(): void {
		this.store.close();
	}
}
