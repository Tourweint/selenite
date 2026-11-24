import fs from "node:fs";
import path from "node:path";
import type {
  ChancellorEvent,
  DependencyReport,
  EmployeeProfile,
  PlannedTask,
  ProjectRef,
  ProjectRootRef,
  Task,
  TaskIsolation,
  TaskRun,
  Ticket,
  WorkerKind,
} from "./types.ts";
import type { WorkerEscalation } from "./escalation-payload.ts";
import type { CliStepEvent } from "./employee/steps.ts";
import { dispatchTask, taskDirName, type DispatchOptions } from "./dispatch.ts";
import { MAX_PARALLEL_TASKS, TASK_ISOLATION, projectRootsDispatchEnabled } from "./config.ts";
import {
  classifyRunFailure,
  cooldownUntil,
  failureText,
  parseResetAt,
  retryDecision,
  type FailureClass,
} from "./failure-class.ts";
import {
  acquireLane,
  laneNameOf,
  recordLaneOutcome,
  setLaneCooldown,
  type LaneLease,
} from "./lane.ts";
import { LeaseManager } from "./lease.ts";
import {
  collectTaskChanges,
  isGitProject,
  mergeTaskChanges,
  prepareTaskWorktree,
  removeWorktree,
  type TaskWorktree,
} from "./isolation.ts";
import { coveredByAny, normalizeProjectPath } from "./paths.ts";
import {
  clearInflightWorktree,
  markInflightMerged,
  recordInflightWorktree,
} from "./inflight.ts";
import { readText, writeJson, type Store } from "./store.ts";
import {
  checkArtifacts,
  collectArtifactContents,
  filterArtifacts,
  formatArtifactContents,
} from "./artifacts.ts";

/**
 * 依赖感知并行调度（2026-11-03 方案 §5.2 / §5.4）。
 *
 * 一个任务要同时满足三件事才开工：前置任务已产生 run、并行槽位没满、写集租约拿得到。
 * 租约拿不到就进「等待文件」，不启动、不写；等有人释放后自动重试。
 */
export interface TaskExecutorResult {
  run?: TaskRun;
  waitingOn?: string;
}

export type TaskRunner = typeof dispatchTask;

export interface ScheduleOptions {
  ticket: Ticket;
  store: Store;
  tasks: PlannedTask[];
  rows: Task[];
  project?: ProjectRef;
  signal?: AbortSignal;
  employeeKind: WorkerKind;
  /** 模型 / 权限（2026-11-16）；不传 = 各 CLI 的 env 缺省。 */
  employeeProfile?: EmployeeProfile;
  emit: (event: ChancellorEvent) => void;
  /**
   * worker 跑动中的决策上报回调（2026-11-19 批2）：scheduler 原样递给每张任务，
   * 由 chancellor 入口层统一发射 escalation 事件；不传 = 旧行为。
   */
  onEscalation?: (escalation: WorkerEscalation) => void;
  /** 外部 CLI 的步骤事件（2026-11-23 流式事件）：原样递到 dispatch。 */
  onStep?: (seq: number, slug: string, step: CliStepEvent) => void;
  /**
   * 任务卡在执行器车道上时的回调（2026-11-22 M1a）：车道的 onWait 只叫一次。
   * 调度路径用它发 task-waiting 让任务中心看得见排队；续跑单不传 = 静默等。
   */
  onTaskWaiting?: (seq: number, slug: string | undefined, reason: string) => void;
  /** 已完成任务（resume 时从磁盘还原）。 */
  initialRuns?: TaskRun[];
  /** 只跑这些 seq（resume 用）；不传为全部。 */
  onlySeqs?: number[];
  /** 测试注入；默认真的派活。 */
  runner?: TaskRunner;
  /** 单张任务也吃按单隔离（2026-11-23）：续跑按原单快照传进来；不传 = 全局缺省。 */
  isolation?: TaskIsolation;
  maxParallel?: number;
  /**
   * 失败自动重试（2026-11-22 M3）。默认开；`CHANCELLOR_RETRY_ENABLED=false`
   * 是硬回滚开关（env 关掉时这里给 true 也不生效）。
   */
  retry?: boolean;
  /** 单个 task 最多跑几次（含第一次）；默认 3，防「失败 → 重试 → 再失败」无限循环。 */
  maxAttempts?: number;
  /** 崩溃恢复：按 seq 接着用上次保留下来的 worktree 半成品。 */
  resumeWorktrees?: Map<number, string>;
}

