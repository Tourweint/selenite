import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { LEASE_HEARTBEAT_MS, LEASE_STALE_MS } from "./config.ts";
import { ensureDir, readJson, writeJson } from "./store.ts";

/**
 * 写入租约（2026-11-03 方案 §5.4）。
 *
 * 粒度是 `(项目, 相对路径)`：同一个文件同一时刻只允许一个任务持有。
 * 跨进程也要成立，所以落盘成目录锁：`mkdir` 原子，进程崩了靠心跳过期回收。
 * 锁放在总管给的项目数据目录里，chancellor 不自己发明位置。
 */
export interface LeaseOwner {
  pid: number;
  ticketId: string;
  seq: number;
  path: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface LeaseAcquireResult {
  ok: boolean;
  /** 失败时：谁先占了哪个路径。 */
  heldBy?: LeaseOwner;
  /** 失败时：被占的路径（项目相对路径）。 */
  blockedPath?: string;
}

export class LeaseManager {
  readonly root: string;
  private readonly held = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly ownerHeader: { ticketId: string; seq: number };

  constructor(opts: {
    dataDir: string;
    projectId: string;
    ticketId: string;
    seq: number;
  }) {
    this.root = path.join(path.resolve(opts.dataDir), "leases", opts.projectId);
    this.ownerHeader = { ticketId: opts.ticketId, seq: opts.seq };
    ensureDir(this.root);
  }

  /** 全有或全无：任意一条被占就释放已拿到的，任务进「等待文件」。 */
  acquire(paths: string[]): LeaseAcquireResult {
    const sorted = [...new Set(paths)].sort();
    const acquired: string[] = [];
    for (const relPath of sorted) {
      const dir = this.leaseDir(relPath);
      try {
        fs.mkdirSync(dir);
      } catch (error) {
        if (!isExist(error)) {
          this.releaseAll();
          throw error;
        }
        const owner = readJson<LeaseOwner>(path.join(dir, "owner.json"));
        if (owner && !isStale(owner)) {
          this.releaseAll();
          return { ok: false, heldBy: owner, blockedPath: relPath };
        }
        // 过期锁（进程已死或心跳停了）：清掉重试一次。
        fs.rmSync(dir, { recursive: true, force: true });
        try {
          fs.mkdirSync(dir);
        } catch (retryError) {
          if (!isExist(retryError)) throw retryError;
          this.releaseAll();
          return { ok: false, blockedPath: relPath };
        }
      }
      const owner: LeaseOwner = {
        pid: process.pid,
        ticketId: this.ownerHeader.ticketId,
        seq: this.ownerHeader.seq,
        path: relPath,
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      };
      writeJson(path.join(dir, "owner.json"), owner);
      acquired.push(relPath);
    }
    for (const relPath of acquired) this.held.add(relPath);
    this.startHeartbeat();
    return { ok: true };
  }

  releaseAll(): void {
    for (const relPath of this.held) {
      fs.rmSync(this.leaseDir(relPath), { recursive: true, force: true });
    }
    this.held.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 合并后仍然持有到调用方确认成功；失败时保留锁也没有意义，统一释放。 */
  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = new Date().toISOString();
      for (const relPath of this.held) {
        const file = path.join(this.leaseDir(relPath), "owner.json");
        const owner = readJson<LeaseOwner>(file);
        if (!owner) continue;
        writeJson(file, { ...owner, heartbeatAt: now });
      }
    }, LEASE_HEARTBEAT_MS);
    // 进程退出不应被这个定时器拖住。
    this.timer.unref?.();
  }

  private leaseDir(relPath: string): string {
    const digest = crypto.createHash("sha1").update(relPath).digest("hex");
    return path.join(this.root, digest);
  }
}

/** 项目启动时清掉所有心跳过期的锁；活着的持有者不受影响。 */
export function releaseStaleLeases(root: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let released = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const owner = readJson<LeaseOwner>(path.join(dir, "owner.json"));
    if (owner && !isStale(owner)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    released += 1;
  }
  return released;
}

function isStale(owner: LeaseOwner): boolean {
  const heartbeat = Date.parse(owner.heartbeatAt);
  const age = Number.isFinite(heartbeat) ? Date.now() - heartbeat : Infinity;
  if (age > LEASE_STALE_MS) return true;
  return !isPidAlive(owner.pid);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程在，只是没权限给它发信号。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isExist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
