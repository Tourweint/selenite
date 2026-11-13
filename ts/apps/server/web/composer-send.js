/**
 * 发送与忙时排队
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { renderApprovalCard } from "./approval-card.js";
import { addError, addNotice, attachUsage, fileChangeCollector, hideChatError, maybeNotify, mountFileSummary, scrollToEnd, syncCtxMeter } from "./chat-notice.js";
import { addMessage, markDoneAt, syncEditEntry } from "./chat-thread.js";
import { closeChatArchiveConfirm, loadChats, renderChats } from "./chats-list.js";
import { KEY_CONV, el } from "./dom.js";
import { renderMarkdown, syncDelegateHint } from "./markdown.js";
import { request } from "./net.js";
import { syncChiefDot } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { currentThinking, setThinkingLevel } from "./shell.js";
import { state } from "./state.js";
import { createStreamRevealer } from "./stream-reveal.js";
import { applyTicketEvent } from "./tasks-live.js";
import { loadPendingApprovals, mountTopicProposalCard, parseTopicProposalOutput, scheduleTurnReconcile } from "./topic-proposal.js";
import { noMotion } from "./ui-atoms.js";
import { createToolFlow } from "./tool-flow.js";

/* ── 发送 ─────────────────────────────────────────────── */

/** 发送/停止同槽（cindy SendButton）：流式时同一个按钮变成停止，必须保持可点 */
function setSending(value) {
  state.sending = value;
  el.send.classList.toggle("streaming", value);
  el.send.setAttribute("aria-label", value ? "停止" : "发送");
  el.send.title = value ? "停止" : "";
  syncSendEnabled();
  // 归档防误触（2026-11-13）：当前会话开跑/停下时同步侧栏归档图标的禁用态，
  // 只动这一个按钮不重渲染整列（渲染时机在 renderChats，两边口径一致）。
  if (state.conversationId) {
    const archive = el.chats.querySelector(
      `[data-chat-archive="${CSS.escape(state.conversationId)}"]`,
    );
    if (archive instanceof HTMLButtonElement) {
      archive.disabled = value;
      archive.title = value ? "会话正在运行，请先停止再归档" : "归档（会话和记忆都还在）";
      if (value) closeChatArchiveConfirm();
    }
  }
  // 忙碌不再改变总管在线色（2026-11-06 C 批）：只重算一次，保持与服务状态一致
  syncChiefDot();
}

function syncSendEnabled() {
  // 纯附件消息也能发（2026-11-08 4a 图片；2026-11-13 加入文件）
  el.send.disabled =
    state.sending
      ? false
      : !el.input.value.trim() &&
        state.pendingImages.length === 0 &&
        state.pendingFiles.length === 0;
}

/* ── 忙时排队（扫尾批 8a：插话队列服务端化）──────────────
   语义没变：忙时按下的 Enter 仍是"下一轮的指令"（whenBusy=followUp）。变的是落点——
   以前先塞进浏览器内存里的本地数组、本轮结束后由前端补发（刷新即丢），
   现在直接提交给服务端，内核写进 durable 的 inbox（2026-11-07 消息即引导批起的
   既有能力），刷新 / 断线后话还在，按提交顺序被消费。
   前端只是视图，不造第二份事实：排队状态以 transcript 里的条目为准。 */
let pendingFollowUps = 0;

/**
 * 忙时排队提交（2026-11-08 扫尾批 8a）。
 *
 * 渲染归属：这条连接上流的是**已经在跑的这一轮**（内核把同一轮同时推给两个订阅者），
 * 后面还会接上排队那句变成的下一轮，所以这里不画正文——画了就是两份。
 * 乐观气泡先上屏（发即上屏），归位靠这条连接跑完后的回读（scheduleTurnReconcile）。
 * 也正因为这样，这条流要读到底：它收尾 = 排进来的那一轮也跑完了。
 */