export interface ScheduleResult {
  runs: TaskRun[];
}

export async function runScheduledTasks(options: ScheduleOptions): Promise<ScheduleResult> {
  const {
    ticket,
    store,
    tasks,
    rows,
    project,
    signal,
    employeeKind,
    employeeProfile,
    emit,
    initialRuns = [],
    onlySeqs,
    runner = dispatchTask,
  } = options;
  const ticketDir = store.ticketDir(ticket.id);
  const isolation = options.isolation ?? TASK_ISOLATION;
  const gitIsolated = isolation === "worktree" && isGitProject(project);
  // worktree 隔离才允许并行写；direct / 非 git 一律串行，避免同一个项目目录被并发写。
  const maxParallel =
    isolation === "worktree" && project && project.vcs === "git"
      ? options.maxParallel ?? MAX_PARALLEL_TASKS
      : 1;

  const runs: TaskRun[] = [...initialRuns];
  const completed = new Set(runs.map((run) => run.seq));
  const started = new Set<number>();
  const running = new Map<number, Promise<{ seq: number; result: TaskExecutorResult }>>();
  // 等待文件的 seq 必须节流：否则租约未释放时它会瞬间重试，把 race 拖成活锁，
  // 正在跑的任务反而永远排不上结算。
  const retryAt = new Map<number, number>();
  const rowBySeq = new Map(rows.map((row) => [row.seq, row]));
  const taskBySeq = new Map(tasks.map((task, index) => [index + 1, task]));
  const wanted = (seq: number): boolean => !onlySeqs || onlySeqs.includes(seq);

  let active = 0;
  while (true) {
    if (signal?.aborted && running.size === 0) break;

    for (const [seq, task] of [...taskBySeq.entries()].sort((a, b) => a[0] - b[0])) {
      if (!wanted(seq) || started.has(seq) || completed.has(seq)) continue;
      if (active >= maxParallel) break;
      if (!task.dependsOn.every((dep) => completed.has(dep))) continue;
      if ((retryAt.get(seq) ?? 0) > Date.now()) continue;

      started.add(seq);
      active += 1;
      const row = rowBySeq.get(seq);
      if (row) {
        row.status = "running";
        row.updated_at = new Date().toISOString();
        store.saveTask(row);
      }
      emit({
        type: "task-start",
        ticketId: ticket.id,
        seq,
        slug: task.slug,
        message: `派活到 ${row?.dir ?? task.slug}`,
      });

      running.set(
        seq,
        executeTask(
          {
            ticket,
            task,
            seq,
            ticketDir,
            project,
            signal,
            employeeKind,
            ...(employeeProfile ? { employeeProfile } : {}),
            runner,
            ...(options.onEscalation ? { onEscalation: options.onEscalation } : {}),
            ...(options.onStep ? { onStep: options.onStep } : {}),
            onTaskWaiting: (waitSeq, waitSlug, reason) => {
              // 车道排队复用 task-waiting：契约里 waitingOn 本来就是「在等什么」，
              // 不新增对外状态（方案 §七）。
              options.onTaskWaiting?.(waitSeq, waitSlug, reason);
              emit({
                type: "task-waiting",
                ticketId: ticket.id,
                seq: waitSeq,
                ...(waitSlug ? { slug: waitSlug } : {}),
                waitingOn: reason,
                message: `等待${reason}`,
              });
            },
            gitIsolated,
            resumeWorktreePath: options.resumeWorktrees?.get(seq),
            ...(options.retry !== undefined ? { retry: options.retry } : {}),
            ...(options.maxAttempts !== undefined
              ? { maxAttempts: options.maxAttempts }
              : {}),
          },
          [...runs],
        ).then((result) => ({ seq, result })),
      );
    }

    if (running.size === 0) {
      const allDone = [...taskBySeq.keys()].every((seq) => !wanted(seq) || completed.has(seq));
      if (allDone) break;
      if (signal?.aborted) break;
      // 全卡在租约上：等持有者释放后再试。
      await sleep(1500, signal);
      continue;
    }

    const settled = await Promise.race(running.values());
    running.delete(settled.seq);
    active -= 1;
    const task = taskBySeq.get(settled.seq);
    const row = rowBySeq.get(settled.seq);

    if (settled.result.waitingOn) {
      // 没真正开跑：名额已在上面释放；删掉 started 让下一轮重新尝试（节流 1 秒）。
      started.delete(settled.seq);
      retryAt.set(settled.seq, Date.now() + 1000);
      if (row) {
        row.status = "waiting";
        row.updated_at = new Date().toISOString();
        store.saveTask(row);
      }
      emit({
        type: "task-waiting",
        ticketId: ticket.id,
        seq: settled.seq,
        ...(task?.slug ? { slug: task.slug } : {}),
        message: `等待文件：${settled.result.waitingOn}`,
        waitingOn: settled.result.waitingOn,
      });
      continue;
    }

    const run = settled.result.run;
    if (!run) continue;
    completed.add(run.seq);
    retryAt.delete(run.seq);
    runs.push(run);
    if (row) {
      row.employee = run.employee;
      row.status = run.aborted || run.timedOut
        ? "blocked"
        : run.exitCode !== 0
          ? "failed"
          : run.reportExists
            ? "reported"
            : "failed";
      row.updated_at = new Date().toISOString();
      store.saveTask(row);
    }
    emit({
      type: "task-done",
      ticketId: ticket.id,
      seq: run.seq,
      slug: run.task.slug,
      message: run.aborted
        ? "已停止"
        : run.failure
          ? run.failure
          : `退出码=${run.exitCode === null ? "null" : run.exitCode}，报告=${
              run.reportExists ? (run.report?.status ?? "无法解析") : "缺失"
            }`,
    });
  }

  return { runs };
}

