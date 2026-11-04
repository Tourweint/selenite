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
  railSettings: document.getElementById("rail-settings"),
  railStatus: document.getElementById("rail-status"),
  railProj: document.getElementById("rail-proj"),
  railProjIcon: document.getElementById("rail-proj-icon"),
  railProjMark: document.getElementById("rail-proj-mark"),
  gate: document.getElementById("gate"),
  gateForm: document.getElementById("gate-form"),
  gateInput: document.getElementById("gate-input"),
  gateErr: document.getElementById("gate-err"),
  viewChat: document.getElementById("view-chat"),
  viewSettings: document.getElementById("view-settings"),
  viewTasks: document.getElementById("view-tasks"),
  openTasks: document.getElementById("open-tasks"),
  railTasks: document.getElementById("rail-tasks"),
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
  tasksBoard: document.getElementById("tasks-board"),
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
  toast: document.getElementById("toast"),
  railTip: document.getElementById("rail-tip"),
  modal: document.getElementById("modal"),
  modalMask: document.getElementById("modal-mask"),
  modalClose: document.getElementById("modal-close"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  exportChat: document.getElementById("export-chat"),
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
}

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
  return "chat";
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
  return SETTINGS_SECTIONS.some((section) => section.id === part) ? part : "appearance";
}

function go(route, page) {
  if (route === "settings") {
    location.hash = page ? `#/settings/${page}` : "#/settings";
  } else if (route === "tasks") {
    location.hash = tasksHash();
  } else {
    location.hash = "#/";
  }
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
  el.toggleSidebar.hidden = route === "settings";
  el.openSettings.setAttribute("aria-current", String(route === "settings"));
  el.openTasks.setAttribute("aria-current", String(route === "tasks"));
  el.railTasks.setAttribute("aria-current", String(route === "tasks"));
  if (route === "settings") void renderSettings();
  else if (route === "tasks") openTasks();
  else el.input.focus();
}

const state = {
  token: readToken(),
  conversationId: localStorage.getItem(KEY_CONV) || "",
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
  // 侧栏项目切换器（2026-11-04）：工作区与当前项目只做展示与门控；
  // 项目列表每次打开现拉（同模型菜单口径），不在这里缓存。
  switcher: { workspace: null, currentId: null, currentName: "", disabled: false },
};

/* ── 任务中心（2026-11-04） ────────────────────────────────
 * 只读看板。数据：GET /api/v1/tickets（列表）与 GET /api/v1/tickets/:id（详情）。
 * 列按「在等谁」分；界面词只有 助理 / 负责人 / 执行者 / 任务单 / 待你处理。
 * 这一版不做改派、不做手动停止，也没有悬浮面板。 */

