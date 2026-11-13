import { Hono } from "hono";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { Harness } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import {
	openNodeSqliteDatabase,
	type NodeSqliteDatabase,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { readLlmConfig } from "../provider.ts";
import {
	closeHarnessForMaintenance,
	getHarness,
	getHarnessForMaintenance,
	runExclusiveMaintenance,
} from "./lifecycle.ts";
import {
	CTX,
	DB_PATH,
	Chats,
	ChatKinds,
	ChatProjects,
	TASK_CONVERSATION_PREFIX,
} from "./shared.ts";
import {
	chatKindOfInternal,
	purgeChatMetaEntries,
	readChatMeta,
	readChatStats,
	type ChatStats,
} from "./session.ts";

/**
 * 永久删除（2026-11-13 归档管理对齐 ZCode 批A，方案 §4）。
 *
 * 归档是唯一门槛：只允许删除**已在归档里**的普通会话（chatKind=worker）；
 * chief / 执事与群（`partner-`）/ 任务（`task-`）一律拒绝。分叉以子树为单位连根删：
 * durable 的 fork 是引用不是复制（`conversations.record` 的 `parent={conversationId,at}`），
 * 物理删父会话会坏子会话的回放链，所以预检扫全表找子孙（BFS），整条子树一起删。
 *
 * **不删**（方案"明确不做"登记）：文件与附件、记忆四层、派活回执、磁盘目录、
 * `record_ids` 孤儿行（只服务全局 id 唯一性，清它收益为零风险高）。
 * `Chats` / `ChatKinds` / `ChatProjects` 三张映射走**既有文档写路径**清条目
 * （session 作用域文档不裸 SQL），`chat-meta.json` 的痕迹由 `purgeChatMetaEntries` 清。
 *
 * 执行时序（durable 无删除 API，走裸 SQL；表顺序是方案定稿的安全顺序）：
 *   1. 预检（普通 getHarness）：开关 → 解析 → not-archived → kind → busy（子树逐个）。
 *   2. `runExclusiveMaintenance(fn)`：进排他维护段——并发删除在此串行，且 `getHarness()`
 *      对其他调用方合闸排队，没人能重开 Harness。
 *   3. 段内**重跑一遍预检**（预检与执行之间状态可能漂移：被恢复、变忙、多了分叉、
 *      被先到的并发删除删掉）。
 *   4. `closeHarnessForMaintenance()` 关门，SQLite 句柄交出；临时开连接做手术，
 *      单事务按 documentRevisions → documents → entries → tasks → submissions → conversations 删。
 *   5. 段内重开 Harness 清三张映射文档，再清 chat-meta；出段放闸，响应删除计数。
 *
 * 时序与方案步骤表的一处刻意调整：方案写"先 discardHarness 再拿互斥"，这里反过来
 * （先合闸再关门）。反过来的窗口更小——不存在"Harness 已关但闸还没合"的缝隙，且闸内
 * 复核忙态复用的是还没关的 Harness，省一次重开。保证等价：手术期间进程内必然无
 * Harness、且无人能重开。
 *
 * 日志只记计数与 id 数量，不含标题/正文（密钥与内容不进日志的既有口径）。
 */

/** 开关消费处：每次请求懒读 env（flags 端点写完当场生效，所以 FLAG_DEFS 里标 hot:true）。 */
export function chatHardDeleteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.CHAT_HARD_DELETE ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0" && raw !== "off";
}

// ── 契约形状 ─────────────────────────────────────────────

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

// ── 子树 BFS（纯函数，单测直接钉结构）──────────────────────

/** 一行 conversations 表：id + record JSON（parent 边只在 record 里，无反向索引）。 */
export interface ConversationRow {
	id: number;
	record: string;
}

/**
 * 全表扫一遍建"父 → 子"索引：`record.parent.conversationId` 是唯一的 fork 边。
 * record 解析失败按"没有父边"处理——坏行不该让预检失败。
 */
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

