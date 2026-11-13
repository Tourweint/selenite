/**
 * 模型辅助巩固 + 已存记忆导入的**装配层**（2026-11-08 扫尾批 6 §二/§三）。
 *
 * 分工照 `memory-extract.ts` 的先例：
 * - `@lifediary/memory` 只管"规范化去重 / 只增不改地入库"这些纯规则；
 * - 这里负责"用哪个模型、超时多久、失败怎么说、建议落到哪"。
 *
 * **D18 底线（不可动摇）**：自动化只做强化 / 衰减 / 确定性同义收敛。
 * 本模块的模型调用**只产出建议**——一条都不执行；执行必须由人在设置页逐条点"应用"，
 * 走既有 `supersede()`（旧记录保留可追溯）。没有"全部应用"。
 *
 * 红线（AGENTS.md）：日志只记条数 / 字数 / 耗时 / 枚举；正文不进日志，
 * 原始错误只留摘要（可能带上游地址）。
 */
import { contentText } from "@earendil-works/pi-ai";
import { redactSecrets, type MemoryRecord, type MemoryScope } from "@lifediary/memory";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findEvidence, memoryEngine, supersedeMemory, type EvidenceHit } from "./agent.ts";
import { auxiliaryModel } from "./auxiliary.ts";
import { currentModels, isFaux, readLlmConfig } from "./provider.ts";

// ── 开关 ────────────────────────────────────────────────

/**
 * `MEMORY_CONSOLIDATE_LLM`（2026-11-08，回滚开关）：`false` / `0` = 整理记忆整套不挂
 * （两个端点 404、设置页按钮不渲染）。默认开。
 */
export function consolidateLlmEnabled(): boolean {
	return !isOff(process.env.MEMORY_CONSOLIDATE_LLM);
}

/**
 * `MEMORY_CONSOLIDATE_JOB`（2026-11-13，回滚开关）：默认开。
 *
 * 开 = `POST review?background=1` 立即 202、后台跑，`GET consolidate/state` 可恢复；
 * 关 = 即使带 `background=1` 也回到同步等待（旧界面/旧探针逐字节兼容）。
 */
export function consolidateJobEnabled(): boolean {
	return !isOff(process.env.MEMORY_CONSOLIDATE_JOB);
}

/**
 * `MEMORY_IMPORT`（2026-11-08，回滚开关）：`false` / `0` = 导入端点 404、按钮隐藏。默认开。
 */
export function memoryImportEnabled(): boolean {
	return !isOff(process.env.MEMORY_IMPORT);
}

/**
 * `MEMORY_REVIEW_EVIDENCE`（2026-11-10，回滚开关）：`false` / `0` = 整理建议不回原始
 * 对话找证据引文（响应里没有 `evidence` 字段，前端不渲染引文块）。默认开。
 */
export function reviewEvidenceEnabled(): boolean {
	return !isOff(process.env.MEMORY_REVIEW_EVIDENCE);
}

function isOff(raw: string | undefined): boolean {
	const value = (raw ?? "").trim().toLowerCase();
	return value === "false" || value === "0" || value === "off";
}

// ── 作用域 ──────────────────────────────────────────────

/**
 * 这两个新端点只认"人的记忆库"：`global` 与各执事的 `partner:<id>`。
 * `session:` / `day:` / `topic:` 是对话沉淀与专题，不属于"我的记忆"这个管理面。
 */
export function validTargetScope(scope: string): boolean {
	return scope === "global" || /^partner:[A-Za-z0-9._~%-]{1,80}$/.test(scope);
}

function scopeOf(scope: string): MemoryScope | null {
	if (scope === "global") return { type: "global" };
	const match = /^partner:(.+)$/.exec(scope);
	return match ? { type: "partner", id: match[1]! } : null;
}

// ── 建议的数据形状 ──────────────────────────────────────

export const MAX_REVIEW_RECORDS = 200;
export const MAX_PROPOSALS = 50;

export interface ProposalSide {
	id: string;
	kind: string;
	content: string;
	importance: number;
	createdAt: string;
}

