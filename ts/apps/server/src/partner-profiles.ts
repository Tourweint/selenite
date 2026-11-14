/**
 * 员工人格 · 人设库（2026-11-15 批3，方案 §3.2 / 任务书 §3）
 *
 * `persona/profiles.json` 的命名快照：名称 + 保存当时的整套 contents + modules + preset，最多 5 份。
 * 应用 = 整份写回 contents / modules / preset，**SOUL.md 一个字节都不动**。
 *
 * 模块开关：`profiles` 关 = 不提供存 / 应用 / 删（400 带说明），但列表仍回读（内容保留，重开即回）。
 * 总开关 `PARTNER_PERSONA_MODULES=false` = 端点字段为 null、动作全拒。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	PARTNER_PROFILE_LIMITS,
	PartnerPersonaProfileSnapshotSchema,
	type PartnerPersonaPreset,
	type PartnerPersonaProfilesView,
	type PartnerPersonaProfileSnapshot,
	type PartnerPersonaModule,
} from "@lifediary/shared";
import { partnersStore, type PartnerRow, type PartnersStore } from "./partners.ts";
import {
	effectivePersonaModules,
	personaModulesEnabled,
	readPersonaContents,
	replacePersonaContents,
	type PersonaStoreLike,
} from "./partner-persona.ts";

interface ProfilesFile {
	version: 1;
	items: PartnerPersonaProfileSnapshot[];
}

function emptyFile(): ProfilesFile {
	return { version: 1, items: [] };
}

function oneLine(text: string, max: number): string {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return [...flat].length <= max ? flat : `${[...flat].slice(0, max - 1).join("")}…`;
}

/** 读人设库；坏 JSON / 坏条目跳过（手改磁盘留下的脏值不许进 UI）。 */
export function readProfiles(
	store: PersonaStoreLike,
	partnerId: string,
): PartnerPersonaProfileSnapshot[] {
	const raw = store.readHomeFile(partnerId, join("persona", "profiles.json"));
	if (!raw?.trim()) return [];
	try {
		const parsed = JSON.parse(raw) as { items?: unknown };
		if (!Array.isArray(parsed.items)) return [];
		const items: PartnerPersonaProfileSnapshot[] = [];
		for (const item of parsed.items) {
			const result = PartnerPersonaProfileSnapshotSchema.safeParse(item);
			if (result.success) items.push(result.data);
			if (items.length >= PARTNER_PROFILE_LIMITS.count) break;
		}
		return items;
	} catch {
		return [];
	}
}

/**
 * 原子写（不走 `atomicWrite` 的 64KB 槽位护栏）：
 * 5 份快照 × 三份内容最坏情况可到 70KB 以上，64KB 是给身份文件的护栏，套在人设库上会写到第 4 份就炸。
 */
function writeDataFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

function writeProfiles(
	store: PersonaStoreLike,
	partnerId: string,
	items: PartnerPersonaProfileSnapshot[],
): void {
	const file: ProfilesFile = {
		version: 1,
		items: items.slice(0, PARTNER_PROFILE_LIMITS.count),
	};
	writeDataFile(
		join(store.homeOf(partnerId), "persona", "profiles.json"),
		`${JSON.stringify(file, null, 2)}\n`,
	);
}

/** 人设库模块是否生效（总开关 + 模块开关）。 */
export function profilesModuleOn(partner: PartnerRow, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!personaModulesEnabled(env)) return false;
	return effectivePersonaModules(partner).profiles === true;
}

export type ProfileActionResult =
	| { ok: true; partner?: PartnerRow }
	| { ok: false; message: string };

