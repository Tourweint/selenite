/**
 * native worker 工具面注入口（2026-11-17 通用 worker 配置统一 批4）。
 *
 * native worker 的工具面 = CodingTools 四件（read / write / edit / bash），
 * 白名单过滤在 worker-main。宿主（harness 服务端）让用户在「普通助手」页勾选，
 * 装配时把**取消名单的补集**推过来（依赖方向：server 推、chancellor 收，
 * 同 worker-persona-source 先例）；spawn 时由 native.ts 换成 `--tools` argv。
 *
 * 硬边界：交集只会在 `WORKER_TOOL_NAMES` 内——宿主配置坏了 / 传了别的东西，
 * worker 也不会多出工具；空集按空集跑（worker 只凭 TASK.md 回话，REPORT 缺失
 * 由验收如实报失败，不静默回退全开）。未注入 / null = 全开（旧行为）。
 * 外部 CLI 不走这条路：它们用自己的内置工具，宿主不管（2026-11-17 用户拍板）。
 */

/** native worker 能有的全部工具（canonical，worker-main 以此过滤注册）。 */
export const WORKER_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

export type WorkerToolName = (typeof WORKER_TOOL_NAMES)[number];

export type WorkerToolsSource = () => string[] | null;

let source: WorkerToolsSource | null = null;

export function setWorkerToolsSource(fn: WorkerToolsSource | null): void {
  source = fn;
}

/**
 * 每张单现取一次（宿主每单现读配置，改完下一单生效）；抛错按未注入处理（全开）。
 * 返回 null = 宿主没装配 / 回滚开关关着 / 读取失败 → 全开。
 */
export function workerAllowedTools(): readonly string[] | null {
  if (source) {
    try {
      return source();
    } catch {
      return null;
    }
  }
  // 分管宰相子进程里没有宿主注入的 source：宿主 spawn manager 时把同一份名单
  // 写成 `CHANCELLOR_WORKER_TOOLS`（逗号分隔），子单据此过滤。空串 = 真的零工具，
  // 没设这个变量 = 旧行为（全开）。
  const raw = process.env.CHANCELLOR_WORKER_TOOLS;
  if (raw === undefined) return null;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 把宿主给的名单收敛成合法白名单：只认 canonical 四件、去重、保序。
 * null / undefined / 空 / 乱值全部筛掉——筛完为空就是真的零工具，不回退全开。
 * 纯函数，单测直接喂。
 */
export function effectiveWorkerTools(
  raw: readonly string[] | null | undefined,
): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(
    raw.filter((item): item is WorkerToolName =>
      (WORKER_TOOL_NAMES as readonly string[]).includes(item),
    ),
  );
  return WORKER_TOOL_NAMES.filter((name) => wanted.has(name));
}

/** `--tools` argv 的值；null = 不传该参数（全开，旧行为逐字一致）。 */
export function workerToolsArgValue(): string | null {
  const allowed = workerAllowedTools();
  if (allowed === null) return null;
  const effective = effectiveWorkerTools(allowed);
  return effective.join(",");
}
