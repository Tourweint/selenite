import type { HarnessSettings } from "@earendil-works/pi-durable";

/**
 * 可靠性旋钮（2026-11-04 批次一，A4）。
 *
 * 单独成模块而不是塞进 agent.ts：agent.ts 模块加载即建 memoryEngine / skillStore，
 * 单测 import 它会有副作用。这里只做 env → 内核 settings 的纯转换。
 *
 * 内核默认值（实读 `pi-durable/dist/harness/agent.js:41-61`，2026-11-04）：
 *   retry      enabled / 3 次 / 2s 起步 / 60s 封顶
 *   compaction 16384 / 20000 / 32768
 *   toolExecution "parallel"
 *   steeringMode / followUpMode "one-at-a-time"
 *   afterFailedRun "keep"
 *   restartLimit 5
 * 这些本次不传，吃内核默认；只把两个旋钮显式化（调研方案 §四 A4 的处置表）。
 */

type Env = Record<string, string | undefined>;

export interface ReliabilitySummary {
	bashTimeoutS: number;
	streamTimeoutMs?: number;
	afterFailedRun?: "keep" | "continue" | "withdraw";
}

/**
 * 模型请求超时（毫秒）。不设 = 走 OpenAI SDK 默认 10 分钟。
 *
 * 该超时对流式请求主要约束连接 / 响应头等待，响应头到达后即清除
 * （`openai/client.js:1008-1025, 543-547`，SDK 7.19.0 实读），
 * 因此它**不约束整段生成时长**。
 */
function streamTimeoutMs(env: Env): number | undefined {
	const raw = Number(env.AGENT_STREAM_TIMEOUT_MS?.trim());
	return Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function afterFailedRun(env: Env): "keep" | "continue" | "withdraw" | undefined {
	const value = (env.AGENT_AFTER_FAILED_RUN ?? "").trim().toLowerCase();
	return value === "keep" || value === "continue" || value === "withdraw" ? value : undefined;
}

/**
 * bash 工具默认超时（秒）。默认 900（15 分钟）：
 * 慢机器上 install / 构建可能超过 10 分钟（2026-11-04 审查建议区间取值）。
 * `0` 或非法值 = `0` = 不做默认超时（保持内核"no default timeout"）。
 */
export function bashTimeoutSeconds(env: Env): number {
	const raw = env.AGENT_BASH_TIMEOUT_S?.trim();
	if (!raw) return 900;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * env → 内核 settings。全空时返回 `undefined`：干脆不传 settings，
 * "不改变行为"是构造上的保证，不靠"显式值恰好等于默认值"的推理。
 */
export function buildHarnessSettings(env: Env): HarnessSettings | undefined {
	const stream = streamTimeoutMs(env);
	const failed = afterFailedRun(env);
	if (stream === undefined && failed === undefined) return undefined;
	return {
		...(stream === undefined ? {} : { stream: { timeoutMs: stream } }),
		...(failed === undefined ? {} : { afterFailedRun: failed }),
	};
}

/** 启动日志用：打印实际解析值（不是原始 env 文本）。 */
export function reliabilitySummary(env: Env): ReliabilitySummary {
	const stream = streamTimeoutMs(env);
	const failed = afterFailedRun(env);
	return {
		bashTimeoutS: bashTimeoutSeconds(env),
		...(stream === undefined ? {} : { streamTimeoutMs: stream }),
		...(failed === undefined ? {} : { afterFailedRun: failed }),
	};
}
