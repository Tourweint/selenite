import assert from "node:assert/strict";
import test from "node:test";
import { enforceChildClosure } from "../../../packages/chancellor/src/stage.ts";
import type { Ticket } from "../../../packages/chancellor/src/types.ts";

function child(id: string, status: Ticket["status"], error: string | null = null): Ticket {
	return {
		id,
		prompt: "子任务",
		status,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		options: { dry: true, maxTasks: 8, workRoot: "." },
		error,
	} as Ticket;
}

const done = {
	status: "done" as const,
	stage: "done" as const,
	line: "✅ 完成",
	error: null,
};

test("父单：有子单 failed 时强制 needs_you，并点名子单和原因", () => {
	const result = enforceChildClosure(
		done,
		[child("T-child-1", "failed", "越权写入：src/secret.ts")],
		"T-parent",
	);
	assert.equal(result.status, "needs_you");
	assert.match(result.line, /T-child-1/);
	assert.match(result.line, /越权写入/);
	assert.match(result.line, /先处理这些子单/);
});

test("父单：有子单 needs_you 时同样不得进 done", () => {
	const result = enforceChildClosure(
		done,
		[child("T-child-2", "needs_you", "声明了 1 个路径，实际 0 个变更")],
		"T-parent",
	);
	assert.equal(result.status, "needs_you");
	assert.match(result.line, /T-child-2/);
	assert.match(result.line, /0 个变更/);
});

test("父单：有子单 aborted 时同样不得进 done，并点名「已中止」和原因", () => {
	const result = enforceChildClosure(
		done,
		[child("T-child-6", "aborted", "用户中止：不要再跑")],
		"T-parent",
	);
	assert.equal(result.status, "needs_you");
	assert.match(result.line, /T-child-6/);
	assert.match(result.line, /已中止/);
	assert.match(result.line, /用户中止/);
});

test("父单：只有未终态子单时沿用 idle，不提前汇报", () => {
	const result = enforceChildClosure(
		done,
		[child("T-child-3", "dispatching"), child("T-child-4", "planning")],
		"T-parent",
	);
	assert.equal(result.status, "idle");
	assert.match(result.line, /T-child-3:dispatching/);
	assert.match(result.line, /T-child-4:planning/);
});

test("父单：idle 子单可续跑，不算终态——父单回 idle 不谎报 done（2026-11-08 chancellor 同步修正）", () => {
	const result = enforceChildClosure(
		done,
		[child("T-child-5", "done"), child("T-child-8", "idle")],
		"T-parent",
	);
	assert.equal(result.status, "idle");
	assert.match(result.line, /T-child-8:idle/);
});

test("父单：子单全部真终态（done/needs_you/failed/aborted 各归各）时 done 才保持", () => {
	const result = enforceChildClosure(done, [child("T-child-5", "done")], "T-parent");
	assert.equal(result.status, "done");
	assert.equal(result.line, done.line);
});

test("父单：自身已经 failed 时不被子单覆盖", () => {
	const failedParent = { ...done, status: "failed" as const, stage: "failed" as const };
	const result = enforceChildClosure(failedParent, [child("T-child-7", "failed")], "T-parent");
	assert.equal(result.status, "failed");
});
