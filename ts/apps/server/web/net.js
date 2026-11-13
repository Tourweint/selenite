/**
 * 令牌 / 网络请求 / 状态灯
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openChat } from "./chat-open.js";
import { loadChats } from "./chats-list.js";
import { KEY_TOKEN, el } from "./dom.js";
import { syncPartnerDots } from "./partners-status.js";
import { refreshProjectPill } from "./project-modal.js";
import { applyRoute, currentRoute, noteRouteChange } from "./route.js";
import { state } from "./state.js";

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

/** 展开侧栏的状态点（唯一的服务状态灯，2026-11-08 收起态的点退役；
 *  收起轨道齿轮的 data-tip 兜底 2026-11-13 一并退役——悬停说明文字全部不挂）。 */
function setStatus(stateName, text) {
  el.status.dataset.state = stateName;
  el.statusText.textContent = text;
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
      setStatus("ok", info.llm === "mock" ? "已连接 · mock" : "已连接");
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

export { authHeaders, checkHealth, readToken, request, setStatus, showGate };
