import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { spawn } from "node:child_process";
import {
	personaCatalogTrim,
	personaInjectGatesClosed,
	personaLightRecall,
	resetPersonaLightRecallForTests,
} from "./persona-inject.ts";
import { memoryLightTimeoutMs, resetToolPolicyCacheForTests } from "./tool-policy.ts";

/**
 * 一生记忆库外挂注入（2026-11-22 记忆外挂源批）单测——方案 §六.3 前五项：
 * 前置过滤（不 spawn）/ 相关性门槛 / echo 抑制 / 限额截断 / 节流 + 总闸。
 *
 * 不真起 python：askPersona 的 stdout 由假 spawn 喂（与 persona-ask.test.ts 同款骨架）。
 * env 用独立对象 + MEMORY_BANK_PATH 指向临时槽位配置（2026-11-24 起读闸只看当前槽位）；
 * AGENT_FLAGS_PATH 指到不存在的文件（flags 的 plugin 存储按"纯 env 夹具"语义回落 env 值），
 * 不碰真实 .data；节流账本每测清空。
 */

const BANK_ROOT = mkdtempSync(join(tmpdir(), "lifediary-persona-inject-bank-"));
const BANK_ASK = join(BANK_ROOT, "ask.py");
writeFileSync(BANK_ASK, "# fake ask\n", "utf8");
const BANK_CONFIG = join(BANK_ROOT, "memory-bank.json");
mkdirSync(join(BANK_ROOT, "analysis"), { recursive: true });
writeFileSync(
	BANK_CONFIG,
	`${JSON.stringify({
		v: 1,
		active: "external",
		external: {
			id: "bank_inject",
			name: "注入测试库",
			root: BANK_ROOT,
			ask: "ask.py",
			repair: "",
			python: "",
			origin: "user",
			addedAt: "2026-11-24T00:00:00+08:00",
			vector: false,
		},
		timeouts: { lightMs: 8000, askMs: 15000 },
	})}\n`,
	"utf8",
);

const CONFIGURED_ENV: NodeJS.ProcessEnv = {
	AGENT_FLAGS_PATH: `lifediary-persona-inject-test-${process.pid}-missing.json`,
	MEMORY_BANK_PATH: BANK_CONFIG,
	PERSONA_MEMORY_ASK: BANK_ASK,
	PERSONA_PYTHON: "py3",
};

/** 内置槽位配置：active=builtin（读闸必须不过）。 */
const BUILTIN_BANK_CONFIG = join(BANK_ROOT, "memory-bank-builtin.json");
writeFileSync(
	BUILTIN_BANK_CONFIG,
	`${JSON.stringify({ v: 1, active: "builtin", external: null, timeouts: { lightMs: 8000, askMs: 15000 } })}\n`,
	"utf8",
);

/** 假 spawn：起一个 EventEmitter 假 child，微任务里喂 stdout 再 close 0（与 persona-ask.test.ts 同款骨架）。 */
function spawnJson(payload: string | null): typeof spawn {
	const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
		void command;
		void args;
		void options;
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill(): boolean;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => true;
		queueMicrotask(() => {
			if (payload !== null) child.stdout.emit("data", Buffer.from(payload, "utf8"));
			child.emit("close", 0);
		});
		return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
	}) as unknown as typeof spawn;
	return spawnFn;
}

function askJson(groups: Record<string, unknown>): string {
	return JSON.stringify({ ok: true, question: "q", groups });
}

/** 记录 argv、且子进程永不 close 的假 spawn：用于超时 / 参数断言（超时由 askPersona kill）。 */
function holdingSpawn(): {
	spawnFn: typeof spawn;
	calls: string[][];
	killed: () => boolean;
} {
	const calls: string[][] = [];
	let killed = false;
	const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
		void command;
		void options;
		calls.push(args);
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
			kill(): boolean;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {
			killed = true;
			return true;
		};
		return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
	}) as unknown as typeof spawn;
	return { spawnFn, calls, killed: () => killed };
}

test("前置过滤：短文本 / 纯符号 / 空格凑数不 spawn，返回空", async () => {
	resetPersonaLightRecallForTests();
	const spawned = spawnJson(askJson({}));
	const lines = await personaLightRecall("嗯 哈哈 ok", {
		conversationId: 1,
		env: CONFIGURED_ENV,
		spawnFn: spawned,
	});
	assert.deepEqual(lines, []);
	const lines2 = await personaLightRecall("。。。？？？", {
		conversationId: 2,
		env: CONFIGURED_ENV,
		spawnFn: spawned,
	});
	assert.deepEqual(lines2, []);
	// 5 个汉字 = 门槛之下
	const lines3 = await personaLightRecall("今天天气真好", {
		conversationId: 3,
		env: CONFIGURED_ENV,
		spawnFn: spawned,
	});
	assert.deepEqual(lines3, []);
});

