/**
 * 工具执行流与 diff 摘要
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { esc, renderMarkdown } from "./markdown.js";
import { createToolChips } from "./tool-chips.js";
import { TOOL_ICON_PATHS, createWorkPanel, shortDuration, toolKindOf } from "./work-panel.js";

function addStepBlock(row, label, text, kind = "pre") {
  row.classList.add("has-detail");
  let body = row.querySelector(".wp-detail");
  if (!body) {
    body = document.createElement("div");
    body.className = "wp-detail";
    row.append(body);
  }
  const block = document.createElement("div");
  block.className = "wp-block";
  const tag = document.createElement("span");
  tag.className = "wp-block-tag";
  tag.textContent = label;
  const pre = document.createElement("pre");
  pre.className = kind === "diff" ? "wp-pre wp-pre-diff" : "wp-pre";
  if (kind === "diff") pre.innerHTML = paintDiff(text);
  else pre.textContent = text;
  // 说过的话按 markdown 渲染（批 32）：那是模型写给**人**看的正文，pre 会把
  // 列表/加粗全变成星号字。wp-pre-md 才是它的样式档。
  if (kind === "md") {
    pre.classList.add("wp-pre-md");
    pre.innerHTML = renderMarkdown(text);
  }
  pre.addEventListener("click", (event) => event.stopPropagation());
  block.append(tag, pre);
  body.append(block);
  body.hidden = false;
}

/** diff 逐行染色：+新增 / -删除 / …上下文。文本本身不是 HTML，先转义再上色 */
function paintDiff(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const cls = line.startsWith("+") ? "d-add" : line.startsWith("-") ? "d-del" : "";
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    })
    .join(String.fromCharCode(10));
}

/** 历史回读：把服务端下发的一轮 steps 还原成同一块（已收尾、默认折叠） */
function workPanelFromSteps(root, steps, workMs) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const panel = createWorkPanel(root);
  for (const step of steps) {
    // 「说」步（2026-11-10 批 32）：历史里的中间话还原成与现场同一行。
    // 现场是 answer 累积后折走，历史是服务端从带工具回合里捞出来——两边同形。
    if (step.name === "say" && step.format === "md") {
      panel.say(step.output || "");
      continue;
    }
    panel.start(step.name, step.label, undefined);
    panel.end(step.name, step.ok !== false, step.output, step.diff);
  }
  panel.finish("completed");
  // 时长以服务端事实为准（现场那块是本地表；历史里没有"正在跑"，直接用落库值）
  if (typeof workMs === "number" && workMs > 0) panel.setDuration(workMs);
  return panel;
}

/**
 * 一轮工具执行 = 一串小灰块（2026-11-13 用户拍板 E1 方案）。
 *
 * 形状：话是正文，工具是灰块，二者交替出现——模型说一句、动一次手、再说一句。
 * 主界面**不写"几步/几秒"**；步数、耗时、命令、输出、diff 全在点击后的详情里。
 * 细节形态（内联展开 / 附近小窗）由 `tool-chips.js` 按设置决定，默认内联。
 *
 * 用两个元素把一轮串起来：
 * - `body.seg`：每一段话一个正文段（streamView 绑一段，说完就换下一段）；
 * - `.tchips`：一组灰块（一次连续动手 = 一组），插在两段话之间。
 * 收尾后它们按真实顺序留在消息里，不再折成一行。
 */

