import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import {
	FLAG_DEFS,
	flagEnabled,
	flagValue,
	flagsPath,
	listFlags,
	loadFlagOverrides,
	mountFlags,
	setFlag,
} from "./flags.ts";

/**
 * 高级开关（2026-11-09）：文件覆盖 env / setFlag 落盘且热生效 / API 校验与回滚开关。
 * 全部用临时目录，不碰真实 .data；env 改动逐项复原。
 */
const root = mkdtempSync(join(tmpdir(), "lifediary-flags-"));
process.env.AGENT_FLAGS_PATH = join(root, "agent-flags.json");

function cleanupEnv(keys: string[]): void {
	for (const key of keys) delete process.env[key];
}

test("loadFlagOverrides：核心覆盖进 env，普通插件只留在 JSON、不进 env，非法键跳过", () => {
	const path = flagsPath();
	writeFileSync(
		path,
		JSON.stringify({ AUTONOMY_ENABLED: "true", NOT_A_FLAG: "x", MEMORY_EXTRACT: "llm" }),
		"utf8",
	);
	cleanupEnv(["AUTONOMY_ENABLED", "MEMORY_EXTRACT"]);
	const applied = loadFlagOverrides();
	assert.equal(applied, 1, "只有 scope=core 的 AUTONOMY_ENABLED 进 env");
	assert.equal(process.env.AUTONOMY_ENABLED, "true");
	assert.equal(process.env.MEMORY_EXTRACT, undefined, "plugin 配置不再灌 env");
	assert.equal(flagValue("MEMORY_EXTRACT"), "llm", "但运行时从 JSON 读到同一个值");
	cleanupEnv(["AUTONOMY_ENABLED"]);
});

test("requires 图：父键都存在且不成环（含多父 / 嵌套）", () => {
	const byKey = new Map(FLAG_DEFS.map((def) => [def.key, def]));
	const visiting = new Set<string>();
	const done = new Set<string>();
	const walk = (key: string): void => {
		if (done.has(key)) return;
		assert.equal(visiting.has(key), false, `requires 成环：${key}`);
		const def = byKey.get(key);
		assert.ok(def, `requires 指向不存在的开关：${key}`);
		visiting.add(key);
		for (const parent of def.requires ?? []) walk(parent);
		visiting.delete(key);
		done.add(key);
	};
	for (const def of FLAG_DEFS) walk(def.key);
	assert.deepEqual(byKey.get("MEMORY_EXTRACT")?.requires, ["MEMORY_ENABLED"]);
	assert.deepEqual(byKey.get("TOOL_PROJECTION_WORKER")?.requires, ["TOOL_PROJECTION"]);
	assert.deepEqual(byKey.get("GROUPS_ENABLED")?.requires, ["COMPANIONS_ENABLED"]);
	assert.deepEqual(byKey.get("PARTNER_WORK_RECORD")?.requires, ["MEMORY_ENABLED", "COMPANIONS_ENABLED"]);
	assert.deepEqual(byKey.get("MEMORY_INJECT_DEDUPE")?.requires, ["MEMORY_ENABLED", "PARTNER_MEMORY_RECALL"]);
	assert.deepEqual(byKey.get("ARCHIVE_AUTO_DAYS")?.requires, ["ARCHIVE_AUTO_ENABLED"]);
	assert.deepEqual(byKey.get("AGENT_COMPACT_TRIGGER_PERCENT")?.requires, ["AGENT_COMPACT_ENABLED"]);
});

