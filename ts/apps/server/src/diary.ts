import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hono } from "hono";

/**
 * 日记成稿镜像（2026-10-29，App 仓库 `docs/设计方案/2026-10-29-对话正文归位Harness（手机只留索引）.md` §7.1）。
 *
 * 定性（先钉死，别写歪）：**手机是日记的权威，这里只是一份镜像**。
 * - 没有任何"在这里改日记"的入口（不提供 PATCH/DELETE），唯一写入路径是 `POST /api/v1/diary/sync`；
 * - `deleted` 是**软标记**，永不物理删除 —— 后期要分析"写过又删了"；
 * - 存放在**独立库** `.data/diary.sqlite`（`DIARY_DB_PATH` 可改），不混进 pi-durable 的表：
 *   那边的表由内核管，外部表混进去每次升级都痛（配对存储也是同样的理由只存 JSON 文件）。
 *
 * 合并口径（与 §7.1 表一一对应）：
 * | 场景 | 处理 |
 * |---|---|
 * | 镜像无、上行有 | 插入 |
 * | 上行 `updatedAt` 更新 | 覆盖（手机赢） |
 * | 两边 `updatedAt` 相同且内容一致 | 跳过 |
 * | 两边 `updatedAt` 相同但内容不同 | 手机赢 + 记一行日志（单用户单设备，正常不会发生） |
 * | 上行 `updatedAt` 更旧 | 镜像保留，**把胜出的那一行塞回响应**，让客户端按 `updatedAt` 覆盖本地 |
 * | `deleted=true` | 只置标记（软删），保留已有正文 |
 */

/** 单条正文上限（8KB 截断保护，§7.1 的"单条上限"口径） */
const MAX_TEXT_BYTES = 8192;

/** 一次响应最多带回多少行（客户端按 200 条/页翻页） */
const MAX_ROWS_PER_RESPONSE = 200;

export interface DiaryEntryWire {
	id: string;
	status?: string;
	source?: string;
	/** 手机端原始来源枚举（MANUAL / INTERVIEW / CAPTURE / EMOTION / RECALL），便于后期按来源分流 */
	localSource?: string | null;
	/** 成稿所属日历日（`yyyy-MM-dd`，手机本地日）—— restore 时没有它无法重建本地行 */
	entryDate?: string | null;
	finalText?: string;
	rawSnapshot?: string;
	types?: string[];
	mood?: number | null;
	createdAt?: number;
	updatedAt?: number;
	deleted?: boolean;
	conversationId?: string | null;
}

export interface DiarySyncRequest {
	entries?: DiaryEntryWire[];
	since?: number;
}

