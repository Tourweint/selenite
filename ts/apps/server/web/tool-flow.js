/**
 * 工具执行流：话 → 灰块 → 话 → 灰块
 *
 * 2026-11-13 用户拍板 E1 方案，替换原「工作过程面板」（旧 work-panel.js 已删）。
 *
 * 形状：模型说一句、动一次手、再说一句。说出来的话留在正文，动手缩成一枚小灰块。
 * 主界面**不写"几步/几秒"**；步数、耗时、命令、输出、diff 全在点击后的详情里。
 * 细节形态（原地展开 / 附近小窗）由 `tool-chips.js` 按设置决定，默认内联。
 *
 * 两个元素把一轮串起来：
 * - `.body`：每一段话一个正文段（streamView 绑一段，说完就换下一段）；
 * - `.tchips`：一组灰块（一次连续动手 = 一组），插在两段话之间。
 * 收尾后它们按真实顺序留在消息里，不再折成一行。
 */

import { renderMarkdown } from "./markdown.js";
import { createToolChips } from "./tool-chips.js";
import { TOOL_ICON_PATHS, shortDuration, toolKindOf } from "./tool-meta.js";

/** 工具图标的内联 SVG（灰块和详情标题共用一套） */
function toolIconSvg(kind) {
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${TOOL_ICON_PATHS[kind] || TOOL_ICON_PATHS.tool}</svg>`
  );
}

/** +A/−M 摘要（和文件汇总卡同一口径：只数改文件的行） */
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
 * 一轮里的工具流。调用方：
 * - `start(name, label, args)` 工具开始；
 * - `end(name, ok, output, diff)` 工具结束；
 * - `breakGroup()` 这段话结束、下一组另起（工具动手前调）；
 * - `track(label, domain)` 派活；
 * - `finish()` 一轮收尾。
 */
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
    start(name, label, args) {
      const kind = toolKindOf(name);
      ensureGroup().push({
        id: name,
        verb: kind.verb || name,
        target: label || "",
        iconSvg: toolIconSvg(kind.icon),
        args,
        state: "run",
      });
      stepCount += 1;
      return group;
    },
    /**
     * 思考段（2026-11-17 用户口径：和工具同款灰块）。
     * 排在它真正发生的位置（通常是一组里最前面），图标 sparkles、动词「思考」；
     * 正文进详情（限高、内部滚动），主界面照样不写秒数。
     * 返回句柄：`append(增量)` 追加正文，`finish()` 定格并补「用时」。
     */
    think() {
      const id = `think:${stepCount}`;
      stepCount += 1;
      // 定格要落到**创建它的那一组**上：中间被 breakGroup 切走也不能丢了终态。
      const owner = ensureGroup();
      const chip = owner.push({
        id,
        verb: "思考",
        iconSvg: toolIconSvg("think"),
        state: "run",
        kind: "think",
      });
      const startedAt = performance.now();
      let text = "";
      return {
        append(delta) {
          text += delta || "";
          chip.__streamText?.(text);
        },
        finish() {
          owner.settle(id, {
            state: "ok",
            output: text,
            duration: shortDuration(performance.now() - startedAt),
          });
        },
      };
    },
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
    /** 一段话结束（工具要动手了）：这组灰块封口，下一段话接在它们后面。 */
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
        iconSvg: toolIconSvg(kind.icon),
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
    finish() {
      group?.finish();
      group = null;
    },
    get count() {
      return stepCount;
    },
  };
}

/**
 * 历史回读：把服务端下发的一轮 steps 还原成同一形状——
 * 「说」是正文段，工具是灰块，按真实顺序插在最终回答之前。
 */
function toolFlowFromSteps(root, steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const flow = document.createElement("div");
  flow.className = "flow";
  const body = root.querySelector(":scope > .body");
  if (body) root.insertBefore(flow, body);
  else root.append(flow);
  root.classList.add("has-flow");

  // 每组工具一块自己的 .tchips：中间夹了「说」就另起一组，顺序才是真实的
  // "话 → 块 → 话 → 块"。只用一个实例会把第二组块也塞回第一组里。
  let chips = null;
  const segment = (text) => {
    if (chips) {
      chips.finish();
      chips = null;
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
    if (!chips) chips = createToolChips(flow, { live: false });
    const kind = toolKindOf(step.name);
    chips.push({
      id: step.name,
      verb: kind.verb || step.name,
      target: step.label || "",
      iconSvg: toolIconSvg(kind.icon),
      args: step.args,
      state: step.ok === false ? "err" : "ok",
      output: step.output,
      diff: step.diff,
      diffSummary: step.diff ? diffSummaryOf(step.diff) : "",
      duration: typeof step.ms === "number" ? shortDuration(step.ms) : "",
    });
  }
  chips?.finish();
  // 最终回答那段 body 移到 flow 末尾，保持"话在块后"的顺序
  if (body) flow.append(body);
  return flow;
}

export { createToolFlow, diffSummaryOf, toolFlowFromSteps };