test("scope：系统核心 = 记忆 / 执事体系 / 宰相 / 自主轮 / 工具权限，其余默认普通插件", () => {
	const coreKeys = FLAG_DEFS.filter((def) => def.scope === "core")
		.map((def) => def.key)
		.sort();
	assert.deepEqual(coreKeys, [
		"AGENT_TOOL_POLICY",
		"AUTONOMY_ENABLED",
		"CHANCELLOR_ENABLED",
		"COMPANIONS_ENABLED",
		"DELEGATION_PROJECT_MEMORY",
		"MEMORY_ENABLED",
	].sort());
	const env: NodeJS.ProcessEnv = { AGENT_FLAGS_PATH: join(root, "scope.json") };
	const rows = new Map(listFlags(env).flags.map((flag) => [flag.key, flag]));
	assert.equal(rows.get("MEMORY_ENABLED")?.scope, "core");
	assert.equal(rows.get("COMPANIONS_ENABLED")?.scope, "core");
	assert.equal(rows.get("AGENT_TOOL_POLICY")?.scope, "core", "工具权限限制是安全边界，标系统核心");
	assert.equal(rows.get("TOOL_PROJECTION")?.scope, "plugin");
	assert.equal(rows.get("PARTNER_TEMPLATES")?.scope, "plugin");
});

test("JSON 清单：API 返回名称 / 说明 / 分组 / 档位 / groups，前端不用再维护映射表", async () => {
	const app = new Hono();
	mountFlags(app);
	const response = await app.request("/api/v1/agent/flags");
	const data = (await response.json()) as {
		groups: { id: string; title: string }[];
		flags: {
			key: string;
			label: string;
			summary: string;
			group: string;
			choices: { value: string; label: string }[];
			offValue?: string;
			surface: string;
		}[];
	};
	assert.equal(data.groups.length, 7);
	assert.equal(data.groups[0]?.id, "chat");
	// 数量按清单快照取（并行开发时别人也会往清单加开关，别钉死数字）；
	// 但要确认本批新增的 SCHEDULED_TASK_MODEL_RUN 确实在册（2026-11-17 定时主动轮）。
	assert.equal(data.flags.length, listFlags().flags.length);
	assert.ok(data.flags.some((flag) => flag.key === "SCHEDULED_TASK_MODEL_RUN"));
	const memory = data.flags.find((flag) => flag.key === "MEMORY_ENABLED");
	assert.equal(memory?.label, "记忆总闸");
	assert.equal(memory?.group, "memory");
	assert.ok(memory?.summary.includes("记忆引擎"));
	const extract = data.flags.find((flag) => flag.key === "MEMORY_EXTRACT");
	assert.deepEqual(
		extract?.choices.map((choice) => choice.label),
		["关", "自动", "模型", "规则"],
		"2026-11-18 加 off 档：多档插件也有开关",
	);
	assert.equal(extract?.offValue, "off");
	const toolPolicy = data.flags.find((flag) => flag.key === "AGENT_TOOL_POLICY");
	assert.equal(toolPolicy?.offValue, "full", "工具权限的关 = 完全访问（既有档位）");
	const internal = data.flags.find((flag) => flag.key === "CHANCELLOR_INTERNAL");
	assert.equal(internal?.offValue, "qoder", "内部质检的关 = 外部 CLI（既有档位）");
	const archiveDays = data.flags.find((flag) => flag.key === "ARCHIVE_AUTO_DAYS");
	assert.equal(archiveDays?.surface, "settings", "专属卡不在插件页重复");
	assert.deepEqual(
		data.flags.filter((flag) => flag.surface === "settings").map((flag) => flag.key),
		[
			"ARCHIVE_AUTO_ENABLED",
			"ARCHIVE_AUTO_DAYS",
			"AGENT_COMPACT_ENABLED",
			"AGENT_COMPACT_TRIGGER_MODE",
			"AGENT_COMPACT_TRIGGER_PERCENT",
			"AGENT_COMPACT_TRIGGER_K",
		],
	);
});

