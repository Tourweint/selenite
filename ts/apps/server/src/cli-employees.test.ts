import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	buildDoubaoInvocation,
	createDoubaoEmployee,
	doubaoPermissionMode,
	interpretDoubao,
	parseDoubaoStdout,
	type DoubaoCall,
} from "../../../packages/chancellor/src/employee/doubao.ts";
import {
	buildOpencodeInvocation,
	parseOpencodeStdout,
} from "../../../packages/chancellor/src/employee/opencode.ts";
import {
	resolveCliLauncher,
	runCliProcess,
} from "../../../packages/chancellor/src/employee/cli.ts";
import { profileEnv, resolveProfile } from "../../../packages/chancellor/src/config.ts";
import {
	DOUBAO_MODEL,
	DOUBAO_PERMISSION,
} from "../../../packages/chancellor/src/config.ts";

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

test("Codex：turn.completed 之后的元数据 error 不推翻成功（2026-11-23 实测形状）", () => {
	// 本机 0.163.0 + magpie 网关正常成功的真实 stdout（service tier 提示 + 完整回合）。
	const metadata = JSON.stringify({
		type: "item.completed",
		item: {
			id: "item_0",
			type: "error",
			message:
				"Configured service tier `priority` is not advertised as supported for model `auto/glm-5.3-flash` and will be omitted from requests.",
		},
	});
	const parsed = parseCodexStdout(
		[
			JSON.stringify({ type: "thread.started", thread_id: "th-9" }),
			metadata,
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "BLUE-OTTER-42" },
			}),
			JSON.stringify({ type: "turn.completed", usage: {} }),
		].join("\n"),
		0,
	);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.text, "BLUE-OTTER-42");
	assert.equal(parsed.error, null);

	// 只有 error 事件、没有 turn.completed：软错误仍要判失败。
	const noTurn = parseCodexStdout(
		[
			JSON.stringify({ type: "thread.started", thread_id: "th-9" }),
			metadata,
		].join("\n"),
		0,
	);
	assert.equal(noTurn.ok, false);
	assert.match(noTurn.error ?? "", /service tier/);
});

test("Codex：致命 error 即使有 turn.completed 也判失败（模型不存在）", () => {
	const fatal = JSON.stringify({
		type: "error",
		message:
			'unexpected status 404 Not Found: magpie no longer serves "group/auto-model-does-not-exist-xyz"',
	});
	const parsed = parseCodexStdout(
		[
			JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
			fatal,
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "按理说不该有结论" },
			}),
			JSON.stringify({ type: "turn.completed", usage: {} }),
		].join("\n"),
		0,
	);
	assert.equal(parsed.ok, false);
	assert.match(parsed.error ?? "", /no longer serves/);
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

/* ── 豆包 CLI（2026-11-23）────────────────────────────────── */

test("豆包：-C 必须在首个参数；短提示进 argv，read 档退到 ask_risky", () => {
	const invocation = buildDoubaoInvocation(
		"只回答 OK",
		"D:/work",
		"person-deepseek-v4-1-flash-261017",
		"read",
	);
	assert.equal(invocation.stdin, null);
	assert.deepEqual(invocation.args, [
		"-C",
		"D:/work",
		"--model",
		"person-deepseek-v4-1-flash-261017",
		"--permission-mode",
		"ask_risky",
		"-p",
		"只回答 OK",
		"--output-format",
		"json",
	]);
	assert.equal(doubaoPermissionMode("edit"), "always_allow");
	assert.equal(doubaoPermissionMode("full"), "always_allow");
});

test("豆包：长提示走 -p - + stdin；resume 带会话号；模型留空不传 --model", () => {
	const longPrompt = "x".repeat(8001);
	const invocation = buildDoubaoInvocation(
		longPrompt,
		"D:/work",
		"",
		"full",
		"session-1",
	);
	assert.equal(invocation.stdin, longPrompt);
	assert.ok(!invocation.args.includes(longPrompt));
	assert.equal(invocation.args[0], "-C");
	assert.ok(invocation.args.includes("-p"));
	assert.equal(invocation.args[invocation.args.indexOf("-p") + 1], "-");
	const resumeAt = invocation.args.indexOf("--resume");
	assert.ok(resumeAt > 0);
	assert.equal(invocation.args[resumeAt + 1], "session-1");
	assert.ok(!invocation.args.includes("--model"));
	// 续跑参数必须在 -p 之前。
	assert.ok(resumeAt < invocation.args.indexOf("-p"));
});

test("豆包：正文在 result.content；is_error / 空结果 / 无 result 行都判失败", () => {
	const ok = parseDoubaoStdout(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			session_id: "d-1",
			result: { type: "text", content: "收到" },
			tool_calls: [],
		}),
	);
	assert.deepEqual(ok, {
		result: "收到",
		sessionId: "d-1",
		isError: false,
		found: true,
		error: null,
		toolCalls: [],
		toolCallsTruncated: false,
	});
	assert.equal(interpretDoubao(JSON.stringify({ type: "result", result: { type: "text", content: "收到" } }), 0).ok, true);

	const failed = parseDoubaoStdout(
		JSON.stringify({
			type: "result",
			subtype: "error",
			is_error: true,
			session_id: "d-2",
			result: { type: "text", content: "" },
		}),
	);
	assert.equal(failed.isError, true);
	assert.equal(
		interpretDoubao(JSON.stringify({ type: "result", is_error: true, result: { type: "text", content: "x" } }), 0).ok,
		false,
	);
	assert.equal(
		interpretDoubao(JSON.stringify({ type: "result", result: { type: "text", content: "" } }), 0).ok,
		false,
	);
	assert.equal(interpretDoubao("internal_error: 无法启动主任务", 1).ok, false);
});

