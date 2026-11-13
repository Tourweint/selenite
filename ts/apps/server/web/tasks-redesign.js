/**
 * 任务中心重做 v1：等你回话 / 在跑 / 今日回顾三区与交互
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { openConversation } from "./chat-open.js";
import { el } from "./dom.js";
import { attr, esc } from "./markdown.js";
import { request } from "./net.js";
import { currentRoute, go, tasksHash } from "./route.js";
import { state } from "./state.js";
import { conversationTickets, employeeName, groupByConversation, hideTasksState, ticketConversationId, workRowsOf } from "./tasks-cards.js";
import { loadTickets, renderBoard } from "./tasks-kanban.js";
import { TASK_BADGE_STATUSES, TASK_HITTERS, TASK_STATUS, relativeTime } from "./tasks-model.js";
import { renderReview, reviewStatsOf, shiftDayKey, todayKey } from "./tasks-review.js";

/* ── 任务中心重做 v1（2026-11-13 批 1）──────────────────────
 * 版式 = 原型 09/10/12 拍板稿：等你回话大区 + 在跑小卡 + 打手手风琴 + 今日回顾卡。
 * 数据仍全从 GET /api/v1/tickets 派生（零新接口）；卡片点击一律 openConversation(id)，
 * v1 不带锚点（落在最新处，2026-11-13 拍板）。
 * 回滚：TASKS_REDESIGN_ENABLED=false → renderTasksView() 转去旧 renderBoard()。
 *
 * 身份诚实（硬规矩）：v1 拿不到总管唤醒轮的原话（原文与时间戳都没进单子），
 * 所以卡面引文只取有据字段——任务说明 prompt 摘要，或单上已有的状态原因；
 * 没有可引用文本就标「系统代发」，绝不写成总管的口气。 */

const TK2_NEEDS_SOFT_LIMIT = 3; // 超过 3 组收进「还有 N 条更早的」
const TK2_BRIEF_MAX = 60; // 与 workRow 同款截断长度
const TK2_QUOTE_MAX = 96; // 等你回话的引文比行内摘要多给一点上下文

/** 压空格 + 截断；空串原样返回，让调用方自己兜底文案 */
function briefText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 头像首字：按码点取，别把 emoji / 生僻字切成半个 */
function firstChar(value, fallback = "对") {
  const text = String(value || "").trim();
  return text ? [...text][0] : fallback;
}

/** 头像配色档：按 id 稳定散列到 v1~v3，刷新不会换色 */
function avatarTone(seed) {
  let sum = 0;
  for (const char of String(seed || "")) sum += char.codePointAt(0) || 0;
  return `v${(sum % 3) + 1}`;
}

