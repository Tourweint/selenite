import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  DOUBAO_BIN,
  DOUBAO_MODEL,
  DOUBAO_PERMISSION,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_MAX_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
  resolveProfile,
} from "../config.ts";
import type {
  DoubaoResult,
  EmployeeCapabilities,
  EmployeePermission,
} from "../types.ts";
import {
  resolveCliLauncher,
  runCliProcess,
  STDIN_PROMPT_THRESHOLD,
  type CliInterpretation,
  type CliProcessResult,
} from "./cli.ts";
import { makeStep, toolDetail, type CliStepEvent } from "./steps.ts";
import type { Employee, EmployeeOutcome, EmployeeTask } from "./index.ts";
import { buildResumePrompt, readTaskPrompt } from "./task-prompt.ts";

/**
 * 豆包 CLI 非交互调用（2026-11-23）。
 *
 * 实测口径（v2.37.2，不许凭文档想当然）：
 * - 成功时 stdout 只有一行 `type=result`，正文在 `result.content`（对象，不是字符串）；
 * - `[cli-chat]` 进度日志全在 stderr，会话号在顶层 `session_id`；
 * - **stdout 接匿名管道必报 `internal_error: 无法启动主任务`**（Windows 重叠句柄
 *   不支持复制），所以这里把 stdout 落到临时文件再读；
 * - `-C` 必须是第一个参数，放到 `--permission-mode` 之后会 `invalid_arguments`；
 * - 权限只有 ask_always / ask_risky / always_allow，没有只读沙箱：
 *   `read` 映射到 ask_risky（实测普通写文件仍会执行），写 / 全权用 always_allow。
 */
export const DOUBAO_CAPABILITIES: EmployeeCapabilities = {
  artifacts: "taskDir",
  canWriteFiles: true,
  resumeWithSession: true,
};

export interface DoubaoCall {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  label: string;
  /** 不传 / 空串 = 不带 `--model`，跟随豆包账号默认（当前也是 DeepSeek V4.1 Flash）。 */
  model?: string;
  permission?: EmployeePermission;
  /** 非空时带 `--resume <sessionId>`，接上上次会话。 */
  resumeSessionId?: string | null;
  signal?: AbortSignal;
  /** 流式事件的降级口径（2026-11-23）：结束后从最终 tool_calls 生成步骤。 */
  onStep?: (step: CliStepEvent) => void;
}

export interface DoubaoInvocation {
  args: string[];
  /** 非 null 表示提示走 stdin（`-p -`）；argv 里不再重复。 */
  stdin: string | null;
}

export { STDIN_PROMPT_THRESHOLD };
export type ParsedDoubaoToolCall = {
  name: string;
  input: unknown;
  failed: boolean;
};
export type ParsedDoubaoStdout = {
  result: string;
  sessionId: string | null;
  isError: boolean;
  found: boolean;
  error: string | null;
  /**
   * 最终结果里的工具清单（2026-11-23 实测：`--output-format json` 的 result 顶层
   * 带 `tool_calls`，每项有 name / input / result.is_error）。`stream-json` 落文件
   * 无法可靠增量读时，用它生成「大概干了啥」的步骤与统计。
   */
  toolCalls: ParsedDoubaoToolCall[];
  /** 服务端截断过工具清单：统计仍然给，但要如实说明不完整。 */
  toolCallsTruncated: boolean;
};

/** 权限三档 → 豆包原生参数。没有只读档，read 只能退到 ask_risky。 */
export function doubaoPermissionMode(
  permission: EmployeePermission = DOUBAO_PERMISSION,
): "ask_risky" | "always_allow" {
  return permission === "read" ? "ask_risky" : "always_allow";
}

/** 纯函数：参数与 stdin 的决定，便于单测。 */
export function buildDoubaoInvocation(
  prompt: string,
  cwd: string,
  model: string = DOUBAO_MODEL,
  permission: EmployeePermission = DOUBAO_PERMISSION,
  resumeSessionId?: string | null,
): DoubaoInvocation {
  const longPrompt = prompt.length > STDIN_PROMPT_THRESHOLD;
  // -C 必须是首个参数：放到权限参数之后实测报 invalid_arguments。
  const args = ["-C", cwd];
  const pickedModel = model.trim();
  if (pickedModel) args.push("--model", pickedModel);
  args.push("--permission-mode", doubaoPermissionMode(permission));
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  args.push("-p", longPrompt ? "-" : prompt, "--output-format", "json");
  return { args, stdin: longPrompt ? prompt : null };
}

/**
 * 解析 stdout：只认 `type=result` 的 JSON 行；正文在 `result.content`。
 * 豆包的 `result` 是对象，不能走 `parseCliStdout`（那边会 stringify 成 JSON 文本）。
 */
export function parseDoubaoStdout(stdout: string): ParsedDoubaoStdout {
  let found: Record<string, unknown> | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value) && value.type === "result") found = value;
    } catch {
      // 非 JSON 行（内部错误文本等）跳过，最后按"没找到结果"判失败。
    }
  }
  if (!found) {
    return {
      result: "",
      sessionId: null,
      isError: false,
      found: false,
      error: "豆包输出里没有 type=result 的结果",
      toolCalls: [],
      toolCallsTruncated: false,
    };
  }
  const payload = isRecord(found.result) ? found.result : null;
  const result =
    payload && typeof payload.content === "string"
      ? payload.content
      : typeof found.result === "string"
        ? found.result
        : "";
  return {
    result,
    sessionId:
      typeof found.session_id === "string" ? found.session_id : null,
    isError: found.is_error === true || found.subtype === "error",
    found: true,
    error: null,
    toolCalls: parseDoubaoToolCalls(found.tool_calls),
    toolCallsTruncated: found.tool_calls_truncated === true,
  };
}

