/**
 * 员工人格 · 活模块（2026-11-15 批2，方案 §六）
 *
 * 三个活模块各归各家（**别合并成一份"状态"**）：
 *
 *   - **印象**（`impression`）：记忆库 `kind="impression"`，一条一个对象（`subject`：
 *     `owner` 或群成员 id）。append-only、不进语义召回、不衰减；单对象 20 条封顶
 *     （跨档记录不淘汰）。写入只有两路：会话结算钩子（`generated`）与端点手改（`manual`）。
 *   - **心情 / 近况**（`mood`）：`partners` 表的列（温度也在那）。规则全是可见常量，
 *     不做黑盒打分；手改随时覆盖，下一次规则事件仍可再改（否则一次手改就把规则锁死）。
 *   - **内心生活**（`heart`）：伙伴家目录 `persona/diary.jsonl`（日记）、`growth.md`
 *     （成长笔记，**永不回写 SOUL 本体**）、`wishes.json`（愿望）。
 *
 * 日志纪律：只记条数与枚举（`thanks` / `correction` / `generated` / `manual`），
 * 不记印象 / 日记正文。写失败只 warn 错误摘要，绝不把结算主流程拖下水。
 *
 * 回滚：`PARTNER_PERSONA_MODULES=false` 或对应模块开关关掉 → 不更新、不注入；
 * 已写的内容保留（重开即回）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteMemoryStore, scopeKey, type MemoryRecord } from "@lifediary/memory";
import {
	PARTNER_LIVING_LIMITS,
	PARTNER_OWNER_TIERS,
	PartnerDiaryEntrySchema,
	PartnerImpressionSchema,
	type PartnerDiaryEntry,
	type PartnerImpression,
	type PartnerLivingPatch,
	type PartnerLivingView,
	type PartnerMood,
	type PartnerOwnerTier,
} from "@lifediary/shared";
import { partnersStore, type PartnerRow, type PartnersStore, type RoutineDef } from "./partners.ts";
import { effectivePersonaModules, personaModulesEnabled } from "./partner-persona.ts";

// ── 可见规则常量（改这里 = 改行为，必须同步变更记录）──────────

/**
 * 温度跨档阈值：从当前档往上升，需要**自上次跨档以来**累计多少次"明确致谢"。
 * 档内微调 = 每次致谢加一条印象；跨档 = 达到阈值时写一条带 `tierChange` 的账。
 * 降档不自动发生（不做隐形惩罚）：降档只能手改，手改同样写一条 `tierChange` 账。
 */
export const TIER_THANKS_NEEDED: Record<PartnerOwnerTier, number | null> = {
	生疏: 3,
	认识: 5,
	熟络: 8,
	亲近: 12,
	像家人: null,
};

/** 明确致谢的词（出现任意一个就算一次，结算轮只看最后一条用户消息）。 */
export const THANKS_WORDS = ["谢谢", "多谢", "感谢", "谢了", "辛苦了", "thanks", "thank you"] as const;

/** 明确纠正 / 不满的词（只用来加一条负面印象，不改温度——避免隐形扣分）。 */
export const CORRECTION_WORDS = ["不对", "错了", "不是这样", "别这样", "重来", "不行"] as const;

/** 心情规则：连续 N 单失败 / 中止 → 低落；这么多小时没有新单落账 → 平静。 */
export const MOOD_FAIL_STREAK = 2;
export const MOOD_IDLE_HOURS = 72;

/** 盘点例行的识别词（名字或指令正文里带任意一个，才挂"他自己的话"生成）。 */
export const REVIEW_ROUTINE_WORDS = ["盘点", "回顾", "周报", "周总结"] as const;

/** 日记文件上限（字节）：超出按最旧淘汰。`PARTNER_LIVING_LIMITS.diaryEntries` 是条数上限。 */
const DIARY_FILE_MAX_BYTES = 512 * 1024;
/** 成长笔记最多留多少节（文件有界，注入只取尾部）。 */
const GROWTH_SECTIONS_MAX = 40;
/** 注入时最多给几条印象 / 每节成长笔记最多截多少字。 */
const INJECT_IMPRESSIONS_MAX = 6;
const INJECT_GROWTH_CHARS = 600;

// ── 开关 ────────────────────────────────────────────────

/**
 * 单个活模块是否开着。`PARTNER_PERSONA_MODULES=false` → 一律 false
 * （这里与 `personaModuleOn` 相反：注入侧的"旧行为"是静态段不出现，活模块本来不存在）。
 */
export function livingModuleOn(partner: PartnerRow, id: "impression" | "mood" | "heart"): boolean {
	if (!personaModulesEnabled()) return false;
	return effectivePersonaModules(partner)[id] === true;
}

/** 子开关：心情是否影响口吻。`PARTNER_PERSONA_MODULES=false` 时视为关。 */
export function moodAffectToneOn(partner: PartnerRow): boolean {
	if (!personaModulesEnabled()) return false;
	return partner.personaSwitches.moodAffectTone === true;
}

// ── 记忆库（印象）────────────────────────────────────────

let db: SqliteMemoryStore | null | undefined;

function memoryDbPath(): string {
	return process.env.MEMORY_DB_PATH ?? ".data/memory.db";
}

