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
  modeSwitch: document.getElementById("mode-switch"),
  exportChat: document.getElementById("export-chat"),
  ctxMeter: document.getElementById("ctx-meter"),
  queuePanelHost: document.getElementById("composer"),
  windowControls: document.getElementById("window-controls"),
  winMin: document.getElementById("win-min"),
  winMax: document.getElementById("win-max"),
  winClose: document.getElementById("win-close"),
};

/* ── 主题 ─────────────────────────────────────────────── */

const KEY_THEME = "lifediary.theme";
const KEY_ACCENT = "lifediary.accent";
const KEY_SEND = "lifediary.sendKey";
const KEY_ACTS = "lifediary.showActs";

const media = matchMedia("(prefers-color-scheme: dark)");

function currentThemeChoice() {
  return localStorage.getItem(KEY_THEME) || "system";
}

function resolvedTheme(choice) {
  if (choice === "system") return media.matches ? "dark" : "light";
  return choice === "dark" ? "dark" : "light";
}

function applyTheme(choice) {
  document.documentElement.dataset.theme = resolvedTheme(choice);
}

function setThemeChoice(choice) {
  localStorage.setItem(KEY_THEME, choice);
  applyTheme(choice);
  syncThemeControls();
}

function setAccent(name) {
  localStorage.setItem(KEY_ACCENT, name);
  document.documentElement.dataset.accent = name;
  syncThemeControls();
}

media.addEventListener("change", () => {
  if (currentThemeChoice() === "system") applyTheme("system");
});

function syncThemeControls() {
  const choice = currentThemeChoice();
  for (const button of el.settingsInner.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.themeChoice === choice));
  }
  syncThemeSlider(choice);
  const accent = localStorage.getItem(KEY_ACCENT) || "indigo";
  for (const button of el.settingsInner.querySelectorAll("[data-accent-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.accentChoice === accent));
  }
}

/*
 * 分段滑块：量出当前选中段的位置，把滑块移过去。
 * 用真实尺寸而不是百分比——三段文字长短不一（跟随系统 / 浅色 / 深色），
 * 按百分比切会让滑块和文字对不齐。位置计算方式同 cindy 的 plate。
 */
function syncThemeSlider(choice = currentThemeChoice()) {
  const slider = el.settingsInner.querySelector("[data-theme-slider]");
  if (!slider) return;
  const thumb = slider.querySelector(".segment-thumb");
  const active = slider.querySelector(`[data-theme-choice="${choice}"]`);
  if (!thumb || !active) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.height = `${active.offsetHeight}px`;
  thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
}

// 窗口变宽变窄时三段宽度会重排，滑块要重新量一次
window.addEventListener("resize", () => {
  if (!el.viewSettings.hidden) syncThemeSlider();
});

/* ── 侧栏折叠 / 首页态 / 思考档 ───────────────────────── */

function sidebarOpen() {
  return document.documentElement.dataset.sidebar !== "closed";
}

