import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 记忆管理端点（2026-11-06）：GET / DELETE / POST supersede。
 *
 * 真挂 Hono + 真开记忆库（临时目录，不碰 `.data/`）。env 必须在动态 import
 * `agent.ts` 之前设好——记忆引擎是模块级单例，加载即按 env 建库。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-memory-api-"));
process.env.AGENT_DB_PATH = join(root, "agent.sqlite");
process.env.AGENT_APPROVALS_PATH = join(root, "approvals.json");
process.env.MEMORY_DB_PATH = join(root, "memory.db");
process.env.PROJECTS_DB_PATH = join(root, "projects.sqlite");
process.env.PROVIDERS_PATH = join(root, "providers.json");
process.env.DELEGATIONS_DB_PATH = join(root, "delegations.sqlite");
process.env.AGENT_SSE_SEQ_DB_PATH = join(root, "chat-events.sqlite");
process.env.AGENT_POLICY_PATH = join(root, "policy.json");
process.env.PARTNERS_DB_PATH = join(root, "partners.sqlite");
process.env.PARTNER_HOMES_ROOT = join(root, "partner-homes");
process.env.ROUTINES_STATE_PATH = join(root, "routines.json");
process.env.AUTONOMY_STATE_PATH = join(root, "autonomy-state.json");
process.env.LLM_PROVIDER = "faux";
process.env.MEMORY_ENABLED = "true";
// 端点测试不关心抽取档位；锁定 rule 以免将来默认值变化时这里莫名多打一次模型
process.env.MEMORY_EXTRACT = "rule";
process.env.CHANCELLOR_ENABLED = "false";
process.env.COMPANIONS_ENABLED = "false";

const { Hono } = await import("hono");
const { mountMemoryApi } = await import("./memory-api.ts");
const { memoryEngine } = await import("./agent.ts");

function newApp(enabled = true) {
	const app = new Hono();
	mountMemoryApi(app, { enabled });
	return app;
}

test("记忆端点：列表按 kind 分组，偏好排最前", async () => {
	assert.ok(memoryEngine, "记忆引擎应已按 env 建好");
	memoryEngine.remember({ kind: "episode", scope: { type: "global" }, content: "上周去了杭州" });
	memoryEngine.remember({ kind: "fact", scope: { type: "global" }, content: "住在上海" });
	memoryEngine.remember({
		kind: "preference",
		scope: { type: "global" },
		content: "不喜欢被追问太多\nWhy: 说过会累\nHow: 一次只问一个",
	});

	const response = await newApp().request("/api/v1/agent/memory");
	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		ok: boolean;
		enabled: boolean;
		total: number;
		byKind: Record<string, number>;
		items: Array<{ id: string; kind: string; content: string }>;
	};
	assert.equal(body.ok, true);
	assert.equal(body.enabled, true);
	assert.equal(body.total, 3);
	assert.equal(body.byKind.preference, 1);
	assert.deepEqual(
		body.items.map((item) => item.kind),
		["preference", "fact", "episode"],
		"列表应按 preference → fact → episode 分组",
	);
	assert.ok(body.items[0]!.content.includes("Why:"), "正文应保留 Why/How 段");
});

test("记忆端点：删除是硬删，重复删除 404", async () => {
	const engine = memoryEngine!;
	const record = engine.remember({ kind: "fact", scope: { type: "global" }, content: "待删除的一条" });
	const app = newApp();

	const first = await app.request(`/api/v1/agent/memory/${encodeURIComponent(record.id)}`, {
		method: "DELETE",
	});
	assert.equal(first.status, 200);
	assert.equal(((await first.json()) as { deleted: string }).deleted, record.id);

	const second = await app.request(`/api/v1/agent/memory/${encodeURIComponent(record.id)}`, {
		method: "DELETE",
	});
	assert.equal(second.status, 404);
	assert.equal(((await second.json()) as { error: string }).error, "not_found");
});

test("记忆端点：取代后旧条不再进召回，历史仍可查", async () => {
	const engine = memoryEngine!;
	const old = engine.remember({ kind: "fact", scope: { type: "global" }, content: "我住在北京" });
	const fresh = engine.remember({ kind: "fact", scope: { type: "global" }, content: "我搬到上海了" });
	const app = newApp();

	const response = await app.request(
		`/api/v1/agent/memory/${encodeURIComponent(old.id)}/supersede`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ byId: fresh.id }),
		},
	);
	assert.equal(response.status, 200);
	const body = (await response.json()) as { superseded: string; byId: string };
	assert.equal(body.byId, fresh.id);

	assert.ok(!engine.recall({ text: "北京", scopes: ["global"] }).some((hit) => hit.record.id === old.id));
	assert.ok(engine.list({ scopes: ["global"], includeSuperseded: true }).some((row) => row.id === old.id));
});

test("记忆端点：缺 id / 替代者不存在 / byId 类型不对，各归其位", async () => {
	const engine = memoryEngine!;
	const record = engine.remember({ kind: "fact", scope: { type: "global" }, content: "一条普通事实" });
	const app = newApp();

	const badType = await app.request(
		`/api/v1/agent/memory/${encodeURIComponent(record.id)}/supersede`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ byId: 42 }),
		},
	);
	assert.equal(badType.status, 400);

	const missing = await app.request("/api/v1/agent/memory/不存在的-id/supersede", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	assert.equal(missing.status, 404);
});

test("记忆端点：只有 global 以外的 scope 时不串（session 沉淀不进列表）", async () => {
	const engine = memoryEngine!;
	engine.remember({ kind: "episode", scope: { type: "session", id: "999" }, content: "只在会话里的一条" });
	const response = await newApp().request("/api/v1/agent/memory?scope=global&limit=200");
	const body = (await response.json()) as { items: Array<{ content: string }> };
	assert.ok(
		!body.items.some((item) => item.content.includes("只在会话里的一条")),
		"默认列 global，不应带出 session scope 的记录",
	);
});

test("记忆端点：未启用时三个端点统一 404 memory_disabled", async () => {
	const app = newApp(false);
	const list = await app.request("/api/v1/agent/memory");
	assert.equal(list.status, 404);
	assert.equal(((await list.json()) as { error: string }).error, "memory_disabled");

	const remove = await app.request("/api/v1/agent/memory/any-id", { method: "DELETE" });
	assert.equal(remove.status, 404);

	const supersede = await app.request("/api/v1/agent/memory/any-id/supersede", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	assert.equal(supersede.status, 404);
});
