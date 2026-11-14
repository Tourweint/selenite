/**
 * 员工人格 · 主动性（2026-11-15 批3，方案 §3.2 / 任务书 §2）
 *
 * 两块：
 *   1. **追问建议**：纯提示词（`【主动一点】`），模块关就不注入。不新机制。
 *   2. **挂念提醒**（默认关，子开关 `nudgeEnabled`）：从主人 `kind=intention` 的记忆里挑一条
 *      **今天相关**的事，经既有提醒链路（`ReminderTask` → `setReminderDeliverer` → 会话消息）下发。
 *      **必须带执事身份**（正文前缀 `【名字】`），一天最多一条，不打扰正在跑的会话。
 *
 * 主动开口时机不新造调度：只挂两处既有唤醒——派活完成即唤醒（delegation-wake）与周盘点（routines）。
 * 没有这两类事件的执事不会自己找上门；这是本批的已知边界。
 *
 * 日志纪律：只记"排了 1 条"，不记挂念正文 / 记忆原文。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteMemoryStore } from "@lifediary/memory";
import type { PartnerRow, PartnersStore } from "./partners.ts";
import { partnersStore } from "./partners.ts";
import { effectivePersonaModules, personaModulesEnabled } from "./partner-persona.ts";
import type { PartnerProactivityView } from "@lifediary/shared";

/** 挂念正文上限（含身份前缀）。 */
export const NUDGE_TEXT_LIMIT = 80;
/** 引用主人原话的上限（≤40 字，与学习模块的短例句同一红线）。 */
export const NUDGE_QUOTE_LIMIT = 40;

export interface NudgeState {
	lastAt: string | null;
	/** 本地日期 YYYY-MM-DD；一天最多一条靠它。 */
	lastDate: string | null;
}

export interface ProactiveDeps {
	store?: PartnersStore;
	now?: () => Date;
	/** 单测注入：替代真实记忆库读（不碰 `.data/memory.db`）。 */
	intentions?: () => Array<{ content: string; createdAt: string; expiresAt?: string | null }>;
	/** 单测注入：替代真实提醒链（返回是否排上）。 */
	send?: (partnerId: string, text: string) => Promise<boolean>;
}

export interface ProactiveStoreLike {
	homeOf(partnerId: string): string;
	readHomeFile(partnerId: string, relative: string): string | null;
	atomicWrite(path: string, content: string): void;
}

function oneLine(text: string, max: number): string {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return [...flat].length <= max ? flat : `${[...flat].slice(0, max - 1).join("")}…`;
}

/** 本地日期（挂念的"一天一条"按本地日历，不按 UTC）。 */
function localDateKey(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDayLabel(date: Date): string {
	return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 主动性模块是否生效（总开关 + 模块开关）。 */
export function proactivityModuleOn(
	partner: PartnerRow,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!personaModulesEnabled(env)) return false;
	return effectivePersonaModules(partner).proactivity === true;
}

/** 挂念提醒子开关：模块关时一律 false。 */
export function nudgeEnabledOn(
	partner: PartnerRow,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!proactivityModuleOn(partner, env)) return false;
	return partner.personaSwitches.nudgeEnabled === true;
}

export function readNudgeState(store: ProactiveStoreLike, partnerId: string): NudgeState {
	const raw = store.readHomeFile(partnerId, join("persona", "nudge.json"));
	if (!raw?.trim()) return { lastAt: null, lastDate: null };
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			lastAt: typeof parsed.lastAt === "string" ? parsed.lastAt : null,
			lastDate: typeof parsed.lastDate === "string" ? parsed.lastDate : null,
		};
	} catch {
		return { lastAt: null, lastDate: null };
	}
}

function writeNudgeState(store: ProactiveStoreLike, partnerId: string, state: NudgeState): void {
	store.atomicWrite(
		join(store.homeOf(partnerId), "persona", "nudge.json"),
		`${JSON.stringify(state, null, 2)}\n`,
	);
}

/** 端点投影（`enabled=false` 时由调用方整段置 null）。 */
export function proactivityView(
	partner: PartnerRow,
	store: PartnersStore = partnersStore(),
): PartnerProactivityView {
	const state = readNudgeState(store, partner.id);
	return {
		nudgeEnabled: nudgeEnabledOn(partner),
		lastNudgeAt: state.lastAt,
	};
}

/**
 * 读主人记忆里的前瞻意图。`MEMORY_ENABLED=false` / 库不存在 → 空。
 * 只看 global scope（主人层面），不看 partner scope。
 */