async function followUp(text) {
  if (!text) return;
  if (!state.conversationId) {
    // 新会话的第一轮还没拿到 start 帧：此时提交会**新建一条会话**，把话送错地方。
    // 这句留在输入框，等这一轮跑起来再发。
    el.input.value = text;
    resize();
    addNotice("这一轮还没跑起来，这句先留在输入框。");
    return;
  }
  const conversationId = state.conversationId;
  const bubble = addMessage("user", text, Date.now(), [], { fresh: true });
  try {
    const response = await request("/api/v1/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        messages: [{ role: "user", content: text }],
        whenBusy: "followUp",
      }),
    });
    if (!response.ok || !response.body) {
      // 服务端根本没受理：气泡撤回，话放回输入框（与插话同一条口径）
      bubble.root.remove();
      addNotice("这条没发出去，已经放回输入框。");
      el.input.value = text;
      resize();
      return;
    }
    pendingFollowUps += 1;
    void new Response(response.body)
      .text()
      .catch(() => "")
      .finally(() => {
        pendingFollowUps -= 1;
        // 还有排队的连接在跑：等最后一轮跑完再回读，免得把还没轮到的气泡刷掉
        if (pendingFollowUps > 0) return;
        if (state.conversationId !== conversationId) return;
        scheduleTurnReconcile(conversationId);
      });
  } catch {
    bubble.root.remove();
    addNotice("这条没发出去，已经放回输入框。");
    el.input.value = text;
    resize();
  }
}

