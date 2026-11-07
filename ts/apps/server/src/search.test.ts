import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, test } from "node:test";
import { searchConfigured, searchKeyEnv, webSearch } from "./search.ts";

/**
 * 搜索适配层单测（2026-11-07 长期课题跟进 §十）：
 * 假上游只在本进程的随机端口上，不碰真实网络；断言不打印 key。
 */

const KEY = "probe-search-key";

after(() => {
	delete process.env.SEARCH_BASE_URL;
	delete process.env.DEEPSEEK_SEARCH_API_KEY;
});

type Stub = {
	url: string;
	close: () => Promise<void>;
	requests: Array<{ path: string; auth: string; body: string }>;
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

test("search：未配置 key 返回引导错误，不返回假结果", async () => {
	delete process.env.DEEPSEEK_SEARCH_API_KEY;
	assert.equal(searchConfigured(), false);
	const result = await webSearch("经济学");
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error, "search_not_configured");
	assert.match(result.message, /DEEPSEEK_SEARCH_API_KEY/);
	assert.equal(searchKeyEnv(), "DEEPSEEK_SEARCH_API_KEY");
});

test("search：假上游返回映射 + count 收敛 + 只发变量名对应的 key", async () => {
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
		delete process.env.SEARCH_BASE_URL;
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
		delete process.env.SEARCH_BASE_URL;
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
		delete process.env.SEARCH_BASE_URL;
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
		delete process.env.SEARCH_BASE_URL;
	}
});
