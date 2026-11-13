import { DatabaseSync } from "node:sqlite";
import { memoryRedactEnabled, redactSecrets } from "./redact.ts";
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
	/** 排除的 kind（2026-11-13 记忆页：设置页不把 work 履历混进"我的记忆"）。 */
	excludeKinds?: MemoryKind[];
	/**
	 * 候选集来源提示（2026-11-04 批次三 A2-F）——**用不用由 store 自己决定**。
	 *
	 * FTS 可用且查询能切出 3-gram → 走 trigram 词袋 OR 捞候选；
	 * 短查询（切不出 3-gram）/ FTS 不可用 → 静默忽略 text，走原来的窗口 SQL。
	 * 这是"批次一窗口语义不动"的开关点。
	 */
	text?: string;
	/**
	 * 正文子串过滤（2026-11-13 记忆页搜索）。
	 *
	 * 与 `text` 的区别：`text` 是 FTS 候选集提示（可能召回词袋噪声），
	 * `contains` 是**精确子串**约束（`instr(lower(content), lower(?)) > 0`），
	 * 给人在设置页搜"猫 / 汇报 / 跑步"用。CJK 不受大小写影响；ASCII 走 lower。
	 */
	contains?: string;
	since?: string;
	/** 是否返回已被取代的记录。默认 false —— 历史链要能查，但不该污染召回 */
	includeSuperseded?: boolean;
	limit?: number;
	/** 分页偏移（与 limit 同用；0 = 从头）。 */
	offset?: number;
}

/** 封顶修剪的可选保护项（2026-11-07）。 */
export interface PruneOptions {
	/** 这些 kind 一律不删（偏好是稳定属性，换个会话也该在）。 */
	protectKinds?: MemoryKind[];
	/**
	 * 只统计 / 删除这些 kind 的行（2026-11-08 刀二 E2：work 履历按 scope 专属封顶）。
	 * 不传 = 按整个 scope 计数删除（改动前行为，§11 用例守护）。
	 */
	kinds?: MemoryKind[];
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
	/**
	 * 满足过滤条件的条数（2026-11-13 记忆页真实计数）。
	 * 与 search 同一套 where 条件；不含 limit/offset。
	 */
	countMatching(filter: SearchFilter): number;
	/** 按 kind 分组的条数（同 countMatching 条件；给分类计数片用）。 */
	countByKind(filter: SearchFilter): Record<string, number>;
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
	"expires_at",
	"usage_count",
	"last_used_at",
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
		expiresAt: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
		usageCount: row.usage_count === null || row.usage_count === undefined ? 0 : Number(row.usage_count),
		lastUsedAt:
			row.last_used_at === null || row.last_used_at === undefined ? null : String(row.last_used_at),
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
	last_recalled_at TEXT,
	expires_at       TEXT,
	usage_count      INTEGER NOT NULL DEFAULT 0,
	last_used_at     TEXT
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
	/**
	 * 落盘前凭据打码（2026-11-09 T4 §2）。不传 = 读 `MEMORY_REDACT`（默认开）；
	 * 传 false = 直通（回滚）。唯一收口点在 `put()` / `patch(content)`：
	 * 工具、抽取、导入、巩固、日记摄入全都走这里。
	 */
	redact?: boolean;
}

/** 测试 / 无盘场景的打码开关口径与 SQLite 版一致。 */
export interface InMemoryStoreOptions {
	redact?: boolean;
}

/**
 * 用 Node 24 内置的 node:sqlite，零第三方依赖。
 * 表的形状刻意保持"一条记忆一行"，不做多表 JOIN ——
 * 记忆的复杂度应该在抽取/巩固/召回，不该在 schema。
 */
export class SqliteMemoryStore implements MemoryStore {
	private readonly db: DatabaseSync;
	private readonly ftsEnabled: boolean;
	private readonly redact: boolean;

	constructor(path: string, options: SqliteMemoryStoreOptions = {}) {
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
		this.ensureColumns();
		this.redact = options.redact ?? memoryRedactEnabled();
		this.ftsEnabled = options.fts !== false && this.initFts();
	}

