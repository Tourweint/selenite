/**
 * 长记忆拆分（2026-11-16 记忆原子化）：
 *
 * 一条记忆里塞了太多事（导入的项目 changelog 最典型），把它拆成几条原子事实，
 * 原文完整保留在 `memory_documents`，原子记录带 `docId + quote` 回指。
 *
 * 两条路：
 *   - **有源文件**（ZCode 记忆目录）：用 frontmatter 的 `description` 当原子；
 *     正文（含 Why / How）进原文档案。description 仍太长时按分句拆。
 *   - **没有源文件**：把记录自己的正文按句/标点拆成短句，原文档案 = 原记录正文。
 *     这条是兜底，不假装有外部出处。
 *
 * 口径：
 *   - 只处理 >= `MIN_SPLIT_CHARS`（200 字）的 fact / episode / preference / entity；
 *   - work / impression 是结构化台账，不拆；
 *   - 已归档 / 已有 `docId` 的记录跳过（幂等）；
 *   - 不删除任何东西：原记录 archive，原文进文档；失败只计数，不落半截。
 *
 * 日志 / 接口只回条数与样例摘要，不回正文（D8）。
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { MemoryEngine, MemoryKind, MemoryRecord } from "@lifediary/memory";
import { stripFrontmatter } from "./memory-frontmatter.ts";

/** 进入拆分的正文下限（低于它的短记忆本来就是原子的）。 */
export const MIN_SPLIT_CHARS = 200;
/** 单条原子正文上限（fact / episode / entity）。 */
const MAX_ATOM_CHARS = 200;
/** preference 的原子上限：保留 Why / How 时放宽（与抽取层的 MAX_PREFERENCE_CHARS 同档）。 */
const MAX_PREFERENCE_ATOM_CHARS = 400;
/** description 单独成原子时的目标上限；超过它按分句拆。 */
const MAX_DESCRIPTION_ATOM_CHARS = 160;
/** 碎片合并门槛：太短的片段并进上一条，避免「对。」这种原子。 */
const MIN_ATOM_CHARS = 12;
/** 一份原文一次最多产多少原子；多余的留在原文档案里。 */
const MAX_ATOMS_PER_DOC = 20;

const SPLIT_KINDS: ReadonlySet<MemoryKind> = new Set(["fact", "episode", "preference", "entity"]);

/** 拆分开关：`MEMORY_SPLIT=false` / `0` / `off` 时端点 404。 */
export function memorySplitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = (env.MEMORY_SPLIT ?? "").trim().toLowerCase();
	return value !== "false" && value !== "0" && value !== "off";
}

export interface SplitAtomDraft {
	content: string;
	quote: string;
	quoteStart: number | null;
	quoteEnd: number | null;
	kind: MemoryKind;
	importance: number;
}

export interface SplitPlanItem {
	recordId: string;
	scope: string;
	doc: {
		title: string;
		content: string;
		source: string;
		sourceRef: string | null;
		sha256: string | null;
		createdAt: string;
	};
	atoms: SplitAtomDraft[];
	/** true = 没找到源文件，用记录正文自己拆的兜底 */
	fallback: boolean;
}

export interface SplitCandidate {
	id: string;
	kind: MemoryKind;
	chars: number;
	title: string;
	source: string;
	fallback: boolean;
	atomCount: number;
	/** 前端预览用（最多 3 条），不是完整原子列表 */
	samples: string[];
}

export interface SplitPreview {
	scope: string;
	scanned: number;
	unmatched: number;
	candidates: SplitCandidate[];
	/** 内部用：apply 时按这份计划落库，不从 HTTP 回传全文 */
	plans: SplitPlanItem[];
}

export interface SplitApplyResult {
	documents: number;
	atoms: number;
	archived: number;
	skipped: number;
	failed: number;
}

interface SourceDoc {
	file: string;
	raw: string;
	body: string;
	description: string;
	name: string;
	metaType: string;
	bodyNorm: string;
	rawNorm: string;
}

let sourceCache: { at: number; docs: SourceDoc[] } | null = null;
const SOURCE_CACHE_MS = 60_000;

function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

/** 导入时项目级条目可能带 `【项目名】` 前缀；匹配源文件时剥掉。 */
function stripProjectPrefix(text: string): string {
	return text.replace(/^【[^】]{1,40}】\s*/, "");
}