export interface DiarySyncResponse {
	entries: DiaryEntryWire[];
	serverTime: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS diary_entries (
	id              TEXT PRIMARY KEY,
	status          TEXT NOT NULL DEFAULT 'CONFIRMED',
	source          TEXT NOT NULL DEFAULT 'MANUAL',
	local_source    TEXT,
	entry_date      TEXT,
	final_text      TEXT NOT NULL DEFAULT '',
	raw_snapshot    TEXT NOT NULL DEFAULT '',
	types           TEXT NOT NULL DEFAULT '[]',
	mood            INTEGER,
	created_at      INTEGER NOT NULL DEFAULT 0,
	updated_at      INTEGER NOT NULL DEFAULT 0,
	deleted         INTEGER NOT NULL DEFAULT 0,
	conversation_id TEXT,
	mirrored_at     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_diary_updated ON diary_entries(updated_at);
`;

type Row = Record<string, unknown>;

/** 按 UTF-8 字节截断（不是按字符数 —— 8KB 说的是体积） */
function clipText(value: string, limit = MAX_TEXT_BYTES): string {
	if (Buffer.byteLength(value, "utf8") <= limit) return value;
	let out = "";
	let bytes = 0;
	for (const ch of value) {
		const size = Buffer.byteLength(ch, "utf8");
		if (bytes + size > limit) break;
		out += ch;
		bytes += size;
	}
	return out;
}

function asText(value: unknown, limit = MAX_TEXT_BYTES): string {
	if (typeof value !== "string") return "";
	return clipText(value, limit);
}

function asMillis(value: unknown, fallback: number): number {
	const num = typeof value === "number" ? value : Number(value);
	return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
}

function parseTypes(raw: unknown): string[] {
	const list = Array.isArray(raw)
		? raw
		: typeof raw === "string" && raw.trim()
			? (() => {
					try {
						const parsed = JSON.parse(raw) as unknown;
						return Array.isArray(parsed) ? parsed : [];
					} catch {
						return [];
					}
				})()
			: [];
	return list.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** 上行一行 → 内部形态（非法行直接丢弃：镜像宁可少一行，也不收半条脏数据） */
function normalize(raw: DiaryEntryWire | null | undefined): InternalEntry | null {
	if (!raw || typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
	const createdAt = asMillis(raw.createdAt, 0);
	const updatedAt = asMillis(raw.updatedAt, createdAt);
	return {
		id: raw.id.trim(),
		status: typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : "CONFIRMED",
		source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : "MANUAL",
		localSource: typeof raw.localSource === "string" ? raw.localSource : null,
		entryDate: typeof raw.entryDate === "string" ? raw.entryDate.slice(0, 10) : null,
		finalText: asText(raw.finalText),
		rawSnapshot: asText(raw.rawSnapshot),
		types: parseTypes(raw.types),
		mood: typeof raw.mood === "number" && Number.isFinite(raw.mood) ? Math.floor(raw.mood) : null,
		createdAt: createdAt || updatedAt,
		updatedAt: updatedAt || createdAt,
		deleted: raw.deleted === true,
		conversationId: typeof raw.conversationId === "string" && raw.conversationId.trim() ? raw.conversationId.trim() : null,
	};
}

interface InternalEntry {
	id: string;
	status: string;
	source: string;
	localSource: string | null;
	entryDate: string | null;
	finalText: string;
	rawSnapshot: string;
	types: string[];
	mood: number | null;
	createdAt: number;
	updatedAt: number;
	deleted: boolean;
	conversationId: string | null;
}

function rowToEntry(row: Row): InternalEntry {
	return {
		id: String(row.id),
		status: String(row.status),
		source: String(row.source),
		localSource: row.local_source === null ? null : String(row.local_source),
		entryDate: row.entry_date === null ? null : String(row.entry_date),
		finalText: String(row.final_text),
		rawSnapshot: String(row.raw_snapshot),
		types: parseTypes(row.types),
		mood: row.mood === null ? null : Number(row.mood),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		deleted: Number(row.deleted) === 1,
		conversationId: row.conversation_id === null ? null : String(row.conversation_id),
	};
}

function toWire(entry: InternalEntry): DiaryEntryWire {
	return {
		id: entry.id,
		status: entry.status,
		source: entry.source,
		localSource: entry.localSource,
		entryDate: entry.entryDate,
		finalText: entry.finalText,
		rawSnapshot: entry.rawSnapshot,
		types: entry.types,
		mood: entry.mood,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		deleted: entry.deleted,
		conversationId: entry.conversationId,
	};
}

/** 内容是否一致（用于"两边都有且一致 → 跳过"） */
function sameContent(a: InternalEntry, b: InternalEntry): boolean {
	return (
		a.status === b.status &&
		a.source === b.source &&
		a.finalText === b.finalText &&
		a.rawSnapshot === b.rawSnapshot &&
		a.types.join("|") === b.types.join("|") &&
		(a.mood ?? -1) === (b.mood ?? -1) &&
		a.deleted === b.deleted
	);
}

const DEFAULT_DB_PATH = ".data/diary.sqlite";

export class DiaryStore {
	private readonly db: DatabaseSync;

	constructor(path: string = DEFAULT_DB_PATH) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
	}

	get(id: string): InternalEntry | null {
		const row = this.db.prepare("SELECT * FROM diary_entries WHERE id = ?").get(id) as Row | undefined;
		return row ? rowToEntry(row) : null;
	}

	/** 只读全量（调试/自检用；正式路径永不调用） */
	list(limit = MAX_ROWS_PER_RESPONSE): DiaryEntryWire[] {
		const rows = this.db
			.prepare("SELECT * FROM diary_entries ORDER BY updated_at DESC LIMIT ?")
			.all(limit) as Row[];
		return rows.map((row) => toWire(rowToEntry(row)));
	}

	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM diary_entries").get() as { n: number };
		return Number(row.n);
	}

	/**
	 * 一次请求完成「上行增量 + 下行增量」。
	 *
	 * `since` 是**闭区间**（`updated_at >= since`）：同一毫秒写入的行宁可重复下发，
	 * 客户端按 `updatedAt` 幂等跳过比漏一行便宜得多（漏一行就是那篇日记永远丢在电脑外）。
	 */
	sync(input: DiarySyncRequest): DiarySyncResponse {
		const incoming = Array.isArray(input.entries) ? input.entries : [];
		const now = Date.now();
		/** 上行比镜像旧时，把镜像里胜出的那行带回给客户端（否则两边会一直各留一份） */
		const conflicts = new Map<string, DiaryEntryWire>();
		let applied = 0;
		let skipped = 0;

		for (const raw of incoming) {
			const entry = normalize(raw);
			if (!entry) {
				skipped += 1;
				continue;
			}
			const existing = this.get(entry.id);

			if (!existing) {
				this.insert(entry, now);
				applied += 1;
				continue;
			}

			if (entry.updatedAt > existing.updatedAt) {
				// 墓碑只带 id + 删除时刻（正文空），**不能**走 overwrite：那会把已镜像的正文抹成空，
				// 而"写过又删了"正是后期要分析的东西（软删必须保留正文）
				if (entry.deleted) {
					this.markDeleted(entry.id, entry.updatedAt, now);
					applied += 1;
					continue;
				}
				this.overwrite(entry, now);
				applied += 1;
				continue;
			}

			if (entry.updatedAt === existing.updatedAt) {
				if (entry.deleted && !existing.deleted) {
					this.markDeleted(entry.id, entry.updatedAt, now);
					applied += 1;
					continue;
				}
				if (entry.deleted || sameContent(existing, entry)) {
					skipped += 1;
					continue;
				}
				// 同一毫秒、内容不同：手机是权威 → 取上行，但留一行日志（正常不会发生）
				console.log(`[diary] ${entry.id} 同毫秒内容不一致，按手机版本覆盖`);
				this.overwrite(entry, now);
				applied += 1;
				continue;
			}

			// 上行更旧：镜像不动，把胜出的一行回给客户端（客户端按 updatedAt 覆盖本地）
			conflicts.set(existing.id, toWire(existing));
			skipped += 1;
		}

		const since = asMillis(input.since, 0);
		const rows = this.db
			.prepare(
				`SELECT * FROM diary_entries WHERE updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT ?`,
			)
			.all(since, MAX_ROWS_PER_RESPONSE) as Row[];

		const out = new Map<string, DiaryEntryWire>();
		for (const row of rows) {
			const wire = toWire(rowToEntry(row));
			out.set(wire.id, wire);
		}
		// 冲突行无论 since 都要回（它们是"这次上行被拒"的直接结果）
		for (const [id, wire] of conflicts) out.set(id, wire);

		const entries = [...out.values()].slice(0, MAX_ROWS_PER_RESPONSE);
		// 日志只记条数与毫秒，**不记正文**（这里是日记原文，比对话还私密）
		console.log(
			`[diary] sync in=${incoming.length} applied=${applied} skipped=${skipped} ` +
				`out=${entries.length} since=${since} total=${this.count()}`,
		);
		return { entries, serverTime: now };
	}

	private insert(entry: InternalEntry, now: number): void {
		this.db
			.prepare(
				`INSERT INTO diary_entries (
					id, status, source, local_source, entry_date, final_text, raw_snapshot,
					types, mood, created_at, updated_at, deleted, conversation_id, mirrored_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				entry.id,
				entry.status,
				entry.source,
				entry.localSource,
				entry.entryDate,
				entry.finalText,
				entry.rawSnapshot,
				JSON.stringify(entry.types),
				entry.mood,
				entry.createdAt,
				entry.updatedAt,
				entry.deleted ? 1 : 0,
				entry.conversationId,
				now,
			);
	}

