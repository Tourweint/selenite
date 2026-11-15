/**
 * 侧栏折叠 / 首页态 / 思考强度 / 收起轨道
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { startNewChat } from "./chat-open.js";
import { el } from "./dom.js";
import { hideHoverTip } from "./hover-tip.js";
import { request } from "./net.js";
import { openChiefChat } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { closeProjectMenu } from "./project-modal.js";
import { closeRailCards } from "./rail-card.js";
import { go } from "./route.js";
import { closeSecMenu, openSecMenu } from "./sec-menu.js";
import { state } from "./state.js";

/* ── 侧栏折叠 / 首页态 / 思考强度 ─────────────────────── */

function sidebarOpen() {
  return document.documentElement.dataset.sidebar !== "closed";
}

function toggleSidebar() {
  closeProjectMenu();
  closeRailCards();
  // 分区 ⋯ 菜单挂在 body 上，收侧栏时它不会跟着走，得显式收掉（2026-11-14）
  closeSecMenu();
  hideHoverTip();
  const next = sidebarOpen() ? "closed" : "open";
  if (next === "closed") document.documentElement.dataset.sidebar = "closed";
  else delete document.documentElement.dataset.sidebar;
  localStorage.setItem("lifediary.sidebar", next);
  el.toggleSidebar.setAttribute("aria-expanded", String(next === "open"));
  applySidebarA11y();
}

/* 隐藏的那一层不能是 Tab 焦点（2026-11-06 C 批）：
   展开时轨道藏着、收起时 inner 藏着。
   2026-11-15 窄屏改覆盖层：≤800px 不再「强制只显示 48px 轨道、与 data-sidebar 无关」
   ——那是旧口径，代价是窄屏点展开静默无效（用户报「特别窄展不开」）。现在
   窄屏收起 = 48px 轨道、展开 = 覆盖面板（样式在 style-11 窄屏块），开合语义
   与宽屏一致，inert 也归一成按 data-sidebar 算。
   遮罩只在「窄屏 + 展开」出现：宽屏侧栏常驻，点外不收（旧口径保留）。
   inert 同时挡住鼠标与键盘，比只设 tabindex=-1 少一整套维护。 */
const NARROW_SIDEBAR = matchMedia("(max-width: 800px)");

function setInert(node, inert) {
  if (!node) return;
  if (inert) node.setAttribute("inert", "");
  else node.removeAttribute("inert");
}

function applySidebarA11y() {
  const open = sidebarOpen();
  setInert(el.sideRail, open);
  setInert(el.sidebarInner, !open);
  if (el.sidebarScrim) el.sidebarScrim.hidden = !(NARROW_SIDEBAR.matches && open);
}

NARROW_SIDEBAR.addEventListener("change", applySidebarA11y);
/* IAB/模拟视口改尺寸不派 matchMedia change（2026-11-15 实测：matches 会更新、
   CSS 媒体查询也跟着走，事件就是不来），补一个 resize 兜底——applySidebarA11y
   是幂等同步，多调不伤。 */
window.addEventListener("resize", applySidebarA11y);

// 窄屏展开态点遮罩 = 收侧栏（宽屏遮罩永远 hidden，走不到这里）
el.sidebarScrim?.addEventListener("click", () => {
  if (sidebarOpen()) toggleSidebar();
});

/* 侧栏悬停浮出（peek）2026-11-08 做过、当天退役（用户拍板"感觉很难受"）：
 * 鼠标扫过左上角就弹一大块面板压内容，且"悬停预览/点击固定"两套逻辑叠着，
 * 点展开按钮反而显得没用。回到「点按钮展开/收起」的单一形态，代码不保留。 */

/* 顶部功能菜单：设置走独立路由（#/settings），不是弹层 */
function setMenuOpen(open) {
  el.menuPop.hidden = !open;
  el.menuBtn.setAttribute("aria-expanded", String(open));
}

function closeMenu() {
  setMenuOpen(false);
}

