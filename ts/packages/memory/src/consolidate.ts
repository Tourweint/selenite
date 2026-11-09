import { IMPORTANCE_CEIL } from "./decay.ts";
import type { MemoryCandidate, MemoryKind, MemoryRecord, Veracity } from "./types.ts";
import type { MemoryStore } from "./store.ts";

/**
 * 巩固层：决定新候选怎么和已有记忆相处。
 *
 * 这是记忆系统真正的分水岭。没有这一层，库只会越写越大，
 * 最后召回出来的全是重复和过时信息。
 *
 * 当前做两件**确定性**的事（不碰语义）：
 *   1. 同 scope + 同 kind + **规范化后全等** → 不新增，只提升 importance（重复 = 更重要）
 *      "规范化" = trim / 空白折叠 / 全半角统一 / 句末标点剥除（2026-11-08 扫尾批 6）
 *   2. 其余 → 直接入库
 *
 * 加上 2026-11-08 的导入通道：`importMemories` 是"只增不改"的旁路，
 * 规范化等价的跳过并计数，绝不覆盖 / 删除已有记录。
 *
 * 刻意没有（D18，2026-11-08 复核）：语义去重、自动冲突消解、自动删除。
 * "意思相同但措辞不同"只走模型建议制（server 的 memory-consolidate.ts），人拍板才执行。
 */

export interface ConsolidateResult {
	added: MemoryRecord[];
	reinforced: MemoryRecord[];
	skipped: MemoryCandidate[];
}

export interface Consolidator {
	consolidate(
		candidates: MemoryCandidate[],
		store: MemoryStore,
		now?: Date,
	): ConsolidateResult;
}

/**
 * 记忆正文的规范化形式（2026-11-08 扫尾批 6 §一）。
 *
 * 四步，顺序有讲究：
 *   1. 全角 → 半角（含全角空格）：`ＡＢ，１２` 与 `AB,12` 是同一句话的两种输入法产物；
 *   2. 空白折叠：换行 / 多空格 / 制表符都算一个空格；
 *   3. 首尾去空白；
 *   4. 剥掉句末标点：同一句话带不带句号不该被当成两条。
 *
 * **不做**大小写折叠与小写化：英文里大小写可能承载专名信息，合并错了无法回退。
 * 也不剥括号 / 引号：那是正文的一部分，不是句末装饰。
 */
export function normalizeContent(text: string): string {
	const halfWidth = text
		.replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
		.replace(/\u3000/g, " ");
	return halfWidth
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[。．.！!？?；;，,、…~～]+$/u, "")
		.trim();
}

function sameContent(left: string, right: string): boolean {
	return normalizeContent(left) === normalizeContent(right);
}

export class BasicConsolidator implements Consolidator {
	consolidate(
		candidates: MemoryCandidate[],
		store: MemoryStore,
		now: Date = new Date(),
	): ConsolidateResult {
		const added: MemoryRecord[] = [];
		const reinforced: MemoryRecord[] = [];
		const skipped: MemoryCandidate[] = [];

		for (const candidate of candidates) {
			const normalized = normalizeContent(candidate.content);
			if (!normalized) {
				skipped.push(candidate);
				continue;
			}

			// 同 scope + 同 kind + 规范化全等才算"重复"（2026-11-08）：
			// kind 不同意味着用途不同（一条是偏好、一条是经历），正文撞车也不该合并。
			// work 是 append-only 履历（2026-11-08 刀二 E2）：正文撞车也是另一单，
			// 一律跳过查重直接 append，绝不合并 / 强化（"整理纪要"干十次是十条履历）。
			// intention（2026-11-09 T4 §3）同理：两次「打算」即使同文，也该保留各自的
			// 时间与有效期；合并会把其中一条的承诺吃掉。
			const existing =
				candidate.kind === "work" || candidate.kind === "intention"
					? undefined
					: store
						.search({ scopes: [candidate.scope], limit: 200 })
						.find(
							(record) =>
								record.kind === candidate.kind && sameContent(record.content, candidate.content),
						);

			if (existing) {
				// 同类内容再次出现：说明这不是一次性事件，重要性上浮。
				// 上限用 10 而不是 1：召回强化可能已经把值推过 1，这里再 Math.min(1, …) 会把它按回去。
				const bumped = Math.min(IMPORTANCE_CEIL, existing.importance + 0.1);
				store.patch(existing.id, { importance: bumped });
				reinforced.push({ ...existing, importance: bumped });
				continue;
			}

			const record: MemoryRecord = {
				id: crypto.randomUUID(),
				kind: candidate.kind,
				scope: candidate.scope,
				content: candidate.content,
				importance: candidate.importance,
				veracity: candidate.veracity,
				source: candidate.source,
				createdAt: now.toISOString(),
				validUntil: candidate.validUntil ?? null,
				supersededBy: null,
				recallCount: 0,
				lastRecalledAt: null,
				expiresAt: candidate.expiresAt ?? null,
			};

			store.put(record);
			added.push(record);
		}

		return { added, reinforced, skipped };
	}
}

