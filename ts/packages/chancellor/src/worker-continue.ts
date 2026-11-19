/**
 * 自主续行的决策逻辑（2026-11-19 批2）。
 *
 * worker-main 的主循环在"没有未收尾提交、也没有等上报"时会问这里：还接不接下一段
 * 续轮？规则全部落成纯函数，单测直接喂——真正的 submit / 留在 worker-main。
 *
 * 口径（方案 §3 + 批2 任务书）：
 * - 触发：REPORT.md **非终态**（waiting / progress / 没写 / 解析不出都算"还想干"）
 *   且预算（`WORKER_TURN_BUDGET`，默认 3，0=关）还有余量；
 * - 无进展保险丝：**连续 3 个续行轮没有一次工具调用** → 停止续行，REPORT 改 blocked
 *   并正常退场（不外抛、不杀进程，worker 照常写完收尾）；
 * - 上报等待中（escalation 已发出未答）不武装续轮、也不退场——这由 worker-main 的
 *   等待分支处理，不进本判定。
 *
 * 终态口径：ready（含老 done，读法与 dispatch.parseWorkerReport 一致）/ failed /
 * dropped / blocked 是终态——worker 已经给出"不用再干"或"要人"的结论；
 * waiting = "这轮干完还差东西"，progress = 只报了进度，都算还要干。
 */

import fs from "node:fs";
import path from "node:path";

/** REPORT.md 里的状态读到这些 = 不用再续。 */
export const CONTINUE_TERMINAL_STATUSES = new Set(["ready", "failed", "dropped", "blocked"]);

/** 保险丝阈值（抄方案：连续 3 个续行轮零工具调用）。 */
export const NO_PROGRESS_FUSE = 3;

/** 续行的决定。stop 时带 reason，worker-main 据此写一行日志（不含任务内容）。 */
export type ContinuationDecision =
  | { kind: "arm" }
  | { kind: "stop"; reason: "off" | "budget" | "terminal" | "fuse" };

export interface ContinuationInput {
  /** REPORT.md 里解析出的 status；null = 没写 / 解析不出（当"还想干"）。 */
  reportStatus: string | null;
  /** 已经用掉的续轮数（0 = 初始 turn 刚收尾）。 */
  usedBudget: number;
  /** 预算上限（workerTurnBudget() 的读数；0 = 关）。 */
  maxBudget: number;
  /** 到目前为止连续多少个续行轮零工具调用。 */
  noProgressStreak: number;
}

/**
 * 一轮收尾后接不接续轮。纯函数：先看保险丝（这一轮刚零调用、连击到 3 → 停），
 * 再看预算与 REPORT 状态。
 */
export function planNextRound(input: ContinuationInput): ContinuationDecision {
  if (input.noProgressStreak >= NO_PROGRESS_FUSE) return { kind: "stop", reason: "fuse" };
  if (input.maxBudget <= 0) return { kind: "stop", reason: "off" };
  if (input.usedBudget >= input.maxBudget) return { kind: "stop", reason: "budget" };
  if (input.reportStatus !== null && CONTINUE_TERMINAL_STATUSES.has(input.reportStatus)) {
    return { kind: "stop", reason: "terminal" };
  }
  return { kind: "arm" };
}

/**
 * 一轮保险丝判定（续轮收尾后调）：零工具调用 → 连击 +1，有调用 → 清零。
 * 与 planNextRound 分开：连击的记账发生在"这一轮跑完"，而 planNextRound 读的是账。
 */
export function nextNoProgressStreak(previous: number, toolCallsThisRound: number): number {
  return toolCallsThisRound > 0 ? 0 : previous + 1;
}

/**
 * 续行输入（followUp 提交的正文）。第一行 `[续行]` 标记：模型与历史都据此认出
 * 这是预算内自动接轮（与批1 的 `[插话]` 同一套约定），前端将来可以同款剥标。
 * "已完成 X、剩余 Y" 由 worker 自己盘点（它有 REPORT.md 与工作目录），
 * 这里只给上一轮汇报的一句话做锚点，不替它编数字。
 */
export function buildContinueInput(round: number, lastSummary: string | null): string {
  const anchor = lastSummary ? `上一轮汇报：${lastSummary}` : "上一轮没有留下汇报摘要";
  return [
    "[续行]",
    `预算内自动接轮（第 ${round} 段续轮）。继续按 TASK.md 推进：`,
    `- ${anchor}`,
    "- 先对照工作目录与 REPORT.md 盘点已完成的部分（X）与剩余的事（Y），",
    "  然后把剩余的事做完；全部完成时把 REPORT.md 更新为终态结论。",
    "- 没有可推进的事就如实更新 REPORT.md（waiting=还要等 / blocked=需要人），不要空转。",
  ].join("\n");
}

/**
 * 保险丝触发后的 REPORT 处置：把第一个 ```json 块里的 status 改成 blocked
 * （保留其余字段——summary / artifacts / attention 都不动），并在文末追加一行
 * 系统注记。REPORT 不存在 / 没有 json 块时只追加注记，不伪造结构。
 * 返回是否真的改写了 status（宿主验收读到 blocked → needs_you，走"需要人"老通道）。
 */
export function markReportBlocked(
  taskDir: string,
  note: string,
  raw?: string | null,
): boolean {
  const file = path.join(taskDir, "REPORT.md");
  let original: string;
  if (raw !== undefined && raw !== null) {
    original = raw;
  } else {
    try {
      original = fs.readFileSync(file, "utf8");
    } catch {
      original = "";
    }
  }
  const stamped = `${original.trimEnd()}${original.trim() ? "\n\n" : ""}> [系统] ${note}\n`;
  let out = stamped;
  let rewrote = false;
  const block = /```json\s*([\s\S]*?)```/i.exec(original);
  if (block && block[1] !== undefined) {
    const updated = block[1].replace(/"status"\s*:\s*"(ready|waiting|progress)"/, (_m, _s) => {
      rewrote = true;
      return '"status": "blocked"';
    });
    if (rewrote) {
      out = stamped.replace(block[0], `\`\`\`json${updated}\`\`\``);
    }
  }
  try {
    fs.writeFileSync(file, out, "utf8");
  } catch {
    // 写不进去就不写了：worker 主进程照常退场，宿主验收按原 REPORT 结论走。
    return false;
  }
  return rewrote;
}

/**
 * 统计一段 durable 消息里的工具调用次数（保险丝的"本轮有没有动手"）。
 * 只认 `toolResult` 角色条目——工具一定有回执，回执数 ≈ 调用数（同轮内重复
 * 提交也不会虚增：回执只属于真实发生的调用）。
 */
export function countToolCallsSince(
  messages: readonly { role?: unknown }[],
  fromIndex: number,
): number {
  let count = 0;
  for (let index = Math.max(0, fromIndex); index < messages.length; index += 1) {
    if (messages[index]?.role === "toolResult") count += 1;
  }
  return count;
}
