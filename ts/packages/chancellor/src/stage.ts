import type {
  GoalCheckResult,
  Review,
  TaskRun,
  Ticket,
  TicketOutcomeStatus,
  TicketStage,
  TicketStatus,
} from "./types.ts";

/**
 * 任务级 stage。规则从上往下读，第一个匹配的生效。
 *
 * 关键区分是「在等谁」：blocked 等人 -> needs_you；failed/progress 结束 -> failed；
 * waiting 等下一个触发 -> idle；dropped 是合法结论 -> done。
 */
export type RunStage =
  | "aborted"
  | "person/answer"
  | "person/blocked"
  | "failed"
  | "idle"
  | "dropped"
  | "ready";

export function classifyRun(run: TaskRun): RunStage {
  if (run.aborted) return "aborted";
  if (run.timedOut) return "person/blocked";
  if (!run.processOk) return "failed";
  if (run.exitCode !== 0) return "failed";
  if (!run.reportExists) return "failed";

  const report = run.report;
  // 契约解析失败不是 worker 的最终结论，交给验收读原文判断。
  if (!report) return "ready";

  switch (report.status) {
    case "blocked":
      return report.attention ? "person/answer" : "person/blocked";
    case "failed":
    case "progress":
      // progress 只用于中途上报；最终 REPORT 只报进度，等于没给结论。
      return "failed";
    case "waiting":
      return "idle";
    case "dropped":
      return "dropped";
    case "ready":
      return "ready";
  }
}

export type BeforeReviewDecision =
  | { kind: "aborted" }
  | { kind: "needs_you"; stage: "person/answer" | "person/blocked"; runs: TaskRun[] }
  | { kind: "failed"; runs: TaskRun[] }
  | { kind: "idle"; runs: TaskRun[] }
  | { kind: "review"; ready: TaskRun[]; dropped: TaskRun[] };

/**
 * 验收前的分流。硬失败排在「等人」前面：一个真失败不能被另一个待回答的问题盖住。
 * 只有整单没有硬失败时，才按 person/answer -> person/blocked -> idle 的顺序看。
 */
export function decideBeforeReview(runs: TaskRun[]): BeforeReviewDecision {
  const groups = new Map<RunStage, TaskRun[]>();
  for (const run of runs) {
    const stage = classifyRun(run);
    const list = groups.get(stage);
    if (list) list.push(run);
    else groups.set(stage, [run]);
  }
  const of = (stage: RunStage): TaskRun[] => groups.get(stage) ?? [];

  if (of("aborted").length > 0) return { kind: "aborted" };

  const failed = of("failed");
  if (failed.length > 0) return { kind: "failed", runs: failed };

  const answer = of("person/answer");
  if (answer.length > 0) {
    return { kind: "needs_you", stage: "person/answer", runs: answer };
  }

  const blocked = of("person/blocked");
  if (blocked.length > 0) {
    return { kind: "needs_you", stage: "person/blocked", runs: blocked };
  }

  const idle = of("idle");
  if (idle.length > 0) return { kind: "idle", runs: idle };

  return { kind: "review", ready: of("ready"), dropped: of("dropped") };
}

/** 全是 dropped 时没有可验收的活，也不该跑整体目标核对。 */
export function needsGoalCheck(runs: TaskRun[]): boolean {
  return runs.some((run) => classifyRun(run) === "ready");
}

export function decideAfterReview(
  reviews: Review[],
  goal: GoalCheckResult | null,
): { status: TicketOutcomeStatus; stage: TicketStage } {
  // 真失败优先；核对器没结论只在没有硬失败时才算「等人」。
  if (reviews.some((review) => review.verdict === "fail")) {
    return { status: "failed", stage: "failed" };
  }
  if (reviews.some((review) => review.verdict === "blocked")) {
    return { status: "needs_you", stage: "person/blocked" };
  }
  if (goal === null) return { status: "done", stage: "done" };
  if (goal.inconclusive) return { status: "needs_you", stage: "person/blocked" };
  if (!goal.satisfied) return { status: "failed", stage: "failed" };
  return { status: "done", stage: "done" };
}

export interface ManagerDecision {
  status: TicketOutcomeStatus;
  stage: TicketStage;
  line: string;
  error: string | null;
}

/**
 * 子单的真终态。idle 不在此列（2026-11-08）：idle 是「等下一个触发」，
 * 可续跑（见 store.ts 的快照清理），子单 idle 时父单不能宣布 done。
 */
const TERMINAL_CHILD_STATUS = new Set<TicketStatus>([
  "done",
  "needs_you",
  "failed",
  "aborted",
]);

/**
 * 父单收口闸门（2026-11-04）：负责人说自己 done，但子单里只要有
 * failed / needs_you / aborted，父单就不得进 done——改成 needs_you，
 * 并点名是哪张子单、什么状态、为什么。其余未终态子单沿用旧的 idle，不提前汇报。
 */
export function enforceChildClosure(
  decided: ManagerDecision,
  children: Ticket[],
  parentId: string,
): ManagerDecision {
  if (decided.status !== "done") return decided;

  const unfinished = children.filter(
    (child) =>
      child.status === "failed" ||
      child.status === "needs_you" ||
      child.status === "aborted",
  );
  if (unfinished.length > 0) {
    const detail = unfinished
      .map((child) => `${child.id}（${childStatusLabel(child)}${child.error ? `：${oneLine(child.error)}` : ""}）`)
      .join("、");
    return {
      status: "needs_you",
      stage: "person/blocked",
      line: `⚠ [${parentId}] 子单没做成：${detail}；父单不进 done，先处理这些子单。`,
      error: `子单未完成：${detail}`,
    };
  }

  const open = children.filter((child) => !TERMINAL_CHILD_STATUS.has(child.status));
  if (open.length > 0) {
    return {
      status: "idle",
      stage: "idle",
      line: `⏳ [${parentId}] 还有 ${open.length} 件子任务没终态（${open
        .map((child) => `${child.id}:${child.status}`)
        .join("、")}），先不汇报。`,
      error: "子任务未全部终态",
    };
  }
  return decided;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** 给汇报用的中文状态：只有 aborted 需要换词，其余保留内部状态名便于追查。 */
function childStatusLabel(child: Ticket): string {
  return child.status === "aborted" ? "已中止" : child.status;
}
