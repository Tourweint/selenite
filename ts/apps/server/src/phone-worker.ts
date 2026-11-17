import type { Hono, Context } from "hono";
import {
  PhoneTaskTimeoutError,
  registerPhoneTransport,
  type PhoneResult,
  type PhoneTask,
  type PhoneTransport,
} from "../../../packages/chancellor/src/index.ts";

/**
 * 手机 worker 的电脑侧（2026-11-02 契约）。
 *
 * 三个接口，手机全部主动发起：poll 要活、model 代理 key、result 交结果。
 * 队列只在内存里：重启就丢，丢了的单子由 chancellor 判 idle。
 *
 * 鉴权由 `index.ts` 的 `/api/v1/*` 中间件统一兜住（设备凭据 ∪ 共享令牌），
 * 这里不再自己判 —— 失败 403 空体那条口径只写在一处。
 */

const DEFAULT_POLL_SECONDS = 30;
const MAX_POLL_SECONDS = 60;
const UPSTREAM_TIMEOUT_MS = 300_000;

/** 取消墓碑留多久：够手机把「已经拿到但还没交」的结果回传一次，够判"丢弃"而不是"未知单"。 */
const CANCELED_TTL_MS = 10 * 60_000;
const CANCELED_CAP = 200;

/**
 * 执行前重验开关（2026-11-10 批 26 §一）：默认开。
 * `PHONE_ENSURE_ACTIVE=false` → 交付前 / 收结果前都不再复核，回到本批之前的形态（一行回滚）。
 *
 * "执行"在手机上，服务端能保证的只有两件事：
 * ① **不再把已失效的单交出去**（取消 / 超时 / 已被别的 poll 认领）；
 * ② **已取消的单交回结果时不写回**（不 resolve，由 chancellor 侧按中止收口）。
 */
export function phoneEnsureActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PHONE_ENSURE_ACTIVE ?? "").trim().toLowerCase();
  if (!raw) return true;
  return raw !== "false" && raw !== "0" && raw !== "off";
}

interface PendingEntry {
  task: PhoneTask;
  /** 到期时刻：交付前再判一次，比"等 setTimeout 真的触发"更早挡住已超时的单。 */
  deadlineAt: number;
  /** 派活方给的信号：取消即 abort，交付前据此判"已取消"。 */
  signal?: AbortSignal;
  resolve(result: PhoneResult): void;
}

interface WaitingPoll {
  timer: NodeJS.Timeout;
  resolve(task: PhoneTask | null): void;
}

/** taskId → 等手机交结果的 Promise；没落库，重启即丢。 */
const pending = new Map<string, PendingEntry>();
/** 还没人 poll 走的任务，按派活顺序排队。 */
const ready: string[] = [];
/** 设备 → 当前挂着的 poll；同设备新 poll 会顶掉旧的。 */
const polls = new Map<string, WaitingPoll>();
/** 最近被取消的 taskId → 取消时刻：结果迟到时能回"已丢弃"而不是"未知单"。 */
const canceled = new Map<string, number>();

/** 判定一张已登记的单还能不能交付。取消优先于超时（事实更具体）。 */
export function inactiveReason(
  entry: { deadlineAt: number; signal?: AbortSignal },
  now = Date.now(),
): "canceled" | "expired" | null {
  if (entry.signal?.aborted) return "canceled";
  if (now >= entry.deadlineAt) return "expired";
  return null;
}

function markCanceled(taskId: string, now = Date.now()): void {
  canceled.set(taskId, now);
  if (canceled.size <= CANCELED_CAP) return;
  for (const [id, at] of canceled) {
    if (canceled.size <= CANCELED_CAP) break;
    if (now - at > CANCELED_TTL_MS) canceled.delete(id);
  }
  // 还是超限：按插入顺序丢最旧的（Map 保序），墓碑只用于回一句"已丢弃"，丢了不影响结果。
  while (canceled.size > CANCELED_CAP) {
    const oldest = canceled.keys().next().value;
    if (oldest === undefined) break;
    canceled.delete(oldest);
  }
}

function isRecentlyCanceled(taskId: string, now = Date.now()): boolean {
  const at = canceled.get(taskId);
  if (at === undefined) return false;
  if (now - at > CANCELED_TTL_MS) {
    canceled.delete(taskId);
    return false;
  }
  return true;
}

