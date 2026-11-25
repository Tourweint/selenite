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
	// 领域派活入口（2026-11-23）：派活总闸关着时这层没有意义，挂 CHANCELLOR_ENABLED。
	assert.deepEqual(byKey.get("CHANCELLOR_DOMAIN_DISPATCH")?.requires, ["CHANCELLOR_ENABLED"]);
	// 真实依赖补边（2026-11-25，recon §4.1 G1–G8 + 隐形父 MEMORY_IMPORT 登记）。
	assert.deepEqual(byKey.get("CHAT_CACHE_STATS")?.requires, ["CHAT_CONTEXT_INSPECT"]);
	assert.deepEqual(byKey.get("SKILL_ADVICE")?.requires, ["SKILLS_ADMIN"]);
	assert.deepEqual(byKey.get("MEMORY_PROACTIVE")?.requires, ["MEMORY_ENABLED", "PARTNER_MEMORY_RECALL"]);
	assert.deepEqual(byKey.get("MEMORY_NIGHTLY_SPLIT")?.requires, ["MEMORY_NIGHTLY_REVIEW", "MEMORY_SPLIT"]);
	assert.deepEqual(byKey.get("MINISTER_DISPATCH_AUTHORITY")?.requires, ["COMPANIONS_ENABLED", "CHANCELLOR_ENABLED"]);
	assert.deepEqual(byKey.get("DEVICE_AUTO_DISPATCH")?.requires, ["CHANCELLOR_ENABLED"]);
	assert.deepEqual(byKey.get("AGENT_VERIFIED_ANSWER")?.requires, ["MEMORY_ENABLED", "AGENT_ASK_USER"]);
	assert.deepEqual(byKey.get("MEMORY_IMPORT_SOURCES")?.requires, ["MEMORY_ENABLED", "MEMORY_IMPORT"]);
	assert.deepEqual(byKey.get("MEMORY_IMPORT")?.requires, ["MEMORY_ENABLED"]);
});

