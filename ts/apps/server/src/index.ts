import { contentText } from "@earendil-works/pi-ai";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import QRCode from "qrcode";
import {
  ChatRequestSchema,
  ThinkingLevelSchema,
  type ChatEvent,
  type DelegationPhase,
  type FinishReason,
  type ThinkingLevel,
  type TurnUsage,
} from "@lifediary/shared";
import { scopeKey } from "@lifediary/memory";
import {
  addReminder,
  applyChatMode,
  archiveChatGuarded,
  cancelReminder,
  chatKindOf,
  chatMetaSummary,
  pruneChatMetaOrphans,
  chatStream,
  chatTitles,
  contextUsageOf,
  externalChatIds,
  forkForEdit,
  getHarness,
  getPolicy,
  listArchivedChats,
  listChats,
  listReminders,
  missingChats,
  memoryEngine,
  openChat,
  pinChat,
  preferenceScopeOf,
  readTranscript,
  reminderTaskById,
  renameChat,
  rescheduleReminder,
  restoreArchivedChats,
  sayInChat,
  sayInConversation,
  seedChiefPartner,
  setTurnSettledObserver,
  startChatCompaction,
  turnSettledHandler,
  unarchiveChat,
  waitChatCompaction,
  searchTranscripts,
  setPolicy,
  stopChat,
  usageSummary,
  workerChatEnabled,
  // 对话历史倒序游标分页（2026-11-13）：/messages 的可选 page/before 走这条。
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  decodeHistoryCursor,
  readTranscriptPage,
} from "./agent.ts";
// 会话画板（2026-11-17 画板批）：只读投影 + 单条消息详情；开关 CHAT_MAP_ENABLED。
import { buildChatMap, chatMapEnabled, readSingleTranscriptMessage } from "./agent/chat-map.ts";
import {
  assembleUserContent,
  attachmentsEnabled,
  editResendEnabled,
  fileAttachmentsEnabled,
} from "./attachments.ts";
// 浏览器上传的附件落盘（2026-11-13 附件走路径）：壳里走原生选择器，这里只服务浏览器。
import { saveUploadedAttachment } from "./attachment-files.ts";
import { createAuthMiddleware, isLoopback } from "./auth.ts";
// 导出数据打包（2026-11-13）：format=zip 的采集与拼包全在这个模块，端点只管参数与响应头。
import {
  buildExportBundle,
  EXPORT_PART_IDS,
  ExportTooLargeError,
  exportBundleEnabled,
  parseExportImages,
  parseExportParts,
} from "./export-bundle.ts";
import { ChatEventStore, sseSeqEnabled } from "./chat-events.ts";
// stream_stalled 看门狗（2026-11-09 任务书 T3 §4）：只记账，不改行为、不中断。
import { stallWatchdog } from "./watchdog.ts";
import { mountDiary } from "./diary.ts";
import { mountOpenAiCompat } from "./openai-compat.ts";
import {
  PairingStore,
  buildPairUrl,
  hashToken,
  pairAdoptEnabled,
  pairTwoStepEnabled,
  resolvePairBase,
} from "./pairing.ts";
import { pairPage } from "./pair-page.ts";
import { mountPhoneWorker } from "./phone-worker.ts";
import { mountProjects, projectsStore, resolveChatDir, seedDefaultWorkspace, type ChatDirPick } from "./projects.ts";
import { chatDirPickEnabled, chatHistoryPagingEnabled, flagEnabled, loadFlagOverrides, mountFlags } from "./flags.ts";
import { toolUsageEnabled, toolUsageRows } from "./tool-usage.ts";
// 全局工具池（2026-11-17 设置→工具页）：目录与摘要复用 partner-tools，避免另抄一份。
import { modelToolCatalog, toolSummaryOf } from "./partner-tools.ts";
import { toolIndexEnabled } from "./tool-index.ts";
import { mountToolPoolRoutes } from "./tool-pool.ts";
// 一轮对话时间线（2026-11-17）：按 SSE 流 id 把工具/闸门/回合/token/收尾串成一条账。
import {
	beginTurn,
	readTurnTimeline,
	recordTimelineEvent,
	turnTimelineEnabled,
} from "./turn-timeline.ts";
// 自动归档调度器（2026-11-13 归档管理对齐 ZCode 批A）：启动 sync 一次，
// ARCHIVE_AUTO_ENABLED=false/0/off 时才零行为（2026-11-15 起默认开）；flags 端点改开关后由 onChange 动态开停。
import { autoArchiveScheduler } from "./agent/auto-archive.ts";
// 永久删除端点（同批）：mountDurableDelete 挂 deletion-preview / delete 两组路由。
import { mountDurableDelete } from "./agent/durable-delete.ts";
import { mountFiles } from "./files.ts";
// 设置 → 上下文（2026-11-16）：只读重放当前装配 + 首轮注入实文，不重跑召回。
import { chatContextInspectEnabled, contextInspectPayloadOf, lastRequestInjectionsOf } from "./context-inspect.ts";
import { contextDefaultPayload } from "./context-defaults.ts";
// Worker（普通任务助手）人设：全局一份可编辑，GET/PUT /api/v1/agent/worker-persona；
// 路由定义收在模块里（可挂载给 HTTP 测试），挂载点放在 context-defaults 附近。
import { mountWorkerPersonaRoutes } from "./worker-persona.ts";
import {
  ChatOrigins,
  ChatProjects,
  Chats as ChatsDoc,
  ChatKinds as ChatKindsDoc,
  CTX,
} from "./agent/shared.ts";
// 从回答分支（2026-11-17 批3a）：复制计划是纯函数，真正的 append 在 init / commit 事务里做。
import { chatBranchEnabled, planBranchCopy, type BranchPlan } from "./agent/branch-copy.ts";
import { conversationIsBusy } from "./agent/session-stream.ts";
import { messageIdOf } from "./agent/session-transcript.ts";
import { createPartnerSideSession } from "./partner-runtime-run-partner-turn.ts";
import type { Tx } from "@earendil-works/pi-durable";
// 壁纸（2026-11-14 外观页扩展）：.data/appearance 存一张图 + GET/POST/DELETE 三个端点。
// AGENT_APPEARANCE_WALLPAPER=0 时整组不挂（界面那块也自己藏掉）。
import { mountAppearanceWallpaper, wallpaperEnabled } from "./appearance-wallpaper.ts";
import { mountDelegationApi } from "./delegation-api.ts";
// 执行器设置（2026-11-16 多 CLI 打手适配）：任务中心派活用哪个 CLI + 模型/权限。
import { mountExecutorApi } from "./executor-mount.ts";
// 内部质检（2026-11-16）：拆单/验收/目标核对用核心模型，不再借 Qoder CLI。
import { installInternalAsk } from "./internal-model.ts";
import { installWorkerPersonaDispatch } from "./worker-persona.ts";
import { installWorkerToolsDispatch, mountWorkerToolsRoutes } from "./worker-tools.ts";
import { mountCompanions } from "./companion-api.ts";
import { mountGroups } from "./group-api.ts";
// 长期课题（2026-11-07 批次一）：列表 / 详情 / 改节奏 / 暂停 / 关闭 / 立即研究 / 提议确认。
// TOPICS_ENABLED=false 时 mountTopics 内部直接返回，整组路由 404（同 COMPANIONS 口径）。
import { mountTopics } from "./topic-api.ts";
// 搜索配置（2026-11-07 长期课题跟进 S2）：设置页直填 DeepSeek 搜索 key + 连接测试。
import { mountSearch } from "./search-api.ts";
import { COMPANIONS_ENABLED, partnersStore } from "./partners.ts";
import { ensurePartnerSession } from "./partner-runtime.ts";
// 定时任务重做（2026-11-17）：暂停/可见性归一 + 执行历史存储 + 立即跑回调。
import { reminderEnabledOf, reminderVisibilityOf, type ReminderRepeat, type ReminderVisibility } from "./reminder.ts";
import { listReminderRuns, recordReminderRun } from "./reminder-runs.ts";
import { invokeScheduledRun } from "./scheduled-run-deliverer.ts";
// 一人多会话批1（2026-11-17）：续话按链接角色分流，side 不再折回 canonical。
import { partnerContinuePlan, sideSessionsEnabled } from "./partner-session-role.ts";
import { alignPartnerSideSession } from "./partner-runtime-run-partner-turn.ts";
import { nextReminderAt, setReminderDeliverer } from "./reminder.ts";
import { installScheduledRunHandler } from "./scheduled-run-handler.ts";
import { routineEngine } from "./routines.ts";
import { watchAllEvents } from "./agent.ts";
import { autonomyMode, autonomyObserver, observeCount24h } from "./autonomy.ts";
import { mountApprovalApi } from "./approval-api.ts";
// bash 后台任务管理面（2026-11-10 批 21 §二）：列表 / 日志尾部 / kill。
// 开关沿用 AGENT_BASH_BG_TIMEOUT，关着时整组 404（与 TOPICS/COMPANIONS 同口径）。
import { mountBgJobs } from "./bg-jobs-api.ts";
import { mountMemoryApi } from "./memory-api.ts";
import { startMemoryNightlyScheduler } from "./memory-nightly.ts";
// 技能管理（2026-11-08 扫尾批 9-S）：设置页「技能」分区的增删改查，写操作锁死在技能目录内。
// SKILLS_ADMIN=false 时 mountSkills 内部直接返回，整组路由 404（同 TOPICS/COMPANIONS 口径）。
import { mountSkills } from "./skills-api.ts";
import { mountWeb } from "./web.ts";
import { mountWorkerShell } from "./worker-shell.ts";
import { syncDiaryToMemory } from "./memory-ingest.ts";
import { RelayClient } from "./relay-client.ts";
import { RelayChannelHub, type RelayChannelDeps, type RelayHttpRequest } from "./relay-channels.ts";
import {
  relayEnabled,
  relaySettings,
  deviceMatrixEnabled,
  deviceAutoDispatchEnabled,
  companionHomeEnabled,
  relayMobileProxyEnabled,
  relayLinkUiEnabled,
  normalizeRelayHttpBase,
  type RelaySettings,
} from "./relay-config.ts";
import {
  clearRelayLink,
  joinRelay,
  readRelayLink,
  relaySettingsFromLink,
  writeRelayLink,
  RelayLinkError,
} from "./relay-link.ts";
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
// 旧会话「找旧事」只读搜索端点（2026-11-10 批 28 §二）：复用 recall_sessions 的检索核心。
import {
  findAroundIndex,
  parseSessionSearchQuery,
  searchSessionsPage,
  sessionSearchApiEnabled,
} from "./agent/session-search.ts";
import { chancellorWorkRoot } from "./delegation.ts";
import { DelegationReceipts } from "./delegation-receipts.ts";
import { delegationMessages } from "./delegation-messages.ts";
import { findTicket } from "./delegation-mount.ts";
import { restoreDelegationWakeQueue, wakeOnDelegationReport } from "./delegation-wake.ts";
import { listTaskChats } from "./task-chat-index.ts";
import { sidebarTaskGroupsEnabled } from "./task-chat-owner.ts";
import {
	collectDeadLetters,
	redeliverUndeliveredReports,
	recoverReportEnabled,
	reportRedeliveryEnabled,
	reportRecoveredTickets,
	type DeadLetterChild,
} from "./recovery-report.ts";
import { recoverDelegations, type RecoveredTicket } from "../../../packages/chancellor/src/index.ts";
// 恢复注记（2026-11-09 任务书 T3 §5）：只有进程内记账，无存储依赖。
import { markRecoverResume, recoverNoteEnabled } from "./agent/recover-note.ts";
// 注入审计（2026-11-10 批 26b §二）：只回元数据、不回正文的框架注入清单。
import { auditInjections, injectionAuditEnabled } from "./agent/injection.ts";
import { INJECTION_REGISTRY } from "./agent/injection-registry.ts";
// 错误分类（2026-11-10 批 32）：上游/模型错误 → 脱敏短句 + 稳定 code，给前端错误卡。
import { describeStreamError } from "./stream-error.ts";
import { Store } from "../../../packages/chancellor/src/store.ts";
import { listManagers } from "../../../packages/chancellor/src/manager/registry.ts";

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

// 内部质检模型（2026-11-16）：默认核心 PI；`CHANCELLOR_INTERNAL=qoder` 回旧形态。
// 必须在任何派活之前注入，崩溃恢复的自动续跑也走同一份内部调用。
const internalMode = installInternalAsk();
console.log(
  `[internal] 拆单/验收/目标核对：${internalMode === "core" ? "核心模型" : "Qoder CLI"}`,
);

// worker 人设派活注入（2026-11-16 批2）：普通助手那份人设，native 与外部 CLI 同吃。
// `WORKER_PERSONA_DISPATCH=false` 回滚到无身份的纯 TASK.md。
const workerPersonaDispatch = installWorkerPersonaDispatch();
console.log(
  `[worker-persona] 派活注入人设：${workerPersonaDispatch ? "开（TASK.md「你是谁」段）" : "关（WORKER_PERSONA_DISPATCH=false）"}`,
);

