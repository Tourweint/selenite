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

const { providerCatalog, removeProvider, saveProvider, setRuntimeModel } = await import("./provider.ts");
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

after(() => {
	rmSync(dir, { recursive: true, force: true });
});