/** 扫 ZCode 各项目的记忆文件；`MEMORY.md` 是索引，不收。 */
function collectZcodeSources(): SourceDoc[] {
	const root = join(homedir(), ".zcode", "cli", "memories", "projects");
	if (!existsSync(root)) return [];
	const docs: SourceDoc[] = [];
	let projects: string[] = [];
	try {
		projects = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	for (const project of projects) {
		const dir = join(root, project, "memory");
		if (!existsSync(dir)) continue;
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "MEMORY.md");
		} catch {
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				const stat = statSync(path);
				if (!stat.isFile() || stat.size === 0 || stat.size > 2 * 1024 * 1024) continue;
				const raw = readFileSync(path, "utf8");
				const { meta, body } = stripFrontmatter(raw);
				docs.push({
					file: path,
					raw,
					body,
					description: (meta["description"] ?? "").trim(),
					name: (meta["name"] ?? "").trim() || basename(file, ".md"),
					metaType: (meta["metadata.type"] ?? meta["type"] ?? "").trim().toLowerCase(),
					bodyNorm: normalizeText(body),
					rawNorm: normalizeText(raw),
				});
			} catch {
				// 单个坏文件不影响整批
			}
		}
	}
	return docs;
}

function getSourceDocs(): SourceDoc[] {
	const now = Date.now();
	if (sourceCache && now - sourceCache.at < SOURCE_CACHE_MS) return sourceCache.docs;
	const docs = collectZcodeSources();
	sourceCache = { at: now, docs };
	return docs;
}

/** 找这条记录对应的源文件：先精确匹配正文，再用前 120 字做唯一前缀匹配。 */
function findSourceDoc(record: MemoryRecord): SourceDoc | null {
	if (!record.source.startsWith("import:zcode")) return null;
	const content = normalizeText(stripProjectPrefix(record.content));
	if (!content) return null;
	const docs = getSourceDocs();
	for (const doc of docs) {
		if (doc.bodyNorm === content) return doc;
	}
	for (const doc of docs) {
		if (doc.rawNorm === content) return doc;
	}
	const head = content.slice(0, 120);
	if (head.length >= 60) {
		const hits = docs.filter((doc) => doc.bodyNorm.startsWith(head) || doc.bodyNorm.includes(head));
		if (hits.length === 1) return hits[0];
	}
	return null;
}

interface Span {
	start: number;
	end: number;
}

/** 按句号 / 问号 / 感叹号 / 分号 / 换行切 span，保留原文偏移。 */
function sentenceSpans(raw: string): Span[] {
	const spans: Span[] = [];
	const re = /[^。！？；;\n]+(?:[。！？；;]|\n|$)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(raw))) {
		const text = match[0];
		if (!text) {
			re.lastIndex += 1;
			continue;
		}
		const start = match.index;
		const end = start + text.length;
		if (raw.slice(start, end).trim()) spans.push({ start, end });
	}
	return spans;
}

/**
 * 把超长 span 切到 maxChars 以内。
 *
 * 默认**不按逗号切**（2026-11-16 实测：英文段落按逗号切会产出
 * 「order domain,」「delivery tasks,」这种碎片）。中文没有空格，按字数硬切；
 * 英文优先在最后一个空格处断开，别把单词劈两半。
 */
function splitLongSpan(raw: string, span: Span, maxChars: number): Span[] {
	if (span.end - span.start <= maxChars) return [span];
	const out: Span[] = [];
	let at = span.start;
	while (at < span.end) {
		let end = Math.min(span.end, at + maxChars);
		if (end < span.end) {
			const window = raw.slice(at, end);
			const space = window.lastIndexOf(" ");
			// 只在后半段找空格，避免为了一个空格切出很短的片。
			if (space > Math.floor(maxChars * 0.6)) end = at + space + 1;
		}
		out.push({ start: at, end });
		at = end;
	}
	return out;
}

