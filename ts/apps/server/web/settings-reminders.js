/**
 * 定时任务页（员工例行任务 + 每晚整理记忆）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 2026-11-14 手动创建重做：滚轮时间 + 图形化日期，支持单日 / 区间 / 每天 / 每周 / 每月，
 * 并给已排好的任务提供「改时间」（只改时间，不改内容）。
 * 2026-11-14 合并「定时任务」页：一张清单；每条任务只记目标（总管 / 员工）、提示词和时间。
 * 到点把提示词发给目标，目标起一轮再回话；不再分「只发一句 / 自动执行」。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { fetchModelCatalog, normalizeModelRow, renderModelMenu } from "./hover-tip.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { ptHumanizeTrigger } from "./partner-modals.js";
import { mountSegmented, syncSegmented } from "./settings-atoms.js";
import { KEY_MODEL_PROVIDER } from "./shell.js";
import { state } from "./state.js";
import { closeModal, closePopover, openModal, openPopover, popoverOpen, toast } from "./ui-atoms.js";


/* ── 提醒（2026-11-12 重做；2026-11-14 图形化）─────────────
 * 日期文案一律走中文（今天 / 明天 / 11月13日），不再把裸 ISO 码或 MM/DD/YY 丢给用户。
 * 时间不再让用户手打 HH:mm，改成上下滚动的小时/分钟滚轮；日期也不是原生 datetime-local，
 * 而是自绘日历/星期/几号。周期规则和服务端一致：once / range(每天) / daily / weekly / monthly。 */
const RM_DAY_MS = 24 * 60 * 60 * 1000;
const RM_ITEM_H = 36;
const RM_WEEK_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
const RM_WEEK_FULL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function rmPad(value) {
  return String(value).padStart(2, "0");
}

function rmStartOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function rmDayDiff(from, to) {
  return Math.round((rmStartOfDay(to) - rmStartOfDay(from)) / RM_DAY_MS);
}

function rmDateText(value) {
  const date = new Date(value);
  const diff = rmDayDiff(Date.now(), date);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function rmShortDate(value) {
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function rmTimeText(value) {
  const date = new Date(value);
  return `${rmPad(date.getHours())}:${rmPad(date.getMinutes())}`;
}

function rmAt(date, hour, minute) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour,
    minute,
    0,
    0,
  ).getTime();
}

function rmNextDaily(hour, minute) {
  const today = rmStartOfDay(Date.now());
  let at = rmAt(today, hour, minute);
  if (at <= Date.now()) at = rmAt(new Date(today.getTime() + RM_DAY_MS), hour, minute);
  return at;
}

function rmNextWeekly(weekdays, hour, minute) {
  const today = rmStartOfDay(Date.now());
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(today.getTime() + offset * RM_DAY_MS);
    if (!weekdays.includes(day.getDay())) continue;
    const at = rmAt(day, hour, minute);
    if (at > Date.now()) return at;
  }
  return null;
}

function rmNextMonthly(dayOfMonth, hour, minute) {
  const now = new Date();
  for (let offset = 0; offset <= 13; offset += 1) {
    const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const at = rmAt(
      new Date(month.getFullYear(), month.getMonth(), Math.min(dayOfMonth, last)),
      hour,
      minute,
    );
    if (at > Date.now()) return at;
  }
  return null;
}

function rmWeeklyText(weekdays) {
  const values = [...weekdays].sort((a, b) => a - b);
  return `每周${values.map((value) => RM_WEEK_SHORT[value]).join("、")}`;
}

/* 总览里不摊 cron 原文：只给一句人话。cron 的星期数字也翻成中文。 */
const RT_WEEK = ["日", "一", "二", "三", "四", "五", "六"];
function rtTriggerText(trigger) {
  if (!trigger) return "—";
  if (trigger.type !== "cron") return ptHumanizeTrigger(trigger);
  const parts = String(trigger.expr || "").trim().split(/\s+/);
  let human = "按 cron 定时";
  if (parts.length === 5) {
    const [mi, hr, dom, mon, dow] = parts;
    const pad = (value) => (value === "*" ? "*" : String(value).padStart(2, "0"));
    const clock = `${pad(hr)}:${pad(mi)}`;
    let week = dow;
    if (/^\d+$/.test(dow)) week = RT_WEEK[Number(dow)] || dow;
    else if (dow === "1-5") week = "一至五";
    else if (dow.includes(",")) week = dow.split(",").map((value) => (/^\d+$/.test(value) ? RT_WEEK[Number(value)] || value : value)).join("、");
    if (hr !== "*" && mi !== "*" && dom === "*" && mon === "*" && dow === "*") human = `每天 ${clock}`;
    else if (hr === "*" && mi !== "*" && dom === "*" && mon === "*" && dow === "*") human = `每小时第 ${mi} 分`;
    else if (hr === "*" && mi === "*") human = "每分钟";
    else if (dom !== "*") human = `每月 ${dom} 日 ${clock}`;
    else if (dow !== "*") human = `每周${week} ${clock}`;
  }
  return esc(human);
}

/* ── 定时任务清单（2026-11-14 合并）──────────────────────
 * 提醒和例行任务本来就是"到点叫一个人"：说一句不跑模型，跑一轮会起一轮。
 * 这里不再分两组，统一成一张清单：来源不同，行长得一样，都能改时间。 */

