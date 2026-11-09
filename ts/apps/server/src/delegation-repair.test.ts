import assert from "node:assert/strict";
import { test } from "node:test";
import {
	acceptRounds,
	buildRepairRequirement,
	lastFailReason,
	renderAcceptLimitLine,
	shouldStartRepair,
} from "../../../../../chancellor/src/repair.ts";
import type { Review, TaskRun } from "../../../../../chancellor/src/types.ts";

/**
 * 验收「核对-修复」循环（2026-11-09 §1）：纯逻辑在这里断言，
 * 有副作用的重跑与目录归档在 runChancellor 里（由 http/probe 侧覆盖）。
 */

function review(over: Partial<Review>): Review {
	return {
		ticket_id: "t-1",
		seq: 1,
		slug: "write-file",
		verdict: "fail",
		reason: "声明了 1 个路径，实际 0 个变更（新增 / 修改 / 删除都没有）",
		stage: "artifacts",
		...over,
	};
}

function run(over: Partial<TaskRun> & { writes: string[] }): TaskRun {
	return {
		ticketId: "t-1",
		seq: 1,
		task: {
			title: "写文件",
			slug: "write-file",
			instruction: "写 a.ts",
			done_when: "a.ts 存在",
			dependsOn: [],
			writes: over.writes,
		},
		dir: "/tmp/task",
		dirName: "01-write-file",
		employee: "native",
		exitCode: 0,
		timedOut: false,
		aborted: false,
		processOk: true,
		processError: null,
		sessionId: null,
		reportExists: true,
		report: null,
		reportError: null,
		stderrTail: "",
		...over,
	};
}

test("DELEGATION_ACCEPT_ROUNDS：默认 1；0 合法（旧行为）；非法回落 1", () => {
	assert.equal(acceptRounds({}), 1);
	assert.equal(acceptRounds({ DELEGATION_ACCEPT_ROUNDS: "" }), 1);
	assert.equal(acceptRounds({ DELEGATION_ACCEPT_ROUNDS: "0" }), 0);
	assert.equal(acceptRounds({ DELEGATION_ACCEPT_ROUNDS: "2" }), 2);
	assert.equal(acceptRounds({ DELEGATION_ACCEPT_ROUNDS: " 3 " }), 3);
	assert.equal(acceptRounds({ DELEGATION_ACCEPT_ROUNDS: "-2" }), 0);
	assert.equal(acceptRounds({ DELEGATION_ACCEPT_ROUNDS: "abc" }), 1);
});

test("0 轮 = 旧行为：失败也不进修复循环；1 轮才有返工", () => {
	// 这就是 runChancellor 里 while 的条件：0 时一次都不进 = 与今天逐字节一致。
	assert.equal(shouldStartRepair("failed", 0, 0), false);
	assert.equal(shouldStartRepair("failed", 0, 1), true);
	// 上限到了不再开新轮（防死循环）
	assert.equal(shouldStartRepair("failed", 1, 1), false);
	assert.equal(shouldStartRepair("failed", 2, 1), false);
	// 非失败结论不修
	assert.equal(shouldStartRepair("done", 0, 3), false);
	assert.equal(shouldStartRepair("needs_you", 0, 3), false);
	assert.equal(shouldStartRepair("aborted", 0, 3), false);
});

test("修复 requirement：带验收原话 + 声明路径逐项状态 + 只修这些", () => {
	const text = buildRepairRequirement({
		requirement: "把 a.ts 和 b.ts 都补上",
		round: 1,
		reviews: [
			review({ seq: 1, slug: "write-a", verdict: "fail" }),
			review({
				seq: 2,
				slug: "write-b",
				verdict: "pass",
				reason: "声明了 1 个路径，1 个有变更：b.ts",
			}),
		],
		runs: [
			run({ seq: 1, writes: ["src/a.ts"], changedPaths: [] }),
			run({ seq: 2, writes: ["src/b.ts"], changedPaths: ["src/b.ts"] }),
		],
	});
	// 验收原话必须原样出现（不是"请修一下"）
	assert.match(text, /实际 0 个变更（新增 \/ 修改 \/ 删除都没有）/);
	assert.match(text, /第 1 轮返工/);
	// 声明路径逐项状态
	assert.match(text, /src\/a\.ts：未变更（本轮必须补上）/);
	assert.match(text, /src\/b\.ts：已变更（保留它，不要重做）/);
	// 明确"只修这些，别重做"
	assert.match(text, /只修下面未通过的部分/);
	assert.match(text, /不要把已经通过的部分重做/);
	// 原始要求附在最后，修复轮不丢上下文
	assert.match(text, /## 原始要求\n把 a\.ts 和 b\.ts 都补上$/);
});

test("上限文案：带轮数与最后一轮验收原话", () => {
	const reason = lastFailReason([
		review({ verdict: "pass", reason: "通过" }),
		review({ verdict: "fail", reason: "REPORT.md 缺失" }),
	]);
	assert.equal(reason, "REPORT.md 缺失");
	assert.equal(
		renderAcceptLimitLine("t-1", 1, reason),
		"⚠ [t-1] 已自动修 1 轮仍失败，原文：REPORT.md 缺失",
	);
});
