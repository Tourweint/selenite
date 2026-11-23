import { scopeKey, type MemoryScope } from "@lifediary/memory";
import { CHIEF_PARTNER_ID } from "../partner-contract.ts";
import { partnersStore } from "../partners.ts";
import type { PartnersStore } from "../partner-store.ts";

/**
 * 会话归属项目（2026-11-15 项目记忆与外部导入区方案）+ 人格挂载（2026-11-15
 * 项目记忆挂载跟人走方案，同日第二批）。
 *
 * 绑定在 durable 的 ChatProjects（internalId → projectId），外键要经 Chats.byExternal
 * （externalId → internalId）换算，都要 harness 快照（async）。**本模块刻意零重依赖**：
 * - 不能 import lifecycle——assist→lifecycle 会成环（lifecycle-injections 顶层就取
 *   assist 的注入 provider，TDZ 炸模块）；
 * - 不能被 assist 静态 carry——tools.ts import 本模块，而 partner-work 等测试动态
 *   import tools.ts 时**刻意不起全局记忆引擎**，任何重依赖的传递加载都会握住它们的
 *   临时目录（2026-11-15 实测：tools→assist 链让 partner-work 的 rmSync EPERM）。
 * - 2026-11-15 下午起 import partners.ts / partner-contract.ts：两者已在 tools.ts 的
 *   既有加载面里（remember/recall 本就查 partnersStore），不加重传递加载；
 *   partner-contract 只读 env（除 node:path 外零 import）。
 *
 * 所以快照源由 lifecycle-harness 装配时注入（setProjectBindingsSource / setChatKindsSource）；
 * 未接线时项目 scope 一律为 null，行为与没有这个功能完全一致。
 *
 * 每轮注入是同步契约（collectInjections 不 await，见 injection.ts），注入侧用
 * TTL 缓存 + 后台刷新：重启后第一轮可能缺项目 scope，30 秒内自愈，无感知。
 * 工具路径（async execute）走 *OfConversationAsync 直查，不吃缓存。
 */

type ProjectBindingsSource = () => Promise<Array<readonly [number, string]>>;
/** ChatKinds 快照源（2026-11-15 人格挂载）：internalId → "chief" | "worker"。 */
type ChatKindsSource = () => Promise<Record<string, "chief" | "worker">>;

let projectBindingsSource: ProjectBindingsSource | null = null;
let projectScopeCache: { byConversation: Map<number, string>; at: number } | null = null;
const PROJECT_SCOPE_CACHE_TTL_MS = 30_000;

let chatKindsSource: ChatKindsSource | null = null;
let chatKindsCache: { byInternal: Map<number, string>; at: number } | null = null;
const CHAT_KINDS_CACHE_TTL_MS = 30_000;

/**
 * 项目名解析器（2026-11-15 项目记忆多挂载）：uuid → 项目名。注入行带归属
 * （`- [atlas · fact] …`）与负责项目索引都靠它。本模块刻意零重依赖，项目库
 * （projects.ts）由 lifecycle-harness 装配时接线，同 setProjectBindingsSource 惯例；
 * 未接线 / 查失败一律 null（行退回旧格式），记忆永远不能把对话卡住。
 */
type ProjectLabelResolver = (projectId: string) => string | null;

let projectLabelResolver: ProjectLabelResolver | null = null;

export function setProjectLabelResolver(resolver: ProjectLabelResolver | null): void {
	projectLabelResolver = resolver;
}

/** 同步取项目名；未接线 / 抛错 → null。只给注入路径用（同步契约，不能 await）。 */
export function projectNameOf(projectId: string): string | null {
	try {
		return projectLabelResolver?.(projectId) ?? null;
	} catch {
		return null;
	}
}

/**
 * 项目存活判定（2026-11-16 归档 / 删除项目退出召回库，用户拍板）。
 *
 * 归档 / 删除只影响**召回**，不影响存储：记忆仍留在库里、记忆页照旧能看能导出；
 * 恢复归档后自动回到召回池（这是过滤，不是删数据）。
 *
 * 三条召回入口都要过这道闸：每轮注入（recallContext）、recall 工具、负责项目索引。
 * 旧会话的 durable 绑定（ChatProjects）与人格挂载（partner.projectIds）都可能指向
 * 死项目——归档不摘挂载、删除也不清旧会话绑定，所以必须在装配候选池时现查。
 *
 * 解析器由 lifecycle-harness 接线（同 setProjectLabelResolver 惯例）；本模块零重依赖。
 * 未接线 / 抛错一律按 "active"（退回旧行为）——记忆永远不能因为一次辅助读取失败就不召回。
 */
export type ProjectState = "active" | "archived" | "missing";

type ProjectStateResolver = (projectId: string) => ProjectState;

let projectStateResolver: ProjectStateResolver | null = null;

