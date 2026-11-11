import type { MemoryCandidate, MemoryScope } from "./types.ts";
import { scopeKey } from "./types.ts";

/**
 * 抽取层：把一段对话变成"值得记的候选"。
 *
 * 这是整个记忆系统里最该被替换的一层。两套实现，**接口同一个**：
 *
 * - `HeuristicExtractor`：纯规则，2026-11-04 的原始实现，只把用户说的每句话记成 episode。
 *   保留它是为了两件事：LLM 不可用时兜底；以及 `MEMORY_EXTRACT=rule` 能逐字节回到旧行为。
 * - `DialogueExtractor`（2026-11-06 起叫 `PreferenceExtractor`，2026-11-10 对标
 *   Anthropic 智能体记忆文章扩成偏好 + 经验两类）：判据是**最窄的两类**——
 *   用户偏好与"用户纠正过/验证过的做法"（experience），判断交给调用方注入的一次性
 *   模型调用（memory 包不碰模型、不读 env、不读配置），解析与清洗在
 *   `parseExtractionJson` 里做纯函数，便于单测。经验可关（`MEMORY_EXTRACT_EXPERIENCE=false`
 *   由装配层消费，关掉 = 提示词与解析逐字节回到只抽偏好的旧形态）。
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

/**
 * 一次抽取最多落几条经验（2026-11-10 对标 Anthropic §二）：比偏好更窄——
 * 经验是"把教训炼成做法"，一段对话里能炼出三条已经很多，多了就是抄对话。
 */
export const MAX_EXPERIENCES_PER_TURN = 3;

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

/**
 * 经验抽取开关（2026-11-10 对标 Anthropic §二）：`MEMORY_EXTRACT_EXPERIENCE=false`
 * 关（默认开，回滚一行）。关掉 = 只抽偏好，提示词与解析逐字节回到旧形态。
 */
