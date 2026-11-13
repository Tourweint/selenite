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
	seedDefaultWorkspace,
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

test("默认工作区播种：没设过才落点；已设过不动；off 关掉；换库跑不碰真实主目录", () => {
	const root = tempDir("seed");
	const store = new ProjectsStore(join(root, "projects.sqlite"));
	const savedFlag = process.env.LIFEDIARY_DEFAULT_WORKSPACE;
	const savedDb = process.env.PROJECTS_DB_PATH;
	try {
		// 没设过：播种到 flag 指的目录（目录不存在就建）
		process.env.LIFEDIARY_DEFAULT_WORKSPACE = join(root, "ws");
		delete process.env.PROJECTS_DB_PATH;
		const seeded = seedDefaultWorkspace(store);
		assert.ok(seeded);
		assert.equal(seeded.rootPath, realpathSync(join(root, "ws")));
		assert.ok(existsSync(join(root, "ws")));

		// 已设过：再播种不动用户的选择
		process.env.LIFEDIARY_DEFAULT_WORKSPACE = join(root, "ws2");
		assert.equal(seedDefaultWorkspace(store), null);
		assert.equal(store.getWorkspace()?.rootPath, seeded.rootPath);

		// off / 0 / false：回滚开关，不播种
		const freshOff = new ProjectsStore(join(root, "fresh-off.sqlite"));
		try {
			process.env.LIFEDIARY_DEFAULT_WORKSPACE = "off";
			assert.equal(seedDefaultWorkspace(freshOff), null);
			assert.equal(freshOff.getWorkspace(), null);
		} finally {
			freshOff.close();
		}

		// 换了 PROJECTS_DB_PATH 跑（探针/测试态）又没给 flag：默认不碰真实主目录
		const freshProbe = new ProjectsStore(join(root, "fresh-probe.sqlite"));
		try {
			process.env.LIFEDIARY_DEFAULT_WORKSPACE = "";
			process.env.PROJECTS_DB_PATH = join(root, "explicit.sqlite");
			assert.equal(seedDefaultWorkspace(freshProbe), null);
			assert.equal(freshProbe.getWorkspace(), null);
		} finally {
			freshProbe.close();
		}
	} finally {
		if (savedFlag === undefined) delete process.env.LIFEDIARY_DEFAULT_WORKSPACE;
		else process.env.LIFEDIARY_DEFAULT_WORKSPACE = savedFlag;
		if (savedDb === undefined) delete process.env.PROJECTS_DB_PATH;
		else process.env.PROJECTS_DB_PATH = savedDb;
		store.close();
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

test("派单复核：按名字或 id 都能找到，换工作区后项目仍可用（多根）", () => {
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
			const after = store.resolveForUse("前端");
			assert.equal(after.ok, true, "项目是独立的根，换工作区不影响它");
		} finally {
			rmSync(workspaceA, { recursive: true, force: true });
			rmSync(workspaceB, { recursive: true, force: true });
		}
	});
});

test("项目可以在工作区外、路径可改、归档后可恢复", () => {
	withStore((store) => {
		const workspace = tempDir("ws");
		const outside = tempDir("outside");
		const moved = tempDir("outside-moved");
		try {
			store.setWorkspace(workspace);
			// 不能把工作区根的上层目录登记成项目（包含工作区根，等于把默认目录降级成子目录）
			assert.throws(() => store.proposeProject("工作区上级", resolve(workspace, "..")), ProjectError);
			const proposal = store.proposeProject("外部项目", outside);
			assert.equal(realpathSync(proposal.rootPath), realpathSync(outside));
			const project = store.confirmProposal(proposal.id);
			assert.equal(project.rootPath, realpathSync(outside));

			const usable = store.resolveForUse(project.id);
			assert.equal(usable.ok, true);

			// 改路径：只改登记，磁盘上的旧目录还在
			const updated = store.updateProjectRoot(project.id, moved);
			assert.equal(updated.rootPath, realpathSync(moved));
			assert.equal(existsSync(outside), true);

			// 归档 = 软退场：派单拒绝、当前项目指针清空；恢复后重新可用
			store.setCurrentProject(project.id);
			store.setArchived(project.id, true);
			assert.equal(store.getCurrentProjectId(), null);
			const archived = store.resolveForUse(project.id);
			assert.equal(archived.ok, false);
			if (!archived.ok) assert.match(archived.message, /已归档/);
			store.setArchived(project.id, false);
			const restored = store.resolveForUse(project.id);
			assert.equal(restored.ok, true);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
			rmSync(moved, { recursive: true, force: true });
		}
	});
});

