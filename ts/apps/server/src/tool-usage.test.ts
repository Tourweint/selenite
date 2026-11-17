import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	readToolUsage,
	recordToolLoad,
	recordToolUse,
	toolUsageEnabled,
	toolUsagePath,
	toolUsageRows,
} from "./tool-usage.ts";

/**
 * 工具用量账（2026-11-17）。全程临时文件，不碰真实 `.data/`。
 *
 * 只钉四条：执行 +1（成败分桶）、loads 只走 tool_search 不动执行数、开关旁路、
 * 坏账容忍（旧形态缺 err/loads / 坏 JSON 都当空账或补 0，不挡列表）。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-tool-usage-"));
const path = join(root, "tool-usage.json");
const env = { AGENT_TOOL_USAGE_PATH: path } as NodeJS.ProcessEnv;

test.after(() => {
	rmSync(root, { recursive: true, force: true });
});

test("执行计数：每执行一次 +1，成败分桶，lastUsedAt 跟随", () => {
	const t1 = new Date("2026-11-01T00:00:00.000Z");
	recordToolUse("bash", true, t1, env);
	recordToolUse("bash", true, new Date("2026-11-02T00:00:00.000Z"), env);
	recordToolUse("web_search", false, t1, env);
	recordToolUse("partner_manage", true, t1, env); // deferred 加载后的调用走同一条路

	const usage = readToolUsage(env);
	assert.equal(usage["bash"]?.count, 2);
	assert.equal(usage["bash"]?.err, 0);
	assert.equal(usage["bash"]?.lastUsedAt, "2026-11-02T00:00:00.000Z");
	assert.equal(usage["web_search"]?.count, 1);
	assert.equal(usage["web_search"]?.err, 1);
	assert.equal(usage["partner_manage"]?.count, 1);
	assert.equal(usage["not-used"], undefined);
});

test("加载计数：loads +1，不动 count / lastUsedAt；先加载后执行接得上", () => {
	const t1 = new Date("2026-11-03T00:00:00.000Z");
	recordToolLoad("routine_manage", t1, env);
	recordToolLoad("routine_manage", new Date("2026-11-03T01:00:00.000Z"), env);
	let usage = readToolUsage(env);
	assert.equal(usage["routine_manage"]?.loads, 2);
	assert.equal(usage["routine_manage"]?.count, 0, "只搜出来没调用不算执行");
	assert.equal(usage["routine_manage"]?.lastUsedAt, null);

	recordToolUse("routine_manage", true, new Date("2026-11-04T00:00:00.000Z"), env);
	usage = readToolUsage(env);
	assert.equal(usage["routine_manage"]?.count, 1);
	assert.equal(usage["routine_manage"]?.loads, 2, "执行不冲掉 loads");
	assert.equal(usage["routine_manage"]?.lastUsedAt, "2026-11-04T00:00:00.000Z");
});

test("开关旁路：TOOL_USAGE=false → 执行与加载都不记账，旧账照读", () => {
	const off = { ...env, TOOL_USAGE: "false" } as NodeJS.ProcessEnv;
	assert.equal(toolUsageEnabled(off), false);
	recordToolUse("bash", true, new Date("2026-11-05T00:00:00.000Z"), off);
	recordToolLoad("bash", new Date("2026-11-05T00:00:00.000Z"), off);
	assert.equal(readToolUsage(env)["bash"]?.count, 2, "关着时不该 +1");
	assert.equal(readToolUsage(env)["bash"]?.loads, 0, "关着时不该记 loads");
	assert.equal(toolUsageEnabled({}), true, "缺省开");
	assert.equal(toolUsageEnabled({ TOOL_USAGE: "0" } as NodeJS.ProcessEnv), false);
	assert.equal(toolUsageEnabled({ TOOL_USAGE: "off" } as NodeJS.ProcessEnv), false);
});

test("坏账容忍：缺 err/loads 的旧条目补 0；坏 JSON / 非法条目当空账；路径缺省落 .data", () => {
	const legacy = join(root, "legacy.json");
	writeFileSync(
		legacy,
		JSON.stringify({ usage: { bash: { count: 5, lastUsedAt: "2026-11-01T00:00:00.000Z" }, broken: { count: "x" } } }),
		"utf8",
	);
	const legacyEnv = { AGENT_TOOL_USAGE_PATH: legacy } as NodeJS.ProcessEnv;
	const usage = readToolUsage(legacyEnv);
	assert.equal(usage["bash"]?.count, 5);
	assert.equal(usage["bash"]?.err, 0, "旧形态缺 err 补 0");
	assert.equal(usage["bash"]?.loads, 0);
	assert.equal(usage["broken"], undefined, "非法条目丢弃");

	const bad = join(root, "bad.json");
	writeFileSync(bad, "not json", "utf8");
	assert.deepEqual(readToolUsage({ AGENT_TOOL_USAGE_PATH: bad } as NodeJS.ProcessEnv), {});

	assert.equal(toolUsagePath({} as NodeJS.ProcessEnv).endsWith("tool-usage.json"), true, "缺省路径");
});

test("端点投影：按执行次数降序，并列按名字稳定排序", () => {
	const t1 = new Date("2026-11-06T00:00:00.000Z");
	recordToolUse("aaa", true, t1, env);
	recordToolUse("aaa", true, t1, env); // 与 bash 并列 2 次，名字序在前
	const rows = toolUsageRows(env);
	assert.deepEqual(
		rows.map((row) => row.name),
		["aaa", "bash", "partner_manage", "routine_manage", "web_search"],
	);
	assert.equal(rows.find((row) => row.name === "aaa")?.count, 2);
});