interface ExecuteOptions {
  ticket: Ticket;
  task: PlannedTask;
  seq: number;
  ticketDir: string;
  project?: ProjectRef;
  signal?: AbortSignal;
  employeeKind: WorkerKind;
  employeeProfile?: EmployeeProfile;
  runner: TaskRunner;
  /** worker 跑动中的决策上报（批2）；经 dispatchExtra 原样递给雇员。 */
  onEscalation?: (escalation: WorkerEscalation) => void;
  /** 外部 CLI 步骤（2026-11-23）；经 dispatchExtra 原样递给雇员。 */
  onStep?: (seq: number, slug: string, step: CliStepEvent) => void;
  /** 卡在执行器车道时的回调（M1a）；不传 = 静默等（续跑单）。 */
  onTaskWaiting?: (seq: number, slug: string | undefined, reason: string) => void;
  gitIsolated: boolean;
  dispatchExtra?: DispatchOptions;
  /** 崩溃恢复：指定就复用这个副本，而不是重新检出。 */
  resumeWorktreePath?: string;
  /** M3：失败重试开关 / 次数上限；不传走 env 默认（开，3 次）。 */
  retry?: boolean;
  maxAttempts?: number;
}

/**
 * 续跑单个任务也走同一套租约 / worktree / 合并逻辑。
 * 续跑是「重跑一个任务」，不能因为它不是并行调度就绕过隔离。
 */
