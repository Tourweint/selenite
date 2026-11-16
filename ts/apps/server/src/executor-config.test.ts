import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import {
	executorConfigEnabled,
	executorForDelegation,
	executorLine,
	executorSummary,
	executorView,
	parseExecutorInput,
	readExecutorConfig,
	writeExecutorConfig,
} from "./executor-config.ts";
import { mountExecutorApi } from "./executor-mount.ts";

function tempPath(): string {
	return join(mkdtempSync(join(tmpdir(), "executor-config-")), "executor.json");
}

test("没有文件：回落 env（执行器 / 模型 / 权限）", () => {
	const env = {
		CHANCELLOR_EMPLOYEE: "codex",
		CHANCELLOR_CODEX_MODEL: "gpt-x",
		CHANCELLOR_CODEX_PERMISSION: "edit",
		EXECUTOR_CONFIG_PATH: tempPath(),
	};
	const config = readExecutorConfig(env);
	assert.equal(config.employee, "codex");
	assert.equal(config.profiles.codex?.model, "gpt-x");
	assert.equal(config.profiles.codex?.permission, "edit");
	assert.equal(executorForDelegation(env).employee, "codex");
});

test("写入后读回：执行器与 profile 生效，且换了默认只影响新单（函数不缓存旧值）", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	writeExecutorConfig(
		{
			employee: "claude-code",
			profiles: { "claude-code": { model: "opus", permission: "read" } },
		},
		env,
	);
	const config = readExecutorConfig(env);
	assert.equal(config.employee, "claude-code");
	assert.equal(config.profiles["claude-code"]?.model, "opus");
	assert.equal(config.profiles["claude-code"]?.permission, "read");
	assert.deepEqual(executorForDelegation(env).profile, {
		model: "opus",
		permission: "read",
	});

	// 文件里显式空串 = 跟随 CLI 自己的配置，不能回落成 env 默认。
	writeExecutorConfig(
		{
			employee: "opencode",
			profiles: { opencode: { model: "", permission: "full" } },
		},
		env,
	);
	const second = executorForDelegation(env);
	assert.equal(second.employee, "opencode");
	assert.equal(second.profile.model, "");
	assert.equal(second.profile.permission, "full");
});

test("EXECUTOR_CONFIG=false：文件存在也不读，一律 env", () => {
	const path = tempPath();
	writeFileSync(
		path,
		JSON.stringify({ employee: "codex", profiles: {} }),
		"utf8",
	);
	const env = {
		EXECUTOR_CONFIG: "false",
		CHANCELLOR_EMPLOYEE: "codebuddy",
		EXECUTOR_CONFIG_PATH: path,
	};
	assert.equal(executorConfigEnabled(env), false);
	const config = readExecutorConfig(env);
	assert.equal(config.employee, "codebuddy");
});

test("PUT 校验：手机/MCP 不可从界面选；权限与模型类型不对 400", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	const current = readExecutorConfig(env);
	assert.equal(parseExecutorInput({ employee: "phone" }, current).ok, false);
	assert.equal(parseExecutorInput({ employee: "codex" }, current).ok, true);
	assert.equal(
		parseExecutorInput(
			{ employee: "codex", profiles: { codex: { permission: "root" } } },
			current,
		).ok,
		false,
	);
	assert.equal(
		parseExecutorInput(
			{ employee: "codex", profiles: { codex: { model: 1 } } },
			current,
		).ok,
		false,
	);
	assert.equal(
		parseExecutorInput(
			{ employee: "codex", profiles: { codex: { model: "gpt", permission: "edit" } } },
			current,
		).ok,
		true,
	);
});

test("native 不往派单里塞 profile（模型由启动 env 决定，2026-11-16 核实）", () => {
	const env = {
		CHANCELLOR_EMPLOYEE: "native",
		EXECUTOR_CONFIG_PATH: tempPath(),
	};
	assert.deepEqual(executorForDelegation(env), { employee: "native", profile: {} });
});

