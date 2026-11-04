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
 */
export type ChatEvent =
	/** conversationId 只在首轮有意义：新建会话时由服务端生成，客户端要存下来 */
	| { type: "start"; id: string; conversationId: string }
  | { type: "delta"; text: string }
	/**
	 * 思考正文增量（2026-11-04 批次一）。
	 *
	 * 与 `progress.phase=thinking` 的分工：那个只说"在想"，这个给"想了什么"。
	 * deep 档才有内容；快档不发。客户端累计成段折叠展示，老客户端按 type 忽略。
	 */
	| { type: "thinking"; text: string }
	/** 在想 / 在动手。只有两次之间才有意义，客户端当状态用 */
	| { type: "progress"; phase: TurnPhase }
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
	  }
  | { type: "done"; id: string; finishReason: FinishReason; /** 本轮 token 用量（2026-11-04 批次一）；读不到就不带 */ usage?: TurnUsage }
  | { type: "error"; message: string }
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
	  }
	/** 需要人回答：一条问题，不是一句"出错了"（2026-11-03） */
	| {
			type: "attention";
			ticketId: string;
			domain: string;
			kind: "need_input" | "need_decision" | "need_action";
			question: string;
	  };

/** 任务单对外的阶段：按"在等谁"分，不按内部进度。 */
export type DelegationPhase =
	| "accepted"
	| "planning"
	| "running"
	| "reviewing"
	| "done"
	| "needs_you"
	| "failed"
	| "aborted";

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
