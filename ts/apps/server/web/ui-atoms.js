/**
 * toast / composer 弹出层 / 通用模态
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { projectAnchor } from "./project-modal.js";
import { currentRoute } from "./route.js";

/* ── 模型快捷切换（2026-11-04 批次五）──────────────────────
 * 数据源 GET /api/v1/agent/model（composer 投影，不含 baseUrl / keyEnv）。
 * 每次打开现拉：配置可能刚在设置页改过，也可能是另一台设备改的；不要缓存。 */

let toastTimer = 0;
function toast(text) {
  if (!el.toast) return;
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (el.toast) el.toast.hidden = true;
  }, 3800);
}

/* ── composer 弹出层（2026-11-04，抄 cindy morph-popover）────────
 * 模型菜单共用这一套：打开时从 pill 位置向上浮 6px 淡入，关闭反向缩回，
 * 220ms；圆角起点 15px（= 30px pill 高的一半），插值中间帧不会鼓包。
 * 动画期间把 overflow 收住，结束才放开滚动；reduced-motion 直接切。 */
const POP_MS = 220;
const noMotion = matchMedia("(prefers-reduced-motion: reduce)");
const popTimers = new WeakMap();

/** 真正处于「打开」状态：正在关闭（pop-closing）也算关 */
function popoverOpen(menu) {
  return Boolean(menu) && !menu.hidden && !menu.classList.contains("pop-closing");
}

function openPopover(menu, trigger) {
  if (!menu || !trigger) return;
  clearTimeout(popTimers.get(menu));
  menu.classList.remove("pop-closing");
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  // 窄窗口贴边修正：默认贴 pill 左边弹出，越过右边界就改贴右边（手机宽度必需）
  menu.style.left = "";
  menu.style.right = "";
  if (menu.getBoundingClientRect().right > window.innerWidth - 12) {
    menu.style.left = "auto";
    menu.style.right = "0";
  }
  if (noMotion.matches) {
    menu.style.overflow = "";
    return;
  }
  // 先摘 class 并强制重排，连续开关时动画才会重放
  menu.classList.remove("pop-open");
  void menu.offsetWidth;
  menu.classList.add("pop-open");
  menu.style.overflow = "hidden";
  popTimers.set(menu, setTimeout(() => {
    menu.classList.remove("pop-open");
    menu.style.overflow = "";
  }, POP_MS));
}

function closePopover(menu, trigger) {
  if (!menu || menu.hidden) return;
  trigger?.setAttribute("aria-expanded", "false");
  clearTimeout(popTimers.get(menu));
  if (noMotion.matches) {
    menu.hidden = true;
    menu.classList.remove("pop-open", "pop-closing");
    menu.style.overflow = "";
    return;
  }
  menu.classList.remove("pop-open");
  void menu.offsetWidth;
  menu.classList.add("pop-closing");
  menu.style.overflow = "hidden";
  popTimers.set(menu, setTimeout(() => {
    menu.classList.remove("pop-closing");
    menu.hidden = true;
    menu.style.overflow = "";
  }, POP_MS));
}

/* ── 通用模态弹窗 + 目录选择（2026-11-05 F1）──────────────
 * 纯手写，不引库：openModal(title, bodyBuilder) 每次重建 body。
 * 遮罩/内容/进出场全在 CSS；这里只管开关、焦点与 Esc。
 * 与 composer 的 morph 弹层并存：弹层贴触发点，模态居中，互不影响。 */

const MODAL_MS = 100;
/** 刚打开的弹层在这么短时间内不接遮罩关闭：双击触发钮时，第二下会落在遮罩上。 */
const MODAL_GUARD_MS = 500;
/** 同一落点连点的更长时间保护：慢一点的双击也不会把刚开的弹层关掉。 */
const MODAL_SAME_POINT_MS = 2000;
const MODAL_SAME_POINT_PX = 48;
let modalTimer = 0;
let modalOpenedAt = 0;
let modalOpenPoint = null;
let modalLastClick = null;
let modalCloseOnMask = true;
let modalReturnFocus = null;
/** 关闭回调：确认框靠它在被遮罩 / ✕ / Esc 关掉时 resolve(false)。 */
let modalOnClose = null;

