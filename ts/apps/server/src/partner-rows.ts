/**
 * 解析与映射（单例 / 人格 / 作用域 / 行转对象 / 默认 SOUL）
 *
 * 2026-11-13 从 partners.ts 的 L1351–L1531 整段切出；正文原文搬运，未改一行实现。
 */

import { MemoryScope } from "@lifediary/memory";
import {
	PartnerPersonaModuleIds,
	PARTNER_MOODS,
	PARTNER_OWNER_TIERS,
	type PartnerMood,
	type PartnerOwnerTier,
	type PartnerPersonaModule,
	type PartnerPersonaPreset,
	type PartnerPersonaSwitches,
} from "@lifediary/shared";
import { join } from "node:path";
import { CHIEF_PARTNER_ID, COMPANIONS_ENABLED, chiefPartnerEnabled } from "./partner-contract.ts";
import type { GroupMessageRow, GroupResponderKind, GroupRow, PartnerRow, PartnerSessionLinkRow, PartnerStatus, RoutineDef, RoutineTrigger } from "./partner-types.ts";
import { PartnersStore } from "./partner-store.ts";

let store: PartnersStore | null = null;

export function partnersStore(): PartnersStore {
	store ??= new PartnersStore();
	return store;
}

export function ensureChiefPartner(seedSoul: string): void {
	if (!chiefPartnerEnabled() || !COMPANIONS_ENABLED) return;
	partnersStore().ensureChief(seedSoul);
}

export function chiefSoul(store: PartnersStore): string | null {
	if (!store.get(CHIEF_PARTNER_ID)) return null;
	const snapshot = store.currentVersion(CHIEF_PARTNER_ID)?.soulSource;
	const soul = snapshot?.trim() ? snapshot : store.readSoulFromHome(CHIEF_PARTNER_ID);
	return soul?.trim() ? soul : null;
}

export function resolvePersona(getStore: () => PartnersStore, fallback: string): string {
	if (!chiefPartnerEnabled()) return fallback;
	try {
		return chiefSoul(getStore()) ?? fallback;
	} catch {
		return fallback;
	}
}

export function effectivePartnerIdOfSession(store: PartnersStore, sessionId: number): string | null {
	const linked = store.partnerIdOfSession(sessionId);
	if (linked !== null) return linked;
	return chiefPartnerEnabled() ? CHIEF_PARTNER_ID : null;
}

export function resolvePartnerScope(store: PartnersStore, sessionId: number): MemoryScope | null {
	const id = effectivePartnerIdOfSession(store, sessionId);
	if (id === CHIEF_PARTNER_ID) return null;
	return id ? { type: "partner", id } : null;
}

function toPartner(row: Record<string, unknown>): PartnerRow {
	return {
		id: String(row.id),
		name: String(row.name),
		status: (String(row.status) as PartnerStatus) || "active",
		currentVersion:
			row.current_version === null || row.current_version === undefined
				? null
				: Number(row.current_version),
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
		domain: row.domain === null || row.domain === undefined ? null : String(row.domain),
		avatar: row.avatar === null || row.avatar === undefined ? null : String(row.avatar),
		dispatchAuthority: Number(row.dispatch_authority ?? 0) !== 0,
		currentGoal:
			row.current_goal === null || row.current_goal === undefined
				? null
				: String(row.current_goal),
		tagline:
			row.tagline === null || row.tagline === undefined ? null : String(row.tagline),
		diary: Number(row.diary ?? 0) !== 0,
		personaPreset: toPersonaPreset(row.persona_preset),
		personaModules: toPersonaModules(row.persona_modules),
		personaSwitches: toPersonaSwitches(row.persona_switches),
		ownerTier: toOwnerTier(row.owner_tier),
		nearby: nullableText(row.nearby),
		mood: toMood(row.mood),
		moodReason: nullableText(row.mood_reason),
		moodUpdatedAt: nullableText(row.mood_updated_at),
		moodSource: toMoodSource(row.mood_source),
	};
}

function nullableText(raw: unknown): string | null {
	return raw === null || raw === undefined || String(raw) === "" ? null : String(raw);
}

/** 温度：只认五档；老库 / 脏值一律回初始档 `生疏`。 */
function toOwnerTier(raw: unknown): PartnerOwnerTier {
	const value = raw === null || raw === undefined ? "" : String(raw);
	return (PARTNER_OWNER_TIERS as readonly string[]).includes(value)
		? (value as PartnerOwnerTier)
		: "生疏";
}

/** 心情：只认五种；老库 / 脏值一律回 `平静`。 */
function toMood(raw: unknown): PartnerMood {
	const value = raw === null || raw === undefined ? "" : String(raw);
	return (PARTNER_MOODS as readonly string[]).includes(value) ? (value as PartnerMood) : "平静";
}

function toMoodSource(raw: unknown): "rule" | "manual" | null {
	const value = raw === null || raw === undefined ? "" : String(raw);
	return value === "rule" || value === "manual" ? value : null;
}

