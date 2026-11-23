import { z } from "zod";

/*
 * 这个包刻意保持单文件：服务端用 tsx、App 用 Metro，两边对相对导入的
 * 扩展名解析规则不完全一致。共享包只有一份契约足够小，单文件最不容易出岔子。
 */

export const RoleSchema = z.enum(["system", "user", "assistant"]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * 定时主动轮的触发标记（2026-11-17）：触发模型那一轮的指令正文以它开头，
 * 回读历史时据此把这"一条用户消息"跳过——用户只看到对面主动冒出的一句话。
 * 是服务端内部常量，不是契约字段；固定字节，不要改（改了历史触发消息会重新显形）。
 * 刻意不复用 `turnAuthority: autonomous`——那是例行/唤醒共用的自主头，会误伤要保留的路。
 */
export const PROACTIVE_HIDDEN_MARKER = "[lifediary.proactive]";

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

/**
 * 文件附件（2026-11-13 附件走路径）：**只带地址，不带内容**。
 *
 * `path` 是服务端可直接 `read` 的绝对路径 —— 桌面壳里由原生选择器给出（零拷贝），
 * 浏览器里由 `POST /api/v1/agent/attachments` 落盘后回填。服务端只做 `stat` 校验，
 * 不读内容；pi-ai 没有文件类型的 Content，因此内核看到的是拼进正文的清单行
 * （见 `renderFileManifest`），由模型自己决定要不要读。
 */
export const FilePartSchema = z
  .object({
    type: z.literal("file"),
    /** 绝对路径（Windows 盘符或 `/` 开头）；长度由服务端复核 */
    path: z.string().min(1).max(4096),
    /** 展示名（原文件名） */
    name: z.string().min(1).max(255),
    /** MIME，未知就不给 */
    mimeType: z.string().max(100).optional(),
    /** 字节数，未知就不给 */
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ContentPartSchema = z.union([TextPartSchema, ImagePartSchema, FilePartSchema]);
export type ContentPart = z.infer<typeof ContentPartSchema>;
export type TextPart = z.infer<typeof TextPartSchema>;
export type ImagePart = z.infer<typeof ImagePartSchema>;
export type FilePart = z.infer<typeof FilePartSchema>;

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
 * 新建会话时客户端可带的一次模型选择（2026-11-19 会话级模型切换，纯增量）。
 * 只在不带 `conversationId` 时采用；不传 = 服务端读当前全局默认。
 */
export const ChatModelSelectionSchema = z.object({
	providerId: z.string().min(1).max(128),
	modelId: z.string().min(1).max(200),
	thinking: ThinkingLevelSchema.optional(),
});
export type ChatModelSelection = z.infer<typeof ChatModelSelectionSchema>;

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
	 * 新建 worker 对话时直接指定工作目录（2026-11-17）。
	 *
	 * 只在不带 `conversationId` 且 `chatKind=worker` 时生效：
	 * 服务端校验「存在 + 是目录 + 落在已登记根内」，反推所属项目（推不出就只绑目录）。
	 * 不传 = 沿用旧行为（当前项目主文件夹 → 主工作区）。
	 */
	dirPath: z.string().min(1).max(1024).optional(),
	/**
	 * 忙时投递方式（2026-11-07 消息即引导，纯增量；2026-11-19 插话统一改缺省）。
	 *
	 * - `steer`（缺省，2026-11-19 插话统一 批1 起）：插进**当前这一轮**，模型下一步就能看到；
	 *   多条插话全部生效（内核 steeringMode="all"）；忙时 steer 的提交正文第一行带 `[插话]` 标记。
	 * - `followUp`：排到本轮结束后，作为下一轮（改动前缺省；现降级为插件卡"忙时消息"档位）。
	 *
	 * 这是"请求"不是"保证"：本轮没有可插的边界（例如已经收尾）时内核会落到队列，
	 * 服务端照实发一条 `notice`，不把"受理"说成"已插入"。不传该字段 = 跟随服务端缺省
	 * （回滚 `AGENT_STEER_DEFAULT=false` 时缺省回 `followUp`）。
	 */
	whenBusy: z.enum(["steer", "followUp"]).optional(),
	/**
	 * 新建会话的初始模型（2026-11-19 会话级模型切换，纯增量）：
	 * 只在不带 `conversationId` 时采用；不传 = 读当前全局默认。
	 * 已有会话请走 `POST /agent/chat/:conversationId/model`，这里传了会被忽略。
	 */
	model: ChatModelSelectionSchema.optional(),
	/**
	 * 新会话的初始思考档（2026-11-21，纯增量）：只在不带 `conversationId` 时采用。
	 * 优先级：这个字段（composer 思考拨盘）> `model.thinking` > 服务端全局默认思考档
	 * （设置里默认模型带的档）> off。已有会话请走
	 * `POST /agent/chat/:conversationId/mode`，这里传了会被忽略。
	 */
	thinking: ThinkingLevelSchema.optional(),
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
  /**
   * 「说」步的正文渲染档（2026-11-10 批 32，纯增量）：`md` = `output` 是模型
   * 写给人的正文，按 markdown 渲染；缺省 = 工具输出，按纯文本 pre 渲染。
   */
  format: z.literal("md").optional(),
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
 * 读历史里附在用户消息上的文件（2026-11-13 附件走路径）。
 * 与上行 `FilePartSchema` 同形状、少一个 `type`（回读只用来渲染，不参与再提交）。
 */
export const TranscriptFileSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    mimeType: z.string().optional(),
    bytes: z.number().optional(),
  })
  .strict();
export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;

/**
 * durable 里的附件清单（2026-11-13）。
 *
 * pi-ai 的 UserInput 只有 text / image 两种 Content，文件没有位置可放，所以把
 * 文件列表写成**正文最前面的一行**：固定前缀 + JSON 数组。JSON 会把路径里的
 * 换行、引号转义掉，所以清单永远是一行，回读按"第一行 + 前缀"识别，不会跨行跑偏。
 *
 * 只由服务端写；用户手打同款前缀时，`parseFileManifest` 解析失败就原样当正文。
 */
export const FILE_MANIFEST_PREFIX = "[附件] ";
export const FILE_MANIFEST_HINT = "用户附上了以下文件，需要时用 read 工具按路径读取：";

/** 一条用户消息最多几个文件（与图片的 4 张上限互不占用） */
export const MAX_FILES_PER_MESSAGE = 8;

/** 文件列表 → durable 清单行（不含正文换行；调用方自己补空行） */
export function renderFileManifest(files: readonly TranscriptFile[]): string {
  const rows = files.map((file) => ({
    name: file.name,
    path: file.path,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(typeof file.bytes === "number" ? { bytes: file.bytes } : {}),
  }));
  return `${FILE_MANIFEST_PREFIX}${FILE_MANIFEST_HINT}${JSON.stringify(rows)}`;
}

/**
 * durable 正文 → { files, text }。
 *
 * 只认最前面那一行 `[附件] <提示><JSON[]>`；解析不出来就原样返回（不猜、不抛）。
 * 纯文件消息剥完清单后 text 是空串。
 */
export function parseFileManifest(text: string): { files: TranscriptFile[]; text: string } {
  const head = FILE_MANIFEST_PREFIX + FILE_MANIFEST_HINT;
  if (!text.startsWith(head)) return { files: [], text };
  const newline = text.indexOf("\n");
  const firstLine = newline < 0 ? text : text.slice(0, newline);
  const rest = newline < 0 ? "" : text.slice(newline + 1);
  const payload = firstLine.slice(head.length);
  let rows: unknown;
  try {
    rows = JSON.parse(payload);
  } catch {
    return { files: [], text };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { files: [], text };
  const files: TranscriptFile[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return { files: [], text };
    const value = row as Record<string, unknown>;
    if (typeof value.path !== "string" || !value.path || typeof value.name !== "string") {
      return { files: [], text };
    }
    files.push({
      path: value.path,
      name: value.name,
      ...(typeof value.mimeType === "string" && value.mimeType ? { mimeType: value.mimeType } : {}),
      ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    });
  }
  // 清单与正文之间固定一个空行（组装时写的是 `\n\n`）：剥掉清单后只去这一行
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;
  return { files, text: body.trim() ? body : "" };
}


/**
 * 一条消息的作者（2026-11-15 作者标记方案 §3.1）。
 *
 * **只有非主人来源才带**，主人自己说的话不标——对齐 cindy「本机输入不盖章」：
 * 右侧默认就是主人，需要标注的只有"不是他说的"。
 *
 * 存在意义：作者是结构，不是正文里的一行字。正文会被压缩、改写、转述吃掉，
 * 这个字段不会。界面靠它决定画在左边还是右边、给不给编辑入口。
 */
export const TranscriptAuthorSchema = z.object({
	/** 目前只有执事间递话一种；工人/群/远端将来要加，按 kind 扩，不改现有形状 */
	kind: z.enum(["partner"]),
	/** 执事 uuid（对外 id 一律 uuid） */
	id: z.string(),
	name: z.string(),
	domain: z.string().optional(),
	/** 递话跳数（通道当前恒 1；留着是为了将来两跳时不必再改形状） */
	hop: z.number().optional(),
});
export type TranscriptAuthor = z.infer<typeof TranscriptAuthorSchema>;

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
   * 这条用户消息带的文件（2026-11-13 附件走路径，纯增量，老客户端忽略）。
   * 只有路径，没有内容；文字仍走 `text`，纯文件消息 `text` 可能是空串。
   */
  files: z.array(TranscriptFileSchema).optional(),
  /**
   * 这条回答之前那一轮的工作步骤（2026-11-07，纯增量，老客户端忽略）。
   * 只挂在 assistant 上；一轮里没有工具调用就不带这个字段。
   */
  steps: z.array(TranscriptStepSchema).optional(),
  /** 那一轮从提问到收尾的墙钟时长（毫秒）；有 steps 才可能有 */
  workMs: z.number().optional(),
  /**
   * 这条 assistant 消息的**收尾时刻**（epoch 毫秒，2026-11-17，纯增量）。
   *
   * `at` 是"这次请求开始"的时间，回答下方要显示"几点答完"就得看这个字段：
   * 服务端按 `at + durationMs` 算（与 `workMs` 的收尾口径同源），读不到 `durationMs`
   * 的旧记录退回 `at`。只挂在 assistant 上；老客户端忽略即可。
   */
  endedAt: z.number().optional(),
  /**
   * 这条 user 消息是谁发的（2026-11-15 作者标记方案，纯增量，老客户端忽略）。
   *
   * 只在**非主人来源**的 user 消息上出现（目前 = 执事间递话）。没有这个字段
   * 就代表主人本人输入——与 `id`（可编辑重发的寻址）互斥：带 author 的不可编辑。
   */
  author: TranscriptAuthorSchema.optional(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export const ChatTranscriptSchema = z.object({
  conversationId: z.string(),
  messages: z.array(TranscriptMessageSchema),
  /**
   * 历史分页（2026-11-13 按天分组·上滑加载，纯增量，只有 `page=1`/`before` 请求才带）。
   * `hasMore` = 还有更早；`nextBefore` = 下一页不透明游标（没有更早时不带）。
   * 老客户端忽略即可；不带分页参数时响应形状与改动前一致。
   */
  hasMore: z.boolean().optional(),
  nextBefore: z.string().optional(),
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

/**
 * 执事档案状态（2026-11-05 批次B 定；2026-11-10 自 §伙伴节上移）：
 * GroupMember.status 与执事档案同口径复用这一枚举——Zod 组合是运行时求值，
 * 声明必须落在首个使用点之前，故放在这里而不是伙伴节。
 */
export const PartnerStatusSchema = z.enum(["active", "paused", "archived"]);
export type PartnerStatus = z.infer<typeof PartnerStatusSchema>;

export const GroupMemberSchema = z.object({
	partnerId: z.string(),
	/** 成员表只存展示名快照，不复制人格（lobehub 教训）；人格 = 各自 SOUL */
	name: z.string(),
	position: z.number().int().min(0),
	/** 档案实时状态；2026-11-08 前服务端已透出，2026-11-10 从裸 string 收紧为本文件同一枚举 */
	status: PartnerStatusSchema.optional(),
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
 * 上游/模型错误的稳定类别（2026-11-10，纯增量）。
 *
 * 为什么要有：`error.message` 是给人看的中文措辞，客户端不该拿它做判断
 * （文案一改就碎）。分类在服务端做完（见 `apps/server/src/stream-error.ts`），
 * 这里只是把结果带给前端。`detail` 已在服务端脱敏（剥 key / 上游地址）。
 */
export type StreamErrorCode =
	| "rate_limited"
	| "auth"
	| "timeout"
	| "network"
	| "context_overflow"
	| "model_error"
	| "unknown";

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
			/**
			 * 编辑类工具的 unified diff（2026-11-10 批 33，纯增量；服务端截断到 2000 字符）。
			 * 只有 `edit` 这类把 `details.diff` 放进结果里的工具才有——以前只有历史 steps
			 * 带 diff，现场工具行画不出改动，两边不一致；现在对齐（口径同 steps）。
			 */
			diff?: string;
			seq?: number;
	  }
  | { type: "done"; id: string; finishReason: FinishReason; /** 本轮 token 用量（2026-11-04 批次一）；读不到就不带 */ usage?: TurnUsage; seq?: number }
  | {
			type: "error";
			message: string;
			/**
			 * 错误类别（2026-11-10，纯增量）：`rate_limited` / `auth` / `timeout` /
			 * `network` / `context_overflow` / `model_error` / `unknown`。
			 * 客户端按 code 决定卡片措辞与动作，**不要解析 message 文案**（那是给人看的）。
			 */
			code?: StreamErrorCode;
			/**
			 * 脱敏后的细节摘要（2026-11-10，纯增量）：已剥 key / 地址，供「详情」小窗展示。
			 * 服务端保证不含密钥片段；原始上游错误只进服务端日志，绝不下发。
			 */
			detail?: string;
			seq?: number;
	  }
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
	  }
	/**
	 * 决策上报（2026-11-19 批2：worker→总管→用户上报链）。
	 *
	 * native worker 跑动中调 `escalate` 工具上报一个要拍板 / 要问的事，宿主把它
	 * 投到**派活方会话**出上报卡。与 `attention` 的分工：attention 是 worker 退场后
	 * 从 REPORT.md 读出的终态问题；escalation 是**跑动中**的实时上报，worker 不退场，
	 * 答复经插话通道（steer）回到 worker 继续跑。老客户端按 `type` 分发，认不出就忽略。
	 */
	| {
			type: "escalation";
			ticketId: string;
			domain: string;
			/** 上报 id（worker 侧生成的 uuid）；路由 / 答复端点用它寻址 */
			escalationId: string;
			/** 要拍板 / 要问的那一句话 */
			question: string;
			/** worker 补充的背景（为什么问、已经试过什么） */
			context: string;
			/** worker 给的候选答案；没有就不带 */
			options?: string[];
			/** 紧急度：worker 自报；路由只透出不改判 */
			urgency: "low" | "normal" | "high";
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

// ── 手机经中继（2026-11-11 批R）────────────────────────────────────────
//
// R1 反向 HTTP 代理：手机把 base 指到中继，REST 由中继收下、以 `invoke` 帧投给
// 名册里的任务主机执行，主机回 `invoke_result`，中继把 status/body **原样**回给手机。
// 中继不看 HTTP 语义，只补路由；查询串与正文都是原文，不做二次编码。
// 协议版本仍是 v1——新增帧都是"认不出就忽略"的增量。

export const RelayInvokePayloadSchema = z
	.object({
		/** 大写 HTTP 方法（GET/POST/…），中继按原样投递 */
		method: z.string().min(1).max(16),
		/** 完整服务端路径（含 `/api/v1` 前缀），不含查询串 */
		path: z.string().min(1).max(2048),
		/** 含前导 `?` 的查询串；没有查询串为空串 */
		query: z.string().max(2048),
		/** 只带手机原始请求的 authorization（中继不替换，也不存 harness 令牌） */
		headers: z.record(z.string()),
		/** 请求正文原文；没有正文 = null */
		body: z.string().nullable(),
	})
	.strict();
export type RelayInvokePayload = z.infer<typeof RelayInvokePayloadSchema>;

/** 中继 → 任务主机：代理一条 HTTP 请求。 */
export const RelayInvokeFrameSchema = z
	.object({
		kind: z.literal("invoke"),
		id: z.string().min(1).max(64),
		payload: RelayInvokePayloadSchema,
	})
	.strict();
export type RelayInvokeFrame = z.infer<typeof RelayInvokeFrameSchema>;

/** 任务主机 → 中继：HTTP 结果（status + 正文原文）。 */
export const RelayInvokeResultFrameSchema = z
	.object({
		kind: z.literal("invoke_result"),
		id: z.string().min(1).max(64),
		payload: z
			.object({
				status: z.number().int().min(100).max(599),
				body: z.string(),
			})
			.strict(),
	})
	.strict();
export type RelayInvokeResultFrame = z.infer<typeof RelayInvokeResultFrameSchema>;

/**
 * 名册变更广播（R3）：hello 成功与连接关闭后推给**所有在线连接**。
 * 全量投影（复用 `RelayDeviceView`），不是增量——帧小频低，省掉客户端合并逻辑。
 * 老客户端必须静默忽略未知 kind（协议既有约定）。
 */
export const RelayPresenceFrameSchema = z
	.object({
		kind: z.literal("presence"),
		devices: z.array(RelayDeviceViewSchema),
	})
	.strict();
export type RelayPresenceFrame = z.infer<typeof RelayPresenceFrameSchema>;

/** 扫码加入（R2）：一次性加入码换设备凭据。码本身即凭证，端点免 Bearer。 */
export const RelayJoinRequestSchema = z.object({
	joinCode: z.string().min(1).max(128),
	deviceName: z.string().min(1).max(40),
	platform: z.string().max(20).optional(),
});
export type RelayJoinRequest = z.infer<typeof RelayJoinRequestSchema>;

/** 加入成功只回这一次明文 deviceToken（中继只存 sha256）。 */
export const RelayJoinResponseSchema = z.object({
	deviceId: z.string().min(1),
	deviceToken: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type RelayJoinResponse = z.infer<typeof RelayJoinResponseSchema>;

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
// PartnerStatusSchema 已上移到群成员节（首个使用点之前，2026-11-10）。

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
	/**
	 * 身份保存计数（2026-11-15 快照退役：不再对应任何可回看的存档）。
	 * 每次保存 SOUL / 契约 / 候选链都 +1，只做「改完下一轮生效」的记账位；界面不展示。
	 */
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
	 * 口头禅（2026-11-12 手机对话身份方案 §四，纯增量可选）：≤40 字（按 Unicode code point，
	 * trim 后判）。`null` = 未设置（前端回落默认句）。列表与详情投影都带；不版本化，现取现用。
	 * 旧客户端忽略未知字段即可。
	 */
	tagline: z.string().nullable().optional(),
	/**
	 * 日记执事（2026-11-12 日记 v2，纯增量可选）：true = 这个执事负责「和小记聊天」那条日记线。
	 * 全局至多一个；PATCH 置 true 时服务端把其他执事的 diary 清掉。列表与详情投影都带。
	 * 旧客户端忽略未知字段即可。
	 */
	diary: z.boolean().optional(),
	/**
	 * 派发权（2026-11-06 执事派发权开关，纯增量可选）：带 domain 的执事是否作为
	 * 分管负责人接单。默认关；投影只对带 domain 的执事给，普通执事不带。
	 * 旧客户端按「忽略未知字段」处理即可。
	 */
	dispatchAuthority: z.boolean().optional(),
	/**
	 * 项目记忆归属（2026-11-15 跟人走方案立项、同日多挂载方案扩化，纯增量可选）：
	 * uuid 数组 = 这个总管 / 执事负责哪些已登记项目（人设二级页勾选，projects.sqlite
	 * 的项目 uuid，**挂载 = 可达性**：recall 全部可查、聊到的自动浮出、remember 可指名
	 * 写入——不是"每轮整包搬进上下文"）。执事自己的 partner: 键空间照旧。
	 *（PARTNER_PROJECT_MEMORY 回滚开关 2026-11-21 退役，字段恒投影；旧客户端忽略未知字段即可。）
	 * 演进注：上线首日是单值 `projectId`（uuid|null），同日改多数组——字段只活了半天、
	 * 手机端未消费，直接换名不留旧字段。
	 */
	projectIds: z.array(z.string().uuid()).optional(),
});
export type PartnerProfile = z.infer<typeof PartnerProfileSchema>;

/* ── 员工人格模块（2026-11-14，方案 `docs/设计方案/2026-11-14-员工人格模块（开关化拟人）.md`）──
 *
 * 一个员工 = 必选核心（身份节 SOUL / 主人数据红线 / 教诲通道，**不可关**）+ 可开关模块。
 * 14 个模块 id 一次定全，批次只决定哪些真的注入（批1 生效：expression / values / scenario /
 * contract / discipline / goal / workHistory / currentWork；impression / mood / heart 批2，
 * learning / proactivity / profiles 批3）。开关关 = 不进提示词、内容保留。
 * 字段上限在这里定义一次，服务端写时校验、端点的 `limits` 原样回这一份（前端不另抄数字）。 */

export const PartnerPersonaModuleIds = [
	"expression",
	"values",
	"scenario",
	"contract",
	"discipline",
	"goal",
	"workHistory",
	"currentWork",
	"impression",
	"mood",
	"heart",
	"learning",
	"proactivity",
	"profiles",
] as const;
export const PartnerPersonaModuleSchema = z.enum(PartnerPersonaModuleIds);
export type PartnerPersonaModule = z.infer<typeof PartnerPersonaModuleSchema>;

/**
 * 预设：岗位（默认）/ 陪伴 / 全才（岗位+内心全开）/ 学徒（学习观察型）/ 自定义。
 * 预设只决定开关键，随时可改；保存时服务端按最终开关表**推导**预设名
 * （2026-11-15 人设页打磨）：表与某预设一致就标该预设，否则 custom。
 * `workHistory` / `currentWork` 固定注入（2026-11-15 起不再是闸），不参与推导比较。
 */
export const PartnerPersonaPresetSchema = z.enum(["work", "companion", "allrounder", "apprentice", "custom"]);
export type PartnerPersonaPreset = z.infer<typeof PartnerPersonaPresetSchema>;

/** 句长枚举（口吻模块）。 */
export const PartnerPersonaSentenceLengthSchema = z.enum(["短", "中", "长", "不限"]);
export type PartnerPersonaSentenceLength = z.infer<typeof PartnerPersonaSentenceLengthSchema>;

/**
 * 字段上限。数字 = 最多多少**字**（Unicode code point，不是 UTF-16 `length`）；
 * `{max, each}` = 最多几条 × 每条多少字。端点 GET 原样回这一份，前端据此在前端就拦。
 */
export const PARTNER_PERSONA_LIMITS = {
	style: {
		speakStyle: 300,
		catchphrases: { max: 8, each: 24 },
		taboos: { max: 6, each: 48 },
		exampleDialogues: { max: 3, each: 400 },
		altStyle: 300,
		switchProbability: 100,
		emojiHabit: 80,
		openingLine: 120,
	},
	values: {
		cares: 200,
		bottomLines: 200,
		fears: 120,
		likes: { max: 10, each: 30 },
		dislikes: { max: 10, each: 30 },
		motivator: 100,
		valueKeywords: { max: 3, each: 8 },
	},
	scenario: {
		situation: 300,
		knowledgeBoundary: 300,
		relations: { max: 10, each: 60 },
	},
} as const;

/** 按 Unicode code point 计长的有上限字符串。 */
function personaText(limit: number, label: string) {
	return z.string().superRefine((value, ctx) => {
		if ([...value].length > limit) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}不超过 ${limit} 字` });
		}
	});
}

/** 有上限的清单：条数 + 每条字数。 */
function personaList(count: { max: number; each: number }, label: string) {
	return z
		.array(personaText(count.each, label))
		.max(count.max, { message: `${label}最多 ${count.max} 条` });
}

/** 口吻（静态模块 expression）：全字段可选，空字段不注入。 */
export const PartnerPersonaStyleSchema = z
	.object({
		speakStyle: personaText(PARTNER_PERSONA_LIMITS.style.speakStyle, "说话风格").optional(),
		sentenceLength: PartnerPersonaSentenceLengthSchema.optional(),
		catchphrases: personaList(PARTNER_PERSONA_LIMITS.style.catchphrases, "口癖").optional(),
		taboos: personaList(PARTNER_PERSONA_LIMITS.style.taboos, "忌用语").optional(),
		exampleDialogues: personaList(PARTNER_PERSONA_LIMITS.style.exampleDialogues, "示例对话").optional(),
		altStyle: personaText(PARTNER_PERSONA_LIMITS.style.altStyle, "备用风格").optional(),
		/** 备用风格的切换概率：0–100（%）。只在填了备用风格时才有意义。 */
		switchProbability: z
			.number()
			.int({ message: "切换概率是 0–100 的整数" })
			.min(0, { message: "切换概率是 0–100 的整数" })
			.max(PARTNER_PERSONA_LIMITS.style.switchProbability, { message: "切换概率是 0–100 的整数" })
			.optional(),
		emojiHabit: personaText(PARTNER_PERSONA_LIMITS.style.emojiHabit, "表情习惯").optional(),
		openingLine: personaText(PARTNER_PERSONA_LIMITS.style.openingLine, "开场白").optional(),
	})
	.strict();
export type PartnerPersonaStyle = z.infer<typeof PartnerPersonaStyleSchema>;

/** 里子（静态模块 values）：他在乎什么、守什么、怕什么、喜欢什么。 */
export const PartnerPersonaValuesSchema = z
	.object({
		cares: personaText(PARTNER_PERSONA_LIMITS.values.cares, "在乎什么").optional(),
		bottomLines: personaText(PARTNER_PERSONA_LIMITS.values.bottomLines, "底线").optional(),
		fears: personaText(PARTNER_PERSONA_LIMITS.values.fears, "怕什么").optional(),
		likes: personaList(PARTNER_PERSONA_LIMITS.values.likes, "喜好").optional(),
		dislikes: personaList(PARTNER_PERSONA_LIMITS.values.dislikes, "厌恶").optional(),
		motivator: personaText(PARTNER_PERSONA_LIMITS.values.motivator, "来劲的事").optional(),
		valueKeywords: personaList(PARTNER_PERSONA_LIMITS.values.valueKeywords, "关键词").optional(),
	})
	.strict();
export type PartnerPersonaValues = z.infer<typeof PartnerPersonaValuesSchema>;

/** 处境（静态模块 scenario）：眼下在哪、知道什么、和谁什么关系。 */
export const PartnerPersonaScenarioSchema = z
	.object({
		situation: personaText(PARTNER_PERSONA_LIMITS.scenario.situation, "眼下处境").optional(),
		knowledgeBoundary: personaText(
			PARTNER_PERSONA_LIMITS.scenario.knowledgeBoundary,
			"知识边界",
		).optional(),
		relations: personaList(PARTNER_PERSONA_LIMITS.scenario.relations, "人物关系").optional(),
	})
	.strict();
export type PartnerPersonaScenario = z.infer<typeof PartnerPersonaScenarioSchema>;

/** 三份静态内容（伙伴家目录 persona/*.json 的形状）。 */
export interface PartnerPersonaContents {
	style: PartnerPersonaStyle;
	values: PartnerPersonaValues;
	scenario: PartnerPersonaScenario;
}

/** 三份静态内容的运行时形状（人设库快照整份保存 / 应用时用）。 */
export const PartnerPersonaContentsSchema = z
	.object({
		style: PartnerPersonaStyleSchema,
		values: PartnerPersonaValuesSchema,
		scenario: PartnerPersonaScenarioSchema,
	})
	.strict();
export type PartnerPersonaContentsValue = z.infer<typeof PartnerPersonaContentsSchema>;

/* ── 员工人格 · 活模块（2026-11-15 批2，方案 §六）──
 *
 * 三个活模块各自的家（**不要合并成一份状态**）：
 *   - 印象：记忆库 `kind="impression"`，每条带 `subject`（`owner` 或群成员 id）；
 *   - 心情 / 近况：`partners` 表的列（一条 UPDATE，不版本化）；
 *   - 内心生活：伙伴家目录 `persona/diary.jsonl` / `growth.md` / `wishes.json`。
 *
 * 刻意没有（已登记 `系统架构.md`）：数值好感度（温度只有五档文字）、假装身体的生理状态、
 * agent 回写 SOUL 本体。上限在这里定义一次，端点 `limits` 原样回给前端。 */

/** 关系温度五档（2026-11-14 拍板：文字档位，不做数值好感度）。顺序即由浅到深。 */
export const PARTNER_OWNER_TIERS = ["生疏", "认识", "熟络", "亲近", "像家人"] as const;
export const PartnerOwnerTierSchema = z.enum(PARTNER_OWNER_TIERS);
export type PartnerOwnerTier = z.infer<typeof PartnerOwnerTierSchema>;

/** 心情枚举（只有这五种；不模拟生理状态，烦躁 / 疲惫只做手改选项，规则不生成）。 */
export const PARTNER_MOODS = ["平静", "愉悦", "低落", "烦躁", "疲惫"] as const;
export const PartnerMoodSchema = z.enum(PARTNER_MOODS);
export type PartnerMood = z.infer<typeof PartnerMoodSchema>;

/** 活内容上限（Unicode code point 计长，与静态模块同一口径）。 */
export const PARTNER_LIVING_LIMITS = {
	impressionText: 120,
	/** 每个对象最多留多少条印象（超出淘汰最旧；跨档记录不淘汰）。 */
	impressionsPerSubject: 20,
	nearby: 60,
	moodReason: 60,
	diaryText: 300,
	/** 员工日记最多留多少条（超出淘汰最旧）。 */
	diaryEntries: 500,
	weeklyWords: 80,
	growthNote: 400,
	wishText: 40,
	wishes: 10,
} as const;

/**
 * 一条印象（记忆库 `kind="impression"` 的正文 JSON）。
 * `tierChange` = 这条就是温度跨档事件（变化后的档位）；没有它的条目是档内累积。
 */
export const PartnerImpressionSchema = z
	.object({
		id: z.string(),
		/** `owner` 或群成员的对外 id（uuid）。 */
		subject: z.string().min(1).max(64),
		text: personaText(PARTNER_LIVING_LIMITS.impressionText, "印象"),
		at: z.string(),
		source: z.enum(["generated", "manual"]),
		/** 事件类型：致谢 / 被纠正；普通条目不带。只有前两种由规则生成。 */
		event: z.enum(["thanks", "correction"]).optional(),
		tierChange: PartnerOwnerTierSchema.optional(),
	})
	.strict();
export type PartnerImpression = z.infer<typeof PartnerImpressionSchema>;

/** 员工日记一条（`persona/diary.jsonl` 的一行）。`liked` 只影响列表排序，不做算法。 */
export const PartnerDiaryEntrySchema = z
	.object({
		id: z.string(),
		at: z.string(),
		text: personaText(PARTNER_LIVING_LIMITS.diaryText, "日记"),
		source: z.enum(["generated", "manual"]),
		liked: z.boolean().optional(),
	})
	.strict();
export type PartnerDiaryEntry = z.infer<typeof PartnerDiaryEntrySchema>;

/** 愿望清单（`persona/wishes.json`）：≤10 条 × 每条 ≤40 字。 */
export const PartnerWishListSchema = z
	.array(personaText(PARTNER_LIVING_LIMITS.wishText, "愿望"))
	.max(PARTNER_LIVING_LIMITS.wishes, { message: `愿望最多 ${PARTNER_LIVING_LIMITS.wishes} 条` });
export type PartnerWishList = z.infer<typeof PartnerWishListSchema>;

/**
 * PUT `/partners/:id/persona` 的 `living` 段：手改活状态。
 * 每次只做一个动作（按字段/按条目），避免"整份覆盖"把并发生成的内容冲掉。
 * 手改一律写 `manual` 标记：印象 / 日记的 source、温度的 tierChange 账都记 manual。
 */
export const PartnerLivingPatchSchema = z
	.object({
		/** 手改温度 = 一次可解释的跨档事件（写一条带 tierChange 的 manual 印象）。 */
		ownerTier: PartnerOwnerTierSchema.optional(),
		nearby: personaText(PARTNER_LIVING_LIMITS.nearby, "近况").optional(),
		mood: PartnerMoodSchema.optional(),
		moodReason: personaText(PARTNER_LIVING_LIMITS.moodReason, "心情原因").optional(),
		/** 整份替换（愿望清单本来就是一份小列表，改哪条都等于整份）。 */
		wishes: PartnerWishListSchema.optional(),
		impression: z
			.union([
				z
					.object({
						add: z
							.object({ subject: z.string().min(1).max(64), text: personaText(PARTNER_LIVING_LIMITS.impressionText, "印象") })
							.strict(),
					})
					.strict(),
				z
					.object({
						update: z
							.object({ id: z.string(), text: personaText(PARTNER_LIVING_LIMITS.impressionText, "印象") })
							.strict(),
					})
					.strict(),
				z.object({ remove: z.string() }).strict(),
			])
			.optional(),
		diary: z
			.union([
				z.object({ add: personaText(PARTNER_LIVING_LIMITS.diaryText, "日记") }).strict(),
				z
					.object({
						edit: z
							.object({ id: z.string(), text: personaText(PARTNER_LIVING_LIMITS.diaryText, "日记") })
							.strict(),
					})
					.strict(),
				z.object({ like: z.string() }).strict(),
				z.object({ unlike: z.string() }).strict(),
				z.object({ remove: z.string() }).strict(),
			])
			.optional(),
	})
	.strict();
export type PartnerLivingPatch = z.infer<typeof PartnerLivingPatchSchema>;

/** 活模块的子开关（`persona_switches` 列）：口吻影响 + 挂念提醒（批3）+ 记忆召回（2026-11-15）。 */
export const PartnerPersonaSwitchesSchema = z
	.object({
		moodAffectTone: z.boolean().optional(),
		/** 挂念提醒（2026-11-15 批3）：默认关；开 = 允许在既有唤醒时机发一条带身份的挂念。 */
		nudgeEnabled: z.boolean().optional(),
		/**
		 * 记忆召回（2026-11-15 人设页打磨二轮）：默认开（未出现 = 开）。
		 * `false` = 这一位的会话每轮不再自动带记忆（`recall` 工具仍可主动查）。
		 * 只管"自动注入"这一半，不动记忆库本身。
		 */
		memoryRecallEnabled: z.boolean().optional(),
	})
	.strict();
export type PartnerPersonaSwitches = z.infer<typeof PartnerPersonaSwitchesSchema>;

/* ── 员工人格 · 批3（2026-11-15）：学习 / 主动性 / 人设库 ──
 *
 * 三块都默认关，且受 `PARTNER_PERSONA_MODULES` 总开关约束。
 * 红线：`voice.json` 只存提炼后的规则与 ≤40 字短例句，不存整段对话原文；
 * 不进日志、不进 export-bundle、不进团队包（团队包本来只搬 SOUL / 契约 / 技能 / 偏好经验）。
 * 挂念提醒必须带执事身份（正文前缀 `【名字】`），一天最多一条。 */

export const PARTNER_VOICE_LIMITS = {
	/** 单条表达规则正文上限 */
	ruleText: 60,
	/** 短例句上限（硬红线：40 字，不存整段对话） */
	example: 40,
	/** 最多保留多少条规则 */
	rules: 16,
	/** 最多保留多少条短例句（滚动覆盖最旧） */
	samples: 8,
	/** 最多保留多少条黑话 / 新词规则 */
	jargon: 12,
} as const;

export const PARTNER_VOICE_RULE_KINDS = [
	"sentenceLength",
	"address",
	"interjection",
	"jargon",
] as const;
export const PartnerVoiceRuleKindSchema = z.enum(PARTNER_VOICE_RULE_KINDS);
export type PartnerVoiceRuleKind = z.infer<typeof PartnerVoiceRuleKindSchema>;

/** 一条学到的表达习惯（`persona/voice.json` 的 rules 元素）。 */
export const PartnerVoiceRuleSchema = z
	.object({
		kind: PartnerVoiceRuleKindSchema,
		text: personaText(PARTNER_VOICE_LIMITS.ruleText, "表达习惯"),
		/** 短例句 ≤40 字；不是整段对话原文。 */
		example: personaText(PARTNER_VOICE_LIMITS.example, "例句").optional(),
		at: z.string(),
	})
	.strict();
export type PartnerVoiceRule = z.infer<typeof PartnerVoiceRuleSchema>;

/** 端点 / 档案页的「已学表达习惯」投影（`enabled=false` 时整段为 null）。 */
export interface PartnerVoiceView {
	ruleCount: number;
	/** 黑话 / 新词条数（rules 里 kind=jargon 的数量）。 */
	jargonCount: number;
	rules: PartnerVoiceRule[];
	updatedAt: string | null;
}

/** 人设库上限：最多 5 份快照；名称 ≤24 字。 */
export const PARTNER_PROFILE_LIMITS = { count: 5, name: 24 } as const;

/**
 * 人设库的一份命名快照（`persona/profiles.json` 的 items 元素）。
 * `contents` 是**保存当时**的整套静态内容；应用 = 整份写回，SOUL 不动。
 */
export const PartnerPersonaProfileSnapshotSchema = z
	.object({
		id: z.string(),
		name: personaText(PARTNER_PROFILE_LIMITS.name, "人设名"),
		createdAt: z.string(),
		preset: PartnerPersonaPresetSchema,
		modules: z.record(PartnerPersonaModuleSchema, z.boolean()),
		contents: PartnerPersonaContentsSchema,
	})
	.strict();
export type PartnerPersonaProfileSnapshot = z.infer<typeof PartnerPersonaProfileSnapshotSchema>;

/** 端点投影里的一份快照摘要（不含 contents：档案页只需要名称 / 预设 / 开关数）。 */
export interface PartnerPersonaProfileSummary {
	id: string;
	name: string;
	createdAt: string;
	preset: PartnerPersonaPreset;
	modules: Record<PartnerPersonaModule, boolean>;
}

export interface PartnerPersonaProfilesView {
	limit: number;
	items: PartnerPersonaProfileSummary[];
}

/** 挂念提醒的可见状态（`enabled=false` 时整段为 null）。 */
export interface PartnerProactivityView {
	nudgeEnabled: boolean;
	lastNudgeAt: string | null;
}

/** PUT 人设库动作：一次只做一件（存 / 应用 / 删）。 */
export const PartnerProfilesActionSchema = z
	.object({
		save: z
			.object({ name: personaText(PARTNER_PROFILE_LIMITS.name, "人设名") })
			.strict()
			.optional(),
		apply: z.object({ id: z.string().min(1).max(64) }).strict().optional(),
		remove: z.object({ id: z.string().min(1).max(64) }).strict().optional(),
	})
	.strict()
	.refine(
		(value) =>
			[value.save, value.apply, value.remove].filter((item) => item !== undefined).length === 1,
		{ message: "人设库一次只能做一件事（存 / 应用 / 删）" },
	);
export type PartnerProfilesAction = z.infer<typeof PartnerProfilesActionSchema>;

/** 端点的活状态投影（GET / PUT 同一份形状；`enabled=false` 时整段为 null）。 */
export interface PartnerLivingView {
	ownerTier: PartnerOwnerTier;
	/** 最近一次跨档事件的说明（来自带 `tierChange` 的印象），没有则 null。 */
	tierNote: string | null;
	mood: {
		mood: PartnerMood;
		reason: string;
		nearby: string;
		updatedAt: string | null;
		source: "rule" | "manual" | null;
	};
	/** 全部印象（按对象分组，单对象 ≤20 条）。`subjectName` 是读取时解析的展示名。 */
	impressions: Array<PartnerImpression & { subjectName: string }>;
	diary: {
		count: number;
		latestAt: string | null;
		latestText: string | null;
		/** 最近 50 条（最早的在前）；"赞 / 删"按 id 操作，不需要一次拉全量。 */
		entries: PartnerDiaryEntry[];
	};
	/** 成长笔记最近一节（`persona/growth.md` 的尾部），没有则 null。 */
	growth: string | null;
	wishes: string[];
}

/** PUT /api/v1/partners/:id/persona 的 body：按模块部分更新（省略 = 不改）。 */
export const PartnerPersonaPatchSchema = z
	.object({
		preset: PartnerPersonaPresetSchema.optional(),
		/** 只写给出的模块；键必须是 14 个 id 之一，值必须是布尔。 */
		modules: z.record(PartnerPersonaModuleSchema, z.boolean()).optional(),
		/** 子开关（2026-11-15 批2）：目前只有 `moodAffectTone`。省略 = 不改。 */
		switches: PartnerPersonaSwitchesSchema.optional(),
		/** 只写给出的模块；模块内按**字段**合并（省略的字段不动，空串 = 清空该字段）。 */
		contents: z
			.object({
				style: PartnerPersonaStyleSchema.optional(),
				values: PartnerPersonaValuesSchema.optional(),
				scenario: PartnerPersonaScenarioSchema.optional(),
			})
			.strict()
			.optional(),
		/** 活状态手改（2026-11-15 批2）：温度 / 心情 / 近况 / 愿望 / 印象 / 日记。 */
		living: PartnerLivingPatchSchema.optional(),
		/** 人设库（2026-11-15 批3）：存一份当前快照 / 应用某份 / 删某份，一次只做一件。 */
		profiles: PartnerProfilesActionSchema.optional(),
	})
	.strict();
export type PartnerPersonaPatch = z.infer<typeof PartnerPersonaPatchSchema>;

/**
 * GET / PUT /api/v1/partners/:id/persona 的响应。
 * `modules` 永远是**有效开关的完整表**（预设默认 + 行上显式值的合并结果），前端不用自己算。
 * `enabled` = `PARTNER_PERSONA_MODULES` 开关（false 时前端整块隐藏；字段仍回默认值）。
 */
export interface PartnerPersonaView {
	ok: true;
	enabled: boolean;
	preset: PartnerPersonaPreset;
	modules: Record<PartnerPersonaModule, boolean>;
	/** 当前生效的子开关（未写过的按默认值回：挂念默认关、记忆召回默认开）。 */
	switches: { moodAffectTone: boolean; nudgeEnabled: boolean; memoryRecallEnabled: boolean };
	contents: PartnerPersonaContents;
	/** 活状态（批2）；`enabled=false` 时为 null（整块隐藏，不假装有状态）。 */
	living: PartnerLivingView | null;
	/** 学到的表达习惯（批3）；`enabled=false` 时为 null；模块关 = 内容保留、仍回读。 */
	voice: PartnerVoiceView | null;
	/** 主动性的挂念状态（批3）；`enabled=false` 时为 null。 */
	proactivity: PartnerProactivityView | null;
	/** 人设库（批3）；`enabled=false` 时为 null；模块关 = 内容保留、仍回读。 */
	profiles: PartnerPersonaProfilesView | null;
	limits: typeof PARTNER_PERSONA_LIMITS & {
		living: typeof PARTNER_LIVING_LIMITS;
		voice: typeof PARTNER_VOICE_LIMITS;
		profiles: typeof PARTNER_PROFILE_LIMITS;
	};
}

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
