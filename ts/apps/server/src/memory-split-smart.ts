/**
 * 智能拆分（2026-11-16）：用辅助模型把一条长记忆拆成几条原子。
 *
 * 为什么不是主对话：主对话一轮贵、慢，还会把维护动作写进聊天上下文。
 * 这里走 `completeSimple` 的**独立一次性请求**——不读对话历史、不写回上下文，
 * 只消耗所选模型的额度（与 `memory-consolidate.ts` 的整理建议同一套先例）。
 *
 * 三条硬口径：
 *  1. **只出候选**：模型产出先过机械校验（逐字引文 + 长度 + 条数），再由人预览确认；
 *     不自动落库、不自动替换代码拆分的结果。
 *  2. **引文必须逐字**：`quote` 归一化后必须能在原文里找到；找不到的原子直接丢。
 *     全部被丢 = 这条失败，退回代码拆分，不写半截。
 *  3. **不改写原文**：原子正文可以是模型提炼的短句，但 `quote` 是原文片段；
 *     原记录归档、原文进 `memory_documents`（与代码拆分同一套落点）。
 *
 * 日志只记条数 / 字数 / 耗时 / 模型名（D8），不记正文。
 */

import { contentText } from "@earendil-works/pi-ai";
import type { MemoryEngine, MemoryKind, MemoryRecord } from "@lifediary/memory";
import { auxiliaryModel } from "./auxiliary.ts";
import { currentModels, isFaux, readLlmConfig, type ModelRef } from "./provider.ts";
import { applySplitPlan, type SplitPlanItem, type SplitPreview } from "./memory-split.ts";

/** 单条长记忆的模型调用超时：与整理建议同档。 */
const SPLIT_TIMEOUT_MS = 30_000;
/** 一条长记忆最多产多少原子（与代码拆分同上限）。 */
const MAX_ATOMS = 20;
/** 原子正文上限：fact / episode / entity。 */
const MAX_ATOM_CHARS = 200;
/** preference 放宽（要装 Why / How）。 */
const MAX_PREFERENCE_ATOM_CHARS = 400;
/** 喂给模型的原文上限：再长就只喂前面这段（后面的仍进原文档案）。 */
const MAX_INPUT_CHARS = 6000;
/** 低于这个长度的原子没有信息量，丢掉。 */
const MIN_ATOM_CHARS = 6;
/** 一次「智能拆分」最多处理几条记录：防止手滑点一下打几十次模型。 */
export const MAX_SMART_SPLIT_RECORDS = 12;

export const SPLIT_PROMPT = [
	"你在把一条记忆拆成更小的「原子事实」。这条记忆是模型早先总结出来的，可能很长、很乱，混着好几件事。",
	"",
	"规则：",
	`1. 最多 ${MAX_ATOMS} 条；能拆成 2-6 条最好，本来就只有一件事就原样输出 1 条。`,
	`2. 每条 content 是一句能独立看懂的话，不超过 ${MAX_ATOM_CHARS} 字（偏好可到 ${MAX_PREFERENCE_ATOM_CHARS} 字）。`,
	"3. 每条必须带 quote：**从下面原文里逐字复制**的一段连续文字（至少 8 个字，不要改写、不要拼接、不要加省略号）。",
	"4. 只拆原文里确实写着的内容；不要补充背景、不要推测、不要合并你自己的想法。",
	"5. 保留具体信息：日期、项目名、文件路径、开关名、数字。这些是以后要查的东西。",
	"6. 同一条原子不要在两条里重复。",
	"",
	'输出严格的 JSON：{"atoms":[{"content":"…","quote":"…"}]}',
	"只输出 JSON，不要解释，不要 markdown 围栏。",
].join("\n");

export interface SmartSplitAtom {
	content: string;
	quote: string;
	quoteStart: number | null;
	quoteEnd: number | null;
}

export interface SmartSplitRecord {
	recordId: string;
	title: string;
	kind: MemoryKind;
	chars: number;
	atoms: SmartSplitAtom[];
	/** 模型返回的原子里有几条被引文校验丢掉 */
	dropped: number;
	error?: string;
}

export interface SmartSplitResult {
	ok: boolean;
	model: string | null;
	records: SmartSplitRecord[];
	/** 总调用次数（= 成功进入模型的记录数） */
	calls: number;
	error?: string;
}

export interface SmartSplitDeps {
	/** 测试注入：假模型输出（拿到 prompt，返回原始文本） */
	generate?: (input: { system: string; user: string }) => Promise<string | null>;
	/** 测试注入：跳过真实模型解析，直接用这个 ref（生产不传） */
	model?: ModelRef | null;
	timeoutMs?: number;
}

/** 所选模型是否可用：显式传了 ref 就用它，否则走辅助模型解析。 */
export function resolveSplitModel(ref?: { provider: string; modelId: string } | null): ModelRef | null {
	const config = readLlmConfig();
	if (!config) return null;
	if (isFaux()) return null;
	if (ref) {
		const models = currentModels();
		const model = models.getModel(ref.provider, ref.modelId);
		return model ? { provider: ref.provider, modelId: ref.modelId } : null;
	}
	return auxiliaryModel("split", { current: config.model }) ?? config.model;
}

