import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import QRCode from "qrcode";
import {
  ChatRequestSchema,
  ThinkingLevelSchema,
  type ChatEvent,
  type FinishReason,
  type ThinkingLevel,
  type TurnUsage,
} from "@lifediary/shared";
import { scopeKey } from "@lifediary/memory";
import {
  addReminder,
  applyChatMode,
  chatKindOf,
  chatMetaSummary,
  chatStream,
  chatTitles,
  contextUsageOf,
  externalChatIds,
  forkForEdit,
  getPolicy,
  hideChat,
  listChats,
  listReminders,
  memoryEngine,
  openChat,
  pinChat,
  preferenceScopeOf,
  readTranscript,
  renameChat,
  restoreChats,
  sayInChat,
  sayInConversation,
  seedChiefPartner,
  setTurnSettledObserver,
  startChatCompaction,
  turnSettledHandler,
  waitChatCompaction,
  searchTranscripts,
  setPolicy,
  stopChat,
  usageSummary,
  workerChatEnabled,
} from "./agent.ts";
import {
  assembleUserContent,
  attachmentsEnabled,
  editResendEnabled,
} from "./attachments.ts";
import { createAuthMiddleware } from "./auth.ts";
import { ChatEventStore, sseSeqEnabled } from "./chat-events.ts";
// stream_stalled 看门狗（2026-11-09 任务书 T3 §4）：只记账，不改行为、不中断。
import { stallWatchdog } from "./watchdog.ts";
import { mountDiary } from "./diary.ts";
import { mountOpenAiCompat } from "./openai-compat.ts";
import { PairingStore, buildPairUrl, resolvePairBase } from "./pairing.ts";
import { pairPage } from "./pair-page.ts";
import { mountPhoneWorker } from "./phone-worker.ts";
import { mountProjects, seedDefaultWorkspace } from "./projects.ts";
import { loadFlagOverrides, mountFlags } from "./flags.ts";
import { mountFiles } from "./files.ts";
import { mountDelegationApi } from "./delegation-api.ts";
import { mountCompanions } from "./companion-api.ts";
import { mountGroups } from "./group-api.ts";
// 长期课题（2026-11-07 批次一）：列表 / 详情 / 改节奏 / 暂停 / 关闭 / 立即研究 / 提议确认。
// TOPICS_ENABLED=false 时 mountTopics 内部直接返回，整组路由 404（同 COMPANIONS 口径）。
import { mountTopics } from "./topic-api.ts";
// 搜索配置（2026-11-07 长期课题跟进 S2）：设置页直填 DeepSeek 搜索 key + 连接测试。
import { mountSearch } from "./search-api.ts";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { ensurePartnerSession } from "./partner-runtime.ts";
import { routineEngine } from "./routines.ts";
import { watchAllEvents } from "./agent.ts";
import { autonomyMode, autonomyObserver, observeCount24h } from "./autonomy.ts";
import { mountApprovalApi } from "./approval-api.ts";
import { mountMemoryApi } from "./memory-api.ts";
// 技能管理（2026-11-08 扫尾批 9-S）：设置页「技能」分区的增删改查，写操作锁死在技能目录内。
// SKILLS_ADMIN=false 时 mountSkills 内部直接返回，整组路由 404（同 TOPICS/COMPANIONS 口径）。
import { mountSkills } from "./skills-api.ts";
import { mountWeb } from "./web.ts";
import { mountWorkerShell } from "./worker-shell.ts";
import { syncDiaryToMemory } from "./memory-ingest.ts";
import { RelayClient } from "./relay-client.ts";
import { RelayChannelHub, type RelayChannelDeps } from "./relay-channels.ts";
import {
  relayEnabled,
  relaySettings,
  deviceMatrixEnabled,
  deviceAutoDispatchEnabled,
  companionHomeEnabled,
} from "./relay-config.ts";
import { companionHomeController, type CompanionHomeController } from "./relay-home.ts";
import { mountRelayMobileProxy } from "./relay-mobile-proxy.ts";
import { createMatrixChannels, dispatchRemoteDelegation, listRemoteDelegations } from "./relay-matrix.ts";
import { RelayInvokeError } from "./relay-client.ts";
import { approvalStore } from "./approvals.ts";
import {
  currentThinkingLevels,
  detectProviderModel,
  modelCatalog,
  providerCatalog,
  readLlmConfig,
  removeProvider,
  runtimeModelInfo,
  saveProvider,
  scheduleThinkingProbe,
  setProviderSecret,
  setRuntimeModel,
} from "./provider.ts";
import { injectProviderKeys } from "./provider-secrets.ts";
// 会话导出「接续文件」（2026-11-10 批 20 §一）：拼接是纯函数，正文只在响应体里出现。
import {
  buildHandoff,
  chatExportHandoffEnabled,
  HANDOFF_MEMORY_LIMIT,
  handoffFileName,
  parseHandoffLimit,
  type HandoffMemory,
} from "./chat-handoff.ts";
// 旧会话定点找回（2026-11-10 批 20 §四）：按消息下标取窗口，不改内核加 seq。
import {
  chatContextLookupEnabled,
  contextMessageOf,
  parseAroundIndex,
  parseContextRadius,
  sliceAroundIndex,
} from "./chat-context.ts";
import { chancellorWorkRoot } from "./delegation.ts";
import { DelegationReceipts } from "./delegation-receipts.ts";
import {
	collectDeadLetters,
	recoverReportEnabled,
	reportRecoveredTickets,
	type DeadLetterChild,
} from "./recovery-report.ts";
import { recoverDelegations, type RecoveredTicket } from "../../../../../chancellor/src/index.ts";
// 恢复注记（2026-11-09 任务书 T3 §5）：只有进程内记账，无存储依赖。
import { markRecoverResume, recoverNoteEnabled } from "./agent/recover-note.ts";
import { Store } from "../../../../../chancellor/src/store.ts";
import { listManagers } from "../../../../../chancellor/src/manager/registry.ts";

