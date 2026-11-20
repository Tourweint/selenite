import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ProjectRef } from "./types.ts";
import { ensureDir, readJson, writeJson } from "./store.ts";
import { normalizeProjectPath } from "./paths.ts";

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

function dedupeChanges(changes: WorktreeChange[]): WorktreeChange[] {
  const seen = new Map<string, WorktreeChange>();
  for (const change of changes) seen.set(change.path, change);
  return [...seen.values()];
}
