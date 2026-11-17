/**
 * store-memory-store
 *
 * 2026-11-14 从 store.ts 的 L12–L214 整段切出；正文原文搬运，未改一行实现。
 * 内含：SearchFilter / PruneOptions / MemoryStore / COLUMNS …
 */

import { MemoryDocument, MemoryKind, MemoryRecord } from "./types.ts";

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
	/**
	 * 是否返回已归档（2026-11-16 原子化：长记录拆开后原记录 archived）。
	 * 默认 false = 召回与默认列表都看不到；原文去 `memory_documents` 看。
	 */
	includeArchived?: boolean;
	/** 正文字数下限（拆分候选扫描用；`>=`）。 */
	minChars?: number;
	/** 正文字数上限（拆分候选扫描用；`<=`）。 */
	maxChars?: number;
	limit?: number;
	/** 分页偏移（与 limit 同用；0 = 从头）。 */
	offset?: number;
}

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
	/**
	 * 把 `from` 的全部记忆与原文档案整体改挂到 `to`（2026-11-17 项目合并/记忆迁移）。
	 *
	 * 纯搬家：不合并重复、不改 kind、不动 superseded 引用（引用存的是记录 id）。
	 * **FTS 不用重灌**：`memory_fts` 只镜像 content 与 content_id，不含 scope。
	 * 返回搬走的行数，供调用方如实回报（不做"搬了 0 条算成功"的掩盖）。
	 */
	moveScope(from: string, to: string): { records: number; documents: number };
	/** 把某个 scope 的全部记忆软封存（写 archived_at；行还在，可再被 move 取走）。 */
	archiveScope(scope: string): number;
	/** 是否真的能做文本检索（2026-11-04 批次三）；内存实现恒 false。 */
	ftsAvailable(): boolean;
	/** 原文档案：写入一份（按 id upsert）。 */
	putDocument(document: MemoryDocument): void;
	/** 原文档案：按 id 取。 */
	getDocument(id: string): MemoryDocument | undefined;
	/** 原文档案：按 scope / 时间列；`includeContent=false` 时 content 置空（列表页省流量）。 */
	searchDocuments(filter: SearchFilter & { includeContent?: boolean }): MemoryDocument[];
	/** 原文档案：某个 scope 的份数。 */
	countDocuments(scope: string): number;
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
	"doc_id",
	"quote",
	"quote_start",
	"quote_end",
	"archived_at",
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
		docId: row.doc_id === null || row.doc_id === undefined ? null : String(row.doc_id),
		quote: row.quote === null || row.quote === undefined ? null : String(row.quote),
		quoteStart:
			row.quote_start === null || row.quote_start === undefined ? null : Number(row.quote_start),
		quoteEnd: row.quote_end === null || row.quote_end === undefined ? null : Number(row.quote_end),
		archivedAt:
			row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
	};
}

function rowToDocument(row: Record<string, unknown>): MemoryDocument {
	return {
		id: String(row.id),
		scope: String(row.scope),
		title: row.title === null || row.title === undefined ? "" : String(row.title),
		content: row.content === null || row.content === undefined ? "" : String(row.content),
		source: String(row.source),
		sourceRef: row.source_ref === null || row.source_ref === undefined ? null : String(row.source_ref),
		sha256: row.sha256 === null || row.sha256 === undefined ? null : String(row.sha256),
		chars: Number(row.chars ?? 0),
		createdAt: String(row.created_at),
		updatedAt: row.updated_at === null || row.updated_at === undefined ? null : String(row.updated_at),
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
	last_used_at     TEXT,
	doc_id           TEXT,
	quote            TEXT,
	quote_start      INTEGER,
	quote_end        INTEGER,
	archived_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope   ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

CREATE TABLE IF NOT EXISTS memory_documents (
	id          TEXT PRIMARY KEY,
	scope       TEXT NOT NULL,
	title       TEXT,
	content     TEXT NOT NULL,
	source      TEXT NOT NULL,
	source_ref  TEXT,
	sha256      TEXT,
	chars       INTEGER NOT NULL DEFAULT 0,
	created_at  TEXT NOT NULL,
	updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_documents_scope ON memory_documents(scope, created_at);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
	content,
	content_id UNINDEXED,
	tokenize='trigram'
);
`;

const MAX_FTS_GRAMS = 24;

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

export interface InMemoryStoreOptions {
	redact?: boolean;
}

export { COLUMNS, FTS_SCHEMA, MAX_FTS_GRAMS, SCHEMA, buildFtsMatch, rowToDocument, rowToRecord };