const transport: PhoneTransport = {
  dispatch(task, signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise<PhoneResult>((resolve, reject) => {
      let settled = false;

      const entry: PendingEntry = {
        task,
        deadlineAt: Date.now() + Math.max(1, task.budgetMs),
        signal,
        resolve: (result) => finish(() => resolve(result)),
      };

      const finish = (apply: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        // 同 taskId 重派时，旧单收尾不能连坐删掉新单的登记 / 队列位（否则新单永远交付不出去）。
        if (pending.get(task.taskId) === entry) {
          pending.delete(task.taskId);
          const queued = ready.indexOf(task.taskId);
          if (queued >= 0) ready.splice(queued, 1);
        }
        apply();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new PhoneTaskTimeoutError(task.taskId, task.budgetMs)));
      }, Math.max(1, task.budgetMs));

      const onAbort = (): void => {
        // 墓碑：手机可能已经拿着这张单在跑了；它交回结果时按"已取消、已丢弃"回。
        markCanceled(task.taskId);
        finish(() => reject(abortReason(signal)));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      pending.set(task.taskId, entry);

      if (!flushPoll(task)) ready.push(task.taskId);
    });
  },
};

registerPhoneTransport(transport);

function flushPoll(task: PhoneTask): boolean {
  const first = polls.entries().next();
  if (first.done) return false;
  const [device, poll] = first.value;
  polls.delete(device);
  clearTimeout(poll.timer);
  poll.resolve(task);
  return true;
}

/**
 * 从队列头取一张**还活着**的单。
 *
 * 执行前重验（2026-11-10 批 26 §一）：排队期间被取消 / 已过期 / 登记已被顶掉的单
 * **一律不交出去**——手机上少跑一次被取消的活，就没有"取消后仍产生副作用"。
 * 收尾交给各自的计时器 / abort 监听，队列这里只负责跳过。
 */
function nextQueuedTask(): PhoneTask | null {
  const guard = phoneEnsureActive();
  while (ready.length > 0) {
    const taskId = ready.shift();
    if (taskId === undefined) break;
    const entry = pending.get(taskId);
    if (!entry) continue;
    if (guard && inactiveReason(entry) !== null) continue;
    // 同一 taskId 被重派过时队列里可能有重复项：认领一次就把余下的清掉，绝不重复发。
    for (let index = ready.length - 1; index >= 0; index -= 1) {
      if (ready[index] === taskId) ready.splice(index, 1);
    }
    return entry.task;
  }
  return null;
}

