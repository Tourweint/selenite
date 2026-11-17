import type { Review, TaskRun } from "./types.ts";

/** 一行汇报里不允许出现换行和绝对路径。 */
export function sanitizeLine(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const withoutPaths = collapsed.replace(/[A-Za-z]:[\\/][^\s，。；、）)]*/g, "（某文件）");
  return withoutPaths.length > max ? `${withoutPaths.slice(0, max)}…` : withoutPaths;
}

export interface LineInput {
  total: number;
  reviews: Review[];
}

/** 截断并去掉句尾标点，避免和模板自带的句号叠成「。。」。 */
function clean(text: string, max: number): string {
  return sanitizeLine(text, max).replace(/[。；;，,\s]+$/u, "");
}

export function renderResultLine(input: LineInput): string {
  const failed = input.reviews.filter((review) => review.verdict !== "pass");
  const passed = input.reviews.length - failed.length;

  if (failed.length === 0 && input.reviews.length === input.total && input.total > 0) {
    const summary = input.reviews
      .map((review) => clean(review.reason, 80))
      .filter(Boolean)
      .join("；");
    return `✓ ${passed}/${input.total} 过。${summary ? `${summary}。` : "全部完成。"}`;
  }

  const stuck = failed
    .slice(0, 3)
    .map(
      (review) =>
        `[${String(review.seq).padStart(2, "0")}-${review.slug}]：${clean(review.reason, 80)}`,
    )
    .join("；");
  // 只有「核对器没给出结论」这种 blocked 才用 ⚠ 提醒人看；worker 自己卡住仍按原来的 ✗。
  const hasHardFail = failed.some((review) => review.verdict === "fail");
  const hasCheckerAnomaly = failed.some(
    (review) => review.verdict === "blocked" && review.stage === "llm",
  );
  const mark = passed > 0 || (!hasHardFail && hasCheckerAnomaly) ? "⚠" : "✗";
  return `${mark} ${passed}/${input.total} 过。卡在 ${stuck || "未知原因"}。`;
}

function runTag(run: TaskRun): string {
  return `[${String(run.seq).padStart(2, "0")}-${run.task.slug}]`;
}

/**
 * attention 的 question 要保留原文（包括用户给的路径），所以不套 sanitizeLine。
 * 只塌掉换行、限长，保证仍然是一行。
 */
function collapseQuestion(text: string, max = 220): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** 有 attention 时，汇报行直接说清「我在等你什么」。 */
export function renderAttentionLine(runs: TaskRun[]): string {
  const asking = runs.filter(
    (run) => run.report?.status === "blocked" && run.report.attention,
  );
  const first = asking[0]?.report?.attention;
  if (!first) {
    const detail = runs
      .slice(0, 3)
      .map((run) => `${runTag(run)}：${clean(run.report?.summary ?? "worker 报告 blocked", 80)}`)
      .join("；");
    return `✗ 卡在 ${detail || "未知原因"}。`;
  }
  const extra = asking.length > 1 ? `（另有 ${asking.length - 1} 个问题待回答）` : "";
  return `⚠ 需要你：${collapseQuestion(first.question)}${extra}`;
}

/** waiting 是「干完一轮，等下一个触发」，不验收也不核对。 */
export function renderIdleLine(runs: TaskRun[]): string {
  const waiting = runs.filter((run) => run.report?.status === "waiting");
  const detail = waiting
    .slice(0, 3)
    .map((run) => `${runTag(run)}：${clean(run.report?.summary ?? "等下一个触发", 80)}`)
    .join("；");
  return `⏸ 干完一轮，等下一个触发：${detail || "依赖还没满足"}。`;
}

/** dropped 是合法结论：这活本来就不需要做，整单按完成收。 */
export function renderDroppedLine(runs: TaskRun[]): string {
  const detail = runs
    .slice(0, 3)
    .map((run) => `${runTag(run)}：${clean(run.report?.summary ?? "这活不需要做", 80)}`)
    .join("；");
  return `✓ 无需处理：${detail || "worker 判断这活不需要做"}。`;
}

export function renderPlanFailureLine(ticketId: string, error: string): string {
  return `✗ 拆单失败：${clean(error, 160)}。原始需求已存 ${ticketId}。`;
}

export function renderDryLine(titles: string[]): string {
  const listed = titles
    .map((title, index) => `${index + 1}.${sanitizeLine(title, 24)}`)
    .join("、");
  return `✓ 拆出 ${titles.length} 个任务，未派活：${listed}。`;
}

export function renderAbortedLine(completed: number): string {
  return `已停止。已完成 ${completed} 个，其余中断。`;
}

export function renderGoalFailureLine(reason: string): string {
  return `✗ 各任务都过了，但整体没达到你要的结果：${clean(reason, 160)}。`;
}

export function renderGoalInconclusiveLine(ticketId: string): string {
  return `⚠ 各任务都过了，但整体核对没做成（核对器输出异常）。活可能干完了，看一眼：runs/${ticketId}`;
}

/**
 * 裁判改判（2026-11-10 批 14）：验收说没过，裁判自己查完说达成。
 * 必须带"已记警告"——这是**推翻验收**，人要能回查（judge.json 里有证据）。
 */
export function renderJudgeDoneLine(reason: string): string {
  return `✓ 验收没过，但裁判查过后认定已达成：${clean(reason, 160)}（已记警告，可回查 judge.json）`;
}

/** 裁判判 blocked：缺信息 / 缺授权，只有人能推进。 */
export function renderJudgeBlockedLine(reason: string): string {
  return `⚠ 验收没过，裁判也卡住了：${clean(reason, 160)}`;
}

/** 裁判判 wait：在等外部条件，不是活没干完。 */
export function renderJudgeWaitLine(reason: string): string {
  return `⏸ 验收没过，裁判说在等外部条件：${clean(reason, 160)}`;
}

export function renderErrorLine(ticketId: string, error: string): string {
  return `✗ 中枢故障：${sanitizeLine(error, 160)}${ticketId ? `（${ticketId}）` : ""}。`;
}
