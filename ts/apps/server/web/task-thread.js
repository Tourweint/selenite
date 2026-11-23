/**
 * 任务线程（2026-11-22 底层工人统一进池）。
 *
 * `task-<ticketId>` 会话是这张单的可视线程；执行在池进程里。
 * 这里只做两件前端的事：
 *   1. 在这个会话里发话 → 按票状态分流到 steer（跑动中）或 /tickets/:id/say（等回答）；
 *      不再走 `/agent/chat`，因此不会触发宿主投影模型的一轮生成。
 *   2. 轮询线程消息，把 mirror 写进来的进度 / 汇报 / 上报实时补到屏幕上。
 *
 * 刻意不做：附件、编辑重发、多选模型——任务线程不是普通助手会话。
 */

import { addMessage } from "./chat-thread.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { currentRoute } from "./route.js";
import { state } from "./state.js";
import { renderTranscriptMessage } from "./chat-open.js";
import { toast } from "./ui-atoms.js";

const TASK_PREFIX = "task-";
const ACTIVE_STATUSES = new Set(["received", "planning", "dispatching", "running"]);
const POLL_MS = 2000;

let pollTimer = 0;
let polling = false;
let currentConv = "";
let lastAt = 0;
let firstSeenAt = 0;
/** 乐观气泡与 durable 回读去重：say 会落一条同文的 user 条目，别显示两遍。 */
let pendingUser = null;

export function isTaskConversation(conversationId) {
  return typeof conversationId === "string" && conversationId.startsWith(TASK_PREFIX);
}

export function taskTicketIdOf(conversationId) {
  return isTaskConversation(conversationId) ? conversationId.slice(TASK_PREFIX.length) : "";
}

function ticketStatus(ticketId) {
  const ticket = state.tickets?.find((item) => item.id === ticketId);
  return String(ticket?.status || "");
}

function lastRenderedAt() {
  const nodes = el.thread?.querySelectorAll(".msg[data-at]");
  const last = nodes && nodes.length > 0 ? nodes[nodes.length - 1] : null;
  return last ? Number(last.dataset.at || 0) : 0;
}

/** 发一句话给这张单的执行端；返回 false = 没送出去（调用方把原文放回输入框）。 */
export async function sendTaskMessage(text) {
  const conversationId = state.conversationId;
  const ticketId = taskTicketIdOf(conversationId);
  const body = String(text || "").trim();
  if (!ticketId || !body) return false;
  const active = ACTIVE_STATUSES.has(ticketStatus(ticketId));
  const endpoint = active
    ? `/api/v1/agent/delegations/${encodeURIComponent(ticketId)}/message`
    : `/api/v1/tickets/${encodeURIComponent(ticketId)}/say`;
  try {
    const response = await request(endpoint, {
      method: "POST",
      body: JSON.stringify(active ? { mode: "steer", text: body } : { text: body }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data?.message || (active ? "工人这会儿没在跑，收不到插话" : "这句话没送出去"));
      return false;
    }
    // 乐观气泡：steer 不进 durable 的线程消息，靠这一条给用户回执；
    // say 会落同文 user 条目，轮询时按 pendingUser 跳过，避免两遍。
    addMessage("user", body, Date.now());
    pendingUser = { text: body, until: Date.now() + 15000 };
    return true;
  } catch (error) {
    toast(`没送出去：${error.message === "forbidden" ? "鉴权失败" : error.message}`);
    return false;
  }
}

async function pollOnce() {
  const conversationId = state.conversationId;
  if (!isTaskConversation(conversationId) || currentRoute() !== "chat") {
    currentConv = "";
    return;
  }
  if (polling) return;
  if (currentConv !== conversationId) {
    currentConv = conversationId;
    lastAt = lastRenderedAt();
    firstSeenAt = Date.now();
    return;
  }
  // 刚打开会话：openChat 的历史可能还在渲染，等它落定再接管。
  if (lastAt === 0) {
    const rendered = lastRenderedAt();
    if (rendered > 0) lastAt = rendered;
    else if (Date.now() - firstSeenAt < 5000) return;
  }
  polling = true;
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=200`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const data = await response.json();
    if (state.conversationId !== conversationId) return;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    for (const message of messages) {
      const at = Number(message.at || 0);
      if (!at || at <= lastAt) continue;
      if (
        pendingUser &&
        message.role === "user" &&
        message.text === pendingUser.text &&
        at <= pendingUser.until
      ) {
        lastAt = Math.max(lastAt, at);
        pendingUser = null;
        continue;
      }
      renderTranscriptMessage(message);
      lastAt = Math.max(lastAt, at);
    }
    if (pendingUser && Date.now() > pendingUser.until) pendingUser = null;
  } catch {
    // 轮询失败不打扰用户：下一拍再试
  } finally {
    polling = false;
  }
}

export function startTaskThreadPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => {
    void pollOnce();
  }, POLL_MS);
}

startTaskThreadPolling();