// Node 20.12+ 自带 .env 加载；文件不存在时静默跳过，不让本地启动被环境文件卡住。
try {
  (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env, that's fine */
}

// 2026-11-05 密钥直填：启动时把 .data/provider-keys.json 注入进程 env。
// 必须放在 loadEnvFile 之后、任何模型配置读取之前——手写 .env / 部署 env 的已有值优先。
injectProviderKeys();

// 界面高级开关（2026-11-09）：.data/agent-flags.json 里用户改过的开关覆盖 env。
// 必须放在路由挂载之前——挂载期的开关（执事/群组/课题/技能管理）要吃到覆盖值。
loadFlagOverrides();

const app = new Hono();

/** 服务端错误日志落点：桌面壳拉起进程时没有终端，文件是唯一能回看的地方。 */
const SERVER_ERROR_LOG = process.env.AGENT_ERROR_LOG?.trim() || ".data/server-errors.log";

/** 追加一行错误（尽力而为：写不进去只 warn，绝不能因为记日志再把请求搞挂）。 */
function appendServerError(line: string): void {
  try {
    mkdirSync(dirname(SERVER_ERROR_LOG), { recursive: true });
    appendFileSync(SERVER_ERROR_LOG, line);
  } catch (error) {
    console.warn(`[error] 写 ${SERVER_ERROR_LOG} 失败: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * 未捕获错误的统一出口（2026-11-07）。
 *
 * 两个理由：
 * 1. **看得见**：Hono 默认只 `console.error` 一行，而桌面壳是 `cmd.Start()` 起的、
 *    没有重定向 stdout/stderr，服务端日志根本没人收——"页面 500"于是变成无头案。
 *    这里把错误追加到 `.data/server-errors.log`（只记时间/方法/路径/错误与栈，
 *    不记请求体与对话内容），出问题时能直接查。
 * 2. **说得清**：500 空体让前端只能显示"读历史失败：500"。这里回一个 `internal_error`
 *    加一句稳定的说明，前端能把它当"服务端内部错误"处理，而不是当成历史丢了。
 *    错误细节（message/stack）只进服务端日志，不下发客户端——它可能带上游地址或路径。
 */
app.onError((error, c) => {
  const message = error instanceof Error ? error.message : String(error);
  const at = new Date().toISOString();
  const line = `${at} ${c.req.method} ${c.req.path} :: ${message}\n${
    error instanceof Error && error.stack ? `${error.stack}\n` : ""
  }`;
  console.error(`[error] ${c.req.method} ${c.req.path}: ${message}`);
  appendServerError(line);
  return c.json({ error: "internal_error", message: "服务端内部错误，详见服务端日志" }, 500);
});

// M0 只在本机/局域网跑，放开来源方便真机调试。
// 上公网前必须收紧成具体来源，否则等于把私人 Agent 敞开。
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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

// SSE 事件重放库（2026-11-04 seq 方案）。惰性建：回滚开关关着就永远不建库。
// 库路径可用 AGENT_SSE_SEQ_DB_PATH 覆盖（探针用），默认 .data/chat-events.sqlite。
let chatEventStore: ChatEventStore | undefined;
const chatEventStoreOf = (): ChatEventStore | undefined => {
  if (!sseSeqEnabled()) return undefined;
  chatEventStore ??= new ChatEventStore();
  return chatEventStore;
};
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
// 默认工作区（2026-11-08 用户拍板）：首次使用不再要引导，没设过就静默落 <主目录>/lifediary。
// LIFEDIARY_DEFAULT_WORKSPACE=off 退回旧行为（不播种）；已设置过的一律不动。
seedDefaultWorkspace();

// 文件浏览入口（2026-11-06）：open-explorer + files 只读浏览。回滚开关
// EXPLORER_OPEN=false / FILE_BROWSE=false（方案：docs/设计方案/2026-11-06-文件浏览入口（桌面资源管理器与手机端）.md）。
mountFiles(app);

// 任务中心只读接口（2026-11-03 方案 §5.9）：领域列表 + 单 ticket 明细。
mountDelegationApi(app);

// 执事管理（2026-11-05 批次B B2）：档案 CRUD + 手动跑一轮。开关关着一个路由都不挂（404 = 未启用）。
mountCompanions(app);

// 群组（2026-11-06 群组方案）：执事群聊 + 共享时间线 + 确定性调度。
// GROUPS_ENABLED / COMPANIONS_ENABLED 任一关着一个路由都不挂（404 = 未启用）。
mountGroups(app);

// 长期课题（2026-11-07 长期课题跟进）：课题户口本 + 提议确认 + 研究回合。
// 开关关着一个路由都不挂（404 = 未启用）；研究闹钟由 agent 里注册的 TopicTask 负责。
mountTopics(app);

// 搜索配置：课题研究的硬前提（没 key 时 propose_topic / 研究回合都会拒绝）。
mountSearch(app);

// 审批答复（2026-11-04 批次二）：待批列表 + 幂等答复。开关关着时列表恒为空。
mountApprovalApi(app);
// 高级开关（2026-11-09）：界面读写运行时开关（.data/agent-flags.json）。AGENT_FLAGS_UI=false 整组不挂。
mountFlags(app);
// 记忆管理（2026-11-06）：看 / 删 / 标过时。只读列表不碰 durable，删改直接落记忆库。
mountMemoryApi(app, { enabled: memoryEngine !== null });
// 技能管理（2026-11-08 扫尾批 9-S）：目录解析 = AGENT_SKILLS_DIR → 用户目录 → 应用目录兜底。
// 技能增删只影响下一个会话（D5 既有取舍），UI 文案已如实说明。
mountSkills(app);

// 界面（2026-11-03）：原来那张 M0 调试页换成了真界面，仍然是同源静态文件。
// 桌面壳和浏览器打开的都是这个 `/`。
mountWeb(app);

// ── 配对（2026-10-29）：手机扫这一屏换设备凭据 ────────────────
const SERVER_VERSION = "0.1.0";

function currentPort(): number {
  return Number(process.env.PORT ?? 39847);
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
 *
 * 2026-11-08（扫尾批 4a）：响应顺带投影两个能力开关（`attachments` / `editResend`），
 * 前端据此决定渲染不渲染入口。它们是**环境变量**、不是可写档位，所以 POST 不收、
 * 但响应里照样带着（读一次 policy 就知道当前能力面）。
 */
app.get("/api/v1/agent/policy", (c) => c.json(policyProjection()));

app.post("/api/v1/agent/policy", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { access?: string; blocked?: string[]; approvalLevel?: unknown; confirmWrites?: unknown }
    | null;
  const access = body?.access;
  if (access && access !== "full" && access !== "read-only" && access !== "no-shell") {
    return c.json({ error: "bad_request", message: "access 只能是 full / read-only / no-shell" }, 400);
  }
  // 三档（2026-11-08 扫尾批 10-C）：新字段优先，旧布尔照旧收（true→ask-all / false→none）
  if (
    body &&
    "approvalLevel" in body &&
    body.approvalLevel !== "ask-all" &&
    body.approvalLevel !== "ask-critical" &&
    body.approvalLevel !== "none"
  ) {
    return c.json(
      { error: "bad_request", message: "approvalLevel 只能是 ask-all / ask-critical / none" },
      400,
    );
  }
  if (body && "confirmWrites" in body && typeof body.confirmWrites !== "boolean") {
    return c.json({ error: "bad_request", message: "confirmWrites 只能是布尔值" }, 400);
  }
  const approvalLevel =
    body?.approvalLevel === "ask-all" ||
    body?.approvalLevel === "ask-critical" ||
    body?.approvalLevel === "none"
      ? body.approvalLevel
      : undefined;
  setPolicy({
    ...(access ? { access: access as "full" | "read-only" | "no-shell" } : {}),
    ...(Array.isArray(body?.blocked) ? { blocked: body!.blocked! } : {}),
    ...(approvalLevel ? { approvalLevel } : {}),
    ...(typeof body?.confirmWrites === "boolean" ? { confirmWrites: body.confirmWrites } : {}),
  });
  // 与改动前一致：POST 回的是写后的策略本身（不含 label），额外带上只读能力投影
  const next = getPolicy();
  return c.json({
    ok: true,
    access: next.access,
    blocked: next.blocked,
    approvalLevel: next.approvalLevel,
    // 派生字段：旧客户端只认布尔
    confirmWrites: next.confirmWrites,
    // 2026-11-08 扫尾批 8c：审批形态是 env（不可写），这里只回显，形状与 GET 对齐
    approvalMode: next.approvalMode,
    attachments: attachmentsEnabled(),
    editResend: editResendEnabled(),
  });
});

/** policy 投影：档位 + 标签 + 能力开关（只读投影，不写 .data/policy.json）。 */
function policyProjection() {
  return {
    ...getPolicy(),
    attachments: attachmentsEnabled(),
    editResend: editResendEnabled(),
  };
}

/**
 * 思考强度档（2026-11-04 思考档位方案 D4）：同一个模型的四条思考变体，不换模型。
 *
 * body：`{ thinking: "off"|"low"|"medium"|"high" }`；旧 `{ mode: "fast"|"deep" }` 兼容映射
 * （fast→off、deep→high）。按**当前模型支持域**校验：未知值或未声明档位 → 400。
 * 写入即 configure 持久化到 durable 会话（重启保留）；faux 下 chatModelRef 原样返回，空操作 ok。
 */
app.post("/api/v1/agent/chat/:conversationId/mode", async (c) => {
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);
  const body = (await c.req.json().catch(() => null)) as
    | { thinking?: unknown; mode?: unknown }
    | null;
  const level = parseThinkingLevel(body);
  if (!level) {
    return c.json(
      {
        error: "bad_request",
        message: "thinking 只能是 off / low / medium / high（旧 mode 兼容 fast / deep）",
      },
      400,
    );
  }
  // 支持域不在 = 上游大概率 400（medium 对 glm-5.3 实测如此）；在入口说清楚，别让它变成一次失败的生成
  const supported = currentThinkingLevels();
  if (!supported.includes(level)) {
    return c.json(
      {
        error: "bad_request",
        message: `当前模型不支持思考档 ${level}；支持：${supported.join(" / ")}`,
      },
      400,
    );
  }

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);
  await applyChatMode(chat, level);
  return c.json({ ok: true, thinking: level });
});

/**
 * 手动压缩（扫尾批 1 B1，方案 §二）：`POST .../agent/chat/:conversationId/compact`。
 * body `{ "instructions"?: string }`；受理即回 `{ok:true,taskId}`，压缩在后台做。
 * `?wait=1` 时再等 `harness.waitForTask` 至多 `AGENT_COMPACT_WAIT_MS`（默认 60000）：
 * 完成回 `{ok:true,compacted:true}`；超时回 `{ok:true,waited:false,taskId}`（受理仍有效）。
 * 会话不存在 404、模型未配置 503，与 `/mode` 同口径；压缩事件内核本就发，SSE 透传不动。
 */
app.post("/api/v1/agent/chat/:conversationId/compact", async (c) => {
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);
  const body = (await c.req.json().catch(() => null)) as { instructions?: unknown } | null;
  const instructions = typeof body?.instructions === "string" ? body.instructions : undefined;
  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);
  const taskId = await startChatCompaction(chat, instructions);
  if (c.req.query("wait") === "1") {
    const raw = Number(process.env.AGENT_COMPACT_WAIT_MS ?? 60000);
    const waitMs = Number.isFinite(raw) && raw > 0 ? raw : 60000;
    const compacted = await waitChatCompaction(taskId, waitMs);
    if (compacted) return c.json({ ok: true, compacted: true });
    return c.json({ ok: true, waited: false, taskId });
  }
  return c.json({ ok: true, taskId });
});

/** 新体 `{thinking}` 优先；没有就按旧体 `{mode}` 映射（2026-11-04 思考档位 D4） */
function parseThinkingLevel(body: { thinking?: unknown; mode?: unknown } | null): ThinkingLevel | null {
  if (typeof body?.thinking === "string") {
    const parsed = ThinkingLevelSchema.safeParse(body.thinking.trim().toLowerCase());
    return parsed.success ? parsed.data : null;
  }
  const legacy = typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "";
  if (legacy === "fast") return "off";
  if (legacy === "deep") return "high";
  return null;
}


app.get("/healthz", (c) => {
  // model/models 给"这台机器现在用什么模型"一个扁平答案（2026-11-04 批次五）：
  // models 语义收窄为**默认供应商的清单**；要分组 / 要 key 状态请走 /agent/model 与 /agent/providers。
  // mock 时 model=null；faux 时 model="faux"、清单为空。
  const info = runtimeModelInfo();
  return c.json({
    ok: true,
    llm: info.model ? "upstream" : "mock",
    model: info.model,
    models: info.models,
    // E2 #6：只露「自主轮总开关」的档位与计数，不露任何会话/内容信息；
    // 前端权限卡据此显示开/关（环境变量），读不到 env 的页面也能看状态。
    // 2026-11-09 T2：扩成三档 + 24h 观察计数（observe 档"这几天它本来会提醒你 N 次"）。
    // 纯增量：`mode` 是档位，`observeCount24h` 按观察记录文件算（off 时通常为 0）；
    // 仍不含任何会话/内容信息。
    autonomy: {
      mode: autonomyMode(),
      observeCount24h: observeCount24h(),
    },
  });
});

/**
 * composer 投影（2026-11-04 批次五，接口文档 §2.8）：当前选择 + 可选供应商。
 * 刻意不含 baseUrl / keyEnv：那是设置页的投影，composer 不需要上游地址。
 */
app.get("/api/v1/agent/model", (c) => c.json(modelCatalog()));

/**
 * 运行时切换模型（2026-11-04，接口文档 §2.8）：改的是选择，env / 文件是默认；
 * 下一轮对话生效，校验与持久化都在 provider.ts 的 setRuntimeModel 里。
 */
app.post("/api/v1/agent/model", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { model?: unknown; modelId?: unknown; providerId?: unknown }
    | null;
  // 兼容旧形状 `{model}`：不区分供应商时按默认供应商解析
  const legacy = typeof body?.model === "string" ? body.model.trim() : "";
  const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : legacy;
  const providerId = typeof body?.providerId === "string" ? body.providerId.trim() : undefined;
  if (!modelId) return c.json({ error: "bad_request", message: "需要 modelId（或旧的 model）" }, 400);

  const result = setRuntimeModel({ modelId, ...(providerId ? { providerId } : {}) });
  if (!result.ok) {
    const status = result.reason === "llm_not_configured" ? 503 : 400;
    return c.json({ error: result.reason, message: result.message }, status);
  }
  // 模型 id / 供应商 id 不是对话内容，可以进日志
  console.log(`[model] 运行时切换 → ${result.provider}/${result.model}`);
  // 2026-11-04 D1：从没声明过档位的模型，切过去后后台探一遍（不阻塞本响应、不进响应体）。
  // 已声明 / faux / MODEL_PROBE_LEVELS=false 都在 provider.ts 内部直接挡掉。
  scheduleThinkingProbe(result.provider, result.model);
  // model / models 是旧字段（现有 web 与兼容层依赖），provider 是新增
  return c.json({ ok: true, provider: result.provider, model: result.model, models: result.models });
});

/** 设置页投影（接口文档 §2.10）：比 composer 多 baseUrl / keyEnv / isDefault，仍无密钥值 */
app.get("/api/v1/agent/providers", (c) => c.json(providerCatalog()));

/** 新增 / 更新供应商；`test:true` 不写文件。密钥只出现在 env 里，请求只带变量名。 */
app.post("/api/v1/agent/providers", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "bad_request", message: "需要 JSON 请求体" }, 400);
  }
  // 显式拒收密钥值字段（不是静默忽略）：这里只接受环境变量名
  for (const field of ["apiKey", "key", "headers"]) {
    if (field in body) {
      return c.json(
        { error: "secret_field_forbidden", message: `${field} 不允许出现：只填 keyEnv 变量名，值放 .env` },
        400,
      );
    }
  }
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const result = await saveProvider({
    id: text(body.id),
    previousId: text(body.previousId),
    name: text(body.name),
    baseUrl: text(body.baseUrl),
    keyEnv: text(body.keyEnv),
    models: body.models,
    modelsUrl: text(body.modelsUrl),
    test: body.test === true,
    modelMeta: body.modelMeta,
    modelThinkingLevels: body.modelThinkingLevels,
    allowEmptyModels: body.allowEmptyModels === true,
  });
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
  return c.json({
    ok: true,
    provider: result.provider,
    ...(result.message ? { message: result.message } : {}),
  });
});

/**
 * 密钥直填（2026-11-05，接口文档 §2.10）：界面填的 API Key 落服务端密钥文件并热注入 env。
 * 响应只回变量名，**绝不回显密钥值**；providers.json 仍然只存 keyEnv。
 */
app.put("/api/v1/agent/providers/:id/secret", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { apiKey?: unknown } | null;
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey : "";
  const result = setProviderSecret(c.req.param("id"), apiKey);
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
  return c.json({ ok: true, keyEnv: result.keyEnv });
});

/** 删除供应商：默认 / 当前选中的一律 400（接口文档 §2.10 的不变量） */
app.delete("/api/v1/agent/providers/:id", (c) => {
  const result = removeProvider(c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
  return c.json({ ok: true });
});

/**
 * 单模型检测（2026-11-05 模型元数据方案）：只读，不写配置、不动密钥。
 * 允许检测尚未加入 models[] 的模型 id——添加流程本来就是先检测再添加。
 */
app.post("/api/v1/agent/providers/:id/models/detect", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { modelId?: unknown } | null;
  const modelId = typeof body?.modelId === "string" ? body.modelId : "";
  const result = await detectProviderModel(c.req.param("id"), modelId);
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
  return c.json(result);
});

// 一轮真正收尾的统一动作在 `agent/settled.ts`（2026-11-08 批 10-A 下沉）：
// 普通轮 / 编辑重发 / 审批续跑共用；观察层在本文件启动处注入（见 setTurnSettledObserver）。
app.post("/api/v1/agent/chat", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
  }
  const request = parsed.data;

  // 附件口径（2026-11-08 扫尾批 4a）：先判开关，再拼内容。
  // 开关关着时**只拦分段请求**；纯字符串老客户端逐字节不变。
  const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
  if (!attachmentsEnabled() && lastUser && typeof lastUser.content !== "string") {
    return c.json(
      {
        error: "attachments_disabled",
        message: "附件已关闭（AGENT_ATTACHMENTS=false），请只发文字",
      },
      400,
    );
  }
  const assembled = assembleUserContent(lastUser?.content ?? "");
  if (!assembled.ok) {
    return c.json({ error: "bad_request", message: assembled.message }, 400);
  }
  const lastUserText = assembled.value.text;

  // 未配置模型时走 mock：链路能验证，但不建会话、不写库。
  if (!readLlmConfig()) {
    return streamMock(c, lastUserText);
  }

  // 会话 id 只能由服务端发出去：不带 = 新建，带了就必须是发过的那个。
  // durable 内部用的是自增整数，对外仍然映射成 uuid —— 整数猜得到，uuid 猜不到。
  const requestedId = request.conversationId;
  // 新建 worker 的回滚开关（2026-11-06 B2）：只拦新建；已落盘的 worker 保持原身份。
  if (!requestedId && request.chatKind === "worker" && !workerChatEnabled()) {
    return c.json(
      { error: "worker_chat_disabled", message: "普通助手会话当前已关闭（WORKER_CHAT_ENABLED=false）" },
      400,
    );
  }
  let chat = await openChat(
    requestedId,
    undefined,
    // 种类只在新建分支采用：续话不能靠这个字段改身份（下面另有不匹配校验）
    requestedId ? undefined : request.chatKind,
  ).catch((error: unknown) => {
    console.error(`[chat] 打开会话失败: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (!chat) {
    return c.json({ error: "unknown_conversation", message: "会话不存在，请不带 conversationId 新建" }, 404);
  }

  if (requestedId) {
    const kind = await chatKindOf(chat);
    // 续话带不匹配的种类：400，不隐式改身份（2026-11-06 B2）
    if (request.chatKind && request.chatKind !== kind) {
      return c.json(
        { error: "chat_kind_mismatch", message: "该会话的种类已确定，不可通过续话更改" },
        400,
      );
    }
    // 主聊天续执事专线（2026-11-06 B2）：提交前对齐身份；暂停/归档不许继续跑。
    // 对齐在 partner-runtime（agent.ts 不能反向 import 它），这里只做装配。
    if (kind === "partner" && COMPANIONS_ENABLED) {
      const partnerId = partnersStore().partnerIdOfSession(chat.internalId);
      if (partnerId) {
        const aligned = await ensurePartnerSession(partnerId).catch(() => null);
        if (!aligned) {
          return c.json(
            { error: "partner_inactive", message: "执事当前是暂停或归档状态，先恢复再继续" },
            409,
          );
        }
        chat = aligned;
      }
    }
  }

  return streamSSE(c, async (stream) => {
    const id = crypto.randomUUID();

    // seq 链（2026-11-04 seq 方案）：先落库再外发。落库失败的帧不外发——
    // 宁可客户端重拉，也不发"承诺过却补不回来"的帧。开关关着时 store 为空，退回直发。
    // 注意落库的是**带 seq 的帧**：重放出来必须和实发的一模一样（http 探针 §13 实测踩过）。
    const eventStore = chatEventStoreOf();
    // 看门狗（2026-11-09）：每帧记一次"最后事件时刻"，流结束移出跟踪。
    const stallWatch = stallWatchdog();
    const nextSeq = eventStore ? () => eventStore.nextSeq(chat.internalId) : null;
    const send = async (event: ChatEvent) => {
      stallWatch.note(chat.internalId, event.type);
      if (eventStore && nextSeq) {
        const seq = nextSeq();
        const stamped = { ...event, seq } as ChatEvent;
        await eventStore.append(chat.internalId, seq, stamped);
        await stream.writeSSE({ data: JSON.stringify(stamped) });
        return;
      }
      await stream.writeSSE({ data: JSON.stringify(event) });
    };

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
        // 带图才给 parts；纯文本仍走字符串（老链路形状不变）
        ...(assembled.value.parts ? { parts: assembled.value.parts } : {}),
        requestId: request.requestId,
        // 忙时投递方式（2026-11-07 消息即引导）：不传 = followUp，等于改动前的排队
        ...(request.whenBusy ? { whenBusy: request.whenBusy } : {}),
        // 记忆挂在"这一轮真的结束"上，不挂在"这条流结束"上：
        // 用户关掉界面之后它还会跑完，那一轮的记忆照样得写。
        onSettled: turnSettledHandler(chat, request.messages),
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
          // 审批（2026-11-04 批次二）：写类工具等客户端答复，属纯增量事件
          event.type === "approval" ||
          // 思考正文增量（2026-11-04 批次一），同属纯增量事件
          event.type === "thinking" ||
          // 系统提示行（2026-11-07 消息即引导）：插话/排队的诚实回执。
          // 对外帧 shape 与群聊的 notice 一致，老客户端按 type 忽略即可。
          event.type === "notice"
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
    // 这一轮的流结束（正常 / 报错 / 客户端断开），移出卡死跟踪。
    stallWatch.finish(chat.internalId);
  });
});

/**
 * 编辑重发（2026-11-08 扫尾批 4a，方案 §二）。
 *
 * `POST .../chat/:conversationId/edit`，body `{ messageId, text }`：
 * 校验消息属于本会话且是 user（会话在跑 → 409）→ fork 到**该条之前** →
 * 在**新会话**里走 `chatStream` 主链路提交新文本 → `202 {ok:true, conversationId}`。
 *
 * 为什么用 fork 而不是就地改写：内核 append-only、没有 truncate/edit；fork 是一等
 * API、零内核风险，老会话完整保留（列表里多一条分叉前的旧会话是方案登记的已知边界）。
 *
 * 提交在后台消费同一条 `chatStream`：记忆抽取挂在 onSettled 上，与 `/chat` 完全同一套；
 * 客户端拿到 202 后 `openConversation(新 id)` 接管，再回读/补读这一轮。
 * 回滚：`AGENT_EDIT_RESEND=false` → 端点 404（见接口文档 §6）。
 */
app.post("/api/v1/agent/chat/:conversationId/edit", async (c) => {
  // 回滚开关：关着一律 404（"未启用"，与其它能力端点同口径）
  if (!editResendEnabled()) return c.json({ error: "not_found" }, 404);
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);

  const body = (await c.req.json().catch(() => null)) as
    | { messageId?: unknown; text?: unknown }
    | null;
  const messageId = typeof body?.messageId === "string" ? body.messageId.trim() : "";
  const text = typeof body?.text === "string" ? body.text : "";
  if (!messageId || !text.trim()) {
    return c.json({ error: "bad_request", message: "需要 messageId 和 text" }, 400);
  }

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  // 执事（及一切带身份链接的会话）不提供编辑重发：fork 会克隆不出 partner 链接，
  // 新会话会丢掉执事身份落成总管会话（D14 身份冻结被 fork 绕道打破）。验收时补的闸。
  if (partnersStore().partnerIdOfSession(chat.internalId)) {
    return c.json(
      { error: "bad_request", message: "执事对话暂不支持编辑重发" },
      400,
    );
  }

  const forked = await forkForEdit(chat, messageId);
  if (!forked.ok) {
    return c.json({ error: forked.error, message: forked.message }, forked.status);
  }
  const next = forked.chat;

  // 后台跑完整一轮：客户端断开/不读都不影响它跑完并落库（与 /chat 同语义）。
  void (async () => {
    try {
      for await (const _event of chatStream({
        conversation: next.conversation,
        text,
        onSettled: turnSettledHandler(next, [{ role: "user", content: text }]),
      })) {
        // 编辑没有客户端读这条流：事件只为驱动主链路，丢弃即可
      }
    } catch (error) {
      // 原始错误只进服务端日志（可能带上游地址）
      console.error(
        `[edit ${next.externalId}] 生成失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  return c.json({ ok: true, conversationId: next.externalId }, 202);
});

/**
 * 读会话历史。
 *
 * 一轮对话现在可以在没有客户端看着的情况下跑完，所以客户端下次打开必须能把结果拉回来 ——
 * 否则"关掉界面它照样跑完"对用户没有意义。
 *
 * `sinceSeq`（2026-11-04 seq 方案）：带上后响应多 `fromSeq` + `events`（seq > sinceSeq 的
 * 已落库帧），断线重连的客户端据此补帧。`fromSeq > sinceSeq + 1` = 窗口滑过，须全量重建。
 * 不带时响应形状与改动前完全一致；回滚开关关着时同样忽略。
 */
app.get("/api/v1/agent/chat/:conversationId/messages", async (c) => {
  if (!readLlmConfig()) return c.json({ messages: [] });

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  const limit = Number(c.req.query("limit") ?? 50);
  const messages = await readTranscript(chat, Number.isFinite(limit) ? limit : 50);
  // 会话种类（2026-11-06 B2）：前端据此恢复"普通 worker / 总管"身份，不按 id 猜
  const chatKind = await chatKindOf(chat);

  const sinceRaw = c.req.query("sinceSeq");
  const eventStore = chatEventStoreOf();
  if (sinceRaw === undefined || sinceRaw === "" || !eventStore) {
    return c.json({ conversationId: chat.externalId, messages, chatKind });
  }
  const sinceSeq = Number(sinceRaw);
  if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
    return c.json({ error: "bad_request", message: "sinceSeq 必须是非负整数" }, 400);
  }
  const { from, events } = eventStore.replaySince(chat.internalId, Math.floor(sinceSeq));
  return c.json({ conversationId: chat.externalId, messages, chatKind, fromSeq: from, events });
});

/**
 * 记忆摘要（导出「接续文件」用）：该**作用域**的 preference + experience，最多 20 条。
 *
 * 主对话看 `global`，执事会话看自己的 `partner:<uuid>` 键空间——与偏好落点同口径
 * （`preferenceScopeOf`）。`session:` 原始对话沉淀刻意不导：接续文件要的是"关于这个人 /
 * 这段关系"的长期事实，不是又抄一遍对话。
 */
function handoffMemoryOf(internalId: number): HandoffMemory {
  if (!memoryEngine) return { enabled: false, scope: "", items: [] };
  const scope = scopeKey(preferenceScopeOf(internalId));
  try {
    const records = memoryEngine.list({ scopes: [scope], limit: 200 });
    const items = records
      .filter((record) => record.kind === "preference" || record.kind === "experience")
      .slice(0, HANDOFF_MEMORY_LIMIT)
      .map((record) => ({ kind: record.kind, content: record.content }));
    return { enabled: true, scope, items };
  } catch {
    // 只给枚举级说明：原始错误可能带上路径 / 正文
    console.warn("[export] 记忆摘要读取失败（本次不带记忆）");
    return { enabled: true, scope, items: [], note: "服务端读取记忆失败" };
  }
}

/**
 * 会话导出「接续文件」（2026-11-10 批 20 §一，接口文档 §2.2.1）。
 *
 * 一份 markdown：角色说明 + 读取说明 + 记忆摘要（最多 20 条）+ 最近 N 轮原文。
 * **一次性响应体，不落服务端磁盘**（隐私口径）；`format` 只支持 `handoff`。
 * 回滚：`CHAT_EXPORT_HANDOFF=false` → 404（与其它能力端点同口径）。
 */
app.get("/api/v1/agent/chat/:conversationId/export", async (c) => {
  if (!chatExportHandoffEnabled()) return c.json({ error: "not_found" }, 404);

  const rawFormat = (c.req.query("format") ?? "").trim().toLowerCase();
  if (rawFormat && rawFormat !== "handoff") {
    return c.json({ error: "bad_request", message: "只支持 format=handoff" }, 400);
  }
  const turns = parseHandoffLimit(c.req.query("limit"));
  if (turns === null) {
    return c.json({ error: "bad_request", message: "limit 必须是 1–200 的整数" }, 400);
  }
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  const [messages, chatKind] = await Promise.all([readTranscript(chat, 0), chatKindOf(chat)]);
  const document = buildHandoff({
    conversationId: chat.externalId,
    title: chatTitles()[chat.externalId],
    kind: chatKind,
    messages,
    memory: handoffMemoryOf(chat.internalId),
    turns,
  });

  // 只作为一次性下载返回：不写盘、不进缓存。文件名只带会话 uuid 前 8 位，不含标题。
  return c.body(document.markdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="${handoffFileName(chat.externalId)}"`,
    "cache-control": "no-store",
  });
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

/**
 * 全部数据导出（2026-11-05 J1，接口文档 §2.5）。
 *
 * 用户拍板：导出进设置页，单对话导出退役。这里只聚合「可见数据」——
 * 会话清单复用 listChats（已排除 hide / task-），消息走 §2.2 同一条读取路径，
 * providers 用 modelCatalog 投影（无 keyEnv，密钥永不出内）。
 * 任何一步失败就整体 503，不出半份。
 */
const EXPORT_CHAT_LIMIT = 5000;
const EXPORT_MESSAGE_LIMIT = 500;

app.get("/api/v1/agent/export", async (c) => {
  try {
    const catalog = modelCatalog();
    const chats = await listChats(EXPORT_CHAT_LIMIT);
    const conversations: {
      id: string;
      title: string;
      pinned: boolean;
      messages: {
        role: string;
        at: number;
        text: string;
        /** 用户消息的图片（2026-11-08 4a）：导出是"全部数据"，不能把图悄悄丢掉 */
        images?: { mimeType: string; data: string }[];
      }[];
    }[] = [];
    let messageCount = 0;

    for (const chat of chats) {
      const resolved = await openChat(chat.conversationId);
      if (!resolved) throw new Error(`会话 ${chat.conversationId} 打不开`);
      const messages = await readTranscript(resolved, EXPORT_MESSAGE_LIMIT);
      messageCount += messages.length;
      conversations.push({
        id: chat.conversationId,
        title: chat.title || chat.firstText,
        pinned: Boolean(chat.pinned),
        messages: messages.map(({ role, at, text, images }) => ({
          role,
          at,
          text,
          ...(images ? { images } : {}),
        })),
      });
    }

    const usage = readLlmConfig() ? await usageSummary() : { models: [] };
    const exportedAt = new Date().toISOString();
    const stamp = exportedAt.slice(0, 10);

    // 只记条数，不含任何对话内容
    console.log(`[export] ${conversations.length} conversations / ${messageCount} messages`);
    c.header("Content-Disposition", `attachment; filename="selenite-export-${stamp}.json"`);
    return c.json({
      exportedAt,
      conversations,
      providers: catalog.providers,
      modelSelection: catalog.current,
      usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[export] 失败: ${message}`);
    return c.json({ error: "export_failed", message }, 503);
  }
});

/**
 * 上下文占用（批次二）：给标题栏「已用/窗口」徽标用；mock 下两者皆 null。
 *
 * 2026-11-10 批 20 §四在同一条路径上加了**定点找回**（`?aroundIndex=<n>&radius=5`）：
 * 无 `aroundIndex` 时逐字节保持旧语义（`{used, window}`），因为早先已有客户端在用；
 * 带 `aroundIndex` 时走「旧会话定点找回」。两条语义靠参数分流，回滚开关只管新语义。
 */
app.get("/api/v1/agent/chat/:conversationId/context", async (c) => {
  const rawIndex = c.req.query("aroundIndex");

  // ── 旧语义：上下文占用（无 aroundIndex 时行为不变）──
  if (rawIndex === undefined) {
    if (!readLlmConfig()) return c.json({ used: null, window: null });
    const chat = await openChat(c.req.param("conversationId"));
    if (!chat) return c.json({ error: "unknown_conversation" }, 404);
    return c.json(await contextUsageOf(chat.conversation));
  }

  // ── 新语义：旧会话定点找回（2026-11-10 批 20 §四，接口文档 §2.2.2）──
  if (!chatContextLookupEnabled()) return c.json({ error: "not_found" }, 404);

  const aroundIndex = parseAroundIndex(rawIndex);
  if (aroundIndex === null) {
    return c.json(
      { error: "bad_request", message: "aroundIndex 必须是非负整数（消息数组下标，从 0 开始）" },
      400,
    );
  }
  const radius = parseContextRadius(c.req.query("radius"));
  if (radius === null) {
    return c.json({ error: "bad_request", message: "radius 必须是 0–50 的整数" }, 400);
  }
  if (!readLlmConfig()) return c.json({ ok: false, reason: "llm_not_configured" }, 503);

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  // transcript 没有 seq（前置勘察确认）：用消息数组下标寻址，不为这个改内核。
  const messages = await readTranscript(chat, 0);
  const total = messages.length;
  if (total === 0) {
    return c.json({
      conversationId: chat.externalId,
      total,
      aroundIndex,
      radius,
      from: 0,
      to: -1,
      messages: [],
    });
  }
  if (aroundIndex >= total) {
    return c.json(
      { error: "bad_request", message: `aroundIndex 超出范围（共 ${total} 条）`, total },
      400,
    );
  }

  const slice = sliceAroundIndex(messages, aroundIndex, radius);
  return c.json({
    conversationId: chat.externalId,
    total,
    aroundIndex,
    radius,
    from: slice.from,
    to: slice.to,
    messages: slice.messages.map((message, offset) =>
      contextMessageOf(message, slice.from + offset),
    ),
  });
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

// ── 中继（2026-11-05 多端同步方案块1，阶段一）──────────────────────
// RELAY_ENABLED=off（默认）→ 完全不装，回局域网直连形态。
// harness 以设备身份出站长连中继；通道白名单在 relay-channels.ts（默认拒绝）。
let relayClient: RelayClient | null = null;
let relayChannels: RelayChannelHub | null = null;
let homeController: CompanionHomeController | null = null;
if (relayEnabled()) {
  const settings = relaySettings();
  if (!settings) {
    console.error("[relay] RELAY_ENABLED 已开但 RELAY_URL / RELAY_TOKEN 未配齐，中继不启动");
  } else {
    const deps: RelayChannelDeps = {
      version: SERVER_VERSION,
      listChats,
      resolveInternalId: async (conversationId) => {
        for (const [internal, external] of await externalChatIds()) {
          if (external === conversationId) return internal;
        }
        return null;
      },
      externalOf: async (internalId) => (await externalChatIds()).get(internalId) ?? null,
      sayInConversation,
      eventStore: chatEventStoreOf() ?? null,
      approvals: () => approvalStore(),
      // 阶段三：降级执事的专线会话拒绝经这台设备代发（fail-closed）
      chatSendGuard: async (conversationId) => (await homeController?.chatSendGuard(conversationId)) ?? null,
    };
    relayChannels = new RelayChannelHub(
      deps,
      (dst, channel, payload) => {
        relayClient?.pushTo(dst, channel, payload);
      },
      deviceMatrixEnabled() ? createMatrixChannels() : undefined,
    );
    relayClient = new RelayClient({
      url: settings.url,
      token: settings.token,
      deviceName: settings.deviceName,
      platform: process.platform,
      version: SERVER_VERSION,
      capabilities: settings.capabilities,
      onInvoke: (src, channel, payload) => {
        if (!relayChannels) throw new Error("中继通道未装配");
        return relayChannels.handle(src, channel, payload);
      },
      onReconnected: () => {
        void homeController?.ensureDemotion().catch(() => {});
      },
      log: (line) => console.log(line),
    });
    relayClient.start();
    if (companionHomeEnabled()) {
      homeController = companionHomeController(relayClient);
      homeController.startPeriodicCheck();
    }
  }
}

// 中继的手机代理面（2026-11-05 手机端对接）：名册/远端单/跨机派活/执事归属，
// 走 /api/v1 既有鉴权；手机零新协议（见 relay-mobile-proxy.ts 头注）
mountRelayMobileProxy(app, {
  relayClient: () => relayClient,
  home: () => homeController,
  listChats,
});

// 中继状态（只暴露连接面，不暴露令牌与地址里的凭据）
app.get("/api/v1/relay/status", (c) => {
  return c.json({
    enabled: relayEnabled(),
    connected: relayClient?.connected ?? false,
    deviceId: relayClient?.selfDeviceId ?? null,
    subscriptionCount: relayChannels?.subscriptionCount ?? 0,
    onlineDevices: relayClient?.devices.length ?? 0,
  });
});

// ── 设备矩阵派活（2026-11-05 阶段二）────────────────────────────
// HTTP 入口给探针/界面用，与 delegate 工具的 targetDevice 分支同一条
// dispatchRemoteDelegation。DEVICE_MATRIX_ENABLED=off 时端点 404。
app.post("/api/v1/relay/matrix/delegate", async (c) => {
  if (!deviceMatrixEnabled() || !relayClient) return c.json({ error: "not_available" }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const targetDeviceId = typeof body?.targetDeviceId === "string" ? body.targetDeviceId : "";
  const requirement = typeof body?.requirement === "string" ? body.requirement : "";
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
  const project = typeof body?.project === "string" ? body.project : undefined;
  const domain = typeof body?.domain === "string" ? body.domain : undefined;
  if (!targetDeviceId || !requirement.trim() || !conversationId) {
    return c.json({ error: "bad_request", message: "需要 targetDeviceId / requirement / conversationId" }, 400);
  }
  // "auto" 第三态（2026-11-05 自动分发）：开关关着按非法参数拒绝，不悄悄降级。
  if (targetDeviceId === "auto" && !deviceAutoDispatchEnabled()) {
    return c.json({ error: "auto_disabled", message: "自动挑机未开启（DEVICE_AUTO_DISPATCH）" }, 400);
  }
  let originInternalId: number | null = null;
  for (const [internal, external] of await externalChatIds()) {
    if (external === conversationId) originInternalId = internal;
  }
  if (originInternalId === null) return c.json({ error: "unknown_conversation" }, 404);
  try {
    const result = await dispatchRemoteDelegation(relayClient, {
      targetDeviceId,
      requirement,
      project,
      domain,
      originInternalId,
    });
    // 挑不出不是失败：202 + 决策结果，由调用方决定是否本机执行（不返回 502）。
    if ("fallbackToLocal" in result) {
      return c.json({ ok: true, fallbackToLocal: true, reason: result.reason }, 202);
    }
    return c.json({ ok: true, requestId: result.requestId, deviceName: result.deviceName }, 202);
  } catch (error) {
    const code = error instanceof RelayInvokeError ? error.code : "internal";
    const message = error instanceof Error ? error.message : "派发失败";
    return c.json({ error: code, message }, 502);
  }
});

app.get("/api/v1/relay/matrix/status", (c) => {
  if (!deviceMatrixEnabled()) return c.json({ error: "not_available" }, 404);
  const requestId = c.req.query("requestId");
  const rows = listRemoteDelegations();
  const filtered = requestId ? rows.filter((row) => row.requestId === requestId) : rows;
  return c.json({ delegations: filtered });
});

// ── 执事认主机（2026-11-05 阶段三底座；档案/记忆归批次B）──────────
app.get("/api/v1/relay/home/status", (c) => {
  if (!companionHomeEnabled() || !homeController) return c.json({ error: "not_available" }, 404);
  return c.json(homeController.status());
});

app.post("/api/v1/relay/home/actors", async (c) => {
  if (!companionHomeEnabled() || !homeController) return c.json({ error: "not_available" }, 404);
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "bad_request", message: "需要 name" }, 400);
  try {
    return c.json(await homeController.create(name), 201);
  } catch (error) {
    const code = error instanceof RelayInvokeError ? error.code : "internal";
    return c.json({ error: code, message: error instanceof Error ? error.message : "创建失败" }, 502);
  }
});

app.post("/api/v1/relay/home/actors/:id/takeover", async (c) => {
  if (!companionHomeEnabled() || !homeController) return c.json({ error: "not_available" }, 404);
  try {
    return c.json(await homeController.takeover(c.req.param("id")));
  } catch (error) {
    const code = error instanceof RelayInvokeError ? error.code : "internal";
    return c.json({ error: code, message: error instanceof Error ? error.message : "换家失败" }, 409);
  }
});

// 立即与中继路由表对齐降级位（平时周期 60s；界面/探针用）
app.post("/api/v1/relay/home/check", async (c) => {
  if (!companionHomeEnabled() || !homeController) return c.json({ error: "not_available" }, 404);
  await homeController.ensureDemotion();
  return c.json(await homeController.status());
});

app.post("/api/v1/relay/home/actors/:id/messages", async (c) => {
  if (!companionHomeEnabled() || !homeController) return c.json({ error: "not_available" }, 404);
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "bad_request", message: "需要 text" }, 400);
  try {
    return c.json(await homeController.sendMessage(c.req.param("id"), text));
  } catch (error) {
    const code = error instanceof RelayInvokeError ? error.code : "internal";
    return c.json({ error: code, message: error instanceof Error ? error.message : "发送失败" }, 502);
  }
});

const port = Number(process.env.PORT ?? 39847);

serve({ fetch: app.fetch, port }, (info) => {
  const mode = readLlmConfig() ? "真实上游" : "mock（未配置 LLM_API_KEY）";
  // 批次D D1：首次启动播种总管（固定 id "chief"，SOUL.md = 旧 PERSONA 原文，幂等）。
  // CHIEF_PARTNER=false / 执事能力关闭时内部旁路；播种失败只 warn，主对话回落 PERSONA。
  seedChiefPartner();
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
  // 批次四（A3b）：逐单收结果，结算完把终态单写回原对话（一行状态，不是结果正文）。
  const recovered: RecoveredTicket[] = [];
  void recoverDelegations(chancellorWorkRoot(), {
    log: (line) => console.log(line),
    onTicket: (entry) => {
      recovered.push(entry);
    },
  })
    .then(async (summary) => {
      if (summary.scanned > 0) {
        console.log(
          `[恢复] 扫描 ${summary.scanned}：仍在跑 ${summary.stillRunning}，已终态 ${summary.finished}，自动续跑 ${summary.resumed}，转待你处理 ${summary.needsYou}，未知 ${summary.unknown}`,
        );
      }
      await reportRecoveries(recovered);
      await recordDeadLetters(recovered);
    })
    .catch((error: unknown) => {
      console.warn(
        `[恢复] 启动恢复失败（不影响服务）: ${error instanceof Error ? error.message : error}`,
      );
    });
  // 例行任务引擎（2026-11-05 批次B B3）：接全局事件口 + 结算遗留 running。
  // phase/tool 的全局口在 agent.ts，这里喂给引擎；delegation 口引擎自己订。
  if (COMPANIONS_ENABLED) {
    routineEngine().subscribe();
    watchAllEvents((event) => routineEngine().onAgentEvent(event));
  }
  // 任务观察层（2026-11-05 批次C C1）：AUTONOMY_ENABLED=false 时 subscribe 内部直接返回（零行为）
  autonomyObserver().subscribe();
  // 轮次收尾的观察层口（2026-11-08 批 10-A）：普通轮 / 编辑重发 / 审批续跑共用
  // agent/settled.ts 的同一个 handler。这里注入而不是让 agent/ 反向 import autonomy（会成环）。
  setTurnSettledObserver((conversationId, status, reason) =>
    autonomyObserver().onTurnSettled(conversationId, status, reason),
  );
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

/**
 * 把启动恢复的逐单结算结果回灌原对话（2026-11-04 批次四 A3b）。
 *
 * 只写一行状态：恢复手里没有任务结果正文。失败只 warn —— 汇总已经进日志，
 * 回灌不是启动的必要条件。开关关或没有模型配置时连回执库都不打开。
 */
async function reportRecoveries(entries: RecoveredTicket[]): Promise<void> {
  if (entries.length === 0 || !readLlmConfig()) return;

  const receipts = new DelegationReceipts();
  try {
    // 恢复注记（2026-11-09 任务书 T3 §5）：自动续跑（still_running）的单，
    // 在原会话下一次模型请求前注入一次「先查再动」。记账与 resumeCount 同族（进程内），
    // 不新建存储；`DELEGATION_RECOVER_REPORT=false` 只关状态行回灌，不关这条。
    if (recoverNoteEnabled()) {
      for (const entry of entries) {
        if (entry.status !== "still_running") continue;
        const conversationId = receipts.lookupByTicket(entry.ticketId)?.conversationId;
        if (typeof conversationId === "number") markRecoverResume(conversationId);
      }
    }
    if (!recoverReportEnabled()) return;
    const sent = await reportRecoveredTickets(entries, {
      receipts,
      say: async (conversationId, text) => {
        await sayInConversation(conversationId, text);
      },
      log: (line) => console.warn(line),
    });
    if (sent > 0) console.log(`[恢复] 已回灌 ${sent} 条状态行`);
  } catch (error) {
    console.warn(
      `[恢复] 回灌失败（不影响服务）: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    receipts.close();
  }
}

/**
 * 迟到子单死信扫描（2026-11-05 批次A A2）。
 *
 * 父单收口那一刻 chancellor 只读一次子单；父单中止后子单才跑完的，结果没人看。
 * 这里只记账（delegations.sqlite 的死信表）：不丢、不自动并入、可查。
 * 与回灌不同，死信是纯记账，不依赖 LLM 配置。
 */
async function recordDeadLetters(entries: RecoveredTicket[]): Promise<void> {
  if (entries.length === 0 || !recoverReportEnabled()) return;
  const receipts = new DelegationReceipts();
  try {
    const recorded = collectDeadLetters(entries, {
      childrenOf: childrenLookup(chancellorWorkRoot()),
      record: (entry) => receipts.recordDeadLetter(entry),
      log: (line) => console.log(line),
    });
    if (recorded > 0) console.log(`[恢复] 迟到子单死信 ${recorded} 条`);
  } catch (error) {
    console.warn(
      `[恢复] 死信扫描失败（不影响服务）: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    receipts.close();
  }
}

/** 父单的子单查询：顶层 runs_dir + 各分管自己的 runs_dir 都要翻（子单记 parentTicketId）。 */
function childrenLookup(workRoot: string): (parentTicketId: string) => DeadLetterChild[] {
  const dirs = new Set<string>([workRoot]);
  try {
    for (const entry of listManagers(workRoot)) {
      const runsDir = entry.meta?.runs_dir;
      if (runsDir) dirs.add(runsDir);
    }
  } catch {
    // 列不出分管就用顶层目录：查不到子单顶多漏记，不能让恢复失败
  }
  return (parentTicketId) => {
    const out: DeadLetterChild[] = [];
    for (const dir of dirs) {
      const store = new Store(dir);
      try {
        for (const child of store.childrenOf(parentTicketId)) {
          out.push({ id: child.id, status: child.status });
        }
      } catch {
        // 单目录读失败不挡别的目录
      } finally {
        store.close();
      }
    }
    return out;
  };
}

/**
 * 未配置 key 时的回显流：证明 SSE 通路、首字节时机、中止行为都正常。
 * mock **不建会话、不写库**，所以也没有事件可落——seq 方案下同样直发不带 seq
 * （接口文档 §2.1"未配置模型"口径：这条流从来不是重放通道）。
 */
function streamMock(c: Context, last: string) {
  const conversationId = crypto.randomUUID();
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
