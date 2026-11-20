import process from "node:process";
import type {
  EmployeePermission,
  EmployeeProfile,
  WorkerKind,
} from "./types.ts";

/**
 * 用哪种雇员干活：native（pi-durable 独立进程）、mercenary（qoder CLI）、
 * codebuddy（CodeBuddy CLI）、claude-code / codex / opencode（2026-11-16 多 CLI 适配）、
 * mcp（外部 MCP 服务器，比如 Mika）或 phone（手机主动轮询）。默认 native。
 */
export const EMPLOYEE: WorkerKind = readEmployee();

function readEmployee(): WorkerKind {
  const raw = process.env.CHANCELLOR_EMPLOYEE?.trim().toLowerCase();
  if (
    raw === "mercenary" ||
    raw === "codebuddy" ||
    raw === "qoder-intl" ||
    raw === "qoder-cn" ||
    raw === "claude-code" ||
    raw === "codex" ||
    raw === "opencode" ||
    raw === "mcp" ||
    raw === "phone"
  ) {
    return raw;
  }
  return "native";
}

/** MCP 服务器地址；与 TOKEN 一起才算装好。 */
export const MCP_URL = process.env.CHANCELLOR_MCP_URL?.trim() || "";

/** MCP 设备令牌；不进仓库。 */
export const MCP_TOKEN = process.env.CHANCELLOR_MCP_TOKEN?.trim() || "";

/** 可选：指定任务提交工具名（如 mika_run_task）；不给时只有单工具才自动挑。 */
export const MCP_TOOL = process.env.CHANCELLOR_MCP_TOOL?.trim() || "";

/** 一个 Mika 任务允许等多久；超过就收成 idle，不判失败。 */
export const MCP_TASK_BUDGET_MS = readPositiveInt(
  process.env.CHANCELLOR_MCP_TASK_BUDGET_MS,
  10 * 60 * 1000,
);

/** 一个手机任务允许等多久；超过就收成 idle，不判失败。 */
export const PHONE_TASK_BUDGET_MS = readPositiveInt(
  process.env.CHANCELLOR_PHONE_TASK_BUDGET_MS,
  10 * 60 * 1000,
);

/** 缺配置时必须报错，绝不静默退回原生——否则人会以为活派到手机上了。 */
export function assertMcpConfigured(): void {
  const missing: string[] = [];
  if (MCP_URL === "") missing.push("CHANCELLOR_MCP_URL");
  if (MCP_TOKEN === "") missing.push("CHANCELLOR_MCP_TOKEN");
  if (missing.length > 0) {
    throw new Error(
      `CHANCELLOR_EMPLOYEE=mcp 缺少 ${missing.join("、")}；不会静默退回原生雇员`,
    );
  }
}

/**
 * qodercli 可执行文件。不在 PATH 里，必须写全路径。
 * 可用 CHANCELLOR_QODER_BIN 覆盖。
 */
export const QODER_BIN =
  process.env.CHANCELLOR_QODER_BIN?.trim() ||
  "<本机 qoder CLI 全路径，配 CHANCELLOR_QODER_BIN>";

/**
 * 传给 qodercli 的模型，一律显式传 `-m`，不走默认 Auto（服务端路由不可复现）。
 * 可用 CHANCELLOR_MODEL 覆盖。
 */
export const MODEL = process.env.CHANCELLOR_MODEL?.trim() || "DeepSeek-Flash";

/**
 * Qoder CN（国内版）可执行文件，登录态与国际版独立。
 * 目录里的 `qoderclicn.exe` 可能是 0 字节壳，适配器会自动回退到带版本号真身。
 */
export const QODER_CN_BIN =
  process.env.CHANCELLOR_QODER_CN_BIN?.trim() ||
  "<本机 qoder-cn CLI 全路径，配 CHANCELLOR_QODER_CN_BIN>";

/** Qoder CN 的模型；默认与国际版一致。 */
export const QODER_CN_MODEL =
  process.env.CHANCELLOR_QODER_CN_MODEL?.trim() || MODEL;

/**
 * CodeBuddy 可执行文件。装在 PATH 里，也可用 CHANCELLOR_CODEBUDDY_BIN 覆盖。
 */
export const CODEBUDDY_BIN =
  process.env.CHANCELLOR_CODEBUDDY_BIN?.trim() || "codebuddy";

/**
 * CodeBuddy 的模型 ID 与 Qoder 写法不同（全小写带版本号）。
 * 必须用 `--model` 全拼传，`-m` 在 npm shim 下会报 unknown option。
 */
export const CODEBUDDY_MODEL =
  process.env.CHANCELLOR_CODEBUDDY_MODEL?.trim() || "deepseek-v4.1-flash";

/**
 * Claude Code（2026-11-16 多 CLI 适配）。装在 PATH 里，也可用 CHANCELLOR_CLAUDE_BIN 覆盖。
 * 模型留空 = 不传 `--model`，跟随 ~/.claude/settings.json。
 * 权限缺省 full：派活是无人值守的，plan / acceptEdits 之外的命令会被拒。
 */
