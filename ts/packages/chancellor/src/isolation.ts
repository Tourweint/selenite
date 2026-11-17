import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { FileFingerprint, PathSnapshot, ProjectRef } from "./types.ts";
import { ensureDir, readJson, SNAPSHOT_FILE, writeJson } from "./store.ts";
import { normalizeProjectPath } from "./paths.ts";
import { SNAPSHOT_COARSE_FILE_LIMIT } from "./config.ts";

/**
 * git worktree 隔离与按租约合并（2026-11-03 方案 §5.4）。
 *
 * 关键取舍：
 * - 副本基准不是任务单的 baseRevision，而是**当前工作区快照**（`git stash create`
 *   产生的临时提交）。否则有依赖的后一个任务看不到前一个已合并的未提交改动，
 *   再合并时必然撞冲突。快照只读，不改变用户工作区。
 * - 合并按文件拷贝，不往项目 index 里塞 patch。这样对未跟踪文件、gitignore
 *   边界之外的操作都可控，也能逐路径做冲突判定。
 * - 任务副本里的未跟踪文件在开工前复制进去，保证任务看到的就是项目现状。
 */

export interface WorktreeChange {
  /** 相对项目根，posix 分隔。 */
  path: string;
  status: "A" | "M" | "D";
}

export interface TaskWorktree {
  path: string;
  baseRef: string;
  untrackedHashes: Map<string, string>;
}

export function isGitProject(project: ProjectRef | undefined): project is ProjectRef & { head: string } {
  return Boolean(project && project.vcs === "git" && project.head);
}

/** 当前工作区快照的 commit-ish；干净工作区退回到 HEAD。 */
function snapshotRef(projectRoot: string, head: string): { ref: string; untracked: string[] } {
  const stash = git(projectRoot, ["stash", "create"]);
  const ref = stash.trim() || head;
  const untracked = listUntracked(projectRoot);
  return { ref, untracked };
}

export function prepareTaskWorktree(opts: {
  project: ProjectRef & { head: string };
  worktreePath: string;
  /** 崩溃恢复：副本已经存在就接着用里面的半成品，不再重新检出。 */
  reuseExisting?: boolean;
}): TaskWorktree {
  const { project, worktreePath, reuseExisting } = opts;
  if (reuseExisting) {
    const reused = readWorktreeMeta(worktreePath);
    if (reused && fs.existsSync(path.join(worktreePath, ".git"))) {
      return {
        path: worktreePath,
        baseRef: reused.baseRef,
        untrackedHashes: new Map(reused.untracked),
      };
    }
  }
  removeWorktree(project.rootPath, worktreePath);
  const { ref, untracked } = snapshotRef(project.rootPath, project.head);
  ensureDir(path.dirname(worktreePath));
  git(project.rootPath, ["worktree", "add", "--detach", worktreePath, ref]);
  const untrackedHashes = new Map<string, string>();
  for (const relPath of untracked) {
    const source = path.join(project.rootPath, relPath);
    const target = path.join(worktreePath, relPath);
    try {
      const stat = fs.lstatSync(source);
      if (!stat.isFile()) continue;
      ensureDir(path.dirname(target));
      fs.copyFileSync(source, target);
      untrackedHashes.set(relPath, sha1(fs.readFileSync(source)));
    } catch {
      // 源文件在这期间被删了：跳过，不影响任务。
    }
  }
  writeWorktreeMeta(worktreePath, { baseRef: ref, untracked: [...untrackedHashes] });
  return { path: worktreePath, baseRef: ref, untrackedHashes };
}

/**
 * 收集任务副本相对基线的变更，并剔除「原样复制进来、任务没动过」的未跟踪文件。
 * 路径统一成项目相对 posix 路径。
 */
