import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ExternalCliResult } from "../types.ts";
import { killTree } from "./kill.ts";

/**
 * 外部 CLI 的统一底座（2026-11-03，方案 §5.6；2026-11-16 扩到 Claude Code / Codex / OpenCode）。
 *
 * CodeBuddy / Qoder / Claude Code 的输出形状与失败口径一致：
 * `type=result` + `result` + `is_error` + `permission_denials`。
 * Codex / OpenCode 是 JSONL 事件流，各自传 `interpret`，但 spawn / 超时 / 取消仍走同一份。
 * 谁都不许各自写一套"成功判定"——被拒不等于干成，空结果也不等于干成。
 */

/** 超过这个长度的提示走 stdin，避开命令行上限。 */
export const STDIN_PROMPT_THRESHOLD = 8000;


export interface ParsedCliStdout {
  result: string;
  sessionId: string | null;
  isError: boolean;
  /** permission_denials 的条数；字段缺失按 0，格式异常按 1（不冒险判成功）。 */
  permissionDenials: number;
  numTurns: number | null;
  durationMs: number | null;
  found: boolean;
  error: string | null;
}

export interface CliProcessResult {
  ok: boolean;
  result: string;
  sessionId: string | null;
  isError: boolean;
  permissionDenials: number;
  numTurns: number | null;
  durationMs: number | null;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
  error: string | null;
}

export interface CliProcessCall {
  /** 只用于错误信息：codebuddy / qoder-intl / qoder-cn / claude-code / codex / opencode。 */
  label: string;
  command: string;
  args: string[];
  /** 非 null 时写入 stdin；argv 里不应重复提示。 */
  stdin: string | null;
  cwd: string;
  /**
   * 墙钟超时（旧口径）。给了 `idleTimeoutMs` 时不再使用：那边按"无输出"和
   * "总时长"两个上限判，长任务只要持续有输出就不会被墙钟误杀（M2a，2026-11-22）。
   */
  timeoutMs: number;
  /**
   * 活动超时（M2a）：stdout/stderr 任意 data 都算活动并重置空闲计时；
   * <= 0 = 不限。给了它就切到活动口径。
   */
  idleTimeoutMs?: number;
  /** 活动口径下的总时长上限；不传 / <= 0 = 不限（只认 idleTimeoutMs 存在时）。 */
  maxTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /**
   * 自定义输出判定（2026-11-16）：Codex / OpenCode 是 JSONL 事件流，
   * 没有 `type=result`；不给时按 CodeBuddy / Qoder / Claude 的同一套口径。
   */
  interpret?: (stdout: string, exitCode: number | null) => CliInterpretation;
}

/** `interpret` 的返回值：够 `EmployeeOutcome` 用，不重复解析文本。 */
export interface CliInterpretation {
  ok: boolean;
  sessionId: string | null;
  error: string | null;
  /** 结论文本（只用于排障 / 汇报；交付物仍看 REPORT.md）。 */
  result?: string;
}

/**
 * 解析 stdout：数组取最后一个 `type=result`，单对象直接认，逐行 JSON 兜底。
 * Qoder 是逐行打 `-o json`，CodeBuddy 是整段数组，同一个解析器都能吃。
 */
export function parseCliStdout(stdout: string, label: string): ParsedCliStdout {
  const found = findResultObject(stdout);
  if (!found) {
    return {
      result: "",
      sessionId: null,
      isError: false,
      permissionDenials: 0,
      numTurns: null,
      durationMs: null,
      found: false,
      error: `${label} 输出里没有 type=result 的结果`,
    };
  }
  const resultValue = found.result;
  const result =
    typeof resultValue === "string"
      ? resultValue
      : resultValue === undefined || resultValue === null
        ? ""
        : JSON.stringify(resultValue);
  return {
    result,
    sessionId:
      typeof found.session_id === "string"
        ? found.session_id
        : typeof found.sessionId === "string"
          ? found.sessionId
          : null,
    isError: found.is_error === true,
    permissionDenials: countDenials(found.permission_denials),
    numTurns: typeof found.num_turns === "number" ? found.num_turns : null,
    durationMs: typeof found.duration_ms === "number" ? found.duration_ms : null,
    found: true,
    error: null,
  };
}

