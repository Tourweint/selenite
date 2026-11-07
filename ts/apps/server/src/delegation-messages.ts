import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 派活留言（2026-11-07）。
 *
 * 存在的理由：现在总管派活走的是 `spawn --requirement=<原文>`，需求只是
 * `ticket.json.prompt` 里的一段裸文本——**看不出是谁发的、什么时候发的**，
 * 更没有一个"这是一条对我说的话"的位置。用户打开任务时想要的是"总管说过什么"，
 * 拿到的却是一段孤立的需求描述。
 *
 * 这里把派活落成**一条留言**（发送者 + 时间 + 正文），与 cindy 的
 * `[From Orca Lead]` 是同一个心智，只是不试图改 chancellor 的 CLI：
 * 那条链路是跨仓契约，而且 CLI 承载不了"会话"这个概念。
 *
 * 刻意不做：不伪造 `pi.user` 进任务会话（任务不是会话，见设计方案）。
 * 留言是**旁路记录**，只读展示，不改变派单语义。
 *
 * 与回执/死信同库（`delegations.sqlite`）：同一类簿记，少一个文件、少一处备份。
 */

const DEFAULT_DB_PATH = ".data/delegations.sqlite";

/** 一条留言的方向：out = 派出去的话，in = 交回来的结论，system = 过程里的机动说明。 */
export type DelegationMessageDirection = "out" | "in" | "system";

/** 发送者类型。worker 只出现在 in（结论由谁交回）。 */
export type DelegationSenderKind = "chief" | "partner" | "worker" | "system";

export interface DelegationMessage {
	ticketId: string;
	direction: DelegationMessageDirection;
	fromKind: DelegationSenderKind;
	/** 展示名（总管 / 执事名 / worker 的 slug）；system 可为空。 */
	fromName: string;
	body: string;
	createdAt: string;
}

/** 单条正文上限：派活原文本来就由 chancellor 限长，这里再兜一层防表被撑爆。 */
const BODY_LIMIT = 20_000;

export class DelegationMessages {
	private readonly db: DatabaseSync;

	constructor(path: string = process.env.DELEGATIONS_DB_PATH?.trim() || DEFAULT_DB_PATH) {
		mkdirSync(dirname(resolve(path)), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS delegation_messages (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				ticket_id  TEXT NOT NULL,
				direction  TEXT NOT NULL,
				from_kind  TEXT NOT NULL,
				from_name  TEXT NOT NULL DEFAULT '',
				body       TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_delegation_messages_ticket
				ON delegation_messages (ticket_id, id);
		`);
	}

	/**
	 * 追加一条留言。
	 *
	 * 幂等口径：**不做去重**。同一次派单可能先落"受理中"再落"单号已定"，
	 * 那本来就是两条不同时刻的簿记；读侧按 id 排序原样展示。
	 * 写失败只抛给调用方决定——宿主的派单主链路不该因为簿记失败而中断，
	 * 所以 `delegation.ts` 那边是 catch 后告警，不是让派单失败。
	 */
	append(message: DelegationMessage): void {
		this.db
			.prepare(
				`INSERT INTO delegation_messages
				 (ticket_id, direction, from_kind, from_name, body, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				message.ticketId,
				message.direction,
				message.fromKind,
				message.fromName.slice(0, 120),
				message.body.slice(0, BODY_LIMIT),
				message.createdAt,
			);
	}

	/** 一张单的全部留言，按落库顺序（先进先出）。没有记录 = 空数组，不是错误。 */
	list(ticketId: string): DelegationMessage[] {
		const rows = this.db
			.prepare(
				`SELECT ticket_id, direction, from_kind, from_name, body, created_at
				 FROM delegation_messages WHERE ticket_id = ? ORDER BY id`,
			)
			.all(ticketId) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			ticketId: String(row.ticket_id ?? ""),
			direction: String(row.direction ?? "out") as DelegationMessageDirection,
			fromKind: String(row.from_kind ?? "system") as DelegationSenderKind,
			fromName: String(row.from_name ?? ""),
			body: String(row.body ?? ""),
			createdAt: String(row.created_at ?? ""),
		}));
	}

	close(): void {
		this.db.close();
	}
}

/** 进程内单例：留言是纯追加簿记，不需要每次请求重开库。 */
let shared: DelegationMessages | null = null;

export function delegationMessages(): DelegationMessages {
	shared ??= new DelegationMessages();
	return shared;
}

/** 测试/探针用：换一个落点（例如临时目录）。传入 null 表示回到默认单例。 */
export function resetDelegationMessages(path?: string): void {
	if (shared) {
		shared.close();
		shared = null;
	}
	if (path !== undefined) shared = new DelegationMessages(path);
}
