import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	anyBackgroundToolPolicy,
	applyToolPolicyPatch,
	emptyToolPolicyConfig,
	memoryLightTimeoutMs,
	readToolPolicyConfig,
	resetToolPolicyCacheForTests,
	resolveToolPolicy,
	sanitizeToolPolicyConfig,
	shellTimeoutDecision,
	shellTimeoutInjectionSeconds,
	toolTimeoutPolicyEnabled,
	writeToolPolicyConfig,
	toolPolicyPath,
	type ToolPolicyConfig,
} from "./tool-policy.ts";

/**
 * 工具超时策略（2026-11-24 M0–M2）单测：
 * 消毒 / 优先级 / clamp / 未知名 / 不可后台写 background / 总开关关走旧行为。
 *
 * 全部用临时 `TOOL_POLICY_PATH`，不碰真实 `.data`；env 传普通对象时 `flagEnabled`
 * 只读对象本身（`pluginStoreApplies` 的口径），所以 `TOOL_TIMEOUT_POLICY` 可独立注入。
 */

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lh-tool-policy-"));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function envWith(path: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { TOOL_POLICY_PATH: path, ...over };
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value), "utf8");
}

test("总开关默认关：不读文件，resolver 返回未启用", () => {
	const path = join(tempDir(), "tool-policy.json");
	writeJson(path, { v: 1, tools: { bash: { timeoutMs: 5000 } } });
	resetToolPolicyCacheForTests();
	const env = envWith(path);
	assert.equal(toolTimeoutPolicyEnabled(env), false);
	const resolved = resolveToolPolicy(env);
	assert.equal(resolved.enabled, false);
	assert.deepEqual(resolved.tools, {}, "关 = 不读文件、没有生效值");
	assert.deepEqual(resolved.injections, {});
	assert.equal(anyBackgroundToolPolicy(env), false);
});

test("旧行为锁定：总开关关时 shell 注入/结算与改动前一致（只 bash 注入；旧 env 决定转后台）", () => {
	// beforeTool：总开关关 + 模块常量 900s → 只给 bash 注入 900，powershell 恒 0。
	const legacy = { bash: 900_000 };
	assert.equal(shellTimeoutInjectionSeconds("bash", {}, legacy), 900);
	assert.equal(shellTimeoutInjectionSeconds("powershell", {}, legacy), 0, "powershell 今天没有默认注入");
	// AGENT_BASH_TIMEOUT_S=0（模块常量 0 → legacy null）→ 不注入。
	assert.equal(shellTimeoutInjectionSeconds("bash", {}, { bash: null }), 0);

	// afterTool：总开关关 → 只认 AGENT_BASH_BG_TIMEOUT；开 = background + 恒通知。
	assert.deepEqual(shellTimeoutDecision("bash", {}), { action: "fail", notify: false });
	assert.deepEqual(shellTimeoutDecision("bash", { AGENT_BASH_BG_TIMEOUT: "true" }), {
		action: "background",
		notify: true,
	});
	assert.deepEqual(shellTimeoutDecision("powershell", { AGENT_BASH_BG_TIMEOUT: "on" }), {
		action: "background",
		notify: true,
	});
});

