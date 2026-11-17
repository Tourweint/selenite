/**
 * 员工人格 · 学习模块（2026-11-15 批3，方案 §六 / 任务书 §1）
 *
 * 学主人说话风格：会话结算钩子里做**确定性特征统计**（句长、称呼、语气词、引号里的黑话候选），
 * 落伙伴家目录 `persona/voice.json`。反思频率（`PARTNER_LEARNING_FREQUENCY`）决定什么时候用
 * **执事自己的模型链**把统计 + 短例句提炼成规则；weekly 挂在既有周盘点之后，settle 每 N 次抽查。
 *
 * 红线（AGENTS.md）：
 *   - 只落**提炼后的规则与短例句（≤40 字）**，不存整段对话原文；
 *   - 日志只记条数 / 枚举，不记规则正文、不记例句；
 *   - 样本与规则不进 export-bundle / 团队包；
 *   - `MEMORY_ENABLED=false`、总开关 false 或模块关 → 整模块停（内容保留）。
 */

import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { flagValue } from "./flags.ts";
import {
	PARTNER_VOICE_LIMITS,
	PartnerVoiceRuleSchema,
	type PartnerVoiceRule,
	type PartnerVoiceView,
} from "@lifediary/shared";
import { partnersStore, type PartnerRow, type PartnersStore } from "./partners.ts";
import { effectivePersonaModules, personaModulesEnabled } from "./partner-persona.ts";
import { currentModels, isFaux, readLlmConfig } from "./provider.ts";

/** 抽取超时：后台动作，宁可丢一次也不挂着。 */
const REFINE_TIMEOUT_MS = 20_000;
/** settle 档的抽查间隔：每 5 次结算提炼一次。 */
export const LEARNING_REFRESH_EVERY = 5;
/** 注入时最多给几条规则（再多就变成提示词灌水）。 */
const INJECT_RULES_MAX = 6;

export type LearningFrequency = "weekly" | "settle";

/**
 * 反思频率（env `PARTNER_LEARNING_FREQUENCY`）：
 * - `weekly`（缺省）：只在既有周盘点跑完后提炼；
 * - `settle`：结算钩子里每 N 轮抽查一次。
 * 拼错 / 空值按 weekly（不因拼错就频繁烧模型）。
 */
export function learningFrequency(env: NodeJS.ProcessEnv = process.env): LearningFrequency {
	return flagValue("PARTNER_LEARNING_FREQUENCY", env) === "settle" ? "settle" : "weekly";
}

/**
 * 模块是否生效：总开关 + 模块开关 + `MEMORY_ENABLED` 三道。
 * 最后一道是任务书红线：记忆关掉时，学习模块整块停（不读、不更新、不注入）。
 */
export function learningModuleOn(partner: PartnerRow, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!personaModulesEnabled(env)) return false;
	if ((env.MEMORY_ENABLED ?? "").trim().toLowerCase() === "false") return false;
	return effectivePersonaModules(partner).learning === true;
}

export interface VoiceStats {
	turns: number;
	totalChars: number;
	shortTurns: number;
	longTurns: number;
	address: Record<string, number>;
	interjections: Record<string, number>;
}

export interface VoiceSample {
	/** 短例句（≤40 字）；不是整段对话原文。 */
	text: string;
	at: string;
}

/** `persona/voice.json` 的内部形状（不对外暴露；端点只回投影）。 */
export interface VoiceFile {
	version: 1;
	updatedAt: string;
	samples: VoiceSample[];
	stats: VoiceStats;
	rules: PartnerVoiceRule[];
}

export interface VoiceStoreLike {
	homeOf(partnerId: string): string;
	readHomeFile(partnerId: string, relative: string): string | null;
	atomicWrite(path: string, content: string): void;
}

function oneLine(text: string, max: number): string {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return [...flat].length <= max ? flat : `${[...flat].slice(0, max - 1).join("")}…`;
}

function emptyStats(): VoiceStats {
	return {
		turns: 0,
		totalChars: 0,
		shortTurns: 0,
		longTurns: 0,
		address: {},
		interjections: {},
	};
}

function emptyVoice(): VoiceFile {
	return {
		version: 1,
		updatedAt: new Date(0).toISOString(),
		samples: [],
		stats: emptyStats(),
		rules: [],
	};
}

function numberMap(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, number> = {};
	for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
		const number = Number(count);
		if (Number.isFinite(number) && number > 0) out[key.slice(0, 24)] = number;
	}
	return out;
}

/**
 * 读 `voice.json`。文件缺失 / 坏 JSON / 越界字段 → 空文件（与静态人格同一口径：
 * 手改磁盘留下的脏值不许进提示词）。
 */
