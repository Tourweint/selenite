import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { spawn } from "node:child_process";
import {
	activeBank,
	bankAsk,
	bankTimeouts,
	bankWritable,
	bankWrite,
	DEFAULT_MEMORY_BANK_TIMEOUTS,
	deleteExternalBank,
	memoryBankState,
	probeBank,
	readMemoryBankConfig,
	resetMemoryBankCacheForTests,
	resolveExternalBank,
	setActiveBank,
	setExternalBank,
	setMemoryBankTimeouts,
	type ExternalBankRecord,
} from "./memory-bank.ts";
import { resetToolPolicyCacheForTests } from "./tool-policy.ts";

/**
 * 记忆库槽位（2026-11-23 外部记忆库接入）单测。
 *
 * 不真起 python：ask/repair 的 argv 与降级留在 persona-ask / persona-write 自己的单测；
 * 这里验槽位配置、路径推导 / 逃逸、只读库、探测失败与删除当前库。真链路在
 * `scripts/memory-bank-probe.ts`（真起服务 + 假脚本）。
 */

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
}

/** 假 spawn：catalog 的成功响应由 answerCatalog 推。 */
function fakeSpawn(): { spawnFn: typeof spawn; calls: SpawnCall[]; child: () => FakeChild } {
	const calls: SpawnCall[] = [];
	let child: FakeChild | undefined;
	const spawnFn = ((command: string, args: string[]) => {
		calls.push({ command, args });
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

/** 一个最小 bank 目录：ask.py 必有；repair.py 按参数。 */
function makeBank(prefix: string, withRepair = false): { root: string; ask: string; repair: string } {
	const root = mkdtempSync(join(tmpdir(), `lifediary-${prefix}-`));
	const ask = join(root, "ask.py");
	const repair = join(root, "repair.py");
	writeFileSync(ask, "# fake ask\n", "utf8");
	if (withRepair) writeFileSync(repair, "# fake repair\n", "utf8");
	return { root, ask, repair };
}

function envFor(configPath: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { MEMORY_BANK_PATH: configPath, PERSONA_MEMORY_ASK: "", ...over };
}

/** catalog 探测成功：stdout 两行 + exit 0。 */
function answerCatalog(fake: ReturnType<typeof fakeSpawn>, lines = ["测试库：2 条记录", "人物：姥姥"]): void {
	fake.child().out(lines.join("\n"));
	fake.child().close(0);
}

test("memory-bank：文件不存在时按 PERSONA_MEMORY_ASK 播种，active 仍是 builtin", () => {
	resetMemoryBankCacheForTests();
	const dir = mkdtempSync(join(tmpdir(), "lifediary-bank-seed-"));
	const configPath = join(dir, "memory-bank.json");
	mkdirSync(join(dir, "analysis"), { recursive: true });
	const ask = join(dir, "analysis", "ask.py");
	writeFileSync(ask, "", "utf8");
	const env = envFor(configPath, { PERSONA_MEMORY_ASK: ask });

	const config = readMemoryBankConfig(env);
	assert.equal(config.active, "builtin", "播种后 active 仍为 builtin");
	assert.equal(config.external?.origin, "env");
	assert.equal(config.external?.root, dir, "analysis/ask.py 的 root 应上溯一层");
	assert.equal(config.external?.ask, "analysis/ask.py");
	assert.equal(config.external?.repair, "", "没有写入口 = 只读库");
	assert.ok(existsSync(configPath), "首次播种应落盘");
});

test("memory-bank：root/ask.py 形态把脚本目录当 root", async () => {
	resetMemoryBankCacheForTests();
	const bank = makeBank("bank-direct");
	const configPath = join(bank.root, "config.json");
	const fake = fakeSpawn();
	const pending = probeBank(bank.root, { env: envFor(configPath), spawnFn: fake.spawnFn });
	answerCatalog(fake);
	const probe = await pending;
	assert.equal(probe.ok, true);
	assert.equal(probe.status, "missing_repair", "没有 repair.py = 只读库");
	assert.equal(probe.ask, "ask.py");
	assert.equal(probe.repair, undefined, "没有写入口 = 只读库");
});

test("memory-bank：多语言入口 ask.js / repair.js 按扩展名选 node 运行器", async () => {
	resetMemoryBankCacheForTests();
	const root = mkdtempSync(join(tmpdir(), "lifediary-bank-js-"));
	writeFileSync(join(root, "ask.js"), "console.log('{}')", "utf8");
	writeFileSync(join(root, "repair.js"), "console.log('ok')", "utf8");
	const fake = fakeSpawn();
	const pending = probeBank(root, { env: envFor(join(root, "config.json")), spawnFn: fake.spawnFn });
	answerCatalog(fake);
	const probe = await pending;
	assert.equal(probe.ok, true);
	assert.equal(probe.ask, "ask.js");
	assert.equal(probe.repair, "repair.js");
	assert.equal(fake.calls[0].command, process.execPath, ".js 入口用当前 node");
	assert.equal(fake.calls[0].args[0], join(root, "ask.js"), "node 跑入口脚本本身");
});

test("memory-bank：analysis/ask.py 形态也能识别，repair 取同目录", async () => {
	resetMemoryBankCacheForTests();
	const root = mkdtempSync(join(tmpdir(), "lifediary-bank-nested-"));
	mkdirSync(join(root, "analysis"), { recursive: true });
	writeFileSync(join(root, "analysis", "ask.py"), "", "utf8");
	writeFileSync(join(root, "analysis", "repair.py"), "", "utf8");
	const fake = fakeSpawn();
	const pending = probeBank(root, { env: envFor(join(root, "config.json")), spawnFn: fake.spawnFn });
	answerCatalog(fake);
	const probe = await pending;
	assert.equal(probe.ok, true);
	assert.equal(probe.status, "ok");
	assert.equal(probe.ask, "analysis/ask.py");
	assert.equal(probe.repair, "analysis/repair.py");
});

test("memory-bank：root/ask.py 优先于 analysis/ask.py", async () => {
	resetMemoryBankCacheForTests();
	const root = mkdtempSync(join(tmpdir(), "lifediary-bank-priority-"));
	mkdirSync(join(root, "analysis"), { recursive: true });
	writeFileSync(join(root, "ask.py"), "", "utf8");
	writeFileSync(join(root, "analysis", "ask.py"), "", "utf8");
	writeFileSync(join(root, "analysis", "repair.py"), "", "utf8");
	const fake = fakeSpawn();
	const pending = probeBank(root, { env: envFor(join(root, "config.json")), spawnFn: fake.spawnFn });
	answerCatalog(fake);
	const probe = await pending;
	assert.equal(probe.ask, "ask.py", "查找顺序：root/ask.py 优先于 analysis/ask.py");
	assert.equal(probe.repair, undefined, "同目录没有写入口 = 只读库");
	assert.equal(probe.status, "missing_repair", "根目录没有 repair.py = 只读库");
});

test("memory-bank：ask/repair 相对路径逃出 root 时配置判无效、切换被拒", () => {
	resetMemoryBankCacheForTests();
	const dir = mkdtempSync(join(tmpdir(), "lifediary-bank-escape-"));
	const configPath = join(dir, "memory-bank.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			v: 1,
			active: "external",
			external: {
				id: "bank_evil",
				name: "越界库",
				root: dir,
				ask: "../outside/ask.py",
				repair: "../outside/repair.py",
				python: "",
				origin: "user",
				addedAt: "2026-11-23T20:00:00+08:00",
			},
		}),
		"utf8",
	);
	const env = envFor(configPath);
	const config = readMemoryBankConfig(env);
	assert.equal(config.external, null, "越界配置按未接入处理");
	assert.equal(config.active, "builtin", "external 无效时 active 回落 builtin");
	const switched = setActiveBank("external", env);
	assert.equal(switched.ok, false);
	assert.equal(switched.error, "no_external_bank");

	// resolveExternalBank 也直接拒绝越界相对路径（即使配置对象是手搓的）
	const evil: ExternalBankRecord = {
		id: "bank_evil",
		name: "x",
		root: dir,
		ask: "../outside.py",
		repair: "repair.py",
		python: "",
		origin: "user",
		addedAt: "2026-11-23T20:00:00+08:00",
		vector: false,
	};
	const resolution = resolveExternalBank(evil, env);
	assert.equal(resolution.ok, false);
	assert.equal(resolution.error, "outside_root");
	assert.equal(resolution.askExists, false);
});

test("memory-bank：探测失败（catalog 非零退出）→ status=error，配置不落盘", async () => {
	resetMemoryBankCacheForTests();
	const bank = makeBank("bank-probe-fail", true);
	const configPath = join(bank.root, "config.json");
	const fake = fakeSpawn();
	const pending = probeBank(bank.root, { env: envFor(configPath), spawnFn: fake.spawnFn });
	fake.child().err("Traceback: boom");
	fake.child().close(1);
	const probe = await pending;
	assert.equal(probe.ok, false);
	assert.equal(probe.status, "error");

	const state = memoryBankState(envFor(configPath));
	assert.equal(state.external, null, "探测失败不该留下配置");
});

test("memory-bank：接入只读库 → 可保存、可切换；写被拒", async () => {
	resetMemoryBankCacheForTests();
	const bank = makeBank("bank-readonly");
	const configPath = join(bank.root, "config.json");
	const env = envFor(configPath);
	const fake = fakeSpawn();
	const savePending = setExternalBank({ root: bank.root, name: "只读库" }, { env, spawnFn: fake.spawnFn });
	answerCatalog(fake);
	const saved = await savePending;
	assert.equal(saved.ok, true);
	assert.equal(saved.external?.name, "只读库");
	assert.equal(saved.external?.origin, "user");
	assert.equal(saved.external?.ask, "ask.py");
	assert.equal(activeBank(env), "builtin", "保存不自动切换");

	const switched = setActiveBank("external", env);
	assert.equal(switched.ok, true);
	assert.equal(activeBank(env), "external");
	assert.equal(bankWritable(env), false, "没有 repair.py = 只读库");
	const write = await bankWrite({ body: "原话", why: "用户让记住" }, { env });
	assert.equal(write.ok, false);

	// 打开写开关仍然不能写（没有 repair.py）
	const writeOn = await bankWrite(
		{ body: "原话", why: "用户让记住" },
		{ env: { ...env, PERSONA_WRITE_ENABLED: "true" } },
	);
	assert.equal(writeOn.ok, false);
	assert.match(writeOn.error ?? "", /只读/);
});

test("memory-bank：有 repair.py 且开关打开 → 写走 repair.py statement argv", async () => {
	resetMemoryBankCacheForTests();
	const bank = makeBank("bank-write", true);
	const configPath = join(bank.root, "config.json");
	const env = { ...envFor(configPath), PERSONA_WRITE_ENABLED: "true" };
	const saveFake = fakeSpawn();
	const savePending = setExternalBank({ root: bank.root }, { env, spawnFn: saveFake.spawnFn });
	answerCatalog(saveFake);
	const saved = await savePending;
	assert.equal(saved.ok, true);
	assert.equal(saved.probe?.status, "ok");
	assert.equal(setActiveBank("external", env).ok, true);
	assert.equal(bankWritable(env), true);

	const writeFake = fakeSpawn();
	const pending = bankWrite({ body: "住院的是姥姥", why: "用户让记住" }, { env, spawnFn: writeFake.spawnFn });
	const call = writeFake.calls[0]!;
	// 先把子进程收尾再断言：断言失败时也不留下 15s 超时计时器。
	writeFake.child().out("已记：住院的是姥姥");
	writeFake.child().close(0);
	assert.equal(call.args[0], bank.repair, "repair.py 用外接库里的那个");
	assert.equal(call.args[1], "statement");
	assert.equal(call.args[2], "住院的是姥姥");
	assert.deepEqual(call.args.slice(3), ["--why", "用户让记住"]);
	const result = await pending;
	assert.equal(result.ok, true);
	assert.match(result.statementId ?? "", /^us-[0-9a-f]{10}$/);
});

test("memory-bank：PERSONA_MEMORY_ENABLED=false → bankAsk 返回「外部记忆库已关闭」且不 spawn", async () => {
	resetMemoryBankCacheForTests();
	const bank = makeBank("bank-disabled", true);
	const configPath = join(bank.root, "config.json");
	const baseEnv = envFor(configPath);
	const saveFake = fakeSpawn();
	const savePending = setExternalBank({ root: bank.root }, { env: baseEnv, spawnFn: saveFake.spawnFn });
	answerCatalog(saveFake);
	await savePending;
	assert.equal(setActiveBank("external", baseEnv).ok, true);

	const offEnv = { ...baseEnv, PERSONA_MEMORY_ENABLED: "false" };
	const fake = fakeSpawn();
	const result = await bankAsk("四级", {}, { env: offEnv, spawnFn: fake.spawnFn });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /外部记忆库已关闭/);
	assert.equal(fake.calls.length, 0, "关闭态不应 spawn");
});

