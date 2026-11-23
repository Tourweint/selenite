/**
 * 任务单拉取与路由入口
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 2026-11-21 随 TASKS_REDESIGN_ENABLED 退役删去旧三列看板渲染（renderBoard）；
 * loadTickets / openTasks 是新视图与详情页共用的数据与路由入口，保留。
 */

import { request } from "./net.js";
import { currentRoute, currentTicketId } from "./route.js";
import { state } from "./state.js";
import { showTasksState } from "./tasks-cards.js";
import { syncTasksBadge } from "./tasks-board.js";
import { showTicketDetail } from "./tasks-detail.js";
import { statusError } from "./tasks-model.js";
import { renderTasksView } from "./tasks-redesign.js";

/** 有一次「在飞」的拉取时，后到的渲染请求别丢：等这批数据回来补画一次。
 *  刷新页面直接落在任务中心时，首屏徽标预拉是 render:false，路由那次会因
 *  ticketsLoading 提前返回——不补画就要空到下一拍轮询（2026-11-23）。 */
let renderPending = false;

function canRenderTasks() {
  return currentRoute() === "tasks" && !currentTicketId();
}

async function loadTickets({ silent = false, force = false, render = true } = {}) {
  if (state.ticketsLoading) {
    if (render && canRenderTasks()) renderPending = true;
    return;
  }
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
    if ((render || renderPending) && canRenderTasks()) {
      renderPending = false;
      renderTasksView();
    }
  } catch (error) {
    renderPending = false;
    if (!silent && render && canRenderTasks()) {
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
  const ticketId = currentTicketId();
  if (ticketId) {
    void showTicketDetail(ticketId);
    return;
  }
  if (state.ticketsFetchedAt) renderTasksView();
  void loadTickets();
}

export { loadTickets, openTasks };
