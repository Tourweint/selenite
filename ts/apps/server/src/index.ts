import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { MemoryScope } from "@lifediary/memory";
import {
  ChatRequestSchema,
  type ChatEvent,
  type FinishReason,
} from "@lifediary/shared";
import {
  addReminder,
  chatStream,
  listReminders,
  memoryEngine,
  openChat,
  usageSummary,
} from "./agent.ts";
import { createAuthMiddleware } from "./auth.ts";
import { debugPage } from "./debug-page.js";
import { mountOpenAiCompat } from "./openai-compat.ts";
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
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// 鉴权只作用于 API；调试页是静态 UI，真正的数据都要过 /api/v1
app.use("/api/v1/*", createAuthMiddleware(process.env.AGENT_TOKEN?.trim() || null));

// OpenAI 兼容端点：手机 App 已经在按这个协议说话，服务端适配比改客户端便宜
mountOpenAiCompat(app);

app.get("/", (c) => c.html(debugPage));

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
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    const send = (event: ChatEvent) =>
      stream.writeSSE({ data: JSON.stringify(event) });

    const startedAt = Date.now();
    let chars = 0;
    let finishReason: FinishReason = "stop";

    await send({ type: "start", id, conversationId: chat.externalId });

    try {
      for await (const text of chatStream({
        conversation: chat.conversation,
        text: lastUserText,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) {
          finishReason = "aborted";
          break;
        }
        chars += text.length;
        await send({ type: "delta", text });
      }
    } catch (error) {
      finishReason = "error";
      const detail = error instanceof Error ? error.message : String(error);
      // 原始错误只进服务端日志：里面可能带上游地址甚至 key 片段。
      console.error(`[chat ${id}] 生成失败: ${detail}`);
      await send({ type: "error", message: "生成失败，请稍后重试" }).catch(
        () => undefined,
      );
    }

    // 客户端先断开时这里会抛，属正常路径，吞掉。
    await send({ type: "done", id, finishReason }).catch(() => undefined);

    // 一轮结束：抽取 + 巩固。刻意不 await —— 记忆写慢了不该让回复变慢。
    if (memoryEngine && finishReason !== "aborted") {
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
    }

    // 只记行数/字数/耗时 —— 日志里绝不出现对话内容。
    console.log(
      `[chat ${id}] finish=${finishReason} chars=${chars} ms=${Date.now() - startedAt}`,
    );
  });
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
  const auth = process.env.AGENT_TOKEN?.trim()
    ? "令牌校验开启"
    : "未配 AGENT_TOKEN —— 仅本机可访问";
  console.log(`lifediary-ts server → http://127.0.0.1:${info.port}`);
  console.log(`  调试页: http://127.0.0.1:${info.port}/`);
  console.log(`  模式  : ${mode}`);
  console.log(`  鉴权  : ${auth}`);
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
