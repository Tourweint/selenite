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

/**
 * 一条用户消息的内容分段（2026-11-08 扫尾批 4a，附件/图片）。
 *
 * 形状对齐内核 pi-ai 的 `TextContent` / `ImageContent`：`image.data` 是**裸 base64**
 * （不带 `data:` 前缀），条目层零转换。`content` 仍是 union —— 纯字符串的老调用方
 * （手机、OpenAI 兼容层、旧脚本）逐字节不变。
 *
 * 图片限制在服务端复核（单图 ≤8MB、单条 ≤4 张），schema 只钉形状：
 * 体积是业务规则，放在这里会让整份契约在解析阶段就拒掉本该给"400 带说明"的请求。
 */
export const TextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const ImagePartSchema = z
  .object({
    type: z.literal("image"),
    /** MIME（`image/png` / `image/jpeg` / …）；服务端只校验 `image/` 前缀 */
    mimeType: z.string().min(1).max(100),
    /** 裸 base64（不含 `data:` 前缀） */
    data: z.string().min(1),
  })
  .strict();

export const ContentPartSchema = z.union([TextPartSchema, ImagePartSchema]);
export type ContentPart = z.infer<typeof ContentPartSchema>;
export type TextPart = z.infer<typeof TextPartSchema>;
export type ImagePart = z.infer<typeof ImagePartSchema>;

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.union([z.string().min(1), z.array(ContentPartSchema).min(1)]),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * 取出 content 里的纯文本（多段用 `\n` 连，与 pi-ai `contentText` 同口径）。
 * 分享给 openai-compat / 记忆抽取这类"只要文字"的调用方，避免各自写一份。
 */
export function chatContentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * 会话种类（2026-11-06 侧栏调整 B2）。
 *
 * 为什么要有：默认 persona 一直是总管身份，前端"新建对话"只清空了本地状态，
 * 新建出来的仍是总管会话。身份必须落在服务端（durable doc），不能只靠按钮文案。
 *
 * - `chief`  = 总管会话（历史默认；手机与旧调用方不带字段 → 仍 chief）
 * - `worker` = 普通任务助手会话（新建入口显式指定）
 * - `partner`= 执事专线（只出现在响应里：由 `partner_session_links` 判定，客户端不能自报）
 */
export const ChatKindSchema = z.enum(["chief", "worker", "partner"]);
export type ChatKind = z.infer<typeof ChatKindSchema>;

/** 新建会话时可指定的种类：partner 不能由客户端声明（身份由服务端链接表决定）。 */
export const NewChatKindSchema = ChatKindSchema.exclude(["partner"]);
export type NewChatKind = z.infer<typeof NewChatKindSchema>;

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
	/**
	 * 新会话种类（2026-11-06 侧栏调整 B2，纯增量）：只在不带 `conversationId` 时采用，
	 * 缺省仍 `chief`（手机/旧调用方零改动）。续话时带不匹配的值 → 400，不隐式改身份。
	 */
	chatKind: NewChatKindSchema.optional(),
	/**
	 * 忙时投递方式（2026-11-07 消息即引导，纯增量）。
	 *
	 * - `followUp`（缺省）：排到本轮结束后，作为下一轮；等于改动前的行为。
	 * - `steer`：插进**当前这一轮**，模型下一步就能看到。
	 *
	 * 这是"请求"不是"保证"：本轮没有可插的边界（例如已经收尾）时内核会落到队列，
	 * 服务端照实发一条 `notice`，不把"受理"说成"已插入"。老客户端不传 = 行为不变。
	 */
	whenBusy: z.enum(["steer", "followUp"]).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * 历史回放里的一步「工作过程」（2026-11-07，纯增量）。
 *
 * 存在的理由：流式期间的 `tool` 事件只在当轮界面上活过一次，刷新/切会话就没了。
 * 步骤本来就躺在 durable 里（`pi.assistant` 的 toolCall + `pi.tool-result`），
 * 这里只是把它们按调用顺序重建成客户端能直接渲染的形状，**不新增存储**。
 *
 * 字段口径与 `tool` 事件保持一致（截断上限相同），这样"现场看到的"与
 * "回头翻到的"是同一份事实，不会出现点开历史比当时更少或更多的情况。
 */
