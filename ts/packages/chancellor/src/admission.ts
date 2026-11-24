import process from "node:process";

/**
 * ticket 准入闸 + 优先级（2026-11-22 调度层合并方案 M1b）。
 *
 * 背景：M1a 的 `lane.ts` 只管「同一执行器最多几个子进程」和「同领域 manager 串行」，
 * 但收单后没有跨 ticket 的总闸。2026-11-23 拆单器退役后收单不再调模型，准入仍然限制
 * 「同时活跃的票」，避免一次连派 N 单把执行器 / 池 / 供应商一起打爆。
 *
 *   intake → 单号已出 → 申请 admission → 拿到才进入规划 / 执行
 *                                     └─ 拿不到：排队（按 runSource 优先级）或明确失败
 *
 * 设计约束（与 lane.ts 同风格，但**不 import 它的私有函数**）：
 * - 纯逻辑，不 import 宿主（server）；env 在每次取用时现读，测试才能在同一进程里翻开关。
 * - 全局与 per-domain 两道闸同时守：任何一道满都不能放行；空 domain 不占领域名额。
 * - 优先级小的先放（human 0 > device 1 > routine 2 > script 3 > test 9），同优先级先来先服务。
 * - 队列不是无限缓冲：`CHANCELLOR_QUEUE_MAX` 满了直接拒（业务失败），不静默堆积。
 * - `CHANCELLOR_SCHEDULER=false` 是总回滚开关：整个准入闸直通，旧行为一字不差。
 *
 * 与 lane.ts 的口径对照（两边必须一致，但各自读 env，避免 chancellor 内部互相依赖）：
 * - 开关解析：false / 0 / no / off 才关，其它（含空串）都算开。
 * - `CHANCELLOR_MAX_ACTIVE_PER_DOMAIN`：默认 4；0 / 负数 = 不限。
 */

/** 准入租约；release 必须幂等（取消 / 异常 / finally 都可能重复走到）。 */
export interface AdmissionLease {
  granted: boolean;
  /** 没拿到时的原因：队列满（业务拒绝）还是排队中被取消。 */
  reason?: "queue_full" | "aborted";
  release: () => void;
}

/** 排队信息：position 从 1 开始，只在该次等待开始时报一次。 */
export interface AdmissionWaitInfo {
  /** 队伍位置（1 起）：前面还有 position - 1 单。 */
  position: number;
  /** 全局上限；Infinity 表示不限。 */
  max: number;
  /** 当前已准入、尚未 release 的票数。 */
  active: number;
  /** 只有非空领域才带，方便看板说明在等哪个领域。 */
  domain?: string;
}

export interface AdmissionSnapshot {
  max: number;
  active: number;
  queued: number;
  /** 各领域当前占用的票数；没有领域占用时不出现。 */
  domains?: Record<string, number>;
}

export interface AdmissionLimits {
  /** 同时 active 的 ticket 上限；Infinity = 不限。 */
  maxActive: number;
  /** 同一领域同时 active 的 ticket 上限；Infinity = 不限。 */
  maxActivePerDomain: number;
  /** 等待队列长度上限；0 = 不排队（装不下直接拒）。 */
  queueMax: number;
}

export interface AdmissionAcquireOptions {
  /** 分管领域；空串 / 省略 = 不受 per-domain 限制。 */
  domain?: string;
  /** 0 最高；缺省 5，与 ChancellorRequest.priority 对齐。 */
  priority?: number;
  signal?: AbortSignal;
  onWait?: (info: AdmissionWaitInfo) => void;
}

interface Waiter {
  domain: string;
  priority: number;
  resolve: (lease: AdmissionLease) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_MAX_ACTIVE_PER_DOMAIN = 4;
const DEFAULT_QUEUE_MAX = 64;
const DEFAULT_PRIORITY = 5;

/**
 * 纯内存闸门。测试可以直接 new 一个固定上限的实例；生产走文件末尾的单例。
 *
 * 不在这里读 env：构造时收 limits，模块单例负责「每次取用现读 env 再 setLimits」。
 * 这样单测既能钉死容量，也能在同一进程里验证 env 开关。
 */
export class TicketAdmissionGate {
  private limits: AdmissionLimits;
  private active = 0;
  /** 只记非空领域的占用；空串不进表，释放时也不会误删别人。 */
  private readonly domainActive = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(limits: Partial<AdmissionLimits> = {}) {
    this.limits = normalizeLimits(limits);
  }

