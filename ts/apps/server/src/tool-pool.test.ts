import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
	DEFAULT_DEFERRED_TOOL_NAMES,
	appliedDeferredToolNames,
	mountToolPoolRoutes,
	noteAppliedDeferredNames,
	poolDiffers,
	readDeferredToolNames,
	sanitizeDeferredList,
	toolPoolPath,
	toolPoolPayload,
	writeDeferredToolNames,
} from "./tool-pool.ts";

/**
 * 全局工具池（2026-11-17 设置→工具页）。全程临时文件，不碰真实 `.data/`。
 *
 * 钉五类：默认回落 / 读写往返 / 坏配置容忍 / 校验（含 tool_search 自锁守卫）/
 * 端点形状与"待重启"判定。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-tool-pool-"));
const path = join(root, "tool-pool.json");
const env = { AGENT_TOOL_POOL_PATH: path } as NodeJS.ProcessEnv;

test.after(() => {
	rmSync(root, { recursive: true, force: true });
});

test("缺文件 / 坏 JSON / deferred 不是数组 → 回落代码默认名单", () => {
	assert.deepEqual(readDeferredToolNames(env), [...DEFAULT_DEFERRED_TOOL_NAMES]);
	writeFileSync(path, "not json", "utf8");
	assert.deepEqual(readDeferredToolNames(env), [...DEFAULT_DEFERRED_TOOL_NAMES]);
	writeFileSync(path, JSON.stringify({ deferred: "routine_manage" }), "utf8");
	assert.deepEqual(readDeferredToolNames(env), [...DEFAULT_DEFERRED_TOOL_NAMES]);
});

test("读写往返：去重、空数组合法（= 全部常驻）", () => {
	writeDeferredToolNames(["read", "read", "web_search"], env);
	assert.deepEqual(readDeferredToolNames(env), ["read", "web_search"]);
	assert.match(readFileSync(path, "utf8"), /"deferred"/);
	writeDeferredToolNames([], env);
	assert.deepEqual(readDeferredToolNames(env), []);
	assert.equal(toolPoolPath(env), path);
	assert.ok(toolPoolPath({}).endsWith(join(".data", "tool-pool.json")), "缺省落 .data");
});

test("校验：非数组 / 非字符串 / 超 64 / 未知名 / tool_search 进按需", () => {
	const known = new Set(["read", "write", "routine_manage", "tool_search"]);
	assert.equal(sanitizeDeferredList(null, known).ok, false);
	assert.equal(sanitizeDeferredList("read", known).ok, false);
	assert.equal(sanitizeDeferredList([1], known).ok, false);
	assert.equal(sanitizeDeferredList(new Array(65).fill("read"), known).ok, false);

	assert.deepEqual(sanitizeDeferredList(["routine_manage", "routine_manage"], known), {
		ok: true,
		deferred: ["routine_manage"],
	});
	const unknown = sanitizeDeferredList(["nope"], known);
	assert.equal(unknown.ok, false);
	if (!unknown.ok) {
		assert.deepEqual(unknown.unknown, ["nope"]);
		assert.match(unknown.message, /未知工具：nope/);
	}
	const selfLock = sanitizeDeferredList(["tool_search"], known);
	assert.equal(selfLock.ok, false);
	if (!selfLock.ok) assert.match(selfLock.message, /tool_search 不能设为按需/);
});

test("待重启判定：运行名单 vs 配置名单", () => {
	assert.equal(poolDiffers(["a"], null), false, "还没装配过 → 不算待重启");
	assert.equal(poolDiffers(["a"], ["a"]), false, "完全一致");
	assert.equal(poolDiffers(["a", "b"], ["a"]), true, "多一个");
	assert.equal(poolDiffers(["b"], ["a"]), true, "换了名字");
	assert.equal(poolDiffers([], []), false);
});

test("applied 记录：markDeferred 的落点（noteAppliedDeferredNames）", () => {
	noteAppliedDeferredNames(["routine_manage", "routine_manage"]);
	assert.deepEqual(appliedDeferredToolNames(), ["routine_manage"], "去重");
	noteAppliedDeferredNames([]);
	assert.deepEqual(appliedDeferredToolNames(), []);
});

test("payload：目录含 deferred 配置、token 口径、restartPending", () => {
	const tool = (name: string, description: string): ToolRegistration =>
		({
			name,
			description,
			parameters: { type: "object", properties: {} },
			execute: async () => ({ output: "ok" }),
		}) as unknown as ToolRegistration;
	const deps = {
		env,
		catalog: () => [tool("read", "读文件。"), tool("routine_manage", "管理例行规则。")],
		summaryOf: (text: string) => text.replace(/。$/, ""),
	};
	writeDeferredToolNames(["routine_manage"], env);
	noteAppliedDeferredNames(["routine_manage"]);
	const payload = toolPoolPayload(deps);
	assert.equal(payload.tools.length, 2);
	assert.equal(payload.tools[0]?.deferred, false);
	assert.equal(payload.tools[1]?.deferred, true);
	assert.equal(payload.tools[1]?.description, "管理例行规则。", "带描述原文（展开行用）");
	assert.deepEqual(payload.tools[1]?.parameters, { type: "object", properties: {} }, "带参数 JSON Schema");
	assert.ok((payload.tools[0]?.tokens ?? 0) > 0);
	assert.equal(payload.restartPending, false);

	writeDeferredToolNames([], env);
	assert.equal(toolPoolPayload(deps).restartPending, true, "配置改了但还没重启");
});

test("端点：GET 形状 + PUT 落盘 / 400 校验 / 开关关时拒写", async () => {
	const tool = (name: string): ToolRegistration =>
		({
			name,
			description: `${name} 说明。`,
			parameters: { type: "object", properties: {} },
			execute: async () => ({ output: "ok" }),
		}) as unknown as ToolRegistration;
	const app = new Hono();
	mountToolPoolRoutes(app, {
		env,
		catalog: () => [tool("read"), tool("routine_manage"), tool("tool_search")],
		summaryOf: (text) => text,
	});
	writeDeferredToolNames([], env);
	noteAppliedDeferredNames([]);

	const got = await app.request("/api/v1/agent/tool-pool");
	assert.equal(got.status, 200);
	const gotBody = (await got.json()) as { ok: boolean; deferred: string[]; tools: unknown[] };
	assert.equal(gotBody.ok, true);
	assert.deepEqual(gotBody.deferred, []);
	assert.equal(gotBody.tools.length, 3);

	const put = await app.request("/api/v1/agent/tool-pool", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deferred: ["routine_manage", "routine_manage"] }),
	});
	assert.equal(put.status, 200);
	assert.deepEqual(readDeferredToolNames(env), ["routine_manage"], "去重后落盘");

	const bad = await app.request("/api/v1/agent/tool-pool", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deferred: ["nope"] }),
	});
	assert.equal(bad.status, 400);
	const selfLock = await app.request("/api/v1/agent/tool-pool", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deferred: ["tool_search"] }),
	});
	assert.equal(selfLock.status, 400);

	//（"索引关了就不允许改池子"用例 2026-11-21 随 AGENT_TOOL_INDEX 退役删除，池子恒可改。）
});