/** 没有消息时输入框抬到中间（首页态），一开口就落回底部 */

/** 首页居中靠实测卡高：CSS 只负责 `50vh - var(--composer-home-offset)`，
 *  高度变了（textarea 换行 / 工具行折行）由 ResizeObserver 重算。
 *  减 12px = 视觉中心略偏上；JS 失效时 CSS 回退常量 64px。 */
function measureHomeOffset() {
  const height = el.composer.getBoundingClientRect().height;
  if (!height) return;
  el.viewChat.style.setProperty("--composer-home-offset", `${height / 2 - 12}px`);
}

/* 输入卡高度统一实测（2026-11-11，学 ZCode 输入栏长高）：卡高写进 --composer-h，
   消息区让位（.thread padding）与底缝遮衬都吃这个变量——长高、错误卡、附件行一处不漏。
   观察器常驻：对话态的卡也会长，不再只在首页挂着；首页态顺带重算居中偏移。 */
if (typeof ResizeObserver === "function" && el.composer) {
  new ResizeObserver(() => {
    const height = el.composer.getBoundingClientRect().height;
    if (!height) return;
    el.viewChat.style.setProperty("--composer-h", `${Math.round(height)}px`);
    if (el.viewChat.dataset.home === "1") measureHomeOffset();
  }).observe(el.composer);
}

function updateHomeMode() {
  const home = !el.thread.querySelector(".msg");
  el.viewChat.dataset.home = home ? "1" : "0";
  if (home) {
    measureHomeOffset();
    syncGreeting();
  }
}

/*
 * 首页问候语按时间段换（2026-11-07 用户提议）：同一句话见多了就变成了墙纸，
 * 早晚各一句能把「现在是什么时候」这层意思带进来，也顺带提醒这是个会等你的东西。
 *
 * 分四段，边界取大多数人的作息而不是整点（凌晨归到夜里，不是「早上」）：
 *   05–10 早 / 10–18 白天 / 18–23 晚 / 23–05 夜。
 * 每段两句，轮换而不是随机：随机会在刷新时跳到另一句，看起来像出错；
 * 按「当天第几段」取模，同一天同一段里刷新、重开都是同一句，跨段才换。
 *
 * 文案口径与原来那句一致：短、第一人称、不催不迎，也不提模型和功能。
 */
const GREETING_SLOTS = [
  { from: 5, key: "morning", lines: ["早，今天想从哪儿开始？", "醒得早，想法大概也清楚。"] },
  { from: 10, key: "day", lines: ["说吧，我在。", "手上的事，说来听听。"] },
  { from: 18, key: "evening", lines: ["忙完了？慢慢说。", "天黑了，正好收个尾。"] },
  { from: 23, key: "night", lines: ["这么晚还没睡。", "夜里的想法，往往更要紧。"] },
];

function greetingSlot(date = new Date()) {
  const hour = date.getHours();
  // 从后往前找：SORT 是升序的，hour 落在哪一段的起点之后就取哪一段
  let slot = GREETING_SLOTS[GREETING_SLOTS.length - 1];
  for (const candidate of GREETING_SLOTS) {
    if (hour >= candidate.from) slot = candidate;
  }
  return slot;
}

/** 同一天同一段固定一句：用本地日期序号 + 段序号做种子，跨段/跨天才换 */
function greetingLine(date = new Date()) {
  const slot = greetingSlot(date);
  const dayIndex = Math.floor(
    (date.getTime() - date.getTimezoneOffset() * 60_000) / 86_400_000,
  );
  const slotIndex = GREETING_SLOTS.indexOf(slot);
  return slot.lines[(dayIndex + slotIndex) % slot.lines.length];
}

/** 把当前该显示的那句写进 #empty-greet；不换 DOM 结构，只改文本 */
function syncGreeting(date = new Date()) {
  if (!el.emptyGreet) return;
  const line = greetingLine(date);
  if (el.emptyGreet.textContent !== line) el.emptyGreet.textContent = line;
}

