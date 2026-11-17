import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { CODEBUDDY_BIN, CODEBUDDY_MODEL, WORKER_TIMEOUT_MS, resolveProfile } from "../config.ts";
import type { CodeBuddyResult, EmployeeCapabilities } from "../types.ts";
import {
	isCliSuccess,
	parseCliStdout,
	runCliProcess,
	STDIN_PROMPT_THRESHOLD,
	type CliProcessResult,
	type ParsedCliStdout,
} from "./cli.ts";
import type { Employee, EmployeeOutcome, EmployeeTask } from "./index.ts";
import { buildResumePrompt, readTaskPrompt } from "./task-prompt.ts";

/**
 * CodeBuddy 非交互调用（2026-11-03，方案 §5.6）。
 *
 * 实测口径（不许凭文档想当然）：
 * - `-p` 必须带 `-y`，否则需要授权的操作被阻止；
 * - 模型只能用 `--model` 全拼，`-m` 在 npm shim 下报 unknown option；
 * - `--output-format json` 输出的是**一个 JSON 数组**，最后一项 `type=result`；
 * - 成败不能只看 `is_error`：`permission_denials` 非空也等于没干成；
 * - 从 WorkBuddy 会话继承 `CODEBUDDY_*` / `WORKBUDDY_*` 会把 CLI 认成宿主，永久挂起。
 */
export const CODEBUDDY_CAPABILITIES: EmployeeCapabilities = {
  artifacts: "taskDir",
  canWriteFiles: true,
  // 2026-11-08 扫尾批 8f2：2.x 起支持 `-r [sessionId]`，真机两段活验过（见变更记录）。
  // `--resume-create-missing` 可用但本仓不用：会话丢了要让上层看见，不静默开空会话。
  resumeWithSession: true,
};

export interface CodeBuddyCall {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  label: string;
  /** 非空时带 `-r <sessionId>`，接上上次会话（2026-11-08 扫尾批 8f2）。 */
  resumeSessionId?: string | null;
  /** 模型（2026-11-16 多 CLI 设置）：不给 = 用 env 缺省。 */
  model?: string;
  signal?: AbortSignal;
}

export interface CodeBuddyLauncher {
  command: string;
  prefixArgs: string[];
}

export interface CodeBuddyInvocation {
  args: string[];
  /** 非 null 表示提示走 stdin；argv 里不再重复。 */
  stdin: string | null;
}

export { STDIN_PROMPT_THRESHOLD };
export type ParsedCodeBuddyStdout = ParsedCliStdout;

/** 纯函数：参数与 stdin 的决定，便于单测。 */
export function buildCodeBuddyInvocation(
  prompt: string,
  model: string = CODEBUDDY_MODEL,
  resumeSessionId?: string | null,
): CodeBuddyInvocation {
  const longPrompt = prompt.length > STDIN_PROMPT_THRESHOLD;
  const args = ["-p"];
  if (!longPrompt) args.push(prompt);
  // 续接参数和 -p 同一层。真机验过两种顺序都接得上（`-p -r <id> <提示>` 与
  // `-p <提示> -r <id>`），这里钉成与 qoder 一致的样子：提示在前、-r 紧跟会话号。
  if (resumeSessionId) args.push("-r", resumeSessionId);
  args.push("--output-format", "json", "-y", "--model", model);
  return { args, stdin: longPrompt ? prompt : null };
}

/**
 * 清掉宿主注入的 CODEBUDDY_* / WORKBUDDY_*。
 *
 * 旧结论（2026-11-03 复核仍然成立）：CLI 看到 `CODEBUDDY_SESSION_ID`、
 * `WORKBUDDY_APP_VERSION` 这套变量会把自己识别成 WorkBuddy 客户端，
 * 去等一个永远不会来的 endpoint。任何一条都不能漏。
 */
export function buildCodeBuddyEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(CODEBUDDY|WORKBUDDY)_/i.test(key)) delete env[key];
  }
  return env;
}

export function parseCodeBuddyStdout(stdout: string): ParsedCodeBuddyStdout {
  return parseCliStdout(stdout, "codebuddy");
}

/** 与另外两个 CLI 同一套判定。 */
export function isCodeBuddySuccess(
  exitCode: number | null,
  parsed: ParsedCodeBuddyStdout,
): boolean {
  return isCliSuccess(exitCode, parsed);
}