test("父子门：父关 → 子 effective=false 且 lockedBy 是父；值不清零，父开恢复", () => {
	const path = join(root, "graph-env.json");
	writeFileSync(
		path,
		JSON.stringify({ MEMORY_EXTRACT: "llm", PARTNER_MEMORY_RECALL: "true" }),
		"utf8",
	);
	const env: NodeJS.ProcessEnv = {
		AGENT_FLAGS_PATH: path,
		MEMORY_ENABLED: "false",
	};
	const locked = listFlags(env).flags.find((flag) => flag.key === "MEMORY_EXTRACT");
	assert.equal(locked?.value, "llm", "存储值不被父闸改掉");
	assert.equal(locked?.effectiveValue, "false");
	assert.equal(locked?.lockedBy, "MEMORY_ENABLED");
	assert.deepEqual(locked?.requires, ["MEMORY_ENABLED"]);

	const writeLocked = setFlag("MEMORY_EXTRACT", "rule", env);
	assert.equal(writeLocked.ok, false);
	if (!writeLocked.ok) {
		assert.equal(writeLocked.status, 400);
		assert.equal(writeLocked.code, "flag_locked");
		assert.match(writeLocked.message, /记忆总闸/);
	}
	assert.equal(flagValue("MEMORY_EXTRACT", env), "llm", "被锁时 JSON 也不动");

	env.MEMORY_ENABLED = "true";
	const unlocked = listFlags(env).flags.find((flag) => flag.key === "MEMORY_EXTRACT");
	assert.equal(unlocked?.value, "llm", "父开恢复原值，不是被改回默认");
	assert.equal(unlocked?.effectiveValue, "llm");
	assert.equal(unlocked?.lockedBy, null);

	// 嵌套：召回总闸是记忆总闸的子，同时又是召回去重的父。
	const recallPath = join(root, "graph-recall-env.json");
	writeFileSync(recallPath, JSON.stringify({ PARTNER_MEMORY_RECALL: "false" }), "utf8");
	const recallEnv: NodeJS.ProcessEnv = { ...env, AGENT_FLAGS_PATH: recallPath };
	const dedupe = listFlags(recallEnv).flags.find((flag) => flag.key === "MEMORY_INJECT_DEDUPE");
	assert.equal(dedupe?.effectiveValue, "false");
	assert.equal(dedupe?.lockedBy, "PARTNER_MEMORY_RECALL");
});

test("多父：任一父关就锁，锁在第一顺位关着的父上", () => {
	const path = join(root, "multi-parent.json");
	writeFileSync(path, JSON.stringify({ PARTNER_WORK_RECORD: "true" }), "utf8");
	const env: NodeJS.ProcessEnv = {
		AGENT_FLAGS_PATH: path,
		MEMORY_ENABLED: "true",
		COMPANIONS_ENABLED: "false",
	};
	const row = listFlags(env).flags.find((flag) => flag.key === "PARTNER_WORK_RECORD");
	assert.equal(row?.value, "true");
	assert.equal(row?.effectiveValue, "false");
	assert.equal(row?.lockedBy, "COMPANIONS_ENABLED");
	assert.deepEqual(row?.requires, ["MEMORY_ENABLED", "COMPANIONS_ENABLED"]);
});

test("会话专属卡也有父子：归档天数 / 压缩档位跟随各自总闸", () => {
	const path = join(root, "section-parents.json");
	writeFileSync(
		path,
		JSON.stringify({
			ARCHIVE_AUTO_ENABLED: "false",
			ARCHIVE_AUTO_DAYS: "14",
			AGENT_COMPACT_ENABLED: "false",
			AGENT_COMPACT_TRIGGER_MODE: "tokens",
			AGENT_COMPACT_TRIGGER_PERCENT: "80",
		}),
		"utf8",
	);
	const env: NodeJS.ProcessEnv = { AGENT_FLAGS_PATH: path };
	const rows = new Map(listFlags(env).flags.map((flag) => [flag.key, flag]));
	assert.equal(rows.get("ARCHIVE_AUTO_DAYS")?.value, "14");
	assert.equal(rows.get("ARCHIVE_AUTO_DAYS")?.effectiveValue, "false");
	assert.equal(rows.get("ARCHIVE_AUTO_DAYS")?.lockedBy, "ARCHIVE_AUTO_ENABLED");
	assert.equal(rows.get("AGENT_COMPACT_TRIGGER_MODE")?.lockedBy, "AGENT_COMPACT_ENABLED");
	assert.equal(rows.get("AGENT_COMPACT_TRIGGER_MODE")?.value, "tokens");
	assert.equal(rows.get("AGENT_COMPACT_TRIGGER_PERCENT")?.lockedBy, "AGENT_COMPACT_ENABLED");
	assert.equal(rows.get("AGENT_COMPACT_TRIGGER_PERCENT")?.effectiveValue, "false");
});

