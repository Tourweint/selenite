/**
 * 定时任务页 + 统一编辑器（2026-11-17 重做）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 2026-11-14 手动创建重做：滚轮时间 + 图形化日期，支持单日 / 区间 / 每天 / 每周 / 每月。
 * 2026-11-14 合并「定时任务」页：一张清单；每条任务只记目标（总管 / 员工）、提示词和时间。
 * 2026-11-17 重做：定时任务页与人设页共用同一张清单 + 同一个编辑器（openScheduledTaskModal）；
 * 手动新建统一走 reminders（保住手机本地闹钟），例行规则在同一清单里只读高级触发、内容可改；
 * 提醒补齐编辑内容 / 暂停 / 立即跑 / 历史 / 触发可见性。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { fetchModelCatalog, normalizeModelRow, renderModelMenu } from "./hover-tip.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { openSecMenu } from "./sec-menu.js";
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

/* 总览里不摊 cron 原文：只给一句人话。cron 的星期数字也翻成中文。纯文本，调用方负责 esc。 */
const RT_WEEK = ["日", "一", "二", "三", "四", "五", "六"];
function rtTriggerText(trigger) {
  if (!trigger) return "—";
  // 2026-11-17：这里不能再借 partner-modals 的 ptHumanizeTrigger（会成环），
  // 非 cron 三型自己翻人话；interval/event 也是 Agent 建的合法高级触发。
  if (trigger.type === "interval") {
    const seconds = Number(trigger.seconds) || 0;
    const minutes = seconds / 60;
    return Number.isInteger(minutes) && minutes > 0 ? `每 ${minutes} 分钟` : `每 ${seconds} 秒`;
  }
  if (trigger.type === "once") {
    const at = trigger.at ? new Date(trigger.at) : null;
    const shown =
      at && !Number.isNaN(at.getTime()) ? at.toLocaleString("zh-CN") : String(trigger.at || "");
    return `一次性 · ${shown}`;
  }
  if (trigger.type === "event") {
    const kind = String(trigger.kind || "");
    const matchText =
      trigger.match && Object.keys(trigger.match).length
        ? Object.entries(trigger.match)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")
        : "";
    return `事件 · ${kind}${matchText ? `（${matchText}）` : ""}`;
  }
  if (trigger.type !== "cron") return "—";
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
  return human;
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
    }
    // interval / event 没有从列表可算准确的下一次（真实下一跳在 durable 任务里），
    // 不拿 now+间隔冒充；行里只显示「每 N 分钟 / 事件 · …」。
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
      const endText = trigger.ends?.at ? `（到 ${rmShortDate(trigger.ends.at)}）` : "";
      if (/^\d+$/.test(mi || "") && /^\d+$/.test(hr || "")) {
        if (dom !== "*" && mon === "*" && dow === "*" && /^\d+$/.test(dom || "")) {
          return `每月${dom}号${endText}`;
        }
        if (dow !== "*" && dom === "*" && mon === "*") {
          const week = dow
            .split(",")
            .map((value) => (/^\d+$/.test(value) ? RT_WEEK[Number(value)] || value : value))
            .join("、");
          return `每周${week}${endText}`;
        }
        if (dom === "*" && dow === "*" && mon === "*") return `每天${endText}`;
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

/** 改时间时保留高级触发里与时间无关的附加条件（if / ends.after）。 */
function rmMergeTriggerExtras(trigger, original) {
  const next = { ...trigger };
  if (original?.if) next.if = original.if;
  const ends = { ...(original?.ends || {}), ...(trigger.ends || {}) };
  if (Object.keys(ends).length > 0) next.ends = ends;
  return next;
}

/* ── 统一定时任务清单（2026-11-17 定时任务重做）──────────────
 * 定时任务页与人设页共用：routine（Agent/高级规则）、reminder（手动新建/主动轮）、
 * memory（每晚整理）三种来源先归一成同一种 item，再画同一套行。
 * 行动作按 kind 路由到各自端点；历史也各取各的，但长得一样。 */

const TASK_RUN_STATUS = {
  success: { text: "成功", cls: "" },
  failed: { text: "失败", cls: "warn" },
  interrupted: { text: "中断", cls: "warn" },
  skipped: { text: "跳过", cls: "" },
  running: { text: "运行中", cls: "" },
  queued: { text: "排队", cls: "" },
};

function taskTitleOf(text, limit = 40) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean) || "";
  return line.slice(0, limit) || "未命名";
}

