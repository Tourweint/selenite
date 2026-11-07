import { DatabaseSync } from "node:sqlite";
import type { MemoryKind, MemoryRecord } from "./types.ts";

/**
 * 存储层：只负责"放进去 / 拿出来"，不懂任何业务策略。
 *
 * 现在只有两张实现：SQLite（默认）和内存（测试用）。
 * 以后要加向量库、要换 Postgres，都实现这个接口即可 —— 上层不该知道用的是哪个。
 */

export interface SearchFilter {
	/** 只在这些 scope 里找 */
	scopes?: string[];
	kinds?: MemoryKind[];
	/**
	 * 候选集来源提示（2026-11-04 批次三 A2-F）——**用不用由 store 自己决定**。
	 *
	 * FTS 可用且查询能切出 3-gram → 走 trigram 词袋 OR 捞候选；
	 * 短查询（切不出 3-gram）/ FTS 不可用 → 静默忽略 text，走原来的窗口 SQL。
	 * 这是"批次一窗口语义不动"的开关点。
	 */
	text?: string;
	since?: string;
	/** 是否返回已被取代的记录。默认 false —— 历史链要能查，但不该污染召回 */
	includeSuperseded?: boolean;
	limit?: number;
}

/** 封顶修剪的可选保护项（2026-11-07）。 */
export interface PruneOptions {
	/** 这些 kind 一律不删（偏好是稳定属性，换个会话也该在）。 */
	protectKinds?: MemoryKind[];
	/** 被别的记录 `supersededBy` 指向的行不删，避免留下悬空引用。 */
	protectReferenced?: boolean;
}

export interface MemoryStore {
	put(record: MemoryRecord): void;
	get(id: string): MemoryRecord | undefined;
	search(filter: SearchFilter): MemoryRecord[];
	patch(id: string, patch: Partial<Omit<MemoryRecord, "id">>): void;
	/**
	 * 物理删除一条（2026-11-06，设置页"删掉这条"）。
	 *
	 * 刻意是硬删而不是软删：记忆是私人物，用户按了删除就是删除；
	 * 留一份"已删除但还在库里"的副本，等于在别处又存了一份对话内容。
	 * 需要保留演化链时走 `patch(supersededBy)`（取代），不是删除。
	 */
	remove(id: string): boolean;
	count(scope?: string): number;
	/** 某个 scope 的条数（2026-11-07 封顶修剪）。 */
	countByScope(scope: string): number;
	/** 库里出现过的所有 scope（按前缀挑要修剪的作用域用）。 */
	listScopes(): string[];
	/**
	 * 把某个 scope 修剪到至多 `keep` 条：按 `created_at` 最旧优先删，
	 * 保护 `protectKinds` 与被 `supersededBy` 引用的行；`global` 拒绝修剪（抛错）。
	 * 返回实际删除条数（只给调用方记数用，不含任何正文）。
	 */
	pruneOldest(scope: string, keep: number, options?: PruneOptions): number;
	/** 是否真的能做文本检索（2026-11-04 批次三）；内存实现恒 false。 */
	ftsAvailable(): boolean;
	close(): void;
}

const COLUMNS = [
	"id",
	"kind",
	"scope",
	"content",
	"importance",
	"veracity",
	"source",
	"created_at",
	"valid_until",
	"superseded_by",
	"recall_count",
	"last_recalled_at",
] as const;

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
	return {
		id: String(row.id),
		kind: String(row.kind) as MemoryKind,
		scope: String(row.scope),
		content: String(row.content),
		importance: Number(row.importance),
		veracity: String(row.veracity) as MemoryRecord["veracity"],
		source: String(row.source),
		createdAt: String(row.created_at),
		validUntil: row.valid_until === null ? null : String(row.valid_until),
		supersededBy: row.superseded_by === null ? null : String(row.superseded_by),
		recallCount: Number(row.recall_count),
		lastRecalledAt:
			row.last_recalled_at === null ? null : String(row.last_recalled_at),
	};
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
	id               TEXT PRIMARY KEY,
	kind             TEXT NOT NULL,
	scope            TEXT NOT NULL,
	content          TEXT NOT NULL,
	importance       REAL NOT NULL,
	veracity         TEXT NOT NULL,
	source           TEXT NOT NULL,
	created_at       TEXT NOT NULL,
	valid_until      TEXT,
	superseded_by    TEXT,
	recall_count     INTEGER NOT NULL DEFAULT 0,
	last_recalled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope   ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