const KEY_THINKING = "lifediary.thinking";
// 模型菜单记住「上次看的供应商」（只定位视图，不等于切模型；D2）
const KEY_MODEL_PROVIDER = "lifediary.modelProvider";
// 旧键迁移（2026-11-04 界面 v2）：fast→off、deep→high；迁完就删旧键
const LEGACY_KEY_MODE = "lifediary.mode";
const THINKING_LEVELS = ["off", "low", "medium", "high"];
const THINKING_LABELS = { off: "关", low: "低", medium: "中", high: "高" };

(function migrateLegacyMode() {
  const legacy = localStorage.getItem(LEGACY_KEY_MODE);
  if (!legacy) return;
  if (!localStorage.getItem(KEY_THINKING)) {
    localStorage.setItem(KEY_THINKING, legacy === "deep" ? "high" : "off");
  }
  localStorage.removeItem(LEGACY_KEY_MODE);
})();

function currentThinking() {
  const value = localStorage.getItem(KEY_THINKING);
  return THINKING_LEVELS.includes(value) ? value : "off";
}

/** 菜单打开时把当前档标在底部常驻条上（2026-11-14：档位从模型行挪到菜单底栏，
 *  浏览别家供应商时也一直看得见；设置页 no-thinking 的弹层没有这条） */
function syncThinkingSegments() {
  if (!el.modelMenu) return;
  const level = currentThinking();
  for (const option of el.modelMenu.querySelectorAll(".think-foot .think-opt")) {
    option.setAttribute("aria-pressed", String(option.dataset.level === level));
  }
}

