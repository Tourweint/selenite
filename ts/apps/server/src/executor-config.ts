/**
 * 执行器运行时配置（2026-11-16 多 CLI 打手适配）。
 *
 * 用户口径：桌面端要能选"派活用哪个 CLI"、每个 CLI 用什么模型 / 权限。
 * 落点 `.data/executor.json`；文件不存在或 `EXECUTOR_CONFIG=false` 时回落到现有 env
 * （`CHANCELLOR_EMPLOYEE` / `CHANCELLOR_*_MODEL` / `CHANCELLOR_*_PERMISSION`），
 * 行为与加这层之前一致。
 *
 * 为什么是全局默认 + 建单快照，不是按单选择：
 * 现有任务中心没有"这张单选谁"的交互；先把用户要的"设置里能选"做对。
 * 建单时把 employee / profile 交给 chancellor，续跑按原单快照走——换默认只影响新单。
 *
 * 刻意不做：
 * - 不在这里探测 CLI 登录状态 / 版本（会拖慢设置页；失败由任务中心的汇报如实显示）；
 * - 模型清单不进页自动拉：probe 端点（executor-probe.ts）只在用户点箭头 / 点检测时跑；
 *   模型是自由文本，留空 = 跟随该 CLI 自己的配置。
 *
 * 界面措辞（2026-11-16 用户口径）：不叫「执行器」——它就是一个普通工人，
 * 界面与系统提示统一说「默认派给谁 / 派活默认交给」。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  EmployeePermission,
  EmployeeProfile,
} from "../../../packages/chancellor/src/types.ts";

export const EXECUTOR_KINDS = [
  "native",
  "codebuddy",
  "qoder-intl",
  "qoder-cn",
  "claude-code",
  "codex",
  "opencode",
  "phone",
  "mcp",
] as const;

export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

/** 界面能选的本地执行器；phone / mcp 是部署形态，只在 env 里切。 */
export const SELECTABLE_EXECUTOR_KINDS = [
  "native",
  "codebuddy",
  "qoder-intl",
  "qoder-cn",
  "claude-code",
  "codex",
  "opencode",
] as const;

export type SelectableExecutorKind = (typeof SELECTABLE_EXECUTOR_KINDS)[number];

export function isSelectableExecutorKind(raw: string): raw is SelectableExecutorKind {
  return (SELECTABLE_EXECUTOR_KINDS as readonly string[]).includes(raw);
}

export interface ExecutorKindInfo {
  id: ExecutorKind;
  label: string;
  /** 界面下拉是否可选；false = 只显示当前值 + 说明。 */
  selectable: boolean;
  /** null = 权限档固定，不画控件。 */
  permissions: EmployeePermission[] | null;
  modelHint: string;
  /** 卡片上的边界说明（Claude 额度等）。 */
  note?: string;
}

export const EXECUTOR_KIND_INFO: ExecutorKindInfo[] = [
  {
    id: "native",
    label: "本机内核（pi-durable）",
    selectable: true,
    permissions: null,
    modelHint: "留空跟随启动 env（LLM_MODEL）；例如 deepseek-v4.1-flash",
    note: "不是外部 CLI；模型留空走启动 env（默认 deepseek-v4.1-flash），填了则派活的 native 工人用该模型（仍走百炼兼容端点）。",
  },
  {
    id: "codebuddy",
    label: "CodeBuddy",
    selectable: true,
    permissions: null,
    modelHint: "例如 deepseek-v4.1-flash",
    note: "非交互模式固定全权（-y），权限档不生效。",
  },
  {
    id: "qoder-intl",
    label: "Qoder 国际",
    selectable: true,
    permissions: null,
    modelHint: "例如 DeepSeek-Flash",
    note: "非交互模式固定全权（bypass_permissions），权限档不生效。",
  },
  {
    id: "qoder-cn",
    label: "Qoder 国内",
    selectable: true,
    permissions: null,
    modelHint: "例如 DeepSeek-Flash",
    note: "登录态与国际版独立；权限固定全权。",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    selectable: true,
    permissions: ["read", "edit", "full"],
    modelHint: "留空跟随 ~/.claude/settings.json；可填 fable / opus / sonnet / haiku 或全名",
    note:
      "订阅登录下 claude -p 按约 1.8–2.9 倍额度计（entrypoint sdk-cli）；API Key 计费不受影响。" +
      "省额度的交互式 TUI 桥本批刻意不做。",
  },
  {
    id: "codex",
    label: "Codex CLI",
    selectable: true,
    permissions: ["read", "edit", "full"],
    modelHint: "留空跟随 ~/.codex/config.toml；例如 gpt-5.1-codex",
  },
  {
    id: "opencode",
    label: "OpenCode",
    selectable: true,
    permissions: ["read", "edit", "full"],
    modelHint: "provider/model，例如 alibaba-cn/deepseek-v4.1-flash",
    note: "权限档：只读 = plan agent；可改 / 全权都用 --auto（OpenCode 不区分这两档）。",
  },
  {
    id: "phone",
    label: "手机",
    selectable: false,
    permissions: null,
    modelHint: "",
    note: "部署形态：由 .env 的 CHANCELLOR_EMPLOYEE=phone 指定，界面不改。",
  },
  {
    id: "mcp",
    label: "MCP 服务",
    selectable: false,
    permissions: null,
    modelHint: "",
    note: "部署形态：由 .env 的 CHANCELLOR_EMPLOYEE=mcp 指定，界面不改。",
  },
];

