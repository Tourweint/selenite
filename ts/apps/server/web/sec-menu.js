/**
 * 分区头 ⋯ 菜单 / 右键菜单（2026-11-14 建，2026-11-16 加右键）
 *
 * 用户口径：「展开时右边现在全是加号，改成三个小点点，点开就能选择新建还是搜索，
 * 比如对话有新建、有搜索，但其他现在只有新建。多了不太好看，统一放在右边，
 * 留三个小点点即可。」
 *
 * 改之前每个分区头右边挂一颗 ＋：执事 / 对话 / 项目 / 群组一列四颗同形按钮，
 * 比分区名还抢眼；「对话」那颗旁边还并排一颗放大镜（搜索入口），一区两颗。
 * 现在统一成一颗 ⋯，点开才看得到这一区能做什么：
 *   执事：新建执事
 *   对话：新建对话（Ctrl+K）/ 搜索旧对话（原来的放大镜收进来）
 *   项目：新建项目 / 添加项目
 *   群组：新建群组
 *
 * 2026-11-16 右键：同一份菜单外壳也给侧栏行用（openMenuAt 按光标定位），
 * 不再单独长一套 .gmenu 那样的样式。原生菜单在 context-menu.js 里统一关掉。
 *
 * 菜单挂在 body 上 + position:fixed：.side-sec-clip 带 overflow:hidden，
 * 行内绝对定位会被整块裁掉（项目文件夹浮卡 2026-11-13 已经踩过一次）。
 * 坐标按入口按钮实测：右缘对齐按钮右缘、下方放不下就翻到上方、左右各留 8px；
 * 右键菜单按光标落点，右/下放不下就翻到光标左侧/上方。
 * 点外面 / Esc / 滚动 / 改窗口尺寸都关，同一时刻只开一张。
 *
 * Esc 用 window 捕获并 stopPropagation：全局 Esc 还负责退回设置页 / 任务页，
 * 不收口的话"菜单开着按 Esc"会连页面一起退（设置页 ⋯ 菜单 2026-11-14 实测踩过）。
 */

/** @typedef {{ label?: string, kbd?: string, disabled?: boolean, danger?: boolean, separator?: boolean, run?: () => void }} SecMenuItem */

import { markNativePopupsBroken, nativePopupsReady } from "./ui-atoms.js";

/** @type {null | { button: HTMLElement | null, menu: HTMLElement, onDown: (event: PointerEvent) => void, onScroll: () => void, onResize: () => void, onKey: (event: KeyboardEvent) => void }} */
let openState = null;

/* 原生菜单开着时，落在页面上的那一次外点击要吞掉（2026-11-22）。
 *
 * 壳在按下时已经先把菜单收起，但 WebView 子窗不是壳自己的窗口：WM_MOUSEACTIVATE
 * 的「激活父窗并吃掉这一下」管不到它，click 仍会交给页面。于是同一个 ⋯ 的第二次
 * 点击会「关掉又立刻打开」（用户看到的菜单卡片闪一下），点别处则会误触底下的行。
 * 按下时记一笔、吞掉紧跟的 click，就回到 Windows 菜单「第一下只关、不选」的口径。
 * 菜单自己选中的动作在原生小窗里完成，不会经过这里。 */
let nativeMenusOpen = 0;
let nativeDismissClick = false;
let nativeDismissTimer = 0;
// 只补 Windows：macOS 的弹出层本来就允许外点击继续落到下面（框架明确保持那个手感），
// 而 Linux / Windows 的「按下只关菜单」在 WebView 子窗这半边丢了。
const nativeMenuEatsPress = /Windows/i.test(navigator.userAgent);