/** 一轮里的工具流：按"话 → 灰块 → 话 → 灰块"依次落 DOM。 */
function createToolFlow(root, options = {}) {
  const live = options.live === true;
  let group = null; // 当前这组灰块（createToolChips 的实例）
  let stepCount = 0;

  const ensureGroup = () => {
    if (!group) group = createToolChips(root, { live });
    return group;
  };

  return {
    root,
    /** 工具开始：建组（若尚未建）并推一枚运行中的块。 */
    start(name, label, args) {
      const kind = toolKindOf(name);
      ensureGroup().push({
        id: name,
        verb: kind.verb || name,
        target: label || "",
        iconSvg:
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
          `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
          `${TOOL_ICON_PATHS[kind.icon] || TOOL_ICON_PATHS.tool}</svg>`,
        args,
        state: "run",
      });
      stepCount += 1;
      return group;
    },
    /** 工具结束：定状态、补输出/diff/耗时。 */
    end(name, ok, output, diff) {
      if (!group) return;
      const duration = group.durationOf?.(name);
      group.settle(name, {
        state: ok ? "ok" : "err",
        output,
        diff,
        diffSummary: diff ? diffSummaryOf(diff) : "",
        duration: duration ? shortDuration(duration) : "",
      });
    },
    /**
     * 一段话结束（工具要动手了）：这组灰块已经落在这里，下一段话要接在它们后面。
     * 调用方负责在新正文段里继续写；这里只把当前组封口，下一枚块另起一组。
     */
    breakGroup() {
      group?.finish();
      group = null;
    },
    /** 派活这类后台长任务：也是一枚块，标签随进度帧更新。 */
    track(label, domain) {
      const kind = toolKindOf("delegate");
      const chip = ensureGroup().push({
        id: `delegate:${stepCount}`,
        verb: kind.verb || "派活",
        target: domain ? `${domain} · ${label || ""}`.trim() : label || "",
        iconSvg:
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
          `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
          `${TOOL_ICON_PATHS[kind.icon] || TOOL_ICON_PATHS.tool}</svg>`,
        args: label,
        state: "run",
      });
      stepCount += 1;
      return {
        row: chip,
        setLabel(text) {
          chip.__setTarget?.(text || "");
        },
        close(ok, output) {
          chip.__setState?.(ok ? "ok" : "err");
          chip.__setDetail?.({ output });
        },
        handoff() {
          chip.__setState?.("back");
          chip.__setDetail?.({ output: "派单已受理，还在后台继续跑；进度看任务中心。" });
        },
      };
    },
    /** 一轮收尾：还开着的详情关掉，块留在原地（不再折成一行）。 */
    finish() {
      group?.finish();
      group = null;
    },
    setDuration() {
      /* 不再显示"已工作 Ns · M 步"：总时长由消息脚注承担 */
    },
    get count() {
      return stepCount;
    },
  };
}

/** +A/-M 摘要（和文件汇总卡同一口径：只数改文件的行） */
function diffSummaryOf(diff) {
  let add = 0;
  let del = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  if (!add && !del) return "";
  return `+${add} −${del}`;
}

/**
 * 历史回读：把服务端下发的一轮 steps 还原成同一形状——
 * 「说」是正文段，工具是灰块，按真实顺序插在最终回答之前。
 */
function toolFlowFromSteps(root, steps, workMs) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const flow = document.createElement("div");
  flow.className = "flow";
  const body = root.querySelector(":scope > .body");
  if (body) root.insertBefore(flow, body);
  else root.append(flow);
  root.classList.add("has-flow");

  const chips = createToolChips(flow, { live: false });
  let groupOpen = false;
  const segment = (text) => {
    if (chips && groupOpen) {
      chips.finish();
      groupOpen = false;
    }
    const seg = document.createElement("div");
    seg.className = "body";
    seg.innerHTML = renderMarkdown(text);
    flow.append(seg);
  };

  for (const step of steps) {
    if (step.name === "say" && step.format === "md") {
      segment(step.output || "");
      continue;
    }
    const kind = toolKindOf(step.name);
    chips.push({
      id: step.name,
      verb: kind.verb || step.name,
      target: step.label || "",
      iconSvg:
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
        `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `${TOOL_ICON_PATHS[kind.icon] || TOOL_ICON_PATHS.tool}</svg>`,
      args: step.args,
      state: step.ok === false ? "err" : "ok",
      output: step.output,
      diff: step.diff,
      diffSummary: step.diff ? diffSummaryOf(step.diff) : "",
      duration: typeof step.ms === "number" ? shortDuration(step.ms) : "",
    });
    groupOpen = true;
  }
  chips.finish();
  // 最终回答那段 body 移到 flow 末尾，保持"话在块后"的顺序
  if (body) flow.append(body);
  return { flow, workMs };
}

export { addStepBlock, createToolFlow, diffSummaryOf, paintDiff, toolFlowFromSteps, workPanelFromSteps };
