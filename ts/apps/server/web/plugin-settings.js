/**
 * 插件卡内设置（2026-11-25）
 *
 * 插件页每张卡上的「设置」按钮与卡内小面板。这张表是**声明式**的：
 * `PLUGIN_SETTINGS[插件 key] = { hint, render?, links? }`。
 * - `hint`   一句话：能调的东西在哪 / 是什么。
 * - `render` 可选：卡内内联控件。只许调既有函数 / 既有端点 / 既有存储键，不在这里重写业务逻辑。
 * - `links`  可选：`[{ href, label }]`，跳到设置已经所在的页面（按人 / 按项目 / 复杂流程一律走链接）。
 *
 * 挂入口与展开由 settings-switches.js 调本模块的三个函数完成；以后补插件只改下面这张表。
 * 审计表与分类口径：docs/设计方案/2026-11-25-插件设置就近呈现.md。
 *
 * 回滚（两层，都不用动别的文件）：
 * 1. 下面 `INLINE_SETTINGS` 改 false；
 * 2. 控制台 `localStorage.setItem("lifediary.pluginInlineSettings", "0")` 后刷新。
 */

import {
  applyWallpaperState,
  readWallpaperState,
  saveWallpaperState,
} from "./appearance-wallpaper.js";
import { CHAT_MAP_WINDOW_OPTIONS, getChatMapWindow, setChatMapWindow } from "./chat-map.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { renderInlinePolicyPanel } from "./settings-tool-policy.js";
import { toast } from "./ui-atoms.js";

const INLINE_SETTINGS = true;
const LOCAL_KILL_KEY = "lifediary.pluginInlineSettings";

/** 实际权限 / 审批档的中文（与会话页权限卡同一套说法，settings-router.js 的权限卡）。 */
const ACCESS_LABEL = { "read-only": "只读", "no-shell": "在工作区内修改", full: "完全访问" };
const APPROVAL_LABEL = { "ask-all": "全部问我", "ask-critical": "只问重要的", none: "全不问" };

/** 壁纸滑杆的上下限：与 appearance-wallpaper.js 的 clampVisible / clampBlur 同口径（那边存盘时会再夹一次）。 */
const WALLPAPER_VISIBLE_MAX = 100;
const WALLPAPER_BLUR_MAX = 24;

function inlineSettingsEnabled() {
  if (!INLINE_SETTINGS) return false;
  try {
    return localStorage.getItem(LOCAL_KILL_KEY) !== "0";
  } catch {
    return true;
  }
}

/* ── 内联控件 ─────────────────────────────────────────────── */

/** 滑杆已填那一截上色（.wall-range 的 --wall-p，与外观页同一条轨道）。 */
function paintRange(range) {
  const min = Number(range.min);
  const max = Number(range.max);
  const value = Number(range.value);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  range.style.setProperty("--wall-p", `${Math.min(100, Math.max(0, pct))}%`);
}

function sliderRowMarkup(name, key, value, max) {
  return `<label class="wall-slider-row flag-settings-slider">
    <span class="wall-slider-name">${esc(name)}</span>
    <input class="wall-range" type="range" data-wallpaper-range="${attr(key)}" min="0" max="${max}" step="1" value="${value}">
  </label>`;
}

/** 壁纸：可见度 / 模糊。读写都走 appearance-wallpaper.js 的同一套 normalize。 */
function renderWallpaper(slot) {
  const state = readWallpaperState();
  slot.innerHTML =
    sliderRowMarkup("可见度", "visible", state.visible, WALLPAPER_VISIBLE_MAX) +
    sliderRowMarkup("模糊", "blur", state.blur, WALLPAPER_BLUR_MAX);
  for (const range of slot.querySelectorAll("[data-wallpaper-range]")) {
    paintRange(range);
    range.addEventListener("input", () => {
      const next = { ...readWallpaperState(), [range.dataset.wallpaperRange]: Number(range.value) };
      saveWallpaperState(next);
      applyWallpaperState(next);
      paintRange(range);
    });
  }
}

/** 会话画板：默认画最近几轮。与画板顶栏下拉同一条路（setChatMapWindow）。 */
function renderChatMap(slot) {
  const current = getChatMapWindow();
  const options = CHAT_MAP_WINDOW_OPTIONS.map((value) => {
    const selected = Number(value) === Number(current) ? " selected" : "";
    return `<option value="${value}"${selected}>最近 ${value} 轮</option>`;
  });
  slot.innerHTML = `<label class="flag-settings-row">
    <span class="flag-settings-name">默认画</span>
    <select class="set-input flag-settings-select" data-chatmap-window aria-label="会话画板默认画的轮数">${options.join("")}</select>
  </label>`;
  const select = slot.querySelector("[data-chatmap-window]");
  select?.addEventListener("change", () => {
    const applied = setChatMapWindow(select.value);
    toast(`会话画板默认画最近 ${applied} 轮`);
  });
}