export const CLAUDE_BIN =
  process.env.CHANCELLOR_CLAUDE_BIN?.trim() || "claude";

export const CLAUDE_MODEL = process.env.CHANCELLOR_CLAUDE_MODEL?.trim() || "";

export const CLAUDE_PERMISSION = readPermission(
  process.env.CHANCELLOR_CLAUDE_PERMISSION,
  "full",
);

/** Codex CLI（2026-11-16）。模型留空 = 跟随 ~/.codex/config.toml。 */
export const CODEX_BIN = process.env.CHANCELLOR_CODEX_BIN?.trim() || "codex";

export const CODEX_MODEL = process.env.CHANCELLOR_CODEX_MODEL?.trim() || "";

export const CODEX_PERMISSION = readPermission(
  process.env.CHANCELLOR_CODEX_PERMISSION,
  "full",
);

/** OpenCode CLI（2026-11-16）。模型格式 provider/model；留空 = 跟随 opencode 配置。 */
export const OPENCODE_BIN =
  process.env.CHANCELLOR_OPENCODE_BIN?.trim() || "opencode";

export const OPENCODE_MODEL =
  process.env.CHANCELLOR_OPENCODE_MODEL?.trim() || "";

export const OPENCODE_PERMISSION = readPermission(
  process.env.CHANCELLOR_OPENCODE_PERMISSION,
  "full",
);

/**
 * 某档雇员的 env 缺省 profile；派单没带 profile 时用它。
 * CodeBuddy / Qoder 的权限固定全权（适配器内部写死），这里只给 model。
 */
export function defaultProfileFor(kind: WorkerKind): EmployeeProfile {
  if (kind === "claude-code") {
    return { model: CLAUDE_MODEL, permission: CLAUDE_PERMISSION };
  }
  if (kind === "codex") return { model: CODEX_MODEL, permission: CODEX_PERMISSION };
  if (kind === "opencode") {
    return { model: OPENCODE_MODEL, permission: OPENCODE_PERMISSION };
  }
  if (kind === "codebuddy") return { model: CODEBUDDY_MODEL };
  if (kind === "qoder-intl" || kind === "mercenary") return { model: MODEL };
  if (kind === "qoder-cn") return { model: QODER_CN_MODEL };
  return {};
}

/** 派单参数 + env 缺省的合并口径：显式给了就用显式的，空串算"跟随 CLI"。 */
export function resolveProfile(
  kind: WorkerKind,
  profile?: EmployeeProfile,
): EmployeeProfile {
  // mcp / phone 是部署形态，不吃 profile：别把空 model / 固定权限塞进 ticket 快照。
  if (kind === "mcp" || kind === "phone") return {};
  // native 只吃 model / modelRoute（2026-11-19 模型分工）：过去这里直接返回 {}，
  // 把 executor 设置里填的工人模型丢掉了；留空仍然不覆盖 worker 的 env 缺省。
  if (kind === "native") {
    const model = profile?.model !== undefined ? profile.model.trim() : "";
    const out: EmployeeProfile = {};
    if (model) out.model = model;
    if (profile?.modelRoute && model) out.modelRoute = profile.modelRoute;
    return out;
  }
  const fallback = defaultProfileFor(kind);
  const model =
    profile?.model !== undefined ? profile.model.trim() : fallback.model ?? "";
  // 权限档只对这三档生效；CodeBuddy / Qoder 非交互固定全权，不记权限。
  if (kind === "claude-code" || kind === "codex" || kind === "opencode") {
    return { model, permission: profile?.permission ?? fallback.permission ?? "full" };
  }
  return { model };
}

/**
 * 把一次派单的 profile 翻成子进程 env（2026-11-16）：
 * 分管宰相在自己的进程里派子单，只有 env 能跨进程带过去。
 */
export function profileEnv(
  kind: WorkerKind,
  profile?: EmployeeProfile,
): Record<string, string> {
  if (!profile) return {};
  const env: Record<string, string> = {};
  if (kind === "claude-code") {
    if (profile.model !== undefined) env.CHANCELLOR_CLAUDE_MODEL = profile.model;
    if (profile.permission) env.CHANCELLOR_CLAUDE_PERMISSION = profile.permission;
  } else if (kind === "codex") {
    if (profile.model !== undefined) env.CHANCELLOR_CODEX_MODEL = profile.model;
    if (profile.permission) env.CHANCELLOR_CODEX_PERMISSION = profile.permission;
  } else if (kind === "opencode") {
    if (profile.model !== undefined) env.CHANCELLOR_OPENCODE_MODEL = profile.model;
    if (profile.permission) env.CHANCELLOR_OPENCODE_PERMISSION = profile.permission;
  } else if (kind === "codebuddy") {
    if (profile.model !== undefined) env.CHANCELLOR_CODEBUDDY_MODEL = profile.model;
  } else if (kind === "qoder-intl" || kind === "mercenary") {
    if (profile.model !== undefined) env.CHANCELLOR_MODEL = profile.model;
  } else if (kind === "qoder-cn") {
    if (profile.model !== undefined) env.CHANCELLOR_QODER_CN_MODEL = profile.model;
  } else if (kind === "native") {
    // 2026-11-19 模型分工：分管宰相子进程里再派 native 子单，模型路由只能走 env 继承。
    if (profile.model !== undefined) env.CHANCELLOR_LLM_MODEL = profile.model;
    if (profile.modelRoute) {
      env.CHANCELLOR_LLM_BASE_URL = profile.modelRoute.baseUrl;
      const key = process.env[profile.modelRoute.keyEnv]?.trim();
      if (key) env.CHANCELLOR_LLM_API_KEY = key;
    }
  }
  return env;
}

