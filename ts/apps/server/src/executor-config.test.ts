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
	// 2026-11-19：native 的 providerId 可选；形状不对 400。
	assert.equal(
		parseExecutorInput(
			{
				employee: "native",
				profiles: { native: { model: "cheap", providerId: "bailian" } },
			},
			current,
		).ok,
		true,
	);
	assert.equal(
		parseExecutorInput(
			{ employee: "native", profiles: { native: { providerId: 1 } } },
			current,
		).ok,
		false,
	);
});

test("native 留空 = 跟随默认（2026-11-19 模型分工）：模型 + 供应商路由进建单快照", () => {
	const env = {
		CHANCELLOR_EMPLOYEE: "native",
		EXECUTOR_CONFIG_PATH: tempPath(),
	};
	const out = executorForDelegation(env, {
		currentModel: () => ({ provider: "bailian", modelId: "cheap-fast" }),
		modelRoute: () => ({ baseUrl: "https://provider.example/v1", keyEnv: "PROVIDER_KEY" }),
	});
	assert.deepEqual(out, {
		employee: "native",
		profile: {
			model: "cheap-fast",
			modelRoute: { baseUrl: "https://provider.example/v1", keyEnv: "PROVIDER_KEY" },
		},
	});
});

test("native 显式模型优先于默认；providerId 决定路由", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	writeExecutorConfig(
		{
			employee: "native",
			profiles: {
				native: { model: "work-model", providerId: "other" },
			},
		},
		env,
	);
	let asked: { providerId: string | null; modelId: string } | null = null;
	const out = executorForDelegation(env, {
		currentModel: () => ({ provider: "bailian", modelId: "default-model" }),
		modelRoute: (providerId, modelId) => {
			asked = { providerId, modelId };
			return { baseUrl: "https://other.example/v1", keyEnv: "OTHER_KEY" };
		},
	});
	assert.deepEqual(asked, { providerId: "other", modelId: "work-model" });
	assert.deepEqual(out.profile, {
		model: "work-model",
		modelRoute: { baseUrl: "https://other.example/v1", keyEnv: "OTHER_KEY" },
	});
});

test("EXECUTOR_NATIVE_FOLLOW_DEFAULT=false：native 留空回到启动 env（旧行为）", () => {
	const env = {
		EXECUTOR_CONFIG_PATH: tempPath(),
		EXECUTOR_NATIVE_FOLLOW_DEFAULT: "false",
	};
	// 文件里没有 native 模型 → 不传递任何 model（worker 回落 CHANCELLOR_LLM_MODEL / LLM_MODEL）。
	assert.deepEqual(executorForDelegation(env, {
		currentModel: () => ({ provider: "bailian", modelId: "default-model" }),
	}), { employee: "native", profile: {} });

	// 显式空串仍原样带上：语义是"不做覆盖"。
	writeExecutorConfig({ employee: "native", profiles: { native: { model: "" } } }, env);
	assert.deepEqual(executorForDelegation(env), {
		employee: "native",
		profile: { model: "" },
	});
});

test("native 显式模型找不到供应商：只带模型名（回落启动 env 的地址 / key）", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	writeExecutorConfig(
		{ employee: "native", profiles: { native: { model: "unknown-model" } } },
		env,
	);
	assert.deepEqual(
		executorForDelegation(env, { modelRoute: () => null }),
		{ employee: "native", profile: { model: "unknown-model" } },
	);
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

		// 2026-11-19 模型分工：native 的 providerId 能写能读；空串 = 不保留。
		const putNative = await app.request("/api/v1/agent/executor", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				employee: "native",
				profiles: { native: { model: "cheap", providerId: "bailian" } },
			}),
		});
		assert.equal(putNative.status, 200);
		const nativeView = (await putNative.json()) as {
			profiles: Record<string, { model?: string; providerId?: string }>;
		};
		assert.equal(nativeView.profiles.native.model, "cheap");
		assert.equal(nativeView.profiles.native.providerId, "bailian");

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
		executorSummary("native", { model: "cheap" }),
		"本机内核（pi-durable，模型 cheap）",
	);
	assert.equal(executorSummary("native", {}), "本机内核（pi-durable）");
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

	// native 的三种口径（2026-11-19 模型分工）：跟随默认 / 显式 / 回滚。
	const nativeEnv = { EXECUTOR_CONFIG_PATH: tempPath() };
	writeExecutorConfig({ employee: "native", profiles: { native: { model: "" } } }, nativeEnv);
	assert.match(
		executorLine(nativeEnv, {
			currentModel: () => ({ provider: "bailian", modelId: "cheap" }),
		}),
		/干活模型跟随默认（cheap）/,
	);
	writeExecutorConfig({ employee: "native", profiles: { native: { model: "work" } } }, nativeEnv);
	assert.match(executorLine(nativeEnv), /干活模型 work/);
	writeExecutorConfig({ employee: "native", profiles: { native: { model: "" } } }, nativeEnv);
	assert.match(
		executorLine({ ...nativeEnv, EXECUTOR_NATIVE_FOLLOW_DEFAULT: "false" }),
		/干活模型跟随启动 env/,
	);
});