export function collectTaskChanges(worktree: TaskWorktree): WorktreeChange[] {
  git(worktree.path, ["add", "-A"]);
  const output = git(worktree.path, ["diff", "--cached", "--name-status", "-z", worktree.baseRef]);
  const changes: WorktreeChange[] = [];
  const parts = output.split("\0");
  let index = 0;
  while (index < parts.length) {
    const code = parts[index++];
    if (!code) continue;
    const first = parts[index++];
    if (!first) continue;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const second = parts[index++];
      if (!second) continue;
      const oldPath = normalizeProjectPath(first);
      const newPath = normalizeProjectPath(second);
      if (oldPath) changes.push({ path: oldPath, status: "D" });
      if (newPath) changes.push({ path: newPath, status: "A" });
      continue;
    }
    const relPath = normalizeProjectPath(first);
    if (!relPath) continue;
    if (kind === "A") changes.push({ path: relPath, status: "A" });
    else if (kind === "D") changes.push({ path: relPath, status: "D" });
    else changes.push({ path: relPath, status: "M" });
  }
  return dedupeChanges(changes.filter((change) => {
    const initial = worktree.untrackedHashes.get(change.path);
    if (!initial) return true;
    try {
      return sha1(fs.readFileSync(path.join(worktree.path, change.path))) !== initial;
    } catch {
      return true;
    }
  }));
}

/**
 * 把任务副本的变更合并进项目。调用方必须已经持有这些路径的独占租约。
 * 冲突时不写任何文件，返回冲突清单。
 */
export function mergeTaskChanges(opts: {
  projectRoot: string;
  worktree: TaskWorktree;
  changes: WorktreeChange[];
}): { merged: string[]; conflicts: string[] } {
  const { projectRoot, worktree, changes } = opts;
  const conflicts: string[] = [];
  const merged: string[] = [];

  // 先判冲突，再统一落盘，避免改一半。
  for (const change of changes) {
    if (hasConflict(projectRoot, worktree, change)) conflicts.push(change.path);
  }
  if (conflicts.length > 0) return { merged: [], conflicts };

  for (const change of changes) {
    const target = path.join(projectRoot, change.path);
    if (change.status === "D") {
      fs.rmSync(target, { force: true });
      merged.push(change.path);
      continue;
    }
    const source = path.join(worktree.path, change.path);
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
    merged.push(change.path);
  }
  return { merged, conflicts };
}

function hasConflict(projectRoot: string, worktree: TaskWorktree, change: WorktreeChange): boolean {
  const projectFile = path.join(projectRoot, change.path);
  const projectExists = fs.existsSync(projectFile);
  const base = baseContent(worktree, change.path);
  if (change.status === "D") {
    if (!projectExists) return false;
    // 基线里没有这个文件（未跟踪）→ 只要内容还是开工时那份，删掉不冲突。
    const initial = worktree.untrackedHashes.get(change.path);
    if (!base && initial) return sha1(fs.readFileSync(projectFile)) !== initial;
    return base ? sha1(fs.readFileSync(projectFile)) !== base : false;
  }
  const next = sha1(fs.readFileSync(path.join(worktree.path, change.path)));
  if (!projectExists) {
    // 基线有、项目里被删了：任务又写同一路径，属于冲突。
    return Boolean(base);
  }
  const current = sha1(fs.readFileSync(projectFile));
  if (current === next) return false;
  const initial = worktree.untrackedHashes.get(change.path);
  if (!base && initial) return current !== initial;
  return base ? current !== base : false;
}

function baseContent(worktree: TaskWorktree, relPath: string): string | null {
  const result = spawnSync("git", ["-C", worktree.path, "show", `${worktree.baseRef}:${relPath}`], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return sha1(result.stdout as Buffer);
}

export function removeWorktree(projectRoot: string, worktreePath: string): void {
  try {
    spawnSync("git", ["-C", projectRoot, "worktree", "remove", "--force", worktreePath], {
      encoding: "utf8",
    });
  } catch {
    // 副本可能不是登记过的 worktree（比如手删了一半），下面直接清目录。
  }
  if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true });
  fs.rmSync(worktreeMetaPath(worktreePath), { force: true });
  try {
    spawnSync("git", ["-C", projectRoot, "worktree", "prune"], { encoding: "utf8" });
  } catch {
    // prune 失败不影响本次任务。
  }
}

interface WorktreeMeta {
  baseRef: string;
  untracked: Array<[string, string]>;
}

/** 副本旁边的小元数据：恢复时要靠它重建 baseRef 与「复制进来但没改过」的文件清单。 */
function worktreeMetaPath(worktreePath: string): string {
  return `${worktreePath}.json`;
}

