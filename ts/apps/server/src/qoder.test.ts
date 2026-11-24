import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	isCliSuccess,
	parseCliStdout,
	STDIN_PROMPT_THRESHOLD,
} from "../../../packages/chancellor/src/employee/cli.ts";
import {
	EXTERNAL_CLI_ORDER,
	selectExternalCli,
} from "../../../packages/chancellor/src/employee/external.ts";
import {
	buildQoderInvocation,
	createQoderEmployee,
	qoderPermissionMode,
	resolveQoderBinary,
	type QoderCall,
} from "../../../packages/chancellor/src/employee/qoder.ts";
import { profileEnv, resolveProfile } from "../../../packages/chancellor/src/config.ts";

function call(prompt: string, tools: "none" | "all" = "all") {
	return {
		prompt,
		cwd: "D:/tmp/task",
		tools,
		timeoutMs: 600_000,
		label: "t",
	};
}

function permissionModeOf(args: string[]): string | undefined {
	const index = args.indexOf("--permission-mode");
	return index >= 0 ? args[index + 1] : undefined;
}

test("Qoder 写任务（不传权限档）：bypass_permissions + json + 模型 + 40 轮上限", () => {
	const invocation = buildQoderInvocation(call("写个文件"), "DeepSeek-Flash");
	assert.equal(invocation.stdin, null);
	assert.deepEqual(invocation.args, [
		"-p",
		"写个文件",
		"-w",
		"D:/tmp/task",
		"--permission-mode",
		"bypass_permissions",
		"-o",
		"json",
		"-m",
		"DeepSeek-Flash",
		"--max-turns",
		"40",
	]);
});

test("Qoder 权限三档 → 原生 --permission-mode（2026-11-23 实测映射）", () => {
	assert.equal(qoderPermissionMode("read"), "dont_ask");
	assert.equal(qoderPermissionMode("edit"), "accept_edits");
	assert.equal(qoderPermissionMode("full"), "bypass_permissions");
	for (const permission of ["read", "edit", "full"] as const) {
		const invocation = buildQoderInvocation(
			{ ...call("干活"), permission },
			"DeepSeek-Flash",
		);
		assert.equal(
			permissionModeOf(invocation.args),
			qoderPermissionMode(permission),
			`${permission} 档要落到自己的原生档名`,
		);
	}
});

test("Qoder 纯问答固定 dont_ask，不吃权限档（tools:none）", () => {
	for (const permission of ["read", "edit", "full"] as const) {
		const invocation = buildQoderInvocation(
			{ ...call("这是什么", "none"), permission },
			"DeepSeek-Flash",
		);
		assert.equal(permissionModeOf(invocation.args), "dont_ask");
	}
});

test("resolveProfile / profileEnv：Qoder 国际与国内都带权限档", () => {
	assert.equal(resolveProfile("qoder-intl", { permission: "read" }).permission, "read");
	assert.equal(resolveProfile("mercenary", { permission: "edit" }).permission, "edit");
	assert.equal(resolveProfile("qoder-cn", { permission: "full" }).permission, "full");
	// 没给权限档 = env 缺省 full（旧配置行为不变）。
	assert.equal(resolveProfile("qoder-intl", {}).permission, "full");
	assert.equal(resolveProfile("qoder-cn", {}).permission, "full");

	assert.deepEqual(
		profileEnv("qoder-intl", { model: "m", permission: "edit" }),
		{ CHANCELLOR_MODEL: "m", CHANCELLOR_QODER_PERMISSION: "edit" },
	);
	assert.deepEqual(
		profileEnv("mercenary", { permission: "read" }),
		{ CHANCELLOR_QODER_PERMISSION: "read" },
	);
	assert.deepEqual(
		profileEnv("qoder-cn", { model: "m", permission: "read" }),
		{ CHANCELLOR_QODER_CN_MODEL: "m", CHANCELLOR_QODER_CN_PERMISSION: "read" },
	);
});

