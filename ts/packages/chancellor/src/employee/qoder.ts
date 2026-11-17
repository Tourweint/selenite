import fs from "node:fs";
import path from "node:path";
import {
	MODEL,
	QODER_BIN,
	QODER_CN_BIN,
	QODER_CN_MODEL,
	WORKER_TIMEOUT_MS,
	resolveProfile,
} from "../config.ts";
import type { EmployeeCapabilities, QoderResult } from "../types.ts";
import {
	runCliProcess,
	STDIN_PROMPT_THRESHOLD,
	type CliProcessResult,
} from "./cli.ts";
import type { Employee, EmployeeOutcome, EmployeeTask } from "./index.ts";
import { buildResumePrompt, readTaskPrompt } from "./task-prompt.ts";

/**
 * Qoder 国际版 / Qoder CN 两个适配器（2026-11-03，方案 §5.6）。
 *
 * 两个版本登录态、二进制互相独立，但命令行形状一致：
 * `-p [prompt] -w <dir> --permission-mode … -o json -m <model> --max-turns N`
 * 提示超过 8K 时 `-p` 不带位置参数，改走 stdin。
 *
 * 成功判定交给 `cli.ts`，与 CodeBuddy 同一套：
 * 退出码 0 + 有 result + 非 is_error + permission_denials 为空。
 */
export const QODER_CAPABILITIES: EmployeeCapabilities = {
  artifacts: "taskDir",
  canWriteFiles: true,
  // 2026-11-08 扫尾批 8f：qodercli 支持 -r <session_id> 续接上一段会话。
  resumeWithSession: true,
};

/** 兼容旧名字：mercenary 就是 Qoder 国际版的执行者。 */
export const MERCENARY_CAPABILITIES = QODER_CAPABILITIES;

export interface QoderCall {
  prompt: string;
  cwd: string;
  /** "none" 时传 --tools ""，纯问答；"all" 时工具全开（worker 要写文件）。 */
  tools: "none" | "all";
  timeoutMs: number;
  label: string;
  /** 非空时带 `-r <session_id>`，接上上次会话（2026-11-08 扫尾批 8f）。 */
  resumeSessionId?: string | null;
  /** 模型（2026-11-16 多 CLI 设置）：不给 = 用 env 缺省。 */
  model?: string;
  signal?: AbortSignal;
}

export interface QoderInvocation {
  args: string[];
  /** 非 null 表示提示走 stdin；argv 里不再重复。 */
  stdin: string | null;
}

/**
 * 目录里的 `qodercli.exe` 可能是 0 字节壳/失效软链；真身是带版本号的可执行文件。
 * 解析不到就把原路径交回去，让 spawn 的 ENOENT 带上可读错误。
 */
export function resolveQoderBinary(configured: string): string {
  try {
    const stat = fs.statSync(configured);
    if (stat.size > 0) return configured;
  } catch {
    return configured;
  }

  const dir = path.dirname(configured);
  const stem = path.basename(configured, path.extname(configured));
  let best: { file: string; parts: number[] } | null = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = name.match(
        new RegExp(`^${escapeRegex(stem)}-(\\d+(?:\\.\\d+)+)\\.exe$`, "i"),
      );
      if (!match?.[1]) continue;
      const parts = match[1].split(".").map(Number);
      if (!best || compareVersions(parts, best.parts) > 0) {
        best = { file: path.join(dir, name), parts };
      }
    }
  } catch {
    return configured;
  }
  return best?.file ?? configured;
}