test("总闸 / 读闸关闭：返回空且不 spawn；槽位 external 且未设总闸 = 开", async () => {
	resetPersonaLightRecallForTests();
	assert.equal(personaInjectGatesClosed(CONFIGURED_ENV), false, "槽位 external + 未设总闸 = 开");
	assert.equal(
		personaInjectGatesClosed({ ...CONFIGURED_ENV, PERSONA_MEMORY_INJECT: "false" }),
		true,
		"总闸 false 关",
	);
	assert.equal(
		personaInjectGatesClosed({
			MEMORY_BANK_PATH: join(BANK_ROOT, `no-bank-${process.pid}.json`),
			AGENT_FLAGS_PATH: CONFIGURED_ENV.AGENT_FLAGS_PATH,
		}),
		true,
		"没有槽位配置 = 读闸不过",
	);
	assert.equal(
		personaInjectGatesClosed({ ...CONFIGURED_ENV, PERSONA_MEMORY_ENABLED: "false" }),
		true,
		"ENABLED=false = 读闸不过",
	);
	assert.equal(
		personaInjectGatesClosed({ ...CONFIGURED_ENV, MEMORY_BANK_PATH: BUILTIN_BANK_CONFIG }),
		true,
		"内置槽位不接大库 = 读闸不过",
	);
	const spawned = spawnJson(askJson({}));
	const envOff = { ...CONFIGURED_ENV, PERSONA_MEMORY_INJECT: "false" };
	const lines = await personaLightRecall("毕设答辩那阵子怎么样了", {
		conversationId: 1,
		env: envOff,
		spawnFn: spawned,
	});
	assert.deepEqual(lines, []);

	// env 显式 true（登记生效后同口径）：正常放行到 spawn。
	const linesOn = await personaLightRecall("毕设答辩那阵子怎么样了", {
		conversationId: 9,
		env: { ...CONFIGURED_ENV, PERSONA_MEMORY_INJECT: "true" },
		spawnFn: spawnJson(askJson({})),
	});
	assert.deepEqual(linesOn, [], "空组返回空行");
});

test("相关性门槛：关键词命中的闲聊条目被拦，直接相关 / 其它 why 放行", async () => {
	resetPersonaLightRecallForTests();
	const payload = askJson({
		memory_day: [
			// why 不含"关键词命中"：放行（时间锁理由）
			{ id: "d1", date: "2023-08-07", body: "科二已过准备考科三自己也紧张", why: "日记忆命中" },
		],
		segment: [
			// 关键词命中 + 正文与 query 有双字交集（毕设/答辩）：放行
			{
				id: "s1",
				date: "2026-03-12",
				module: "diary",
				text: "毕设答辩通过了，老师说课题还是有价值的",
				why: "关键词命中",
			},
			// 关键词命中 + 正文与 query 无双字交集：拦（闲聊 FTS 噪声）
			{
				id: "s2",
				date: "2025-07-30",
				module: "wechat_self",
				text: "考驾照的科目一二十几遍就会了刚七次最",
				why: "关键词命中",
			},
		],
	});
	const query = "毕设答辩那阵子怎么样了";
	const lines = await personaLightRecall(query, {
		conversationId: 1,
		env: CONFIGURED_ENV,
		spawnFn: spawnJson(payload),
	});
	assert.equal(lines.length, 2, "只留两条：门槛拦掉无关的 segment");
	assert.match(lines[0] ?? "", /科二已过准备考科三/);
	assert.match(lines[0] ?? "", /（memory_day）/);
	assert.match(lines[1] ?? "", /毕设答辩通过了/);
	assert.match(lines[1] ?? "", /（segment · diary）/);
});

test("echo 抑制：query 与命中正文近重复（Jaccard ≥0.8 或正文含 query 全文）→ 0 条", async () => {
	resetPersonaLightRecallForTests();
	const query = "毕设答辩那天老师说了什么";
	const payload = askJson({
		fact: [
			// 正文包含 query 全文 → 抑制
			{ id: "f1", date: "2026-03-12", body: `${query}，老师说了好几次。`, why: "长期事实命中" },
			// 低相似对照（换个话题维度，不含 query 双字串）→ 放行
			{ id: "f2", date: "2026-03-12", body: "那天评委席上坐了五位老师全程很严肃", why: "长期事实命中" },
		],
		segment: [
			// Jaccard ≥0.8 的近重复：只差一两个字
			{
				id: "s1",
				date: "2026-03-12",
				text: "毕设答辩那天老师说了什么来着",
				why: "关键词命中",
			},
		],
	});
	const lines = await personaLightRecall(query, {
		conversationId: 1,
		env: CONFIGURED_ENV,
		spawnFn: spawnJson(payload),
	});
	assert.equal(lines.length, 1, "含全文与近重复的抑制，只留对照条");
	assert.match(lines[0] ?? "", /评委席/);
});

