import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 记忆库槽位端点（2026-11-23 外部记忆库接入）。
 *
 * 真挂 Hono + 真子进程：假 ask.py / repair.py 用 JS 写，`PERSONA_PYTHON` 指向
 * `process.execPath`（node 把 `.py` 当 CommonJS 跑）——不依赖本机 python，也不碰任何
 * 真实记忆库。env 必须在动态 import `memory-api` / `agent.ts` 之前设好。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-bank-api-"));
const bankRoot = join(root, "bank");
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
process.env.MEMORY_PROPOSALS_PATH = join(root, "memory-proposals.json");
process.env.MEMORY_CONSOLIDATE_DIFF_PATH = join(root, "memory-consolidate-diff.json");
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.PROVIDERS_PATH = join(root, "providers.json");
process.env.DELEGATIONS_DB_PATH = join(root, "delegations.sqlite");
process.env.AGENT_SSE_SEQ_DB_PATH = join(root, "chat-events.sqlite");
process.env.AGENT_POLICY_PATH = join(root, "policy.json");
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.ROUTINES_STATE_PATH = join(root, "routines.json");
process.env.AUTONOMY_STATE_PATH = join(root, "autonomy-state.json");
process.env.AGENT_FLAGS_PATH = join(root, "agent-flags.json");
process.env.LLM_PROVIDER = "faux";
process.env.MEMORY_ENABLED = "true";
process.env.MEMORY_BANK_PATH = join(root, "memory-bank.json");
process.env.PERSONA_MEMORY_ASK = "";
process.env.PERSONA_MEMORY_ENABLED = "true";
process.env.PERSONA_WRITE_ENABLED = "false";
process.env.PERSONA_PYTHON = process.execPath;
process.env.CHANCELLOR_ENABLED = "false";
process.env.COMPANIONS_ENABLED = "false";

mkdirSync(bankRoot, { recursive: true });

writeFileSync(
	join(bankRoot, "ask.py"),
	`const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "ask.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--catalog-only")) {
  console.log("测试库：2 条记录");
  console.log("人物：姥姥");
  process.exit(0);
}
console.log(JSON.stringify({
  groups: {
    memory_day: [{ id: "mem-1", date: "2024-10-06", title: "旧事", body: "假命中正文", why: "关键词命中" }],
    fact: [{ id: "fact-1", date: "2024-10-07", title: "事实", body: "另一条", why: "用户亲口确认" }]
  },
  coverage: { gaps: ["2022-03"] },
  unknown: "查不到 ≠ 没有这回事"
}));
`,
	"utf8",
);
writeFileSync(
	join(bankRoot, "repair.py"),
	`const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "repair.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("已记：ok");
`,
	"utf8",
);

const { Hono } = await import("hono");
const { mountMemoryApi } = await import("./memory-api.ts");
const { resetMemoryBankCacheForTests } = await import("./memory-bank.ts");

resetMemoryBankCacheForTests();
const app = new Hono();
mountMemoryApi(app, { enabled: true });

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const response = await app.request(path, init);
	return { status: response.status, body: await response.json() };
}

