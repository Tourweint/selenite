import fs from "node:fs";
import path from "node:path";
import { EMPLOYEE, cliStreamEventsEnabled, externalResumeEnabled } from "./config.ts";
import {
  capabilitiesOf,
  createEmployee,
  resumeEmployee,
  type Employee,
} from "./employee/index.ts";
import {
  appendStep,
  STEPS_FILE,
  summarizeSteps,
  type CliStepEvent,
} from "./employee/steps.ts";
import { ensureDir, readJson, writeJson, writeText } from "./store.ts";
import { buildWorkerPrompt, renderUpstream } from "./worker-prompt.ts";
import type {
  AttentionKind,
  DependencyReport,
  EmployeeProfile,
  PlannedTask,
  ProjectRootRef,
  TaskRun,
  Ticket,
  WorkerAttention,
  WorkerKind,
  WorkerReport,
  WorkerStatus,
} from "./types.ts";
import type { WorkerEscalation } from "./escalation-payload.ts";

// qoder 调用搬进了雇员实现；这里保留旧导出，拆单/验收/目标核对一行都不用改。
export { runQoder, type QoderCall } from "./employee/mercenary.ts";

export interface ParsedReport {
  report: WorkerReport | null;
  error: string | null;
}

export function taskDirName(seq: number, slug: string): string {
  return `${String(seq).padStart(2, "0")}-${slug}`;
}

export interface DispatchOptions {
  /** 用哪个雇员跑；resume 时按 ticket 上记的雇员，默认全局配置。 */
  employeeKind?: WorkerKind;
  /** 模型 / 权限（2026-11-16）；不传 = 各 CLI 的 env 缺省。 */
  employeeProfile?: EmployeeProfile;
  /** 有值时走 resume；默认实现就是重新 run。 */
  resumeAnswer?: string;
  /** 隔离执行的项目副本 / 项目根；不传就是老行为（task 目录即工作目录）。 */
  workDir?: string;
  /**
   * 项目全部文件夹（2026-11-24）：主文件夹之外的额外根，直接读写真实目录，
   * 不进 worktree / 不合并。隔离形态下不含 primary（primary 以 workDir 副本呈现）。
   * 不传 = 旧行为（只知道 workDir）。
   */
  projectRoots?: readonly ProjectRootRef[];
  /**
   * worker 跑动中的决策上报回调（2026-11-19 批2）。只对本机池生效
   * （SSE escalation 事件）；外部 CLI 没有这条通道。不传 = 旧行为。
   * chancellor 不解读内容，只透传给雇员。
   */
  onEscalation?: (escalation: WorkerEscalation) => void;
  /** 测试注入：给假雇员；默认按 kind 建真雇员。 */
  employeeFactory?: (kind: WorkerKind) => Employee;
  /**
   * 外部 CLI 的步骤回调（2026-11-23 流式事件）：每采集到一步调一次，
   * 由 scheduler 包成 `step` 事件推给任务中心。不传 = 只落 steps.jsonl。
   */
  onStep?: (seq: number, slug: string, step: CliStepEvent) => void;
  /** 测试注入：是否采集步骤；缺省读 CHANCELLOR_CLI_STREAM_EVENTS。 */
  streamEvents?: boolean;
}

/**
 * 会话号落盘（2026-11-08 扫尾批 8f）：放在 task 目录，和 REPORT.md、
 * snapshot-before.json 同处；明文文件才是事实源，进程重启后 resume 还能读回来。
 */
export const SESSION_FILE = "session.json";

export interface EmployeeSessionRecord {
  ticket_id: string;
  seq: number;
  employee: WorkerKind;
  session_id: string;
  updated_at: string;
}

export function sessionFileFor(taskDir: string): string {
  return path.join(taskDir, SESSION_FILE);
}

/** 每次外部执行拿到会话号就落盘；没有会话号不写，免得拿旧号冒充这次。 */
export function writeSessionRecord(taskDir: string, record: EmployeeSessionRecord): void {
  writeJson(sessionFileFor(taskDir), record);
}

/** 读会话号；文件缺失 / 坏了 / 空串一律当没有——重派，不假装续接。 */
export function readSessionId(taskDir: string): string | null {
  const raw = readJson<{ session_id?: unknown }>(sessionFileFor(taskDir));
  if (!raw || typeof raw.session_id !== "string") return null;
  const sessionId = raw.session_id.trim();
  return sessionId === "" ? null : sessionId;
}

/** 外部 CLI 才有「带 -r 续接」这回事；原生 / MCP / 手机各有自己的 resume 语义。 */
const EXTERNAL_CLI_KINDS = new Set<WorkerKind>([
  "codebuddy",
  "mercenary",
  "qoder-intl",
  "qoder-cn",
  "claude-code",
  "codex",
  "opencode",
  "doubao",
]);

