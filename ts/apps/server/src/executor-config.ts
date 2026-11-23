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
 * 模型分工（2026-11-19）：规划 / 对话仍用 `readLlmConfig()` 的默认模型；
 * 本机内核（native）派活工人单独一条"干活模型"，留空 = 跟随默认
 * （`EXECUTOR_NATIVE_FOLLOW_DEFAULT=false` 回滚到启动 env），非空 = 单独模型。
 * 显式模型按 `providerId`（或模型 id）解析到已连接供应商，带 `modelRoute` 给 worker；
 * 这样跨供应商不再只吃启动 env 的百炼。
 *
 * 刻意不做：
 * - 不在这里探测 CLI 登录状态 / 版本（会拖慢设置页；失败由任务中心的汇报如实显示）；
 * - 外部 CLI 的模型清单不进页自动拉：probe 端点（executor-probe.ts）只在用户点箭头 /
 *   点检测时跑；模型是自由文本，留空 = 跟随该 CLI 自己的配置。
 *   native 的清单来自已连接供应商目录，同样不 spawn CLI。
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
import { providerCatalog, readLlmConfig } from "./provider.ts";

export const EXECUTOR_KINDS = [
  "native",
  "pool",
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
  "pool",
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
    id: "pool",
    label: "底层 worker 运行时（独立进程）",
    selectable: true,
    permissions: null,
    modelHint: "留空跟随默认模型；例如 deepseek-v4.1-flash",
    note:
      "新派出去的底层工人默认都在这里跑：一进程同时只跑一票，进程跨票复用，" +
      "并发上限由池大小决定（WORKER_POOL_SIZE）。每个池进程自带 SQLite 与工具白名单，" +
      "崩了只影响在跑的那一票。前端「新建任务」和总管/执事派活都走它。",
  },
  {
    id: "native",
    label: "旧：每票一进程（回滚用）",
    selectable: true,
    permissions: null,
    modelHint: "留空跟随默认模型；例如 deepseek-v4.1-flash",
    note:
      "改动前的形态：每张单起一个 worker 子进程。只在池不可用或需要强制隔离时选；" +
      "选它等于把新单从第二套运行时拉回旧进程。整体回滚也可以直接 CHANCELLOR_EMPLOYEE=native。",
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

/**
 * 执行器 profile 的界面/文件形状：chancellor 的 EmployeeProfile + 仅 native 用的
 * 供应商 id（2026-11-19 模型分工）。`providerId` 只用来把干活模型解析到 baseUrl/keyEnv，
 * 不会作为密钥或进程参数下发。
 */
export interface ExecutorProfile extends EmployeeProfile {
  providerId?: string;
}

export interface ExecutorConfig {
  employee: ExecutorKind;
  profiles: Partial<Record<ExecutorKind, ExecutorProfile>>;
}

export interface ExecutorView {
  enabled: boolean;
  employee: ExecutorKind;
  profiles: Partial<Record<ExecutorKind, ExecutorProfile>>;
  kinds: ExecutorKindInfo[];
  /** true = 当前执行器来自部署 env 的 phone / mcp，界面选择不生效。 */
  locked: boolean;
  lockedReason?: string;
  /** 当前生效的配置文件路径（排障用；不含密钥）。 */
  path: string;
}

/** 派单时解析 native 干活模型的外部依赖（单测注入，生产走 provider.ts）。 */
export interface ExecutorDispatchDeps {
  /** 当前运行时主选；缺省读 `.data/runtime.json`。 */
  currentModel?: () => { provider: string; modelId: string } | null;
  /** 已连接供应商里找模型路由；缺省读 providers.json + env key。 */
  modelRoute?: (
    providerId: string | null,
    modelId: string,
  ) => { baseUrl: string; keyEnv: string } | null;
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

/**
 * 回滚开关（2026-11-19 模型分工）：false/0/off = native 模型框留空时回到旧行为
 * （不覆盖 worker 的启动 env）；默认开 = 留空跟随运行时默认模型。
 */
export function executorNativeFollowsDefault(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.EXECUTOR_NATIVE_FOLLOW_DEFAULT ?? "").trim().toLowerCase();
  return !["false", "0", "off"].includes(raw);
}

/** 当前运行时主选（设置 → 模型的默认模型）；读不到 = null（faux / 未配置）。 */
function currentRuntimeModel(): { provider: string; modelId: string } | null {
  try {
    const model = readLlmConfig()?.model ?? null;
    // faux 是假模型，native worker 自己也会走 faux；不要把它写进建单快照当"干活模型"。
    if (!model || model.provider === "faux") return null;
    return model;
  } catch {
    return null;
  }
}

/**
 * 已连接供应商里找模型路由（2026-11-19）：返回 baseUrl + keyEnv。
 * 选择顺序：显式 providerId > 当前默认供应商 > 第一家含该模型的供应商。
 * key 只认宿主 env 有没有值；没有就不要把子进程指向一个没钥匙的供应商。
 */
function providerRouteFor(
  providerId: string | null,
  modelId: string,
): { baseUrl: string; keyEnv: string } | null {
  try {
    const catalog = providerCatalog();
    const candidates = catalog.providers.filter((provider) =>
      provider.models.includes(modelId),
    );
    const preferred = providerId?.trim() || readLlmConfig()?.model.provider || "";
    const chosen =
      (preferred
        ? candidates.find((provider) => provider.id === preferred)
        : undefined) ?? candidates[0];
    if (!chosen) return null;
    if (!process.env[chosen.keyEnv]?.trim()) {
      console.warn(
        `[executor] 干活模型 ${modelId} 的供应商 ${chosen.id} 没有 key（${chosen.keyEnv}），回落启动 env`,
      );
      return null;
    }
    return { baseUrl: chosen.baseUrl, keyEnv: chosen.keyEnv };
  } catch {
    return null;
  }
}

/**
 * native 的干活模型解析（2026-11-19 模型分工）：
 * 显式 model > 运行时默认（开关开）> 不覆盖（开关关 / 无可选模型）。
 * 返回值 null = 不覆盖 worker 的启动 env。
 */
function resolveNativeWorkProfile(
  raw: ExecutorProfile,
  env: NodeJS.ProcessEnv,
  deps: ExecutorDispatchDeps,
): { model: string; route?: { baseUrl: string; keyEnv: string } } | null {
  const routeOf = deps.modelRoute ?? providerRouteFor;
  const explicit = (raw.model ?? "").trim();
  if (explicit) {
    const route = routeOf(raw.providerId?.trim() || null, explicit);
    return { model: explicit, ...(route ? { route } : {}) };
  }
  if (!executorNativeFollowsDefault(env)) return null;
  const current = (deps.currentModel ?? currentRuntimeModel)();
  if (!current) return null;
  const route = routeOf(current.provider, current.modelId);
  return { model: current.modelId, ...(route ? { route } : {}) };
}

/**
 * 派单要用的执行器与参数；新单把它放进 ChancellorRequest。
 *
 * native（2026-11-19 模型分工）：
 * - 显式模型 = 干活模型（可跨供应商，带 modelRoute）；
 * - 留空 = 跟随设置 → 模型的默认模型（`EXECUTOR_NATIVE_FOLLOW_DEFAULT=false` 回滚到旧 env 行为）；
 * - 外部 CLI 语义不变：显式 model / permission 原样带上，留空跟随各自 CLI 配置。
 */
export function executorForDelegation(
  env: NodeJS.ProcessEnv = process.env,
  deps: ExecutorDispatchDeps = {},
  /**
   * 强制执行器（2026-11-22 前端直派任务固定 pool）：不传 = 设置里的默认。
   * profile 仍从同一份设置里按这个 kind 取，避免“换执行器但丢了工人模型”。
   */
  kindOverride?: ExecutorKind,
): { employee: ExecutorKind; profile: EmployeeProfile } {
  const config = readExecutorConfig(env);
  const kind = kindOverride ?? config.employee;
  const raw = config.profiles[kind] ?? {};
  const profile: EmployeeProfile = {};
  // 池与 native 同档（2026-11-22）：都用本机内核、都吃「干活模型」与跨供应商 route。
  // 差别只在容器（池进程 vs 每票子进程），profile 字段一模一样。
  if (kind === "native" || kind === "pool") {
    const work = resolveNativeWorkProfile(raw, env, deps);
    if (work) {
      profile.model = work.model;
      if (work.route) profile.modelRoute = work.route;
    } else if (raw.model !== undefined) {
      // 回滚模式：保留显式空串，语义回到“worker 不覆盖启动 env”。
      profile.model = raw.model;
    }
  } else {
    // 显式带上空串：它表示"跟随 CLI 自己的配置"，不能回落成 env 里的默认模型。
    if (raw.model !== undefined) profile.model = raw.model;
    if (raw.permission !== undefined) profile.permission = raw.permission;
  }
  return { employee: kind, profile };
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
export function executorLine(
  env: NodeJS.ProcessEnv = process.env,
  deps: ExecutorDispatchDeps = {},
): string {
  const view = executorView(env);
  const label = executorLabel(view.employee);
  if (view.locked) {
    return (
      `派活默认交给：${label}（部署形态，由 .env 指定）。` +
      "换默认只影响新单；续跑沿用原单的工人。"
    );
  }
  if (view.employee === "native") {
    const picked = (view.profiles.native?.model ?? "").trim();
    let modelText: string;
    if (picked) {
      modelText = `干活模型 ${picked}`;
    } else if (executorNativeFollowsDefault(env)) {
      const current = (deps.currentModel ?? currentRuntimeModel)();
      modelText = current
        ? `干活模型跟随默认（${current.modelId}）`
        : "干活模型跟随默认";
    } else {
      modelText = "干活模型跟随启动 env";
    }
    return (
      `派活默认交给：本机内核（${modelText}；权限由本机内核权限策略管）。` +
      "换默认只影响新单；续跑沿用原单的工人。"
    );
  }
  if (view.employee === "pool") {
    const picked = (view.profiles.pool?.model ?? "").trim();
    let modelText: string;
    if (picked) {
      modelText = `干活模型 ${picked}`;
    } else if (executorNativeFollowsDefault(env)) {
      const current = (deps.currentModel ?? currentRuntimeModel)();
      modelText = current ? `干活模型跟随默认（${current.modelId}）` : "干活模型跟随默认";
    } else {
      modelText = "干活模型跟随启动 env";
    }
    return (
      `派活默认交给：执行器池（${modelText}；权限由池内工具白名单管：read/write/edit/bash/escalate）。` +
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
  if (employee === "native") {
    // 2026-11-19：干活模型随派单快照解析好了就如实说；没带（回滚模式）保持原文案。
    // 2026-11-22：native 降级为回滚档，摘要里也如实说“旧”。
    const model = profile.model?.trim();
    return model ? `旧：每票一进程（模型 ${model}）` : label;
  }
  if (employee === "pool") {
    const model = profile.model?.trim();
    return model ? `底层 worker 运行时（模型 ${model}）` : label;
  }
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
      // 2026-11-19 模型分工：只有 native 用 providerId（供应商 id，不是密钥）。
      if (raw.providerId !== undefined) {
        if (typeof raw.providerId !== "string") {
          return { ok: false, message: `profiles.${kind}.providerId 必须是字符串` };
        }
        if (raw.providerId.trim().length > 100) {
          return { ok: false, message: `profiles.${kind}.providerId 太长（≤100 字符）` };
        }
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

  const profiles: Partial<Record<ExecutorKind, ExecutorProfile>> = {};
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
    const profile: ExecutorProfile = {};
    if (model !== undefined) profile.model = model;
    if (permission !== undefined) profile.permission = permission;
    // 2026-11-19 模型分工：native 的供应商 id 只在这里保留；其它档忽略。
    if (kind === "native" && hasOwn(rawProfile, "providerId")) {
      const providerId = normalizeProviderId(rawProfile.providerId);
      if (providerId) profile.providerId = providerId;
    }
    profiles[kind] = profile;
  }
  return { employee, profiles };
}

function envEmployee(env: NodeJS.ProcessEnv): ExecutorKind {
  const raw = (env.CHANCELLOR_EMPLOYEE ?? "").trim().toLowerCase();
  if (isExecutorKind(raw)) return raw;
  // 2026-11-22 切默认：宿主的派活默认走**执行器池**（独立进程串行复用，方案 P5）。
  // 单独跑 chancellor CLI（不经宿主）时没有 PoolClient，chancellor 自己仍默认 native，
  // 并且 `createEmployee("pool")` 有"未接线回落 native + 告警"的保险。
  // 回滚：CHANCELLOR_EMPLOYEE=native（一行，不动代码）。
  return "pool";
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

/** native 的供应商 id（2026-11-19）：只保留形状，不校验是否存在（供应商被删也不能炸配置）。 */
function normalizeProviderId(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw.trim().slice(0, 100) || undefined : undefined;
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
