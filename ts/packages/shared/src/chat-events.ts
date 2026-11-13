/**
 * 流式事件联合（FinishReason / TurnUsage / StreamErrorCode / ChatEvent）
 *
 * 2026-11-13 从 packages/shared/src/index.ts（契约单文件）按行区间 L436–L620 整段切出；正文原文搬运，未改一行。
 * index.ts 变成纯桶，继续对外提供同样的符号；环由构建期依赖图检查保证为无环。
 */
import type { FinishReason, GroupSender, TurnUsage } from "./group-schemas.ts";
import type { DelegationPhase } from "./relay-schemas.ts";

export type TurnPhase = "thinking" | "working";

export type StreamErrorCode =
	| "rate_limited"
	| "auth"
	| "timeout"
	| "network"
	| "context_overflow"
	| "model_error"
	| "unknown";

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
	  };

export interface ReplayEvent {
	/** 完整事件帧（含 seq）。 */
	event: ChatEvent;
}


