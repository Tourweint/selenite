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

/* ── 连接横幅（2026-11-25）───────────────────────────────
 * 用户口径：网断了、它自动重连，界面上什么提示都没有。
 * 这里给一条全站固定的提示：断开时说明"正在自动重连"，回来后报一句"已重新连接"。
 * 不替代侧栏状态点，只是让这件事在视野里有一句话（任何页面都看得到）。
 * 首次连接成功不弹横幅；只有"先连上过、后来断了"才提示。
 */
let everConnected = false;
// idle（还没连过 / 正常且没断过）| down（客户端断网）| retry（服务失联，重连中）| ok（已恢复）
let connState = "idle";
let connBannerTimer = 0;

function ensureConnBanner() {
  const existing = document.getElementById("connBanner");
  if (existing) return existing;
  const banner = document.createElement("div");
  banner.id = "connBanner";
  banner.className = "conn-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.hidden = true;
  const dot = document.createElement("span");
  dot.className = "conn-banner-dot";
  const text = document.createElement("span");
  text.className = "conn-banner-text";
  banner.append(dot, text);
  document.body.append(banner);
  return banner;
}

function showConnBanner(kind, text, hideAfter = 0) {
  const banner = ensureConnBanner();
  clearTimeout(connBannerTimer);
  banner.dataset.kind = kind;
  banner.querySelector(".conn-banner-text").textContent = text;
  banner.hidden = false;
  if (hideAfter > 0) {
    connBannerTimer = setTimeout(() => {
      banner.hidden = true;
    }, hideAfter);
  }
}

function offlineNow() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// 浏览器自己的在线事件先到一步：不等 8 秒轮询，立刻把话说出来。
window.addEventListener("offline", () => {
  if (!everConnected) return;
  // 用户自己停的服务：断网提示会跟"已停止"打架（同 checkHealth 的口径）。
  if (document.body.dataset.runtime === "stopped") return;
  connState = "down";
  showConnBanner("down", "网络已断开，正在等待恢复…");
  setStatus("off", "网络断开");
});

window.addEventListener("online", () => {
  if (!everConnected) return;
  if (document.body.dataset.runtime === "stopped") return;
  connState = "retry";
  showConnBanner("retry", "网络已恢复，正在重新连接…");
  void checkHealth();
});

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
    everConnected = true;
    // 之前报过断（down / retry）才提示恢复；首屏连接成功不弹横幅。
    if (connState === "down" || connState === "retry") {
      connState = "ok";
      showConnBanner("ok", "已重新连接", 2400);
    }
    // 门开着的时候别把状态灯改回"在线"——那会跟"需要令牌"自相矛盾。
    if (el.gate.hidden) {
      setStatus("ok", info.llm === "mock" ? "已连接 · mock" : "已连接");
    }
    syncPartnerDots();
    return true;
  } catch (error) {
    if (error.message !== "forbidden") {
      state.serviceOk = false;
      if (everConnected) {
        const kind = offlineNow() ? "down" : "retry";
        // 状态没变就不重复弹（轮询 8 秒一次，别让横幅一直重播入场动画）。
        if (connState !== kind) {
          showConnBanner(
            kind,
            kind === "down" ? "网络已断开，正在等待恢复…" : "与服务的连接中断，正在自动重连…",
          );
        }
        connState = kind;
      }
      setStatus("off", offlineNow() ? "网络断开" : "服务离线");
      syncPartnerDots();
    }
    return false;
  }
}

export { authHeaders, checkHealth, readToken, request, setStatus, showGate };