test("memory-bank：删除当前使用的库 → 先切回 builtin，external 清空", async () => {
	resetMemoryBankCacheForTests();
	const bank = makeBank("bank-delete", true);
	const configPath = join(bank.root, "config.json");
	const env = envFor(configPath);
	const fake = fakeSpawn();
	const pending = setExternalBank({ root: bank.root }, { env, spawnFn: fake.spawnFn });
	answerCatalog(fake);
	await pending;
	assert.equal(setActiveBank("external", env).ok, true);
	assert.equal(activeBank(env), "external");

	const deleted = deleteExternalBank(env);
	assert.equal(deleted.ok, true);
	assert.equal(deleted.active, "builtin");
	const config = readMemoryBankConfig(env);
	assert.equal(config.external, null);
	assert.equal(activeBank(env), "builtin");
	assert.equal(deleteExternalBank(env).ok, false, "再删 = 404");
});

test("memory-bank：active 只接受 builtin / external；未知值不改配置", () => {
	resetMemoryBankCacheForTests();
	const dir = mkdtempSync(join(tmpdir(), "lifediary-bank-active-"));
	const env = envFor(join(dir, "memory-bank.json"));
	const bogus = setActiveBank("sideways" as never, env);
	assert.equal(bogus.ok, false);
	assert.equal(bogus.error, "bad_active");
	assert.equal(activeBank(env), "builtin");
});

