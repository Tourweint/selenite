import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { QueuedRun, TicketEvent } from "./run-queue.ts";

/**
 * 宿主池桥（2026-11-22「底层工人统一进池」）：把宿主 supervisor 包成一个
 * **只监听 127.0.0.1** 的 HTTP + SSE 面，给 manager 子进程用。
 *
 * 为什么需要：manager 子进程是独立进程，既不能 import 宿主，也拿不到
 * `setPoolClient()` 的内存注入。它的子单要进池，只能像池进程一样走 HTTP。
 *
 * 契约与 `pool-server.ts` 同形（`/run` + `/run/:id/events|say|abort`），
 * 这样 chancellor 侧的 HTTP 客户端一套语义通吃。差别只有一处：这里的 `/run`
 * 不排队到“本进程的 RunQueue”，而是直接交给 supervisor 去抢一个池槽位。
 *
 * 安全边界：只 bind 127.0.0.1；除 `/health` 外一律 Bearer token，失败 403 空体；
 * token 每次宿主启动随机生成，只经 env 交给 manager 子进程，不落盘、不进日志。
 */

export interface BridgePoolClient {
  run(
    run: QueuedRun,
    onEvent: (event: TicketEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; reason: string }>;
  say(ticketId: string, text: string, mode?: "steer" | "followUp"): Promise<{ ok: boolean; message?: string }>;
  abort(ticketId: string): Promise<{ ok: boolean; message?: string }>;
  snapshot?(): { slots: readonly unknown[]; running: string[] };
}

export interface PoolBridgeOptions {
  /**
   * supervisor 收到一票的 escalation 时回调（2026-11-22）：宿主据此把上报转发回
   * 父单来源会话，走既有的 escalate 路由。回调异常不影响票本身。
   */
  onEscalation?: (
    ticketId: string,
    escalation: Record<string, unknown>,
  ) => void;
  /** 观测行（缺省 console.error）；不记正文。 */
  onLog?: (line: string) => void;
}

export interface PoolBridge {
  endpoint: string;
  token: string;
  close: () => Promise<void>;
}

interface BridgeRun {
  readonly run: QueuedRun;
  readonly events: TicketEvent[];
  readonly listeners: Set<ServerResponse>;
  readonly abort: AbortController;
  settled: boolean;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUIRED_RUN_FIELDS = ["ticketId", "dir", "workDir", "instruction", "doneWhen"] as const;

export async function startPoolBridge(
  client: BridgePoolClient,
  options: PoolBridgeOptions = {},
): Promise<PoolBridge> {
  const token = randomUUID();
  const runs = new Map<string, BridgeRun>();
  const log = options.onLog ?? ((line: string) => console.error(line));

  const authorized = (req: IncomingMessage): boolean =>
    req.headers.authorization === `Bearer ${token}`;

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  const sendEmpty = (res: ServerResponse, status: number): void => {
    res.writeHead(status);
    res.end();
  };

  const writeEvent = (res: ServerResponse, event: TicketEvent): void => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // 客户端已断：由 close 事件清理
    }
  };

  const settle = (record: BridgeRun, event: TicketEvent): void => {
    if (record.settled) return;
    record.settled = true;
    record.events.push(event);
    for (const listener of [...record.listeners]) {
      writeEvent(listener, event);
      // 与池进程的 SSE 同语义：settled 即收流。不收会让 manager 的客户端
      // 一直挂着读（2026-11-22 桥自测抓到的真 hang）。
      try {
        listener.end();
      } catch {
        // 已断
      }
    }
    record.listeners.clear();
    log(
      `[pool-bridge] settle ticket=${record.run.ticketId.slice(0, 12)} ok=${
        (event as { ok?: unknown }).ok === true ? "1" : "0"
      } reason=${String((event as { reason?: unknown }).reason ?? "")}`,
    );
  };

