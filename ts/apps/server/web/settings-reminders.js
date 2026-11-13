/**
 * 提醒页
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { fetchModelCatalog, normalizeModelRow, renderModelMenu } from "./hover-tip.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { mountSegmented, syncSegmented } from "./settings-atoms.js";
import { KEY_MODEL_PROVIDER } from "./shell.js";
import { state } from "./state.js";
import { closeModal, closePopover, openModal, openPopover, popoverOpen, toast } from "./ui-atoms.js";


/* ── 提醒（2026-11-12 重做）─────────────────────────────
 * 日期文案一律走中文（今天 / 明天 / 11月13日），不再把裸 ISO 码或 MM/DD/YY 丢给用户。
 * 手动加一条的日历也是自绘的：原生 datetime-local 在中文界面上就是 MM/DD/YY，已退役。 */
const RM_TIME_GROUPS = [
  { label: "上午", times: ["08:00", "09:00", "10:00"] },
  { label: "下午", times: ["12:30", "15:00", "18:00"] },
  { label: "晚上", times: ["20:00", "21:00", "22:00"] },
];

function rmStartOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function rmDayDiff(from, to) {
  return Math.round((rmStartOfDay(to) - rmStartOfDay(from)) / 86400000);
}

function rmDateText(value) {
  const date = new Date(value);
  const diff = rmDayDiff(Date.now(), date);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function rmTimeText(value) {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 相对时间只说到天：提醒是粗粒度的事，精确到分秒反而吵 */
function rmRelativeText(at, now = Date.now()) {
  const diff = at - now;
  if (diff <= 0) return "已到点";
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  const days = rmDayDiff(now, at);
  if (days <= 1) return `${Math.round(diff / 3600000)} 小时后`;
  if (days < 7) return `${days} 天后`;
  return `${Math.round(days / 7)} 周后`;
}

async function loadReminders() {
  const card = document.getElementById("reminder-card");
  if (!card) return;
  try {
    const response = await request("/api/v1/agent/reminders", { cache: "no-store" });
    const data = await response.json();
    const all = (data.reminders || data || [])
      .slice()
      .sort((a, b) => {
        // 已结束的沉底，其余按时间先后
        const offA = a.status === "terminal" ? 1 : 0;
        const offB = b.status === "terminal" ? 1 : 0;
        if (offA !== offB) return offA - offB;
        return Number(a.at || a.until || 0) - Number(b.at || b.until || 0);
      });
    if (!all.length) {
      card.innerHTML = `<div class="rm-empty">还没有定时任务</div>`;
      return;
    }
    const list = all.slice(0, 12);
    card.innerHTML =
      list
        .map((item, index) => {
          const at = Number(item.at || item.until || 0);
          const off = item.status === "terminal";
          const tag = off
            ? '<span class="rm-state is-off">已结束</span>'
            : item.status === "pending"
              ? '<span class="rm-state">排队中</span>'
              : "";
          const meta = off ? "" : rmRelativeText(at);
          const daily = item.repeat === "daily";
          return `${index ? '<div class="divider"></div>' : ""}
        <div class="rm-row${off ? " is-off" : ""}">
          <div class="rm-when">
            <div class="rm-when-day">${daily ? "每天" : rmDateText(at)}</div>
            <div class="rm-when-time">${rmTimeText(at)}</div>
          </div>
          <div class="rm-row-main">
            <div class="rm-row-text">${esc(item.text || "提醒")}</div>
            ${meta ? `<div class="rm-row-meta">${meta}${daily ? " · 每天重复" : ""}</div>` : ""}
          </div>
          ${tag}
          ${off ? "" : `<button class="rm-del" type="button" data-del="${Number(item.id)}" aria-label="取消提醒">取消</button>`}
        </div>`;
        })
        .join("") +
      (all.length > list.length
        ? `<div class="divider"></div><div class="rm-more">还有 ${all.length - list.length} 条</div>`
        : "");
    card.querySelectorAll("[data-del]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        await request(`/api/v1/agent/reminders/${encodeURIComponent(button.dataset.del)}`, {
          method: "DELETE",
        }).catch(() => undefined);
        void loadReminders();
      });
    });
  } catch {
    card.innerHTML = `<div class="row"><div class="row-main">
      <div class="row-hint">读不到提醒</div></div></div>`;
  }
}

