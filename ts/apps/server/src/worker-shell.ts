import type { Hono } from "hono";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * 手机 worker 的受限 shell（2026-11-02 契约的第四个接口）。
 *
 * 只为一件事开：把 App 拉到手机自己建的虚拟屏上（`am start --display`）。
 * 因此这里是**白名单**，不是通用 shell —— argv 必须命中下面几种形状，
 * 否则在碰 adb 之前就拒绝。执行时直接 spawn(argv 数组)，绝不拼字符串。
 */

const DEFAULT_ADB_PATH =
  "C:/Users/<user>/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ARGV = 16;
const MAX_ARG_LENGTH = 256;
const OUTPUT_LIMIT = 256 * 1024;

/** 空白、元字符、引号、反斜杠一律不许出现在参数里（exec 本就不走 shell，挡的是误用）。 */
const FORBIDDEN_CHARS = /[\s;&|$`<>(){}[\]\\!*?'"\u0000-\u001f\u007f]/;

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const COMPONENT_NAME =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*\/\.?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

export type ShellDecision = { ok: true; argv: string[] } | { ok: false; reason: string };

/**
 * 白名单校验。纯函数，不碰 adb —— 拒绝路径必须连子进程都不创建。
 *
 * 允许：
 *   am start --display <n> -n <pkg/Activity> [...]
 *   am force-stop <pkg>
 *   input -d <n> tap <x> <y>
 *   input -d <n> swipe <x1> <y1> <x2> <y2> [ms]
 */
export function validateAdbShellArgv(raw: unknown): ShellDecision {
  if (!Array.isArray(raw)) return reject("argv 必须是字符串数组");
  if (raw.length === 0) return reject("argv 不能为空");
  if (raw.length > MAX_ARGV) return reject(`参数过多（上限 ${MAX_ARGV}）`);
  if (!raw.every((item): item is string => typeof item === "string")) {
    return reject("argv 只能包含字符串");
  }

  const argv = raw;
  const command = argv[0];
  const sub = argv[1];

  const isAmStart = command === "am" && sub === "start";
  const isAmForceStop = command === "am" && sub === "force-stop";
  const isInput = command === "input";
  if (!isAmStart && !isAmForceStop && !isInput) {
    return reject("不在白名单内");
  }

  for (const token of argv) {
    const problem = tokenProblem(token);
    if (problem) return reject(problem);
  }

  if (isAmStart) return validateAmStart(argv);
  if (isAmForceStop) return validateAmForceStop(argv);
  return validateInput(argv);
}

function validateAmStart(argv: string[]): ShellDecision {
  if (argv[2] !== "--display") {
    return reject("am start 必须带 --display <n>（不许启到主屏）");
  }
  if (!isDisplay(argv[3])) return reject("--display 后必须是数字");

  let component: string | null = null;
  for (let index = 4; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--display" || token.startsWith("--display=")) {
      return reject("--display 只能出现一次");
    }
    if (token !== "-n") continue;

    if (component !== null) return reject("-n 只能出现一次");
    const value = argv[index + 1];
    if (value === undefined || !COMPONENT_NAME.test(value)) {
      return reject("-n 后必须是 pkg/Activity");
    }
    component = value;
    index += 1;
  }

  if (component === null) return reject("am start 必须用 -n 指定 pkg/Activity");
  return { ok: true, argv };
}

function validateAmForceStop(argv: string[]): ShellDecision {
  if (argv.length !== 3) return reject("am force-stop 只接受一个包名");
  if (!PACKAGE_NAME.test(argv[2])) return reject("包名不合法");
  return { ok: true, argv };
}

function validateInput(argv: string[]): ShellDecision {
  if (argv[1] !== "-d") return reject("input 必须带 -d <n>（必须在虚拟屏上操作）");
  if (!isDisplay(argv[2])) return reject("-d 后必须是数字");

  const action = argv[3];
  if (action === "tap") {
    if (argv.length !== 6) return reject("tap 需要 x y 两个坐标");
    if (!isNumber(argv[4]) || !isNumber(argv[5])) return reject("坐标必须是数字");
    return { ok: true, argv };
  }

  if (action === "swipe") {
    if (argv.length !== 8 && argv.length !== 9) {
      return reject("swipe 需要 x1 y1 x2 y2 [ms]");
    }
    for (let index = 4; index <= 7; index += 1) {
      if (!isNumber(argv[index])) return reject("滑动坐标必须是数字");
    }
    if (argv[8] !== undefined && !isNumber(argv[8], 60_000)) {
      return reject("滑动时长必须是 0..60000 的数字");
    }
    return { ok: true, argv };
  }

  return reject("input 只支持 tap / swipe");
}

function tokenProblem(token: string): string | null {
  if (token.length === 0) return "参数不能为空";
  if (token.length > MAX_ARG_LENGTH) return "参数过长";
  if (FORBIDDEN_CHARS.test(token)) return `参数含可疑字符：${token}`;
  if (looksLikePath(token)) return `参数看起来是路径：${token}`;
  return null;
}

function looksLikePath(token: string): boolean {
  if (token === ".") return true;
  if (token.startsWith("/") || token.startsWith("~")) return true;
  if (token.startsWith("./") || token.startsWith("../")) return true;
  if (token.includes("..")) return true;
  return /^[A-Za-z]:/.test(token);
}

function isNumber(token: string | undefined, max = 99_999): boolean {
  return token !== undefined && /^\d{1,5}$/.test(token) && Number(token) <= max;
}

function isDisplay(token: string | undefined): boolean {
  return token !== undefined && /^\d{1,3}$/.test(token) && Number(token) <= 255;
}

function reject(reason: string): ShellDecision {
  return { ok: false, reason };
}

// ── 执行 ──────────────────────────────────────────────────────────────

export type SpawnFn = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

const defaultSpawn: SpawnFn = spawn as unknown as SpawnFn;

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

export class ShellSetupError extends Error {
  constructor(
    readonly reason: "no_device" | "multiple_devices" | "adb_unavailable" | "adb_timeout",
    message: string,
  ) {
    super(message);
    this.name = "ShellSetupError";
  }
}

export interface ShellExecution {
  ok: boolean;
  serial: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  setupError?: ShellSetupError;
  spawnError?: Error;
}

export interface WorkerShellOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

/** 校验已由调用方做完；这里只负责选设备、跑命令、把结果摊平。 */
export async function executeAdbShell(
  argv: string[],
  options: WorkerShellOptions = {},
): Promise<ShellExecution> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const adbPath = env.ADB_PATH?.trim() || DEFAULT_ADB_PATH;

  let serial: string;
  try {
    serial = await resolveSerial(env, adbPath, timeoutMs, spawnFn);
  } catch (error) {
    if (error instanceof ShellSetupError) {
      return {
        ok: false,
        serial: null,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        setupError: error,
      };
    }
    throw error;
  }

  const outcome = await runShellCommand(adbPath, serial, argv, timeoutMs, spawnFn);
  return {
    ok: !outcome.timedOut && !outcome.spawnError && outcome.code === 0,
    serial,
    exitCode: outcome.code,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    timedOut: outcome.timedOut,
    ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}),
  };
}

async function resolveSerial(
  env: NodeJS.ProcessEnv,
  adbPath: string,
  timeoutMs: number,
  spawnFn: SpawnFn,
): Promise<string> {
  const configured = env.ADB_SERIAL?.trim() || "";
  if (configured !== "") return configured;

  let outcome = await runProcess(adbPath, ["devices"], timeoutMs, spawnFn);
  let serials = parseDeviceSerials(outcome);
  if (needsRetry(outcome) || serials.length === 0) {
    outcome = await runProcess(adbPath, ["devices"], timeoutMs, spawnFn);
    serials = parseDeviceSerials(outcome);
  }

  if (outcome.spawnError) {
    throw new ShellSetupError("adb_unavailable", `adb 起不来：${outcome.spawnError.message}`);
  }
  if (outcome.timedOut) {
    throw new ShellSetupError("adb_timeout", `adb devices 超过 ${timeoutMs}ms`);
  }
  if (outcome.code !== 0) {
    throw new ShellSetupError(
      "adb_unavailable",
      `adb devices 退出码 ${outcome.code}：${outcome.stderr.trim() || outcome.stdout.trim()}`,
    );
  }
  if (serials.length === 0) {
    throw new ShellSetupError("no_device", "没有已连接的设备（adb devices 为空）");
  }
  if (serials.length > 1) {
    throw new ShellSetupError(
      "multiple_devices",
      `有多台设备（${serials.join(", ")}），请用 ADB_SERIAL 指定`,
    );
  }
  return serials[0];
}

function parseDeviceSerials(outcome: ProcessOutcome): string[] {
  const serials: string[] = [];
  for (const line of outcome.stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+device(?:\s|$)/.exec(line.trim());
    if (match) serials.push(match[1]);
  }
  return serials;
}

function needsRetry(outcome: ProcessOutcome): boolean {
  if (outcome.spawnError || outcome.timedOut) return false;
  return outcome.code !== 0;
}

const TRANSIENT_ADB_FAILURE =
  /daemon|device offline|no devices|device not found|error: closed|protocol fault|connection reset|broken pipe/i;

async function runShellCommand(
  adbPath: string,
  serial: string,
  argv: string[],
  timeoutMs: number,
  spawnFn: SpawnFn,
): Promise<ProcessOutcome> {
  const args = ["-s", serial, "shell", ...argv];
  let outcome = await runProcess(adbPath, args, timeoutMs, spawnFn);

  // 这台机器的 adb 服务会在每条命令后被杀：失败一次就先显式拉起 daemon 再重试。
  // 不缓存任何“设备在线”的判断，下一次调用仍然从头来。
  if (!outcome.spawnError && !outcome.timedOut && outcome.code !== 0) {
    if (TRANSIENT_ADB_FAILURE.test(outcome.stderr)) {
      await runProcess(adbPath, ["start-server"], timeoutMs, spawnFn);
      outcome = await runProcess(adbPath, args, timeoutMs, spawnFn);
    }
  }
  return outcome;
}

function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number,
  spawnFn: SpawnFn,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(bin, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: asError(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: Omit<ProcessOutcome, "stdout" | "stderr">): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...outcome, stdout, stderr });
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经退出 */
      }
      setTimeout(() => {
        finish({ code: null, signal: "SIGKILL", timedOut: true });
      }, 200);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error: unknown) => {
      finish({
        code: null,
        signal: null,
        timedOut,
        spawnError: asError(error),
      });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, timedOut });
    });
  });
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= OUTPUT_LIMIT) return current;
  return (current + chunk).slice(0, OUTPUT_LIMIT);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// ── HTTP ──────────────────────────────────────────────────────────────

export function mountWorkerShell(app: Hono, options: WorkerShellOptions = {}): void {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawnFn ?? defaultSpawn;

  app.post("/api/v1/worker/shell", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { argv?: unknown } | null;
    if (!body || !Array.isArray(body.argv)) {
      logRejected(body?.argv, "argv 必须是字符串数组");
      return c.json({ ok: false, error: "bad_request", detail: "argv 必须是字符串数组" }, 400);
    }

    const decision = validateAdbShellArgv(body.argv);
    if (!decision.ok) {
      logRejected(body.argv, decision.reason);
      return c.json({ ok: false, error: "rejected", detail: decision.reason }, 400);
    }

    const execution = await executeAdbShell(decision.argv, { env, timeoutMs, spawnFn });

    if (execution.setupError) {
      const status =
        execution.setupError.reason === "multiple_devices"
          ? 409
          : execution.setupError.reason === "adb_timeout"
            ? 504
            : 503;
      console.warn(`[worker-shell] 设备不可用：${execution.setupError.message}`);
      return c.json(
        {
          ok: false,
          error: execution.setupError.reason,
          detail: execution.setupError.message,
          stdout: execution.stdout,
          stderr: execution.stderr,
        },
        status,
      );
    }

    if (execution.timedOut) {
      console.warn(`[worker-shell] 超时 ${timeoutMs}ms，已终止：${JSON.stringify(decision.argv)}`);
      return c.json(
        {
          ok: false,
          error: "timeout",
          detail: `命令超过 ${timeoutMs}ms，子进程已终止`,
          stdout: execution.stdout,
          stderr: execution.stderr,
        },
        504,
      );
    }

    if (execution.spawnError) {
      console.warn(`[worker-shell] adb 启动失败：${execution.spawnError.message}`);
      return c.json(
        {
          ok: false,
          error: "adb_unavailable",
          detail: execution.spawnError.message,
          stdout: execution.stdout,
          stderr: execution.stderr,
        },
        502,
      );
    }

    console.log(
      `[worker-shell] serial=${execution.serial} exit=${execution.exitCode} argv=${JSON.stringify(decision.argv)}`,
    );

    const payload = {
      ok: execution.ok,
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
    };
    return c.json(payload);
  });
}

function logRejected(raw: unknown, reason: string): void {
  let shown: string;
  try {
    shown = JSON.stringify(raw) ?? String(raw);
  } catch {
    shown = String(raw);
  }
  console.warn(`[worker-shell] 拒绝（未执行）argv=${shown.slice(0, 500)} 原因=${reason}`);
}