test("批1：native 填了模型 → 进建单快照；留空 → 不带（回落启动 env）", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	writeExecutorConfig(
		{ employee: "native", profiles: { native: { model: "deepseek-v4.1-flash" } } },
		env,
	);
	assert.deepEqual(executorForDelegation(env), {
		employee: "native",
		profile: { model: "deepseek-v4.1-flash" },
	});
	// 留空 = 显式"跟随启动 env"，空串原样带上，native.ts 不做覆盖
	writeExecutorConfig({ employee: "native", profiles: { native: { model: "" } } }, env);
	assert.deepEqual(executorForDelegation(env), { employee: "native", profile: { model: "" } });
});

test("phone 由 env 指定时视图锁定并说明原因", () => {
	const env = {
		CHANCELLOR_EMPLOYEE: "phone",
		EXECUTOR_CONFIG_PATH: tempPath(),
	};
	const view = executorView(env);
	assert.equal(view.employee, "phone");
	assert.equal(view.locked, true);
	assert.match(view.lockedReason ?? "", /CHANCELLOR_EMPLOYEE/);
	// phone 是部署形态，不参与 profiles。
	assert.equal(view.profiles.phone, undefined);
});

test("端点：GET 读当前值，PUT 写文件并返回新视图；非法值 400", async () => {
	const prevPath = process.env.EXECUTOR_CONFIG_PATH;
	const prevEmployee = process.env.CHANCELLOR_EMPLOYEE;
	process.env.EXECUTOR_CONFIG_PATH = tempPath();
	process.env.CHANCELLOR_EMPLOYEE = "codebuddy";
	try {
		const app = new Hono();
		mountExecutorApi(app);

		const get = await app.request("/api/v1/agent/executor");
		assert.equal(get.status, 200);
		const before = (await get.json()) as {
			employee: string;
			kinds: unknown[];
		};
		assert.equal(before.employee, "codebuddy");
		assert.ok(Array.isArray(before.kinds));

		const put = await app.request("/api/v1/agent/executor", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				employee: "codex",
				profiles: { codex: { model: "gpt-x", permission: "edit" } },
			}),
		});
		assert.equal(put.status, 200);
		const after = (await put.json()) as {
			employee: string;
			profiles: Record<string, { model?: string; permission?: string }>;
		};
		assert.equal(after.employee, "codex");
		assert.equal(after.profiles.codex.model, "gpt-x");
		assert.equal(after.profiles.codex.permission, "edit");

		const bad = await app.request("/api/v1/agent/executor", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ employee: "codex", profiles: { codex: { permission: "root" } } }),
		});
		assert.equal(bad.status, 400);
	} finally {
		if (prevPath === undefined) delete process.env.EXECUTOR_CONFIG_PATH;
		else process.env.EXECUTOR_CONFIG_PATH = prevPath;
		if (prevEmployee === undefined) delete process.env.CHANCELLOR_EMPLOYEE;
		else process.env.CHANCELLOR_EMPLOYEE = prevEmployee;
	}
});

test("executorSummary / executorLine：派活的人和用户都能看到执行器/模型/权限", () => {
	assert.equal(
		executorSummary("claude-code", { model: "opus", permission: "full" }),
		"Claude Code（模型 opus，权限 全权）",
	);
	assert.equal(
		executorSummary("codebuddy", { model: "deepseek-v4.1-flash" }),
		"CodeBuddy（模型 deepseek-v4.1-flash，固定全权）",
	);

	const env = {
		EXECUTOR_CONFIG_PATH: tempPath(),
		CHANCELLOR_EMPLOYEE: "codex",
	};
	writeExecutorConfig(
		{ employee: "codex", profiles: { codex: { model: "gpt-x", permission: "edit" } } },
		env,
	);
	const line = executorLine(env);
	assert.match(line, /Codex CLI/);
	assert.match(line, /gpt-x/);
	assert.match(line, /可改/);
	assert.match(line, /派活默认交给/);
	assert.match(line, /换默认只影响新单/);
});