test("scope：系统核心 = 记忆 / 执事体系 / 宰相 / 自主轮 / 目标模式 / 工具权限，其余默认普通插件", () => {
	const coreKeys = FLAG_DEFS.filter((def) => def.scope === "core")
		.map((def) => def.key)
		.sort();
	assert.deepEqual(coreKeys, [
		"AGENT_TOOL_POLICY",
		"AUTONOMY_ENABLED",
		"CHANCELLOR_CLI_STREAM_EVENTS",
		"CHANCELLOR_DOMAIN_DISPATCH",
		"CHANCELLOR_ENABLED",
		"COMPANIONS_ENABLED",
		"GOAL_MODE",
		"MEMORY_ENABLED",
	].sort());
	const env: NodeJS.ProcessEnv = { AGENT_FLAGS_PATH: join(root, "scope.json") };
	const rows = new Map(listFlags(env).flags.map((flag) => [flag.key, flag]));
	assert.equal(rows.get("MEMORY_ENABLED")?.scope, "core");
	assert.equal(rows.get("COMPANIONS_ENABLED")?.scope, "core");
	assert.equal(rows.get("AGENT_TOOL_POLICY")?.scope, "core", "工具权限限制是安全边界，标系统核心");
	assert.equal(rows.get("TOOL_PROJECTION")?.scope, "plugin");
	// PARTNER_TEMPLATES 2026-11-21 退役；普通插件样本换 SKILL_USAGE。
	assert.equal(rows.get("SKILL_USAGE")?.scope, "plugin");
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
	//（CHANCELLOR_INTERNAL 2026-11-21 退役：qoder 旧拆单形态删除，offValue 样本只剩 extraction / toolPolicy。）
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
		flags: { key: string; hot: boolean; defaultValue: string; scope: string; group?: string }[];
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
	assert.equal(personaMemory?.hot, true, "轻召回 / 库目录的关闸每次调用前懒读，热生效");
	assert.equal(personaMemory?.defaultValue, "true");
	const personaExport = data.flags.find((flag) => flag.key === "PERSONA_EXPORT_ENABLED");
	assert.equal(personaExport?.hot, true, "导出开关每轮 settled 懒读，热生效");
	assert.equal(personaExport?.defaultValue, "true", "2026-11-16 翻案：对话归档默认开，插件页可关");
	// 领域派活入口（2026-11-23）：默认关；执行层懒读（参数面随 harness 装载刷新）。
	const domainDispatch = data.flags.find((flag) => flag.key === "CHANCELLOR_DOMAIN_DISPATCH");
	assert.equal(domainDispatch?.defaultValue, "false", "默认关：领域派活入口关闭，代码保留");
	assert.equal(domainDispatch?.hot, true);
	// 对话逐字浮现（2026-11-13）：web 开新消息时懒读，默认开；关掉退回旧整块渲染。
	const streamReveal = data.flags.find((flag) => flag.key === "CHAT_STREAM_REVEAL");
	assert.equal(streamReveal?.hot, true);
	assert.equal(streamReveal?.defaultValue, "true");
	// 统一下拉（2026-11-23）：刷新页面生效（回滚 = 退回原生 select），默认开。
	const selectMenu = data.flags.find((flag) => flag.key === "UI_SELECT_MENU");
	assert.equal(selectMenu?.hot, true);
	assert.equal(selectMenu?.defaultValue, "true");
	assert.equal(selectMenu?.group, "ui");

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

/* ────────────────────────────────────────────────────────────────────────────
 * 前置连开 / 父项连带关（2026-11-25）
 * 四条端点都挂在 mountFlags() 内、走 process.env；每条用例用独立临时 flags 文件，
 * core 开关（MEMORY_ENABLED / CHANCELLOR_ENABLED / COMPANIONS_ENABLED …）走 env，
 * plugin 开关走 JSON——和运行期口径一致。
 * ──────────────────────────────────────────────────────────────────────────── */

interface CascadeNodeBody {
	key: string;
	label: string;
	value: string | null;
	hot: boolean;
	willWrite: boolean;
}

interface CascadePlanBody {
	key: string;
	label: string;
	missing: CascadeNodeBody[];
	revive: { key: string; label: string; value: string; hot: boolean; willWrite: boolean }[];
	needsValue: { key: string; label: string; choices: { value: string; label: string }[] }[];
	target: CascadeNodeBody;
}

interface CascadeDisablePlanBody {
	key: string;
	label: string;
	disableable: boolean;
	offValue?: string;
	affected: { key: string; label: string }[];
}

interface CascadeWriteBody {
	ok: boolean;
	changed: { key: string; value: string; hot: boolean }[];
	revived?: { key: string; value: string; hot: boolean }[];
	affected?: { key: string; label: string }[];
	alreadyOn?: boolean;
	alreadyOff?: boolean;
}

/** 每条用例一份独立配置：写 JSON 指到临时 flags 文件，返回路径。 */
function cascadeFixture(name: string, json: Record<string, string> = {}): string {
	const path = join(root, name);
	writeFileSync(path, JSON.stringify(json), "utf8");
	process.env.AGENT_FLAGS_PATH = path;
	return path;
}

function mountCascadeApp(): Hono {
	const app = new Hono();
	mountFlags(app);
	return app;
}

const JSON_HEADERS = { "content-type": "application/json" };
const CASCADE_KEYS = ["MEMORY_ENABLED", "CHANCELLOR_ENABLED", "COMPANIONS_ENABLED", "FLAG_CASCADE_ENABLE"];

test("级联 enable-plan：多父按拓扑序（父在子前），只读不写", async () => {
	const path = cascadeFixture("cascade-plan-order.json", { PARTNER_MEMORY_RECALL: "false" });
	process.env.MEMORY_ENABLED = "false";
	try {
		const plan = (await (
			await mountCascadeApp().request("/api/v1/agent/flags/MEMORY_INJECT_DEDUPE/enable-plan")
		).json()) as CascadePlanBody;
		assert.equal(plan.key, "MEMORY_INJECT_DEDUPE");
		assert.equal(plan.label, "记忆召回去重");
		assert.deepEqual(
			plan.missing.map((node) => node.key),
			["MEMORY_ENABLED", "PARTNER_MEMORY_RECALL"],
			"最深祖先在前、父在子前：召回总闸本身也要求记忆总闸",
		);
		assert.deepEqual(plan.missing.map((node) => node.willWrite), [true, true], "两个父的存储值都是关的");
		assert.deepEqual(plan.missing.map((node) => node.value), ["true", "true"]);
		assert.equal(plan.target.value, "true");
		assert.equal(plan.target.willWrite, false, "目标自己本来就开着，只是被父锁住");
		assert.deepEqual(plan.needsValue, [], "布尔键都有确定的开值，不需要用户选");
		// 只读：GET 不能顺手写值
		assert.equal(process.env.MEMORY_ENABLED, "false");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { PARTNER_MEMORY_RECALL: "false" });
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 enable-plan：父锁但 stored 开 → willWrite=false，且不进 revive", async () => {
	const path = cascadeFixture("cascade-plan-lock.json", {
		MEMORY_IMPORT: "true",
		MEMORY_IMPORT_SOURCES: "true",
	});
	process.env.MEMORY_ENABLED = "false";
	try {
		const plan = (await (
			await mountCascadeApp().request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable-plan")
		).json()) as CascadePlanBody;
		assert.deepEqual(plan.missing.map((node) => node.key), ["MEMORY_ENABLED", "MEMORY_IMPORT"]);
		assert.deepEqual(plan.missing.map((node) => node.willWrite), [true, false], "导入总闸自己开着，不用写");
		assert.equal(plan.missing[1]?.value, "true");
		assert.equal(plan.target.willWrite, false);
		assert.ok(
			plan.revive.some((node) => node.key === "MEMORY_EXTRACT"),
			"记忆总闸一开，被它锁住的记忆提取会顺带恢复（证明 revive 真的在算）",
		);
		assert.equal(
			plan.revive.some((node) => node.key === "MEMORY_IMPORT"),
			false,
			"计划里的父（哪怕只被父锁着）不算顺带复活，避免同一件事报两遍",
		);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			MEMORY_IMPORT: "true",
			MEMORY_IMPORT_SOURCES: "true",
		});
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 enable-plan：多父不误报复活（COMPANIONS 仍关，执事派发权不进 revive）", async () => {
	cascadeFixture("cascade-plan-multiparent.json");
	process.env.CHANCELLOR_ENABLED = "false";
	process.env.COMPANIONS_ENABLED = "false";
	try {
		const rows = new Map(listFlags().flags.map((flag) => [flag.key, flag]));
		assert.equal(rows.get("MINISTER_DISPATCH_AUTHORITY")?.effectiveValue, "false");
		const plan = (await (
			await mountCascadeApp().request("/api/v1/agent/flags/DEVICE_AUTO_DISPATCH/enable-plan")
		).json()) as CascadePlanBody;
		assert.deepEqual(plan.missing.map((node) => node.key), ["CHANCELLOR_ENABLED"]);
		assert.equal(
			plan.revive.some((node) => node.key === "MINISTER_DISPATCH_AUTHORITY"),
			false,
			"派发权还有另一个父（执事体系）关着，simulateOn 必须把它判成不复活",
		);
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 enable：三层链按「记忆总闸 → 召回总闸 → 去重」顺序写", async () => {
	const path = cascadeFixture("cascade-enable-order.json", {
		PARTNER_MEMORY_RECALL: "false",
		MEMORY_INJECT_DEDUPE: "false",
	});
	process.env.MEMORY_ENABLED = "false";
	try {
		const response = await mountCascadeApp().request("/api/v1/agent/flags/MEMORY_INJECT_DEDUPE/enable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: true }),
		});
		assert.equal(response.status, 200);
		const body = (await response.json()) as CascadeWriteBody;
		assert.equal(body.ok, true);
		assert.deepEqual(body.changed.map((item) => item.key), [
			"MEMORY_ENABLED",
			"PARTNER_MEMORY_RECALL",
			"MEMORY_INJECT_DEDUPE",
		]);
		assert.deepEqual(body.changed.map((item) => item.value), ["true", "true", "true"]);
		assert.equal(process.env.MEMORY_ENABLED, "true", "core 仍同步写 env");
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
		assert.equal(onDisk.PARTNER_MEMORY_RECALL, "true");
		assert.equal(onDisk.MEMORY_INJECT_DEDUPE, "true");
		assert.equal(flagEnabled("MEMORY_INJECT_DEDUPE"), true, "写完目标真的生效");
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 POST：缺 confirm → 400 needs_confirm（enable / disable 同判）", async () => {
	cascadeFixture("cascade-confirm.json");
	process.env.MEMORY_ENABLED = "false";
	try {
		const app = mountCascadeApp();
		const noBody = await app.request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable", {
			method: "POST",
		});
		assert.equal(noBody.status, 400);
		assert.equal(((await noBody.json()) as { error: string }).error, "needs_confirm");

		const wrongType = await app.request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: "true" }),
		});
		assert.equal(wrongType.status, 400);
		assert.equal(((await wrongType.json()) as { error: string }).error, "needs_confirm");

		const disable = await app.request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/disable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({}),
		});
		assert.equal(disable.status, 400);
		assert.equal(((await disable.json()) as { error: string }).error, "needs_confirm");
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 enable：目标已开 → changed []、alreadyOn", async () => {
	cascadeFixture("cascade-idempotent.json");
	cleanupEnv(CASCADE_KEYS);
	const response = await mountCascadeApp().request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ confirm: true }),
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as CascadeWriteBody;
	assert.equal(body.ok, true);
	assert.deepEqual(body.changed, []);
	assert.deepEqual(body.revived, []);
	assert.equal(body.alreadyOn, true);
});

