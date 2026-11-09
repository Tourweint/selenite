/**
 * 巩固审计的装配与落盘（2026-11-10 批 17 §三）。
 *
 * 记忆包里的 `consolidateScope()` 是纯函数：只算建议、不改库。这里做两件服务端的事：
 *   - 读 `MEMORY_USAGE_RANKING`（默认开）决定保留优先级；
 *   - 把差异摘要原子写到 `.data/memory-consolidate-diff.json`，供界面查询。
 *
 * **红线**：淘汰只出建议，绝不自动删。本模块只写一个 JSON 文件，从不调用
 * `store.remove()` / `supersede()`。diff 里只存 id、kind 与 ≤40 字摘要，不存正文
 * （日志与导出纪律，同 D8）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ConsolidateDiff } from "@lifediary/memory";
import { memoryEngine } from "./agent/assist.ts";

/** 未用淘汰排序开关（默认开）：false = 只看创建时间、不给未用淘汰建议（一行回滚）。 */
export function memoryUsageRankingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.MEMORY_USAGE_RANKING ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0";
}

/** diff 落点；探针用 env 与真实 `.data` 隔离。 */
export function consolidateDiffPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.MEMORY_CONSOLIDATE_DIFF_PATH?.trim() || ".data/memory-consolidate-diff.json");
}

/**
 * 跑一次确定性巩固审计并落盘。返回 null = 记忆未启用 / 库不可用（调用方按 404 处理）。
 *
 * **不 await、不重试**：审计是只读快照，失败只影响这份文件，不该影响请求主流程。
 */
export function runConsolidatePass(scope: string): ConsolidateDiff | null {
	if (!memoryEngine) return null;
	const diff = memoryEngine.auditConsolidation(scope, {
		usageRanking: memoryUsageRankingEnabled(),
	});
	try {
		writeDiff(diff, consolidateDiffPath());
	} catch (error) {
		// 只记错误摘要（可能含路径），不记记忆正文
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 巩固 diff 落盘失败: ${detail.slice(0, 200)}`);
	}
	return diff;
}

/** 读上次审计结果；文件不存在 / 坏 JSON → null（界面按"还没跑过"处理）。 */
export function readConsolidateDiff(
	env: NodeJS.ProcessEnv = process.env,
): ConsolidateDiff | null {
	try {
		const parsed = JSON.parse(readFileSync(consolidateDiffPath(env), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const candidate = parsed as Partial<ConsolidateDiff>;
		if (typeof candidate.scope !== "string") return null;
		return {
			scope: candidate.scope,
			generatedAt: String(candidate.generatedAt ?? ""),
			kept: Number(candidate.kept ?? 0),
			merged: Array.isArray(candidate.merged) ? candidate.merged : [],
			retired: Array.isArray(candidate.retired) ? candidate.retired : [],
		};
	} catch {
		return null;
	}
}

/** 原子写：先写临时文件再改名，读到的永远是整份 JSON。 */
function writeDiff(diff: ConsolidateDiff, path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, `${JSON.stringify(diff, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
