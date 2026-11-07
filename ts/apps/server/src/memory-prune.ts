import type { MemoryEngine } from "@lifediary/memory";

/**
 * 会话记忆封顶修剪的服务端装配（2026-11-07）。
 *
 * memory 包只提供 `pruneSessionScopes(cap)` 这个能力，env 在哪里读、cap=0 怎么理解、
 * 删了记什么日志，都是服务端的事——和 `memory-extract.ts` 的装配层同一分工。
 *
 * 日志纪律（D8）：只记删除条数，不记任何记忆正文；prune 抛错只记一句摘要，
 * 绝不让"整理记忆"把一次正常的对话写回拖挂。
 */
export function pruneSessionMemory(engine: MemoryEngine | null): number {
	if (!engine) return 0;
	const raw = Number(process.env.MEMORY_SESSION_CAP ?? 200);
	// 0 / 负数 / 非法值 = 关闭，回到"只增不减"的上一形态（一行回滚）。
	const cap = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
	if (cap === 0) return 0;
	try {
		return engine.pruneSessionScopes(cap);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] 会话记忆修剪失败（不影响写入）: ${detail.slice(0, 200)}`);
		return 0;
	}
}
