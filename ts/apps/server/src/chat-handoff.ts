/**
 * 会话导出「接续文件」（2026-11-10 批 20 §一）。
 *
 * 目标不是"备份数据"，而是**换一个 AI 接着聊**：一份 markdown 里同时有
 *   - 角色说明（你是谁）；
 *   - 读取说明（这份文件可以直接粘给任何 AI）；
 *   - 记忆摘要（该作用域 preference + experience，最多 20 条）；
 *   - 最近 N 轮原文（默认 30 轮）。
 *
 * 硬口径（接口文档 §2.2.1）：
 *   - **不落服务端磁盘**：这是响应体，服务端不保存正文（隐私）；
 *   - **部分可读要标注原因**：截断 / 记忆不可用 / 没有消息都在文里写清楚，不冒充完整；
 *   - **导出成功 ≠ 对方已接收**：文件里也写这一句。
 *
 * 本模块只做纯文本拼装，不读磁盘、不碰会话。消息与记忆由调用方传入，便于单测。
 */

import type { TranscriptMessage } from "./agent/session.ts";

/** 默认包含的轮数（一轮 = 一条 user 消息 + 其后到下一问之前的回答） */
export const HANDOFF_DEFAULT_TURNS = 30;
/** 上限：再大就不是"接续"而是归档，这里不装成归档 */
export const HANDOFF_MAX_TURNS = 200;
/** 记忆摘要上限 */
export const HANDOFF_MEMORY_LIMIT = 20;

export type HandoffRole = "preference" | "experience";

export interface HandoffMemoryItem {
	kind: string;
	content: string;
}

export interface HandoffMemory {
	enabled: boolean;
	/** 实际读取的 scope 键（`global` / `partner:<uuid>`），记忆关闭时为空串 */
	scope: string;
	items: HandoffMemoryItem[];
	/** 读不到时给一句**枚举级**说明（不含错误原文，避免带出路径 / 正文） */
	note?: string;
}

export interface HandoffInput {
	conversationId: string;
	/** 用户改过的标题；没有就不编一个 */
	title?: string;
	/** `chief` / `worker` / `partner` */
	kind: string;
	messages: TranscriptMessage[];
	memory: HandoffMemory;
	/** 要包含的轮数（已校验 1–200） */
	turns: number;
	generatedAt?: Date;
}

export interface HandoffDocument {
	markdown: string;
	/** 实际包含的轮数（user 消息条数） */
	includedTurns: number;
	/** 因为 `turns` 上限被省略的消息条数 */
	omittedMessages: number;
	totalMessages: number;
}

/**
 * 回滚开关：默认开；只有显式 `false` 才关（关 = 端点 404，与其它能力端点同口径）。
 */
export function chatExportHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.CHAT_EXPORT_HANDOFF ?? "").trim().toLowerCase() !== "false";
}

/** `limit` 解析：未传 = 30；必须是 1–200 的整数，否则 null（调用方 400）。 */
export function parseHandoffLimit(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return HANDOFF_DEFAULT_TURNS;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > HANDOFF_MAX_TURNS) return null;
	return value;
}

/**
 * 取最近 `turns` 轮。
 *
 * 一轮从一条 user 消息开始；回答、工作步骤都算在同一轮里。末尾可能只有 assistant
 * （`/say` 或没等到回答的一轮），从后往前数满 `turns` 条 user 就停，保证不会把
 * 倒数第 N 轮的回答切一半。
 */
export function sliceRecentTurns<T extends { role: string }>(
	messages: T[],
	turns: number,
): { messages: T[]; omittedMessages: number } {
	if (turns <= 0) return { messages: [], omittedMessages: messages.length };
	let seen = 0;
	let start = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role !== "user") continue;
		seen += 1;
		if (seen === turns) {
			start = index;
			break;
		}
	}
	return { messages: messages.slice(start), omittedMessages: start };
}

function roleLine(kind: string): string {
	if (kind === "chief") {
		return "你是主人身边的 AI 助手（总管）。下面是和主人的历史对话。";
	}
	if (kind === "partner") {
		return "你是主人的执事（常驻助手）。下面是和主人的历史对话。";
	}
	if (kind === "worker") {
		return "你是一个 worker 会话里的 AI 助手。下面是这个会话的历史对话。";
	}
	return "你是一个 AI 助手。下面是和主人的历史对话。";
}

function shortId(conversationId: string): string {
	return conversationId.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 8) || "session";
}

/** 导出文件名（只含对外会话 uuid 前 8 位，不含标题 / 正文） */
export function handoffFileName(conversationId: string): string {
	return `lifediary-handoff-${shortId(conversationId)}.md`;
}

function memorySection(memory: HandoffMemory): string[] {
	if (!memory.enabled) {
		return ["（记忆未启用，本次没有记忆摘要。）"];
	}
	if (memory.note) {
		return [`（记忆读取失败：${memory.note}；本次没有记忆摘要。）`];
	}
	if (memory.items.length === 0) {
		return ["（这个作用域里还没有偏好 / 经历记录。）"];
	}
	const label: Record<string, string> = { preference: "偏好", experience: "经历" };
	return memory.items.slice(0, HANDOFF_MEMORY_LIMIT).map((item) => {
		const prefix = label[item.kind] ?? item.kind;
		return `- 【${prefix}】${item.content.replace(/\r?\n/g, " ")}`;
	});
}

function quote(text: string): string {
	const one = text.trim();
	if (!one) return "> （空）";
	return one
		.split(/\r?\n/)
		.map((line) => `> ${line}`)
		.join("\n");
}

function stamp(at: number): string {
	if (!Number.isFinite(at) || at <= 0) return "时间未知";
	return new Date(at).toISOString();
}

/**
 * 拼出接续文件。所有"缺了一块"的情况都在文里留一句原因，绝不假装完整。
 */
export function buildHandoff(input: HandoffInput): HandoffDocument {
	const { messages, omittedMessages } = sliceRecentTurns(input.messages, input.turns);
	const includedTurns = messages.filter((message) => message.role === "user").length;
	const generatedAt = (input.generatedAt ?? new Date()).toISOString();
	const heading = input.title?.trim() || `会话 ${shortId(input.conversationId)}`;

	const lines: string[] = [
		`# 接续文件：${heading}`,
		"",
		`> 生成时间：${generatedAt} ｜ 会话：${input.conversationId}`,
		"> 这是一份一次性导出：服务端不保存这份文件；**导出成功不等于对方已经收到**。",
		"",
		roleLine(input.kind),
		"",
		"## 怎么用这份文件",
		"",
		"这份文件可以直接粘给任何 AI 继续聊：它带着角色、长期记忆摘要和最近的对话原文。",
		"粘过去之后，直接说你想接着聊什么即可；不需要再自我介绍一遍。",
		"",
		`## 记忆摘要（${input.memory.scope || "未读取"}，最多 ${HANDOFF_MEMORY_LIMIT} 条）`,
		"",
		...memorySection(input.memory),
		"",
		`## 最近 ${input.turns} 轮对话`,
		"",
	];

	if (omittedMessages > 0) {
		lines.push(`> 注：本次只包含最近 ${input.turns} 轮；更早的 ${omittedMessages} 条消息未包含。`, "");
	}

	if (messages.length === 0) {
		lines.push("（这个会话还没有可导出的消息。）", "");
	}

	for (const message of messages) {
		const who = message.role === "user" ? "主人" : "助手";
		lines.push(`**${who}** · ${stamp(message.at)}`, "", quote(message.text), "");
	}

	return {
		markdown: `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`,
		includedTurns,
		omittedMessages,
		totalMessages: input.messages.length,
	};
}
