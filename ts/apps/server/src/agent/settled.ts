import type { SettledSubmissionRecord } from "@earendil-works/pi-durable";
import type { MemoryScope } from "@lifediary/memory";
import { chatContentText, type ChatMessage } from "@lifediary/shared";
import { pruneSessionMemory } from "../memory-prune.ts";
import { noteTurnSettlement } from "../partner-living.ts";
import { CHIEF_PARTNER_ID, partnersStore } from "../partners.ts";
import { appendPersonaExport, personaExportEnabled } from "../persona-export.ts";
import { memoryEngine, preferenceScopeOf } from "./assist.ts";
import { TASK_CONVERSATION_PREFIX } from "./shared.ts";

/**
 * 「这一轮真正收尾」的统一动作（2026-11-08 扫尾批 4a 从 index.ts 抽出；
 * 2026-11-08 批 10-A 下沉成独立模块，供审批续跑轮共用）。
 *
 * 原来这段内联在 `/chat` 的流里；编辑重发与审批续跑都在后台跑同一套 `chatStream`，
 * 抽出来才能保证"观察层 / 记忆抽取 / 会话记忆修剪"只有一份实现。
 *
 * 为什么观察层用**注入**而不是直接 import `autonomy.ts`：
 * `autonomy.ts` 反过来 import 桶 `agent.ts`，而本模块在 `agent/` 里被 session.ts 引用，
 * 直接 import 会绕成一个环。启动时由 index.ts 把 `autonomyObserver().onTurnSettled`
 * 塞进来，装配关系留在顶层，内核文件之间保持单向。
 *
 * 记忆只吃文本：图片不进记忆，去的是"他说了什么"。
 */
export type TurnSettledObserver = (
	conversationId: number,
	status: SettledSubmissionRecord["status"],
	reason: string,
) => void;

let observer: TurnSettledObserver | null = null;

/** 启动装配调用一次；传 null 只给单测清理用。 */
export function setTurnSettledObserver(next: TurnSettledObserver | null): void {
	observer = next;
}

export interface SettledChat {
	internalId: number;
	externalId: string;
}

/**
 * 本轮最终 assistant 文本的懒读取（2026-11-09 persona 接入批二）。
 *
 * `plain` 是**请求时刻**的消息快照，客户端通常只带这一句 user，拿不到本轮新生成的回复；
 * 内核在 settle 后由 session.ts 提供"读 durable 里本轮最后一条 assistant"的入口。
 * 只有导出开关打开、且 plain 里没有尾随 assistant 时才会被调用（默认关 = 零成本）。
 */
export type TurnReplyReader = () => Promise<string>;

export function turnSettledHandler(chat: SettledChat, messages: ChatMessage[]) {
	const scope: MemoryScope = { type: "session", id: String(chat.internalId) };
	const plain = messages.map((message) => ({
		role: message.role,
		content: chatContentText(message.content),
	}));
	return (record: SettledSubmissionRecord, replyText?: TurnReplyReader): void => {
		// 观察层的 errored/usage-limit 事件源（批次C C1）；开关关着时内部直接返回
		observer?.(
			Number(chat.internalId),
			record.status,
			record.status === "unanswered" ? record.reason : "",
		);
		// persona 导出（2026-11-09 批二）：done 轮追加一行；开关默认关，三项会话过滤在模块内。
		// 不 await —— 写盘慢了不拖对话；失败只 warn（导出绝不能打断对话）。
		if (record.status === "done" && personaExportEnabled()) {
			appendPersonaExport(chat, plain, undefined, {
				turnId: String(record.id),
				...(replyText ? { reply: replyText } : {}),
			});
		}
		// 活模块的结算钩子（2026-11-15 批2）：只认执事的**主会话**（canonical）。
		// 例行 / 课题专线跑的是提示词不是人在说话，把它的正文当"主人态度"提炼会张冠李戴；
		// 群成员会话有自己的回合编排（group-runtime），不走这里。
		// 模块关 / 总管 / 没有可提炼的事 → 内部直接返回，日志只记条数与枚举。
		// 刻意放在 `memoryEngine` 判空**之前**：印象有自己的库，不依赖记忆引擎开没开。
		if (record.status === "done") {
			try {
				const partnerId = partnersStore().canonicalPartnerIdOfSession(chat.internalId);
				if (partnerId && partnerId !== CHIEF_PARTNER_ID) {
					noteTurnSettlement({ partnerId, messages: plain });
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[persona] 结算钩子装配失败（不影响对话）: ${detail.slice(0, 200)}`);
			}
		}
		if (!memoryEngine || record.status !== "done") return;
		// 任务专线（`task-` 前缀，2026-11-08 扫尾批 8g）不进记忆引擎：就算主人从会话页
		// 直接点开它回话，也不该把"任务过程"沉淀成关于人的记忆（与研究回合同一口径）。
		if (chat.externalId.startsWith(TASK_CONVERSATION_PREFIX)) return;
		// 刻意不 await —— 记忆写慢了不该拖慢任何东西
		void memoryEngine
			.ingestTurn(plain, scope, {
				// 2026-11-06：偏好挂更宽的 scope（主人 global / 执事 partner:<id>），
				// 其余仍落本会话。不传这个参数 = 全部落本会话，与旧行为一致。
				preferenceScope: preferenceScopeOf(chat.internalId),
			})
			.then((result) => {
				if (result.added.length > 0 || result.reinforced.length > 0) {
					console.log(`[memory] +${result.added.length} ~${result.reinforced.length}`);
				}
				// 写入路径末尾按 MEMORY_SESSION_CAP 修剪会话/伙伴作用域；只记条数（D8）。
				const pruned = pruneSessionMemory(memoryEngine);
				if (pruned > 0) console.log(`[memory] prune -${pruned}`);
			})
			.catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				console.error(`[memory] 写入失败: ${detail}`);
			});
	};
}
