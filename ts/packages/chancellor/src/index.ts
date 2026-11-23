import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { assertMcpConfigured, DELEGATION_RESUME_POLICY, EMPLOYEE, MAX_TASKS_DEFAULT, resolveProfile } from "./config.ts";
import { decideResume, parseWorkerReport, readSessionId, taskDirName } from "./dispatch.ts";
import { assertPhoneConfigured, capabilitiesOf } from "./employee/index.ts";
import { runManager, type ManagerOutcome } from "./employee/manager.ts";
import { intake } from "./intake.ts";
import { ensureManager, listManagers, readManagerMeta } from "./manager/registry.ts";
import { acquireAdmission, type AdmissionLease } from "./admission.ts";
import { acquireDomain, type LaneLease } from "./lane.ts";
import { classifyRunFailure } from "./failure-class.ts";
import { isPidAlive, releaseStaleLeases } from "./lease.ts";
import { planTicket } from "./plan.ts";
import {
  renderAbortedLine,
  renderAttentionLine,
  renderDroppedLine,
  renderDryLine,
  renderErrorLine,
  renderIdleLine,
  renderPlanFailureLine,
  renderResultLine,
  sanitizeLine,
} from "./report.ts";
import {
  classifyRun,
  decideOutcome,
  enforceChildClosure,
  runReason,
  type RunStage,
} from "./stage.ts";
import { runScheduledTasks, runSingleTask } from "./scheduler.ts";
import { readJson, readText, Store, writeJson, type TicketProgress } from "./store.ts";
import type {
  ChancellorEvent,
  ChancellorOptions,
  ChancellorRequest,
  ChancellorTaskResult,
  DependencyReport,
  EmployeeProfile,
  EventSink,
  ManagerRunRecord,
  PlannedTask,
  PlannedTaskInfo,
  ProjectRef,
  Task,
  TaskRun,
  TaskStatus,
  Ticket,
  TicketOutcomeStatus,
  TicketResult,
  TicketStage,
  TicketStatus,
  WorkerAttention,
  WorkerKind,
} from "./types.ts";

export type {
  ChancellorEvent,
  ChancellorOptions,
  ChancellorRequest,
  ChancellorTaskResult,
  PlannedTaskInfo,
  TicketResult,
} from "./types.ts";

export type { PhoneResult, PhoneTask, PhoneTransport } from "./employee/index.ts";
export {
  createPhoneEmployee,
  PhoneTaskTimeoutError,
  registerPhoneTransport,
} from "./employee/index.ts";

// 内部质检（拆单 / 验收 / 目标核对）的模型注入缝（2026-11-16）：
// 宿主启动时注入核心模型调用；不注入 = 回 Qoder（standalone / 旧测试）。
export { setInternalAsk, type InternalAsk } from "./internal.ts";

import {
  clearInflight,
  inflightPath,
  readInflight,
  startInflight,
  type InflightRecord,
} from "./inflight.ts";

/**
 * 事件 → 落盘的进度字段（2026-11-04）：最近动作就是事件里那句话，
 * 「等哪个文件」只在 task-waiting 时写，其它事件一律清掉（任务已经继续跑了）。
 * 只是展示用的近况，落盘由 Store.saveTicketProgress 节流。
 */
function progressOfEvent(event: ChancellorEvent): TicketProgress {
  const action = sanitizeLine(
    event.message?.trim() ||
      (event.slug
        ? `${event.type === "task-done" ? "完成" : "进行"}：${event.slug}`
        : ""),
    120,
  );
  return {
    ...(action !== "" ? { action } : {}),
    waitingOn: event.type === "task-waiting" ? (event.waitingOn ?? action) : null,
    heartbeat: new Date().toISOString(),
  };
}

/**
 * chancellor 的唯一入口。纯库：不含 CLI 副作用，进度只走 onEvent。
 * line 是唯一给人看的一句话。
 */
