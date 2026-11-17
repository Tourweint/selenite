import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lifediary-reminder-runs-"));
const statePath = join(root, "runs.json");
process.env.REMINDER_RUNS_STATE_PATH = statePath;

const { listReminderRuns, recordReminderRun } = await import("./reminder-runs.ts");

test.after(() => {
	rmSync(root, { recursive: true, force: true });
});

test("执行历史：按 reminderId 归组，新的在前", () => {
	recordReminderRun({
		reminderId: "a",
		trigger: "scheduled",
		status: "success",
		at: 1000,
		summary: "第一轮",
	});
	recordReminderRun({
		reminderId: "b",
		trigger: "manual",
		status: "failed",
		at: 2000,
		summary: "别人的",
	});
	recordReminderRun({
		reminderId: "a",
		trigger: "manual",
		status: "success",
		at: 3000,
		summary: "第二轮",
	});
	const runs = listReminderRuns("a");
	assert.equal(runs.length, 2);
	assert.equal(runs[0]?.summary, "第二轮");
	assert.equal(runs[0]?.trigger, "manual");
	assert.equal(runs[1]?.summary, "第一轮");
	assert.equal(listReminderRuns("b")[0]?.status, "failed");
});

test("执行历史：摘要截断到 200 字，文件有界 500 条", () => {
	recordReminderRun({
		reminderId: "long",
		trigger: "scheduled",
		status: "success",
		at: 1,
		summary: "长".repeat(500),
	});
	const long = listReminderRuns("long")[0];
	assert.ok(long?.summary && long.summary.length <= 200, `摘要应 ≤200，实际 ${long?.summary?.length}`);

	for (let index = 0; index < 520; index += 1) {
		recordReminderRun({
			reminderId: "cap",
			trigger: "scheduled",
			status: "success",
			at: index,
			summary: `第 ${index} 轮`,
		});
	}
	const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { runs: unknown[] };
	assert.equal(parsed.runs.length, 500, "全局最多留 500 条");
});

test("执行历史：文件坏掉当空，不挡记账", () => {
	writeFileSync(statePath, "{ 不是 JSON", "utf8");
	assert.deepEqual(listReminderRuns("a"), []);
	recordReminderRun({
		reminderId: "after-broken",
		trigger: "manual",
		status: "success",
		at: 1,
	});
	assert.equal(listReminderRuns("after-broken").length, 1);
});
