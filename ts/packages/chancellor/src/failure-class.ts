import type { TaskRun } from "./types.ts";

/**
 * 失败分类 + attempt 重试 / 车道冷却口径（2026-11-22 调度层合并方案 M3）。
 *
 * 为什么在 chancellor 而不是池里：池只负责「执行一次」，它上报的是
 * pool_crashed / stream_closed / timeout 这类执行容器原因；要不要重试、
 * 等多久、是不是额度没了，属于调度层（合并方案 §4.1「重试边界」）。
 *
 * 纯函数，不 import 宿主（server）：宿主有 `model-chain.classifyUnanswered`，
 * 但依赖方向是 server → chancellor，不能反过来。
 */

export type FailureClass =
  | "usage_limit"
  | "rate_limit"
  | "transient"
  | "timeout"
  | "permission"
  | "unauthorized_write"
  | "merge_conflict"
  | "report_missing"
  | "crashed"
  | "aborted"
  | "unknown";

/**
 * 额度耗尽：重试立刻再撞，只能等 reset（额度类）。
 * 放在 rate_limit 前面判，因为 429 + quota 字样应归额度，而不是分钟级限流。
 */
const USAGE_LIMIT_MARKER =
  /usage[\s_-]?limit|insufficient[_\s]?quota|exceeded[^.\n]{0,40}quota|\bquota\b|credit balance|billing|spend limit|额度|用量上限|超出[^。\n]{0,8}(额度|配额)|套餐[^。\n]{0,8}(上限|额度)/i;

/** 带「小时级」reset 的 429：分钟级退避解决不了，按额度冷却处理。 */
const LONG_RESET_MARKER =
  /reset(?:s)?\s+(?:after|in)\s+\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|小时)|resets?\s+in\s+\d+\s*hours?/i;

const RATE_LIMIT_MARKER =
  /\b429\b|rate[\s_-]?limit|too many requests|overloaded|throttl|限流|请求(?:过于|太)频繁|并发(?:上限|超限)/i;

/**
 * 权限 / 登录类：重试也不会通过，只能要人重新授权或登录。
 * `permission_denials` 是外部 CLI 的统一口径（employee/cli.ts 的 failureReason）。
 */
const PERMISSION_MARKER =
  /permission[_\s-]?denials?|permission denied|permissions? (?:denied|required)|\bnot authorized\b|\bforbidden\b|\bunauthorized\b|\b(?:401|403)\b|not logged in|log ?in (?:expired|required)|sign in required|请先登录|登录(?:已)?(?:过期|失效)|未授权|无权限|权限不足|权限被拒|操作被拒/i;

/** 执行容器崩：池进程崩溃 / 流断 / 启动失败；镜像与宿主 token 不在这里判。 */
const CRASHED_MARKER =
  /pool_crashed|stream_closed|spawn_error|ready_timeout|supervisor_stopped|worker 进程失败|进程(?:崩溃|异常退出)|crash|EPIPE|broken pipe|unexpected exit/i;

/** 传输层抖动：5xx / ECONN / socket hang up；退避后大概率能过。 */
const TRANSIENT_MARKER =
  /ECONN(?:RESET|REFUSED|ABORTED|CLOSED)|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network (?:error|failure)|网络(?:错误|异常|断开)|连接(?:失败|中断)|no_idle_slot|\bbusy\b|run_post_failed|HTTP 5\d\d|\b50[0234]\b|temporar(?:ily|y) unavailable|timed out|请稍后重试|稍后重试/i;

/**
 * 判定一次任务失败的性质。顺序即优先级：
 * 1. 调度层自己判的失败（越权 / 合并冲突）不是执行器问题；
 * 2. 取消优先于任何文本：用户喊停不是失败，不该重试/冷却；
 * 3. 超时是调度层判定的（池 reason=timeout / CLI idle 超时），比 stderr 文本可靠；
 * 4. 只有「进程真失败」时才去读错误文本——成功的任务 stderr 里也可能出现 429 警告；
 * 5. 最后才看 REPORT 缺失，避免把「进程失败且没写报告」误判成报告问题。
 *
 * 成功执行也返回 `unknown`（"unknown" 同时兼作「没认出发败因」）：
 * 调用方要先看任务是否真失败，不能拿 unknown 当失败去重试。
 */