/** 每晚整理时间：与定时任务页弹层同一个 PATCH。 */
async function renderNightly(slot, alive) {
  const response = await request("/api/v1/agent/memory/nightly", { cache: "no-store" });
  if (!response.ok) {
    if (response.status === 404) {
      slot.innerHTML = '<p class="flag-settings-hint">记忆未启用，读不到整理时间。</p>';
      return;
    }
    throw new Error(String(response.status));
  }
  const data = await response.json().catch(() => ({}));
  if (!alive()) return;
  const at = /^\d{2}:\d{2}$/.test(String(data?.at ?? "")) ? String(data.at) : "";
  slot.innerHTML = `<label class="flag-settings-row">
    <span class="flag-settings-name">每天整理时间</span>
    <input class="set-input flag-settings-time" type="time" step="60" value="${attr(at)}"${at ? "" : " disabled"} aria-label="每晚整理时间">
  </label>`;
  const input = slot.querySelector(".flag-settings-time");
  input?.addEventListener("change", async () => {
    const next = String(input.value || "").trim();
    if (!/^\d{2}:\d{2}$/.test(next)) {
      toast("时间只能是 HH:MM");
      input.value = at;
      return;
    }
    const saved = await request("/api/v1/agent/memory/nightly", {
      method: "PATCH",
      body: JSON.stringify({ at: next }),
    });
    if (saved.ok) {
      toast(`已改，每晚 ${next} 整理`);
      return;
    }
    const payload = await saved.json().catch(() => ({}));
    toast(payload.message || "没保存上，稍后再试");
    input.value = at;
  });
}

/** 工具权限限制：只回显**实际生效**的权限与审批档（来自 .data/policy.json），不给第二个可写控件。
 *  原因见方案 §0.2：这张卡上的档位与真实闸门是两份数据，先不动，待立项。 */
async function renderToolPolicy(slot, alive) {
  const response = await request("/api/v1/agent/policy", { cache: "no-store" });
  if (!response.ok) throw new Error(String(response.status));
  const data = await response.json().catch(() => ({}));
  if (!alive()) return;
  const access = String(data?.access ?? "");
  const approval = String(data?.approvalLevel ?? "");
  slot.innerHTML = `
    <div class="flag-settings-row"><span class="flag-settings-name">实际生效的权限</span><span class="flag-settings-value">${esc(ACCESS_LABEL[access] || access || "—")}</span></div>
    <div class="flag-settings-row"><span class="flag-settings-name">审批档</span><span class="flag-settings-value">${esc(APPROVAL_LABEL[approval] || approval || "—")}</span></div>`;
}

/** 工具异常处理：直接复用详情弹层里那张内嵌面板（同一份数据、同一套弹层）。 */
async function renderTimeoutPolicy(slot) {
  await renderInlinePolicyPanel(slot);
}

/* ── 登记表 ───────────────────────────────────────────────── */

const GO_PARTNERS = { href: "#/settings/partners", label: "去人设" };
const GO_MEMORY = { href: "#/settings/memory", label: "去索引页" };
const GO_PROJECTS = { href: "#/settings/projects", label: "去项目设置" };
const GO_SKILLS = { href: "#/settings/skills", label: "去技能页" };
const GO_LOCAL = { href: "#/settings/connect", label: "去本机设置" };
const GO_REMINDERS = { href: "#/settings/reminders", label: "去定时任务" };