/** 三个 CLI 共用：退出码 0 + 有结果 + 非 error + 没有拒绝。 */
export function isCliSuccess(
  exitCode: number | null,
  parsed: ParsedCliStdout,
): boolean {
  return (
    exitCode === 0 &&
    parsed.found &&
    parsed.result.trim() !== "" &&
    !parsed.isError &&
    parsed.permissionDenials === 0
  );
}

/** 起一个外部 CLI，超时/取消都走 killTree；stdout 只取结论，stderr 只留尾部。 */
export function runCliProcess(call: CliProcessCall): Promise<CliProcessResult> {
  if (call.signal?.aborted) {
    return Promise.resolve(emptyResult({ aborted: true, error: "已停止" }));
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    /** 旧口径的墙钟计时 / 活动口径的空闲计时（同一槽位，二选一） */
    let primaryTimer: NodeJS.Timeout | null = null;
    let maxTimer: NodeJS.Timeout | null = null;
    /** 超时判定后用于错误信息：区分空闲超时与总时长超时 */
    let timeoutLabel: string | null = null;
    /**
     * 超时口径（M2a，2026-11-22）：
     * - 给了 idleTimeoutMs：活动超时，stdout/stderr 任意 data 重置空闲计时；
     *   maxTimeoutMs 再压一个墙钟上限（不传 / <=0 = 不限）。
     * - 没给：保持旧的 timeoutMs 墙钟，输出不续命（还没迁移的调用方口径不变）。
     */
    const activityMode = call.idleTimeoutMs !== undefined;

    const clearRunTimers = (): void => {
      if (primaryTimer !== null) {
        clearTimeout(primaryTimer);
        primaryTimer = null;
      }
      if (maxTimer !== null) {
        clearTimeout(maxTimer);
        maxTimer = null;
      }
    };

    const timeoutText = (): string => timeoutLabel ?? `超时（${call.timeoutMs}ms）`;

    const finish = (result: CliProcessResult): void => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      clearRunTimers();
      resolve(result);
    };

    let child;
    try {
      // Windows 上 Git Bash / MSYS 会给子进程留一个 PWD；OpenCode 2.1.1 按它认工作目录，
      // 不认 spawn 的 cwd（2026-11-16 冒烟实测：产物写进宿主目录）。统一对齐到 call.cwd。
      const env: NodeJS.ProcessEnv = { ...(call.env ?? process.env) };
      if (call.cwd) env.PWD = call.cwd;
      child = spawn(call.command, call.args, {
        cwd: call.cwd,
        // 走 stdin 时必须是 pipe；走 argv 时 ignore，否则子进程可能等标准输入。
        stdio: [call.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        env,
      });
    } catch (error) {
      finish(
        emptyResult({
          error: `起 ${call.label} 子进程失败：${messageOf(error)}`,
        }),
      );
      return;
    }

    const onTimeout = (label: string): void => {
      if (timedOut || aborted) return;
      timedOut = true;
      timeoutLabel = label;
      clearRunTimers();
      killTree(child);
      forceTimer = setTimeout(() => {
        finish(
          emptyResult({
            timedOut: true,
            stderrTail: tail(stderr, 8000),
            error: `${label}后进程未退出`,
          }),
        );
      }, 5000);
    };

    // 有输出就顺延空闲计时；旧墙钟口径下输出不改变上限。
    const bumpActivity = (): void => {
      if (!activityMode || primaryTimer === null) return;
      primaryTimer.refresh();
    };

    if (activityMode) {
      const idleLimitMs = call.idleTimeoutMs ?? 0;
      if (idleLimitMs > 0) {
        primaryTimer = setTimeout(
          () => onTimeout(`空闲超时（${idleLimitMs}ms 无输出）`),
          idleLimitMs,
        );
      }
      const maxLimitMs = call.maxTimeoutMs ?? 0;
      if (maxLimitMs > 0) {
        maxTimer = setTimeout(
          () => onTimeout(`超时（${maxLimitMs}ms 总时长）`),
          maxLimitMs,
        );
      }
    } else {
      primaryTimer = setTimeout(
        () => onTimeout(`超时（${call.timeoutMs}ms）`),
        call.timeoutMs,
      );
    }

    const onAbort = (): void => {
      aborted = true;
      clearRunTimers();
      killTree(child);
      forceTimer = setTimeout(() => {
        finish(
          emptyResult({
            aborted: true,
            stderrTail: tail(stderr, 8000),
            error: "已停止",
          }),
        );
      }, 5000);
    };
    call.signal?.addEventListener("abort", onAbort, { once: true });

    if (call.stdin !== null) {
      child.stdin?.end(call.stdin);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      bumpActivity();
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = tail(stderr + chunk, 8000);
      bumpActivity();
    });

    child.on("error", (error) => {
      clearRunTimers();
      call.signal?.removeEventListener("abort", onAbort);
      finish(
        emptyResult({
          stderrTail: stderr,
          error: `${call.label} 子进程出错：${error.message}`,
        }),
      );
    });

    child.on("close", (code) => {
      clearRunTimers();
      call.signal?.removeEventListener("abort", onAbort);

      if (timedOut) {
        finish(
          emptyResult({
            timedOut: true,
            exitCode: code,
            stderrTail: stderr,
            error: `${timeoutText()}被杀`,
          }),
        );
        return;
      }
      if (aborted) {
        finish(
          emptyResult({
            aborted: true,
            exitCode: code,
            stderrTail: stderr,
            error: "已停止",
          }),
        );
        return;
      }

      if (call.interpret) {
        const reading = call.interpret(stdout, code);
        finish(
          emptyResult({
            ok: reading.ok,
            result: reading.result ?? "",
            sessionId: reading.sessionId,
            exitCode: code,
            stderrTail: stderr,
            error: reading.ok
              ? null
              : reading.error ?? `${call.label} 退出码 ${code === null ? "null" : code}`,
          }),
        );
        return;
      }

      const parsed = parseCliStdout(stdout, call.label);
      const ok = isCliSuccess(code, parsed);
      finish({
        ok,
        result: parsed.result,
        sessionId: parsed.sessionId,
        isError: parsed.isError,
        permissionDenials: parsed.permissionDenials,
        numTurns: parsed.numTurns,
        durationMs: parsed.durationMs,
        exitCode: code,
        timedOut: false,
        aborted: false,
        stderrTail: stderr,
        error: ok ? null : failureReason(call.label, code, parsed),
      });
    });
  });
}

