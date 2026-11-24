import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BG_WAKE_TAIL_CHARS,
	bashBackgroundEnabled,
	bgJobWatchIntervalSeconds,
	bgJobWakePayload,
	canceledResult,
	killBgJob,
	listBgJobs,
	moveToBackground,
	pruneBgIndex,
	readBgJobLog,
	replacedResult,
	summarizeCommand,
	tailForWake,
	timeoutSecondsFromResult,
	type BgJobRecord,
} from "./bash-background.ts";

/**
 * bash 超时转后台（任务书 T3 §3.6）。
 *
 * 真起进程的用例故意很短（`node -e "setTimeout(...)"` 300ms），整个文件秒级跑完。
 */

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lh-bg-job-"));
	dirs.push(dir);
	return dir;
}
test.after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("超时识别：只认内核固定文案，且能从 output / diagnostics 两处取到", () => {
	// 形状一：内核把抛错转成 output 文本（bash.js 的 `Command timed out after N seconds`）
	assert.equal(
		timeoutSecondsFromResult({
			isError: true,
			output: [{ type: "text", text: "Command timed out after 1 seconds" }],
		}),
		1,
	);
	// 形状二：纯字符串输出
	assert.equal(timeoutSecondsFromResult({ isError: true, output: "Command timed out after 900 seconds" }), 900);
	// 形状三：诊断里带这句
	assert.equal(
		timeoutSecondsFromResult({
			isError: true,
			output: [],
			diagnostics: [{ message: "Command timed out after 5 seconds" }],
		}),
		5,
	);
	// 失败但不像超时 → null（不把真正的错误转后台再跑一遍）
	assert.equal(timeoutSecondsFromResult({ isError: true, output: "Command exited with code 2" }), null);
	assert.equal(timeoutSecondsFromResult({ isError: true, output: "connection timed out" }), null);
	assert.equal(timeoutSecondsFromResult({ isError: false, output: "ok" }), null);
});

test("开关默认关；摘要把命令压成 ≤120 字", () => {
	assert.equal(bashBackgroundEnabled({}), false);
	assert.equal(bashBackgroundEnabled({ AGENT_BASH_BG_TIMEOUT: "false" }), false);
	assert.equal(bashBackgroundEnabled({ AGENT_BASH_BG_TIMEOUT: "1" }), true);
	assert.equal(bashBackgroundEnabled({ AGENT_BASH_BG_TIMEOUT: "TRUE" }), true);

	const long = `npm run build -- ${"x".repeat(300)}`;
	const summary = summarizeCommand(long);
	assert.ok(summary.length <= 121, `摘要应 ≤120 字，实际 ${summary.length}`);
	assert.equal(summarizeCommand("  a   b  "), "a b");
});

test("转后台：真起进程，完成后 index 落一条（只存摘要，不存完整命令）", async () => {
	const dir = tempDir();
	const command = 'node -e "setTimeout(()=>{},300)"';
	const finished = new Promise<{ exitCode: number | null; status: string }>((resolve) => {
		moveToBackground({
			command,
			cwd: process.cwd(),
			timeoutSeconds: 1,
			dir,
			onFinished: (record) => resolve({ exitCode: record.exitCode ?? null, status: record.status }),
		});
	});

	// 立刻回给模型的文案（不等进程结束）
	const moved = moveToBackground({
		command: 'node -e "setTimeout(()=>{},50)"',
		cwd: process.cwd(),
		timeoutSeconds: 1,
		dir,
	});
	assert.match(moved.message, /已转到后台（任务 bg-/);
	assert.match(moved.message, /别再重复执行同一条命令/);

	const result = await finished;
	assert.equal(result.status, "done");
	assert.equal(result.exitCode, 0);

	const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Array<
		Record<string, unknown>
	>;
	const record = index.find((entry) => entry.id === moved.id);
	assert.ok(record, "index.json 里应有这次转后台的记录");
	assert.ok(index.length >= 2, "两次调用都应落账");
	for (const entry of index) {
		assert.equal(typeof entry.commandSummary, "string");
		assert.ok((entry.commandSummary as string).length <= 121);
		assert.equal("command" in entry, false, "完整命令不许落 index.json");
		assert.ok(typeof entry.startedAt === "string");
	}
});

