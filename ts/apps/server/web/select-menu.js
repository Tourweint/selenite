/**
 * 全站原生 <select> 自绘化（2026-11-23 样式统一批，用户定稿 C 版）
 *
 * 起因：原生 select 的展开列表由系统画（Windows 灰底蓝选），和站内自绘面板两套语言；
 * 2026-11-21 只换掉了触发器上的灰三角，列表本身还是系统的。
 *
 * 做法：**渐进增强，不动调用方**。
 *   - 原 <select> 留在 DOM 里当唯一数据源（id / value / options / change 事件全部照旧），
 *     只加 `sel-src` 类隐藏；按钮插在它后面，原样复制它的 class —— 布局照旧由页面自己的
 *     `.set-input` / `.modal-input` / grid 格子管，21+ 处调用方一个字都不用改。
 *   - 每次打开时从 <select> 现读选项，所以动态重建选项（归档页按数据重建项目、模型链
 *     换供应商）不需要任何钩子；选中态 = 浅底行 + 右侧主题色对勾（用户从三版里选的 C）。
 *   - 键位：↑↓ 移动、Home/End、Enter/Space 选中、Esc 关闭、首字母跳转；焦点始终在按钮上。
 *
 * 刷新后生效；关 `UI_SELECT_MENU` 即退回原生 select（本模块不启动，页面按旧样式走）。
 */

import { chevDownSvg } from "./icons.js";

/** 面板里每行的对勾。选中行才可见（C 版），非选中行留同样宽度，避免文字左右跳。 */
const CHECK_SVG =
  '<svg class="sel-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** select → { select, button, face, observer }；用 Map 而不是 WeakMap：要能遍历回收。 */
const entries = new Map();
/** 当前打开的一份面板：{ entry, menu, items, active, button, buffer, bufferAt } */
let opened = null;
/** 滚动重定位的 rAF 节流（一次滚动风暴只量一次） */
let repositionPending = false;
let docObserver = null;
let uid = 0;

/* ── 安装 ───────────────────────────────────────────── */

export function initSelectMenus() {
  if (docObserver) return;
  for (const select of document.querySelectorAll("select")) enhance(select);
  // 动态 DOM（弹窗、设置页重渲染、模型链整段重建）全靠这一只观察器接住；
  // 只处理新增/移除的子树，不整页扫描。
  docObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scanAdded(node);
      for (const node of record.removedNodes) scanRemoved(node);
    }
  });
  docObserver.observe(document.body, { childList: true, subtree: true });
}

function scanAdded(node) {
  if (!(node instanceof Element)) return;
  if (node.tagName === "SELECT") enhance(node);
  else for (const select of node.querySelectorAll("select")) enhance(select);
}

function scanRemoved(node) {
  if (!(node instanceof Element)) return;
  const removed = node.tagName === "SELECT" ? [node] : [...node.querySelectorAll("select")];
  for (const select of removed) {
    const entry = entries.get(select);
    if (!entry) continue;
    if (opened?.entry === entry) closeMenu();
    entry.observer.disconnect();
    entry.button.remove();
    entries.delete(select);
  }
}

/* ── 增强单个 select ─────────────────────────────────── */

