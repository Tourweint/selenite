import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { mountToolPolicyRoutes } from "./tool-policy-api.ts";
import {
	emptyToolPolicyConfig,
	readToolPolicyConfig,
	resetToolPolicyCacheForTests,
	writeToolPolicyConfig,
	type ToolPolicyConfig,
} from "./tool-policy.ts";

/**
 * 工具超时策略端点（2026-11-24 M0）：
 * GET/PUT 回环、局部更新、null 删除、错误码、开关关 404。
 * 全部用临时 `TOOL_POLICY_PATH`；legacy 用假 provider，不读真实 memory-bank.json。
 */

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lh-tool-policy-api-"));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const LEGACY = () => ({ recall: 30_000, memoryLight: 8_000 });

function makeApp(path: string, enabled = () => true): Hono {
	// 与生产一致：endpoint 的 enabled 与 resolver 读的是同一个开关，所以这里也把它放进 env。
	const env: NodeJS.ProcessEnv = { TOOL_POLICY_PATH: path, TOOL_TIMEOUT_POLICY: "true" };
	const app = new Hono();
	mountToolPolicyRoutes(app, { env, enabled, legacy: LEGACY });
	return app;
}

test("开关关：GET / PUT 都 404", async () => {
	const path = join(tempDir(), "tool-policy.json");
	const app = makeApp(path, () => false);
	const get = await app.request("/api/v1/agent/tool-policy");
	assert.equal(get.status, 404);
	const put = await app.request("/api/v1/agent/tool-policy", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tools: { bash: { timeoutMs: 900_000 } } }),
	});
	assert.equal(put.status, 404);
});

test("GET：分组 + 4 个可配工具 + 锁定原因 + legacy 注入；cache-control no-store", async () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const app = makeApp(path);
	const response = await app.request("/api/v1/agent/tool-policy");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const body = (await response.json()) as {
		ok: boolean;
		enabled: boolean;
		groups: Array<{ id: string }>;
		tools: Array<{
			name: string;
			effective: { timeoutMs: number | null; onTimeout: string; notify: boolean; source: string } | null;
			ranges: { min: number; max: number } | null;
			lockedReason: string | null;
			capabilities: { configurable: boolean; backgroundable: boolean; abortable: boolean };
		}>;
		injections: Array<{ name: string; effective: { timeoutMs: number; source: string } }>;
		backgroundJobs: { indexLimit: number };
	};
	assert.equal(body.ok, true);
	assert.equal(body.enabled, true);
	assert.deepEqual(
		body.groups.map((group) => group.id),
		["shell", "memory", "search", "collaborate", "interaction", "skills", "meta"],
	);
	const configurable = body.tools.filter((tool) => tool.capabilities.configurable).map((tool) => tool.name);
	assert.deepEqual(configurable, ["bash", "powershell", "recall", "web_search"]);
	const recall = body.tools.find((tool) => tool.name === "recall")!;
	assert.deepEqual(recall.effective, {
		timeoutMs: 30_000,
		onTimeout: "fail",
		notify: false,
		source: "legacy",
	});
	assert.deepEqual(recall.ranges, { min: 1000, max: 120_000 });
	const read = body.tools.find((tool) => tool.name === "read")!;
	assert.equal(read.effective, null, "锁定行没有可解析的输入面");
	assert.equal(read.ranges, null);
	assert.match(read.lockedReason ?? "", /本地同步读/);
	assert.equal(body.injections[0]?.name, "memoryLight");
	assert.equal(body.injections[0]?.effective.timeoutMs, 8000);
	assert.equal(body.injections[0]?.effective.source, "legacy");
	assert.equal(body.backgroundJobs.indexLimit, 200);
});