function toggleSidebar() {
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
function updateHomeMode() {
  const hasMessages = Boolean(el.thread.querySelector(".msg"));
  el.viewChat.dataset.home = hasMessages ? "0" : "1";
}

const KEY_MODE = "lifediary.mode";

function currentMode() {
  return localStorage.getItem(KEY_MODE) === "deep" ? "deep" : "fast";
}

function syncModeSwitch() {
  for (const button of el.modeSwitch.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-checked", String(button.dataset.mode === currentMode()));
  }
}

async function setMode(mode) {
  localStorage.setItem(KEY_MODE, mode);
  syncModeSwitch();
  // 还没有会话就不用下发，第一轮 `start` 回来时补
  if (!state.conversationId) return;
  await request(`/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode }),
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
  renderChats();
  clearThread();
  el.title.textContent = "新对话";
  syncExport();
  el.ctxMeter.hidden = true;
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

/** 上下文占用徽标（批次二）：done 后与切会话时刷新；window 读不到就隐藏 */
async function syncCtxMeter() {
  if (!state.conversationId || currentRoute() !== "chat") {
    el.ctxMeter.hidden = true;
    return;
  }
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/context`,
      { cache: "no-store" },
    );
    const data = await response.json();
    if (!data.used || !data.window) {
      el.ctxMeter.hidden = true;
      return;
    }
    const pct = Math.round((data.used / data.window) * 100);
    const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    el.ctxMeter.textContent = `${k(data.used)}/${k(data.window)}`;
    el.ctxMeter.title = `上下文已用 ${pct}%（${data.used.toLocaleString()} / ${data.window.toLocaleString()} tokens）`;
    el.ctxMeter.classList.toggle("warn", pct >= 70);
    el.ctxMeter.classList.toggle("danger", pct >= 90);
    el.ctxMeter.hidden = false;
  } catch {
    el.ctxMeter.hidden = true;
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
          if (event.type === "start") {
            state.conversationId = event.conversationId;
            streamConv = event.conversationId;
            localStorage.setItem(KEY_CONV, event.conversationId);
            renderChats();
            syncExport();
            // 新会话（或重启后的旧会话）要立刻出现在侧栏里——
            // 以前只靠页面加载时拉一次，新建会话要等到重载才可见，置顶/重命名都够不着
            void loadChats();
            // 新会话建好了，把当前的思考档补发给它
            if (currentMode() === "deep") void setMode("deep");
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
          } else if (event.type === "done") {
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

/* ── 收起轨道（2026-11-04）──────────────────────────────
   收起不再是整栏消失：60px 图标轨上「+ 新对话」和设置是真功能，
   任务中心 / 领域负责人 / 群组是禁用占位（HTML 里 disabled + tooltip 写明）。 */
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
          "跟随系统会按桌面的深浅色走；选浅色或深色就固定下来",
          `<div class="segment-slider" role="radiogroup" aria-label="主题" data-theme-slider>
             <span class="segment-thumb" aria-hidden="true"></span>
             <button type="button" role="radio" data-theme-choice="system" aria-checked="${choice === "system"}">跟随系统</button>
             <button type="button" role="radio" data-theme-choice="light" aria-checked="${choice === "light"}">浅色</button>
             <button type="button" role="radio" data-theme-choice="dark" aria-checked="${choice === "dark"}">深色</button>
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

    // 主题：一条滑轨上的三段，滑块跟着选中项移动
    for (const button of el.settingsInner.querySelectorAll("[data-theme-choice]")) {
      button.addEventListener("click", () => setThemeChoice(button.dataset.themeChoice));
    }
    syncThemeSlider(choice);
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
          "发送键",
          "「Ctrl+Enter」适合写长句，回车留给换行",
          `<div class="segmented" role="radiogroup" aria-label="发送键">
             <button type="button" data-send-key="enter" aria-checked="${sendKey === "enter"}">Enter 发送</button>
             <button type="button" data-send-key="mod-enter" aria-checked="${sendKey !== "enter"}">Ctrl+Enter 发送</button>
           </div>`,
        )}
        <div class="divider"></div>
        ${rowMarkup(
          "工具活动",
          "关掉就只看回答，不看「读了哪个文件、跑了什么命令」",
          `<div class="segmented" role="radiogroup" aria-label="工具活动">
             <button type="button" data-acts="1" aria-checked="${showActs}">显示</button>
             <button type="button" data-acts="0" aria-checked="${!showActs}">隐藏</button>
           </div>`,
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
          `<div class="segmented" role="radiogroup" aria-label="权限" id="policy-switch">
             <button type="button" data-policy="full" aria-checked="false">完全访问</button>
             <button type="button" data-policy="read-only" aria-checked="false">只读</button>
             <button type="button" data-policy="no-shell" aria-checked="false">不跑命令</button>
           </div>`,
        )}
      </div>`,
    )}`;

    wireSettingsSearch();
    for (const button of el.settingsInner.querySelectorAll("[data-send-key]")) {
      button.addEventListener("click", () => {
        localStorage.setItem(KEY_SEND, button.dataset.sendKey);
        for (const other of el.settingsInner.querySelectorAll("[data-send-key]")) {
          other.setAttribute("aria-checked", String(other === button));
        }
      });
    }
    for (const button of el.settingsInner.querySelectorAll("[data-acts]")) {
      button.addEventListener("click", () => {
        localStorage.setItem(KEY_ACTS, button.dataset.acts);
        applyActPref();
        for (const other of el.settingsInner.querySelectorAll("[data-acts]")) {
          other.setAttribute("aria-checked", String(other === button));
        }
      });
    }
    document.getElementById("restore-chats")?.addEventListener("click", async () => {
      await request("/api/v1/agent/chats/restore", { method: "POST" }).catch(() => undefined);
      await loadChats();
      void renderSettings();
    });
    void loadPolicy();
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
    // 模型行不套 rowMarkup：可切时右栏要换成下拉、提示行要动态改文案
    const notifyOn = localStorage.getItem(KEY_NOTIFY) === "1";
    el.settingsInner.innerHTML = sectionMarkup(
      "服务",
      `<div class="card">
        ${rowMarkup("地址", "", `<span class="kv" id="svc-address">…</span>`)}
        <div class="divider"></div>
        <div class="row">
          <div class="row-main">
            <div class="row-label">模型</div>
            <div class="row-hint" id="svc-model-hint">读取中…</div>
          </div>
          <div class="row-control" id="svc-model-control"><span class="kv" id="svc-model">…</span></div>
        </div>
        <div class="divider"></div>
        ${rowMarkup(
          "桌面通知",
          "回复完成 / 出错 / 任务单待你处理时提醒；窗口正看着那个会话就不打扰",
          `<div class="segmented" role="radiogroup" aria-label="桌面通知">
             <button type="button" data-notify="1" aria-checked="${notifyOn}">开启</button>
             <button type="button" data-notify="0" aria-checked="${!notifyOn}">关闭</button>
           </div>`,
        )}
        <div class="divider"></div>
        ${rowMarkup("鉴权", "", `<span class="kv" id="svc-auth">…</span>`)}
        <div class="divider"></div>
        ${rowMarkup("累计 token", "", `<span class="kv" id="svc-usage">…</span>`)}
      </div>`,
    );
    // 通知开关（批次二）：开的时候才请求系统权限；被拒就退回关闭并提示
    for (const button of el.settingsInner.querySelectorAll("[data-notify]")) {
      button.addEventListener("click", async () => {
        const want = button.dataset.notify === "1";
        if (!want) {
          localStorage.setItem(KEY_NOTIFY, "0");
          syncNotifyButtons(false);
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
            syncNotifyButtons(false);
            return;
          }
        }
        localStorage.setItem(KEY_NOTIFY, "1");
        syncNotifyButtons(true);
      });
    }
    function syncNotifyButtons(on) {
      for (const other of el.settingsInner.querySelectorAll("[data-notify]")) {
        other.setAttribute("aria-checked", String((other.dataset.notify === "1") === on));
      }
    }
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
  try {
    const response = await request("/api/v1/agent/policy", { cache: "no-store" });
    const data = await response.json();
    for (const button of box.querySelectorAll("[data-policy]")) {
      button.setAttribute("aria-checked", String(button.dataset.policy === data.access));
    }
  } catch {
    /* 离线就保持原样 */
  }
  for (const button of box.querySelectorAll("[data-policy]")) {
    button.addEventListener("click", async () => {
      for (const other of box.querySelectorAll("[data-policy]")) {
        other.setAttribute("aria-checked", String(other === button));
      }
      await request("/api/v1/agent/policy", {
        method: "POST",
        body: JSON.stringify({ access: button.dataset.policy }),
      }).catch(() => undefined);
    });
  }
}

/**
 * 模型行（2026-11-04，接口文档 §2.8）：清单里有多项且允许切换 → 下拉；
 * 否则只读显示当前模型。特性探测：旧服务端的 /healthz 没有 models 字段，
 * 走到只读分支，行为与改造前一致。
 */
function renderModelRow(info) {
  const control = document.getElementById("svc-model-control");
  const hint = document.getElementById("svc-model-hint");
  if (!control || !hint) return;
  const current = info.model == null ? "" : String(info.model);
  const models = Array.isArray(info.models) ? info.models.map(String) : [];
  const setHint = (text) => { hint.textContent = text; };

  if (info.llm === "mock") {
    control.innerHTML = `<span class="kv" id="svc-model">未配置（mock 回显）</span>`;
    setHint("配好 LLM_API_KEY 就能在这里切模型");
    return;
  }
  if (!current) {
    control.innerHTML = `<span class="kv" id="svc-model">读取失败</span>`;
    setHint("");
    return;
  }
  if (current === "faux" || models.length < 2) {
    control.innerHTML = `<span class="kv" id="svc-model">${esc(current)}</span>`;
    setHint(
      current === "faux"
        ? "faux 是假模型（链路验证用），没有可切的真实模型"
        : "在 .env 的 LLM_MODELS 里列几个模型就能在这里切",
    );
    return;
  }

  // 可切：下拉 + 切换反馈。同一上游端点下换模型名，密钥与地址不动（硬约束）。
  control.innerHTML = `<select class="model-select" id="svc-model-select" aria-label="选择模型">
      ${models.map((id) => `<option value="${esc(id)}"${id === current ? " selected" : ""}>${esc(id)}</option>`).join("")}
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
    const target = select.value;
    select.disabled = true;
    try {
      const response = await request("/api/v1/agent/model", {
        method: "POST",
        body: JSON.stringify({ model: target }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        say(`没切成：${data.message || data.error || `HTTP ${response.status}`}`);
        select.value = current;
        return;
      }
      say("已切换，下一轮用新模型；首轮会慢一点（上游缓存重建）。");
    } catch (error) {
      if (error.message !== "forbidden") say(`没切成：${error.message}`);
      select.value = current;
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
    const health = await request("/healthz", { cache: "no-store" });
    const info = await health.json();
    renderModelRow(info);
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

for (const button of el.modeSwitch.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => void setMode(button.dataset.mode));
}

/* ── 启动 ─────────────────────────────────────────────── */

void (async () => {
  // 显式初始化一次，别指望 HTML 的 disabled 属性活到脚本跑完
  el.send.disabled = true;
  applyTheme(currentThemeChoice());
  applyActPref();
  syncModeSwitch();

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
  if (state.conversationId) await openChat(state.conversationId);
  updateHomeMode();
  // 侧栏「任务中心」的进行中徽标：静默拉一次，读不到就只当没有；
  // 之后由 autoSyncTick 低频兜底（看板 20s / 对话页 60s），SSE 事件到达时直接增量更新。
  void loadTickets({ silent: true, render: false });
  applyRoute();
  setInterval(checkHealth, 8000);
  setInterval(autoSyncTick, 5000);
})();
