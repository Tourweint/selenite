/**
 * worker 决策上报的线协议（2026-11-19 批2：worker→总管→用户上报链）。
 *
 * 通道复用（"别发明第二条"）：native worker 的 stderr 本来就是宿主在收的实时流
 * （employee/native.ts 逐块 tail），escalation 走同一条路——worker-main 把一条
 * `[escalate] {json}` 结构行写上 stderr，native.ts 逐行解析后经
 * `EmployeeTask.onEscalation` 回调沿既有事件链送回宿主。答复仍走批1 的 stdin
 * 插话通道（`forwardNativeWorkerMessage`），一个进程一对管道两个方向。
 *
 * 这里放三样东西：
 * - `WorkerEscalation` 形状（escalate 工具参数 + 线上载荷同构）；
 * - `escalationLine` / `parseEscalationLine`：一行序列化与解析（纯函数，单测直喂）；
 * - 两个 env 读数（`WORKER_ESCALATE_TOOL` / `WORKER_TURN_BUDGET`），worker-main 与
 *   宿主侧都要读，放这里避免两边各抄一份读法。
 *
 * 外部 CLI 执行器没有这条 stderr 协议（它们的 stderr 语义各异），escalation 只对
 * 本机 native worker 生效——边界如实写，不做模拟（AGENTS.md：未测量的不冒充已知）。
 */

import process from "node:process";
import { randomUUID } from "node:crypto";
import type { WorkerEscalation } from "./types.ts";

export type { WorkerEscalation };

export const ESCALATION_URGENCIES = ["low", "normal", "high"] as const;
export type WorkerEscalationUrgency = (typeof ESCALATION_URGENCIES)[number];

/** worker→宿主 结构行的行首标记；worker 日志行都带 `[worker]` / `[manager]` 前缀，不冲突。 */
export const ESCALATION_LINE_PREFIX = "[escalate] ";

/** 各字段长度上限（worker 工具描述与宿主解析同一口径；超限在工具层截断，不整条丢弃）。 */
export const ESCALATION_QUESTION_MAX = 500;
export const ESCALATION_CONTEXT_MAX = 2000;
export const ESCALATION_OPTIONS_MAX = 3;
export const ESCALATION_OPTION_MAX = 120;

/**
 * `WORKER_ESCALATE_TOOL`（批2 回滚开关之一）：false / 0 / off → escalate 工具不注册，
 * worker 回到没有上报工具的旧形态（要人时写 REPORT.md 的 attention 走老通道）。
 * 缺省 / 其它值 = 开。读法与其余开关一致：只有明确写关才关，拼错值不会误关。
 */
export function workerEscalateToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WORKER_ESCALATE_TOOL?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * `WORKER_TURN_BUDGET`（自主续行预算，批2）：初始 turn 收尾后还允许自动接几段续轮。
 * 默认 3；**0 是合法值 = 关**（不续行，改动前行为）。负数按 0 收（宁可关掉）。
 */
export function workerTurnBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKER_TURN_BUDGET?.trim();
  if (raw === undefined || raw === "") return 3;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** 归一 worker 侧参数为线上载荷：超限截断、options 收敛到 ≤3 条、urgency 认不出按 normal。 */
export function normalizeEscalationInput(raw: {
  question?: unknown;
  context?: unknown;
  options?: unknown;
  urgency?: unknown;
}): { ok: true; value: WorkerEscalation } | { ok: false; message: string } {
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return { ok: false, message: "question 不能为空（要问什么，一句话说清）" };
  const context = typeof raw.context === "string" ? raw.context.trim() : "";
  if (!context) {
    return { ok: false, message: "context 不能为空（为什么问、已经试过什么，让答的人不用猜）" };
  }

  let options: string[] | undefined;
  if (raw.options !== undefined && raw.options !== null) {
    if (!Array.isArray(raw.options)) {
      return { ok: false, message: "options 必须是字符串数组" };
    }
    const trimmed = raw.options
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, ESCALATION_OPTIONS_MAX)
      .map((item) => (item.length > ESCALATION_OPTION_MAX ? item.slice(0, ESCALATION_OPTION_MAX) : item));
    if (trimmed.length > 0) options = trimmed;
  }

  const urgencyRaw = typeof raw.urgency === "string" ? raw.urgency.trim().toLowerCase() : "";
  const urgency: WorkerEscalationUrgency =
    (ESCALATION_URGENCIES as readonly string[]).includes(urgencyRaw)
      ? (urgencyRaw as WorkerEscalationUrgency)
      : "normal";

  return {
    ok: true,
    value: {
      escalationId: randomUUID(),
      question: clip(question, ESCALATION_QUESTION_MAX),
      context: clip(context, ESCALATION_CONTEXT_MAX),
      ...(options ? { options } : {}),
      urgency,
    },
  };
}

/** 序列化成一行（不含换行；调用方补 `\n`）。 */
export function escalationLine(payload: WorkerEscalation): string {
  return `${ESCALATION_LINE_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * 从 stderr 的一行里解出上报；不是上报行 / 形状不对 → null（静默，不抛——
 * stderr 上别的日志行照旧走 tail，解析失败不能把 worker 盯崩）。
 */
export function parseEscalationLine(line: string): WorkerEscalation | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(ESCALATION_LINE_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed.slice(ESCALATION_LINE_PREFIX.length));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.escalationId !== "string" || obj.escalationId === "") return null;
  if (typeof obj.question !== "string" || obj.question === "") return null;
  if (typeof obj.context !== "string") return null;
  if (obj.options !== undefined && !Array.isArray(obj.options)) return null;
  const urgency = typeof obj.urgency === "string" ? obj.urgency : "normal";
  if (!(ESCALATION_URGENCIES as readonly string[]).includes(urgency)) return null;
  return {
    escalationId: obj.escalationId,
    question: obj.question,
    context: obj.context,
    ...(Array.isArray(obj.options) ? { options: obj.options.filter((item): item is string => typeof item === "string") } : {}),
    urgency: urgency as WorkerEscalationUrgency,
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
