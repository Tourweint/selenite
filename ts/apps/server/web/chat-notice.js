/**
 * 文件变更汇总 / 提示与错误 / 用量 / 桌面通知
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { loadOlderMessages, openConversation } from "./chat-open.js";
import { send } from "./composer-send.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { formatTokenCount } from "./providers.js";
import { currentRoute } from "./route.js";
import { state } from "./state.js";
import { openModal, toast } from "./ui-atoms.js";
import { TOOL_ICON_PATHS } from "./tool-meta.js";

/* ── 文件变更汇总（2026-11-10 批 33，学 ZCode ConversationFileSummaryPanel）──
 * ZCode 的形状：折叠行「改了 N 个文件 +A -B」，点开逐文件列表（路径 + 每文件 +/-）。
 * 数据源走现成的 edit/write 工具步骤（事件与历史 steps 都带 label=路径、diff），
 * 不新增存储、不动契约口径——工具事件这批起带 diff（纯增量），两边终于同一份事实。
 * 刻意没有：ZCode 的逐文件 diff 查看器与回退按钮——MyGo 没有 code viewer 与 rewind
 * 机制，完整改动在工作过程折叠区里点开 edit 步骤就能看，这里只做"动了哪些"的提示。
 */

/** 只认改文件的工具；read/bash 不算（bash 改的文件事件里没有路径，编不出来） */
const FILECHANGE_TOOLS = new Set(["edit", "write"]);

/** unified diff → +N / -M 行数：跳过文件头（+++ / ---），逐行数前缀 */
function diffStats(diff) {
  let add = 0;
  let del = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}

/** 一轮的文件变更收集器：按路径聚合（同一个文件改三次算一个文件、行数累加） */
function fileChangeCollector() {
  const map = new Map();
  return {
    add(name, label, diff) {
      if (!FILECHANGE_TOOLS.has(name) || !label) return;
      const entry = map.get(label) || { add: 0, del: 0 };
      const stats = diffStats(diff);
      entry.add += stats.add;
      entry.del += stats.del;
      map.set(label, entry);
    },
    /** 展开用的有序列表：按第一次动手的先后排（时间序，不按字母序） */
    list() {
      return [...map.entries()].map(([path, counts]) => ({ path, ...counts }));
    },
  };
}

/**
 * 「改了 N 个文件」汇总卡：挂在正文下方、灰块之后。
 * 历史回读从 steps 收集（collectFileChangesFromSteps），形状与现场一致。
 */
