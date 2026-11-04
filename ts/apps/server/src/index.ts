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
  type TurnUsage,
} from "@lifediary/shared";
import {
  addReminder,
  applyChatMode,
  chatMetaSummary,
  chatStream,
  contextUsageOf,
  getPolicy,
  hideChat,
  listChats,
  listReminders,
  memoryEngine,
  openChat,
  pinChat,
  readTranscript,
  renameChat,
  restoreChats,
  sayInChat,
  searchTranscripts,
  setPolicy,
  stopChat,
  usageSummary,
} from "./agent.ts";
import { createAuthMiddleware } from "./auth.ts";
import { mountDiary } from "./diary.ts";
import { mountOpenAiCompat } from "./openai-compat.ts";
import { PairingStore, buildPairUrl, resolvePairBase } from "./pairing.ts";
import { pairPage } from "./pair-page.ts";
import { mountPhoneWorker } from "./phone-worker.ts";
import { mountProjects } from "./projects.ts";
import { mountDelegationApi } from "./delegation-api.ts";
import { mountWeb } from "./web.ts";
import { mountWorkerShell } from "./worker-shell.ts";
import { syncDiaryToMemory } from "./memory-ingest.ts";
import { readLlmConfig, runtimeModelInfo, setRuntimeModel } from "./provider.ts";
import { chancellorWorkRoot } from "./delegation.ts";
import { recoverDelegations } from "../../../../../chancellor/src/index.ts";

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

// 手机 worker 通道（2026-11-02）：poll / model / result，鉴权沿用上面的 /api/v1/* 中间件
mountPhoneWorker(app);

// 受限 shell（2026-11-02 第四个接口）：只放行虚拟屏需要的那几种 adb shell 形状
mountWorkerShell(app);

// 项目与工作区（2026-11-03 方案 §5.5）：派单前置。新建项目根目录只提交待确认请求，
// 用户在设置页确认后才建目录、登记。界面上线前用 HTTP 也能完成同一流程。
mountProjects(app);

// 任务中心只读接口（2026-11-03 方案 §5.9）：领域列表 + 单 ticket 明细。
mountDelegationApi(app);

// 界面（2026-11-03）：原来那张 M0 调试页换成了真界面，仍然是同源静态文件。
// 桌面壳和浏览器打开的都是这个 `/`。
mountWeb(app);

// ── 配对（2026-10-29）：手机扫这一屏换设备凭据 ────────────────
const SERVER_VERSION = "0.1.0";

function currentPort(): number {
  return Number(process.env.PORT ?? 8082);
}

/**
 * 配对码的 JSON 版（2026-11-03）：桌面端要在自己的设置页里显示二维码，
 * 而 `/pair` 返回的是一整张 HTML。同一个码、同一个来源，只是换个格式。
 */
app.get("/api/v1/pair/qr", async (c) => {
  const { code, expiresAt } = pairing.issueCode();
  const url = buildPairUrl(resolvePairBase(currentPort()), code);
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  c.header("Cache-Control", "no-store");
  return c.json({
    url,
    dataUrl,
    machineName: hostname(),
    expiresInSeconds: Math.max(1, Math.round((expiresAt - Date.now()) / 1000)),
  });
});

/** 已配对的设备（桌面设置页要看「有哪些手机连着」）。凭据哈希不外泄。 */
app.get("/api/v1/pair/devices", (c) => {
  const devices = pairing.listDevices().map((device) => ({
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt ?? null,
    revoked: Boolean(device.revokedAt),
  }));
  return c.json({ devices });
});

/** 撤掉一台设备（CORS 只放 GET/POST，所以用 POST 而不是 DELETE） */
app.post("/api/v1/pair/devices/:id/revoke", (c) => {
  const ok = pairing.revokeDevice(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ ok: false }, 404);
});

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
  const chats = await listChats(Number.isFinite(limit) ? limit : 50);
  return c.json({ chats, removed: chatMetaSummary().hidden });
});

/**
 * 会话改名 / 从列表移除（2026-11-03）。
 *
 * durable 没有标题和删除的概念，所以这两件事只写我们自己的 `chat-meta.json`：
 * 改名不影响内核；「移除」只是不在列表里出现，会话与记忆都还在。
 */
app.post("/api/v1/agent/chat/:conversationId/rename", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { title?: string } | null;
  const title = body?.title ?? "";
  return c.json({ ok: true, ...renameChat(c.req.param("conversationId"), title) });
});

app.post("/api/v1/agent/chat/:conversationId/hide", (c) => {
  hideChat(c.req.param("conversationId"));
  return c.json({ ok: true });
});

app.post("/api/v1/agent/chats/restore", (c) => c.json({ ok: true, restored: restoreChats() }));