// ── 向量检索 + 两档超时（2026-11-24）──────────────────────────

test("memory-bank：旧配置（无 vector / timeouts，遗留 deep 忽略）按默认值工作", () => {
	resetMemoryBankCacheForTests();
	const dir = mkdtempSync(join(tmpdir(), "lifediary-bank-legacy-"));
	const configPath = join(dir, "memory-bank.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			v: 1,
			active: "builtin",
			external: {
				id: "bank_old",
				name: "老库",
				root: dir,
				ask: "ask.py",
				repair: "",
				python: "",
				origin: "user",
				addedAt: "2026-11-23T20:00:00+08:00",
				// 未发布的过渡字段：不做别名，读到也按默认 false（2026-11-24 命名统一）。
				deep: true,
			},
		}),
		"utf8",
	);
	const config = readMemoryBankConfig(envFor(configPath));
	assert.equal(config.external?.vector, false, "缺 vector = false；旧 deep:true 直接忽略");
	assert.deepEqual(config.timeouts, { ...DEFAULT_MEMORY_BANK_TIMEOUTS }, "旧文件缺 timeouts = 8000/15000");
});

test("memory-bank：timeouts 非法回落默认、越界 clamp、小数取整", () => {
	const cases: Array<[unknown, { lightMs: number; askMs: number }]> = [
		[undefined, { lightMs: 8_000, askMs: 15_000 }],
		[{ lightMs: 100, askMs: "abc" }, { lightMs: 500, askMs: 15_000 }],
		[{ lightMs: 999_999, askMs: 0 }, { lightMs: 30_000, askMs: 1_000 }],
		[{ lightMs: 12_000.4, askMs: 20_000.6 }, { lightMs: 12_000, askMs: 20_001 }],
		["garbage", { lightMs: 8_000, askMs: 15_000 }],
	];
	for (const [raw, expected] of cases) {
		const dir = mkdtempSync(join(tmpdir(), "lifediary-bank-timeouts-"));
		const configPath = join(dir, "memory-bank.json");
		writeFileSync(
			configPath,
			JSON.stringify({ v: 1, active: "builtin", external: null, ...(raw ? { timeouts: raw } : {}) }),
			"utf8",
		);
		resetMemoryBankCacheForTests();
		assert.deepEqual(
			readMemoryBankConfig(envFor(configPath)).timeouts,
			expected,
			JSON.stringify(raw),
		);
	}
});

