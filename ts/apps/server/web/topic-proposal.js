/**
 * 课题提议卡
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { approvalCards, renderApprovalCard } from "./approval-card.js";
import { addNotice, scrollToEnd } from "./chat-notice.js";
import { openChat } from "./chat-open.js";
import { addMessage, hideEmpty } from "./chat-thread.js";
import { el } from "./dom.js";
import { loadTopicsSidebar } from "./groups-topics.js";
import { request } from "./net.js";
import { resize } from "./plus-menu.js";
import { go } from "./route.js";
import { state } from "./state.js";

/* ── 课题提议卡（2026-11-07 批二）─────────────────────────
   总管调 propose_topic 后，工具结果里带 proposalId / question / flavor / cron。
   前端在该条工具消息处渲染一张卡（照审批卡的 attention 形态），按 callId 去重；
   状态不靠内存：每次渲前 GET /topics/proposals/:id 定态，刷新页面也能按 transcript 重渲。
   接口失败不弹全局错误，卡内行内提示。 */
const topicProposalCards = new Map();
const TOPIC_FLAVOR_TEXT = { watch: "盯梢型 · 盯变化", dig: "啃题型 · 每周推进" };
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** cron → 人话：只认「分 时 * * 周几」这种周节奏；其它原样展示（不猜）。 */
function humanCron(cron) {
  const raw = String(cron || "").trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return raw;
  if (dayOfMonth !== "*" || month !== "*") return raw;
  const mm = Number(minute);
  const hh = Number(hour);
  if (mm > 59 || hh > 23) return raw;
  const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  if (dayOfWeek === "*") return `每天 ${clock}`;
  const days = dayOfWeek.split(",").map((item) => item.trim());
  if (!days.length || days.some((item) => !/^[0-7]$/.test(item))) return raw;
  return `每${days.map((item) => WEEKDAY_NAMES[Number(item) % 7]).join("、")} ${clock}`;
}

function shortDateTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 工具输出 → 提议数据；只有 ok:true 且带 proposalId 的才建卡（失败交给正文说明）。 */
function parseTopicProposalOutput(output) {
  if (typeof output !== "string") return null;
  const text = output.trim();
  if (!text.startsWith("{")) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.ok !== true) return null;
  if (typeof data.proposalId !== "string" || !data.proposalId) return null;
  if (typeof data.question !== "string" || !data.question.trim()) return null;
  return {
    proposalId: data.proposalId,
    question: data.question.trim(),
    flavor: data.flavor === "dig" ? "dig" : "watch",
    cron: typeof data.cron === "string" && data.cron.trim() ? data.cron.trim() : "0 9 * * 1",
  };
}

function mountTopicProposalCard(host, data) {
  if (!host || !data) return;
  if (topicProposalCards.has(data.proposalId)) return;

  const card = document.createElement("section");
  card.className = "attention topic-proposal";
  card.dataset.proposalId = data.proposalId;

  const title = document.createElement("p");
  title.className = "attention-text";
  title.textContent = "提议长期跟进这个课题";

  const question = document.createElement("p");
  question.className = "topic-proposal-q";
  question.textContent = data.question;

  const meta = document.createElement("div");
  meta.className = "topic-proposal-meta";
  const flavor = document.createElement("span");
  flavor.className = "pill-tag topic-flavor";
  flavor.dataset.flavor = data.flavor;
  flavor.textContent = TOPIC_FLAVOR_TEXT[data.flavor];
  const rhythm = document.createElement("span");
  rhythm.textContent = `节奏：${humanCron(data.cron)}`;
  meta.append(flavor, rhythm);

  const expiry = document.createElement("div");
  expiry.className = "topic-proposal-expiry";

  const state = document.createElement("p");
  state.className = "topic-proposal-state";
  state.hidden = true;

  const actions = document.createElement("div");
  actions.className = "topic-proposal-actions";
  actions.hidden = true;
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "btn-primary";
  accept.textContent = "开课题";
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "ghost";
  decline.textContent = "不用了";
  actions.append(accept, decline);

  const note = document.createElement("p");
  note.className = "topic-proposal-note";

  card.append(title, question, meta, expiry, state, actions, note);
  host.append(card);
  topicProposalCards.set(data.proposalId, card);
  void hydrateTopicProposalCard(card);
}

function setTopicProposalNote(card, text, isError = false) {
  const note = card.querySelector(".topic-proposal-note");
  if (!note) return;
  note.textContent = text || "";
  note.classList.toggle("is-error", Boolean(isError) && Boolean(text));
}

