import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { hostname } from "node:os";
import QRCode from "qrcode";
import type { MemoryScope } from "@lifediary/memory";
import {
  ChatRequestSchema,
  type ChatEvent,
  type FinishReason,
} from "@lifediary/shared";
import {
  addReminder,
  chatStream,
  listChats,
  listReminders,
  memoryEngine,
  openChat,
  readTranscript,
  stopChat,
  usageSummary,
} from "./agent.ts";
import { createAuthMiddleware } from "./auth.ts";
import { debugPage } from "./debug-page.js";
import { mountDiary } from "./diary.ts";
import { mountOpenAiCompat } from "./openai-compat.ts";
import { PairingStore, buildPairUrl, resolvePairBase } from "./pairing.ts";
import { pairPage } from "./pair-page.ts";
import { readLlmConfig } from "./provider.ts";

// Node 20.12+ 自带 .env 加载；文件不存在时静默跳过，不让本地启动被环境文件卡住。
try {
  (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env, that's fine */
}

const app = new Hono();

// M0 只在本机/局域网跑，放开来源方便真机调试。
// 上公网前必须收紧成具体来源，否则等于把私人 Agent 敞开。
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    // X-Conversation-Id 是兼容层的会话绑定头，X-Task 是任务通道的任务名（原生客户端不发预检，但浏览器/WebView 会）
    allowHeaders: ["Content-Type", "Authorization", "X-Conversation-Id", "X-Task", "Accept"],
  }),
);

// 鉴权只作用于 API；调试页是静态 UI，真正的数据都要过 /api/v1
//
// 凭据两档（2026-10-29 配对）：共享令牌 `AGENT_TOKEN`（命令行/调试）+ 扫码换来的设备凭据。
// **配对的两个端点必须免鉴权**——手机在配对之前手里还没有任何凭据。
const pairing = new PairingStore();
const auth = createAuthMiddleware(process.env.AGENT_TOKEN?.trim() || null, {
  verifyDeviceToken: (token) => pairing.verifyDeviceToken(token),
});
const PAIR_OPEN_PATHS = new Set(["/api/v1/pair/info", "/api/v1/pair/redeem"]);
app.use("/api/v1/*", async (c, next) => {
  if (PAIR_OPEN_PATHS.has(c.req.path)) return next();
  return auth(c, next);
});

// redeem 限流：每 IP 每分钟 10 次（防有人对着 6 位码暴力枚举）
const redeemHits = new Map<string, { count: number; resetAt: number }>();
const REDEEM_PER_MINUTE = 10;
function redeemRateLimited(ip: string, now = Date.now()): boolean {
  const hit = redeemHits.get(ip);
  if (!hit || hit.resetAt <= now) {
    redeemHits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  hit.count += 1;
  return hit.count > REDEEM_PER_MINUTE;
}

// OpenAI 兼容端点：手机 App 已经在按这个协议说话，服务端适配比改客户端便宜
mountOpenAiCompat(app);

// 日记成稿镜像（2026-10-29）：独立库 .data/diary.sqlite，只收手机的推送，没有"在这里改日记"的入口
mountDiary(app);

app.get("/", (c) => c.html(debugPage));

// ── 配对（2026-10-29）：手机扫这一屏换设备凭据 ────────────────
const SERVER_VERSION = "0.1.0";

function currentPort(): number {
  return Number(process.env.PORT ?? 8082);
}

/** 配对页每次打开都换一枚新码（旧码立即作废，符合"一次性"语义） */
app.get("/pair", async (c) => {
  const { code, expiresAt } = pairing.issueCode();
  const url = buildPairUrl(resolvePairBase(currentPort()), code);
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  c.header("Cache-Control", "no-store");
  return c.html(
    pairPage({
      url,
      dataUrl,
      machineName: hostname(),
      expiresInSeconds: Math.max(1, Math.round((expiresAt - Date.now()) / 1000)),
    }),
  );
});

/** 探活：手机在兑换前先确认"这台机器在不在"（不含任何密钥） */
app.get("/api/v1/pair/info", (c) =>
  c.json({ name: hostname(), version: SERVER_VERSION, pairing: true }),
);

/** 出一枚新码（命令行/别的客户端用；调试页走 /pair 页面） */
app.post("/api/v1/pair/code", (c) => {
  const { code, expiresAt } = pairing.issueCode();
  return c.json({ code, expiresAt, url: buildPairUrl(resolvePairBase(currentPort()), code) });
});

/** 用码换设备凭据（免鉴权：手机此刻还没有任何凭据） */
app.post("/api/v1/pair/redeem", async (c) => {
  const ip = (() => {
    try {
      return getConnInfo(c).remote.address ?? "local";
    } catch {
      return "local";
    }
  })();
  if (redeemRateLimited(ip)) return c.json({ error: "too_many_attempts" }, 429);

  const body = (await c.req.json().catch(() => null)) as
    | { code?: string; deviceName?: string }
    | null;
  const code = body?.code?.trim();
  if (!code) return c.json({ error: "bad_request" }, 400);

  const result = pairing.redeem(code, body?.deviceName?.trim() || "手机");
  if (typeof result === "string") {
    const status =
      result === "unknown_code"
        ? 404
        : result === "code_used"
          ? 409
          : result === "code_expired"
            ? 410
            : 429;
    return c.json({ error: result }, status);
  }
  console.log(`[pair] 新设备已配对（${ip}），当前共 ${pairing.listDevices().length} 台`);
  return c.json({ deviceToken: result.deviceToken, name: hostname(), version: SERVER_VERSION });
});

app.get("/api/v1/pair/devices", (c) => c.json(pairing.listDevices()));

app.post("/api/v1/pair/devices/:id/revoke", (c) =>
  pairing.revokeDevice(c.req.param("id"))
    ? c.json({ ok: true })
    : c.json({ error: "unknown_device" }, 404),
);

/** 会话索引（只元数据，供手机重装后重建历史列表） */
app.get("/api/v1/agent/chats", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({ chats: await listChats(Number.isFinite(limit) ? limit : 50) });
});

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    llm: readLlmConfig() ? "upstream" : "mock",
  }),
);

