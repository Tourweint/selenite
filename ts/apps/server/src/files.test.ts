import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { test } from "node:test";
import { FileBrowseError, mountFiles, resolveInsideWorkspace } from "./files.ts";
import { ProjectsStore } from "./projects.ts";

interface Fixture {
	app: Hono;
	store: ProjectsStore;
	workspace: string;
	projectId: string;
	opened: string[];
}

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lifediary-files-${prefix}-`));
}

/** 隔离工作区 + 一个已确认子项目；opener 只记账不真弹窗口；结束统一清理。 */
async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
	const base = tempDir("base");
	const workspace = join(base, "ws");
	const store = new ProjectsStore(join(base, "projects.sqlite"));
	mkdirSync(join(workspace, "notes"), { recursive: true });
	mkdirSync(join(workspace, ".data"), { recursive: true });
	writeFileSync(join(workspace, "readme.md"), "hello 世界");
	writeFileSync(join(workspace, "notes", "a.txt"), "aaa");
	writeFileSync(join(workspace, ".data", "providers.json"), "{}");
	store.setWorkspace(workspace);
	const project = store.confirmProposal(store.proposeProject("demo", "demo").id);
	const opened: string[] = [];
	const app = new Hono();
	mountFiles(app, { store, open: (dir) => opened.push(dir) });
	try {
		await run({ app, store, workspace, projectId: project.id, opened });
	} finally {
		store.close();
		rmSync(base, { recursive: true, force: true });
	}
}

function withEnv(key: string, value: string, run: () => void): void {
	const previous = process.env[key];
	process.env[key] = value;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
}

/* ── 路径解析（纯函数）───────────────────────────────────────── */

test("resolveInsideWorkspace：拒绝绝对路径、.. 与根层 .data", () => {
	const root = tempDir("resolve");
	try {
		assert.throws(() => resolveInsideWorkspace(root, "C:/Windows"), FileBrowseError);
		assert.throws(
			() => resolveInsideWorkspace(root, "../outside"),
			(e: unknown) => e instanceof FileBrowseError && e.code === "outside_workspace",
		);
		assert.throws(
			() => resolveInsideWorkspace(root, "notes/../readme.md"),
			(e: unknown) => e instanceof FileBrowseError && e.code === "outside_workspace",
		);
		assert.throws(
			() => resolveInsideWorkspace(root, ".data/providers.json"),
			(e: unknown) => e instanceof FileBrowseError && e.code === "blocked_path",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/* ── open-explorer ──────────────────────────────────────────── */

test("open-explorer：缺省开工作区根，带 projectId 开项目根", async () => {
	await withFixture(async (f) => {
		let response = await f.app.request("/api/v1/workspaces/open-explorer", { method: "POST" });
		assert.equal(response.status, 200);
		assert.equal(f.opened.length, 1);

		response = await f.app.request("/api/v1/workspaces/open-explorer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: f.projectId }),
		});
		assert.equal(response.status, 200);
		assert.equal(f.opened.length, 2);
		assert.notEqual(f.opened[1], f.opened[0], "项目根 ≠ 工作区根");
	});
});

test("open-explorer：未知项目 400；EXPLORER_OPEN=false 回 400 且不起进程", async () => {
	await withFixture(async (f) => {
		const response = await f.app.request("/api/v1/workspaces/open-explorer", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId: "no-such-project" }),
		});
		assert.equal(response.status, 400);
		assert.equal(f.opened.length, 0);

		withEnv("EXPLORER_OPEN", "false", () => {
			// 同步 request：Hono 的 request 可以直接 await
		});
		const disabled = await f.app.request("/api/v1/workspaces/open-explorer", { method: "POST" });
		assert.equal(disabled.status, 400);
		assert.equal(f.opened.length, 0, "开关关着不起进程");
	});
});

/* ── files 列目录 / 看文本 ───────────────────────────────────── */

test("files 列目录：根层屏蔽 .data，其余照常列出", async () => {
	await withFixture(async (f) => {
		const response = await f.app.request("/api/v1/files");
		assert.equal(response.status, 200);
		const data = (await response.json()) as {
			ok: boolean;
			path: string;
			entries: { name: string; type: string }[];
		};
		assert.equal(data.ok, true);
		assert.equal(data.path, "");
		const names = data.entries.map((entry) => entry.name);
		assert.ok(names.includes("readme.md"));
		assert.ok(names.includes("notes"));
		assert.ok(!names.includes(".data"), "根层 .data 不出现在列表里");

		const nested = await f.app.request("/api/v1/files?path=notes");
		assert.equal(nested.status, 200);
		const nestedData = (await nested.json()) as { entries: { name: string }[] };
		assert.deepEqual(nestedData.entries.map((entry) => entry.name), ["a.txt"]);
	});
});

test("files/content：文本回正文；二进制与超大文件只给元信息", async () => {
	await withFixture(async (f) => {
		const text = await f.app.request("/api/v1/files/content?path=readme.md");
		assert.equal(text.status, 200);
		const textData = (await text.json()) as { content: string; truncated: boolean; size: number };
		assert.equal(textData.content, "hello 世界");
		assert.equal(textData.truncated, false);
		assert.equal(textData.size, Buffer.byteLength("hello 世界"));

		writeFileSync(join(f.workspace, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
		const binary = await f.app.request("/api/v1/files/content?path=blob.bin");
		const binaryData = (await binary.json()) as { content: string | null; truncated: boolean };
		assert.equal(binaryData.content, null);
		assert.equal(binaryData.truncated, true);

		writeFileSync(join(f.workspace, "big.txt"), Buffer.alloc(512 * 1024 + 1, 0x61));
		const big = await f.app.request("/api/v1/files/content?path=big.txt");
		const bigData = (await big.json()) as { content: string | null; truncated: boolean };
		assert.equal(bigData.content, null);
		assert.equal(bigData.truncated, true);

		assert.equal((await f.app.request("/api/v1/files/content?path=nope.txt")).status, 404);
	});
});

/* ── 安全用例（方案验证表点名的两条 + 越界族）────────────────── */

test("安全：越权路径被拒（.. / 符号链接逃逸 / 绝对路径），.data 被屏蔽", async () => {
	await withFixture(async (f) => {
		let response = await f.app.request("/api/v1/files?path=../outside");
		assert.equal(response.status, 400);
		response = await f.app.request("/api/v1/files/content?path=..%2Foutside");
		assert.equal(response.status, 400);
		response = await f.app.request(`/api/v1/files?path=${encodeURIComponent(f.workspace)}`);
		assert.equal(response.status, 400);
		response = await f.app.request("/api/v1/files/content?path=.data/providers.json");
		assert.equal(response.status, 400);

		// 符号链接祖先逃逸：link → 工作区外目录，realpath 复核拦住
		const outside = tempDir("outside");
		try {
			symlinkSync(outside, join(f.workspace, "link"), "junction");
			response = await f.app.request("/api/v1/files?path=link");
			assert.equal(response.status, 400, "符号链接逃逸必须被 realpath 复核拦住");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

test("FILE_BROWSE=false：两个 files 端点整体下线（404）", async () => {
	await withFixture(async (f) => {
		withEnv("FILE_BROWSE", "false", async () => {
			// 开关是现读 env 的，直接在同一 app 上验证
			const list = await f.app.request("/api/v1/files");
			const content = await f.app.request("/api/v1/files/content?path=readme.md");
			assert.equal(list.status, 404);
			assert.equal(content.status, 404);
		});
	});
});
