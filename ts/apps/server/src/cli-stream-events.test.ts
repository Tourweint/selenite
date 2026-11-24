import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildClaudeInvocation,
	parseClaudeStepLine,
} from "../../../packages/chancellor/src/employee/claude.ts";
import { parseCodexStepLine } from "../../../packages/chancellor/src/employee/codex.ts";
import {
	doubaoStepEvents,
	interpretDoubao,
	parseDoubaoStdout,
} from "../../../packages/chancellor/src/employee/doubao.ts";
import { parseOpencodeStepLine } from "../../../packages/chancellor/src/employee/opencode.ts";
import { runCliProcess } from "../../../packages/chancellor/src/employee/cli.ts";
import {
	emptyToolStats,
	formatStatsLine,
	readSteps,
	stepLineOf,
	STEPS_FILE,
	summarizeSteps,
	type CliStepEvent,
} from "../../../packages/chancellor/src/employee/steps.ts";
import type { Employee } from "../../../packages/chancellor/src/employee/index.ts";
import { cliStreamEventsEnabled } from "../../../packages/chancellor/src/config.ts";
import { dispatchTask } from "../../../packages/chancellor/src/dispatch.ts";
import type { PlannedTask, Ticket } from "../../../packages/chancellor/src/types.ts";

/* ── Claude Code（2026-11-23 实测：stream-json + --verbose）──────────── */

test("Claude：给 onStep 才切 stream-json + --verbose；不给保持单结果 json", () => {
	const base = {
		prompt: "读 a.txt",
		cwd: "/tmp",
		model: "",
		permission: "full" as const,
		timeoutMs: 1000,
		label: "01-test",
	};
	const plain = buildClaudeInvocation(base);
	assert.ok(plain.args.includes("json"));
	assert.ok(!plain.args.includes("stream-json"));
	assert.ok(!plain.args.includes("--verbose"));

	const streamed = buildClaudeInvocation({ ...base, onStep: () => {} });
	assert.ok(streamed.args.includes("stream-json"));
	assert.ok(streamed.args.includes("--verbose"));
});

test("Claude：tool_use 出工具事件；tool_result 失败出失败状态；thinking/text 不产生事件", () => {
	const toolNames = new Map<string, string>();
	const toolUse = parseClaudeStepLine(
		JSON.stringify({
			type: "assistant",
			message: {
				content: [
					{ type: "thinking", thinking: "先读文件" },
					{
						type: "tool_use",
						id: "call-1",
						name: "Read",
						input: { file_path: "C:\\work\\a.txt" },
					},
				],
			},
		}),
		toolNames,
	);
	assert.equal(toolUse.length, 1);
	assert.equal(toolUse[0]?.type, "tool");
	assert.equal(toolUse[0]?.name, "Read");
	assert.equal(toolUse[0]?.detail, "a.txt");

	const failed = parseClaudeStepLine(
		JSON.stringify({
			type: "user",
			message: {
				content: [
					{ type: "tool_result", tool_use_id: "call-1", is_error: true, content: "x" },
				],
			},
		}),
		toolNames,
	);
	assert.equal(failed.length, 1);
	assert.equal(failed[0]?.type, "status");
	assert.equal(failed[0]?.failed, true);
	assert.equal(failed[0]?.name, "Read");

	assert.deepEqual(
		parseClaudeStepLine(
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "做完了" }] },
			}),
		),
		[],
	);
	assert.deepEqual(parseClaudeStepLine("not json"), []);
});

/* ── Codex（2026-11-23 实测：item.started / item.completed）──────────── */

test("Codex：命令 / 非零退出 / file_change / 元数据提示的口径", () => {
	const started = parseCodexStepLine(
		JSON.stringify({
			type: "item.started",
			item: {
				id: "item_1",
				type: "command_execution",
				command: "Get-Content a.txt",
				status: "in_progress",
			},
		}),
	);
	assert.equal(started.length, 1);
	assert.equal(started[0]?.type, "tool");
	assert.equal(started[0]?.name, "command");
	assert.equal(started[0]?.detail, "Get-Content a.txt");

	const failed = parseCodexStepLine(
		JSON.stringify({
			type: "item.completed",
			item: { id: "item_1", type: "command_execution", command: "x", exit_code: 1 },
		}),
	);
	assert.equal(failed.length, 1);
	assert.equal(failed[0]?.failed, true);

	const fileChange = parseCodexStepLine(
		JSON.stringify({
			type: "item.completed",
			item: {
				id: "item_2",
				type: "file_change",
				changes: [{ path: "a.txt" }, { path: "src/b.ts" }],
			},
		}),
	);
	assert.equal(fileChange.length, 1);
	assert.equal(fileChange[0]?.name, "write");
	assert.equal(fileChange[0]?.detail, "a.txt、b.ts");

	// 上游元数据提示（priority tier / model metadata）不是工具失败。
	assert.deepEqual(
		parseCodexStepLine(
			JSON.stringify({
				type: "item.completed",
				item: {
					id: "item_0",
					type: "error",
					message: "Configured service tier `priority` is not advertised",
				},
			}),
		),
		[],
	);

	const turnFailed = parseCodexStepLine(
		JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
	);
	assert.equal(turnFailed[0]?.failed, true);
});

