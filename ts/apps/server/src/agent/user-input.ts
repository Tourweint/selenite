import { flagEnabled } from "../flags.ts";
import type { OutgoingPart } from "../attachments.ts";

/**
 * 人的消息的提交形状（2026-11-09 主动性与例行 T2 §5；2026-11-19 插话统一 批1 改口径）。
 *
 * **产品承诺：人的消息永远插得上话。** 派单 / 例行 / 群轮进行中，用户对同一会话
 * 发新消息 → 必须是 `steer`（插进当前轮），**不得被拒、不得丢**；没赶上本轮的
 * 边界就如实回执（沿用 inserted / new-turn 诚实回执），不谎报"已经插进去了"。
 *
 * 这里把缺省值写死成 `steer`，不依赖内核的缺省：内核以后改默认值也改变不了
 * 这条产品承诺。`followUp`（排队到本轮收尾）降级为插件卡选项——前端显式传值，
 * 或回滚开关 `AGENT_STEER_DEFAULT=false` 时回到改动前的排队口径。
 * 机制本身不在这里改——提交、插话、落库仍是 durable 的事。
 */
export const DEFAULT_USER_INPUT_WHEN_BUSY = "steer" as const;

/**
 * 缺省 whenBusy（2026-11-19 插话统一 批1）：默认插话；
 * `AGENT_STEER_DEFAULT=false`（/ 插件卡"忙时消息"关）→ 缺省回 followUp（改动前口径）。
 */
export function defaultUserInputWhenBusy(env: NodeJS.ProcessEnv = process.env): "steer" | "followUp" {
	return flagEnabled("AGENT_STEER_DEFAULT", env) ? DEFAULT_USER_INPUT_WHEN_BUSY : "followUp";
}

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
		whenBusy: input.whenBusy ?? defaultUserInputWhenBusy(),
	};
}
