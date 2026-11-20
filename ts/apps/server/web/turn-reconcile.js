/**
 * 忙时插话 / 轮末回读 / 刷新后补挂审批（2026-11-20 从 topic-proposal.js 拆出）。
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 2026-11-20 课题退役：只留下与课题无关的会话机制，课题提议卡整块删除。
 *
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { approvalCards, renderApprovalCard } from "./approval-card.js";
import { addNotice, scrollToEnd } from "./chat-notice.js";
import { openChat } from "./chat-open.js";
import { addMessage, hideEmpty } from "./chat-thread.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { resize } from "./plus-menu.js";
import { state } from "./state.js";

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

export { loadPendingApprovals, scheduleTurnReconcile, steerIntoTurn, turnReconcile };
