/**
 * 取消 / 重试 / 自动更新
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openConversation } from "./chat-open.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { loadRoster } from "./partners-status.js";
import { openProjectAddMenu, setModalHint } from "./project-modal.js";
import { currentRoute, currentTicketId, go, tasksHash, writeTasksHash } from "./route.js";
import { state } from "./state.js";
import { loadProjects, syncTasksBadge } from "./tasks-board.js";
import { showTicketDetail } from "./tasks-detail.js";
import { loadTickets } from "./tasks-kanban.js";
import { BADGE_POLL_MS, PHASE_STATUS, TASKS_POLL_MS } from "./tasks-model.js";
import { renderTasksView } from "./tasks-redesign.js";
import { renderReview } from "./tasks-review.js";
import { closeModal, openModal, toast } from "./ui-atoms.js";

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
      else renderTasksView();
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
    if (currentRoute() === "tasks" && !currentTicketId()) renderTasksView();
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
  const gap = route === "tasks" || route === "review" ? TASKS_POLL_MS : BADGE_POLL_MS;
  if (state.ticketsFetchedAt && Date.now() - state.ticketsFetchedAt < gap) return;
  const pending = loadTickets({
    silent: true,
    force: true,
    render: route === "tasks" && !currentTicketId(),
  });
  // 今日回顾（2026-11-13 批 1）：数据同一份 state.tickets，拉回来就重画时间线
  if (route === "review") {
    void pending.then(() => {
      if (currentRoute() === "review") renderReview();
    });
  }
  // E4：花名册的 activeTickets 来自 domains（派生自任务单），低频一并刷新
  void loadRoster();
}

/* 侧栏分区头的入口（2026-11-07 统一批）：
   任务中心 —— 「打开任务中心 →」进看板；轨道按钮同。
   项目 —— ＋ 添加项目（「管理项目 → 设置」行 2026-11-13 退役，管理走设置页侧栏）。
   会话 —— ＋ 已在上面的 applySections 段注册（新建一轮）。 */
el.secTasksAll?.addEventListener("click", () => go("tasks"));
// 项目 ＋（2026-11-07 四改）：两个入口——新建项目 / 添加已有项目
el.secProjectsAdd?.addEventListener("click", () => openProjectAddMenu());

/* 任务中心的固定入口与交互（只读，不提供改派/停止）。
   轨道钮 2026-11-13 退役：轨道只镜像展开态分区，任务中心从展开态「对话」分区底部的
   「打开任务中心 →」进（`#/tasks` 路由不变）。 */
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
  renderTasksView();
});
el.tasksProject.addEventListener("change", () => {
  state.projectFilter = el.tasksProject.value;
  writeTasksHash("");
  renderTasksView();
});
el.tasksSort.addEventListener("change", () => {
  state.sort = el.tasksSort.value === "status" ? "status" : "recent";
  writeTasksHash("");
  renderTasksView();
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
  renderTasksView();
});

export { applyTicketEvent, autoSyncTick, confirmCancelTicket, performTicketAction, scheduleTasksRender, scheduleTicketsSync, tasksRenderFrame, ticketsSyncTimer };
