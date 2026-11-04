import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { test } from "node:test";
import {
	isInside,
	ProjectError,
	ProjectsStore,
	resolveDelegationProject,
	resolveProjectPath,
	validateWorkspaceRoot,
} from "./projects.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `lifediary-${prefix}-`));
}

function withStore(run: (store: ProjectsStore) => void): void {
	const root = tempDir("projects");
	const store = new ProjectsStore(join(root, "projects.sqlite"));
	try {
		run(store);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
}

test("工作区拒绝盘符根、主目录与不存在的路径", () => {
	const driveRoot = parse(resolve(tmpdir())).root;
	assert.throws(() => validateWorkspaceRoot(driveRoot), ProjectError);
	assert.throws(() => validateWorkspaceRoot(homedir()), ProjectError);
	assert.throws(() => validateWorkspaceRoot("relative/path"), ProjectError);
	assert.throws(() => validateWorkspaceRoot(join(tmpdir(), "definitely-not-here-8f7a")), ProjectError);

	const root = tempDir("workspace");
	try {
		// 文件不是目录
		const file = join(root, "file.txt");
		writeFileSync(file, "x");
		assert.throws(() => validateWorkspaceRoot(file), ProjectError);
		assert.equal(validateWorkspaceRoot(root), realpathSync(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("新建项目只提交 proposal，确认后才建目录并登记", () => {
	withStore((store) => {
		const workspace = tempDir("ws");
		try {
			store.setWorkspace(workspace);
			const proposal = store.proposeProject("新工具", "demo");
			assert.equal(proposal.status, "pending");
			assert.equal(existsSync(proposal.rootPath), false, "确认之前不能建目录");

			const project = store.confirmProposal(proposal.id);
			assert.equal(existsSync(project.rootPath), true, "确认后才建目录");
			assert.equal(project.name, "新工具");
			assert.equal(project.vcs, "none");
			assert.equal(project.workspaceId, store.getWorkspace()?.id);

			const confirmed = store.listProposals("confirmed");
			assert.equal(confirmed.length, 1);
			assert.equal(confirmed[0]?.decidedAt !== null, true);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

test("拒绝待确认请求不会建目录", () => {
	withStore((store) => {
		const workspace = tempDir("ws");
		try {
			store.setWorkspace(workspace);
			const proposal = store.proposeProject("不要的项目", "rejected");
			const rejected = store.rejectProposal(proposal.id);
			assert.equal(rejected.status, "rejected");
			assert.equal(existsSync(proposal.rootPath), false);
			assert.equal(store.listProjects().length, 0);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

test("项目路径拒绝绝对路径、.. 与工作区外", () => {
	const root = tempDir("path");
	try {
		assert.throws(() => resolveProjectPath(root, "C:\\elsewhere"), ProjectError);
		assert.throws(() => resolveProjectPath(root, "../escape"), ProjectError);
		assert.throws(() => resolveProjectPath(root, "a/../b"), ProjectError);
		assert.equal(resolveProjectPath(root, "a/b"), join(root, "a", "b"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目内子目录不算新项目，项目名不能重复", () => {
	withStore((store) => {
		const workspace = tempDir("ws");
		try {
			store.setWorkspace(workspace);
			const proposal = store.proposeProject("主项目", "main");
			store.confirmProposal(proposal.id);

			assert.throws(() => store.proposeProject("主项目副本", "main/sub"), ProjectError);
			assert.throws(() => store.proposeProject("主项目", "another"), ProjectError);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

test("派单复核：按名字或 id 都能找到，工作区变更后拒绝", () => {
	withStore((store) => {
		const workspaceA = tempDir("ws-a");
		const workspaceB = tempDir("ws-b");
		try {
			store.setWorkspace(workspaceA);
			const proposal = store.proposeProject("前端", "frontend");
			const project = store.confirmProposal(proposal.id);

			const byName = store.resolveForUse("前端");
			assert.equal(byName.ok, true);
			if (byName.ok) assert.equal(byName.project.id, project.id);

			const byId = store.resolveForUse(project.id);
			assert.equal(byId.ok, true);
			if (byId.ok) assert.equal(byId.project.rootPath, resolve(project.rootPath));

			store.setWorkspace(workspaceB);
			const outside = store.resolveForUse("前端");
			assert.equal(outside.ok, false);
			if (!outside.ok) assert.match(outside.message, /不在当前工作区/);
		} finally {
			rmSync(workspaceA, { recursive: true, force: true });
			rmSync(workspaceB, { recursive: true, force: true });
		}
	});
});

test("delegate 没有项目时返回 needs_project 与项目清单", () => {
	withStore((store) => {
		const workspace = tempDir("ws");
		try {
			store.setWorkspace(workspace);
			const gate = resolveDelegationProject(undefined, store);
			assert.equal(gate.ok, false);
			if (gate.ok) return;
			const payload = JSON.parse(gate.text) as {
				error: string;
				projects: Array<{ name: string }>;
			};
			assert.equal(payload.error, "needs_project");
			assert.deepEqual(payload.projects, []);

			// 登记表不可用时也不能放行
			const missing = resolveDelegationProject("前端", null);
			assert.equal(missing.ok, false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

test("delegate 工具在没有项目时返回 needs_project，且不调用 runner", async () => {
	const { createTools } = await import("./tools.ts");
	let called = 0;
	const tools = createTools({
		memory: null,
		scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
		delegateRun: (async () => {
			called += 1;
			throw new Error("不该跑到执行");
		}) as never,
		projects: null,
	});
	const delegate = tools.find((tool) => tool.name === "delegate");
	assert.ok(delegate, "delegate 工具应该在");
	const result = await delegate.execute(
		{ requirement: "写一个文件" } as never,
		{ conversationId: 7001 } as never,
		{} as never,
	);
	const output = (result.output ?? [])
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("");
	assert.match(output, /needs_project/);
	assert.equal(called, 0, "没有项目不能起 worker");
});

test("propose_project 工具只提交待确认请求", async () => {
	const { createTools } = await import("./tools.ts");
	const root = tempDir("propose-tool");
	const workspace = tempDir("ws");
	const store = new ProjectsStore(join(root, "projects.sqlite"));
	try {
		store.setWorkspace(workspace);
		const tools = createTools({
			memory: null,
			scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
			projects: store,
		});
		const propose = tools.find((tool) => tool.name === "propose_project");
		assert.ok(propose, "propose_project 工具应该在");
		const result = await propose.execute(
			{ name: "新项目", path: "new" } as never,
			{ conversationId: 7002 } as never,
			{} as never,
		);
		const output = (result.output ?? [])
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("");
		const payload = JSON.parse(output) as { ok: boolean; proposalId: string };
		assert.equal(payload.ok, true);
		assert.equal(existsSync(join(workspace, "new")), false, "确认之前不能建目录");
		assert.equal(store.listProposals("pending").length, 1);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("符号链接逃逸在提交时就被 realpath 拦住", (t) => {
	const root = tempDir("symlink");
	const workspace = join(root, "ws");
	const outside = join(root, "outside");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(outside, { recursive: true });
	const link = join(workspace, "link-out");
	try {
		if (process.platform === "win32") {
			symlinkSync(outside, link, "junction");
		} else {
			symlinkSync(outside, link, "dir");
		}
	} catch {
		t.skip("当前环境不允许建目录符号链接");
		return;
	}

	const store = new ProjectsStore(join(root, "projects.sqlite"));
	try {
		store.setWorkspace(workspace);
		// 直接拿符号链接当项目根：提交时就该被 realpath 拦住。
		assert.throws(() => store.proposeProject("逃逸", "link-out"), ProjectError);

		// 更隐蔽的一种：在链接后面再建子目录。提交阶段就该拦住，
		// 不能等 mkdir 先把 outside/newdir 建出来。
		assert.throws(() => store.proposeProject("逃逸子目录", "link-out/newdir"), ProjectError);
		assert.equal(existsSync(join(outside, "newdir")), false);
		assert.equal(store.listProjects().length, 0);
		assert.equal(isInside(workspace, outside), false);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
