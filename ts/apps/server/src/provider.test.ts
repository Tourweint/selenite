import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test, { after } from "node:test";

/**
 * 供应商配置的不变量（2026-11-04 批次五）。
 *
 * 这里只测不依赖网络的纯配置逻辑；"换地址 / 换 keyEnv 真的打到下一轮"由
 * `scripts/providers-probe.ts` 用假上游验。
 */

const dir = mkdtempSync(join(tmpdir(), "lifediary-providers-"));
process.env.LLM_PROVIDER = "faux";
process.env.PROVIDERS_CONFIG = "true";
process.env.MODEL_RUNTIME_OVERRIDE = "true";
process.env.PROVIDERS_PATH = join(dir, "providers.json");
process.env.MODEL_RUNTIME_PATH = join(dir, "runtime.json");

const { modelCatalog, providerCatalog, removeProvider, saveProvider, setRuntimeModel, setRuntimeThinking } = await import(
	"./provider.ts"
);
const providersPath = process.env.PROVIDERS_PATH;

test("新增供应商只写 keyEnv 变量名", async () => {
	const result = await saveProvider({
		id: "alpha",
		name: "Alpha",
		baseUrl: "http://127.0.0.1:9/v1",
		keyEnv: "ALPHA_KEY",
		models: ["m1", "m2"],
	});
	assert.equal(result.ok, true);
	const raw = readFileSync(providersPath, "utf8");
	assert.ok(raw.includes('"keyEnv": "ALPHA_KEY"'));
	assert.ok(!raw.includes("apiKey"));
	assert.ok(!raw.includes("headers"));
	const catalog = providerCatalog();
	assert.equal(catalog.providers.length, 1);
	assert.equal(catalog.providers[0]?.isDefault, true);
	assert.equal(catalog.providers[0]?.hasKey, false);
});

test("逐模型元数据落盘、回读；非法值丢弃", async () => {
	const result = await saveProvider({
		id: "alpha",
		previousId: "alpha",
		name: "Alpha",
		baseUrl: "http://127.0.0.1:9/v1",
		keyEnv: "ALPHA_KEY",
		models: ["m1", "m2"],
		modelMeta: { m1: { contextWindow: 200000, maxTokens: 8192 }, m2: { contextWindow: -5 } },
		modelThinkingLevels: { m1: ["off", "high"] },
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.provider.modelMeta, { m1: { contextWindow: 200000, maxTokens: 8192 } });
	assert.deepEqual(result.provider.modelThinkingLevels.m1, ["off", "high"]);
	const catalog = modelCatalog();
	const row = catalog.providers[0]?.models.find((model) => model.id === "m1");
	assert.equal(row?.contextWindow, 200000);
	assert.equal(row?.maxTokens, 8192);
	const raw = readFileSync(providersPath, "utf8");
	assert.ok(raw.includes('"modelMeta"'));
	const parsed = JSON.parse(raw) as {
		providers: { id: string; modelMeta?: Record<string, unknown> }[];
	};
	assert.equal(parsed.providers.find((item) => item.id === "alpha")?.modelMeta?.m2, undefined);
});

test("空清单要显式开关；不带开关仍按老语义拒绝", async () => {
	const rejected = await saveProvider({
		id: "empty",
		name: "Empty",
		baseUrl: "http://127.0.0.1:9/v1",
		keyEnv: "EMPTY_KEY",
		models: [],
	});
	assert.equal(rejected.ok, false);
	if (!rejected.ok) assert.equal(rejected.error, "bad_models");
	const allowed = await saveProvider({
		id: "empty",
		name: "Empty",
		baseUrl: "http://127.0.0.1:9/v1",
		keyEnv: "EMPTY_KEY",
		models: [],
		allowEmptyModels: true,
	});
	assert.equal(allowed.ok, true);
	assert.equal(removeProvider("empty").ok, true);
});

test("编辑把默认模型移出清单 → 400，必须先切走", async () => {
	const result = await saveProvider({
		id: "alpha",
		previousId: "alpha",
		name: "Alpha",
		baseUrl: "http://127.0.0.1:9/v1",
		keyEnv: "ALPHA_KEY",
		models: ["m2"],
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "selected_model_missing");
});

test("默认供应商不能删；非默认的可以", async () => {
	await saveProvider({
		id: "beta",
		name: "Beta",
		baseUrl: "http://127.0.0.1:9/v1",
		keyEnv: "BETA_KEY",
		models: ["b1"],
	});
	const denied = removeProvider("alpha");
	assert.equal(denied.ok, false);
	if (!denied.ok) assert.equal(denied.error, "provider_is_default");
	const removed = removeProvider("beta");
	assert.equal(removed.ok, true);
	assert.equal(providerCatalog().providers.length, 1);
});

test("faux 下切模型返回 faux", () => {
	const result = setRuntimeModel({ providerId: "alpha", modelId: "m1" });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "faux");
});

test("faux 下设全局默认思考档同样返回 faux（与切模型同一道门，2026-11-21）", () => {
	const result = setRuntimeThinking("high");
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "faux");
});