/** 合并碎片；每条原子不超过 maxChars，最多 MAX_ATOMS_PER_DOC 条。 */
function spansToAtoms(raw: string, spans: Span[], maxChars: number): Span[] {
	const expanded = spans.flatMap((span) => splitLongSpan(raw, span, maxChars));
	const merged: Span[] = [];
	for (const span of expanded) {
		const length = raw.slice(span.start, span.end).trim().length;
		if (length === 0) continue;
		const prev = merged[merged.length - 1];
		if (prev && length < MIN_ATOM_CHARS) {
			const combined = raw.slice(prev.start, span.end).trim().length;
			if (combined <= maxChars) {
				prev.end = span.end;
				continue;
			}
		}
		merged.push({ ...span });
	}
	// 第一条太短也并进下一条（避免「背景。」单独成条）
	if (merged.length > 1 && raw.slice(merged[0].start, merged[0].end).trim().length < MIN_ATOM_CHARS) {
		const first = merged.shift()!;
		merged[0] = { start: first.start, end: merged[0].end };
	}
	return merged.slice(0, MAX_ATOMS_PER_DOC);
}

function atomKindOf(record: MemoryRecord): MemoryKind {
	return SPLIT_KINDS.has(record.kind) ? record.kind : "fact";
}

function maxCharsFor(kind: MemoryKind): number {
	return kind === "preference" ? MAX_PREFERENCE_ATOM_CHARS : MAX_ATOM_CHARS;
}

/** 从记录正文兜底拆分：原文档案就是这条记录本身。 */
function planFromContent(record: MemoryRecord): SplitPlanItem {
	const raw = record.content;
	const kind = atomKindOf(record);
	const spans = spansToAtoms(raw, sentenceSpans(raw), maxCharsFor(kind));
	const atoms: SplitAtomDraft[] = [];
	for (const span of spans) {
		const quote = raw.slice(span.start, span.end).trim();
		const content = quote.replace(/^[-*]\s+/, "").trim();
		if (!content) continue;
		atoms.push({
			content,
			quote,
			quoteStart: span.start,
			quoteEnd: span.end,
			kind,
			importance: record.importance,
		});
	}
	const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? raw;
	return {
		recordId: record.id,
		scope: record.scope,
		doc: {
			title: firstLine.trim().slice(0, 60) || "未命名原文",
			content: raw,
			source: record.source,
			sourceRef: null,
			sha256: createHash("sha256").update(raw).digest("hex"),
			createdAt: record.createdAt,
		},
		atoms,
		fallback: true,
	};
}

/** description 只有「2026-11-11」这种日期时不能当记忆；太短也一样。 */
function usableDescription(description: string): boolean {
	const text = description.trim();
	if (text.length < 20) return false;
	return !/^[\d\s年月日\-—:：./]+$/u.test(text);
}

/** 从源文件的 description 拆分；description 不可用时取正文前几句。 */
function planFromSource(record: MemoryRecord, source: SourceDoc): SplitPlanItem {
	const description = source.description;
	const kind = atomKindOf(record);
	const base = source.raw;
	const useDescription = usableDescription(description);
	const summary = useDescription ? description : source.body;
	const summaryStart = useDescription
		? base.indexOf(description)
		: Math.max(0, base.indexOf(source.body));

	const spans = spansToAtoms(summary, sentenceSpans(summary), Math.max(MAX_DESCRIPTION_ATOM_CHARS, maxCharsFor(kind)));
	// 正文兜底只取前 3 段：它只是给这份原文一个可召回的入口，不是把正文全抄成记忆。
	const picked = useDescription ? spans : spans.slice(0, 3);
	const atoms: SplitAtomDraft[] = [];
	for (const span of picked) {
		const quote = summary.slice(span.start, span.end).trim();
		if (!quote) continue;
		atoms.push({
			content: quote.replace(/^[-*]\s+/, "").trim(),
			quote,
			quoteStart: summaryStart >= 0 ? summaryStart + span.start : null,
			quoteEnd: summaryStart >= 0 ? summaryStart + span.end : null,
			kind,
			importance: record.importance,
		});
	}

	// 偏好 / 经验：把 Why / How 并进第一条原子（正文仍在原文档案里）。
	if ((kind === "preference" || source.metaType === "feedback") && atoms.length > 0) {
		const why = /^\*\*Why:?\*\*\s*([\s\S]*?)(?=^\*\*|$)/im.exec(source.body)?.[1]?.trim() ?? "";
		const how =
			/^\*\*How to apply:?\*\*\s*([\s\S]*?)(?=^\*\*|$)/im.exec(source.body)?.[1]?.trim() ?? "";
		const extra = [why ? `Why: ${normalizeText(why)}` : "", how ? `How: ${normalizeText(how)}` : ""]
			.filter(Boolean)
			.join("\n");
		if (extra && atoms[0].content.length + extra.length + 1 <= MAX_PREFERENCE_ATOM_CHARS) {
			atoms[0] = { ...atoms[0], content: `${atoms[0].content}\n${extra}` };
		}
	}

	return {
		recordId: record.id,
		scope: record.scope,
		doc: {
			title: source.name || basename(source.file, ".md"),
			content: source.raw,
			source: record.source,
			sourceRef: source.file,
			sha256: createHash("sha256").update(source.raw).digest("hex"),
			createdAt: record.createdAt,
		},
		atoms,
		fallback: false,
	};
}

