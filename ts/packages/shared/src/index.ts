import { z } from "zod";

/*
 * 这个包刻意保持单文件：服务端用 tsx、App 用 Metro，两边对相对导入的
 * 扩展名解析规则不完全一致。共享包只有一份契约足够小，单文件最不容易出岔子。
 */

export const RoleSchema = z.enum(["system", "user", "assistant"]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * 思考强度档（2026-11-04 思考档位方案 D1）。
 *
 * 刻意只做内核档位集的一个子集：`minimal/xhigh/max` 上游没有实证、UI 也没有需求，
 * 多一个值就等于多一条要验的上游路径。`off` 仍是"关思考变体"，其余三档走
 * `reasoning_effort`（见 `接口文档.md` §2.4.1）。
 */
export const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.string().min(1),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * 上行请求。这里**故意**没有 userId：身份走鉴权头，不信任客户端自报。
 *
 * `conversationId` 的语义：**不带 = 新建会话**，服务端生成并在 `start` 事件里返回；
 * 带了就必须是服务端发过的 id，否则 404。这样做是为了让 id 不可猜 ——
 * 否则谁都能编一个 id 去续别人的会话。
 *
 * 历史由服务端持有（pi 的 JsonlSessionRepo），客户端只发新消息。
 * `messages` 保留是为了兼容旧客户端，实际只取最后一条 user。
 */
export const ChatRequestSchema = z.object({
	conversationId: z.string().min(1).max(128).optional(),
	messages: z.array(ChatMessageSchema).min(1).max(200),
	/**
	 * 重试标识：同一条用户消息重发时带同一个值，服务端会认成同一轮，
	 * 不会重复扣 token、也不会把同一段话记两遍记忆。弱网下很有用。
	 */
	requestId: z.string().min(1).max(128).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * 读历史接口的一条记录。
 *
 * 为什么需要它：一轮对话现在**可以在客户端关掉之后继续跑完**，
 * 所以客户端重新打开时必须能把结果拉回来，而不能只依赖自己收到过什么。
 */
export const TranscriptMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /** epoch 毫秒 */
  at: z.number(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export const ChatTranscriptSchema = z.object({
  conversationId: z.string(),
  messages: z.array(TranscriptMessageSchema),
});
export type ChatTranscript = z.infer<typeof ChatTranscriptSchema>;

export const FinishReasonSchema = z.enum(["stop", "length", "aborted", "error"]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

/** 一轮的 token 用量（2026-11-04 批次一）：来自本轮最后一条 assistant 消息的 pi.usage */
export interface TurnUsage {
	input: number;
	output: number;
	/** 缓存命中（只读，不另收"写缓存"的账） */
	cacheRead: number;
}

/**
 * 一轮里"此刻在干什么"。工具回合可能几十秒没有 token，
 * 只靠 delta 的话客户端看到的是一段空白。
 */
export type TurnPhase = "thinking" | "working";

/**
 * SSE 下行事件。客户端只依赖这一个联合类型，
 * 服务端加减字段时另一端会被编译器当场指出来——这就是共用一份定义的意义。
 *
 * 判据：**加的成员必须能被"不认识的客户端"安全忽略**。分发一律看 `type`，
 * 老客户端遇到新类型直接跳过即可，所以 `progress` / `tool` 是纯增量（2026-11-03）。
 *
 * `seq`（2026-11-04，SSE seq 与断点重放方案）：**会话内**单调递增的事件序号，
 * 从 1 起，每个成员都可以带。服务端先落库再外发；客户端重连时带 `sinceSeq`
 * 到 `GET .../messages` 精确补缺帧。可选 = 老客户端与回滚开关（AGENT_SSE_SEQ=off）
 * 两个场景都零感知。
 */
export type ChatEvent =
	/** conversationId 只在首轮有意义：新建会话时由服务端生成，客户端要存下来 */
	| { type: "start"; id: string; conversationId: string; seq?: number }
	| { type: "delta"; text: string; seq?: number }
	/**
	 * 思考正文增量（2026-11-04 批次一）。
	 *
	 * 与 `progress.phase=thinking` 的分工：那个只说"在想"，这个给"想了什么"。
	 * deep 档才有内容；快档不发。客户端累计成段折叠展示，老客户端按 type 忽略。
	 */
	| { type: "thinking"; text: string; seq?: number }
	/** 在想 / 在动手。只有两次之间才有意义，客户端当状态用 */
	| { type: "progress"; phase: TurnPhase; seq?: number }
	/**
	 * 一次工具调用的起止。start 与 end 成对，`name` 相同；
	 * `label` 是能说明"在干什么"的那一个参数（路径 / 命令 / 查询），可能没有。
	 */
	| {
			type: "tool";
			name: string;
			status: "start" | "end";
			label?: string;
			ok?: boolean;
			/** 工具吐出来的文字（服务端截断到 2000 字符） */
			output?: string;
			/** 调用参数（JSON，服务端截断到 1200 字符） */
			args?: string;
			seq?: number;
	  }
  | { type: "done"; id: string; finishReason: FinishReason; /** 本轮 token 用量（2026-11-04 批次一）；读不到就不带 */ usage?: TurnUsage; seq?: number }
  | { type: "error"; message: string; seq?: number }
	/**
	 * 派单进度（2026-11-03）。
	 *
	 * `ticketId` 是任务单号，`domain` 是负责这块分工的领域负责人，`phase` 是
	 * "在等谁"这一层对外状态。老客户端按 `type` 分发，认不出就忽略。
	 */
	| {
			type: "delegate";
			ticketId: string;
			domain: string;
			phase: DelegationPhase;
			done: number;
			total: number;
			current: string;
			message?: string;
			/** 项目名（2026-11-04 方案 §5.9）；老链路没有 */
			project?: string;
			/** 最近一次动作，与 current 同源 */
			lastAction?: string;
			/** 事件心跳（ISO 时间），客户端判断「还活着」 */
			lastHeartbeat?: string;
			/** 等文件租约时卡在哪个路径 */
			waitingOn?: string;
			seq?: number;
	  }
	/** 需要人回答：一条问题，不是一句"出错了"（2026-11-03） */
	| {
			type: "attention";
			ticketId: string;
			domain: string;
			kind: "need_input" | "need_decision" | "need_action";
			question: string;
			seq?: number;
	  }
	/**
	 * 审批请求（2026-11-04 批次二）：写类工具执行前挂起，等客户端答复。
	 *
	 * `callId` 是答复端点（`POST /api/v1/agent/approvals/:callId`）的主键；
	 * `args` 是工具参数 JSON（按 `tool` 事件口径截断到 1200 字符）；
	 * `deadlineAt` 是 ISO 时间，过了就按拒绝处理（fail-closed）。
	 * 手机走 OpenAI 兼容层、没有答复通道：不答复就是等到超时被拒。
	 */
	| {
			type: "approval";
			callId: string;
			tool: string;
			args: string;
			deadlineAt: string;
			/** 自主轮标记（2026-11-05 批次C C2）：例行任务轮的审批卡；纯增量，老客户端忽略 */
			origin?: "autonomous";
			seq?: number;
	  };

/**
 * 会话事件重放响应里的事件行（2026-11-04，SSE seq 与断点重放方案）。
 *
 * 重放路径是 `GET .../messages` 的 `events` 字段：从客户端报的 `sinceSeq`
 * 之后取已落库的事件。落库窗口有限（每会话只留最近 N 条），所以带
 * `fromSeq`——重放的第一条的真实序号。客户端拿它发现"窗口已经滑过去了"
 * （`fromSeq > sinceSeq + 1`），此时该全量重建，不能只补。
 */
export interface ReplayEvent {
	/** 完整事件帧（含 seq）。 */
	event: ChatEvent;
}

/** 任务单对外的阶段：按"在等谁"分，不按内部进度。schema 见文末矩阵段（DelegationPhaseSchema）。 */

/**
 * 编码成 SSE 帧。只写 data 行：帧类型以 JSON 的 type 字段为准，
 * 不另外维护 event: 行，避免同一件事有两份真相。
 */
export function encodeSseEvent(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * 增量 SSE 解码器。
 *
 * 为什么自己写：网络上拿到的 chunk 边界是任意切分的，一个 JSON 可能被劈成
 * 两半。未完成的半帧必须留在缓冲区等下一个 chunk，这类边界错误在真机上
 * 极难复现。服务端与 App 共用这一份实现，解析行为不会两边漂移。
 */
export function createSseDecoder(): { push: (chunk: string) => ChatEvent[] } {
  let buffer = "";

  return {
    push(chunk: string): ChatEvent[] {
      buffer += chunk;
      const events: ChatEvent[] = [];

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        const separator = /\r?\n\r?\n/.exec(buffer.slice(boundary));
        buffer = buffer.slice(boundary + (separator?.[0].length ?? 2));

        const data = rawFrame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (data.length > 0) {
          try {
            events.push(JSON.parse(data) as ChatEvent);
          } catch {
            // 畸形帧不中断整条流：宁可丢一帧，也不要让对话卡死。
          }
        }

        boundary = buffer.search(/\r?\n\r?\n/);
      }

      return events;
    },
  };
}

// ── 中继信封（2026-11-05 多端同步方案 §四，协议 v1）────────────────────────
//
// 设计取舍（对齐 cindy device-link-protocol 的核心思想）：
// - 中继只按 dst 转发、覆写 src，channel/payload 对中继不透明——中继被攻破
//   也只能丢消息，不能伪造业务语义；
// - 语义校验全部在被控端（通道白名单默认拒绝），`channel_not_allowed` 兼作
//   能力探测信号（旧端 fail-visible）；
// - result 与 deliver 走同一路由形状（dst = 发起端），中继不存每消息状态。

export const RELAY_PROTOCOL_VERSION = 1;
/** 单帧字节上限。中继在解析前按长度拒收，不解析内容。 */
export const RELAY_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export const RelayErrorCodeSchema = z.enum([
	"bad_request",
	"unauthorized",
	"version_mismatch",
	"unknown_device",
	"device_offline",
	"payload_too_large",
	"timeout",
	"channel_not_allowed",
	"remote_disabled",
	"internal",
]);
export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>;

/** 设备上线第一帧（15 秒内必须发），token = 中继签发的 deviceToken。 */
export const RelayHelloSchema = z.object({
	kind: z.literal("hello"),
	v: z.literal(1),
	token: z.string().min(1).max(128),
	deviceName: z.string().min(1).max(40),
	platform: z.string().min(1).max(20),
	version: z.string().max(20).optional(),
	capabilities: z.array(z.string().min(1).max(40)).max(16).default([]),
});
export type RelayHello = z.infer<typeof RelayHelloSchema>;

export const RelayDeviceViewSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	platform: z.string(),
	online: z.boolean(),
	lastSeenAt: z.number().optional(),
	capabilities: z.array(z.string()).default([]),
});
export type RelayDeviceView = z.infer<typeof RelayDeviceViewSchema>;

/** 中继回执：确认身份并带全量设备快照（控制端冷启动靠它建名册）。 */
export const RelayWelcomeSchema = z.object({
	kind: z.literal("welcome"),
	deviceId: z.string().min(1),
	devices: z.array(RelayDeviceViewSchema),
});
export type RelayWelcome = z.infer<typeof RelayWelcomeSchema>;

/** 发起端 → 中继：转交给 dst。被控端回程 result 的 dst = 发起端 deviceId。 */
export const RelayDeliverSchema = z.object({
	kind: z.literal("deliver"),
	id: z.string().min(1).max(64),
	dst: z.string().min(1).max(64),
	channel: z.string().min(1).max(80),
	payload: z.unknown(),
});
export type RelayDeliver = z.infer<typeof RelayDeliverSchema>;

/** 中继 → 目标：盖章帧（src 由中继覆写，连接自报无效）。 */
export const RelayRoutedSchema = z.object({
	kind: z.literal("routed"),
	id: z.string().min(1).max(64),
	src: z.string().min(1).max(64),
	channel: z.string().min(1).max(80),
	payload: z.unknown(),
});
export type RelayRouted = z.infer<typeof RelayRoutedSchema>;

/** 被控端 → 中继：invoke 结果（中继按 dst 原路送回发起端）。 */
export const RelayResultSchema = z.object({
	kind: z.literal("result"),
	id: z.string().min(1).max(64),
	dst: z.string().min(1).max(64),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z
		.object({ code: RelayErrorCodeSchema, message: z.string().max(300) })
		.optional(),
});
export type RelayResult = z.infer<typeof RelayResultSchema>;

/** 中继 → 连接：同步拒绝帧（对 deliver/result 的 immediate 拒收）。 */
export const RelayErrorFrameSchema = z.object({
	kind: z.literal("error"),
	id: z.string().max(64).optional(),
	code: RelayErrorCodeSchema,
	message: z.string().max(300),
});
export type RelayErrorFrame = z.infer<typeof RelayErrorFrameSchema>;

export const RelayPingSchema = z.object({ kind: z.literal("ping"), at: z.number() });
export const RelayPongSchema = z.object({ kind: z.literal("pong"), at: z.number() });

/** 通道名约定：主动推送以 "push/" 开头（是否可推仍由被控端白名单决定）。 */
export const RELAY_PUSH_CHANNEL_PREFIX = "push/";

// ── 设备矩阵派活（2026-11-05 多端同步方案块2，阶段二）──────────────────
// 新增通道 `delegation/busy`（2026-11-05 自动分发）：目标机返回 {active} 在跑单数；
// 决策在发起端（relay-auto.ts），中继保持哑。
// 语义（方案 §四阶段二）：发起端生成 requestId（全局幂等）；目标机受理后
// 用"本地锚点会话"承载 chancellor 单（复用既有回执/恢复机制）；发起端
// 轮询 status，相位变化写回发起会话。目标离线直接失败不排队。

/** 与 chancellor TicketStatus 的映射：received→accepted，planned/dispatching→running，idle→needs_you。 */
export const DelegationPhaseSchema = z.enum([
	"accepted",
	"planning",
	"running",
	"reviewing",
	"done",
	"needs_you",
	"failed",
	"aborted",
]);
export type DelegationPhase = z.infer<typeof DelegationPhaseSchema>;

export const RemoteDelegationAcceptSchema = z.object({
	requestId: z.string().min(8).max(64),
	prompt: z.string().min(1).max(20_000),
	project: z.string().max(120).optional(),
	domain: z.string().max(60).optional(),
	originDeviceId: z.string().min(1).max(64),
	createdAt: z.number(),
});
export type RemoteDelegationAccept = z.infer<typeof RemoteDelegationAcceptSchema>;

export const RemoteDelegationStatusSchema = z.object({
	requestId: z.string(),
	ticketId: z.string(),
	phase: DelegationPhaseSchema,
	report: z.string().max(4000).optional(),
	updatedAt: z.number(),
});
export type RemoteDelegationStatus = z.infer<typeof RemoteDelegationStatusSchema>;

// ── 伙伴认主机路由（2026-11-05 多端同步方案块3，阶段三）────────────────
// 中继持有"伙伴 → 主机设备"路由表并做 CAS 仲裁——这是路由元数据不是业务数据
// （方案 §四阶段三、§六备选）。信封新增 meta 帧：中继自答不转发。
// CAS 口径照抄 cindy：expected 不符时**带回实际值**，调用方重读再决定。

export const RelayMetaActionSchema = z.enum(["actors", "actor-home", "actor-claim", "actor-release", "devices"]);
export type RelayMetaAction = z.infer<typeof RelayMetaActionSchema>;

export const RelayMetaRequestSchema = z.object({
	kind: z.literal("meta"),
	id: z.string().min(1).max(64),
	action: RelayMetaActionSchema,
	payload: z.unknown(),
});
export type RelayMetaRequest = z.infer<typeof RelayMetaRequestSchema>;

export interface RelayActorMeta {
	actorId: string;
	name: string;
	homeDeviceId: string | null;
	updatedAt: number;
}

export const RelayActorClaimResultSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		actorId: z.string(),
		name: z.string(),
		homeDeviceId: z.string(),
	}),
	z.object({
		ok: z.literal(false),
		code: z.literal("home_conflict"),
		actorId: z.string(),
		/** 当前实际主机（调用方据此重读重判，绝不盲抢） */
		homeDeviceId: z.string().nullable(),
	}),
]);
export type RelayActorClaimResult = z.infer<typeof RelayActorClaimResultSchema>;

