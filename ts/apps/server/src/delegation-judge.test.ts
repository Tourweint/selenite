import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { JudgeInput } from "../../../../../chancellor/src/types.ts";
import { WRITE_TOOLS } from "./approval-policy.ts";
import {
	JUDGE_SESSION_PREFIX,
	JUDGE_TOOL_NAMES,
	capJudgeTool,
	createJudgeTools,
	guardJudgeRead,
	judgeBashAllowed,
	judgeReadAllowed,
	judgeRetestEnabled,
	judgeSessionName,
	judgeToolCapMessage,
	type JudgeToolCounter,
	parseJudgeOutput,
	renderJudgePrompt,
} from "./delegation-judge.ts";

/**
 * 证据裁判（2026-11-10 批 14）宿主侧：这里钉死**裁判只能读**。
 * 判定规则（降级 / 连续同因）在 chancellor/src/judge.test.ts。
 */

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "judge-ws-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
	writeFileSync(join(root, "README.md"), "# demo\n", "utf8");
	return root;
}

const INPUT: JudgeInput = {
	ticketId: "3f5a1c2e-1111-2222-3333-444455556666",
	prompt: "把 a.ts 补上 run()",
	steps: ["先读 README", "再写 a.ts"],
	cwd: "/tmp/proj",
	failureReason: "声明了 1 个路径，实际 0 个变更",
	maxTools: 8,
	tasks: [
		{
			seq: 1,
			slug: "write-a",
			title: "写 a.ts",
			doneWhen: "a.ts 里有 run()",
			writes: ["src/a.ts"],
			changedPaths: [],
			changedDetected: true,
			reportStatus: "ready",
			reportSummary: "写好了",
			reportError: null,
			employee: "native",
		},
	],
	reviews: [{ seq: 1, slug: "write-a", verdict: "fail", reason: "实际 0 个变更" }],
};

test("裁判工具面只有 read + bash：写 / edit / 派活结构性不在", () => {
	const root = workspace();
	const { tools } = createJudgeTools({ cwd: root, maxTools: 8 });
	assert.deepEqual(
		tools.map((tool) => tool.name),
		[...JUDGE_TOOL_NAMES],
	);
	// 白名单里的写类工具一个都不在（连名字都看不到）
	for (const name of ["write", "edit", "delegate", "powershell", "partner_manage", "routine_manage"]) {
		assert.equal(
			tools.some((tool) => tool.name === name),
			false,
			`裁判不该有 ${name}`,
		);
		assert.ok(WRITE_TOOLS.has(name), `${name} 仍是写类工具（对照用）`);
	}
});

test("bash 只读白名单：读命令放行，写 / 网络 / 逃逸 / 复合命令一律拒", () => {
	const root = workspace();
	const allowed = [
		"ls",
		"ls src",
		"cat README.md",
		"grep -n run src/a.ts",
		"rg TODO",
		"wc -l src/a.ts",
	];
	for (const command of allowed) {
		assert.equal(judgeBashAllowed(command, root, root), true, command);
	}
	const denied = [
		"rm -rf .",
		"npm test",
		"pnpm typecheck",
		"git status",
		"git commit -m x",
		"cat /etc/passwd",
		"cat README.md | grep demo",
		"cat README.md > out.txt",
		"echo hi",
		"node -e '1'",
		"cd src",
	];
	for (const command of denied) {
		assert.equal(judgeBashAllowed(command, root, root), false, command);
	}
	// 子目录里的相对路径仍在工作区内 → 放行
	assert.equal(judgeBashAllowed("cat ../README.md", join(root, "src"), root), true);
	// 越出工作区 → 拒
	assert.equal(judgeBashAllowed("cat ../../x", join(root, "src"), root), false);
});

test("read 也只读工作区内：越界路径直接拒绝，不读盘", async () => {
	const root = workspace();
	assert.equal(judgeReadAllowed("src/a.ts", root, root), true);
	assert.equal(judgeReadAllowed("README.md", root, root), true);
	assert.equal(judgeReadAllowed("../outside.txt", root, root), false);
	assert.equal(judgeReadAllowed(join(root, "..", "outside.txt"), root, root), false);

	const calls: string[] = [];
	const tool = guardJudgeRead(fakeTool(calls), root, root);
	const run = tool.execute as unknown as (a: unknown, b: unknown, c: unknown) => Promise<{
		isError?: boolean;
		output?: Array<{ text?: string }>;
	}>;
	const denied = await run({ path: "../outside.txt" }, {}, {});
	assert.equal(denied.isError, true);
	assert.deepEqual(calls, []);
	const allowed = await run({ path: "src/a.ts" }, {}, {});
	assert.equal(allowed.isError, undefined);
	assert.deepEqual(calls, ["src/a.ts"]);
});

function fakeTool(calls: string[]): ToolRegistration {
	return {
		name: "read",
		description: "fake",
		parameters: Type.Object({ path: Type.String() }),
		execute: async (args: unknown) => {
			calls.push(String((args as { path?: string }).path ?? ""));
			return { output: [{ type: "text" as const, text: "ok" }] };
		},
	} as unknown as ToolRegistration;
}

