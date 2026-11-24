/**
 * 侧栏折叠 / 首页态 / 思考强度 / 收起轨道
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { hideHoverTip } from "./hover-tip.js";
import { request } from "./net.js";
import { openChiefChat } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { closeProjectMenu } from "./project-modal.js";
import { closeRailCards } from "./rail-card.js";
import { go } from "./route.js";
import { closeSecMenu, openSecMenu } from "./sec-menu.js";
import { animateSidebarIcons } from "./sidebar-morph.js";
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
  // 收起/展开时图标不换元素（2026-11-25，见 sidebar-morph.js）
  animateSidebarIcons(next === "open");
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

/**
 * 会话载入期锁住首页态（2026-11-19 用户报）：openChat 一进来就要 clearThread
 * （停旧审批计时器、清附件），线程一空就会被 updateHomeMode 判成首页态，输入框
 * 先抬到中间；历史异步回来又判回对话态，输入框再落回底部——从设置/任务/画板
 * 回到对话、点侧栏切会话都能看到那一下「先在中间、再被快速拉下来」的位移。
 * 载入期改为保持对话态贴底、关掉位移过渡（样式见 style-07-composer.css），
 * 历史画完由 endHomeSettle 结算一次。
 * 锁带 token（沿用 state.navToken）：并发 / 被顶掉的旧 openChat 收尾不会拆新请求的锁。
 */
let homeSettleToken = null;

function beginHomeSettle(token) {
  homeSettleToken = token;
  el.viewChat.dataset.homeLock = "1";
  el.viewChat.dataset.homeSettling = "1";
  // 贴底是对话态的形态；空会话等结算时再一步落到中间（不走动画）
  el.viewChat.dataset.home = "0";
}

function endHomeSettle(token) {
  if (homeSettleToken !== token) return;
  homeSettleToken = null;
  delete el.viewChat.dataset.homeLock;
  // 历史画完这一下也不走动画（空会话要一步落位）
  updateHomeMode({ animate: false });
  delete el.viewChat.dataset.homeSettling;
}

/** 放弃载入锁（新建会话时用）：不管手里是哪次 openChat 的锁，立即按当前线程结算。
 *  新建会话不该等一条已被顶掉的 openChat 收尾才把输入框抬回中间。 */
function cancelHomeSettle() {
  if (homeSettleToken === null && !el.viewChat.dataset.homeLock) return;
  homeSettleToken = null;
  delete el.viewChat.dataset.homeLock;
  delete el.viewChat.dataset.homeSettling;
  updateHomeMode();
}

/**
 * 判首页态并落位。`animate: false` = 这次落位不播位移过渡（载入历史 / 首屏结算用）；
 * 只有用户发第一句话这种「真·首页 → 对话」才该看到下滑。
 * 关过渡靠一次强制 reflow 钉住：同一任务里改两次属性，浏览器只做一次样式计算，
 * 不加 reflow 直接删属性会把这次位移重新变成动画。
 * 不用 rAF：后台 / 不可见窗口的帧回调会被节流甚至不跑，属性会一直挂着。
 */
function updateHomeMode({ animate = true } = {}) {
  // 会话历史还在路上：空 / 非空尚未确定，别先抬到中间再落回去（见 beginHomeSettle）
  if (el.viewChat.dataset.homeLock) return;
  const home = !el.thread.querySelector(".msg");
  const next = home ? "1" : "0";
  const changed = el.viewChat.dataset.home !== next;
  if (!animate && changed) el.viewChat.dataset.homeSettling = "1";
  el.viewChat.dataset.home = next;
  if (home) {
    measureHomeOffset();
    syncGreeting();
  }
  if (!animate && changed) {
    void el.composer.offsetHeight;
    delete el.viewChat.dataset.homeSettling;
  }
}

/*
 * 首页问候语按时间段换（2026-11-07 用户提议）：同一句话见多了就变成了墙纸，
 * 换着说能把「现在是什么时候」这层意思带进来，也顺带提醒这是个会等你的东西。
 *
 * 分四段，边界取大多数人的作息而不是整点（凌晨归到夜里，不是「早上」）：
 *   05–10 早 / 10–18 白天 / 18–23 晚 / 23–05 夜。
 *
 * 每段六句，句式混着来（问句 / 陈述 / 观察 / 邀请），别一段全是同一种问法；
 * 句尾标点是文案的一部分，照原样保留（「这么晚还没睡。」的句号不能删）。
 *
 * 选句（2026-11-18 丰富句池 + 由轮换改洗牌）：按段做种子把句序洗成一套固定
 * 乱序，日子顺着往前走、一轮用完从头再来——跨天像随机换句，但同一天同一段
 * 里刷新、重开都是同一句，不会随刷新跳变（2026-11-07 定下的底线，仍然守）；
 * 洗牌顺序保证一轮之内句句不重，所以也不会连着两天撞同一句。
 *
 * 文案口径与原来那句一致：短、第一人称、不催不迎，也不提模型和功能。
 */
