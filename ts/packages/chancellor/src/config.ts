import process from "node:process";
import type {
  EmployeePermission,
  EmployeeProfile,
  WorkerKind,
} from "./types.ts";

/**
 * 用哪种雇员干活：pool（本机执行器池，pi-durable 常驻进程）、mercenary（qoder CLI）、
 * codebuddy（CodeBuddy CLI）、claude-code / codex / opencode（2026-11-16 多 CLI 适配）、
 * doubao（豆包 CLI）、mcp（外部 MCP 服务器，比如 Mika）或 phone（手机主动轮询）。
 * 默认 pool；旧的 native（每票一个裸子进程）已于 2026-11-23 退役。
 */
export const EMPLOYEE: WorkerKind = readEmployee();

function readEmployee(): WorkerKind {
  const raw = process.env.CHANCELLOR_EMPLOYEE?.trim().toLowerCase();
  if (
    raw === "mercenary" ||
    raw === "pool" ||
    raw === "codebuddy" ||
    raw === "qoder-intl" ||
    raw === "qoder-cn" ||
    raw === "claude-code" ||
    raw === "codex" ||
    raw === "opencode" ||
    raw === "doubao" ||
    raw === "mcp" ||
    raw === "phone"
  ) {
    return raw;
  }
  if (raw === "native") {
    console.warn("[chancellor] CHANCELLOR_EMPLOYEE=native 已退役，按 pool 处理");
  }
  return "pool";
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

/**
 * 派活是否把项目的全部文件夹下发给工人（2026-11-24）。
 *
 * 默认开；`DELEGATION_PROJECT_ROOTS=0/false/off` 回到"只给主文件夹"的旧形态。
 * 开关只决定**下发 / 边界**，不改项目登记与 worktree 语义：主文件夹始终是唯一的
 * worktree / 合并 / 租约单位，其他文件夹始终是共享读写。
 */
export function projectRootsDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DELEGATION_PROJECT_ROOTS?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

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
 * Qoder 国际版 / 国内版权限档（2026-11-23）：`read`→`dont_ask`、
 * `edit`→`accept_edits`、`full`→`bypass_permissions`；纯问答路径仍固定 `dont_ask`。
 */
export const QODER_PERMISSION = readPermission(
  process.env.CHANCELLOR_QODER_PERMISSION,
  "full",
);

export const QODER_CN_PERMISSION = readPermission(
  process.env.CHANCELLOR_QODER_CN_PERMISSION,
  "full",
);

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
 * CodeBuddy 权限档（2026-11-23）：`read`→`dontAsk`、`edit`→`acceptEdits`、
 * `full`→`bypassPermissions`（`-p` 的预授权按实测不再固定带 `-y`，见变更记录）。
 */
export const CODEBUDDY_PERMISSION = readPermission(
  process.env.CHANCELLOR_CODEBUDDY_PERMISSION,
  "full",
);

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
 * 豆包 CLI（2026-11-23）。`doubao` 是 npm 全局 shim（PATH 直达），
 * 也可用 CHANCELLOR_DOUBAO_BIN 覆盖。
 *
 * 默认模型钉 DeepSeek V4.1 Flash：它本来就是豆包账号的默认档（`model list` 里
 * `is_default: true`），钉住是为了换机器也能复现同一份配置。模型 id 必须带
 * `person-` 前缀，不能用显示名。
 *
 * 权限只有 ask_always / ask_risky / always_allow 三档，没有只读沙箱；
 * read 档映射到 ask_risky，普通文件写入仍会执行（2026-11-23 实测）。
 */
export const DOUBAO_BIN =
  process.env.CHANCELLOR_DOUBAO_BIN?.trim() || "doubao";

export const DOUBAO_MODEL =
  process.env.CHANCELLOR_DOUBAO_MODEL?.trim() ||
  "person-deepseek-v4-1-flash-261017";

export const DOUBAO_PERMISSION = readPermission(
  process.env.CHANCELLOR_DOUBAO_PERMISSION,
  "full",
);

/**
 * 某档雇员的 env 缺省 profile；派单没带 profile 时用它。
 * 本批（2026-11-23）起 CodeBuddy / Qoder 的权限档也吃 env 缺省，不再写死全权。
 */
export function defaultProfileFor(kind: WorkerKind): EmployeeProfile {
  if (kind === "claude-code") {
    return { model: CLAUDE_MODEL, permission: CLAUDE_PERMISSION };
  }
  if (kind === "codex") return { model: CODEX_MODEL, permission: CODEX_PERMISSION };
  if (kind === "opencode") {
    return { model: OPENCODE_MODEL, permission: OPENCODE_PERMISSION };
  }
  if (kind === "codebuddy") {
    return { model: CODEBUDDY_MODEL, permission: CODEBUDDY_PERMISSION };
  }
  if (kind === "doubao") {
    return { model: DOUBAO_MODEL, permission: DOUBAO_PERMISSION };
  }
  if (kind === "qoder-intl" || kind === "mercenary") {
    return { model: MODEL, permission: QODER_PERMISSION };
  }
  if (kind === "qoder-cn") {
    return { model: QODER_CN_MODEL, permission: QODER_CN_PERMISSION };
  }
  return {};
}

/** 派单参数 + env 缺省的合并口径：显式给了就用显式的，空串算"跟随 CLI"。 */
export function resolveProfile(
  kind: WorkerKind,
  profile?: EmployeeProfile,
): EmployeeProfile {
  // mcp / phone 是部署形态，不吃 profile：别把空 model / 固定权限塞进 ticket 快照。
  if (kind === "mcp" || kind === "phone") return {};
  // 本机池只吃 model / modelRoute（2026-11-19 模型分工）：过去这里直接返回 {}，
  // 把 executor 设置里填的工人模型丢掉了；留空仍然不覆盖池进程的 env 缺省。
  if (kind === "pool") {
    const model = profile?.model !== undefined ? profile.model.trim() : "";
    const out: EmployeeProfile = {};
    if (model) out.model = model;
    if (profile?.modelRoute && model) out.modelRoute = profile.modelRoute;
    return out;
  }
  const fallback = defaultProfileFor(kind);
  const model =
    profile?.model !== undefined ? profile.model.trim() : fallback.model ?? "";
  // 权限档生效的档（2026-11-23 起含 CodeBuddy / Qoder 国际 / Qoder 国内）；
  // pool / phone / mcp 不吃权限。
  if (
    kind === "claude-code" ||
    kind === "codex" ||
    kind === "opencode" ||
    kind === "doubao" ||
    kind === "codebuddy" ||
    kind === "qoder-intl" ||
    kind === "mercenary" ||
    kind === "qoder-cn"
  ) {
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
    if (profile.permission) env.CHANCELLOR_CODEBUDDY_PERMISSION = profile.permission;
  } else if (kind === "doubao") {
    if (profile.model !== undefined) env.CHANCELLOR_DOUBAO_MODEL = profile.model;
    if (profile.permission) env.CHANCELLOR_DOUBAO_PERMISSION = profile.permission;
  } else if (kind === "qoder-intl" || kind === "mercenary") {
    if (profile.model !== undefined) env.CHANCELLOR_MODEL = profile.model;
    if (profile.permission) env.CHANCELLOR_QODER_PERMISSION = profile.permission;
  } else if (kind === "qoder-cn") {
    if (profile.model !== undefined) env.CHANCELLOR_QODER_CN_MODEL = profile.model;
    if (profile.permission) env.CHANCELLOR_QODER_CN_PERMISSION = profile.permission;
  } else if (kind === "pool") {
    // 2026-11-19 模型分工：分管宰相子进程里再派池子单，模型路由只能走 env 继承。
    // 2026-11-22：pool 走同一条；另外记下 keyEnv 变量名，池桥把它原样带进 run 载荷，
    // 密钥值仍由池进程从自己的 env 取（值不过 HTTP）。
    if (profile.model !== undefined) env.CHANCELLOR_LLM_MODEL = profile.model;
    if (profile.modelRoute) {
      env.CHANCELLOR_LLM_BASE_URL = profile.modelRoute.baseUrl;
      env.CHANCELLOR_LLM_KEY_ENV = profile.modelRoute.keyEnv;
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

/** 单个 worker 超时，默认 10 分钟。 */
export const WORKER_TIMEOUT_MS = readEnvInt("CHANCELLOR_WORKER_TIMEOUT_MS", 10 * 60_000);

/**
 * 外部 CLI 的单票超时（M2a，2026-11-22）：空闲 + 总时长两个上限，0 = 该项不限。
 * 本机池走 supervisor 自己的 idle / max 口径，不用这两个值。
 */
export const WORKER_IDLE_TIMEOUT_MS = readEnvIntUnlimited(
  "CHANCELLOR_WORKER_IDLE_MS",
  10 * 60_000,
);

/** 外部 CLI 单票总时长上限，默认 60 分钟；0 = 不限。 */
export const WORKER_MAX_TIMEOUT_MS = readEnvIntUnlimited(
  "CHANCELLOR_WORKER_MAX_MS",
  60 * 60_000,
);

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

/**
 * 外部 CLI 流式事件（2026-11-23）：默认开；`CHANCELLOR_CLI_STREAM_EVENTS=false/0/off`
 * 关闭所有 CLI 的事件采集、steps.jsonl 与 UI 步骤，回到「只有最终结果」的形态。
 * 每次调用都读 env：界面开关（plugins.json 登记、scope=core）写回 env 后即时生效。
 */
export function cliStreamEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBool(env.CHANCELLOR_CLI_STREAM_EVENTS, true);
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

/**
 * 超时类 env：0 / 负数本身是"不限"的合法写法，不能像 readPositiveInt 那样回落默认值。
 * 只有空值或非数字才回落默认。
 */
function readEnvIntUnlimited(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}