/**
 * 生成拆分计划。默认扫描整个 scope，只挑 >=200 字、尚未归档/拆过的记录。
 * `ids` 给了就只算这几条（前端勾选后预览/应用）。
 */
export function buildSplitPlan(
	engine: MemoryEngine,
	scope: string,
	options: { ids?: string[]; minChars?: number } = {},
): SplitPreview {
	const minChars = Math.max(1, Math.floor(options.minChars ?? MIN_SPLIT_CHARS));
	const hasSelection = options.ids !== undefined;
	const selected = new Set((options.ids ?? []).filter(Boolean));
	const records = engine.list({ scopes: [scope], limit: 2000 });
	const plans: SplitPlanItem[] = [];
	let unmatched = 0;
	for (const record of records) {
		if (hasSelection && !selected.has(record.id)) continue;
		if (record.archivedAt || record.docId) continue;
		if (!SPLIT_KINDS.has(record.kind)) continue;
		if (record.content.length < minChars) continue;
		const source = findSourceDoc(record);
		const plan = source ? planFromSource(record, source) : planFromContent(record);
		if (plan.atoms.length === 0) continue;
		if (plan.fallback) unmatched += 1;
		plans.push(plan);
	}
	const candidates: SplitCandidate[] = plans.map((plan) => ({
		id: plan.recordId,
		kind: plan.atoms[0]?.kind ?? "fact",
		chars: plan.doc.content.length,
		title: plan.doc.title,
		source: plan.doc.source,
		fallback: plan.fallback,
		atomCount: plan.atoms.length,
		samples: plan.atoms.slice(0, 3).map((atom) => atom.content.replace(/\s+/g, " ").slice(0, 120)),
	}));
	return { scope, scanned: records.length, unmatched, candidates, plans };
}

/**
 * 应用拆分计划：每份原文写一条 document，原子走 import 管线（同一套打码 / 去重），
 * 原记录 archive。按记录独立失败，不因为一条坏数据中断整批。
 */
export function applySplitPlan(
	engine: MemoryEngine,
	preview: SplitPreview,
	options: { ids?: string[] } = {},
): SplitApplyResult {
	const selected = new Set(
		options.ids !== undefined
			? options.ids.filter(Boolean)
			: preview.plans.map((plan) => plan.recordId),
	);
	let documents = 0;
	let atoms = 0;
	let archived = 0;
	let skipped = 0;
	let failed = 0;
	for (const plan of preview.plans) {
		if (!selected.has(plan.recordId)) continue;
		const record = engine.getRecord(plan.recordId);
		if (!record || record.archivedAt) {
			skipped += 1;
			continue;
		}
		try {
			const docId = crypto.randomUUID();
			engine.putDocument({
				id: docId,
				scope: plan.scope,
				title: plan.doc.title,
				content: plan.doc.content,
				source: plan.doc.source,
				sourceRef: plan.doc.sourceRef,
				sha256: plan.doc.sha256,
				chars: plan.doc.content.length,
				createdAt: plan.doc.createdAt,
				updatedAt: null,
			});
			const outcome = engine.importItemsToScope(
				plan.scope,
				plan.atoms.map((atom) => ({
					text: atom.content,
					kind: atom.kind,
					createdAt: plan.doc.createdAt,
					importance: atom.importance,
					source: plan.doc.source,
					docId,
					quote: atom.quote,
					quoteStart: atom.quoteStart ?? undefined,
					quoteEnd: atom.quoteEnd ?? undefined,
				})),
				{ now: new Date(plan.doc.createdAt) },
			);
			engine.archive(plan.recordId, docId);
			documents += 1;
			atoms += outcome.added.length;
			skipped += outcome.skipped;
			archived += 1;
		} catch {
			failed += 1;
		}
	}
	return { documents, atoms, archived, skipped, failed };
}
