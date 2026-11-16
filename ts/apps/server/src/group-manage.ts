import {
	GROUP_MEMBER_MAX,
	GROUP_MEMBER_MIN,
	type GroupResponderKind,
} from "@lifediary/shared";
import {
	COMPANIONS_ENABLED,
	partnersStore,
	type GroupRow,
	type PartnersStore,
} from "./partners.ts";
import { flagEnabled } from "./flags.ts";

/**
 * 群组核心（2026-11-07 群组入口统一）：**唯一一份**建群校验与落库实现。
 *
 * HTTP 端点（group-api.ts 的 POST /api/v1/groups）与模型侧工具（tools.ts 的 group_manage）
 * 都调这里，避免"端点一套、工具一套"漂移——同 partner-manage.ts 的分层纪律。
 *
 * 为什么 GROUPS_ENABLED 也搬到这里：工具侧要按同一个开关决定注不注册
 * （关掉 = 一行回滚，模型也够不到建群），而 group-api 是 HTTP 装配层，
 * 工具不该反向 import 它。group-api 原样 re-export，既有 import 不受影响。
 *
 * 存储通过 GroupContext 注入：生产用 defaultGroupContext()，单测传临时目录，不碰真实 .data/。
 */

/** 回滚开关（方案 §2.7）：false = 群端点一个不挂、group_manage 工具不注册 */
export const GROUPS_ENABLED = flagEnabled("GROUPS_ENABLED");

export function groupsAvailable(): boolean {
	return GROUPS_ENABLED && COMPANIONS_ENABLED;
}

export interface GroupContext {
	store: PartnersStore;
}

export function defaultGroupContext(): GroupContext {
	return { store: partnersStore() };
}

export type GroupResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

const RESPONDER_KINDS: GroupResponderKind[] = ["member", "everyone", "mentions"];

/** 与端点逐字一致的口径（历史消息里的 400 文案不许变）：未知值回落值日制。 */
export function normalizeResponderKind(raw: string | undefined | null): GroupResponderKind {
	return raw && RESPONDER_KINDS.includes(raw as GroupResponderKind)
		? (raw as GroupResponderKind)
		: "member";
}

export interface CreateGroupInput {
	name?: string;
	memberIds?: string[];
	responderKind?: string;
	responderPartnerId?: string | null;
	notice?: string;
}

/**
 * 建群（校验 + 落库）。校验顺序与文案沿用 2026-11-06 端点实现，逐字不变：
 * 群名 → 公告 → 人数 → 执事存在 → 重名 → 值日。
 */
export function createGroupChecked(
	input: CreateGroupInput,
	store: PartnersStore,
): GroupResult<GroupRow> {
	const name = input.name?.trim() ?? "";
	if (!name || name.length > 40) {
		return { ok: false, error: "name 必填且不超过 40 字" };
	}
	const notice = typeof input.notice === "string" ? input.notice : "";
	if (notice.length > 500) {
		return { ok: false, error: "公告不超过 500 字" };
	}
	const memberIds = [
		...new Set((input.memberIds ?? []).map((id) => String(id).trim()).filter(Boolean)),
	];
	if (memberIds.length < GROUP_MEMBER_MIN || memberIds.length > GROUP_MEMBER_MAX) {
		return {
			ok: false,
			error: `成员要 ${GROUP_MEMBER_MIN}–${GROUP_MEMBER_MAX} 名执事`,
		};
	}
	const members = memberIds.map((id) => store.get(id));
	if (members.some((m) => !m)) {
		return { ok: false, error: "有执事不存在，刷新后再试" };
	}
	if (new Set(members.map((m) => m!.name)).size !== members.length) {
		return { ok: false, error: "群里有重名执事，@ 会分不清人，请先改名" };
	}
	const kind = normalizeResponderKind(input.responderKind);
	let duty: string | null = input.responderPartnerId?.trim() || null;
	if (kind === "member") {
		if (!duty) {
			return { ok: false, error: "值日执事必选（不 @ 就发给谁）" };
		}
		if (!memberIds.includes(duty)) {
			return { ok: false, error: "值日执事必须是群成员" };
		}
	} else {
		duty = null;
	}
	const group = store.createGroup({
		name,
		notice,
		responderKind: kind,
		responderPartnerId: duty,
		memberIds,
	});
	return { ok: true, value: group };
}

/** 按名字查一位在册执事；重名 / 查无此人都拒绝，交给调用方拼文案。 */
function findOneByName(
	name: string,
	store: PartnersStore,
): { ok: true; value: { id: string; name: string } } | { ok: false; error: "missing" | "ambiguous" } {
	const hits = store.list().filter((partner) => partner.status === "active" && partner.name === name);
	if (hits.length === 0) return { ok: false, error: "missing" };
	if (hits.length > 1) return { ok: false, error: "ambiguous" };
	return { ok: true, value: { id: hits[0]!.id, name: hits[0]!.name } };
}

/**
 * 把工具传来的成员名解析成执事 id（模型侧建群用）。
 *
 * 模型拿不到、也不该拿到执事 uuid（对外 id 一律 uuid 这条口径不破），所以工具只收名字。
 * 重名必须拒绝：群里的 @ 解析按名字做，重名会让点名变成歧义（方案 §2.3）。
 */
export function resolvePartnersByName(
	names: string[],
	store: PartnersStore,
): GroupResult<Array<{ id: string; name: string }>> {
	const wanted = [...new Set(names.map((name) => String(name).trim()).filter(Boolean))];
	if (wanted.length < GROUP_MEMBER_MIN || wanted.length > GROUP_MEMBER_MAX) {
		return { ok: false, error: `成员要 ${GROUP_MEMBER_MIN}–${GROUP_MEMBER_MAX} 名执事` };
	}
	const picked: Array<{ id: string; name: string }> = [];
	for (const name of wanted) {
		const hit = findOneByName(name, store);
		if (!hit.ok) {
			if (hit.error === "ambiguous") {
				return { ok: false, error: `有不止一位执事叫「${name}」，先改名再建群` };
			}
			const available = store
				.list()
				.filter((partner) => partner.status === "active")
				.map((partner) => partner.name)
				.join("、");
			return {
				ok: false,
				error: `找不到执事「${name}」。现有执事：${available || "（暂无执事）"}`,
			};
		}
		picked.push(hit.value);
	}
	return { ok: true, value: picked };
}

/** 按名字查值日执事。名字为空时返回 null，交给调用方决定缺省。 */
export function resolvePartnerByName(
	name: string | undefined | null,
	store: PartnersStore,
): GroupResult<{ id: string; name: string } | null> {
	const trimmed = name?.trim() ?? "";
	if (!trimmed) return { ok: true, value: null };
	const hit = findOneByName(trimmed, store);
	if (!hit.ok) {
		return {
			ok: false,
			error:
				hit.error === "ambiguous"
					? `有不止一位执事叫「${trimmed}」，先改名再建群`
					: `找不到执事「${trimmed}」（值日执事必须是群成员）`,
		};
	}
	return { ok: true, value: hit.value };
}