export interface ConsolidateProposal {
	keepId: string;
	dropId: string;
	reason: string;
	/** 两端正文随建议一起返回：前端不必再从列表里反查（列表可能只取了前 300 条） */
	keep: ProposalSide;
	drop: ProposalSide;
	/**
	 * 证据引文（2026-11-10 对标 Anthropic「做梦」§一）：drop 端正文在**原始对话**里的
	 * 命中片段，人拍板前可核对"这条记忆当初真是这么说的吗"。
	 * 开关开着时恒有值（查不到 = null，不挡应用）；`MEMORY_REVIEW_EVIDENCE=false`
	 * 时整个字段不下发（undefined，JSON 序列化自动丢弃）。
	 */
	evidence?: ProposalEvidence | null;
}

/** 证据引文命中的一条（形状照跨会话搜索 `EvidenceHit`，去掉 title 之类卡片用不上的）。 */
export type ProposalEvidence = EvidenceHit;

/** 证据查找函数的形状（测试/探针注入假实现；默认 = 真扫跨会话记录）。 */
export type EvidenceFinder = (
	needles: string[],
) => Promise<Map<string, EvidenceHit>>;

export interface ProposalDraft {
	keepId: string;
	dropId: string;
	reason: string;
}

// ── 模型调用 ────────────────────────────────────────────

/** 单次整理调用的超时。建议制是"人点了等结果"，宁可报错也不无限挂着。 */
const REVIEW_TIMEOUT_MS = 30_000;
/** 单条正文喂给模型的上限：建议是找重复，长尾巴对判断没帮助，还会挤占预算。 */
const REVIEW_CONTENT_CHARS = 300;

export type ReviewGenerator = (input: {
	system: string;
	user: string;
}) => Promise<string | null>;

/**
 * 默认实现：一次独立模型调用（不进主会话、不留半截会话），照偏好抽取的范式。
 *
 * 模型走 `auxiliaryModel("review")`（2026-11-10 批 23b §三）：`AUX_MODEL_REVIEW` 可以给
 * "找重复 / 编建议"这活单独 pin 一个模型；没配 / `AUX_LLM=false` 时回落当前会话模型。
 */
