import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildClaudeInvocation,
	isClaudeSuccess,
	parseClaudeStdout,
} from "../../../packages/chancellor/src/employee/claude.ts";
import {
	buildCodexInvocation,
	parseCodexStdout,
} from "../../../packages/chancellor/src/employee/codex.ts";
import {
	buildOpencodeInvocation,
	parseOpencodeStdout,
} from "../../../packages/chancellor/src/employee/opencode.ts";
import { resolveCliLauncher } from "../../../packages/chancellor/src/employee/cli.ts";

/* ── Claude Code ─────────────────────────────────────────── */

test("Claude：短提示进 argv；edit 用 acceptEdits，full 走 dangerously-skip", () => {
	const base = {
		prompt: "只回答 OK",
		cwd: "/tmp",
		model: "sonnet",
		timeoutMs: 1000,
		label: "01-test",
	};
	const edit = buildClaudeInvocation({ ...base, permission: "edit" });
	assert.equal(edit.stdin, null);
	assert.deepEqual(edit.args, [
		"-p",
		"只回答 OK",
		"--output-format",
		"json",
		"--permission-mode",
		"acceptEdits",
		"--model",
		"sonnet",
	]);

	const full = buildClaudeInvocation({ ...base, permission: "full" });
	assert.ok(full.args.includes("--dangerously-skip-permissions"));
	assert.ok(!full.args.includes("--permission-mode"));
});

test("Claude：长提示走 stdin；resume 带会话号；模型留空不传 --model", () => {
	const invocation = buildClaudeInvocation({
		prompt: "x".repeat(8001),
		cwd: "/tmp",
		model: "",
		permission: "read",
		timeoutMs: 1000,
		label: "01-test",
		resumeSessionId: "s-1",
	});
	assert.equal(invocation.stdin, "x".repeat(8001));
	assert.ok(!invocation.args.includes("x".repeat(8001)));
	assert.ok(invocation.args.includes("--resume"));
	assert.equal(invocation.args[invocation.args.indexOf("--resume") + 1], "s-1");
	assert.ok(invocation.args.includes("plan"));
	assert.ok(!invocation.args.includes("--model"));
});

test("Claude：type=result 同形解析；空结论不算失败，被拒才算失败", () => {
	const parsed = parseClaudeStdout(
		JSON.stringify({
			type: "result",
			is_error: false,
			result: "",
			session_id: "s-9",
			permission_denials: [],
		}),
	);
	assert.equal(parsed.sessionId, "s-9");
	assert.equal(parsed.found, true);
	assert.equal(isClaudeSuccess(0, parsed), true);
	assert.equal(
		isClaudeSuccess(0, { ...parsed, permissionDenials: 1, result: "x" }),
		false,
	);
	assert.equal(isClaudeSuccess(1, parsed), false);
});

/* ── Codex ───────────────────────────────────────────────── */

test("Codex：exec 参数与权限沙箱；resume 的会话号在选项之后", () => {
	const base = {
		prompt: "只回答 OK",
		cwd: "/tmp",
		model: "gpt-5.1-codex",
		timeoutMs: 1000,
		label: "01-test",
	};
	const fresh = buildCodexInvocation({ ...base, permission: "edit" });
	assert.equal(fresh.stdin, null);
	assert.deepEqual(fresh.args, [
		"exec",
		"--json",
		"--skip-git-repo-check",
		"-m",
		"gpt-5.1-codex",
		"-s",
		"workspace-write",
		"-c",
		'approval_policy="never"',
		"只回答 OK",
	]);

	const resumed = buildCodexInvocation({
		...base,
		permission: "full",
		resumeSessionId: "th-1",
	});
	assert.equal(resumed.args[0], "exec");
	assert.equal(resumed.args[1], "resume");
	assert.ok(resumed.args.includes("danger-full-access"));
	assert.ok(resumed.args.includes("th-1"));
	assert.equal(resumed.args[resumed.args.length - 1], "只回答 OK");
});

test("Codex：长提示用 - 从 stdin 读", () => {
	const invocation = buildCodexInvocation({
		prompt: "x".repeat(8001),
		cwd: "/tmp",
		model: "",
		permission: "read",
		timeoutMs: 1000,
		label: "01-test",
	});
	assert.equal(invocation.stdin, "x".repeat(8001));
	assert.equal(invocation.args[invocation.args.length - 1], "-");
	assert.ok(invocation.args.includes("read-only"));
});

