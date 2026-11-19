import { redactSecrets, type MemoryEngine } from "@lifediary/memory";
import type { Hono } from "hono";
import { flagEnabled } from "./flags.ts";
import {
	readTranscriptSources,
	type SessionReader,
	type TranscriptLine,
} from "./agent/session-search.ts";

/**
 * 提醒沉淀 · 收集端（2026-11-19 批4，方案 `docs/设计方案/2026-11-19-提醒沉淀（重复提醒蒸馏成教诲）.md`）。
 *
 * 用户对 agent 的反复纠正/提醒是最高信号的教诲来源，但此前没有"同一提醒反复出现 →
 * 聚合成条目"的跨轮机制。本模块做**收集**这一半：纯代码、确定性过滤、**0 token**——
 * 不调任何模型。蒸馏在总管对话里做（技能评估批 30 同款"跳转 + 预填"模式），
 * 落盘走 `save_reminder_advice` 工具（快照在 reminder-advice.ts），**人采纳**才进偏好（D18）。
 *
 * 三路候选（近 30 天）：
 *   ① 用户消息里含提醒模式词（以后/记住/下次/别再/不要再/每次都）的句子，逐句聚合
 *      出现次数（同句原文去重计数）；
 *   ② memory 里 `source="taught"` 的偏好条目（`remember` 工具立规矩写的）——给总管
 *      当"已有规矩"参照，避免重复出条；
 *   ③ ask_user 答复沉淀（`verified-answer.ts` 旁路写的 `source="verified_answer"` fact）。
 *
 * 边界（方案"明确不做"）：不自动聚合（只有用户点入口才跑）；聚合计数不落库
 * （候选即时算，无表）；v1 只做 global 偏好（蒸馏**产物**落 global，见 reminder-advice.ts；
 * 收集的已有教诲覆盖主人全部键空间，见 collectTaughtCandidates）。
 *
 * 隐私：句子落回响应/提示词前过 `redactSecrets`（与 recall_sessions 的 snippet 同一把尺子）；
 * 日志只记条数，不记内容。
 */

/** 回滚开关（plugins.json 登记，hot:false）：false → 端点 404、入口不显示、工具不上架。 */
export function reminderDistillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("REMINDER_DISTILL_ENABLED", env);
}

/** 提醒模式词：句子含任一词才算候选（方案口径，2026-11-19 拍板）。 */
export const REMINDER_PATTERN_WORDS: readonly string[] = [
	"以后",
	"记住",
	"下次",
	"别再",
	"不要再",
	"每次都",
];

/** 收集窗口：近 30 天。 */
export const REMINDER_DISTILL_WINDOW_DAYS = 30;

/* ── 上限（防预填提示词爆长；方案"候选 ≤40"）──────────────────
 * 三段各设上限，合计恰为 40：反复说过的原话信号最高占大头，
 * 已有教诲与确认问答是参照/补充各 10。 */
export const REMINDER_MAX_UTTERANCES = 20;
export const REMINDER_MAX_TAUGHT = 10;
export const REMINDER_MAX_VERIFIED = 10;
export const REMINDER_MAX_CANDIDATES = 40;

/** 单句上限：超长不是一句提醒，截断会歪曲原话——整句丢，不硬塞进提示词。 */
export const REMINDER_SENTENCE_MAX_CHARS = 200;

/** 一路候选：用户原话（聚合出现次数）。 */
export interface ReminderUtterance {
	kind: "utterance";
	text: string;
	count: number;
	/** 命中的提醒模式词（按首次命中顺序） */
	patterns: string[];
	/** 首次 / 最近一次出现（ISO）；同句跨天出现时不同 */
	firstAt: string;
	lastAt: string;
}

/** 已有教诲（参照，不重复出条）。 */
export interface ReminderTaught {
	kind: "taught";
	text: string;
	createdAt: string;
}

/** ask_user 答复沉淀（问：/答：整段）。 */
export interface ReminderVerified {
	kind: "verified";
	text: string;
	createdAt: string;
}

export type ReminderCandidate = ReminderUtterance | ReminderTaught | ReminderVerified;