export async function runChancellor(
  req: ChancellorRequest,
  opts: ChancellorOptions = {},
): Promise<TicketResult> {
  const resumeTicketId =
    typeof req.resumeTicketId === "string" ? req.resumeTicketId.trim() : "";
  if (resumeTicketId !== "") return resumeTicket(req, resumeTicketId, opts);

  const requirement = typeof req.requirement === "string" ? req.requirement.trim() : "";
  if (!requirement) {
    throw new Error("requirement 不能为空（续跑请提供 resumeTicketId + answer）");
  }
  // 2026-11-16 多 CLI：派单可以点名 worker；不点名就按全局 CHANCELLOR_EMPLOYEE。
  const employee = workerKindOf(req.employee) ?? EMPLOYEE;
  // 模型 / 权限按「显式请求 > 该 CLI 的 env 缺省」合并；建单时快照进 ticket.options。
  const employeeProfile = resolveProfile(employee, req.employeeProfile);
  const storedProfile =
    employeeProfile.model || employeeProfile.permission ? employeeProfile : undefined;
  // 配置不全必须在收单前报错；静默退回原生会让人以为活派到手机上了。
  if (employee === "mcp") assertMcpConfigured();
  if (employee === "phone") assertPhoneConfigured();

  const maxTasks = clamp(req.maxTasks ?? MAX_TASKS_DEFAULT, 1, 5);
  const dry = req.dry === true;
  const workRoot = path.resolve(
    req.workRoot && req.workRoot.trim() !== ""
      ? req.workRoot
      : path.join(process.cwd(), "runs"),
  );

  const store = new Store(workRoot);
  const notify: EventSink = opts.onEvent ?? (() => {});
  const signal = opts.signal;
  const idempotencyKey =
    typeof req.idempotencyKey === "string" ? req.idempotencyKey.trim() : "";

  if (idempotencyKey !== "") {
    const existingId = store.ticketIdByIdempotencyKey(idempotencyKey);
    const existing = existingId
      ? readJson<Ticket>(path.join(store.ticketDir(existingId), "ticket.json"))
      : null;
    if (existing) {
      const result = resultFromExistingTicket(store, existing);
      if (opts.onEvent) {
        opts.onEvent({ type: "finished", ticketId: existing.id, message: result.line });
      }
      return result;
    }
    // 索引和明文都没有：这是该 key 第一次收单。
  }

  // 只有总管明确给了 domain、且没被硬关掉时才走分管；否则完全按 v0.3。
  const domain = typeof req.domain === "string" ? req.domain.trim() : "";
  const useManager = domain !== "" && req.managers !== false;
  // 项目由总管校验并下发；这里只做形状收敛，不猜路径。
  const project = normalizeProject(req.project);

  const ticket = intake(
    store,
    requirement,
    {
      dry,
      maxTasks,
      workRoot,
      ...(useManager ? { domain } : {}),
      ...(project ? { project } : {}),
      ...(storedProfile ? { employeeProfile: storedProfile } : {}),
      // 工作目录（2026-11-17）：宿主已校验；空串 / 非字符串一律当没传，旧 ticket 形状不变
      ...(typeof req.workDir === "string" && req.workDir.trim() !== ""
        ? { workDir: req.workDir.trim() }
        : {}),
    },
    useManager ? "manager" : employee,
    idempotencyKey || undefined,
    typeof req.parentTicketId === "string" && req.parentTicketId.trim() !== ""
      ? req.parentTicketId.trim()
      : undefined,
    // 宿主对话标识只透传：原样落盘，不解析、不参与路由（2026-11-05 跨仓契约）。
    typeof req.originConversationId === "string" && req.originConversationId.trim() !== ""
      ? req.originConversationId.trim()
      : undefined,
    // 计划附件（2026-11-09 §2）：宿主已校验；空数组不落键，旧 ticket 形状不变。
    Array.isArray(req.steps) && req.steps.length > 0 ? req.steps : undefined,
    // 预分配单号（2026-11-22 前端直派任务）：宿主先建专线再落单。
    typeof req.ticketId === "string" && req.ticketId.trim() !== ""
      ? req.ticketId.trim()
      : undefined,
  );
  // 进行中标记：进程被杀后靠它判断这张单断在哪一步；dry 单不派活、已终态的幂等命中也不记。
  if (!dry && !FINAL_TICKET_STATUSES.has(ticket.status)) {
    startInflight(store.ticketDir(ticket.id), ticket.id);
  }
  // 事件出口统一在这里接一层：先落进度，再照原样推给宿主。
  const emit: EventSink = (event) => {
    store.saveTicketProgress(ticket, progressOfEvent(event));
    notify(event);
  };
  const emitFor = (
    type: ChancellorEvent["type"],
    extra: { seq?: number; slug?: string; message?: string; total?: number } = {},
  ): void => {
    emit({ type, ticketId: ticket.id, ...extra });
  };

  // 单号必须在第一个 await 之前同步发出：宿主 startDelegation 的 launch 靠同步段拿到
  // ticketId（「立即受理」），否则 delegate 工具会先返回空单号。排队 / 拒绝都是之后的事。
  emitFor("ticket", {
    message: useManager ? "收单，交给分管领域" : "收单，开始拆单",
  });

  // ticket 准入闸（2026-11-22 M1b）：intake 之后、拆单之前。
  // dry 不派活，也不该占名额；单号已经发出，排队 / 拒绝都能立刻回报宿主。
  let admission: AdmissionLease | null = null;
  if (!dry) {
    admission = await acquireAdmission({
      domain: useManager ? domain : "",
      priority: req.priority ?? 5,
      ...(signal ? { signal } : {}),
      onWait: (info) =>
        emitFor("ticket", { message: `排队中：前面 ${Math.max(0, info.position - 1)} 单` }),
    });
    if (!admission.granted) {
      if (admission.reason === "queue_full") {
        // 队列满是业务拒绝：明确失败，别让单子停在 received 里等一个不会来的槽。
        ticket.stage = "failed";
        store.setTicketStatus(ticket, "failed", "排队已满，稍后再试");
        const line = "排队已满，稍后再试";
        emitFor("finished", { message: line });
        return { ticketId: ticket.id, status: "failed", line, tasks: [] };
      }
      // 排队中被取消：setTicketStatus 到终态会顺手清 inflight，不留僵尸在跑。
      ticket.stage = "aborted";
      store.setTicketStatus(ticket, "aborted", "已停止");
      const line = renderAbortedLine(0);
      emitFor("finished", { message: line });
      return { ticketId: ticket.id, status: "aborted", line, tasks: [] };
    }
  }

  try {
  if (useManager) {
    // 必须 await：直接 return Promise 时 finally 会在 manager 还没跑完就执行，
    // 准入名额提前放掉，同领域的下一张单会在 manager 进程还活着时挤进来。
    return await runManagerTicket(
      ticket,
      store,
      requirement,
      domain,
      dry,
      emitFor,
      signal,
      employee,
      employeeProfile,
      req.managerIdentity,
      ticket.originConversationId ?? undefined,
    );
  }

  const ticketDir = store.ticketDir(ticket.id);

  /** 一轮 = 拆单 → 执行 → 收口（2026-11-19 起没有验收 / 返工）。 */
  const runRound = async (roundRequirement: string): Promise<TicketResult> => {
    store.setTicketStatus(ticket, "planning");
    // 修复轮的 prompt 只给规划器看；ticket.prompt 保留原始要求（详情不换正文）。
    const planResult = await planTicket(
      roundRequirement === ticket.prompt ? ticket : { ...ticket, prompt: roundRequirement },
      maxTasks,
      signal,
      capabilitiesOf(employee),
      employee,
    );
    writeJson(path.join(ticketDir, "plan.json"), {
      ticket: ticket.id,
      employee,
      ok: planResult.ok,
      tasks: planResult.tasks,
      droppedDeps: planResult.droppedDeps,
      error: planResult.error,
      attempts: planResult.attempts,
      created_at: new Date().toISOString(),
    });

    if (!planResult.ok) {
      if (signal?.aborted) {
        ticket.stage = "aborted";
        store.setTicketStatus(ticket, "aborted", "已停止");
        const line = renderAbortedLine(0);
        emitFor("finished", { message: line });
        return { ticketId: ticket.id, status: "aborted", line, tasks: [] };
      }
      ticket.stage = "person/blocked";
      store.setTicketStatus(ticket, "needs_you", planResult.error);
      const line = renderPlanFailureLine(ticket.id, planResult.error ?? "拆单失败");
      emitFor("planned", { message: planResult.error ?? "拆单失败" });
      emitFor("finished", { message: line });
      return { ticketId: ticket.id, status: "needs_you", line, tasks: [] };
    }

    const taskRows: Task[] = planResult.tasks.map((task, index) => {
      const seq = index + 1;
      return {
        ticket_id: ticket.id,
        seq,
        slug: task.slug,
        title: task.title,
        dir: taskDirName(seq, task.slug),
        status: "pending",
        employee,
        updated_at: new Date().toISOString(),
      };
    });
    for (const row of taskRows) store.saveTask(row);
    emitFor("planned", {
      total: planResult.tasks.length,
      message: `拆出 ${planResult.tasks.length} 个任务：${planResult.tasks
        .map((task) => task.slug)
        .join("、")}`,
    });

    if (dry) {
      store.setTicketStatus(ticket, "planned");
      const line = renderDryLine(planResult.tasks.map((task) => task.title));
      const plannedTasks: PlannedTaskInfo[] = planResult.tasks.map((task, index) => ({
        seq: index + 1,
        slug: task.slug,
        title: task.title,
        done_when: task.done_when,
        dependsOn: task.dependsOn,
      }));
      emitFor("finished", { message: line });
      return { ticketId: ticket.id, status: "done", line, tasks: [], plannedTasks };
    }

    store.setTicketStatus(ticket, "dispatching");
    const scheduled = await runScheduledTasks({
      ticket,
      store,
      tasks: planResult.tasks,
      rows: taskRows,
      project,
      signal,
      employeeKind: employee,
      ...(storedProfile ? { employeeProfile: storedProfile } : {}),
      emit: (event) => emit({ ...event, ticketId: ticket.id }),
      // 决策上报（2026-11-19 批2）：worker 跑动中的 escalation 原样包成事件推给宿主；
      // 路由 / 限流 / 答复都在宿主侧，chancellor 只透传。
      onEscalation: (escalation) =>
        emit({
          type: "escalation",
          ticketId: ticket.id,
          escalation,
        }),
    });

    return await finishRuns({
      ticket,
      store,
      taskRows,
      runs: scheduled.runs,
      emitFor,
      signal,
    });
  };

  try {
    return await runRound(requirement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ticket.stage = "failed";
      store.setTicketStatus(ticket, "failed", message);
    } catch {
      /* 记录失败不能覆盖原始错误 */
    }
    const line = renderErrorLine(ticket.id, message);
    emitFor("finished", { message: line });
    return { ticketId: ticket.id, status: "failed", line, tasks: [] };
  }
  } finally {
    // 所有 return（含 manager 分支与 runRound 的 catch）都经过这里，名额不会漏还。
    admission?.release();
  }
}