export function readVoice(store: VoiceStoreLike, partnerId: string): VoiceFile {
	const raw = store.readHomeFile(partnerId, join("persona", "voice.json"));
	if (!raw?.trim()) return emptyVoice();
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const stats = (parsed.stats ?? {}) as Record<string, unknown>;
		const samples = Array.isArray(parsed.samples)
			? parsed.samples
					.map((item) => {
						const value = item as Record<string, unknown>;
						const text = oneLine(String(value.text ?? ""), PARTNER_VOICE_LIMITS.example);
						const at = String(value.at ?? "");
						return text && at ? { text, at } : null;
					})
					.filter((item): item is VoiceSample => item !== null)
					.slice(-PARTNER_VOICE_LIMITS.samples)
			: [];
		const rules = Array.isArray(parsed.rules)
			? parsed.rules
					.map((item) => {
						const result = PartnerVoiceRuleSchema.safeParse(item);
						return result.success ? result.data : null;
					})
					.filter((item): item is PartnerVoiceRule => item !== null)
					.slice(0, PARTNER_VOICE_LIMITS.rules)
			: [];
		return {
			version: 1,
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : emptyVoice().updatedAt,
			samples,
			stats: {
				turns: Math.max(0, Math.trunc(Number(stats.turns) || 0)),
				totalChars: Math.max(0, Math.trunc(Number(stats.totalChars) || 0)),
				shortTurns: Math.max(0, Math.trunc(Number(stats.shortTurns) || 0)),
				longTurns: Math.max(0, Math.trunc(Number(stats.longTurns) || 0)),
				address: numberMap(stats.address),
				interjections: numberMap(stats.interjections),
			},
			rules,
		};
	} catch {
		return emptyVoice();
	}
}

export function writeVoice(store: VoiceStoreLike, partnerId: string, voice: VoiceFile): void {
	store.atomicWrite(
		join(store.homeOf(partnerId), "persona", "voice.json"),
		`${JSON.stringify(voice, null, 2)}\n`,
	);
}

/** 常见称呼（按长度降序，先认长词，避免「亲」把「亲爱的」拆走）。 */
const ADDRESS_WORDS = [
	"亲爱的",
	"宝宝",
	"宝子",
	"兄弟",
	"姐妹",
	"老板",
	"老大",
	"主人",
	"您",
	"你",
] as const;

/** 语气词 / 笑声（只统计出现次数，不猜语义）。 */
const INTERJECTION_WORDS = [
	"哈哈",
	"hhh",
	"嘿嘿",
	"呵呵",
	"好嘞",
	"嗯嗯",
	"唉",
	"哎",
	"啊",
	"呀",
	"呢",
	"吧",
	"嘛",
	"哦",
] as const;

/** 一句里引号 / 括号中的词，作为黑话候选（≥2 字）。 */
const QUOTED_TERM_RE = /[「“"《]([^」”"》]{2,12})[」”"》]/g;

export interface TurnStyleSignals {
	chars: number;
	short: boolean;
	long: boolean;
	address: string[];
	interjections: string[];
	jargon: string[];
}

/**
 * 从**一条**用户消息里取风格信号（纯函数，单测直接断言）。
 *
 * 只看最后一条用户消息，与批2 的印象结算同一判据：历史消息是上一轮的事，
 * 重复统计会把一次习惯数成十次。
 */
export function turnStyleSignals(text: string): TurnStyleSignals {
	const trimmed = String(text ?? "").trim();
	const chars = [...trimmed].length;
	const sentenceCount = Math.max(1, trimmed.split(/[。！？!?；;…]+/).filter((part) => part.trim()).length);
	const avg = sentenceCount > 0 ? chars / sentenceCount : chars;
	const address = ADDRESS_WORDS.filter((word) => trimmed.includes(word));
	const interjections = INTERJECTION_WORDS.filter((word) => trimmed.toLowerCase().includes(word));
	const jargon = [...new Set([...trimmed.matchAll(QUOTED_TERM_RE)].map((match) => match[1] ?? ""))]
		.filter((term) => [...term].length >= 2)
		.slice(0, 3);
	return {
		chars,
		// 短句 / 长句按"每条句子平均字数"判，不按整条消息长度（一句长话也可能是短句习惯）。
		short: avg > 0 && avg <= 15,
		long: avg >= 40,
		address,
		interjections,
		jargon,
	};
}

function topKey(map: Record<string, number>): string | null {
	let best: string | null = null;
	let count = 0;
	for (const [key, value] of Object.entries(map)) {
		if (value > count) {
			best = key;
			count = value;
		}
	}
	return best;
}

function topKeys(map: Record<string, number>, limit: number): string[] {
	return Object.entries(map)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([key]) => key);
}