async function generateReview(input: { system: string; user: string }): Promise<string | null> {
	const config = readLlmConfig();
	if (!config) return null;
	// faux 是"真实 durable 链路 + 假模型"：拿它的输出当建议只会是假文本，视为没有模型。
	if (isFaux()) return null;

	const ref = auxiliaryModel("review", { current: config.model }) ?? config.model;
	const models = currentModels();
	const model = models.getModel(ref.provider, ref.modelId);
	if (!model) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
	try {
		const response = await models.completeSimple(
			model,
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
		// 只有错误摘要，没有正文
		console.warn(`[memory] 整理建议调用失败: ${detail.slice(0, 200)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** 当前会不会真的发模型调用（faux / 未配置都算"没有模型"）。 */
export function reviewModelAvailable(): boolean {
	return Boolean(readLlmConfig()) && !isFaux();
}

// ── 提示词与解析 ────────────────────────────────────────

/**
 * 提示词。三处刻意写死：
 * 1. **"只建议、不执行"**——模型不该以为自己在改库；
 * 2. **id 必须来自清单**——模型编 id 是最常见的坏输出，解析后还会再按清单复核一遍；
 * 3. **没有就输出空数组**——避免模型为了凑数硬配。
 */
export const CONSOLIDATE_PROMPT = [
	"你在检查一个人的长期记忆库，找出**说的是同一件事、且其中一条明显更完整或更新**的条目对。",
	"",
	"你**只给建议，不执行任何修改**：系统会把你的建议逐条给人看，由人决定要不要收编。",
	"",
	"规则：",
	`1. 最多 ${MAX_PROPOSALS} 条建议；没有就输出 {"proposals":[]}。`,
	"2. keepId 是应当保留的那条；dropId 是应被收编（标为过时）的那条。",
	"3. keepId / dropId 必须**原样来自下面的清单**，不许编造 id；两者不能相同。",
	"4. 只有在语义确实重复或后者是前者的更正时才提；措辞接近但讲的是不同事情，不要提。",
	"5. reason 用一句话说明为什么，不要复述原文。",
	"",
	'输出严格的 JSON：{"proposals":[{"keepId":"…","dropId":"…","reason":"…"}]}',
	"只输出 JSON，不要解释，不要 markdown 围栏。",
].join("\n");

/** 把一次整理的输入记录渲染成模型可读的清单。 */
export function renderReviewInput(records: MemoryRecord[]): string {
	return records
		.map((record) => {
			const text = record.content.replace(/\s+/g, " ").trim().slice(0, REVIEW_CONTENT_CHARS);
			return `- id=${record.id} [${record.kind}] ${text}`;
		})
		.join("\n");
}

/**
 * 解析模型输出。**返回 null = 解析失败**（调用方如实 5xx），
 * 返回 `[]` = 模型明确说"没有可整理的"——两者不能混。
 *
 * 容忍围栏与前后解释（与 `parsePreferenceJson` 同一套办法），
 * 但不容忍字段缺失：认不出的条目直接丢。
 */
export function parseProposalJson(raw: string): ProposalDraft[] | null {
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
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { proposals?: unknown }).proposals)
			? (parsed as { proposals: unknown[] }).proposals
			: null;
	if (!list) return null;

	const drafts: ProposalDraft[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const keepId = typeof row.keepId === "string" ? row.keepId.trim() : "";
		const dropId = typeof row.dropId === "string" ? row.dropId.trim() : "";
		if (!keepId || !dropId || keepId === dropId) continue;
		drafts.push({
			keepId,
			dropId,
			reason: typeof row.reason === "string" ? row.reason.trim().slice(0, 200) : "",
		});
		if (drafts.length >= MAX_PROPOSALS) break;
	}
	return drafts;
}

// ── 待决建议的落点 ──────────────────────────────────────

interface PendingEntry {
	generatedAt: string;
	proposals: ConsolidateProposal[];
}

type PendingFile = Record<string, PendingEntry>;

/** 建议落点：`.data/memory-proposals.json`（按 scope 存），可用 `MEMORY_PROPOSALS_PATH` 覆盖。 */
function proposalsPath(): string {
	return process.env.MEMORY_PROPOSALS_PATH?.trim() || ".data/memory-proposals.json";
}

function readPending(path: string): PendingFile {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: PendingFile = {};
		for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
			const entry = value as Partial<PendingEntry> | null;
			if (!entry || !Array.isArray(entry.proposals)) continue;
			out[scope] = {
				generatedAt: typeof entry.generatedAt === "string" ? entry.generatedAt : "",
				proposals: entry.proposals.filter((item): item is ConsolidateProposal => {
					const row = item as unknown as Record<string, unknown> | null;
					return Boolean(row && typeof row.keepId === "string" && typeof row.dropId === "string");
				}),
			};
		}
		return out;
	} catch {
		// 文件不存在 / 坏 JSON 都当空账：建议是易失的，不值得为它挡住请求。
		return {};
	}
}

function writePending(path: string, data: PendingFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	try {
		renameSync(tmp, path);
	} catch {
		rmSync(tmp, { force: true });
	}
}

// ── 整理：出建议 ────────────────────────────────────────

export type ReviewResult =
	| {
			ok: true;
			scope: string;
			total: number;
			generatedAt: string;
			proposals: ConsolidateProposal[];
	  }
	| { ok: false; status: number; error: string; message: string };

function sideOf(record: MemoryRecord): ProposalSide {
	return {
		id: record.id,
		kind: record.kind,
		content: record.content,
		importance: record.importance,
		createdAt: record.createdAt,
	};
}

/**
 * 按 scope 取最近 ≤200 条（不含已被取代的），让模型只找"重复 / 更正"。
 *
 * 失败口径（"如实 5xx 不假装"）：
 * - 没有可用模型 → 503 `llm_not_configured`
 * - 调用失败 / 超时 / 输出解析不了 → 502 `llm_failed`
 * - 建议里的 id 对不上清单 → 丢掉那一条（其余照常返回），不报错
 */
export async function reviewScope(
	scope: string,
	options: { generate?: ReviewGenerator; findEvidence?: EvidenceFinder } = {},
): Promise<ReviewResult> {
	if (!memoryEngine) {
		return { ok: false, status: 404, error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" };
	}
	if (!validTargetScope(scope)) {
		return { ok: false, status: 400, error: "bad_request", message: "scope 只能是 global 或 partner:<id>" };
	}

	// work 是 append-only 履历台账（2026-11-08 刀二 E2）：语义去重不作用于履历，
	// 同正文的不同单是两条历史，合并=篡改。整理建议的输入里直接剔除。
	const records = memoryEngine
		.list({ scopes: [scope], limit: MAX_REVIEW_RECORDS })
		.filter((record) => record.kind !== "work");
	const generatedAt = new Date().toISOString();
	if (records.length < 2) {
		// 一条（或零条）记忆没有"重复"可谈：不打这一枪模型，也不写待决文件。
		return { ok: true, scope, total: records.length, generatedAt, proposals: [] };
	}

	const generate = options.generate ?? (reviewModelAvailable() ? generateReview : null);
	if (!generate) {
		return {
			ok: false,
			status: 503,
			error: "llm_not_configured",
			message: "当前没有可用模型（未配置 LLM_API_KEY 或 LLM_PROVIDER=faux）",
		};
	}

	const started = Date.now();
	let raw: string | null = null;
	try {
		raw = await generate({ system: CONSOLIDATE_PROMPT, user: renderReviewInput(records) });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 整理建议调用异常: ${detail.slice(0, 200)}`);
		raw = null;
	}
	if (!raw) {
		return { ok: false, status: 502, error: "llm_failed", message: "模型调用失败或超时，请稍后重试" };
	}

	const drafts = parseProposalJson(raw);
	if (!drafts) {
		return { ok: false, status: 502, error: "llm_failed", message: "模型输出不是可解析的建议 JSON" };
	}

	// 按清单复核 id：模型编造的 id 一律丢掉（宁可少建议，不可指向不存在的记录）。
	const byId = new Map(records.map((record) => [record.id, record]));
	const seen = new Set<string>();
	const proposals: ConsolidateProposal[] = [];
	for (const draft of drafts) {
		const keep = byId.get(draft.keepId);
		const drop = byId.get(draft.dropId);
		if (!keep || !drop || keep.id === drop.id) continue;
		const key = `${keep.id}\u0000${drop.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		proposals.push({
			keepId: keep.id,
			dropId: drop.id,
			reason: draft.reason,
			keep: sideOf(keep),
			drop: sideOf(drop),
		});
	}

	// 证据引文（2026-11-10 对标 Anthropic「做梦」§一）：给每条建议的 drop 端回原始
	// 对话找出处，人拍板前可核对"这条记忆当初真是这么说的吗"。
	// 查不到 = null（不挡应用）；查找失败同样降级为 null——证据缺着比建议发不出去强。
	// 开关关着时不设置该字段（undefined，JSON 序列化自动丢弃，前端不渲染引文块）。
	if (reviewEvidenceEnabled() && proposals.length > 0) {
		const lookup = options.findEvidence ?? findEvidence;
		let hits: Map<string, EvidenceHit>;
		try {
			hits = await lookup(proposals.map((proposal) => proposal.drop.content));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[memory] 证据引文查找失败: ${detail.slice(0, 200)}`);
			hits = new Map();
		}
		for (const proposal of proposals) {
			const hit = hits.get(proposal.drop.content);
			// 引文过一遍凭据打码：与记忆正文同一政策——原文片段可能带 sk-…/key=…，
			// 渲染或转存都不该带（P2-1，验收 2026-11-10）。
			proposal.evidence = hit ? { ...hit, text: redactSecrets(hit.text) } : null;
		}
	}

	const path = proposalsPath();
	const pending = readPending(path);
	// 待决文件只存 id / 理由 / 两端正文快照（接口文档 §2.15.1 口径）：evidence 只进响应，
	// 落盘等于把对话片段多存一份（P1-2，验收 2026-11-10）——写之前剥掉。
	pending[scope] = {
		generatedAt,
		proposals: proposals.map((proposal) => ({
			keepId: proposal.keepId,
			dropId: proposal.dropId,
			reason: proposal.reason,
			keep: proposal.keep,
			drop: proposal.drop,
		})),
	};
	writePending(path, pending);

	// 只记条数 / 耗时，不记正文（D8）
	console.log(
		`[memory] 整理建议 scope=${scope} 输入=${records.length} 建议=${proposals.length} 证据=${
			proposals.filter((proposal) => proposal.evidence).length
		} ${Date.now() - started}ms`,
	);

	return { ok: true, scope, total: records.length, generatedAt, proposals };
}