	/**
	 * 老库补列（2026-11-09 T4 §3；2026-11-10 批 17 §三补 usage 两列）：`CREATE TABLE IF NOT EXISTS`
	 * 只对新库生效，已有 `memory.db` 不会因为 SCHEMA 改了长出新列。个人记忆量级，ALTER 瞬时完成；
	 * 不做版本表——一列一判，比半成品的迁移框架更稳。
	 */
	private ensureColumns(): void {
		const columns = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{
			name?: unknown;
		}>;
		const names = new Set(columns.map((column) => String(column.name)));
		const additions: Array<[string, string]> = [
			["expires_at", "TEXT"],
			["usage_count", "INTEGER NOT NULL DEFAULT 0"],
			["last_used_at", "TEXT"],
		];
		for (const [name, ddl] of additions) {
			if (!names.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl}`);
		}
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
		// 隐私收口点（2026-11-09 T4 §2）：所有写入方（remember / 抽取 / 导入 / 巩固 /
		// 日记摄入）最终都走这里。只改 content，其余字段原样落库。
		const content = this.redact ? redactSecrets(record.content) : record.content;
		this.db
			.prepare(
				`INSERT INTO memories (${COLUMNS.join(", ")})
				 VALUES (${COLUMNS.map(() => "?").join(", ")})
				 ON CONFLICT(id) DO UPDATE SET
				   kind=excluded.kind, scope=excluded.scope, content=excluded.content,
				   importance=excluded.importance, veracity=excluded.veracity,
				   source=excluded.source, valid_until=excluded.valid_until,
				   superseded_by=excluded.superseded_by, expires_at=excluded.expires_at`,
			)
			.run(
				record.id,
				record.kind,
				record.scope,
				content,
				record.importance,
				record.veracity,
				record.source,
				record.createdAt,
				record.validUntil,
				record.supersededBy,
				record.recallCount,
				record.lastRecalledAt,
				record.expiresAt ?? null,
				record.usageCount ?? 0,
				record.lastUsedAt ?? null,
			);
		// 镜像维护：put 一律 delete+insert（upsert 可能换了 content）
		if (this.ftsEnabled) this.replaceFtsRow(record.id, content);
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
	 * 窗口 SQL 的 where 收口（2026-11-13）：搜索 / 计数 / 分页共用同一套条件，
	 * 避免"列表算一套、计数算另一套"漂移。
	 */
	private whereOf(
		filter: SearchFilter,
		ftsMatch?: string,
	): { sql: string; params: (string | number)[] } {
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
		if (filter.excludeKinds?.length) {
			where.push(`kind NOT IN (${filter.excludeKinds.map(() => "?").join(", ")})`);
			params.push(...filter.excludeKinds);
		}
		if (filter.contains) {
			// 精确子串（不是 FTS 词袋候选）：设置页搜索要"搜什么有什么"。
			where.push("instr(lower(content), lower(?)) > 0");
			params.push(filter.contains);
		}
		if (filter.since) {
			where.push("created_at >= ?");
			params.push(filter.since);
		}
		if (!filter.includeSuperseded) {
			where.push("superseded_by IS NULL");
		}

		return {
			sql: where.length ? ` WHERE ${where.join(" AND ")}` : "",
			params,
		};
	}

	/**
	 * 窗口 SQL。传了 [ftsMatch] 就用镜像虚表先把候选 id 圈出来。
	 *
	 * superseded 的过滤在外层 `superseded_by IS NULL` —— 被取代的记录即使进了镜像也不进候选。
	 * FTS 命中 0 时这里返回空数组，**回落窗口路径是 retriever 的事**（它知道"0 命中"不是"没记忆"）。
	 */
	private searchRows(filter: SearchFilter, ftsMatch?: string): MemoryRecord[] {
		const where = this.whereOf(filter, ftsMatch);
		const params = [...where.params];
		let sql = `SELECT * FROM memories${where.sql} ORDER BY created_at DESC`;
		// limit / offset 用参数绑定，别把用户输入拼进 SQL。
		const limit =
			filter.limit === undefined ? 0 : Math.max(0, Math.floor(filter.limit));
		const offset = Math.max(0, Math.floor(filter.offset ?? 0));
		if (limit > 0) {
			sql += " LIMIT ? OFFSET ?";
			params.push(limit, offset);
		} else if (offset > 0) {
			sql += " LIMIT -1 OFFSET ?";
			params.push(offset);
		}

		const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
		return rows.map(rowToRecord);
	}

	countMatching(filter: SearchFilter): number {
		const match = this.ftsEnabled && filter.text ? buildFtsMatch(filter.text) : null;
		const run = (withMatch: boolean): number => {
			const where = this.whereOf(filter, withMatch ? match ?? undefined : undefined);
			const row = this.db
				.prepare(`SELECT COUNT(*) AS n FROM memories${where.sql}`)
				.get(...where.params) as { n: number };
			return Number(row.n);
		};
		try {
			return run(Boolean(match));
		} catch {
			// MATCH 抛错 → 静默回落无 FTS 条件（与 searchRows 同口径）
			return run(false);
		}
	}

	countByKind(filter: SearchFilter): Record<string, number> {
		const match = this.ftsEnabled && filter.text ? buildFtsMatch(filter.text) : null;
		const run = (withMatch: boolean): Record<string, number> => {
			const where = this.whereOf(filter, withMatch ? match ?? undefined : undefined);
			const rows = this.db
				.prepare(`SELECT kind, COUNT(*) AS n FROM memories${where.sql} GROUP BY kind`)
				.all(...where.params) as Array<{ kind: string; n: number }>;
			const out: Record<string, number> = {};
			for (const row of rows) out[String(row.kind)] = Number(row.n);
			return out;
		};
		try {
			return run(Boolean(match));
		} catch {
			return run(false);
		}
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
			expiresAt: "expires_at",
			usageCount: "usage_count",
			lastUsedAt: "last_used_at",
		};

		const sets: string[] = [];
		const params: (string | number | null)[] = [];
		for (const [key, value] of Object.entries(patch)) {
			const column = map[key];
			if (!column) continue;
			// content 也是写入：同一把打码尺子，避免"改一条就漏一次"
			const stored =
				key === "content" && this.redact && typeof value === "string"
					? redactSecrets(value)
					: value;
			sets.push(`${column} = ?`);
			params.push(stored as string | number | null);
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

		// 计数条件 = scope +（可选）kind 专属；删除条件在这之上再加保护项。
		// 不传 kinds 时 countParts 只有 scope = ?，与改动前 countByScope 等价。
		const countParts: string[] = ["scope = ?"];
		const countParams: (string | number)[] = [scope];
		const kinds = options.kinds;
		if (kinds?.length) {
			countParts.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
			countParams.push(...kinds);
		}
		const total = Number(
			(
				this.db
					.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${countParts.join(" AND ")}`)
					.get(...countParams) as { n: number }
			).n,
		);
		const excess = total - cap;
		if (excess <= 0) return 0;

		const conditions: string[] = [...countParts];
		const params: (string | number)[] = [...countParams];
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
	private readonly redact: boolean;

	constructor(options: InMemoryStoreOptions = {}) {
		this.redact = options.redact ?? memoryRedactEnabled();
	}

	/**
	 * 没有索引，`filter.text` 一律忽略（2026-11-04 批次三的刻意行为）。
	 * 批次一的窗口用例（"灯塔"）就靠这一点原样成立。
	 */
	ftsAvailable(): boolean {
		return false;
	}

	put(record: MemoryRecord): void {
		const content = this.redact ? redactSecrets(record.content) : record.content;
		// 与 SQLite 版同口径：这两列有默认值，缺省按 0 / null 落，读出来形状一致。
		this.rows.set(record.id, {
			...record,
			content,
			usageCount: record.usageCount ?? 0,
			lastUsedAt: record.lastUsedAt ?? null,
		});
	}

	get(id: string): MemoryRecord | undefined {
		const row = this.rows.get(id);
		return row ? { ...row } : undefined;
	}

	private matchesFilter(record: MemoryRecord, filter: SearchFilter): boolean {
		if (filter.scopes?.length && !filter.scopes.includes(record.scope)) return false;
		if (filter.kinds?.length && !filter.kinds.includes(record.kind)) return false;
		if (filter.excludeKinds?.length && filter.excludeKinds.includes(record.kind)) return false;
		if (filter.contains) {
			const needle = filter.contains.toLowerCase();
			if (!record.content.toLowerCase().includes(needle)) return false;
		}
		if (filter.since && record.createdAt < filter.since) return false;
		if (!filter.includeSuperseded && record.supersededBy !== null) return false;
		return true;
	}

	search(filter: SearchFilter): MemoryRecord[] {
		let rows = [...this.rows.values()].filter((row) => this.matchesFilter(row, filter));
		rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		const offset = Math.max(0, Math.floor(filter.offset ?? 0));
		if (offset > 0) rows = rows.slice(offset);
		return filter.limit ? rows.slice(0, filter.limit) : rows;
	}

	countMatching(filter: SearchFilter): number {
		let count = 0;
		for (const row of this.rows.values()) {
			if (this.matchesFilter(row, filter)) count += 1;
		}
		return count;
	}

	countByKind(filter: SearchFilter): Record<string, number> {
		const out: Record<string, number> = {};
		for (const row of this.rows.values()) {
			if (!this.matchesFilter(row, filter)) continue;
			out[row.kind] = (out[row.kind] ?? 0) + 1;
		}
		return out;
	}

	patch(id: string, patch: Partial<Omit<MemoryRecord, "id">>): void {
		const row = this.rows.get(id);
		if (!row) return;
		const next = { ...row, ...patch };
		if (this.redact && patch.content !== undefined) next.content = redactSecrets(next.content);
		this.rows.set(id, next);
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
		const kinds = options.kinds;
		const inScope = [...this.rows.values()].filter(
			(r) => r.scope === scope && (!kinds?.length || kinds.includes(r.kind)),
		);
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