`;

/**
 * 镜像虚表（2026-11-04 批次三 A2-F）。
 *
 * content_id 故意 UNINDEXED：本规模（个人记忆数千条）不需要按 id 反查，
 * 代价是 `DELETE ... WHERE content_id = ?` 要全表扫 —— 可接受，换的是虚表更小。
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
	content,
	content_id UNINDEXED,
	tokenize='trigram'
);
`;

/** 一次 MATCH 最多用多少个 3-gram（长句防表达式爆炸）。 */
const MAX_FTS_GRAMS = 24;

/**
 * 查询串 → FTS5 MATCH 表达式（2026-11-04 批次三 A2-F）。
 *
 * **为什么不整句短语匹配**：trigram 的 MATCH 是短语/子串语义，实测整句
 * （"我今天想吃红烧狮子头，你能帮我找找附近的餐馆吗？"）恒 0 命中。
 * 这里切成 3-gram 词袋再用 OR 连接：库里只要有一段 3 字重合就能进候选池。
 * 词袋必然带噪声候选，交给打分层 + limit 兜 —— 候选集只负责"把相关的老条目捞进来"。
 *
 * 清洗口径照抄 recall.ts 的 extractKeywords。切不出 3-gram（短查询 / 纯标点）返回 null，
 * 调用方走原窗口路径 —— 批次一"灯塔"用例的保命条件。
 */
function buildFtsMatch(text: string): string | null {
	const cleaned = text.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, " ").trim();
	if (!cleaned) return null;

	const grams = new Set<string>();
	outer: for (const chunk of cleaned.split(/\s+/)) {
		if (!chunk) continue;
		const normalized = /\p{Script=Han}/u.test(chunk) ? chunk : chunk.toLowerCase();
		for (let index = 0; index + 3 <= normalized.length; index += 1) {
			grams.add(normalized.slice(index, index + 3));
			if (grams.size >= MAX_FTS_GRAMS) break outer;
		}
	}
	if (grams.size === 0) return null;

	// FTS5 字符串字面量：整体双引号，内部双引号转义成两个。
	return [...grams].map((gram) => `"${gram.replace(/"/g, '""')}"`).join(" OR ");
}

export interface SqliteMemoryStoreOptions {
	/** 是否启用 FTS5 trigram 候选集（2026-11-04 批次三）。默认 true；false = 回到批次一行为。 */
	fts?: boolean;
}

/**
 * 用 Node 24 内置的 node:sqlite，零第三方依赖。
 * 表的形状刻意保持"一条记忆一行"，不做多表 JOIN ——
 * 记忆的复杂度应该在抽取/巩固/召回，不该在 schema。
 */
export class SqliteMemoryStore implements MemoryStore {
	private readonly db: DatabaseSync;
	private readonly ftsEnabled: boolean;

	constructor(path: string, options: SqliteMemoryStoreOptions = {}) {
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
		this.ftsEnabled = options.fts !== false && this.initFts();
	}

	/**
	 * 建镜像虚表 + 对账。探测失败（SQLite 没编 FTS5 / 没有 trigram）返回 false，
	 * 全链路静默退回窗口路径 —— 记忆检索不该让服务起不来。
	 */
	private initFts(): boolean {
		try {
			this.db.exec(FTS_SCHEMA);
			const mirrored = this.db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as {
				n: number;
			};
			const stored = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as {
				n: number;
			};
			// 批次三之前的旧库没有镜像行：行数对不上就整表重灌，不需要迁移脚本。
			if (Number(mirrored.n) !== Number(stored.n)) this.rebuildFts();
			return true;
		} catch {
			return false;
		}
	}

	/** 清空重灌。只在构造对账时调用（个人记忆量级，几毫秒）。 */
	private rebuildFts(): void {
		this.db.exec("DELETE FROM memory_fts");
		this.db
			.prepare("INSERT INTO memory_fts (content, content_id) SELECT content, id FROM memories")
			.run();
	}

	ftsAvailable(): boolean {
		return this.ftsEnabled;
	}

	put(record: MemoryRecord): void {
		this.db
			.prepare(
				`INSERT INTO memories (${COLUMNS.join(", ")})
				 VALUES (${COLUMNS.map(() => "?").join(", ")})
				 ON CONFLICT(id) DO UPDATE SET
				   kind=excluded.kind, scope=excluded.scope, content=excluded.content,
				   importance=excluded.importance, veracity=excluded.veracity,
				   source=excluded.source, valid_until=excluded.valid_until,
				   superseded_by=excluded.superseded_by`,
			)
			.run(
				record.id,
				record.kind,
				record.scope,
				record.content,
				record.importance,
				record.veracity,
				record.source,
				record.createdAt,
				record.validUntil,
				record.supersededBy,
				record.recallCount,
				record.lastRecalledAt,
			);
		// 镜像维护：put 一律 delete+insert（upsert 可能换了 content）
		if (this.ftsEnabled) this.replaceFtsRow(record.id, record.content);
	}

