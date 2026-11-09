import assert from "node:assert/strict";
import { test } from "node:test";
import {
	delegationRunSource,
	isTestRun,
	projectRunSource,
	runSourceEnabled,
} from "./run-source.ts";

/**
 * 触发来源单测（2026-11-10 批 15 §三）：开关、测试进程识别、派单来源优先级。
 * 回执列与详情投影的落库口径在 delegation-receipts.test.ts / http 探针里验。
 */

test("RUN_SOURCE：默认开；false/0/off 才关", () => {
	assert.equal(runSourceEnabled({}), true);
	assert.equal(runSourceEnabled({ RUN_SOURCE: "" }), true);
	assert.equal(runSourceEnabled({ RUN_SOURCE: "false" }), false);
	assert.equal(runSourceEnabled({ RUN_SOURCE: "0" }), false);
	assert.equal(runSourceEnabled({ RUN_SOURCE: "off" }), false);
	assert.equal(runSourceEnabled({ RUN_SOURCE: "true" }), true);
});

test("测试进程：VITEST / NODE_TEST_CONTEXT / NODE_ENV=test 命中，生产不命中", () => {
	assert.equal(isTestRun({ VITEST: "true" }), true);
	assert.equal(isTestRun({ NODE_TEST_CONTEXT: "child-v8" }), true);
	assert.equal(isTestRun({ NODE_ENV: "test" }), true);
	assert.equal(isTestRun({ NODE_ENV: "production" }), false);
	assert.equal(isTestRun({}), false);
});

test("派单来源：测试 > 设备 > 例行轮 > 人", () => {
	// 测试进程（本进程）优先级最高：传了 VITEST 就一定是 test。
	assert.equal(delegationRunSource({ device: true, routineTurn: true, env: { VITEST: "1" } }), "test");
	assert.equal(delegationRunSource({ device: true, routineTurn: true, env: {} }), "device");
	assert.equal(delegationRunSource({ routineTurn: true, env: {} }), "routine");
	assert.equal(delegationRunSource({ env: {} }), "human");
});

test("详情投影：老数据 null 视为 human；开关关着不出现", () => {
	assert.equal(projectRunSource(null, {}), "human");
	assert.equal(projectRunSource("routine", {}), "routine");
	assert.equal(projectRunSource(null, { RUN_SOURCE: "false" }), undefined);
});