function putBody(path: string, body: unknown): Promise<{ status: number; body: any }> {
	return json(path, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function postBody(path: string, body: unknown): Promise<{ status: number; body: any }> {
	return json(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("GET /bank：没配置 = builtin / external null，工具面 recall+remember，timeouts 默认", async () => {
	const result = await json("/api/v1/agent/memory/bank");
	assert.equal(result.status, 200);
	assert.equal(result.body.ok, true);
	assert.equal(result.body.enabled, true);
	assert.equal(result.body.active, "builtin");
	assert.equal(result.body.external, null);
	assert.deepEqual(result.body.tools, ["recall", "remember"]);
	assert.deepEqual(result.body.timeouts, { lightMs: 8000, askMs: 15000 }, "两档超时默认 8s / 15s");
});

test("POST /bank/probe：识别 ask/repair + 跑 catalog-only，不落盘", async () => {
	const result = await postBody("/api/v1/agent/memory/bank/probe", { root: bankRoot });
	assert.equal(result.status, 200);
	assert.equal(result.body.ok, true);
	assert.equal(result.body.status, "ok");
	assert.equal(result.body.ask, "ask.py");
	assert.equal(result.body.repair, "repair.py");
	assert.ok(result.body.catalog.lines.some((line: string) => line.includes("测试库")));
	const state = await json("/api/v1/agent/memory/bank");
	assert.equal(state.body.external, null, "probe 不落盘");
});

test("PUT /bank/external：探测通过才保存，保存不自动切换；vector 落盘", async () => {
	const result = await putBody("/api/v1/agent/memory/bank/external", {
		root: bankRoot,
		name: "我的库",
		vector: true,
	});
	assert.equal(result.status, 200);
	assert.equal(result.body.ok, true);
	assert.equal(result.body.external.name, "我的库");
	assert.equal(result.body.external.root, bankRoot);
	assert.equal(result.body.external.vector, true, "vector 随接入一起保存");
	assert.equal(result.body.bank.active, "builtin", "保存后 active 仍为 builtin");

	const state = await json("/api/v1/agent/memory/bank");
	assert.equal(state.body.external.status, "ok");
	assert.equal(state.body.external.vector, true, "GET /bank 带出 vector");
	assert.equal(state.body.external.capabilities.read, true);
	assert.equal(state.body.external.capabilities.catalog, true);
	assert.equal(state.body.external.capabilities.write, false, "PERSONA_WRITE_ENABLED 默认关");
});

test("PUT /bank/external：vector 只认布尔；非法值 400 且不落盘", async () => {
	const before = await json("/api/v1/agent/memory/bank");
	const result = await putBody("/api/v1/agent/memory/bank/external", {
		root: bankRoot,
		vector: "yes",
	});
	assert.equal(result.status, 400);
	assert.equal(result.body.error, "bad_request");
	assert.equal(result.body.message, "vector 只能是 true 或 false");
	const after = await json("/api/v1/agent/memory/bank");
	assert.equal(after.body.external.vector, before.body.external.vector, "非法 vector 不改配置");
});

test("PUT /bank：timeouts 局部更新与 GET 回环（缺省字段不动）", async () => {
	const setLight = await putBody("/api/v1/agent/memory/bank", { timeouts: { lightMs: 12000 } });
	assert.equal(setLight.status, 200);
	assert.deepEqual(setLight.body.timeouts, { lightMs: 12000, askMs: 15000 }, "只改 lightMs");
	assert.equal(setLight.body.active, "builtin", "只改 timeouts 不动 active");

	const state = await json("/api/v1/agent/memory/bank");
	assert.deepEqual(state.body.timeouts, { lightMs: 12000, askMs: 15000 }, "GET 回读到新值");

	const clamped = await putBody("/api/v1/agent/memory/bank", {
		timeouts: { lightMs: 1, askMs: 999999 },
	});
	assert.equal(clamped.status, 200);
	assert.deepEqual(clamped.body.timeouts, { lightMs: 500, askMs: 120000 }, "服务端 clamp 到边界");

	const invalid = await putBody("/api/v1/agent/memory/bank", { timeouts: { lightMs: "8" } });
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.error, "bad_request");
	assert.deepEqual(
		(await json("/api/v1/agent/memory/bank")).body.timeouts,
		{ lightMs: 500, askMs: 120000 },
		"非法请求不改配置",
	);

	const empty = await putBody("/api/v1/agent/memory/bank", {});
	assert.equal(empty.status, 400, "active / timeouts 都不给 = 400");

	const both = await putBody("/api/v1/agent/memory/bank", {
		active: "builtin",
		timeouts: { lightMs: 9000, askMs: 14000 },
	});
	assert.equal(both.status, 200);
	assert.equal(both.body.active, "builtin");
	assert.deepEqual(both.body.timeouts, { lightMs: 9000, askMs: 14000 });
	assert.deepEqual(
		(await json("/api/v1/agent/memory/bank")).body.timeouts,
		{ lightMs: 9000, askMs: 14000 },
		"一次请求同时更新两者");
});

test("PUT /bank：切到 external；GET /bank/catalog 与 POST /bank/search 走外接库", async () => {
	const switched = await putBody("/api/v1/agent/memory/bank", { active: "external" });
	assert.equal(switched.status, 200);
	assert.equal(switched.body.active, "external");

	const catalog = await json("/api/v1/agent/memory/bank/catalog");
	assert.equal(catalog.status, 200);
	assert.equal(catalog.body.ok, true);
	assert.ok(catalog.body.lines.some((line: string) => line.includes("姥姥")));

	const search = await postBody("/api/v1/agent/memory/bank/search", { query: "旧事", limit: 5 });
	assert.equal(search.status, 200);
	assert.equal(search.body.ok, true);
	assert.equal(search.body.count, 2);
	assert.deepEqual(
		search.body.hits.map((hit: { group: string; id: string }) => [hit.group, hit.id]),
		[
			["memory_day", "mem-1"],
			["fact", "fact-1"],
		],
		"按组序扁平化",
	);
	assert.equal(search.body.hits[0].text, "假命中正文", "body 映射成 text");
	assert.deepEqual(search.body.coverage.gaps, ["2022-03"]);
	assert.equal(search.body.unknown, "查不到 ≠ 没有这回事");
});

test("切回 builtin：catalog / search 返回 400 bank_builtin", async () => {
	const switched = await putBody("/api/v1/agent/memory/bank", { active: "builtin" });
	assert.equal(switched.status, 200);
	assert.equal(switched.body.active, "builtin");
	assert.equal((await json("/api/v1/agent/memory/bank/catalog")).status, 400);
	assert.equal(
		(await postBody("/api/v1/agent/memory/bank/search", { query: "旧事" })).status,
		400,
	);
});

test("DELETE /bank/external：若当前是 external 先切回 builtin", async () => {
	assert.equal((await putBody("/api/v1/agent/memory/bank", { active: "external" })).status, 200);
	const deleted = await json("/api/v1/agent/memory/bank/external", { method: "DELETE" });
	assert.equal(deleted.status, 200);
	assert.equal(deleted.body.ok, true);
	assert.equal(deleted.body.active, "builtin");
	const state = await json("/api/v1/agent/memory/bank");
	assert.equal(state.body.external, null);
	assert.equal(state.body.active, "builtin");
	assert.equal(
		(await json("/api/v1/agent/memory/bank/external", { method: "DELETE" })).status,
		404,
		"再删 = 404",
	);
});

test("MEMORY_BANK=false 已退役：/bank 端点不再 404，工具面仍恒为 recall+remember", async () => {
	process.env.MEMORY_BANK = "false";
	try {
		const state = await json("/api/v1/agent/memory/bank");
		assert.equal(state.status, 200, "旧总闸 env 不再影响槽位端点");
		assert.deepEqual(state.body.tools, ["recall", "remember"]);
		// 旧页脚端点保留（MEMORY_EXTERNAL 仍生效）：没有外接槽位 = configured false。
		const legacy = await json("/api/v1/agent/memory/external");
		assert.equal(legacy.status, 200);
		assert.equal(legacy.body.configured, false);
		assert.equal(legacy.body.ready, false);
	} finally {
		delete process.env.MEMORY_BANK;
	}
});

test("记忆未启用（MEMORY_ENABLED=false）：/bank 仍整组 404", async () => {
	const offApp = new Hono();
	mountMemoryApi(offApp, { enabled: false });
	for (const [method, path] of [
		["GET", "/api/v1/agent/memory/bank"],
		["PUT", "/api/v1/agent/memory/bank"],
		["POST", "/api/v1/agent/memory/bank/probe"],
		["GET", "/api/v1/agent/memory/bank/catalog"],
	] as const) {
		const response = await offApp.request(path, { method });
		assert.equal(response.status, 404, `${method} ${path} 应 404`);
	}
});
