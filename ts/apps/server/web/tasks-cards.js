/**
 * 一张卡=一条对话：聚合、排序、筛选、侧栏小卡
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { attr, esc } from "./markdown.js";
import { go } from "./route.js";
import { state } from "./state.js";
import { renderSideListEmpty } from "./tasks-board.js";
import { EMPLOYEE_LABEL, STATE_ICON, STATUS_ORDER, TASK_BADGE_STATUSES, relativeTime } from "./tasks-model.js";

/* ── 一张卡 = 一条对话（L3，2026-11-05） ───────────────────
 * 三层粒度：对话卡 → 派活行（父单）→ 子单。
 * - 卡头是对话本身（标题 / 总管 / 区域 / 聚合灯 / 最近时间），点它回原对话；
 * - 卡身每个父单一行（摘要 / 状态 / 执行者 / 时间），子单只收进那一行的展开区；
 * - 没有 conversationId 的旧直派单不进三列，统一收进底部「更早的直派」折叠组。
 * 灯 / 时间 / 计数全是渲染时从列表现算的派生值，不写回任何单的状态。 */

/** 子单按父单号就地分组：列表里已经有全量字段，不再逐张拉详情 */
function childTicketsOf(parentId) {
  return state.tickets.filter((ticket) => ticket.parentTicketId === parentId);
}

/** 来源对话（L1 新字段）：缺失 / null / 非字符串一律当「无来源对话」 */
function ticketConversationId(ticket) {
  const value = ticket && ticket.conversationId;
  return typeof value === "string" ? value.trim() : "";
}

/** L1 新字段的取值口：不是非空字符串就当没有——老服务端不带字段也照常渲染 */
function ticketText(ticket, key) {
  const value = ticket ? ticket[key] : null;
  return typeof value === "string" ? value.trim() : "";
}

/* 聚合灯（照 CINDY resolveSessionRightStatus 的优先级）：
 * 红「有单出错」→ 蓝「等你处理」→ 灰「执行中」→ 灰「已完结」无灯。 */
const LAMP_TEXT = { fail: "有单出错", ask: "等你处理", run: "执行中", done: "已完结" };
const LAMP_ORDER = ["fail", "ask", "run", "done"];

/** 单灯：failed/aborted 红；needs_you 蓝；done 无灯；其余（排队/派发/验收/等文件）灰 */
function ticketLamp(ticket) {
  const status = ticket ? ticket.status : "";
  if (status === "failed" || status === "aborted") return "fail";
  if (status === "needs_you") return "ask";
  // 作废单不再在跑：归到已完结折叠区，别一直挂在「进行中」列里（仍有「已作废」chip 与重试入口）。
  if (status === "done" || status === "canceled") return "done";
  return "run";
}

/** 卡灯：卡内任一单/子单取最高优先级 */
function conversationLamp(tickets) {
  let lamp = "done";
  for (const ticket of tickets) {
    const next = ticketLamp(ticket);
    if (LAMP_ORDER.indexOf(next) < LAMP_ORDER.indexOf(lamp)) lamp = next;
  }
  return lamp;
}

function lampHtml(lamp) {
  const text = LAMP_TEXT[lamp];
  if (!lamp || !text) return "";
  return `<span class="tk-lamp" data-lamp="${attr(lamp)}"><i aria-hidden="true"></i>${esc(text)}</span>`;
}

/** 卡内全部单（父 + 子）：子单一般继承 conversationId，缺了也要算进聚合 */
function conversationTickets(card) {
  const seen = new Map();
  for (const ticket of card.tickets) seen.set(ticket.id, ticket);
  for (const ticket of card.tickets) {
    for (const child of childTicketsOf(ticket.id)) seen.set(child.id, child);
  }
  return [...seen.values()];
}

/**
 * 派活行 = 卡内的父单。父单不在列表里（被 limit 截断）时，孤儿子单自己顶一行，
 * 别让一张已经派出去的单凭空消失。
 */
function workRowsOf(card) {
  const known = new Set(state.tickets.map((ticket) => ticket.id));
  return card.tickets.filter(
    (ticket) => !ticket.parentTicketId || !known.has(ticket.parentTicketId),
  );
}