export interface ExecutorConfig {
  employee: ExecutorKind;
  profiles: Partial<Record<ExecutorKind, EmployeeProfile>>;
}

export interface ExecutorView {
  enabled: boolean;
  employee: ExecutorKind;
  profiles: Partial<Record<ExecutorKind, EmployeeProfile>>;
  kinds: ExecutorKindInfo[];
  /** true = 当前执行器来自部署 env 的 phone / mcp，界面选择不生效。 */
  locked: boolean;
  lockedReason?: string;
  /** 当前生效的配置文件路径（排障用；不含密钥）。 */
  path: string;
}

interface CacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  config: ExecutorConfig;
}

let cache: CacheEntry | null = null;

/** 回滚开关：false/0/off = 不读文件，一律 env。 */
export function executorConfigEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.EXECUTOR_CONFIG ?? "").trim().toLowerCase();
  return !["false", "0", "off"].includes(raw);
}

export function executorConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.EXECUTOR_CONFIG_PATH?.trim() || ".data/executor.json");
}

/** 每次派单懒读，带 mtime+size 缓存；文件坏了 / 没权限 → 回落 env，不抛。 */
export function readExecutorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExecutorConfig {
  const fallback = normalizeConfig(null, env);
  if (!executorConfigEnabled(env)) return fallback;

  const path = executorConfigPath(env);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return fallback;
  }
  if (
    cache &&
    cache.path === path &&
    cache.mtimeMs === stat.mtimeMs &&
    cache.size === stat.size
  ) {
    return cache.config;
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const config = normalizeConfig(raw, env);
    cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, config };
    return config;
  } catch {
    return fallback;
  }
}

/** 写配置（原子替换）；返回写入后的规范化结果。关闭时抛错，由端点转 400。 */
export function writeExecutorConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ExecutorConfig {
  if (!executorConfigEnabled(env)) {
    throw new Error("派活设置已关闭（EXECUTOR_CONFIG=false）");
  }
  const current = readExecutorConfig(env);
  const merged = mergeInput(input, current, env);
  const config = normalizeConfig(merged, env);
  const path = executorConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  try {
    const stat = statSync(path);
    cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, config };
  } catch {
    cache = null;
  }
  return config;
}

/** 派单要用的执行器与参数；新单把它放进 ChancellorRequest。 */
export function executorForDelegation(
  env: NodeJS.ProcessEnv = process.env,
): { employee: ExecutorKind; profile: EmployeeProfile } {
  const config = readExecutorConfig(env);
  const raw = config.profiles[config.employee] ?? {};
  const profile: EmployeeProfile = {};
  // 显式带上空串：它表示"跟随 CLI 自己的配置"，不能回落成 env 里的默认模型。
  // native 同走这条路（2026-11-16 批1）：model 留空时 native.ts 不做 env 覆盖，
  // worker 子进程回落启动 env（CHANCELLOR_LLM_MODEL / LLM_MODEL）。
  if (raw.model !== undefined) profile.model = raw.model;
  if (raw.permission !== undefined) profile.permission = raw.permission;
  return { employee: config.employee, profile };
}

