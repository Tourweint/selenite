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

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 日期头的主标题：11月18日；跨年才补年份（翻旧账时不能只写 11月18日） */
function dayTitle(key) {
  const [year, month, day] = String(key || todayKey()).split("-").map(Number);
  const head = `${month || 1}月${day || 1}日`;
  return year && year !== new Date().getFullYear() ? `${year}年${head}` : head;
}

/** 日期头的副标题：周二 · 今天 / 周一 · 昨天 / 周二 */
function daySubtitle(key) {
  const [year, month, day] = String(key || todayKey()).split("-").map(Number);
  const date = new Date(year || 1970, (month || 1) - 1, day || 1);
  const weekday = WEEKDAYS[date.getDay()] || "";
  const today = todayKey();
  if (key === today) return weekday ? `${weekday} · 今天` : "今天";
  if (key === shiftDayKey(today, -1)) return weekday ? `${weekday} · 昨天` : "昨天";
  return weekday;
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
    if (group.kind === "done") group.note = `${group.count} 次派活完成`;
  }
  entries.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return entries;
}

/** 流水一行：时间 / 状态图标 / 标题 + 一句出处 / 可回原对话才给箭头。
 *  完结、派活、出错都能回原对话；直派单没有来源对话，整行只读。 */
function reviewRowHtml(entry) {
  const icon =
    entry.kind === "done"
      ? `<span class="rv-ic done" aria-hidden="true">✓</span>`
      : entry.kind === "ask"
        ? `<span class="rv-ic ask" aria-hidden="true">问</span>`
        : entry.kind === "fail"
          ? `<span class="rv-ic fail" aria-hidden="true">!</span>`
          : `<span class="tk2-tool ${hitterTone(entry.employee)}">${esc(hitterBadge(entry.employee))}</span>`;
  const clickable = Boolean(entry.conversationId);
  const body = `<span class="rv-tm">${esc(reviewClockOf(entry.at))}</span>
      ${icon}
      <span class="rv-bd"><b>${esc(entry.title)}</b><em>${esc(entry.note)}</em></span>
      <span class="rv-go" aria-hidden="true">${clickable ? "›" : ""}</span>`;
  if (!clickable) return `<div class="rv-row static" title="这张单没有来源对话">${body}</div>`;
  return `<button class="rv-row" type="button" data-open-conv="${attr(entry.conversationId)}" title="点开回原对话">${body}</button>`;
}

/** 日期头：大日期 + 周几/今天昨天 + 回到今天 + 前后一天 */
function reviewDaynavHtml(key, today) {
  const prevKey = shiftDayKey(key, -1);
  const nextKey = shiftDayKey(key, 1);
  const nextDisabled = nextKey > today;
  return `<div class="rv-day-copy">
      <h2>${esc(dayTitle(key))}</h2>
      <p>${esc(daySubtitle(key))}</p>
    </div>
    <div class="rv-day-actions">
      ${key === today ? "" : `<button class="rv-today-btn" type="button" data-day-today>回到今天</button>`}
      <div class="rv-day-btns">
        <button class="rv-day-btn" type="button" data-day-shift="-1" title="看 ${esc(dayLabel(prevKey))}" aria-label="前一天">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <button class="rv-day-btn" type="button" data-day-shift="1" title="看 ${esc(dayLabel(nextKey))}" aria-label="后一天"${nextDisabled ? " disabled" : ""}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
    </div>`;
}

/** 当日概览：左边一个主数字（派了多少单），右边三个结果数字 */
function reviewHeroHtml(key, stats) {
  const today = key === todayKey();
  const leadLabel = today ? "今天派出" : "这天派出";
  return `<div class="rv-hero">
    <div class="rv-lead">
      <span class="rv-lead-label">${leadLabel}</span>
      <b>${stats.dispatched}</b>
      <span class="rv-lead-unit">单</span>
    </div>
    <div class="rv-split">
      <div class="${stats.done ? "done" : "zero"}"><b>${stats.done}</b><span>件收了尾</span></div>
      <div class="${stats.needs ? "ask" : "zero"}"><b>${stats.needs}</b><span>条等你回话</span></div>
      <div class="${stats.failed ? "fail" : "zero"}"><b>${stats.failed}</b><span>单出了错</span></div>
    </div>
  </div>`;
}

/** 空态：没有单的日子也长得像一页纸，而不是一片白 */
function reviewEmptyHtml(key) {
  const today = key === todayKey();
  return `<div class="rv-empty">
    <span class="rv-empty-ic" aria-hidden="true">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>
    </span>
    <h3>${today ? "今天还没有派过活" : "这天没有记录"}</h3>
    <p>${today ? "派出去的单会按天记在这里。" : "换一天看看，或者去任务中心派一单。"}</p>
    ${today ? `<a class="rv-empty-go" href="#/tasks">去任务中心</a>` : ""}
  </div>`;
}

function renderReview() {
  const scrollTop = el.reviewScroll.scrollTop;
  const today = todayKey();
  if (!state.reviewDay) state.reviewDay = today;
  if (String(state.reviewDay) > today) state.reviewDay = today; // 不看未来
  const key = state.reviewDay;
  const stats = reviewStatsOf(key);
  const entries = reviewEntriesOf(key);

  el.reviewTitleSub.textContent = stats.dispatched ? `${stats.dispatched} 单` : "";
  el.rvPager.innerHTML = reviewDaynavHtml(key, today);
  el.rvSum.innerHTML = entries.length ? reviewHeroHtml(key, stats) : "";

  if (!entries.length) {
    el.rvTl.innerHTML = reviewEmptyHtml(key);
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
      return `<section class="rv-grp">
        <div class="rv-grp-h"><span>${group.label}</span><span class="rv-grp-ln"></span></div>
        <div class="rv-rows">${items.map(reviewRowHtml).join("")}</div>
      </section>`;
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

export { REVIEW_GROUPS, dayKeyOf, dayLabel, dayRowsOf, daySubtitle, dayTitle, openReview, renderReview, reviewClockOf, reviewEntriesOf, reviewRowHtml, reviewStatsOf, shiftDayKey, ticketsOfDay, todayKey };