	/** 上行更新：本地是权威，正文/类型/心情/时间戳整体覆盖（`local_source` 等带上） */
	private overwrite(entry: InternalEntry, now: number): void {
		this.db
			.prepare(
				`UPDATE diary_entries SET
					status = ?, source = ?, local_source = ?, entry_date = ?, final_text = ?,
					raw_snapshot = ?, types = ?, mood = ?, created_at = ?, updated_at = ?,
					deleted = ?, conversation_id = ?, mirrored_at = ?
				 WHERE id = ?`,
			)
			.run(
				entry.status,
				entry.source,
				entry.localSource,
				entry.entryDate,
				entry.finalText,
				entry.rawSnapshot,
				JSON.stringify(entry.types),
				entry.mood,
				entry.createdAt,
				entry.updatedAt,
				entry.deleted ? 1 : 0,
				entry.conversationId,
				now,
				entry.id,
			);
	}

	/** 软删：**保留已有正文**，只置标记与更新时间（后期要分析"写过又删了"） */
	private markDeleted(id: string, deletedAt: number, now: number): void {
		this.db
			.prepare("UPDATE diary_entries SET deleted = 1, updated_at = ?, mirrored_at = ? WHERE id = ?")
			.run(deletedAt, now, id);
	}

	close(): void {
		this.db.close();
	}
}

