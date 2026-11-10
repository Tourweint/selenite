import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUX_USES,
	auxPinnedModelId,
	auxiliaryEnabled,
	auxiliaryModel,
	type AuxUse,
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
	assert.equal(auxPinnedModelId("vision", { AUX_MODEL_VISION: "v" }), "v");
	assert.deepEqual([...AUX_USES], ["title", "compact", "vision", "review", "extract"]);
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

/**
 * 已接线的两处（2026-11-10 批 23b §三）：`extract`（偏好抽取）与 `review`（记忆整理建议）。
 * 配了 `AUX_MODEL_<USE>` 就返回该模型；没配回落当前会话模型。
 * `compact` 不在列：内核 `Conversation.compact()` 不收模型，没法接；`title` 当前没有自动标题。
 */
test("已接用途：pin 了用 pin 的模型，没配回落当前模型", () => {
	for (const use of ["extract", "review"] as const) {
		assert.deepEqual(
			auxiliaryModel(use, {
				current: CURRENT,
				env: { [`AUX_MODEL_${use.toUpperCase()}`]: "small-model" },
				models: fakeModels(),
			}),
			{ provider: "bailian", modelId: "small-model" },
			`${use} 应当用 pin 的模型`,
		);
		assert.deepEqual(
			auxiliaryModel(use, { current: CURRENT, env: {}, models: fakeModels() }),
			CURRENT,
			`${use} 没配时应回落当前模型`,
		);
	}
});

/**
 * compact（2026-11-10 批 26b §一）：内核 `Conversation.compact()` 不收模型参数，
 * 所以 `compact` 用途**接不进压缩调用**；但这一层的解析必须照常工作——配了返回 pin 的
 * 模型、没配回落当前模型，绝不静默失效（未生效的事实由 startChatCompaction 记日志）。
 */
test("compact 用途能解析：配了返回 pin 的模型，没配回落当前模型", () => {
	assert.deepEqual(
		auxiliaryModel("compact", {
			current: CURRENT,
			env: { AUX_MODEL_COMPACT: "small-model" },
			models: fakeModels(),
		}),
		{ provider: "bailian", modelId: "small-model" },
	);
	assert.deepEqual(
		auxiliaryModel("compact", { current: CURRENT, env: {}, models: fakeModels() }),
		CURRENT,
	);
});

/**
 * title / vision 显式"无调用点"（2026-11-10 批 28 §三）：配了照常返回配置值，
 * 但调用时打一条 warn 提示"当前无调用方、配置不会生效"；只一次，warn 可注入以便断言。
 */
test("title / vision 无调用点：配了返回配置值但打 warn（只一次、可注入）", () => {
	for (const use of ["title", "vision"] as const) {
		const warns: string[] = [];
		const warned = new Set<AuxUse>();
		const deps = {
			current: CURRENT,
			env: { [`AUX_MODEL_${use.toUpperCase()}`]: "small-model" },
			models: fakeModels(),
			warn: (message: string) => warns.push(message),
			warned,
		};
		assert.deepEqual(
			auxiliaryModel(use, deps),
			{ provider: "bailian", modelId: "small-model" },
			`${use} 配了要返回配置值，不因"无调用点"改变解析契约`,
		);
		assert.equal(warns.length, 1, `${use} 调用要打一条 warn`);
		assert.match(warns[0]!, /无调用方.*配置不会生效/);
		assert.match(warns[0]!, new RegExp(use), "warn 要带用途名，便于定位");

		// 同一用途再调一次：进程内只告警一次
		auxiliaryModel(use, deps);
		assert.equal(warns.length, 1, `${use} 只告警一次`);
	}
});

test("已接用途 extract / review 不触发无调用点 warn", () => {
	const warns: string[] = [];
	const deps = {
		current: CURRENT,
		env: {},
		models: fakeModels(),
		warn: (message: string) => warns.push(message),
		warned: new Set<AuxUse>(),
	};
	auxiliaryModel("extract", deps);
	auxiliaryModel("review", deps);
	assert.equal(warns.length, 0, "已接线用途不该被误标成无调用点");
});