test("记忆召回总闸：注册为可热改的行为开关，默认开（父子关系的父）", () => {
	const def = FLAG_DEFS.find((item) => item.key === "PARTNER_MEMORY_RECALL");
	assert.ok(def, "总闸必须在行为开关表里");
	assert.equal(def.defaultValue, "true", "默认开：不带记忆是例外，不是缺省");
	assert.equal(def.hot, true, "消费处每次请求懒读 env，改完立刻生效");
	assert.deepEqual(def.values, ["true", "false"]);
});

test("plugin JSON 是唯一真源：文件值压过 env；外部改文件后缓存失效", () => {
	const path = join(root, "plugin-priority.json");
	const env: NodeJS.ProcessEnv = { AGENT_FLAGS_PATH: path, MEMORY_EXTRACT: "rule" };
	writeFileSync(path, JSON.stringify({ MEMORY_EXTRACT: "llm" }), "utf8");
	assert.equal(flagValue("MEMORY_EXTRACT", env), "llm", "文件值优先于 env");
	assert.equal(
		listFlags(env).flags.find((flag) => flag.key === "MEMORY_EXTRACT")?.value,
		"llm",
	);
	writeFileSync(path, JSON.stringify({ MEMORY_EXTRACT: "auto" }), "utf8");
	assert.equal(flagValue("MEMORY_EXTRACT", env), "auto", "外部改 JSON 后下一次读能看到");
	setFlag("MEMORY_EXTRACT", "rule", env);
	assert.equal(flagValue("MEMORY_EXTRACT", env), "rule", "setFlag 立即刷新缓存");
	assert.equal(env.MEMORY_EXTRACT, "rule", "env 保持部署回落值，不被插件写覆盖");
});

test("setFlag：plugin 只落 JSON 不写 env，运行时 flagValue 读 JSON；core 仍同步 env", () => {
	const path = join(root, "set-flag-plugin.json");
	const env: NodeJS.ProcessEnv = { AGENT_FLAGS_PATH: path };
	cleanupEnv(["AGENT_ATTACHMENTS"]);
	const ok = setFlag("AGENT_ATTACHMENTS", "false", env);
	assert.equal(ok.ok, true);
	assert.equal(process.env.AGENT_ATTACHMENTS, undefined, "plugin 配置不再写 process.env");
	assert.equal(flagValue("AGENT_ATTACHMENTS", env), "false");
	assert.equal(flagEnabled("AGENT_ATTACHMENTS", env), false);
	const onDisk = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(onDisk.AGENT_ATTACHMENTS, "false");

	const badKey = setFlag("NOT_A_FLAG", "true", env);
	assert.equal(badKey.ok, false);
	const badValue = setFlag("AGENT_ATTACHMENTS", "maybe", env);
	assert.equal(badValue.ok, false);
	assert.equal(flagValue("AGENT_ATTACHMENTS", env), "false", "非法写不覆盖原值");

	const corePath = join(root, "set-flag-core.json");
	const coreEnv: NodeJS.ProcessEnv = { AGENT_FLAGS_PATH: corePath, CHANCELLOR_ENABLED: "true" };
	const core = setFlag("CHANCELLOR_ENABLED", "false", coreEnv);
	assert.equal(core.ok, true);
	assert.equal(coreEnv.CHANCELLOR_ENABLED, "false", "core 仍是历史部署路径：同步写 env");
	assert.equal(JSON.parse(readFileSync(corePath, "utf8")).CHANCELLOR_ENABLED, "false");
	cleanupEnv(["AGENT_ATTACHMENTS"]);
});