// ── 整理：逐条应用 ──────────────────────────────────────

export type ApplyResult =
	| { ok: true; scope: string; keepId: string; dropId: string; alreadyApplied: boolean }
	| { ok: false; status: number; error: string; message: string };

/**
 * 幂等执行一条建议：`dropId` 被 `keepId` 取代（旧记录保留，D18）。
 *
 * 幂等的定义是"重复点同一个按钮结果一样"：
 * 已经指向同一个 keepId → 200 `alreadyApplied:true`，不再写一次。
 * 指向别的记录 → 400（这是另一个判断，不该被这条覆盖）。
 */
export function applyProposal(scope: string, keepId: string, dropId: string): ApplyResult {
	if (!memoryEngine) {
		return { ok: false, status: 404, error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" };
	}
	if (!validTargetScope(scope)) {
		return { ok: false, status: 400, error: "bad_request", message: "scope 只能是 global 或 partner:<id>" };
	}
	if (!keepId || !dropId || keepId === dropId) {
		return { ok: false, status: 400, error: "bad_request", message: "需要两个不同的记忆 id" };
	}

	const keep = memoryEngine.getRecord(keepId);
	const drop = memoryEngine.getRecord(dropId);
	if (!keep || !drop || keep.scope !== scope || drop.scope !== scope) {
		return { ok: false, status: 404, error: "not_found", message: "记忆不存在，或不属于这个 scope" };
	}
	// 防御：整理建议的输入已剔除 work，但人手工把 work id 传进来也不能合并履历。
	if (keep.kind === "work" || drop.kind === "work") {
		return { ok: false, status: 400, error: "bad_request", message: "工作履历不参与整理（append-only）" };
	}
	if (drop.supersededBy === keepId) {
		return { ok: true, scope, keepId, dropId, alreadyApplied: true };
	}
	if (drop.supersededBy) {
		return { ok: false, status: 400, error: "already_superseded", message: "这条记忆已经被别的记录取代了" };
	}
	if (keep.supersededBy) {
		return { ok: false, status: 400, error: "bad_request", message: "保留的那条已经被取代了，不能再收编别的记录" };
	}

	if (!supersedeMemory(dropId, keepId)) {
		return { ok: false, status: 404, error: "not_found", message: "记忆不存在" };
	}

	// 应用过的建议从**内存结果**里摘掉，页面不必等下一轮 state 才消失。
	forgetProposalInMemory(scope, keepId, dropId);

	// 应用过的建议从待决文件里摘掉：刷新页面再点"整理"不会重复弹同一张卡。
	// 失败不挡主流程（建议是易失的，取代已经落库）。
	try {
		const path = proposalsPath();
		const pending = readPending(path);
		const entry = pending[scope];
		if (entry) {
			entry.proposals = entry.proposals.filter(
				(item) => !(item.keepId === keepId && item.dropId === dropId),
			);
			writePending(path, pending);
		}
	} catch (error) {
		console.warn(
			`[memory] 待决建议清理失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return { ok: true, scope, keepId, dropId, alreadyApplied: false };
}

// ── 导入 ────────────────────────────────────────────────

/** 单次导入上限：再多就不是"补一份旧记忆"，而是拿错文件了。 */
export const MAX_IMPORT_ITEMS = 5000;

export type ImportResult =
	| { ok: true; scope: string; added: number; skipped: number; total: number }
	| { ok: false; status: number; error: string; message: string };

/**
 * 只增不改地导入一批记忆。逐条走 ingest 同一套校验与规范化收敛（见 `importMemories`）。
 * 返回只有条数——不把正文回显给调用方（它本来就有），也不写日志（D8）。
 */
export function importMemory(scope: string, items: unknown): ImportResult {
	if (!memoryEngine) {
		return { ok: false, status: 404, error: "memory_disabled", message: "记忆未启用（MEMORY_ENABLED=false）" };
	}
	const parsedScope = validTargetScope(scope) ? scopeOf(scope) : null;
	if (!parsedScope) {
		return { ok: false, status: 400, error: "bad_request", message: "scope 只能是 global 或 partner:<id>" };
	}
	if (!Array.isArray(items)) {
		return { ok: false, status: 400, error: "bad_request", message: "items 必须是数组" };
	}
	if (items.length > MAX_IMPORT_ITEMS) {
		return {
			ok: false,
			status: 400,
			error: "too_many_items",
			message: `单次最多导入 ${MAX_IMPORT_ITEMS} 条，请拆成多份`,
		};
	}

	const entries = items.map((item) => {
		const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		return {
			text: typeof row.text === "string" ? row.text : "",
			...(typeof row.kind === "string" ? { kind: row.kind } : {}),
			...(typeof row.createdAt === "string" ? { createdAt: row.createdAt } : {}),
			...(typeof row.importance === "number" ? { importance: row.importance } : {}),
		};
	});

	const result = memoryEngine.importItems({ scope: parsedScope, items: entries });
	// 只记条数（D8）
	console.log(
		`[memory] 导入 scope=${scope} 新增=${result.added.length} 跳过=${result.skipped} 共=${result.total}`,
	);
	return {
		ok: true,
		scope,
		added: result.added.length,
		skipped: result.skipped,
		total: result.total,
	};
}

/** 给探针/测试：当前 scope 的待决建议条数（不返回正文）。 */
export function pendingProposalCount(scope: string): number {
	return readPending(proposalsPath())[scope]?.proposals.length ?? 0;
}

/** 读某个 scope 的待决建议（2026-11-13：页面切走再回来要能看到上次结果）。 */
export function readPendingProposals(scope: string): PendingEntry | null {
	const entry = readPending(proposalsPath())[scope];
	if (!entry) return null;
	return { generatedAt: entry.generatedAt, proposals: entry.proposals };
}

// ── 整理任务（2026-11-13，A 版记忆页）────────────────────
//
// 为什么要有这一层：整理是一次最长 30s 的模型调用 + 证据扫描。旧实现把结果写进
// 当时的 DOM，切页/刷新就丢；再点一次就是第二发模型调用。现在：
//   - 同一 scope 单飞（activeReviews），并发点只返回"已在跑"；
//   - 完成结果留在内存（lastResults，含 evidence），GET state 可读；
//   - 进程重启后回落到 `.data/memory-proposals.json`（无 evidence，符合"引文不落盘"）。

interface ActiveReview {
	startedAt: string;
	promise: Promise<ReviewResult>;
}

interface LastReview {
	generatedAt: string;
	proposals: ConsolidateProposal[];
}

export interface ReviewState {
	scope: string;
	running: boolean;
	startedAt: string | null;
	generatedAt: string | null;
	proposals: ConsolidateProposal[];
	/** live = 本次进程结果（含 evidence）；pending = 从待决文件读回（无 evidence）；none = 没有。 */
	source: "live" | "pending" | "none";
	error: { at: string; error: string; message: string } | null;
}

const activeReviews = new Map<string, ActiveReview>();
const lastResults = new Map<string, LastReview>();
const lastErrors = new Map<string, { at: string; error: string; message: string }>();

function forgetProposalInMemory(scope: string, keepId: string, dropId: string): boolean {
	const last = lastResults.get(scope);
	if (!last) return false;
	const before = last.proposals.length;
	last.proposals = last.proposals.filter(
		(item) => !(item.keepId === keepId && item.dropId === dropId),
	);
	return last.proposals.length !== before;
}

export interface StartReviewOptions {
	generate?: ReviewGenerator;
	findEvidence?: EvidenceFinder;
	/** 成功后跑一次确定性审计（API 层注入，避免本模块 import pass 造成层次反转）。 */
	onSuccess?: (result: Extract<ReviewResult, { ok: true }>) => void;
}

export interface ReviewJobHandle {
	running: true;
	alreadyRunning: boolean;
	startedAt: string;
	promise: Promise<ReviewResult> | null;
}

/**
 * 启动一次整理（单飞）。`alreadyRunning=true` 时 `promise` 是既有那一发，
 * 调用方**不要**等它（后台模式直接 202；同步模式回 409）。
 */
export function startReview(scope: string, options: StartReviewOptions = {}): ReviewJobHandle {
	const active = activeReviews.get(scope);
	if (active) {
		return {
			running: true,
			alreadyRunning: true,
			startedAt: active.startedAt,
			promise: active.promise,
		};
	}

	const startedAt = new Date().toISOString();
	const promise = (async (): Promise<ReviewResult> => {
		let result: ReviewResult;
		try {
			result = await reviewScope(scope, {
				...(options.generate ? { generate: options.generate } : {}),
				...(options.findEvidence ? { findEvidence: options.findEvidence } : {}),
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[memory] 整理任务异常: ${detail.slice(0, 200)}`);
			result = { ok: false, status: 502, error: "llm_failed", message: "整理失败，请稍后重试" };
		}

		if (result.ok) {
			lastResults.set(scope, { generatedAt: result.generatedAt, proposals: result.proposals });
			lastErrors.delete(scope);
			try {
				options.onSuccess?.(result);
			} catch (error) {
				// 审计失败只影响 diff 文件，不影响已产出的建议
				const detail = error instanceof Error ? error.message : String(error);
				console.warn(`[memory] 整理后审计失败: ${detail.slice(0, 200)}`);
			}
		} else {
			lastErrors.set(scope, {
				at: new Date().toISOString(),
				error: result.error,
				message: result.message,
			});
		}
		return result;
	})().finally(() => {
		activeReviews.delete(scope);
	});

	activeReviews.set(scope, { startedAt, promise });
	return { running: true, alreadyRunning: false, startedAt, promise };
}