test("运行期坏文件保留上一份可用配置", () => {
	writeFileSync(
		providersPath,
		JSON.stringify({
			schemaVersion: 1,
			providers: [
				{
					id: "leak",
					name: "Leak",
					baseUrl: "http://127.0.0.1:9/v1",
					keyEnv: "LEAK_KEY",
					apiKey: "should-not-live-here",
					models: ["m"],
					createdAt: "2026-11-04T00:00:00.000Z",
				},
			],
			defaultSelection: { providerId: "leak", modelId: "m" },
		}),
	);
	const catalog = providerCatalog();
	assert.equal(catalog.providers.length, 1);
	assert.equal(catalog.providers[0]?.id, "alpha");
});

/**
 * 扫尾批 2 / A2 回归（2026-11-07）：重启后旧会话绑定的派生变体 id 必须可解析。
 *
 * 用「带 query 的全新模块实例」模拟重启：variantSpecs / singleton / document 全空，
 * 只有 providers.json 持久化——正是旧会话报 `...#think-off is not available` 的状态。
 * 修复前这个用例红：目录里从未被 `chatModelRef` 碰过的模型，其变体没人注册。
 */
test("重启（注册表重建）后目录内模型的派生变体可直接解析（2026-11-07 扫尾批 2 / A2）", async () => {
	const restartDir = mkdtempSync(join(tmpdir(), "lifediary-preseed-"));
	const restartProviders = join(restartDir, "providers.json");
	const restartRuntime = join(restartDir, "runtime.json");
	writeFileSync(
		restartProviders,
		`${JSON.stringify({
			schemaVersion: 1,
			providers: [
				{
					id: "alpha",
					name: "Alpha",
					baseUrl: "http://127.0.0.1:9/v1",
					keyEnv: "ALPHA_KEY",
					models: ["mA", "mB"],
					// mB 显式声明支持 low / high；缺省域也刻意不含 medium
					modelThinkingLevels: { mB: ["off", "low", "high"] },
					createdAt: "2026-11-07T00:00:00.000Z",
				},
			],
			defaultSelection: { providerId: "alpha", modelId: "mA" },
		})}\n`,
	);

	const envKeys = [
		"LLM_PROVIDER",
		"LLM_API_KEY",
		"PROVIDERS_CONFIG",
		"PROVIDERS_PATH",
		"MODEL_RUNTIME_PATH",
		"MODEL_VARIANT_PRESEEDED",
	] as const;
	const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	try {
		process.env.LLM_PROVIDER = "";
		process.env.LLM_API_KEY = "test-key";
		process.env.PROVIDERS_CONFIG = "true";
		process.env.PROVIDERS_PATH = restartProviders;
		process.env.MODEL_RUNTIME_PATH = restartRuntime;
		delete process.env.MODEL_VARIANT_PRESEEDED; // 默认启用预注册
		const fresh = await import(`./provider.ts?preseed=${Date.now()}`);
		const models = fresh.currentModels(); // 首次访问触发注册表重建
		// mB 从未被 chatModelRef 调用过：修复前 getModel 返回 undefined（not available）
		assert.ok(
			models.getModel("alpha", "mB#think-off"),
			"mB#think-off 应可解析（not available 语义：重启后旧会话模型绑定）",
		);
		assert.ok(models.getModel("alpha", "mB#think-low"), "mB 声明支持 low，#think-low 应可解析");
		assert.ok(models.getModel("alpha", "mA#think-off"), "mA（默认模型）#think-off 应可解析");
		// 支持域外不注册：mB 没声明 medium，缺省域也刻意不含 medium
		assert.equal(models.getModel("alpha", "mB#think-medium"), undefined, "未声明的 medium 不预注册");
		// 复用既有派生逻辑：上游必须收到真实模型名，派生 id 不漏到 body.model
		const derived = models.getModel("alpha", "mB#think-off") as
			| { samplingParams?: Record<string, unknown> }
			| undefined;
		assert.equal(derived?.samplingParams?.model, "mB", "派生变体把 model 盖回真实模型名");

		// 2026-11-19 会话级模型切换：指定模型的变体派生 / 可用性判定。
		assert.deepEqual(
			fresh.chatModelRefFor("alpha", "mB", "low"),
			{ provider: "alpha", modelId: "mB#think-low" },
		);
		assert.equal(fresh.modelAvailable("alpha", "mB#think-off"), true);
		assert.equal(fresh.modelAvailable("alpha", "mB"), true);
		assert.equal(fresh.modelAvailable("alpha", "nope"), false);
		assert.equal(fresh.modelAvailable("missing", "mB"), false);

		// 回滚开关：false 时跳过预注册，回到懒注册旧行为（方案 §六 / 接口文档 §6）
		process.env.MODEL_VARIANT_PRESEEDED = "false";
		const rolledBack = await import(`./provider.ts?preseed-off=${Date.now()}`);
		assert.equal(
			rolledBack.currentModels().getModel("alpha", "mB#think-off"),
			undefined,
			"MODEL_VARIANT_PRESEEDED=false 回到旧行为（变体不再预注册）",
		);
	} finally {
		for (const key of envKeys) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(restartDir, { recursive: true, force: true });
	}
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});