test("API：GET 列表带 hot/defaultValue，PUT 校验取值，AGENT_FLAGS_UI=false 整组不挂", async () => {
	const app = new Hono();
	mountFlags(app);
	const list = await app.request("/api/v1/agent/flags");
	assert.equal(list.status, 200);
	const data = (await list.json()) as {
		flags: { key: string; hot: boolean; defaultValue: string; scope: string }[];
	};
	assert.ok(data.flags.length >= FLAG_DEFS.length);
	const autonomy = data.flags.find((flag) => flag.key === "AUTONOMY_ENABLED");
	assert.equal(autonomy?.hot, true);
	assert.equal(autonomy?.scope, "core", "自主轮是系统核心，不是普通插件");
	const companions = data.flags.find((flag) => flag.key === "COMPANIONS_ENABLED");
	assert.equal(companions?.hot, false, "执事总闸是挂载期冻结，标 hot=false");
	assert.equal(companions?.scope, "core");
	// persona 记忆库接入（2026-11-09）：两个消费处都懒读 env，热生效；导出默认开（2026-11-16 翻案）。
	const personaMemory = data.flags.find((flag) => flag.key === "PERSONA_MEMORY_ENABLED");
	assert.equal(personaMemory?.hot, true, "persona_recall 的关闸每次调用前懒读，热生效");
	assert.equal(personaMemory?.defaultValue, "true");
	const personaExport = data.flags.find((flag) => flag.key === "PERSONA_EXPORT_ENABLED");
	assert.equal(personaExport?.hot, true, "导出开关每轮 settled 懒读，热生效");
	assert.equal(personaExport?.defaultValue, "true", "2026-11-16 翻案：对话归档默认开，插件页可关");
	// 对话逐字浮现（2026-11-13）：web 开新消息时懒读，默认开；关掉退回旧整块渲染。
	const streamReveal = data.flags.find((flag) => flag.key === "CHAT_STREAM_REVEAL");
	assert.equal(streamReveal?.hot, true);
	assert.equal(streamReveal?.defaultValue, "true");

	const put = await app.request("/api/v1/agent/flags/CHANCELLOR_ENABLED", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "false" }),
	});
	assert.equal(put.status, 200);
	assert.equal(process.env.CHANCELLOR_ENABLED, "false");
	const bad = await app.request("/api/v1/agent/flags/CHANCELLOR_ENABLED", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "maybe" }),
	});
	assert.equal(bad.status, 400);
	const unknown = await app.request("/api/v1/agent/flags/NOPE", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "true" }),
	});
	assert.equal(unknown.status, 404);
	cleanupEnv(["CHANCELLOR_ENABLED"]);

	const closed = new Hono();
	mountFlags(closed, { enabled: false });
	assert.equal((await closed.request("/api/v1/agent/flags")).status, 404);
});

test("归档管理三键（2026-11-13 批A）：默认值 / hot 标记 / onChange 回调", async () => {
	const byKey = new Map(FLAG_DEFS.map((def) => [def.key, def]));
	const hardDelete = byKey.get("CHAT_HARD_DELETE");
	assert.equal(hardDelete?.defaultValue, "true", "永久删除默认开（回滚开关）");
	assert.equal(hardDelete?.hot, true, "端点每次请求懒读 env，改完即生效");
	const autoEnabled = byKey.get("ARCHIVE_AUTO_ENABLED");
	assert.equal(autoEnabled?.defaultValue, "true", "自动归档默认开（2026-11-15 用户口径）");
	assert.equal(autoEnabled?.hot, true);
	const autoDays = byKey.get("ARCHIVE_AUTO_DAYS");
	assert.equal(autoDays?.defaultValue, "30");
	assert.equal(autoDays?.hot, true);
	assert.equal(autoDays?.min, 1, "天数数值型开关，最小 1");

	// onChange：写成功才回调（自动归档调度器靠它动态开停定时器）
	const seen: string[] = [];
	const app = new Hono();
	mountFlags(app, { onChange: (key) => seen.push(key) });
	const put = await app.request("/api/v1/agent/flags/ARCHIVE_AUTO_ENABLED", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "true" }),
	});
	assert.equal(put.status, 200);
	assert.deepEqual(seen, ["ARCHIVE_AUTO_ENABLED"]);
	const badPut = await app.request("/api/v1/agent/flags/ARCHIVE_AUTO_ENABLED", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "maybe" }),
	});
	assert.equal(badPut.status, 400);
	assert.deepEqual(seen, ["ARCHIVE_AUTO_ENABLED"], "写失败不回调");
	cleanupEnv(["ARCHIVE_AUTO_ENABLED", "CHAT_HARD_DELETE", "ARCHIVE_AUTO_DAYS"]);
});