function taskPersonOf(partnerId, nameById) {
  if (!partnerId || partnerId === "chief") return { key: "chief", label: "总管" };
  return { key: `partner:${partnerId}`, label: nameById.get(partnerId) || "同事" };
}

function taskPersonLabel(partnerId) {
  if (!partnerId || partnerId === "chief") return "总管";
  return state.partners.find((item) => item.id === partnerId)?.name || "同事";
}

function routineTaskItem(routine, nameById) {
  const person = taskPersonOf(routine.partnerId, nameById);
  const triggers = Array.isArray(routine.triggers) ? routine.triggers : [];
  return {
    key: `routine-${routine.id}`,
    kind: "routine",
    id: routine.id,
    partnerId: routine.partnerId,
    personKey: person.key,
    who: person.label,
    title: routine.name || taskTitleOf(routine.prompt),
    instruction: routine.prompt || "",
    // 老服务端（未重启）不返回 prompt：先锁编辑，避免空正文覆盖掉原指令。
    promptMissing: typeof routine.prompt !== "string",
    scheduleText: rtScheduleText(triggers),
    nextAt: rtNextAt(triggers),
    enabled: Boolean(routine.enabled),
    visibility: "visible",
    canPause: true,
    canRunNow: true,
    canHistory: true,
    canDelete: true,
    raw: routine,
  };
}

function reminderTaskItem(reminder, nameById) {
  const person = taskPersonOf(reminder.partnerId, nameById);
  const repeat = reminder.repeat || "none";
  return {
    key: `reminder-${reminder.reminderId}`,
    kind: "reminder",
    id: reminder.id,
    reminderId: reminder.reminderId,
    partnerId: reminder.partnerId,
    personKey: person.key,
    who: person.label,
    title: taskTitleOf(reminder.text),
    instruction: reminder.text || "",
    scheduleText: rmProactiveScheduleText(reminder),
    nextAt: Number(reminder.at || 0),
    enabled: reminder.enabled !== false,
    visibility: reminder.visibility === "visible" ? "visible" : "hidden",
    // 一次性提醒没有可恢复的持久定义：暂停等于静默终止，UI 不提供。
    canPause: repeat !== "none",
    canRunNow: true,
    canHistory: true,
    canDelete: true,
    raw: reminder,
  };
}

function memoryTaskItem(item, memoryData, nameById) {
  const scope = String(item.scope || "");
  const partnerId = scope === "global" ? "chief" : scope.startsWith("partner:") ? scope.slice(8) : null;
  const person = taskPersonOf(partnerId, nameById);
  return {
    key: `memory-${scope}`,
    kind: "memory",
    id: scope,
    memoryScope: scope,
    partnerId,
    personKey: person.key,
    who: scope === "global" ? "总管" : item.label || person.label,
    title: "整理记忆",
    instruction: "把长记忆拆成短原子（原文存进原文档案），再回看重复、过时、说法不一致的条目；只出建议，你点应用才改。",
    scheduleText: `每天 ${memoryData.at || "03:30"}`,
    nextAt: Date.parse(memoryData.nextAt || "") || 0,
    enabled: Boolean(memoryData.enabled) && item.enabled !== false,
    visibility: "",
    // 总开关关着时单个任务改不了；开着就能暂停/启用。
    canPause: Boolean(memoryData.enabled),
    canRunNow: false,
    canHistory: false,
    canDelete: true,
    raw: item,
  };
}

function taskRunTime(run) {
  const at = run.endedAt || run.startedAt || (run.at ? new Date(run.at).toISOString() : "");
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString("zh-CN") : "";
}

function taskTriggerText(run) {
  if (run.trigger === "manual") return "手动";
  if (run.trigger === "scheduled") return "按计划";
  return String(run.trigger || "");
}

function renderTaskRuns(box, runs) {
  const list = (Array.isArray(runs) ? runs : []).slice(0, 10);
  if (list.length === 0) {
    box.innerHTML = `<div class="set-hint">还没有执行记录。</div>`;
    return;
  }
  box.innerHTML = list
    .map((run) => {
      const info = TASK_RUN_STATUS[run.status] || { text: run.status || "未知", cls: "" };
      const summary = String(run.summary || "").replace(/\s+/g, " ").trim().slice(0, 200);
      return `<div class="rm-run">
        <span class="pill-tag ${info.cls}">${esc(info.text)}</span>
        <span class="rm-run-trigger">${esc(taskTriggerText(run))}</span>
        <span class="rm-run-summary">${esc(summary || "—")}</span>
        <span class="rm-run-time">${esc(taskRunTime(run))}</span>
      </div>`;
    })
    .join("");
}

