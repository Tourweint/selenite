import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import {
	runCliProcess,
	type CliProcessCall,
} from "../../../packages/chancellor/src/employee/cli.ts";

/**
 * 外部 CLI 的超时口径（2026-11-22 M2a）。
 *
 * 旧行为是 `WORKER_TIMEOUT_MS=10min` 墙钟：长任务被误杀，挂死任务却占满 10 分钟。
 * 新口径是活动超时（stdout/stderr 有输出就顺延）+ 总时长上限。
 * 这里用 `node -e` 起真子进程（process.execPath，不依赖 bash），验的是真 spawn / killTree。
 */

function baseCall(source: string, over: Partial<CliProcessCall> = {}): CliProcessCall {
	return {
		label: "timeout-probe",
		command: process.execPath,
		args: ["-e", source],
		stdin: null,
		cwd: process.cwd(),
		timeoutMs: 60_000,
		...over,
	};
}

test("idleTimeoutMs：持续有输出时不计空闲超时", async () => {
	const startedAt = Date.now();
	const result = await runCliProcess(
		baseCall(
			[
				'process.stdout.write("start\\n");',
				"let ticks = 0;",
				"const timer = setInterval(() => {",
				"  ticks += 1;",
				'  process.stdout.write("tick " + ticks + "\\n");',
				"  if (ticks >= 8) clearInterval(timer);",
				"}, 150);",
			].join("\n"),
			{
				idleTimeoutMs: 600,
				maxTimeoutMs: 10_000,
				interpret: () => ({ ok: true, sessionId: null, error: null }),
			},
		),
	);
	const elapsed = Date.now() - startedAt;
	assert.equal(result.timedOut, false, result.error ?? "");
	assert.equal(result.ok, true);
	// 总耗时超过一个空闲窗口：没被杀说明每条输出都把空闲计时顺延了。
	assert.ok(elapsed >= 600, `elapsed=${elapsed}`);
});

test("idleTimeoutMs：静默子进程按空闲超时被杀", async () => {
	const startedAt = Date.now();
	const result = await runCliProcess(
		baseCall("setTimeout(() => {}, 5000);", {
			idleTimeoutMs: 200,
			maxTimeoutMs: 10_000,
		}),
	);
	const elapsed = Date.now() - startedAt;
	assert.equal(result.timedOut, true);
	assert.equal(result.aborted, false);
	assert.match(result.error ?? "", /空闲超时（200ms 无输出）/);
	// killTree 没兜住会走 5s 强杀兜底；这里把"该早死"也钉住。
	assert.ok(elapsed < 5_000, `elapsed=${elapsed}`);
});

test("maxTimeoutMs：持续有输出也按总时长上限超时", async () => {
	const result = await runCliProcess(
		baseCall("setInterval(() => process.stdout.write('tick\\n'), 50);", {
			idleTimeoutMs: 5_000,
			maxTimeoutMs: 300,
		}),
	);
	assert.equal(result.timedOut, true);
	assert.match(result.error ?? "", /超时（300ms 总时长）/);
});

test("没给 idleTimeoutMs：沿用旧 timeoutMs 墙钟，输出不续命", async () => {
	const result = await runCliProcess(
		baseCall("setInterval(() => process.stdout.write('tick\\n'), 20);", {
			timeoutMs: 200,
		}),
	);
	assert.equal(result.timedOut, true);
	assert.match(result.error ?? "", /超时（200ms）/);
});
