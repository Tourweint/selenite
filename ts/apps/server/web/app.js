/**
 * lifediary 的界面。刻意不引任何依赖：
 *
 * - 服务端就是同源，所以路径全是相对的，换端口/换主机都不用改；
 * - 没有构建步骤，改完刷新就见效——这一层不值得为它上一条打包链；
 * - 所有网络请求只从这里出去（见 request），别的地方不许自己 fetch。
 */

const KEY_TOKEN = "lifediary.token";
const KEY_CONV = "lifediary.conversationId";

const el = {
  chats: document.getElementById("chats"),
  // E4 侧栏：总管区 / 最近会话折叠 / 执事花名册
  chiefEntry: document.getElementById("chief-entry"),
  chiefAvatar: document.getElementById("chief-avatar"),
  chiefDot: document.getElementById("chief-dot"),
  chiefCount: document.getElementById("chief-count"),
  // 2026-11-07 侧栏统一批：四个分区共用一套折叠头（.side-sec），
  // 收起态各存一份 localStorage；旧 id（recents/new-chat/side-proj/proj-pill）已从
  // HTML 移除，这里一并换掉——留着 null 会在注册监听时炸断整个启动流程。
  // 分区头 = 整行按钮（点它就收起/展开，2026-11-07 四改去掉了箭头）＋ 行尾一个 ＋。
  secChatsToggle: document.getElementById("sec-chats-toggle"),
  secProjectsToggle: document.getElementById("sec-projects-toggle"),
  secPartnersToggle: document.getElementById("sec-partners-toggle"),
  secChatsAdd: document.getElementById("sec-chats-add"),
  secProjectsName: document.getElementById("sec-projects-name"),
  secProjectsAdd: document.getElementById("sec-projects-add"),
  secProjectsManage: document.getElementById("sec-projects-manage"),
  projList: document.getElementById("proj-list"),
  secTasksAll: document.getElementById("sec-tasks-all"),
  tasksMini: document.getElementById("tasks-mini"),
  secGroupsAdd: document.getElementById("sec-groups-add"),
  secGroupsAll: document.getElementById("sec-groups-all"),
  partnersBadge: document.getElementById("partners-badge"),
  partnerAddSide: document.getElementById("partner-add-side"),
  partnerRoster: document.getElementById("partner-roster"),
  settingsNav: document.getElementById("settings-nav"),
  projectMenu: document.getElementById("proj-menu"),
  title: document.getElementById("title"),
  thread: document.getElementById("thread"),
  empty: document.getElementById("empty"),
  emptyGreet: document.getElementById("empty-greet"),
  scroll: document.getElementById("scroll"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  railChief: document.getElementById("rail-chief"),
  railPartners: document.getElementById("rail-partners"),
  railSettings: document.getElementById("rail-settings"),
  railStatus: document.getElementById("rail-status"),
  railProj: document.getElementById("rail-proj"),
  sideRail: document.getElementById("side-rail"),
  sidebarInner: document.getElementById("sidebar-inner"),
  gate: document.getElementById("gate"),
  gateForm: document.getElementById("gate-form"),
  gateInput: document.getElementById("gate-input"),
  gateErr: document.getElementById("gate-err"),
  viewChat: document.getElementById("view-chat"),
  viewSettings: document.getElementById("view-settings"),
  viewTasks: document.getElementById("view-tasks"),
  viewDomains: document.getElementById("view-domains"),
  viewGroups: document.getElementById("view-groups"),
  groupsBack: document.getElementById("groups-back"),
  groupsState: document.getElementById("groups-state"),
  groupsBody: document.getElementById("groups-body"),
  groupsTitleText: document.getElementById("groups-title-text"),
  groupsTitleSub: document.getElementById("groups-title-sub"),
  groupCreate: document.getElementById("group-create"),
  groupSettingsBtn: document.getElementById("group-settings-btn"),
  groupSettingsDrawer: document.getElementById("group-settings-drawer"),
  groupSettingsOverlay: document.getElementById("group-settings-overlay"),
  groupChat: document.getElementById("group-chat"),
  groupHeadAvatar: document.getElementById("group-head-avatar"),
  groupMembers: document.getElementById("group-members"),
  groupNotice: document.getElementById("group-notice"),
  groupThread: document.getElementById("group-thread"),
  groupPulse: document.getElementById("group-pulse"),
  groupAtHint: document.getElementById("group-at-hint"),
  groupInput: document.getElementById("group-input"),
  groupSend: document.getElementById("group-send"),
  groupStop: document.getElementById("group-stop"),
  groupAtpop: document.getElementById("group-atpop"),
  groupAtBtn: document.getElementById("group-at-btn"),
  secGroupsToggle: document.getElementById("sec-groups-toggle"),
  railGroups: document.getElementById("rail-groups"),
  groupList: document.getElementById("group-list"),
  // 长期课题（2026-11-07 批二）：轨道入口 + 展开态分区
  railTopics: document.getElementById("rail-topics"),
  secTopicsToggle: document.getElementById("sec-topics-toggle"),
  topicList: document.getElementById("topic-list"),
  topicsBadge: document.getElementById("topics-badge"),
  railTasks: document.getElementById("rail-tasks"),
  domainsBack: document.getElementById("domains-back"),
  domainsRefresh: document.getElementById("domains-refresh"),
  domainsState: document.getElementById("domains-state"),
  domainsBody: document.getElementById("domains-body"),
  domainsTitleSub: document.getElementById("domains-title-sub"),
  tasksBadge: document.getElementById("tasks-badge"),
  tasksBack: document.getElementById("tasks-back"),
  tasksRefresh: document.getElementById("tasks-refresh"),
  tasksDomain: document.getElementById("tasks-domain"),
  tasksProject: document.getElementById("tasks-project"),
  tasksSort: document.getElementById("tasks-sort"),
  tasksFilters: document.getElementById("tasks-filters"),
  tasksScroll: document.getElementById("tasks-scroll"),
  tasksState: document.getElementById("tasks-state"),
  tasksBody: document.getElementById("tasks-body"),
  tasksStats: document.getElementById("tasks-stats"),
  // 外部打手区（L3）：四张固定小卡，数据全部由 tickets 列表按 employee 现算
  tasksHitters: document.getElementById("tasks-hitters"),
  tasksBoard: document.getElementById("tasks-board"),
  tasksArchive: document.getElementById("tasks-archive"),
  // 「更早的直派」折叠组（L3）：没有 conversationId 的旧单走这里，不占三列
  tasksDirect: document.getElementById("tasks-direct"),
  tasksDetail: document.getElementById("task-detail"),
  tasksTitleText: document.getElementById("tasks-title-text"),
  tasksTitleSub: document.getElementById("tasks-title-sub"),
  openSettings: document.getElementById("open-settings"),
  closeSettings: document.getElementById("close-settings"),
  settingsInner: document.getElementById("settings-inner"),
  settingsScroll: document.getElementById("settings-scroll"),
  toggleSidebar: document.getElementById("toggle-sidebar"),
  menuBtn: document.getElementById("menu-btn"),
  menuPop: document.getElementById("menu-pop"),
  composerAdd: document.getElementById("composer-add"),
  composerFile: document.getElementById("composer-file"),
  composerAttachments: document.getElementById("composer-attachments"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightbox-img"),
  modelPill: document.getElementById("model-pill"),
  modelPillLabel: document.getElementById("model-pill-label"),
  modelThink: document.getElementById("model-think"),
  modelMenu: document.getElementById("model-menu"),
  chatSettingsBtn: document.getElementById("chat-settings-btn"),
  chatSettingsDrawer: document.getElementById("chat-settings-drawer"),
  chatSettingsOverlay: document.getElementById("chat-settings-overlay"),
  toast: document.getElementById("toast"),
  railTip: document.getElementById("rail-tip"),
  modal: document.getElementById("modal"),
  modalMask: document.getElementById("modal-mask"),
  modalClose: document.getElementById("modal-close"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  ctxRing: document.getElementById("ctx-ring"),
  ctxFill: document.getElementById("ctx-fill"),
  ctxPct: document.getElementById("ctx-pct"),
  windowControls: document.getElementById("window-controls"),
  winMin: document.getElementById("win-min"),
  winMax: document.getElementById("win-max"),
  winClose: document.getElementById("win-close"),
};

/* ── 主题（2026-11-05：四套色板） ─────────────────────── */

const KEY_THEME = "lifediary.theme";
const KEY_ACCENT = "lifediary.accent";
const KEY_SEND = "lifediary.sendKey";
const KEY_ACTS = "lifediary.showActs";

/* id 与 html[data-theme] 一一对应；预览色写死，不跟当前 token 走 */
const THEMES = [
  { id: "paper", name: "米黄", bg: "#fdf9f2", card: "#f6f1e7", accent: "#3e4a8c" },
  { id: "white", name: "纯白", bg: "#ffffff", card: "#fafafa", accent: "#3e4a8c" },
  { id: "indigo", name: "靛蓝夜", bg: "#12141d", card: "#191c27", accent: "#8b97ea" },
  { id: "black", name: "纯黑", bg: "#000000", card: "#0e0e12", accent: "#8b97ea" },
];
const THEME_IDS = THEMES.map((item) => item.id);

/** 旧值迁移：dark → indigo；light / system / 缺失 → paper（迁移后就地写回） */
function currentThemeChoice() {
  const stored = localStorage.getItem(KEY_THEME);
  if (THEME_IDS.includes(stored)) return stored;
  const migrated = stored === "dark" ? "indigo" : "paper";
  localStorage.setItem(KEY_THEME, migrated);
  return migrated;
}

function applyTheme(choice) {
  document.documentElement.dataset.theme = THEME_IDS.includes(choice) ? choice : "paper";
}

function setThemeChoice(choice) {
  const theme = THEME_IDS.includes(choice) ? choice : "paper";
  localStorage.setItem(KEY_THEME, theme);
  applyTheme(theme);
  syncThemeControls();
}

function setAccent(name) {
  localStorage.setItem(KEY_ACCENT, name);
  document.documentElement.dataset.accent = name;
  syncThemeControls();
}

function syncThemeControls() {
  const choice = currentThemeChoice();
  for (const button of el.settingsInner.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.themeChoice === choice));
  }
  const accent = localStorage.getItem(KEY_ACCENT) || "indigo";
  for (const button of el.settingsInner.querySelectorAll("[data-accent-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.accentChoice === accent));
  }
}

/* ── 侧栏折叠 / 首页态 / 思考强度 ─────────────────────── */

function sidebarOpen() {
  return document.documentElement.dataset.sidebar !== "closed";
}

function toggleSidebar() {
  closeProjectMenu();
  hideRailTip();
  const next = sidebarOpen() ? "closed" : "open";
  if (next === "closed") document.documentElement.dataset.sidebar = "closed";
  else delete document.documentElement.dataset.sidebar;
  localStorage.setItem("lifediary.sidebar", next);
  el.toggleSidebar.setAttribute("aria-expanded", String(next === "open"));
  applySidebarA11y();
}

/* 隐藏的那一层不能是 Tab 焦点（2026-11-06 C 批）：
   展开时轨道藏着、收起时 inner 藏着；窄屏（≤800px）CSS 强制只显示 48px 轨道，
   与 data-sidebar 无关，所以按「实际可见」算，不能只看 dataset。
   inert 同时挡住鼠标与键盘，比只设 tabindex=-1 少一整套维护。 */
const NARROW_SIDEBAR = matchMedia("(max-width: 800px)");

function setInert(node, inert) {
  if (!node) return;
  if (inert) node.setAttribute("inert", "");
  else node.removeAttribute("inert");
}

function applySidebarA11y() {
  const narrow = NARROW_SIDEBAR.matches;
  const railVisible = narrow || !sidebarOpen();
  const innerVisible = !narrow && sidebarOpen();
  setInert(el.sideRail, !railVisible);
  setInert(el.sidebarInner, !innerVisible);
}

NARROW_SIDEBAR.addEventListener("change", applySidebarA11y);

/* 顶部功能菜单：设置走独立路由（#/settings），不是弹层 */
function setMenuOpen(open) {
  el.menuPop.hidden = !open;
  el.menuBtn.setAttribute("aria-expanded", String(open));
}

function closeMenu() {
  setMenuOpen(false);
}

/** 没有消息时输入框抬到中间（首页态），一开口就落回底部 */
let composerObserver = null;

/** 首页居中靠实测卡高：CSS 只负责 `50vh - var(--composer-home-offset)`，
 *  高度变了（textarea 换行 / 工具行折行）由 ResizeObserver 重算。
 *  减 12px = 视觉中心略偏上；JS 失效时 CSS 回退常量 64px。 */
function measureHomeOffset() {
  const height = el.composer.getBoundingClientRect().height;
  if (!height) return;
  el.viewChat.style.setProperty("--composer-home-offset", `${height / 2 - 12}px`);
}

function updateHomeMode() {
  const home = !el.thread.querySelector(".msg");
  el.viewChat.dataset.home = home ? "1" : "0";
  if (home) {
    measureHomeOffset();
    syncGreeting();
    // 只在首页态挂观察器：对话态 bottom 固定 14px，卡高变化与定位无关
    if (!composerObserver && typeof ResizeObserver === "function") {
      composerObserver = new ResizeObserver(measureHomeOffset);
      composerObserver.observe(el.composer);
    }
  } else if (composerObserver) {
    composerObserver.disconnect();
    composerObserver = null;
    el.viewChat.style.removeProperty("--composer-home-offset");
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

/** 模型 pill 上的中性小字：非 off 档才出现（off 是默认，不占视觉）；没配模型也不摆 */
function syncThinkingPill(catalog = state.modelCatalog) {
  if (!el.modelThink) return;
  const level = currentThinking();
  const visible = level !== "off" && Boolean(catalog && catalog.current);
  el.modelThink.textContent = visible ? `·${THINKING_LABELS[level]}` : "";
  el.modelThink.hidden = !visible;
}

/** 菜单打开时把当前档标在**当前模型**那一行（其它模型的档位未选中） */
function syncThinkingSegments() {
  if (!el.modelMenu) return;
  const level = currentThinking();
  for (const row of el.modelMenu.querySelectorAll(".model-row")) {
    const isCurrent = row.dataset.current === "1";
    for (const option of row.querySelectorAll(".think-opt")) {
      option.setAttribute("aria-pressed", String(isCurrent && option.dataset.level === level));
    }
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
  syncThinkingPill();
  syncThinkingSegments();
  // 还没有会话就不用下发，第一轮 `start` 回来时补（同原 setMode 的语义）
  if (!state.conversationId) return;
  await request(`/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/mode`, {
    method: "POST",
    body: JSON.stringify({ thinking: level }),
  }).catch(() => undefined);
}

/* ── 路由 ─────────────────────────────────────────────── */

function currentRoute() {
  const hash = location.hash.replace(/^#/, "");
  if (hash.startsWith("/settings")) return "settings";
  if (hash.startsWith("/tasks")) return "tasks";
  if (hash.startsWith("/domains")) return "domains";
  // 群组两条路由（2026-11-06 群组方案批二）：#/groups 列表、#/group/<id> 会话视图
  if (hash === "/groups" || hash.startsWith("/group/")) return "group";
  return "chat";
}

/** #/group/<id> 里的群 id；不在群会话路由时返回空 */
function groupRouteId() {
  const hash = location.hash.replace(/^#/, "");
  const match = /^\/group\/([A-Za-z0-9-]+)/.exec(hash);
  return match ? match[1] : "";
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

/** 设置子页：#/settings/外观 → "appearance"；缺省落「外观」（同 cindy 的 ?tab=） */
function currentSettingsPage() {
  const part = location.hash.replace(/^#\/settings\/?/, "").split(/[?#]/)[0];
  // 侧栏「全部会话 →」虽已下线（2026-11-07），旧书签 #/settings/sessions 仍要能落地：
  // 分区 id 是 chats，这里做一层别名。
  // 分区 id 其实是 chats；这里做一层别名，不改现有分区与路由体系。
  if (part === "sessions") return "chats";
  // 2026-11-07：头像并入「人设」后，旧书签 / 旧链接的 #/settings/avatars 落到 partners，
  // 而不是掉回「外观」——老入口指过来的地方仍然是改头像的地方。
  if (part === "avatars") return "partners";
  return SETTINGS_SECTIONS.some((section) => section.id === part) ? part : "appearance";
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
  else if (route === "tasks") next = tasksHash();
  else if (route === "domains") next = "#/domains";
  else if (route === "groups") next = "#/groups";
  if (location.hash === next) return;
  state.selfNavHash = next;
  noteRouteChange();
  location.hash = next;
}

function applyRoute() {
  closeMenu();
  closeProjectMenu();
  hideRailTip();
  const route = currentRoute();
  // 设置页是独立整页：侧栏不占位，侧栏开关只在设置页之外出现；
  // 任务中心保留侧栏（入口就在侧栏底部，也能顺手回对话）。
  document.documentElement.dataset.route = route;
  el.viewChat.hidden = route !== "chat";
  el.viewSettings.hidden = route !== "settings";
  el.viewTasks.hidden = route !== "tasks";
  el.viewDomains.hidden = route !== "domains";
  el.viewGroups.hidden = route !== "group";
  // 群会话的轮询只在该路由里跑：离开就停（2026-11-08 批三）
  if (route !== "group") stopGroupPulse();
  // 群组侧栏的选中态只在群组路由里成立：离开群组页后「所有群聊」不该还亮着
  // （2026-11-07 修：openGroupsView 只在进群组页时写 aria-current，回对话页就不再有
  // 人复位它，实测高亮会一直挂在那里）。
  el.secGroupsAll?.setAttribute(
    "aria-current",
    String(route === "group" && !groupRouteId()),
  );
  el.toggleSidebar.hidden = route === "settings";
  el.openSettings.setAttribute("aria-current", String(route === "settings"));
  el.railTasks.setAttribute("aria-current", String(route === "tasks"));
  if (route === "settings") void renderSettings();
  else if (route === "tasks") openTasks();
  else if (route === "domains") openDomains();
  else if (route === "group") void openGroupsView();
  else el.input.focus();
  // 会话行的选中态跟着路由走（2026-11-07）：renderChats 里判了 currentRoute()，
  // 但进群组/任务/设置时不一定会重绘列表——离开对话页就在这里把高亮摘掉，
  // 回对话页再按当前会话补回来。不重排 DOM，只改属性。
  if (route !== "chat") {
    for (const row of el.chats?.querySelectorAll('.chat[aria-current="true"]') || []) {
      row.removeAttribute("aria-current");
    }
  } else {
    const current = el.chats?.querySelector(`.chat[data-conv="${CSS.escape(state.conversationId)}"]`);
    if (current && !current.hasAttribute("aria-current")) current.setAttribute("aria-current", "true");
  }
}

const state = {
  token: readToken(),
  conversationId: localStorage.getItem(KEY_CONV) || "",
  /* 会话种类（2026-11-06 C 批）：chief|worker|partner。没有落盘会话时，首屏就是一个
     普通 worker 空会话；有落盘会话时先空着，等 /messages 回读再认（不靠 id 猜）。 */
  chatKind: localStorage.getItem(KEY_CONV) ? "" : "worker",
  // 服务连通（/healthz）与总管档案状态：两者共同决定绿色在线点，sending 不再参与
  serviceOk: false,
  chiefStatus: "active",
  // 执事缓存：头像 / 名字 / 状态都从这里取，避免每处再拉一遍
  partners: [],
  // 导航令牌：快速切会话时让旧的 open 响应作废，不允许把页面抢回去
  navToken: 0,
  // 路由世代：每次真实路由切换 +1（含浏览器后退）；旧 open 即使回到同一 hash 也失效
  routeGen: 0,
  // go() 自己写入的 hash：下一次 hashchange 认领它，不再当成用户导航
  selfNavHash: "",
  // 正在 open 的执事（防双击；同一个执事并发只发一次）
  partnerOpening: new Set(),
  sending: false,
  stopRequested: false,
  stick: true,
  // 待发图片（2026-11-08 扫尾批 4a）：{mimeType, data(裸 base64)}，只存内存，切换会话/发出即清
  pendingImages: [],
  // 能力投影（GET /agent/policy 的 attachments / editResend / approvalMode）：
  // 关着时入口不渲染；审批形态决定审批卡显示倒计时还是「等待处理」
  capabilities: { attachments: true, editResend: true, approvalMode: "async" },
  chats: [],
  removed: 0,
  query: "",
  // 任务中心：一次拉列表（最多 200 张），看板/详情/徽标都从这里派生
  tickets: [],
  ticketsFetchedAt: 0,
  ticketsLoading: false,
  // 取消/重试开关（扫尾批 1 A1）：来自 GET /tickets 的 cancelEnabled；关时不渲染按钮。
  ticketsCancelEnabled: false,
  domainFilter: "",
  projectFilter: "",
  sort: "recent",
  // 「已完结」折叠区是否展开：只记会话内存，刷新即回到收合态
  tasksArchiveOpen: false,
  // 「更早的直派」折叠组是否展开（L3）：同样只记会话内存，默认收起
  tasksDirectOpen: false,
  // 派活行内「子单 N」展开态：Set of 派活行（父单）id，同样只记会话内存
  tasksChildrenOpen: new Set(),
  // 外部打手过滤（L3）：空 = 不过滤；等于某个 employee 时只留含该执行者的对话卡
  tasksEmployeeFilter: "",
  // 项目筛选的选项来自 GET /api/v1/projects；接口不在时用任务单里的项目名兜底
  projects: [],
  projectsFetchedAt: 0,
  // SSE 断点重放（2026-11-04 seq 方案）：当前会话已收到的最大事件序号。
  // 切会话/刷新即归零——那两种路径本来就走 /messages 全量回读，不需要补帧。
  maxSeq: 0,
  // 模型投影（批次五）：GET /agent/model 的最近一次结果，只做展示，不当缓存用
  modelCatalog: null,
  // 设置页供应商投影（批次五）：GET /agent/providers
  providers: [],
  // 服务页右栏当前状态（G1）：templates=模板选择 / form=编辑现有 / new=新建表单 / empty
  providerView: { mode: "empty", providerId: "", templateId: "" },
  // 密钥填写形态：api=界面直填（PUT /secret）；env=后端没有该接口时退回变量名手输
  providerSecretMode: "api",
  // 供应商表单里的模型草稿（2026-11-05）：{ id, contextWindow, maxTokens, thinkingLevels }
  // 只在前端编辑，点「保存」才随供应商一起落盘。
  providerModels: [],
  // 侧栏项目面板（2026-11-06 起是总览，不再切「当前项目」）：
  // 项目列表每次打开现拉（同模型菜单口径），不在这里缓存。
  switcher: { workspace: null, subCount: 0, unavailable: false },
};

/* ── 任务中心（2026-11-04） ────────────────────────────────
 * 只读看板。数据：GET /api/v1/tickets（列表）与 GET /api/v1/tickets/:id（详情）。
 * 列按「在等谁」分；界面词只有 助理 / 负责人 / 执行者 / 任务单 / 待你处理。
 * 主视图只留「要管的」：done 收进底部的「已完结」折叠区，
 * 不再与进行中的列抢位置（K1，2026-11-05）。
 * L3（2026-11-05）起粒度是「一张卡 = 一条来源对话」：卡头是对话，卡身是这条对话
 * 派出去的每次活（一行一单），子单收在那一行内部；三列喂的是对话卡的聚合灯。
 * 这一版不做改派、不做手动停止，也没有悬浮面板。 */

const TASK_COLUMNS = [
  { id: "ask", label: "待你处理", lamp: "ask" },
  { id: "fail", label: "出错", lamp: "fail" },
  { id: "run", label: "进行中", lamp: "run" },
];

/** [文案, 语气]；语气决定颜色，文案只用人话 */
const TASK_STATUS = {
  received: ["排队中", "idle"],
  planning: ["规划中", "run"],
  planned: ["待派发", "idle"],
  dispatching: ["派发中", "run"],
  reviewing: ["验收中", "run"],
  idle: ["等文件", "ask"],
  needs_you: ["待你处理", "ask"],
  done: ["已完成", "done"],
  failed: ["失败待看", "fail"],
  aborted: ["已中止", "fail"],
  canceled: ["已作废", "idle"],
};

const SUBTASK_STATUS = {
  pending: ["待开始", "idle"],
  running: ["进行中", "run"],
  reported: ["已报告", "run"],
  passed: ["已通过", "done"],
  failed: ["未通过", "fail"],
  blocked: ["受阻", "ask"],
  waiting: ["等待中", "ask"],
  dropped: ["已移除", "idle"],
};

const VERDICT_LABEL = {
  pass: ["通过", "done"],
  fail: ["未通过", "fail"],
  blocked: ["受阻", "ask"],
};

/** 雇员对外只说「执行者」，类型作为后缀（L3 补齐 qoder 国际/国内、原生、总管） */
const EMPLOYEE_LABEL = {
  "pi-durable": "本机执行者",
  qoder: "Qoder",
  "qoder-intl": "Qoder 国际",
  "qoder-cn": "Qoder 国内",
  codebuddy: "CodeBuddy",
  mcp: "MCP",
  phone: "手机",
  native: "原生",
  manager: "总管",
};

/** 外部打手区固定四张（L3）：id 就是 ticket.employee 的字面值 */
const TASK_HITTERS = [
  { id: "codebuddy", label: "CodeBuddy" },
  { id: "qoder-intl", label: "Qoder 国际" },
  { id: "qoder-cn", label: "Qoder 国内" },
  { id: "phone", label: "手机" },
];

/**
 * 侧栏徽标口径：还在流程里的单（received/planning/planned/idle/dispatching/
 * reviewing/needs_you）——failed / done / aborted 都不算「正在跑的活」。
 */
const TASK_BADGE_STATUSES = new Set([
  "received",
  "planning",
  "planned",
  "idle",
  "dispatching",
  "reviewing",
  "needs_you",
]);

/** SSE 的「在等谁」映射成列表里的 status，用来做增量更新 */
const PHASE_STATUS = {
  accepted: "planning",
  planning: "planning",
  running: "dispatching",
  reviewing: "reviewing",
  done: "done",
  needs_you: "needs_you",
  failed: "failed",
  aborted: "aborted",
};

/** 「按状态」排序：先处理需要人的，再看跑着的，最后是完成的（done/aborted 只在折叠区里参与排序） */
const STATUS_ORDER = [
  "needs_you",
  "failed",
  "aborted",
  "idle",
  "reviewing",
  "dispatching",
  "planning",
  "received",
  "planned",
  "done",
];

const TASKS_POLL_MS = 20000;
const BADGE_POLL_MS = 60000;

const STATE_ICON = {
  loading:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  empty:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

function statusError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

function employeeText(kind) {
  if (!kind) return "";
  return EMPLOYEE_LABEL[kind] || String(kind);
}

function relativeTime(iso) {
  if (!iso) return "";
  const stamp = new Date(iso).getTime();
  if (!Number.isFinite(stamp)) return "";
  const minutes = Math.floor((Date.now() - stamp) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

/* ── 一张卡 = 一条对话（L3，2026-11-05） ───────────────────
 * 三层粒度：对话卡 → 派活行（父单）→ 子单。
 * - 卡头是对话本身（标题 / 总管 / 区域 / 聚合灯 / 最近时间），点它回原对话；
 * - 卡身每个父单一行（摘要 / 状态 / 执行者 / 时间），子单只收进那一行的展开区；
 * - 没有 conversationId 的旧直派单不进三列，统一收进底部「更早的直派」折叠组。
 * 灯 / 时间 / 计数全是渲染时从列表现算的派生值，不写回任何单的状态。 */

/** 子单按父单号就地分组：列表里已经有全量字段，不再逐张拉详情 */
function childTicketsOf(parentId) {
  return state.tickets.filter((ticket) => ticket.parentTicketId === parentId);
}

/** 来源对话（L1 新字段）：缺失 / null / 非字符串一律当「无来源对话」 */
function ticketConversationId(ticket) {
  const value = ticket && ticket.conversationId;
  return typeof value === "string" ? value.trim() : "";
}

/** L1 新字段的取值口：不是非空字符串就当没有——老服务端不带字段也照常渲染 */
function ticketText(ticket, key) {
  const value = ticket ? ticket[key] : null;
  return typeof value === "string" ? value.trim() : "";
}

/* 聚合灯（照 CINDY resolveSessionRightStatus 的优先级）：
 * 红「有单出错」→ 蓝「等你处理」→ 灰「执行中」→ 全 done 无灯。 */
const LAMP_TEXT = { fail: "有单出错", ask: "等你处理", run: "执行中", done: "已完成" };
const LAMP_ORDER = ["fail", "ask", "run", "done"];

/** 单灯：failed/aborted 红；needs_you 蓝；done 无灯；其余（排队/派发/验收/等文件）灰 */
function ticketLamp(ticket) {
  const status = ticket ? ticket.status : "";
  if (status === "failed" || status === "aborted") return "fail";
  if (status === "needs_you") return "ask";
  // 作废单不再在跑：归到已完结折叠区，别一直挂在「进行中」列里（仍有「已作废」chip 与重试入口）。
  if (status === "done" || status === "canceled") return "done";
  return "run";
}

/** 卡灯：卡内任一单/子单取最高优先级 */
function conversationLamp(tickets) {
  let lamp = "done";
  for (const ticket of tickets) {
    const next = ticketLamp(ticket);
    if (LAMP_ORDER.indexOf(next) < LAMP_ORDER.indexOf(lamp)) lamp = next;
  }
  return lamp;
}

function lampHtml(lamp) {
  const text = LAMP_TEXT[lamp];
  if (!lamp || !text) return "";
  return `<span class="tk-lamp" data-lamp="${attr(lamp)}"><i aria-hidden="true"></i>${esc(text)}</span>`;
}

/** 卡内全部单（父 + 子）：子单一般继承 conversationId，缺了也要算进聚合 */
function conversationTickets(card) {
  const seen = new Map();
  for (const ticket of card.tickets) seen.set(ticket.id, ticket);
  for (const ticket of card.tickets) {
    for (const child of childTicketsOf(ticket.id)) seen.set(child.id, child);
  }
  return [...seen.values()];
}

/**
 * 派活行 = 卡内的父单。父单不在列表里（被 limit 截断）时，孤儿子单自己顶一行，
 * 别让一张已经派出去的单凭空消失。
 */
function workRowsOf(card) {
  const known = new Set(state.tickets.map((ticket) => ticket.id));
  return card.tickets.filter(
    (ticket) => !ticket.parentTicketId || !known.has(ticket.parentTicketId),
  );
}

/**
 * 分组：有 conversationId 的进对话卡（一对话一卡），没有的进直派组。
 * 卡头三个字段各自取卡内第一个非空值——L1 每张单都会带，取谁结果都一样。
 */
function groupByConversation(tickets) {
  const cards = new Map();
  const direct = [];
  for (const ticket of tickets) {
    const conversationId = ticketConversationId(ticket);
    if (!conversationId) {
      direct.push(ticket);
      continue;
    }
    let card = cards.get(conversationId);
    if (!card) {
      card = {
        conversationId,
        tickets: [],
        title: "",
        chiefName: "",
        project: "",
        updated_at: "",
        lamp: "done",
      };
      cards.set(conversationId, card);
    }
    card.tickets.push(ticket);
  }

  const list = [...cards.values()];
  for (const card of list) {
    // 卡内顺序 = 派活行顺序 = 最近更新在前
    card.tickets.sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
    for (const ticket of card.tickets) {
      if (!card.title) card.title = ticketText(ticket, "conversationTitle");
      if (!card.chiefName) card.chiefName = ticketText(ticket, "chiefName");
      if (!card.project) card.project = ticketText(ticket, "project");
    }
    card.updated_at = card.tickets.length ? card.tickets[0].updated_at || "" : "";
    card.lamp = conversationLamp(conversationTickets(card));
  }

  // 直派组只留「派活行」：子单如果父单也在，就别单列一行（和对话卡同一个口径）
  const known = new Set(state.tickets.map((ticket) => ticket.id));
  const directRows = direct.filter(
    (ticket) => !ticket.parentTicketId || !known.has(ticket.parentTicketId),
  );
  return { cards: list, direct: sortTickets(directRows) };
}

function sortTickets(list) {
  const rows = [...list];
  const byRecent = (a, b) =>
    String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  if (state.sort === "status") {
    const rank = (ticket) => {
      const index = STATUS_ORDER.indexOf(ticket.status);
      return index < 0 ? STATUS_ORDER.length : index;
    };
    rows.sort((a, b) => (rank(a) === rank(b) ? byRecent(a, b) : rank(a) - rank(b)));
  } else {
    rows.sort(byRecent);
  }
  return rows;
}

/** 对话卡排序：卡头时间（recent）或灯优先级（status），与三列顺序同源 */
function sortCards(cards) {
  const rows = [...cards];
  const byRecent = (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  if (state.sort === "status") {
    const rank = (card) => {
      const index = LAMP_ORDER.indexOf(card.lamp);
      return index < 0 ? LAMP_ORDER.length : index;
    };
    rows.sort((a, b) => (rank(a) === rank(b) ? byRecent(a, b) : rank(a) - rank(b)));
  } else {
    rows.sort(byRecent);
  }
  return rows;
}

/** 领域 / 项目 / 执行者筛选：卡内任一单命中就整卡留下（卡内行不裁，避免半张卡） */
function cardMatchesFilters(card) {
  const tickets = conversationTickets(card);
  if (state.domainFilter) {
    const hit =
      state.domainFilter === "__none__"
        ? tickets.some((ticket) => !ticket.domain)
        : tickets.some((ticket) => ticket.domain === state.domainFilter);
    if (!hit) return false;
  }
  if (
    state.projectFilter &&
    !tickets.some((ticket) => (ticket.project || "") === state.projectFilter)
  ) {
    return false;
  }
  if (
    state.tasksEmployeeFilter &&
    !tickets.some((ticket) => ticket.employee === state.tasksEmployeeFilter)
  ) {
    return false;
  }
  return true;
}

/** 直派单只吃领域/项目筛选：它们本来就没有对话可筛 */
function directMatchesFilters(ticket) {
  if (state.domainFilter) {
    if (state.domainFilter === "__none__") {
      if (ticket.domain) return false;
    } else if (ticket.domain !== state.domainFilter) {
      return false;
    }
  }
  if (state.projectFilter && (ticket.project || "") !== state.projectFilter) return false;
  return true;
}

/** 执行者名：空 → 「默认」，未知类型原样显示，别把新雇员藏起来 */
function employeeName(kind) {
  const key = String(kind || "").trim();
  if (!key) return "默认";
  return EMPLOYEE_LABEL[key] || key;
}

/** 三种状态共用一个容器：加载/空/失败都不许白屏 */
function showTasksState(kind, title, text, action) {
  el.tasksState.hidden = false;
  el.tasksState.dataset.kind = kind;
  el.tasksState.replaceChildren();
  const icon = document.createElement("div");
  icon.className = "tasks-state-icon";
  icon.innerHTML = STATE_ICON[kind] || STATE_ICON.empty;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = text;
  el.tasksState.append(icon, heading, body);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    el.tasksState.append(button);
  }
  el.tasksBody.hidden = true;
}

function hideTasksState() {
  el.tasksState.hidden = true;
  el.tasksBody.hidden = false;
}

/**
 * 侧栏「任务中心」分区里的简版列表（2026-11-07 统一批）。
 *
 * 用户口径：任务中心也要能展开、展开后"长得像里面那个对话一样"。
 * 所以这里不复制整张看板，只列最近有活的对话卡（标题 + 聚合灯 + 时间），
 * 点一下进任务中心那张卡（#/tasks?ticket=… 或直接开看板）；
 * 完整三列/筛选/打手卡仍在任务中心页——侧栏是入口，不是第二块看板。
 */
const SIDE_TASKS_LIMIT = 5;

function renderTasksMini() {
  const box = el.tasksMini;
  if (!box) return;
  const { cards, direct } = groupByConversation(state.tickets);
  const alive = (ticket) => TASK_BADGE_STATUSES.has(ticket.status);
  // 固定按最近更新排（不看任务中心的排序/筛选：侧栏要稳定，不该被页面上的筛选带走）
  // 2026-11-07 四改：会话与任务合并成一个分区后，**同一个对话不能出现两行**——
  // 已经在上面会话列表里出现的对话，这里跳过（它那一行本身就是入口，点进去也能看任务）。
  const shown = new Set(
    [...el.chats?.querySelectorAll(".chat") || []].map((row) => row.dataset.conv).filter(Boolean),
  );
  const activeCards = cards
    .filter((card) => conversationTickets(card).some(alive))
    .filter((card) => !shown.has(card.conversationId))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  box.replaceChildren();

  // 空态由整块（会话 + 任务）统一给，这里不再各说一句；
  // 但统一空态本身由本函数的收尾来刷新——最后一张任务行消失时也要能补上那句话
  // （2026-11-07 修：原先提前 return 跳过了收尾的 renderSideListEmpty，空态一直缺失）
  if (!activeCards.length && !direct.some(alive)) {
    renderSideListEmpty();
    return;
  }

  for (const card of activeCards.slice(0, SIDE_TASKS_LIMIT)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-item task-row";
    row.dataset.lamp = card.lamp;
    row.title = `${card.title || "未命名对话"} · 打开任务中心`;
    const lamp = document.createElement("i");
    lamp.className = "task-lamp";
    lamp.dataset.lamp = card.lamp === "done" ? "run" : card.lamp;
    const name = document.createElement("span");
    name.className = "side-item-label";
    name.textContent = card.title || "未命名对话";
    const time = document.createElement("span");
    time.className = "roster-idle";
    time.textContent = relativeTime(card.updated_at);
    row.append(lamp, name, time);
    row.addEventListener("click", () => {
      go("tasks");
      const first = workRowsOf(card)[0];
      if (first) location.hash = `#/tasks?ticket=${encodeURIComponent(first.id)}`;
    });
    box.append(row);
  }

  // 直派（没有来源对话的旧单）：只给一行计数，点进任务中心底部那组
  const aliveDirect = direct.filter(alive).length;
  if (aliveDirect) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-item task-row";
    row.innerHTML = `<span class="side-item-label">更早的直派</span><span class="roster-idle">${aliveDirect} 单</span>`;
    row.addEventListener("click", () => go("tasks"));
    box.append(row);
  }
  renderSideListEmpty();
}

/**
 * 合并后的统一空态（2026-11-07 四改）：会话行与任务行都没内容时，才在列表顶上
 * 放一句「还没有对话」。两处各写一句会同时冒出两条互相矛盾的提示。
 */
function renderSideListEmpty() {
  if (!el.chats) return;
  el.chats.querySelector(".chats-empty")?.remove();
  const taskRows = el.tasksMini?.querySelectorAll(".task-row").length || 0;
  if (el.chats.querySelector(".chat") || taskRows) return;
  const hint = document.createElement("div");
  hint.className = "chats-empty";
  hint.textContent = "还没有对话。用 ＋ 新建一条。";
  el.chats.append(hint);
}

function syncTasksBadge() {
  // 徽标口径跟看板一致：数「还有活在跑/在等」的对话卡；直派单没有卡，自己算一个。
  // 注意 alive 收的是**单张票**：direct.filter(alive) 直接可用；卡内用 .some(alive)。
  // （E5 实测：原来 alive 写成收数组，遇到直派单会抛错，把后面的总管计数一起带掉。）
  const { cards, direct } = groupByConversation(state.tickets);
  const alive = (ticket) => TASK_BADGE_STATUSES.has(ticket.status);
  const active =
    cards.filter((card) => conversationTickets(card).some(alive)).length + direct.filter(alive).length;
  el.tasksBadge.hidden = active === 0;
  el.tasksBadge.textContent = active > 99 ? "99+" : String(active);

  // E5：无 domain 的活跃单 = 总管直接派给无主工人的活，挂在总管条目右侧。
  // 不可点击（总管没有 domain 筛选入口），为 0 时不显示。
  if (el.chiefCount) {
    const chiefActive = state.tickets.filter(
      (ticket) => !ticket.domain && TASK_BADGE_STATUSES.has(ticket.status),
    ).length;
    el.chiefCount.hidden = chiefActive === 0;
    el.chiefCount.textContent = chiefActive > 99 ? "99+ 单" : `${chiefActive} 单`;
  }

  // 侧栏「任务中心」分区的简版列表跟着同一份数据走（不另拉接口）
  renderTasksMini();
}

/**
 * 外部打手小卡（L3）：只读聚合，四张固定，数据全部来自现有 tickets 列表。
 * 「未完结」= 还没 done / aborted 的单（failed 也算没完，得有人看）。
 */
function hitterCards() {
  const open = state.tickets.filter(
    (ticket) => ticket.status !== "done" && ticket.status !== "aborted",
  );
  return TASK_HITTERS.map(({ id, label }) => {
    const mine = open
      .filter((ticket) => ticket.employee === id)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return { id, label, count: mine.length, latest: mine[0] || null };
  });
}

function renderHitters() {
  el.tasksHitters.replaceChildren();
  el.tasksHitters.hidden = false;
  for (const hitter of hitterCards()) {
    const active = state.tasksEmployeeFilter === hitter.id;
    const latest = hitter.latest;
    const brief = latest ? String(latest.prompt || "").replace(/\s+/g, " ").trim() : "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tk-hitter";
    button.dataset.employee = hitter.id;
    button.dataset.active = active ? "1" : "0";
    button.setAttribute("aria-pressed", String(active));
    button.title = hitter.count
      ? `只看「${hitter.label}」派出去的活（再点一次取消）`
      : `${hitter.label} 当前空闲`;
    button.innerHTML = `
      <span class="tk-hitter-head">
        <span class="tk-hitter-name">${esc(hitter.label)}</span>
        ${hitter.count ? `<span class="tk-hitter-count">${hitter.count}</span>` : ""}
      </span>
      ${
        hitter.count
          ? `<span class="tk-hitter-brief">${esc(brief.slice(0, 40) || "（没有说明）")}</span>
             <span class="tk-hitter-foot">${lampHtml(ticketLamp(latest))}<span class="tk-hitter-time">${esc(relativeTime(latest.updated_at))}</span></span>`
          : `<span class="tk-hitter-idle">空闲</span>`
      }
    `;
    el.tasksHitters.append(button);
  }
}

function syncDomainOptions() {
  const domains = [...new Set(state.tickets.map((ticket) => ticket.domain).filter(Boolean))].sort();
  const previous = state.domainFilter;
  el.tasksDomain.replaceChildren(new Option("全部领域", ""));
  for (const domain of domains) el.tasksDomain.append(new Option(domain, domain));
  if (state.tickets.some((ticket) => !ticket.domain)) {
    // E5 口径：无 domain 的单 = 总管直接派发给无主工人的活，不叫「未分领域」。
    el.tasksDomain.append(new Option("总管（未分配）", "__none__"));
  }
  const values = new Set([...el.tasksDomain.options].map((option) => option.value));
  el.tasksDomain.value = values.has(previous) ? previous : "";
  state.domainFilter = el.tasksDomain.value;
}

/**
 * 项目筛选选项：优先 GET /api/v1/projects，接口不可用时用任务单里的项目名兜底；
 * 已归档但仍有历史单的项目也要保留，否则那些单会筛不出来。
 */
function syncProjectOptions() {
  const names = new Set();
  for (const project of state.projects) {
    if (!project.archived) names.add(project.name);
  }
  for (const ticket of state.tickets) {
    if (ticket.project) names.add(ticket.project);
  }
  const previous = state.projectFilter;
  el.tasksProject.replaceChildren(new Option("全部项目", ""));
  for (const name of [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    el.tasksProject.append(new Option(name, name));
  }
  const values = new Set([...el.tasksProject.options].map((option) => option.value));
  el.tasksProject.value = values.has(previous) ? previous : "";
  state.projectFilter = el.tasksProject.value;
}

async function loadProjects({ force = false } = {}) {
  if (!force && state.projectsFetchedAt && Date.now() - state.projectsFetchedAt < 60000) {
    return;
  }
  try {
    const response = await request("/api/v1/projects", { cache: "no-store" });
    if (!response.ok) return; // 筛选是附加能力：接口不在就当没有，不打断看板
    const data = await response.json();
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    state.projectsFetchedAt = Date.now();
    if (currentRoute() === "tasks" && !currentTicketId() && state.tickets.length) {
      syncProjectOptions();
    }
  } catch {
    // 静默：项目接口失败不影响任务列表
  }
}

/** 派活行：一单一行。摘要 / 状态 / 执行者 / 时间 + 「子单 N」展开区（两层收拢） */
/** 取消/重试（扫尾批 1 A1）：只在该单可操作时渲染；开关关着一律不渲染。 */
const RETRYABLE_TICKET_STATUS = new Set(["failed", "aborted", "canceled"]);
// 服务端 cancel 只对这三个终态回 400，其余（含 needs_you / idle）都能作废。
const CANCEL_BLOCKED_STATUS = new Set(["done", "failed", "aborted"]);
function ticketActionButtons(ticket, enabled = state.ticketsCancelEnabled) {
  if (!enabled) return "";
  const status = String(ticket.status || "");
  const canceled = Boolean(ticket.canceled) || status === "canceled";
  const id = attr(ticket.id || "");
  if (canceled || RETRYABLE_TICKET_STATUS.has(status)) {
    return `<span class="tk-row-actions"><button class="tk-act" type="button" data-ticket-action="retry" data-ticket="${id}">重试</button></span>`;
  }
  if (!CANCEL_BLOCKED_STATUS.has(status)) {
    return `<span class="tk-row-actions"><button class="tk-act" type="button" data-ticket-action="cancel" data-ticket="${id}">取消</button></span>`;
  }
  return "";
}

function workRow(ticket) {
  const children = childTicketsOf(ticket.id);
  const [label, tone] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
  const prompt = String(ticket.prompt || "").replace(/\s+/g, " ").trim();
  const brief = prompt ? (prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt) : "（没有说明）";
  const childrenOpen = state.tasksChildrenOpen.has(ticket.id);

  const childRows = children
    .map((child) => {
      const [childLabel, childTone] = TASK_STATUS[child.status] || [child.status || "未知", "idle"];
      return `<a class="tk-child-row" href="#/tasks?ticket=${encodeURIComponent(child.id)}">
        <span class="tk-child-id">${esc(child.id)}</span>
        <span class="tk-chip" data-tone="${childTone}">${esc(childLabel)}</span>
        <span class="tk-child-time">${esc(relativeTime(child.updated_at))}</span>
      </a>`;
    })
    .join("");

  // 行根是 div[role=button]：行内还要放「子单 N」按钮，按钮里嵌按钮是非法 HTML。
  // 键盘行为由 tasksBody 上的 keydown 补齐。展开态 key = 派活行（父单）id。
  const row = document.createElement("div");
  row.className = "tk-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.dataset.ticket = ticket.id;
  row.dataset.lamp = ticketLamp(ticket);
  row.innerHTML = `
    <div class="tk-row-top">
      <span class="tk-row-prompt">${esc(brief)}</span>
      <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
    </div>
    <div class="tk-row-meta">
      <span class="tk-row-who">${esc(employeeName(ticket.employee))}</span>
      <span class="tk-row-time">${esc(relativeTime(ticket.updated_at))}</span>
    </div>
    ${ticketActionButtons(ticket)}
    ${
      children.length
        ? `<button class="tk-children-toggle" type="button" data-ticket="${attr(ticket.id)}" aria-expanded="${childrenOpen ? "true" : "false"}">
            <span>子单 ${children.length}</span><span class="tk-child-caret" aria-hidden="true">▸</span>
          </button>
          <div class="tk-children"${childrenOpen ? "" : " hidden"}>${childRows}</div>`
        : ""
    }
  `;
  return row;
}

/** 对话卡：卡头 = 对话（可点回原对话），卡身 = 这条对话派出去的每次活 */
function conversationCard(card) {
  const badges = [
    card.chiefName ? `<span class="tk-badge">总管 ${esc(card.chiefName)}</span>` : "",
    card.project ? `<span class="tk-badge">区域 ${esc(card.project)}</span>` : "",
  ].join("");
  const element = document.createElement("article");
  element.className = "tk-card";
  element.dataset.lamp = card.lamp;
  // 全 done 的卡不进主视图；万一进来也不挂灯，只留时间（灯只在有话要说时才亮）
  const lamp = card.lamp === "done" ? "" : lampHtml(card.lamp);
  element.innerHTML = `
    <button class="tk-conv-head" type="button" data-conv="${attr(card.conversationId)}" title="回到这条对话">
      <span class="tk-conv-title">${esc(card.title || "未命名对话")}</span>
      <span class="tk-conv-badges">${badges}</span>
      <span class="tk-conv-tail">${lamp}<span class="tk-conv-time">${esc(relativeTime(card.updated_at))}</span></span>
    </button>
    <div class="tk-rows"></div>
  `;
  const rows = element.querySelector(".tk-rows");
  for (const ticket of workRowsOf(card)) rows.append(workRow(ticket));
  return element;
}

function renderStats(cards, direct) {
  const count = (lamp) => cards.filter((card) => card.lamp === lamp).length;
  // 「派活」数的是派活行（父单），子单不算一次派活
  const dispatched =
    cards.reduce((sum, card) => sum + workRowsOf(card).length, 0) +
    direct.filter((ticket) => !ticket.parentTicketId).length;
  const stats = [
    ["进行中", count("run"), "run"],
    ["等你处理", count("ask"), "ask"],
    ["有单出错", count("fail"), "fail"],
    ["已完成", count("done"), ""],
    ["派活", dispatched, ""],
  ];
  el.tasksStats.replaceChildren();
  for (const [label, value, tone] of stats) {
    const tile = document.createElement("div");
    tile.className = "tk-stat";
    if (tone) tile.dataset.tone = tone;
    tile.innerHTML = `<div class="tk-stat-label">${esc(label)}</div><div class="tk-stat-value">${value}</div>`;
    el.tasksStats.append(tile);
  }
}

/** 旧行式简卡（直派单用）：单号 + prompt 截断 + 状态徽章 + 相对时间；不带进度条与错误详情 */
function archiveRow(ticket) {
  const [label, tone] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
  const prompt = String(ticket.prompt || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tk-arch-row";
  row.dataset.ticket = ticket.id;
  row.dataset.status = ticket.status;
  row.innerHTML = `
    <span class="tk-arch-id">${esc(ticket.id)}</span>
    <span class="tk-arch-prompt">${esc(prompt || "（没有说明）")}</span>
    <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
    <span class="tk-arch-time">${esc(relativeTime(ticket.updated_at))}</span>
  `;
  return row;
}

/** 已完结简卡：对话卡样式（标题 + 聚合灯 + 时间），点它回原对话 */
function archiveCard(card) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tk-arch-conv";
  row.dataset.conv = card.conversationId;
  row.title = "回到这条对话";
  row.innerHTML = `
    <span class="tk-arch-title">${esc(card.title || "未命名对话")}</span>
    <span class="tk-arch-count">${workRowsOf(card).length} 次派活</span>
    ${lampHtml("done")}
    <span class="tk-arch-time">${esc(relativeTime(card.updated_at))}</span>
  `;
  return row;
}

/**
 * 折叠条：已完结区与「更早的直派」共用一套外观，但各自记展开态。
 * 结构 = 一条横条 + 一段列表；横条点一下就地收放，不重绘整板。
 */
function foldSection({ count, label, emptyText, open, onToggle, renderRow }) {
  if (!count) {
    const bar = document.createElement("div");
    bar.className = "tk-archive-bar is-empty";
    bar.textContent = emptyText;
    return bar;
  }
  const items = document.createElement("div");
  items.className = "tk-arch-list";
  items.hidden = !open;
  for (const item of renderRow()) items.append(item);

  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = "tk-archive-bar";
  bar.setAttribute("aria-expanded", String(open));
  bar.innerHTML = `<span>${esc(label)}</span><span class="tk-arch-caret" aria-hidden="true">▸</span>`;
  bar.addEventListener("click", () => {
    const next = !items.hidden;
    items.hidden = !next;
    bar.setAttribute("aria-expanded", String(next));
    onToggle(next);
  });
  // 容器本身是 .tk-archive（flex 列 + gap），这里只交出「横条 + 列表」两段
  const fragment = document.createDocumentFragment();
  fragment.append(bar, items);
  return fragment;
}

/**
 * 已完结折叠区（K1/L3）：全 done 的对话卡从三列退场，只留底部一条低调横条。
 * 放在看板网格外（见 index.html），窄屏不必横向滚到最右才点得到。
 * 展开态记 state.tasksArchiveOpen —— 会话内存，刷新回到收合。
 */
function renderArchive(cards) {
  el.tasksArchive.replaceChildren();
  el.tasksArchive.hidden = false;
  el.tasksArchive.append(
    foldSection({
      count: cards.length,
      label: `已完结 ${cards.length} 个对话（已完成）`,
      emptyText: "已完结 0 个对话（已完成）",
      open: state.tasksArchiveOpen,
      onToggle: (next) => {
        state.tasksArchiveOpen = next;
      },
      renderRow: () => cards.map(archiveCard),
    }),
  );
}

/**
 * 「更早的直派」（L3）：没有 conversationId 的旧单/探针单不进三列，
 * 沿用已完结的折叠样式摆在最下面，默认收起。清库后正常情况下这里是空的。
 */
function renderDirect(rows) {
  el.tasksDirect.replaceChildren();
  if (!rows.length) {
    el.tasksDirect.hidden = true;
    return;
  }
  el.tasksDirect.hidden = false;
  el.tasksDirect.append(
    foldSection({
      count: rows.length,
      label: `更早的直派 ${rows.length} 单（没有来源对话）`,
      emptyText: "",
      open: state.tasksDirectOpen,
      onToggle: (next) => {
        state.tasksDirectOpen = next;
      },
      renderRow: () => rows.map(archiveRow),
    }),
  );
}

function boardEmptyNote(hasTickets) {
  const note = document.createElement("div");
  note.className = "tk-board-empty";
  note.innerHTML = hasTickets
    ? `<h2>没有正在跑的活</h2>
       <p>派出去后按对话收成一张卡；已经完结的在下方「已完结」里</p>`
    : `<h2>还没有派出去的活</h2>
       <p>在对话里派活后，这里会按对话收成一张卡，卡身是每次派活</p>`;
  return note;
}

/** 清除筛选：领域 / 项目 / 执行者 / 排序一起回到默认，并同步 hash 与下拉框 */
function clearTaskFilters() {
  state.domainFilter = "";
  state.projectFilter = "";
  state.tasksEmployeeFilter = "";
  state.sort = "recent";
  el.tasksDomain.value = "";
  el.tasksProject.value = "";
  el.tasksSort.value = "recent";
  writeTasksHash("");
  renderBoard();
}

/** 筛选筛空：就地提示 + 一键清除；打手四卡留在上方，点错执行者也能自己点回来 */
function filterEmptyNote() {
  const note = document.createElement("div");
  note.className = "tk-board-empty";
  const heading = document.createElement("h2");
  heading.textContent = "没有符合筛选的任务单";
  const text = document.createElement("p");
  text.textContent = "换个领域、项目或执行者，或者清除筛选看看全部任务。";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = "清除筛选";
  button.addEventListener("click", clearTaskFilters);
  note.append(heading, text, button);
  return note;
}

function renderBoard() {
  // 自动刷新会反复走这里：先记下滚动位置，重排后再放回去，别让看板自己跳回顶部/最左。
  const scrollTop = el.tasksScroll.scrollTop;
  const scrollLeft = el.tasksScroll.scrollLeft;

  hideTasksState();
  el.tasksDetail.hidden = true;
  el.tasksHitters.hidden = false;
  el.tasksBoard.hidden = false;
  el.tasksStats.hidden = false;
  el.tasksFilters.hidden = false;
  el.tasksBack.hidden = true;
  el.tasksTitleText.textContent = "任务中心";

  const { cards, direct } = groupByConversation(state.tickets);
  const totalTickets = state.tickets.length;
  const hasTickets = totalTickets > 0;
  el.tasksTitleSub.textContent = "";

  if (hasTickets) {
    syncDomainOptions();
    syncProjectOptions();
  }
  el.tasksSort.value = state.sort;

  const visibleCards = sortCards(cards.filter(cardMatchesFilters));
  const visibleDirect = direct.filter(directMatchesFilters);
  // 有单但筛不出来：就地给「清除筛选」，不进全屏空状态——
  // 打手四卡必须还看得见，否则点错了执行者就再也点不回来。
  const noneVisible = !visibleCards.length && !visibleDirect.length && hasTickets;

  if (hasTickets) {
    const filtered = visibleCards.length !== cards.length || Boolean(state.tasksEmployeeFilter);
    // 只有直派单时「0 个对话」很怪，直接说清楚这一屏是什么
    el.tasksTitleSub.textContent = !cards.length
      ? `共 ${totalTickets} 次直派（没有来源对话）`
      : filtered
        ? `筛选 ${visibleCards.length} / 共 ${cards.length} 个对话`
        : `共 ${cards.length} 个对话 · ${totalTickets} 次派活`;
  }

  // 一张任务单都没有时，统计和筛选没有信息量，让位给空状态说明；打手四卡仍要露脸
  el.tasksStats.hidden = !hasTickets;
  el.tasksFilters.hidden = !hasTickets;
  renderHitters();
  renderStats(visibleCards, visibleDirect);
  el.tasksBoard.replaceChildren();

  const archive = visibleCards.filter((card) => card.lamp === "done");
  const main = visibleCards.filter((card) => card.lamp !== "done");
  if (noneVisible) {
    el.tasksBoard.append(filterEmptyNote());
  } else if (!main.length) {
    // 全空（含从没派过活）：不摆三列空架子，直接说清楚「这里将来会出现什么」
    el.tasksBoard.append(boardEmptyNote(hasTickets));
  } else {
    for (const column of TASK_COLUMNS) {
      const items = main.filter((card) => card.lamp === column.lamp);
      const section = document.createElement("section");
      section.className = "tk-col";
      section.dataset.column = column.id;
      const head = document.createElement("div");
      head.className = "tk-col-head";
      head.innerHTML = `<h2>${esc(column.label)}</h2><span class="tk-col-count">${items.length}</span>`;
      section.append(head);
      if (!items.length) {
        const blank = document.createElement("div");
        blank.className = "tk-col-empty";
        blank.textContent = "无";
        section.append(blank);
      } else {
        for (const card of items) section.append(conversationCard(card));
      }
      el.tasksBoard.append(section);
    }
  }
  if (noneVisible) {
    el.tasksArchive.hidden = true;
    el.tasksDirect.hidden = true;
  } else {
    renderArchive(archive);
    renderDirect(visibleDirect);
  }

  el.tasksScroll.scrollTop = scrollTop;
  el.tasksScroll.scrollLeft = scrollLeft;
}

async function loadTickets({ silent = false, force = false, render = true } = {}) {
  if (state.ticketsLoading) return;
  if (!force && state.ticketsFetchedAt && Date.now() - state.ticketsFetchedAt < 4000) {
    if (render && !silent) renderBoard();
    return;
  }
  state.ticketsLoading = true;
  if (!silent && !state.ticketsFetchedAt && render) {
    showTasksState("loading", "正在读取任务单…", "第一次打开会扫一遍本机的任务目录。");
  }
  try {
    const response = await request("/api/v1/tickets?limit=200", { cache: "no-store" });
    if (!response.ok) throw statusError(response.status);
    const data = await response.json();
    state.tickets = Array.isArray(data.tickets) ? data.tickets : [];
    state.ticketsFetchedAt = Date.now();
    // 开关随列表下发：DELEGATION_CANCEL=false 时服务端不挂端点，前端也不渲染按钮。
    // 只认显式 true——老版本服务端没这个字段时按「不渲染」处理，避免点了 404。
    state.ticketsCancelEnabled = data.cancelEnabled === true;
    syncTasksBadge();
    // 详情页自动刷新时只更新内存与徽标，不动正在看的详情（不重置滚动/展开状态）
    if (render && currentRoute() === "tasks" && !currentTicketId()) renderBoard();
  } catch (error) {
    if (!silent && render && currentRoute() === "tasks" && !currentTicketId()) {
      const notFound = error && error.status === 404;
      showTasksState(
        "error",
        "任务单没读出来",
        notFound
          ? "服务端还没有任务列表接口，可能是旧版本；更新服务后再试。"
          : "读取本机任务目录时出错了，稍后再试一次。",
        { label: "重试", run: () => loadTickets({ force: true }) },
      );
    }
  } finally {
    state.ticketsLoading = false;
  }
}

function openTasks() {
  // 筛选与排序从 hash 恢复（刷新、从对话点链接进来都走这里）
  const params = tasksParams();
  state.domainFilter = params.get("domain") || "";
  state.projectFilter = params.get("project") || "";
  state.sort = params.get("sort") === "status" ? "status" : "recent";
  // 外部打手过滤只记会话内存：每次进任务中心都从「全部」开始，避免上次的过滤把看板筛空
  state.tasksEmployeeFilter = "";
  el.tasksSort.value = state.sort;
  void loadProjects();

  const ticketId = currentTicketId();
  if (ticketId) {
    void showTicketDetail(ticketId);
    return;
  }
  if (state.ticketsFetchedAt) renderBoard();
  void loadTickets();
}

async function showTicketDetail(ticketId) {
  hideTasksState();
  el.tasksBoard.hidden = true;
  el.tasksArchive.hidden = true;
  el.tasksDirect.hidden = true;
  el.tasksHitters.hidden = true;
  el.tasksStats.hidden = true;
  el.tasksFilters.hidden = true;
  el.tasksDetail.hidden = false;
  el.tasksBack.hidden = false;
  el.tasksTitleText.textContent = "任务单";
  el.tasksTitleSub.textContent = ticketId;
  const loading = document.createElement("p");
  loading.className = "td-note";
  loading.textContent = "正在读取任务单…";
  el.tasksDetail.replaceChildren(loading);

  try {
    const response = await request(`/api/v1/tickets/${encodeURIComponent(ticketId)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw statusError(response.status);
    const data = await response.json();
    renderTicketDetail(data, ticketId);
  } catch (error) {
    const notFound = error && error.status === 404;
    const wrap = document.createElement("div");
    wrap.className = "td-card";
    const note = document.createElement("p");
    note.className = "td-note";
    note.dataset.tone = "fail";
    note.textContent = notFound
      ? "找不到这张任务单，可能已经被清理了。"
      : "任务单详情没读出来，稍后再试一次。";
    const row = document.createElement("div");
    row.className = "tasks-actions";
    row.style.marginTop = "12px";
    if (!notFound) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ghost";
      retry.textContent = "重试";
      retry.addEventListener("click", () => void showTicketDetail(ticketId));
      row.append(retry);
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "ghost";
    back.textContent = "返回看板";
    back.addEventListener("click", () => go("tasks"));
    row.append(back);
    wrap.append(note, row);
    el.tasksDetail.replaceChildren(wrap);
  }
}

function renderTicketDetail(data, fallbackId) {
  const ticket = data.ticket || {};
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  const children = Array.isArray(data.children) ? data.children : [];
  const [statusLabel, statusTone] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
  const total = tasks.length;
  const passed = tasks.filter((task) => task.status === "passed").length;
  const percent = total > 0 ? Math.min(100, Math.round((passed / total) * 100)) : 0;
  const employee = employeeText(ticket.employee || ticket.options?.employee);
  const project = data.project?.name || ticket.options?.project?.name || "";
  const error = ticket.error ? String(ticket.error).trim() : "";
  // 接口带回这三项后才显示；现在没有就完全不渲染（等后端落盘）
  const lastAction = String(ticket.lastAction || data.lastAction || "").trim();
  const waitingOn = String(ticket.waitingOn || data.waitingOn || "").trim();
  const heartbeat = ticket.lastHeartbeat || data.lastHeartbeat || "";

  const taskRows = tasks.length
    ? tasks
        .map((task) => {
          const [label, tone] = SUBTASK_STATUS[task.status] || [task.status || "未知", "idle"];
          return `<li class="td-task">
            <span class="td-seq">${String(task.seq).padStart(2, "0")}</span>
            <span class="td-task-title">${esc(task.title || task.slug || "")}</span>
            <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
          </li>`;
        })
        .join("")
    : `<div class="td-note">任务还没拆出来；等负责人规划后会出现在这里。</div>`;

  const childRows = children.length
    ? `<section class="td-section">
        <h3>子任务单<span>${children.length}</span></h3>
        ${children
          .map((child) => {
            const [label, tone] = TASK_STATUS[child.status] || [child.status || "未知", "idle"];
            return `<a class="td-child" href="#/tasks?ticket=${encodeURIComponent(child.id)}">
              <span>任务单</span>
              <span class="td-child-id">${esc(child.id)}</span>
              <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
            </a>`;
          })
          .join("")}
      </section>`
    : "";

  const reviewRows = reviews.length
    ? `<section class="td-section">
        <h3>验收记录<span>${reviews.length}</span></h3>
        ${reviews
          .slice(-6)
          .map((review) => {
            const [label, tone] = VERDICT_LABEL[review.verdict] || [review.verdict || "", "idle"];
            return `<div class="td-review">
              <div class="td-review-top">
                <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
                <span class="td-stage">${esc(review.stage || "")}</span>
              </div>
              <p>${esc(review.reason || "（没有说明）")}</p>
            </div>`;
          })
          .join("")}
      </section>`
    : "";

  // 迟到的回报（E2 #2）：父单终态后才回来的子单结果，只读记账，不自动并入。
  // 空数组整节不渲染；每行照 reviewRows 的写法：子单 id · 状态 pill · note · 时间。
  const deadLetters = Array.isArray(data.deadLetters) ? data.deadLetters : [];
  const deadLetterRows = deadLetters.length
    ? `<section class="td-section">
        <h3>迟到的回报<span>${deadLetters.length}</span></h3>
        <p class="td-sec-hint">父单已终态后子单才回的结果，记账在此，不会自动并入。</p>
        ${deadLetters
          .map((letter) => {
            const [label, tone] = TASK_STATUS[letter.childStatus] || [letter.childStatus || "未知", "idle"];
            return `<div class="td-review">
              <div class="td-review-top">
                <span class="td-deadletter-id">${esc(letter.childTicketId || "")}</span>
                <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
                <span class="td-stage" title="${esc(letter.createdAt || "")}">${esc(relativeTime(letter.createdAt))}</span>
              </div>
              <p>${esc(letter.note || "（没有说明）")}</p>
            </div>`;
          })
          .join("")}
      </section>`
    : "";

  // 派活留言（2026-11-07）：把"谁在什么时候说了什么"摆在需求正文之前。
  // 以前详情只有 ticket.prompt 一段裸文本，看不出是总管说的还是别人转的。
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const SENDER_LABEL = { chief: "总管", partner: "", worker: "执行端", system: "系统" };
  const messageRows = messages.length
    ? `<section class="td-section td-messages">
        <h3>派活往来<span>${messages.length}</span></h3>
        ${messages
          .map((message) => {
            const who =
              message.fromKind === "partner"
                ? message.fromName || "执事"
                : message.fromName || SENDER_LABEL[message.fromKind] || "系统";
            const isOut = message.direction === "out";
            return `<div class="td-msg" data-dir="${esc(message.direction || "out")}">
              <div class="td-msg-top">
                <span class="td-msg-who">${isOut ? "来自" : "回到"} ${esc(who)}</span>
                <span class="td-stage" title="${esc(message.createdAt || "")}">${esc(relativeTime(message.createdAt))}</span>
              </div>
              <p class="td-msg-body">${esc(message.body || "")}</p>
            </div>`;
          })
          .join("")}
      </section>`
    : "";

  // 动作区（扫尾批 1 A1）：详情与行内共用一套按钮；开关随本页响应下发。
  const actionButtons = ticketActionButtons(
    ticket,
    data.cancelEnabled === true || state.ticketsCancelEnabled,
  );

  el.tasksDetail.innerHTML = `
    <div class="td-card"${ticket.status === "needs_you" ? ' data-attn="1"' : ""}>
      <div class="td-head">
        <span class="tk-chip" data-tone="${statusTone}">${esc(statusLabel)}</span>
        <span class="td-domain">${esc(data.domain || ticket.options?.domain || "")}</span>
        ${project ? `<span class="td-proj">项目 ${esc(project)}</span>` : ""}
        <span class="td-time">${esc(relativeTime(ticket.updated_at))}</span>
      </div>
      <h2 class="td-prompt">${esc(String(ticket.prompt || "").trim() || "（没有说明）")}</h2>
      <div class="td-meta">
        <span>任务 <b>${passed}/${total}</b></span>
        ${employee ? `<span>执行者 ${esc(employee)}</span>` : ""}
        <span>任务单 ${esc(ticket.id || fallbackId)}</span>
        ${lastAction ? `<span>最近 ${esc(lastAction)}</span>` : ""}
        ${waitingOn ? `<span>等文件 ${esc(waitingOn)}</span>` : ""}
        ${heartbeat ? `<span>心跳 ${esc(relativeTime(heartbeat))}</span>` : ""}
      </div>
      ${total > 0 ? `<div class="tk-bar"><i style="width:${percent}%"></i></div>` : ""}
      ${error ? `<p class="td-note" data-tone="${ticket.status === "failed" || ticket.status === "aborted" ? "fail" : "ask"}">${esc(error)}</p>` : ""}
    </div>
    ${actionButtons ? `<div class="td-actions">${actionButtons}</div>` : ""}
    <section class="td-section">
      <h3>任务<span>${passed}/${total}</span></h3>
      <ul class="td-tasks">${taskRows}</ul>
    </section>
    ${childRows}
    ${reviewRows}
    ${deadLetterRows}
    ${messageRows}
  `;
}

/* ── 取消 / 重试（扫尾批 1 A1）─────────────────────────────
 * 作废 = harness 侧不再汇报、不写回对话；执行端可能继续跑完、产物照常落盘。
 * 取消不可逆所以走确认弹窗；重试直接调端点。操作后本地立即置态 + 刷新列表。 */
async function performTicketAction(ticketId, action) {
  try {
    const response = await request(`/api/v1/tickets/${encodeURIComponent(ticketId)}/${action}`, {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data?.message || `没成功：HTTP ${response.status}`);
      return false;
    }
    const ticket = state.tickets.find((item) => item.id === ticketId);
    if (ticket && action === "cancel") {
      ticket.canceled = true;
      ticket.status = "canceled";
    }
    toast(action === "cancel" ? "已作废" : "已重派新单");
    await loadTickets({ force: true, silent: true, render: false });
    if (currentRoute() === "tasks") {
      if (currentTicketId()) void showTicketDetail(currentTicketId());
      else renderBoard();
    }
    return true;
  } catch (error) {
    if (error.message !== "forbidden") toast(`没成功：${error.message}`);
    return false;
  }
}

function confirmCancelTicket(ticketId) {
  openModal("作废这张任务单", (body) => {
    body.innerHTML = `
      <p class="modal-desc">作废后，执行端可能继续跑完、产物照常落盘，但它不再汇报、也不会把结果写回对话。此操作不可逆。</p>
      <p class="modal-hint" id="tk-cancel-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>暂不作废</button>
        <button class="modal-danger" type="button" id="tk-cancel-confirm">确认作废</button>
      </div>`;
    const hint = body.querySelector("#tk-cancel-hint");
    const confirm = body.querySelector("#tk-cancel-confirm");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    confirm?.addEventListener("click", async () => {
      if (confirm.disabled) return;
      confirm.disabled = true;
      const ok = await performTicketAction(ticketId, "cancel");
      if (ok) closeModal();
      else {
        setModalHint(hint, "作废没成功，稍后再试一次");
        confirm.disabled = false;
      }
    });
  });
}

/* ── 任务中心自动更新（2026-11-04） ────────────────────────
 * 对话流里有 delegate / attention 时优先做增量（SSE）；
 * 看板单独开着、没有流时用低频轮询兜底（看板 20s / 对话页徽标 60s）。
 * 自动刷新详情页只更新内存与徽标，不重绘 DOM，滚动位置和展开状态不受影响。 */

let tasksRenderFrame = 0;
let ticketsSyncTimer = 0;

function scheduleTasksRender() {
  if (tasksRenderFrame) return;
  tasksRenderFrame = requestAnimationFrame(() => {
    tasksRenderFrame = 0;
    if (currentRoute() === "tasks" && !currentTicketId()) renderBoard();
  });
}

/** SSE 只给了事件字段；稍后再静默拉一次列表，用落盘的真实数据补齐摘要/进度 */
function scheduleTicketsSync(delay = 900) {
  clearTimeout(ticketsSyncTimer);
  ticketsSyncTimer = setTimeout(() => {
    ticketsSyncTimer = 0;
    void loadTickets({ silent: true, force: true, render: !currentTicketId() });
  }, delay);
}

function applyTicketEvent(event) {
  const ticketId = event.ticketId;
  if (!ticketId) return;
  const status = PHASE_STATUS[event.phase];
  if (!status) return;
  const now = new Date().toISOString();
  let ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) {
    // 新单：先放一张临时单，紧接着的一次静默刷新会补上完整字段。
    // 事件帧不带 conversationId（L3），所以它这一刻可能暂时落在「更早的直派」里，
    // 刷新回来后按真实 conversationId 归到对应对话卡——不为此另开一条猜测逻辑。
    ticket = {
      id: ticketId,
      prompt: event.message || "刚派出去的任务单",
      status,
      domain: event.domain || null,
      project: event.project || null,
      total: 0,
      passed: 0,
      employee: null,
      updated_at: now,
      error: null,
      parentTicketId: null,
      conversationId: event.conversationId || null,
    };
    state.tickets.unshift(ticket);
  }
  ticket.status = status;
  if (Number.isFinite(event.done)) ticket.passed = event.done;
  if (Number.isFinite(event.total)) ticket.total = event.total;
  if (event.domain) ticket.domain = event.domain;
  if (event.project) ticket.project = event.project;
  if (event.lastAction) ticket.lastAction = event.lastAction;
  if (event.lastHeartbeat) ticket.lastHeartbeat = event.lastHeartbeat;
  if (event.waitingOn) ticket.waitingOn = event.waitingOn;
  if (event.conversationId) ticket.conversationId = event.conversationId;
  ticket.updated_at = event.lastHeartbeat || now;
  // L3：子单/父单事件 → 它所属的那张对话卡。灯、计数、卡头时间都是渲染时从列表现算的，
  // 所以整板重绘会连同那张卡一起更新（不写回任何单的状态）。
  // 找不到父单（列表被 limit 截断 / 还没拉回来）时提前补一次列表，别让聚合值长期停在旧值。
  const ownerMissing =
    Boolean(ticket.parentTicketId) &&
    !state.tickets.some((item) => item.id === ticket.parentTicketId);
  syncTasksBadge();
  scheduleTasksRender();
  scheduleTicketsSync(ownerMissing ? 400 : 900);
}

function autoSyncTick() {
  if (document.hidden || state.ticketsLoading) return;
  const route = currentRoute();
  if (route === "settings") return;
  // 正在对话且 SSE 在流：delegate / attention 会增量更新，不叠加请求
  if (state.sending && route === "chat") return;
  const gap = route === "tasks" ? TASKS_POLL_MS : BADGE_POLL_MS;
  if (state.ticketsFetchedAt && Date.now() - state.ticketsFetchedAt < gap) return;
  void loadTickets({
    silent: true,
    force: true,
    render: route === "tasks" && !currentTicketId(),
  });
  // E4：花名册的 activeTickets 来自 domains（派生自任务单），低频一并刷新
  void loadRoster();
}

/* 侧栏分区头的入口（2026-11-07 统一批）：
   任务中心 —— 「打开任务中心 →」进看板；轨道按钮同。
   项目 —— ＋ 添加子项目；「管理项目 → 设置」进设置页。
   会话 —— ＋ 已在上面的 applySections 段注册（新建一轮）。 */
el.secTasksAll?.addEventListener("click", () => go("tasks"));
// 项目 ＋（2026-11-07 四改）：两个入口——新建项目 / 添加已有子项目
el.secProjectsAdd?.addEventListener("click", () => openProjectAddMenu());
el.secProjectsManage?.addEventListener("click", () => go("settings", "projects"));

/* 任务中心的固定入口与交互（只读，不提供改派/停止） */
el.railTasks.addEventListener("click", () => go("tasks"));
el.tasksBack.addEventListener("click", () => go("tasks"));
el.tasksRefresh.addEventListener("click", () => {
  const ticketId = currentTicketId();
  if (ticketId) {
    void showTicketDetail(ticketId);
    return;
  }
  void loadTickets({ force: true });
  void loadProjects({ force: true });
});
el.tasksDomain.addEventListener("change", () => {
  state.domainFilter = el.tasksDomain.value;
  writeTasksHash("");
  renderBoard();
});
el.tasksProject.addEventListener("change", () => {
  state.projectFilter = el.tasksProject.value;
  writeTasksHash("");
  renderBoard();
});
el.tasksSort.addEventListener("change", () => {
  state.sort = el.tasksSort.value === "status" ? "status" : "recent";
  writeTasksHash("");
  renderBoard();
});
/**
 * 任务中心的点击代理（L3）：看板、已完结区、直派折叠组都在 tasksBody 里，一处接管。
 * - .tk-conv-head / .tk-arch-conv（卡头、已完结简卡）→ 回原对话（复用搜索结果的跳转写法：先切路由，再 openChat）
 * - .tk-children-toggle → 就地展开/收起那一行的子单，展开态记 state.tasksChildrenOpen
 * - .tk-row / .tk-arch-row → 打开该单详情
 * 子单行是 <a>，自己的 href 会导航；派活行是 div[role=button]，键盘行为在下面补。
 */
el.tasksBody.addEventListener("click", (event) => {
  // 取消/重试按钮（扫尾批 1 A1）：行根是 div[role=button]，按钮必须先拦下，
  // 否则一点就顺带跳进详情页。真实 <button> 自带键盘语义，不用再补 keydown。
  const actionButton = event.target.closest("[data-ticket-action]");
  if (actionButton) {
    event.stopPropagation();
    const ticketId = actionButton.dataset.ticket || "";
    const action = actionButton.dataset.ticketAction;
    if (!ticketId) return;
    if (action === "cancel") confirmCancelTicket(ticketId);
    else if (action === "retry") void performTicketAction(ticketId, "retry");
    return;
  }

  const head = event.target.closest(".tk-conv-head, .tk-arch-conv");
  if (head) {
    const conversationId = head.dataset.conv || "";
    if (conversationId) void openConversation(conversationId);
    return;
  }

  const toggle = event.target.closest(".tk-children-toggle");
  if (toggle) {
    const ticketId = toggle.dataset.ticket || "";
    if (!ticketId) return;
    const open = !state.tasksChildrenOpen.has(ticketId);
    if (open) state.tasksChildrenOpen.add(ticketId);
    else state.tasksChildrenOpen.delete(ticketId);
    toggle.setAttribute("aria-expanded", String(open));
    const row = toggle.closest(".tk-row");
    const list = row ? row.querySelector(".tk-children") : null;
    if (list) list.hidden = !open;
    return;
  }

  // 子单行自己导航到子单详情，不能再落回派活行
  if (event.target.closest(".tk-child-row")) return;

  const row = event.target.closest(".tk-row, .tk-arch-row");
  if (!row || !row.dataset.ticket) return;
  location.hash = tasksHash({ ticket: row.dataset.ticket });
});
// div[role=button] 的键盘等价行为：Enter / 空格进详情（行内按钮自己处理事件）
el.tasksBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest(".tk-row");
  if (!row || event.target !== row || !row.dataset.ticket) return;
  event.preventDefault();
  location.hash = tasksHash({ ticket: row.dataset.ticket });
});

/** 外部打手小卡：点一下过滤主视图，再点一下取消（只改会话内存，不写 hash） */
el.tasksHitters.addEventListener("click", (event) => {
  const card = event.target.closest(".tk-hitter");
  if (!card) return;
  const employee = card.dataset.employee || "";
  state.tasksEmployeeFilter = state.tasksEmployeeFilter === employee ? "" : employee;
  renderBoard();
});

/* ── 领域概览（E2 #3）───────────────────────────────────────
 * 侧栏「领域负责人」占位点亮为 #/domains。只读：GET /api/v1/domains。
 * 每行 领域 · 活跃单数(activeTickets) · 状态；error 行标红并给出错误文案；
 * 行点击跳 #/tasks?domain=<domain>（任务中心已有 domain 筛选）。 */

function showDomainsState(kind, title, text, action) {
  el.domainsState.hidden = false;
  el.domainsState.dataset.kind = kind;
  el.domainsState.replaceChildren();
  const icon = document.createElement("div");
  icon.className = "tasks-state-icon";
  icon.innerHTML = STATE_ICON[kind] || STATE_ICON.empty;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = text;
  el.domainsState.append(icon, heading, body);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    el.domainsState.append(button);
  }
  el.domainsBody.hidden = true;
}

function hideDomainsState() {
  el.domainsState.hidden = true;
  el.domainsBody.hidden = false;
}

function renderDomains(rows) {
  el.domainsTitleSub.textContent = rows.length ? `${rows.length} 个领域` : "";
  if (!rows.length) {
    showDomainsState("empty", "还没有领域", "派活给某个领域后，这里会列出各领域的活跃单数与状态。");
    return;
  }
  hideDomainsState();
  const card = document.createElement("div");
  card.className = "card td-dom-list";
  card.innerHTML = rows
    .map((row, index) => {
      const domain = String(row.domain || "").trim();
      const error = String(row.error || "").trim();
      const active = Number(row.activeTickets) || 0;
      return `${index ? '<div class="divider"></div>' : ""}
        <div class="row td-dom-row" data-domain="${esc(domain)}"${error ? ' data-tone="fail"' : ""}
             role="link" tabindex="0" title="看「${esc(domain)}」的任务单">
          <div class="row-main">
            <div class="row-label">${esc(domain || "未命名领域")}</div>
            <div class="row-hint">${error ? esc(error) : `活跃 ${active} 单`}</div>
          </div>
          <div class="row-control">
            <span class="kv">活跃 ${active}</span>
            <span class="pill-tag ${error ? "warn" : "ok"}">${error ? "异常" : "正常"}</span>
          </div>
        </div>`;
    })
    .join("");
  el.domainsBody.replaceChildren(card);
}

async function loadDomains() {
  showDomainsState("loading", "读取中…", "正在读取领域清单");
  try {
    const response = await request("/api/v1/domains", { cache: "no-store" });
    if (!response.ok) throw statusError(response.status);
    const data = await response.json();
    renderDomains(Array.isArray(data.domains) ? data.domains : []);
  } catch (error) {
    // 照「当前项目 pill」的降级先例：读不到不白屏、不把错误吞掉，给一句说明 + 手动重试。
    showDomainsState(
      "error",
      "领域清单读不出来",
      `服务可能还没就绪，或接口暂时不可达（${error.message || ""}）。`,
      { label: "重试", run: () => void loadDomains() },
    );
  }
}

function openDomains() {
  void loadDomains();
}

el.domainsBack.addEventListener("click", () => go("chat"));
el.domainsRefresh.addEventListener("click", () => void loadDomains());
el.domainsBody.addEventListener("click", (event) => {
  const row = event.target.closest(".td-dom-row");
  if (!row || !row.dataset.domain) return;
  // 直接落 #/tasks?domain=<domain>：openTasks 会从 hash 恢复筛选，衔接任务中心既有 domain 筛选。
  location.hash = `#/tasks?domain=${encodeURIComponent(row.dataset.domain)}`;
});
el.domainsBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest(".td-dom-row");
  if (!row || !row.dataset.domain) return;
  event.preventDefault();
  location.hash = `#/tasks?domain=${encodeURIComponent(row.dataset.domain)}`;
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autoSyncTick();
});

/* ── 令牌 ─────────────────────────────────────────────── */

// 壳会把令牌带在 URL 上（?token=），读一次就存起来并从地址栏抹掉。
function readToken() {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const fromUrl = url.searchParams.get("token") || hash.get("token");
  if (fromUrl) {
    localStorage.setItem(KEY_TOKEN, fromUrl);
    url.searchParams.delete("token");
    url.hash = "";
    history.replaceState(null, "", url.toString());
    return fromUrl;
  }
  return localStorage.getItem(KEY_TOKEN) || "";
}

function showGate(message) {
  setStatus("waiting", "需要令牌");
  if (message) {
    el.gateErr.textContent = message;
    el.gateErr.hidden = false;
  }
  if (!el.gate.hidden) return;
  el.gate.hidden = false;
  el.gateInput.value = "";
  el.gateInput.focus();
}

// 页面已经开着的时候再补一个 #token= 只是改 hash，不会重新加载模块。
// 监听一次，别让人以为"贴了没反应"。
window.addEventListener("hashchange", () => {
  // go() 自己写 hash 时已经同步推进过世代；其余 hashchange（后退/前进/手改）都要推进。
  if (state.selfNavHash && state.selfNavHash === location.hash) {
    state.selfNavHash = "";
  } else {
    state.selfNavHash = "";
    noteRouteChange();
  }
  const next = readToken();
  if (next && next !== state.token) {
    state.token = next;
    void checkHealth();
    void loadChats();
    if (state.conversationId) void openChat(state.conversationId);
  }
  applyRoute();
  // 设置页可能刚改过工作区/项目，回到对话页顺带把侧栏项目区补齐
  if (currentRoute() === "chat") void refreshProjectPill();
});

el.gateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = el.gateInput.value.trim();
  if (!value) return;
  state.token = value;
  localStorage.setItem(KEY_TOKEN, value);
  el.gate.hidden = true;
  el.gateErr.hidden = true;
  checkHealth();
  void loadChats();
  void refreshProjectPill();
  if (state.conversationId) void openChat(state.conversationId);
});

/* ── 网络 ─────────────────────────────────────────────── */

function authHeaders(extra) {
  const headers = { ...(extra || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return headers;
}

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: authHeaders({
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    }),
  });
  if (response.status === 403) {
    // 手里根本没有令牌，和「令牌被拒」是两件事，别混成同一句话。
    showGate(state.token ? "这个令牌没被接受。" : "");
    throw new Error("forbidden");
  }
  return response;
}

/* ── 状态灯 ───────────────────────────────────────────── */

/** 侧栏展开态的状态行与收起轨道的小圆点共用同一份状态 */
function setStatus(stateName, text) {
  el.status.dataset.state = stateName;
  el.statusText.textContent = text;
  el.railStatus.dataset.state = stateName;
}

async function checkHealth() {
  // 用户自己停的（2026-11-07）：别再每 8 秒把状态灯刷成"服务离线"并弹错误，
  // 那是我们的操作结果，不是故障。启动/刷新后 body 上没有这个标记，自然恢复轮询。
  if (document.body.dataset.runtime === "stopped") return false;
  try {
    const response = await request("/healthz", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const info = await response.json();
    state.serviceOk = true;
    // 门开着的时候别把状态灯改回"在线"——那会跟"需要令牌"自相矛盾。
    if (el.gate.hidden) {
      setStatus("ok", info.llm === "mock" ? "服务在线 · mock" : "服务在线");
    }
    syncPartnerDots();
    return true;
  } catch (error) {
    if (error.message !== "forbidden") {
      state.serviceOk = false;
      setStatus("off", "服务离线");
      syncPartnerDots();
    }
    return false;
  }
}

/* ── 会话列表 ─────────────────────────────────────────── */

// E4：侧栏「最近会话」折叠块只列前 5 条，其余去设置→会话搜索（#/settings/sessions）。
const RECENTS_LIMIT = 5;

async function loadChats() {
  try {
    const response = await request("/api/v1/agent/chats?limit=50", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    state.chats = data.chats || [];
    state.removed = data.removed || 0;
    renderChats();
  } catch {
    /* 离线时保持旧列表 */
  }
}

function chatLabel(chat) {
  return chat.title || chat.firstText || "（无标题）";
}

function renderChats() {
  el.chats.replaceChildren();
  const visible = state.chats;
  // 置顶的排前面（2026-11-04 批次一），段内保持原有顺序（旧→新）；标记走标题前缀，不另起分组栏
  // partner- 前缀（执事专线 / 群成员会话，2026-11-06 群组方案 §2.2）不进最近会话：
  // 执事的对话从花名册进，群从群组节进——这里漏过滤会把执事会话当主人会话摆出来（实测踩过）。
  //
  // 总管会话（chatKind=chief）也不进这张列表（2026-11-07 用户拍板）：
  // 「主会话就不要了，总管跟主会话是一个效果，把它从界面上删掉」。
  // 总管会话仍是真会话、仍能从顶部「总管」条目打开（openChiefChat 读的是 state.chats
  // 全量，不受这条过滤影响），只是不再作为一条「管不了也删不掉」的行混在最近会话里。
  const ordered = [...visible]
    .filter((chat) => !String(chat.conversationId || "").startsWith("partner-"))
    .filter((chat) => (chat.chatKind || "chief") !== "chief")
    .reverse()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  // 空态（2026-11-07 四改）：会话与任务合并成一块后，空态也只说一句。
  // 这里先不放占位，等任务行也渲染完，由 renderSideListEmpty() 统一判——
  // 否则「没有会话」和「没有在跑的活」会同时出现两行。

  // 只展示前 RECENTS_LIMIT 条；更多的在设置→会话里搜（#/settings/chats）。
  for (const chat of ordered.slice(0, RECENTS_LIMIT)) {
    const row = document.createElement("div");
    row.className = "chat";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = `${chatLabel(chat)} · ${chat.turns} 轮${chat.pinned ? " · 已置顶" : ""}`;
    row.dataset.conv = chat.conversationId;
    // 选中态只在对话路由里成立（2026-11-07 修）：进了群聊 / 任务页 / 设置页，
    // 这条会话仍是「上次打开的那条」，但屏幕上已经不是它了——继续亮着会把人的
    // 位置感带错（截图里群列表旁边还亮着一条会话，看着像同时在两处）。
    if (chat.conversationId === state.conversationId && currentRoute() === "chat") {
      row.setAttribute("aria-current", "true");
    }

    const label = document.createElement("span");
    label.className = "chat-title";
    label.textContent = `${chat.pinned ? "★ " : ""}${chatLabel(chat)}`;
    row.append(label);

    // 悬停才出现：置顶 / 重命名 / 从列表移除。不做下拉菜单，三个图标够了。
    const actions = document.createElement("span");
    actions.className = "chat-actions";

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "chat-act";
    pin.textContent = "★";
    pin.title = chat.pinned ? "取消置顶" : "置顶";
    pin.addEventListener("click", async (event) => {
      event.stopPropagation();
      await request(
        `/api/v1/agent/chat/${encodeURIComponent(chat.conversationId)}/pin`,
        { method: "POST", body: JSON.stringify({ pinned: !chat.pinned }) },
      ).catch(() => undefined);
      await loadChats();
    });

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "chat-act";
    rename.textContent = "✎";
    rename.title = "重命名";
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      startRename(row, chat);
    });

    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "chat-act";
    hide.textContent = "✕";
    hide.title = "从列表移除（会话还在）";
    hide.addEventListener("click", async (event) => {
      event.stopPropagation();
      await request(
        `/api/v1/agent/chat/${encodeURIComponent(chat.conversationId)}/hide`,
        { method: "POST" },
      ).catch(() => undefined);
      if (chat.conversationId === state.conversationId) startNewChat();
      await loadChats();
    });

    actions.append(rename, hide, pin);
    row.append(actions);

    // 点会话行 = 进这条对话。2026-11-07 修：以前只 openChat、不切路由，
    // 从群聊 / 任务 / 设置页点过来时内容在背后换了、屏幕还停在原页（用户报的
    // 「点了群聊之后点对话，界面切换不了」）。统一走 openConversation()，
    // 与搜索结果、任务卡头、通知点击同一份"先切路由再回读"的口径。
    row.addEventListener("click", () => void openConversation(chat.conversationId));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openConversation(chat.conversationId);
      }
    });
    el.chats.append(row);
  }
  renderSideListEmpty();
}

/** 就地改名：回车存、Esc 取消、失焦也存 */
function startRename(row, chat) {
  const input = document.createElement("input");
  input.className = "chat-rename";
  input.value = chat.title || chat.firstText || "";
  row.replaceChildren(input);
  input.focus();
  input.select();

  const commit = async (save) => {
    if (!input.isConnected) return;
    const value = input.value.trim();
    input.remove();
    if (save) {
      await request(
        `/api/v1/agent/chat/${encodeURIComponent(chat.conversationId)}/rename`,
        { method: "POST", body: JSON.stringify({ title: value }) },
      ).catch(() => undefined);
      if (chat.conversationId === state.conversationId) {
        el.title.textContent = value || "新对话";
      }
    }
    void loadChats();
  };

  input.addEventListener("keydown", (event) => {
    // 按键不能冒泡到会话行：行的 Enter 处理是 openChat，会把刚改的标题又覆盖回首条消息
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commit(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      void commit(false);
    }
  });
  input.addEventListener("blur", () => void commit(true));
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

/* 折叠（2026-11-07 四改，用户口径「箭头别要了，点击这个框相当于收起或展开」）：
   整行分区头就是那个把手，行尾只留一个 ＋。 */
for (const sec of SIDE_SECTIONS) {
  document.getElementById(`sec-${sec}-toggle`)?.addEventListener("click", () => toggleSection(sec));
}

/* 会话区的 ＋（2026-11-07）：顶部「新建对话」退役后，这里是唯一的新建入口。
   与旧按钮同语义：新开一条普通 worker 会话。 */
el.secChatsAdd?.addEventListener("click", () => {
  go("chat");
  startNewChat("worker");
});

/* ── 头像（2026-11-06 C 批）────────────────────────────
 * 只存有界 PNG data URL（服务端同样复核）。渲染一律用 DOM 属性赋 src，
 * 不把不可信字符串拼进 innerHTML；未设置时回落名字首字。 */

const AVATAR_PREFIX = "data:image/png;base64,";
const AVATAR_MAX_CHARS = 180000;
const AVATAR_MAX_BYTES = 128 * 1024;
const AVATAR_MAX_DIM = 256;
const AVATAR_INPUT_LIMIT = 5 * 1024 * 1024;

function avatarText(name) {
  return String(name || "?").trim().slice(0, 1) || "?";
}

/** 把头像写进容器（button / span）：有图用 img，没图用首字 */
function paintAvatar(host, avatar, name) {
  if (!host) return;
  if (avatar) {
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.setAttribute("aria-hidden", "true");
    img.src = avatar; // 属性赋值，不拼 HTML
    host.replaceChildren(img);
  } else {
    host.textContent = avatarText(name);
  }
}

/** 头像 data URL 是否超出契约；合法返回 null（客户端先自查，服务端仍会复核） */
function avatarDataProblem(dataUrl) {
  if (!dataUrl.startsWith(AVATAR_PREFIX)) return "头像只接受 PNG";
  if (dataUrl.length > AVATAR_MAX_CHARS) return "头像太大，换一张更简单的图片";
  const b64 = dataUrl.slice(AVATAR_PREFIX.length);
  if (!b64 || b64.length % 4 !== 0) return "头像数据不完整";
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = (b64.length / 4) * 3 - padding;
  if (bytes > AVATAR_MAX_BYTES) return "处理后的图片超过 128KiB，换一张更简单的图片";
  return null;
}

/**
 * 本地图片 → 有界 PNG data URL：先解码（坏图在这里就失败），再按最长边 ≤256 画到 canvas。
 * 相片打成 256px PNG 仍可能超过 128KiB，此时依次退到 192 / 128，保证能存进去又不超上限。
 * 不读文件名、不上传原图，页面上也只用 <img> 解码渲染。
 */
async function fileToAvatarPng(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("只支持 PNG / JPEG / WebP 图片");
  }
  if (file.size > AVATAR_INPUT_LIMIT) {
    throw new Error("图片超过 5MiB，换一张小一点的");
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    if (typeof img.decode === "function") {
      try {
        await img.decode();
      } catch {
        throw new Error("这张图片读不出来（可能已损坏）");
      }
    } else {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("这张图片读不出来（可能已损坏）"));
      });
    }
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("这张图片没有可用的画面");

    let last = "";
    for (const max of [AVATAR_MAX_DIM, 192, 128]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器画不了图，换个浏览器再试");
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/png");
      last = avatarDataProblem(dataUrl) || "";
      if (!last) return dataUrl;
    }
    throw new Error(last || "这张图片不能用作头像");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* 在线点 = 服务连通 && 伙伴 active（2026-11-06 C 批）：
   active 且服务在线 → 绿；active 但服务失联 → 黄；暂停 / 归档 → 灰。
   忙碌只走既有的单数 / 文案，不再参与在线色；state.sending 不再决定总管是否在线。 */
function partnerDotClass(status) {
  if (status === "active") return state.serviceOk ? "ok" : "warn";
  return "idle";
}

function syncChiefDot() {
  if (!el.chiefDot) return;
  el.chiefDot.className = `status-dot ${partnerDotClass(state.chiefStatus || "active")}`;
}

/** 服务状态变化时就地改点，不重绘整份花名册（不打断 hover / 焦点） */
function syncPartnerDots() {
  syncChiefDot();
  for (const row of document.querySelectorAll("#partner-roster [data-partner-id]")) {
    const partner = state.partners.find((item) => item.id === row.dataset.partnerId);
    const dot = row.querySelector(".status-dot");
    if (partner && dot) dot.className = `status-dot ${partnerDotClass(partner.status)}`;
  }
  for (const dot of document.querySelectorAll("[data-pt-dot]")) {
    const partner = state.partners.find((item) => item.id === dot.dataset.ptDot);
    if (partner) dot.className = `status-dot ${partnerDotClass(partner.status)}`;
  }
}

/** 总管头像 / 名字 / 状态同步到展开条目与收起轨道 */
function syncChiefAvatar() {
  const chief = state.partners.find((item) => item.id === "chief");
  const name = String(chief?.name || "总管").trim() || "总管";
  state.chiefStatus = chief?.status || "active";
  const avatar = chief?.avatar || null;
  if (el.chiefAvatar) {
    paintAvatar(el.chiefAvatar, avatar, name);
    el.chiefAvatar.setAttribute("aria-label", `编辑${name}头像`);
    el.chiefAvatar.title = `编辑${name}头像`;
  }
  const railSlot = el.railChief?.querySelector(".pt-avatar");
  if (railSlot) paintAvatar(railSlot, avatar, name);
  syncChiefDot();
}

/** 执事会话表头用名字，不叫“新对话” */
function partnerDisplayName(partnerId) {
  const partner = state.partners.find((item) => item.id === partnerId);
  return String(partner?.name || "执事").trim() || "执事";
}

/**
 * 总管固定条目 = 打开总管主对话。
 * 实现取方案 A 的 a：总管条目点击 = 打开最近一条「总管」会话，没有就新开一轮。
 * 行为不变：仍走既有 go("chat") + openChat / startNewChat 流程，历史列表仍能恢复。
 * 这里排除 partner-* 的执事 canonical 会话，避免把执事会话当成总管主对话。
 */
function openChiefChat() {
  // 只认 chatKind=chief 的历史（缺字段的旧会话按 chief，保住老数据）；
  // 不靠 partner- 前缀之外的东西猜身份。没有就新开一条总管会话。
  const ordered = state.chats
    .filter((chat) => !String(chat.conversationId || "").startsWith("partner-"))
    .filter((chat) => (chat.chatKind || "chief") === "chief")
    .reverse()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const recent = ordered[0];
  go("chat");
  if (recent) void openChat(recent.conversationId);
  else startNewChat("chief");
}

el.chiefEntry.addEventListener("click", openChiefChat);
el.chiefEntry.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openChiefChat();
  }
});

// 头像单独是按钮：点它进编辑，不打开会话；键盘事件也不再冒泡到行
el.chiefAvatar?.addEventListener("click", (event) => {
  event.stopPropagation();
  void openEditPartnerModal("chief");
});
for (const type of ["keydown", "keyup"]) {
  el.chiefAvatar?.addEventListener(type, (event) => event.stopPropagation());
}

/* 执事花名册：GET /api/v1/partners（过滤 chief + archived）
   + GET /api/v1/domains（domain → activeTickets）。两个端点各自容错，
   一个读不到不拖累另一个；403 交给令牌门，不把花名册刷成空。 */
async function loadRoster() {
  const box = el.partnerRoster;
  if (!box) return;
  let partners = null;
  let domains = [];
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (response.ok) partners = (await response.json().catch(() => ({}))).partners || [];
  } catch (error) {
    if (error.message === "forbidden") return;
  }
  try {
    const response = await request("/api/v1/domains", { cache: "no-store" });
    if (response.ok) domains = (await response.json().catch(() => ({}))).domains || [];
  } catch (error) {
    if (error.message === "forbidden") return;
  }
  // 拉失败保留上一次的档案（头像 / 名字不闪没）
  if (Array.isArray(partners)) state.partners = partners;
  renderRoster(
    Array.isArray(partners) ? partners : state.partners,
    Array.isArray(domains) ? domains : [],
  );
  syncChiefAvatar();
  syncPartnerDots();
  // 名册晚于会话加载时，把执事专线的表头补成名字（之前只有占位「执事」）
  if (state.conversationId.startsWith("partner-") && currentRoute() === "chat") {
    el.title.textContent = partnerDisplayName(state.conversationId.slice("partner-".length));
  }
}

function renderRoster(partners, domainRows) {
  const box = el.partnerRoster;
  box.replaceChildren();

  const activeByDomain = new Map();
  for (const row of domainRows) {
    const key = String(row.domain || "").trim();
    if (key) activeByDomain.set(key, Number(row.activeTickets) || 0);
  }

  // 数据源返回全部（含 chief）；过滤掉 chief 与已归档的
  const roster = partners.filter(
    (partner) => partner && partner.id !== "chief" && partner.status !== "archived",
  );

  if (!roster.length) {
    const hint = document.createElement("div");
    hint.className = "roster-empty";
    hint.textContent = "还没有执事。让总管建一个，或在设置→执事里新建。";
    box.append(hint);
    return;
  }

  for (const partner of roster) {
    const id = String(partner.id || "");
    const name = String(partner.name || "执事").trim() || "执事";
    const domain = String(partner.domain || "").trim();
    const active = domain ? activeByDomain.get(domain) || 0 : 0;

    const row = document.createElement("div");
    row.className = "side-item roster-row";
    row.dataset.partnerId = id;
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.title = `${name}${domain ? " · " + domain : ""}`;

    const dot = document.createElement("i");
    dot.className = `status-dot ${partnerDotClass(partner.status)}`;
    dot.setAttribute("aria-hidden", "true");

    // 头像：有图用 img，没图用名字首字；点它进编辑，不打开会话
    const avatar = document.createElement("button");
    avatar.type = "button";
    avatar.className = "pt-avatar avatar-edit";
    avatar.title = "编辑头像";
    avatar.setAttribute("aria-label", `编辑${name}的头像`);
    paintAvatar(avatar, partner.avatar || null, name);
    avatar.addEventListener("click", (event) => {
      event.stopPropagation();
      void openEditPartnerModal(id);
    });
    avatar.addEventListener("keydown", (event) => event.stopPropagation());
    avatar.addEventListener("keyup", (event) => event.stopPropagation());

    const label = document.createElement("span");
    label.className = "roster-name";
    label.textContent = name;

    row.append(avatar, label);

    if (domain) {
      const tag = document.createElement("span");
      tag.className = "pill-tag roster-domain";
      tag.textContent = domain;
      row.append(tag);

      // 派发权拨杆（2026-11-06 执事派发权开关）：亮 = 有权接单；关 = 派单等同无分管领域。
      const dispatch = document.createElement("button");
      dispatch.type = "button";
      dispatch.className = `pill-tag roster-dispatch${partner.dispatchAuthority ? " on" : " off"}`;
      dispatch.textContent = partner.dispatchAuthority ? "派·开" : "派·关";
      dispatch.title = partner.dispatchAuthority
        ? "派发权：开（点击关闭）"
        : "派发权已关：派单不经过该执事（点击打开）";
      dispatch.setAttribute("aria-label", `${name}的派发权开关`);
      dispatch.addEventListener("click", async (event) => {
        event.stopPropagation();
        const next = !partner.dispatchAuthority;
        dispatch.disabled = true;
        try {
          const response = await request(`/api/v1/partners/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dispatchAuthority: next }),
          });
          if (response.ok) {
            partner.dispatchAuthority = next;
            renderRoster(state.partners, domainRows);
            return;
          }
        } catch { /* 落到下面的提示 */ }
        dispatch.disabled = false;
        dispatch.title = "切换失败，稍后再试";
      });
      row.append(dispatch);
    }

    if (active > 0) {
      // 数字可点 → 任务中心按 domain 筛选（.side-count 与任务中心徽章同款）
      const count = document.createElement("button");
      count.type = "button";
      count.className = "side-count roster-count";
      count.textContent = `${active} 单`;
      count.title = `看「${domain}」的任务单`;
      count.addEventListener("click", (event) => {
        event.stopPropagation();
        location.hash = `#/tasks?domain=${encodeURIComponent(domain)}`;
      });
      row.append(count);
    } else {
      const idle = document.createElement("span");
      idle.className = "roster-idle";
      idle.textContent = "空闲";
      row.append(idle);
    }

    // 状态点固定在最右；本批只调位置，不改 active/archived 的状态来源
    row.append(dot);

    const open = () => void openPartnerChat(id);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    box.append(row);
  }
}

/**
 * 行点击 = 打开该执事的 canonical 对话。
 *
 * 2026-11-06 C 批：先 POST /api/v1/partners/:id/open（服务端负责 ensurePartnerSession
 * + 首次问候的持久去重），返回后再 openChat 回读。前端不再自己判断「有没有历史」，
 * 否则第一次点永远没有入口。护栏：
 *  - 同一个执事的 open 在飞时直接吞掉重复点击；
 *  - 每次导航有令牌，快速切到别的会话 / 执事后旧响应直接作废；
 *  - 失败给「重试 / 继续现有空会话」两个动作，不只 toast。
 *
 * 404 拆义（2026-11-06 返修，实测踩过）：open 的 404 有两种含义——
 *  a) 服务进程比页面旧，还没有 /open 路由（Hono 对未知路由一律 404）；
 *  b) 执事档案真被删了（花名册残留的幽灵行）。
 * 两种都报「执事不存在」是谎报。用 GET /api/v1/partners/:id 复核一次：
 *  200 = 服务旧 → 说清楚要重启服务，可重试；404 = 真没了 → 刷花名册让这行消失。
 */
async function openPartnerChat(partnerId) {
  if (!partnerId || state.partnerOpening.has(partnerId)) return;
  state.partnerOpening.add(partnerId);
  const token = ++state.navToken;
  const startHash = location.hash;
  const startGen = state.routeGen;
  // 离开再回到同一 hash 也算离开：routeGen 比 hash 字符串更可信。
  const stillHere = () =>
    token === state.navToken && state.routeGen === startGen && location.hash === startHash;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/open`, {
      method: "POST",
    });
    if (response.status === 404) {
      if (!stillHere()) return;
      // 复核档案还在不在，两种 404 分开说、分开处置
      const verdict = await partnerExistsAfter404(partnerId);
      if (verdict === "gone") {
        // 真被删了：列表里那行是幽灵，刷掉并明说，不报「点开失败」
        void loadRoster();
        toast("这个执事已删除，列表已刷新");
      } else {
        showPartnerOpenFailureCard(
          partnerId,
          verdict === "stale-server"
            ? "服务还是旧版本，先重启服务（托盘右键退出后重开）再点。"
            : "执事状态读不到，稍后再试。",
          stillHere,
        );
      }
      return;
    }
    if (response.status === 409) {
      // 409 = 服务端说暂停/归档：列表可能还在显示旧状态，静默刷一次对齐
      void loadRoster();
      if (stillHere()) toast("这个执事已暂停或归档，先恢复再打开");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      await showPartnerOpenFailure(
        partnerId,
        data.message || data.error || `打开失败（HTTP ${response.status}）`,
        stillHere,
      );
      return;
    }
    if (!stillHere()) return; // 用户已经切走，旧响应不得抢回
    // 只认服务端返回的 canonical id；缺字段说明契约不完整，不拿 partner-<id> 猜。
    const convId = String(data.conversationId || "");
    if (!convId) {
      await showPartnerOpenFailure(partnerId, "服务端返回不完整，稍后再试", stillHere);
      return;
    }
    go("chat");
    await openChat(convId);
  } catch (error) {
    if (error.message !== "forbidden" && stillHere()) {
      await showPartnerOpenFailure(partnerId, `打不开执事会话：${error.message}`, stillHere);
    }
  } finally {
    state.partnerOpening.delete(partnerId);
  }
}

/**
 * open 404 后复核档案：GET /api/v1/partners/:id。
 * 200 = 档案在（服务版本旧，缺 /open 路由）；404 = 档案真没了；其他 = 读不到，无法判定。
 */
async function partnerExistsAfter404(partnerId) {
  try {
    const probe = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
      cache: "no-store",
    });
    if (probe.ok) return "stale-server";
    if (probe.status === 404) return "gone";
    return "unknown";
  } catch (error) {
    return error.message === "forbidden" ? "forbidden" : "unknown";
  }
}

/**
 * open 失败且只适合给一张可重试卡（不切会话、不动花名册）的轻量入口：
 * 典型是 404 拆义出的「服务旧」——重试大概率还是 404，卡比 toast 留得住。
 * 与 showPartnerOpenFailure 的差别：这里不做 canonical 探测，也不切路由。
 */
function showPartnerOpenFailureCard(partnerId, message, stillHere) {
  if (!stillHere()) return;
  const name = partnerDisplayName(partnerId);
  const wrap = document.createElement("div");
  wrap.className = "msg error partner-open-error";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = `打开${name}失败：${message}`;
  wrap.append(body);
  const actions = document.createElement("div");
  actions.className = "partner-open-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry-btn";
  retry.textContent = "重试";
  retry.title = "重新请求打开执事";
  retry.addEventListener("click", () => {
    wrap.remove();
    void openPartnerChat(partnerId);
  });
  actions.append(retry);
  wrap.append(actions);
  el.thread.append(wrap);
  updateHomeMode();
  if (state.stick) scrollToEnd();
}

/** 只读探测 canonical 会话是否已由服务端确认存在（响应必须带同一个 conversationId） */
async function partnerConversationExists(partnerId) {
  const convId = partnerConversationId(partnerId);
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(convId)}/messages?limit=1`,
      { cache: "no-store" },
    );
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data && data.conversationId === convId);
  } catch {
    return false;
  }
}

function partnerConversationId(partnerId) {
  return `partner-${partnerId}`;
}

/** openChat 的结果只有在“仍是最后一次导航 + 仍是这条会话 + 仍在对话路由”时才算归属本次 */
function ownsChatResult(result, conversationId) {
  return Boolean(result) &&
    result.token === state.navToken &&
    result.conversationId === conversationId &&
    state.conversationId === conversationId &&
    currentRoute() === "chat";
}

/** 只打开已确认存在的 canonical；探测失败就不制造伪执事页面 */
async function openConfirmedPartnerCanonical(partnerId) {
  const convId = partnerConversationId(partnerId);
  if (!(await partnerConversationExists(partnerId))) return { ok: false, reason: "missing" };
  go("chat");
  const result = await openChat(convId);
  if (!ownsChatResult(result, convId)) {
    return { ok: false, reason: result?.status === "missing" ? "missing" : "stale" };
  }
  return { ok: true, result };
}

/**
 * open 失败（503 等）：
 *  - canonical 已确认存在 → 切过去并挂可重试错误卡；
 *  - 探测不到 canonical → 不切换、不改标题/身份，保留当前会话，只挂可重试错误卡。
 * 错误文案用服务端的通用中文，不展示上游原文。
 * 失败后顺手静默刷一次花名册（2026-11-06 返修）：档案可能刚被删/暂停，列表里的
 * 名字、状态点、幽灵行跟着对齐——「点开失败但列表还说在」就是这次 bug 的观感来源。
 */
async function showPartnerOpenFailure(partnerId, message, stillHere) {
  void loadRoster();
  if (!stillHere()) return;
  const name = partnerDisplayName(partnerId);
  const convId = partnerConversationId(partnerId);
  // 先探测再切路由：切完再看会把自己的 go("chat") 当成用户离开
  const exists = await partnerConversationExists(partnerId);
  if (!stillHere()) return;

  if (!exists) {
    // 不制造“标题是执事、身份却是 worker”的假页面：原会话、标题、chatKind 一律不动。
    addPartnerOpenError(message, partnerId, false, name, { keptConversation: true });
    // 错误卡挂在对话页；如果用户此刻在任务/设置页，补一条即时提示，别让点击像没反应。
    if (currentRoute() !== "chat") toast(`打开${name}失败：${message}`);
    return;
  }

  go("chat");
  const result = await openChat(convId);
  // openChat 自己会递增 token；这里用结果归属判断，不能拿旧 token 让正常路径失效。
  if (!ownsChatResult(result, convId)) {
    if (result?.status === "missing") toast("执事会话不在了，先点重试");
    return;
  }
  addPartnerOpenError(message, partnerId, true, name);
}

function addPartnerOpenError(message, partnerId, canContinue, name, opts = {}) {
  hideEmpty();
  const wrap = document.createElement("div");
  wrap.className = "msg error partner-open-error";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = opts.keptConversation
    ? `打开${name}失败：${message}。已保留当前会话，稍后可以重试。`
    : `${name}的问候没生成：${message}`;
  wrap.append(body);

  const actions = document.createElement("div");
  actions.className = "partner-open-actions";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry-btn";
  retry.textContent = "重试";
  retry.title = "重新请求首次问候";
  retry.addEventListener("click", () => {
    wrap.remove();
    void openPartnerChat(partnerId);
  });
  actions.append(retry);

  if (canContinue) {
    const cont = document.createElement("button");
    cont.type = "button";
    cont.className = "retry-btn";
    cont.textContent = "继续对话";
    cont.title = "不重试问候，直接在这个空会话里说话";
    cont.addEventListener("click", async () => {
      // 点击时再确认一次 canonical：会话可能在错误卡出现后被清理。
      const opened = await openConfirmedPartnerCanonical(partnerId);
      if (opened.ok) {
        wrap.remove();
        return;
      }
      if (opened.reason === "missing") toast("这个执事会话还没建好，先点重试");
    });
    actions.append(cont);
  }

  wrap.append(actions);
  el.thread.append(wrap);
  updateHomeMode();
  if (state.stick) scrollToEnd();
  if (currentRoute() === "chat") el.input.focus();
}

// 分区标题右侧 ＋：复用 E1「新建执事」模态，不重写
el.partnerAddSide.addEventListener("click", () => openCreatePartnerModal());

/* ── 消息渲染 ─────────────────────────────────────────── */

function clearThread() {
  // 切会话/新建时把审批卡片的倒计时停掉，免得旧卡在后面空转
  for (const { timer } of approvalCards.values()) clearInterval(timer);
  approvalCards.clear();
  // 课题提议卡跟审批卡同命运：换会话后旧卡不再属于这一屏
  topicProposalCards.clear();
  // 待发图片属于"这一屏的这条会话"：切走就清，别把图带到另一条对话里
  clearPendingImages();
  el.thread.replaceChildren();
  if (el.empty) el.thread.append(el.empty);
  updateHomeMode();
}

function hideEmpty() {
  if (el.empty && el.empty.isConnected) el.empty.remove();
}

function addMessage(role, text, at, images = []) {
  hideEmpty();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  // 时间戳不摆在脸上，挂在 hover 的 title 里；data-at 留给以后要用的时候
  if (at) {
    wrap.dataset.at = String(at);
    wrap.title = new Date(at).toLocaleString("zh-CN");
  }

  // 助手那一侧多一层「工作过程」（2026-11-07）：思考卡 + 工具步骤 + 派活。
  // 用户消息没有这一层。刻意**不在建消息时就插占位块**——没有工具的轮次
  // 不该多出一条空壳（旧 .acts 靠 :empty 隐藏，这里直接不建）。
  const body = document.createElement("div");
  body.className = "body";
  if (role === "user") body.textContent = text;
  else body.innerHTML = renderMarkdown(text);
  wrap.append(body);

  // 用户消息的图片（2026-11-08 扫尾批 4a）：贴在气泡下方，点开看大图
  if (role === "user") mountMessageImages(wrap, images);

  // 回答底下的一条脚注（2026-11-06）：复制 · 用时 · 完成时间。
  // 以前复制按钮浮在右上角、耗时单独 absolute 在右边，两者都对不齐正文；
  // 现在统一收进正文下方的 .msg-foot，hover 才出现。
  let foot = null;
  if (role === "assistant") {
    foot = document.createElement("div");
    foot.className = "msg-foot";
    wrap.append(foot);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-btn";
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(body.innerText);
        copy.textContent = "已复制";
      } catch {
        copy.textContent = "复制失败";
      }
      setTimeout(() => {
        copy.textContent = "复制";
      }, 1200);
    });
    foot.append(copy);
  }

  el.thread.append(wrap);
  updateHomeMode();
  if (state.stick) scrollToEnd();
  return { root: wrap, body, foot };
}

/* ── 用户消息的图片 / 编辑重发（2026-11-08 扫尾批 4a）────────────
   图片：base64 data URL 直接渲染（服务端回读同形状），点击开 lightbox。
   编辑：只给**最后一条 user 消息**入口（方案 §二）；点开是行内输入框，提交后
   服务端 fork 出新会话，这里 openConversation 接管并无缝补看这一轮。 */

function mountMessageImages(root, images) {
  if (!root || !Array.isArray(images) || images.length === 0) return;
  const host = document.createElement("div");
  host.className = "msg-images";
  for (const image of images) {
    if (!image || !image.data) continue;
    const img = document.createElement("img");
    img.src = `data:${image.mimeType || "image/png"};base64,${image.data}`;
    img.alt = "图片";
    img.loading = "lazy";
    img.addEventListener("click", () => openLightbox(img.src));
    host.append(img);
  }
  if (host.children.length) root.append(host);
}

function userActionsOf(root) {
  let actions = root.querySelector(":scope > .msg-user-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "msg-user-actions";
    root.prepend(actions);
  }
  return actions;
}

/**
 * 把「编辑」入口挂到**最后一条**用户消息上（其它历史消息不提供，方案登记的刻意没有）。
 * 会话切换 / 每轮发送后各刷一次；能力开关关着时一个都不渲染。
 */
function syncEditEntry() {
  for (const button of el.thread.querySelectorAll(".msg-edit")) button.remove();
  if (!state.capabilities.editResend) return;
  const users = el.thread.querySelectorAll(".msg.user");
  const last = users[users.length - 1];
  if (!last) return;
  const actions = userActionsOf(last);
  if (actions.querySelector(".msg-edit")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "msg-edit";
  button.textContent = "编辑";
  button.title = "改这句话并重发（会产生一条新会话）";
  button.addEventListener("click", () => void startEditing(last));
  actions.append(button);
}

/**
 * 现场刚发出去的消息没有 messageId（SSE 不带它，契约没动）。点编辑时再拉一次历史，
 * 按"从末尾对齐"把 id 写回所有用户气泡——limit 截断的是最早的部分，末尾一定对得上。
 */
async function resolveMessageId(root) {
  const conversationId = state.conversationId;
  if (!conversationId) return "";
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=200`,
      { cache: "no-store" },
    );
    if (!response.ok) return "";
    const data = await response.json();
    const userMessages = (data.messages || []).filter((message) => message.role === "user");
    const roots = [...el.thread.querySelectorAll(".msg.user")];
    const count = Math.min(roots.length, userMessages.length);
    for (let offset = 1; offset <= count; offset += 1) {
      const node = roots[roots.length - offset];
      const message = userMessages[userMessages.length - offset];
      if (node && message?.id) node.dataset.messageId = message.id;
    }
    return root.dataset.messageId || "";
  } catch {
    return "";
  }
}

async function startEditing(root) {
  if (state.sending) {
    toast("等这一轮结束再改");
    return;
  }
  const conversationId = state.conversationId;
  if (!conversationId) return;
  const text = (root.querySelector(":scope > .body")?.textContent || "").trim();
  const messageId = root.dataset.messageId || (await resolveMessageId(root));
  if (!messageId) {
    toast("这条消息暂时定位不到，刷新页面后再试");
    return;
  }
  openInlineEditor(root, text, messageId);
}

function openInlineEditor(root, text, messageId) {
  if (root.querySelector(":scope > .msg-editor")) return;
  const body = root.querySelector(":scope > .body");
  const images = root.querySelector(":scope > .msg-images");
  const actions = root.querySelector(":scope > .msg-user-actions");
  if (body) body.hidden = true;
  if (images) images.hidden = true;
  if (actions) actions.hidden = true;

  const editor = document.createElement("div");
  editor.className = "msg-editor";
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("aria-label", "编辑这条消息");
  const bar = document.createElement("div");
  bar.className = "msg-editor-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = "改并重发";
  bar.append(cancel, save);
  editor.append(area, bar);
  root.append(editor);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  if (state.stick) scrollToEnd();

  const close = () => {
    editor.remove();
    if (body) body.hidden = false;
    if (images) images.hidden = false;
    if (actions) actions.hidden = false;
  };
  cancel.addEventListener("click", close);
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    // Ctrl/⌘+Enter 提交（与 composer 的"带修饰键发送"同习惯）；裸 Enter 留给换行
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save.click();
    }
  });
  save.addEventListener("click", () => {
    const next = area.value.trim();
    if (!next) return;
    if (next === text) {
      close();
      return;
    }
    save.disabled = true;
    cancel.disabled = true;
    save.textContent = "重发中…";
    void submitEdit(messageId, next, { save, cancel });
  });
}

/**
 * 提交编辑重发。成功 = 202 + 新 conversationId：立刻切过去（老会话原样留在列表里），
 * 再等这一轮落库把回答补上。
 */
async function submitEdit(messageId, text, ui) {
  const conversationId = state.conversationId;
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/edit`,
      { method: "POST", body: JSON.stringify({ messageId, text }) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.conversationId) {
      const why =
        data.message ||
        (response.status === 404
          ? "编辑重发未开启（AGENT_EDIT_RESEND=false）"
          : response.status === 409
            ? "这一轮还在跑，等它结束再改"
            : `改不了：HTTP ${response.status}`);
      toast(why);
      ui.save.disabled = false;
      ui.cancel.disabled = false;
      ui.save.textContent = "改并重发";
      return;
    }
    await openConversation(data.conversationId);
    // 新会话要立刻出现在侧栏里（与发送路径的 start 帧同一做法）
    void loadChats();
    await waitEditedTurn(data.conversationId);
  } catch (error) {
    ui.save.disabled = false;
    ui.cancel.disabled = false;
    ui.save.textContent = "改并重发";
    toast(`改不了：${error.message}`);
  }
}

/**
 * 编辑重发后的回答是后台跑的（端点立刻 202），所以这里轮询回读：
 * 一出现新的 assistant 消息就整屏重读一次（工作过程/用量脚注都跟着补上）。
 * 轮询窗口 90s；期间按钮是「停止」，点了会走正常的 `POST .../stop`。
 */
async function waitEditedTurn(conversationId) {
  if (state.conversationId !== conversationId) return;
  setSending(true);
  const deadline = Date.now() + 90_000;
  try {
    while (Date.now() < deadline && state.conversationId === conversationId) {
      // 判据：最后一条 user 之后出现了 assistant。不按"条数变多"判——
      // 分叉历史本身就带旧回答，数数会把"还没开始"当成"已经答完"。
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=200`,
        { cache: "no-store" },
      ).catch(() => null);
      if (response && response.ok) {
        const data = await response.json().catch(() => ({}));
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
        const answered =
          lastUserIndex >= 0 &&
          messages.slice(lastUserIndex + 1).some((message) => message.role === "assistant");
        if (answered) {
          await openChat(conversationId);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (state.conversationId !== conversationId || state.stopRequested) return;
    }
  } finally {
    setSending(false);
  }
}

/**
 * 在脚注里落「完成于 …」。
 *
 * 刻意不在 addMessage 里写：那一轮刚建出来时只有一个光标，写上去就是
 * "刚开始就完成于 xx:xx"。历史回读（文案已定）走 openChat，现场那一轮
 * 等 done / 收尾再落，两边才会显示真正的收尾时刻。
 */
function markDoneAt(root, ms) {
  const foot = root?.querySelector?.(".msg-foot");
  if (!foot) return;
  let stamp = foot.querySelector('[data-role="done-at"]');
  if (!stamp) {
    stamp = document.createElement("span");
    stamp.className = "msg-time";
    stamp.dataset.role = "done-at";
    foot.append(stamp);
  }
  stamp.textContent = `完成于 ${clockOf(ms)}`;
}

/** 脚注时间：今天只给 HH:MM，隔天补 M/D——历史会话里"完成于 14:03"没有信息量 */
function clockOf(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

/* ── 工作过程（2026-11-07，对齐 ZCode 的「工作过程」）──────────
 *
 * 为什么改：以前活动行是"一串平铺的小行"，跑完才收成 details。问题是
 *   ① 收起后的那一行在**正文上方**，读起来像"先给结论再给过程"，跟实际顺序相反；
 *   ② 刷新/切会话就全没了（服务端 2026-11-07 起回放 steps，见接口文档 §2.2）；
 *   ③ 一步做什么（读/写/改/跑）只有工具名，没有图标与成败语义。
 *
 * 现在的形状：
 *   运行中 → 正文下方一块工作过程，头行「工作中 12s · 3 步」，默认展开，逐步出现；
 *   收尾后 → 同一块折成一行「已工作 12s · 3 步」，点开仍是原始步骤（含参数/输出/diff）。
 * 折叠态与展开态是**同一个 DOM**，所以"点开是不是当时那些步骤"不需要再对一次账。
 */

/** 工具名 → 语义分类：图标、动词、以及"这一步到底改了什么" */
const TOOL_KINDS = {
  read: { icon: "read", verb: "读取" },
  write: { icon: "write", verb: "写入" },
  edit: { icon: "edit", verb: "编辑" },
  bash: { icon: "shell", verb: "执行" },
  remember: { icon: "memory", verb: "记住" },
  recall: { icon: "memory", verb: "回忆" },
  set_reminder: { icon: "clock", verb: "提醒" },
  skill: { icon: "skill", verb: "技能" },
  delegate: { icon: "delegate", verb: "派活" },
  propose_project: { icon: "project", verb: "提议项目" },
  // 长期课题（2026-11-07 批二）：提议卡与搜索都进工作过程
  propose_topic: { icon: "project", verb: "提议课题" },
  web_search: { icon: "search", verb: "搜索" },
  partner_manage: { icon: "delegate", verb: "执事" },
  partner_skill_write: { icon: "skill", verb: "执事技能" },
};

/** 线性图标（与界面其余内联 SVG 同做法：无依赖、无构建） */
const TOOL_ICON_PATHS = {
  read: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19"/>',
  write: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  shell: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  memory: '<path d="M12 5a3 3 0 1 0-3 3"/><path d="M12 5a3 3 0 1 1 3 3"/><path d="M9 8h6"/><path d="M6 12h12"/><path d="M7 16h10"/><path d="M9 20h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  skill: '<path d="M12 3l2.2 5.6L20 9.8l-4.4 3.6L17 20l-5-3-5 3 1.4-6.6L4 9.8l5.8-1.2z"/>',
  delegate: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M17 8h4"/><path d="m19 6 2 2-2 2"/>',
  project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  // Lucide search（0.468）：24 视框、2 号描边，与上面同族
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  tool: '<path d="M14.7 6.3a4 4 0 1 0 5 5L21 10l-3-3z"/><path d="m9 15-6 6"/><path d="m14 10-4 4"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  fail: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function toolIcon(kind) {
  const span = document.createElement("span");
  span.className = "wp-icon";
  span.dataset.kind = kind;
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${TOOL_ICON_PATHS[kind] || TOOL_ICON_PATHS.tool}</svg>`;
  return span;
}

function toolKindOf(name) {
  return TOOL_KINDS[name] || { icon: "tool", verb: "" };
}

/** 毫秒 → 「12s」/「1m 05s」/「2h 10m」。低于 1s 给「<1s」，不写 0s 骗人 */
function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  if (total <= 0) return "<1s";
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * 一个工作过程块。调用方持有它，工具事件来时喂 `start` / `end`，
 * 一轮收尾时调 `finish`。历史回读直接 `fromSteps` 造一个已收尾的块。
 */
function createWorkPanel(root) {
  const box = document.createElement("section");
  box.className = "wp";
  box.dataset.open = "1";
  box.dataset.state = "running";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "wp-head";
  head.setAttribute("aria-expanded", "true");

  const chevron = document.createElement("span");
  chevron.className = "wp-chevron";
  chevron.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICON_PATHS.chevron}</svg>`;

  const title = document.createElement("span");
  title.className = "wp-title";
  const meta = document.createElement("span");
  meta.className = "wp-meta";
  head.append(title, meta, chevron);

  const list = document.createElement("div");
  list.className = "wp-steps";

  box.append(head, list);
  // 收尾后整块落在正文下方；运行中也一样——顺序跟真实发生的一致
  root.append(box);

  const startedAt = Date.now();
  /** toolCallId/name → 还没结束的那一行（同名连续调用时按最近一条配对） */
  const open = new Map();
  let stepCount = 0;
  let failed = 0;
  let ticker = 0;

  const paintHead = (finalMs) => {
    const elapsed = finalMs ?? Date.now() - startedAt;
    const state = box.dataset.state;
    const label =
      state === "running" ? "工作中" : state === "interrupted" ? "已中断" : "已工作";
    title.textContent = elapsed >= 1000 || state !== "running"
      ? `${label} ${shortDuration(elapsed) || "<1s"}`
      : label;
    const bits = [`${stepCount} 步`];
    if (failed > 0) bits.push(`${failed} 步失败`);
    meta.textContent = stepCount > 0 ? bits.join(" · ") : "";
  };

  const setOpen = (value) => {
    box.dataset.open = value ? "1" : "0";
    head.setAttribute("aria-expanded", String(value));
  };

  head.addEventListener("click", () => setOpen(box.dataset.open !== "1"));

  const startTicker = () => {
    if (ticker) return;
    ticker = setInterval(() => paintHead(), 1000);
  };
  const stopTicker = () => {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = 0;
  };

  paintHead();
  startTicker();

  return {
    root: box,
    /** 工具开始：立刻出现一行「执行 正在运行」，参数折叠在这一行里 */
    start(name, label, args) {
      const kind = toolKindOf(name);
      const row = document.createElement("div");
      row.className = "wp-step";
      row.dataset.state = "run";
      row.dataset.tool = name;

      const dot = document.createElement("span");
      dot.className = "wp-status";
      const verb = document.createElement("span");
      verb.className = "wp-verb";
      verb.textContent = kind.verb || name;
      const nameEl = document.createElement("span");
      nameEl.className = "wp-name";
      nameEl.textContent = kind.verb ? name : "";
      if (!kind.verb) nameEl.hidden = true;
      const labelEl = document.createElement("span");
      labelEl.className = "wp-label";
      labelEl.textContent = label || "";
      labelEl.title = label || "";
      if (!label) labelEl.hidden = true;

      const line = document.createElement("div");
      line.className = "wp-line";
      line.append(toolIcon(kind.icon), dot, verb, nameEl, labelEl);

      row.append(line);
      if (args) addStepBlock(row, "参数", args);
      list.append(row);
      if (open.has(name)) open.get(name).push(row);
      else open.set(name, [row]);
      stepCount += 1;
      paintHead();
      return row;
    },
    /** 工具结束：定成败、补输出（有 diff 就优先画 diff，比"Successfully replaced…"有用） */
    end(name, ok, output, diff) {
      const queue = open.get(name);
      const row = queue?.shift();
      if (!row) return;
      if (queue && queue.length === 0) open.delete(name);
      row.dataset.state = ok ? "ok" : "err";
      if (!ok) failed += 1;
      if (diff) addStepBlock(row, "改动", diff, "diff");
      if (output) addStepBlock(row, "输出", output);
      paintHead();
    },
    /**
     * 派活这类"后台长任务"的行（2026-11-07 修）：**不进** open 队列。
     * 原因：delegate 的进度帧由 chancellor 的事件来，终态帧（done / needs_you /
     * aborted / failed）经常晚于本轮收尾——进了 open 队列就会被 `finish` 判成
     * 「没等到结果」记一步失败，成功派活也报「N 步失败」，是谎报。
     * 所以行建出来后由调用方喂 `setLabel` / `close`，一轮收尾还没 close 的走 `handoff`。
     */
    track(label) {
      const kind = toolKindOf("delegate");
      const row = document.createElement("div");
      row.className = "wp-step";
      row.dataset.state = "run";
      row.dataset.tool = "delegate";

      const dot = document.createElement("span");
      dot.className = "wp-status";
      const verb = document.createElement("span");
      verb.className = "wp-verb";
      verb.textContent = kind.verb || "delegate";
      const labelEl = document.createElement("span");
      labelEl.className = "wp-label";
      labelEl.textContent = label || "";
      labelEl.title = label || "";
      if (!label) labelEl.hidden = true;

      const line = document.createElement("div");
      line.className = "wp-line";
      line.append(toolIcon(kind.icon), dot, verb, labelEl);

      row.append(line);
      list.append(row);
      stepCount += 1;
      paintHead();
      return {
        row,
        setLabel(text) {
          labelEl.textContent = text || "";
          labelEl.title = text || "";
          labelEl.hidden = !text;
        },
        /** 终态帧到了：定成败、补一句说明（chancellor 的 message 就是给人看的那个） */
        close(ok, output) {
          if (row.dataset.state !== "run") return;
          row.dataset.state = ok ? "ok" : "err";
          if (!ok) failed += 1;
          if (output) addStepBlock(row, "输出", output);
          paintHead();
        },
        /** 轮收尾还没等到终态：chancellor 在后台继续跑，画「已转后台」而不是失败 */
        handoff() {
          if (row.dataset.state !== "run") return;
          row.dataset.state = "back";
          addStepBlock(row, "输出", "派单已受理，还在后台继续跑；进度看任务中心。");
          paintHead();
        },
      };
    },
    /** 历史/权威时长覆盖本地表（服务端 workMs 是事实源，本地表只是现场估的） */
    setDuration(ms) {
      stopTicker();
      paintHead(ms);
    },
    /** 一轮收尾：停表、定格标题、默认折起来（人已经看过过程了，结论才是重点） */
    finish(outcome = "completed") {
      stopTicker();
      for (const queue of open.values()) {
        // 没等到结果的（中断 / 崩溃）不能画成成功
        for (const row of queue) {
          row.dataset.state = "err";
          failed += 1;
        }
      }
      open.clear();
      box.dataset.state = outcome;
      paintHead();
      if (stepCount === 0) {
        box.remove();
        return;
      }
      setOpen(false);
    },
  };
}

/**
 * 行内展开块：参数 / 输出 / diff 都塞在同一个可折叠区里，
 * 点开哪一块就只看那一块（选字不收起，与旧 addActBlock 同口径）。
 */
function addStepBlock(row, label, text, kind = "pre") {
  row.classList.add("has-detail");
  let body = row.querySelector(".wp-detail");
  if (!body) {
    body = document.createElement("div");
    body.className = "wp-detail";
    row.append(body);
  }
  const block = document.createElement("div");
  block.className = "wp-block";
  const tag = document.createElement("span");
  tag.className = "wp-block-tag";
  tag.textContent = label;
  const pre = document.createElement("pre");
  pre.className = kind === "diff" ? "wp-pre wp-pre-diff" : "wp-pre";
  if (kind === "diff") pre.innerHTML = paintDiff(text);
  else pre.textContent = text;
  pre.addEventListener("click", (event) => event.stopPropagation());
  block.append(tag, pre);
  body.append(block);
  body.hidden = false;
}

/** diff 逐行染色：+新增 / -删除 / …上下文。文本本身不是 HTML，先转义再上色 */
function paintDiff(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const cls = line.startsWith("+") ? "d-add" : line.startsWith("-") ? "d-del" : "";
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    })
    .join(String.fromCharCode(10));
}

/** 历史回读：把服务端下发的一轮 steps 还原成同一块（已收尾、默认折叠） */
function workPanelFromSteps(root, steps, workMs) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const panel = createWorkPanel(root);
  for (const step of steps) {
    panel.start(step.name, step.label, undefined);
    panel.end(step.name, step.ok !== false, step.output, step.diff);
  }
  panel.finish("completed");
  // 时长以服务端事实为准（现场那块是本地表；历史里没有"正在跑"，直接用落库值）
  if (typeof workMs === "number" && workMs > 0) panel.setDuration(workMs);
  return panel;
}

/** 错误行。`retryable` 时带「重试」——重发这条错误的最后一句话（批次一，2026-11-04） */
/**
 * 系统提示行（2026-11-07 消息即引导）。
 *
 * 只用于"这件事变了但你不需要看模型说话"：插话请求落到下一个边界、
 * 补充已受理之类。与 addError 分开的理由：它不是失败，不该染成红色，
 * 也不该被当成模型的正文进 markdown 渲染。
 */
function addNotice(text) {
  if (!text) return;
  const wrap = document.createElement("div");
  wrap.className = "msg notice";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  wrap.append(body);
  el.thread.append(wrap);
  if (state.stick) scrollToEnd();
}

function addError(text, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "msg error";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  wrap.append(body);
  if (opts.retryable && state.lastUserText) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-btn";
    retry.textContent = "重试";
    retry.title = "重新发送上一条消息";
    retry.addEventListener("click", () => {
      wrap.remove();
      void send(state.lastUserText);
    });
    wrap.append(retry);
  }
  el.thread.append(wrap);
  if (state.stick) scrollToEnd();
}

/**
 * 消息级用时/token（批次一）：hover 才出现，落在正文下方的脚注里。
 * 2026-11-06 从「右侧浮层」改成脚注的一部分：复制 · 用时 · 完成时间同一行，
 * 不再各自 absolute 定位（那样永远跟正文右边缘对不齐）。
 *
 * 两路数据源共用：现场那一轮给 `usage + 墙钟`（两个数字都显示），
 * 历史回读只给 `workMs`（没有 token 可读，就只显示用时，不编 0 tok）。
 */
function attachUsage(root, usage, ms) {
  const input = usage?.input || 0;
  const output = usage?.output || 0;
  const total = input + output;
  const hasDuration = typeof ms === "number" && ms > 0;
  if (!root.isConnected || (total <= 0 && !hasDuration)) return;
  const foot = root.querySelector(".msg-foot");
  if (!foot) return;
    let chip = foot.querySelector(".msg-usage");
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "msg-usage";
      // 复制按钮恒在最前，其余按「用时 · 完成时间」顺排。
      // （2026-11-07 修：原来 insertBefore(copy.nextSibling || firstChild) 在复制按钮
      //   是末节点时会回落到 firstChild——chip 反而插到它前面去了。）
      const copy = foot.querySelector(".copy-btn");
      if (copy) copy.after(chip);
      else foot.prepend(chip);
    }
  const seconds = hasDuration ? `${(ms / 1000).toFixed(1)}s` : "";
  chip.textContent = total > 0
    ? `${total.toLocaleString()} tok${seconds ? ` · ${seconds}` : ""}`
    : seconds;
  chip.title =
    total > 0
      ? `输入 ${input} · 输出 ${output} · 缓存命中 ${usage?.cacheRead || 0} tokens`
      : "这一轮的用时（历史消息只留时长，不重算 token）";

  // 完成时间：实时那一轮以"拿到 done 的时刻"为准（不是消息创建时刻）
  markDoneAt(root, Date.now());
}

function scrollToEnd() {
  el.scroll.scrollTop = el.scroll.scrollHeight;
}

el.scroll.addEventListener("scroll", () => {
  const distance = el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight;
  state.stick = distance < 80;
});

/* ── 极简 Markdown ────────────────────────────────────── */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const esc = (text) => text.replace(/[&<>]/g, (char) => ESCAPES[char]);
/** 放进 HTML 属性值里用：esc 不处理引号，这里补上 */
const attr = (text) => esc(String(text ?? "")).replace(/"/g, "&quot;");

function inline(raw) {
  return esc(raw)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    )
    // 任务单号自动变链接：历史里的「【任务 t-2026… · 前端】已完成」也能点进详情。
    // 只在空白/括号后命中，避免把 code、属性值里的字符改坏。
    .replace(
      /(^|[\s(（【])((?:t-\d{8}-\d{6}-[0-9a-z]+|T-\d{3,}))(?![0-9a-z-])/gi,
      (_match, prefix, id) =>
        `${prefix}<a href="#/tasks?ticket=${encodeURIComponent(id)}" class="ticket-link">${id}</a>`,
    );
}

/* ── 对话里的派单提示 ─────────────────────────────────────
 * 受理后补一句「任务已派发，可在任务中心查看」，并做成真链接；
 * 后台跑完时同一个任务单的那句会更新成「已完成 / 待你处理 / 失败」。
 * 每条任务单一句话，不堆重复行。 */
const DELEGATE_HINTS = new WeakMap();

function delegateHintText(phase) {
  switch (phase) {
    case "done":
      return "任务已完成，可以到任务中心查看结果。";
    case "needs_you":
      return "任务需要你处理，去任务中心看看。";
    case "failed":
      return "任务没做成，任务中心里有失败原因。";
    case "aborted":
      return "任务已中止。";
    default:
      return "任务已派发，可在任务中心查看。";
  }
}

function syncDelegateHint(root, event) {
  if (!event.ticketId) return;
  let hint = root.querySelector(".delegate-hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "delegate-hint";
    DELEGATE_HINTS.set(hint, new Map());
    root.append(hint);
  }
  const items = DELEGATE_HINTS.get(hint);
  items.set(event.ticketId, delegateHintText(event.phase));
  hint.replaceChildren();
  for (const [ticketId, text] of items) {
    const link = document.createElement("a");
    link.href = `#/tasks?ticket=${encodeURIComponent(ticketId)}`;
    link.textContent = text;
    hint.append(link);
  }
}

/* ── 代码块：轻量高亮 + 复制按钮 ────────────────────────────
 * 无依赖无构建：一条合并正则把 注释/字符串/数字/关键字/属性名 五类挑出来上色，
 * 规则都允许未闭合——流式中的半截字符串也能上色。不追求 IDE 准确度，
 * 扫不出来就原样转义显示。规则源全部用非捕获组，别让分组序号错位。 */
const HL_MAX_CODE = 20000;

function hlBuild(rules) {
  const re = new RegExp(
    rules.map((rule) => `(${rule.re.source})`).join("|"),
    "gm",
  );
  return (code) => {
    let out = "";
    let last = 0;
    re.lastIndex = 0;
    for (let match = re.exec(code); match; match = re.exec(code)) {
      if (match.index > last) out += esc(code.slice(last, match.index));
      let cls = "";
      for (let i = 1; i < match.length; i += 1) {
        if (match[i] !== undefined) {
          cls = rules[i - 1].cls;
          break;
        }
      }
      out += `<span class="tok-${cls}">${esc(match[0])}</span>`;
      last = match.index + match[0].length;
      if (match[0].length === 0) re.lastIndex += 1; // 防空匹配死循环
    }
    out += esc(code.slice(last));
    return out;
  };
}

const HL_NUMBER = { re: /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/, cls: "n" };
const HL_LANGS = {
  clike: hlBuild([
    { re: /\/\/[^\n]*/, cls: "c" },
    { re: /\/\*[\s\S]*?(?:\*\/|$)/, cls: "c" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    { re: /'(?:[^'\\\n]|\\.)*'?/, cls: "s" },
    { re: /`(?:[^`\\]|\\.)*`?/, cls: "s" },
    HL_NUMBER,
    {
      re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|super|this|typeof|instanceof|try|catch|finally|throw|async|await|yield|import|export|from|delete|void|static|get|set|interface|type|enum|implements|readonly|public|private|protected|namespace|declare|abstract|keyof|infer|satisfies|null|undefined|true|false|never|unknown|any)\b/,
      cls: "k",
    },
  ]),
  python: hlBuild([
    { re: /#[^\n]*/, cls: "c" },
    { re: /"""[\s\S]*?(?:"""|$)/, cls: "s" },
    { re: /'''[\s\S]*?(?:'''|$)/, cls: "s" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    { re: /'(?:[^'\\\n]|\\.)*'?/, cls: "s" },
    HL_NUMBER,
    {
      re: /\b(?:def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|lambda|yield|pass|raise|and|or|not|in|is|None|True|False|self|async|await|match|case|global|nonlocal|assert|del)\b/,
      cls: "k",
    },
  ]),
  bash: hlBuild([
    { re: /#[^\n]*/, cls: "c" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    { re: /'[^']*'?/, cls: "s" },
    { re: /(?:\$\{[^}]*\}|\$\w+)/, cls: "a" },
    HL_NUMBER,
    {
      re: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|readonly|echo|cd|source|set|unset|trap|shift|break|continue|in)\b/,
      cls: "k",
    },
  ]),
  json: hlBuild([
    { re: /"(?:[^"\\\n]|\\.)*"(?=\s*:)/, cls: "a" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    HL_NUMBER,
    { re: /\b(?:true|false|null)\b/, cls: "k" },
  ]),
  css: hlBuild([
    { re: /\/\*[\s\S]*?(?:\*\/|$)/, cls: "c" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
    { re: /@[\w-]+/, cls: "k" },
    { re: /[\w-]+(?=\s*:)/, cls: "a" },
    { re: /#[0-9a-fA-F]{3,8}\b/, cls: "n" },
    { re: /\b\d[\d.]*(?:px|em|rem|vh|vw|%|s|ms|deg|fr)?/, cls: "n" },
  ]),
  html: hlBuild([
    { re: /<!--[\s\S]*?(?:-->|$)/, cls: "c" },
    { re: /<\/?[\w-]+|\/?>/, cls: "k" },
    { re: /[\w-]+(?==)/, cls: "a" },
    { re: /"(?:[^"\\\n]|\\.)*"?/, cls: "s" },
  ]),
};

const HL_ALIAS = {
  js: "clike", javascript: "clike", jsx: "clike", mjs: "clike", cjs: "clike",
  ts: "clike", typescript: "clike", tsx: "clike",
  java: "clike", c: "clike", cpp: "clike", "c++": "clike", cs: "clike", csharp: "clike",
  go: "clike", rust: "clike", rs: "clike", kotlin: "clike", kt: "clike",
  swift: "clike", php: "clike", scala: "clike", dart: "clike",
  py: "python", python: "python",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css",
  html: "html", xml: "html", svg: "html", vue: "html",
};

function codeBlockHtml(lang, code) {
  // 围栏信息串可能是 "ts title=x" 这类，取第一个词；未知语言原样转义
  const key = (lang || "").trim().toLowerCase().split(/[\s{]/)[0];
  const highlight = HL_LANGS[HL_ALIAS[key] || ""];
  let body;
  try {
    body = highlight && code.length <= HL_MAX_CODE ? highlight(code) : esc(code);
  } catch {
    body = esc(code);
  }
  return `<div class="codeblock"><button class="code-copy" type="button" title="复制代码">复制</button><pre class="code"><code>${body}</code></pre></div>`;
}

/* ── 表格（批次二）：GFM 管道表格，只做基本形态 ──────────────
   判定很保守：某行像行、且**下一行是纯分隔行**（全为 -/: 组成）才算表，
   正文里带竖线的普通句子不会被误吞。单元格内容走 inline（支持加粗/行内码）。 */
const splitTableRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isTableDelim = (line) => {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
};

const isTableRow = (line) => line.includes("|") && splitTableRow(line).length >= 2;

function tableHtml(header, aligns, rows) {
  const alignOf = (i) => aligns[i] || "left";
  const cellOf = (cell, i, tag) =>
    `<${tag} style="text-align:${alignOf(i)}">${inline(cell ?? "")}</${tag}>`;
  const head = header.map((cell, i) => cellOf(cell, i, "th")).join("");
  const body = rows
    .map((row) => `<tr>${header.map((_, i) => cellOf(row[i], i, "td")).join("")}</tr>`)
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMarkdown(source) {
  const blocks = [];
  let text = source.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    blocks.push(codeBlockHtml(lang, code.replace(/\n+$/, "")));
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+$/, "");
    const placeholder = line.trim().match(/^\u0000(\d+)\u0000$/);
    if (placeholder) {
      flushParagraph();
      flushList();
      out.push(blocks[Number(placeholder[1])]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    let match;
    if ((match = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushParagraph();
      flushList();
      const level = match[1].length;
      out.push(`<h${level}>${inline(match[2])}</h${level}>`);
      continue;
    }
    // 表格分支（批次二）：表头行 + 分隔行 + 连续数据行
    if (isTableRow(line) && index + 1 < lines.length && isTableDelim(lines[index + 1])) {
      flushParagraph();
      flushList();
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[index + 1]).map((cell) =>
        /^:-+:$/.test(cell) ? "center" : /-+:$/.test(cell) ? "right" : "left",
      );
      index += 2;
      const rows = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1; // 外层 for 还会 +1，别跳过表后那行
      out.push(tableHtml(header, aligns, rows));
      continue;
    }
    if ((match = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushParagraph();
      if (list !== "ul") {
        flushList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(match[1])}</li>`);
      continue;
    }
    if ((match = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph();
      if (list !== "ol") {
        flushList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(match[1])}</li>`);
      continue;
    }
    if ((match = line.match(/^>\s?(.*)$/))) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inline(match[1])}</blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      flushList();
      out.push("<hr />");
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return out.join("");
}

/* ── 打开会话 ─────────────────────────────────────────── */

/**
 * 「从任何地方打开一条对话」的唯一入口（2026-11-07 修）：
 * 先切到对话路由，再回读历史。
 *
 * 为什么不能只 openChat：它只换 state.conversationId 与线程内容，**不动路由**。
 * 于是从群聊（#/group/<id>）/ 任务中心 / 设置页点会话行时，数据在背后换了、
 * 屏幕还停在原页——用户看到的就是「点了没反应、界面切换不了」。
 * go("chat") 改 hash → hashchange → applyRoute 把视图换回来；两件事的顺序不能反，
 * 否则 applyRoute 可能带着旧会话重绘一次。
 */
async function openConversation(conversationId) {
  if (!conversationId) return;
  go("chat");
  return openChat(conversationId);
}

async function openChat(conversationId) {
  const token = ++state.navToken; // 作废还在飞的 open / 上一次 openChat
  const owner = () => token === state.navToken && state.conversationId === conversationId;
  state.conversationId = conversationId;
  localStorage.setItem(KEY_CONV, conversationId);
  // seq 游标跟着会话走：切会话就是重新全量回读，游标归零（2026-11-04 seq 方案）。
  state.maxSeq = 0;
  renderChats();
  clearThread();
  el.title.textContent = "…";

  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=200`,
      { cache: "no-store" },
    );
    if (response.status === 404) {
      // 迟到的 404 不能把用户已经切过去的新会话清掉（send 的 start 帧也会改 conversationId）
      if (!owner()) return { token, conversationId, status: "stale" };
      // 会话没了：延续原身份重开（总管入口不能掉成普通 worker）
      startNewChat(state.chatKind === "chief" ? "chief" : "worker");
      return { token: state.navToken, conversationId: "", status: "missing", applied: true };
    }
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    // 这中间用户又切了别的会话：旧历史不许覆盖新会话的屏幕
    if (!owner()) return { token, conversationId, status: "stale" };
    // 续话身份只认服务端回读（缺字段的旧后端按 chief）；不靠 id 猜。
    const kind = data.chatKind || "chief";
    state.chatKind = kind;
    clearThread();
    const messages = data.messages || [];
    for (const message of messages) {
      const shown = addMessage(
        message.role === "user" ? "user" : "assistant",
        message.text,
        message.at,
        message.images,
      );
      // 可寻址 id（2026-11-08 4a）：编辑重发靠它定位这条 user 消息
      if (message.role === "user" && message.id) shown.root.dataset.messageId = message.id;
      if (message.role !== "user") {
        // 工作过程（2026-11-07）：服务端从 durable 里把这一轮的 toolCall / tool-result
        // 配成 steps 下发；这里还原成与现场同一块（已收尾、默认折叠）。
        workPanelFromSteps(shown.root, message.steps, message.workMs);
        // 课题提议卡（2026-11-07 批二）：历史回读也按工具结果重渲，状态由 GET 定
        for (const step of Array.isArray(message.steps) ? message.steps : []) {
          if (step && step.name === "propose_topic" && step.output) {
            mountTopicProposalCard(shown.root, parseTopicProposalOutput(step.output));
          }
        }
        // 历史里的用时（2026-11-06）：服务端已下发 workMs（提问到收尾的墙钟），
        // 以前只有现场那一轮有耗时，切回来就没了。这里补成同一份脚注。
        // 完成时间 = 这条消息落盘的时刻（时间戳就是收尾时写的）。
        if (message.at) markDoneAt(shown.root, message.at);
        if (typeof message.workMs === "number" && message.workMs > 0) {
          attachUsage(shown.root, { input: 0, output: 0, cacheRead: 0 }, message.workMs);
        }
        // E2 #7：助手正文里以「【需要你】」开头的行加 .attention（只改渲染判断，不改内容）。
        for (const block of shown.body.children) {
          if (block.textContent.split("\n").some((line) => line.trimStart().startsWith("【需要你】"))) {
            block.classList.add("attention");
          }
        }
      }
    }
    const partnerId = conversationId.startsWith("partner-")
      ? conversationId.slice("partner-".length)
      : "";
    if (partnerId) {
      // 执事专线表头用名字；身份仍以服务端 chatKind 为准，这里只是展示
      el.title.textContent = partnerDisplayName(partnerId);
    } else if (!messages.length) {
      el.title.textContent = kind === "worker" ? "普通对话" : "新对话";
    } else {
      // 改过名的会话用存储标题（GET /chats 已带 title）；没改过名才从首句派生。
      // 不然 openChat 每次都把改名冲掉（顶栏永远是首句前 40 字）。
      const known = state.chats.find((chat) => chat.conversationId === conversationId)?.title;
      const first = messages.find((message) => message.role === "user");
      el.title.textContent = known || (first ? first.text.slice(0, 40) : "对话");
    }
    el.title.dataset.chatKind = kind;
    state.stick = true;
    scrollToEnd();
    // 编辑入口只挂在最后一条 user 消息上（2026-11-08 4a）
    syncEditEntry();
    if (!owner()) return { token, conversationId, status: "stale" };
    // 刷新页面 / 切回会话时，可能还有一条挂着等答复的审批
    await loadPendingApprovals(conversationId);
    if (!owner()) return { token, conversationId, status: "stale" };
    return { token, conversationId, status: "ok", applied: true, chatKind: kind };
  } catch (error) {
    // 旧请求的失败不许挂到别人屏幕上
    if (!owner()) return { token, conversationId, status: "stale" };
    if (error.message !== "forbidden" && error.message !== "not-found") {
      // 500 不再只显示一个数字（2026-11-07）：那条路以前是"读历史失败：500"，
      // 用户既不知道是历史没了还是服务端坏了，也不知道要不要重开。
      // 现在服务端 500 会回 { error: "internal_error", message }，这里把话说清。
      const serverBroken = error.message === "Internal Server Error" || error.message === "500";
      addError(
        serverBroken
          ? "读历史失败：服务端内部错误（历史还在，不用重建）。稍后重试；反复出现请看服务端日志。"
          : `读历史失败：${error.message}`,
      );
    }
    return { token, conversationId, status: "error", applied: true };
  } finally {
    if (owner()) void syncCtxMeter(owner);
  }
}

function startNewChat(kind = "worker") {
  state.navToken += 1;
  state.chatKind = kind === "chief" ? "chief" : "worker";
  state.conversationId = "";
  localStorage.removeItem(KEY_CONV);
  state.maxSeq = 0; // 新会话没有历史帧（2026-11-04 seq 方案）
  renderChats();
  clearThread();
  el.title.textContent = state.chatKind === "chief" ? "新对话" : "普通对话";
  el.title.dataset.chatKind = state.chatKind;
  el.ctxRing.hidden = true;
  el.input.focus();
}

/* ── 发送 ─────────────────────────────────────────────── */

/** 发送/停止同槽（cindy SendButton）：流式时同一个按钮变成停止，必须保持可点 */
function setSending(value) {
  state.sending = value;
  el.send.classList.toggle("streaming", value);
  el.send.setAttribute("aria-label", value ? "停止" : "发送");
  el.send.title = value ? "停止" : "";
  syncSendEnabled();
  // 忙碌不再改变总管在线色（2026-11-06 C 批）：只重算一次，保持与服务状态一致
  syncChiefDot();
}

function syncSendEnabled() {
  // 纯图片消息也能发（2026-11-08 4a）：有文字或有附件都算"有内容"
  el.send.disabled = state.sending ? false : !el.input.value.trim() && state.pendingImages.length === 0;
}

/* ── 桌面通知（批次二，三时机：完成 / 出错 / 待你处理）──────
   静默判定是前置条件不是优化：窗口可见且正看着这个会话 → 不打扰
   （cindy notificationService 的口径）。开关在设置-服务分区，默认关。
   三时机过滤（2026-11-07 抽屉改造）：纯前端 localStorage，
   KEY_NOTIFY_TIMING = all | error | attention，默认 all（= 现行为）。
   maybeNotify 带 kind：all 放行全部；error 放行 error+attention；attention 只放行 attention。 */
const KEY_NOTIFY = "lifediary.notify";
const KEY_NOTIFY_TIMING = "lifediary.notify.timing";

function maybeNotify(title, body, convId, kind = "done") {
  if (localStorage.getItem(KEY_NOTIFY) !== "1") return;
  const timing = localStorage.getItem(KEY_NOTIFY_TIMING) || "all";
  if (timing === "attention" && kind !== "attention") return;
  if (timing === "error" && kind !== "error" && kind !== "attention") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (
    document.visibilityState === "visible" &&
    convId &&
    convId === state.conversationId &&
    currentRoute() === "chat"
  ) {
    return;
  }
  const n = new Notification(title, { body: (body || "").slice(0, 120), tag: "lifediary" });
  n.addEventListener("click", () => {
    window.focus();
    // 通知点进来就是"我要看这条对话"：在群聊 / 任务页上收到通知也要真切过去，
    // 所以走 openConversation（先切路由再回读），不是只换背后的会话。
    if (convId && convId !== state.conversationId) void openConversation(convId);
    n.close();
  });
}

/** 上下文环形指示（2026-11-04 从顶栏搬进 composer 右下）：done 后与切会话时刷新；
    used / window 任一读不到就整块隐藏（维持原口径） */
const CTX_R = 8.25;
const CTX_C = 2 * Math.PI * CTX_R;

async function syncCtxMeter(stillCurrent = () => true) {
  const convId = state.conversationId;
  if (!stillCurrent()) return;
  if (!convId || currentRoute() !== "chat") {
    el.ctxRing.hidden = true;
    return;
  }
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(convId)}/context`,
      { cache: "no-store" },
    );
    const data = await response.json();
    // 请求期间切了会话 / 路由：旧游标不许画到新会话上
    if (!stillCurrent() || state.conversationId !== convId) return;
    if (!data.used || !data.window) {
      el.ctxRing.hidden = true;
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round((data.used / data.window) * 100)));
    el.ctxFill.style.strokeDasharray = `${CTX_C}`;
    el.ctxFill.style.strokeDashoffset = `${CTX_C * (1 - pct / 100)}`;
    el.ctxPct.textContent = `${pct}%`;
    el.ctxRing.title = `上下文已用 ${pct}%（${data.used.toLocaleString()} / ${data.window.toLocaleString()} tokens）`;
    // 阈值：<70% 中性灰；70–90% 警示；>90% 错误
    el.ctxRing.classList.toggle("warn", pct >= 70 && pct <= 90);
    el.ctxRing.classList.toggle("danger", pct > 90);
    el.ctxRing.hidden = false;
  } catch {
    el.ctxRing.hidden = true;
  }
}

/* ── 审批卡片（批次二 A1）：写类工具要人确认 ─────────────
   按 callId 去重：SSE 与"刷新补挂"两条路都可能把它画一次。
   答复后按钮置灰、倒计时停下；卡片留在原地作为痕迹。
   2026-11-08 批三：标题下补一行「来自 <会话或群名> · <执事名>」——群成员的审批
   与主人会话的审批长得一样，不标来源就分不清是谁在等确认。 */
const approvalCards = new Map();

/** `partner-<pid>-group-<gid>` → { partnerId, groupId }；不是群成员会话返回 null */
function parseGroupMemberConversation(conversationId) {
  const value = String(conversationId || "");
  if (!value.startsWith("partner-")) return null;
  const rest = value.slice("partner-".length);
  const at = rest.indexOf("-group-");
  if (at < 0) return null;
  const partnerId = rest.slice(0, at);
  const groupId = rest.slice(at + "-group-".length);
  if (!partnerId || !groupId) return null;
  return { partnerId, groupId };
}

/** 执事展示名（审批来源用：查不到就给空串，让调用方省略，不猜） */
function approvalPartnerName(partnerId) {
  if (!partnerId) return "";
  if (partnerId === "chief") return "总管";
  return state.partners.find((item) => item.id === partnerId)?.name || "";
}

/** 群投影（当前打开的群优先，其次侧栏列表；都查不到返回 null） */
function groupProjectionById(groupId) {
  if (groups.current?.id === groupId) return groups.current;
  return groups.list.find((item) => item.id === groupId) || null;
}

/**
 * 审批来源标签（2026-11-08 批三）：「来自 <会话或群名> · <执事名>」。
 * 只写能反查到的：群成员会话 → 群名 + 成员名；执事专线 → 执事名；主对话 → 总管。
 * task- 前缀（自主轮/课题专线）与查不到的一律返回空串——如实不显示，不猜。
 */
function approvalSourceLabel(conversationId) {
  const value = String(conversationId || "");
  if (!value) return "";
  const ref = parseGroupMemberConversation(value);
  if (ref) {
    const group = groupProjectionById(ref.groupId);
    const memberName =
      group?.members.find((member) => member.partnerId === ref.partnerId)?.name ||
      approvalPartnerName(ref.partnerId);
    return [group?.name ? `群「${group.name}」` : "群聊", memberName].filter(Boolean).join(" · ");
  }
  if (value.startsWith("task-")) return "";
  if (value.startsWith("partner-")) {
    return approvalPartnerName(value.slice("partner-".length)) || "执事";
  }
  return "总管";
}

function renderApprovalCard(event) {
  if (!event || !event.callId) return null;
  const existing = approvalCards.get(event.callId);
  if (existing) return existing.root;

  const card = document.createElement("div");
  card.className = "attention approval";
  card.dataset.callId = event.callId;

  const title = document.createElement("p");
  title.className = "attention-text";
  title.append(document.createTextNode(`要执行 ${event.tool || "工具"}`));
  // 自主轮（例行任务）的审批：工具名旁挂一枚徽章（批次C C2，纯增量）
  if (event.origin === "autonomous") {
    const routineTag = document.createElement("span");
    routineTag.className = "pill-tag";
    routineTag.textContent = "例行任务";
    title.append(routineTag);
  }
  title.append(document.createTextNode("，需要你确认"));
  card.append(title);

  // 来源行（2026-11-08 批三）：群成员轮的审批必须在卡上说是谁/哪个群，
  // 否则同一张卡在主对话与执事专线里长得一模一样，只能靠猜。
  const source = approvalSourceLabel(event.conversationId);
  if (source) {
    const from = document.createElement("p");
    from.className = "approval-source";
    from.textContent = `来自 ${source}`;
    card.append(from);
  }

  const args = document.createElement("pre");
  args.className = "approval-args";
  args.textContent = event.args || "（没有参数）";
  card.append(args);

  const meta = document.createElement("div");
  meta.className = "approval-meta";
  const remain = document.createElement("span");
  // 2026-11-08 扫尾批 8c：审批形态决定这一行。
  // blocking（AGENT_APPROVAL_MODE=blocking）= 旧形态，保留倒计时；
  // async（缺省）= 等待态落库，没有截止时间，只写「等待处理」。
  const blocking = state.capabilities.approvalMode === "blocking";
  let timer = null;
  if (blocking) {
    const deadline = Date.parse(event.deadlineAt || "");
    const tick = () => {
      if (!Number.isFinite(deadline)) {
        remain.textContent = "";
        return;
      }
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      remain.textContent = left > 0 ? `剩余 ${left} 秒，超时按拒绝处理` : "已超时";
    };
    tick();
    timer = setInterval(tick, 1000);
  } else {
    remain.textContent = "等待处理";
  }
  meta.append(remain);
  card.append(meta);

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const rememberLabel = document.createElement("label");
  rememberLabel.className = "approval-remember";
  const remember = document.createElement("input");
  remember.type = "checkbox";
  rememberLabel.append(remember, document.createTextNode("本会话记住这个工具"));
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "ghost";
  approve.textContent = "批准";
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "ghost";
  reject.textContent = "拒绝";
  actions.append(rememberLabel, approve, reject);
  card.append(actions);

  const decide = async (decision) => {
    approve.disabled = true;
    reject.disabled = true;
    remember.disabled = true;
    try {
      const response = await request(
        `/api/v1/agent/approvals/${encodeURIComponent(event.callId)}`,
        {
          method: "POST",
          body: JSON.stringify({ decision, remember: remember.checked }),
        },
      );
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      const label = {
        approved: "已批准",
        rejected: "已拒绝",
        timeout: "已超时（按拒绝处理）",
        aborted: "本轮已停止",
      }[data.status];
      remain.textContent = label || String(data.status || "已处理");
      clearInterval(timer);
      approvalCards.delete(event.callId);
      card.classList.add("resolved");
    } catch {
      remain.textContent = "答复失败，请重试";
      approve.disabled = false;
      reject.disabled = false;
      remember.disabled = false;
    }
  };
  approve.addEventListener("click", () => void decide("approve"));
  reject.addEventListener("click", () => void decide("reject"));

  approvalCards.set(event.callId, { root: card, timer });
  return card;
}

/* ── 课题提议卡（2026-11-07 批二）─────────────────────────
   总管调 propose_topic 后，工具结果里带 proposalId / question / flavor / cron。
   前端在该条工具消息处渲染一张卡（照审批卡的 attention 形态），按 callId 去重；
   状态不靠内存：每次渲前 GET /topics/proposals/:id 定态，刷新页面也能按 transcript 重渲。
   接口失败不弹全局错误，卡内行内提示。 */
const topicProposalCards = new Map();
const TOPIC_FLAVOR_TEXT = { watch: "盯梢型 · 盯变化", dig: "啃题型 · 每周推进" };
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** cron → 人话：只认「分 时 * * 周几」这种周节奏；其它原样展示（不猜）。 */
function humanCron(cron) {
  const raw = String(cron || "").trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return raw;
  if (dayOfMonth !== "*" || month !== "*") return raw;
  const mm = Number(minute);
  const hh = Number(hour);
  if (mm > 59 || hh > 23) return raw;
  const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  if (dayOfWeek === "*") return `每天 ${clock}`;
  const days = dayOfWeek.split(",").map((item) => item.trim());
  if (!days.length || days.some((item) => !/^[0-7]$/.test(item))) return raw;
  return `每${days.map((item) => WEEKDAY_NAMES[Number(item) % 7]).join("、")} ${clock}`;
}

function shortDateTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 工具输出 → 提议数据；只有 ok:true 且带 proposalId 的才建卡（失败交给正文说明）。 */
function parseTopicProposalOutput(output) {
  if (typeof output !== "string") return null;
  const text = output.trim();
  if (!text.startsWith("{")) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.ok !== true) return null;
  if (typeof data.proposalId !== "string" || !data.proposalId) return null;
  if (typeof data.question !== "string" || !data.question.trim()) return null;
  return {
    proposalId: data.proposalId,
    question: data.question.trim(),
    flavor: data.flavor === "dig" ? "dig" : "watch",
    cron: typeof data.cron === "string" && data.cron.trim() ? data.cron.trim() : "0 9 * * 1",
  };
}

function mountTopicProposalCard(host, data) {
  if (!host || !data) return;
  if (topicProposalCards.has(data.proposalId)) return;

  const card = document.createElement("section");
  card.className = "attention topic-proposal";
  card.dataset.proposalId = data.proposalId;

  const title = document.createElement("p");
  title.className = "attention-text";
  title.textContent = "提议长期跟进这个课题";

  const question = document.createElement("p");
  question.className = "topic-proposal-q";
  question.textContent = data.question;

  const meta = document.createElement("div");
  meta.className = "topic-proposal-meta";
  const flavor = document.createElement("span");
  flavor.className = "pill-tag topic-flavor";
  flavor.dataset.flavor = data.flavor;
  flavor.textContent = TOPIC_FLAVOR_TEXT[data.flavor];
  const rhythm = document.createElement("span");
  rhythm.textContent = `节奏：${humanCron(data.cron)}`;
  meta.append(flavor, rhythm);

  const expiry = document.createElement("div");
  expiry.className = "topic-proposal-expiry";

  const state = document.createElement("p");
  state.className = "topic-proposal-state";
  state.hidden = true;

  const actions = document.createElement("div");
  actions.className = "topic-proposal-actions";
  actions.hidden = true;
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "btn-primary";
  accept.textContent = "开课题";
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "ghost";
  decline.textContent = "不用了";
  actions.append(accept, decline);

  const note = document.createElement("p");
  note.className = "topic-proposal-note";

  card.append(title, question, meta, expiry, state, actions, note);
  host.append(card);
  topicProposalCards.set(data.proposalId, card);
  void hydrateTopicProposalCard(card);
}

function setTopicProposalNote(card, text, isError = false) {
  const note = card.querySelector(".topic-proposal-note");
  if (!note) return;
  note.textContent = text || "";
  note.classList.toggle("is-error", Boolean(isError) && Boolean(text));
}

/** 按服务端状态定卡：pending 出按钮；accepted / declined / expired 只留灰化文案。 */
async function hydrateTopicProposalCard(card) {
  const proposalId = card.dataset.proposalId;
  const actions = card.querySelector(".topic-proposal-actions");
  const stateEl = card.querySelector(".topic-proposal-state");
  const expiry = card.querySelector(".topic-proposal-expiry");
  const proposalPath = `/api/v1/topics/proposals/${encodeURIComponent(proposalId)}`;

  let proposal = null;
  try {
    const response = await request(proposalPath, { cache: "no-store" });
    if (response.status === 404) {
      if (actions) actions.hidden = true;
      setTopicProposalNote(card, "这条提议查不到了（可能已被清理）。");
      return;
    }
    if (!response.ok) {
      if (actions) actions.hidden = true;
      setTopicProposalNote(card, `没法确认这条提议的状态（${response.status}），稍后再试。`);
      return;
    }
    const payload = await response.json();
    proposal = payload.proposal || null;
  } catch {
    if (actions) actions.hidden = true;
    setTopicProposalNote(card, "读不到提议状态，检查服务是否在跑。");
    return;
  }
  if (!proposal || !proposal.status) {
    if (actions) actions.hidden = true;
    setTopicProposalNote(card, "服务端没回提议状态，稍后再试。");
    return;
  }

  if (expiry) {
    expiry.textContent = proposal.expiresAt
      ? `有效期到 ${shortDateTime(proposal.expiresAt)}（72 小时没处理就过期）`
      : "";
  }

  const paintDone = (text) => {
    card.classList.add("resolved");
    if (actions) actions.hidden = true;
    if (stateEl) {
      stateEl.hidden = false;
      stateEl.textContent = text;
    }
  };

  if (proposal.status === "accepted") {
    paintDone("已开课题，会按这个节奏研究。");
    return;
  }
  if (proposal.status === "declined") {
    paintDone("已谢绝。");
    return;
  }
  if (proposal.status === "expired") {
    paintDone("这条提议已经过期了（72 小时没处理）。");
    return;
  }

  // pending：两个按钮
  if (actions) actions.hidden = false;
  const accept = card.querySelector(".topic-proposal-actions .btn-primary");
  const decline = card.querySelector(".topic-proposal-actions .ghost");
  if (!accept || !decline) return;
  let busy = false;

  const fail = (message) => {
    setTopicProposalNote(card, message, true);
    accept.disabled = false;
    decline.disabled = false;
    busy = false;
  };

  accept.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    accept.disabled = true;
    decline.disabled = true;
    setTopicProposalNote(card, "");
    try {
      const response = await request(`${proposalPath}/accept`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        paintDone("已开课题，会按这个节奏研究。");
        void loadTopicsSidebar();
        return;
      }
      // 400 的业务拒绝（search_not_configured / topic_limit / exists / expired / not_found）
      setTopicProposalNote(card, payload.message || "开课题失败，稍后再试。", true);
      accept.disabled = false;
      decline.disabled = false;
      busy = false;
      if (payload.error === "search_not_configured") {
        const note = card.querySelector(".topic-proposal-note");
        const link = document.createElement("button");
        link.type = "button";
        link.className = "attention-link topic-proposal-link";
        link.textContent = "去设置里配搜索";
        link.addEventListener("click", () => go("settings", "service"));
        note?.append(document.createTextNode(" "), link);
      }
    } catch {
      fail("请求没发出去，检查服务是否在跑。");
    }
  });

  decline.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    accept.disabled = true;
    decline.disabled = true;
    setTopicProposalNote(card, "");
    try {
      const response = await request(`${proposalPath}/decline`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        paintDone("已谢绝。");
        return;
      }
      fail(payload.message || "谢绝失败，稍后再试。");
    } catch {
      fail("请求没发出去，检查服务是否在跑。");
    }
  });
}

/** 刷新/切会话时补挂还挂着的审批（只补没画过的） */
async function loadPendingApprovals(conversationId) {
  if (!conversationId || state.conversationId !== conversationId) return;
  try {
    const response = await request(
      `/api/v1/agent/approvals?conversationId=${encodeURIComponent(conversationId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const data = await response.json();
    // 请求期间用户切了会话：审批卡不能挂到别人的屏幕上
    if (state.conversationId !== conversationId) return;
    for (const item of data.approvals || []) {
      if (approvalCards.has(item.callId)) continue;
      // 来源行要会话 id：服务端已回（2026-11-08 批三），老服务端缺就用当前会话
      const card = renderApprovalCard({ ...item, conversationId: item.conversationId || conversationId });
      if (!card) continue;
      hideEmpty();
      el.thread.append(card);
    }
    if (state.stick) scrollToEnd();
  } catch {
    /* 离线 / 未配置：补挂失败不影响对话 */
  }
}

/**
 * 忙时插话（2026-11-07 消息即引导）。
 *
 * 为什么不复用 send()：send 是"开一轮"的路径（建气泡、setSending、主流渲染）。
 * 插话属于**已经在跑的那一轮**，再开一个气泡会让同一轮出现两个回答框。
 *
 * 渲染归属（这是本函数唯一容易做错的地方）：插话请求也有一条自己的 SSE 流，
 * 而内核把同一轮的增量同时推给两个订阅者。如果这里也画，屏幕上会出现两份正文。
 * 所以本函数**只消费 notice（受理回执），不画正文**——那一轮的回答由正在跑的
 * 主流继续追加。没赶上边界时（模型已经收尾）会由服务端的 notice 说明，
 * 用户看到的仍是"这句话被受理了"，不会假装它已经生效。
 *
 * 断流不取消工作：reader.cancel() 只停这条连接的推送，那一轮照原样跑完。
 */
async function steerIntoTurn(text) {
  if (!text) return;
  if (!state.conversationId) {
    // 还没有会话可插（新会话第一轮还没拿到 start 帧）：这句留在输入框，
    // 本地队列已退役（扫尾批 8a），不能让它变成一个没有落点的动作
    el.input.value = text;
    resize();
    addNotice("这一轮还没跑起来，这句先留在输入框。");
    return;
  }
  const bubble = addMessage("user", text, Date.now());
  try {
    const response = await request("/api/v1/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.conversationId,
        messages: [{ role: "user", content: text }],
        whenBusy: "steer",
      }),
    });
    if (!response.ok || !response.body) {
      // 服务端根本没受理：气泡撤回——屏幕上不能留一条服务端没收到的话
      bubble.root.remove();
      addNotice("插话没发出去，已经放回输入框。");
      el.input.value = text;
      resize();
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let receipt = null;
    // 读到**回执**为止（2026-11-07 修）：受理回执在 start 帧之后才 yield，
    // 两者几乎必然不在同一个 chunk——按"读到 start 就停"会把回执整个丢掉。
    // 上限只防服务端失联挂死，正常路径一两帧就出去了。
    for (let guard = 0; guard < 64 && receipt === null; guard += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0 && receipt === null) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (typeof event.seq === "number" && event.seq > state.maxSeq) {
            state.maxSeq = event.seq;
          }
          // 只认回执：正文归主流画，这里多看一个字都会变成重复输出
          if (event.type === "notice") receipt = event;
        }
      }
    }
    await reader.cancel().catch(() => undefined);
    if (receipt) {
      addNotice(receipt.text || "");
      // 竞态兜底（2026-11-07 修）：刚好收尾时这句补充成了**新的一轮**，正文从
      // 这条短连接上流——而它只收回执。不给机器可读落点就没法分辨这种情况
      // （契约 notice.steer=new-turn），只能收尾后全量回读一次补上。
      if (receipt.steer === "new-turn") scheduleTurnReconcile(state.conversationId);
    }
  } catch {
    addNotice("插话的结果没确认，稍后看这一轮正文有没有带上它。");
  }
}

/**
 * 轮末回读（2026-11-07 修，2026-11-08 扫尾批 8a 扩展到「排队插话」）。
 *
 * 用在两种"正文画在别处"的情形：
 *   1. 插话刚好收尾，这句补充成了**新的一轮**（notice.steer=new-turn）；
 *   2. 忙时排队的那句（whenBusy=followUp）变成下一轮跑完了——那条短连接按约定不画正文。
 * 两条都没有客户端在画那一轮的正文，等这一轮尘埃落定就全量回读一次。
 * "落定"的判据是 transcript 尾条从我们那句插话（user）变成了回答（assistant）——
 * 这轮在服务端跑，客户端没有它的流，`state.sending` 帮不上忙。
 * 回读走 openChat 的服务端事实源重建，不会跟在跑的主流重复。
 */
let turnReconcile = null;

function scheduleTurnReconcile(conversationId) {
  if (turnReconcile) {
    clearInterval(turnReconcile.timer);
  }
  const ticket = { conversationId, tries: 0, timer: 0 };
  turnReconcile = ticket;
  ticket.timer = setInterval(async () => {
    // 人切走了会话：这次插话不归这屏管，切回去本来就会全量回读
    if (state.conversationId !== ticket.conversationId) {
      clearInterval(ticket.timer);
      turnReconcile = null;
      return;
    }
    ticket.tries += 1;
    if (ticket.tries > 150) {
      // 5 分钟还没落定（服务端失联 / 这轮没产出回答）：放弃，用户刷新可见
      clearInterval(ticket.timer);
      turnReconcile = null;
      return;
    }
    let settled = false;
    try {
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(ticket.conversationId)}/messages?limit=1`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const data = await response.json();
        const messages = data.messages || [];
        const last = messages[messages.length - 1];
        settled = Boolean(last && last.role === "assistant");
      }
    } catch {
      /* 网络打嗝：下一轮再试 */
    }
    if (!settled) return;
    // 回答已经在盘上；若用户恰又开了新一轮（主流在画），等它收尾再重建
    if (state.sending) return;
    clearInterval(ticket.timer);
    turnReconcile = null;
    void openChat(ticket.conversationId);
  }, 2000);
}

/* ── 忙时排队（扫尾批 8a：插话队列服务端化）──────────────
   语义没变：忙时按下的 Enter 仍是"下一轮的指令"（whenBusy=followUp）。变的是落点——
   以前先塞进浏览器内存里的本地数组、本轮结束后由前端补发（刷新即丢），
   现在直接提交给服务端，内核写进 durable 的 inbox（2026-11-07 消息即引导批起的
   既有能力），刷新 / 断线后话还在，按提交顺序被消费。
   前端只是视图，不造第二份事实：排队状态以 transcript 里的条目为准。 */
let pendingFollowUps = 0;

/**
 * 忙时排队提交（2026-11-08 扫尾批 8a）。
 *
 * 渲染归属：这条连接上流的是**已经在跑的这一轮**（内核把同一轮同时推给两个订阅者），
 * 后面还会接上排队那句变成的下一轮，所以这里不画正文——画了就是两份。
 * 乐观气泡先上屏（发即上屏），归位靠这条连接跑完后的回读（scheduleTurnReconcile）。
 * 也正因为这样，这条流要读到底：它收尾 = 排进来的那一轮也跑完了。
 */
async function followUp(text) {
  if (!text) return;
  if (!state.conversationId) {
    // 新会话的第一轮还没拿到 start 帧：此时提交会**新建一条会话**，把话送错地方。
    // 这句留在输入框，等这一轮跑起来再发。
    el.input.value = text;
    resize();
    addNotice("这一轮还没跑起来，这句先留在输入框。");
    return;
  }
  const conversationId = state.conversationId;
  const bubble = addMessage("user", text, Date.now());
  try {
    const response = await request("/api/v1/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        messages: [{ role: "user", content: text }],
        whenBusy: "followUp",
      }),
    });
    if (!response.ok || !response.body) {
      // 服务端根本没受理：气泡撤回，话放回输入框（与插话同一条口径）
      bubble.root.remove();
      addNotice("这条没发出去，已经放回输入框。");
      el.input.value = text;
      resize();
      return;
    }
    pendingFollowUps += 1;
    void new Response(response.body)
      .text()
      .catch(() => "")
      .finally(() => {
        pendingFollowUps -= 1;
        // 还有排队的连接在跑：等最后一轮跑完再回读，免得把还没轮到的气泡刷掉
        if (pendingFollowUps > 0) return;
        if (state.conversationId !== conversationId) return;
        scheduleTurnReconcile(conversationId);
      });
  } catch {
    bubble.root.remove();
    addNotice("这条没发出去，已经放回输入框。");
    el.input.value = text;
    resize();
  }
}

async function send(text, images = []) {
  if (state.sending) return;
  setSending(true);
  state.stopRequested = false;
  state.lastUserText = text; // 错误行的「重试」用（批次一）
  state.stick = true;
  const turnStartMs = Date.now();
  // 通知与「正看着这个会话」的静默判定要用这一轮的会话 id（批次二）
  let streamConv = state.conversationId;

  // 建流前补挂：刷新后 SSE 不会重发历史审批，只能主动拉一次
  await loadPendingApprovals(state.conversationId);

  // 标题跟着「这一屏的第一句」走，而不是跟着 conversationId 走：
  // mock 模式也会发 start，本地留下的 id 是假的，按 id 判断会一直不更新。
  const firstTurn = !el.thread.querySelector(".msg");
  addMessage("user", text, Date.now(), images);
  if (firstTurn) el.title.textContent = (text || "图片").replace(/\s+/g, " ").slice(0, 40);
  // 刚发出的这条就是最后一句话：编辑入口跟上去（messageId 在点的时候再补）
  syncEditEntry();
  const turn = addMessage("assistant", "", Date.now());
  const body = turn.body;
  const caret = document.createElement("span");
  caret.className = "caret";
  body.append(caret);

  // 思考折叠卡（批次一，对齐 cindy ThinkingCard）：全态默认折叠，
  // 流式中计时跳秒，正文开始后定格。thinking 增量都往同一张卡里追加。
  let thinkEl = null;
  let thinkSummary = null;
  let thinkBody = null;
  let thinkStartMs = 0;
  let thinkLastMs = 0;
  let thinkTimer = 0;
  let answered = false;

  // 工作过程块：有工具才建（第一只工具动手时），建了就一直在正文下方。
  // 运行中默认展开，收尾折成一行——不是先给结论再看过程。
  let work = null;
  const ensureWork = () => {
    if (!work) work = createWorkPanel(turn.root);
    return work;
  };
  // 派活行（2026-11-07 修）：按 ticketId 一单一行，进度帧更新、终态帧收行。
  // 轮收尾还在跑的由 finally 里 handoff 画「已转后台」——chancellor 比轮活得久。
  const delegateRows = new Map();
  const delegateRowOf = (event) => {
    let entry = delegateRows.get(event.ticketId);
    if (!entry) {
      entry = ensureWork().track(
        `${event.done}/${event.total} ${event.current || event.lastAction || ""}`.trim(),
      );
      delegateRows.set(event.ticketId, entry);
    }
    return entry;
  };
  const ensureThinkCard = () => {
    if (thinkEl) return;
    thinkEl = document.createElement("details");
    thinkEl.className = "think";
    thinkSummary = document.createElement("summary");
    thinkSummary.textContent = "思考中…";
    thinkBody = document.createElement("div");
    thinkBody.className = "think-body";
    thinkEl.append(thinkSummary, thinkBody);
    turn.root.prepend(thinkEl);
    thinkStartMs = Date.now();
    thinkTimer = setInterval(() => {
      if (thinkEl && !answered) {
        thinkSummary.textContent = `思考中… ${Math.round((Date.now() - thinkStartMs) / 1000)}s`;
      }
    }, 500);
  };
  const endThinkCard = () => {
    if (!thinkEl || answered) return;
    answered = true;
    clearInterval(thinkTimer);
    thinkSummary.textContent = `已思考 ${Math.max(1, Math.round((thinkLastMs - thinkStartMs) / 1000))}s`;
  };

  let answer = "";
  let frame = 0;
  // 这一轮已经用后端给的具体文案解释过「没有回复」时，结尾就不再补兜底的"模型没有返回内容。"
  let noReplyExplained = false;
  const paint = () => {
    frame = 0;
    if (!body.isConnected) return;
    body.innerHTML = renderMarkdown(answer);
    if (state.sending) body.append(caret);
    if (state.stick) scrollToEnd();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  // 断点重放（2026-11-04 seq 方案）：这一轮流中途断掉时（连接中断、done 没等到），
  // 带 sinceSeq 回 /messages 补缺帧。窗口滑过（fromSeq > maxSeq+1）只能提示重建，
  // 不试图自动补——那是全量回读 openChat 的事。正常收尾（见过 done）不补。
  let sawDone = false;
  const replayMissing = async () => {
    if (sawDone || !state.conversationId || !state.maxSeq) return;
    try {
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/messages?sinceSeq=${state.maxSeq}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const data = await response.json();
      const events = data.events || [];
      if (!events.length) return;
      if (typeof data.fromSeq === "number" && data.fromSeq > state.maxSeq + 1) {
        addError("有事件已经超出补帧窗口，这条会话建议刷新页面重建。", { retryable: false });
        return;
      }
      for (const replayed of events) {
        const event = replayed.event || replayed;
        if (typeof event.seq === "number" && event.seq > state.maxSeq) {
          state.maxSeq = event.seq;
        }
        // 与主流分发同一套消费逻辑的子集：跨轮还在跑的活，只补"要人管"的帧。
        if (event.type === "attention") {
          applyTicketEvent({ ...event, phase: "needs_you" });
          maybeNotify("有任务单需要你处理", event.question || "", state.conversationId, "attention");
        } else if (event.type === "approval") {
          const card = renderApprovalCard({ ...event, conversationId: state.conversationId });
          if (card && !card.isConnected) turn.root.before(card);
          maybeNotify("有写操作需要你确认", event.tool || "", state.conversationId, "attention");
        } else if (event.type === "done") {
          // 补帧拿到的 done 也算收尾：完成时间与用时一起落，不然断线重连后这条没有脚注
          markDoneAt(turn.root, Date.now());
          attachUsage(turn.root, event.usage || { input: 0, output: 0, cacheRead: 0 }, Date.now() - turnStartMs);
        } else if (event.type === "delegate") {
          applyTicketEvent(event);
        }
      }
    } catch {
      // 补帧失败就失败：主链路的错误行已经报过了，这里不再叠一条。
    }
  };

  try {
    const response = await request("/api/v1/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        ...(state.conversationId
          ? { conversationId: state.conversationId }
          : { chatKind: state.chatKind === "chief" ? "chief" : "worker" }),
        // 有图才用分段数组；纯文本仍发字符串（老形状，服务端 union 兼容）
        messages: [
          {
            role: "user",
            content: images.length
              ? [
                  ...(text ? [{ type: "text", text }] : []),
                  ...images.map((image) => ({
                    type: "image",
                    mimeType: image.mimeType,
                    data: image.data,
                  })),
                ]
              : text,
          },
        ],
      }),
    });

    if (response.status === 404 && state.conversationId) {
      // 服务重启过、或者那个会话已经不在：当新会话重发一次。
      state.conversationId = "";
      localStorage.removeItem(KEY_CONV);
      body.remove();
      setSending(false);
      return send(text, images);
    }
    if (!response.ok || !response.body) {
      body.remove();
      addError(`请求失败：HTTP ${response.status}`, { retryable: true });
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          // seq 游标（2026-11-04 seq 方案）：只认单调前进的，防重放帧把游标拉回去。
          if (typeof event.seq === "number" && event.seq > state.maxSeq) {
            state.maxSeq = event.seq;
          }
          if (event.type === "start") {
            state.conversationId = event.conversationId;
            streamConv = event.conversationId;
            localStorage.setItem(KEY_CONV, event.conversationId);
            renderChats();
            // 新会话（或重启后的旧会话）要立刻出现在侧栏里——
            // 以前只靠页面加载时拉一次，新建会话要等到重载才可见，置顶/重命名都够不着
            void loadChats();
            // 新会话建好了，把当前思考档补发给它（off 是服务端默认，不用发）
            if (currentThinking() !== "off") void setThinkingLevel(currentThinking());
          } else if (event.type === "thinking") {
            // 思考正文增量（批次一）：进折叠卡。占位行没有了——
            // 「在想」这件事由思考卡自己的表头表达（2026-11-07）
            ensureThinkCard();
            thinkLastMs = Date.now();
            thinkBody.textContent += event.text || "";
            if (state.stick) scrollToEnd();
          } else if (event.type === "notice") {
            // 系统提示行（2026-11-07 消息即引导）：插话/排队的诚实回执。
            // 独立成行，不并进这一轮的正文（answer 不追加）。
            addNotice(event.text || "");
          } else if (event.type === "delta") {
            answer += event.text;
            endThinkCard();
            schedule();
          } else if (event.type === "progress") {
            // 「在想」由思考卡表头表达；「在动手」由工作过程块表头表达。
            // 这里不再插占位行——两处表头已经是同一件事的第二份说法。
          } else if (event.type === "tool") {
            if (event.status === "start") ensureWork().start(event.name, event.label, event.args);
            else {
              ensureWork().end(event.name, event.ok !== false, event.output, event.diff);
              // 课题提议（2026-11-07 批二）：结果落在该条工具消息处（对话末尾自然出现）
              if (event.name === "propose_topic" && event.ok !== false) {
                mountTopicProposalCard(turn.root, parseTopicProposalOutput(event.output));
              }
            }
            if (state.stick) scrollToEnd();
          } else if (event.type === "delegate") {
            // 派活也是一步：进同一个工作过程块，不再另起一行飘在正文上方。
            // 行的生死跟 phase 走：终态帧（done / needs_you / aborted / failed）
            // 一定有一帧，到了就收行；还在跑的由收尾 handoff 兜底（见 delegateRows）。
            const row = delegateRowOf(event);
            row.setLabel(`${event.done}/${event.total} ${event.current || event.lastAction || ""}`.trim());
            if (event.phase === "done" || event.phase === "needs_you") {
              row.close(true, event.message || "");
            } else if (event.phase === "aborted" || event.phase === "failed") {
              row.close(false, event.message || "");
            }
            syncDelegateHint(turn.root, event);
            applyTicketEvent(event);
            if (state.stick) scrollToEnd();
          } else if (event.type === "attention") {
            applyTicketEvent({ ...event, phase: "needs_you" });
            const card = document.createElement("div");
            card.className = "attention";
            const text = document.createElement("p");
            text.className = "attention-text";
            text.textContent = event.question || "它在等你回答。";
            card.append(text);
            if (event.ticketId) {
              const link = document.createElement("a");
              link.className = "attention-link";
              link.href = `#/tasks?ticket=${encodeURIComponent(event.ticketId)}`;
              link.textContent = "去任务中心处理";
              card.append(link);
            }
            body.before(card);
            maybeNotify("有任务单需要你处理", event.question || "", streamConv, "attention");
            if (state.stick) scrollToEnd();
          } else if (event.type === "approval") {
            // 写类工具要确认（批次二）：卡片挂在回答气泡上方，和 attention 同一套视觉
            const card = renderApprovalCard({ ...event, conversationId: streamConv });
            if (card && !card.isConnected) body.before(card);
            maybeNotify("有写操作需要你确认", event.tool || "", streamConv, "attention");
            if (state.stick) scrollToEnd();
          } else if (event.type === "done") {
            sawDone = true;
            if (event.finishReason === "error" && !answer) {
              if (!noReplyExplained) addError("这一轮出错了。", { retryable: true });
              maybeNotify("这一轮没答上来", el.title.textContent || "对话", streamConv, "error");
            } else {
              maybeNotify("Selenite 回复完成", el.title.textContent || "对话", streamConv, "done");
            }
            // 完成时间先落（finishReason=error 时也要留痕），再落用时；
            // 模型没回 usage 的轮次至少还有"多久"这一项，不是一片空白。
            markDoneAt(turn.root, Date.now());
            attachUsage(turn.root, event.usage || { input: 0, output: 0, cacheRead: 0 }, Date.now() - turnStartMs);
            void syncCtxMeter();
          } else if (event.type === "unanswered") {
            // 后端明确说「这次没能生成回复」：用它的文案，别让结尾兜底再补一句笼统的"模型没有返回内容。"
            noReplyExplained = true;
            addError(event.message);
            maybeNotify("这一轮没答上来", el.title.textContent || "对话", streamConv, "error");
            if (state.stick) scrollToEnd();
          } else if (event.type === "error") {
            // 后端把 unanswered 透成 error 帧时（index.ts 收尾兜底），文案就是那句具体提示，
            // 同样记下，避免结尾再叠一条"模型没有返回内容。"
            noReplyExplained = true;
            addError(event.message || "出错了", { retryable: true });
            maybeNotify("Selenite 出错了", event.message || "", streamConv, "error");
          }
        }
      }
    }
    caret.remove();
    paint();
    if (!answer.trim() && !noReplyExplained) {
      addError("模型没有返回内容。", { retryable: true });
    }
  } catch (error) {
    if (error.message !== "forbidden") {
      addError(`连接中断：${error.message}`, { retryable: true });
      // 流是断着结束的：done 没等到，可能缺帧。带 seq 去补一次（2026-11-04 seq 方案）。
      await replayMissing();
    }
  } finally {
    setSending(false);
    caret.remove();
    endThinkCard();
    clearInterval(thinkTimer);
    if (state.stopRequested) {
      // 人的明确中断：给一行痕迹，区别于"模型自己没话说"（批次一）
      const note = document.createElement("div");
      note.className = "msg stopped";
      note.textContent = "已中断生成。";
      el.thread.append(note);
      if (state.stick) scrollToEnd();
    }
    if (body.isConnected) body.innerHTML = renderMarkdown(answer);
    // 收尾：工作过程折成一行「已工作 Ns · M 步」，点开还是刚才那些步骤。
    // 人点了停止 → 标 interrupted（表头写"已中断"），不能画成正常完成。
    // 派活行先 handoff：它不在 open 队列里，finish 不管；没终态帧的说明
    // chancellor 还在后台跑，画「已转后台」，不能算进失败（2026-11-07 修）。
    for (const row of delegateRows.values()) row.handoff();
    if (work) work.finish(state.stopRequested ? "interrupted" : "completed");
    // 忙时排队的那些话由服务端按序消费（扫尾批 8a），这里不再有轮末补发：
    // 它们要么已经作为插话落进这一轮，要么在 durable 的 inbox 里等下一轮。
    el.input.focus();
  }
}

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
let modalTimer = 0;
let modalReturnFocus = null;

function modalOpen() {
  return Boolean(el.modal) && !el.modal.hidden;
}

function openModal(title, build, { className = "" } = {}) {
  if (!el.modal) return;
  const wasOpen = modalOpen();
  clearTimeout(modalTimer);
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
  // 每次打开都重置，避免上一次的宽档泄漏到下一次的确认框。
  const panel = el.modal.querySelector(".modal-panel");
  if (panel) {
    panel.classList.remove("modal-wide");
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
  };
  if (noMotion.matches) {
    finish();
    return;
  }
  modalTimer = setTimeout(finish, MODAL_MS);
}

el.modalMask?.addEventListener("click", closeModal);
el.modalClose?.addEventListener("click", closeModal);

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

/* ── 收起轨道 tooltip（右侧弹出）──────────────────────────
 * 挂在 body 下而不是 ::after：.sidebar 收起动画靠 overflow:hidden 裁内容，
 * 伪元素会被一起裁掉。 */
function hideRailTip() {
  if (el.railTip) el.railTip.hidden = true;
}

function showRailTip(trigger) {
  if (!el.railTip || !trigger) return;
  // 展开态轨道整体 pointer-events:none；键盘 Tab 进来时也别弹一个看不见的提示
  const rail = trigger.closest(".side-rail");
  if (rail && getComputedStyle(rail).pointerEvents === "none") return;
  const text = trigger.dataset.tip;
  if (!text) return;
  const anchor = trigger.getBoundingClientRect();
  el.railTip.textContent = text;
  el.railTip.hidden = false;
  const gap = 10;
  const maxLeft = window.innerWidth - 8 - el.railTip.offsetWidth;
  const left = Math.min(anchor.right + gap, Math.max(8, maxLeft));
  el.railTip.style.left = `${Math.round(left)}px`;
  el.railTip.style.top = `${Math.round(anchor.top + anchor.height / 2)}px`;
  el.railTip.style.transform = "translateY(-50%)";
}

for (const node of document.querySelectorAll("#side-rail [data-tip]")) {
  node.addEventListener("mouseenter", () => showRailTip(node));
  node.addEventListener("mouseleave", hideRailTip);
  node.addEventListener("focus", () => showRailTip(node));
  node.addEventListener("blur", hideRailTip);
  // 点了就走：别让提示压在刚打开的弹层/新页面上面
  node.addEventListener("click", hideRailTip);
}
window.addEventListener("resize", hideRailTip);

async function fetchModelCatalog() {
  const response = await request("/api/v1/agent/model", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function modelLabel(catalog) {
  const current = catalog && catalog.current;
  if (!current) return "未配置模型";
  const provider = (catalog.providers || []).find((item) => item.id === current.providerId);
  return `${provider ? provider.name : current.providerId} · ${current.modelId}`;
}

/** pill 文字滚动（2026-11-05，ZCode RollingToolbarLabel 同拍 200ms）：
 *  换模型时旧字向上滚出淡去、新字从下方滚入。外层 span 是裁切罩
 *  （沿用 .composer-pill > span 的 overflow），真正动的是内层 .pill-label-text。
 *  文字没变（例行刷新）不播。 */
function setModelPillLabel(text) {
  const wrap = el.modelPillLabel;
  if (!wrap) return;
  const current = wrap.querySelector(".pill-label-text");
  if ((current ? current.textContent : wrap.textContent) === text) return;
  const enter = document.createElement("span");
  enter.className = "pill-label-text";
  enter.textContent = text;
  if (!current || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    wrap.replaceChildren(enter);
    return;
  }
  const exit = document.createElement("span");
  exit.className = "pill-label-text pill-label-exit";
  exit.setAttribute("aria-hidden", "true");
  exit.textContent = current.textContent;
  enter.classList.add("pill-label-enter");
  wrap.replaceChildren(enter, exit);
  // 播完归位：enter 摘掉动画类，exit 拆走；定时器兜底 animationend 丢失
  const clean = () => {
    enter.classList.remove("pill-label-enter");
    exit.remove();
  };
  enter.addEventListener("animationend", clean, { once: true });
  setTimeout(() => { if (exit.isConnected) clean(); }, 300);
}

function updateModelPill(catalog = state.modelCatalog) {
  if (!el.modelPillLabel) return;
  setModelPillLabel(modelLabel(catalog));
  syncThinkingPill(catalog);
  if (el.modelPill) {
    el.modelPill.title = catalog && catalog.current
      ? `当前：${modelLabel(catalog)}（点击切换，下一轮生效）`
      : "还没有可用的模型";
  }
}

async function refreshModelPill() {
  try {
    state.modelCatalog = await fetchModelCatalog();
    updateModelPill();
  } catch (error) {
    if (error.message !== "forbidden") updateModelPill(null);
  }
}

function closeModelMenu() {
  if (!el.modelMenu) return;
  closePopover(el.modelMenu, el.modelPill);
}

/** 模型行兼容两种形状：新的 `{id, thinkingLevels}` 与旧的裸字符串（后端未上线时兜底） */
function normalizeModelRow(row) {
  if (typeof row === "string") {
    return { id: row, thinkingLevels: ["off", "low", "high"], contextWindow: null, maxTokens: null };
  }
  if (!row || typeof row.id !== "string") return null;
  const declared = Array.isArray(row.thinkingLevels) ? row.thinkingLevels : [];
  const levels = THINKING_LEVELS.filter((level) => declared.includes(level));
  return {
    id: row.id,
    thinkingLevels: levels.length ? levels : ["off", "low", "high"],
    contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : null,
    maxTokens: Number.isFinite(row.maxTokens) ? row.maxTokens : null,
  };
}

/** 菜单里能上分段行的供应商：凡有模型的都上（2026-11-05）。
 *  没 key 的段照常显示，沿用「缺 env」徽标；点它的模型也能切（服务端允许），
 *  成功后 toast 提醒去环境里补 key。全家都 keyless 时菜单照样能看。 */
function menuProviders(catalog) {
  return (catalog.providers || []).filter(
    (provider) => Array.isArray(provider.models) && provider.models.length > 0,
  );
}

/** 打开时的落点：当前供应商 > 上次看的 > 第一家；点段则钉在点的那家 */
function resolveMenuProvider(catalog, providers, preferredId) {
  const currentId = (catalog.current && catalog.current.providerId) || "";
  const wanted = preferredId || currentId || localStorage.getItem(KEY_MODEL_PROVIDER) || "";
  return providers.find((provider) => provider.id === wanted) || providers[0];
}

function renderModelMenu(catalog, preferredProviderId, menu = el.modelMenu) {
  if (!menu) return;
  menu.replaceChildren();
  const current = catalog.current || null;
  const level = currentThinking();
  const providers = menuProviders(catalog);
  if (!providers.length) {
    const row = document.createElement("div");
    row.className = "model-menu-empty";
    row.textContent = "还没有可选模型：到设置 → 服务里添加供应商";
    menu.append(row);
    return;
  }
  const active = resolveMenuProvider(catalog, providers, preferredProviderId);

  // 供应商分段（D2）：一次只看一家，点段只换筛、不发请求；没有「全部」段
  const rail = document.createElement("div");
  rail.className = "provider-seg";
  rail.setAttribute("role", "group");
  rail.setAttribute("aria-label", "供应商");
  for (const provider of providers) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "provider-opt";
    opt.dataset.provider = provider.id;
    opt.setAttribute("aria-pressed", String(provider.id === active.id));
    opt.title = provider.name || provider.id;
    const name = document.createElement("span");
    name.textContent = provider.name || provider.id;
    opt.append(name);
    if (!provider.hasKey) {
      const badge = document.createElement("span");
      badge.className = "model-menu-warn";
      badge.textContent = "缺 env";
      opt.append(badge);
    }
    opt.addEventListener("click", () => {
      if (provider.id === active.id) return;
      localStorage.setItem(KEY_MODEL_PROVIDER, provider.id);
      renderModelMenu(catalog, provider.id, menu);
      // 重渲染换掉了刚点的按钮：焦点跟到新段上，键盘 Tab 还能继续走
      menu.querySelector('.provider-opt[aria-pressed="true"]')?.focus();
      // 宿主（对话快捷设置面板）靠这个事件同步「加到：某家」标签；模型菜单无人监听，无害
      menu.dispatchEvent(new CustomEvent("providerchange", { bubbles: true }));
    });
    rail.append(opt);
  }
  menu.append(rail);

  // 只列这一家的模型：分组头省了，段上已经写明是哪家
  for (const raw of active.models) {
    const model = normalizeModelRow(raw);
    if (!model) continue;
    const selected = Boolean(current && current.providerId === active.id && current.modelId === model.id);

    // 行 = 模型名（可点，选中行 ✓）；只有当前行额外挂档位分段（2026-11-05）
    const row = document.createElement("div");
    row.className = "model-row";
    // 统一写 "1"/"0"：CSS 当前行样式与 syncThinkingSegments / 焦点回位选择器都按 "1" 找
    // （原来写 "true"/"false"，那两处从来没命中过）
    row.dataset.current = selected ? "1" : "0";
    row.setAttribute("role", "none");

    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-item";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(Boolean(selected)));
    const contextText = model.contextWindow ? formatTokenCount(model.contextWindow) : "";
    item.title = `${active.name || active.id} · ${model.id}${contextText ? ` · ${contextText} 上下文` : ""}`;
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = model.id;
    item.append(name);
    if (contextText) {
      const meta = document.createElement("span");
      meta.className = "model-meta";
      meta.textContent = `上下文 ${contextText}`;
      item.append(meta);
    }
    // 选中行不放 ✓（2026-11-05 用户口径，同 cindy UnifiedModelRow 的裁决）：
    // 选中态已有强调色 + 加粗 + 档位分段，再挂勾是重复信号
    // 选中后菜单不关：重渲染出档位分段，接着选强度（D2 的「先选模型再选强度」）
    item.addEventListener("click", () => {
      void chooseModel(active, model.id, model.thinkingLevels, { keepOpen: true, menu });
    });
    row.append(item);

    // 档位分段只属于当前模型（2026-11-05 第二次强调）：非当前行完全不渲染，
    // 比禁用更干净，也杜绝「先点别家的档位再偷偷切模型」的两段请求。
    // 选中新模型后 keepOpen 就地重渲染，新当前行才长出分段。
    if (selected) {
      const seg = document.createElement("div");
      seg.className = "think-seg";
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", `${model.id} 的思考强度`);
      for (const optionLevel of model.thinkingLevels) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "think-opt";
        option.dataset.level = optionLevel;
        option.textContent = THINKING_LABELS[optionLevel];
        option.title = `思考强度：${THINKING_LABELS[optionLevel]}`;
        option.setAttribute("aria-pressed", String(level === optionLevel));
        option.addEventListener("click", () => void chooseCurrentThinking(optionLevel));
        seg.append(option);
      }
      row.append(seg);
    }
    menu.append(row);
  }
}

async function toggleModelMenu() {
  if (!el.modelMenu) return;
  if (popoverOpen(el.modelMenu)) {
    closeModelMenu();
    return;
  }
  el.modelPill.disabled = true;
  try {
    // 每次打开都现拉：不缓存陈旧目录（审查 S2）
    const catalog = await fetchModelCatalog();
    state.modelCatalog = catalog;
    updateModelPill();
    renderModelMenu(catalog);
    openPopover(el.modelMenu, el.modelPill);
  } catch (error) {
    if (error.message !== "forbidden") toast("拿不到模型清单");
  } finally {
    el.modelPill.disabled = false;
  }
}

async function chooseModel(provider, modelId, levels, { keepOpen = false, menu = null } = {}) {
  if (!keepOpen) closeModelMenu();
  try {
    const response = await request("/api/v1/agent/model", {
      method: "POST",
      body: JSON.stringify({ providerId: provider.id, modelId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(`没切成：${data.message || data.error || `HTTP ${response.status}`}`);
      return false;
    }
    const providerId = data.provider || provider.id;
    state.modelCatalog = {
      ...(state.modelCatalog || {}),
      current: { providerId, modelId: data.model || modelId },
    };
    // 服务端换模型会把不支持的档位落回 ≤ 当前档（off 兜底），本地跟着对齐。
    // levels 缺省（模型不在清单里、支持域未知）就不动本地档——宁可保留也不静默清成 off
    if (Array.isArray(levels) && levels.length) {
      localStorage.setItem(KEY_THINKING, clampThinking(currentThinking(), levels));
    }
    updateModelPill();
    // 菜单没关就就地重渲染：✓ 挪到新行、档位分段出现（D2：先选模型再选强度）
    const host = menu || el.modelMenu;
    if (keepOpen && host) {
      renderModelMenu(state.modelCatalog, providerId, host);
      // 重渲染把刚点的按钮换掉了：焦点跟到新行，键盘 Tab 能直接进档位
      host.querySelector('.model-row[data-current="1"] .model-item')?.focus();
    }
    toast(
      provider.hasKey === false
        ? "已切换；该供应商缺 API Key，聊天前请在服务端环境设置对应变量"
        : `下一轮起用 ${provider.name || providerId} · ${modelId}`,
    );
    return true;
  } catch (error) {
    if (error.message !== "forbidden") toast(`没切成：${error.message}`);
    return false;
  }
}

/** 当前模型行内换档：菜单不关，选中态就地刷新 */
async function chooseCurrentThinking(level) {
  if (level === currentThinking()) return;
  await setThinkingLevel(level);
}

/* ── 对话右上角快捷设置（2026-11-07 抽屉改造，替换同日下弹面板）──
 * 右上角图标按钮 → 右侧全高抽屉：首页四行（模型 / 权限档 / 通知 / 全部设置），
 * 控件全在二级页。底层聊天不卸载只挂浮层，滚动位置与输入内容天然保持。
 * 关闭三通道：Esc（输入法豁免）/ X / 点遮罩；关闭动画播完再卸载（照 popTimers 模式）。
 * 模型二级页整体搬入原下弹面板的模型菜单 + 批量加模型，渲染零语义改动。 */

const DRAWER_MS = 250;
let csPage = "home"; // home | persona | model | policy | notify
let csTimer = 0;
let csCatalog = null; // 打开抽屉时现拉的模型目录（同原「每次打开现拉」口径）
let csPolicy = null;  // 打开抽屉时顺带拉的权限档；失败保持 null（副文本显示 —）
let csTarget = null;  // 当前对话对应的执事（chief / 某 uuid）；决定「人设」改谁
let csDetail = null;  // 该执事详情（soul / soulVersion / modelChain）；人设页与备选副文本用
let csProviders = null; // 供应商全量投影（备选链要 keyEnv；模型目录里没有它）

const CS_TIMING_LABEL = { all: "全部", error: "仅出错", attention: "仅待你处理" };
const CS_POLICY_LABEL = { full: "完全访问", "read-only": "只读", "no-shell": "不跑命令" };

function drawerOpen() {
  return Boolean(el.chatSettingsDrawer) && !el.chatSettingsDrawer.hidden &&
    !el.chatSettingsDrawer.classList.contains("pop-closing");
}

function openDrawer() {
  const drawer = el.chatSettingsDrawer;
  const overlay = el.chatSettingsOverlay;
  if (!drawer || !overlay) return;
  clearTimeout(csTimer);
  drawer.classList.remove("pop-closing");
  overlay.classList.remove("pop-closing");
  drawer.hidden = false;
  overlay.hidden = false;
  el.chatSettingsBtn.setAttribute("aria-expanded", "true");
  if (noMotion.matches) return;
  // 先摘 class 并强制重排，连续开关时动画才会重放（同 openPopover）
  drawer.classList.remove("pop-open");
  overlay.classList.remove("pop-open");
  void drawer.offsetWidth;
  drawer.classList.add("pop-open");
  overlay.classList.add("pop-open");
}

function closeDrawer() {
  const drawer = el.chatSettingsDrawer;
  const overlay = el.chatSettingsOverlay;
  if (!drawer || drawer.hidden) return;
  el.chatSettingsBtn.setAttribute("aria-expanded", "false");
  clearTimeout(csTimer);
  const finish = () => {
    drawer.hidden = true;
    overlay.hidden = true;
    drawer.classList.remove("pop-open", "pop-closing");
    overlay.classList.remove("pop-open", "pop-closing");
    csPage = "home";
  };
  if (noMotion.matches) {
    finish();
    return;
  }
  drawer.classList.remove("pop-open");
  overlay.classList.remove("pop-open");
  void drawer.offsetWidth;
  drawer.classList.add("pop-closing");
  overlay.classList.add("pop-closing");
  csTimer = setTimeout(finish, DRAWER_MS);
}

function closeChatSettings() {
  closeDrawer();
}

async function toggleChatSettings() {
  if (drawerOpen()) {
    closeChatSettings();
    return;
  }
  el.chatSettingsBtn.disabled = true;
  try {
    // 每次打开都现拉：不缓存陈旧目录（同模型菜单口径）
    csCatalog = await fetchModelCatalog();
    state.modelCatalog = csCatalog;
    updateModelPill();
    csTarget = csResolveTarget();
    csPage = "home";
    csDetail = null;
    renderCsPage();
    openDrawer();
    // 权限档 / 人设详情顺带拉；回来若还停在对应页就重渲染补上
    void refreshCsPolicy();
    void refreshCsDetail();
  } catch (error) {
    if (error.message !== "forbidden") toast("拿不到模型清单");
  } finally {
    el.chatSettingsBtn.disabled = false;
  }
}

/**
 * 当前角色的详情（SOUL / 版本 / 候选链）。模型目录与供应商投影都不含这些，
 * 而「人设」和「备选模型」都要用，所以打开抽屉时拉一次、保存后再拉。
 */
async function refreshCsDetail({ after } = {}) {
  if (!csTarget) return;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(csTarget)}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    if (!data?.ok) return;
    csDetail = data;
    // 花名册里的头像 / 名字可能比详情旧，就手同步一份（侧栏也用这份缓存）
    const cached = state.partners.find((item) => item.id === csTarget);
    if (cached && data.partner) Object.assign(cached, data.partner);
    // 只在首页重渲染补副文本；人设页不整体重画——用户可能已经进去在打字了，
    // 详情恰好晚到会把草稿整个换掉。人设页确实在等数据时，走 after 回调自己重画一次。
    if (drawerOpen() && csPage === "home") renderCsPage();
    after?.();
  } catch {
    /* 拉不到就维持现有副文本，不拦抽屉 */
  }
}

/** 供应商全量投影：备选链每项要 keyEnv，模型目录（/agent/model）里没有这个字段 */
async function csLoadProviders() {
  if (csProviders) return csProviders;
  try {
    const response = await request("/api/v1/agent/providers", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    csProviders = Array.isArray(data.providers) ? data.providers : [];
    return csProviders;
  } catch {
    return null;
  }
}

/** 执事详情里的候选链（详情没拉到时回落到空，避免副文本报错） */
function partnerModelChain() {
  const chain = csDetail && Array.isArray(csDetail.modelChain) ? csDetail.modelChain : [];
  return chain;
}

async function refreshCsPolicy() {
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    if (response.ok) {
      csPolicy = await response.json();
      if (csPage === "home" && drawerOpen()) renderCsHome();
      // 写失败回滚：重渲染权限档页，用服务端真值覆盖乐观切档
      else if (csPage === "policy" && drawerOpen()) renderCsPolicyPage();
    }
  } catch {
    /* 拉不到就显示 —，不拦抽屉 */
  }
}

function csSvg(paths) {
  const span = document.createElement("span");
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return span;
}
const CS_ICONS = {
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>',
  // 人设 = 人形 + 笔（与设置页「人设」分区同一个图形，让同一件事在兩处长得一样）
  pencil: '<circle cx="10" cy="8" r="5"/><path d="M2 21a8 8 0 0 1 12.9-6.3"/><path d="M18 15l3 3-6 6-3.5.5.5-3.5z"/>',
  // 备选链 = 叠层，表示「主用之外还排着几条」
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  arrowUp: '<path d="m18 15-6-6-6 6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  arrowDown: '<path d="m6 9 6 6 6-6"/>',
};

function csHead(title, { back = false } = {}) {
  const head = document.createElement("div");
  head.className = "cs-head";
  if (back) {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "cs-icon-btn";
    backBtn.setAttribute("aria-label", "返回");
    backBtn.title = "返回";
    backBtn.append(csSvg(CS_ICONS.back));
    backBtn.addEventListener("click", () => {
      csPage = "home";
      renderCsPage();
    });
    head.append(backBtn);
  }
  const titleNode = document.createElement("div");
  titleNode.className = "cs-head-title";
  titleNode.textContent = title;
  head.append(titleNode);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cs-icon-btn";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.title = "关闭 (Esc)";
  closeBtn.append(csSvg(CS_ICONS.x));
  closeBtn.addEventListener("click", () => closeChatSettings());
  head.append(closeBtn);
  return head;
}

function csRow({ icon, title, sub, value, onClick, current = false }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "cs-row";
  if (current) row.setAttribute("aria-current", "true");
  if (icon) {
    const iconNode = document.createElement("span");
    iconNode.className = "cs-row-icon";
    iconNode.append(csSvg(CS_ICONS[icon] || ""));
    row.append(iconNode);
  }
  const main = document.createElement("span");
  main.className = "cs-row-main";
  const titleNode = document.createElement("span");
  titleNode.className = "cs-row-title";
  titleNode.textContent = title;
  main.append(titleNode);
  if (sub) {
    const subNode = document.createElement("span");
    subNode.className = "cs-row-sub";
    subNode.textContent = sub;
    subNode.title = sub;
    main.append(subNode);
  }
  row.append(main);
  if (value) {
    const valueNode = document.createElement("span");
    valueNode.className = "cs-row-value";
    valueNode.textContent = value;
    row.append(valueNode);
  }
  const chevron = document.createElement("span");
  chevron.className = "cs-row-chevron";
  chevron.append(csSvg(CS_ICONS.chevron));
  row.append(chevron);
  row.addEventListener("click", onClick);
  return row;
}

/** 抽屉页面壳：换页只换内容，壳不卸载（抽屉开着时底层聊天与滚动不受影响） */
function renderCsPage() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  const body = drawer.querySelector(".cs-body");
  const keepScroll = body ? body.scrollTop : 0;
  if (csPage === "persona") renderCsPersonaPage();
  else if (csPage === "model") renderCsModelPage();
  else if (csPage === "policy") renderCsPolicyPage();
  else if (csPage === "notify") renderCsNotifyPage();
  else renderCsHome();
  const next = drawer.querySelector(".cs-body");
  if (next) next.scrollTop = csPage === "home" ? keepScroll : 0;
}

/** 卡片容器：一组成设置行，行间 1px 分割（视觉与设置页同语言，只是收在 448px 里） */
function csCard(label) {
  const card = document.createElement("div");
  card.className = "cs-card";
  if (label) {
    const head = document.createElement("div");
    head.className = "cs-card-label";
    head.textContent = label;
    card.append(head);
  }
  return card;
}

/**
 * 当前这条对话归谁：决定首页「人设」改的是哪个角色。
 *  - `partner-<id>`：执事主会话 → 该执事；
 *  - `partner-<id>-group-<gid>`：群成员轮次 → 该成员（群设置另有入口）；
 *  - chief：总管。总管就是主对话的身份——侧栏统一批之后「主会话」不再单独存在；
 *  - worker：普通助手会话，**没有角色可改**（它的人格是服务端的 WORKER_PERSONA，
 *    不是某个执事也不是总管）→ 返回 null，界面不摆人设入口，避免「改了总管、
 *    却以为改的是当前这个助手」这种谎报。
 */
function csResolveTarget() {
  const id = state.conversationId || "";
  if (id.startsWith("partner-")) {
    const rest = id.slice("partner-".length);
    const groupAt = rest.indexOf("-group-");
    const partnerId = groupAt >= 0 ? rest.slice(0, groupAt) : rest;
    return partnerId || null;
  }
  // 身份以服务端回读的 chatKind 为准（缺字段的旧会话按 chief，保住老数据）
  return state.chatKind === "worker" ? null : "chief";
}

/**
 * 首页顶部身份块：**横排一行**（头像 + 名字/版本 + chevron），整块进「人设」。
 *
 * 2026-11-07 二次修：原来是居中竖排（大头像 + 名字 + 版本 + 改人设），
 * 在 448px 抽屉里占了近 1/5 屏高、下方还留一片空白，读起来像「个人主页」
 * 而不是设置面板。设置面板的账号区应当是**一行**，与下面的设置行同节奏。
 */
function csIdentityNode(partner) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "cs-identity";
  node.title = "改人设（头像 / 名字 / 正文）";

  const avatar = document.createElement("span");
  avatar.className = "pt-avatar";
  const name = String(partner?.name || "").trim() || "总管";
  paintAvatar(avatar, partner?.avatar || null, name);
  node.append(avatar);

  const main = document.createElement("span");
  main.className = "cs-identity-main";
  const nameNode = document.createElement("span");
  nameNode.className = "cs-identity-name";
  nameNode.textContent = name;
  main.append(nameNode);
  const sub = document.createElement("span");
  sub.className = "cs-identity-sub";
  const version = csDetail ? csDetail.soulVersion : partner?.soulVersion;
  sub.textContent = version != null ? `人设 v${version} · 点头像或名字改` : "还没写过人设 · 点这里写";
  main.append(sub);
  node.append(main);

  const chevron = document.createElement("span");
  chevron.className = "cs-row-chevron";
  chevron.append(csSvg(CS_ICONS.chevron));
  node.append(chevron);

  node.addEventListener("click", () => {
    csPage = "persona";
    renderCsPage();
  });
  return node;
}

function renderCsHome() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("对话设置"));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）

  const catalog = csCatalog;
  const current = catalog && catalog.current;
  const timing = localStorage.getItem(KEY_NOTIFY_TIMING) || "all";
  const notifyOn = localStorage.getItem(KEY_NOTIFY) === "1";
  const partner = state.partners.find((item) => item.id === csTarget) || null;
  const chain = partner ? partnerModelChain() : [];

  // 身份块 = 人设入口（点头像/名字整块进去）。它自己就是那一行，
  // 不再另立一条「这个角色 → 人设」——两个入口指同一页，只会让人多点一次。
  // 普通助手会话没有角色可改（人格在服务端），不摆身份块也不摆人设行。
  if (csTarget) body.append(csIdentityNode(partner));

  // 模型卡：主选 + 备选。两者都是同一个角色身上可调的，用户口径是
  // 「主选模型和备选模型都是在自己已有的这些里调，这俩应该是一样的设置」。
  const modelCard = csCard("模型");
  modelCard.append(
    csRow({
      icon: "cpu",
      title: "主选模型",
      sub: current ? modelLabel(catalog) || current.modelId : "还没有可用模型",
      onClick: () => {
        csPage = "model";
        renderCsPage();
      },
    }),
    // 备选链只属于执事：普通助手会话不摆这一行（摆一条点不动的行等于噪声）
    ...(csTarget
      ? [
          csRow({
            icon: "layers",
            title: "备选模型",
            sub: chain.length
              ? chain.map((item) => item.modelId).join(" → ")
              : "没配：试跑 / 例行任务失败时不会自动换",
            onClick: () => {
              csPage = "model";
              renderCsPage();
            },
          }),
        ]
      : []),
  );
  body.append(modelCard);

  const agentCard = csCard("助手");
  agentCard.append(
    csRow({
      icon: "shield",
      title: "权限档",
      sub: csPolicy && csPolicy.access ? CS_POLICY_LABEL[csPolicy.access] || csPolicy.access : "—",
      onClick: () => {
        csPage = "policy";
        renderCsPage();
      },
    }),
    csRow({
      icon: "bell",
      title: "通知",
      sub: notifyOn ? `开 · ${CS_TIMING_LABEL[timing] || timing}` : "关",
      onClick: () => {
        csPage = "notify";
        renderCsPage();
      },
    }),
  );
  body.append(agentCard);

  const allCard = csCard("更多");
  allCard.append(
    csRow({
      icon: "settings",
      title: "全部设置",
      sub: "供应商、密钥、记忆、连接手机…",
      onClick: () => {
        closeChatSettings();
        location.hash = "#/settings";
      },
    }),
  );
  body.append(allCard);
  drawer.append(body);
}

/* ── 二级页 · 人设：头像 + 名字 + 正文，一次保存 ──────────────
 * 用户口径（2026-11-07）：「调整人设这里都应该加到右上角这里头」「换头像啥的其实无所谓，
 * 但是也可以换，就在设置里」「调整人物的页面，和打开一个人后点击右上角那个设置页面，
 * 这两个应该是差不多的，都可以用 EP（API）接口」。
 *
 * 所以这一页与「全部设置 → 人设 → 改人设」是**同一件事、同一批接口**：
 *   GET   /api/v1/partners/:id      → soul / soulVersion / modelChain
 *   PATCH /api/v1/partners/:id      → 头像 + 名字 + 正文同一次提交（服务端本来就支持多槽位，
 *                                      任一不合法整批 400，不会半写）
 * 头像是人设的一部分（2026-11-07 用户已合并过一次），所以这里头像按钮与正文同页，
 * 不另开「换头像」入口。头像预设面板与弹窗共用同一份实现（openAvatarPanel）。
 */
function renderCsPersonaPage() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("人设", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）
  drawer.append(body);

  if (!csTarget) {
    const note = document.createElement("p");
    note.className = "cs-note";
    note.textContent =
      "这条是普通助手会话，它的身份由服务端固定，没有可改的人设。到「全部设置 → 人设」可以改总管和各个执事。";
    body.append(note);
    return;
  }

  const partner = state.partners.find((item) => item.id === csTarget) || null;
  const name = String(partner?.name || "").trim() || "总管";
  const soul = csDetail ? String(csDetail.soul ?? "") : "";
  const version = csDetail ? csDetail.soulVersion : partner?.soulVersion ?? null;

  if (!csDetail) {
    const loading = document.createElement("p");
    loading.className = "cs-note";
    loading.textContent = "读取中…";
    body.append(loading);
    // 等这一次详情回来再画：此时还没进编辑状态，重画不会覆盖任何草稿
    void refreshCsDetail({
      after: () => {
        if (drawerOpen() && csPage === "persona" && csDetail) renderCsPage();
      },
    });
    return;
  }

  /* 头像 + 名字 */
  const headCard = csCard();
  const headField = document.createElement("div");
  headField.className = "cs-field";
  headField.style.flexDirection = "row";
  headField.style.alignItems = "center";
  headField.style.gap = "14px";

  const avatarBtn = document.createElement("button");
  avatarBtn.type = "button";
  avatarBtn.className = "pt-avatar avatar-edit pt-portrait-btn";
  avatarBtn.id = "cs-avatar";
  avatarBtn.title = "换一张头像";
  avatarBtn.setAttribute("aria-label", "更换头像");
  avatarBtn.setAttribute("aria-haspopup", "dialog");
  avatarBtn.setAttribute("aria-expanded", "false");
  avatarBtn.style.width = "56px";
  avatarBtn.style.height = "56px";
  avatarBtn.style.fontSize = "22px";
  const chev = document.createElement("span");
  chev.className = "pt-portrait-chev";
  chev.setAttribute("aria-hidden", "true");
  chev.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  avatarBtn.append(chev);

  const nameBox = document.createElement("div");
  nameBox.style.flex = "1";
  nameBox.style.minWidth = "0";
  nameBox.style.display = "flex";
  nameBox.style.flexDirection = "column";
  nameBox.style.gap = "6px";
  const nameLabel = document.createElement("span");
  nameLabel.className = "cs-field-label";
  nameLabel.textContent = "名字";
  const nameInput = document.createElement("input");
  nameInput.className = "cs-input";
  nameInput.id = "cs-persona-name";
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.value = name;
  nameInput.setAttribute("aria-label", "名字");
  nameBox.append(nameLabel, nameInput);
  headField.append(avatarBtn, nameBox);
  headCard.append(headField);

  // 版本说明挂在名字框下面（同一个列里），不单独占一行卡片底边——
  // 原来它带 border-top 挂在卡片尾部，读起来像一条游离的脚注。
  const versionNode = document.createElement("span");
  versionNode.className = "cs-hint";
  versionNode.style.padding = "0";
  versionNode.textContent = version != null ? `v${version} · 改完下一轮起用` : "改完下一轮起用";
  nameBox.append(versionNode);
  body.append(headCard);

  /* 正文 */
  const soulCard = csCard("它是谁、怎么说话、守什么规矩");
  const soulField = document.createElement("div");
  soulField.className = "cs-field";
  const soulArea = document.createElement("textarea");
  soulArea.className = "cs-textarea is-soul";
  soulArea.id = "cs-persona-soul";
  soulArea.rows = 8;
  soulArea.spellcheck = false;
  soulArea.value = soul;
  soulArea.style.minHeight = "168px";
  soulArea.style.fontFamily = "inherit";
  soulArea.style.fontSize = "13px";
  soulArea.style.lineHeight = "1.7";
  soulArea.setAttribute("aria-label", "人设正文");
  soulArea.placeholder = "例：你叫阿岚，是这个家的管事。说话短、先给结论；不确定就直说，不要编。";
  soulField.append(soulArea);
  soulCard.append(soulField);

  const hint = document.createElement("div");
  hint.className = "cs-hint";
  hint.id = "cs-persona-hint";
  hint.style.padding = "0 14px";
  soulCard.append(hint);

  const actions = document.createElement("div");
  actions.className = "cs-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost";
  reset.id = "cs-persona-reset";
  reset.textContent = "撤销改动";
  reset.disabled = true;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary";
  save.id = "cs-persona-save";
  save.textContent = "保存";
  save.disabled = true;
  actions.append(reset, save);
  soulCard.append(actions);
  body.append(soulCard);

  /* 头像草稿：点头像弹共用面板，选中只改预览，保存才写 */
  let avatarDraft = partner?.avatar || null;
  let saving = false;
  let decoding = false;
  const original = { avatar: partner?.avatar || null, name, soul };
  const shown = () => {
    const currentName = nameInput.value.trim() || "总管";
    paintAvatar(avatarBtn, avatarDraft, currentName);
  };
  // chev 是常驻子节点，paintAvatar 会 replaceChildren 把它清掉——每次重画后补回
  const paintAvatarWithChev = () => {
    shown();
    avatarBtn.append(chev);
  };
  const isDirty = () =>
    avatarDraft !== original.avatar ||
    (nameInput.value.trim() || "") !== original.name ||
    soulArea.value !== original.soul;
  const refresh = () => {
    const dirty = isDirty();
    const valid = Boolean(soulArea.value.trim()) && Boolean(nameInput.value.trim());
    save.disabled = saving || decoding || !dirty || !valid;
    reset.disabled = saving || decoding || !dirty;
    avatarBtn.disabled = saving;
    nameInput.disabled = saving;
    soulArea.disabled = saving;
  };
  paintAvatarWithChev();
  refresh();

  avatarBtn.addEventListener("click", () => {
    if (saving) return;
    openAvatarPanel({
      anchor: avatarBtn,
      current: avatarDraft,
      onPick: (dataUrl) => {
        avatarDraft = dataUrl;
        paintAvatarWithChev();
        hint.textContent = dataUrl ? "头像已选好，点「保存」一起生效。" : "已改为不使用头像：保存后显示名字首字。";
        hint.classList.remove("is-error");
        refresh();
      },
      onBusy: (busy, message) => {
        decoding = busy;
        if (message) {
          hint.textContent = message;
          hint.classList.toggle("is-error", message.includes("不能") || message.includes("读不出"));
        }
        refresh();
      },
    });
  });
  nameInput.addEventListener("input", () => {
    paintAvatarWithChev();
    hint.textContent = "";
    hint.classList.remove("is-error");
    refresh();
  });
  soulArea.addEventListener("input", () => {
    hint.textContent = "";
    hint.classList.remove("is-error");
    refresh();
  });
  reset.addEventListener("click", () => {
    avatarDraft = original.avatar;
    nameInput.value = original.name;
    soulArea.value = original.soul;
    paintAvatarWithChev();
    hint.textContent = "";
    hint.classList.remove("is-error");
    refresh();
  });

  save.addEventListener("click", async () => {
    const nextName = nameInput.value.trim();
    const nextSoul = soulArea.value;
    if (!nextName) {
      hint.textContent = "名字不能为空。";
      hint.classList.add("is-error");
      nameInput.focus();
      return;
    }
    if (!nextSoul.trim()) {
      hint.textContent = "人设不能是空的。";
      hint.classList.add("is-error");
      soulArea.focus();
      return;
    }
    if (saving || decoding) return;
    saving = true;
    refresh();
    hint.classList.remove("is-error");
    hint.textContent = "保存中…";
    // 同一个 PATCH 提交：服务端先整体校验再写，头像 / 名字 / 正文不会半写
    const payload = {};
    if (nextName !== original.name) payload.name = nextName;
    if (nextSoul !== original.soul) payload.soul = nextSoul;
    if (avatarDraft !== original.avatar) payload.avatar = avatarDraft;
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(csTarget)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        hint.textContent = data.message || data.error || `没存成：HTTP ${response.status}`;
        hint.classList.add("is-error");
        return;
      }
      // 基准推进到服务端回读值：再点保存不会重复提交同样内容
      original.name = nextName;
      original.soul = nextSoul;
      original.avatar = avatarDraft;
      const cached = state.partners.find((item) => item.id === csTarget);
      if (cached && data.partner) Object.assign(cached, data.partner);
      if (csDetail) {
        csDetail.soul = nextSoul;
        if (data.soulVersion != null) csDetail.soulVersion = data.soulVersion;
        if (data.partner) csDetail.partner = { ...(csDetail.partner || {}), ...data.partner };
      }
      versionNode.textContent =
        data.soulVersion != null ? `v${data.soulVersion} · 下一轮起用` : "下一轮起用";
      hint.textContent = data.soulVersion != null ? `已保存为 v${data.soulVersion}，下一轮起用。` : "已保存。";
      syncChiefAvatar();
      void loadRoster();
      refresh();
    } catch (error) {
      if (error.message === "forbidden") return;
      hint.textContent = `没存成：${error.message}`;
      hint.classList.add("is-error");
    } finally {
      saving = false;
      refresh();
    }
  });
}

/* ── 二级页 · 模型：主选 + 备选同页 ─────────────────────────
 * 用户口径（2026-11-07）：「选模型那个功能，应该跟设置里那个是一个方法吧」
 *   「调整人设、调整模型（主选模型和备选模型），都是在自己已有的这些里调，这俩应该是一样的设置」。
 *
 * 所以这一页是**同一个角色**的两件模型设置，共用一份「已有模型」清单：
 *   ① 主选：全局运行时模型（POST /agent/model，下一轮生效）——与 composer pill、
 *      设置→服务的默认模型行是同一个接口、同一套目录，不另造一份；
 *   ② 备选：这个执事的候选链（PATCH /partners/:id { modelChain }）——只在主模型
 *      「没应答且原因可切」时按链往下换，keyEnv 只填变量名（密钥纪律）。
 * 两段都从**已有**模型里选（供应商 × 模型两个下拉，选项来自 /agent/model），
 * 不再要求手打 providerId|modelId|KEY_ENV_NAME。批量加模型仍然保留在页尾。 */
function renderCsModelPage() {
  const drawer = el.chatSettingsDrawer;
  const catalog = csCatalog;
  if (!drawer || !catalog) return;
  drawer.replaceChildren(csHead("模型", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）
  drawer.append(body);
  const providers = menuProviders(catalog);
  body.append(csModelWho());
  body.append(csPrimaryCard(providers, catalog.current || null));
  // 备选链挂在执事身上；普通助手会话没有链可配，不摆这张卡
  if (csTarget) body.append(csFallbackCard(providers));
  body.append(csBatchCard(providers, catalog.current || null));
}

/** 这页改的是谁：避免在执事会话里以为改了执事、其实改的是全局主选 */
function csModelWho() {
  const partner = state.partners.find((item) => item.id === csTarget);
  const name = String(partner?.name || "").trim() || "总管";
  const node = document.createElement("p");
  node.className = "cs-note";
  node.style.padding = "0 2px 2px";
  node.textContent = `主选对所有对话生效；备选只属于「${name}」。`;
  return node;
}

/** ① 主选：与设置页「默认模型」同一个接口（POST /agent/model），只是换成下拉 */
function csPrimaryCard(providers, current) {
  const card = csCard("主选模型");
  const field = document.createElement("div");
  field.className = "cs-field";
  field.innerHTML = `
    <select class="cs-input" id="cs-primary-select" aria-label="主选模型"></select>
    <span class="cs-hint" id="cs-primary-hint">切换后下一轮生效。</span>`;
  card.append(field);
  const select = field.querySelector("#cs-primary-select");
  const hint = field.querySelector("#cs-primary-hint");

  for (const provider of providers) {
    const group = document.createElement("optgroup");
    group.label = provider.name || provider.id;
    for (const raw of provider.models) {
      const model = normalizeModelRow(raw);
      if (!model) continue;
      const option = document.createElement("option");
      option.value = `${provider.id}|${model.id}`;
      option.textContent = model.id;
      // 思考支持域跟着行走（2026-11-07 修）：切换时 chooseModel 要拿它做档位折算，
      // 不给的话 clampThinking 按"无档位"处理，用户的思考档会被静默重置成 off
      option.dataset.thinkingLevels = JSON.stringify(model.thinkingLevels);
      if (current && current.providerId === provider.id && current.modelId === model.id) {
        option.selected = true;
      }
      group.append(option);
    }
    if (group.children.length) select.append(group);
  }
  if (!providers.length) {
    select.disabled = true;
    const option = document.createElement("option");
    option.textContent = "还没有可选模型：到全部设置 → 服务里添加供应商";
    select.append(option);
    hint.textContent = "配好供应商后这里就有清单了。";
    return card;
  }
  // 当前模型不在清单里（供应商被删 / 模型下线）：补一条占位，别让下拉静默跳到第一家
  const value = current ? `${current.providerId}|${current.modelId}` : "";
  if (value && !Array.from(select.options).some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${current.modelId}（当前，已不在清单）`;
    option.selected = true;
    select.prepend(option);
  }

  select.addEventListener("change", async () => {
    const [providerId, modelId] = String(select.value).split("|");
    const provider = providers.find((item) => item.id === providerId);
    if (!provider || !modelId) return;
    select.disabled = true;
    hint.classList.remove("is-error");
    hint.textContent = "切换中…";
    // 选中行自带思考支持域（build 时落在 option.dataset 上），档位折算用
    const levels = (() => {
      try {
        const raw = select.selectedOptions[0]?.dataset.thinkingLevels;
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) && parsed.length ? parsed : null;
      } catch {
        return null;
      }
    })();
    const ok = await chooseModel(provider, modelId, levels, { keepOpen: true });
    select.disabled = false;
    if (!ok) {
      hint.textContent = "没切成，稍后再试。";
      hint.classList.add("is-error");
      return;
    }
    csCatalog = state.modelCatalog;
    hint.textContent = "已切换，下一轮生效；下一轮会慢一点（上游缓存重建）。";
    if (drawerOpen() && csPage === "model") renderCsPage();
  });
  return card;
}

/**
 * 备选链编辑器（2026-11-07 抽出，抽屉与设置弹窗共用）。
 *
 * 用户口径：「调整人物的页面，和打开一个人后点击右上角那个设置页面，
 * 这两个应该是差不多的，都可以用 EP（API）接口」。
 * 原来两处形态完全不同：抽屉是下拉，弹窗要手打 `providerId|modelId|KEY_ENV_NAME`。
 * 现在统一成这一份：**从已有模型里选**（供应商 + 模型两个下拉），顺序可调，
 * keyEnv 由供应商记录带出（密钥纪律：值永不落档案，页面也不让填）。
 *
 * 回调口径：
 *   onSaved(next) —— 服务端接受后把新链交回调用方（弹窗用来同步抽屉的详情缓存）
 */
async function mountChainEditor(host, { partnerId, chain, onSaved }) {
  if (!host || !partnerId) return;
  let list = Array.isArray(chain) ? chain.slice() : [];
  const keys = new Map();

  host.innerHTML = `
    <div class="cs-chain" data-chain-rows></div>
    <p class="cs-hint" data-chain-hint></p>`;
  const rowsBox = host.querySelector("[data-chain-rows]");
  const hint = host.querySelector("[data-chain-hint]");
  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", isError && Boolean(text));
  };

  // 已有模型清单：优先用调用方已经拉过的目录，没有再自己拉一次（两处都不额外造数据源）
  let catalog = state.modelCatalog;
  if (!catalog || !menuProviders(catalog).length) {
    catalog = await fetchModelCatalog().catch(() => null);
  }
  const known = menuProviders(catalog || {});

  const paint = () => {
    rowsBox.replaceChildren();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "cs-chain-empty";
      empty.textContent = "还没有备选。主模型失败时直接报错，不会自动换。";
      rowsBox.append(empty);
    } else {
      list.forEach((item, index) => rowsBox.append(chainRow(item, index)));
    }
    const bar = document.createElement("div");
    bar.className = "cs-chain-add";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "cs-chain-add-btn";
    add.disabled = list.length >= 5 || !known.length;
    add.append(csSvg(CS_ICONS.plus));
    const label = document.createElement("span");
    label.textContent = "加一条备选";
    add.append(label);
    add.addEventListener("click", () => void addOne());
    bar.append(add);
    if (list.length >= 5) {
      const limit = document.createElement("span");
      limit.className = "cs-hint";
      limit.textContent = "已到上限 5 条";
      bar.append(limit);
    }
    rowsBox.append(bar);
  };

  /* 一条备选 = 序号 + 一个「供应商 / 模型」分组下拉 + 上移下移删除。
     用分组下拉而不是并排两个 select：448px 里两个并排各自只剩 90px，
     模型 id（kimi/kimi-k3.1-pro-highspeed）会被截成一样的开头；
     分组下拉与主选那一处是同一个控件形状，符合「这俩应该是一样的设置」。 */
  function chainRow(item, index) {
    const row = document.createElement("div");
    row.className = "cs-chain-row";

    const order = document.createElement("span");
    order.className = "cs-chain-order";
    order.textContent = String(index + 1);
    row.append(order);

    const select = document.createElement("select");
    select.className = "cs-input cs-chain-pick";
    select.setAttribute("aria-label", `第 ${index + 1} 条备选`);
    for (const provider of known) {
      const group = document.createElement("optgroup");
      group.label = provider.name || provider.id;
      for (const raw of provider.models) {
        const model = normalizeModelRow(raw);
        if (!model) continue;
        const option = document.createElement("option");
        option.value = `${provider.id}|${model.id}`;
        option.textContent = model.id;
        if (provider.id === item.providerId && model.id === item.modelId) option.selected = true;
        group.append(option);
      }
      if (group.children.length) select.append(group);
    }
    // 链里引用的模型已被删掉 / 供应商已移除：补一条占位，别让下拉静默跳到第一家
    const value = `${item.providerId}|${item.modelId}`;
    if (!known.some((provider) => provider.id === item.providerId &&
      provider.models.some((raw) => normalizeModelRow(raw)?.id === item.modelId))) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `${item.providerId} / ${item.modelId}（已不在清单）`;
      option.selected = true;
      select.prepend(option);
    }
    select.addEventListener("change", () => {
      const [providerId, modelId] = String(select.value).split("|");
      if (!providerId || !modelId) return;
      void patch(index, { providerId, modelId });
    });
    row.append(select);

    const actions = document.createElement("div");
    actions.className = "cs-chain-actions";
    const iconBtn = (title, paths, handler, disabled) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cs-chain-btn";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.disabled = disabled;
      button.append(csSvg(paths));
      button.addEventListener("click", handler);
      return button;
    };
    actions.append(
      iconBtn("上移", CS_ICONS.arrowUp, () => void move(index, -1), index === 0),
      iconBtn("下移", CS_ICONS.arrowDown, () => void move(index, 1), index === list.length - 1),
      iconBtn("删掉这条", CS_ICONS.x, () => void save(list.filter((_, at) => at !== index)), false),
    );
    row.append(actions);
    return row;
  }

  async function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = list.slice();
    [next[index], next[target]] = [next[target], next[index]];
    await save(next);
  }

  async function patch(index, step) {
    const next = list.map((entry, at) => {
      if (at !== index) return entry;
      const providerId = step.providerId || entry.providerId;
      return {
        providerId,
        modelId: step.modelId || entry.modelId,
        // keyEnv 跟着供应商走；没读到就保留原值，保存前会明确拦下
        keyEnv: keys.get(providerId) || entry.keyEnv || "",
      };
    });
    await save(next);
  }

  async function addOne() {
    const used = new Set(list.map((entry) => `${entry.providerId}|${entry.modelId}`));
    let pick = null;
    for (const provider of known) {
      for (const raw of provider.models) {
        const model = normalizeModelRow(raw);
        if (!model || used.has(`${provider.id}|${model.id}`)) continue;
        pick = { providerId: provider.id, modelId: model.id };
        break;
      }
      if (pick) break;
    }
    if (!pick) {
      setHint("清单里的模型都已经在链里了。", true);
      return;
    }
    await save([...list, { ...pick, keyEnv: keys.get(pick.providerId) || "" }]);
  }

  async function save(next) {
    const missing = next.filter((item) => !item.keyEnv);
    if (missing.length) {
      setHint("有供应商没读到 keyEnv（供应商配置缺变量名），先到全部设置 → 服务里补上。", true);
      return;
    }
    setHint("保存中…");
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ modelChain: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return;
      }
      list = next.map((item) => ({ ...item }));
      setHint(next.length ? "" : "已清空：以后主模型失败就直接报错。");
      paint();
      onSaved?.(list);
    } catch (error) {
      if (error.message === "forbidden") return;
      setHint(`没存成：${error.message}`, true);
    }
  }

  paint();
  // keyEnv 要等供应商投影回来才有：回来后就地补一份并重画（链本身没变）
  void csLoadProviders().then((rows) => {
    if (!rows) return;
    for (const item of rows) keys.set(item.id, item.keyEnv || "");
    paint();
  });
}

/** 抽屉里的「备选模型」卡片：外层说明 + 共用编辑器 */
function csFallbackCard(providers) {
  const card = csCard("备选模型");
  const note = document.createElement("div");
  note.className = "cs-note";
  note.style.padding = "0 14px 10px";
  note.textContent = csTarget
    // 生效范围按代码实况写：链只在执事的试跑与例行任务轮次里走
    // （partner-runtime.runPartnerTurn → nextChainCandidate）；主对话的 chatStream 不读链。
    // 写成「主模型失败就自动换」是虚假承诺，用户会以为聊天也有兜底。
    ? "只在试跑与例行任务轮次里生效（主对话不换）：那一轮没应答且原因可切时，按顺序换下一条重跑。最多 5 条。"
    : "备选链属于执事，普通助手会话没有。到「全部设置 → 人设」里给某个执事配。";
  card.append(note);
  if (!csTarget) return card;
  const box = document.createElement("div");
  card.append(box);
  void mountChainEditor(box, {
    partnerId: csTarget,
    chain: partnerModelChain(),
    onSaved: (next) => {
      if (csDetail) csDetail.modelChain = next;
    },
  });
  return card;
}

/** ③ 批量添加：一行一个模型 ID，加到主选所在的那家（没主选就第一家有模型的） */
function csBatchCard(providers, current) {
  const providerId = current ? current.providerId : providers[0]?.id || "";
  const provider = providers.find((item) => item.id === providerId);
  const card = csCard("清单里没有这个模型？");
  const batch = document.createElement("div");
  batch.className = "chat-settings-batch";
  batch.innerHTML = `
    <div class="batch-head">
      <span>一行一个模型 ID，直接加进清单</span>
      <span class="batch-target" id="batch-target"></span>
    </div>
    <textarea class="batch-input is-mono" id="batch-models" rows="4" spellcheck="false"
      aria-label="一行一个模型 ID" placeholder="一行一个模型 ID，例如：\nqwen3-max\nqwen-plus"></textarea>
    <div class="batch-actions">
      <span class="set-hint batch-hint" id="batch-hint"></span>
      <button class="ghost" type="button" id="batch-import">导入</button>
    </div>`;
  card.append(batch);
  const target = batch.querySelector("#batch-target");
  if (target) target.textContent = provider ? `加到：${provider.name || provider.id}` : "";
  batch.querySelector("#batch-import")?.addEventListener("click", () => {
    void importBatchModels(
      providerId,
      batch.querySelector("#batch-models")?.value || "",
      batch.querySelector("#batch-hint"),
      batch,
    ).then(async (added) => {
      if (!added) return;
      // 加完刷新目录：新模型要能立刻出现在上面两个下拉里
      csProviders = null;
      try {
        const next = await fetchModelCatalog();
        csCatalog = next;
        state.modelCatalog = next;
        updateModelPill();
      } catch {
        /* 目录没刷新也不影响已经写进配置的模型，下次打开抽屉自然会有 */
      }
      if (drawerOpen() && csPage === "model") renderCsPage();
    });
  });
  return card;
}

/* ── 二级页 · 权限档：三档分段 + 写确认开关 + 审批入口 ──
   轻量重实现，不复用 loadPolicy（那是 getElementById 硬编码 #policy-switch，
   与全屏设置页双绑会打架）；GET /agent/policy 读档、POST 回写（2026-11-07 定论）。 */
function renderCsPolicyPage() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("权限档", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）
  body.innerHTML = `
    <div class="cs-card">
      <div class="cs-field">
        <span class="cs-field-label">它能替你动到什么程度</span>
        <div class="segmented slide" role="radiogroup" aria-label="权限" id="cs-policy-switch">
          <button type="button" data-policy="full" aria-checked="false">完全访问</button>
          <button type="button" data-policy="read-only" aria-checked="false">只读</button>
          <button type="button" data-policy="no-shell" aria-checked="false">不跑命令</button>
        </div>
        <span class="cs-hint">完全访问 = 能改文件、能跑命令。改完立刻生效。</span>
      </div>
      <div class="cs-row is-static">
        <span class="cs-row-main">
          <span class="cs-row-title">写操作逐次确认</span>
          <span class="cs-row-sub">开启后，改文件 / 跑命令 / 派活前先问你一句</span>
        </span>
        ${switchMarkup(csPolicy?.confirmWrites === true, { label: "写操作逐次确认", attrs: 'id="cs-policy-confirm-writes"' })}
      </div>
      <button class="cs-row" type="button" id="cs-approval-entry">
        <span class="cs-row-main">
          <span class="cs-row-title">待处理审批</span>
          <span class="cs-row-sub" id="cs-approval-count">读取中…</span>
        </span>
        <span class="cs-row-chevron">${csSvg(CS_ICONS.chevron).innerHTML}</span>
      </button>
    </div>
    <p class="cs-note">审批在「全部设置 → 权限」里批准 / 拒绝。</p>`;
  drawer.append(body);

  // 三档分段：mountSegmented/syncSegmented 复用，事件只绑抽屉这一份
  const box = body.querySelector("#cs-policy-switch");
  if (box) {
    mountSegmented(box);
    for (const button of box.querySelectorAll("[data-policy]")) {
      button.setAttribute("aria-checked", String(button.dataset.policy === csPolicy?.access));
    }
    syncSegmented(box);
    for (const button of box.querySelectorAll("[data-policy]")) {
      button.addEventListener("click", async () => {
        for (const other of box.querySelectorAll("[data-policy]")) {
          other.setAttribute("aria-checked", String(other === button));
        }
        syncSegmented(box);
        if (csPolicy) csPolicy.access = button.dataset.policy;
        try {
          await request("/api/v1/agent/policy", {
            method: "POST",
            body: JSON.stringify({ access: button.dataset.policy }),
          });
        } catch {
          // 写失败：回读服务端真值，撤销乐观切档，避免用户误以为已保存
          toast("权限档保存失败，请重试");
          void refreshCsPolicy();
        }
      });
    }
  }

  const confirm = body.querySelector("#cs-policy-confirm-writes");
  confirm?.addEventListener("click", async () => {
    const next = confirm.getAttribute("aria-checked") !== "true";
    confirm.setAttribute("aria-checked", String(next));
    if (csPolicy) csPolicy.confirmWrites = next;
    try {
      await request("/api/v1/agent/policy", {
        method: "POST",
        body: JSON.stringify({ confirmWrites: next }),
      });
    } catch {
      toast("写确认开关保存失败，请重试");
      void refreshCsPolicy();
    }
  });

  // 审批计数：GET /agent/approvals 不带 conversationId = 全局 pending
  void (async () => {
    const node = body.querySelector("#cs-approval-count");
    if (!node) return;
    try {
      const response = await request("/api/v1/agent/approvals", { cache: "no-store" });
      const data = await response.json();
      const count = Array.isArray(data) ? data.length : Array.isArray(data.approvals) ? data.approvals.length : 0;
      node.textContent = count > 0 ? `${count} 条待处理` : "没有待处理";
    } catch {
      node.textContent = "—";
    }
  })();
  body.querySelector("#cs-approval-entry")?.addEventListener("click", () => {
    closeChatSettings();
    location.hash = "#/settings";
  });
}

/* ── 二级页 · 通知：主开关（KEY_NOTIFY，含权限申请）+ 三时机过滤 ──
   三时机是纯前端 localStorage 过滤：all 放行全部 / error 放行出错+待处理 /
   attention 只放行待你处理；SSE 帧的 kind 已经够用，不加端点。 */
function renderCsNotifyPage() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("通知", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.dataset.cards = ""; // 卡片化排版（群设置共用骨架，不吃这一套）
  const notifyOn = localStorage.getItem(KEY_NOTIFY) === "1";
  const timing = localStorage.getItem(KEY_NOTIFY_TIMING) || "all";
  const timingRow = (key, sub) => `
        <button class="cs-row" type="button" data-timing="${key}" role="radio" aria-checked="${key === timing}">
          <span class="cs-row-main">
            <span class="cs-row-title">${CS_TIMING_LABEL[key]}</span>
            <span class="cs-row-sub">${sub}</span>
          </span>
          <span class="cs-row-chevron" data-check ${key === timing ? "" : "hidden"}>✓</span>
        </button>`;
  body.innerHTML = `
    <div class="cs-card">
      <div class="cs-row is-static">
        <span class="cs-row-main">
          <span class="cs-row-title">桌面通知</span>
          <span class="cs-row-sub">回复完成 / 出错 / 待你处理时提醒；窗口正看着这个会话就不打扰</span>
        </span>
        ${switchMarkup(notifyOn, { label: "桌面通知", attrs: 'id="cs-notify-switch"' })}
      </div>
    </div>
    <div class="cs-card">
      <div class="cs-card-label">提醒哪些时机</div>
      <div id="cs-notify-timing" role="radiogroup" aria-label="提醒时机">
        ${timingRow("all", "完成、出错、待你处理都提醒")}
        ${timingRow("error", "出错与待你处理时提醒，完成不打扰")}
        ${timingRow("attention", "只有等你处理时才提醒")}
      </div>
    </div>`;
  drawer.append(body);

  const notifySwitch = body.querySelector("#cs-notify-switch");
  // 主开关口径抄全屏设置页（设置-服务分区）：开的时候才请求系统权限；被拒就退回关闭
  notifySwitch?.addEventListener("click", async () => {
    const want = notifySwitch.getAttribute("aria-checked") !== "true";
    if (!want) {
      localStorage.setItem(KEY_NOTIFY, "0");
      notifySwitch.setAttribute("aria-checked", "false");
      return;
    }
    if (!("Notification" in window)) {
      toast("这个环境不支持通知");
      return;
    }
    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast("通知权限被拒了，去系统设置里开");
        return;
      }
    }
    localStorage.setItem(KEY_NOTIFY, "1");
    notifySwitch.setAttribute("aria-checked", "true");
  });

  for (const row of body.querySelectorAll("[data-timing]")) {
    row.addEventListener("click", () => {
      localStorage.setItem(KEY_NOTIFY_TIMING, row.dataset.timing);
      for (const other of body.querySelectorAll("[data-timing]")) {
        other.setAttribute("aria-checked", String(other === row));
        other.querySelector("[data-check]").hidden = other !== row;
      }
    });
  }
}

/** 逐行校验：非法行（超长）整批拦下并列明行号；合法行去重后与既有清单合并回写 */
async function importBatchModels(providerId, text, hintNode, batchBox) {
  const setHint = (msg, isError = true) => {
    if (!hintNode) return;
    hintNode.textContent = msg;
    hintNode.classList.toggle("is-error", isError);
  };
  if (!providerId) {
    setHint("还没有供应商：先到设置 → 服务里添加");
    return false;
  }
  const invalid = [];
  const ids = [];
  const seen = new Set();
  String(text).split(/\r?\n/).forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    if (value.length > 200) {
      invalid.push(`第 ${index + 1} 行超长（模型 ID 最多 200 字符）`);
      return;
    }
    if (seen.has(value)) return; // 同一次输入里的重复行只取一个
    seen.add(value);
    ids.push(value);
  });
  if (invalid.length) {
    setHint(`这些行没法用，先改掉再导入：${invalid.join("；")}`);
    return;
  }
  if (!ids.length) {
    setHint("先填至少一行模型 ID");
    return;
  }
  const button = batchBox?.querySelector("#batch-import");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  setHint("保存中…", false);
  try {
    // 拿全量记录：模型菜单的投影（/agent/model）不含 baseUrl/keyEnv/元数据，回写必须原样带上
    const listResponse = await request("/api/v1/agent/providers", { cache: "no-store" });
    if (!listResponse.ok) {
      setHint(`读不到供应商配置：HTTP ${listResponse.status}`);
      return;
    }
    const listData = await listResponse.json().catch(() => ({}));
    const provider = (listData.providers || []).find((item) => item.id === providerId);
    if (!provider) {
      setHint("找不到这家供应商，刷新后再试");
      return;
    }
    const existing = new Set(provider.models || []);
    const fresh = ids.filter((id) => !existing.has(id));
    const duplicated = ids.filter((id) => existing.has(id));
    if (!fresh.length) {
      setHint(`都已在清单里（${duplicated.join("、")}），没有新增`, false);
      return;
    }
    // 只增不改：既有模型的元数据/档位原样保留；不删任何模型（避开 selected_model_missing）
    const saved = await postProvider({
      id: provider.id,
      previousId: provider.id,
      name: provider.name || provider.id,
      baseUrl: provider.baseUrl || "",
      keyEnv: provider.keyEnv || "",
      models: [...(provider.models || []), ...fresh],
      modelMeta: provider.modelMeta || {},
      modelThinkingLevels: provider.modelThinkingLevels || {},
      allowEmptyModels: true,
    });
    if (!saved.response.ok) {
      setHint(providerErrorText(saved.data || {}, saved.response.status));
      return;
    }
    const listed = (state.providers || []).find((item) => item.id === providerId);
    if (listed) listed.models = [...(listed.models || []), ...fresh];
    await refreshModelPill().catch(() => undefined);
    const textarea = batchBox?.querySelector("#batch-models");
    if (textarea) textarea.value = "";
    setHint(
      `已加入 ${fresh.length} 个模型，下一轮生效${duplicated.length ? `；${duplicated.length} 个已存在，跳过：${duplicated.join("、")}` : ""}`,
      false,
    );
    return true; // 真的写进了清单：调用方（抽屉）据此重拉目录，让新模型立刻能选
  } catch (error) {
    if (error.message === "forbidden") {
      closeChatSettings();
      return;
    }
    setHint(`没存上：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
  return false;
}

/* ── 侧栏项目面板（2026-11-04 建，2026-11-06 改为总览）────
 * 展开态 pill 与收起轨道按钮是同一份弹层、同一个渲染函数。
 * pill = 主项目（工作区根）；展开是「主项目 + 子项目」总览，**不再切「当前项目」**
 * ——没人在意固定在哪个目录干活，派活时才指定项目（resolveDelegationProject）。
 * 列表每次打开现拉（同模型菜单口径）：项目可能在设置页刚建/归档，也可能是
 * 另一台设备改的。契约见接口文档 §工作区。 */

const PROJECT_UNAVAILABLE_HINT = "读不到项目接口，重启服务后再试";

let projectAnchor = null;
let projectLoading = false;
// 打开序号：慢网下点了外面，等在路上的现拉结果回来也不许自己弹出来
let projectOpenToken = 0;

/** 拿全了才返回；失败返回 null，调用方保持原状（不抛）。
 *  GET /api/v1/projects 本身就带 workspace，不用再打一发 /workspaces。 */
async function fetchProjectSwitchData() {
  const response = await request("/api/v1/projects", { cache: "no-store" });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  const workspace = data.workspace || null;
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const items = projects
    .filter((project) => project && typeof project.id === "string")
    // 归档的不进列表（去设置页看）；目录丢了 / 跑出工作区的照常显示、行尾标注——
    // 总览就该都能看见，藏起来反而像「凭空少了项目」。
    .filter((project) => !project.archived)
    .map((project) => ({
      id: project.id,
      name: project.name || project.id,
      rootPath: project.rootPath || "",
      missing: project.exists === false,
      outside: project.insideWorkspace === false,
    }));
  return { workspace, items };
}

function applyProjectData(data) {
  const switcher = state.switcher;
  switcher.workspace = data.workspace;
  switcher.subCount = data.items.length;
  // 内联列表要行内容：workspace + items 一起记下，syncProjectPill 直接渲染
  switcher.items = data.items;
  switcher.unavailable = false;
  syncProjectPill();
}

/**
 * 项目分区（2026-11-07 统一批）：主项目 + 子项目内联成行，不再用 pill 弹小窗。
 *
 * 为什么改：用户要的是"每个分区都能展开、都能加"，pill 那种「点开一个浮层再看」
 * 与另外几个分区（会话/执事/群组）不是一个语言。列表本身就是总览，浮层留给设置页。
 * 行尾仍保留文件入口（浏览 / 资源管理器）——那两个动作不适合做成行点击。
 */
function syncProjectRows(items) {
  const box = el.projList;
  if (!box) return;
  box.replaceChildren();
  const switcher = state.switcher;
  const hasWorkspace = Boolean(switcher.workspace);
  const unavailable = Boolean(switcher.unavailable);

  // 分区头恒为「项目」：塞 workspace 名会和下面主项目行一模一样，
  // 两行同为「Workspace」时根本分不清谁是主项目（2026-11-06 截图核对）。
  if (el.secProjectsName) {
    el.secProjectsName.textContent = unavailable ? "项目不可用" : "项目";
  }

  // 接口读不到（旧后端 / 临时 5xx）不把入口藏起来：给一行可点的重试行。
  if (unavailable) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-item proj-row is-unavailable";
    row.textContent = "读不到项目，点一下重试";
    row.addEventListener("click", () => void refreshProjectPill());
    box.append(row);
    return;
  }

  if (!hasWorkspace) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "side-item proj-row";
    row.innerHTML = '<span class="side-item-label">设置主项目</span>';
    row.title = "设定最大工作区根目录";
    row.addEventListener("click", () => openAddWorkspaceModal());
    box.append(row);
    return;
  }

  const main = document.createElement("div");
  main.className = "side-item proj-row is-main";
  main.title = switcher.workspace.rootPath || "";
  main.append(projectIcon("main"));
  const mainName = document.createElement("span");
  mainName.className = "side-item-label";
  mainName.textContent = baseNameOf(switcher.workspace.rootPath) || "主项目";
  main.append(mainName);
  // 层级标注：只靠缩进和图标，用户会问「哪个是主项目」
  const mainTag = document.createElement("span");
  mainTag.className = "proj-tag";
  mainTag.textContent = "主项目";
  main.append(mainTag);
  const mainLabel = baseNameOf(switcher.workspace.rootPath) || "主项目";
  main.append(
    // 面包屑以工作区根名打头；子项目起点是它自己的相对路径，不能再套一遍项目名
    projActionButton("browse", "浏览文件", "在界面里看这个目录的文件", () =>
      openFileBrowser(mainLabel, "", mainLabel),
    ),
    projActionButton("explorer", "在资源管理器中打开", "在系统的文件资源管理器里打开这个目录", () =>
      openExplorerInOs(""),
    ),
  );
  box.append(main);

  for (const project of items || []) {
    const row = document.createElement("div");
    row.className = "side-item proj-row is-sub";
    row.title = project.rootPath || project.name;
    row.append(projectIcon("sub"));
    const name = document.createElement("span");
    name.className = "side-item-label";
    name.textContent = project.name;
    row.append(name);
    if (project.missing || project.outside) {
      const tag = document.createElement("span");
      tag.className = `proj-tag ${project.missing ? "is-warn" : "is-idle"}`;
      tag.textContent = project.missing ? "目录不在了" : "不在工作区";
      row.append(tag);
    } else {
      const startRel = relativeWithinWorkspace(switcher.workspace.rootPath, project.rootPath);
      row.append(
        projActionButton("browse", "浏览文件", `在界面里看「${project.name}」的文件`, () =>
          openFileBrowser(project.name, startRel || "", mainLabel),
        ),
        projActionButton("explorer", "在资源管理器中打开", `在系统的文件资源管理器里打开「${project.name}」`, () =>
          openExplorerInOs(project.id),
        ),
      );
    }
    box.append(row);
  }

  if (!items || !items.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = "还没有子项目。用上面的 ＋ 添加一个。";
    box.append(empty);
  }

  // 层级说明（2026-11-06）：侧栏只留一行，完整解释在设置页「项目」分区。
  // 一开始写成三行小字，实测把 232px 的侧栏撑出横向滚动条，而且天天占位；
  // 这是"看一眼就懂"的注释，不是常驻内容，压缩成一行 + title 更合适。
  const legend = document.createElement("p");
  legend.className = "proj-legend";
  legend.textContent = "主项目=打杂空间，子项目=登记的仓库";
  legend.title =
    "主项目 = 最大工作区根目录，打杂和临时文件放这里；子项目 = 登记进来的独立目录，通常是代码仓库或另一个项目。不在完全访问档时，助手只能在这两个空间里动手。";
  box.append(legend);
}

/* 收起轨道的项目按钮仍走弹层（72px 放不下内联列表），内容复用同一个总览渲染。 */
function syncRailProject(tip) {
  if (!el.railProj) return;
  el.railProj.hidden = false;
  el.railProj.classList.toggle("is-unavailable", Boolean(state.switcher.unavailable));
  el.railProj.removeAttribute("title");
  el.railProj.dataset.tip = tip;
  el.railProj.setAttribute("aria-label", "项目");
}

/** 项目区 / 轨道按钮 / 降级态都从这里刷新，别在两处各写一份显示逻辑 */
function syncProjectPill() {
  const switcher = state.switcher;
  const hasWorkspace = Boolean(switcher.workspace);
  const unavailable = Boolean(switcher.unavailable);
  const tip = unavailable
    ? PROJECT_UNAVAILABLE_HINT
    : hasWorkspace
      ? `主项目：${switcher.workspace?.rootPath || ""} · ${switcher.subCount} 个子项目`
      : "设置主项目";
  syncProjectRows(state.switcher.items || []);
  syncRailProject(tip);
}

/* 项目弹层的两个线描图标（静态图元，不引图标库/远程图片）：
   主项目=文件夹，子项目=折入箭头，配合缩进表达层级。 */
const PROJECT_ICONS = {
  main:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  sub: '<path d="M4 4v6a4 4 0 0 0 4 4h12"/><path d="m15 9 5 5-5 5"/>',
  explorer:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="m14 13 2 2-2 2"/><path d="M8 15h4"/>',
  browse:
    '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
};

function projectIcon(kind) {
  const slot = document.createElement("span");
  slot.className = `proj-ico is-${kind}`;
  slot.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  // 只写入本文件里的常量图元，不拼接任何用户数据
  svg.innerHTML = PROJECT_ICONS[kind] || "";
  slot.append(svg);
  return slot;
}

/** 行尾小动作钮（2026-11-06 文件浏览入口）：在资源管理器中打开 / 浏览文件。 */
function projActionButton(icon, label, tip, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "proj-act";
  button.title = tip;
  button.setAttribute("aria-label", `${label}：${tip}`);
  const slot = document.createElement("span");
  slot.className = "proj-act-ico";
  slot.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // 只写入本文件里的常量图元，不拼接任何用户数据
  svg.innerHTML = PROJECT_ICONS[icon] || "";
  slot.append(svg);
  button.append(slot);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** 让服务端对本机目录起系统资源管理器（projectId 缺省 = 工作区根）。 */
async function openExplorerInOs(projectId) {
  try {
    const response = await request("/api/v1/workspaces/open-explorer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(projectId ? { projectId } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 404 = 这个进程还是没带文件入口的旧版本（端点 18:39 才合入）。
      // 以前这里只说「打不开资源管理器」，用户完全不知道是版本问题。
      if (response.status === 404) {
        toast(SERVICE_TOO_OLD_HINT);
        return;
      }
      toast(`打不开资源管理器：${data.message || data.error || `HTTP ${response.status}`}`);
      return;
    }
    closeProjectMenu();
  } catch (error) {
    if (error.message !== "forbidden") toast("打不开资源管理器，重启服务后再试");
  }
}

const SERVICE_TOO_OLD_HINT = "服务还是旧版本（没有文件/资源管理器接口），重启服务后再点";

/** 侧栏文件浏览器（只读）：列目录 + 看文本，路径锁在工作区内。
 *
 *  `startRel` 是**工作区内相对路径**（子项目进来就是它自己的相对路径），
 *  所以面包屑必须以工作区根名打头，不能拿项目名当根——否则子项目会显示成
 *  `tmp-ws-test/tmp-ws-test`（2026-11-06 修）。
 */
function openFileBrowser(projectName, startRel, rootLabel) {
  const browser = { name: projectName, rel: startRel || "" };
  const base = rootLabel || projectName;
  const crumbOf = (rel) => (rel ? `${base}/${rel}` : `${base}/`);
  openModal(`文件 · ${projectName}`, (body) => {
    body.classList.add("file-browser");
    const bar = document.createElement("div");
    bar.className = "fb-bar";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "ghost fb-up";
    up.textContent = "上一级";
    const crumb = document.createElement("span");
    crumb.className = "fb-crumb";
    bar.append(up, crumb);
    const list = document.createElement("div");
    list.className = "fb-list";
    const viewer = document.createElement("pre");
    viewer.className = "fb-view";
    viewer.hidden = true;
    body.append(bar, list, viewer);

    const parentOf = (rel) => {
      const idx = rel.lastIndexOf("/");
      return idx === -1 ? "" : rel.slice(0, idx);
    };

    up.addEventListener("click", () => {
      if (viewer.hidden) {
        if (browser.rel) load(parentOf(browser.rel));
      } else {
        // 从正文退回列表：面包屑要跟着退回目录，不能停在文件名上
        viewer.hidden = true;
        list.hidden = false;
        crumb.textContent = crumbOf(browser.rel);
      }
    });

    const entryPath = (name) => (browser.rel ? `${browser.rel}/${name}` : name);

    async function load(rel) {
      browser.rel = rel;
      viewer.hidden = true;
      list.hidden = false;
      crumb.textContent = crumbOf(rel);
      up.disabled = !rel;
      list.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "fb-empty";
      loading.textContent = "读取中…";
      list.append(loading);
      try {
        const response = await request(`/api/v1/files?path=${encodeURIComponent(rel)}`, {
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          loading.textContent =
            response.status === 404
              ? SERVICE_TOO_OLD_HINT
              : data.message || `读不到（HTTP ${response.status}）`;
          return;
        }
        list.replaceChildren();
        if (!data.entries.length) {
          const empty = document.createElement("div");
          empty.className = "fb-empty";
          empty.textContent = "空目录";
          list.append(empty);
          return;
        }
        for (const entry of data.entries) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = `fb-row is-${entry.type}`;
          const name = document.createElement("span");
          name.className = "fb-name";
          name.textContent = entry.type === "dir" ? `${entry.name}/` : entry.name;
          const meta = document.createElement("span");
          meta.className = "fb-meta";
          meta.textContent = entry.type === "dir" ? "目录" : `${entry.size} 字节`;
          row.append(name, meta);
          row.addEventListener("click", () => {
            if (entry.type === "dir") load(entryPath(entry.name));
            else view(entryPath(entry.name), entry.size);
          });
          list.append(row);
        }
      } catch (error) {
        loading.textContent =
          error.message === "forbidden" ? "没有权限" : "读不到文件列表，重启服务后再试";
      }
    }

    async function view(path, size) {
      list.hidden = true;
      viewer.hidden = false;
      viewer.textContent = "读取中…";
      crumb.textContent = crumbOf(path);
      try {
        const response = await request(`/api/v1/files/content?path=${encodeURIComponent(path)}`, {
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          viewer.textContent =
            response.status === 404
              ? SERVICE_TOO_OLD_HINT
              : data.message || `读不到（HTTP ${response.status}）`;
          return;
        }
        if (data.content === null) {
          viewer.textContent =
            data.truncated && data.size > 524288
              ? `文件过大（${data.size} 字节），不预览正文`
              : "二进制文件，不预览正文";
          return;
        }
        viewer.textContent = data.content;
      } catch (error) {
        viewer.textContent = error.message === "forbidden" ? "没有权限" : "读不到文件内容";
      }
    }

    load(browser.rel);
  });
}

/** 弹层内容：主项目（带标注）+ 子项目总览 + 底部「添加子项目 · 设置主项目 · 管理项目」。
 *  行本身仍只读总览；行尾两颗小钮是文件入口（2026-11-06 文件浏览入口）：
 *  资源管理器按项目直达自己的根（用户诉求：多个工作区不知道打开哪个），文件浏览器只读看文本。
 *
 *  两层语义（2026-11-06 补说明，用户问过"子项目是什么"）：
 *  主项目 = 最大工作区根，打杂/临时文件放这里；子项目 = 登记进工作区的独立目录，
 *  通常是代码仓库或另一个项目。两者都在同一条权限边界内——非完全访问档下助手只能在这两个空间里动。 */
function renderProjectMenu(items) {
  const menu = el.projectMenu;
  if (!menu) return;
  menu.replaceChildren();
  const workspace = state.switcher.workspace;
  const hasWorkspace = Boolean(workspace?.rootPath);
  const mainLabel = baseNameOf(workspace?.rootPath) || "主项目";

  if (hasWorkspace) {
    const main = document.createElement("div");
    main.className = "proj-item is-static is-main";
    main.title = workspace.rootPath;
    const mainName = document.createElement("span");
    mainName.className = "proj-item-name";
    mainName.textContent = mainLabel;
    const mainTag = document.createElement("span");
    mainTag.className = "proj-tag";
    mainTag.textContent = "主项目";
    main.append(projectIcon("main"), mainName, mainTag);
    // 文件入口：主项目行尾「在资源管理器中打开」+「浏览文件」（相对路径 = 工作区根）
    main.append(
      projActionButton("browse", "浏览文件", "在界面里看这个目录的文件", () =>
        openFileBrowser(mainLabel, "", mainLabel),
      ),
      projActionButton("explorer", "在资源管理器中打开", "在系统的文件资源管理器里打开这个目录", () => openExplorerInOs("")),
    );
    menu.append(main);
  } else {
    const empty = document.createElement("div");
    empty.className = "proj-empty";
    empty.textContent = "还没有主工作区。先设置主项目，项目才能登记进来。";
    menu.append(empty);
  }

  if (hasWorkspace && items.length) {
    const sep = document.createElement("div");
    sep.className = "proj-sep";
    sep.setAttribute("role", "none");
    menu.append(sep);
  }

  for (const project of items) {
    if (!hasWorkspace) break;
    const row = document.createElement("div");
    row.className = "proj-item is-static is-sub";
    row.title = project.rootPath || project.name;
    const name = document.createElement("span");
    name.className = "proj-item-name";
    name.textContent = project.name;
    row.append(projectIcon("sub"), name);
    // 行尾标注异常：目录丢了（黄）优先于跑出工作区（灰）
    if (project.missing || project.outside) {
      const tag = document.createElement("span");
      tag.className = `proj-tag ${project.missing ? "is-warn" : "is-idle"}`;
      tag.textContent = project.missing ? "目录不在了" : "不在工作区";
      row.append(tag);
    } else {
      // 目录健康才有文件入口：起点 = 项目自己在工作区内的相对路径，按项目直达
      const startRel = relativeWithinWorkspace(workspace.rootPath, project.rootPath);
      row.append(
        projActionButton("browse", "浏览文件", `在界面里看「${project.name}」的文件`, () =>
          openFileBrowser(project.name, startRel || "", mainLabel),
        ),
        projActionButton("explorer", "在资源管理器中打开", `在系统的文件资源管理器里打开「${project.name}」`, () =>
          openExplorerInOs(project.id),
        ),
      );
    }
    menu.append(row);
  }

  if (hasWorkspace && !items.length) {
    const empty = document.createElement("div");
    empty.className = "proj-empty";
    empty.textContent = "还没有子项目。";
    menu.append(empty);
  }

  // 层级说明（2026-11-06）：两行就够，别把弹层撑成说明书
  if (hasWorkspace) {
    const legend = document.createElement("div");
    legend.className = "proj-legend";
    const line1 = document.createElement("p");
    line1.textContent = "主项目 = 最大工作区，打杂和临时文件放这里。";
    const line2 = document.createElement("p");
    line2.textContent = "子项目 = 登记进来的独立目录，通常是代码仓库或另一个项目。";
    const line3 = document.createElement("p");
    line3.textContent = "不在完全访问档时，助手只能在这两个空间里动手。";
    legend.append(line1, line2, line3);
    menu.append(legend);
  }

  const foot = document.createElement("div");
  foot.className = "proj-foot";

  // 添加子项目：没有工作区时置灰，title 指明先去设置主项目
  const addSub = document.createElement("button");
  addSub.type = "button";
  addSub.className = "proj-manage";
  addSub.textContent = "添加子项目";
  if (hasWorkspace) {
    addSub.addEventListener("click", () => {
      closeProjectMenu();
      openAddSubprojectModal();
    });
  } else {
    addSub.setAttribute("aria-disabled", "true");
    addSub.title = "先设置主项目";
  }

  // 设置主项目：设置（或更换）最大工作区根目录
  const addMain = document.createElement("button");
  addMain.type = "button";
  addMain.className = "proj-manage";
  addMain.textContent = "设置主项目";
  addMain.title = hasWorkspace ? "更换最大工作区根目录" : "设定最大工作区根目录";
  addMain.addEventListener("click", () => {
    closeProjectMenu();
    openAddWorkspaceModal();
  });

  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "proj-manage";
  manage.textContent = "管理项目 → 设置";
  manage.addEventListener("click", () => {
    closeProjectMenu();
    go("settings", "projects");
  });

  foot.append(addSub, addMain, manage);
  menu.append(foot);
}

/* ── 添加项目弹窗（2026-11-05 F1）────────────────────────
 * 主项目 = 工作区根；子项目 = 工作区内登记项。
 * 两个弹窗共用同一套壳桥接：壳内多一颗「选择目录」，浏览器手输绝对路径。
 * 子项目提交 proposal 后立刻 confirm —— 目录是用户亲手选的，不再二次确认。 */

function baseNameOf(path) {
  const text = String(path || "").trim().replace(/[\\/]+$/, "");
  if (!text) return "";
  const parts = text.split(/[\\/]+/);
  return parts[parts.length - 1] || "";
}

function isAbsolutePath(path) {
  const text = String(path || "").trim();
  // Windows 盘符 / UNC，或 POSIX 根；具体合法性仍由服务端复核
  return /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text) || text.startsWith("/");
}

/** 目标是否严格位于工作区内；返回相对路径，落在外面返回 null */
function relativeWithinWorkspace(rootPath, targetPath) {
  const clean = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const root = clean(rootPath);
  const target = clean(targetPath);
  if (!root || !target) return null;
  const fold = /^[a-zA-Z]:\//.test(root) || root.startsWith("//");
  const left = fold ? root.toLowerCase() : root;
  const right = fold ? target.toLowerCase() : target;
  // 必须严格在下面：项目不能就是工作区根本身
  if (right === left || !right.startsWith(`${left}/`)) return null;
  return target.slice(root.length + 1);
}

/** 主项目/子项目落库后，侧栏 pill 与设置页项目列表一起刷新 */
async function refreshProjectViews() {
  await refreshProjectPill();
  if (currentRoute() === "settings" && currentSettingsPage() === "projects") {
    await loadProjectsSettings();
  }
}

function setModalHint(node, text, isError = true) {
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-error", Boolean(isError));
}

function clearModalHint(node) {
  if (!node) return;
  node.textContent = "";
  node.classList.remove("is-error");
}

function openAddWorkspaceModal() {
  const currentRoot = state.switcher.workspace?.rootPath || "";
  openModal("设置主项目", (body) => {
    body.innerHTML = `
      <p class="modal-desc">这是最大工作区边界，助手只能在这个目录内操作；更换会清空当前项目选择。</p>
      <div class="modal-field">
        <span>目录（绝对路径）</span>
        <div class="modal-row">
          <input class="modal-input" id="add-workspace-path" type="text" spellcheck="false"
                 placeholder="例如：D:/Projects" value="${attr(currentRoot)}" />
          ${inShell() ? '<button class="ghost" id="add-workspace-pick" type="button">选择目录</button>' : ""}
        </div>
      </div>
      <p class="modal-hint" id="add-workspace-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="add-workspace-confirm" type="button">确认</button>
      </div>`;

    const pathInput = body.querySelector("#add-workspace-path");
    const hint = body.querySelector("#add-workspace-hint");
    const confirm = body.querySelector("#add-workspace-confirm");
    const pick = body.querySelector("#add-workspace-pick");

    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    pick?.addEventListener("click", async () => {
      const chosen = await selectDirectory();
      if (!chosen) return; // 用户取消：保留原值
      pathInput.value = chosen;
      clearModalHint(hint);
    });

    const submit = async () => {
      if (confirm.disabled) return;
      const rootPath = pathInput.value.trim();
      if (!rootPath) {
        setModalHint(hint, "先选一个目录。");
        pathInput.focus();
        return;
      }
      if (!isAbsolutePath(rootPath)) {
        setModalHint(hint, "目录要写绝对路径。");
        pathInput.focus();
        return;
      }
      confirm.disabled = true;
      hint.textContent = "保存中…";
      hint.classList.remove("is-error");
      try {
        const response = await request("/api/v1/workspaces", {
          method: "POST",
          body: JSON.stringify({ rootPath }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          return;
        }
        closeModal();
        toast("主项目已设置");
        await refreshProjectViews();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal(); // 令牌门在最上层，别让模态挡住它
          return;
        }
        setModalHint(hint, `没存成：${error.message}`);
      } finally {
        confirm.disabled = false;
      }
    };

    confirm.addEventListener("click", () => void submit());
    pathInput.addEventListener("input", () => clearModalHint(hint));
    pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
  });
}

/**
 * 项目 ＋ 的双入口（2026-11-07 四改，用户口径「项目的加号：用于创建新项目或添加子项目」）。
 *
 * 两个动作的区别（服务端已经这么分工，前端只是把它们摆到同一个 ＋ 下）：
 *   · 新建项目 —— 目录还不存在，确认时服务端 mkdir 再登记（POST /projects → confirm）；
 *   · 添加子项目 —— 目录已经在硬盘上（多半是已有仓库），只登记、不建目录。
 * 位置按 ＋ 实测坐标写，右侧放不下就翻到左边；点外面 / Esc 关。
 */
function closeProjectAddMenu() {
  const menu = document.getElementById("proj-add-menu");
  if (!menu) return;
  menu.remove();
  el.secProjectsAdd?.setAttribute("aria-expanded", "false");
}

function openProjectAddMenu() {
  const button = el.secProjectsAdd;
  if (!button) return;
  if (document.getElementById("proj-add-menu")) {
    closeProjectAddMenu();
    return;
  }
  const menu = document.createElement("div");
  menu.id = "proj-add-menu";
  menu.className = "proj-add-menu";
  menu.setAttribute("role", "menu");

  const make = (label, hint, run) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "proj-add-item";
    item.setAttribute("role", "menuitem");
    const title = document.createElement("span");
    title.className = "proj-add-label";
    title.textContent = label;
    const sub = document.createElement("span");
    sub.className = "proj-add-hint";
    sub.textContent = hint;
    item.append(title, sub);
    item.addEventListener("click", () => {
      closeProjectAddMenu();
      run();
    });
    return item;
  };

  menu.append(
    make("新建项目", "目录还不存在，确认后建目录并登记", () => openCreateProjectModal()),
    make("添加已有子项目", "目录已经在硬盘上，只登记不新建", () => openAddSubprojectModal()),
  );
  document.body.append(menu);

  // 定位：菜单挂在 body 下（不被侧栏 overflow 裁掉），坐标按按钮实测
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = rect.right - width;
  let top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(48, top))}px`;
  button.setAttribute("aria-expanded", "true");

  // 首次点外面就关；用 setTimeout 避开"打开这一下"自身
  setTimeout(() => {
    const onDown = (event) => {
      if (event.target.closest("#proj-add-menu") || event.target === button) return;
      closeProjectAddMenu();
      document.removeEventListener("pointerdown", onDown, true);
    };
    document.addEventListener("pointerdown", onDown, true);
  }, 0);
}

/**
 * 新建项目（目录不存在）：POST /projects 提交待确认请求 → 立刻 confirm。
 * 与「添加子项目」共用同一套校验，差别只在文案与「会把目录建出来」这件事。
 */
function openCreateProjectModal() {
  const rootPath = state.switcher.workspace?.rootPath || settingsWorkspace?.rootPath || "";
  if (!rootPath) {
    toast("先设置主项目");
    openAddWorkspaceModal();
    return;
  }
  openModal("新建项目", (body) => {
    body.innerHTML = `
      <p class="modal-desc">新项目会建在主工作区目录下。写一个还不存在的子目录名，确认后由服务端创建并登记。</p>
      <div class="modal-field">
        <span>项目名</span>
        <input class="modal-input" id="new-project-name" type="text" maxlength="60"
               placeholder="例如：new-tool" />
      </div>
      <div class="modal-field">
        <span>目录（相对主工作区，可留空 = 用项目名）</span>
        <input class="modal-input" id="new-project-path" type="text" spellcheck="false"
               placeholder="例如：tools/new-tool" />
      </div>
      <p class="modal-hint" id="new-project-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="new-project-confirm" type="button">创建</button>
      </div>`;

    const nameInput = body.querySelector("#new-project-name");
    const pathInput = body.querySelector("#new-project-path");
    const hint = body.querySelector("#new-project-hint");
    const confirm = body.querySelector("#new-project-confirm");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    const submit = async () => {
      if (confirm.disabled) return;
      const name = nameInput.value.trim();
      const raw = pathInput.value.trim() || name;
      if (!name) {
        setModalHint(hint, "先给项目起个名字。");
        nameInput.focus();
        return;
      }
      if (isAbsolutePath(raw)) {
        setModalHint(hint, "这里填相对主工作区的路径；已有目录请用「添加已有子项目」。");
        pathInput.focus();
        return;
      }
      confirm.disabled = true;
      hint.textContent = "创建中…";
      hint.classList.remove("is-error");
      try {
        const response = await request("/api/v1/projects", {
          method: "POST",
          body: JSON.stringify({ name, path: raw }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          return;
        }
        const proposalId = data?.proposal?.id;
        if (!proposalId) {
          setModalHint(hint, "服务端没有返回待确认请求，刷新后再试。");
          return;
        }
        const confirmed = await request(
          `/api/v1/projects/${encodeURIComponent(proposalId)}/confirm`,
          { method: "POST" },
        );
        const confirmedData = await confirmed.json().catch(() => ({}));
        if (!confirmed.ok) {
          setModalHint(hint, projectErrorText(confirmedData, confirmed.status));
          return;
        }
        closeModal();
        toast(`已创建 ${name}`);
        await refreshProjectViews();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没建成：${error.message}`);
      } finally {
        confirm.disabled = false;
      }
    };

    confirm.addEventListener("click", () => void submit());
    for (const input of [nameInput, pathInput]) {
      input.addEventListener("input", () => clearModalHint(hint));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      });
    }
  });
}

function openAddSubprojectModal(explicitRoot) {
  // 设置页「添加子项目」不走侧栏切换器，根目录用设置页刚读到的那份（state.switcher 可能还没拉）
  const rootPath = explicitRoot || state.switcher.workspace?.rootPath || settingsWorkspace?.rootPath || "";
  if (!rootPath) {
    toast("先设置主项目");
    return;
  }
  openModal("添加子项目", (body) => {
    body.innerHTML = `
      <p class="modal-desc">登记在最大工作区下，确认后立即生效；助手只能在这个项目目录里做事。</p>
      <div class="modal-field">
        <span>项目目录（绝对路径）</span>
        <div class="modal-row">
          <input class="modal-input" id="add-project-path" type="text" spellcheck="false"
                 placeholder="例如：D:/Projects/new-tool" />
          ${inShell() ? '<button class="ghost" id="add-project-pick" type="button">选择目录</button>' : ""}
        </div>
      </div>
      <div class="modal-field">
        <span>项目名</span>
        <input class="modal-input" id="add-project-name" type="text" maxlength="60"
               placeholder="默认取目录名，可改" />
      </div>
      <p class="modal-hint" id="add-project-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="add-project-confirm" type="button">确认</button>
      </div>`;

    const pathInput = body.querySelector("#add-project-path");
    const nameInput = body.querySelector("#add-project-name");
    const hint = body.querySelector("#add-project-hint");
    const confirm = body.querySelector("#add-project-confirm");
    const pick = body.querySelector("#add-project-pick");
    let nameTouched = false;

    const syncName = () => {
      if (!nameTouched) nameInput.value = baseNameOf(pathInput.value);
    };

    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    pick?.addEventListener("click", async () => {
      const chosen = await selectDirectory();
      if (!chosen) return;
      pathInput.value = chosen;
      syncName();
      clearModalHint(hint);
    });

    pathInput.addEventListener("input", () => {
      syncName();
      clearModalHint(hint);
    });
    nameInput.addEventListener("input", () => {
      nameTouched = true;
      clearModalHint(hint);
    });

    const submit = async () => {
      if (confirm.disabled) return;
      const path = pathInput.value.trim();
      const name = nameInput.value.trim();
      if (!path) {
        setModalHint(hint, "先选一个项目目录。");
        pathInput.focus();
        return;
      }
      if (!isAbsolutePath(path)) {
        setModalHint(hint, "目录要写绝对路径。");
        pathInput.focus();
        return;
      }
      if (!name) {
        setModalHint(hint, "给项目起个名字。");
        nameInput.focus();
        return;
      }
      const relativePath = relativeWithinWorkspace(rootPath, path);
      if (!relativePath) {
        setModalHint(hint, "必须在最大工作区内，先去设置主项目。");
        toast("必须在最大工作区内，先去设置主项目");
        return;
      }
      confirm.disabled = true;
      hint.textContent = "登记中…";
      hint.classList.remove("is-error");
      try {
        const response = await request("/api/v1/projects", {
          method: "POST",
          body: JSON.stringify({ name, path: relativePath }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          return;
        }
        const proposalId = data?.proposal?.id;
        if (!proposalId) {
          setModalHint(hint, "服务端没有返回待确认请求，刷新后再试。");
          return;
        }
        // 用户亲手选的目录：立即确认，不再弹第二次
        const confirmed = await request(
          `/api/v1/projects/${encodeURIComponent(proposalId)}/confirm`,
          { method: "POST" },
        );
        const confirmedData = await confirmed.json().catch(() => ({}));
        if (!confirmed.ok) {
          setModalHint(hint, projectErrorText(confirmedData, confirmed.status));
          return;
        }
        closeModal();
        toast(`已添加 ${name}`);
        await refreshProjectViews();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没登记成：${error.message}`);
      } finally {
        confirm.disabled = false;
      }
    };

    confirm.addEventListener("click", () => void submit());
    pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    });
  });
}

function closeProjectMenu() {
  projectOpenToken += 1;
  if (!el.projectMenu) return;
  // projectAnchor 指向最后用过的触发点（现在只剩收起轨道的项目钮），aria-expanded 才对得上
  closePopover(el.projectMenu, projectAnchor);
}

/**
 * 弹层定位：挂在 body 下、absolute 以视口为参照（页面不滚动），
 * 所以不会被侧栏收起动画的 overflow:hidden 裁掉。
 * 展开态贴着 pill 往上放，放不下再落回下面；轨道只有 72px 宽，往右弹、
 * 垂直对齐按钮。左右上下越界都夹回屏幕内（窄窗口 + 轨道态必需）。
 */
function placeProjectMenu(trigger) {
  const menu = el.projectMenu;
  if (!menu || !trigger) return;
  const anchor = trigger.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const gap = 8;
  const pad = 12;
  // 顶栏是 fixed 的 40px：弹层别钻到它下面去（z-index 也压在它之下）
  const minTop = 48;
  let left;
  let top;
  if (trigger.closest(".side-rail")) {
    left = anchor.right + gap;
    top = anchor.top + anchor.height / 2 - 18;
  } else {
    left = anchor.left;
    top = anchor.top - gap - height;
    if (top < minTop) top = anchor.bottom + gap;
  }
  left = Math.max(pad, Math.min(left, window.innerWidth - pad - width));
  top = Math.max(minTop, Math.min(top, window.innerHeight - pad - height));
  // openPopover 可能写过 right:0，这里改回 left 定位；只保留一套坐标
  menu.style.right = "auto";
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

async function toggleProjectMenu(trigger) {
  if (!el.projectMenu || !trigger) return;
  if (popoverOpen(el.projectMenu)) {
    closeProjectMenu();
    return;
  }
  if (projectLoading) return;
  // 上次接口读不到（旧后端 / 临时故障）：点一下先重试，仍不行再给明确提示。
  if (state.switcher.unavailable) {
    await refreshProjectPill();
    if (state.switcher.unavailable) {
      toast(PROJECT_UNAVAILABLE_HINT);
      return;
    }
  }
  projectLoading = true;
  const token = ++projectOpenToken;
  try {
    // 每次打开都现拉：不缓存（同模型菜单口径）
    const data = await fetchProjectSwitchData();
    // 现拉期间点过外面 / 换了路由：这次结果作废，别把弹层补出来
    if (token !== projectOpenToken) return;
    if (!data) {
      state.switcher.unavailable = true;
      syncProjectPill();
      toast(PROJECT_UNAVAILABLE_HINT);
      return;
    }
    applyProjectData(data);
    // 没有工作区也照常打开：里面还有「设置主项目」，是首次使用的唯一入口
    renderProjectMenu(data.items);
    projectAnchor = trigger;
    openPopover(el.projectMenu, trigger);
    // openPopover 会清掉 left/right，落点必须在它之后写
    placeProjectMenu(trigger);
  } catch (error) {
    if (error.message !== "forbidden") {
      state.switcher.unavailable = true;
      syncProjectPill();
      toast("读不到项目列表");
    }
  } finally {
    projectLoading = false;
  }
}

/** 启动 / 回到对话页时补一次 pill 文案：读不到就保持现状，下次打开弹层会再试 */
async function refreshProjectPill() {
  try {
    const data = await fetchProjectSwitchData();
    if (data) {
      applyProjectData(data);
      return;
    }
    // 接口在但没给数据（404/5xx）：降级成可见的「项目不可用」，
    // 不能让 pill 保持初始 hidden——那正是"项目凭空消失"的观感来源。
    state.switcher.unavailable = true;
    syncProjectPill();
  } catch (error) {
    // 403 交给令牌门；其它错误同样降级显示，下一次刷新会自动重试。
    if (error.message === "forbidden") return;
    state.switcher.unavailable = true;
    syncProjectPill();
  }
}

el.railProj?.addEventListener("click", () => void toggleProjectMenu(el.railProj));

el.modelPill?.addEventListener("click", () => void toggleModelMenu());
// 菜单里的点击不冒泡到「点外面就关」的判定：点供应商段会就地重渲染，
// 被替换掉的旧按钮已经脱离文档，冒泡到 document 时会被当成外部点击误关。
el.modelMenu?.addEventListener("click", (event) => event.stopPropagation());

// 对话右上角快捷设置（2026-11-07 抽屉改造）：三通道关闭 = Esc / X / 点遮罩。
// 2026-11-07 二次修：模型页改成卡片里的两个下拉，不再有供应商分段，
// 原来那条 providerchange → 同步批量区标签的接线随之删掉。
el.chatSettingsBtn?.addEventListener("click", () => void toggleChatSettings());
el.chatSettingsOverlay?.addEventListener("click", () => closeChatSettings());
el.groupSettingsOverlay?.addEventListener("click", () => closeGroupSettingsDrawer());
/* ── 附件（2026-11-08 扫尾批 4a）───────────────────────────
   三入口：选择器 / 粘贴 / 拖拽。浏览器侧先挡一次（只收图片、单张 ≤8MB、单条 ≤4 张），
   服务端还会全量复核——契约是公开的，前端校验只为体验，不能当边界。
   发送时有图才用分段数组；纯文本仍是老形状（shared 的 content union 兼容两态）。
   不做 blob 存储：base64 直接进服务端会话库（方案登记的已知边界）。 */
const MAX_PENDING_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function renderPendingImages() {
  const host = el.composerAttachments;
  if (!host) return;
  host.replaceChildren();
  host.hidden = state.pendingImages.length === 0;
  state.pendingImages.forEach((image, index) => {
    const item = document.createElement("div");
    item.className = "composer-att";
    const img = document.createElement("img");
    img.src = `data:${image.mimeType};base64,${image.data}`;
    img.alt = `待发图片 ${index + 1}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除这张图片");
    remove.title = "移除";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.pendingImages.splice(index, 1);
      renderPendingImages();
      syncSendEnabled();
    });
    item.append(img, remove);
    host.append(item);
  });
}

function clearPendingImages() {
  state.pendingImages = [];
  renderPendingImages();
  syncSendEnabled();
}

/** File → {mimeType, data(裸 base64)}；不合法返回 null，太大返回 {error} */
function readImageFile(file) {
  return new Promise((resolve) => {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      resolve(null);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      resolve({ error: "单张图片不能超过 8MB" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        resolve(null);
        return;
      }
      resolve({ mimeType: file.type, data: result.slice(comma + 1) });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  if (!state.capabilities.attachments) {
    toast("附件已在服务端关闭（AGENT_ATTACHMENTS=false）");
    return;
  }
  for (const file of list) {
    if (state.pendingImages.length >= MAX_PENDING_IMAGES) {
      toast(`一条消息最多 ${MAX_PENDING_IMAGES} 张图片`);
      break;
    }
    const image = await readImageFile(file);
    if (!image) {
      toast("只支持图片文件");
      continue;
    }
    if (image.error) {
      toast(image.error);
      continue;
    }
    state.pendingImages.push(image);
  }
  renderPendingImages();
  syncSendEnabled();
}

function openLightbox(src) {
  if (!el.lightbox || !el.lightboxImg || !src) return;
  el.lightboxImg.src = src;
  el.lightbox.hidden = false;
}

function closeLightbox() {
  if (!el.lightbox || !el.lightboxImg || el.lightbox.hidden) return;
  el.lightbox.hidden = true;
  el.lightboxImg.removeAttribute("src");
}

el.lightbox?.addEventListener("click", closeLightbox);

el.composerAdd?.addEventListener("click", () => {
  if (!state.capabilities.attachments) {
    toast("附件已在服务端关闭（AGENT_ATTACHMENTS=false）");
    return;
  }
  el.composerFile?.click();
});

el.composerFile?.addEventListener("change", () => {
  const files = el.composerFile.files ? [...el.composerFile.files] : [];
  el.composerFile.value = "";
  void addImageFiles(files);
});

// 粘贴图片：输入框里 Ctrl+V 直接进待发条（截图文是最常用的入口）
el.input.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  if (!files.length) return;
  event.preventDefault();
  void addImageFiles(files);
});

// 拖拽：整个 composer 是投放区（只拦 dragover 才收得到 drop）
el.composer.addEventListener("dragover", (event) => {
  if (!state.capabilities.attachments) return;
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
el.composer.addEventListener("drop", (event) => {
  if (!state.capabilities.attachments) return;
  const files = event.dataTransfer?.files ? [...event.dataTransfer.files] : [];
  if (!files.length) return;
  event.preventDefault();
  void addImageFiles(files);
});

/**
 * 能力投影（2026-11-08 4a）：GET /agent/policy 顺带带回 `attachments` / `editResend`。
 * 关着就把入口**收掉**（而不是点了再报错）；拉不到按默认开处理，不因为一次网络抖动
 * 把功能藏起来。
 *
 * 2026-11-08 扫尾批 8c：顺带读审批形态（`approvalMode`）。`blocking` = 旧的 120s 阻塞，
 * 卡片保留倒计时；缺省 `async` = 等待态落库，卡片显示「等待处理」、不显示倒计时。
 */
async function loadCapabilities() {
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    state.capabilities.attachments = data.attachments !== false;
    state.capabilities.editResend = data.editResend !== false;
    state.capabilities.approvalMode = data.approvalMode === "blocking" ? "blocking" : "async";
  } catch {
    return;
  }
  if (el.composerAdd) el.composerAdd.hidden = !state.capabilities.attachments;
  if (!state.capabilities.attachments) clearPendingImages();
  syncEditEntry();
}

// pill 在右组（D2），不能再用 .composer-tools 判内外：按触发 pill 和菜单自己判
document.addEventListener("click", (event) => {
  if (!event.target.closest("#model-pill") && !event.target.closest("#model-menu")) closeModelMenu();
  // 项目弹层有两个触发点（展开态 pill / 轨道按钮），菜单自己也算里面
  if (
    !event.target.closest("#proj-pill") &&
    !event.target.closest("#rail-proj") &&
    !event.target.closest("#proj-menu")
  ) {
    closeProjectMenu();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // 输入法豁免： composing 中 / keyCode 229（安卓输入法）的 Esc 不当关闭用
  if (event.isComposing || event.keyCode === 229) return;
  // 大图查看（2026-11-08）：它压在页面最上层，先关它
  if (el.lightbox && !el.lightbox.hidden) {
    event.stopImmediatePropagation();
    closeLightbox();
    return;
  }
  // 模态在最上层：先关它，别同时把下面的弹层/路由也收掉。
  // stopImmediatePropagation 是给 reduced-motion 的：没有动画时 modalOpen()
  // 立刻变 false，第二个全局 Esc 监听会以为是普通返回。
  if (modalOpen()) {
    event.stopImmediatePropagation();
    closeModal();
    return;
  }
  // 群设置抽屉压在群会话页上：先关抽屉，别把路由带回列表
  if (groupSettingsOpen()) {
    event.stopImmediatePropagation();
    closeGroupSettingsDrawer();
    return;
  }
  closeModelMenu();
  closeChatSettings();
  closeProjectMenu();
});

/** 插话意图（2026-11-07 消息即引导）：keydown 置位、submit 消费一次。 */
let steerNextSubmit = false;

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  // 插话意图先消费（2026-11-07 修）：放回 text 判空之后的话，Ctrl+Enter 对着
  // 空输入框按下时标志会残留，下一次普通发送就被误当成插话
  const steer = steerNextSubmit;
  steerNextSubmit = false;
  const text = el.input.value.trim();
  // 图片条（2026-11-08 4a）：纯图消息允许，所以判空要把附件算进去
  const images = state.pendingImages.slice();
  if (!text && !images.length) return;
  // 手动压缩斜杠命令（扫尾批 1 B1）：只认 /compact 一个，刻意不做通用命令系统。
  // 命中后不作为消息发送、不进历史；剩余文字当作 instructions，wait=1 等结果。
  const compactMatch = /^\/compact\b/i.exec(text);
  if (compactMatch) {
    if (images.length) {
      toast("压缩命令不能带图片");
      return;
    }
    el.input.value = "";
    resize();
    void runCompactCommand(text.slice(compactMatch[0].length).trim());
    return;
  }
  // 忙时两条路（2026-11-07 消息即引导；2026-11-08 扫尾批 8a 改排队落点）：
  //   Ctrl/⌘+Enter = 插话，带 whenBusy=steer 直接投到正在跑的这一轮；
  //   普通 Enter    = 排队，带 whenBusy=followUp 交给服务端落 durable（是下一轮的指令）。
  // 两条都只走纯文本（附件只在空闲时发，图先留在条上）。
  if (state.sending) {
    if (images.length) {
      toast("附件消息要等这一轮结束再发");
      return;
    }
    if (steer) {
      el.input.value = "";
      resize();
      void steerIntoTurn(text);
      return;
    }
    el.input.value = "";
    resize();
    void followUp(text);
    return;
  }
  el.input.value = "";
  resize();
  clearPendingImages();
  void send(text, images);
});

/** /compact（扫尾批 1 B1）：调手动压缩端点，等结果后用气泡（toast）提示。 */
async function runCompactCommand(instructions) {
  const conversationId = state.conversationId;
  if (!conversationId) {
    toast("先打开一条对话再压缩上下文");
    return;
  }
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/compact?wait=1`,
      { method: "POST", body: JSON.stringify({ instructions: instructions || undefined }) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(
        data?.reason === "llm_not_configured"
          ? "还没配置模型，压缩不可用"
          : data?.message || `压缩没成功：HTTP ${response.status}`,
      );
      return;
    }
    toast(data.waited === false ? "压缩已受理，仍在进行中" : "上下文已压缩");
  } catch (error) {
    if (error.message !== "forbidden") toast(`压缩没成功：${error.message}`);
  }
}

el.input.addEventListener("input", () => {
  resize();
  syncSendEnabled();
});

el.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  const modSend = localStorage.getItem(KEY_SEND) === "mod-enter";
  const withMod = event.metaKey || event.ctrlKey;
  // 插话快路（2026-11-07 消息即引导）：忙时 Ctrl/⌘+Enter **一律**是插话。
  // 它不受"发送快捷键"设置影响——那是"怎么把这句话变成一轮"的偏好，
  // 而插话是"把这句话塞进正在跑的那一轮"，两件事。
  // 这条必须排在前面的原因：Enter 模式下的发送条件是"不带修饰键"，
  // 若按那个条件判，带 Ctrl 的按键会被直接放行成换行，插话永远进不去（实测踩过）。
  if (state.sending && withMod && !event.shiftKey) {
    event.preventDefault();
    steerNextSubmit = true;
    el.composer.requestSubmit();
    return;
  }
  // Enter 模式：不带修饰键就发送（Shift 仍是换行）；Ctrl+Enter 模式：必须带修饰键。
  if (modSend ? withMod : !event.shiftKey && !withMod) {
    event.preventDefault();
    steerNextSubmit = false;
    el.composer.requestSubmit();
  }
});

// 全局快捷键：跟大多数桌面 Agent 一致
document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) {
    if (event.key === "Escape") {
      // 模态的 Esc 由上一处监听处理；这里别再顺手退回设置/任务页
      if (modalOpen()) return;
      if (!el.menuPop.hidden) closeMenu();
      else if (currentRoute() === "settings") go("chat");
      else if (currentRoute() === "domains") go("chat");
      else if (currentRoute() === "tasks") {
        // 详情先退回看板，再按一次才回对话；跟设置页的返回逻辑一致
        if (currentTicketId()) go("tasks");
        else go("chat");
      } else if (currentRoute() === "group") {
        // 群组两层：群会话先退到群列表，列表再按一次才回对话
        // （2026-11-07：顶栏返回键的 title 一直写着「返回对话 (Esc)」，
        //  但 Esc 根本没绑过；这里把承诺补上，语义与任务页逐字同构）。
        if (groupRouteId()) location.hash = "#/groups";
        else go("chat");
      }
    }
    return;
  }
  if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    go("chat");
    startNewChat("worker");
  } else if (event.key === ",") {
    event.preventDefault();
    go("settings");
  } else if (event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
  }
});

function resize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 200)}px`;
}

/** 停止当前这一轮：人的明确意图（跟客户端断开是两回事） */
async function stopStreaming() {
  if (!state.conversationId) return;
  state.stopRequested = true;
  try {
    await request(`/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/stop`, {
      method: "POST",
    });
  } catch {
    /* 停不下来也别拦着用户 */
  }
}

// 流式时按钮是「停止」：拦下表单提交，改走停止接口
el.send.addEventListener("click", (event) => {
  if (!state.sending) return;
  event.preventDefault();
  void stopStreaming();
});

el.newChat?.addEventListener("click", () => {
  go("chat");
  startNewChat("worker");
});

// 代码块复制（批次一）：事件挂在 thread 上，消息增删不用重挂；
// 读 pre 的 innerText，流式中也能复制到当前最新的文本
el.thread.addEventListener("click", async (event) => {
  const button = event.target.closest(".code-copy");
  if (!button) return;
  const pre = button.parentElement?.querySelector("pre.code");
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.innerText);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  setTimeout(() => {
    button.textContent = "复制";
  }, 1500);
});

/* ── 全部数据导出（2026-11-05 J1）──────────────────────
   单对话导出退役，入口挪到设置 → 会话。走 request() 拿 blob（带凭据，
   403 时能 toast），不裸跳转——裸跳转拿不到错误响应。 */
async function exportAllData() {
  try {
    const response = await request("/api/v1/agent/export", { cache: "no-store" });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.message || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const name =
      match?.[1] || `selenite-export-${new Date().toISOString().slice(0, 10)}.json`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    toast("已导出");
  } catch (error) {
    toast(error.message === "forbidden" ? "导出失败：没有访问权限" : `导出失败：${error.message}`);
  }
}

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
// 总管首字圆钮 → 打开总管会话（与展开态总管条目同一个函数，行为完全一致）
el.railChief?.addEventListener("click", openChiefChat);
el.railPartners?.addEventListener("click", () => {
  if (!sidebarOpen()) toggleSidebar();
});

for (const hint of document.querySelectorAll("[data-hint]")) {
  hint.addEventListener("click", () => {
    el.input.value = hint.dataset.hint;
    resize();
    el.send.disabled = false;
    el.input.focus();
  });
}

/* ── 设置页 ───────────────────────────────────────────── */

const ACCENTS = [
  { id: "indigo", name: "靛蓝", chip: "#3e4a8c" },
  { id: "gold", name: "暖金", chip: "#b89b6e" },
  { id: "amber", name: "琥珀", chip: "#e0a84a" },
];

let pairTimer = 0;

// 每项 icon 是 Lucide 0.468 官方图标的内部图元（24 视框，外层 svg 统一给属性），
// 不再只存一条 path：Lucide 里 bells/server 等多图元图标拼不出来。
const SETTINGS_SECTIONS = [
  {
    id: "appearance",
    label: "外观",
    icon: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  },
  { id: "chats", label: "会话", icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  {
    id: "projects",
    label: "项目",
    icon: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  },
  {
    id: "reminders",
    label: "提醒",
    icon: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  },
  {
    id: "connect",
    label: "连接",
    icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  },
  {
    id: "service",
    label: "服务",
    icon: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  },
  {
    id: "memory",
    label: "记忆",
    // Lucide brain 0.468 完整八图元（2026-11-06）：只取左右两瓣会画成「（ ）」，
    // 内部的沟回才是让它在 15px 下仍认得出是「脑」的部分。
    icon: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  },
  // 2026-11-07：「头像」不再单开分区——头像并进「人设」（执事页的编辑弹窗），
  // 因为它和 SOUL 回答的是同一个问题「这个角色是谁」。旧路由 #/settings/avatars
  // 由 currentSettingsPage() 做别名落到 partners，老书签不会 404 成空页。
  {
    id: "partners",
    label: "人设",
    // Lucide user-round-pen 族：人形 + 笔，表示「改这个角色的设定」
    icon: '<circle cx="10" cy="8" r="5"/><path d="M2 21a8 8 0 0 1 12.9-6.3"/><path d="M18 15l3 3-6 6-3.5.5.5-3.5z"/>',
  },
  {
    id: "about",
    label: "关于",
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  },
];

/**
 * 设置页左侧分区导航：点击真切页（hash 子路由），一次只渲染当前分区。
 * 形态同 cindy 的 SettingsSidebarNav：36px 胶囊行 + 15px 图标，选中走中性底。
 */
function renderSettingsNav(page) {
  el.settingsNav.replaceChildren();
  el.settingsNav.setAttribute("role", "tablist");
  for (const section of SETTINGS_SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `settings-tab-${section.id}`;
    button.dataset.section = section.id;
    button.title = section.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(section.id === page));
    button.setAttribute("aria-controls", "settings-inner");
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${section.icon}</svg><span>${section.label}</span>`;
    button.addEventListener("click", () => {
      // 同页再点不重渲染（cindy 同款早退）；跨页改 hash，applyRoute 接手渲染
      if (section.id !== page) go("settings", section.id);
    });
    el.settingsNav.append(button);
  }
}

/** 搜索从主界面挪到设置里：主页面只留说话框 */
function wireSettingsSearch() {
  const input = document.getElementById("settings-search");
  const results = document.getElementById("search-results");
  if (!input || !results) return;

  let contentTimer = 0;
  const renderHits = (box, hits, emptyText) => {
    box.replaceChildren();
    if (!hits.length) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<div class="row-main"><div class="row-hint">${emptyText}</div></div>`;
      box.append(row);
      return;
    }
    for (const hit of hits) {
      const row = document.createElement("div");
      row.className = "row search-hit";
      row.innerHTML = `<div class="row-main">
        <div class="row-label">${hit.label}</div>
        <div class="row-hint">${esc(hit.hint)}</div>
      </div>`;
      row.addEventListener("click", () => void openConversation(hit.conversationId));
      box.append(row);
    }
  };

  input.addEventListener("input", () => {
    const query = input.value.trim();
    const lower = query.toLowerCase();
    results.replaceChildren();
    const contentBox = document.getElementById("content-results");
    if (contentBox) contentBox.replaceChildren();
    if (!query) return;

    // 标题/首句：本地即时过滤（原有行为）
    const hits = state.chats
      .filter((chat) => `${chat.title || ""} ${chat.firstText || ""}`.toLowerCase().includes(lower))
      .slice(0, 8);
    renderHits(
      results,
      hits.map((chat) => ({
        conversationId: chat.conversationId,
        label: esc(chatLabel(chat)),
        hint: `${chat.turns} 轮`,
      })),
      "没有匹配的会话",
    );

    // 正文内容（批次二）：≥2 字符才查服务端，300ms 防抖
    clearTimeout(contentTimer);
    if (query.length < 2 || !contentBox) return;
    contentTimer = setTimeout(async () => {
      try {
        const response = await request(`/api/v1/agent/search?q=${encodeURIComponent(query)}`, {
          cache: "no-store",
        });
        const data = await response.json();
        const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        const mark = (snippet) =>
          esc(snippet).replace(re, (m) => `<mark>${m}</mark>`);
        renderHits(
          contentBox,
          (data.hits || []).map((hit) => ({
            conversationId: hit.conversationId,
            label: mark(hit.text),
            hint: `${hit.title || "对话"} · ${hit.role === "user" ? "我" : "Selenite"} · ${new Date(hit.at).toLocaleString("zh-CN")}`,
          })),
          "正文里没有命中",
        );
      } catch (error) {
        if (error.message !== "forbidden") {
          renderHits(contentBox, [], `搜不到：${error.message}`);
        }
      }
    }, 300);
  });
}

function rowMarkup(label, hint, control) {
  return `<div class="row">
    <div class="row-main">
      <div class="row-label">${label}</div>
      ${hint ? `<div class="row-hint">${hint}</div>` : ""}
    </div>
    <div class="row-control">${control}</div>
  </div>`;
}

/** 通用开关（2026-11-05 G1）：设置页所有布尔项共用这一份结构，
 *  几何/形变对齐 CINDY components/ui/switch（36×20 轨道、16px thumb、
 *  hover 17px / 按下 18×14）。行为（写哪个 key、要不要打接口）由各自的 click 监听决定。 */
function switchMarkup(checked, { label, attrs = "" } = {}) {
  return `<button class="switch" type="button" role="switch"
    aria-checked="${checked ? "true" : "false"}" aria-label="${label || ""}" ${attrs}>
    <span class="switch-thumb" aria-hidden="true"></span>
  </button>`;
}

/*
 * 分段控件共享滑行高亮（2026-11-05 H1）。
 * 结构照 CINDY components/ui/segmented-control.tsx：容器 relative，第一个子元素是
 * aria-hidden 的绝对定位小胶囊；选中按钮的 offset 量出来写进 transform / width / height，
 * 由 CSS 的 200ms ease-move 过渡负责滑动。任何 `.segmented.slide` 都能复用，
 * 不绑定权限那一处；没加 .slide 的老分段控件仍是原来的瞬时高亮。
 */
function segmentedPlateOf(root) {
  let plate = root.querySelector(":scope > .segmented-plate");
  if (!plate) {
    plate = document.createElement("span");
    plate.className = "segmented-plate";
    plate.setAttribute("aria-hidden", "true");
    root.insertBefore(plate, root.firstChild);
  }
  return plate;
}

/** 把胶囊挪到当前 aria-checked=true 的按钮上；没有选中项就藏起来 */
function syncSegmented(root, { animate = true } = {}) {
  if (!root) return;
  const plate = segmentedPlateOf(root);
  const active = Array.from(root.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-checked") === "true",
  );
  if (!active) {
    root.removeAttribute("data-plate");
    return;
  }
  const rootRect = root.getBoundingClientRect();
  const buttonRect = active.getBoundingClientRect();
  // 面板隐藏时量出来全是 0：先不定位，等 ResizeObserver 在可见时再量
  if (!buttonRect.width || !buttonRect.height) return;
  // 绝对定位的 left/top 原点是 padding box，getBoundingClientRect 是 border box，
  // 所以减掉容器 border（clientLeft/clientTop），否则会差 1px。
  const x = buttonRect.left - rootRect.left - root.clientLeft;
  const y = buttonRect.top - rootRect.top - root.clientTop;
  const first = !root.hasAttribute("data-plate");
  if (first || !animate) {
    // 首帧/无动画：先关过渡再写值，写完强制回流，然后恢复过渡（不会从 (0,0) 滑进来）
    plate.style.transition = "none";
  }
  plate.style.transform = `translate(${x}px, ${y}px)`;
  plate.style.width = `${buttonRect.width}px`;
  plate.style.height = `${buttonRect.height}px`;
  if (first || !animate) {
    void plate.offsetWidth;
    plate.style.transition = "";
    root.setAttribute("data-plate", "ready");
  }
}

/** 只挂一次：首次定位 + 窗口/字体/标签变化时重新量（尺寸变化不做滑行动画） */
function mountSegmented(root) {
  if (!root || root.dataset.segmentedMounted === "1") return;
  root.dataset.segmentedMounted = "1";
  syncSegmented(root, { animate: false });
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => syncSegmented(root, { animate: false }));
    observer.observe(root);
    for (const button of root.querySelectorAll("button")) observer.observe(button);
  } else {
    window.addEventListener("resize", () => syncSegmented(root, { animate: false }));
  }
}

/** 一节 = 标题在卡片外 + 卡片；节距/标题-卡片间距由 .set-sec 定（cindy 的节律） */
function sectionMarkup(title, body) {
  return `<section class="set-sec">
    <h2 class="set-sec-title">${title}</h2>
    ${body}
  </section>`;
}

/** 切页进场重放：150ms 纯 opacity（.set-page.enter），瞬时回顶不做平滑 */
function replayPageEnter() {
  el.settingsScroll.scrollTop = 0;
  el.settingsInner.classList.remove("enter");
  void el.settingsInner.offsetWidth; // 强制 reflow，让同页连点也能重放
  el.settingsInner.classList.add("enter");
}

/*
 * 设置按子页渲染：左侧导航点哪个分区，这里就只挂哪个分区的 DOM。
 * 分区 → 子页映射见 SETTINGS_SECTIONS；每个子页内部再按「节」分组。
 */
async function renderSettings() {
  const page = currentSettingsPage();
  renderSettingsNav(page);
  el.settingsInner.setAttribute("role", "tabpanel");
  el.settingsInner.setAttribute("aria-labelledby", `settings-tab-${page}`);

  if (page === "appearance") {
    const choice = currentThemeChoice();
    const accent = localStorage.getItem(KEY_ACCENT) || "indigo";
    el.settingsInner.innerHTML = sectionMarkup(
      "外观",
      `<div class="card">
        ${rowMarkup(
          "主题",
          "四套色板，点哪套就固定下来（不再跟随系统）",
          `<div class="theme-picker" role="radiogroup" aria-label="主题">
             ${THEMES.map(
               (item) =>
                 `<button class="theme-choice" type="button" role="radio"
                    data-theme-choice="${item.id}" aria-checked="${choice === item.id}"
                    title="${item.name}" aria-label="${item.name}"
                    style="--tc-bg:${item.bg};--tc-card:${item.card};--tc-accent:${item.accent}">
                    <span class="theme-chip" aria-hidden="true">
                      <span class="theme-chip-dot"></span>
                      <span class="theme-chip-card"></span>
                    </span>
                    <span class="theme-name">${item.name}</span>
                  </button>`,
             ).join("")}
           </div>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "主题色",
          "三个都取自手机端色板，不另造颜色",
          `<div class="swatches" role="radiogroup" aria-label="主题色">
             ${ACCENTS.map(
               (item) =>
                 `<button class="swatch" type="button" data-accent-choice="${item.id}"
                    style="background:${item.chip}" title="${item.name}" aria-label="${item.name}"
                    aria-checked="${accent === item.id}"></button>`,
             ).join("")}
           </div>`,
        )}
      </div>`,
    );

    // 主题色板：点击即切 + 持久化，无需确认；当前项由 syncThemeControls 描边
    for (const button of el.settingsInner.querySelectorAll("[data-theme-choice]")) {
      button.addEventListener("click", () => setThemeChoice(button.dataset.themeChoice));
    }
    for (const button of el.settingsInner.querySelectorAll("[data-accent-choice]")) {
      button.addEventListener("click", () => setAccent(button.dataset.accentChoice));
    }
  } else if (page === "chats") {
    const sendKey = localStorage.getItem(KEY_SEND) || "enter";
    const showActs = localStorage.getItem(KEY_ACTS) !== "0";
    el.settingsInner.innerHTML = `${sectionMarkup(
      "会话",
      `<div class="card">
        ${rowMarkup(
          "搜索会话",
          "先按标题/第一句找；输入 2 字以上还会搜正文内容",
          `<input class="chat-search" id="settings-search" type="search" placeholder="搜索…" aria-label="搜索会话" />`,
        )}
        <div class="divider"></div>
        <div id="search-results"></div>
        <div id="content-results"></div>
        ${rowMarkup(
          "回车发送",
          "开启后回车直接发送；关掉则回车换行、Ctrl+Enter 发送",
          switchMarkup(sendKey === "enter", {
            label: "回车发送",
            attrs: 'data-send-key-switch',
          }),
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "工具活动",
          "关掉就只看回答，不看「读了哪个文件、跑了什么命令」",
          switchMarkup(showActs, { label: "显示工具活动", attrs: 'data-acts-switch' }),
        )}
        ${
          state.removed
            ? `<div class="divider"></div>
               ${rowMarkup(
                 "已移除的会话",
                 `有 ${state.removed} 个会话从列表里拿掉了，数据还在`,
                 `<button class="ghost" type="button" id="restore-chats">恢复</button>`,
               )}`
            : ""
        }
        <div class="divider"></div>
        ${rowMarkup(
          "导出全部数据",
          "会话、消息、供应商配置（不含密钥）打包成 JSON，自己存档或复制",
          `<button class="ghost" type="button" id="settings-export-all">导出</button>`,
        )}
      </div>`,
    )}
    ${sectionMarkup(
      "权限",
      `<div class="card">
        ${rowMarkup(
          "Agent 权限",
          "决定它能替你动到什么程度：完全访问 = 能改文件、能跑命令。改完立刻生效。",
          `<div class="segmented slide" role="radiogroup" aria-label="权限" id="policy-switch">
             <button type="button" data-policy="full" aria-checked="false">完全访问</button>
             <button type="button" data-policy="read-only" aria-checked="false">只读</button>
             <button type="button" data-policy="no-shell" aria-checked="false">不跑命令</button>
           </div>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "写操作逐次确认",
          "开启后，改文件 / 跑命令 / 派活前先问你一句。手机不进聊天流，审批走全局待办轮询，也能在这里或手机上答复。",
          switchMarkup(false, {
            label: "写操作逐次确认",
            attrs: 'id="policy-confirm-writes" data-confirm-writes',
          }),
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "自主轮（观察与审批）",
          "环境变量 AUTONOMY_ENABLED 控制；页面只读显示开 / 关，不在这里改。",
          `<span class="kv" id="policy-autonomy">…</span>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "待处理审批",
          "全局待办：其他会话等着的写操作也会列在这里；批准 / 拒绝与聊天卡片等价（重复答复幂等）。",
          `<span class="kv" id="pending-approval-count">…</span>`,
        )}
        <div id="pending-approval-list">
          <div class="row"><div class="row-main"><div class="row-hint">读取中…</div></div></div>
        </div>
      </div>`,
    )}`;

    wireSettingsSearch();
    const sendSwitch = el.settingsInner.querySelector("[data-send-key-switch]");
    sendSwitch?.addEventListener("click", () => {
      const next = sendSwitch.getAttribute("aria-checked") !== "true";
      sendSwitch.setAttribute("aria-checked", String(next));
      localStorage.setItem(KEY_SEND, next ? "enter" : "mod-enter");
    });
    const actsSwitch = el.settingsInner.querySelector("[data-acts-switch]");
    actsSwitch?.addEventListener("click", () => {
      const next = actsSwitch.getAttribute("aria-checked") !== "true";
      actsSwitch.setAttribute("aria-checked", String(next));
      localStorage.setItem(KEY_ACTS, next ? "1" : "0");
      applyActPref();
    });
    document.getElementById("restore-chats")?.addEventListener("click", async () => {
      await request("/api/v1/agent/chats/restore", { method: "POST" }).catch(() => undefined);
      await loadChats();
      void renderSettings();
    });
    document
      .getElementById("settings-export-all")
      ?.addEventListener("click", () => void exportAllData());
    void loadPolicy();
    void loadAutonomySwitch();
    void loadPendingApprovalList();
  } else if (page === "projects") {
    // 2026-11-05 G1：卡片补内衬（p-4 / sm:p-6），主项目/子项目/待确认三段分开；
    // 带目录选择器（壳内系统对话框、壳外只留手输）。
    el.settingsInner.innerHTML = `${sectionMarkup(
      "主项目",
      `<div class="card">
        <div class="set-card-body" id="workspace-card">
          <div class="set-hint">读取中…</div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "子项目",
      `<div class="card">
        <div class="set-card-body">
          <div class="set-card-head">
            <div class="row-main">
              <div class="set-card-title">已登记的项目</div>
              <div class="set-hint">派活时从这里选；目录丢了、或跑出当前工作区，会标出来。</div>
            </div>
            <button class="btn-primary" type="button" id="project-add">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
              添加子项目
            </button>
          </div>
          <div class="proj-list" id="project-list">
            <div class="set-hint">读取中…</div>
          </div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "待确认的请求",
      `<div class="card">
        <div class="set-card-body" id="proposal-list">
          <div class="set-hint">读取中…</div>
        </div>
      </div>`,
    )}`;
    document.getElementById("project-add")?.addEventListener("click", () => openAddSubprojectModal());
    void loadProjectsSettings();
  } else if (page === "reminders") {
    // E2 #4：只读列表顶部加「加一条」行，直接 POST /agent/reminders（不经过模型）。
    // 骨架建一次；loadReminders 只重填 #reminder-card，输入值不会被重建冲掉。
    el.settingsInner.innerHTML = `${sectionMarkup(
      "提醒",
      `<div class="card" id="reminder-add-card">
        <div class="row">
          <div class="row-main">
            <div class="row-label">加一条</div>
            <div class="row-hint">不经过模型，直接定个时间提醒；到点会出现在对话里。</div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="row">
          <div class="tk-remind-form">
            <input class="set-input" id="reminder-text" type="text" maxlength="200"
                   placeholder="提醒我…" aria-label="提醒内容" />
            <input class="set-input tk-remind-at" id="reminder-at" type="datetime-local" aria-label="提醒时间" />
            <button class="btn-primary" type="button" id="reminder-add">添加</button>
          </div>
        </div>
        <p class="tk-remind-hint" id="reminder-add-hint"></p>
      </div>`,
    )}
    ${sectionMarkup(
      "待触发",
      `<div class="card" id="reminder-card">
        <div class="row"><div class="row-main"><div class="row-hint">读取中…</div></div></div>
      </div>`,
    )}`;
    const addText = document.getElementById("reminder-text");
    const addAt = document.getElementById("reminder-at");
    const addBtn = document.getElementById("reminder-add");
    const addHint = document.getElementById("reminder-add-hint");
    const submitReminder = async () => {
      if (addBtn.disabled) return;
      const text = addText.value.trim();
      const at = addAt.value ? new Date(addAt.value).getTime() : NaN;
      if (!text) { addHint.textContent = "先写点提醒内容。"; addText.focus(); return; }
      if (!Number.isFinite(at)) { addHint.textContent = "选个时间。"; addAt.focus(); return; }
      if (at <= Date.now()) { addHint.textContent = "这个时间已经过去了。"; return; }
      addBtn.disabled = true;
      addHint.textContent = "添加中…";
      try {
        const response = await request("/api/v1/agent/reminders", {
          method: "POST",
          body: JSON.stringify({ text, at }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          addHint.textContent = data.message || `没加上：HTTP ${response.status}`;
          return;
        }
        addText.value = "";
        addAt.value = "";
        addHint.textContent = "";
        toast("提醒已添加");
        void loadReminders();
      } catch (error) {
        if (error.message !== "forbidden") addHint.textContent = `没加上：${error.message}`;
      } finally {
        addBtn.disabled = false;
      }
    };
    addBtn?.addEventListener("click", () => void submitReminder());
    addText?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void submitReminder(); }
    });
    void loadReminders();
  } else if (page === "connect") {
    el.settingsInner.innerHTML = `${sectionMarkup(
      "连接手机",
      `<div class="card">
        <div class="pair">
          <div class="pair-info">
            <div class="row-label">扫码连接手机</div>
            <div class="row-hint">手机 App 扫这个码，换一个长期有效的设备凭据——不用把 AGENT_TOKEN 抄到手机上。</div>
            <div class="pair-url" id="pair-url">正在取配对码…</div>
            <div class="pair-meta" id="pair-meta"></div>
            <button class="ghost" id="pair-refresh" type="button">换一个码</button>
          </div>
          <img class="pair-qr" id="pair-qr" alt="配对二维码" hidden />
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "已连接的设备",
      `<div class="card" id="device-card"></div>`,
    )}`;
    document.getElementById("pair-refresh").addEventListener("click", () => void loadPair());
    void loadPair();
    void loadDevices();
    // 配对码是限时的，停在这一页太久就自己换一张，别让人扫到过期码
    clearInterval(pairTimer);
    pairTimer = setInterval(() => {
      if (currentRoute() === "settings" && currentSettingsPage() === "connect" && el.gate.hidden) {
        void loadPair();
      }
    }, 100000);
  } else if (page === "service") {
    // 模型行不套 rowMarkup：有多个可选项时右栏换成下拉、提示行要动态改文案
    const notifyOn = localStorage.getItem(KEY_NOTIFY) === "1";
    // 供应商双栏每次进页重置到"当前默认供应商"；模板/表单状态由 renderProviderDetail 接手
    state.providerView = { mode: "empty", providerId: "" };
    el.settingsInner.innerHTML = `${sectionMarkup(
      "服务",
      `<div class="card">
        ${rowMarkup("地址", "", `<span class="kv" id="svc-address">…</span>`)}
        <div class="divider"></div>
        <div class="row">
          <div class="row-main">
            <div class="row-label">默认模型</div>
            <div class="row-hint" id="svc-model-hint">读取中…</div>
          </div>
          <div class="row-control" id="svc-model-control"><span class="kv" id="svc-model">…</span></div>
        </div>
        <div class="divider"></div>
        ${rowMarkup(
          "桌面通知",
          "回复完成 / 出错 / 任务单待你处理时提醒；窗口正看着那个会话就不打扰",
          switchMarkup(notifyOn, { label: "桌面通知", attrs: 'data-notify-switch' }),
        )}
        <div class="divider"></div>
        ${rowMarkup("鉴权", "", `<span class="kv" id="svc-auth">…</span>`)}
        <div class="divider"></div>
        ${rowMarkup("累计 token", "", `<span class="kv" id="svc-usage">…</span>`)}
        <div class="divider"></div>
        <details class="td-usage-detail" id="svc-usage-detail">
          <summary>按模型明细</summary>
          <div class="td-usage-body" id="svc-usage-models">
            <div class="row-hint">读取中…</div>
          </div>
        </details>
      </div>`,
    )}
    ${sectionMarkup(
      "运行时",
      `<div class="card" id="runtime-card">
        ${rowMarkup(
          "Node 服务",
          "桌面壳拉起来的那个进程。停掉之后手机连接、提醒、例行任务都会断；历史不会丢，启动即可恢复。",
          `<div class="runtime-actions">
             <span class="kv" id="runtime-state">读取中…</span>
             <button class="btn-primary" type="button" id="runtime-start" hidden>启动</button>
             <button class="ghost" type="button" id="runtime-restart" hidden>重启</button>
             <button class="ghost is-danger" type="button" id="runtime-stop" hidden>停止</button>
           </div>`,
        )}
        <div class="divider" id="autostart-divider" hidden></div>
        <div class="row" id="autostart-row" hidden>
          <div class="row-main">
            <div class="row-label">开机自启</div>
            <div class="row-hint">登录 Windows 时自动启动 Selenite；服务仍由壳拉起，和这里的起停互不影响。</div>
          </div>
          <div class="row-control">
            ${switchMarkup(false, { label: "开机自启", attrs: "data-autostart-switch" })}
          </div>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "搜索",
      `<div class="card" id="search-card">
        ${rowMarkup(
          "搜索（课题研究用）",
          "DeepSeek 搜索，给长期课题的每周研究查资料用。变量名 <code>DEEPSEEK_SEARCH_API_KEY</code>",
          `<span class="kv" id="search-state" data-state="unknown">读取中…</span>`,
        )}
        <div class="divider"></div>
        <div class="field" id="search-key-api">
          <span>DeepSeek 搜索 API Key</span>
          <div class="secret-wrap">
            <input id="search-apikey" type="password" autocomplete="new-password" spellcheck="false"
                   aria-label="DeepSeek 搜索 API Key" placeholder="sk-…" />
            <button class="secret-eye" type="button" id="search-eye" aria-label="显示密钥" title="显示密钥" aria-pressed="false">
              <svg class="eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <svg class="eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden>
                <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>
                <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>
                <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>
                <path d="m2 2 20 20"/>
              </svg>
            </button>
          </div>
          <span class="field-hint">留空 = 不改。值只存在本机服务端，不进 git、不进日志、不下发手机。</span>
        </div>
        <div class="field" id="search-key-env" hidden>
          <span>DEEPSEEK_SEARCH_API_KEY</span>
          <span class="field-hint">这版服务端没开密钥直填：把值写进 .env，变量名就用这个；保存后重启服务生效。</span>
        </div>
        <div class="svc-form-actions">
          <span class="set-hint" id="search-hint"></span>
          <button class="btn-primary" type="button" id="search-save">保存</button>
          <button class="ghost" type="button" id="search-test">测试连接</button>
        </div>
      </div>`,
    )}
    ${sectionMarkup(
      "供应商",
      `<div class="svc-head">
        <div class="row-main">
          <div class="set-hint" id="svc-provider-hint">填 API Key 就能用：Key 只存在本机服务端，不进 git、不进日志、不下发手机。保存后下一轮对话生效。</div>
        </div>
        <button class="btn-primary" type="button" id="provider-add">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          新建供应商
        </button>
      </div>
      <div class="svc-split">
        <div class="svc-nav" id="provider-list" aria-label="供应商列表">
          <div class="svc-nav-empty">读取中…</div>
        </div>
        <div class="svc-detail" id="provider-detail">
          <div class="svc-detail-empty"><div class="set-hint">读取中…</div></div>
        </div>
      </div>`,
    )}`;
    // 通知开关（批次二）：开的时候才请求系统权限；被拒就退回关闭并提示
    const notifySwitch = el.settingsInner.querySelector("[data-notify-switch]");
    notifySwitch?.addEventListener("click", async () => {
      const want = notifySwitch.getAttribute("aria-checked") !== "true";
      if (!want) {
        localStorage.setItem(KEY_NOTIFY, "0");
        notifySwitch.setAttribute("aria-checked", "false");
        return;
      }
      if (!("Notification" in window)) {
        const hint = document.getElementById("svc-model-hint");
        if (hint) hint.textContent = "这个环境不支持通知";
        return;
      }
      if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          const hint = document.getElementById("svc-model-hint");
          if (hint) hint.textContent = "通知权限被拒了，去系统设置里开";
          notifySwitch.setAttribute("aria-checked", "false");
          return;
        }
      }
      localStorage.setItem(KEY_NOTIFY, "1");
      notifySwitch.setAttribute("aria-checked", "true");
    });
    document.getElementById("provider-add")?.addEventListener("click", () => showProviderTemplates());
    void loadServiceInfo();
    void initRuntimeCard();
    // 搜索配置（2026-11-07 批二）：进页 GET 一次当前状态
    void initSearchCard();
  } else if (page === "memory") {
    el.settingsInner.innerHTML = memorySettingsMarkup();
    void wireMemorySettings();
  } else if (page === "partners") {
    el.settingsInner.innerHTML = sectionMarkup(
      "人设",
      `<div class="pt-head">
        <div class="row-main">
          <div class="set-card-title">总管与执事</div>
          <div class="set-hint">头像和「它是谁」一起改：点「改人设」进弹窗，左边换头像、右边写正文，一次保存。模型候选链与例行任务也在里面。</div>
        </div>
        <button class="btn-primary" type="button" id="partner-add">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          新建执事
        </button>
      </div>
      <div class="pt-list" id="partner-list">
        <div class="set-hint">读取中…</div>
      </div>`,
    );
    document.getElementById("partner-add")?.addEventListener("click", () => openCreatePartnerModal());
    void loadPartners();
  } else {
    el.settingsInner.innerHTML = sectionMarkup(
      "关于",
      `<div class="card">
        ${rowMarkup("Selenite", "一个人用的 Agent。记录是重点场景，但不是边界。", `<span class="kv">0.1.0</span>`)}
        <div class="divider"></div>
        ${rowMarkup("界面", "与手机端同一套配色；改完刷新就生效，没有构建步骤。", `<span class="kv">web/</span>`)}
      </div>`,
    );
  }

  replayPageEnter();
}

/* ── 记忆设置（2026-11-06；2026-11-08 扫尾批 6 补整理与导入）──
 * 只读列表 + 四个动作：删掉 / 标过时 / 整理记忆 / 导入记忆。刻意不做编辑与搜索：
 *   - 编辑记忆等于让它变成第二个人格，删了重说一遍更干净；
 *   - 千级以内先给分组滚动，真上千再加（同设置页不做全局搜索的口径）。
 * 数据形状见 memory-api.ts：GET /api/v1/agent/memory。
 * 「整理记忆」只出建议，人在卡片上逐条点「应用」才动库（D18）；导入只增不改。 */

const MEMORY_KIND_LABEL = {
  preference: "偏好",
  fact: "事实",
  episode: "经历",
  entity: "人事物",
};
const MEMORY_KIND_ORDER = ["preference", "fact", "entity", "episode"];

/** 当前查看 / 整理 / 导入的 scope。进页固定回 global，避免下拉与数据不同步。 */
let memoryScope = "global";
/** 本轮整理的结果计数（应用 / 忽略），只用于结果行。 */
let memoryReviewStats = { applied: 0, ignored: 0, total: 0 };

function memorySettingsMarkup() {
  return `${sectionMarkup(
    "记忆",
    `<div class="card">
      ${rowMarkup(
        "当前状态",
        "偏好会在每轮对话开头被想起；其余记忆按相关度召回。",
        `<span class="kv" id="mem-status">读取中…</span>`,
      )}
      <div class="divider"></div>
      ${rowMarkup(
        "抽取方式",
        "auto = 有模型时用模型识别偏好，其余仍走规则；rule = 完全规则版（回滚档）",
        `<span class="kv is-mono" id="mem-extract">—</span>`,
      )}
      <div class="divider"></div>
      ${rowMarkup(
        "范围",
        "总管用 global；每个执事有自己的记忆库，互不可见",
        `<select class="mem-select" id="mem-scope" aria-label="选择记忆范围">
          <option value="global">总管（global）</option>
        </select>`,
      )}
      <div class="divider"></div>
      ${rowMarkup(
        "整理与导入",
        "整理只给建议，逐条确认才会标记过时；导入只增不改，重复的跳过",
        `<div class="mem-tools">
          <button class="ghost mem-act" type="button" id="mem-consolidate" hidden>整理记忆</button>
          <button class="ghost mem-act" type="button" id="mem-import" hidden>导入记忆</button>
          <input type="file" id="mem-import-file" accept=".json,application/json" hidden>
        </div>`,
      )}
      <div class="mem-result" id="mem-import-result" hidden></div>
    </div>
    <div class="card" id="mem-proposals-card" hidden>
      <div class="mem-prop-head">
        <div class="set-card-title">整理建议<span class="mem-count" id="mem-prop-count"></span></div>
        <div class="set-hint">这些都是模型给的<b>建议</b>，不会自动改。应用 = 被收编那条标为过时（记录还留着，可追溯）。</div>
      </div>
      <div class="mem-props" id="mem-props"></div>
      <div class="mem-result" id="mem-prop-result" hidden></div>
    </div>
    <div class="card" id="mem-list-card">
      <div class="set-hint" id="mem-empty" hidden>
        还没有记忆。聊几次之后，偏好会自动出现在这里；也可以直接对助手说「记住：……」。
      </div>
      <div class="mem-list" id="mem-list"><div class="set-hint">读取中…</div></div>
    </div>`,
  )}`;
}

async function wireMemorySettings() {
  const list = document.getElementById("mem-list");
  const status = document.getElementById("mem-status");
  if (!list || !status) return;

  memoryScope = "global";
  memoryReviewStats = { applied: 0, ignored: 0, total: 0 };
  const scopeSelect = document.getElementById("mem-scope");
  if (scopeSelect) {
    await fillMemoryScopes(scopeSelect);
    scopeSelect.value = memoryScope;
    scopeSelect.addEventListener("change", () => {
      memoryScope = scopeSelect.value || "global";
      clearProposalCards();
      const importResult = document.getElementById("mem-import-result");
      if (importResult) importResult.hidden = true;
      void loadMemoryScope();
    });
  }

  const consolidateButton = document.getElementById("mem-consolidate");
  const importButton = document.getElementById("mem-import");
  const fileInput = document.getElementById("mem-import-file");
  consolidateButton?.addEventListener("click", () => void runMemoryConsolidate(consolidateButton));
  importButton?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => void runMemoryImport(fileInput));

  await loadMemoryScope();
}

/** 范围的候选：总管 + 未归档的执事。执事接口不可用（COMPANIONS_ENABLED=false）时只有总管。 */
async function fillMemoryScopes(select) {
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    for (const partner of Array.isArray(data.partners) ? data.partners : []) {
      if (!partner || !partner.id || partner.id === "chief") continue;
      if (partner.status === "archived") continue;
      const option = document.createElement("option");
      option.value = `partner:${partner.id}`;
      option.textContent = `${partner.name || "执事"}（执事）`;
      select.append(option);
    }
  } catch (error) {
    // 读不到执事就只留 global：范围选择不该把整页卡死
    if (error.message === "forbidden") return;
  }
}

async function loadMemoryScope() {
  const list = document.getElementById("mem-list");
  const status = document.getElementById("mem-status");
  const extract = document.getElementById("mem-extract");
  const empty = document.getElementById("mem-empty");
  if (!list || !status) return;

  list.innerHTML = `<div class="set-hint">读取中…</div>`;
  try {
    const response = await request(
      `/api/v1/agent/memory?scope=${encodeURIComponent(memoryScope)}&limit=300`,
      { cache: "no-store" },
    );
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      status.textContent = "未启用";
      if (extract) extract.textContent = "—";
      toggleMemoryTools(false, false);
      list.innerHTML = `<div class="set-hint">记忆未启用（服务端 MEMORY_ENABLED=false）。</div>`;
      return;
    }
    if (!response.ok) throw new Error(String(response.status));

    // 能力位（2026-11-08）：开关关着时按钮不渲染（端点也会 404）
    toggleMemoryTools(data.canConsolidate === true, data.canImport === true);

    const items = Array.isArray(data.items) ? data.items : [];
    status.textContent = items.length > 0 ? `${items.length} 条` : "空";
    if (extract) extract.textContent = data.extract === "llm" ? "模型 + 规则" : "规则";
    if (items.length === 0) {
      list.replaceChildren();
      if (empty) {
        empty.hidden = false;
        empty.textContent =
          memoryScope === "global"
            ? "还没有记忆。聊几次之后，偏好会自动出现在这里；也可以直接对助手说「记住：……」"
            : "这个执事还没有记忆。和它聊几次，或从这页导入。";
      }
      return;
    }
    if (empty) empty.hidden = true;
    renderMemoryList(list, items);
  } catch (error) {
    if (error.message === "forbidden") return;
    status.textContent = "读取失败";
    list.innerHTML = `<div class="set-hint is-error">读不到记忆：${esc(error.message)}</div>`;
  }
}

function toggleMemoryTools(consolidate, importable) {
  const consolidateButton = document.getElementById("mem-consolidate");
  const importButton = document.getElementById("mem-import");
  if (consolidateButton) consolidateButton.hidden = !consolidate;
  if (importButton) importButton.hidden = !importable;
}

function clearProposalCards() {
  const card = document.getElementById("mem-proposals-card");
  const box = document.getElementById("mem-props");
  const line = document.getElementById("mem-prop-result");
  const count = document.getElementById("mem-prop-count");
  memoryReviewStats = { applied: 0, ignored: 0, total: 0 };
  if (card) card.hidden = true;
  if (box) box.replaceChildren();
  if (line) { line.hidden = true; line.textContent = ""; }
  if (count) count.textContent = "";
}

/**
 * 「整理记忆」：一次模型调用只产出建议。
 * 一条建议都不自动执行 —— 人在卡片上逐条点「应用」才走 supersede（D18）。
 */
async function runMemoryConsolidate(button) {
  const card = document.getElementById("mem-proposals-card");
  const box = document.getElementById("mem-props");
  if (!card || !box) return;

  clearProposalCards();
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "整理中…";
  try {
    const response = await request("/api/v1/agent/memory/consolidate/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: memoryScope }),
    });
    if (response.status === 404) {
      toast("整理记忆未启用（服务端 MEMORY_CONSOLIDATE_LLM=false）");
      button.hidden = true;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || String(response.status));

    const proposals = Array.isArray(data.proposals) ? data.proposals : [];
    card.hidden = false;
    memoryReviewStats = { applied: 0, ignored: 0, total: proposals.length };
    const count = document.getElementById("mem-prop-count");
    if (count) count.textContent = proposals.length > 0 ? `${proposals.length} 条` : "";
    if (proposals.length === 0) {
      box.innerHTML = `<div class="set-hint">没有发现可整理的重复记忆。</div>`;
      return;
    }
    box.innerHTML = proposals.map(memoryProposalMarkup).join("");
    wireMemoryProposalActions(box);
  } catch (error) {
    if (error.message === "forbidden") return;
    card.hidden = false;
    box.innerHTML = `<div class="set-hint is-error">整理失败：${esc(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function memoryProposalMarkup(item) {
  const keep = String(item.keep?.content || item.keepId || "");
  const drop = String(item.drop?.content || item.dropId || "");
  const reason = String(item.reason || "");
  return `<div class="mem-prop" data-keep="${esc(item.keepId)}" data-drop="${esc(item.dropId)}">
    <div class="mem-prop-line"><span class="mem-prop-tag is-keep">保留</span><span class="mem-prop-text">${esc(keep)}</span></div>
    <div class="mem-prop-line"><span class="mem-prop-tag is-drop">收编</span><span class="mem-prop-text">${esc(drop)}</span></div>
    ${reason ? `<div class="mem-prop-reason">${esc(reason)}</div>` : ""}
    <div class="mem-prop-actions">
      <button class="ghost mem-act" type="button" data-prop-apply>应用</button>
      <button class="ghost mem-act" type="button" data-prop-ignore>忽略</button>
    </div>
  </div>`;
}

function wireMemoryProposalActions(box) {
  for (const card of box.querySelectorAll(".mem-prop")) {
    const apply = card.querySelector("[data-prop-apply]");
    const ignore = card.querySelector("[data-prop-ignore]");
    apply?.addEventListener("click", async () => {
      const keepId = card.dataset.keep;
      const dropId = card.dataset.drop;
      if (!keepId || !dropId) return;
      if (apply.disabled) return;
      apply.disabled = true;
      if (ignore) ignore.disabled = true;
      try {
        const response = await request("/api/v1/agent/memory/consolidate/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: memoryScope, keepId, dropId }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || String(response.status));
        card.classList.add("is-done");
        const actions = card.querySelector(".mem-prop-actions");
        if (actions) {
          actions.innerHTML = `<span class="mem-prop-status">已应用${
            data.alreadyApplied ? "（之前已应用过）" : ""
          }</span>`;
        }
        memoryReviewStats.applied += 1;
        updateMemoryProposalResult();
        // 被收编的那条已经从召回里下线，列表跟着刷新
        await loadMemoryScope();
      } catch (error) {
        if (error.message === "forbidden") return;
        apply.disabled = false;
        if (ignore) ignore.disabled = false;
        toast(`应用失败：${error.message}`);
      }
    });
    ignore?.addEventListener("click", () => {
      card.remove();
      memoryReviewStats.ignored += 1;
      updateMemoryProposalResult();
    });
  }
}

/** 结果行："已应用 N / 忽略 M"；一条都没处理时不占位。 */
function updateMemoryProposalResult() {
  const line = document.getElementById("mem-prop-result");
  if (!line) return;
  const { applied, ignored, total } = memoryReviewStats;
  if (applied + ignored === 0) {
    line.hidden = true;
    line.textContent = "";
    return;
  }
  line.hidden = false;
  line.textContent = `本次建议 ${total} 条：已应用 ${applied} / 忽略 ${ignored}`;
}

/**
 * 「导入记忆」：前端只解析 + 计数（不做内容预检），确认后整份交给服务端校验。
 * 文件格式（接口文档 §2.15）：裸数组，或 `{items:[…]}`，条目 `{text, kind?, createdAt?, importance?}`。
 */
async function runMemoryImport(input) {
  const file = input?.files?.[0];
  if (input) input.value = ""; // 允许连续选同一个文件
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast("这个文件不是合法 JSON");
    return;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : null;
  if (!items) {
    toast('文件格式不对：需要一个数组，或 {"items": [...]}');
    return;
  }
  if (items.length === 0) {
    toast("这个文件里没有记忆条目");
    return;
  }

  const select = document.getElementById("mem-scope");
  const label = select?.selectedOptions?.[0]?.textContent || memoryScope;
  if (!window.confirm(`把 ${items.length} 条记忆导入「${label}」？只增不改，重复的会跳过。`)) return;

  const button = document.getElementById("mem-import");
  const line = document.getElementById("mem-import-result");
  if (button) button.disabled = true;
  try {
    const response = await request("/api/v1/agent/memory/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: memoryScope, items }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      toast("导入未启用（服务端 MEMORY_IMPORT=false）");
      if (button) button.hidden = true;
      return;
    }
    if (!response.ok) throw new Error(data.message || String(response.status));
    if (line) {
      line.hidden = false;
      line.textContent = `新增 ${data.added} 条 / 跳过 ${data.skipped} 条（共 ${data.total} 条）`;
    }
    await loadMemoryScope();
  } catch (error) {
    if (error.message === "forbidden") return;
    toast(`导入失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderMemoryList(box, items) {
  const groups = new Map();
  for (const item of items) {
    const kind = MEMORY_KIND_LABEL[item.kind] ? item.kind : "fact";
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(item);
  }
  const order = [
    ...MEMORY_KIND_ORDER.filter((kind) => groups.has(kind)),
    ...[...groups.keys()].filter((kind) => !MEMORY_KIND_ORDER.includes(kind)),
  ];
  box.innerHTML = order
    .map((kind) => {
      const rows = groups.get(kind);
      return `<div class="mem-group">
        <div class="mem-group-title">${esc(MEMORY_KIND_LABEL[kind] || kind)}<span class="mem-count">${rows.length}</span></div>
        ${rows.map((item) => memoryItemMarkup(item)).join("")}
      </div>`;
    })
    .join("");
  wireMemoryActions(box);
}

function memoryItemMarkup(item) {
  const lines = String(item.content || "").split("\n");
  const head = lines[0] || "";
  // Why / How 是给人和模型看的两段（cindy feedback 类的硬要求）：展开时整段显示
  const extra = lines.slice(1).filter(Boolean);
  const when = String(item.createdAt || "").slice(0, 10);
  const recalled = Number(item.recallCount) > 0 ? ` · 想起 ${Number(item.recallCount)} 次` : "";
  return `<div class="mem-item" data-memory-id="${esc(item.id)}">
    <div class="mem-item-main">
      <div class="mem-item-text">${esc(head)}</div>
      ${extra.length ? `<div class="mem-item-why">${extra.map((line) => esc(line)).join("<br>")}</div>` : ""}
      <div class="mem-item-meta">${esc(when)}${esc(recalled)}</div>
    </div>
    <div class="mem-item-actions">
      <button class="ghost mem-act" type="button" data-mem-supersede="${esc(item.id)}"
              title="这条已经不对了？把它标成过时，以后不再想起">标过时</button>
      <button class="ghost mem-act" type="button" data-mem-forget="${esc(item.id)}">删除</button>
    </div>
  </div>`;
}

function wireMemoryActions(box) {
  for (const button of box.querySelectorAll("[data-mem-supersede]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.memSupersede;
      if (!id) return;
      if (!window.confirm("把这条标成过时？之后不会再被想起，但记录还留着。")) return;
      button.disabled = true;
      try {
        // 只下线、不指定替代者：语义冲突的自动判断留给"人"，这里只表达"这条不算数了"
        const response = await request(`/api/v1/agent/memory/${encodeURIComponent(id)}/supersede`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(String(response.status));
        toast("已标为过时");
        await renderSettings();
      } catch (error) {
        if (error.message !== "forbidden") {
          button.disabled = false;
          toast(`操作失败：${error.message}`);
        }
      }
    });
  }
  for (const button of box.querySelectorAll("[data-mem-forget]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.memForget;
      if (!id) return;
      if (!window.confirm("删掉这条记忆？删了就找不回来了。")) return;
      button.disabled = true;
      try {
        const response = await request(`/api/v1/agent/memory/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(String(response.status));
        toast("已删除");
        await renderSettings();
      } catch (error) {
        if (error.message !== "forbidden") {
          button.disabled = false;
          toast(`删除失败：${error.message}`);
        }
      }
    });
  }
}

/* 头像预设图库（2026-11-06 落地，2026-11-07 改挂到「人设」弹窗里）：
 * 30 张 PNG（10 男 / 20 女）由 web.ts 的 /assets/preset/:file 白名单路由供图。
 * 原来这里还有一整页「设置 → 头像」（选对象 + 网格 + 上传 + 保存），
 * 2026-11-07 合并进人设弹窗后整页删除——头像不是独立设置项，是这个角色的一部分。 */
const AVATAR_PRESET_FILES = {
  male: Array.from({ length: 10 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`),
  female: Array.from({ length: 20 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`),
};
const AVATAR_PRESET_URL = (file) => `/assets/preset/${file}.png`;

/* ── 项目分区（2026-11-04 批次六）───────────────────────
   服务端 2026-11-03 就有登记/提案/确认流，这里只是把它接上：
   工作区 = 一个根目录；项目 = 根目录下的已登记子目录；确认提案才建目录。
   路由以代码为准：确认 / 拒绝是 POST /api/v1/projects/:id/confirm|reject。 */

const PROJECT_ERROR_TEXT = {
  bad_request: "名称和相对路径都要填。",
  bad_path: "路径不合法：工作区要写绝对路径；项目路径要写工作区内的相对路径。",
  outside_workspace: "必须在最大工作区内，先去设置主项目。",
  no_workspace: "还没有主工作区，先去设置主项目。",
  inside_existing_project: "这个路径已经属于某个已登记项目了。",
  duplicate_project: "同名项目已存在。",
  already_decided: "这条请求已经处理过了。",
  not_found: "找不到这条待确认请求，刷新后再试。",
};

function projectErrorText(data, status) {
  // bad_path 的服务端文案更具体（盘符根 / 主目录 / 不可写），别用笼统那句盖掉
  if (data?.error === "bad_path" && typeof data.message === "string" && data.message.trim()) {
    return data.message;
  }
  return PROJECT_ERROR_TEXT[data?.error] || data?.message || `没成功：HTTP ${status}`;
}

/** 项目列表不返回 relativePath（服务端零改动），这里用工作区根目录算出来 */
function relativeProjectPath(rootPath, projectRoot) {
  if (!rootPath || !projectRoot) return projectRoot || "";
  const normalize = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalize(rootPath);
  const original = normalize(projectRoot);
  const caseFold = /^[a-z]:\//i.test(base);
  const left = caseFold ? base.toLowerCase() : base;
  const right = caseFold ? original.toLowerCase() : original;
  if (right === left) return ".";
  if (right.startsWith(`${left}/`)) return original.slice(left.length + 1);
  return original;
}

/** 设置页最近一次读到的工作区；「添加子项目」弹层要用它算相对路径 */
let settingsWorkspace = null;
const REPLACE_WORKSPACE_WARNING = "更换根目录会清空当前项目选择（回到主工作区）。";

async function loadProjectsSettings() {
  try {
    const [workspaceResponse, projectsResponse, proposalsResponse] = await Promise.all([
      request("/api/v1/workspaces", { cache: "no-store" }),
      // 归档折叠区要把 archived 的一并读回来（扫尾批 1 A4）；默认列表已滤掉它们。
      request("/api/v1/projects?includeArchived=1", { cache: "no-store" }),
      request("/api/v1/projects/proposals?status=pending", { cache: "no-store" }),
    ]);
    const workspaceData = await workspaceResponse.json();
    const projectsData = await projectsResponse.json();
    const proposalsData = await proposalsResponse.json();
    const workspace = workspaceData.workspace || projectsData.workspace || null;
    settingsWorkspace = workspace;
    renderWorkspaceCard(workspace);
    renderProjectList(workspace, projectsData.projects || []);
    renderProposalList(proposalsData.proposals || []);
  } catch (error) {
    if (error.message === "forbidden") return;
    for (const id of ["workspace-card", "project-list", "proposal-list"]) {
      const box = document.getElementById(id);
      if (box) {
        box.innerHTML = `<div class="set-hint is-error">读不到：${esc(error.message)}</div>`;
      }
    }
  }
}

function renderWorkspaceCard(workspace) {
  const card = document.getElementById("workspace-card");
  if (!card) return;
  const hasWorkspace = Boolean(workspace);
  card.innerHTML = `
    <div class="set-card-head">
      <div class="row-main">
        <div class="set-card-title">工作区根目录</div>
        <div class="set-hint">${
          hasWorkspace
            ? "助手只能在这个目录里动文件；子项目也必须落在它下面。"
            : "还没有设定。新项目只能建在它下面；先选一个代码目录或空目录。"
        }</div>
      </div>
    </div>
    <div class="set-path-row">
      <input class="set-input is-mono" id="workspace-path" type="text" spellcheck="false"
             aria-label="工作区根目录" placeholder="例如：D:/Projects"
             value="${hasWorkspace ? attr(workspace.rootPath) : ""}" />
      ${
        inShell()
          ? '<button class="ghost" type="button" id="workspace-pick">选择目录</button>'
          : ""
      }
      <button class="btn-primary" type="button" id="workspace-save">${hasWorkspace ? "保存" : "设定"}</button>
    </div>
    <div class="set-hint" id="workspace-hint">${
      hasWorkspace
        ? "更换根目录会清空当前项目选择（回到主工作区）。拒绝盘符根、用户主目录与系统目录。"
        : "拒绝盘符根、用户主目录与系统目录。"
    }</div>`;

  const input = document.getElementById("workspace-path");
  const hint = (text) => {
    const node = document.getElementById("workspace-hint");
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("is-error", Boolean(text) && text !== REPLACE_WORKSPACE_WARNING);
  };
  const restoreHint = () =>
    hint(hasWorkspace ? REPLACE_WORKSPACE_WARNING : "拒绝盘符根、用户主目录与系统目录。");

  document.getElementById("workspace-pick")?.addEventListener("click", async () => {
    const chosen = await selectDirectory();
    if (!chosen) return; // 取消选择：保留原值
    input.value = chosen;
    restoreHint();
  });
  input?.addEventListener("input", restoreHint);
  document.getElementById("workspace-save")?.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) {
      hint("填一个绝对路径，或者点「选择目录」。");
      input.focus();
      return;
    }
    try {
      const response = await request("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ rootPath: value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        hint(projectErrorText(data, response.status));
        return;
      }
      toast(hasWorkspace ? "根目录已更新" : "工作区已设定");
      await loadProjectsSettings();
    } catch (error) {
      if (error.message !== "forbidden") hint(`没存成：${error.message}`);
    }
  });
}

/** 一张项目卡（扫尾批 1 A4）：行内改名 / 归档或恢复 / 删除。 */
function projectCardMarkup(workspace, project) {
  const relativePath = relativeProjectPath(workspace?.rootPath, project.rootPath);
  // 状态点优先级：目录丢失（黄）> 工作区外（灰）> 在（绿）
  const dot = project.exists === false ? "warn" : project.insideWorkspace === false ? "idle" : "ok";
  const archived = Boolean(project.archived);
  const badges = [
    `<span class="pill-tag">${project.vcs === "git" ? "git" : "无版本控制"}</span>`,
    project.exists === false
      ? '<span class="pill-tag warn">目录丢失</span>'
      : '<span class="pill-tag ok">在</span>',
    archived ? '<span class="pill-tag">已归档</span>' : "",
    project.insideWorkspace === false ? '<span class="pill-tag">工作区外</span>' : "",
  ]
    .filter(Boolean)
    .join("");
  const id = attr(project.id);
  return `<div class="proj-card" data-project-id="${id}">
    <i class="status-dot ${dot}" aria-hidden="true"></i>
    <div class="proj-card-main">
      <div class="proj-card-title">${esc(project.name)}</div>
      <div class="proj-card-path">${esc(relativePath)}</div>
      <div class="proj-card-tags">${badges}</div>
    </div>
    <div class="proj-card-actions">
      <button class="ghost" type="button" data-project-action="rename" data-project-id="${id}" data-project-name="${attr(project.name)}">改名</button>
      <button class="ghost" type="button" data-project-action="${archived ? "unarchive" : "archive"}" data-project-id="${id}">${archived ? "恢复" : "归档"}</button>
      <button class="ghost" type="button" data-project-action="delete" data-project-id="${id}" data-project-name="${attr(project.name)}">删除</button>
    </div>
  </div>`;
}

function renderProjectList(workspace, projects) {
  const box = document.getElementById("project-list");
  if (!box) return;
  const active = projects.filter((project) => !project.archived);
  const archived = projects.filter((project) => project.archived);
  const empty = `<div class="set-empty">
      <div class="set-card-title">还没有登记项目</div>
      <div class="set-hint">确认一条新建请求后，项目会出现在这里；派活时也从这里选。</div>
    </div>`;
  // 归档折叠区：用原生 details 收合，默认收起；空的就不摆这一节。
  const archivedSection = archived.length
    ? `<details class="proj-archived">
        <summary>已归档（${archived.length}）</summary>
        <div class="proj-archived-list">${archived.map((project) => projectCardMarkup(workspace, project)).join("")}</div>
      </details>`
    : "";
  box.innerHTML = `${active.length ? active.map((project) => projectCardMarkup(workspace, project)).join("") : empty}${archivedSection}`;

  // 每次 innerHTML 重建后旧按钮连同监听器一起没了，这里重新挂即可（同 proposal 列表写法）。
  for (const button of box.querySelectorAll("[data-project-action]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.projectId || "";
      const name = button.dataset.projectName || "";
      switch (button.dataset.projectAction) {
        case "rename":
          openRenameProjectModal(id, name);
          break;
        case "archive":
        case "unarchive":
          void doProjectAction(id, button.dataset.projectAction);
          break;
        case "delete":
          confirmDeleteProject(id, name);
          break;
      }
    });
  }
}

/** 归档 / 恢复：纯增量端点，操作后重载项目设置页。 */
async function doProjectAction(id, action) {
  try {
    const response = await request(`/api/v1/projects/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(projectErrorText(data, response.status));
      return;
    }
    toast(action === "archive" ? "已归档" : "已恢复");
    await loadProjectsSettings();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没成功：${error.message}`);
  }
}

/** 改名弹窗（与既有「新建项目待确认」同风格）：只改登记名，不动磁盘。 */
function openRenameProjectModal(id, name) {
  openModal("项目改名", (body) => {
    body.innerHTML = `
      <p class="modal-desc">只改登记里的名字，不改动磁盘目录。</p>
      <input class="modal-input" id="proj-rename-input" type="text" maxlength="60" value="${attr(name)}" spellcheck="false" />
      <p class="modal-hint" id="proj-rename-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="btn-primary" type="button" id="proj-rename-save">保存</button>
      </div>`;
    const input = body.querySelector("#proj-rename-input");
    const hint = body.querySelector("#proj-rename-hint");
    const save = body.querySelector("#proj-rename-save");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    input?.addEventListener("input", () => clearModalHint(hint));
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save?.click();
      }
    });
    save?.addEventListener("click", async () => {
      if (save.disabled) return;
      const next = String(input.value || "").trim();
      if (!next) {
        setModalHint(hint, "项目名不能为空");
        return;
      }
      save.disabled = true;
      try {
        const response = await request(`/api/v1/projects/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name: next }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          save.disabled = false;
          return;
        }
        closeModal();
        toast("已改名");
        await loadProjectsSettings();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没改成功：${error.message}`);
        save.disabled = false;
      }
    });
  });
}

/** 删除确认：文案明说「只删登记，不删磁盘目录」；有在飞单时服务端 400 会回说明。 */
function confirmDeleteProject(id, name) {
  openModal("删除项目登记", (body) => {
    body.innerHTML = `
      <p class="modal-desc">删除「${esc(name)}」的登记。<b>只删登记，不删磁盘目录</b>——文件都还在。此操作不能撤销，历史任务单保留但项目字段会变成悬空引用。</p>
      <p class="modal-hint" id="proj-del-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="proj-del-confirm">删除登记</button>
      </div>`;
    const hint = body.querySelector("#proj-del-hint");
    const confirm = body.querySelector("#proj-del-confirm");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    confirm?.addEventListener("click", async () => {
      if (confirm.disabled) return;
      confirm.disabled = true;
      try {
        const response = await request(`/api/v1/projects/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, projectErrorText(data, response.status));
          confirm.disabled = false;
          return;
        }
        closeModal();
        toast("已删除项目登记（磁盘目录保留）");
        await loadProjectsSettings();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `没删成：${error.message}`);
        confirm.disabled = false;
      }
    });
  });
}

function renderProposalList(proposals) {
  const box = document.getElementById("proposal-list");
  if (!box) return;
  if (!proposals.length) {
    box.innerHTML = `<div class="set-empty">
      <div class="set-card-title">没有待确认的请求</div>
      <div class="set-hint">助理提出新建项目后会出现在这里；确认才建目录、登记。</div>
    </div>`;
    return;
  }
  box.innerHTML = proposals
    .map(
      (proposal) => `<div class="proposal-card">
        <div class="proposal-card-main">
          <div class="proj-card-title">${esc(proposal.name)}</div>
          <div class="proj-card-path">${esc(proposal.relativePath)} · 确认后才建目录、登记</div>
        </div>
        <div class="proposal-actions">
          <button class="ghost" type="button" data-proposal-confirm="${esc(proposal.id)}">确认</button>
          <button class="ghost" type="button" data-proposal-reject="${esc(proposal.id)}">拒绝</button>
        </div>
      </div>`,
    )
    .join("");

  for (const button of box.querySelectorAll("[data-proposal-confirm]")) {
    button.addEventListener("click", () => void decideProjectProposal(button.dataset.proposalConfirm, "confirm"));
  }
  for (const button of box.querySelectorAll("[data-proposal-reject]")) {
    button.addEventListener("click", () => void decideProjectProposal(button.dataset.proposalReject, "reject"));
  }
}

async function decideProjectProposal(id, action) {
  const box = document.getElementById("proposal-list");
  for (const button of box ? box.querySelectorAll("button") : []) button.disabled = true;
  try {
    const response = await request(`/api/v1/projects/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(projectErrorText(data, response.status));
      await loadProjectsSettings();
      return;
    }
    toast(action === "confirm" ? "已确认并登记" : "已拒绝");
    await loadProjectsSettings();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没处理成：${error.message}`);
    await loadProjectsSettings();
  }
}

/**
 * 设置页「权限」卡里的全局待办（2026-11-04 批次六）。
 * 不带 conversationId = 跨会话；标题只认改名表，取不到显示「未命名会话」。
 */
async function loadPendingApprovalList() {
  const box = document.getElementById("pending-approval-list");
  const count = document.getElementById("pending-approval-count");
  if (!box) return;
  const empty = (text) => {
    box.innerHTML = `<div class="row"><div class="row-main"><div class="row-hint">${esc(text)}</div></div></div>`;
    if (count) count.textContent = "0";
  };

  try {
    const response = await request("/api/v1/agent/approvals", { cache: "no-store" });
    if (response.status === 503) {
      empty("还没有配置模型，暂时没有审批。");
      if (count) count.textContent = "—";
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    const approvals = data.approvals || [];
    if (count) count.textContent = String(approvals.length);
    if (!approvals.length) {
      empty("没有待处理的审批。");
      return;
    }

    box.innerHTML = approvals
      .map((item, index) => {
        // 2026-11-08 扫尾批 8c：blocking 形态才有倒计时；async 形态只写「等待处理」
        const deadline = Date.parse(item.deadlineAt || "");
        const left = Number.isFinite(deadline)
          ? Math.max(0, Math.round((deadline - Date.now()) / 1000))
          : null;
        const remain =
          state.capabilities.approvalMode === "blocking"
            ? left === null
              ? ""
              : left > 0
                ? `剩余 ${left} 秒，超时按拒绝处理`
                : "已超时"
            : "等待处理";
        // 来源（2026-11-08 批三）：能反查到群/执事就写清楚，否则退回 chatTitle
        const source = approvalSourceLabel(item.conversationId) || item.chatTitle || "未命名会话";
        return `${index ? '<div class="divider"></div>' : ""}
        <div class="row">
          <div class="row-main">
            <div class="row-label">${esc(source)} · ${esc(item.tool || "工具")}${item.origin === "autonomous" ? '<span class="pill-tag">例行任务</span>' : ""}</div>
            <div class="row-hint">${esc((item.args || "").slice(0, 160))}</div>
            ${remain ? `<div class="row-hint">${remain}</div>` : ""}
          </div>
          <div class="row-control">
            <button class="ghost" type="button" data-approval-approve="${esc(item.callId)}">批准</button>
            <button class="ghost" type="button" data-approval-reject="${esc(item.callId)}">拒绝</button>
          </div>
        </div>`;
      })
      .join("");

    for (const button of box.querySelectorAll("[data-approval-approve]")) {
      button.addEventListener("click", () => void decideGlobalApproval(button.dataset.approvalApprove, "approve"));
    }
    for (const button of box.querySelectorAll("[data-approval-reject]")) {
      button.addEventListener("click", () => void decideGlobalApproval(button.dataset.approvalReject, "reject"));
    }
  } catch (error) {
    if (error.message !== "forbidden") empty(`读不到待办：${error.message}`);
  }
}

async function decideGlobalApproval(callId, decision) {
  try {
    const response = await request(`/api/v1/agent/approvals/${encodeURIComponent(callId)}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.message || data.error || `答复失败：HTTP ${response.status}`);
      return;
    }
    toast(
      {
        approved: "已批准",
        rejected: "已拒绝",
        timeout: "已超时（按拒绝处理）",
        aborted: "本轮已停止",
      }[data.status] || "已处理",
    );
    // 聊天卡片上若挂着同一条，同步置灰，避免两处按钮各按一次
    const entry = approvalCards.get(callId);
    if (entry) {
      clearInterval(entry.timer);
      entry.root.classList.add("resolved");
      for (const button of entry.root.querySelectorAll("button")) button.disabled = true;
      approvalCards.delete(callId);
    }
    await loadPendingApprovalList();
  } catch (error) {
    if (error.message !== "forbidden") toast(`答复失败：${error.message}`);
  }
}

function ago(at) {
  if (!at) return "还没用过";
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚用过";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前用过`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前用过`;
  return `${Math.floor(diff / 86_400_000)} 天前用过`;
}

async function loadDevices() {
  const card = document.getElementById("device-card");
  if (!card) return;
  try {
    const response = await request("/api/v1/pair/devices", { cache: "no-store" });
    const data = await response.json();
    const devices = (data.devices || []).filter((device) => !device.revoked);
    if (!devices.length) {
      card.innerHTML = `<div class="row"><div class="row-main">
        <div class="row-label">已连接的设备</div>
        <div class="row-hint">还没有。手机扫码之后会出现在这里。</div>
      </div></div>`;
      return;
    }
    card.innerHTML = devices
      .map(
        (device, index) => `${index ? '<div class="divider"></div>' : ""}
        <div class="row">
          <div class="row-main">
            <div class="row-label">${esc(device.name || "手机")}</div>
            <div class="row-hint">${ago(device.lastSeenAt)}</div>
          </div>
          <div class="row-control">
            <button class="ghost" type="button" data-revoke="${esc(device.id)}">移除</button>
          </div>
        </div>`,
      )
      .join("");
    for (const button of card.querySelectorAll("[data-revoke]")) {
      button.addEventListener("click", async () => {
        button.disabled = true;
        await request(
          `/api/v1/pair/devices/${encodeURIComponent(button.dataset.revoke)}/revoke`,
          { method: "POST" },
        ).catch(() => undefined);
        void loadDevices();
      });
    }
  } catch {
    card.innerHTML = `<div class="row"><div class="row-main">
      <div class="row-hint">读不到设备列表</div></div></div>`;
  }
}

async function loadPair() {
  const image = document.getElementById("pair-qr");
  const urlEl = document.getElementById("pair-url");
  const metaEl = document.getElementById("pair-meta");
  if (!image || !urlEl) return;
  try {
    const response = await request("/api/v1/pair/qr", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    image.src = data.dataUrl;
    image.hidden = false;
    urlEl.textContent = data.url;
    metaEl.textContent = `${data.machineName} · ${Math.round(data.expiresInSeconds / 60)} 分钟内有效`;
  } catch (error) {
    if (error.message === "forbidden") return;
    urlEl.textContent = "拿不到配对信息";
    metaEl.textContent = String(error.message || error);
  }
}

/** 工具活动可以整体隐掉（只看回答的那种用法） */
function applyActPref() {
  document.documentElement.dataset.acts =
    localStorage.getItem(KEY_ACTS) === "0" ? "0" : "1";
}

function whenText(at) {
  if (!at) return "";
  const date = new Date(at);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadReminders() {
  const card = document.getElementById("reminder-card");
  if (!card) return;
  try {
    const response = await request("/api/v1/agent/reminders", { cache: "no-store" });
    const data = await response.json();
    const list = (data.reminders || data || []).slice(0, 8);
    if (!list.length) {
      card.innerHTML = `<div class="row"><div class="row-main">
        <div class="row-label">待触发的提醒</div>
        <div class="row-hint">还没有。让 Agent 说「明天九点提醒我…」就会出现在这里。</div>
      </div></div>`;
      return;
    }
    card.innerHTML = list
      .map(
        (item, index) => `${index ? '<div class="divider"></div>' : ""}
        <div class="row">
          <div class="row-main">
            <div class="row-label">${esc(item.text || "提醒")}</div>
            <div class="row-hint">${whenText(item.at || item.until)} · ${esc(item.status || "")}</div>
          </div>
        </div>`,
      )
      .join("");
  } catch {
    card.innerHTML = `<div class="row"><div class="row-main">
      <div class="row-hint">读不到提醒</div></div></div>`;
  }
}

async function loadPolicy() {
  const box = document.getElementById("policy-switch");
  if (!box) return;
  // 先量一次胶囊（此时还没有选中项，量不到就等拿到 policy 再量）
  mountSegmented(box);
  let data = null;
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    data = await response.json();
    for (const button of box.querySelectorAll("[data-policy]")) {
      button.setAttribute("aria-checked", String(button.dataset.policy === data.access));
    }
  } catch {
    /* 离线就保持原样 */
  }
  // 高亮胶囊跟到服务端返回的那一档（没有选中项时自己隐藏）
  syncSegmented(box);
  for (const button of box.querySelectorAll("[data-policy]")) {
    button.addEventListener("click", async () => {
      for (const other of box.querySelectorAll("[data-policy]")) {
        other.setAttribute("aria-checked", String(other === button));
      }
      // 只改属性、不重建 DOM：重建会把滑行高亮层一起丢掉
      syncSegmented(box);
      await request("/api/v1/agent/policy", {
        method: "POST",
        body: JSON.stringify({ access: button.dataset.policy }),
      }).catch(() => undefined);
    });
  }

  // 写操作逐次确认（批次二）：独立轴，和三档可以同时生效
  const confirm = document.getElementById("policy-confirm-writes");
  if (confirm) {
    if (data) confirm.setAttribute("aria-checked", String(data.confirmWrites === true));
    confirm.addEventListener("click", async () => {
      const next = confirm.getAttribute("aria-checked") !== "true";
      confirm.setAttribute("aria-checked", String(next));
      await request("/api/v1/agent/policy", {
        method: "POST",
        body: JSON.stringify({ confirmWrites: next }),
      }).catch(() => undefined);
    });
  }
}

/** 自主轮总开关（E2 #6）：只读显示开/关。/healthz 只露这一个布尔，不露任何会话/内容信息。 */
async function loadAutonomySwitch() {
  const node = document.getElementById("policy-autonomy");
  if (!node) return;
  try {
    const response = await request("/healthz", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const info = await response.json();
    node.textContent = info.autonomy ? "开（环境变量）" : "关（环境变量）";
    node.title = info.autonomy
      ? "AUTONOMY_ENABLED 已开启（观察与审批生效）"
      : "AUTONOMY_ENABLED 未开启（默认关）";
  } catch {
    node.textContent = "读不到";
  }
}

/**
 * 默认模型行（2026-11-04 批次五，接口文档 §2.8）：数据源 GET /agent/model，
 * 选项按供应商分组；只有一个可选项时退化成只读行。
 * 这里不再读 /healthz.models —— 那个字段已收窄成"默认供应商的清单"，没有分组信息。
 * 2026-11-05 G1 热修：models 自思考档位起是对象行 {id, thinkingLevels}（兼容裸字符串），
 * 统一走 normalizeModelRow（与模型菜单同一份归一化），不再把行当字符串拼。
 */
function renderDefaultModelRow(catalog) {
  const control = document.getElementById("svc-model-control");
  const hint = document.getElementById("svc-model-hint");
  if (!control || !hint) return;
  const current = catalog && catalog.current ? catalog.current : null;
  const providers = (catalog && catalog.providers ? catalog.providers : [])
    .map((provider) => ({
      ...provider,
      models: (Array.isArray(provider.models) ? provider.models : [])
        .map(normalizeModelRow)
        .filter(Boolean),
    }))
    .filter((provider) => provider.models.length > 0);
  const options = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      providerName: provider.name || provider.id,
      modelId: model.id,
    })),
  );
  const setHint = (text) => {
    hint.textContent = text;
  };

  if (!current) {
    control.innerHTML = `<span class="kv" id="svc-model">未配置（mock 回显）</span>`;
    setHint("配好 LLM_API_KEY 就会播种一个默认供应商，之后可在这里切");
    return;
  }
  if (current.providerId === "faux") {
    control.innerHTML = `<span class="kv" id="svc-model">faux</span>`;
    setHint("faux 是假模型（链路验证用），没有可切的真实模型");
    return;
  }
  if (options.length < 2) {
    control.innerHTML = `<span class="kv" id="svc-model">${esc(current.modelId)}</span>`;
    setHint("在下面的供应商里多填几个模型，就能在这里切");
    return;
  }

  // 可切：下拉 + 切换反馈。同一上游端点下换模型名，密钥与地址不动（硬约束）。
  control.innerHTML = `<select class="model-select" id="svc-model-select" aria-label="选择模型">
      ${providers
        .map(
          (provider) => `<optgroup label="${esc(provider.name || provider.id)}">
            ${provider.models
              .map(
                (model) =>
                  `<option value="${esc(provider.id)}|${esc(model.id)}"${
                    current.providerId === provider.id && current.modelId === model.id ? " selected" : ""
                  }>${esc(model.id)}</option>`,
              )
              .join("")}
          </optgroup>`,
        )
        .join("")}
    </select>`;
  setHint("切换后下一轮对话生效");
  const select = document.getElementById("svc-model-select");
  let msgTimer = 0;
  const say = (text) => {
    setHint(text);
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => setHint("切换后下一轮对话生效"), 6000);
  };
  select.addEventListener("change", async () => {
    const [providerId, modelId] = String(select.value).split("|");
    const previous = `${current.providerId}|${current.modelId}`;
    select.disabled = true;
    try {
      const response = await request("/api/v1/agent/model", {
        method: "POST",
        body: JSON.stringify({ providerId, modelId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        say(`没切成：${data.message || data.error || `HTTP ${response.status}`}`);
        select.value = previous;
        return;
      }
      state.modelCatalog = {
        ...(state.modelCatalog || {}),
        current: { providerId: data.provider || providerId, modelId: data.model || modelId },
      };
      updateModelPill();
      say("已切换，下一轮用新模型；首轮会慢一点（上游缓存重建）。");
    } catch (error) {
      if (error.message !== "forbidden") say(`没切成：${error.message}`);
      select.value = previous;
    } finally {
      select.disabled = false;
    }
  });
}

/* ── 运行时起停（2026-11-07）────────────────────────────────
 * 这一块**不能走 HTTP**：它要停的东西就是 HTTP 服务本身。停下去之后页面所有请求都会
 * 失败，连"现在是什么状态"都问不出来。所以状态只从壳读，跟 /healthz 无关——
 * 拿 healthz 判会把"我自己停的"误报成"服务挂了"。
 *
 * 浏览器里（非桌面壳）没有 window.mygo，退回只读提示，不出按钮。
 */
const RUNTIME_LABELS = {
  running: "运行中",
  starting: "启动中…",
  stopped: "已停止",
  failed: "未运行（异常退出）",
  unknown: "未知",
};

/** 壳方法调用：MyGo 的 call 挂在 window.mygo 上，错误以 reject 形式回来。
 *  额外参数按 MyGo 绑定签名顺序透传（例：shellCall("SetOpenAtLogin", true)）。 */
async function shellCall(method, ...args) {
  const call = window.mygo?.call;
  if (typeof call !== "function") throw new Error("only-desktop");
  const value = await call.call(window.mygo, `Shell.${method}`, ...args);
  // 有的桥接层会把结果包成 {result} / 字符串 JSON，这里统一拆一层。
  if (typeof value === "string" && value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value?.result ?? value;
}

function paintRuntime(status) {
  const box = document.getElementById("runtime-card");
  if (!box) return;
  const label = box.querySelector("#runtime-state");
  const start = box.querySelector("#runtime-start");
  const restart = box.querySelector("#runtime-restart");
  const stop = box.querySelector("#runtime-stop");
  const state = status?.state || "unknown";

  label.textContent = `${RUNTIME_LABELS[state] || state}${status?.pid ? ` · PID ${status.pid}` : ""}`;
  label.dataset.state = state;
  // 三种按钮互斥出现：跑着才有"重启/停止"，没跑才有"启动"
  const running = state === "running";
  if (start) start.hidden = running || state === "starting";
  if (restart) restart.hidden = !running;
  if (stop) stop.hidden = !running;
}

/** 停服之后整页失去后端：盖一块本地面板，别让人对着一屏报错点。 */
function showRuntimeCurtain(visible, text) {
  let layer = document.getElementById("runtime-curtain");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "runtime-curtain";
    layer.innerHTML = `<div class="runtime-curtain-card">
      <h3>服务已停止</h3>
      <p id="runtime-curtain-text">手机连接、提醒、例行任务都已断开。历史没有丢。</p>
      <button class="btn-primary" type="button" id="runtime-curtain-start">启动服务</button>
    </div>`;
    document.body.append(layer);
    layer.querySelector("#runtime-curtain-start").addEventListener("click", () => void startRuntimeFromUi());
  }
  if (typeof text === "string") layer.querySelector("#runtime-curtain-text").textContent = text;
  layer.hidden = !visible;
  // 让 checkHealth 别再刷"服务离线"——那是我们自己停的，不是失联。
  document.body.dataset.runtime = visible ? "stopped" : "running";
}

async function startRuntimeFromUi() {
  showRuntimeCurtain(true, "启动中…（首次启动要加载技能与记忆，通常 10–25 秒）");
  try {
    paintRuntime(await shellCall("StartRuntime"));
    // 起来了就整页重来：SSE、健康轮询、会话列表一起重建，比逐块热修可靠。
    location.reload();
  } catch (error) {
    showRuntimeCurtain(true, `启动失败：${error.message}`);
  }
}

async function initRuntimeCard() {
  const box = document.getElementById("runtime-card");
  if (!box) return;
  if (!inShell()) {
    const label = box.querySelector("#runtime-state");
    if (label) label.textContent = "仅桌面端可操作";
    for (const id of ["runtime-start", "runtime-restart", "runtime-stop"]) {
      const node = box.querySelector(`#${id}`);
      if (node) node.hidden = true;
    }
    return;
  }

  const refresh = async () => {
    try {
      paintRuntime(await shellCall("RuntimeStatus"));
    } catch {
      paintRuntime(null);
    }
  };
  await refresh();

  box.querySelector("#runtime-stop")?.addEventListener("click", async () => {
    if (!confirm("停掉 Node 服务？手机连接、提醒、正在跑的任务都会断开。历史不会丢。")) return;
    try {
      paintRuntime(await shellCall("StopRuntime"));
      showRuntimeCurtain(true);
    } catch (error) {
      alert(`停止失败：${error.message}`);
      await refresh();
    }
  });
  box.querySelector("#runtime-start")?.addEventListener("click", () => void startRuntimeFromUi());
  box.querySelector("#runtime-restart")?.addEventListener("click", async () => {
    if (!confirm("重启 Node 服务？正在生成的回答会中断，历史不会丢。")) return;
    try {
      await shellCall("RestartRuntime");
      location.reload();
    } catch (error) {
      showRuntimeCurtain(true, `重启失败：${error.message}`);
    }
  });

  // 上次是用户停的：进来就显面板，别先闪一下"服务离线"
  const status = await shellCall("RuntimeStatus").catch(() => null);
  if (status?.state === "stopped") showRuntimeCurtain(true);

  await initAutostartRow();
}

/* 开机自启（2026-11-08 扫尾批 4b）。
 * 读不到状态就不渲染：浏览器里没有 Shell，`LIFEDIARY_SHELL_BINDINGS=off` 时整组
 * 绑定也没挂——两种情况都落在 OpenAtLogin 调用失败上，与"整组同退"口径一致。 */
async function initAutostartRow() {
  const row = document.getElementById("autostart-row");
  const divider = document.getElementById("autostart-divider");
  const sw = row?.querySelector("[data-autostart-switch]");
  if (!row || !divider || !sw) return;

  let enabled;
  try {
    enabled = Boolean(await shellCall("OpenAtLogin"));
  } catch {
    return; // 没有绑定：保持隐藏
  }
  row.hidden = false;
  divider.hidden = false;
  sw.setAttribute("aria-checked", enabled ? "true" : "false");

  sw.addEventListener("click", async () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.disabled = true;
    try {
      const now = Boolean(await shellCall("SetOpenAtLogin", next));
      sw.setAttribute("aria-checked", now ? "true" : "false");
      toast(now ? "已开启开机自启" : "已关闭开机自启");
    } catch (error) {
      alert(`没改成功：${error.message}`);
    } finally {
      sw.disabled = false;
    }
  });
}

async function loadServiceInfo() {
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  set("svc-address", location.origin);
  set("svc-auth", state.token ? "已配置令牌" : "未配置（仅本机）");

  try {
    const catalog = await fetchModelCatalog();
    state.modelCatalog = catalog;
    renderDefaultModelRow(catalog);
    updateModelPill();
  } catch {
    set("svc-model", "读取失败");
    const hint = document.getElementById("svc-model-hint");
    if (hint) hint.textContent = "";
  }

  const renderUsageModels = (models) => {
    const box = document.getElementById("svc-usage-models");
    if (!box) return;
    if (!models.length) {
      box.innerHTML = `<div class="row-hint">还没有按模型的用量。</div>`;
      return;
    }
    box.innerHTML = `<table class="td-usage-table">
      <thead><tr><th>模型</th><th>input</th><th>output</th><th>cacheRead</th><th>total</th></tr></thead>
      <tbody>${models
        .map(
          (item) => `<tr>
            <td>${esc(String(item.model ?? ""))}</td>
            <td>${(item.inputTokens || 0).toLocaleString()}</td>
            <td>${(item.outputTokens || 0).toLocaleString()}</td>
            <td>${(item.cacheReadTokens || 0).toLocaleString()}</td>
            <td>${(item.totalTokens || 0).toLocaleString()}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>`;
  };

  try {
    const response = await request("/api/v1/agent/usage", { cache: "no-store" });
    const data = await response.json();
    const models = data.models || [];
    const total = models.reduce((sum, item) => sum + (item.totalTokens || 0), 0);
    set("svc-usage", total ? `${total.toLocaleString()} tokens` : "还没有用量");
    // E2 #5：总数下面可点开的按模型小表，取同一份 models[]（模型/input/output/cacheRead/total）。
    renderUsageModels(models);
  } catch {
    set("svc-usage", "读取失败");
    const box = document.getElementById("svc-usage-models");
    if (box) box.innerHTML = `<div class="row-hint">读不到用量明细</div>`;
  }

  await loadProviders();
}

/* ── 供应商管理（2026-11-04 批次五；2026-11-05 G1 双栏重排，H1 密钥直填）────────
 * 密钥以界面直填为主：表单只收 API Key，keyEnv 由前端按 LIFEDIARY_KEY_<ID大写> 生成；
 * 直填接口不在的环境退回「只填变量名、值写 .env」的老形态，两种都只出现变量名，不存明文。 */

/* 预置模板（G1）：只给 baseUrl / 常见模型 id，不含任何密钥值。
   keyEnv 不再写进模板：H1 起由前端按 LIFEDIARY_KEY_<ID大写> 自动生成，界面不出现。 */
/* 模型元数据默认值（与服务端 provider.ts 保持一致；只用于显示"没填时的生效值"） */
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 4096;

/** 128K / 1M 这类短写；不精确到个位，免得表单里一长串数字 */
function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number >= 1000000) return `${Number((number / 1000000).toFixed(2))}M`;
  if (number >= 1000) return `${Math.round(number / 1000)}K`;
  return String(number);
}

const PROVIDER_TEMPLATES = [
  {
    id: "bailian",
    name: "百炼",
    desc: "阿里云 DashScope 兼容模式",
    mark: "百",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: "qwen3-max\nqwen-plus",
  },
  {
    id: "magpie",
    name: "magpie 本地网关",
    desc: "本机 127.0.0.1:3425",
    mark: "M",
    baseUrl: "http://127.0.0.1:3425/v1",
    models: "glm-5.3-flash",
  },
  {
    id: "custom",
    name: "自定义供应商",
    desc: "自己填 baseUrl 与模型清单",
    mark: "+",
    baseUrl: "",
    models: "",
  },
];

const PROVIDER_ERROR_TEXT = {
  providers_disabled: "供应商配置被环境变量关掉了（PROVIDERS_CONFIG=false）。",
  provider_id_locked: "供应商 id 不能改；要换 id 请新建一个。",
  selected_model_missing: "这家供应商上还选着模型：先把「默认模型」切到别处，再改模型清单。",
  provider_is_default: "这是默认供应商，不能删；先把默认模型切到别家。",
  provider_in_use: "当前正用着这家供应商，先切到别家再删。",
  bad_key_env: "环境变量名只能是大写字母、数字、下划线，且不以数字开头（如 DASHSCOPE_API_KEY）。",
  bad_base_url: "Base URL 要写完整地址（http:// 或 https://），不带 /chat/completions。",
  bad_provider_name: "名称需要 1–80 个字符。",
  bad_models: "模型清单不能为空：点「添加模型」填一个模型 id 再保存。",
  bad_model_meta: "模型的上下文 / 最大输出只能是正整数。",
  bad_thinking_levels: "思考档格式不对，刷新页面再试。",
  bad_provider_id: "id 只能是小写字母、数字、连字符。",
  secret_field_forbidden: "界面不收密钥值：只填环境变量名，值放 .env。",
  models_fetch_failed: "拉不到清单：检查 Key 和地址，或手填。",
  missing_key: "这个环境变量还没有值：界面填 Key 后保存，或把值写进 .env。",
  unknown_provider: "找不到这家供应商，刷新后再试。",
};

const PROVIDER_SECRET_ERROR_TEXT = {
  secrets_disabled: "密钥直填功能已关闭（PROVIDER_SECRETS=false）。",
  providers_disabled: "供应商配置被环境变量关掉了（PROVIDERS_CONFIG=false）。",
  bad_request: "Key 不能为空，且最长 512 个字符。",
};

function providerErrorText(data, status) {
  return PROVIDER_ERROR_TEXT[data?.error] || data?.message || `没成功：HTTP ${status}`;
}

/** 密钥接口的错：404 一律说「先保存基本信息」（契约里 404 = unknown_provider） */
function providerSecretErrorText(data, status) {
  if (data?.error === "secrets_disabled") return PROVIDER_SECRET_ERROR_TEXT.secrets_disabled;
  if (status === 404 || data?.error === "unknown_provider") return "先保存基本信息，再存密钥。";
  return (
    PROVIDER_SECRET_ERROR_TEXT[data?.error] ||
    data?.message ||
    (status ? `密钥没存上：HTTP ${status}` : "密钥没存上：网络错误")
  );
}

function providerById(id) {
  return (state.providers || []).find((provider) => provider.id === id) || null;
}

async function loadProviders() {
  const nav = document.getElementById("provider-list");
  const detail = document.getElementById("provider-detail");
  if (!nav || !detail) return;
  // 右栏已经有表单时只压一点不透明度，等数据回来原位填值——不整块重建，页面不闪
  if (detail.querySelector(".svc-form")) detail.classList.add("is-loading");
  try {
    const response = await request("/api/v1/agent/providers", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.providers = data.providers || [];
    ensureProviderView();
    renderProviderNav();
    renderProviderDetail({ animate: false });
  } catch {
    nav.innerHTML = `<div class="svc-nav-empty">读不到</div>`;
    detail.dataset.view = "empty";
    detail.innerHTML = `<div class="svc-detail-empty"><div class="set-hint is-error">读不到供应商列表</div></div>`;
  } finally {
    detail.classList.remove("is-loading");
  }
}

/** 默认落点：当前默认供应商 > 第一家；模板/新建态保持不动 */
function ensureProviderView() {
  const list = state.providers || [];
  const view = state.providerView || { mode: "empty" };
  if (view.mode === "templates" || view.mode === "new") return;
  if (view.mode === "form" && list.some((provider) => provider.id === view.providerId)) return;
  if (!list.length) {
    state.providerView = { mode: "empty", providerId: "", templateId: "" };
    return;
  }
  const preferred = list.find((provider) => provider.isDefault) || list[0];
  state.providerView = { mode: "form", providerId: preferred.id, templateId: "" };
}

function renderProviderNav() {
  const nav = document.getElementById("provider-list");
  if (!nav) return;
  const list = state.providers || [];
  const view = state.providerView || {};
  const rows = list
    .map((provider) => {
      const selected = view.mode === "form" && view.providerId === provider.id;
      const initial = (provider.name || provider.id || "?").trim().slice(0, 1);
      return `<button class="svc-row" type="button" data-provider="${esc(provider.id)}"
        aria-selected="${selected}" title="${attr(
          (provider.name || provider.id) + (provider.hasKey ? "" : " · 缺环境变量"),
        )}">
        <span class="svc-row-initial" aria-hidden="true">${esc(initial)}</span>
        <span class="svc-row-label">${esc(provider.name || provider.id)}</span>
        <i class="status-dot ${provider.hasKey ? "ok" : "warn"}" aria-hidden="true"></i>
      </button>`;
    })
    .join("");
  nav.innerHTML = `<div class="svc-nav-title">供应商</div>${
    rows || `<div class="svc-nav-empty">还没有供应商</div>`
  }`;
  for (const button of nav.querySelectorAll("[data-provider]")) {
    button.addEventListener("click", () => openProviderForm(button.dataset.provider));
  }
}

/** 右栏：模板选择 / 新建表单 / 编辑表单 / 空态。
 *  2026-11-05 H1：表单区常驻 DOM，切供应商只更新字段值（value/checked/文本），
 *  不再整块 innerHTML（那会让右栏闪一下重新弹）；首次进表单仍走 200ms 下拉展开。 */
function renderProviderDetail({ animate = true } = {}) {
  const host = document.getElementById("provider-detail");
  if (!host) return;
  const view = state.providerView || { mode: "empty" };

  if (view.mode === "templates") {
    host.dataset.view = "templates";
    host.innerHTML = providerTemplatesMarkup();
    wireProviderTemplates(host);
    return;
  }

  const template =
    view.mode === "new" ? PROVIDER_TEMPLATES.find((item) => item.id === view.templateId) || null : null;
  const provider = view.mode === "form" ? providerById(view.providerId) : null;

  if (view.mode === "empty" || (view.mode === "form" && !provider)) {
    // 没有供应商，或列表刷新后这家不见了（别处删掉）：空态，别留一张指向空气的表单
    renderProviderEmpty(host);
    return;
  }

  const existingForm = host.querySelector(".svc-form");
  if (existingForm && host.dataset.view === "form") {
    // 同一种结构：只填值。换了一家才重放 160ms 的 .55→1 微淡入（不位移、不弹跳）
    const sameTarget =
      host.dataset.formFor === (provider ? `form:${provider.id}` : `new:${template ? template.id : "custom"}`);
    if (!sameTarget) {
      existingForm.classList.remove("is-swapping");
      void existingForm.offsetWidth;
      existingForm.classList.add("is-swapping");
      clearTimeout(host.swapTimer);
      host.swapTimer = setTimeout(() => existingForm.classList.remove("is-swapping"), 200);
    }
    fillProviderForm(host, provider, template);
    return;
  }

  host.dataset.view = "form";
  if (!animate) {
    host.innerHTML = `<div class="svc-expand is-open"><div>${providerFormMarkup()}</div></div>`;
    wireProviderForm(host);
    fillProviderForm(host, provider, template);
    return;
  }
  // 先落结构，再填数据：网络慢的时候看到的是空表单骨架，不是白块或旧供应商闪回
  host.innerHTML = `<div class="svc-expand"><div>${providerFormMarkup()}</div></div>`;
  wireProviderForm(host);
  fillProviderForm(host, provider, template);
  const wrap = host.firstElementChild;
  // 双 rAF：先让 0fr 落一帧，再加 is-open，200ms 过渡才会真的跑
  requestAnimationFrame(() => requestAnimationFrame(() => wrap?.classList.add("is-open")));
}

function renderProviderEmpty(host) {
  host.dataset.view = "empty";
  host.innerHTML = `<div class="svc-detail-empty">
    <div class="set-card-title">还没有供应商</div>
    <div class="set-hint">配好 LLM_API_KEY 首次启动会按 env 播种一个；也可以点右上「新建供应商」。</div>
    <button class="btn-primary" type="button" id="provider-empty-add">新建供应商</button>
  </div>`;
  host.querySelector("#provider-empty-add")?.addEventListener("click", () => showProviderTemplates());
}

/** 当前表单指向谁：编辑既有供应商，或基于模板新建 */
function currentProviderFormTarget() {
  const view = state.providerView || {};
  if (view.mode === "form") return { provider: providerById(view.providerId), template: null };
  if (view.mode === "new") {
    return {
      provider: null,
      template: PROVIDER_TEMPLATES.find((item) => item.id === view.templateId) || null,
    };
  }
  return { provider: null, template: null };
}

function showProviderTemplates() {
  const previous = (state.providerView && state.providerView.providerId) || "";
  state.providerView = { mode: "templates", providerId: previous, templateId: "" };
  renderProviderNav();
  renderProviderDetail();
}

function providerTemplatesMarkup() {
  return `<div class="svc-expand is-open"><div>
    <div class="svc-tpl-head">
      <button class="svc-back" type="button" id="provider-tpl-back" aria-label="返回" title="返回">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m12 19-7-7 7-7"/>
          <path d="M19 12H5"/>
        </svg>
      </button>
      <h2 class="svc-tpl-title">选择供应商模板</h2>
    </div>
    <div class="svc-tpl-grid">
      ${PROVIDER_TEMPLATES.map(
        (template) => `<button class="svc-tpl" type="button" data-template="${esc(template.id)}">
          <span class="svc-tpl-icon" aria-hidden="true">${esc(template.mark)}</span>
          <span class="svc-tpl-main">
            <span class="svc-tpl-name">${esc(template.name)}</span>
            <span class="svc-tpl-desc">${esc(template.desc)}</span>
          </span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6"/>
          </svg>
        </button>`,
      ).join("")}
    </div>
  </div></div>`;
}

function wireProviderTemplates(host) {
  host.querySelector("#provider-tpl-back")?.addEventListener("click", () => {
    const previous = state.providerView.providerId;
    if (previous && providerById(previous)) {
      state.providerView = { mode: "form", providerId: previous, templateId: "" };
    } else {
      state.providerView = { mode: "empty", providerId: "", templateId: "" };
      ensureProviderView();
    }
    renderProviderNav();
    renderProviderDetail();
  });
  for (const button of host.querySelectorAll("[data-template]")) {
    button.addEventListener("click", () => {
      state.providerView = { mode: "new", providerId: "", templateId: button.dataset.template };
      renderProviderNav();
      renderProviderDetail();
    });
  }
}

/* ── 供应商 id / keyEnv 的前端生成（2026-11-05 H1）────────
 * keyEnv 要写成 LIFEDIARY_KEY_<ID大写>，而直填密钥必须先知道 id；
 * 所以新建时就按服务端 slugify / uniqueId 的同一规则先把 id 定下来，
 * POST 时显式带上（服务端已有同名 id 就按更新处理，这里先去重）。
 * 连字符转下划线是因为环境变量名只允许 [A-Z0-9_]。 */
const PROVIDER_RESERVED_IDS = new Set(["faux", "mock"]);

function providerSlug(name) {
  const base = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (base) return base;
  // 中文名 slug 为空时给一个稳定兜底（不能用时间戳：同一次保存里要算两次 id）
  let hash = 0;
  for (const char of String(name || "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `provider-${hash.toString(36)}`;
}

function nextProviderId(name) {
  let base = providerSlug(name);
  if (PROVIDER_RESERVED_IDS.has(base)) base = `${base}-provider`;
  const taken = new Set((state.providers || []).map((provider) => provider.id));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function providerKeyEnv(id) {
  return `LIFEDIARY_KEY_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** 表单骨架：结构只建一次，之后切供应商只填值（不重建 = 不闪） */
function providerFormMarkup() {
  return `<div class="svc-form">
    <div class="svc-form-head">
      <button class="svc-back" type="button" id="pv-back" aria-label="返回模板选择" title="返回模板选择" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m12 19-7-7 7-7"/>
          <path d="M19 12H5"/>
        </svg>
      </button>
      <div class="row-main">
        <div class="set-card-title"><span id="pv-title">供应商</span><span class="pill-tag" id="pv-default" hidden>默认</span></div>
        <div class="svc-form-id" id="pv-id" hidden></div>
        <div class="set-hint" id="pv-new-hint" hidden></div>
      </div>
    </div>
    <label class="field"><span>名称</span>
      <input id="pv-name" type="text" maxlength="80" placeholder="例如：百炼" />
    </label>
    <label class="field"><span>Base URL</span>
      <input id="pv-base" type="text" spellcheck="false" placeholder="https://api.example.com/v1" />
    </label>
    <div class="field" id="pv-key-api">
      <span>API Key</span>
      <div class="secret-wrap">
        <input id="pv-apikey" type="password" autocomplete="new-password" spellcheck="false"
               aria-label="API Key" placeholder="sk-…" />
        <button class="secret-eye" type="button" id="pv-eye" aria-label="显示密钥" title="显示密钥" aria-pressed="false">
          <svg class="eye-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <svg class="eye-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden>
            <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>
            <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>
            <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>
            <path d="m2 2 20 20"/>
          </svg>
        </button>
      </div>
      <span class="field-hint">Key 只存在你这台电脑的服务端，不进 git、不进日志、不下发手机。</span>
    </div>
    <label class="field" id="pv-key-env" hidden><span>密钥环境变量名</span>
      <input id="pv-keyenv" class="is-mono" type="text" spellcheck="false" placeholder="DASHSCOPE_API_KEY" />
      <span class="field-hint">这版服务端还没开放密钥直填：变量名填这里，值写进 .env。</span>
    </label>
    <div class="field">
      <span>模型</span>
      <div class="svc-models">
        <div class="svc-models-head">
          <span class="set-hint">每个模型单独配置上下文与思考档；保存供应商时一起写入。</span>
          <button class="ghost svc-model-add" type="button" id="pv-add-model">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            添加模型
          </button>
        </div>
        <div class="svc-model-list" id="pv-model-list"></div>
      </div>
    </div>
    <div class="svc-form-actions">
      <span class="set-hint" id="pv-hint"></span>
      <button class="btn-primary" type="button" id="pv-save">保存</button>
      <button class="ghost" type="button" id="pv-cancel">取消</button>
    </div>
    <div class="svc-danger-zone" id="pv-danger" hidden>
      <span class="set-hint" id="pv-danger-hint"></span>
      <button class="ghost is-danger" type="button" id="pv-delete">删除</button>
    </div>
  </div>`;
}

/** 原位填值：只改 value / checked / 文本，不动 DOM 结构（滑行/展开动画都还在） */
function fillProviderForm(host, provider, template) {
  const isTemplate = Boolean(template && template.id !== "custom");
  const isEdit = Boolean(provider);
  const name = provider ? provider.name : isTemplate ? template.name : "";
  const baseUrl = provider ? provider.baseUrl : isTemplate ? template.baseUrl : "";
  const id = provider ? provider.id : nextProviderId(name || "provider");
  const q = (selector) => host.querySelector(selector);
  const setValue = (selector, value) => {
    const node = q(selector);
    if (node && node.value !== value) node.value = value;
  };

  const back = q("#pv-back");
  if (back) back.hidden = isEdit;
  const title = q("#pv-title");
  if (title) title.textContent = isEdit ? "编辑供应商" : "新建供应商";
  const badge = q("#pv-default");
  if (badge) badge.hidden = !(isEdit && provider.isDefault);
  const idNode = q("#pv-id");
  if (idNode) {
    idNode.hidden = !isEdit;
    idNode.textContent = isEdit ? `id: ${id}（不能改）` : "";
  }
  const newHint = q("#pv-new-hint");
  if (newHint) {
    newHint.hidden = isEdit;
    newHint.textContent = isTemplate
      ? `基于「${template.name}」模板，保存前都能改`
      : "填好后保存；Key 只进本机服务端";
  }

  setValue("#pv-name", name);
  setValue("#pv-base", baseUrl);
  setValue("#pv-keyenv", provider ? provider.keyEnv || providerKeyEnv(id) : providerKeyEnv(id));
  // 换了一家 / 换模板才重建模型草稿；同一家刷新只重绘，不丢正在编辑的列表
  const nextFormFor = isEdit ? `form:${id}` : `new:${isTemplate ? template.id : "custom"}`;
  if (host.dataset.formFor !== nextFormFor) hydrateProviderModels(provider, template);
  host.dataset.formFor = nextFormFor;
  renderProviderModelList(host);

  // 明文永不跨供应商保留：每次填表都把 Key 输入框清空，只留占位提示
  const api = q("#pv-apikey");
  if (api) {
    api.value = "";
    api.type = "password";
    api.placeholder = isEdit && provider.hasKey ? "已设置（留空保持不变）" : "sk-…";
  }
  const eye = q("#pv-eye");
  if (eye) {
    eye.setAttribute("aria-pressed", "false");
    eye.setAttribute("aria-label", "显示密钥");
    eye.title = "显示密钥";
    const showIcon = eye.querySelector(".eye-show");
    const hideIcon = eye.querySelector(".eye-hide");
    if (showIcon) showIcon.hidden = false;
    if (hideIcon) hideIcon.hidden = true;
  }

  // 表单换人时重建模型草稿；同一个人只做原位填值，不动正在编辑的列表
  host.dataset.formFor = isEdit ? `form:${id}` : `new:${isTemplate ? template.id : "custom"}`;

  const danger = q("#pv-danger");
  if (danger) danger.hidden = !isEdit;
  if (isEdit) {
    const dangerHint = q("#pv-danger-hint");
    if (dangerHint) {
      dangerHint.textContent = provider.isDefault
        ? "默认供应商不能删；先把默认模型切到别家。"
        : "删除后，已有会话下一轮会回退到默认供应商。";
    }
    const del = q("#pv-delete");
    if (del) del.disabled = Boolean(provider.isDefault);
  }

  applyProviderSecretMode(host);
  setProviderHint(host, "", false);
}

/** 从服务端投影 / 模板重建模型草稿（上下文与档位缺省 = 服务端缺省） */
function hydrateProviderModels(provider, template) {
  const ids = provider
    ? [...(provider.models || [])]
    : template && template.models
      ? parseModelText(template.models)
      : [];
  state.providerModels = ids.map((id) => {
    const meta = (provider && provider.modelMeta && provider.modelMeta[id]) || {};
    const levels =
      provider && provider.modelThinkingLevels ? provider.modelThinkingLevels[id] : null;
    return {
      id,
      contextWindow: Number.isFinite(meta.contextWindow) ? meta.contextWindow : null,
      maxTokens: Number.isFinite(meta.maxTokens) ? meta.maxTokens : null,
      thinkingLevels: Array.isArray(levels) && levels.length ? [...levels] : null,
    };
  });
}

/** 没声明过档位 = 服务端缺省域（off/low/high，刻意不含 medium） */
function effectiveThinkingLevels(model) {
  return model && Array.isArray(model.thinkingLevels) && model.thinkingLevels.length
    ? model.thinkingLevels
    : ["off", "low", "high"];
}

function renderProviderModelList(host) {
  const box = host && host.querySelector("#pv-model-list");
  if (!box) return;
  const list = state.providerModels || [];
  box.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "svc-model-empty";
    empty.textContent = "还没有模型。点右上「添加模型」，填 ID 后可自动检测。";
    box.append(empty);
    return;
  }
  const icon = (path) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  list.forEach((model, index) => {
    const row = document.createElement("div");
    row.className = "svc-model-row";

    const main = document.createElement("div");
    main.className = "svc-model-main";
    const idLine = document.createElement("div");
    idLine.className = "svc-model-id";
    idLine.textContent = model.id;
    const metaLine = document.createElement("div");
    metaLine.className = "svc-model-meta";
    metaLine.textContent = [
      `上下文 ${formatTokenCount(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW)}`,
      `输出 ${formatTokenCount(model.maxTokens ?? DEFAULT_MAX_TOKENS)}`,
      `思考 ${effectiveThinkingLevels(model)
        .map((level) => THINKING_LABELS[level] || level)
        .join("/")}`,
    ].join(" · ");
    main.append(idLine, metaLine);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "svc-model-act";
    edit.title = `编辑 ${model.id}`;
    edit.setAttribute("aria-label", `编辑 ${model.id}`);
    edit.innerHTML = icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
    edit.addEventListener("click", () => openProviderModelDialog(host, index));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "svc-model-act is-danger";
    remove.title = `移除 ${model.id}`;
    remove.setAttribute("aria-label", `移除 ${model.id}`);
    remove.innerHTML = icon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
    remove.addEventListener("click", () => {
      state.providerModels.splice(index, 1);
      renderProviderModelList(host);
      setProviderHint(host, "模型列表已修改，点「保存」写回", false);
    });

    row.append(main, edit, remove);
    box.append(row);
  });
}

/** 空 / 非正整数 → null；有值但不是正整数 → NaN（保存时拦下） */
function parseTokenField(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : Number.NaN;
}

/**
 * 添加 / 编辑模型的弹窗（2026-11-05）：
 * 只填 ID → 点「检测」真打一次上游，回填上下文 / 最大输出 / 思考档 → 用户确认后进草稿。
 * 未保存的新供应商不能检测（端点按 provider id 找 key），提示先保存。
 */
function openProviderModelDialog(host, index) {
  const editing = Number.isInteger(index) && index >= 0;
  const model = editing
    ? { ...state.providerModels[index] }
    : { id: "", contextWindow: null, maxTokens: null, thinkingLevels: null };
  const { provider } = currentProviderFormTarget();
  const levelsFor = effectiveThinkingLevels(model);

  openModal(editing ? "编辑模型" : "添加模型", (body) => {
    body.innerHTML = `
      <div class="modal-field">
        <span>模型 ID</span>
        <div class="modal-row">
          <input class="modal-input is-mono" id="pm-id" type="text" spellcheck="false"
                 placeholder="例如 deepseek-v4.1-flash" value="${attr(model.id)}" />
          <button class="ghost" type="button" id="pm-detect"${provider ? "" : " disabled"}>检测</button>
        </div>
        <p class="modal-hint" id="pm-detect-hint">${
          provider
            ? "填模型 ID 后点「检测」：会真打一次上游，顺便拉上下文与思考档"
            : "先保存供应商基础信息，再回来检测；现在可以先手填"
        }</p>
      </div>
      <div class="modal-field">
        <span>上下文窗口（tokens）</span>
        <input class="modal-input" id="pm-ctx" type="text" inputmode="numeric" spellcheck="false"
               placeholder="${DEFAULT_CONTEXT_WINDOW}" value="${model.contextWindow ?? ""}" />
      </div>
      <div class="modal-field">
        <span>最大输出（tokens）</span>
        <input class="modal-input" id="pm-max" type="text" inputmode="numeric" spellcheck="false"
               placeholder="${DEFAULT_MAX_TOKENS}" value="${model.maxTokens ?? ""}" />
      </div>
      <div class="modal-field">
        <span>思考强度</span>
        <div class="pm-levels">
          ${THINKING_LEVELS.map(
            (level) => `<label class="pm-level-opt">
              <input class="pm-level" type="checkbox" value="${level}"${levelsFor.includes(level) ? " checked" : ""} />
              <span>${THINKING_LABELS[level]}</span>
            </label>`,
          ).join("")}
        </div>
      </div>
      <p class="modal-hint" id="pm-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" type="button" id="pm-save">保存</button>
      </div>`;

    const hint = body.querySelector("#pm-hint");
    const detectHint = body.querySelector("#pm-detect-hint");
    const idInput = body.querySelector("#pm-id");
    const ctxInput = body.querySelector("#pm-ctx");
    const maxInput = body.querySelector("#pm-max");
    const levelBoxes = [...body.querySelectorAll(".pm-level")];
    const detect = body.querySelector("#pm-detect");
    const save = body.querySelector("#pm-save");

    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    detect?.addEventListener("click", async () => {
      const modelId = idInput.value.trim();
      if (!modelId) {
        setModalHint(hint, "先填模型 ID");
        idInput.focus();
        return;
      }
      if (!provider) return;
      detect.disabled = true;
      save.disabled = true;
      setModalHint(hint, "检测中：会真打一次上游…", false);
      try {
        const response = await request(
          `/api/v1/agent/providers/${encodeURIComponent(provider.id)}/models/detect`,
          { method: "POST", body: JSON.stringify({ modelId }) },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, providerErrorText(data, response.status));
          return;
        }
        const detection = data.detection || {};
        if (Number.isFinite(detection.contextWindow)) ctxInput.value = String(detection.contextWindow);
        if (Number.isFinite(detection.maxTokens)) maxInput.value = String(detection.maxTokens);
        if (Array.isArray(detection.thinkingLevels)) {
          for (const box of levelBoxes) box.checked = detection.thinkingLevels.includes(box.value);
        }
        if (!detection.reachable) {
          setModalHint(hint, detection.message || "没连上");
          return;
        }
        const latency = Number.isFinite(detection.latencyMs) ? `（${detection.latencyMs}ms）` : "";
        const contextText = Number.isFinite(detection.contextWindow)
          ? `上下文 ${formatTokenCount(detection.contextWindow)}`
          : "上游没给上下文，请手填";
        const unknown = Object.entries(detection.levels || {})
          .filter(([, verdict]) => verdict === "unknown")
          .map(([level]) => THINKING_LABELS[level] || level);
        setModalHint(
          hint,
          `已连通${latency}；${contextText}${unknown.length ? `；${unknown.join("/")} 档未确认` : ""}`,
          false,
        );
        if (detectHint) {
          detectHint.textContent = detection.message || "检测完成，确认下面的值后保存";
        }
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal();
          return;
        }
        setModalHint(hint, `检测失败：${error.message}`);
      } finally {
        detect.disabled = false;
        save.disabled = false;
      }
    });

    save?.addEventListener("click", () => {
      const modelId = idInput.value.trim();
      if (!modelId) {
        setModalHint(hint, "模型 ID 不能为空");
        idInput.focus();
        return;
      }
      if ((state.providerModels || []).some((item, itemIndex) => item.id === modelId && itemIndex !== index)) {
        setModalHint(hint, "这个模型已经在列表里");
        return;
      }
      const contextWindow = parseTokenField(ctxInput.value);
      const maxTokens = parseTokenField(maxInput.value);
      if (Number.isNaN(contextWindow) || Number.isNaN(maxTokens)) {
        setModalHint(hint, "上下文 / 最大输出只能是正整数（留空 = 用默认值）");
        return;
      }
      const thinkingLevels = levelBoxes.filter((box) => box.checked).map((box) => box.value);
      if (!thinkingLevels.length) {
        setModalHint(hint, "至少选一个思考档（不想思考就只留「关」）");
        return;
      }
      const next = { id: modelId, contextWindow, maxTokens, thinkingLevels };
      if (editing) state.providerModels[index] = next;
      else state.providerModels.push(next);
      renderProviderModelList(host);
      setProviderHint(host, "模型列表已修改，点「保存」写回", false);
      closeModal();
    });
  });
}

function setProviderHint(host, text, isError = true) {
  const node = host && host.querySelector("#pv-hint");
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-error", Boolean(isError) && Boolean(text));
}

/** api=直填（PUT /secret）；env=后端没这个接口时的退回形态（只填变量名） */
function applyProviderSecretMode(host) {
  const envMode = state.providerSecretMode === "env";
  const apiField = host.querySelector("#pv-key-api");
  const envField = host.querySelector("#pv-key-env");
  if (apiField) apiField.hidden = envMode;
  if (envField) envField.hidden = !envMode;
  // 页头那句也跟着换，别在退回 env 后还写着“填 API Key 就能用”
  const head = document.getElementById("svc-provider-hint");
  if (head) {
    head.textContent = envMode
      ? "这版服务端只收「密钥环境变量名」；值写 .env，界面不收也不存明文。保存后下一轮对话生效。"
      : "填 API Key 就能用：Key 只存在本机服务端，不进 git、不进日志、不下发手机。保存后下一轮对话生效。";
  }
}

/* ── 设置 → 服务 → 搜索（2026-11-07 批二）──────────────────
   key 落点照供应商直填：PUT 写 .data/provider-keys.json 并热注入 env；响应只回变量名。
   老服务端 / PROVIDER_SECRETS=false 时退回「只展示变量名 + 手写 .env」的形态
   （同 saveProviderFlow 的 404 / secrets_disabled 先例）。 */
const SEARCH_ERROR_TEXT = {
  search_not_configured: "还没配置搜索 Key：先在上面保存，或写进 .env。",
  upstream_error: "搜索服务报错（上游 / 网络），稍后再试。",
  bad_response: "搜索服务返回格式异常，稍后再试。",
};

function setSearchHint(host, text, isError = false) {
  const node = host && host.querySelector("#search-hint");
  if (!node) return;
  node.textContent = text || "";
  node.classList.toggle("is-error", Boolean(isError) && Boolean(text));
}

function paintSearchState(host, hasKey) {
  const node = host && host.querySelector("#search-state");
  if (!node) return;
  node.textContent = hasKey ? "已配置" : "未配置";
  node.dataset.state = hasKey ? "on" : "off";
}

function applySearchEnvMode(host) {
  if (!host) return;
  host.dataset.searchMode = "env";
  const apiField = host.querySelector("#search-key-api");
  const envField = host.querySelector("#search-key-env");
  if (apiField) apiField.hidden = true;
  if (envField) envField.hidden = false;
  const actions = host.querySelector(".svc-form-actions");
  if (actions) actions.hidden = true;
  const stateNode = host.querySelector("#search-state");
  if (stateNode) {
    stateNode.textContent = "写 .env";
    stateNode.dataset.state = "unknown";
  }
}

/** 眼睛：只换 type，不落值（与供应商密钥框同款） */
function wireSearchEye(host) {
  const eye = host.querySelector("#search-eye");
  const input = host.querySelector("#search-apikey");
  if (!eye || !input) return;
  eye.addEventListener("mousedown", (event) => event.preventDefault());
  eye.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.setAttribute("aria-pressed", String(show));
    eye.setAttribute("aria-label", show ? "隐藏密钥" : "显示密钥");
    eye.title = show ? "隐藏" : "显示";
    const showIcon = eye.querySelector(".eye-show");
    const hideIcon = eye.querySelector(".eye-hide");
    if (showIcon) showIcon.hidden = show;
    if (hideIcon) hideIcon.hidden = !show;
  });
}

async function initSearchCard() {
  const host = document.getElementById("search-card");
  if (!host || host.dataset.wired === "1") return;
  host.dataset.wired = "1";
  wireSearchEye(host);

  const input = host.querySelector("#search-apikey");
  const save = host.querySelector("#search-save");
  const test = host.querySelector("#search-test");

  // 进页 GET 一次：已配置 / 未配置；404 = 老服务端，退回 env 形态
  try {
    const response = await request("/api/v1/agent/search-provider", { cache: "no-store" });
    if (response.status === 404) {
      applySearchEnvMode(host);
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const node = host.querySelector("#search-state");
      if (node) node.textContent = "读取失败";
      return;
    }
    paintSearchState(host, data.hasKey === true);
  } catch {
    const node = host.querySelector("#search-state");
    if (node) node.textContent = "读取失败";
  }

  input?.addEventListener("input", () => setSearchHint(host, ""));

  save?.addEventListener("click", async () => {
    const apiKey = (input?.value || "").trim();
    if (!apiKey) {
      setSearchHint(host, "留空 = 不改；要保存请先填一个 Key。", false);
      return;
    }
    save.disabled = true;
    if (test) test.disabled = true;
    setSearchHint(host, "保存中…", false);
    try {
      const response = await request("/api/v1/agent/search-provider", {
        method: "PUT",
        body: JSON.stringify({ apiKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        if (input) {
          input.value = "";
          input.type = "password";
        }
        const eye = host.querySelector("#search-eye");
        if (eye) {
          eye.setAttribute("aria-pressed", "false");
          const showIcon = eye.querySelector(".eye-show");
          const hideIcon = eye.querySelector(".eye-hide");
          if (showIcon) showIcon.hidden = false;
          if (hideIcon) hideIcon.hidden = true;
        }
        paintSearchState(host, true);
        setSearchHint(host, "已保存，下一轮生效。", false);
        return;
      }
      if (response.status === 404 || data.error === "secrets_disabled") {
        applySearchEnvMode(host);
        return;
      }
      setSearchHint(host, data.message || "保存失败，稍后再试。", true);
    } catch {
      setSearchHint(host, "请求没发出去，检查服务是否在跑。", true);
    } finally {
      save.disabled = false;
      if (test) test.disabled = false;
    }
  });

  test?.addEventListener("click", async () => {
    test.disabled = true;
    if (save) save.disabled = true;
    setSearchHint(host, "测试中…", false);
    try {
      const response = await request("/api/v1/agent/search-provider/test", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok === true) {
        setSearchHint(host, data.message || `搜索通了，返回 ${data.hits ?? 0} 条`, false);
        paintSearchState(host, true);
        return;
      }
      const base = SEARCH_ERROR_TEXT[data.error] || "测试没通过，稍后再试。";
      setSearchHint(
        host,
        data.message && data.error === "upstream_error" ? `${base}（${data.message}）` : base,
        true,
      );
      if (data.error === "search_not_configured") paintSearchState(host, false);
    } catch {
      setSearchHint(host, "请求没发出去，检查服务是否在跑。", true);
    } finally {
      test.disabled = false;
      if (save) save.disabled = false;
    }
  });
}


function wireProviderForm(host) {
  const hint = (text, isError = true) => setProviderHint(host, text, isError);
  const clear = () => hint("", false);

  for (const node of host.querySelectorAll("input, textarea")) {
    node.addEventListener("input", clear);
  }

  // 眼睛：按住时不让输入框失焦，点一下在 password / text 之间切
  host.querySelector("#pv-eye")?.addEventListener("mousedown", (event) => event.preventDefault());
  host.querySelector("#pv-eye")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const input = host.querySelector("#pv-apikey");
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", String(show));
    button.setAttribute("aria-label", show ? "隐藏密钥" : "显示密钥");
    button.title = show ? "隐藏" : "显示";
    const showIcon = button.querySelector(".eye-show");
    const hideIcon = button.querySelector(".eye-hide");
    if (showIcon) showIcon.hidden = show;
    if (hideIcon) hideIcon.hidden = !show;
  });

  host.querySelector("#pv-back")?.addEventListener("click", () => showProviderTemplates());
  host.querySelector("#pv-cancel")?.addEventListener("click", () => {
    const { provider } = currentProviderFormTarget();
    if (provider) {
      // 编辑态取消 = 丢掉未保存输入，回到磁盘上的那份（原位填回，不重建）
      hydrateProviderModels(provider, null);
      fillProviderForm(host, provider, null);
      renderProviderModelList(host);
      return;
    }
    showProviderTemplates();
  });

  host.querySelector("#pv-add-model")?.addEventListener("click", () => openProviderModelDialog(host, -1));
  host.querySelector("#pv-save")?.addEventListener("click", () => void saveProviderFlow());

  host.querySelector("#pv-delete")?.addEventListener("click", () => {
    const { provider } = currentProviderFormTarget();
    if (provider) confirmDeleteProvider(provider);
  });
}

/**
 * 保存编排（2026-11-05）：
 *   ① POST /agent/providers            基本信息 + 逐模型元数据（含前端生成的 id/keyEnv）
 *   ② PUT  /agent/providers/:id/secret 密钥（Key 框留空 = 不改）
 * 模型清单就是表单里那张卡片列表；不再有第二段「保存并拉取清单」。
 * ②失败但服务端没有该接口（404 / secrets_disabled）时，退回“只填变量名”的老形态。
 */
async function saveProviderFlow() {
  const host = document.getElementById("provider-detail");
  if (!host) return;
  const saveButton = host.querySelector("#pv-save");
  if (saveButton?.disabled) return;

  const { provider } = currentProviderFormTarget();
  const apiKey = (host.querySelector("#pv-apikey")?.value || "").trim();
  const values = providerFormValues(provider ? provider.id : "");
  const problem = providerFormError(values);
  if (problem) {
    setProviderHint(host, problem);
    return;
  }

  if (saveButton) saveButton.disabled = true;
  setProviderHint(host, "保存中…", false);
  try {
    // ① 基本信息（允许空清单：先建档，再逐个添加模型）
    const created = await postProvider(values);
    if (!created.response.ok) {
      setProviderHint(host, providerErrorText(created.data || {}, created.response.status));
      return;
    }
    const saved = created.data.provider || {};
    const providerId = saved.id || values.id || (provider && provider.id) || "";
    if (!providerId) {
      setProviderHint(host, "服务端没回供应商 id，刷新后再试。");
      return;
    }
    // 视图立刻切到这家：后面任一步失败，回来也是编辑态而不是“新建”
    state.providerView = { mode: "form", providerId, templateId: "" };
    // 列表先用本地回写，别等下一次 GET（②失败时左栏也不会缺这一行）
    state.providers = [
      ...(state.providers || []).filter((item) => item.id !== providerId),
      { ...saved, id: providerId },
    ];
    renderProviderNav();
    fillProviderForm(host, { ...saved, id: providerId }, null);
    if (apiKey) {
      const input = host.querySelector("#pv-apikey");
      if (input) input.value = apiKey;
    }

    // ② 密钥（留空 = 保留原 Key）
    let keyEnv = saved.keyEnv || values.keyEnv || providerKeyEnv(providerId);
    if (apiKey && state.providerSecretMode !== "env") {
      setProviderHint(host, "已保存，正在存密钥…", false);
      const secret = await putProviderSecret(providerId, apiKey);
      if (secret.response.ok) {
        state.providerSecretMode = "api";
        keyEnv = secret.data.keyEnv || keyEnv;
        applyProviderSecretMode(host);
        const envNode = host.querySelector("#pv-keyenv");
        if (envNode) envNode.value = keyEnv;
        const listed = (state.providers || []).find((item) => item.id === providerId);
        if (listed) listed.hasKey = true;
        renderProviderNav();
      } else if (secret.response.status === 404 || secret.data?.error === "secrets_disabled") {
        // 后端还没上线这个接口：降级成“密钥环境变量名”手输，不抛未捕获异常
        state.providerSecretMode = "env";
        applyProviderSecretMode(host);
        const envNode = host.querySelector("#pv-keyenv");
        if (envNode && !envNode.value.trim()) envNode.value = keyEnv;
        await reloadAfterProviderChange();
        setProviderHint(
          host,
          secret.data?.error === "unknown_provider"
            ? "先保存基本信息，再存密钥。"
            : `这版服务端还没有密钥直填接口：把 Key 写进 .env（变量名 ${keyEnv}），再保存。`,
          false,
        );
        return;
      } else {
        setProviderHint(host, providerSecretErrorText(secret.data, secret.response.status));
        return;
      }
    }

    toast(provider ? `已保存 ${values.name}` : `已添加 ${values.name}`);
    await reloadAfterProviderChange();
    setProviderHint(
      host,
      values.models.length
        ? "已保存"
        : "已保存。现在可以点「添加模型」并检测",
      false,
    );
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

/** 表单校验（服务端仍会再拦一遍；这里只把明显问题挡在请求前） */
function providerFormError(values) {
  if (!values.name) return "给供应商起个名字。";
  if (!/^https?:\/\/\S+$/i.test(values.baseUrl)) {
    return "Base URL 要写完整地址（http:// 或 https://）。";
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(values.keyEnv)) {
    return "变量名只能是大写字母、数字、下划线，且不以数字开头（如 DASHSCOPE_API_KEY）。";
  }
  return "";
}

function parseModelText(text) {
  return String(text || "")
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 草稿列表 → 接口字段；没配的元数据不下发（服务端按默认值解释） */
function providerModelPayload(models) {
  const ids = [];
  const modelMeta = {};
  const modelThinkingLevels = {};
  for (const model of models || []) {
    if (!model.id) continue;
    ids.push(model.id);
    if (Number.isInteger(model.contextWindow) || Number.isInteger(model.maxTokens)) {
      const meta = {};
      if (Number.isInteger(model.contextWindow)) meta.contextWindow = model.contextWindow;
      if (Number.isInteger(model.maxTokens)) meta.maxTokens = model.maxTokens;
      modelMeta[model.id] = meta;
    }
    if (Array.isArray(model.thinkingLevels) && model.thinkingLevels.length) {
      modelThinkingLevels[model.id] = [...model.thinkingLevels];
    }
  }
  return { models: ids, modelMeta, modelThinkingLevels };
}

function providerFormValues(editingId) {
  const name = (document.getElementById("pv-name")?.value || "").trim();
  const baseUrl = (document.getElementById("pv-base")?.value || "").trim();
  const { models, modelMeta, modelThinkingLevels } = providerModelPayload(state.providerModels);
  const keyEnvInput = (document.getElementById("pv-keyenv")?.value || "").trim();
  // 空清单显式允许：先建档（拿 key），再逐个添加并检测模型
  const base = { name, baseUrl, models, modelMeta, modelThinkingLevels, allowEmptyModels: true };
  if (editingId) {
    const provider = providerById(editingId);
    // 编辑时 keyEnv 默认沿用磁盘上的那个；只有退回 env 形态才读手输框
    const keyEnv =
      state.providerSecretMode === "env"
        ? keyEnvInput || provider?.keyEnv || ""
        : provider?.keyEnv || providerKeyEnv(editingId);
    // id 不能改：编辑时把原 id 一并带上，服务端会拒绝 previousId ≠ id
    return { ...base, id: editingId, previousId: editingId, keyEnv };
  }
  // 新建：id/keyEnv 前端先定下来（服务端同一套 slug 规则），② 才有 id 可用
  const id = nextProviderId(name || "provider");
  const keyEnv =
    (state.providerSecretMode === "env" && keyEnvInput) || providerKeyEnv(id);
  return { ...base, id, keyEnv };
}

/** 删除确认（复用 .modal，确认钮走 destructive 色；不用 window.confirm） */
function confirmDeleteProvider(provider) {
  openModal("删除供应商", (body) => {
    body.innerHTML = `
      <p class="modal-desc">删除「${esc(provider.name)}」之后，已有会话下一轮会回退到默认供应商。这个操作不能撤销。</p>
      <p class="modal-hint" id="pv-del-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="pv-del-confirm">删除</button>
      </div>`;

    const hint = body.querySelector("#pv-del-hint");
    const confirm = body.querySelector("#pv-del-confirm");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    confirm?.addEventListener("click", async () => {
      if (confirm.disabled) return;
      confirm.disabled = true;
      try {
        const response = await request(`/api/v1/agent/providers/${encodeURIComponent(provider.id)}`, {
          method: "DELETE",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, providerErrorText(data, response.status));
          confirm.disabled = false;
          return;
        }
        closeModal();
        toast(`已删除 ${provider.name}`);
        state.providerView = { mode: "empty", providerId: "", templateId: "" };
        await reloadAfterProviderChange();
      } catch (error) {
        if (error.message === "forbidden") {
          closeModal(); // 令牌门在最上层，别让模态挡住它
          return;
        }
        setModalHint(hint, `没删成：${error.message}`);
        confirm.disabled = false;
      }
    });
  });
}

/** 左栏点行 / 空态入口：选中并展开右栏表单 */
function openProviderForm(providerId) {
  const provider = providerById(providerId);
  if (!provider) return;
  state.providerView = { mode: "form", providerId: provider.id, templateId: "" };
  renderProviderNav();
  renderProviderDetail();
}

async function postProvider(payload) {
  try {
    const response = await request("/api/v1/agent/providers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (error.message === "forbidden") {
      return { response: { ok: false, status: 403 }, data: { message: "需要访问令牌" } };
    }
    return { response: { ok: false, status: 0 }, data: { message: error.message } };
  }
}

/** 直填密钥（2026-11-05 契约）：body 只有 apiKey，响应不回显密钥值 */
async function putProviderSecret(providerId, apiKey) {
  try {
    const response = await request(
      `/api/v1/agent/providers/${encodeURIComponent(providerId)}/secret`,
      { method: "PUT", body: JSON.stringify({ apiKey }) },
    );
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (error.message === "forbidden") {
      return { response: { ok: false, status: 403 }, data: { message: "需要访问令牌" } };
    }
    return { response: { ok: false, status: 0 }, data: { message: error.message } };
  }
}

/** 供应商改了之后：列表、默认模型行、composer 标签一起刷新 */
async function reloadAfterProviderChange() {
  await loadProviders();
  try {
    state.modelCatalog = await fetchModelCatalog();
    renderDefaultModelRow(state.modelCatalog);
    updateModelPill();
  } catch {
    /* 读不到就保留旧显示 */
  }
}

el.openSettings.addEventListener("click", () => go("settings"));
el.closeSettings.addEventListener("click", () => go("chat"));
el.toggleSidebar.addEventListener("click", toggleSidebar);
el.toggleSidebar.setAttribute("aria-expanded", String(sidebarOpen()));

/* ── 自绘窗口三键（仅 MyGo 壳内） ─────────────────────── */

// 普通浏览器没有 MyGo API：按钮保持 hidden，避免出现点了没反应的按钮。
// 注意 MyGo 运行时暴露的方法是首字母小写：minimize / toggleMaximize / isMaximized / close，
// 且 window.mygo.window 是冻结对象，取不到时只能静默，所以大小写必须对。
const shellWindow = (() => {
  try {
    if (typeof window.isMyGo !== "function" || !window.isMyGo()) return null;
    return window.mygo?.window ?? null;
  } catch {
    return null;
  }
})();

async function callWindow(method) {
  try {
    const result = shellWindow?.[method]?.();
    // 接口可能是同步返回值，也可能返回 Promise；两种都等它结束
    if (result && typeof result.then === "function") await result;
  } catch {
    /* 壳没接上就静默，别把按钮变成报错源 */
  }
}

async function readMaximized() {
  try {
    const value = shellWindow?.isMaximized?.();
    const resolved = value && typeof value.then === "function" ? await value : value;
    return Boolean(resolved);
  } catch {
    return false;
  }
}

/** 最大化/还原图标、aria-label 与窗口状态对齐 */
async function syncWindowState() {
  if (!shellWindow) return;
  const maximized = await readMaximized();
  const maxIcon = el.winMax.querySelector(".ico-max");
  const restoreIcon = el.winMax.querySelector(".ico-restore");
  // SVGElement 没有 hidden IDL 属性，直接赋值只写 JS 对象、不落到 HTML 属性，
  // 而 [hidden]{display:none} 只认属性，所以必须用 toggleAttribute。
  if (maxIcon) maxIcon.toggleAttribute("hidden", maximized);
  if (restoreIcon) restoreIcon.toggleAttribute("hidden", !maximized);
  el.winMax.setAttribute("aria-label", maximized ? "还原窗口" : "最大化窗口");
  el.winMax.title = maximized ? "还原" : "最大化";
}

if (shellWindow) {
  el.windowControls.hidden = false;
  el.winMin.addEventListener("click", () => void callWindow("minimize"));
  el.winMax.addEventListener("click", async () => {
    await callWindow("toggleMaximize");
    await syncWindowState();
  });
  el.winClose.addEventListener("click", () => void callWindow("close"));
  // 双击标题栏 / 系统贴靠 / 拖出边界都会改变窗口尺寸，图标跟着走
  window.addEventListener("resize", () => void syncWindowState());
  void syncWindowState();
}

el.menuBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenuOpen(el.menuPop.hidden);
});
el.menuPop.addEventListener("click", (event) => {
  const item = event.target.closest("[data-action]");
  if (!item) return;
  closeMenu();
  if (item.dataset.action === "settings") {
    go("settings");
  } else if (item.dataset.action === "new") {
    go("chat");
    startNewChat("worker");
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) closeMenu();
});

/* ── 执事与例行任务（E1，2026-11-05；纯前端，后端零改动）────
   端点形状以 companion-api.ts / routines.ts 为准：
   执事投影 {id,name,status,soulVersion,domain?}；详情多 soul / soulVersion / modelChain；
   例行任务投影 {id,name,triggers,sessionMode,enabled,…}；runs {status,trigger,summary,startedAt,…}。
   网络只走 request()，反馈只走 toast()，确认只走 openModal()，动态值一律 esc()/attr()。 */

const PT_STATUS = {
  active: { text: "运行中", cls: "ok" },
  paused: { text: "已暂停", cls: "warn" },
  archived: { text: "已归档", cls: "" },
};
const PT_RUN_STATUS = {
  success: { text: "成功", cls: "ok" },
  failed: { text: "失败", cls: "warn" },
  interrupted: { text: "中断", cls: "warn" },
  running: { text: "运行中", cls: "" },
  skipped: { text: "跳过", cls: "" },
};

function ptStatusPill(status) {
  const info = PT_STATUS[status] || { text: status || "未知", cls: "" };
  return `<span class="pill-tag ${info.cls}">${esc(info.text)}</span>`;
}

function ptStatusDot(status, id = "") {
  // 与服务连通一起判：active + 在线才是绿；失联黄；暂停/归档灰（2026-11-06 C 批）
  const attrs = id ? ` data-pt-dot="${esc(id)}"` : "";
  return `<span class="status-dot ${partnerDotClass(status)}"${attrs} aria-hidden="true"></span>`;
}

/** 触发器人话化：cron 给原文 + 一句人话，其余给一句人话。返回值已转义，直接塞进模板。 */
function ptHumanizeTrigger(trigger) {
  if (!trigger) return "—";
  if (trigger.type === "cron") {
    const raw = String(trigger.expr || "");
    const parts = raw.trim().split(/\s+/);
    let human = "按 cron 定时";
    if (parts.length === 5) {
      const [mi, hr, dom, mon, dow] = parts;
      const pad = (v) => (v === "*" ? "*" : String(v).padStart(2, "0"));
      const clock = `${pad(hr)}:${pad(mi)}`;
      if (hr !== "*" && mi !== "*" && dom === "*" && mon === "*" && dow === "*") human = `每天 ${clock}`;
      else if (hr === "*" && mi !== "*" && dom === "*" && mon === "*" && dow === "*") human = `每小时第 ${mi} 分`;
      else if (hr === "*" && mi === "*") human = "每分钟";
      else if (dom !== "*") human = `每月 ${dom} 日 ${clock}`;
      else if (dow !== "*") human = `每周 ${dow} ${clock}`;
    }
    return `<span class="kv">${esc(raw)}</span> <span class="pt-human">${esc(human)}</span>`;
  }
  if (trigger.type === "interval") {
    const secs = Number(trigger.seconds) || 0;
    const mins = secs / 60;
    const human = Number.isInteger(mins) && mins > 0 ? `每 ${mins} 分钟` : `每 ${secs} 秒`;
    return esc(human);
  }
  if (trigger.type === "once") {
    const at = trigger.at ? new Date(trigger.at) : null;
    const shown = at && !Number.isNaN(at.getTime()) ? at.toLocaleString("zh-CN") : String(trigger.at || "");
    return `一次性 · ${esc(shown)}`;
  }
  if (trigger.type === "event") {
    const kind = String(trigger.kind || "");
    const matchText = trigger.match && Object.keys(trigger.match).length
      ? Object.entries(trigger.match).map(([k, v]) => `${k}=${v}`).join(", ")
      : "";
    return `事件 · ${esc(kind)}${matchText ? ` <span class="kv">${esc(matchText)}</span>` : ""}`;
  }
  return "—";
}

/* ── 执事列表（设置页 #/settings/partners）────────────── */

async function loadPartners() {
  const box = document.getElementById("partner-list");
  if (!box) return;
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(response.status));
    // 设置页也共享头像 / 状态缓存（侧栏与设置不各拉一份结论）
    if (Array.isArray(data.partners)) {
      state.partners = data.partners;
      syncChiefAvatar();
    }
    renderPartnerList(box, data.partners || []);
  } catch (error) {
    if (error.message === "forbidden") return;
    box.innerHTML = `<div class="set-hint is-error">读不到执事：${esc(error.message)}</div>`;
  }
}

function renderPartnerList(box, partners) {
  box.replaceChildren();
  if (!partners.length) {
    const empty = document.createElement("div");
    empty.className = "card pt-empty";
    empty.innerHTML = `<p class="set-hint">还没有执事。新建一个，或给总管配个执事。</p>
      <button class="btn-primary" type="button" id="partner-empty-add">新建执事</button>`;
    box.append(empty);
    empty.querySelector("#partner-empty-add")?.addEventListener("click", () => openCreatePartnerModal());
    return;
  }
  for (const partner of partners) {
    const card = document.createElement("div");
    card.className = "card pt-card";
    const isChief = partner.id === "chief";
    const archived = partner.status === "archived";
    const nextStatus = partner.status === "active" ? "paused" : "active";
    // 卡片形状（2026-11-07 重排）：头像 + 名字/元信息在左，动作在右，一张卡两行。
    // 原来头像被塞在名字行里、标签和状态点又各占一个位置，一行里五个东西抢视线。
    card.innerHTML = `
      <span class="pt-avatar pt-card-avatar" data-avatar-for="${attr(partner.id)}" aria-hidden="true"></span>
      <div class="pt-card-main">
        <div class="pt-card-name-row">
          <span class="row-label pt-name">${esc(partner.name || "")}</span>
          ${isChief && partner.name !== "总管" ? '<span class="pill-tag">总管</span>' : ""}
          ${ptStatusPill(partner.status)}
          ${ptStatusDot(partner.status, partner.id)}
        </div>
        <div class="pt-meta">
          <span class="kv">人设 v${esc(String(partner.soulVersion ?? "—"))}</span>
          ${partner.domain ? `<span class="pt-domain kv">领域 · ${esc(String(partner.domain))}</span>` : ""}
        </div>
      </div>
      <div class="pt-actions">
        <button class="ghost" type="button" data-pt-edit="${attr(partner.id)}">改人设</button>
        <button class="ghost" type="button" data-pt-run="${attr(partner.id)}" data-pt-run-name="${attr(partner.name || "")}">试跑</button>
        ${archived ? "" : `<button class="ghost" type="button" data-pt-toggle="${attr(partner.id)}" data-pt-next="${attr(nextStatus)}">${partner.status === "active" ? "暂停" : "恢复"}</button>`}
      </div>`;
    box.append(card);
    // 头像只走 DOM 属性（不把 data URL 拼进 innerHTML）
    paintAvatar(
      card.querySelector("[data-avatar-for]"),
      partner.avatar || null,
      partner.name || "",
    );

    card.querySelector("[data-pt-edit]")?.addEventListener("click", () => void openEditPartnerModal(partner.id));
    card.querySelector("[data-pt-run]")?.addEventListener("click", () =>
      openRunPartnerModal(partner.id, partner.name || ""),
    );
    if (!archived) {
      card.querySelector("[data-pt-toggle]")?.addEventListener("click", () => {
        const button = card.querySelector("[data-pt-toggle]");
        void ptTogglePartner(partner.id, button.dataset.ptNext, button);
      });
    }
  }
}

async function ptTogglePartner(id, nextStatus, button) {
  if (button) button.disabled = true;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) toast(`没切成：${data.message || data.error || response.status}`);
  } catch (error) {
    if (error.message !== "forbidden") toast(`没切成：${error.message}`);
  } finally {
    if (button) button.disabled = false;
    void loadPartners();
    void loadRoster(); // E4：侧栏花名册同步刷新
  }
}

/* ── 新建执事模态 ────────────────────────────────────── */

function openCreatePartnerModal() {
  openModal("新建执事", (body) => {
    body.innerHTML = `
      <p class="modal-desc">给执事起个名字就行。领域只是一句备注，可以不填、以后也能改，不影响派活。</p>
      <div class="modal-field">
        <span>名字（≤40 字）</span>
        <input class="modal-input" id="pt-new-name" type="text" maxlength="40" placeholder="例如：小助手" />
      </div>
      <div class="modal-field">
        <span>领域标签（可选）</span>
        <input class="modal-input is-mono" id="pt-new-domain" type="text" spellcheck="false"
               placeholder="例如 frontend、写作；不填也行" />
      </div>
      <div class="modal-field">
        <span>一句话身份（可选）</span>
        <textarea class="pt-ta" id="pt-new-identity" rows="2" spellcheck="false"
                  placeholder="例如：你是替我整理资料的安静助手"></textarea>
      </div>
      <p class="modal-hint" id="pt-new-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-primary" id="pt-new-go" type="button">新建</button>
      </div>`;

    const nameInput = body.querySelector("#pt-new-name");
    const domainInput = body.querySelector("#pt-new-domain");
    const identityInput = body.querySelector("#pt-new-identity");
    const hint = body.querySelector("#pt-new-hint");
    const go = body.querySelector("#pt-new-go");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);

    const submit = async () => {
      if (go.disabled) return;
      const name = nameInput.value.trim();
      if (!name) { setModalHint(hint, "先起个名字。"); nameInput.focus(); return; }
      const domain = domainInput.value.trim();
      const identity = identityInput.value.trim();
      go.disabled = true;
      setModalHint(hint, "创建中…", false);
      try {
        const response = await request("/api/v1/partners", {
          method: "POST",
          // E2 #0：soul 随建档一次提交（后端 bumpSoul 落成 v2 自定义版本），
          // 收敛掉 E1「建完补 PATCH」的两段式；不带 identity 时请求形状与旧版一致。
          body: JSON.stringify({
            name,
            ...(domain ? { domain } : {}),
            ...(identity ? { soul: identity } : {}),
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setModalHint(hint, data.message || data.error || `没建成：HTTP ${response.status}`);
          return;
        }
        closeModal();
        toast("执事已新建");
        void loadPartners();
        void loadRoster(); // E4：侧栏花名册同步刷新
      } catch (error) {
        if (error.message === "forbidden") { closeModal(); return; }
        setModalHint(hint, `没建成：${error.message}`);
      } finally {
        go.disabled = false;
      }
    };
    go.addEventListener("click", () => void submit());
    nameInput.addEventListener("input", () => clearModalHint(hint));
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void submit(); }
    });
  });
}

/* ── 编辑执事模态（人设（含头像）/ 模型候选链 / 例行任务）──
 *
 * 2026-11-07 用户口径：**头像属于人设的一部分**——头像就是这个角色的脸，SOUL 是它的内核，
 * 两件事说的是同一个"你是谁"，不该在设置里分成两个入口（原来头像单开一个分区，
 * 用户得先在「头像」页选对象、再来「执事」页编辑）。
 * 所以：编辑弹窗里头像与 SOUL 合并成「人设」一段，头像在上、正文在下，同一次"保存人设"提交；
 * 弹窗加宽到 760px（原来 420px，SOUL 一列只能显示 30 来个字宽，长文很难读）。 */

const PARTNER_MODAL_CLASS = "modal-wide";

async function openEditPartnerModal(partnerId) {
  let detail;
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, { cache: "no-store" });
    detail = await response.json().catch(() => ({}));
    if (!response.ok || !detail.ok) { toast("读不到执事详情"); return; }
  } catch (error) {
    if (error.message !== "forbidden") toast(`读不到执事详情：${error.message}`);
    return;
  }
  const name = String(detail.partner?.name || "").trim();
  openModal(name ? `人设 · ${name}` : "人设", (body) => ptBuildEditModal(body, partnerId, detail), {
    className: PARTNER_MODAL_CLASS,
  });
}

function ptBuildEditModal(body, partnerId, detail) {
  const partner = detail.partner || {};
  const soul = String(detail.soul ?? "");
  const chain = Array.isArray(detail.modelChain) ? detail.modelChain : [];
  body.innerHTML = `
    <div class="pt-edit">
      <!-- 人设（2026-11-07 合并）：头像 + SOUL 说的是同一件事「你是谁」。
           头部一行 = 头像（点开下拉选预设或本地文件）+ 说明 + 版本号，正文吃满宽度；
           一次「保存人设」同时提交 avatar 与 soul（PATCH 同对象，服务端本来就支持多槽位）。 -->
      <div class="pt-seg pt-instr">
        <div class="pt-instr-top">
          <button class="pt-avatar avatar-edit pt-portrait-btn" id="pt-avatar-preview" type="button"
                  aria-label="更换头像" title="更换头像" aria-haspopup="dialog" aria-expanded="false">
            <span class="pt-portrait-chev" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </span>
          </button>
          <div class="pt-instr-meta">
            <span class="pt-instr-label">它是谁、怎么说话、守什么规矩</span>
            <span class="pt-instr-sub" id="pt-portrait-caption">点头像换一张：30 张预设或本地图片</span>
          </div>
          <span class="kv" id="pt-soul-version">人设 v${esc(String(detail.soulVersion ?? "—"))}</span>
        </div>
        <textarea class="pt-ta is-soul" id="pt-soul" rows="6" spellcheck="false"
                  aria-label="人设正文"
                  placeholder="例：你叫阿岚，是这个家的管事。说话短、先给结论；不确定就直说，不要编。">${esc(soul)}</textarea>
        <p class="modal-hint" id="pt-instr-hint">头像和这段正文一起保存，作为新版本生效（下一轮起用）。</p>
        <div class="pt-actions">
          <button class="ghost" id="pt-instr-reset" type="button" disabled>撤销改动</button>
          <button class="btn-primary" id="pt-instr-save" type="button" disabled>保存人设</button>
        </div>
      </div>

      <div class="pt-seg pt-basic">
        <div class="pt-seg-head">
          <span class="pt-seg-title">名字与领域</span>
          <span class="kv">领域只是备注，可留空、可改</span>
        </div>
        <div class="pt-basic-row">
          <label class="modal-field">
            <span>名字</span>
            <div class="modal-row">
              <input class="modal-input" id="pt-name" type="text" maxlength="40" value="${attr(partner.name || "")}" />
              <button class="ghost" id="pt-name-save" type="button">改名</button>
            </div>
          </label>
          <label class="modal-field">
            <span>领域标签（可选）</span>
            <div class="modal-row">
              <input class="modal-input is-mono" id="pt-domain" type="text" value="${attr(partner.domain || "")}"
                     placeholder="留空也行，不影响派活" />
              <button class="ghost" id="pt-domain-save" type="button">保存</button>
            </div>
          </label>
        </div>
        <p class="set-hint">领域只是一句备注（例如 frontend、写作），用来在任务列表里区分活是谁的。留空照样能派活。</p>
      </div>

      <div class="pt-seg">
        <div class="pt-seg-head">
          <span class="pt-seg-title">备选模型</span>
          <span class="kv">最多 5 条 · 只存变量名</span>
        </div>
        <p class="set-hint">只在试跑与例行任务轮次里生效：那一轮没应答且原因可切（超时 / 5xx / 限流 / 鉴权 / 模型下线）时，按顺序换下一条重跑；不改变主对话。</p>
        <div id="pt-chain-editor"></div>
      </div>

      <div class="pt-seg">
        <div class="pt-seg-head">
          <span class="pt-seg-title">例行任务</span>
          <button class="ghost" id="pt-routine-refresh" type="button">刷新</button>
        </div>
        <div class="pt-routine-list" id="pt-routine-list"><div class="set-hint">读取中…</div></div>
        ${ptRoutineFormMarkup()}
      </div>
    </div>`;

  const nameInput = body.querySelector("#pt-name");
  body.querySelector("#pt-name-save")?.addEventListener("click", () => void ptSaveName(partnerId, nameInput));

  // 领域标签（2026-11-07）：可留空、可改。空串 = 清掉标签（回到"普通执事"）。
  const domainInput = body.querySelector("#pt-domain");
  body.querySelector("#pt-domain-save")?.addEventListener("click", () => {
    void (async () => {
      const value = String(domainInput?.value || "").trim();
      const res = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ domain: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addNotice(data.message || "领域标签没保存成功。");
        return;
      }
      partner.domain = value || null;
      addNotice(value ? `领域标签已改成 ${value}。` : "领域标签已清空，不影响派活。");
    })();
  });

  void ptWireInstructionEditor(body, partnerId, partner, soul, detail.soulVersion ?? null);

  // 备选链与抽屉的「模型 → 备选模型」共用同一个编辑器（2026-11-07）：
  // 两处都是「从已有模型里选」，不再手打 providerId|modelId|KEY_ENV。
  mountChainEditor(body.querySelector("#pt-chain-editor"), {
    partnerId,
    chain,
    onSaved: (next) => {
      if (csDetail && csTarget === partnerId) csDetail.modelChain = next;
    },
  });

  const listBox = body.querySelector("#pt-routine-list");
  body.querySelector("#pt-routine-refresh")?.addEventListener("click", () => void ptRenderRoutineList(listBox, partnerId));
  ptWireRoutineForm(body, partnerId, listBox);
  void ptRenderRoutineList(listBox, partnerId);
}

/* ── 人设编辑器（2026-11-07）：头像 + SOUL 一次改、一次存 ──────────────────
 *
 * 用户口径：「头像应该合并到指示里（界面称呼现为「人设」）；选图片可以下拉选择系统预设图片，
 * 也可以从本地选文件」。
 * 所以头像不再是一个独立表单，而是头像按钮自己弹出选择面板：
 *   点头像 → 面板（预设图库网格 + "从本地选一张"）→ 选中即进草稿 → 与 SOUL 一起「保存人设」。
 * 草稿语义沿用 C 批：选完只改本地预览，保存才写服务端；撤销 / 关窗不动任何数据。
 * 预设走 /assets/preset/<m|f><NN>.png（服务端白名单，2026-11-06 已落地），本地上传走
 * fileToAvatarPng（解码 → 最长边 ≤256 → PNG → ≤128KiB，与服务端复核同口径）。 */

const INSTR_PRESET_GROUPS = [
  { id: "male", label: "男生", files: AVATAR_PRESET_FILES.male },
  { id: "female", label: "女生", files: AVATAR_PRESET_FILES.female },
];

/**
 * 头像选择面板（2026-11-07 抽出共用）：贴在触发按钮下方浮出，
 * 预设图库（30 张）+ 从本地选一张 + 不使用。
 *
 * 抽出来的原因：抽屉的人设页与「全部设置 → 人设」的弹窗都要换头像，
 * 两份实现一定会漂移（此前就是弹窗独占一份）。回调口径：
 *   onPick(dataUrl|null) —— 选中即进草稿，不写服务端（保存由调用方决定）
 *   onBusy(bool, message) —— 解码/读取中，调用方据此禁用保存
 */
function openAvatarPanel({ anchor, current, onPick, onBusy }) {
  if (!anchor || !anchor.isConnected) return;
  if (anchor.dataset.avatarPanel === "1") {
    closeAvatarPanel();
    return;
  }
  const node = document.createElement("div");
  node.className = "pt-portrait-pop is-fixed";
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", "选择头像");

  const head = document.createElement("div");
  head.className = "pt-portrait-pop-head";
  const title = document.createElement("span");
  title.textContent = "选一张头像";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "pt-portrait-pop-clear";
  clear.textContent = "不使用";
  clear.title = "保存时不带头像，显示名字首字";
  head.append(title, clear);

  const groups = document.createElement("div");
  groups.className = "pt-portrait-groups";
  for (const group of INSTR_PRESET_GROUPS) {
    const label = document.createElement("div");
    label.className = "pt-portrait-group-label";
    label.textContent = `${group.label} · ${group.files.length}`;
    const grid = document.createElement("div");
    grid.className = "pt-portrait-grid";
    for (const file of group.files) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "pt-portrait-cell";
      cell.dataset.preset = file;
      cell.title = `预设 ${file}`;
      cell.setAttribute("aria-label", `预设头像 ${file}`);
      const img = document.createElement("img");
      img.src = AVATAR_PRESET_URL(file);
      img.alt = "";
      img.decoding = "async";
      img.setAttribute("aria-hidden", "true");
      cell.append(img);
      cell.addEventListener("click", () => void pick(file, cell));
      grid.append(cell);
    }
    groups.append(label, grid);
  }

  // 本地选图 input 常驻在 body 下（浮层收起时会被移除，系统文件框是异步的）
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp";
  fileInput.hidden = true;
  document.body.append(fileInput);

  const foot = document.createElement("div");
  foot.className = "pt-portrait-pop-foot";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "ghost";
  upload.textContent = "从本地选一张…";
  const note = document.createElement("span");
  note.className = "pt-portrait-pop-note";
  note.textContent = "PNG / JPEG / WebP · ≤5MiB";
  foot.append(upload, note);
  node.append(head, groups, foot);
  document.body.append(node);

  const position = () => {
    const r = anchor.getBoundingClientRect();
    const width = node.offsetWidth || 332;
    const height = node.offsetHeight || 420;
    const gap = 8;
    let left = r.left;
    if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
    let top = r.bottom + gap;
    if (top + height > window.innerHeight - 12) {
      const above = r.top - height - gap;
      top = above >= 12 ? above : Math.max(12, window.innerHeight - height - 12);
    }
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  };
  position();
  anchor.dataset.avatarPanel = "1";
  anchor.setAttribute("aria-expanded", "true");

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    delete anchor.dataset.avatarPanel;
    anchor.setAttribute("aria-expanded", "false");
    node.remove();
    // 选图按钮点下去会先 close() 再 fileInput.click()：系统文件框是异步的，
    // 这里若把 input 摘掉，change 就永远不触发。等 change/取消之后再清。
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
  };
  const onResize = () => position();
  const onDocPointer = (event) => {
    if (node.contains(event.target) || anchor.contains(event.target)) return;
    close();
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    if (event.isComposing || event.keyCode === 229) return;
    event.stopPropagation(); // 只关面板，别把外面的抽屉/弹窗一起关了
    close();
    anchor.focus();
  };
  window.addEventListener("resize", onResize);
  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onKey, true);

  clear.addEventListener("click", () => {
    onPick(null);
    close();
  });
  upload.addEventListener("click", () => {
    close();
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) {
      fileInput.remove();
      return;
    }
    onBusy?.(true, "处理图片…");
    try {
      const dataUrl = await fileToAvatarPng(file);
      onPick(dataUrl);
    } catch (error) {
      onBusy?.(false, error.message || "这张图片不能用作头像");
      fileInput.remove();
      return;
    }
    onBusy?.(false, "");
    fileInput.remove();
  });

  async function pick(file, cell) {
    if (cell) cell.classList.add("is-busy");
    onBusy?.(true, "读取预设…");
    try {
      const resp = await fetch(AVATAR_PRESET_URL(file), { cache: "no-store" });
      if (!resp.ok) throw new Error(`预设读不到（HTTP ${resp.status}）`);
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("预设读不出来"));
        reader.readAsDataURL(blob);
      });
      const problem = avatarDataProblem(dataUrl);
      if (problem) throw new Error(problem);
      onPick(dataUrl);
      close();
      onBusy?.(false, "");
    } catch (error) {
      if (cell) cell.classList.remove("is-busy");
      onBusy?.(false, error.message || "这个预设用不了");
    }
  }
}

/** 供面板切换：当前已打开就收起 */
function closeAvatarPanel() {
  document.querySelectorAll('[data-avatar-panel="1"]').forEach((node) => {
    delete node.dataset.avatarPanel;
    node.setAttribute("aria-expanded", "false");
  });
  for (const pop of document.querySelectorAll(".pt-portrait-pop.is-fixed")) pop.remove();
}

async function ptWireInstructionEditor(body, partnerId, partner, initialSoul, soulVersion) {
  const preview = body.querySelector("#pt-avatar-preview");
  const caption = body.querySelector("#pt-portrait-caption");
  const soulArea = body.querySelector("#pt-soul");
  const hint = body.querySelector("#pt-instr-hint");
  const save = body.querySelector("#pt-instr-save");
  const reset = body.querySelector("#pt-instr-reset");
  const versionNode = body.querySelector("#pt-soul-version");
  if (!preview || !soulArea) return;

  const nameOf = () => String(partner.name || "").trim() || "执事";
  let originalAvatar = partner.avatar || null;
  let originalSoul = String(initialSoul ?? "");
  let avatarDraft = originalAvatar;
  let soulDraft = originalSoul;
  let decoding = false;
  let saving = false;
  let decodeSeq = 0;

  // 模态关闭后 #modal-body 会被 replaceChildren 清空（节点本身还在 DOM 里），
  // 所以 alive() 不能只看 isConnected——要确认这个 textarea 自己还在文档里。
  const alive = () => soulArea.isConnected && body.isConnected;
  const isDirty = () => avatarDraft !== originalAvatar || soulDraft !== originalSoul;

  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", Boolean(isError && text));
  };

  const paint = () => {
    paintAvatar(preview, avatarDraft, nameOf());
    preview.classList.toggle("has-image", Boolean(avatarDraft));
    if (caption) {
      caption.textContent = avatarDraft
        ? "点头像换一张：30 张预设或本地图片"
        : "还没有头像，点头像选一张（预设或本地文件）";
    }
  };

  const refresh = () => {
    const dirty = isDirty();
    save.disabled = saving || decoding || !dirty || !soulDraft.trim();
    reset.disabled = saving || decoding || !dirty;
    preview.disabled = saving;
    soulArea.disabled = saving;
  };

  paint();
  refresh();

  // 本地选图 input：常驻在弹窗 body 里（不进浮层）——浮层收起时会被移除，
  // 而系统文件框是异步的，change 必须落在还活着的节点上。
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.id = "pt-avatar-file";
  fileInput.accept = "image/png,image/jpeg,image/webp";
  fileInput.hidden = true;
  body.append(fileInput);
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ""; // 同一张图再选一次也能触发 change
    if (!file || saving || !alive()) return;
    const seq = ++decodeSeq;
    decoding = true;
    refresh();
    setHint("处理图片…");
    try {
      const dataUrl = await fileToAvatarPng(file);
      if (seq !== decodeSeq || !alive()) return; // 选 A 后清除 / 选 B：A 迟到就作废
      avatarDraft = dataUrl;
      paint();
      setHint("头像已选好，点「保存人设」生效。");
    } catch (error) {
      if (seq !== decodeSeq || !alive()) return;
      setHint(error.message || "这张图片不能用作头像", true);
    } finally {
      if (seq === decodeSeq) {
        decoding = false;
        if (alive()) refresh();
      }
    }
  });

  /* ── 头像：点按钮弹共用面板（与抽屉的人设页同一份实现，2026-11-07 抽出）── */
  preview.addEventListener("click", () => {
    if (saving || decoding || !alive()) return;
    openAvatarPanel({
      anchor: preview,
      current: avatarDraft,
      onPick: (dataUrl) => {
        avatarDraft = dataUrl;
        decodeSeq += 1;
        decoding = false;
        paint();
        refresh();
        setHint(dataUrl ? "头像已选好，点「保存人设」生效。" : "已改为不使用头像，保存后显示名字首字。");
      },
      onBusy: (busy, message) => {
        decoding = busy;
        if (message) setHint(message, true);
        if (alive()) refresh();
      },
    });
  });

  soulArea.addEventListener("input", () => {
    soulDraft = soulArea.value;
    clearModalHint(hint);
    refresh();
  });

  reset?.addEventListener("click", () => {
    if (saving || !alive()) return;
    decodeSeq += 1;
    decoding = false;
    avatarDraft = originalAvatar;
    soulDraft = originalSoul;
    soulArea.value = originalSoul;
    paint();
    setHint("");
    refresh();
    closeAvatarPanel();
  });

  save?.addEventListener("click", async () => {
    const nextSoul = soulArea.value;
    if (!nextSoul.trim()) {
      setHint("人设不能是空的。", true);
      soulArea.focus();
      return;
    }
    if (!isDirty() || saving || decoding || !alive()) return;
    saving = true;
    refresh();
    setHint("保存中…");
    const payload = {};
    if (nextSoul !== originalSoul) payload.soul = nextSoul;
    if (avatarDraft !== originalAvatar) payload.avatar = avatarDraft;
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (alive()) setHint(data.message || data.error || `没存成：HTTP ${response.status}`, true);
        return;
      }
      // 保存成功后把基准推进到服务端回读值：再点保存不会重复提交同样的内容
      partner.avatar = data.partner?.avatar ?? null;
      const cached = state.partners.find((item) => item.id === partnerId);
      if (cached) cached.avatar = partner.avatar;
      // 缓存同步：侧栏（展开 + 轨道）与设置页都从 state.partners 取头像
      syncChiefAvatar();
      void loadRoster();
      void loadPartners();
      if (!alive()) return;
      const nextVersion = data.soulVersion ?? soulVersion;
      if (versionNode && nextVersion != null) versionNode.textContent = `人设 v${nextVersion}`;
      setHint(data.soulVersion != null ? `已保存为 v${data.soulVersion}，下一轮起用。` : "已保存。");
      // 用回读值重设基准：把「刚保存的内容」当成新的 original
      avatarDraft = partner.avatar;
      soulDraft = nextSoul;
      paint();
      body.querySelector("#pt-soul")?.blur();
      setOriginal(partner.avatar, nextSoul);
    } catch (error) {
      if (alive() && error.message !== "forbidden") setHint(`没存成：${error.message}`, true);
    } finally {
      saving = false;
      if (alive()) refresh();
    }
  });

  /** 保存成功后的新基准（闭包内两个 let 不能从外部改，走这一层） */
  function setOriginal(nextAvatar, nextSoul) {
    originalAvatar = nextAvatar;
    originalSoul = nextSoul;
    refresh();
  }

  /** 关窗即清场：共用面板挂在 body 里，模态一关就一起摘掉 */
  const observer = new MutationObserver(() => {
    if (!alive()) {
      closeAvatarPanel();
      observer.disconnect();
    }
  });
  observer.observe(body, { childList: true });
}

async function ptSaveName(partnerId, input) {
  const name = input.value.trim();
  if (!name) { toast("名字不能为空"); return; }
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { toast(`没改名：${data.message || data.error || response.status}`); return; }
    toast("名字已保存");
    void loadPartners();
  } catch (error) {
    if (error.message !== "forbidden") toast(`没改名：${error.message}`);
  }
}

/* ── 例行任务（编辑模态第三段）───────────────────────── */

function ptRoutineFormMarkup() {
  return `
    <div class="pt-new">
      <div class="pt-seg-title">新建例行任务</div>
      <label class="modal-field">
        <span>名称（≤40 字）</span>
        <input class="modal-input" id="pt-r-name" type="text" maxlength="40" placeholder="例如：每晚整理" />
      </label>
      <label class="modal-field">
        <span>指令 prompt</span>
        <textarea class="pt-ta" id="pt-r-prompt" rows="3" spellcheck="false" placeholder="到点要它做什么"></textarea>
      </label>
      <div class="modal-field">
        <span>触发器类型</span>
        <div class="segmented slide" id="pt-r-trigger" role="radiogroup" aria-label="触发器类型">
          <button type="button" data-trigger="cron" aria-checked="true">cron</button>
          <button type="button" data-trigger="interval" aria-checked="false">interval</button>
          <button type="button" data-trigger="once" aria-checked="false">once</button>
          <button type="button" data-trigger="event" aria-checked="false">event</button>
        </div>
      </div>
      <div class="modal-field pt-trigger-input" data-trigger-input="cron">
        <span>cron 原文（5 段：分 时 日 月 周）</span>
        <input class="modal-input is-mono" id="pt-r-cron" type="text" spellcheck="false" placeholder="30 21 * * *" />
      </div>
      <div class="modal-field pt-trigger-input" data-trigger-input="interval" hidden>
        <span>间隔秒数（≥60）</span>
        <input class="modal-input is-mono" id="pt-r-interval" type="number" min="60" placeholder="3600" />
      </div>
      <div class="modal-field pt-trigger-input" data-trigger-input="once" hidden>
        <span>一次性时间</span>
        <input class="modal-input" id="pt-r-once" type="datetime-local" />
      </div>
      <div class="modal-field pt-trigger-input" data-trigger-input="event" hidden>
        <span>事件 kind</span>
        <select class="modal-input" id="pt-r-kind">
          <option value="delegation">delegation</option>
          <option value="tool">tool</option>
          <option value="phase">phase</option>
        </select>
        <span>match（可选，单行 k=v，多组用逗号）</span>
        <input class="modal-input is-mono" id="pt-r-match" type="text" spellcheck="false" placeholder="phase=done" />
      </div>
      <div class="pt-mode-row">
        <span class="set-hint">会话方式</span>
        <button class="switch" id="pt-r-mode" type="button" role="switch" aria-checked="false" aria-label="每次新开">
          <span class="switch-thumb" aria-hidden="true"></span>
        </button>
        <span class="set-hint" id="pt-r-mode-label">接着聊</span>
      </div>
      <div class="pt-actions">
        <button class="btn-primary" id="pt-r-create" type="button">新建例行任务</button>
      </div>
      <p class="modal-hint" id="pt-r-hint"></p>
    </div>`;
}

function ptWireRoutineForm(body, partnerId, listBox) {
  const seg = body.querySelector("#pt-r-trigger");
  if (seg) mountSegmented(seg);
  const showTrigger = (type) => {
    for (const node of body.querySelectorAll("[data-trigger-input]")) {
      node.hidden = node.dataset.triggerInput !== type;
    }
  };
  showTrigger("cron");
  for (const button of seg ? seg.querySelectorAll("[data-trigger]") : []) {
    button.addEventListener("click", () => {
      for (const other of seg.querySelectorAll("[data-trigger]")) {
        other.setAttribute("aria-checked", String(other === button));
      }
      syncSegmented(seg);
      showTrigger(button.dataset.trigger);
    });
  }

  const mode = body.querySelector("#pt-r-mode");
  const modeLabel = body.querySelector("#pt-r-mode-label");
  mode?.addEventListener("click", () => {
    const next = mode.getAttribute("aria-checked") !== "true";
    mode.setAttribute("aria-checked", String(next));
    if (modeLabel) modeLabel.textContent = next ? "每次新开" : "接着聊";
  });

  const hint = body.querySelector("#pt-r-hint");
  body.querySelector("#pt-r-create")?.addEventListener("click", () =>
    void ptCreateRoutine(body, partnerId, listBox, hint),
  );
  body.querySelector("#pt-r-name")?.addEventListener("input", () => clearModalHint(hint));
}

async function ptCreateRoutine(body, partnerId, listBox, hint) {
  const name = body.querySelector("#pt-r-name")?.value.trim() || "";
  const prompt = body.querySelector("#pt-r-prompt")?.value || "";
  const type = body.querySelector("#pt-r-trigger [data-trigger][aria-checked='true']")?.dataset.trigger || "cron";
  const fresh = body.querySelector("#pt-r-mode")?.getAttribute("aria-checked") === "true";
  const sessionMode = fresh ? "fresh" : "persistent";

  if (!name) { setModalHint(hint, "先给例行任务起个名字。"); return; }
  if (!prompt.trim()) { setModalHint(hint, "指令 prompt 不能为空。"); return; }

  let trigger;
  if (type === "cron") {
    const expr = (body.querySelector("#pt-r-cron")?.value || "").trim();
    if (expr.split(/\s+/).length !== 5) { setModalHint(hint, "cron 要 5 段：分 时 日 月 周"); return; }
    trigger = { type: "cron", expr };
  } else if (type === "interval") {
    const seconds = Number(body.querySelector("#pt-r-interval")?.value);
    if (!Number.isFinite(seconds) || seconds < 60) { setModalHint(hint, "间隔秒数至少 60"); return; }
    trigger = { type: "interval", seconds };
  } else if (type === "once") {
    const raw = body.querySelector("#pt-r-once")?.value || "";
    const at = new Date(raw);
    if (!raw || Number.isNaN(at.getTime())) { setModalHint(hint, "选一个合法时间"); return; }
    trigger = { type: "once", at: at.toISOString() };
  } else {
    const kind = body.querySelector("#pt-r-kind")?.value || "delegation";
    const matchText = (body.querySelector("#pt-r-match")?.value || "").trim();
    trigger = { type: "event", kind };
    if (matchText) {
      const match = {};
      for (const pair of matchText.split(",")) {
        const index = pair.indexOf("=");
        if (index > 0) match[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
      }
      if (Object.keys(match).length) trigger.match = match;
    }
  }

  const button = body.querySelector("#pt-r-create");
  if (button) button.disabled = true;
  setModalHint(hint, "新建中…", false);
  try {
    const response = await request("/api/v1/routines", {
      method: "POST",
      body: JSON.stringify({ partnerId, name, prompt, triggers: [trigger], sessionMode }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setModalHint(hint, data.message || data.error || `没建成：HTTP ${response.status}`); return; }
    setModalHint(hint, "", false);
    toast("例行任务已新建");
    const nameNode = body.querySelector("#pt-r-name");
    const promptNode = body.querySelector("#pt-r-prompt");
    if (nameNode) nameNode.value = "";
    if (promptNode) promptNode.value = "";
    void ptRenderRoutineList(listBox, partnerId);
  } catch (error) {
    if (error.message === "forbidden") { closeModal(); return; }
    setModalHint(hint, `没建成：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function ptRenderRoutineList(box, partnerId) {
  if (!box) return;
  try {
    const response = await request(`/api/v1/routines?partnerId=${encodeURIComponent(partnerId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(response.status));
    const routines = data.routines || [];
    box.replaceChildren();
    if (!routines.length) {
      box.innerHTML = `<div class="set-hint">还没有例行任务，用下面的表单加一条。</div>`;
      return;
    }
    for (const routine of routines) {
      const row = document.createElement("div");
      row.className = "pt-routine";
      const triggers = Array.isArray(routine.triggers) ? routine.triggers : [];
      row.innerHTML = `
        <div class="pt-routine-head">
          <span class="row-label">${esc(routine.name || "")}</span>
          <div class="pt-routine-actions">
            <button class="switch" type="button" role="switch" aria-label="启用"
                    aria-checked="${routine.enabled ? "true" : "false"}" data-pt-enabled="${attr(routine.id)}">
              <span class="switch-thumb" aria-hidden="true"></span>
            </button>
            <button class="ghost" type="button" data-pt-run-now="${attr(routine.id)}">立即跑</button>
            <button class="ghost" type="button" data-pt-history="${attr(routine.id)}">展开历史</button>
            <button class="ghost" type="button" data-pt-del-routine="${attr(routine.id)}" data-pt-del-name="${attr(routine.name || "")}">删除</button>
          </div>
        </div>
        <div class="row-hint pt-trigger">${triggers.length ? triggers.map(ptHumanizeTrigger).join("；") : "—"}</div>
        <div class="pt-runs" data-pt-runs-for="${attr(routine.id)}" hidden></div>`;
      box.append(row);

      row.querySelector("[data-pt-enabled]")?.addEventListener("click", () => {
        const sw = row.querySelector("[data-pt-enabled]");
        void ptToggleRoutine(routine.id, sw);
      });
      row.querySelector("[data-pt-run-now]")?.addEventListener("click", () => {
        const runButton = row.querySelector("[data-pt-run-now]");
        void ptRunNow(routine.id, runButton, row.querySelector("[data-pt-runs-for]"));
      });
      row.querySelector("[data-pt-history]")?.addEventListener("click", () => {
        const historyButton = row.querySelector("[data-pt-history]");
        void ptToggleHistory(routine.id, historyButton, row.querySelector("[data-pt-runs-for]"));
      });
      row.querySelector("[data-pt-del-routine]")?.addEventListener("click", () =>
        ptConfirmDeleteRoutine(partnerId, routine.id, routine.name || ""),
      );
    }
  } catch (error) {
    if (error.message === "forbidden") return;
    box.innerHTML = `<div class="set-hint is-error">读不到例行任务：${esc(error.message)}</div>`;
  }
}

async function ptToggleRoutine(id, sw) {
  const next = sw.getAttribute("aria-checked") !== "true";
  sw.disabled = true;
  try {
    const response = await request(`/api/v1/routines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: next }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { toast(`没切换：${data.message || data.error || response.status}`); return; }
    sw.setAttribute("aria-checked", String(next));
  } catch (error) {
    if (error.message !== "forbidden") toast(`没切换：${error.message}`);
  } finally {
    sw.disabled = false;
  }
}

async function ptRunNow(id, button, runsBox) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "跑中…";
  try {
    const response = await request(`/api/v1/routines/${encodeURIComponent(id)}/run_now`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      toast(`没跑成：${data.error || data.message || response.status}`);
    } else {
      toast("已跑完一轮");
      if (runsBox) await ptLoadRuns(id, runsBox, true);
    }
  } catch (error) {
    if (error.message !== "forbidden") toast(`没跑成：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function ptToggleHistory(id, button, runsBox) {
  if (!runsBox) return;
  if (!runsBox.hidden) {
    runsBox.hidden = true;
    button.textContent = "展开历史";
    return;
  }
  button.textContent = "收起";
  await ptLoadRuns(id, runsBox, true);
}

async function ptLoadRuns(id, box, show) {
  if (show) box.hidden = false;
  box.innerHTML = `<div class="set-hint">读取中…</div>`;
  try {
    const response = await request(`/api/v1/routines/${encodeURIComponent(id)}/runs`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(response.status));
    const runs = (data.runs || []).slice(0, 10);
    if (!runs.length) { box.innerHTML = `<div class="set-hint">还没有执行记录。</div>`; return; }
    box.innerHTML = runs
      .map((run) => {
        const info = PT_RUN_STATUS[run.status] || { text: run.status || "未知", cls: "" };
        const summary = String(run.summary || run.error || "").slice(0, 80);
        const at = run.endedAt || run.startedAt;
        const time = at ? new Date(at).toLocaleString("zh-CN") : "";
        return `<div class="pt-run">
          <span class="pill-tag ${info.cls}">${esc(info.text)}</span>
          <span class="pt-run-trigger">${esc(String(run.trigger || ""))}</span>
          <span class="pt-run-summary">${esc(summary)}</span>
          <span class="pt-run-time">${esc(time)}</span>
        </div>`;
      })
      .join("");
  } catch (error) {
    if (error.message === "forbidden") return;
    box.innerHTML = `<div class="set-hint is-error">读不到历史：${esc(error.message)}</div>`;
  }
}

function ptConfirmDeleteRoutine(partnerId, routineId, name) {
  // 单一 modal 宿主：确认弹层会替换编辑模态，答复后重新打开编辑模态（刷新一次详情）
  openModal("删除例行任务", (body) => {
    body.innerHTML = `
      <p class="modal-desc">确定删除「${esc(name)}」？在飞的任务会自动作废（没有取消 API，不残留）。</p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>取消</button>
        <button class="modal-danger" type="button" id="pt-del-go">删除</button>
      </div>`;
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", () => void openEditPartnerModal(partnerId));
    body.querySelector("#pt-del-go")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await request(`/api/v1/routines/${encodeURIComponent(routineId)}`, { method: "DELETE" });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          toast(`没删成：${data.message || data.error || response.status}`);
          button.disabled = false;
          return;
        }
        toast("已删除");
        void openEditPartnerModal(partnerId);
      } catch (error) {
        if (error.message === "forbidden") { closeModal(); return; }
        toast(`没删成：${error.message}`);
        button.disabled = false;
      }
    });
  });
}

/* ── 试跑（执事卡动作 #3）───────────────────────────── */

function openRunPartnerModal(partnerId, partnerName) {
  openModal(`试跑 · ${partnerName || "执事"}`, (body) => {
    body.innerHTML = `
      <p class="modal-desc">给这个执事发一句话，走完整链路跑一轮；faux 下会拿到假模型应答。</p>
      <div class="modal-field">
        <span>说一句</span>
        <input class="modal-input" id="pt-run-text" type="text" placeholder="例如：帮我记一句今天的事" />
      </div>
      <pre class="pt-result" id="pt-run-result" hidden></pre>
      <p class="modal-hint" id="pt-run-hint"></p>
      <div class="modal-actions">
        <button class="ghost" type="button" data-modal-cancel>关闭</button>
        <button class="modal-primary" id="pt-run-go" type="button">运行</button>
      </div>`;
    const textInput = body.querySelector("#pt-run-text");
    const result = body.querySelector("#pt-run-result");
    const hint = body.querySelector("#pt-run-hint");
    const go = body.querySelector("#pt-run-go");
    body.querySelector("[data-modal-cancel]")?.addEventListener("click", closeModal);
    const submit = async () => {
      if (go.disabled) return;
      const text = textInput.value.trim();
      if (!text) { setModalHint(hint, "先写一句话。"); return; }
      go.disabled = true; // 防重复点击
      result.hidden = true;
      setModalHint(hint, "跑中…", false);
      try {
        const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/run`, {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        const data = await response.json().catch(() => ({}));
        const shown = data.ok ? (data.text || "（没有正文）") : (data.error || data.text || "这一轮没跑完");
        result.textContent = shown;
        result.classList.toggle("is-error", !data.ok);
        result.hidden = false;
        setModalHint(hint, "", false);
      } catch (error) {
        if (error.message === "forbidden") { closeModal(); return; }
        setModalHint(hint, `没跑成：${error.message}`);
      } finally {
        go.disabled = false;
      }
    };
    go.addEventListener("click", () => void submit());
    textInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void submit(); }
    });
    textInput.addEventListener("input", () => clearModalHint(hint));
  });
}

/* ── 群组（2026-11-06 群组方案批二）────────────────────────
 * #/groups 列表 + #/group/:id 会话视图；时间线四形态 + @picker + 建群/群设置。
 * 数据面：GET /groups、GET /groups/:id/messages、POST /groups/:id/chat（SSE）、
 * POST /groups/:id/stop。发言顺序服务端定（@点名 > @所有人 > 值日），前端只渲染。
 * 端点未启用（404）= 按钮回占位态，一切入口保持禁用。 */

const groups = {
  available: null, // null = 还没探测过
  list: [],
  current: null, // 当前打开的群（含 members / 成员头像与领域）
  messages: [],
  lastSeq: 0,
  sending: false,
  streamSender: null, // 正在流式的那位（start 帧的 sender）
  streamBubble: null, // 正在流式的气泡 DOM
  streamText: "",
  picked: [], // 建群弹窗里勾中的成员 id（弹窗期间的状态）
  // 时间线渲染游标（2026-11-08 批三）：回读与实时追加共用，合并/日界都看它
  lastMeta: null, // { key, day, at }
  round: null, // 群详情投影的轮次状态 { running, speaker }
  pending: [], // 全局待审批（映射到本群成员用）
  pulseTimer: 0,
};

/** 探测群组可用性 + 侧栏「群组」节首帧。404 = 未启用，一切入口回占位。 */
async function initGroups() {
  try {
    const response = await request("/api/v1/groups", { cache: "no-store" });
    if (!response.ok) {
      groups.available = false;
    } else {
      const data = await response.json().catch(() => ({}));
      groups.available = true;
      groups.list = Array.isArray(data.groups) ? data.groups : [];
    }
  } catch {
    groups.available = false;
  }
  applyGroupsAvailability();
  renderGroupSidebar();
}

function applyGroupsAvailability() {
  const on = groups.available === true;
  // 侧栏「群组」分区（2026-11-07 统一批）：折叠头 + 行尾 ＋ 是两个独立按钮，
  // 旧的一体式 #side-group 已从 HTML 移除（折叠箭头随四改一并退役）。
  // 四个入口一起跟可用性走：轨道圆钮 / 分区名（进群组页）/ 行尾 ＋（建群）/
  // 分区底部的「所有群聊」（2026-11-07 新增，见下方注释）。
  //
  // 标题逐个给：以前一个循环把三颗按钮的 title 全写成「群组」，＋ 的「新建群组」
  // 被顺手冲掉，悬停提示跟着丢了语义。
  for (const [button, title] of [
    [el.railGroups, "群组"],
    [el.secGroupsToggle, "群组"],
    [el.secGroupsAdd, "新建群组"],
    [el.secGroupsAll, "查看全部群聊"],
  ]) {
    if (!button) continue;
    button.disabled = !on;
    button.title = on ? title : "群组未启用";
  }
  if (el.groupList) el.groupList.hidden = !on;
  if (el.groupCreate) el.groupCreate.hidden = !on;
  // 「所有群聊」这一行跟整节可用性走：群组没启用时它和折叠头一起灰掉，
  // 不留一条点进去必然空页的入口。
  if (el.secGroupsAll) el.secGroupsAll.hidden = !on;
}

/** 群成员头像：成员投影自带 avatar 就用它（2026-11-08 批三），老服务端回落到花名册缓存 */
function groupMemberAvatar(member) {
  if (!member) return null;
  return member.avatar || groupMemberAvatarOf(member.partnerId);
}

/**
 * 复合头像（2026-11-08 批三）：群不是一个人，头像就用成员头像拼。
 * 1 人直出（直接用其头像/首字）；2–4 人 2×2；>4 人取前 3 + 右下角 +N。
 * host 保留 .pt-avatar（圆形容器），.gavatar 只覆盖内部布局；不复用首字逻辑。
 */
function paintGroupAvatar(host, members) {
  if (!host) return;
  const all = (Array.isArray(members) ? members : []).filter(Boolean);
  host.replaceChildren();
  host.classList.remove("gavatar", "gavatar-n2", "gavatar-n3", "gavatar-n4");
  if (!all.length) {
    host.textContent = "群";
    return;
  }
  if (all.length === 1) {
    paintAvatar(host, groupMemberAvatar(all[0]), all[0].name);
    return;
  }
  const shown = all.length > 4 ? all.slice(0, 3) : all;
  const cells = shown.length + (all.length > 4 ? 1 : 0);
  host.textContent = "";
  host.classList.add("gavatar", `gavatar-n${cells}`);
  for (const member of shown) {
    const cell = document.createElement("span");
    cell.className = "gavatar-cell";
    paintAvatar(cell, groupMemberAvatar(member), member.name);
    cell.title = member.name || "";
    host.append(cell);
  }
  if (all.length > 4) {
    const more = document.createElement("span");
    more.className = "gavatar-cell gavatar-more";
    more.textContent = `+${all.length - 3}`;
    more.title = `共 ${all.length} 名成员`;
    host.append(more);
  }
}

/** 侧栏「群组」节：群名 + 成员数；点击进会话视图。 */
function renderGroupSidebar() {
  if (!el.groupList || groups.available !== true) return;
  el.groupList.replaceChildren();
  if (!groups.list.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = "还没有群组。点右边的 ＋ 新建。";
    el.groupList.append(empty);
    return;
  }
  for (const group of groups.list) {
    const row = document.createElement("div");
    row.className = "side-item group-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = `${group.name} · ${group.members.length} 名成员`;
    row.dataset.groupId = group.id;

    const avatar = document.createElement("span");
    avatar.className = "pt-avatar";
    avatar.setAttribute("aria-hidden", "true");
    paintGroupAvatar(avatar, group.members);

    const label = document.createElement("span");
    label.className = "roster-name";
    label.textContent = group.name;

    const count = document.createElement("span");
    count.className = "roster-idle";
    count.textContent = `${group.members.length}人`;

    row.append(avatar, label, count);
    const open = () => {
      location.hash = `#/group/${group.id}`;
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    el.groupList.append(row);
  }
}

/* ── 侧栏课题（2026-11-07 批二）──────────────────────────
   展开侧栏时拉 GET /topics；点开一行 = 时间线（GET /topics/:id 按需拉）。
   改节奏 / 暂停恢复 / 关闭成功后就地刷新，不整页重载。
   列表只放「在跟的」：closed 不进侧栏（方案 §六 的进行中课题列表）。 */
let topicsSidebarAvailable = null; // null=未查 / true / false（404 = 未启用）
let topicsSidebarList = [];
const expandedTopicIds = new Set();

const TOPIC_EMPTY_TEXT = "还没有在跟的课题。聊到值得长期跟进的问题，总管会提议。";

async function loadTopicsSidebar({ force = false } = {}) {
  if (!el.topicList) return;
  if (topicsSidebarAvailable === false && !force) return;
  try {
    const response = await request("/api/v1/topics", { cache: "no-store" });
    if (response.status === 404) {
      // TOPICS_ENABLED=false / 老服务端：整块入口退场（不留点进去必然空页的入口）
      topicsSidebarAvailable = false;
      topicsSidebarList = [];
      el.topicList.replaceChildren();
      const section = document.getElementById("sec-topics");
      if (section) section.hidden = true;
      if (el.railTopics) el.railTopics.hidden = true;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(response.status));
    topicsSidebarAvailable = true;
    const section = document.getElementById("sec-topics");
    if (section) section.hidden = false;
    if (el.railTopics) el.railTopics.hidden = false;
    topicsSidebarList = Array.isArray(data.topics) ? data.topics : [];
    renderTopicSidebar();
  } catch {
    // 网络抖动不藏功能：已有列表保留；空列表给一句可重试的话
    if (!topicsSidebarList.length && el.topicList) {
      el.topicList.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "roster-empty";
      empty.textContent = "课题读取失败，稍后再试。";
      el.topicList.append(empty);
    }
  }
}

function renderTopicSidebar() {
  if (!el.topicList) return;
  const ongoing = topicsSidebarList.filter((topic) => topic.status !== "closed");
  if (el.topicsBadge) {
    el.topicsBadge.hidden = ongoing.length === 0;
    el.topicsBadge.textContent = String(ongoing.length);
  }
  el.topicList.replaceChildren();
  if (!ongoing.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = TOPIC_EMPTY_TEXT;
    el.topicList.append(empty);
    return;
  }
  for (const topic of ongoing) el.topicList.append(buildTopicRow(topic));
}

function buildTopicRow(topic) {
  const wrap = document.createElement("div");
  wrap.className = "topic-item";
  wrap.dataset.topicId = topic.id;

  const row = document.createElement("button");
  row.type = "button";
  row.className = "side-item topic-row";
  row.title = topic.question;
  const expanded = expandedTopicIds.has(topic.id);
  row.setAttribute("aria-expanded", String(expanded));

  const name = document.createElement("span");
  name.className = "roster-name";
  name.textContent = topic.question;

  const flavor = document.createElement("span");
  flavor.className = "pill-tag topic-flavor";
  flavor.dataset.flavor = topic.flavor;
  flavor.textContent = topic.flavor === "dig" ? "啃题" : "盯梢";

  row.append(name, flavor);

  if (topic.status === "paused") {
    const paused = document.createElement("span");
    paused.className = "topic-paused";
    paused.textContent = "已暂停";
    row.append(paused);
  } else if (topic.nextFireAt) {
    const next = document.createElement("span");
    next.className = "roster-idle topic-next";
    next.textContent = topic.nextFireLabel || shortDateTime(topic.nextFireAt);
    next.title = `下次研究：${topic.nextFireLabel || topic.nextFireAt}`;
    row.append(next);
  }

  const detail = document.createElement("div");
  detail.className = "topic-detail";
  detail.hidden = !expanded;

  row.addEventListener("click", () => {
    const open = detail.hidden;
    if (open) {
      expandedTopicIds.add(topic.id);
      detail.hidden = false;
      row.setAttribute("aria-expanded", "true");
      void refreshTopicDetail(topic, detail);
    } else {
      expandedTopicIds.delete(topic.id);
      detail.hidden = true;
      row.setAttribute("aria-expanded", "false");
    }
  });

  wrap.append(row, detail);
  if (expanded) void refreshTopicDetail(topic, detail);
  return wrap;
}

async function refreshTopicDetail(topic, detail) {
  detail.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "topic-detail-hint";
  loading.textContent = "读取中…";
  detail.append(loading);

  let full = null;
  try {
    const response = await request(`/api/v1/topics/${encodeURIComponent(topic.id)}`, {
      cache: "no-store",
    });
    if (response.ok) {
      const payload = await response.json();
      full = payload.topic || null;
    }
  } catch {
    /* 下面统一给一句可重试的提示 */
  }
  if (!full) {
    detail.replaceChildren();
    const fail = document.createElement("p");
    fail.className = "topic-detail-hint";
    fail.textContent = "课题详情读取失败，稍后再试。";
    detail.append(fail);
    return;
  }
  renderTopicDetail(full, detail);
}

/** `0 9 * * 1` → { weekday: 1, hour: 9 }；不是周节奏就返回 null（下拉退回默认值）。 */
function parseWeeklyCron(cron) {
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (minute !== "0" || dayOfMonth !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(hour) || !/^[0-7]$/.test(dayOfWeek)) return null;
  const hh = Number(hour);
  if (hh > 23) return null;
  return { weekday: Number(dayOfWeek) % 7, hour: hh };
}

function renderTopicDetail(topic, detail) {
  detail.replaceChildren();

  const head = document.createElement("div");
  head.className = "topic-detail-head";

  // 改节奏：每周几 + 时段（整点）两个下拉，拼成 `0 H * * D`
  const parsed = parseWeeklyCron(topic.cron);
  const weekday = document.createElement("select");
  weekday.className = "topic-select";
  weekday.setAttribute("aria-label", "每周几");
  for (const [value, label] of [
    [1, "周一"], [2, "周二"], [3, "周三"], [4, "周四"], [5, "周五"], [6, "周六"], [0, "周日"],
  ]) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    weekday.append(option);
  }
  weekday.value = String(parsed ? parsed.weekday : 1);

  const hour = document.createElement("select");
  hour.className = "topic-select";
  hour.setAttribute("aria-label", "时段");
  for (let hh = 0; hh < 24; hh += 1) {
    const option = document.createElement("option");
    option.value = String(hh);
    option.textContent = `${String(hh).padStart(2, "0")}:00`;
    hour.append(option);
  }
  hour.value = String(parsed ? parsed.hour : 9);

  const schedule = document.createElement("div");
  schedule.className = "topic-schedule";
  const weekPrefix = document.createElement("span");
  weekPrefix.textContent = "每周";
  schedule.append(weekPrefix, weekday, hour);

  const state = document.createElement("span");
  state.className = "topic-detail-state";
  state.dataset.state = topic.status === "paused" ? "paused" : "active";
  state.textContent = topic.status === "paused" ? "已暂停" : "进行中";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ghost topic-act";
  toggle.textContent = topic.status === "paused" ? "恢复" : "暂停";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ghost is-danger topic-act";
  close.textContent = "关闭";

  head.append(schedule, state, toggle, close);
  detail.append(head);

  const hint = document.createElement("p");
  hint.className = "topic-detail-hint";
  detail.append(hint);

  const setHint = (text, isError = false) => {
    hint.textContent = text || "";
    hint.classList.toggle("is-error", Boolean(isError) && Boolean(text));
  };

  const reload = async () => {
    await loadTopicsSidebar({ force: true });
  };

  const patch = async (body, okText) => {
    weekday.disabled = true;
    hour.disabled = true;
    toggle.disabled = true;
    close.disabled = true;
    setHint("保存中…");
    try {
      const response = await request(`/api/v1/topics/${encodeURIComponent(topic.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setHint(payload.message || "没有保存成功，稍后再试。", true);
        return false;
      }
      // 成功后整个侧栏会重绘（保留展开态），行内那句会跟着旧节点消失——用 toast 留个回执
      toast(okText);
      await reload();
      return true;
    } catch {
      setHint("请求没发出去，检查服务是否在跑。", true);
      return false;
    } finally {
      weekday.disabled = false;
      hour.disabled = false;
      toggle.disabled = false;
      close.disabled = false;
    }
  };

  const commitCron = () => {
    const cron = `0 ${Number(hour.value)} * * ${Number(weekday.value)}`;
    if (cron === topic.cron) return;
    void patch({ cron }, "节奏已改。");
  };
  weekday.addEventListener("change", commitCron);
  hour.addEventListener("change", commitCron);

  toggle.addEventListener("click", () => {
    void patch(
      { status: topic.status === "paused" ? "active" : "paused" },
      topic.status === "paused" ? "已恢复。" : "已暂停。",
    );
  });

  // 关闭：先点一次变成确认态，再点一次才发请求（行内确认，不弹窗）
  let armed = false;
  let armTimer = 0;
  close.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      close.textContent = "确认关闭？";
      setHint("再点一次就关掉；研究记录会留着。");
      armTimer = setTimeout(() => {
        armed = false;
        close.textContent = "关闭";
        setHint("");
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    close.disabled = true;
    setHint("关闭中…");
    try {
      const response = await request(`/api/v1/topics/${encodeURIComponent(topic.id)}/close`, {
        method: "POST",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setHint(payload.message || "关闭失败，稍后再试。", true);
        close.disabled = false;
        return;
      }
      expandedTopicIds.delete(topic.id);
      await reload();
    } catch {
      setHint("请求没发出去，检查服务是否在跑。", true);
      close.disabled = false;
    }
  });

  const timeline = document.createElement("div");
  timeline.className = "topic-timeline";
  if (!Array.isArray(topic.findings) || topic.findings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "topic-detail-hint";
    empty.textContent = "还没有研究记录，到点后会在这里出现。";
    timeline.append(empty);
  } else {
    for (const finding of topic.findings) timeline.append(buildTopicFinding(finding));
  }
  detail.append(timeline);
}

function findingCompare(body) {
  const lines = String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((item) => /^相比上次[:：]/.test(item));
  return line ? line.replace(/^相比上次[:：]\s*/, "") : "";
}

function buildTopicFinding(finding) {
  const wrap = document.createElement("div");
  wrap.className = "topic-finding";

  const head = document.createElement("div");
  head.className = "topic-finding-head";
  const date = document.createElement("span");
  date.className = "topic-finding-date";
  date.textContent = finding.date || "";
  head.append(date);
  if (finding.noNew) {
    const pill = document.createElement("span");
    pill.className = "pill-tag topic-no-new";
    pill.textContent = "无新进展";
    head.append(pill);
  }
  wrap.append(head);

  const summary = document.createElement("div");
  summary.className = "topic-finding-summary";
  summary.textContent = finding.summary || "（本轮没有摘要）";
  wrap.append(summary);

  const compareText = findingCompare(finding.body);
  if (compareText) {
    const compare = document.createElement("div");
    compare.className = "topic-finding-compare";
    compare.textContent = `相比上次：${compareText}`;
    wrap.append(compare);
  }

  if (finding.body) {
    const details = document.createElement("details");
    details.className = "topic-finding-body";
    const label = document.createElement("summary");
    label.textContent = "正文";
    const pre = document.createElement("pre");
    pre.textContent = finding.body;
    details.append(label, pre);
    wrap.append(details);
  }
  return wrap;
}


/** 群组路由入口：#/groups 列表态，#/group/:id 会话态。 */
async function openGroupsView() {
  if (groups.available === null) await initGroups();
  closeGroupAtPop();
  const id = groupRouteId();
  if (!id) {
    el.groupsTitleText.textContent = "群组";
    el.groupsTitleSub.textContent = "";
    el.groupSettingsBtn.hidden = true;
    el.groupCreate.hidden = groups.available !== true;
    el.groupChat.hidden = true;
    el.groupsBody.hidden = false;
    if (el.groupHeadAvatar) el.groupHeadAvatar.hidden = true;
    // 列表态没有"谁在忙"可看：停掉轮询，别在后台空转
    stopGroupPulse();
    if (el.groupPulse) {
      el.groupPulse.replaceChildren();
      el.groupPulse.hidden = true;
    }
    await renderGroupsListPage();
    return;
  }
  el.groupCreate.hidden = true;
  el.groupsBody.hidden = true;
  el.groupChat.hidden = false;
  await openGroupChat(id);
}

async function renderGroupsListPage() {
  if (groups.available !== true) {
    el.groupsBody.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.textContent = "群组未启用（GROUPS_ENABLED / COMPANIONS_ENABLED）。";
    el.groupsBody.append(empty);
    return;
  }
  // 现拉一次：建群/删群回来列表要新
  const response = await request("/api/v1/groups", { cache: "no-store" }).catch(() => null);
  if (response?.ok) {
    const data = await response.json().catch(() => ({}));
    groups.list = Array.isArray(data.groups) ? data.groups : [];
    renderGroupSidebar();
  }

  el.groupsBody.replaceChildren();
  if (!groups.list.length) {
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.innerHTML = [
      "<h2>还没有群组</h2>",
      // 措辞与建群弹窗同一套（那里也说"成员"）：群里的可以是指挥官，也可以是执事
      "<p>把 2–6 位成员拉进同一条会话：@名字 点名谁回，不 @ 就发给值日。</p>",
    ].join("");
    el.groupsBody.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "group-list";
  for (const group of groups.list) {
    // 一行一群（2026-11-07）：原来是自适应网格卡片，1–2 个群时被撑成一大块孤卡。
    const row = document.createElement("button");
    row.type = "button";
    row.className = "group-item";
    row.dataset.groupId = group.id;

    const avatar = document.createElement("span");
    avatar.className = "pt-avatar group-item-avatar";
    avatar.setAttribute("aria-hidden", "true");
    paintGroupAvatar(avatar, group.members);

    const main = document.createElement("span");
    main.className = "group-item-main";
    const name = document.createElement("span");
    name.className = "group-item-name";
    name.textContent = group.name;
    const sub = document.createElement("span");
    sub.className = "group-item-sub";
    const duty = group.members.find((m) => m.partnerId === group.responderPartnerId);
    const who = group.members.map((m) => m.name).join("、");
    // 口径直接复用设置抽屉的 gsResponderShort（值日 阅读助手 / 全员都回 / 只回点名）：
    // 同一个概念在两处出现，就不该有两套措辞——原来这里拼「不 @ 阅读助手 回」，
    // 断句会读成"不要 @ 阅读助手"，而设置页写的是「值日 阅读助手」。
    sub.textContent = `${who} · ${gsResponderShort(group)}`;
    main.append(name, sub);

    const count = document.createElement("span");
    count.className = "group-item-count";
    count.textContent = `${group.members.length} 人`;

    const chevron = document.createElement("span");
    chevron.className = "group-item-chevron";
    chevron.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

    row.append(avatar, main, count, chevron);
    row.addEventListener("click", () => {
      location.hash = `#/group/${group.id}`;
    });
    list.append(row);
  }
  el.groupsBody.append(list);
}

/** 打开群会话视图：群资料 + 时间线，composer 就绪。 */
async function openGroupChat(groupId) {
  const response = await request(`/api/v1/groups/${encodeURIComponent(groupId)}`, { cache: "no-store" }).catch(() => null);
  if (!response || !response.ok) {
    toast("这个群不存在或已被删除");
    location.hash = "#/groups";
    return;
  }
  const data = await response.json().catch(() => ({}));
  groups.current = data.group ?? null;
  groups.messages = [];
  groups.streamSender = null;
  groups.streamBubble = null;

  if (!groups.current) {
    toast("这个群不存在或已被删除");
    location.hash = "#/groups";
    return;
  }
  el.groupsTitleText.textContent = groups.current.name;
  // 会话头复合头像（2026-11-08 批三）：列表态没有它，进群才画
  if (el.groupHeadAvatar) {
    el.groupHeadAvatar.hidden = false;
    paintGroupAvatar(el.groupHeadAvatar, groups.current.members);
  }
  const duty = groups.current.members.find((m) => m.partnerId === groups.current.responderPartnerId);
  el.groupsTitleSub.textContent = duty
    ? ` · 值日 ${duty.name}`
    : groups.current.responderKind === "everyone"
      ? " · 不 @ 全员回"
      : groups.current.responderKind === "mentions"
        ? " · 只回点名"
        : "";
  el.groupSettingsBtn.hidden = false;
  el.groupNotice.hidden = !groups.current.notice?.trim();
  el.groupNotice.textContent = groups.current.notice?.trim() ? `公告：${groups.current.notice.trim()}` : "";
  renderGroupMembersBar();

  el.groupThread.replaceChildren();
  const msgResponse = await request(`/api/v1/groups/${encodeURIComponent(groupId)}/messages?limit=200`, { cache: "no-store" }).catch(() => null);
  if (msgResponse?.ok) {
    const msgData = await msgResponse.json().catch(() => ({}));
    groups.messages = Array.isArray(msgData.messages) ? msgData.messages : [];
    groups.lastSeq = Number(msgData.lastSeq ?? 0);
    renderGroupTimeline();
  }
  el.groupInput.value = "";
  resizeGroupInput();
  // 状态胶囊（2026-11-08 批三）：先按详情里的轮次状态画一帧，再开轮询
  groups.round = groups.current.round ?? null;
  groups.pending = [];
  updateGroupSendState();
  renderGroupPulse();
  startGroupPulse();
  el.groupInput.focus();
}

/* ── 状态胶囊（2026-11-08 批三）：谁在忙 / 谁等审批 ────────
 * 数据全部来自既有端点：群详情（round）+ 全局待审批（conversationId 映射到成员）。
 * 轮询节奏跟群会话对齐（5s）——只有群会话打开时跑，离开就停。
 * 映射不来的一律不画：查不到成员/群的审批不写进胶囊，不拿名字猜。 */

const GROUP_PULSE_MS = 5000;

function startGroupPulse() {
  stopGroupPulse();
  groups.pulseTimer = setInterval(() => void refreshGroupPulse(), GROUP_PULSE_MS);
}

function stopGroupPulse() {
  if (!groups.pulseTimer) return;
  clearInterval(groups.pulseTimer);
  groups.pulseTimer = 0;
}

async function refreshGroupPulse() {
  const group = groups.current;
  const id = groupRouteId();
  if (!group || currentRoute() !== "group" || id !== group.id) {
    stopGroupPulse();
    return;
  }
  const [detail, pending] = await Promise.all([
    request(`/api/v1/groups/${encodeURIComponent(group.id)}`, { cache: "no-store" }).catch(() => null),
    request("/api/v1/agent/approvals", { cache: "no-store" }).catch(() => null),
  ]);
  // 请求期间切了群 / 离开了群路由：旧响应不许画到新群上
  if (!groups.current || groups.current.id !== group.id || groupRouteId() !== group.id) return;
  if (detail?.ok) {
    const data = await detail.json().catch(() => ({}));
    if (data.group) groups.round = data.group.round ?? null;
  }
  if (pending) {
    if (pending.ok) {
      const data = await pending.json().catch(() => ({}));
      if (Array.isArray(data.approvals)) groups.pending = data.approvals;
    } else {
      // 服务端明确拒绝（503 未配置模型 / 403）：待批清单不可信，宁可空着也不留旧的
      groups.pending = [];
    }
  }
  renderGroupPulse();
}

/** 本群成员里有哪些人挂着待批（按会话 id 反查；不是本群的一律忽略） */
function groupPendingMembers() {
  const group = groups.current;
  if (!group) return [];
  const waiting = new Set();
  for (const item of groups.pending) {
    const ref = parseGroupMemberConversation(item?.conversationId);
    if (ref && ref.groupId === group.id) waiting.add(ref.partnerId);
  }
  return group.members.filter((member) => waiting.has(member.partnerId));
}

function renderGroupPulse() {
  if (!el.groupPulse) return;
  const group = groups.current;
  if (!group) {
    el.groupPulse.hidden = true;
    el.groupPulse.replaceChildren();
    return;
  }
  const chips = [];
  const round = groups.round;
  if (round?.running) {
    chips.push({
      kind: "busy",
      text: round.speaker?.name ? `${round.speaker.name} 正在发言` : "群轮进行中",
      title: "这一轮还没跑完，发消息会被拒（可点停止）",
    });
  } else if (groups.sending) {
    chips.push({
      kind: "busy",
      text: groups.streamSender?.name ? `${groups.streamSender.name} 正在发言` : "正在回话",
      title: "这一轮还没跑完",
    });
  }
  for (const member of groupPendingMembers()) {
    chips.push({
      kind: "wait",
      text: `${member.name} 等审批`,
      title: `${member.name} 有个写操作在等确认（去设置 → 权限，或等这轮超时）`,
    });
  }
  el.groupPulse.replaceChildren();
  if (!chips.length) {
    el.groupPulse.hidden = true;
    return;
  }
  for (const chip of chips) {
    const node = document.createElement("span");
    node.className = `group-pulse-chip is-${chip.kind}`;
    node.textContent = chip.text;
    if (chip.title) node.title = chip.title;
    el.groupPulse.append(node);
  }
  el.groupPulse.hidden = false;
}

/* ── 时间线渲染：四形态 ──────────────────────────────────
 * 主人右对齐气泡 / 成员左对齐（头像+名字+时间）/ 系统行居中发丝线 /
 * 5 分钟内同作者合并（名字行只画一次）+ 跨天分割线。 */

const GROUP_MERGE_MS = 5 * 60 * 1000;
/** 成员数上下限：与 shared 的 GROUP_MEMBER_MIN/MAX 同值（web 端无构建，不 import 包） */
const GROUP_MEMBER_MIN = 2;
const GROUP_MEMBER_MAX = 6;


function renderGroupTimeline() {
  el.groupThread.replaceChildren();
  groups.lastMeta = null;
  for (const message of groups.messages) appendGroupMessageToThread(message);
  scrollGroupThread();
}

function groupAuthorKey(message) {
  return message.kind === "system" ? `system:${message.id}` : `${message.authorKind}:${message.authorId ?? message.authorName}`;
}

function groupDayOf(message) {
  // 跨天分割按**本地**日历日算：at 是 ISO UTC 串，直接 slice(0,10) 在凌晨时段会标错天（实测踩过）
  const value = Date.parse(message.at || "");
  if (!Number.isFinite(value)) return String(message.at || "").slice(0, 10);
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 日期分割的可读标签（2026-11-08 批三）：今天 / 昨天 / M月D日（跨年才带年份） */
function groupDayLabel(day) {
  const [year, month, date] = String(day || "").split("-").map(Number);
  if (!year || !month || !date) return String(day || "");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(year, month - 1, date);
  const diffDays = Math.round((today - that) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  return year === now.getFullYear() ? `${month}月${date}日` : `${year}年${month}月${date}日`;
}

/** 一条消息的渲染元信息（合并 / 日界判据）：回读与实时追加共用同一份 */
function groupMetaOf(message) {
  return {
    key: groupAuthorKey(message),
    day: groupDayOf(message),
    at: Date.parse(message.at || "") || 0,
  };
}

function appendGroupDayDivider(day) {
  const divider = document.createElement("div");
  divider.className = "group-day";
  divider.textContent = groupDayLabel(day);
  divider.title = day;
  el.groupThread.append(divider);
}

/**
 * 追加一条消息（回读与实时追加同一条路）。
 * 合并条件：同作者 + 中间没有别人 + 同一天 + 间隔 <5 分钟；跨天绝不合并（否则会跨过日界）。
 * 每条消息渲染后把游标写回 groups.lastMeta，两条路径行为一致。
 */
function appendGroupMessageToThread(message) {
  const meta = groupMetaOf(message);
  const lastRendered = groups.lastMeta;
  if (!lastRendered || lastRendered.day !== meta.day) appendGroupDayDivider(meta.day);
  const merge =
    Boolean(lastRendered) &&
    lastRendered.key === meta.key &&
    lastRendered.day === meta.day &&
    message.kind === "message" &&
    meta.at - (lastRendered.at || 0) < GROUP_MERGE_MS;

  if (message.kind === "system") {
    const line = document.createElement("div");
    line.className = "group-sys";
    line.textContent = message.content;
    el.groupThread.append(line);
    groups.lastMeta = meta;
    return;
  }

  const mine = message.authorKind === "user";
  const bubble = document.createElement("div");
  bubble.className = `gmsg ${mine ? "me" : "them"}${merge ? " merged" : ""}`;
  bubble.dataset.msgId = message.id;
  bubble.dataset.authorName = mine ? "主人" : message.authorName || "";

  if (!mine) {
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar gmsg-avatar";
    paintAvatar(avatar, groupMemberAvatarOf(message.authorId), message.authorName || "");
    bubble.append(avatar);
  }
  const stack = document.createElement("div");
  stack.className = "gmsg-stack";
  if (!merge) {
    const head = document.createElement("div");
    head.className = "gmsg-head";
    const who = document.createElement("span");
    who.className = "gmsg-who";
    who.textContent = mine ? "主人" : message.authorName || "执事";
    const when = document.createElement("span");
    when.className = "gmsg-at";
    when.textContent = formatGroupTime(message.at);
    head.append(who, when);
    stack.append(head);
  }
  const body = document.createElement("div");
  body.className = "gmsg-body";
  paintMentionText(body, message.content);
  stack.append(body);
  bubble.append(stack);
  el.groupThread.append(bubble);
  groups.lastMeta = meta;
}

/** 群成员头像（按 partnerId 从花名册取；外侧缓存由 state.partners 负责） */
function groupMemberAvatarOf(partnerId) {
  if (!partnerId) return null;
  return state.partners.find((item) => item.id === partnerId)?.avatar || null;
}

/**
 * 正文里的 @点名 上色（2026-11-07；2026-11-08 批三补长标签）。纯文本发送、发送时服务端
 * 重解析的口径不变，这里只做**显示**：把命中成员名的那段包一层 <span>，不改变 textContent。
 * 长标签 `@名字·domain` 整体上色；`@名字·打错的域` 不是点名，按普通文本留白（与服务端同判据）。
 * 用 DOM 拼节点而不是 innerHTML —— 正文是用户/模型产出，绝不拼 HTML。
 */
function paintMentionText(host, text) {
  const source = String(text ?? "");
  const members = groups.current?.members ?? [];
  if (!members.length || !source.includes("@")) {
    host.textContent = source;
    return;
  }
  // 长标签优先：`小双·math` 排在 `小双` 前，避免只染半截
  const labels = [];
  for (const member of members) {
    if (!member.name) continue;
    if (member.domain) labels.push(`${member.name}·${member.domain}`);
    labels.push(member.name);
  }
  labels.sort((a, b) => b.length - a.length);
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf("@", cursor);
    if (at === -1) break;
    const prev = at > 0 ? source[at - 1] : "";
    if (/[A-Za-z0-9_@]/.test(prev)) {
      // 邮箱/路径里的 @ 不是点名：原样吞掉这个字符继续扫
      fragment.append(document.createTextNode(source.slice(cursor, at + 1)));
      cursor = at + 1;
      continue;
    }
    const hit = labels.find((label) => source.startsWith(label, at + 1));
    // 短名后面跟着 `·域` 但整体没命中长标签 = 打错的域：不是点名，整段留白
    const looksLong = hit && !hit.includes("·") && source[at + 1 + hit.length] === "·";
    if (!hit || looksLong) {
      fragment.append(document.createTextNode(source.slice(cursor, at + 1)));
      cursor = at + 1;
      continue;
    }
    fragment.append(document.createTextNode(source.slice(cursor, at)));
    const mark = document.createElement("span");
    mark.className = "gmsg-mention";
    mark.textContent = `@${hit}`;
    fragment.append(mark);
    cursor = at + 1 + hit.length;
  }
  if (cursor < source.length) fragment.append(document.createTextNode(source.slice(cursor)));
  host.replaceChildren(fragment);
}

/**
 * 群成员条（2026-11-07）：头像 + 名字 + 值日标记。
 * 点 = 把 @名字 插进输入框（补全 @ 的发现性）；右键 = 同一个操作菜单（@他 / 复制名字）。
 */
function renderGroupMembersBar() {
  if (!el.groupMembers) return;
  el.groupMembers.replaceChildren();
  const group = groups.current;
  if (!group) {
    el.groupMembers.hidden = true;
    return;
  }
  el.groupMembers.hidden = false;
  for (const member of group.members) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "group-member";
    chip.dataset.memberId = member.partnerId;
    const isDuty = member.partnerId === group.responderPartnerId && group.responderKind === "member";
    chip.title = isDuty ? `${member.name} · 值日执事（不 @ 时他回）` : `${member.name} · 点一下 @ 他`;
    chip.setAttribute("aria-label", chip.title);

    const avatar = document.createElement("span");
    avatar.className = "pt-avatar group-member-avatar";
    paintAvatar(avatar, groupMemberAvatar(member), member.name);
    const name = document.createElement("span");
    name.className = "group-member-name";
    name.textContent = member.name;
    chip.append(avatar, name);
    if (isDuty) {
      const duty = document.createElement("span");
      duty.className = "group-member-duty";
      duty.textContent = "值日";
      chip.append(duty);
    }
    if (member.status && member.status !== "active") {
      chip.classList.add("is-off");
      chip.title = `${member.name} · 当前不在服务（发言会被跳过）`;
    }

    chip.addEventListener("click", () => insertGroupMention(member));
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openGroupMemberMenu(event, member, isDuty);
    });
    el.groupMembers.append(chip);
  }
}

/**
 * 把 @名字 插到光标处（不留双空格；已有 @ 就只补名字）。
 * 带 domain 的成员插**长标签** `@名字·domain`（2026-11-08 批三）：
 * 重名时短名会被后端 400 拒绝，长标签是那个唯一能写对的表达形式。
 */
function insertGroupMention(member) {
  if (!el.groupInput) return;
  const name = typeof member === "string" ? member : member?.name;
  const domain = typeof member === "string" ? "" : member?.domain || "";
  if (!name) return;
  const tag = domain ? `${name}·${domain}` : name;
  const value = el.groupInput.value;
  const caret = el.groupInput.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  // 光标前已有 @（含半截名字 / 半截长标签）就替换掉这段，接上选中的成员
  const partial = /(^|\s)@([^\s@]*)$/.exec(before);
  const head = partial ? before.slice(0, caret - partial[2].length - 1) : before;
  const pad = head && !head.endsWith(" ") ? " " : "";
  const insert = `${pad}@${tag} `;
  el.groupInput.value = head + insert + after;
  const next = head.length + insert.length;
  el.groupInput.setSelectionRange(next, next);
  el.groupInput.focus();
  resizeGroupInput();
  updateGroupSendState();
  clearGroupAtHint();
}

/**
 * 成员右键菜单（2026-11-07）：右键在群成员上不是「浏览器菜单」，而是这个人的操作清单。
 *
 * 为什么要它：@ 是纯文本，用户不知道有哪些人可以点、也不知道点谁会发生什么。
 * 菜单里给出「@ 他」与「复制名字」两条，`@所有人` 另给一条广播项并明示它会叫醒全员。
 * 几何照 .proj-pop（fixed 定位、贴边翻转、点外关闭、Esc 关闭），不引入新交互范式。
 */
const groupMemberMenu = { node: null, anchor: null };

function closeGroupMemberMenu() {
  if (!groupMemberMenu.node) return;
  groupMemberMenu.node.remove();
  groupMemberMenu.node = null;
  groupMemberMenu.anchor = null;
}

function openGroupMemberMenu(event, member, isDuty) {
  closeGroupMemberMenu();
  if (!groups.current) return;
  const menu = document.createElement("div");
  menu.className = "gmenu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `${member.name} 的操作`);

  const header = document.createElement("div");
  header.className = "gmenu-head";
  const headerAvatar = document.createElement("span");
  headerAvatar.className = "pt-avatar gmenu-avatar";
  paintAvatar(headerAvatar, groupMemberAvatar(member), member.name);
  const headerMain = document.createElement("div");
  headerMain.className = "gmenu-head-main";
  const headerName = document.createElement("div");
  headerName.className = "gmenu-head-name";
  headerName.textContent = member.name;
  const headerSub = document.createElement("div");
  headerSub.className = "gmenu-head-sub";
  headerSub.textContent = isDuty ? "值日执事 · 不 @ 时由他回" : "群成员";
  headerMain.append(headerName, headerSub);
  header.append(headerAvatar, headerMain);
  menu.append(header);

  const item = (label, hint, run, { danger = false } = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gmenu-item${danger ? " is-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    const main = document.createElement("span");
    main.className = "gmenu-item-label";
    main.textContent = label;
    button.append(main);
    if (hint) {
      const sub = document.createElement("span");
      sub.className = "gmenu-item-hint";
      sub.textContent = hint;
      button.append(sub);
    }
    button.addEventListener("click", () => {
      closeGroupMemberMenu();
      run();
    });
    menu.append(button);
  };

  const mentionTag = member.domain ? `${member.name}·${member.domain}` : member.name;
  item("＠ 他", `插入 @${mentionTag} 到输入框`, () => insertGroupMention(member));
  item("复制名字", member.name, () => {
    navigator.clipboard
      ?.writeText(member.name)
      .then(() => toast(`已复制「${member.name}」`))
      .catch(() => toast("复制失败"));
  });
  item("＠ 所有人", "叫醒全员，按成员顺序逐个回（最贵）", () => insertGroupBroadcastMention());

  document.body.append(menu);
  // 定位：贴光标，越界往回翻（同 .proj-pop 的口径：先右后翻）
  const rect = menu.getBoundingClientRect();
  const gap = 6;
  let left = event.clientX;
  let top = event.clientY;
  if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - rect.width);
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, event.clientY - rect.height);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  groupMemberMenu.node = menu;
  groupMemberMenu.anchor = event.currentTarget;
  menu.querySelector(".gmenu-item")?.focus();
}

/** 右键菜单里的广播项：@所有人 不是成员，所以单独给一条并写清代价 */
function insertGroupBroadcastMention() {
  if (!el.groupInput) return;
  const value = el.groupInput.value;
  const caret = el.groupInput.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const partial = /(^|\s)@([^\s@]*)$/.exec(before);
  const head = partial ? before.slice(0, caret - partial[2].length - 1) : before;
  const pad = head && !head.endsWith(" ") ? " " : "";
  const insert = `${pad}@所有人 `;
  el.groupInput.value = head + insert + value.slice(caret);
  const next = head.length + insert.length;
  el.groupInput.setSelectionRange(next, next);
  el.groupInput.focus();
  resizeGroupInput();
  updateGroupSendState();
}

document.addEventListener("pointerdown", (event) => {
  if (!groupMemberMenu.node) return;
  if (groupMemberMenu.node.contains(event.target)) return;
  closeGroupMemberMenu();
});
document.addEventListener("keydown", (event) => {
  if (!groupMemberMenu.node) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeGroupMemberMenu();
    groupMemberMenu.anchor?.focus?.();
  }
});
window.addEventListener("resize", closeGroupMemberMenu);

function formatGroupTime(at) {
  const value = Date.parse(at || "");
  if (!Number.isFinite(value)) return "";
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ── 群 composer：发送（SSE 回合）─────────────────────── */

/**
 * 输入框按内容长高。
 *
 * 2026-11-07 修：原来用 `height:auto` → 读 `scrollHeight`，但 textarea 是
 * `flex:1` 的子项、父级 `.group-composer` 又是 `align-items:flex-end` 的 flex，
 * 量出来的 scrollHeight 会跟随被拉伸后的盒子（实测恒为 max-height 160），
 * 结果明明只有一行也撑成 160px 的大白框。
 * 改成先把 height 归零再量（content 决定 scrollHeight），并给 min-height 兜底。
 */
function resizeGroupInput() {
  if (!el.groupInput) return;
  el.groupInput.style.height = "0px";
  const next = Math.min(Math.max(el.groupInput.scrollHeight, 30), 160);
  el.groupInput.style.height = `${next}px`;
}

function updateGroupSendState() {
  if (!el.groupInput || !el.groupSend) return;
  el.groupSend.disabled = groups.sending || !el.groupInput.value.trim();
  el.groupStop.hidden = !groups.sending;
  el.groupSend.hidden = groups.sending;
  // 发/停的瞬间胶囊要跟上（轮询 5s，别让"正在发言"晚一拍）
  renderGroupPulse();
}

async function sendGroupMessage() {
  const text = el.groupInput.value.trim();
  if (!text || groups.sending || !groups.current) return;
  el.groupInput.value = "";
  resizeGroupInput();
  closeGroupAtPop();

  // 乐观落自己的气泡（主人右对齐）；回读时会以服务端为准再刷一遍
  const localMessage = {
    id: `local-${Date.now()}`,
    groupId: groups.current.id,
    seq: groups.lastSeq + 1,
    kind: "message",
    authorKind: "user",
    authorId: null,
    authorName: "主人",
    content: text,
    at: new Date().toISOString(),
  };
  groups.messages.push(localMessage);
  appendGroupMessageToThread(localMessage);
  groups.lastSeq = localMessage.seq;
  scrollGroupThread();

  groups.sending = true;
  updateGroupSendState();

  try {
    const response = await request(`/api/v1/groups/${encodeURIComponent(groups.current.id)}/chat`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (response.status === 409) {
      toast("这个群上一轮还在跑，等它说完（或点停止）");
      rollbackLocalMessage(localMessage.id, text);
      return;
    }
    if (response.status === 400) {
      const data = await response.json().catch(() => ({}));
      toast(data.message || "发不出去");
      // 重名歧义：后端把候选（名字 + 领域）带回来，这里给一条可点的长标签提示条
      showGroupAtHint(data.candidates);
      rollbackLocalMessage(localMessage.id, text);
      return;
    }
    if (!response.ok || !response.body) {
      toast(`请求失败：HTTP ${response.status}`);
      rollbackLocalMessage(localMessage.id, text);
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          handleGroupStreamEvent(event);
        }
      }
    }
    // 流收尾：以服务端时间线为准对齐一遍（拿到各成员终稿的 seq/at）
    await refreshGroupTimeline();
  } catch {
    toast("连接断了，稍后重试");
  } finally {
    groups.sending = false;
    groups.streamSender = null;
    groups.streamBubble = null;
    updateGroupSendState();
    void refreshGroupSidebarQuiet();
  }
}

function rollbackLocalMessage(localId, text) {
  groups.messages = groups.messages.filter((m) => m.id !== localId);
  const bubble = el.groupThread.querySelector(`[data-msg-id="${localId}"]`);
  bubble?.remove();
  // 渲染游标跟着回退：下一条追加仍按真实最后一条判合并/日界
  const last = groups.messages[groups.messages.length - 1];
  groups.lastMeta = last ? groupMetaOf(last) : null;
  el.groupInput.value = text;
  resizeGroupInput();
  updateGroupSendState();
}

/** 流式帧渲染：start 换发言者、delta 追加、notice 落系统行、done 收尾。 */
function handleGroupStreamEvent(event) {
  if (event.type === "start") {
    groups.streamSender = event.sender || null;
    groups.streamText = "";
    // 日界与回读同一条规则（2026-11-08 批三）：跨天了先插分割线，实时追加也不漏
    const streamDay = groupDayOf({ at: new Date().toISOString() });
    if (!groups.lastMeta || groups.lastMeta.day !== streamDay) {
      appendGroupDayDivider(streamDay);
      groups.lastMeta = { key: "stream", day: streamDay, at: Date.now() };
    }
    // 开一个正在发言的气泡（同 renderGroupTimeline 的左对齐形态）
    const bubble = document.createElement("div");
    bubble.className = "gmsg them streaming";
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar gmsg-avatar";
    const senderMember = groups.current?.members.find((m) => m.partnerId === event.sender?.id) ?? null;
    paintAvatar(avatar, groupMemberAvatar(senderMember), event.sender?.name || "");
    const stack = document.createElement("div");
    stack.className = "gmsg-stack";
    const head = document.createElement("div");
    head.className = "gmsg-head";
    const who = document.createElement("span");
    who.className = "gmsg-who";
    who.textContent = event.sender?.name || "执事";
    const when = document.createElement("span");
    when.className = "gmsg-at gmsg-live";
    when.textContent = "正在发言…";
    head.append(who, when);
    const body = document.createElement("div");
    body.className = "gmsg-body";
    stack.append(head, body);
    bubble.append(avatar, stack);
    el.groupThread.append(bubble);
    groups.streamBubble = { root: bubble, body, when };
    scrollGroupThread();
  } else if (event.type === "delta") {
    if (groups.streamBubble) {
      groups.streamText += event.text || "";
      groups.streamBubble.body.textContent = groups.streamText;
      scrollGroupThread();
    }
  } else if (event.type === "progress") {
    if (groups.streamBubble) {
      groups.streamBubble.when.textContent = event.phase === "working" ? "正在动手…" : "正在思考…";
    }
  } else if (event.type === "notice") {
    const line = document.createElement("div");
    line.className = "group-sys";
    line.textContent = event.text || "";
    el.groupThread.append(line);
    scrollGroupThread();
  } else if (event.type === "done") {
    if (groups.streamBubble) {
      groups.streamBubble.root.classList.remove("streaming");
      if (groups.streamBubble.when) groups.streamBubble.when.textContent = formatGroupTime(new Date().toISOString());
    }
    groups.streamSender = null;
    groups.streamBubble = null;
  }
}

/** 流结束后以服务端时间线为准（终稿 seq/at/被停的半截话都对上） */
async function refreshGroupTimeline() {
  if (!groups.current) return;
  const response = await request(`/api/v1/groups/${encodeURIComponent(groups.current.id)}/messages?limit=200`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const data = await response.json().catch(() => ({}));
  groups.messages = Array.isArray(data.messages) ? data.messages : [];
  groups.lastSeq = Number(data.lastSeq ?? 0);
  renderGroupTimeline();
}

async function refreshGroupSidebarQuiet() {
  const response = await request("/api/v1/groups", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const data = await response.json().catch(() => ({}));
  groups.list = Array.isArray(data.groups) ? data.groups : groups.list;
  renderGroupSidebar();
}

/** 时间线自己滚（2026-11-07 修）：原来滚的是外层 #groups-scroll，
 *  但群会话态是 `height:100%` 的 flex 列，外层根本不溢出——滚动量全落空，
 *  新消息来了不跟随。 */
function scrollGroupThread() {
  const thread = el.groupThread;
  if (thread) thread.scrollTop = thread.scrollHeight;
}

async function stopGroupRoundWeb() {
  if (!groups.current) return;
  await request(`/api/v1/groups/${encodeURIComponent(groups.current.id)}/stop`, { method: "POST" }).catch(() => undefined);
}

/* ── @picker（cindy 同款：纯文本 + 发送时服务端重解析）────── */

const groupAt = { open: false, items: [], index: 0, from: -1 };

function closeGroupAtPop() {
  groupAt.open = false;
  if (el.groupAtpop) el.groupAtpop.hidden = true;
}

function updateGroupAtPop() {
  if (!el.groupInput || !el.groupAtpop || !groups.current) return;
  const caret = el.groupInput.selectionStart ?? el.groupInput.value.length;
  const before = el.groupInput.value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) {
    closeGroupAtPop();
    return;
  }
  const typed = match[2].toLowerCase();
  // 长标签输入中（`@名字·域`）：前半段匹配名字、后半段匹配领域（2026-11-08 批三）
  const [namePart = "", domainPart] = typed.split("·");
  const candidates = [];
  if (domainPart === undefined && (!typed || "所有人".startsWith(typed))) {
    candidates.push({ label: "所有人", insert: "@所有人 " });
  }
  for (const member of groups.current.members) {
    const nameHit = !namePart || member.name.toLowerCase().includes(namePart);
    const domainHit =
      domainPart === undefined || (member.domain || "").toLowerCase().startsWith(domainPart);
    if (!nameHit || !domainHit) continue;
    // 带领域的一律按长标签展示与插入：重名时短名会被后端拒绝，
    // 这里给的是"唯一能写对的形式"，而不是让用户先撞一次 400 再回来改。
    candidates.push(
      member.domain
        ? { label: `${member.name}（${member.domain}）`, insert: `@${member.name}·${member.domain} ` }
        : { label: member.name, insert: `@${member.name} ` },
    );
  }
  if (!candidates.length) {
    closeGroupAtPop();
    return;
  }
  groupAt.open = true;
  groupAt.items = candidates.slice(0, 8);
  groupAt.index = 0;
  groupAt.from = caret - match[2].length - 1;
  el.groupAtpop.replaceChildren(
    ...groupAt.items.map((item, i) => {
      const row = document.createElement("div");
      row.className = `group-at-item${i === groupAt.index ? " current" : ""}`;
      row.setAttribute("role", "option");
      row.textContent = item.label;
      row.addEventListener("mousedown", (mouseEvent) => {
        mouseEvent.preventDefault();
        pickGroupAt(i);
      });
      return row;
    }),
  );
  el.groupAtpop.hidden = false;
}

function pickGroupAt(index) {
  const item = groupAt.items[index];
  if (!item || !el.groupInput) {
    closeGroupAtPop();
    return;
  }
  const value = el.groupInput.value;
  el.groupInput.value = value.slice(0, groupAt.from) + item.insert + value.slice(el.groupInput.selectionStart ?? value.length);
  const caret = groupAt.from + item.insert.length;
  el.groupInput.setSelectionRange(caret, caret);
  closeGroupAtPop();
  resizeGroupInput();
  updateGroupSendState();
  el.groupInput.focus();
}

/* ── 重名 400 的候选条（2026-11-08 批三）───────────────────
 * 后端仍然拒绝不猜：重名短名 400，但把候选（名字 + 领域）随载荷带回来。
 * 这里把候选画成一条可点的提示：点一下插入唯一长标签 @名字·领域，用户改一个字就能发。
 * 不给后端加"猜一个人"的余地，也不让用户自己去记领域。 */

function clearGroupAtHint() {
  if (!el.groupAtHint) return;
  el.groupAtHint.replaceChildren();
  el.groupAtHint.hidden = true;
}

function showGroupAtHint(candidates) {
  if (!el.groupAtHint) return;
  const list = (Array.isArray(candidates) ? candidates : []).filter((item) => item && item.name);
  if (!list.length) {
    clearGroupAtHint();
    return;
  }
  el.groupAtHint.replaceChildren();
  const label = document.createElement("span");
  label.className = "group-at-hint-label";
  label.textContent = "重名了，改用长标签点名：";
  el.groupAtHint.append(label);
  for (const item of list) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "group-at-hint-chip";
    chip.textContent = item.domain ? `${item.name}（${item.domain}）` : item.name;
    chip.title = item.domain ? `插入 @${item.name}·${item.domain}` : `插入 @${item.name}`;
    chip.addEventListener("click", () => insertGroupMention(item));
    el.groupAtHint.append(chip);
  }
  el.groupAtHint.hidden = false;
}

/* ── 建群弹窗（2026-11-07 统一语言）──────────────────────────
 * 原实现挂的是 `text-input`——这个类在 style.css 里根本不存在，于是群名/公告退化成
 * 浏览器默认控件（2px 直角灰框、14px），和同项目「新建执事」的 .modal-input 并排像两个产品；
 * 成员勾选是 13px 原生复选框（Windows 蓝勾），值日执事在勾人前是一块空白。
 *
 * 现在回到模态既有语言（.modal-field + .modal-input + .modal-desc + .modal-actions）：
 *   群名 / 成员 / 公告 三个字段，成员一行一人（头像 + 名字 + 右侧「加入/值日」），
 *   值日不再是独立区域——就在成员行里选，勾人不用再理解一个方框，也不多一块空区。
 * 元素只减不加：原先是「输入框 + 提示 + 勾选块 + 值日块 + 公告 + 按钮」，现在少两块。 */

async function openCreateGroupModal() {
  const partners = await fetchPartnerOptions();
  if (!partners) return;
  if (partners.length < 2) {
    toast("至少要有 2 名执事才能建群，先去侧栏「执事」新建。");
    return;
  }
  groups.picked = [];
  openModal("新建群组", (body) => {
    const desc = document.createElement("p");
    desc.className = "modal-desc";
    desc.textContent = "拉 2–6 位成员进同一条会话。不 @ 就发给值日，@名字 点名谁回。";

    // ── 群名 ──
    const nameField = document.createElement("label");
    nameField.className = "modal-field";
    const nameLabel = document.createElement("span");
    nameLabel.textContent = "群名";
    const nameInput = document.createElement("input");
    nameInput.className = "modal-input";
    nameInput.type = "text";
    nameInput.maxLength = 40;
    nameInput.placeholder = "例如：书房小事";
    nameField.append(nameLabel, nameInput);

    // ── 成员：一行一人，右侧是「加入 / 值日」两个互斥态 ──
    const memberField = document.createElement("div");
    memberField.className = "modal-field";
    const memberLabel = document.createElement("span");
    memberLabel.className = "gcf-label";
    const memberCount = document.createElement("span");
    memberCount.className = "gcf-count";
    memberLabel.append("成员", memberCount);

    const list = document.createElement("div");
    list.className = "gcf-list";
    let dutyChoice = "";

    const validate = () => {
      const count = groups.picked.length;
      memberCount.textContent = `${count} / ${GROUP_MEMBER_MAX}`;
      // 值日必须还在群里：把人移出去时顺手清掉，不让"值日指向已移出的人"这种半截状态存在
      if (dutyChoice && !groups.picked.includes(dutyChoice)) dutyChoice = "";
      submit.disabled = count < GROUP_MEMBER_MIN || count > GROUP_MEMBER_MAX;
      submit.title = submit.disabled ? `需要 ${GROUP_MEMBER_MIN}–${GROUP_MEMBER_MAX} 名成员` : "";
    };

    const rowOf = (partner) => {
      const row = document.createElement("div");
      row.className = "gcf-row";
      row.dataset.partner = partner.id;
      const avatar = document.createElement("span");
      avatar.className = "pt-avatar";
      paintAvatar(avatar, partner.avatar || null, partner.name);
      const name = document.createElement("span");
      name.className = "gcf-name";
      name.textContent = partner.name;
      const role = document.createElement("div");
      role.className = "gcf-role";

      const toggle = () => {
        const picked = groups.picked.includes(partner.id);
        if (picked) {
          groups.picked = groups.picked.filter((id) => id !== partner.id);
          // 值日只在成员之间传递，不留空：移走值日就把值日交给还在群里的第一位。
          // 若留着空，「不 @ 时谁回」在提交前就没人能答（提交会默默补第一位，界面与结果不一致）。
          if (dutyChoice === partner.id) dutyChoice = groups.picked[0] ?? "";
        } else if (groups.picked.length < GROUP_MEMBER_MAX) {
          groups.picked.push(partner.id);
          if (!dutyChoice) dutyChoice = partner.id;
        } else toast(`最多 ${GROUP_MEMBER_MAX} 名成员，先移出一位`);
        renderRows(partner.id);
      };

      const isMember = groups.picked.includes(partner.id);
      // 已在群里时「移除」收成一个 ×：两个文字并排（移除 / 设为值日）会读成一串动作，
      // 而移出是低频、次要、且不可撤销的那一个——图标最省字也最不容易误读。
      const joinBtn = document.createElement("button");
      joinBtn.type = "button";
      joinBtn.className = isMember ? "gcf-chip is-leave" : "gcf-chip is-join";
      if (isMember) {
        joinBtn.setAttribute("aria-label", `把 ${partner.name} 移出群`);
        joinBtn.title = "移出群";
        joinBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      } else {
        joinBtn.textContent = "加入";
      }
      joinBtn.addEventListener("click", toggle);

      if (isMember) {
        // 值日只做"指向"，不做"关掉"：群建出来必须有一个人接不 @ 的话，
        // 所以当前值日是不可点标记（点掉它就出现"谁都不值日"的假状态），
        // 换人请点别人那行的「设为值日」。省一个按钮态，也省一次误操作。
        if (dutyChoice === partner.id) {
          const badge = document.createElement("span");
          badge.className = "gcf-duty";
          badge.textContent = "值日";
          badge.title = "不 @ 任何人时，由这位回话";
          role.append(badge);
        } else {
          const dutyBtn = document.createElement("button");
          dutyBtn.type = "button";
          dutyBtn.className = "gcf-chip is-duty";
          dutyBtn.textContent = "设为值日";
          dutyBtn.title = "不 @ 任何人时，由这位回话";
          dutyBtn.addEventListener("click", () => {
            dutyChoice = partner.id;
            renderRows(partner.id);
          });
          role.append(dutyBtn);
        }
      }
      // 总管进群就是普通成员（方案 §2.1）：名字旁边不再挂一个同字的「总管」标签，
      // 那既重复又像头衔；身份差异放在 title 里，只在需要时出现。
      if (partner.id === "chief") {
        row.title = "总管进群后是普通成员，与其他人一样可以被 @、被设为值日";
      }
      // 四列定宽：头像 | 名字 | 动作槽（加入/设为值日，右对齐）| 移出槽（固定 22px）。
      // 两列分开而不是塞进同一个 flex，"加入/移除" 宽度差就不会把 × 推来推去。
      if (!isMember) {
        role.append(joinBtn);
        const spacer = document.createElement("span");
        spacer.className = "gcf-x-slot";
        row.append(avatar, name, role, spacer);
      } else {
        row.append(avatar, name, role, joinBtn);
      }
      return row;
    };

    const renderRows = (focusId) => {
      list.replaceChildren();
      for (const partner of partners) list.append(rowOf(partner));
      validate();
      // 整块重建会丢焦点：点完「加入」光标飞回弹窗顶部，键盘用户得重新 Tab 一遍。
      // 有明确操作对象时把焦点落回他那一行（优先「加入/移除」，其次「值日」）。
      if (focusId) {
        const row = list.querySelector(`[data-partner="${CSS.escape(focusId)}"]`);
        const target = row?.querySelector(".gcf-chip");
        if (target instanceof HTMLElement) target.focus();
      }
    };

    memberField.append(memberLabel, list);

    // ── 公告 ──
    const noticeField = document.createElement("label");
    noticeField.className = "modal-field";
    const noticeLabel = document.createElement("span");
    noticeLabel.textContent = "群公告（可选）";
    const noticeInput = document.createElement("input");
    noticeInput.className = "modal-input";
    noticeInput.type = "text";
    noticeInput.maxLength = 500;
    noticeInput.placeholder = "一句话说清这个群是干什么的";
    noticeField.append(noticeLabel, noticeInput);

    // ── 动作条 ──
    const row = document.createElement("div");
    row.className = "modal-actions";
    const hint = document.createElement("p");
    hint.className = "modal-hint";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "取消";
    cancel.addEventListener("click", closeModal);
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "modal-primary";
    submit.textContent = "建群";
    submit.disabled = true;

    submit.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        setModalHint(hint, "先给群起个名字。");
        nameInput.focus();
        return;
      }
      if (groups.picked.length < GROUP_MEMBER_MIN || groups.picked.length > GROUP_MEMBER_MAX) {
        setModalHint(hint, `成员要 ${GROUP_MEMBER_MIN}–${GROUP_MEMBER_MAX} 名执事`);
        return;
      }
      // 值日缺省取第一位成员：建群的主路径不该卡在一个"还得再点一下"的必填项上
      const duty = dutyChoice || groups.picked[0] || "";
      submit.disabled = true;
      setModalHint(hint, "建群中…", false);
      const response = await request("/api/v1/groups", {
        method: "POST",
        body: JSON.stringify({
          name,
          memberIds: groups.picked,
          responderKind: "member",
          responderPartnerId: duty,
          notice: noticeInput.value.trim(),
        }),
      }).catch(() => null);
      const data = await response?.json().catch(() => ({}));
      if (!response?.ok) {
        submit.disabled = false;
        setModalHint(hint, data?.message || data?.error || "建群失败");
        return;
      }
      closeModal();
      toast("群组建好了");
      await initGroups();
      location.hash = `#/group/${data.group.id}`;
    });

    nameInput.addEventListener("input", () => clearModalHint(hint));
    row.append(hint, cancel, submit);
    body.append(desc, nameField, memberField, noticeField, row);
    renderRows();
    nameInput.focus();
  });
}

/* ── 群设置抽屉（2026-11-07 重建）──────────────────────────
 * 原实现是居中 modal：改名/公告/值日/成员增减/删除全塞进一列，输入框和勾选胶囊混排，
 * 看不出层级，也不像设置。现在改成与「对话设置」同一副骨架的右侧抽屉：
 *   首页 = 群身份 + 三行（群资料 / 成员 / 回应口径）+ 页尾删除
 *   二级页 = 一次只管一件事，返回箭头回首页，抽屉不关
 * 群名/公告这类长文本在二级页给足高度；成员页一行一人，值日和移出各自独立按钮
 * （原来「点一下移出」既无提示也无撤销，误点就得关掉重来）。
 *
 * 状态全在 drawer 内的局部闭包：取消/关抽屉即丢弃，不写回 groups.current。
 * 保存成功才 initGroups + openGroupChat 重拉，失败原地留输入。 */

const GS_MS = 250;
const gs = {
  node: null, // drawer 元素
  overlay: null,
  page: "home", // home | basic | members | reply
  group: null, // 打开时的群快照（保存后由 openGroupChat 重拉覆盖）
  partners: [], // 可选执事（含已在群里的，成员页按 in/out 分组）
  draft: { name: "", notice: "" },
  timer: 0,
};

function groupSettingsOpen() {
  return Boolean(gs.node) && !gs.node.hidden && !gs.node.classList.contains("pop-closing");
}

function openGroupSettingsDrawer() {
  if (!groups.current) return;
  const overlay = el.groupSettingsOverlay;
  const drawer = el.groupSettingsDrawer;
  if (!overlay || !drawer) return;
  gs.node = drawer;
  gs.overlay = overlay;
  gs.group = groups.current;
  gs.page = "home";
  gs.draft = { name: gs.group.name, notice: gs.group.notice || "" };
  // 执事清单：加成员要用；先吃花名册缓存，随后再拉一次全量（不拦抽屉）
  gs.partners = state.partners.filter((p) => p.status === "active");
  void loadGroupPartnerOptions();

  clearTimeout(gs.timer);
  drawer.classList.remove("pop-closing");
  overlay.classList.remove("pop-closing");
  overlay.hidden = false;
  drawer.hidden = false;
  el.groupSettingsBtn?.setAttribute("aria-expanded", "true");
  renderGroupSettings();
  if (!noMotion.matches) {
    drawer.classList.remove("pop-open");
    overlay.classList.remove("pop-open");
    void drawer.offsetWidth;
    drawer.classList.add("pop-open");
    overlay.classList.add("pop-open");
  }
  gs.node.querySelector(".cs-icon-btn, .gs-row, .set-input")?.focus?.();
}

function closeGroupSettingsDrawer() {
  const drawer = gs.node;
  const overlay = gs.overlay;
  if (!drawer || drawer.hidden) return;
  el.groupSettingsBtn?.setAttribute("aria-expanded", "false");
  clearTimeout(gs.timer);
  const finish = () => {
    drawer.hidden = true;
    if (overlay) overlay.hidden = true;
    drawer.classList.remove("pop-open", "pop-closing");
    overlay?.classList.remove("pop-open", "pop-closing");
    drawer.replaceChildren();
    gs.page = "home";
    gs.group = null;
  };
  if (noMotion.matches) {
    finish();
    return;
  }
  drawer.classList.remove("pop-open");
  overlay?.classList.remove("pop-open");
  void drawer.offsetWidth;
  drawer.classList.add("pop-closing");
  overlay?.classList.add("pop-closing");
  gs.timer = setTimeout(finish, GS_MS);
}

/** 加人清单重拉：state.partners 可能只是一部分（花名册接口） */
async function loadGroupPartnerOptions() {
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    const list = (Array.isArray(data.partners) ? data.partners : []).filter((p) => p.status === "active");
    if (!list.length) return;
    gs.partners = list;
    if (groupSettingsOpen() && gs.page === "members") renderGroupSettings();
  } catch {
    /* 拉不到就维持现有成员视图 */
  }
}

/** 抽屉顶部：标题 + 返回（二级页）+ 关闭 */
function gsHead(title, { back = false } = {}) {
  const head = document.createElement("div");
  head.className = "cs-head";
  if (back) {
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "cs-icon-btn";
    backBtn.setAttribute("aria-label", "返回");
    backBtn.title = "返回";
    backBtn.append(csSvg(CS_ICONS.back));
    backBtn.addEventListener("click", () => {
      gs.page = "home";
      renderGroupSettings();
    });
    head.append(backBtn);
  }
  const titleNode = document.createElement("div");
  titleNode.className = "cs-head-title";
  titleNode.textContent = title;
  head.append(titleNode);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cs-icon-btn";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.title = "关闭 (Esc)";
  closeBtn.append(csSvg(CS_ICONS.x));
  closeBtn.addEventListener("click", closeGroupSettingsDrawer);
  head.append(closeBtn);
  return head;
}

function gsIcon(paths) {
  const span = document.createElement("span");
  span.className = "gs-row-icon";
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return span;
}

const GS_ICONS = {
  // 群资料 = 文本框 + 笔
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  // 成员 = 两个人
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  // 回应口径 = 对话气泡 + 回声
  reply: '<path d="M8 9h8"/><path d="M8 13h6"/><path d="M20 15a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v1a3 3 0 0 0 3 3h2l3 3v-3h5a3 3 0 0 0 3-3z"/>',
  chevron: CS_ICONS.chevron,
};

function renderGroupSettings() {
  const drawer = gs.node;
  if (!drawer) return;
  const group = gs.group;
  if (!group) return;
  const scrollTop = drawer.querySelector(".cs-body")?.scrollTop ?? 0;
  drawer.replaceChildren();
  if (gs.page === "basic") renderGroupSettingsBasic(drawer);
  else if (gs.page === "members") renderGroupSettingsMembers(drawer);
  else if (gs.page === "reply") renderGroupSettingsReply(drawer);
  else renderGroupSettingsHome(drawer);
  const body = drawer.querySelector(".cs-body");
  if (body) body.scrollTop = scrollTop;
}

/** 首页：群身份 + 三行 + 删除 */
function renderGroupSettingsHome(drawer) {
  const group = gs.group;
  drawer.append(gsHead("群设置"));

  const body = document.createElement("div");
  body.className = "cs-body";

  const identity = document.createElement("div");
  identity.className = "gs-identity";
  const avatars = document.createElement("div");
  avatars.className = "gs-identity-avatars";
  for (const member of group.members.slice(0, 5)) {
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar";
    paintAvatar(avatar, groupMemberAvatar(member), member.name);
    avatar.title = member.name;
    avatars.append(avatar);
  }
  const name = document.createElement("div");
  name.className = "gs-identity-name";
  name.textContent = group.name;
  const meta = document.createElement("div");
  meta.className = "gs-identity-meta";
  const duty = group.members.find((m) => m.partnerId === group.responderPartnerId);
  meta.textContent = `${group.members.length} 名成员 · ${gsResponderLabel(group, duty)}`;
  identity.append(avatars, name, meta);
  body.append(identity);

  const row = (icon, title, sub, value, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gs-row";
    button.append(gsIcon(icon));
    const main = document.createElement("span");
    main.className = "gs-row-main";
    const titleNode = document.createElement("span");
    titleNode.className = "gs-row-title";
    titleNode.textContent = title;
    main.append(titleNode);
    if (sub) {
      const subNode = document.createElement("span");
      subNode.className = "gs-row-sub";
      subNode.textContent = sub;
      main.append(subNode);
    }
    button.append(main);
    if (value) {
      const valueNode = document.createElement("span");
      valueNode.className = "gs-row-value";
      valueNode.textContent = value;
      button.append(valueNode);
    }
    const chevron = document.createElement("span");
    chevron.className = "gs-row-chevron";
    chevron.append(csSvg(GS_ICONS.chevron));
    button.append(chevron);
    button.addEventListener("click", onClick);
    return button;
  };

  body.append(
    row(GS_ICONS.edit, "群资料", "群名和公告，公告随每轮输入带给成员", "查看", () => {
      gs.page = "basic";
      renderGroupSettings();
    }),
    (() => {
      const divider = document.createElement("div");
      divider.className = "gs-divider";
      return divider;
    })(),
    row(GS_ICONS.users, "成员", "2–6 名执事；值日执事在不 @ 时回话", `${group.members.length} 人`, () => {
      gs.page = "members";
      renderGroupSettings();
    }),
    (() => {
      const divider = document.createElement("div");
      divider.className = "gs-divider";
      return divider;
    })(),
    row(GS_ICONS.reply, "回应口径", "不 @ 时谁回：值日 / 全员 / 只回点名", gsResponderShort(group), () => {
      gs.page = "reply";
      renderGroupSettings();
    }),
  );

  const footer = document.createElement("div");
  footer.className = "gs-footer";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "gs-danger";
  del.textContent = "删除这个群…";
  del.addEventListener("click", () => confirmDeleteGroup(group));
  footer.append(del);
  body.append(footer);
  drawer.append(body);
}

function gsResponderShort(group) {
  if (group.responderKind === "everyone") return "全员都回";
  if (group.responderKind === "mentions") return "只回点名";
  const duty = group.members.find((m) => m.partnerId === group.responderPartnerId);
  return duty ? `值日 ${duty.name}` : "值日未设";
}

function gsResponderLabel(group, duty) {
  if (group.responderKind === "everyone") return "不 @ 时全员按顺序回";
  if (group.responderKind === "mentions") return "只有 @ 点名才有人回";
  return duty ? `不 @ 时 ${duty.name} 回` : "值日执事未设";
}

/** 二级页：群名 + 公告 */
function renderGroupSettingsBasic(drawer) {
  drawer.append(gsHead("群资料", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  const form = document.createElement("div");
  form.className = "gs-form";

  const nameField = document.createElement("label");
  nameField.className = "gs-field";
  const nameLabel = document.createElement("span");
  nameLabel.className = "gs-field-label";
  nameLabel.textContent = "群名";
  const nameInput = document.createElement("input");
  nameInput.className = "set-input";
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.value = gs.draft.name;
  nameInput.addEventListener("input", () => {
    gs.draft.name = nameInput.value;
  });
  nameField.append(nameLabel, nameInput);

  const noticeField = document.createElement("label");
  noticeField.className = "gs-field";
  const noticeLabel = document.createElement("span");
  noticeLabel.className = "gs-field-label";
  noticeLabel.textContent = "群公告";
  const noticeInput = document.createElement("textarea");
  noticeInput.className = "set-input";
  noticeInput.maxLength = 500;
  noticeInput.placeholder = "可选。会随每轮输入带给发言的成员，适合写这个群是干什么的、有什么约定。";
  noticeInput.value = gs.draft.notice;
  noticeInput.addEventListener("input", () => {
    gs.draft.notice = noticeInput.value;
  });
  const note = document.createElement("div");
  note.className = "gs-pick-note";
  note.textContent = "公告是群级背景，不是指令；它不会给成员任何新权限。";
  noticeField.append(noticeLabel, noticeInput, note);

  const actions = document.createElement("div");
  actions.className = "gs-actions";
  const hint = document.createElement("p");
  hint.className = "set-hint";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn-primary";
  save.textContent = "保存";
  save.addEventListener("click", async () => {
    const nextName = nameInput.value.trim();
    if (!nextName) {
      hint.textContent = "群名不能为空。";
      hint.classList.add("is-error");
      return;
    }
    save.disabled = true;
    hint.textContent = "保存中…";
    hint.classList.remove("is-error");
    const response = await request(`/api/v1/groups/${encodeURIComponent(gs.group.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: nextName, notice: noticeInput.value }),
    }).catch(() => null);
    const data = await response?.json().catch(() => ({}));
    save.disabled = false;
    if (!response?.ok) {
      hint.textContent = data?.message || "保存失败";
      hint.classList.add("is-error");
      return;
    }
    gs.group = data.group ?? gs.group;
    groups.current = gs.group;
    gs.draft = { name: gs.group.name, notice: gs.group.notice || "" };
    await initGroups();
    await openGroupChat(gs.group.id);
    gs.page = "home";
    renderGroupSettings();
    toast("群资料已保存");
  });
  actions.append(hint, save);
  form.append(nameField, noticeField, actions);
  body.append(form);
  drawer.append(body);
  nameInput.focus();
}

/** 二级页：成员（一行一人；值日 / 移出各自独立；下方候选加人） */
function renderGroupSettingsMembers(drawer) {
  drawer.append(gsHead("成员", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  const group = gs.group;
  const inGroup = new Set(group.members.map((m) => m.partnerId));
  const candidates = gs.partners
    .filter((p) => p.id !== "chief" || !inGroup.has("chief"))
    .filter((p) => !inGroup.has(p.id));
  const hint = document.createElement("p");
  hint.className = "set-hint";
  hint.style.padding = "12px 16px 4px";

  const render = () => {
    body.replaceChildren();
    const count = group.members.length;
    hint.textContent =
      `${count} / ${GROUP_MEMBER_MAX} 人。值日执事在不 @ 时回话；群至少保留 ${GROUP_MEMBER_MIN} 人。` +
      (count >= GROUP_MEMBER_MAX ? "已满员，先移出一位才能加人。" : "");
    body.append(hint);

    for (const member of group.members) {
      const isDuty = member.partnerId === group.responderPartnerId && group.responderKind === "member";
      const row = document.createElement("div");
      row.className = "gs-member-row";
      const avatar = document.createElement("span");
      avatar.className = "pt-avatar";
      paintAvatar(avatar, groupMemberAvatar(member), member.name);
      const main = document.createElement("div");
      main.className = "gs-member-main";
      const nameNode = document.createElement("div");
      nameNode.className = "gs-member-name";
      nameNode.textContent = member.name;
      const sub = document.createElement("div");
      sub.className = "gs-member-sub";
      sub.textContent = isDuty
        ? "值日执事 · 不 @ 时他回"
        : member.status === "active"
          ? "群成员"
          : "当前暂停或归档";
      main.append(nameNode, sub);

      const actions = document.createElement("div");
      actions.className = "gs-member-actions";
      if (group.responderKind === "member") {
        const dutyBtn = document.createElement("button");
        dutyBtn.type = "button";
        dutyBtn.className = "gs-chip-btn";
        dutyBtn.setAttribute("aria-pressed", isDuty ? "true" : "false");
        dutyBtn.textContent = isDuty ? "值日" : "设为值日";
        dutyBtn.disabled = isDuty;
        dutyBtn.addEventListener("click", () => void patchGroup({ responderPartnerId: member.partnerId }));
        actions.append(dutyBtn);
      }
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "gs-chip-btn is-danger";
      removeBtn.textContent = "移出";
      removeBtn.disabled = count <= GROUP_MEMBER_MIN;
      if (removeBtn.disabled) removeBtn.title = `群至少保留 ${GROUP_MEMBER_MIN} 人`;
      removeBtn.addEventListener("click", () => {
        if (count <= GROUP_MEMBER_MIN) {
          toast(`群至少保留 ${GROUP_MEMBER_MIN} 人`);
          return;
        }
        if (!window.confirm(`把「${member.name}」移出群？群里的历史消息会保留。`)) return;
        void patchGroup({ removeMemberIds: [member.partnerId] });
      });
      actions.append(removeBtn);
      row.append(avatar, main, actions);
      body.append(row);
    }

    const label = document.createElement("div");
    label.className = "gs-section-label";
    label.textContent = candidates.length ? "加人" : "可加的执事都已在这个群里";
    body.append(label);

    if (candidates.length) {
      const list = document.createElement("div");
      list.className = "gs-add-list";
      const full = group.members.length >= GROUP_MEMBER_MAX;
      for (const partner of candidates) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gs-add-row";
        button.disabled = full;
        const avatar = document.createElement("span");
        avatar.className = "pt-avatar";
        paintAvatar(avatar, partner.avatar || null, partner.name);
        const nameNode = document.createElement("span");
        nameNode.textContent = partner.name;
        const plus = document.createElement("span");
        plus.className = "gs-add-plus";
        plus.textContent = full ? "已满员" : "加入";
        button.append(avatar, nameNode, plus);
        if (partner.id === "chief") {
          button.title = "总管进群后就是普通成员，不参与路由（值日 / @ 都照常）";
        }
        button.addEventListener("click", () => {
          void patchGroup({ addMemberIds: [partner.id] });
        });
        list.append(button);
      }
      body.append(list);
    }
  };
  render();
  drawer.append(body);
}

/** 二级页：回应口径（三选一，写清代价） */
function renderGroupSettingsReply(drawer) {
  drawer.append(gsHead("回应口径", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  const group = gs.group;
  const hint = document.createElement("p");
  hint.className = "set-hint";
  hint.style.padding = "12px 16px 8px";
  hint.textContent = "只管「这条消息没有 @ 任何人」时怎么办；@ 点名与 @所有人 永远优先。";

  const options = [
    {
      kind: "member",
      title: "值日执事回",
      sub: "最省：只叫一位。@点名 仍然可以点别人。",
    },
    {
      kind: "everyone",
      title: "全员按顺序回",
      sub: "最贵：每位成员一次完整模型调用，人多时明显慢。",
    },
    {
      kind: "mentions",
      title: "只回点名",
      sub: "没有 @ 就没人接话（会留一行系统提示）。",
    },
  ];

  body.append(hint);
  for (const option of options) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "gs-row";
    row.setAttribute("aria-pressed", group.responderKind === option.kind ? "true" : "false");
    const main = document.createElement("span");
    main.className = "gs-row-main";
    const title = document.createElement("span");
    title.className = "gs-row-title";
    title.textContent = option.title;
    const sub = document.createElement("span");
    sub.className = "gs-row-sub";
    sub.textContent = option.sub;
    main.append(title, sub);
    row.append(main);
    if (group.responderKind === option.kind) {
      const check = document.createElement("span");
      check.className = "gs-row-value";
      check.textContent = "当前";
      row.append(check);
    }
    row.addEventListener("click", () => {
      if (group.responderKind === option.kind) return;
      if (option.kind === "everyone") {
        const ok = window.confirm(
          `「${group.name}」改成不 @ 就全员回？每位成员都会各跑一次模型，账单和等待都会随人数增长。`,
        );
        if (!ok) return;
      }
      const payload = { responderKind: option.kind };
      // 换成 member 而没有值日时，顺手把第一位设成值日（否则服务端 400）
      if (option.kind === "member" && !group.responderPartnerId) {
        const first = group.members[0];
        if (first) payload.responderPartnerId = first.partnerId;
      }
      void patchGroup(payload);
    });
    body.append(row);
    const divider = document.createElement("div");
    divider.className = "gs-divider";
    body.append(divider);
  }
  if (group.responderKind === "member") {
    const label = document.createElement("div");
    label.className = "gs-section-label";
    label.textContent = "值日执事";
    body.append(label);
    for (const member of group.members) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "gs-row";
      const avatar = document.createElement("span");
      avatar.className = "pt-avatar";
      paintAvatar(avatar, groupMemberAvatar(member), member.name);
      const main = document.createElement("span");
      main.className = "gs-row-main";
      const title = document.createElement("span");
      title.className = "gs-row-title";
      title.textContent = member.name;
      main.append(title);
      row.append(avatar, main);
      if (member.partnerId === group.responderPartnerId) {
        const check = document.createElement("span");
        check.className = "gs-row-value";
        check.textContent = "值日";
        row.append(check);
      }
      row.addEventListener("click", () => {
        if (member.partnerId === group.responderPartnerId) return;
        void patchGroup({ responderPartnerId: member.partnerId });
      });
      body.append(row);
    }
  }
  drawer.append(body);
}

/** 统一的 PATCH：成功就把新群写回并重渲染当前页；失败只 toast，草稿不丢 */
async function patchGroup(payload) {
  const group = gs.group;
  if (!group) return;
  const response = await request(`/api/v1/groups/${encodeURIComponent(group.id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  }).catch(() => null);
  const data = await response?.json().catch(() => ({}));
  if (!response?.ok) {
    toast(data?.message || "没保存成功");
    return;
  }
  gs.group = data.group ?? gs.group;
  groups.current = gs.group;
  gs.draft = { name: gs.group.name, notice: gs.group.notice || "" };
  await initGroups();
  await openGroupChat(gs.group.id);
  renderGroupSettings();
}

async function confirmDeleteGroup(group) {
  const ok = window.confirm(`删群「${group.name}」？消息和成员关系一起删，不可恢复。`);
  if (!ok) return;
  const response = await request(`/api/v1/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" }).catch(() => null);
  if (!response?.ok) {
    toast("删群失败");
    return;
  }
  closeGroupSettingsDrawer();
  toast("群已删除");
  await initGroups();
  location.hash = "#/groups";
}

/**
 * 执事选项（建群/加人用）；拿不到返回 null（弹窗里 toast 提示）
 *
 * 2026-11-07：**总管也要能进群**。总管在库里就是一行 partner（固定 id `chief`），
 * 服务端建群/加人一路都接受他（方案 §2.1「总管可被拉进群当普通成员，不做路由者」），
 * 之前这里 `.filter(p => p.id !== "chief")` 把它挡在前端，用户看到的就是「加不了总管」。
 * 现在只按状态筛；总管排在最前，并在界面上标注他的身份差异（普通成员，不路由）。
 */
async function fetchPartnerOptions() {
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const list = (Array.isArray(data.partners) ? data.partners : [])
      .filter((p) => p.status === "active")
      .sort((a, b) => Number(b.id === "chief") - Number(a.id === "chief"));
    // 重名在群里是 @ 歧义源：建群入口就拦（服务端同样校验）
    const seen = new Set();
    for (const partner of list) {
      if (seen.has(partner.name)) {
        toast(`有重名执事「${partner.name}」，先改名再建群`);
        return null;
      }
      seen.add(partner.name);
    }
    return list;
  } catch {
    return null;
  }
}

/* 群组事件接线 */
el.groupsBack?.addEventListener("click", () => {
  location.hash = groupRouteId() ? "#/groups" : "#/";
});
el.groupCreate?.addEventListener("click", () => void openCreateGroupModal());
el.groupSettingsBtn?.addEventListener("click", () => {
  if (groupSettingsOpen()) closeGroupSettingsDrawer();
  else openGroupSettingsDrawer();
});
el.groupSend?.addEventListener("click", () => void sendGroupMessage());
el.groupStop?.addEventListener("click", () => void stopGroupRoundWeb());
el.groupInput?.addEventListener("input", () => {
  resizeGroupInput();
  updateGroupSendState();
  updateGroupAtPop();
  // 用户开始改正文：上一轮重名候选条已经过时，收掉（2026-11-08 批三）
  clearGroupAtHint();
});
el.groupInput?.addEventListener("keydown", (event) => {
  if (groupAt.open) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      groupAt.index = (groupAt.index + 1) % groupAt.items.length;
      updateGroupAtPop();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      groupAt.index = (groupAt.index - 1 + groupAt.items.length) % groupAt.items.length;
      updateGroupAtPop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.isComposing) {
      event.preventDefault();
      pickGroupAt(groupAt.index);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeGroupAtPop();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendGroupMessage();
  }
});
// @ 按钮（2026-11-07 修接线）：把 @ 打到光标处并弹候选——与手输 @ 走同一条
// updateGroupAtPop 路径；光标前已有半截 @（含空 @）就不重复插，直接把候选弹出来。
el.groupAtBtn?.addEventListener("click", () => {
  if (!el.groupInput) return;
  const value = el.groupInput.value;
  const caret = el.groupInput.selectionStart ?? value.length;
  if (!/(^|\s)@([^\s@]*)$/.test(value.slice(0, caret))) {
    el.groupInput.value = value.slice(0, caret) + "@" + value.slice(caret);
    const next = caret + 1;
    el.groupInput.setSelectionRange(next, next);
  }
  el.groupInput.focus();
  updateGroupAtPop();
});
el.railGroups?.addEventListener("click", () => {
  go("groups");
});
// 分组头的折叠由上面 SIDE_SECTIONS 那个循环统一注册；**这里不要再绑一次**——
// 同一元素上两个 toggleSection 会互相抵消（点一下收起、紧接着又展开），
// 表现成"群组点了没反应、也没有动画"（2026-11-07 实测踩到）。
// 进整页的入口都挂在分区体内的链接行 / 群行上。
el.secGroupsAdd?.addEventListener("click", () => {
  go("groups");
  void openCreateGroupModal();
});
/* 「所有群聊」：分区底部那一行（2026-11-07 用户口径「放在群组展开之后的底下，
   不要放在返回之后」）。它只负责去列表态；群会话里点它同样落到 #/groups，
   不必先按顶栏返回键再找入口。 */
el.secGroupsAll?.addEventListener("click", () => go("groups"));

/* 课题（2026-11-07 批二）：轨道按钮不带独立页面，只负责把展开侧栏打开、
   把「课题」分区展开并滚到可见处；列表数据顺手现拉一次。 */
el.railTopics?.addEventListener("click", () => {
  if (!sidebarOpen()) toggleSidebar();
  localStorage.setItem("lifediary.side.topics", "open");
  applySections();
  document.getElementById("sec-topics")?.scrollIntoView({ block: "nearest" });
  void loadTopicsSidebar({ force: true });
});
// 分区头由 SIDE_SECTIONS 的循环统一折叠；这里只补「展开时现拉一次」，不再 toggle。
el.secTopicsToggle?.addEventListener("click", () => {
  if (!sectionClosed("topics")) void loadTopicsSidebar();
});

/* ── 启动 ─────────────────────────────────────────────── */

void (async () => {
  // 显式初始化一次，别指望 HTML 的 disabled 属性活到脚本跑完
  el.send.disabled = true;
  applyTheme(currentThemeChoice());
  applyActPref();
  syncThinkingPill();
  // 侧栏分区折叠态（localStorage）与总管状态点初值
  applySections();
  // 课题区（2026-11-07 批二）：首屏拉一次；404 时整块入口自己退场
  void loadTopicsSidebar();
  syncChiefDot();
  // 隐藏层不作为 Tab 焦点：首帧按真实可见性定（窄屏只看轨道）
  applySidebarA11y();
  // 没有落盘会话 = 首屏普通 worker 空会话；表头要跟身份一致
  if (!state.conversationId) {
    el.title.textContent = state.chatKind === "chief" ? "新对话" : "普通对话";
    el.title.dataset.chatKind = state.chatKind;
  }

  // 深链：`?view=settings`（或 `?view=settings/连接页 id`）落设置页，
  // `?view=new` 开一个新对话（壳的托盘/快捷方式用得上）
  const deepView = new URLSearchParams(location.search).get("view");
  if (deepView && (deepView.startsWith("settings") || deepView.startsWith("new"))) {
    if (deepView.startsWith("settings")) {
      if (currentRoute() !== "settings") {
        const sub = deepView.slice("settings".length).replace(/^\//, "");
        go("settings", SETTINGS_SECTIONS.some((section) => section.id === sub) ? sub : undefined);
      }
    } else {
      go("chat");
      startNewChat("worker");
    }
    // 用掉就清掉，否则以后每次刷新都被它拽回同一个地方
    const clean = new URL(location.href);
    clean.searchParams.delete("view");
    history.replaceState(null, "", clean.toString());
  }

  await checkHealth();
  await loadChats();
  void loadCapabilities(); // 附件 / 编辑重发的开关投影（2026-11-08 4a）
  void loadRoster(); // E4：执事花名册首帧
  void initGroups(); // 群组（2026-11-06 批二）：可用性探测 + 侧栏节首帧
  void refreshModelPill();
  // 侧栏项目区：拿不到工作区就保持隐藏（没根目录谈何项目）
  void refreshProjectPill();
  if (state.conversationId) await openChat(state.conversationId);
  updateHomeMode();
  // 侧栏「任务中心」的进行中徽标：静默拉一次，读不到就只当没有；
  // 之后由 autoSyncTick 低频兜底（看板 20s / 对话页 60s），SSE 事件到达时直接增量更新。
  void loadTickets({ silent: true, render: false });
  applyRoute();
  setInterval(checkHealth, 8000);
  setInterval(autoSyncTick, 5000);
  // 问候语跨段自动换（2026-11-07）：窗口常开着过夜也不能一直挂着「晚安」。
  // 一分钟查一次就够——换段是整点的事，没人会盯着这一秒；
  // 只改文本、不重建 DOM，所以不会打断动画，也不会闪。
  setInterval(() => {
    if (el.viewChat.dataset.home === "1") syncGreeting();
  }, 60_000);
})();
