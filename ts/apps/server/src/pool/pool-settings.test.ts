import assert from "node:assert/strict";
import { test } from "node:test";
import {
	POOL_MAX_TURNS,
	POOL_MAX_TURNS_DEFAULT,
	bashTimeoutSeconds,
	poolEscalationWaitMs,
	poolHarnessSettings,
	poolMaxTurns,
	poolReserveTokens,
} from "./pool-settings.ts";

/**
 * 池内上下文管理档位（设计文档 §5.9）。核心只有一件事：**触发点按窗口 70%**，
 * 而不是内核默认的 `reserveTokens=16384`（窗口 131072 时那是 87.5% 才压）。
 *
 * 内核的算式是 `blocking = contextWindow - reserveTokens`（实读
 * `pi-durable/dist/harness/generation.js`，另见 `compaction-settings.ts` 文首），
 * 所以"70% 触发"要写成"reserve = 30%"。
 */

const MODEL_KEY = "bailian/deepseek-v4.1-flash";
const WINDOW = 131_072;

/** 取 `poolHarnessSettings` 里真正生效的那份 reserveTokens（全局档）。 */
function reserveOf(settings: ReturnType<typeof poolHarnessSettings>): number | undefined {
	return settings.compaction?.reserveTokens;
}

test("窗口 131072：压缩触发点落在 70%（不是内核默认的 87.5%）", () => {
	const settings = poolHarnessSettings({}, WINDOW, MODEL_KEY);
	const reserve = reserveOf(settings);
	assert.ok(reserve !== undefined, "必须显式给出 reserveTokens，否则就是内核默认 16384");
	// 131072 × 30% = 39322
	assert.equal(reserve, Math.round(WINDOW * 0.3));
	const trigger = WINDOW - reserve!;
	assert.ok(
		trigger >= 91_000 && trigger <= 92_400,
		`触发点应落在窗口 70%±1%，实算 ${trigger}（${((trigger / WINDOW) * 100).toFixed(2)}%）`,
	);
	// 内核默认档（87.5%）必须被覆盖掉，否则本票等于没接压缩设置
	assert.notEqual(reserve, 16_384);
	assert.equal(settings.compaction?.enabled, true);
});

test("modelOverrides 用真实 modelKey，不用内核匹配不了的 \"*\"", () => {
	const settings = poolHarnessSettings({}, WINDOW, MODEL_KEY);
	const overrides = settings.compaction?.modelOverrides ?? {};
	assert.deepEqual(Object.keys(overrides), [MODEL_KEY]);
	assert.equal(overrides[MODEL_KEY]?.reserveTokens, reserveOf(settings));
	// 内核 compactionPolicy() 按 `${provider}/${modelId}` 精确查表，无通配档："*" 是静默失效的配置
	assert.ok(!("*" in overrides), '不许用 "*" 当 modelOverrides 的键');
});

test("POOL_MAX_TURNS 常量存在且等于缺省；poolMaxTurns 按 env 算", () => {
	assert.equal(POOL_MAX_TURNS_DEFAULT, 100);
	assert.equal(POOL_MAX_TURNS, poolMaxTurns());
	assert.ok(Number.isInteger(POOL_MAX_TURNS) && POOL_MAX_TURNS > 0);

	assert.equal(poolMaxTurns({}), 100, "未设 AGENT_MAX_TURNS = 100");
	assert.equal(poolMaxTurns({ AGENT_MAX_TURNS: "50" }), 50);
	assert.equal(poolMaxTurns({ AGENT_MAX_TURNS: "12.9" }), 12, "取整向下");
	assert.equal(poolMaxTurns({ AGENT_MAX_TURNS: "abc" }), 100, "非数字回落 100");
	assert.equal(poolMaxTurns({ AGENT_MAX_TURNS: "-1" }), 100, "<0 回落 100");
	// 0 是合法取值 = "不限回合"，与宿主 turn-gate.ts 同语义
	assert.equal(poolMaxTurns({ AGENT_MAX_TURNS: "0" }), 0);
});

test("bashTimeoutSeconds 与宿主 reliability.ts 同判据", () => {
	assert.equal(bashTimeoutSeconds({}), 900, "未设 = 900 秒");
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "0" }), 0, "显式 0 = 不注入默认超时");
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "30" }), 30);
	// 注意：任务书这里写的是"非法值返回 900"，但宿主 reliability.ts 的实际语义是
	// 非法值 → 0（= 不注入，保持内核 no-default-timeout）。本函数是宿主的转发，
	// 不另发明一套判据，所以按宿主断言；差异已写进 REPORT。
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "abc" }), 0);
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "-5" }), 0);
});

test("reserveTokens 有下限：小窗口不算出 0 / 负数", () => {
	for (const window of [1024, 2048, 4096, 200]) {
		const reserve = poolReserveTokens({}, window, MODEL_KEY);
		assert.ok(reserve !== undefined && reserve >= 1024, `窗口 ${window} 的 reserve=${reserve} 低于下限 1024`);
		assert.ok(reserve <= window || reserve === 1024, `窗口 ${window} 的 reserve=${reserve} 超过窗口`);
		const trigger = window - reserve;
		assert.ok(Number.isInteger(trigger), `窗口 ${window} 的触发点不是整数`);
	}
});

test("窗口不可信（≤0）：不覆盖，回落内核默认", () => {
	assert.equal(poolReserveTokens({}, 0, MODEL_KEY), undefined);
	assert.equal(poolReserveTokens({}, -1, MODEL_KEY), undefined);
	const settings = poolHarnessSettings({}, 0, MODEL_KEY);
	assert.equal(settings.compaction?.enabled, true);
	assert.equal(settings.compaction?.reserveTokens, undefined);
	assert.equal(settings.compaction?.modelOverrides, undefined);
});

test("AGENT_COMPACT_ENABLED=false：整档关掉", () => {
	const settings = poolHarnessSettings({ AGENT_COMPACT_ENABLED: "false" }, WINDOW, MODEL_KEY);
	assert.deepEqual(settings.compaction, { enabled: false });
});

test("上报等待上限：默认 10 分钟；0/负数 = 无限等；非法值回落默认", () => {
	assert.equal(poolEscalationWaitMs({}), 10 * 60_000);
	assert.equal(poolEscalationWaitMs({ WORKER_POOL_ESCALATION_WAIT_MS: "0" }), 0);
	assert.equal(poolEscalationWaitMs({ WORKER_POOL_ESCALATION_WAIT_MS: "-1" }), 0);
	assert.equal(poolEscalationWaitMs({ WORKER_POOL_ESCALATION_WAIT_MS: "abc" }), 10 * 60_000);
	assert.equal(poolEscalationWaitMs({ WORKER_POOL_ESCALATION_WAIT_MS: "1500" }), 1500);
});
