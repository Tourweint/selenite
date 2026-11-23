/**
 * 分支会话删除（2026-11-18，方案 docs/设计方案/2026-11-18-分支会话删除与选择器二级菜单.md）。
 *
 * 只删「选择器里的分支/副会话」：
 * - 执事的 `role='side'` 副会话；
 * - 总管带 `ChatOrigins` 的分支副本。
 *
 * canonical 主对话、总管无来源的主对话、普通 worker 会话都不走这里（worker 仍走归档 → 永久删除）。
 * 有子分支的先拦下：分支关系只存 `ChatOrigins`（durable 没有 parent），直接删会留下孤儿。
 *
 * 清理范围与 durable-delete 对齐：会话行 / entries / tasks / submissions / documents、
 * Chats / ChatKinds / ChatProjects / ChatOrigins、chat-meta 痕迹、partner_session_links。
 * 不碰记忆、附件文件、磁盘目录。
 */

import { partnersStore } from "../partners.ts";
import {
	closeHarnessForMaintenance,
	getHarness,
	getHarnessForMaintenance,
	runExclusiveMaintenance,
} from "./lifecycle.ts";
import { deletionGuard, purgeChatMappings } from "./durable-delete-plan-chat-deletion.ts";
import {
	buildForkChildrenIndex,
	deleteSubtreeRows,
	forkSubtreeOf,
	type ConversationRow,
	type DeletionEstimate,
} from "./durable-delete-delete-subtree-rows.ts";
import { chatKindOfInternal } from "./session-open.ts";
import { purgeChatMetaEntries, readChatMeta } from "./session-meta.ts";
import { CTX, ChatKinds, ChatOrigins, Chats, DB_PATH } from "./shared.ts";
import type { PartnerSessionLinkRow } from "../partner-types.ts";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Harness, LiveDoc } from "@earendil-works/pi-durable";

export interface PartnerSessionDeleteResult {
	ok: true;
	conversationId: string;
	deleted: DeletionEstimate;
}

export interface PartnerSessionDeleteFailure {
	ok: false;
	status: 400 | 404 | 409 | 503;
	error: string;
	message: string;
}

type OriginMap = Record<
	string,
	{ source: string; sourceTitle?: string; at: number; atMessageId?: string }
>;

interface InspectedTarget {
	internalId: number;
	externalId: string;
	origins: OriginMap;
	link: PartnerSessionLinkRow | null;
}

type InspectResult =
	| { ok: true; target: InspectedTarget }
	| { ok: false; status: 400 | 404 | 409 | 503; error: string; message: string };

function fail(
	status: 400 | 404 | 409 | 503,
	error: string,
	message: string,
): { ok: false; status: 400 | 404 | 409 | 503; error: string; message: string } {
	return { ok: false, status, error, message };
}

/** 沿 ChatOrigins 往上找根：根会话属于这个执事的 canonical/side 才算他的分支。
 *  给"老分支缺 side 链接、但选择器沿 ChatOrigins 补出来了"的那类副本用。 */
function partnerOwnsOriginChain(
	externalId: string,
	origins: OriginMap,
	byExternal: Record<string, number>,
	partnerId: string,
): boolean {
	let current = externalId;
	const seen = new Set<string>();
	for (let depth = 0; depth < 64; depth += 1) {
		const origin = origins[current];
		if (!origin?.source || seen.has(current)) break;
		seen.add(current);
		current = origin.source;
	}
	const rootInternal = byExternal[current];
	if (rootInternal === undefined) return false;
	const rootLink = partnersStore().linkOfSession(Number(rootInternal));
	return Boolean(
		rootLink &&
			rootLink.partnerId === partnerId &&
			(rootLink.role === "canonical" || rootLink.role === "side"),
	);
}