test("memory-bank：bankAsk 按 external.vector 决定 argv 末尾是否 --vector", async () => {
	resetMemoryBankCacheForTests();
	const bank = makeBank("bank-vector", true);
	const configPath = join(bank.root, "config.json");
	const env = {
		...envFor(configPath),
		PERSONA_MEMORY_ENABLED: "true",
		PERSONA_PYTHON: "py3",
	};
	const writeConfig = (vector: boolean): void => {
		writeFileSync(
			configPath,
			JSON.stringify({
				v: 1,
				active: "external",
				external: {
					id: "bank_vector",
					name: "向量库",
					root: bank.root,
					ask: "ask.py",
					repair: "repair.py",
					python: "",
					origin: "user",
					addedAt: "2026-11-24T10:00:00+08:00",
					vector,
				},
				timeouts: { lightMs: 6_000, askMs: 9_000 },
			}),
			"utf8",
		);
		resetMemoryBankCacheForTests();
	};

	writeConfig(true);
	assert.deepEqual(bankTimeouts(env), { lightMs: 6_000, askMs: 9_000 }, "配置里的两档读出");
	const on = fakeSpawn();
	const onPending = bankAsk("旧事", { limit: 2 }, { env, spawnFn: on.spawnFn });
	assert.deepEqual(
		on.calls[0]!.args.slice(1),
		["旧事", "--json", "--limit", "2", "--vector"],
		"vector=true → 末尾追加 --vector",
	);
	on.child().out('{"groups":{}}');
	on.child().close(0);
	assert.equal((await onPending).ok, true);

	writeConfig(false);
	const off = fakeSpawn();
	const offPending = bankAsk("旧事", { limit: 2 }, { env, spawnFn: off.spawnFn });
	assert.deepEqual(
		off.calls[0]!.args.slice(1),
		["旧事", "--json", "--limit", "2"],
		"vector=false → argv 与旧版逐字节相同",
	);
	off.child().out('{"groups":{}}');
	off.child().close(0);
	assert.equal((await offPending).ok, true);
});

