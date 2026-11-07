/**
 * 时间衰减与使用强化（2026-11-08 扫尾批 6 §一）。
 *
 * 两条都是**纯函数**：给定一条记录的 importance / 锚点时间 / 当前时间，
 * 算出"读这一刻应该算多少"和"这次召回之后应该落多少"。引擎层只负责
 * 在命中路径上把结果写回（`touchRecall`），这里不碰 store、不读时钟。
 *
 * 为什么锚点是 `lastRecallAt ?? createdAt`：被想起一次就相当于"重新确认了一次"，
 * 衰减从那一刻重新起算；从没被想起过的，从创建时间起算。
 *
 * 为什么写回不会越衰减越狠：写回只发生在召回命中时，而那一刻同时把
 * `lastRecalledAt` 推到 now —— 值衰减到 now、锚点也变成 now，下一次从新锚点
 * 重新算，不会把已经衰减过的值再乘一遍。
 */

/** 记忆重要性的下限：衰减到 0.1 就停住，永不归零、永不因为衰减被删除。 */
export const IMPORTANCE_FLOOR = 0.1;

/**
 * 重要性的上限（2026-11-08）。
 *
 * 召回命中每次 +0.05，长期高频使用的记忆会涨过 1。上限取 10 是给"越用越牢"
 * 留出空间，同时防止无界增长；召回打分的权重仍按 0..1 归一（见 recall.ts），
 * 所以涨过 1 之后只是"排得更前"，不会把别的维度挤成噪声。
 */
export const IMPORTANCE_CEIL = 10;

/** 召回命中一次加多少重要性。 */
export const RECALL_BOOST = 0.05;

const DAY_MS = 86_400_000;

function clamp(value: number): number {
	if (!Number.isFinite(value)) return IMPORTANCE_FLOOR;
	return Math.min(IMPORTANCE_CEIL, Math.max(IMPORTANCE_FLOOR, value));
}

/**
 * 按天数温和衰减后的重要性。
 *
 * `daily` 是日衰减系数（默认 0.99）：`importance * daily ** days`。
 * `daily <= 0` 或 `>= 1` 视为关闭，原值返回（只做上限裁剪，不改数值）。
 * 锚点解析不了（坏数据）同样原值返回 —— 记忆库里的坏时间戳不该让整轮召回炸掉。
 */
export function decayedImportance(
	importance: number,
	anchorIso: string | null,
	now: Date,
	daily: number,
): number {
	const base = Number.isFinite(importance) ? importance : IMPORTANCE_FLOOR;
	if (!(daily > 0 && daily < 1)) return Math.min(IMPORTANCE_CEIL, base);

	const anchor = anchorIso ? Date.parse(anchorIso) : Number.NaN;
	if (Number.isNaN(anchor)) return Math.min(IMPORTANCE_CEIL, base);

	const days = Math.max(0, (now.getTime() - anchor) / DAY_MS);
	if (days <= 0) return clamp(base);
	return clamp(base * Math.pow(daily, days));
}

/** 使用强化后的重要性（召回命中一次）。 */
export function reinforcedImportance(
	importance: number,
	step: number = RECALL_BOOST,
): number {
	return clamp((Number.isFinite(importance) ? importance : IMPORTANCE_FLOOR) + step);
}