const GREETING_SLOTS = [
  {
    from: 5,
    key: "morning",
    lines: [
      "早，今天想从哪儿开始？",
      "醒得早，想法大概也清楚。",
      "一天刚开始，节奏你来定。",
      "刚醒就开始想事了？",
      "先说今天最惦记的那件。",
      "趁着刚醒，把脑子里的事倒出来。",
    ],
  },
  {
    from: 10,
    key: "day",
    lines: [
      "说吧，我在。",
      "手上的事，说来听听。",
      "正事闲话都行，随你。",
      "事情办到哪儿了？",
      "在想什么？说出来一起理理。",
      "白天还长，不急着说重点。",
    ],
  },
  {
    from: 18,
    key: "evening",
    lines: [
      "忙完了？慢慢说。",
      "天黑了，正好收个尾。",
      "今天过得怎么样，挑几件讲讲。",
      "到了松口气的时候了。",
      "晚饭吃了没？",
      "今晚的时间归你。",
    ],
  },
  {
    from: 23,
    key: "night",
    lines: [
      "这么晚还没睡。",
      "夜里的想法，往往更要紧。",
      "还醒着？正好，我也在。",
      "睡前有什么想说的，说吧。",
      "夜里安静，适合把话摊开。",
      "想睡就睡，这些话不会跑。",
    ],
  },
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

/** FNV-1a 散列：同样两个数永远出同一个值——问候语当固定种子用，不用 Math.random */
function greetingHash(a, b) {
  let h = 2166136261;
  h = Math.imul(h ^ a, 16777619);
  h = Math.imul(h ^ b, 16777619);
  return h >>> 0;
}

/** 同一段固定一套洗好的句序（按段做种子）：看起来是乱序，其实一轮之内句句不重 */
function greetingOrder(slotIndex, length) {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = greetingHash(slotIndex, i) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** 同一天同一段固定一句：按天序号在洗好的句序里往前走，跨段/跨天才换 */
function greetingLine(date = new Date()) {
  const slot = greetingSlot(date);
  const dayIndex = Math.floor(
    (date.getTime() - date.getTimezoneOffset() * 60_000) / 86_400_000,
  );
  const slotIndex = GREETING_SLOTS.indexOf(slot);
  const order = greetingOrder(slotIndex, slot.lines.length);
  return slot.lines[order[dayIndex % slot.lines.length]];
}

/* 换句动画（2026-11-19 用户提议）：旧句淡出、新句淡入，不是一闪一换。
   时长跟 style-04-chat-base.css 里 .empty-greet 的 opacity 过渡是一对，改要一起改；
   reduced-motion 走 ui-atoms 同款姿势：CSS 关过渡，JS 直接切文本不绕弯。 */
const GREET_OUT_MS = 280;
const noMotion = matchMedia("(prefers-reduced-motion: reduce)");
let greetingSwapToken = 0;

function swapGreetingText(line) {
  const node = el.emptyGreet;
  if (noMotion.matches) {
    node.textContent = line;
    return;
  }
  const token = ++greetingSwapToken;
  node.classList.add("greet-out"); // 旧句淡出
  setTimeout(() => {
    if (token !== greetingSwapToken) return; // 又有新句接手了，文本归它写
    node.textContent = line;
    node.classList.remove("greet-out"); // 新句淡入
  }, GREET_OUT_MS);
}

/** 把当前该显示的那句写进 #empty-greet；不换 DOM 结构，变了才换文本、换文本就带淡出淡入 */
function syncGreeting(date = new Date()) {
  if (!el.emptyGreet) return;
  const line = greetingLine(date);
  if (el.emptyGreet.textContent !== line) swapGreetingText(line);
}

const KEY_THINKING = "lifediary.thinking";
// 拨盘是否被用户真碰过（2026-11-21）：没碰过时新会话不发顶层 thinking——
// 让服务端全局默认档（设置里设的那档）说话，别让缺省 off 冒充用户的选择。
const KEY_THINKING_TOUCHED = "lifediary.thinkingTouched";
// 模型菜单记住「上次看的供应商」（只定位视图，不等于切模型；D2）
const KEY_MODEL_PROVIDER = "lifediary.modelProvider";
// 旧键迁移（2026-11-04 界面 v2）：fast→off、deep→high；迁完就删旧键。
// 旧档是用户显式选过的：迁移时同样记"碰过"，别把老用户的档丢给全局默认。
const LEGACY_KEY_MODE = "lifediary.mode";
const THINKING_LEVELS = ["off", "low", "medium", "high"];
const THINKING_LABELS = { off: "关", low: "低", medium: "中", high: "高" };

(function migrateLegacyMode() {
  const legacy = localStorage.getItem(LEGACY_KEY_MODE);
  if (!legacy) return;
  if (!localStorage.getItem(KEY_THINKING)) {
    localStorage.setItem(KEY_THINKING, legacy === "deep" ? "high" : "off");
  }
  localStorage.setItem(KEY_THINKING_TOUCHED, "1");
  localStorage.removeItem(LEGACY_KEY_MODE);
})();

function currentThinking() {
  const value = localStorage.getItem(KEY_THINKING);
  return THINKING_LEVELS.includes(value) ? value : "off";
}

/** 拨盘被用户碰过没有（2026-11-21）：没碰过 = 缺省 off 不冒充选择，新会话走全局默认档 */
function thinkingTouched() {
  return localStorage.getItem(KEY_THINKING_TOUCHED) === "1";
}

/** 菜单打开时把当前档标在底部常驻条上（2026-11-14：档位从模型行挪到菜单底栏，
 *  浏览别家供应商时也一直看得见；设置页 no-thinking 的弹层没有这条）。
 *  2026-11-21 分段按钮换成填充滑块：同步改为给滑块发 think-sync（/mode 被 clamp
 *  改写实际档时，滑块跟回服务端说的那一档）。 */
function syncThinkingSegments() {
  if (!el.modelMenu) return;
  const level = currentThinking();
  for (const slider of el.modelMenu.querySelectorAll(".think-foot .think-slider")) {
    slider.dispatchEvent(new CustomEvent("think-sync", { detail: { level } }));
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
  localStorage.setItem(KEY_THINKING_TOUCHED, "1");
  syncThinkingSegments();
  // 还没有会话就不用下发，第一轮 `start` 回来时补（同原 setMode 的语义）
  if (!state.conversationId) return;
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/mode`,
      {
        method: "POST",
        body: JSON.stringify({ thinking: level }),
      },
    );
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    // 2026-11-19：档位按本会话模型支持域 clamp；服务端说实际用了哪档，pill 就显示哪档。
    if (typeof data?.thinking === "string" && data.thinking !== level) {
      localStorage.setItem(KEY_THINKING, data.thinking);
      syncThinkingSegments();
    }
  } catch {
    /* 静默：下一轮 ensureConversationModel 还会按会话模型再 clamp 一次 */
  }
}

/* ── 侧栏按「人」重排（E4）：总管区 / 执事花名册 ───────────
 * 纯前端：数据只从既有端点 GET（partners / domains / chat messages），
 * 不新增、不改后端契约。执事 canonical 会话对外 id = partner-<partnerId>
 * （partner-runtime.ts 的 partnerCanonicalExternalId）。 */

const KEY_RECENTS = "lifediary.chief.recents"; // 旧键：只读迁移，不再写

/* 侧栏分区折叠（2026-11-07 统一批）：会话 / 任务中心 / 项目 / 执事 / 群组共用一套。
   键 `lifediary.side.<sec>`，值 open|closed，默认展开。
   旧的 lifediary.chief.recents 只作为「会话」分区的初始值读一次，之后各存各的。 */
const SIDE_SECTIONS = ["partners", "chats", "projects", "groups"];

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

/* 「任务」分区（原「对话」，2026-11-21 改名）的 ⋯（2026-11-14）：原来这里固定一颗 ＋（新建），
   旁边还有一颗放大镜（搜索）。现在合成一张菜单——新建与搜索都是"对任务列表做的事"，
   没有理由各占一格。
   2026-11-21：「打开任务中心」从分区底部的文字链接收进这张菜单（底部链接退役）。
   2026-11-22：菜单不再写解释行（用户口径「解释性文字不需要」）。
   2026-11-23：普通助手（worker 会话）退役——「新建助手对话」撤掉，新建只剩「新建任务」（派给池）。 */
el.secChatsMore?.addEventListener("click", () => {
  openSecMenu(el.secChatsMore, [
    {
      label: "新建任务",
      kbd: "Ctrl+K",
      run: () => {
        // 动态 import：tasks-create 依赖弹窗 / 项目 / 会话打开，静态引会把侧栏拖进这张图。
        void import("./tasks-create.js").then((module) => module.openCreateTaskModal());
      },
    },
    { label: "搜索旧对话", run: () => go("search") },
    { label: "打开任务中心", run: () => go("tasks") },
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

export { GREETING_SLOTS, KEY_MODEL_PROVIDER, KEY_RECENTS, KEY_THINKING, LEGACY_KEY_MODE, NARROW_SIDEBAR, SIDE_SECTIONS, THINKING_LABELS, THINKING_LEVELS, applySections, applySidebarA11y, beginHomeSettle, cancelHomeSettle, clampThinking, closeMenu, currentThinking, endHomeSettle, greetingLine, greetingSlot, measureHomeOffset, sectionClosed, setInert, setMenuOpen, setThinkingLevel, sidebarOpen, syncGreeting, syncThinkingSegments, thinkingTouched, toggleSection, toggleSidebar, updateHomeMode };