interface FinishRunsContext {
  ticket: Ticket;
  store: Store;
  taskRows: Task[];
  runs: TaskRun[];
  emitFor: (
    type: ChancellorEvent["type"],
    extra?: { seq?: number; slug?: string; message?: string; total?: number },
  ) => void;
  signal?: AbortSignal;
}

/**
 * 派活之后的统一收口（2026-11-19 删掉验收层）：
 * 任务终态只认执行事实（classifyRun），不再有验收 / 返工 / 裁判 / 目标核对。
 */
async function finishRuns(ctx: FinishRunsContext): Promise<TicketResult> {
  const { ticket, store, taskRows, runs, emitFor, signal } = ctx;
  // 失败分类（2026-11-22 M3）：每个 run 都填一份，供任务中心 / 后续重试看。
  // 成功执行是 unknown（"unknown" 兼作「没认出发败因」），不新增对外状态。
  for (const run of runs) run.failureClass = classifyRunFailure(run);
  const aborted = signal?.aborted === true || runs.some((run) => run.aborted);
  const decision = aborted ? { kind: "aborted" as const } : decideOutcome(runs);

  for (const row of taskRows) {
    row.status = taskRowStatusOf(runs.find((item) => item.seq === row.seq));
    row.updated_at = new Date().toISOString();
    store.saveTask(row);
  }

  const resultTasks: ChancellorTaskResult[] = taskRows.map((row) => {
    const run = runs.find((item) => item.seq === row.seq);
    return {
      seq: row.seq,
      slug: row.slug,
      title: row.title,
      status: taskResultStatusOf(run),
      reason: run ? runReason(run) : "未执行",
      dir: path.join(store.ticketDir(ticket.id), row.dir),
      ...(run?.report?.attention ? { attention: run.report.attention } : {}),
    };
  });
  const ticketAttention = resultTasks.find((item) => item.attention)?.attention;

  if (decision.kind === "aborted") {
    ticket.stage = "aborted";
    store.setTicketStatus(ticket, "aborted", "已停止");
    const line = renderAbortedLine(resultTasks.filter((task) => task.status === "passed").length);
    emitFor("finished", { message: line });
    return {
      ticketId: ticket.id,
      status: "aborted",
      line,
      tasks: resultTasks,
      ...(ticketAttention ? { attention: ticketAttention } : {}),
    };
  }

  let status: TicketOutcomeStatus;
  let stage: TicketStage;
  let line: string;
  let error: string | null;

  if (decision.kind === "failed") {
    status = "failed";
    stage = "failed";
    line = renderResultLine({ total: runs.length, runs });
    error = decision.runs[0] ? runReason(decision.runs[0]) : "有 task 失败";
  } else if (decision.kind === "needs_you") {
    status = "needs_you";
    stage = decision.stage;
    if (decision.stage === "person/answer") {
      line = renderAttentionLine(decision.runs);
      error = ticketAttention
        ? `需要你（${ticketAttention.kind}）：${ticketAttention.question}`
        : "有 task 在等人回话";
    } else {
      line = renderResultLine({ total: runs.length, runs });
      error = decision.runs[0] ? runReason(decision.runs[0]) : "有 task 卡住了";
    }
  } else if (decision.kind === "idle") {
    status = "idle";
    stage = "idle";
    line = renderIdleLine(decision.runs);
    error = `等下一个触发：${decision.runs
      .map((run) => run.report?.summary ?? "等下一个触发")
      .join("；")}`;
  } else {
    status = "done";
    stage = "done";
    const allDropped = runs.every((run) => classifyRun(run) === "dropped");
    line = allDropped
      ? renderDroppedLine(runs)
      : renderResultLine({ total: runs.length, runs });
    error = null;
  }

  ticket.stage = stage;
  store.setTicketStatus(ticket, status, error);
  emitFor("finished", { message: line });
  return {
    ticketId: ticket.id,
    status,
    line,
    tasks: resultTasks,
    ...(ticketAttention ? { attention: ticketAttention } : {}),
  };
}


function taskResultStatusOf(run: TaskRun | undefined): ChancellorTaskResult["status"] {
  if (!run) return "blocked";
  switch (classifyRun(run)) {
    case "ready":
      return "passed";
    case "dropped":
      return "dropped";
    case "idle":
      return "waiting";
    case "failed":
      return "failed";
    case "aborted":
    case "person/answer":
    case "person/blocked":
      return "blocked";
  }
}

function taskRowStatusOf(run: TaskRun | undefined): TaskStatus {
  if (!run) return "blocked";
  switch (classifyRun(run)) {
    case "ready":
      return "passed";
    case "dropped":
      return "dropped";
    case "idle":
      return "waiting";
    case "failed":
      return "failed";
    case "aborted":
    case "person/answer":
    case "person/blocked":
      return "blocked";
  }
}


const FINAL_TICKET_STATUSES = new Set<TicketStatus>([
  "done",
  "needs_you",
  "failed",
  "idle",
  "aborted",
]);

/**
 * 幂等命中：不重跑，把已有单从明文记录还原成 TicketResult。
 * 汇报行优先用 plan.json 里存下的原句；还原不出就明说命中了旧单。
 */
