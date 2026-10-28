import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  createMemoryEngine,
  scopeKey,
  type MemoryEngine,
  type MemoryScope,
} from "@lifediary/memory";
import {
  ChatRequestSchema,
  type ChatEvent,
  type FinishReason,
} from "@lifediary/shared";
import { debugPage } from "./debug-page.js";
import { readLlmConfig, streamChat } from "./provider.js";

// Node 20.12+ 自带 .env 加载；文件不存在时静默跳过，不让本地启动被环境文件卡住。
try {
  (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env, that's fine */
}

/**
 * 记忆库是进程级单例：SQLite 不适合每请求开关。
 * 初始化失败时降级为"无记忆"而不是拒绝启动 —— 记忆是增强，不是前置依赖。
 */
const memory: MemoryEngine | null = (() => {
  if (process.env.MEMORY_ENABLED === "false") return null;
  try {
    return createMemoryEngine({ dbPath: process.env.MEMORY_DB_PATH });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`记忆库初始化失败，本次以无记忆运行: ${detail}`);
    return null;
  }
})();

/** 召回失败绝不能让对话失败，所以一律吞掉并降级为空上下文。 */
function recallContext(engine: MemoryEngine | null, text: string, scope: MemoryScope): string {
  if (!engine || !text.trim()) return "";
  try {
    return engine.buildContext({ text, scopes: ["global", scopeKey(scope)] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`记忆召回失败，本轮不使用记忆: ${detail}`);
    return "";
  }
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

  // 记忆作用域：本会话 + 全局画像。日记场景以后会再加 day:<date>。
  const conversationId = request.conversationId ?? "default";
  const scope: MemoryScope = { type: "session", id: conversationId };
  const lastUserText =
    [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const memoryContext = recallContext(memory, lastUserText, scope);

  return streamSSE(c, async (stream) => {
    const id = crypto.randomUUID();
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    const send = (event: ChatEvent) =>
      stream.writeSSE({ data: JSON.stringify(event) });

    const startedAt = Date.now();
    let chars = 0;
    let finishReason: FinishReason = "stop";

    await send({ type: "start", id });

    try {
      for await (const text of streamChat({
        messages: request.messages,
        conversationId,
        systemContext: memoryContext,
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
      console.error(`[chat ${id}] upstream failed: ${detail}`);
      await send({ type: "error", message: "上游调用失败，请稍后重试" }).catch(
        () => undefined,
      );
    }

    // 客户端先断开时这里会抛，属正常路径，吞掉。
    await send({ type: "done", id, finishReason }).catch(() => undefined);

    // 一轮结束：抽取 + 巩固。刻意不 await —— 记忆写慢了不该让回复变慢。
    if (memory) {
      void memory
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
      `[chat ${id}] finish=${finishReason} chars=${chars} memCtx=${memoryContext.length} ms=${Date.now() - startedAt}`,
    );
  });
});

const port = Number(process.env.PORT ?? 8082);

serve({ fetch: app.fetch, port }, (info) => {
  const mode = readLlmConfig() ? "真实上游" : "mock（未配置 LLM_API_KEY）";
  console.log(`lifediary-ts server → http://127.0.0.1:${info.port}`);
  console.log(`  调试页: http://127.0.0.1:${info.port}/`);
  console.log(`  模式  : ${mode}`);
});
