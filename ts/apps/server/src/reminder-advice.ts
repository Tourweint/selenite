import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { MemoryEngine } from "@lifediary/memory";
import type { Hono } from "hono";
import { flagEnabled } from "./flags.ts";

/**
 * 提醒沉淀 · 建议快照与采纳（2026-11-19 批4，照 skill-advice.ts 批 30 同款分工）。
 *
 * 分工与红线：
 * - 总管蒸馏完调 `save_reminder_advice` 工具把候选教诲条目写进本快照
 *   （`.data/reminder-advice.json`）——写的只是**建议**，不碰记忆库；
 * - 人回设置 → 记忆页逐条点「采纳」才写进偏好（`kind=preference`、`source="taught"`、
 *   global scope——与 `remember` 工具立规矩完全同款；偏好 decay 系数为 0 = 永不删保护）；
 * - 「忽略」只把这条从待采纳清单里划掉，不写库；
 * - **D18 底线**：蒸馏 / 巩固不自动写库，采纳是人的动作，本模块的写库只在采纳路径。
 *
 * 快照是"当前待采纳清单"：每次蒸馏整份替换 items；采纳 / 忽略即时摘除，
 * 采纳过的进 `adopted` 尾巴（最近 200 条，给人看"上次沉淀了什么"，不参与任何逻辑）。
 * 回滚：`REMINDER_DISTILL_ENABLED=false` → 端点 404、工具不上架（同一开关）。
 */

export interface ReminderAdviceSnapshot {
	generatedAt: string;
	/** 待采纳的教诲条目（纯文本，无 id——采纳按原文匹配，天然防伪造） */
	items: string[];
	/** 已采纳的原文尾巴（最近 200 条，只展示） */
	adopted: string[];
}

export function reminderAdvicePath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_REMINDER_ADVICE_PATH?.trim() || ".data/reminder-advice.json");
}

/** 回滚开关：与收集端点 / 入口同一个 `REMINDER_DISTILL_ENABLED`，一行退回改动前。 */
export function reminderAdviceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("REMINDER_DISTILL_ENABLED", env);
}

/** 一次最多落多少条：多合并少罗列，30 条已是清单不是建议。 */
export const REMINDER_ADVICE_MAX_ITEMS = 30;
/** 单条上限：一句话的规矩；超过截断（模型偶发长篇时保清单可读）。 */
export const REMINDER_ADVICE_MAX_CHARS = 200;
/** 采纳尾巴上限：只展示，封顶防快照越攒越大。 */
export const REMINDER_ADVICE_ADOPTED_KEEP = 200;

/**
 * 清洗：收字符串数组；空白丢、截 200 字、去重、封顶 limit（待采纳清单 30，
 * adopted 尾巴 200——读侧按字段分别封顶，别把尾巴剪成清单的长度）。
 * 宁可少存一条也不改写模型的字——采纳按原文匹配，改字就对不上快照。
 */
export function sanitizeReminderAdviceItems(raw: unknown, limit: number = REMINDER_ADVICE_MAX_ITEMS): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const text = item.trim().slice(0, REMINDER_ADVICE_MAX_CHARS);
		if (!text || out.includes(text)) continue;
		out.push(text);
	}
	return out.slice(0, Math.max(0, limit));
}

export function readReminderAdviceSnapshot(path: string): ReminderAdviceSnapshot | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		return {
			generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : "",
			items: sanitizeReminderAdviceItems(obj.items),
			adopted: sanitizeReminderAdviceItems(obj.adopted, REMINDER_ADVICE_ADOPTED_KEEP),
		};
	} catch {
		return null;
	}
}

/** 原子写（先临时文件再改名）：读到的永远是整份清单。 */
export function writeReminderAdviceSnapshot(path: string, snapshot: ReminderAdviceSnapshot): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * 蒸馏结果整份替换待采纳清单（adopted 尾巴保留）。
 * 每次蒸馏都是对"最近 30 天"的全量重算，旧清单里没被覆盖的条目按过期处理摘除——
 * 与 save_skill_advice 的"按键合并"不同：这里没有自然键，原文即键。
 */
export function saveReminderAdviceItems(
	path: string,
	items: string[],
): ReminderAdviceSnapshot {
	const snapshot: ReminderAdviceSnapshot = {
		generatedAt: new Date().toISOString(),
		items: sanitizeReminderAdviceItems(items),
		adopted: readReminderAdviceSnapshot(path)?.adopted ?? [],
	};
	writeReminderAdviceSnapshot(path, snapshot);
	return snapshot;
}