	private replaceFtsRow(id: string, content: string): void {
		this.db.prepare("DELETE FROM memory_fts WHERE content_id = ?").run(id);
		this.db
			.prepare("INSERT INTO memory_fts (content, content_id) VALUES (?, ?)")
			.run(content, id);
	}

	get(id: string): MemoryRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM memories WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined;
		return row ? rowToRecord(row) : undefined;
	}

	search(filter: SearchFilter): MemoryRecord[] {
		// text 只是"候选集来源提示"（2026-11-04 批次三）：切不出 3-gram 就当没给。
		if (this.ftsEnabled && filter.text) {
			const match = buildFtsMatch(filter.text);
			if (match) {
				try {
					return this.searchRows(filter, match);
				} catch {
					// MATCH 抛错（极端输入 / 老版本 SQLite）→ 静默回落窗口路径
				}
			}
		}
		return this.searchRows(filter);
	}

	/**
	 * 窗口 SQL。传了 [ftsMatch] 就用镜像虚表先把候选 id 圈出来。
	 *
	 * superseded 的过滤在外层 `superseded_by IS NULL` —— 被取代的记录即使进了镜像也不进候选。
	 * FTS 命中 0 时这里返回空数组，**回落窗口路径是 retriever 的事**（它知道"0 命中"不是"没记忆"）。
	 */
	private searchRows(filter: SearchFilter, ftsMatch?: string): MemoryRecord[] {
		const where: string[] = [];
		const params: (string | number)[] = [];

		if (ftsMatch) {
			where.push("id IN (SELECT content_id FROM memory_fts WHERE memory_fts MATCH ?)");
			params.push(ftsMatch);
		}
		if (filter.scopes?.length) {
			where.push(`scope IN (${filter.scopes.map(() => "?").join(", ")})`);
			params.push(...filter.scopes);
		}
		if (filter.kinds?.length) {
			where.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
			params.push(...filter.kinds);
		}
		if (filter.since) {
			where.push("created_at >= ?");
			params.push(filter.since);
		}
		if (!filter.includeSuperseded) {
			where.push("superseded_by IS NULL");
		}

		const sql =
			`SELECT * FROM memories` +
			(where.length ? ` WHERE ${where.join(" AND ")}` : "") +
			` ORDER BY created_at DESC` +
			(filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : "");

		const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
		return rows.map(rowToRecord);
	}

	patch(id: string, patch: Partial<Omit<MemoryRecord, "id">>): void {
		const map: Record<string, string> = {
			kind: "kind",
			scope: "scope",
			content: "content",
			importance: "importance",
			veracity: "veracity",
			source: "source",
			createdAt: "created_at",
			validUntil: "valid_until",
			supersededBy: "superseded_by",
			recallCount: "recall_count",
			lastRecalledAt: "last_recalled_at",
		};

		const sets: string[] = [];
		const params: (string | number | null)[] = [];
		for (const [key, value] of Object.entries(patch)) {
			const column = map[key];
			if (!column) continue;
			sets.push(`${column} = ?`);
			params.push(value as string | number | null);
		}
		if (sets.length === 0) return;

		params.push(id);
		this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
		// 镜像维护：只有 content 变了才需要重灌这一行
		if (this.ftsEnabled && patch.content !== undefined) {
			const row = this.get(id);
			if (row) this.replaceFtsRow(id, row.content);
		}
	}

	count(scope?: string): number {
		const row = scope
			? (this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = ?").get(scope) as {
					n: number;
				})
			: (this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number });
		return Number(row.n);
	}

	countByScope(scope: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = ?")
			.get(scope) as { n: number };
		return Number(row.n);
	}

	listScopes(): string[] {
		const rows = this.db.prepare("SELECT DISTINCT scope FROM memories").all() as Array<
			Record<string, unknown>
		>;
		return rows.map((row) => String(row.scope));
	}

	/**
	 * 封顶修剪（2026-11-07）：一条 DELETE 子查询把最旧的、可删的行一次删掉。
	 *
	 * 两条 `DELETE` 共用同一个子查询（确定性 ORDER BY created_at, rowid）：先清 FTS 镜像、
	 * 再删正表，中间不动 `memories`，所以两次选中的行完全一致。全程同步、无 await，
	 * 单进程里不会被别的写入插进来。
	 */
	pruneOldest(scope: string, keep: number, options: PruneOptions = {}): number {
		if (scope === "global") {
			throw new Error("global scope 不做自动修剪：偏好与长期事实永不淘汰");
		}
		const cap = Math.max(0, Math.floor(keep));
		const excess = this.countByScope(scope) - cap;
		if (excess <= 0) return 0;

		const conditions: string[] = ["scope = ?"];
		const params: (string | number)[] = [scope];
		const protectKinds = options.protectKinds ?? [];
		if (protectKinds.length) {
			conditions.push(`kind NOT IN (${protectKinds.map(() => "?").join(", ")})`);
			params.push(...protectKinds);
		}
		if (options.protectReferenced) {
			conditions.push(
				"id NOT IN (SELECT superseded_by FROM memories WHERE superseded_by IS NOT NULL)",
			);
		}
		const subquery =
			`SELECT id FROM memories WHERE ${conditions.join(" AND ")}` +
			" ORDER BY created_at ASC, rowid ASC LIMIT ?";
		const allParams = [...params, excess];

		if (this.ftsEnabled) {
			this.db
				.prepare(`DELETE FROM memory_fts WHERE content_id IN (${subquery})`)
				.run(...allParams);
		}
		const result = this.db
			.prepare(`DELETE FROM memories WHERE id IN (${subquery})`)
			.run(...allParams);
		return Number(result.changes);
	}

	remove(id: string): boolean {
		const existing = this.get(id);
		if (!existing) return false;
		this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
		// 镜像同步：不删的话下次 count 对账会把整表重灌（能自愈，但白做一次全表扫）
		if (this.ftsEnabled) this.db.prepare("DELETE FROM memory_fts WHERE content_id = ?").run(id);
		return true;
	}

	close(): void {
		this.db.close();
	}
}

