import path from "node:path";
import process from "node:process";
import {
  CLAUDE_BIN,
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
  failureReason,
  parseCliStdout,
  readReportFile,
  resolveCliLauncher,
  runCliProcess,
  STDIN_PROMPT_THRESHOLD,
  type ParsedCliStdout,
} from "./cli.ts";
import type { Employee, EmployeeOutcome, EmployeeTask } from "./index.ts";
import { buildResumePrompt, readTaskPrompt } from "./task-prompt.ts";

/**
 * Claude Code 非交互适配器（2026-11-16 多 CLI 适配）。
 *
 * 实测口径（claude 2.1.304）：
 * - `-p` 后跟提示词；`--output-format json` 输出单个 `type=result` 对象，
 *   与 CodeBuddy / Qoder 同形（`result` / `is_error` / `permission_denials` / `session_id`）；
 * - 权限：`plan` = 只读，`acceptEdits` = 可改文件，`--dangerously-skip-permissions` = 全权；
 * - 续跑：`--resume <session_id>`，新会话的会话号从 result 里取。
 *
 * 额度边界（不修）：订阅登录下 `claude -p` 的 entrypoint 是 sdk-cli，社区实测约为
 * 交互式终端的 1.8–2.9 倍；API Key 计费不受此影响。交互式 TUI 桥（magpie claudetui）
 * 是另一个量级的工程，本批刻意不做，详见 docs/设计方案/2026-11-16-多CLI打手适配与执行器设置.md。
 */
export const CLAUDE_CAPABILITIES: EmployeeCapabilities = {
  artifacts: "taskDir",
  canWriteFiles: true,
  resumeWithSession: true,
};

export interface ClaudeCall {
  prompt: string;
  cwd: string;
  model: string;
  permission: EmployeePermission;
  timeoutMs: number;
  label: string;
  /** 非空时带 `--resume <sessionId>`，接上上次会话。 */
  resumeSessionId?: string | null;
  signal?: AbortSignal;
}

export interface ClaudeInvocation {
  args: string[];
  /** 非 null 表示提示走 stdin；argv 里不再重复。 */
  stdin: string | null;
}

/** 纯函数：参数与 stdin 的决定，便于单测。 */
export function buildClaudeInvocation(call: ClaudeCall): ClaudeInvocation {
  const longPrompt = call.prompt.length > STDIN_PROMPT_THRESHOLD;
  const args = ["-p"];
  if (!longPrompt) args.push(call.prompt);
  if (call.resumeSessionId) args.push("--resume", call.resumeSessionId);
  args.push("--output-format", "json");
  if (call.permission === "full") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push(
      "--permission-mode",
      call.permission === "read" ? "plan" : "acceptEdits",
    );
  }
  if (call.model) args.push("--model", call.model);
  return { args, stdin: longPrompt ? call.prompt : null };
}

export function parseClaudeStdout(stdout: string): ParsedCliStdout {
  return parseCliStdout(stdout, "claude-code");
}

/**
 * 与 CodeBuddy / Qoder 的判定只差一条：不要求 `result` 非空。
 * Claude 把活干完、最后一句只写文件时可能没有自然语言结论，交付物仍看 REPORT.md。
 * 被拒（permission_denials）和 is_error 照样判失败。
 */
export function isClaudeSuccess(
  exitCode: number | null,
  parsed: ParsedCliStdout,
): boolean {
  return (
    exitCode === 0 &&
    parsed.found &&
    !parsed.isError &&
    parsed.permissionDenials === 0
  );
}

/** 调一次 Claude Code；进程级超时与 abort 都走统一底座。 */
export async function runClaude(call: ClaudeCall): Promise<ExternalCliResult> {
  let launcher;
  try {
    launcher = resolveCliLauncher(CLAUDE_BIN, process.env, "Claude Code");
  } catch (error) {
    return emptyCliResult({ error: messageOf(error) });
  }
  const invocation = buildClaudeInvocation(call);
  return runCliProcess({
    label: "claude-code",
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
    interpret: (stdout, exitCode) => {
      const parsed = parseClaudeStdout(stdout);
      const ok = isClaudeSuccess(exitCode, parsed);
      return {
        ok,
        sessionId: parsed.sessionId,
        error: ok ? null : failureReason("claude-code", exitCode, parsed),
        result: parsed.result,
      };
    },
  });
}

/** Claude Code 作为执行者：产物仍只认任务目录里的 REPORT.md。 */
export function createClaudeEmployee(
  run: (call: ClaudeCall) => Promise<ExternalCliResult> = runClaude,
): Employee {
  const execute = async (
    task: EmployeeTask,
    prompt: string,
    sessionId: string | null,
    signal?: AbortSignal,
  ): Promise<EmployeeOutcome> => {
    const profile = resolveProfile("claude-code", task.settings);
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
    kind: "claude-code",
    capabilities: CLAUDE_CAPABILITIES,
    run: (task, signal) => execute(task, readTaskPrompt(task), null, signal),
    resume: (task, answer, signal) => {
      const sessionId = task.sessionId ?? null;
      return execute(task, buildResumePrompt(task, answer, sessionId), sessionId, signal);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
