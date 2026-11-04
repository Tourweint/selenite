import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyUnanswered, nextChainCandidate, validateModelChain, type ModelChainItem } from "./model-chain.ts";

const chain: ModelChainItem[] = [
	{ providerId: "p-a", modelId: "m-1", keyEnv: "KEY_A" },
	{ providerId: "p-b", modelId: "m-2", keyEnv: "KEY_B" },
	{ providerId: "p-c", modelId: "m-3", keyEnv: "KEY_C" },
];

test("候选链：unanswered 原因归类 —— 可切与不可切", () => {
	for (const reason of [
		"fetch failed: ECONNREFUSED",
		"ETIMEDOUT after 30000ms",
		"HTTP 500 bad gateway",
		"429 too many requests",
		"quota exceeded",
		"401 unauthorized: invalid api key",
		"model m-9 not found",
	]) {
		assert.equal(classifyUnanswered(reason), "switchable", reason);
	}
	for (const reason of [
		"aborted by user",
		"request was cancelled",
		"context length exceeded",
		"invalid parameter: temperature",
		"bad request body",
		"",
	]) {
		assert.equal(classifyUnanswered(reason), "final", reason);
	}
});

test("候选链：当前在链内取下一项，到链尾放弃", () => {
	const v1 = nextChainCandidate(chain, { provider: "p-a", modelId: "m-1#think-off" }, "ECONNREFUSED");
	assert.equal(v1.action, "retry");
	assert.equal(v1.target?.providerId, "p-b", "档位后缀要剥掉再比对");

	const v2 = nextChainCandidate(chain, { provider: "p-c", modelId: "m-3" }, "ECONNREFUSED");
	assert.equal(v2.action, "give-up");
	assert.match(v2.reason, /链已到尾/);
});

test("候选链：当前不在链内 → 从链头开始；原因不可切 → 不切", () => {
	const v1 = nextChainCandidate(chain, { provider: "p-x", modelId: "m-9" }, "ECONNREFUSED");
	assert.equal(v1.action, "retry");
	assert.equal(v1.target?.providerId, "p-a");

	const v2 = nextChainCandidate(chain, null, "aborted by user");
	assert.equal(v2.action, "give-up");
	assert.match(v2.reason, /不可切/);

	const v3 = nextChainCandidate([], { provider: "p-a", modelId: "m-1" }, "ECONNREFUSED");
	assert.equal(v3.action, "give-up");
});

test("候选链：结构校验 —— 只许引用（keyEnv 名），不许带值字段", () => {
	assert.equal(validateModelChain(chain), null);
	assert.match(validateModelChain("no") ?? "", /数组/);
	assert.match(validateModelChain([...chain, ...chain]) ?? "", /最多 5 项/);
	assert.match(
		validateModelChain([{ providerId: "p", modelId: "m", keyEnv: "" }]) ?? "",
		/keyEnv/,
	);
	assert.match(
		validateModelChain([{ providerId: "p", modelId: "m", keyEnv: "KEY", apiKey: "sk-xxx" }]) ?? "",
		/密钥纪律|apiKey/,
	);
	assert.match(
		validateModelChain([{ providerId: "p", modelId: "m", keyEnv: "KEY", thinkingLevel: "ultra" }]) ?? "",
		/thinkingLevel/,
	);
});