function readPermission(
  raw: string | undefined,
  fallback: EmployeePermission,
): EmployeePermission {
  const value = raw?.trim().toLowerCase();
  if (value === "read" || value === "edit" || value === "full") return value;
  return fallback;
}

/** 拆单超时。 */
export const PLAN_TIMEOUT_MS = readEnvInt("CHANCELLOR_PLAN_TIMEOUT_MS", 180_000);

/** 单个 worker 超时，默认 10 分钟。 */
export const WORKER_TIMEOUT_MS = readEnvInt("CHANCELLOR_WORKER_TIMEOUT_MS", 10 * 60_000);

/**
 * 下游提示里注入「上游已验收落盘的产物路径清单」（2026-11-08 扫尾批 8e）。
 * 默认开；CHANCELLOR_UPSTREAM_ARTIFACTS=false 回滚成只注入 REPORT 原文。
 * 每次调用都读 env：测试要在同一进程里翻开关，模块级常量读不了第二遍。
 */
export function upstreamArtifactsEnabled(): boolean {
  return readBool(process.env.CHANCELLOR_UPSTREAM_ARTIFACTS, true);
}

/**
 * 外部 CLI 续跑（2026-11-08 扫尾批 8f）。默认开；
 * `CHANCELLOR_RESUME_EXTERNAL=false` 时外部单一律重派新单（不传 `-r`）。
 * 每次调用都读 env：测试要在同一进程里翻开关，模块级常量读不了第二遍。
 */
export function externalResumeEnabled(): boolean {
  return readBool(process.env.CHANCELLOR_RESUME_EXTERNAL, true);
}

/** 分管宰相一轮的超时；它可能要派多轮 worker，默认 30 分钟。 */
export const MANAGER_TIMEOUT_MS = readEnvInt(
  "CHANCELLOR_MANAGER_TIMEOUT_MS",
  30 * 60_000,
);

/** 默认最大任务数。 */
export const MAX_TASKS_DEFAULT = 5;

/** 依赖感知并行的上限（2026-11-03 方案 §5.4：最多 3 路）。 */
export const MAX_PARALLEL_TASKS = readEnvInt("CHANCELLOR_MAX_PARALLEL_TASKS", 3);

/** 执行隔离方式：worktree（git 项目默认）或 direct（老行为/非 git 项目）。 */
export const TASK_ISOLATION: "worktree" | "direct" =
  process.env.CHANCELLOR_TASK_ISOLATION?.trim().toLowerCase() === "direct"
    ? "direct"
    : "worktree";

/** 租约心跳间隔。 */
export const LEASE_HEARTBEAT_MS = readEnvInt("CHANCELLOR_LEASE_HEARTBEAT_MS", 30_000);

/** 心跳停多久算持有者已死；默认两个心跳周期 + 宽限。 */
export const LEASE_STALE_MS = readEnvInt("CHANCELLOR_LEASE_STALE_MS", 5 * 60_000);

/**
 * 负责人上下文窗口（2026-11-03 方案 §5.7）。
 * 只用于负责人会话：换段阈值、pi 自动压缩的预留量都按它算，冒充不了别的模型。
 */
export const MANAGER_CONTEXT_WINDOW = readEnvInt("MANAGER_CONTEXT_WINDOW", 131_072);

/** 到窗口这个比例就自动换段 / 压缩，默认 60%。 */
export const MANAGER_CONTEXT_ROTATE_RATIO = readRatio(
  process.env.MANAGER_CONTEXT_ROTATE_RATIO,
  0.6,
);

/**
 * 崩溃恢复策略（2026-11-03 方案 §5.7）：
 * - auto-before-merge（默认）：没跨过「合并进项目」就自动续一次；
 * - always-ask：一律等人确认；
 * - never：不自动续跑，只标中断。
 */
export type ResumePolicy = "auto-before-merge" | "always-ask" | "never";
export const DELEGATION_RESUME_POLICY: ResumePolicy = readResumePolicy(
  process.env.DELEGATION_RESUME_POLICY,
);

function readResumePolicy(raw: string | undefined): ResumePolicy {
  const value = raw?.trim().toLowerCase();
  if (value === "always-ask" || value === "never") return value;
  return "auto-before-merge";
}

function readRatio(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function readEnvInt(name: string, fallback: number): number {
  return readPositiveInt(process.env[name], fallback);
}

/** 只认 false / 0 / no / off 为关；其余（含未设置）走默认值。 */
function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "") return fallback;
  return !["false", "0", "no", "off"].includes(value);
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