/** 调一次 codebuddy；进程级超时与 abort 都走统一底座。 */
export async function runCodeBuddy(
  call: CodeBuddyCall,
): Promise<CodeBuddyResult> {
  let launcher: CodeBuddyLauncher;
  try {
    launcher = resolveCodeBuddyLauncher();
  } catch (error) {
    return emptyResult({ error: messageOf(error) });
  }

  const invocation = buildCodeBuddyInvocation(
    call.prompt,
    call.model?.trim() || CODEBUDDY_MODEL,
    call.resumeSessionId,
  );
  const result = await runCliProcess({
    label: "codebuddy",
    command: launcher.command,
    args: [...launcher.prefixArgs, ...invocation.args],
    stdin: invocation.stdin,
    cwd: call.cwd,
    timeoutMs: call.timeoutMs,
    env: buildCodeBuddyEnv(),
    signal: call.signal,
  });
  return toCodeBuddyResult(result);
}

/**
 * CodeBuddy 作为执行者：产物仍只认任务目录里的 REPORT.md。
 *
 * `run` 参数只为测试注入假 CLI；生产路径不传，走真 `runCodeBuddy`。
 */
export function createCodeBuddyEmployee(
  run: (call: CodeBuddyCall) => Promise<CodeBuddyResult> = runCodeBuddy,
): Employee {
  const execute = async (
    task: EmployeeTask,
    prompt: string,
    sessionId: string | null,
    signal?: AbortSignal,
  ): Promise<EmployeeOutcome> => {
    const response = await run({
      prompt,
      cwd: task.workDir ?? task.dir,
      timeoutMs: WORKER_TIMEOUT_MS,
      label: path.basename(task.dir),
      model: resolveProfile("codebuddy", task.settings).model,
      ...(sessionId ? { resumeSessionId: sessionId } : {}),
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
    kind: "codebuddy",
    capabilities: CODEBUDDY_CAPABILITIES,
    run: (task, signal) => execute(task, readTaskPrompt(task), null, signal),
    /**
     * 有会话号才带 `-r`，提示只发人的回答（任务书在会话里）；
     * 没有就退回整份 TASK.md（重派，不假装续接）。
     * 会话失效时 CLI 会退出码 0 + 空输出，`isCliSuccess` 判失败——让上层看见，不吞。
     */
    resume: (task, answer, signal) => {
      const sessionId = task.sessionId ?? null;
      return execute(task, buildResumePrompt(task, answer, sessionId), sessionId, signal);
    },
  };
}

/**
 * npm 全局安装给的是 `.cmd` / `.ps1` 壳，Node 的 spawn（不加 shell）跑不了它们。
 * 直接 `spawn("codebuddy")` 会得到 ENOENT —— 2026-11-03 实测踩过。
 *
 * 这里把壳解回它包着的 Node 入口，用 `node bin/codebuddy` 起进程：
 * 不经过 cmd.exe，也就不需要拼命令行，提示词里有引号/& 也不会变成注入。
 */
export function resolveCodeBuddyLauncher(
  bin: string = CODEBUDDY_BIN,
  env: NodeJS.ProcessEnv = process.env,
): CodeBuddyLauncher {
  const resolved = resolveExecutable(bin, env);
  if (!resolved) return { command: bin, prefixArgs: [] };

  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") {
    const entry = shimNodeEntry(resolved);
    if (!entry) {
      throw new Error(
        `无法从 ${resolved} 解出 CodeBuddy 的 Node 入口；` +
          "请把 CHANCELLOR_CODEBUDDY_BIN 指向该包的 bin/codebuddy",
      );
    }
    return { command: process.execPath, prefixArgs: [entry] };
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return { command: process.execPath, prefixArgs: [resolved] };
  }
  // POSIX 上 npm 装的是带 shebang 的软链，直接跑；Windows 上无扩展名只能是 Node 脚本。
  if (ext === "" && process.platform === "win32") {
    return { command: process.execPath, prefixArgs: [resolved] };
  }
  return { command: resolved, prefixArgs: [] };
}

/** 纯函数：从 npm shim 正文里解出它执行的 Node 入口（不校验存在性）。 */
export function parseShimNodeEntry(
  content: string,
  shimDir: string,
): string | null {
  const match = content.match(/node_modules[\\/]([^"'\r\n]+)/i);
  if (!match) return null;
  const relative = `node_modules/${match[1]}`.replace(/\\/g, "/");
  return path.resolve(shimDir, ...relative.split("/"));
}

function shimNodeEntry(shimPath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const entry = parseShimNodeEntry(content, path.dirname(shimPath));
  return entry !== null && fs.existsSync(entry) ? entry : null;
}

/** 解析 PATH 里的可执行文件；Windows 按 PATHEXT 找 .exe/.cmd（Node spawn 只认 .exe）。 */
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

function toCodeBuddyResult(result: CliProcessResult): CodeBuddyResult {
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

function emptyResult(patch: Partial<CodeBuddyResult>): CodeBuddyResult {
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