function clampThinking(level, levels) {
  if (!Array.isArray(levels) || !levels.length) return "off";
  if (levels.includes(level)) return level;
  // 换模型时服务端口径：落回支持域内 ≤ 当前档的最高档，off 兜底
  const index = THINKING_LEVELS.indexOf(level);
  for (let i = index; i >= 0; i -= 1) {
    if (levels.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  return "off";
}

async function setThinkingLevel(level) {
  if (!THINKING_LEVELS.includes(level)) return;
  localStorage.setItem(KEY_THINKING, level);
  syncThinkingSegments();
  // 还没有会话就不用下发，第一轮 `start` 回来时补（同原 setMode 的语义）
  if (!state.conversationId) return;
  await request(`/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/mode`, {
    method: "POST",
    body: JSON.stringify({ thinking: level }),
  }).catch(() => undefined);
}

/* ── 侧栏按「人」重排（E4）：总管区 / 执事花名册 ───────────
 * 纯前端：数据只从既有端点 GET（partners / domains / chat messages），
 * 不新增、不改后端契约。执事 canonical 会话对外 id = partner-<partnerId>
 * （partner-runtime.ts 的 partnerCanonicalExternalId）。 */

const KEY_RECENTS = "lifediary.chief.recents"; // 旧键：只读迁移，不再写

/* 侧栏分区折叠（2026-11-07 统一批）：会话 / 任务中心 / 项目 / 执事 / 群组共用一套。
   键 `lifediary.side.<sec>`，值 open|closed，默认展开。
   旧的 lifediary.chief.recents 只作为「会话」分区的初始值读一次，之后各存各的。 */
const SIDE_SECTIONS = ["partners", "chats", "projects", "groups", "topics"];

function sectionClosed(sec) {
  const stored = localStorage.getItem(`lifediary.side.${sec}`);
  if (stored === "closed") return true;
  if (stored === "open") return false;
  // 没存过：会话区接旧键，其余默认展开
  return sec === "chats" && localStorage.getItem(KEY_RECENTS) === "closed";
}

function applySections() {
  for (const sec of SIDE_SECTIONS) {
    const node = document.getElementById(`sec-${sec}`);
    if (!node) continue;
    const closed = sectionClosed(sec);
    node.classList.toggle("is-collapsed", closed);
    node.querySelector(".side-sec-head")?.setAttribute("aria-expanded", String(!closed));
  }
}

function toggleSection(sec) {
  if (!SIDE_SECTIONS.includes(sec)) return;
  localStorage.setItem(`lifediary.side.${sec}`, sectionClosed(sec) ? "open" : "closed");
  applySections();
}

/* 分区头的折叠（2026-11-07 四改，用户口径「箭头别要了，点击这个框相当于收起或展开」）：
   整行分区头就是那个把手，行尾只留一颗 ⋯（2026-11-14 由 ＋ 改）。 */
for (const sec of SIDE_SECTIONS) {
  document.getElementById(`sec-${sec}-toggle`)?.addEventListener("click", () => toggleSection(sec));
}

/* 「对话」分区的 ⋯（2026-11-14）：原来这里固定一颗 ＋（新建），旁边还有一颗放大镜（搜索）。
   现在两颗合成一张菜单——新建与搜索都是"对对话列表做的事"，没有理由各占一格。
   新建语义与旧按钮完全一致：新开一条普通 worker 会话（Ctrl+K 走同一条路）。 */
el.secChatsMore?.addEventListener("click", () => {
  openSecMenu(el.secChatsMore, [
    {
      label: "新建对话",
      kbd: "Ctrl+K",
      run: () => {
        go("chat");
        startNewChat("worker");
      },
    },
    { label: "搜索旧对话", run: () => go("search") },
  ]);
});

/* ── 收起轨道（2026-11-05 F1 / E4 重排 / 2026-11-07 统一批）──────────
   收起不再是整栏消失：72px 图标轨上「总管 / 任务中心 / 项目 / 设置」是真功能；
   执事占位与群组占位都保留（群组仍 disabled），执事不在轨道展开，悬停提示去展开侧栏。
   领域负责人占位移除：领域概览并入执事花名册，#/domains 独立页与路由原样保留。

   2026-11-07：顶部「新建对话」按钮退役（新建入口在展开态「最近会话」分区头的 ＋），
   轨道顶部那颗 ＋ 一并撤掉——两处都走 `.side-item`/`.rail-btn` 的同一套入口。
   **教训留在代码里**：一处 `null.addEventListener` 就会把后面所有监听注册打断
   （项目弹层、模型 pill、设置页都挂在这段之后），表现成"侧栏按钮全都没用"。
   所以轨道上的入口一律用可选链：HTML 删元素，JS 不该跟着炸。 */
el.railSettings?.addEventListener("click", () => go("settings"));
// 总管首字圆钮 → 打开总管会话（与展开态总管条目同一个函数，行为完全一致）。
// 2026-11-13：悬停浮一张总管卡（头像/状态/打开对话），点击仍是直接开对话——
// 先把卡收掉，免得已在对话路由时 hash 没变、applyRoute 不跑而留一张卡在屏上。
el.railChief?.addEventListener("click", () => {
  closeRailCards();
  openChiefChat();
});
// 执事轨道钮的点击改挂悬停卡开关（见轨道悬停浮卡段，2026-11-13）——
// 原「点一下展开侧栏看花名册」退役。

for (const hint of document.querySelectorAll("[data-hint]")) {
  hint.addEventListener("click", () => {
    el.input.value = hint.dataset.hint;
    resize();
    el.send.disabled = false;
    el.input.focus();
  });
}

export { GREETING_SLOTS, KEY_MODEL_PROVIDER, KEY_RECENTS, KEY_THINKING, LEGACY_KEY_MODE, NARROW_SIDEBAR, SIDE_SECTIONS, THINKING_LABELS, THINKING_LEVELS, applySections, applySidebarA11y, clampThinking, closeMenu, currentThinking, greetingLine, greetingSlot, measureHomeOffset, sectionClosed, setInert, setMenuOpen, setThinkingLevel, sidebarOpen, syncGreeting, syncThinkingSegments, toggleSection, toggleSidebar, updateHomeMode };