function modalOpen() {
  return Boolean(el.modal) && !el.modal.hidden;
}

// 记录最近一次点击的落点：openModal 用它判断「遮罩这一下是不是刚触发弹层的那只手指」。
document.addEventListener("click", (event) => {
  modalLastClick = { x: event.clientX, y: event.clientY, at: Date.now() };
}, true);

function openModal(title, build, { className = "", onClose = null, closeOnMask = true } = {}) {
  if (!el.modal) return;
  modalOpenedAt = Date.now();
  modalCloseOnMask = closeOnMask;
  modalOpenPoint =
    modalLastClick && modalOpenedAt - modalLastClick.at < 500 ? modalLastClick : null;
  // 弹窗字体跟当前区域走（2026-11-13 字体设置）：设置页开的弹窗跟随设置区，
  // 对话里开的跟随聊天区，任务 / 搜索 / 群组跟随其他界面。
  el.modal.dataset.scope = currentRoute();
  const wasOpen = modalOpen();
  clearTimeout(modalTimer);
  modalOnClose = onClose;
  if (!wasOpen) {
    const active = document.activeElement;
    // 从项目弹层里点开的：焦点回触发它的轨道按钮，别回一个马上要被 hidden 的菜单项
    modalReturnFocus =
      active instanceof HTMLElement && !active.closest("#proj-menu")
        ? active
        : projectAnchor;
  }
  el.modal.hidden = false;
  el.modal.classList.remove("is-closing", "is-open");
  // 宽度档位跟着本次内容走（2026-11-07）：编辑人设要长文，420px 一行只放得下 30 来个字。
  // 每次打开都重置，避免上一次的宽档泄漏到下一次的确认框（2026-11-12：提醒弹窗也是宽档）。
  const panel = el.modal.querySelector(".modal-panel");
  if (panel) {
    panel.classList.remove("modal-wide", "modal-reminder", "modal-font");
    if (className) panel.classList.add(className);
  }
  el.modalTitle.textContent = title;
  el.modalBody.replaceChildren();
  if (typeof build === "function") build(el.modalBody);
  // 强制一帧，连续打开/关闭时 100ms 动画才会重放
  void el.modal.offsetWidth;
  el.modal.classList.add("is-open");
  const first = el.modalBody.querySelector("input, textarea, select, button");
  if (first instanceof HTMLElement) {
    first.focus();
    if (first instanceof HTMLInputElement) first.select();
  }
}

function closeModal() {
  if (!modalOpen() || el.modal.classList.contains("is-closing")) return;
  clearTimeout(modalTimer);
  el.modal.classList.remove("is-open");
  el.modal.classList.add("is-closing");
  const finish = () => {
    el.modal.hidden = true;
    el.modal.classList.remove("is-closing");
    el.modalBody.replaceChildren();
    const target = modalReturnFocus;
    modalReturnFocus = null;
    if (target && target.isConnected) target.focus();
    const after = modalOnClose;
    modalOnClose = null;
    if (after) after();
  };
  if (noMotion.matches) {
    finish();
    return;
  }
  modalTimer = setTimeout(finish, MODAL_MS);
}

el.modalMask?.addEventListener("click", (event) => {
  if (!modalCloseOnMask) return;
  const now = Date.now();
  // 双击触发钮：第一下开弹层，第二下落在刚铺开的遮罩上；同一落点连点不关。
  if (now - modalOpenedAt < MODAL_GUARD_MS) return;
  if (
    modalOpenPoint &&
    now - modalOpenPoint.at < MODAL_SAME_POINT_MS &&
    Math.hypot(
      event.clientX - modalOpenPoint.x,
      event.clientY - modalOpenPoint.y,
    ) <= MODAL_SAME_POINT_PX
  ) {
    return;
  }
  closeModal();
});
el.modalClose?.addEventListener("click", () => {
  // 双击触发钮时，第二下也可能落到弹层右上角的 ✕；刚开时同样不接。
  if (Date.now() - modalOpenedAt < MODAL_GUARD_MS) return;
  closeModal();
});