test("消毒：未知键/未知名字丢弃、越界 clamp、小数取整、非有限数丢、空条目删除", () => {
	const warnings: string[] = [];
	const config = sanitizeToolPolicyConfig(
		{
			v: 99,
			unknownTop: "x",
			tools: {
				bash: { timeoutMs: 10, onTimeout: "background", notify: true }, // 10 → clamp 5000
				powershell: { timeoutMs: 999_999_999 }, // → clamp 3600000
				recall: { timeoutMs: 1500.6, onTimeout: "fail" }, // → 1501
				web_search: { timeoutMs: Number.NaN, notify: "yes" }, // 两个字段都丢 → 删条目
				read: { timeoutMs: 5000 }, // 锁定工具：读盘直接丢
				"nope": { timeoutMs: 5000 }, // 未知工具：丢
			},
			groups: { memory: { timeoutMs: 12_000 }, collaborate: { timeoutMs: 5000 }, nope: {} },
			injections: { memoryLight: { timeoutMs: 0, onTimeout: "background" }, nope: {} },
		},
		(message) => warnings.push(message),
	);
	assert.equal(config.v, 1);
	assert.deepEqual(config.tools.bash, { timeoutMs: 5000, onTimeout: "background", notify: true });
	assert.deepEqual(config.tools.powershell, { timeoutMs: 3_600_000 });
	assert.deepEqual(config.tools.recall, { timeoutMs: 1501, onTimeout: "fail" });
	assert.equal("web_search" in config.tools, false, "非有限数 + 非布尔 → 三个字段全空 = 删条目");
	assert.equal("read" in config.tools, false, "锁定工具读盘丢弃");
	assert.equal("nope" in config.tools, false, "未知工具丢弃");
	assert.deepEqual(config.groups, { memory: { timeoutMs: 12_000 } }, "没有可配工具的组不收");
	assert.deepEqual(config.injections, { memoryLight: { timeoutMs: 500 } }, "0 → clamp 到 500；background 不收");
	assert.ok(warnings.some((line) => line.includes("on_timeout_unsupported")), "不可后台写 background 要记一条");
});

test("优先级与 source：tools > groups > legacy > default；每层只覆盖显式字段", () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const env = envWith(path, { TOOL_TIMEOUT_POLICY: "true" });
	const base = emptyToolPolicyConfig();
	base.groups.memory = { timeoutMs: 12_000 };
	base.groups.shell = { timeoutMs: 60_000, notify: true };
	base.tools.recall = { timeoutMs: 20_000 };
	base.tools.bash = { timeoutMs: 30_000, onTimeout: "background" };
	writeToolPolicyConfig(base, env);

	const resolved = resolveToolPolicy(env, { recall: 30_000, memoryLight: 6_000 });
	assert.equal(resolved.enabled, true);
	// recall：工具 > 组 > legacy
	assert.deepEqual(resolved.tools.recall?.effective, {
		timeoutMs: 20_000,
		onTimeout: "fail",
		notify: false,
		source: "tool",
	});
	// bash：工具给了 timeout/onTimeout；notify 未给 → 组 true（每层只覆盖显式字段）
	assert.deepEqual(resolved.tools.bash?.effective, {
		timeoutMs: 30_000,
		onTimeout: "background",
		notify: true,
		source: "tool",
	});
	// powershell：只有组给了 timeout/notify；onTimeout 往下默认 fail
	assert.deepEqual(resolved.tools.powershell?.effective, {
		timeoutMs: 60_000,
		onTimeout: "fail",
		notify: true,
		source: "group",
	});
	// web_search：没有 policy / legacy → 代码默认
	assert.deepEqual(resolved.tools.web_search?.effective, {
		timeoutMs: 20_000,
		onTimeout: "fail",
		notify: false,
		source: "default",
	});
	// 注入：显式条目优先于 legacy
	assert.equal(resolved.injections.memoryLight?.effective.timeoutMs, 6_000);
	assert.equal(resolved.injections.memoryLight?.effective.source, "legacy");
	base.injections.memoryLight = { timeoutMs: 4_000 };
	writeToolPolicyConfig(base, env);
	assert.deepEqual(resolveToolPolicy(env, { memoryLight: 6_000 }).injections.memoryLight?.effective, {
		timeoutMs: 4_000,
		onTimeout: "fail",
		notify: false,
		source: "tool",
	});
	// 删条目回继承
	const deleted = applyToolPolicyPatch(readToolPolicyConfig(env), { tools: { recall: null } });
	assert.ok(deleted.ok);
	writeToolPolicyConfig(deleted.config, env);
	const afterDelete = resolveToolPolicy(env, { recall: 30_000 });
	assert.deepEqual(afterDelete.tools.recall?.effective, {
		timeoutMs: 12_000,
		onTimeout: "fail",
		notify: false,
		source: "group",
	});
});