async function send(text, images = [], files = []) {
  if (state.sending) return;
  setSending(true);
  state.stopRequested = false;
  state.lastUserText = text; // 错误行的「重试」用（批次一）
  state.stick = true;
  // 新的一轮开跑：上一轮的错误卡退场（批 32）——人在发新消息，旧错不再是当下的事
  hideChatError();
  const turnStartMs = Date.now();
  // 通知与「正看着这个会话」的静默判定要用这一轮的会话 id（批次二）
  let streamConv = state.conversationId;

  // 建流前补挂：刷新后 SSE 不会重发历史审批，只能主动拉一次
  await loadPendingApprovals(state.conversationId);

  // 标题跟着「这一屏的第一句」走，而不是跟着 conversationId 走：
  // mock 模式也会发 start，本地留下的 id 是假的，按 id 判断会一直不更新。
  const firstTurn = !el.thread.querySelector(".msg");
  addMessage("user", text, Date.now(), images, { fresh: true, files });
  if (firstTurn) {
    el.title.textContent = (text || files[0]?.name || "图片").replace(/\s+/g, " ").slice(0, 40);
  }
  // 刚发出的这条就是最后一句话：编辑入口跟上去（messageId 在点的时候再补）
  syncEditEntry();
  const turn = addMessage("assistant", "", Date.now(), [], { fresh: true });
  // 这一轮的结构是"话 → 灰块 → 话 → 灰块"（E1 方案，2026-11-13）：
  // turn.root 下先插一个 .flow 容器，每一段话是一个 .body，连续动一次手是一组 .tchips。
  // 段与段之间顺序就是真实发生顺序，收尾也不再折成一行。
  const flow = document.createElement("div");
  flow.className = "flow";
  turn.root.insertBefore(flow, turn.foot);
  let body = turn.body;
  flow.append(body);

  // 逐字浮现（2026-11-13）：旧版每帧整段 innerHTML 会杀掉子节点动画，
  // 逐字只能靠"只追加、不重建旧 span"的增量渲染（见 stream-reveal.js）。
  // 关掉开关或系统减少动态效果时退回旧路径，caret 也跟旧路径一起保留。
  const canReveal = () => state.chatRevealFlag !== false && !noMotion.matches;
  let streamView = canReveal()
    ? createStreamRevealer({ body, renderHtml: renderMarkdown, canAnimate: canReveal })
    : null;
  const caret = streamView ? null : document.createElement("span");
  if (caret) {
    caret.className = "caret";
    body.append(caret);
  }
  /** 当前这段是否已经封口（工具动过手，下一句话要另起一段）。 */
  let segmentClosed = false;
  /** 下一个 delta 落到哪段正文：封口了就新开一段，接在灰块后面。 */
  const ensureSegment = () => {
    if (!segmentClosed) return;
    segmentClosed = false;
    // 上一段话已经落定，累积器清零——否则新段会从上一段开头重放一遍。
    answer = "";
    const next = document.createElement("div");
    next.className = "body";
    flow.append(next);
    body = next;
    streamView = canReveal()
      ? createStreamRevealer({ body: next, renderHtml: renderMarkdown, canAnimate: canReveal })
      : null;
    if (caret) next.append(caret);
  };
  const closeSegment = () => {
    if (segmentClosed) return;
    if (streamView) streamView.finish(answer);
    else if (body.isConnected) body.innerHTML = renderMarkdown(answer);
    // 空段（没说话就动手）不占位：留着会在"话/块"之间多出一条 8px 的缝。
    if (!answer.trim() && body.isConnected) body.remove();
    segmentClosed = true;
  };

  // 思考折叠卡（批次一，对齐 cindy ThinkingCard）：全态默认折叠，
  // 流式中计时跳秒，正文开始后定格。thinking 增量都往同一张卡里追加。
  let thinkEl = null;
  let thinkSummary = null;
  let thinkLabel = null;
  let thinkBody = null;
  let thinkStartMs = 0;
  let thinkLastMs = 0;
  let thinkTimer = 0;
  let answered = false;

  // 工具流：有工具才建（第一只工具动手时）。它把灰块插在 .flow 里，
  // 顺序就是"话 → 块 → 话"；主界面不写步数/耗时，细节点块看（tool-chips.js）。
  let work = null;
  const ensureWork = () => {
    if (!work) work = createToolFlow(flow, { live: true });
    return work;
  };
  /**
   * 工具要动手了：当前这段话封口，灰块接在它后面。
   * 不再把中间话折进面板（批 32 的「只留结尾」在 E1 下退役）——
   * E1 要的就是"说过的话留在正文、动手缩成小块"的交替阅读。
   */
  const breakForTool = () => {
    ensureWork();
    // 连续动第二次手（中间没说话）：留在同一组灰块里，别把一动手拆成一行一枚。
    if (segmentClosed) return;
    closeSegment();
    // 另起一组：start() 的灰块接在这段话后面。
    work.breakGroup();
  };
  /**
   * 文件变更收集（批 33，学 ZCode 的「改了 N 个文件」）：只认 edit / write，
   * 按路径聚合 +/- 行数（diff 统计）。bash 改的文件不进来——事件里没有路径，
   * 编不出来；write 覆盖全文件也没有 diff，只列路径不带数字，不编数。
   */
  const fileChanges = fileChangeCollector();
  // 派活行（2026-11-07 修）：按 ticketId 一单一行，进度帧更新、终态帧收行。
  // 轮收尾还在跑的由 finally 里 handoff 画「已转后台」——chancellor 比轮活得久。
  const delegateRows = new Map();
  const delegateRowOf = (event) => {
    let entry = delegateRows.get(event.ticketId);
    if (!entry) {
      entry = ensureWork().track(
        `${event.done}/${event.total} ${event.current || event.lastAction || ""}`.trim(),
        event.domain,
      );
      delegateRows.set(event.ticketId, entry);
    }
    return entry;
  };
  const ensureThinkCard = () => {
    if (thinkEl) return;
    thinkEl = document.createElement("details");
    thinkEl.className = "think";
    thinkEl.dataset.live = "1";
    thinkSummary = document.createElement("summary");
    // 彗星环 + 扫光文案（2026-11-13，对齐 ZCode 的"工作中"）：只有运行中才转 / 扫，
    // 定格后收成一行静态的"已思考 Ns"，不在已完成的卡上继续动。
    const orb = document.createElement("span");
    orb.className = "think-orb";
    orb.setAttribute("aria-hidden", "true");
    thinkLabel = document.createElement("span");
    thinkLabel.className = "think-label";
    thinkLabel.textContent = "思考中…";
    thinkSummary.append(orb, thinkLabel);
    thinkBody = document.createElement("div");
    thinkBody.className = "think-body";
    thinkEl.append(thinkSummary, thinkBody);
    turn.root.prepend(thinkEl);
    thinkStartMs = Date.now();
    thinkTimer = setInterval(() => {
      if (thinkEl && !answered) {
        thinkLabel.textContent = `思考中… ${Math.round((Date.now() - thinkStartMs) / 1000)}s`;
      }
    }, 500);
  };
  const endThinkCard = () => {
    if (!thinkEl || answered) return;
    answered = true;
    clearInterval(thinkTimer);
    thinkEl.dataset.live = "0";
    thinkLabel.textContent = `已思考 ${Math.max(1, Math.round((thinkLastMs - thinkStartMs) / 1000))}s`;
  };

  let answer = "";
  let frame = 0;
  // 这一轮已经用后端给的具体文案解释过「没有回复」时，结尾就不再补兜底的"模型没有返回内容。"
  let noReplyExplained = false;
  const paint = () => {
    frame = 0;
    if (!body.isConnected) return;
    if (streamView) {
      // 增量更新：旧 span 不重建，新单元只写 transition-delay（见 stream-reveal.js）。
      streamView.update(answer);
    } else {
      body.innerHTML = renderMarkdown(answer);
      if (state.sending && caret) body.append(caret);
    }
    if (state.stick) scrollToEnd();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  // 断点重放（2026-11-04 seq 方案）：这一轮流中途断掉时（连接中断、done 没等到），
  // 带 sinceSeq 回 /messages 补缺帧。窗口滑过（fromSeq > maxSeq+1）只能提示重建，
  // 不试图自动补——那是全量回读 openChat 的事。正常收尾（见过 done）不补。
  let sawDone = false;
  const replayMissing = async () => {
    if (sawDone || !state.conversationId || !state.maxSeq) return;
    try {
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/messages?sinceSeq=${state.maxSeq}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const data = await response.json();
      const events = data.events || [];
      if (!events.length) return;
      if (typeof data.fromSeq === "number" && data.fromSeq > state.maxSeq + 1) {
        addError("有事件已经超出补帧窗口，这条会话建议刷新页面重建。", { retryable: false });
        return;
      }
      for (const replayed of events) {
        const event = replayed.event || replayed;
        if (typeof event.seq === "number" && event.seq > state.maxSeq) {
          state.maxSeq = event.seq;
        }
        // 与主流分发同一套消费逻辑的子集：跨轮还在跑的活，只补"要人管"的帧。
        if (event.type === "attention") {
          applyTicketEvent({ ...event, phase: "needs_you" });
          maybeNotify("有任务单需要你处理", event.question || "", state.conversationId, "attention");
        } else if (event.type === "approval") {
          const card = renderApprovalCard({ ...event, conversationId: state.conversationId });
          if (card && !card.isConnected) turn.root.before(card);
          maybeNotify("有写操作需要你确认", event.tool || "", state.conversationId, "attention");
        } else if (event.type === "done") {
          // 补帧拿到的 done 也算收尾：完成时间与用时一起落，不然断线重连后这条没有脚注
          markDoneAt(turn.root, Date.now());
          attachUsage(turn.root, event.usage || { input: 0, output: 0, cacheRead: 0 }, Date.now() - turnStartMs);
        } else if (event.type === "delegate") {
          applyTicketEvent(event);
        }
      }
    } catch {
      // 补帧失败就失败：主链路的错误行已经报过了，这里不再叠一条。
    }
  };

  try {
    const response = await request("/api/v1/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        ...(state.conversationId
          ? { conversationId: state.conversationId }
          : { chatKind: state.chatKind === "chief" ? "chief" : "worker" }),
        // 有附件才用分段数组；纯文本仍发字符串（老形状，服务端 union 兼容）
        messages: [
          {
            role: "user",
            content:
              images.length || files.length
                ? [
                    ...(text ? [{ type: "text", text }] : []),
                    ...images.map((image) => ({
                      type: "image",
                      mimeType: image.mimeType,
                      data: image.data,
                    })),
                    ...files.map((file) => ({
                      type: "file",
                      path: file.path,
                      name: file.name,
                      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
                      ...(typeof file.bytes === "number" ? { bytes: file.bytes } : {}),
                    })),
                  ]
                : text,
          },
        ],
      }),
    });

    if (response.status === 404 && state.conversationId) {
      // 服务重启过、或者那个会话已经不在：当新会话重发一次。
      state.conversationId = "";
      localStorage.removeItem(KEY_CONV);
      turn.root.remove();
      setSending(false);
      return send(text, images, files);
    }
    if (!response.ok || !response.body) {
      turn.root.remove();
      addError(`请求失败：HTTP ${response.status}`, { retryable: true });
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
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
          // seq 游标（2026-11-04 seq 方案）：只认单调前进的，防重放帧把游标拉回去。
          if (typeof event.seq === "number" && event.seq > state.maxSeq) {
            state.maxSeq = event.seq;
          }
          if (event.type === "start") {
            state.conversationId = event.conversationId;
            streamConv = event.conversationId;
            localStorage.setItem(KEY_CONV, event.conversationId);
            renderChats();
            // 新会话（或重启后的旧会话）要立刻出现在侧栏里——
            // 以前只靠页面加载时拉一次，新建会话要等到重载才可见，置顶/重命名都够不着
            void loadChats();
            // 新会话建好了，把当前思考档补发给它（off 是服务端默认，不用发）
            if (currentThinking() !== "off") void setThinkingLevel(currentThinking());
          } else if (event.type === "thinking") {
            // 思考正文增量（批次一）：进折叠卡。占位行没有了——
            // 「在想」这件事由思考卡自己的表头表达（2026-11-07）
            ensureThinkCard();
            thinkLastMs = Date.now();
            thinkBody.textContent += event.text || "";
            if (state.stick) scrollToEnd();
          } else if (event.type === "notice") {
            // 系统提示行（2026-11-07 消息即引导）：插话/排队的诚实回执。
            // 独立成行，不并进这一轮的正文（answer 不追加）。
            addNotice(event.text || "");
          } else if (event.type === "delta") {
            // 工具动过手之后来的第一句话：另起一段正文，接在灰块后面。
            ensureSegment();
            answer += event.text;
            endThinkCard();
            schedule();
          } else if (event.type === "progress") {
            // 「在想」由思考卡表头表达；「在动手」由工具灰块表达。
            // 这里不再插占位行——两处表头已经是同一件事的第二份说法。
          } else if (event.type === "tool") {
            if (event.status === "start") {
              // 工具动手：当前话段封口，灰块接在它后面（话留在正文，不折叠）。
              breakForTool();
              ensureWork().start(event.name, event.label, event.args);
            } else {
              ensureWork().end(event.name, event.ok !== false, event.output, event.diff);
              if (event.diff) fileChanges.add(event.name, event.label, event.diff);
              // 课题提议（2026-11-07 批二）：结果落在该条工具消息处（对话末尾自然出现）
              if (event.name === "propose_topic" && event.ok !== false) {
                mountTopicProposalCard(turn.root, parseTopicProposalOutput(event.output));
              }
            }
            if (state.stick) scrollToEnd();
          } else if (event.type === "delegate") {
            // 派活也是一枚灰块：和工具在同一组里，不另起一行飘在正文上方。
            // 行的生死跟 phase 走：终态帧（done / needs_you / aborted / failed）
            // 一定有一帧，到了就收行；还在跑的由收尾 handoff 兜底（见 delegateRows）。
            breakForTool();
            const row = delegateRowOf(event);
            row.setLabel(`${event.done}/${event.total} ${event.current || event.lastAction || ""}`.trim());
            if (event.phase === "done" || event.phase === "needs_you") {
              row.close(true, event.message || "");
            } else if (event.phase === "aborted" || event.phase === "failed") {
              row.close(false, event.message || "");
            }
            syncDelegateHint(turn.root, event);
            applyTicketEvent(event);
            if (state.stick) scrollToEnd();
          } else if (event.type === "attention") {
            applyTicketEvent({ ...event, phase: "needs_you" });
            const card = document.createElement("div");
            card.className = "attention";
            const text = document.createElement("p");
            text.className = "attention-text";
            text.textContent = event.question || "它在等你回答。";
            card.append(text);
            if (event.ticketId) {
              const link = document.createElement("a");
              link.className = "attention-link";
              link.href = `#/tasks?ticket=${encodeURIComponent(event.ticketId)}`;
              link.textContent = "去任务中心处理";
              card.append(link);
            }
            body.before(card);
            maybeNotify("有任务单需要你处理", event.question || "", streamConv, "attention");
            if (state.stick) scrollToEnd();
          } else if (event.type === "approval") {
            // 写类工具要确认（批次二）：卡片挂在回答气泡上方，和 attention 同一套视觉
            const card = renderApprovalCard({ ...event, conversationId: streamConv });
            if (card && !card.isConnected) body.before(card);
            maybeNotify("有写操作需要你确认", event.tool || "", streamConv, "attention");
            if (state.stick) scrollToEnd();
          } else if (event.type === "done") {
            sawDone = true;
            if (event.finishReason === "error" && !answer) {
              if (!noReplyExplained) addError("这一轮出错了。", { retryable: true });
              maybeNotify("这一轮没答上来", el.title.textContent || "对话", streamConv, "error");
            } else {
              maybeNotify("Selenite 回复完成", el.title.textContent || "对话", streamConv, "done");
            }
            // 完成时间先落（finishReason=error 时也要留痕），再落用时；
            // 模型没回 usage 的轮次至少还有"多久"这一项，不是一片空白。
            markDoneAt(turn.root, Date.now());
            attachUsage(turn.root, event.usage || { input: 0, output: 0, cacheRead: 0 }, Date.now() - turnStartMs);
            void syncCtxMeter();
          } else if (event.type === "unanswered") {
            // 后端明确说「这次没能生成回复」：用它的文案与脱敏 detail（批 32），
            // 别让结尾兜底再补一句笼统的"模型没有返回内容。"
            noReplyExplained = true;
            addError(event.message, { detail: event.detail });
            maybeNotify("这一轮没答上来", el.title.textContent || "对话", streamConv, "error");
            if (state.stick) scrollToEnd();
          } else if (event.type === "error") {
            // 后端把 unanswered 透成 error 帧（index.ts），文案与 code/detail 一起带来。
            // 同样记下，避免结尾再叠一条"模型没有返回内容。"
            noReplyExplained = true;
            addError(event.message || "出错了", {
              retryable: true,
              detail: event.detail,
            });
            maybeNotify("Selenite 出错了", event.message || "", streamConv, "error");
          }
        }
      }
    }
    caret?.remove();
    paint();
    if (!answer.trim() && !noReplyExplained) {
      addError("模型没有返回内容。", { retryable: true });
    }
  } catch (error) {
    if (error.message !== "forbidden") {
      addError(`连接中断：${error.message}`, { retryable: true });
      // 流是断着结束的：done 没等到，可能缺帧。带 seq 去补一次（2026-11-04 seq 方案）。
      await replayMissing();
    }
  } finally {
    setSending(false);
    caret?.remove();
    endThinkCard();
    clearInterval(thinkTimer);
    if (state.stopRequested) {
      // 人的明确中断：给一行痕迹，区别于"模型自己没话说"（批次一）
      const note = document.createElement("div");
      note.className = "msg stopped";
      note.textContent = "已中断生成。";
      el.thread.append(note);
      if (state.stick) scrollToEnd();
    }
    // 收尾：当前这段正文封口（去掉 reveal span，完整重渲染一次），
    // 灰块留在原地（不再折成"已工作 Ns · M 步"一行）。
    // 人点了停止 → 派活行标「已转后台」而不是失败（2026-11-07 修）。
    closeSegment();
    for (const row of delegateRows.values()) row.handoff();
    if (work) work.finish();
    // 一轮收尾：动过文件就在正文下方挂一张「改了 N 个文件」汇总卡（批 33，
    // 学 ZCode ConversationFileSummaryPanel——折叠区收掉之后，动了哪些文件还留得住）
    mountFileSummary(turn.root, fileChanges.list());
    // 忙时排队的那些话由服务端按序消费（扫尾批 8a），这里不再有轮末补发：
    // 它们要么已经作为插话落进这一轮，要么在 durable 的 inbox 里等下一轮。
    el.input.focus();
  }
}

export { followUp, pendingFollowUps, send, setSending, syncSendEnabled };