/** 测试与无盘场景用。行为与 SQLite 版一致，只是一个 Map。 */
export class InMemoryStore implements MemoryStore {
	private readonly rows = new Map<string, MemoryRecord>();

	/**
	 * 没有索引，`filter.text` 一律忽略（2026-11-04 批次三的刻意行为）。
	 * 批次一的窗口用例（"灯塔"）就靠这一点原样成立。
	 */
	ftsAvailable(): boolean {
		return false;
	}

	put(record: MemoryRecord): void {
		this.rows.set(record.id, { ...record });
	}

	get(id: string): MemoryRecord | undefined {
		const row = this.rows.get(id);
		return row ? { ...row } : undefined;
	}

	search(filter: SearchFilter): MemoryRecord[] {
		let rows = [...this.rows.values()];
		if (filter.scopes?.length) rows = rows.filter((r) => filter.scopes!.includes(r.scope));
		if (filter.kinds?.length) rows = rows.filter((r) => filter.kinds!.includes(r.kind));
		if (filter.since) rows = rows.filter((r) => r.createdAt >= filter.since!);
		if (!filter.includeSuperseded) rows = rows.filter((r) => r.supersededBy === null);

		rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		return filter.limit ? rows.slice(0, filter.limit) : rows;
	}

	patch(id: string, patch: Partial<Omit<MemoryRecord, "id">>): void {
		const row = this.rows.get(id);
		if (!row) return;
		this.rows.set(id, { ...row, ...patch });
	}

	remove(id: string): boolean {
		return this.rows.delete(id);
	}

	count(scope?: string): number {
		if (!scope) return this.rows.size;
		return [...this.rows.values()].filter((r) => r.scope === scope).length;
	}

	countByScope(scope: string): number {
		return [...this.rows.values()].filter((r) => r.scope === scope).length;
	}

	listScopes(): string[] {
		return [...new Set([...this.rows.values()].map((r) => r.scope))];
	}

	pruneOldest(scope: string, keep: number, options: PruneOptions = {}): number {
		if (scope === "global") {
			throw new Error("global scope 不做自动修剪：偏好与长期事实永不淘汰");
		}
		const cap = Math.max(0, Math.floor(keep));
		const inScope = [...this.rows.values()].filter((r) => r.scope === scope);
		const excess = inScope.length - cap;
		if (excess <= 0) return 0;

		const referenced = new Set<string>();
		if (options.protectReferenced) {
			for (const row of this.rows.values()) {
				if (row.supersededBy) referenced.add(row.supersededBy);
			}
		}
		const protectKinds = new Set(options.protectKinds ?? []);
		const deletable = inScope
			.filter((r) => !protectKinds.has(r.kind) && !referenced.has(r.id))
			.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
		const victims = deletable.slice(0, excess);
		for (const victim of victims) this.rows.delete(victim.id);
		return victims.length;
	}

	close(): void {
		this.rows.clear();
	}
}
