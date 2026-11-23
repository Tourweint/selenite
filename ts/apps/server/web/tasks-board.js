/**
 * 任务单共享件：侧栏空态、徽标、派活行、操作按钮
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 2026-11-21 随 TASKS_REDESIGN_ENABLED 退役删去旧三列看板专属的渲染函数
 * （renderBoard / 打手四卡 / 统计条 / 筛选下拉 / 归档与直派折叠），只留新视图仍消费的部分。
 */

import { el } from "./dom.js";
import { chevSvg } from "./icons.js";
import { attr, esc } from "./markdown.js";
import { state } from "./state.js";
import { childTicketsOf, conversationTickets, employeeName, groupByConversation, ticketLamp, workRowsOf } from "./tasks-cards.js";
import { TASK_BADGE_STATUSES, TASK_STATUS, relativeTime, stalenessHint } from "./tasks-model.js";

function renderSideListEmpty() {
  if (!el.chats) return;
  el.chats.querySelector(".chats-empty")?.remove();
  // 普通对话行与任务行都为零才出现（2026-11-15 设计口径；实现当时漏了任务行，2026-11-21 补上）
  if (el.chats.querySelector(".chat, .task-row")) return;
  const hint = document.createElement("div");
  hint.className = "chats-empty";
  hint.textContent = "还没有对话。点「任务」右边的 ⋯ 新建一条。";
  el.chats.append(hint);
}

function syncTasksBadge() {
  // 徽标口径跟看板一致：数「还有活在跑/在等」的对话卡；直派单没有卡，自己算一个。
  // 注意 alive 收的是**单张票**：direct.filter(alive) 直接可用；卡内用 .some(alive)。
  // （E5 实测：原来 alive 写成收数组，遇到直派单会抛错，把后面的总管计数一起带掉。）
  const { cards, direct } = groupByConversation(state.tickets);
  const alive = (ticket) => TASK_BADGE_STATUSES.has(ticket.status);
  const active =
    cards.filter((card) => conversationTickets(card).some(alive)).length + direct.filter(alive).length;
  el.tasksBadge.hidden = active === 0;
  el.tasksBadge.textContent = active > 99 ? "99+" : String(active);

  // E5：无 domain 的活跃单 = 总管直接派给无主工人的活，挂在总管条目右侧。
  // 不可点击（总管没有 domain 筛选入口），为 0 时不显示。
  if (el.chiefCount) {
    const chiefActive = state.tickets.filter(
      (ticket) => !ticket.domain && TASK_BADGE_STATUSES.has(ticket.status),
    ).length;
    el.chiefCount.hidden = chiefActive === 0;
    el.chiefCount.textContent = chiefActive > 99 ? "99+ 单" : `${chiefActive} 单`;
  }
}

/** 取消/重试（扫尾批 1 A1）：只在该单可操作时渲染；开关关着一律不渲染。 */
const RETRYABLE_TICKET_STATUS = new Set(["failed", "aborted", "canceled"]);
// 服务端 cancel 只对这三个终态回 400，其余（含 needs_you / idle）都能作废。
const CANCEL_BLOCKED_STATUS = new Set(["done", "failed", "aborted"]);
function ticketActionButtons(ticket, enabled = state.ticketsCancelEnabled) {
  if (!enabled) return "";
  const status = String(ticket.status || "");
  const canceled = Boolean(ticket.canceled) || status === "canceled";
  const id = attr(ticket.id || "");
  if (canceled || RETRYABLE_TICKET_STATUS.has(status)) {
    return `<span class="tk-row-actions"><button class="tk-act" type="button" data-ticket-action="retry" data-ticket="${id}">重试</button></span>`;
  }
  if (!CANCEL_BLOCKED_STATUS.has(status)) {
    return `<span class="tk-row-actions"><button class="tk-act" type="button" data-ticket-action="cancel" data-ticket="${id}">取消</button></span>`;
  }
  return "";
}

function workRow(ticket) {
  const children = childTicketsOf(ticket.id);
  const [label, tone] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
  const prompt = String(ticket.prompt || "").replace(/\s+/g, " ").trim();
  const brief = prompt ? (prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt) : "（没有说明）";
  const childrenOpen = state.tasksChildrenOpen.has(ticket.id);

  const childRows = children
    .map((child) => {
      const [childLabel, childTone] = TASK_STATUS[child.status] || [child.status || "未知", "idle"];
      return `<a class="tk-child-row" href="#/tasks?ticket=${encodeURIComponent(child.id)}">
        <span class="tk-child-id">${esc(child.id)}</span>
        <span class="tk-chip" data-tone="${childTone}">${esc(childLabel)}</span>
        <span class="tk-child-time">${esc(relativeTime(child.updated_at))}</span>
      </a>`;
    })
    .join("");

  // 行根是 div[role=button]：行内还要放「子单 N」按钮，按钮里嵌按钮是非法 HTML。
  // 键盘行为由 tasksBody 上的 keydown 补齐。展开态 key = 派活行（父单）id。
  const row = document.createElement("div");
  row.className = "tk-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.dataset.ticket = ticket.id;
  row.dataset.lamp = ticketLamp(ticket);
  row.innerHTML = `
    <div class="tk-row-top">
      <span class="tk-row-prompt">${esc(brief)}</span>
      <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
    </div>
    <div class="tk-row-meta">
      <span class="tk-row-who">${esc(employeeName(ticket.employee))}</span>
      <span class="tk-row-time">${esc(relativeTime(ticket.updated_at))}${esc(stalenessHint(ticket.status, ticket.updated_at))}</span>
    </div>
    ${ticketActionButtons(ticket)}
    ${
      children.length
        ? `<button class="tk-children-toggle" type="button" data-ticket="${attr(ticket.id)}" aria-expanded="${childrenOpen ? "true" : "false"}">
            <span>子单 ${children.length}</span>${chevSvg("tk-child-caret chev")}
          </button>
          <div class="tk-children"${childrenOpen ? "" : " hidden"}>${childRows}</div>`
        : ""
    }
  `;
  return row;
}

/**
 * 「派活」次数的唯一算法（批 18 七原则⑤）：父单一行算一次，子单不算。
 * 统计条与标题副行都走它——两处各算一份就会互相矛盾。
 */
function dispatchedCount(cards, direct) {
  return (
    cards.reduce((sum, card) => sum + workRowsOf(card).length, 0) +
    direct.filter((ticket) => !ticket.parentTicketId).length
  );
}

export { dispatchedCount, renderSideListEmpty, syncTasksBadge, ticketActionButtons, workRow };
