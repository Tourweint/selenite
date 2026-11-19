/**
 * 会话工作归属纯投影（2026-11-18）——不启动 durable，只测 resolveChatWorkdir。
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveChatWorkdir } from "./chat-workdir.ts";

const workspace = resolve("/workspaces/main");
const projectRoot = resolve("/projects/lifediary-harness");
const custom = resolve("/projects/other-folder");
const project = { id: "p-1", name: "lifediary-harness", rootPath: projectRoot };

test("绑了项目 + 有 cwd：项目名优先，path 用会话快照", () => {
	assert.deepEqual(
		resolveChatWorkdir({ cwd: projectRoot, project, workspaceRoot: workspace }),
		{
			kind: "project",
			name: "lifediary-harness",
			path: projectRoot,
			projectId: "p-1",
		},
	);
});

test("绑了项目但 durable 没有 cwd：path 回项目主文件夹", () => {
	assert.equal(
		resolveChatWorkdir({ cwd: null, project, workspaceRoot: workspace })?.path,
		projectRoot,
	);
});

test("没绑项目、cwd 就是主工作区：workspace", () => {
	assert.deepEqual(resolveChatWorkdir({ cwd: workspace, project: null, workspaceRoot: workspace }), {
		kind: "workspace",
		name: "工作区",
		path: workspace,
	});
});

test("只选了目录、没绑项目：dir，名称取 basename", () => {
	const result = resolveChatWorkdir({ cwd: custom, project: null, workspaceRoot: workspace });
	assert.equal(result?.kind, "dir");
	assert.equal(result?.name, "other-folder");
	assert.equal(result?.path, custom);
});

test("项目已删（project=null）但映射还在：不编项目名，落到目录", () => {
	const result = resolveChatWorkdir({ cwd: projectRoot, project: null, workspaceRoot: workspace });
	assert.equal(result?.kind, "dir");
	assert.equal(result?.name, "lifediary-harness");
});

test("没有 cwd、也没有项目：主工作区兜底", () => {
	assert.deepEqual(resolveChatWorkdir({ cwd: null, project: null, workspaceRoot: workspace }), {
		kind: "workspace",
		name: "工作区",
		path: workspace,
	});
});

test("什么都没有：不显示", () => {
	assert.equal(resolveChatWorkdir({ cwd: null, project: null, workspaceRoot: null }), null);
});

test("cwd 末尾斜杠不影响工作区判定（samePath 归一）", () => {
	assert.equal(
		resolveChatWorkdir({ cwd: `${workspace}/`, project: null, workspaceRoot: workspace })?.kind,
		"workspace",
	);
});