function rtCronFieldMatches(field, value, min, max) {
  for (const part of String(field).split(",")) {
    const [body, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return false;
    let lo;
    let hi;
    if (body === "*" || body === "?") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
      lo = a;
      hi = b;
    } else {
      const n = Number(body);
      if (!Number.isInteger(n)) return false;
      lo = hi = n;
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

function rtCronMatches(expr, date) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.every((field, index) => rtCronFieldMatches(field, values[index], ranges[index][0], ranges[index][1]));
}

function rtCronNext(expr, from = Date.now()) {
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  const limit = from + 366 * RM_DAY_MS;
  while (cursor.getTime() <= limit) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (rtCronMatches(expr, cursor)) return cursor.getTime();
  }
  return null;
}

/** 例行规则的下一次（cron / once / interval）；事件触发没有下一次。 */
function rtNextAt(triggers, from = Date.now()) {
  let best = null;
  for (const trigger of triggers || []) {
    const endedAt = trigger?.ends?.at ? new Date(trigger.ends.at).getTime() : null;
    if (endedAt !== null && endedAt <= from) continue;
    let next = null;
    if (trigger?.type === "cron") next = rtCronNext(trigger.expr, from);
    else if (trigger?.type === "once") {
      const at = new Date(trigger.at).getTime();
      if (Number.isFinite(at) && at > from) next = at;
    } else if (trigger?.type === "interval") {
      next = from + Math.max(60, Number(trigger.seconds) || 60) * 1000;
    }
    if (Number.isFinite(next) && (best === null || next < best)) best = next;
  }
  return best;
}

/** 把一条简单例行规则翻成改时间弹窗能认的形状；复杂规则返回 null。 */
function rtScheduleOf(routine) {
  const triggers = Array.isArray(routine?.triggers) ? routine.triggers : [];
  if (triggers.length !== 1) return null;
  const trigger = triggers[0];
  const until = trigger?.ends?.at ? new Date(trigger.ends.at).getTime() : undefined;
  const at = rtNextAt([trigger], Date.now());
  if (!at) return null;
  if (trigger.type === "once") return { at, repeat: "none" };
  if (trigger.type !== "cron") return null;
  const [mi, hr, dom, mon, dow] = String(trigger.expr || "").trim().split(/\s+/);
  if (!/^\d+$/.test(mi || "") || !/^\d+$/.test(hr || "")) return null;
  if (dom !== "*" && mon === "*" && dow === "*" && /^\d+$/.test(dom || "")) {
    if (until) return null;
    return { at, repeat: "monthly", dayOfMonth: Number(dom) };
  }
  if (dow !== "*" && dom === "*" && mon === "*") {
    if (until) return null;
    const weekdays = String(dow).split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
    if (!weekdays.length) return null;
    return { at, repeat: "weekly", weekdays };
  }
  if (dom === "*" && dow === "*" && mon === "*") {
    return { at, repeat: until ? "range" : "daily", ...(until ? { until } : {}) };
  }
  return null;
}

function rtScheduleText(triggers) {
  if (!triggers.length) return "—";
  if (triggers.length === 1) {
    const trigger = triggers[0];
    if (trigger?.type === "once") return "一次性";
    if (trigger?.type === "cron") {
      const [mi, hr, dom, mon, dow] = String(trigger.expr || "").trim().split(/\s+/);
      if (/^\d+$/.test(mi || "") && /^\d+$/.test(hr || "")) {
        if (dom !== "*" && mon === "*" && dow === "*" && /^\d+$/.test(dom || "")) {
          return `每月${dom}号`;
        }
        if (dow !== "*" && dom === "*" && mon === "*") {
          const week = dow
            .split(",")
            .map((value) => (/^\d+$/.test(value) ? RT_WEEK[Number(value)] || value : value))
            .join("、");
          return `每周${week}`;
        }
        if (dom === "*" && dow === "*" && mon === "*") return "每天";
      }
    }
  }
  return triggers.map(rtTriggerText).join("；");
}

/** 定时主动轮（隐藏触发）那类的一句话频率（2026-11-17）。 */
function rmProactiveScheduleText(reminder) {
  const repeat = reminder.repeat || "none";
  if (repeat === "none") return "一次性";
  if (repeat === "daily") return reminder.until ? "每天（到结束日）" : "每天";
  if (repeat === "weekly") return rmWeeklyText(reminder.weekdays || []);
  if (repeat === "monthly") return `每月${reminder.dayOfMonth}号`;
  return "一次性";
}

function rmRoutineTriggers(schedule) {
  const date = new Date(schedule.at);
  const minute = date.getMinutes();
  const hour = date.getHours();
  const ends = schedule.until ? { ends: { at: new Date(schedule.until).toISOString() } } : {};
  if (schedule.repeat === "none") {
    return [{ type: "once", at: date.toISOString() }];
  }
  if (schedule.repeat === "daily") {
    return [{ type: "cron", expr: `${minute} ${hour} * * *`, ...ends }];
  }
  if (schedule.repeat === "weekly") {
    return [{ type: "cron", expr: `${minute} ${hour} * * ${(schedule.weekdays || []).join(",")}`, ...ends }];
  }
  if (schedule.repeat === "monthly") {
    return [{ type: "cron", expr: `${minute} ${hour} ${schedule.dayOfMonth} * *`, ...ends }];
  }
  return [{ type: "once", at: date.toISOString() }];
}

async function loadReminders() {
  const card = document.getElementById("reminder-card");
  if (!card) return;
  try {
    const [routinesResponse, remindersResponse, partnersResponse, memoryResponse] = await Promise.all([
      request("/api/v1/routines", { cache: "no-store" }),
      // 2026-11-17 定时主动轮：这类任务的触发消息对用户隐藏，是另一套端点/数据。
      request("/api/v1/agent/reminders", { cache: "no-store" }).catch(() => null),
      request("/api/v1/partners", { cache: "no-store" }),
      request("/api/v1/agent/memory/nightly", { cache: "no-store" }),
    ]);
    const routinesData = await routinesResponse.json().catch(() => ({}));
    const remindersData = remindersResponse ? await remindersResponse.json().catch(() => ({})) : {};
    const partnersData = await partnersResponse.json().catch(() => ({}));
    const memoryData = await memoryResponse.json().catch(() => ({}));
    const partners = partnersData.partners || state.partners || [];
    const nameById = new Map(partners.map((item) => [item.id, item.name || item.id]));
    const whoOf = (partnerId) => (partnerId ? (nameById.get(partnerId) || "同事") : "总管");

    const all = [];
    for (const routine of routinesData.routines || []) {
      const triggers = Array.isArray(routine.triggers) ? routine.triggers : [];
      const nextAt = rtNextAt(triggers);
      all.push({
        key: `run-${routine.id}`,
        kind: "run",
        id: routine.id,
        raw: routine,
        title: routine.name || "未命名",
        who: whoOf(routine.partnerId),
        personKey: routine.partnerId && routine.partnerId !== "chief" ? `partner:${routine.partnerId}` : "chief",
        at: nextAt || 0,
        enabled: Boolean(routine.enabled),
        editable: rtScheduleOf(routine) !== null,
        scheduleText: rtScheduleText(triggers),
      });
    }
    // 2026-11-17 定时主动轮：触发消息对用户隐藏的那类。数据本身就是弹窗能认的 schedule 形状。
    for (const reminder of remindersData.reminders || []) {
      if (reminder.status === "terminal") continue;
      all.push({
        key: `pro-${reminder.id}`,
        kind: "proactive",
        id: reminder.id,
        raw: reminder,
        title: reminder.text || "未命名",
        who: whoOf(reminder.partnerId),
        personKey: reminder.partnerId && reminder.partnerId !== "chief" ? `partner:${reminder.partnerId}` : "chief",
        at: reminder.at || 0,
        enabled: true,
        editable: true,
        scheduleText: rmProactiveScheduleText(reminder),
      });
    }
    const nightlyAt = Date.parse(memoryData.nextAt || "") || 0;
    for (const item of memoryData.scopes || []) {
      all.push({
        key: `mem-${item.scope}`,
        kind: "memory",
        id: item.scope,
        raw: item,
        title: "整理记忆",
        who: item.scope === "global" ? "总管" : item.label || "同事",
        personKey: item.scope === "global" ? "chief" : item.scope,
        at: nightlyAt,
        enabled: Boolean(memoryData.enabled) && item.enabled !== false,
        editable: true,
        scheduleText: `每天 ${memoryData.at || "03:30"}`,
        memoryScope: item.scope,
      });
    }

    if (!all.length) {
      card.innerHTML = `<div class="rm-empty">还没有定时任务</div>`;
      return;
    }

    all.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (a.at || Number.MAX_SAFE_INTEGER) - (b.at || Number.MAX_SAFE_INTEGER);
    });
    const personMap = new Map();
    for (const item of all) {
      const found = personMap.get(item.personKey);
      if (found) found.count += 1;
      else personMap.set(item.personKey, { key: item.personKey, label: item.who, count: 1 });
    }
    const people = [...personMap.values()];
    const savedFilter = state.reminderFilter || "all";
    const filter =
      savedFilter === "all" || people.some((item) => item.key === savedFilter) ? savedFilter : "all";
    state.reminderFilter = filter;
    const visible = filter === "all" ? all : all.filter((item) => item.personKey === filter);
    const list = visible.slice(0, 30);
    const filterBar =
      people.length > 1
        ? `<div class="rm-filter-bar">
            <span class="rm-filter-label">按人筛选</span>
            <select class="rm-filter-select" id="reminder-filter" aria-label="按人筛选">
              <option value="all"${filter === "all" ? " selected" : ""}>全部人 (${all.length})</option>
              ${people
                .map(
                  (item) =>
                    `<option value="${esc(item.key)}"${filter === item.key ? " selected" : ""}>${esc(
                      item.label,
                    )} (${item.count})</option>`,
                )
                .join("")}
            </select>
          </div>`
        : "";
    card.innerHTML =
      filterBar +
      (list.length
        ? list
            .map((item, index) => {
              const dayText = item.enabled ? (item.at ? rmDateText(item.at) : "—") : "已停";
              const timeText = item.enabled && item.at ? rmTimeText(item.at) : "";
              const actions = [];
              if (item.editable) {
                actions.push(`<button class="rm-edit" type="button" data-edit="${esc(item.key)}">改时间</button>`);
              }
              if (item.kind === "run") {
                actions.push(
                  `<button class="rm-edit" type="button" data-toggle="${esc(item.id)}" data-enabled="${
                    item.enabled ? "1" : "0"
                  }">${item.enabled ? "暂停" : "启用"}</button>`,
                );
              }
              if (item.kind === "memory") {
                if (memoryData.enabled) {
                  actions.push(
                    `<button class="rm-edit" type="button" data-memory-toggle="${esc(item.memoryScope)}" data-enabled="${
                      item.enabled ? "1" : "0"
                    }">${item.enabled ? "暂停" : "启用"}</button>`,
                  );
                }
                actions.push(
                  `<button class="rm-del" type="button" data-memory-del="${esc(item.memoryScope)}">删除</button>`,
                );
              }
              if (item.kind === "run" || item.kind === "proactive") {
                actions.push(`<button class="rm-del" type="button" data-del="${esc(item.key)}">删除</button>`);
              }
              return `${index ? '<div class="divider"></div>' : ""}
        <div class="rm-row${item.enabled ? "" : " is-off"}">
          <div class="rm-when">
            <div class="rm-when-day">${esc(dayText)}</div>
            <div class="rm-when-time">${esc(timeText)}</div>
          </div>
          <div class="rm-row-main">
            <div class="rm-row-text">${esc(item.title)} ${
              item.kind === "proactive"
                ? '<span class="rm-kind rm-kind-hidden">触发消息对我隐藏</span>'
                : item.kind === "run"
                  ? '<span class="rm-kind rm-kind-visible">触发消息可见</span>'
                  : ""
            }</div>
            <div class="rm-row-meta">${esc(item.who)} · ${item.scheduleText}</div>
          </div>
          <div class="rm-row-actions">${actions.join("")}</div>
        </div>`;
            })
            .join("")
        : `<div class="rm-empty">这个人还没有任务</div>`) +
      (visible.length > list.length
        ? `<div class="divider"></div><div class="rm-more">还有 ${visible.length - list.length} 条</div>`
        : "");

    card.querySelectorAll("[data-edit]").forEach((button) => {
      button.addEventListener("click", () => {
        const row = all.find((item) => item.key === button.dataset.edit);
        if (!row) return;
        if (row.kind === "memory") {
          openReminderModal({
            kind: "memory",
            id: row.memoryScope,
            text: "整理记忆",
            at: row.at,
            repeat: "daily",
          });
          return;
        }
        if (row.kind === "run") {
          const schedule = rtScheduleOf(row.raw);
          if (!schedule) return;
          openReminderModal({
            ...schedule,
            kind: "routine",
            id: row.raw.id,
            text: row.raw.name || "未命名",
            partnerId: row.raw.partnerId,
          });
          return;
        }
        if (row.kind === "proactive") {
          const raw = row.raw;
          const schedule = {
            at: raw.at,
            repeat: raw.repeat || "none",
            ...(raw.weekdays ? { weekdays: raw.weekdays } : {}),
            ...(raw.dayOfMonth ? { dayOfMonth: raw.dayOfMonth } : {}),
            ...(raw.until ? { until: raw.until } : {}),
          };
          openReminderModal({
            ...schedule,
            kind: "proactive",
            id: raw.id,
            text: raw.text || "未命名",
            partnerId: raw.partnerId,
          });
          return;
        }
      });
    });
    card.querySelector("#reminder-filter")?.addEventListener("change", (event) => {
      state.reminderFilter = event.target.value;
      void loadReminders();
    });
    card.querySelectorAll("[data-memory-toggle]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        await request(`/api/v1/agent/memory/nightly/${encodeURIComponent(button.dataset.memoryToggle)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: button.dataset.enabled !== "1" }),
        }).catch(() => undefined);
        void loadReminders();
      });
    });
    card.querySelectorAll("[data-memory-del]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        await request(`/api/v1/agent/memory/nightly/${encodeURIComponent(button.dataset.memoryDel)}`, {
          method: "DELETE",
        }).catch(() => undefined);
        void loadReminders();
      });
    });
    card.querySelectorAll("[data-toggle]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        await request(`/api/v1/routines/${encodeURIComponent(button.dataset.toggle)}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: button.dataset.enabled !== "1" }),
        }).catch(() => undefined);
        void loadReminders();
      });
    });
    card.querySelectorAll("[data-del]").forEach((button) => {
      button.addEventListener("click", async () => {
        const row = all.find((item) => item.key === button.dataset.del);
        if (!row) return;
        button.disabled = true;
        const endpoint =
          row.kind === "proactive"
            ? `/api/v1/agent/reminders/${encodeURIComponent(row.id)}`
            : `/api/v1/routines/${encodeURIComponent(row.id)}`;
        await request(endpoint, { method: "DELETE" }).catch(() => undefined);
        void loadReminders();
      });
    });
  } catch {
    card.innerHTML = `<div class="row"><div class="row-main">
      <div class="row-hint">读不到定时任务</div></div></div>`;
  }
}

