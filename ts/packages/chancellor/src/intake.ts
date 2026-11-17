import fs from "node:fs";
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
): Ticket {
  fs.mkdirSync(store.workRoot, { recursive: true });
  const now = new Date();
  const id = newTicketId(now, store);
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

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function newTicketId(now: Date, store: Store): string {
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