export async function runSingleTask(options: {
  ticket: Ticket;
  store: Store;
  task: PlannedTask;
  seq: number;
  project?: ProjectRef;
  signal?: AbortSignal;
  employeeKind: WorkerKind;
  employeeProfile?: EmployeeProfile;
  completedRuns: TaskRun[];
  resumeAnswer?: string;
  /** worker 跑动中的决策上报（批2）：续跑的单也要能上报。 */
  onEscalation?: (escalation: WorkerEscalation) => void;
  /** 外部 CLI 步骤（2026-11-23）：续跑的单也要能看到过程。 */
  onStep?: (seq: number, slug: string, step: CliStepEvent) => void;
  /** 崩溃恢复：接着用上次保留下来的副本。 */
  resumeWorktreePath?: string;
  /** 续跑沿用原单的隔离快照（2026-11-23）；不传 = 全局 `CHANCELLOR_TASK_ISOLATION`。 */
  isolation?: TaskIsolation;
}): Promise<TaskExecutorResult> {
  const ticketDir = options.store.ticketDir(options.ticket.id);
  return executeTask(
    {
      ticket: options.ticket,
      task: options.task,
      seq: options.seq,
      ticketDir,
      project: options.project,
      signal: options.signal,
      employeeKind: options.employeeKind,
      ...(options.employeeProfile ? { employeeProfile: options.employeeProfile } : {}),
      runner: dispatchTask,
      ...(options.onEscalation ? { onEscalation: options.onEscalation } : {}),
      ...(options.onStep ? { onStep: options.onStep } : {}),
      gitIsolated:
        (options.isolation ?? TASK_ISOLATION) === "worktree" &&
        isGitProject(options.project),
      ...(options.resumeWorktreePath
        ? { resumeWorktreePath: options.resumeWorktreePath }
        : {}),
      ...(options.resumeAnswer !== undefined
        ? { dispatchExtra: { resumeAnswer: options.resumeAnswer } }
        : {}),
    },
    options.completedRuns,
  );
}

const DEFAULT_MAX_ATTEMPTS = 3;
/** usage_limit 的 reset 超过这个时间就不在进程内等（几小时会把这张单的 promise 挂死）。 */
const USAGE_LIMIT_INLINE_WAIT_MS = 10 * 60_000;
/** 车道冷却时的探活间隔：30s 一次，顺便刷新「冷却到 HH:mm」。 */
const LANE_COOLDOWN_POLL_MS = 30_000;
/**
 * 计入车道熔断的失败类（方案 §4.6）：权限 / 登录、执行器崩溃、认不出的进程失败。
 * 额度、限流、网络、超时、报告问题、越权、冲突都不是「车坏了」，不该熔断整条车道。
 */
const LANE_BREAKER_CLASSES = new Set<FailureClass>(["permission", "crashed", "unknown"]);

/**
 * 跑一个 task，失败按分类决定要不要重试（2026-11-22 M3）。
 *
 * 每轮都是一次完整的 executeAttempt：重新拿车道 / 租约 / worktree，和第一次开跑
 * 走同一套隔离与合并逻辑；重试前清掉上一轮的 REPORT.md / session.json，避免把
 * 旧报告当本轮结果。取消 / 中止随时打断（退避 sleep 可被 signal 叫醒）。
 */