test("回滚开关：PROJECT_OUTSIDE_WORKSPACE=false 恢复单根口径", () => {
	const saved = process.env.PROJECT_OUTSIDE_WORKSPACE;
	process.env.PROJECT_OUTSIDE_WORKSPACE = "false";
	try {
		withStore((store) => {
			const workspace = tempDir("ws");
			const outside = tempDir("outside");
			try {
				store.setWorkspace(workspace);
				assert.throws(() => store.proposeProject("外部项目", outside), ProjectError);
			} finally {
				rmSync(workspace, { recursive: true, force: true });
				rmSync(outside, { recursive: true, force: true });
			}
		});
	} finally {
		if (saved === undefined) delete process.env.PROJECT_OUTSIDE_WORKSPACE;
		else process.env.PROJECT_OUTSIDE_WORKSPACE = saved;
	}
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

// ── 设备活豁免项目前置（2026-11-08 扫尾批 3-H B3）──────────────
// 判别字段先钉死：delegate 入参没有 worker 字段，设备执行体由「明确 targetDevice」
// 与「chancellor 雇员档 CHANCELLOR_EMPLOYEE=phone」两处表达。

test("设备 worker 判别：明确 targetDevice / phone 雇员 / 本机 / auto 回落", async () => {
	const { isDeviceWorkerDelegation } = await import("./tools.ts");
	assert.equal(isDeviceWorkerDelegation({ targetDevice: "device-b" }, {}), true, "明确点名设备 = 设备活");
	assert.equal(isDeviceWorkerDelegation({ targetDevice: "auto" }, {}), false, "auto 落回本机不算设备活");
	assert.equal(isDeviceWorkerDelegation({}, { CHANCELLOR_EMPLOYEE: "phone" }), true, "phone 雇员 = 设备活");
	assert.equal(isDeviceWorkerDelegation({}, { CHANCELLOR_EMPLOYEE: "codebuddy" }), false, "本机 codebuddy 不是设备活");
	assert.equal(isDeviceWorkerDelegation({}, {}), false, "默认 native 不是设备活");
});

/**
 * 真跑一次 delegate 的项目前置：env 由调用方先设好（env-before-import 纪律——
 * `createTools` 在调用那一刻读 env 开关、execute 那一刻读雇员档），回执/工作根都
 * 指临时目录，不碰真实 .data。
 */
async function runProjectGateCase(): Promise<{ output: string; called: number; projectSeen: unknown }> {
	const { createTools } = await import("./tools.ts");
	const { DelegationReceipts } = await import("./delegation-receipts.ts");
	const root = tempDir("device-gate");
	const receipts = new DelegationReceipts(join(root, "delegations.sqlite"));
	let called = 0;
	let projectSeen: unknown = "未调用";
	try {
		const tools = createTools({
			memory: null,
			scopeOf: (id) => ({ type: "session", id: String(id) }) as never,
			projects: null,
			receipts,
			delegateRun: (async (
				request: { requirement: string; project?: unknown },
				options: { onEvent?: (event: never) => void },
			) => {
				called += 1;
				projectSeen = request.project;
				options.onEvent?.({ type: "ticket", ticketId: "T-device", message: "已受理" } as never);
				return { ticketId: "T-device", status: "done", line: "完成", tasks: [] };
			}) as never,
		});
		const delegate = tools.find((tool) => tool.name === "delegate");
		assert.ok(delegate);
		const result = await delegate.execute(
			{ requirement: "打开设置看一眼版本号" } as never,
			{ conversationId: 7201 } as never,
			{} as never,
		);
		const output = (result.output ?? [])
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("");
		return { output, called, projectSeen };
	} finally {
		receipts.close();
		rmSync(root, { recursive: true, force: true });
	}
}

test("设备活豁免项目前置（B3）：设备无项目受理 / 本机仍 needs_project / 开关关后设备也要项目", async () => {
	const base = {
		DELEGATION_PROJECT_REQUIRED: "true",
		DELEGATION_ASYNC: "true",
		// 不存在的临时根即可：domainList 读不到 managers 会自己回落，不碰真实工作区
		CHANCELLOR_WORK_ROOT: join(tmpdir(), "lifediary-device-gate-work"),
	};
	const deviceEnv = { ...base, CHANCELLOR_EMPLOYEE: "phone", DELEGATION_DEVICE_PROJECT_EXEMPT: "true" };
	const localEnv = { ...base, CHANCELLOR_EMPLOYEE: "codebuddy", DELEGATION_DEVICE_PROJECT_EXEMPT: "true" };
	const rollbackEnv = { ...base, CHANCELLOR_EMPLOYEE: "phone", DELEGATION_DEVICE_PROJECT_EXEMPT: "false" };
	const keys = [
		"DELEGATION_PROJECT_REQUIRED",
		"DELEGATION_DEVICE_PROJECT_EXEMPT",
		"DELEGATION_ASYNC",
		"CHANCELLOR_EMPLOYEE",
		"CHANCELLOR_WORK_ROOT",
	];
	const snapshot = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	try {
		// ① 设备活（phone worker）无项目 → 受理，且按无项目单入队（不带 project）
		Object.assign(process.env, deviceEnv);
		const device = await runProjectGateCase();
		assert.doesNotMatch(device.output, /needs_project/, "设备活不该被 needs_project 拦下");
		assert.equal(device.called, 1, "设备活应真的起单");
		assert.equal(device.projectSeen, undefined, "设备活按无项目单受理");

		// ② 本机活（codebuddy）无项目 → 仍 needs_project，且不起 worker
		Object.assign(process.env, localEnv);
		const local = await runProjectGateCase();
		assert.match(local.output, /needs_project/, "本机活仍要项目");
		assert.equal(local.called, 0, "本机活没项目不能起 worker");

		// ③ 回滚开关关 → 设备活也要项目（回到本批前行为）
		Object.assign(process.env, rollbackEnv);
		const rollback = await runProjectGateCase();
		assert.match(rollback.output, /needs_project/, "开关关后设备活也要项目");
		assert.equal(rollback.called, 0, "开关关后设备活没项目不能起 worker");
	} finally {
		for (const key of keys) {
			const value = snapshot[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
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
