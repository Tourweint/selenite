/**
 * 工作过程面板（工具步/思考/耗时）
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { addStepBlock } from "./tool-flow.js";

/* ── 工作过程（2026-11-07，对齐 ZCode 的「工作过程」）──────────
 *
 * 为什么改：以前活动行是"一串平铺的小行"，跑完才收成 details。问题是
 *   ① 收起后的那一行在**正文上方**，读起来像"先给结论再给过程"，跟实际顺序相反；
 *   ② 刷新/切会话就全没了（服务端 2026-11-07 起回放 steps，见接口文档 §2.2）；
 *   ③ 一步做什么（读/写/改/跑）只有工具名，没有图标与成败语义。
 *
 * 现在的形状：
 *   运行中 → 正文下方一块工作过程，头行「工作中 12s · 3 步」，默认展开，逐步出现；
 *   收尾后 → 同一块折成一行「已工作 12s · 3 步」，点开仍是原始步骤（含参数/输出/diff）。
 * 折叠态与展开态是**同一个 DOM**，所以"点开是不是当时那些步骤"不需要再对一次账。
 */

/** 工具名 → 语义分类：图标、动词、以及"这一步到底改了什么" */
const TOOL_KINDS = {
  read: { icon: "read", verb: "读取" },
  write: { icon: "write", verb: "写入" },
  edit: { icon: "edit", verb: "编辑" },
  bash: { icon: "shell", verb: "执行" },
  remember: { icon: "memory", verb: "记住" },
  recall: { icon: "memory", verb: "回忆" },
  set_reminder: { icon: "clock", verb: "提醒" },
  skill: { icon: "skill", verb: "技能" },
  delegate: { icon: "delegate", verb: "派活" },
  propose_project: { icon: "project", verb: "提议项目" },
  // 长期课题（2026-11-07 批二）：提议卡与搜索都进工作过程
  propose_topic: { icon: "project", verb: "提议课题" },
  web_search: { icon: "search", verb: "搜索" },
  partner_manage: { icon: "delegate", verb: "执事" },
  partner_skill_write: { icon: "skill", verb: "执事技能" },
};

