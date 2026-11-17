import fs from "node:fs";
import path from "node:path";
import type { EmployeeTask } from "./index.ts";

/**
 * 外部 CLI 执行的统一任务书：优先读 dispatch 写好的 TASK.md，
 * 目录被外部改过时按接口字段兜底。
 *
 * 2026-11-03 从 mercenary.ts 抽出：CodeBuddy 与 qoder 必须拿到同一份契约，
 * 否则两个后端的验收口径会慢慢漂开。
 */
export function readTaskPrompt(task: EmployeeTask): string {
  const raw = readTextOrNull(path.join(task.dir, "TASK.md"));
  if (raw !== null) return raw;
  return [
    "# TASK",
    "",
    "## 任务",
    task.instruction,
    "",
    "## 完成标准（done_when）",
    task.doneWhen,
    ...(task.upstream ? ["", "## 前置任务结果", task.upstream] : []),
    "",
    "## 交付契约（硬性要求）",
    "干完后必须在当前目录写 REPORT.md，第一个 ```json 块是：",
    '{"status":"ready|waiting|blocked|failed|dropped","summary":"一句话","artifacts":["相对路径"],"attention":{"question":"...","kind":"need_input|need_decision|need_action"}}',
    "status 是最终结论；需要人回答/拍板/动手时用 blocked + attention；progress 不能作为最终结论。",
    "写完必须用 read 把 artifacts 里每个文件读回来，确认存在且内容对；没读到不许写 ready。",
    "done_when 指定的文件名、格式、条数照抄，不要自己改名。",
  ].join("\n");
}

/**
 * 外部 CLI 续跑提示，两种形态（批 10-B 简化）。
 *
 * - 真续接（有会话号，CLI 带 `-r`）：旧会话里已经有整份任务书和交付契约，
 *   这里只递人的回答。再塞任务回顾/纪律段就是第二份任务书，跟会话里的
 *   TASK.md 抢解释权（批 10 拍板的口径）。
 * - 重派（没有会话号，上一段接不上）：必须给整份 TASK.md，人的回答也不能丢，
 *   否则 worker 既没有任务书也不知道人改了什么主意。
 */
export function buildResumePrompt(
  task: EmployeeTask,
  answer: string,
  sessionId: string | null | undefined,
): string {
  if (sessionId) return `用户回复：${answer}`;
  return [readTaskPrompt(task), "", "## 人对你上一个问题的回答", answer].join("\n");
}

function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