test("PUT 局部更新 + null 删除 + GET 回读：值持久化到文件", async () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const app = makeApp(path);
	writeToolPolicyConfig(emptyToolPolicyConfig(), { TOOL_POLICY_PATH: path });

	const put = await app.request("/api/v1/agent/tool-policy", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			tools: {
				bash: { timeoutMs: 1_800_000, onTimeout: "background", notify: true },
				recall: { timeoutMs: 20_000 },
			},
			injections: { memoryLight: { timeoutMs: 6_000 } },
		}),
	});
	assert.equal(put.status, 200);
	const putBody = (await put.json()) as {
		tools: Array<{ name: string; effective: { timeoutMs: number; onTimeout: string; source: string } | null }>;
		injections: Array<{ name: string; effective: { timeoutMs: number; source: string } }>;
	};
	const bash = putBody.tools.find((tool) => tool.name === "bash")!;
	assert.deepEqual(bash.effective, {
		timeoutMs: 1_800_000,
		onTimeout: "background",
		notify: true,
		source: "tool",
	});
	assert.equal(putBody.injections[0]?.effective.timeoutMs, 6_000);
	assert.equal(putBody.injections[0]?.effective.source, "tool");

	// 局部更新：只给 groups，不动 tools / injections
	const groupsOnly = await app.request("/api/v1/agent/tool-policy", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ groups: { memory: { timeoutMs: 12_000 } } }),
	});
	assert.equal(groupsOnly.status, 200);
	const stored = JSON.parse(readFileSync(path, "utf8")) as ToolPolicyConfig;
	assert.deepEqual(stored.tools.bash, { timeoutMs: 1_800_000, onTimeout: "background", notify: true });
	assert.deepEqual(stored.groups, { memory: { timeoutMs: 12_000 } });
	assert.deepEqual(stored.injections, { memoryLight: { timeoutMs: 6_000 } });

	// null = 删除该条，回继承（memory 组 → legacy 30s）
	const deleted = await app.request("/api/v1/agent/tool-policy", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tools: { recall: null } }),
	});
	assert.equal(deleted.status, 200);
	const deletedBody = (await deleted.json()) as {
		tools: Array<{ name: string; effective: { timeoutMs: number; source: string } | null }>;
	};
	assert.equal(deletedBody.tools.find((tool) => tool.name === "recall")?.effective?.timeoutMs, 12_000);
	assert.equal(readToolPolicyConfig({ TOOL_POLICY_PATH: path }).tools.recall, undefined);

	// injections 的 null 同样可删：memoryLight 回 legacy 8000（2026-11-24 补用例）。
	const deletedLight = await app.request("/api/v1/agent/tool-policy", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ injections: { memoryLight: null } }),
	});
	assert.equal(deletedLight.status, 200);
	const deletedLightBody = (await deletedLight.json()) as {
		injections: Array<{
			name: string;
			effective: { timeoutMs: number; onTimeout: string; notify: boolean; source: string };
		}>;
	};
	assert.deepEqual(deletedLightBody.injections[0]?.effective, {
		timeoutMs: 8_000,
		onTimeout: "fail",
		notify: false,
		source: "legacy",
	});
	assert.equal(readToolPolicyConfig({ TOOL_POLICY_PATH: path }).injections.memoryLight, undefined);
});

test("PUT 错误码：未知 / 锁定 / 不可后台 / bad_timeout / bad_notify / bad_request", async () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const app = makeApp(path);
	const call = async (body: unknown) => {
		const response = await app.request("/api/v1/agent/tool-policy", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
		assert.equal(response.status, 400);
		return (await response.json()) as { ok: boolean; error: string; message?: string };
	};
	assert.equal((await call("not-json")).error, "bad_request");
	assert.equal((await call({})).error, "bad_request");
	assert.equal((await call({ tools: { nope: { timeoutMs: 5000 } } })).error, "unknown_tool");
	assert.equal((await call({ groups: { nope: { timeoutMs: 5000 } } })).error, "unknown_group");
	assert.equal((await call({ injections: { nope: { timeoutMs: 5000 } } })).error, "unknown_injection");
	assert.equal((await call({ tools: { write: { timeoutMs: 5000 } } })).error, "tool_locked");
	const background = await call({ tools: { recall: { onTimeout: "background" } } });
	assert.equal(background.error, "on_timeout_unsupported");
	assert.match(background.message ?? "", /后台/);
	assert.equal((await call({ tools: { bash: { timeoutMs: "900" } } })).error, "bad_timeout");
	assert.equal((await call({ tools: { bash: { notify: 1 } } })).error, "bad_notify");
});

test("坏 JSON 文件：按未配置处理，GET 仍能回默认值", async () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const { writeFileSync } = await import("node:fs");
	writeFileSync(path, "{ not json", "utf8");
	const app = makeApp(path);
	const response = await app.request("/api/v1/agent/tool-policy");
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		tools: Array<{ name: string; effective: { timeoutMs: number; source: string } | null }>;
	};
	assert.equal(body.tools.find((tool) => tool.name === "web_search")?.effective?.timeoutMs, 20_000);
});
