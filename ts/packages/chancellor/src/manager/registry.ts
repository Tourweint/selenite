import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../store.ts";

/**
 * 分管领域的长期注册表。
 *
 * 放在 runs 的同级（默认就是仓库根下的 managers/），不跟某一张 ticket 绑定；
 * 每个领域一个目录：meta.json + .agent.sqlite + workspace + runs。
 * 进程按需起，目录和库一直在——这就是「状态常驻」。
 */
export interface ManagerMeta {
  domain: string;
  created_at: string;
  updated_at: string;
  /** 分管宰相自己的工作目录（CodingTools 的 cwd）。 */
  work_dir: string;
  /** 分管宰相用 delegate 派出去的 worker ticket 落在这里。 */
  runs_dir: string;
  db_path: string;
  /** 续用的 pi-durable 会话；第一次跑完才有。 */
  conversation_id: number | null;
  /** 上下文换段次数（§5.7）；旧段仍在 sqlite 里，handoff.md 累积每次交接。 */
  rotations: number;
  /**
   * 宿主侧手下伙伴的 id（批次D D2）。宿主建手下时透记，chancellor **只存不解读**：
   * 不用它查库、不改权限、不参与路由。老领域没有这个字段，按 null 读。
   */
  partner_id: string | null;
}

export interface ManagerInfo extends ManagerMeta {
  root: string;
  meta_path: string;
}

export interface ManagerListEntry {
  domain: string;
  meta: ManagerMeta | null;
  root: string;
  db_exists: boolean;
  db_bytes: number;
  error: string | null;
}

export const DOMAIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 只认总管明确给的合法领域名；不合法直接报错，不猜、不归一化。
 * 传了 workRoot 时把当前已有领域一并带出，模型可以直接照着选，不用猜。
 */
export function validateDomain(raw: string, workRoot?: string): string {
  const domain = raw.trim();
  if (!DOMAIN_PATTERN.test(domain)) {
    const suffix = workRoot ? `。可用领域：${availableDomainText(workRoot)}` : "";
    throw new Error(
      `领域名「${raw}」不合法：必须是小写 ASCII（小写字母、数字、连字符，不能以连字符开头或结尾）${suffix}`,
    );
  }
  return domain;
}

function availableDomainText(workRoot: string): string {
  const domains = listManagers(workRoot)
    .map((entry) => entry.domain)
    .filter((domain) => DOMAIN_PATTERN.test(domain));
  return domains.length > 0 ? domains.join(" / ") : "（暂无，可用小写英文新建）";
}

/** 与 Store 的 data/ 同一规则：放在 workRoot 的同级。 */
export function managersRoot(workRoot: string): string {
  return path.join(path.dirname(path.resolve(workRoot)), "managers");
}

export function managerDir(workRoot: string, domain: string): string {
  return path.join(managersRoot(workRoot), validateDomain(domain));
}

/**
 * 找领域；没有就建。只在 runChancellor 明确收到 domain 时调用。
 * 已存在的 meta 字段（尤其是 conversation_id、partner_id）原样保留，只刷新 updated_at。
 * opts.partnerId 由宿主建手下伙伴时传入；chancellor 自己的派单不带 opts，
 * 因此必须保留既有值，不能把宿主写进来的 partner_id 冲掉。
 */
export function ensureManager(
  workRoot: string,
  domainRaw: string,
  opts?: { partnerId?: string },
): ManagerInfo {
  const domain = validateDomain(domainRaw, workRoot);
  const root = managerDir(workRoot, domain);
  const metaPath = path.join(root, "meta.json");
  const now = new Date().toISOString();
  const existing = readJson<Partial<ManagerMeta>>(metaPath);

  const meta: ManagerMeta = {
    domain,
    created_at: validString(existing?.created_at) ?? now,
    updated_at: now,
    work_dir: resolveInside(root, validString(existing?.work_dir) ?? "workspace"),
    runs_dir: resolveInside(root, validString(existing?.runs_dir) ?? "runs"),
    db_path: resolveInside(root, validString(existing?.db_path) ?? ".agent.sqlite"),
    conversation_id: validNumber(existing?.conversation_id),
    rotations: validNumber(existing?.rotations) ?? 0,
    partner_id: validString(opts?.partnerId) ?? validString(existing?.partner_id) ?? null,
  };

  ensureDir(meta.work_dir);
  ensureDir(meta.runs_dir);
  writeJson(metaPath, meta);
  return { ...meta, root, meta_path: metaPath };
}

