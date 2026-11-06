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
  recents: document.getElementById("recents"),
  recentsToggle: document.getElementById("recents-toggle"),
  recentsBody: document.getElementById("recents-body"),
  recentsAll: document.getElementById("recents-all"),
  partnerAddSide: document.getElementById("partner-add-side"),
  partnerRoster: document.getElementById("partner-roster"),
  settingsNav: document.getElementById("settings-nav"),
  newChat: document.getElementById("new-chat"),
  sideProj: document.getElementById("side-proj"),
  projectPill: document.getElementById("proj-pill"),
  projectPillLabel: document.getElementById("proj-pill-label"),
  projectMenu: document.getElementById("proj-menu"),
  title: document.getElementById("title"),
  thread: document.getElementById("thread"),
  empty: document.getElementById("empty"),
  scroll: document.getElementById("scroll"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  railNew: document.getElementById("rail-new"),
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
  groupChat: document.getElementById("group-chat"),
  groupNotice: document.getElementById("group-notice"),
  groupThread: document.getElementById("group-thread"),
  groupInput: document.getElementById("group-input"),
  groupSend: document.getElementById("group-send"),
  groupStop: document.getElementById("group-stop"),
  groupAtpop: document.getElementById("group-atpop"),
  sideGroup: document.getElementById("side-group"),
  railGroups: document.getElementById("rail-groups"),
  groupList: document.getElementById("group-list"),
  openTasks: document.getElementById("open-tasks"),
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
  queuePanelHost: document.getElementById("composer"),
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
  // E4「全部会话 →」用的 #/settings/sessions 落到「会话」分区（该分区已有搜索）。
  // 分区 id 其实是 chats；这里做一层别名，不改现有分区与路由体系。
  if (part === "sessions") return "chats";
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
  el.toggleSidebar.hidden = route === "settings";
  el.openSettings.setAttribute("aria-current", String(route === "settings"));
  el.openTasks.setAttribute("aria-current", String(route === "tasks"));
  el.railTasks.setAttribute("aria-current", String(route === "tasks"));
  if (route === "settings") void renderSettings();
  else if (route === "tasks") openTasks();
  else if (route === "domains") openDomains();
  else if (route === "group") void openGroupsView();
  else el.input.focus();
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
  chats: [],
  removed: 0,
  query: "",
  // 任务中心：一次拉列表（最多 200 张），看板/详情/徽标都从这里派生
  tickets: [],
  ticketsFetchedAt: 0,
  ticketsLoading: false,
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
  // 排队插话（批次二）：忙时发的消息先在这里排队，本轮结束后依次真发。
  // 只存内存——刷新即丢，登记为已知边界（方案 §三）。
  queue: [],
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
  if (status === "done") return "done";
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

  el.tasksDetail.innerHTML = `
    <div class="td-card"${ticket.status === "needs_you" ? ' data-attn="1"' : ""}>
      <div class="td-head">
        <span class="tk-chip" data-tone="${statusTone}">${esc(statusLabel)}</span>
        <span class="td-domain">${esc(data.domain || ticket.options?.domain || "总管（未分配）")}</span>
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
    <section class="td-section">
      <h3>任务<span>${passed}/${total}</span></h3>
      <ul class="td-tasks">${taskRows}</ul>
    </section>
    ${childRows}
    ${reviewRows}
    ${deadLetterRows}
  `;
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

/* 任务中心的固定入口与交互（只读，不提供改派/停止） */
el.openTasks.addEventListener("click", () => go("tasks"));
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
  const head = event.target.closest(".tk-conv-head, .tk-arch-conv");
  if (head) {
    const conversationId = head.dataset.conv || "";
    if (conversationId) {
      go("chat");
      void openChat(conversationId);
    }
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
  if (!visible.length) {
    const hint = document.createElement("div");
    hint.className = "chats-empty";
    hint.textContent = "还没有会话";
    el.chats.append(hint);
  }
  // 置顶的排前面（2026-11-04 批次一），段内保持原有顺序（旧→新）；标记走标题前缀，不另起分组栏
  // partner- 前缀（执事专线 / 群成员会话，2026-11-06 群组方案 §2.2）不进最近会话：
  // 执事的对话从花名册进，群从群组节进——这里漏过滤会把执事会话当主人会话摆出来（实测踩过）。
  const ordered = [...visible]
    .filter((chat) => !String(chat.conversationId || "").startsWith("partner-"))
    .reverse()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  // 原「对话」列表整块移入最近会话折叠块，只展示前 RECENTS_LIMIT 条；
  // 5 条之外由块尾「全部会话 →」进设置→会话搜索，不在侧栏铺开。
  for (const chat of ordered.slice(0, RECENTS_LIMIT)) {
    const row = document.createElement("div");
    row.className = "chat";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = `${chatLabel(chat)} · ${chat.turns} 轮${chat.pinned ? " · 已置顶" : ""}`;
    if (chat.conversationId === state.conversationId) {
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

    row.addEventListener("click", () => void openChat(chat.conversationId));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openChat(chat.conversationId);
      }
    });
    el.chats.append(row);
  }
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

const KEY_RECENTS = "lifediary.chief.recents";

/* 最近会话折叠：默认展开，折叠态存 localStorage（刷新后仍折叠）。 */
function applyRecents() {
  const collapsed = localStorage.getItem(KEY_RECENTS) === "closed";
  el.recents.classList.toggle("is-collapsed", collapsed);
  el.recentsToggle.setAttribute("aria-expanded", String(!collapsed));
}

function toggleRecents() {
  const collapsed = localStorage.getItem(KEY_RECENTS) === "closed";
  localStorage.setItem(KEY_RECENTS, collapsed ? "open" : "closed");
  applyRecents();
}

el.recentsToggle.addEventListener("click", toggleRecents);
// 5 条之外：进设置→会话搜索。分区 id 是 chats，#/settings/sessions 由
// currentSettingsPage() 做别名落到同一分区（会话分区已有搜索）。
el.recentsAll.addEventListener("click", () => go("settings", "sessions"));

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
  el.thread.replaceChildren();
  if (el.empty) el.thread.append(el.empty);
  updateHomeMode();
}

function hideEmpty() {
  if (el.empty && el.empty.isConnected) el.empty.remove();
}

function addMessage(role, text, at) {
  hideEmpty();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  // 时间戳不摆在脸上，挂在 hover 的 title 里；data-at 留给以后要用的时候
  if (at) {
    wrap.dataset.at = String(at);
    wrap.title = new Date(at).toLocaleString("zh-CN");
  }

  // 助手那一侧多一层「活动」：思考 / 工具 / 派活。用户消息没有这一层。
  let acts = null;
  if (role === "assistant") {
    acts = document.createElement("div");
    acts.className = "acts";
    wrap.append(acts);
  }

  const body = document.createElement("div");
  body.className = "body";
  if (role === "user") body.textContent = text;
  else body.innerHTML = renderMarkdown(text);
  wrap.append(body);

  // 复制整条回答：悬停才出现，别一直挂在那里
  if (role === "assistant") {
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
    wrap.append(copy);
  }

  el.thread.append(wrap);
  updateHomeMode();
  if (state.stick) scrollToEnd();
  return { root: wrap, body, acts };
}

/* ── 活动行 ───────────────────────────────────────────── */

function makeAct(name, label, stateName) {
  const row = document.createElement("div");
  row.className = "act";
  row.dataset.state = stateName;
  const dot = document.createElement("span");
  dot.className = "dot";
  const nameEl = document.createElement("span");
  nameEl.className = "act-name";
  nameEl.textContent = name;
  row.append(dot, nameEl);
  if (label) {
    const labelEl = document.createElement("span");
    labelEl.className = "act-label";
    labelEl.textContent = label;
    labelEl.title = label;
    row.append(labelEl);
  }
  return row;
}

/** "正在思考" 只有一行，工具一动就让位给具体的工具行 */
function setThinking(acts, on) {
  const existing = acts.querySelector('.act[data-state="thinking"]');
  if (on && !existing) {
    const row = makeAct("正在思考", "", "thinking");
    acts.append(row);
  } else if (!on && existing) {
    existing.remove();
  }
}

/** 让这一行可点开（第一次加内容时挂监听，之后不再重复挂） */
function markExpandable(row) {
  if (row.classList.contains("expandable")) return;
  row.classList.add("expandable");
  row.dataset.open = "0";
  row.addEventListener("click", () => {
    row.dataset.open = row.dataset.open === "1" ? "0" : "1";
  });
}

function addActBlock(row, text) {
  markExpandable(row);
  const pre = document.createElement("pre");
  pre.className = "act-block";
  pre.textContent = text;
  // 在原文里选字不该顺手把块收起来
  pre.addEventListener("click", (event) => event.stopPropagation());
  row.append(pre);
}

function toolStart(acts, name, label, args) {
  setThinking(acts, false);
  const row = makeAct(name, label, "run");
  row.dataset.tool = name;
  if (args) addActBlock(row, args);
  acts.append(row);
  return row;
}

function toolEnd(acts, name, ok, output) {
  const row = [...acts.querySelectorAll('.act[data-tool]')]
    .reverse()
    .find((node) => node.dataset.tool === name && node.dataset.state === "run");
  if (!row) return;
  row.dataset.state = ok ? "ok" : "err";
  if (output) addActBlock(row, output);
}