document.addEventListener(
  "pointerdown",
  () => {
    if (!nativeMenuEatsPress) return;
    if (!nativeMenusOpen) {
      // 新的一次按下说明上一次已经结束；上一按要是拖拽没出 click，别吞掉这一次
      nativeDismissClick = false;
      clearTimeout(nativeDismissTimer);
      return;
    }
    nativeDismissClick = true;
    clearTimeout(nativeDismissTimer);
    // 按下后拖走不会出 click；别把很久以后键盘触发的 click 也吞了
    nativeDismissTimer = setTimeout(() => {
      nativeDismissClick = false;
    }, 1500);
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    if (!nativeDismissClick) return;
    nativeDismissClick = false;
    clearTimeout(nativeDismissTimer);
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);

/** 让壳画菜单（2026-11-19 批1，desktop/popovers.go）：true=壳接了。
 *  业务闭包不过桥：桥上只过显示字段，壳阻塞到用户选完、resolve 所选序号，
 *  这里再本地跑对应的 run。序号 -1 = 用户按掉（外点击 / Esc），什么都不做。
 *  壳侧出错（开关刚翻走、壳退回旧版）→ markNativePopupsBroken 粘性关原生，
 *  本次会话全走 DOM；当次先走 domFallback 兜底，不让人点了个寂寞。 */
function shellShowMenu(anchor, placement, items, domFallback, onDone) {
  const bridge = window.mygo;
  if (typeof bridge?.call !== "function") return false;
  const runs = [];
  const payload = items.map((item) => {
    if (item.separator) {
      runs.push(null);
      return { separator: true };
    }
    runs.push(typeof item.run === "function" ? item.run : null);
    return {
      label: item.label || "",
      kbd: item.kbd || "",
      danger: item.danger === true,
      disabled: item.disabled === true,
    };
  });
  try {
    const result = bridge.call.call(bridge, "Shell.ShowMenu", { anchor, placement, items: payload });
    if (result && typeof result.then === "function") {
      nativeMenusOpen += 1;
      result
        .then((chosen) => {
          if (Number.isInteger(chosen) && chosen >= 0 && chosen < runs.length) runs[chosen]?.();
          onDone?.();
        })
        .catch(() => {
          markNativePopupsBroken();
          onDone?.();
          domFallback?.();
        })
        .finally(() => {
          nativeMenusOpen = Math.max(0, nativeMenusOpen - 1);
        });
    }
    return true;
  } catch {
    return false;
  }
}

function closeSecMenu() {
  if (!openState) return;
  const { button, menu, onDown, onScroll, onResize, onKey } = openState;
  // 先记焦点：menu.remove() 之后 activeElement 会掉回 body，键盘用户就丢了落点
  const hadFocus = menu.contains(document.activeElement);
  menu.remove();
  if (button) button.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onKey, true);
  openState = null;
  if (hadFocus && button?.isConnected) button.focus({ preventScroll: true });
}

