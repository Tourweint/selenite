import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PlannedTask, Review, Task, Ticket, TicketStatus } from "./types.ts";

export interface TicketRow {
  id: string;
  prompt: string;
  status: string;
  created_at: string;
  total: number;
  passed: number;
  /** 这单用的雇员：优先 task 实际雇员；分管单没有 task，取 tickets.employee。老数据可能为 null。 */
  employee: string | null;
}

export interface FileEntry {
  path: string;
  size: number;
}

/** 进度落盘只收这三样；不给的字段沿用当前值（`waitingOn: null` 表示明确清掉）。 */
export interface TicketProgress {
  action?: string;
  waitingOn?: string | null;
  heartbeat?: string;
}

/** 心跳类更新的最小落盘间隔；动作或等待对象变了则立刻写。 */
const PROGRESS_WRITE_MS = 10_000;

/**
 * 执行前快照的文件名（2026-11-04）：落在每个 task 目录里，崩溃恢复按 ticketId/seq 读回。
 * 放在这里是为了让 shell 与 isolation、review 共用同一个名字，避免三处各写一份字符串。
 */
export const SNAPSHOT_FILE = "snapshot-before.json";

const TERMINAL_STATUSES = new Set<TicketStatus>([
  "done",
  "needs_you",
  "idle",
  "failed",
  "aborted",
]);

