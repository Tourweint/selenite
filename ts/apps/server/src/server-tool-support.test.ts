import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAGPIE_GATEWAY_ORIGIN,
	OFFICIAL_DEEPSEEK_ORIGIN,
	SERVER_TOOL_PROVIDERS,
	SERVER_TOOL_REJECTIONS,
	originOf,
	serverToolSupport,
	serverToolsEnabled,
	swapWebSearchTool,
} from "./server-tool-support.ts";

/**
 * 服务端联网工具白名单单测（2026-11-19）：
 * 只测判定，不发真实请求。重点是「不误放行」——漏判的代价是静默不搜。
 */

const ON: NodeJS.ProcessEnv = { SERVER_WEB_SEARCH_TOOLS: "on" };
const OFF: NodeJS.ProcessEnv = {};

test("开关默认关闭：任何端点都不支持", () => {
	assert.equal(serverToolsEnabled(OFF), false);
	const r = serverToolSupport(OFFICIAL_DEEPSEEK_ORIGIN, "deepseek-flash", OFF);
	assert.equal(r.supported, false);
	assert.match(r.reason, /开关未开/);
});

test("官方端点 + deepseek-flash：支持", () => {
	const r = serverToolSupport(OFFICIAL_DEEPSEEK_ORIGIN, "deepseek-flash", ON);
	assert.equal(r.supported, true);
	assert.equal(r.providerId, "deepseek-official");
});

test("官方端点带路径 /v1：仍按 origin 命中", () => {
	const r = serverToolSupport(`${OFFICIAL_DEEPSEEK_ORIGIN}/v1`, "deepseek-flash", ON);
	assert.equal(r.supported, true);
});

test("官方端点 + 非白名单模型：不支持，但回填 providerId", () => {
	const r = serverToolSupport(OFFICIAL_DEEPSEEK_ORIGIN, "deepseek-v4-pro", ON);
	assert.equal(r.supported, false);
	assert.equal(r.providerId, "deepseek-official");
	assert.match(r.reason, /不在该条目名单/);
});

test("仿冒域名不算官方：api.deepseek.com.evil.cc", () => {
	const r = serverToolSupport("https://api.deepseek.com.evil.cc/v1", "deepseek-flash", ON);
	assert.equal(r.supported, false);
	assert.equal(r.providerId, null);
});

test("协议不符不算官方：http://api.deepseek.com", () => {
	const r = serverToolSupport("http://api.deepseek.com", "deepseek-flash", ON);
	assert.equal(r.supported, false);
});

test("host 大小写不敏感", () => {
	assert.equal(originOf("HTTPS://API.DEEPSEEK.COM/v1"), "https://api.deepseek.com");
	const r = serverToolSupport("HTTPS://API.DEEPSEEK.COM", "deepseek-flash", ON);
	assert.equal(r.supported, true);
});

test("magpie 本地网关 + deepseek/deepseek-flash：支持（已实测）", () => {
	assert.equal(MAGPIE_GATEWAY_ORIGIN, "http://127.0.0.1:3425");
	const r = serverToolSupport(`${MAGPIE_GATEWAY_ORIGIN}/v1`, "deepseek/deepseek-flash", ON);
	assert.equal(r.supported, true);
	assert.equal(r.providerId, "magpie-local");
});

test("magpie 端点上的其他 DeepSeek 路由不放行（未实测）", () => {
	const r = serverToolSupport(`${MAGPIE_GATEWAY_ORIGIN}/v1`, "workbuddy/deepseek-v4.1-flash", ON);
	assert.equal(r.supported, false);
	assert.equal(r.providerId, "magpie-local");
});

test("同主机不同端口不算 magpie", () => {
	const r = serverToolSupport("http://127.0.0.1:3426/v1", "deepseek/deepseek-flash", ON);
	assert.equal(r.supported, false);
	assert.match(r.reason, /不在白名单/);
});

test("百炼端点是 400 实测过的反例，必须拒绝", () => {
	const r = serverToolSupport("https://dashscope.aliyuncs.com/compatible-mode/v1", "deepseek-v4.1-flash", ON);
	assert.equal(r.supported, false);
	assert.equal(r.providerId, null);
});