/** 切句：换行与中英句读都算句子边界（提醒几乎总是一短句）。 */
export function splitReminderSentences(text: string): string[] {
	return text
		.split(/\r?\n|[。！？；!?;]/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

/** 命中的提醒模式词（按 REMINDER_PATTERN_WORDS 顺序，去重）。 */
export function reminderPatternsOf(sentence: string): string[] {
	const hits: string[] = [];
	for (const word of REMINDER_PATTERN_WORDS) {
		if (sentence.includes(word) && !hits.includes(word)) hits.push(word);
	}
	return hits;
}

/**
 * 从用户消息行收集并聚合候选原话（纯函数，单测直接喂数组）：
 * 只看 `role === "user"` 的行；窗口外（at < cutoff）跳过；同句原文归并计数。
 * 输出按次数降序、同次数按最近出现时间降序，截到 `limit`。
 */
export function collectUtteranceCandidates(
	lines: readonly TranscriptLine[],
	now: number = Date.now(),
	limit: number = REMINDER_MAX_UTTERANCES,
): ReminderUtterance[] {
	const cutoff = now - REMINDER_DISTILL_WINDOW_DAYS * 86_400_000;
	const byText = new Map<string, ReminderUtterance>();
	for (const line of lines) {
		if (line.role !== "user" || !line.text) continue;
		if (line.at < cutoff) continue;
		for (const sentence of splitReminderSentences(line.text)) {
			if (sentence.length > REMINDER_SENTENCE_MAX_CHARS) continue;
			const patterns = reminderPatternsOf(sentence);
			if (patterns.length === 0) continue;
			const existing = byText.get(sentence);
			if (existing) {
				existing.count += 1;
				const at = line.at > 0 ? new Date(line.at).toISOString() : existing.lastAt;
				existing.lastAt = at > existing.lastAt ? at : existing.lastAt;
				existing.firstAt =
					line.at > 0 && at < existing.firstAt ? at : existing.firstAt;
				for (const word of patterns) {
					if (!existing.patterns.includes(word)) existing.patterns.push(word);
				}
				continue;
			}
			const iso = line.at > 0 ? new Date(line.at).toISOString() : "";
			byText.set(sentence, {
				kind: "utterance",
				// 与 recall_sessions 的 snippet 同一把尺子：落回响应/提示词前打码
				text: redactSecrets(sentence),
				count: 1,
				patterns,
				firstAt: iso,
				lastAt: iso,
			});
		}
	}
	return [...byText.values()]
		.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
		.slice(0, Math.max(0, limit));
}

/**
 * ② 已有教诲：主人侧的 `kind=preference` 且 `source="taught"`。
 *
 * scope 口径（2026-11-19 批4 实测钉下来）：`remember` 工具立规矩写的是 `scopeOf()`
 * ——普通会话落 `session:<id>`，**不是** global（`preferenceScopeOf` 只管逐轮抽取路径）。
 * 所以这里不能只看 global：主人自己的键空间（global / session / day / topic）都算，
 * 排掉 `partner:` 与 `project:`（那是执事与项目的键空间，不是"主人教总管的规矩"）。
 * `browse` 默认就不返回 superseded；`archivedAt`（原子化拆走）再挡一层。
 * 引擎关着 / 读失败 → 空清单（收集绝不因记忆库打挂）。
 */
export function collectTaughtCandidates(
	engine: MemoryEngine | null | undefined,
	limit: number = REMINDER_MAX_TAUGHT,
): ReminderTaught[] {
	if (!engine) return [];
	try {
		const { items } = engine.browse({ kinds: ["preference"], limit: 2000 });
		return items
			.filter(
				(record) =>
					record.source === "taught" &&
					!record.archivedAt &&
					!record.scope.startsWith("partner:") &&
					!record.scope.startsWith("project:"),
			)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, Math.max(0, limit))
			.map((record) => ({ kind: "taught", text: record.content, createdAt: record.createdAt }));
	} catch {
		return [];
	}
}

/**
 * ③ ask_user 答复沉淀：`source="verified_answer"` 的 fact（scope 是发起会话的，
 * 不限 global——答复写在哪个会话都是人亲口确认过的事）。
 */
export function collectVerifiedCandidates(
	engine: MemoryEngine | null | undefined,
	limit: number = REMINDER_MAX_VERIFIED,
): ReminderVerified[] {
	if (!engine) return [];
	try {
		const { items } = engine.browse({ kinds: ["fact"], limit: 2000 });
		return items
			.filter((record) => record.source === "verified_answer" && !record.archivedAt)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, Math.max(0, limit))
			.map((record) => ({ kind: "verified", text: record.content, createdAt: record.createdAt }));
	} catch {
		return [];
	}
}

/** 三段候选合成一份响应体形状；prompt 由调用方一并嵌入。 */
export interface ReminderCandidatesPayload {
	generatedAt: string;
	windowDays: number;
	/** 总条数上限内的三段候选（utterance + taught + verified） */
	candidates: ReminderCandidate[];
	counts: { utterances: number; taught: number; verified: number };
}

export function collectReminderCandidates(
	engine: MemoryEngine | null | undefined,
	lines: readonly TranscriptLine[],
	now: number = Date.now(),
): ReminderCandidatesPayload {
	const utterances = collectUtteranceCandidates(lines, now);
	const taught = collectTaughtCandidates(engine);
	const verified = collectVerifiedCandidates(engine);
	return {
		generatedAt: new Date(now).toISOString(),
		windowDays: REMINDER_DISTILL_WINDOW_DAYS,
		candidates: [...utterances, ...taught, ...verified],
		counts: { utterances: utterances.length, taught: taught.length, verified: verified.length },
	};
}