/** `save_reminder_advice` 工具的结果：saved=本次落盘条数。 */
export type ReminderAdviceSaveResult =
	| { ok: true; saved: number }
	| { ok: false; error: string; message: string; hint?: string };

/** 工具入口（lifecycle 注入给 tools.ts；包住清洗 + 落盘），tools 不碰文件系统。 */
export function makeReminderAdviceSaver(
	path: string,
): (items: string[]) => ReminderAdviceSaveResult {
	return (rawItems) => {
		const items = sanitizeReminderAdviceItems(rawItems);
		if (items.length === 0) {
			return {
				ok: false,
				error: "no_valid_items",
				message: "items 里没有一条合法建议（要是非空字符串数组，每条一句话 ≤200 字）",
				hint: "每条写成「以后要怎么做 / 不做什么」的规矩本身；同类合并后再给。",
			};
		}
		saveReminderAdviceItems(path, items);
		return { ok: true, saved: items.length };
	};
}

/** `save_reminder_advice` 工具描述原文（缓存前缀资产：改动要在报告/变更记录单列）。 */
export const SAVE_REMINDER_ADVICE_DESCRIPTION =
	"把你蒸馏好的提醒教诲条目一次性写进建议清单（设置 → 记忆页会显示这份清单，主人逐条采纳后才会写进偏好）。" +
	"只在主人让你沉淀提醒、并且你已经合并同类、去掉一次性语境之后调用一次。" +
	"它不写记忆库：采纳是主人在记忆页上的动作。";

/* ── 采纳（人的动作，唯一的写库路径）──────────────────────── */

export type ReminderAdoptionAction = "adopt" | "dismiss";

export interface ReminderAdoptionInput {
	text: string;
	action: ReminderAdoptionAction;
}

/**
 * 采纳闸门（照 illegalAdviceActions）：每条 text 必须来自当前快照 items
 * （防"伪造建议直接写偏好"——总管落盘后才可采纳）。
 * 返回非法原文清单；空数组 = 全部合法。
 */
export function illegalReminderActions(
	actions: readonly ReminderAdoptionInput[],
	snapshot: ReminderAdviceSnapshot | null,
): string[] {
	if (!snapshot) return actions.map((action) => action.text);
	return actions.filter((action) => !snapshot.items.includes(action.text)).map((action) => action.text);
}

export interface ReminderAdoptionOutcome {
	adopted: number;
	dismissed: number;
	/** 内容与已有 global 偏好重复、跳过写入的条数（仍从清单摘除） */
	duplicates: number;
	remaining: number;
}

/**
 * 执行采纳 / 忽略（纯逻辑 + 快照写回；引擎注入便于单测）。
 *
 * adopt = 写偏好（remember 同款：kind=preference、scope=global、importance 0.7、
 * veracity=stated、source=taught——偏好层"永不删保护"来自 decay 系数为 0）；
 * 写前与 global 偏好现有内容去重（同一句已经在库里的不再重复落）。
 * adopt / dismiss 都把原文从待采纳清单摘除、adopt 的进 adopted 尾巴。
 * 单条引擎异常不挡其余条目（与 verified-answer 同口径：记忆绝不卡住界面动作）。
 */
