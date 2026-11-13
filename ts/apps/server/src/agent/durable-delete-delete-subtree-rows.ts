/**
 * durable-delete-delete-subtree-rows
 *
 * 2026-11-14 从 durable-delete.ts 的 L64–L326 整段切出；正文原文搬运，未改一行实现。
 * 内含：chatHardDeleteEnabled / DeletionBlockedReason / DeletionBlocked / DeletionPreviewNode …
 */

import type { ChatStats } from "./session.ts";
import { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

export function chatHardDeleteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.CHAT_HARD_DELETE ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0" && raw !== "off";
}

export type DeletionBlockedReason = "not-archived" | "kind" | "busy";

export interface DeletionBlocked {
	reason: DeletionBlockedReason;
	detail: string;
}

export interface DeletionPreviewNode {
	/** 对外 uuid；没有对外映射的子树节点不列（内部 id 不外泄），但照样会被删掉 */
	conversationId: string;
	title: string;
	rounds: number;
	lastAt: number;
}

export interface DeletionEstimate {
	conversations: number;
	entries: number;
	tasks: number;
	submissions: number;
}

export interface DeletionPreview {
	conversationId: string;
	title: string;
	rounds: number;
	lastAt: number;
	archivedAt?: number;
	blocked?: DeletionBlocked;
	/** blocked 时为空数组（方案口径：不给名单） */
	subtree: DeletionPreviewNode[];
	estimate: DeletionEstimate;
}

export type DeletionFailure = {
	ok: false;
	status: 400 | 404 | 503;
	error: string;
	message: string;
	blocked?: DeletionBlocked;
};

export interface ConversationRow {
	id: number;
	record: string;
}

export function buildForkChildrenIndex(rows: readonly ConversationRow[]): Map<number, number[]> {
	const children = new Map<number, number[]>();
	for (const row of rows) {
		let parentId: number | undefined;
		try {
			const parsed = JSON.parse(row.record) as { parent?: { conversationId?: unknown } };
			const candidate = parsed.parent?.conversationId;
			if (typeof candidate === "number" && Number.isSafeInteger(candidate)) parentId = candidate;
		} catch {
			continue;
		}
		if (parentId === undefined) continue;
		const list = children.get(parentId);
		if (list) list.push(row.id);
		else children.set(parentId, [row.id]);
	}
	return children;
}

export function forkSubtreeOf(children: Map<number, number[]>, root: number): number[] {
	const subtree: number[] = [];
	const seen = new Set<number>([root]);
	let frontier = [root];
	while (frontier.length > 0) {
		const next: number[] = [];
		for (const id of frontier) {
			subtree.push(id);
			for (const child of children.get(id) ?? []) {
				if (seen.has(child)) continue;
				seen.add(child);
				next.push(child);
			}
		}
		frontier = next;
	}
	return subtree;
}

const SQL_CHUNK = 400;

function chunked(ids: readonly number[]): number[][] {
	if (ids.length === 0) return [[]];
	const chunks: number[][] = [];
	for (let index = 0; index < ids.length; index += SQL_CHUNK) {
		chunks.push(ids.slice(index, index + SQL_CHUNK));
	}
	return chunks;
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(",");
}

async function taskIdsOf(
	db: SqliteExecutor,
	conversationIds: readonly number[],
): Promise<number[]> {
	const found: number[] = [];
	for (const chunk of chunked(conversationIds)) {
		if (chunk.length === 0) continue;
		const rows = await db.all<{ id: number }>(
			`SELECT id FROM tasks WHERE conversation_id IN (${placeholders(chunk.length)})`,
			...chunk,
		);
		for (const row of rows) found.push(Number(row.id));
	}
	return found;
}

async function countRows(
	db: NodeSqliteDatabase,
	table: string,
	column: string,
	conversationIds: readonly number[],
): Promise<number> {
	let total = 0;
	for (const chunk of chunked(conversationIds)) {
		if (chunk.length === 0) continue;
		const row = await db.get<{ n: number }>(
			`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${placeholders(chunk.length)})`,
			...chunk,
		);
		total += Number(row?.n ?? 0);
	}
	return total;
}