/** 与 work-record 同款：写口 create=true 才建库；读口库不存在返回 null（不凭空造文件）。 */
function openDb(create: boolean): SqliteMemoryStore | null {
	if (process.env.MEMORY_ENABLED === "false" || !personaModulesEnabled()) return null;
	if (db) return db;
	const path = memoryDbPath();
	if (!create && !existsSync(path)) return null;
	try {
		mkdirSync(dirname(path), { recursive: true });
		db = new SqliteMemoryStore(path);
		return db;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 印象库打开失败（不影响主流程）: ${detail.slice(0, 200)}`);
		return null;
	}
}

function oneLine(text: string, max: number): string {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return [...flat].length <= max ? flat : `${[...flat].slice(0, max - 1).join("")}…`;
}

/** 保留换行的截断（日记 / 成长笔记用；`oneLine` 会压掉分段）。 */
function truncateText(text: string, max: number): string {
	const flat = String(text ?? "").trim();
	return [...flat].length <= max ? flat : `${[...flat].slice(0, max - 1).join("")}…`;
}

function dayLabel(at: string): string {
	const date = new Date(at);
	if (!Number.isFinite(date.getTime())) return "";
	return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 读一个执事的全部印象（旧 → 新）。坏 JSON / 越界字段当没这条
 * （与 persona 静态内容同一口径：手改磁盘留下的脏值不许进提示词）。
 */
export function listImpressions(
	partnerId: string,
	store: SqliteMemoryStore | null = openDb(false),
): PartnerImpression[] {
	if (!store) return [];
	try {
		const rows = store.search({
			scopes: [scopeKey({ type: "partner", id: partnerId })],
			kinds: ["impression"],
			limit: 1000,
		});
		const out: PartnerImpression[] = [];
		for (const row of rows) {
			try {
				const parsed = PartnerImpressionSchema.safeParse(JSON.parse(row.content));
				if (parsed.success) out.push(parsed.data);
			} catch {
				// 单条坏 JSON 不挡其它条目
			}
		}
		return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 印象读取失败: ${detail.slice(0, 200)}`);
		return [];
	}
}

function putImpression(store: SqliteMemoryStore, partnerId: string, entry: PartnerImpression): void {
	const record: MemoryRecord = {
		id: entry.id,
		kind: "impression",
		scope: scopeKey({ type: "partner", id: partnerId }),
		content: JSON.stringify(entry),
		// 印象是"对某个人的判断"，比履历台账略高，但不参与召回排序（召回已排除这个 kind）
		importance: 0.55,
		veracity: entry.source === "manual" ? "stated" : "tool",
		source: entry.source === "manual" ? "persona-manual" : "persona-settle",
		createdAt: entry.at,
		validUntil: null,
		supersededBy: null,
		recallCount: 0,
		lastRecalledAt: null,
	};
	store.put(record);
}

function newImpressionId(subject: string): string {
	return `impression:${encodeURIComponent(subject)}:${randomUUID()}`;
}

/**
 * 单对象封顶：超过 20 条就删最旧的**普通条目**。
 * 带 `tierChange` 的记录永不淘汰——它是"跨档必须能指到一件事"的唯一凭据。
 */
function pruneImpressions(store: SqliteMemoryStore, partnerId: string, subject: string): number {
	const entries = listImpressions(partnerId, store).filter((entry) => entry.subject === subject);
	let removed = 0;
	for (const entry of entries) {
		if (entries.length - removed <= PARTNER_LIVING_LIMITS.impressionsPerSubject) break;
		if (entry.tierChange) continue;
		if (store.remove(entry.id)) removed += 1;
	}
	return removed;
}

/** 追加一条印象（唯一写入口之一）。返回落库的条目。 */
export function addImpression(
	partnerId: string,
	input: {
		subject: string;
		text: string;
		at?: string;
		source?: "generated" | "manual";
		event?: "thanks" | "correction";
		tierChange?: PartnerOwnerTier;
	},
	store: SqliteMemoryStore | null = openDb(true),
): PartnerImpression | null {
	if (!store) return null;
	const entry: PartnerImpression = {
		id: newImpressionId(input.subject),
		subject: input.subject,
		text: oneLine(input.text, PARTNER_LIVING_LIMITS.impressionText),
		at: input.at ?? new Date().toISOString(),
		source: input.source ?? "generated",
		...(input.event ? { event: input.event } : {}),
		...(input.tierChange ? { tierChange: input.tierChange } : {}),
	};
	try {
		putImpression(store, partnerId, entry);
		pruneImpressions(store, partnerId, input.subject);
		return entry;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 印象落库失败（不影响主流程）: ${detail.slice(0, 200)}`);
		return null;
	}
}

/** 改一条印象的正文（手改 → `source` 不变，仍按原来源；端点会写成 manual 新条目更简单）。 */
export function updateImpressionText(partnerId: string, id: string, text: string): boolean {
	const store = openDb(true);
	if (!store) return false;
	try {
		const row = store.get(id);
		if (!row || row.kind !== "impression") return false;
		// 校验归属：只准改自己 scope 里的条目
		if (row.scope !== scopeKey({ type: "partner", id: partnerId })) return false;
		const entry = PartnerImpressionSchema.parse(JSON.parse(row.content));
		putImpression(store, partnerId, {
			...entry,
			text: oneLine(text, PARTNER_LIVING_LIMITS.impressionText),
			source: "manual",
		});
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 印象改写失败: ${detail.slice(0, 200)}`);
		return false;
	}
}