test("runCliProcess：stdoutFile 走文件，不接管道也能拿到结果", async () => {
	const dir = mkdtempSync(join(tmpdir(), "doubao-file-"));
	const file = join(dir, "stdout.json");
	const payload = JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		session_id: "d-file",
		result: { type: "text", content: "收到" },
	});
	const result = await runCliProcess({
		label: "doubao-test",
		command: process.execPath,
		args: ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
		stdin: null,
		cwd: dir,
		timeoutMs: 10_000,
		stdoutFile: file,
		interpret: interpretDoubao,
	});
	try {
		assert.equal(result.ok, true);
		assert.equal(result.result, "收到");
		assert.equal(result.sessionId, "d-file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("豆包 employee：产物只认任务目录 REPORT.md；settings 下传模型与权限；resume 带会话号", async () => {
	const dir = mkdtempSync(join(tmpdir(), "doubao-employee-"));
	writeFileSync(join(dir, "TASK.md"), "TASK-BODY");
	writeFileSync(join(dir, "REPORT.md"), "DONE");
	const calls: DoubaoCall[] = [];
	const employee = createDoubaoEmployee(async (call) => {
		calls.push(call);
		return {
			ok: true,
			result: "ok",
			sessionId: "s-9",
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
		const task = {
			instruction: "do it",
			doneWhen: "REPORT.md",
			upstream: "",
			dir,
			settings: {
				model: "person-deepseek-v4-pro-ga-260813",
				permission: "read" as const,
			},
		};
		const outcome = await employee.run(task);
		assert.equal(outcome.reportRaw, "DONE");
		assert.equal(outcome.sessionId, "s-9");
		assert.equal(calls[0].prompt, "TASK-BODY");
		assert.equal(calls[0].model, "person-deepseek-v4-pro-ga-260813");
		assert.equal(calls[0].permission, "read");
		assert.equal(calls[0].cwd, dir);

		await employee.resume?.({ ...task, sessionId: "s-9" }, "同意");
		assert.equal(calls[1].resumeSessionId, "s-9");
		assert.equal(calls[1].prompt, "用户回复：同意");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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

/* ── 本机池模型（2026-11-19 模型分工；2026-11-23 native 退役后只剩 pool）──── */

test("豆包：默认模型是 DeepSeek V4.1 Flash；profileEnv 带模型与权限", () => {
	// 默认档钉在 DeepSeek V4.1 Flash（用户口径：模型用 DeepSeek 就行）。
	assert.equal(DOUBAO_MODEL, "person-deepseek-v4-1-flash-261017");
	assert.deepEqual(resolveProfile("doubao", {}), {
		model: DOUBAO_MODEL,
		permission: DOUBAO_PERMISSION,
	});
	assert.deepEqual(
		profileEnv("doubao", {
			model: "person-deepseek-v4-pro-ga-260813",
			permission: "read",
		}),
		{
			CHANCELLOR_DOUBAO_MODEL: "person-deepseek-v4-pro-ga-260813",
			CHANCELLOR_DOUBAO_PERMISSION: "read",
		},
	);
});

test("resolveProfile：本机池保留 model / modelRoute，空 model 不塞 profile", () => {
	const route = { baseUrl: "https://provider.example/v1", keyEnv: "PROVIDER_KEY" };
	assert.deepEqual(
		resolveProfile("pool", { model: " work-model ", modelRoute: route }),
		{ model: "work-model", modelRoute: route },
	);
	assert.deepEqual(resolveProfile("pool", { model: "" }), {});
	assert.deepEqual(resolveProfile("pool", { modelRoute: route }), {});
	// 外部 CLI 的语义不变：显式模型 + 权限原样合并。
	assert.deepEqual(
		resolveProfile("claude-code", { model: "opus", permission: "read" }),
		{ model: "opus", permission: "read" },
	);
});

test("profileEnv：本机池把模型路由翻成子进程 env；key 从宿主 env 现取", () => {
	const prev = process.env.PROVIDER_KEY;
	process.env.PROVIDER_KEY = "sk-test";
	try {
		assert.deepEqual(
			profileEnv("pool", {
				model: "work-model",
				modelRoute: {
					baseUrl: "https://provider.example/v1",
					keyEnv: "PROVIDER_KEY",
				},
			}),
			{
				CHANCELLOR_LLM_MODEL: "work-model",
				CHANCELLOR_LLM_BASE_URL: "https://provider.example/v1",
				// 2026-11-22：池桥子单要按变量名从自己的 env 取 key，值仍不过 HTTP。
				CHANCELLOR_LLM_KEY_ENV: "PROVIDER_KEY",
				CHANCELLOR_LLM_API_KEY: "sk-test",
			},
		);
	} finally {
		if (prev === undefined) delete process.env.PROVIDER_KEY;
		else process.env.PROVIDER_KEY = prev;
	}
});
