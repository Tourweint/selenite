/**
 * 群组发言路由（2026-11-06 群组方案 §2.3）——**纯函数，可单测**。
 *
 * 排序交给模型在多方场景必乱（四家参考仓库共识），所以谁发言由这里按确定性规则定：
 *   @点名 > @所有人 > 值日执事。
 *
 * @ 解析是纯文本纯函数（OpenMausBot 口径）：最长标签优先、要求词边界、
 * 重名歧义**拒绝不猜**（400 抛回 + 候选清单，前端据此给长标签）。
 * 2026-11-08 批三加**唯一长标签** `@名字·<domain>`：重名时给用户一个能写对的形式，
 * 而不是让后端猜；长标签写错域 = 按普通文本处理，不命中也不回退短名（同样是"不猜"）。
 * 本模块不 import 任何运行时——agent/partner 一概不碰，防依赖成环。
 */

import type { GroupResponderKind } from "./partners.ts";

/** 群成员参与路由所需的最小形状（真行在 partners.ts，这里解耦） */
export interface GroupMemberLike {
	partnerId: string;
	name: string;
	position: number;
	/** 执事域（chancellor domain，全局唯一）；没有 = 只能用短名点名 */
	domain?: string | null;
}

/** 重名候选（400 载荷用）：名字 + 领域，前端据此拼长标签 */
export interface MentionCandidate {
	name: string;
	domain: string | null;
}

/** @ 解析失败：调用方（端点层）把它映射成 400 带说明（+ 可选候选清单） */
export class GroupRouteError extends Error {
	readonly candidates?: MentionCandidate[];

	constructor(message: string, candidates?: MentionCandidate[]) {
		super(message);
		this.name = "GroupRouteError";
		this.candidates = candidates;
	}
}

/** 长标签分隔符：`@名字·domain`（中文间隔号，与用户输入法一致） */
const LONG_LABEL_SEP = "·";

/** 领域 token：小写 ASCII（字母/数字/连字符，companion-api 同口径） */
const DOMAIN_TOKEN = /^[a-z0-9][a-z0-9-]*/i;

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
 * - **唯一长标签** `@名字·<domain>`：名字后紧跟 `·` 且后面是领域 token 时按长标签解析，
 *   只认 domain 恰好等于该成员领域的那个；打错域 / 域不唯一 → 不命中（按普通文本，不猜、不回退短名）；
 * - 重名 = 歧义：短名命中重名成员时抛错，错误里带候选清单（`[{name, domain}]`）——
 *   这是给前端拼长标签用的**表达形式**，解析本身仍然不猜。
 *   重名但正文没写这个名字时不报错（不 @ 时走值日，不该被别人的重名拦住）。
 */
export function parseMentionedIds(text: string, members: GroupMemberLike[]): string[] {
	const byName = new Map<string, GroupMemberLike[]>();
	for (const member of members) byName.set(member.name, [...(byName.get(member.name) ?? []), member]);

	const names = [...byName.keys()].sort((a, b) => b.length - a.length);
	const hitIds: string[] = [];
	for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
		const prev = at > 0 ? text[at - 1] : "";
		// 词边界：前一位还是词字符（或已是 @ 的转义）就不算点名
		if (/[A-Za-z0-9_@]/.test(prev)) continue;
		for (const name of names) {
			if (!text.startsWith(name, at + 1)) continue;
			const same = byName.get(name)!;
			const after = at + 1 + name.length;
			// 长标签：`@名字·domain`
			if (text[after] === LONG_LABEL_SEP) {
				const token = DOMAIN_TOKEN.exec(text.slice(after + 1))?.[0] ?? "";
				if (token) {
					const matched = same.filter(
						(member) =>
							member.domain !== null &&
							member.domain !== undefined &&
							member.domain.toLowerCase() === token.toLowerCase(),
					);
					// 兜住"同名同域"这种不该存在的数据：不唯一也不猜
					if (matched.length === 1) hitIds.push(matched[0]!.partnerId);
					at = after + 1 + token.length;
					break;
				}
			}
			if (same.length > 1) {
				throw new GroupRouteError(
					`群里有重名成员「${name}」，@ 会分不清人。改用 @${name}·<领域> 点名，或先改名`,
					same.map((member) => ({ name: member.name, domain: member.domain ?? null })),
				);
			}
			hitIds.push(same[0]!.partnerId);
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
