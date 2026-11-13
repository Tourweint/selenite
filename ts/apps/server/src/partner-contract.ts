/**
 * 伙伴契约与常量（开关 / 契约小节与默认决策 / 库路径 / 主伙伴）
 *
 * 2026-11-13 从 partners.ts 的 L1–L111 整段切出；正文原文搬运，未改一行实现。
 */

import { join } from "node:path";

export const COMPANIONS_ENABLED =
	(process.env.COMPANIONS_ENABLED?.trim() || "true").toLowerCase() !== "false";

export function partnerContractEnabled(): boolean {
	const raw = process.env.PARTNER_CONTRACT?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

export const PARTNER_CONTRACT_SECTIONS = [
	"职责范围",
	"决策分级",
	"验收标准",
	"汇报对象",
] as const;

export const PARTNER_CONTRACT_DECISION_DEFAULTS = [
	"- 没有调查不许改：先复现、再看现象、再动手；猜着改三次不如查一次。",
	"- 同一条思路连修 3 次还不行 → 停下，把已查明的事写成一段话交上去，别继续硬修。",
	"- 交付物要自带验收证据：说「做完了」要能指出凭什么。",
].join("\n");

export function partnerContractTemplate(): string {
	return PARTNER_CONTRACT_SECTIONS.map((section) =>
		section === "决策分级"
			? `## ${section}\n${PARTNER_CONTRACT_DECISION_DEFAULTS}`
			: `## ${section}`,
	).join("\n\n");
}

const DEFAULT_DB_PATH = ".data/partners.sqlite";

const DEFAULT_HOMES_ROOT = ".data/partner-homes";

export const PARTNER_SLOT_LIMIT = 64 * 1024;

export const CHIEF_PARTNER_ID = "chief";

const CHIEF_PARTNER_NAME = "总管";

export function chiefPartnerEnabled(): boolean {
	const raw = process.env.CHIEF_PARTNER?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

export function chiefSkillsDir(): string {
	const homesRoot = process.env.PARTNER_HOMES_ROOT?.trim() || DEFAULT_HOMES_ROOT;
	return join(homesRoot, CHIEF_PARTNER_ID, "skills");
}

export { CHIEF_PARTNER_NAME, DEFAULT_DB_PATH, DEFAULT_HOMES_ROOT };
