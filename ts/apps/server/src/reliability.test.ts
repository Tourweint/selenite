import assert from "node:assert/strict";
import { test } from "node:test";
import { bashTimeoutSeconds, buildHarnessSettings } from "./reliability.ts";

/** 只看 stream / afterFailedRun 两个旋钮：压缩自 2026-11-14 起总是带着（默认 70%），
 *  这几条测试只关心"不设就不传"，所以把 compaction 剥掉再比。 */
function knobsOnly(env: Record<string, string | undefined>) {
	const { compaction, ...rest } = buildHarnessSettings(env);
	return rest;
}

test("settings：env 全空时只有压缩默认（stream / afterFailedRun 不传）", () => {
	assert.deepEqual(knobsOnly({}), {});
	assert.deepEqual(knobsOnly({ AGENT_STREAM_TIMEOUT_MS: "", AGENT_AFTER_FAILED_RUN: "" }), {});
	// 压缩从 2026-11-14 起默认就按 70% 生效（用户拍板），不再"全空就不传"
	assert.equal(buildHarnessSettings({}).compaction?.enabled, true);
	assert.equal(buildHarnessSettings({}).compaction?.modelOverrides, undefined);
});

test("settings：AGENT_STREAM_TIMEOUT_MS 只认正整数", () => {
	assert.deepEqual(knobsOnly({ AGENT_STREAM_TIMEOUT_MS: "123456" }), {
		stream: { timeoutMs: 123456 },
	});
	for (const bad of ["0", "-1", "abc", "1.5"]) {
		assert.deepEqual(knobsOnly({ AGENT_STREAM_TIMEOUT_MS: bad }), {});
	}
});

test("settings：AGENT_AFTER_FAILED_RUN 只认三个枚举值", () => {
	for (const value of ["keep", "continue", "withdraw"] as const) {
		assert.deepEqual(knobsOnly({ AGENT_AFTER_FAILED_RUN: value }), {
			afterFailedRun: value,
		});
	}
	assert.deepEqual(knobsOnly({ AGENT_AFTER_FAILED_RUN: "nope" }), {});
});

test("settings：两个旋钮可以并存", () => {
	assert.deepEqual(
		knobsOnly({
			AGENT_STREAM_TIMEOUT_MS: "600000",
			AGENT_AFTER_FAILED_RUN: "continue",
		}),
		{ stream: { timeoutMs: 600000 }, afterFailedRun: "continue" },
	);
});

test("bash 默认超时：900 起步，0/非法值 = 不做默认超时", () => {
	assert.equal(bashTimeoutSeconds({}), 900);
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "" }), 900);
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "30" }), 30);
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "1.9" }), 1);
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "0" }), 0);
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "-5" }), 0);
	assert.equal(bashTimeoutSeconds({ AGENT_BASH_TIMEOUT_S: "abc" }), 0);
});