test("legacy 兜底：memory-bank askMs / AGENT_BASH_TIMEOUT_S；bash=0 表示不设默认超时", () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const env = envWith(path, { TOOL_TIMEOUT_POLICY: "true", AGENT_BASH_TIMEOUT_S: "120" });
	const resolved = resolveToolPolicy(env, { recall: 30_000, memoryLight: 8_000 });
	assert.deepEqual(resolved.tools.recall?.effective, {
		timeoutMs: 30_000,
		onTimeout: "fail",
		notify: false,
		source: "legacy",
	});
	assert.equal(resolved.tools.bash?.effective.timeoutMs, 120_000);
	assert.equal(resolved.tools.bash?.effective.source, "legacy");
	assert.equal(resolved.injections.memoryLight?.effective.source, "legacy");
	assert.equal(resolved.injections.memoryLight?.effective.timeoutMs, 8_000);

	const off = resolveToolPolicy(envWith(path, { TOOL_TIMEOUT_POLICY: "true", AGENT_BASH_TIMEOUT_S: "0" }));
	assert.equal(off.tools.bash?.effective.timeoutMs, null, "AGENT_BASH_TIMEOUT_S=0 = 显式不设默认");
	assert.equal(off.tools.bash?.effective.source, "legacy");
});

test("shell 策略生效：powershell 注入、background/cancel 结算、notify 默认", () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const env = envWith(path, { TOOL_TIMEOUT_POLICY: "true" });
	const config = emptyToolPolicyConfig();
	config.tools.bash = { timeoutMs: 60_000, onTimeout: "background" };
	config.tools.powershell = { timeoutMs: 45_000, onTimeout: "cancel", notify: true };
	writeToolPolicyConfig(config, env);

	assert.equal(shellTimeoutInjectionSeconds("bash", env, { bash: 900_000 }), 60);
	assert.equal(shellTimeoutInjectionSeconds("powershell", env, { bash: 900_000 }), 45, "powershell 也注入");
	assert.deepEqual(shellTimeoutDecision("bash", env), { action: "background", notify: true });
	assert.deepEqual(shellTimeoutDecision("powershell", env), { action: "cancel", notify: true });
	assert.equal(anyBackgroundToolPolicy(env), true, "bg-jobs 管理面据此挂载");

	// 未配置的工具走默认 fail，notify=false（不产生额外噪音）
	assert.deepEqual(shellTimeoutDecision("powershell", envWith(join(tempDir(), "empty.json"), { TOOL_TIMEOUT_POLICY: "true" })), {
		action: "fail",
		notify: false,
	});
});

test("memoryLight 消费点：master 关回 legacy；开用 policy；无条目回落 legacy；越界 clamp", () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const offEnv = envWith(path);
	// 总开关默认关：即使文件里有 policy 也不读。
	writeJson(path, { v: 1, tools: {}, groups: {}, injections: { memoryLight: { timeoutMs: 6_000 } } });
	assert.equal(memoryLightTimeoutMs(8_000, offEnv), 8_000, "master 关 = 旧 lightMs");

	const onEnv = envWith(path, { TOOL_TIMEOUT_POLICY: "true" });
	assert.equal(memoryLightTimeoutMs(8_000, onEnv), 6_000, "policy 设 6000 → 6000");

	// 总开关开但没有该条目：回落 legacy lightMs。
	const emptyPath = join(tempDir(), "tool-policy.json");
	assert.equal(
		memoryLightTimeoutMs(8_000, envWith(emptyPath, { TOOL_TIMEOUT_POLICY: "true" })),
		8_000,
		"policy 无条目 → 回落 lightMs",
	);

	// 越界按 injections.memoryLight 的 500..30000 clamp（写盘消毒时完成）。
	writeJson(path, { v: 1, tools: {}, groups: {}, injections: { memoryLight: { timeoutMs: 100 } } });
	assert.equal(memoryLightTimeoutMs(8_000, onEnv), 500);
});

