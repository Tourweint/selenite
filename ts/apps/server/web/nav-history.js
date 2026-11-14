/**
 * 站内「返回上一页 / 前进」（2026-11-14）
 *
 * 用户原话：「我们还需要在上面实现回到上一页的功能，或者回到上一页后点击下一页。」
 *
 * 为什么要有这一层：界面上每跨一页（对话 → 搜索 → 设置 → 人设页 → 任务中心 …）都靠
 * `location.hash`，而壳（MyGo 的 webview）里没有浏览器的后退按钮、也没有工具栏，
 * 一旦进了整页就没有「原路退回」这回事。页面自己那几枚写死的返回（搜索页回对话、
 * 任务单回看板、人设详情回列表）只回**它认为的上一级**，不是真的上一页：
 * 从抽屉里跳进人设页，那枚按钮回的是列表，不是刚才的对话。
 *
 * 做法：前端自己记一条访问栈，标题栏左侧给两枚钮（位置跟浏览器一致：品牌右边）。
 *
 * - **栈顶 = 现在这页**；每次真实 hash 变化压一条。`state.selfNavHash` / 世代那套
 *   仍归 net.js 管，这里只旁听同一批 hashchange，不插手路由本身。
 * - **返回 = 把栈顶挪进前进栈**；**前进 = 挪回来**。任何新导航清空前进栈
 *   （浏览器同款语义：退回去再点别的，前进就没了）——用户说的「回到上一页后点下一页」
 *   走的就是这两步。
 * - **同样地址不重复压栈**：对话页之间换会话不换 hash（`#/`），那不叫换页，不该多一条。
 * - 两枚都不可用时整组 hidden：首屏与改动前逐像素一致，不白占标题栏一个位。
 *
 * 刻意不做：不用 `history.back()`（webview 的历史里掺着 replaceState 与外部跳转，
 * 退到哪儿不可控；栈自己拿着才敢在按钮上承诺「上一页」）；不记滚动位置与表单草稿
 * （那是各页自己的事，不在这一层假装）。
 *
 * 回滚：URL 带 `?nav=off`，或 localStorage `lifediary.navBack = "off"`，两枚钮不渲染，
 * 其余行为与改动前完全一致。
 */

import { el } from "./dom.js";

const MAX_DEPTH = 40;
const KEY_NAV_OFF = "lifediary.navBack";

/** 走过的页（栈顶 = 当前页）；每一项就是一个 hash 串 */
const trail = [];
/** 返回出来之后还能前进回去的页（栈顶 = 最近一次返回走掉的那页） */
const ahead = [];
/** 我们自己写出去的 hash；下一次 hashchange 认领掉，不重复压栈 */
let pending = null;
let installed = false;

/** 这页叫什么：只为了悬停提示能说出「返回上一页 · 搜索」，读不到就说「上一页」 */
function pageLabel(hash) {
  if (!hash || hash === "#" || hash === "#/") return "对话";
  if (hash.startsWith("#/search")) return "搜索";
  if (hash.startsWith("#/tasks")) return "任务中心";
  if (hash.startsWith("#/review")) return "今日回顾";
  if (hash.startsWith("#/domains")) return "领域";
  if (hash === "#/groups") return "群组";
  if (hash.startsWith("#/group/")) return "群聊";
  // 人设二级页也算「设置」那一支，但它单独有名，别让人以为返回会掉回哪个分区
  if (/^#\/settings\/partners\/[A-Za-z0-9-]+/.test(hash)) return "人设页";
  if (hash.startsWith("#/settings")) return "设置";
  return "上一页";
}

function setTip(button, prefix, target, key) {
  if (!button) return;
  const label = pageLabel(target);
  button.setAttribute("data-tip", `${prefix} · ${label} (${key})`);
}

/** 不可用的那一枚不留旧提示：目标页早就不成立了（禁用态也不接悬停，但别留假账） */
function clearTip(button) {
  if (button) button.removeAttribute("data-tip");
}

/** 按钮的可点状态与显隐：都不可用就整组收起来 */
function syncNavButtons() {
  const nav = el.titlebarNav;
  if (!nav) return;
  const canBack = trail.length > 1;
  const canForward = ahead.length > 0;
  nav.hidden = !(canBack || canForward);
  if (el.navBack) el.navBack.disabled = !canBack;
  if (el.navForward) el.navForward.disabled = !canForward;
  if (canBack) setTip(el.navBack, "返回上一页", trail[trail.length - 2], "Alt+←");
  else clearTip(el.navBack);
  if (canForward) setTip(el.navForward, "前进", ahead[ahead.length - 1], "Alt+→");
  else clearTip(el.navForward);
}

/** 真实导航：压一条，前进栈清空（旧的「下一页」至此作废，与浏览器同语义） */
function pushEntry() {
  const hash = location.hash;
  if (trail[trail.length - 1] === hash) {
    syncNavButtons();
    return;
  }
  trail.push(hash);
  if (trail.length > MAX_DEPTH) trail.shift();
  ahead.length = 0;
  syncNavButtons();
}

/**
 * 走一趟：只改 hash，渲染仍由 net.js → applyRoute 负责。
 * pending 用 null 当哨兵（对话页的 hash 是空串，空串也是合法目标）。
 */
function travel(hash) {
  if (location.hash === hash) {
    syncNavButtons();
    return;
  }
  pending = hash;
  location.hash = hash;
  // hashchange 是异步的：先按新栈把按钮同步一次，不等事件
  syncNavButtons();
}

function goBack() {
  if (trail.length < 2) return;
  ahead.push(trail.pop());
  travel(trail[trail.length - 1]);
}

function goForward() {
  if (!ahead.length) return;
  const target = ahead.pop();
  trail.push(target);
  travel(target);
}

function onHashChange() {
  if (pending !== null && pending === location.hash) {
    pending = null;
    syncNavButtons();
    return;
  }
  pending = null;
  // 不是我们写的（点链接 / go() / 手改地址 / 浏览器后退）：都算一次新导航
  pushEntry();
}

function navOff() {
  try {
    if (new URLSearchParams(location.search).get("nav") === "off") return true;
    if (localStorage.getItem(KEY_NAV_OFF) === "off") return true;
  } catch {
    /* 隐私模式下 localStorage 可能抛，按开走 */
  }
  return false;
}

/** 入口：静态 DOM 已在，绑一次即可；开关关掉就把那两枚钮摘掉 */
function installNavHistory() {
  const nav = el.titlebarNav;
  if (!nav || installed) return;
  if (navOff()) {
    nav.remove();
    return;
  }
  installed = true;
  trail.length = 0;
  trail.push(location.hash);
  syncNavButtons();
  el.navBack?.addEventListener("click", goBack);
  el.navForward?.addEventListener("click", goForward);
  window.addEventListener("hashchange", onHashChange);
  // 键盘：Alt+← / Alt+→（Ctrl+Alt 留给输入法；带 ctrl/meta 一律不抢）
  window.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goBack();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      goForward();
    }
  });
}

export { goBack, goForward, installNavHistory, navOff, pageLabel };