/** 删一条印象（手删；硬删，与记忆页"删掉这条"同口径）。 */
export function removeImpression(partnerId: string, id: string): boolean {
	const store = openDb(true);
	if (!store) return false;
	try {
		const row = store.get(id);
		if (!row || row.kind !== "impression") return false;
		if (row.scope !== scopeKey({ type: "partner", id: partnerId })) return false;
		return store.remove(id);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 印象删除失败: ${detail.slice(0, 200)}`);
		return false;
	}
}

// ── 温度（可见规则）──────────────────────────────────────

/** 下一档；已到顶返回 null。 */
export function nextTier(tier: PartnerOwnerTier): PartnerOwnerTier | null {
	const index = PARTNER_OWNER_TIERS.indexOf(tier);
	if (index < 0 || index >= PARTNER_OWNER_TIERS.length - 1) return null;
	return PARTNER_OWNER_TIERS[index + 1] ?? null;
}

/** 自上次跨档以来累计的致谢次数（只看 `subject=owner` 的 thanks 事件）。 */
export function thanksSinceLastTierChange(entries: PartnerImpression[]): number {
	let count = 0;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry || entry.subject !== "owner") continue;
		if (entry.tierChange) break;
		if (entry.event === "thanks") count += 1;
	}
	return count;
}

/**
 * 致谢后的温度决定（纯函数，单测直接断言）：
 * 档内微调不换档；达到阈值才升一档（且只升一档，避免一次暴涨跨两档）。
 * 到顶（像家人）后不再升，只累积印象。
 */
export function tierAfterThanks(
	tier: PartnerOwnerTier,
	thanks: number,
): { tier: PartnerOwnerTier; changed: boolean; needed: number | null } {
	const needed = TIER_THANKS_NEEDED[tier];
	const up = nextTier(tier);
	if (needed === null || up === null || thanks < needed) return { tier, changed: false, needed };
	return { tier: up, changed: true, needed };
}

// ── 心情 ────────────────────────────────────────────────

/** 结算轮的心情决定（纯函数）：只有三条可见规则，返回 null = 不改。 */
export function moodAfterTurn(signals: {
	thanked: boolean;
	idle: boolean;
}): { mood: PartnerMood; reason: string } | null {
	if (signals.thanked) return { mood: "愉悦", reason: "刚被主人谢过" };
	if (signals.idle) return { mood: "平静", reason: "这阵子没什么活儿在办" };
	return null;
}

/**
 * 派单结算后的心情决定（纯函数）：
 * - 连败（最近两单都不是 done）→ 低落；
 * - 只从"低落"里被一单成功捞回来 → 平静（不覆盖愉悦等其它状态）。
 */
export function moodAfterWork(
	status: "done" | "failed" | "aborted" | "canceled",
	recent: Array<"done" | "failed" | "aborted" | "canceled">,
	current: PartnerMood,
): { mood: PartnerMood; reason: string } | null {
	if (status === "done") {
		return current === "低落" ? { mood: "平静", reason: "手上的活办成了" } : null;
	}
	const tail = recent.slice(-MOOD_FAIL_STREAK);
	if (tail.length >= MOOD_FAIL_STREAK && tail.every((item) => item !== "done")) {
		return { mood: "低落", reason: "连续两单没成" };
	}
	return null;
}

/** 心情 / 近况落库（一条 UPDATE；值没变就不写，保住 `updatedAt` 的可读性）。 */
export function setMood(
	partnerId: string,
	next: { mood: PartnerMood; reason: string; source: "rule" | "manual" },
	store: PartnersStore = partnersStore(),
): boolean {
	try {
		const partner = store.get(partnerId);
		if (!partner) return false;
		if (partner.mood === next.mood && partner.moodReason === next.reason && partner.moodSource === next.source) {
			return false;
		}
		store.setLivingState(partnerId, {
			mood: next.mood,
			moodReason: oneLine(next.reason, PARTNER_LIVING_LIMITS.moodReason),
			moodSource: next.source,
		});
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 心情落库失败: ${detail.slice(0, 200)}`);
		return false;
	}
}

/** 近况一句（空串 = 清除）。 */
export function setNearby(partnerId: string, nearby: string, store: PartnersStore = partnersStore()): boolean {
	try {
		if (!store.get(partnerId)) return false;
		store.setLivingState(partnerId, {
			nearby: nearby.trim() ? oneLine(nearby, PARTNER_LIVING_LIMITS.nearby) : null,
		});
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 近况落库失败: ${detail.slice(0, 200)}`);
		return false;
	}
}

/** 手改温度：写一条带 `tierChange` 的 manual 账，再落当前档。 */
export function setOwnerTierManual(
	partnerId: string,
	tier: PartnerOwnerTier,
	store: PartnersStore = partnersStore(),
): boolean {
	try {
		const partner = store.get(partnerId);
		if (!partner) return false;
		const from = partner.ownerTier;
		if (from === tier) return true;
		addImpression(partnerId, {
			subject: "owner",
			text: `温度由人从「${from}」改成「${tier}」`,
			source: "manual",
			tierChange: tier,
		});
		store.setOwnerTier(partnerId, tier);
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 温度落库失败: ${detail.slice(0, 200)}`);
		return false;
	}
}

// ── 从本会话实际发生的事提炼 ────────────────────────────

export interface TurnSignals {
	thanked: boolean;
	corrected: boolean;
	/** 被纠正时引用的用户原话（已压成一行、截断）；没有纠正则 null。 */
	quote: string | null;
}