export function buildQoderInvocation(
  call: QoderCall,
  model: string,
): QoderInvocation {
  const longPrompt = call.prompt.length > STDIN_PROMPT_THRESHOLD;
  const args = ["-p"];
  if (!longPrompt) args.push(call.prompt);
  // 续接参数跟着提示走：`-r <id>` 必须在子命令参数里，和 -p 同一层。
  if (call.resumeSessionId) args.push("-r", call.resumeSessionId);
  args.push(
    "-w",
    call.cwd,
    "--permission-mode",
    // 纯问答不需要写权限；只有 worker 要写产物，用 bypass_permissions。
    call.tools === "all" ? "bypass_permissions" : "dont_ask",
    "-o",
    "json",
  );
  if (call.tools === "none") args.push("--tools", "");
  if (model) args.push("-m", model);
  // 防跑飞：写任务 40 轮，纯问答 6 轮（方案 §5.6）。
  args.push("--max-turns", String(call.tools === "all" ? 40 : 6));
  return { args, stdin: longPrompt ? call.prompt : null };
}

/** Qoder 国际版。 */
export function runQoderIntl(call: QoderCall): Promise<QoderResult> {
  return runQoderWith(
    "qoder-intl",
    resolveQoderBinary(QODER_BIN),
    call.model?.trim() || MODEL,
    call,
  );
}

/** Qoder CN；首次调用冷启动约 100 秒，超时预算仍是 10 分钟。 */
export function runQoderCn(call: QoderCall): Promise<QoderResult> {
  return runQoderWith(
    "qoder-cn",
    resolveQoderBinary(QODER_CN_BIN),
    call.model?.trim() || QODER_CN_MODEL,
    call,
  );
}

async function runQoderWith(
  label: "qoder-intl" | "qoder-cn",
  bin: string,
  model: string,
  call: QoderCall,
): Promise<QoderResult> {
  // 配置路径可能是坏软链 / 没装：起进程前先给一句人话，不要只留 spawn ENOENT。
  // 只对"像路径"的值做存在性检查；纯命令名（PATH 里找）交给 spawn 报 ENOENT。
  const pathLike =
    bin.includes("/") || bin.includes("\\") || /^[A-Za-z]:/.test(bin);
  if (pathLike && !fs.existsSync(bin)) {
    return emptyResult({
      error: `${label === "qoder-cn" ? "Qoder 国内版" : "Qoder 国际版"}未安装：${bin} 不存在；` +
        "请重装 Qoder，或在 设置 → 派活 换成别的执行器（内部拆单已不再依赖它）",
    });
  }
  const invocation = buildQoderInvocation(call, model);
  const result = await runCliProcess({
    label,
    command: bin,
    args: invocation.args,
    stdin: invocation.stdin,
    cwd: call.cwd,
    timeoutMs: call.timeoutMs,
    signal: call.signal,
  });
  return toQoderResult(result);
}

export function createQoderIntlEmployee(
  kind: "mercenary" | "qoder-intl" = "qoder-intl",
): Employee {
  return createQoderEmployee(kind, runQoderIntl);
}

export function createQoderCnEmployee(): Employee {
  return createQoderEmployee("qoder-cn", runQoderCn);
}

/**
 * 导出是为了让测试塞一个假 `run`：断言 `-r <id>` 与纪律段真的透传到 CLI 调用上。
 * 生产路径只经由上面两个工厂。
 */
export function createQoderEmployee(
  kind: "mercenary" | "qoder-intl" | "qoder-cn",
  run: (call: QoderCall) => Promise<QoderResult>,
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
      tools: "all",
      timeoutMs: WORKER_TIMEOUT_MS,
      label: path.basename(task.dir),
      model: resolveProfile(kind, task.settings).model,
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
    kind,
    capabilities: QODER_CAPABILITIES,
    run: (task, signal) => execute(task, readTaskPrompt(task), null, signal),
    /**
     * 有会话号才带 `-r`，提示只发人的回答（任务书在会话里）；没有会话号就退回
     * 重派的整份 TASK.md（重派是不是真接上由上层如实回报，这里不假装）。
     */
    resume: (task, answer, signal) => {
      const sessionId = task.sessionId ?? null;
      return execute(task, buildResumePrompt(task, answer, sessionId), sessionId, signal);
    },
  };
}

function toQoderResult(result: CliProcessResult): QoderResult {
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

function emptyResult(patch: Partial<QoderResult> = {}): QoderResult {
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

function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