function enhance(select) {
  if (entries.has(select)) return;
  // 多选 / 列表式 select 面板长得不一样，本轮只接管单选的普通下拉。
  if (select.multiple || select.size > 1) return;
  // 弹窗刚 openModal 时会把焦点塞给第一个控件；随后本函数才把 select 藏起来，
  // 焦点会掉到 body——接住并转给触发钮。
  const hadFocus = document.activeElement === select;

  const face = document.createElement("span");
  face.className = "sel-face";

  const caret = document.createElement("span");
  caret.className = "sel-caret";
  caret.innerHTML = chevDownSvg("chev-ud");

  const button = document.createElement("button");
  button.type = "button";
  // 复制 className：高度 / 边框 / 内边距 / flex 槽位仍由页面原有类决定。
  button.className = select.className ? `sel-btn ${select.className}` : "sel-btn";
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.append(face, caret);

  const entry = { select, button, face, observer: null };
  select.classList.add("sel-src");
  select.after(button);

  entry.observer = new MutationObserver(() => {
    syncEntry(entry);
    // 选项被整段重建 / 控件被禁用时，还开着的面板已经对不上了
    if (opened?.entry === entry) closeMenu();
  });
  entry.observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "hidden", "aria-label"],
  });
  select.addEventListener("change", () => syncEntry(entry));
  // 调用方直接 `select.value = x`（如外观页「恢复默认字体」）不触发 change，也不会改 DOM；
  // 实例级覆写 setter，读仍走原型，只补一次面板文案同步。
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (proto?.get && proto?.set) {
    try {
      Object.defineProperty(select, "value", {
        configurable: true,
        get() {
          return proto.get.call(select);
        },
        set(next) {
          proto.set.call(select, next);
          syncEntry(entry);
        },
      });
    } catch {
      /* 个别环境不允许实例覆写：退化成 change / 打开时同步，不报错 */
    }
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (opened?.entry === entry) closeMenu();
    else openMenu(entry);
  });
  button.addEventListener("keydown", (event) => {
    if (opened?.entry === entry) {
      handleOpenKey(event);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu(entry, { keyboard: true });
    }
  });

  entries.set(select, entry);
  syncEntry(entry);
  if (hadFocus) button.focus();
}

function syncEntry(entry) {
  const { select, button, face } = entry;
  const option = select.selectedOptions[0];
  face.textContent = option ? option.textContent.trim() : "";
  button.disabled = select.disabled;
  button.hidden = select.hidden;
  const label = select.getAttribute("aria-label");
  if (label) button.setAttribute("aria-label", label);
  else button.removeAttribute("aria-label");
}

/* ── 面板 ───────────────────────────────────────────── */