/**
 * 只看**最后一条用户消息**：这是"本会话实际发生的事"里最不容易张冠李戴的证据
 * （历史消息是上一轮的事，重复计会把一次致谢数成十次）。
 * 纯字符串匹配、不调模型——宁缺毋滥，判不出来就不写。
 */
export function turnSignals(messages: Array<{ role: string; content: string }>): TurnSignals {
	const lastUser = [...messages].reverse().find((message) => message.role === "user");
	const text = String(lastUser?.content ?? "");
	const lower = text.toLowerCase();
	const thanked = THANKS_WORDS.some((word) => lower.includes(word));
	const corrected = CORRECTION_WORDS.some((word) => text.includes(word));
	return {
		thanked,
		corrected,
		quote: corrected ? oneLine(text, 40) : null,
	};
}

/** 最近 N 单的终态（从 work 履历的结构化查询里数；只读，库不存在 = 空）。 */
export function recentWorkStatuses(
	partnerId: string,
	limit = MOOD_FAIL_STREAK,
): Array<"done" | "failed" | "aborted" | "canceled"> {
	const store = openDb(false);
	if (!store) return [];
	try {
		const rows = store.search({
			scopes: [scopeKey({ type: "partner", id: partnerId })],
			kinds: ["work"],
			limit: Math.max(1, limit),
		});
		// search 是倒序；转成旧 → 新，调用方按"最近一单在最后"读
		return rows
			.map((row) => /终态=([a-z]+)/.exec(row.content)?.[1] ?? "")
			.filter((status): status is "done" | "failed" | "aborted" | "canceled" =>
				["done", "failed", "aborted", "canceled"].includes(status),
			)
			.reverse();
	} catch {
		return [];
	}
}

function lastWorkAt(partnerId: string): number | null {
	const store = openDb(false);
	if (!store) return null;
	try {
		const [row] = store.search({
			scopes: [scopeKey({ type: "partner", id: partnerId })],
			kinds: ["work"],
			limit: 1,
		});
		const at = row ? Date.parse(row.createdAt) : NaN;
		return Number.isFinite(at) ? at : null;
	} catch {
		return null;
	}
}

/**
 * 会话结算钩子（2026-11-15 批2）：只从**本会话实际发生的事**提炼。
 *
 * - 被明确致谢 → 加一条印象 + 心情愉悦；达到阈值则升一档（写 `tierChange` 账）。
 * - 被明确纠正 → 加一条负面印象（引原话），**不改温度**（不做隐形扣分）。
 * - 两种都没有，且长时间没有新单 → 心情平静。
 *
 * 模块关 / 没有致谢与纠正 → 一条都不写。日志只记条数与枚举。
 */
export function noteTurnSettlement(input: {
	partnerId: string;
	messages: Array<{ role: string; content: string }>;
	at?: string;
	store?: PartnersStore;
}): void {
	const store = input.store ?? partnersStore();
	try {
		const partner = store.get(input.partnerId);
		if (!partner) return;
		const at = input.at ?? new Date().toISOString();
		const impressionOn = livingModuleOn(partner, "impression");
		const moodOn = livingModuleOn(partner, "mood");
		if (!impressionOn && !moodOn) return;

		const signals = turnSignals(input.messages);
		if (impressionOn && signals.thanked) {
			const entries = listImpressions(input.partnerId);
			const entry = addImpression(input.partnerId, {
				subject: "owner",
				text: `被主人谢过（${dayLabel(at)}）`,
				at,
				event: "thanks",
			});
			if (entry) {
				const verdict = tierAfterThanks(
					partner.ownerTier,
					thanksSinceLastTierChange([...entries, entry]),
				);
				if (verdict.changed) {
					addImpression(input.partnerId, {
						subject: "owner",
						text: `和主人的关系从「${partner.ownerTier}」到「${verdict.tier}」：累计被谢 ${verdict.needed} 次`,
						at,
						tierChange: verdict.tier,
					});
					store.setOwnerTier(input.partnerId, verdict.tier);
					console.log(`[persona] 温度 +1 档（${verdict.needed} 次致谢）`);
				}
				console.log("[persona] 印象 +1（枚举 thanks）");
			}
		} else if (impressionOn && signals.corrected) {
			const added = addImpression(input.partnerId, {
				subject: "owner",
				text: `被主人纠正过：${signals.quote ?? "（原话略）"}`,
				at,
				event: "correction",
			});
			if (added) console.log("[persona] 印象 +1（枚举 correction）");
		}

		if (moodOn) {
			const lastAt = lastWorkAt(input.partnerId) ?? Date.parse(partner.createdAt);
			const idleHours = Number.isFinite(lastAt) ? (Date.parse(at) - lastAt) / 3_600_000 : 0;
			const next = moodAfterTurn({
				thanked: signals.thanked,
				idle: idleHours >= MOOD_IDLE_HOURS,
			});
			if (next && setMood(input.partnerId, { ...next, source: "rule" }, store)) {
				console.log(`[persona] 心情 → ${next.mood}（枚举 rule）`);
			}
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 结算钩子失败（不影响对话）: ${detail.slice(0, 200)}`);
	}
}

/**
 * 派单结算钩子：连续两单失败 / 中止 → 低落；连败被一单成功打断 → 回平静。
 * 由结算链路在 `recordWorkSettlement` 之后调用（不在 work-record 里反向 import，防成环）。
 */
export function noteWorkSettlement(
	partnerId: string,
	status: "done" | "failed" | "aborted" | "canceled",
	store: PartnersStore = partnersStore(),
): void {
	try {
		const partner = store.get(partnerId);
		if (!partner || !livingModuleOn(partner, "mood")) return;
		const recent = recentWorkStatuses(partnerId, MOOD_FAIL_STREAK);
		const next = moodAfterWork(status, recent, partner.mood);
		if (next && setMood(partnerId, { ...next, source: "rule" }, store)) {
			console.log(`[persona] 心情 → ${next.mood}（枚举 rule）`);
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 派单心情钩子失败: ${detail.slice(0, 200)}`);
	}
}

