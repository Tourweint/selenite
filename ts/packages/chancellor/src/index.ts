import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { assertMcpConfigured, DELEGATION_RESUME_POLICY, EMPLOYEE, MAX_TASKS_DEFAULT, resolveProfile } from "./config.ts";
import { decideResume, parseWorkerReport, readSessionId, taskDirName } from "./dispatch.ts";
import { assertPhoneConfigured, capabilitiesOf } from "./employee/index.ts";
import { runManager, type ManagerOutcome } from "./employee/manager.ts";
import { checkTicketGoal } from "./goal.ts";
import {
  buildJudgeInput,
  decideJudgeOutcome,
  judgeCallsOf,
  judgeEnabled,
  judgeMaxRounds,
  judgeMaxTools,
  nextJudgeRound,
  shouldConsultJudge,
  type JudgeDecision,
} from "./judge.ts";
import { intake } from "./intake.ts";
import { ensureManager, listManagers, readManagerMeta } from "./manager/registry.ts";
import { isPidAlive, releaseStaleLeases } from "./lease.ts";
import { planTicket } from "./plan.ts";
import {
  renderAbortedLine,
  renderAttentionLine,
  renderDroppedLine,
  renderDryLine,
  renderErrorLine,
  renderGoalFailureLine,
  renderGoalInconclusiveLine,
  renderIdleLine,
  renderJudgeBlockedLine,
  renderJudgeDoneLine,
  renderJudgeWaitLine,
  renderPlanFailureLine,
  renderResultLine,
  sanitizeLine,
} from "./report.ts";
import {
  classifyRun,
  decideAfterReview,
  decideBeforeReview,
  enforceChildClosure,
  needsGoalCheck,
  type RunStage,
} from "./stage.ts";
import { reviewTask } from "./review.ts";
import {
	acceptRounds,
	buildRepairRequirement,
	lastFailReason,
	renderAcceptLimitLine,
	shouldStartRepair,
} from "./repair.ts";
import { runScheduledTasks, runSingleTask } from "./scheduler.ts";
import {
  readPathSnapshot,
  snapshotFileFor,
  type SnapshotResult,
} from "./isolation.ts";
import { readJson, readText, Store, writeJson, type TicketProgress } from "./store.ts";
import type {
  ChancellorEvent,
  ChancellorOptions,
  ChancellorRequest,
  ChancellorTaskResult,
  DependencyReport,
  EmployeeProfile,
  EventSink,
  GoalCheckResult,
  JudgeCallRecord,
  JudgeFile,
  JudgeFn,
  JudgeOutcome,
  ManagerRunRecord,
  PlannedTask,
  PlannedTaskInfo,
  ProjectRef,
  Review,
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

  if (useManager) {
    return runManagerTicket(
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

  emitFor("ticket", { message: "收单，开始拆单" });

  const ticketDir = store.ticketDir(ticket.id);

  /**
   * 一轮 = 拆单 → 执行 → 验收。修复轮复用同一张 ticket / 同一个 store（§1 路线 A）。
   * `repairSlot` 由调用方持有：失败时 finishRuns 把这一轮的验收结论填进去。
   */
  const runRound = async (
    roundRequirement: string,
    repairSlot: { requested?: { reviews: Review[]; runs: TaskRun[]; judgeReason?: string } },
  ): Promise<TicketResult> => {
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
    });

    return await finishRuns({
      ticket,
      store,
      tasks: planResult.tasks,
      taskRows,
      runs: scheduled.runs,
      emitFor,
      signal,
      repair: repairSlot,
      // 证据裁判（2026-11-10 批 14）：宿主注入的能力；chancellor 只在验收 fail 时用。
      ...(opts.judge ? { judge: opts.judge } : {}),
    });
  };

  try {
    // 验收「核对-修复」循环（2026-11-09 §1）：失败 → 同一张单再跑一轮 → 再核。
    // DELEGATION_ACCEPT_ROUNDS=0 时 while 一次都不进，结果与改动前逐字节一致。
    const maxRounds = acceptRounds();
    let repairRound = 0;
    let lastFailed: { reviews: Review[]; runs: TaskRun[]; judgeReason?: string } | null = null;
    const slot: { requested?: { reviews: Review[]; runs: TaskRun[]; judgeReason?: string } } = {};
    let result = await runRound(requirement, slot);

    while (slot.requested && shouldStartRepair(result.status, repairRound, maxRounds)) {
      lastFailed = slot.requested;
      repairRound += 1;
      // 返工轮次先落盘：规划 / 执行期间看板就能看到"这是第几轮"。
      ticket.repairRound = repairRound;
      // 上一轮的现场归档到 round-<上一轮>/，任务行清掉；新轮从干净的任务目录开始。
      archiveRoundDir(ticketDir, repairRound - 1);
      store.resetRoundRows(ticket.id);
      const repairRequirement = buildRepairRequirement({
        requirement,
        round: repairRound,
        reviews: lastFailed.reviews,
        runs: lastFailed.runs,
        // 裁判给的返工方向（批 14）：比机械的验收原话更能指导下一步。
        ...(lastFailed.judgeReason ? { judgeReason: lastFailed.judgeReason } : {}),
      });
      // 上一轮以 failed 收的尾（setTicketStatus 清过 inflight / 快照），这里重新标记进行中。
      startInflight(ticketDir, ticket.id);
      emitFor("ticket", {
        message: `第 ${repairRound} 轮返工：只修上一轮验收未通过的部分`,
      });
      slot.requested = undefined;
      result = await runRound(repairRequirement, slot);
    }
    if (slot.requested) lastFailed = slot.requested;

    // 轮次用完仍失败 → 交人；文案必须带"已修几轮 + 最后一轮验收原话"（§1.2）。
    if (repairRound > 0 && result.status === "failed" && lastFailed) {
      ticket.stage = "person/blocked";
      const reason = lastFailReason(lastFailed.reviews);
      const line = renderAcceptLimitLine(ticket.id, repairRound, reason);
      store.setTicketStatus(ticket, "needs_you", `已自动修 ${repairRound} 轮仍失败：${reason}`);
      emitFor("finished", { message: line });
      result = { ...result, status: "needs_you", line };
    }
    // 返工过才带这个字段（缺省不出现 = 旧调用方零影响）。
    if (repairRound > 0) result = { ...result, repairRound };
    return result;
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
}

/**
 * 返工轮开始前把上一轮的现场归档到 `<ticketDir>/round-<n>/`（2026-11-09 §1）。
 *
 * 为什么必须清任务目录：dispatchTask 只覆盖 TASK.md，不会删旧的 REPORT.md；
 * 同一 seq / slug 重跑时，旧报告会让"没重写"看起来像完成。归档而不是删除，
 * 是为了排障时还能看到上一轮到底交付了什么。
 */
function archiveRoundDir(ticketDir: string, round: number): void {
	const archive = path.join(ticketDir, `round-${round}`);
	try {
		fs.mkdirSync(archive, { recursive: true });
		for (const entry of fs.readdirSync(ticketDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !/^\d{2}-/.test(entry.name)) continue;
			const target = path.join(archive, entry.name);
			fs.rmSync(target, { recursive: true, force: true });
			fs.renameSync(path.join(ticketDir, entry.name), target);
		}
		// review.json 每轮覆盖写，上一轮的结论复制一份进归档。
		const reviewFile = path.join(ticketDir, "review.json");
		if (fs.existsSync(reviewFile)) {
			fs.copyFileSync(reviewFile, path.join(archive, "review.json"));
		}
	} catch (error) {
		console.warn(
			`[repair] 归档第 ${round} 轮目录失败（不影响返工）：${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

interface FinishRunsContext {
  ticket: Ticket;
  store: Store;
  tasks: PlannedTask[];
  taskRows: Task[];
  runs: TaskRun[];
  emitFor: (
    type: ChancellorEvent["type"],
    extra?: { seq?: number; slug?: string; message?: string; total?: number },
  ) => void;
  signal?: AbortSignal;
  /**
   * 返工循环的缝（2026-11-09 §1）：调用方给一个槽位，失败时 finishRuns 把
   * 这一轮的验收结论与执行结果填进去；要不要重跑由调用方决定。
   * 不传 = 旧行为（其余调用方：崩溃恢复 / resume 不受影响）。
   */
  repair?: { requested?: { reviews: Review[]; runs: TaskRun[]; judgeReason?: string } };
  /** 证据裁判（2026-11-10 批 14）：只由宿主注入；不传 = 旧行为。 */
  judge?: JudgeFn;
}

/** 派活之后的统一收口：短接结论、验收、整体目标核对。首跑和 resume 共用。 */
async function finishRuns(ctx: FinishRunsContext): Promise<TicketResult> {
  const { ticket, store, tasks, taskRows, runs, emitFor, signal } = ctx;
  const aborted = signal?.aborted === true || runs.some((run) => run.aborted);
  const decision = aborted ? null : decideBeforeReview(runs);

  // waiting / dropped / blocked / failed 都是明确结论，不走 LLM 验收。
  if (decision && decision.kind !== "review" && decision.kind !== "aborted") {
    const result = finishWithoutReview(ticket, store, taskRows, runs, decision, emitFor);
    // 硬失败（退出码 / 报告缺失 / worker 报 failed）同样进返工循环：
    // 这些 review 与 finishWithoutReview 里写入的是同一份纯计算结果。
    requestRepair(ctx, result.status, runs.map(shortCircuitReview), runs);
    return result;
  }

  store.setTicketStatus(ticket, "reviewing");
  ticket.stage = "review";
  const droppedSeqs = new Set(
    decision?.kind === "review" ? decision.dropped.map((run) => run.seq) : [],
  );
  const reviews: Review[] = [];
  for (const run of runs) {
    let review: Review;
    if (droppedSeqs.has(run.seq)) {
      review = droppedReview(run);
    } else {
      emitFor("reviewing", {
        seq: run.seq,
        slug: run.task.slug,
        message: `验收 ${run.dirName}`,
      });
      review = await reviewTask(run, ticket, signal);
    }
    reviews.push(review);
    store.saveReview(review);
    const row = taskRows.find((item) => item.seq === run.seq);
    if (row) {
      row.status = taskRowStatus(classifyRun(run), review);
      row.updated_at = new Date().toISOString();
      store.saveTask(row);
    }
  }

  const completed = reviews.filter((review) => review.verdict === "pass").length;
  writeJson(path.join(store.ticketDir(ticket.id), "review.json"), {
    ticket: ticket.id,
    created_at: new Date().toISOString(),
    aborted,
    stage: aborted ? "aborted" : "review",
    reviews: reviews.map((review) => ({
      ...review,
      employee:
        runs.find((run) => run.seq === review.seq)?.employee ??
        ticket.employee ??
        null,
    })),
  });

  const resultTasks: ChancellorTaskResult[] = taskRows.map((row) => {
    const run = runs.find((item) => item.seq === row.seq);
    const review = reviews.find((item) => item.seq === row.seq);
    return {
      seq: row.seq,
      slug: row.slug,
      title: row.title,
      status: aborted
        ? review
          ? verdictStatus(review)
          : "blocked"
        : taskResultStatus(run, review),
      reason: review ? review.reason : aborted ? "已停止" : "未执行",
      dir: path.join(store.ticketDir(ticket.id), row.dir),
      ...(run?.report?.attention ? { attention: run.report.attention } : {}),
    };
  });
  // 整单第一个还没人回答的问题；宿主拿它出「需要你」卡片。
  const ticketAttention = resultTasks.find((item) => item.attention)?.attention;

  if (aborted) {
    ticket.stage = "aborted";
    store.setTicketStatus(ticket, "aborted", "已停止");
    const line = renderAbortedLine(completed);
    emitFor("finished", { message: line });
    return {
      ticketId: ticket.id,
      status: "aborted",
      line,
      tasks: resultTasks,
      attention: ticketAttention,
    };
  }

  const allPassed =
    reviews.length === runs.length && reviews.every((review) => review.verdict === "pass");

  let goal: GoalCheckResult | null = null;
  if (allPassed && needsGoalCheck(runs)) {
    emitFor("goal", { message: "各任务已通过，开始整体目标核对" });
    goal = await checkTicketGoal(
      {
        ticket,
        tasks,
        runs,
        ticketDir: store.ticketDir(ticket.id),
      },
      signal,
    );
    writeJson(path.join(store.ticketDir(ticket.id), "goal.json"), {
      ticket: ticket.id,
      satisfied: goal.satisfied,
      inconclusive: goal.inconclusive,
      reason: goal.reason,
      aborted: goal.aborted,
      created_at: new Date().toISOString(),
    });

    if (goal.aborted) {
      ticket.stage = "aborted";
      store.setTicketStatus(ticket, "aborted", "已停止");
      const abortedLine = renderAbortedLine(completed);
      emitFor("finished", { message: abortedLine });
      return {
        ticketId: ticket.id,
        status: "aborted",
        line: abortedLine,
        tasks: resultTasks,
        attention: ticketAttention,
      };
    }
    if (goal.inconclusive) {
      ticket.stage = "person/blocked";
      const line = renderGoalInconclusiveLine(ticket.id);
      store.setTicketStatus(ticket, "needs_you", `目标核对没做成：${goal.reason}`);
      emitFor("finished", { message: line });
      return {
        ticketId: ticket.id,
        status: "needs_you",
        line,
        tasks: resultTasks,
        attention: ticketAttention,
      };
    }
    if (!goal.satisfied) {
      // 证据裁判（2026-11-10 批 14 §2.5）：验收判 fail 时先让裁判自己查一遍。
      // 它可能推翻验收（done）、给出更具体的返工方向（continue），或判给人（blocked/wait）。
      const judged = await consultJudge(
        ctx,
        reviews,
        `各任务通过，但整体目标核对判未达成：${goal.reason}`,
      );
      const settledByJudge = applyJudgeVerdict({
        ticket,
        store,
        emitFor,
        judged,
        resultTasks,
        ticketAttention,
      });
      if (settledByJudge) return settledByJudge;

      ticket.stage = "failed";
      const line = renderGoalFailureLine(goal.reason);
      store.setTicketStatus(ticket, "failed", `目标核对未通过：${goal.reason}`);
      emitFor("finished", { message: line });
      // 目标核对失败也算"验收不合格"：各任务 review 已落盘，修复轮以它们为准。
      requestRepair(ctx, "failed", reviews, runs, judgeRepairReason(judged));
      return {
        ticketId: ticket.id,
        status: "failed",
        line,
        tasks: resultTasks,
        attention: ticketAttention,
      };
    }
  }

  const tentative = decideAfterReview(reviews, goal);
  // 验收判 fail 才叫裁判（pass 快路径不变，省钱）。blocked 是"工人卡住"，
  // 不是"验收判太严"，不走裁判。
  const judged =
    tentative.status === "failed"
      ? await consultJudge(ctx, reviews, firstFailReason(reviews))
      : null;
  const settledByJudge = applyJudgeVerdict({
    ticket,
    store,
    emitFor,
    judged,
    resultTasks,
    ticketAttention,
  });
  if (settledByJudge) return settledByJudge;

  const decided = tentative;
  const line =
    allPassed && !needsGoalCheck(runs)
      ? renderDroppedLine(runs.filter((run) => classifyRun(run) === "dropped"))
      : renderResultLine({ total: runs.length, reviews });
  ticket.stage = decided.stage;
  store.setTicketStatus(ticket, decided.status, finalError(decided.status, reviews));
  emitFor("finished", { message: line });
  requestRepair(ctx, decided.status, reviews, runs, judgeRepairReason(judged));
  return {
    ticketId: ticket.id,
    status: decided.status,
    line,
    tasks: resultTasks,
    attention: ticketAttention,
  };
}

/** 裁判意见只对 continue 有意义（done/blocked/wait 已由 applyJudgeVerdict 收口）。 */
function judgeRepairReason(judged: JudgeDecision | null): string | undefined {
  if (!judged || judged.verdict !== "continue") return undefined;
  return judged.reason.trim() !== "" ? judged.reason : undefined;
}

/** 第一条 fail 的原话：裁判材料里的"验收为什么没过"。 */
function firstFailReason(reviews: Review[]): string {
  const failed = reviews.find((review) => review.verdict === "fail");
  return failed?.reason ?? "验收未通过（没有具体理由）";
}

/**
 * 裁判改判对终态的处置（2026-11-10 批 14 §2.5）。
 *   裁判 done      → 验收判太严：按 done 收，judge.json 里留 warning（人可查）
 *   裁判 blocked   → needs_you，带裁判给的问题
 *   裁判 wait      → needs_you，文案「在等外部条件」
 *   裁判 continue  → 返回 null，交给原有失败路径（返工要求改用裁判 reason）
 *
 * 只在 judge 启用时才会被调用；judged=null 时立刻返回 null，旧路径逐字节不变。
 */
function applyJudgeVerdict(input: {
  ticket: Ticket;
  store: Store;
  emitFor: (type: ChancellorEvent["type"], extra?: { seq?: number; slug?: string; message?: string; total?: number }) => void;
  judged: JudgeDecision | null;
  resultTasks: ChancellorTaskResult[];
  ticketAttention: WorkerAttention | undefined;
}): TicketResult | null {
  const { ticket, store, emitFor, judged, resultTasks, ticketAttention } = input;
  if (!judged || judged.verdict === "continue") return null;
  const { verdict, reason } = judged;

  if (verdict === "done") {
    ticket.stage = "done";
    const line = renderJudgeDoneLine(reason);
    store.setTicketStatus(ticket, "done", null);
    emitFor("finished", { message: line });
    return { ticketId: ticket.id, status: "done", line, tasks: resultTasks, attention: ticketAttention };
  }

  const waiting = verdict === "wait";
  ticket.stage = "person/blocked";
  const line = waiting ? renderJudgeWaitLine(reason) : renderJudgeBlockedLine(reason);
  const attention: WorkerAttention = waiting
    ? { kind: "need_action", question: `在等外部条件：${reason}` }
    : { kind: "need_input", question: reason };
  store.setTicketStatus(
    ticket,
    "needs_you",
    waiting ? `裁判说在等外部条件：${reason}` : `裁判判 blocked：${reason}`,
  );
  emitFor("finished", { message: line });
  return { ticketId: ticket.id, status: "needs_you", line, tasks: resultTasks, attention };
}

export const JUDGE_FILE = "judge.json";

function judgeFileOf(ticketDir: string): JudgeFile | null {
  return readJson<JudgeFile>(path.join(ticketDir, JUDGE_FILE));
}

/**
 * 叫一次证据裁判（2026-11-10 批 14）。
 *
 * 落盘 `judge.json` 是**审计事实**：谁在第几轮、判了什么、证据是什么、有没有被降级。
 * 顺序固定为「先记事实，再生效」——裁判本身异常也不能让这张单卡在多一步上。
 * 返回 null = 没叫 / 没用上（开关关、轮次用完、没注入、裁判没给结论）。
 */
async function consultJudge(
  ctx: FinishRunsContext,
  reviews: Review[],
  failureReason: string,
): Promise<JudgeDecision | null> {
  const judge = ctx.judge;
  const ticketDir = ctx.store.ticketDir(ctx.ticket.id);
  const file = judgeFileOf(ticketDir);
  const calls = judgeCallsOf(file);
  if (
    !shouldConsultJudge({
      enabled: judgeEnabled(),
      hasJudge: Boolean(judge),
      calls: calls.length,
      maxRounds: judgeMaxRounds(),
      aborted: ctx.signal?.aborted === true,
    }) ||
    !judge
  ) {
    return null;
  }

  const round = nextJudgeRound(file);
  ctx.emitFor("reviewing", { message: "验收未过，裁判开始自己查一遍" });

  let outcome: JudgeOutcome;
  try {
    outcome = await judge(
      buildJudgeInput({
        ticket: ctx.ticket,
        tasks: ctx.tasks,
        runs: ctx.runs,
        reviews,
        ticketDir,
        failureReason,
        maxTools: judgeMaxTools(),
      }),
      ctx.signal,
    );
  } catch (error) {
    outcome = {
      ok: false,
      evidence: [],
      reason: "",
      toolsUsed: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const decision = decideJudgeOutcome(outcome, calls.at(-1) ?? null);
  const record: JudgeCallRecord = {
    round,
    verdict: decision?.verdict ?? "error",
    raw_verdict: outcome.verdict ?? "error",
    reason: typeof outcome.reason === "string" ? outcome.reason : "",
    evidence: Array.isArray(outcome.evidence) ? outcome.evidence.slice(0, 20) : [],
    tools_used: Number.isFinite(outcome.toolsUsed) ? outcome.toolsUsed : 0,
    warnings: decision?.warnings ?? [],
    ...(decision ? {} : { error: outcome.error ?? "裁判没有给出可用结论" }),
    created_at: new Date().toISOString(),
  };
  writeJson(path.join(ticketDir, JUDGE_FILE), {
    ticket: ctx.ticket.id,
    calls: [...calls, record],
  });
  // 只记条数与结论（日志纪律：不记对话内容，也不带上游错误原文）；细节在 judge.json。
  if (decision === null || decision.warnings.length > 0) {
    console.warn(
      `[judge] ${ctx.ticket.id} verdict=${record.verdict} warnings=${record.warnings.length}`,
    );
  }
  return decision;
}

/** 失败时把这一轮的验收结论交给调用方（要不要返工由调用方按轮次上限决定）。 */
function requestRepair(
	ctx: FinishRunsContext,
	status: TicketOutcomeStatus,
	reviews: Review[],
	runs: TaskRun[],
	judgeReason?: string,
): void {
	if (!ctx.repair || status !== "failed") return;
	ctx.repair.requested = { reviews, runs, ...(judgeReason ? { judgeReason } : {}) };
}

type ShortCircuitDecision =
  | { kind: "needs_you"; stage: "person/answer" | "person/blocked"; runs: TaskRun[] }
  | { kind: "failed"; runs: TaskRun[] }
  | { kind: "idle"; runs: TaskRun[] };

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
  const reviewFile = readJson<{ reviews?: Review[] }>(path.join(dir, "review.json"));
  const reviews = reviewFile?.reviews ?? [];
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
    const review = reviews.find((item) => item.seq === seq);
    const dropped = review?.reason.startsWith("无需处理：") === true;
    const taskStatus: ChancellorTaskResult["status"] = dropped
      ? "dropped"
      : review
        ? verdictStatus(review)
        : status === "idle"
          ? "waiting"
          : "blocked";
    return {
      seq,
      slug: task.slug,
      title: task.title,
      status: taskStatus,
      reason:
        review?.reason ??
        (status === "idle" ? "未验收：等下一个触发" : (ticket.error ?? "未验收")),
      dir: path.join(dir, taskDirName(seq, task.slug)),
    };
  });

  let line: string;
  if (running) {
    line = `⏸ 同一 idempotencyKey 的单还在处理（${ticket.id}），未重复执行。`;
  } else if (ticket.status === "aborted") {
    line = renderAbortedLine(reviews.filter((review) => review.verdict === "pass").length);
  } else if (ticket.error?.startsWith("需要你（")) {
    // attention 的 question 可能带路径，不能再过 sanitizeLine。
    line = `⚠ ${ticket.error.slice(0, 240)}`;
  } else if (plan?.manager?.line) {
    line = plan.manager.line;
  } else if (reviews.length > 0) {
    line = renderResultLine({ total: planned.length || reviews.length, reviews });
  } else if (planned.length > 0) {
    line = renderDryLine(planned.map((task) => task.title));
  } else if (ticket.error) {
    line = renderPlanFailureLine(ticket.id, ticket.error);
  } else {
    line = `↩ 幂等命中：返回已有单 ${ticket.id}（${status}），未重复执行。`;
  }

  return {
    ticketId: ticket.id,
    status,
    line,
    tasks,
    // 返工轮次（2026-11-09 §1.5）：幂等命中同样透出，宿主查详情不丢事实。
    ...(typeof ticket.repairRound === "number" && ticket.repairRound > 0
      ? { repairRound: ticket.repairRound }
      : {}),
  };
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
    const reviews =
      readJson<{ reviews?: Review[] }>(path.join(ticketDir, "review.json"))?.reviews ?? [];
    const doneSeqs = new Set(
      reviews
        .filter(
          (review) => review.verdict === "pass" || review.reason.startsWith("无需处理："),
        )
        .map((review) => review.seq),
    );
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
    const runs = tasks
      .map((task, index) => runFromDisk(ticket, task, index + 1, ticketDir, kind))
      .filter((run) => doneSeqs.has(run.seq));
    // 先把续跑次数记上：再崩一次就不会无限续。
    startInflight(ticketDir, ticket.id, { resumeCount: record.resumeCount + 1 });
    // 要重跑的 task 优先读回崩溃前落下的执行前快照：这样崩溃前已经做出的写入
    // 也算这个任务做的，续跑结束后仍能严格前后对比。
    const resumeSnapshots = new Map<number, SnapshotResult>();
    tasks.forEach((task, index) => {
      const seq = index + 1;
      if (doneSeqs.has(seq)) return;
      const snapshot = readPathSnapshot(
        snapshotFileFor(path.join(ticketDir, taskDirName(seq, task.slug))),
        { ticketId: ticket.id, seq },
      );
      if (snapshot) resumeSnapshots.set(seq, snapshot);
    });
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
      resumeSnapshots,
    });
    await finishRuns({
      ticket,
      store,
      tasks,
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

  emitFor("ticket", { message: `续跑原单，回答 [${row.dir}] 的问题` });
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
    // 续跑前把这张单执行前的快照读回来：上一次尝试已经写进项目的改动也算这张单做的。
    const resumeSnapshot = readPathSnapshot(
      snapshotFileFor(path.join(ticketDir, row.dir)),
      { ticketId: ticket.id, seq: row.seq },
    );
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
      ...(previousInflight?.worktrees.find((item) => item.seq === row.seq)
        ? {
            resumeWorktreePath: previousInflight.worktrees.find(
              (item) => item.seq === row.seq,
            )!.path,
          }
        : {}),
      ...(resumeSnapshot ? { resumeSnapshot } : {}),
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
        tasks,
        taskRows,
        runs,
        emitFor,
        signal,
        // 续跑同样能叫裁判（批 14）：宿主这一轮还在。
        ...(opts.judge ? { judge: opts.judge } : {}),
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
  // 崩溃恢复：执行前快照按 ticketId/seq 归属读回；读不到就不带，
  // 验收会明确 blocked，绝不拿「现在存在的文件」冒充完成。
  const snapshot = readPathSnapshot(snapshotFileFor(dir), { ticketId: ticket.id, seq });
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
    // workDir 只作为「回到哪个项目根重新拍一次当前快照」的落点；
    // 判定本身必须靠 snapshotBefore，缺快照时验收会给 blocked。
    ...(() => {
      // 2026-11-17：单子指定过目录就沿用它，否则回到项目根。
      const dir = ticket.options.workDir ?? ticket.options.project?.rootPath;
      return dir ? { workDir: dir } : {};
    })(),
    ...(snapshot
      ? { snapshotBefore: snapshot.entries, snapshotCoarse: snapshot.coarse }
      : {}),
  };
}

function workerKindOf(kind: string | undefined): WorkerKind | null {
  return kind === "native" ||
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
 * 验收前的明确结论：不再调用验收模型，只把 worker 的报告落成 task 状态和一句话。
 * waiting、dropped 都在这里收，所以不会跑目标核对。
 */
function finishWithoutReview(
  ticket: Ticket,
  store: Store,
  taskRows: Task[],
  runs: TaskRun[],
  decision: ShortCircuitDecision,
  emitFor: (
    type: ChancellorEvent["type"],
    extra?: { seq?: number; slug?: string; message?: string },
  ) => void,
): TicketResult {
  const reviews = runs.map(shortCircuitReview);
  for (const review of reviews) store.saveReview(review);

  writeJson(path.join(store.ticketDir(ticket.id), "review.json"), {
    ticket: ticket.id,
    created_at: new Date().toISOString(),
    aborted: false,
    stage: decision.kind === "needs_you" ? decision.stage : decision.kind,
    reviews: reviews.map((review) => ({
      ...review,
      employee:
        runs.find((run) => run.seq === review.seq)?.employee ??
        ticket.employee ??
        null,
    })),
  });

  for (const row of taskRows) {
    const run = runs.find((item) => item.seq === row.seq);
    if (!run) continue;
    row.status = taskRowStatus(
      classifyRun(run),
      reviews.find((review) => review.seq === row.seq),
    );
    row.updated_at = new Date().toISOString();
    store.saveTask(row);
  }

  const resultTasks: ChancellorTaskResult[] = taskRows.map((row) => {
    const run = runs.find((item) => item.seq === row.seq);
    const review = reviews.find((item) => item.seq === row.seq);
    return {
      seq: row.seq,
      slug: row.slug,
      title: row.title,
      status: taskResultStatus(run, review),
      reason: review?.reason ?? "未执行",
      dir: path.join(store.ticketDir(ticket.id), row.dir),
      ...(run?.report?.attention ? { attention: run.report.attention } : {}),
    };
  });
  // 端到端：worker 卡住时整单要带一条 attention 回去，宿主据此出「需要你」卡片。
  // 只看 person/answer：person/blocked（没写清问题）和 idle/failed 都不该问用户。
  const ticketAttention =
    decision.kind === "needs_you" && decision.stage === "person/answer"
      ? resultTasks.find((item) => item.attention)?.attention
      : undefined;

  let status: TicketOutcomeStatus;
  let stage: TicketStage;
  let line: string;
  let error: string | null;

  if (decision.kind === "needs_you") {
    status = "needs_you";
    stage = decision.stage;
    if (decision.stage === "person/answer") {
      line = renderAttentionLine(decision.runs);
      error = ticketAttention
        ? `需要你（${ticketAttention.kind}）：${ticketAttention.question}`
        : "有 task 在等人回话";
    } else {
      line = renderResultLine({
        total: runs.length,
        reviews: onlySeqs(reviews, decision.runs),
      });
      error = decision.runs[0]?.report?.summary ?? "有 task 卡住了";
    }
  } else if (decision.kind === "failed") {
    status = "failed";
    stage = "failed";
    const failedReviews = onlySeqs(reviews, decision.runs);
    line = renderResultLine({ total: runs.length, reviews: failedReviews });
    error =
      failedReviews.find((review) => review.verdict === "fail")?.reason ?? "有 task 失败";
  } else {
    status = "idle";
    stage = "idle";
    line = renderIdleLine(decision.runs);
    error = `等下一个触发：${decision.runs
      .map((run) => run.report?.summary ?? "等下一个触发")
      .join("；")}`;
  }

  // 父单完成闸门在 runManagerTicket 里：直接派工链路没有子单，
  // 也只有分管分支会创建带 parentTicketId 的子任务。

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

function onlySeqs(reviews: Review[], runs: TaskRun[]): Review[] {
  const seqs = new Set(runs.map((run) => run.seq));
  return reviews.filter((review) => seqs.has(review.seq));
}

function shortCircuitReview(run: TaskRun): Review {
  const base = { ticket_id: run.ticketId, seq: run.seq, slug: run.task.slug };
  switch (classifyRun(run)) {
    case "person/answer": {
      const attention = run.report?.attention;
      return {
        ...base,
        verdict: "blocked",
        stage: "report",
        reason: attention
          ? `需要你（${attention.kind}）：${attention.question}`
          : run.report?.summary || "worker 报告 blocked",
      };
    }
    case "person/blocked":
      if (run.timedOut) {
        return { ...base, verdict: "blocked", stage: "process", reason: "worker 超时被杀" };
      }
      if (run.aborted) {
        return { ...base, verdict: "blocked", stage: "process", reason: "已停止" };
      }
      return {
        ...base,
        verdict: "blocked",
        stage: "report",
        reason: run.report?.summary || "worker 报告 blocked",
      };
    case "failed":
      if (!run.processOk) {
        return {
          ...base,
          verdict: "fail",
          stage: "process",
          reason: run.processError ?? "worker 进程失败",
        };
      }
      if (run.exitCode !== 0) {
        const detail = run.stderrTail ? `；stderr 尾部：${tail(run.stderrTail, 200)}` : "";
        return {
          ...base,
          verdict: "fail",
          stage: "process",
          reason: `worker 退出码 ${run.exitCode === null ? "null" : run.exitCode}${detail}`,
        };
      }
      if (!run.reportExists) {
        return {
          ...base,
          verdict: "fail",
          stage: "report",
          reason: "REPORT.md 缺失（退出码 0 也不算完成）",
        };
      }
      if (run.report?.status === "progress") {
        return {
          ...base,
          verdict: "fail",
          stage: "report",
          reason: `只报了进度，没有最终结论：${run.report.summary}`,
        };
      }
      return {
        ...base,
        verdict: "fail",
        stage: "report",
        reason: run.report?.summary || "worker 报告 failed",
      };
    case "idle":
      return {
        ...base,
        verdict: "blocked",
        stage: "report",
        reason: `waiting：${run.report?.summary ?? "等下一个触发"}`,
      };
    case "dropped":
      return droppedReview(run);
    case "ready":
      return {
        ...base,
        verdict: "blocked",
        stage: "report",
        reason: "同单已有任务先给出结论，本任务未验收",
      };
    case "aborted":
      return { ...base, verdict: "blocked", stage: "process", reason: "已停止" };
  }
}

function droppedReview(run: TaskRun): Review {
  return {
    ticket_id: run.ticketId,
    seq: run.seq,
    slug: run.task.slug,
    verdict: "pass",
    reason: `无需处理：${run.report?.summary || "worker 判断这活不需要做"}`,
    stage: "report",
  };
}

function taskRowStatus(stage: RunStage, review: Review | undefined): TaskStatus {
  if (stage === "idle") return "waiting";
  if (stage === "dropped") return "dropped";
  if (!review) return "blocked";
  return verdictStatus(review);
}

function taskResultStatus(
  run: TaskRun | undefined,
  review: Review | undefined,
): ChancellorTaskResult["status"] {
  if (run) {
    const stage = classifyRun(run);
    if (stage === "idle") return "waiting";
    if (stage === "dropped") return "dropped";
  }
  return review ? verdictStatus(review) : "blocked";
}

function verdictStatus(review: Review): "passed" | "failed" | "blocked" {
  return review.verdict === "pass"
    ? "passed"
    : review.verdict === "blocked"
      ? "blocked"
      : "failed";
}

function finalError(status: TicketOutcomeStatus, reviews: Review[]): string | null {
  if (status === "done" || status === "idle" || status === "aborted") return null;
  if (status === "failed") {
    return (
      reviews.find((review) => review.verdict === "fail")?.reason ?? "有 task 未通过验收"
    );
  }
  return (
    reviews.find((review) => review.verdict === "blocked")?.reason ?? "有 task 未给出结论"
  );
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
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