test("限额截断：>3 条截 3、单条 >120 字带省略号、总预算 800 字", async () => {
	resetPersonaLightRecallForTests();
	const longBody = `毕设相关的长记录${"甲".repeat(200)}尾部标记`;
	const payload = askJson({
		memory_day: [
			{ id: "d1", date: "2023-08-07", body: "毕设记录一", why: "日记忆命中" },
			{ id: "d2", date: "2023-08-08", body: longBody, why: "日记忆命中" },
			{ id: "d3", date: "2023-08-09", body: "毕设记录三", why: "日记忆命中" },
			{ id: "d4", date: "2023-08-10", body: "毕设记录四", why: "日记忆命中" },
		],
	});
	const query = "毕设那年发生了什么";
	const lines = await personaLightRecall(query, {
		conversationId: 1,
		env: CONFIGURED_ENV,
		spawnFn: spawnJson(payload),
	});
	assert.equal(lines.length, 3, "四条截到 3");
	assert.ok(lines.every((line) => line.length <= 120), `单条 ≤120：${lines.map((l) => l.length)}`);
	assert.match(lines[1] ?? "", /…/, "长正文截断带省略号（整行预算口径，省略号在组标注前）");
	assert.ok(!lines.join("\n").includes("尾部标记"), "截断后预算外内容不出现");
	const total = lines.reduce((sum, line) => sum + line.length, 0);
	assert.ok(total <= 800, `总预算 800：实际 ${total}`);
});

test("fact 组 conf=user：标「用户亲口确认」（why 判别，与 conf=user 一一对应）", async () => {
	resetPersonaLightRecallForTests();
	const payload = askJson({
		fact: [
			{
				id: "f1",
				date: "2026-09",
				body: "毕设被说太简不止一次",
				why: "用户亲口确认·最高优先（压过模型推断）",
			},
		],
	});
	const lines = await personaLightRecall("毕设当时被怎么说来着", {
		conversationId: 1,
		env: CONFIGURED_ENV,
		spawnFn: spawnJson(payload),
	});
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /用户亲口确认）$/, "结尾标注用户亲口确认");
});

test("节流：60s 内第二次同会话不 spawn（复用上次结果）；不同会话不受限", async () => {
	resetPersonaLightRecallForTests();
	let spawnCount = 0;
	const base = spawnJson(askJson({ memory_day: [{ id: "d1", date: "2023-08-07", body: "毕设记录一", why: "日记忆命中" }] }));
	const spawnFn = ((...args: Parameters<typeof spawn>) => {
		spawnCount += 1;
		return (base as (...a: unknown[]) => ReturnType<typeof spawn>)(...args);
	}) as unknown as typeof spawn;
	const query = "毕设答辩那阵子怎么样了";
	const clock = { t: 1_000_000 };
	const now = () => clock.t;

	const first = await personaLightRecall(query, {
		conversationId: 7,
		env: CONFIGURED_ENV,
		spawnFn,
		now,
	});
	assert.equal(first.length, 1);
	assert.equal(spawnCount, 1);

	const second = await personaLightRecall(query, {
		conversationId: 7,
		env: CONFIGURED_ENV,
		spawnFn,
		now,
	});
	assert.deepEqual(second, first, "60s 内复用上次结果");
	assert.equal(spawnCount, 1, "第二次不 spawn");

	clock.t += 61_000;
	const third = await personaLightRecall(query, {
		conversationId: 7,
		env: CONFIGURED_ENV,
		spawnFn,
		now,
	});
	assert.deepEqual(third, first);
	assert.equal(spawnCount, 2, "过 60s 再 spawn");

	const other = await personaLightRecall(query, {
		conversationId: 8,
		env: CONFIGURED_ENV,
		spawnFn,
		now,
	});
	assert.deepEqual(other, first);
	assert.equal(spawnCount, 3, "不同会话不受 7 号会话节流影响");
});

test("失败降级：ask.py 非零退出 / 非 JSON → 空数组，不抛", async () => {
	resetPersonaLightRecallForTests();
	// 非 JSON：spawnJson 喂坏输出，askPersona 走 parse 失败 → ok:false → []
	const bad = await personaLightRecall("毕设答辩那阵子怎么样了", {
		conversationId: 11,
		env: CONFIGURED_ENV,
		spawnFn: spawnJson("这不是 JSON"),
	});
	assert.deepEqual(bad, []);
});

