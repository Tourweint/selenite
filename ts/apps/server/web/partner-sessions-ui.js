/**
 * 一人多会话 · 选择器弹层（2026-11-17 批2）。
 *
 * 数据来自服务端 GET /api/v1/partners/:id/sessions（批1 契约）；弹层复用 openModal，
 * 不新造浮层。纯解析在同目录 partner-sessions.js（node --test 可直接 import，本模块不进单测）。
 */

import { loadChats } from "./chats-list.js";
import { openChat, syncTitleSessionAffordance } from "./chat-open.js";
import { request } from "./net.js";
import { go } from "./route.js";
import { state } from "./state.js";
import { closeModal, modalOpen, openModal, toast } from "./ui-atoms.js";
import { partnerSessionLabel } from "./partner-sessions.js";

const SIDE_SESSIONS_KEY = "PARTNER_SIDE_SESSIONS";

/**
 * 弹层复用同一个 el.modalBody：A 的请求未回就关掉再开 B，A 回来时不能覆盖 B。
 * 每次打开递增 generation，所有 await 之后先比对，过期响应一律丢弃。
 */
let pickerGeneration = 0;

/** 人设名：本地取 state.partners（不 import partners-status.js，避免循环依赖与命名导入坑）。 */
function displayNameOf(partnerId) {
  const partner = state.partners.find((item) => item && item.id === partnerId);
  const name = String(partner?.name || "").trim();
  if (name) return name;
  return partnerId === "chief" ? "总管" : "执事";
}

/**
 * 插件开关：复用 state.flagsCache（GET /api/v1/agent/flags 只拉一次，与设置页同源）。
 * 读取失败 / 字段缺失 → 按关处理（不渲染入口按钮）。
 */
