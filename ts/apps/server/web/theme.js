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
import { ACCENTS } from "./settings-base.js";
import { closeModal, openModal } from "./ui-atoms.js";

/* ── 主题（2026-11-05：四套色板） ─────────────────────── */

const KEY_THEME = "lifediary.theme";
const KEY_ACCENT = "lifediary.accent";
const KEY_ACCENT_CUSTOM = "lifediary.accentCustom";
const KEY_SEND = "lifediary.sendKey";
/** 自定义取色：没选过时色盘停在这里（与默认靛蓝同色） */
const ACCENT_CUSTOM_FALLBACK = "#3e4a8c";
const DARK_THEME_IDS = ["indigo", "black"];

/* id 与 html[data-theme] 一一对应；预览色写死，不跟当前 token 走。
   white/black 2026-11-08 柔化（纯白纯黑太刺眼），预览色随 token 同步。
   2026-11-14 外观页改 A 版（缩略界面卡）：每套多带 tag（名字右边那一个字）和
   缩略图要用的几档色（侧栏底 / 卡 / 描边 / 分隔 / 正文 / 弱字）。
   缩略图里的强调点是该主题自带的那一档，不跟当前选的主题色走 —— 它是"这套主题长什么样"，
   不是"你现在选了哪个强调色"。 */
