import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { spawn } from "node:child_process";
import {
	askPersona,
	askPersonaAvailable,
	parsePersonaAskOutput,
	personaAskEnabled,
	type PersonaAskResult,
} from "./persona-ask.ts";
import { createTools, type PersonaRecallResult } from "./tools.ts";

/**
 * persona-metric 检索（2026-11-09 persona 接入批一）单测。
 *
 * 不真起 python：用假 child_process 断言 argv 拼装、正常解析、非 JSON / 超时 / 启动失败降级；
 * 再用替身验证工具注册与渲染。真实链路留给探针（真 python + 真 ask.py）。
 */

// 工具执行会问「是不是群会话」：把 PartnersStore 指到临时目录，不碰真实 .data。
process.env.PARTNERS_DB_PATH = join(tmpdir(), `lifediary-persona-ask-${process.pid}.sqlite`);
process.env.PARTNER_HOMES_ROOT = join(tmpdir(), `lifediary-persona-ask-homes-${process.pid}`);

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(): boolean {
		this.killed = true;
		return true;
	}

	out(text: string): void {
		this.stdout.emit("data", Buffer.from(text, "utf8"));
	}

	err(text: string): void {
		this.stderr.emit("data", Buffer.from(text, "utf8"));
	}

	close(code: number): void {
		this.emit("close", code);
	}
}

interface SpawnCall {
	command: string;
	args: string[];
	options: Record<string, unknown> | undefined;
}

function fakeSpawn(): { spawnFn: typeof spawn; calls: SpawnCall[]; child: () => FakeChild } {
	const calls: SpawnCall[] = [];
	let child: FakeChild | undefined;
	const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
		calls.push({ command, args, options });
		child = new FakeChild();
		return child;
	}) as unknown as typeof spawn;
	return {
		spawnFn,
		calls,
		child: () => {
			assert.ok(child, "spawn 应已被调用");
			return child;
		},
	};
}

const CONFIGURED_ENV = {
	PERSONA_MEMORY_ASK: "D:\\persona-metric\\analysis\\ask.py",
	PERSONA_PYTHON: "py3",
};

test("persona-ask：argv 数组拼装、正常 JSON 映射为证据条目", async () => {
	const fake = fakeSpawn();
	const pending = askPersona("查一下 2024 年秋天在忙什么", { limit: 3 }, {
		env: CONFIGURED_ENV,
		spawnFn: fake.spawnFn,
	});

	assert.equal(fake.calls.length, 1);
	const call = fake.calls[0]!;
	assert.equal(call.command, "py3", "python 命令来自 PERSONA_PYTHON");
	assert.deepEqual(call.args, [
		"D:\\persona-metric\\analysis\\ask.py",
		"查一下 2024 年秋天在忙什么",
		"--json",
		"--limit",
		"3",
	]);
	assert.equal(call.options?.windowsHide, true, "不弹窗口");

	fake.child().out(
		JSON.stringify({
			question: "查一下 2024 年秋天在忙什么",
			qtype: "fact_recall",
			groups: {
				memory_day: [
					{
						id: "mem-day-2024-10-06",
						date: "2024-10-06",
						title: "四级备考方案调整",
						body: "决定放弃购买 70 多元的题库，改用星火英语资料。",
						conf: "high",
						n_seg: 5,
						why: "日记忆命中",
					},
				],
				segment: [
					{
						id: "seg-wx-2024-10-06",
						date: "2024-10-06",
						module: "wechat_self",
						kind: "question",
						text: "考四级的吗 买了星火那个",
						why: "关键词命中",
					},
				],
				event: [],
				fact: [],
				entity: [],
				tension: [],
			},
			unknown: "时间范围未确定：按全时段检索，不能据此说「那段时间没发生」",
			coverage: {
				not_searched: ["event（本类型不用）"],
				not_indexed: ["audio（未采集）"],
				gaps: [],
				gap_months: ["2021-01"],
			},
		}),
	);
	fake.child().close(0);

	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.qtype, "fact_recall");
	assert.deepEqual(Object.keys(result.groups ?? {}).sort(), ["memory_day", "segment"], "空组不保留");
	assert.deepEqual(result.groups?.memory_day?.[0], {
		id: "mem-day-2024-10-06",
		date: "2024-10-06",
		title: "四级备考方案调整",
		text: "决定放弃购买 70 多元的题库，改用星火英语资料。",
		why: "日记忆命中",
	});
	assert.deepEqual(result.groups?.segment?.[0], {
		id: "seg-wx-2024-10-06",
		date: "2024-10-06",
		text: "考四级的吗 买了星火那个",
		kind: "question",
		source: "wechat_self",
		why: "关键词命中",
	});
	assert.equal(result.coverage?.gap_months?.[0], "2021-01", "实测字段 gap_months 也要透传");
	assert.match(result.unknown ?? "", /不能据此说/);
});