/** 插件 key → 卡内设置面板定义。没有登记的插件不画「设置」按钮（A / D / E 类）。 */
const PLUGIN_SETTINGS = {
  /* 对话基本能力 */
  CURRENT_PROJECT: { hint: "项目的增删改名归档、工作区根路径都在项目页。", links: [GO_PROJECTS] },
  PROJECT_OUTSIDE_WORKSPACE: { hint: "项目落在哪由项目页决定。", links: [GO_PROJECTS] },
  PROJECT_MERGE: { hint: "在项目页的行内菜单里把一个项目合并进另一个。", links: [GO_PROJECTS] },
  PROJECT_ARCHIVE_CHATS: { hint: "归档项目时带不带会话，在项目页归档时选。", links: [GO_PROJECTS] },
  USER_PROFILE_ENABLED: { hint: "偏好正文、每位 Agent 读不读它，都在偏好页。", links: [{ href: "#/settings/about-me", label: "去偏好设置" }] },

  /* 记忆 */
  MEMORY_ENABLED: { hint: "作用域切换、整理、导入都在索引页。", links: [GO_MEMORY] },
  MEMORY_EXTERNAL: { hint: "记忆库槽位（内置 / 外接）在索引页的记忆库卡里。", links: [GO_MEMORY] },
  MEMORY_NIGHTLY_REVIEW: {
    hint: "每晚整理记忆的时间。每个作用域的暂停 / 删除在定时任务页。",
    render: renderNightly,
    links: [GO_REMINDERS],
  },
  PARTNER_MEMORY_RECALL: { hint: "每位执事各有自己的「记忆召回」子开关。", links: [GO_PARTNERS] },

  /* 一生记忆库 */
  PERSONA_MEMORY_ENABLED: { hint: "外接命令、路径、探测都在索引页的记忆库卡里。", links: [GO_MEMORY] },
  PERSONA_WRITE_ENABLED: { hint: "能不能写由记忆库槽位里配没配 repair.py 决定。", links: [GO_MEMORY] },

  /* 自主与派活 */
  CHANCELLOR_ENABLED: {
    hint: "默认派给谁、每个 CLI 的模型与权限档都在派活页。",
    links: [{ href: "#/settings/agent", label: "去派活设置" }],
  },
  SCHEDULED_TASK_MODEL_RUN: { hint: "任务本身（时间、给谁、是否可见）在定时任务页。", links: [GO_REMINDERS] },
  ROUTINE_SELF_SERVICE: { hint: "执事自建的例行规则在定时任务页。", links: [GO_REMINDERS] },
  COMPANIONS_ENABLED: { hint: "执事档案（头像、人设、岗位、能力）在人设页。", links: [GO_PARTNERS] },
  GROUPS_ENABLED: { hint: "群设置在群组页的设置抽屉里。", links: [{ href: "#/groups", label: "去群组" }] },
  PARTNER_SIDE_SESSIONS: { hint: "每位执事各有自己的副会话。", links: [GO_PARTNERS] },
  PARTNER_PERSONA_MODULES: { hint: "每位执事的人格模块开关在她 / 他自己的页里。", links: [GO_PARTNERS] },
  PARTNER_CONTRACT: { hint: "每位执事的岗位契约在她 / 他自己的页里。", links: [GO_PARTNERS] },
  PARTNER_DISCIPLINE_EDIT: { hint: "每位执事的纪律覆盖在她 / 他自己的页里。", links: [GO_PARTNERS] },
  PARTNER_LEARNING_FREQUENCY: { hint: "档位是全局的；生不生效看每位执事的学习模块开关。", links: [GO_PARTNERS] },
  PARTNER_GREETING_ENABLED: { hint: "每位执事的开场问候在她 / 他自己的页里。", links: [GO_PARTNERS] },
  DEVICE_MATRIX_ENABLED: { hint: "设备的登记、撤销、备注在本机页。", links: [GO_LOCAL] },
  COMPANION_HOME_ENABLED: { hint: "执事认哪台主机在本机页。", links: [GO_LOCAL] },
  AGENT_TOOL_POLICY: {
    hint: "下面是权限卡里实际生效的值；要改去会话页的权限卡。",
    render: renderToolPolicy,
    links: [{ href: "#/settings/chats", label: "去权限卡" }],
  },
  TOOL_TIMEOUT_POLICY: {
    hint: "每个工具的超时、超时后怎么办、完成通知。点一行打开它的弹层。",
    render: renderTimeoutPolicy,
  },

  /* 普通助手（工人） */
  WORKER_PERSONA_EDIT: { hint: "池工人的人设正文在池工人页。", links: [{ href: "#/settings/partners/pool", label: "去池工人" }] },
  WORKER_TOOLS_DISPATCH: {
    hint: "派活下发的工具面在池工人页勾选；全局常驻 / 按需在工具页。",
    links: [
      { href: "#/settings/partners/pool", label: "去池工人" },
      { href: "#/settings/tools", label: "去工具页" },
    ],
  },

  /* 技能与履历 */
  SKILLS_ADMIN: { hint: "技能的增删改、批量启停、额外目录都在技能页。", links: [GO_SKILLS] },
  SKILL_STATE: { hint: "每个技能的启停位在技能页的列表里。", links: [GO_SKILLS] },

  /* 任务与界面 */
  TOOL_PROJECTION_WORKER: { hint: "这里只是默认值；每位执事可以单独覆盖。", links: [GO_PARTNERS] },
  CHAT_MAP_ENABLED: { hint: "会话画板默认只画最近几轮。", render: renderChatMap },
  CHAT_CONTEXT_INSPECT: { hint: "默认开销各段可改，注入视图在上下文页。", links: [{ href: "#/settings/context", label: "去上下文页" }] },
  AGENT_APPEARANCE_WALLPAPER: {
    hint: "换图、上传自定义图在外观页。",
    render: renderWallpaper,
    links: [{ href: "#/settings/appearance", label: "去外观页" }],
  },

  /* 其他（兜底组） */
  GOAL_MODE: { hint: "每位执事的目标在她 / 他自己的页里。", links: [GO_PARTNERS] },
  GOAL_MAX_ROUNDS: { hint: "与目标模式一起，在人设页设。", links: [GO_PARTNERS] },
};

