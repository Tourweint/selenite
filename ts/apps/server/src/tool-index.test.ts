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
	toolIndexEnabled,
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

test("DEFERRED_TOOL_NAMES：固定名单（批4 起 9 个：+save_reminder_advice）", () => {
	assert.deepEqual([...DEFERRED_TOOL_NAMES].sort(), [
		"group_manage",
		"partner_manage",
		"partner_skill_write",
		"propose_project",
		// 2026-11-19 批2 决策上报链：只在唤醒轮用得上，默认按需。
		"respond_escalation",
		"routine_manage",
		// 2026-11-19 批4 提醒沉淀：只有入口发起蒸馏那轮用得上，默认按需。
		"save_reminder_advice",
		"save_skill_advice",
		"send_to_agent",
	]);
});

test("toolIndexEnabled：缺省开；false / 0 / off（大小写空白不敏感）关", () => {
	assert.equal(toolIndexEnabled({}), true);
	assert.equal(toolIndexEnabled({ AGENT_TOOL_INDEX: "1" }), true);
	assert.equal(toolIndexEnabled({ AGENT_TOOL_INDEX: "FALSE" }), false);
	assert.equal(toolIndexEnabled({ AGENT_TOOL_INDEX: "0" }), false);
	assert.equal(toolIndexEnabled({ AGENT_TOOL_INDEX: " off " }), false);
});

test("isDeferredTool：名单内且开关开才为真（文件缺失 = 代码默认）", () => {
	assert.equal(isDeferredTool("routine_manage", true, missing), true);
	assert.equal(isDeferredTool("send_to_agent", true, missing), true);
	assert.equal(isDeferredTool("read", true, missing), false);
	assert.equal(isDeferredTool("routine_manage", false, missing), false);
});

test("markDeferred：只给名单内工具加属性、不改原对象、保持顺序", () => {
	const tools = [tool("read"), tool("routine_manage"), tool("write"), tool("send_to_agent")];
	const marked = markDeferred(tools, true, missing);
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

test("markDeferred：关时一个都不加", () => {
	const tools = [tool("routine_manage"), tool("read")];
	const marked = markDeferred(tools, false, missing);
	assert.deepEqual(
		marked.map((item) => item.name),
		["routine_manage", "read"],
	);
	assert.equal(marked[0]?.deferred, undefined);
	assert.equal(marked[0], tools[0]);
});

test("markDeferred：配置文件覆盖默认名单（2026-11-17 全局工具池）", () => {
	const custom = join(root, "custom.json");
	writeFileSync(custom, JSON.stringify({ deferred: ["read", "web_search"] }), "utf8");
	const env = { AGENT_TOOL_POOL_PATH: custom } as NodeJS.ProcessEnv;
	const tools = [tool("read"), tool("routine_manage"), tool("web_search")];
	const marked = markDeferred(tools, true, env);
	assert.equal(marked[0]?.deferred, true, "配置里的 read 变成按需");
	assert.equal(marked[1]?.deferred, undefined, "默认名单里的 routine_manage 不再按需");
	assert.equal(marked[2]?.deferred, true);

	const empty = join(root, "empty.json");
	writeFileSync(empty, JSON.stringify({ deferred: [] }), "utf8");
	const none = markDeferred(tools, true, { AGENT_TOOL_POOL_PATH: empty } as NodeJS.ProcessEnv);
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