test("persona-ask：limit 收敛到 1..20，默认 5", async () => {
	const fake = fakeSpawn();
	const pending = askPersona("四级", { limit: 99 }, { env: CONFIGURED_ENV, spawnFn: fake.spawnFn });
	assert.equal(fake.calls[0]!.args.at(-1), "20", "上限 20");
	fake.child().out('{"groups":{"memory_day":[]}}');
	fake.child().close(0);
	await pending;

	const fake2 = fakeSpawn();
	const pending2 = askPersona("四级", {}, { env: CONFIGURED_ENV, spawnFn: fake2.spawnFn });
	assert.equal(fake2.calls[0]!.args.at(-1), "5", "默认 5");
	fake2.child().out('{"groups":{"memory_day":[]}}');
	fake2.child().close(0);
	await pending2;
});

test("persona-ask：非 JSON / 结构不符一律 ok:false，不抛", async () => {
	const fake = fakeSpawn();
	const pending = askPersona("四级", {}, { env: CONFIGURED_ENV, spawnFn: fake.spawnFn });
	fake.child().out("Traceback? no, 这不是 JSON");
	fake.child().close(0);
	const result = await pending;
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /无法解析/);

	assert.equal(parsePersonaAskOutput("{}", "q").ok, false, "缺 groups 结构不符");
	assert.equal(parsePersonaAskOutput('{"groups":[]}', "q").ok, false, "groups 不是对象");
	assert.equal(
		parsePersonaAskOutput('{"groups":{"memory_day":{}}}', "q").ok,
		false,
		"组不是数组",
	);
});

test("persona-ask：超时 kill 并返回结构化失败", async () => {
	const fake = fakeSpawn();
	const result = await askPersona("四级", {}, { env: CONFIGURED_ENV, spawnFn: fake.spawnFn, timeoutMs: 10 });
	assert.equal(result.ok, false);
	assert.equal(result.error, "persona 检索超时（15s）");
	assert.equal(fake.child().killed, true, "超时要 kill 子进程");
});

test("persona-ask：未配置 / 显式关闭 → 禁用且不 spawn", async () => {
	const fake = fakeSpawn();
	const disabled = await askPersona("四级", {}, { env: {}, spawnFn: fake.spawnFn });
	assert.equal(disabled.ok, false);
	assert.match(disabled.error ?? "", /未启用/);
	assert.equal(fake.calls.length, 0, "未配置不应起进程");

	const off = await askPersona("四级", {}, {
		env: { ...CONFIGURED_ENV, PERSONA_MEMORY_ENABLED: "false" },
		spawnFn: fake.spawnFn,
	});
	assert.equal(off.ok, false);
	assert.equal(fake.calls.length, 0, "ENABLED=false 不应起进程");

	assert.equal(askPersonaAvailable({}), false);
	assert.equal(askPersonaAvailable(CONFIGURED_ENV), true);
	assert.equal(personaAskEnabled({}), true);
	assert.equal(personaAskEnabled({ PERSONA_MEMORY_ENABLED: "off" }), false);
});

test("persona-ask：非零退出带退出码与 stderr 第一行；启动失败也降级", async () => {
	const fake = fakeSpawn();
	const pending = askPersona("四级", {}, { env: CONFIGURED_ENV, spawnFn: fake.spawnFn });
	fake.child().err("Traceback (most recent call last):\n  File \"C:\\\\secret\\\\ask.py\"");
	fake.child().close(1);
	const result = await pending;
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /退出码 1/);
	assert.match(result.error ?? "", /Traceback/);
	assert.ok(!(result.error ?? "").includes("secret"), "只取第一行，不带后续本机路径");

	const fake2 = fakeSpawn();
	const pending2 = askPersona("四级", {}, { env: CONFIGURED_ENV, spawnFn: fake2.spawnFn });
	fake2.child().emit("error", new Error("spawn py3 ENOENT"));
	const failed = await pending2;
	assert.equal(failed.ok, false);
	assert.match(failed.error ?? "", /启动失败/);
});

