import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	personaWrite,
	personaWriteEnabled,
	repairScriptPath,
	validatePersonaWriteInput,
	writePersonaAvailable,
	PERSONA_WRITE_BODY_MAX,
	PERSONA_WRITE_WHY_MAX,
	type PersonaWriteDeps,
} from "./persona-write.ts";

/**
 * persona 写入（2026-11-17 persona_write 批）单测。
 *
 * 语义红线：这是往主人一生库落字的工具——双闸（开关默认关 + 路径可用）缺一不可、
 * 文本超限直接拒绝不截断、失败一律降级不抛。argv 拼死（python + repair.py + statement），
 * 模型自由度只有三条文本字段。全部用假 spawn，不碰真实 python 与 persona.db。
 */

const ON = { PERSONA_WRITE_ENABLED: "true", PERSONA_MEMORY_ASK: "D:/pm/analysis/ask.py" };

type StubChild = ChildProcess & { stdout: Readable; stderr: Readable };

function makeChild(): StubChild {
	const child = new EventEmitter() as StubChild;
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
	return child;
}

/** 假 spawn：记录 args（不含 python 命令本身），返回可手工收尾的假子进程。 */
function spawnStub() {
	const calls: string[][] = [];
	const children: StubChild[] = [];
	const fn = ((_command: string, args: string[]) => {
		calls.push(args);
		const child = makeChild();
		children.push(child);
		return child;
	}) as unknown as typeof import("node:child_process").spawn;
	return { fn, calls, children };
}

function settle(child: ReturnType<typeof makeChild>, stdout = "已记：测试", code = 0): void {
	child.stdout.emit("data", Buffer.from(stdout));
	child.emit("close", code);
}

test("personaWriteEnabled：默认关，显式 true 才开（往一生库落字的工具默认不动）", () => {
	assert.equal(personaWriteEnabled({}), false);
	assert.equal(personaWriteEnabled({ PERSONA_WRITE_ENABLED: "false" }), false);
	assert.equal(personaWriteEnabled({ PERSONA_WRITE_ENABLED: "true" }), true);
});

test("repairScriptPath：PERSONA_REPAIR 显式优先；否则从 PERSONA_MEMORY_ASK 同目录推导；都没有=空", () => {
	assert.equal(repairScriptPath({ PERSONA_REPAIR: "D:/x/repair.py" }), "D:/x/repair.py");
	assert.equal(
		repairScriptPath({ PERSONA_MEMORY_ASK: "D:/pm/analysis/ask.py" }),
		join("D:/pm/analysis", "repair.py"),
	);
	assert.equal(repairScriptPath({}), "");
	assert.equal(writePersonaAvailable({ PERSONA_MEMORY_ASK: "D:/pm/analysis/ask.py" }), true);
	assert.equal(writePersonaAvailable({}), false);
});

test("validatePersonaWriteInput：空 body / 空 why 拒绝；超限拒绝不截断", () => {
	assert.equal(validatePersonaWriteInput({ body: "住院的是姥姥", why: "主人纠正主体" }), null);
	assert.match(validatePersonaWriteInput({ body: "  ", why: "x" }) ?? "", /body 不能为空/);
	assert.match(validatePersonaWriteInput({ body: "x", why: "" }) ?? "", /why 不能为空/);
	assert.match(
		validatePersonaWriteInput({ body: "长".repeat(PERSONA_WRITE_BODY_MAX + 1), why: "x" }) ?? "",
		/超过 500 字/,
	);
	assert.match(
		validatePersonaWriteInput({ body: "x", why: "长".repeat(PERSONA_WRITE_WHY_MAX + 1) }) ?? "",
		/超过 200 字/,
	);
});

test("双闸任一不过：直接 ok:false，不起进程", async () => {
	const { fn, calls } = spawnStub();
	for (const env of [
		{},
		{ PERSONA_WRITE_ENABLED: "true" }, // 有开关没路径
		{ PERSONA_MEMORY_ASK: "D:/pm/analysis/ask.py" }, // 有路径没开关
	]) {
		const result = await personaWrite({ body: "x", why: "y" }, { env, spawnFn: fn });
		assert.equal(result.ok, false);
	}
	assert.equal(calls.length, 0, "不该起任何子进程");
});

test("正常写入：argv 拼死 statement + 可选字段按序；statementId 按 repair.py 同式本地计算", async () => {
	const { fn, calls, children } = spawnStub();
	const pending = personaWrite(
		{ body: "住院的是我姥姥，不是我妈", why: "主人纠正主体", about: "2025-01", tag: "错认主体" },
		{ env: ON, spawnFn: fn },
	);
	settle(children[0], "已记：住院的是我姥姥，不是我妈");
	const result = await pending;
	assert.equal(result.ok, true);
	// argv 形状：脚本、statement、body、--about、--tag、--why 各就各位，无 shell
	assert.deepEqual(calls[0], [
		join("D:/pm/analysis", "repair.py"),
		"statement",
		"住院的是我姥姥，不是我妈",
		"--about",
		"2025-01",
		"--tag",
		"错认主体",
		"--why",
		"主人纠正主体",
	]);
	assert.match(result.line ?? "", /已记/);
	// statementId 是 us- 前缀 + 10 位十六进制（与 repair.py 的 sha1 同式）
	assert.match(result.statementId ?? "", /^us-[0-9a-f]{10}$/);
});

test("非零退出：ok:false，错误只带 stderr 第一行（不整段落日志面）", async () => {
	const { fn, children } = spawnStub();
	const pending = personaWrite({ body: "x", why: "y" }, { env: ON, spawnFn: fn });
	const child = children[0];
	child.stderr.emit("data", Buffer.from("sqlite error: no such table\n第二行不该出现"));
	child.emit("close", 1);
	const result = await pending;
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /退出码 1/);
	assert.match(result.error ?? "", /no such table/);
	assert.ok(!(result.error ?? "").includes("第二行不该出现"), "stderr 只取第一行");
});

test("未启用 / 无路径时不做长度校验也直接降级，绝不抛异常", async () => {
	const result = await personaWrite({ body: "", why: "" }, { env: {}, spawnFn: undefined });
	assert.equal(result.ok, false);
	assert.ok(result.error);
});
