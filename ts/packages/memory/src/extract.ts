import type { MemoryCandidate, MemoryScope } from "./types.ts";
import { scopeKey } from "./types.ts";

/**
 * 抽取层：把一段对话变成"值得记的候选"。
 *
 * 这是整个记忆系统里最该被替换的一层。两套实现，**接口同一个**：
 *
 * - `HeuristicExtractor`：纯规则，2026-11-04 的原始实现，只把用户说的每句话记成 episode。
 *   保留它是为了两件事：LLM 不可用时兜底；以及 `MEMORY_EXTRACT=rule` 能逐字节回到旧行为。
 * - `PreferenceExtractor`：2026-11-06 新增。判据是**用户偏好**这一种最窄的东西，
 *   判断交给调用方注入的一次性模型调用（memory 包不碰模型、不读 env、不读配置），
 *   解析与清洗在 `parsePreferenceJson` 里做纯函数，便于单测。
 *
 * 为什么不在这里做"完整抽取 Agent"（ZCode 的形态）：那需要工具、多轮、受限执行策略、
 * cursor 与 pending 槽，是跨仓库契约级工程量；当前真缺口只是"偏好从来没被识别过"。
 * `Extractor` 接口不变，以后升级是换实现而不是改契约。
 */

export interface ExtractMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ExtractInput {
	messages: ExtractMessage[];
	scope: MemoryScope;
	now: Date;
}

export interface Extractor {
	extract(input: ExtractInput): Promise<MemoryCandidate[]>;
}

/** 寒暄/无信息量的短句，不值得存 */
const NOISE = /^(嗯+|哦+|好的?|行|对|是|在吗|你好|谢谢|哈哈+|ok|okay|hi|hey)[。！？.!?~～\s]*$/i;

const SENTENCE_SPLIT = /[。！？!?\n]+/;

/**
 * 规则版抽取器：
 * 只从**用户说的话**里取，助手说的不记（助手的话是我们自己的产物，
 * 记下来会形成自我强化的回声）。按句切分，过滤寒暄与碎片。
 */
export class HeuristicExtractor implements Extractor {
	async extract(input: ExtractInput): Promise<MemoryCandidate[]> {
		const candidates: MemoryCandidate[] = [];
		const scope = scopeKey(input.scope);

		for (const message of input.messages) {
			if (message.role !== "user") continue;

			for (const raw of message.content.split(SENTENCE_SPLIT)) {
				const sentence = raw.trim();
				if (sentence.length < 6) continue;
				if (NOISE.test(sentence)) continue;

				candidates.push({
					// TODO(细节): 区分 fact / entity / preference。
					// 需要 LLM 参与判断，规则版一律记成 episode。
					kind: "episode",
					scope,
					content: sentence,
					importance: Math.min(1, sentence.length / 60) * 0.6 + 0.2,
					veracity: "stated",
					source: "extract:heuristic",
					validUntil: null,
				});
			}
		}

		return candidates;
	}
}

/** 什么都不抽的版本：用于"只想跑通、不想存记忆"的场景 */
export class NoopExtractor implements Extractor {
	async extract(): Promise<MemoryCandidate[]> {
		return [];
	}
}

// scope→key 的换算统一用 types.ts 的 scopeKey（2026-11-05 批次B B1）：
// 这里原来有一份逐分支相同的私有复制，新增 scope 类型时必须改两处——
// partner 就是这样差点漏掉，所以删私有版收口成一处。

// ── 偏好抽取（2026-11-06）────────────────────────────────

/**
 * 模型返回的一条偏好。`why` / `howToApply` 照 cindy `feedback` 类与 ZCode 的硬要求：
 * 没有"为什么"和"什么时候用"的偏好，下次遇到同类场景照样会错。
 */
export interface PreferenceDraft {
	/** 偏好本身，一句话，第三人称或原话 */
	content: string;
	/** 为什么：用户给的理由 / 出过的事故。没有就空串 */
	why: string;
	/** 何时生效：什么场景下该按这条来 */
	howToApply: string;
	/** 0..1；低于阈值的丢弃（模型经常把"这次这么说"当偏好） */
	confidence: number;
}

/** 一次抽取最多落几条：偏好是窄口径，多了就是把闲聊当原则。 */
export const MAX_PREFERENCES_PER_TURN = 5;

/** 低于这个置信度直接丢。0.6 是"模型认为较确定"，低于它的多是当轮语气。 */
export const MIN_PREFERENCE_CONFIDENCE = 0.6;

/** 单条偏好正文上限（含 why/how 段），超过截断——防一段话占满注入预算。 */
export const MAX_PREFERENCE_CHARS = 400;

// ── 引文校验（2026-11-10 批 21 §四，七 #31 差半）────────────────
//
// 偏好必须能在**用户自己的原话**里找到依据片段，找不到 = 模型在编造
// （把常识或它自己的想法安到用户头上）。与 GROUNDING_DISCIPLINE 同哲学的
// 机械版：接地不做自然语言判断，只做"归一化后有没有共同的连续片段"。