function resultFromExistingTicket(store: Store, ticket: Ticket): TicketResult {
  const dir = store.ticketDir(ticket.id);
  const plan = readJson<{
    tasks?: Array<{ title: string; slug: string }>;
    manager?: { line?: string };
  }>(path.join(dir, "plan.json"));
  const planned = plan?.tasks ?? [];

  // 单还在跑（或上一次进程死在半路）时，5 个对外状态里没有「进行中」；
  // 用 idle 表示「现在不用你做任何事」，并在行里说清没有重复执行。
  const running = !FINAL_TICKET_STATUSES.has(ticket.status) && ticket.status !== "planned";
  const status: TicketOutcomeStatus = running
    ? "idle"
    : ticket.status === "planned"
      ? "done"
      : (ticket.status as string) === "blocked"
        ? "needs_you"
        : (ticket.status as TicketOutcomeStatus);

  const tasks: ChancellorTaskResult[] = planned.map((task, index) => {
    const seq = index + 1;
    return {
      seq,
      slug: task.slug,
      title: task.title,
      status: status === "done" ? "passed" : status === "idle" ? "waiting" : "blocked",
      reason:
        status === "idle"
          ? "未完成：等下一个触发"
          : (ticket.error ?? (status === "done" ? "完成" : "未完成")),
      dir: path.join(dir, taskDirName(seq, task.slug)),
    };
  });

  let line: string;
  if (running) {
    line = `⏸ 同一 idempotencyKey 的单还在处理（${ticket.id}），未重复执行。`;
  } else if (ticket.status === "aborted") {
    line = renderAbortedLine(0);
  } else if (ticket.error?.startsWith("需要你（")) {
    // attention 的 question 可能带路径，不能再过 sanitizeLine。
    line = `⚠ ${ticket.error.slice(0, 240)}`;
  } else if (plan?.manager?.line) {
    line = plan.manager.line;
  } else if (planned.length > 0) {
    line =
      status === "done"
        ? `✓ ${planned.length} 个任务已完成（幂等命中 ${ticket.id}）。`
        : `↩ 幂等命中：${ticket.id}（${status}）${ticket.error ? `：${ticket.error}` : ""}。`;
  } else if (ticket.error) {
    line = renderPlanFailureLine(ticket.id, ticket.error);
  } else {
    line = `↩ 幂等命中：返回已有单 ${ticket.id}（${status}），未重复执行。`;
  }

  return { ticketId: ticket.id, status, line, tasks };
}

/**
 * 启动时的崩溃恢复（2026-11-03 方案 §5.7）。
 *
 * 只扫「还留着 inflight.json」的单，按四类结算：
 * - still_running：pid 还活着，不动；
 * - finished_with_result：单已终态，只清标记；
 * - cut_off：进程没了；没跨过合并点且策略允许时自动续一次，否则转「待你处理」；
 * - unknown：连 ticket.json 都没有，写 recovery.json 留证后清标记。
 *
 * 每进程每个 workRoot 只跑一次；不阻塞新派单以外的任何事，但不主动打扰用户。
 */
export interface RecoverySummary {
  scanned: number;
  stillRunning: number;
  finished: number;
  resumed: number;
  needsYou: number;
  unknown: number;
  lines: string[];
}

/**
 * 逐单结算结果（2026-11-04，A3b）。
 *
 * 宿主拿它把「上一进程留下的单最后怎么了」写回原对话。status 复用对外 5 态，
 * 不另造词；`still_running` / `unknown` 只是内部占位，由宿主按 5 态过滤后丢弃。
 */
export interface RecoveredTicket {
  ticketId: string;
  /** 现成对外语汇（types.ts 的 TicketOutcomeStatus）；另两个是内部占位 */
  status: TicketOutcomeStatus | "still_running" | "unknown";
  projectId?: string;
  /** ticket.error；needs_you 的 reason 已由 markRecoveredNeedsYou 写进这里 */
  error?: string;
}

type TicketCallback = (entry: RecoveredTicket) => void | Promise<void>;

const recoveredRoots = new Set<string>();

export async function recoverDelegations(
  workRoot: string,
  opts: { log?: (line: string) => void; onTicket?: TicketCallback } = {},
): Promise<RecoverySummary> {
  const root = path.resolve(workRoot);
  const summary: RecoverySummary = {
    scanned: 0,
    stillRunning: 0,
    finished: 0,
    resumed: 0,
    needsYou: 0,
    unknown: 0,
    lines: [],
  };
  const key = root.toLowerCase();
  if (recoveredRoots.has(key)) return summary;
  recoveredRoots.add(key);

  const log = (line: string): void => {
    summary.lines.push(line);
    opts.log?.(line);
  };

  for (const scanRoot of recoveryRoots(root)) {
    for (const dir of ticketDirsWithInflight(scanRoot)) {
      summary.scanned += 1;
      // 集中打点（S8）：每个目录只在循环尾把结果交出去一次，不在各结算分支里逐处插桩。
      const entry = await settleTicketDir(scanRoot, dir, summary, log, opts.onTicket);
      if (entry) await notifyTicket(entry, opts.onTicket);
    }
  }

  return summary;
}

/**
 * 结算一个带 inflight 标记的目录。返回要回传给宿主的单条结果；
 * `null` = 已在 autoResumeTicket 内部上报过，循环尾别再报一次。
 */
async function settleTicketDir(
  scanRoot: string,
  dir: string,
  summary: RecoverySummary,
  log: (line: string) => void,
  onTicket?: TicketCallback,
): Promise<RecoveredTicket | null> {
  const dirName = path.basename(dir);
  const record = readInflight(dir);
  if (!record) {
    summary.unknown += 1;
    log(`[恢复] ${dirName}：inflight 不可读，已跳过`);
    clearInflight(dir);
    return { ticketId: dirName, status: "unknown" };
  }
  const ticket = readJson<Ticket>(path.join(dir, "ticket.json"));
  if (!ticket) {
    summary.unknown += 1;
    writeJson(path.join(dir, "recovery.json"), {
      at: new Date().toISOString(),
      status: "unknown",
      reason: "缺 ticket.json",
    });
    clearInflight(dir);
    log(`[恢复] ${dirName}：缺 ticket.json，已标未知`);
    return { ticketId: dirName, status: "unknown" };
  }
  if (FINAL_TICKET_STATUSES.has(ticket.status)) {
    summary.finished += 1;
    clearInflight(dir);
    log(`[恢复] ${ticket.id}：已终态（${ticket.status}），清理进行中标记`);
    return recoveredEntry(ticket);
  }
  if (isPidAlive(record.pid)) {
    summary.stillRunning += 1;
    log(`[恢复] ${ticket.id}：原进程 ${record.pid} 仍在跑，不接管`);
    return { ...recoveredEntry(ticket), status: "still_running" };
  }

  releaseTicketLeases(ticket);

  if (record.merged) {
    summary.needsYou += 1;
    markRecoveredNeedsYou(rootOf(scanRoot), ticket, "已合并进项目，需人工确认是否继续");
    log(`[恢复] ${ticket.id}：已跨过合并点，转待你处理`);
    return recoveredEntry(ticket);
  }
  if (DELEGATION_RESUME_POLICY === "never") {
    summary.needsYou += 1;
    markRecoveredNeedsYou(rootOf(scanRoot), ticket, "中断：策略为不自动续跑");
    log(`[恢复] ${ticket.id}：DELEGATION_RESUME_POLICY=never，转待你处理`);
    return recoveredEntry(ticket);
  }
  if (DELEGATION_RESUME_POLICY === "always-ask") {
    summary.needsYou += 1;
    markRecoveredNeedsYou(rootOf(scanRoot), ticket, "中断：需要确认后继续");
    log(`[恢复] ${ticket.id}：策略为等人确认，转待你处理`);
    return recoveredEntry(ticket);
  }
  if (record.resumeCount >= 1) {
    summary.needsYou += 1;
    markRecoveredNeedsYou(rootOf(scanRoot), ticket, "中断：已自动续跑过一次，仍中断");
    log(`[恢复] ${ticket.id}：已自动续跑过一次，转待你处理`);
    return recoveredEntry(ticket);
  }

  const resumed = await autoResumeTicket(rootOf(scanRoot), dir, ticket, record, onTicket);
  if (resumed) {
    summary.resumed += 1;
    log(`[恢复] ${ticket.id}：断在半路，已自动续跑`);
    // 续跑是 await 跑完的，这里 ticket.status 已是真实终态。
    return recoveredEntry(ticket);
  }
  summary.needsYou += 1;
  log(`[恢复] ${ticket.id}：无法自动续跑，转待你处理`);
  // 两个失败出口已在 autoResumeTicket 里上报（含真实 status / error）。
  return null;
}

