/**
 * 触发来源（2026-11-10 批 15 §三，全景调研 #44）。
 *
 * 回答"这张单 / 这一轮是谁发起的"：人、例行轮、执事自建例行的首轮、HTTP 脚本、
 * 探针/测试、设备矩阵。原本只用于**旁路簿记**（回执列 + run 记录 + 详情投影），
 * 不改变派单 / 例行 / 设备的任何语义。
 *
 * 2026-11-22 M1b 起多了一个用途：`priorityOfRunSource()` 把来源映射成 ticket 准入
 * 优先级，决定同时排队时谁先跑。优先级只传给 chancellor，不落回执、不下发客户端；
 * 簿记列与投影口径仍由下面的开关控制，和之前一致。
 *
 * 开关 `RUN_SOURCE` 默认开；`false`/`0`/`off` → 不写不返，行为回到改动前。
 * 老数据没有这一列 = null，投影时视为 `human`（见 delegation-api 的详情投影）。
 *
 * 本文件不 import agent/：来源判定只看注入的布尔量与环境，单测不需要真 harness。
 */

export type RunSource = "human" | "routine" | "routine_self" | "script" | "test" | "device";

/**
 * 触发来源 → ticket 准入优先级（2026-11-22 调度层 M1b）：0 最高。
 *
 * 这是 **2026-11-22 起的语义变化**：runSource 以前只做簿记，现在还要决定
 * 「同时排队的单谁先跑」。数值不写进回执、不下发客户端，只由宿主在派单时
 * 传给 chancellor（`ChancellorRequest.priority`）。
 * human(0) > device(1) > routine/routine_self(2) > script(3) > test(9)；
 * 未知来源回落 5（与 ChancellorRequest.priority 的缺省一致）。
 */
const RUN_SOURCE_PRIORITY: Record<RunSource, number> = {
	human: 0,
	device: 1,
	routine: 2,
	routine_self: 2,
	script: 3,
	test: 9,
};

export function priorityOfRunSource(source: RunSource): number {
	return RUN_SOURCE_PRIORITY[source] ?? 5;
}

/** 回滚开关：默认开；只有明确写 false / 0 / off 才关。 */
export function runSourceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.RUN_SOURCE ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * 是不是测试进程。node:test / vitest 都会给环境加标记；
 * 生产服务端不会命中（探针走真实 HTTP，按 script / device 记账）。
 */
export function isTestRun(env: NodeJS.ProcessEnv = process.env): boolean {
	// vitest 用 VITEST；node:test 的子进程用 NODE_TEST_CONTEXT（本仓库的单测走后者）。
	if (env.VITEST || env.NODE_TEST_CONTEXT) return true;
	return (env.NODE_ENV ?? "").trim().toLowerCase() === "test";
}

export interface DelegationRunSourceInput {
	/** 设备矩阵派发（跨机 worker） */
	device?: boolean;
	/** 这一轮是例行任务轮（进程内标记 `isRoutineTurn`） */
	routineTurn?: boolean;
	env?: NodeJS.ProcessEnv;
}

/**
 * 派单回执的来源。优先级：测试 > 设备 > 例行轮 > 人。
 * 设备活优先于例行轮：跨机派发是结构性事实，比"哪个会话发起"更强。
 */
export function delegationRunSource(input: DelegationRunSourceInput = {}): RunSource {
	if (isTestRun(input.env)) return "test";
	if (input.device) return "device";
	if (input.routineTurn) return "routine";
	return "human";
}

/**
 * 任务详情投影口径：有回执但列是 null（老数据）→ `human`；开关关着 → 不出现。
 * 传 `undefined`（没有回执）由调用方直接跳过，不走这里。
 */
export function projectRunSource(
	source: RunSource | null,
	env: NodeJS.ProcessEnv = process.env,
): RunSource | undefined {
	if (!runSourceEnabled(env)) return undefined;
	return source ?? "human";
}