/** 「等了 3 小时」：等你回话的组头用，口径与 relativeTime 一致（分钟起算） */
function waitedText(iso) {
  if (!iso) return "等了有一会儿";
  const stamp = new Date(iso).getTime();
  if (!Number.isFinite(stamp)) return "等了有一会儿";
  const minutes = Math.max(0, Math.floor((Date.now() - stamp) / 60000));
  if (minutes < 1) return "刚发来";
  if (minutes < 60) return `等了 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `等了 ${hours} 小时`;
  return `等了 ${Math.floor(hours / 24)} 天`;
}

/**
 * 运行时开关（2026-11-13）：GET /api/v1/agent/flags 只拉一次，按 key 记在 state 里。
 * 端点不可用 / 没这个键 → 用调用方给的 fallback；不同开关各自决定默认形态。
 */
async function ensureFlag(key, fallback) {
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
  const flag = state.flagsCache.get(key);
  return flag ? flag.value !== "false" : fallback;
}

/** 任务中心回滚开关：null = 还没问过；只问一次，之后记在 state 里 */
async function ensureTasksRedesignFlag() {
  if (state.tasksRedesignFlag !== null) return state.tasksRedesignFlag;
  // 端点不可用 / 没这个键 → 默认新视图（任务书口径：别把新界面误判成旧看板）
  state.tasksRedesignFlag = await ensureFlag("TASKS_REDESIGN_ENABLED", true);
  return state.tasksRedesignFlag;
}

/** 对话历史分页回滚开关（2026-11-13）：false = 一次拉 200 条、无上滑加载、无日期分隔 */
async function ensureChatPagingFlag() {
  if (state.chatPagingFlag !== null) return state.chatPagingFlag;
  state.chatPagingFlag = await ensureFlag("CHAT_HISTORY_PAGING_ENABLED", true);
  return state.chatPagingFlag;
}

/** 视图分派：开关说 false 就整套退回旧看板（旧函数与旧 DOM 都还在） */
function renderTasksView() {
  if (state.tasksRedesignFlag === false) {
    el.tasksRedesign.hidden = true;
    el.tasksLegacy.hidden = false;
    renderBoard();
    return;
  }
  el.tasksLegacy.hidden = true;
  el.tasksRedesign.hidden = false;
  el.tasksFilters.hidden = true; // 新视图不放领域/项目/排序下拉
  renderTasksRedesign();
}

/** 还在流程里的单数（口径同侧栏徽标）：在跑小卡的计数与空态文案都用它 */
function aliveTicketCount() {
  return state.tickets.filter((ticket) => TASK_BADGE_STATUSES.has(ticket.status)).length;
}

/**
 * 「等你回话」分组：一条对话一组，外加单级 needs_you 直派单。
 * 组按「等最久」升序（组内最早一条 needs_you 的 updated_at），组内按时间正序。
 */
function needsYouGroups(cards, direct) {
  const groups = [];
  for (const card of cards) {
    if (card.lamp !== "ask") continue;
    const tickets = conversationTickets(card)
      .filter((ticket) => ticket.status === "needs_you")
      .sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")));
    if (!tickets.length) continue; // 灯是 ask 却不是 needs_you（例如 idle）——没有可引用的等待理由
    groups.push({
      conversationId: card.conversationId,
      title: card.title || "未命名对话",
      tickets,
      oldest: tickets[0].updated_at || card.updated_at || "",
    });
  }
  for (const ticket of direct) {
    if (ticket.status !== "needs_you") continue;
    groups.push({
      conversationId: "",
      title: briefText(ticket.prompt, TK2_BRIEF_MAX) || "直接派出的单",
      tickets: [ticket],
      oldest: ticket.updated_at || "",
    });
  }
  groups.sort((a, b) => String(a.oldest || "").localeCompare(String(b.oldest || "")));
  return groups;
}

/**
 * 一条留言的有据文本：prompt 摘要优先（总管派活时写的说明），其次单上状态原因。
 * 两者都没有 → 不给引文，交给卡面标「系统代发」。
 */
function needsQuoteOf(ticket) {
  const prompt = briefText(ticket.prompt, TK2_QUOTE_MAX);
  if (prompt) return { text: prompt, source: "prompt" };
  const reason = [ticket.waitingOn, ticket.lastAction, ticket.error]
    .map((value) => briefText(value, TK2_QUOTE_MAX))
    .find(Boolean);
  if (reason) return { text: reason, source: "reason" };
  return { text: "这张单在等你，没留下可引用的说明。", source: "none" };
}

function needsZoneHtml(groups, running) {
  const total = groups.reduce((sum, group) => sum + group.tickets.length, 0);
  const head = `<div class="tk2-np-h">
      <h2>等你回话</h2><span class="tk2-cnt">${total}</span>
      <span class="tk2-hint">都是总管转给你的，点「去处理」回到那条对话</span>
    </div>`;
  if (!groups.length) {
    return `<section class="tk2-needs">${head}<p class="tk2-needs-empty">都回完了，${
      running ? `执事们在跑 ${running} 件事。` : "都在歇着。"
    }</p></section>`;
  }
  // 超过 3 组：前 3 组常驻，更早的收进折叠条（展开态只记会话内存）
  const first = groups.slice(0, TK2_NEEDS_SOFT_LIMIT);
  const rest = groups.slice(TK2_NEEDS_SOFT_LIMIT);
  const older = rest.length
    ? `<button class="tk2-more" type="button" data-needs-more aria-expanded="${
        state.tasksNeedsOlderOpen ? "true" : "false"
      }">
        <span class="tk2-more-caret" aria-hidden="true">▸</span>还有 ${rest.length} 条更早的
      </button>
      <div class="tk2-older"${state.tasksNeedsOlderOpen ? "" : " hidden"}>${rest
        .map(needsGroupHtml)
        .join("")}</div>`
    : "";
  return `<section class="tk2-needs">${head}${first.map(needsGroupHtml).join("")}${older}</section>`;
}

function needsGroupHtml(group) {
  const title = group.title || "未命名对话";
  // 直派单没有对话可回：按钮改走单详情（#/tasks?ticket=），别给一个点了没反应的入口
  const action = group.conversationId
    ? `<button class="tk2-btn" type="button" data-open-conv="${attr(group.conversationId)}">去处理 →</button>`
    : `<button class="tk2-btn" type="button" data-ticket-open="${attr(group.tickets[0].id)}">看这张单 →</button>`;
  return `<section class="tk2-ngroup">
    <div class="tk2-ng-h">
      <span class="tk2-ava ${avatarTone(group.conversationId || title)}">${esc(firstChar(title, "总"))}</span>
      <div class="tk2-ng-bd">
        <h3>${esc(title)}</h3>
        <p><b>${esc(waitedText(group.oldest))}</b> · ${group.tickets.length} 条</p>
      </div>
      ${action}
    </div>
    ${group.tickets.map(needsBubbleHtml).join("")}
  </section>`;
}

function needsBubbleHtml(ticket) {
  const quote = needsQuoteOf(ticket);
  const chief = quote.source === "prompt";
  const who = chief
    ? `<b>总管</b> · 派活说明`
    : `<span class="tk2-sys-tag">系统代发</span> · 这张单在等你`;
  const conversationId = ticketConversationId(ticket);
  const open = conversationId
    ? ` data-open-conv="${attr(conversationId)}" role="button" tabindex="0" title="点开回到这条对话"`
    : ` data-ticket-open="${attr(ticket.id)}" role="button" tabindex="0" title="这张单没有来源对话，点开看单"`;
  return `<div class="tk2-msg"${open}>
    <span class="tk2-msg-ava${chief ? "" : " sys"}">${chief ? "总" : "系"}</span>
    <div class="tk2-msg-bd">
      <p class="tk2-who">${who}</p>
      <p class="tk2-quote">${quote.source === "none" ? esc(quote.text) : `「${esc(quote.text)}」`}</p>
    </div>
    <span class="tk2-msg-tm">${esc(relativeTime(ticket.updated_at))}</span>
  </div>`;
}

/** 在跑小卡：一条对话一张，含排队/出错；灯口径仍是聚合灯 */
function runningCards(cards) {
  return cards
    .filter((card) => card.lamp === "run" || card.lamp === "fail")
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

/** 卡上「代表这盏灯」的那张单：出错优先找失败单，在跑优先找没终结的单 */
function headlineTicketOf(card) {
  const rows = workRowsOf(card);
  if (card.lamp === "fail") {
    return rows.find((ticket) => ticket.status === "failed" || ticket.status === "aborted") || rows[0] || null;
  }
  return rows.find((ticket) => ticket.status !== "done" && ticket.status !== "canceled") || rows[0] || null;
}

function runBlockHtml(cards, running) {
  const head = `<div class="tk2-sec-h"><span>在跑</span><span class="tk2-sec-cnt">${running}</span><span class="tk2-sec-ln"></span></div>`;
  if (!cards.length) return `${head}<p class="tk2-none">现在没有在跑的事。</p>`;
  const items = cards
    .map((card) => {
      const ticket = headlineTicketOf(card);
      const [label] = (ticket && TASK_STATUS[ticket.status]) || ["执行中", "run"];
      const lamp = card.lamp === "fail" ? "fail" : "run";
      return `<button class="tk2-mini" type="button" data-lamp="${lamp}" data-open-conv="${attr(card.conversationId)}" title="回到这条对话">
        <span class="tk2-ava sm ${avatarTone(card.conversationId)}">${esc(firstChar(card.title, "对"))}</span>
        <span class="tk2-mini-bd">
          <span class="tk2-mini-title">${esc(card.title || "未命名对话")}</span>
          <span class="tk2-mini-sub"><i aria-hidden="true"></i>${esc(label)} · ${esc(relativeTime(card.updated_at))}</span>
        </span>
      </button>`;
    })
    .join("");
  return `${head}<section class="tk2-minis">${items}</section>`;
}

/** 打手徽章：四项固定（TASK_HITTERS 不改成动态，那是另一个立项） */
const HITTER_BADGE = {
  codebuddy: ["CB", "cb"],
  "qoder-intl": ["QI", "qi"],
  "qoder-cn": ["QC", "qc"],
  phone: ["手", "mg"],
};

function hitterBadge(employee) {
  return (HITTER_BADGE[employee] || [firstChar(employeeName(employee), "手"), "cb"])[0];
}

function hitterTone(employee) {
  return (HITTER_BADGE[employee] || ["", "cb"])[1];
}

/** 某个执行者名下的对话行：按 conversationId 分组后过滤 employee，最近更新在前 */
function hitterConversations(cards, employee) {
  return cards
    .filter((card) => conversationTickets(card).some((ticket) => ticket.employee === employee))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

/** 展开行里那一单：等你的 / 出错的优先，其次还在跑的，最后退回任何一张 */
function cardTicketOf(card, employee) {
  const rows = conversationTickets(card).filter((ticket) => ticket.employee === employee);
  return (
    rows.find((ticket) => ticket.status === "needs_you" || ticket.status === "failed" || ticket.status === "aborted") ||
    rows.find((ticket) => ticket.status !== "done" && ticket.status !== "canceled") ||
    rows[0] ||
    null
  );
}

function hittersBlockHtml() {
  const { cards } = groupByConversation(state.tickets);
  // 「在跑数」口径与徽标一致：只数还在流程里的单（canceled/done/aborted 不算）
  const counts = new Map(
    TASK_HITTERS.map(({ id }) => [
      id,
      state.tickets.filter(
        (ticket) => ticket.employee === id && TASK_BADGE_STATUSES.has(ticket.status),
      ).length,
    ]),
  );
  // 第一次进页面替用户展开第一个在跑的打手；之后再按用户点过的展开态走
  if (!state.tasksHitterSettled) {
    state.tasksHitterSettled = true;
    const firstBusy = TASK_HITTERS.find(({ id }) => counts.get(id) > 0);
    if (firstBusy) state.tasksHitterOpen.add(firstBusy.id);
  }
  const head = `<div class="tk2-sec-h"><span>打手</span><span class="tk2-sec-ln"></span></div>`;
  const rows = TASK_HITTERS.map(({ id, label }) => {
    const count = counts.get(id) || 0;
    const open = state.tasksHitterOpen.has(id);
    const conversations = hitterConversations(cards, id);
    const body = conversations.length
      ? conversations
          .map((card) => {
            const ticket = cardTicketOf(card, id);
            const [statusLabel, tone] = (ticket && TASK_STATUS[ticket.status]) || ["执行中", "run"];
            return `<button class="tk2-hit-row" type="button" data-open-conv="${attr(card.conversationId)}" title="回到这条对话">
              <span class="tk2-hit-t">${esc(card.title || "未命名对话")}</span>
              <span class="tk2-dotst ${esc(tone)}"><i aria-hidden="true"></i>${esc(statusLabel)}</span>
              <span class="tk2-hit-tm">${esc(relativeTime(card.updated_at))}</span>
            </button>`;
          })
          .join("")
      : `<p class="tk2-hit-empty">${count ? "手上没有可点开的对话。" : "今天还没派过活。"}</p>`;
    return `<div class="tk2-hit${open ? " open" : ""}">
      <button class="tk2-hit-h" type="button" data-hitter="${attr(id)}" aria-expanded="${open ? "true" : "false"}">
        <span class="tk2-tool ${hitterTone(id)}">${esc(hitterBadge(id))}</span>
        <span class="tk2-hit-nm">${esc(label)}</span>
        <span class="tk2-hit-st${count ? " busy" : ""}"><i aria-hidden="true"></i>${count ? `在跑 ${count}` : "空闲"}</span>
        ${count ? `<span class="tk2-hit-ct">${count}</span>` : ""}
        <span class="tk2-caret" aria-hidden="true">▸</span>
      </button>
      <div class="tk2-hit-b"${open ? "" : " hidden"}>${body}</div>
    </div>`;
  }).join("");
  return `${head}<section class="tk2-hits">${rows}</section>`;
}

/** 今日回顾卡（右列）：三个有据数字 + 入口 */
function recapCardHtml() {
  const stats = reviewStatsOf(todayKey());
  return `<a class="tk2-recap" href="#/review">
    <h3><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>今日回顾</h3>
    <p>下班前看看今天都干了啥</p>
    <div class="tk2-recap-nums">
      <div><b>${stats.dispatched}</b><span>次派活</span></div>
      <div><b>${stats.done}</b><span>完结对话</span></div>
      <div><b>${stats.failed}</b><span>出错</span></div>
    </div>
  </a>`;
}

/** 新主视图渲染：自动刷新会反复进来，先记滚动位置，重排后放回去 */
function renderTasksRedesign() {
  const scrollTop = el.tasksScroll.scrollTop;
  hideTasksState();
  el.tasksDetail.hidden = true;
  el.tasksHitters.hidden = true;
  el.tasksStats.hidden = true;
  el.tasksBoard.hidden = true;
  el.tasksArchive.hidden = true;
  el.tasksDirect.hidden = true;
  el.tasksFilters.hidden = true;
  el.tasksBack.hidden = true;
  el.tasksTitleText.textContent = "任务中心";

  const { cards, direct } = groupByConversation(state.tickets);
  const groups = needsYouGroups(cards, direct);
  const running = aliveTicketCount();
  const messages = groups.reduce((sum, group) => sum + group.tickets.length, 0);
  el.tasksTitleSub.textContent = state.tickets.length
    ? `${messages} 条等你回话 · ${running} 件事在跑`
    : "";

  el.tk2Needs.innerHTML = needsZoneHtml(groups, running);
  el.tk2Run.innerHTML = runBlockHtml(runningCards(cards), running);
  el.tk2Hitters.innerHTML = hittersBlockHtml();
  el.tk2Recap.innerHTML = recapCardHtml();

  el.tasksScroll.scrollTop = scrollTop;
}

/* ── 任务中心重做 v1 的交互（2026-11-13 批 1）────────────────
 * 新视图的卡片全是现算的 HTML，统一在容器上做代理：
 * - [data-open-conv]  → 回原对话（v1 不带锚点，落在最新处）
 * - [data-ticket-open] → 直派单没有来源对话，走单详情
 * - [data-needs-more] → 就地展开/收起「更早的」等你回话组
 * - [data-hitter]     → 打手手风琴展开/收起
 * 这四类都只是一次重绘（滚动位置在 renderTasksRedesign 里保住）。 */
el.tasksRedesign?.addEventListener("click", (event) => {
  const conversation = event.target.closest("[data-open-conv]");
  if (conversation) {
    const conversationId = conversation.dataset.openConv || "";
    if (conversationId) void openConversation(conversationId);
    return;
  }
  const ticket = event.target.closest("[data-ticket-open]");
  if (ticket) {
    const ticketId = ticket.dataset.ticketOpen || "";
    if (ticketId) location.hash = tasksHash({ ticket: ticketId });
    return;
  }
  if (event.target.closest("[data-needs-more]")) {
    state.tasksNeedsOlderOpen = !state.tasksNeedsOlderOpen;
    renderTasksRedesign();
    return;
  }
  const hitter = event.target.closest("[data-hitter]");
  if (hitter) {
    const id = hitter.dataset.hitter || "";
    if (!id) return;
    if (state.tasksHitterOpen.has(id)) state.tasksHitterOpen.delete(id);
    else state.tasksHitterOpen.add(id);
    renderTasksRedesign();
  }
});
// div[role=button] 的键盘等价行为：Enter / 空格等同点一下（真按钮自带语义，跳过）
el.tasksRedesign?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target.closest("[data-open-conv], [data-ticket-open]");
  if (!target || event.target !== target || target.tagName === "BUTTON") return;
  event.preventDefault();
  target.click();
});

/* 今日回顾（2026-11-13 批 1）：日期切换 + 时间线条目回原对话。
   轨道钮同批退役（同上：任务中心的视图，入口在任务页底部的「今日回顾 →」）。 */
el.reviewBack.addEventListener("click", () => go("tasks"));
el.reviewRefresh.addEventListener("click", () => {
  void loadTickets({ silent: true, force: true, render: false }).then(() => {
    if (currentRoute() === "review") renderReview();
  });
});
el.reviewBody?.addEventListener("click", (event) => {
  const shift = event.target.closest("[data-day-shift]");
  if (shift) {
    const delta = Number(shift.dataset.dayShift || 0);
    if (!delta) return;
    state.reviewDay = shiftDayKey(state.reviewDay || todayKey(), delta);
    renderReview();
    return;
  }
  if (event.target.closest("[data-day-today]")) {
    state.reviewDay = todayKey();
    renderReview();
    return;
  }
  const conversation = event.target.closest("[data-open-conv]");
  if (conversation) {
    const conversationId = conversation.dataset.openConv || "";
    if (conversationId) void openConversation(conversationId);
  }
});
el.reviewBody?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target.closest("[data-open-conv]");
  if (!target || event.target !== target || target.tagName === "BUTTON") return;
  event.preventDefault();
  target.click();
});

export { HITTER_BADGE, TK2_BRIEF_MAX, TK2_NEEDS_SOFT_LIMIT, TK2_QUOTE_MAX, aliveTicketCount, avatarTone, briefText, cardTicketOf, ensureChatPagingFlag, ensureFlag, ensureTasksRedesignFlag, firstChar, headlineTicketOf, hitterBadge, hitterConversations, hitterTone, hittersBlockHtml, needsBubbleHtml, needsGroupHtml, needsQuoteOf, needsYouGroups, needsZoneHtml, recapCardHtml, renderTasksRedesign, renderTasksView, runBlockHtml, runningCards, waitedText };
