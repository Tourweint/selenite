/**
 * 消息与内容分段（角色 / 思考档 / 文本·图片·文件段 / 会话类型）
 *
 * 2026-11-13 从 packages/shared/src/index.ts（契约单文件）按行区间 L1–L120 整段切出；正文原文搬运，未改一行。
 * index.ts 变成纯桶，继续对外提供同样的符号；环由构建期依赖图检查保证为无环。
 */
import { z } from "zod";

export const RoleSchema = z.enum(["system", "user", "assistant"]);

export type Role = z.infer<typeof RoleSchema>;

export const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);

export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

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

export function chatContentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export const ChatKindSchema = z.enum(["chief", "worker", "partner"]);

export type ChatKind = z.infer<typeof ChatKindSchema>;

export const NewChatKindSchema = ChatKindSchema.exclude(["partner"]);

export type NewChatKind = z.infer<typeof NewChatKindSchema>;


