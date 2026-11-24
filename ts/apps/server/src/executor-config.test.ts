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
	// 2026-11-19：本机池的 providerId 可选；形状不对 400。
	assert.equal(
		parseExecutorInput(
			{
				employee: "pool",
				profiles: { pool: { model: "cheap", providerId: "bailian" } },
			},
			current,
		).ok,
		true,
	);
	assert.equal(
		parseExecutorInput(
			{ employee: "pool", profiles: { pool: { providerId: 1 } } },
			current,
		).ok,
		false,
	);
});

test("本机池留空 = 跟随默认（2026-11-19 模型分工）：模型 + 供应商路由进建单快照", () => {
	const env = {
		CHANCELLOR_EMPLOYEE: "pool",
		EXECUTOR_CONFIG_PATH: tempPath(),
	};
	const out = executorForDelegation(env, {
		currentModel: () => ({ provider: "bailian", modelId: "cheap-fast" }),
		modelRoute: () => ({ baseUrl: "https://provider.example/v1", keyEnv: "PROVIDER_KEY" }),
	});
	assert.deepEqual(out, {
		employee: "pool",
		profile: {
			model: "cheap-fast",
			modelRoute: { baseUrl: "https://provider.example/v1", keyEnv: "PROVIDER_KEY" },
		},
	});
});

test("本机池显式模型优先于默认；providerId 决定路由", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	writeExecutorConfig(
		{
			employee: "pool",
			profiles: {
				pool: { model: "work-model", providerId: "other" },
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

test("EXECUTOR_NATIVE_FOLLOW_DEFAULT=false：池留空回到启动 env（旧行为）", () => {
	const env = {
		EXECUTOR_CONFIG_PATH: tempPath(),
		EXECUTOR_NATIVE_FOLLOW_DEFAULT: "false",
	};
	assert.deepEqual(executorForDelegation(env, {
		currentModel: () => ({ provider: "bailian", modelId: "default-model" }),
	}), { employee: "pool", profile: {} });

	// 2026-11-23：native 退役；历史 env 值映射到 pool，不再有第二套运行时。
	assert.deepEqual(executorForDelegation(
		{ ...env, CHANCELLOR_EMPLOYEE: "native" },
		{ currentModel: () => ({ provider: "bailian", modelId: "default-model" }) },
	), { employee: "pool", profile: {} });

	// 显式空串仍原样带上：语义是"不做覆盖"。
	writeExecutorConfig({ employee: "pool", profiles: { pool: { model: "" } } }, env);
	assert.deepEqual(executorForDelegation(env), {
		employee: "pool",
		profile: { model: "" },
	});
});

test("老配置迁移：employee/profiles 里的 native 读成 pool，设置不丢", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	// 直接写一份旧形状（2026-11-23 之前可能落盘的文件）。
	writeFileSync(
		env.EXECUTOR_CONFIG_PATH,
		JSON.stringify({
			employee: "native",
			profiles: { native: { model: "work-model", providerId: "other" } },
		}),
		"utf8",
	);
	const config = readExecutorConfig(env);
	assert.equal(config.employee, "pool");
	assert.deepEqual(config.profiles.pool, { model: "work-model", providerId: "other" });

	// 显式 pool 存在时优先于旧 native 段。
	writeFileSync(
		env.EXECUTOR_CONFIG_PATH,
		JSON.stringify({
			employee: "native",
			profiles: {
				native: { model: "old" },
				pool: { model: "new" },
			},
		}),
		"utf8",
	);
	assert.deepEqual(readExecutorConfig(env).profiles.pool, { model: "new" });
});

test("本机池显式模型找不到供应商：只带模型名（回落启动 env 的地址 / key）", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	writeExecutorConfig(
		{ employee: "pool", profiles: { pool: { model: "unknown-model" } } },
		env,
	);
	assert.deepEqual(
		executorForDelegation(env, { modelRoute: () => null }),
		{ employee: "pool", profile: { model: "unknown-model" } },
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

		// 2026-11-19 模型分工：本机池的 providerId 能写能读；空串 = 不保留。
		const putPool = await app.request("/api/v1/agent/executor", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				employee: "pool",
				profiles: { pool: { model: "cheap", providerId: "bailian" } },
			}),
		});
		assert.equal(putPool.status, 200);
		const poolView = (await putPool.json()) as {
			profiles: Record<string, { model?: string; providerId?: string }>;
		};
		assert.equal(poolView.profiles.pool.model, "cheap");
		assert.equal(poolView.profiles.pool.providerId, "bailian");

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
		executorSummary("pool", { model: "cheap" }),
		"底层 worker 运行时（模型 cheap）",
	);
	assert.equal(
		executorSummary("claude-code", { model: "opus", permission: "full" }),
		"Claude Code（模型 opus，权限 全权）",
	);
	assert.equal(
		executorSummary("codebuddy", { model: "deepseek-v4.1-flash" }),
		"CodeBuddy（模型 deepseek-v4.1-flash，权限 全权）",
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

	// 本机池的三种口径（2026-11-19 模型分工）：跟随默认 / 显式 / 回滚。
	const poolEnv = { EXECUTOR_CONFIG_PATH: tempPath() };
	writeExecutorConfig({ employee: "pool", profiles: { pool: { model: "" } } }, poolEnv);
	assert.match(
		executorLine(poolEnv, {
			currentModel: () => ({ provider: "bailian", modelId: "cheap" }),
		}),
		/干活模型跟随默认（cheap）/,
	);
	writeExecutorConfig({ employee: "pool", profiles: { pool: { model: "work" } } }, poolEnv);
	assert.match(executorLine(poolEnv), /干活模型 work/);
	writeExecutorConfig({ employee: "pool", profiles: { pool: { model: "" } } }, poolEnv);
	assert.match(
		executorLine({ ...poolEnv, EXECUTOR_NATIVE_FOLLOW_DEFAULT: "false" }),
		/干活模型跟随启动 env/,
	);
});