test("memory-bank：工具超时策略覆盖旧 timeouts.askMs（master 开）；关时仍读 askMs", async () => {
	resetMemoryBankCacheForTests();
	resetToolPolicyCacheForTests();
	const bank = makeBank("bank-policy-timeout", true);
	const configPath = join(bank.root, "config.json");
	const policyPath = join(bank.root, "tool-policy.json");
	const writeConfig = (askMs: number): void => {
		writeFileSync(
			configPath,
			JSON.stringify({
				v: 1,
				active: "external",
				external: {
					id: "bank_policy",
					name: "策略库",
					root: bank.root,
					ask: "ask.py",
					repair: "",
					python: "",
					origin: "user",
					addedAt: "2026-11-24T10:00:00+08:00",
					vector: false,
				},
				timeouts: { lightMs: 6_000, askMs },
			}),
			"utf8",
		);
		resetMemoryBankCacheForTests();
	};
	writeConfig(5_000);
	writeFileSync(
		policyPath,
		JSON.stringify({ v: 1, tools: { recall: { timeoutMs: 1_000 } }, groups: {}, injections: {} }),
		"utf8",
	);
	const env = {
		...envFor(configPath),
		PERSONA_MEMORY_ENABLED: "true",
		PERSONA_PYTHON: "py3",
		TOOL_POLICY_PATH: policyPath,
		TOOL_TIMEOUT_POLICY: "true",
	};

	const fake = fakeSpawn();
	const started = Date.now();
	const result = await bankAsk("旧事", {}, { env, spawnFn: fake.spawnFn });
	const elapsed = Date.now() - started;
	assert.equal(result.ok, false);
	assert.equal(result.timedOut, true);
	assert.match(result.error ?? "", /超时（1s）/);
	assert.ok(elapsed < 3_000, `policy 1000ms 应覆盖 legacy 5000ms（实际 ${elapsed}ms）`);
	assert.equal(fake.child().killed, true);

	// 总开关关：回到旧 timeouts.askMs（1200ms → Math.round 1s），policy 文件不读。
	resetToolPolicyCacheForTests();
	writeConfig(1_200);
	const offEnv = { ...env, TOOL_TIMEOUT_POLICY: "false" };
	const offFake = fakeSpawn();
	const offStarted = Date.now();
	const off = await bankAsk("旧事", {}, { env: offEnv, spawnFn: offFake.spawnFn });
	const offElapsed = Date.now() - offStarted;
	assert.equal(off.timedOut, true);
	assert.match(off.error ?? "", /超时（1s）/, "1200ms → 1s（旧 askMs 仍生效）");
	assert.ok(offElapsed < 3_000, `旧路径按 askMs 超时（实际 ${offElapsed}ms）`);
	assert.equal(offFake.child().killed, true);
});

