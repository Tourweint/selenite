/**
 * 打开会话 + 历史分页
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { addError, attachUsage, collectFileChangesFromSteps, mountFileSummary, scrollToEnd, syncCtxMeter } from "./chat-notice.js";
import { addMessage, clearThread, markDoneAt, syncEditEntry } from "./chat-thread.js";
import { renderChats } from "./chats-list.js";
import { KEY_CONV, el } from "./dom.js";
import { dayKeyOfAt, dayLabelOf } from "./groups-thread.js";
import { request } from "./net.js";
import { chiefDisplayName, partnerDisplayName, syncChatHeadAvatar } from "./partners-status.js";
import { go, syncRailCurrent, syncSideRowsCurrent } from "./route.js";
import { state } from "./state.js";
import { ensureChatPagingFlag } from "./tasks-redesign.js";
import { workPanelFromSteps } from "./tool-flow.js";
import { loadPendingApprovals, mountTopicProposalCard, parseTopicProposalOutput } from "./topic-proposal.js";
import { toast } from "./ui-atoms.js";

/* ── 打开会话 ─────────────────────────────────────────── */

/**
 * 定位到命中的那一句（2026-11-12）：addMessage 已把时间戳写进 .msg[data-at]，
 * 这里按 at（有角色就再对一下角色）找节点，滚到视口中间并闪一下。
 * 命中不到返回 false，交给调用方决定是否整段重放；绝不"猜一个差不多的地方"。
 */