app.post("/api/v1/agent/chat", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
  }
  const request = parsed.data;

  // 未配置模型时走 mock：链路能验证，但不建会话、不写库。
  if (!readLlmConfig()) {
    return streamMock(c, request.messages);
  }

  // 会话 id 只能由服务端发出去：不带 = 新建，带了就必须是发过的那个。
  // durable 内部用的是自增整数，对外仍然映射成 uuid —— 整数猜得到，uuid 猜不到。
  const requestedId = request.conversationId;
  const chat = await openChat(requestedId).catch((error: unknown) => {
    console.error(`[chat] 打开会话失败: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (!chat) {
    return c.json({ error: "unknown_conversation", message: "会话不存在，请不带 conversationId 新建" }, 404);
  }

  const lastUserText =
    [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const scope: MemoryScope = { type: "session", id: String(chat.internalId) };

  return streamSSE(c, async (stream) => {
    const id = crypto.randomUUID();

    const send = (event: ChatEvent) =>
      stream.writeSSE({ data: JSON.stringify(event) });

    const startedAt = Date.now();
    let chars = 0;
    // 这里只说"这条流怎么结束的"，不代表那一轮怎么结束的
    let streamEnd: FinishReason = "stop";

    await send({ type: "start", id, conversationId: chat.externalId });

    try {
      for await (const event of chatStream({
        conversation: chat.conversation,
        text: lastUserText,
        requestId: request.requestId,
        // 记忆挂在"这一轮真的结束"上，不挂在"这条流结束"上：
        // 用户关掉界面之后它还会跑完，那一轮的记忆照样得写。
        onSettled: (record) => {
          if (!memoryEngine || record.status !== "done") return;
          // 刻意不 await —— 记忆写慢了不该拖慢任何东西
          void memoryEngine
            .ingestTurn(request.messages, scope)
            .then((result) => {
              if (result.added.length > 0 || result.reinforced.length > 0) {
                console.log(
                  `[chat ${id}] memory +${result.added.length} ~${result.reinforced.length}`,
                );
              }
            })
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              console.error(`[chat ${id}] 记忆写入失败: ${detail}`);
            });
        },
      })) {
        // 客户端走了：只停止推送。那一轮还在服务端跑完并落库，
        // 下次打开用 GET .../messages 拿回来。
        if (stream.aborted) {
          streamEnd = "aborted";
          break;
        }
        if (event.type === "progress") {
          // 阶段变化只对兼容层的客户端有意义；自有 SSE 协议不加新事件，避免破坏老客户端
          continue;
        }
        if (event.type === "delta") {
          chars += event.text.length;
          await send({ type: "delta", text: event.text });
          continue;
        }
        // 工具调用撞上限：这一轮没有回答，但已经做过的工具结果都保留
        streamEnd = "error";
        await send({ type: "error", message: event.message }).catch(() => undefined);
      }
    } catch (error) {
      streamEnd = "error";
      const detail = error instanceof Error ? error.message : String(error);
      // 原始错误只进服务端日志：里面可能带上游地址甚至 key 片段。
      console.error(`[chat ${id}] 生成失败: ${detail}`);
      await send({ type: "error", message: "生成失败，请稍后重试" }).catch(
        () => undefined,
      );
    }

    // 客户端已断开时这里会抛，属正常路径，吞掉。
    await send({ type: "done", id, finishReason: streamEnd }).catch(() => undefined);

    // 只记行数/字数/耗时 —— 日志里绝不出现对话内容。
    console.log(
      `[chat ${id}] stream=${streamEnd} chars=${chars} ms=${Date.now() - startedAt}`,
    );
  });
});

/**
 * 读会话历史。
 *
 * 一轮对话现在可以在没有客户端看着的情况下跑完，所以客户端下次打开必须能把结果拉回来 ——
 * 否则"关掉界面它照样跑完"对用户没有意义。
 */
app.get("/api/v1/agent/chat/:conversationId/messages", async (c) => {
  if (!readLlmConfig()) return c.json({ messages: [] });

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  const limit = Number(c.req.query("limit") ?? 50);
  const messages = await readTranscript(chat, Number.isFinite(limit) ? limit : 50);
  return c.json({ conversationId: chat.externalId, messages });
});

/**
 * 手动停止当前这一轮。
 *
 * 跟"客户端断开"是两件事：这是人的明确意图。停了之后再说一句话就是新一轮。
 */
app.post("/api/v1/agent/chat/:conversationId/stop", async (c) => {
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  await stopChat(chat);
  return c.json({ ok: true, conversationId: chat.externalId });
});

/** 用量与花费：按模型累计，来自 durable 自己维护的 pi.usage */
app.get("/api/v1/agent/usage", async (c) => {
  if (!readLlmConfig()) return c.json({ models: [] });
  return c.json(await usageSummary());
});

/** 还没响的提醒（读 durable 的任务图） */
app.get("/api/v1/agent/reminders", async (c) => {
  if (!readLlmConfig()) return c.json({ reminders: [] });
  return c.json({ reminders: await listReminders() });
});

/** 直接加一个提醒，不经过模型 */
app.post("/api/v1/agent/reminders", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { conversationId?: string; text?: string; at?: string | number }
    | null;
  const text = body?.text?.trim();
  if (!text || !body?.at) {
    return c.json({ error: "bad_request", message: "需要 text 和 at" }, 400);
  }
  const at = typeof body.at === "number" ? body.at : Date.parse(body.at);
  if (!Number.isFinite(at)) {
    return c.json({ error: "bad_request", message: "at 需要 ISO 时间或毫秒时间戳" }, 400);
  }
  if (at <= Date.now()) {
    return c.json({ error: "bad_request", message: "at 已经过去了" }, 400);
  }

  const chat = await openChat(body.conversationId);
  if (!chat) {
    return c.json({ error: "unknown_conversation" }, 404);
  }
  const taskId = await addReminder(chat, { text, at });
  return c.json({ ok: true, taskId, conversationId: chat.externalId }, 201);
});

const port = Number(process.env.PORT ?? 8082);

serve({ fetch: app.fetch, port }, (info) => {
  const mode = readLlmConfig() ? "真实上游" : "mock（未配置 LLM_API_KEY）";
  const authLabel = process.env.AGENT_TOKEN?.trim()
    ? "共享令牌 + 配对设备凭据"
    : "未配 AGENT_TOKEN —— 仅本机 / 已配对设备可访问";
  console.log(`lifediary-ts server → http://127.0.0.1:${info.port}`);
  console.log(`  调试页: http://127.0.0.1:${info.port}/`);
  console.log(`  配对  : http://127.0.0.1:${info.port}/pair   ← 手机扫这一屏`);
  console.log(`  模式  : ${mode}`);
  console.log(`  鉴权  : ${authLabel}`);
});

export { app };

/** 未配置 key 时的回显流：证明 SSE 通路、首字节时机、中止行为都正常。 */
function streamMock(c: Context, messages: { role: string; content: string }[]) {
  const conversationId = crypto.randomUUID();
  const last = messages.at(-1)?.content ?? "";
  const reply =
    `（mock 模式，未配置 LLM_API_KEY）链路已通。你说的是：「${last}」。` +
    `配置 LLM_API_KEY 后这里会换成真实模型输出。`;

  return streamSSE(c, async (stream) => {
    const id = crypto.randomUUID();
    await stream.writeSSE({
      data: JSON.stringify({ type: "start", id, conversationId } satisfies ChatEvent),
    });
    for (const char of reply) {
      if (stream.aborted) return;
      await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: char } satisfies ChatEvent) });
      await new Promise((resolve) => setTimeout(resolve, 18));
    }
    await stream
      .writeSSE({ data: JSON.stringify({ type: "done", id, finishReason: "stop" } satisfies ChatEvent) })
      .catch(() => undefined);
  });
}