test("memory-bank：setMemoryBankTimeouts 局部更新、clamp、保留未知字段", () => {
	resetMemoryBankCacheForTests();
	const dir = mkdtempSync(join(tmpdir(), "lifediary-bank-save-limits-"));
	const configPath = join(dir, "memory-bank.json");
	const env = envFor(configPath);
	writeFileSync(
		configPath,
		JSON.stringify({
			v: 1,
			active: "builtin",
			external: {
				id: "bank_future",
				name: "未来库",
				root: dir,
				ask: "ask.py",
				repair: "",
				python: "",
				origin: "user",
				addedAt: "2026-11-24T10:00:00+08:00",
				futureBankField: "keep-me",
			},
			timeouts: { lightMs: 8_000, askMs: 15_000 },
			futureTop: { a: 1 },
		}),
		"utf8",
	);

	const partial = setMemoryBankTimeouts({ lightMs: 12_000 }, env);
	assert.equal(partial.ok, true);
	assert.deepEqual(partial.timeouts, { lightMs: 12_000, askMs: 15_000 }, "只改 lightMs，askMs 不动");
	assert.deepEqual(bankTimeouts(env), { lightMs: 12_000, askMs: 15_000 });

	const clamped = setMemoryBankTimeouts({ lightMs: 1, askMs: 999_999 }, env);
	assert.deepEqual(clamped.timeouts, { lightMs: 500, askMs: 120_000 }, "越界 clamp 到边界");

	const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
		timeouts: { lightMs: number; askMs: number };
		futureTop: { a: number };
		external: { vector: boolean; futureBankField: string };
	};
	assert.deepEqual(raw.timeouts, { lightMs: 500, askMs: 120_000 }, "原子写回带出新值");
	assert.deepEqual(raw.futureTop, { a: 1 }, "顶层未知字段保留");
	assert.equal(raw.external.futureBankField, "keep-me", "external 行未知字段保留");
	assert.equal(raw.external.vector, false, "旧 external 补齐默认 vector");
});