// ── 工具注册与渲染 ─────────────────────────────────────────

const BASE_DEPS = { memory: null, scopeOf: () => ({ type: "global" as const }) };

function personaTool(personaAsk: ToolDepsPersonaAsk) {
	return createTools({ ...BASE_DEPS, personaAsk }).find((tool) => tool.name === "persona_recall");
}

type ToolDepsPersonaAsk = ((question: string, options?: { limit?: number }) => Promise<PersonaRecallResult>) | null;

async function runPersonaTool(
	tool: NonNullable<ReturnType<typeof personaTool>>,
	args: Record<string, unknown>,
): Promise<string> {
	const result = await tool.execute(args as never, { conversationId: 1 } as never, {} as never);
	const text = (result.output ?? [])
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("");
	// 批次三（2026-11-13 工具层结果契约化）：persona_recall 迁 ToolResult，输出是一行 JSON。
	// 人读正文仍在 message 里，断言口径不变。
	const parsed = JSON.parse(text) as {
		ok: boolean;
		data?: { message?: string };
		error?: { message?: string };
	};
	return parsed.ok ? (parsed.data?.message ?? "") : (parsed.error?.message ?? text);
}

function okResult(over: Partial<PersonaAskResult> = {}): PersonaAskResult {
	return { ok: true, question: "q", ...over };
}

test("persona_recall：deps 不传时工具不注册（回滚形态）", () => {
	assert.equal(personaTool(null), undefined);
	assert.ok(personaTool(async () => okResult()), "注入替身后应上架");
});

test("persona_recall：按组渲染、正文截 160 字、unknown 与时段缺口原文附上", async () => {
	const longBody = `${"甲".repeat(200)}尾部标记`;
	const tool = personaTool(async () =>
		okResult({
			groups: {
				memory_day: [
					{
						id: "mem-day-2024-10-06",
						date: "2024-10-06",
						title: "四级备考方案调整",
						text: longBody,
					},
				],
				segment: [
					{ id: "seg-1", date: "2024-10-06", text: "考四级的吗", kind: "question", source: "wechat_self" },
				],
			},
			unknown: "时间范围未确定：不能据此说「那段时间没发生」",
			coverage: { gaps: ["2022-03"], gap_months: ["2021-01"] },
		}),
	);
	assert.ok(tool);
	const output = await runPersonaTool(tool, { query: "2024 年秋天在忙什么", limit: 5 });

	assert.match(output, /^- \[日记忆\] 2024-10-06｜四级备考方案调整：甲/m);
	assert.ok(output.includes("（mem-day-2024-10-06）"), "带出处 id");
	assert.ok(output.includes("…"), "长正文应截断");
	assert.ok(!output.includes("尾部标记"), "160 字以后的内容不应出现");
	assert.match(output, /- \[片段\] 2024-10-06｜考四级的吗（seg-1）/);
	assert.ok(output.includes("\n\n注意：时间范围未确定"), "unknown 原文透传");
	assert.ok(output.includes("记忆库在这些时段没有记录：2022-03、2021-01"));
	assert.ok(/（seg-1）\n\n注意：/.test(output) || output.includes("\n\n注意："), "组间空行");
});

test("persona_recall：全空与 ok:false 各给固定文案", async () => {
	const emptyTool = personaTool(async () => okResult());
	assert.ok(emptyTool);
	assert.equal(await runPersonaTool(emptyTool, { query: "没有的事" }), "个人记忆库里没有查到相关记录。");

	const failedTool = personaTool(async () => ({ ok: false, question: "q", error: "内部细节" }));
	assert.ok(failedTool);
	const failed = await runPersonaTool(failedTool, { query: "四级" });
	assert.equal(
		failed,
		"个人记忆库暂时查不了（原因已记日志），你可以说说想确认什么，我换个方式找。",
	);
	assert.ok(!failed.includes("内部细节"), "不把内部错误细节透给模型");

	const throwingTool = personaTool(async () => {
		throw new Error("boom");
	});
	assert.ok(throwingTool);
	assert.match(await runPersonaTool(throwingTool, { query: "四级" }), /暂时查不了/);
});
