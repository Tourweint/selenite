/**
 * 发送与忙时排队
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { renderApprovalCard } from "./approval-card.js";
import { freezeChatProjectLabel } from "./chat-project.js";
import { addError, addNotice, attachUsage, fileChangeCollector, hideChatError, maybeNotify, mountFileSummary, scrollToEnd, syncCtxMeter } from "./chat-notice.js";
import { addMessage, stampMessageClock, syncEditEntry } from "./chat-thread.js";
import { stopRunningWatch, watchRunningTurn } from "./chat-open.js";
import { closeChatArchiveConfirm, loadChats, renderChats } from "./chats-list.js";
import { KEY_CONV, el } from "./dom.js";
import { renderMarkdown, syncDelegateHint } from "./markdown.js";
import { refreshModelPill } from "./hover-tip.js";
import { request } from "./net.js";
import { parsePartnerExternalId } from "./partner-sessions.js";
import { partnerDisplayName, syncChiefDot } from "./partners-status.js";
import { resize } from "./plus-menu.js";
import { currentThinking, setThinkingLevel, thinkingTouched } from "./shell.js";
import { state } from "./state.js";
import { createStreamRevealer } from "./stream-reveal.js";
import { isTaskConversation, sendTaskMessage } from "./task-thread.js";
import { applyTicketEvent } from "./tasks-live.js";
import { loadPendingApprovals, scheduleTurnReconcile } from "./turn-reconcile.js";
import { noMotion } from "./ui-atoms.js";
import { createToolFlow } from "./tool-flow.js";

/* ── 发送 ─────────────────────────────────────────────── */

/**
 * 上报卡动作（2026-11-19 批2）：POST /api/v1/agent/escalations/:ticketId/route。
 * action=chief → 重新唤起总管代答轮；action=user → 问题转成 ask 卡在会话里等主人答。
 * 返回是否成功；失败时调用方把按钮恢复可点并如实报错（不留一个永远转圈的按钮）。
 */