function taskDeleteEndpoint(item) {
  if (item.kind === "memory") {
    return `/api/v1/agent/memory/nightly/${encodeURIComponent(item.memoryScope)}`;
  }
  if (item.kind === "reminder") {
    return `/api/v1/agent/reminders/${encodeURIComponent(item.id)}`;
  }
  return `/api/v1/routines/${encodeURIComponent(item.id)}`;
}

function taskRunsEndpoint(item) {
  if (item.kind === "reminder") {
    return `/api/v1/agent/reminders/${encodeURIComponent(item.reminderId)}/runs`;
  }
  return `/api/v1/routines/${encodeURIComponent(item.id)}/runs`;
}

function confirmDeleteTask(item, onChanged) {
  openModal("删除定时任务", (body) => {
    body.innerHTML = `
      <p class="modal-desc">确定删除「${esc(item.title)}」？提醒任务会取消后续续排；例行规则的在飞任务醒来会自动作废。</p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="task-del-go">删除</button>
      </div>`;
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    body.querySelector("#task-del-go")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await request(taskDeleteEndpoint(item), { method: "DELETE" });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          toast(`没删成：${data.message || data.error || response.status}`);
          button.disabled = false;
          return;
        }
        toast("已删除");
        closeModal();
        if (typeof onChanged === "function") onChanged();
      } catch (error) {
        if (error.message !== "forbidden") toast(`没删成：${error.message}`);
        button.disabled = false;
      }
    });
  });
}

/** 打开编辑器；老服务端没返回 prompt 时先拦住，避免空正文覆盖原指令。 */
function openTaskEditor(item, onChanged) {
  if (item.kind === "routine" && item.promptMissing === true) {
    toast("服务端还没重启，读不到指令正文；先重启再编辑，避免空正文覆盖");
    return;
  }
  openScheduledTaskModal({ mode: "edit", item }, onChanged);
}

function taskToggleEndpoint(item) {
  if (item.kind === "memory") {
    return `/api/v1/agent/memory/nightly/${encodeURIComponent(item.memoryScope)}`;
  }
  if (item.kind === "reminder") {
    return `/api/v1/agent/reminders/${encodeURIComponent(item.id)}`;
  }
  return `/api/v1/routines/${encodeURIComponent(item.id)}`;
}