function entryOf(key) {
  return inlineSettingsEnabled() ? PLUGIN_SETTINGS[key] || null : null;
}

function panelIdOf(key) {
  return `flag-settings-${key}`;
}

/* ── 给 settings-switches.js 用的三个函数 ──────────────────── */

/** 卡尾「设置」按钮。没登记的插件返回空串。 */
function pluginSettingsButtonMarkup(key) {
  if (!entryOf(key)) return "";
  return `<button class="flag-settings-toggle" type="button" data-flag-settings="${attr(key)}" aria-expanded="false" aria-controls="${attr(panelIdOf(key))}" aria-label="设置">设置</button>`;
}

/** 卡内小面板的外壳，放在卡尾下面（内容第一次点开时才渲染）。 */
function pluginSettingsPanelMarkup(key) {
  if (!entryOf(key)) return "";
  return `<div class="flag-settings" id="${attr(panelIdOf(key))}"><div class="flag-settings-inner" data-flag-settings-panel="${attr(key)}"></div></div>`;
}

const renderTokens = new Map();

async function renderPluginSettings(key, panel) {
  const entry = PLUGIN_SETTINGS[key];
  if (!entry || !(panel instanceof HTMLElement)) return;
  const token = (renderTokens.get(key) || 0) + 1;
  renderTokens.set(key, token);
  const alive = () => renderTokens.get(key) === token && panel.isConnected;

  const body = document.createElement("div");
  body.className = "flag-settings-body";
  const hint = document.createElement("p");
  hint.className = "flag-settings-hint";
  hint.textContent = entry.hint;
  body.append(hint);
  const slot = document.createElement("div");
  slot.className = "flag-settings-slot";
  body.append(slot);
  panel.replaceChildren(body);

  if (entry.render) {
    const loading = document.createElement("p");
    loading.className = "flag-settings-hint";
    loading.textContent = "读取中…";
    slot.append(loading);
    try {
      await entry.render(slot, alive);
    } catch (error) {
      if (error?.message === "forbidden") return;
      if (!alive()) return;
      slot.innerHTML = '<p class="flag-settings-hint">读不到设置，稍后再试。</p>';
    }
    // 同步渲染的控件会把整个 slot 换掉，「读取中」已经不在了；异步补内容的在这里收掉。
    loading.remove();
  }
  if (!alive()) return;

  const links = Array.isArray(entry.links) ? entry.links : [];
  if (links.length) {
    const row = document.createElement("div");
    row.className = "flag-settings-links";
    row.innerHTML = links
      .map((link) => `<a class="flag-settings-link" href="${attr(link.href)}">${esc(link.label)}</a>`)
      .join("");
    body.append(row);
  }
}

/** 展开与收起。只挂一次在插件页容器上（事件委托），重画卡片不用重挂。 */
function wirePluginSettings(root) {
  if (!(root instanceof HTMLElement) || root.dataset.flagSettingsWired === "1") return;
  root.dataset.flagSettingsWired = "1";
  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("[data-flag-settings]");
    if (!button || !root.contains(button)) return;
    // 按钮不在卡体按钮里，但显式截断，确保永远不会连带打开「点卡看详情」。
    event.stopPropagation();
    const key = button.dataset.flagSettings || "";
    const item = button.closest(".flag-item");
    const panel = item?.querySelector("[data-flag-settings-panel]") || null;
    if (!item || !panel) return;
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    if (!open) {
      item.classList.remove("is-settings-open");
      return;
    }
    void renderPluginSettings(key, panel);
    // 先把「读取中」画进去，下一帧再放开高度，让面板从 0 长出来。
    requestAnimationFrame(() => {
      if (item.isConnected && button.getAttribute("aria-expanded") === "true") {
        item.classList.add("is-settings-open");
      }
    });
  });
}

export { inlineSettingsEnabled, pluginSettingsButtonMarkup, pluginSettingsPanelMarkup, wirePluginSettings };