export function setProjectStateResolver(resolver: ProjectStateResolver | null): void {
	projectStateResolver = resolver;
}

/** 同步取项目状态；未接线 / 抛错 → "active"（旧行为，见上）。 */
export function projectStateOf(projectId: string): ProjectState {
	try {
		return projectStateResolver?.(projectId) ?? "active";
	} catch {
		return "active";
	}
}

/** 记忆闸看到的状态（PROJECT_MEMORY_ACTIVE_ONLY 回滚开关 2026-11-21 退役）。 */
export function projectMemoryStateOf(projectId: string): ProjectState {
	return projectStateOf(projectId);
}

/** 只有"登记存在且未归档"的项目才进召回池；归档 / 删除一律剔除。 */
export function isRecallableProjectId(projectId: string): boolean {
	return projectMemoryStateOf(projectId) === "active";
}

/** 过滤一批项目 id（绑定 / 挂载），保持顺序；纯过滤，不动存储。 */
export function recallableProjectIds(ids: readonly string[]): string[] {
	return ids.filter((id) => isRecallableProjectId(id));
}

// ── 项目记忆写入解析（2026-11-15 多挂载方案）────────────────
// remember scope=project 的落点阶梯：**指名 → 绑定项目 → 唯一挂载 → 报错引导**。
// 指名必须在负责清单里——挂载 = 可达性，写到清单外后续 recall 查不着。
// 纯函数收 store 无关的输入（项目名在登记时全局唯一，renameProject 有同名校验），
// 单测直接喂表；工具层只负责把会话解析成这三个入参。

export interface ProjectWriteCandidate {
	readonly id: string;
	readonly name: string;
}

export type ProjectWriteResolution =
	| { ok: true; projectId: string }
	| {
			ok: false;
			code: "project_not_mounted" | "no_project_scope" | "project_ambiguous";
			message: string;
			hint: string;
	  };