test("API：父关时 PUT 子项返回 400 flag_locked，JSON 存储值不动", async () => {
	const previousPath = process.env.AGENT_FLAGS_PATH;
	const path = join(root, "api-locked.json");
	process.env.AGENT_FLAGS_PATH = path;
	cleanupEnv(["MEMORY_ENABLED", "MEMORY_EXTRACT"]);
	process.env.MEMORY_ENABLED = "false";
	writeFileSync(path, JSON.stringify({ MEMORY_EXTRACT: "llm" }), "utf8");
	try {
		const app = new Hono();
		mountFlags(app);
		const put = await app.request("/api/v1/agent/flags/MEMORY_EXTRACT", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: "rule" }),
		});
		assert.equal(put.status, 400);
		const body = (await put.json()) as { error: string; message: string };
		assert.equal(body.error, "flag_locked");
		assert.match(body.message, /记忆总闸/);
		assert.equal(
			JSON.parse(readFileSync(path, "utf8")).MEMORY_EXTRACT,
			"llm",
			"被锁时 JSON 存储值不动",
		);
		const list = (await (await app.request("/api/v1/agent/flags")).json()) as {
			flags: { key: string; value: string; effectiveValue: string; lockedBy: string | null }[];
		};
		const child = list.flags.find((flag) => flag.key === "MEMORY_EXTRACT");
		assert.equal(child?.value, "llm");
		assert.equal(child?.effectiveValue, "false");
		assert.equal(child?.lockedBy, "MEMORY_ENABLED");
	} finally {
		cleanupEnv(["MEMORY_ENABLED", "MEMORY_EXTRACT"]);
		if (previousPath === undefined) delete process.env.AGENT_FLAGS_PATH;
		else process.env.AGENT_FLAGS_PATH = previousPath;
	}
});

test("插件清单热更新：改 JSON 后 listFlags 直接看到新 label，不重启；坏清单保留上一版", () => {
	const source = JSON.parse(
		readFileSync(new URL("./plugins.json", import.meta.url), "utf8"),
	) as { flags: { key: string; label?: string }[]; groups: unknown[] };
	const manifestPath = join(root, "plugins-hot.json");
	const configPath = join(root, "plugins-hot-config.json");
	const env: NodeJS.ProcessEnv = {
		AGENT_PLUGINS_PATH: manifestPath,
		AGENT_FLAGS_PATH: configPath,
	};
	const write = (label: string): void => {
		const flag = source.flags.find((item) => item.key === "AGENT_ATTACHMENTS");
		assert.ok(flag);
		flag.label = label;
		writeFileSync(manifestPath, JSON.stringify(source), "utf8");
	};

	write("附件（热更一）");
	assert.equal(
		listFlags(env).flags.find((flag) => flag.key === "AGENT_ATTACHMENTS")?.label,
		"附件（热更一）",
	);
	write("附件（热更二）");
	assert.equal(
		listFlags(env).flags.find((flag) => flag.key === "AGENT_ATTACHMENTS")?.label,
		"附件（热更二）",
		"mtime / size 变化后重新装载，不需要重启",
	);

	writeFileSync(manifestPath, "{ 坏 JSON", "utf8");
	assert.equal(
		listFlags(env).flags.find((flag) => flag.key === "AGENT_ATTACHMENTS")?.label,
		"附件（热更二）",
		"坏清单保留上一版，不把服务打挂",
	);

	// 清掉临时清单，下一次默认 env 调用会切回 src/plugins.json。
	listFlags({});
});
