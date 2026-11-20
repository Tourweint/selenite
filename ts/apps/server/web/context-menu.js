/**
 * 桌面壳里的右键菜单（2026-11-16）
 *
 * 用户口径：
 *   - 桌面端输入框的右键要自绘，只留「全选 / 复制 / 粘贴」；
 *   - Web 端不用管——原生右键照旧，不禁用也没事。
 *
 * 分工：
 *   - 这里只在壳里（window.isMyGo）接管原生菜单；普通浏览器一行都不拦。
 *   - 输入框（textarea / 文本类 input / contenteditable）走自绘菜单。剪贴板优先走
 *     壳的 Shell.ReadClipboard / Shell.WriteClipboard：WebView2 的
 *     navigator.clipboard.readText() 默认没有 ClipboardRead 权限，壳没处理
 *     PermissionRequested 会弹权限框；所以读取**不**退回 navigator，老壳直接提示按
 *     Ctrl+V。写入仍可退回 navigator（写剪贴板不需要授权框）。
 *   - 侧栏各行的菜单由各列表模块自己挂（对话 / 执事 / 项目 / 群组），
 *     它们用同一道 inShell() 闸：Web 端不拦原生右键。
 *   - 壳里非输入区、非行目标：原生菜单一律关掉；选中文字时给一条「复制」保底。
 *   - 设置页非输入区不弹自定义菜单（用户 2026-11-16 口径）；输入框仍走自绘菜单。
 *
 * 为什么不用 WebView2 自带的编辑菜单：用户明确要「自己画」；默认菜单还会带上
 * 刷新 / 打印 / 检查 / 另存为这些本地应用用不到的项。
 */

import { currentRoute } from "./route.js";
import { closeSecMenu, openMenuAt } from "./sec-menu.js";
import { inShell, toast } from "./ui-atoms.js";

/** 自绘菜单接管的范围：只认真正能选字 / 改字的控件。 */
const TEXT_FIELD_SELECTOR = [
  "textarea",
  "input:not([type])",
  "input[type='text']",
  "input[type='search']",
  "input[type='url']",
  "input[type='tel']",
  "input[type='password']",
  "[contenteditable='']",
  "[contenteditable='true']",
].join(", ");

/** 其他表单控件（select / checkbox / 日期输入等）保留原生菜单。 */
const OTHER_FORM_CONTROL =
  "input, textarea, select, [contenteditable=''], [contenteditable='true']";

function isTextInput(field) {
  return field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement;
}

function captureSelection(field) {
  if (isTextInput(field)) {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    return { start, end, text: field.value.slice(start, end) };
  }
  const selection = window.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  return { start: 0, end: 0, text: selection ? selection.toString() : "", range };
}

function selectAllIn(field) {
  field.focus();
  if (isTextInput(field)) {
    field.select();
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(field);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 写剪贴板：优先壳原生，老壳 / 浏览器退回 navigator；返回是否成功。 */
async function writeClipboardText(text) {
  const bridge = window.mygo;
  if (typeof bridge?.call === "function") {
    try {
      await bridge.call.call(bridge, "Shell.WriteClipboard", text);
      return true;
    } catch {
      /* 老壳没有这个方法：往下走 */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 读剪贴板：只走壳原生；读不到返回 null（空字符串表示剪贴板为空）。
 *
 * 刻意不退回 navigator.clipboard.readText()：WebView2 对异步读取要 ClipboardRead
 * 权限，壳没处理 PermissionRequested，第一次会弹权限框。宁可提示用户按 Ctrl+V，
 * 也不弹那个框（2026-11-16 用户反馈）。 */
async function readClipboardText() {
  const bridge = window.mygo;
  if (typeof bridge?.call !== "function") return null;
  try {
    const value = await bridge.call.call(bridge, "Shell.ReadClipboard");
    return typeof value === "string" ? value : "";
  } catch {
    return null;
  }
}

async function copyText(text) {
  if (!text) return;
  const ok = await writeClipboardText(text);
  toast(ok ? "已复制" : "复制失败，按 Ctrl+C 试试");
}

async function pasteInto(field, captured) {
  const text = await readClipboardText();
  if (text === null) {
    toast("右键粘贴暂时用不了，先按 Ctrl+V 贴上");
    return;
  }
  if (!text) {
    toast("剪贴板里没有文字；图片请按 Ctrl+V 粘贴");
    return;
  }
  field.focus();
  if (isTextInput(field)) {
    field.setRangeText(text, captured.start, captured.end, "end");
    // 让输入框自己的监听（长高、发送态）跑起来
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  // contenteditable：先把光标恢复到右键时的位置，再走 insertText
  const selection = window.getSelection();
  if (selection && captured.range) {
    selection.removeAllRanges();
    selection.addRange(captured.range);
  }
  const ok = document.execCommand("insertText", false, text);
  if (!ok && selection && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * 输入框右键菜单：只给三件事。
 * 「粘贴」在读只读 / 禁用的字段上置灰；「复制」在没有选中文字时置灰。
 */
function openInputMenu(field, x, y) {
  const captured = captureSelection(field);
  const canEdit = isTextInput(field) ? !field.disabled && !field.readOnly : field.isContentEditable;
  openMenuAt(
    x,
    y,
    [
      { label: "全选", kbd: "Ctrl+A", run: () => selectAllIn(field) },
      {
        label: "复制",
        kbd: "Ctrl+C",
        disabled: !captured.text,
        run: () => void copyText(captured.text),
      },
      {
        label: "粘贴",
        kbd: "Ctrl+V",
        disabled: !canEdit,
        run: () => void pasteInto(field, captured),
      },
    ],
    "输入框",
  );
}

document.addEventListener("contextmenu", (event) => {
  // 行自己的 contextmenu 已经处理过（preventDefault + 开菜单）：不要在这里再开一张
  if (event.defaultPrevented) return;

  // Web 端：原生右键照旧。用户 2026-11-16 口径，普通浏览器不再接管。
  if (!inShell()) return;

  const target = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
  if (!target) return;

  const field = target.closest(TEXT_FIELD_SELECTOR);
  if (field) {
    event.preventDefault();
    openInputMenu(field, event.clientX, event.clientY);
    return;
  }

  // select / checkbox / 日期输入等：保留原生菜单（自绘菜单帮不上忙）
  if (target.closest(OTHER_FORM_CONTROL)) return;

  event.preventDefault();

  // 菜单自己身上右键：收起即可，不要叠一张新菜单
  if (target.closest("#sec-menu")) {
    closeSecMenu();
    return;
  }
  closeSecMenu();

  // 设置页非输入区：用户口径是不用右键菜单，只把原生菜单关掉
  if (currentRoute() === "settings") return;

  // 通用保底：选中了文字就给一条「复制」——原生菜单关掉后，
  // 圈了一段字右键复制仍然要能用（消息脚注的复制按钮只覆盖回答）
  const selected = (window.getSelection()?.toString() || "").trim();
  if (!selected) return;
  openMenuAt(
    event.clientX,
    event.clientY,
    [{ label: "复制", kbd: "Ctrl+C", run: () => void copyText(selected) }],
    "选中的文字",
  );
});
