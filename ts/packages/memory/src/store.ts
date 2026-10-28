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
	/** 关键词（当前实现是子串匹配，够用；FTS5 是 TODO） */
	text?: string;
	since?: string;
	/** 是否返回已被取代的记录。默认 false —— 历史链要能查，但不该污染召回 */
	includeSuperseded?: boolean;
	limit?: number;
}

export interface MemoryStore {
	put(record: MemoryRecord): void;
	get(id: string): MemoryRecord | undefined;
	search(filter: SearchFilter): MemoryRecord[];
	patch(id: string, patch: Partial<Omit<MemoryRecord, "id">>): void;
	count(scope?: string): number;
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
 * 用 Node 24 内置的 node:sqlite，零第三方依赖。
 * 表的形状刻意保持"一条记忆一行"，不做多表 JOIN ——
 * 记忆的复杂度应该在抽取/巩固/召回，不该在 schema。
 */
export class SqliteMemoryStore implements MemoryStore {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
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
	}

	get(id: string): MemoryRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM memories WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined;
		return row ? rowToRecord(row) : undefined;
	}

	search(filter: SearchFilter): MemoryRecord[] {
		const where: string[] = [];
		const params: (string | number)[] = [];

		if (filter.scopes?.length) {
			where.push(`scope IN (${filter.scopes.map(() => "?").join(", ")})`);
			params.push(...filter.scopes);
		}
		if (filter.kinds?.length) {
			where.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
			params.push(...filter.kinds);
		}
		if (filter.text) {
			where.push("content LIKE ?");
			params.push(`%${filter.text}%`);
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
	}

	count(scope?: string): number {
		const row = scope
			? (this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = ?").get(scope) as {
					n: number;
				})
			: (this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number });
		return Number(row.n);
	}

	close(): void {
		this.db.close();
	}
}

/** 测试与无盘场景用。行为与 SQLite 版一致，只是一个 Map。 */
export class InMemoryStore implements MemoryStore {
	private readonly rows = new Map<string, MemoryRecord>();

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
		if (filter.text) rows = rows.filter((r) => r.content.includes(filter.text!));
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

	count(scope?: string): number {
		if (!scope) return this.rows.size;
		return [...this.rows.values()].filter((r) => r.scope === scope).length;
	}

	close(): void {
		this.rows.clear();
	}
}
