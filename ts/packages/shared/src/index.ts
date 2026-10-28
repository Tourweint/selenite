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
 * 也没有任何服务端状态句柄——上下文由客户端每轮带来（与 Java 版 D3 一致，
 * M1 落库时会明确改掉这一条）。
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
  | { type: "start"; id: string }
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
