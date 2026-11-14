/**
 * 行类型（伙伴 / 版本 / 会话挂接 / 模型链 / 例行触发与定义 / 群与消息）
 *
 * 2026-11-13 从 partners.ts 的 L112–L293 整段切出；正文原文搬运，未改一行实现。
 */

import { join } from "node:path";
import type { PartnerPersonaModule, PartnerPersonaPreset } from "@lifediary/shared";

export type PartnerStatus = "active" | "paused" | "archived";

export interface PartnerRow {
	id: string;
	name: string;
	status: PartnerStatus;
	/** 当前身份快照版本号；还没建过版本 = null */
	currentVersion: number | null;
	createdAt: string;
	updatedAt: string;
	/** 执事的领域名（批次D D2）；普通执事为 null。小写 ASCII，同 chancellor DOMAIN_PATTERN。 */
	domain: string | null;
	/**
	 * 头像（2026-11-06 侧栏调整 B1）：有界 PNG data URL，或 null（未设置 → 前端用名字首字）。
	 * 只供 `<img>` 渲染；服务端不存路径、不收外部 URL、不收 SVG（理由见 shared 的 PartnerAvatarSchema）。
	 */
	avatar: string | null;
	/**
	 * 派发权（2026-11-06 执事派发权开关）：带 domain 的执事是否作为分管负责人接单。
	 * 默认关。只对带 domain 的执事有意义。
	 */
	dispatchAuthority: boolean;
	/**
	 * 当前目标（2026-11-08 员工人格化刀二 E4）：这一阵子在奔什么，用户 / 总管可改。
	 * **不版本化**（不是身份，是现取现用的状态），只进 detail 端点与 PATCH，
	 * 列表形状不变（字段经 shared 暴露在刀三）。空串 / null = 清除。
	 */
	currentGoal: string | null;
	/**
	 * 口头禅（2026-11-12 手机对话身份方案 §四）：一句常说的话，≤40 字（Unicode code point）。
	 * **不版本化**（不是身份，不 bump 版本、不动 SOUL / 契约）；null = 未设置。
	 * 列表与详情投影都带（首页 / 空态零额外请求）。
	 */
	tagline: string | null;
	/**
	 * 日记执事（2026-11-12 日记 v2）：true = 这个执事是「和小记聊天」那条日记线的固定对象。
	 * 全局至多一个（写 true 时同事务清掉其他执事）；不版本化，不参与派活路由。
	 */
	diary: boolean;
	/**
	 * 人格预设（2026-11-14 员工人格模块 §四）：`work`（默认）/ `companion` / `custom`。
	 * 只决定模块开关的默认值；**不版本化**（人格模块不是身份，不 bump 版本、不动 SOUL / 契约）。
	 */
	personaPreset: PartnerPersonaPreset;
	/**
	 * 人格模块开关（2026-11-14）：14 个 id → bool，只存**显式改过**的键；
	 * 缺省键按 `personaPreset` 的默认值算（`effectivePersonaModules`）。
	 * 同样是状态不是身份：一条 UPDATE 落地，不 bump 版本。
	 */
	personaModules: Partial<Record<PartnerPersonaModule, boolean>>;
}

export interface PartnerVersionRow {
	partnerId: string;
	version: number;
	/** SOUL.md 正文快照（冻结） */
	soulSource: string;
	/**
	 * CONTRACT.md 正文快照（2026-11-08 员工人格化刀一 E1，冻结）。
	 * 一个身份版本 = 当时的 SOUL + CONTRACT 对；改任一文本都 bump 版本并落双快照。
	 * `null` = 该版本没有契约快照（老库 / 总管 / 开关关着时建的家）。
	 */
	contractSource: string | null;
	/** 能力 JSON：模型候选链（B4）+ 预留位；只允许存引用（keyEnv 名），不允许存值 */
	capabilities: string | null;
	createdAt: string;
}