/* ── OpenCode（2026-11-23 实测：tool_use + part.state）───────────────── */

test("OpenCode：tool_use 落定出事件；error 标失败；同一 part 不重复", () => {
	const seen = new Set<string>();
	const read = parseOpencodeStepLine(
		JSON.stringify({
			type: "tool_use",
			part: {
				id: "prt_1",
				type: "tool",
				tool: "read",
				state: {
					status: "completed",
					input: { path: "C:\\work\\a.txt" },
					output: "full file content",
				},
			},
		}),
		seen,
	);
	assert.equal(read.length, 1);
	assert.equal(read[0]?.name, "read");
	assert.equal(read[0]?.detail, "a.txt");
	assert.deepEqual(
		parseOpencodeStepLine(
			JSON.stringify({
				type: "tool_use",
				part: { id: "prt_1", type: "tool", tool: "read", state: { status: "completed" } },
			}),
			seen,
		),
		[],
	);

	const failed = parseOpencodeStepLine(
		JSON.stringify({
			type: "tool_use",
			part: {
				id: "prt_2",
				type: "tool",
				tool: "read",
				state: { status: "error", input: { path: "a.txt" }, error: "File not found" },
			},
		}),
	);
	assert.equal(failed[0]?.failed, true);
	assert.equal(failed[0]?.detail, "File not found");
});

/* ── 豆包（降级口径：最终 tool_calls）────────────────────────────────── */

test("豆包：tool_calls 转步骤；失败照实标；没有 tool_calls 就不产生事件", () => {
	const parsed = parseDoubaoStdout(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			session_id: "d-9",
			result: { type: "text", content: "完成" },
			tool_calls: [
				{ name: "Read", input: { file_path: "C:\\work\\a.txt" }, result: { is_error: false } },
				{ name: "Bash", input: { command: "ls" }, result: { is_error: false } },
				{ name: "Write", input: { file_path: "b.txt" }, result: { is_error: true } },
			],
			tool_calls_truncated: true,
		}),
	);
	assert.equal(parsed.toolCalls.length, 3);
	assert.deepEqual(
		parsed.toolCalls.map((call) => call.failed),
		[false, false, true],
	);
	assert.equal(parsed.toolCallsTruncated, true);

	const events: CliStepEvent[] = [];
	const reading = interpretDoubao(
		JSON.stringify({
			type: "result",
			is_error: false,
			result: { type: "text", content: "完成" },
			tool_calls: [
				{ name: "Read", input: { file_path: "a.txt" }, result: { is_error: false } },
				{ name: "Bash", input: { command: "ls" }, result: { is_error: false } },
				{ name: "Write", input: { file_path: "b.txt" }, result: { is_error: true } },
			],
		}),
		0,
		(step) => events.push(step),
	);
	assert.equal(reading.ok, true);
	assert.equal(events.length, 3);
	assert.equal(events[2]?.failed, true);

	assert.deepEqual(
		doubaoStepEvents(
			parseDoubaoStdout(
				JSON.stringify({ type: "result", result: { type: "text", content: "x" } }),
			),
		),
		[],
	);
});

/* ── 统计行 / steps.jsonl ───────────────────────────────────────────── */

test("统计：读 / 命令 / 写 / 失败各算一类；空事件不硬凑一行", () => {
	const steps: CliStepEvent[] = [
		{ type: "tool", name: "read", detail: "a.txt", at: "" },
		{ type: "tool", name: "bash", detail: "ls", at: "" },
		{ type: "tool", name: "write", detail: "b.txt", at: "" },
		{ type: "status", name: "bash", detail: "退出码 1", failed: true, at: "" },
	];
	const stats = summarizeSteps(steps);
	assert.deepEqual(stats, {
		reads: 1,
		writes: 1,
		commands: 1,
		other: 0,
		total: 3,
		failed: 1,
	});
	assert.equal(
		formatStatsLine(stats),
		"（过程：读了 1 个文件、跑了 1 条命令、改了 1 个文件；1 次失败）",
	);
	assert.equal(formatStatsLine(emptyToolStats()), null);
	assert.equal(stepLineOf(steps[0]!), "读取 a.txt");
	assert.equal(stepLineOf(steps[3]!), "退出码 1（失败）");
});