const TASK_COLUMNS = [
  { id: "queued", label: "排队 / 等文件", statuses: ["received", "planning", "planned", "idle"] },
  { id: "running", label: "执行中", statuses: ["dispatching", "reviewing"] },
  { id: "ask", label: "待你处理", statuses: ["needs_you", "failed", "aborted"] },
  { id: "done", label: "已完成", statuses: ["done"] },
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

/** 雇员对外只说「执行者」，类型作为后缀 */
const EMPLOYEE_LABEL = {
  "pi-durable": "本机执行者",
  qoder: "Qoder",
  codebuddy: "CodeBuddy",
  mcp: "MCP",
  phone: "手机",
  manager: "负责人",
};

const TASK_TERMINAL = new Set(["done", "failed", "aborted"]);

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

/** 「按状态」排序：先处理需要人的，再看跑着的，最后是完成的 */
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
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3" y="2.6" width="10" height="11.4" rx="1.6"/><path d="M5.6 8h4.8M5.6 10.8h3.2"/></svg>',
  empty:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3" y="2.6" width="10" height="11.4" rx="1.6"/><path d="M5.8 2.6V5h4.4V2.6M5.6 8h4.8M5.6 10.8h3.2"/></svg>',
  error:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 2.4 14 13.2H2Z" stroke-linejoin="round"/><path d="M8 6.2v3.2M8 11.4v.1" stroke-linecap="round"/></svg>',
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

function filteredTickets() {
  let list = state.tickets;
  if (state.domainFilter) {
    list =
      state.domainFilter === "__none__"
        ? list.filter((ticket) => !ticket.domain)
        : list.filter((ticket) => ticket.domain === state.domainFilter);
  }
  if (state.projectFilter) {
    list = list.filter((ticket) => (ticket.project || "") === state.projectFilter);
  }
  return sortTickets(list);
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
  const active = state.tickets.filter((ticket) => !TASK_TERMINAL.has(ticket.status)).length;
  el.tasksBadge.hidden = active === 0;
  el.tasksBadge.textContent = active > 99 ? "99+" : String(active);
}

function syncDomainOptions() {
  const domains = [...new Set(state.tickets.map((ticket) => ticket.domain).filter(Boolean))].sort();
  const previous = state.domainFilter;
  el.tasksDomain.replaceChildren(new Option("全部领域", ""));
  for (const domain of domains) el.tasksDomain.append(new Option(domain, domain));
  if (state.tickets.some((ticket) => !ticket.domain)) {
    el.tasksDomain.append(new Option("未分领域", "__none__"));
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

function taskCard(ticket) {
  const [label, tone] = TASK_STATUS[ticket.status] || [ticket.status || "未知", "idle"];
  const total = Number(ticket.total) || 0;
  const passed = Number(ticket.passed) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((passed / total) * 100)) : 0;
  const prompt = String(ticket.prompt || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const employee = employeeText(ticket.employee);
  const error = ticket.error ? String(ticket.error).trim() : "";
  const showError = error && (ticket.status === "failed" || ticket.status === "aborted");
  // 这三项由接口逐步带回来（2026-11-04 后端落盘中）：没有就不渲染，不占位也不报错
  const lastAction = ticket.lastAction ? String(ticket.lastAction).trim().slice(0, 120) : "";
  const waitingOn = ticket.waitingOn ? String(ticket.waitingOn).trim().slice(0, 120) : "";

  const card = document.createElement("button");
  card.type = "button";
  card.className = "tk-card";
  card.dataset.ticket = ticket.id;
  card.dataset.status = ticket.status;
  if (ticket.status === "needs_you") card.dataset.attn = "1";
  card.innerHTML = `
    <div class="tk-card-top">
      <span class="tk-domain">${esc(ticket.domain || "未分领域")}</span>
      <span class="tk-id">${esc(ticket.id)}</span>
    </div>
    <p class="tk-prompt">${esc(prompt || "（没有说明）")}</p>
    <div class="tk-meta">
      <span>任务 <b>${passed}/${total}</b></span>
      ${employee ? `<span>执行者 <b>${esc(employee)}</b></span>` : ""}
    </div>
    ${total > 0 ? `<div class="tk-bar"><i style="width:${percent}%"></i></div>` : ""}
    ${showError ? `<p class="tk-err">${esc(error.slice(0, 120))}</p>` : ""}
    ${lastAction ? `<p class="tk-live">最近 ${esc(lastAction)}</p>` : ""}
    ${waitingOn ? `<p class="tk-wait">等文件 ${esc(waitingOn)}</p>` : ""}
    <div class="tk-foot">
      <span class="tk-chip" data-tone="${tone}">${esc(label)}</span>
      <span class="tk-time">${esc(relativeTime(ticket.updated_at))}</span>
    </div>
  `;
  return card;
}

function renderStats(list) {
  const active = list.filter((ticket) => !TASK_TERMINAL.has(ticket.status)).length;
  const ask = list.filter((ticket) => ticket.status === "needs_you").length;
  const failed = list.filter((ticket) => ticket.status === "failed" || ticket.status === "aborted").length;
  const done = list.filter((ticket) => ticket.status === "done").length;
  const domains = new Set(list.map((ticket) => ticket.domain || "未分领域")).size;
  const stats = [
    ["进行中", active, "run"],
    ["待你处理", ask, "ask"],
    ["失败待看", failed, "fail"],
    ["已完成", done, ""],
    ["领域", domains, ""],
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

function renderBoard() {
  // 自动刷新会反复走这里：先记下滚动位置，重排后再放回去，别让看板自己跳回顶部/最左。
  const scrollTop = el.tasksScroll.scrollTop;
  const scrollLeft = el.tasksScroll.scrollLeft;

  hideTasksState();
  el.tasksDetail.hidden = true;
  el.tasksBoard.hidden = false;
  el.tasksStats.hidden = false;
  el.tasksFilters.hidden = false;
  el.tasksBack.hidden = true;
  el.tasksTitleText.textContent = "任务中心";
  el.tasksTitleSub.textContent = state.tickets.length ? `共 ${state.tickets.length} 张任务单` : "";

  if (!state.tickets.length) {
    showTasksState(
      "empty",
      "还没有任务单",
      "在对话里让助理派个活，任务单会出现在这里；派出去的活会按状态分列，需要你处理的会亮起来。",
      { label: "回到对话", run: () => go("chat") },
    );
    return;
  }

  syncDomainOptions();
  syncProjectOptions();
  el.tasksSort.value = state.sort;
  const list = filteredTickets();
  if (!list.length) {
    const clear = () => {
      state.domainFilter = "";
      state.projectFilter = "";
      state.sort = "recent";
      el.tasksDomain.value = "";
      el.tasksProject.value = "";
      el.tasksSort.value = "recent";
      writeTasksHash("");
      renderBoard();
    };
    showTasksState(
      "empty",
      "没有符合筛选的任务单",
      "换个领域或项目，或者清除筛选看看全部任务。",
      { label: "清除筛选", run: clear },
    );
    return;
  }
  el.tasksTitleSub.textContent =
    list.length === state.tickets.length
      ? `共 ${state.tickets.length} 张任务单`
      : `筛选 ${list.length} / 共 ${state.tickets.length} 张任务单`;

  renderStats(list);
  el.tasksBoard.replaceChildren();
  for (const column of TASK_COLUMNS) {
    const items = list.filter((ticket) => column.statuses.includes(ticket.status));
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
      blank.textContent = column.id === "ask" ? "没有需要你处理的事" : "空";
      section.append(blank);
    } else {
      for (const ticket of items) section.append(taskCard(ticket));
    }
    el.tasksBoard.append(section);
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

  el.tasksDetail.innerHTML = `
    <div class="td-card"${ticket.status === "needs_you" ? ' data-attn="1"' : ""}>
      <div class="td-head">
        <span class="tk-chip" data-tone="${statusTone}">${esc(statusLabel)}</span>
        <span class="td-domain">${esc(data.domain || ticket.options?.domain || "未分领域")}</span>
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
    // 新单：先放一张临时卡，紧接着的一次静默刷新会补上完整字段
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
  ticket.updated_at = event.lastHeartbeat || now;
  syncTasksBadge();
  scheduleTasksRender();
  scheduleTicketsSync();
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
el.tasksBoard.addEventListener("click", (event) => {
  const card = event.target.closest(".tk-card");
  if (!card || !card.dataset.ticket) return;
  location.hash = tasksHash({ ticket: card.dataset.ticket });
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
    // 门开着的时候别把状态灯改回"在线"——那会跟"需要令牌"自相矛盾。
    if (el.gate.hidden) {
      setStatus("ok", info.llm === "mock" ? "服务在线 · mock" : "服务在线");
    }
    return true;
  } catch (error) {
    if (error.message !== "forbidden") {
      setStatus("off", "服务离线");
    }
    return false;
  }
}

/* ── 会话列表 ─────────────────────────────────────────── */

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
  const ordered = [...visible]
    .reverse()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  for (const chat of ordered) {
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
      startNewChat();
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    clearThread();
    const messages = data.messages || [];
    for (const message of messages) {
      addMessage(message.role === "user" ? "user" : "assistant", message.text, message.at);
    }
    if (!messages.length) {
      el.title.textContent = "新对话";
    } else {
      const first = messages.find((message) => message.role === "user");
      el.title.textContent = first ? first.text.slice(0, 40) : "对话";
    }
    state.stick = true;
    scrollToEnd();
    // 刷新页面 / 切回会话时，可能还有一条挂着等答复的审批
    await loadPendingApprovals(conversationId);
  } catch (error) {
    if (error.message !== "forbidden" && error.message !== "not-found") {
      addError(`读历史失败：${error.message}`);
    }
  }
  syncExport();
  void syncCtxMeter();
}

function startNewChat() {
  state.conversationId = "";
  localStorage.removeItem(KEY_CONV);
  state.maxSeq = 0; // 新会话没有历史帧（2026-11-04 seq 方案）
  renderChats();
  clearThread();
  el.title.textContent = "新对话";
  syncExport();
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
}

function syncSendEnabled() {
  el.send.disabled = state.sending ? false : !el.input.value.trim();
}

/* ── 桌面通知（批次二，三时机：完成 / 出错 / 待你处理）──────
   静默判定是前置条件不是优化：窗口可见且正看着这个会话 → 不打扰
   （cindy notificationService 的口径）。开关在设置-服务分区，默认关。 */
const KEY_NOTIFY = "lifediary.notify";

function maybeNotify(title, body, convId) {
  if (localStorage.getItem(KEY_NOTIFY) !== "1") return;
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

async function syncCtxMeter() {
  if (!state.conversationId || currentRoute() !== "chat") {
    el.ctxRing.hidden = true;
    return;
  }
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/context`,
      { cache: "no-store" },
    );
    const data = await response.json();
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
  title.textContent = `要执行 ${event.tool || "工具"}，需要你确认`;
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
  if (!conversationId) return;
  try {
    const response = await request(
      `/api/v1/agent/approvals?conversationId=${encodeURIComponent(conversationId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const data = await response.json();
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
          maybeNotify("有任务单需要你处理", event.question || "", state.conversationId);
        } else if (event.type === "approval") {
          const card = renderApprovalCard(event);
          if (card && !card.isConnected) turn.root.before(card);
          maybeNotify("有写操作需要你确认", event.tool || "", state.conversationId);
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
        ...(state.conversationId ? { conversationId: state.conversationId } : {}),
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
            syncExport();
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
            maybeNotify("有任务单需要你处理", event.question || "", streamConv);
            if (state.stick) scrollToEnd();
          } else if (event.type === "approval") {
            // 写类工具要确认（批次二）：卡片挂在回答气泡上方，和 attention 同一套视觉
            const card = renderApprovalCard(event);
            if (card && !card.isConnected) body.before(card);
            maybeNotify("有写操作需要你确认", event.tool || "", streamConv);
            if (state.stick) scrollToEnd();
          } else if (event.type === "done") {
            sawDone = true;
            if (event.finishReason === "error" && !answer) {
              addError("这一轮出错了。", { retryable: true });
              maybeNotify("这一轮没答上来", el.title.textContent || "对话", streamConv);
            } else {
              maybeNotify("Selenite 回复完成", el.title.textContent || "对话", streamConv);
            }
            if (event.usage) attachUsage(turn.root, event.usage, Date.now() - turnStartMs);
            void syncCtxMeter();
          } else if (event.type === "error") {
            addError(event.message || "出错了", { retryable: true });
            maybeNotify("Selenite 出错了", event.message || "", streamConv);
          }
        }
      }
    }
    caret.remove();
    paint();
    if (!answer.trim()) {
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

function updateModelPill(catalog = state.modelCatalog) {
  if (!el.modelPillLabel) return;
  el.modelPillLabel.textContent = modelLabel(catalog);
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
  if (typeof row === "string") return { id: row, thinkingLevels: ["off", "low", "high"] };
  if (!row || typeof row.id !== "string") return null;
  const declared = Array.isArray(row.thinkingLevels) ? row.thinkingLevels : [];
  const levels = THINKING_LEVELS.filter((level) => declared.includes(level));
  return { id: row.id, thinkingLevels: levels.length ? levels : ["off", "low", "high"] };
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

function renderModelMenu(catalog, preferredProviderId) {
  el.modelMenu.replaceChildren();
  const current = catalog.current || null;
  const level = currentThinking();
  const providers = menuProviders(catalog);
  if (!providers.length) {
    const row = document.createElement("div");
    row.className = "model-menu-empty";
    row.textContent = "还没有可选模型：到设置 → 服务里添加供应商";
    el.modelMenu.append(row);
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
      renderModelMenu(catalog, provider.id);
      // 重渲染换掉了刚点的按钮：焦点跟到新段上，键盘 Tab 还能继续走
      el.modelMenu.querySelector('.provider-opt[aria-pressed="true"]')?.focus();
    });
    rail.append(opt);
  }
  el.modelMenu.append(rail);

  // 只列这一家的模型：分组头省了，段上已经写明是哪家
  for (const raw of active.models) {
    const model = normalizeModelRow(raw);
    if (!model) continue;
    const selected = Boolean(current && current.providerId === active.id && current.modelId === model.id);

    // 行 = 模型名（可点，选中行 ✓）；只有当前行额外挂档位分段（2026-11-05）
    const row = document.createElement("div");
    row.className = "model-row";
    row.dataset.current = String(selected);
    row.setAttribute("role", "none");

    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-item";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(Boolean(selected)));
    item.title = `${active.name || active.id} · ${model.id}`;
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = model.id;
    item.append(name);
    if (selected) {
      const check = document.createElement("span");
      check.className = "model-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";
      item.append(check);
    }
    // 选中后菜单不关：重渲染出档位分段，接着选强度（D2 的「先选模型再选强度」）
    item.addEventListener("click", () => {
      void chooseModel(active, model.id, model.thinkingLevels, { keepOpen: true });
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
    el.modelMenu.append(row);
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

async function chooseModel(provider, modelId, levels, { keepOpen = false } = {}) {
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
    if (keepOpen && el.modelMenu) {
      renderModelMenu(state.modelCatalog, providerId);
      // 重渲染把刚点的按钮换掉了：焦点跟到新行，键盘 Tab 能直接进档位
      el.modelMenu.querySelector('.model-row[data-current="1"] .model-item')?.focus();
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

/* ── 侧栏项目切换器（2026-11-04）──────────────────────────
 * 展开态 pill 与收起轨道按钮是同一份弹层、同一个渲染函数。
 * 列表每次打开现拉（同模型菜单口径）：项目可能在设置页刚建/归档，也可能是
 * 另一台设备改的。契约见接口文档 §工作区；currentProjectId 是后加字段，
 * 老后端读不到时按 null（主工作区）处理，不报错。 */

const PROJECT_HOME_LABEL = "杂事 · 主工作区";
const PROJECT_SWITCH_ERROR = {
  unknown_project: "这个项目已经不在登记表里了",
  project_missing: "项目目录不在了，先修好目录再切",
  outside_workspace: "这个项目不在当前工作区里",
  current_project_disabled: "当前项目功能已关闭",
};

let projectAnchor = null;
let projectLoading = false;
// 打开序号：慢网下点了外面，等在路上的现拉结果回来也不许自己弹出来
let projectOpenToken = 0;

function projectSwitchErrorText(data, status) {
  return PROJECT_SWITCH_ERROR[data?.error] || data?.message || `没切成：HTTP ${status}`;
}

/** 项目名首字：Array.from 取，emoji / 代理对不会被切成半个字符 */
function firstChar(text) {
  return Array.from(String(text || "").trim())[0] || "";
}

/** 两个接口都拿全了才返回；任一失败返回 null，调用方保持原状（不抛） */
async function fetchProjectSwitchData() {
  const [workspaceResponse, projectsResponse] = await Promise.all([
    request("/api/v1/workspaces", { cache: "no-store" }),
    request("/api/v1/projects", { cache: "no-store" }),
  ]);
  if (!workspaceResponse.ok || !projectsResponse.ok) return null;
  const workspaceData = await workspaceResponse.json().catch(() => ({}));
  const projectsData = await projectsResponse.json().catch(() => ({}));
  const workspace = workspaceData.workspace || projectsData.workspace || null;
  const projects = Array.isArray(projectsData.projects) ? projectsData.projects : [];
  const items = projects
    .filter((project) => project && typeof project.id === "string")
    // 归档 / 目录已消失的不进列表：切过去也跑不起来。
    // exists 缺省时按「还在」处理——老后端不带这个字段，全藏起来反而像功能坏了。
    .filter((project) => !project.archived && project.exists !== false)
    .map((project) => ({
      id: project.id,
      name: project.name || project.id,
      rootPath: project.rootPath || "",
      outside: project.insideWorkspace === false,
    }));
  return {
    workspace,
    items,
    currentId: typeof workspaceData.currentProjectId === "string" ? workspaceData.currentProjectId : null,
  };
}

function applyProjectData(data) {
  const switcher = state.switcher;
  switcher.workspace = data.workspace;
  switcher.currentId = data.currentId;
  const current = data.items.find((item) => item.id === data.currentId);
  switcher.currentName = current ? current.name : "";
  syncProjectPill();
}

/** pill / 轨道按钮 / 降级态都从这里刷新，别在两处各写一份显示逻辑 */
function syncProjectPill() {
  const switcher = state.switcher;
  const hasWorkspace = Boolean(switcher.workspace);
  const active = Boolean(switcher.currentId);
  // F1：没有工作区也显示 pill —— 它同时是「添加主项目」的入口，
  // 否则侧栏没有任何地方能打开添加主项目弹窗。
  const label = hasWorkspace
    ? active
      ? switcher.currentName || "项目不可用"
      : PROJECT_HOME_LABEL
    : "添加主项目";
  const off = switcher.disabled;

  if (el.sideProj) el.sideProj.hidden = false;
  if (el.railProj) el.railProj.hidden = false;

  if (el.projectPillLabel) el.projectPillLabel.textContent = label;
  if (el.projectPill) {
    el.projectPill.setAttribute("aria-disabled", String(off));
    el.projectPill.title = off
      ? "当前项目功能已关闭（CURRENT_PROJECT=false）"
      : hasWorkspace
        ? `当前：${label}（点击切换项目）`
        : "还没有主工作区，点这里添加";
  }

  if (el.railProj) {
    el.railProj.setAttribute("aria-disabled", String(off));
    el.railProj.dataset.active = String(active);
    // 轨道 tooltip 走 data-tip（自绘右侧气泡），不再用原生 title
    el.railProj.removeAttribute("title");
    el.railProj.dataset.tip = off
      ? "当前项目功能已关闭（CURRENT_PROJECT=false）"
      : hasWorkspace
        ? `切换项目（当前：${label}）`
        : "添加主项目";
    el.railProj.setAttribute(
      "aria-label",
      hasWorkspace ? `切换项目，当前：${label}` : "添加主项目",
    );
  }
  if (el.railProjIcon) el.railProjIcon.hidden = active;
  if (el.railProjMark) {
    el.railProjMark.hidden = !active;
    el.railProjMark.textContent = active ? firstChar(switcher.currentName) || "项" : "";
  }
}

function projectCheck() {
  const check = document.createElement("span");
  check.className = "proj-check";
  check.setAttribute("aria-hidden", "true");
  check.textContent = "✓";
  return check;
}

/** 弹层内容：主工作区 / 已登记项目 / 底部「添加子项目 · 添加主项目 · 管理项目」 */
function renderProjectMenu(items, currentId) {
  const menu = el.projectMenu;
  if (!menu) return;
  menu.replaceChildren();
  const hasWorkspace = Boolean(state.switcher.workspace?.rootPath);

  if (hasWorkspace) {
    const home = document.createElement("button");
    home.type = "button";
    home.className = "proj-item";
    home.setAttribute("role", "menuitemradio");
    home.setAttribute("aria-checked", String(currentId === null));
    home.title = "主工作区：没有特定项目，跑杂事";
    const homeName = document.createElement("span");
    homeName.className = "proj-item-name";
    homeName.textContent = PROJECT_HOME_LABEL;
    home.append(homeName);
    if (currentId === null) home.append(projectCheck());
    home.addEventListener("click", () => void switchProject(null, PROJECT_HOME_LABEL));
    menu.append(home);
  } else {
    const empty = document.createElement("div");
    empty.className = "proj-empty";
    empty.textContent = "还没有主工作区。先添加主项目，项目才能登记进来。";
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
    const selected = project.id === currentId;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "proj-item";
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", String(selected));
    row.title = project.outside
      ? `${project.rootPath || project.name}（不在当前工作区）`
      : project.rootPath || project.name;
    const name = document.createElement("span");
    name.className = "proj-item-name";
    name.textContent = project.name;
    row.append(name);
    if (selected) row.append(projectCheck());
    row.addEventListener("click", () => void switchProject(project.id, project.name));
    menu.append(row);
  }

  const foot = document.createElement("div");
  foot.className = "proj-foot";

  // 添加子项目：没有工作区时置灰，title 指明先去添加主项目
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
    addSub.title = "先添加主项目";
  }

  // 添加主项目：设置（或更换）最大工作区根目录
  const addMain = document.createElement("button");
  addMain.type = "button";
  addMain.className = "proj-manage";
  addMain.textContent = "添加主项目";
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
  openModal("添加主项目", (body) => {
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
        toast("主项目已添加");
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
    toast("先添加主项目");
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
        setModalHint(hint, "必须在最大工作区内，先去添加主项目。");
        toast("必须在最大工作区内，先去添加主项目");
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

/** 切换即 PUT；失败把错误码翻成人话，回滚开关命中后本会话不再发请求 */
async function switchProject(nextId, label) {
  const switcher = state.switcher;
  if (nextId === switcher.currentId) {
    closeProjectMenu();
    return;
  }
  if (projectLoading) return;
  projectLoading = true;
  try {
    const response = await request("/api/v1/workspaces/current-project", {
      method: "PUT",
      body: JSON.stringify({ projectId: nextId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 回滚开关：记住这一次，pill 直接降级，不让人反复点出同一个错
      if (data.error === "current_project_disabled") {
        switcher.disabled = true;
        syncProjectPill();
        closeProjectMenu();
      }
      toast(projectSwitchErrorText(data, response.status));
      return;
    }
    switcher.currentId =
      typeof data.projectId === "string" || data.projectId === null ? data.projectId : nextId;
    switcher.currentName = nextId ? label : "";
    syncProjectPill();
    closeProjectMenu();
    toast(`已切到 ${label}`);
  } catch (error) {
    if (error.message !== "forbidden") toast(`没切成：${error.message}`);
  } finally {
    projectLoading = false;
  }
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
  if (state.switcher.disabled || projectLoading) return;
  projectLoading = true;
  const token = ++projectOpenToken;
  try {
    // 每次打开都现拉：不缓存（同模型菜单口径）
    const data = await fetchProjectSwitchData();
    // 现拉期间点过外面 / 换了路由：这次结果作废，别把弹层补出来
    if (token !== projectOpenToken) return;
    if (!data) {
      toast("拿不到项目列表");
      return;
    }
    applyProjectData(data);
    // 没有工作区也照常打开：里面还有「添加主项目」，是首次使用的唯一入口
    renderProjectMenu(data.items, data.currentId);
    projectAnchor = trigger;
    openPopover(el.projectMenu, trigger);
    // openPopover 会清掉 left/right，落点必须在它之后写
    placeProjectMenu(trigger);
  } catch (error) {
    if (error.message !== "forbidden") toast("拿不到项目列表");
  } finally {
    projectLoading = false;
  }
}

/** 启动 / 回到对话页时补一次 pill 文案：读不到就保持隐藏，不留点了会报错的空壳 */
async function refreshProjectPill() {
  try {
    const data = await fetchProjectSwitchData();
    if (data) applyProjectData(data);
  } catch {
    /* 离线或接口未上线：保持现状，下次打开弹层会再试 */
  }
}

el.projectPill?.addEventListener("click", () => void toggleProjectMenu(el.projectPill));
el.railProj?.addEventListener("click", () => void toggleProjectMenu(el.railProj));

el.modelPill?.addEventListener("click", () => void toggleModelMenu());
// 菜单里的点击不冒泡到「点外面就关」的判定：点供应商段会就地重渲染，
// 被替换掉的旧按钮已经脱离文档，冒泡到 document 时会被当成外部点击误关。
el.modelMenu?.addEventListener("click", (event) => event.stopPropagation());
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
  // 模态在最上层：先关它，别同时把下面的弹层/路由也收掉。
  // stopImmediatePropagation 是给 reduced-motion 的：没有动画时 modalOpen()
  // 立刻变 false，第二个全局 Esc 监听会以为是普通返回。
  if (modalOpen()) {
    event.stopImmediatePropagation();
    closeModal();
    return;
  }
  closeModelMenu();
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
    startNewChat();
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

el.newChat.addEventListener("click", startNewChat);

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

/* ── 导出对话 Markdown（批次一）──────────────────────────
   正文从 /messages 现取（不解析屏幕上的 HTML），标题用当前会话标题。 */
async function exportConversation() {
  if (!state.conversationId) return;
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/messages?limit=500`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const title = el.title.textContent || "对话";
    const lines = [
      `# ${title}`,
      "",
      `> 导出自 Selenite · ${new Date().toLocaleString("zh-CN")}`,
      "",
    ];
    for (const message of data.messages || []) {
      const who = message.role === "user" ? "我" : "Selenite";
      const at = message.at ? new Date(message.at).toLocaleString("zh-CN") : "";
      lines.push(`**${who}**${at ? ` · ${at}` : ""}:`, "", message.text || "", "");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const name = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "对话";
    link.download = `${name}-${new Date().toISOString().slice(0, 10)}.md`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    if (error.message !== "forbidden") addError(`导出失败：${error.message}`);
  }
}

/** 导出入口只在有会话时出现（新对话没有可导的东西） */
function syncExport() {
  el.exportChat.hidden = !state.conversationId;
}
el.exportChat.addEventListener("click", () => void exportConversation());

/* ── 收起轨道（2026-11-05 F1）──────────────────────────
   收起不再是整栏消失：72px 图标轨上「新对话 / 任务中心 / 项目 / 设置」是真功能，
   领域负责人 / 群组是禁用占位（HTML 里 disabled + tooltip 写明）。 */
el.railNew.addEventListener("click", () => {
  if (!sidebarOpen()) toggleSidebar();
  go("chat");
  startNewChat();
});
el.railSettings.addEventListener("click", () => go("settings"));

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

const SETTINGS_SECTIONS = [
  { id: "appearance", label: "外观", path: "M8 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z" },
  { id: "chats", label: "会话", path: "M3 4.2h10v6.6H7.2L4.4 13V4.2H3Z" },
  { id: "projects", label: "项目", path: "M2.6 3.6h4l1.2 1.6h5.6v7H2.6zM2.6 6.4h10.8" },
  { id: "reminders", label: "提醒", path: "M8 2.6a3 3 0 0 1 3 3v2.1l1 2.2H4l1-2.2V5.6a3 3 0 0 1 3-3Zm-1.4 9.4h2.8a1.4 1.4 0 0 1-2.8 0Z" },
  { id: "connect", label: "连接", path: "M6 2.6h4v10.8H6zM7.2 11.6h1.6" },
  { id: "service", label: "服务", path: "M3 3.4h10v3.2H3zM3 9.4h10v3.2H3z" },
  { id: "about", label: "关于", path: "M8 2.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6Zm-.8 2.2h1.6v1.6H7.2Zm0 2.6h1.6v4H7.2Z" },
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
    button.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${section.path}"/></svg><span>${section.label}</span>`;
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
    void loadPolicy();
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
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>
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
    el.settingsInner.innerHTML = sectionMarkup(
      "提醒",
      `<div class="card" id="reminder-card">
        <div class="row"><div class="row-main"><div class="row-hint">读取中…</div></div></div>
      </div>`,
    );
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
      </div>`,
    )}
    ${sectionMarkup(
      "供应商",
      `<div class="svc-head">
        <div class="row-main">
          <div class="set-hint" id="svc-provider-hint">填 API Key 就能用：Key 只存在本机服务端，不进 git、不进日志、不下发手机。保存后下一轮对话生效。</div>
        </div>
        <button class="btn-primary" type="button" id="provider-add">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>
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

/* ── 项目分区（2026-11-04 批次六）───────────────────────
   服务端 2026-11-03 就有登记/提案/确认流，这里只是把它接上：
   工作区 = 一个根目录；项目 = 根目录下的已登记子目录；确认提案才建目录。
   路由以代码为准：确认 / 拒绝是 POST /api/v1/projects/:id/confirm|reject。 */

const PROJECT_ERROR_TEXT = {
  bad_request: "名称和相对路径都要填。",
  bad_path: "路径不合法：工作区要写绝对路径；项目路径要写工作区内的相对路径。",
  outside_workspace: "必须在最大工作区内，先去添加主项目。",
  no_workspace: "还没有主工作区，先去添加主项目。",
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
            <div class="row-label">${esc(item.chatTitle || "未命名会话")} · ${esc(item.tool || "工具")}</div>
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

  try {
    const response = await request("/api/v1/agent/usage", { cache: "no-store" });
    const data = await response.json();
    const models = data.models || [];
    const total = models.reduce((sum, item) => sum + (item.totalTokens || 0), 0);
    set("svc-usage", total ? `${total.toLocaleString()} tokens` : "还没有用量");
  } catch {
    set("svc-usage", "读取失败");
  }

  await loadProviders();
}

/* ── 供应商管理（2026-11-04 批次五；2026-11-05 G1 双栏重排，H1 密钥直填）────────
 * 密钥以界面直填为主：表单只收 API Key，keyEnv 由前端按 LIFEDIARY_KEY_<ID大写> 生成；
 * 直填接口不在的环境退回「只填变量名、值写 .env」的老形态，两种都只出现变量名，不存明文。 */

/* 预置模板（G1）：只给 baseUrl / 常见模型 id，不含任何密钥值。
   keyEnv 不再写进模板：H1 起由前端按 LIFEDIARY_KEY_<ID大写> 自动生成，界面不出现。 */
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
  bad_models: "模型清单不能为空：填一个模型 id，或勾上「自动拉取模型清单」再保存。",
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
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M9.8 3.4 5.2 8l4.6 4.6" stroke-linecap="round" stroke-linejoin="round"/>
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
          <svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M6.4 4.8 9.6 8l-3.2 3.2" stroke-linecap="round" stroke-linejoin="round"/>
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
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M9.8 3.4 5.2 8l4.6 4.6" stroke-linecap="round" stroke-linejoin="round"/>
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
          <svg class="eye-show" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M1.6 8s2.4-4 6.4-4 6.4 4 6.4 4-2.4 4-6.4 4S1.6 8 1.6 8Z" stroke-linejoin="round"/>
            <circle cx="8" cy="8" r="1.9"/>
          </svg>
          <svg class="eye-hide" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true" hidden>
            <path d="M1.6 8s2.4-4 6.4-4 6.4 4 6.4 4-2.4 4-6.4 4S1.6 8 1.6 8Z" stroke-linejoin="round"/>
            <circle cx="8" cy="8" r="1.9"/>
            <path d="M2.6 2.6l10.8 10.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <span class="field-hint">Key 只存在你这台电脑的服务端，不进 git、不进日志、不下发手机。</span>
    </div>
    <label class="field" id="pv-key-env" hidden><span>密钥环境变量名</span>
      <input id="pv-keyenv" class="is-mono" type="text" spellcheck="false" placeholder="DASHSCOPE_API_KEY" />
      <span class="field-hint">这版服务端还没开放密钥直填：变量名填这里，值写进 .env。</span>
    </label>
    <label class="field"><span>模型清单（一行一个）</span>
      <textarea id="pv-models" rows="5" spellcheck="false" placeholder="qwen3-max"></textarea>
      <span class="field-hint">勾了自动拉取就不用填；拉不到再手填。</span>
    </label>
    <label class="field-check"><input type="checkbox" id="pv-autofetch" checked /> 自动拉取模型清单（会覆盖手填）</label>
    <div class="svc-form-actions">
      <span class="set-hint" id="pv-hint"></span>
      <button class="ghost" type="button" id="pv-fetch">保存并拉取清单</button>
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
  const modelsText = provider
    ? (provider.models || []).join("\n")
    : isTemplate
      ? template.models
      : "";
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
  setValue("#pv-models", modelsText);
  setValue("#pv-keyenv", provider ? provider.keyEnv || providerKeyEnv(id) : providerKeyEnv(id));

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

  // 自动拉取默认开（用户口径：不再手填清单）；只在“换了一家/换了一个模板”时复位，
  // 避免用户手动取消后被一次刷新又勾回去
  const nextFormFor = isEdit ? `form:${id}` : `new:${isTemplate ? template.id : "custom"}`;
  const auto = q("#pv-autofetch");
  const switched = host.dataset.formFor !== nextFormFor;
  host.dataset.formFor = nextFormFor;
  if (auto && switched) auto.checked = true;

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
      fillProviderForm(host, provider, null);
      return;
    }
    showProviderTemplates();
  });

  host.querySelector("#pv-fetch")?.addEventListener("click", () => void saveProviderFlow({ withModels: true }));
  host.querySelector("#pv-save")?.addEventListener("click", () => void saveProviderFlow({ withModels: false }));

  host.querySelector("#pv-delete")?.addEventListener("click", () => {
    const { provider } = currentProviderFormTarget();
    if (provider) confirmDeleteProvider(provider);
  });
}

/**
 * 保存编排（2026-11-05 H1）：
 *   ① POST /agent/providers            基本信息（含前端生成的 id/keyEnv）
 *   ② PUT  /agent/providers/:id/secret 密钥（Key 框留空 = 不改）
 *   ③ POST /agent/providers {modelsUrl} 代拉清单并回填多行框（勾了自动 / 点了“保存并拉取清单”）
 * ②失败但服务端没有该接口（404 / secrets_disabled）时，退回“只填变量名”的老形态。
 */
async function saveProviderFlow({ withModels }) {
  const host = document.getElementById("provider-detail");
  if (!host) return;
  const saveButton = host.querySelector(withModels ? "#pv-fetch" : "#pv-save");
  const otherButton = host.querySelector(withModels ? "#pv-save" : "#pv-fetch");
  if (saveButton?.disabled) return;

  const { provider } = currentProviderFormTarget();
  const autoFetch = host.querySelector("#pv-autofetch")?.checked !== false;
  const shouldFetch = withModels || autoFetch;
  const apiKey = (host.querySelector("#pv-apikey")?.value || "").trim();
  const values = providerFormValues(provider ? provider.id : "");
  const problem = providerFormError(values, { autoFetch: shouldFetch });
  if (problem) {
    setProviderHint(host, problem);
    return;
  }

  if (saveButton) saveButton.disabled = true;
  if (otherButton) otherButton.disabled = true;
  setProviderHint(host, withModels ? "保存并拉取中…" : "保存中…", false);
  try {
    // ① 基本信息
    const created = await postProvider(values);
    if (!created.response.ok) {
      // 老服务端建新供应商仍要求非空 models：把“先填一个再拉”说清楚，别只丢一句通用错误
      const denied = created.data || {};
      if (denied.error === "bad_models" && shouldFetch && !provider) {
        setProviderHint(
          host,
          "这版服务端还不允许空清单建档：先手填一个模型 id 保存，之后点「保存并拉取清单」覆盖成上游清单。",
        );
        return;
      }
      setProviderHint(host, providerErrorText(denied, created.response.status));
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
    // 填表会把勾选重置成编辑态默认（关）：把用户刚才的选择放回去
    const autoNode = host.querySelector("#pv-autofetch");
    if (autoNode) autoNode.checked = autoFetch;
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

    // ③ 代拉模型清单（models 传空 + modelsUrl，服务端拉到什么就存什么）
    if (shouldFetch) {
      setProviderHint(host, "已保存，正在拉取模型清单…", false);
      const body = {
        ...values,
        id: providerId,
        keyEnv,
        models: [],
        modelsUrl: `${values.baseUrl.replace(/\/+$/, "")}/models`,
        test: false,
      };
      if (provider) body.previousId = providerId;
      else delete body.previousId;
      const fetched = await postProvider(body);
      if (!fetched.response.ok) {
        await reloadAfterProviderChange();
        setProviderHint(host, providerErrorText(fetched.data, fetched.response.status));
        return;
      }
      const models = (fetched.data.provider && fetched.data.provider.models) || [];
      const textarea = host.querySelector("#pv-models");
      if (textarea && models.length) textarea.value = models.join("\n");
      // 拉到就先把勾去掉：接下来手改再保存不会被下一次拉取覆盖
      const autoBox = host.querySelector("#pv-autofetch");
      if (autoBox) autoBox.checked = false;
      toast(provider ? `已保存 ${values.name}` : `已添加 ${values.name}`);
      await reloadAfterProviderChange();
      setProviderHint(
        host,
        models.length
          ? `已保存，拉到 ${models.length} 个模型；要手改就改完再保存（自动拉取已取消勾选）`
          : "已保存；上游没返回模型，请手填",
        false,
      );
      return;
    }

    toast(provider ? `已保存 ${values.name}` : `已添加 ${values.name}`);
    await reloadAfterProviderChange();
    setProviderHint(host, "已保存", false);
  } finally {
    if (saveButton) saveButton.disabled = false;
    if (otherButton) otherButton.disabled = false;
  }
}

/** 表单校验（服务端仍会再拦一遍；这里只把明显问题挡在请求前） */
function providerFormError(values, { autoFetch = false } = {}) {
  if (!values.name) return "给供应商起个名字。";
  if (!/^https?:\/\/\S+$/i.test(values.baseUrl)) {
    return "Base URL 要写完整地址（http:// 或 https://）。";
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(values.keyEnv)) {
    return "变量名只能是大写字母、数字、下划线，且不以数字开头（如 DASHSCOPE_API_KEY）。";
  }
  if (!values.models.length && !autoFetch) {
    return "模型清单不能为空：一行一个模型 id，或勾上「自动拉取模型清单」。";
  }
  return "";
}

function parseModelText(text) {
  return String(text || "")
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function providerFormValues(editingId) {
  const name = (document.getElementById("pv-name")?.value || "").trim();
  const baseUrl = (document.getElementById("pv-base")?.value || "").trim();
  const models = parseModelText(document.getElementById("pv-models")?.value);
  const keyEnvInput = (document.getElementById("pv-keyenv")?.value || "").trim();
  if (editingId) {
    const provider = providerById(editingId);
    // 编辑时 keyEnv 默认沿用磁盘上的那个；只有退回 env 形态才读手输框
    const keyEnv =
      state.providerSecretMode === "env"
        ? keyEnvInput || provider?.keyEnv || ""
        : provider?.keyEnv || providerKeyEnv(editingId);
    // id 不能改：编辑时把原 id 一并带上，服务端会拒绝 previousId ≠ id
    return { id: editingId, previousId: editingId, name, baseUrl, keyEnv, models };
  }
  // 新建：id/keyEnv 前端先定下来（服务端同一套 slug 规则），② 才有 id 可用
  const id = nextProviderId(name || "provider");
  const keyEnv =
    (state.providerSecretMode === "env" && keyEnvInput) || providerKeyEnv(id);
  return { id, name, baseUrl, keyEnv, models };
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
    startNewChat();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) closeMenu();
});

/* ── 启动 ─────────────────────────────────────────────── */

void (async () => {
  // 显式初始化一次，别指望 HTML 的 disabled 属性活到脚本跑完
  el.send.disabled = true;
  applyTheme(currentThemeChoice());
  applyActPref();
  syncThinkingPill();

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
      startNewChat();
    }
    // 用掉就清掉，否则以后每次刷新都被它拽回同一个地方
    const clean = new URL(location.href);
    clean.searchParams.delete("view");
    history.replaceState(null, "", clean.toString());
  }

  await checkHealth();
  await loadChats();
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
