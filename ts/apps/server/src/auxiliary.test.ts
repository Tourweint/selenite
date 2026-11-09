import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUX_USES,
	auxPinnedModelId,
	auxiliaryEnabled,
	auxiliaryModel,
} from "./auxiliary.ts";

/**
 * 杂活模型解析（2026-11-10 批 20 §二）。
 *
 * 这里钉的是"配了怎么解析、没配怎么回落、配错了怎么办"——不测真模型调用
 * （那在 `memory-extract.ts` 的装配层，且需要真上游）。
 */

const CURRENT = { provider: "bailian", modelId: "big-model" };

/** 两个供应商：同名模型只出现在第二个供应商里（验证跨供应商解析） */
function fakeModels(): {
	getModel(provider: string, id: string): unknown;
	getProviders(): readonly { id: string }[];
} {
	const catalog: Record<string, string[]> = {
		bailian: ["big-model", "small-model"],
		other: ["tiny-model"],
	};
	return {
		getModel(provider, id) {
			return catalog[provider]?.includes(id) ? { id } : undefined;
		},
		getProviders() {
			return Object.keys(catalog).map((id) => ({ id }));
		},
	};
}

test("总开关：默认开，只有显式 false 才关", () => {
	assert.equal(auxiliaryEnabled({}), true);
	assert.equal(auxiliaryEnabled({ AUX_LLM: "" }), true);
	assert.equal(auxiliaryEnabled({ AUX_LLM: "true" }), true);
	assert.equal(auxiliaryEnabled({ AUX_LLM: "0" }), true, "默认开口径只认 false");
	assert.equal(auxiliaryEnabled({ AUX_LLM: "FALSE" }), false);
});

test("pin 变量名按用途大写；没配 / 空白 → null", () => {
	assert.equal(auxPinnedModelId("extract", {}), null);
	assert.equal(auxPinnedModelId("extract", { AUX_MODEL_EXTRACT: "  " }), null);
	assert.equal(
		auxPinnedModelId("extract", { AUX_MODEL_EXTRACT: " small-model " }),
		"small-model",
	);
	assert.equal(auxPinnedModelId("title", { AUX_MODEL_TITLE: "t" }), "t");
	assert.deepEqual([...AUX_USES], ["title", "compact", "review", "extract"]);
});

test("没有当前模型 → null（不编一个路由）", () => {
	assert.equal(auxiliaryModel("extract", { current: null, env: {} }), null);
});

test("没 pin / 关掉总开关 → 当前会话模型（行为不变）", () => {
	assert.deepEqual(
		auxiliaryModel("extract", { current: CURRENT, env: {}, models: fakeModels() }),
		CURRENT,
	);
	assert.deepEqual(
		auxiliaryModel("extract", {
			current: CURRENT,
			env: { AUX_LLM: "false", AUX_MODEL_EXTRACT: "small-model" },
			models: fakeModels(),
		}),
		CURRENT,
		"AUX_LLM=false 时 pin 也不生效",
	);
});

test("pin 命中当前供应商 → 同供应商换模型", () => {
	assert.deepEqual(
		auxiliaryModel("extract", {
			current: CURRENT,
			env: { AUX_MODEL_EXTRACT: "small-model" },
			models: fakeModels(),
		}),
		{ provider: "bailian", modelId: "small-model" },
	);
});

test("pin 只在别的供应商里有 → 用那个供应商", () => {
	assert.deepEqual(
		auxiliaryModel("title", {
			current: CURRENT,
			env: { AUX_MODEL_TITLE: "tiny-model" },
			models: fakeModels(),
		}),
		{ provider: "other", modelId: "tiny-model" },
	);
});

test("pin 不在目录里 → 回落当前模型（不静默换路由）", () => {
	assert.deepEqual(
		auxiliaryModel("extract", {
			current: CURRENT,
			env: { AUX_MODEL_EXTRACT: "no-such-model" },
			models: fakeModels(),
		}),
		CURRENT,
	);
});
