import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifyRunFailure,
	cooldownUntil,
	parseResetAt,
	retryDecision,
} from "../../../packages/chancellor/src/failure-class.ts";
import type {
	PlannedTask,
	TaskRun,
	WorkerReport,
} from "../../../packages/chancellor/src/types.ts";

/**
 * 失败分类 + attempt 退避口径（2026-11-22 M3）。
 * chancellor 包没有 test 脚本，测试统一放 server 侧，import 包内纯函数。
 */

const READY_REPORT: WorkerReport = {
	status: "ready",
	summary: "完成",
	artifacts: [],
	raw: "READY",
};

function planned(): PlannedTask {
	return {
		title: "活",
		slug: "job",
		instruction: "做点事",
		done_when: "文件存在",
		dependsOn: [],
		writes: [],
	};
}

function runOf(over: Partial<TaskRun> = {}): TaskRun {
	return {
		ticketId: "T-class",
		seq: 1,
		task: planned(),
		dir: "/tmp/T-class/01-job",
		dirName: "01-job",
		employee: "claude-code",
		exitCode: 0,
		timedOut: false,
		aborted: false,
		processOk: true,
		processError: null,
		sessionId: null,
		reportExists: true,
		report: READY_REPORT,
		reportError: null,
		stderrTail: "",
		...over,
	};
}

test("分类：越权 / 合并冲突来自 run.failure，优先于执行器文本", () => {
	assert.equal(
		classifyRunFailure(
			runOf({ failure: "越权写入：a.txt", processOk: false, stderrTail: "429" }),
		),
		"unauthorized_write",
	);
	assert.equal(classifyRunFailure(runOf({ failure: "合并冲突：a.txt" })), "merge_conflict");
});

test("分类：取消 / 超时最优先，不会被 stderr 里的 429 带偏", () => {
	assert.equal(
		classifyRunFailure(runOf({ aborted: true, processOk: false, stderrTail: "429" })),
		"aborted",
	);
	assert.equal(classifyRunFailure(runOf({ timedOut: true, processOk: false })), "timeout");
});

test("分类：429 带小时级 reset 归额度；普通 429 归限流", () => {
	assert.equal(
		classifyRunFailure(
			runOf({
				processOk: false,
				exitCode: 1,
				processError: "claude-code 报告 is_error=true",
				stderrTail: 'API Error: 429 {"type":"rate_limit_error"} (reset after 2h 30m 5s)',
			}),
		),
		"usage_limit",
	);
	assert.equal(
		classifyRunFailure(runOf({ processOk: false, exitCode: 1, stderrTail: "429 Too Many Requests" })),
		"rate_limit",
	);
	assert.equal(
		classifyRunFailure(runOf({ processOk: false, exitCode: 1, stderrTail: "额度已用尽，冷却 5 分钟" })),
		"usage_limit",
	);
});

test("分类：权限拒绝 / 池崩溃 / 传输抖动", () => {
	assert.equal(
		classifyRunFailure(
			runOf({
				processOk: false,
				exitCode: 1,
				processError: "claude-code 有 2 项操作被拒（permission_denials 非空）",
			}),
		),
		"permission",
	);
	assert.equal(
		classifyRunFailure(runOf({ processOk: false, exitCode: null, processError: "pool_crashed" })),
		"crashed",
	);
	assert.equal(
		classifyRunFailure(runOf({ processOk: false, processError: "stream_closed" })),
		"crashed",
	);
	assert.equal(
		classifyRunFailure(
			runOf({ processOk: false, exitCode: 1, processError: "fetch failed", stderrTail: "ECONNRESET" }),
		),
		"transient",
	);
	assert.equal(
		classifyRunFailure(runOf({ processOk: false, exitCode: 1, processError: "no_idle_slot" })),
		"transient",
	);
});

test("分类：REPORT 缺失 / 成功 / 认不出", () => {
	assert.equal(
		classifyRunFailure(
			runOf({ reportExists: false, report: null, reportError: "REPORT.md 缺失" }),
		),
		"report_missing",
	);
	assert.equal(
		classifyRunFailure(
			runOf({ report: null, reportError: "REPORT.md 的 json 无法解析：坏" }),
		),
		"report_missing",
	);
	assert.equal(classifyRunFailure(runOf()), "unknown", "成功执行没有失败类");
	assert.equal(
		classifyRunFailure(runOf({ processOk: false, processError: "说不上来" })),
		"unknown",
	);
});

