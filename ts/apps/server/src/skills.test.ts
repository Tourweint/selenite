import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { mountSkills, SKILL_SLOT_LIMIT } from "./skills-api.ts";
import { resolveSkillsDir } from "./skills.ts";

/**
 * 技能管理（2026-11-08 扫尾批 9-S）单测。
 *
 * 两段：
 *   1. 目录解析优先级：env 显式 → 用户目录（自动建）→ 应用目录兜底；
 *   2. 端点 CRUD 与边界：名字白名单、64KB 上限、两行结构、越界（含符号链接）拒绝。
 *
 * 全部落在系统临时目录，跑完即删；不碰真实 `.data` 与用户主目录。
 */

let root = "";
test.before(() => {
	root = mkdtempSync(join(tmpdir(), "lifediary-skills-"));
});
test.after(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

function freshDir(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("resolveSkillsDir：AGENT_SKILLS_DIR 显式最高优先，且不替用户建目录", () => {
	const envDir = join(root, "env-skills");
	const result = resolveSkillsDir({
		env: { AGENT_SKILLS_DIR: envDir, USERPROFILE: join(root, "home-env") },
	});
	assert.deepEqual(result, { dir: envDir, origin: "env" });
	assert.equal(existsSync(envDir), false, "显式目录不存在时不该被自动创建");
});

test("resolveSkillsDir：无显式配置时落用户目录，并首次访问自动建目录", () => {
	const home = join(root, "home-user");
	const result = resolveSkillsDir({ env: {}, home });
	assert.equal(result.origin, "user");
	assert.equal(result.dir, join(home, ".lifediary", "skills"));
	assert.equal(existsSync(result.dir), true, "用户目录应被自动创建");
});

test("resolveSkillsDir：用户目录建不出来时回落应用目录", () => {
	// 用文件冒充主目录：join(file, ".lifediary", "skills") 的 mkdir 必然失败（ENOTDIR/EEXIST）
	const blocker = join(root, "home-blocked");
	writeFileSync(blocker, "not a directory");
	const appDir = join(root, "app-skills");
	const result = resolveSkillsDir({ env: {}, home: blocker, appDir });
	assert.equal(result.origin, "app");
	assert.equal(result.dir, appDir);
});

function apiApp(dir: string) {
	const app = new Hono();
	mountSkills(app, { resolve: () => ({ dir, origin: "user" }), enabled: true });
	return app;
}

async function json(response: Response) {
	return (await response.json()) as Record<string, unknown>;
}

const put = (app: Hono, name: string, content: unknown) =>
	app.request(`/api/v1/agent/skills/${name}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content }),
	});

test("技能端点：列表 → 新建 → 读 → 覆盖 → 删除 全链路", async () => {
	const dir = freshDir("api-crud");
	const app = apiApp(dir);

	const empty = await app.request("/api/v1/agent/skills");
	assert.equal(empty.status, 200);
	const emptyBody = await json(empty);
	assert.equal(emptyBody.ok, true);
	assert.equal(emptyBody.dir, dir);
	assert.equal(emptyBody.origin, "user");
	assert.deepEqual(emptyBody.items, []);

	const created = await put(app, "daily-brief", "每天早上的简报流程\n按项目分组列出变化。");
	assert.equal(created.status, 200);
	const createdBody = await json(created);
	assert.equal(createdBody.created, true);
	const file = join(dir, "daily-brief.md");
	assert.equal(readFileSync(file, "utf8"), "每天早上的简报流程\n按项目分组列出变化。");

	const list = await json(await app.request("/api/v1/agent/skills"));
	const items = list.items as { name: string; summary: string; size: number; updatedAt: string }[];
	assert.equal(items.length, 1);
	assert.equal(items[0]?.name, "daily-brief");
	assert.equal(items[0]?.summary, "每天早上的简报流程");
	assert.ok((items[0]?.size ?? 0) > 0);
	assert.ok(Number.isFinite(Date.parse(String(items[0]?.updatedAt))));

	const one = await json(await app.request("/api/v1/agent/skills/daily-brief"));
	assert.equal(one.content, "每天早上的简报流程\n按项目分组列出变化。");

	const updated = await json(await put(app, "daily-brief", "新的摘要\n新的正文"));
	assert.equal(updated.created, false);
	assert.equal(readFileSync(file, "utf8"), "新的摘要\n新的正文");

	const removed = await app.request("/api/v1/agent/skills/daily-brief", { method: "DELETE" });
	assert.equal(removed.status, 200);
	assert.equal((await app.request("/api/v1/agent/skills/daily-brief")).status, 404);
	assert.equal((await app.request("/api/v1/agent/skills/daily-brief", { method: "DELETE" })).status, 404);
});

test("技能端点：名字白名单与正文结构/大小校验", async () => {
	const app = apiApp(freshDir("api-bounds"));

	for (const name of ["Upper", "-lead", "_lead", "with%20space", "..%2Fescape"]) {
		const response = await put(app, name, "摘要\n正文");
		assert.equal(response.status, 400, `${name} 应被名字白名单拒绝`);
	}

	assert.equal((await put(app, "one-line", "只有一行摘要")).status, 400, "没有正文的技能不该落盘");
	assert.equal((await put(app, "empty", "   \n  ")).status, 400);
	assert.equal((await put(app, "huge", `${"a".repeat(SKILL_SLOT_LIMIT)}\n正文`)).status, 400);
	assert.equal((await app.request("/api/v1/agent/skills/ok", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content: 123 }),
	})).status, 400);
});

test("技能端点：目录内符号链接指向外部时读写一律 400", async (t) => {
	const dir = freshDir("api-symlink");
	const outside = join(root, "outside-secret.md");
	writeFileSync(outside, "外面的文件\n不该被读到");
	try {
		symlinkSync(outside, join(dir, "evil.md"));
	} catch {
		t.skip("当前系统不允许创建符号链接（Windows 需开发者模式）");
		return;
	}
	const app = apiApp(dir);
	assert.equal((await app.request("/api/v1/agent/skills/evil")).status, 400);
	const list = await json(await app.request("/api/v1/agent/skills"));
	assert.deepEqual(list.items, [], "越界的符号链接不该出现在管理列表里");
});