async function taskToggleEnabled(item, onChanged) {
  const next = !item.enabled;
  try {
    const response = await request(taskToggleEndpoint(item), {
      method: "PATCH",
      body: JSON.stringify({ enabled: next }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(`没切换：${data.message || data.error || response.status}`);
      return;
    }
    toast(next ? "已启用" : "已暂停");
    if (onChanged) onChanged();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没切换：${error.message}`);
  }
}

async function taskRunNow(item, onChanged) {
  // 菜单点完就收了，补一条「跑中」回执（旧版靠按钮文字变化）。
  toast("正在跑一轮…");
  try {
    const endpoint =
      item.kind === "reminder"
        ? `/api/v1/agent/reminders/${encodeURIComponent(item.id)}/run_now`
        : `/api/v1/routines/${encodeURIComponent(item.id)}/run_now`;
    const response = await request(endpoint, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      toast(`没跑成：${data.message || data.error || response.status}`);
      return;
    }
    toast("已跑完一轮");
    if (onChanged) onChanged();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没跑成：${error.message}`);
  }
}

/** 历史就地展开；再点一次收起（菜单项文案跟着当前状态变）。 */
async function taskToggleHistory(item, itemNode) {
  const runsBox = itemNode?.querySelector(".rm-runs");
  if (!runsBox) return;
  if (!runsBox.hidden) {
    runsBox.hidden = true;
    return;
  }
  runsBox.hidden = false;
  runsBox.innerHTML = `<div class="set-hint">读取中…</div>`;
  try {
    const response = await request(taskRunsEndpoint(item), { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));
    renderTaskRuns(runsBox, data.runs);
  } catch (error) {
    if (error.message !== "forbidden") {
      runsBox.innerHTML = `<div class="set-hint is-error">读不到历史：${esc(error.message)}</div>`;
    }
  }
}

/** 行右侧 ⋯ 的菜单项（2026-11-18）：常驻按钮全部收进这里，行本身点开就是编辑。 */
function taskMenuItems(item, itemNode, onChanged) {
  const runsBox = itemNode?.querySelector(".rm-runs");
  const editLocked = item.kind === "routine" && item.promptMissing === true;
  const items = [
    item.kind === "memory"
      ? { label: "改时间", run: () => openTaskEditor(item, onChanged) }
      : {
          label: "编辑",
          ...(editLocked
            ? { hint: "服务端还没重启，读不到指令正文", disabled: true }
            : {}),
          run: () => openTaskEditor(item, onChanged),
        },
  ];
  if (item.canPause) {
    items.push({
      label: item.enabled ? "暂停" : "启用",
      run: () => void taskToggleEnabled(item, onChanged),
    });
  }
  if (item.canRunNow) {
    items.push({ label: "立即跑", run: () => void taskRunNow(item, onChanged) });
  }
  if (item.canHistory) {
    items.push({
      label: runsBox && !runsBox.hidden ? "收起历史" : "历史",
      run: () => void taskToggleHistory(item, itemNode),
    });
  }
  items.push({ separator: true });
  items.push({ label: "删除", danger: true, run: () => confirmDeleteTask(item, onChanged) });
  return items;
}

/**
 * 一张清单的渲染与动作（2026-11-17）。
 * `items` 由三个 XxxTaskItem 归一；`options.onChanged` 在删/暂停/编辑后由调用方重拉。
 * 2026-11-18：行内不再铺动作按钮/类型徽章/指令预览——整行点开就是编辑，其余动作进右侧 ⋯。
 */
function renderScheduledTaskList(box, items, options = {}) {
  if (!box) return;
  const all = [...items];
  const onChanged = typeof options.onChanged === "function" ? options.onChanged : null;
  all.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.nextAt || Number.MAX_SAFE_INTEGER) - (b.nextAt || Number.MAX_SAFE_INTEGER);
  });

  if (all.length === 0) {
    box.innerHTML = `<div class="rm-empty">${esc(options.emptyText || "还没有定时任务")}</div>`;
    return;
  }

  const people = new Map();
  for (const item of all) {
    const found = people.get(item.personKey);
    if (found) found.count += 1;
    else people.set(item.personKey, { key: item.personKey, label: item.who, count: 1 });
  }

  let filter = "all";
  if (options.showFilter !== false && people.size > 1) {
    const filterKey = options.filterKey || "reminderFilter";
    const saved = state[filterKey] || "all";
    filter = saved === "all" || people.has(saved) ? saved : "all";
    state[filterKey] = filter;
  }
  const visible = filter === "all" ? all : all.filter((item) => item.personKey === filter);
  const list = visible.slice(0, 30);
  const byKey = new Map(list.map((item) => [item.key, item]));

  const filterBar =
    options.showFilter !== false && people.size > 1
      ? `<div class="rm-filter-bar">
          <span class="rm-filter-label">按人筛选</span>
          <select class="rm-filter-select" id="scheduled-task-filter" aria-label="按人筛选">
            <option value="all"${filter === "all" ? " selected" : ""}>全部人 (${all.length})</option>
            ${[...people.values()]
              .map(
                (item) =>
                  `<option value="${attr(item.key)}"${filter === item.key ? " selected" : ""}>${esc(
                    item.label,
                  )} (${item.count})</option>`,
              )
              .join("")}
          </select>
        </div>`
      : "";

  box.innerHTML =
    filterBar +
    (list.length
      ? list
          .map((item, index) => {
            const dayText = item.enabled ? (item.nextAt ? rmDateText(item.nextAt) : "—") : "已停";
            const timeText = item.enabled && item.nextAt ? rmTimeText(item.nextAt) : "";
            const metaExtra = `${!item.enabled && item.kind !== "memory" ? " · 已暂停" : ""}${
              item.promptMissing ? " · 服务端待重启" : ""
            }`;
            return `${index ? '<div class="divider"></div>' : ""}
        <div class="rm-item" data-task-key="${attr(item.key)}">
          <div class="rm-row${item.enabled ? "" : " is-off"}" role="button" tabindex="0"
               aria-label="${attr(`编辑「${item.title}」`)}">
            <div class="rm-when">
              <div class="rm-when-day">${esc(dayText)}</div>
              <div class="rm-when-time">${esc(timeText)}</div>
            </div>
            <div class="rm-row-main">
              <div class="rm-row-text"><span class="rm-title" title="${attr(item.title)}">${esc(item.title)}</span></div>
              <div class="rm-row-meta">${esc(item.who)} · ${esc(item.scheduleText)}${esc(metaExtra)}</div>
            </div>
            <div class="rm-row-actions">
              <button class="rm-dots" type="button" data-act="menu"
                      aria-haspopup="menu" aria-expanded="false"
                      aria-label="${attr(`「${item.title}」的更多操作`)}" data-tip="更多操作">⋯</button>
            </div>
          </div>
          <div class="rm-runs" hidden></div>
        </div>`;
          })
          .join("")
      : `<div class="rm-empty">这个人还没有任务</div>`) +
    (visible.length > list.length
      ? `<div class="divider"></div><div class="rm-more">还有 ${visible.length - list.length} 条</div>`
      : "");

  box.querySelector("#scheduled-task-filter")?.addEventListener("change", (event) => {
    state[options.filterKey || "reminderFilter"] = event.target.value;
    renderScheduledTaskList(box, all, options);
  });

  // 行本身就是编辑入口（2026-11-18）：点空白/文字/时间都打开编辑器；
  // ⋯ 只收不常驻的动作。键位只认行自己（内部按钮的 Enter/Space 归按钮）。
  box.querySelectorAll("[data-task-key]").forEach((itemNode) => {
    const item = byKey.get(itemNode.dataset.taskKey);
    if (!item) return;
    const row = itemNode.querySelector(".rm-row");
    const menuButton = itemNode.querySelector("[data-act='menu']");
    row?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, a")) return;
      openTaskEditor(item, onChanged);
    });
    row?.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openTaskEditor(item, onChanged);
    });
    menuButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      openSecMenu(menuButton, taskMenuItems(item, itemNode, onChanged));
    });
  });
}