function makeRule(
	kind: PartnerVoiceRule["kind"],
	text: string,
	at: string,
	example?: string,
): PartnerVoiceRule {
	return {
		kind,
		text: oneLine(text, PARTNER_VOICE_LIMITS.ruleText),
		...(example ? { example: oneLine(example, PARTNER_VOICE_LIMITS.example) } : {}),
		at,
	};
}

/**
 * 从统计 + 短例句推导确定性规则（不调模型）。
 * 黑话规则不在这里生成：没有解释的"词"没有价值，交给模型提炼；模型不可用就留着旧规则。
 */
export function deriveVoiceRules(
	stats: VoiceStats,
	samples: VoiceSample[],
	previousJargon: PartnerVoiceRule[],
	at: string,
): PartnerVoiceRule[] {
	const rules: PartnerVoiceRule[] = [];
	if (stats.turns <= 0) return previousJargon.slice(0, PARTNER_VOICE_LIMITS.rules);
	const example = samples[samples.length - 1]?.text;
	const shortRatio = stats.shortTurns / stats.turns;
	const longRatio = stats.longTurns / stats.turns;
	if (shortRatio >= 0.6) {
		rules.push(makeRule("sentenceLength", "主人说话偏短，常常一两句说完", at, example));
	} else if (longRatio >= 0.4) {
		rules.push(makeRule("sentenceLength", "主人说话偏长，习惯把来龙去脉交代清楚", at, example));
	} else if (stats.turns >= 3) {
		rules.push(makeRule("sentenceLength", "主人句长适中，不刻意压短也不铺陈", at));
	}
	const address = topKey(stats.address);
	if (address) {
		rules.push(
			makeRule(
				"address",
				address === "你" || address === "您"
					? `主人习惯用「${address}」称呼你`
					: `主人习惯叫你「${address}」`,
				at,
			),
		);
	}
	const interjections = topKeys(stats.interjections, 2);
	if (interjections.length > 0) {
		rules.push(
			makeRule(
				"interjection",
				`主人常用${interjections.map((word) => `「${word}」`).join("")}这类语气词`,
				at,
			),
		);
	}
	return [...rules, ...previousJargon].slice(0, PARTNER_VOICE_LIMITS.rules);
}

/** 把一条用户消息并入统计 + 样本 + 确定性规则（纯函数，单测直接断言）。 */
export function mergeVoiceTurn(voice: VoiceFile, text: string, at: string): VoiceFile {
	const signals = turnStyleSignals(text);
	const stats: VoiceStats = {
		turns: voice.stats.turns + 1,
		totalChars: voice.stats.totalChars + signals.chars,
		shortTurns: voice.stats.shortTurns + (signals.short ? 1 : 0),
		longTurns: voice.stats.longTurns + (signals.long ? 1 : 0),
		address: { ...voice.stats.address },
		interjections: { ...voice.stats.interjections },
	};
	for (const word of signals.address) stats.address[word] = (stats.address[word] ?? 0) + 1;
	for (const word of signals.interjections) {
		stats.interjections[word] = (stats.interjections[word] ?? 0) + 1;
	}
	const samples = [
		...voice.samples.filter((sample) => sample.text !== oneLine(text, PARTNER_VOICE_LIMITS.example)),
		{ text: oneLine(text, PARTNER_VOICE_LIMITS.example), at },
	].slice(-PARTNER_VOICE_LIMITS.samples);
	const jargon = voice.rules.filter((rule) => rule.kind === "jargon");
	return {
		version: 1,
		updatedAt: at,
		samples,
		stats,
		rules: deriveVoiceRules(stats, samples, jargon, at),
	};
}

// ── 模型提炼（执事自己的模型链）────────────────────────────

export interface VoiceRefineDeps {
	/** 单测注入：直接给一段模型文本（不碰真实模型）。 */
	complete?: (prompt: string) => Promise<string | null>;
}