/** 端点视图：配置 + 控件元数据 + 锁定原因。 */
export function executorView(env: NodeJS.ProcessEnv = process.env): ExecutorView {
  const config = readExecutorConfig(env);
  const locked = config.employee === "phone" || config.employee === "mcp";
  return {
    enabled: executorConfigEnabled(env),
    employee: config.employee,
    profiles: config.profiles,
    kinds: EXECUTOR_KIND_INFO,
    locked,
    ...(locked
      ? {
          lockedReason:
            `默认派给谁由 .env 指定为「${executorLabel(config.employee)}」；` +
            "手机 / MCP 是部署形态，界面不改，请在 .env 里切 CHANCELLOR_EMPLOYEE。",
        }
      : {}),
    path: executorConfigPath(env),
  };
}

const PERMISSION_TEXT: Record<EmployeePermission, string> = {
  read: "只读",
  edit: "可改",
  full: "全权",
};

function executorLabel(kind: ExecutorKind): string {
  return EXECUTOR_KIND_INFO.find((item) => item.id === kind)?.label ?? kind;
}

function executorPermissionText(
  employee: ExecutorKind,
  permission?: EmployeePermission,
): string {
  const info = EXECUTOR_KIND_INFO.find((item) => item.id === employee);
  return info?.permissions ? PERMISSION_TEXT[permission ?? "full"] : "固定全权";
}

/**
 * 给派活的人看的一行（2026-11-16）：系统提示每轮注入。
 * 总管/执事靠它回答“会派给谁、什么模型、什么权限”。
 * 措辞说「默认派给谁」不说「执行器」——用户口径：它就是一个普通工人（2026-11-16）。
 */
export function executorLine(env: NodeJS.ProcessEnv = process.env): string {
  const view = executorView(env);
  const label = executorLabel(view.employee);
  if (view.locked) {
    return (
      `派活默认交给：${label}（部署形态，由 .env 指定）。` +
      "换默认只影响新单；续跑沿用原单的工人。"
    );
  }
  if (view.employee === "native") {
    return (
      "派活默认交给：本机内核（模型跟随 设置 → 模型 的主选；权限由本机内核权限策略管）。" +
      "换默认只影响新单；续跑沿用原单的工人。"
    );
  }
  const profile = view.profiles[view.employee] ?? {};
  const model = profile.model?.trim() ? profile.model.trim() : "跟随该 CLI 自己的默认";
  const permission = executorPermissionText(view.employee, profile.permission);
  return (
    `派活默认交给：${label}（模型 ${model}，权限 ${permission}）。` +
    "换默认只影响新单；续跑沿用原单的工人。"
  );
}

/** 工具返回里的一句：已派发到 X（模型 Y，权限 Z）。 */
export function executorSummary(
  employee: ExecutorKind,
  profile: EmployeeProfile,
): string {
  const label = executorLabel(employee);
  if (employee === "native") return label;
  if (employee === "phone" || employee === "mcp") return label;
  const model = profile.model?.trim();
  const info = EXECUTOR_KIND_INFO.find((kind) => kind.id === employee);
  const permission = executorPermissionText(employee, profile.permission);
  return `${label}（模型 ${model || "跟随 CLI 默认"}，${info?.permissions ? `权限 ${permission}` : permission}）`;
}

/** PUT 的入参校验；返回错误文案由端点原样 400。 */
export function parseExecutorInput(
  input: unknown,
  current: ExecutorConfig,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: "请求体必须是对象" };
  const rawEmployee = input.employee;
  if (rawEmployee !== undefined) {
    if (typeof rawEmployee !== "string" || !isSelectableKind(rawEmployee)) {
      return {
        ok: false,
        message: `employee 必须是 ${SELECTABLE_EXECUTOR_KINDS.join(" / ")} 之一`,
      };
    }
  }
  if (input.profiles !== undefined && !isRecord(input.profiles)) {
    return { ok: false, message: "profiles 必须是对象" };
  }
  if (isRecord(input.profiles)) {
    for (const [kind, raw] of Object.entries(input.profiles)) {
      if (!isSelectableKind(kind)) continue;
      if (!isRecord(raw)) {
        return { ok: false, message: `profiles.${kind} 必须是对象` };
      }
      if (raw.model !== undefined) {
        if (typeof raw.model !== "string") {
          return { ok: false, message: `profiles.${kind}.model 必须是字符串` };
        }
        if (raw.model.trim().length > 200) {
          return { ok: false, message: `profiles.${kind}.model 太长（≤200 字符）` };
        }
      }
      if (raw.permission !== undefined && !isPermission(raw.permission)) {
        return {
          ok: false,
          message: `profiles.${kind}.permission 必须是 read / edit / full`,
        };
      }
    }
  }
  return { ok: true, value: input };
}

