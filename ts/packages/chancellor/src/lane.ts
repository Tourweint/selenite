import { MAX_PARALLEL_TASKS } from "./config.ts";
import type { WorkerKind } from "./types.ts";

/**
 * 任务级车道帽 + 同领域串行（2026-11-22 调度层合并方案 M1a）。
 *
 * 背景：单票的 MAX_PARALLEL_TASKS 只管一张票内部；跨 ticket 没有总闸，
 * 外部 CLI（claude-code / codex / opencode…）更是完全绕开执行器池。
 * 这里补的是「同一执行器最多几个子进程」和「同一领域同时只放一个 manager」，
 * 不碰 ticket 准入与优先级（那是 M1b）。
 *
 * 设计约束：
 * - 纯逻辑，不 import 宿主（server）；用到 env 的地方都在调用时现读，
 *   测试才能在同一进程里翻开关。
 * - 车道容量以执行器为键：pool 与 native 共用 native 车道（容量 = 池大小），
 *   外部 CLI 各算各的。
 * - CHANCELLOR_SCHEDULER=false 是总回滚开关：车道与领域都直通，旧行为一字不差。
 *
 * M3（2026-11-22）追加车道冷却 / 连续失败熔断：冷却只影响「新 task 能不能开」，
 * 不打断正在跑的；失败类型判定在 failure-class.ts，这里只认调用方给的 ok。
 */

/** 已授予或直通的租约；release 必须幂等（cancel / 异常路径都可能重复走到）。 */
export interface LaneLease {
  release: () => void;
  granted: boolean;
  /**
   * 车道冷却中：granted=false 且带冷却截止（epoch ms）。
   * 调用方据此判「执行器冷却」并排队等，不要当成取消 / 拿不到槽处理（2026-11-22 M3）。
   */
  cooldownUntil?: number;
}

/** 排队信息：position 从 1 开始，只在该次等待「开始时」报一次。 */
export interface GateWaitInfo {
  position: number;
  cap: number;
  running: number;
}

export interface LaneWaitInfo extends GateWaitInfo {
  lane: string;
}

export interface DomainWaitInfo extends GateWaitInfo {
  domain: string;
}

export interface LaneSnapshot {
  lane: string;
  cap: number;
  running: number;
  queued: number;
}

interface Waiter {
  priority: number;
  resolve: (lease: LaneLease) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** 取消时从队列里摘掉，返回一个「没拿到槽位」的租约；调用方据此走 abort 收尾。 */
function notGrantedLease(): LaneLease {
  return { granted: false, release: () => {} };
}

/**
 * 按容量放行的闸门：满了就排队，release 唤醒下一个。
 * priority 小的先放（0 最高；同优先级先来先服务）——与调度层的 runSource 优先级同向：
 * human(0) > device(1) > routine(2)。M1a 调用方全用默认 0，参数留给 M1b。
 */
export class FifoGate {
  private desiredCap: number;
  /** 实际生效的容量：任何时候都不低于 running，避免出现「余额为负」。 */
  private cap: number;
  private running = 0;
  private queue: Waiter[] = [];

  constructor(max: number) {
    this.desiredCap = normalizeCap(max);
    this.cap = this.desiredCap;
  }

  /** cap 变了就地更新（env 可能被测试改）；调大时立刻补放排队者。 */
  setCap(max: number): void {
    this.desiredCap = normalizeCap(max);
    this.cap = Math.max(this.desiredCap, this.running);
    this.drain();
  }