test("工具结果替换：不回传 isError（否则模型会当成失败重跑）", () => {
	const replacement = replacedResult("已转到后台（任务 bg-x）");
	assert.equal(replacement.isError, false);
	assert.equal(replacement.structuredOutput.exitCode, -1);
	assert.match(replacement.output[0].text, /bg-x/);
});

test("取消结算：isError + canceled 诊断，明确不提示成功（2026-11-24 onTimeout=cancel）", () => {
	const canceled = canceledResult("命令超过 60 秒，已按工具策略取消。不要重试同一条命令。");
	assert.equal(canceled.isError, true, "cancel 是错误结算（不是成功）");
	assert.equal(canceled.structuredOutput.exitCode, -1);
	assert.equal(canceled.diagnostics[0]?.code, "canceled");
	assert.equal(canceled.diagnostics[0]?.severity, "error");
	assert.match(canceled.output[0].text, /不要重试/);
});

test("后台记录带 tool / kind / conversationId；列表支持按会话过滤（旧记录不命中）", async () => {
	const dir = tempDir();
	writeIndex(dir, [
		{
			id: "bg-old-555555",
			commandSummary: "old",
			startedAt: "2026-11-24T00:00:00.000Z",
			status: "done",
			exitCode: 0,
		},
	]);
	const finished = new Promise<BgJobRecord>((resolve) => {
		moveToBackground({
			command: 'node -e "console.log(1)"',
			cwd: process.cwd(),
			timeoutSeconds: 1,
			dir,
			tool: "powershell",
			kind: "shell",
			conversationId: 42,
			onFinished: resolve,
		});
	});
	const record = await finished;
	assert.equal(record.tool, "powershell");
	assert.equal(record.kind, "shell");
	assert.equal(record.conversationId, 42);

	const all = listBgJobs(dir);
	const fresh = all.find((job) => job.id === record.id)!;
	assert.deepEqual(
		{ tool: fresh.tool, kind: fresh.kind, conversationId: fresh.conversationId },
		{ tool: "powershell", kind: "shell", conversationId: 42 },
	);
	const filtered = listBgJobs(dir, 42);
	assert.deepEqual(filtered.map((job) => job.id), [record.id], "旧记录没有 conversationId，不命中过滤");
	assert.deepEqual(listBgJobs(dir, 7), []);
});

// ── 管理面（2026-11-10 批 21 §二）────────────────────────────

function writeIndex(dir: string, records: BgJobRecord[]): void {
	writeFileSync(join(dir, "index.json"), JSON.stringify(records), "utf8");
}

test("列表：索引原样投影，缺省字段给 null（不编造退出码）", () => {
	const dir = tempDir();
	writeIndex(dir, [
		{
			id: "bg-a-111111",
			commandSummary: "npm run build",
			startedAt: "2026-11-10T01:00:00.000Z",
			endedAt: "2026-11-10T01:01:00.000Z",
			exitCode: 0,
			status: "done",
		},
		{ id: "bg-b-222222", commandSummary: "npm run dev", startedAt: "2026-11-10T01:02:00.000Z", status: "running" },
	]);
	const jobs = listBgJobs(dir);
	assert.equal(jobs.length, 2);
	assert.deepEqual(jobs[0], {
		id: "bg-a-111111",
		commandSummary: "npm run build",
		startedAt: "2026-11-10T01:00:00.000Z",
		endedAt: "2026-11-10T01:01:00.000Z",
		exitCode: 0,
		status: "done",
		// 2026-11-24：旧记录没有 kind / tool / conversationId——kind 缺省 shell，其余给 null。
		kind: "shell",
		tool: null,
		conversationId: null,
	});
	assert.equal(jobs[1]!.endedAt, null);
	assert.equal(jobs[1]!.exitCode, null);
	assert.deepEqual(listBgJobs(join(dir, "no-such")), [], "目录不存在 → 空数组");
});