/** 所选模型在目录里存在且不是 faux（前端下拉据此灰态）。 */
export function splitModelAvailable(ref?: { provider: string; modelId: string } | null): boolean {
	return Boolean(resolveSplitModel(ref));
}

function normalizeForQuote(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * 引文校验：`quote` 归一化后必须能在原文里找到。
 *
 * 归一化只折叠空白（模型常把换行变空格），**不做同义替换**：找不到就是找不到。
 * 返回在原文里的字符偏移（找不到 = null）。
 */
export function locateQuote(content: string, quote: string): { start: number; end: number } | null {
	const needle = normalizeForQuote(quote);
	if (needle.length < 4) return null;
	// 先试原文直配（多数情况模型就是原样抄的）
	const direct = content.indexOf(quote.trim());
	if (direct >= 0) return { start: direct, end: direct + quote.trim().length };
	// 再试空白折叠后的匹配：把原文按同样规则折叠，同时记录每段折叠文本对应的原偏移。
	const map: number[] = [];
	let folded = "";
	let previousSpace = false;
	for (let i = 0; i < content.length; i += 1) {
		const ch = content[i]!;
		if (/\s/.test(ch)) {
			if (!previousSpace) {
				folded += " ";
				map.push(i);
				previousSpace = true;
			}
			continue;
		}
		folded += ch;
		map.push(i);
		previousSpace = false;
	}
	const at = folded.indexOf(needle);
	if (at < 0) return null;
	const start = map[at] ?? 0;
	const endIndex = map[at + needle.length - 1] ?? start;
	return { start, end: endIndex + 1 };
}

/** 解析模型输出；容忍 ```json 围栏与前后废话。 */
export function parseSmartSplitJson(raw: string): SmartSplitAtom[] | null {
	const text = (raw ?? "").trim();
	if (!text) return null;
	const unfenced = (() => {
		const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
		return (fenced?.[1] ?? text).trim();
	})();
	const start = unfenced.search(/[[{]/);
	const end = Math.max(unfenced.lastIndexOf("]"), unfenced.lastIndexOf("}"));
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(unfenced.slice(start, end + 1));
	} catch {
		return null;
	}
	const list = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { atoms?: unknown }).atoms)
			? (parsed as { atoms: unknown[] }).atoms
			: null;
	if (!list) return null;
	const atoms: SmartSplitAtom[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const content = typeof row.content === "string" ? row.content.trim() : "";
		const quote = typeof row.quote === "string" ? row.quote.trim() : "";
		if (!content || !quote) continue;
		atoms.push({ content, quote, quoteStart: null, quoteEnd: null });
		if (atoms.length >= MAX_ATOMS) break;
	}
	return atoms;
}