test("Codex：thread.started 拿会话号，turn.failed 判失败，退出码非 0 判失败", () => {
	const ok = parseCodexStdout(
		[
			JSON.stringify({ type: "thread.started", thread_id: "th-9" }),
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "做完了" },
			}),
			JSON.stringify({ type: "turn.completed", usage: {} }),
		].join("\n"),
		0,
	);
	assert.deepEqual(ok, {
		ok: true,
		sessionId: "th-9",
		text: "做完了",
		error: null,
	});

	const failed = parseCodexStdout(
		JSON.stringify({
			type: "turn.failed",
			error: { message: "rate limited" },
		}),
		0,
	);
	assert.equal(failed.ok, false);
	assert.equal(failed.error, "rate limited");

	const exit1 = parseCodexStdout(
		JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
		1,
	);
	assert.equal(exit1.ok, false);
	assert.match(exit1.error ?? "", /退出码 1/);
});

/* ── OpenCode ────────────────────────────────────────────── */

test("OpenCode：run 参数；read 用 plan agent，其余用 --auto", () => {
	const base = {
		prompt: "只回答 OK",
		cwd: "/tmp",
		model: "alibaba-cn/deepseek-v4.1-flash",
		timeoutMs: 1000,
		label: "01-test",
	};
	const read = buildOpencodeInvocation({ ...base, permission: "read" });
	assert.deepEqual(read.args, [
		"run",
		"--standalone",
		"--format",
		"json",
		"-m",
		"alibaba-cn/deepseek-v4.1-flash",
		"--agent",
		"plan",
		"只回答 OK",
	]);
	const edit = buildOpencodeInvocation({ ...base, permission: "edit" });
	assert.ok(edit.args.includes("--auto"));
	assert.ok(!edit.args.includes("--agent"));

	const resumed = buildOpencodeInvocation({
		...base,
		permission: "full",
		resumeSessionId: "ses_1",
	});
	assert.equal(resumed.args[resumed.args.indexOf("--session") + 1], "ses_1");
});

test("OpenCode：长提示走 stdin", () => {
	const invocation = buildOpencodeInvocation({
		prompt: "x".repeat(8001),
		cwd: "/tmp",
		model: "",
		permission: "full",
		timeoutMs: 1000,
		label: "01-test",
	});
	assert.equal(invocation.stdin, "x".repeat(8001));
	assert.equal(invocation.args[invocation.args.length - 1], "--auto");
});

test("OpenCode：退出码 0 但带 error 事件必须判失败（实测踩过）", () => {
	const parsed = parseOpencodeStdout(
		JSON.stringify({
			type: "error",
			sessionID: "ses_bad",
			error: { type: "provider.no-route", message: "Model unavailable: x/y" },
		}),
		0,
	);
	assert.equal(parsed.ok, false);
	assert.equal(parsed.error, "Model unavailable: x/y");

	const text = parseOpencodeStdout(
		JSON.stringify({
			type: "text",
			sessionID: "ses_ok",
			part: { type: "text", text: "OK" },
		}),
		0,
	);
	assert.deepEqual(text, {
		ok: true,
		sessionId: "ses_ok",
		text: "OK",
		error: null,
	});
});

/* ── npm shim 启动 ───────────────────────────────────────── */

test("shim：.cmd 指向 .exe 时直接起 exe；指向 .js 时用 node 起", () => {
	const root = mkdtempSync(join(tmpdir(), "cli-shim-"));
	const exeDir = join(root, "node_modules", "@scope", "tool", "bin");
	mkdirSync(exeDir, { recursive: true });
	const exe = join(exeDir, "tool.exe");
	writeFileSync(exe, "");
	const cmd = join(root, "tool.cmd");
	writeFileSync(
		cmd,
		`@ECHO off\r\n"%dp0%\\node_modules\\@scope\\tool\\bin\\tool.exe" %*\r\n`,
	);
	const launcher = resolveCliLauncher(cmd);
	assert.equal(launcher.command, exe);
	assert.deepEqual(launcher.prefixArgs, []);

	const jsDir = join(root, "node_modules", "@scope", "js-tool", "bin");
	mkdirSync(jsDir, { recursive: true });
	const js = join(jsDir, "index.js");
	writeFileSync(js, "console.log('x')\n");
	const jsCmd = join(root, "js-tool.cmd");
	writeFileSync(
		jsCmd,
		`@ECHO off\r\nnode "%dp0%\\node_modules\\@scope\\js-tool\\bin\\index.js" %*\r\n`,
	);
	const nodeLauncher = resolveCliLauncher(jsCmd);
	assert.equal(nodeLauncher.command, process.execPath);
	assert.deepEqual(nodeLauncher.prefixArgs, [js]);
});
