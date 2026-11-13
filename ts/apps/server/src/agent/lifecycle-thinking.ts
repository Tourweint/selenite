/**
 * 思考档与回话（粘滞档位 / 工具触发切换 / 会话内发言 / 派活回报）
 *
 * 2026-11-13 从 lifecycle.ts 的 L1161–L1360 整段切出；正文原文搬运，未改一行实现。
 */

import type { DelegationReport } from "../delegation.ts";
import { chatModelRef, clampThinkingLevel, currentThinkingLevels, readLlmConfig } from "../provider.ts";
import { CTX, ResolvedChat } from "./shared.ts";
import { Context } from "@earendil-works/chord";
import type { Conversation, HookApi } from "@earendil-works/pi-durable";
import { ThinkingLevel } from "@lifediary/shared";
import { getHarness } from "./lifecycle-harness.ts";

const stickyLevels = new Map<number, ThinkingLevel>();

const thinkingRefused = new Set<number>();

export function stickyThinkingLevel(internalId: number): ThinkingLevel | null {
	return stickyLevels.get(internalId) ?? null;
}

export function rememberLevel(internalId: number, level: ThinkingLevel): void {
	if (level === "off") stickyLevels.delete(internalId);
	else stickyLevels.set(internalId, level);
}

function thinkingTokenLimit(): number {
	const raw = Number(process.env.AGENT_THINK_TOKEN_LIMIT);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4000;
}

async function lastTurnInputTokens(
	conversation: Conversation,
	context: Context,
): Promise<number | null> {
	const view = await conversation.context(context);
	for (let index = view.entries.length - 1; index >= 0; index -= 1) {
		const entry = view.entries[index];
		if (!entry || entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0] as { usage?: { input?: number } } | undefined;
		if (message && typeof message.usage?.input === "number") return message.usage.input;
	}
	return null;
}

async function switchThinkingOnTool(api: HookApi, context: Context): Promise<void> {
	// 已经切过/已判定不切的，不再碰库（每次工具调用都去 configure/读上下文是白付的）
	if (stickyThinkingLevel(api.conversationId) || thinkingRefused.has(api.conversationId)) return;
	// 2026-10-31 命名整改（方案 D11）：这个名字以前叫 AGENT_TOOL_UPGRADE，
	// 语义是"升级到更贵的模型"，会把读代码的人（包括我自己）带偏成"换模型"；
	// 现在它做的是"把思考档切上去"。旧别名 AGENT_TOOL_UPGRADE 已于 2026-11-07 删除。
	if ((process.env.AGENT_THINK_ON_TOOL ?? "on").trim().toLowerCase() === "off") {
		return;
	}

	const config = readLlmConfig();
	if (!config) return;
	// 目标档：非法值回退 low；off = "不切"，与总开关关掉同义（切一次只为了多思考）
	const wanted = thinkingToolLevel();
	if (wanted === "off") return;

	try {
		const harness = await getHarness();
		const conversation = await harness.conversation(api.conversationId as never, context);
		if (!conversation) return;
		const lastInput = await lastTurnInputTokens(conversation, context);
		const limit = thinkingTokenLimit();
		if (lastInput !== null && lastInput >= limit) {
			thinkingRefused.add(api.conversationId);
			console.log(
				`[agent] 会话 ${api.conversationId} 首次工具调用时 prompt≈${lastInput} ≥ ${limit}，保持当前档（长会话不切，方案 D3）`,
			);
			return;
		}
		// 目标档可能不在当前模型支持域（例如默认模型没有 medium）→ 按序落回
		const level = clampThinkingLevel(wanted, currentThinkingLevels());
		const target = chatModelRef(level);
		const agent = await conversation.agent(context);
		// 成对比较：同名模型换了供应商也要重配（审查 S1）
		if (agent.model?.provider === target.provider && agent.model?.modelId === target.modelId) {
			rememberLevel(api.conversationId, level);
			return;
		}
		await conversation.configure({ model: target }, context);
		rememberLevel(api.conversationId, level);
		console.log(
			`[agent] 会话 ${api.conversationId} 首次工具调用 → 档位 ${level}${
				level !== wanted ? `（${wanted} 不在支持域）` : ""
			}（prompt≈${lastInput ?? "首轮"} < ${limit}；本次前缀重算约 ${lastInput ?? "?"} token）`,
		);
	} catch (error) {
		// 切档失败不影响这一轮：大不了这轮继续按原来的档跑
		console.warn(
			`[agent] 会话 ${api.conversationId} 切思考档失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function thinkingToolLevel(): ThinkingLevel {
	const raw = (process.env.AGENT_THINK_TOOL_LEVEL ?? "").trim().toLowerCase();
	if (!raw) return "low";
	if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") return raw;
	console.warn(`[agent] AGENT_THINK_TOOL_LEVEL=${raw} 不是合法档位，按 low 处理`);
	return "low";
}

export async function sayInConversation(
	conversationId: number,
	text: string,
): Promise<boolean> {
	const harness = await getHarness();
	const conversation = await harness.conversation(conversationId as never, CTX);
	if (!conversation) return false;
	await sayInChat({ conversation, externalId: "", internalId: conversationId }, text);
	return true;
}

export async function reportDelegationResult(
	conversationId: number,
	report: DelegationReport,
): Promise<void> {
	try {
		const delivered = await sayInConversation(conversationId, report.text);
		if (!delivered) {
			console.warn(`[agent] 任务 ${report.ticketId} 的会话 ${conversationId} 已不存在，跳过汇报`);
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[agent] 任务 ${report.ticketId} 写回会话失败: ${detail}`);
	}
}

export async function sayInChat(chat: ResolvedChat, text: string): Promise<void> {
	const at = Date.now();
	await chat.conversation.submit(
		{
			type: "write",
			entry: {
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [{ type: "text", text }],
						api: "lifediary.say",
						provider: "lifediary",
						model: "lifediary.say",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: at,
					},
				],
			},
		},
		CTX,
	);
}

export { lastTurnInputTokens, stickyLevels, switchThinkingOnTool, thinkingRefused, thinkingTokenLimit, thinkingToolLevel };