/** 一轮跑完：把一长串活动收成一行「已执行 N 步」，点开还在 */
function collapseActs(acts) {
  if (!acts || !acts.childElementCount || acts.dataset.collapsed) return;
  acts.dataset.collapsed = "1";
  const count = acts.querySelectorAll(".act").length;
  const box = document.createElement("details");
  box.className = "acts";
  const summary = document.createElement("summary");
  summary.textContent = `已执行 ${count} 步`;
  box.append(summary);
  acts.replaceWith(box);
  box.append(acts);
}

/** 错误行。`retryable` 时带「重试」——重发这条错误的最后一句话（批次一，2026-11-04） */
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

/** 消息级 token/耗时（批次一）：hover 才出现，跟复制按钮同一层 */
function attachUsage(root, usage, ms) {
  const total = (usage.input || 0) + (usage.output || 0);
  if (!root.isConnected || total <= 0) return;
  const chip = document.createElement("span");
  chip.className = "msg-usage";
  chip.textContent = `${total.toLocaleString()} tok · ${(ms / 1000).toFixed(1)}s`;
  chip.title = `输入 ${usage.input || 0} · 输出 ${usage.output || 0} · 缓存命中 ${usage.cacheRead || 0} tokens`;
  const copy = root.querySelector(".copy-btn");
  if (copy) root.insertBefore(chip, copy);
  else root.append(chip);
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
      const shown = addMessage(message.role === "user" ? "user" : "assistant", message.text, message.at);
      // E2 #7：助手正文里以「【需要你】」开头的行加 .attention（只改渲染判断，不改内容）。
      if (message.role !== "user") {
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
    if (!owner()) return { token, conversationId, status: "stale" };
    // 刷新页面 / 切回会话时，可能还有一条挂着等答复的审批
    await loadPendingApprovals(conversationId);
    if (!owner()) return { token, conversationId, status: "stale" };
    return { token, conversationId, status: "ok", applied: true, chatKind: kind };
  } catch (error) {
    // 旧请求的失败不许挂到别人屏幕上
    if (!owner()) return { token, conversationId, status: "stale" };
    if (error.message !== "forbidden" && error.message !== "not-found") {
      addError(`读历史失败：${error.message}`);
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
  el.send.disabled = state.sending ? false : !el.input.value.trim();
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
    if (convId && convId !== state.conversationId) void openChat(convId);
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
   答复后按钮置灰、倒计时停下；卡片留在原地作为痕迹。 */
const approvalCards = new Map();

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

  const args = document.createElement("pre");
  args.className = "approval-args";
  args.textContent = event.args || "（没有参数）";
  card.append(args);

  const meta = document.createElement("div");
  meta.className = "approval-meta";
  const remain = document.createElement("span");
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
  const timer = setInterval(tick, 1000);
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
      const card = renderApprovalCard(item);
      if (!card) continue;
      hideEmpty();
      el.thread.append(card);
    }
    if (state.stick) scrollToEnd();
  } catch {
    /* 离线 / 未配置：补挂失败不影响对话 */
  }
}

/* ── 排队插话（批次二）：忙时发的消息先排队，本轮结束后依次真发 ──
   队列只在本机内存里（刷新即丢，方案 §三 登记的边界）；发送仍走现有
   /chat 端点，以 SSE start 为成功依据——前端只是视图，不造第二份事实。 */
const QUEUE_MAX = 10;

function renderQueue() {
  let panel = document.getElementById("queue-panel");
  if (!state.queue.length) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "queue-panel";
    panel.className = "queue-panel";
    el.queuePanelHost.prepend(panel);
  }
  panel.replaceChildren();
  const label = document.createElement("div");
  label.className = "queue-label";
  label.textContent = `排队中 ${state.queue.length} 条 · 本轮结束后依次发送`;
  panel.append(label);
  state.queue.forEach((text, index) => {
    const row = document.createElement("div");
    row.className = "queue-row";
    const span = document.createElement("span");
    span.className = "queue-text";
    span.textContent = text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "queue-remove";
    remove.textContent = "✕";
    remove.title = "撤回这条";
    remove.addEventListener("click", () => {
      state.queue.splice(index, 1);
      renderQueue();
    });
    row.append(span, remove);
    panel.append(row);
  });
  // 停止之后队列留在原地，给一个「继续」的明确入口（cindy 同款语义）
  const cont = document.createElement("button");
  cont.type = "button";
  cont.className = "queue-continue";
  cont.hidden = state.sending;
  cont.textContent = "继续发送";
  cont.addEventListener("click", () => submitNext());
  panel.append(cont);
}

function submitNext() {
  renderQueue();
  if (state.sending || !state.queue.length) return;
  const next = state.queue.shift();
  void send(next);
}

async function send(text) {
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
  addMessage("user", text, Date.now());
  if (firstTurn) el.title.textContent = text.replace(/\s+/g, " ").slice(0, 40);
  const turn = addMessage("assistant", "", Date.now());
  const body = turn.body;
  const acts = turn.acts;
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
          const card = renderApprovalCard(event);
          if (card && !card.isConnected) turn.root.before(card);
          maybeNotify("有写操作需要你确认", event.tool || "", state.conversationId, "attention");
        } else if (event.type === "done") {
          if (event.usage) attachUsage(turn.root, event.usage, Date.now() - turnStartMs);
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
        messages: [{ role: "user", content: text }],
      }),
    });

    if (response.status === 404 && state.conversationId) {
      // 服务重启过、或者那个会话已经不在：当新会话重发一次。
      state.conversationId = "";
      localStorage.removeItem(KEY_CONV);
      body.remove();
      setSending(false);
      return send(text);
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
            // 思考正文增量（批次一）：进折叠卡；占位的「正在思考」行让位
            ensureThinkCard();
            setThinking(acts, false);
            thinkLastMs = Date.now();
            thinkBody.textContent += event.text || "";
            if (state.stick) scrollToEnd();
          } else if (event.type === "delta") {
            answer += event.text;
            setThinking(acts, false);
            endThinkCard();
            schedule();
          } else if (event.type === "progress") {
            // 只说"在想 / 在动手"，具体动的是哪只手等 tool 事件
            if (event.phase === "thinking" && !acts.querySelector(".act")) setThinking(acts, true);
          } else if (event.type === "tool") {
            if (event.status === "start") toolStart(acts, event.name, event.label, event.args);
            else toolEnd(acts, event.name, event.ok !== false, event.output);
            if (state.stick) scrollToEnd();
          } else if (event.type === "delegate") {
            const row = makeAct("派活", `${event.done}/${event.total} ${event.current || ""}`, "run");
            acts.append(row);
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
            const card = renderApprovalCard(event);
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
            if (event.usage) attachUsage(turn.root, event.usage, Date.now() - turnStartMs);
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
    setThinking(acts, false);
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
    collapseActs(acts);
    renderQueue();
    // 排队插话（批次二）：正常收尾就自动续发队列首条；人点了停止则留住队列，
    // 面板上的「继续发送」按钮是明确的再启动入口
    if (!state.stopRequested) submitNext();
    else renderQueue();
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

function openModal(title, build) {
  if (!el.modal) return;
  const wasOpen = modalOpen();
  clearTimeout(modalTimer);
  if (!wasOpen) {
    const active = document.activeElement;
    // 从项目弹层里点开的：焦点回 pill，别回一个马上要被 hidden 的菜单项
    modalReturnFocus =
      active instanceof HTMLElement && !active.closest("#proj-menu")
        ? active
        : projectAnchor || el.projectPill;
  }
  el.modal.hidden = false;
  el.modal.classList.remove("is-closing", "is-open");
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
    // 服务端换模型会把不支持的档位落回 ≤ 当前档（off 兜底），本地跟着对齐
    localStorage.setItem(KEY_THINKING, clampThinking(currentThinking(), levels));
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
// 面板里上次看的供应商（仅定位视图，同 KEY_MODEL_PROVIDER 的口径，不等于切模型）
let chatSettingsPreferred = "";
let csPage = "home"; // home | model | policy | notify
let csTimer = 0;
let csCatalog = null; // 打开抽屉时现拉的模型目录（同原「每次打开现拉」口径）
let csPolicy = null;  // 打开抽屉时顺带拉的权限档；失败保持 null（副文本显示 —）

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
    csPage = "home";
    renderCsPage();
    openDrawer();
    // 权限档副文本顺带拉，回来若还停在首页就重渲染补上
    void refreshCsPolicy();
  } catch (error) {
    if (error.message !== "forbidden") toast("拿不到模型清单");
  } finally {
    el.chatSettingsBtn.disabled = false;
  }
}

