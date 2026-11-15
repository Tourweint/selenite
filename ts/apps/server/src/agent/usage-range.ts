/**
 * 用量区间（2026-11-15）：近 N 天按每条回复的完成时间归日。
 *
 * 为什么能这么做：`pi.usage` 只有每个会话的累计快照（`harness.usage()` 求和），
 * 没有逐日流水；但 durable 里每条 `pi.assistant` 的 `model[0]` 自带 `timestamp`
 * 与 `usage`。把本机全部会话的 entry 扫一遍，就能还原出每一天花了多少——只读，
 * 不新增存储、不做每日快照。
 *
 * 口径（与页面注脚同一句话）：
 *   - 窗口 = 本地日历日：近 7 天含今天在内共 7 个自然日，从第 1 天的 00:00 起算；
 *   - 归日按**回复完成时间**（assistant message 的 `timestamp`），不是提问时间；
 *   - 累计为 0 的模型不进区间表（`lifediary.say` 这类播报不花钱，列出来只是多一行 0%）；
 *   - 只算模型（assistant）的消耗；工具结果自带的 `pi.usage.tools` 不在本页口径内
 *     （原页面也只展示 models）。
 */

import { getHarness } from "./lifecycle.ts";
import { CTX, Chats } from "./shared.ts";
import type { Cursor, EntryRecord } from "@earendil-works/pi-durable";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageModelTotals extends UsageTotals {
	/** `provider/modelId#variant`，与 `pi.usage.models` 的 key 同形 */
	model: string;
}

export interface UsageSample {
	/** 回复完成时间（epoch ms） */
	at: number;
	/** `provider/modelId#variant` */
	model: string;
	usage: UsageTotals;
}

export interface UsageWindow {
	models: UsageModelTotals[];
	/** 窗口内有消耗的自然日数量（0 = 一段空窗） */
	activeDays: number;
	/** 窗口起点（本地 00:00，epoch ms） */
	since: number;
	/** 扫到的有效样本数（诊断用，不上界面） */
	samples: number;
}

/** 一条 assistant entry → 用量样本；不是 assistant / 没时间 / 没用量就跳过 */
export function usageSampleOf(entry: EntryRecord): UsageSample | null {
	if (entry.kind !== "pi.assistant") return null;
	const message = entry.model?.[0] as
		| {
				timestamp?: number;
				provider?: string;
				model?: string;
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					totalTokens?: number;
				};
		  }
		| undefined;
	const usage = message?.usage;
	if (!message || !usage) return null;
	const at = typeof message.timestamp === "number" ? message.timestamp : 0;
	if (!at) return null;
	const model = `${message.provider ?? ""}/${message.model ?? ""}`.replace(/^\/+|\/+$/g, "");
	if (!model || model === "/") return null;
	return { at, model, usage: totalsOf(usage) };
}

/** 计数器归一：`totalTokens` 缺失时用四项相加兜底（个别播报类条目只填了各部分） */
function totalsOf(usage: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}): UsageTotals {
	const input = count(usage.input);
	const output = count(usage.output);
	const cacheRead = count(usage.cacheRead);
	const cacheWrite = count(usage.cacheWrite);
	const total = count(usage.totalTokens) || input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, total };
}

function count(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 窗口起点：本地日历日的第一天 00:00。
 * `days = 7` → 今天与之前 6 个自然日（含今天共 7 天）；不是"现在往前推 168 小时"——
 * 按小时推会让同一天上午看到的数字和下午看到的不一样。
 */
export function startOfUsageWindow(days: number, now: number = Date.now()): number {
	const span = Math.max(1, Math.round(days));
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() - (span - 1));
	return start.getTime();
}

/** 本地日期键（`YYYY-MM-DD`），只用于数"有几天用过"，不做展示排序 */
export function localDayKey(at: number): string {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 纯聚合：给定样本与窗口起点，按模型合并、数活跃日。
 * 抽成纯函数是为了单测不必真起 durable；扫描只负责把 entry 读成 {@link UsageSample}。
 */
export function aggregateUsageWindow(
	samples: readonly UsageSample[],
	since: number,
): { models: UsageModelTotals[]; activeDays: number } {
	const byModel = new Map<string, UsageModelTotals>();
	const days = new Set<string>();
	for (const sample of samples) {
		if (!Number.isFinite(sample.at) || sample.at < since) continue;
		const usage = sample.usage;
		if (!usage.total) continue;
		const row = byModel.get(sample.model) ?? {
			model: sample.model,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		};
		row.input += usage.input;
		row.output += usage.output;
		row.cacheRead += usage.cacheRead;
		row.cacheWrite += usage.cacheWrite;
		row.total += usage.total;
		byModel.set(sample.model, row);
		days.add(localDayKey(sample.at));
	}
	const models = [...byModel.values()].sort((a, b) => b.total - a.total);
	return { models, activeDays: days.size };
}

/**
 * 扫本机全部会话的 assistant entry，聚合成区间用量。
 *
 * 代价与 `searchSessions` / `listChats` 同口径：逐会话读 entry，个人规模（几十个会话、
 * 千级条目）一次显式请求可接受；真慢了再加逐日账本，不在这一版引入。
 * 单个会话读失败只跳过它，不挡整页（同 `searchSessions` 的取舍）。
 */
export async function usageInWindow(days: number): Promise<UsageWindow> {
	const harness = await getHarness();
	const chats = await harness.snapshot(Chats, CTX);
	const since = startOfUsageWindow(days);
	const samples: UsageSample[] = [];
	/**
	 * fork 子会话的 `conversation.entries()` 会从父会话的 fork 点接着往前读（durable 的
	 * fork 是引用不是复制），逐会话相加会把父会话那段 assistant 再算一遍。
	 * entry id 全库唯一，按 id 去重最省事，也不依赖会话遍历顺序。
	 */
	const seenEntries = new Set<number>();
	for (const internalId of Object.values(chats?.byExternal ?? {})) {
		try {
			const conversation = await harness.conversation(internalId as never, CTX);
			if (!conversation) continue;
			let cursor: Cursor | undefined;
			// 上限只是防呆：个人库不可能有 100 页（200 条/页）的单会话历史
			for (let page = 0; page < 100; page += 1) {
				const scanned = await conversation.entries({ order: "descending" }, 200, cursor, CTX);
				for (const entry of scanned.items) {
					if (seenEntries.has(entry.id)) continue;
					seenEntries.add(entry.id);
					const sample = usageSampleOf(entry);
					if (sample) samples.push(sample);
				}
				if (!scanned.next) break;
				cursor = scanned.next;
			}
		} catch (error) {
			console.warn(
				`[usage] 会话 ${internalId} 读取失败（区间统计跳过它）: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	const { models, activeDays } = aggregateUsageWindow(samples, since);
	return { models, activeDays, since, samples: samples.length };
}