  const execute = (record: BridgeRun): void => {
    const ticketId = record.run.ticketId;
    log(`[pool-bridge] dispatch ticket=${ticketId.slice(0, 12)}`);
    void client
      .run(record.run, (event) => {
        if (record.settled) return;
        if (event.type === "settled") {
          settle(record, event);
          return;
        }
        record.events.push(event);
        for (const listener of [...record.listeners]) writeEvent(listener, event);
        if (event.type === "escalation") {
          const escalation = (event as { escalation?: unknown }).escalation;
          if (escalation !== null && typeof escalation === "object") {
            try {
              options.onEscalation?.(ticketId, escalation as Record<string, unknown>);
            } catch (error) {
              log(
                `[pool-bridge] 上报转发异常 ticket=${ticketId.slice(0, 12)}: ${
                  error instanceof Error ? error.message.slice(0, 160) : "unknown"
                }`,
              );
            }
          }
        }
      }, record.abort.signal)
      .then((result) => {
        if (record.settled) return;
        settle(record, {
          type: "settled",
          ok: result.ok,
          reason: result.reason,
        });
      })
      .catch((error: unknown) => {
        if (record.settled) return;
        settle(record, {
          type: "settled",
          ok: false,
          reason: error instanceof Error ? error.message.slice(0, 200) : "bridge_error",
        });
      });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (path === "/health" && req.method === "GET") {
        const snapshot = client.snapshot?.();
        sendJson(res, 200, {
          ok: true,
          ...(snapshot ? { slots: snapshot.slots, running: snapshot.running } : {}),
        });
        return;
      }

      if (!authorized(req)) {
        sendEmpty(res, 403);
        return;
      }

      if (path === "/run" && req.method === "POST") {
        const parsed = parseRun(await readJson(req));
        if (!parsed.ok) {
          sendJson(res, 400, { ok: false, error: "bad_request", message: parsed.message });
          return;
        }
        const run = parsed.run;
        const existing = runs.get(run.ticketId);
        if (existing && !existing.settled) {
          sendJson(res, 409, { ok: false, error: "duplicate" });
          return;
        }
        const record: BridgeRun = {
          run,
          events: [],
          listeners: new Set(),
          abort: new AbortController(),
          settled: false,
        };
        runs.set(run.ticketId, record);
        sendJson(res, 202, { accepted: true, ticketId: run.ticketId });
        execute(record);
        return;
      }

      const eventMatch = /^\/run\/([^/]+)\/events$/.exec(path);
      if (eventMatch && req.method === "GET") {
        const ticketId = decodeURIComponent(eventMatch[1]!);
        const record = runs.get(ticketId);
        if (!record) {
          sendJson(res, 404, { ok: false, error: "not_found" });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const event of record.events) writeEvent(res, event);
        if (record.settled) {
          res.end();
          return;
        }
        record.listeners.add(res);
        const cleanup = (): void => {
          record.listeners.delete(res);
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
        return;
      }

      const sayMatch = /^\/run\/([^/]+)\/say$/.exec(path);
      if (sayMatch && req.method === "POST") {
        const ticketId = decodeURIComponent(sayMatch[1]!);
        const body = (await readJson(req)) as { text?: unknown; mode?: unknown } | null;
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) {
          sendJson(res, 400, { ok: false, error: "bad_request", message: "text 必须是非空字符串" });
          return;
        }
        const mode = body?.mode === "followUp" ? "followUp" : "steer";
        const result = await client.say(ticketId, text, mode);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      const abortMatch = /^\/run\/([^/]+)\/abort$/.exec(path);
      if (abortMatch && req.method === "POST") {
        const ticketId = decodeURIComponent(abortMatch[1]!);
        const record = runs.get(ticketId);
        record?.abort.abort();
        const result = await client.abort(ticketId);
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: "not_found" });
    })().catch((error: unknown) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // 已断
        }
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: "internal",
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}`;

  return {
    endpoint,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const record of runs.values()) record.abort.abort();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function parseRun(body: unknown): { ok: true; run: QueuedRun } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "body 必须是 JSON 对象" };
  }
  const raw = body as Record<string, unknown>;
  for (const field of REQUIRED_RUN_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, message: `${field} 必须是非空字符串` };
    }
  }
  for (const field of ["upstream", "model"] as const) {
    const value = raw[field];
    if (value !== undefined && typeof value !== "string") {
      return { ok: false, message: `${field} 必须是字符串` };
    }
  }
  const tools = raw.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((item) => typeof item !== "string"))) {
    return { ok: false, message: "tools 必须是字符串数组" };
  }
  let modelRoute: { baseUrl: string; keyEnv: string } | undefined;
  if (raw.modelRoute !== undefined) {
    const route = raw.modelRoute;
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      return { ok: false, message: "modelRoute 必须是对象" };
    }
    const record = route as Record<string, unknown>;
    const baseUrl = record.baseUrl;
    const keyEnv = record.keyEnv;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      return { ok: false, message: "modelRoute.baseUrl 必须是非空字符串" };
    }
    if (typeof keyEnv !== "string" || keyEnv.trim() === "") {
      return { ok: false, message: "modelRoute.keyEnv 必须是非空字符串" };
    }
    modelRoute = { baseUrl: baseUrl.trim().replace(/\/+$/, ""), keyEnv: keyEnv.trim() };
  }
  return {
    ok: true,
    run: {
      ticketId: raw.ticketId as string,
      dir: raw.dir as string,
      workDir: raw.workDir as string,
      instruction: raw.instruction as string,
      doneWhen: raw.doneWhen as string,
      ...(typeof raw.upstream === "string" ? { upstream: raw.upstream } : {}),
      ...(typeof raw.model === "string" ? { model: raw.model } : {}),
      ...(modelRoute ? { modelRoute } : {}),
      ...(Array.isArray(tools) ? { tools: tools as string[] } : {}),
    },
  };
}
