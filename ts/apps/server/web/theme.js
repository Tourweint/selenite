/**
 * 主题色板 + 字体（全站/分区）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { closeModal, openModal } from "./ui-atoms.js";

/* ── 主题（2026-11-05：四套色板） ─────────────────────── */

const KEY_THEME = "lifediary.theme";
const KEY_ACCENT = "lifediary.accent";
const KEY_SEND = "lifediary.sendKey";
const KEY_ACTS = "lifediary.showActs";

/* id 与 html[data-theme] 一一对应；预览色写死，不跟当前 token 走。
   white/black 2026-11-08 柔化（纯白纯黑太刺眼），预览色随 token 同步 */
const THEMES = [
  { id: "paper", name: "米黄", bg: "#fdf9f2", card: "#f6f1e7", accent: "#3e4a8c" },
  { id: "white", name: "暖白", bg: "#fafaf8", card: "#f4f4f1", accent: "#3e4a8c" },
  { id: "indigo", name: "靛蓝夜", bg: "#12141d", card: "#191c27", accent: "#8b97ea" },
  { id: "black", name: "炭黑", bg: "#17171a", card: "#1d1d21", accent: "#8b97ea" },
];
const THEME_IDS = THEMES.map((item) => item.id);

/** 旧值迁移：dark → indigo；light / system / 缺失 → paper（迁移后就地写回） */
function currentThemeChoice() {
  const stored = localStorage.getItem(KEY_THEME);
  if (THEME_IDS.includes(stored)) return stored;
  const migrated = stored === "dark" ? "indigo" : "paper";
  localStorage.setItem(KEY_THEME, migrated);
  return migrated;
}

function applyTheme(choice) {
  document.documentElement.dataset.theme = THEME_IDS.includes(choice) ? choice : "paper";
}

function setThemeChoice(choice) {
  const theme = THEME_IDS.includes(choice) ? choice : "paper";
  localStorage.setItem(KEY_THEME, theme);
  applyTheme(theme);
  syncThemeControls();
}

function setAccent(name) {
  localStorage.setItem(KEY_ACCENT, name);
  document.documentElement.dataset.accent = name;
  syncThemeControls();
}

function syncThemeControls() {
  const choice = currentThemeChoice();
  for (const button of el.settingsInner.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.themeChoice === choice));
  }
  const accent = localStorage.getItem(KEY_ACCENT) || "indigo";
  for (const button of el.settingsInner.querySelectorAll("[data-accent-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.accentChoice === accent));
  }
}

/* ── 字体（2026-11-13：全站默认 + 分区字体 / 字号）────────
   全站默认写 `--font`；聊天 / 设置 / 其他界面可以各自覆盖字体。
   字号按区域用 zoom 缩放（字、间距、控件一起放大），宽度用 100%/zoom 反向补偿，
   避免放大后横向溢出。纯前端 localStorage，无服务端契约。 */

const KEY_FONTS = "lifediary.fonts";
const FONT_FAMILIES = {
  songti: {
    label: "宋体",
    stack: '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "STSong", "SimSun", "Microsoft YaHei", serif',
  },
  dengxian: {
    label: "等线",
    stack: '"DengXian", "等线", "Microsoft YaHei", sans-serif',
  },
  sans: {
    label: "无衬线",
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
};
const FONT_SIZES = {
  sm: { label: "小", scale: 0.9 },
  md: { label: "标准", scale: 1 },
  lg: { label: "大", scale: 1.12 },
  xl: { label: "特大", scale: 1.25 },
};
const FONT_SCOPES = [
  { id: "chat", label: "聊天区", hint: "对话正文与输入框" },
  { id: "settings", label: "设置区", hint: "设置页正文与卡片" },
  { id: "other", label: "其他界面", hint: "任务中心、搜索、群组" },
];
const DEFAULT_FONT_SETTINGS = {
  base: "songti",
  chat: { font: "inherit", size: "md" },
  settings: { font: "inherit", size: "md" },
  other: { font: "inherit", size: "md" },
};

/** 读盘 / 表单值都先过这一层：未知字体 / 字号回落到默认，不把坏值写进 CSS。 */
function normalizeFontSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const settings = {
    base: Object.hasOwn(FONT_FAMILIES, source.base) ? source.base : "songti",
  };
  for (const scope of FONT_SCOPES) {
    const item = source[scope.id] && typeof source[scope.id] === "object" ? source[scope.id] : {};
    settings[scope.id] = {
      font:
        item.font === "inherit" || Object.hasOwn(FONT_FAMILIES, item.font)
          ? item.font
          : DEFAULT_FONT_SETTINGS[scope.id].font,
      size: Object.hasOwn(FONT_SIZES, item.size)
        ? item.size
        : DEFAULT_FONT_SETTINGS[scope.id].size,
    };
  }
  return settings;
}

function loadFontSettings() {
  try {
    return normalizeFontSettings(JSON.parse(localStorage.getItem(KEY_FONTS) || "null"));
  } catch {
    return normalizeFontSettings(null);
  }
}

function saveFontSettings(settings) {
  localStorage.setItem(KEY_FONTS, JSON.stringify(settings));
}

