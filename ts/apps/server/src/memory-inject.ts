/**
 * 每轮记忆注入的预算开关（2026-11-15 项目记忆多挂载之后追加的一小批）。
 *
 * 为什么单独成模块：这两个数原先**硬编码**在 `@lifediary/memory` 的 `buildContext`
 * 默认值里（`maxChars = 1200`、`limit = 8`），没有任何 env 能调。实际跑下来两个都偏紧，
 * 而且**条数比字数更卡**——偏好记忆永不删除且优先成段，攒满 8 条之后，其余记忆
 * （含项目记忆）一条都进不来，1200 字预算根本用不满。
 *
 * 口径：
 *   - 缺省 = 16 条 / 2000 字（比旧硬编码的 8 条 / 1200 字放宽）；
 *   - 显式 `MEMORY_INJECT_LIMIT=8` + `MEMORY_INJECT_MAX_CHARS=1200` = 逐字节回到旧形态（一行回滚）；
 *   - 非法值 / 负数 / 超界的值一律 clamp 到边界，**不关掉能力**（要关记忆是 `MEMORY_ENABLED=false`）；
 *   - 纯函数收 env，与 `memory-proactive.ts` 同款（单测直接喂对象，不碰进程环境）。
 *
 * 这层只管**自动注入**（`recallContext` 每轮那一批）。`recall` 工具的 limit 是模型自己
 * 按需取的，不受这里约束——主动查多查少由模型判断。
 */

import { flagEnabled } from "./flags.ts";

/** 只作边界与默认值，改这里 = 改行为，必须进变更记录。 */
export const MEMORY_INJECT_DEFAULTS = {
	/** 每轮注入的记忆条数上限（召回 `limit`）。 */
	limit: 16,
	/** 每轮注入的记忆总字符预算。 */
	maxChars: 2000,
} as const;

const LIMIT_BOUNDS = { min: 1, max: 40 } as const;
const MAX_CHARS_BOUNDS = { min: 200, max: 8000 } as const;

function readInt(
	raw: string | undefined,
	fallback: number,
	bounds: { min: number; max: number },
): number {
	const text = (raw ?? "").trim();
	if (!text) return fallback;
	const value = Number(text);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/** 每轮注入条数上限。`MEMORY_INJECT_LIMIT`。 */
export function memoryInjectLimit(env: NodeJS.ProcessEnv = process.env): number {
	return readInt(env.MEMORY_INJECT_LIMIT, MEMORY_INJECT_DEFAULTS.limit, LIMIT_BOUNDS);
}

/** 每轮注入字符预算。`MEMORY_INJECT_MAX_CHARS`。 */
export function memoryInjectMaxChars(env: NodeJS.ProcessEnv = process.env): number {
	return readInt(env.MEMORY_INJECT_MAX_CHARS, MEMORY_INJECT_DEFAULTS.maxChars, MAX_CHARS_BOUNDS);
}

/**
 * 召回后去重总开关（2026-11-15 上下文预算批）：`MEMORY_INJECT_DEDUPE`。
 *
 * 默认**开**：同一件事的多种说法只留分数最高的一条进注入（判重是纯规则，
 * 阈值偏保守 0.85，见 memory 包的 `dedupeRecallHits`）。只影响本轮注入、不动库。
 * `false` / `0` / `off` = 关（回到"召回多少注多少"）。
 */
export function memoryInjectDedupeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("MEMORY_INJECT_DEDUPE", env);
}