/** 结算结果 → 回传形状。终态单的 status 直接取 ticket 上的值。 */
function recoveredEntry(ticket: Ticket): RecoveredTicket {
  const projectId = ticket.options.project?.id;
  return {
    ticketId: ticket.id,
    status: ticket.status as RecoveredTicket["status"],
    ...(projectId ? { projectId } : {}),
    ...(ticket.error ? { error: ticket.error } : {}),
  };
}

/** 回调允许异步；异常吞掉——宿主写回失败不能反过来影响结算。 */
async function notifyTicket(entry: RecoveredTicket, onTicket?: TicketCallback): Promise<void> {
  if (!onTicket) return;
  try {
    await onTicket(entry);
  } catch {
    // 回调异常只影响回灌本身；恢复计数与本地状态已经落好。
  }
}

/** 顶层 workRoot + 各分管领域自己的 runs 目录。 */
function recoveryRoots(root: string): string[] {
  const roots = [root];
  for (const manager of listManagers(root)) {
    const runs = manager.meta?.runs_dir;
    if (runs && path.resolve(runs) !== root) roots.push(path.resolve(runs));
  }
  return roots;
}

function ticketDirsWithInflight(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(inflightPath(dir)));
}

/**
 * ticket 所在的 workRoot：顶层单就是扫描根；分管单的扫描根是 runs_dir，
 * 它的 data/ 与 tickets 都在 runs_dir 同级规则下，直接用扫描根即可。
 */
function rootOf(scanRoot: string): string {
  return path.resolve(scanRoot);
}

function releaseTicketLeases(ticket: Ticket): void {
  const project = ticket.options.project;
  if (!project?.dataDir) return;
  try {
    releaseStaleLeases(path.join(project.dataDir, "leases", project.id));
  } catch {
    // 清租约失败不影响恢复判定；下次启动还会再清。
  }
}

function markRecoveredNeedsYou(workRoot: string, ticket: Ticket, reason: string): void {
  const store = new Store(workRoot);
  try {
    ticket.stage = "person/blocked";
    store.setTicketStatus(ticket, "needs_you", `需要你（崩溃恢复）：${reason}`);
  } finally {
    store.close();
  }
}