// native worker 工具面（2026-11-17 批4）：普通助手页勾选的取消名单补集，spawn 换成 --tools。
// 外部 CLI 不吃这层（用自己的工具）；`WORKER_TOOLS_DISPATCH=false` 回滚全开。
const workerToolsDispatch = installWorkerToolsDispatch();
console.log(
  `[worker-tools] native 工具面勾选：${workerToolsDispatch ? "开（spawn --tools）" : "关（WORKER_TOOLS_DISPATCH=false，全开）"}`,
);

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

/**
 * 「未配对的外部连接」登记（2026-11-14 连接方式两分）：共享令牌从非本机地址进来的请求。
 *
 * 为什么需要它：手机里如果直接填了 `AGENT_TOKEN`（而不是扫码换设备凭据），它既不在本地配对
 * 名册、也不在中继名册，设置页上就是空白——用户的原话是"我平板在调试，但它还是看不到连接"。
 * 这里只在内存里留**最近 10 分钟、最多 8 个来源类别**，只记地址类别与时间，不记 IP 明文、
 * 不落盘（重启即清空，它本来就是"刚刚有人在用"的临时事实）。
 */
interface ForeignPeer {
  address: string;
  transport: "local" | "usb" | "direct";
  firstAt: number;
  lastAt: number;
  path: string;
}
const foreignPeers = new Map<string, ForeignPeer>();
const FOREIGN_PEER_TTL_MS = 10 * 60_000;
const FOREIGN_PEER_MAX = 8;

function noteForeignPeer(info: { transport: "local" | "usb" | "direct"; path: string; address: string | null }): void {
  const now = Date.now();
  for (const [key, peer] of foreignPeers) {
    if (now - peer.lastAt > FOREIGN_PEER_TTL_MS) foreignPeers.delete(key);
  }
  const address = info.address ?? "unknown";
  const existing = foreignPeers.get(address);
  foreignPeers.set(address, {
    address,
    transport: info.transport,
    firstAt: existing?.firstAt ?? now,
    lastAt: now,
    path: info.path,
  });
  // 上限兜底：只留最近活跃的几条，别让扫描器把内存当记事本
  if (foreignPeers.size > FOREIGN_PEER_MAX) {
    const oldest = [...foreignPeers.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
    if (oldest) foreignPeers.delete(oldest.address);
  }
}

/**
 * 「此刻谁在跟这台机器说话」（2026-11-14 三次打磨）。
 *
 * 名册只回答"曾经配对过谁"，不回答"现在谁在用"——平板正连着、但凭据已撤销（或名册里根本没它），
 * 页面就一片空白，用户看到的是"平板明明在线，列表里没有它"。这里按**设备身份**记一笔：
 * 认出令牌属于哪台设备（哪怕已撤销）就用它的 id 当 key；主令牌从外部进来、或不认识这枚令牌，
 * 就用方式 + 地址类别当 key。5 分钟过期，最多 8 条，不存 IP 明文。
 */
interface LivePeer {
  key: string;
  id: string | null;
  name: string | null;
  kind: "device" | "main" | "unknown";
  revoked: boolean;
  transport: "local" | "usb" | "direct";
  path: string;
  /**
   * 这枚凭据的 sha256（2026-11-14 五次打磨）：认领要靠它把"此刻正连着的陌生令牌"
   * 登记成一台设备。只存哈希、不存明文，也不下发给页面（页面只拿前 8 位当短号）。
   */
  tokenHash: string | null;
  firstAt: number;
  lastAt: number;
}
const livePeers = new Map<string, LivePeer>();
/** 拒绝日志的节流表：同一枚凭据每分钟只留一行，避免扫描器把日志刷爆 */
const authFailLoggedAt = new Map<string, number>();
const LIVE_PEER_TTL_MS = 5 * 60_000;
const LIVE_PEER_MAX = 8;

function noteLivePeer(info: {
  id: string | null;
  name: string | null;
  kind: "device" | "main" | "unknown";
  revoked: boolean;
  transport: "local" | "usb" | "direct";
  path: string;
  tokenHash?: string | null;
}): void {
  const now = Date.now();
  for (const [key, peer] of livePeers) {
    if (now - peer.lastAt > LIVE_PEER_TTL_MS) livePeers.delete(key);
  }
  const key = info.id ? `device:${info.id}` : `anon:${info.kind}:${info.transport}`;
  const existing = livePeers.get(key);
  livePeers.set(key, {
    key,
    id: info.id,
    name: info.name,
    kind: info.kind,
    revoked: info.revoked,
    transport: info.transport,
    path: info.path,
    tokenHash: info.tokenHash ?? null,
    firstAt: existing?.firstAt ?? now,
    lastAt: now,
  });
  if (livePeers.size > LIVE_PEER_MAX) {
    const oldest = [...livePeers.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
    if (oldest) livePeers.delete(oldest.key);
  }
}

const auth = createAuthMiddleware(process.env.AGENT_TOKEN?.trim() || null, {
  verifyDeviceToken: (token) => pairing.verifyDeviceToken(token),
  // 第二次调用带上方式：只补记录，鉴权结论已经由上面那次给出（令牌哈希比对是纯计算，够便宜）
  onDeviceSeen: (token, transport) => {
    pairing.verifyDeviceToken(token, Date.now(), transport);
    const who = pairing.identifyDeviceToken(token);
    if (who) {
      noteLivePeer({
        id: who.id,
        name: who.name,
        kind: "device",
        revoked: false,
        transport,
        path: "",
        tokenHash: hashToken(token),
      });
    }
  },
  onForeignPeer: (info) => {
    noteForeignPeer(info);
    noteLivePeer({ id: null, name: null, kind: "main", revoked: false, transport: info.transport, path: info.path });
  },
  // 凭据没过也记一笔（2026-11-14 三次打磨）：平板拿着已撤销的令牌来敲门时，
  // 不加这条页面就什么都看不见，用户只能看到"平板明明在线，列表里没有它"。
  onAuthFail: (info) => {
    // 没带任何凭据的请求不记（2026-11-15）：页面自己那次不带 Authorization 的请求也会走到这里，
    // 记下来就在列表里多一台「3 分钟前回话的未知凭据」——凭空长出来的幽灵设备，用户想认领也无从认领。
    if (!info.token) return;
    const who = info.token ? pairing.identifyDeviceToken(info.token) : null;
    noteLivePeer({
      id: who?.id ?? null,
      name: who?.name ?? null,
      kind: who ? "device" : "unknown",
      revoked: Boolean(who?.revoked),
      transport: info.transport,
      path: info.path,
      // 没认出来的凭据也留哈希：页面上的「认领」要凭它把这枚令牌登记进来。
      tokenHash: info.token ? hashToken(info.token) : null,
    });
    // 落一笔"这枚没登记的凭据来过"（五次打磨）：活口表 5 分钟就忘，可平板的 App 未必一直在问——
    // 只靠活口，用户过几分钟再看又是空白。认不出的才记，已撤销的不算（它在名册里有名有姓）。
    if (!who && info.token && pairAdoptEnabled()) {
      pairing.noteUnclaimed(hashToken(info.token), info.transport);
    }
    // 留一条可追溯的日志（同一枚凭据每 60 秒最多一行）：用户再问"平板明明在线"时，
    // 这里能直接回答"它到底有没有打到这台机器"。不写 IP、不写令牌。
    const logKey = who ? `device:${who.id}` : `unknown:${info.transport}`;
    const nowMs = Date.now();
    if (nowMs - (authFailLoggedAt.get(logKey) ?? 0) > 60_000) {
      authFailLoggedAt.set(logKey, nowMs);
      console.warn(
        `[auth] 拒绝${who ? `设备「${who.name}」` : "未知凭据"}（${who?.revoked ? "已撤销" : "无匹配记录"}） transport=${info.transport} path=${info.path}`,
      );
    }
  },
});

// SSE 事件重放库（2026-11-04 seq 方案）。惰性建：回滚开关关着就永远不建库。
// 库路径可用 AGENT_SSE_SEQ_DB_PATH 覆盖（探针用），默认 .data/chat-events.sqlite。
let chatEventStore: ChatEventStore | undefined;
const chatEventStoreOf = (): ChatEventStore | undefined => {
  if (!sseSeqEnabled()) return undefined;
  chatEventStore ??= new ChatEventStore();
  return chatEventStore;
};
const PAIR_OPEN_PATHS = new Set([
  "/api/v1/pair/info",
  "/api/v1/pair/redeem",
  // 两段式 confirm 必须免鉴权：手机此刻还没有任何凭据（与单段 redeem 同口径）。
  // begin 是电脑端调用（要鉴权），故意不在此列。
  "/api/v1/pairing/confirm",
]);
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

// 外观壁纸（2026-11-14）：只负责存图与回传，可见度/模糊在前端。
if (wallpaperEnabled()) mountAppearanceWallpaper(app);

// 任务中心只读接口（2026-11-03 方案 §5.9）：领域列表 + 单 ticket 明细。
mountDelegationApi(app);

// 执行器设置（2026-11-16）：派活用哪个 CLI + 各 CLI 的模型/权限；落 .data/executor.json。
mountExecutorApi(app);

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
// bash 后台任务管理面（2026-11-10 批 21 §二）：转后台之后要能看见、能收尾。
mountBgJobs(app);
// 高级开关（2026-11-09）：界面读写运行时开关（.data/agent-flags.json）。AGENT_FLAGS_UI=false 整组不挂。
mountFlags(app, {
  // 自动归档的开关/天数写成功后立刻开停调度器（hot 开关的运行中生效路径；
  // 没有这一步，运行中打开 ARCHIVE_AUTO_ENABLED 要等重启）
  onChange: (key) => {
    if (key === "ARCHIVE_AUTO_ENABLED" || key === "ARCHIVE_AUTO_DAYS") {
      autoArchiveScheduler().sync();
    }
  },
});
// 记忆管理（2026-11-06）：看 / 删 / 标过时。只读列表不碰 durable，删改直接落记忆库。
// 2026-11-16：enabled 改成活读函数——运行期关掉记忆总闸后 /memory/* 立即 404；
// 启动时关着、运行期再打开仍受 memoryEngine=null 限制（要重启才真正上架）。
mountMemoryApi(app, { enabled: () => memoryEngine !== null && flagEnabled("MEMORY_ENABLED") });
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
  const now = Date.now();
  const deviceRecords = pairing.listDevices();
  const devices = deviceRecords.map((device) => ({
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt ?? null,
    // 连接方式（2026-11-14 连接页两分）：`online` 是"最近活跃"的近似——本机没有真在线表。
    // 窗口从 2 分钟放宽到 10 分钟（2026-11-14 二次打磨）：平板明明连着、只是暂时没请求，
    // 2 分钟就翻成离线，用户看到的是"在线状态乱跳"。前提没变：它只回答"刚还在用、走的哪条路"。
    online: Boolean(device.lastSeenAt && now - device.lastSeenAt <= 600_000),
    lastTransport: device.lastTransport ?? null,
    lastTransportAt: device.lastTransportAt ?? null,
    transportAt: device.transportAt ?? null,
    revoked: Boolean(device.revokedAt),
    // 人眼可核的指纹 + 键变更位（2026-11-10 批 26 §四）；开关关着时两者都不出现。
    ...(device.fingerprint !== undefined ? { fingerprint: device.fingerprint } : {}),
    ...(device.keyChangedAt !== undefined
      ? { keyChanged: true, keyChangedAt: device.keyChangedAt }
      : {}),
  }));
  // 用主令牌直连、没走配对的外部设备（2026-11-14）：不落盘，只报"刚刚有人这样连着"。
  const unpaired = [...foreignPeers.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((peer) => ({ transport: peer.transport, firstAt: peer.firstAt, lastAt: peer.lastAt, path: peer.path }));
  // 「此刻谁在说话」（2026-11-14 三次打磨）：名册回答"配过谁"，这里回答"现在谁在用"——
  // 凭据已撤销也照样列出来（revoked=true），页面才有东西可显示。
  // 读的时候再剪一次过期（五次打磨）：表只在"有新请求进来"时才顺手清，一台设备停了之后
  // 最后那条记录会一直躺着，页面就会把它写成"现在在线"——那是假的。
  const live = [...livePeers.values()]
    // 名册里已经不存在的设备（删掉记录 / 撤销后又被删）不再算"此刻谁在说话"（五次打磨）：
    // 那条记录已经没了，画出来的只是一枚幽灵——页面给它套上"未知凭据"的壳，看着像另一台不认识的设备。
    .filter(
      (peer) =>
        !(
          peer.kind === "device" &&
          peer.id !== null &&
          !deviceRecords.some((device) => device.id === peer.id)
        ),
    )
    .filter((peer) => now - peer.lastAt <= LIVE_PEER_TTL_MS)
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((peer) => ({
      id: peer.id,
      name: peer.name,
      kind: peer.kind,
      revoked: peer.revoked,
      transport: peer.transport,
      path: peer.path,
      firstAt: peer.firstAt,
      lastAt: peer.lastAt,
      secondsAgo: Math.max(0, Math.round((now - peer.lastAt) / 1000)),
      // 认领用的短号：只给"认不出的凭据"，且只有 sha256 前 8 位（反推不了令牌）。
      tokenHint: peer.kind === "unknown" && peer.tokenHash ? peer.tokenHash.slice(0, 8) : null,
    }));
  // 「来过、但没登记」的凭据（五次打磨）：活口只回答"这一分钟谁在说话"，它回答
  // "最近谁来过却一直被拒"——平板隔几分钟才问一次的时候，这一行才是看得见的那一行。
  const unclaimed = pairAdoptEnabled()
    ? pairing.listUnclaimed(now).map((item) => ({
        ...item,
        secondsAgo: Math.max(0, Math.round((now - item.lastAt) / 1000)),
      }))
    : [];
  return c.json({ devices, unpaired, live, unclaimed });
});

/** 撤掉一台设备（CORS 只放 GET/POST，所以用 POST 而不是 DELETE） */
app.post("/api/v1/pair/devices/:id/revoke", (c) => {
  const ok = pairing.revokeDevice(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ ok: false }, 404);
});

