/**
 * store-in-memory-store
 *
 * 2026-11-14 从 store.ts 的 L598–L723 整段切出；正文原文搬运，未改一行实现。
 * 内含：InMemoryStore
 */

import { memoryRedactEnabled, redactSecrets } from "./redact.ts";
import { MemoryDocument, MemoryRecord } from "./types.ts";
import type { InMemoryStoreOptions, MemoryStore, PruneOptions, SearchFilter } from "./store-memory-store.ts";

export class InMemoryStore implements MemoryStore {
	private readonly rows = new Map<string, MemoryRecord>();
	private readonly documents = new Map<string, MemoryDocument>();
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
			docId: record.docId ?? null,
			quote: record.quote ?? null,
			quoteStart: record.quoteStart ?? null,
			quoteEnd: record.quoteEnd ?? null,
			archivedAt: record.archivedAt ?? null,
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
		if (filter.minChars !== undefined && record.content.length < filter.minChars) return false;
		if (filter.maxChars !== undefined && record.content.length > filter.maxChars) return false;
		if (!filter.includeSuperseded && record.supersededBy !== null) return false;
		if (!filter.includeArchived && record.archivedAt) return false;
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
		return [...this.rows.values()].filter((r) => r.scope === scope && !r.archivedAt).length;
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
			(r) => r.scope === scope && !r.archivedAt && (!kinds?.length || kinds.includes(r.kind)),
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

	moveScope(from: string, to: string): { records: number; documents: number } {
		if (!from || !to || from === to) return { records: 0, documents: 0 };
		let records = 0;
		for (const [id, row] of this.rows) {
			if (row.scope !== from) continue;
			this.rows.set(id, { ...row, scope: to });
			records += 1;
		}
		let documents = 0;
		for (const [id, document] of this.documents) {
			if (document.scope !== from) continue;
			this.documents.set(id, { ...document, scope: to });
			documents += 1;
		}
		return { records, documents };
	}

	archiveScope(scope: string): number {
		if (!scope) return 0;
		const at = new Date().toISOString();
		let archived = 0;
		for (const [id, row] of this.rows) {
			if (row.scope !== scope || row.archivedAt) continue;
			this.rows.set(id, { ...row, archivedAt: at });
			archived += 1;
		}
		return archived;
	}

	// ── 原文档案（2026-11-16 记忆原子化）──────────────────────

	putDocument(document: MemoryDocument): void {
		const content = this.redact ? redactSecrets(document.content) : document.content;
		this.documents.set(document.id, {
			...document,
			content,
			chars: content.length,
		});
	}

	getDocument(id: string): MemoryDocument | undefined {
		const document = this.documents.get(id);
		return document ? { ...document } : undefined;
	}

	searchDocuments(filter: SearchFilter & { includeContent?: boolean }): MemoryDocument[] {
		let rows = [...this.documents.values()].filter(
			(document) => !filter.scopes?.length || filter.scopes.includes(document.scope),
		);
		rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		const offset = Math.max(0, Math.floor(filter.offset ?? 0));
		if (offset > 0) rows = rows.slice(offset);
		const limit = filter.limit === undefined ? rows.length : Math.max(0, Math.floor(filter.limit));
		rows = rows.slice(0, limit);
		return filter.includeContent === false
			? rows.map((document) => ({ ...document, content: "" }))
			: rows.map((document) => ({ ...document }));
	}

	countDocuments(scope: string): number {
		return [...this.documents.values()].filter((document) => document.scope === scope).length;
	}

	close(): void {
		this.rows.clear();
		this.documents.clear();
	}
}