export function applyReminderActions(
	engine: MemoryEngine | null,
	path: string,
	actions: readonly ReminderAdoptionInput[],
): ReminderAdoptionOutcome | { error: string; message: string } {
	const snapshot = readReminderAdviceSnapshot(path);
	if (!snapshot) return { error: "not_found", message: "还没有沉淀建议清单；先让总管蒸馏一次。" };
	const existing = new Set<string>();
	if (engine) {
		try {
			const { items } = engine.browse({ scopes: ["global"], kinds: ["preference"], limit: 2000 });
			for (const record of items) existing.add(record.content);
		} catch {
			// 现有偏好读不出来就不去重：宁可靠检查少一层，也不让采纳失败
		}
	}
	const items = new Set(snapshot.items);
	const adoptedTail = [...snapshot.adopted];
	const outcome: ReminderAdoptionOutcome = { adopted: 0, dismissed: 0, duplicates: 0, remaining: 0 };
	for (const action of actions) {
		if (!items.has(action.text)) continue;
		items.delete(action.text);
		if (action.action === "dismiss") {
			outcome.dismissed += 1;
			continue;
		}
		if (existing.has(action.text)) {
			// 库里已经有同一句：不重复落，也从清单摘除（它已经是生效的偏好）
			outcome.duplicates += 1;
			continue;
		}
		if (!engine) {
			// 记忆引擎没起来：写不了库，条目留在清单里
			items.add(action.text);
			continue;
		}
		try {
			engine.remember({
				kind: "preference",
				scope: { type: "global" },
				content: action.text,
				importance: 0.7,
				veracity: "stated",
				source: "taught",
			});
			existing.add(action.text);
			// adopted 尾巴只记"真写进库的"（duplicates 没产生新偏好，不记）
			if (!adoptedTail.includes(action.text)) adoptedTail.push(action.text);
			outcome.adopted += 1;
		} catch {
			// 这条没写成：留在清单里，让人再点一次（与"记忆绝不卡住动作"同口径）
			items.add(action.text);
		}
	}
	const next: ReminderAdviceSnapshot = {
		generatedAt: snapshot.generatedAt,
		items: [...items],
		adopted: adoptedTail.slice(-REMINDER_ADVICE_ADOPTED_KEEP),
	};
	if (
		next.items.length !== snapshot.items.length ||
		next.adopted.length !== snapshot.adopted.length
	) {
		writeReminderAdviceSnapshot(path, next);
	}
	outcome.remaining = next.items.length;
	return outcome;
}

/* ── 端点 ────────────────────────────────────────────────── */

export interface ReminderAdviceDeps {
	enabled?: () => boolean;
	engine?: () => MemoryEngine | null | undefined;
	path?: () => string;
}

/**
 * 设置 → 记忆页的待采纳清单（GET）与逐条动作（PUT）。鉴权走 /api/v1 全局中间件。
 * 回滚：`REMINDER_DISTILL_ENABLED=false` → 404。日志只记条数，不记内容。
 */
export function mountReminderAdvice(app: Hono, deps: ReminderAdviceDeps = {}): void {
	const enabled = () => (deps.enabled ?? reminderAdviceEnabled)();
	const path = () => deps.path?.() ?? reminderAdvicePath();

	app.get("/api/v1/agent/reminder-advice", (c) => {
		if (!enabled()) return c.json({ error: "not_found" }, 404);
		const snapshot = readReminderAdviceSnapshot(path());
		c.header("cache-control", "no-store");
		return c.json({
			ok: true,
			generatedAt: snapshot?.generatedAt ?? null,
			items: snapshot?.items ?? [],
			adopted: snapshot?.adopted ?? [],
		});
	});

	app.put("/api/v1/agent/reminder-advice", async (c) => {
		if (!enabled()) return c.json({ error: "not_found" }, 404);
		const body = (await c.req.json().catch(() => null)) as { actions?: unknown } | null;
		if (!Array.isArray(body?.actions)) {
			return c.json({ error: "bad_request", message: "需要 actions 数组" }, 400);
		}
		const actions: ReminderAdoptionInput[] = [];
		for (const raw of body.actions) {
			if (!raw || typeof raw !== "object") continue;
			const { text, action } = raw as Record<string, unknown>;
			if (typeof text !== "string" || !text.trim()) continue;
			if (action !== "adopt" && action !== "dismiss") continue;
			actions.push({ text: text.trim(), action });
		}
		if (!actions.length) {
			return c.json({ error: "bad_request", message: "actions 里没有合法条目（text + adopt/dismiss）" }, 400);
		}
		const engine = deps.engine?.() ?? null;
		if (!engine && actions.some((action) => action.action === "adopt")) {
			return c.json(
				{ error: "memory_disabled", message: "记忆库未启用（MEMORY_ENABLED=false），没法把采纳写进偏好" },
				400,
			);
		}
		// 闸门：原文必须来自当前快照（防伪造建议直接写偏好）
		const illegal = illegalReminderActions(actions, readReminderAdviceSnapshot(path()));
		if (illegal.length) {
			return c.json(
				{ error: "bad_request", message: "这些条目不在当前建议清单里（可能已采纳 / 忽略，或总管重新蒸馏过），刷新后重试" },
				400,
			);
		}
		const outcome = applyReminderActions(engine, path(), actions);
		if ("error" in outcome) return c.json(outcome, 404);
		console.log(
			`[reminder-advice] 采纳 ${outcome.adopted} / 忽略 ${outcome.dismissed} / 重复 ${outcome.duplicates} / 剩 ${outcome.remaining}`,
		);
		c.header("cache-control", "no-store");
		return c.json({ ok: true, ...outcome });
	});
}