export async function estimateSubtree(
	db: NodeSqliteDatabase,
	conversationIds: readonly number[],
): Promise<DeletionEstimate> {
	return {
		conversations: await countRows(db, "conversations", "id", conversationIds),
		entries: await countRows(db, "entries", "conversation_id", conversationIds),
		tasks: await countRows(db, "tasks", "conversation_id", conversationIds),
		submissions: await countRows(db, "submissions", "conversation_id", conversationIds),
	};
}

export async function deleteSubtreeRows(
	db: NodeSqliteDatabase,
	conversationIds: readonly number[],
): Promise<DeletionEstimate> {
	const estimate: DeletionEstimate = { conversations: 0, entries: 0, tasks: 0, submissions: 0 };
	await db.transaction(async (tx) => {
		for (const chunk of chunked(conversationIds)) {
			if (chunk.length === 0) continue;
			const conversationPh = placeholders(chunk.length);
			// 子树会话名下的 tasks（task 作用域文档按它们删）；必须在删 tasks 表之前取
			const chunkTaskIds = await taskIdsOf(tx, chunk);
			const taskChunks = chunkTaskIds.length > 0 ? chunked(chunkTaskIds) : [[]];

			// document_revisions → documents。文档行谓词：会话作用域（按子树会话）
			// ∪ 任务作用域（按子树 tasks）；task id 多于一块时与会话块做组合（子树规模小，个位数块）。
			for (const taskChunk of taskChunks) {
				const predicateParts = [
					`(scope_kind='conversation' AND owner_id IN (${conversationPh}))`,
				];
				const params: number[] = [...chunk];
				if (taskChunk.length > 0) {
					predicateParts.push(`(scope_kind='task' AND owner_id IN (${placeholders(taskChunk.length)}))`);
					params.push(...taskChunk);
				}
				const predicate = predicateParts.join(" OR ");
				await tx.run(
					`DELETE FROM document_revisions WHERE document_id IN
						(SELECT id FROM documents WHERE ${predicate})`,
					...params,
				);
				await tx.run(`DELETE FROM documents WHERE ${predicate}`, ...params);
			}

			const entryRow = await tx.get<{ n: number }>(
				`SELECT COUNT(*) AS n FROM entries WHERE conversation_id IN (${conversationPh})`,
				...chunk,
			);
			await tx.run(`DELETE FROM entries WHERE conversation_id IN (${conversationPh})`, ...chunk);
			estimate.entries += Number(entryRow?.n ?? 0);

			const submissionRow = await tx.get<{ n: number }>(
				`SELECT COUNT(*) AS n FROM submissions WHERE conversation_id IN (${conversationPh})`,
				...chunk,
			);
			await tx.run(
				`DELETE FROM submissions WHERE conversation_id IN (${conversationPh})`,
				...chunk,
			);
			estimate.submissions += Number(submissionRow?.n ?? 0);

			const taskRow = await tx.get<{ n: number }>(
				`SELECT COUNT(*) AS n FROM tasks WHERE conversation_id IN (${conversationPh})`,
				...chunk,
			);
			await tx.run(`DELETE FROM tasks WHERE conversation_id IN (${conversationPh})`, ...chunk);
			estimate.tasks += Number(taskRow?.n ?? 0);

			const conversationRow = await tx.get<{ n: number }>(
				`SELECT COUNT(*) AS n FROM conversations WHERE id IN (${conversationPh})`,
				...chunk,
			);
			await tx.run(`DELETE FROM conversations WHERE id IN (${conversationPh})`, ...chunk);
			estimate.conversations += Number(conversationRow?.n ?? 0);
		}
	});
	return estimate;
}

interface DeletionPlan {
	targetExternalId: string;
	targetInternal: number;
	/** 子树全集合（含目标；没有对外映射的也在内，照样删） */
	subtreeIds: number[];
	/** 有对外映射的子树名单（对外 id 一律 uuid；内部 id 不外泄） */
	nodes: DeletionPreviewNode[];
	targetStats: ChatStats | null;
	estimate: DeletionEstimate;
	blocked?: DeletionBlocked;
}

type PlanResult = { ok: true; plan: DeletionPlan } | DeletionFailure;

const KIND_LABEL: Record<string, string> = {
	chief: "总管会话",
	partner: "执事/群会话",
	task: "任务会话",
};

export { KIND_LABEL, SQL_CHUNK, chunked, countRows, placeholders, taskIdsOf };
export type { DeletionPlan, PlanResult };
