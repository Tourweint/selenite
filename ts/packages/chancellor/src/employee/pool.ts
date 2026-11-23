import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { EmployeeCapabilities, WorkerEscalation } from "../types.ts";
import { effectiveWorkerTools, workerAllowedTools } from "../worker-tools-source.ts";
import type { Employee, EmployeeOutcome, EmployeeTask } from "./index.ts";

/**
 * 池执行器（2026-11-22 执行器池方案 §5.4）。
 *
 * chancellor 不许 import 宿主：宿主在启动时通过 `setPoolClient()` 把 supervisor 注入进来
 * （同 `setWorkerPersonaSource` / `setInternalAsk` 先例）。没注入 = 这一档不可用，
 * `createEmployee("pool")` 会抛一句人话，而不是静默退回 native。
 */

export interface PoolClientRunResult {
  ok: boolean;
  reason: string;
}

export interface PoolClientEvent {
  type: string;
  [key: string]: unknown;
}

/** 宿主注入的接口（实现见 apps/server/src/pool/supervisor.ts 的 WorkerPoolSupervisor）。 */
export interface PoolClient {
  run(
    run: {
      ticketId: string;
      dir: string;
      workDir: string;
      instruction: string;
      doneWhen: string;
      upstream?: string;
      model?: string;
      /** 供应商端点（baseUrl + keyEnv 变量名）；密钥值不经这条通道。 */
      modelRoute?: { baseUrl: string; keyEnv: string };
      /**
       * 这一票可用的工具（2026-11-22 工具面统一）：canonical 四件的补集 + escalate。
       * 不传 = 池默认五件全开（旧行为）。
       */
      tools?: string[];
    },
    onEvent: (event: PoolClientEvent) => void,
    signal?: AbortSignal,
  ): Promise<PoolClientRunResult>;
  say(ticketId: string, text: string, mode?: "steer" | "followUp"): Promise<{ ok: boolean; message?: string }>;
  abort(ticketId: string): Promise<{ ok: boolean; message?: string }>;
}

export const POOL_CAPABILITIES: EmployeeCapabilities = {
  artifacts: "taskDir",
  canWriteFiles: true,
};

let client: PoolClient | null = null;

export function setPoolClient(next: PoolClient | null): void {
  client = next;
}

/**
 * 宿主池桥（2026-11-22）：manager 子进程里没有 `setPoolClient` 注入口，
 * 只能靠宿主 spawn 时带下来的 endpoint + token。token 只进这一条 env，不落盘。
 */
export interface ManagerPoolBridge {
  endpoint: string;
  token: string;
}

let managerBridge: ManagerPoolBridge | null = null;

export function setManagerPoolBridge(next: ManagerPoolBridge | null): void {
  managerBridge = next;
}

export function getManagerPoolBridge(): ManagerPoolBridge | null {
  return managerBridge;
}

let envClient: PoolClient | null = null;
let envClientKey = "";

/** manager 子进程：从 env 建一个指向宿主池桥的 HTTP 客户端（幂等）。 */
function bridgeClientFromEnv(): PoolClient | null {
  const endpoint = process.env.CHANCELLOR_POOL_ENDPOINT?.trim() ?? "";
  if (!endpoint) return null;
  const token = process.env.CHANCELLOR_POOL_TOKEN?.trim() ?? "";
  const key = `${endpoint}\n${token}`;
  if (envClient && envClientKey === key) return envClient;
  envClient = createHttpPoolClient(endpoint, token);
  envClientKey = key;
  return envClient;
}

export function poolAvailable(): boolean {
  return client !== null || bridgeClientFromEnv() !== null;
}

function selectedPoolTools(): string[] | undefined {
  const allowed = workerAllowedTools();
  if (allowed === null) return undefined;
  // canonical 四件按勾选过滤；escalate 是池工人的通信手段，恒开（不能被勾掉）。
  return [...effectiveWorkerTools(allowed), "escalate"];
}