async function loadReminders() {
  const card = document.getElementById("reminder-card");
  if (!card) return;
  try {
    const [routinesResponse, remindersResponse, partnersResponse, memoryResponse] = await Promise.all([
      request("/api/v1/routines", { cache: "no-store" }),
      // includePaused=1：桌面清单要看到暂停项；手机端不传，继续只同步真会响的。
      request("/api/v1/agent/reminders?includePaused=1", { cache: "no-store" }).catch(() => null),
      request("/api/v1/partners", { cache: "no-store" }),
      request("/api/v1/agent/memory/nightly", { cache: "no-store" }),
    ]);
    const routinesData = await routinesResponse.json().catch(() => ({}));
    const remindersData = remindersResponse ? await remindersResponse.json().catch(() => ({})) : {};
    const partnersData = await partnersResponse.json().catch(() => ({}));
    const memoryData = await memoryResponse.json().catch(() => ({}));
    const partners = partnersData.partners || state.partners || [];
    const nameById = new Map(partners.map((item) => [item.id, item.name || item.id]));

    const items = [];
    for (const routine of routinesData.routines || []) {
      items.push(routineTaskItem(routine, nameById));
    }
    for (const reminder of remindersData.reminders || []) {
      if (reminder.status === "terminal") continue;
      items.push(reminderTaskItem(reminder, nameById));
    }
    for (const item of memoryData.scopes || []) {
      items.push(memoryTaskItem(item, memoryData, nameById));
    }
    renderScheduledTaskList(card, items, {
      showFilter: true,
      emptyText: "还没有定时任务",
      onChanged: () => void loadReminders(),
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

function taskPartnerIdOf(spec, item) {
  const value = spec?.partnerId ?? item?.partnerId ?? "chief";
  return value && value !== "null" ? value : "chief";
}

/**
 * 统一编辑器（2026-11-17 定时任务重做）。
 *
 * spec:
 *   `{ mode:"create", partnerId?, lockPartner? }` —— 新建一律走 reminders（保住手机本地闹钟）；
 *   `{ mode:"edit", item }` —— item 由 XxxTaskItem 归一。
 *
 * 编辑三种：
 *   - reminder：内容 / 时间 / 触发可见性（PATCH /agent/reminders/:id，同 reminderId 重排）；
 *   - routine ：内容 / 名称 / 会话方式；简单触发可改时间，复杂触发只读；
 *   - memory  ：只改时间（每晚整理是全家共用时刻）。
 */
function openScheduledTaskModal(spec = null, onDone = null) {
  const item = spec?.mode === "edit" ? spec.item : null;
  const kind = item?.kind ?? "create";
  const memoryEditing = kind === "memory";
  const routineEditing = kind === "routine";
  const reminderEditing = kind === "reminder";
  const editing = Boolean(item);
  const partnerId = taskPartnerIdOf(spec, item);
  const partnerName = taskPersonLabel(partnerId);
  const lockPartner = spec?.lockPartner === true || editing;
  const raw = item?.raw ?? {};
  const initialText = String(
    item?.instruction ?? (routineEditing ? raw.prompt ?? "" : raw.text ?? "") ?? "",
  );
  const initialName = routineEditing ? String(raw.name || "") : "";
  let visibility = reminderEditing && item?.visibility === "hidden" ? "hidden" : "visible";
  let sessionMode = routineEditing && raw.sessionMode === "fresh" ? "fresh" : "persistent";

  const routineSchedule = routineEditing ? rtScheduleOf(raw) : null;
  const reminderSchedule = reminderEditing
    ? {
        at: Number(raw.at || item?.nextAt || 0),
        repeat: raw.repeat || "none",
        ...(raw.weekdays ? { weekdays: raw.weekdays } : {}),
        ...(raw.dayOfMonth ? { dayOfMonth: raw.dayOfMonth } : {}),
        ...(raw.until ? { until: raw.until } : {}),
      }
    : null;
  const scheduleBase = memoryEditing
    ? { at: Number(item?.nextAt || 0) || rmNextDaily(3, 30), repeat: "daily" }
    : routineEditing
      ? routineSchedule
      : reminderSchedule;
  // 复杂触发（interval / event / 多触发器 / 已过去的一次性）：只改内容，时间只读。
  const scheduleLocked = routineEditing && routineSchedule === null;
  let scheduleUnlocked = !scheduleLocked;

  const initialAt =
    (scheduleBase?.at && Number(scheduleBase.at) > 0 ? Number(scheduleBase.at) : 0) ||
    rmAt(new Date(rmStartOfDay(Date.now()).getTime() + RM_DAY_MS), 9, 0);
  const initialDate = rmStartOfDay(initialAt);
  const initialTime = new Date(initialAt);
  const pick = {
    date: initialDate,
    hour: initialTime.getHours(),
    minute: initialTime.getMinutes(),
    end: scheduleBase?.until ? rmStartOfDay(scheduleBase.until) : null,
    weekdays:
      scheduleBase?.weekdays?.length ? [...scheduleBase.weekdays] : [initialDate.getDay()],
    dayOfMonth: scheduleBase?.dayOfMonth || initialDate.getDate(),
    mode: memoryEditing ? "daily" : scheduleBase ? rmModeOf(scheduleBase) : "once",
  };
  let view = new Date(initialDate.getFullYear(), initialDate.getMonth(), 1);
  const title = memoryEditing ? "改时间" : editing ? "编辑定时任务" : "新建定时任务";
  const targetOptions = state.partners
    .filter((entry) => entry.id !== "chief" && entry.status === "active")
    .map(
      (entry) =>
        `<option value="${attr(entry.id)}"${entry.id === partnerId ? " selected" : ""}>${esc(
          entry.name || entry.id,
        )}</option>`,
    )
    .join("");
  const partnerControl =
    lockPartner || editing
      ? `<div class="rm-subject"><span class="rm-field-label">到点叫谁</span>
           <div class="rm-subject-text">${esc(partnerName)}</div></div>`
      : `<div class="rm-field">
           <span class="rm-field-label">到点叫谁</span>
           <select class="modal-input" id="reminder-target">
             <option value="chief"${partnerId === "chief" ? " selected" : ""}>总管</option>
             ${targetOptions}
           </select>
         </div>`;

  openModal(
    title,
    (body) => {
      body.innerHTML = `
      <div class="rm-form">
        ${
          memoryEditing
            ? `<div class="rm-subject"><span class="rm-field-label">做什么</span>
                 <div class="rm-subject-text">整理记忆（拆分 + 对账；只出建议，你点应用才改）</div></div>`
            : `${
              routineEditing
                ? `<div class="rm-field">
                     <span class="rm-field-label">名称（≤40 字，可不填）</span>
                     <input class="modal-input" id="reminder-name" type="text" maxlength="40" value="${attr(initialName)}" placeholder="留空就用指令开头" />
                   </div>`
                : ""
            }
            <div class="rm-field">
              <span class="rm-field-label">到点做什么</span>
              <textarea class="modal-input rm-textarea" id="reminder-text" rows="4" maxlength="100000" placeholder="例如：用你自己的话跟我说一句早安；先看一眼今天有没有要提醒我的事">${esc(initialText)}</textarea>
              <p class="modal-hint rm-text-hint">到点后，${esc(partnerName)} 会拿这段话自己跑一轮：能查就查、能做就做，然后把结果回在你们的主会话；做不了会回一句。不是照念这段话。第一次可以先点「立即跑」试一次。</p>
            </div>`
        }
        ${partnerControl}
        ${
          memoryEditing
            ? ""
            : routineEditing
              ? `<div class="rm-mode-row">
                   <span class="rm-field-label">触发消息</span>
                   <div class="rm-subject-text">可见（到点会留一条你发的指令）</div>
                 </div>`
              : `<div class="rm-mode-row rm-delivery-row">
                   <span class="rm-field-label" data-tip="隐藏=看不到你发的那条指令，只看到 TA 自己说的一句；可见=会话里留一条你写的触发消息">触发消息</span>
                   <div class="rm-modes" role="radiogroup" aria-label="触发消息是否可见">
                     <button class="rm-mode${visibility === "hidden" ? " is-on" : ""}" type="button" data-visibility="hidden" role="radio" aria-checked="${visibility === "hidden"}" data-tip="看不到你发的指令，只看到 TA 自己说的一句">像 TA 主动找我</button>
                     <button class="rm-mode${visibility === "visible" ? " is-on" : ""}" type="button" data-visibility="visible" role="radio" aria-checked="${visibility === "visible"}" data-tip="会话里留一条你写的触发指令，做完再回你">留一条我发的指令</button>
                   </div>
                 </div>
                 <p class="modal-hint rm-delivery-hint">「像 TA 主动找我」：只看到回复；「留一条我发的指令」：会话里能看到你写的这段话，适合需要接着聊的跟进任务。</p>`
        }
        ${
          scheduleLocked
            ? `<div class="rm-field" id="reminder-lock">
                 <span class="rm-field-label">什么时候</span>
                 <div class="rm-subject-text">${esc(item?.scheduleText || "高级触发")}</div>
                 <p class="modal-hint">这是 Agent 建的高级触发（interval / event / 复杂 cron）。这里只改内容；要改触发请交给 Agent，或点下面改成按时间。</p>
                 <div><button class="ghost" id="reminder-unlock" type="button">改成按时间</button></div>
               </div>`
            : ""
        }
        <div id="reminder-schedule" ${scheduleLocked ? "hidden" : ""}>
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
        </div>
        ${
          routineEditing
            ? `<div class="rm-mode-row">
                 <span class="rm-field-label">会话</span>
                 <div class="rm-modes" role="radiogroup" aria-label="会话方式">
                   <button class="rm-mode${sessionMode === "persistent" ? " is-on" : ""}" type="button" data-session="persistent" role="radio" aria-checked="${sessionMode === "persistent"}">接着聊</button>
                   <button class="rm-mode${sessionMode === "fresh" ? " is-on" : ""}" type="button" data-session="fresh" role="radio" aria-checked="${sessionMode === "fresh"}">每次新开</button>
                 </div>
               </div>`
            : ""
        }
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
      const nameInput = body.querySelector("#reminder-name");
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

      /* ── 触发消息：可见 / 隐藏（2026-11-17）────────── */
      body.querySelectorAll("[data-visibility]").forEach((button) => {
        button.addEventListener("click", () => {
          visibility = button.dataset.visibility === "hidden" ? "hidden" : "visible";
          body.querySelectorAll("[data-visibility]").forEach((b) => {
            const on = b.dataset.visibility === visibility;
            b.classList.toggle("is-on", on);
            b.setAttribute("aria-checked", on ? "true" : "false");
          });
        });
      });

      /* ── 会话方式：接着聊 / 每次新开（仅例行规则）────────── */
      body.querySelectorAll("[data-session]").forEach((button) => {
        button.addEventListener("click", () => {
          sessionMode = button.dataset.session === "fresh" ? "fresh" : "persistent";
          body.querySelectorAll("[data-session]").forEach((b) => {
            const on = b.dataset.session === sessionMode;
            b.classList.toggle("is-on", on);
            b.setAttribute("aria-checked", on ? "true" : "false");
          });
        });
      });

      /* ── 高级触发的「改成按时间」：解锁图形化控件 ─────────── */
      body.querySelector("#reminder-unlock")?.addEventListener("click", () => {
        scheduleUnlocked = true;
        body.querySelector("#reminder-lock")?.setAttribute("hidden", "");
        body.querySelector("#reminder-schedule")?.removeAttribute("hidden");
        renderDate();
        paintWheel();
        sync();
        requestAnimationFrame(() => {
          for (const { name, column } of wheelColumns) {
            column.scrollTop = pick[name] * RM_ITEM_H;
          }
          paintWheel();
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
      // 多行指令：Enter 换行，Ctrl/⌘+Enter 才提交（旧单行输入框的 Enter 提交会误伤长指令）。
      textInput?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
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
        const text = textInput ? textInput.value.trim() : String(item?.instruction || "");
        if (!memoryEditing && !text) {
          hint.textContent = "先写点到点做什么。";
          hint.classList.add("is-error");
          textInput?.focus();
          return;
        }
        if (scheduleUnlocked && pick.mode === "weekly" && pick.weekdays.length === 0) {
          hint.textContent = "至少选一个星期几。";
          hint.classList.add("is-error");
          return;
        }
        if (scheduleUnlocked && pick.mode === "range" && !pick.end) {
          hint.textContent = "再选一个结束日期。";
          hint.classList.add("is-error");
          return;
        }
        if (
          scheduleUnlocked &&
          pick.mode === "range" &&
          rmStartOfDay(pick.end).getTime() <= rmStartOfDay(pick.date).getTime()
        ) {
          hint.textContent = "结束日期要晚于开始日期。";
          hint.classList.add("is-error");
          return;
        }
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
            if (typeof onDone === "function") onDone();
            else void loadReminders();
          } catch {
            hint.textContent = "没保存：网络请求失败。";
            hint.classList.add("is-error");
            confirm.disabled = false;
          }
          return;
        }

        const schedule = scheduleUnlocked ? payload() : null;
        if (scheduleUnlocked && (!schedule.at || schedule.at <= Date.now())) {
          hint.textContent = "这个时间已经过去了。";
          hint.classList.add("is-error");
          return;
        }
        confirm.disabled = true;
        hint.textContent = editing ? "保存中…" : "添加中…";
        hint.classList.remove("is-error");
        try {
          let endpoint;
          let bodyData;
          if (!editing) {
            // 手动新建统一走 reminders：可见/隐藏只是显示方式，手机本地闹钟继续有效。
            endpoint = "/api/v1/agent/reminders";
            bodyData = {
              partnerId: (targetSelect?.value || partnerId) || "chief",
              text,
              ...schedule,
              visibility,
            };
          } else if (routineEditing) {
            // 例行规则：内容/名称/会话方式总能改；时间只在简单触发时能改。
            endpoint = `/api/v1/routines/${encodeURIComponent(item.id)}`;
            bodyData = {
              name: (nameInput?.value || "").trim() || taskTitleOf(text),
              prompt: text,
              sessionMode,
            };
            if (scheduleUnlocked) {
              const original =
                Array.isArray(raw.triggers) && raw.triggers.length === 1 ? raw.triggers[0] : null;
              bodyData.triggers = rmRoutineTriggers(schedule).map((trigger) =>
                rmMergeTriggerExtras(trigger, original),
              );
            }
          } else {
            // 提醒：改内容/时间/可见性；同 reminderId 重排，历史不断。
            endpoint = `/api/v1/agent/reminders/${encodeURIComponent(item.id)}`;
            bodyData = { ...schedule, text, visibility };
          }
          const response = await request(endpoint, {
            method: editing ? "PATCH" : "POST",
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
          toast(editing ? "已保存" : "定时任务已添加");
          if (typeof onDone === "function") onDone();
          else void loadReminders();
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

/**
 * 旧调用点兼容（2026-11-17）：把老 shape 映射到统一编辑器。
 * 新代码直接调 openScheduledTaskModal；这个壳只为还没改到的入口不炸。
 */
function openReminderModal(reminder = null, onDone = null) {
  if (!reminder) {
    openScheduledTaskModal({ mode: "create" }, onDone);
    return;
  }
  const kind =
    reminder.kind === "routine" ? "routine" : reminder.kind === "memory" ? "memory" : "reminder";
  openScheduledTaskModal(
    {
      mode: "edit",
      item: {
        kind,
        id: reminder.id,
        reminderId: reminder.reminderId,
        partnerId: reminder.partnerId,
        title: reminder.title || reminder.name || reminder.text || "定时任务",
        instruction: reminder.prompt || reminder.text || "",
        scheduleText: "",
        nextAt: reminder.at,
        enabled: reminder.enabled !== false,
        visibility: reminder.kind === "proactive" ? "hidden" : "visible",
        raw: reminder.raw ?? reminder,
      },
    },
    onDone,
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

export {
  loadPolicy,
  loadReminders,
  memoryTaskItem,
  openReminderModal,
  openScheduledTaskModal,
  reminderTaskItem,
  renderDefaultModelRow,
  renderScheduledTaskList,
  routineTaskItem,
  rmDateText,
  rmDayDiff,
  rmStartOfDay,
  rmTimeText,
};