function writeWorktreeMeta(worktreePath: string, meta: WorktreeMeta): void {
  writeJson(worktreeMetaPath(worktreePath), meta);
}

function readWorktreeMeta(worktreePath: string): WorktreeMeta | null {
  const meta = readJson<Partial<WorktreeMeta>>(worktreeMetaPath(worktreePath));
  if (!meta || typeof meta.baseRef !== "string" || meta.baseRef === "") return null;
  return {
    baseRef: meta.baseRef,
    untracked: Array.isArray(meta.untracked)
      ? meta.untracked.filter(
          (item): item is [string, string] =>
            Array.isArray(item) &&
            typeof item[0] === "string" &&
            typeof item[1] === "string",
        )
      : [],
  };
}

function listUntracked(projectRoot: string): string[] {
  const output = git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return output
    .split("\0")
    .map((item) => normalizeProjectPath(item))
    .filter((item): item is string => Boolean(item));
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim() || (result.stdout ?? "").trim();
    throw new Error(`git ${args.join(" ")} 失败：${stderr.split("\n").slice(-3).join(" ")}`);
  }
  return result.stdout ?? "";
}

function sha1(buffer: Buffer): string {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

export interface SnapshotOptions {
  /**
   * 上一次快照。给了就只对「mtime/size 疑似变化」的文件算 sha1，
   * 其余文件直接沿用旧指纹——这是同一目录改 1 个文件时的主要成本差。
   */
  previous?: PathSnapshot;
  /** 单个 `dir/**` 目录超过这么多文件就退化成 mtime+size 粗判。 */
  coarseLimit?: number;
}

export interface SnapshotResult {
  entries: PathSnapshot;
  /** 有一个声明目录因为过大而只做了元数据粗判。 */
  coarse: boolean;
}

/** 落盘的执行前快照；ticketId/seq 用来防止把别人的快照读回来。 */
export interface PersistedSnapshot {
  ticketId: string;
  seq: number;
  slug?: string;
  createdAt: string;
  coarse: boolean;
  entries: PathSnapshot;
}

export function snapshotFileFor(runDir: string): string {
  return path.join(runDir, SNAPSHOT_FILE);
}

/** 用写声明路径拍一次快照。不存在 = 快照里没有这个 key（删除即「前后少了一项」）。 */
export function snapshotDeclaredPaths(
  root: string,
  declared: string[],
  options: SnapshotOptions = {},
): SnapshotResult {
  const entries: PathSnapshot = {};
  const coarseLimit = options.coarseLimit ?? SNAPSHOT_COARSE_FILE_LIMIT;
  let coarse = false;

  for (const declaredPath of declared) {
    if (declaredPath.endsWith("/**")) {
      const prefix = declaredPath.slice(0, -3).replace(/\/+$/, "");
      if (!prefix) continue;
      const files = listDeclaredFiles(root, prefix);
      // 文件数过多时不读内容，只留 size+mtime；验收仍能看出新增/删除/改动，
      // 但「同尺寸同时间戳的内容替换」会漏掉——这是刻意换成本。
      const useCoarse = files.length > coarseLimit;
      if (useCoarse) coarse = true;
      for (const relPath of files) {
        const absPath = path.join(root, relPath);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(absPath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const meta = metadataOf(stat);
        const previous = options.previous?.[relPath];
        if (previous && sameMetadata(previous, meta) && (previous.hash || useCoarse)) {
          // 文件没动过：沿用旧 hash，绝不重新读内容。
          // 粗判快照本来就没有 hash，元数据相同即可复用。
          entries[relPath] = previous;
          continue;
        }
        entries[relPath] = useCoarse ? meta : withHash(meta, absPath);
      }
      continue;
    }

    const relPath = normalizeProjectPath(declaredPath);
    if (!relPath) continue;
    const absPath = path.join(root, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const meta = metadataOf(stat);
    const previous = options.previous?.[relPath];
    if (previous && sameMetadata(previous, meta) && previous.hash) {
      entries[relPath] = previous;
      continue;
    }
    // 具体路径通常只有几个，直接算 sha1，不用粗判。
    entries[relPath] = withHash(meta, absPath);
  }

  return { entries, coarse };
}

/**
 * 前后两次快照的差异：新增 / 修改 / 删除都算变更（2026-11-04）。
 * 只有声明路径一个都没变才返回空数组。
 */
export function changedDeclaredPaths(before: PathSnapshot, after: PathSnapshot): string[] {
  const changed = new Set<string>();
  for (const [relPath, next] of Object.entries(after)) {
    const prev = before[relPath];
    if (!prev || fingerprintChanged(prev, next)) changed.add(relPath);
  }
  // 执行前存在、执行后没了：删除也是任务真的做了事。
  for (const relPath of Object.keys(before)) {
    if (!(relPath in after)) changed.add(relPath);
  }
  return [...changed].sort();
}

export function writePathSnapshot(file: string, snapshot: PersistedSnapshot): void {
  writeJson(file, snapshot);
}

/** 读回执行前快照；ticketId/seq 对不上、形状不合法都当没有。 */
export function readPathSnapshot(
  file: string,
  expect: { ticketId: string; seq: number },
): SnapshotResult | null {
  const data = readJson<Partial<PersistedSnapshot>>(file);
  if (!data || data.ticketId !== expect.ticketId || data.seq !== expect.seq) return null;
  if (data.entries === null || typeof data.entries !== "object") return null;

  const entries: PathSnapshot = {};
  for (const [rawPath, rawFingerprint] of Object.entries(data.entries)) {
    const relPath = normalizeProjectPath(rawPath);
    if (!relPath) continue;
    if (!rawFingerprint || typeof rawFingerprint !== "object") continue;
    const fingerprint = rawFingerprint as Partial<FileFingerprint>;
    if (
      typeof fingerprint.size !== "number" ||
      !Number.isFinite(fingerprint.size) ||
      typeof fingerprint.mtimeMs !== "number" ||
      !Number.isFinite(fingerprint.mtimeMs)
    ) {
      continue;
    }
    entries[relPath] = {
      size: fingerprint.size,
      mtimeMs: fingerprint.mtimeMs,
      ...(typeof fingerprint.hash === "string" && fingerprint.hash !== ""
        ? { hash: fingerprint.hash }
        : {}),
    };
  }
  return { entries, coarse: data.coarse === true };
}

function metadataOf(stat: fs.Stats): { size: number; mtimeMs: number } {
  // 截到毫秒：JSON 往返与不同平台的浮点表示要一致，否则每次都会被误判成「改过」。
  return { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

/** 读不到内容时只留元数据；下一个快照仍能靠 size+mtime 判断。 */
function withHash(meta: { size: number; mtimeMs: number }, absPath: string): FileFingerprint {
  const hash = hashFile(absPath);
  return hash ? { ...meta, hash } : meta;
}

function sameMetadata(
  previous: FileFingerprint,
  next: { size: number; mtimeMs: number },
): boolean {
  return previous.size === next.size && previous.mtimeMs === next.mtimeMs;
}

/**
 * 两边都算过内容时以 hash 为准（`touch` 只改 mtime 不算变更）；
 * 粗判缺 hash 时才退回元数据。
 */
function fingerprintChanged(previous: FileFingerprint, next: FileFingerprint): boolean {
  if (previous.hash && next.hash) return previous.hash !== next.hash;
  return !sameMetadata(previous, next);
}

/** 递归列出声明目录下的所有文件；`.git` 不进快照。 */
function listDeclaredFiles(root: string, prefix: string): string[] {
  const files: string[] = [];
  const walk = (relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (entry.isFile()) files.push(relPath);
    }
  };
  walk(prefix);
  return files;
}

function hashFile(absPath: string): string | null {
  try {
    const stat = fs.lstatSync(absPath);
    if (!stat.isFile()) return null;
    return sha1(fs.readFileSync(absPath));
  } catch {
    return null;
  }
}

function dedupeChanges(changes: WorktreeChange[]): WorktreeChange[] {
  const seen = new Map<string, WorktreeChange>();
  for (const change of changes) seen.set(change.path, change);
  return [...seen.values()];
}