test("豆包档：可选中、默认 DeepSeek V4.1 Flash、模型与权限写读一致", () => {
	const env = { EXECUTOR_CONFIG_PATH: tempPath() };
	assert.equal(
		parseExecutorInput({ employee: "doubao" }, readExecutorConfig(env)).ok,
		true,
	);
	writeExecutorConfig(
		{
			employee: "doubao",
			profiles: {
				doubao: {
					model: "person-deepseek-v4-pro-ga-260813",
					permission: "read",
				},
			},
		},
		env,
	);
	const config = readExecutorConfig(env);
	assert.equal(config.employee, "doubao");
	assert.deepEqual(config.profiles.doubao, {
		model: "person-deepseek-v4-pro-ga-260813",
		permission: "read",
	});
	assert.equal(
		executorSummary("doubao", {
			model: "person-deepseek-v4-1-flash-261017",
			permission: "full",
		}),
		"豆包 CLI（模型 person-deepseek-v4-1-flash-261017，权限 全权）",
	);

	// 没有文件 / 没有 env 时，豆包档的缺省就是 DeepSeek V4.1 Flash + 全权。
	const fresh = readExecutorConfig({ EXECUTOR_CONFIG_PATH: tempPath() });
	assert.deepEqual(fresh.profiles.doubao, {
		model: "person-deepseek-v4-1-flash-261017",
		permission: "full",
	});

	// 前端卡片数据源：kinds 里要有可选的豆包项与权限三段。
	const view = executorView({ EXECUTOR_CONFIG_PATH: tempPath() });
	const doubao = view.kinds.find((kind) => kind.id === "doubao");
	assert.equal(doubao?.selectable, true);
	assert.deepEqual(doubao?.permissions, ["read", "edit", "full"]);
	assert.match(doubao?.modelHint ?? "", /person-deepseek-v4-1-flash-261017/);
});