test("级联 disable：布尔键写 false；父项连带关但子项存储值一个字不动", async () => {
	const path = cascadeFixture("cascade-disable-bool.json", {
		MEMORY_IMPORT_SOURCES: "true",
		PARTNER_SIDE_SESSIONS: "true",
	});
	process.env.COMPANIONS_ENABLED = "true";
	try {
		const app = mountCascadeApp();

		// 1) 叶子：没有后代
		const leafPlan = (await (
			await app.request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/disable-plan")
		).json()) as CascadeDisablePlanBody;
		assert.equal(leafPlan.disableable, true);
		assert.equal(leafPlan.offValue, "false");
		assert.deepEqual(leafPlan.affected, []);
		const leafWrite = await app.request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/disable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: true }),
		});
		assert.equal(leafWrite.status, 200);
		const leafBody = (await leafWrite.json()) as CascadeWriteBody;
		assert.deepEqual(leafBody.changed, [{ key: "MEMORY_IMPORT_SOURCES", value: "false", hot: true }]);
		assert.deepEqual(leafBody.affected, []);
		assert.equal(flagValue("MEMORY_IMPORT_SOURCES"), "false");
		assert.equal(flagEnabled("MEMORY_IMPORT_SOURCES"), false);

		// 2) 父项：连带关下游，子项存储值保留
		const parentPlan = (await (
			await app.request("/api/v1/agent/flags/COMPANIONS_ENABLED/disable-plan")
		).json()) as CascadeDisablePlanBody;
		assert.equal(parentPlan.disableable, true);
		assert.equal(parentPlan.offValue, "false");
		assert.ok(parentPlan.affected.some((node) => node.key === "PARTNER_SIDE_SESSIONS"));
		assert.equal(
			parentPlan.affected.some((node) => node.key === "COMPANION_HOME_ENABLED"),
			false,
			"本来就关着的后代不在受影响范围里",
		);
		assert.equal(parentPlan.affected.some((node) => node.key === "COMPANIONS_ENABLED"), false, "不含自身");

		const parentWrite = await app.request("/api/v1/agent/flags/COMPANIONS_ENABLED/disable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: true }),
		});
		assert.equal(parentWrite.status, 200);
		const parentBody = (await parentWrite.json()) as CascadeWriteBody;
		assert.deepEqual(parentBody.changed.map((item) => item.key), ["COMPANIONS_ENABLED"]);
		assert.deepEqual(parentBody.affected, parentPlan.affected, "受影响清单与 plan 一致（写前算的）");
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
		assert.equal(onDisk.PARTNER_SIDE_SESSIONS, "true", "子项存储值一个字不动");
		const row = listFlags().flags.find((flag) => flag.key === "PARTNER_SIDE_SESSIONS");
		assert.equal(row?.value, "true");
		assert.equal(row?.effectiveValue, "false", "只是被父锁住");
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 disable：无 offValue 的枚举 400 flag_not_disableable；未知键四条都 404 flag_not_found", async () => {
	cascadeFixture("cascade-disable-enum.json");
	const app = mountCascadeApp();
	const enumPlan = (await (
		await app.request("/api/v1/agent/flags/AGENT_COMPACT_TRIGGER_MODE/disable-plan")
	).json()) as CascadeDisablePlanBody;
	assert.equal(enumPlan.disableable, false, "纯枚举没有「关」这一档，200 让前端好渲染");
	assert.deepEqual(enumPlan.affected, []);

	const enumWrite = await app.request("/api/v1/agent/flags/AGENT_COMPACT_TRIGGER_MODE/disable", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ confirm: true }),
	});
	assert.equal(enumWrite.status, 400);
	assert.equal(((await enumWrite.json()) as { error: string }).error, "flag_not_disableable");

	const unknownEnablePlan = await app.request("/api/v1/agent/flags/NOPE/enable-plan");
	assert.equal(unknownEnablePlan.status, 404);
	assert.equal(((await unknownEnablePlan.json()) as { error: string }).error, "flag_not_found");
	const unknownDisablePlan = await app.request("/api/v1/agent/flags/NOPE/disable-plan");
	assert.equal(unknownDisablePlan.status, 404);
	assert.equal(((await unknownDisablePlan.json()) as { error: string }).error, "flag_not_found");
	const unknownEnable = await app.request("/api/v1/agent/flags/NOPE/enable", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ confirm: true }),
	});
	assert.equal(unknownEnable.status, 404);
	assert.equal(((await unknownEnable.json()) as { error: string }).error, "flag_not_found");
	const unknownDisable = await app.request("/api/v1/agent/flags/NOPE/disable", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ confirm: true }),
	});
	assert.equal(unknownDisable.status, 404);
	assert.equal(((await unknownDisable.json()) as { error: string }).error, "flag_not_found");
});