export function resolveProjectWriteTarget(
	named: string | undefined,
	bound: string | null,
	mounted: readonly ProjectWriteCandidate[],
): ProjectWriteResolution {
	const wanted = named?.trim();
	if (wanted) {
		const exact = mounted.find((entry) => entry.name === wanted);
		const loose = exact
			? [exact]
			: mounted.filter((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
		if (loose.length === 1) return { ok: true, projectId: loose[0].id };
		const names = mounted.map((entry) => entry.name).join("、");
		return {
			ok: false,
			code: "project_not_mounted",
			message:
				`「${wanted}」不在你负责的项目里${names ? `（${names}）` : ""}。` +
				`要写它的项目记忆，先把「${wanted}」加进负责项目（设置 → 人设）。`,
			hint: "用负责项目清单里的完整项目名重试，或先把项目加进负责项目。",
		};
	}
	if (bound) return { ok: true, projectId: bound };
	if (mounted.length === 1) return { ok: true, projectId: mounted[0].id };
	if (mounted.length === 0) {
		return {
			ok: false,
			code: "no_project_scope",
			message:
				"这个会话没有可挂的项目记忆：干活会话跟项目文件夹走；" +
				"总管 / 执事可以在「设置 → 人设」的档案页里勾选负责的项目。",
			hint: "项目相关的口径也可以先记成普通记忆（不带 scope 参数）。",
		};
	}
	const names = mounted.map((entry) => entry.name).join("、");
	return {
		ok: false,
		code: "project_ambiguous",
		message: `你负责多个项目（${names}）：用 remember 的 project 参数指名要写进哪个。`,
		hint: "带上 project 参数和负责项目清单里的项目名重试。",
	};
}

/**
 * 每轮注入的项目 scope 组装（2026-11-15 多挂载，供 recallContext）：
 * 绑定项目由调用方全权进池；这里只出**其余挂载项目**的键（一律走「聊到才注入」
 * 硬闸——PROJECT_MEMORY_GATE 回滚开关 2026-11-21 退役）。绑定与挂载重叠时去重。
 * 纯函数，单测直接喂。
 */
export function composeProjectRecallScopes(
	boundProjectId: string | null,
	mountedProjectIds: readonly string[],
): string[] {
	const boundKey = boundProjectId ? scopeKey({ type: "project", id: boundProjectId }) : null;
	return [
		...new Set(mountedProjectIds.map((id) => scopeKey({ type: "project", id }))),
	].filter((key) => key !== boundKey);
}

/** lifecycle-harness 装配时接线；测试/未接线时项目 scope 一律为 null（与旧行为一致）。 */
export function setProjectBindingsSource(source: ProjectBindingsSource | null): void {
	projectBindingsSource = source;
}

/** 同上：kind 判定快照源（durable 的 ChatKinds.byInternal）。未接线时人格挂载只认链接执事。 */
export function setChatKindsSource(source: ChatKindsSource | null): void {
	chatKindsSource = source;
	chatKindsCache = null;
}

async function refreshProjectScopeCache(): Promise<void> {
	if (!projectBindingsSource) return;
	try {
		const pairs = await projectBindingsSource();
		projectScopeCache = { byConversation: new Map(pairs), at: Date.now() };
	} catch {
		// 读不到（还没起 / 迁移中）就不带项目 scope，不影响对话——与 recallContext 的降级口径一致
	}
}

async function refreshChatKindsCache(): Promise<void> {
	if (!chatKindsSource) return;
	try {
		const byInternal = await chatKindsSource();
		chatKindsCache = {
			byInternal: new Map(
				Object.entries(byInternal ?? {}).map(([key, kind]) => [Number(key), kind]),
			),
			at: Date.now(),
		};
	} catch {
		// 同上：读不到就不带人格挂载，不影响对话
	}
}

/** 每轮注入用（同步）：缓存命中即用，过期后台刷新。 */
export function projectScopeOfConversation(conversationId: number): MemoryScope | null {
	const now = Date.now();
	if (!projectScopeCache || now - projectScopeCache.at > PROJECT_SCOPE_CACHE_TTL_MS) {
		projectScopeCache = projectScopeCache ?? { byConversation: new Map(), at: now };
		projectScopeCache.at = now;
		void refreshProjectScopeCache();
	}
	const projectId = projectScopeCache.byConversation.get(conversationId);
	return projectId ? { type: "project", id: projectId } : null;
}

/** 工具路径用（async）：直接读快照，不吃缓存。 */
export async function projectIdOfConversation(conversationId: number): Promise<string | null> {
	if (!projectBindingsSource) return null;
	try {
		const pairs = await projectBindingsSource();
		return pairs.find(([id]) => id === conversationId)?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * 人格挂载的**纯解析**（供单测）：链接执事 → 该执事的挂载；未链接且 kind=chief →
 * 总管的挂载；worker → 空数组（干活会话跟文件夹走，不吃总管的挂载）。
 * 与 partner-rows 的 resolvePartnerScope 同设计：纯函数收 store，单测直接喂临时库。
 * 2026-11-15 多挂载方案：返回 uuid 数组（档案可挂多个项目）。
 */
export function personaProjectIdsOfSession(
	store: PartnersStore,
	sessionId: number,
	kind: "chief" | "worker" | null,
): string[] {
	const linked = store.partnerIdOfSession(sessionId);
	if (linked) return store.get(linked)?.projectIds ?? [];
	if (kind !== "chief") return [];
	return store.get(CHIEF_PARTNER_ID)?.projectIds ?? [];
}

/**
 * 人格挂载（2026-11-15 跟人走立项、同日多挂载方案扩化）：总管 / 执事档案勾选的
 * "负责项目"清单。**挂载 = 可达性**：recall 全部可查、聊到的自动浮出（注入闸门在
 * assist 组装层）、remember 可指名写入——不是"每轮整包搬进上下文"。
 *
 * - 执事会话（链接表）→ 该执事档案的 projectIds；
 * - 总管主对话（未链接 + kind=chief）→ 总管档案的 projectIds；
 * - worker / 未接线 / 开关关 → 空数组。
 *
 * kind 判定与 session-open 的 chatKindOfInternal 同语义：**不是显式 worker 就算 chief**
 * （缺缓存时同口径，30 秒自愈，与项目 scope 缓存的降级一致）。
 * 每轮注入同步用；查失败一律空数组，记忆永远不能把对话卡住。
 */
export function personaProjectIdsOfConversation(conversationId: number): string[] {
	//（PARTNER_PROJECT_MEMORY 回滚开关 2026-11-21 退役：跟人走是唯一形态。）
	try {
		const now = Date.now();
		if (!chatKindsCache || now - chatKindsCache.at > CHAT_KINDS_CACHE_TTL_MS) {
			chatKindsCache = chatKindsCache ?? { byInternal: new Map(), at: now };
			chatKindsCache.at = now;
			void refreshChatKindsCache();
		}
		const kind = chatKindsCache.byInternal.get(conversationId) === "worker" ? "worker" : "chief";
		return personaProjectIdsOfSession(partnersStore(), conversationId, kind);
	} catch {
		return [];
	}
}

/** 工具路径用（async）：与 projectIdOfConversation 同口径，kind 直查快照不吃缓存。 */
export async function personaProjectIdsOfConversationAsync(
	conversationId: number,
): Promise<string[]> {
	try {
		const store = partnersStore();
		const linked = store.partnerIdOfSession(conversationId);
		if (linked) return store.get(linked)?.projectIds ?? [];
		if (!chatKindsSource) return [];
		const byInternal = await chatKindsSource();
		if (byInternal?.[String(conversationId)] === "worker") return [];
		return store.get(CHIEF_PARTNER_ID)?.projectIds ?? [];
	} catch {
		return [];
	}
}
