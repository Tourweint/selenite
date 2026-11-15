/**
 * 消息渲染 + 用户附件 / 编辑重发
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { approvalCards } from "./approval-card.js";
import { clearPendingAttachments, openLightbox } from "./attachments.js";
import { hideChatError, scrollToEnd } from "./chat-notice.js";
import { openChat, openConversation } from "./chat-open.js";
import { loadChats } from "./chats-list.js";
import { setSending } from "./composer-send.js";
import { el } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { request } from "./net.js";
import { updateHomeMode } from "./shell.js";
import { state } from "./state.js";
import { topicProposalCards } from "./topic-proposal.js";
import { toast } from "./ui-atoms.js";

/* ── 消息渲染 ─────────────────────────────────────────── */

function clearThread() {
  // 切会话/新建时把审批卡片的倒计时停掉，免得旧卡在后面空转
  for (const { timer } of approvalCards.values()) clearInterval(timer);
  approvalCards.clear();
  // 课题提议卡跟审批卡同命运：换会话后旧卡不再属于这一屏
  topicProposalCards.clear();
  // 错误卡同理（批 32）：报错是"那一条会话里那一轮"的事，不追着人跑
  hideChatError();
  // 待发附件属于"这一屏的这条会话"：切走就清，别把附件带到另一条对话里
  clearPendingAttachments();
  el.thread.replaceChildren();
  if (el.empty) el.thread.append(el.empty);
  // 历史分页状态跟着这一屏一起归零（2026-11-13）：旧的 top 节点已随 replaceChildren
  // 移除，但 state 里还指着它的话，下一次 renderHistoryTop 会去改一个脱离 DOM 的节点。
  state.history = { started: false, cursor: null, hasMore: false, loading: false, pages: 0, top: null };
  updateHomeMode();
}

function hideEmpty() {
  if (el.empty && el.empty.isConnected) el.empty.remove();
}

