/**
 * 设置 → 上下文的只读检查（2026-11-16）
 *
 * 口径见 docs/设计方案/2026-11-16-设置上下文页（固定前缀查看）.md：
 *   - 系统提示词 / 工具 / 技能：从 ContextView 用 pi-ai 的 getCurrentSystemMessage 重放，
 *     拿当前真正会发出去的那一份，不重新跑注入 provider（会重渲染、会碰副作用）；
 *   - 记忆：只读 beforeRequest 首轮记下的临时注入实文，不重新召回（recall 会回写使用计数）；
 *   - 会变部分只计数，不搬运正文。
 */

import { contentText, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ContextView } from "@earendil-works/pi-durable";
import { memoryInjectLimit, memoryInjectMaxChars } from "./memory-inject.ts";
import { estimateTokens } from "./token-estimate.ts";

export type ContextSectionStability = "fixed" | "session" | "turn";

export interface ContextSectionView {
	key: string;
	label: string;
	stability: ContextSectionStability;
	chars: number;
	/** 估算 token（见 token-estimate.ts）；页面主数字。 */
	tokens: number;
	text: string;
	/** 可编辑的段（默认页的岗位契约 / 当前目标 / 纪律逐节；红线除外）：页面给“可编辑”徽标。 */
	editable?: boolean;
	/** 空槽位：text 为空、chars 0，仍作为一行展示，但不计真实文本。 */
	empty?: boolean;
}

export interface ContextToolView {
	name: string;
	description: string;
	chars: number;
	tokens: number;
	schema: string;
}

export interface ContextCountView {
	count: number;
	chars: number;
	tokens: number;
}

export interface ContextInspectView {
	system: {
		content: string;
		sections: ContextSectionView[];
		chars: number;
		tokens: number;
	};
	tools: {
		count: number;
		chars: number;
		tokens: number;
		items: ContextToolView[];
	};
	skills: {
		count: number;
		chars: number;
		tokens: number;
		text: string;
	};
	changing: {
		messages: ContextCountView;
		toolCalls: ContextCountView;
		toolResults: ContextCountView;
	};
}

/** 进程内只留最新一轮的注入实文；不落盘、不进日志。 */
export interface ContextInjectionNote {
	id: string;
	text: string;
}

export interface LastRequestInjections {
	at: number;
	items: ContextInjectionNote[];
}

export interface ContextInspectPayload extends ContextInspectView {
	conversationId: string;
	title: string | null;
	chatKind: string | null;
	usage: { used: number | null; window: number | null };
	memory: {
		enabled: boolean;
		limit: number;
		maxChars: number;
		last: {
			at: number;
			items: number;
			chars: number;
			tokens: number;
			text: string;
			others: { id: string; chars: number; tokens: number }[];
		} | null;
	};
	updatedAt: number;
}

/** 一个段落的中文名 + 稳定性；`skills` 单独成块，不在这里露。 */
const SECTION_META: Record<
	string,
	{ label: string; stability: ContextSectionStability; editable?: boolean }