test("级联门：FLAG_CASCADE_ENABLE=false / 0 / off 时四条端点整组 404，列表与旧 PUT 照旧", async () => {
	cascadeFixture("cascade-gate.json");
	try {
		for (const raw of ["false", "0", "off", "FALSE"]) {
			process.env.FLAG_CASCADE_ENABLE = raw;
			const app = mountCascadeApp();
			const targets = [
				["/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable-plan", undefined],
				[
					"/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable",
					{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ confirm: true }) },
				],
				["/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/disable-plan", undefined],
				[
					"/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/disable",
					{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ confirm: true }) },
				],
			] as const;
			for (const [path, init] of targets) {
				assert.equal((await app.request(path, init)).status, 404, `门关（${raw}）时 ${path} 不挂`);
			}
			assert.equal((await app.request("/api/v1/agent/flags")).status, 200, "GET 列表不受门影响");
		}
		const put = await mountCascadeApp().request("/api/v1/agent/flags/AGENT_ATTACHMENTS", {
			method: "PUT",
			headers: JSON_HEADERS,
			body: JSON.stringify({ value: "false" }),
		});
		assert.equal(put.status, 200, "旧 PUT 语义不受门影响");
		assert.equal(flagValue("AGENT_ATTACHMENTS"), "false");
	} finally {
		cleanupEnv([...CASCADE_KEYS, "AGENT_ATTACHMENTS"]);
	}
});