  acquire(
    priority = 0,
    onWait?: (info: GateWaitInfo) => void,
    signal?: AbortSignal,
  ): Promise<LaneLease> {
    if (signal?.aborted) return Promise.resolve(notGrantedLease());
    if (this.running < this.cap && this.queue.length === 0) {
      this.running += 1;
      return Promise.resolve(this.lease());
    }
    return new Promise<LaneLease>((resolve) => {
      const waiter: Waiter = { priority, resolve, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          resolve(notGrantedLease());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      const at = this.queue.findIndex((item) => item.priority > priority);
      const index = at === -1 ? this.queue.length : at;
      this.queue.splice(index, 0, waiter);
      // 只叫一次：后续位置变化不追报，任务中心拿到的是一句「在排队」而不是刷屏。
      onWait?.({ position: index + 1, cap: this.cap, running: this.running });
    });
  }

  snapshot(): { cap: number; running: number; queued: number } {
    return { cap: this.cap, running: this.running, queued: this.queue.length };
  }

  private lease(): LaneLease {
    let released = false;
    return {
      granted: true,
      release: () => {
        if (released) return;
        released = true;
        this.running = Math.max(0, this.running - 1);
        // 释放后重新对齐容量：之前为保护 running 抬高过的 cap 到这里自然降回去。
        this.cap = Math.max(this.desiredCap, this.running);
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.running < this.cap && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      this.running += 1;
      next.resolve(this.lease());
    }
  }
}

/** 外部 CLI 的默认容量（方案 §5.2）；其它执行器回落到单票并行上限。 */
const DEFAULT_LANE_CAPS: Record<string, number> = {
  "claude-code": 4,
  codex: 4,
  opencode: 2,
  "qoder-intl": 2,
  "qoder-cn": 2,
  codebuddy: 2,
  phone: 1,
  mcp: 1,
};

const laneGates = new Map<string, FifoGate>();
const domainGates = new Map<string, FifoGate>();
/** 车道冷却截止（epoch ms）与连续失败计数（2026-11-22 M3，进程内状态）。 */
const laneCooldowns = new Map<string, number>();
const laneFailureStreaks = new Map<string, number>();

/** 同一车道连续 3 次失败就熔断 5 分钟（方案 §4.6 车道熔断）。 */
const LANE_BREAKER_FAILURES = 3;
const LANE_BREAKER_COOLDOWN_MS = 5 * 60_000;

function noopLease(): LaneLease {
  return { granted: true, release: () => {} };
}

/** 默认开；只有显式 false / 0 / no / off 才关（与 config.readBool 同口径）。 */
function schedulingEnabled(): boolean {
  const raw = process.env.CHANCELLOR_SCHEDULER;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  return !["false", "0", "no", "off"].includes(value);
}

/** pool 与 native 共用 native 车道，其它执行器原样成道。 */
export function laneNameOf(employeeKind: WorkerKind): string {
  return employeeKind === "pool" ? "native" : employeeKind;
}

/** `native:4,claude-code:2` 形式的覆盖；非法项直接忽略，不让一个错字关掉整条道。 */
function parseLaneCaps(raw: string | undefined): Map<string, number> {
  const caps = new Map<string, number>();
  if (!raw) return caps;
  for (const part of raw.split(",")) {
    const [nameRaw, valueRaw] = part.split(":");
    const name = nameRaw?.trim();
    const value = Number(valueRaw?.trim());
    if (!name || !Number.isFinite(value) || value <= 0) continue;
    caps.set(name, Math.floor(value));
  }
  return caps;
}

function laneCapOf(lane: string): number {
  const override = parseLaneCaps(process.env.CHANCELLOR_LANE_CAPS).get(lane);
  if (override !== undefined) return override;
  // native/pool 共用车道，容量 = 池大小；WORKER_POOL_SIZE 优先，旧名 SUPERVISOR_POOL_SIZE 仍兼容。
  if (lane === "native") {
    const rawPool = process.env.WORKER_POOL_SIZE ?? process.env.SUPERVISOR_POOL_SIZE;
    return envPositiveInt(rawPool, 8);
  }
  return DEFAULT_LANE_CAPS[lane] ?? MAX_PARALLEL_TASKS;
}

/**
 * 同领域容量：默认 1（方案 §5.2）；0 或负数 = 不限。
 * 不限用 Infinity 表示，闸门照常存在，排队信息里不会出现 cap=0 的怪值。
 */
function domainCapOf(): number {
  const raw = process.env.CHANCELLOR_MAX_ACTIVE_PER_DOMAIN;
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  if (value <= 0) return Infinity;
  return Math.floor(value);
}

function laneGate(lane: string): FifoGate {
  let gate = laneGates.get(lane);
  if (!gate) {
    gate = new FifoGate(laneCapOf(lane));
    laneGates.set(lane, gate);
    return gate;
  }
  // 每次取用都对一次 env：测试会在同一进程里改容量，重建不如就地更新。
  gate.setCap(laneCapOf(lane));
  return gate;
}

function domainGate(domain: string): FifoGate {
  let gate = domainGates.get(domain);
  if (!gate) {
    gate = new FifoGate(domainCapOf());
    domainGates.set(domain, gate);
    return gate;
  }
  gate.setCap(domainCapOf());
  return gate;
}

/**
 * 取一个执行器车道槽位。满了就挂起，直到有人 release。
 * 调用方必须先拿车道、再拿文件租约：反过来会形成「持租约等槽 / 持槽等租约」的死锁。
 */
export async function acquireLane(
  employeeKind: WorkerKind,
  opts: {
    priority?: number;
    onWait?: (info: LaneWaitInfo) => void;
    signal?: AbortSignal;
  } = {},
): Promise<LaneLease> {
  if (!schedulingEnabled()) return noopLease();
  if (opts.signal?.aborted) return notGrantedLease();
  const lane = laneNameOf(employeeKind);
  // 冷却中不排队、不占槽：直接回 granted=false + 截止时间，调用方据此显示
  //「执行器冷却到 HH:mm」并定期重试，而不是把整条车道挂死在这里。
  const cooling = laneCooldown(lane);
  if (cooling !== null) {
    return { granted: false, cooldownUntil: cooling, release: () => {} };
  }
  return laneGate(lane).acquire(
    opts.priority ?? 0,
    (info) => opts.onWait?.({ lane, ...info }),
    opts.signal,
  );
}

/**
 * 把一条车道冷却到 untilMs（epoch ms）。只延长、不缩短：
 * 已经冷却到更晚时，新的（更早的）通知不能把冷却提前解除。
 */
export function setLaneCooldown(lane: string, untilMs: number): void {
  if (!schedulingEnabled()) return;
  const key = lane.trim();
  if (key === "" || !Number.isFinite(untilMs)) return;
  const current = laneCooldowns.get(key) ?? 0;
  if (untilMs > current) laneCooldowns.set(key, untilMs);
}

/** 车道冷却截止时间；没冷却 / 已到期返回 null（到期顺手清掉，免得表无限长）。 */
export function laneCooldown(lane: string): number | null {
  const key = lane.trim();
  const until = laneCooldowns.get(key);
  if (until === undefined) return null;
  if (until <= Date.now()) {
    laneCooldowns.delete(key);
    return null;
  }
  return until;
}

/**
 * 记录一次任务结算（M3 车道熔断）。只由调度层在 settle 时调用一次 / 任务，
 * 不按 attempt 重复计数：同一个 task 的重试不该把整条车道熔断（方案 §4.6）。
 * ok=false 连续 3 次 → 冷却 5 分钟并清零计数；ok=true 清零。
 *
 * 这里不判失败类型：哪些失败算「车坏了」由调度层决定（权限 / 崩溃 / 认不出），
 * 额度 / 网络 / 报告问题不该把车道关掉。
 */
export function recordLaneOutcome(lane: string, ok: boolean): void {
  if (!schedulingEnabled()) return;
  const key = lane.trim();
  if (key === "") return;
  if (ok) {
    laneFailureStreaks.delete(key);
    return;
  }
  const streak = (laneFailureStreaks.get(key) ?? 0) + 1;
  if (streak < LANE_BREAKER_FAILURES) {
    laneFailureStreaks.set(key, streak);
    return;
  }
  laneFailureStreaks.delete(key);
  setLaneCooldown(key, Date.now() + LANE_BREAKER_COOLDOWN_MS);
}

/**
 * 同领域串行：同一领域的 manager 子进程一次只放一个，避免两个会话并发改同一份领域状态。
 * domain 为空 = 这张单没有分管领域，直通。
 */
export async function acquireDomain(
  domain: string,
  opts: { onWait?: (info: DomainWaitInfo) => void; signal?: AbortSignal } = {},
): Promise<LaneLease> {
  if (!schedulingEnabled()) return noopLease();
  const key = domain.trim();
  if (key === "") return noopLease();
  return domainGate(key).acquire(
    0,
    (info) => opts.onWait?.({ domain: key, ...info }),
    opts.signal,
  );
}

/** 调度层状态投影（M1a 先给内部用；GET /api/v1/scheduler 在 M2 接）。 */
export function laneSnapshot(): LaneSnapshot[] {
  return [...laneGates.entries()]
    .map(([lane, gate]) => ({ lane, ...gate.snapshot() }))
    .sort((a, b) => a.lane.localeCompare(b.lane));
}

/** 只在测试里用：清掉所有闸门与冷却，让下一条测试从干净容量开始。 */
export function resetSchedulingForTest(): void {
  laneGates.clear();
  domainGates.clear();
  laneCooldowns.clear();
  laneFailureStreaks.clear();
}

function normalizeCap(max: number): number {
  if (!Number.isFinite(max)) return Infinity;
  const value = Math.floor(max);
  return value > 0 ? value : 1;
}

function envPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