let store: DiaryStore | null = null;

/** 懒建：进程启动时不碰磁盘（与配对存储同一纪律） */
export function diaryStore(): DiaryStore {
	if (!store) {
		store = new DiaryStore(process.env.DIARY_DB_PATH?.trim() || DEFAULT_DB_PATH);
	}
	return store;
}

export function mountDiary(app: Hono): void {
	/**
	 * `POST /api/v1/diary/sync` —— 手机 → 镜像的上行增量 + 镜像 → 手机的下行增量，一次请求完成。
	 *
	 * 幂等：按 entry id 对齐，同一份数据重发不会产生第二行、也不会把软删改回来。
	 * 鉴权走全局 `/api/v1/*` 中间件（共享令牌 ∪ 设备凭据；403 空体）。
	 */
	app.post("/api/v1/diary/sync", async (c) => {
		// 到这一行说明已经过鉴权：手机连不上/令牌不对时**不会有这条日志**，
		// 排障时"服务端一行都没打"本身就是结论（问题在客户端或网络，不在这里）。
		console.log("[diary] 收到同步请求");
		const body = (await c.req.json().catch(() => null)) as DiarySyncRequest | null;
		if (!body || typeof body !== "object") {
			console.log("[diary] 拒绝：请求体不是 JSON");
			return c.json({ error: "bad_request" }, 400);
		}
		try {
			return c.json(diaryStore().sync(body));
		} catch (error) {
			// 库写失败只回 500：手机侧一律静默重试（不让"同步崩了"打扰写日记的人）
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[diary] 同步失败: ${detail}`);
			return c.json({ error: "diary_store_failed" }, 500);
		}
	});

	/** 只读自检：条数 + 最近几条的元数据（**不含正文**，防止被随手当接口读全文） */
	app.get("/api/v1/diary/status", (c) => {
		try {
			const items = diaryStore().list(20).map((entry) => ({
				id: entry.id,
				status: entry.status,
				source: entry.source,
				localSource: entry.localSource,
				entryDate: entry.entryDate,
				updatedAt: entry.updatedAt,
				deleted: entry.deleted,
				chars: entry.finalText?.length ?? 0,
			}));
			return c.json({ count: diaryStore().count(), items });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[diary] 自检失败: ${detail}`);
			return c.json({ error: "diary_store_failed" }, 500);
		}
	});
}