test("日志尾部：最多 200 行、以最新一行结尾；非法 id / 未知 id 都拒绝", () => {
	const dir = tempDir();
	writeIndex(dir, [
		{ id: "bg-log-333333", commandSummary: "x", startedAt: "2026-11-10T01:00:00.000Z", status: "done" },
	]);
	const lines = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`);
	writeFileSync(join(dir, "bg-log-333333.log"), `${lines.join("\n")}\n`, "utf8");

	const tail = readBgJobLog("bg-log-333333", dir);
	assert.equal(tail.found, true);
	assert.equal(tail.totalLines, 250, "末尾换行不算一整行");
	const kept = tail.log.split("\n");
	assert.equal(kept.length, 200);
	assert.equal(kept[0], "line-51");
	assert.equal(kept[199], "line-250");

	assert.equal(readBgJobLog("bg-nope-999999", dir).found, false, "索引里没有 = 不存在");
	assert.equal(readBgJobLog("../../etc/passwd", dir).found, false, "路径形状的 id 一律拒绝");
	assert.equal(readBgJobLog("bg-log-333333", join(dir, "no-such")).found, false);
});

test("kill：只认本进程起的活进程；未知 / 已结束 / 不是本进程起的分开报", async () => {
	const dir = tempDir();
	const finished = new Promise<BgJobRecord>((resolve) => {
		moveToBackground({
			command: 'node -e "setTimeout(()=>{},30000)"',
			cwd: process.cwd(),
			timeoutSeconds: 1,
			dir,
			onFinished: (record) => resolve(record),
		});
	});
	const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as BgJobRecord[];
	const id = index[index.length - 1]!.id;

	assert.equal(killBgJob("bg-nope-999999", dir), "unknown");
	// 索引里再塞一条 running，但活进程不在本进程的内存表里（模拟重启后残留）
	writeIndex(dir, [
		...index,
		{
			id: "bg-stale-444444",
			commandSummary: "x",
			startedAt: "2026-11-10T01:00:00.000Z",
			status: "running",
		},
	]);
	assert.equal(killBgJob("bg-stale-444444", dir), "not_owned");

	// 本次自己起的那个仍在跑 → 真杀；杀完 close 事件把状态收口
	assert.equal(killBgJob(id, dir), "killed");
	const record = await finished;
	assert.equal(record.status, "failed", "被杀掉的任务按失败收口（有结束时间）");
	assert.equal(record.endedAt !== undefined, true);
	assert.equal(killBgJob(id, dir), "not_owned", "同一任务不能杀第二次");
});

test("索引裁剪：超限时只删最旧的已结束条目，在跑的与日志文件都不动", () => {
	const dir = tempDir();
	const records: BgJobRecord[] = [
		{
			id: "bg-run-000000",
			commandSummary: "long",
			startedAt: "2026-11-10T00:00:00.000Z",
			status: "running",
		},
		{
			id: "bg-old-111111",
			commandSummary: "old",
			startedAt: "2026-11-10T00:01:00.000Z",
			endedAt: "2026-11-10T00:02:00.000Z",
			exitCode: 0,
			status: "done",
		},
		{
			id: "bg-old-222222",
			commandSummary: "older",
			startedAt: "2026-11-10T00:00:30.000Z",
			endedAt: "2026-11-10T00:01:30.000Z",
			exitCode: 0,
			status: "done",
		},
		{
			id: "bg-new-333333",
			commandSummary: "new",
			startedAt: "2026-11-10T00:03:00.000Z",
			endedAt: "2026-11-10T00:04:00.000Z",
			exitCode: 0,
			status: "done",
		},
	];
	writeIndex(dir, records);
	for (const record of records) writeFileSync(join(dir, `${record.id}.log`), "x", "utf8");

	assert.equal(pruneBgIndex(dir, 3), 1, "只裁一条");
	const kept = (JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as BgJobRecord[]).map(
		(record) => record.id,
	);
	assert.deepEqual(kept.sort(), ["bg-new-333333", "bg-old-111111", "bg-run-000000"].sort());
	assert.equal(readFileSync(join(dir, "bg-old-222222.log"), "utf8"), "x", "日志文件不删");
	assert.equal(pruneBgIndex(dir, 3), 0, "没超限时不动");
});

// ── 完成即唤醒 / 输出变化检测（2026-11-19 唤醒管道批3）────────────────────

test("唤醒间隔：缺省 0（关）、非法回落 0（BG_JOB_WAKE_ENABLED 回滚开关 2026-11-21 退役）", () => {
	assert.equal(bgJobWatchIntervalSeconds({}), 0, "缺省 0 = 仅完成唤醒");
	assert.equal(bgJobWatchIntervalSeconds({ BG_JOB_WATCH_INTERVAL_S: "0" }), 0);
	assert.equal(bgJobWatchIntervalSeconds({ BG_JOB_WATCH_INTERVAL_S: "-3" }), 0, "负数回落 0");
	assert.equal(bgJobWatchIntervalSeconds({ BG_JOB_WATCH_INTERVAL_S: "abc" }), 0, "非法回落 0");
	assert.equal(bgJobWatchIntervalSeconds({ BG_JOB_WATCH_INTERVAL_S: "10" }), 10);
	assert.equal(bgJobWatchIntervalSeconds({ BG_JOB_WATCH_INTERVAL_S: "2.9" }), 2, "向下取整");
});

test("唤醒载荷：尾部保留末尾 ≤400 字；running 恒无退出码", () => {
	assert.equal(BG_WAKE_TAIL_CHARS, 400);
	const long = Array.from({ length: 50 }, (_, index) => `line-${index}`).join("\n");
	const tail = tailForWake(long);
	assert.ok(tail.length <= 400, `尾部应 ≤400 字，实际 ${tail.length}`);
	assert.ok(tail.endsWith("line-49"), "保留末尾（尾部输出的信息量在结尾）");
	assert.equal(tailForWake("short"), "short");
	assert.equal(tailForWake("  padded  "), "padded", "先去首尾空白再截");

	const record: BgJobRecord = {
		id: "bg-w-1",
		commandSummary: "npm run build",
		startedAt: "2026-11-19T00:00:00.000Z",
		status: "done",
		exitCode: 0,
		endedAt: "2026-11-19T00:01:00.000Z",
	};
	const payload = bgJobWakePayload(record, long, "done");
	assert.equal(payload.jobId, "bg-w-1");
	assert.equal(payload.commandSummary, "npm run build");
	assert.equal(payload.status, "done");
	assert.equal(payload.exitCode, 0);
	assert.ok(payload.tail.length <= 400);
	const running = bgJobWakePayload(record, "x", "running");
	assert.equal(running.status, "running");
	assert.equal(running.exitCode, null, "running 恒无退出码");
});

test("输出变化检测：间隔 1s + 渐进输出 → 运行中触发一次变化回调；完成恰一次收口", async () => {
	const dir = tempDir();
	const changes: Array<{ id: string; tail: string; at: number }> = [];
	const finished = new Promise<{ id: string; status: string; at: number }>((resolve) => {
		moveToBackground({
			// 渐进输出：约 0.4s 间隔打 4 行，~1.6s 收尾——1s 的检测间隔只够赶上一拍
			command: 'node -e "let n=0; const iv=setInterval(()=>{n++; console.log(100+n); if(n>=4) clearInterval(iv);},400)"',
			cwd: process.cwd(),
			timeoutSeconds: 1,
			dir,
			watchIntervalSeconds: 1,
			onOutputChange: (record, logTail) =>
				changes.push({ id: record.id, tail: logTail, at: Date.now() }),
			onFinished: (record) => resolve({ id: record.id, status: record.status, at: Date.now() }),
		});
	});
	const result = await finished;
	// 给"完成收口后漏网的一拍"留观察窗口：检测定时器必须在收口时撤干净
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(result.status, "done");
	assert.ok(changes.length >= 1, `运行中触发过变化回调（实际 ${changes.length} 次）`);
	for (const change of changes) {
		assert.equal(change.id, result.id);
		assert.ok(change.tail.includes("101"), "变化回调带日志尾部");
		assert.equal(change.at < result.at, true, "变化回调先于完成收口");
	}
});

test("输出变化检测：间隔 0（默认关）→ 全程只完成收口，不触发变化回调", async () => {
	const dir = tempDir();
	const changes: string[] = [];
	const finished = new Promise<string>((resolve) => {
		moveToBackground({
			command: 'node -e "console.log(7)"',
			cwd: process.cwd(),
			timeoutSeconds: 1,
			dir,
			watchIntervalSeconds: 0,
			onOutputChange: (record) => changes.push(record.id),
			onFinished: (record) => resolve(record.status),
		});
	});
	assert.equal(await finished, "done");
	assert.equal(changes.length, 0, "间隔 0 = 仅完成唤醒");
});