/**
 * 群成员轮结算钩子（2026-11-15 批2）：只认**被同事点名**这一种可解释事件。
 *
 * 群回合不经过 `turnSettledHandler`（那一条只认主会话），所以单独在这里接。
 * 不做"读了谁的发言就记一条"——那种条目每轮都涨、毫无信息；被叫到名字才是
 * 一段真实发生过的关系事件。同一天同名事件只记一次（去重按正文完全相同）。
 */
export function noteGroupTurn(input: {
	partnerId: string;
	partnerName: string;
	messages: Array<{ authorKind: string; authorId: string | null; authorName: string; content: string }>;
	at?: string;
	store?: PartnersStore;
}): void {
	const store = input.store ?? partnersStore();
	try {
		const partner = store.get(input.partnerId);
		if (!partner || !livingModuleOn(partner, "impression")) return;
		const at = input.at ?? new Date().toISOString();
		const existing = listImpressions(input.partnerId);
		for (const message of input.messages) {
			if (message.authorKind !== "partner") continue;
			if (!message.authorId || message.authorId === input.partnerId) continue;
			if (!message.content.includes(input.partnerName)) continue;
			const text = `在群里被「${message.authorName}」叫到过（${dayLabel(at)}）`;
			if (existing.some((entry) => entry.subject === message.authorId && entry.text === text)) continue;
			if (addImpression(input.partnerId, { subject: message.authorId, text, at })) {
				console.log("[persona] 印象 +1（枚举 group）");
			}
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 群印象钩子失败（不影响群回合）: ${detail.slice(0, 200)}`);
	}
}

/**
 * 派单结算钩子的装配门面：按发起会话认执事（与 work 履历同一判据），
 * 主人 / 总管会话不认（他没有员工履历，也没有员工心情）。
 */
export function noteWorkSettlementForConversation(
	originConversationId: number,
	status: "done" | "failed" | "aborted" | "canceled",
): void {
	try {
		const partnerId = partnersStore().partnerIdOfSession(originConversationId);
		if (!partnerId || partnerId === "chief") return;
		noteWorkSettlement(partnerId, status);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 派单心情钩子装配失败: ${detail.slice(0, 200)}`);
	}
}

// ── 内心生活：家目录文件 ────────────────────────────────

/** 只用到家目录这三件，单测可以塞桩。 */
export interface LivingStoreLike {
	homeOf(partnerId: string): string;
	readHomeFile(partnerId: string, relative: string): string | null;
	atomicWrite(path: string, content: string): void;
}

/**
 * 原子写（不走 `atomicWrite` 的 64KB 槽位护栏）：日记 / 成长笔记是会长的数据文件，
 * 64KB 是给身份文件的护栏，套在日记上等于写到 500 条就炸。
 */
function writeDataFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

function personaPath(store: LivingStoreLike, partnerId: string, file: string): string {
	return join(store.homeOf(partnerId), "persona", file);
}

function parseDiary(raw: string): PartnerDiaryEntry[] {
	const entries: PartnerDiaryEntry[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = PartnerDiaryEntrySchema.safeParse(JSON.parse(line));
			if (parsed.success) entries.push(parsed.data);
		} catch {
			// 单行坏 JSON 跳过，不牵连其它行
		}
	}
	return entries;
}

/** 读日记（旧 → 新）。文件缺失 / 坏行 = 当没有。 */
export function readDiary(store: LivingStoreLike, partnerId: string): PartnerDiaryEntry[] {
	return parseDiary(store.readHomeFile(partnerId, join("persona", "diary.jsonl")) ?? "");
}

function writeDiary(store: LivingStoreLike, partnerId: string, entries: PartnerDiaryEntry[]): void {
	// 条数 + 字节双封顶：条数按上限砍最旧；单条 300 字 500 条约 450KB，字节护栏兜一次底。
	let list = entries.slice(-PARTNER_LIVING_LIMITS.diaryEntries);
	const serialize = (items: PartnerDiaryEntry[]): string =>
		items.map((entry) => JSON.stringify(entry)).join("\n") + (items.length ? "\n" : "");
	while (list.length > 0 && Buffer.byteLength(serialize(list), "utf8") > DIARY_FILE_MAX_BYTES) {
		list = list.slice(1);
	}
	writeDataFile(personaPath(store, partnerId, "diary.jsonl"), serialize(list));
}