function mountFileSummary(root, files) {
  if (!root || !files.length) return;
  const totalAdd = files.reduce((sum, file) => sum + file.add, 0);
  const totalDel = files.reduce((sum, file) => sum + file.del, 0);

  const box = document.createElement("section");
  box.className = "fsum";
  box.dataset.open = "0";

  const chevron = document.createElement("span");
  chevron.className = "fsum-chevron";
  chevron.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICON_PATHS.chevron}</svg>`;

  const title = document.createElement("span");
  title.className = "fsum-title";
  title.textContent = files.length === 1 ? "改了 1 个文件" : `改了 ${files.length} 个文件`;

  const nums = document.createElement("span");
  nums.className = "fsum-nums";
  if (totalAdd > 0) {
    const add = document.createElement("i");
    add.className = "fsum-add";
    add.textContent = `+${totalAdd}`;
    nums.append(add);
  }
  if (totalDel > 0) {
    const del = document.createElement("i");
    del.className = "fsum-del";
    del.textContent = `-${totalDel}`;
    nums.append(del);
  }

  const head = document.createElement("button");
  head.type = "button";
  head.className = "fsum-head";
  head.setAttribute("aria-expanded", "false");
  head.append(chevron, title, nums);
  head.addEventListener("click", () => {
    const open = box.dataset.open !== "1";
    box.dataset.open = open ? "1" : "0";
    head.setAttribute("aria-expanded", String(open));
  });

  const list = document.createElement("div");
  list.className = "fsum-files";
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "fsum-file";
    const path = document.createElement("span");
    path.className = "fsum-path";
    path.textContent = file.path;
    path.title = file.path;
    row.append(path);
    if (file.add > 0) {
      const add = document.createElement("i");
      add.className = "fsum-add";
      add.textContent = `+${file.add}`;
      row.append(add);
    }
    if (file.del > 0) {
      const del = document.createElement("i");
      del.className = "fsum-del";
      del.textContent = `-${file.del}`;
      row.append(del);
    }
    list.append(row);
  }

  box.append(head, list);
  root.append(box);
}

/** 历史回读的收集：从一条回答的 steps 里捞出 edit / write 步骤（与现场同口径） */
function collectFileChangesFromSteps(steps) {
  const collector = fileChangeCollector();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step && step.label) collector.add(step.name, step.label, step.diff);
  }
  return collector.list();
}

/** 错误行。`retryable` 时带「重试」——重发这条错误的最后一句话（批次一，2026-11-04） */
/**
 * 系统提示行（2026-11-07 消息即引导）。
 *
 * 只用于"这件事变了但你不需要看模型说话"：插话请求落到下一个边界、
 * 补充已受理之类。与 addError 分开的理由：它不是失败，不该染成红色，
 * 也不该被当成模型的正文进 markdown 渲染。
 */
function addNotice(text) {
  if (!text) return;
  const wrap = document.createElement("div");
  wrap.className = "msg notice";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  wrap.append(body);
  el.thread.append(wrap);
  if (state.stick) scrollToEnd();
}

function addError(text, opts = {}) {
  // 批 32（对齐 ZCode ChatErrorBanner）：错误不再插进消息流（流里一行红字
  // 会把正文挤乱、滚动跳位），改挂 composer 上方一张卡：一行摘要 +
  // 详情（弹窗）/ 复制 / 重试 / ×。opts.detail 为脱敏摘要，opts.code 稳定类别。
  showChatError({
    message: text,
    detail: opts.detail || "",
    retryable: Boolean(opts.retryable && state.lastUserText),
  });
}

/**
 * 错误卡（2026-11-10 批 32）：渲染 / 更新 composer 上方那张卡。
 * 一轮只留一张卡——同一轮里接连报错时后到的覆盖先到的（人在意的是最新一次）。
 * `retryPayload` 存「重试」要重发的那条话；切会话 / 发新消息时整卡退场。
 */
function showChatError({ message, detail = "", retryable = false, retryPayload = null }) {
  const host = el.chatError;
  if (!host) return;
  host.replaceChildren();
  host.hidden = false;

  const icon = document.createElement("span");
  icon.className = "chat-error-icon";
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';

  const text = document.createElement("div");
  text.className = "chat-error-text";
  text.textContent = message || "出错了";

  const actions = document.createElement("div");
  actions.className = "chat-error-actions";
  const button = (label, title, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost chat-error-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    actions.append(b);
    return b;
  };

  // 详情才进小窗（ZCode 的理由：内嵌展开会把消息区撑高、滚动跳动）
  if (detail) {
    button("详情", "查看脱敏后的错误细节", () => {
      openModal("错误详情", (body) => {
        const pre = document.createElement("pre");
        pre.className = "chat-error-detail";
        pre.textContent = detail;
        body.append(pre);
      });
    });
  }
  if (detail || message) {
    button("复制", "复制这条报错（已脱敏），方便贴给别人看", async () => {
      const full = detail ? `${message}\n\n${detail}` : message;
      try {
        await navigator.clipboard.writeText(full);
        toast("已复制（不含密钥与上游地址）");
      } catch {
        toast("复制失败，手动选文本吧");
      }
    });
  }
  if (retryable) {
    button("重试", "重新发送上一条消息", () => {
      hideChatError();
      void send(retryPayload ?? state.lastUserText);
    });
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost chat-error-btn chat-error-close";
  dismiss.setAttribute("aria-label", "关闭");
  dismiss.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  dismiss.addEventListener("click", hideChatError);
  actions.append(dismiss);

  host.append(icon, text, actions);
}

/** 错误卡退场。切会话 / 发出新消息时调用——错误是"那一轮"的事，不追着人跑。 */
function hideChatError() {
  if (!el.chatError) return;
  el.chatError.hidden = true;
  el.chatError.replaceChildren();
}

/**
 * 消息级用时/token（批次一）：hover 才出现，落在正文下方的脚注里。
 * 2026-11-06 从「右侧浮层」改成脚注的一部分：复制 · 用时 · 完成时间同一行，
 * 不再各自 absolute 定位（那样永远跟正文右边缘对不齐）。
 *
 * 两路数据源共用：现场那一轮给 `usage + 墙钟`（两个数字都显示），
 * 历史回读只给 `workMs`（没有 token 可读，就只显示用时，不编 0 tok）。
 */
function attachUsage(root, usage, ms) {
  const input = usage?.input || 0;
  const output = usage?.output || 0;
  const total = input + output;
  const hasDuration = typeof ms === "number" && ms > 0;
  if (!root.isConnected || (total <= 0 && !hasDuration)) return;
  const foot = root.querySelector(".msg-foot");
  if (!foot) return;
    let chip = foot.querySelector(".msg-usage");
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "msg-usage";
      // 复制按钮恒在最前，其余按「用时 · 完成时间」顺排。
      // （2026-11-07 修：原来 insertBefore(copy.nextSibling || firstChild) 在复制按钮
      //   是末节点时会回落到 firstChild——chip 反而插到它前面去了。）
      const copy = foot.querySelector(".copy-btn");
      if (copy) copy.after(chip);
      else foot.prepend(chip);
    }
  const seconds = hasDuration ? `${(ms / 1000).toFixed(1)}s` : "";
  chip.textContent = total > 0
    ? `${total.toLocaleString()} tok${seconds ? ` · ${seconds}` : ""}`
    : seconds;
}

function scrollToEnd() {
  el.scroll.scrollTop = el.scroll.scrollHeight;
}

/** 回到底部按钮（2026-11-16）：离底部超过一屏才露出来，点一下跳回最新。
 *  显隐挂在既有滚动监听上（同一份 distance，不另起监听）；首页态没有消息，永不显示。 */
const chatBackbottom = document.getElementById("chat-backbottom");

el.scroll.addEventListener("scroll", () => {
  const distance = el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight;
  state.stick = distance < 80;
  if (chatBackbottom && el.viewChat?.dataset.home !== "1") {
    chatBackbottom.hidden = distance < 300;
  }
  // 滑到顶附近自动续上一页（2026-11-13 历史分页）。loadOlderMessages 自己挡重复请求，
  // 切会话/开关关着/已经到最早时它直接返回，不会打扰普通滚动。
  if (el.scroll.scrollTop < 120) void loadOlderMessages();
});

chatBackbottom?.addEventListener("click", () => {
  scrollToEnd();
  chatBackbottom.hidden = true;
});

/* ── 桌面通知（批次二，三时机：完成 / 出错 / 待你处理）──────
   静默判定是前置条件不是优化：窗口可见且正看着这个会话 → 不打扰
   （cindy notificationService 的口径）。开关在设置-服务分区，默认关。
   三时机过滤（2026-11-07 抽屉改造）：纯前端 localStorage，
   KEY_NOTIFY_TIMING = all | error | attention，默认 all（= 现行为）。
   maybeNotify 带 kind：all 放行全部；error 放行 error+attention；attention 只放行 attention。 */
const KEY_NOTIFY = "lifediary.notify";
const KEY_NOTIFY_TIMING = "lifediary.notify.timing";

function maybeNotify(title, body, convId, kind = "done") {
  if (localStorage.getItem(KEY_NOTIFY) !== "1") return;
  const timing = localStorage.getItem(KEY_NOTIFY_TIMING) || "all";
  if (timing === "attention" && kind !== "attention") return;
  if (timing === "error" && kind !== "error" && kind !== "attention") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (
    document.visibilityState === "visible" &&
    convId &&
    convId === state.conversationId &&
    currentRoute() === "chat"
  ) {
    return;
  }
  const n = new Notification(title, { body: (body || "").slice(0, 120), tag: "lifediary" });
  n.addEventListener("click", () => {
    window.focus();
    // 通知点进来就是"我要看这条对话"：在群聊 / 任务页上收到通知也要真切过去，
    // 所以走 openConversation（先切路由再回读），不是只换背后的会话。
    if (convId && convId !== state.conversationId) void openConversation(convId);
    n.close();
  });
}

/** 上下文环形指示（2026-11-04 从顶栏搬进 composer 右下）：done 后与切会话时刷新；
    used / window 任一读不到就整块隐藏（维持原口径） */
const CTX_R = 8.25;
const CTX_C = 2 * Math.PI * CTX_R;

/* 上下文容量卡（2026-11-14，学 ZCode 的 chat.contextUsage 浮层）：
   环本身不摆数字，悬停/聚焦/点击时向上弹一张卡——顶部「已用 / 总量（占比）」，
   中间一条按构成分段的进度条，下面按字符占比列「这一窗里是什么在占地方」。
   构成来自服务端 /context 新增的 breakdown（按上下文实文计字符，口径同 ZCode）。 */
const CTX_SOURCE_LABEL = {
  messages: "消息",
  system_prompt: "系统提示词",
  skills: "技能",
  tool_prompt: "工具定义",
  tool_calls: "工具调用",
  tool_results: "工具结果",
};
let ctxPayload = null;
let ctxCard = null;
let ctxPinned = false;
let ctxHideTimer = 0;

function ctxPct(used, windowSize) {
  return Math.min(100, Math.max(0, Math.round((used / windowSize) * 100)));
}

/** 构成百分比：先取整再用最大余数补足 100，避免 6 段各自四舍五入后合计 101%。 */
function ctxShares(items, total) {
  const raw = items.map((item) => (item.chars / total) * 100);
  const shares = raw.map((value) => Math.floor(value));
  let left = 100 - shares.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; index < left; index += 1) {
    shares[order[index % order.length].index] += 1;
  }
  return shares;
}

function renderCtxCard(payload) {
  if (!ctxCard || !payload) return;
  const used = payload.used;
  const windowSize = payload.window;
  const pct = payload.pct ?? ctxPct(used, windowSize);
  const breakdown = (payload.breakdown || []).filter((item) => item && item.chars > 0);
  const totalChars = breakdown.reduce((sum, item) => sum + item.chars, 0);
  const shares = totalChars > 0 ? ctxShares(breakdown, totalChars) : [];

  const usage = ctxCard.querySelector(".ctx-card-usage");
  usage.textContent = `${formatTokenCount(used)} / ${formatTokenCount(windowSize)}（${pct}%）`;
  ctxCard.querySelector(".ctx-bar-fill").style.width = `${Math.max(pct, pct > 0 ? 1.5 : 0)}%`;

  const fill = ctxCard.querySelector(".ctx-bar-fill");
  fill.replaceChildren();
  breakdown.forEach((item, index) => {
    const segment = document.createElement("span");
    segment.className = "ctx-seg";
    segment.style.width = `${(item.chars / totalChars) * 100}%`;
    segment.style.background = `var(--ctx-seg-${(index % 6) + 1})`;
    // 下面 legend 已经写了同一个标签与百分比；分段块不再挂 title，
    // 否则卡片里悬停又会冒一份浏览器默认框。
    fill.append(segment);
  });

  const legend = ctxCard.querySelector(".ctx-legend");
  legend.replaceChildren();
  breakdown.forEach((item, index) => {
    const row = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "ctx-dot";
    dot.style.background = `var(--ctx-seg-${(index % 6) + 1})`;
    const name = document.createElement("span");
    name.className = "ctx-name";
    name.textContent = CTX_SOURCE_LABEL[item.source] || "其他";
    const percent = document.createElement("span");
    percent.className = "ctx-percent";
    percent.textContent = shares[index] === 0 ? "＜1%" : `${shares[index] ?? Math.round((item.chars / totalChars) * 100)}%`;
    row.append(dot, name, percent);
    legend.append(row);
  });
  legend.hidden = breakdown.length === 0;
}

function placeCtxCard() {
  if (!ctxCard || ctxCard.hidden) return;
  const ring = el.ctxRing.getBoundingClientRect();
  const box = ctxCard.getBoundingClientRect();
  const gap = 10;
  let left = ring.left + ring.width / 2 - box.width / 2;
  left = Math.min(Math.max(8, left), window.innerWidth - box.width - 8);
  let top = ring.top - box.height - gap;
  // 上面放不下就翻到下面；两端都越界时贴住上边
  if (top < 8) top = Math.min(ring.bottom + gap, window.innerHeight - box.height - 8);
  ctxCard.style.left = `${Math.round(left)}px`;
  ctxCard.style.top = `${Math.round(top)}px`;
}

function ensureCtxCard() {
  if (ctxCard) return ctxCard;
  ctxCard = document.createElement("div");
  ctxCard.className = "ctx-card";
  ctxCard.setAttribute("role", "dialog");
  ctxCard.setAttribute("aria-label", "上下文容量");
  ctxCard.hidden = true;
  ctxCard.innerHTML = `
    <div class="ctx-card-head">
      <span class="ctx-card-title">上下文容量</span>
      <span class="ctx-card-usage"></span>
    </div>
    <div class="ctx-bar" aria-hidden="true"><div class="ctx-bar-fill"></div></div>
    <ul class="ctx-legend"></ul>`;
  document.body.append(ctxCard);
  ctxCard.addEventListener("pointerenter", cancelCtxClose);
  ctxCard.addEventListener("pointerleave", scheduleCtxClose);
  return ctxCard;
}

function cancelCtxClose() {
  if (ctxHideTimer) {
    clearTimeout(ctxHideTimer);
    ctxHideTimer = 0;
  }
}

function scheduleCtxClose() {
  if (ctxPinned) return;
  cancelCtxClose();
  ctxHideTimer = setTimeout(() => closeCtxCard(), 140);
}

function openCtxCard(pin = false) {
  if (!ctxPayload || ctxPayload.conv !== state.conversationId || el.ctxRing.hidden) return;
  ensureCtxCard();
  cancelCtxClose();
  renderCtxCard(ctxPayload);
  ctxCard.hidden = false;
  el.ctxRing.setAttribute("aria-expanded", "true");
  // 显示之后才量得到高度，位置随即校正
  placeCtxCard();
  if (pin) ctxPinned = true;
}

function closeCtxCard(force = false) {
  if (ctxPinned && !force) return;
  cancelCtxClose();
  ctxPinned = false;
  if (!ctxCard) return;
  ctxCard.hidden = true;
  el.ctxRing.setAttribute("aria-expanded", "false");
}

function toggleCtxCard() {
  if (ctxCard && !ctxCard.hidden && ctxPinned) closeCtxCard(true);
  else openCtxCard(true);
}

function mountCtxCard() {
  el.ctxRing.setAttribute("tabindex", "0");
  el.ctxRing.setAttribute("role", "button");
  el.ctxRing.setAttribute("aria-haspopup", "dialog");
  el.ctxRing.setAttribute("aria-expanded", "false");
  el.ctxRing.addEventListener("pointerenter", () => openCtxCard(false));
  el.ctxRing.addEventListener("pointerleave", scheduleCtxClose);
  el.ctxRing.addEventListener("focus", () => openCtxCard(false));
  el.ctxRing.addEventListener("blur", scheduleCtxClose);
  el.ctxRing.addEventListener("click", toggleCtxCard);
  el.ctxRing.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleCtxCard();
    } else if (event.key === "Escape") {
      closeCtxCard(true);
      el.ctxRing.blur();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!ctxCard || ctxCard.hidden) return;
    if (el.ctxRing.contains(event.target) || ctxCard.contains(event.target)) return;
    closeCtxCard(true);
  });
  window.addEventListener("resize", placeCtxCard);
  window.addEventListener("scroll", placeCtxCard, true);
}

async function syncCtxMeter(stillCurrent = () => true) {
  const convId = state.conversationId;
  if (!stillCurrent()) return;
  if (!convId || currentRoute() !== "chat") {
    el.ctxRing.hidden = true;
    ctxPayload = null;
    closeCtxCard(true);
    return;
  }
  try {
    const response = await request(
      `/api/v1/agent/chat/${encodeURIComponent(convId)}/context`,
      { cache: "no-store" },
    );
    const data = await response.json();
    // 请求期间切了会话 / 路由：旧游标不许画到新会话上
    if (!stillCurrent() || state.conversationId !== convId) return;
    if (!data.used || !data.window) {
      el.ctxRing.hidden = true;
      ctxPayload = null;
      closeCtxCard(true);
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round((data.used / data.window) * 100)));
    el.ctxFill.style.strokeDasharray = `${CTX_C}`;
    el.ctxFill.style.strokeDashoffset = `${CTX_C * (1 - pct / 100)}`;
    // 环边不摆数字（2026-11-13 拍板）；2026-11-14 起悬停不再用一句话浮签，
    // 改为「上下文容量」卡片（占比 + 构成 + 进度条，对齐 ZCode）：数字、构成都在卡里。
    ctxPayload = { ...data, conv: convId, pct };
    el.ctxRing.setAttribute("aria-label", `上下文已用 ${formatTokenCount(data.used)} / ${formatTokenCount(data.window)}`);
    if (ctxCard && !ctxCard.hidden) renderCtxCard(ctxPayload);
    // 阈值：<70% 中性灰；70–90% 警示；>90% 错误
    el.ctxRing.classList.toggle("warn", pct >= 70 && pct <= 90);
    el.ctxRing.classList.toggle("danger", pct > 90);
    el.ctxRing.dataset.conv = convId;
    el.ctxRing.hidden = false;
  } catch {
    el.ctxRing.hidden = true;
    ctxPayload = null;
    closeCtxCard(true);
  }
}

export { CTX_C, CTX_R, FILECHANGE_TOOLS, KEY_NOTIFY, KEY_NOTIFY_TIMING, addError, addNotice, attachUsage, collectFileChangesFromSteps, diffStats, fileChangeCollector, hideChatError, maybeNotify, mountCtxCard, mountFileSummary, scrollToEnd, showChatError, syncCtxMeter };
