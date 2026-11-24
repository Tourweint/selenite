import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { spawn } from "node:child_process";
import {
	askPersona,
	askPersonaAvailable,
	askPersonaCatalog,
	parsePersonaAskOutput,
	personaAskEnabled,
} from "./persona-ask.ts";
import { renderPersonaAsk } from "./tools.ts";

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

test("persona-ask：command 模式用指定运行器，不依赖 PERSONA_MEMORY_ASK", async () => {
	const fake = fakeSpawn();
	const pending = askPersona("问题", {}, {
		env: { PERSONA_MEMORY_ENABLED: "true" },
		command: ["node", "D:\\bank\\ask.js"],
		cwd: "D:\\bank",
		spawnFn: fake.spawnFn,
	});
	assert.equal(fake.calls[0]?.command, "node");
	assert.deepEqual(fake.calls[0]?.args, ["D:\\bank\\ask.js", "问题", "--json", "--limit", "5"]);
	assert.equal(fake.calls[0]?.options?.cwd, "D:\\bank");
	fake.child().out('{"groups":{"memory_day":[]}}');
	fake.child().close(0);
	const result = await pending;
	assert.equal(result.ok, true);
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
	assert.equal(result.timedOut, undefined, "非超时失败不置 timedOut");

	assert.equal(parsePersonaAskOutput("{}", "q").ok, false, "缺 groups 结构不符");
	assert.equal(parsePersonaAskOutput('{"groups":[]}', "q").ok, false, "groups 不是对象");
	assert.equal(
		parsePersonaAskOutput('{"groups":{"memory_day":{}}}', "q").ok,
		false,
		"组不是数组",
	);
});

test("persona-ask：外接库 anyGroups 接受任意组名与空 groups（组名不固定）", () => {
	const arbitrary = parsePersonaAskOutput(
		JSON.stringify({
			groups: { notes: [{ id: "n1", date: "2024-01-01", text: "正文", why: "命中" }] },
			coverage: { gaps: ["2022-01"] },
			unknown: "查不到 ≠ 没有",
		}),
		"q",
		{ anyGroups: true },
	);
	assert.equal(arbitrary.ok, true);
	assert.equal(arbitrary.hits?.length, 1);
	assert.equal(arbitrary.hits?.[0].group, "notes");
	assert.equal(arbitrary.hits?.[0].text, "正文");
	assert.deepEqual(arbitrary.coverage?.gaps, ["2022-01"]);

	const empty = parsePersonaAskOutput('{"groups":{}}', "q", { anyGroups: true });
	assert.equal(empty.ok, true, "空 groups 是合法空结果");
	assert.deepEqual(empty.hits, []);

	assert.equal(
		parsePersonaAskOutput('{"groups":{"notes":{}}}', "q", { anyGroups: true }).ok,
		false,
		"组值不是数组仍按结构不符",
	);
});

test("persona-ask：vector 不传 / false → argv 与旧版逐字节相同；true → 末尾追加 --vector", async () => {
	const base = [
		"D:\\persona-metric\\analysis\\ask.py",
		"问题",
		"--json",
		"--limit",
		"5",
	];

	const plain = fakeSpawn();
	const plainPending = askPersona("问题", {}, { env: CONFIGURED_ENV, spawnFn: plain.spawnFn });
	assert.deepEqual(plain.calls[0]!.args, base, "不传 vector = 旧 argv");
	plain.child().out('{"groups":{"memory_day":[]}}');
	plain.child().close(0);
	await plainPending;

	const off = fakeSpawn();
	const offPending = askPersona("问题", { vector: false }, { env: CONFIGURED_ENV, spawnFn: off.spawnFn });
	assert.deepEqual(off.calls[0]!.args, base, "vector:false 也不加 --vector");
	off.child().out('{"groups":{"memory_day":[]}}');
	off.child().close(0);
	await offPending;

	const on = fakeSpawn();
	const onPending = askPersona("问题", { vector: true }, { env: CONFIGURED_ENV, spawnFn: on.spawnFn });
	assert.deepEqual(on.calls[0]!.args, [...base, "--vector"], "--vector 追加在 --limit N 之后（末尾）");
	on.child().out('{"groups":{"memory_day":[]}}');
	on.child().close(0);
	await onPending;
});