/** 追加一条日记（生成 / 手写共用）。日志只记来源枚举。 */
export function appendDiary(
	store: LivingStoreLike,
	partnerId: string,
	input: { text: string; source: "generated" | "manual"; at?: string },
): PartnerDiaryEntry | null {
	const text = truncateText(input.text, PARTNER_LIVING_LIMITS.diaryText);
	if (!text) return null;
	const entry: PartnerDiaryEntry = {
		id: randomUUID(),
		at: input.at ?? new Date().toISOString(),
		text,
		source: input.source,
	};
	try {
		writeDiary(store, partnerId, [...readDiary(store, partnerId), entry]);
		return entry;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 日记写入失败: ${detail.slice(0, 200)}`);
		return null;
	}
}

/** 手改 / 点赞 / 删除日记（按 id；`liked` 只影响展示排序）。 */
export function patchDiary(
	store: LivingStoreLike,
	partnerId: string,
	patch:
		| { edit: { id: string; text: string } }
		| { like: string }
		| { unlike: string }
		| { remove: string },
): boolean {
	const entries = readDiary(store, partnerId);
	const findId = "edit" in patch ? patch.edit.id : "like" in patch ? patch.like : "unlike" in patch ? patch.unlike : patch.remove;
	const index = entries.findIndex((entry) => entry.id === findId);
	if (index < 0) return false;
	if ("edit" in patch) {
		const text = truncateText(patch.edit.text, PARTNER_LIVING_LIMITS.diaryText);
		if (!text) return false;
		entries[index] = { ...entries[index]!, text, source: "manual" };
	} else if ("remove" in patch) {
		entries.splice(index, 1);
	} else {
		const liked = "like" in patch;
		entries[index] = { ...entries[index]!, liked };
	}
	writeDiary(store, partnerId, entries);
	return true;
}

/** 成长笔记最近一节（注入用；文件大也只读尾部）。 */
export function readGrowthTail(store: LivingStoreLike, partnerId: string): string | null {
	const raw = store.readHomeFile(partnerId, join("persona", "growth.md")) ?? "";
	const sections = raw.split(/^## /m).filter((part) => part.trim());
	const last = sections[sections.length - 1]?.trim();
	if (!last) return null;
	return oneLine(last.replace(/\s+/g, " "), INJECT_GROWTH_CHARS);
}

/**
 * 追加一条成长笔记（**永不回写 SOUL 本体**：这是 SOUL 的附注层，独立文件）。
 * 同一条反思重复出现不重复追加（生成侧容错）。最多留 40 节。
 */
export function appendGrowth(
	store: LivingStoreLike,
	partnerId: string,
	note: string,
	at: string = new Date().toISOString(),
): boolean {
	const text = truncateText(note, PARTNER_LIVING_LIMITS.growthNote);
	if (!text || text === "无") return false;
	try {
		const raw = store.readHomeFile(partnerId, join("persona", "growth.md")) ?? "";
		if (raw.includes(text)) return false;
		const label = dayLabel(at);
		const sections = raw.split(/^## /m).filter((part) => part.trim());
		const next = [...sections, `${label}\n${text}\n`].slice(-GROWTH_SECTIONS_MAX);
		writeDataFile(
			personaPath(store, partnerId, "growth.md"),
			next.map((section) => `## ${section.trim()}\n`).join("\n"),
		);
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 成长笔记写入失败: ${detail.slice(0, 200)}`);
		return false;
	}
}

/** 愿望清单（坏 JSON / 越界 → 空列表）。 */
export function readWishes(store: LivingStoreLike, partnerId: string): string[] {
	const raw = store.readHomeFile(partnerId, join("persona", "wishes.json"));
	if (!raw?.trim()) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((item) => String(item).trim())
			.filter((item) => item && [...item].length <= PARTNER_LIVING_LIMITS.wishText)
			.slice(0, PARTNER_LIVING_LIMITS.wishes);
	} catch {
		return [];
	}
}

/** 整份写愿望清单（已过 zod 的字符串数组；这里只做 trim / 去空）。 */
export function writeWishes(store: LivingStoreLike, partnerId: string, wishes: string[]): string[] {
	const list = wishes
		.map((item) => oneLine(item, PARTNER_LIVING_LIMITS.wishText))
		.filter(Boolean)
		.slice(0, PARTNER_LIVING_LIMITS.wishes);
	store.atomicWrite(personaPath(store, partnerId, "wishes.json"), `${JSON.stringify(list, null, 2)}\n`);
	return list;
}

// ── 端点手改（唯一入口：系统生成与手改都过这里）──────────

export type LivingPatchResult = { ok: true } | { ok: false; message: string };

/**
 * 手改活状态（PUT persona 的 `living` 段；zod 已在端点过一遍）。
 * 顺序固定：温度 → 近况 → 心情 → 愿望 → 印象 → 日记；命中不存在的条目 → `ok:false`。
 * 手改一律写 `manual` 标记（印象 / 日记的 source、温度的 tierChange 账）。
 */
export function applyLivingPatch(
	partnerId: string,
	patch: PartnerLivingPatch,
	store: PartnersStore = partnersStore(),
): LivingPatchResult {
	if (patch.ownerTier) setOwnerTierManual(partnerId, patch.ownerTier, store);
	if (patch.nearby !== undefined) setNearby(partnerId, patch.nearby, store);
	if (patch.mood !== undefined || patch.moodReason !== undefined) {
		const current = store.get(partnerId);
		if (!current) return { ok: false, message: "执事不存在" };
		setMood(
			partnerId,
			{
				mood: patch.mood ?? current.mood,
				reason: patch.moodReason ?? current.moodReason ?? "",
				source: "manual",
			},
			store,
		);
	}
	if (patch.wishes) writeWishes(store, partnerId, patch.wishes);
	if (patch.impression) {
		if ("add" in patch.impression) {
			addImpression(partnerId, {
				subject: patch.impression.add.subject,
				text: patch.impression.add.text,
				source: "manual",
			});
		} else if ("update" in patch.impression) {
			if (!updateImpressionText(partnerId, patch.impression.update.id, patch.impression.update.text)) {
				return { ok: false, message: "这条印象不存在" };
			}
		} else if (!removeImpression(partnerId, patch.impression.remove)) {
			return { ok: false, message: "这条印象不存在" };
		}
	}
	if (patch.diary) {
		if ("add" in patch.diary) {
			const added = appendDiary(store, partnerId, { text: patch.diary.add, source: "manual" });
			if (!added) return { ok: false, message: "日记没写进去" };
		} else if (!patchDiary(store, partnerId, patch.diary)) {
			return { ok: false, message: "这条日记不存在" };
		}
	}
	return { ok: true };
}

// ── 注入 ────────────────────────────────────────────────

export interface LivingSections {
	impression?: string;
	mood?: string;
	heart?: string;
}

function subjectName(subject: string, store: PartnersStore): string {
	if (subject === "owner") return "主人";
	try {
		return store.get(subject)?.name ?? "一位同事";
	} catch {
		return "一位同事";
	}
}

/** 印象块：温度一行 + 最近几条（主人优先，其次群成员），空则整块不出现。 */
export function renderImpressionSection(
	partner: PartnerRow,
	store: PartnersStore = partnersStore(),
): string | undefined {
	if (!livingModuleOn(partner, "impression")) return undefined;
	const entries = listImpressions(partner.id);
	if (entries.length === 0) return undefined;
	const recent = [...entries].reverse();
	const owner = recent.filter((entry) => entry.subject === "owner").slice(0, 4);
	const others = recent.filter((entry) => entry.subject !== "owner");
	const picked = [...owner, ...others.slice(0, Math.max(0, INJECT_IMPRESSIONS_MAX - owner.length))];
	const lines = [`【印象】`, `- 和主人的关系：${partner.ownerTier}`];
	const tierEvent = [...entries].reverse().find((entry) => entry.tierChange);
	if (tierEvent) lines.push(`- 最近一次变化：${tierEvent.text}`);
	for (const entry of picked) {
		lines.push(`- 对${subjectName(entry.subject, store)}：${entry.text}`);
	}
	return lines.join("\n");
}

/** 心情块：一行状态 +（子开关开时）一行口吻提示。模块关 / 初始态不出现。 */
export function renderMoodSection(partner: PartnerRow, tone: boolean = moodAffectToneOn(partner)): string | undefined {
	if (!livingModuleOn(partner, "mood")) return undefined;
	const has = partner.moodSource !== null || partner.mood !== "平静" || partner.moodReason;
	if (!has && !partner.nearby) return undefined;
	const lines = ["【此刻状态】"];
	const reason = partner.moodReason ? `（${partner.moodReason}）` : "";
	lines.push(`- ${partner.mood}${reason}`);
	if (partner.nearby) lines.push(`- 近况：${partner.nearby}`);
	if (tone && partner.mood !== "平静") {
		lines.push("- 说话可以带一点这种状态的口吻，但别演，也不要把状态当话题。");
	}
	return lines.join("\n");
}

/** 内心生活块：愿望 + 成长笔记尾部；两样都空则整块不出现。 */
export function renderHeartSection(
	store: LivingStoreLike,
	partner: PartnerRow,
): string | undefined {
	if (!livingModuleOn(partner, "heart")) return undefined;
	const wishes = readWishes(store, partner.id);
	const growth = readGrowthTail(store, partner.id);
	if (wishes.length === 0 && !growth) return undefined;
	const lines = ["【心里话】"];
	if (wishes.length) lines.push(`- 想做的事：${wishes.join("；")}`);
	if (growth) lines.push(`- 最近想明白的：${growth}`);
	return lines.join("\n");
}

/** 三个活段一起装配（执事轮每轮调一次；`deps.living` 给了就以调用方为准）。 */
export function buildLivingSections(
	partner: PartnerRow | null,
	store: PartnersStore = partnersStore(),
): LivingSections | undefined {
	if (!partner || !personaModulesEnabled()) return undefined;
	const impression = renderImpressionSection(partner, store);
	const mood = renderMoodSection(partner);
	const heart = renderHeartSection(store, partner);
	if (!impression && !mood && !heart) return undefined;
	return {
		...(impression ? { impression } : {}),
		...(mood ? { mood } : {}),
		...(heart ? { heart } : {}),
	};
}

// ── 端点投影 ────────────────────────────────────────────

/** GET / PUT persona 的 `living` 段（`enabled=false` 时调用方直接回 null）。 */
export function livingView(
	partner: PartnerRow,
	store: PartnersStore = partnersStore(),
): PartnerLivingView {
	const entries = listImpressions(partner.id);
	const tierEvent = [...entries].reverse().find((entry) => entry.tierChange);
	const diaries = readDiary(store, partner.id);
	const latest = diaries[diaries.length - 1] ?? null;
	return {
		ownerTier: partner.ownerTier,
		tierNote: tierEvent?.text ?? null,
		mood: {
			mood: partner.mood,
			reason: partner.moodReason ?? "",
			nearby: partner.nearby ?? "",
			updatedAt: partner.moodUpdatedAt,
			source: partner.moodSource,
		},
		impressions: entries
			.slice()
			.reverse()
			.map((entry) => ({ ...entry, subjectName: subjectName(entry.subject, store) })),
		diary: {
			count: diaries.length,
			latestAt: latest?.at ?? null,
			latestText: latest?.text ?? null,
			// 点赞只影响展示排序（赞过的在前，其次新的在前），不做算法；
			// 只给最近 50 条——"赞 / 删"按 id 操作，不需要一次拉全量。
			entries: [...diaries]
				.sort((a, b) => Number(b.liked === true) - Number(a.liked === true) || (a.at < b.at ? 1 : -1))
				.slice(0, 50),
		},
		growth: readGrowthTail(store, partner.id),
		wishes: readWishes(store, partner.id),
	};
}

// ── 每周盘点：他自己的话 / 日记 / 成长笔记 ────────────────

/** 这条例行规则算不算"周盘点"（名字或指令里带盘点 / 回顾 / 周报 / 周总结）。 */
export function isReviewRoutine(routine: Pick<RoutineDef, "name" | "prompt">): boolean {
	const text = `${routine.name}\n${routine.prompt}`;
	return REVIEW_ROUTINE_WORDS.some((word) => text.includes(word));
}

/** 追加在盘点例行提示词末尾的固定段（只在 heart 开 + 盘点例行的轮次里加）。 */
export const PERSONA_DIGEST_INSTRUCTION = [
	"【你自己的记录】",
	"这轮盘点结束时，在回复的最末尾按下面三段各写一次；只写这周真做过、真发生的事，不要编：",
	"[[日记]] 第一人称日记，不超过 300 字（只存档，主人看不到）。",
	"[[成长]] 一条值得沉淀的反思（下次可以怎么做），不超过 400 字；没有就写「无」。",
	"[[周报]] 一两句话，谈谈这周干活和相处的感受，不超过 80 字（这段会留在周报末尾给主人看）。",
].join("\n");

export interface PersonaDigest {
	/** 去掉日记 / 成长两段后的可见正文（周报一句留在原处）。 */
	text: string;
	diary: string | null;
	growth: string | null;
	weekly: string | null;
}

const DIGEST_MARKERS = ["[[日记]]", "[[成长]]", "[[周报]]"] as const;

function section(raw: string, marker: string): string | null {
	const start = raw.indexOf(marker);
	if (start < 0) return null;
	const after = raw.slice(start + marker.length);
	let end = after.length;
	for (const other of DIGEST_MARKERS) {
		const index = after.indexOf(other);
		if (index >= 0 && index < end) end = index;
	}
	const body = after.slice(0, end).trim();
	return body || null;
}

/** 标出一段（从标记起到下一个标记前）；没有返回 null。 */
function digestRange(raw: string, marker: string): [number, number] | null {
	const start = raw.indexOf(marker);
	if (start < 0) return null;
	const afterStart = start + marker.length;
	const next = DIGEST_MARKERS.map((other) => raw.indexOf(other, afterStart))
		.filter((index) => index >= 0)
		.sort((a, b) => a - b)[0];
	return [start, next === undefined ? raw.length : next];
}

/**
 * 拆盘点回复里的三段（纯函数，单测直接断言）。
 * 日记 / 成长从可见正文里摘掉（避免把日记原文塞进例行 run 的 200 字摘要）；
 * 周报一句留在原处——它就是"周报末尾他自己的话"。
 */
export function parsePersonaDigest(raw: string): PersonaDigest {
	const diary = section(raw, "[[日记]]");
	const growth = section(raw, "[[成长]]");
	const weekly = section(raw, "[[周报]]");
	const ranges = [digestRange(raw, "[[日记]]"), digestRange(raw, "[[成长]]")]
		.filter((range): range is [number, number] => range !== null)
		.sort((a, b) => b[0] - a[0]);
	let text = raw;
	for (const [start, end] of ranges) text = `${text.slice(0, start)}${text.slice(end)}`;
	return {
		text: text.replace(/\n{3,}/g, "\n\n").trim(),
		diary,
		growth,
		weekly,
	};
}

/**
 * 盘点轮结束后的落账（由 routines.ts 在 runPartnerTurn 成功后调用）。
 * 只在 heart 开 + 盘点例行时写；写失败只 warn。返回清理后的正文与"写了什么"的枚举。
 */
export function applyRoutineDigest(input: {
	partnerId: string;
	text: string;
	at?: string;
	store?: PartnersStore;
}): { text: string; diary: boolean; growth: boolean } | null {
	const store = input.store ?? partnersStore();
	try {
		const partner = store.get(input.partnerId);
		if (!partner || !livingModuleOn(partner, "heart")) return null;
		const digest = parsePersonaDigest(input.text);
		if (!digest.diary && !digest.growth && !digest.weekly) return null;
		let diary = false;
		let growth = false;
		if (digest.diary) {
			diary = Boolean(
				appendDiary(store, input.partnerId, {
					text: digest.diary,
					source: "generated",
					...(input.at ? { at: input.at } : {}),
				}),
			);
		}
		if (digest.growth) {
			growth = appendGrowth(store, input.partnerId, digest.growth, input.at);
		}
		if (diary || growth) {
			console.log(
				`[persona] 盘点落账 日记=${diary ? 1 : 0} 成长=${growth ? 1 : 0}（枚举）`,
			);
		}
		return { text: digest.text || input.text, diary, growth };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 盘点落账失败（不影响例行）: ${detail.slice(0, 200)}`);
		return null;
	}
}

/** 关掉本模块自己开的 SQLite 句柄（进程收尾 / 单测清理用）。 */
export function closeLivingStore(): void {
	db?.close();
	db = undefined;
}