/** 按服务端状态定卡：pending 出按钮；accepted / declined / expired 只留灰化文案。 */
async function hydrateTopicProposalCard(card) {
  const proposalId = card.dataset.proposalId;
  const actions = card.querySelector(".topic-proposal-actions");
  const stateEl = card.querySelector(".topic-proposal-state");
  const expiry = card.querySelector(".topic-proposal-expiry");
  const proposalPath = `/api/v1/topics/proposals/${encodeURIComponent(proposalId)}`;

  let proposal = null;
  try {
    const response = await request(proposalPath, { cache: "no-store" });
    if (response.status === 404) {
      if (actions) actions.hidden = true;
      setTopicProposalNote(card, "这条提议查不到了（可能已被清理）。");
      return;
    }
    if (!response.ok) {
      if (actions) actions.hidden = true;
      setTopicProposalNote(card, `没法确认这条提议的状态（${response.status}），稍后再试。`);
      return;
    }
    const payload = await response.json();
    proposal = payload.proposal || null;
  } catch {
    if (actions) actions.hidden = true;
    setTopicProposalNote(card, "读不到提议状态，检查服务是否在跑。");
    return;
  }
  if (!proposal || !proposal.status) {
    if (actions) actions.hidden = true;
    setTopicProposalNote(card, "服务端没回提议状态，稍后再试。");
    return;
  }

  if (expiry) {
    expiry.textContent = proposal.expiresAt
      ? `有效期到 ${shortDateTime(proposal.expiresAt)}（72 小时没处理就过期）`
      : "";
  }

  const paintDone = (text) => {
    card.classList.add("resolved");
    if (actions) actions.hidden = true;
    if (stateEl) {
      stateEl.hidden = false;
      stateEl.textContent = text;
    }
  };

  if (proposal.status === "accepted") {
    paintDone("已开课题，会按这个节奏研究。");
    return;
  }
  if (proposal.status === "declined") {
    paintDone("已谢绝。");
    return;
  }
  if (proposal.status === "expired") {
    paintDone("这条提议已经过期了（72 小时没处理）。");
    return;
  }

  // pending：两个按钮
  if (actions) actions.hidden = false;
  const accept = card.querySelector(".topic-proposal-actions .btn-primary");
  const decline = card.querySelector(".topic-proposal-actions .ghost");
  if (!accept || !decline) return;
  let busy = false;

  const fail = (message) => {
    setTopicProposalNote(card, message, true);
    accept.disabled = false;
    decline.disabled = false;
    busy = false;
  };

  accept.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    accept.disabled = true;
    decline.disabled = true;
    setTopicProposalNote(card, "");
    try {
      const response = await request(`${proposalPath}/accept`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        paintDone("已开课题，会按这个节奏研究。");
        void loadTopicsSidebar();
        return;
      }
      // 400 的业务拒绝（search_not_configured / topic_limit / exists / expired / not_found）
      setTopicProposalNote(card, payload.message || "开课题失败，稍后再试。", true);
      accept.disabled = false;
      decline.disabled = false;
      busy = false;
      if (payload.error === "search_not_configured") {
        const note = card.querySelector(".topic-proposal-note");
        const link = document.createElement("button");
        link.type = "button";
        link.className = "attention-link topic-proposal-link";
        link.textContent = "去设置里配搜索";
        link.addEventListener("click", () => go("settings", "service"));
        note?.append(document.createTextNode(" "), link);
      }
    } catch {
      fail("请求没发出去，检查服务是否在跑。");
    }
  });

  decline.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    accept.disabled = true;
    decline.disabled = true;
    setTopicProposalNote(card, "");
    try {
      const response = await request(`${proposalPath}/decline`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        paintDone("已谢绝。");
        return;
      }
      fail(payload.message || "谢绝失败，稍后再试。");
    } catch {
      fail("请求没发出去，检查服务是否在跑。");
    }
  });
}

