/**
 * 会话列表与归档二次确认
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openConversation, startNewChat } from "./chat-open.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { chiefDisplayName } from "./partners-status.js";
import { currentRoute } from "./route.js";
import { state } from "./state.js";
import { renderSideListEmpty } from "./tasks-board.js";
import { toast } from "./ui-atoms.js";

/* ── 会话列表 ─────────────────────────────────────────── */

// E4：侧栏「最近会话」折叠块只列前 5 条，其余去设置→会话搜索（#/settings/sessions）。
const RECENTS_LIMIT = 5;

async function loadChats() {
  try {
    const response = await request("/api/v1/agent/chats?limit=50", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    state.chats = data.chats || [];
    state.archived = data.archived || 0;
    renderChats();
  } catch {
    /* 离线时保持旧列表 */
  }
}

function chatLabel(chat) {
  return chat.title || chat.firstText || "（无标题）";
}

/** 最近会话的过滤与排序（展开态「对话」分区与轨道浮卡共用这一份口径）。
    置顶的排前面（2026-11-04 批次一），段内保持原有顺序（旧→新）；标记走标题前缀，
    不另起分组栏。partner- 前缀（执事专线 / 群成员会话，2026-11-06 群组方案 §2.2）
    不进最近会话：执事的对话从花名册进，群从群组节进——这里漏过滤会把执事会话当
    主人会话摆出来（实测踩过）。总管会话（chatKind=chief）也不进这张列表（2026-11-07
    用户拍板）：「主会话就不要了，总管跟主会话是一个效果，把它从界面上删掉」。
    总管会话仍是真会话、仍能从顶部「总管」条目打开（openChiefChat 读的是 state.chats
    全量，不受这条过滤影响），只是不再作为一条「管不了也删不掉」的行混在最近会话里。 */
function recentChatsOrdered() {
  return [...state.chats]
    .filter((chat) => !String(chat.conversationId || "").startsWith("partner-"))
    .filter((chat) => (chat.chatKind || "chief") !== "chief")
    .reverse()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}

function renderChats() {
  el.chats.replaceChildren();
  const ordered = recentChatsOrdered();
  // 空态（2026-11-07 四改）：会话与任务合并成一块后，空态也只说一句。
  // 这里先不放占位，等任务行也渲染完，由 renderSideListEmpty() 统一判——
  // 否则「没有会话」和「没有在跑的活」会同时出现两行。

  // 只展示前 RECENTS_LIMIT 条；更多的在设置→会话里搜（#/settings/chats）。
  for (const chat of ordered.slice(0, RECENTS_LIMIT)) {
    const row = document.createElement("div");
    row.className = "chat";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = `${chatLabel(chat)} · ${chat.turns} 轮${chat.pinned ? " · 已置顶" : ""}`;
    row.dataset.conv = chat.conversationId;
    // 选中态只在对话路由里成立（2026-11-07 修）：进了群聊 / 任务页 / 设置页，
    // 这条会话仍是「上次打开的那条」，但屏幕上已经不是它了——继续亮着会把人的
    // 位置感带错（截图里群列表旁边还亮着一条会话，看着像同时在两处）。
    if (chat.conversationId === state.conversationId && currentRoute() === "chat") {
      row.setAttribute("aria-current", "true");
    }

    const label = document.createElement("span");
    label.className = "chat-title";
    label.textContent = `${chat.pinned ? "★ " : ""}${chatLabel(chat)}`;
    row.append(label);

    // 悬停才出现：置顶 / 重命名 / 归档。不做下拉菜单，三个图标够了。
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

    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "chat-act";
    // 归档图标（Lucide archive）：✕ 会被读成删除，和「归档」语义相反（2026-11-12）
    archive.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
    // 防误触（2026-11-13 对齐 ZCode）：当前会话正在流式输出时图标禁用（title 说明）；
    // 其余行的忙态界面不知道，由服务端 400 兜底（行内确认条确认后才 POST）。
    // dataset.chatArchive 给 setSending 用：发送/停止切换时同步这一个按钮，不重渲染整列。
    archive.dataset.chatArchive = chat.conversationId;
    const archiveBusy = state.sending && chat.conversationId === state.conversationId;
    archive.disabled = archiveBusy;
    archive.title = archiveBusy ? "会话正在运行，请先停止再归档" : "归档（会话和记忆都还在）";
    archive.setAttribute("aria-label", "归档会话");
    archive.addEventListener("click", (event) => {
      event.stopPropagation();
      if (archive.disabled) return;
      openChatArchiveConfirm(row, chat);
    });

    actions.append(rename, archive, pin);
    row.append(actions);

    // 点会话行 = 进这条对话。2026-11-07 修：以前只 openChat、不切路由，
    // 从群聊 / 任务 / 设置页点过来时内容在背后换了、屏幕还停在原页（用户报的
    // 「点了群聊之后点对话，界面切换不了」）。统一走 openConversation()，
    // 与搜索结果、任务卡头、通知点击同一份"先切路由再回读"的口径。
    row.addEventListener("click", () => void openConversation(chat.conversationId));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void openConversation(chat.conversationId);
      }
    });
    el.chats.append(row);
  }
  renderSideListEmpty();
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
        // 总管会话的顶栏是身份（「总管」），不是会话名：改名只进侧栏清单，不动顶栏（2026-11-13）
        const isChiefChat =
          !String(chat.conversationId).startsWith("partner-") &&
          (chat.chatKind || state.chatKind || "chief") === "chief";
        el.title.textContent = isChiefChat ? chiefDisplayName() : value || "新对话";
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