export function isExternalCli(kind: WorkerKind): boolean {
  return EXTERNAL_CLI_KINDS.has(kind);
}

export const RESUME_NOTICE_UNSUPPORTED =
  "该执行者不支持续跑，已重派新单，上一段上下文不延续";
export const RESUME_NOTICE_NO_SESSION =
  "没有可续接的会话号，已重派新单，上一段上下文不延续";
export const RESUME_NOTICE_DISABLED =
  "CHANCELLOR_RESUME_EXTERNAL=false，已重派新单，上一段上下文不延续";

export interface ResumeDecision {
  /** session = 真带 -r 续接；redispatch = 重派新单；employee = 雇员自己的 resume。 */
  mode: "session" | "redispatch" | "employee";
  /** 非 null 时必须原样回报给模型 / 用户——不许静默丢上下文。 */
  notice: string | null;
}

/**
 * 续跑分档：能力看雇员档的 `resumeWithSession`，不硬编码名字。
 * 闸门优先——关掉后连能力也不看，外部单一律重派。
 */
export function decideResume(kind: WorkerKind, sessionId: string | null): ResumeDecision {
  if (!isExternalCli(kind)) return { mode: "employee", notice: null };
  if (!externalResumeEnabled()) {
    return { mode: "redispatch", notice: RESUME_NOTICE_DISABLED };
  }
  if (capabilitiesOf(kind).resumeWithSession !== true) {
    return { mode: "redispatch", notice: RESUME_NOTICE_UNSUPPORTED };
  }
  if (!sessionId) return { mode: "redispatch", notice: RESUME_NOTICE_NO_SESSION };
  return { mode: "session", notice: null };
}

export async function dispatchTask(
  ticket: Ticket,
  task: PlannedTask,
  seq: number,
  ticketDir: string,
  signal?: AbortSignal,
  deps: DependencyReport[] = [],
  options: DispatchOptions = {},
): Promise<TaskRun> {
  const dirName = taskDirName(seq, task.slug);
  const dir = path.join(ticketDir, dirName);
  const workDir = options.workDir;
  const kind = options.employeeKind ?? EMPLOYEE;
  // 取消发生在等车道槽位时：不建 TASK.md、不起雇员，直接回一张 aborted 的单。
  // 车道闸门在 signal 中止时会返回 granted=false，不会占槽；这里把收尾做实。
  if (signal?.aborted) {
    return {
      ticketId: ticket.id,
      seq,
      task,
      dir,
      dirName,
      employee: kind,
      exitCode: null,
      timedOut: false,
      aborted: true,
      processOk: false,
      processError: "已停止",
      sessionId: null,
      reportExists: false,
      report: null,
      reportError: "已停止",
      stderrTail: "",
      ...(workDir ? { workDir } : {}),
    };
  }
  ensureDir(dir);
  // 步骤文件与本次尝试同生命周期：重试 / 续跑开头先清掉上一轮的，避免把旧步骤当新过程。
  const stepsFile = path.join(dir, STEPS_FILE);
  fs.rmSync(stepsFile, { force: true });
  const captureSteps = options.streamEvents ?? cliStreamEventsEnabled();
  const steps: CliStepEvent[] = [];
  const stepSink = captureSteps
    ? (step: CliStepEvent): void => {
        steps.push(step);
        appendStep(stepsFile, step);
        options.onStep?.(seq, task.slug, step);
      }
    : undefined;
  const prompt = buildWorkerPrompt(
    task,
    dirName,
    deps,
    workDir ? { workDir, taskDir: dir } : undefined,
    options.projectRoots,
  );
  writeText(path.join(dir, "TASK.md"), prompt);

  const employee = options.employeeFactory?.(kind) ?? createEmployee(kind);
  const resumeAnswer = options.resumeAnswer;
  // 会话号只从落盘读：进程重启后同一张单续跑仍拿得到（2026-11-08 8f）。
  const storedSessionId = resumeAnswer === undefined ? null : readSessionId(dir);
  const resumeDecision =
    resumeAnswer === undefined ? null : decideResume(kind, storedSessionId);
  const employeeTask = {
    instruction: task.instruction,
    doneWhen: task.done_when,
    upstream: deps.length === 0 ? "" : renderUpstream(deps),
    writes: task.writes,
    dir,
    ...(workDir ? { workDir } : {}),
    ...(options.projectRoots?.length ? { projectRoots: [...options.projectRoots] } : {}),
    // 只有分档判成真续接才把会话号交给雇员；重派时故意不传，避免假续接。
    ...(resumeDecision?.mode === "session" && storedSessionId
      ? { sessionId: storedSessionId }
      : {}),
    // 模型 / 权限：建单快照或当前派单参数；没有就不传，雇员回落到 env 缺省。
    ...(options.employeeProfile ? { settings: options.employeeProfile } : {}),
    // 决策上报（2026-11-19 批2）：池 worker 跑动中的上报经 SSE 事件回到这里，
    // 再沿 onEscalation 上送；续跑（resume）同样带上。
    ...(options.onEscalation ? { onEscalation: options.onEscalation } : {}),
    // 流式步骤（2026-11-23）：只有四档外部 CLI 会调用；不传 = 旧行为。
    ...(stepSink ? { onStep: stepSink } : {}),
  };
  const response =
    resumeAnswer === undefined
      ? await employee.run(employeeTask, signal)
      : await resumeEmployee(employee, employeeTask, resumeAnswer, signal);
  const sessionId = response.sessionId?.trim() || null;
  // 与 employee 输出同处落盘；没有会话号不写，免得拿旧号冒充这次。
  if (sessionId) {
    writeSessionRecord(dir, {
      ticket_id: ticket.id,
      seq,
      employee: kind,
      session_id: sessionId,
      updated_at: new Date().toISOString(),
    });
  }

  const reportPath = path.join(dir, "REPORT.md");
  const reportExists = fs.existsSync(reportPath) || response.reportRaw !== null;
  const reportRaw = response.reportRaw ?? "";
  const parsed: ParsedReport = reportExists
    ? parseWorkerReport(reportRaw)
    : { report: null, error: "REPORT.md 缺失" };
  const toolStats = summarizeSteps(steps);

  return {
    ticketId: ticket.id,
    seq,
    task,
    dir,
    dirName,
    employee: kind,
    exitCode: response.exitCode,
    timedOut: response.timedOut,
    aborted: response.aborted,
    processOk: response.processOk,
    processError: response.processOk
      ? null
      : (response.error ?? "worker 进程失败"),
    sessionId,
    reportExists,
    report: parsed.report,
    reportError: parsed.error,
    stderrTail: response.stderrTail,
    ...(workDir ? { workDir } : {}),
    ...(toolStats.total > 0 || toolStats.failed > 0 ? { toolStats } : {}),
  };
}