/**
 * 统一确认框（2026-11-13）：替换 window.confirm 的原生小窗。
 * 返回 Promise<boolean>：点确认 = true；取消 / 遮罩 / ✕ / Esc = false。
 * 危险动作（删除、停服）传 danger: true，图标与确认钮走 destructive 色。
 *
 * `input`（2026-11-14）：要顺手填一句的场景（比如"认领这台设备，给它起个名"）。
 * 传 `{ value, placeholder, label, maxLength }` 时确认钮返回**输入框里的字符串**
 * （取消仍是 false）——调用方用 `if (!结果) return` 就能同时兜住两种情况。
 */
function openConfirm({
  title,
  message,
  detail = "",
  confirmText = "确定",
  cancelText = "取消",
  danger = false,
  input = null,
}) {
  if (!el.modal) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal(
      title,
      (body) => {
        body.innerHTML = `
          <div class="modal-confirm">
            <div class="modal-confirm-icon ${danger ? "is-danger" : "is-accent"}" aria-hidden="true">${danger ? "!" : "?"}</div>
            <div class="modal-confirm-copy">
              <p class="modal-desc">${esc(message)}</p>
              ${detail ? `<p class="modal-hint">${esc(detail)}</p>` : ""}
            </div>
          </div>
          ${
            input
              ? `<div class="modal-field">
            <span>${esc(input.label || "名字")}</span>
            <input class="modal-input" data-modal-input type="text" maxlength="${Number(input.maxLength) || 40}"
                   value="${attr(input.value || "")}" placeholder="${attr(input.placeholder || "")}" spellcheck="false" />
          </div>`
              : ""
          }
          <div class="modal-actions">
            <button class="ghost" type="button" data-modal-cancel>${esc(cancelText)}</button>
            <button class="${danger ? "modal-danger" : "modal-primary"}" type="button" data-modal-confirm>${esc(confirmText)}</button>
          </div>`;
        const field = body.querySelector("[data-modal-input]");
        const submit = () => {
          done(input ? (field?.value || "").trim() : true);
          closeModal();
        };
        field?.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        });
        body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => {
          done(false);
          closeModal();
        });
        body.querySelector("[data-modal-confirm]")?.addEventListener("click", submit);
      },
      { onClose: () => done(false) },
    );
  });
}

/** 统一提示框：替换 alert，只有一颗「知道了」。 */
function showAlert(title, message) {
  openModal(title, (body) => {
    body.innerHTML = `
      <div class="modal-confirm">
        <div class="modal-confirm-icon is-accent" aria-hidden="true">i</div>
        <p class="modal-desc">${esc(message)}</p>
      </div>
      <div class="modal-actions">
        <button class="modal-primary" type="button" data-modal-ok>知道了</button>
      </div>`;
    body.querySelector("[data-modal-ok]")?.addEventListener("click", closeModal);
  });
}

/** 是否在 MyGo 桌面壳里：壳内才有原生目录选择器 */
function inShell() {
  try {
    return typeof window.isMyGo === "function" && Boolean(window.isMyGo());
  } catch {
    return false;
  }
}

/** Shell.SelectDirectory 的返回值兼容：字符串 / {path} / JSON 字符串都能吃下 */
function shellPathValue(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("\"") && text.endsWith("\""))) {
      try {
        return shellPathValue(JSON.parse(text));
      } catch {
        return text;
      }
    }
    return text;
  }
  if (Array.isArray(value)) return shellPathValue(value[0]);
  if (value && typeof value === "object") {
    for (const key of ["path", "directory", "result", "value"]) {
      if (typeof value[key] === "string") return shellPathValue(value[key]);
    }
  }
  return "";
}

/**
 * 打开系统目录选择器。壳内返回选中的绝对路径；取消或壳没接上返回空串。
 * 浏览器里没有这个能力，由 modal 退化为手输绝对路径（UI 只少一颗按钮）。
 */
async function selectDirectory() {
  if (!inShell()) return "";
  const call = window.mygo?.call;
  if (typeof call !== "function") return "";
  try {
    return shellPathValue(await call.call(window.mygo, "Shell.SelectDirectory"));
  } catch {
    return "";
  }
}

export { MODAL_MS, POP_MS, closeModal, closePopover, inShell, modalOnClose, modalOpen, modalReturnFocus, modalTimer, noMotion, openConfirm, openModal, openPopover, popTimers, popoverOpen, selectDirectory, shellPathValue, showAlert, toast, toastTimer };