function addMessage(role, text, at, images = [], options = {}) {
  hideEmpty();
  // 2026-11-15 作者标记：非主人来源（`author.kind === "partner"`）不是"我说的话"，
  // 不占右侧气泡位、不挂 .user（编辑入口按 .msg.user 找，不挂类就天然不可编辑）。
  const author = options.author && options.author.kind ? options.author : null;
  const letter = role === "user" && Boolean(author);
  const wrap = document.createElement("div");
  wrap.className = letter ? "msg letter" : `msg ${role}`;
  // 只有"人刚发/刚回"的消息才播入场；历史回读、搜索跳转、补帧重建都不播。
  // 以前动画直接挂在 .msg.user/.assistant 上，刷新一条 200 条的会话会整屏同时入场。
  if (options.fresh) {
    wrap.classList.add("is-new");
    wrap.addEventListener("animationend", () => wrap.classList.remove("is-new"), { once: true });
  }
  // 时间戳只留给 `data-at`（搜索定位要用），不再挂 title 弹悬停框。
  if (at) wrap.dataset.at = String(at);

  // 助手那一侧多一层「工作过程」（2026-11-07）：思考卡 + 工具步骤 + 派活。
  // 用户消息没有这一层。刻意**不在建消息时就插占位块**——没有工具的轮次
  // 不该多出一条空壳（旧 .acts 靠 :empty 隐藏，这里直接不建）。
  // 用户消息的附件（图片 + 文件）在文字**上方**（2026-11-13 用户口径）：
  // 先挂附件再挂 body，flex 列顺序就是「附件 → 我们说的话」。
  if (role === "user" && !letter) mountMessageAttachments(wrap, images, options.files);
  const body = document.createElement("div");
  body.className = "body";
  if (role === "user") body.textContent = text;
  else body.innerHTML = renderMarkdown(text);
  if (letter) {
    mountLetter(wrap, body, author, at);
  } else if (role !== "user" || text) {
    // 纯附件消息没有文字：不挂空 body，附件卡直接贴住气泡（少一格 gap）
    wrap.append(body);
  }

  // 回答底下的一条脚注（2026-11-06 建这条线；2026-11-08 图标化）：复制图标 · 用时 · 完成时间。
  // 以前复制按钮浮在右上角、耗时单独 absolute 在右边，两者都对不齐正文；
  // 现在统一收进正文下方的 .msg-foot，hover 才出现。复制从文字改 Lucide 图标
  // （2026-11-08 用户口径：脚注要简洁，能图标就别文字），反馈用图标互换。
  let foot = null;
  if (role === "assistant") {
    foot = document.createElement("div");
    foot.className = "msg-foot";
    wrap.append(foot);

    const footSvg = (paths) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const ICON_COPY = footSvg(
      '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    );
    const ICON_COPIED = footSvg('<path d="M20 6 9 17l-5-5"/>');
    const ICON_FAILED = footSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-btn";
    copy.setAttribute("aria-label", "复制");
    copy.innerHTML = ICON_COPY;
    copy.addEventListener("click", async () => {
      let ok = true;
      try {
        // E1 灰块：一轮可能分成多段正文（话/块/话），复制要把所有正文段拼起来，
        // 不能只取第一段。灰块本身和脚注不属于回答原文。
        const parts = [...wrap.querySelectorAll(":scope > .flow > .body, :scope > .body")]
          .map((seg) => seg.innerText)
          .filter(Boolean);
        await navigator.clipboard.writeText(parts.join("\n\n"));
      } catch {
        ok = false;
      }
      copy.classList.toggle("is-done", ok);
      copy.classList.toggle("is-failed", !ok);
      copy.innerHTML = ok ? ICON_COPIED : ICON_FAILED;
      copy.setAttribute("aria-label", ok ? "已复制" : "复制失败");
      setTimeout(() => {
        copy.classList.remove("is-done", "is-failed");
        copy.innerHTML = ICON_COPY;
        copy.setAttribute("aria-label", "复制");
      }, 1200);
    });
    foot.append(copy);
  }

  // 前插历史（2026-11-13 上滑加载）走 `options.parent`：先渲进 DocumentFragment 再整体插进
  // thread 顶部，避免逐条 prepend 把顺序弄反；fragment 里也不触发自动滚底。
  (options.parent || el.thread).append(wrap);
  updateHomeMode();
  if (!options.parent && state.stick) scrollToEnd();
  return { root: wrap, body, foot };
}

/* ── 来信（2026-11-15 作者标记方案 §3.3）──────────────────
   同事递来的话不是"我说的话"：不占右侧气泡，收成左侧一张卡——抬头写清是谁发来的
   （名字 · 领域），正文默认只露首行，点开看全文。与 cindy 的 botLetter 同一套口径：
   右侧只代表主人本人或替主人发的输入。卡片不带 .msg.user，所以没有编辑重发入口。 */

function mountLetter(root, body, author, at) {
  const card = document.createElement("div");
  card.className = "letter-card";

  const meta = document.createElement("div");
  meta.className = "letter-meta";
  const from = document.createElement("span");
  from.className = "letter-from";
  const name = String(author.name || "执事");
  from.textContent = author.domain
    ? `执事「${name}」· ${author.domain} 发来`
    : `执事「${name}」发来`;
  meta.append(from);
  const clock = letterClock(at);
  if (clock) {
    const when = document.createElement("time");
    when.className = "letter-when";
    when.dateTime = new Date(at).toISOString();
    when.textContent = clock;
    meta.append(when);
  }
  card.append(meta);

  body.classList.add("letter-body");
  const text = body.textContent || "";
  const lineCount = text.split("\n").filter((line) => line.trim()).length;
  // 只有一行且不长：原样摊开，不为了"看起来像卡片"硬加一个展开按钮
  const collapsible = lineCount > 1 || text.length > 140;
  if (collapsible) body.classList.add("is-collapsed");
  card.append(body);

  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "letter-toggle";
    toggle.textContent = "展开全文";
    const setOpen = (open) => {
      body.classList.toggle("is-collapsed", !open);
      toggle.textContent = open ? "收起" : "展开全文";
    };
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(body.classList.contains("is-collapsed"));
    });
    card.addEventListener("click", () => setOpen(body.classList.contains("is-collapsed")));
    card.append(toggle);
  }
  root.append(card);
}

