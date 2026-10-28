import { z } from "zod";

/*
 * 这个包刻意保持单文件：服务端用 tsx、App 用 Metro，两边对相对导入的
 * 扩展名解析规则不完全一致。共享包只有一份契约足够小，单文件最不容易出岔子。
 */

export const RoleSchema = z.enum(["system", "user", "assistant"]);
export type Role = z.infer<typeof RoleSchema>;

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
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const FinishReasonSchema = z.enum(["stop", "length", "aborted", "error"]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

/**
 * SSE 下行事件。客户端只依赖这一个联合类型，
 * 服务端加减字段时另一端会被编译器当场指出来——这就是共用一份定义的意义。
 */
export type ChatEvent =
	/** conversationId 只在首轮有意义：新建会话时由服务端生成，客户端要存下来 */
	| { type: "start"; id: string; conversationId: string }
  | { type: "delta"; text: string }
  | { type: "done"; id: string; finishReason: FinishReason }
  | { type: "error"; message: string };

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