export function classifyRunFailure(run: TaskRun): FailureClass {
  const failure = (run.failure ?? "").trim();
  if (failure !== "") {
    if (/越权|unauthorized/i.test(failure)) return "unauthorized_write";
    if (/合并冲突|merge conflict|conflict/i.test(failure)) return "merge_conflict";
  }

  if (run.aborted) return "aborted";
  if (run.timedOut) return "timeout";

  const processFailed =
    !run.processOk || (run.exitCode !== null && run.exitCode !== 0);
  const text = failureText(run);
  if (processFailed && text !== "") {
    if (USAGE_LIMIT_MARKER.test(text)) return "usage_limit";
    if (RATE_LIMIT_MARKER.test(text)) {
      return LONG_RESET_MARKER.test(text) ? "usage_limit" : "rate_limit";
    }
    // 权限排在 transient 前：401/403 不是网络抖动，退避重试只会再被拒。
    if (PERMISSION_MARKER.test(text)) return "permission";
    if (CRASHED_MARKER.test(text)) return "crashed";
    if (TRANSIENT_MARKER.test(text)) return "transient";
  }

  if (!run.processOk) return "unknown";
  if (run.exitCode !== null && run.exitCode !== 0) return "unknown";
  if (!run.reportExists) return "report_missing";
  if ((run.reportError ?? "") !== "") return "report_missing";
  return "unknown";
}

/** 分类 / 解析 reset 共用的错误文本：只有服务端字段，不含对话正文。 */
export function failureText(run: TaskRun): string {
  return [run.failure ?? "", run.processError ?? "", run.stderrTail]
    .filter((part) => part !== "")
    .join("\n");
}

export interface RetryOptions {
  /** transient 最多重试几次；默认 2（1s / 4s）。 */
  maxTransient?: number;
  /** rate_limit 最多重试几次；默认 3（5s / 30s / 2min）。 */
  maxRateLimit?: number;
  /** usage_limit 最多重试几次；默认 3（每次最多等 5min）。 */
  maxUsageLimit?: number;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  /** 一句话说明；只含枚举、次数、时长，可进事件 / 日志。 */
  reason: string;
}

const TRANSIENT_DELAYS = [1_000, 4_000];
const RATE_LIMIT_DELAYS = [5_000, 30_000, 120_000];
const CRASHED_DELAYS = [2_000, 8_000];
const TIMEOUT_DELAYS = [0];
const USAGE_LIMIT_DELAYS = [5 * 60_000];

const NO_RETRY_REASON: Record<string, string> = {
  permission: "权限 / 登录类失败，重试也不会通过（要人重新授权）",
  unauthorized_write: "越权写入，重试只会再越权",
  merge_conflict: "合并冲突，重试不会消失（副本保留给人看）",
  report_missing: "REPORT.md 缺失或无法解析，重跑只会再缺",
  aborted: "已取消，不再重试",
  unknown: "认不出的失败，不自动重试",
};

/**
 * 这一次失败的 attempt 要不要再跑一轮、等多久。
 *
 * `attempt` 是刚落败的那一轮（1 起）：attempt=1 失败后决定的是第 1 次重试。
 * 默认口径见设计稿 §4.6：transient 2 次、rate_limit 3 次、timeout 1 次、
 * crashed 2 次、usage_limit 3 次；permission / 越权 / 冲突 / 报告缺失 / 取消 /
 * unknown 一律不重试——它们重跑只会得到同一个结论。
 */
export function retryDecision(
  cls: FailureClass,
  attempt: number,
  opts: RetryOptions = {},
): RetryDecision {
  const current = Math.max(1, Math.floor(attempt));
  const pick = (max: number, delays: number[], label: string): RetryDecision => {
    const limit = Math.max(0, Math.floor(max));
    if (current > limit) {
      return { retry: false, delayMs: 0, reason: `${label}已重试 ${limit} 次，不再重试` };
    }
    const delayMs = delays[Math.min(current - 1, delays.length - 1)] ?? 0;
    return {
      retry: true,
      delayMs,
      reason:
        delayMs > 0
          ? `${label}失败，${formatDelay(delayMs)}后重试（第 ${current} 次）`
          : `${label}失败，立即重试（第 ${current} 次）`,
    };
  };

  switch (cls) {
    case "transient":
      return pick(opts.maxTransient ?? 2, TRANSIENT_DELAYS, "传输类");
    case "rate_limit":
      return pick(opts.maxRateLimit ?? 3, RATE_LIMIT_DELAYS, "限流");
    case "crashed":
      return pick(2, CRASHED_DELAYS, "执行器崩溃");
    case "timeout":
      return pick(1, TIMEOUT_DELAYS, "超时");
    case "usage_limit":
      return pick(opts.maxUsageLimit ?? 3, USAGE_LIMIT_DELAYS, "额度");
    default:
      return {
        retry: false,
        delayMs: 0,
        reason: NO_RETRY_REASON[cls] ?? "该类失败不自动重试",
      };
  }
}

/**
 * 这一类失败是否值得再跑（终止回执用，2026-11-23）。
 * 复用 retryDecision 的默认口径，避免回执与调度层判断两套标准。
 */
export function failureIsRetryable(cls: FailureClass): boolean {
  return retryDecision(cls, 1).retry;
}

