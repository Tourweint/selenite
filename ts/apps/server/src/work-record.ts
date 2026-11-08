import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	SqliteMemoryStore,
	scopeKey,
	type MemoryRecord,
} from "@lifediary/memory";
import { CHIEF_PARTNER_ID, partnersStore } from "./partners.ts";

/**
 * 工作履历的落账与读取（2026-11-08 员工人格化刀二 E2）。
 *
 * 这是 `work` kind 在 server 侧**唯一的写入口**：harness 派单终态结算时调
 * `recordWorkSettlement()` 落一条，append-only。写入点用稳定 id `work:<票号>`
 * 走 `store.put()` 的 upsert —— 同一单终态重入也只留一条（不重复落账）。
 *
 * 与 `memory-ingest.ts` 同款：自己在 `MEMORY_DB_PATH` 上开一个 `SqliteMemoryStore`。
 * 刻意不复用 `memoryEngine` 单例——那条链在 `agent/` 里，从结算链反向 import 会绕成环；
 * 同一个 SQLite 文件多连接同进程打开没有副作用（日记摄入已经这么跑了）。
 *
 * 两个开关：`MEMORY_ENABLED=false`（记忆整体关）/ `PARTNER_WORK_RECORD=false`
 * （上位方案 §六 的单点回滚）→ 一个字节都不写，回到刀二之前的形态。
 *
 * 日志纪律：失败只 warn 错误摘要（可能含上游地址，只进服务端日志），
 * **绝不把履历正文 / 派单需求 / 结果行写进日志**。
 */

/** 每 scope 的 work 履历上限；超出删最旧（沿用 store.pruneOldest 的 kind 规则）。 */
export const WORK_RECORD_CAP = 200;

/** 履历摘要窗口：近 10 单。 */
export const WORK_SUMMARY_LIMIT = 10;

export type WorkStatus = "done" | "failed" | "aborted" | "canceled";

export interface WorkSettlementInput {
	/** 任务单号（也是稳定记忆 id 的一部分） */
	ticketId: string;
	/** 派单需求正文，压成一句话摘要 */
	requirement: string;
	/** 终态枚举：needs_you / idle 等中间态不传到这里（不落账） */
	status: WorkStatus;
	/** 结果一行 */
	line: string;
	/** 产物目录（TicketResult.tasks[].dir）；产物文件清单不透传，只记目录 */
	productDirs: string[];
	/** 发起会话的内部自增 id，用于按 origin 认出执事 */
	originConversationId: number;
	domain: string;
}

export interface WorkSummary {
	/** 完成 */
	done: number;
	/** 失败 */
	failed: number;
	/** 中止（aborted / canceled / 认不出的旧格式） */
	stopped: number;
	/** 窗口内记录数（≤ WORK_SUMMARY_LIMIT） */
	total: number;
}

let store: SqliteMemoryStore | null | undefined;

