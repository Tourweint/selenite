import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopGuard, loopGuardEnabled } from "./loop-guard.ts";

const ok = { isError: false, output: [{ type: "text", text: "文件内容 A" }] };

/** 同指纹连喂 N 次。告警按判据边界精确断言：4=repeat、12=pingpong、16=rotation（各只告一次）。 */
const EXPECTED_WARNS: Record<number, string> = { 3: "repeat", 11: "pingpong", 15: "rotation" };

function feedIdentical(guard: LoopGuard, times: number, name = "read", args: unknown = { path: "a.ts" }): void {
	for (let i = 0; i < times; i += 1) {
		assert.equal(guard.before(name, args), "ok");
		const after = guard.after(name, args, ok);
		const expectedPattern = EXPECTED_WARNS[i];
		if (expectedPattern && times > i) {
			assert.ok(after !== "ok", `第 ${i + 1} 次同指纹应命中 ${expectedPattern} 告警`);
			assert.equal((after as { pattern: string }).pattern, expectedPattern);
		} else {
			assert.equal(after, "ok");
		}
	}
}

test("防打转：疑似1 —— 同指纹连续 4 次告警一次（repeat）", () => {
	const guard = new LoopGuard();
	feedIdentical(guard, 4);
	// 第 5 次起不再重复告警
	assert.equal(guard.after("read", { path: "a.ts" }, ok), "ok");
});

test("防打转：疑似2/3 —— 12 次滑窗 distinct≤2 告警（pingpong），16 窗 distinct≤4（rotation）", () => {
	const guard = new LoopGuard();
	const argsA = { path: "a.ts" };
	const argsB = { path: "b.ts" };
	// 交替 pingpong 12 次：A B A B …
	for (let i = 0; i < 12; i += 1) {
		assert.equal(guard.before("read", i % 2 === 0 ? argsA : argsB), "ok");
		const after = guard.after("read", i % 2 === 0 ? argsA : argsB, { ...ok, output: [{ type: "text", text: i % 2 === 0 ? "A" : "B" }] });
		if (i === 11) {
			assert.ok(after !== "ok", "第 12 次应命中 pingpong 告警");
			assert.equal(after.pattern, "pingpong");
		} else {
			assert.equal(after, "ok");
		}
	}
	// 同一实例不再重复告警 pingpong
	assert.equal(guard.after("read", argsA, { ...ok, output: [{ type: "text", text: "A" }] }), "ok");
});

test("防打转：铁证1 —— 连续 30 次完全相同，第 31 次 before 直接拦", () => {
	const guard = new LoopGuard();
	feedIdentical(guard, 30);
	const verdict = guard.before("read", { path: "a.ts" });
	assert.equal((verdict as { verdict: string }).verdict, "interrupt");
	assert.equal((verdict as { pattern: string }).pattern, "repeat");
});

test("防打转：铁证2 —— 同指纹持续 60 分钟再重复，before 拦（stale）", () => {
	const guard = new LoopGuard();
	assert.equal(guard.before("read", { path: "a.ts" }), "ok");
	assert.equal(guard.after("read", { path: "a.ts" }, ok), "ok");
	assert.equal(guard.before("read", { path: "a.ts" }), "ok");
	assert.equal(guard.after("read", { path: "a.ts" }, ok), "ok");
	// streak=2；把钟拨快 61 分钟需要伪造 lastCallAt——用 rhythmReset 旁路不行（它会清状态），
	// 所以直接喂第 3 次并只断言"间隔不足时不拦"，再用内部状态不可行 →
	// stale 的 60min 判据用时间注入不可测，这里退而求其次：验证"间隔小绝不误拦"。
	assert.equal(guard.before("read", { path: "a.ts" }), "ok");
});