/** 线性图标（与界面其余内联 SVG 同做法：无依赖、无构建） */
const TOOL_ICON_PATHS = {
  read: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19"/>',
  write: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  shell: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  memory: '<path d="M12 5a3 3 0 1 0-3 3"/><path d="M12 5a3 3 0 1 1 3 3"/><path d="M9 8h6"/><path d="M6 12h12"/><path d="M7 16h10"/><path d="M9 20h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  skill: '<path d="M12 3l2.2 5.6L20 9.8l-4.4 3.6L17 20l-5-3-5 3 1.4-6.6L4 9.8l5.8-1.2z"/>',
  delegate: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M17 8h4"/><path d="m19 6 2 2-2 2"/>',
  project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  // Lucide search（0.468）：24 视框、2 号描边，与上面同族
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  // 引号气泡：折叠区里"模型说过的话"用（批 32）
  say: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  tool: '<path d="M14.7 6.3a4 4 0 1 0 5 5L21 10l-3-3z"/><path d="m9 15-6 6"/><path d="m14 10-4 4"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  fail: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function toolIcon(kind) {
  const span = document.createElement("span");
  span.className = "wp-icon";
  span.dataset.kind = kind;
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${TOOL_ICON_PATHS[kind] || TOOL_ICON_PATHS.tool}</svg>`;
  return span;
}

/** 派活行的身份 chip：用领域负责人（domain）首字，替掉通用工具图标。 */
function domainChip(domain) {
  const span = document.createElement("span");
  span.className = "wp-domain";
  const label = String(domain || "").trim();
  span.textContent = Array.from(label)[0] || "管";
  if (label) span.title = label;
  return span;
}

function toolKindOf(name) {
  return TOOL_KINDS[name] || { icon: "tool", verb: "" };
}

/** 毫秒 → 「12s」/「1m 05s」/「2h 10m」。低于 1s 给「<1s」，不写 0s 骗人 */
function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  if (total <= 0) return "<1s";
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * 一个工作过程块。调用方持有它，工具事件来时喂 `start` / `end`，
 * 一轮收尾时调 `finish`。历史回读直接 `fromSteps` 造一个已收尾的块。
 */
function createWorkPanel(root) {
  const box = document.createElement("section");
  box.className = "wp";
  box.dataset.open = "1";
  box.dataset.state = "running";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "wp-head";
  head.setAttribute("aria-expanded", "true");

  const chevron = document.createElement("span");
  chevron.className = "wp-chevron";
  chevron.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICON_PATHS.chevron}</svg>`;

  const title = document.createElement("span");
  title.className = "wp-title";
  const meta = document.createElement("span");
  meta.className = "wp-meta";
  head.append(title, meta, chevron);

  const list = document.createElement("div");
  list.className = "wp-steps";

  box.append(head, list);
  // 收尾后整块落在正文下方；运行中也一样——顺序跟真实发生的一致
  root.append(box);

  const startedAt = Date.now();
  /** toolCallId/name → 还没结束的那一行（同名连续调用时按最近一条配对） */
  const open = new Map();
  let stepCount = 0;
  let failed = 0;
  let ticker = 0;

  const paintHead = (finalMs) => {
    const elapsed = finalMs ?? Date.now() - startedAt;
    const state = box.dataset.state;
    const label =
      state === "running" ? "工作中" : state === "interrupted" ? "已中断" : "已工作";
    title.textContent = elapsed >= 1000 || state !== "running"
      ? `${label} ${shortDuration(elapsed) || "<1s"}`
      : label;
    const bits = [`${stepCount} 步`];
    if (failed > 0) bits.push(`${failed} 步失败`);
    meta.textContent = stepCount > 0 ? bits.join(" · ") : "";
  };

  const setOpen = (value) => {
    box.dataset.open = value ? "1" : "0";
    head.setAttribute("aria-expanded", String(value));
  };

  head.addEventListener("click", () => setOpen(box.dataset.open !== "1"));

  const startTicker = () => {
    if (ticker) return;
    ticker = setInterval(() => paintHead(), 1000);
  };
  const stopTicker = () => {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = 0;
  };

  paintHead();
  startTicker();

  return {
    root: box,
    /** 工具开始：立刻出现一行「执行 正在运行」，参数折叠在这一行里 */
    start(name, label, args) {
      const kind = toolKindOf(name);
      const row = document.createElement("div");
      row.className = "wp-step";
      row.dataset.state = "run";
      row.dataset.tool = name;

      const dot = document.createElement("span");
      dot.className = "wp-status";
      const verb = document.createElement("span");
      verb.className = "wp-verb";
      verb.textContent = kind.verb || name;
      const nameEl = document.createElement("span");
      nameEl.className = "wp-name";
      nameEl.textContent = kind.verb ? name : "";
      if (!kind.verb) nameEl.hidden = true;
      const labelEl = document.createElement("span");
      labelEl.className = "wp-label";
      labelEl.textContent = label || "";
      labelEl.title = label || "";
      if (!label) labelEl.hidden = true;

      const line = document.createElement("div");
      line.className = "wp-line";
      line.append(toolIcon(kind.icon), dot, verb, nameEl, labelEl);

      row.append(line);
      if (args) addStepBlock(row, "参数", args);
      list.append(row);
      if (open.has(name)) open.get(name).push(row);
      else open.set(name, [row]);
      stepCount += 1;
      paintHead();
      return row;
    },
    /**
     * 一句"说过的话"进折叠区（2026-11-10 批 32，对齐 ZCode：只留结尾正文）。
     *
     * 模型一轮里会先说话再动工具（"我先看看这个文件…"），这些中间话以前全堆在
     * 正文里；现在工具一动手，之前的话就折进来当一行「说」，点开看原文。
     * 状态恒为 ok（话说完就是说完，没有成败语义）；label 摘首行，正文进展开块。
     */
    say(text) {
      const one = String(text || "").trim();
      if (!one) return;
      const row = document.createElement("div");
      row.className = "wp-step wp-say";
      row.dataset.state = "ok";

      const dot = document.createElement("span");
      dot.className = "wp-status";
      const verb = document.createElement("span");
      verb.className = "wp-verb";
      verb.textContent = "说";
      const firstLine = one.split("\n").find((line) => line.trim()) || one;
      const labelEl = document.createElement("span");
      labelEl.className = "wp-label";
      labelEl.textContent = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
      labelEl.title = firstLine;

      const line = document.createElement("div");
      line.className = "wp-line";
      line.append(toolIcon("say"), dot, verb, labelEl);

      row.append(line);
      addStepBlock(row, "原文", one, "md");
      list.append(row);
      stepCount += 1;
      paintHead();
    },
    /** 工具结束：定成败、补输出（有 diff 就优先画 diff，比"Successfully replaced…"有用） */
    end(name, ok, output, diff) {
      const queue = open.get(name);
      const row = queue?.shift();
      if (!row) return;
      if (queue && queue.length === 0) open.delete(name);
      row.dataset.state = ok ? "ok" : "err";
      if (!ok) failed += 1;
      if (diff) addStepBlock(row, "改动", diff, "diff");
      if (output) addStepBlock(row, "输出", output);
      paintHead();
    },
    /**
     * 派活这类"后台长任务"的行（2026-11-07 修）：**不进** open 队列。
     * 原因：delegate 的进度帧由 chancellor 的事件来，终态帧（done / needs_you /
     * aborted / failed）经常晚于本轮收尾——进了 open 队列就会被 `finish` 判成
     * 「没等到结果」记一步失败，成功派活也报「N 步失败」，是谎报。
     * 所以行建出来后由调用方喂 `setLabel` / `close`，一轮收尾还没 close 的走 `handoff`。
     */
    track(label) {
      const kind = toolKindOf("delegate");
      const row = document.createElement("div");
      row.className = "wp-step";
      row.dataset.state = "run";
      row.dataset.tool = "delegate";

      const dot = document.createElement("span");
      dot.className = "wp-status";
      const verb = document.createElement("span");
      verb.className = "wp-verb";
      verb.textContent = kind.verb || "delegate";
      const labelEl = document.createElement("span");
      labelEl.className = "wp-label";
      labelEl.textContent = label || "";
      labelEl.title = label || "";
      if (!label) labelEl.hidden = true;

      const line = document.createElement("div");
      line.className = "wp-line";
      line.append(toolIcon(kind.icon), dot, verb, labelEl);

      row.append(line);
      list.append(row);
      stepCount += 1;
      paintHead();
      return {
        row,
        setLabel(text) {
          labelEl.textContent = text || "";
          labelEl.title = text || "";
          labelEl.hidden = !text;
        },
        /** 终态帧到了：定成败、补一句说明（chancellor 的 message 就是给人看的那个） */
        close(ok, output) {
          if (row.dataset.state !== "run") return;
          row.dataset.state = ok ? "ok" : "err";
          if (!ok) failed += 1;
          if (output) addStepBlock(row, "输出", output);
          paintHead();
        },
        /** 轮收尾还没等到终态：chancellor 在后台继续跑，画「已转后台」而不是失败 */
        handoff() {
          if (row.dataset.state !== "run") return;
          row.dataset.state = "back";
          addStepBlock(row, "输出", "派单已受理，还在后台继续跑；进度看任务中心。");
          paintHead();
        },
      };
    },
    /** 历史/权威时长覆盖本地表（服务端 workMs 是事实源，本地表只是现场估的） */
    setDuration(ms) {
      stopTicker();
      paintHead(ms);
    },
    /** 一轮收尾：停表、定格标题、默认折起来（人已经看过过程了，结论才是重点） */
    finish(outcome = "completed") {
      stopTicker();
      for (const queue of open.values()) {
        // 没等到结果的（中断 / 崩溃）不能画成成功
        for (const row of queue) {
          row.dataset.state = "err";
          failed += 1;
        }
      }
      open.clear();
      box.dataset.state = outcome;
      paintHead();
      if (stepCount === 0) {
        box.remove();
        return;
      }
      setOpen(false);
    },
  };
}

/**
 * 行内展开块：参数 / 输出 / diff 都塞在同一个可折叠区里，
 * 点开哪一块就只看那一块（选字不收起，与旧 addActBlock 同口径）。
 */

export { TOOL_ICON_PATHS, TOOL_KINDS, createWorkPanel, domainChip, shortDuration, toolIcon, toolKindOf };