export function parseWorkerReport(raw: string): ParsedReport {
  const match = /```json\s*([\s\S]*?)```/i.exec(raw);
  if (!match || match[1] === undefined) {
    return { report: null, error: "REPORT.md 里没有 ```json 代码块" };
  }
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch (error) {
    return { report: null, error: `REPORT.md 的 json 无法解析：${messageOf(error)}` };
  }
  if (data === null || typeof data !== "object") {
    return { report: null, error: "REPORT.md 的 json 不是对象" };
  }
  const obj = data as Record<string, unknown>;
  const status = normalizeWorkerStatus(obj.status);
  if (status === null) {
    return {
      report: null,
      error: "status 必须是 ready / waiting / blocked / failed / dropped / progress（老数据 done 也认）",
    };
  }
  if (typeof obj.summary !== "string") {
    return { report: null, error: "summary 缺失或不是字符串" };
  }
  const artifactsRaw = obj.artifacts ?? [];
  if (!Array.isArray(artifactsRaw) || artifactsRaw.some((item) => typeof item !== "string")) {
    return { report: null, error: "artifacts 必须是字符串数组" };
  }
  const attention = parseAttention(obj.attention);
  return {
    report: {
      status,
      summary: obj.summary,
      artifacts: artifactsRaw as string[],
      ...(attention ? { attention } : {}),
      raw,
    },
    error: null,
  };
}

const WORKER_STATUSES = new Set<WorkerStatus>([
  "ready",
  "waiting",
  "blocked",
  "failed",
  "dropped",
  "progress",
]);

/** 老 worker 只会写 done/blocked/failed；done 一律当 ready 读。 */
function normalizeWorkerStatus(raw: unknown): WorkerStatus | null {
  if (typeof raw !== "string") return null;
  const status = raw === "done" ? "ready" : raw;
  return WORKER_STATUSES.has(status as WorkerStatus) ? (status as WorkerStatus) : null;
}

const ATTENTION_KINDS = new Set<AttentionKind>([
  "need_input",
  "need_decision",
  "need_action",
]);

/** attention 是可选的；格式不对就当没填，不影响整份报告。 */
function parseAttention(raw: unknown): WorkerAttention | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.question !== "string" || obj.question.trim() === "") return undefined;
  const kind = obj.kind;
  if (typeof kind !== "string" || !ATTENTION_KINDS.has(kind as AttentionKind)) {
    return undefined;
  }
  return { question: obj.question.trim(), kind: kind as AttentionKind };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
