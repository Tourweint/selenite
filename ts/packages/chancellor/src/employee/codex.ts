import path from "node:path";
import process from "node:process";
import {
  CODEX_BIN,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_MAX_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
  resolveProfile,
} from "../config.ts";
import type {
  EmployeeCapabilities,
  EmployeePermission,
  ExternalCliResult,
} from "../types.ts";
import {
  emptyCliResult,
  readReportFile,
  resolveCliLauncher,
  runCliProcess,
  STDIN_PROMPT_THRESHOLD,
} from "./cli.ts";
import { compact, makeStep, toolDetail, type CliStepEvent } from "./steps.ts";
import type { Employee, EmployeeOutcome, EmployeeTask } from "./index.ts";
import { buildResumePrompt, readTaskPrompt } from "./task-prompt.ts";

/**
 * Codex CLI 非交互适配器（2026-11-16 多 CLI 适配）。
 *
 * 实测口径（codex-cli 0.163.0）：
 * - `codex exec [resume <id>] --json --skip-git-repo-check -m <model> -s <sandbox>
 *   -c approval_policy="never" [prompt|-]`
 * - `--json` 是 JSONL 事件流：`thread.started`（带 thread_id）、`turn.completed`、
 *   `turn.failed`、`item.completed`（item.type=agent_message 才是结论）；
 * - 续跑用 `codex exec resume <session_id> <prompt>`；会话号落 session.json。
 *
 * 成败不能只看退出码：turn.failed / 非零退出码 / 没有任何 JSON 事件一律判失败。
 * `item.type=error` 不一定是失败（见 parseCodexStdout 的判定口径）。
 */
export const CODEX_CAPABILITIES: EmployeeCapabilities = {
  artifacts: "taskDir",
  canWriteFiles: true,
  resumeWithSession: true,
};

export interface CodexCall {
  prompt: string;
  cwd: string;
  model: string;
  permission: EmployeePermission;
  timeoutMs: number;
  label: string;
  resumeSessionId?: string | null;
  signal?: AbortSignal;
  /** 流式事件（2026-11-23）：给回调时逐行映射 item 事件。 */
  onStep?: (step: CliStepEvent) => void;
}

export interface CodexInvocation {
  args: string[];
  stdin: string | null;
}

export interface CodexReading {
  ok: boolean;
  sessionId: string | null;
  text: string;
  error: string | null;
}

/** 权限档 → Codex 沙箱；approval_policy 统一 never（无人值守，不能等确认）。 */
export function codexSandbox(permission: EmployeePermission): string {
  if (permission === "read") return "read-only";
  if (permission === "edit") return "workspace-write";
  return "danger-full-access";
}

/** 纯函数：参数与 stdin 的决定，便于单测。 */
export function buildCodexInvocation(call: CodexCall): CodexInvocation {
  const longPrompt = call.prompt.length > STDIN_PROMPT_THRESHOLD;
  const args = ["exec"];
  if (call.resumeSessionId) args.push("resume");
  args.push("--json", "--skip-git-repo-check");
  if (call.model) args.push("-m", call.model);
  args.push("-s", codexSandbox(call.permission), "-c", 'approval_policy="never"');
  if (call.resumeSessionId) args.push(call.resumeSessionId);
  args.push(longPrompt ? "-" : call.prompt);
  return { args, stdin: longPrompt ? call.prompt : null };
}

/**
 * Codex `--json` 的成败判定（2026-11-23 修正）。
 *
 * 本机 0.163.0 + magpie 网关实测：正常成功的回合也会先发一条
 * `item.completed` + `item.type=error` 的**元数据提示**
 * （`Configured service tier priority ...`），它只说明客户端配置被上游降级，
 * 不代表回合失败。旧实现把任何 `item.type=error` 当失败，导致整单 ok=false。
 *
 * 因此 error 类事件分两层处理，不做"忽略所有 error"的一刀切：
 * - `turn.failed` 是硬失败（真失败样本里它一定出现）；
 * - 顶层 `error` / `item.type=error` 记为"软错误"：有 `turn.completed` 时默认不推翻成功，
 *   只有 message 命中致命特征（模型不存在 / 认证失败 / 网络失败）才判失败；
 *   没有 `turn.completed` 时软错误仍判失败，避免"中途崩了但退出码 0"被吞掉。
 *
 * 致命特征用关键词而不是"service tier 白名单"：元数据提示随上游网关变化会冒新文案，
 * 白名单会漏；反过来漏判真错误代价更大，所以只对"明确致命"的 message 覆盖完成结论。
 */