test("两档超时：轻召回 spawn 的 argv 永不含 --vector；timeoutMs 生效时静默空并 kill", async () => {
	resetPersonaLightRecallForTests();
	const capture = holdingSpawn();
	const lines = await personaLightRecall("毕设答辩那阵子怎么样了", {
		conversationId: 21,
		env: CONFIGURED_ENV,
		spawnFn: capture.spawnFn,
		timeoutMs: 5,
	});
	assert.deepEqual(lines, [], "超时静默返回空（不抛、不注）");
	assert.equal(capture.calls.length, 1);
	const args = capture.calls[0]!;
	assert.ok(!args.includes("--vector"), "轻召回永远不传 --vector");
	assert.equal(args.at(-1), "2", "argv 末尾仍是 --limit 2，没有追加任何开关");
	assert.equal(capture.killed(), true, "超时要 kill 子进程");
});

test("memoryLight 接线：总开关开时 policy 预算传给轻召回 spawn；关 = 旧 lightMs", async () => {
	resetPersonaLightRecallForTests();
	resetToolPolicyCacheForTests();
	const policyDir = mkdtempSync(join(tmpdir(), "lifediary-persona-inject-policy-"));
	const policyPath = join(policyDir, "tool-policy.json");
	writeFileSync(
		policyPath,
		`${JSON.stringify({ v: 1, tools: {}, groups: {}, injections: { memoryLight: { timeoutMs: 500 } } })}\n`,
		"utf8",
	);
	const env: NodeJS.ProcessEnv = {
		...CONFIGURED_ENV,
		TOOL_POLICY_PATH: policyPath,
		TOOL_TIMEOUT_POLICY: "true",
	};
	// 生效值：policy 500 覆盖 legacy lightMs 8000（6000 的语义相同，这里用 500 = 下限，测试只等 0.5s）。
	assert.equal(memoryLightTimeoutMs(8_000, env), 500, "policy 覆盖 legacy lightMs");
	const capture = holdingSpawn();
	const startedAt = Date.now();
	const lines = await personaLightRecall("毕设答辩那阵子怎么样了", {
		conversationId: 22,
		env,
		spawnFn: capture.spawnFn,
		timeoutMs: memoryLightTimeoutMs(8_000, env),
	});
	const elapsed = Date.now() - startedAt;
	assert.deepEqual(lines, [], "超时按策略预算静默返回空");
	assert.equal(capture.killed(), true, "到 policy 预算就 kill 子进程");
	assert.ok(elapsed >= 450, `应约 500ms 超时（实际 ${elapsed}ms）`);
	assert.ok(elapsed < 2_000, `不应回落到 legacy 8000ms（实际 ${elapsed}ms）`);

	// 总开关关：同一份 policy 文件也不读，仍用 legacy lightMs。
	const offEnv: NodeJS.ProcessEnv = { ...CONFIGURED_ENV, TOOL_POLICY_PATH: policyPath };
	assert.equal(memoryLightTimeoutMs(8_000, offEnv), 8_000, "master 关 = 旧 lightMs（逐字节旧行为）");
	// 总开关开但 policy 没有该条目：回落 legacy。
	const emptyPath = join(policyDir, "tool-policy-empty.json");
	writeFileSync(emptyPath, `${JSON.stringify({ v: 1, tools: {}, groups: {}, injections: {} })}\n`, "utf8");
	assert.equal(
		memoryLightTimeoutMs(8_000, { ...CONFIGURED_ENV, TOOL_POLICY_PATH: emptyPath, TOOL_TIMEOUT_POLICY: "true" }),
		8_000,
		"policy 无条目 → 回落 lightMs",
	);
});

test("catalog 裁剪：超预算砍空月行，再超硬截断带省略号", () => {
	const ok = ["库里 100 个事件", "常提的人：a、b", "高频对象：x"];
	assert.equal(personaCatalogTrim(ok), ok.join("\n"), "不超预算原样");
	const withGaps = [...ok, "空月 6 个：2021-01、2021-02、2021-03、2021-04、2021-05、2021-06"];
	const trimmed = personaCatalogTrim(withGaps, ok.join("\n").length + 1);
	assert.ok(!trimmed.includes("空月"), "超预算先砍空月行");
	assert.ok(trimmed.length <= ok.join("\n").length + 1);
	const tiny = personaCatalogTrim(["x".repeat(50), "y".repeat(50)], 60);
	assert.match(tiny, /…$/, "还超就硬截断带省略号");
	assert.ok(tiny.length <= 60);
});