/** 置顶 / 取消置顶（2026-11-04 批次一）：只影响列表顺序，写 chat-meta，不碰会话本身 */
app.post("/api/v1/agent/chat/:conversationId/pin", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { pinned?: boolean } | null;
  const pinned = body?.pinned !== false;
  return c.json({ ok: true, pinned: pinChat(c.req.param("conversationId"), pinned) });
});

/**
 * 访问档位（2026-11-03）：完全访问 / 只读 / 不跑命令。
 * 改完立刻生效——beforeTool 每次调用都重新判断，不用重启服务。
 */
app.get("/api/v1/agent/policy", (c) => c.json(getPolicy()));

app.post("/api/v1/agent/policy", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { access?: string; blocked?: string[] }
    | null;
  const access = body?.access;
  if (access && access !== "full" && access !== "read-only" && access !== "no-shell") {
    return c.json({ error: "bad_request", message: "access 只能是 full / read-only / no-shell" }, 400);
  }
  const next = setPolicy({
    ...(access ? { access: access as "full" | "read-only" | "no-shell" } : {}),
    ...(Array.isArray(body?.blocked) ? { blocked: body!.blocked! } : {}),
  });
  return c.json({ ok: true, ...next });
});

/** 快档 / 深档（同一个模型，区别只在思考开关） */
app.post("/api/v1/agent/chat/:conversationId/mode", async (c) => {
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);
  const body = (await c.req.json().catch(() => null)) as { mode?: string } | null;
  const mode = body?.mode === "deep" ? "deep" : body?.mode === "fast" ? "fast" : null;
  if (!mode) return c.json({ error: "bad_request", message: "mode 只能是 fast / deep" }, 400);

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);
  await applyChatMode(chat, mode);
  return c.json({ ok: true, mode });
});


app.get("/healthz", (c) => {
  // model/models 是给设置页「服务」分区的（2026-11-04）：当前模型 + 可切清单。
  // mock 时 model=null；faux 时 model="faux"、清单为空——两种都不可切。
  const info = runtimeModelInfo();
  return c.json({
    ok: true,
    llm: info.model ? "upstream" : "mock",
    model: info.model,
    models: info.models,
  });
});

/**
 * 运行时切换模型（2026-11-04，接口文档 §2.8）：改的是覆盖值，env 是出厂默认；
 * 下一轮对话生效，校验与持久化都在 provider.ts 的 setRuntimeModel 里。
 */
app.post("/api/v1/agent/model", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { model?: string } | null;
  const model = body?.model?.trim();
  if (!model) return c.json({ error: "bad_request", message: "需要 model" }, 400);

  const result = setRuntimeModel(model);
  if (!result.ok) {
    const status = result.reason === "llm_not_configured" ? 503 : 400;
    return c.json({ error: result.reason, message: result.message }, status);
  }
  // 模型 id 不是对话内容，可以进日志
  console.log(`[model] 运行时切换 → ${result.model}`);
  return c.json({ ok: true, model: result.model, models: result.models });
});

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
    // chatStream 在收尾时吐的内部用量事件，挂到 done.usage 上（2026-11-04 批次一）
    let turnUsage: TurnUsage | undefined;

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
        if (
          event.type === "progress" ||
          event.type === "tool" ||
          // 2026-11-03：派单进度与「需要你」也透传。前端靠 ticketId/domain/phase
          // 把多张单分开归并；老客户端按 type 分发，认不出的类型直接忽略。
          event.type === "delegate" ||
          event.type === "attention" ||
          // 思考正文增量（2026-11-04 批次一），同属纯增量事件
          event.type === "thinking"
        ) {
          await send(event as unknown as ChatEvent);
          continue;
        }
        if (event.type === "delta") {
          chars += event.text.length;
          await send({ type: "delta", text: event.text });
          continue;
        }
        // 本轮 token 用量（内部事件）：不单独发帧，挂到收尾的 done.usage 上
        if (event.type === "usage") {
          turnUsage = event.usage;
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
    await send({
      type: "done",
      id,
      finishReason: streamEnd,
      ...(turnUsage ? { usage: turnUsage } : {}),
    }).catch(() => undefined);

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

/**
 * 让助手**在新会话里**主动说一句（2026-11-01，回顾页钩子：「每次尽量都出一个新对话」）。
 *
 * 与下面 `:id/say` 的区别：这里不带会话 id，服务端**新建**一个会话再把话说进去，
 * 返回新会话的 id 给客户端绑定。用户没接话的话，客户端会把这段空对话清掉。
 */
app.post("/api/v1/agent/say", async (c) => {
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);

  const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) return c.json({ error: "bad_request", message: "需要 text" }, 400);

  const chat = await openChat(undefined);
  if (!chat) return c.json({ ok: false, reason: "conversation_not_created" }, 503);

  await sayInChat(chat, text);
  return c.json({ ok: true, conversationId: chat.externalId }, 201);
});

/**
 * 让助手主动说一句话（2026-11-01，手机端回顾页钩子）。
 *
 * 与 `/chat` 的区别：**不调模型、不产生用户消息**，只把这句话以 assistant 身份写进会话，
 * 之后的回读/后续对话都能看到。手机端点回顾页的钩子卡片就走这里。
 */