test("persona-ask：库不认 --vector（exit 2 + argparse 拒绝）→ 自动退回普通检索一次并标记", async () => {
	const base = [
		"D:\\persona-metric\\analysis\\ask.py",
		"问题",
		"--json",
		"--limit",
		"5",
	];
	const fake = fakeSpawn();
	const pending = askPersona("问题", { vector: true }, { env: CONFIGURED_ENV, spawnFn: fake.spawnFn });
	assert.deepEqual(fake.calls[0]!.args, [...base, "--vector"], "第一次带 --vector");
	fake.child().err("usage: ask.py [-h] [question]\nask.py: error: unrecognized arguments: --vector\n");
	fake.child().close(2);
	// 第一次结果落地后才会起第二次：让微任务队列刷新到下一次 spawn。
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(fake.calls.length, 2, "只重试一次");
	assert.deepEqual(fake.calls[1]!.args, base, "第二次不带 --vector（同一命令的普通检索）");
	fake.child().out('{"groups":{"memory_day":[]}}');
	fake.child().close(0);
	const result = await pending;
	assert.equal(result.ok, true, "重试成功照常返回");
	assert.equal(result.vectorUnsupported, true, "结果带 vectorUnsupported 留痕");
});

test("persona-ask：带 --vector 但超时 → 不重试（spawn 只调一次）", async () => {
	const fake = fakeSpawn();
	const result = await askPersona("问题", { vector: true }, {
		env: CONFIGURED_ENV,
		spawnFn: fake.spawnFn,
		timeoutMs: 5,
	});
	assert.equal(result.ok, false);
	assert.equal(result.timedOut, true);
	assert.equal(result.vectorUnsupported, undefined, "超时不是「库不认 --vector」");
	assert.equal(fake.calls.length, 1, "超时不重试（避免再等一个 timeoutMs）");
});

test("persona-ask：带 --vector 的其它失败（非 argparse 参数拒绝）→ 不重试", async () => {
	const fake = fakeSpawn();
	const pending = askPersona("问题", { vector: true }, { env: CONFIGURED_ENV, spawnFn: fake.spawnFn });
	fake.child().err("Traceback: boom");
	fake.child().close(1);
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.vectorUnsupported, undefined);
	assert.equal(fake.calls.length, 1, "只有参数拒绝才重试");
});

test("persona-ask：--catalog-only 永不带 --vector（目录不是检索）", async () => {
	const fake = fakeSpawn();
	const pending = askPersonaCatalog({
		env: { PERSONA_MEMORY_ENABLED: "true" },
		command: ["py3", "D:\\bank-catalog-test\\ask.py"],
		spawnFn: fake.spawnFn,
	});
	assert.deepEqual(fake.calls[0]!.args, ["D:\\bank-catalog-test\\ask.py", "--catalog-only"]);
	fake.child().out("库边界一行");
	fake.child().close(0);
	const result = await pending;
	assert.equal(result.ok, true);
	assert.deepEqual(result.lines, ["库边界一行"]);
});