> = {
	persona: { label: "人设", stability: "fixed", editable: true },
	verification_iron_law: { label: "验证铁律", stability: "fixed" },
	clarify_contract: { label: "开工前问清", stability: "fixed" },
	injection_guard: { label: "注入防线", stability: "fixed" },
	current_project: { label: "当前项目", stability: "turn", editable: true },
	topics: { label: "课题", stability: "turn", editable: true },
	// 默认开销里的执事：身份是 instructions，岗位契约/纪律是 extra system message；
	// 这里各给一个可读的名字，避免页面上出现裸 key。
	partner_identity: { label: "执事身份", stability: "fixed" },
	partner_soul: { label: "执事身份 · SOUL", stability: "fixed" },
	partner_voice: { label: "执事人设 · 说话方式（口吻）", stability: "fixed" },
	partner_values: { label: "执事人设 · 里子", stability: "fixed" },
	partner_scenario: { label: "执事人设 · 处境", stability: "fixed" },
	partner_owner_profile: { label: "执事身份 · 主人画像", stability: "fixed" },
	partner_skill_index: { label: "执事身份 · 技能索引", stability: "fixed" },
	partner_boundary: { label: "执事身份 · 运行边界", stability: "fixed" },
	partner_context: { label: "执事上下文", stability: "fixed" },
	// 默认页按 PartnerTurnContext 的真实字段拆开：契约四节、目标、纪律分别成行。
	// 契约四节是 CONTRACT.md 的四个固定二级标题，不是从一段文本里随手切出来的。
	partner_contract_scope: { label: "岗位契约 · 职责范围", stability: "fixed", editable: true },
	partner_contract_decision: { label: "岗位契约 · 决策分级", stability: "fixed", editable: true },
	partner_contract_acceptance: { label: "岗位契约 · 验收标准", stability: "fixed", editable: true },
	partner_contract_report: { label: "岗位契约 · 汇报对象", stability: "fixed", editable: true },
	partner_goal: { label: "当前目标", stability: "turn", editable: true },
	// 纪律按固定块拆开（2026-11-16 续）：默认页逐节展示，逐节可改；
	// 主人数据红线单独一行、只读，避免把“安全边界”混进可编辑的行为纪律里。
	partner_verification: { label: "执事纪律 · 验证铁律", stability: "fixed", editable: true },
	partner_ruling: { label: "执事纪律 · 裁决纪律", stability: "fixed", editable: true },
	partner_work_silence: { label: "执事纪律 · 干活期间", stability: "fixed", editable: true },
	partner_grounding: { label: "执事纪律 · 答案接地", stability: "fixed", editable: true },
	partner_artifact_handoff: { label: "执事纪律 · 产物交接", stability: "fixed", editable: true },
	partner_brief_card: { label: "执事纪律 · 汇报卡", stability: "fixed", editable: true },
	partner_attention: { label: "执事纪律 · 提问纪律", stability: "fixed", editable: true },
	partner_owner_data: { label: "执事纪律 · 主人数据红线", stability: "fixed" },
	partner_discipline: { label: "执事纪律（合并）", stability: "fixed", editable: true },
	partner_learning: { label: "表达习惯", stability: "session" },
	partner_proactivity: { label: "主动性", stability: "session" },
	partner_status: { label: "当前在办", stability: "turn" },
	partner_impression: { label: "印象", stability: "session" },
	partner_mood: { label: "心情", stability: "session" },
	partner_heart: { label: "心里话", stability: "session" },
};

const SKILL_SECTION_KEYS = new Set(["skills", "skill"]);

/** 每个会话只留最近一轮；超过这个数按 LRU 丢最旧的。 */
const MAX_TRACKED_CONVERSATIONS = 64;
const requestInjections = new Map<string, LastRequestInjections>();

function conversationKey(conversationId: string | number): string {
	return String(conversationId);
}

/** beforeRequest 首轮调用：记下这一轮真正插入的 message 注入（只记 id/text）。 */
export function noteRequestInjections(
	conversationId: string | number,
	entries: readonly ContextInjectionNote[],
	at: number = Date.now(),
): void {
	const key = conversationKey(conversationId);
	requestInjections.delete(key);
	requestInjections.set(key, {
		at,
		items: entries.map((entry) => ({ id: entry.id, text: entry.text })),
	});
	while (requestInjections.size > MAX_TRACKED_CONVERSATIONS) {
		const oldest = requestInjections.keys().next().value;
		if (oldest === undefined) break;
		requestInjections.delete(oldest);
	}
}

export function lastRequestInjectionsOf(conversationId: string | number): LastRequestInjections | null {
	return requestInjections.get(conversationKey(conversationId)) ?? null;
}

/** 测试与关停用。 */
export function clearRequestInjections(): void {
	requestInjections.clear();
}

/** `CHAT_CONTEXT_INSPECT=false` 一行回滚；缺省 / 其它值 = 开。 */
export function chatContextInspectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.CHAT_CONTEXT_INSPECT ?? "").trim().toLowerCase();
	return raw !== "false";
}

function countString(text: string): number {
	return text.length;
}

function sectionView(key: string, text: string): ContextSectionView {
	const meta = SECTION_META[key];
	return {
		key,
		label: meta?.label ?? key,
		stability: meta?.stability ?? "fixed",
		chars: countString(text),
		tokens: estimateTokens(text),
		text,
		...(meta?.editable ? { editable: true } : {}),
		...(text.length === 0 ? { empty: true } : {}),
	};
}

function skillCount(text: string): number {
	// 索引一行一条，形如 `- 名字：摘要`；没有条目行时整段算 1 条，避免把"有索引但格式不同"报成 0。
	const lines = text.split(/\r?\n/).filter((line) => /^\s*[-*]\s+/.test(line));
	return lines.length || (text.trim() ? 1 : 0);
}

function memoryItemCount(text: string): number {
	const lines = text.split(/\r?\n/).filter((line) => /^\s*[-*]\s+/.test(line));
	return lines.length || 1;
}