app.post("/api/v1/agent/chat/:conversationId/say", async (c) => {
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) return c.json({ error: "bad_request", message: "需要 text" }, 400);

  await sayInChat(chat, text);
  return c.json({ ok: true, conversationId: chat.externalId }, 201);
});

/** 用量与花费：按模型累计，来自 durable 自己维护的 pi.usage */
app.get("/api/v1/agent/usage", async (c) => {
  if (!readLlmConfig()) return c.json({ models: [] });
  return c.json(await usageSummary());
});

/** 上下文占用（批次二）：给标题栏「已用/窗口」徽标用；mock 下两者皆 null */
app.get("/api/v1/agent/chat/:conversationId/context", async (c) => {
  if (!readLlmConfig()) return c.json({ used: null, window: null });
  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);
  return c.json(await contextUsageOf(chat.conversation));
});

/** 内容级跨会话搜索（批次二）：逐会话 LIKE，q 最少 2 字符（见接口文档 §2.5） */
app.get("/api/v1/agent/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (q.trim().length < 2) return c.json({ hits: [] });
  if (!readLlmConfig()) return c.json({ hits: [] });
  return c.json({ hits: await searchTranscripts(q, 20) });
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
  // 2026-10-31：启动即把日记镜像里的近况摄入记忆（幂等 upsert）。
  // 目的不是"启动时干活"，而是让记忆库**一开始就有东西**——之前它是空的，
  // 注入点接好了也注入不出内容（记忆方案 §0 记的就是这个坑）。
  try {
    const ingested = syncDiaryToMemory(3, { force: true });
    if (ingested > 0) console.log(`[memory] 启动摄入日记 ${ingested} 条`);
  } catch (error) {
    console.warn(`[memory] 启动摄入失败（不影响服务）: ${error instanceof Error ? error.message : error}`);
  }
  // 2026-11-04：派单崩溃恢复。只结算上一进程留下的 inflight 单：
  // 没跨合并点的自动续一次，跨过的转「待你处理」。只记计数，不记内容。
  void recoverDelegations(chancellorWorkRoot(), { log: (line) => console.log(line) })
    .then((summary) => {
      if (summary.scanned > 0) {
        console.log(
          `[恢复] 扫描 ${summary.scanned}：仍在跑 ${summary.stillRunning}，已终态 ${summary.finished}，自动续跑 ${summary.resumed}，转待你处理 ${summary.needsYou}，未知 ${summary.unknown}`,
        );
      }
    })
    .catch((error: unknown) => {
      console.warn(
        `[恢复] 启动恢复失败（不影响服务）: ${error instanceof Error ? error.message : error}`,
      );
    });
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
  // 回复里带代码块 + 表格：界面渲染（高亮/复制按钮/markdown/表格）在无 key 环境也有得验
  const codeExample = [
    "",
    "顺便验证代码块的渲染与复制：",
    "",
    "```js",
    "const greeting = \"你好\"; // 注释也会上色",
    "function hi(name) {",
    "  return `${greeting}，${name}！`;",
    "}",
    "```",
    "",
    "顺便验证表格渲染（批次二）：",
    "",
    "| 能力 | 状态 |",
    "| --- | --- |",
    "| 代码块 | 上色 + 复制 |",
    "| 表格 | 你正在看 |",
    "",
  ].join("\n");
  const reply =
    `（mock 模式，未配置 LLM_API_KEY）链路已通。你说的是：「${last}」。` +
    `配置 LLM_API_KEY 后这里会换成真实模型输出。${codeExample}`;

  return streamSSE(c, async (stream) => {
    const id = crypto.randomUUID();
    await stream.writeSSE({
      data: JSON.stringify({ type: "start", id, conversationId } satisfies ChatEvent),
    });
    // 思考事件也走一遍（2026-11-04 批次一）：mock 的职责是让链路可验，
    // 客户端的 thinking 折叠卡没有这段就没法在无 key 环境里测。
    const thinkingText = "（mock）这是一段思考过程的示例文本：先理解问题，再组织回答。";
    await stream
      .writeSSE({ data: JSON.stringify({ type: "thinking", text: thinkingText } satisfies ChatEvent) })
      .catch(() => undefined);
    for (const char of reply) {
      if (stream.aborted) return;
      await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: char } satisfies ChatEvent) });
      await new Promise((resolve) => setTimeout(resolve, 18));
    }
    await stream
      .writeSSE({
        data: JSON.stringify({
          type: "done",
          id,
          finishReason: "stop",
          // 数字仅供链路验证，不代表真实计费
          usage: { input: 12, output: Math.max(1, Math.round(reply.length / 2)), cacheRead: 0 },
        } satisfies ChatEvent),
      })
      .catch(() => undefined);
  });
}
