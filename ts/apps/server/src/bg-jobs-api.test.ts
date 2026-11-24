import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { mountBgJobs } from "./bg-jobs-api.ts";
import type { BgJobRecord } from "./bash-background.ts";

/**
 * 后台任务管理面（2026-11-24 M2 generalize）：
 * 挂载条件放宽后的列表投影 / `?conversationId=` 过滤 / 参数校验。
 * 落点用临时目录，不碰真实 `.data/bg-jobs`。
 */

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lh-bg-jobs-api-"));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeIndex(dir: string, records: BgJobRecord[]): void {
	writeFileSync(join(dir, "index.json"), JSON.stringify(records), "utf8");
}

test("开关都关：整组不挂（404）", async () => {
	const dir = tempDir();
	const app = new Hono();
	mountBgJobs(app, { enabled: () => false, dir: () => dir });
	const response = await app.request("/api/v1/agent/bg-jobs");
	assert.equal(response.status, 404, "路由不存在 → Hono 默认 404");
});

test("列表：带 tool / kind / conversationId；?conversationId= 只回该会话", async () => {
	const dir = tempDir();
	writeIndex(dir, [
		{
			id: "bg-old-111111",
			commandSummary: "old",
			startedAt: "2026-11-24T00:00:00.000Z",
			endedAt: "2026-11-24T00:01:00.000Z",
			exitCode: 0,
			status: "done",
		},
		{
			id: "bg-new-222222",
			commandSummary: "new",
			startedAt: "2026-11-24T00:02:00.000Z",
			status: "running",
			kind: "shell",
			tool: "powershell",
			conversationId: 7,
		},
	]);
	const app = new Hono();
	mountBgJobs(app, { enabled: () => true, dir: () => dir });

	const all = (await (await app.request("/api/v1/agent/bg-jobs")).json()) as {
		ok: boolean;
		limit: number;
		jobs: Array<Record<string, unknown>>;
	};
	assert.equal(all.ok, true);
	assert.equal(all.limit, 200);
	assert.equal(all.jobs.length, 2);
	const old = all.jobs.find((job) => job.id === "bg-old-111111")!;
	assert.deepEqual(
		{ kind: old.kind, tool: old.tool, conversationId: old.conversationId },
		{ kind: "shell", tool: null, conversationId: null },
		"旧记录缺省 kind=shell，其余 null",
	);
	const fresh = all.jobs.find((job) => job.id === "bg-new-222222")!;
	assert.deepEqual(
		{ kind: fresh.kind, tool: fresh.tool, conversationId: fresh.conversationId },
		{ kind: "shell", tool: "powershell", conversationId: 7 },
	);

	const filtered = (await (
		await app.request("/api/v1/agent/bg-jobs?conversationId=7")
	).json()) as { jobs: Array<{ id: string }> };
	assert.deepEqual(filtered.jobs.map((job) => job.id), ["bg-new-222222"]);

	const none = (await (
		await app.request("/api/v1/agent/bg-jobs?conversationId=999")
	).json()) as { jobs: unknown[] };
	assert.deepEqual(none.jobs, []);

	const bad = await app.request("/api/v1/agent/bg-jobs?conversationId=abc");
	assert.equal(bad.status, 400);
	const badBody = (await bad.json()) as { error: string };
	assert.equal(badBody.error, "bad_request");
});