export interface PartnerSessionLinkRow {
	partnerId: string;
	/**
	 * `delegation` = 执事的领域路由（批次D D2），这类链接没有宿主会话，sessionId 为占位 0；
	 * `group` = 执事在某群的成员会话（2026-11-06 群组方案），routeKey = `group:<群id>`。
	 */
	role: "canonical" | "routine" | "topic" | "delegation" | "group";
	routeKey: string | null;
	/** durable 内部自增会话 id（不外泄） */
	sessionId: number;
	/** 该会话最近一次应用过的身份版本（下一轮生效契约的记账位） */
	appliedVersion: number | null;
	createdAt: string;
}

export interface ModelChainItemLike {
	providerId: string;
	modelId: string;
	keyEnv: string;
	thinkingLevel?: string;
}

export interface RoutineTriggerGates {
	/**
	 * 前置条件（`ROUTINE_CONDITIONAL` 开时生效）：触发前先问模型"这句成立吗"，
	 * 不成立就跳过本轮（记一条 skipped run，不消耗 maxRuns）。判定见 routine-gate.ts。
	 */
	if?: { note: string };
	/**
	 * 结束条件：`at` = 到这个时间点后不再触发；`after` = 跑满 N 次后停
	 * （`maxRuns` 的别名，两者同时存在取更小的）。判定见 routine-conditions.ts。
	 */
	ends?: { at?: string; after?: number };
}

export type RoutineTrigger = RoutineTriggerGates &
	(
		| { type: "cron"; expr: string }
		| { type: "interval"; seconds: number }
		| { type: "once"; at: string }
		| {
				type: "event";
				kind: "delegation" | "tool" | "phase";
				match?: Record<string, string>;
				/**
				 * 三件门（2026-11-10 批 15 §一，`ROUTINE_TRIGGER_GATES` 默认开）：
				 * 只对 event 触发器生效，三个可选字段可组合。判定在 routine-conditions.ts。
				 */
				baseline?: { key: string; delta: number };
				edge?: true;
				cooldownSec?: number;
		  }
	);

export interface RoutineDef {
	id: string;
	partnerId: string;
	name: string;
	/** 每次触发的指令正文（≤100k，cindy 同款上限） */
	prompt: string;
	triggers: RoutineTrigger[];
	/** persistent = 复用主会话（跟进类保上下文）；fresh = 每次全新专线（检查类防污染） */
	sessionMode: "persistent" | "fresh";
	enabled: boolean;
	/**
	 * 完成条件（2026-11-10 批 13 §四.1）：一句**文字条件**，每轮跑完由模型自己判断
	 * 达成没有；判达成 → `enabled=false`（不删，保留历史）。不做表达式引擎。
	 * `ROUTINE_CONDITIONAL=false` 时忽略（老规则不受影响）。
	 */
	until?: { note: string };
	/** 跑满 N 次自动停（同上开关；比 ends={after,at,times} 全套便宜）。 */
	maxRuns?: number;
	/** 每次修改 +1：durable 任务带着旧 revision 醒来时据此作废（替代"取消任务"） */
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export type GroupResponderKind = "member" | "everyone" | "mentions";

export interface GroupRow {
	id: string;
	name: string;
	/** 群公告（≤500 字），随每轮输入注入成员会话 */
	notice: string;
	responderKind: GroupResponderKind;
	/** kind=member 时的值日执事；必须是群成员 */
	responderPartnerId: string | null;
	/**
	 * 成员按 position 升序；只存引用，人格 = 各自 SOUL。
	 * avatar / domain 是**实时 join 档案表**得出的展示字段（不落 group_members）：
	 * 头像给群复合头像用，domain 给 @名字·domain 长标签消歧用（2026-11-08 批三）。
	 */
	members: Array<{
		partnerId: string;
		name: string;
		position: number;
		status: PartnerStatus;
		avatar: string | null;
		domain: string | null;
	}>;
	createdAt: string;
	updatedAt: string;
}

export interface GroupMessageRow {
	id: string;
	groupId: string;
	/** 群内单调序号（从 1 起），回读分页用 beforeSeq */
	seq: number;
	kind: "message" | "system";
	authorKind: "user" | "partner" | "system";
	authorId: string | null;
	/** 作者名快照：不 join 成员表，改名/离群后历史不变（cindy 四件套） */
	authorName: string;
	content: string;
	at: string;
	roundId: string | null;
}