export function parseCodexStdout(  stdout: string,
  exitCode: number | null,
): CodexReading {
  let sessionId: string | null = null;
  let text = "";
  let completed = false;
  let hardFailure: string | null = null;
  const softErrors: string[] = [];
  let sawJson = false;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    sawJson = true;

    const type =
      typeof event.type === "string"
        ? event.type
        : typeof event.method === "string"
          ? event.method
          : "";
    const params = isRecord(event.params) ? event.params : event;

    if (type === "thread.started" || type === "thread/started") {
      sessionId =
        stringOf(params.thread_id) ??
        stringOf(params.threadId) ??
        stringOf(params.id) ??
        sessionId;
      continue;
    }
    if (type === "turn.completed" || type === "turn/completed") {
      completed = true;
      continue;
    }
    if (type === "turn.failed" || type === "turn/failed") {
      hardFailure = errorMessageOf(params) ?? hardFailure ?? "codex 回合失败";
      continue;
    }
    if (type === "error" || type === "stream/error") {
      softErrors.push(errorMessageOf(params) ?? "codex 输出 error 事件");
      continue;
    }
    if (type === "item.completed" || type === "item/completed") {
      const item = isRecord(params.item) ? params.item : null;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        text = item.text;
      } else if (item?.type === "error") {
        softErrors.push(errorMessageOf(item) ?? "codex 工具报错");
      }
    }
  }

  if (hardFailure) return { ok: false, sessionId, text, error: hardFailure };
  if (exitCode !== 0) {
    return {
      ok: false,
      sessionId,
      text,
      error: `codex 退出码 ${exitCode === null ? "null" : exitCode}`,
    };
  }
  if (!sawJson) {
    return { ok: false, sessionId, text, error: "codex 没有输出 JSON 事件" };
  }
  const fatal = softErrors.find(isFatalCodexError);
  if (fatal !== undefined) return { ok: false, sessionId, text, error: fatal };
  if (!completed && (text.trim() === "" || softErrors.length > 0)) {
    return {
      ok: false,
      sessionId,
      text,
      error: softErrors[0] ?? "codex 没有完成回合（缺 turn.completed）",
    };
  }
  return { ok: true, sessionId, text, error: null };
}

/**
 * 明确致命的 error 文案（大小写不敏感）。只收"这一单肯定没干成"的特征：
 * 模型不存在 / 不再由网关提供、认证失败、网络连不上。刻意不收 `rate limit`：
 * 限流可能被 Codex 自动重试后成功，真正的限流失败会同时给 turn.failed / 非零退出码。
 */
const FATAL_CODEX_ERROR_PATTERNS: RegExp[] = [
  // 模型不存在 / 不再可用（注意别误伤 "Model metadata ... not found. Defaulting to fallback"）
  /\bmodel\b[^.\n]{0,80}(?:does not exist|no longer serves|unsupported)\b/i,
  /\bmodel not found\b/i,
  /\b(?:unknown|invalid|unsupported) model\b/i,
  /\bno longer serves\b/i,
  // 认证 / 授权
  /\b(?:401|403)\b/,
  /unauthori[sz]ed|forbidden|authentication (?:failed|error)|invalid (?:api )?key|incorrect api key|api key[^.\n]{0,40}(?:invalid|incorrect|missing)|not logged in|login required/i,
  // 网络 / 连接
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network (?:error|failure)|connection (?:refused|reset|failed)|fetch failed|timed out/i,
];

