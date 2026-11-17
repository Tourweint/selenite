import path from "node:path";
import process from "node:process";
import { OPENCODE_BIN, WORKER_TIMEOUT_MS, resolveProfile } from "../config.ts";
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
import type { Employee, EmployeeOutcome, EmployeeTask } from "./index.ts";
import { buildResumePrompt, readTaskPrompt } from "./task-prompt.ts";

/**
 * OpenCode CLI 非交互适配器（2026-11-16 多 CLI 适配）。
 *
 * 实测口径（opencode 2.1.1，本机已登录 Alibaba）：
 * - `opencode run --format json [-m provider/model] [--session <id>] [--auto|--agent plan] [message]`
 * - `--format json` 是 JSONL：`{"type":"text","sessionID":"ses_…","part":{"type":"text","text":"…"}}`
 * - **失败时退出码可能仍是 0**：模型不可用会输出
 *   `{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: …"}}`。
 *   所以必须看 error 事件，不能只看退出码。
 * - 不给 message 参数时从 stdin 读（实测 `printf … | opencode run --format json` 成功）。
 * - 续跑：`--session <sessionID>`；会话号从任一事件里取。
 *
 * 权限：OpenCode 只有 `--auto`（自动批准未显式拒绝的操作）和内置 plan agent。
 * `read` 用 `--agent plan`；`edit` / `full` 都用 `--auto`（OpenCode 不区分这两档）。
 */
export const OPENCODE_CAPABILITIES: EmployeeCapabilities = {
  artifacts: "taskDir",
  canWriteFiles: true,
  resumeWithSession: true,
};

export interface OpencodeCall {
  prompt: string;
  cwd: string;
  model: string;
  permission: EmployeePermission;
  timeoutMs: number;
  label: string;
  resumeSessionId?: string | null;
  signal?: AbortSignal;
}

export interface OpencodeInvocation {
  args: string[];
  stdin: string | null;
}

export interface OpencodeReading {
  ok: boolean;
  sessionId: string | null;
  text: string;
  error: string | null;
}

/** 纯函数：参数与 stdin 的决定，便于单测。 */
export function buildOpencodeInvocation(call: OpencodeCall): OpencodeInvocation {
  const longPrompt = call.prompt.length > STDIN_PROMPT_THRESHOLD;
  // --standalone 是必需的：默认走后台常驻服务，那个服务的工作目录是它第一次启动的地方，
  // 会把产物写进宿主目录（2026-11-16 冒烟实测踩过）。私有服务在 spawn 的 cwd 起，才落在任务目录。
  const args = ["run", "--standalone", "--format", "json"];
  if (call.model) args.push("-m", call.model);
  if (call.resumeSessionId) args.push("--session", call.resumeSessionId);
  // plan 是只读档；其余两档都用 --auto。OpenCode 没有单独的 workspace-write。
  if (call.permission === "read") args.push("--agent", "plan");
  else args.push("--auto");
  if (!longPrompt) args.push(call.prompt);
  return { args, stdin: longPrompt ? call.prompt : null };
}

/** 解析 `--format json` 的 JSONL；只看 text / error 两类事件。 */
export function parseOpencodeStdout(
  stdout: string,
  exitCode: number | null,
): OpencodeReading {
  let sessionId: string | null = null;
  let text = "";
  let failure: string | null = null;
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

    sessionId =
      stringOf(event.sessionID) ?? stringOf(event.sessionId) ?? sessionId;

    const part = isRecord(event.part) ? event.part : null;
    if (event.type === "text" && part?.type === "text" && typeof part.text === "string") {
      text += part.text;
      continue;
    }
    if (event.type === "error" || part?.type === "error") {
      failure =
        errorMessageOf(isRecord(part) ? part : event) ??
        errorMessageOf(event) ??
        failure ??
        "opencode 输出 error 事件";
    }
  }

  if (failure) return { ok: false, sessionId, text, error: failure };
  if (exitCode !== 0) {
    return {
      ok: false,
      sessionId,
      text,
      error: `opencode 退出码 ${exitCode === null ? "null" : exitCode}`,
    };
  }
  if (!sawJson) {
    return { ok: false, sessionId, text, error: "opencode 没有输出 JSON 事件" };
  }
  // 不要求 text 非空：交付物看 REPORT.md；有事件且没有 error 就算进程成功。
  return { ok: true, sessionId, text, error: null };
}

/** 调一次 OpenCode；进程级超时与 abort 都走统一底座。 */
export async function runOpencode(call: OpencodeCall): Promise<ExternalCliResult> {
  let launcher;
  try {
    launcher = resolveCliLauncher(OPENCODE_BIN, process.env, "OpenCode");
  } catch (error) {
    return emptyCliResult({ error: messageOf(error) });
  }
  const invocation = buildOpencodeInvocation(call);
  return runCliProcess({
    label: "opencode",
    command: launcher.command,
    args: [...launcher.prefixArgs, ...invocation.args],
    stdin: invocation.stdin,
    cwd: call.cwd,
    timeoutMs: call.timeoutMs,
    signal: call.signal,
    interpret: (stdout, exitCode) => {
      const reading = parseOpencodeStdout(stdout, exitCode);
      return {
        ok: reading.ok,
        sessionId: reading.sessionId,
        error: reading.error,
        result: reading.text,
      };
    },
  });
}

/** OpenCode 作为执行者：产物仍只认任务目录里的 REPORT.md。 */
export function createOpencodeEmployee(
  run: (call: OpencodeCall) => Promise<ExternalCliResult> = runOpencode,
): Employee {
  const execute = async (
    task: EmployeeTask,
    prompt: string,
    sessionId: string | null,
    signal?: AbortSignal,
  ): Promise<EmployeeOutcome> => {
    const profile = resolveProfile("opencode", task.settings);
    const response = await run({
      prompt,
      cwd: task.workDir ?? task.dir,
      model: profile.model ?? "",
      permission: (profile.permission ?? "full") as EmployeePermission,
      timeoutMs: WORKER_TIMEOUT_MS,
      label: path.basename(task.dir),
      ...(sessionId ? { resumeSessionId: sessionId } : {}),
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
    kind: "opencode",
    capabilities: OPENCODE_CAPABILITIES,
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
    const kind = stringOf(error.type);
    if (kind) return kind;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