test("runCliProcess：onLine 按行回调，末行无换行也补发", async () => {
	const lines: string[] = [];
	const result = await runCliProcess({
		label: "lines",
		command: process.execPath,
		args: ["-e", "process.stdout.write('{\"a\":1}\\n{\"b\":2}')"],
		stdin: null,
		cwd: tmpdir(),
		timeoutMs: 10_000,
		onLine: (line) => lines.push(line),
		interpret: () => ({ ok: true, sessionId: null, error: null, result: "ok" }),
	});
	assert.equal(result.ok, true);
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("dispatchTask：步骤落 steps.jsonl、算出统计；关开关后既不落盘也不回统计", async () => {
	const workRoot = mkdtempSync(join(tmpdir(), "cli-steps-"));
	const ticket = {
		id: "t-steps",
		prompt: "演示",
		status: "dispatching",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		options: { dry: false, maxTasks: 1, workRoot },
	} as Ticket;
	const task: PlannedTask = {
		title: "演示",
		slug: "demo",
		instruction: "做点事。",
		done_when: "REPORT.md 写清楚。",
		dependsOn: [],
		writes: [],
	};
	const report = '```json\n{"status":"ready","summary":"完成","artifacts":[]}\n```';
	const makeEmployee = (seen: { onStep: boolean }): Employee => ({
		kind: "claude-code",
		capabilities: { artifacts: "taskDir", canWriteFiles: true },
		run: async (employeeTask) => {
			seen.onStep = typeof employeeTask.onStep === "function";
			employeeTask.onStep?.({ type: "tool", name: "read", detail: "a.txt", at: "" });
			employeeTask.onStep?.({ type: "tool", name: "bash", detail: "ls", at: "" });
			employeeTask.onStep?.({ type: "tool", name: "write", detail: "b.txt", at: "" });
			employeeTask.onStep?.({
				type: "status",
				name: "bash",
				detail: "退出码 1",
				failed: true,
				at: "",
			});
			return {
				processOk: true,
				exitCode: 0,
				timedOut: false,
				aborted: false,
				reportRaw: report,
				stderrTail: "",
				sessionId: null,
				error: null,
			};
		},
	});

	try {
		const firstSeen = { onStep: false };
		const first = await dispatchTask(ticket, task, 1, workRoot, undefined, [], {
			employeeKind: "claude-code",
			employeeFactory: () => makeEmployee(firstSeen),
			streamEvents: true,
		});
		assert.equal(firstSeen.onStep, true);
		assert.deepEqual(first.toolStats, {
			reads: 1,
			writes: 1,
			commands: 1,
			other: 0,
			total: 3,
			failed: 1,
		});
		const stepsFile = join(workRoot, "01-demo", STEPS_FILE);
		const written = readSteps(stepsFile);
		assert.equal(written.length, 4);
		assert.equal(written[0]?.name, "read");
		assert.equal(written[3]?.failed, true);

		const secondSeen = { onStep: false };
		const second = await dispatchTask(ticket, task, 1, workRoot, undefined, [], {
			employeeKind: "claude-code",
			employeeFactory: () => makeEmployee(secondSeen),
			streamEvents: false,
		});
		assert.equal(secondSeen.onStep, false);
		assert.equal(second.toolStats, undefined);
		assert.equal(existsSync(stepsFile), false);
	} finally {
		rmSync(workRoot, { recursive: true, force: true });
	}
});

test("回滚开关：CHANCELLOR_CLI_STREAM_EVENTS=false/0/off 才关，默认开", () => {
	assert.equal(cliStreamEventsEnabled({} as NodeJS.ProcessEnv), true);
	assert.equal(
		cliStreamEventsEnabled({ CHANCELLOR_CLI_STREAM_EVENTS: "false" }),
		false,
	);
	assert.equal(
		cliStreamEventsEnabled({ CHANCELLOR_CLI_STREAM_EVENTS: "0" }),
		false,
	);
	assert.equal(
		cliStreamEventsEnabled({ CHANCELLOR_CLI_STREAM_EVENTS: "off" }),
		false,
	);
	assert.equal(
		cliStreamEventsEnabled({ CHANCELLOR_CLI_STREAM_EVENTS: "true" }),
		true,
	);
});