/**
 * 彻底删掉一条**已撤销**的设备记录（2026-11-14 五次打磨）。
 *
 * 撤销只让凭据作废，记录还在名册里占一行（"已移除 · #xxxx"）。用户想清理这种残壳，
 * 但删活动设备等于绕过"先撤销"的顺序，所以这里只认 revoked 的记录，别的给 409。
 */
app.post("/api/v1/pair/devices/:id/delete", (c) => {
  const id = c.req.param("id");
  const record = pairing.listDevices().find((item) => item.id === id);
  if (!record) return c.json({ error: "unknown_device" }, 404);
  if (!record.revokedAt) return c.json({ error: "still_active" }, 409);
  const ok = pairing.removeDevice(id);
  return ok ? c.json({ ok: true }) : c.json({ error: "unknown_device" }, 404);
});

/**
 * 认领一枚"本机没登记、但此刻正连着"的凭据（2026-11-14 五次打磨）。
 *
 * 为什么需要：平板手里那枚令牌不是这台机器发的（别处配的 / 中继发的 / 旧库留下的），
 * 于是每个请求都 403，页面只能把它叫「未知凭据」——"找不到平板"说的就是这件事。
 * 认领 = 把它的 sha256 登记成一台设备，凭据立刻生效、也立刻能像别人一样"移除"。
 *
 * 三条硬口径：
 * ① **只许本机页面**（`isLoopback`）调：这等于把一枚陌生凭据升级成长期设备，不能从网络上按一下就过；
 * ② 只认留下的这枚凭据：活口表里 5 分钟内正在说的，或"来过"表里 7 天内的（平板隔几分钟才问一次，
 *    只认活口会经常"点的时候它刚好没在说话"）；
 * ③ 页面只拿得到 8 位短号，拿到哈希本体的是服务端自己——网页永远看不到完整凭据指纹。
 */
app.post("/api/v1/pair/devices/adopt", async (c) => {
  if (!pairAdoptEnabled()) return c.json({ error: "not_found" }, 404);
  if (!isLoopback(c)) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { tokenHint?: string; name?: string } | null;
  const hint = body?.tokenHint?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{8}$/.test(hint)) return c.json({ error: "bad_request" }, 400);
  const now = Date.now();
  const peer = [...livePeers.values()]
    .filter(
      (item) =>
        item.kind === "unknown" &&
        item.tokenHash &&
        now - item.lastAt <= LIVE_PEER_TTL_MS &&
        item.tokenHash.startsWith(hint),
    )
    .sort((a, b) => b.lastAt - a.lastAt)[0];
  const tokenHash = peer?.tokenHash ?? pairing.unclaimedHashByHint(hint, now);
  if (!tokenHash) return c.json({ error: "peer_gone" }, 404);
  const result = pairing.adoptTokenHash(tokenHash, body?.name?.trim() || "设备");
  if (result === "duplicate") return c.json({ error: "duplicate" }, 409);
  if (result === "too_many") return c.json({ error: "too_many_devices" }, 409);
  // 这枚"匿名活口"已经有了名字，立刻撤掉，免得列表里同一台设备出现两行（一行有名、一行"未知"）
  if (peer) livePeers.delete(peer.key);
  pairing.forgetUnclaimed(tokenHash);
  console.log(`[pair] 认领了一枚没登记但来过门的凭据 → 设备「${result.name}」`);
  return c.json({ ok: true, id: result.id, name: result.name });
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

/**
 * 用码换设备凭据（单段 / 回滚通道，免鉴权：手机此刻还没有任何凭据）。
 *
 * 2026-11-10 批 28 §一：两段式默认开（PAIR_TWO_STEP=true）时这条单段捷径**关闭**，
 * 否则"只扫码拿到 code 就能兑凭据"会让两段式形同虚设（手机绝不代确认）。
 * 回滚：PAIR_TWO_STEP=false → 逐字节回到旧单段行为。
 */
app.post("/api/v1/pair/redeem", async (c) => {
  if (pairTwoStepEnabled()) {
    return c.json(
      {
        error: "two_step_required",
        message: "单段配对在 PAIR_TWO_STEP=true 时关闭；请改用 /api/v1/pairing/begin + /confirm",
      },
      410,
    );
  }
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
  return c.json({
    deviceToken: result.deviceToken,
    deviceId: result.deviceId,
    ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
    name: hostname(),
    version: SERVER_VERSION,
  });
});

// ── 两段式配对（2026-11-10 批 28 §一）──────────────────────────────
/**
 * 第一段：电脑端（已鉴权）起一枚两段式码。
 * `code` 给手机扫（进二维码），`confirmToken` 只回电脑端确认用、**不随二维码下发**。
 * `PAIR_TWO_STEP=false` 时整组两段式端点不启用（404，回到旧单段）。
 */
app.post("/api/v1/pairing/begin", (c) => {
  if (!pairTwoStepEnabled()) return c.json({ error: "not_found" }, 404);
  const { code, expiresAt, confirmToken } = pairing.begin();
  return c.json({ code, expiresAt, confirmToken });
});

/**
 * 第二段：`code` + `confirmToken` 同时正确才发设备令牌（免鉴权：手机此刻还没有凭据）。
 * 只拿到 code 不能完成——必须有人在电脑端把 confirmToken 输进去（手机绝不代确认）。
 */
app.post("/api/v1/pairing/confirm", async (c) => {
  if (!pairTwoStepEnabled()) return c.json({ error: "not_found" }, 404);
  const ip = (() => {
    try {
      return getConnInfo(c).remote.address ?? "local";
    } catch {
      return "local";
    }
  })();
  // 与 redeem 共用 IP 限流；码内 attempts 限流由 PairingStore.confirm 负责（两者同一计数器）。
  if (redeemRateLimited(ip)) return c.json({ error: "too_many_attempts" }, 429);

  const body = (await c.req.json().catch(() => null)) as
    | { code?: string; confirmToken?: string; deviceName?: string }
    | null;
  const code = body?.code?.trim();
  if (!code) return c.json({ error: "bad_request" }, 400);

  const result = pairing.confirm(
    code,
    body?.confirmToken?.trim() ?? "",
    body?.deviceName?.trim() || "手机",
  );
  if (typeof result === "string") {
    const status =
      result === "unknown_code"
        ? 404
        : result === "confirm_required" || result === "bad_confirm"
          ? 400
          : result === "code_used"
            ? 409
            : result === "code_expired"
              ? 410
              : 429;
    return c.json({ error: result }, status);
  }
  console.log(`[pair] 新设备已两段式配对（${ip}），当前共 ${pairing.listDevices().length} 台`);
  return c.json({
    deviceToken: result.deviceToken,
    deviceId: result.deviceId,
    ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
    name: hostname(),
    version: SERVER_VERSION,
  });
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
  // 2026-11-12 归档模块：`removed` → `archived`（计数）。手机端只读 `chats`，改名不断手机。
  // 2026-11-15 侧栏按创建者分组：增量 `tasks` 键带任务专线会话（手机 / 旧客户端忽略未知键）。
  // 开关关着不下发——回滚形态双保险（前端回旧版平铺列表）。
  const body: Record<string, unknown> = { chats, archived: chatMetaSummary().archived };
  if (sidebarTaskGroupsEnabled()) {
    body.tasks = await listTaskChats(Number.isFinite(limit) ? limit : 50);
  }
  return c.json(body);
});

/**
 * 会话存活核对（2026-11-17，手机同步回收）。
 *
 * 手机把本地绑定过的 conversationId 发来，只回「已经不在电脑上」的那些（删了 / 归档了 /
 * 任务专线）。手机据此软删本地映射行——电脑上删掉的对话，手机上不再留着。
 *
 * 只查 durable 的会话表与 chat-meta 归档表，**不读正文**（对比 `GET /agent/chats`
 * 逐会话读 context 的已知代价），可以跟着列表刷新同频调用。
 * 请求非法 / 空 → `{missing: []}`（宁可少回收，不可误删）。
 */
app.post("/api/v1/agent/chats/check", async (c) => {
	const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
	const ids = Array.isArray(body?.ids)
		? [
				...new Set(
					body.ids.filter(
						(id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200,
					),
				),
			].slice(0, 500)
		: [];
	return c.json({ missing: await missingChats(ids) });
});

/**
 * 归档会话清单（2026-11-12 归档模块 §3）。
 *
 * 按 chat-meta 的归档 id 反查，不受活跃清单 limit 截断；`limit` 只截最终结果
 * （非法值回落 200）。`total` 是归档总数（chat-meta 口径），可能大于本页条数。
 */
app.get("/api/v1/agent/chats/archived", async (c) => {
  const raw = Number(c.req.query("limit") ?? 200);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
  const chats = await listArchivedChats(limit);
  return c.json({ chats, total: chatMetaSummary().archived });
});

/**
 * 会话改名 / 归档（2026-11-03；2026-11-12 改名「归档」）。
 *
 * durable 没有标题和删除的概念，所以这两件事只写我们自己的 `chat-meta.json`：
 * 改名不影响内核；「归档」只是不在活跃列表里出现，会话与记忆都还在。
 */
app.post("/api/v1/agent/chat/:conversationId/rename", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { title?: string } | null;
  const title = body?.title ?? "";
  return c.json({ ok: true, ...renameChat(c.req.param("conversationId"), title) });
});

/**
 * 归档一条会话：主入口（`/hide` 保留为兼容别名，同一 handler）。
 * 2026-11-13 对齐 ZCode 批A：**运行中禁止归档**（busy → 400 带说明），
 * 判定与拒绝语义都在 `archiveChatGuarded`（session.ts），这里只做参数与响应映射。
 */
const archiveChatHandler = async (c: Context) => {
  const conversationId = c.req.param("conversationId");
  if (!conversationId) return c.json({ error: "bad_request" }, 400);
  const result = await archiveChatGuarded(conversationId);
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
  return c.json({ ok: true });
};
app.post("/api/v1/agent/chat/:conversationId/archive", archiveChatHandler);
app.post("/api/v1/agent/chat/:conversationId/hide", archiveChatHandler);

/** 单条恢复（幂等：不在归档里也返回 ok）。恢复无害，不判忙。 */
app.post("/api/v1/agent/chat/:conversationId/unarchive", (c) => {
  unarchiveChat(c.req.param("conversationId"));
  return c.json({ ok: true });
});

/**
 * 全部恢复 → `{ok, restored}`。
 * 2026-11-13 对齐 ZCode 批A：**UI 不再暴露页级"全部恢复"**（组级恢复取代之），
 * 端点保留不删——旧客户端 / 探针 / 回滚不 404（方案 §1）。
 */
app.post("/api/v1/agent/chats/restore", (c) =>
  c.json({ ok: true, restored: restoreArchivedChats() }),
);

/**
 * 永久删除（2026-11-13 对齐 ZCode 批A）：预检 + 执行，归档是唯一门槛，
 * 只收普通会话、连分叉子树一起删。实现与挂载在 agent/durable-delete.ts。
 */
mountDurableDelete(app);

/** 置顶 / 取消置顶（2026-11-04 批次一）：只影响列表顺序，写 chat-meta，不碰会话本身 */
app.post("/api/v1/agent/chat/:conversationId/pin", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { pinned?: boolean } | null;
  const pinned = body?.pinned !== false;
  return c.json({ ok: true, pinned: pinChat(c.req.param("conversationId"), pinned) });
});

