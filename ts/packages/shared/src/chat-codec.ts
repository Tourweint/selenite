/**
 * SSE 编解码（encodeSseEvent / 增量解码器）
 *
 * 2026-11-13 从 packages/shared/src/index.ts（契约单文件）按行区间 L621–L680 整段切出；正文原文搬运，未改一行。
 * index.ts 变成纯桶，继续对外提供同样的符号；环由构建期依赖图检查保证为无环。
 */
import type { ChatEvent } from "./chat-events.ts";

export function encodeSseEvent(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

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