test("权限档按厂商收口（2026-11-23）：permissionOptions 只列该 CLI 实际支持的档", () => {
	const view = executorView({ EXECUTOR_CONFIG_PATH: tempPath() });
	const optionsOf = (id: string) =>
		view.kinds.find((kind) => kind.id === id)?.permissionOptions;

	// 豆包：两段，没有只读；label 用厂商自己的档名。
	assert.deepEqual(
		optionsOf("doubao")?.map((option) => [option.value, option.label]),
		[
			["edit", "风险确认"],
			["full", "全部允许"],
		],
	);
	assert.equal(
		optionsOf("doubao")?.some((option) => option.label === "只读"),
		false,
		"豆包没有只读档",
	);

	// OpenCode：edit / full 同走 --auto，只画两段。
	assert.deepEqual(
		optionsOf("opencode")?.map((option) => [option.value, option.label]),
		[
			["read", "只读"],
			["full", "全权"],
		],
	);

	// Claude Code / Codex 仍是完整三段，value 顺序与旧 permissions 一致。
	assert.deepEqual(
		optionsOf("claude-code")?.map((option) => [option.value, option.label]),
		[
			["read", "只读"],
			["edit", "可改"],
			["full", "全权"],
		],
	);
	assert.deepEqual(
		optionsOf("codex")?.map((option) => [option.value, option.label]),
		[
			["read", "只读"],
			["edit", "可改"],
			["full", "全权"],
		],
	);

	// CodeBuddy / Qoder（2026-11-23 接上厂商权限档）：三段，label 用原生档名。
	for (const id of ["codebuddy", "qoder-intl", "qoder-cn"]) {
		assert.deepEqual(
			optionsOf(id)?.map((option) => [option.value, option.label]),
			[
				["read", "只读"],
				["edit", "可改"],
				["full", "全权"],
			],
			`${id} 应有三段权限档`,
		);
		assert.match(
			optionsOf(id)?.find((option) => option.value === "full")?.hint ?? "",
			/bypass/i,
			`${id} 全权档要写清原生档名`,
		);
	}
	// CodeBuddy 只读档实测用 dontAsk（plan 也拒写但会生成计划文件）。
	assert.equal(
		optionsOf("codebuddy")?.find((option) => option.value === "read")?.hint,
		"dontAsk：写文件 / 跑命令都被拒",
	);

	// 固定全权的档不填 permissionOptions（前端继续按 permissions:null 渲染）。
	for (const id of ["pool", "phone", "mcp"]) {
		assert.equal(optionsOf(id), undefined, `${id} 不该有 permissionOptions`);
	}
});

test("CodeBuddy / Qoder 权限档：env 缺省进 profile，旧配置没字段 = full", () => {
	// 无文件、无 env → 三档缺省 full（行为与改动前一致）。
	const fresh = readExecutorConfig({ EXECUTOR_CONFIG_PATH: tempPath() });
	assert.equal(fresh.profiles.codebuddy?.permission, "full");
	assert.equal(fresh.profiles["qoder-intl"]?.permission, "full");
	assert.equal(fresh.profiles["qoder-cn"]?.permission, "full");

	// env 缺省生效。
	const fromEnv = readExecutorConfig({
		EXECUTOR_CONFIG_PATH: tempPath(),
		CHANCELLOR_CODEBUDDY_PERMISSION: "read",
		CHANCELLOR_QODER_PERMISSION: "edit",
		CHANCELLOR_QODER_CN_PERMISSION: "read",
	});
	assert.equal(fromEnv.profiles.codebuddy?.permission, "read");
	assert.equal(fromEnv.profiles["qoder-intl"]?.permission, "edit");
	assert.equal(fromEnv.profiles["qoder-cn"]?.permission, "read");

	// 文件里写过的权限优先于 env；旧配置只有 model = 权限回落 env（未设 = full）。
	const path = tempPath();
	writeExecutorConfig(
		{ employee: "codebuddy", profiles: { codebuddy: { model: "m", permission: "edit" } } },
		{ EXECUTOR_CONFIG_PATH: path, CHANCELLOR_CODEBUDDY_PERMISSION: "read" },
	);
	const written = readExecutorConfig({ EXECUTOR_CONFIG_PATH: path });
	assert.deepEqual(written.profiles.codebuddy, { model: "m", permission: "edit" });

	const legacyPath = tempPath();
	writeExecutorConfig(
		{ employee: "qoder-intl", profiles: { "qoder-intl": { model: "DeepSeek-Flash" } } },
		{ EXECUTOR_CONFIG_PATH: legacyPath },
	);
	const legacy = readExecutorConfig({ EXECUTOR_CONFIG_PATH: legacyPath });
	assert.equal(legacy.profiles["qoder-intl"]?.permission, "full");

	// 派单 profile 原样带上（executorForDelegation 不吞权限）。
	const dispatch = executorForDelegation(
		{
			EXECUTOR_CONFIG_PATH: path,
			CHANCELLOR_EMPLOYEE: "codebuddy",
		},
		{},
	);
	assert.equal(dispatch.employee, "codebuddy");
	assert.equal(dispatch.profile.permission, "edit");
});