/** 回滚开关：只有明确写 false/0 才关（与 CHANCELLOR_ENABLED 同读法）。 */
export function workRecordEnabled(): boolean {
	const raw = (process.env.PARTNER_WORK_RECORD ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0";
}

function memoryDbPath(): string {
	return process.env.MEMORY_DB_PATH ?? ".data/memory.db";
}

/**
 * 读口 `create=false`：库文件不存在就返回 null（**不建文件**），免得纯装配读
 * 在测试 / 无记忆的机器上凭空造一个 .data/memory.db。写口 `create=true` 才建。
 * 只有成功打开才缓存；关着 / 打不开都不缓存，下一次还能重试。
 */
function openStore(create: boolean): SqliteMemoryStore | null {
	// 开关判断放在缓存判断**之前**：PARTNER_WORK_RECORD=false 时哪怕库已经打开过，
	// 读写也都立刻停（一行回滚，不留"库开着就绕过开关"的口子）。
	if (process.env.MEMORY_ENABLED === "false" || !workRecordEnabled()) return null;
	if (store) return store;
	const path = memoryDbPath();
	if (!create && !existsSync(path)) return null;
	try {
		mkdirSync(dirname(path), { recursive: true });
		store = new SqliteMemoryStore(path);
		return store;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[work] 履历库打开失败（不影响结算）: ${detail.slice(0, 200)}`);
		return null;
	}
}

function oneLine(text: string, max: number): string {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * content 一行：单号 ｜ 任务一句话摘要 ｜ 终态=状态 ｜ 结果一行 ｜（产物目录，有则带）。
 * `终态=<状态>` 是给 `parseWorkStatus` / 装配摘要用的可解析标记，不额外加字段
 * （动 MemoryRecord 的形状等于动 durable / 导出 / 手机端全套契约）。
 */
export function formatWorkContent(input: WorkSettlementInput): string {
	const parts = [
		input.ticketId,
		oneLine(input.requirement, 60),
		`终态=${input.status}`,
		oneLine(input.line, 80) || "（无结果行）",
	];
	const dirs = input.productDirs.filter(Boolean).slice(0, 3);
	if (dirs.length) parts.push(`产物=${oneLine(dirs.join(", "), 120)}`);
	return parts.join("｜");
}

function parseWorkStatus(content: string): string | null {
	return /终态=([a-z]+)/.exec(content)?.[1] ?? null;
}

/**
 * 落一条 work 履历到**发起执事**的 `partner:<id>` scope。
 *
 * 只认 `partnerIdOfSession(originConversationId)`（刀一同款判据）：主人 / 总管会话
 * 没有执事链接 → 不落账（他没有执事履历）。整段 try/catch：写失败只 warn，
 * 绝不把结算主流程拖下水。
 */
export function recordWorkSettlement(input: WorkSettlementInput): void {
	try {
		const partnerId = partnersStore().partnerIdOfSession(input.originConversationId);
		if (!partnerId || partnerId === CHIEF_PARTNER_ID) return;
		const scope = scopeKey({ type: "partner", id: partnerId });
		const db = openStore(true);
		if (!db) return;
		const record: MemoryRecord = {
			id: `work:${input.ticketId}`,
			kind: "work",
			scope,
			content: formatWorkContent(input),
			// 履历是事实台账，不靠 importance 排序（召回也排除它），给个中值即可
			importance: 0.5,
			veracity: "tool",
			source: "work",
			createdAt: new Date().toISOString(),
			validUntil: null,
			supersededBy: null,
			recallCount: 0,
			lastRecalledAt: null,
		};
		db.put(record);
		// 每 scope 200 条封顶、超出删最旧；只按 work 计数，不动别的形态。
		db.pruneOldest(scope, WORK_RECORD_CAP, { kinds: ["work"] });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[work] 履历落库失败（不影响结算）: ${detail.slice(0, 200)}`);
	}
}

/**
 * 结构化查询：按 `scope + kind="work"` 取最近 N 条（created_at 倒序），聚合成
 * 「近 10 单：完成 X、失败 Y、中止 Z」。**不走语义召回**（work 已被召回层排除）。
 *
 * 读口不带 create：库不存在 / 没记录 → null（装配据此整行省略）。
 */
export function workSummaryFor(partnerId: string, limit = WORK_SUMMARY_LIMIT): WorkSummary | null {
	const db = openStore(false);
	if (!db) return null;
	try {
		const rows = db.search({
			scopes: [scopeKey({ type: "partner", id: partnerId })],
			kinds: ["work"],
			limit: Math.max(1, Math.min(WORK_SUMMARY_LIMIT, limit)),
		});
		if (rows.length === 0) return null;
		const summary: WorkSummary = { done: 0, failed: 0, stopped: 0, total: rows.length };
		for (const row of rows) {
			const status = parseWorkStatus(row.content);
			if (status === "done") summary.done += 1;
			else if (status === "failed") summary.failed += 1;
			else summary.stopped += 1;
		}
		return summary;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[work] 履历读取失败: ${detail.slice(0, 200)}`);
		return null;
	}
}

/**
 * 关掉本模块自己开的 SQLite 句柄（进程收尾 / 单测清理用）。
 * 与 `PartnersStore.close()` 同款：这个模块也持着一个连接，不关的话 Windows 上
 * 临时库删不掉。关完下次 openStore 会按需重开。
 */
export function closeWorkStore(): void {
	store?.close();
	store = undefined;
}