const THEMES = [
  {
    id: "paper", name: "米黄", tag: "纸",
    bg: "#fdf9f2", side: "#f7f3eb", card: "#f6f1e7", cardHigh: "#ede9e0",
    outline: "#c8c5bc", divider: "rgba(200,197,188,.55)", text: "#2e2b3a", text3: "#9a97a5",
    accent: "#3e4a8c",
  },
  {
    id: "white", name: "暖白", tag: "素",
    bg: "#fafaf8", side: "#f3f3f0", card: "#f4f4f1", cardHigh: "#ededea",
    outline: "#d7d7d3", divider: "rgba(0,0,0,.10)", text: "#1a1a1e", text3: "#9b9ba4",
    accent: "#3e4a8c",
  },
  {
    id: "celadon", name: "青瓷", tag: "瓷",
    bg: "#f1f5f1", side: "#e8eee8", card: "#ebf1ea", cardHigh: "#e0e7df",
    outline: "#c2cec3", divider: "rgba(30,42,37,.12)", text: "#1e2a25", text3: "#8b9a90",
    accent: "#3e4a8c",
  },
  {
    id: "indigo", name: "靛蓝夜", tag: "夜",
    bg: "#12141d", side: "#181b26", card: "#191c27", cardHigh: "#212433",
    outline: "#3a3f52", divider: "rgba(255,255,255,.09)", text: "#e7e9f2", text3: "#6d7183",
    accent: "#8b97ea",
  },
  {
    id: "black", name: "炭黑", tag: "炭",
    bg: "#17171a", side: "#121215", card: "#1d1d21", cardHigh: "#242429",
    outline: "#3a3a44", divider: "rgba(255,255,255,.12)", text: "#e6e6ea", text3: "#66666f",
    accent: "#8b97ea",
  },
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

/** 把当前主题回写给壳（2026-11-14）：下次开窗时启动页要按它铺纸或铺夜。
 *  壳读不到 WebView 的 localStorage，只能自己记一份。
 *  普通浏览器里没有 window.mygo，静默跳过；返回的 Promise 失败也不影响这一版。 */
function tellShellTheme(theme) {
  try {
    const bridge = window.mygo;
    if (!bridge || typeof bridge.call !== "function") return;
    const result = bridge.call.call(bridge, "Shell.SetTheme", theme);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (e) { /* 记不上不影响这一版 */ }
}

function setThemeChoice(choice) {
  const theme = THEME_IDS.includes(choice) ? choice : "paper";
  localStorage.setItem(KEY_THEME, theme);
  applyTheme(theme);
  tellShellTheme(theme);
  // 自定义取色要看当前主题是浅底还是深底来挑那一档，换主题得重算一次
  applyAccentStyle(storedAccent());
  syncThemeControls();
}

/** 当前那档主题色（脏值回落靛蓝；custom 也认） */
function storedAccent() {
  const stored = localStorage.getItem(KEY_ACCENT);
  if (stored === "custom") {
    return localStorage.getItem(KEY_ACCENT_CUSTOM) ? "custom" : "indigo";
  }
  return ACCENTS.some((item) => item.id === stored) ? stored : "indigo";
}

/** 自定义取色（2026-11-14）：预设里没有的色由用户自己挑，写成 <html> 的行内变量。
 *  浅底用原色 + 白字；夜主题把色提亮一档、容器压深一档，和七档预设同一套口径。 */
function applyCustomAccent(hex) {
  const root = document.documentElement;
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : ACCENT_CUSTOM_FALLBACK;
  const dark = DARK_THEME_IDS.includes(root.dataset.theme);
  const pairs = dark
    ? {
        "--accent": `color-mix(in srgb, ${value} 62%, #ffffff)`,
        "--on-accent": `color-mix(in srgb, ${value} 24%, #0a0c12)`,
        "--accent-container": `color-mix(in srgb, ${value} 24%, var(--bg))`,
        "--on-accent-container": `color-mix(in srgb, ${value} 72%, #ffffff)`,
      }
    : {
        "--accent": value,
        "--on-accent": "#ffffff",
        "--accent-container": `color-mix(in srgb, ${value} 13%, var(--bg))`,
        "--on-accent-container": `color-mix(in srgb, ${value} 82%, var(--text))`,
      };
  for (const [name, computed] of Object.entries(pairs)) root.style.setProperty(name, computed);
}

/** 把主题色落到 CSS：预设交给 style-01 的 [data-accent] 规则，自定义/回预设时要清行内值。 */
function applyAccentStyle(accent = storedAccent()) {
  const root = document.documentElement;
  root.dataset.accent = accent === "custom" ? "custom" : accent;
  if (accent === "custom") {
    applyCustomAccent(localStorage.getItem(KEY_ACCENT_CUSTOM) || ACCENT_CUSTOM_FALLBACK);
    return;
  }
  for (const name of ["--accent", "--on-accent", "--accent-container", "--on-accent-container"]) {
    root.style.removeProperty(name);
  }
}

/** 选主题色：preset id，或传 hex 走自定义那档 */
function setAccent(name, hex) {
  if (name === "custom") {
    const value = /^#[0-9a-f]{6}$/i.test(String(hex || "")) ? String(hex) : ACCENT_CUSTOM_FALLBACK;
    localStorage.setItem(KEY_ACCENT_CUSTOM, value);
    localStorage.setItem(KEY_ACCENT, "custom");
  } else {
    localStorage.setItem(KEY_ACCENT, ACCENTS.some((item) => item.id === name) ? name : "indigo");
  }
  applyAccentStyle(name === "custom" ? "custom" : name);
  syncThemeControls();
}

function syncThemeControls() {
  const choice = currentThemeChoice();
  for (const button of el.settingsInner.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.themeChoice === choice));
  }
  const accent = storedAccent();
  for (const button of el.settingsInner.querySelectorAll("[data-accent-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.accentChoice === accent));
  }
  // 自定义那个取色圈不在 [data-accent-choice] 里（它开的是系统色盘），单独描一下
  el.settingsInner
    .querySelector("[data-accent-pick]")
    ?.setAttribute("aria-checked", String(accent === "custom"));
  const chip = el.settingsInner.querySelector("[data-accent-pick] i");
  if (chip) {
    chip.style.background = localStorage.getItem(KEY_ACCENT_CUSTOM) || "#3e4a8c";
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

export { ACCENT_CUSTOM_FALLBACK, DEFAULT_FONT_SETTINGS, FONT_FAMILIES, FONT_SCOPES, FONT_SIZES, KEY_ACCENT, KEY_ACCENT_CUSTOM, KEY_FONTS, KEY_SEND, KEY_THEME, THEMES, THEME_IDS, applyAccentStyle, applyFontSettings, applyTheme, currentThemeChoice, fontOptions, fontSizeOptions, loadFontSettings, normalizeFontSettings, openFontModal, readFontForm, saveFontSettings, setAccent, setThemeChoice, storedAccent, syncThemeControls };
