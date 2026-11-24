/**
 * 一人多会话 · 选择器弹层（2026-11-17 批2）。
 *
 * 数据来自服务端 GET /api/v1/partners/:id/sessions（批1 契约）；弹层复用 openModal，
 * 不新造浮层。纯解析在同目录 partner-sessions.js（node --test 可直接 import，本模块不进单测）。
 */

import { loadChats } from "./chats-list.js";
import { openChat, startNewChat } from "./chat-open.js";
import { request } from "./net.js";
import { go } from "./route.js";
import { state } from "./state.js";
import { closeModal, modalOpen, openModal, toast } from "./ui-atoms.js";
import { buildSessionTree, paginateSessionTree, partnerSessionLabel } from "./partner-sessions.js";

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

/** 服务端说插件关了：收弹层、给提示；入口已收进右键菜单（2026-11-23），
    此后打开的菜单不再挂「选择会话」。 */
function onSideSessionsDisabled() {
  closeModal();
  toast("副会话插件已关闭（设置 → 插件）");
  state.sideSessionsEnabled = false;
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

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

/** 翻页箭头（2026-11-21）：与全站 chevron 同两条 path 族；左右是固定方向，不走 aria-expanded 旋转。 */
const PAGER_PREV_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const PAGER_NEXT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

/** 选择器行：当前会话精确按 conversationId 匹配（不靠前缀猜）。
 *  2026-11-18：包一层 .ps-item，垃圾桶是行的兄弟（button 不能套 button）；
 *  有 origin 的副本名前置「↳」，配合缩进表达"挂在母会话下面"。 */
function sessionRow(
  session,
  {
    main = false,
    deletable = false,
    onDelete = null,
    onOpen = null,
    currentId = "",
    disableCurrent = true,
  } = {},
) {
  const item = document.createElement("div");
  item.className = "ps-item";

  const row = document.createElement("button");
  row.type = "button";
  row.className = `ps-row${main ? " ps-main" : ""}`;
  const name = document.createElement("span");
  name.className = "ps-name";
  if (session.origin && !main) {
    const mark = document.createElement("span");
    mark.className = "ps-branch-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "↳";
    name.append(mark);
  }
  // 主行固定叫「主对话」：服务端首句可能是 [Scheduled run context] 这类系统指令原文，不该当标题。
  name.append(document.createTextNode(main ? "主对话" : partnerSessionLabel(session)));
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
  if (currentId && session.conversationId === currentId) {
    row.setAttribute("aria-current", "true");
    row.disabled = disableCurrent;
  }
  row.addEventListener("click", () => {
    if (typeof onOpen === "function") onOpen(session);
    else openExistingConversation(session.conversationId);
  });
  item.append(row);

  if (deletable && typeof onDelete === "function") {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ps-del";
    del.innerHTML = TRASH_ICON;
    del.setAttribute("aria-label", "删除这条分支会话");
    del.setAttribute("data-tip", "删除这条分支会话（不可恢复）");
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      onDelete(session);
    });
    item.append(del);
  }
  return item;
}

/** 打开到哪儿（2026-11-18）：同一个选择器既能去对话，也能直接切会话地图。
 *  两个位置固定（去对话 / 看地图），不随当前档位换顺序——人的肌肉记忆比 autoFocus 重要。 */
