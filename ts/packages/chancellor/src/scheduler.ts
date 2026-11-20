import fs from "node:fs";
import path from "node:path";
import type {
  ChancellorEvent,
  DependencyReport,
  EmployeeProfile,
  PlannedTask,
  ProjectRef,
  Task,
  TaskRun,
  Ticket,
  WorkerKind,
} from "./types.ts";
import type { WorkerEscalation } from "./escalation-payload.ts";
import { dispatchTask, taskDirName, type DispatchOptions } from "./dispatch.ts";
import { MAX_PARALLEL_TASKS, TASK_ISOLATION } from "./config.ts";
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
import { readText, type Store } from "./store.ts";
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
  /** 已完成任务（resume 时从磁盘还原）。 */
  initialRuns?: TaskRun[];
  /** 只跑这些 seq（resume 用）；不传为全部。 */
  onlySeqs?: number[];
  /** 测试注入；默认真的派活。 */
  runner?: TaskRunner;
  isolation?: "worktree" | "direct";
  maxParallel?: number;
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
            gitIsolated,
            resumeWorktreePath: options.resumeWorktrees?.get(seq),

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
  gitIsolated: boolean;
  dispatchExtra?: DispatchOptions;
  /** 崩溃恢复：指定就复用这个副本，而不是重新检出。 */
  resumeWorktreePath?: string;
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
  /** 崩溃恢复：接着用上次保留下来的副本。 */
  resumeWorktreePath?: string;
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
      gitIsolated: TASK_ISOLATION === "worktree" && isGitProject(options.project),
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

async function executeTask(
  options: ExecuteOptions,
  completedRuns: TaskRun[],
): Promise<TaskExecutorResult> {
  const { ticket, task, seq, ticketDir, project, signal, employeeKind, runner } = options;
  const writes = project
    ? task.writes
        .map((item) => normalizeProjectPath(item))
        .filter((item): item is string => Boolean(item))
    : [];
  let lease: LeaseManager | null = null;
  let worktree: TaskWorktree | null = null;

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
        return { waitingOn: `${blocked}${holder}` };
      }
    }

    const dirName = taskDirName(seq, task.slug);
    let workDir: string | undefined;
    if (project) {
      if (options.gitIsolated) {
        const dataDir = project.dataDir ?? path.join(ticketDir, "project-data");
        worktree = prepareTaskWorktree({
          project: project as ProjectRef & { head: string },
          worktreePath:
            options.resumeWorktreePath ??
            path.join(dataDir, "worktrees", ticket.id, dirName),
          reuseExisting: Boolean(options.resumeWorktreePath),
        });
        workDir = worktree.path;
        recordInflightWorktree(ticketDir, seq, worktree.path);
      } else {
        // 2026-11-17：单子上指定了 workDir 就用它（宿主已校验绝对路径 + 登记根内），
        // 没指定才回落项目主文件夹。从 ticket 读，续跑 / 恢复天然沿用同一份快照。
        workDir = options.ticket.options.workDir ?? project.rootPath;
      }
    }

    const deps = buildDependencies(task, completedRuns, project?.rootPath);
    const run = await runner(ticket, task, seq, ticketDir, signal, deps, {
      ...options.dispatchExtra,
      employeeKind,
      ...(options.onEscalation ? { onEscalation: options.onEscalation } : {}),
      ...(options.employeeProfile ? { employeeProfile: options.employeeProfile } : {}),
      ...(workDir ? { workDir } : {}),
    });
    if (workDir) run.workDir = workDir;

    if (project && worktree) {
      const changes = collectTaskChanges(worktree);
      run.changedPaths = changes.map((change) => change.path);
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
    if (run.aborted && worktree && project) {
      removeWorktree(project.rootPath, worktree.path);
      clearInflightWorktree(ticketDir, seq);
      worktree = null;
    }
    // 失败副本刻意保留：负责人能进去看现场；下一条同 seq 任务开工时会先清掉。

    return { run };
  } finally {
    lease?.releaseAll();
  }
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
