/**
 * 文件变更汇总 / 提示与错误 / 用量 / 桌面通知
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { loadOlderMessages, openConversation } from "./chat-open.js";
import { markDoneAt } from "./chat-thread.js";
import { send } from "./composer-send.js";
import { el } from "./dom.js";
import { request } from "./net.js";
import { formatTokenCount } from "./providers.js";
import { currentRoute } from "./route.js";
import { state } from "./state.js";
import { openModal, toast } from "./ui-atoms.js";
import { TOOL_ICON_PATHS } from "./work-panel.js";

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
 * 「改了 N 个文件」汇总卡：挂在正文下方、工作过程块之后。
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
  head.title = "点开看动了哪些文件（完整改动在工作过程里）";
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
  dismiss.title = "关闭";
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
  chip.title =
    total > 0
      ? `输入 ${input} · 输出 ${output} · 缓存命中 ${usage?.cacheRead || 0} tokens`
      : "这一轮的用时（历史消息只留时长，不重算 token）";

  // 完成时间：实时那一轮以"拿到 done 的时刻"为准（不是消息创建时刻）
  markDoneAt(root, Date.now());
}

function scrollToEnd() {
  el.scroll.scrollTop = el.scroll.scrollHeight;
}

el.scroll.addEventListener("scroll", () => {
  const distance = el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight;
  state.stick = distance < 80;
  // 滑到顶附近自动续上一页（2026-11-13 历史分页）。loadOlderMessages 自己挡重复请求，
  // 切会话/开关关着/已经到最早时它直接返回，不会打扰普通滚动。
  if (el.scroll.scrollTop < 120) void loadOlderMessages();
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

async function syncCtxMeter(stillCurrent = () => true) {
  const convId = state.conversationId;
  if (!stillCurrent()) return;
  if (!convId || currentRoute() !== "chat") {
    el.ctxRing.hidden = true;
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
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round((data.used / data.window) * 100)));
    el.ctxFill.style.strokeDasharray = `${CTX_C}`;
    el.ctxFill.style.strokeDashoffset = `${CTX_C * (1 - pct / 100)}`;
    // 数字口径（2026-11-13 用户拍板）：环边**不摆数字**，只留 20×20 的环；
    // 「用了多少 / 顶了多少 / 最多多少」全部收进悬停，环本身的花费仍按占比画。
    el.ctxRing.title = `用了 ${formatTokenCount(data.used)} · 顶了 ${pct}% · 最多 ${formatTokenCount(data.window)}`;
    // 阈值：<70% 中性灰；70–90% 警示；>90% 错误
    el.ctxRing.classList.toggle("warn", pct >= 70 && pct <= 90);
    el.ctxRing.classList.toggle("danger", pct > 90);
    el.ctxRing.dataset.conv = convId;
    el.ctxRing.hidden = false;
  } catch {
    el.ctxRing.hidden = true;
  }
}

export { CTX_C, CTX_R, FILECHANGE_TOOLS, KEY_NOTIFY, KEY_NOTIFY_TIMING, addError, addNotice, attachUsage, collectFileChangesFromSteps, diffStats, fileChangeCollector, hideChatError, maybeNotify, mountFileSummary, scrollToEnd, showChatError, syncCtxMeter };