test("级联 enable：plan 过期后按当时状态重推演，不 500", async () => {
	cascadeFixture("cascade-stale.json");
	cleanupEnv(["MEMORY_ENABLED"]);
	try {
		const app = mountCascadeApp();
		const plan = (await (
			await app.request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable-plan")
		).json()) as CascadePlanBody;
		assert.deepEqual(plan.missing, [], "一开始什么都开着，plan 是「无需写」");

		// 客户端拿着 plan 期间，另一个入口把父关掉了（等 POST 回来时 plan 已经过期）。
		const manual = setFlag("MEMORY_ENABLED", "false");
		assert.equal(manual.ok, true);

		const response = await app.request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: true }),
		});
		assert.equal(response.status, 200, "按当前状态重新推演，不因旧 plan 报错");
		const body = (await response.json()) as CascadeWriteBody;
		assert.deepEqual(body.changed.map((item) => item.key), ["MEMORY_ENABLED"], "只写当前真正缺的那个父");
		assert.equal(process.env.MEMORY_ENABLED, "true");
		assert.equal(flagEnabled("MEMORY_IMPORT_SOURCES"), true);
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 enable：需要选值（needs_value）时缺值 / 选到关档都 400，选对档才写", async () => {
	cascadeFixture("cascade-needs-value.json");
	process.env.AGENT_TOOL_POLICY = "full";
	try {
		const app = mountCascadeApp();
		const plan = (await (
			await app.request("/api/v1/agent/flags/AGENT_TOOL_POLICY/enable-plan")
		).json()) as CascadePlanBody;
		assert.equal(plan.target.willWrite, true, "存储值就是关档 full");
		assert.equal(plan.target.value, null, "默认值也是关档 → 必须用户挑");
		assert.deepEqual(plan.needsValue.map((need) => need.key), ["AGENT_TOOL_POLICY"]);
		assert.deepEqual(
			plan.needsValue[0]?.choices.map((choice) => choice.value),
			["full", "no-shell", "read-only"],
		);

		const missing = await app.request("/api/v1/agent/flags/AGENT_TOOL_POLICY/enable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: true }),
		});
		assert.equal(missing.status, 400);
		const missingBody = (await missing.json()) as {
			error: string;
			keys: { key: string; label: string; choices: { value: string; label: string }[] }[];
		};
		assert.equal(missingBody.error, "needs_value");
		assert.deepEqual(missingBody.keys.map((item) => item.key), ["AGENT_TOOL_POLICY"]);

		const offChoice = await app.request("/api/v1/agent/flags/AGENT_TOOL_POLICY/enable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: true, values: { AGENT_TOOL_POLICY: "full" } }),
		});
		assert.equal(offChoice.status, 400, "挑关档等于没开，仍按 needs_value 打回");
		assert.equal(((await offChoice.json()) as { error: string }).error, "needs_value");

		const ok = await app.request("/api/v1/agent/flags/AGENT_TOOL_POLICY/enable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: true, values: { AGENT_TOOL_POLICY: "no-shell" } }),
		});
		assert.equal(ok.status, 200);
		const okBody = (await ok.json()) as CascadeWriteBody;
		assert.deepEqual(okBody.changed, [{ key: "AGENT_TOOL_POLICY", value: "no-shell", hot: false }]);
		assert.equal(flagValue("AGENT_TOOL_POLICY"), "no-shell");
	} finally {
		cleanupEnv([...CASCADE_KEYS, "AGENT_TOOL_POLICY"]);
	}
});

