import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
	DEFERRED_TOOL_NAMES,
	isDeferredTool,
	markDeferred,
	toolIndexText,
} from "./tool-index.ts";

/**
 * 名单现在住 `.data/tool-pool.json`（2026-11-17 全局工具池）：测试必须钉到临时路径，
 * 否则开发机上真实保存过的工具池会把断言带偏。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-tool-index-"));
const missing = { AGENT_TOOL_POOL_PATH: join(root, "missing.json") } as NodeJS.ProcessEnv;

test.after(() => {
	rmSync(root, { recursive: true, force: true });
});

function tool(name: string): ToolRegistration {
	return {
		name,
		description: `${name} 做一件事。第二句不该出现在摘要里。`,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: "ok" }),
	} as unknown as ToolRegistration;
}

test("DEFERRED_TOOL_NAMES：2026-11-25 起代码默认为空 = 全部常驻", () => {
	assert.deepEqual([...DEFERRED_TOOL_NAMES], []);
});

test("isDeferredTool：默认全常驻；显式按需池才为真", () => {
	assert.equal(isDeferredTool("routine_manage", missing), false);
	assert.equal(isDeferredTool("send_to_agent", missing), false);
	assert.equal(isDeferredTool("read", missing), false);

	const optIn = join(root, "opt-in.json");
	writeFileSync(optIn, JSON.stringify({ deferred: ["routine_manage", "send_to_agent"] }), "utf8");
	const env = { AGENT_TOOL_POOL_PATH: optIn } as NodeJS.ProcessEnv;
	assert.equal(isDeferredTool("routine_manage", env), true);
	assert.equal(isDeferredTool("send_to_agent", env), true);
	assert.equal(isDeferredTool("read", env), false);
});

test("markDeferred：默认名单为空 → 全部原样；显式按需池才浅拷贝加属性", () => {
	const tools = [tool("read"), tool("routine_manage"), tool("write"), tool("send_to_agent")];
	const untouched = markDeferred(tools, missing);
	assert.equal(untouched.every((item) => item.deferred === undefined), true, "默认全常驻");
	assert.equal(untouched[1], tools[1], "不产生浅拷贝");

	const optIn = join(root, "opt-in-mark.json");
	writeFileSync(optIn, JSON.stringify({ deferred: ["routine_manage", "send_to_agent"] }), "utf8");
	const env = { AGENT_TOOL_POOL_PATH: optIn } as NodeJS.ProcessEnv;
	const marked = markDeferred(tools, env);
	assert.deepEqual(
		marked.map((item) => item.name),
		["read", "routine_manage", "write", "send_to_agent"],
	);
	assert.equal(marked[0], tools[0], "名单外的原样返回（同一引用）");
	assert.equal(marked[2], tools[2]);
	assert.equal(marked[1]?.deferred, true);
	assert.notEqual(marked[1], tools[1], "名单内的是浅拷贝");
	assert.equal(tools[1]?.deferred, undefined, "原对象没被改");
	assert.equal(marked[3]?.deferred, true);
	assert.equal(tools[3]?.deferred, undefined);
});

test("markDeferred：配置文件显式覆盖按需名单（2026-11-17 全局工具池）", () => {
	const custom = join(root, "custom.json");
	writeFileSync(custom, JSON.stringify({ deferred: ["read", "web_search"] }), "utf8");
	const env = { AGENT_TOOL_POOL_PATH: custom } as NodeJS.ProcessEnv;
	const tools = [tool("read"), tool("routine_manage"), tool("web_search")];
	const marked = markDeferred(tools, env);
	assert.equal(marked[0]?.deferred, true, "配置里的 read 变成按需");
	assert.equal(marked[1]?.deferred, undefined, "没在配置里的 routine_manage 常驻");
	assert.equal(marked[2]?.deferred, true);

	const empty = join(root, "empty.json");
	writeFileSync(empty, JSON.stringify({ deferred: [] }), "utf8");
	const none = markDeferred(tools, { AGENT_TOOL_POOL_PATH: empty } as NodeJS.ProcessEnv);
	assert.equal(none.every((item) => item.deferred === undefined), true, "空数组 = 全部常驻");
});

test("toolIndexText：空列表 undefined；有列表含标题、每个名字与提示句", () => {
	assert.equal(toolIndexText([]), undefined);
	const text = toolIndexText([
		{ name: "routine_manage", description: "自建常驻自主轮。第二句不该出现在摘要里。" },
		{ name: "send_to_agent", description: "给另一个执事递话。" },
	]);
	assert.ok(text);
	assert.match(text!, /^按需工具（初始不加载）：/);
	assert.match(text!, /- routine_manage：自建常驻自主轮/);
	assert.match(text!, /- send_to_agent：给另一个执事递话/);
	assert.ok(!text!.includes("第二句不该出现在摘要里"), "摘要只取首句");
	assert.match(text!, /tool_search\(\{name\}\)/);
});