/** 当前 scope 的整理状态（页面切走/刷新后恢复用）。 */
export function reviewState(scope: string): ReviewState {
	const active = activeReviews.get(scope);
	const last = lastResults.get(scope);
	const pending = readPendingProposals(scope);
	const proposals = last?.proposals ?? pending?.proposals ?? [];
	const generatedAt = last?.generatedAt ?? pending?.generatedAt ?? null;
	const source: ReviewState["source"] = last ? "live" : pending ? "pending" : "none";
	return {
		scope,
		running: Boolean(active),
		startedAt: active?.startedAt ?? null,
		generatedAt,
		proposals,
		source,
		error: lastErrors.get(scope) ?? null,
	};
}

/** 忽略一条建议：从待决文件与本次进程结果里一起摘掉（不写库、不删记忆）。 */
export function dismissProposal(scope: string, keepId: string, dropId: string): boolean {
	if (!keepId || !dropId || keepId === dropId) return false;
	let removed = forgetProposalInMemory(scope, keepId, dropId);

	try {
		const path = proposalsPath();
		const pending = readPending(path);
		const entry = pending[scope];
		if (entry) {
			const before = entry.proposals.length;
			entry.proposals = entry.proposals.filter(
				(item) => !(item.keepId === keepId && item.dropId === dropId),
			);
			if (entry.proposals.length !== before) {
				removed = true;
				writePending(path, pending);
			}
		}
	} catch (error) {
		console.warn(
			`[memory] 忽略建议落盘失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return removed;
}
