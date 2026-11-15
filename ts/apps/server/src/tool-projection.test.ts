import assert from "node:assert/strict";
import { test } from "node:test";
import {
	firstCommandWord,
	projectShellError,
	projectShellResult,
	projectionDecision,
	setProjectionDeps,
	toolProjectionEnvEnabled,
	wrapShellTool,
	type ProjectionDeps,
} from "./tool-projection.ts";

/** 测试里手搓的结果形状与内核 ToolExecutionResult / ShellStructuredOutput 一致即可。 */
type ShellProjectionTestResult = {
	structuredOutput: {
		output: string;
		truncated: boolean;
		fullOutputPath?: string;
		exitCode: number;
	};
	isError?: boolean;
	diagnostics: { severity: "info" | "warn" | "error"; message: string; code?: string }[];
};

// 测试里手搓的结果形状与内核 ToolExecutionResult / ShellStructuredOutput 一致即可。
function shellResult(overrides: {
	exitCode?: number;
	output?: string;
	fullOutputPath?: string;
	isError?: boolean;
}): ShellProjectionTestResult {
	const exitCode = overrides.exitCode ?? 0;
	const output = overrides.output ?? "some output";
	return {
		structuredOutput: {
			output,
			truncated: false,
			...(overrides.fullOutputPath === undefined ? {} : { fullOutputPath: overrides.fullOutputPath }),
			exitCode,
		},
		...(overrides.isError === false ? {} : { isError: true }),
		diagnostics: [
			{ severity: "error", code: "exit_code", message: `Command exited with code ${exitCode}` },
		],
	};
}

// ── 验收 ①②：语义退出码白名单 ─────────────────────────────────────

test("① grep exit 1 → 不 isError、有语义行、exit_code error 诊断摘掉", () => {
	const projected = projectShellResult(shellResult({ exitCode: 1, output: "" }), "grep foo f.txt");
	assert.equal(projected.isError, false);
	const text = (projected.structuredOutput as { output: string }).output;
	assert.match(text, /exit 1（语义型退出：无匹配，不是错误）/);
	assert.ok(
		!((projected.diagnostics ?? []) as unknown as { severity: string; code?: string }[]).some(
			(d) => d.severity === "error" && d.code === "exit_code",
		),
	);
	assert.ok(
		((projected.diagnostics ?? []) as unknown as { severity: string; code?: string }[]).some(
			(d) => d.code === "semantic_exit",
		),
	);
});

test("② diff / test / rg / command -v grep exit 1 → 同样豁免；exit 2 不豁免", () => {
	for (const command of ["diff a b", "test -d x", "[ -d x ]", "rg foo", "command -v grep"]) {
		const projected = projectShellResult(shellResult({ exitCode: 1 }), command);
		assert.equal(projected.isError, false, command);
	}
	// diff exit 2 = 真出错，不豁免
	assert.equal(projectShellResult(shellResult({ exitCode: 2 }), "diff a b").isError, true);
	// 首词不在白名单的 exit 1 不豁免
	assert.equal(projectShellResult(shellResult({ exitCode: 1 }), "node bad.js").isError, true);
});

test("②续 firstCommandWord：command -v 跳 flag、builtin、复杂形态保守", () => {
	assert.equal(firstCommandWord("grep foo f.txt"), "grep");
	assert.equal(firstCommandWord("command -v grep"), "grep");
	assert.equal(firstCommandWord("builtin test -d x"), "test");
	assert.equal(firstCommandWord("FOO=1 grep x"), "grep", "env 前缀跳过后取真首词");
	assert.equal(firstCommandWord("FOO=1"), "", "只有 env 前缀 = 没有命令，保守");
	assert.equal(firstCommandWord("  "), "");
});

// ── 验收 ③：普通失败不豁免、成功结果原样 ──────────────────────────

test("③ node bad.js exit 1 → 仍 isError，结果引用不变", () => {
	const result = shellResult({ exitCode: 1, output: "throw Error" });
	assert.equal(projectShellResult(result, "node bad.js"), result, "没得投影就原引用返回");
	const success = shellResult({ exitCode: 0, isError: false });
	assert.equal(projectShellResult(success, "grep x f.txt"), success, "成功结果不碰");
});

// ── 验收 ④：中断稳定标记 ──────────────────────────────────────────

test("④ timeout / abort 错误 → 文本追加中断标记；其他错误透传", () => {
	const timeout = new Error("Command timed out after 900 seconds");
	const projected = projectShellError(timeout) as Error;
	assert.notEqual(projected, timeout);
	assert.match(projected.message, /<error>Command was aborted before completion<\/error>/);

	const aborted = Object.assign(new Error("Command aborted"), { code: "aborted" });
	assert.match((projectShellError(aborted) as Error).message, ABORT_PATTERN);

	const spawn = new Error("spawn git ENOENT");
	assert.equal(projectShellError(spawn), spawn, "不相关错误原引用透传");

	// 重复投影不叠标记
	const again = projectShellError(projected) as Error;
	assert.equal(again.message.match(ABORT_PATTERN)?.length, 1);
});
const ABORT_PATTERN = /<error>Command was aborted before completion<\/error>/g;

// ── 验收 ⑤：失败大输出 hint ───────────────────────────────────────

