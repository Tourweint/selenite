import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 记忆 scope 迁移与孤儿可见性（2026-11-17 项目合并与记忆迁移）。
 *
 * 真挂 Hono + 真开记忆库/项目库（临时目录，不碰 `.data/`）。
 * env 必须在动态 import `agent.ts` 之前设好——记忆引擎是模块级单例。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-scope-move-"));
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
process.env.LLM_PROVIDER = "faux";
process.env.MEMORY_ENABLED = "true";
process.env.MEMORY_EXTRACT = "rule";
process.env.CHANCELLOR_ENABLED = "false";
process.env.COMPANIONS_ENABLED = "false";

const { Hono } = await import("hono");
const { mountMemoryApi } = await import("./memory-api.ts");
const { memoryEngine } = await import("./agent.ts");
const { projectsStore } = await import("./projects.ts");

function newApp() {
	const app = new Hono();
	mountMemoryApi(app, { enabled: true });
	return app;
}

/** 建一个真项目（项目库 + 目录），返回项目 id。 */
function createProject(name: string): string {
	const store = projectsStore();
	const workspace = join(root, "ws");
	mkdirSync(workspace, { recursive: true });
	if (!store.getWorkspace()) store.setWorkspace(workspace);
	const proposal = store.proposeProject(name, name);
	return store.confirmProposal(proposal.id).id;
}

function rememberProject(projectId: string, content: string) {
	assert.ok(memoryEngine);
	return memoryEngine.remember({
		kind: "fact",
		scope: { type: "project", id: projectId },
		content,
	});
}

test("moveScope：记忆与原文档案一起搬，取代引用与搜索仍成立", () => {
	assert.ok(memoryEngine);
	const from = "project:11111111-1111-4111-8111-111111111111";
	const to = "global";
	const kept = memoryEngine.remember({ kind: "fact", scope: { type: "project", id: "11111111-1111-4111-8111-111111111111" }, content: "搬到全局的旧事实" });
	const dropped = memoryEngine.remember({ kind: "fact", scope: { type: "project", id: "11111111-1111-4111-8111-111111111111" }, content: "被取代的那条" });
	// 取代链：dropped --supersededBy--> kept
	memoryEngine.supersede(dropped.id, kept.id);
	memoryEngine.putDocument({
		id: "doc-move-1",
		scope: from,
		title: "原文档案",
		content: "一份长原文",
		source: "test",
		sourceRef: null,
		sha256: null,
		chars: 5,
		createdAt: new Date().toISOString(),
		updatedAt: null,
	});

	const moved = memoryEngine.moveScope(from, to);
	assert.equal(moved.records, 2);
	assert.equal(moved.documents, 1);
	assert.equal(memoryEngine.listScopes().includes(from), false, "源 scope 应该空了");
	const after = memoryEngine.getRecord(kept.id);
	assert.equal(after?.scope, to);
	assert.equal(memoryEngine.getRecord(dropped.id)?.supersededBy, kept.id, "取代引用是记录 id，搬家后仍有效");
	assert.equal(memoryEngine.getDocument("doc-move-1")?.scope, to);
	// FTS 镜像只存 content / content_id，搬家不影响关键词检索
	const hits = memoryEngine.browse({ scopes: [to], q: "搬到全局" }).items;
	assert.equal(hits.length, 1);
});

test("archiveScope：只写 archived_at，行还在（可再被 move 取走）", () => {
	assert.ok(memoryEngine);
	const projectId = "22222222-2222-4222-8222-222222222222";
	const record = rememberProject(projectId, "要被封存的记忆");
	const archived = memoryEngine.archiveScope(`project:${projectId}`);
	assert.equal(archived, 1);
	assert.equal(memoryEngine.getRecord(record.id)?.archivedAt !== null, true);
	// 默认列表看不到，但 scope 仍在（listScopes 不按 archived 过滤）
	assert.equal(memoryEngine.browse({ scopes: [`project:${projectId}`] }).total, 0);
	assert.equal(memoryEngine.listScopes().includes(`project:${projectId}`), true);
});

test("孤儿 scope：登记项目删了，记忆在 /memory/scopes 里仍然可见", async () => {
	const projectId = createProject("orphan-demo");
	rememberProject(projectId, "这个项目马上要被删登记");
	projectsStore().deleteProject(projectId);

	const response = await newApp().request("/api/v1/agent/memory/scopes");
	assert.equal(response.status, 200);
	const data = (await response.json()) as {
		scopes: Array<{ scope: string; label: string; count: number; kind: string }>;
	};
	const orphan = data.scopes.find((row) => row.scope === `project:${projectId}`);
	assert.ok(orphan, "孤儿 scope 必须出现在清单里");
	assert.equal(orphan.kind, "orphan");
	assert.match(orphan.label, /^已删除的项目 · /);
	assert.ok(orphan.count >= 1);
});

test("POST /memory/scope/move：迁移成功、目标项目必须已登记、空源拒绝", async () => {
	const projectId = createProject("move-target");
	const orphanId = "33333333-3333-4333-8333-333333333333";
	rememberProject(orphanId, "孤儿记忆搬到活项目");
	const orphanScope = `project:${orphanId}`;

	// 目标未登记 → 400 unknown_project
	let response = await newApp().request("/api/v1/agent/memory/scope/move", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: orphanScope, to: "project:99999999-9999-4999-8999-999999999999" }),
	});
	assert.equal(response.status, 400);
	assert.equal(((await response.json()) as { error: string }).error, "unknown_project");

	// 自己搬自己 → 400
	response = await newApp().request("/api/v1/agent/memory/scope/move", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: orphanScope, to: orphanScope }),
	});
	assert.equal(response.status, 400);

	// 空源 → 400 empty_source
	response = await newApp().request("/api/v1/agent/memory/scope/move", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: "project:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", to: `project:${projectId}` }),
	});
	assert.equal(response.status, 400);
	assert.equal(((await response.json()) as { error: string }).error, "empty_source");

	// 正常 → 200，记忆进了目标项目
	response = await newApp().request("/api/v1/agent/memory/scope/move", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: orphanScope, to: `project:${projectId}` }),
	});
	assert.equal(response.status, 200);
	const moved = (await response.json()) as { records: number };
	assert.equal(moved.records, 1);
	assert.equal(memoryEngine!.listScopes().includes(orphanScope), false);
	assert.ok(memoryEngine!.listScopes().includes(`project:${projectId}`));
});

test("MEMORY_SCOPE_MOVE=false：迁移端点 404（一行回滚）", async () => {
	process.env.MEMORY_SCOPE_MOVE = "false";
	try {
		const response = await newApp().request("/api/v1/agent/memory/scope/move", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ from: "global", to: "global" }),
		});
		assert.equal(response.status, 404);
	} finally {
		delete process.env.MEMORY_SCOPE_MOVE;
	}
});