const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  "天": 86_400_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  "小时": 3_600_000,
  "时": 3_600_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  "分钟": 60_000,
  "分": 60_000,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  "秒": 1_000,
};

/** 时长 token：长的单位写前面，否则 `minutes` 会被 `m` 抢先匹配掉。 */
const DURATION_SOURCE =
  "(\\d+(?:\\.\\d+)?)\\s*(days?|天|hours?|hrs?|hr|h|小时|时|minutes?|mins?|min|m|分钟|分|seconds?|secs?|sec|s|秒)";

/** 触发词：只有紧跟触发词的时长才当 reset 时间，避免把日志里别处的数字当恢复时间。 */
const TRIGGER_SOURCE =
  "(?:reset(?:s)?(?:\\s+(?:after|in|at))?|retry(?:\\s+(?:after|in))?|try\\s+again\\s+(?:after|in)|available\\s+(?:after|in)|cooldown|cool(?:ing)?\\s+down|\\bwait(?:ing)?\\b|冷却(?:到|至|约)?|恢复(?:时间)?|重试|稍后|等待)";

/**
 * 从错误文本里解析「什么时候恢复」。
 *
 * 认这些形状（Claude / Codex / OpenCode / 中文文案）：
 * - `(reset after 1h 2m 3s)` / `reset after 2h 30m 5s` / `reset after 45m`
 * - `retry after 30s` / `available in 2 hours`
 * - `冷却 5 分钟` / `额度冷却到 30 分钟`
 * - `2 小时 30 分钟后恢复` / `5 分钟后重试`（倒装）
 *
 * 不认绝对时间（`resets 3pm` / ISO 时间戳）：没有时区信息，宁可回落 5min 兜底。
 * 返回 epoch ms；解析不到返回 null（调用方用 5min 兜底）。
 */
export function parseResetAt(text: string, now: number = Date.now()): number | null {
  if (!text) return null;

  // 每次新建 RegExp：带 g 的模块级正则会在多次调用间残留 lastIndex。
  const trigger = new RegExp(TRIGGER_SOURCE, "gi");
  let matched: RegExpExecArray | null;
  while ((matched = trigger.exec(text)) !== null) {
    // 只看触发词后面 80 个字符：一般错误消息里 reset 信息就在这一段。
    const window = text.slice(matched.index + matched[0].length, matched.index + matched[0].length + 80);
    const duration = parseDuration(window);
    if (duration !== null && duration >= 0) return now + duration;
  }

  // 中文倒装：「5 分钟后重试」「2 小时 30 分钟后恢复」。
  const suffix = /((?:\d+(?:\.\d+)?\s*(?:days?|天|hours?|hrs?|hr|h|小时|时|minutes?|mins?|min|m|分钟|分|seconds?|secs?|sec|s|秒)[\s,]*)+)(?:后|之后)/i.exec(
    text,
  );
  if (suffix && suffix[1]) {
    const duration = parseDuration(suffix[1]);
    if (duration !== null && duration >= 0) return now + duration;
  }

  return null;
}

/**
 * 额度 / 限流失败后这条车道冷却到什么时候。
 * - usage_limit：有 resetAt 就用它（上限 24h，防错误文本给出天际数字），没有就 5min；
 * - rate_limit：固定 30s（分钟级限流的退避上限）；
 * - 其它类不冷却（网络抖动 / 崩溃由 attempt 重试和 3 次熔断兜）。
 */
export function cooldownUntil(
  cls: FailureClass,
  resetAt: number | null,
  now: number = Date.now(),
): number | null {
  if (cls === "usage_limit") {
    const base =
      resetAt !== null && Number.isFinite(resetAt) && resetAt > now
        ? resetAt
        : now + 5 * 60_000;
    const cap = now + 24 * 60 * 60_000;
    return Math.min(base, cap);
  }
  if (cls === "rate_limit") return now + 30_000;
  return null;
}

/** 把窗口里所有时长 token 加起来；一个都没认出来返回 null。 */
function parseDuration(window: string): number | null {
  const pattern = new RegExp(DURATION_SOURCE, "gi");
  let total = 0;
  let found = false;
  let matched: RegExpExecArray | null;
  while ((matched = pattern.exec(window)) !== null) {
    const value = Number(matched[1]);
    const unit = UNIT_MS[(matched[2] ?? "").toLowerCase()];
    if (!Number.isFinite(value) || unit === undefined) continue;
    total += value * unit;
    found = true;
  }
  return found ? Math.round(total) : null;
}

function formatDelay(delayMs: number): string {
  if (delayMs <= 0) return "立即";
  if (delayMs < 60_000) return `${Math.round(delayMs / 1_000)} 秒`;
  return `${Math.round(delayMs / 60_000)} 分钟`;
}