export function experienceExtractionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.MEMORY_EXTRACT_EXPERIENCE?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/** 归一化时剥掉的字符（空白 + 中西文常用标点）——两处共用，防口径漂移。 */
const GROUNDING_STRIP = /[\s，。；、！？：,.:;!?()（）"'「」『』【】\-—_~/\\]+/g;

/** 归一化：小写、去空白与常见标点——只服务依据匹配，不做通用清洗。 */
export function normalizeForGrounding(text: string): string {
	return text.toLowerCase().replace(GROUNDING_STRIP, "");
}

/**
 * 归一化 + **原文位置映射**（2026-11-10 对标 Anthropic §一，给整理建议的证据引文用）。
 *
 * `norm[i]` 是归一化串第 i 个 UTF-16 单元，`map[i]` 是它在**原文**里的下标——归一化在
 * 原文里找到命中后，要能回到原文摘"给人看的片段"。三个域必须同一套（都是 UTF-16 下标），
 * 含 emoji / 生僻字（代理对）的文本才不会错位：所以按 `char.length` 推进原文下标、
 * 按单元建 map，不变式 `map.length === norm.length` 对任意文本成立。
 * `toLowerCase()` 个别字符会一变多（如 `İ` → i + 组合点），多出来的单元补同一个原文下标。
 */
export function normalizeForGroundingWithMap(text: string): { norm: string; map: number[] } {
	const normChars: string[] = [];
	const map: number[] = [];
	for (let index = 0; index < text.length; ) {
		const char = String.fromCodePoint(text.codePointAt(index)!);
		const stripped = char.toLowerCase().replace(GROUNDING_STRIP, "");
		for (const folded of [...stripped]) {
			for (let unit = 0; unit < folded.length; unit += 1) {
				normChars.push(folded[unit]!);
				map.push(index);
			}
		}
		index += char.length;
	}
	return { norm: normChars.join(""), map };
}

/** 引文锚点的窗口大小，从长到短试：长锚点误报少，4 字与抽取侧 `groundedInUserText` 同判据兜底。 */
const EVIDENCE_WINDOW_SIZES = [12, 8, 6, 4];

/** 引文片段的半径：命中处前 40 字、后 80 字（与跨会话搜索 `SearchHit.text` 同口径）。 */
const EVIDENCE_CONTEXT_CHARS = { before: 40, after: 80 } as const;

/**
 * 在一段原文（会话记录正文）里找记忆正文的**最早命中**，返回可直接给人看的片段。
 *
 * - needle 只取记忆正文**首行**：偏好的 Why/How 是我们补写的，原话里不会有；
 * - 匹配在归一化层做（容忍措辞间的标点 / 空白差异），展示摘原文（带标点，人读着顺）；
 * - 窗口从 12 字试到 4 字：先找特异性强的锚点，都没有再退到与引文校验相同的 4 字判据；
 * - 找不到返回 null——证据是给人核对用的，不是门槛。
 */
export function locateEvidence(text: string, needle: string): string | null {
	const firstLine = (needle.split("\n")[0] ?? "").trim();
	const { norm: normHaystack, map } = normalizeForGroundingWithMap(text);
	const normNeedle = normalizeForGrounding(firstLine);
	if (!normHaystack || normNeedle.length < 4) return null;

	for (const size of EVIDENCE_WINDOW_SIZES) {
		if (normNeedle.length < size) continue;
		for (let start = 0; start + size <= normNeedle.length; start += 1) {
			const at = normHaystack.indexOf(normNeedle.slice(start, start + size));
			if (at < 0) continue;
			const hit = map[at] ?? 0;
			const from = Math.max(0, hit - EVIDENCE_CONTEXT_CHARS.before);
			const to = Math.min(text.length, hit + size + EVIDENCE_CONTEXT_CHARS.after);
			return [
				from > 0 ? "…" : "",
				text.slice(from, to),
				to < text.length ? "…" : "",
			].join("");
		}
	}
	return null;
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

/** 一次抽取解析出的两类草稿（2026-11-10 对标 Anthropic §二：偏好 + 经验）。 */
export interface ExtractionDrafts {
	preferences: PreferenceDraft[];
	experiences: PreferenceDraft[];
}

/**
 * 解析模型输出。**永不抛错**：模型返回 markdown 代码块、前后加解释、字段名写错都是常态，
 * 抽取失败最多等于"这轮没抽到"，绝不能让记忆写入把对话搞挂（调用方还有规则兜底）。
 *
 * 接受这些形状：
 *   1. `[{content, why, howToApply, confidence}]` —— 旧形状，整段当偏好
 *   2. `{preferences: [...]}`
 *   3. `{preferences: [...], experiences: [...]}`（2026-11-10 起）
 *   4. `{experiences: [...]}` 单独一段（模型漏了偏好栏时也能活）
 *   5. 直接一段带 ```json 围栏的文本
 */
export function parseExtractionJson(raw: string): ExtractionDrafts {
	const text = raw.trim();
	if (!text) return { preferences: [], experiences: [] };

	const unfenced = (() => {
		const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
		return (fenced?.[1] ?? text).trim();
	})();

	// 模型常见毛病：JSON 前后各写一句"好的，我提取到："。取第一个 [ 或 { 到最后一个 ] 或 }。
	const start = unfenced.search(/[[{]/);
	const end = Math.max(unfenced.lastIndexOf("]"), unfenced.lastIndexOf("}"));
	if (start < 0 || end <= start) return { preferences: [], experiences: [] };

	let parsed: unknown;
	try {
		parsed = JSON.parse(unfenced.slice(start, end + 1));
	} catch {
		return { preferences: [], experiences: [] };
	}

	const toDrafts = (list: unknown[], max: number): PreferenceDraft[] => {
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
			if (drafts.length >= max) break;
		}
		return drafts;
	};

	const asList = (value: unknown): unknown[] =>
		value !== null && typeof value === "object" && Array.isArray(value) ? value : [];

	if (Array.isArray(parsed)) {
		return { preferences: toDrafts(parsed, MAX_PREFERENCES_PER_TURN), experiences: [] };
	}
	if (!parsed || typeof parsed !== "object") return { preferences: [], experiences: [] };
	const record = parsed as Record<string, unknown>;
	return {
		preferences: toDrafts(asList(record.preferences), MAX_PREFERENCES_PER_TURN),
		experiences: toDrafts(asList(record.experiences), MAX_EXPERIENCES_PER_TURN),
	};
}

/**
 * 只解析偏好（旧入口，保持兼容）：`parseExtractionJson` 的偏好栏。
 * 旧调用方（selftest / 外部）语义逐字节不变——坏输入返回 []，永不抛。
 */
export function parsePreferenceJson(raw: string): PreferenceDraft[] {
	return parseExtractionJson(raw).preferences;
}

/**
 * 抽取用的提示词（只抽偏好的旧形态）。
 *
 * **只抽偏好**是刻意的窄口径：
 *
 * - 事实/经历交给规则抽取（它已经在做，且不需要判断力）；
 * - 偏好是"规则做不了、又高频影响回答风格"的东西；
 * - 窄口径让输出可预算（一条短 prompt、≤5 条结果），不必把整段对话再送一遍。
 *
 * 明确列出"不算偏好"的反例：模型最容易把"这次的要求"当"以后的原则"。
 *
 * `MEMORY_EXTRACT_EXPERIENCE=false` 时发送的就是这个字符串，**逐字节**回到
 * 2026-11-10 之前的形态——所以它保持原样不动，别顺手"整理"它。
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
 * 合并提示词（2026-11-10 对标 Anthropic §二）：偏好 + 经验**一次调用**出两类——
 * 独立调用 = 每轮多一次模型钱 + 多一个超时面；两段判据写清互不污染，
 * kind 不相交不会打架。实测混判率高再拆（接口不变、换实现）。
 *
 * 经验判据照 Anthropic 的"完整学习循环"收窄：只有**用户纠正过并说明原因**或
 * **验证过有效**的才算——文章自己提醒过，给记忆的判据太宽（"只记录失败"）
 * 会丢掉大部分收益，太宽则是把对话抄一遍。
 */
export const EXTRACTION_PROMPT_COMBINED = [
	"你在做一件事：从下面这段对话里，找出两类东西——**用户表达过的长期偏好**和**可复用的经验**。",
	"",
	"【偏好】用户对以后也成立的要求：",
	'- "我不喜欢被追问太多"、"以后都用中文"、"别再给我列一堆选项"、"先给结论"',
	"- 用户纠正了你的做法、并说明了原因（这是最有价值的一类）",
	"",
	"不算偏好的（这些不要输出）：",
	"- 只是这一次的任务要求（\"把这段翻译成英文\"）",
	"- 事实与经历（\"我今天面试挂了\"、\"我养了只猫\"）——另有通道记",
	"- 你已经能从常识判断的、或者用户只是在提问",
	"",
	"【经验】「下次遇到同类事可以怎么做」的做法，只认两类来源：",
	"- 用户纠正过做法、且说明了原因或验证过改法有效（\"上次那样被打回来，这次先给结论就过了\"）",
	"- 用户亲口总结的踩坑教训（\"连续 3 次失败就换节奏\"）",
	"你自己脑补的做法、一次性的任务安排、没验证过的想法，都不是经验，不要输出。",
	"",
	`输出严格的 JSON 对象：{"preferences":[...最多 ${MAX_PREFERENCES_PER_TURN} 条...],"experiences":[...最多 ${MAX_EXPERIENCES_PER_TURN} 条...]}，没有的一栏输出 []。`,
	"两栏每条形状相同：",
	'{"content": "一句话，用\\"用户\\"做主语或直接写要求", "why": "用户给的理由；没给就空串", "howToApply": "什么场景下该按这条来", "confidence": 0到1的数字}',
	"",
	"只输出 JSON，不要解释，不要 markdown 围栏。",
].join("\n");

/** 按开关给这一次抽取的提示词：关经验 = 逐字节发旧偏好提示词。 */
export function extractionPrompt(experience: boolean): string {
	return experience ? EXTRACTION_PROMPT_COMBINED : PREFERENCE_PROMPT;
}

export interface DialogueExtractorOptions {
	/**
	 * 是否同时抽经验（2026-11-10 对标 Anthropic §二）。默认 false = 只抽偏好，
	 * 提示词与解析逐字节回到旧形态（总闸在装配层，`MEMORY_EXTRACT_EXPERIENCE`）。
	 */
	experience?: boolean;
}

/**
 * 对话抽取器（2026-11-06 叫 `PreferenceExtractor`；2026-11-10 扩成偏好 + 经验两类）：
 * 把"调模型"这件事**注入进来**，不在包里写死。
 *
 * 这样 memory 包仍然不依赖任何供应商 / env（架构守卫会检查它不逃出包、不依赖 server）。
 * 模型调用失败由实现方返回 null，这里按"没抽到"处理——绝不抛。
 */
export class DialogueExtractor implements Extractor {
	private readonly experience: boolean;

	constructor(
		private readonly generate: (messages: ExtractMessage[]) => Promise<string | null>,
		options: DialogueExtractorOptions = {},
	) {
		this.experience = options.experience ?? false;
	}

	async extract(input: ExtractInput): Promise<MemoryCandidate[]> {
		const transcript = renderTranscript(input.messages);
		if (!transcript) return [];

		let raw: string | null = null;
		try {
			raw = await this.generate([
				{ role: "system", content: extractionPrompt(this.experience) },
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
		const grounded = (draft: PreferenceDraft): boolean => {
			// 引文校验（批 21 §四）：原话里找不到依据片段的不入库——模型把常识当偏好
			// 是"宁拒勿收"的经典误报源。只数一次量，不回显内容（日志不含对话内容）。
			if (quoteCheck && !groundedInUserText(draft.content, userText)) {
				rejected += 1;
				return false;
			}
			return true;
		};
		const { preferences, experiences } = parseExtractionJson(raw);
		const keptPreferences = preferences.filter(grounded);
		// 开关关着时经验栏整段丢弃：模型不守提示词（或注入的假实现回了新形状）也不落库
		const keptExperiences = this.experience ? experiences.filter(grounded) : [];
		if (rejected > 0) {
			console.warn(`[memory-extract] 偏好/经验引文校验拒收 ${rejected} 条（用户原话里找不到依据）`);
		}
		return [
			...keptPreferences.map((draft) => ({
				kind: "preference" as const,
				scope,
				content: renderPreference(draft),
				// 偏好天然比"今天吃了什么"重要；置信度只做微调，不主导排序
				importance: Math.min(1, 0.72 + draft.confidence * 0.2),
				// 偏好是用户自己说的（或当面转述的）：可信度最高
				veracity: "stated" as const,
				source: "extract:preference",
				validUntil: null,
			})),
			// 经验与偏好同形状同权重档：都是"用户自己的判断"，比一次性事件重要。
			// 偏好在前：巩固层按顺序处理，同一段话里"偏好"优先占位。
			...keptExperiences.map((draft) => ({
				kind: "experience" as const,
				scope,
				content: renderPreference(draft),
				importance: Math.min(1, 0.72 + draft.confidence * 0.2),
				veracity: "stated" as const,
				source: "extract:experience",
				validUntil: null,
			})),
		];
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
