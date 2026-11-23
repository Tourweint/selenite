/**
 * 会话列表与归档二次确认
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openConversation, startNewChat } from "./chat-open.js";
import { renderGroupedChats } from "./chats-groups.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { chiefDisplayName } from "./partners-status.js";
import { currentRoute } from "./route.js";
import { openMenuAt, openSecMenu } from "./sec-menu.js";
import { state } from "./state.js";
import { renderSideListEmpty } from "./tasks-board.js";
import { inShell, toast } from "./ui-atoms.js";

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
    // 2026-11-15 侧栏按创建者分组：任务专线会话清单（增量键；老服务端没有）
    state.taskChats = Array.isArray(data.tasks) ? data.tasks : [];
    renderChats();
  } catch {
    /* 离线时保持旧列表 */
  }
}

function chatLabel(chat) {
  return chat.title || chat.firstText || "（无标题）";
}

/** 最近会话的过滤与排序（展开态「任务」分区〔2026-11-21 由「对话」改名〕与轨道浮卡共用这一份口径）。
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

/** 置顶 / 取消置顶：行内星标与右键菜单共用一份实现。 */
async function toggleChatPin(chat) {
  await request(
    `/api/v1/agent/chat/${encodeURIComponent(chat.conversationId)}/pin`,
    { method: "POST", body: JSON.stringify({ pinned: !chat.pinned }) },
  ).catch(() => undefined);
  await loadChats();
}

function buildChatRow(chat) {
  const row = document.createElement("div");
  row.className = "chat";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
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

  // 行尾一颗 ⋯（2026-11-21，用户口径「三个小图标取消」）：悬停才出现的一颗点，
  // 重命名 / 置顶 / 归档收进菜单，与分区头 ⋯ 同一套（openSecMenu，壳里走原生小窗）；
  // 忙态在打开菜单时现算（建行快照会过时）。右键菜单不变（attachChatContextMenu）。
  const actions = document.createElement("span");
  actions.className = "chat-actions";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "chat-act chat-more";
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-label", "会话动作");
  more.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>';
  more.addEventListener("click", (event) => {
    // 不拦会把行点开：⋯ 的 click 会冒泡到「点行 = 进对话」
    event.stopPropagation();
    // 解释行退役（2026-11-21 用户口径「就重命名、置顶、归档三个就行」）：忙态用
    // 灰置表达，不写提示行；确认条与 400 toast 还在，误触有兜底。
    const archiveBusy = state.sending && chat.conversationId === state.conversationId;
    openSecMenu(more, [
      { label: "重命名", run: () => startRename(row, chat) },
      { label: chat.pinned ? "取消置顶" : "置顶", run: () => void toggleChatPin(chat) },
      { separator: true },
      { label: "归档", disabled: archiveBusy, run: () => openChatArchiveConfirm(row, chat) },
    ]);
  });
  actions.append(more);
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
  // 右键（2026-11-16）：行尾 ⋯ 与右键互为两个入口（2026-11-21 起 ⋯ 是主入口，
  // 原三颗悬停图标退役）；实现与 ⋯ 菜单同一份 items 口径。
  // 收起轨道的会话浮卡也复用这一份（attachChatContextMenu）。
  attachChatContextMenu(row, chat);
  return row;
}

/**
 * 给会话行挂右键菜单。收起轨道的浮卡行不是 buildChatRow 建的，
 * 但对象还是同一条会话——菜单内容与行为保持一致。
 * @param {HTMLElement} row
 * @param {any} chat
 * @param {{ onOpen?: (() => void) | null, compact?: boolean }} [options]
 */
function attachChatContextMenu(row, chat, options = {}) {
  row.addEventListener("contextmenu", (event) => {
    // Web 端不拦原生右键（用户 2026-11-16 口径）；壳里才挂自绘菜单
    if (!inShell()) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]")) return;
    event.preventDefault();
    const open = () => (options.onOpen ? options.onOpen() : void openConversation(chat.conversationId));
    const archiveBusy = state.sending && chat.conversationId === state.conversationId;
    const items = [{ label: "打开", run: open }];
    // 收起轨道的浮卡是临时预览：点菜单时浮卡就开始退场，行内改名 / 行内归档确认
    // 没法留在屏上。浮卡里只给不依赖行 DOM 的两项，展开侧栏里才是完整菜单。
    if (!options.compact) {
      items.push(
        { label: "重命名", run: () => startRename(row, chat) },
        { label: chat.pinned ? "取消置顶" : "置顶", run: () => void toggleChatPin(chat) },
        { separator: true },
        // 解释行退役（2026-11-21，与 ⋯ 菜单同一份口径）：忙态用灰置表达
        { label: "归档", disabled: archiveBusy, run: () => openChatArchiveConfirm(row, chat) },
      );
    } else {
      items.push({ label: chat.pinned ? "取消置顶" : "置顶", run: () => void toggleChatPin(chat) });
    }
    openMenuAt(event.clientX, event.clientY, items, chatLabel(chat));
  });
}

function renderChats() {
  const ordered = recentChatsOrdered();
  const rows = ordered.slice(0, RECENTS_LIMIT).map(buildChatRow);

  // 2026-11-21 二次翻案（用户口径「咱们这个在其他区域里，那这个也没有啊」）：
  // 「其他」组**常驻**——一条任务都没有也套文件夹，普通对话永远待在「其他」里，不再平铺。
  // 旧口径"没有任务可归时套一层文件夹只是噪音"当日作废。服务端没带 tasks 键的老服务
  // 也走这条路：分组照画，只是暂时没有总管 / 执事组（要服务重启下发 tasks 键才有）。
  renderGroupedChats(rows);
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

export { RECENTS_LIMIT, attachChatContextMenu, chatArchiveConfirm, chatLabel, closeChatArchiveConfirm, confirmChatArchive, loadChats, openChatArchiveConfirm, recentChatsOrdered, renderChats, startRename };
