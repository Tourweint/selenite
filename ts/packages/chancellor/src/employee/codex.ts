import path from "node:path";
import process from "node:process";
import { CODEX_BIN, WORKER_TIMEOUT_MS, resolveProfile } from "../config.ts";
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
 * Codex CLI 非交互适配器（2026-11-16 多 CLI 适配）。
 *
 * 实测口径（codex-cli 0.163.0）：
 * - `codex exec [resume <id>] --json --skip-git-repo-check -m <model> -s <sandbox>
 *   -c approval_policy="never" [prompt|-]`
 * - `--json` 是 JSONL 事件流：`thread.started`（带 thread_id）、`turn.completed`、
 *   `turn.failed`、`item.completed`（item.type=agent_message 才是结论）；
 * - 续跑用 `codex exec resume <session_id> <prompt>`；会话号落 session.json。
 *
 * 成败不能只看退出码：解析到 turn.failed / error 事件一律判失败。
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

/** 解析 `--json` 的 JSONL；兼容未来 method/params 形态，忽略不认识的事件。 */
export function parseCodexStdout(
  stdout: string,
  exitCode: number | null,
): CodexReading {
  let sessionId: string | null = null;
  let text = "";
  let completed = false;
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
      failure = errorMessageOf(params) ?? failure ?? "codex 回合失败";
      continue;
    }
    if (type === "error" || type === "stream/error") {
      failure = errorMessageOf(params) ?? failure ?? "codex 输出 error 事件";
      continue;
    }
    if (type === "item.completed" || type === "item/completed") {
      const item = isRecord(params.item) ? params.item : null;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        text = item.text;
      } else if (item?.type === "error") {
        failure = errorMessageOf(item) ?? failure ?? "codex 工具报错";
      }
    }
  }

  if (failure) return { ok: false, sessionId, text, error: failure };
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
  if (!completed && text.trim() === "") {
    return {
      ok: false,
      sessionId,
      text,
      error: "codex 没有完成回合（缺 turn.completed）",
    };
  }
  return { ok: true, sessionId, text, error: null };
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
  return runCliProcess({
    label: "codex",
    command: launcher.command,
    args: [...launcher.prefixArgs, ...invocation.args],
    stdin: invocation.stdin,
    cwd: call.cwd,
    timeoutMs: call.timeoutMs,
    signal: call.signal,
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