/** 把字体设置写到 :root 的 CSS 变量；不选分区的项删除覆盖，回落到全站 --font。 */
function applyFontSettings(settings = loadFontSettings()) {
  const next = normalizeFontSettings(settings);
  const root = document.documentElement;
  root.style.setProperty("--font", FONT_FAMILIES[next.base].stack);
  for (const scope of FONT_SCOPES) {
    const item = next[scope.id];
    if (item.font === "inherit") root.style.removeProperty(`--font-${scope.id}`);
    else root.style.setProperty(`--font-${scope.id}`, FONT_FAMILIES[item.font].stack);
    root.style.setProperty(`--zoom-${scope.id}`, String(FONT_SIZES[item.size].scale));
  }
}

function fontOptions(selected, includeInherit) {
  const inherit = includeInherit
    ? `<option value="inherit"${selected === "inherit" ? " selected" : ""}>跟随全站</option>`
    : "";
  return (
    inherit +
    Object.entries(FONT_FAMILIES)
      .map(
        ([id, item]) =>
          `<option value="${id}"${selected === id ? " selected" : ""}>${esc(item.label)}</option>`,
      )
      .join("")
  );
}

function fontSizeOptions(selected) {
  return Object.entries(FONT_SIZES)
    .map(
      ([id, item]) =>
        `<option value="${id}"${selected === id ? " selected" : ""}>${esc(item.label)}</option>`,
    )
    .join("");
}

function readFontForm(body) {
  const next = {
    base: body.querySelector("[data-font-base]")?.value || "songti",
  };
  for (const scope of FONT_SCOPES) {
    next[scope.id] = {
      font:
        body.querySelector(`select[data-font-scope="${scope.id}"][data-font-kind="font"]`)?.value ||
        "inherit",
      size:
        body.querySelector(`select[data-font-scope="${scope.id}"][data-font-kind="size"]`)?.value ||
        "md",
    };
  }
  return normalizeFontSettings(next);
}

/** 外观 → 字体：全站默认 + 三个区域；改动即时预览并自动保存。 */
function openFontModal() {
  const settings = loadFontSettings();
  openModal(
    "字体",
    (body) => {
      body.innerHTML = `
        <div class="font-form">
          <div class="font-row font-row-base">
            <div class="font-row-name"><span>全站默认</span><small>没单独设置的区域跟随这里</small></div>
            <select class="font-select" data-font-base aria-label="全站字体">${fontOptions(settings.base, false)}</select>
            <span class="font-row-note">字号按区域调</span>
          </div>
          <div class="font-divider"></div>
          <div class="font-row font-row-head" aria-hidden="true">
            <span>区域</span><span>字体</span><span>字号</span>
          </div>
          ${FONT_SCOPES.map(
            (scope) => `<div class="font-row">
              <div class="font-row-name"><span>${esc(scope.label)}</span><small>${esc(scope.hint)}</small></div>
              <select class="font-select" data-font-scope="${scope.id}" data-font-kind="font"
                      aria-label="${esc(scope.label)}字体">${fontOptions(settings[scope.id].font, true)}</select>
              <select class="font-select" data-font-scope="${scope.id}" data-font-kind="size"
                      aria-label="${esc(scope.label)}字号">${fontSizeOptions(settings[scope.id].size)}</select>
            </div>`,
          ).join("")}
        </div>
        <p class="font-note">字号会把该区域的文字、间距和控件一起缩放；不选就跟随全站。</p>
        <div class="modal-actions font-actions">
          <button class="ghost" type="button" id="font-reset">恢复默认</button>
          <span class="font-saved" id="font-saved"></span>
          <button class="modal-primary" type="button" id="font-done">完成</button>
        </div>`;

      const saved = body.querySelector("#font-saved");
      const update = () => {
        const next = readFontForm(body);
        saveFontSettings(next);
        applyFontSettings(next);
        if (saved) saved.textContent = "已保存";
      };
      for (const select of body.querySelectorAll(
        "select[data-font-base], select[data-font-scope]",
      )) {
        select.addEventListener("change", update);
      }
      body.querySelector("#font-reset")?.addEventListener("click", () => {
        saveFontSettings(DEFAULT_FONT_SETTINGS);
        applyFontSettings(DEFAULT_FONT_SETTINGS);
        const base = body.querySelector("[data-font-base]");
        if (base) base.value = DEFAULT_FONT_SETTINGS.base;
        for (const scope of FONT_SCOPES) {
          const font = body.querySelector(
            `select[data-font-scope="${scope.id}"][data-font-kind="font"]`,
          );
          const size = body.querySelector(
            `select[data-font-scope="${scope.id}"][data-font-kind="size"]`,
          );
          if (font) font.value = DEFAULT_FONT_SETTINGS[scope.id].font;
          if (size) size.value = DEFAULT_FONT_SETTINGS[scope.id].size;
        }
        if (saved) saved.textContent = "已恢复默认";
      });
      body.querySelector("#font-done")?.addEventListener("click", closeModal);
    },
    { className: "modal-font" },
  );
}

export { DEFAULT_FONT_SETTINGS, FONT_FAMILIES, FONT_SCOPES, FONT_SIZES, KEY_ACCENT, KEY_ACTS, KEY_FONTS, KEY_SEND, KEY_THEME, THEMES, THEME_IDS, applyFontSettings, applyTheme, currentThemeChoice, fontOptions, fontSizeOptions, loadFontSettings, normalizeFontSettings, openFontModal, readFontForm, saveFontSettings, setAccent, setThemeChoice, syncThemeControls };
