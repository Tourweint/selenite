import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { mountSearch } from "./search-api.ts";
import { SEARCH_VENDORS } from "./search.ts";

/**
 * 搜索源 HTTP 接口单测（2026-11-12 多供应商）：
 * 只测形状与落点纪律——不真打上游；适配层回包映射在 search.test.ts。
 */

const CONFIG_PATH = join(tmpdir(), `lifediary-search-api-test-${randomUUID()}.json`);
const KEYS_PATH = join(tmpdir(), `lifediary-search-keys-test-${randomUUID()}.json`);

process.env.SEARCH_CONFIG_PATH = CONFIG_PATH;
process.env.PROVIDER_KEYS_PATH = KEYS_PATH;

function app() {
	const server = new Hono();
	mountSearch(server);
	return server;
}

function clearState() {
	for (const vendor of SEARCH_VENDORS) delete process.env[vendor.keyEnv];
	delete process.env.SEARXNG_URL;
	delete process.env.PROVIDER_SECRETS;
	delete process.env.SEARCH_MULTI_VENDOR;
	rmSync(CONFIG_PATH, { force: true });
	rmSync(KEYS_PATH, { force: true });
}

beforeEach(clearState);

after(() => {
	clearState();
	delete process.env.SEARCH_CONFIG_PATH;
	delete process.env.PROVIDER_KEYS_PATH;
});

async function json(response: Response) {
	return (await response.json()) as Record<string, unknown>;
}

test("search-provider：GET 空态带目录与旧字段", async () => {
	const response = await app().request("/api/v1/agent/search-provider");
	assert.equal(response.status, 200);
	const data = await json(response);
	assert.equal(data.configured, false);
	assert.equal(data.hasKey, false);
	assert.equal(data.keyEnv, "DEEPSEEK_SEARCH_API_KEY");
	assert.deepEqual(data.sources, []);
	const vendors = data.vendors as Array<{ id: string; keyEnv: string; configured: boolean }>;
	for (const id of ["deepseek", "tavily", "exa", "baidu", "yuanbao"]) {
		assert.ok(vendors.some((vendor) => vendor.id === id), `目录缺少 ${id}`);
	}
	assert.ok(vendors.every((vendor) => !vendor.configured));
});

test("search-provider：PUT 写 key + source，GET 立刻可见，DELETE 清掉", async () => {
	const server = app();
	const put = await server.request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "tavily", apiKey: "tavily-test-key" }),
	});
	assert.equal(put.status, 200);
	const saved = await json(put);
	assert.equal(saved.configured, true);
	const sources = saved.sources as Array<{ vendor: string; keyEnv: string; hasKey: boolean; usable: boolean }>;
	assert.equal(sources.length, 1);
	assert.equal(sources[0]?.vendor, "tavily");
	assert.equal(sources[0]?.keyEnv, "TAVILY_API_KEY");
	assert.equal(sources[0]?.hasKey, true);
	assert.equal(sources[0]?.usable, true);
	assert.equal(process.env.TAVILY_API_KEY, "tavily-test-key");
	const keysFile = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as Record<string, string>;
	assert.equal(keysFile.TAVILY_API_KEY, "tavily-test-key");

	const get = await json(await server.request("/api/v1/agent/search-provider"));
	assert.equal(get.configured, true);
	assert.equal((get.vendors as Array<{ id: string; configured: boolean }>).find((v) => v.id === "tavily")?.configured, true);

	const del = await server.request("/api/v1/agent/search-provider?vendor=tavily", { method: "DELETE" });
	assert.equal(del.status, 200);
	const removed = await json(del);
	assert.deepEqual(removed.sources, []);
	assert.equal(removed.configured, false);
	assert.equal(process.env.TAVILY_API_KEY, undefined);
});

test("search-provider：PUT 缺 key → missing_key；未知 vendor → unknown_vendor", async () => {
	const server = app();
	const missing = await server.request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "exa" }),
	});
	assert.equal(missing.status, 400);
	assert.equal((await json(missing)).error, "missing_key");

	const unknown = await server.request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "nope", apiKey: "x" }),
	});
	assert.equal(unknown.status, 400);
	assert.equal((await json(unknown)).error, "unknown_vendor");
});

test("search-provider：PROVIDER_SECRETS=false 时界面直填被拒", async () => {
	process.env.PROVIDER_SECRETS = "false";
	const response = await app().request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "tavily", apiKey: "x" }),
	});
	assert.equal(response.status, 400);
	assert.equal((await json(response)).error, "secrets_disabled");
});

test("search-provider：顺序接口按传入顺序重排", async () => {
	const server = app();
	await server.request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "tavily", apiKey: "t" }),
	});
	await server.request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "deepseek", apiKey: "d" }),
	});
	const response = await server.request("/api/v1/agent/search-provider/order", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendors: ["deepseek", "tavily"] }),
	});
	assert.equal(response.status, 200);
	const data = await json(response);
	assert.deepEqual(
		(data.sources as Array<{ vendor: string }>).map((source) => source.vendor),
		["deepseek", "tavily"],
	);
});

test("search-provider：首次 PUT 保留 env 反推的其他源", async () => {
	process.env.TAVILY_API_KEY = "tavily-env-key";
	const response = await app().request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "deepseek", apiKey: "deepseek-key" }),
	});
	assert.equal(response.status, 200);
	const data = await json(response);
	assert.deepEqual(
		(data.sources as Array<{ vendor: string }>).map((source) => source.vendor).sort(),
		["deepseek", "tavily"],
	);
});

test("search-provider：SEARCH_MULTI_VENDOR=false 只留 DeepSeek", async () => {
	process.env.SEARCH_MULTI_VENDOR = "false";
	process.env.TAVILY_API_KEY = "t";
	const server = app();
	const get = await json(await server.request("/api/v1/agent/search-provider"));
	assert.deepEqual(get.sources, [], "多源清单不读");
	assert.deepEqual(
		(get.vendors as Array<{ id: string }>).map((vendor) => vendor.id),
		["deepseek"],
	);
	const put = await server.request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "tavily", apiKey: "t" }),
	});
	assert.equal(put.status, 400);
	assert.equal((await json(put)).error, "multi_vendor_disabled");
});

test("search-provider：SearXNG 需要地址；测试未配置返回引导错误", async () => {
	const server = app();
	const missing = await server.request("/api/v1/agent/search-provider", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vendor: "searxng" }),
	});
	assert.equal(missing.status, 400);
	assert.equal((await json(missing)).error, "missing_url");

	const testResponse = await server.request("/api/v1/agent/search-provider/test", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	});
	assert.equal(testResponse.status, 200);
	const data = await json(testResponse);
	assert.equal(data.ok, false);
	assert.equal(data.error, "search_not_configured");
});
