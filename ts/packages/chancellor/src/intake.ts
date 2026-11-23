import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.ts";
import type { EmployeeKind, Ticket, TicketOptions } from "./types.ts";

export function intake(
  store: Store,
  prompt: string,
  options: TicketOptions,
  employee: EmployeeKind,
  idempotencyKey?: string,
  parentTicketId?: string,
  /** 宿主对话标识（跨仓契约）：明文直存 ticket.json，store 的 INSERT 不认识它。 */
  originConversationId?: string,
  /** 计划附件（2026-11-09 §2）：宿主已校验的动作序列；不传 = 旧 ticket。 */
  steps?: string[],
  /**
   * 预分配单号（2026-11-22 前端直派任务）：宿主先按这个号建任务专线，再落单。
   * 形状不合法或目录已存在时**回落自生成**——不因一个可选参数把收单卡死。
   */
  requestedId?: string,
): Ticket {
  fs.mkdirSync(store.workRoot, { recursive: true });
  const now = new Date();
  const id =
    requestedId && validRequestedId(requestedId, store) ? requestedId : newTicketId(now, store);
  fs.mkdirSync(store.ticketDir(id));
  const ticket: Ticket = {
    id,
    prompt,
    status: "received",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    options,
    employee,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(parentTicketId ? { parentTicketId } : {}),
    ...(originConversationId ? { originConversationId } : {}),
    ...(steps && steps.length > 0 ? { steps: [...steps] } : {}),
  };
  store.saveTicket(ticket);
  return ticket;
}

/**
 * 预分配单号（前端直派任务）：只生成、不落盘；`intake` 收到同一个号才会建目录。
 * 生成规则与自生成完全一致，调用方不必知道格式。
 */
export function allocateTicketId(workRoot: string, now = new Date()): string {
  const dir = path.resolve(workRoot);
  return newTicketId(now, { ticketDir: (id: string) => path.join(dir, id) });
}

/** 只认自己发出去的那种单号；目录已存在 = 冲突，回落自生成。 */
function validRequestedId(id: string, store: Pick<Store, "ticketDir">): boolean {
  return /^t-\d{8}-\d{6}-[a-z0-9]{4}$/.test(id) && !fs.existsSync(store.ticketDir(id));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function newTicketId(now: Date, store: Pick<Store, "ticketDir">): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 20; attempt++) {
    let suffix = "";
    for (let index = 0; index < 4; index++) {
      suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    const id = `t-${stamp}-${suffix}`;
    if (!fs.existsSync(store.ticketDir(id))) return id;
  }
  return `t-${stamp}-${Date.now().toString(36).slice(-4)}`;
}