async function ensureSideSessionsFlag() {
  if (!state.flagsCache) {
    try {
      const response = await request("/api/v1/agent/flags", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json().catch(() => ({}));
      const list = Array.isArray(data.flags) ? data.flags : [];
      state.flagsCache = new Map(
        list
          .filter((item) => item && typeof item.key === "string")
          .map((item) => [item.key, item]),
      );
    } catch {
      state.flagsCache = new Map();
    }
  }
  const flag = state.flagsCache.get(SIDE_SESSIONS_KEY);
  if (!flag) return false;
  // effectiveValue 已含父闸（COMPANIONS_ENABLED）的锁态；缺这两个字段也按关。
  const raw = flag.effectiveValue ?? flag.value;
  return typeof raw === "string" && raw !== "false" && raw !== "0" && raw !== "off";
}

/** 服务端说插件关了：收弹层、给提示、把界面上所有入口按钮就地撤掉。 */
function onSideSessionsDisabled() {
  closeModal();
  toast("副会话插件已关闭（设置 → 插件）");
  state.sideSessionsEnabled = false;
  document.querySelectorAll(".roster-sessions, .chief-sessions").forEach((btn) => btn.remove());
  syncTitleSessionAffordance("");
}

/** 相对时间：只给「N 分钟前 / N 小时前 / N 天前」，够选择器次要信息用。 */
function relativeTime(at) {
  const time = Number(at) || 0;
  if (!time) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/** 打开一条已有会话：关弹层 → 切对话路由 → 回读；顺手刷一次侧栏列表。 */
function openExistingConversation(conversationId) {
  if (!conversationId) return;
  closeModal();
  go("chat");
  void openChat(conversationId);
  void loadChats().catch(() => undefined);
}

/** 走 /open 建还没开始的主对话（服务端负责 canonical 去重与首次问候）。 */
async function openPartnerMain(partnerId) {
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/open`, {
      method: "POST",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      toast(data.message || data.error || "打开主对话失败，稍后再试");
      return;
    }
    const data = await response.json().catch(() => ({}));
    const conversationId = String(data.conversationId || "");
    if (!conversationId) {
      toast("服务端返回不完整，稍后再试");
      return;
    }
    openExistingConversation(conversationId);
  } catch (error) {
    toast(error.message === "forbidden" ? "鉴权失败" : "打开主对话失败，稍后再试");
  }
}

/** 新建一条会话：执事建 side，总管建 chief；首条消息会自动写标题。 */
async function createSession(partnerId) {
  try {
    const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (response.status === 400) {
      const data = await response.json().catch(() => ({}));
      if (data.error === "side_sessions_disabled") {
        onSideSessionsDisabled();
        return;
      }
      toast(data.message || data.error || "新建会话失败");
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      toast(data.message || data.error || "新建会话失败，稍后再试");
      return;
    }
    const data = await response.json().catch(() => ({}));
    const conversationId = String(data.conversationId || "");
    if (!conversationId) {
      toast("服务端返回不完整，稍后再试");
      return;
    }
    openExistingConversation(conversationId);
  } catch (error) {
    toast(error.message === "forbidden" ? "鉴权失败" : "新建会话失败，稍后再试");
  }
}

/** 选择器行：当前会话精确按 conversationId 匹配（不靠前缀猜）。 */
function sessionRow(session, { main = false } = {}) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `ps-row${main ? " ps-main" : ""}`;
  const name = document.createElement("span");
  name.className = "ps-name";
  // 主行固定叫「主对话」：服务端首句可能是 [Scheduled run context] 这类系统指令原文，不该当标题。
  name.textContent = main ? "主对话" : partnerSessionLabel(session);
  row.append(name);
  const turns = Number(session.turns) || 0;
  if (main || turns > 0) {
    const meta = document.createElement("span");
    meta.className = "ps-meta";
    // 副会话 turns=0 时名字已是「新会话」，meta 再写一遍会变成「新会话新会话」。
    meta.textContent = main
      ? (turns > 0 ? `${turns} 轮 · ${relativeTime(session.lastAt)}` : "还没开始")
      : `${turns} 轮 · ${relativeTime(session.lastAt)}`;
    row.append(meta);
  }
  if (session.conversationId === state.conversationId) {
    row.setAttribute("aria-current", "true");
    row.disabled = true;
  }
  row.addEventListener("click", () => openExistingConversation(session.conversationId));
  return row;
}

function renderSessionRows(body, data, partnerId, isChief) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const desc = document.createElement("p");
  desc.className = "modal-desc";
  desc.textContent = isChief
    ? "总管没有链接表：第一条是主对话，其余是副会话（按最近使用排序）。"
    : "人设、记忆与项目照旧共用；选一条继续，或新建一条。";
  body.append(desc);

  const list = document.createElement("div");
  list.className = "ps-list";

  // 主对话：执事取 canonical；没开过就走 /open。总管取服务端排好序的第一条；
  // 一条都没有时，点主对话 = 新建 chief 会话。
  const main = isChief ? sessions[0] : sessions.find((item) => item?.role === "canonical");
  if (main) {
    list.append(sessionRow(main, { main: true }));
  } else {
    const pending = document.createElement("button");
    pending.type = "button";
    pending.className = "ps-row ps-main";
    pending.textContent = "主对话（还没开始）";
    pending.addEventListener("click", () => {
      if (isChief) void createSession(partnerId);
      else void openPartnerMain(partnerId);
    });
    list.append(pending);
  }

  // 副会话：执事取 role=side；总管取除第一条以外的 chief 会话，顺序照服务端。
  const sides = isChief ? sessions.slice(1) : sessions.filter((item) => item?.role === "side");
  for (const session of sides) list.append(sessionRow(session));
  body.append(list);

  const create = document.createElement("button");
  create.type = "button";
  create.className = "ghost ps-create";
  create.textContent = "新建会话";
  create.addEventListener("click", () => void createSession(partnerId));
  body.append(create);
}

/** 入口：花名册 / 总管条目 / 对话顶栏共用。 */
function openPartnerSessions(partnerId) {
  if (!partnerId) return;
  const gen = ++pickerGeneration;
  const isChief = partnerId === "chief";
  const name = displayNameOf(partnerId);
  openModal(`${name}的会话`, (body) => {
    const loading = document.createElement("p");
    loading.className = "modal-desc";
    loading.textContent = "正在读取会话…";
    body.append(loading);
    void (async () => {
      // 每次 await 之后、动弹层之前都先判 generation：过期请求一律丢弃。
      const stale = () => gen !== pickerGeneration || !modalOpen();
      let response;
      try {
        response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/sessions`, {
          cache: "no-store",
        });
      } catch (error) {
        if (stale()) return;
        closeModal();
        toast(error.message === "forbidden" ? "鉴权失败" : "读取会话失败，稍后再试");
        return;
      }
      if (stale()) return;
      if (response.status === 400) {
        const data = await response.json().catch(() => ({}));
        if (stale()) return;
        if (data.error === "side_sessions_disabled") {
          onSideSessionsDisabled();
          return;
        }
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (stale()) return;
        closeModal();
        toast(data.message || data.error || "读取会话失败，稍后再试");
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (stale()) return;
      body.replaceChildren();
      renderSessionRows(body, data, partnerId, isChief);
    })();
  });
}

export { ensureSideSessionsFlag, openPartnerSessions };