function jumpToAnchor(anchor) {
  const at = Number(anchor?.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  const nodes = [...el.thread.querySelectorAll(`.msg[data-at="${at}"]`)];
  if (!nodes.length) return false;
  const role = anchor?.role === "user" || anchor?.role === "assistant" ? anchor.role : "";
  const node = (role && nodes.find((item) => item.classList.contains(role))) || nodes[0];
  node.scrollIntoView({ block: "center" });
  node.classList.remove("is-jump-hit");
  void node.offsetWidth; // 强制 reflow：同一条连点两次也能重放动画
  node.classList.add("is-jump-hit");
  window.setTimeout(() => node.classList.remove("is-jump-hit"), 2800);
  return true;
}

/**
 * 「从任何地方打开一条对话」的唯一入口（2026-11-07 修）：
 * 先切到对话路由，再回读历史。
 *
 * 为什么不能只 openChat：它只换 state.conversationId 与线程内容，**不动路由**。
 * 于是从群聊（#/group/<id>）/ 任务中心 / 设置页点会话行时，数据在背后换了、
 * 屏幕还停在原页——用户看到的就是「点了没反应、界面切换不了」。
 * go("chat") 改 hash → hashchange → applyRoute 把视图换回来；两件事的顺序不能反，
 * 否则 applyRoute 可能带着旧会话重绘一次。
 *
 * 2026-11-12：`options.anchor = { at, role? }` = 搜索命中处，回读后定位到那一句；
 * 不带就是普通打开（定位实现见 jumpToAnchor）。
 */
async function openConversation(conversationId, options) {
  if (!conversationId) return;
  go("chat");
  return openChat(conversationId, options);
}

/* ── 历史分页：按天分组 + 上滑加载（2026-11-13）─────────────
 *
 * 打开只回读一页；滚到顶再往前插上一页。日期分隔只做展示，页边界由服务端按"轮"
 * 和自然日切好——前端不重新分组数据，只按消息的 `at` 决定哪天该画一条日期条。
 *
 * 三条不能破的约束：
 * 1. 前插不重建屏幕：不能复用 openChat/clearThread，否则流式补帧（maxSeq）、审批卡、
 *    编辑入口全被打断。
 * 2. 前插后视口停在原处：记录 scrollHeight 差再补 scrollTop，否则人会"被跳走"。
 * 3. 接缝不重复日期条：新页最后一条和原第一条同一天时，把原来那条日期条拿掉。
 */

const CHAT_HISTORY_PAGE_SIZE = 50;

/** 单条 transcript 消息的完整渲染（历史回读与分页前插共用；与现场渲染同一套装饰）。 */
function renderTranscriptMessage(message, options = {}) {
  const shown = addMessage(
    message.role === "user" ? "user" : "assistant",
    message.text,
    message.at,
    message.images,
    { files: message.files, parent: options.parent },
  );
  // 可寻址 id（2026-11-08 4a）：编辑重发靠它定位这条 user 消息
  if (message.role === "user" && message.id) shown.root.dataset.messageId = message.id;
  if (message.role !== "user") {
    // 工作过程（2026-11-07）：服务端从 durable 里把这一轮的 toolCall / tool-result
    // 配成 steps 下发；这里还原成与现场同一块（已收尾、默认折叠）。
    workPanelFromSteps(shown.root, message.steps, message.workMs);
    // 文件变更汇总（批 33）：从同一份 steps 收集，与现场同一张卡
    mountFileSummary(shown.root, collectFileChangesFromSteps(message.steps));
    // 课题提议卡（2026-11-07 批二）：历史回读也按工具结果重渲，状态由 GET 定
    for (const step of Array.isArray(message.steps) ? message.steps : []) {
      if (step && step.name === "propose_topic" && step.output) {
        mountTopicProposalCard(shown.root, parseTopicProposalOutput(step.output));
      }
    }
    // 历史里的用时（2026-11-06）：服务端已下发 workMs（提问到收尾的墙钟），
    // 以前只有现场那一轮有耗时，切回来就没了。这里补成同一份脚注。
    // 完成时间 = 这条消息落盘的时刻（时间戳就是收尾时写的）。
    if (message.at) markDoneAt(shown.root, message.at);
    if (typeof message.workMs === "number" && message.workMs > 0) {
      attachUsage(shown.root, { input: 0, output: 0, cacheRead: 0 }, message.workMs);
    }
    // E2 #7：助手正文里以「【需要你】」开头的行加 .attention（只改渲染判断，不改内容）。
    for (const block of shown.body.children) {
      if (block.textContent.split("\n").some((line) => line.trimStart().startsWith("【需要你】"))) {
        block.classList.add("attention");
      }
    }
  }
  return shown;
}

/** 把一页消息按天分组渲进 container（升序）；返回这页最后一条的日历日（接缝判断用）。 */
function renderHistoryMessages(messages, container) {
  let lastDay = "";
  for (const message of messages) {
    const day = dayKeyOfAt(message.at);
    if (day && day !== lastDay) {
      const divider = document.createElement("div");
      divider.className = "msg-day";
      divider.textContent = dayLabelOf(day);
      divider.title = day;
      container.append(divider);
      lastDay = day;
    }
    renderTranscriptMessage(message, { parent: container });
  }
  return lastDay;
}

function clearHistoryTop() {
  if (state.history.top) state.history.top.remove();
  state.history.top = null;
}

/** 顶部那一条：加载中 / 还有更早（可点） / 已经到最早。没有可显示的就整条隐藏。 */
function renderHistoryTop() {
  const history = state.history;
  if (!history.started) {
    clearHistoryTop();
    return;
  }
  if (!history.top) {
    const top = document.createElement("div");
    top.className = "history-top";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "history-more";
    more.textContent = "↑ 加载更早的对话";
    more.addEventListener("click", () => void loadOlderMessages());
    const loading = document.createElement("span");
    loading.className = "history-loading";
    loading.textContent = "正在加载更早的对话…";
    const start = document.createElement("span");
    start.className = "history-start";
    start.textContent = "没有更早的记录了";
    top.append(more, loading, start);
    history.top = top;
    el.thread.prepend(top);
  }
  const showMore = history.hasMore && !history.loading;
  const showLoading = history.loading;
  // 只有"翻过至少一页"才说"到最早"：短会话首屏不动就挂一句会很吵。
  const showStart = !history.hasMore && !history.loading && history.pages > 1;
  history.top.querySelector(".history-more").hidden = !showMore;
  history.top.querySelector(".history-loading").hidden = !showLoading;
  history.top.querySelector(".history-start").hidden = !showStart;
  history.top.hidden = !showMore && !showLoading && !showStart;
}

/** 上一页前插到 thread 顶部（日期条按天补；视口停在原来看的那条消息上）。 */
function prependHistoryMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const oldFirst = el.thread.querySelector(":scope > .msg");
  const oldFirstDay = oldFirst ? dayKeyOfAt(Number(oldFirst.dataset.at || 0)) : "";
  const prevHeight = el.scroll.scrollHeight;
  const prevTop = el.scroll.scrollTop;

  const fragment = document.createDocumentFragment();
  const lastDay = renderHistoryMessages(messages, fragment);

  // 接缝：新页最后一条和原来第一条同一天 → 原来那条前面的日期条属于"这一天开头"，
  // 现在这一天开头已经挪到新页里了，旧的那条要拿掉。
  if (oldFirst && oldFirstDay && lastDay === oldFirstDay) {
    const divider = oldFirst.previousElementSibling;
    if (divider && divider.classList.contains("msg-day")) divider.remove();
  }

  const top = state.history.top;
  const anchorNode = top && top.parentNode === el.thread ? top.nextSibling : el.thread.firstChild;
  el.thread.insertBefore(fragment, anchorNode);
  el.scroll.scrollTop = prevTop + (el.scroll.scrollHeight - prevHeight);
}

