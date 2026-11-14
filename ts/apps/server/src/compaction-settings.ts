/**
 * 上下文压缩设置（2026-11-14，用户两次拍板后的最终形态）。
 *
 * 最终口径：**只留「按百分比」和「按 token」两档，默认按百分比 70%**；
 * 保留原文（`keepRecentTokens`）与后台提前（`backgroundTokens`）从界面和换算里全删，
 * 一律吃内核默认（20000 / 32768）——它们不是用户能凭直觉调的量。
 *
 * 纯转换：env（界面写入走 flags 层，落盘后同步写 env）→ 内核 `CompactionSettings`。
 * 单独成模块的理由同 `reliability.ts`：`agent.ts` 模块加载即建 memoryEngine / skillStore，
 * 单测 import 它会有副作用。
 *
 * ── 内核口径（实读 `pi-durable/dist/harness` 1.4.0）──
 *   `generation.js:236-246`  blocking = contextWindow - reserveTokens；
 *                            `tokens > blocking` → 阻塞压缩（压完继续跑这一轮），
 *                            `tokens > blocking - backgroundTokens` → 提前起一次后台压。
 *   `compaction.js:194-203`  `compactionPolicy(settings, model)` 按 `${provider}/${modelId}`
 *                            查 `modelOverrides`，逐字段盖过 Harness 全局值。
 *   `agent.js:10-15`         默认 `{enabled:true, reserveTokens:16384, keepRecentTokens:20000,
 *                            backgroundTokens:32768}`。
 *
 * 所以"什么时候压"在内核里是**窗口减白**，在用户脑子里是"用到多少就压"。两边差一个减法：
 *   trigger = window - reserve。
 * 例：窗口 100K、按 token 填 70 → 到 70K 就压一次，压完接着跑这一轮（不是压完就停）。
 *
 * 百分比必须按各模型的窗口换算，因此只能落在 `modelOverrides` 上；全局只给 `enabled`，
 * 窗口不可信的模型（faux / 未登记派生）回落内核 16384。
 */

import type { CompactionPolicy, CompactionSettings } from "@earendil-works/pi-durable";

type Env = Record<string, string | undefined>;

/** 触发点怎么算：窗口占比 / 绝对 token（没有"跟随内核"这一档，默认就是 70%） */
export type CompactionTriggerMode = "percent" | "tokens";

export interface CompactionConfig {
	enabled: boolean;
	mode: CompactionTriggerMode;
	/** 窗口用到多少百分比就压（整数 5–95，越界夹回） */
	percent: number;
	/** 绝对触发点（token）；undefined = 该模式下不生效（回落内核默认白） */
	tokens?: number;
}

/** 1K = 1024 token（界面按 K 填，与内核的 token 计数只差这一层换算） */
const K = 1024;
/** 给回答留白的下限：再小就等于"每轮都压"，会把一轮对话切成碎片 */
const MIN_RESERVE = 1024;
const PERCENT_MIN = 5;
const PERCENT_MAX = 95;
const DEFAULT_PERCENT = 70;

const MODES: readonly CompactionTriggerMode[] = ["percent", "tokens"];

function trimmed(env: Env, key: string): string {
	return (env[key] ?? "").trim();
}

function integer(env: Env, key: string): number | undefined {
	const raw = trimmed(env, key);
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isInteger(value) ? value : undefined;
}

function flagFalse(raw: string): boolean {
	const value = raw.toLowerCase();
	return value === "false" || value === "0" || value === "off";
}

/**
 * env → 配置。非法值一律回落（`AGENT_COMPACT_*` 是安全机制的旋钮，
 * 配错了不能变成"永不压缩"或"每轮都压缩"）。
 */