/** 一次模型调用：独立请求，不读对话历史。 */
async function generateOnce(
	model: ModelRef,
	input: { system: string; user: string },
	timeoutMs: number,
): Promise<string | null> {
	const models = currentModels();
	const resolved = models.getModel(model.provider, model.modelId);
	if (!resolved) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await models.completeSimple(
			resolved,
			{
				systemPrompt: input.system,
				messages: [{ role: "user", content: input.user, timestamp: Date.now() }],
			},
			{ signal: controller.signal, maxTokens: 2000, temperature: 0 },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") return null;
		return contentText(response.content) || null;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory-split] 智能拆分调用失败: ${detail.slice(0, 200)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function maxCharsFor(kind: MemoryKind): number {
	return kind === "preference" ? MAX_PREFERENCE_ATOM_CHARS : MAX_ATOM_CHARS;
}

/** 一条记录：调模型 → 校验引文 → 得到可用原子。失败返回 error，不抛。 */
async function splitOne(
	record: MemoryRecord,
	model: ModelRef,
	deps: SmartSplitDeps,
): Promise<SmartSplitRecord> {
	const kind = record.kind;
	const limit = maxCharsFor(kind);
	const title = (record.content.split(/\r?\n/).find((line) => line.trim()) ?? record.content)
		.trim()
		.slice(0, 60);
	const base: SmartSplitRecord = {
		recordId: record.id,
		title,
		kind,
		chars: record.content.length,
		atoms: [],
		dropped: 0,
	};

	const input = record.content.slice(0, MAX_INPUT_CHARS);
	const generate =
		deps.generate ?? ((payload: { system: string; user: string }) => generateOnce(model, payload, deps.timeoutMs ?? SPLIT_TIMEOUT_MS));
	let raw: string | null;
	try {
		raw = await generate({ system: "你在把一条记忆拆成更小的原子事实。只输出 JSON。", user: `${SPLIT_PROMPT}\n\n原文：\n${input}` });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ...base, error: detail.slice(0, 200) };
	}
	if (!raw) return { ...base, error: "model_failed" };
	const parsed = parseSmartSplitJson(raw);
	if (!parsed || parsed.length === 0) return { ...base, error: "parse_failed" };

	const seen = new Set<string>();
	const atoms: SmartSplitAtom[] = [];
	let dropped = 0;
	for (const atom of parsed) {
		const content = atom.content.replace(/\s+/g, " ").trim();
		if (content.length < MIN_ATOM_CHARS || content.length > limit) {
			dropped += 1;
			continue;
		}
		const located = locateQuote(record.content, atom.quote);
		if (!located) {
			dropped += 1;
			continue;
		}
		const key = content.toLowerCase();
		if (seen.has(key)) {
			dropped += 1;
			continue;
		}
		seen.add(key);
		atoms.push({
			content,
			quote: record.content.slice(located.start, located.end).trim(),
			quoteStart: located.start,
			quoteEnd: located.end,
		});
		if (atoms.length >= MAX_ATOMS) break;
	}
	if (atoms.length === 0) return { ...base, dropped, error: "no_valid_atoms" };
	return { ...base, atoms, dropped };
}

/**
 * 智能拆分一批记录（只出候选，不落库）。
 *
 * `ids` 为空 = 用传入的候选计划（前端预览里的那些）。串行跑，避免同时打 N 个模型请求；
 * 单条失败只记在该条的 `error` 上，不影响其它条。
 */
export async function runSmartSplit(
	engine: MemoryEngine,
	plans: SplitPlanItem[],
	options: { ids?: string[]; model?: { provider: string; modelId: string } | null; deps?: SmartSplitDeps } = {},
): Promise<SmartSplitResult> {
	const deps = options.deps ?? {};
	const model = deps.model !== undefined ? deps.model : resolveSplitModel(options.model ?? null);
	if (!model) {
		return { ok: false, model: null, records: [], calls: 0, error: "model_unavailable" };
	}
	const selected = options.ids === undefined ? null : new Set(options.ids.filter(Boolean));
	const targets = plans.filter((plan) => (selected ? selected.has(plan.recordId) : true));
	if (targets.length === 0) {
		return { ok: true, model: `${model.provider}/${model.modelId}`, records: [], calls: 0 };
	}
	if (targets.length > MAX_SMART_SPLIT_RECORDS) {
		return {
			ok: false,
			model: `${model.provider}/${model.modelId}`,
			records: [],
			calls: 0,
			error: `too_many_records:${MAX_SMART_SPLIT_RECORDS}`,
		};
	}

	const records: SmartSplitRecord[] = [];
	let calls = 0;
	for (const plan of targets) {
		const record = engine.getRecord(plan.recordId);
		if (!record || record.archivedAt) continue;
		calls += 1;
		const startedAt = Date.now();
		const result = await splitOne(record, model, deps);
		console.log(
			`[memory-split] 智能拆分 ${record.id.slice(0, 8)} 原子=${result.atoms.length} 丢弃=${result.dropped}${result.error ? ` 失败=${result.error}` : ""} ${Date.now() - startedAt}ms`,
		);
		records.push(result);
	}
	return { ok: true, model: `${model.provider}/${model.modelId}`, records, calls };
}

/**
 * 应用智能拆分：把通过的原子按"代码拆分"同一套落点写库
 * （原文进 `memory_documents`、原子带 `docId + quote`、原记录归档）。
 *
 * 只接受**已确认**的记录：`records` 里每条都必须是本次预览回来的（含 atoms）。
 * 引文再校验一次（防前端篡改）；失效的原子丢掉；一条都不剩的记录跳过。
 */
export function applySmartSplit(
	engine: MemoryEngine,
	plans: SplitPlanItem[],
	records: SmartSplitRecord[],
): { documents: number; atoms: number; archived: number; skipped: number; failed: number } {
	const planById = new Map(plans.map((plan) => [plan.recordId, plan]));
	const confirmed: SplitPreview = { scope: "", scanned: 0, unmatched: 0, candidates: [], plans: [] };
	for (const record of records) {
		const plan = planById.get(record.recordId);
		if (!plan) continue;
		const source = engine.getRecord(record.recordId);
		if (!source || source.archivedAt) continue;
		const limit = maxCharsFor(record.kind);
		const atoms = record.atoms
			.map((atom) => {
				const located = locateQuote(source.content, atom.quote);
				if (!located) return null;
				const content = atom.content.replace(/\s+/g, " ").trim();
				if (content.length < MIN_ATOM_CHARS || content.length > limit) return null;
				return {
					content,
					quote: source.content.slice(located.start, located.end).trim(),
					quoteStart: located.start,
					quoteEnd: located.end,
					kind: record.kind,
					importance: source.importance,
				};
			})
			.filter((atom): atom is NonNullable<typeof atom> => Boolean(atom));
		if (atoms.length === 0) continue;
		confirmed.plans.push({ ...plan, atoms });
	}
	return applySplitPlan(engine, confirmed);
}