export function failureReason(
  label: string,
  exitCode: number | null,
  parsed: ParsedCliStdout,
): string {
  if (parsed.error) return parsed.error;
  if (parsed.isError) return `${label} 报告 is_error=true`;
  if (parsed.permissionDenials > 0) {
    return `${label} 有 ${parsed.permissionDenials} 项操作被拒（permission_denials 非空）`;
  }
  if (parsed.result.trim() === "") return `${label} 结果为空`;
  return `${label} 退出码 ${exitCode === null ? "null" : exitCode}`;
}

function findResultObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;

  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(trimmed));
  } catch {
    /* 不是整段 JSON，交给逐行兜底 */
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      candidates.push(JSON.parse(text));
    } catch {
      /* 进度、警告直接忽略 */
    }
  }

  let found: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (isRecord(item) && item.type === "result") found = item;
      }
    } else if (isRecord(candidate) && candidate.type === "result") {
      found = candidate;
    }
  }
  return found;
}

function countDenials(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (Array.isArray(raw)) return raw.length;
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* ── 外部 CLI 启动：解析 npm shim（2026-11-16 多 CLI 适配） ─────────
 * Windows 上 `claude` / `codex` / `opencode` 都是 npm 全局安装：
 *   claude.cmd   → node_modules/@anthropic-ai/claude-code/bin/claude.exe
 *   codex.cmd    → node .../@openai/codex/bin/codex.js（再由它拉起原生 exe）
 *   opencode.cmd → node_modules/@opencode/cli/bin/opencode.exe
 * Node 的 spawn（shell:false）不能直接跑 .cmd；这里把壳解回真正的 .exe / .js。
 * 提示词里可能有引号 / &，所以绝不用 shell:true 拼命令行。
 */

export interface CliLauncher {
  command: string;
  prefixArgs: string[];
}

export function resolveCliLauncher(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  label = "CLI",
): CliLauncher {
  const resolved = resolveExecutable(bin, env) ?? resolveExact(bin, env);
  if (!resolved) return { command: bin, prefixArgs: [] };
  return launcherFor(resolved, label);
}

/** 解析 PATH：Windows 按 PATHEXT 找 .exe/.cmd；POSIX 找无扩展名的可执行文件。 */
function resolveExecutable(bin: string, env: NodeJS.ProcessEnv): string | null {
  const hasSeparator = bin.includes("/") || bin.includes("\\");
  if (hasSeparator || path.isAbsolute(bin)) {
    return fs.existsSync(bin) ? path.resolve(bin) : null;
  }

  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, bin + extension.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 兜底找原名的文件（POSIX 上 npm 给的是无扩展名 shim）。 */
function resolveExact(bin: string, env: NodeJS.ProcessEnv): string | null {
  if (bin.includes("/") || bin.includes("\\") || path.isAbsolute(bin)) {
    return fs.existsSync(bin) ? path.resolve(bin) : null;
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function launcherFor(file: string, label: string): CliLauncher {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") {
    const target = shimTarget(file);
    if (target) return target;
    throw new Error(
      `无法从 ${file} 解出 ${label} 的启动目标；` +
        `请把对应的 *_BIN 指向真实的 .exe / .js 文件`,
    );
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return { command: process.execPath, prefixArgs: [file] };
  }
  if (ext === "" && process.platform === "win32") {
    // Windows 上无扩展名的 POSIX shim 跑不了；同目录通常有 .cmd。
    const cmd = `${file}.cmd`;
    if (fs.existsSync(cmd)) return launcherFor(cmd, label);
    return { command: process.execPath, prefixArgs: [file] };
  }
  return { command: file, prefixArgs: [] };
}

/** 从 npm shim 正文里找 `node_modules/...` 目标：.exe 直接起，.js 用 node 起。 */
function shimTarget(shimPath: string): CliLauncher | null {
  let content: string;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(shimPath);
  const pattern = /node_modules[\\/]([^"'\r\n]+)/gi;
  for (const match of content.matchAll(pattern)) {
    const captured = match[1];
    if (!captured) continue;
    const relative = `node_modules/${captured}`.replace(/\\/g, "/").trim();
    const absolute = path.resolve(dir, ...relative.split("/"));
    if (!fs.existsSync(absolute)) continue;
    const ext = path.extname(absolute).toLowerCase();
    if (ext === ".exe" || ext === ".com") {
      return { command: absolute, prefixArgs: [] };
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return { command: process.execPath, prefixArgs: [absolute] };
    }
    if (ext === "" && process.platform === "win32") {
      return { command: process.execPath, prefixArgs: [absolute] };
    }
  }
  return null;
}

/** 读任务目录里的 REPORT.md；缺失 / 读失败都当没有。 */
export function readReportFile(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, "REPORT.md"), "utf8");
  } catch {
    return null;
  }
}

/** 新适配器的空结果；字段与 CliProcessResult 对齐，够 EmployeeOutcome 用。 */
export function emptyCliResult(
  patch: Partial<ExternalCliResult> = {},
): ExternalCliResult {
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

function emptyResult(patch: Partial<CliProcessResult>): CliProcessResult {
  return {
    ok: false,
    result: "",
    sessionId: null,
    isError: false,
    permissionDenials: 0,
    numTurns: null,
    durationMs: null,
    exitCode: null,
    timedOut: false,
    aborted: false,
    stderrTail: "",
    error: null,
    ...patch,
  };
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