/** 这些终态不会再沿用执行前快照续跑，可以把残留的快照清掉。needs_you / idle 留给续跑。 */
const NON_RESUMABLE_STATUSES = new Set<TicketStatus>(["done", "failed", "aborted"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  employee TEXT,
  error TEXT,
  idempotency_key TEXT,
  parent_ticket_id TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  ticket_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  dir TEXT NOT NULL,
  status TEXT NOT NULL,
  employee TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, seq)
);
CREATE TABLE IF NOT EXISTS reviews (
  ticket_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  slug TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  stage TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, seq)
);
`;

/**
 * sqlite 只是索引，runs/ 下的明文文件才是事实源。
 * 每次运行的 workRoot 独立，db 放在 workRoot 同级的 data/ 下，避免全局状态。
 */
export class Store {
  readonly workRoot: string;
  readonly dataDir: string;
  readonly dbPath: string;
  private db: DatabaseSync | null = null;
  /** 每张单上次写进度的时刻/内容，用来判断能不能跳过这次心跳。 */
  private progressWrites = new Map<
    string,
    { at: number; action: string; waitingOn: string | null }
  >();

  constructor(workRoot: string) {
    this.workRoot = path.resolve(workRoot);
    this.dataDir = path.join(path.dirname(this.workRoot), "data");
    this.dbPath = path.join(this.dataDir, "chancellor.db");
  }

  ticketDir(ticketId: string): string {
    return path.join(this.workRoot, ticketId);
  }

  /** 释放 sqlite 句柄。只读接口每次请求开一个库，不关会在长跑进程里泄漏句柄。 */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  saveTicket(ticket: Ticket): void {
    writeJson(path.join(this.ticketDir(ticket.id), "ticket.json"), ticket);
    this.conn()
      .prepare(
        `INSERT INTO tickets (id, prompt, status, created_at, updated_at, employee, error, idempotency_key, parent_ticket_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           prompt = excluded.prompt,
           status = excluded.status,
           updated_at = excluded.updated_at,
           employee = excluded.employee,
           error = excluded.error,
           idempotency_key = excluded.idempotency_key,
           parent_ticket_id = excluded.parent_ticket_id`,
      )
      .run(
        ticket.id,
        ticket.prompt,
        ticket.status,
        ticket.created_at,
        ticket.updated_at,
        ticket.employee ?? null,
        ticket.error ?? null,
        ticket.idempotencyKey ?? null,
        ticket.parentTicketId ?? null,
      );
  }

  setTicketStatus(ticket: Ticket, status: TicketStatus, error?: string | null): void {
    ticket.status = status;
    ticket.updated_at = new Date().toISOString();
    // 状态变化也算一次活动：重启后看板据此判断这单最后动过没有。
    ticket.lastHeartbeat = ticket.updated_at;
    if (error === null) delete ticket.error;
    else if (error !== undefined) ticket.error = error;
    this.saveTicket(ticket);
    // 到终态就不再有「进行中的这单」；崩溃恢复只认还留着的 inflight.json。
    if (TERMINAL_STATUSES.has(status)) {
      fs.rmSync(path.join(this.ticketDir(ticket.id), "inflight.json"), { force: true });
    }
    // 不会再续跑的终态把 task 目录里的执行前快照一并清掉；needs_you / idle 要留给续跑。
    if (NON_RESUMABLE_STATUSES.has(status)) clearTaskSnapshots(this.ticketDir(ticket.id));
  }

  /**
   * 进度落盘（2026-11-04）：看板与详情要看到「最近动作 / 心跳 / 等哪个文件」，
   * 重启后也能从 ticket.json 读到。只写明文，不动 sqlite 的 updated_at ——
   * 这三项是展示用的近况，不是索引字段，也不该打乱列表顺序。
   * 动作或等待对象变了立刻写；只有心跳在变时最多每 `PROGRESS_WRITE_MS` 写一次。
   */
  saveTicketProgress(ticket: Ticket, progress: TicketProgress): void {
    const now = Date.now();
    const action = (progress.action ?? ticket.lastAction ?? "").trim();
    const waitingOn =
      progress.waitingOn === undefined
        ? (ticket.waitingOn ?? null)
        : (progress.waitingOn?.trim() || null);
    const changed =
      action !== (ticket.lastAction ?? "") || waitingOn !== (ticket.waitingOn ?? null);

    if (action !== "") ticket.lastAction = action;
    if (waitingOn === null) delete ticket.waitingOn;
    else ticket.waitingOn = waitingOn;
    ticket.lastHeartbeat = progress.heartbeat ?? new Date(now).toISOString();

    const last = this.progressWrites.get(ticket.id);
    if (!changed && last && now - last.at < PROGRESS_WRITE_MS) return;
    this.progressWrites.set(ticket.id, {
      at: now,
      action: ticket.lastAction ?? "",
      waitingOn: ticket.waitingOn ?? null,
    });
    writeJson(path.join(this.ticketDir(ticket.id), "ticket.json"), ticket);
  }

  /**
   * 返工轮重跑前清掉上一轮的任务行与验收行（2026-11-09 §1）。
   * 明文任务目录由 index.ts 归档；这里只清 sqlite 索引，否则新计划任务数变少时
   * 详情会混进上一轮的残留行。ticket 行不动（同一张单）。
   */
  resetRoundRows(ticketId: string): void {
    this.conn().prepare("DELETE FROM tasks WHERE ticket_id = ?").run(ticketId);
    this.conn().prepare("DELETE FROM reviews WHERE ticket_id = ?").run(ticketId);
  }

  saveTask(task: Task): void {    this.conn()
      .prepare(
        `INSERT INTO tasks (ticket_id, seq, slug, title, dir, status, employee, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, seq) DO UPDATE SET
           slug = excluded.slug,
           title = excluded.title,
           dir = excluded.dir,
           status = excluded.status,
           employee = excluded.employee,
           updated_at = excluded.updated_at`,
      )
      .run(
        task.ticket_id,
        task.seq,
        task.slug,
        task.title,
        task.dir,
        task.status,
        task.employee,
        task.updated_at,
      );
  }

  saveReview(review: Review): void {
    this.conn()
      .prepare(
        `INSERT INTO reviews (ticket_id, seq, slug, verdict, reason, stage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, seq) DO UPDATE SET
           slug = excluded.slug,
           verdict = excluded.verdict,
           reason = excluded.reason,
           stage = excluded.stage,
           created_at = excluded.created_at`,
      )
      .run(
        review.ticket_id,
        review.seq,
        review.slug,
        review.verdict,
        review.reason,
        review.stage,
        new Date().toISOString(),
      );
  }

  /**
   * 按幂等 key 找已有单。sqlite 是索引，runs/ 明文才是事实源：
   * 索引里没有时扫一遍 ticket.json，找到就顺手补进索引。
   */
  ticketIdByIdempotencyKey(key: string): string | null {
    const row = this.conn()
      .prepare("SELECT id FROM tickets WHERE idempotency_key = ? LIMIT 1")
      .get(key) as { id: string } | undefined;
    if (row?.id) return row.id;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.workRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const ticket = readJson<Ticket>(path.join(this.workRoot, entry.name, "ticket.json"));
      if (!ticket || ticket.idempotencyKey !== key) continue;
      this.saveTicket(ticket);
      return ticket.id;
    }
    return null;
  }

  listTickets(limit = 20): TicketRow[] {    const rows = this.conn()
      .prepare(
        `SELECT t.id, t.prompt, t.status, t.created_at,
           (SELECT COUNT(*) FROM tasks x WHERE x.ticket_id = t.id) AS total,
           (SELECT COUNT(*) FROM tasks x WHERE x.ticket_id = t.id AND x.status = 'passed') AS passed,
           COALESCE(
             (SELECT GROUP_CONCAT(DISTINCT x.employee) FROM tasks x WHERE x.ticket_id = t.id),
             t.employee
           ) AS employee
         FROM tickets t
         ORDER BY t.created_at DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows as unknown as TicketRow[];
  }

  tasksOf(ticketId: string): Task[] {
    const rows = this.conn()
      .prepare("SELECT * FROM tasks WHERE ticket_id = ? ORDER BY seq")
      .all(ticketId);
    return rows as unknown as Task[];
  }

  /**
   * 这张单所有的直接子单。父单完成闸门用它判断子任务是否全终态：
   * 子单必须记 `parentTicketId`，否则父单看不到它。
   */
  childrenOf(parentTicketId: string): Ticket[] {
    const rows = this.conn()
      .prepare("SELECT id FROM tickets WHERE parent_ticket_id = ? ORDER BY created_at")
      .all(parentTicketId) as Array<{ id?: unknown }>;
    const tickets: Ticket[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string") continue;
      const ticket = readJson<Ticket>(path.join(this.ticketDir(row.id), "ticket.json"));
      if (ticket) tickets.push(ticket);
    }
    return tickets;
  }

  reviewsOf(ticketId: string): Review[] {
    const rows = this.conn()
      .prepare("SELECT * FROM reviews WHERE ticket_id = ? ORDER BY seq")
      .all(ticketId);
    return rows as unknown as Review[];
  }

  /** db 丢了或为空时，从 runs/ 的明文记录重建索引。 */
  ensureIndex(): void {
    const db = this.conn();
    const row = db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as
      | { n: number }
      | undefined;
    if ((row?.n ?? 0) > 0) return;
    this.rebuildIndex(db);
  }

  private conn(): DatabaseSync {
    if (this.db) return this.db;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    // 并发写不立刻抛 "database is locked"（2026-11-09 实测：tsx --test 并发跑多个
    // 测试文件时，同一 runs 目录的 sqlite 会撞锁，跑三次错一次）。
    // busy_timeout = 等 5 秒再放弃；WAL 让读写不互斥。两者都是幂等的，
    // 每次连接设一遍不重复开销。
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    this.migrate(db);
    this.db = db;
    return db;
  }

  /** v0.3 起 tasks 多了 employee；v0.4 起 tickets 也有。老库补列，老行保持 NULL。 */
  private migrate(db: DatabaseSync): void {
    this.addColumnIfMissing(db, "tasks", "employee");
    this.addColumnIfMissing(db, "tickets", "employee");
    this.addColumnIfMissing(db, "tickets", "idempotency_key");
    this.addColumnIfMissing(db, "tickets", "parent_ticket_id");
    // 同一个 key 只能落一张单；老行都是 NULL，不受唯一约束影响。
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_idempotency
       ON tickets(idempotency_key) WHERE idempotency_key IS NOT NULL`,
    );
  }

  private addColumnIfMissing(db: DatabaseSync, table: string, column: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name?: unknown;
    }>;
    if (!columns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }

  private rebuildIndex(db: DatabaseSync): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.workRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const insertTicket = db.prepare(
      `INSERT INTO tickets (id, prompt, status, created_at, updated_at, employee, error, idempotency_key, parent_ticket_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         prompt = excluded.prompt,
         status = excluded.status,
         updated_at = excluded.updated_at,
         employee = excluded.employee,
         error = excluded.error,
         idempotency_key = excluded.idempotency_key,
         parent_ticket_id = excluded.parent_ticket_id`,
    );
    const insertTask = db.prepare(
      `INSERT INTO tasks (ticket_id, seq, slug, title, dir, status, employee, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticket_id, seq) DO UPDATE SET
         slug = excluded.slug,
         title = excluded.title,
         dir = excluded.dir,
         status = excluded.status,
         employee = excluded.employee,
         updated_at = excluded.updated_at`,
    );
    const insertReview = db.prepare(
      `INSERT INTO reviews (ticket_id, seq, slug, verdict, reason, stage, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.workRoot, entry.name);
      const ticket = readJson<Ticket>(path.join(dir, "ticket.json"));
      if (!ticket) continue;

      insertTicket.run(
        ticket.id,
        ticket.prompt,
        ticket.status,
        ticket.created_at,
        ticket.updated_at,
        ticket.employee ?? null,
        ticket.error ?? null,
        ticket.idempotencyKey ?? null,
        ticket.parentTicketId ?? null,
      );

      const plan = readJson<{ tasks?: PlannedTask[] }>(path.join(dir, "plan.json"));
      const reviewFile = readJson<{ reviews?: Review[] }>(path.join(dir, "review.json"));
      const reviews = reviewFile?.reviews ?? [];
      const tasks = plan?.tasks ?? [];

      tasks.forEach((task, index) => {
        const seq = index + 1;
        const review = reviews.find((item) => item.seq === seq);
        const status = review
          ? review.verdict === "pass"
            ? "passed"
            : review.verdict === "fail"
              ? "failed"
              : "blocked"
          : "pending";
        insertTask.run(
          ticket.id,
          seq,
          task.slug,
          task.title,
          `${String(seq).padStart(2, "0")}-${task.slug}`,
          status,
          ticket.employee ?? null,
          ticket.updated_at,
        );
      });

      for (const review of reviews) {
        insertReview.run(
          review.ticket_id || ticket.id,
          review.seq,
          review.slug,
          review.verdict,
          review.reason,
          review.stage,
          ticket.updated_at,
        );
      }
    }
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 清掉这张单所有 task 目录里的执行前快照；目录读不到就当没事。 */
export function clearTaskSnapshots(ticketDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ticketDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    fs.rmSync(path.join(ticketDir, entry.name, SNAPSHOT_FILE), { force: true });
  }
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeText(file: string, text: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function listFiles(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        out.push({ path: path.relative(root, full).split(path.sep).join("/"), size });
      }
    }
  };
  walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
