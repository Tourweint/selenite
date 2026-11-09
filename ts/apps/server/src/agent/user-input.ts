import type { OutgoingPart } from "../attachments.ts";

/**
 * 人的消息的提交形状（2026-11-09 主动性与例行 T2 §5）。
 *
 * **产品承诺：人的消息永远插得上话。** 派单 / 例行 / 群轮进行中，用户对同一会话
 * 发新消息 → 必须是 `followUp`（排队到本轮收尾），**不得被拒、不得丢**。
 *
 * 这里把缺省值写死成 `followUp`，不依赖内核的缺省：内核以后改默认值也改变不了
 * 这条产品承诺。`steer` 只在客户端明确要求时才用（那是"插进当前轮"的更强语义）。
 * 机制本身不在这里改——提交、排队、落库仍是 durable 的事。
 */
export const DEFAULT_USER_INPUT_WHEN_BUSY = "followUp" as const;

export interface UserInputSubmission {
	type: "input";
	content: string | OutgoingPart[];
	requestId?: string;
	whenBusy: "steer" | "followUp";
}

export function userInputSubmission(input: {
	text: string;
	parts?: OutgoingPart[];
	requestId?: string;
	whenBusy?: "steer" | "followUp";
}): UserInputSubmission {
	return {
		type: "input",
		content: input.parts ?? input.text,
		...(input.requestId ? { requestId: input.requestId } : {}),
		whenBusy: input.whenBusy ?? DEFAULT_USER_INPUT_WHEN_BUSY,
	};
}