test("级联 enable-plan：父一开后，二层被锁的中间父与孙辈都要进 revive（P0-1 漏报）", async () => {
	cascadeFixture("cascade-revive-two-levels.json", {
		PARTNER_MEMORY_RECALL: "true",
		MEMORY_INJECT_DEDUPE: "true",
		MEMORY_IMPORT: "true",
		MEMORY_IMPORT_SOURCES: "true",
	});
	process.env.MEMORY_ENABLED = "false";
	try {
		const plan = (await (
			await mountCascadeApp().request("/api/v1/agent/flags/MEMORY_EXTRACT/enable-plan")
		).json()) as CascadePlanBody;
		assert.deepEqual(plan.missing.map((node) => node.key), ["MEMORY_ENABLED"]);
		const revived = new Set(plan.revive.map((node) => node.key));
		assert.ok(
			revived.has("PARTNER_MEMORY_RECALL"),
			"存储值是 true、只是被记忆总闸锁住的中间父，父一开就恢复",
		);
		assert.ok(
			revived.has("MEMORY_INJECT_DEDUPE"),
			"它的子（两层以下）也会跟着恢复：不能因为中间父不在计划里就按写前状态判成关",
		);
		assert.ok(
			revived.has("MEMORY_IMPORT_SOURCES"),
			"同层孙辈（记忆总闸 → 导入总闸 → 导入来源）同样恢复",
		);
		assert.deepEqual(
			plan.revive.filter((node) => node.willWrite !== false),
			[],
			"revive 每项都标 willWrite:false：复活不写它自己的值",
		);
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 enable-plan：DAG 共享祖先只回溯不残留，两个候选都不会被误判成关", async () => {
	const path = cascadeFixture("cascade-dag-shared.json");
	process.env.MEMORY_ENABLED = "false";
	try {
		const app = mountCascadeApp();
		// 两个候选都共享 MEMORY_ENABLED：导入来源走 记忆总闸 → 导入总闸；夜间拆分走 记忆总闸 → 复审 / 拆分。
		const first = (await (
			await app.request("/api/v1/agent/flags/MEMORY_IMPORT_SOURCES/enable-plan")
		).json()) as CascadePlanBody;
		const second = (await (
			await app.request("/api/v1/agent/flags/MEMORY_NIGHTLY_SPLIT/enable-plan")
		).json()) as CascadePlanBody;
		assert.ok(
			new Set(first.revive.map((node) => node.key)).has("MEMORY_NIGHTLY_SPLIT"),
			"算完导入来源这一支后，共享祖先不能把夜间拆分误判成关",
		);
		assert.ok(
			new Set(second.revive.map((node) => node.key)).has("MEMORY_IMPORT_SOURCES"),
			"反方向同样成立",
		);
		assert.equal(
			new Set(second.revive.map((node) => node.key)).has("MEMORY_NIGHTLY_SPLIT"),
			false,
			"目标自身不进 revive",
		);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {}, "两条 enable-plan 都只读不写");
	} finally {
		cleanupEnv(CASCADE_KEYS);
	}
});