/**
 * 访问档位（2026-11-03）：只读 / 在工作区内修改（内部值 no-shell）/ 完全访问。
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
    // 2026-11-13：任意文件（路径引用）与浏览器上传入口；关着时前端只留图片
    fileAttachments: fileAttachmentsEnabled(),
    editResend: editResendEnabled(),
  });
});

/** policy 投影：档位 + 标签 + 能力开关（只读投影，不写 .data/policy.json）。 */
function policyProjection() {
  return {
    ...getPolicy(),
    attachments: attachmentsEnabled(),
    fileAttachments: fileAttachmentsEnabled(),
    editResend: editResendEnabled(),
    // 会话画板（2026-11-17）：前端据此决定会话顶栏要不要挂「会话地图」。
    chatMap: chatMapEnabled(),
    // 会话分叉（2026-11-17 批3b；2026-11-18 抠进插件清单）：前端据此决定回答脚注要不要挂「从这里分支」。
    chatBranch: chatBranchEnabled(),
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

/**
 * 附件上传（2026-11-13 附件走路径）：浏览器拿不到真实路径，收字节落盘、回服务端路径。
 *
 * 壳里不走这里（原生选择器直接给绝对路径，零拷贝）。`AGENT_FILE_ATTACHMENTS=false`
 * 时整条路由 404，`/agent/policy` 的 `fileAttachments` 同步为 false。
 * 响应只回路径/名字/字节，不回内容；日志只记数量（见 attachment-files.ts）。
 */
app.post("/api/v1/agent/attachments", async (c) => {
  if (!fileAttachmentsEnabled()) {
    return c.json(
      { error: "not_found", message: "文件附件未启用（AGENT_FILE_ATTACHMENTS=false）" },
      404,
    );
  }
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; mimeType?: unknown; data?: unknown }
    | null;
  const result = saveUploadedAttachment(body ?? {});
  if (!result.ok) {
    return c.json({ error: result.error, message: result.message }, result.status);
  }
  return c.json({ ok: true, file: result.file });
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
  // 新建时直接选目录（2026-11-17）：只认新建分支；续话带目录一概拒——
  // cwd 是创建时的快照，中途换目录会让模型前后的相对路径指向两个地方。
  let chatDir: ChatDirPick | undefined;
  if (request.dirPath && chatDirPickEnabled()) {
    if (requestedId) {
      return c.json(
        { error: "bad_dir", message: "已有会话不能改工作目录；换目录请新建会话" },
        400,
      );
    }
    if (request.chatKind !== "worker") {
      return c.json({ error: "bad_dir", message: "只有 worker 会话需要工作目录" }, 400);
    }
    const pick = resolveChatDir(request.dirPath, projectsStore());
    if (!pick.ok) return c.json({ error: "bad_dir", message: pick.message }, 400);
    chatDir = pick.pick;
  }
  let chat = await openChat(
    requestedId,
    undefined,
    // 种类只在新建分支采用：续话不能靠这个字段改身份（下面另有不匹配校验）
    requestedId ? undefined : request.chatKind,
    chatDir,
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
    // 2026-11-17 批1：按链接角色分流——side 对齐这条副会话本身，不再折回 canonical；
    // canonical / group / routine 仍走原来的 partnerIdOfSession → ensurePartnerSession。
    if (kind === "partner" && COMPANIONS_ENABLED) {
      const store = partnersStore();
      const link = store.linkOfSession(chat.internalId);
      const plan = partnerContinuePlan(link?.role ?? null, sideSessionsEnabled());
      if (plan === "side") {
        const ok = await alignPartnerSideSession(chat, link!.partnerId).catch(() => false);
        if (!ok) {
          return c.json(
            { error: "partner_inactive", message: "执事当前是暂停或归档状态，先恢复再继续" },
            409,
          );
        }
      } else if (plan === "reject") {
        return c.json({ error: "side_session_disabled", message: "副会话已关闭" }, 409);
      } else {
        const partnerId = store.partnerIdOfSession(chat.internalId);
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
  }

  return streamSSE(c, async (stream) => {
    const id = crypto.randomUUID();

    // 时间线账（2026-11-17）：把本轮单号登记给内部会话 id，钩子按内部 id 挂事件。
    // 与 SSE start/done.id 是同一个 uuid——日志和对外帧共用单号，搜一个号看全一轮。
    beginTurn(chat.internalId, id);
    recordTimelineEvent({ turnId: id, conversationId: chat.internalId, kind: "start" });

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
          recordTimelineEvent({
            turnId: id,
            conversationId: chat.internalId,
            kind: "usage",
            count: event.usage.input + event.usage.output + event.usage.cacheRead,
          });
          continue;
        }
        // 工具调用撞上限 / 一轮没给出回答（批 32）：都透成 error 帧。
        // `code`（稳定类别）与 `detail`（已脱敏摘要）跟着 unanswered 一起带给前端，
        // 供错误卡决定措辞与「详情」小窗内容；老客户端多收两个可选字段无害。
        streamEnd = "error";
        const described =
          event.type === "unanswered" ? { code: event.code, detail: event.detail } : {};
        // 时间线只记错误类别枚举（event.code 已脱敏），detail 正文绝不入账。
        recordTimelineEvent({
          turnId: id,
          conversationId: chat.internalId,
          kind: "error",
          name: event.type === "unanswered" ? event.code : "stream_error",
        });
        await send({
          type: "error",
          message: event.message,
          ...described,
        }).catch(() => undefined);
      }
    } catch (error) {
      streamEnd = "error";
      const detail = error instanceof Error ? error.message : String(error);
      // 时间线只记错误类别枚举，绝不记原始 message（可能带上游地址 / key 片段）。
      recordTimelineEvent({ turnId: id, conversationId: chat.internalId, kind: "error", name: "model_error" });
      // 原始错误只进服务端日志：里面可能带上游地址甚至 key 片段。
      console.error(`[chat ${id}] 生成失败: ${detail}`);
      // 这里的 detail 是异常 message（服务端内部错误，非上游原文），照旧脱敏后下发
      const described = describeStreamError("model_error", detail);
      await send({
        type: "error",
        message: described?.message ?? "生成失败，请稍后重试",
        ...(described?.code ? { code: described.code } : {}),
        ...(described?.detail ? { detail: described.detail } : {}),
      }).catch(() => undefined);
    }

    // 客户端已断开时这里会抛，属正常路径，吞掉。
    await send({
      type: "done",
      id,
      finishReason: streamEnd,
      ...(turnUsage ? { usage: turnUsage } : {}),
    }).catch(() => undefined);

    // 时间线收尾：结束状态 + 字数 + 耗时（都是枚举/数字，无正文）。
    recordTimelineEvent({
      turnId: id,
      conversationId: chat.internalId,
      kind: "done",
      name: streamEnd,
      ms: Date.now() - startedAt,
      chars,
    });
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
 * 从回答分支（2026-11-17 批3a）：把复制计划逐条 append 到新会话。
 *
 * compaction 的 `head` / `edits[].target` 在计划里已摘掉、只留下标映射；这里维护
 * `复制下标 → 真实新 id`，追加到一条就回填它们。前向 head（真实 compaction）已在计划里
 * 展平成普通摘要条目，不在这里处理。不设 durable parent（设了历史会在源与副本各出现一遍），
 * 来源只写 ChatOrigins。
 */
/**
 * 分支来源 / 副本标题的兜底（2026-11-17 批3b 验收补）：源会话没改过名时，
 * `chatTitles()` 是空的；取第一条用户消息首行，别让来源行只能写「一条会话」。
 */
function firstUserLineOf(
  entries: ReadonlyArray<{ kind: string; model?: readonly unknown[] }>,
): string {
  for (const entry of entries) {
    if (entry.kind !== "pi.user") continue;
    const message = entry.model?.[0] as { content?: unknown } | undefined;
    const text = message
      ? contentText(message.content as Parameters<typeof contentText>[0]).trim()
      : "";
    if (text) return text.split(/\r?\n/, 1)[0].slice(0, 40);
  }
  return "";
}

async function appendBranchEntries(tx: Tx, destinationId: number, plan: BranchPlan): Promise<void> {
  const headRemaps = new Map(plan.headRemaps.map((item) => [item.entryIndex, item.headIndex]));
  const editRemaps = new Map<number, Array<{ editIndex: number; targetIndex: number }>>();
  for (const item of plan.editRemaps) {
    const list = editRemaps.get(item.entryIndex) ?? [];
    list.push({ editIndex: item.editIndex, targetIndex: item.targetIndex });
    editRemaps.set(item.entryIndex, list);
  }
  const newIds: number[] = [];
  for (let index = 0; index < plan.entries.length; index += 1) {
    const draft: Record<string, unknown> = { ...plan.entries[index] };
    // EntryDraft 不接受源会话分配的身份字段
    delete draft.id;
    delete draft.conversationId;
    delete draft.byTaskId;
    const headRemap = headRemaps.get(index);
    if (headRemap !== undefined) {
      const headId = newIds[headRemap];
      if (headId !== undefined) draft.head = headId;
      else delete draft.head;
    }
    const edits = editRemaps.get(index);
    if (edits && Array.isArray(draft.edits)) {
      // 先克隆再改，别动计划对象；目标新 id 尚不存在（被丢弃 / 顺序异常）就删掉这条 edit。
      const cloned = (draft.edits as Array<Record<string, unknown>>).map((edit) => ({ ...edit }));
      const drop = new Set<number>();
      for (const { editIndex, targetIndex } of edits) {
        const targetId = newIds[targetIndex];
        if (targetId === undefined) drop.add(editIndex);
        else cloned[editIndex].target = targetId;
      }
      const kept = cloned.filter((_, editIndex) => !drop.has(editIndex));
      if (kept.length > 0) draft.edits = kept;
      else delete draft.edits;
    }
    const appended = await tx.appendEntry(destinationId as never, draft as never);
    newIds[index] = Number(appended.id);
  }
}

/**
 * `POST .../chat/:conversationId/branches`，body `{ atMessageId, title? }`（2026-11-17 批3a）。
 *
 * 从某条**助手回答**另开一支：复制源会话从 1 到该回答的全部条目（usage 清零、
 * compaction head 重映射）到一条新会话；源会话只读、不改。
 * 执事会话的新分支 = 同一人设下的 side 会话（走 createPartnerSideSession，身份/记忆/项目照旧）；
 * worker / chief 则建一条独立会话并继承种类 / 项目 / 工作目录 / 模型。
 * 返回 `{ok:true, conversationId, entries}`；不写消息、不跑模型（分叉点就是最后一条）。
 */
app.post("/api/v1/agent/chat/:conversationId/branches", async (c) => {
  // 会话分叉回滚开关（2026-11-18 插件清单）：false → 404；前端按 /agent/policy 的 chatBranch 收起入口。
  if (!chatBranchEnabled()) {
    return c.json({ error: "chat_branch_disabled", message: "会话分叉已关闭（CHAT_BRANCH_ENABLED=false）" }, 404);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { atMessageId?: unknown; title?: unknown }
    | null;
  const atMessageId = typeof body?.atMessageId === "string" ? body.atMessageId.trim() : "";
  if (!atMessageId) {
    return c.json({ error: "bad_request", message: "需要 atMessageId" }, 400);
  }
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 80) : "";

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);
  if (await conversationIsBusy(chat.conversation)) {
    return c.json({ error: "conversation_busy", message: "这一轮还在跑，等它结束再分叉" }, 409);
  }

  const view = await chat.conversation.context(CTX);
  const index = view.entries.findIndex(
    (entry) =>
      entry.kind === "pi.assistant" &&
      messageIdOf(chat.externalId, Number(entry.id)) === atMessageId,
  );
  if (index < 0) {
    return c.json({ error: "branch_point_not_found", message: "这条回答不在这个会话里" }, 400);
  }
  const planned = planBranchCopy(view.entries as Parameters<typeof planBranchCopy>[0], index);
  if (!planned.ok) {
    const errorOf = {
      not_assistant: "branch_point_not_found",
      empty: "branch_point_empty",
      too_large: "branch_too_large",
    } as const;
    return c.json({ error: errorOf[planned.reason], message: planned.message }, 400);
  }

  const harness = await getHarness();
  const sourceAgent = await chat.conversation.agent(CTX);
  // 来源标题：用户改过名优先；没改过取首句首行（否则来源行只能写「一条会话」）。
  const sourceTitle = chatTitles()[chat.externalId] || firstUserLineOf(view.entries) || undefined;
  const origin = {
    source: chat.externalId,
    ...(sourceTitle ? { sourceTitle } : {}),
    at: Date.now(),
    // 分叉点（2026-11-17 画板批）：画板靠它把副本的第一张问卡挂回母会话那张答卡；
    // 老数据没有这个字段，画板按时间戳兜底。
    atMessageId,
  };
  const link = partnersStore().linkOfSession(chat.internalId);
  // 群成员 / 例行 / 课题专线不能分支：落到下面的 worker/chief 会把它复制成一条总管会话，
  // 身份（群成员轮次 / 例行归属）就丢了（2026-11-17 批3b）。
  if (link && link.role !== "canonical" && link.role !== "side") {
    return c.json({ error: "branch_not_supported", message: "这类会话不能分支" }, 400);
  }
  const isPartnerLine = link && (link.role === "canonical" || link.role === "side");

  // 执事分支 = 新建 side：插件关时必须明确说"副会话已关闭"，不能落到看似的 partner_inactive。
  if (isPartnerLine && !sideSessionsEnabled()) {
    return c.json({ error: "side_sessions_disabled", message: "副会话已关闭" }, 400);
  }

  let destinationId: string;
  if (isPartnerLine && link) {
    // 执事：同一人设下新建 side 会话（内部已对齐身份、钉工作目录、登记链接）
    const dest = await createPartnerSideSession(link.partnerId);
    if (!dest) {
      return c.json({ error: "partner_inactive", message: "执事当前不可用，先恢复再分叉" }, 409);
    }
    destinationId = dest.externalId;
    await dest.conversation.commit(async (tx) => {
      await appendBranchEntries(tx, Number(dest.conversation.id), planned.plan);
      const origins = await tx.doc(ChatOrigins);
      origins.byExternal[dest.externalId] = origin;
    }, CTX);
  } else {
    // worker / chief：新建独立会话，init 同一事务里落映射表 + 复制条目 + 来源
    const externalId = crypto.randomUUID();
    const kind = (await chatKindOf(chat)) === "worker" ? "worker" : "chief";
    const sourceProjectId =
      kind === "worker"
        ? (await harness.snapshot(ChatProjects, CTX))?.byInternal?.[String(chat.internalId)]
        : undefined;
    const init = async (tx: Tx, conversationId: number) => {
      const chats = await tx.doc(ChatsDoc);
      chats.byExternal[externalId] = Number(conversationId);
      const kinds = await tx.doc(ChatKindsDoc);
      kinds.byInternal[String(conversationId)] = kind;
      if (sourceProjectId) {
        const projects = await tx.doc(ChatProjects);
        projects.byInternal[String(conversationId)] = sourceProjectId;
      }
      await appendBranchEntries(tx, conversationId, planned.plan);
      const origins = await tx.doc(ChatOrigins);
      origins.byExternal[externalId] = origin;
    };
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        // 同模型（含思考档后缀），不回到默认模型
        agent: { model: sourceAgent.model },
        init,
      },
      CTX,
    );
    destinationId = externalId;
    // cwd 继承：读得到才写（与 openChat 的会话绑定即快照同口径）
    if (sourceAgent.cwd) {
      try {
        await conversation.configure({ cwd: sourceAgent.cwd }, CTX);
      } catch (error) {
        console.warn(
          `[branch] 工作目录继承失败，按回落处理: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // 副本默认带「副本 · <来源标题>」，否则列表里两条会话同名，只能靠来源行分。
  renameChat(destinationId, title || `副本 · ${sourceTitle || "一条会话"}`);
  console.log(
    `[branch] ${chat.externalId} → ${destinationId}：复制 ${planned.plan.count} 条` +
      (planned.plan.flattenedCompaction
        ? `，展平前向压缩 ${planned.plan.flattenedCompaction} 条`
        : "") +
      (planned.plan.droppedCompaction
        ? `，丢弃失效压缩 ${planned.plan.droppedCompaction} 条`
        : "") +
      (planned.plan.editRemaps.length ? `，重映射上下文覆盖 ${planned.plan.editRemaps.length} 条` : ""),
  );
  return c.json({ ok: true, conversationId: destinationId, entries: planned.plan.count });
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
 *
 * 分页（2026-11-13 方案「按天分组·上滑加载」）：可选 `page=1` / `before=<不透明游标>`，
 * 任一出现即走倒序游标分页 —— 服务端只读这一页 entry，响应多 `hasMore` / `nextBefore`。
 * **两个参数都不带时行为与改动前逐字一致**（手机端零改动）；`CHAT_HISTORY_PAGING_ENABLED=false`
 * 时即使带了也忽略，退回老形态。
 */
app.get("/api/v1/agent/chat/:conversationId/messages", async (c) => {
  if (!readLlmConfig()) return c.json({ messages: [] });

  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  const beforeRaw = c.req.query("before");
  const paged =
    chatHistoryPagingEnabled() &&
    (c.req.query("page") === "1" || (beforeRaw ?? "") !== "");

  let messages: Awaited<ReturnType<typeof readTranscript>>;
  /** 分页模式才带；空对象 spread 后老响应形状不变 */
  const pageFields: { hasMore?: boolean; nextBefore?: string } = {};
  if (paged) {
    const limitRaw = c.req.query("limit");
    const limit =
      limitRaw === undefined || limitRaw === "" ? HISTORY_PAGE_DEFAULT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_MAX) {
      return c.json(
        { error: "bad_request", message: `limit 必须是 1..${HISTORY_PAGE_MAX} 的整数` },
        400,
      );
    }
    let beforeMaxEntryId: number | undefined;
    if ((beforeRaw ?? "") !== "") {
      const decoded = decodeHistoryCursor(chat.externalId, beforeRaw as string);
      if (decoded === null) {
        return c.json({ error: "bad_request", message: "before 游标无效" }, 400);
      }
      beforeMaxEntryId = decoded;
    }
    const page = await readTranscriptPage(chat, {
      limit,
      ...(beforeMaxEntryId === undefined ? {} : { beforeMaxEntryId }),
    });
    messages = page.messages;
    pageFields.hasMore = page.hasMore;
    if (page.nextBefore) pageFields.nextBefore = page.nextBefore;
  } else {
    const limit = Number(c.req.query("limit") ?? 50);
    messages = await readTranscript(chat, Number.isFinite(limit) ? limit : 50);
  }
  // 会话种类（2026-11-06 B2）：前端据此恢复"普通 worker / 总管"身份，不按 id 猜
  const chatKind = await chatKindOf(chat);
  // 分支来源（2026-11-17 批3b，纯增量）：只有副本会话才有；分页 / 全量与补帧两条路都带。
  const origin = (await (await getHarness()).snapshot(ChatOrigins, CTX))?.byExternal?.[chat.externalId];

  const sinceRaw = c.req.query("sinceSeq");
  const eventStore = chatEventStoreOf();
  if (sinceRaw === undefined || sinceRaw === "" || !eventStore) {
    return c.json({
      conversationId: chat.externalId,
      messages,
      chatKind,
      ...pageFields,
      ...(origin ? { origin } : {}),
    });
  }
  const sinceSeq = Number(sinceRaw);
  if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
    return c.json({ error: "bad_request", message: "sinceSeq 必须是非负整数" }, 400);
  }
  const { from, events } = eventStore.replaySince(chat.internalId, Math.floor(sinceSeq));
  return c.json({
    conversationId: chat.externalId,
    messages,
    chatKind,
    ...pageFields,
    ...(origin ? { origin } : {}),
    fromSeq: from,
    events,
  });
});

/**
 * 会话画板（2026-11-17 画板批，方案 `docs/设计方案/2026-11-17-会话画板（单会话回合卡）.md`）。
 *
 * `GET .../chat/:conversationId/map`：一次回根会话 + 全部后代（来源链向上找根、向下 BFS），
 * 每节点带「分叉点之后」的回合预览。只读，不写布局、不改会话。
 * `CHAT_MAP_ENABLED=false` → 404（一行回滚；前端按钮同时按 /agent/policy 的 chatMap 收起）。
 */
app.get("/api/v1/agent/chat/:conversationId/map", async (c) => {
  if (!chatMapEnabled()) {
    return c.json({ error: "chat_map_disabled", message: "会话地图已关闭" }, 404);
  }
  const map = await buildChatMap(c.req.param("conversationId"));
  if (!map) return c.json({ error: "unknown_conversation" }, 404);
  return c.json(map);
});

/**
 * 画板详情：按可寻址 id 取单条消息全文（地图接口只回 1200 字预览）。
 * 与 /messages 同一套回合投影，隐藏的定时触发不在列表里，因此也取不到（口径一致）。
 */
app.get("/api/v1/agent/chat/:conversationId/messages/:messageId", async (c) => {
  if (!chatMapEnabled()) {
    return c.json({ error: "chat_map_disabled", message: "会话地图已关闭" }, 404);
  }
  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);
  const message = await readSingleTranscriptMessage(chat, c.req.param("messageId"));
  if (!message) return c.json({ error: "unknown_message" }, 404);
  return c.json({ message });
});

/**
 * 注入审计（2026-11-10 批 26b §二 / #7 批 A；批 27 §四扩到全部注入）。
 *
 * `GET /api/v1/agent/chat/:conversationId/injections` → `[{id, source, scope, channel, length}]`：
 * 框架当前接管的注入清单（`source` 区分 `lifecycle` / `assist` / `partner-context`）。
 * **只回元数据、不回正文**（`length` 是正文字符数），所以即便正文是固定提示词也不会从这里泄露。
 *
 * 开关 `AGENT_INJECTION_AUDIT`（默认开；显式 `false` → 404，一行回滚，与 TOPICS/导出同口径）。
 *
 * 会尽量把会话解析成内部 id / 种类 / 执事，好让 persona、执事纪律这些"按身份分流"的条目
 * 与真实一轮一致；解析不到（未配置 LLM / 会话不存在）就按原始 id 出清单，绝不 500。
 * `dryRun` 保证读端点无副作用：课题不吞简报、技能不冻结索引、任务近况不摄入日记；
 * 执事「当前在办」也不列（它要扫 runs/ 目录 + 开 SQLite，付不起这份代价）。
 */
app.get("/api/v1/agent/chat/:conversationId/injections", async (c) => {
  if (!injectionAuditEnabled()) return c.json({ error: "not_found" }, 404);
  const raw = c.req.param("conversationId");
  let conversationId: number | string = raw;
  let chatKind: "chief" | "worker" | null = null;
  let partnerId: string | null = null;
  try {
    const chat = await openChat(raw);
    if (chat) {
      conversationId = chat.internalId;
      chatKind = (await chatKindOf(chat)) === "worker" ? "worker" : "chief";
      partnerId = COMPANIONS_ENABLED ? partnersStore().partnerIdOfSession(chat.internalId) : null;
    }
  } catch {
    // 解析失败 = 只按原始 id 出静态清单（诊断端点不能因为会话读不到就 500）
  }
  return c.json(
    auditInjections(INJECTION_REGISTRY, {
      conversationId,
      chatKind,
      partnerId,
      dryRun: true,
    }),
  );
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

/**
 * 用量与花费：按模型累计，来自 durable 自己维护的 pi.usage。
 *
 * 2026-11-15 加 `range=7d|30d`：近 N 个自然日（含今天）改用每条 assistant entry
 * 自带的 `timestamp` + `usage` 还原（pi.usage 只有按会话累计，没有逐日流水）。
 * 不带 `range` 或值不认识 = 原来的全部累计，旧客户端零改动。
 */
app.get("/api/v1/agent/usage", async (c) => {
  if (!readLlmConfig()) return c.json({ models: [] });
  const range = c.req.query("range")?.trim();
  if (range === "7d" || range === "30d") {
    return c.json(await usageSummary({ days: range === "7d" ? 7 : 30 }));
  }
  return c.json(await usageSummary());
});

/**
 * 工具用量（2026-11-17，方案 docs/设计方案/2026-11-17-工具调用计数.md）：
 * 每个工具真实执行的次数（成败分桶）+ 被 tool_search 按需加载的次数，
 * 全部累计、无区间——给"按使用频率动态调整上下文"当数据底座。
 * 开关 TOOL_USAGE=false → 404（前端据此整卡隐藏），与账本停记同一行回滚。
 */
app.get("/api/v1/agent/tool-usage", (c) => {
  if (!toolUsageEnabled()) return c.json({ error: "tool_usage_disabled" }, 404);
  return c.json({ tools: toolUsageRows() });
});

/**
 * 全局工具池（2026-11-17 设置→工具页）：哪些工具进"按需"池（初始不进前缀，
 * 由 tool_search 按需加载），其余全部常驻。目录 / 分组 / 摘要复用 partner-tools，
 * 定义大小与 token 口径同上下文页（紧凑 JSON + estimateTokens）。
 *
 * **生效边界**：deferred 是工具注册期属性，PUT 只写 `.data/tool-pool.json`，
 * 必须重启服务（重开 Harness）才生效；GET 用 `restartPending` 告诉前端"已保存待重启"。
 */
mountToolPoolRoutes(app, {
  catalog: () => modelToolCatalog(),
  summaryOf: toolSummaryOf,
  indexEnabled: () => toolIndexEnabled(),
});

/**
 * 一轮对话的时间线（2026-11-17）：按 SSE 流 id（`turnId`，即 /chat 的 start/done.id）
 * 把该轮的工具调用 / 闸门拦截 / 模型回合 / token 用量 / 收尾聚合成一条时间线。
 * 只返回脱敏字段（枚举 / 计数 / 字数 / 耗时），不含任何对话正文或内部 id。
 * 开关 TURN_TIMELINE=false → 404（与账本停记同一行回滚）。
 */
app.get("/api/v1/agent/turn-timeline", (c) => {
  if (!turnTimelineEnabled()) return c.json({ error: "turn_timeline_disabled" }, 404);
  const turnId = c.req.query("turnId")?.trim();
  if (!turnId) return c.json({ error: "bad_request", message: "缺少 turnId" }, 400);
  return c.json({ turnId, events: readTurnTimeline(turnId) });
});

/**
 * 全部数据导出（2026-11-05 J1，接口文档 §2.5）。
 *
 * 用户拍板：导出进设置页，单对话导出退役。这里只聚合「可见数据」——
 * 会话清单复用 listChats（已排除 hide / task-），消息走 §2.2 同一条读取路径，
 * providers 用 modelCatalog 投影（无 keyEnv，密钥永不出内）。
 * 任何一步失败就整体 503，不出半份。
 *
 * 2026-11-13 升级：新增 `format=zip`（可选块 / 多文件 / 压缩包，见 export-bundle.ts），
 * `format=json` 分支逐字节保持原样——老客户端与回滚都靠它。
 */
const EXPORT_CHAT_LIMIT = 5000;
const EXPORT_MESSAGE_LIMIT = 500;

app.get("/api/v1/agent/export", async (c) => {
  const format = (c.req.query("format") ?? "json").trim().toLowerCase();

  if (format === "zip") {
    // 回滚开关：关 = 这个形态不存在（json 形态不受影响）
    if (!exportBundleEnabled()) return c.json({ error: "not_found" }, 404);

    const parts = parseExportParts(c.req.query("parts"));
    if (!parts) {
      return c.json(
        {
          error: "bad_request",
          message: `parts 只能是 ${EXPORT_PART_IDS.join(" / ")} 里的值，逗号分隔`,
        },
        400,
      );
    }
    const images = parseExportImages(c.req.query("images"));
    if (images === null) {
      return c.json({ error: "bad_request", message: "images 只能是 0 或 1" }, 400);
    }

    try {
      const bundle = await buildExportBundle({ parts, images });
      const partRows = bundle.manifest["parts"] as { status?: string }[] | undefined;
      if (partRows?.every((part) => part.status === "failed")) {
        return c.json({ error: "export_failed", message: "请求的每一块都没读出来" }, 503);
      }

      // 只记块名 / 条数 / 字节，不含任何对话内容
      console.log(
        `[export] zip parts=${parts.join(",")} files=${bundle.files} bytes=${bundle.bytes} partial=${bundle.partial}`,
      );
      c.header("Content-Type", "application/zip");
      c.header("Content-Disposition", `attachment; filename="${bundle.fileName}"`);
      c.header("Cache-Control", "no-store");
      c.header("X-Export-Files", String(bundle.files));
      c.header("X-Export-Bytes", String(bundle.bytes));
      if (bundle.partial) c.header("X-Export-Partial", "1");
      return c.body(bundle.buffer as unknown as ArrayBuffer);
    } catch (error) {
      if (error instanceof ExportTooLargeError) {
        return c.json({ error: "export_too_large", message: error.message }, 413);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[export] zip 失败: ${message}`);
      return c.json({ error: "export_failed", message }, 503);
    }
  }

  if (format !== "json") {
    return c.json({ error: "bad_request", message: "format 只能是 json 或 zip" }, 400);
  }

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
        messages: messages.map(({ role, at, text, images, files }) => ({
          role,
          at,
          text,
          ...(images ? { images } : {}),
          ...(files ? { files } : {}),
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

/**
 * 设置 → 上下文（2026-11-16，接口文档 §2.2.4）。
 *
 * 只读：从 conversation.context() 重放当前 system prompt / tools，加上 beforeRequest
 * 首轮记下的临时注入实文；不重新跑记忆召回（recall 会回写使用计数）。
 * 回滚：`CHAT_CONTEXT_INSPECT=false` → 404。
 */
app.get("/api/v1/agent/chat/:conversationId/context-inspect", async (c) => {
  if (!chatContextInspectEnabled()) return c.json({ error: "not_found" }, 404);
  const chat = await openChat(c.req.param("conversationId"));
  if (!chat) return c.json({ error: "unknown_conversation" }, 404);

  const view = await chat.conversation.context(CTX).catch(() => null);
  if (!view) return c.json({ error: "context_unavailable" }, 503);
  const usage = await contextUsageOf(chat.conversation, view).catch(() => null);
  const chatKind = await chatKindOf(chat).catch(() => null);
  c.header("cache-control", "no-store");
  return c.json(
    contextInspectPayloadOf({
      conversationId: chat.externalId,
      title: chatTitles()[chat.externalId] ?? null,
      chatKind,
      usage: usage ? { used: usage.used, window: usage.window } : null,
      view,
      memoryEnabled: Boolean(memoryEngine),
      lastInjections: lastRequestInjectionsOf(chat.internalId),
    }),
  );
});

/**
 * 设置 → 上下文 · 默认开销（2026-11-16 续）。
 *
 * 不创建会话、不读聊天记录：按角色（总管 / 每个活跃执事 / 普通 worker）显式装配
 * “全新会话会读到的固定前缀”。工具取真实 extension；技能走预览索引不冻结；
 * 记忆只回预算，不回召回正文。
 * 回滚同上：`CHAT_CONTEXT_INSPECT=false` → 404。
 */
app.get("/api/v1/agent/context-defaults", async (c) => {
  if (!chatContextInspectEnabled()) return c.json({ error: "not_found" }, 404);
  const role = c.req.query("role") || undefined;
  let payload: Awaited<ReturnType<typeof contextDefaultPayload>>;
  try {
    payload = await contextDefaultPayload(role);
  } catch {
    return c.json({ error: "context_defaults_unavailable" }, 503);
  }
  if (!payload) return c.json({ error: "unknown_role" }, 404);
  c.header("cache-control", "no-store");
  return c.json(payload);
});

// Worker 人设 GET/PUT（2026-11-16）：鉴权沿用 /api/v1/* 中间件，不另写。
mountWorkerPersonaRoutes(app);

// native worker 工具面 GET/PUT（2026-11-17 批4）：普通助手页勾选，仅本机工人。
mountWorkerToolsRoutes(app);

/** 内容级跨会话搜索（批次二）：逐会话 LIKE，q 最少 2 字符（见接口文档 §2.5） */
app.get("/api/v1/agent/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (q.trim().length < 2) return c.json({ hits: [] });
  if (!readLlmConfig()) return c.json({ hits: [] });
  return c.json({ hits: await searchTranscripts(q, 20) });
});

/**
 * 旧会话「找旧事」只读搜索（2026-11-10 批 28 §二，接口文档 §2.5）。
 *
 * 与上面的 `/agent/search` 刻意分开：那条走 `searchTranscripts`（跳过任务专线与隐藏会话），
 * 这条复用 `recall_sessions` 的 `searchSessions`（覆盖全部会话、snippet 脱敏截断），
 * 并给每条命中补一个 `aroundIndex`（定位口径与 §2.2.2 同源）。
 *
 * 消费方（2026-11-12 起）：独立搜索页 `#/search` 的原文段走本端点（界面只留这一个搜索）；
 * 点一条按 `at` 跳回原会话并定位到那一句。分页用 `offset + limit`，响应额外回 `total`
 * （未分页的命中总数）给"还有 N 处 / 查看更多"用；`total` 不是稳定快照，只作展示。
 * `aroundIndex` 仍是稳定的绝对下标，留给需要前后文窗口的消费者（§2.2.2 端点保留）。
 *
 * 只读：只 `getHarness()` / `openChat()` / `readTranscript()` 读 durable，不写、不开新会话。
 * 回滚：`AGENT_SESSIONS_SEARCH=false` → 404（整组端点不启用）。
 */
app.get("/api/v1/agent/sessions/search", async (c) => {
  if (!sessionSearchApiEnabled()) return c.json({ error: "not_found" }, 404);
  const parsed = parseSessionSearchQuery({
    q: c.req.query("q") ?? undefined,
    days: c.req.query("days") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
    offset: c.req.query("offset") ?? undefined,
  });
  if (!parsed) {
    return c.json({ error: "bad_request", message: "q 至少 2 个字符" }, 400);
  }

  const page = await searchSessionsPage(await getHarness(), parsed.query, parsed.options);
  // 每条命中补一个与定点找回同源的下标：按会话缓存正文，避免同会话多命中重复读。
  const messagesByConversation = new Map<string, Awaited<ReturnType<typeof readTranscript>>>();
  const enriched: Array<(typeof page.hits)[number] & { aroundIndex: number }> = [];
  for (const hit of page.hits) {
    let messages = messagesByConversation.get(hit.conversationId);
    if (!messages) {
      const chat = await openChat(hit.conversationId);
      messages = chat ? await readTranscript(chat, 0) : [];
      messagesByConversation.set(hit.conversationId, messages);
    }
    enriched.push({ ...hit, aroundIndex: findAroundIndex(messages, hit, parsed.query) });
  }
  return c.json({ hits: enriched, total: page.total });
});

/**
 * 解析提醒的时间规则（2026-11-14）。
 *
 * 契约：`repeat` = none / daily / weekly / monthly。
 * - weekly 需要 `weekdays`（0 = 周日 … 6 = 周六，可多选）；
 * - monthly 需要 `dayOfMonth`（1–31，小月落到月末）；
 * - `until` 是区间结束（含当天），仅对周期提醒有意义；一次性提醒忽略。
 * 时间统一收成 epoch 毫秒，避免客户端和服务端时区口径分叉。
 */
type ReminderScheduleBody = {
  at?: string | number;
  repeat?: unknown;
  weekdays?: unknown;
  dayOfMonth?: unknown;
  until?: unknown;
};

function parseReminderTime(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseReminderSchedule(body: ReminderScheduleBody | null):
  | {
      at: number;
      repeat: "none" | "daily" | "weekly" | "monthly";
      weekdays?: number[];
      dayOfMonth?: number;
      until?: number;
    }
  | { error: string } {
  const rawAt = parseReminderTime(body?.at);
  if (rawAt === null) return { error: "at 需要 ISO 时间或毫秒时间戳" };

  const repeat = body?.repeat === undefined ? "none" : body.repeat;
  if (repeat !== "none" && repeat !== "daily" && repeat !== "weekly" && repeat !== "monthly") {
    return { error: "repeat 只能是 none / daily / weekly / monthly" };
  }

  let weekdays: number[] | undefined;
  if (repeat === "weekly") {
    if (!Array.isArray(body?.weekdays) || body.weekdays.length === 0) {
      return { error: "weekly 需要 weekdays（0 = 周日 … 6 = 周六）" };
    }
    const parsed = Array.from(
      new Set(
        body.weekdays
          .map((value) => (typeof value === "number" ? Math.trunc(value) : NaN))
          .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
      ),
    ).sort();
    if (parsed.length === 0) return { error: "weekdays 只能是 0–6" };
    weekdays = parsed;
  }

  let dayOfMonth: number | undefined;
  if (repeat === "monthly") {
    const parsed = typeof body?.dayOfMonth === "number" ? Math.trunc(body.dayOfMonth) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
      return { error: "monthly 需要 dayOfMonth（1–31）" };
    }
    dayOfMonth = parsed;
  }

  let until: number | undefined;
  if (repeat !== "none" && body?.until !== undefined && body.until !== null) {
    const parsed = parseReminderTime(body.until);
    if (parsed === null) return { error: "until 需要 ISO 时间或毫秒时间戳" };
    until = parsed;
  }

  let at = rawAt;
  if (repeat === "none") {
    if (at <= Date.now()) return { error: "at 已经过去了" };
  } else {
    // at 是「几点」的锚点，不是周期提醒的首次日期：按规则推到 now 之后的第一跳。
    // 这样编辑一条今天已经响过的每日提醒、或 Agent 随手给个 at，也不会先错响一次。
    const next = nextReminderAt({ text: "", at: rawAt, repeat, weekdays, dayOfMonth });
    if (next === null) return { error: "这个重复规则找不到下一次触发时间" };
    if (until !== undefined && next > until) {
      return { error: "until 之前没有可触发的时间" };
    }
    at = next;
  }
  if (until !== undefined && until <= at) {
    return { error: "until 必须晚于第一次触发" };
  }

  return { at, repeat, weekdays, dayOfMonth, until };
}

/** 还没响的提醒（读 durable 的任务图）；`includePaused=1` 才带暂停中的任务。 */
app.get("/api/v1/agent/reminders", async (c) => {
  if (!readLlmConfig()) return c.json({ reminders: [] });
  const reminders = await listReminders();
  // 2026-11-17：手机端不传这个参数 → 继续只同步真会响的；桌面设置页传 1 才能看到暂停项。
  const includePaused = c.req.query("includePaused") === "1";
  return c.json({ reminders: includePaused ? reminders : reminders.filter((item) => item.enabled) });
});

/**
 * 直接加一个提醒，不经过模型。
 *
 * 2026-11-12 扩展：`repeat`（每天自动续排）、`partnerId`（目标执事）；
 * 2026-11-14 扩展：weekly / monthly / `until` 区间（手动图形化创建的三种新规则）。
 * 不传 `partnerId` 时行为与旧版一致（`conversationId` 或默认会话）。
 */
app.post("/api/v1/agent/reminders", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | (ReminderScheduleBody & {
        conversationId?: string;
        text?: string;
        partnerId?: unknown;
        enabled?: unknown;
        visibility?: unknown;
      })
    | null;
  const text = body?.text?.trim();
  if (!text || !body?.at) {
    return c.json({ error: "bad_request", message: "需要 text 和 at" }, 400);
  }
  if (text.length > 100_000) {
    return c.json({ error: "bad_request", message: "text 超过 100k 上限" }, 400);
  }
  if (body?.enabled !== undefined && typeof body.enabled !== "boolean") {
    return c.json({ error: "bad_request", message: "enabled 必须是布尔值" }, 400);
  }
  if (
    body?.visibility !== undefined &&
    body.visibility !== "hidden" &&
    body.visibility !== "visible"
  ) {
    return c.json({ error: "bad_request", message: "visibility 只能是 hidden / visible" }, 400);
  }
  const schedule = parseReminderSchedule(body);
  if ("error" in schedule) return c.json({ error: "bad_request", message: schedule.error }, 400);

  const partnerId =
    typeof body?.partnerId === "string" && body.partnerId.trim()
      ? body.partnerId.trim()
      : null;
  if (partnerId === null && body?.partnerId !== undefined && body.partnerId !== null) {
    return c.json({ error: "bad_request", message: "partnerId 必须是字符串或 null" }, 400);
  }

  const chat = partnerId
    ? await ensurePartnerSession(partnerId)
    : await openChat(body?.conversationId);
  if (!chat) {
    return partnerId
      ? c.json({ error: "partner_not_found", message: "执事不存在或已暂停" }, 404)
      : c.json({ error: "unknown_conversation" }, 404);
  }
  const enabled = reminderEnabledOf(body?.enabled);
  const visibility = reminderVisibilityOf(body?.visibility);
  const taskId = await addReminder(chat, {
    text,
    ...schedule,
    partnerId,
    enabled,
    visibility,
  });
  return c.json(
    {
      ok: true,
      taskId,
      conversationId: chat.externalId,
      repeat: schedule.repeat,
      ...(schedule.weekdays ? { weekdays: schedule.weekdays } : {}),
      ...(schedule.dayOfMonth ? { dayOfMonth: schedule.dayOfMonth } : {}),
      ...(schedule.until ? { until: schedule.until } : {}),
      partnerId,
      enabled,
      visibility,
    },
    201,
  );
});

/**
 * 改一条提醒（2026-11-14 只改时间；2026-11-17 扩内容 / 暂停 / 可见性）。
 * 服务端用同一个 `reminderId` 重排，列表不会多出一行"已结束"。
 * 只给 `text` / `enabled` / `visibility` 时沿用原时间规则；给 `at` 才按新规则归一化。
 */
app.patch("/api/v1/agent/reminders/:taskId", async (c) => {
  const taskId = Number(c.req.param("taskId"));
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return c.json({ error: "bad_request", message: "taskId 必须是正整数" }, 400);
  }
  const body = (await c.req.json().catch(() => null)) as
    | (ReminderScheduleBody & {
        text?: unknown;
        enabled?: unknown;
        visibility?: unknown;
      })
    | null;
  if (body?.text !== undefined && (typeof body.text !== "string" || !body.text.trim())) {
    return c.json({ error: "bad_request", message: "text 必须是非空字符串" }, 400);
  }
  if (typeof body?.text === "string" && body.text.length > 100_000) {
    return c.json({ error: "bad_request", message: "text 超过 100k 上限" }, 400);
  }
  if (body?.enabled !== undefined && typeof body.enabled !== "boolean") {
    return c.json({ error: "bad_request", message: "enabled 必须是布尔值" }, 400);
  }
  if (
    body?.visibility !== undefined &&
    body.visibility !== "hidden" &&
    body.visibility !== "visible"
  ) {
    return c.json({ error: "bad_request", message: "visibility 只能是 hidden / visible" }, 400);
  }

  const origin = (await listReminders()).find(
    (item) => item.id === taskId && item.status !== "terminal",
  );
  if (!origin) {
    return c.json({ error: "not_found", message: "没有这条提醒，或已经结束" }, 404);
  }

  let schedule: {
    at: number;
    repeat: ReminderRepeat;
    weekdays?: number[];
    dayOfMonth?: number;
    until?: number;
  };
  if (body?.at !== undefined) {
    const parsed = parseReminderSchedule(body);
    if ("error" in parsed) return c.json({ error: "bad_request", message: parsed.error }, 400);
    schedule = parsed;
  } else {
    schedule = {
      at: origin.at,
      repeat: origin.repeat,
      ...(origin.weekdays ? { weekdays: origin.weekdays } : {}),
      ...(origin.dayOfMonth ? { dayOfMonth: origin.dayOfMonth } : {}),
      ...(origin.until !== undefined ? { until: origin.until } : {}),
    };
  }

  const text = typeof body?.text === "string" ? body.text.trim() : origin.text;
  const enabled = body?.enabled === undefined ? origin.enabled : Boolean(body.enabled);
  const visibility: ReminderVisibility =
    body?.visibility === undefined ? origin.visibility : reminderVisibilityOf(body.visibility);
  const nextId = await rescheduleReminder(taskId, {
    ...schedule,
    text,
    enabled,
    visibility,
  });
  if (nextId === null) {
    return c.json({ error: "not_found", message: "没有这条提醒，或已经结束" }, 404);
  }
  return c.json({
    ok: true,
    taskId: nextId,
    text,
    enabled,
    visibility,
    repeat: schedule.repeat,
    at: schedule.at,
    ...(schedule.weekdays ? { weekdays: schedule.weekdays } : {}),
    ...(schedule.dayOfMonth ? { dayOfMonth: schedule.dayOfMonth } : {}),
    ...(schedule.until !== undefined ? { until: schedule.until } : {}),
  });
});

/**
 * 立即跑一次（2026-11-17 定时任务重做）：手动触发一轮，不动定时链。
 * `SCHEDULED_TASK_MODEL_RUN=false`（回滚形态）时拒绝——那套形态本来就不调模型。
 */
app.post("/api/v1/agent/reminders/:taskId/run_now", async (c) => {
  if (!flagEnabled("SCHEDULED_TASK_MODEL_RUN")) {
    return c.json(
      { error: "bad_request", message: "定时任务当前是回滚形态（不调模型），不能立即跑" },
      400,
    );
  }
  const taskId = Number(c.req.param("taskId"));
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return c.json({ error: "bad_request", message: "taskId 必须是正整数" }, 400);
  }
  const task = await reminderTaskById(taskId);
  if (!task || !task.live) {
    return c.json({ error: "not_found", message: "没有这条提醒，或已经结束" }, 404);
  }
  const result = await invokeScheduledRun({
    conversationId: task.conversationId,
    partnerId: task.partnerId,
    text: task.text,
    visible: task.visibility === "visible",
  });
  if (!result) {
    return c.json(
      { error: "run_unavailable", message: "到点执行器未装配，稍后再试" },
      503,
    );
  }
  recordReminderRun({
    reminderId: task.reminderId,
    partnerId: task.partnerId,
    trigger: "manual",
    status: result.ok ? "success" : "failed",
    at: task.at,
    summary: result.ok ? result.text : "这一轮没跑完（详情看服务端日志）",
  });
  return c.json(
    {
      ok: result.ok,
      text: result.text ?? "",
      ...(result.ok ? {} : { error: result.error ?? "这一轮没跑完" }),
    },
    result.ok ? 200 : 400,
  );
});

/** 某条提醒的执行历史（2026-11-17）：按稳定 reminderId 归组，重排后仍能查到。 */
app.get("/api/v1/agent/reminders/:reminderId/runs", (c) => {
  const reminderId = c.req.param("reminderId").trim();
  if (!reminderId) return c.json({ error: "bad_request", message: "reminderId 不能为空" }, 400);
  return c.json({ ok: true, runs: listReminderRuns(reminderId) });
});

/** 取消一条提醒（2026-11-12）：每日续排的链在取消当前任务后不再续。 */
app.delete("/api/v1/agent/reminders/:taskId", async (c) => {
  const taskId = Number(c.req.param("taskId"));
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return c.json({ error: "bad_request", message: "taskId 必须是正整数" }, 400);
  }
  const cancelled = await cancelReminder(taskId);
  if (!cancelled) {
    return c.json({ error: "not_found", message: "没有这条提醒，或已经结束" }, 404);
  }
  return c.json({ ok: true });
});

// ── 中继（2026-11-05 多端同步方案块1，阶段一）──────────────────────
// RELAY_ENABLED=off（默认）→ 完全不装，回局域网直连形态。
// harness 以设备身份出站长连中继；通道白名单在 relay-channels.ts（默认拒绝）。
let relayClient: RelayClient | null = null;
let relayChannels: RelayChannelHub | null = null;
let homeController: CompanionHomeController | null = null;

/**
 * mobile/proxy 的内部执行体（2026-11-11 批H H1）：直接在进程内把请求喂给 Hono，
 * 不经过网络（免端口自环、免再走一遍 Node HTTP 栈），status 与正文原样回给中继。
 *
 * 鉴权映射：手机带的是中继签发的 deviceToken，与本进程 AGENT_TOKEN 不是同一套
 * （批R 已知简化 + join 流程的固有冲突）。中继在投 invoke 前已经验过 deviceToken，
 * 所以这里**一律用本进程 AGENT_TOKEN** 作为内部凭据；没配令牌时不注入（fail-closed，
 * 内部鉴权会按非本机拒掉）。
 */
async function dispatchRelayHttp(request: RelayHttpRequest): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const name = key.toLowerCase();
    // 逐跳头不带进内部调用（app.request 自己会算 body 长度）
    if (name === "host" || name === "connection" || name === "content-length" || name === "transfer-encoding") {
      continue;
    }
    headers[name] = value;
  }
  const agentToken = process.env.AGENT_TOKEN?.trim();
  if (agentToken) headers.authorization = `Bearer ${agentToken}`;
  const method = request.method.toUpperCase();
  const response = await app.request(`${request.path}${request.query}`, {
    method,
    headers,
    ...(request.body !== null && method !== "GET" && method !== "HEAD" ? { body: request.body } : {}),
  });
  return { status: response.status, body: await response.text() };
}