/** JSON 行清单（逐行一条，compact——总管读清单不需要多余括号）。 */
function jsonLines(rows: readonly Record<string, unknown>[]): string {
	return rows.map((row) => JSON.stringify(row)).join("\n");
}

/**
 * 总管对话用的蒸馏提示词（前端预填，照 renderAdvicePrompt 的分工）：清单服务端拼好，
 * 总管只需要：合并同类 → 去一次性语境 → 调 save_reminder_advice 一次性落盘 → 回摘要。
 */
export function renderReminderDistillPrompt(payload: ReminderCandidatesPayload): string {
	const empty = "（这段没收集到内容）";
	const utteranceLines = payload.counts.utterances
		? jsonLines(
				payload.candidates
					.filter((item): item is ReminderUtterance => item.kind === "utterance")
					.map((item) => ({ text: item.text, count: item.count, patterns: item.patterns })),
			)
		: empty;
	const taughtLines = payload.counts.taught
		? jsonLines(
				payload.candidates
					.filter((item): item is ReminderTaught => item.kind === "taught")
					.map((item) => ({ text: item.text })),
			)
		: empty;
	const verifiedLines = payload.counts.verified
		? jsonLines(
				payload.candidates
					.filter((item): item is ReminderVerified => item.kind === "verified")
					.map((item) => ({ text: item.text })),
			)
		: empty;
	return [
		"帮我沉淀一下我的提醒。下面三份清单来自最近 "
			+ payload.windowDays
			+ " 天（代码确定性收集，0 token）：一是我反复说过的话（含「"
			+ REMINDER_PATTERN_WORDS.join("/")
			+ "」这类提醒词，带出现次数）；二是已经记下的教诲；三是我用「向主人提问」确认过、你替我答过的事。",
		"请把它们蒸馏成候选教诲条目：",
		"- 同一个意思合并成一条，不逐句罗列；",
		"- 去掉一次性语境（具体某天、某个单子、某次对话的细节），留下「以后要怎么做 / 不做什么」的规矩本身；",
		"- 第二份清单里已有的意思不要重复出条；",
		"- 每条一句话，≤100 字。",
		"蒸馏完把结果一次性存起来（调 save_reminder_advice 工具，items 是字符串数组，一次 1–30 条），"
			+ "最后用两三句话告诉我：合并出了哪几条、丢掉了哪些一次性内容。它只写建议清单，不会动我的偏好。",
		"",
		"一、我反复说过的（原文 + 出现次数，JSON 行）：",
		utteranceLines,
		"",
		"二、已经记下的教诲（已有规矩，不要重复）：",
		taughtLines,
		"",
		"三、我亲口确认过的问答（沉淀候选，JSON 行）：",
		verifiedLines,
	].join("\n");
}

/* ── 端点 ────────────────────────────────────────────────── */

export interface ReminderCandidatesDeps {
	/** 回滚开关（注入便于单测）；不传 = reminderDistillEnabled() */
	enabled?: () => boolean;
	/** durable 读取面（生产传 getHarness 的惰性包装；探针/单测注入假实现） */
	reader: () => Promise<SessionReader>;
	/** 记忆引擎（关着 / 未初始化 → ②③ 两段为空，① 照常收集） */
	engine?: () => MemoryEngine | null | undefined;
}

/**
 * GET /api/v1/agent/reminder-candidates（2026-11-19 批4）。
 *
 * 只读：逐会话读 durable 的近 30 天用户消息 + 记忆库两条结构化查询，**不调模型**、
 * 不写任何东西。回滚：`REMINDER_DISTILL_ENABLED=false` → 404。
 * 日志只记条数（原话/教诲/问答三段），不记内容。
 */
export function mountReminderCandidates(app: Hono, deps: ReminderCandidatesDeps): void {
	app.get("/api/v1/agent/reminder-candidates", async (c) => {
		if (!(deps.enabled ?? reminderDistillEnabled)()) return c.json({ error: "not_found" }, 404);
		const sources = await readTranscriptSources(await deps.reader());
		const userLines = sources.flatMap((source) => source.lines).filter((line) => line.role === "user");
		const payload = collectReminderCandidates(deps.engine?.() ?? null, userLines);
		console.log(
			`[reminder-distill] 候选：原话 ${payload.counts.utterances} / 已有教诲 ${payload.counts.taught} / 确认问答 ${payload.counts.verified}`,
		);
		c.header("cache-control", "no-store");
		return c.json({ ok: true, ...payload, prompt: renderReminderDistillPrompt(payload) });
	});
}
