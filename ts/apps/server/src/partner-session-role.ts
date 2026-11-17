/**
 * 一人多会话：对外 id 解析、续话分流与开关（2026-11-17 批1，纯函数模块）。
 *
 * 单独成模块的理由：这三件事都是无副作用的判定，单测要能直接测；
 * 不 import agent / 存储，避免单测被真实装配与 `.data` 牵连。
 */

import { flagEnabled } from "./flags.ts";

/**
 * 副会话开关（插件页默认开、即时生效；env 同名变量兜底）。
 * 透传 `flagEnabled` 的父子门语义：`COMPANIONS_ENABLED` 关时本开关也视为关。
 */
export function sideSessionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("PARTNER_SIDE_SESSIONS", env);
}

export interface ParsedPartnerSessionId {
	partnerId: string;
	role: "canonical" | "side" | "group";
}

/**
 * 解析 partner- 前缀的对外会话 id。顺序很重要：
 * 1) /^partner-(.+)-side-[0-9a-f]{8}$/  → side
 * 2) /^partner-(.+)-group-(.+)$/        → group
 * 3) /^partner-(.+)$/                   → canonical
 * 不是 partner- 开头 → null。
 * partnerId 本身可能含 "-"，禁止 split("-") 猜。
 */
export function parsePartnerExternalId(
	externalId: string | null | undefined,
): ParsedPartnerSessionId | null {
	if (!externalId) return null;
	if (!externalId.startsWith("partner-")) return null;
	const side = /^partner-(.+)-side-[0-9a-f]{8}$/.exec(externalId);
	if (side) return { partnerId: side[1], role: "side" };
	const group = /^partner-(.+)-group-(.+)$/.exec(externalId);
	if (group) return { partnerId: group[1], role: "group" };
	const canonical = /^partner-(.+)$/.exec(externalId);
	if (canonical) return { partnerId: canonical[1], role: "canonical" };
	return null;
}

/**
 * /agent/chat 续话按链接角色分流：canonical 折回主会话；side 放行；side 开关关 → reject；
 * group / routine / topic / delegation / null 保持旧行为（折回 canonical）。
 */
export function partnerContinuePlan(
	role: "canonical" | "routine" | "topic" | "delegation" | "group" | "side" | null,
	sideEnabled: boolean,
): "canonical" | "side" | "reject" {
	if (role === "side") return sideEnabled ? "side" : "reject";
	return "canonical";
}
