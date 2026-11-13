/**
 * memory-consolidate-review-scope
 *
 * 2026-11-14 从 memory-consolidate.ts 的 L343–L656 整段切出；正文原文搬运，未改一行实现。
 * 内含：reviewScope / ApplyResult / applyProposal / MAX_IMPORT_ITEMS …
 */

import type { EvidenceHit } from "./agent.ts";
import { findEvidence, memoryEngine, supersedeMemory } from "./agent.ts";
import { redactSecrets } from "@lifediary/memory";
import { CONSOLIDATE_PROMPT, MAX_REVIEW_RECORDS, generateReview, parseProposalJson, proposalsPath, readPending, renderReviewInput, reviewEvidenceEnabled, reviewModelAvailable, scopeOf, sideOf, validTargetScope, writePending } from "./memory-consolidate-parse-proposal-json.ts";
import type { ConsolidateProposal, EvidenceFinder, PendingEntry, ReviewGenerator, ReviewResult } from "./memory-consolidate-parse-proposal-json.ts";

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

export type ApplyResult =
	| { ok: true; scope: string; keepId: string; dropId: string; alreadyApplied: boolean }
	| { ok: false; status: number; error: string; message: string };

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

export const MAX_IMPORT_ITEMS = 5000;

export type ImportResult =
	| { ok: true; scope: string; added: number; skipped: number; total: number }
	| { ok: false; status: number; error: string; message: string };

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

export function pendingProposalCount(scope: string): number {
	return readPending(proposalsPath())[scope]?.proposals.length ?? 0;
}

export function readPendingProposals(scope: string): PendingEntry | null {
	const entry = readPending(proposalsPath())[scope];
	if (!entry) return null;
	return { generatedAt: entry.generatedAt, proposals: entry.proposals };
}

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

export { activeReviews, forgetProposalInMemory, lastErrors, lastResults };
export type { ActiveReview, LastReview };