function renderDestinationControl(body, destination, onChange) {
  const row = document.createElement("div");
  row.className = "ps-mode";
  const label = document.createElement("span");
  label.className = "ps-mode-label";
  label.textContent = "打开到";
  row.append(label);
  for (const [value, text] of [["chat", "去对话"], ["map", "看地图"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ps-mode-btn";
    btn.textContent = text;
    btn.setAttribute("aria-pressed", String(destination === value));
    btn.addEventListener("click", () => {
      if (destination !== value) onChange(value);
    });
    row.append(btn);
  }
  body.append(row);
}

/** 当前地图路由里的会话 id（不在地图页 = 空串）。 */
function mapRouteIdFromHash() {
  const match = /^#\/map\/([A-Za-z0-9._-]+)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : "";
}

/** 选择器里「看地图」：关弹层 → 换地图路由；同一条会话就只关弹层。 */
function openMapConversation(conversationId) {
  if (!conversationId) return;
  closeModal();
  const hash = `#/map/${encodeURIComponent(conversationId)}`;
  if (location.hash === hash) return;
  location.hash = hash;
  void loadChats().catch(() => undefined);
}

/** 翻页条（2026-11-21）：位置固定在列表与「新建会话」之间；一页放得下就不出现。 */
function renderPager(body, page, totalPages, onPageChange) {
  const bar = document.createElement("div");
  bar.className = "ps-pager";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "ps-pager-btn";
  prev.innerHTML = PAGER_PREV_ICON;
  prev.setAttribute("aria-label", "上一页");
  prev.disabled = page <= 0;
  prev.addEventListener("click", () => onPageChange(page - 1));
  const info = document.createElement("span");
  info.className = "ps-pager-info";
  info.textContent = `${page + 1} / ${totalPages}`;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "ps-pager-btn";
  next.innerHTML = PAGER_NEXT_ICON;
  next.setAttribute("aria-label", "下一页");
  next.disabled = page >= totalPages - 1;
  next.addEventListener("click", () => onPageChange(page + 1));
  bar.append(prev, info, next);
  body.append(bar);
}

function renderSessionRows(
  body,
  data,
  partnerId,
  isChief,
  {
    onDelete = null,
    destination = "chat",
    onDestinationChange = null,
    pager = { page: 0 },
    onPageChange = null,
  } = {},
) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  renderDestinationControl(body, destination, onDestinationChange || (() => {}));

  const list = document.createElement("div");
  list.className = "ps-list";
  const currentId = destination === "map" ? mapRouteIdFromHash() : state.conversationId;
  const onOpen = (session) => {
    if (destination === "map") openMapConversation(session.conversationId);
    else openExistingConversation(session.conversationId);
  };

  // 主对话：执事取 canonical；没开过就走 /open。总管取第一条**没有来源**的会话
  // （2026-11-18：分支副本可能比主对话更近，按 lastAt 的第一条不一定是根）；
  // 一条都没有时，点主对话 = 新建 chief 会话。
  const main = isChief
    ? sessions.find((item) => !item?.origin) || sessions[0]
    : sessions.find((item) => item?.role === "canonical");

  const appendPendingMain = () => {
    const pending = document.createElement("button");
    pending.type = "button";
    pending.className = "ps-row ps-main";
    pending.textContent = "主对话（还没开始）";
    pending.addEventListener("click", () => {
      if (isChief) void createSession(partnerId);
      else void openPartnerMain(partnerId);
    });
    list.append(pending);
  };

  // 分支会话管理（缩进 + 删除）恒生效：开关 2026-11-21 退役，平铺旧列表分支已删。
  if (!main) appendPendingMain();
  // 二级缩进：副本按 origin.source 挂到母会话下面；母会话不在列表里就当顶层。
  // 翻页（2026-11-21）：10 行一页、子树不拆页；页码存弹层闭包里，删完刷新/切目标后原地钳住。
  const pages = paginateSessionTree(buildSessionTree(sessions));
  pager.page = Math.min(Math.max(0, pager.page), pages.length - 1);
  const appendTree = (nodes, container) => {
    for (const node of nodes) {
      const isMain = Boolean(main && node.session.conversationId === main.conversationId);
      const item = sessionRow(node.session, {
        main: isMain,
        deletable: Boolean(node.session.deletable),
        onDelete,
        onOpen,
        currentId,
      });
      container.append(item);
      if (node.children.length > 0) {
        const group = document.createElement("div");
        group.className = "ps-children";
        appendTree(node.children, group);
        item.append(group);
      }
    }
  };
  appendTree(pages[pager.page] || [], list);
  body.append(list);
  if (pages.length > 1 && typeof onPageChange === "function") {
    renderPager(body, pager.page, pages.length, (next) => onPageChange(next));
  }

  const create = document.createElement("button");
  create.type = "button";
  create.className = "ghost ps-create";
  create.textContent = "新建会话";
  create.addEventListener("click", () => void createSession(partnerId));
  body.append(create);
}

/** 删除确认视图：占用同一个弹层 body（openModal 不支持叠加，不能另开一个）。 */
function renderDeleteConfirm(body, session, { onCancel, onConfirm }) {
  body.replaceChildren();
  const title = partnerSessionLabel(session);
  const desc = document.createElement("p");
  desc.className = "modal-desc";
  desc.textContent = `永久删除「${title}」？这条会话的对话记录会一起删掉，不可恢复。`;
  const note = document.createElement("p");
  note.className = "modal-hint";
  note.textContent = "只删这条会话的对话记录；人设、记忆与项目不受影响。";
  const hint = document.createElement("p");
  hint.className = "modal-hint is-error";
  hint.hidden = true;

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => onCancel());
  const del = document.createElement("button");
  del.type = "button";
  del.className = "modal-danger";
  del.textContent = "删除";
  del.addEventListener("click", async () => {
    del.disabled = true;
    cancel.disabled = true;
    hint.hidden = true;
    try {
      await onConfirm();
    } catch (error) {
      hint.textContent =
        error.message === "forbidden"
          ? "鉴权失败"
          : error.message || "删除没成功，稍后再试";
      hint.hidden = false;
      del.disabled = false;
      cancel.disabled = false;
    }
  });
  actions.append(cancel, del);
  body.append(desc, note, hint, actions);
}