/**
 * 分组：有 conversationId 的进对话卡（一对话一卡），没有的进直派组。
 * 卡头三个字段各自取卡内第一个非空值——L1 每张单都会带，取谁结果都一样。
 */
function groupByConversation(tickets) {
  const cards = new Map();
  const direct = [];
  for (const ticket of tickets) {
    const conversationId = ticketConversationId(ticket);
    if (!conversationId) {
      direct.push(ticket);
      continue;
    }
    let card = cards.get(conversationId);
    if (!card) {
      card = {
        conversationId,
        tickets: [],
        title: "",
        chiefName: "",
        project: "",
        updated_at: "",
        lamp: "done",
      };
      cards.set(conversationId, card);
    }
    card.tickets.push(ticket);
  }

  const list = [...cards.values()];
  for (const card of list) {
    // 卡内顺序 = 派活行顺序 = 最近更新在前
    card.tickets.sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
    for (const ticket of card.tickets) {
      if (!card.title) card.title = ticketText(ticket, "conversationTitle");
      if (!card.chiefName) card.chiefName = ticketText(ticket, "chiefName");
      if (!card.project) card.project = ticketText(ticket, "project");
    }
    card.updated_at = card.tickets.length ? card.tickets[0].updated_at || "" : "";
    card.lamp = conversationLamp(conversationTickets(card));
  }

  // 直派组只留「派活行」：子单如果父单也在，就别单列一行（和对话卡同一个口径）
  const known = new Set(state.tickets.map((ticket) => ticket.id));
  const directRows = direct.filter(
    (ticket) => !ticket.parentTicketId || !known.has(ticket.parentTicketId),
  );
  return { cards: list, direct: sortTickets(directRows) };
}

function sortTickets(list) {
  const rows = [...list];
  const byRecent = (a, b) =>
    String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  if (state.sort === "status") {
    const rank = (ticket) => {
      const index = STATUS_ORDER.indexOf(ticket.status);
      return index < 0 ? STATUS_ORDER.length : index;
    };
    rows.sort((a, b) => (rank(a) === rank(b) ? byRecent(a, b) : rank(a) - rank(b)));
  } else {
    rows.sort(byRecent);
  }
  return rows;
}

/** 对话卡排序：卡头时间（recent）或灯优先级（status），与三列顺序同源 */
function sortCards(cards) {
  const rows = [...cards];
  const byRecent = (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  if (state.sort === "status") {
    const rank = (card) => {
      const index = LAMP_ORDER.indexOf(card.lamp);
      return index < 0 ? LAMP_ORDER.length : index;
    };
    rows.sort((a, b) => (rank(a) === rank(b) ? byRecent(a, b) : rank(a) - rank(b)));
  } else {
    rows.sort(byRecent);
  }
  return rows;
}

/** 领域 / 项目 / 执行者筛选：卡内任一单命中就整卡留下（卡内行不裁，避免半张卡） */
function cardMatchesFilters(card) {
  const tickets = conversationTickets(card);
  if (state.domainFilter) {
    const hit =
      state.domainFilter === "__none__"
        ? tickets.some((ticket) => !ticket.domain)
        : tickets.some((ticket) => ticket.domain === state.domainFilter);
    if (!hit) return false;
  }
  if (
    state.projectFilter &&
    !tickets.some((ticket) => (ticket.project || "") === state.projectFilter)
  ) {
    return false;
  }
  if (
    state.tasksEmployeeFilter &&
    !tickets.some((ticket) => ticket.employee === state.tasksEmployeeFilter)
  ) {
    return false;
  }
  return true;
}

/** 直派单只吃领域/项目筛选：它们本来就没有对话可筛 */
function directMatchesFilters(ticket) {
  if (state.domainFilter) {
    if (state.domainFilter === "__none__") {
      if (ticket.domain) return false;
    } else if (ticket.domain !== state.domainFilter) {
      return false;
    }
  }
  if (state.projectFilter && (ticket.project || "") !== state.projectFilter) return false;
  return true;
}

/** 执行者名：空 → 「默认」，未知类型原样显示，别把新雇员藏起来 */
function employeeName(kind) {
  const key = String(kind || "").trim();
  if (!key) return "默认";
  return EMPLOYEE_LABEL[key] || key;
}

/** 三种状态共用一个容器：加载/空/失败都不许白屏 */
function showTasksState(kind, title, text, action) {
  el.tasksState.hidden = false;
  el.tasksState.dataset.kind = kind;
  el.tasksState.replaceChildren();
  const icon = document.createElement("div");
  icon.className = "tasks-state-icon";
  icon.innerHTML = STATE_ICON[kind] || STATE_ICON.empty;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = text;
  el.tasksState.append(icon, heading, body);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    el.tasksState.append(button);
  }
  el.tasksBody.hidden = true;
}