/**
 * 从目标出发沿 fork 边收集整棵子树（BFS，逐层扩到不动点）。
 * 返回顺序：根在前、子在后；集合删没有顺序依赖（表无外键），顺序只服务可读性。
 */
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

// ── SQLite 计量与手术 ─────────────────────────────────────

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

/** 子树 tasks 的 id（task 作用域文档按它们删）。必须**先于** tasks 表删除前取。 */
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

/** 预检的 estimate：SQL COUNT，不逐条读 context（方案口径）。 */
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

/**
 * 删除手术：**单事务**按 documentRevisions → documents → entries → tasks →
 * submissions → conversations 的顺序删（先删文档修订与文档行，再删会话内容，
 * 最后删会话本体——与方案的安全顺序一致）。返回各表删除前的实际行数。
 * `record_ids` 刻意不清（方案已登记）。
 */
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

// ── 预检计划（预检与执行重跑共用同一实现）──────────────────

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

/**
 * 一份删除计划：解析 + 子树 BFS + 忙态 + estimate。
 * `blocked` 按方案顺序取第一个命中：not-archived（门槛）→ kind → busy。
 */
async function planChatDeletion(harness: Harness, externalId: string): Promise<PlanResult> {
	const chats = await harness.snapshot(Chats, CTX);
	const byExternal = chats?.byExternal ?? {};
	const targetInternal = byExternal[externalId];
	if (targetInternal === undefined) {
		return { ok: false, status: 404, error: "unknown_chat", message: "没有这个会话" };
	}
	const target = Number(targetInternal);

	const externalByInternal = new Map<number, string>();
	for (const [external, internal] of Object.entries(byExternal)) {
		externalByInternal.set(Number(internal), external);
	}

	const meta = readChatMeta();
	const targetStats = await readChatStats(harness, target);

	// 子树 BFS 与 estimate 走临时裸连接（WAL 下与 Harness 的连接互不阻塞）；
	// 预检结束立刻关掉，不占句柄。
	const db = await openNodeSqliteDatabase(DB_PATH);
	let subtreeIds: number[];
	let estimate: DeletionEstimate;
	try {
		const rows = await db.all<ConversationRow>("SELECT id, record FROM conversations ORDER BY id");
		subtreeIds = forkSubtreeOf(buildForkChildrenIndex(rows), target);
		estimate = await estimateSubtree(db, subtreeIds);
	} finally {
		await db.close();
	}

	// not-archived：门槛第一（ZCode 同款：未归档拒绝）
	if (!meta.archived.includes(externalId)) {
		return {
			ok: true,
			plan: {
				targetExternalId: externalId,
				targetInternal: target,
				subtreeIds,
				nodes: [],
				targetStats,
				estimate,
				blocked: {
					reason: "not-archived",
					detail: "会话不在归档里；只有已归档的会话才能永久删除",
				},
			},
		};
	}

	// kind：只允许普通会话（目标 + 子树逐个；分叉子会话继承种类，一般不会命中）
	const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
	let kindHit: { kind: "chief" | "partner" | "task"; isTarget: boolean } | null = null;
	for (const id of subtreeIds) {
		const external = externalByInternal.get(id);
		if (external?.startsWith(TASK_CONVERSATION_PREFIX)) {
			kindHit = { kind: "task", isTarget: id === target };
			break;
		}
		const kind = chatKindOfInternal(id, kinds);
		if (kind !== "worker") {
			kindHit = { kind, isTarget: id === target };
			break;
		}
	}
	if (kindHit) {
		const scope = kindHit.isTarget ? "目标是" : "子树里有";
		return {
			ok: true,
			plan: {
				targetExternalId: externalId,
				targetInternal: target,
				subtreeIds,
				nodes: [],
				targetStats,
				estimate,
				blocked: {
					reason: "kind",
					detail: `只能永久删除普通会话；${scope}${KIND_LABEL[kindHit.kind] ?? "非普通会话"}，不能删`,
				},
			},
		};
	}

	// busy：子树任一会话在跑（读 pi.live.run，与 conversationIsBusy 同口径）
	const busy: number[] = [];
	for (const id of subtreeIds) {
		try {
			const live = await harness.snapshot(LiveDoc, id as never, CTX);
			if (live?.run) busy.push(id);
		} catch {
			/* live 读不出来按空闲处理（与 conversationIsBusy 同口径） */
		}
	}
	if (busy.length > 0) {
		return {
			ok: true,
			plan: {
				targetExternalId: externalId,
				targetInternal: target,
				subtreeIds,
				nodes: [],
				targetStats,
				estimate,
				blocked: {
					reason: "busy",
					detail: `子树里有 ${busy.length} 个会话正在运行，请先停止再删`,
				},
			},
		};
	}

	// 名单：只列有对外映射的节点（内部 id 不外泄）；标题 = chat-meta 标题 ?? 首句
	const nodes: DeletionPreviewNode[] = [];
	for (const id of subtreeIds) {
		const external = externalByInternal.get(id);
		if (external === undefined) continue;
		const stats = id === target ? targetStats : await readChatStats(harness, id).catch(() => null);
		nodes.push({
			conversationId: external,
			title: meta.titles[external] ?? stats?.firstText ?? "",
			rounds: stats?.turns ?? 0,
			lastAt: stats?.lastAt ?? 0,
		});
	}

	return {
		ok: true,
		plan: {
			targetExternalId: externalId,
			targetInternal: target,
			subtreeIds,
			nodes,
			targetStats,
			estimate,
		},
	};
}