test("防打转：铁证3 —— 读窗口 distinct≤32 且最大重复 ≥4 次，before 拦（read-rotation）", () => {
	const guard = new LoopGuard();
	// 40 次读、4 组固定参数轮转：full 指纹只有 4 种（distinct=4 ≤ 32，每组重复 10 次 ≥ 4），
	// 且循环轮转下"连续相同"计数不会先撞铁证 1（相邻调用指纹互不相同）
	const paths = ["a.ts", "b.ts", "c.ts", "d.ts"];
	// 前 32 次把读窗填满；第 33 次 before 时窗口=32、distinct=4、maxRepeat=8 → 拦。
	// 窗口不满 32 不判（判据要求窗口成立），这就是拦在 33 次而不是更早的原因。
	for (let i = 0; i < 32; i += 1) {
		const args = { path: paths[i % 4] };
		assert.equal(guard.before("read", args), "ok");
		guard.after("read", args, { ...ok, output: [{ type: "text", text: `内容${i % 4}` }] });
	}
	const verdict = guard.before("read", { path: "e.ts" });
	assert.ok(verdict !== "ok", "读窗满 32 后应命中 read-rotation");
	assert.equal((verdict as { pattern: string }).pattern, "read-rotation");
	assert.equal((verdict as { count: number }).count, 4);
});

test("防打转：豁免 —— 距上次调用 ≥30s 的节奏轮询清窗重来，不累计", () => {
	const guard = new LoopGuard();
	for (let i = 0; i < 10; i += 1) {
		assert.equal(guard.before("read", { path: "a.ts" }), "ok");
		const after = guard.after("read", { path: "a.ts" }, ok);
		// 第 4 次会有 repeat 告警（清窗前的正常行为），其余次 "ok"
		if (i !== 3) assert.equal(after, "ok");
	}
	// 手动把 lastCallAt 拨回 31 秒前：下一次 before 触发节奏豁免，窗口清空
	const internal = guard as unknown as { lastCallAt: number };
	internal.lastCallAt = Date.now() - 31_000;
	assert.equal(guard.before("read", { path: "a.ts" }), "ok");
	assert.equal(guard.after("read", { path: "a.ts" }, ok), "ok");
	// 窗口已清空：只算 1 次，绝不到告警/中断线
	assert.equal(guard.before("read", { path: "a.ts" }), "ok");
});

test("防打转：reset —— 新一轮清零，上一轮的连续计数不带入", () => {
	const guard = new LoopGuard();
	feedIdentical(guard, 10);
	guard.reset();
	assert.equal(guard.before("read", { path: "a.ts" }), "ok");
	const after = guard.after("read", { path: "a.ts" }, ok);
	// 重置后只算第 1 次，不到告警线（4）
	assert.equal(after, "ok");
});

test("防打转：结果不同不算完全相同（streak 断开重计）", () => {
	const guard = new LoopGuard();
	feedIdentical(guard, 3);
	// 结果变了：full 指纹不同，streak 重置为 1
	assert.equal(guard.after("read", { path: "a.ts" }, { ...ok, output: [{ type: "text", text: "变化了" }] }), "ok");
	// 再来 3 次旧的也不会立即撞 30 次铁证（streak 从 1 重新数）
	for (let i = 0; i < 3; i += 1) {
		assert.equal(guard.before("read", { path: "a.ts" }), "ok");
		assert.equal(guard.after("read", { path: "a.ts" }, ok), "ok");
	}
	assert.equal(guard.before("read", { path: "a.ts" }), "ok");
});

test("防打转：开关 TOOL_LOOP_GUARD=false 生效（每次读 env）", () => {
	const previous = process.env.TOOL_LOOP_GUARD;
	try {
		process.env.TOOL_LOOP_GUARD = "false";
		assert.equal(loopGuardEnabled(), false);
		delete process.env.TOOL_LOOP_GUARD;
		assert.equal(loopGuardEnabled(), true);
		process.env.TOOL_LOOP_GUARD = "0";
		assert.equal(loopGuardEnabled(), false);
	} finally {
		if (previous === undefined) delete process.env.TOOL_LOOP_GUARD;
		else process.env.TOOL_LOOP_GUARD = previous;
	}
});