// ── 伙伴与例行任务（2026-11-05 批次B，REST 投影形状）──
// 现阶段前端不消费（桌面/手机都还没接）；这里先立形状，端点以服务端代码为准
// （接口文档 §2.11/§2.12 与本节同步维护）。无新 SSE 事件。

export const PartnerStatusSchema = z.enum(["active", "paused", "archived"]);
export type PartnerStatus = z.infer<typeof PartnerStatusSchema>;

/** 模型候选链项：keyEnv 只允许存 env 变量名（密钥纪律），任何值形状都会被服务端 400 */
export const ModelChainItemSchema = z.object({
	providerId: z.string(),
	modelId: z.string(),
	keyEnv: z.string(),
	thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
});
export type ModelChainItem = z.infer<typeof ModelChainItemSchema>;

export const PartnerProfileSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	status: PartnerStatusSchema,
	/** 当前生效的身份快照版本号；改 SOUL 下一轮生效（版本化在服务端） */
	soulVersion: z.number().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	/**
	 * 手下伙伴的唯一领域名（批次D D2，纯增量可选字段）：小写 ASCII，
	 * 正则同 chancellor `DOMAIN_PATTERN`。普通伙伴 / 老客户端不带这个字段。
	 * App 零改动：认不出的客户端按「忽略未知字段」处理即可。
	 */
	domain: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
});
export type PartnerProfile = z.infer<typeof PartnerProfileSchema>;