function ownerIntentions(): Array<{ content: string; createdAt: string; expiresAt?: string | null }> {
	if ((process.env.MEMORY_ENABLED ?? "").trim().toLowerCase() === "false") return [];
	const path = process.env.MEMORY_DB_PATH ?? ".data/memory.db";
	if (!existsSync(path)) return [];
	let db: SqliteMemoryStore | null = null;
	try {
		db = new SqliteMemoryStore(path);
		return db
			.search({ scopes: ["global"], kinds: ["intention"], limit: 50 })
			.map((row) => ({
				content: row.content,
				createdAt: row.createdAt,
				expiresAt: row.expiresAt ?? null,
			}));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 挂念读取记忆失败: ${detail.slice(0, 200)}`);
		return [];
	} finally {
		db?.close();
	}
}

/**
 * 挑一条"今天相关"的意图（纯函数）：
 * 正文含 今天 / 今日 / 今天的 M月D日，或 expiresAt 落在今天。取最新一条。
 * 不猜"明天"是不是今天——宁可少发，不发错的。
 */
export function pickTodayIntention(
	items: Array<{ content: string; createdAt: string; expiresAt?: string | null }>,
	now: Date,
): { content: string; createdAt: string } | null {
	const label = localDayLabel(now);
	const dateKey = localDateKey(now);
	const isToday = (value: string | null | undefined): boolean => {
		if (!value) return false;
		const date = new Date(value);
		return Number.isFinite(date.getTime()) && localDateKey(date) === dateKey;
	};
	const candidates = items.filter(
		(item) =>
			item.content.includes("今天") ||
			item.content.includes("今日") ||
			item.content.includes(label) ||
			isToday(item.expiresAt),
	);
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	return candidates[0] ?? null;
}

/** 挂念正文：必须带执事身份（`【名字】`），不许无感知自动化。 */
export function buildNudgeText(partnerName: string, quote: string): string {
	return oneLine(
		`【${partnerName.trim() || "执事"}】你说过「${oneLine(quote, NUDGE_QUOTE_LIMIT)}」，今天别忘了。`,
		NUDGE_TEXT_LIMIT,
	);
}

/**
 * 真实投递器（2026-11-15 批3）：把一条带身份的挂念排进执事 canonical 会话的既有提醒链。
 *
 * 这里用**运行时动态 import** 而不是静态 import：`partner-context` 会 import 本模块，
 * 而 `partner-runtime` 又 import `partner-context`；静态 import 会成环。动态 import 在
 * 真正要发提醒时才求值，那时所有模块都已初始化，依赖方向仍保持单向。
 */
async function sendViaExistingReminder(partnerId: string, text: string): Promise<boolean> {
	try {
		const [{ ensurePartnerSession }, { conversationIsBusy }, { ReminderTask }, { CTX }] =
			await Promise.all([
				import("./partner-runtime.ts"),
				import("./agent/session.ts"),
				import("./reminder.ts"),
				import("./agent/shared.ts"),
			]);
		const chat = await ensurePartnerSession(partnerId);
		if (!chat) return false;
		// 不主动搭话打扰正在跑的会话：忙就放弃这一次（当天晚些时候还能再试）。
		if (await conversationIsBusy(chat.conversation)) return false;
		await chat.conversation.commit(
			(tx) =>
				tx.createTask(
					ReminderTask,
					{
						text,
						at: Date.now(),
						reminderId: `persona-nudge:${partnerId}:${Date.now()}`,
						partnerId,
					},
					{ ownership: { kind: "conversation" } },
				),
			CTX,
		);
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 挂念提醒排不上: ${detail.slice(0, 200)}`);
		return false;
	}
}

/**
 * 挂念提醒的唯一入口（挂两处既有唤醒）：模块 / 子开关 / 一天一条 / 今天有意图，四道都过才排。
 * 返回 true = 真排上了一条；没有可发的不更新状态（当天晚些时候还能再试）。
 */
export async function maybeScheduleNudge(
	partnerId: string,
	deps: ProactiveDeps = {},
): Promise<boolean> {
	const store = deps.store ?? partnersStore();
	try {
		const partner = store.get(partnerId);
		if (!partner || partner.status !== "active") return false;
		if (!nudgeEnabledOn(partner)) return false;
		const now = (deps.now ?? (() => new Date()))();
		const state = readNudgeState(store, partnerId);
		if (state.lastDate === localDateKey(now)) return false;
		const intention = pickTodayIntention((deps.intentions ?? ownerIntentions)(), now);
		if (!intention) return false;
		const text = buildNudgeText(partner.name, intention.content);
		const sent = await (deps.send ?? sendViaExistingReminder)(partnerId, text);
		if (!sent) return false;
		writeNudgeState(store, partnerId, { lastAt: now.toISOString(), lastDate: localDateKey(now) });
		console.log("[persona] 挂念提醒已排 1 条（枚举 nudge）");
		return true;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[persona] 挂念提醒失败（不影响主流程）: ${detail.slice(0, 200)}`);
		return false;
	}
}

/**
 * 注入 `【主动一点】`：只给追问口径，不命令模型自己发挂念（挂念走服务端提醒链）。
 * 模块关 → undefined。
 */
export function buildProactivitySection(partner: PartnerRow): string | undefined {
	if (!proactivityModuleOn(partner)) return undefined;
	return [
		"【主动一点】",
		"- 回答完可以自然带一句追问，推动事情往下走；主人明显在赶活时别加。",
		"- 不要每轮都问；没有值得追问的就正常收尾。",
		"- 挂念提醒由服务端在合适时机发，不在这里自己发。",
	].join("\n");
}