/** 刷新/切会话时补挂还挂着的审批（只补没画过的） */
async function loadPendingApprovals(conversationId) {
  if (!conversationId || state.conversationId !== conversationId) return;
  try {
    const response = await request(
      `/api/v1/agent/approvals?conversationId=${encodeURIComponent(conversationId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const data = await response.json();
    // 请求期间用户切了会话：审批卡不能挂到别人的屏幕上
    if (state.conversationId !== conversationId) return;
    for (const item of data.approvals || []) {
      if (approvalCards.has(item.callId)) continue;
      // 来源行要会话 id：服务端已回（2026-11-08 批三），老服务端缺就用当前会话
      const card = renderApprovalCard({ ...item, conversationId: item.conversationId || conversationId });
      if (!card) continue;
      hideEmpty();
      el.thread.append(card);
    }
    if (state.stick) scrollToEnd();
  } catch {
    /* 离线 / 未配置：补挂失败不影响对话 */
  }
}

/**
 * 忙时插话（2026-11-07 消息即引导）。
 *
 * 为什么不复用 send()：send 是"开一轮"的路径（建气泡、setSending、主流渲染）。
 * 插话属于**已经在跑的那一轮**，再开一个气泡会让同一轮出现两个回答框。
 *
 * 渲染归属（这是本函数唯一容易做错的地方）：插话请求也有一条自己的 SSE 流，
 * 而内核把同一轮的增量同时推给两个订阅者。如果这里也画，屏幕上会出现两份正文。
 * 所以本函数**只消费 notice（受理回执），不画正文**——那一轮的回答由正在跑的
 * 主流继续追加。没赶上边界时（模型已经收尾）会由服务端的 notice 说明，
 * 用户看到的仍是"这句话被受理了"，不会假装它已经生效。
 *
 * 断流不取消工作：reader.cancel() 只停这条连接的推送，那一轮照原样跑完。
 */
async function steerIntoTurn(text) {
  if (!text) return;
  if (!state.conversationId) {
    // 还没有会话可插（新会话第一轮还没拿到 start 帧）：这句留在输入框，
    // 本地队列已退役（扫尾批 8a），不能让它变成一个没有落点的动作
    el.input.value = text;
    resize();
    addNotice("这一轮还没跑起来，这句先留在输入框。");
    return;
  }
  const bubble = addMessage("user", text, Date.now(), [], { fresh: true });
  try {
    const response = await request("/api/v1/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.conversationId,
        messages: [{ role: "user", content: text }],
        whenBusy: "steer",
      }),
    });
    if (!response.ok || !response.body) {
      // 服务端根本没受理：气泡撤回——屏幕上不能留一条服务端没收到的话
      bubble.root.remove();
      addNotice("插话没发出去，已经放回输入框。");
      el.input.value = text;
      resize();
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let receipt = null;
    // 读到**回执**为止（2026-11-07 修）：受理回执在 start 帧之后才 yield，
    // 两者几乎必然不在同一个 chunk——按"读到 start 就停"会把回执整个丢掉。
    // 上限只防服务端失联挂死，正常路径一两帧就出去了。
    for (let guard = 0; guard < 64 && receipt === null; guard += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0 && receipt === null) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (typeof event.seq === "number" && event.seq > state.maxSeq) {
            state.maxSeq = event.seq;
          }
          // 只认回执：正文归主流画，这里多看一个字都会变成重复输出
          if (event.type === "notice") receipt = event;
        }
      }
    }
    await reader.cancel().catch(() => undefined);
    if (receipt) {
      addNotice(receipt.text || "");
      // 竞态兜底（2026-11-07 修）：刚好收尾时这句补充成了**新的一轮**，正文从
      // 这条短连接上流——而它只收回执。不给机器可读落点就没法分辨这种情况
      // （契约 notice.steer=new-turn），只能收尾后全量回读一次补上。
      if (receipt.steer === "new-turn") scheduleTurnReconcile(state.conversationId);
    }
  } catch {
    addNotice("插话的结果没确认，稍后看这一轮正文有没有带上它。");
  }
}

/**
 * 轮末回读（2026-11-07 修，2026-11-08 扫尾批 8a 扩展到「排队插话」）。
 *
 * 用在两种"正文画在别处"的情形：
 *   1. 插话刚好收尾，这句补充成了**新的一轮**（notice.steer=new-turn）；
 *   2. 忙时排队的那句（whenBusy=followUp）变成下一轮跑完了——那条短连接按约定不画正文。
 * 两条都没有客户端在画那一轮的正文，等这一轮尘埃落定就全量回读一次。
 * "落定"的判据是 transcript 尾条从我们那句插话（user）变成了回答（assistant）——
 * 这轮在服务端跑，客户端没有它的流，`state.sending` 帮不上忙。
 * 回读走 openChat 的服务端事实源重建，不会跟在跑的主流重复。
 */
let turnReconcile = null;

function scheduleTurnReconcile(conversationId) {
  if (turnReconcile) {
    clearInterval(turnReconcile.timer);
  }
  const ticket = { conversationId, tries: 0, timer: 0 };
  turnReconcile = ticket;
  ticket.timer = setInterval(async () => {
    // 人切走了会话：这次插话不归这屏管，切回去本来就会全量回读
    if (state.conversationId !== ticket.conversationId) {
      clearInterval(ticket.timer);
      turnReconcile = null;
      return;
    }
    ticket.tries += 1;
    if (ticket.tries > 150) {
      // 5 分钟还没落定（服务端失联 / 这轮没产出回答）：放弃，用户刷新可见
      clearInterval(ticket.timer);
      turnReconcile = null;
      return;
    }
    let settled = false;
    try {
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(ticket.conversationId)}/messages?limit=1`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const data = await response.json();
        const messages = data.messages || [];
        const last = messages[messages.length - 1];
        settled = Boolean(last && last.role === "assistant");
      }
    } catch {
      /* 网络打嗝：下一轮再试 */
    }
    if (!settled) return;
    // 回答已经在盘上；若用户恰又开了新一轮（主流在画），等它收尾再重建
    if (state.sending) return;
    clearInterval(ticket.timer);
    turnReconcile = null;
    void openChat(ticket.conversationId);
  }, 2000);
}

export { TOPIC_FLAVOR_TEXT, WEEKDAY_NAMES, humanCron, hydrateTopicProposalCard, loadPendingApprovals, mountTopicProposalCard, parseTopicProposalOutput, scheduleTurnReconcile, setTopicProposalNote, shortDateTime, steerIntoTurn, topicProposalCards, turnReconcile };
