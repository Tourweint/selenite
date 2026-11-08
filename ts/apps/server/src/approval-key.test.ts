import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalArgsHash, stableStringify } from "./agent/approval-key.ts";

/**
 * 审批参数指纹（2026-11-08 扫尾批 8c）：稳定序列化 + sha256。
 * 放行清单的"防骗"全靠它：同参不同键序必须同指纹，换值必须不同指纹。
 */

test("stableStringify：键序不影响结果（顶层与嵌套都排序）", () => {
	const a = stableStringify({ command: "ls", timeout: 3, env: { B: "2", A: "1" } });
	const b = stableStringify({ env: { A: "1", B: "2" }, timeout: 3, command: "ls" });
	assert.equal(a, b);
	assert.equal(a, '{"command":"ls","env":{"A":"1","B":"2"},"timeout":3}');
});

test("stableStringify：数组保序，对象与数组混排也稳定", () => {
	assert.equal(stableStringify([3, 1, 2]), "[3,1,2]");
	assert.equal(
		stableStringify({ list: [{ b: 1, a: 2 }, "x"] }),
		'{"list":[{"a":2,"b":1},"x"]}',
	);
});

test("stableStringify：undefined 在对象里删键、在数组里变 null；非有限数字变 null", () => {
	assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
	assert.equal(stableStringify([undefined, 1]), "[null,1]");
	assert.equal(stableStringify({ n: Number.NaN, i: Infinity }), '{"i":null,"n":null}');
});

test("approvalArgsHash：同参不同键序同指纹，换值 / 换工具参数即不同", () => {
	const h1 = approvalArgsHash({ command: "sleep 2", timeout: 5 });
	const h2 = approvalArgsHash({ timeout: 5, command: "sleep 2" });
	const h3 = approvalArgsHash({ command: "sleep 3", timeout: 5 });
	assert.equal(h1, h2);
	assert.notEqual(h1, h3);
	assert.match(h1, /^[0-9a-f]{64}$/);
});

test("approvalArgsHash：不同类型的同名参数不能撞（1 vs \"1\"）", () => {
	assert.notEqual(approvalArgsHash({ a: 1 }), approvalArgsHash({ a: "1" }));
});

test("approvalArgsHash：空对象也有指纹；无法序列化的输入返回空串（永不匹配放行）", () => {
	assert.match(approvalArgsHash({}), /^[0-9a-f]{64}$/);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.equal(stableStringify(circular), "");
	assert.equal(approvalArgsHash(circular), "");
});