function openMenu(entry, options = {}) {
  closeMenu();
  const { select, button } = entry;
  if (button.disabled || button.hidden) return;

  const menu = document.createElement("div");
  menu.className = "sel-menu";
  menu.id = `sel-menu-${++uid}`;
  menu.setAttribute("role", "listbox");
  const label = select.getAttribute("aria-label");
  if (label) menu.setAttribute("aria-label", label);

  const items = [];
  let truncated = false;
  const rowOf = (option, groupDisabled) => {
    if (option.hidden) return;
    if (items.length >= 600) {
      truncated = true;
      return;
    }
    const item = document.createElement("div");
    item.className = "sel-item";
    item.id = `${menu.id}-${items.length}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(option.selected));
    if (option.disabled || groupDisabled) item.setAttribute("aria-disabled", "true");
    const name = document.createElement("span");
    name.className = "sel-name";
    name.textContent = option.textContent.trim();
    item.append(name);
    item.insertAdjacentHTML("beforeend", CHECK_SVG);
    // 禁用项（含整组禁用）只画出来，不挂点击：不能靠 aria-disabled 兜底
    if (!option.disabled && !groupDisabled) item.addEventListener("click", () => pick(entry, option));
    menu.append(item);
    items.push(item);
  };

  for (const child of select.children) {
    if (child.tagName === "OPTGROUP") {
      const head = document.createElement("div");
      head.className = "sel-group";
      head.setAttribute("role", "presentation");
      head.textContent = child.label;
      menu.append(head);
      for (const option of child.children) if (option.tagName === "OPTION") rowOf(option, child.disabled);
    } else if (child.tagName === "OPTION") {
      rowOf(child, false);
    }
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "sel-empty";
    empty.textContent = "没有可选项";
    menu.append(empty);
  }
  if (truncated) {
    const note = document.createElement("div");
    note.className = "sel-empty";
    note.textContent = "只显示前 600 项";
    menu.append(note);
  }

  document.body.append(menu);
  placeMenu(menu, button);

  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-controls", menu.id);
  opened = { entry, menu, items, active: -1, buffer: "", bufferAt: 0 };
  const selected = items.findIndex((item) => item.getAttribute("aria-selected") === "true" && !isDisabled(item));
  const first = items.findIndex((item) => !isDisabled(item));
  setActive(options.keyboard ? (selected >= 0 ? selected : first) : selected >= 0 ? selected : -1);

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
}

function placeMenu(menu, button) {
  const rect = button.getBoundingClientRect();
  // 面板可以比触发钮宽（会话名 / 模型 id 常比控件长）：按内容量一次，钳到 420px 与视口内。
  const maxWidth = Math.min(420, window.innerWidth - 16);
  menu.style.width = "max-content";
  menu.style.maxWidth = `${maxWidth}px`;
  const intrinsic = menu.getBoundingClientRect().width;
  const width = Math.max(Math.round(rect.width), Math.min(Math.round(intrinsic), maxWidth));
  menu.style.width = `${width}px`;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  const height = menu.getBoundingClientRect().height;
  if (rect.bottom + 6 + height > window.innerHeight - 8 && rect.top - 6 - height > 8) {
    menu.style.top = `${rect.top - 6 - height}px`;
  }
}

function closeMenu() {
  if (!opened) return;
  const { entry, menu } = opened;
  opened = null;
  menu.remove();
  if (entry.button.isConnected) {
    entry.button.setAttribute("aria-expanded", "false");
    entry.button.removeAttribute("aria-activedescendant");
  }
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
}

function onPointerDown(event) {
  if (!opened) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (opened.menu.contains(target) || opened.entry.button.contains(target)) return;
  closeMenu();
}

function onScroll(event) {
  // 滚动不关面板：任何滚动容器一滚就关，聊天自动滚屏会把正在选的下拉反复打断。
  // 改成跟着触发钮重定位；滚出视口才关。面板内部自己的滚动不用管。
  if (!opened || repositionPending) return;
  if (event.target instanceof Node && opened.menu.contains(event.target)) return;
  repositionPending = true;
  requestAnimationFrame(() => {
    repositionPending = false;
    if (!opened) return;
    const rect = opened.entry.button.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      closeMenu();
      return;
    }
    placeMenu(opened.menu, opened.entry.button);
  });
}

function onResize() {
  if (!opened) return;
  placeMenu(opened.menu, opened.entry.button);
}

/* ── 选中与键位 ──────────────────────────────────────── */

function pick(entry, option) {
  if (option.disabled) return;
  const previous = entry.select.selectedOptions[0];
  option.selected = true;
  syncEntry(entry);
  closeMenu();
  entry.button.focus();
  if (previous !== option) entry.select.dispatchEvent(new Event("change", { bubbles: true }));
}

const isDisabled = (item) => item.getAttribute("aria-disabled") === "true";

function setActive(index) {
  if (!opened) return;
  opened.active = index;
  opened.items.forEach((item, at) => item.classList.toggle("is-active", at === index && !isDisabled(item)));
  const item = opened.items[index];
  if (!item) {
    opened.entry.button.removeAttribute("aria-activedescendant");
    return;
  }
  opened.entry.button.setAttribute("aria-activedescendant", item.id);
  item.scrollIntoView({ block: "nearest" });
}

function step(from, delta) {
  const { items } = opened;
  let index = from;
  for (let i = 0; i < items.length; i += 1) {
    index = (index + delta + items.length) % items.length;
    if (!isDisabled(items[index])) return index;
  }
  return from;
}

function handleOpenKey(event) {
  if (!opened) return;
  const key = event.key;
  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    setActive(step(opened.active, key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (key === "Home" || key === "End") {
    event.preventDefault();
    const first = opened.items.findIndex((item) => !isDisabled(item));
    if (key === "Home") setActive(first);
    else {
      for (let i = opened.items.length - 1; i >= 0; i -= 1) {
        if (!isDisabled(opened.items[i])) {
          setActive(i);
          break;
        }
      }
    }
    return;
  }
  if (key === "Enter" || key === " ") {
    event.preventDefault();
    const item = opened.items[opened.active];
    if (item) item.click();
    else closeMenu();
    return;
  }
  if (key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    return;
  }
  if (key === "Tab") {
    closeMenu();
    return;
  }
  // 首字母 / 连续字母跳转：和原生 select 的手感一致
  if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const now = Date.now();
    opened.buffer = now - opened.bufferAt > 600 ? key : opened.buffer + key;
    opened.bufferAt = now;
    const needle = opened.buffer.toLowerCase();
    const { items } = opened;
    for (let i = 1; i <= items.length; i += 1) {
      const index = (opened.active + i) % items.length;
      const item = items[index];
      if (!isDisabled(item) && item.textContent.trim().toLowerCase().startsWith(needle)) {
        setActive(index);
        break;
      }
    }
    event.preventDefault();
  }
}