export const RoutineTriggerSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("cron"), expr: z.string() }),
	z.object({ type: z.literal("interval"), seconds: z.number() }),
	z.object({ type: z.literal("once"), at: z.string() }),
	z.object({
		type: z.literal("event"),
		kind: z.enum(["delegation", "tool", "phase"]),
		match: z.record(z.string()).optional(),
	}),
]);
export type RoutineTrigger = z.infer<typeof RoutineTriggerSchema>;

export const RoutineDefSchema = z.object({
	id: z.string().uuid(),
	partnerId: z.string().uuid(),
	name: z.string(),
	prompt: z.string(),
	triggers: z.array(RoutineTriggerSchema).min(1),
	/** persistent=复用主会话（保上下文）；fresh=每次全新专线（防污染） */
	sessionMode: z.enum(["persistent", "fresh"]),
	enabled: z.boolean(),
	/** 每次修改 +1：在飞的 durable 任务醒来对不上号就作废 */
	revision: z.number(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type RoutineDef = z.infer<typeof RoutineDefSchema>;

export const RoutineRunStatusSchema = z.enum([
	"running",
	"success",
	"failed",
	"interrupted",
	"skipped",
]);
export type RoutineRunStatus = z.infer<typeof RoutineRunStatusSchema>;

export const RoutineRunRecordSchema = z.object({
	id: z.string(),
	routineId: z.string(),
	partnerId: z.string(),
	status: RoutineRunStatusSchema,
	trigger: z.string(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
	summary: z.string().optional(),
	error: z.string().optional(),
});
export type RoutineRunRecord = z.infer<typeof RoutineRunRecordSchema>;
