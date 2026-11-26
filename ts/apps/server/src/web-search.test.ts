import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * `web_search` 结果瘦身（2026-11-25 上下文瘦身）。
 *
 * 实测单次搜索 39,349 字符里有一半是 `message` 把 `hits` 又抄了一遍；这里验
 * ① 正常命中不再带 `message`；② 0 命中仍给引导文案；③ 超长结果按序列化字符数
 * 从尾部裁剪，`count` 与 `hits.length` 始终一致。
 */

const root = mkdtempSync(join(tmpdir(), "lifediary-web-search-"));
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.MEMORY_ENABLED = "false";
process.env.COMPANIONS_ENABLED = "false";

const { createTools, shapeWebSearchHits, WEB_SEARCH_MAX_RESULT_CHARS } = await import("./tools.ts");
type SearchHit = import("./search.ts").SearchHit;
type SearchModule = import("./search.ts").SearchModule;

const BASE_DEPS = {
	memory: null,
	scopeOf: () => ({ type: "global" as const }),
} as const;

function fakeSearch(hits: SearchHit[]): SearchModule {
	return {
		searchConfigured: () => true,
		searchKeyEnv: () => "FAKE_SEARCH_KEY",
		webSearch: async () => ({ ok: true, hits }),
	};
}

function webSearchTool(search: SearchModule) {
	return createTools({ ...BASE_DEPS, search }).find((tool) => tool.name === "web_search");
}

async function run(tool: NonNullable<ReturnType<typeof webSearchTool>>) {
	const result = await tool.execute({ query: "test" } as never, { conversationId: 1 } as never, {} as never);
	const text = (result.output ?? [])
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("");
	return JSON.parse(text) as {
		ok: boolean;
		data?: {
			count?: number;
			hits?: SearchHit[];
			message?: string;
		};
	};
}

const HITS: SearchHit[] = [
	{ title: "甲", url: "https://example.com/a", summary: "第一条摘要" },
	{ title: "乙", url: "https://example.com/b", summary: "第二条摘要" },
];

test("web_search 正常命中：只回 count + hits，不再有重复的 message", async () => {
	const tool = webSearchTool(fakeSearch(HITS));
	assert.ok(tool, "注入 search 后应注册 web_search");
	const result = await run(tool);
	assert.equal(result.ok, true);
	assert.equal(result.data?.count, 2);
	assert.deepEqual(result.data?.hits, HITS);
	assert.equal("message" in (result.data ?? {}), false);
});

test("web_search 0 命中：仍回 message 引导，而不是空数组", async () => {
	const tool = webSearchTool(fakeSearch([]));
	assert.ok(tool);
	const result = await run(tool);
	assert.equal(result.ok, true);
	assert.equal(result.data?.count, 0);
	assert.equal(result.data?.message, "没有找到相关结果。");
	assert.equal(result.data?.hits, undefined);
});

test("web_search 超长结果：从尾部裁剪到 ≤ 32K，count 与 hits.length 一致", async () => {
	const long = Array.from({ length: 10 }, (_, index) => ({
		title: `标题 ${index}`,
		url: `https://example.com/${index}`,
		summary: "长".repeat(4000),
	}));
	assert.ok(JSON.stringify(long).length > WEB_SEARCH_MAX_RESULT_CHARS, "用例本身要超过上限");
	const tool = webSearchTool(fakeSearch(long));
	assert.ok(tool);
	const result = await run(tool);
	const hits = result.data?.hits ?? [];
	assert.ok(hits.length >= 1 && hits.length < long.length, `应裁掉尾部，实际 ${hits.length} 条`);
	assert.equal(result.data?.count, hits.length);
	assert.ok(
		JSON.stringify(hits).length <= WEB_SEARCH_MAX_RESULT_CHARS,
		`裁剪后 ${JSON.stringify(hits).length} 应 ≤ ${WEB_SEARCH_MAX_RESULT_CHARS}`,
	);
	// 排名在前的命中优先保留，每条结构不变
	assert.equal(hits[0]?.title, "标题 0");
	assert.equal(hits[0]?.summary.length, 4000);
});

test("shapeWebSearchHits：单条超长也至少保留 1 条，且不改原数组", () => {
	const one: SearchHit[] = [
		{ title: "唯一一条", url: "https://example.com/only", summary: "长".repeat(40000) },
	];
	const shaped = shapeWebSearchHits(one);
	assert.equal(shaped.length, 1);
	assert.equal(one.length, 1);
	assert.equal(shaped[0]?.url, "https://example.com/only");
});