  /** env 变了就地更新；只改传入的项，缩容不打断已跑的票，只影响下一次放行。 */
  setLimits(limits: Partial<AdmissionLimits>): void {
    this.limits = normalizeLimits({
      maxActive: limits.maxActive ?? this.limits.maxActive,
      maxActivePerDomain: limits.maxActivePerDomain ?? this.limits.maxActivePerDomain,
      queueMax: limits.queueMax ?? this.limits.queueMax,
    });
    // 调大容量后可能立刻能补放排队者；调小则等现有票自然释放。
    this.drain();
  }

  acquire(opts: AdmissionAcquireOptions = {}): Promise<AdmissionLease> {
    const domain = typeof opts.domain === "string" ? opts.domain.trim() : "";
    const priority = normalizePriority(opts.priority);

    if (opts.signal?.aborted) {
      // 还没排队就已经被取消：不占名额，也不进队列。
      return Promise.resolve(deniedLease("aborted"));
    }

    // 队列空且装得下才直接放行：队列非空时按优先级走下面的排队逻辑，避免后来者越队。
    if (this.queue.length === 0 && this.canGrant(domain)) {
      return Promise.resolve(this.grant(domain));
    }

    if (this.queue.length >= this.limits.queueMax) {
      // 满了就明确拒绝；不无限缓冲，也不假装「一会儿就能跑」。
      return Promise.resolve(deniedLease("queue_full"));
    }

    return new Promise<AdmissionLease>((resolve) => {
      const waiter: Waiter = {
        domain,
        priority,
        resolve,
        ...(opts.signal ? { signal: opts.signal } : {}),
      };

      if (opts.signal) {
        // 排队中取消：从队列摘掉，返回 aborted；不占名额、不误放行别人。
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          resolve(deniedLease("aborted"));
        };
        opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      // 优先级小的先放；同优先级保持到达顺序（插在第一个更低优先级的人之前）。
      const at = this.queue.findIndex((item) => item.priority > priority);
      const index = at === -1 ? this.queue.length : at;
      this.queue.splice(index, 0, waiter);

      // 插队后按顺序补放一圈：前面可能有人卡在自己的领域上，
      // 不能因为他占着队首就让全局空位空转。
      this.drain();

      if (this.queue.includes(waiter)) {
        // 只报一次：后续位置变化不追报，任务中心看到的是一句「在排队」而不是刷屏。
        // 播报异常不能把准入 promise 变成异常——否则队列里会留下一个没人收的 waiter，
        // 以后补放时还会白占名额。
        try {
          opts.onWait?.({
            position: this.queue.indexOf(waiter) + 1,
            max: this.limits.maxActive,
            active: this.active,
            ...(domain !== "" ? { domain } : {}),
          });
        } catch {
          // 事件出口是旁路；排队本身不受影响。
        }
      }
    });
  }

  snapshot(): AdmissionSnapshot {
    const domains: Record<string, number> = {};
    for (const [domain, count] of this.domainActive) domains[domain] = count;
    return {
      max: this.limits.maxActive,
      active: this.active,
      queued: this.queue.length,
      ...(Object.keys(domains).length > 0 ? { domains } : {}),
    };
  }

  /** 全局与领域两道闸都装得下才放行；空领域只看全局。 */
  private canGrant(domain: string): boolean {
    if (this.active >= this.limits.maxActive) return false;
    if (domain !== "" && (this.domainActive.get(domain) ?? 0) >= this.limits.maxActivePerDomain) {
      return false;
    }
    return true;
  }

