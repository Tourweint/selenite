/**
 * 今日回顾
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { attr, esc } from "./markdown.js";
import { currentRoute } from "./route.js";
import { state } from "./state.js";
import { employeeName, ticketConversationId, ticketText } from "./tasks-cards.js";
import { loadTickets } from "./tasks-kanban.js";
import { TASK_STATUS } from "./tasks-model.js";
import { briefText, hitterBadge, hitterTone } from "./tasks-redesign.js";

/* ── 今日回顾（2026-11-13 批 1）──────────────────────────────
 * 独立视图 #/review：GET /tickets 全量按 updated_at 分日，默认今天。
 * 汇总只用单列表现算的数字：派活次数（父单，同 dispatchedCount 口径）/ 完结对话 /
 * 出错 / 等你回话。刻意不写「改了 N 个文件」——回执没有 changedPaths，没数据源就不编。 */

const REVIEW_GROUPS = [
  { id: "am", label: "上午" },
  { id: "pm", label: "下午" },
  { id: "night", label: "晚上" },
];

/** 本地日历日（YYYY-MM-DD）：按天分组用本地时区，不能用 UTC 切片 */
function dayKeyOf(value) {
  // new Date(null) 会得到 1970-01-01（不是 Invalid Date），缺时间戳的单必须显式挡掉
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayKey() {
  return dayKeyOf(new Date());
}

function shiftDayKey(key, delta) {
  const [year, month, day] = String(key || todayKey()).split("-").map(Number);
  return dayKeyOf(new Date(year, (month || 1) - 1, (day || 1) + delta));
}

/** 11-13：页面上只给月日，年份留在 key 里 */
function dayLabel(key) {
  const [, month, day] = String(key).split("-");
  return `${month}-${day}`;
}

/** 时间线只给 HH:MM（跨天由日期切换负责，不在这里补日期） */
function reviewClockOf(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ticketsOfDay(key) {
  return state.tickets.filter((ticket) => dayKeyOf(ticket.updated_at) === key);
}

/**
 * 当天数字。派活 = 父单行数（子单不算一次派活）；
 * 完结对话 = 当天有 done 单的去重对话数（直派单自己算一个）；
 * 出错 / 等你回话按单数点（一张出错单就是一次要看的错）。
 */
function reviewStatsOf(key) {
  const tickets = ticketsOfDay(key);
  const doneConversations = new Set();
  let directDone = 0;
  for (const ticket of tickets) {
    if (ticket.status !== "done") continue;
    const conversationId = ticketConversationId(ticket);
    if (conversationId) doneConversations.add(conversationId);
    else if (!ticket.parentTicketId) directDone += 1;
  }
  return {
    dispatched: tickets.filter((ticket) => !ticket.parentTicketId).length,
    done: doneConversations.size + directDone,
    failed: tickets.filter((ticket) => ticket.status === "failed" || ticket.status === "aborted").length,
    needs: tickets.filter((ticket) => ticket.status === "needs_you").length,
  };
}

/** 当天的派活行：子单不单列（父单在列表里时），与 workRowsOf 同口径 */
function dayRowsOf(key) {
  const known = new Set(state.tickets.map((ticket) => ticket.id));
  return ticketsOfDay(key).filter(
    (ticket) => !ticket.parentTicketId || !known.has(ticket.parentTicketId),
  );
}

/**
 * 时间线混排：完结（按对话收一条）✓ / 派活行（工具徽章）/ 等你回话 / 出错。
 * 时间一律取 ticket.updated_at；没有对话可回的直派单不给点击。
 */
function reviewEntriesOf(key) {
  const entries = [];
  const doneGroups = new Map();
  for (const ticket of dayRowsOf(key)) {
    const conversationId = ticketConversationId(ticket);
    const [statusLabel] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
    if (ticket.status === "done") {
      const groupKey = conversationId || `direct-${ticket.id}`;
      let group = doneGroups.get(groupKey);
      if (!group) {
        group = {
          kind: "done",
          conversationId,
          title:
            briefText(ticketText(ticket, "conversationTitle") || ticket.prompt, 48) ||
            (conversationId ? "未命名对话" : "直接派出的单"),
          count: 0,
          at: ticket.updated_at || "",
        };
        doneGroups.set(groupKey, group);
        entries.push(group);
      }
      group.count += 1;
      if (String(ticket.updated_at || "") > String(group.at || "")) group.at = ticket.updated_at || "";
      continue;
    }
    const kind =
      ticket.status === "needs_you"
        ? "ask"
        : ticket.status === "failed" || ticket.status === "aborted"
          ? "fail"
          : "run";
    const prompt = briefText(ticket.prompt, 48);
    entries.push({
      kind,
      conversationId,
      employee: ticket.employee || "",
      title:
        prompt ||
        briefText(ticketText(ticket, "conversationTitle"), 48) ||
        (kind === "ask" ? "有张单在等你回话" : "（没有说明）"),
      // 身份诚实：等你回话不写「总管说」，只说这张单在等你
      note:
        kind === "ask"
          ? `这张单在等你回话 · ${statusLabel}`
          : kind === "fail"
            ? `${employeeName(ticket.employee)} · ${statusLabel}`
            : `派给 ${employeeName(ticket.employee)} · ${statusLabel}`,
      at: ticket.updated_at || "",
    });
  }
  for (const group of entries) {
    if (group.kind === "done") group.note = `${group.count} 次派活完成 · 点开回原对话`;
  }
  entries.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return entries;
}

function reviewEntryHtml(entry) {
  const icon =
    entry.kind === "done"
      ? `<span class="rv-ic done" aria-hidden="true">✓</span>`
      : entry.kind === "ask"
        ? `<span class="rv-ic ask" aria-hidden="true">总</span>`
        : entry.kind === "fail"
          ? `<span class="rv-ic fail" aria-hidden="true">!</span>`
          : `<span class="tk2-tool ${hitterTone(entry.employee)}">${esc(hitterBadge(entry.employee))}</span>`;
  // 完结/派活/出错都能回原对话；直派单没有对话，卡片保持只读
  const clickable = Boolean(entry.conversationId);
  const attrs = clickable
    ? ` data-open-conv="${attr(entry.conversationId)}" role="button" tabindex="0" title="点开回原对话"`
    : ` title="这张单没有来源对话"`;
  return `<div class="rv-entry" data-kind="${attr(entry.kind)}">
    <span class="rv-dot" aria-hidden="true"></span>
    <span class="rv-tm">${esc(reviewClockOf(entry.at))}</span>
    <div class="rv-card${entry.kind === "done" ? " dim" : ""}${clickable ? " link" : ""}"${attrs}>
      <div class="rv-r1">${icon}<h3>${esc(entry.title)}</h3></div>
      <p class="rv-r2">${esc(entry.note)}</p>
    </div>
  </div>`;
}

function renderReview() {
  const scrollTop = el.reviewScroll.scrollTop;
  const today = todayKey();
  if (!state.reviewDay) state.reviewDay = today;
  if (String(state.reviewDay) > today) state.reviewDay = today; // 不看未来
  const key = state.reviewDay;
  const prevKey = shiftDayKey(key, -1);
  const nextKey = shiftDayKey(key, 1);
  const nextDisabled = nextKey > today || !ticketsOfDay(nextKey).length;

  el.reviewTitleSub.textContent = key === today ? "" : dayLabel(key);
  el.rvPager.innerHTML = `
    <button type="button" data-day-shift="-1" title="看 ${esc(dayLabel(prevKey))}">‹ 前一天</button>
    ${key === today ? "" : `<span class="rv-day-tag">${esc(dayLabel(key))}</span>`}
    <button type="button" data-day-today class="${key === today ? "cur" : ""}"${
      key === today ? ' aria-current="date"' : ""
    }>今天 · ${esc(dayLabel(today))}</button>
    <button type="button" data-day-shift="1" title="看 ${esc(dayLabel(nextKey))}"${
      nextDisabled ? " disabled" : ""
    }>后一天 ›</button>`;

  const stats = reviewStatsOf(key);
  el.rvSum.innerHTML = [
    ["次派活", stats.dispatched, ""],
    ["完结对话", stats.done, "done"],
    ["出错", stats.failed, "fail"],
    ["等你回话", stats.needs, "ask"],
  ]
    .map(
      ([label, value, tone]) =>
        `<div class="rv-n${tone ? ` ${tone}` : ""}"><b>${value}</b><span>${label}</span></div>`,
    )
    .join("");

  const entries = reviewEntriesOf(key);
  if (!entries.length) {
    el.rvTl.innerHTML = `<p class="rv-empty">${
      state.tickets.length ? "这天没有记录。" : "还没有派过活。派出去的单会按天记在这里。"
    }</p>`;
  } else {
    // 06 / 12 / 18 切上午·下午·晚上；0~6 点归晚上
    const buckets = { am: [], pm: [], night: [] };
    for (const entry of entries) {
      const hour = new Date(entry.at).getHours();
      const bucket = !Number.isFinite(hour) || hour < 6 || hour >= 18 ? "night" : hour < 12 ? "am" : "pm";
      buckets[bucket].push(entry);
    }
    el.rvTl.innerHTML = REVIEW_GROUPS.map((group) => {
      const items = buckets[group.id];
      if (!items.length) return "";
      return `<div class="rv-grp">${group.label}</div>${items.map(reviewEntryHtml).join("")}`;
    }).join("");
  }

  el.reviewState.hidden = true;
  el.reviewBody.hidden = false;
  el.reviewScroll.scrollTop = scrollTop;
}

function openReview() {
  if (!state.reviewDay) state.reviewDay = todayKey();
  renderReview();
  // 进页补一次最新单（4s 内刚拉过会走缓存），回来再按新数据重画一次
  const pending = loadTickets({ silent: true, force: true, render: false });
  void pending.then(() => {
    if (currentRoute() === "review") renderReview();
  });
}

export { REVIEW_GROUPS, dayKeyOf, dayLabel, dayRowsOf, openReview, renderReview, reviewClockOf, reviewEntriesOf, reviewEntryHtml, reviewStatsOf, shiftDayKey, ticketsOfDay, todayKey };