/** 目标校验：存在 / 是这个执事的 side（或总管的分支副本）/ 没有子分支 / 不忙。 */
async function inspectTarget(
	harness: Harness,
	partnerId: string,
	externalId: string,
): Promise<InspectResult> {
	const chats = await harness.snapshot(Chats, CTX);
	const internalId = chats?.byExternal?.[externalId];
	if (internalId === undefined) return fail(404, "unknown_session", "没有这条会话");

	const origins = (await harness.snapshot(ChatOrigins, CTX))?.byExternal ?? {};
	const origin = origins[externalId];
	const link = partnersStore().linkOfSession(Number(internalId));

	if (partnerId === "chief") {
		const kinds = (await harness.snapshot(ChatKinds, CTX))?.byInternal ?? {};
		if (chatKindOfInternal(Number(internalId), kinds) !== "chief") {
			return fail(409, "not_side_session", "这条不是总管的分支副本，不能在这里删除");
		}
		if (!origin) {
			return fail(409, "not_side_session", "总管的主对话不能删；只有分叉出来的副本可以删");
		}
	} else {
		const ownedByPartner =
			Boolean(link && link.partnerId === partnerId && link.role === "side") ||
			Boolean(
				origin &&
					partnerOwnsOriginChain(
						externalId,
						origins,
						chats?.byExternal ?? {},
						partnerId,
					),
			);
		if (!ownedByPartner) {
			return fail(409, "not_side_session", "这条不是该执事的副会话，不能在这里删除");
		}
	}

	// 有子分支先拦下：ChatOrigins 里还有以它为 source 的会话。
	// 已归档的子分支不算：它已经从选择器消失，不该变成看不见的死结（恢复后就是一条独立副会话）。
	const archived = new Set(readChatMeta().archived);
	const children = Object.entries(origins).filter(
		([childId, value]) => value?.source === externalId && !archived.has(childId),
	);
	if (children.length > 0) {
		return fail(
			400,
			"has_branches",
			`这条会话下面还有 ${children.length} 条分支，先把下面这些删掉再删它`,
		);
	}

	// busy 与现有永久删除同口径：LiveDoc.run 存在即正在跑。
	const live = await harness.snapshot(LiveDoc, Number(internalId) as never, CTX);
	if (live?.run) return fail(400, "conversation_busy", "会话正在运行，请先停止再删除");

	return { ok: true, target: { internalId: Number(internalId), externalId, origins, link } };
}

/** 子树 = 目标 + durable 编辑分叉（parent 链）；分支副本的 ChatOrigins 子会话已被拦下。 */
async function durableSubtree(internalId: number): Promise<number[]> {
	const db = await openNodeSqliteDatabase(DB_PATH);
	try {
		const rows = await db.all<ConversationRow>("SELECT id, record FROM conversations ORDER BY id");
		return forkSubtreeOf(buildForkChildrenIndex(rows), internalId);
	} finally {
		await db.close();
	}
}

export async function deletePartnerSession(
	partnerId: string,
	externalId: string,
): Promise<PartnerSessionDeleteResult | PartnerSessionDeleteFailure> {
	// 与归档页「永久删除」共用总闸（CHAT_HARD_DELETE）与 LLM 配置守卫。
	//（分支会话管理开关 2026-11-21 退役，删除恒可用。）
	const guard = deletionGuard();
	if (guard) return guard;

	const harness = await getHarness();
	const first = await inspectTarget(harness, partnerId, externalId);
	if (!first.ok) return first;

	return runExclusiveMaintenance(async () => {
		// 闸内重检：删除前可能被恢复、变忙、多了子分支，或已被并发删除。
		const harnessForRecheck = await getHarnessForMaintenance();
		const recheck = await inspectTarget(harnessForRecheck, partnerId, externalId);
		if (!recheck.ok) return recheck;

		const internalId = recheck.target.internalId;
		const subtreeIds = await durableSubtree(internalId);
		const externalIds = await externalIdsOf(harnessForRecheck, subtreeIds);

		await closeHarnessForMaintenance();
		const db = await openNodeSqliteDatabase(DB_PATH);
		let deleted: DeletionEstimate;
		try {
			deleted = await deleteSubtreeRows(db, subtreeIds);
		} finally {
			await db.close();
		}
		console.log(
			`[partner-session-delete] 已删除分支会话：conversations=${deleted.conversations} entries=${deleted.entries} ` +
				`tasks=${deleted.tasks} submissions=${deleted.submissions} root=${externalId}`,
		);

		const harnessAfter = await getHarnessForMaintenance();
		await purgeChatMappings(harnessAfter, subtreeIds);
		purgeChatMetaEntries(externalIds);

		// 链接最后清：失败只 warn——列表本身按 Chats 过滤，孤儿 link 不会让已删会话重新出现。
		try {
			const changed = partnersStore().deleteSideLinkBySessionId(internalId);
			if (changed > 0) console.log(`[partner-session-delete] 已清副会话链接 ${externalId}`);
		} catch (error) {
			console.warn(
				`[partner-session-delete] 清副会话链接失败（会话已删）: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		return { ok: true as const, conversationId: externalId, deleted };
	});
}

/** 子树里的对外 id（给 chat-meta / ChatOrigins 清理用）。 */
async function externalIdsOf(harness: Harness, internalIds: readonly number[]): Promise<string[]> {
	const chats = await harness.snapshot(Chats, CTX);
	const wanted = new Set(internalIds.map(Number));
	return Object.entries(chats?.byExternal ?? {})
		.filter(([, internal]) => wanted.has(Number(internal)))
		.map(([externalId]) => externalId);
}