/**
 * 从当前 ContextView 折出四块里的三块（系统 / 工具 / 技能）与会变计数。
 * 不会读数据库，也不会触发注入 provider。
 */
export function contextInspectViewOf(view: ContextView): ContextInspectView {
	const current = getCurrentSystemMessage(view.messages);
	const baseContent = contentText(current?.content ?? "");
	const sections: ContextSectionView[] = [];
	let skillsText = "";
	let systemChars = countString(baseContent);
	let systemTokens = estimateTokens(baseContent);

	for (const [key, value] of Object.entries(current?.sections ?? {})) {
		if (value === null) continue;
		if (SKILL_SECTION_KEYS.has(key.toLowerCase())) {
			skillsText = value;
			continue;
		}
		const section = sectionView(key, value);
		sections.push(section);
		systemChars += section.chars;
		systemTokens += section.tokens;
	}

	const tools = (current?.toolsAdded ?? []).map((tool) => {
		const compact = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
		return {
			name: tool.name,
			description: tool.description,
			chars: compact.length,
			tokens: estimateTokens(compact),
			schema: JSON.stringify(
				{ name: tool.name, description: tool.description, parameters: tool.parameters },
				null,
				2,
			),
		};
	});

	const changing = {
		messages: { count: 0, chars: 0, tokens: 0 },
		toolCalls: { count: 0, chars: 0, tokens: 0 },
		toolResults: { count: 0, chars: 0, tokens: 0 },
	};

	for (const message of view.messages) {
		if (message.role === "user") {
			const text = contentText(message.content);
			changing.messages.count += 1;
			changing.messages.chars += countString(text);
			changing.messages.tokens += estimateTokens(text);
			continue;
		}
		if (message.role === "assistant") {
			const text = contentText(message.content);
			if (text) {
				changing.messages.count += 1;
				changing.messages.chars += countString(text);
				changing.messages.tokens += estimateTokens(text);
			}
			const blocks = Array.isArray(message.content) ? message.content : [];
			for (const block of blocks) {
				if (block.type !== "toolCall") continue;
				const args = JSON.stringify({ name: block.name, arguments: block.arguments });
				changing.toolCalls.count += 1;
				changing.toolCalls.chars += countString(args);
				changing.toolCalls.tokens += estimateTokens(args);
			}
			continue;
		}
		if (message.role === "toolResult") {
			const text = contentText(message.content);
			changing.toolResults.count += 1;
			changing.toolResults.chars += countString(text);
			changing.toolResults.tokens += estimateTokens(text);
		}
	}

	const skillsChars = countString(skillsText);
	return {
		system: { content: baseContent, sections, chars: systemChars, tokens: systemTokens },
		tools: {
			count: tools.length,
			chars: tools.reduce((sum, tool) => sum + tool.chars, 0),
			tokens: tools.reduce((sum, tool) => sum + tool.tokens, 0),
			items: tools,
		},
		skills: { count: skillCount(skillsText), chars: skillsChars, tokens: estimateTokens(skillsText), text: skillsText },
		changing,
	};
}

export function contextInspectPayloadOf(input: {
	conversationId: string;
	title?: string | null;
	chatKind?: string | null;
	usage?: { used: number | null; window: number | null } | null;
	view: ContextView;
	memoryEnabled: boolean;
	lastInjections?: LastRequestInjections | null;
	env?: NodeJS.ProcessEnv;
	now?: number;
}): ContextInspectPayload {
	const env = input.env ?? process.env;
	const view = contextInspectViewOf(input.view);
	const last = input.lastInjections ?? null;
	const recall = last?.items.find((item) => item.id === "memory_recall");
	const recallText = recall?.text ?? "";
	const others = (last?.items ?? [])
		.filter((item) => item.id !== "memory_recall")
		.map((item) => ({
			id: item.id,
			chars: countString(item.text),
			tokens: estimateTokens(item.text),
		}));

	return {
		conversationId: input.conversationId,
		title: input.title ?? null,
		chatKind: input.chatKind ?? null,
		usage: input.usage ?? { used: null, window: null },
		...view,
		memory: {
			enabled: input.memoryEnabled,
			limit: memoryInjectLimit(env),
			maxChars: memoryInjectMaxChars(env),
				last: last
					? {
							at: last.at,
							items: recallText ? memoryItemCount(recallText) : 0,
							chars: countString(recallText),
							tokens: estimateTokens(recallText),
							text: recallText,
							others,
						}
					: null,
		},
		updatedAt: input.now ?? Date.now(),
	};
}