function isFatalCodexError(message: string): boolean {
  return FATAL_CODEX_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * 把 Codex `--json` 的一行映射成统一事件（2026-11-23 实测形状）：
 * - `item.started/completed` 的 `command_execution` → 命令事件；退出码非 0 补一条失败状态；
 * - `item.completed` 的 `file_change` → 写文件事件（本机 0.163 常走 shell，未必出现）；
 * - `mcp_tool_call` / `web_search` → 工具事件；
 * - `item.completed` 的 `error` 多数是上游元数据提示（如 priority service tier 不支持），
 *   **不算工具失败**；只有 `turn.failed` / 顶层 `error` 才记失败。
 * reasoning / agent_message 是模型自述，不产生事件。
 */
export function parseCodexStepLine(line: string): CliStepEvent[] {
  const event = parseJsonObject(line);
  if (!event) return [];
  const type = typeof event.type === "string" ? event.type : "";
  const item = isRecord(event.item) ? event.item : null;
  const steps: CliStepEvent[] = [];

  if (type === "turn.failed" || type === "error" || type === "stream/error") {
    steps.push(
      makeStep({
        type: "status",
        name: "codex",
        detail: compact(errorMessageOf(event) ?? "回合失败", 80),
        failed: true,
      }),
    );
    return steps;
  }
  if (!item) return steps;
  const itemType = typeof item.type === "string" ? item.type : "";

  if (itemType === "command_execution") {
    if (type === "item.started") {
      steps.push(
        makeStep({
          type: "tool",
          name: "command",
          detail: toolDetail("command", item),
        }),
      );
    } else if (type === "item.completed") {
      const code = typeof item.exit_code === "number" ? item.exit_code : null;
      const status = typeof item.status === "string" ? item.status : "";
      if ((code !== null && code !== 0) || status === "failed") {
        steps.push(
          makeStep({
            type: "status",
            name: "command",
            detail: code !== null ? `退出码 ${code}` : "命令失败",
            failed: true,
          }),
        );
      }
    }
    return steps;
  }

  if (itemType === "file_change" && (type === "item.completed" || type === "item.started")) {
    const failed = typeof item.status === "string" && item.status === "failed";
    steps.push(
      makeStep({
        type: "tool",
        name: "write",
        detail: fileChangeDetail(item),
        ...(failed ? { failed: true } : {}),
      }),
    );
    return steps;
  }

  if (itemType === "mcp_tool_call" && type === "item.started") {
    const name =
      (typeof item.tool === "string" && item.tool) ||
      (typeof item.name === "string" && item.name) ||
      "mcp";
    const server = typeof item.server === "string" ? `${item.server}/` : "";
    steps.push(
      makeStep({ type: "tool", name: `${server}${name}`, detail: toolDetail(name, item) }),
    );
    return steps;
  }

  if (itemType === "web_search" && type === "item.started") {
    steps.push(
      makeStep({
        type: "tool",
        name: "web_search",
        detail: compact(item.query ?? item.prompt ?? "", 80),
      }),
    );
  }
  return steps;
}

/** file_change 的 changes 只取文件名列表，不带整段 patch。 */
function fileChangeDetail(item: Record<string, unknown>): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const names = changes
    .map((change) => {
      if (typeof change === "string") {
        return change.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
      }
      if (!isRecord(change)) return "";
      const raw =
        typeof change.path === "string"
          ? change.path
          : typeof change.file_path === "string"
            ? change.file_path
            : "";
      return raw === "" ? "" : raw.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    })
    .filter((name) => name !== "");
  return compact(names.join("、"), 100);
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** 调一次 Codex；进程级超时与 abort 都走统一底座。 */
export async function runCodex(call: CodexCall): Promise<ExternalCliResult> {
  let launcher;
  try {
    launcher = resolveCliLauncher(CODEX_BIN, process.env, "Codex");
  } catch (error) {
    return emptyCliResult({ error: messageOf(error) });
  }
  const invocation = buildCodexInvocation(call);
  const onStep = call.onStep;
  return runCliProcess({
    label: "codex",
    command: launcher.command,
    args: [...launcher.prefixArgs, ...invocation.args],
    stdin: invocation.stdin,
    cwd: call.cwd,
    // 旧的墙钟字段保留给还没迁移的调用方；给了 idleTimeoutMs 后它不参与判定。
    timeoutMs: call.timeoutMs,
    // M2a：外部 CLI 改活动超时，长任务只要持续有输出就不会被 10 分钟墙钟误杀。
    idleTimeoutMs: WORKER_IDLE_TIMEOUT_MS,
    maxTimeoutMs: WORKER_MAX_TIMEOUT_MS,
    signal: call.signal,
    ...(onStep
      ? {
          onLine: (line: string) => {
            for (const step of parseCodexStepLine(line)) onStep(step);
          },
        }
      : {}),
    interpret: (stdout, exitCode) => {
      const reading = parseCodexStdout(stdout, exitCode);
      return {
        ok: reading.ok,
        sessionId: reading.sessionId,
        error: reading.error,
        result: reading.text,
      };
    },
  });
}

/** Codex 作为执行者：产物仍只认任务目录里的 REPORT.md。 */
export function createCodexEmployee(
  run: (call: CodexCall) => Promise<ExternalCliResult> = runCodex,
): Employee {
  const execute = async (
    task: EmployeeTask,
    prompt: string,
    sessionId: string | null,
    signal?: AbortSignal,
  ): Promise<EmployeeOutcome> => {
    const profile = resolveProfile("codex", task.settings);
    const response = await run({
      prompt,
      cwd: task.workDir ?? task.dir,
      model: profile.model ?? "",
      permission: (profile.permission ?? "full") as EmployeePermission,
      timeoutMs: WORKER_TIMEOUT_MS,
      label: path.basename(task.dir),
      ...(sessionId ? { resumeSessionId: sessionId } : {}),
      ...(task.onStep ? { onStep: task.onStep } : {}),
      signal,
    });
    return {
      processOk: response.ok,
      exitCode: response.exitCode,
      timedOut: response.timedOut,
      aborted: response.aborted,
      reportRaw: readReportFile(task.dir),
      stderrTail: response.stderrTail,
      sessionId: response.sessionId,
      error: response.error,
    };
  };

  return {
    kind: "codex",
    capabilities: CODEX_CAPABILITIES,
    run: (task, signal) => execute(task, readTaskPrompt(task), null, signal),
    resume: (task, answer, signal) => {
      const sessionId = task.sessionId ?? null;
      return execute(task, buildResumePrompt(task, answer, sessionId), sessionId, signal);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function errorMessageOf(value: Record<string, unknown>): string | null {
  const direct = stringOf(value.message);
  if (direct) return direct;
  const error = value.error;
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  if (isRecord(error)) {
    const nested = stringOf(error.message);
    if (nested) return nested;
  }
  const turn = value.turn;
  if (isRecord(turn)) {
    const nested = errorMessageOf(turn);
    if (nested) return nested;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
