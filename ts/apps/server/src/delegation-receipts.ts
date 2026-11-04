import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 派单回执（2026-11-03 方案 §5.1）。
 *
 * `requestId` 是派活的幂等键：受理时先落回执再入队，重启后同一个 id 只返回原单号。
 * 回执跟任务单生命周期绑定：显式 id 永远返回原单；自动 id 只在原单未终态时复用，
 * 终态后允许用户再提同样的需求。
 *
 * 存独立 SQLite（`.data/delegations.sqlite`）：和 projects 一样，不混进会话库。
 */

const DEFAULT_DB_PATH = ".data/delegations.sqlite";

export type ReceiptOutcome = "accepting" | "accepted" | "uncertain" | "failed";

export interface DelegationReceipt {
	requestId: string;
	fingerprint: string;
	/** accepting 时可能还是空串：回执先落，单号随受理补上。 */
	ticketId: string;
	outcome: ReceiptOutcome;
	createdAt: string;
	updatedAt: string;
}

export interface ReceiptBegin {
	kind: "new" | "existing" | "conflict" | "uncertain";
	receipt?: DelegationReceipt;
}

const TERMINAL_TICKET_STATUS = new Set([
	"done",
	"needs_you",
	"failed",
	"idle",
	"aborted",
]);

export class DelegationReceipts {
	private readonly db: DatabaseSync;

	constructor(path: string = process.env.DELEGATIONS_DB_PATH?.trim() || DEFAULT_DB_PATH) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS delegation_receipts (
				request_id TEXT PRIMARY KEY,
				ticket_id TEXT NOT NULL DEFAULT '',
				fingerprint TEXT NOT NULL,
				outcome TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
	}

	close(): void {
		this.db.close();
	}

	lookup(requestId: string): DelegationReceipt | null {
		const row = this.db
			.prepare("SELECT * FROM delegation_receipts WHERE request_id = ?")
			.get(requestId) as Record<string, unknown> | undefined;
		return row ? toReceipt(row) : null;
	}

	/**
	 * 受理前调用。返回 new 表示可以继续派；existing / uncertain / conflict 都必须直接回话。
	 * `explicit` 决定「原单已终态后能不能再用同一个 id 派新活」。
	 */
	begin(
		requestId: string,
		fingerprint: string,
		opts: { explicit: boolean; workRoot?: string },
	): ReceiptBegin {
		const existing = this.lookup(requestId);
		if (!existing) {
			this.insert(requestId, fingerprint);
			return { kind: "new" };
		}
		if (existing.fingerprint !== fingerprint) {
			return { kind: "conflict", receipt: existing };
		}
		if (existing.outcome === "uncertain") {
			return { kind: "uncertain", receipt: existing };
		}
		if (existing.outcome === "accepting" && existing.ticketId === "") {
			// 发送中就崩了：单号未知，按方案归到 uncertain，不自动重派。
			this.setOutcome(requestId, "uncertain");
			return { kind: "uncertain", receipt: { ...existing, outcome: "uncertain" } };
		}
		if (opts.explicit) return { kind: "existing", receipt: existing };
		if (existing.ticketId && isTicketOpen(opts.workRoot, existing.ticketId)) {
			return { kind: "existing", receipt: existing };
		}
		if (!existing.ticketId) {
			return { kind: "existing", receipt: existing };
		}
		// 自动 id：原单已经终态，允许重新派，回执改指向新单。
		this.reinsert(requestId, fingerprint);
		return { kind: "new", receipt: existing };
	}

	accept(requestId: string, ticketId: string): void {
		this.db
			.prepare(
				"UPDATE delegation_receipts SET ticket_id = ?, outcome = 'accepted', updated_at = ? WHERE request_id = ?",
			)
			.run(ticketId, new Date().toISOString(), requestId);
	}

	/** 失败且没拿到单号 → uncertain；拿到单号 → failed（显式 id 仍返回原单）。 */
	markFailed(requestId: string): void {
		const existing = this.lookup(requestId);
		if (!existing) return;
		this.setOutcome(requestId, existing.ticketId ? "failed" : "uncertain");
	}

	private setOutcome(requestId: string, outcome: ReceiptOutcome): void {
		this.db
			.prepare("UPDATE delegation_receipts SET outcome = ?, updated_at = ? WHERE request_id = ?")
			.run(outcome, new Date().toISOString(), requestId);
	}

	private insert(requestId: string, fingerprint: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO delegation_receipts (request_id, ticket_id, fingerprint, outcome, created_at, updated_at) VALUES (?, '', ?, 'accepting', ?, ?)",
			)
			.run(requestId, fingerprint, now, now);
	}

	private reinsert(requestId: string, fingerprint: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				"UPDATE delegation_receipts SET ticket_id = '', fingerprint = ?, outcome = 'accepting', updated_at = ? WHERE request_id = ?",
			)
			.run(fingerprint, now, requestId);
	}
}

function toReceipt(row: Record<string, unknown>): DelegationReceipt {
	return {
		requestId: text(row.request_id),
		ticketId: text(row.ticket_id),
		fingerprint: text(row.fingerprint),
		outcome: (text(row.outcome) as ReceiptOutcome) || "accepting",
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at),
	};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** 自动 id：同一会话 + 同一需求指纹；工具 API 没有「本轮」标识，这是能做到的最稳口径。 */
export function autoRequestId(conversationId: number, requirement: string): string {
	return `auto-${fingerprintOf({ conversationId, requirement })}`;
}

export function requestFingerprint(parts: Record<string, unknown>): string {
	return fingerprintOf(parts);
}

function fingerprintOf(parts: Record<string, unknown>): string {
	return createHash("sha256")
		.update(JSON.stringify(parts))
		.digest("hex")
		.slice(0, 32);
}

function isTicketOpen(workRoot: string | undefined, ticketId: string): boolean {
	if (!workRoot) return true;
	const file = join(resolve(workRoot), ticketId, "ticket.json");
	if (!existsSync(file)) return false;
	try {
		const ticket = JSON.parse(readFileSync(file, "utf8")) as { status?: unknown };
		return !TERMINAL_TICKET_STATUS.has(String(ticket.status ?? ""));
	} catch {
		return false;
	}
}