/** 只取 name / input / is_error；不搬 result 正文（那是过程全文，不许进事件）。 */
function parseDoubaoToolCalls(raw: unknown): ParsedDoubaoToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ParsedDoubaoToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const result = isRecord(item.result) ? item.result : null;
    calls.push({
      name: item.name,
      input: item.input,
      failed: result?.is_error === true,
    });
  }
  return calls;
}

/** 把最终 tool_calls 转成统一事件（豆包降级口径：事后补发，不做实时尾读）。 */
export function doubaoStepEvents(parsed: ParsedDoubaoStdout): CliStepEvent[] {
  return parsed.toolCalls.map((call) =>
    makeStep({
      type: "tool",
      name: call.name,
      detail: toolDetail(call.name, call.input),
      ...(call.failed ? { failed: true } : {}),
    }),
  );
}

/** 与其它 CLI 同一套成功口径：退出码 0 + 有结果 + 非 error。 */
export function interpretDoubao(
  stdout: string,
  exitCode: number | null,
  onStep?: (step: CliStepEvent) => void,
): CliInterpretation {
  const parsed = parseDoubaoStdout(stdout);
  if (!parsed.found) {
    return { ok: false, sessionId: null, error: parsed.error };
  }
  if (onStep) {
    for (const step of doubaoStepEvents(parsed)) onStep(step);
  }
  const ok =
    exitCode === 0 && !parsed.isError && parsed.result.trim() !== "";
  return {
    ok,
    sessionId: parsed.sessionId,
    error: ok
      ? null
      : parsed.isError
        ? "豆包报告 is_error=true"
        : `豆包退出码 ${exitCode === null ? "null" : exitCode}`,
    result: parsed.result,
  };
}

/** 调一次 doubao；进程级超时与 abort 走统一底座，stdout 落临时文件。 */
export async function runDoubao(call: DoubaoCall): Promise<DoubaoResult> {
  let launcher: { command: string; prefixArgs: string[] };
  try {
    launcher = resolveCliLauncher(DOUBAO_BIN, process.env, "豆包");
  } catch (error) {
    return emptyResult({ error: messageOf(error) });
  }

  const invocation = buildDoubaoInvocation(
    call.prompt,
    call.cwd,
    call.model?.trim() || DOUBAO_MODEL,
    call.permission ?? DOUBAO_PERMISSION,
    call.resumeSessionId,
  );
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-out-"));
  const stdoutFile = path.join(outDir, "stdout.json");
  const onStep = call.onStep;
  try {
    const result = await runCliProcess({
      label: "doubao",
      command: launcher.command,
      args: [...launcher.prefixArgs, ...invocation.args],
      stdin: invocation.stdin,
      cwd: call.cwd,
      timeoutMs: call.timeoutMs,
      // 外部 CLI 的活动超时：stderr 有 [cli-chat] 进度日志，能续空闲计时。
      idleTimeoutMs: WORKER_IDLE_TIMEOUT_MS,
      maxTimeoutMs: WORKER_MAX_TIMEOUT_MS,
      env: process.env,
      stdoutFile,
      // 降级口径：stdout 只能落文件，工具步骤在进程结束后从最终 tool_calls 补发。
      interpret: (stdout, exitCode) => interpretDoubao(stdout, exitCode, onStep),
      signal: call.signal,
    });
    return toDoubaoResult(result);
  } finally {
    try {
      fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows 上子进程刚退出时目录可能仍被占用；清理失败不影响本次结果。
    }
  }
}

/** 豆包作为执行者：产物仍只认任务目录里的 REPORT.md。 */
export function createDoubaoEmployee(
  run: (call: DoubaoCall) => Promise<DoubaoResult> = runDoubao,
): Employee {
  const execute = async (
    task: EmployeeTask,
    prompt: string,
    sessionId: string | null,
    signal?: AbortSignal,
  ): Promise<EmployeeOutcome> => {
    const profile = resolveProfile("doubao", task.settings);
    const response = await run({
      prompt,
      cwd: task.workDir ?? task.dir,
      timeoutMs: WORKER_TIMEOUT_MS,
      label: path.basename(task.dir),
      model: profile.model,
      permission: profile.permission ?? DOUBAO_PERMISSION,
      ...(sessionId ? { resumeSessionId: sessionId } : {}),
      ...(task.onStep ? { onStep: task.onStep } : {}),
      signal,
    });
    return {
      processOk: response.ok,
      exitCode: response.exitCode,
      timedOut: response.timedOut,
      aborted: response.aborted,
      reportRaw: readReport(task.dir),
      stderrTail: response.stderrTail,
      sessionId: response.sessionId,
      error: response.error,
    };
  };

  return {
    kind: "doubao",
    capabilities: DOUBAO_CAPABILITIES,
    run: (task, signal) => execute(task, readTaskPrompt(task), null, signal),
    resume: (task, answer, signal) => {
      const sessionId = task.sessionId ?? null;
      return execute(
        task,
        buildResumePrompt(task, answer, sessionId),
        sessionId,
        signal,
      );
    },
  };
}

function toDoubaoResult(result: CliProcessResult): DoubaoResult {
  return {
    ok: result.ok,
    result: result.result,
    sessionId: result.sessionId,
    isError: result.isError,
    permissionDenials: result.permissionDenials,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stderrTail: result.stderrTail,
    error: result.error,
  };
}

function emptyResult(patch: Partial<DoubaoResult>): DoubaoResult {
  return {
    ok: false,
    result: "",
    sessionId: null,
    isError: false,
    permissionDenials: 0,
    exitCode: null,
    timedOut: false,
    aborted: false,
    stderrTail: "",
    error: null,
    ...patch,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readReport(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
