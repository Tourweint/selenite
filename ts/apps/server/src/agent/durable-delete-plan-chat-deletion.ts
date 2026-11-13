/**
 * durable-delete-plan-chat-deletion
 *
 * 2026-11-14 从 durable-delete.ts 的 L332–L583 整段切出；正文原文搬运，未改一行实现。
 * 内含：planChatDeletion / previewOf / failureOf / deletionGuard …
 */

import { readLlmConfig } from "../provider.ts";
import { closeHarnessForMaintenance, getHarness, getHarnessForMaintenance, runExclusiveMaintenance } from "./lifecycle.ts";
import { chatKindOfInternal, purgeChatMetaEntries, readChatMeta, readChatStats } from "./session.ts";
import { CTX, ChatKinds, ChatProjects, Chats, DB_PATH, TASK_CONVERSATION_PREFIX } from "./shared.ts";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Harness, LiveDoc } from "@earendil-works/pi-durable";
import { KIND_LABEL, buildForkChildrenIndex, chatHardDeleteEnabled, deleteSubtreeRows, estimateSubtree, forkSubtreeOf } from "./durable-delete-delete-subtree-rows.ts";
import type { ConversationRow, DeletionBlocked, DeletionEstimate, DeletionFailure, DeletionPlan, DeletionPreview, DeletionPreviewNode, PlanResult } from "./durable-delete-delete-subtree-rows.ts";

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

function deletionGuard(): DeletionFailure | null {
	if (!chatHardDeleteEnabled()) {
		return { ok: false, status: 400, error: "chat_hard_delete_disabled", message: "永久删除已关闭" };
	}
	if (!readLlmConfig()) {
		return { ok: false, status: 503, error: "llm_unconfigured", message: "LLM 未配置" };
	}
	return null;
}

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

export { deletionGuard, failureOf, planChatDeletion, previewOf, purgeChatMappings };