async function executeTask(
  options: ExecuteOptions,
  completedRuns: TaskRun[],
): Promise<TaskExecutorResult> {
  // M3 的总回滚开关：CHANCELLOR_RETRY_ENABLED=false 同时关掉 attempt 记账与车道冷却，
  // 退回「一次执行即终态」的旧形态（方案 §六 M3 回滚口径）。
  const m3 = retryEnabled();
  const retry = m3 && options.retry !== false;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const lane = laneNameOf(options.employeeKind);
  let attempt = 0;

  while (true) {
    attempt += 1;
    const settled = await executeAttempt(options, completedRuns, attempt);
    const run = settled.result.run;
    if (!run) {
      // 等文件租约：这一轮没真开跑，不记 attempt、不结算，调度层会重新排队。
      return settled.result;
    }
    run.attempt = attempt;
    const cls = classifyRunFailure(run);
    if (settled.executed) {
      run.failureClass = cls;
      if (m3) {
        // 只记枚举 / 退出码 / 时长，不写 TASK / REPORT / 错误正文（日志纪律）。
        writeJson(path.join(taskDirOf(options), `attempt-${attempt}.json`), {
          seq: options.seq,
          attempt,
          class: cls,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          durationMs: settled.durationMs,
          // M4 观测：排队与 worktree 检出耗时，给「要不要做 worktree 预热」提供数据。
          queueMs: settled.queueMs ?? 0,
          worktreeMs: settled.worktreeMs ?? null,
        });
        // 额度耗尽是整条车道的事：先冷却，后面的 task 不该继续撞同一个 429。
        if (cls === "usage_limit") applyLaneCooldown(lane, cls, run);
      }
    }

    // 取消 / 中止 / 本轮没真开跑 / 重试关掉：都按这一轮结算，不重跑。
    const decision =
      !retry || !settled.executed || run.aborted || options.signal?.aborted
        ? { retry: false, delayMs: 0, reason: "" }
        : retryDecision(cls, attempt);

    if (!decision.retry || attempt >= maxAttempts || options.signal?.aborted) {
      // 限流到顶才冷却 30s：重试期间冷却会把 5s / 30s / 2min 的退避顶掉。
      if (m3 && cls === "rate_limit") applyLaneCooldown(lane, cls, run);
      if (m3 && settled.executed) recordLaneOutcome(lane, laneOutcomeOk(run));
      return settled.result;
    }

    let delayMs = decision.delayMs;
    // usage_limit 只在 reset 很近（≤10min）时才在进程内等；更久就判失败，
    // 把 failureClass 落进 run，让上层转 needs_you / 按车道冷却处理。
    if (cls === "usage_limit") {
      const resetAt = parseResetAt(failureText(run));
      if (resetAt === null || resetAt - Date.now() > USAGE_LIMIT_INLINE_WAIT_MS) {
        recordLaneOutcome(lane, laneOutcomeOk(run));
        return settled.result;
      }
      // 等的是 reset 本身，不是 retryDecision 的 5min 兜底值。
      delayMs = Math.max(0, resetAt - Date.now());
    }

    if (delayMs > 0) await sleep(delayMs, options.signal);
    if (options.signal?.aborted) {
      // 等退避时被取消：这一轮记成中止，别让上层当失败。
      run.aborted = true;
      run.failureClass = "aborted";
      return settled.result;
    }
    // 上一轮的 REPORT.md / session.json 必须先清掉：dispatch 只看磁盘上有没有
    // 报告文件，留着旧文件会把上一轮的结论当成本轮结果（方案 §4.6）。
    clearAttemptArtifacts(options);
  }
}

interface AttemptSettlement {
  result: TaskExecutorResult;
  /** runner 真跑过（含跑成 aborted）；等车道 / 等租约不算。 */
  executed: boolean;
  /** runner 那一跳的耗时（写 attempt-<n>.json 用）。 */
  durationMs: number;
  /** 等车道槽位 / 冷却的耗时（M4 观测：决定要不要做 worktree 预热）。 */
  queueMs?: number;
  /** worktree 检出耗时；direct 隔离 / 非 git 为 null。 */
  worktreeMs?: number | null;
}

