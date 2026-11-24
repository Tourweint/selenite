import type { HarnessSettings } from "@earendil-works/pi-durable";
import { compactionSettings, readCompactionConfig } from "../compaction-settings.ts";
import { bashTimeoutSeconds as hostBashTimeoutSeconds } from "../reliability.ts";

/**
 * 池进程的上下文管理档位（设计文档 §5.9「上下文管理补齐」，P2 骨架）。
 *
 * 纯函数：不读文件、不起进程、不碰 Harness。装配层（P2 池进程入口）每票算一次——
 * `HarnessOptions.settings` 允许传函数（"Run settings, or a function returning the current
 * ones; read at each use either way"），所以要传 `() => poolHarnessSettings(...)`，
 * 这样同一进程串行跑下一票时才会按那一票的模型窗口重算。
 *
 * 与宿主的分工：换算逻辑一律复用 `compaction-settings.ts` 与 `reliability.ts`，
 * 这里只做"池内只有一个模型 / 只算一个窗口"这一层收口，不重写第二套换算。
 *
 * 刻意**不用** `modelOverrides: { "*": ... }`：内核 `compactionPolicy()`（实读
 * `pi-durable/dist/harness/compaction.js:195-204`）按 `${provider}/${modelId}` 精确查表，
 * 没有通配档——`"*"` 能通过类型检查，但永远命中不了，等于一条静默失效的配置。
 * 所以这里把同一个值**同时**写进全局 `reserveTokens` 与 `modelOverrides[modelKey]`：
 * 全局那份保证"这一票实际选的模型与传进来的 key 不一致时也生效"。
 */

type Env = Record<string, string | undefined>;

/** `AGENT_MAX_TURNS` 缺省值，与宿主 `turn-gate.ts:64` 同值。 */
export const POOL_MAX_TURNS_DEFAULT = 100;

/**
 * 等上报答复的上限（2026-11-23 M4 收口）：默认 10 分钟。
 *
 * 为什么要有：池进程一条活跃会话，等答复期间仍然占着一口锅。人可能几小时后才回，
 * 不能让它无限期占槽。超时后把 REPORT 改成 blocked 并退场（槽位释放），
 * 用户回来在任务线程回话走既有 resume 链路续跑。
 *
 * `WORKER_POOL_ESCALATION_WAIT_MS`；0 / 负数 = 无限等（旧行为）。
 */
export function poolEscalationWaitMs(env: Env = process.env): number {
	const raw = env.WORKER_POOL_ESCALATION_WAIT_MS;
	if (raw === undefined || raw.trim() === "") return 10 * 60_000;
	const value = Number(raw);
	if (!Number.isFinite(value)) return 10 * 60_000;
	return Math.floor(value) > 0 ? Math.floor(value) : 0;
}

/** reserve 的下限，与 `compaction-settings.ts` 的 `MIN_RESERVE` 同值：再小等于每轮都压。 */
const MIN_RESERVE_TOKENS = 1024;

/**
 * 单轮工具回合上限（`WORKER_POOL_MAX_TURNS` > `AGENT_MAX_TURNS`，默认 100；
 * 非法或 <0 回落 100，取整）。
 *
 * 宿主与池共用一份 env 时，`AGENT_MAX_TURNS` 原本是给宿主模型循环压轮次用的
 * （很多探针会把它压到 1）；池进程继承同一份 env 就会跟着被压，干活干一半被拦。
 * 2026-11-23 起给池单独一条覆盖：不设 = 沿用 `AGENT_MAX_TURNS`（旧口径），
 * 探针 / 部署可以只调池的回合上限。
 *
 * 这是宿主 `turn-gate.ts` **自己实现**的机制：内核 1.4.0 没有 `maxTurns`，
 * 所以这里只导出读数，由 `beforeTool` 的 hook 数回合用，
 * 不许塞进 `Harness.open` 的 agent 配置（塞了会被无声忽略）。
 */
export function poolMaxTurns(env: Env = process.env): number {
	const raw = Number(
		env.WORKER_POOL_MAX_TURNS ?? env.AGENT_MAX_TURNS ?? POOL_MAX_TURNS_DEFAULT,
	);
	if (!Number.isFinite(raw) || raw < 0) return POOL_MAX_TURNS_DEFAULT;
	return Math.floor(raw);
}

/**
 * 模块级常量：装配层直接读它，语义与宿主的 `MAX_TURNS` 一致（进程启动时冻结）。
 * 要按 env 夹具算（比如单测）就用 `poolMaxTurns(env)`。
 */
export const POOL_MAX_TURNS: number = poolMaxTurns();

/**
 * bash 默认超时（秒，`AGENT_BASH_TIMEOUT_S`，默认 900）。
 * 直接复用宿主 `reliability.ts` 的同名函数，两边走同一套判据：
 * 未设 = 900；`0` / 负数 / 非法值 = 0（= 不注入默认超时，保持内核"无限等"的原语义）。
 */
export function bashTimeoutSeconds(env: Env = process.env): number {
	return hostBashTimeoutSeconds(env);
}

/**
 * 距阻塞压缩触发点还给回答留的白（token）：`contextWindow - 触发点`，
 * 由 `compaction-settings.ts` 按 `AGENT_COMPACT_TRIGGER_PERCENT`（默认 70%）换算并夹边界。
 *
 * 窗口 ≤0 时返回 `undefined` = 不覆盖，回落内核 16384（窗口不可信的模型就该吃默认）。
 */
export function poolReserveTokens(
	env: Env,
	contextWindow: number,
	modelKey: string,
): number | undefined {
	if (!(contextWindow > 0)) return undefined;
	const config = readCompactionConfig(env);
	const settings = compactionSettings(config, new Map([[modelKey, contextWindow]]));
	const computed = settings.modelOverrides?.[modelKey]?.reserveTokens;
	if (computed !== undefined) return computed;
	// `AGENT_COMPACT_TRIGGER_MODE=tokens` 且没填 K 时，换算不产出按窗口的值：
	// 按"70% 触发"的本阶段口径兜底，保证不出现 0 / 负数。
	return Math.max(MIN_RESERVE_TOKENS, Math.round((contextWindow * (100 - config.percent)) / 100));
}

/**
 * 池内 `HarnessSettings`：只装压缩这一件事。
 *
 * `modelKey` 必须是 `${provider}/${modelId}`，与这一票真正要用的模型同源；
 * 万一不一致，全局 `reserveTokens` 那份仍然生效（override 命中不了也不会退回内核默认）。
 * 触发点落在窗口 70%：内核默认 `reserveTokens=16384` 在窗口 131072 时是 87.5% 才压，太晚。
 */
export function poolHarnessSettings(
	env: Env,
	contextWindow: number,
	modelKey: string,
): HarnessSettings {
	const config = readCompactionConfig(env);
	if (!config.enabled) return { compaction: { enabled: false } };
	const reserve = poolReserveTokens(env, contextWindow, modelKey);
	if (reserve === undefined) return { compaction: { enabled: true } };
	return {
		compaction: {
			enabled: true,
			reserveTokens: reserve,
			modelOverrides: { [modelKey]: { reserveTokens: reserve } },
		},
	};
}
