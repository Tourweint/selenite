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

import { auxiliaryModel } from "./auxiliary.ts";
import { currentModels, isFaux, readLlmConfig } from "./provider.ts";
import { contentText } from "@earendil-works/pi-ai";
import type { MemoryRecord, MemoryScope } from "@lifediary/memory";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { flagEnabled } from "./flags.ts";

export function consolidateLlmEnabled(): boolean {
	return !isOff(process.env.MEMORY_CONSOLIDATE_LLM);
}

export function memoryImportEnabled(): boolean {
	return !isOff(process.env.MEMORY_IMPORT);
}

function isOff(raw: string | undefined): boolean {
	const value = (raw ?? "").trim().toLowerCase();
	return value === "false" || value === "0" || value === "off";
}

export function validTargetScope(scope: string): boolean {
	return (
		scope === "global" ||
		/^partner:[A-Za-z0-9._~%-]{1,80}$/.test(scope) ||
		// 项目 scope（2026-11-15 项目记忆方案）：uuid 必须是登记项目，校验在调用方（importMemory）做
		/^project:[0-9a-f-]{10,64}$/i.test(scope)
	);
}

function scopeOf(scope: string): MemoryScope | null {
	if (scope === "global") return { type: "global" };
	const match = /^partner:(.+)$/.exec(scope);
	if (match) return { type: "partner", id: match[1]! };
	const project = /^project:(.+)$/.exec(scope);
	return project ? { type: "project", id: project[1]! } : null;
}

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
	/**
	 * 两端正文随建议一起返回：前端不必再从列表里反查（列表可能只取了前 300 条）。
	 * 证据引文 `evidence` 已退役（2026-11-17，方案 docs/设计方案/2026-11-17-整理建议证据引文退役.md）：
	 * 原子化后 drop 端正文与对话原话不再逐字对应，逐字反查条条落空，整个检测链拆除。
	 */
	keep: ProposalSide;
	drop: ProposalSide;
}

export interface ProposalDraft {
	keepId: string;
	dropId: string;
	reason: string;
}

const REVIEW_TIMEOUT_MS = 30_000;

const REVIEW_CONTENT_CHARS = 300;

export type ReviewGenerator = (input: {
	system: string;
	user: string;
}) => Promise<string | null>;

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

export function reviewModelAvailable(): boolean {
	return Boolean(readLlmConfig()) && !isFaux();
}

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

export function renderReviewInput(records: MemoryRecord[]): string {
	return records
		.map((record) => {
			const text = record.content.replace(/\s+/g, " ").trim().slice(0, REVIEW_CONTENT_CHARS);
			return `- id=${record.id} [${record.kind}] ${text}`;
		})
		.join("\n");
}

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

interface PendingEntry {
	generatedAt: string;
	proposals: ConsolidateProposal[];
}

type PendingFile = Record<string, PendingEntry>;

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

export { REVIEW_CONTENT_CHARS, REVIEW_TIMEOUT_MS, generateReview, isOff, proposalsPath, readPending, scopeOf, sideOf, writePending };
export type { PendingEntry, PendingFile };