function buildRefinePrompt(partnerName: string, voice: VoiceFile): string {
	const stats = voice.stats;
	const avg = stats.turns > 0 ? Math.round(stats.totalChars / stats.turns) : 0;
	const samples = voice.samples.map((sample) => `- ${sample.text}`).join("\n") || "（无）";
	return [
		`你是「${partnerName}」本人。下面是从主人最近几句话里提炼出的说话特征和短例句（每条不超过 40 字）。`,
		"请只根据这些材料，总结主人说话的 3–6 条习惯，供你以后模仿；不要复述例句，不要编造没出现过的内容。",
		"",
		`统计：共 ${stats.turns} 句，平均 ${avg} 字/句，短句 ${stats.shortTurns} 次，长句 ${stats.longTurns} 次。`,
		`称呼：${JSON.stringify(stats.address)}`,
		`语气词：${JSON.stringify(stats.interjections)}`,
		"短例句：",
		samples,
		"",
		"严格输出 JSON（不要代码块）：",
		'{"rules":[{"kind":"sentenceLength|address|interjection|jargon","text":"不超过60字","example":"可选，不超过40字"}]}',
		"其中 jargon 只写短例句里出现过的黑话 / 新词，格式「词」= 一句话解释；没有就返回空数组。",
	].join("\n");
}

function parseRefinedRules(raw: string, at: string): PartnerVoiceRule[] {
	const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return [];
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as { rules?: unknown };
		if (!Array.isArray(parsed.rules)) return [];
		const rules: PartnerVoiceRule[] = [];
		for (const item of parsed.rules) {
			const value = item as Record<string, unknown>;
			const rule = PartnerVoiceRuleSchema.safeParse({
				kind: value.kind,
				text: oneLine(String(value.text ?? ""), PARTNER_VOICE_LIMITS.ruleText),
				...(typeof value.example === "string" && value.example.trim()
					? { example: oneLine(value.example, PARTNER_VOICE_LIMITS.example) }
					: {}),
				at,
			});
			if (rule.success) rules.push(rule.data);
			if (rules.length >= PARTNER_VOICE_LIMITS.rules) break;
		}
		return rules;
	} catch {
		return [];
	}
}

/**
 * 合并模型规则与确定性规则：非黑话按 kind 用模型版覆盖，黑话用模型版（没有就保留旧的）。
 * 这样模型不可用 / 输出不全时，确定性规则不会整段消失。
 */
export function mergeRefinedRules(
	deterministic: PartnerVoiceRule[],
	refined: PartnerVoiceRule[],
): PartnerVoiceRule[] {
	const byKind = new Map<PartnerVoiceRule["kind"], PartnerVoiceRule>();
	for (const rule of deterministic) {
		if (rule.kind !== "jargon" && !byKind.has(rule.kind)) byKind.set(rule.kind, rule);
	}
	const jargon = refined.filter((rule) => rule.kind === "jargon");
	for (const rule of refined) {
		if (rule.kind !== "jargon") byKind.set(rule.kind, rule);
	}
	const base = [...byKind.values()];
	const keptJargon = jargon.length > 0
		? jargon
		: deterministic.filter((rule) => rule.kind === "jargon");
	return [...base, ...keptJargon].slice(0, PARTNER_VOICE_LIMITS.rules);
}

async function completeWithPartnerModel(
	partnerId: string,
	prompt: string,
): Promise<string | null> {
	if (process.env.LLM_PROVIDER === "faux" || isFaux()) return null;
	const models = currentModels();
	const config = readLlmConfig();
	const chain = partnersStore().getModelChain(partnerId);
	const ref =
		chain
			.map((item) => ({ provider: item.providerId, modelId: item.modelId }))
			.find((item) => models.getModel(item.provider, item.modelId)) ??
		(config ? { provider: config.model.provider, modelId: config.model.modelId } : null);
	if (!ref) return null;
	const model = models.getModel(ref.provider, ref.modelId);
	if (!model) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REFINE_TIMEOUT_MS);
	try {
		const response = await models.completeSimple(
			model,
			{
				systemPrompt: "你只做说话习惯归纳，只输出 JSON。不要复述对话原文。",
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{ signal: controller.signal, maxTokens: 600, temperature: 0 },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") return null;
		return contentText(response.content) || null;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// 只记错误摘要（不含提示词 / 例句）
		console.warn(`[persona] 表达习惯提炼失败: ${detail.slice(0, 200)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** 每个执事一条串行链：结算与周盘点可能同时触发提炼，避免互相覆盖。 */
const voiceLocks = new Map<string, Promise<unknown>>();

function withVoiceLock<T>(partnerId: string, fn: () => Promise<T>): Promise<T> {
	const previous = voiceLocks.get(partnerId) ?? Promise.resolve();
	const next = previous.then(fn, fn).finally(() => {
		if (voiceLocks.get(partnerId) === next) voiceLocks.delete(partnerId);
	});
	voiceLocks.set(partnerId, next);
	return next as Promise<T>;
}

/**
 * 用执事自己的模型链把当前统计 + 短例句提炼成规则。
 * 任何失败都只 warn，保留确定性结果；绝不把对话原文写进日志。
 */
export async function refineVoice(
	partnerId: string,
	deps: VoiceRefineDeps = {},
	store: PartnersStore = partnersStore(),
): Promise<boolean> {
	const partner = store.get(partnerId);
	if (!partner || !learningModuleOn(partner)) return false;
	return withVoiceLock(partnerId, async () => {
		const current = readVoice(store, partnerId);
		if (current.samples.length === 0) return false;
		const prompt = buildRefinePrompt(partner.name, current);
		const raw = deps.complete
			? await deps.complete(prompt)
			: await completeWithPartnerModel(partnerId, prompt);
		if (!raw) return false;
		const refined = parseRefinedRules(raw, new Date().toISOString());
		if (refined.length === 0) return false;
		const next: VoiceFile = {
			...current,
			updatedAt: new Date().toISOString(),
			rules: mergeRefinedRules(current.rules, refined),
		};
		writeVoice(store, partnerId, next);
		console.log(`[persona] 表达习惯提炼 +${refined.length}（枚举 rules）`);
		return true;
	}).then(
		(applied) => applied,
		(error: unknown) => {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[persona] 表达习惯提炼失败: ${detail.slice(0, 200)}`);
			return false;
		},
	);
}