async function routeEscalation(ticketId, action) {
  try {
    const response = await request(
      `/api/v1/agent/escalations/${encodeURIComponent(ticketId)}/route`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
    if (response.ok) return true;
    addError(response.status === 404 ? "这条上报已经不在等处理了。" : "上报路由失败，请稍后再试。");
    return false;
  } catch {
    addError("上报路由失败（网络错误），请稍后再试。");
    return false;
  }
}

/** 发送/停止同槽（cindy SendButton）：流式时同一个按钮变成停止，必须保持可点 */
function setSending(value) {
  state.sending = value;
  el.send.classList.toggle("streaming", value);
  el.send.setAttribute("aria-label", value ? "停止" : "发送");
  el.send.setAttribute("data-tip", value ? "停止（再点一次或按 Esc）" : "发送（Enter）");
  syncSendEnabled();
  // 归档防误触（2026-11-13 立；2026-11-21 行尾三图标退役、入口收进 ⋯ 菜单）：
  // 没有归档图标可同步了，忙态在打开 ⋯ 菜单时现算；这里只剩一件事——
  // 当前会话开跑时收掉已开的行内归档确认条，免得确认条悬在跑动的会话行上。
  if (value) closeChatArchiveConfirm();
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

/* ── 忙时投递（2026-11-07 消息即引导；扫尾批 8a 服务端化；2026-11-19 插话统一改缺省）──
   忙时按下的 Enter 现在默认是"插进当前轮"（whenBusy=steer，读插件卡「忙时消息」档）；
   插件卡切"排队"时回到旧行为（whenBusy=followUp，是下一轮的指令）。两条路都是直接
   提交给服务端，内核写进 durable 的 inbox，刷新 / 断线后话还在，按提交顺序被消费。
   前端只是视图，不造第二份事实：插话 / 排队状态以 transcript 里的条目为准。 */
let pendingFollowUps = 0;

/**
 * 忙时投递档（2026-11-19 插话统一 批1）：插件卡「忙时消息」（AGENT_STEER_DEFAULT）。
 * 开（默认）= 忙时消息插进当前轮（steer）；关 = 排队（followUp，改动前口径）。
 * flags 清单拉一次进 state.flagsCache（与设置页同源）；设置页改档会更新 flagsCache，
 * 下次发送现读，即时生效。端点不可用 / 没这个键 → 按插话（默认值语义）。
 */
async function busyWhenSteerDefault() {
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
  const flag = state.flagsCache.get("AGENT_STEER_DEFAULT");
  if (!flag) return true;
  return (flag.effectiveValue ?? flag.value) !== "false";
}

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
  // 本地这一轮马上有自己的流：停掉"后台还在跑"的自动重读，免得它插进来重建屏幕
  stopRunningWatch();
  // 任务线程（2026-11-22）：话直接送执行端（steer / 续跑），不跑宿主助手。
  // 失败把原文放回输入框；成功由 task-thread 自己补用户气泡。
  if (isTaskConversation(state.conversationId)) {
    const ok = await sendTaskMessage(text);
    if (!ok) {
      el.input.value = text;
      resize();
    }
    return;
  }
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
    const label = (text || files[0]?.name || "图片").replace(/\s+/g, " ").slice(0, 40);
    const parsed = parsePartnerExternalId(state.conversationId);
    if (parsed?.role === "side") {
      // 副会话顶栏是「人设名 · 会话标题」：首句只换标题部分，别把人设前缀冲掉
      // （canonical 有 loadRoster 兜底，副会话没有，必须在这里保住）。
      el.title.textContent = `${partnerDisplayName(parsed.partnerId)} · ${label}`;
    } else if (parsed?.role !== "canonical") {
      // canonical 保持现状不动；worker / chief / 无 partner 维持原逻辑
      el.title.textContent = label;
    }
  }
  // 刚发出的这条就是最后一句话：编辑入口跟上去（messageId 在点的时候再补）
  syncEditEntry();
  const turn = addMessage("assistant", "", Date.now(), [], { fresh: true });
  // 跑动中不挂消息脚注（2026-11-25 用户口径）：复制/分支按钮只在回答收尾后
  // hover 才出现——还没答完就让人复制，复制到的只是半截。
  turn.root.classList.add("is-streaming");
  // 这一轮的结构是"话 → 灰块 → 话 → 灰块"（E1 方案，2026-11-13）：
  // turn.root 下先插一个 .flow 容器，每一段话是一个 .body，连续动一次手是一组 .tchips。
  // 段与段之间顺序就是真实发生顺序，收尾也不再折成一行。
  const flow = document.createElement("div");
  flow.className = "flow";
  turn.root.insertBefore(flow, turn.foot);
  let body = turn.body;
  flow.append(body);
  /**
   * 卡片挂在回答上方（attention / approval / escalation 共用）。
   * 当前话段可能已经被灰块封口：2026-11-20 起发消息就先立思考块，空 body 会被
   * closeSegment 撤掉——这时退回插在整个 flow 前面，否则卡片挂到脱链节点上，静默丢掉。
   */
  const insertAboveAnswer = (card) => {
    if (!card || card.isConnected) return;
    if (body.isConnected) body.before(card);
    else flow.before(card);
  };

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

  // 思考块（2026-11-17 用户口径）：不再是消息顶上那张展开式折叠卡，
  // 而是和工具同款的一枚灰块——位置就是它真正发生的地方，正文进详情面板，
  // 主界面只写「思考」，不写秒数（和工具块同一条规矩）。
  let think = null;
  // 发消息时就先立一枚"转圈"的思考块占住位置（连接上游也算在想）；真思考正文到了
  // 就继承这一枚。2026-11-21 用户口径「思考过程也要显示出来」翻掉 2026-11-20 的
  // 空块清理：没等到思考正文的不再撤掉——它就是这一轮的「思考」步，落定后详情里
  // 如实写「这段没留下正文」（服务端 session-transcript 同批给历史补记这一步）。

  // 工具流：有工具才建（第一只工具动手时）。它把灰块插在 .flow 里，
  // 顺序就是"话 → 块 → 话"；主界面不写步数/耗时，细节点块看（tool-chips.js）。
  let work = null;
  const ensureWork = () => {
    if (!work) work = createToolFlow(flow, { live: true });
    return work;
  };
  /**
   * 要动手 / 要动脑了（工具、派活、思考）：当前这段话封口，灰块接在它后面。
   * 不再把中间话折进面板（批 32 的「只留结尾」在 E1 下退役）——
   * E1 要的就是"说过的话留在正文、动手缩成小块"的交替阅读。
   */
  const breakForWork = () => {
    // 真动手了就不再算"在想"：思考块在这一刻定格，用时只算思考本身，
    // 不把后面的工具执行时间也算进去（不然一枚"思考 40s"其实是慢在工具上）。
    endThink();
    ensureWork();
    // 连续动第二次（中间没说话）：留在同一组灰块里，别把一动手拆成一行一枚。
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
  /** 思考开始：当前话段封口，思考块接在它后面（和工具动手同一套排序规则）。 */
  const beginThink = () => {
    if (think) return;
    breakForWork();
    think = ensureWork().think();
  };
  /**
   * 思考定型：补上「用时」，正文留在详情里。
   * 2026-11-21 翻掉 2026-11-20 的撤块：没吐思考正文的也落定成一枚空壳「思考」
   * （详情如实说没留正文）——转圈消失会让人以为这一步被藏了。
   */
  const endThink = () => {
    if (!think) return;
    think.finish();
    think = null;
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
    if (sawDone || !state.conversationId || !state.maxSeq) return false;
    try {
      const response = await request(
        `/api/v1/agent/chat/${encodeURIComponent(state.conversationId)}/messages?sinceSeq=${state.maxSeq}`,
        { cache: "no-store" },
      );
      if (!response.ok) return false;
      const data = await response.json();
      const events = data.events || [];
      if (!events.length) return false;
      if (typeof data.fromSeq === "number" && data.fromSeq > state.maxSeq + 1) {
        addError("有事件已经超出补帧窗口，这条会话建议刷新页面重建。", { retryable: false });
        return false;
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
        } else if (event.type === "escalation") {
          // 决策上报补帧（批2）：只补卡与状态，不再起动作请求（活跃集服务端有账）。
          applyTicketEvent({ ...event, phase: "needs_you" });
          const card = document.createElement("div");
          card.className = "attention escalation";
          const label = document.createElement("p");
          label.className = "attention-text";
          label.textContent = `【工人上报】${event.question || "它在等一个决定。"}`;
          card.append(label);
          if (event.ticketId) {
            const link = document.createElement("a");
            link.className = "attention-link";
            link.href = `#/tasks?ticket=${encodeURIComponent(event.ticketId)}`;
            link.textContent = "去任务中心看";
            card.append(link);
          }
          turn.root.before(card);
          maybeNotify("工人上报了一个问题", event.question || "", state.conversationId, "attention");
        } else if (event.type === "done") {
          // 补帧拿到的 done 也算收尾：补上用时脚注，断线重连后这条仍有耗时
          attachUsage(turn.root, event.usage || { input: 0, output: 0, cacheRead: 0 }, Date.now() - turnStartMs);
          // 收尾时刻（2026-11-17）：和主链路一致，补帧到的 done 也把"几点答完"落上去
          stampMessageClock(turn.root, Date.now());
        } else if (event.type === "delegate") {
          applyTicketEvent(event);
        }
      }
      return true;
    } catch {
      // 补帧失败就失败：主链路的错误行已经报过了，这里不再叠一条。
      return false;
    }
  };

  // 一发出去就把「思考」立起来转圈（2026-11-20 用户口径）：连上游、等第一个字
  // 也算在想，别让人对着一只空泡乱点。真思考到了继承这一枚（beginThink 已存在就返回），
  // 没有思考正文就由 endThink 撤掉（见上面）。
  beginThink();
  if (state.stick) scrollToEnd();

  try {
    const response = await request("/api/v1/agent/chat", {
      method: "POST",
      body: JSON.stringify({
        ...(state.conversationId
          ? { conversationId: state.conversationId }
          : {
              // 普通助手（worker）2026-11-23 退役：空态第一条消息只建总管会话，不再生产 worker 会话。
              chatKind: "chief",
              // 2026-11-19 会话级模型切换：新会话屏选的模型只带这一次；
              // 不传 = 服务端读全局默认。已有会话走 POST /agent/chat/:id/model。
              ...(state.pendingModel
                ? {
                    model: {
                      providerId: state.pendingModel.providerId,
                      modelId: state.pendingModel.modelId,
                      thinking: currentThinking(),
                    },
                  }
                : {}),
              // 2026-11-21 思考拨盘随新会话下发（顶层 thinking，优先于 model.thinking
              // 与服务端全局默认档）：此前只在屏选模型时才带上，不选模型直接发就被
              // 丢进服务端默认 off——用户口径「思考档位没有夺取到」。
              // 拨盘没被碰过就不发（缺省 off 不冒充选择），让服务端全局默认档说话。
              ...(thinkingTouched() ? { thinking: currentThinking() } : {}),
            }),
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
            // 新会话才冻结归属：续话的 workdir 由 openChat 回读，不能拿当前侧栏选择顶替
            const wasNew = !state.conversationId;
            state.conversationId = event.conversationId;
            streamConv = event.conversationId;
            localStorage.setItem(KEY_CONV, event.conversationId);
            // 上下文环常显（2026-11-24）：新会话第一轮期间也先把窗口画出来
            // （服务端回 used=null 时画空环，卡里写「尚未统计」）。
            void syncCtxMeter();
            // 会话已落盘：把这一刻的项目/工作区冻结成只读标签（2026-11-18）
            if (wasNew) {
              freezeChatProjectLabel();
              // 2026-11-19 会话级模型切换：新会话已用 pending / 全局模型建好。
              // 先把思考档补发（off 是服务端默认），再让 pill 拉服务端实际的模型 / 档位。
              state.pendingModel = null;
              void (async () => {
                if (currentThinking() !== "off") {
                  await setThinkingLevel(currentThinking()).catch(() => undefined);
                }
                if (state.conversationId === event.conversationId) {
                  await refreshModelPill(state.conversationId);
                }
              })();
            }
            renderChats();
            // 新会话（或重启后的旧会话）要立刻出现在侧栏里——
            // 以前只靠页面加载时拉一次，新建会话要等到重载才可见，置顶/重命名都够不着
            void loadChats();
          } else if (event.type === "thinking") {
            // 思考正文增量：进思考块（和工具同款灰块），详情里滚动看全文。
            beginThink();
            think.append(event.text || "");
            if (state.stick) scrollToEnd();
          } else if (event.type === "notice") {
            // 系统提示行（2026-11-07 消息即引导）：插话/排队的诚实回执。
            // 独立成行，不并进这一轮的正文（answer 不追加）。
            addNotice(event.text || "");
          } else if (event.type === "delta") {
            // 工具动过手之后来的第一句话：另起一段正文，接在灰块后面。
            ensureSegment();
            answer += event.text;
            endThink();
            schedule();
          } else if (event.type === "progress") {
            // 「在想」由思考块表达（跑动中的 accent + 扫光）；「在动手」由工具灰块表达。
            // 这里不再插占位行——同一件事不给第二份说法。
          } else if (event.type === "tool") {
            if (event.status === "start") {
              // 工具动手：当前话段封口，灰块接在它后面（话留在正文，不折叠）。
              breakForWork();
              ensureWork().start(event.name, event.label, event.args);
            } else {
              ensureWork().end(event.name, event.ok !== false, event.output, event.diff);
              if (event.diff) fileChanges.add(event.name, event.label, event.diff);
            }
            if (state.stick) scrollToEnd();
          } else if (event.type === "delegate") {
            // 派活也是一枚灰块：和工具在同一组里，不另起一行飘在正文上方。
            // 行的生死跟 phase 走：终态帧（done / needs_you / aborted / failed）
            // 一定有一帧，到了就收行；还在跑的由收尾 handoff 兜底（见 delegateRows）。
            breakForWork();
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
            insertAboveAnswer(card);
            maybeNotify("有任务单需要你处理", event.question || "", streamConv, "attention");
            if (state.stick) scrollToEnd();
          } else if (event.type === "approval") {
            // 写类工具要确认（批次二）：卡片挂在回答气泡上方，和 attention 同一套视觉
            const card = renderApprovalCard({ ...event, conversationId: streamConv });
            insertAboveAnswer(card);
            maybeNotify("有写操作需要你确认", event.tool || "", streamConv, "attention");
            if (state.stick) scrollToEnd();
          } else if (event.type === "escalation") {
            // worker 决策上报（批2）：复用 attention 同款皮，两个动作按钮
            // （总管代答 / 升级给用户）走上报路由端点；升级给主人的问题卡
            // 走 ask_user 现有渲染（approval-card / 全局待办），不另造样式。
            applyTicketEvent({ ...event, phase: "needs_you" });
            const card = document.createElement("div");
            card.className = "attention escalation";
            const label = document.createElement("p");
            label.className = "attention-text";
            const urgencyLabel = event.urgency === "high" ? "（紧急）" : "";
            label.textContent = `【工人上报${urgencyLabel}】${event.question || "它在等一个决定。"}`;
            card.append(label);
            if (event.context) {
              const contextLine = document.createElement("p");
              contextLine.className = "attention-text";
              contextLine.style.cssText = "opacity:.75;font-size:.92em";
              contextLine.textContent = `背景：${event.context}`;
              card.append(contextLine);
            }
            if (Array.isArray(event.options) && event.options.length > 0) {
              const optionsLine = document.createElement("p");
              optionsLine.className = "attention-text";
              optionsLine.style.cssText = "opacity:.75;font-size:.92em";
              optionsLine.textContent = `候选：${event.options.join(" / ")}`;
              card.append(optionsLine);
            }
            const actions = document.createElement("div");
            actions.style.cssText = "display:flex;gap:8px;margin-top:6px";
            const chiefButton = document.createElement("button");
            chiefButton.type = "button";
            chiefButton.className = "attention-link";
            chiefButton.textContent = "总管代答";
            chiefButton.addEventListener("click", async () => {
              chiefButton.disabled = true;
              const okRoute = await routeEscalation(event.ticketId, "chief");
              if (okRoute) chiefButton.textContent = "已叫总管来答";
              else chiefButton.disabled = false;
            });
            const userButton = document.createElement("button");
            userButton.type = "button";
            userButton.className = "attention-link";
            userButton.textContent = "升级给我";
            userButton.addEventListener("click", async () => {
              userButton.disabled = true;
              const okRoute = await routeEscalation(event.ticketId, "user");
              if (okRoute) userButton.textContent = "已升级，等你答";
              else userButton.disabled = false;
            });
            actions.append(chiefButton, userButton);
            card.append(actions);
            if (event.ticketId) {
              const link = document.createElement("a");
              link.className = "attention-link";
              link.href = `#/tasks?ticket=${encodeURIComponent(event.ticketId)}`;
              link.textContent = "去任务中心看";
              card.append(link);
            }
            insertAboveAnswer(card);
            maybeNotify("工人上报了一个问题", event.question || "", streamConv, "attention");
            if (state.stick) scrollToEnd();
          } else if (event.type === "done") {
            sawDone = true;
            if (event.finishReason === "error" && !answer) {
              if (!noReplyExplained) addError("这一轮出错了。", { retryable: true });
              maybeNotify("这一轮没答上来", el.title.textContent || "对话", streamConv, "error");
            } else {
              maybeNotify("Selenite 回复完成", el.title.textContent || "对话", streamConv, "done");
            }
            // 只落用时；模型没回 usage 的轮次至少还有"多久"这一项，不是一片空白。
            attachUsage(turn.root, event.usage || { input: 0, output: 0, cacheRead: 0 }, Date.now() - turnStartMs);
            // 收尾时刻（2026-11-17）：脚注最右那枚 `14:03` 的回答侧就是这里写的；
            // 用时仍按客户端墙钟算，与历史里服务端的 endedAt 口径一致（at + durationMs）。
            stampMessageClock(turn.root, Date.now());
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
    // 流断着结束（done 没等到，fetch 也没抛错）：以前这里静默结束，用户只看到
    // 半截回答、不知道断过。现在带 seq 自动补一次缺帧，并明说这件事（2026-11-25）。
    if (!sawDone) {
      const recovered = await replayMissing();
      if (answer.trim() || noReplyExplained) {
        addNotice(
          recovered
            ? "连接中断过，断线期间的事件已自动补上；回答正文可能不完整。"
            : "连接中断，已尝试自动重连；这条回答可能不完整。",
        );
      }
      // 服务端可能还在跑（断开 ≠ 取消）：交给后台轮次监视，跑完自动重读，
      // 别让用户对着半截回答以为活停了（2026-11-25）。
      if (!state.stopRequested && state.conversationId) {
        watchRunningTurn(state.conversationId);
      }
    }
    if (!answer.trim() && !noReplyExplained) {
      addError("模型没有返回内容。", { retryable: true });
    }
  } catch (error) {
    if (error.message !== "forbidden") {
      addError(`连接中断：${error.message}`, { retryable: true });
      // 流是断着结束的：done 没等到，可能缺帧。带 seq 去补一次（2026-11-04 seq 方案）。
      const recovered = await replayMissing();
      addNotice(
        recovered
          ? "连接中断过，断线期间的事件已自动补上；回答正文可能不完整。"
          : "连接中断，已尝试自动重连；这条回答可能不完整。",
      );
      // 同正常断流：服务端还在跑就等它收尾，完成自动重读。
      if (!state.stopRequested && state.conversationId) {
        watchRunningTurn(state.conversationId);
      }
    }
  } finally {
    setSending(false);
    // 回答收尾：脚注（复制 / 分支 / 时刻）从这一刻起才允许出现。
    turn.root.classList.remove("is-streaming");
    caret?.remove();
    endThink();
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

export { busyWhenSteerDefault, followUp, pendingFollowUps, send, setSending, syncSendEnabled };