async function fetchSessions(partnerId) {
  const response = await request(`/api/v1/partners/${encodeURIComponent(partnerId)}/sessions`, {
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `读取会话失败：HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

async function deleteBranchSession(partnerId, session) {
  const response = await request(
    `/api/v1/partners/${encodeURIComponent(partnerId)}/sessions/${encodeURIComponent(session.conversationId)}/delete`,
    { method: "POST" },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `删除没成功：HTTP ${response.status}`);
  }
  return data;
}

/** 删掉当前正在看的会话后往哪走：执事回主对话；总管回到第一条剩余会话，没有就新开。 */
function openAfterDeleted(partnerId, isChief, data, deletedId) {
  if (!isChief) {
    void openPartnerMain(partnerId);
    return;
  }
  const remaining = (data?.sessions || []).filter((item) => item.conversationId !== deletedId);
  const main = remaining.find((item) => !item?.origin) || remaining[0];
  if (main) openExistingConversation(main.conversationId);
  else startNewChat("chief");
}

/** 入口：侧栏花名册右键 / 总管条目右键 / 地图顶栏「切换」共用。
 *  `target` 决定选择一条已有会话后落到哪：`chat` 或 `map`；不传时跟随当前页面——
 *  在地图页默认「看地图」，在对话页默认「去对话」。 */
function openPartnerSessions(partnerId, { target } = {}) {
  if (!partnerId) return;
  const gen = ++pickerGeneration;
  const isChief = partnerId === "chief";
  const name = displayNameOf(partnerId);
  const initialTarget =
    target === "map" || target === "chat"
      ? target
      : document.documentElement.dataset.route === "map"
        ? "map"
        : "chat";
  let destination = initialTarget;
  openModal(`${name}的会话`, (body) => {
    const loading = document.createElement("p");
    loading.className = "modal-desc";
    loading.textContent = "正在读取会话…";
    body.append(loading);
    // 弹层内所有 await 都先判 generation + 弹层是否还开着：过期响应一律丢弃。
    const stale = () => gen !== pickerGeneration || !modalOpen();
    let current = null;
    // 翻页页码（2026-11-21）：存弹层闭包，切「去对话/看地图」与删后刷新都不重置，越界由渲染钳住。
    const pager = { page: 0 };

    const render = () => {
      if (!current) return;
      body.replaceChildren();
      renderSessionRows(body, current, partnerId, isChief, {
        destination,
        onDestinationChange: (next) => {
          destination = next === "map" ? "map" : "chat";
          render();
          body.querySelector('.ps-mode-btn[aria-pressed="true"]')?.focus();
        },
        pager,
        onPageChange: (next) => {
          pager.page = next;
          render();
        },
        onDelete: (session) => {
          renderDeleteConfirm(body, session, {
            onCancel: render,
            onConfirm: async () => {
              await deleteBranchSession(partnerId, session);
              toast("已删除");
              await loadChats().catch(() => undefined);
              // 删的是当前地图：落到主对话的地图（没有就回对话），不然地图会 404。
              if (destination === "map" && session.conversationId === mapRouteIdFromHash()) {
                const remaining = (current.sessions || []).filter(
                  (item) => item.conversationId !== session.conversationId,
                );
                const fallback = remaining.find((item) => !item?.origin) || remaining[0];
                closeModal();
                if (fallback) {
                  location.hash = `#/map/${encodeURIComponent(fallback.conversationId)}`;
                } else if (isChief) {
                  startNewChat("chief");
                } else {
                  void openPartnerMain(partnerId);
                }
                return;
              }
              // 删的是当前正在看的会话：弹层收起，切回主对话（不然屏幕上还是已删内容）。
              if (destination === "chat" && session.conversationId === state.conversationId) {
                closeModal();
                openAfterDeleted(partnerId, isChief, current, session.conversationId);
                return;
              }
              // 已经删成功：列表刷新失败只提示，不把确认按钮放回去（再点就是 404）。
              try {
                const next = await fetchSessions(partnerId);
                if (stale()) return;
                current = next;
                render();
              } catch {
                if (stale()) return;
                closeModal();
                toast("已删除，但列表刷新失败，重开一次就能看到");
              }
            },
          });
        },
      });
    };

    void (async () => {
      try {
        const data = await fetchSessions(partnerId);
        if (stale()) return;
        current = data;
        body.replaceChildren();
        render();
        // 位置固定后第一个按钮不一定是当前档：把焦点放到真正生效的那个上。
        body.querySelector('.ps-mode-btn[aria-pressed="true"]')?.focus();
      } catch (error) {
        if (stale()) return;
        if (error.status === 400 && error.code === "side_sessions_disabled") {
          onSideSessionsDisabled();
          return;
        }
        closeModal();
        toast(
          error.message === "forbidden"
            ? "鉴权失败"
            : error.message || "读取会话失败，稍后再试",
        );
      }
    })();
  });
}

export { ensureSideSessionsFlag, openPartnerSessions };
