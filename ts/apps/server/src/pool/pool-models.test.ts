import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
	POOL_DEFAULT_MODEL,
	POOL_PROVIDER_ID,
	configurePoolModel,
	createPoolModels,
	poolLlmConfig,
} from "./pool-models.ts";

/**
 * 池内模型装配（P2 骨架）。要点：
 * - 真实分支每票 `configurePoolModel` 覆盖 provider，窗口 131072 / maxTokens 4096；
 * - faux 分支的 provider 名以 `fauxProvider(...).provider.id` 为准，不硬编码；
 * - 真实分支缺 key 必须抛错，不能静默空转。
 */

/** 取 fauxProvider 的真实 provider id（不猜字符串）。 */
function realFauxProviderId(): string {
	return fauxProvider({ models: [{ id: "faux" }] }).provider.id;
}

test("poolLlmConfig({})：默认 baseUrl / 默认模型 / apiKey 空", () => {
	const cfg = poolLlmConfig({});
	assert.equal(cfg.faux, false);
	assert.equal(cfg.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
	assert.equal(cfg.defaultModel, POOL_DEFAULT_MODEL);
	assert.equal(cfg.apiKey, "");
});

test("LLM_PROVIDER=faux 时 faux === true", () => {
	assert.equal(poolLlmConfig({ LLM_PROVIDER: "faux" }).faux, true);
	assert.equal(poolLlmConfig({ LLM_PROVIDER: " FAUX " }).faux, true, "大小写 / 空白无关");
	assert.equal(poolLlmConfig({ CHANCELLOR_LLM_PROVIDER: "faux" }).faux, true, "宰相变量兜底");
	assert.equal(poolLlmConfig({ LLM_PROVIDER: "openai" }).faux, false);
});

test("createPoolModels(faux)：默认模型 id 是 faux，且 models 里有该 provider/模型", () => {
	const { models, defaultModelId } = createPoolModels({ LLM_PROVIDER: "faux" });
	assert.equal(defaultModelId, "faux");
	// 从真实 fauxProvider 推导 id，不硬编码
	assert.ok(models.getModel(realFauxProviderId(), "faux"), "models 里应登记 faux provider 的 faux 模型");
});

test("configurePoolModel(faux)：返回的 provider 与 createPoolModels 实际登记的 provider id 一致", () => {
	const { models } = createPoolModels({ LLM_PROVIDER: "faux" });
	const ref = configurePoolModel(models, undefined, { LLM_PROVIDER: "faux" });
	assert.equal(ref.provider, realFauxProviderId());
	assert.equal(ref.modelId, "faux");
	assert.notEqual(ref.provider, POOL_PROVIDER_ID, "faux 分支不该落到真实 provider");
});

test("configurePoolModel(真实)：返回 pool provider，模型窗口 131072 / maxTokens 4096", () => {
	const env = { LLM_API_KEY: "k", LLM_PROVIDER: "" };
	const { models } = createPoolModels(env);
	const ref = configurePoolModel(models, "m1", env);
	assert.deepEqual(ref, { provider: POOL_PROVIDER_ID, modelId: "m1" });

	const model = models.getModel(POOL_PROVIDER_ID, "m1");
	assert.ok(model, "setProvider 之后应能取到 m1");
	assert.equal(model!.contextWindow, 131_072);
	assert.equal(model!.maxTokens, 4096);
	assert.equal(model!.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("configurePoolModel(真实无 key)：抛错，不静默空转", () => {
	const env = { LLM_PROVIDER: "" };
	const { models } = createPoolModels(env);
	assert.throws(
		() => configurePoolModel(models, "m1", env),
		/LLM_API_KEY 未配置/,
	);
});