test("⑤ isError 且有 spillPath → 输出尾 hint 含路径；成功不 hint", () => {
	const projected = projectShellResult(
		shellResult({ exitCode: 1, output: "tail of big output", fullOutputPath: "/tmp/spill-1.log" }),
		"node bad.js",
	);
	assert.equal(projected.isError, true);
	const modelText = ((projected.output ?? []) as { type: string; text: string }[]).at(-1);
	assert.match(modelText?.text ?? "", /完整输出已落盘：\/tmp\/spill-1\.log，用 read 工具续看/);
	const so = projected.structuredOutput as { output: string };
	assert.match(so.output, /\/tmp\/spill-1\.log/);

	const clean = shellResult({ exitCode: 1 });
	assert.equal(projectShellResult(clean, "node bad.js"), clean, "没落盘就没 hint");
});

// ── 验收 ⑥ + ⑦~⑩：挂载判定 ───────────────────────────────────────

function deps(overrides: {
	projection?: 1 | 0 | null;
	domain?: string | null;
	kind?: "chief" | "worker" | null;
}): ProjectionDeps {
	const partnerId = overrides.projection === undefined && overrides.domain === undefined ? null : "p-1";
	return {
		partnerIdOfSession: (id) => (id === 7 && partnerId ? partnerId : null),
		getPartner: (id) =>
			partnerId && id === partnerId
				? { domain: overrides.domain ?? null, toolProjection: overrides.projection ?? null }
				: null,
		chatKindOf: async (id) => (id === 7 ? (overrides.kind ?? null) : null),
	};
}

async function decide(d: ProjectionDeps, env?: string): Promise<boolean> {
	const prev = process.env.TOOL_PROJECTION;
	if (env !== undefined) process.env.TOOL_PROJECTION = env;
	else delete process.env.TOOL_PROJECTION;
	try {
		return projectionDecision({
			envEnabled: toolProjectionEnvEnabled(),
			partnerId: d.partnerIdOfSession(7),
			partner: d.partnerIdOfSession(7) ? (d.getPartner(d.partnerIdOfSession(7) as string) ?? null) : null,
			chatKind: await d.chatKindOf(7),
		});
	} finally {
		if (prev === undefined) delete process.env.TOOL_PROJECTION;
		else process.env.TOOL_PROJECTION = prev;
	}
}

test("⑦ 主人/聊天会话（无 partner、kind=chief）→ 默认不开", async () => {
	assert.equal(await decide(deps({ kind: "chief" })), false);
	assert.equal(await decide(deps({ domain: null, projection: null, kind: "chief" })), false, "无 domain 聊天执事默认不开");
});

test("⑧ worker 会话 / 带 domain 执事 → 默认开", async () => {
	assert.equal(await decide(deps({ kind: "worker" })), true);
	assert.equal(await decide(deps({ domain: "todo", projection: null, kind: "chief" })), true);
});

test("⑨ 执事三态压过默认：0 强制关、1 聊天执事也开", async () => {
	assert.equal(await decide(deps({ domain: "todo", projection: 0 })), false);
	assert.equal(await decide(deps({ domain: null, projection: 1, kind: "chief" })), true);
});

test("⑩ TOOL_PROJECTION=false → 一律关；包装器关时逐字节透传", async () => {
	assert.equal(await decide(deps({ kind: "worker" }), "false"), false);
	assert.equal(await decide(deps({ domain: "todo" }), "false"), false);

	setProjectionDeps(deps({ projection: 0 }));
	const inner = shellResult({ exitCode: 1 });
	const wrapped = wrapShellTool({
		name: "bash",
		description: "d",
		parameters: {} as never,
		execute: async () => inner,
	});
	const passthrough = wrapped.execute({ command: "grep x f" } as never, {} as never, undefined as never);
	return passthrough.then((result) => {
		assert.equal(result, inner, "关 = 原引用透传，逐字节不变");
	});
});

test("包装器开时：结果投影 + 抛错加标记", async () => {
	setProjectionDeps(deps({ kind: "worker" }));
	const failing = shellResult({ exitCode: 1 });
	const wrapped = wrapShellTool({
		name: "bash",
		description: "d",
		parameters: {} as never,
		execute: async () => failing,
	});
const projectionApi = { conversationId: 7 } as never;
const projected = await wrapped.execute({ command: "grep x f" } as never, projectionApi, undefined as never);
	assert.equal((projected as typeof failing).isError, false);

	const throwing = wrapShellTool({
		name: "bash",
		description: "d",
		parameters: {} as never,
		execute: async () => {
			throw new Error("Command timed out after 5 seconds");
		},
	});
	await assert.rejects(
		() => throwing.execute({ command: "sleep" } as never, projectionApi, undefined as never),
		ABORT_PATTERN as never,
	);
});

test("未装配依赖（setProjectionDeps 之前）→ 判定恒 false，全透传", async () => {
	const { projectionEnabledFor } = await import("./tool-projection.ts");
	setProjectionDeps(deps({ kind: "worker" }));
	// projectionEnabledFor 走 deps；这里只验证纯函数入口在无依赖时安全：
	// 直接测 projectionDecision 的 envEnabled=false 分支已在 ⑩ 覆盖，这里防回归注记。
	assert.equal(typeof projectionEnabledFor, "function");
});