test("工具上限是结构性的：超限的调用不执行，只回一句别查了", async () => {
	const calls: string[] = [];
	const counter: JudgeToolCounter = { executed: 0, attempts: 0 };
	const tool = capJudgeTool(fakeTool(calls), counter, 2);

	const run = tool.execute as unknown as (a: unknown, b: unknown, c: unknown) => Promise<{
		isError?: boolean;
		output?: Array<{ text?: string }>;
	}>;
	await run({ path: "a" }, {}, {});
	await run({ path: "b" }, {}, {});
	const third = await run({ path: "c" }, {}, {});
	assert.equal(third.isError, true);
	assert.match(third.output?.[0]?.text ?? "", /上限/);
	assert.equal(third.output?.[0]?.text, judgeToolCapMessage(2));
	// 第三次没有到达执行层
	assert.deepEqual(calls, ["a", "b"]);
	assert.equal(counter.executed, 2);
});

test("裁判输出解析：只认 json 块；坏 verdict / 坏 json 一律 ok=false", () => {
	const good = parseJudgeOutput(
		'前面一句话\n```json\n{"verdict":"done","evidence":["读了 src/a.ts：有 run()"],"reason":"达成"}\n```',
	);
	assert.equal(good.ok, true);
	assert.equal(good.verdict, "done");
	assert.deepEqual(good.evidence, ["读了 src/a.ts：有 run()"]);
	assert.equal(good.reason, "达成");

	// evidence 里的非字符串 / 空串被剔掉，但结论仍然有效
	const filtered = parseJudgeOutput(
		'```json\n{"verdict":"continue","evidence":["看了 a.ts", 3, "  "],"reason":"还差 b.ts"}\n```',
	);
	assert.equal(filtered.ok, true);
	assert.deepEqual(filtered.evidence, ["看了 a.ts"]);

	assert.equal(parseJudgeOutput("没有代码块").ok, false);
	assert.equal(parseJudgeOutput("```json\n{坏\n```").ok, false);
	assert.equal(parseJudgeOutput('```json\n{"verdict":"maybe","reason":"x"}\n```').ok, false);
	assert.equal(parseJudgeOutput('```json\n{"verdict":"done"}\n```').ok, true);
});

test("裁判提示词：用户原话被包成不可信目标；四态与只读纪律都在", () => {
	const text = renderJudgePrompt(INPUT);
	assert.match(text, /<untrusted_objective>把 a\.ts 补上 run\(\)<\/untrusted_objective>/);
	assert.match(text, /最多 8 次工具调用/);
	assert.match(text, /没有写文件、改文件、派活的工具/);
	assert.match(text, /执行者说完成了不是证据/);
	assert.match(text, /`done`/);
	assert.match(text, /`continue`/);
	assert.match(text, /`blocked`/);
	assert.match(text, /`wait`/);
	assert.match(text, /声明了 1 个路径，实际 0 个变更/);
	assert.match(text, /01-write-a/);
	assert.match(text, /src\/a\.ts → 未变更/);
	assert.match(text, /先读 README/);
});

test("裁判会话名：task- 前缀（不进历史列表）且每次不同", () => {
	const first = judgeSessionName(INPUT.ticketId);
	const second = judgeSessionName(INPUT.ticketId);
	assert.ok(first.startsWith(JUDGE_SESSION_PREFIX));
	assert.ok(first.startsWith("task-judge-"));
	assert.notEqual(first, second);
});

test("裁判重跑测试（批 22 §三）：开关关照拒；开关开只放 test 形态与 git 只读子命令", () => {
	const root = workspace();
	const saved = process.env.DELEGATION_JUDGE_RETEST;
	try {
		// 开关关（缺省）：测试与 git 一律照拒（原行为回归）
		delete process.env.DELEGATION_JUDGE_RETEST;
		assert.equal(judgeBashAllowed("npm test", root, root), false);
		assert.equal(judgeBashAllowed("pnpm test", root, root), false);
		assert.equal(judgeBashAllowed("git diff", root, root), false);

		process.env.DELEGATION_JUDGE_RETEST = "true";
		// 放行：test 形态（可带路径参数）与 git 只读子命令
		const allowed = [
			"npm test",
			"npm test src/a.test.ts",
			"pnpm test",
			"pnpm run test:unit",
			"pnpm run test-e2e",
			"npx vitest run",
			"npx vitest run src/a.test.ts",
			"git status",
			"git diff",
			"git log --oneline",
			"git show HEAD",
			"git diff --stat src/",
		];
		for (const command of allowed) {
			assert.equal(judgeBashAllowed(command, root, root), true, command);
		}
		// 照拒：任意脚本 / 安装 / 写动作 / 可执行旗标 / 组合语法 / 通配
		const denied = [
			"npm run deploy",
			"npm install",
			"pnpm run lint",
			"npx vitest",
			"git commit -m x",
			"git push",
			"git checkout main",
			"git log -c foo=bar",
			"git diff --pretty=format:x",
			"npm test > out.txt",
			"npm test && echo done",
			"npm test src/*.ts",
			"git log `cat f`",
		];
		for (const command of denied) {
			assert.equal(judgeBashAllowed(command, root, root), false, command);
		}
		// 开关取值口径：true/1/on 开；false/0/off/其他 关
		for (const [value, want] of [["1", true], ["on", true], ["0", false], ["off", false], ["yes", false]] as const) {
			process.env.DELEGATION_JUDGE_RETEST = value;
			assert.equal(judgeRetestEnabled(), want, value);
		}
	} finally {
		if (saved === undefined) delete process.env.DELEGATION_JUDGE_RETEST;
		else process.env.DELEGATION_JUDGE_RETEST = saved;
	}
});