  /**
   * 按队列顺序扫描：装得下的领走，装不下的留在原位等下一次释放。
   * 用 while + 手动索引（不 shift）是因为放行后会 splice，索引不能无脑自增。
   */
  private drain(): void {
    let index = 0;
    while (index < this.queue.length) {
      const waiter = this.queue[index]!;
      if (!this.canGrant(waiter.domain)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(this.grant(waiter.domain));
    }
  }

  private grant(domain: string): AdmissionLease {
    this.active += 1;
    if (domain !== "") {
      this.domainActive.set(domain, (this.domainActive.get(domain) ?? 0) + 1);
    }
    let released = false;
    return {
      granted: true,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        if (domain !== "") {
          const next = Math.max(0, (this.domainActive.get(domain) ?? 0) - 1);
          if (next === 0) this.domainActive.delete(domain);
          else this.domainActive.set(domain, next);
        }
        this.drain();
      },
    };
  }
}

let gate: TicketAdmissionGate | null = null;

/**
 * 生产入口：默认读 env 的单例。
 * 关掉调度层时返回直通租约，连闸门都不建（`admissionSnapshot()` 也不会出现幽灵状态）。
 */
export function acquireAdmission(
  opts: AdmissionAcquireOptions = {},
): Promise<AdmissionLease> {
  if (!schedulingEnabled()) return Promise.resolve(grantedNoopLease());
  return gateFromEnv().acquire(opts);
}

/** 调度层状态投影（M1b 先给内部/测试用；GET /api/v1/scheduler 在 M2 接）。 */
export function admissionSnapshot(): AdmissionSnapshot {
  if (!gate) {
    return { max: limitsFromEnv().maxActive, active: 0, queued: 0 };
  }
  gate.setLimits(limitsFromEnv());
  return gate.snapshot();
}

/** 只在测试里用：丢掉单例，让下一条测试从干净状态开始（排队中的 promise 由测试自己收尾）。 */
export function resetAdmissionForTest(): void {
  gate = null;
}

function gateFromEnv(): TicketAdmissionGate {
  const limits = limitsFromEnv();
  if (!gate) {
    gate = new TicketAdmissionGate(limits);
    return gate;
  }
  gate.setLimits(limits);
  return gate;
}

/**
 * 每次取用现读 env：测试会在同一进程里改上限 / 开关，缓存不如就地重算。
 * 三个变量与方案 §5.2 对齐：
 * - CHANCELLOR_MAX_ACTIVE_TICKETS 默认 8（0 / 负数 = 不限）
 * - CHANCELLOR_MAX_ACTIVE_PER_DOMAIN 默认 4（0 / 负数 = 不限）
 * - CHANCELLOR_QUEUE_MAX 默认 64（0 = 不排队）
 */
function limitsFromEnv(): AdmissionLimits {
  return {
    maxActive: activeLimitFromEnv("CHANCELLOR_MAX_ACTIVE_TICKETS", DEFAULT_MAX_ACTIVE),
    maxActivePerDomain: activeLimitFromEnv(
      "CHANCELLOR_MAX_ACTIVE_PER_DOMAIN",
      DEFAULT_MAX_ACTIVE_PER_DOMAIN,
    ),
    queueMax: queueMaxFromEnv("CHANCELLOR_QUEUE_MAX", DEFAULT_QUEUE_MAX),
  };
}

/** 默认开；只有显式 false / 0 / no / off 才关（与 lane.ts 的 schedulingEnabled 同口径）。 */
function schedulingEnabled(): boolean {
  const raw = process.env.CHANCELLOR_SCHEDULER;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  return !["false", "0", "no", "off"].includes(value);
}

/** 0 / 负数 = 不限（用 Infinity 表示），非法值回落默认；与 lane.ts 的 domainCapOf 同口径。 */
function activeLimitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const limit = Math.floor(value);
  return limit > 0 ? limit : Infinity;
}

/** 0 = 不排队；负数也当 0（没有「负队列」这种语义），非法值回落默认。 */
function queueMaxFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeLimits(limits: Partial<AdmissionLimits>): AdmissionLimits {
  return {
    maxActive: normalizeActiveLimit(limits.maxActive, DEFAULT_MAX_ACTIVE),
    maxActivePerDomain: normalizeActiveLimit(
      limits.maxActivePerDomain,
      DEFAULT_MAX_ACTIVE_PER_DOMAIN,
    ),
    queueMax: normalizeQueueMax(limits.queueMax, DEFAULT_QUEUE_MAX),
  };
}

function normalizeActiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  if (value === Infinity) return Infinity;
  const limit = Math.floor(value);
  return limit > 0 ? limit : Infinity;
}

function normalizeQueueMax(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizePriority(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PRIORITY;
  return Math.trunc(value);
}

function deniedLease(reason: "queue_full" | "aborted"): AdmissionLease {
  return { granted: false, reason, release: () => {} };
}

function grantedNoopLease(): AdmissionLease {
  return { granted: true, release: () => {} };
}
