/**
 * 看板骨架与拉取
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { request } from "./net.js";
import { currentRoute, currentTicketId, tasksParams } from "./route.js";
import { state } from "./state.js";
import { boardEmptyNote, conversationCard, dispatchedCount, filterEmptyNote, loadProjects, renderArchive, renderDirect, renderHitters, renderStats, syncDomainOptions, syncProjectOptions, syncTasksBadge } from "./tasks-board.js";
import { cardMatchesFilters, directMatchesFilters, groupByConversation, hideTasksState, showTasksState, sortCards } from "./tasks-cards.js";
import { showTicketDetail } from "./tasks-detail.js";
import { TASK_COLUMNS, statusError } from "./tasks-model.js";
import { ensureTasksRedesignFlag, renderTasksView } from "./tasks-redesign.js";

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
        : `共 ${cards.length} 个对话 · ${dispatchedCount(cards, direct)} 次派活`;
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
    if (render && !silent) renderTasksView();
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
    if (render && currentRoute() === "tasks" && !currentTicketId()) renderTasksView();
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
  if (state.ticketsFetchedAt) renderTasksView();
  // 回滚开关只问一次：先按新视图画（flag 未知 = 新视图），回来若是 false 自动转旧看板
  void ensureTasksRedesignFlag().then(() => {
    if (currentRoute() === "tasks" && !currentTicketId()) renderTasksView();
  });
  void loadTickets();
}

export { loadTickets, openTasks, renderBoard };
