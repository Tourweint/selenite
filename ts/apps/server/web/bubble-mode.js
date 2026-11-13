/**
 * 回答气泡（2026-11-13）
 *
 * 设置 → 外观 → 回答：把助手的每一段话包成气泡，并给一个宽度滑杆。
 * 样式全在 style.css 里，按 [data-answer-bubble="1"] 生效；本模块只负责三件事：
 *   1. 启动时把 localStorage 的选择写到 <html>（index.html 里的内联脚本已先写过一遍，防首帧闪）；
 *   2. 在「外观」页挂一节「回答」（开关 + 宽度）；
 *   3. 改完即时生效并落 localStorage，只走前端，不进服务端开关、不动契约。
 *
 * 为什么单独成模块：2026-11-13 另一个会话正在改 web/app.js（附件走路径、导出升级），
 * 这段先不插进去。等那边收工，把 mountSection 里的一节搬进 renderSettings 的
 * appearance 分支、删掉本文件与 index.html 的那行 script 即可——行内结构
 * 用的就是 app.js 那套 .card / .row / .divider / .switch，搬过去不用改样式。
 *
 * 两条边界（2026-11-13 定）：
 * - 气泡只包 .body；工具灰块 .tchips-wrap 是 .flow 的兄弟节点，留在气泡外；
 * - 宽度只作用于助手这侧，用户气泡保持 480px（短句跟着变宽会成一面墙）。
 */

const KEY = "lifediary.answerBubble";
const MIN_WIDTH = 60;
const MAX_WIDTH = 92;
const DEFAULT_WIDTH = 80;

function clampWidth(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

function readState() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || typeof raw !== "object") return { on: false, width: DEFAULT_WIDTH };
    return { on: raw.on === true, width: clampWidth(raw.width) };
  } catch {
    return { on: false, width: DEFAULT_WIDTH };
  }
}

function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify({ on: state.on, width: clampWidth(state.width) }));
}

/** 把状态写到 <html>：样式表认属性，宽度认 CSS 变量。关掉时两个都撤，回到旧排版。 */
function applyState(state) {
  const root = document.documentElement;
  if (state.on) {
    root.dataset.answerBubble = "1";
    root.style.setProperty("--bubble-w", `${clampWidth(state.width)}%`);
  } else {
    delete root.dataset.answerBubble;
    root.style.removeProperty("--bubble-w");
  }
}

function sectionHtml(state) {
  return `<section class="set-sec" data-bubble-sec>
  <h2 class="set-sec-title">回答</h2>
  <div class="card">
    <div class="row">
      <div class="row-main">
        <div class="row-label" title="把助手的每段话包成气泡；工具调用留在气泡外，不跟着变">气泡</div>
      </div>
      <div class="row-control">
        <button class="switch" type="button" role="switch" aria-checked="${state.on}" aria-label="回答气泡" data-bubble-switch>
          <span class="switch-thumb" aria-hidden="true"></span>
        </button>
      </div>
    </div>
    <div class="divider"></div>
    <div class="row">
      <div class="row-main">
        <div class="row-label" title="相对对话内容宽度；只作用于助手这侧，用户气泡不跟着变">气泡宽度</div>
      </div>
      <div class="row-control bubble-range-wrap">
        <input class="bubble-range" type="range" min="${MIN_WIDTH}" max="${MAX_WIDTH}" step="1"
               value="${state.width}" aria-label="气泡宽度" data-bubble-range ${state.on ? "" : "disabled"} />
        <span class="bubble-range-val" data-bubble-val>${state.width}%</span>
      </div>
    </div>
  </div>
</section>`;
}

/** 挂一节进「外观」页。每次切页重渲染都会重挂，所以只认标记、不重复挂。 */
function mountSection() {
  const host = document.getElementById("settings-inner");
  if (!host) return;
  // 只有「外观」页有字体入口；别的页不挂
  if (!host.querySelector("#font-open")) return;
  if (host.querySelector("[data-bubble-sec]")) return;

  const state = readState();
  const holder = document.createElement("div");
  holder.innerHTML = sectionHtml(state);
  const section = holder.firstElementChild;
  host.append(section);

  const sw = section.querySelector("[data-bubble-switch]");
  const range = section.querySelector("[data-bubble-range]");
  const value = section.querySelector("[data-bubble-val]");

  sw?.addEventListener("click", () => {
    const next = !readState().on;
    sw.setAttribute("aria-checked", String(next));
    if (range) range.disabled = !next;
    const now = readState();
    now.on = next;
    applyState(now);
    saveState(now);
  });

  range?.addEventListener("input", () => {
    const now = readState();
    now.width = clampWidth(range.value);
    if (value) value.textContent = `${now.width}%`;
    applyState(now);
  });
  // 松手才写盘：拖动过程中不反复写 localStorage
  range?.addEventListener("change", () => {
    const now = readState();
    now.width = clampWidth(range.value);
    saveState(now);
  });
}

// 首帧之后同步一次；设置页每次重渲染由 observer 兜住。
// 只盯设置容器、且只盯 childList：换成 body + subtree 的话，聊天流式每个字都在改 DOM，
// 回调会被打成每帧一次（每帧都要 querySelector 两个标记），白烧 CPU。
mountSection();
const host = document.getElementById("settings-inner");
if (host) {
  const observer = new MutationObserver(() => mountSection());
  observer.observe(host, { childList: true });
}

applyState(readState());