/** 一次完整尝试：车道 → 租约 → worktree → runner → 越权判定 / 合并。 */
async function executeAttempt(
  options: ExecuteOptions,
  completedRuns: TaskRun[],
  attempt: number,
): Promise<AttemptSettlement> {
  const { ticket, task, seq, ticketDir, project, signal, employeeKind, runner } = options;
  const writes = project
    ? task.writes
        .map((item) => normalizeProjectPath(item))
        .filter((item): item is string => Boolean(item))
    : [];
  const projectRoots = taskProjectRoots(project, options.gitIsolated);
  let lease: LeaseManager | null = null;
  let worktree: TaskWorktree | null = null;
  let queueMs = 0;
  let worktreeMs: number | null = null;

  // 车道必须先于文件租约：反序会「持租约等槽位」，与另一张单的「持槽位等租约」互等。
  // 车道只等执行器容量、不持任何项目锁，等再久也只影响这张单自己。
  // signal 中止时闸门返回 granted=false（不占槽）；这时仍走一次 runner，
  // dispatchTask 看到 aborted 会直接回一张 aborted 的单，不建 TASK.md、不起雇员。
  const queueStartedAt = Date.now();
  const lane = await acquireLaneForTask(options);
  queueMs = Date.now() - queueStartedAt;
  if (!lane.granted) {
    const deps = buildDependencies(task, completedRuns, project?.rootPath);
    const run = await runner(ticket, task, seq, ticketDir, signal, deps, {
      ...options.dispatchExtra,
      employeeKind,
      ...(projectRoots ? { projectRoots } : {}),
      ...(options.onEscalation ? { onEscalation: options.onEscalation } : {}),
      ...(options.onStep ? { onStep: options.onStep } : {}),
      ...(options.employeeProfile ? { employeeProfile: options.employeeProfile } : {}),
    });
    return { result: { run }, executed: false, durationMs: 0, queueMs, worktreeMs };
  }

  try {
    if (project && writes.length > 0) {
      const dataDir = project.dataDir ?? path.join(ticketDir, "project-data");
      lease = new LeaseManager({
        dataDir,
        projectId: project.id,
        ticketId: ticket.id,
        seq,
      });
      const acquired = lease.acquire(writes);
      if (!acquired.ok) {
        const blocked = acquired.blockedPath ?? "未知路径";
        const holder = acquired.heldBy
          ? `（被 ${acquired.heldBy.ticketId}/${acquired.heldBy.seq} 占用）`
          : "";
        lease.releaseAll();
        lease = null;
        return { result: { waitingOn: `${blocked}${holder}` }, executed: false, durationMs: 0, queueMs, worktreeMs };
      }
    }

    const dirName = taskDirName(seq, task.slug);
    let workDir: string | undefined;
    if (project) {
      if (options.gitIsolated) {
        const dataDir = project.dataDir ?? path.join(ticketDir, "project-data");
        const worktreeStartedAt = Date.now();
        worktree = prepareTaskWorktree({
          project: project as ProjectRef & { head: string },
          worktreePath:
            options.resumeWorktreePath ??
            path.join(dataDir, "worktrees", ticket.id, dirName),
          // 只有第一轮沿用崩溃恢复的半成品；重试明确「清掉重检」，
          // 否则上一轮改坏的副本会被带进第二次尝试。
          reuseExisting: Boolean(options.resumeWorktreePath) && attempt === 1,
        });
        worktreeMs = Date.now() - worktreeStartedAt;
        workDir = worktree.path;
        recordInflightWorktree(ticketDir, seq, worktree.path);
      } else {
        // 2026-11-17：单子上指定了 workDir 就用它（宿主已校验绝对路径 + 登记根内），
        // 没指定才回落项目主文件夹。从 ticket 读，续跑 / 恢复天然沿用同一份快照。
        workDir = options.ticket.options.workDir ?? project.rootPath;
      }
    }

    const deps = buildDependencies(task, completedRuns, project?.rootPath);
    const startedAt = Date.now();
    const run = await runner(ticket, task, seq, ticketDir, signal, deps, {
      ...options.dispatchExtra,
      employeeKind,
      ...(projectRoots ? { projectRoots } : {}),
      ...(options.onEscalation ? { onEscalation: options.onEscalation } : {}),
      ...(options.onStep ? { onStep: options.onStep } : {}),
      ...(options.employeeProfile ? { employeeProfile: options.employeeProfile } : {}),
      ...(workDir ? { workDir } : {}),
    });
    const durationMs = Date.now() - startedAt;
    if (workDir) run.workDir = workDir;

    // M0 取消语义（2026-11-22 合并方案 §5.3）：取消 / 中止只停执行，不把半成品合并进项目。
    // signal（票级取消控制器）与 outcome.aborted 任一成立都算中止。
    const aborted = signal?.aborted === true || run.aborted;

    if (project && worktree) {
      const changes = collectTaskChanges(worktree);
      run.changedPaths = changes.map((change) => change.path);
      if (aborted) {
        // 取消 / 中止：跳过越权判定 / 合并 / markInflightMerged，worktree 原样保留；
        // 租约仍由 finally 释放。
        return { result: { run }, executed: true, durationMs, queueMs, worktreeMs };
      }
      const unauthorized = changes.filter((change) => !coveredByAny(writes, change.path));
      if (unauthorized.length > 0) {
        failRun(run, `越权写入：${unauthorized.map((change) => change.path).join("、")}`);
      } else {
        const merged = mergeTaskChanges({
          projectRoot: project.rootPath,
          worktree,
          changes,
        });
        if (merged.conflicts.length > 0) {
          failRun(run, `合并冲突：${merged.conflicts.join("、")}`);
        } else if (merged.merged.length > 0) {
          // 跨过合并点：恢复时不再自动续跑，必须先让人确认。
          markInflightMerged(ticketDir);
        }
      }
      if (run.processOk) {
        removeWorktree(project.rootPath, worktree.path);
        clearInflightWorktree(ticketDir, seq);
        worktree = null;
      }
    }
    // 失败 / 中止副本刻意保留：负责人能进去看现场；下一条同 seq 任务开工时会先清掉。

    return { result: { run }, executed: true, durationMs, queueMs, worktreeMs };
  } finally {
    // 取消 / 中止的早返回也走这里（M0 的 aborted 分支在 try 内 return）。
    lane.release();
    lease?.releaseAll();
  }
}

