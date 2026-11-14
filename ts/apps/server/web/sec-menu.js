/**
 * 分区头 ⋯ 菜单（2026-11-14）
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
 * 菜单挂在 body 上 + position:fixed：.side-sec-clip 带 overflow:hidden，
 * 行内绝对定位会被整块裁掉（项目文件夹浮卡 2026-11-13 已经踩过一次）。
 * 坐标按入口按钮实测：右缘对齐按钮右缘、下方放不下就翻到上方、左右各留 8px；
 * 点外面 / Esc / 滚动 / 改窗口尺寸都关，同一时刻只开一张。
 *
 * Esc 用 window 捕获并 stopPropagation：全局 Esc 还负责退回设置页 / 任务页，
 * 不收口的话"菜单开着按 Esc"会连页面一起退（设置页 ⋯ 菜单 2026-11-14 实测踩过）。
 */

/** @typedef {{ label: string, hint?: string, kbd?: string, disabled?: boolean, run: () => void }} SecMenuItem */

/** @type {null | { button: HTMLElement, menu: HTMLElement, onDown: (event: PointerEvent) => void, onScroll: () => void, onResize: () => void, onKey: (event: KeyboardEvent) => void }} */
let openState = null;

function closeSecMenu() {
  if (!openState) return;
  const { button, menu, onDown, onScroll, onResize, onKey } = openState;
  // 先记焦点：menu.remove() 之后 activeElement 会掉回 body，键盘用户就丢了落点
  const hadFocus = menu.contains(document.activeElement);
  menu.remove();
  button.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onKey, true);
  openState = null;
  if (hadFocus) button.focus({ preventScroll: true });
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

function secMenuItem(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = item.hint ? "sec-menu-item is-rich" : "sec-menu-item";
  button.setAttribute("role", "menuitem");
  button.disabled = item.disabled === true;

  const label = document.createElement("span");
  label.className = "sec-menu-label";
  label.textContent = item.label;
  if (item.hint) {
    const hint = document.createElement("span");
    hint.className = "sec-menu-hint";
    hint.textContent = item.hint;
    label.append(hint);
  }
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
    item.run();
  });
  return button;
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

  const menu = document.createElement("div");
  menu.id = "sec-menu";
  menu.className = "sec-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", button.getAttribute("aria-label") || "分区动作");

  for (const item of items) {
    menu.append(secMenuItem(item));
  }
  document.body.append(menu);
  placeSecMenu(menu, button);
  button.setAttribute("aria-expanded", "true");

  const onDown = (event) => {
    const target = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
    if (!target) return;
    // 按钮里的 svg / 圆点也是"按钮自己"：只判 target === button 时，点到图标上会被当成
    // 点外面——先关、随后的 click 再开，同一颗 ⋯ 就永远关不掉（2026-11-14 实测踩到）。
    if (target.closest("#sec-menu") || button.contains(target)) return;
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

  // 键盘用户直接落到第一项；鼠标点开也顺手聚焦，Esc 之后回到 ⋯ 上
  const first = menu.querySelector("button:not(:disabled)");
  first?.focus({ preventScroll: true });
}

export { closeSecMenu, openSecMenu };