test("Qoder 纯问答：dont_ask + 空 tools + 6 轮上限", () => {
	const invocation = buildQoderInvocation(call("这是什么", "none"), "DeepSeek-Flash");
	assert.deepEqual(invocation.args, [
		"-p",
		"这是什么",
		"-w",
		"D:/tmp/task",
		"--permission-mode",
		"dont_ask",
		"-o",
		"json",
		"--tools",
		"",
		"-m",
		"DeepSeek-Flash",
		"--max-turns",
		"6",
	]);
});

test("Qoder employee：settings 下传权限档；旧配置没权限档 = full", async () => {
	const dir = mkdtempSync(join(tmpdir(), "qoder-employee-"));
	writeFileSync(join(dir, "TASK.md"), "TASK-BODY");
	writeFileSync(join(dir, "REPORT.md"), "DONE");
	const calls: QoderCall[] = [];
	const employee = createQoderEmployee("qoder-intl", async (call) => {
		calls.push(call);
		return {
			ok: true,
			result: "ok",
			sessionId: "s-1",
			isError: false,
			permissionDenials: 0,
			exitCode: 0,
			timedOut: false,
			aborted: false,
			stderrTail: "",
			error: null,
		};
	});
	try {
		const base = {
			instruction: "do it",
			doneWhen: "REPORT.md",
			upstream: "",
			dir,
		};
		await employee.run({ ...base, settings: { permission: "read" as const } });
		assert.equal(calls[0].permission, "read");
		assert.equal(calls[0].tools, "all");

		await employee.run(base);
		assert.equal(calls[1].permission, "full");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Qoder 长提示走 stdin", () => {
	const prompt = "x".repeat(STDIN_PROMPT_THRESHOLD + 1);
	const invocation = buildQoderInvocation(call(prompt), "DeepSeek-Flash");
	assert.equal(invocation.stdin, prompt);
	assert.equal(invocation.args.includes(prompt), false);
	assert.equal(invocation.args[0], "-p");
});

test("0 字节壳回退到带版本号真身，取最高版本", () => {
	const dir = mkdtempSync(join(tmpdir(), "qoder-bin-"));
	const shell = join(dir, "qodercli.exe");
	writeFileSync(shell, "");
	writeFileSync(join(dir, "qodercli-1.0.16.exe"), "old");
	writeFileSync(join(dir, "qodercli-1.1.81.exe"), "new");

	assert.equal(
		resolveQoderBinary(shell),
		join(dir, "qodercli-1.1.81.exe"),
	);
	assert.equal(
		resolveQoderBinary(join(dir, "qodercli-1.1.81.exe")),
		join(dir, "qodercli-1.1.81.exe"),
	);
});

test("外部执行优先级：CodeBuddy → Qoder 国际版 → Qoder CN", async () => {
	const okOnly = (name: string) => async (candidate: string) => ({
		ok: candidate === name,
		detail: "",
	});
	assert.equal(
		await selectExternalCli(EXTERNAL_CLI_ORDER, okOnly("codebuddy")),
		"codebuddy",
	);
	assert.equal(
		await selectExternalCli(EXTERNAL_CLI_ORDER, okOnly("qoder-intl")),
		"qoder-intl",
	);
	assert.equal(
		await selectExternalCli(EXTERNAL_CLI_ORDER, okOnly("qoder-cn")),
		"qoder-cn",
	);
	assert.equal(
		await selectExternalCli(EXTERNAL_CLI_ORDER, async () => ({ ok: false, detail: "" })),
		null,
	);
});

test("Qoder 输出解析与 CodeBuddy 共用同一套成功判定", () => {
	const line = JSON.stringify({
		type: "result",
		result: "收到",
		is_error: false,
		permission_denials: [],
		session_id: "s-2",
	});
	const parsed = parseCliStdout(line, "qoder-intl");
	assert.equal(parsed.result, "收到");
	assert.equal(parsed.permissionDenials, 0);
	assert.equal(isCliSuccess(0, parsed), true);

	const denied = parseCliStdout(
		JSON.stringify({
			type: "result",
			result: "半截",
			is_error: false,
			permission_denials: [{ tool_name: "Write" }],
		}),
		"qoder-cn",
	);
	assert.equal(denied.permissionDenials, 1);
	assert.equal(isCliSuccess(0, denied), false);
});