export function mountPhoneWorker(app: Hono): void {
  /** 要活：有活立刻给，没活挂起 timeoutS 秒（默认 30，上限 60）后 204。 */
  app.post("/api/v1/worker/poll", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { timeoutS?: unknown } | null;
    const requested =
      typeof body?.timeoutS === "number" && Number.isFinite(body.timeoutS)
        ? body.timeoutS
        : DEFAULT_POLL_SECONDS;
    const timeoutS = Math.min(MAX_POLL_SECONDS, Math.max(1, Math.round(requested)));
    const device = bearerOf(c) || "anonymous";

    const immediate = nextQueuedTask();
    if (immediate) return c.json(toWireTask(immediate));

    // 同一设备只留一个 poll：新的顶掉旧的，旧的按超时收 204。
    const previous = polls.get(device);
    if (previous) {
      polls.delete(device);
      clearTimeout(previous.timer);
      previous.resolve(null);
    }

    let received: PhoneTask | null = null;
    let poll: WaitingPoll | null = null;
    const signal = c.req.raw.signal;

    await new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        if (poll && polls.get(device) === poll) {
          polls.delete(device);
          clearTimeout(poll.timer);
        }
        done();
      };
      poll = {
        timer: setTimeout(() => {
          if (poll && polls.get(device) === poll) polls.delete(device);
          done();
        }, timeoutS * 1000),
        resolve: (task) => {
          received = task;
          done();
        },
      };
      polls.set(device, poll);
      signal.addEventListener("abort", onAbort, { once: true });
    });

    if (!received) return c.body(null, 204);
    return c.json(toWireTask(received));
  });

  /**
   * 调模型：拿 harness 自己的 key 转发，响应原样回去。
   * 流式原样透传流，非流式原样返回字节；失败只回 502 + 脱敏后的说明。
   */
  app.post("/api/v1/worker/model", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | {
          taskId?: unknown;
          messages?: unknown;
          tools?: unknown;
          tool_choice?: unknown;
          stream?: unknown;
        }
      | null;

    if (!body || !Array.isArray(body.messages)) {
      return c.json({ error: "bad_request" }, 400);
    }

    const apiKey = process.env.LLM_API_KEY?.trim() || "";
    if (apiKey === "") {
      return c.json({ error: "upstream_failed", detail: "LLM 未配置" }, 502);
    }

    const baseUrl = (
      process.env.LLM_BASE_URL?.trim() ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ).replace(/\/+$/, "");
    const model = process.env.LLM_MODEL?.trim() || "deepseek-v4.1-flash";
    const stream = body.stream === true;

    const payload: Record<string, unknown> = { model, messages: body.messages };
    if (Array.isArray(body.tools)) payload.tools = body.tools;
    if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;
    if (stream) payload.stream = true;

    let upstream: Response;
    try {
      upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      // 连接失败的原始错误里可能带 URL；只给一句能定位方向的话。
      return c.json({ error: "upstream_failed", detail: "连不上模型商" }, 502);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return c.json(
        { error: "upstream_failed", detail: redact(text, apiKey) },
        502,
      );
    }

    if (stream || contentType.includes("text/event-stream")) {
      return c.newResponse(upstream.body, 200, {
        "content-type": contentType || "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
    }

    const text = await upstream.text();
    return c.body(text, 200, {
      "content-type": contentType || "application/json",
    });
  });

  /** 交结果：按 taskId 唤醒挂着的 Promise；找不到（比如电脑重启过）就 404。 */
  app.post("/api/v1/worker/result", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | {
          taskId?: unknown;
          status?: unknown;
          summary?: unknown;
          attention?: unknown;
        }
      | null;

    if (!body || typeof body.taskId !== "string" || typeof body.summary !== "string") {
      return c.json({ error: "bad_request" }, 400);
    }
    if (
      body.status !== "done" &&
      body.status !== "blocked" &&
      body.status !== "failed"
    ) {
      return c.json({ error: "bad_request" }, 400);
    }

    const entry = pending.get(body.taskId);
    if (!entry) {
      // 取消墓碑（批 26 §一）：手机可能已经拿着这张单跑完了。**结果丢弃、不写回**，
      // 只回一句"已丢弃"（手机端据 applied:false 不再重试）；日志只记单号，不记正文。
      if (phoneEnsureActive() && isRecentlyCanceled(body.taskId)) {
        console.log(`[phone] 丢弃迟到结果 task=${body.taskId} reason=canceled`);
        return c.json({ ok: true, applied: false, reason: "canceled" });
      }
      return c.json({ error: "unknown_task" }, 404);
    }

    if (phoneEnsureActive()) {
      const reason = inactiveReason(entry);
      if (reason !== null) {
        // 计时器还没来得及触发（事件循环被占）时也别写回：同一次判定，两种失效同一种处置。
        console.log(`[phone] 丢弃迟到结果 task=${body.taskId} reason=${reason}`);
        return c.json({ ok: true, applied: false, reason });
      }
    }

    const attention = parseAttention(body.attention);
    entry.resolve({
      status: body.status,
      summary: body.summary,
      ...(body.status === "blocked" && attention ? { attention } : {}),
    });
    return c.json({ ok: true });
  });
}

function toWireTask(task: PhoneTask): PhoneTask {
  return {
    taskId: task.taskId,
    goal: task.goal,
    doneWhen: task.doneWhen,
    budgetMs: task.budgetMs,
  };
}

function parseAttention(raw: unknown): { kind: "need_action"; question: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "need_action") return null;
  if (typeof obj.question !== "string" || obj.question.trim() === "") return null;
  return { kind: "need_action", question: obj.question.trim() };
}

function bearerOf(c: Context): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function abortReason(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("已停止");
  error.name = "AbortError";
  return error;
}

/** 上游报错只留一句：截断并抹掉 key（哪怕上游把它回显了）。 */
function redact(text: string, apiKey: string): string {
  const trimmed = text.trim();
  const redacted = apiKey === "" ? trimmed : trimmed.split(apiKey).join("[redacted]");
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 500)}…`;
}