/** 子开关列：只认已登记的键且值为布尔；坏 JSON / 脏值当"没改过"。 */
function toPersonaSwitches(raw: unknown): PartnerPersonaSwitches {
	if (raw === null || raw === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const source = parsed as Record<string, unknown>;
	return typeof source.moodAffectTone === "boolean"
		? { moodAffectTone: source.moodAffectTone }
		: {};
}

/** 人格预设：只认三个枚举值，老库 / 脏值一律回默认 `work`。 */
function toPersonaPreset(raw: unknown): PartnerPersonaPreset {
	const value = raw === null || raw === undefined ? "" : String(raw);
	return value === "companion" || value === "custom" ? value : "work";
}

/** 人格开关列：只留 14 个 id 且值为布尔的键；坏 JSON / 脏值当"没显式改过"。 */
function toPersonaModules(raw: unknown): Partial<Record<PartnerPersonaModule, boolean>> {
	if (raw === null || raw === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const source = parsed as Record<string, unknown>;
	const out: Partial<Record<PartnerPersonaModule, boolean>> = {};
	for (const id of PartnerPersonaModuleIds) {
		const value = source[id];
		if (typeof value === "boolean") out[id] = value;
	}
	return out;
}

function toRoutine(row: Record<string, unknown>): RoutineDef {
	let triggers: RoutineTrigger[] = [];
	try {
		const parsed: unknown = JSON.parse(String(row.triggers ?? "[]"));
		if (Array.isArray(parsed)) triggers = parsed as RoutineTrigger[];
	} catch {
		// 坏 JSON 当无触发器：任务不会响，但档案可改
	}
	const untilNote =
		row.until_note === null || row.until_note === undefined ? "" : String(row.until_note).trim();
	const maxRunsRaw = Number(row.max_runs);
	return {
		id: String(row.id),
		partnerId: String(row.partner_id),
		name: String(row.name),
		prompt: String(row.prompt ?? ""),
		triggers,
		sessionMode: row.session_mode === "fresh" ? "fresh" : "persistent",
		enabled: Number(row.enabled ?? 0) === 1,
		...(untilNote ? { until: { note: untilNote } } : {}),
		...(Number.isFinite(maxRunsRaw) && maxRunsRaw > 0
			? { maxRuns: Math.floor(maxRunsRaw) }
			: {}),
		revision: Number(row.revision ?? 1),
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
	};
}

function toLink(row: Record<string, unknown>): PartnerSessionLinkRow {
	return {
		partnerId: String(row.partner_id),
		role: String(row.role) as PartnerSessionLinkRow["role"],
		routeKey: row.route_key === null || row.route_key === undefined ? null : String(row.route_key),
		sessionId: Number(row.session_id),
		appliedVersion:
			row.applied_version === null || row.applied_version === undefined
				? null
				: Number(row.applied_version),
		createdAt: String(row.created_at ?? ""),
	};
}

function toGroup(
	row: Record<string, unknown>,
	members: GroupRow["members"],
): GroupRow {
	const kind = String(row.responder_kind ?? "member") as GroupResponderKind;
	return {
		id: String(row.id),
		name: String(row.name),
		notice: String(row.notice ?? ""),
		responderKind: kind === "everyone" || kind === "mentions" ? kind : "member",
		responderPartnerId:
			row.responder_partner_id === null || row.responder_partner_id === undefined
				? null
				: String(row.responder_partner_id),
		members,
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
	};
}

function toGroupMessage(row: Record<string, unknown>): GroupMessageRow {
	return {
		id: String(row.id),
		groupId: String(row.group_id),
		seq: Number(row.seq),
		kind: String(row.kind) === "system" ? "system" : "message",
		authorKind: ((): "user" | "partner" | "system" => {
			const raw = String(row.author_kind ?? "system");
			return raw === "user" || raw === "partner" ? raw : "system";
		})(),
		authorId: row.author_id === null || row.author_id === undefined ? null : String(row.author_id),
		authorName: String(row.author_name ?? ""),
		content: String(row.content ?? ""),
		at: String(row.at ?? ""),
		roundId: row.round_id === null || row.round_id === undefined ? null : String(row.round_id),
	};
}

function defaultSoul(name: string): string {
	return [
		`# ${name}`,
		"",
		"<!-- SOUL.md：这个执事是谁。改这里的正文，下一轮生效（版本快照在 partners.sqlite）。",
		"     写什么：性格、说话方式、在意的边界、长期在做的事。单文件 64KB 上限。 -->",
		"",
		`你是${name}，一个和一个具体的人长期相处的执事。`,
		"说话直接、克制、就事论事；不堆情绪词，不说教。",
		"涉及真实文件、数据、日程的事先用工具去看，不许凭印象编造。",
	].join("\n");
}

export { defaultSoul, store, toGroup, toGroupMessage, toLink, toPartner, toRoutine };