test("级联 disable：AGENT_TOOL_POLICY 存储 full（界面显示关）→ alreadyOff，不重写同一个值", async () => {
	const path = cascadeFixture("cascade-already-off.json");
	process.env.AGENT_TOOL_POLICY = "full";
	try {
		const app = mountCascadeApp();
		const plan = (await (
			await app.request("/api/v1/agent/flags/AGENT_TOOL_POLICY/disable-plan")
		).json()) as CascadeDisablePlanBody;
		assert.equal(plan.disableable, true);
		assert.equal(plan.offValue, "full");
		assert.deepEqual(plan.affected, []);

		const response = await app.request("/api/v1/agent/flags/AGENT_TOOL_POLICY/disable", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ confirm: true }),
		});
		assert.equal(response.status, 200);
		const body = (await response.json()) as CascadeWriteBody;
		assert.equal(body.alreadyOff, true, "存储值就是关档 full，已经是关的");
		assert.deepEqual(body.changed, [], "不把 full 再写一遍");
		assert.deepEqual(body.affected, []);
		// setFlag 对 core 会同时写 JSON + env；走 alreadyOff 分支时两边都不该动。
		assert.equal(
			JSON.parse(readFileSync(path, "utf8")).AGENT_TOOL_POLICY,
			undefined,
			"配置文件里没有被写一笔",
		);
		assert.equal(process.env.AGENT_TOOL_POLICY, "full");
	} finally {
		cleanupEnv([...CASCADE_KEYS, "AGENT_TOOL_POLICY"]);
	}
});