/** 引文校验开关：`MEMORY_EXTRACT_QUOTE_CHECK=false` 关（默认开，回滚一行）。 */
export function preferenceQuoteCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.MEMORY_EXTRACT_QUOTE_CHECK?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 归一化：小写、去空白与常见标点——只服务依据匹配，不做通用清洗。 */
function normalizeForGrounding(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\s，。；、！？：,.:;!?()（）"'「」『』【】\-—_~/\\]+/g, "");
}

/**
 * 一条偏好草稿是否在用户原话里有依据：
 *   - 中文（含 CJK）：content 归一化后，任取 4 个连续字符能在用户原话里找到即算
 *     （转述会换句式，但关键短语总会保留；4 字在中文里已足够特异）；
 *   - 纯西文：content 的任一 ≥4 字母词在原话里出现即算。
 * 空原话 = 没有依据（用户什么都没说，偏好无从谈起）。
 */
export function groundedInUserText(content: string, userText: string): boolean {
	const needle = normalizeForGrounding(content);
	const haystack = normalizeForGrounding(userText);
	if (!needle || !haystack) return false;
	const hasCjk = /\p{Script=Han}/u.test(needle);
	if (!hasCjk) {
		// 西文按整词匹配——归一化会把词并成一串，所以从原文小写后切词比对
		const words = content.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
		const haystackWords = new Set(userText.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
		return words.some((word) => haystackWords.has(word));
	}
	for (let i = 0; i + 4 <= needle.length; i += 1) {
		if (haystack.includes(needle.slice(i, i + 4))) return true;
	}
	// content 比较短时（归一化后不足 4 字），退回"整段出现"判定
	return needle.length < 4 && haystack.includes(needle);
}

/** 把一条候选渲染成入库形状：`偏好\nWhy: …\nHow: …`（两段可缺）。 */
export function renderPreference(draft: PreferenceDraft): string {
	const content = draft.content.replace(/\s+/g, " ").trim();
	const why = draft.why.replace(/\s+/g, " ").trim();
	const how = draft.howToApply.replace(/\s+/g, " ").trim();
	const lines = [content];
	// 这两行是给人和模型看的，不是查询维度，所以走 content 文案而不是新增字段
	// （动 MemoryRecord 等于动 durable/手机端/导出全套契约）。
	if (why) lines.push(`Why: ${why}`);
	if (how) lines.push(`How: ${how}`);
	const text = lines.join("\n");
	return text.length > MAX_PREFERENCE_CHARS ? `${text.slice(0, MAX_PREFERENCE_CHARS - 1)}…` : text;
}

/**
 * 解析模型输出。**永不抛错**：模型返回 markdown 代码块、前后加解释、字段名写错都是常态，
 * 抽取失败最多等于"这轮没抽到"，绝不能让记忆写入把对话搞挂（调用方还有规则兜底）。
 *
 * 接受三种形状：
 *   1. `[{content, why, howToApply, confidence}]`
 *   2. `{preferences: [...]}`
 *   3. 直接一段带 ```json 围栏的文本
 */
export function parsePreferenceJson(raw: string): PreferenceDraft[] {
	const text = raw.trim();
	if (!text) return [];

	const unfenced = (() => {
		const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
		return (fenced?.[1] ?? text).trim();
	})();

	// 模型常见毛病：JSON 前后各写一句"好的，我提取到："。取第一个 [ 或 { 到最后一个 ] 或 }。
	const start = unfenced.search(/[[{]/);
	const end = Math.max(unfenced.lastIndexOf("]"), unfenced.lastIndexOf("}"));
	if (start < 0 || end <= start) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(unfenced.slice(start, end + 1));
	} catch {
		return [];
	}

	const list = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { preferences?: unknown }).preferences)
			? (parsed as { preferences: unknown[] }).preferences
			: [];
	if (list.length === 0) return [];

	const drafts: PreferenceDraft[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const content = typeof record.content === "string" ? record.content.trim() : "";
		if (!content) continue;
		const confidenceRaw = typeof record.confidence === "number" ? record.confidence : 0.7;
		const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.7;
		if (confidence < MIN_PREFERENCE_CONFIDENCE) continue;
		drafts.push({
			content,
			why: typeof record.why === "string" ? record.why : "",
			howToApply:
				typeof record.howToApply === "string"
					? record.howToApply
					: typeof record.how === "string"
						? record.how
						: "",
			confidence,
		});
		if (drafts.length >= MAX_PREFERENCES_PER_TURN) break;
	}
	return drafts;
}

