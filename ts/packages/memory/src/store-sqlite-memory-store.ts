/**
 * store-sqlite-memory-store
 *
 * 2026-11-14 从 store.ts 的 L221–L595 整段切出；正文原文搬运，未改一行实现。
 * 内含：SqliteMemoryStore
 */

import { memoryRedactEnabled, redactSecrets } from "./redact.ts";
import { MemoryDocument, MemoryRecord } from "./types.ts";
import { DatabaseSync } from "node:sqlite";
import { COLUMNS, FTS_SCHEMA, SCHEMA, buildFtsMatch, rowToDocument, rowToRecord } from "./store-memory-store.ts";
import type { MemoryStore, PruneOptions, SearchFilter, SqliteMemoryStoreOptions } from "./store-memory-store.ts";

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
			["doc_id", "TEXT"],
			["quote", "TEXT"],
			["quote_start", "INTEGER"],
			["quote_end", "INTEGER"],
			["archived_at", "TEXT"],
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
				   superseded_by=excluded.superseded_by, expires_at=excluded.expires_at,
				   doc_id=excluded.doc_id, quote=excluded.quote,
				   quote_start=excluded.quote_start, quote_end=excluded.quote_end,
				   archived_at=excluded.archived_at`,
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
				record.docId ?? null,
				record.quote ?? null,
				record.quoteStart ?? null,
				record.quoteEnd ?? null,
				record.archivedAt ?? null,
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
		if (filter.minChars !== undefined) {
			where.push("length(content) >= ?");
			params.push(filter.minChars);
		}
		if (filter.maxChars !== undefined) {
			where.push("length(content) <= ?");
			params.push(filter.maxChars);
		}
		if (!filter.includeSuperseded) {
			where.push("superseded_by IS NULL");
		}
		if (!filter.includeArchived) {
			where.push("archived_at IS NULL");
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
			docId: "doc_id",
			quote: "quote",
			quoteStart: "quote_start",
			quoteEnd: "quote_end",
			archivedAt: "archived_at",
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
			.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = ? AND archived_at IS NULL")
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
		const countParts: string[] = ["scope = ?", "archived_at IS NULL"];
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

	// ── 原文档案（2026-11-16 记忆原子化）──────────────────────

	putDocument(document: MemoryDocument): void {
		// 原文同样过凭据打码：导入文件的正文可能含密钥，不能借"档案"绕开收口点。
		const content = this.redact ? redactSecrets(document.content) : document.content;
		const chars = content.length;
		this.db
			.prepare(
				`INSERT INTO memory_documents (id, scope, title, content, source, source_ref, sha256, chars, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   scope=excluded.scope, title=excluded.title, content=excluded.content,
				   source=excluded.source, source_ref=excluded.source_ref, sha256=excluded.sha256,
				   chars=excluded.chars, updated_at=excluded.updated_at`,
			)
			.run(
				document.id,
				document.scope,
				document.title,
				content,
				document.source,
				document.sourceRef,
				document.sha256,
				chars,
				document.createdAt,
				document.updatedAt,
			);
	}

	getDocument(id: string): MemoryDocument | undefined {
		const row = this.db
			.prepare("SELECT * FROM memory_documents WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined;
		return row ? rowToDocument(row) : undefined;
	}

	searchDocuments(filter: SearchFilter & { includeContent?: boolean }): MemoryDocument[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (filter.scopes?.length) {
			where.push(`scope IN (${filter.scopes.map(() => "?").join(", ")})`);
			params.push(...filter.scopes);
		}
		const sql =
			`SELECT id, scope, title, ${filter.includeContent === false ? "''" : "content"} AS content, ` +
			"source, source_ref, sha256, chars, created_at, updated_at " +
			`FROM memory_documents${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
			"ORDER BY created_at DESC LIMIT ? OFFSET ?";
		const limit = Math.max(0, Math.floor(filter.limit ?? 100));
		const offset = Math.max(0, Math.floor(filter.offset ?? 0));
		const rows = this.db.prepare(sql).all(...params, limit, offset) as Record<string, unknown>[];
		return rows.map(rowToDocument);
	}

	countDocuments(scope: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM memory_documents WHERE scope = ?")
			.get(scope) as { n: number };
		return Number(row.n);
	}

	close(): void {
		this.db.close();
	}
}
