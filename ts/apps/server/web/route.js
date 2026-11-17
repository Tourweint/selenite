/**
 * 路由与选中态
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { openDomains } from "./domains.js";
import { stopGroupPulse } from "./groups-base.js";
import { openGroupsView } from "./groups-topics.js";
import { hideHoverTip } from "./hover-tip.js";
import { partnerIdOfConversation } from "./partner-sessions.js";
import { stopMemoryPolling } from "./memory-page.js";
import { closeProjectMenu } from "./project-modal.js";
import { closeRailCards } from "./rail-card.js";
import { AGENT_TABS, SETTINGS_ALIASES, SETTINGS_SECTIONS } from "./settings-base.js";
import { renderSettings } from "./settings-router.js";
import { closeMenu } from "./shell.js";
import { state } from "./state.js";
import { openTasks } from "./tasks-kanban.js";
import { openReview } from "./tasks-review.js";

/* ── 路由 ─────────────────────────────────────────────── */

function currentRoute() {
  const hash = location.hash.replace(/^#/, "");
  if (hash.startsWith("/settings")) return "settings";
  // 搜索独立成页（2026-11-12）：界面上唯一的搜索入口，见 SEARCH 段
  if (hash.startsWith("/search")) return "search";
  // 今日回顾（2026-11-13 批 1）：任务中心的日报视图，与 /tasks 分开一条路由
  if (hash.startsWith("/review")) return "review";
  if (hash.startsWith("/tasks")) return "tasks";
  if (hash.startsWith("/domains")) return "domains";
  // 会话画板（2026-11-17 画板批）：#/map/<会话 id>，只画这一条会话的回合与分支
  if (hash.startsWith("/map/")) return "map";
  // 群组两条路由（2026-11-06 群组方案批二）：#/groups 列表、#/group/<id> 会话视图
  if (hash === "/groups" || hash.startsWith("/group/")) return "group";
  return "chat";
}

/** #/map/<id> 里的会话 id；不在画板路由时返回空 */
function mapRouteId() {
  const hash = location.hash.replace(/^#/, "");
  const match = /^\/map\/([A-Za-z0-9._-]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]) : "";
}

/** #/group/<id> 里的群 id；不在群会话路由时返回空 */
function groupRouteId() {
  const hash = location.hash.replace(/^#/, "");
  const match = /^\/group\/([A-Za-z0-9-]+)/.exec(hash);
  return match ? match[1] : "";
}

/* ── 选中态：黄色只表示「你在这里」（2026-11-13 选中态批）────
 * 轨道圆圈与展开侧栏的行选中共用一份口径：
 *   普通会话 → 对话；执事专线 → 执事；群列表 / 群会话 → 群组；
 *   总管会话 → 都不亮（用户拍板：选了总管本身就看得出，不再给黄块）；
 *   任务 / 回顾 / 搜索 / 领域 / 设置没有对应轨道钮，不亮。
 * 之前只判 route === "chat"，而总管会话 / 执事专线也走 chat 路由，
 * 轨道「对话」就一直亮着——用户报的「无论咋着它一直是黄的」就是这里。 */
function currentRailSection() {
  const route = currentRoute();
  if (route === "group") return "groups";
  // 画板是"这条会话的另一个视图"：轨道高亮与对话页同一套口径
  if (route !== "chat" && route !== "map") return "";
  const convId = String(route === "map" ? mapRouteId() : state.conversationId || "");
  if (convId.startsWith("partner-")) return "partners";
  // 种类优先看会话列表里已知的那条（切会话瞬间 state.chatKind 还是上一条的）
  const known = state.chats.find((chat) => chat.conversationId === convId);
  const kind = (known && known.chatKind) || (route === "chat" ? state.chatKind : "") || "";
  if (kind === "chief") return "";
  if (kind === "worker") return "chats";
  // 种类未知（历史还没回读）先不亮，避免总管会话闪一下「对话」
  return "";
}

function syncRailCurrent() {
  const section = currentRailSection();
  el.railChats?.setAttribute("aria-current", String(section === "chats"));
  el.railPartners?.setAttribute("aria-current", String(section === "partners"));
  el.railGroups?.setAttribute("aria-current", String(section === "groups"));
}

/** 正开着的执事专线：canonical / side 都返回真正 partnerId；群成员会话返回 ""（保持现状）。 */
function currentPartnerLineId() {
  const route = currentRoute();
  if (route !== "chat" && route !== "map") return "";
  return partnerIdOfConversation(route === "map" ? mapRouteId() : state.conversationId);
}

/** 展开侧栏的行选中：执事那一行 / 群那一行；会话行由 renderChats 自己管。 */
function syncSideRowsCurrent() {
  const partnerId = currentPartnerLineId();
  for (const row of el.partnerRoster?.querySelectorAll(".roster-row[data-partner-id]") || []) {
    if (partnerId && row.dataset.partnerId === partnerId) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
  const groupId = currentRoute() === "group" ? groupRouteId() : "";
  for (const row of el.groupList?.querySelectorAll(".group-row[data-group-id]") || []) {
    if (groupId && row.dataset.groupId === groupId) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
}

/** 任务页的查询参数（ticket / domain / project / sort），路由与筛选共用一份 */
function tasksParams() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash.startsWith("/tasks")) return new URLSearchParams();
  return new URLSearchParams(hash.split("?")[1] || "");
}

/** 任务详情：#/tasks?ticket=<id>；没有就是看板本身 */
function currentTicketId() {
  return tasksParams().get("ticket") || "";
}

/**
 * 任务中心地址：筛选与排序写进 hash，刷新后还能记住。
 * 详情只多一个 ticket；看板时不带，避免把详情状态留在地址里。
 */
function tasksHash({ ticket = "" } = {}) {
  const query = new URLSearchParams();
  if (ticket) query.set("ticket", ticket);
  if (state.domainFilter) query.set("domain", state.domainFilter);
  if (state.projectFilter) query.set("project", state.projectFilter);
  if (state.sort && state.sort !== "recent") query.set("sort", state.sort);
  const text = query.toString();
  return text ? `#/tasks?${text}` : "#/tasks";
}

/** 改筛选时用 replaceState：不往浏览器历史里塞一串筛选记录，也不触发 applyRoute */
function writeTasksHash(ticket = currentTicketId()) {
  const next = tasksHash({ ticket });
  if (location.hash === next) return;
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

/** 设置子路由的第一段：#/settings/partners/chief → "partners"；空/未知就是空串。 */
function settingsRoutePart() {
  return location.hash.replace(/^#\/settings\/?/, "").split(/[?#]/)[0].split("/")[0];
}

/** Agent 合并分区（2026-11-17）：四个旧子路由 → 四个 tab。
    注意只在**调用时**读 AGENT_TABS：route.js 与 settings-base.js 是循环引用，
    模块顶层去 map 它会在另一条 import 顺序上撞 TDZ（见文件头）。 */
function agentTabOfRoute(part) {
  return AGENT_TABS.find((tab) => tab.route === part)?.id || "";
}

/**
 * 当前落在 Agent 分区的哪个 tab：人设 / 上下文 / 工具 / 派活。
 * 认四个旧子路由（tab 切换直接复用它们，老书签不用改）；其余情况落第一个 tab（人设）。
 */
function currentAgentTab() {
  return agentTabOfRoute(settingsRoutePart()) || AGENT_TABS[0].id;
}

/** 设置子页：#/settings/外观 → "appearance"；缺省落「外观」（同 cindy 的 ?tab=） */
function currentSettingsPage() {
  // 二级页也走同一条前缀：#/settings/partners/<id> 仍然算「人设」这个分区，
  // 具体是谁由 currentPartnerProfileId 再从地址里取（2026-11-14 C 版）。
  const part = settingsRoutePart();
  // 旧分区 id 走别名账（2026-11-18 合并后：archive→chats、service/about→connect；
  // sessions、avatars 是更早的两层旧书签）。落对原来的去处，别掉回「外观」。
  const alias = SETTINGS_ALIASES[part];
  if (alias) return alias;
  if (agentTabOfRoute(part)) return "agent";
  return SETTINGS_SECTIONS.some((section) => section.id === part) ? part : "appearance";
}

/**
 * #/settings/partners/<id> 里的执事 id；在列表页或别处时返回空串。
 * 人设二级页（2026-11-14）用它判断「这是详情还是列表」，别处一律空。
 */
function currentPartnerProfileId() {
  const match = /^#\/settings\/partners\/([A-Za-z0-9-]+)/.exec(location.hash);
  return match ? match[1] : "";
}

/**
 * 真实路由切换（go / 浏览器前进后退 / 手改 hash）推进单调世代。
 * 离开再回到同一 hash 也会让旧 open 作废；go() 自己触发的 hashchange
 * 由 selfNavHash 认领，不重复推进（否则 openPartnerChat 自己的 go 会取消自己）。
 */
function noteRouteChange() {
  state.routeGen += 1;
  state.navToken += 1;
}

function go(route, page) {
  let next = "#/";
  if (route === "settings") next = page ? `#/settings/${page}` : "#/settings";
  else if (route === "search") next = "#/search";
  else if (route === "tasks") next = tasksHash();
  else if (route === "review") next = "#/review";
  else if (route === "domains") next = "#/domains";
  else if (route === "groups") next = "#/groups";
  if (location.hash === next) return;
  state.selfNavHash = next;
  noteRouteChange();
  location.hash = next;
}

/* 未保存守卫（2026-11-16）：页面可以注册一个同步判断。
   true = 这次路由切换放行；false = 先别换页，由注册方自己弹「保存 / 不保存 / 取消」。
   放行一次即卸任：页面若仍是自己会重新注册；用户取消时用 replaceState 把地址改回去，
   不触发 hashchange，所以草稿不会被重渲染冲掉。 */
let routeGuard = null;

function setRouteGuard(fn) {
  routeGuard = typeof fn === "function" ? fn : null;
}

function applyRoute() {
  if (routeGuard && !routeGuard()) return;
  routeGuard = null;
  closeMenu();
  closeProjectMenu();
  closeRailCards();
  hideHoverTip();
  const route = currentRoute();
  // 设置页是独立整页：侧栏不占位，侧栏开关只在设置页之外出现；
  // 任务中心保留侧栏（入口就在侧栏底部，也能顺手回对话）。
  document.documentElement.dataset.route = route;
  el.viewChat.hidden = route !== "chat" && route !== "map";
  el.viewSettings.hidden = route !== "settings";
  el.viewTasks.hidden = route !== "tasks";
  el.viewReview.hidden = route !== "review";
  el.viewDomains.hidden = route !== "domains";
  el.viewGroups.hidden = route !== "group";
  el.viewSearch.hidden = route !== "search";
  // 搜索页：进页就把光标放进输入框（从侧栏/设置点进来马上能打字）
  if (route === "search") el.searchInput?.focus();
  // 群会话的轮询只在该路由里跑：离开就停（2026-11-08 批三）
  if (route !== "group") stopGroupPulse();
  // 记忆页整理轮询只在该路由里跑：离开设置页就停（2026-11-13）
  if (route !== "settings") stopMemoryPolling();
  // 群组侧栏的选中态只在群组路由里成立：离开群组页后「所有群聊」不该还亮着
  // （2026-11-07 修：openGroupsView 只在进群组页时写 aria-current，回对话页就不再有
  // 人复位它，实测高亮会一直挂在那里）。
  el.secGroupsAll?.setAttribute(
    "aria-current",
    String(route === "group" && !groupRouteId()),
  );
  el.toggleSidebar.hidden = route === "settings";
  el.openSettings.setAttribute("aria-current", String(route === "settings"));
  // 轨道 / 展开侧栏的「你在这里」（2026-11-13 选中态批）：黄色只表示当前所在；
  // 总管会话刻意不亮任何轨道钮（用户拍板），群组页/群会话亮「群组」。
  syncRailCurrent();
  syncSideRowsCurrent();
  if (route === "settings") void renderSettings();
  else if (route === "tasks") openTasks();
  else if (route === "review") openReview();
  else if (route === "domains") openDomains();
  else if (route === "group") void openGroupsView();
  else if (route === "map") {
    // 画板自己管焦点与数据加载（chat-map.js 听 hashchange）；
    // 这里只保证不把光标塞进被盖住的输入框。
  } else el.input.focus();
  // 会话行的选中态跟着路由走（2026-11-07）：renderChats 里判了 currentRoute()，
  // 但进群组/任务/设置时不一定会重绘列表——离开对话页就在这里把高亮摘掉，
  // 回对话页再按当前会话补回来。不重排 DOM，只改属性。
  if (route !== "chat" && route !== "map") {
    for (const row of el.chats?.querySelectorAll('.chat[aria-current="true"]') || []) {
      row.removeAttribute("aria-current");
    }
  } else {
    const convId = route === "map" ? mapRouteId() : state.conversationId;
    // 画板可能深链到另一条会话：先把不属于当前地址的高亮摘掉，别让旧行留在选中态
    for (const row of el.chats?.querySelectorAll('.chat[aria-current="true"]') || []) {
      if (row.dataset.conv !== convId) row.removeAttribute("aria-current");
    }
    const current = el.chats?.querySelector(`.chat[data-conv="${CSS.escape(convId)}"]`);
    if (current && !current.hasAttribute("aria-current")) current.setAttribute("aria-current", "true");
  }
}

export { applyRoute, currentAgentTab, currentPartnerLineId, currentPartnerProfileId, currentRailSection, currentRoute, currentSettingsPage, currentTicketId, go, groupRouteId, mapRouteId, noteRouteChange, setRouteGuard, syncRailCurrent, syncSideRowsCurrent, tasksHash, tasksParams, writeTasksHash };