test("persona-ask：超时 kill 并返回结构化失败（文案跟随实际预算）", async () => {	const fake = fakeSpawn();
	const result = await askPersona("四级", {}, { env: CONFIGURED_ENV, spawnFn: fake.spawnFn, timeoutMs: 10 });
	assert.equal(result.ok, false);
	assert.equal(result.error, "persona 检索超时（0s）", "10ms → Math.round(10/1000)=0s（不再是硬编码 15s）");
	assert.equal(result.timedOut, true, "超时分支置 timedOut 标记");
	assert.equal(fake.child().killed, true, "超时要 kill 子进程");

	// 真实秒级预算：文案跟着 timeoutMs 走（Math.round）。
	const fakeSlow = fakeSpawn();
	const slow = await askPersona("四级", {}, {
		env: CONFIGURED_ENV,
		spawnFn: fakeSlow.spawnFn,
		timeoutMs: 1_200,
	});
	assert.equal(slow.ok, false);
	assert.equal(slow.error, "persona 检索超时（1s）", "1200ms → 1s");
	assert.equal(slow.timedOut, true);
	assert.equal(fakeSlow.child().killed, true);
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

test("persona-ask：vector 被拒后的重试与第一次共享同一个 deadline（总耗时不翻倍）", async () => {
	const fake = fakeSpawn();
	const startedAt = Date.now();
	const pending = askPersona("问题", { vector: true }, {
		env: CONFIGURED_ENV,
		spawnFn: fake.spawnFn,
		timeoutMs: 1_500,
	});
	// 第一次尝试：用掉约 600ms 后以 argparse 拒绝的方式退出（库不认识 --vector）。
	await new Promise<void>((resolve) => setTimeout(resolve, 600));
	const first = fake.child();
	first.err("usage: ask.py [-h] [question]\nask.py: error: unrecognized arguments: --vector\n");
	first.close(2);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(fake.calls.length, 2, "只重试一次");
	// 第二次不再关闭：只剩 ~700ms 预算，到点必须被 kill（旧行为会再给满 1200ms）。
	const result = await pending;
	const elapsed = Date.now() - startedAt;
	assert.equal(result.ok, false);
	assert.equal(result.timedOut, true);
	assert.equal(result.vectorUnsupported, true, "重试结果仍带 vectorUnsupported 留痕");
	assert.equal(fake.child().killed, true, "第二次尝试被同一 deadline 杀掉");
	assert.ok(elapsed < 1_900, `总耗时 ${elapsed}ms 应接近一次预算（1500ms），而不是 2×`);
});

test("persona-ask 日志：anyGroups 的命中数取 result.hits（不再恒 0）", async () => {
	const fake = fakeSpawn();
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		const pending = askPersona("问题", { anyGroups: true }, {
			env: CONFIGURED_ENV,
			spawnFn: fake.spawnFn,
		});
		fake.child().out(
			JSON.stringify({ groups: { notes: [{ id: "n1", text: "a" }, { id: "n2", text: "b" }] } }),
		);
		fake.child().close(0);
		const result = await pending;
		assert.equal(result.hits?.length, 2);
	} finally {
		console.log = original;
	}
	assert.ok(
		lines.some((line) => line.includes("[persona-ask]") && line.includes("hits=2")),
		`日志应记 hits=2，实际：${lines.join(" | ")}`,
	);
});

// ── 结果渲染（2026-11-24：persona_recall 工具退役后，渲染函数仍由 recall 外部槽使用）──

test("renderPersonaAsk：按组渲染、正文截 160 字、unknown 与时段缺口原文附上", () => {
	const longBody = `${"甲".repeat(200)}尾部标记`;
	const output = renderPersonaAsk({
		ok: true,
		question: "q",
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
	});

	assert.match(output, /^- \[日记忆\] 2024-10-06｜四级备考方案调整：甲/m);
	assert.ok(output.includes("（mem-day-2024-10-06）"), "带出处 id");
	assert.ok(output.includes("…"), "长正文应截断");
	assert.ok(!output.includes("尾部标记"), "160 字以后的内容不应出现");
	assert.match(output, /- \[片段\] 2024-10-06｜考四级的吗（seg-1）/);
	assert.ok(output.includes("\n\n注意：时间范围未确定"), "unknown 原文透传");
	assert.ok(output.includes("记忆库在这些时段没有记录：2022-03、2021-01"));
	assert.ok(/（seg-1）\n\n注意：/.test(output) || output.includes("\n\n注意："), "组间空行");
});

test("renderPersonaAsk：全空给固定文案", () => {
	assert.equal(renderPersonaAsk({ ok: true, question: "q" }), "个人记忆库里没有查到相关记录。");
});
