import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { CHIEF_PARTNER_ID, partnersStore } from "./partners.ts";
import { emitDelegation } from "./delegation.ts";
import { isTaskSession } from "./unattended.ts";
import { encodeToolResult, err, ok, type ToolResult } from "./tool-result.ts";

/**
 * agent → 用户中途播报（2026-11-10 批 13 §三，全景调研 #18）。
 *
 * 语义 = **长任务中途主动说一句，不结束本轮**。与 steer 正交：steer 是人→agent，
 * 这里是 agent→人。
 *
 * 送达口径（照 8d / 派单进度的既有纪律）：
 *   - 写一条 `notice` 帧到**正在流式的那条会话**（`delegation.ts` 的 emitDelegation 通道）；
 *   - 若当前会话同时是任务专线，再镜像一条（`task-conversation.ts` 的系统条目）；
 *   - **没有开流就收不到、不落盘**——不伪造主人的时间线。
 *
 * 上架范围（任务书 §3.4）：只在执事轮与任务专线；主人（总管）对话不上架。
 * 工具注册是全局的，所以"不上架"由 lifecycle 的 beforeTool 结构性地拦住。
 *
 * 频率闸：同一会话**每轮最多 3 条**，第 4 条起返回引导话术（不是错误）。
 */

export const PROGRESS_TOOL_NAME = "report_progress";
export const PROGRESS_MESSAGE_LIMIT = 200;
export const PROGRESS_MAX_PER_RUN = 3;

/** 回滚开关：默认开；`AGENT_PROGRESS_REPORT=false` / `0` / `off` → 工具不上架。 */
export function progressReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.AGENT_PROGRESS_REPORT ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 超限时的引导话术（不是错误：本轮还能继续做别的）。 */
export function progressCapMessage(limit: number = PROGRESS_MAX_PER_RUN): string {
	return (
		`这一轮已经播报了 ${limit} 条，上限就是 ${limit} 条。` +
		"把剩下几件事合并成一条再说，或者留到最后的回复里一起说。"
	);
}

/** 上架范围：任务专线，或执事自己的会话（总管 / 主人对话 / 群会话都不算）。 */
export function progressReportAllowed(conversationId: number): boolean {
	if (isTaskSession(conversationId)) return true;
	let partnerId: string | null = null;
	try {
		const store = partnersStore();
		if (store.isGroupSession(conversationId)) return false;
		partnerId = store.partnerIdOfSession(conversationId);
	} catch {
		return false;
	}
	return partnerId !== null && partnerId !== CHIEF_PARTNER_ID;
}

/** 这一轮的身份键：与 turn-gate / relay 同一口径（`inputs[0] ?? taskId`）。 */
export function progressRunKey(
	conversationId: number,
	live: { run?: { inputs?: readonly unknown[]; taskId?: unknown } } | null | undefined,
): string {
	return `${conversationId}:${String(live?.run?.inputs?.[0] ?? live?.run?.taskId ?? "none")}`;
}

// 每 run 已播条数（key = run 键）。会话切换 run 时丢掉上一轮的计数，Map 不随轮次增长。
const progressUses = new Map<string, number>();
const lastRunKey = new Map<number, string>();

/** 取一个播报名额；返回 false = 这一轮已到上限。 */
export function takeProgressSlot(
	conversationId: number,
	runKey: string,
): { allowed: boolean; used: number } {
	const previous = lastRunKey.get(conversationId);
	if (previous && previous !== runKey) progressUses.delete(previous);
	lastRunKey.set(conversationId, runKey);

	const used = progressUses.get(runKey) ?? 0;
	if (used >= PROGRESS_MAX_PER_RUN) return { allowed: false, used };
	const next = used + 1;
	progressUses.set(runKey, next);
	return { allowed: true, used: next };
}

/** 测试用：清空进程内计数。 */
export function resetProgressState(): void {
	progressUses.clear();
	lastRunKey.clear();
}

/** 主人时间线上的那条文案。正文本身就是模型要说的那句（≤200 字）。 */
export function progressNoticeText(message: string): string {
	return `【进度】${message}`;
}

export interface ProgressReportDeps {
	/** 任务专线镜像（装配层注入；不传 = 不镜像） */
	mirrorTaskNotice?: (conversationId: number, text: string) => void;
	/** 测试用：覆盖上架范围判定 */
	allowed?: (conversationId: number) => boolean;
}

export function createReportProgressTool(deps: ProgressReportDeps = {}): ToolRegistration {
	const allowed = deps.allowed ?? progressReportAllowed;

	return defineTool({
		name: PROGRESS_TOOL_NAME,
		description:
			"长任务做到一半时，主动对主人说一句进展（**不会结束本轮**）。" +
			"适合：跨了好几步、要跑好几分钟的活，中间有一句值得让人先知道的话（" +
			"「已经定位到问题，正在改」「前两步做完，第三步要再等一会儿」）。" +
			`每次不超过 ${PROGRESS_MESSAGE_LIMIT} 字，一条说一件事；每轮最多 ${PROGRESS_MAX_PER_RUN} 条，` +
			"超了就合并成一条。**不适合**：一句话就能汇报完的短活、纯寒暄、把最终结论拆成好几条。" +
			"这句话会出现在主人正在看的对话流里；没开流就收不到，也不会补写历史。",
		parameters: Type.Object({
			message: Type.String({
				description: `要说的那一句，不超过 ${PROGRESS_MESSAGE_LIMIT} 字`,
			}),
		}),
		execute: async (args, api, context) => {
			const conversationId = Number(api.conversationId);
			const message = String(args.message ?? "").replace(/\s+/g, " ").trim();
			if (!message) return text(err("progress_empty", "message 不能为空。", "说一句话再说。"));
			if (message.length > PROGRESS_MESSAGE_LIMIT) {
				return text(
					err(
						"progress_too_long",
						`这条 ${message.length} 字，超过 ${PROGRESS_MESSAGE_LIMIT} 字上限。`,
						"压缩成一句再说。",
					),
				);
			}
			if (!allowed(conversationId)) {
				return text(
					err(
						"progress_out_of_scope",
						"这个会话不需要中途播报（主人就在对话里看着）。",
						"把结果直接写进回复即可。",
					),
				);
			}

			const live = await api.snapshot(LiveDoc, api.conversationId, context);
			const slot = takeProgressSlot(conversationId, progressRunKey(conversationId, live));
			if (!slot.allowed) {
				return text(err("progress_cap_reached", progressCapMessage(), "合并成一条，或留到最后一起说。"));
			}

			const notice = progressNoticeText(message);
			emitDelegation(conversationId, { type: "notice", text: notice });
			deps.mirrorTaskNotice?.(conversationId, notice);
			// 日志只记字数与序号，不记正文（对话内容不进日志）。
			console.log(`[progress] 会话 ${conversationId} 第 ${slot.used} 条（${message.length} 字）`);
			return text(
				ok({
					used: slot.used,
					limit: PROGRESS_MAX_PER_RUN,
					message: `已播报（本轮第 ${slot.used} 条）。继续做手里的事，不要结束本轮。`,
				}),
			);
		},
	});
}

function text<T>(result: ToolResult<T>) {
	return { output: [{ type: "text" as const, text: encodeToolResult(result) }] };
}