/** worker-main 的 manager 角色按目录读 meta；不负责建。 */
export function readManagerMeta(root: string): ManagerMeta | null {
  const meta = readJson<Partial<ManagerMeta>>(path.join(root, "meta.json"));
  if (!meta || !validString(meta.domain)) return null;
  return {
    domain: meta.domain as string,
    created_at: validString(meta.created_at) ?? "",
    updated_at: validString(meta.updated_at) ?? "",
    work_dir: resolveInside(root, validString(meta.work_dir) ?? "workspace"),
    runs_dir: resolveInside(root, validString(meta.runs_dir) ?? "runs"),
    db_path: resolveInside(root, validString(meta.db_path) ?? ".agent.sqlite"),
    conversation_id: validNumber(meta.conversation_id),
    rotations: validNumber(meta.rotations) ?? 0,
    partner_id: validString(meta.partner_id) ?? null,
  };
}

export function saveManagerMeta(root: string, meta: ManagerMeta): void {
  writeJson(path.join(root, "meta.json"), meta);
}

/**
 * 归档领域（批次D D2）：把 `managers/<domain>/` 改名成
 * `managers/.archived-<domain>-<时间戳>/`，**不物理删**——runs 里的工单历史还在。
 * `.` 开头的目录会被 listManagers 跳过，所以归档后这个领域不再对外可见。
 * 幂等：目录已经不在（没建过 / 已归档）时直接返回 null，不报错。
 * 返回归档后的绝对路径；调用方（宿主）只用它做断言，chancellor 自己不读回。
 */
export function archiveManager(workRoot: string, domainRaw: string): string | null {
  const domain = validateDomain(domainRaw, workRoot);
  const root = managersRoot(workRoot);
  const dir = path.join(root, domain);
  if (!fs.existsSync(dir)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target = path.join(root, `.archived-${domain}-${stamp}`);
  for (let i = 2; fs.existsSync(target); i += 1) {
    target = path.join(root, `.archived-${domain}-${stamp}-${i}`);
  }
  fs.renameSync(dir, target);
  return target;
}

/** 列出所有领域；坏掉的 meta 也列出来，标清楚，不吞掉。归档目录（`.` 开头）跳过。 */
export function listManagers(workRoot: string): ManagerListEntry[] {
  const root = managersRoot(workRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ManagerListEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 归档后的领域以 `.` 开头（.archived-…）：不物理删，但不再作为可用领域列出。
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const metaPath = path.join(dir, "meta.json");
    const meta = readManagerMeta(dir);
    let dbBytes = 0;
    let dbExists = false;
    const dbPath = meta
      ? path.isAbsolute(meta.db_path)
        ? meta.db_path
        : path.join(dir, meta.db_path)
      : path.join(dir, ".agent.sqlite");
    try {
      dbBytes = fs.statSync(dbPath).size;
      dbExists = true;
    } catch {
      dbExists = false;
    }
    out.push({
      domain: meta?.domain ?? entry.name,
      meta,
      root: dir,
      db_exists: dbExists,
      db_bytes: dbBytes,
      error: meta ? null : fs.existsSync(metaPath) ? "meta.json 无法解析" : "缺 meta.json",
    });
  }
  out.sort((a, b) => (b.meta?.updated_at ?? "").localeCompare(a.meta?.updated_at ?? ""));
  return out;
}

function resolveInside(root: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function validString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function validNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
