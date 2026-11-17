import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ensureDir, readJson, writeJson } from "./store.ts";

/**
 * 进行中标记（2026-11-03 方案 §5.7）。
 *
 * 每张单在 ticket 目录里留一份 inflight.json，只在进程真的开工后写、到终态就删。
 * 进程被杀后它还在，下一次进程启动据此判断「是还在跑、已跑完、断在半路、还是根本没记录」。
 * 只写路径与计数，不写对话内容。
 */
export interface InflightWorktree {
  seq: number;
  path: string;
}

export interface InflightRecord {
  ticketId: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** 已自动续跑次数；最多一次，防重启循环。 */
  resumeCount: number;
  /** 这张单是否已经有改动合并进项目目录。 */
  merged: boolean;
  taskDir: string;
  worktrees: InflightWorktree[];
}

export function inflightPath(ticketDir: string): string {
  return path.join(ticketDir, "inflight.json");
}

export function readInflight(ticketDir: string): InflightRecord | null {
  const record = readJson<Partial<InflightRecord>>(inflightPath(ticketDir));
  if (!record || typeof record.ticketId !== "string" || record.ticketId === "") return null;
  return {
    ticketId: record.ticketId,
    pid: typeof record.pid === "number" ? record.pid : 0,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    resumeCount: typeof record.resumeCount === "number" ? record.resumeCount : 0,
    merged: record.merged === true,
    taskDir: typeof record.taskDir === "string" ? record.taskDir : ticketDir,
    worktrees: Array.isArray(record.worktrees)
      ? record.worktrees.filter(
          (item): item is InflightWorktree =>
            Boolean(item) && typeof item.seq === "number" && typeof item.path === "string",
        )
      : [],
  };
}

/** 开工：记录当前进程与续跑次数；已有记录的续跑次数、合并状态原样保留。 */
export function startInflight(
  ticketDir: string,
  ticketId: string,
  patch: { resumeCount?: number; startedAt?: string } = {},
): InflightRecord {
  ensureDir(ticketDir);
  const now = new Date().toISOString();
  const existing = readInflight(ticketDir);
  const record: InflightRecord = {
    ticketId,
    pid: process.pid,
    startedAt: patch.startedAt ?? now,
    updatedAt: now,
    resumeCount: patch.resumeCount ?? existing?.resumeCount ?? 0,
    merged: existing?.merged ?? false,
    taskDir: ticketDir,
    worktrees: existing?.worktrees ?? [],
  };
  writeJson(inflightPath(ticketDir), record);
  return record;
}

export function markInflightMerged(ticketDir: string): void {
  const record = readInflight(ticketDir);
  if (!record) return;
  writeJson(inflightPath(ticketDir), {
    ...record,
    merged: true,
    updatedAt: new Date().toISOString(),
  });
}

export function recordInflightWorktree(
  ticketDir: string,
  seq: number,
  worktreePath: string,
): void {
  const record = readInflight(ticketDir);
  if (!record) return;
  const worktrees = record.worktrees.filter((item) => item.seq !== seq);
  worktrees.push({ seq, path: worktreePath });
  writeJson(inflightPath(ticketDir), {
    ...record,
    worktrees,
    updatedAt: new Date().toISOString(),
  });
}

export function clearInflightWorktree(ticketDir: string, seq: number): void {
  const record = readInflight(ticketDir);
  if (!record) return;
  writeJson(inflightPath(ticketDir), {
    ...record,
    worktrees: record.worktrees.filter((item) => item.seq !== seq),
    updatedAt: new Date().toISOString(),
  });
}

export function clearInflight(ticketDir: string): void {
  fs.rmSync(inflightPath(ticketDir), { force: true });
}