function previewOf(plan: DeletionPlan): DeletionPreview {
	const targetNode = plan.nodes.find((node) => node.conversationId === plan.targetExternalId);
	const archivedAt = readChatMeta().archivedAt[plan.targetExternalId];
	return {
		conversationId: plan.targetExternalId,
		title: targetNode?.title ?? (plan.targetStats ? plan.targetStats.firstText : ""),
		rounds: plan.targetStats?.turns ?? 0,
		lastAt: plan.targetStats?.lastAt ?? 0,
		...(archivedAt !== undefined ? { archivedAt } : {}),
		...(plan.blocked ? { blocked: plan.blocked } : {}),
		// blocked 时子树名单为空数组（方案口径：不给名单）
		subtree: plan.blocked ? [] : plan.nodes,
		estimate: plan.estimate,
	};
}

function failureOf(blocked: DeletionBlocked): DeletionFailure {
	return {
		ok: false,
		status: 400,
		error: "delete_blocked",
		message: blocked.detail,
		blocked,
	};
}

/** 公共前置：开关 + LLM 配置（预检要开 Harness 读映射；未配置模型与 /stop 同口径 503）。 */
function deletionGuard(): DeletionFailure | null {
	if (!chatHardDeleteEnabled()) {
		return { ok: false, status: 400, error: "chat_hard_delete_disabled", message: "永久删除已关闭" };
	}
	if (!readLlmConfig()) {
		return { ok: false, status: 503, error: "llm_unconfigured", message: "LLM 未配置" };
	}
	return null;
}

/** 预检端点本体（只读，不动任何数据）。 */
export async function previewChatDeletion(
	externalId: string,
): Promise<{ ok: true; preview: DeletionPreview } | DeletionFailure> {
	const guard = deletionGuard();
	if (guard) return guard;
	const harness = await getHarness();
	const result = await planChatDeletion(harness, externalId);
	if (!result.ok) return result;
	return { ok: true, preview: previewOf(result.plan) };
}

/**
 * 执行删除：闸内**重跑一遍预检**（预检与执行之间状态可能漂移），任一 blocked → 400。
 * 成功响应 `{ok:true, deleted:{conversations,entries,tasks,submissions}}`。
 */
