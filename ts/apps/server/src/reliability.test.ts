import assert from "node:assert/strict";
import { test } from "node:test";
import { bashTimeoutSeconds, buildHarnessSettings } from "./reliability.ts";

test("settings：env 全空时不传（构造上不改变行为）", () => {
	assert.equal(buildHarnessSettings({}), undefined);
	assert.equal(buildHarnessSettings({ AGENT_STREAM_TIMEOUT_MS: "", AGENT_AFTER_FAILED_RUN: "" }), undefined);
});

test("settings：AGENT_STREAM_TIMEOUT_MS 只认正整数", () => {
	assert.deepEqual(buildHarnessSettings({ AGENT_STREAM_TIMEOUT_MS: "123456" }), {
		stream: { timeoutMs: 123456 },
	});
	assert.equal(buildHarnessSettings({ AGENT_STREAM_TIMEOUT_MS: "0" }), undefined);
	assert.equal(buildHarnessSettings({ AGENT_STREAM_TIMEOUT_MS: "-1" }), undefined);
	assert.equal(buildHarnessSettings({ AGENT_STREAM_TIMEOUT_MS: "abc" }), undefined);
	assert.equal(buildHarnessSettings({ AGENT_STREAM_TIMEOUT_MS: "1.5" }), undefined);
});

test("settings：AGENT_AFTER_FAILED_RUN 只认三个枚举值", () => {
	for (const value of ["keep", "continue", "withdraw"] as const) {
		assert.deepEqual(buildHarnessSettings({ AGENT_AFTER_FAILED_RUN: value }), {
			afterFailedRun: value,
		});
	}
	assert.equal(buildHarnessSettings({ AGENT_AFTER_FAILED_RUN: "nope" }), undefined);
});

test("settings：两个旋钮可以并存", () => {
	assert.deepEqual(
		buildHarnessSettings({
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