/* ── 归档行内二次确认（2026-11-13 对齐 ZCode 防误触）──────
   点归档图标不再直接 POST：图标旁出现「归档？确认 / 取消」小条（行内确认，非弹窗），
   确认才归档；点别处 / 取消收起。同一时刻只允许一条。 */

let chatArchiveConfirm = null; // { bar, chat }：当前打开的确认条

function closeChatArchiveConfirm() {
  if (!chatArchiveConfirm) return;
  const { bar } = chatArchiveConfirm;
  chatArchiveConfirm = null;
  document.removeEventListener("click", closeChatArchiveConfirm, true);
  bar.remove();
}

function openChatArchiveConfirm(row, chat) {
  closeChatArchiveConfirm();
  const bar = document.createElement("span");
  bar.className = "chat-archive-confirm";
  bar.innerHTML = `<span class="chat-archive-q">归档？</span>
    <button class="chat-archive-yes" type="button">确认</button>
    <button class="chat-archive-no" type="button">取消</button>`;
  // 条内任何点击都不往外冒：不触发行打开，也不触发 document 的「点别处收起」
  bar.addEventListener("click", (event) => event.stopPropagation());
  bar.querySelector(".chat-archive-yes").addEventListener("click", (event) => {
    event.stopPropagation();
    const yes = event.currentTarget;
    if (yes instanceof HTMLButtonElement) yes.disabled = true;
    void confirmChatArchive(chat);
  });
  bar.querySelector(".chat-archive-no").addEventListener("click", (event) => {
    event.stopPropagation();
    closeChatArchiveConfirm();
  });
  row.append(bar);
  chatArchiveConfirm = { bar, chat };
  // 捕获段挂 document：点任何别处先收起确认条，再让那次点击照常干活
  document.addEventListener("click", closeChatArchiveConfirm, true);
}

async function confirmChatArchive(chat) {
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(chat.conversationId)}/archive`,
      { method: "POST" },
    );
    closeChatArchiveConfirm();
    if (!response.ok) {
      // 400 = 业务拒绝（忙时「会话正在运行，请先停止再归档」）：toast 服务端文案。
      // message 在前：error 是机器码（conversation_busy），人要看的是说明文字。
      const data = await response.json().catch(() => ({}));
      toast(data?.message || data?.error || `归档没成功：HTTP ${response.status}`);
      return;
    }
    if (chat.conversationId === state.conversationId) startNewChat();
    await loadChats();
  } catch (error) {
    closeChatArchiveConfirm();
    if (error.message !== "forbidden") toast(`归档没成功：${error.message}`);
  }
}

export { RECENTS_LIMIT, chatArchiveConfirm, chatLabel, closeChatArchiveConfirm, confirmChatArchive, loadChats, openChatArchiveConfirm, recentChatsOrdered, renderChats, startRename };