/**
 * 提醒到点监视（2026-11-12）：服务端没有 push 通道，页面开着就每 30s 拉一次。
 * 同一条（reminderId + 触发时刻）只弹一次；没有通知权限时静默——列表里照样看得到。
 */
const REMINDER_NOTIFIED_KEYS = new Set();
function startReminderWatch() {
  const tick = async () => {
    try {
      const response = await request("/api/v1/agent/reminders", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const now = Date.now();
      for (const item of data.reminders || []) {
        if (item.status === "terminal") continue;
        const due = Number(item.until ?? item.at ?? 0);
        if (!due || due > now + 1000) continue;
        const key = `${item.reminderId || item.id}:${due}`;
        if (REMINDER_NOTIFIED_KEYS.has(key)) continue;
        REMINDER_NOTIFIED_KEYS.add(key);
        notify("定时任务", item.text || "到点了");
      }
    } catch {
      /* 离线就等下一次 */
    }
  };
  void tick();
  setInterval(tick, 30_000);
}

/**
 * 手动加一条（2026-11-12）：日期/时间只活在这个弹窗的闭包里，关掉即弃，
 * 不引全局状态。左边日历、右边时段，一屏看完，不写解释性文案。
 */
function openReminderModal() {
  openModal("手动加一条定时任务", (body) => {
    body.innerHTML = `
      <div class="rm-form">
        <div class="rm-field">
          <span class="rm-field-label">提醒什么</span>
          <input class="modal-input" id="reminder-text" type="text" maxlength="200" placeholder="例如：交房租" />
        </div>
        <div class="rm-form-cols">
          <div class="rm-field">
            <span class="rm-field-label">哪一天</span>
            <div class="rm-cal" id="reminder-cal"></div>
          </div>
          <div class="rm-field">
            <span class="rm-field-label">几点</span>
            <div class="rm-times" id="reminder-times">
              ${RM_TIME_GROUPS.map(
                (group) => `<div class="rm-time-group">
                  <span class="rm-time-label">${group.label}</span>
                  <div class="rm-time-row">${group.times
                    .map((time) => `<button class="rm-time" type="button" data-time="${time}" aria-pressed="false">${time}</button>`)
                    .join("")}</div>
                </div>`,
              ).join("")}
            </div>
            <input class="modal-input rm-time-input" id="reminder-time" type="text" inputmode="numeric"
                   maxlength="5" placeholder="其他时间 09:30" aria-label="自定义时间" />
          </div>
        </div>
        <label class="rm-repeat">
          <input type="checkbox" id="reminder-repeat" />
          <span>每天重复</span>
        </label>
        <p class="modal-hint" id="reminder-hint"></p>
        <div class="modal-actions">
          <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="reminder-confirm" type="button">添加</button>
      </div>`;

    const cal = body.querySelector("#reminder-cal");
    const times = body.querySelector("#reminder-times");
    const custom = body.querySelector("#reminder-time");
    const textInput = body.querySelector("#reminder-text");
    const repeatInput = body.querySelector("#reminder-repeat");
    const hint = body.querySelector("#reminder-hint");
    const confirm = body.querySelector("#reminder-confirm");

    // 默认明天早上 9 点：最常见的约定时间，也比「此刻 +1 小时」可预期
    const tomorrow = rmStartOfDay(Date.now() + 86400000);
    const pick = { date: tomorrow, time: "09:00" };
    let view = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), 1);

    const parseTimeInput = (value) => {
      const match = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(value);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) return null;
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    };

    const selectedAt = () => {
      const [hour, minute] = pick.time.split(":").map(Number);
      return new Date(
        pick.date.getFullYear(),
        pick.date.getMonth(),
        pick.date.getDate(),
        hour,
        minute,
        0,
        0,
      ).getTime();
    };

    const sync = () => {
      const typed = custom.value.trim();
      const typedTime = typed ? parseTimeInput(typed) : null;
      const badTime = Boolean(typed) && !typedTime;
      const at = selectedAt();
      const future = at > Date.now();
      for (const chip of times.querySelectorAll("[data-time]")) {
        const on = !typed && chip.dataset.time === pick.time;
        chip.classList.toggle("is-on", on);
        chip.setAttribute("aria-pressed", String(on));
      }
      if (badTime) {
        hint.textContent = "时间写成 09:30 这样。";
        hint.classList.add("is-error");
      } else {
        hint.textContent = future
          ? `${rmDateText(at)} ${rmTimeText(at)} · ${rmRelativeText(at)}`
          : "这个时间已经过去了。";
        hint.classList.toggle("is-error", !future);
      }
      confirm.disabled = !future || badTime;
    };

    const renderCal = () => {
      const year = view.getFullYear();
      const month = view.getMonth();
      const lead = (new Date(year, month, 1).getDay() + 6) % 7; // 周一打头
      const days = new Date(year, month + 1, 0).getDate();
      const today = rmStartOfDay(Date.now());
      let cells = '<span class="rm-cal-pad"></span>'.repeat(lead);
      for (let day = 1; day <= days; day += 1) {
        const date = new Date(year, month, day);
        const past = date < today;
        const on = date.getTime() === pick.date.getTime();
        const isToday = date.getTime() === today.getTime();
        cells += `<button class="rm-cal-day${on ? " is-on" : ""}${isToday && !on ? " is-today" : ""}" type="button"
          data-day="${day}"${past ? " disabled" : ""} aria-pressed="${on}">${day}</button>`;
      }
      cal.innerHTML = `
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
        <div class="rm-cal-grid">${cells}</div>`;
    };

    cal.addEventListener("click", (event) => {
      const nav = event.target.closest("[data-cal]");
      if (nav) {
        const step = nav.dataset.cal === "next" ? 1 : -1;
        view = new Date(view.getFullYear(), view.getMonth() + step, 1);
        renderCal();
        return;
      }
      const day = event.target.closest("[data-day]");
      if (!day || day.disabled) return;
      pick.date = new Date(view.getFullYear(), view.getMonth(), Number(day.dataset.day));
      renderCal();
      sync();
    });

    times.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-time]");
      if (!chip) return;
      pick.time = chip.dataset.time;
      custom.value = "";
      sync();
    });

    custom.addEventListener("input", () => {
      const parsed = parseTimeInput(custom.value);
      if (parsed) pick.time = parsed;
      sync();
    });
    custom.addEventListener("blur", () => {
      // 9:30 也能认，但失焦时补成 09:30，读起来整齐
      const parsed = parseTimeInput(custom.value);
      if (parsed) custom.value = parsed;
    });

    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    const submit = async () => {
      const text = textInput.value.trim();
      if (!text) {
        hint.textContent = "先写点提醒内容。";
        hint.classList.add("is-error");
        textInput.focus();
        return;
      }
      if (confirm.disabled) return;
      confirm.disabled = true;
      hint.textContent = "添加中…";
      hint.classList.remove("is-error");
      try {
        const response = await request("/api/v1/agent/reminders", {
          method: "POST",
          body: JSON.stringify({
            text,
            at: selectedAt(),
            repeat: repeatInput?.checked ? "daily" : "none",
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          hint.textContent = data.message || `没加上：HTTP ${response.status}`;
          hint.classList.add("is-error");
          confirm.disabled = false;
          return;
        }
        closeModal();
        toast("提醒已添加");
        void loadReminders();
      } catch (error) {
        if (error.message !== "forbidden") {
          hint.textContent = `没加上：${error.message}`;
          hint.classList.add("is-error");
        }
        confirm.disabled = false;
      }
    };

    confirm.addEventListener("click", () => void submit());
    textInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void submit(); }
    });
    textInput.addEventListener("input", sync);

    renderCal();
    sync();
  }, { className: "modal-reminder" });
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

export { REMINDER_NOTIFIED_KEYS, RM_TIME_GROUPS, loadPolicy, loadReminders, openReminderModal, renderDefaultModelRow, rmDateText, rmDayDiff, rmRelativeText, rmStartOfDay, rmTimeText, startReminderWatch };