export const TranscriptStepSchema = z.object({
  /** 工具名（read / write / edit / bash / remember / delegate …） */
  name: z.string(),
  /** 最能说明"在干什么"的那一个参数（路径 / 命令 / 查询） */
  label: z.string().optional(),
  /** 调用参数 JSON，服务端截断到 1200 字符 */
  args: z.string().optional(),
  /** 工具输出，服务端截断到 2000 字符 */
  output: z.string().optional(),
  /** 编辑类工具的 unified diff（服务端截断到 2000 字符），其它工具没有 */
  diff: z.string().optional(),
  /** false = 这一步失败了（或这一轮被中断、没等到结果） */
  ok: z.boolean(),
  /** 该步耗时（毫秒）；老记录或没跑完的调用读不到就不带 */
  ms: z.number().optional(),
});
export type TranscriptStep = z.infer<typeof TranscriptStepSchema>;

/**
 * 读历史里附在用户消息上的图片（2026-11-08 扫尾批 4a）。
 * 与上行 `ImagePartSchema` 同形状、少一个 `type`（回读只用来渲染，不参与再提交）。
 */
export const TranscriptImageSchema = z
  .object({
    mimeType: z.string(),
    data: z.string(),
  })
  .strict();
export type TranscriptImage = z.infer<typeof TranscriptImageSchema>;

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
  /**
   * 这条消息的可寻址 id（2026-11-08 扫尾批 4a，纯增量，只给 user 消息）。
   *
   * 用途：编辑重发要指到"哪一条"。**不是** durable 内部自增条目 id 原文——
   * 对外 id 一律 uuid（会话 id 的例子），这里由 `(会话 uuid, 条目 id)` 哈希成
   * uuid 形状，服务端按同一个函数反查。
   */
  id: z.string().optional(),
  /**
   * 这条用户消息带的图片（2026-11-08 扫尾批 4a，纯增量，老客户端忽略）。
   * 文字仍走 `text`；纯图片消息 `text` 可能是空串。
   */
  images: z.array(TranscriptImageSchema).optional(),
  /**
   * 这条回答之前那一轮的工作步骤（2026-11-07，纯增量，老客户端忽略）。
   * 只挂在 assistant 上；一轮里没有工具调用就不带这个字段。
   */
  steps: z.array(TranscriptStepSchema).optional(),
  /** 那一轮从提问到收尾的墙钟时长（毫秒）；有 steps 才可能有 */
  workMs: z.number().optional(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export const ChatTranscriptSchema = z.object({
  conversationId: z.string(),
  messages: z.array(TranscriptMessageSchema),
});
export type ChatTranscript = z.infer<typeof ChatTranscriptSchema>;

// ── 群组（2026-11-06 群组方案，接口文档 §2.14）──────────────
//
// 群 = 主人 + 2–6 名执事在同一条共享时间线里聊；谁发言由宿主按确定性规则编排
// （@点名 > @所有人 > 值日执事）。每个执事仍是独立 agent（自己的会话、SOUL、模型链、
// 闸门），群里只有一条共享时间线。手机端 v1 零改动：下面的 schema 只被 web 端与服务端用，
// SSE 侧的增量（start.sender / notice）老客户端可忽略。

/** 群聊 SSE 帧的发言者快照。落时间线的是快照，改名/离群后历史照常渲染（cindy 四件套）。 */
export interface GroupSender {
	kind: "partner" | "user";
	/** kind=partner 时是执事 uuid */
	id?: string;
	/** 展示名（快照）；user 固定「主人」 */
	name?: string;
}

/** 无 @ 时的默认应答者口径。member = 值日执事（用户拍板的默认）；everyone = 全员；mentions = 只有点名才回。 */
export const GroupResponderKindSchema = z.enum(["member", "everyone", "mentions"]);
export type GroupResponderKind = z.infer<typeof GroupResponderKindSchema>;

export const GROUP_MEMBER_MIN = 2;
export const GROUP_MEMBER_MAX = 6;
/** 单条群消息正文上限（与方案 §2.1 一致） */
export const GROUP_MESSAGE_LIMIT = 8000;

export const GroupMemberSchema = z.object({
	partnerId: z.string(),
	/** 成员表只存展示名快照，不复制人格（lobehub 教训）；人格 = 各自 SOUL */
	name: z.string(),
	position: z.number().int().min(0),
	/** 档案实时状态（active / paused / archived）；2026-11-08 前服务端已透出，这里补齐 */
	status: z.string().optional(),
	/**
	 * 复合头像（2026-11-08 批三）：档案 avatar 槽的 data URL，或 null（前端用名字首字）。
	 * 群列表行 / 会话头用 2×2 网格拼，≤4 人直出，多人右下角 +N。
	 */
	avatar: z.string().nullable().optional(),
	/** 执事域（2026-11-08 批三）：`@名字·domain` 唯一长标签消歧用；无 domain = null */
	domain: z.string().nullable().optional(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

/** 群轮次状态（2026-11-08 批三）：群会话「谁在忙」胶囊读这一段；成员间隙 speaker=null。 */
export const GroupRoundSchema = z.object({
	running: z.boolean(),
	speaker: z
		.object({ partnerId: z.string(), name: z.string() })
		.nullable(),
});
export type GroupRound = z.infer<typeof GroupRoundSchema>;

export const GroupMetaSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** 群公告（≤500 字），随每轮输入注入成员会话 */
	notice: z.string(),
	responderKind: GroupResponderKindSchema,
	/** kind=member 时的值日执事；必须是群成员 */
	responderPartnerId: z.string().nullable(),
	members: z.array(GroupMemberSchema),
	/** 轮次状态（2026-11-08 批三，纯增量） */
	round: GroupRoundSchema.optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type GroupMeta = z.infer<typeof GroupMetaSchema>;

export const GroupMessageSchema = z.object({
	id: z.string(),
	groupId: z.string(),
	/** 群内单调序号（从 1 起），回读分页用 beforeSeq */
	seq: z.number().int().min(1),
	kind: z.enum(["message", "system"]),
	authorKind: z.enum(["user", "partner", "system"]),
	authorId: z.string().nullable(),
	/** 作者名快照：不 join 成员表，改名/离群后历史不变 */
	authorName: z.string(),
	content: z.string(),
	at: z.string(),
	/** 同一回合同名（用于将来合并/追溯），v1 落 uuid */
	roundId: z.string(),
});
export type GroupMessage = z.infer<typeof GroupMessageSchema>;

/** POST /groups/:id/chat 的上行。历史在服务端（群时间线 + 各成员会话），客户端只发新消息。 */
export const GroupChatRequestSchema = z.object({
	text: z.string().min(1).max(GROUP_MESSAGE_LIMIT),
});
export type GroupChatRequest = z.infer<typeof GroupChatRequestSchema>;

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
	| {
			type: "start";
			id: string;
			conversationId: string;
			/**
			 * 群聊发言者归属（2026-11-06 群组方案 §2.5，纯增量）：一轮一个 start，
			 * 整轮的 delta/thinking/progress/tool/done 都归属这个 sender。
			 * 主对话不带这个字段（老客户端与旧链路零感知）。
			 */
			sender?: GroupSender;
			seq?: number;
		  }
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
	 * 群时间线系统行（2026-11-06 群组方案 §2.5，纯增量）。
	 *
	 * 成员被跳过 / mentions 无人回 / 回合被停这类"不是谁说的话"的时刻，
	 * 用这一帧告诉客户端；同一行会落 `group_messages(kind='system')`，
	 * 回读可复现。老客户端按 `type` 分发，认不出就忽略。
	 */
	| {
			type: "notice";
			text: string;
			/**
			 * 插话回执的机器可读落点（2026-11-07 消息即引导，纯增量）。
			 *
			 * `whenBusy=steer` 的那一帧才带：
			 * - `inserted`：插进了正在跑的这一轮，正文由**原来的那条流**继续画；
			 * - `new-turn`：刚好收尾，这句补充成了新的一轮——它那条短连接就是
			 *   唯一的正文来源，客户端只收回执的话必须收尾后回读一次，否则
			 *   新一轮的回答没人画。
			 * `text` 是给人看的话，不要拿文案做判断；认不出该值的客户端按无标记处理。
			 */
			steer?: "inserted" | "new-turn";
			seq?: number;
	  }
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
	/**
	 * 主机位（2026-11-05 主机优先制）：中继名册里同一时刻只有一台 `isHome=true`。
	 * 只读投影；设/清走 `POST /api/relay/home-device`（owner 或设备令牌）。
	 */
	isHome: z.boolean().optional(),
	/**
	 * 设备描述（≤200 字，如"存储机"/"计算用"）。
	 * **只给人看**：名册/overview/delegate 回话里供人点名参考，
	 * 自动挑机决策器（`relay-auto.ts`）**不读这个字段**（产品口径：描述不参与挑选）。
	 */
	description: z.string().max(200).optional(),
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

/**
 * meta 动作（2026-11-05 主机优先制加 `set-home` / `set-description`）：
 * - `devices` 快照带 `isHome` / `description`；
 * - `set-home` payload `{deviceId: string | null}`（null = 清除）；
 * - `set-description` payload `{deviceId, description}`（≤200 字，空串 = 清除）。
 * 两者都是路由元数据，中继自答、不转发——与设备名册同层。
 */
export const RelayMetaActionSchema = z.enum([
	"actors",
	"actor-home",
	"actor-claim",
	"actor-release",
	"devices",
	"set-home",
	"set-description",
]);
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

// ── 伙伴头像（2026-11-06 侧栏调整 B1）──────────────────────
//
// 取舍：**只收有界 PNG data URL**，不存文件路径、不收外部 URL、不收 SVG。
//  - 文件路径会暴露本机目录，也会随家目录迁移失效；
//  - 外部 URL 等于让服务端去抓任意地址（SSRF），而且离线就没了；
//  - SVG 是可执行内容，服务端不该存"一段能被浏览器当文档执行的东西"。
// PNG 只供 `<img src>` 渲染（图片解码器，不执行脚本），并有明确的字节/尺寸上限。
//
// 客户端负责把用户选的图缩成 ≤256px 的 PNG；服务端仍然全量复核（不信任客户端），
// 因为契约是公开的，谁都能直接 POST 一段字符串。

/** 头像字符串上限（data URL 整体，含前缀与 base64 填充） */
export const PARTNER_AVATAR_MAX_CHARS = 180_000;
/** 解码后字节上限（128KiB：256×256 RGBA 未压缩约 256KiB，PNG 压缩后远小于此） */
export const PARTNER_AVATAR_MAX_BYTES = 128 * 1024;
/** 单边尺寸上限（px）；下限固定 1 */
export const PARTNER_AVATAR_MAX_DIMENSION = 256;
/** 唯一允许的 data URL 前缀 */
export const PARTNER_AVATAR_PREFIX = "data:image/png;base64,";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * 完整解开一段 base64（长度必须是 4 的倍数）。
 * 刻意不用 Buffer/atob：shared 同时被服务端（tsx）和手机端（Metro）加载，
 * 两边全局对象不一样。头像上限 128KiB，这里一次性解完——PNG 的块边界、
 * IHDR 参数和 CRC 都要看真实字节，只解头尾会被坏图骗过去。
 */
function base64Decode(b64: string): Uint8Array | null {
	if (b64.length === 0 || b64.length % 4 !== 0) return null;
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	const byteLength = (b64.length / 4) * 3 - padding;
	const out = new Uint8Array(byteLength);
	let cursor = 0;
	for (let i = 0; i < b64.length; i += 4) {
		const a = B64_ALPHABET.indexOf(b64[i]);
		const b = B64_ALPHABET.indexOf(b64[i + 1]);
		const c = b64[i + 2] === "=" ? 0 : B64_ALPHABET.indexOf(b64[i + 2]);
		const d = b64[i + 3] === "=" ? 0 : B64_ALPHABET.indexOf(b64[i + 3]);
		if (a < 0 || b < 0 || c < 0 || d < 0) return null;
		const n = (a << 18) | (b << 12) | (c << 6) | d;
		out[cursor++] = (n >> 16) & 0xff;
		if (cursor < byteLength) out[cursor++] = (n >> 8) & 0xff;
		if (cursor < byteLength) out[cursor++] = n & 0xff;
	}
	return cursor === byteLength ? out : null;
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
	let c = 0xffffffff;
	for (let i = start; i < end; i += 1) {
		c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function be32(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] << 24) |
		(bytes[offset + 1] << 16) |
		(bytes[offset + 2] << 8) |
		bytes[offset + 3]
	) >>> 0;
}

/** PNG 块类型必须是 4 个 ASCII 字母（大小写都合法；大小写决定 critical/ancillary）。 */
function isChunkType(bytes: Uint8Array, offset: number): boolean {
	for (let i = 0; i < 4; i += 1) {
		const byte = bytes[offset + i];
		if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) return false;
	}
	return true;
}

/**
 * 逐块走完整个 PNG：签名 → IHDR（必须是首块且长度 13，参数合法）→ 每块 CRC →
 * IDAT 存在 / 连续 / 在 IEND 前 → IEND 长度 0 且后面没有多余字节。
 *
 * 这里只做**结构**校验；IDAT 的 deflate 流是否真能解开由服务端用 zlib 复核
 * （shared 不能 import Node，手机端也要能加载）。
 */
function pngProblem(bytes: Uint8Array): string | null {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length < 45) return "头像不是完整的 PNG";
	if (signature.some((byte, index) => bytes[index] !== byte)) return "头像不是 PNG";

	let offset = 8;
	let seenIhdr = false;
	let seenIdat = false;
	let idatClosed = false;
	let seenIend = false;
	let seenPlte = false;
	let colorType = -1;

	while (offset < bytes.length) {
		if (bytes.length - offset < 12) return "PNG 数据不完整";
		const length = be32(bytes, offset);
		const typeStart = offset + 4;
		const dataStart = offset + 8;
		const crcStart = dataStart + length;
		if (length > bytes.length || crcStart + 4 > bytes.length) return "PNG 数据不完整";
		if (!isChunkType(bytes, typeStart)) return "PNG 块类型不合法";
		const type = String.fromCharCode(
			bytes[typeStart],
			bytes[typeStart + 1],
			bytes[typeStart + 2],
			bytes[typeStart + 3],
		);
		if (be32(bytes, crcStart) !== pngCrc32(bytes, typeStart, crcStart)) {
			return "PNG 数据校验失败（CRC）";
		}

		if (!seenIhdr) {
			if (type !== "IHDR") return "PNG 缺少 IHDR 块";
			if (length !== 13) return "PNG IHDR 长度不合法";
			const width = be32(bytes, dataStart);
			const height = be32(bytes, dataStart + 4);
			const bitDepth = bytes[dataStart + 8];
			colorType = bytes[dataStart + 9];
			const compression = bytes[dataStart + 10];
			const filter = bytes[dataStart + 11];
			const interlace = bytes[dataStart + 12];
			if (
				width < 1 ||
				height < 1 ||
				width > PARTNER_AVATAR_MAX_DIMENSION ||
				height > PARTNER_AVATAR_MAX_DIMENSION
			) {
				return `头像尺寸需在 1–${PARTNER_AVATAR_MAX_DIMENSION}px 之间（当前 ${width}×${height}）`;
			}
			const depthsByColor: Record<number, number[]> = {
				0: [1, 2, 4, 8, 16],
				2: [8, 16],
				3: [1, 2, 4, 8],
				4: [8, 16],
				6: [8, 16],
			};
			if (!depthsByColor[colorType]?.includes(bitDepth)) {
				return "PNG IHDR 参数不合法（颜色类型 / 位深）";
			}
			if (compression !== 0 || filter !== 0 || interlace > 1) {
				return "PNG IHDR 参数不合法（压缩 / 过滤 / 隔行）";
			}
			seenIhdr = true;
		} else {
			if (type === "IHDR") return "PNG 包含多个 IHDR 块";
			if (type === "IDAT") {
				if (idatClosed) return "PNG IDAT 块不连续";
				if (colorType === 3 && !seenPlte) return "PNG 缺少调色板（PLTE）";
				seenIdat = true;
			} else {
				if (seenIdat) idatClosed = true;
				if (type === "PLTE") {
					if (seenIdat) return "PNG PLTE 必须位于 IDAT 之前";
					seenPlte = true;
				}
				if (type === "IEND") {
					if (length !== 0) return "PNG IEND 长度不合法";
					if (crcStart + 4 !== bytes.length) return "PNG IEND 之后有多余数据";
					seenIend = true;
				}
			}
		}

		offset = crcStart + 4;
		if (seenIend) break;
	}

	if (!seenIhdr) return "PNG 缺少 IHDR 块";
	if (!seenIdat) return "PNG 缺少 IDAT 块";
	if (!seenIend) return "PNG 数据不完整（缺少 IEND）";
	return null;
}

/**
 * 头像字符串的问题描述；合法返回 null。
 * 校验顺序：前缀 → base64 形状 / 体积 → 完整解码 → PNG 签名 / 块边界 / IHDR / CRC / IDAT / IEND。
 * 返回的是给人看的中文短句，端点直接用作 400 的 message。
 */
export function partnerAvatarProblem(value: string): string | null {
	if (!value.startsWith(PARTNER_AVATAR_PREFIX)) {
		return "头像只接受 PNG（data:image/png;base64,...）";
	}
	if (value.length > PARTNER_AVATAR_MAX_CHARS) {
		return `头像字符串超过 ${PARTNER_AVATAR_MAX_CHARS} 字符上限`;
	}
	const b64 = value.slice(PARTNER_AVATAR_PREFIX.length);
	if (b64.length === 0) return "头像内容为空";
	if (b64.length % 4 !== 0) return "头像 base64 长度不合法";
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return "头像 base64 含非法字符";

	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	const byteLength = (b64.length / 4) * 3 - padding;
	if (byteLength > PARTNER_AVATAR_MAX_BYTES) {
		return `头像解码后超过 ${PARTNER_AVATAR_MAX_BYTES / 1024}KiB 上限`;
	}
	if (byteLength < 45) return "头像不是完整的 PNG";

	const bytes = base64Decode(b64);
	if (!bytes) return "头像 base64 无法解码";
	return pngProblem(bytes);
}

/** 合法头像：`data:image/png;base64,...`（有界）。 */
export const PartnerAvatarSchema = z
	.string()
	.max(PARTNER_AVATAR_MAX_CHARS, { message: `头像字符串超过 ${PARTNER_AVATAR_MAX_CHARS} 字符上限` })
	.superRefine((value, ctx) => {
		const problem = partnerAvatarProblem(value);
		if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
	});
export type PartnerAvatar = z.infer<typeof PartnerAvatarSchema>;

/** PATCH 语义：字段遗漏 = 不改；`null` = 清除；字符串 = 设置。 */
export const PartnerAvatarPatchSchema = PartnerAvatarSchema.nullable();
export type PartnerAvatarPatch = z.infer<typeof PartnerAvatarPatchSchema>;


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
	/**
	 * 头像（2026-11-06 侧栏调整 B1，纯增量）：`null` = 未设置（前端回落名字首字）。
	 * 只在 `GET /api/v1/partners/:id` 的投影里出现；旧客户端忽略未知字段即可。
	 */
	avatar: PartnerAvatarSchema.nullable(),
	/**
	 * 派发权（2026-11-06 执事派发权开关，纯增量可选）：带 domain 的执事是否作为
	 * 分管负责人接单。默认关；投影只对带 domain 的执事给，普通执事不带。
	 * 旧客户端按「忽略未知字段」处理即可。
	 */
	dispatchAuthority: z.boolean().optional(),
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

/* ── 文件浏览入口（2026-11-06，方案见 docs/设计方案/2026-11-06-文件浏览入口（桌面资源管理器与手机端）.md）──
 * 三个只读端点：打开资源管理器（桌面）、列目录、看文本（手机兜底）。
 * 安全口径：只收工作区内相对路径；realpath 复核与 path-guard.ts 同口径；根层屏蔽 .data；正文 ≤512KB UTF-8。 */

/** POST /api/v1/workspaces/open-explorer 请求体：缺省 projectId = 打开工作区根 */
export const OpenExplorerRequestSchema = z.object({
	projectId: z.string().min(1).optional(),
});
export type OpenExplorerRequest = z.infer<typeof OpenExplorerRequestSchema>;

/** GET /api/v1/files 的单个目录项 */
export const FileEntrySchema = z.object({
	name: z.string(),
	type: z.enum(["file", "dir"]),
	/** 字节数；目录恒为 0 */
	size: z.number(),
	/** ISO 时间 */
	updatedAt: z.string(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

/** GET /api/v1/files?path=<工作区内相对路径> 响应；path 缺省 = 工作区根 */
export const FileListResponseSchema = z.object({
	ok: z.literal(true),
	/** 归一后的相对路径（"" = 工作区根） */
	path: z.string(),
	entries: z.array(FileEntrySchema),
});
export type FileListResponse = z.infer<typeof FileListResponseSchema>;

/**
 * GET /api/v1/files/content?path=… 响应。
 * 正文只回 UTF-8 可解码且 ≤512KB 的文本；二进制 / 超大文件 content=null、truncated=true。
 */
export const FileContentResponseSchema = z.object({
	ok: z.literal(true),
	path: z.string(),
	size: z.number(),
	truncated: z.boolean(),
	content: z.string().nullable(),
});
export type FileContentResponse = z.infer<typeof FileContentResponseSchema>;
