/**
 * 伙伴契约与常量（开关 / 契约小节与默认决策 / 库路径 / 主伙伴）
 *
 * 2026-11-13 从 partners.ts 的 L1–L111 整段切出；正文原文搬运，未改一行实现。
 */

import { join } from "node:path";
import { flagEnabled } from "./flags.ts";

export const COMPANIONS_ENABLED =
	(process.env.COMPANIONS_ENABLED?.trim() || "true").toLowerCase() !== "false";

export function partnerContractEnabled(): boolean {
	return flagEnabled("PARTNER_CONTRACT");
}

/**
 * 执事纪律覆盖（2026-11-16）：宿主默认纪律 + 每执事人工覆盖。
 * `PARTNER_DISCIPLINE_EDIT=false` / `0`：不读、不写 `DISCIPLINE.md`，纪律回到纯宿主常量。
 * 默认开；覆盖只由人经档案页写，模型工具不碰这个文件。
 */
export function partnerDisciplineEditEnabled(): boolean {
	return flagEnabled("PARTNER_DISCIPLINE_EDIT");
}

/**
 * 项目记忆跟人走（2026-11-15 项目记忆挂载跟人走方案）：总管 / 执事档案挂项目的记忆层。
 * `false` / `0` 全链路退回"只有文件夹挂载"的形态：投影不出字段、召回不并、remember 不认。
 * 文件夹挂载（ChatProjects → 打手会话）不在本开关内——那是上一批已落地的东西。
 */
export function partnerProjectMemoryEnabled(): boolean {
	return flagEnabled("PARTNER_PROJECT_MEMORY");
}

/**
 * 注入闸门（2026-11-15 项目记忆多挂载方案）：挂载项目（除会话绑定项目外）只有
 * 字面命中当前话题的条目才进候选——"聊到才注入"从打分巧合变成硬规则。
 * `false` / `0` = 挂载项目全权进池（跟人走方案当日的形态），一行回滚。
 */
export function projectMemoryGateEnabled(): boolean {
	return flagEnabled("PROJECT_MEMORY_GATE");
}

/**
 * 归档 / 删除项目退出召回库（2026-11-16 用户拍板）：归档 = 退场，删除 = 登记没了。
 * 两者的项目记忆都**留在库里**（记忆页照旧能看、能导出），但不再进召回池、也不再接收
 * 新记忆；恢复归档后自动回来。
 * `false` / `0` = 旧形态——归档项目照旧召回、照旧接收记忆，一行回滚。
 */
export function projectMemoryActiveOnlyEnabled(): boolean {
	return flagEnabled("PROJECT_MEMORY_ACTIVE_ONLY");
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