/**
 * 结算钩子：把最后一条用户消息并入 `voice.json`。
 * 只认 canonical 主会话（调用方已判）；模块关 / 空消息直接返回。
 * `settle` 档每 N 轮抽查一次模型提炼；`weekly` 档交给 `reflectVoiceWeekly`。
 */
export async function noteOwnerStyle(input: {
	partnerId: string;
	messages: Array<{ role: string; content: string }>;
	at?: string;
	store?: PartnersStore;
	refine?: VoiceRefineDeps;
}): Promise<boolean> {
	const store = input.store ?? partnersStore();
	try {
		const partner = store.get(input.partnerId);
		if (!partner || !learningModuleOn(partner)) return false;
		const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
		const text = String(lastUser?.content ?? "").trim();
		if (!text) return false;
		const at = input.at ?? new Date().toISOString();
		const voice = readVoice(store, input.partnerId);
		writeVoice(store, input.partnerId, mergeVoiceTurn(voice, text, at));
		console.log("[persona] 表达习惯 +1（枚举 turn）");
		if (learningFrequency() === "settle") {
			const turns = readVoice(store, input.partnerId).stats.turns;
			if (turns % LEARNING_REFRESH_EVERY === 0) {
				void refineVoice(input.partnerId, input.refine ?? {}, store);
			}
		}
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 表达习惯结算失败（不影响对话）: ${detail.slice(0, 200)}`);
		return false;
	}
}

/**
 * 周盘点扩展（`routines.ts` 在盘点例行成功之后调用）：用执事模型链提炼一次。
 * 不新造调度——还是既有盘点轮，只是多一次后台提炼。
 */
export async function reflectVoiceWeekly(
	partnerId: string,
	deps: VoiceRefineDeps = {},
	store: PartnersStore = partnersStore(),
): Promise<boolean> {
	// 频率是 settle 时，周盘点不再额外提炼（抽查只在结算钩子里发生）。
	if (learningFrequency() !== "weekly") return false;
	const partner = store.get(partnerId);
	if (!partner || !learningModuleOn(partner)) return false;
	return refineVoice(partnerId, deps, store);
}

/** 端点 / 档案页投影。 */
export function voiceView(partner: PartnerRow, store: PartnersStore = partnersStore()): PartnerVoiceView {
	const voice = readVoice(store, partner.id);
	return {
		ruleCount: voice.rules.length,
		jargonCount: voice.rules.filter((rule) => rule.kind === "jargon").length,
		rules: voice.rules,
		updatedAt: voice.stats.turns > 0 ? voice.updatedAt : null,
	};
}

/** 注入一小节「表达习惯」；模块关 / 规则空 → undefined（整段不出现）。 */
export function buildLearningSection(
	partner: PartnerRow,
	store: PartnersStore = partnersStore(),
): string | undefined {
	if (!learningModuleOn(partner)) return undefined;
	const voice = readVoice(store, partner.id);
	if (voice.rules.length === 0) return undefined;
	const lines = ["【表达习惯】"];
	for (const rule of voice.rules.slice(0, INJECT_RULES_MAX)) {
		const example = rule.example && rule.kind !== "jargon" ? `（例：${rule.example}）` : "";
		lines.push(`- ${rule.text}${example}`);
	}
	return lines.join("\n");
}
