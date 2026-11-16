/**
 * 对外接口（派活主控权限 / 领域身份 / 人格种子 / 派活判定）
 *
 * 2026-11-13 从 partners.ts 的 L1532–L1585 整段切出；正文原文搬运，未改一行实现。
 */

import { PartnersStore } from "./partner-store.ts";
import { store } from "./partner-rows.ts";
import { flagEnabled } from "./flags.ts";

export function delegationSoulSeed(name: string, domain: string): string {
	// 没有领域标签时（2026-11-07 起 domain 可空）给一句通用身份，不硬编一个领域名——
	// 编一个"general 领域"会让用户在界面上看到一个自己没选过的东西。
	return domain
		? `你是${name}，${domain} 领域的负责人；总管把这一领域的事交给你，你带工人把活办完，只回一行结论。\n`
		: `你是${name}；总管把事交给你，你带工人把活办完，只回一行结论。\n`;
}

export function partnerIdentityForDomain(
	store: PartnersStore,
	domain: string,
): { name: string; soul: string } | null {
	const id = store.partnerIdByDomain(domain);
	if (!id) return null;
	const partner = store.get(id);
	if (!partner) return null;
	const soul = store.readSoulFromHome(id);
	if (!soul?.trim()) return null;
	return { name: partner.name, soul };
}

export function ministerDispatchMasterEnabled(): boolean {
	return flagEnabled("MINISTER_DISPATCH_AUTHORITY");
}

export function ministerDispatchAllowed(store: PartnersStore, domain: string): boolean {
	if (!ministerDispatchMasterEnabled()) return false;
	const id = store.partnerIdByDomain(domain);
	if (!id) return false;
	return store.get(id)?.dispatchAuthority === true;
}