/** 接入来源：`.env`（部署环境说了算）或 `.data/relay-link.json`（页面里接的）。 */
let relaySource: "env" | "file" | null = null;
/** 状态页用的对外 http 地址与设备名（都是可示人的，不含令牌）。 */
let relayHttpShown = "";
let relayDeviceShown = "";

/**
 * 装配并起客户端（2026-11-14 连接页三步方案：从"启动时一次性装配"抽成可重入）。
 * 页面里「接入中继」换地址时要能停掉旧连接、用新令牌重起——同一进程内完成，不要求重启。
 *
 * 注意：`companionHomeController` 没有 stop，周期校准的定时器会留在旧控制器上（unref、
 * 对已停客户端的调用全在 catch 里）。换地址是低频动作，这里如实不装作清干净了。
 */
function startRelayClient(settings: RelaySettings, source: "env" | "file"): void {
  relayClient?.stop();
  homeController = null;
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
    // 批H H1：反代通道。开关关着 = 不传执行体 = 通道未注册（invoke 一律 404）。
    dispatchHttp: relayMobileProxyEnabled() ? dispatchRelayHttp : undefined,
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
    // 批H H1：中继反代帧（与 routed 通道并行的另一条入站路）
    onInvokeHttp: (payload) => {
      if (!relayChannels) return Promise.resolve({ status: 404, body: JSON.stringify({ error: "not_found" }) });
      return relayChannels.handleHttpInvoke(payload);
    },
    onReconnected: () => {
      void homeController?.ensureDemotion().catch(() => {});
    },
    // RELAY_HEARTBEAT_MS=0 → 不挂心跳（回滚用；默认 20s，见 relay-client.ts 头注）
    ...(() => {
      const raw = (process.env.RELAY_HEARTBEAT_MS ?? "").trim();
      if (!raw) return {};
      const ms = Number.parseInt(raw, 10);
      if (!Number.isFinite(ms) || ms <= 0) return { heartbeatMs: 0, livenessMs: 0 };
      return { heartbeatMs: Math.max(5_000, ms), livenessMs: Math.max(15_000, ms * 2.5) };
    })(),
    log: (line) => console.log(line),
  });
  relayClient.start();
  if (companionHomeEnabled()) {
    homeController = companionHomeController(relayClient);
    homeController.startPeriodicCheck();
  }
  relaySource = source;
  relayHttpShown = normalizeRelayHttpBase(settings.url);
  relayDeviceShown = settings.deviceName;
}

