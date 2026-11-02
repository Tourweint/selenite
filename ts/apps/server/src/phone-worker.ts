import type { Hono, Context } from "hono";
import {
  PhoneTaskTimeoutError,
  registerPhoneTransport,
  type PhoneResult,
  type PhoneTask,
  type PhoneTransport,
} from "../../../../../chancellor/src/index.ts";

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

interface PendingEntry {
  task: PhoneTask;
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

const transport: PhoneTransport = {
  dispatch(task, signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise<PhoneResult>((resolve, reject) => {
      let settled = false;

      const finish = (apply: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(task.taskId);
        const queued = ready.indexOf(task.taskId);
        if (queued >= 0) ready.splice(queued, 1);
        apply();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new PhoneTaskTimeoutError(task.taskId, task.budgetMs)));
      }, Math.max(1, task.budgetMs));

      const onAbort = (): void => {
        finish(() => reject(abortReason(signal)));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      pending.set(task.taskId, {
        task,
        resolve: (result) => finish(() => resolve(result)),
      });

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

function nextQueuedTask(): PhoneTask | null {
  while (ready.length > 0) {
    const taskId = ready.shift();
    if (taskId === undefined) break;
    const entry = pending.get(taskId);
    if (entry) return entry.task;
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
    if (!entry) return c.json({ error: "unknown_task" }, 404);

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
