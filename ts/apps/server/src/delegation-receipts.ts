import { createHash, randomUUID } from "node:crypto";
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
 *
 * 2026-11-05 批次A A2 补差（DS-Bot requests.js 的教训）：
 *   - 回执行带 `boot_id`（进程代号）：**上个进程留下的 accepting 一律按 uncertain 处理**——
 *     本进程无法确认那次受理到底发没发出去，宁可让人重提，不可自动重派造成重复副作用；
 *   - 同库新增 `delegation_dead_letters` 死信表：父单已终态后子单结果无处并入时记账
 *     （不丢、不自动并入、可查），写入方在恢复扫描（recovery-report.ts 的调用方）。
 */

const DEFAULT_DB_PATH = ".data/delegations.sqlite";

/** 进程代号：模块加载期定一次。重启即换新，用于判定"回执是不是本进程落的"。 */
const BOOT_ID = randomUUID();

export type ReceiptOutcome = "accepting" | "accepted" | "uncertain" | "failed";

export interface DelegationReceipt {
	requestId: string;
	fingerprint: string;
	/** accepting 时可能还是空串：回执先落，单号随受理补上。 */
	ticketId: string;
	/** 受理时的内部会话 id（A3a）。旧行没有这条信息，永远是 null。 */
	conversationId: number | null;
	/** 落这行状态时的进程代号（A2 补差）。旧行/NULL 一律视为"别的进程落的"。 */
	bootId: string | null;
	outcome: ReceiptOutcome;
	createdAt: string;
	updatedAt: string;
}

/** 迟到子单的死信记录（A2 补差）：只增不改，主键幂等。 */
export interface DelegationDeadLetter {
	parentTicketId: string;
	childTicketId: string;
	childStatus: string;
	note: string;
	createdAt: string;
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
		this.migrate();
	}

	/** 旧库补列（A3a 会话映射、A2 boot 代号）：旧行补不上信息，永远按 NULL 处理。 */
	private migrate(): void {
		const columns = this.db.prepare("PRAGMA table_info(delegation_receipts)").all() as Array<{
			name?: unknown;
		}>;
		if (!columns.some((column) => column.name === "conversation_id")) {
			this.db.exec("ALTER TABLE delegation_receipts ADD COLUMN conversation_id INTEGER");
		}
		if (!columns.some((column) => column.name === "boot_id")) {
			this.db.exec("ALTER TABLE delegation_receipts ADD COLUMN boot_id TEXT");
		}
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_delegation_receipts_ticket ON delegation_receipts(ticket_id);",
		);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS delegation_dead_letters (
				parent_ticket_id TEXT NOT NULL,
				child_ticket_id TEXT NOT NULL,
				child_status TEXT NOT NULL,
				note TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL,
				PRIMARY KEY (parent_ticket_id, child_ticket_id)
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
	 * 按任务单号反查受理回执（A3a 存下的 ticketId → 会话映射）。
	 *
	 * @internal A3b（恢复回灌）专用，当前无生产调用方。
	 */
	lookupByTicket(ticketId: string): DelegationReceipt | null {
		// 同一单号被重新受理时取最后写入的那条（同毫秒并列看 rowid）
		const row = this.db
			.prepare(
				"SELECT * FROM delegation_receipts WHERE ticket_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
			)
			.get(ticketId) as Record<string, unknown> | undefined;
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
		if (
			existing.outcome === "accepting" &&
			(existing.ticketId === "" || existing.bootId !== BOOT_ID)
		) {
			// 发送中就崩了：单号未知，或这行 accepting 是**别的进程**落的（boot 代号对不上）——
			// 本进程都无法确认那次受理是否真的发出去了，按方案归 uncertain，不自动重派。
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

	/**
	 * 受理成功：单号与（可选的）会话映射一起落库。
	 *
	 * `DELEGATION_MAP_PERSIST=false` 时不写 `conversation_id`（A3a 回滚开关）。
	 * 每次调用都读 env，不在构造函数里缓存 —— 这样单测能在同一进程里切开关。
	 */
	accept(requestId: string, ticketId: string, conversationId?: number): void {
		const now = new Date().toISOString();
		// 判 `undefined` 而不是 truthy：会话 id 是自增整数，0 也是合法值
		if (conversationId !== undefined && mapPersistEnabled()) {
			this.db
				.prepare(
					"UPDATE delegation_receipts SET ticket_id = ?, outcome = 'accepted', conversation_id = ?, boot_id = ?, updated_at = ? WHERE request_id = ?",
				)
				.run(ticketId, conversationId, BOOT_ID, now, requestId);
			return;
		}
		this.db
			.prepare(
				"UPDATE delegation_receipts SET ticket_id = ?, outcome = 'accepted', boot_id = ?, updated_at = ? WHERE request_id = ?",
			)
			.run(ticketId, BOOT_ID, now, requestId);
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
				"INSERT INTO delegation_receipts (request_id, ticket_id, fingerprint, outcome, boot_id, created_at, updated_at) VALUES (?, '', ?, 'accepting', ?, ?, ?)",
			)
			.run(requestId, fingerprint, BOOT_ID, now, now);
	}

	private reinsert(requestId: string, fingerprint: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				"UPDATE delegation_receipts SET ticket_id = '', fingerprint = ?, outcome = 'accepting', boot_id = ?, updated_at = ? WHERE request_id = ?",
			)
			.run(fingerprint, BOOT_ID, now, requestId);
	}

	// ── 死信（A2 补差）────────────────────────────────────
	/**
	 * 记一条迟到子单死信。主键幂等：重复扫描同一条只落一次，返回是否真的新插入。
	 * 死信**只增不改**：它记的是"结果无处可去"这个事实，怎么处置是人看完再定的事。
	 */
	recordDeadLetter(
		entry: { parentTicketId: string; childTicketId: string; childStatus: string; note: string },
	): boolean {
		const result = this.db
			.prepare(
				"INSERT OR IGNORE INTO delegation_dead_letters (parent_ticket_id, child_ticket_id, child_status, note, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				entry.parentTicketId,
				entry.childTicketId,
				entry.childStatus,
				entry.note,
				new Date().toISOString(),
			);
		return Number(result.changes) > 0;
	}

	listDeadLetters(parentTicketId: string): DelegationDeadLetter[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM delegation_dead_letters WHERE parent_ticket_id = ? ORDER BY created_at",
			)
			.all(parentTicketId) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			parentTicketId: text(row.parent_ticket_id),
			childTicketId: text(row.child_ticket_id),
			childStatus: text(row.child_status),
			note: text(row.note),
			createdAt: text(row.created_at),
		}));
	}
}

function toReceipt(row: Record<string, unknown>): DelegationReceipt {
	return {
		requestId: text(row.request_id),
		ticketId: text(row.ticket_id),
		fingerprint: text(row.fingerprint),
		conversationId:
			row.conversation_id === null || row.conversation_id === undefined
				? null
				: Number(row.conversation_id),
		bootId: row.boot_id === null || row.boot_id === undefined ? null : text(row.boot_id) || null,
		outcome: (text(row.outcome) as ReceiptOutcome) || "accepting",
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at),
	};
}

/** A3a 回滚开关：只有显式 "false" 才关；不配 = 落库。 */
function mapPersistEnabled(): boolean {
	return (process.env.DELEGATION_MAP_PERSIST?.trim() || "true").toLowerCase() !== "false";
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