test("retryDecision：transient 默认 2 次（1s / 4s）", () => {
	assert.deepEqual(retryDecision("transient", 1), {
		retry: true,
		delayMs: 1_000,
		reason: "传输类失败，1 秒后重试（第 1 次）",
	});
	assert.equal(retryDecision("transient", 2).delayMs, 4_000);
	assert.equal(retryDecision("transient", 3).retry, false);
	assert.equal(retryDecision("transient", 1, { maxTransient: 1 }).retry, true);
	assert.equal(retryDecision("transient", 2, { maxTransient: 1 }).retry, false);
});

test("retryDecision：rate_limit 3 次（5s / 30s / 2min）", () => {
	assert.deepEqual(
		[1, 2, 3].map((attempt) => retryDecision("rate_limit", attempt).delayMs),
		[5_000, 30_000, 120_000],
	);
	assert.equal(retryDecision("rate_limit", 4).retry, false);
	assert.equal(retryDecision("rate_limit", 1, { maxRateLimit: 0 }).retry, false);
});

test("retryDecision：timeout / crashed / usage_limit 的次数与延迟", () => {
	assert.deepEqual(retryDecision("timeout", 1), {
		retry: true,
		delayMs: 0,
		reason: "超时失败，立即重试（第 1 次）",
	});
	assert.equal(retryDecision("timeout", 2).retry, false);

	assert.equal(retryDecision("crashed", 1).delayMs, 2_000);
	assert.equal(retryDecision("crashed", 2).delayMs, 8_000);
	assert.equal(retryDecision("crashed", 3).retry, false);

	assert.equal(retryDecision("usage_limit", 1).delayMs, 5 * 60_000);
	assert.equal(retryDecision("usage_limit", 3).retry, true);
	assert.equal(retryDecision("usage_limit", 4).retry, false);
	assert.equal(retryDecision("usage_limit", 1, { maxUsageLimit: 1 }).retry, true);
});

test("retryDecision：权限 / 越权 / 冲突 / 报告缺失 / 取消 / unknown 一律不重试", () => {
	for (const cls of [
		"permission",
		"unauthorized_write",
		"merge_conflict",
		"report_missing",
		"aborted",
		"unknown",
	] as const) {
		const decision = retryDecision(cls, 1);
		assert.equal(decision.retry, false, `${cls} 不该重试`);
		assert.equal(decision.delayMs, 0);
		assert.ok(decision.reason.length > 0, `${cls} 要给一句原因`);
	}
});

test("parseResetAt：Claude 的 h/m/s、分钟、秒、中文冷却", () => {
	const now = 1_700_000_000_000;
	assert.equal(
		parseResetAt("API Error: 429 (reset after 1h 2m 3s)", now),
		now + 3_723_000,
	);
	assert.equal(parseResetAt("reset after 2h 30m 5s", now), now + 9_005_000);
	assert.equal(parseResetAt("reset after 45m", now), now + 2_700_000);
	assert.equal(parseResetAt("retry after 30s", now), now + 30_000);
	assert.equal(parseResetAt("额度冷却 5 分钟", now), now + 300_000);
	assert.equal(parseResetAt("2 小时 30 分钟后恢复", now), now + 9_000_000);
	assert.equal(parseResetAt("5 分钟后重试", now), now + 300_000);
});

test("parseResetAt：没有 reset 信息时返回 null", () => {
	const now = 1_700_000_000_000;
	assert.equal(parseResetAt("", now), null);
	assert.equal(parseResetAt("没有恢复时间，只有错误码 500", now), null);
});

test("cooldownUntil：额度用 resetAt（上限 24h），没有则 5min；限流 30s", () => {
	const now = 1_700_000_000_000;
	assert.equal(cooldownUntil("usage_limit", now + 2 * 3_600_000, now), now + 2 * 3_600_000);
	assert.equal(cooldownUntil("usage_limit", null, now), now + 5 * 60_000);
	assert.equal(
		cooldownUntil("usage_limit", now + 48 * 3_600_000, now),
		now + 24 * 3_600_000,
		"异常大的 reset 不能把车道关两天以上",
	);
	assert.equal(cooldownUntil("usage_limit", now - 1_000, now), now + 5 * 60_000);
	assert.equal(cooldownUntil("rate_limit", null, now), now + 30_000);
	assert.equal(cooldownUntil("transient", now + 3_600_000, now), null);
	assert.equal(cooldownUntil("permission", null, now), null);
});
