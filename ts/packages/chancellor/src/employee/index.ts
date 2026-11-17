import type {
  EmployeeCapabilities,
  EmployeeKind,
  EmployeeProfile,
  WorkerKind,
} from "../types.ts";
import { assertMcpConfigured } from "../config.ts";
import { CODEBUDDY_CAPABILITIES, createCodeBuddyEmployee } from "./codebuddy.ts";
import { CLAUDE_CAPABILITIES, createClaudeEmployee } from "./claude.ts";
import { CODEX_CAPABILITIES, createCodexEmployee } from "./codex.ts";
import { createMcpEmployee, MCP_CAPABILITIES } from "./mcp.ts";
import { createMercenaryEmployee, MERCENARY_CAPABILITIES } from "./mercenary.ts";
import { OPENCODE_CAPABILITIES, createOpencodeEmployee } from "./opencode.ts";
import {
	createQoderCnEmployee,
	createQoderIntlEmployee,
	QODER_CAPABILITIES,
} from "./qoder.ts";
import { createNativeEmployee, NATIVE_CAPABILITIES } from "./native.ts";
import { createPhoneEmployee, PHONE_CAPABILITIES, phoneTransport } from "./phone.ts";

export type { EmployeeKind } from "../types.ts";

export interface EmployeeTask {
  instruction: string;
  doneWhen: string;
  /** 前置任务的结果，已拼好的文本（可能为空）。 */
  upstream: string;
  /** 任务目录，绝对路径；REPORT.md 与 artifacts 落在这里。 */
  dir: string;
  /** 实际执行 cwd（项目副本 / 项目根）；不传等于 dir。 */
  workDir?: string;
  /**
   * 上次执行留下的会话号（2026-11-08 扫尾批 8f）。只有声明
   * `resumeWithSession` 的雇员会读它；没有就是重派新单。
   */
  sessionId?: string | null;
  /**
   * 这次执行的模型 / 权限（2026-11-16 多 CLI 适配）。
   * 只有外部 CLI 读；缺省 = 各 CLI 的 env 缺省。
   */
  settings?: EmployeeProfile;
}

export interface EmployeeOutcome {
  processOk: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** worker 写的 REPORT.md 原文；没写就是 null。 */
  reportRaw: string | null;
  stderrTail: string;
  /** CLI 输出里带的会话号，落盘后供下次 resume；没有就是 null。 */
  sessionId?: string | null;
  /** 起进程/解析失败时的说明；成功时为 null。 */
  error?: string | null;
}

export interface Employee {
  readonly kind: EmployeeKind;
  readonly capabilities: EmployeeCapabilities;
  run(task: EmployeeTask, signal?: AbortSignal): Promise<EmployeeOutcome>;
  /**
   * 接着上次跑。默认实现 = 重新 run（原生/雇佣兵没有中间态，重跑就是对的）。
   * MCP 雇员覆写：读任务目录里的 task_id，先回答再继续轮询。
   */
  resume?(task: EmployeeTask, answer: string, signal?: AbortSignal): Promise<EmployeeOutcome>;
}

/** 没有覆写 resume 的雇员，续跑就是重跑。 */
export function resumeEmployee(
  employee: Employee,
  task: EmployeeTask,
  answer: string,
  signal?: AbortSignal,
): Promise<EmployeeOutcome> {
  return employee.resume
    ? employee.resume(task, answer, signal)
    : employee.run(task, signal);
}

/** 只读能力声明，不连 MCP；doctor 缺配置时也能打印。 */
export function capabilitiesOf(kind: WorkerKind): EmployeeCapabilities {
  if (kind === "mcp") return MCP_CAPABILITIES;
  if (kind === "phone") return PHONE_CAPABILITIES;
  if (kind === "mercenary") return MERCENARY_CAPABILITIES;
  if (kind === "codebuddy") return CODEBUDDY_CAPABILITIES;
  if (kind === "claude-code") return CLAUDE_CAPABILITIES;
  if (kind === "codex") return CODEX_CAPABILITIES;
  if (kind === "opencode") return OPENCODE_CAPABILITIES;
  if (kind === "qoder-intl" || kind === "qoder-cn") return QODER_CAPABILITIES;
  return NATIVE_CAPABILITIES;
}

/** 按配置挑一个 worker 雇员；三种实现产出同一个契约：干完有 REPORT.md。 */
export function createEmployee(kind: WorkerKind): Employee {
  if (kind === "mcp") {
    assertMcpConfigured();
    return createMcpEmployee();
  }
  if (kind === "phone") return createPhoneEmployee(phoneTransport());
  if (kind === "codebuddy") return createCodeBuddyEmployee();
  if (kind === "claude-code") return createClaudeEmployee();
  if (kind === "codex") return createCodexEmployee();
  if (kind === "opencode") return createOpencodeEmployee();
  if (kind === "qoder-cn") return createQoderCnEmployee();
  if (kind === "qoder-intl") return createQoderIntlEmployee();
  return kind === "mercenary" ? createMercenaryEmployee() : createNativeEmployee();
}

export {
  createMcpEmployee,
  listMcpTools,
  openMcpSession,
  resolveMikaTools,
  selectMcpTool,
  type McpSession,
  type McpTool,
  type MikaLifecycleTools,
} from "./mcp.ts";
export {
  buildCodeBuddyEnv,
  buildCodeBuddyInvocation,
  CODEBUDDY_CAPABILITIES,
  createCodeBuddyEmployee,
  isCodeBuddySuccess,
  parseCodeBuddyStdout,
  runCodeBuddy,
  type CodeBuddyCall,
  type CodeBuddyInvocation,
  type ParsedCodeBuddyStdout,
} from "./codebuddy.ts";
export {
  buildClaudeInvocation,
  CLAUDE_CAPABILITIES,
  createClaudeEmployee,
  isClaudeSuccess,
  parseClaudeStdout,
  runClaude,
  type ClaudeCall,
  type ClaudeInvocation,
} from "./claude.ts";
export {
  buildCodexInvocation,
  codexSandbox,
  CODEX_CAPABILITIES,
  createCodexEmployee,
  parseCodexStdout,
  runCodex,
  type CodexCall,
  type CodexInvocation,
  type CodexReading,
} from "./codex.ts";
export {
  buildOpencodeInvocation,
  createOpencodeEmployee,
  OPENCODE_CAPABILITIES,
  parseOpencodeStdout,
  runOpencode,
  type OpencodeCall,
  type OpencodeInvocation,
  type OpencodeReading,
} from "./opencode.ts";
export { createMercenaryEmployee, runQoder, type QoderCall } from "./mercenary.ts";
export {
  buildQoderInvocation,
  createQoderCnEmployee,
  createQoderIntlEmployee,
  QODER_CAPABILITIES,
  resolveQoderBinary,
  runQoderCn,
  runQoderIntl,
  type QoderInvocation,
} from "./qoder.ts";
export { createNativeEmployee } from "./native.ts";
export {
  assertPhoneConfigured,
  createPhoneEmployee,
  PhoneTaskTimeoutError,
  registerPhoneTransport,
  type PhoneResult,
  type PhoneTask,
  type PhoneTransport,
} from "./phone.ts";
