/**
 * 注入框架（2026-11-10 批 26b §二 / #7 批 A）。
 *
 * 背景：提示词注入目前散在两处——lifecycle 的 7 个 `sections[].render`（system 段，
 * 会进 durable 的 `pi.system`）与 beforeRequest 里 5 处 `extra.push({role:"system"})`
 * （每轮模型请求前临时拼）。这一层只做**收集 + 规范排序 + 去重 + 分流**，
 * 把"有哪些注入、从哪来、多大"变成可审计的清单；本批**只接管 `injection_guard` 一个**，
 * 其余 6 个 section 与 5 处 extra.push 一律不动（逐字节保持改造前形态）。
 *
 * 硬标准：接管后 `injection_guard` 的内容与位置与改造前逐字节一致——
 * section 仍留在 lifecycle `sections` 数组的原下标，`render` 改走本框架取回同一段
 * `INJECTION_GUARD` 实文。框架自身的 order 只用于框架内排序，不决定 section 的物理位置。
 */

import { INJECTION_GUARD, injectionGuardEnabled } from "./injection-guard.ts";

export type InjectionScope = "session" | "once" | "turn";
export type InjectionChannel = "system" | "message";

export interface InjectionEntry {
	id: string;
	text: string;
	order: number;
	scope: InjectionScope;
	channel: InjectionChannel;
}

/**
 * 收集上下文。批 A 里 provider 都不读它，但框架要留这个口子给后续批次接会话级注入
 * （某会话要不要注、注哪一段）。只读、不下发客户端。
 */
export interface InjectionContext {
	conversationId: number | string;
}

export type InjectionProvider = (
	ctx: InjectionContext,
) => InjectionEntry | InjectionEntry[] | undefined;

export interface CollectedInjections {
	system: InjectionEntry[];
	message: InjectionEntry[];
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 收集 → 规范排序 → 按 id 去重（后者覆盖）→ 按 channel 分流。
 *
 * 排序：`order` 升序；同 `order` 按 `id` 字典序；`order` 与 `id` 都相同时再按
 * `channel`/`scope`/`text` 补成全序——这样"打乱 providers / 条目输入顺序"输出也恒定，
 * 不会因稳定排序保留了输入顺序而让去重结果随输入抖。
 *
 * 去重（后者覆盖）：保留规范序里某 `id` **最后一次**出现的位置（后面覆盖前面），
 * 因此结果仍是有序的；同名 id 里 order / 字典序更大的那个胜出。
 */
export function collectInjections(
	providers: readonly InjectionProvider[],
	ctx: InjectionContext,
): CollectedInjections {
	const all: InjectionEntry[] = [];
	for (const provider of providers) {
		const result = provider(ctx);
		if (result === undefined) continue;
		if (Array.isArray(result)) all.push(...result);
		else all.push(result);
	}

	all.sort(
		(a, b) =>
			a.order - b.order ||
			cmp(a.id, b.id) ||
			cmp(a.channel, b.channel) ||
			cmp(a.scope, b.scope) ||
			cmp(a.text, b.text),
	);

	const lastIndexById = new Map<string, number>();
	all.forEach((entry, index) => lastIndexById.set(entry.id, index));
	const deduped = all.filter((entry, index) => lastIndexById.get(entry.id) === index);

	return {
		system: deduped.filter((entry) => entry.channel === "system"),
		message: deduped.filter((entry) => entry.channel === "message"),
	};
}

// ── 批 A 唯一接管的注入：injection_guard ───────────────────────────
/** section key / 注入 id，框架内统一用这个标识。 */
export const INJECTION_GUARD_ID = "injection_guard";

/**
 * `injection_guard` provider：`AGENT_INJECTION_GUARD=false/0/off` 时返回 undefined，
 * 框架据此省略整段（与改造前 `render` 直接返回 undefined 逐字节一致）。
 */
export const guardProvider: InjectionProvider = () => {
	if (!injectionGuardEnabled()) return undefined;
	return {
		id: INJECTION_GUARD_ID,
		text: INJECTION_GUARD,
		// 批 A 只有这一个 provider；order 只作框架内排序，section 物理位置由 lifecycle 数组下标决定。
		order: 0,
		scope: "session",
		channel: "system",
	};
};

/** 框架登记的注入源：`source` 是审计用的来源标识，不进正文、不下发正文。 */
export interface RegisteredInjection {
	source: string;
	provider: InjectionProvider;
}

/** 批 A：只此一个。其余 section / extra.push 还没接管，绝不在这里冒名登记。 */
export const INJECTION_REGISTRY: readonly RegisteredInjection[] = [
	{ source: INJECTION_GUARD_ID, provider: guardProvider },
];

/**
 * 审计开关（默认开；显式 `false` 关，关时 `.../injections` 端点 404，一行回滚）。
 * 新开关净增类默认开，与仓库其它开关同口径。
 */
export function injectionAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_INJECTION_AUDIT ?? "").trim().toLowerCase() !== "false";
}

export interface InjectionAuditRow {
	id: string;
	source: string;
	scope: InjectionScope;
	/** 正文字符数；只回长度，不回正文。 */
	length: number;
}

/**
 * 审计投影：对登记的每个源走一遍收集，产出 `{id, source, scope, length}`。
 * **绝不返回 `text` 或任何正文片段**——审计端点可以把这份数组原样下发。
 */
export function auditInjections(ctx: InjectionContext): InjectionAuditRow[] {
	const rows: InjectionAuditRow[] = [];
	for (const { source, provider } of INJECTION_REGISTRY) {
		const { system, message } = collectInjections([provider], ctx);
		for (const entry of [...system, ...message]) {
			rows.push({ id: entry.id, source, scope: entry.scope, length: entry.text.length });
		}
	}
	return rows;
}