// ── 已存记忆导入（2026-11-08 扫尾批 6 §三）──────────────────

/** 导入单条（已通过 API 层形状校验，这里再做内容校验）。 */
export interface ImportEntry {
	text: string;
	kind?: string;
	createdAt?: string;
	importance?: number;
}

export interface ImportOutcome {
	added: MemoryRecord[];
	/** 跳过条数（空文本 / 认不出的 kind / 规范化等价）——调用方只报数，不报内容（D8）。 */
	skipped: number;
	total: number;
}

const IMPORT_KINDS: ReadonlySet<string> = new Set(["fact", "episode", "preference", "entity"]);
const IMPORT_DEFAULT_IMPORTANCE = 0.5;

/** 导入正文上限：记忆是短句，超长的一条多半是导错了文件。 */
const IMPORT_MAX_CHARS = 2000;

/**
 * 只增不改地把一批记忆并进某个 scope。
 *
 * 口径（方案 §三）：
 *   - 逐条走与 ingest 同一套校验：空文本 / 认不出的 kind 跳过；
 *   - **规范化等价 = 跳过并计数**，不提升 importance、不改任何已有行（import 不出去动别人）；
 *   - 被取代（superseded）的旧记录也算"已经存在"：不把用户明确标过时的内容重新捞回来；
 *   - 同一批内重复（规范化等价）同样跳过，防止一个文件自己踩自己；
 *   - `source` / `veracity` 一律 `imported`，方便日后按来源审计。
 *
 * 返回值只带条数和新增的记录对象，不含任何日志输出。
 */
export function importMemories(
	store: MemoryStore,
	scope: string,
	entries: ImportEntry[],
	now: Date = new Date(),
): ImportOutcome {
	const added: MemoryRecord[] = [];
	let skipped = 0;

	// 一次性把本 scope 的规范化键捞出来（含已被取代的）：导入是批处理，逐条查库会 O(n²)。
	const seen = new Set<string>();
	for (const record of store.search({ scopes: [scope], includeSuperseded: true, limit: 100_000 })) {
		seen.add(`${record.kind}\u0000${normalizeContent(record.content)}`);
	}

	for (const entry of entries) {
		const text = typeof entry?.text === "string" ? entry.text.trim() : "";
		const kind = typeof entry?.kind === "string" ? entry.kind.trim() : "";
		if (!text || text.length > IMPORT_MAX_CHARS) {
			skipped += 1;
			continue;
		}
		const resolvedKind = (kind || "fact") as MemoryKind;
		if (!IMPORT_KINDS.has(resolvedKind)) {
			skipped += 1;
			continue;
		}
		const key = `${resolvedKind}\u0000${normalizeContent(text)}`;
		if (!normalizeContent(text) || seen.has(key)) {
			skipped += 1;
			continue;
		}
		seen.add(key);

		const importance =
			typeof entry.importance === "number" && Number.isFinite(entry.importance)
				? Math.min(1, Math.max(0.1, entry.importance))
				: IMPORT_DEFAULT_IMPORTANCE;
		const createdAt = resolveImportedTime(entry.createdAt, now);

		const record: MemoryRecord = {
			id: crypto.randomUUID(),
			kind: resolvedKind,
			scope,
			content: text,
			importance,
			veracity: "imported" as Veracity,
			source: "imported",
			createdAt,
			validUntil: null,
			supersededBy: null,
			recallCount: 0,
			lastRecalledAt: null,
			expiresAt: null,
		};
		store.put(record);
		added.push(record);
	}

	return { added, skipped, total: entries.length };
}

/**
 * 导入时间：合法 ISO 就用（保留"这是哪年的记忆"），否则用 now。
 * 未来时间裁到 now —— 一条来自 2099 的记忆会把新近度打分打爆。
 */
function resolveImportedTime(raw: unknown, now: Date): string {
	if (typeof raw !== "string" || !raw.trim()) return now.toISOString();
	const parsed = Date.parse(raw);
	if (Number.isNaN(parsed)) return now.toISOString();
	const at = new Date(Math.min(parsed, now.getTime()));
	return at.toISOString();
}