/**
 * 取车道槽位；车道在额度冷却时等它到期（不消耗 attempt，任务中心显示冷却到几点），
 * 其余情况与 M1a 一致：容量满就排队。取消立即返回 not-granted，交给 dispatch 收尾。
 */
/**
 * 本次任务可访问的项目文件夹（2026-11-24 派活按项目下发）。
 *
 * - 主文件夹走 worktree / 合并 / 租约，隔离形态下工人看到的是 `workDir` 副本，
 *   **真实主文件夹不下发**（否则绕过副本直写项目）；
 * - 非隔离形态下发全部 roots（`workDir` 可能只是其中一个子目录）；
 * - 其他文件夹始终是共享读写：不进 worktree、不合并、不租约。
 * - 回滚开关关掉 / 项目没有 roots → undefined（回到"只给主文件夹"）。
 */
export function taskProjectRoots(
  project: ProjectRef | undefined,
  isolated: boolean,
): ProjectRootRef[] | undefined {
  if (!project?.roots?.length) return undefined;
  if (!projectRootsDispatchEnabled()) return undefined;
  const roots = isolated
    ? project.roots.filter((root) => root.role !== "primary")
    : project.roots;
  return roots.length > 0 ? roots.map((root) => ({ ...root })) : undefined;
}

async function acquireLaneForTask(options: ExecuteOptions): Promise<LaneLease> {
  const { seq, task, signal, employeeKind } = options;
  while (true) {
    const lease = await acquireLane(employeeKind, {
      signal,
      onWait: (info) =>
        options.onTaskWaiting?.(
          seq,
          task.slug,
          `执行器槽位（${info.lane} ${info.running}/${info.cap}）`,
        ),
    });
    if (lease.granted || lease.cooldownUntil === undefined) return lease;
    const until = lease.cooldownUntil;
    options.onTaskWaiting?.(seq, task.slug, `执行器冷却到 ${clockOf(until)}`);
    if (signal?.aborted) return lease;
    // 冷却可能几小时：按 30s 探，不一口气睡到截止；到期或冷却被改短都能及时重试，
    // 取消也能叫醒。
    await sleep(Math.min(LANE_COOLDOWN_POLL_MS, Math.max(200, until - Date.now())), signal);
    if (signal?.aborted) return lease;
  }
}