/**
 * 抽取用的提示词。**只抽偏好**——这是刻意的窄口径：
 *
 * - 事实/经历交给规则抽取（它已经在做，且不需要判断力）；
 * - 偏好是唯一"规则做不了、又高频影响回答风格"的东西；
 * - 窄口径让输出可预算（一条短 prompt、≤5 条结果），不必把整段对话再送一遍。
 *
 * 明确列出"不算偏好"的反例：模型最容易把"这次的要求"当"以后的原则"。
 */
export const PREFERENCE_PROMPT = [
	"你在做一件事：从下面这段对话里，找出**用户表达过的长期偏好**。",
	"",
	"算偏好的（用户对以后也成立的要求）：",
		'- "我不喜欢被追问太多"、"以后都用中文"、"别再给我列一堆选项"、"先给结论"',
		'- 用户纠正了你的做法、并说明了原因（这是最有价值的一类）',
	"",
	"不算偏好的（这些不要输出）：",
	"- 只是这一次的任务要求（\"把这段翻译成英文\"）",
	"- 事实与经历（\"我今天面试挂了\"、\"我养了只猫\"）——另有通道记",
	"- 你已经能从常识判断的、或者用户只是在提问",
	"",
	`输出严格的 JSON 数组，最多 ${MAX_PREFERENCES_PER_TURN} 条；一条都没有就输出 []。`,
	"每条：",
	'{"content": "偏好本身，一句话，用\\"用户\\"做主语或直接写要求", "why": "用户给的理由；没给就空串", "howToApply": "什么场景下该按这条来", "confidence": 0到1的数字}',
	"",
	"只输出 JSON，不要解释，不要 markdown 围栏。",
].join("\n");

/**
 * 偏好抽取器：把"调模型"这件事**注入进来**，不在包里写死。
 *
 * 这样 memory 包仍然不依赖任何供应商 / env（架构守卫会检查它不逃出包、不依赖 server）。
 * 模型调用失败由实现方返回 null，这里按"没抽到"处理——绝不抛。
 */
export class PreferenceExtractor implements Extractor {
	constructor(
		private readonly generate: (messages: ExtractMessage[]) => Promise<string | null>,
	) {}

	async extract(input: ExtractInput): Promise<MemoryCandidate[]> {
		const transcript = renderTranscript(input.messages);
		if (!transcript) return [];

		let raw: string | null = null;
		try {
			raw = await this.generate([
				{ role: "system", content: PREFERENCE_PROMPT },
				{ role: "user", content: transcript },
			]);
		} catch {
			// 模型不可用 = 这轮没抽到；调用方可以再叠规则兜底
			return [];
		}
		if (!raw) return [];

		const scope = scopeKey(input.scope);
		const userText = input.messages
			.filter((message) => message.role === "user")
			.map((message) => message.content)
			.join("\n");
		const quoteCheck = preferenceQuoteCheckEnabled();
		let rejected = 0;
		const kept = parsePreferenceJson(raw).filter((draft) => {
			// 引文校验（批 21 §四）：原话里找不到依据片段的不入库——模型把常识当偏好
			// 是"宁拒勿收"的经典误报源。只数一次量，不回显内容（日志不含对话内容）。
			if (quoteCheck && !groundedInUserText(draft.content, userText)) {
				rejected += 1;
				return false;
			}
			return true;
		});
		if (rejected > 0) {
			console.warn(`[memory-extract] 偏好引文校验拒收 ${rejected} 条（用户原话里找不到依据）`);
		}
		return kept.map((draft) => ({
			kind: "preference" as const,
			scope,
			content: renderPreference(draft),
			// 偏好天然比"今天吃了什么"重要；置信度只做微调，不主导排序
			importance: Math.min(1, 0.72 + draft.confidence * 0.2),
			// 偏好是用户自己说的（或当面转述的）：可信度最高
			veracity: "stated" as const,
			source: "extract:preference",
			validUntil: null,
		}));
	}
}

/**
 * 把对话裁成"值得给抽取模型看"的形状。
 *
 * 两个刻意的裁剪：
 * 1. **只留用户说的 + 助手回答的首行**。助手的长篇输出会把 prompt 撑大，
 *    且偏好几乎总在用户那句里（或用户对助手首行的纠正里）。
 * 2. 单条最多 600 字、整体最多 6000 字（从最新的往前取）——预算可预期。
 */
export function renderTranscript(messages: ExtractMessage[], maxChars = 6000): string {
	const lines: string[] = [];
	let used = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "system") continue;
		const text = message.content.replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (message.role === "user" && NOISE.test(text)) continue;

		const body =
			message.role === "user"
				? text.slice(0, 600)
				: `${text.split(/(?<=[。！？.!?])/)[0]?.slice(0, 200) ?? text.slice(0, 200)}`;
		const line = `${message.role === "user" ? "用户" : "助手"}：${body}`;
		if (used + line.length > maxChars) break;
		lines.unshift(line);
		used += line.length;
	}
	return lines.join("\n");
}