/** 往上翻一页。切会话 / 路由变了就丢弃这次结果，绝不把旧页插进新会话。 */
async function loadOlderMessages() {
  const history = state.history;
  const conversationId = state.conversationId;
  if (!history.started || !history.hasMore || history.loading || !history.cursor || !conversationId) {
    return;
  }
  const token = state.navToken;
  history.loading = true;
  renderHistoryTop();
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?page=1&limit=${CHAT_HISTORY_PAGE_SIZE}&before=${encodeURIComponent(history.cursor)}`,
      { cache: "no-store" },
    );
    if (state.conversationId !== conversationId || state.navToken !== token) return;
    if (response.status === 400) {
      // 游标解不开 = 服务端重启换了密钥 / 令牌变了。不猜、不回退到开屏重载，停下说清楚。
      history.hasMore = false;
      history.cursor = null;
      renderHistoryTop();
      toast("更早的记录暂时打不开（服务端可能重启过），刷新页面再试");
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (state.conversationId !== conversationId || state.navToken !== token) return;
    prependHistoryMessages(data.messages);
    history.cursor = data.nextBefore || null;
    // 没有游标就不算"还有更早"，避免下一次请求拿 null 拼 URL
    history.hasMore = Boolean(data.hasMore) && Boolean(history.cursor);
    history.pages += 1;
    renderHistoryTop();
  } catch (error) {
    if (state.conversationId === conversationId) {
      const message = error.message === "forbidden" ? "鉴权失败" : error.message;
      toast(`加载更早的对话失败：${message}`);
    }
  } finally {
    history.loading = false;
    if (state.conversationId === conversationId) renderHistoryTop();
  }
}

async function openChat(conversationId, { anchor = null, deep = false } = {}) {
  const token = ++state.navToken; // 作废还在飞的 open / 上一次 openChat
  const owner = () => token === state.navToken && state.conversationId === conversationId;
  state.conversationId = conversationId;
  localStorage.setItem(KEY_CONV, conversationId);
  // 选中态先按 id 前缀落位（执事专线立刻亮「执事」；总管要等 chatKind 回读）
  syncRailCurrent();
  syncSideRowsCurrent();
  // 切会话先把上一会话的环藏掉（2026-11-13）：/context 回来之前旧数字停在
  // 新会话的角落里，看起来像"上下文没按这个会话加载"。同一会话重开不闪。
  if (el.ctxRing.dataset.conv !== conversationId) el.ctxRing.hidden = true;
  // seq 游标跟着会话走：切会话就是重新全量回读，游标归零（2026-11-04 seq 方案）。
  state.maxSeq = 0;
  renderChats();
  clearThread();
  el.title.textContent = "…";
  // 顶栏头像跟着会话走（2026-11-13）：换会话先按新 id 摆（执事专线立刻有脸，
  // 总管 / 普通对话立刻收起），别让上一位的头像挂在新会话的标题旁。
  syncChatHeadAvatar();

  try {
    // 分页开关（2026-11-13 按天分组·上滑加载）：开 = 只回读一页，往上滑再前插；
    // 关 = 退回旧的一次 200 条（deep 搜索兜底始终走全量，只有这条路径付全量代价）。
    const paging = await ensureChatPagingFlag();
    const pageMode = paging && !deep;
    const response = await request(
      pageMode
        ? `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?page=1&limit=${CHAT_HISTORY_PAGE_SIZE}`
        : `/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=${deep ? 0 : 200}`,
      { cache: "no-store" },
    );
    if (response.status === 404) {
      // 迟到的 404 不能把用户已经切过去的新会话清掉（send 的 start 帧也会改 conversationId）
      if (!owner()) return { token, conversationId, status: "stale" };
      // 会话没了：延续原身份重开（总管入口不能掉成普通 worker）
      startNewChat(state.chatKind === "chief" ? "chief" : "worker");
      return { token: state.navToken, conversationId: "", status: "missing", applied: true };
    }
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    // 这中间用户又切了别的会话：旧历史不许覆盖新会话的屏幕
    if (!owner()) return { token, conversationId, status: "stale" };
    // 续话身份只认服务端回读（缺字段的旧后端按 chief）；不靠 id 猜。
    const kind = data.chatKind || "chief";
    state.chatKind = kind;
    // 种类回读后再校一次轨道选中：总管会话要把「对话」熄掉（2026-11-13 选中态批）
    syncRailCurrent();
    clearThread();
    const messages = data.messages || [];
    if (pageMode) {
      // 只回读了一页：按天分组画出来，顶部挂"加载更早"；往上滑由 scroll 监听续页。
      renderHistoryMessages(messages, el.thread);
      state.history.cursor = data.nextBefore || null;
      state.history.hasMore = Boolean(data.hasMore) && Boolean(state.history.cursor);
      state.history.pages = 1;
      state.history.started = true;
      renderHistoryTop();
    } else {
      // 回滚形态（开关关）或 deep 搜索兜底：一次全量/200 条，行为与改动前一致（无日期条）。
      for (const message of messages) renderTranscriptMessage(message);
    }
    const partnerId = conversationId.startsWith("partner-")
      ? conversationId.slice("partner-".length)
      : "";
    if (partnerId) {
      // 执事专线表头用名字；身份仍以服务端 chatKind 为准，这里只是展示
      el.title.textContent = partnerDisplayName(partnerId);
    } else if (kind === "chief") {
      // 总管（2026-11-13 用户口径）：顶栏回答的是「我在跟谁说话」，答的是总管，
      // 不是「这条会话叫什么」——会话存过什么标题（例如「我的主对话」）不拿到这里来。
      el.title.textContent = chiefDisplayName();
    } else if (!messages.length) {
      el.title.textContent = "普通对话";
    } else {
      // 改过名的会话用存储标题（GET /chats 已带 title）；没改过名才从首句派生。
      // 不然 openChat 每次都把改名冲掉（顶栏永远是首句前 40 字）。
      const known = state.chats.find((chat) => chat.conversationId === conversationId)?.title;
      const first = messages.find((message) => message.role === "user");
      el.title.textContent = known || (first ? first.text.slice(0, 40) : "对话");
    }
    el.title.dataset.chatKind = kind;
    state.stick = true;
    scrollToEnd();
    // 编辑入口只挂在最后一条 user 消息上（2026-11-08 4a）
    syncEditEntry();
    if (!owner()) return { token, conversationId, status: "stale" };
    // 搜索命中跳回：定位到那一句；当前页里没有 = 它是更早的消息，
    // 用 limit=0 整段重来一次（只有这条路径付全量代价，且不启用分页）。
    if (anchor) {
      const located = jumpToAnchor(anchor);
      if (!located && !deep) return openChat(conversationId, { anchor, deep: true });
      if (!located) toast("那句话已经不在记录里了（可能被编辑或清理过）");
    }
    if (!owner()) return { token, conversationId, status: "stale" };
    // 刷新页面 / 切回会话时，可能还有一条挂着等答复的审批
    await loadPendingApprovals(conversationId);
    if (!owner()) return { token, conversationId, status: "stale" };
    return { token, conversationId, status: "ok", applied: true, chatKind: kind };
  } catch (error) {
    // 旧请求的失败不许挂到别人屏幕上
    if (!owner()) return { token, conversationId, status: "stale" };
    if (error.message !== "forbidden" && error.message !== "not-found") {
      // 500 不再只显示一个数字（2026-11-07）：那条路以前是"读历史失败：500"，
      // 用户既不知道是历史没了还是服务端坏了，也不知道要不要重开。
      // 现在服务端 500 会回 { error: "internal_error", message }，这里把话说清。
      const serverBroken = error.message === "Internal Server Error" || error.message === "500";
      addError(
        serverBroken
          ? "读历史失败：服务端内部错误（历史还在，不用重建）。稍后重试；反复出现请看服务端日志。"
          : `读历史失败：${error.message}`,
      );
    }
    return { token, conversationId, status: "error", applied: true };
  } finally {
    if (owner()) void syncCtxMeter(owner);
  }
}

function startNewChat(kind = "worker") {
  state.navToken += 1;
  state.chatKind = kind === "chief" ? "chief" : "worker";
  state.conversationId = "";
  localStorage.removeItem(KEY_CONV);
  state.maxSeq = 0; // 新会话没有历史帧（2026-11-04 seq 方案）
  syncRailCurrent();
  syncSideRowsCurrent();
  renderChats();
  clearThread();
  el.title.textContent = state.chatKind === "chief" ? chiefDisplayName() : "普通对话";
  el.title.dataset.chatKind = state.chatKind;
  syncChatHeadAvatar(); // 新会话没有对手：头像整块收起
  el.ctxRing.hidden = true;
  delete el.ctxRing.dataset.conv;
  el.input.focus();
}

export { CHAT_HISTORY_PAGE_SIZE, clearHistoryTop, jumpToAnchor, loadOlderMessages, openChat, openConversation, prependHistoryMessages, renderHistoryMessages, renderHistoryTop, renderTranscriptMessage, startNewChat };