test("PUT 校验：未知名 / 锁定工具 / 不可后台 / bad_timeout / bad_notify / bad_request", () => {
	const current = emptyToolPolicyConfig();
	const fail = (patch: unknown) => {
		const result = applyToolPolicyPatch(current, patch);
		assert.equal(result.ok, false);
		return result as Extract<typeof result, { ok: false }>;
	};

	assert.equal(fail(null).error, "bad_request");
	assert.equal(fail([]).error, "bad_request");
	assert.equal(fail({ tools: [] }).error, "bad_request");
	assert.equal(fail({}).error, "bad_request", "三个命名空间都缺");
	assert.equal(fail({ tools: { nope: { timeoutMs: 5000 } } }).error, "unknown_tool");
	assert.equal(fail({ groups: { nope: { timeoutMs: 5000 } } }).error, "unknown_group");
	assert.equal(fail({ injections: { nope: { timeoutMs: 5000 } } }).error, "unknown_injection");
	assert.equal(fail({ tools: { read: { timeoutMs: 5000 } } }).error, "tool_locked");
	assert.equal(fail({ tools: { ask_user: { timeoutMs: 5000 } } }).error, "tool_locked");
	assert.equal(
		fail({ tools: { recall: { onTimeout: "background" } } }).error,
		"on_timeout_unsupported",
		"记忆检索是当轮证据，不能转后台",
	);
	assert.equal(fail({ tools: { web_search: { onTimeout: "cancel" } } }).error, "on_timeout_unsupported");
	assert.equal(fail({ tools: { bash: { onTimeout: "nope" } } }).error, "on_timeout_unsupported");
	assert.equal(fail({ tools: { bash: { timeoutMs: "900" } } }).error, "bad_timeout");
	assert.equal(fail({ tools: { bash: { timeoutMs: Number.POSITIVE_INFINITY } } }).error, "bad_timeout");
	assert.equal(fail({ tools: { bash: { notify: "yes" } } }).error, "bad_notify");
	assert.equal(fail({ groups: { collaborate: { timeoutMs: 5000 } } }).error, "bad_request", "组里没有可配工具");
});

test("PUT 局部更新：只动给了的命名空间；null 删除；越界 clamp；写入可回读", () => {
	const path = join(tempDir(), "tool-policy.json");
	resetToolPolicyCacheForTests();
	const env = envWith(path, { TOOL_TIMEOUT_POLICY: "true" });
	writeToolPolicyConfig(emptyToolPolicyConfig(), env);

	const first = applyToolPolicyPatch(readToolPolicyConfig(env), {
		tools: {
			bash: { timeoutMs: 1, onTimeout: "background", notify: true }, // clamp 到 5000
			recall: { timeoutMs: 20_000 },
		},
		groups: { memory: { timeoutMs: 9000 } },
	});
	assert.ok(first.ok);
	writeToolPolicyConfig(first.config, env);
	assert.equal(toolPolicyPath(env), path);

	const second = applyToolPolicyPatch(readToolPolicyConfig(env), { tools: { recall: null } });
	assert.ok(second.ok);
	writeToolPolicyConfig(second.config, env);
	const stored = JSON.parse(readFileSync(path, "utf8")) as ToolPolicyConfig;
	assert.deepEqual(stored.tools, {
		bash: { timeoutMs: 5000, onTimeout: "background", notify: true },
	});
	assert.deepEqual(stored.groups, { memory: { timeoutMs: 9000 } }, "没给的命名空间不受影响");
	assert.deepEqual(stored.injections, {});
	assert.equal(stored.v, 1);
});
