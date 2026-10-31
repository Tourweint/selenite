/**
 * 日记 → 记忆的摄入器（2026-10-31）。
 *
 * 为什么要有这一层：**"最近的上下文"只有一个来源，就是记忆**。
 * 之前 `taskMemoryBlock` 直接读日记镜像，等于在记忆系统旁边又开了一条捷径——
 * 聊天走记忆、任务读镜像，两套并存，自然就出现"记忆库是空的"这种怪事。
 *
 * 现在的分工很干脆：
 * - 日记镜像（`diary.sqlite`）是**事实源**（App 同步过来的成稿）；
 * - 摄入器把成稿**写成记忆**（`kind=episode`、`scope=global`、`id=diary:<entryId>` 稳定可重入）；
 * - 聊天与任务都从记忆取（聊天走 `recallContext` 的语义召回，任务走 `recentDiaryMemories` 的按日期取）。
 *
 * 为什么不用 `engine.remember()`：它每次生成随机 id，重复同步会堆出一串重复记录。
 * 这里直接用 `store.put()`——同一个 `diary:<entryId>` 永远是 upsert（`ON CONFLICT(id) DO UPDATE`）。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type MemoryRecord, SqliteMemoryStore } from "@lifediary/memory";
import { diaryStore } from "./diary.ts";

/** 同步节流：30 秒内重复调用只做一次（任务一问一答可能连续调两次）。 */
const SYNC_INTERVAL_MS = 30_000;

let store: SqliteMemoryStore | null | undefined;
let lastSyncAt = 0;

function memoryStore(): SqliteMemoryStore | null {
	if (process.env.MEMORY_ENABLED === "false") return null;
	if (store !== undefined) return store;
	try {
		const path = process.env.MEMORY_DB_PATH ?? ".data/memory.db";
		mkdirSync(dirname(path), { recursive: true });
		store = new SqliteMemoryStore(path);
		return store;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 记忆库打开失败，摄入降级为关闭: ${detail}`);
		store = null;
		return null;
	}
}

function dayStr(offsetDays: number, now = Date.now()): string {
	return new Date(now - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 把日记镜像里最近 [days] 天的成稿摄入记忆。返回摄入条数（0 = 没东西或已被节流）。
 *
 * 幂等：同一条成稿重复摄入只是 update，不会堆出重复记忆。
 */
export function syncDiaryToMemory(days = 3, options: { force?: boolean } = {}): number {
	const db = memoryStore();
	if (!db) return 0;
	const now = Date.now();
	if (!options.force && now - lastSyncAt < SYNC_INTERVAL_MS) return 0;
	lastSyncAt = now;

	try {
		const entries = diaryStore().recent(dayStr(days, now), 50);
		const createdAt = new Date(now).toISOString();
		for (const entry of entries) {
			const text = String(entry.finalText ?? "").replace(/\s+/g, " ").trim();
			if (!text) continue;
			const record: MemoryRecord = {
				id: `diary:${entry.id}`,
				kind: "episode",
				scope: "global",
				content: `${entry.entryDate ?? dayStr(0, now)}：${text.slice(0, 200)}`,
				// 用户自己确认过的成稿：可信度高，但不如"明确说记住"的那些重要
				importance: 0.6,
				veracity: "stated",
				source: "diary",
				createdAt,
				validUntil: null,
				supersededBy: null,
				recallCount: 0,
				lastRecalledAt: null,
			};
			db.put(record);
		}
		return entries.length;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 日记摄入失败: ${detail}`);
		return 0;
	}
}

/**
 * 从记忆里取最近几天的日记片段（按日期倒序）。
 *
 * 为什么不走 `recall`：召回是按"与本轮文本的相关度"排序的，而任务要的是**时间序**的近期切片
 * （"最近三天记了什么"）。所以这里用 `search` + 稳定 id 前缀过滤，结果可预期。
 */
export function recentDiaryMemories(days = 3, limit = 12): { date: string; text: string }[] {
	const db = memoryStore();
	if (!db) return [];
	try {
		const since = dayStr(days);
		const rows = db.search({ scopes: ["global"], kinds: ["episode"], limit: 200 });
		return rows
			.filter((row) => row.id.startsWith("diary:"))
			.map((row) => {
				const content = row.content;
				const split = content.indexOf("：");
				const date = split > 0 ? content.slice(0, split) : "";
				const text = split > 0 ? content.slice(split + 1) : content;
				return { date, text };
			})
			.filter((item) => item.date >= since)
			.sort((a, b) => (a.date < b.date ? 1 : -1))
			.slice(0, limit);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 近况读取失败: ${detail}`);
		return [];
	}
}

/** 记忆里有多少条日记来源的记录（探针/健康检查用）。 */
export function diaryMemoryCount(): number {
	const db = memoryStore();
	if (!db) return 0;
	try {
		return db.search({ scopes: ["global"], kinds: ["episode"], limit: 500 }).filter((row) =>
			row.id.startsWith("diary:"),
		).length;
	} catch {
		return 0;
	}
}