/** 右缘对齐按钮，放不下翻到上方；都夹在视口里（左右 8px、顶部不低于 8px）。 */
function placeSecMenu(menu, button) {
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = rect.right - width;
  let top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(8, top))}px`;
}

/** 右键菜单贴光标：右/下越界就翻到光标左侧/上方，最后夹进视口。 */
function placeSecMenuAtPoint(menu, x, y) {
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const gap = 2;
  let left = x + gap;
  let top = y + gap;
  if (left + width > window.innerWidth - 8) left = x - width - gap;
  if (top + height > window.innerHeight - 8) top = y - height - gap;
  left = Math.max(8, Math.min(left, window.innerWidth - 8 - width));
  top = Math.max(8, Math.min(top, window.innerHeight - 8 - height));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function secMenuItem(item) {
  const button = document.createElement("button");
  button.type = "button";
  const classes = ["sec-menu-item"];
  if (item.danger) classes.push("is-danger");
  button.className = classes.join(" ");
  button.setAttribute("role", "menuitem");
  button.disabled = item.disabled === true;

  const label = document.createElement("span");
  label.className = "sec-menu-label";
  label.textContent = item.label || "";
  button.append(label);

  if (item.kbd) {
    const kbd = document.createElement("span");
    kbd.className = "sec-menu-kbd";
    kbd.textContent = item.kbd;
    button.append(kbd);
  }

  button.addEventListener("click", () => {
    // 先关再跑：动作里可能开模态 / 切路由，菜单不该留在屏上
    closeSecMenu();
    item.run?.();
  });
  return button;
}

function buildMenu(items, label) {
  const menu = document.createElement("div");
  menu.id = "sec-menu";
  menu.className = "sec-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label || "菜单");
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("span");
      sep.className = "sec-menu-sep";
      sep.setAttribute("role", "separator");
      menu.append(sep);
      continue;
    }
    menu.append(secMenuItem(item));
  }
  return menu;
}

/** 挂全局关闭监听 + 方向键导航；button 为空表示右键菜单（光标定位，无回焦目标）。 */
function wireMenu(menu, button) {
  const onDown = (event) => {
    const target = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
    if (!target) return;
    // 按钮里的 svg / 圆点也是"按钮自己"：只判 target === button 时，点到图标上会被当成
    // 点外面——先关、随后的 click 再开，同一颗 ⋯ 就永远关不掉（2026-11-14 实测踩到）。
    if (target.closest("#sec-menu") || (button && button.contains(target))) return;
    closeSecMenu();
  };
  const onScroll = () => closeSecMenu();
  const onResize = () => closeSecMenu();
  const onKey = (event) => {
    if (event.key === "Escape") {
      // 输入法组字中的 Esc 不算（跟全局那条同一豁免）
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      // 捕获阶段收口：不然全局 Esc 会顺手把设置页 / 任务页也退掉
      event.stopPropagation();
      closeSecMenu();
      return;
    }
    if (event.key === "Tab") {
      // Tab 是"离开菜单"：收起后让焦点照常往下走
      closeSecMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index < 0 ? 0 : (index + step + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  };

  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKey, true);
  openState = { button, menu, onDown, onScroll, onResize, onKey };
}

/**
 * 打开某个分区头的 ⋯ 菜单；同一个按钮再点一下就是关。
 * @param {HTMLElement | null | undefined} button
 * @param {SecMenuItem[]} items
 */
function openSecMenu(button, items) {
  if (!button || button.disabled) return;
  const same = openState?.button === button;
  closeSecMenu();
  if (same) return;

  // 原生菜单（2026-11-19 批1）：锚 ⋯ 按钮矩形、右缘对齐（bottom-end）、Gap 6，
  // 与 web 版 placeSecMenu 的定位口径一致；翻转 / 越界壳自己处理。
  // Windows 上外点击只关菜单不穿透，所以「再点一下 ⋯」是按下即关、不会重开。
  if (nativePopupsReady()) {
    const rect = button.getBoundingClientRect();
    button.setAttribute("aria-expanded", "true");
    const ok = shellShowMenu(
      { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      "bottom-end",
      items,
      () => openSecMenu(button, items),
      () => {
        // 菜单关了（选中或按掉都算）：把 ⋯ 的展开态还原
        if (button.isConnected) button.setAttribute("aria-expanded", "false");
      },
    );
    if (ok) return;
    button.setAttribute("aria-expanded", "false");
  }

  const menu = buildMenu(items, button.getAttribute("aria-label") || "分区动作");
  document.body.append(menu);
  placeSecMenu(menu, button);
  button.setAttribute("aria-expanded", "true");
  wireMenu(menu, button);

  // 键盘用户直接落到第一项；鼠标点开也顺手聚焦，Esc 之后回到 ⋯ 上
  const first = menu.querySelector("button:not(:disabled)");
  first?.focus({ preventScroll: true });
}

/**
 * 在光标处打开右键菜单（侧栏行等）。
 * @param {number} x
 * @param {number} y
 * @param {SecMenuItem[]} items
 * @param {string} [label]
 */
function openMenuAt(x, y, items, label = "操作") {
  if (!items.length) return;
  closeSecMenu();

  // 原生菜单（2026-11-19 批1）：贴光标零尺寸锚点、bottom-start、Gap 2，
  // 与 web 版 placeSecMenuAtPoint 的定位口径一致。输入框右键（context-menu.js）、
  // 侧栏行菜单、选中文字复制都从这里走，一处分叉整族原生化。
  if (nativePopupsReady()) {
    const ok = shellShowMenu(
      { x: Math.round(x), y: Math.round(y), width: 0, height: 0 },
      "bottom-start",
      items,
      () => openMenuAt(x, y, items, label),
    );
    if (ok) return;
  }

  const menu = buildMenu(items, label);
  menu.classList.add("is-context");
  document.body.append(menu);
  placeSecMenuAtPoint(menu, x, y);
  wireMenu(menu, null);
  // 右键菜单也把焦点放到第一项：方向键 / Enter 能直接操作，Esc 关掉
  const first = menu.querySelector("button:not(:disabled)");
  first?.focus({ preventScroll: true });
}

export { closeSecMenu, openMenuAt, openSecMenu };
