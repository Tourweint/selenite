import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { SEARCH_VENDORS, searchConfigured, searchKeyEnv, testSearchVendor, webSearch } from "./search.ts";

/**
 * 搜索适配层单测（2026-11-07 长期课题跟进 §十；2026-11-12 多供应商）：
 * 假上游只在本进程的随机端口上，不碰真实网络；断言不打印 key。
 */

const KEY = "probe-search-key";
const CONFIG_PATH = join(tmpdir(), `lifediary-search-test-${randomUUID()}.json`);

process.env.SEARCH_CONFIG_PATH = CONFIG_PATH;

function clearSearchEnv() {
	for (const vendor of SEARCH_VENDORS) delete process.env[vendor.keyEnv];
	delete process.env.SEARXNG_URL;
	delete process.env.SEARCH_BASE_URL;
	delete process.env.SEARCH_MULTI_VENDOR;
	rmSync(CONFIG_PATH, { force: true });
}

function writeConfig(sources: Array<{ vendor: string; baseUrl?: string }>) {
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ schemaVersion: 1, sources })}\n`);
}

beforeEach(clearSearchEnv);

after(() => {
	clearSearchEnv();
	delete process.env.SEARCH_CONFIG_PATH;
});

type Stub = {
	url: string;
	close: () => Promise<void>;
	requests: Array<{ path: string; auth: string; headers: IncomingMessage["headers"]; body: string }>;
};

async function startStub(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Stub> {
	const requests: Stub["requests"] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += String(chunk);
		});
		req.on("end", () => {
			requests.push({
				path: req.url ?? "",
				auth: String(req.headers.authorization ?? ""),
				headers: req.headers,
				body,
			});
			handler(req, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test("search：未配置任何源返回引导错误，不返回假结果", async () => {
	assert.equal(searchConfigured(), false);
	const result = await webSearch("经济学");
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error, "search_not_configured");
	assert.match(result.message, /模型/);
	assert.equal(searchKeyEnv(), "DEEPSEEK_SEARCH_API_KEY");
});

test("search：旧 env（DEEPSEEK_SEARCH_API_KEY）继续可用 + count 收敛 + 只发 key", async () => {
	process.env.DEEPSEEK_SEARCH_API_KEY = KEY;
	const stub = await startStub((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				results: [
					{ title: "标题一", url: "https://example.com/a", summary: "摘要一" },
					{ title: "标题二", url: "https://example.com/b", summary: "摘要二" },
					{ title: "标题三", url: "https://example.com/c", summary: "摘要三" },
				],
			}),
		);
	});
	process.env.SEARCH_BASE_URL = stub.url;
	try {
		const result = await webSearch("  利率走向  ", 99);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.hits.length, 3);
		assert.equal(result.hits[0]?.title, "标题一");
		assert.equal(stub.requests.length, 1);
		assert.equal(stub.requests[0]?.path, "/v1/tools/search");
		assert.equal(stub.requests[0]?.auth, `Bearer ${KEY}`);
		const sent = JSON.parse(stub.requests[0]?.body ?? "{}") as {
			query?: string;
			count?: number;
			need_content?: boolean;
		};
		assert.equal(sent.query, "利率走向");
		assert.equal(sent.count, 10, "count 上限收敛到 10");
		assert.equal(sent.need_content, true);
	} finally {
		await stub.close();
	}
});

test("search：多源按顺序回退（第一个失败，第二个有结果）", async () => {
	process.env.TAVILY_API_KEY = "tavily-key";
	process.env.DEEPSEEK_SEARCH_API_KEY = "deepseek-key";
	const stub = await startStub((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if ((req.url ?? "").startsWith("/search")) {
			res.statusCode = 429;
			res.end("rate limited");
			return;
		}
		res.end(
			JSON.stringify({
				results: [{ title: "回退命中", url: "https://example.com/fallback", summary: "第二源" }],
			}),
		);
	});
	writeConfig([
		{ vendor: "tavily", baseUrl: stub.url },
		{ vendor: "deepseek", baseUrl: stub.url },
	]);
	try {
		assert.equal(searchKeyEnv(), "TAVILY_API_KEY", "首个配置源的变量名");
		const result = await webSearch("x", 1);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.hits[0]?.title, "回退命中");
		assert.equal(stub.requests.length, 2);
		assert.equal(stub.requests[0]?.path, "/search");
		assert.equal(stub.requests[0]?.auth, "Bearer tavily-key");
		assert.equal(stub.requests[1]?.path, "/v1/tools/search");
		assert.equal(stub.requests[1]?.auth, "Bearer deepseek-key");
	} finally {
		await stub.close();
	}
});

test("search：第一个源零命中也会试下一个", async () => {
	process.env.TAVILY_API_KEY = "tavily-key";
	process.env.DEEPSEEK_SEARCH_API_KEY = "deepseek-key";
	const stub = await startStub((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if ((req.url ?? "").startsWith("/search")) {
			res.end(JSON.stringify({ results: [] }));
			return;
		}
		res.end(
			JSON.stringify({
				results: [{ title: "后面的源", url: "https://example.com/second", summary: "有结果" }],
			}),
		);
	});
	writeConfig([
		{ vendor: "tavily", baseUrl: stub.url },
		{ vendor: "deepseek", baseUrl: stub.url },
	]);
	try {
		const result = await webSearch("x", 1);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.hits[0]?.title, "后面的源");
		assert.equal(stub.requests.length, 2);
	} finally {
		await stub.close();
	}
});

test("search：非 2xx → upstream_error，message 只写状态码", async () => {
	process.env.DEEPSEEK_SEARCH_API_KEY = KEY;
	const stub = await startStub((_req, res) => {
		res.statusCode = 401;
		res.end("upstream secret-ish body");
	});
	process.env.SEARCH_BASE_URL = stub.url;
	try {
		const result = await webSearch("x", 1);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.error, "upstream_error");
		assert.match(result.message, /401/);
		assert.ok(!result.message.includes("secret-ish"), "不带上游返回原文");
	} finally {
		await stub.close();
	}
});

test("search：没有 results 数组 → bad_response；空数组是合法零结果", async () => {
	process.env.DEEPSEEK_SEARCH_API_KEY = KEY;
	let mode: "bad" | "empty" = "bad";
	const stub = await startStub((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify(mode === "bad" ? { data: [] } : { results: [] }));
	});
	process.env.SEARCH_BASE_URL = stub.url;
	try {
		const bad = await webSearch("x", 1);
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.equal(bad.error, "bad_response");

		mode = "empty";
		const empty = await webSearch("x", 1);
		assert.equal(empty.ok, true);
		if (empty.ok) assert.equal(empty.hits.length, 0);
	} finally {
		await stub.close();
	}
});

test("search：空 query 直接拒绝，不发请求", async () => {
	process.env.DEEPSEEK_SEARCH_API_KEY = KEY;
	const stub = await startStub((_req, res) => res.end("{}"));
	process.env.SEARCH_BASE_URL = stub.url;
	try {
		const result = await webSearch("   ");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, "bad_response");
		assert.equal(stub.requests.length, 0);
	} finally {
		await stub.close();
	}
});

test("search：百度千帆回包（references）与 Bearer 认证", async () => {
	process.env.BAIDU_SEARCH_API_KEY = "baidu-key";
	const stub = await startStub((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				references: [
					{ title: "百度结果", url: "https://baidu.example/a", content: "百度摘要" },
				],
			}),
		);
	});
	writeConfig([{ vendor: "baidu", baseUrl: stub.url }]);
	try {
		const result = await webSearch("查一下", 3);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.hits[0]?.title, "百度结果");
		assert.equal(result.hits[0]?.summary, "百度摘要");
		assert.equal(stub.requests[0]?.path, "/v2/ai_search/web_search");
		assert.equal(stub.requests[0]?.auth, "Bearer baidu-key");
		const sent = JSON.parse(stub.requests[0]?.body ?? "{}") as {
			messages?: Array<{ content?: string }>;
			resource_type_filter?: Array<{ top_k?: number }>;
		};
		assert.equal(sent.messages?.[0]?.content, "查一下");
		assert.equal(sent.resource_type_filter?.[0]?.top_k, 3);
	} finally {
		await stub.close();
	}
});

test("search：Exa 用 x-api-key，读 results[].text", async () => {
	process.env.EXA_API_KEY = "exa-key";
	const stub = await startStub((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				results: [{ title: "Exa 结果", url: "https://exa.example/a", text: "语义摘要" }],
			}),
		);
	});
	writeConfig([{ vendor: "exa", baseUrl: stub.url }]);
	try {
		const result = await webSearch("查一下", 2);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.hits[0]?.summary, "语义摘要");
		assert.equal(stub.requests[0]?.headers["x-api-key"], "exa-key");
		assert.equal(stub.requests[0]?.path, "/search");
		const sent = JSON.parse(stub.requests[0]?.body ?? "{}") as { numResults?: number };
		assert.equal(sent.numResults, 2);
	} finally {
		await stub.close();
	}
});

test("search：元宝搜索读 Response.Pages 的 JSON 字符串，Cnt 取 10", async () => {
	process.env.YUANBAO_SEARCH_API_KEY = "yuanbao-key";
	const stub = await startStub((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				Response: {
					Pages: [
						JSON.stringify({
							Title: "元宝结果",
							URL: "https://yuanbao.example/a",
							Passage: "元宝摘要",
						}),
					],
				},
			}),
		);
	});
	writeConfig([{ vendor: "yuanbao", baseUrl: stub.url }]);
	try {
		const result = await webSearch("查一下", 1);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.hits[0]?.summary, "元宝摘要");
		assert.equal(stub.requests[0]?.path, "/SearchPro");
		const sent = JSON.parse(stub.requests[0]?.body ?? "{}") as { Query?: string; Cnt?: number };
		assert.equal(sent.Query, "查一下");
		assert.equal(sent.Cnt, 10);
	} finally {
		await stub.close();
	}
});

test("search：SearXNG 免 key，用配置的地址", async () => {
	const stub = await startStub((_req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				results: [{ title: "自建结果", url: "https://searx.example/a", content: "自建摘要" }],
			}),
		);
	});
	writeConfig([{ vendor: "searxng", baseUrl: stub.url }]);
	try {
		const result = await webSearch("查一下", 1);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.hits[0]?.title, "自建结果");
		assert.equal(stub.requests[0]?.path, "/search?q=%E6%9F%A5%E4%B8%80%E4%B8%8B&format=json");
		assert.equal(stub.requests[0]?.auth, "");
	} finally {
		await stub.close();
	}
});

test("testSearchVendor：只测指定源，不按整条回退链跑", async () => {
	process.env.TAVILY_API_KEY = "tavily-key";
	process.env.DEEPSEEK_SEARCH_API_KEY = "deepseek-key";
	const stub = await startStub((req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				results: [{ title: (req.url ?? "").startsWith("/search") ? "T" : "D", url: "https://e.example", summary: "" }],
			}),
		);
	});
	writeConfig([
		{ vendor: "tavily", baseUrl: stub.url },
		{ vendor: "deepseek", baseUrl: stub.url },
	]);
	try {
		const result = await testSearchVendor("deepseek");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.hits[0]?.title, "D");
		assert.equal(stub.requests.length, 1);
		assert.equal(stub.requests[0]?.path, "/v1/tools/search");
	} finally {
		await stub.close();
	}
});
