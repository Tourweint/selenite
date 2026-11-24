/**
 * 自绘窗口三键（仅 MyGo 壳内）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { go } from "./route.js";
import { closeMenu, setMenuOpen } from "./shell.js";


/* ── 自绘窗口三键（仅 MyGo 壳内） ─────────────────────── */

// 普通浏览器没有 MyGo API：按钮保持 hidden，避免出现点了没反应的按钮。
// 注意 MyGo 运行时暴露的方法是首字母小写：minimize / toggleMaximize / isMaximized / close，
// 且 window.mygo.window 是冻结对象，取不到时只能静默，所以大小写必须对。
const shellWindow = (() => {
  try {
    if (typeof window.isMyGo !== "function" || !window.isMyGo()) return null;
    return window.mygo?.window ?? null;
  } catch {
    return null;
  }
})();

async function callWindow(method) {
  try {
    const result = shellWindow?.[method]?.();
    // 接口可能是同步返回值，也可能返回 Promise；两种都等它结束
    if (result && typeof result.then === "function") await result;
  } catch {
    /* 壳没接上就静默，别把按钮变成报错源 */
  }
}

async function readMaximized() {
  try {
    const value = shellWindow?.isMaximized?.();
    const resolved = value && typeof value.then === "function" ? await value : value;
    return Boolean(resolved);
  } catch {
    return false;
  }
}

/** 最大化/还原图标、aria-label 与窗口状态对齐 */
async function syncWindowState() {
  if (!shellWindow) return;
  const maximized = await readMaximized();
  const maxIcon = el.winMax.querySelector(".ico-max");
  const restoreIcon = el.winMax.querySelector(".ico-restore");
  // SVGElement 没有 hidden IDL 属性，直接赋值只写 JS 对象、不落到 HTML 属性，
  // 而 [hidden]{display:none} 只认属性，所以必须用 toggleAttribute。
  if (maxIcon) maxIcon.toggleAttribute("hidden", maximized);
  if (restoreIcon) restoreIcon.toggleAttribute("hidden", !maximized);
  el.winMax.setAttribute("aria-label", maximized ? "还原窗口" : "最大化窗口");
}

if (shellWindow) {
  el.windowControls.hidden = false;
  el.winMin.addEventListener("click", () => void callWindow("minimize"));
  el.winMax.addEventListener("click", async () => {
    await callWindow("toggleMaximize");
    await syncWindowState();
  });
  el.winClose.addEventListener("click", () => void callWindow("close"));
  // 双击标题栏 / 系统贴靠 / 拖出边界都会改变窗口尺寸，图标跟着走
  window.addEventListener("resize", () => void syncWindowState());
  void syncWindowState();
}

el.menuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenuOpen(el.menuPop.hidden);
});
el.menuPop.addEventListener("click", (event) => {
  const item = event.target.closest("[data-action]");
  if (!item) return;
  closeMenu();
  if (item.dataset.action === "settings") {
    go("settings");
  } else if (item.dataset.action === "new") {
    // 普通助手（worker）2026-11-23 退役：托盘/窗口菜单的「新建」= 建一张派给池的任务票。
    void import("./tasks-create.js").then((module) => module.openCreateTaskModal());
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) closeMenu();
});

export { callWindow, readMaximized, shellWindow, syncWindowState };
