/**
 * 对话请求与转写（ChatRequest / 步骤 / 附件清单 / 转写消息）
 *
 * 2026-11-13 从 packages/shared/src/index.ts（契约单文件）按行区间 L121–L330 整段切出；正文原文搬运，未改一行。
 * index.ts 变成纯桶，继续对外提供同样的符号；环由构建期依赖图检查保证为无环。
 */
import { z } from "zod";
import { ChatMessageSchema, NewChatKindSchema } from "./chat-base.ts";

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

export const TranscriptImageSchema = z
  .object({
    mimeType: z.string(),
    data: z.string(),
  })
  .strict();

export type TranscriptImage = z.infer<typeof TranscriptImageSchema>;

export const TranscriptFileSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    mimeType: z.string().optional(),
    bytes: z.number().optional(),
  })
  .strict();

export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;

export const FILE_MANIFEST_PREFIX = "[附件] ";

export const FILE_MANIFEST_HINT = "用户附上了以下文件，需要时用 read 工具按路径读取：";

export const MAX_FILES_PER_MESSAGE = 8;

export function renderFileManifest(files: readonly TranscriptFile[]): string {
  const rows = files.map((file) => ({
    name: file.name,
    path: file.path,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(typeof file.bytes === "number" ? { bytes: file.bytes } : {}),
  }));
  return `${FILE_MANIFEST_PREFIX}${FILE_MANIFEST_HINT}${JSON.stringify(rows)}`;
}

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


