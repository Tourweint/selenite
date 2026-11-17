import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	buildCodeBuddyEnv,
	buildCodeBuddyInvocation,
	isCodeBuddySuccess,
	parseCodeBuddyStdout,
	parseShimNodeEntry,
	resolveCodeBuddyLauncher,
	STDIN_PROMPT_THRESHOLD,
} from "../../../packages/chancellor/src/employee/codebuddy.ts";

/** 与真实 `--output-format json` 同形：数组，最后一项 type=result。 */
function realShape(patch: Record<string, unknown> = {}): string {
	return JSON.stringify([
		{ type: "system", subtype: "init", session_id: "s-1" },
		{ type: "assistant", message: { content: "收到" } },
		{
			type: "result",
			subtype: "success",
			is_error: false,
			result: "收到",
			session_id: "s-1",
			permission_denials: [],
			...patch,
		},
	]);
}

test("短提示进 argv：必带 -y 与 --model 全拼", () => {
	const invocation = buildCodeBuddyInvocation("只回答两个字：收到", "deepseek-v4.1-flash");
	assert.equal(invocation.stdin, null);
	assert.deepEqual(invocation.args, [
		"-p",
		"只回答两个字：收到",
		"--output-format",
		"json",
		"-y",
		"--model",
		"deepseek-v4.1-flash",
	]);
});

test("长提示走 stdin，argv 里不重复提示", () => {
	const boundary = "x".repeat(STDIN_PROMPT_THRESHOLD);
	assert.equal(buildCodeBuddyInvocation(boundary).stdin, null);

	const long = "x".repeat(STDIN_PROMPT_THRESHOLD + 1);
	const invocation = buildCodeBuddyInvocation(long);
	assert.equal(invocation.stdin, long);
	assert.deepEqual(invocation.args, [
		"-p",
		"--output-format",
		"json",
		"-y",
		"--model",
		"deepseek-v4.1-flash",
	]);
});

test("清掉宿主注入的 CODEBUDDY_* / WORKBUDDY_*，其余原样保留", () => {
	const env = buildCodeBuddyEnv({
		PATH: "C:/bin",
		LLM_API_KEY: "keep",
		CODEBUDDY_SESSION_ID: "host-session",
		codebuddy_token: "lower-case",
		WORKBUDDY_APP_VERSION: "0.6.0",
		WORKBUDDY_ENDPOINT: "http://127.0.0.1:9",
	});
	assert.deepEqual(Object.keys(env).sort(), ["LLM_API_KEY", "PATH"]);
	assert.equal(env.PATH, "C:/bin");
});

test("结果解析：数组里取最后一个 type=result", () => {
	const parsed = parseCodeBuddyStdout(realShape());
	assert.equal(parsed.found, true);
	assert.equal(parsed.result, "收到");
	assert.equal(parsed.sessionId, "s-1");
	assert.equal(parsed.isError, false);
	assert.equal(parsed.permissionDenials, 0);
	assert.equal(isCodeBuddySuccess(0, parsed), true);
});

test("结果解析：单对象与逐行 JSON 也认", () => {
	const single = JSON.stringify({
		type: "result",
		result: "ok",
		is_error: false,
		permission_denials: [],
	});
	assert.equal(parseCodeBuddyStdout(single).result, "ok");

	const lines = [
		'{"type":"system","subtype":"init"}',
		JSON.stringify({ type: "result", result: "ok", is_error: false }),
	].join("\n");
	assert.equal(parseCodeBuddyStdout(lines).result, "ok");
});

test("成功判定：permission_denials 非空即失败", () => {
	const parsed = parseCodeBuddyStdout(
		realShape({
			permission_denials: [{ tool_name: "Bash", tool_use_id: "t-1" }],
		}),
	);
	assert.equal(parsed.permissionDenials, 1);
	assert.equal(isCodeBuddySuccess(0, parsed), false);
});

test("成功判定：字段格式异常按有拒绝处理，不冒险判成功", () => {
	const parsed = parseCodeBuddyStdout(
		realShape({ permission_denials: "not-an-array" }),
	);
	assert.equal(parsed.permissionDenials, 1);
	assert.equal(isCodeBuddySuccess(0, parsed), false);
});

test("成功判定：is_error / 空结果 / 非零退出码都不算成", () => {
	const isError = parseCodeBuddyStdout(realShape({ is_error: true }));
	assert.equal(isError.isError, true);
	assert.equal(isCodeBuddySuccess(0, isError), false);

	const empty = parseCodeBuddyStdout(realShape({ result: "" }));
	assert.equal(isCodeBuddySuccess(0, empty), false);

	const ok = parseCodeBuddyStdout(realShape());
	assert.equal(isCodeBuddySuccess(1, ok), false);
	assert.equal(isCodeBuddySuccess(null, ok), false);
});

test("npm shim 解出 Node 入口：Windows 的 .cmd 不能直接 spawn", () => {
	const dir = mkdtempSync(join(tmpdir(), "codebuddy-shim-"));
	const entry = join(
		dir,
		"node_modules",
		"@tencent-ai",
		"codebuddy-code",
		"bin",
		"codebuddy",
	);
	mkdirSync(dirname(entry), { recursive: true });
	writeFileSync(entry, "");
	const shim = join(dir, "codebuddy.cmd");
	writeFileSync(
		shim,
		[
			"@ECHO off",
			"GOTO start",
			":find_dp0",
			"SET dp0=%~dp0",
			"EXIT /b",
			":start",
			"SETLOCAL",
			'CALL :find_dp0',
			'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*',
		].join("\r\n"),
	);

	const launcher = resolveCodeBuddyLauncher(shim);
	assert.equal(launcher.command, process.execPath);
	assert.deepEqual(launcher.prefixArgs, [entry]);
});

test("npm shim 解析兼容 .ps1 的写法", () => {
	const entry = parseShimNodeEntry(
		'& "$basedir/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy" $args',
		"C:/Users/me/AppData/Roaming/npm",
	);
	assert.equal(
		entry,
		join(
			"C:",
			"Users",
			"me",
			"AppData",
			"Roaming",
			"npm",
			"node_modules",
			"@tencent-ai",
			"codebuddy-code",
			"bin",
			"codebuddy",
		),
	);
});

test("没有任何 type=result 时明确报错", () => {
	const parsed = parseCodeBuddyStdout('{"type":"assistant","message":"半截"}');
	assert.equal(parsed.found, false);
	assert.equal(parsed.result, "");
	assert.equal(parsed.error, "codebuddy 输出里没有 type=result 的结果");
	assert.equal(isCodeBuddySuccess(0, parsed), false);
});
