/**
 * 群组发言路由（2026-11-06 群组方案 §2.3）——**纯函数，可单测**。
 *
 * 排序交给模型在多方场景必乱（四家参考仓库共识），所以谁发言由这里按确定性规则定：
 *   @点名 > @所有人 > 值日执事。
 *
 * @ 解析是纯文本纯函数（OpenMausBot 口径）：最长标签优先、要求词边界、
 * 重名歧义**拒绝不猜**（400 抛回，cindy/OpenMausBot 同款；点选消歧留给批三候选）。
 * 本模块不 import 任何运行时——agent/partner 一概不碰，防依赖成环。
 */

import type { GroupResponderKind } from "./partners.ts";

/** 群成员参与路由所需的最小形状（真行在 partners.ts，这里解耦） */
export interface GroupMemberLike {
	partnerId: string;
	name: string;
	position: number;
}

/** @ 解析失败：调用方（端点层）把它映射成 400 带说明 */
export class GroupRouteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GroupRouteError";
	}
}

/** 转义正则元字符——成员名是用户起的，不能当模式用 */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从正文解析 @点名，返回被点中的成员 partnerId（按正文出现顺序，未去重）。
 *
 * 规则：
 * - 扫描每个 `@`，候选**最长名优先**——`@阅读助手斋` 在「阅读助手斋」「阅读助手」都在群里时点中「阅读助手斋」；
 * - 词边界：`@` 前一位不能是「名字会跟 @ 粘连成词」的字符（字母/数字/下划线/@），
 *   防止邮箱尾缀 `a@阅读助手` 这类误点；
 * - 重名 = 歧义：群里有两个同名成员时，@ 这个名字直接抛错（拒绝不猜）。
 */
export function parseMentionedIds(text: string, members: GroupMemberLike[]): string[] {
	// 重名在群里是 @ 歧义源：解析前就拒，报错文案指向改名（方案 §七）
	const byName = new Map<string, GroupMemberLike[]>();
	for (const member of members) byName.set(member.name, [...(byName.get(member.name) ?? []), member]);
	for (const [name, same] of byName) {
		if (same.length > 1) {
			throw new GroupRouteError(`群里有重名成员「${name}」，@ 会分不清人，请先改名`);
		}
	}

	const names = [...byName.keys()].sort((a, b) => b.length - a.length);
	const hitIds: string[] = [];
	for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
		const prev = at > 0 ? text[at - 1] : "";
		// 词边界：前一位还是词字符（或已是 @ 的转义）就不算点名
		if (/[A-Za-z0-9_@]/.test(prev)) continue;
		for (const name of names) {
			if (!text.startsWith(name, at + 1)) continue;
			hitIds.push(byName.get(name)![0].partnerId);
			at += name.length; // 命中后跳过整段名字，名字里再含 @ 也不二次解析
			break;
		}
	}
	return hitIds;
}

export interface GroupRouteSpec {
	responderKind: GroupResponderKind;
	/** kind=member 时的值日执事 id */
	responderPartnerId?: string | null;
}

/**
 * 正文 → 这一轮谁发言（按顺序串行，已去重）。
 *
 * 1. @点名 ≥1 → 被点名者（正文出现顺序）；
 * 2. `@所有人` → 全员按 position；
 * 3. 无 @ → responderKind：member=值日 / everyone=全员 / mentions=没人（调用方落 system 行）。
 *
 * 抛 GroupRouteError = 端点层要回 400 的那种错（重名歧义）；值日不在群里这类
 * 配置错误不该走到发言时才炸，端点在写入口就校验。
 */
export function resolveGroupSpeakers(
	text: string,
	spec: GroupRouteSpec,
	members: GroupMemberLike[],
): string[] {
	const active = members.filter((m) => Boolean(m.name));
	if (text.includes("@所有人")) {
		return [...active].sort((a, b) => a.position - b.position).map((m) => m.partnerId);
	}
	const mentioned = parseMentionedIds(text, active);
	if (mentioned.length > 0) {
		// 去重保序：同一个人被 @ 两次只回一次
		return [...new Set(mentioned)];
	}
	if (spec.responderKind === "everyone") {
		return [...active].sort((a, b) => a.position - b.position).map((m) => m.partnerId);
	}
	if (spec.responderKind === "member") {
		const duty = spec.responderPartnerId;
		return duty && active.some((m) => m.partnerId === duty) ? [duty] : [];
	}
	// mentions：只有点名才有人回
	return [];
}