async function autoResumeTicket(
  workRoot: string,
  ticketDir: string,
  ticket: Ticket,
  record: InflightRecord,
  onTicket?: TicketCallback,
): Promise<boolean> {
  const store = new Store(workRoot);
  try {
    const plan = readJson<{ tasks?: PlannedTask[] }>(path.join(ticketDir, "plan.json"));
    const tasks = plan?.tasks ?? [];
    if (tasks.length === 0) {
      ticket.stage = "person/blocked";
      store.setTicketStatus(ticket, "needs_you", "需要你（崩溃恢复）：没有可续跑的 task 计划");
      // 续跑没跑起来，这张单的结论只能在这里上报；成功续跑由循环尾按真实终态上报。
      await notifyTicket(recoveredEntry(ticket), onTicket);
      return false;
    }
    const kind = workerKindOf(ticket.employee) ?? EMPLOYEE;
    // 崩溃恢复没有请求参数：沿用建单时的模型 / 权限快照（老单没有就回 env 缺省）。
    const profile = ticket.options.employeeProfile;
    const stored = store.tasksOf(ticket.id);
    // 已做完的任务行不重跑（2026-11-19：任务行状态就是唯一事实，没有 review.json）。
    const doneSeqs = new Set(
      stored
        .filter((row) => row.status === "passed" || row.status === "dropped")
        .map((row) => row.seq),
    );
    const taskRows: Task[] = tasks.map((task, index) => {
      const seq = index + 1;
      return (
        stored.find((row) => row.seq === seq) ?? {
          ticket_id: ticket.id,
          seq,
          slug: task.slug,
          title: task.title,
          dir: taskDirName(seq, task.slug),
          status: "reported",
          employee: kind,
          updated_at: new Date().toISOString(),
        }
      );
    });
    const runs = tasks
      .map((task, index) => runFromDisk(ticket, task, index + 1, ticketDir, kind))
      .filter((run) => doneSeqs.has(run.seq));
    // 先把续跑次数记上：再崩一次就不会无限续。
    startInflight(ticketDir, ticket.id, { resumeCount: record.resumeCount + 1 });
    store.setTicketStatus(ticket, "dispatching");
    const scheduled = await runScheduledTasks({
      ticket,
      store,
      tasks,
      rows: taskRows,
      project: ticket.options.project,
      employeeKind: kind,
      ...(profile ? { employeeProfile: profile } : {}),
      // 自动续跑没有宿主连接，但进度仍要落盘：重启后的看板才知道它跑到哪。
      emit: (event) => {
        store.saveTicketProgress(ticket, progressOfEvent(event));
      },
      initialRuns: runs,
      onlySeqs: tasks
        .map((_, index) => index + 1)
        .filter((seq) => !doneSeqs.has(seq)),
      resumeWorktrees: new Map(record.worktrees.map((item) => [item.seq, item.path])),
    });
    await finishRuns({
      ticket,
      store,
      taskRows,
      runs: scheduled.runs,
      emitFor: (type, extra) => {
        store.saveTicketProgress(
          ticket,
          progressOfEvent({ type, ticketId: ticket.id, ...extra }),
        );
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ticket.stage = "person/blocked";
      store.setTicketStatus(ticket, "needs_you", `需要你（崩溃恢复）：续跑失败：${message}`);
    } catch {
      // 记录失败不能覆盖原始错误。
    }
    await notifyTicket(recoveredEntry(ticket), onTicket);
    return false;
  } finally {
    store.close();
  }
}

async function resumeTicket(
  req: ChancellorRequest,
  resumeTicketId: string,
  opts: ChancellorOptions,
): Promise<TicketResult> {
  const answer = typeof req.answer === "string" ? req.answer.trim() : "";
  if (!answer) throw new Error("resume 需要非空的 answer");

  const workRoot = path.resolve(
    req.workRoot && req.workRoot.trim() !== ""
      ? req.workRoot
      : path.join(process.cwd(), "runs"),
  );
  const store = new Store(workRoot);
  const ticketDir = store.ticketDir(resumeTicketId);
  const ticket = readJson<Ticket>(path.join(ticketDir, "ticket.json"));
  if (!ticket) throw new Error(`找不到要续跑的单：${resumeTicketId}`);
  // 续跑也是开工：重新记进行中；如果上次留下副本，接着用。
  const previousInflight = readInflight(ticketDir);
  startInflight(ticketDir, ticket.id);


  const kind = workerKindOf(ticket.employee) ?? EMPLOYEE;
  // 续跑沿用建单时的模型 / 权限快照；老单没有就回 env 缺省。
  const profile = ticket.options.employeeProfile;
  if (kind === "mcp") assertMcpConfigured();
  if (kind === "phone") assertPhoneConfigured();

  const plan = readJson<{ tasks?: PlannedTask[] }>(path.join(ticketDir, "plan.json"));
  const tasks = plan?.tasks ?? [];
  if (tasks.length === 0) {
    throw new Error(`这单没有可续跑的 task 计划：${resumeTicketId}`);
  }

  const notify = opts.onEvent ?? (() => {});
  const signal = opts.signal;
  // 续跑同样先把进度落到原单上，宿主断开也能从 ticket.json 看到。
  const emit: EventSink = (event) => {
    store.saveTicketProgress(ticket, progressOfEvent(event));
    notify(event);
  };
  const emitFor = (
    type: ChancellorEvent["type"],
    extra: { seq?: number; slug?: string; message?: string; total?: number } = {},
  ): void => {
    emit({ type, ticketId: ticket.id, ...extra });
  };

  const stored = store.tasksOf(ticket.id);
  const taskRows: Task[] = tasks.map((task, index) => {
    const seq = index + 1;
    return (
      stored.find((row) => row.seq === seq) ?? {
        ticket_id: ticket.id,
        seq,
        slug: task.slug,
        title: task.title,
        dir: taskDirName(seq, task.slug),
        status: "reported",
        employee: kind,
        updated_at: new Date().toISOString(),
      }
    );
  });
  const runs = tasks.map((task, index) =>
    runFromDisk(ticket, task, index + 1, ticketDir, kind),
  );

  const blockedIndex = runs.findIndex((run) => run.report?.status === "blocked");
  if (blockedIndex < 0) {
    throw new Error(`这单没有在等回答的任务：${resumeTicketId}（当前 ${ticket.status}）`);
  }
  const task = tasks[blockedIndex]!;
  const row = taskRows[blockedIndex]!;

  // 分档要在开跑前定：真续接还是重派，必须先算出来，重派时好如实回报（2026-11-08 8f）。
  const resumeDecision = decideResume(kind, readSessionId(path.join(ticketDir, row.dir)));

  // 单号必须同步发出（同新单路径）：startDelegation 用「同步段有没有拿到 ticketId」
  // 区分「续跑被拒」与「在排队」；先 await 准入会被误判成续跑被拒，进而改派新单。
  emitFor("ticket", { message: `续跑原单，回答 [${row.dir}] 的问题` });

  // ticket 准入（2026-11-22 M1b）：续跑 / 重试也走同一入口，否则重启恢复能绕过所有上限。
  // 领域沿用原单快照（续跑没有新请求的 domain）；排队中被取消时不占名额。
  const admission = await acquireAdmission({
    domain: ticket.options.domain ?? "",
    priority: req.priority ?? 5,
    ...(signal ? { signal } : {}),
    onWait: (info) =>
      emitFor("ticket", { message: `排队中：前面 ${Math.max(0, info.position - 1)} 单` }),
  });
  if (!admission.granted) {
    if (admission.reason === "queue_full") {
      ticket.stage = "failed";
      store.setTicketStatus(ticket, "failed", "排队已满，稍后再试");
      const line = "排队已满，稍后再试";
      emitFor("finished", { message: line });
      return { ticketId: ticket.id, status: "failed", line, tasks: [] };
    }
    ticket.stage = "aborted";
    store.setTicketStatus(ticket, "aborted", "已停止");
    const line = renderAbortedLine(0);
    emitFor("finished", { message: line });
    return { ticketId: ticket.id, status: "aborted", line, tasks: [] };
  }

  try {
  // 重派就是丢了上一段上下文：模型和人都得知道，不许静默（方案 §一.1）。
  if (resumeDecision.notice) emitFor("ticket", { message: resumeDecision.notice });
  store.setTicketStatus(ticket, "dispatching");
  row.employee = kind;
  row.status = "running";
  row.updated_at = new Date().toISOString();
  store.saveTask(row);
  emitFor("task-start", {
    seq: row.seq,
    slug: task.slug,
    message: `续跑 ${row.dir}`,
  });

  try {
    const resumedResult = await runSingleTask({
      ticket,
      store,
      task,
      seq: row.seq,
      project: ticket.options.project,
      signal,
      employeeKind: kind,
      ...(profile ? { employeeProfile: profile } : {}),
      completedRuns: runs,
      resumeAnswer: answer,
      // 续跑的单也要能上报（批2）：同一张单的宿主连接还在。
      onEscalation: (escalation) =>
        emit({
          type: "escalation",
          ticketId: ticket.id,
          escalation,
        }),
      ...(previousInflight?.worktrees.find((item) => item.seq === row.seq)
        ? {
            resumeWorktreePath: previousInflight.worktrees.find(
              (item) => item.seq === row.seq,
            )!.path,
          }
        : {}),
    });
    if (resumedResult.waitingOn) {
      row.status = "waiting";
      row.updated_at = new Date().toISOString();
      store.saveTask(row);
      ticket.stage = "idle";
      store.setTicketStatus(ticket, "idle", `等待文件：${resumedResult.waitingOn}`);
      const line = sanitizeLine(`[${ticket.id}] 等待文件：${resumedResult.waitingOn}，稍后再续`);
      emitFor("finished", { message: line });
      return withResumeNotice(
        { ticketId: ticket.id, status: "idle", line, tasks: [] },
        resumeDecision.notice,
      );
    }
    const resumed = resumedResult.run!;
    runs[blockedIndex] = resumed;
    row.employee = resumed.employee;
    row.status = resumed.aborted || resumed.timedOut
      ? "blocked"
      : resumed.exitCode !== 0
        ? "failed"
        : resumed.reportExists
          ? "reported"
          : "failed";
    row.updated_at = new Date().toISOString();
    store.saveTask(row);
    emitFor("task-done", {
      seq: row.seq,
      slug: task.slug,
      message: `退出码=${resumed.exitCode === null ? "null" : resumed.exitCode}，报告=${
        resumed.reportExists ? (resumed.report?.status ?? "无法解析") : "缺失"
      }`,
    });

    return withResumeNotice(
      await finishRuns({
        ticket,
        store,
        taskRows,
        runs,
        emitFor,
        signal,
      }),
      resumeDecision.notice,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ticket.stage = "failed";
      store.setTicketStatus(ticket, "failed", message);
    } catch {
      /* 记录失败不能覆盖原始错误 */
    }
    const line = renderErrorLine(ticket.id, message);
    emitFor("finished", { message: line });
    return withResumeNotice(
      { ticketId: ticket.id, status: "failed", line, tasks: [] },
      resumeDecision.notice,
    );
  }
  } finally {
    // 续跑的所有出口（idle / 成功 / 失败 / 抛错）都要还名额。
    admission.release();
  }
}

/**
 * 重派时把「上下文没接上」写进汇报行：line 是模型和人唯一都能看到的一句话，
 * 不能只在事件流里说（2026-11-08 扫尾批 8f）。
 */
function withResumeNotice(result: TicketResult, notice: string | null): TicketResult {
  if (!notice) return result;
  return { ...result, line: `${result.line}${notice}。` };
}

/** 续跑时把没重跑的 task 从磁盘 REPORT 还原成 TaskRun，供重新验收。 */
function runFromDisk(
  ticket: Ticket,
  task: PlannedTask,
  seq: number,
  ticketDir: string,
  kind: WorkerKind,
): TaskRun {
  const dirName = taskDirName(seq, task.slug);
  const dir = path.join(ticketDir, dirName);
  const raw = readText(path.join(dir, "REPORT.md"));
  const parsed = raw !== null
    ? parseWorkerReport(raw)
    : { report: null, error: "REPORT.md 缺失（续跑时从磁盘还原）" };
  return {
    ticketId: ticket.id,
    seq,
    task,
    dir,
    dirName,
    employee: kind,
    exitCode: raw !== null ? 0 : null,
    timedOut: false,
    aborted: false,
    processOk: raw !== null,
    processError: raw !== null ? null : "REPORT.md 缺失（续跑时从磁盘还原）",
    // 会话号同样从落盘读：重启后续跑才有 -r 可用（2026-11-08 8f）。
    sessionId: readSessionId(dir),
    reportExists: raw !== null,
    report: parsed.report,
    reportError: parsed.error,
    stderrTail: "",
    // 2026-11-17：单子指定过目录就沿用它，否则回到项目根。
    ...(() => {
      const dir = ticket.options.workDir ?? ticket.options.project?.rootPath;
      return dir ? { workDir: dir } : {};
    })(),
  };
}

function workerKindOf(kind: string | undefined): WorkerKind | null {
  // 2026-11-22：池执行器也是宿主可点名的 worker；漏掉这一档会让 req.employee="pool"
  // 静默回落 EMPLOYEE（实测：前端直派任务全跑成 native）。
  return kind === "native" ||
    kind === "pool" ||
    kind === "mercenary" ||
    kind === "codebuddy" ||
    kind === "qoder-intl" ||
    kind === "qoder-cn" ||
    kind === "claude-code" ||
    kind === "codex" ||
    kind === "opencode" ||
    kind === "mcp" ||
    kind === "phone"
    ? kind
    : null;
}

/**
 * 分管分支：一单只问一个领域，不拆单、不验收——验收由分管宰相自己负责。
 *
 * 它跑在独立进程里，这里只负责起进程、收最后一行、把结论映射成 ticket 状态。
 */
async function runManagerTicket(
  ticket: Ticket,
  store: Store,
  requirement: string,
  domain: string,
  dry: boolean,
  emitFor: (
    type: ChancellorEvent["type"],
    extra?: { seq?: number; slug?: string; message?: string },
  ) => void,
  signal: AbortSignal | undefined,
  /** 分管子单用的 worker 与参数（2026-11-16 多 CLI）；由 manager 子进程的 env 继承。 */
  employee: WorkerKind,
  employeeProfile: EmployeeProfile,
  /** 宿主注入的宰相身份；只透传给子进程，chancellor 不解读（批次D D2）。 */
  managerIdentity?: { name: string; soul: string },
  /** 来源宿主对话标识；只透传给子进程，子单据此继承（2026-11-05 跨仓契约）。 */
  originConversationId?: string,
): Promise<TicketResult> {
  // 同领域串行的租约（M1a）：拿到后才允许起 manager；任何出口都释放。
  let domainLease: LaneLease | null = null;
  try {
    if (dry) {
      const line = `⚠ 这单带的是分管领域「${domain}」，--dry 只能预览直接派工的拆单；去掉 --dry 再跑。`;
      ticket.stage = "person/blocked";
      store.setTicketStatus(ticket, "needs_you", "dry 模式下不支持分管宰相");
      emitFor("finished", { message: line });
      return { ticketId: ticket.id, status: "needs_you", line, tasks: [] };
    }

    if (signal?.aborted) {
      ticket.stage = "aborted";
      store.setTicketStatus(ticket, "aborted", "已停止");
      const line = renderAbortedLine(0);
      emitFor("finished", { message: line });
      return { ticketId: ticket.id, status: "aborted", line, tasks: [] };
    }

    // 同领域串行（2026-11-22 M1a）：两个同领域单各起一个 manager 子进程会并发改写
    // 同一份领域状态；串行化只影响同领域，不同领域照常并行。
    domainLease = await acquireDomain(domain, {
      signal,
      onWait: (info) => emitFor("manager", { message: `同领域排队：${info.running}/${info.cap}` }),
    });
    if (!domainLease.granted) {
      // 等领域时被取消：不占领域、不起 manager，按 aborted 收尾（signal 已是唯一事实）。
      ticket.stage = "aborted";
      store.setTicketStatus(ticket, "aborted", "已停止");
      const line = renderAbortedLine(0);
      emitFor("finished", { message: line });
      return { ticketId: ticket.id, status: "aborted", line, tasks: [] };
    }

    // 只有走到这里才建领域；没有 domain 的调用根本进不来。
    const manager = ensureManager(store.workRoot, domain);
    store.setTicketStatus(ticket, "dispatching");
    emitFor("manager", {
      message: `领域「${domain}」，进程按需起，会话续用 ${manager.root}`,
    });

    const outcome = await runManager(
      {
        domain,
        requirement,
        manager,
        ...(ticket.options.project ? { project: ticket.options.project } : {}),
        parentTicketId: ticket.id,
        employee,
        employeeProfile,
        ...(managerIdentity ? { managerIdentity } : {}),
        ...(originConversationId ? { originConversationId } : {}),
      },
      signal,
    );
    // 把子进程自己的隔离证据（pid/cwd/db、reused/history）抬到事件流里；
    // 安静模式仍然只看到最后一行结论。
    for (const line of outcome.stderrTail.split(/\r?\n/)) {
      const text = line.trim();
      if (text.startsWith("[manager]")) emitFor("manager", { message: text });
    }
    const conversationId =
      readManagerMeta(manager.root)?.conversation_id ?? manager.conversation_id;
    const reuse = parseManagerReuse(outcome.stderrTail);

    const record: ManagerRunRecord = {
      domain,
      line: outcome.finalLine,
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut,
      aborted: outcome.aborted,
      conversation_id: conversationId,
      reused: reuse?.reused ?? null,
      history: reuse?.history ?? null,
      error: outcome.error,
    };
    writeJson(path.join(store.ticketDir(ticket.id), "plan.json"), {
      ticket: ticket.id,
      employee: "manager",
      domain,
      ok: true,
      tasks: [],
      droppedDeps: [],
      error: null,
      attempts: [],
      created_at: new Date().toISOString(),
      manager: record,
    });

    let decided = decideManagerResult(outcome, domain, signal?.aborted === true);
    // 父单完成闸门：子单有 failed/needs_you 时父单不得进 done；没终态的子单沿用 idle。
    // 分管宰相同步等每个 delegate 返回，正常情况这里永远是 0；这是防「提前收尾」的硬闸。
    decided = enforceChildClosure(decided, childTickets(manager.runs_dir, ticket.id), ticket.id);
    ticket.stage = decided.stage;
    store.setTicketStatus(ticket, decided.status, decided.error);
    emitFor("finished", { message: decided.line });
    return {
      ticketId: ticket.id,
      status: decided.status,
      line: decided.line,
      tasks: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ticket.stage = "failed";
      store.setTicketStatus(ticket, "failed", message);
    } catch {
      /* 记录失败不能覆盖原始错误 */
    }
    const line = renderErrorLine(ticket.id, message);
    emitFor("finished", { message: line });
    return { ticketId: ticket.id, status: "failed", line, tasks: [] };
  } finally {
    // 领域租约在 catch 之后释放：失败路径也要让同领域的下一单进来。
    domainLease?.release();
  }
}

/** 读父单名下所有子单；存储坏了返回空，不把父单一起判失败。 */
function childTickets(runsDir: string, parentTicketId: string): Ticket[] {
  let store: Store | null = null;
  try {
    store = new Store(runsDir);
    return store.childrenOf(parentTicketId);
  } catch {
    // 子单存储坏了不能把父单也判失败；父单继续按自己的结论走。
    return [];
  } finally {
    // 必须关：这个库落在 managers/<domain>/data/ 里。不关会一直占着目录句柄，
    // 宿主 archiveManager 在 Windows 上改名该领域目录就会 EPERM（批次D D2 归档）。
    store?.close();
  }
}

/** 从 manager 子进程的 `[manager] conversation=… reused=… history=…` 日志里取续用证据。 */
function parseManagerReuse(
  stderrTail: string,
): { reused: boolean; history: number } | null {
  const match = /conversation=\d+\s+reused=(true|false)\s+history=(\d+)/.exec(stderrTail);
  if (!match) return null;
  return { reused: match[1] === "true", history: Number(match[2]) };
}

/** 分管宰相结论只能以 done/blocked/failed 开头；认不出来就不算 done。 */
function decideManagerResult(
  outcome: ManagerOutcome,
  domain: string,
  abortedBySignal: boolean,
): { status: TicketOutcomeStatus; stage: TicketStage; line: string; error: string | null } {
  if (abortedBySignal || outcome.aborted) {
    return {
      status: "aborted",
      stage: "aborted",
      line: renderAbortedLine(0),
      error: "已停止",
    };
  }
  if (outcome.timedOut) {
    return {
      status: "needs_you",
      stage: "person/blocked",
      line: `⚠ 分管宰相（${domain}）超时，没给结论。`,
      error: outcome.error ?? "分管宰相超时",
    };
  }
  if (!outcome.processOk || outcome.finalLine === null) {
    const reason =
      outcome.error ?? `退出码 ${outcome.exitCode === null ? "null" : outcome.exitCode}`;
    return {
      status: "failed",
      stage: "failed",
      line: `✗ 分管宰相（${domain}）异常退出：${sanitizeLine(reason, 120)}。`,
      error: reason,
    };
  }

  const match = /^(done|blocked|failed)\s*[:：]\s*(.*)$/i.exec(outcome.finalLine.trim());
  if (!match) {
    return {
      status: "needs_you",
      stage: "person/blocked",
      line: `⚠ 分管宰相（${domain}）没按格式收尾：${sanitizeLine(outcome.finalLine, 120)}`,
      error: "分管宰相结论前缀无法识别",
    };
  }
  const prefix = (match[1] ?? "").toLowerCase();
  if (prefix === "done") {
    return {
      status: "done",
      stage: "done",
      line: sanitizeLine(outcome.finalLine, 200),
      error: null,
    };
  }
  if (prefix === "failed") {
    return {
      status: "failed",
      stage: "failed",
      line: sanitizeLine(outcome.finalLine, 200),
      error: "分管宰相结论：failed",
    };
  }
  return {
    status: "needs_you",
    stage: "person/blocked",
    line: sanitizeLine(outcome.finalLine, 200),
    error: "分管宰相结论：blocked",
  };
}

function clamp(value: number, min: number, max: number): number {
  const rounded = Math.floor(value);
  if (!Number.isFinite(rounded)) return max;
  return Math.min(max, Math.max(min, rounded));
}

/** 总管下发的项目只收敛形状：id/rootPath 缺一不可，其余字段能省就省。 */
function normalizeProject(raw: ProjectRef | undefined): ProjectRef | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const rootPath = typeof raw.rootPath === "string" ? raw.rootPath.trim() : "";
  if (!id || !rootPath) return undefined;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name.trim() : "",
    rootPath,
    ...(raw.vcs === "git" || raw.vcs === "none" ? { vcs: raw.vcs } : {}),
    ...(typeof raw.head === "string" && raw.head.trim() !== ""
      ? { head: raw.head.trim() }
      : {}),
    ...(typeof raw.dataDir === "string" && raw.dataDir.trim() !== ""
      ? { dataDir: raw.dataDir.trim() }
      : {}),
  };
}