function routeFromEnv(): { baseUrl: string; keyEnv: string } | undefined {
  const baseUrl = process.env.CHANCELLOR_LLM_BASE_URL?.trim() ?? "";
  const keyEnv = process.env.CHANCELLOR_LLM_KEY_ENV?.trim() ?? "";
  return baseUrl && keyEnv ? { baseUrl, keyEnv } : undefined;
}

/** `<runsRoot>/<ticketId>/<NN>-<slug>` 布局 → 单号（与 native.ts 的 ticketIdOfTask 同口径）。 */
export function ticketIdOfTask(task: EmployeeTask): string {
  return path.basename(path.dirname(path.resolve(task.dir))) || "";
}

export function reportRawOf(task: EmployeeTask): string | null {
  try {
    return fs.readFileSync(path.join(task.dir, "REPORT.md"), "utf8");
  } catch {
    return null;
  }
}

export function createPoolEmployee(): Employee {
  return {
    kind: "pool",
    capabilities: POOL_CAPABILITIES,
    async run(task: EmployeeTask, signal?: AbortSignal): Promise<EmployeeOutcome> {
      const active = client ?? bridgeClientFromEnv();
      if (!active) {
        return {
          processOk: false,
          exitCode: null,
          timedOut: false,
          aborted: false,
          reportRaw: reportRawOf(task),
          stderrTail: "",
          error: "池执行器未接线：宿主启动时没有注入 PoolClient（检查 supervisor 是否启动）",
        };
      }
      const ticketId = ticketIdOfTask(task);
      // 模型：建单快照优先；manager 子进程没有快照时从 profileEnv 继承的 env 兜底。
      const model = task.settings?.model?.trim() || process.env.CHANCELLOR_LLM_MODEL?.trim() || "";
      const route = task.settings?.modelRoute ?? routeFromEnv();
      const tools = selectedPoolTools();
      try {
        const result = await active.run(
          {
            ticketId,
            dir: task.dir,
            workDir: task.workDir ?? task.dir,
            instruction: task.instruction,
            doneWhen: task.doneWhen,
            ...(task.upstream ? { upstream: task.upstream } : {}),
            ...(model ? { model } : {}),
            ...(route ? { modelRoute: route } : {}),
            ...(tools ? { tools } : {}),
          },
          (event) => {
            if (event.type !== "escalation") return;
            const escalation = (event as { escalation?: WorkerEscalation }).escalation;
            if (escalation) task.onEscalation?.(escalation);
          },
          signal,
        );
        return {
          processOk: result.ok,
          exitCode: result.ok ? 0 : 1,
          // M2a（2026-11-22）：池的单票超时由 supervisor 判定并回 reason="timeout"，
          // 本地没有 signal、也没有进程级 timeout，只能认这个 reason。
          timedOut: result.reason === "timeout",
          // M0（2026-11-22）：supervisor 收 callerSignal 后返回 reason="aborted"，
          // 即使本地 signal 还没翻，也要把这次执行记成中止（调度层据此不合并）。
          aborted: signal?.aborted === true || result.reason === "aborted",
          reportRaw: reportRawOf(task),
          stderrTail: result.reason.slice(0, 2000),
          sessionId: null,
          error: result.ok ? null : result.reason,
        };
      } catch (error) {
        return {
          processOk: false,
          exitCode: null,
          timedOut: false,
          aborted: signal?.aborted === true,
          reportRaw: reportRawOf(task),
          stderrTail: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * 宿主池桥的 HTTP 客户端（manager 子进程用）。
 *
 * 为什么在 chancellor 里再写一份：宿主 supervisor 在 `apps/server`，chancellor 不能
 * 反向 import 宿主；而两边对池的契约本来就同形（方案 §5.2）。这里只实现
 * `run / say / abort` 三件事，SSE 解析与 supervisor 同口径：`data:` 行、`\n\n` 分帧。
 */
function createHttpPoolClient(endpoint: string, token: string): PoolClient {
  const base = endpoint.trim().replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${token}` };

  const postJson = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: Record<string, unknown> | null }> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = null;
    }
    return { status: res.status, data };
  };

  const abortTicket = async (ticketId: string): Promise<{ ok: boolean; message?: string }> => {
    try {
      const { status, data } = await postJson(
        `/run/${encodeURIComponent(ticketId)}/abort`,
        { ticketId },
      );
      if (status !== 200) {
        const message = typeof data?.message === "string" ? data.message : `http_${status}`;
        return { ok: false, message };
      }
      return { ok: true };
    } catch {
      return { ok: false, message: "请求失败" };
    }
  };

  return {
    async run(run, onEvent, signal) {
      const ticketId = run.ticketId;
      if (signal?.aborted) return { ok: false, reason: "aborted" };
      try {
        const { status, data } = await postJson("/run", run, signal);
        if (status === 409) return { ok: false, reason: "duplicate" };
        if (status === 429) return { ok: false, reason: "busy" };
        if (status !== 202 && status !== 200) {
          const message = typeof data?.message === "string" ? data.message : `http_${status}`;
          return { ok: false, reason: message };
        }
      } catch {
        return { ok: false, reason: signal?.aborted ? "aborted" : "run_post_failed" };
      }

      const controller = new AbortController();
      let sentAbort = false;
      const onAbort = (): void => {
        if (sentAbort) return;
        sentAbort = true;
        void abortTicket(ticketId);
        controller.abort();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      let settled: { ok: boolean; reason: string } | null = null;
      let cancelReader: (() => void) | null = null;
      try {
        const res = await fetch(`${base}/run/${encodeURIComponent(ticketId)}/events`, {
          headers: { ...auth, accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || res.body === null) {
          return { ok: false, reason: signal?.aborted ? "aborted" : "stream_closed" };
        }
        const reader = res.body.getReader();
        cancelReader = () => {
          void reader.cancel().catch(() => undefined);
        };
        const decoder = new TextDecoder();
        let buffer = "";
        while (settled === null) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = parseEventFrame(frame);
            if (event === null) continue;
            try {
              onEvent(event);
            } catch {
              // 订阅者异常不能反噬执行器
            }
            if (event.type === "settled") {
              settled = {
                ok: (event as { ok?: unknown }).ok === true,
                reason:
                  typeof (event as unknown as { reason?: unknown }).reason === "string"
                    ? ((event as unknown as { reason: string }).reason)
                    : "settled",
              };
              break;
            }
          }
        }
        if (settled === null && buffer.trim() !== "") {
          const event = parseEventFrame(buffer);
          if (event !== null) {
            try {
              onEvent(event);
            } catch {
              // 同上
            }
            if (event.type === "settled") {
              settled = {
                ok: (event as { ok?: unknown }).ok === true,
                reason:
                  typeof (event as unknown as { reason?: unknown }).reason === "string"
                    ? ((event as unknown as { reason: string }).reason)
                    : "settled",
              };
            }
          }
        }
      } catch {
        // 传输层失败：落到下面的断流收尾
      } finally {
        cancelReader?.();
        signal?.removeEventListener("abort", onAbort);
      }

      if (settled !== null) return settled;
      return { ok: false, reason: signal?.aborted ? "aborted" : "stream_closed" };
    },

    async say(ticketId, text, mode = "steer") {
      try {
        const { status, data } = await postJson(
          `/run/${encodeURIComponent(ticketId)}/say`,
          { ticketId, text, mode },
        );
        if (status !== 200) {
          const message = typeof data?.message === "string" ? data.message : `http_${status}`;
          return { ok: false, message };
        }
        return { ok: data?.ok !== false, ...(typeof data?.message === "string" ? { message: data.message } : {}) };
      } catch {
        return { ok: false, message: "请求失败" };
      }
    },

    abort: abortTicket,
  };
}

function parseEventFrame(frame: string): PoolClientEvent | null {
  let data = "";
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).replace(/^ /, "");
    data = data === "" ? value : `${data}\n${value}`;
  }
  if (data === "") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    if (typeof (parsed as { type?: unknown }).type !== "string") return null;
    return parsed as PoolClientEvent;
  } catch {
    return null;
  }
}