test("非法地址不炸、判不支持", () => {
	for (const bad of ["", "   ", "not-a-url", "ftp://api.deepseek.com"]) {
		assert.equal(originOf(bad), null);
		assert.equal(serverToolSupport(bad, "deepseek-flash", ON).supported, false);
	}
});

test("白名单条目字段自检：origin 都是可解析的 http/https、模型名非空", () => {
	assert.ok(SERVER_TOOL_PROVIDERS.length >= 2);
	for (const provider of SERVER_TOOL_PROVIDERS) {
		assert.equal(originOf(provider.origin), provider.origin.toLowerCase(), `${provider.id} 的 origin 不规范`);
		assert.ok(provider.models.length > 0, `${provider.id} 没有模型名单`);
		assert.equal(typeof provider.verified, "boolean");
	}
});

test("反例表里的路由一律不放行（2026-11-19 实测）", () => {
	assert.ok(SERVER_TOOL_REJECTIONS.length === 6, "本轮实测应为 6 条反例");
	for (const rejected of SERVER_TOOL_REJECTIONS) {
		const r = serverToolSupport(rejected.origin, rejected.model, ON);
		assert.equal(r.supported, false, `${rejected.model} 不应被放行`);
		assert.match(r.reason, /不在该条目名单|不在白名单/, `${rejected.model} 拒绝理由要可排错`);
	}
});

test("白名单与反例表不重叠：同一个端点 + 模型不能两边都有", () => {
	for (const rejected of SERVER_TOOL_REJECTIONS) {
		const conflict = SERVER_TOOL_PROVIDERS.find(
			(provider) => provider.origin.toLowerCase() === rejected.origin.toLowerCase() && provider.models.includes(rejected.model),
		);
		assert.equal(conflict, undefined, `${rejected.model} 同时出现在白名单与反例表`);
	}
});

// ── 工具替换（接入用，2026-11-19） ─────────────────────

const localTools = [
	{ type: "function", function: { name: "read" } },
	{ type: "function", function: { name: "web_search" } },
	{ type: "function", function: { name: "bash" } },
];

test("命中白名单：摘掉 web_search，追加服务端工具，其余不动", () => {
	const r = swapWebSearchTool(localTools, `${MAGPIE_GATEWAY_ORIGIN}/v1`, "deepseek/deepseek-flash", ON);
	assert.equal(r.swapped, true);
	assert.equal(r.providerId, "magpie-local");
	assert.equal(r.tools.length, localTools.length);
	assert.ok(r.tools.some((t) => (t as { type: string }).type === "deepseek_web_search"));
	assert.ok(!r.tools.some((t) => (t as { function?: { name?: string } }).function?.name === "web_search"));
	assert.ok(r.tools.some((t) => (t as { function?: { name?: string } }).function?.name === "read"));
	assert.ok(r.tools.some((t) => (t as { function?: { name?: string } }).function?.name === "bash"));
});

test("替换不改入参：原数组仍是三个本地工具", () => {
	const original = structuredClone(localTools);
	swapWebSearchTool(localTools, `${MAGPIE_GATEWAY_ORIGIN}/v1`, "deepseek/deepseek-flash", ON);
	assert.deepEqual(localTools, original);
});

test("本地没有 web_search：不注入（尊重「搜索被禁用」）", () => {
	const noSearch = localTools.filter((t) => t.function.name !== "web_search");
	const r = swapWebSearchTool(noSearch, `${MAGPIE_GATEWAY_ORIGIN}/v1`, "deepseek/deepseek-flash", ON);
	assert.equal(r.swapped, false);
	assert.equal(r.tools.length, noSearch.length);
});

test("非白名单端点：一个字节都不动（百炼会 400）", () => {
	const r = swapWebSearchTool(localTools, "https://dashscope.aliyuncs.com/compatible-mode/v1", "deepseek-v4.1-flash", ON);
	assert.equal(r.swapped, false);
	assert.deepEqual(r.tools, localTools);
});

test("开关关闭：即使命中端点也不替换", () => {
	const r = swapWebSearchTool(localTools, `${MAGPIE_GATEWAY_ORIGIN}/v1`, "deepseek/deepseek-flash", OFF);
	assert.equal(r.swapped, false);
});