/** 把已有的提醒翻成弹窗里的初始形态（2026-11-14 改时间用）。 */
function rmModeOf(item) {
  if (item.repeat === "daily") return item.until ? "range" : "daily";
  if (item.repeat === "weekly") return "weekly";
  if (item.repeat === "monthly") return "monthly";
  return "once";
}

/**
 * 手动加一条 / 改一条（2026-11-14 图形化；2026-11-17 加"触发消息隐藏/可见"）。
 *
 * 传 `reminder` = 改时间：内容只读、不出现「提醒什么」输入框；
 * 不传 = 新建：内容输入框保留，时间规则用图形化控件选。
 *
 * `reminder.kind` 两种（2026-11-17）：
 *  - "routine"（默认）= 例行任务，触发消息对用户可见（走 /api/v1/routines）；
 *  - "proactive" = 定时主动轮，触发指令对用户隐藏、只见对面主动冒一句（走 /api/v1/agent/reminders）。
 * 新建时由一个分段控件让用户选；编辑时沿用原任务类型、不让人中途换（换了等于删了重建）。
 */
function openReminderModal(reminder = null, onDone = null) {
  const memoryEditing = reminder?.kind === "memory";
  const editing = Boolean(
    reminder &&
      (memoryEditing || reminder.kind === "routine" || reminder.kind === "proactive" || reminder.status !== "terminal"),
  );
  // 新建时用户选：隐藏触发（定时主动轮）/ 可见触发（例行任务）；编辑时沿用原类型。
  let delivery = reminder?.kind === "proactive" ? "proactive" : "routine";
  const who = reminder?.partnerId
    ? (state.partners.find((item) => item.id === reminder.partnerId)?.name || "同事")
    : "总管";
  const initialAt = Number(reminder?.at || 0) || rmAt(
    new Date(rmStartOfDay(Date.now()).getTime() + RM_DAY_MS),
    9,
    0,
  );
  const initialDate = rmStartOfDay(initialAt);
  const initialTime = new Date(initialAt);
  const pick = {
    date: initialDate,
    hour: initialTime.getHours(),
    minute: initialTime.getMinutes(),
    end: reminder?.until ? rmStartOfDay(reminder.until) : null,
    weekdays:
      reminder?.weekdays?.length
        ? [...reminder.weekdays]
        : [initialDate.getDay()],
    dayOfMonth: reminder?.dayOfMonth || initialDate.getDate(),
    mode: reminder ? rmModeOf(reminder) : "once",
  };
  let view = new Date(initialDate.getFullYear(), initialDate.getMonth(), 1);

  openModal(
    editing ? "改时间" : "新建定时任务",
    (body) => {
      body.innerHTML = `
      <div class="rm-form">
        ${
          editing
            ? `<div class="rm-subject"><span class="rm-field-label">到点叫谁</span>
                 <div class="rm-subject-text">${esc(who)}</div></div>
               <div class="rm-subject"><span class="rm-field-label">做什么</span>
                 <div class="rm-subject-text">${esc(reminder.text || "提醒")}</div></div>`
            : `<div class="rm-field">
                 <span class="rm-field-label">到点做什么</span>
                 <input class="modal-input" id="reminder-text" type="text" maxlength="200" placeholder="例如：提醒我记日记" />
               </div>
               <div class="rm-field">
                 <span class="rm-field-label">到点叫谁</span>
                 <select class="modal-input" id="reminder-target">
                   <option value="">总管</option>
                   ${state.partners
                     .filter((item) => item.id !== "chief")
                     .map((item) => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`)
                     .join("")}
                 </select>
               </div>`
        }
        ${
          !editing
            ? `<div class="rm-mode-row rm-delivery-row">
                 <span class="rm-field-label" data-tip="隐藏=对面看起来像自己主动开口，看不到你发的那条触发指令；可见=会看到一条你发的触发消息，适合跟进类任务">触发消息</span>
                 <div class="rm-modes" role="radiogroup" aria-label="触发消息是否对我隐藏">
                   <button class="rm-mode" type="button" data-delivery="proactive" role="radio" aria-checked="false" data-tip="对面看起来像自己主动开口，看不到你发的那条指令">对我隐藏</button>
                   <button class="rm-mode is-on" type="button" data-delivery="routine" role="radio" aria-checked="true" data-tip="会看到一条你发的触发消息，适合跟进类任务">可见</button>
                 </div>
               </div>
               <p class="modal-hint rm-delivery-hint">「对我隐藏」：到点执事自己跑一轮说一句，你看不到那条触发指令，像它主动找你。「可见」：会留一条你发的触发消息，适合需要接着聊的跟进任务。</p>`
            : ""
        }
        <div class="rm-mode-row">
          <span class="rm-field-label">重复</span>
          <div class="rm-modes" role="radiogroup" aria-label="重复方式">
            <button class="rm-mode" type="button" data-mode="once" role="radio">单日</button>
            <button class="rm-mode" type="button" data-mode="range" role="radio">区间</button>
            <button class="rm-mode" type="button" data-mode="daily" role="radio">每天</button>
            <button class="rm-mode" type="button" data-mode="weekly" role="radio">每周</button>
            <button class="rm-mode" type="button" data-mode="monthly" role="radio">每月</button>
          </div>
        </div>
        <div class="rm-form-cols">
          <div class="rm-field rm-date-field">
            <span class="rm-field-label" id="reminder-date-label">哪一天</span>
            <div class="rm-date" id="reminder-date"></div>
          </div>
          <div class="rm-field rm-time-field">
            <span class="rm-field-label">几点</span>
            <div class="rm-wheel" id="reminder-wheel" role="group" aria-label="时间">
              <div class="rm-wheel-col" data-wheel="hour" aria-label="小时"></div>
              <span class="rm-wheel-mark">:</span>
              <div class="rm-wheel-col" data-wheel="minute" aria-label="分钟"></div>
            </div>
          </div>
        </div>
        <p class="modal-hint rm-hint" id="reminder-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>取消</button>
          <button class="modal-primary" id="reminder-confirm" type="button">${editing ? "保存" : "添加"}</button>
        </div>
      </div>`;

      const dateBox = body.querySelector("#reminder-date");
      const dateLabel = body.querySelector("#reminder-date-label");
      const wheel = body.querySelector("#reminder-wheel");
      const hint = body.querySelector("#reminder-hint");
      const confirm = body.querySelector("#reminder-confirm");
      const textInput = body.querySelector("#reminder-text");
      const targetSelect = body.querySelector("#reminder-target");

      /* ── 滚轮 ───────────────────────────────────────── */
      const wheelColumns = [];
      for (const [name, count] of [["hour", 24], ["minute", 60]]) {
        const column = wheel.querySelector(`[data-wheel="${name}"]`);
        column.innerHTML = Array.from({ length: count }, (_, index) => {
          const value = rmPad(index);
          return `<button class="rm-wheel-item" type="button" data-wheel-value="${index}" aria-pressed="false">${value}</button>`;
        }).join("");
        wheelColumns.push({ name, column, max: count - 1 });
      }

      const paintWheel = () => {
        for (const { name, column } of wheelColumns) {
          for (const item of column.children) {
            const on = Number(item.dataset.wheelValue) === pick[name];
            item.classList.toggle("is-on", on);
            item.setAttribute("aria-pressed", String(on));
          }
        }
      };

      let scrollTick = 0;
      for (const { name, column, max } of wheelColumns) {
        column.addEventListener("scroll", () => {
          cancelAnimationFrame(scrollTick);
          scrollTick = requestAnimationFrame(() => {
            const index = Math.max(0, Math.min(max, Math.round(column.scrollTop / RM_ITEM_H)));
            if (pick[name] === index) return;
            pick[name] = index;
            paintWheel();
            sync();
          });
        });
      }

      wheel.addEventListener("click", (event) => {
        const item = event.target.closest("[data-wheel-value]");
        if (!item) return;
        const column = item.closest("[data-wheel]");
        const index = Number(item.dataset.wheelValue);
        pick[column.dataset.wheel] = index;
        column.scrollTo({ top: index * RM_ITEM_H, behavior: "smooth" });
        paintWheel();
        sync();
      });

      /* ── 日期 ───────────────────────────────────────── */
      const renderCalendar = () => {
        const year = view.getFullYear();
        const month = view.getMonth();
        const lead = (new Date(year, month, 1).getDay() + 6) % 7; // 周一打头
        const days = new Date(year, month + 1, 0).getDate();
        const today = rmStartOfDay(Date.now());
        const range = pick.mode === "range";
        const start = rmStartOfDay(pick.date).getTime();
        const end = pick.end ? rmStartOfDay(pick.end).getTime() : null;
        let cells = '<span class="rm-cal-pad"></span>'.repeat(lead);
        for (let day = 1; day <= days; day += 1) {
          const date = new Date(year, month, day);
          const stamp = date.getTime();
          const past = date < today;
          const isStart = range ? stamp === start : stamp === rmStartOfDay(pick.date).getTime();
          const isEnd = range && end !== null && stamp === end;
          const inRange = range && end !== null && stamp > start && stamp < end;
          const isToday = stamp === today.getTime();
          cells += `<button class="rm-cal-day${isStart ? " is-on is-range-start" : ""}${
            isEnd ? " is-range-end" : ""
          }${inRange ? " is-in-range" : ""}${isToday && !isStart ? " is-today" : ""}" type="button"
            data-day="${day}"${past ? " disabled" : ""} aria-pressed="${isStart || isEnd}">${day}</button>`;
        }
        return `
        <div class="rm-cal">
          <div class="rm-cal-head">
            <button class="rm-cal-nav" type="button" data-cal="prev" aria-label="上个月">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <div class="rm-cal-title">${year} 年 ${month + 1} 月</div>
            <button class="rm-cal-nav" type="button" data-cal="next" aria-label="下个月">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>
          <div class="rm-cal-dow">${["一", "二", "三", "四", "五", "六", "日"].map((label) => `<span>${label}</span>`).join("")}</div>
          <div class="rm-cal-grid">${cells}</div>
        </div>`;
      };

      const renderDate = () => {
        dateBox.classList.toggle(
          "is-calendar",
          pick.mode === "once" || pick.mode === "range",
        );
        if (pick.mode === "daily") {
          dateLabel.textContent = "日期";
          dateBox.innerHTML = `<div class="rm-date-note"><strong>每天</strong><span>不用选日期</span></div>`;
          return;
        }
        if (pick.mode === "weekly") {
          dateLabel.textContent = "星期几";
          dateBox.innerHTML = `
            <div class="rm-week">${RM_WEEK_SHORT.map((label, index) => {
              const on = pick.weekdays.includes(index);
              return `<button class="rm-weekday${on ? " is-on" : ""}" type="button" data-weekday="${index}" aria-pressed="${on}">${label}</button>`;
            }).join("")}</div>
            <div class="rm-date-note is-compact">${esc(rmWeeklyText(pick.weekdays))}</div>`;
          return;
        }
        if (pick.mode === "monthly") {
          dateLabel.textContent = "每月几号";
          dateBox.innerHTML = `
            <div class="rm-month-grid">${Array.from({ length: 31 }, (_, index) => {
              const day = index + 1;
              const on = day === pick.dayOfMonth;
              return `<button class="rm-month-day${on ? " is-on" : ""}" type="button" data-month-day="${day}" aria-pressed="${on}">${day}</button>`;
            }).join("")}</div>
            <div class="rm-date-note is-compact">每月 ${pick.dayOfMonth} 号${pick.dayOfMonth > 28 ? "（小月按月末）" : ""}</div>`;
          return;
        }
        if (pick.mode === "range") {
          dateLabel.textContent = "起止日期";
          dateBox.innerHTML =
            renderCalendar() +
            `<div class="rm-range-note"><span>开始 ${esc(rmShortDate(pick.date))}</span><span>结束 ${
              pick.end ? esc(rmShortDate(pick.end)) : "未选"
            }</span></div>`;
          return;
        }
        dateLabel.textContent = "哪一天";
        dateBox.innerHTML = renderCalendar();
      };

      dateBox.addEventListener("click", (event) => {
        const nav = event.target.closest("[data-cal]");
        if (nav) {
          const step = nav.dataset.cal === "next" ? 1 : -1;
          view = new Date(view.getFullYear(), view.getMonth() + step, 1);
          renderDate();
          return;
        }
        const weekday = event.target.closest("[data-weekday]");
        if (weekday) {
          const index = Number(weekday.dataset.weekday);
          pick.weekdays = pick.weekdays.includes(index)
            ? pick.weekdays.filter((value) => value !== index)
            : [...pick.weekdays, index];
          renderDate();
          sync();
          return;
        }
        const monthDay = event.target.closest("[data-month-day]");
        if (monthDay) {
          pick.dayOfMonth = Number(monthDay.dataset.monthDay);
          renderDate();
          sync();
          return;
        }
        const day = event.target.closest("[data-day]");
        if (!day || day.disabled) return;
        const date = new Date(view.getFullYear(), view.getMonth(), Number(day.dataset.day));
        if (pick.mode === "range") {
          if (!pick.end) {
            if (date < rmStartOfDay(pick.date)) pick.date = date;
            else pick.end = date;
          } else {
            pick.date = date;
            pick.end = null;
          }
        } else {
          pick.date = date;
        }
        renderDate();
        sync();
      });

      /* ── 触发消息：隐藏 / 可见（2026-11-17）────────── */
      body.querySelectorAll("[data-delivery]").forEach((button) => {
        button.addEventListener("click", () => {
          delivery = button.dataset.delivery;
          body.querySelectorAll("[data-delivery]").forEach((b) => {
            const on = b.dataset.delivery === delivery;
            b.classList.toggle("is-on", on);
            b.setAttribute("aria-checked", on ? "true" : "false");
          });
        });
      });

      /* ── 模式 / 提交 ────────────────────────────────── */
      body.querySelectorAll("[data-mode]").forEach((button) => {
        if (memoryEditing && button.dataset.mode !== "daily") button.disabled = true;
        button.addEventListener("click", () => {
          if (button.disabled) return;
          pick.mode = button.dataset.mode;
          if (pick.mode === "range") {
            if (!pick.end) {
              pick.end = null;
            }
          }
          if (pick.mode === "weekly" && pick.weekdays.length === 0) {
            pick.weekdays = [new Date(pick.date).getDay()];
          }
          if (pick.mode === "monthly") {
            pick.dayOfMonth = new Date(pick.date).getDate();
          }
          renderDate();
          sync();
        });
      });

      const selectedAt = () => {
        if (pick.mode === "daily") return rmNextDaily(pick.hour, pick.minute);
        if (pick.mode === "weekly") {
          return rmNextWeekly(pick.weekdays, pick.hour, pick.minute) ?? 0;
        }
        if (pick.mode === "monthly") {
          return rmNextMonthly(pick.dayOfMonth, pick.hour, pick.minute) ?? 0;
        }
        return rmAt(pick.date, pick.hour, pick.minute);
      };

      const selectedUntil = () => {
        if (pick.mode !== "range") return undefined;
        if (!pick.end) return undefined;
        return rmStartOfDay(pick.end).getTime() + RM_DAY_MS - 1;
      };

      function sync() {
        for (const button of body.querySelectorAll("[data-mode]")) {
          const on = button.dataset.mode === pick.mode;
          button.classList.toggle("is-on", on);
          button.setAttribute("aria-checked", String(on));
        }
        // 不在没填完时就报红：只把「添加」保持可用，点下去再指出缺哪一项。
        hint.textContent = "";
        hint.classList.remove("is-error");
        confirm.disabled = false;
      }

      body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
      textInput?.addEventListener("input", sync);
      textInput?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      });

      const payload = () => {
        const at = selectedAt();
        const until = selectedUntil();
        const repeat =
          pick.mode === "range"
            ? "daily"
            : pick.mode === "daily"
              ? "daily"
              : pick.mode === "weekly"
                ? "weekly"
                : pick.mode === "monthly"
                  ? "monthly"
                  : "none";
        return {
          at,
          repeat,
          ...(pick.mode === "weekly" ? { weekdays: [...pick.weekdays].sort((a, b) => a - b) } : {}),
          ...(pick.mode === "monthly" ? { dayOfMonth: pick.dayOfMonth } : {}),
          ...(until ? { until } : {}),
        };
      };

      async function submit() {
        if (!editing && !(textInput?.value || "").trim()) {
          hint.textContent = "先写点到点做什么。";
          hint.classList.add("is-error");
          textInput.focus();
          return;
        }
        if (pick.mode === "weekly" && pick.weekdays.length === 0) {
          hint.textContent = "至少选一个星期几。";
          hint.classList.add("is-error");
          return;
        }
        if (pick.mode === "range" && !pick.end) {
          hint.textContent = "再选一个结束日期。";
          hint.classList.add("is-error");
          return;
        }
        if (
          pick.mode === "range" &&
          rmStartOfDay(pick.end).getTime() <= rmStartOfDay(pick.date).getTime()
        ) {
          hint.textContent = "结束日期要晚于开始日期。";
          hint.classList.add("is-error");
          return;
        }
        const text = editing ? reminder.text : textInput.value.trim();
        const target = targetSelect?.value || "";
        if (memoryEditing) {
          confirm.disabled = true;
          hint.textContent = "保存中…";
          hint.classList.remove("is-error");
          try {
            const response = await request("/api/v1/agent/memory/nightly", {
              method: "PATCH",
              body: JSON.stringify({ at: `${rmPad(pick.hour)}:${rmPad(pick.minute)}` }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
              hint.textContent = data.message || `没保存：HTTP ${response.status}`;
              hint.classList.add("is-error");
              confirm.disabled = false;
              return;
            }
            toast("时间已改");
            closeModal();
            void loadReminders();
            if (typeof onDone === "function") onDone();
          } catch {
            hint.textContent = "没保存：网络请求失败。";
            hint.classList.add("is-error");
            confirm.disabled = false;
          }
          return;
        }
        const schedule = payload();
        if (!schedule.at || schedule.at <= Date.now()) {
          hint.textContent = "这个时间已经过去了。";
          hint.classList.add("is-error");
          return;
        }
        confirm.disabled = true;
        hint.textContent = editing ? "保存中…" : "添加中…";
        hint.classList.remove("is-error");
        try {
          // 2026-11-17：按"触发消息隐藏/可见"分两路。编辑时沿用原类型（不中途换）。
          const kind = editing ? reminder.kind : delivery;
          const method = editing ? "PATCH" : "POST";
          let endpoint;
          let bodyData;
          if (kind === "proactive") {
            // 隐藏触发 → /agent/reminders：这套任务到点跑模型、触发指令对用户隐藏。
            endpoint = editing
              ? `/api/v1/agent/reminders/${encodeURIComponent(reminder.id)}`
              : "/api/v1/agent/reminders";
            bodyData = editing
              ? { ...schedule }
              : { partnerId: target || null, text, ...schedule };
          } else {
            // 可见触发 → /routines：例行任务（沿用原逻辑）。
            endpoint = editing
              ? `/api/v1/routines/${encodeURIComponent(reminder.id)}`
              : "/api/v1/routines";
            bodyData = editing
              ? { triggers: rmRoutineTriggers(schedule) }
              : {
                  partnerId: target || "chief",
                  name: text.slice(0, 40),
                  prompt: text,
                  triggers: rmRoutineTriggers(schedule),
                  sessionMode: "persistent",
                  enabled: true,
                };
          }
          const response = await request(endpoint, {
            method,
            body: JSON.stringify(bodyData),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            hint.textContent = data.message || `没保存：HTTP ${response.status}`;
            hint.classList.add("is-error");
            confirm.disabled = false;
            return;
          }
          closeModal();
          toast(editing ? "时间已改" : "定时任务已添加");
          void loadReminders();
          if (typeof onDone === "function") onDone();
        } catch (error) {
          if (error.message !== "forbidden") {
            hint.textContent = `没保存：${error.message}`;
            hint.classList.add("is-error");
          }
          confirm.disabled = false;
        }
      }

      confirm.addEventListener("click", () => void submit());

      renderDate();
      paintWheel();
      sync();
      // 等一帧让滚轮列有高度，再滚到默认时间；scrollTop 按 36px 一行对齐。
      requestAnimationFrame(() => {
        for (const { name, column } of wheelColumns) {
          column.scrollTop = pick[name] * RM_ITEM_H;
        }
        paintWheel();
      });
    },
    { className: "modal-reminder" },
  );
}

async function loadPolicy() {
  const box = document.getElementById("policy-switch");
  if (!box) return;
  // 先量一次胶囊（此时还没有选中项，量不到就等拿到 policy 再量）
  mountSegmented(box);
  let data = null;
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    data = await response.json();
    for (const button of box.querySelectorAll("[data-policy]")) {
      button.setAttribute("aria-checked", String(button.dataset.policy === data.access));
    }
  } catch {
    /* 离线就保持原样 */
  }
  // 高亮胶囊跟到服务端返回的那一档（没有选中项时自己隐藏）
  syncSegmented(box);
  for (const button of box.querySelectorAll("[data-policy]")) {
    button.addEventListener("click", async () => {
      for (const other of box.querySelectorAll("[data-policy]")) {
        other.setAttribute("aria-checked", String(other === button));
      }
      // 只改属性、不重建 DOM：重建会把滑行高亮层一起丢掉
      syncSegmented(box);
      await request("/api/v1/agent/policy", {
        method: "POST",
        body: JSON.stringify({ access: button.dataset.policy }),
      }).catch(() => undefined);
    });
  }

  // 审批三档（2026-11-08 扫尾批 10-C）：独立轴，与上面三档可以同时生效。
  // 旧客户端只认派生的 confirmWrites 布尔，新界面读 approvalLevel。
  const approval = document.getElementById("policy-approval-level");
  if (approval) {
    mountSegmented(approval);
    if (data) {
      for (const button of approval.querySelectorAll("[data-approval]")) {
        button.setAttribute("aria-checked", String(button.dataset.approval === data.approvalLevel));
      }
    }
    syncSegmented(approval);
    for (const button of approval.querySelectorAll("[data-approval]")) {
      button.addEventListener("click", async () => {
        for (const other of approval.querySelectorAll("[data-approval]")) {
          other.setAttribute("aria-checked", String(other === button));
        }
        syncSegmented(approval);
        await request("/api/v1/agent/policy", {
          method: "POST",
          body: JSON.stringify({ approvalLevel: button.dataset.approval }),
        }).catch(() => undefined);
      });
    }
  }
}

/**
 * 默认模型卡（2026-11-12 M1；原 2026-11-04 批次五的一行下拉退役）。
 *
 * 数据源不变：GET /agent/model（接口文档 §2.8）。两行结构：
 * - `mdl-current` 模型名（放大，页面第一眼）；
 * - `mdl-hint`  供应商 + 生效时机。
 * 可切时右侧出「更换」，弹层复用对话 pill 的 model-menu（供应商分段 + 模型行），
 * 弹层里选完由 modelchange 收回并重填本卡；不可切（faux / 只有一个模型）不出按钮。
 * 2026-11-05 G1 热修：models 自思考档位起是对象行 {id, thinkingLevels}（兼容裸字符串），
 * 统一走 normalizeModelRow（与模型菜单同一份归一化）。
 */
function renderDefaultModelRow(catalog) {
  const name = document.getElementById("mdl-current");
  const hint = document.getElementById("mdl-hint");
  const change = document.getElementById("mdl-change");
  if (!name || !hint || !change) return;
  const current = catalog && catalog.current ? catalog.current : null;
  const providers = (catalog && catalog.providers ? catalog.providers : [])
    .map((provider) => ({
      ...provider,
      models: (Array.isArray(provider.models) ? provider.models : [])
        .map(normalizeModelRow)
        .filter(Boolean),
    }))
    .filter((provider) => provider.models.length > 0);
  const total = providers.reduce((count, provider) => count + provider.models.length, 0);
  const providerName =
    providers.find((provider) => provider.id === current?.providerId)?.name ||
    current?.providerId ||
    "";
  const paint = (title, sub) => {
    name.textContent = title;
    hint.textContent = sub;
  };

  change.hidden = true;
  if (!current) {
    paint("未配置", "配好 LLM_API_KEY 会播种一个默认供应商");
    return;
  }
  if (current.providerId === "faux") {
    paint("faux", "假模型（链路验证用），没有可切的真实模型");
    return;
  }
  paint(current.modelId, `${providerName} · 切换后下一轮对话生效`);
  if (total < 2) {
    hint.textContent = `${providerName} · 在下面多填几个模型就能换`;
    return;
  }

  // 可切：出「更换」。onclick 直接赋值（不是 addEventListener），
  // 卡片会随 modelchange / 重进页重绘，避免监听叠加成"点一次开两次"。
  change.hidden = false;
  change.onclick = async () => {
    const menu = document.getElementById("mdl-menu");
    if (!menu) return;
    if (popoverOpen(menu)) {
      closePopover(menu, change);
      return;
    }
    change.disabled = true;
    try {
      // 每次打开现拉：不缓存陈旧目录（同对话 pill 的模型菜单）
      const fresh = await fetchModelCatalog();
      state.modelCatalog = fresh;
      // 设置页的选择器只选模型：不要对话页那排思考强度分段（那是会话级偏好，
      // 放进"换默认模型"里会被当成模型属性）。chooseModel 的 keepOpen 重渲染
      // 读同一个 dataset，所以这条标记会一直生效到菜单关闭。
      menu.dataset.noThinking = "1";
      renderModelMenu(fresh, localStorage.getItem(KEY_MODEL_PROVIDER), menu);
      openPopover(menu, change);
    } catch (error) {
      if (error.message !== "forbidden") toast("拿不到模型清单");
    } finally {
      change.disabled = false;
    }
  };
}

export { loadPolicy, loadReminders, openReminderModal, renderDefaultModelRow, rmDateText, rmDayDiff, rmStartOfDay, rmTimeText };
