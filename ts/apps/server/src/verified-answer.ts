import type { MemoryEngine } from "@lifediary/memory";
import { memoryEngine, scopeOf } from "./agent/assist.ts";
import { partnersStore } from "./partners.ts";

/**
 * 答案沉淀（2026-11-10 批 19 §二；全景调研二 §六）。
 *
 * `ask_user` 的答复是**人亲口确认过的事实**：同一个问题下次不该再问一遍。
 * 答复成功后把 `{question, answer}` 写成一条 `kind=fact`、`source="verified_answer"`
 * 的记忆，scope 用发起会话的 scope（与 recall 的检索范围同一套）。
 *
 * 边界：**群会话不落**（群不进个人记忆，2026-11-06 群组方案 §2.2）。
 * 失败只 warn（记条数 / 字数 / 错误摘要，不记正文），绝不挡答复主链路。
 */

/** 回滚开关：默认开；`AGENT_VERIFIED_ANSWER=false` → 一条都不写（逐字节回到改动前）。 */
export function verifiedAnswerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.AGENT_VERIFIED_ANSWER ?? "").trim().toLowerCase();
	if (!raw) return true;
	return !["false", "0", "off"].includes(raw);
}

/** 从 pending 的 args 摘要里取问题原文（坏 JSON / 缺字段 → 空串，不猜）。 */
export function questionOfArgs(args: string): string {
	try {
		const parsed = JSON.parse(args) as { question?: unknown };
		return typeof parsed.question === "string" ? parsed.question.trim() : "";
	} catch {
		return "";
	}
}

/** 记忆正文：一问一答，问题在前（召回时整段可读）。 */
export function verifiedAnswerContent(question: string, answer: string): string {
	return `问：${question}\n答：${answer}`;
}

export interface VerifiedAnswerInput {
	conversationId: number;
	question: string;
	answer: string;
	/** 注入缝（单测）：不传用进程内 memoryEngine / partnersStore。 */
	engine?: MemoryEngine | null;
	isGroup?: (conversationId: number) => boolean;
}

/** 落一条答案记忆；返回是否真的写了。任何异常都吞掉，不挡答复。 */
export function recordVerifiedAnswer(input: VerifiedAnswerInput): boolean {
	if (!verifiedAnswerEnabled()) return false;
	const question = input.question.trim();
	const answer = input.answer.trim();
	if (!question || !answer) return false;

	let group = false;
	try {
		group = input.isGroup
			? input.isGroup(input.conversationId)
			: partnersStore().isGroupSession(input.conversationId);
	} catch {
		// 档案库读不到：按普通会话处理（宁可不落一条，也不要猜成群）
		group = false;
	}
	if (group) return false;

	const engine = input.engine === undefined ? memoryEngine : input.engine;
	if (!engine) return false;
	try {
		engine.remember({
			kind: "fact",
			scope: scopeOf(input.conversationId),
			content: verifiedAnswerContent(question, answer),
			// 人亲口答的：可信度高，但不必压过明确说「记住」的偏好
			importance: 0.8,
			veracity: "stated",
			source: "verified_answer",
		});
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[verified-answer] 答案记忆落库失败（不挡答复）: ${detail.slice(0, 120)}`);
		return false;
	}
}