/** 等握手完成（页面点完「接入并连接」要一个确定答复，别让它猜）。 */
async function waitForRelayConnection(timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (relayClient?.connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return relayClient?.connected ?? false;
}

/**
 * 中继身份独占（2026-11-14 稳定性补丁，NS-02）。
 *
 * 一台电脑在中继名册上只有**一个**设备令牌 = 一个 `deviceId`。两个 harness 进程
 * 同时拿这枚令牌连中继时，中继按"同设备顶替"（4409）把旧连接关掉，于是两边互相
 * 顶替、每秒断一次、永远握不上手——线上表现就是"电脑时而连上时而连不上"。
 * 2026-11-14 实测：这台机器上有两个 harness（39847 与 39899 各一个）同时挂着，
 * `relay/status` 的 `reconnects` 三分钟涨到 85、`lastCloseCode` 全是 4409。
 *
 * 这里用一个 pid 文件把"谁来代表这台电脑连中继"钉死：后起的进程发现别人还活着
 * 就不连中继（服务照常起，只是不当这台设备），并把自己的 pid 报给状态页。
 * 进程死了（重启、崩溃）pid 失效，下一个进程自动接管——不会永久卡死。
 */
const RELAY_IDENTITY_LOCK = ".data/relay-identity.pid";
let relayBlockedByPid: number | null = null;

function relayIdentityOwner(): number | null {
  let raw = "";
  try {
    raw = readFileSync(RELAY_IDENTITY_LOCK, "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid; // 活着：身份被别人占着
  } catch {
    return null; // 不存在 / 权限不足：视为已失效，允许接管
  }
}

/** 拿到身份返回 true；被别人占着返回 false（并记下对方 pid 供状态页显示）。 */
function claimRelayIdentity(): boolean {
  // 回滚开关：RELAY_IDENTITY_LOCK=off → 不做互斥（回到"谁先连谁占位、双连互相顶替"的旧形态）
  if ((process.env.RELAY_IDENTITY_LOCK ?? "").trim().toLowerCase() === "off") {
    relayBlockedByPid = null;
    return true;
  }
  const owner = relayIdentityOwner();
  if (owner !== null) {
    relayBlockedByPid = owner;
    return false;
  }
  relayBlockedByPid = null;
  try {
    mkdirSync(".data", { recursive: true });
    writeFileSync(RELAY_IDENTITY_LOCK, `${process.pid}\n`, { mode: 0o600 });
  } catch {
    /* 写不了锁就当没锁：宁可双连也不要因为锁文件起不来 */
  }
  return true;
}

function releaseRelayIdentity(): void {
  try {
    const raw = readFileSync(RELAY_IDENTITY_LOCK, "utf8").trim();
    if (raw === String(process.pid)) rmSync(RELAY_IDENTITY_LOCK, { force: true });
  } catch {
    /* 没有锁文件 / 已被别人接管：都不动 */
  }
}

// 启动选择：`.env` 配齐优先；否则用页面里接过的；都没有 = 未接入（正常态，不报错）。
const envRelaySettings = relayEnabled() ? relaySettings() : null;
if (envRelaySettings || readRelayLink()) {
  if (!claimRelayIdentity()) {
    console.error(
      `[relay] 本机已有一个 harness（pid ${relayBlockedByPid}）在代表这台电脑连中继，本进程不再连——双连会互相顶替（4409）`,
    );
  } else {
    process.once("exit", releaseRelayIdentity);
    if (envRelaySettings) {
      startRelayClient(envRelaySettings, "env");
    } else {
      if (relayEnabled()) {
        console.error("[relay] RELAY_ENABLED 已开但 RELAY_URL / RELAY_TOKEN 未配齐，中继不启动");
      }
      const saved = readRelayLink();
      if (saved) {
        startRelayClient(relaySettingsFromLink(saved), "file");
        console.log(`[relay] 按本机保存的接入信息连接 ${saved.base}（设备名 ${saved.deviceName || "默认"}）`);
      }
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
    enabled: relayClient !== null || relayEnabled(),
    connected: relayClient?.connected ?? false,
    deviceId: relayClient?.selfDeviceId ?? null,
    // 2026-11-14 连接页三步：页面要能区分「没接入 / 接入了但没连上 / 连上了」，
    // 并且知道该拿哪个地址、哪台设备名示人（都不含令牌）。
    configured: relayClient !== null,
    relayUrl: relayHttpShown,
    deviceName: relayDeviceShown,
    source: relaySource,
    subscriptionCount: relayChannels?.subscriptionCount ?? 0,
    onlineDevices: relayClient?.devices.length ?? 0,
    // 2026-11-14 稳定性补丁（NS-02）：本进程没拿到中继身份时，说明同机已有另一个
    // harness 在代表这台电脑连中继——页面据此提示，而不是让人以为"中继坏了"。
    blockedByPid: relayBlockedByPid,
    // 2026-11-14 稳定性补丁：断线原因对页面可见（reconnects/上一个关闭码/最近一次成功连接时间）。
    // 页面据此把"掉一下又回来"显示成「重连中」，而不是红一下绿一下地闪。
    ...(relayClient?.stats ?? {}),
  });
});

/**
 * 连接页「接入中继」（2026-11-14 连接页三步方案）：
 * 地址 + 主令牌 → 换本机设备令牌 → 落 `.data/relay-link.json`（0600）→ 热起客户端。
 *
 * 为什么让令牌落本机：连接页第一步必须有个能填的地方（之前只认 `.env`，页面上
 * 就只有一段教程和一个灰按钮）。密钥纪律靠"0600 + 不回显 + 不进日志"守，
 * 和 `provider-keys.json` 同一套口径。`.env` 里配齐的那份仍然优先，页面不覆盖部署。
 */
app.post("/api/v1/relay/link", async (c) => {
  if (!relayLinkUiEnabled()) return c.json({ error: "not_available" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    address?: unknown;
    ownerToken?: unknown;
    deviceName?: unknown;
  } | null;
  try {
    const link = await joinRelay({
      address: typeof body?.address === "string" ? body.address : "",
      ownerToken: typeof body?.ownerToken === "string" ? body.ownerToken : "",
      deviceName: typeof body?.deviceName === "string" ? body.deviceName : "",
    });
    writeRelayLink(link);
    // 身份被别人占着时不能连：双连只会互相顶替（NS-02）
    if (!claimRelayIdentity()) {
      return c.json(
        {
          error: "relay_busy",
          message: `本机已有另一个 harness（pid ${relayBlockedByPid}）在连中继；先关掉它，否则两边会互相顶断`,
        },
        409,
      );
    }
    startRelayClient(relaySettingsFromLink(link), "file");
    const connected = await waitForRelayConnection(7_000);
    return c.json({
      ok: true,
      connected,
      deviceId: relayClient?.selfDeviceId ?? null,
      relayUrl: link.base,
      deviceName: link.deviceName,
    });
  } catch (error) {
    if (error instanceof RelayLinkError) {
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    return c.json({ error: "internal", message: error instanceof Error ? error.message : "接入失败" }, 502);
  }
});

/** 断开并清掉本机保存的接入信息；`.env` 来源的拒绝（改 `.env` 才是那条路）。 */
app.post("/api/v1/relay/unlink", (c) => {
  if (!relayLinkUiEnabled()) return c.json({ error: "not_available" }, 404);
  if (relaySource === "env") {
    return c.json(
      { error: "from_env", message: "中继配置来自 .env；要断开就改 .env 里的 RELAY_ENABLED / RELAY_URL / RELAY_TOKEN" },
      400,
    );
  }
  relayClient?.stop();
  relayClient = null;
  relayChannels = null;
  homeController = null;
  relaySource = null;
  relayHttpShown = "";
  relayDeviceShown = "";
  clearRelayLink();
  return c.json({ ok: true });
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

// 定时任务到点投递（2026-11-17 定时主动轮）：
// - 默认：installScheduledRunHandler 注入"到点跑一轮模型 + 触发消息隐藏"的实现；
// - 回滚（SCHEDULED_TASK_MODEL_RUN=false）：下面这个旧 deliverer 写一条写死的 assistant 消息。
// 两路都用注册回调，避免 reminder.ts ↔ lifecycle.ts / agent 循环 import。
installScheduledRunHandler();
setReminderDeliverer(async (conversationId, text) => {
  await sayInConversation(conversationId, text);
});

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
      // 补送（2026-11-15 送达兜底）：与恢复扫描独立——没有恢复单也可能有待送达行。
      await redeliverReports();
    })
    .catch((error: unknown) => {
      console.warn(
        `[恢复] 启动恢复失败（不影响服务）: ${error instanceof Error ? error.message : error}`,
      );
    });
  // 唤醒队列恢复（2026-11-15 送达兜底 §C）：读回上一次进程没送完的唤醒队列并重排。
  restoreWakeQueue();
  // 例行任务引擎（2026-11-05 批次B B3）：接全局事件口 + 结算遗留 running。
  // phase/tool 的全局口在 agent.ts，这里喂给引擎；delegation 口引擎自己订。
  if (COMPANIONS_ENABLED) {
    routineEngine().subscribe();
    watchAllEvents((event) => routineEngine().onAgentEvent(event));
  }
  // 任务观察层（2026-11-05 批次C C1）：AUTONOMY_ENABLED=false 时 subscribe 内部直接返回（零行为）
  autonomyObserver().subscribe();
  // 自动归档调度器（2026-11-13 批A）：ARCHIVE_AUTO_ENABLED=false/0/off 时不开定时器，零开销（2026-11-15 起默认开）
  autoArchiveScheduler().sync();
  // 每晚记忆整理（2026-11-14）：每天 03:30 对我 + 各在职执事各跑一次"整理建议"。
  // 只出建议、不应用；MEMORY_NIGHTLY_REVIEW=false 时不挂定时器。
  startMemoryNightlyScheduler();
  // chat-meta 自愈（2026-11-13）：清库会在归档/置顶/改名单里留孤儿 id，
  // 归档页会显示"N 条"却取不出东西。启动时清一次，列归档清单时还会再兜一次。
  void pruneChatMetaOrphans().catch((error: unknown) => {
    console.warn(
      `[chats] 启动自愈 chat-meta 失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
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

/**
 * 待送达汇报的启动补送（2026-11-15 回信送达兜底，方案 §A）。
 *
 * 终态落盘到汇报写回之间进程崩溃的话，in 留言停在 delivered=0——恢复扫描
 * （inflight 口径）看不到它们。这里启动时补送一次：写回成功销 1 并走"完成即唤醒"，
 * 宿主会话已不存在销 2，写回异常留 0 下次启动再试。留言表 + 任务专线里始终有
 * 结论原文，补送只是把宿主会话里缺的那份补齐。开关 DELEGATION_REPORT_REDELIVERY。
 */
async function redeliverReports(): Promise<void> {
  if (!reportRedeliveryEnabled() || !readLlmConfig()) return;
  const receipts = new DelegationReceipts();
  try {
    const sent = await redeliverUndeliveredReports({
      undelivered: () => delegationMessages().listUndelivered(),
      // 票已被清掉的行（探针残留 / 老单清理）直接销账，不进补送也不反复 warn
      ticketExists: (ticketId) => findTicket(chancellorWorkRoot(), ticketId) !== null,
      hostConversationId: (ticketId) => {
        const receipt = receipts.lookupByTicket(ticketId);
        if (typeof receipt?.conversationId === "number") return receipt.conversationId;
        // 回执缺失退 ticket.json：originConversationId 记的是宿主内部 id（数字串）
        const raw = findTicket(chancellorWorkRoot(), ticketId)?.ticket.originConversationId;
        return raw !== undefined && raw !== null && /^\d+$/.test(String(raw)) ? Number(raw) : null;
      },
      phaseOf: (ticketId) => {
        const status = String(findTicket(chancellorWorkRoot(), ticketId)?.ticket.status ?? "");
        if (status === "done" || status === "needs_you" || status === "aborted") return status;
        return status ? "failed" : null;
      },
      // sayInConversation 返回 false = 会话已不存在 → 行销 2（补送永远不会再成功）
      say: async (conversationId, text) => {
        const ok = await sayInConversation(conversationId, text);
        if (!ok) {
          console.warn(`[补送] 会话 ${conversationId} 已不存在，销账跳过`);
        }
        return ok;
      },
      settle: (id, state) => delegationMessages().markDelivery(id, state),
      wake: (conversationId, ticketId, text, phase) => {
        wakeOnDelegationReport(conversationId, {
          ticketId,
          domain: "",
          phase: phase as DelegationPhase,
          text: `（重启补送）${text}`,
        });
      },
      log: (line) => console.warn(line),
    });
    if (sent > 0) console.log(`[恢复] 补送待送达汇报 ${sent} 条`);
  } catch (error) {
    console.warn(
      `[恢复] 补送扫描失败（不影响服务）: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    receipts.close();
  }
}

/**
 * 唤醒队列启动恢复（2026-11-15 送达兜底 §C）：读回上一次进程没送完的唤醒队列。
 * 文件不存在 / 坏了当空队列；开关关着时 flush 的守卫链会自行清空。
 */
function restoreWakeQueue(): void {
  try {
    restoreDelegationWakeQueue();
  } catch (error) {
    console.warn(
      `[wake] 唤醒队列恢复失败（不影响服务）: ${error instanceof Error ? error.message : error}`,
    );
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