function hideTasksState() {
  el.tasksState.hidden = true;
  el.tasksBody.hidden = false;
}

/**
 * 侧栏「任务中心」分区里的简版列表（2026-11-07 统一批）。
 *
 * 用户口径：任务中心也要能展开、展开后"长得像里面那个对话一样"。
 * 所以这里不复制整张看板，只列最近有活的对话卡（标题 + 聚合灯 + 时间），
 * 点一下进任务中心那张卡（#/tasks?ticket=… 或直接开看板）；
 * 完整三列/筛选/打手卡仍在任务中心页——侧栏是入口，不是第二块看板。
 */
const SIDE_TASKS_LIMIT = 5;

function renderTasksMini() {
  const box = el.tasksMini;
  if (!box) return;
  const { cards, direct } = groupByConversation(state.tickets);
  const alive = (ticket) => TASK_BADGE_STATUSES.has(ticket.status);
  // 固定按最近更新排（不看任务中心的排序/筛选：侧栏要稳定，不该被页面上的筛选带走）
  // 2026-11-07 四改：会话与任务合并成一个分区后，**同一个对话不能出现两行**——
  // 已经在上面会话列表里出现的对话，这里跳过（它那一行本身就是入口，点进去也能看任务）。
  const shown = new Set(
    [...el.chats?.querySelectorAll(".chat") || []].map((row) => row.dataset.conv).filter(Boolean),
  );
  const activeCards = cards
    .filter((card) => conversationTickets(card).some(alive))
    .filter((card) => !shown.has(card.conversationId))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  box.replaceChildren();

  // 空态由整块（会话 + 任务）统一给，这里不再各说一句；
  // 但统一空态本身由本函数的收尾来刷新——最后一张任务行消失时也要能补上那句话
  // （2026-11-07 修：原先提前 return 跳过了收尾的 renderSideListEmpty，空态一直缺失）
  if (!activeCards.length && !direct.some(alive)) {
    renderSideListEmpty();
    return;
  }

  for (const card of activeCards.slice(0, SIDE_TASKS_LIMIT)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-item task-row";
    row.dataset.lamp = card.lamp;
    const lamp = document.createElement("i");
    lamp.className = "task-lamp";
    lamp.dataset.lamp = card.lamp === "done" ? "run" : card.lamp;
    const name = document.createElement("span");
    name.className = "side-item-label";
    name.textContent = card.title || "未命名对话";
    const time = document.createElement("span");
    time.className = "roster-idle";
    time.textContent = relativeTime(card.updated_at);
    row.append(lamp, name, time);
    row.addEventListener("click", () => {
      go("tasks");
      const first = workRowsOf(card)[0];
      if (first) location.hash = `#/tasks?ticket=${encodeURIComponent(first.id)}`;
    });
    box.append(row);
  }

  // 直派（没有来源对话的旧单）：只给一行计数，点进任务中心底部那组
  const aliveDirect = direct.filter(alive).length;
  if (aliveDirect) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-item task-row";
    row.innerHTML = `<span class="side-item-label">更早的直派</span><span class="roster-idle">${aliveDirect} 单</span>`;
    row.addEventListener("click", () => go("tasks"));
    box.append(row);
  }
  renderSideListEmpty();
}

/**
 * 合并后的统一空态（2026-11-07 四改）：会话行与任务行都没内容时，才在列表顶上
 * 放一句「还没有对话」。两处各写一句会同时冒出两条互相矛盾的提示。
 */

export { LAMP_ORDER, LAMP_TEXT, SIDE_TASKS_LIMIT, cardMatchesFilters, childTicketsOf, conversationLamp, conversationTickets, directMatchesFilters, employeeName, groupByConversation, hideTasksState, lampHtml, renderTasksMini, showTasksState, sortCards, sortTickets, ticketConversationId, ticketLamp, ticketText, workRowsOf };