export async function deleteChatForever(
	externalId: string,
): Promise<{ ok: true; deleted: DeletionEstimate } | DeletionFailure> {
	const guard = deletionGuard();
	if (guard) return guard;

	// 预检 #1（普通 getHarness；此时维护闸还没合）
	const harness = await getHarness();
	const pre = await planChatDeletion(harness, externalId);
	if (!pre.ok) return pre;
	if (pre.plan.blocked) return failureOf(pre.plan.blocked);

	// 排他维护段：并发删除在这里串行；getHarness() 对其他调用方合闸排队
	return runExclusiveMaintenance(async () => {
		// 预检 #2（闸内）：被恢复、变忙、多了分叉、已被先到的并发删除删掉，都在这里挡下
		const harnessForRecheck = await getHarnessForMaintenance();
		const recheck = await planChatDeletion(harnessForRecheck, externalId);
		if (!recheck.ok) return recheck;
		if (recheck.plan.blocked) return failureOf(recheck.plan.blocked);
		const plan = recheck.plan;
		const externalIds = [...new Set(plan.nodes.map((node) => node.conversationId))];

		// 关门：SQLite 句柄交出，手术期间进程内无 Harness（闸挡住重开）
		await closeHarnessForMaintenance();

		const db = await openNodeSqliteDatabase(DB_PATH);
		let deleted: DeletionEstimate;
		try {
			deleted = await deleteSubtreeRows(db, plan.subtreeIds);
		} finally {
			await db.close();
		}
		console.log(
			`[chat-delete] 已永久删除会话子树：conversations=${deleted.conversations} entries=${deleted.entries} ` +
				`tasks=${deleted.tasks} submissions=${deleted.submissions} ids=${plan.subtreeIds.length}`,
		);

		// 清三张映射文档：走既有文档写路径（重开 Harness 由维护闸挡住并发）
		const harnessAfter = await getHarnessForMaintenance();
		await purgeChatMappings(harnessAfter, plan.subtreeIds);

		// 清 chat-meta 痕迹（titles/archived/archivedAt/pins；原子写在 session.ts）
		purgeChatMetaEntries(externalIds);
		return { ok: true, deleted };
	});
}

/** 清 `Chats` / `ChatKinds` / `ChatProjects` 里子树的条目（tx 写路径，session 作用域文档不裸 SQL）。 */
async function purgeChatMappings(harness: Harness, internalIds: readonly number[]): Promise<void> {
	const idSet = new Set(internalIds.map(Number));
	await harness.commit(async (tx) => {
		const chats = await tx.doc(Chats);
		for (const [externalId, internal] of Object.entries(chats.byExternal ?? {})) {
			if (idSet.has(Number(internal))) delete chats.byExternal[externalId];
		}
		const kinds = await tx.doc(ChatKinds);
		for (const id of internalIds) delete kinds.byInternal[String(id)];
		const projects = await tx.doc(ChatProjects);
		for (const id of internalIds) delete projects.byInternal[String(id)];
	}, CTX);
}

// ── 端点（照 mountFlags / mountProjects 的挂载范式；批C http 探针直接复用）──

export function mountDurableDelete(app: Hono): void {
	app.get("/api/v1/agent/chat/:conversationId/deletion-preview", async (c) => {
		const result = await previewChatDeletion(c.req.param("conversationId"));
		if (!result.ok) {
			return c.json(
				{
					error: result.error,
					message: result.message,
					...(result.blocked ? { blocked: result.blocked } : {}),
				},
				result.status,
			);
		}
		return c.json(result.preview);
	});

	app.post("/api/v1/agent/chat/:conversationId/delete", async (c) => {
		const result = await deleteChatForever(c.req.param("conversationId"));
		if (!result.ok) {
			return c.json(
				{
					error: result.error,
					message: result.message,
					...(result.blocked ? { blocked: result.blocked } : {}),
				},
				result.status,
			);
		}
		return c.json({ ok: true, deleted: result.deleted });
	});
}