/** 存一份当前快照。同名拒绝（不静默覆盖）；满了拒绝（让用户先删）。 */
export function saveProfile(
	partnerId: string,
	name: string,
	store: PartnersStore = partnersStore(),
	at: string = new Date().toISOString(),
): ProfileActionResult {
	const partner = store.get(partnerId);
	if (!partner) return { ok: false, message: "执事不存在" };
	if (!profilesModuleOn(partner)) return { ok: false, message: "人设库没打开（先打开「人设库」模块）" };
	const cleanName = oneLine(name, PARTNER_PROFILE_LIMITS.name);
	if (!cleanName) return { ok: false, message: "人设名不能空" };
	const items = readProfiles(store, partnerId);
	if (items.some((item) => item.name === cleanName)) {
		return { ok: false, message: `已经有一份叫「${cleanName}」的人设了` };
	}
	if (items.length >= PARTNER_PROFILE_LIMITS.count) {
		return { ok: false, message: `人设库最多 ${PARTNER_PROFILE_LIMITS.count} 份，先删一份再存` };
	}
	const snapshot: PartnerPersonaProfileSnapshot = {
		id: randomUUID(),
		name: cleanName,
		createdAt: at,
		preset: partner.personaPreset,
		modules: effectivePersonaModules(partner),
		contents: readPersonaContents(store, partnerId),
	};
	const validated = PartnerPersonaProfileSnapshotSchema.safeParse(snapshot);
	if (!validated.success) {
		return { ok: false, message: validated.error.issues[0]?.message ?? "人设快照不合法" };
	}
	try {
		writeProfiles(store, partnerId, [...items, validated.data]);
		console.log(`[persona] 人设库存入 1 份（共 ${items.length + 1} 份）`);
		return { ok: true };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 人设库存入失败: ${detail.slice(0, 200)}`);
		return { ok: false, message: "人设没存进去" };
	}
}

/** 应用一份快照：整份写回 contents / modules / preset；SOUL 不动、不 bump 身份版本。 */
export function applyProfile(
	partnerId: string,
	id: string,
	store: PartnersStore = partnersStore(),
): ProfileActionResult {
	const partner = store.get(partnerId);
	if (!partner) return { ok: false, message: "执事不存在" };
	if (!profilesModuleOn(partner)) return { ok: false, message: "人设库没打开（先打开「人设库」模块）" };
	const item = readProfiles(store, partnerId).find((entry) => entry.id === id);
	if (!item) return { ok: false, message: "这份人设不存在" };
	try {
		replacePersonaContents(store, partnerId, item.contents);
		const modules = effectivePersonaModules({
			personaPreset: item.preset as PartnerPersonaPreset,
			personaModules: item.modules as Partial<Record<PartnerPersonaModule, boolean>>,
		});
		const updated = store.setPersona(partnerId, {
			preset: item.preset,
			modules,
			switches: partner.personaSwitches,
		});
		console.log("[persona] 人设库应用 1 份（枚举 profile）");
		return { ok: true, ...(updated ? { partner: updated } : {}) };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 人设库应用失败: ${detail.slice(0, 200)}`);
		return { ok: false, message: "人设没应用成功" };
	}
}

export function removeProfile(
	partnerId: string,
	id: string,
	store: PartnersStore = partnersStore(),
): ProfileActionResult {
	const partner = store.get(partnerId);
	if (!partner) return { ok: false, message: "执事不存在" };
	if (!profilesModuleOn(partner)) return { ok: false, message: "人设库没打开（先打开「人设库」模块）" };
	const items = readProfiles(store, partnerId);
	const next = items.filter((item) => item.id !== id);
	if (next.length === items.length) return { ok: false, message: "这份人设不存在" };
	try {
		writeProfiles(store, partnerId, next);
		console.log("[persona] 人设库删除 1 份（枚举 profile）");
		return { ok: true };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 人设库删除失败: ${detail.slice(0, 200)}`);
		return { ok: false, message: "人设没删掉" };
	}
}

/** 端点投影：只给摘要，不含 contents（列表只做名称 / 预设 / 开关摘要）。 */
export function profilesView(
	partner: PartnerRow,
	store: PartnersStore = partnersStore(),
): PartnerPersonaProfilesView {
	const items = readProfiles(store, partner.id).map((item) => ({
		id: item.id,
		name: item.name,
		createdAt: item.createdAt,
		preset: item.preset,
		modules: effectivePersonaModules({
			personaPreset: item.preset,
			personaModules: item.modules as Partial<Record<PartnerPersonaModule, boolean>>,
		}),
	}));
	return { limit: PARTNER_PROFILE_LIMITS.count, items };
}