/** 来信抬头的时刻（`14:32`）；时间戳缺失就不显示，不编一个数出来。 */
function letterClock(at) {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/* ── 用户消息的附件 / 编辑重发（2026-11-08 扫尾批 4a；2026-11-13 文件走路径）──
   附件在文字上方（2026-11-13 用户口径）：图片是缩略图（base64 data URL，点击开 lightbox），
   文件是「图标 + 名字 + 体积」小卡（只有路径，不预览内容）。 */

/** 文件卡图标（Lucide file），输入框与消息里共用 */
const ATT_FILE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>';

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function mountMessageAttachments(root, images, files) {
  if (!root) return;
  if (Array.isArray(images) && images.length > 0) {
    const host = document.createElement("div");
    host.className = "msg-images";
    for (const image of images) {
      if (!image || !image.data) continue;
      const img = document.createElement("img");
      img.src = `data:${image.mimeType || "image/png"};base64,${image.data}`;
      img.alt = "图片";
      img.loading = "lazy";
      img.addEventListener("click", () => openLightbox(img.src));
      host.append(img);
    }
    if (host.children.length) root.append(host);
  }
  if (Array.isArray(files) && files.length > 0) {
    const host = document.createElement("div");
    host.className = "msg-files";
    for (const file of files) {
      if (!file || !file.name) continue;
      const card = document.createElement("div");
      card.className = "msg-file";
      if (file.path) card.title = file.path;
      const icon = document.createElement("span");
      icon.innerHTML = ATT_FILE_ICON;
      const main = document.createElement("span");
      main.className = "msg-file-main";
      const name = document.createElement("span");
      name.className = "msg-file-name";
      name.textContent = file.name;
      const meta = document.createElement("span");
      meta.className = "msg-file-meta";
      meta.textContent =
        [file.mimeType, formatBytes(file.bytes)].filter(Boolean).join(" · ") || "文件";
      main.append(name, meta);
      card.append(icon, main);
      host.append(card);
    }
    if (host.children.length) root.append(host);
  }
}

function userActionsOf(root) {
  let actions = root.querySelector(":scope > .msg-user-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "msg-user-actions";
    root.prepend(actions);
  }
  return actions;
}

/**
 * 把「编辑」入口挂到**最后一条**用户消息上（其它历史消息不提供，方案登记的刻意没有）。
 * 会话切换 / 每轮发送后各刷一次；能力开关关着时一个都不渲染。
 */
function syncEditEntry() {
  for (const button of el.thread.querySelectorAll(".msg-edit")) button.remove();
  if (!state.capabilities.editResend) return;
  const users = el.thread.querySelectorAll(".msg.user");
  const last = users[users.length - 1];
  if (!last) return;
  const actions = userActionsOf(last);
  if (actions.querySelector(".msg-edit")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "msg-edit";
  button.textContent = "编辑";
  button.title = "改这句话并重发（会产生一条新会话）";
  button.addEventListener("click", () => void startEditing(last));
  actions.append(button);
}

/**
 * 现场刚发出去的消息没有 messageId（SSE 不带它，契约没动）。点编辑时再拉一次历史，
 * 按"从末尾对齐"把 id 写回所有用户气泡——limit 截断的是最早的部分，末尾一定对得上。
 */
async function resolveMessageId(root) {
  const conversationId = state.conversationId;
  if (!conversationId) return "";
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=200`,
      { cache: "no-store" },
    );
    if (!response.ok) return "";
    const data = await response.json();
    const userMessages = (data.messages || []).filter((message) => message.role === "user");
    const roots = [...el.thread.querySelectorAll(".msg.user")];
    const count = Math.min(roots.length, userMessages.length);
    for (let offset = 1; offset <= count; offset += 1) {
      const node = roots[roots.length - offset];
      const message = userMessages[userMessages.length - offset];
      if (node && message?.id) node.dataset.messageId = message.id;
    }
    return root.dataset.messageId || "";
  } catch {
    return "";
  }
}

async function startEditing(root) {
  if (state.sending) {
    toast("等这一轮结束再改");
    return;
  }
  const conversationId = state.conversationId;
  if (!conversationId) return;
  const text = (root.querySelector(":scope > .body")?.textContent || "").trim();
  const messageId = root.dataset.messageId || (await resolveMessageId(root));
  if (!messageId) {
    toast("这条消息暂时定位不到，刷新页面后再试");
    return;
  }
  openInlineEditor(root, text, messageId);
}

function openInlineEditor(root, text, messageId) {
  if (root.querySelector(":scope > .msg-editor")) return;
  const body = root.querySelector(":scope > .body");
  const images = root.querySelector(":scope > .msg-images");
  const files = root.querySelector(":scope > .msg-files");
  const actions = root.querySelector(":scope > .msg-user-actions");
  if (body) body.hidden = true;
  if (images) images.hidden = true;
  if (files) files.hidden = true;
  if (actions) actions.hidden = true;

  const editor = document.createElement("div");
  editor.className = "msg-editor";
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("aria-label", "编辑这条消息");
  const bar = document.createElement("div");
  bar.className = "msg-editor-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = "改并重发";
  bar.append(cancel, save);
  editor.append(area, bar);
  root.append(editor);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  if (state.stick) scrollToEnd();

  const close = () => {
    editor.remove();
    if (body) body.hidden = false;
    if (images) images.hidden = false;
    if (files) files.hidden = false;
    if (actions) actions.hidden = false;
  };
  cancel.addEventListener("click", close);
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    // Ctrl/⌘+Enter 提交（与 composer 的"带修饰键发送"同习惯）；裸 Enter 留给换行
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save.click();
    }
  });
  save.addEventListener("click", () => {
    const next = area.value.trim();
    if (!next) return;
    if (next === text) {
      close();
      return;
    }
    save.disabled = true;
    cancel.disabled = true;
    save.textContent = "重发中…";
    void submitEdit(messageId, next, { save, cancel });
  });
}

/**
 * 提交编辑重发。成功 = 202 + 新 conversationId：立刻切过去（老会话原样留在列表里），
 * 再等这一轮落库把回答补上。
 */
async function submitEdit(messageId, text, ui) {
  const conversationId = state.conversationId;
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/edit`,
      { method: "POST", body: JSON.stringify({ messageId, text }) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.conversationId) {
      const why =
        data.message ||
        (response.status === 404
          ? "编辑重发未开启（AGENT_EDIT_RESEND=false）"
          : response.status === 409
            ? "这一轮还在跑，等它结束再改"
            : `改不了：HTTP ${response.status}`);
      toast(why);
      ui.save.disabled = false;
      ui.cancel.disabled = false;
      ui.save.textContent = "改并重发";
      return;
    }
    await openConversation(data.conversationId);
    // 新会话要立刻出现在侧栏里（与发送路径的 start 帧同一做法）
    void loadChats();
    await waitEditedTurn(data.conversationId);
  } catch (error) {
    ui.save.disabled = false;
    ui.cancel.disabled = false;
    ui.save.textContent = "改并重发";
    toast(`改不了：${error.message}`);
  }
}

/**
 * 编辑重发后的回答是后台跑的（端点立刻 202），所以这里轮询回读：
 * 一出现新的 assistant 消息就整屏重读一次（工作过程/用量脚注都跟着补上）。
 * 轮询窗口 90s；期间按钮是「停止」，点了会走正常的 `POST .../stop`。
 */
async function waitEditedTurn(conversationId) {
  if (state.conversationId !== conversationId) return;
  setSending(true);
  const deadline = Date.now() + 90_000;
  try {
    while (Date.now() < deadline && state.conversationId === conversationId) {
      // 判据：最后一条 user 之后出现了 assistant。不按"条数变多"判——
      // 分叉历史本身就带旧回答，数数会把"还没开始"当成"已经答完"。
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=200`,
        { cache: "no-store" },
      ).catch(() => null);
      if (response && response.ok) {
        const data = await response.json().catch(() => ({}));
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
        const answered =
          lastUserIndex >= 0 &&
          messages.slice(lastUserIndex + 1).some((message) => message.role === "assistant");
        if (answered) {
          await openChat(conversationId);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (state.conversationId !== conversationId || state.stopRequested) return;
    }
  } finally {
    setSending(false);
  }
}

export { ATT_FILE_ICON, addMessage, clearThread, formatBytes, hideEmpty, mountMessageAttachments, openInlineEditor, resolveMessageId, startEditing, submitEdit, syncEditEntry, userActionsOf, waitEditedTurn };
