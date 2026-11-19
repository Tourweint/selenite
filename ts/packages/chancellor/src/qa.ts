/**
 * 质检 worker（2026-11-19 批2，方案 §4：用户拍板"提示词实现，不写代码"）。
 *
 * 质检方式二选一：`internal`（现状：chancellor 内部一次纯文本 LLM 请求做验收，
 * review.ts 的 askInternal 路径）与 `qa-worker`（worker 自报完成后，以
 * `templates/qa.md` 为模板**再派一单**，走既有派单器 runChancellor）。
 *
 * 分支本身在 review.ts（原来调内部请求的地方）；本模块放三样东西：
 * - `qaWorkerMode()` / `qaRunner` 注入缝：跑真派单的实现在宿主侧（服务端有
 *   startDelegation / 会话设施，chancellor 是纯库）——与 judge 的注入方向同一刀；
 * - `buildQaRequirement`：模板 + 任务材料 → 派单 requirement（纯函数，单测直喂）；
 * - `parseQaConclusion`：质检工人的结论行解析（DONE / CONTINUE / BLOCKED，纯函数）。
 *
 * 刻意不做：质检单的持久化状态机、质检结果台账（结论落在 review.json 的 reason 里，
 * 现有验收投影原样带出来）；质检单自己的验收**不走质检**（宿主注入实现时自带防递归）。
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { TaskRun, Ticket, Verdict } from "./types.ts";

const QA_TEMPLATE_PATH = fileURLToPath(new URL("./templates/qa.md", import.meta.url));

/** 质检方式（派活设置「质检方式」，落 `.data/executor.json` 的 `qa` 字段）。 */
export type QaMode = "internal" | "qa-worker";

/**
 * env 缺省（`CHANCELLOR_QA_MODE`）；派活设置的文件值由宿主放进 ChancellorRequest，
 * env 只在没走设置文件时兜底。认不出的值按 internal（不静默启用新形态）。
 */
export function qaModeFromEnv(env: NodeJS.ProcessEnv = process.env): QaMode {
  const raw = env.CHANCELLOR_QA_MODE?.trim().toLowerCase();
  return raw === "qa-worker" ? "qa-worker" : "internal";
}

/**
 * 质检派单的实现缝（宿主注入，与 ChancellorOptions.judge 同方向）。
 * 输入 = 派单 requirement；输出 = 质检工人的结论行原文（解析由 parseQaConclusion 做）。
 * 实现方负责：真派单、等终态、防递归（质检单自己的验收不走质检）。
 */
export type QaRunner = (requirement: string) => Promise<string>;

let runner: QaRunner | null = null;

/** 宿主装配时注入（index.ts 启动段）；传 null = 卸载（回滚形态）。 */
export function setQaRunner(fn: QaRunner | null): void {
  runner = fn;
}

/** 质检派单实现是否可用（review.ts 的分支判定用）。 */
export function qaRunnerAvailable(): boolean {
  return runner !== null;
}

/** 调质检派单；没注入时抛错——调用方必须先过 qaRunnerAvailable()。 */
export async function runQaTicket(requirement: string): Promise<string> {
  if (!runner) throw new Error("qa runner 未注入（质检 worker 形态需要宿主装配）");
  return runner(requirement);
}

/** 模板占位符 → 值（只替换本批登记的七个；其余原样保留）。 */
const QA_PLACEHOLDERS = [
  "TICKET_ID",
  "SEQ",
  "TOTAL",
  "TITLE",
  "INSTRUCTION",
  "DONE_WHEN",
  "WORK_DIR",
  "TASK_DIR",
  "ARTIFACTS",
] as const;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 模板 + 任务材料 → 派单 requirement。模板缺失（打包裁掉了 templates/）→ 抛错：
 * 派不出"可编辑的质检任务书"就不该悄悄退回内部请求（fail-visible）。
 */
export function buildQaRequirement(input: {
  run: TaskRun;
  ticket: Ticket;
  total: number;
}): string {
  const template = fs.readFileSync(QA_TEMPLATE_PATH, "utf8");
  const report = input.run.report;
  const values: Record<(typeof QA_PLACEHOLDERS)[number], string> = {
    TICKET_ID: input.ticket.id,
    SEQ: String(input.run.seq),
    TOTAL: String(input.total),
    TITLE: oneLine(input.run.task.title),
    INSTRUCTION: clip(oneLine(input.run.task.instruction), 600),
    DONE_WHEN: clip(oneLine(input.run.task.done_when), 300),
    WORK_DIR: input.run.workDir ?? input.run.dir,
    TASK_DIR: input.run.dir,
    ARTIFACTS:
      report && report.artifacts.length > 0
        ? report.artifacts.slice(0, 10).join("、")
        : "（未列出）",
  };
  let out = template;
  for (const key of QA_PLACEHOLDERS) {
    out = out.split(`{${key}}`).join(values[key]);
  }
  return out;
}

export type QaConclusion =
  | { verdict: "pass"; reason: string }
  | { verdict: "fail"; reason: string }
  | { verdict: "blocked"; reason: string };

/**
 * 从质检工人的结论行解析验收判定。只认模板规定的前缀（允许全半角冒号）：
 * DONE / CONTINUE / BLOCKED。找不到结论行 → null（调用方按"没给出结论"处理，
 * 判 blocked 交人——质检自身不可用时不该冒充验收通过）。
 *
 * 扫描顺序：先解 REPORT 的第一个 ```json 块、在 summary 里找结论行（模板口径：
 * summary 以结论行结尾）；json 解析不出再整段文本逐行扫（worker 把结论写成
 * 独立一行的回执也认）。两种口径都取**最后一个**匹配（结论行在结尾）。
 */
export function parseQaConclusion(line: string | null | undefined): QaConclusion | null {
  if (!line) return null;
  const block = /```json\s*([\s\S]*?)```/i.exec(line);
  if (block && block[1] !== undefined) {
    try {
      const data = JSON.parse(block[1]) as { summary?: unknown };
      if (typeof data.summary === "string") {
        const fromSummary = scanConclusionLines(data.summary);
        if (fromSummary) return fromSummary;
      }
    } catch {
      // 坏 json：走整段扫描，不在解析上多较劲。
    }
  }
  return scanConclusionLines(line);
}

function scanConclusionLines(text: string): QaConclusion | null {
  // `\\n` 兜底：summary 被 json 转义成一行时（json 块没解开），真实换行是字面 \n。
  for (const raw of text.split(/\r?\n|\\n/).reverse()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const match = /^(DONE|CONTINUE|BLOCKED)\s*[：:]\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const verdict: Verdict =
      match[1] === "DONE" ? "pass" : match[1] === "CONTINUE" ? "fail" : "blocked";
    const reason =
      (match[2] ?? "").trim() || (match[1] === "DONE" ? "质检工人确认达成" : "质检未给出原因");
    return { verdict, reason: `质检 worker：${reason}` };
  }
  return null;
}