export function readCompactionConfig(env: Env = process.env): CompactionConfig {
	const enabledRaw = trimmed(env, "AGENT_COMPACT_ENABLED");
	// 缺省开：与内核默认一致；显式 false/0/off 才关
	const enabled = enabledRaw ? !flagFalse(enabledRaw) : true;

	const modeRaw = trimmed(env, "AGENT_COMPACT_TRIGGER_MODE").toLowerCase();
	// 缺省 = 按百分比（用户 2026-11-14 拍板：默认就 70% 压）
	const mode = (MODES as readonly string[]).includes(modeRaw)
		? (modeRaw as CompactionTriggerMode)
		: "percent";

	const percentRaw = integer(env, "AGENT_COMPACT_TRIGGER_PERCENT");
	const percent =
		percentRaw === undefined
			? DEFAULT_PERCENT
			: Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, percentRaw));

	const tokensK = integer(env, "AGENT_COMPACT_TRIGGER_K");
	// K 必须 ≥1：0 会让 trigger=0 → 每轮都压
	const tokens = tokensK !== undefined && tokensK >= 1 ? tokensK * K : undefined;

	return { enabled, mode, percent, tokens };
}

/** 该模型的触发点（token）；`undefined` = 这一档不按模型算，走全局 */
function triggerOf(config: CompactionConfig, window: number): number | undefined {
	if (window <= 0) return undefined;
	if (config.mode === "percent") return Math.round(window * config.percent / 100);
	if (config.mode === "tokens") return config.tokens;
	return undefined;
}

/**
 * 触发点 → 内核要的 `reserveTokens`（给回答留的白）。
 *
 * 夹在 `[MIN_RESERVE, window - MIN_RESERVE]`：
 *   - 下界：再小就"每轮都压"，没有对话可言；
 *   - 上界：`window` 本身也要留一点，否则 `reserve > window` 时判据变负数
 *     （按 token 填了超过窗口的量时，就落到这条上界 = 几乎每轮都压）。
 */
function reserveOf(window: number, trigger: number): number {
	const raw = window - trigger;
	const ceiling = Math.max(MIN_RESERVE, window - MIN_RESERVE);
	return Math.min(ceiling, Math.max(MIN_RESERVE, raw));
}

/**
 * 配置 + 各模型窗口 → 内核 `CompactionSettings`。
 *
 * `windows` 是 `${provider}/${modelId} → contextWindow`，含基座与思考 / 任务变体
 * （会话里存的模型是 `<模型>#think-<档>`，只登记基座会漏掉全部会话）。
 */
export function compactionSettings(
	config: CompactionConfig,
	windows: ReadonlyMap<string, number>,
): CompactionSettings {
	const base: Partial<CompactionPolicy> = { enabled: config.enabled };
	// 关掉自动压缩时不必发覆盖：没人会看这些数字
	if (!config.enabled) return base;

	const overrides: Record<string, Partial<CompactionPolicy>> = {};
	for (const [ref, window] of windows) {
		const trigger = triggerOf(config, window);
		if (trigger === undefined) continue;
		overrides[ref] = { reserveTokens: reserveOf(window, trigger) };
	}

	return {
		...base,
		...(Object.keys(overrides).length > 0 ? { modelOverrides: overrides } : {}),
	};
}

/** 启动日志用：打印实际生效档位，不打印原始 env 文本 */
export interface CompactionSummary {
	enabled: boolean;
	mode: CompactionTriggerMode;
	/** 人话：`窗口 70%` / `触发 100K` / `关闭` */
	trigger: string;
	/** 有几个模型拿到了自己的覆盖值 */
	overridden: number;
}

export function compactionSummary(
	config: CompactionConfig,
	windows: ReadonlyMap<string, number> = new Map(),
): CompactionSummary {
	const trigger = !config.enabled
		? "关闭"
		: config.mode === "percent"
			? `窗口 ${config.percent}%`
			: config.tokens !== undefined
				? `触发 ${Math.round(config.tokens / K)}K`
				: "触发未设(回落内核默认)";
	let overridden = 0;
	if (config.enabled) {
		for (const window of windows.values()) if (triggerOf(config, window) !== undefined) overridden += 1;
	}
	return { enabled: config.enabled, mode: config.mode, trigger, overridden };
}