/** 额度 / 限流失败后冷却车道；resetAt 只对 usage_limit 有意义。 */
function applyLaneCooldown(lane: string, cls: FailureClass, run: TaskRun): void {
  const resetAt = cls === "usage_limit" ? parseResetAt(failureText(run)) : null;
  const until = cooldownUntil(cls, resetAt);
  if (until !== null) setLaneCooldown(lane, until);
}

/**
 * 一次 task 结算是否算「车道健康」。只有权限 / 崩溃 / 认不出的进程失败才计入熔断；
 * 取消、超时、额度、限流、网络、报告问题、越权、冲突都不算（方案 §4.6）。
 */
function laneOutcomeOk(run: TaskRun): boolean {
  if (runSucceeded(run)) return true;
  const cls = run.failureClass ?? classifyRunFailure(run);
  return !LANE_BREAKER_CLASSES.has(cls);
}

function runSucceeded(run: TaskRun): boolean {
  return (
    run.processOk &&
    !run.aborted &&
    !run.timedOut &&
    run.exitCode === 0 &&
    run.reportExists
  );
}

function taskDirOf(options: ExecuteOptions): string {
  return path.join(options.ticketDir, taskDirName(options.seq, options.task.slug));
}

/** 重试前清掉上一轮结论文件：旧 REPORT.md 会被当成这一轮的报告。 */
function clearAttemptArtifacts(options: ExecuteOptions): void {
  const dir = taskDirOf(options);
  fs.rmSync(path.join(dir, "REPORT.md"), { force: true });
  fs.rmSync(path.join(dir, "session.json"), { force: true });
}

function clockOf(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 默认开；只有显式 false / 0 / no / off 才关（与 config.readBool 同口径）。 */
function retryEnabled(): boolean {
  const raw = process.env.CHANCELLOR_RETRY_ENABLED;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  return !["false", "0", "no", "off"].includes(value);
}

function failRun(run: TaskRun, reason: string): void {
  run.processOk = false;
  run.failure = reason;
  run.processError = reason;
}

export function buildDependencies(
  task: PlannedTask,
  runs: TaskRun[],
  projectRoot?: string,
): DependencyReport[] {
  const deps: DependencyReport[] = [];
  for (const depSeq of task.dependsOn) {
    const prior = runs.find((item) => item.seq === depSeq);
    if (!prior) continue;
    const reportRaw =
      prior.report?.raw ??
      readText(path.join(prior.dir, "REPORT.md")) ??
      "（前置任务没有写 REPORT.md）";
    const artifacts = filterArtifacts(prior.report?.artifacts ?? []);
    const mechanical = checkArtifacts(prior.dir, artifacts);
    const artifactsText = mechanical.ok
      ? formatArtifactContents(collectArtifactContents(prior.dir, artifacts), "####")
      : `（上游产物未通过机械校验，未注入内容：${mechanical.reason}）`;
    deps.push({
      seq: prior.seq,
      slug: prior.task.slug,
      dirName: prior.dirName,
      reportRaw,
      artifactsText,
      artifactPaths: verifiedArtifactPaths(prior, projectRoot),
    });
  }
  return deps;
}

/**
 * 上游「已验收落盘」的产物路径（2026-11-08 扫尾批 8e）。
 *
 * 直接取验收快照比对出来的 changedPaths——判定 pass 用的就是它，同源、不另算一份。
 * changedPaths 里删除也算变更，所以有项目根时再核一遍文件真实存在，删掉的路径不注入。
 * 没声明 writes 的任务（只读 / 手机单）没有快照，清单为空，下游看到的与改动前完全一致。
 */
function verifiedArtifactPaths(run: TaskRun, projectRoot?: string): string[] {
  const paths = run.changedPaths ?? [];
  const unique = [
    ...new Set(
      paths
        .map((item) => normalizeProjectPath(item))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
  if (!projectRoot) return unique;
  return unique.filter((relPath) => {
    try {
      return fs.statSync(path.join(projectRoot, relPath)).isFile();
    } catch {
      return false;
    }
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