async function refreshCsPolicy() {
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    if (response.ok) {
      csPolicy = await response.json();
      if (csPage === "home" && drawerOpen()) renderCsHome();
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
  chevron: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
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

function csRow({ icon, title, sub, onClick }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "cs-row";
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
    main.append(subNode);
  }
  row.append(main);
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
  if (csPage === "model") renderCsModelPage();
  else if (csPage === "policy") renderCsPolicyPage();
  else if (csPage === "notify") renderCsNotifyPage();
  else renderCsHome();
}

function renderCsHome() {
  const drawer = el.chatSettingsDrawer;
  if (!drawer) return;
  drawer.replaceChildren(csHead("对话设置"));
  const body = document.createElement("div");
  body.className = "cs-body";

  const catalog = csCatalog;
  const current = catalog && catalog.current;
  const timing = localStorage.getItem(KEY_NOTIFY_TIMING) || "all";
  const notifyOn = localStorage.getItem(KEY_NOTIFY) === "1";

  body.append(
    csRow({
      icon: "cpu",
      title: "模型",
      sub: current ? modelLabel(catalog) || current.modelId : "还没有可用模型",
      onClick: () => {
        csPage = "model";
        renderCsPage();
      },
    }),
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
    csRow({
      icon: "settings",
      title: "全部设置",
      sub: "",
      onClick: () => {
        closeChatSettings();
        location.hash = "#/settings";
      },
    }),
  );
  drawer.append(body);
}

/* ── 二级页 · 模型：原下弹面板整体搬入（渲染函数零语义改动，只换宿主）── */
function renderCsModelPage() {
  const drawer = el.chatSettingsDrawer;
  const catalog = csCatalog;
  if (!drawer || !catalog) return;
  drawer.replaceChildren(csHead("模型", { back: true }));
  const body = document.createElement("div");
  body.className = "cs-body";
  body.style.padding = "6px";
  drawer.append(body);

  // 上半：模型切换（与 composer 模型菜单同一份渲染；切模型/换档逻辑全部复用）
  const modelPart = document.createElement("div");
  modelPart.className = "chat-settings-models";
  body.append(modelPart);
  renderModelMenu(catalog, chatSettingsPreferred, modelPart);

  // 下半：一行一个模型批量添加（加到模型区当前选中的供应商）
  const batch = document.createElement("div");
  batch.className = "chat-settings-batch";
  batch.innerHTML = `
    <div class="batch-head">
      <span>批量添加模型</span>
      <span class="batch-target" id="batch-target"></span>
    </div>
    <textarea class="batch-input is-mono" id="batch-models" rows="4" spellcheck="false"
      aria-label="一行一个模型 ID" placeholder="一行一个模型 ID，例如：\nqwen3-max\nqwen-plus"></textarea>
    <div class="batch-actions">
      <span class="set-hint batch-hint" id="batch-hint"></span>
      <button class="ghost" type="button" id="batch-import">导入</button>
    </div>`;
  body.append(batch);
  syncChatSettingsTarget();

  batch.querySelector("#batch-import")?.addEventListener("click", () => {
    const providerId = chatSettingsPreferred || catalog.current?.providerId || "";
    void importBatchModels(
      providerId,
      batch.querySelector("#batch-models")?.value || "",
      batch.querySelector("#batch-hint"),
      batch,
    );
  });
}

/** 批量区的「加到」标签跟着模型区当前供应商走（供应商段点击会 dispatch providerchange） */
function syncChatSettingsTarget() {
  if (!el.chatSettingsDrawer) return;
  const active = el.chatSettingsDrawer.querySelector('.provider-opt[aria-pressed="true"]');
  const node = el.chatSettingsDrawer.querySelector("#batch-target");
  if (active) chatSettingsPreferred = active.dataset.provider;
  if (node) {
    node.textContent = active ? `加到：${active.title || active.textContent}` : "";
    node.title = node.textContent;
  }
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
  body.innerHTML = `
    <div class="cs-section">
      <div class="segmented slide" role="radiogroup" aria-label="权限" id="cs-policy-switch">
        <button type="button" data-policy="full" aria-checked="false">完全访问</button>
        <button type="button" data-policy="read-only" aria-checked="false">只读</button>
        <button type="button" data-policy="no-shell" aria-checked="false">不跑命令</button>
      </div>
      <div class="set-hint">决定它能替你动到什么程度：完全访问 = 能改文件、能跑命令。改完立刻生效。</div>
      <div class="divider"></div>
      <div class="cs-row" style="cursor:default">
        <span class="cs-row-main">
          <span class="cs-row-title">写操作逐次确认</span>
          <span class="cs-row-sub">开启后，改文件 / 跑命令 / 派活前先问你一句</span>
        </span>
        ${switchMarkup(csPolicy?.confirmWrites === true, { label: "写操作逐次确认", attrs: 'id="cs-policy-confirm-writes"' })}
      </div>
      <div class="divider"></div>
      <button class="cs-row" type="button" id="cs-approval-entry">
        <span class="cs-row-main">
          <span class="cs-row-title">待处理审批</span>
          <span class="cs-row-sub" id="cs-approval-count">读取中…</span>
        </span>
        <span class="cs-row-chevron">${csSvg(CS_ICONS.chevron).innerHTML}</span>
      </button>
      <div class="set-hint">去全部设置 → 权限里批准 / 拒绝。</div>
    </div>`;
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
        await request("/api/v1/agent/policy", {
          method: "POST",
          body: JSON.stringify({ access: button.dataset.policy }),
        }).catch(() => undefined);
      });
    }
  }

  const confirm = body.querySelector("#cs-policy-confirm-writes");
  confirm?.addEventListener("click", async () => {
    const next = confirm.getAttribute("aria-checked") !== "true";
    confirm.setAttribute("aria-checked", String(next));
    if (csPolicy) csPolicy.confirmWrites = next;
    await request("/api/v1/agent/policy", {
      method: "POST",
      body: JSON.stringify({ confirmWrites: next }),
    }).catch(() => undefined);
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
    <div class="cs-section">
      <div class="cs-row" style="cursor:default">
        <span class="cs-row-main">
          <span class="cs-row-title">桌面通知</span>
          <span class="cs-row-sub">回复完成 / 出错 / 待你处理时提醒；窗口正看着这个会话就不打扰</span>
        </span>
        ${switchMarkup(notifyOn, { label: "桌面通知", attrs: 'id="cs-notify-switch"' })}
      </div>
      <div class="divider"></div>
      <div class="set-hint">提醒哪些时机</div>
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
      renderCsHome();
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
    renderCsHome();
  });

  for (const row of body.querySelectorAll("[data-timing]")) {
    row.addEventListener("click", () => {
      localStorage.setItem(KEY_NOTIFY_TIMING, row.dataset.timing);
      for (const other of body.querySelectorAll("[data-timing]")) {
        other.setAttribute("aria-checked", String(other === row));
        other.querySelector("[data-check]").hidden = other !== row;
      }
      renderCsHome();
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
    return;
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
  } catch (error) {
    if (error.message === "forbidden") {
      closeChatSettings();
      return;
    }
    setHint(`没存上：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
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
  switcher.unavailable = false;
  syncProjectPill();
}

/** pill / 轨道按钮 / 降级态都从这里刷新，别在两处各写一份显示逻辑 */
function syncProjectPill() {
  const switcher = state.switcher;
  const hasWorkspace = Boolean(switcher.workspace);
  // E5：接口读不到（旧后端 404 / 临时 5xx）时**不能把入口藏起来**——藏起来就是
  // 用户看到的"项目凭空没了"。降级成可见的「项目不可用」pill，点一下给 toast 并重试；
  // 下次 hashchange / 启动 / 点击仍会自动恢复。只有 403（令牌门）才保持隐藏。
  const unavailable = Boolean(switcher.unavailable);
  // F1：没有工作区也显示 pill —— 它同时是「设置主项目」的入口，
  // 否则侧栏没有任何地方能打开设置主项目弹窗。
  const label = unavailable
    ? "项目不可用"
    : hasWorkspace
      ? baseNameOf(switcher.workspace?.rootPath) || "主项目"
      : "设置主项目";
  const tip = unavailable
    ? PROJECT_UNAVAILABLE_HINT
    : hasWorkspace
      ? `主项目：${switcher.workspace?.rootPath || ""} · ${switcher.subCount} 个子项目`
      : "设置主项目";

  if (el.sideProj) el.sideProj.hidden = false;
  if (el.railProj) el.railProj.hidden = false;

  if (el.projectPillLabel) el.projectPillLabel.textContent = label;
  if (el.projectPill) {
    el.projectPill.classList.toggle("is-unavailable", unavailable);
    el.projectPill.title = tip;
    el.projectPill.setAttribute(
      "aria-label",
      unavailable ? "项目不可用" : hasWorkspace ? `项目：${label}` : "设置主项目",
    );
  }

  if (el.railProj) {
    el.railProj.classList.toggle("is-unavailable", unavailable);
    // 轨道 tooltip 走 data-tip（自绘右侧气泡），不再用原生 title
    el.railProj.removeAttribute("title");
    el.railProj.dataset.tip = tip;
    el.railProj.setAttribute("aria-label", "项目");
  }
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
      toast(`打不开资源管理器：${data.message || data.error || `HTTP ${response.status}`}`);
      return;
    }
    closeProjectMenu();
  } catch (error) {
    if (error.message !== "forbidden") toast("打不开资源管理器，重启服务后再试");
  }
}

/** 侧栏文件浏览器（只读）：列目录 + 看文本，路径锁在工作区内。 */
function openFileBrowser(projectName, startRel) {
  const browser = { name: projectName, rel: startRel || "" };
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
        viewer.hidden = true;
        list.hidden = false;
      }
    });

    const entryPath = (name) => (browser.rel ? `${browser.rel}/${name}` : name);

    async function load(rel) {
      browser.rel = rel;
      viewer.hidden = true;
      list.hidden = false;
      crumb.textContent = rel ? `${projectName}/${rel}` : `${projectName}/`;
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
          loading.textContent = data.message || `读不到（HTTP ${response.status}）`;
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
      crumb.textContent = `${projectName}/${path}`;
      try {
        const response = await request(`/api/v1/files/content?path=${encodeURIComponent(path)}`, {
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          viewer.textContent = data.message || `读不到（HTTP ${response.status}）`;
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
 *  资源管理器按项目直达自己的根（用户诉求：多个工作区不知道打开哪个），文件浏览器只读看文本。 */
function renderProjectMenu(items) {
  const menu = el.projectMenu;
  if (!menu) return;
  menu.replaceChildren();
  const workspace = state.switcher.workspace;
  const hasWorkspace = Boolean(workspace?.rootPath);

  if (hasWorkspace) {
    const main = document.createElement("div");
    main.className = "proj-item is-static is-main";
    main.title = workspace.rootPath;
    const mainName = document.createElement("span");
    mainName.className = "proj-item-name";
    mainName.textContent = baseNameOf(workspace.rootPath) || "主项目";
    const mainTag = document.createElement("span");
    mainTag.className = "proj-tag";
    mainTag.textContent = "主项目";
    main.append(projectIcon("main"), mainName, mainTag);
    // 文件入口：主项目行尾「在资源管理器中打开」+「浏览文件」（相对路径 = 工作区根）
    main.append(
      projActionButton("browse", "浏览文件", "在界面里看这个目录的文件", () => openFileBrowser(baseNameOf(workspace.rootPath) || "主项目", "")),
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
          openFileBrowser(project.name, startRel || ""),
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
  // projectAnchor 指向最后用过的触发点：pill 或轨道按钮，aria-expanded 才对得上
  closePopover(el.projectMenu, projectAnchor || el.projectPill);
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

el.projectPill?.addEventListener("click", () => void toggleProjectMenu(el.projectPill));
el.railProj?.addEventListener("click", () => void toggleProjectMenu(el.railProj));

el.modelPill?.addEventListener("click", () => void toggleModelMenu());
// 菜单里的点击不冒泡到「点外面就关」的判定：点供应商段会就地重渲染，
// 被替换掉的旧按钮已经脱离文档，冒泡到 document 时会被当成外部点击误关。
el.modelMenu?.addEventListener("click", (event) => event.stopPropagation());

// 对话右上角快捷设置（2026-11-07 抽屉改造）：三通道关闭 = Esc / X / 点遮罩；供应商段切换时同步批量区「加到」标签
el.chatSettingsBtn?.addEventListener("click", () => void toggleChatSettings());
el.chatSettingsOverlay?.addEventListener("click", () => closeChatSettings());
el.chatSettingsDrawer?.addEventListener("providerchange", () => syncChatSettingsTarget());
// 附件按钮只弹占位提示，不发请求
el.composerAdd?.addEventListener("click", () => toast("附件还没接上，先占个位"));

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
  // 模态在最上层：先关它，别同时把下面的弹层/路由也收掉。
  // stopImmediatePropagation 是给 reduced-motion 的：没有动画时 modalOpen()
  // 立刻变 false，第二个全局 Esc 监听会以为是普通返回。
  if (modalOpen()) {
    event.stopImmediatePropagation();
    closeModal();
    return;
  }
  closeModelMenu();
  closeChatSettings();
  closeProjectMenu();
});

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = el.input.value.trim();
  if (!text) return;
  el.input.value = "";
  resize();
  // 忙时不再拒发：进队列（批次二），本轮结束后自动依次真发
  if (state.sending) {
    if (state.queue.length < QUEUE_MAX) {
      state.queue.push(text);
      renderQueue();
    }
    return;
  }
  void send(text);
});

el.input.addEventListener("input", () => {
  resize();
  syncSendEnabled();
});

el.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  const modSend = localStorage.getItem(KEY_SEND) === "mod-enter";
  const withMod = event.metaKey || event.ctrlKey;
  // Enter 模式：不带修饰键就发送（Shift 仍是换行）；Ctrl+Enter 模式：必须带修饰键
  if (modSend ? withMod : !event.shiftKey && !withMod) {
    event.preventDefault();
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

el.newChat.addEventListener("click", () => {
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

/* ── 收起轨道（2026-11-05 F1 / E4 重排）──────────────────
   收起不再是整栏消失：72px 图标轨上「新建对话 / 总管 / 任务中心 / 项目 / 设置」是真功能；
   执事占位与群组占位都保留（群组仍 disabled），执事不在轨道展开，悬停提示去展开侧栏。
   领域负责人占位移除：领域概览并入执事花名册，#/domains 独立页与路由原样保留。 */
el.railNew.addEventListener("click", () => {
  if (!sidebarOpen()) toggleSidebar();
  go("chat");
  startNewChat("worker");
});
el.railSettings.addEventListener("click", () => go("settings"));
// 总管首字圆钮 → 打开主对话；执事占位 → 展开侧栏看花名册
el.railChief.addEventListener("click", openChiefChat);
el.railPartners.addEventListener("click", () => {
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
    id: "avatars",
    label: "头像",
    icon: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>',
  },
  {
    id: "partners",
    label: "执事",
    icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
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
      row.addEventListener("click", () => {
        go("chat");
        void openChat(hit.conversationId);
      });
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
  } else if (page === "avatars") {
    el.settingsInner.innerHTML = avatarSettingsMarkup();
    void wireAvatarSettings();
  } else if (page === "partners") {
    el.settingsInner.innerHTML = sectionMarkup(
      "执事",
      `<div class="pt-head">
        <div class="row-main">
          <div class="set-card-title">总管与执事</div>
          <div class="set-hint">总管照常列出。SOUL 版本、模型候选链、例行任务都在「编辑」里。</div>
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

/* ── 头像设置（预设图库 + 本地上传）────────────────────── */
const AVATAR_PRESET_FILES = {
  male: Array.from({ length: 10 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`),
  female: Array.from({ length: 20 }, (_, i) => `f${String(i + 1).padStart(2, "0")}`),
};
const AVATAR_PRESET_URL = (file) => `/assets/preset/${file}.png`;

function avatarSettingsMarkup() {
  return sectionMarkup(
    "头像",
    `<div class="card">
      ${rowMarkup("选择对象", "总管和每个执事都能单独换头像", `<div class="av-targets" id="av-targets"><div class="set-hint">读取中…</div></div>`)}
    </div>
    <div class="card" id="av-editor-card" hidden>
      <div class="av-editor">
        <div class="av-preview-col">
          <span class="pt-avatar av-preview" id="av-preview" aria-hidden="true"></span>
          <span class="set-hint" id="av-editor-name"></span>
        </div>
        <div class="av-main">
          <div class="av-filter segmented" role="radiogroup" aria-label="预设筛选" id="av-filter">
            <button type="button" data-av-filter="all" aria-checked="true">全部</button>
            <button type="button" data-av-filter="male" aria-checked="false">男生</button>
            <button type="button" data-av-filter="female" aria-checked="false">女生</button>
          </div>
          <div class="av-grid" id="av-grid"></div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="av-actions">
        <button class="ghost" id="av-upload" type="button">选择本地图片</button>
        <button class="ghost" id="av-clear" type="button">清除头像</button>
        <button class="btn-primary" id="av-save" type="button" disabled>保存</button>
      </div>
      <input type="file" id="av-file" accept="image/png,image/jpeg,image/webp" hidden />
      <p class="modal-hint" id="av-hint">点预设或上传本地图片，再点「保存」生效；未设置时显示名字首字。</p>
    </div>`,
  );
}

async function wireAvatarSettings() {
  const targets = document.getElementById("av-targets");
  const editorCard = document.getElementById("av-editor-card");
  const grid = document.getElementById("av-grid");
  const preview = document.getElementById("av-preview");
  const editorName = document.getElementById("av-editor-name");
  const hint = document.getElementById("av-hint");
  const saveBtn = document.getElementById("av-save");
  const uploadBtn = document.getElementById("av-upload");
  const clearBtn = document.getElementById("av-clear");
  const fileInput = document.getElementById("av-file");
  const filterBox = document.getElementById("av-filter");
  if (!targets || !editorCard) return;

  if (!state.partners.length) {
    try {
      const resp = await request("/api/v1/partners", { cache: "no-store" });
      const data = await resp.json().catch(() => ({}));
      if (Array.isArray(data.partners)) state.partners = data.partners;
    } catch (error) {
      if (error.message === "forbidden") return;
      targets.innerHTML = `<div class="set-hint is-error">读不到：${esc(error.message)}</div>`;
      return;
    }
  }
  const partners = state.partners;
  if (!partners.length) {
    targets.innerHTML = `<div class="set-hint">还没有可编辑的对象。</div>`;
    return;
  }

  let targetId = partners.some((p) => p.id === "chief") ? "chief" : partners[0].id;
  let draft = null;
  let dirty = false;
  let presetFile = null;
  let filter = "all";
  let busy = false;
  let decodeSeq = 0;

  // 不缓存数组引用：loadRoster() 会用 GET 结果整体替换 state.partners，
  // 这里始终读最新数组，避免保存后重渲染画到旧数组。
  const current = () => state.partners.find((p) => p.id === targetId);
  const nameOf = (p) => String(p?.name || "").trim() || (p?.id === "chief" ? "总管" : "执事");
  const setHint = (text, isError = true) => {
    hint.textContent = text;
    hint.classList.toggle("is-error", Boolean(isError && text));
  };

  function renderTargets() {
    targets.replaceChildren();
    for (const p of state.partners) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "av-target" + (p.id === targetId ? " is-active" : "");
      b.setAttribute("aria-pressed", String(p.id === targetId));
      const slot = document.createElement("span");
      slot.className = "pt-avatar av-target-avatar";
      const label = document.createElement("span");
      label.className = "av-target-name";
      label.textContent = nameOf(p);
      b.append(slot, label);
      paintAvatar(slot, p.avatar || null, nameOf(p));
      b.addEventListener("click", () => selectTarget(p.id));
      targets.append(b);
    }
  }

  function renderGrid() {
    grid.replaceChildren();
    const files = filter === "all"
      ? [...AVATAR_PRESET_FILES.male, ...AVATAR_PRESET_FILES.female]
      : AVATAR_PRESET_FILES[filter];
    for (const file of files) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "av-preset" + (file === presetFile ? " is-active" : "");
      b.title = file;
      b.setAttribute("aria-label", `预设 ${file}`);
      const img = document.createElement("img");
      img.src = AVATAR_PRESET_URL(file);
      img.alt = "";
      img.decoding = "async";
      img.setAttribute("aria-hidden", "true");
      b.append(img);
      b.addEventListener("click", () => void applyPreset(file));
      grid.append(b);
    }
  }

  function syncPreview() {
    paintAvatar(preview, draft, nameOf(current()));
    editorName.textContent = nameOf(current());
  }

  function setDirtyState(value) {
    dirty = value;
    saveBtn.disabled = busy || !dirty;
  }

  function selectTarget(id) {
    if (busy) return;
    targetId = id;
    const p = current();
    draft = p?.avatar || null;
    presetFile = null;
    setDirtyState(false);
    editorCard.hidden = false;
    renderTargets();
    renderGrid();
    syncPreview();
    setHint("选好后点「保存」生效。", false);
  }

  async function applyPreset(file) {
    if (busy) return;
    const seq = ++decodeSeq;
    busy = true;
    saveBtn.disabled = true;
    setHint("读取预设…", false);
    try {
      const resp = await fetch(AVATAR_PRESET_URL(file), { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("预设读不出来"));
        reader.readAsDataURL(blob);
      });
      if (seq !== decodeSeq) return;
      const problem = avatarDataProblem(dataUrl);
      if (problem) throw new Error(problem);
      draft = dataUrl;
      presetFile = file;
      setDirtyState(true);
      syncPreview();
      renderGrid();
      setHint("已选预设，点「保存」生效。", false);
    } catch (error) {
      if (seq !== decodeSeq) return;
      setHint(error.message);
    } finally {
      if (seq === decodeSeq) {
        busy = false;
        saveBtn.disabled = !dirty;
      }
    }
  }

  filterBox?.querySelectorAll("[data-av-filter]").forEach((b) => {
    b.addEventListener("click", () => {
      filter = b.dataset.avFilter;
      filterBox.querySelectorAll("[data-av-filter]").forEach((x) =>
        x.setAttribute("aria-checked", String(x === b)));
      renderGrid();
    });
  });

  uploadBtn?.addEventListener("click", () => { if (!busy) fileInput.click(); });
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file || busy) return;
    const seq = ++decodeSeq;
    busy = true;
    saveBtn.disabled = true;
    setHint("处理中…", false);
    try {
      const dataUrl = await fileToAvatarPng(file);
      if (seq !== decodeSeq) return;
      draft = dataUrl;
      presetFile = null;
      setDirtyState(true);
      syncPreview();
      renderGrid();
      setHint("已选本地图片，点「保存」生效。", false);
    } catch (error) {
      if (seq !== decodeSeq) return;
      setHint(error.message);
    } finally {
      if (seq === decodeSeq) {
        busy = false;
        saveBtn.disabled = !dirty;
      }
    }
  });

  clearBtn?.addEventListener("click", () => {
    if (busy) return;
    decodeSeq += 1;
    draft = null;
    presetFile = null;
    setDirtyState(true);
    syncPreview();
    renderGrid();
    setHint("将清除头像，点「保存」生效。", false);
  });

  saveBtn?.addEventListener("click", async () => {
    if (!dirty || busy) return;
    const payload = draft;
    busy = true;
    saveBtn.disabled = true;
    setHint("保存中…", false);
    try {
      const resp = await request(`/api/v1/partners/${encodeURIComponent(targetId)}`, {
        method: "PATCH",
        body: JSON.stringify({ avatar: payload }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.message || data.error || `HTTP ${resp.status}`);
      draft = data.partner?.avatar ?? null;
      setDirtyState(false);
      const cached = state.partners.find((p) => p.id === targetId);
      if (cached) cached.avatar = draft;
      syncChiefAvatar();
      void loadRoster();
      syncPreview();
      renderTargets();
      toast("头像已保存");
      setHint("头像已保存。", false);
    } catch (error) {
      if (error.message === "forbidden") return;
      setHint(`没存成：${error.message}`);
    } finally {
      busy = false;
      saveBtn.disabled = !dirty;
    }
  });

  renderTargets();
  selectTarget(targetId);
}

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
      request("/api/v1/projects", { cache: "no-store" }),
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

function renderProjectList(workspace, projects) {
  const box = document.getElementById("project-list");
  if (!box) return;
  if (!projects.length) {
    box.innerHTML = `<div class="set-empty">
      <div class="set-card-title">还没有登记项目</div>
      <div class="set-hint">确认一条新建请求后，项目会出现在这里；派活时也从这里选。</div>
    </div>`;
    return;
  }
  box.innerHTML = projects
    .map((project) => {
      const relativePath = relativeProjectPath(workspace?.rootPath, project.rootPath);
      // 状态点优先级：目录丢失（黄）> 工作区外（灰）> 在（绿）
      const dot = project.exists === false ? "warn" : project.insideWorkspace === false ? "idle" : "ok";
      const badges = [
        `<span class="pill-tag">${project.vcs === "git" ? "git" : "无版本控制"}</span>`,
        project.exists === false
          ? '<span class="pill-tag warn">目录丢失</span>'
          : '<span class="pill-tag ok">在</span>',
        project.archived ? '<span class="pill-tag">已归档</span>' : "",
        project.insideWorkspace === false ? '<span class="pill-tag">工作区外</span>' : "",
      ]
        .filter(Boolean)
        .join("");
      return `<div class="proj-card">
        <i class="status-dot ${dot}" aria-hidden="true"></i>
        <div class="proj-card-main">
          <div class="proj-card-title">${esc(project.name)}</div>
          <div class="proj-card-path">${esc(relativePath)}</div>
          <div class="proj-card-tags">${badges}</div>
        </div>
      </div>`;
    })
    .join("");
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
        const deadline = Date.parse(item.deadlineAt || "");
        const left = Number.isFinite(deadline)
          ? Math.max(0, Math.round((deadline - Date.now()) / 1000))
          : null;
        const remain =
          left === null ? "" : left > 0 ? `剩余 ${left} 秒，超时按拒绝处理` : "已超时";
        return `${index ? '<div class="divider"></div>' : ""}
        <div class="row">
          <div class="row-main">
            <div class="row-label">${esc(item.chatTitle || "未命名会话")} · ${esc(item.tool || "工具")}${item.origin === "autonomous" ? '<span class="pill-tag">例行任务</span>' : ""}</div>
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
    card.innerHTML = `
      <div class="pt-card-head">
        ${ptStatusDot(partner.status, partner.id)}
        <span class="pt-avatar pt-card-avatar" data-avatar-for="${attr(partner.id)}" aria-hidden="true"></span>
        <span class="row-label pt-name">${esc(partner.name || "")}</span>
        ${isChief ? '<span class="pill-tag">总管</span>' : ""}
        ${ptStatusPill(partner.status)}
      </div>
      <div class="pt-meta">
        <span class="kv">SOUL v${esc(String(partner.soulVersion ?? "—"))}</span>
        ${partner.domain ? `<span class="pt-domain kv">领域 · ${esc(String(partner.domain))}</span>` : ""}
      </div>
      <div class="pt-actions">
        <button class="ghost" type="button" data-pt-edit="${attr(partner.id)}">编辑</button>
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
      <p class="modal-desc">给执事起个名字。填了领域就是总管执事的分管宰相，建好之后领域不可改。</p>
      <div class="modal-field">
        <span>名字（≤40 字）</span>
        <input class="modal-input" id="pt-new-name" type="text" maxlength="40" placeholder="例如：小助手" />
      </div>
      <div class="modal-field">
        <span>领域（可选）</span>
        <input class="modal-input is-mono" id="pt-new-domain" type="text" spellcheck="false"
               placeholder="小写 ASCII 领域名，建了就是总管执事" />
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

/* ── 编辑执事模态（三段：SOUL / 模型候选链 / 例行任务）── */

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
  openModal("编辑执事", (body) => ptBuildEditModal(body, partnerId, detail));
}

function ptBuildEditModal(body, partnerId, detail) {
  const partner = detail.partner || {};
  const soul = String(detail.soul ?? "");
  const chain = Array.isArray(detail.modelChain) ? detail.modelChain : [];
  const chainText = chain.map((item) => `${item.providerId}|${item.modelId}|${item.keyEnv}`).join("\n");
  body.innerHTML = `
    <div class="pt-edit">
      <div class="pt-seg">
        <div class="pt-seg-head">
          <span class="pt-seg-title">头像</span>
          <span class="kv">PNG / JPEG / WebP · ≤5MiB</span>
        </div>
        <div class="pt-avatar-row">
          <button class="pt-avatar avatar-edit pt-avatar-preview" id="pt-avatar-preview" type="button"
                  aria-label="选择本地图片作为头像" title="选择本地图片"></button>
          <div class="pt-avatar-btns">
            <button class="ghost" id="pt-avatar-pick" type="button">选择图片</button>
            <button class="ghost" id="pt-avatar-clear" type="button">清除</button>
            <button class="btn-primary" id="pt-avatar-save" type="button" disabled>保存头像</button>
          </div>
        </div>
        <input type="file" id="pt-avatar-file" accept="image/png,image/jpeg,image/webp" hidden />
        <p class="modal-hint" id="pt-avatar-hint">会缩到最长边 256px 并转成 PNG 保存在服务端；未设置时显示名字首字。</p>
      </div>

      <div class="pt-seg pt-basic">
        <label class="modal-field">
          <span>名字</span>
          <div class="modal-row">
            <input class="modal-input" id="pt-name" type="text" maxlength="40" value="${attr(partner.name || "")}" />
            <button class="ghost" id="pt-name-save" type="button">改名</button>
          </div>
        </label>
        <label class="modal-field">
          <span>领域（建后不可改）</span>
          <input class="modal-input is-mono" id="pt-domain" type="text" value="${attr(partner.domain || "")}"
                 placeholder="普通执事没有领域" readonly />
        </label>
      </div>

      <div class="pt-seg">
        <div class="pt-seg-head">
          <span class="pt-seg-title">SOUL · 身份</span>
          <span class="kv" id="pt-soul-version">当前 v${esc(String(detail.soulVersion ?? "—"))}</span>
        </div>
        <textarea class="pt-ta is-soul" id="pt-soul" rows="12" spellcheck="false">${esc(soul)}</textarea>
        <p class="modal-hint" id="pt-soul-hint"></p>
        <div class="pt-actions">
          <button class="btn-primary" id="pt-soul-save" type="button">保存 SOUL</button>
        </div>
      </div>

      <div class="pt-seg">
        <div class="pt-seg-title">模型候选链</div>
        <p class="set-hint">每行一条 <span class="kv">providerId|modelId|KEY_ENV_NAME</span>；空行与 # 注释跳过，最多 5 行；留空保存即清空链。只填环境变量名，不要填密钥值。</p>
        <textarea class="pt-ta" id="pt-chain" rows="6" spellcheck="false">${esc(chainText)}</textarea>
        <p class="modal-hint" id="pt-chain-hint"></p>
        <div class="pt-actions">
          <button class="btn-primary" id="pt-chain-save" type="button">保存候选链</button>
        </div>
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

  ptWireAvatarEditor(body, partnerId, partner);

  const soulArea = body.querySelector("#pt-soul");
  const soulHint = body.querySelector("#pt-soul-hint");
  body.querySelector("#pt-soul-save")?.addEventListener("click", () => void ptSaveSoul(partnerId, soulArea, soulHint, body));
  soulArea.addEventListener("input", () => clearModalHint(soulHint));

  const chainArea = body.querySelector("#pt-chain");
  const chainHint = body.querySelector("#pt-chain-hint");
  body.querySelector("#pt-chain-save")?.addEventListener("click", () => void ptSaveChain(partnerId, chainArea, chainHint, body));
  chainArea.addEventListener("input", () => clearModalHint(chainHint));

  const listBox = body.querySelector("#pt-routine-list");
  body.querySelector("#pt-routine-refresh")?.addEventListener("click", () => void ptRenderRoutineList(listBox, partnerId));
  ptWireRoutineForm(body, partnerId, listBox);
  void ptRenderRoutineList(listBox, partnerId);
}

/* 头像编辑（2026-11-06 C 批）：选择 → 本地预览 → 保存才写服务端；清除也走同一次保存。
 * 取消 / 关闭模态不会改任何东西；坏图 / 超限只改提示，不覆盖已有头像。 */
function ptWireAvatarEditor(body, partnerId, partner) {
  const preview = body.querySelector("#pt-avatar-preview");
  const fileInput = body.querySelector("#pt-avatar-file");
  const hint = body.querySelector("#pt-avatar-hint");
  const save = body.querySelector("#pt-avatar-save");
  const pickButton = body.querySelector("#pt-avatar-pick");
  const clearButton = body.querySelector("#pt-avatar-clear");
  const name = String(partner.name || "").trim() || "执事";
  let draft = partner.avatar || null;
  let dirty = false;
  // 选图解码是异步的：每次选图 / 清除都推进序号，迟到的结果不许覆盖最新草稿。
  let decodeSeq = 0;
  let decoding = false;
  let saving = false;

  // 模态关闭后 body 会从 DOM 摘掉：所有异步后续先看这个，不再碰失效节点。
  const alive = () => body.isConnected;

  const refreshSave = () => {
    if (save) save.disabled = saving || decoding || !dirty;
  };
  const setDirty = (value) => {
    dirty = value;
    refreshSave();
  };
  const setSaving = (value) => {
    saving = value;
    if (fileInput) fileInput.disabled = value;
    if (pickButton) pickButton.disabled = value;
    if (clearButton) clearButton.disabled = value;
    if (preview) preview.disabled = value;
    refreshSave();
  };

  paintAvatar(preview, draft, name);
  refreshSave();

  const pick = () => {
    if (!saving && alive()) fileInput?.click();
  };

  preview?.addEventListener("click", pick);
  pickButton?.addEventListener("click", pick);

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ""; // 同一张图再选一次也能触发 change
    if (!file || saving || !alive()) return;
    const seq = ++decodeSeq;
    decoding = true;
    refreshSave();
    setModalHint(hint, "处理中…", false);
    try {
      const dataUrl = await fileToAvatarPng(file);
      if (seq !== decodeSeq || !alive()) return; // 选 A 后清除 / 选 B：A 迟到就作废
      draft = dataUrl;
      setDirty(true);
      paintAvatar(preview, draft, name);
      setModalHint(hint, "已选好，点「保存头像」生效。", false);
    } catch (error) {
      if (seq !== decodeSeq || !alive()) return; // 迟到的失败也不许改最新提示
      setModalHint(hint, error.message || "这张图片不能用作头像");
    } finally {
      if (seq === decodeSeq) {
        decoding = false;
        if (alive()) refreshSave();
      }
    }
  });

  clearButton?.addEventListener("click", () => {
    if (saving || !alive()) return;
    decodeSeq += 1; // 清掉正在解码的选图：清空是最后意图
    decoding = false;
    draft = null;
    setDirty(true);
    paintAvatar(preview, draft, name);
    setModalHint(hint, "已清除，点「保存头像」生效。", false);
  });

  save?.addEventListener("click", async () => {
    if (!dirty || saving || decoding || !alive()) return;
    const payload = draft;
    setSaving(true); // 保存期间禁止选择 / 清除 / 重复保存，旧响应没有机会覆盖新草稿
    setModalHint(hint, "保存中…", false);
    try {
      const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
        method: "PATCH",
        body: JSON.stringify({ avatar: payload }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (alive()) {
          setModalHint(hint, data.message || data.error || `没存成：HTTP ${response.status}`);
        }
        return;
      }
      draft = data.partner?.avatar ?? null;
      dirty = false;
      // 缓存同步：侧栏（展开 + 轨道）与设置页都从 state.partners 取头像。
      // 即使模态已经关了也同步缓存；DOM 只在 body 还活着时碰。
      const cached = state.partners.find((item) => item.id === partnerId);
      if (cached) cached.avatar = draft;
      syncChiefAvatar();
      void loadRoster();
      void loadPartners();
      if (!alive()) return;
      paintAvatar(preview, draft, name);
      setModalHint(hint, "头像已保存。", false);
    } catch (error) {
      if (alive() && error.message !== "forbidden") setModalHint(hint, `没存成：${error.message}`);
    } finally {
      if (alive()) setSaving(false);
    }
  });
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

async function ptSaveSoul(partnerId, area, hint, host) {
  const soul = area.value;
  if (!soul.trim()) { setModalHint(hint, "SOUL 不能为空"); return; }
  const button = host.querySelector("#pt-soul-save");
  if (button) button.disabled = true;
  setModalHint(hint, "保存中…", false);
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ soul }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setModalHint(hint, data.message || data.error || `没存成：HTTP ${response.status}`); return; }
    setModalHint(hint, "", false);
    toast("已保存为新版本，下一轮生效");
    if (data.soulVersion != null) {
      const version = host.querySelector("#pt-soul-version");
      if (version) version.textContent = `当前 v${data.soulVersion}`;
    }
    void loadPartners();
  } catch (error) {
    if (error.message === "forbidden") { closeModal(); return; }
    setModalHint(hint, `没存成：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

/** 把按行编辑的文本解析成候选链数组；前端先拦行数 / 结构 / keyEnv 形状。 */
function ptParseChain(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length > 5) return { error: "候选链最多 5 行，先删掉多余的" };
  const items = [];
  for (const line of lines) {
    const parts = line.split("|").map((part) => part.trim());
    // 密钥值优先拦：第三段不是合法 env 名（或混进了 sk- 之类的值）就给密钥纪律提示
    if (parts.length >= 3 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[2])) {
      return { error: "只填环境变量名，不要填密钥值" };
    }
    if (parts.length !== 3 || !parts[0] || !parts[1]) {
      return { error: "每行格式：providerId|modelId|KEY_ENV_NAME" };
    }
    items.push({ providerId: parts[0], modelId: parts[1], keyEnv: parts[2] });
  }
  return { items };
}

async function ptSaveChain(partnerId, area, hint, host) {
  const parsed = ptParseChain(area.value);
  if (parsed.error) { setModalHint(hint, parsed.error); return; }
  const button = host.querySelector("#pt-chain-save");
  if (button) button.disabled = true;
  setModalHint(hint, "保存中…", false);
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ modelChain: parsed.items }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setModalHint(hint, data.message || data.error || `没存成：HTTP ${response.status}`); return; }
    setModalHint(hint, "", false);
    toast(parsed.items.length ? `候选链已保存（${parsed.items.length} 项）` : "候选链已清空");
    if (data.soulVersion != null) {
      const version = host.querySelector("#pt-soul-version");
      if (version) version.textContent = `当前 v${data.soulVersion}`;
    }
  } catch (error) {
    if (error.message === "forbidden") { closeModal(); return; }
    setModalHint(hint, `没存成：${error.message}`);
  } finally {
    if (button) button.disabled = false;
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
  current: null, // 当前打开的群（含 members）
  messages: [],
  lastSeq: 0,
  sending: false,
  streamSender: null, // 正在流式的那位（start 帧的 sender）
  streamBubble: null, // 正在流式的气泡 DOM
  streamText: "",
  picked: [], // 建群弹窗里勾中的成员 id（弹窗期间的状态）
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
  for (const button of [el.railGroups, el.sideGroup]) {
    if (!button) continue;
    button.disabled = !on;
    button.title = on ? "群组" : "群组未启用";
  }
  if (el.groupList) el.groupList.hidden = !on;
  if (el.groupCreate) el.groupCreate.hidden = !on;
}

/** 侧栏「群组」节：群名 + 成员数；点击进会话视图。 */
function renderGroupSidebar() {
  if (!el.groupList || groups.available !== true) return;
  el.groupList.replaceChildren();
  if (!groups.list.length) {
    const empty = document.createElement("div");
    empty.className = "roster-empty";
    empty.textContent = "还没有群组。点「群组」新建一个。";
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
    avatar.textContent = group.name.slice(0, 1);

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
      "<p>把 2–6 名执事拉进同一条会话：@点名谁发言，不 @ 就发给值日执事。</p>",
    ].join("");
    el.groupsBody.append(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "group-grid";
  for (const group of groups.list) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "group-card";
    card.dataset.groupId = group.id;

    const head = document.createElement("div");
    head.className = "group-card-head";
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar group-card-avatar";
    avatar.textContent = group.name.slice(0, 1);
    const name = document.createElement("span");
    name.className = "group-card-name";
    name.textContent = group.name;
    head.append(avatar, name);

    const meta = document.createElement("div");
    meta.className = "group-card-meta";
    const duty = group.members.find((m) => m.partnerId === group.responderPartnerId);
    meta.textContent = `${group.members.length} 名成员${duty ? ` · 值日 ${duty.name}` : ""}${
      group.responderKind === "everyone" ? " · 不 @ 全员回" : group.responderKind === "mentions" ? " · 只回点名" : ""
    }`;

    const memberLine = document.createElement("div");
    memberLine.className = "group-card-members";
    memberLine.textContent = group.members.map((m) => m.name).join("、");

    card.append(head, meta, memberLine);
    card.addEventListener("click", () => {
      location.hash = `#/group/${group.id}`;
    });
    grid.append(card);
  }
  el.groupsBody.append(grid);
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
  updateGroupSendState();
  el.groupInput.focus();
}

/* ── 时间线渲染：四形态 ──────────────────────────────────
 * 主人右对齐气泡 / 成员左对齐（头像+名字+时间）/ 系统行居中发丝线 /
 * 5 分钟内同作者合并（名字行只画一次）+ 跨天分割线。 */

const GROUP_MERGE_MS = 5 * 60 * 1000;

function renderGroupTimeline() {
  el.groupThread.replaceChildren();
  let lastRendered = null; // { key, day }
  for (const message of groups.messages) {
    appendGroupMessageToThread(message, lastRendered);
    lastRendered = {
      key: groupAuthorKey(message),
      day: groupDayOf(message),
    };
  }
  el.groupThread.scrollIntoView({ block: "end" });
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

function appendGroupMessageToThread(message, lastRendered) {
  const day = groupDayOf(message);
  if (!lastRendered || lastRendered.day !== day) {
    const divider = document.createElement("div");
    divider.className = "group-day";
    divider.textContent = day;
    el.groupThread.append(divider);
  }
  const at = Date.parse(message.at || "") || 0;
  const merge =
    lastRendered &&
    lastRendered.key === groupAuthorKey(message) &&
    message.kind === "message" &&
    at - (message._prevAt || 0) < GROUP_MERGE_MS;

  if (message.kind === "system") {
    const line = document.createElement("div");
    line.className = "group-sys";
    line.textContent = message.content;
    el.groupThread.append(line);
    return;
  }

  const mine = message.authorKind === "user";
  const bubble = document.createElement("div");
  bubble.className = `gmsg ${mine ? "me" : "them"}`;
  bubble.dataset.msgId = message.id;

  if (!mine) {
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar gmsg-avatar";
    avatar.textContent = (message.authorName || "?").slice(0, 1);
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
  body.textContent = message.content;
  stack.append(body);
  bubble.append(stack);
  el.groupThread.append(bubble);
}

function formatGroupTime(at) {
  const value = Date.parse(at || "");
  if (!Number.isFinite(value)) return "";
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ── 群 composer：发送（SSE 回合）─────────────────────── */

function resizeGroupInput() {
  if (!el.groupInput) return;
  el.groupInput.style.height = "auto";
  el.groupInput.style.height = `${Math.min(el.groupInput.scrollHeight, 160)}px`;
}

function updateGroupSendState() {
  if (!el.groupInput || !el.groupSend) return;
  el.groupSend.disabled = groups.sending || !el.groupInput.value.trim();
  el.groupStop.hidden = !groups.sending;
  el.groupSend.hidden = groups.sending;
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
  appendGroupMessageToThread(localMessage, lastRenderedMeta());
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

function lastRenderedMeta() {
  for (let i = groups.messages.length - 2; i >= 0; i -= 1) {
    const message = groups.messages[i];
    return { key: groupAuthorKey(message), day: groupDayOf(message) };
  }
  return null;
}

function rollbackLocalMessage(localId, text) {
  groups.messages = groups.messages.filter((m) => m.id !== localId);
  const bubble = el.groupThread.querySelector(`[data-msg-id="${localId}"]`);
  bubble?.remove();
  el.groupInput.value = text;
  resizeGroupInput();
  updateGroupSendState();
}

/** 流式帧渲染：start 换发言者、delta 追加、notice 落系统行、done 收尾。 */
function handleGroupStreamEvent(event) {
  if (event.type === "start") {
    groups.streamSender = event.sender || null;
    groups.streamText = "";
    // 开一个正在发言的气泡（同 renderGroupTimeline 的左对齐形态）
    const bubble = document.createElement("div");
    bubble.className = "gmsg them streaming";
    const avatar = document.createElement("span");
    avatar.className = "pt-avatar gmsg-avatar";
    avatar.textContent = (event.sender?.name || "?").slice(0, 1);
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

function scrollGroupThread() {
  const scroll = document.getElementById("groups-scroll");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
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
  const candidates = [];
  if (!typed || "所有人".startsWith(typed)) candidates.push({ label: "所有人", insert: "@所有人 " });
  for (const member of groups.current.members) {
    if (!typed || member.name.toLowerCase().includes(typed)) {
      candidates.push({ label: member.name, insert: `@${member.name} ` });
    }
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

/* ── 建群 / 群设置弹窗 ─────────────────────────────────── */

async function openCreateGroupModal() {
  const partners = await fetchPartnerOptions();
  if (!partners) return;
  if (partners.length < 2) {
    toast("至少要有 2 名执事才能建群，先去侧栏「执事」新建。");
    return;
  }
  groups.picked = [];
  openModal("新建群组", (body) => {
    const nameInput = document.createElement("input");
    nameInput.className = "text-input";
    nameInput.placeholder = "群名（≤40 字）";
    nameInput.maxLength = 40;

    const hint = document.createElement("p");
    hint.className = "set-hint";
    hint.textContent = "勾 2–6 名执事。不 @ 就发给值日执事；@点名按正文顺序串行回。";

    const memberBox = document.createElement("div");
    memberBox.className = "group-pick";
    const checkboxes = new Map();
    for (const partner of partners) {
      const label = document.createElement("label");
      label.className = "group-pick-item";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = partner.id;
      const name = document.createElement("span");
      name.textContent = partner.name;
      label.append(box, name);
      box.addEventListener("change", () => {
        if (box.checked) groups.picked.push(partner.id);
        else groups.picked = groups.picked.filter((id) => id !== partner.id);
        renderDutyChoices();
        validatePick();
      });
      checkboxes.set(partner.id, box);
      memberBox.append(label);
    }

    const dutyLabel = document.createElement("div");
    dutyLabel.className = "set-hint";
    dutyLabel.textContent = "值日执事（不 @ 时谁回）";
    const dutyBox = document.createElement("div");
    dutyBox.className = "group-pick";
    let dutyChoice = "";
    const renderDutyChoices = () => {
      dutyBox.replaceChildren();
      dutyChoice = "";
      for (const id of groups.picked) {
        const partner = partners.find((p) => p.id === id);
        if (!partner) continue;
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "group-duty-item";
        pill.textContent = partner.name;
        pill.addEventListener("click", () => {
          dutyChoice = id;
          for (const child of dutyBox.children) child.classList.remove("current");
          pill.classList.add("current");
        });
        dutyBox.append(pill);
      }
    };
    const validatePick = () => {
      submit.disabled = groups.picked.length < 2 || groups.picked.length > 6;
    };

    const noticeInput = document.createElement("textarea");
    noticeInput.className = "text-input";
    noticeInput.placeholder = "群公告（可选，≤500 字）";
    noticeInput.maxLength = 500;

    const row = document.createElement("div");
    row.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "取消";
    cancel.addEventListener("click", closeModal);
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn-primary";
    submit.textContent = "建群";
    submit.disabled = true;
    submit.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      if (groups.picked.length < 2 || groups.picked.length > 6) {
        toast("成员要 2–6 名执事");
        return;
      }
      if (!dutyChoice) {
        toast("选一个值日执事（不 @ 就发给谁）");
        return;
      }
      const response = await request("/api/v1/groups", {
        method: "POST",
        body: JSON.stringify({
          name,
          memberIds: groups.picked,
          responderKind: "member",
          responderPartnerId: dutyChoice,
          notice: noticeInput.value.trim(),
        }),
      }).catch(() => null);
      const data = await response?.json().catch(() => ({}));
      if (!response?.ok) {
        toast(data?.message || "建群失败");
        return;
      }
      closeModal();
      toast("群组建好了");
      await initGroups();
      location.hash = `#/group/${data.group.id}`;
    });
    row.append(cancel, submit);
    body.append(nameInput, hint, memberBox, dutyLabel, dutyBox, noticeInput, row);
    nameInput.focus();
  });
}

async function openGroupSettingsModal() {
  if (!groups.current) return;
  const current = groups.current;
  const partners = await fetchPartnerOptions();
  if (!partners) return;
  openModal(`群设置 · ${current.name}`, (body) => {
    const nameInput = document.createElement("input");
    nameInput.className = "text-input";
    nameInput.value = current.name;
    nameInput.maxLength = 40;

    const noticeInput = document.createElement("textarea");
    noticeInput.className = "text-input";
    noticeInput.value = current.notice || "";
    noticeInput.placeholder = "群公告（≤500 字）";
    noticeInput.maxLength = 500;

    const dutyLabel = document.createElement("div");
    dutyLabel.className = "set-hint";
    dutyLabel.textContent = "值日执事（不 @ 时谁回）";
    const dutyBox = document.createElement("div");
    dutyBox.className = "group-pick";
    let dutyChoice = current.responderPartnerId;
    for (const member of current.members) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `group-duty-item${member.partnerId === dutyChoice ? " current" : ""}`;
      pill.textContent = member.name;
      pill.addEventListener("click", () => {
        dutyChoice = member.partnerId;
        for (const child of dutyBox.children) child.classList.remove("current");
        pill.classList.add("current");
      });
      dutyBox.append(pill);
    }

    const memberLabel = document.createElement("div");
    memberLabel.className = "set-hint";
    memberLabel.textContent = "成员（点一下移出 / 在下面点选加回，保持 2–6 人）";
    const memberBox = document.createElement("div");
    memberBox.className = "group-pick";
    const memberSet = () => new Set(current.members.map((m) => m.partnerId));
    let removeIds = [];
    let addIds = [];
    const renderMemberBox = () => {
      memberBox.replaceChildren();
      const inGroup = memberSet();
      for (const member of current.members) {
        if (removeIds.includes(member.partnerId)) continue;
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "group-duty-item";
        pill.title = "点一下移出";
        pill.textContent = member.name;
        pill.addEventListener("click", () => {
          removeIds.push(member.partnerId);
          renderMemberBox();
        });
        memberBox.append(pill);
      }
      for (const partner of partners) {
        if (inGroup.has(partner.id) || removeIds.includes(partner.id) || !addIds.includes(partner.id)) continue;
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "group-duty-item group-duty-add";
        pill.title = "点一下加回";
        pill.textContent = `＋${partner.name}`;
        pill.addEventListener("click", () => {
          addIds.push(partner.id);
          renderMemberBox();
        });
        memberBox.append(pill);
      }
      // 已移出但还没保存的，给一个「撤销移出」的入口
      for (const id of removeIds) {
        const partner = partners.find((p) => p.id === id) ?? current.members.find((m) => m.partnerId === id);
        if (!partner) continue;
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "group-duty-item group-duty-add";
        pill.textContent = `＋${partner.name ?? id}`;
        pill.addEventListener("click", () => {
          removeIds = removeIds.filter((x) => x !== id);
          renderMemberBox();
        });
        memberBox.append(pill);
      }
    };
    // 候选加人列表：不在群里的执事
    for (const partner of partners) {
      if (memberSet().has(partner.id)) continue;
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "group-duty-item group-duty-add";
      pill.textContent = `＋${partner.name}`;
      pill.addEventListener("click", () => {
        if (addIds.includes(partner.id)) return;
        addIds.push(partner.id);
        renderMemberBox();
      });
      memberBox.append(pill);
    }
    renderMemberBox();

    const row = document.createElement("div");
    row.className = "modal-actions";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost danger";
    del.textContent = "删除群组";
    del.addEventListener("click", async () => {
      if (!window.confirm(`删群「${current.name}」？消息和成员关系一起删，不可恢复。`)) return;
      const response = await request(`/api/v1/groups/${encodeURIComponent(current.id)}`, { method: "DELETE" }).catch(() => null);
      if (!response?.ok) {
        toast("删群失败");
        return;
      }
      closeModal();
      toast("群已删除");
      await initGroups();
      location.hash = "#/groups";
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "取消";
    cancel.addEventListener("click", closeModal);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-primary";
    save.textContent = "保存";
    save.addEventListener("click", async () => {
      const finalCount = current.members.length + addIds.length - removeIds.length;
      if (finalCount < 2 || finalCount > 6) {
        toast("成员要保持在 2–6 名");
        return;
      }
      const payload = {
        name: nameInput.value.trim() || current.name,
        notice: noticeInput.value,
        responderPartnerId: dutyChoice,
        ...(removeIds.length ? { removeMemberIds: removeIds } : {}),
        ...(addIds.length ? { addMemberIds: addIds } : {}),
      };
      const response = await request(`/api/v1/groups/${encodeURIComponent(current.id)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      }).catch(() => null);
      const data = await response?.json().catch(() => ({}));
      if (!response?.ok) {
        toast(data?.message || "保存失败");
        return;
      }
      closeModal();
      toast("群设置已保存");
      await initGroups();
      await openGroupChat(current.id);
    });
    row.append(del, cancel, save);
    body.append(nameInput, noticeInput, dutyLabel, dutyBox, memberLabel, memberBox, row);
  });
}

/** 执事选项（建群/加人用）；拿不到返回 null（弹窗里 toast 提示） */
async function fetchPartnerOptions() {
  try {
    const response = await request("/api/v1/partners", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const list = (Array.isArray(data.partners) ? data.partners : []).filter(
      (p) => p.status === "active" && p.id !== "chief",
    );
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
el.groupSettingsBtn?.addEventListener("click", () => void openGroupSettingsModal());
el.groupSend?.addEventListener("click", () => void sendGroupMessage());
el.groupStop?.addEventListener("click", () => void stopGroupRoundWeb());
el.groupInput?.addEventListener("input", () => {
  resizeGroupInput();
  updateGroupSendState();
  updateGroupAtPop();
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
el.railGroups?.addEventListener("click", () => {
  go("groups");
});
el.sideGroup?.addEventListener("click", () => {
  go("groups");
});

/* ── 启动 ─────────────────────────────────────────────── */

void (async () => {
  // 显式初始化一次，别指望 HTML 的 disabled 属性活到脚本跑完
  el.send.disabled = true;
  applyTheme(currentThemeChoice());
  applyActPref();
  syncThinkingPill();
  // E4：最近会话折叠态（localStorage）、总管状态点初值
  applyRecents();
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
})();
