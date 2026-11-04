import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatEvent } from "@lifediary/shared";

/**
 * 会话事件重放库（2026-11-04，SSE seq 与断点重放方案）。
 *
 * 聊天 SSE 的每一帧在**外发之前**先落这里（persist-before-publish），
 * 客户端断线重连后带 `sinceSeq` 来补缺帧。它不是审计日志：每会话只留
 * 最近 KEEP 条（默认 500，`AGENT_SSE_SEQ_KEEP` 可调），超出就滑掉——
 * 补帧窗口外的客户端靠 `fromSeq` 发现要全量重建，不假装能补。
 *
 * 存独立 SQLite（`.data/chat-events.sqlite`）：跟回执库/项目库同一个先例，
 * 不混进会话库——这张表写得多、滑得快，跟 durable 的会话记录生命周期不同。
 * 会话以**内部自增 id** 为键（不外泄），对外路径已由调用方换算好。
 */

const DEFAULT_DB_PATH = ".data/chat-events.sqlite";

/** 每会话保留的事件条数。500 ≈ 一次长跑轮（delta 逐字）+ 审批等待绰绰有余。 */
const DEFAULT_KEEP = 500;

export function sseSeqEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_SSE_SEQ?.trim() || "on").toLowerCase() !== "off";
}

export function sseSeqKeep(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.AGENT_SSE_SEQ_KEEP?.trim());
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_KEEP;
}

export class ChatEventStore {
	private readonly db: DatabaseSync;
	private readonly keep: number;

	constructor(
		path: string = process.env.AGENT_SSE_SEQ_DB_PATH?.trim() || DEFAULT_DB_PATH,
		keep: number = sseSeqKeep(),
	) {
		mkdirSync(dirname(resolve(path)), { recursive: true });
		this.db = new DatabaseSync(path);
		this.keep = keep;
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS chat_events (
				internal_id INTEGER NOT NULL,
				seq INTEGER NOT NULL,
				event_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (internal_id, seq)
			);
			CREATE INDEX IF NOT EXISTS idx_chat_events_seq ON chat_events (internal_id, seq);
		`);
	}

	/** 该会话下一个序号。空会话从 1 起。 */
	nextSeq(internalId: number): number {
		const row = this.db
			.prepare("SELECT MAX(seq) AS max_seq FROM chat_events WHERE internal_id = ?")
			.get(internalId) as { max_seq: number | null } | undefined;
		return (row?.max_seq ?? 0) + 1;
	}

	/**
	 * 落一帧。调用方必须在拿到 seq 之后、外发之前调它；
	 * 这里抛错就让外发不发生——宁可客户端重拉，不发"承诺过却补不回来"的帧。
	 */
	append(internalId: number, seq: number, event: ChatEvent): void {
		this.db
			.prepare(
				"INSERT INTO chat_events (internal_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(internalId, seq, JSON.stringify(event), new Date().toISOString());
		// 滑窗：只对本会话删多余的。KeySet 分页太重，500 条内的 DELETE 每帧一次可接受。
		this.db
			.prepare(
				`DELETE FROM chat_events
				 WHERE internal_id = ? AND seq <= (SELECT MAX(seq) FROM chat_events WHERE internal_id = ?) - ?`,
			)
			.run(internalId, internalId, this.keep);
	}

	/**
	 * 重放 seq > since 的已落库帧。`from` 是**重放第一条的真实 seq**
	 * （一条都没有时 = since+1，表示"一条不缺"）。客户端判据：
	 * `from > since + 1` 说明中间有缺口——可能是滑窗已把缺的那段滑掉，
	 * 不能只补，要全量重建。事件包成 `{ event }`（shared 的 ReplayEvent 口径），
	 * 将来加重放元信息（如落库时间）不用再改响应形状。
	 */
	replaySince(
		internalId: number,
		since: number,
	): { from: number; events: { event: ChatEvent }[] } {
		const rows = this.db
			.prepare(
				"SELECT seq, event_json FROM chat_events WHERE internal_id = ? AND seq > ? ORDER BY seq ASC",
			)
			.all(internalId, since) as { seq: number; event_json: string }[];
		const events: { event: ChatEvent }[] = [];
		for (const row of rows) {
			try {
				events.push({ event: JSON.parse(row.event_json) as ChatEvent });
			} catch {
				// 落库时就是合法 JSON，这里只为类型安全兜底；跳过坏行，不中断重放。
			}
		}
		return { from: events.length > 0 ? rows[0].seq : since + 1, events };
	}

	/** 关库（测试清理用；照 delegation-receipts 的先例）。 */
	close(): void {
		this.db.close();
	}
}