function mergeInput(
  input: unknown,
  current: ExecutorConfig,
  _env: NodeJS.ProcessEnv,
): unknown {
  if (!isRecord(input)) return current;
  return {
    employee: input.employee ?? current.employee,
    profiles: {
      ...current.profiles,
      ...(isRecord(input.profiles) ? input.profiles : {}),
    },
  };
}

function normalizeConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv,
): ExecutorConfig {
  const source = isRecord(raw) ? raw : {};
  const envKind = envEmployee(env);
  const employee =
    typeof source.employee === "string" && isExecutorKind(source.employee)
      ? source.employee
      : envKind;
  const rawProfiles = isRecord(source.profiles) ? source.profiles : {};

  const profiles: Partial<Record<ExecutorKind, EmployeeProfile>> = {};
  for (const kind of EXECUTOR_KINDS) {
    if (kind === "phone" || kind === "mcp") continue;
    const fallback = envProfile(kind, env);
    const rawProfile = isRecord(rawProfiles[kind]) ? rawProfiles[kind] : {};
    const model = hasOwn(rawProfile, "model")
      ? normalizeModel(rawProfile.model)
      : fallback.model;
    const permission = hasOwn(rawProfile, "permission")
      ? readPermission(rawProfile.permission, fallback.permission ?? "full")
      : fallback.permission;
    const profile: EmployeeProfile = {};
    if (model !== undefined) profile.model = model;
    if (permission !== undefined) profile.permission = permission;
    profiles[kind] = profile;
  }
  return { employee, profiles };
}

function envEmployee(env: NodeJS.ProcessEnv): ExecutorKind {
  const raw = (env.CHANCELLOR_EMPLOYEE ?? "").trim().toLowerCase();
  return isExecutorKind(raw) ? raw : "native";
}

/** env 是缺省值；文件里显式写的（包括空串）优先。 */
function envProfile(kind: ExecutorKind, env: NodeJS.ProcessEnv): EmployeeProfile {
  if (kind === "claude-code") {
    return {
      model: (env.CHANCELLOR_CLAUDE_MODEL ?? "").trim(),
      permission: readPermission(
        env.CHANCELLOR_CLAUDE_PERMISSION,
        "full",
      ),
    };
  }
  if (kind === "codex") {
    return {
      model: (env.CHANCELLOR_CODEX_MODEL ?? "").trim(),
      permission: readPermission(env.CHANCELLOR_CODEX_PERMISSION, "full"),
    };
  }
  if (kind === "opencode") {
    return {
      model: (env.CHANCELLOR_OPENCODE_MODEL ?? "").trim(),
      permission: readPermission(env.CHANCELLOR_OPENCODE_PERMISSION, "full"),
    };
  }
  if (kind === "codebuddy") {
    return {
      model: (env.CHANCELLOR_CODEBUDDY_MODEL ?? "").trim() || "deepseek-v4.1-flash",
    };
  }
  if (kind === "qoder-intl") {
    return { model: (env.CHANCELLOR_MODEL ?? "").trim() || "DeepSeek-Flash" };
  }
  if (kind === "qoder-cn") {
    return {
      model:
        (env.CHANCELLOR_QODER_CN_MODEL ?? "").trim() ||
        (env.CHANCELLOR_MODEL ?? "").trim() ||
        "DeepSeek-Flash",
    };
  }
  return {};
}

function normalizeModel(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw.trim().slice(0, 200) : undefined;
}

function readPermission(
  raw: unknown,
  fallback: EmployeePermission,
): EmployeePermission {
  return isPermission(raw) ? raw : fallback;
}

function isPermission(raw: unknown): raw is EmployeePermission {
  return raw === "read" || raw === "edit" || raw === "full";
}

function isExecutorKind(raw: string): raw is ExecutorKind {
  return (EXECUTOR_KINDS as readonly string[]).includes(raw);
}

function isSelectableKind(raw: string): raw is SelectableExecutorKind {
  return (SELECTABLE_EXECUTOR_KINDS as readonly string[]).includes(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
