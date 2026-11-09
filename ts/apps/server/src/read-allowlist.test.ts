import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReadOnlyShellCommand, readAllowlistEnabled } from "./read-allowlist.ts";

/**
 * 只读白名单（任务书 T3 §2.5）：10 个正例 + 15 个反例。
 *
 * 反例覆盖：管道 / 重定向 / 命令分隔 / 变量 / glob / 越界 / 写命令混入 / 非 shell 工具。
 * 每个反例都必须 `false`——白名单只降噪，不放宽任何既有拦截。
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-read-allow-")));
const work = join(root, "work");
const outside = join(root, "outside");
mkdirSync(join(work, "src"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(work, "notes.md"), "hello\nworld\n");
writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(outside, "secret.txt"), "nope\n");

const cwd = work;

function bash(command: string): boolean {
	return isReadOnlyShellCommand("bash", { command }, work, cwd);
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test("只读白名单：开关默认关，只有明确写 1/true/on 才开", () => {
	assert.equal(readAllowlistEnabled({}), false);
	assert.equal(readAllowlistEnabled({ AGENT_READ_ALLOWLIST: "" }), false);
	assert.equal(readAllowlistEnabled({ AGENT_READ_ALLOWLIST: "false" }), false);
	assert.equal(readAllowlistEnabled({ AGENT_READ_ALLOWLIST: "1" }), true);
	assert.equal(readAllowlistEnabled({ AGENT_READ_ALLOWLIST: " TRUE " }), true);
	assert.equal(readAllowlistEnabled({ AGENT_READ_ALLOWLIST: "on" }), true);
});

test("只读白名单：10 个正例（纯读 + 路径在工作区）", () => {
	const positives = [
		"cat notes.md",
		"head -n 20 notes.md",
		"tail notes.md",
		"ls -la",
		"grep -rn hello .",
		"rg hello src",
		"wc -l notes.md",
		"find . -name notes.md",
		"stat notes.md",
		`cat ${join(work, "notes.md")}`,
	];
	for (const command of positives) {
		assert.equal(bash(command), true, `应放行却拦了：${command}`);
	}
	assert.equal(isReadOnlyShellCommand("powershell", { command: "cat notes.md" }, work, cwd), true);
});

test("只读白名单：15 个反例（管道/重定向/变量/glob/越界/写命令）", () => {
	const negatives = [
		"cat notes.md | grep hello",
		"cat notes.md > out.txt",
		"cat notes.md < notes.md",
		"cat notes.md ; rm -rf .",
		"cat notes.md && rm notes.md",
		"cat notes.md & ",
		"echo $HOME",
		"cat *.md",
		"cat notes.md?",
		"cat `pwd`",
		"cat $(pwd)",
		"cat ../outside/secret.txt",
		"cat /etc/passwd",
		"cat ~/notes.md",
		"rm notes.md",
		"mv notes.md src/",
		"curl https://example.com",
	];
	for (const command of negatives) {
		assert.equal(bash(command), false, `应拦却放行了：${command}`);
	}
});

test("只读白名单：只对 bash / powershell 生效，且必须有工作区根", () => {
	assert.equal(isReadOnlyShellCommand("write", { command: "cat notes.md" }, work, cwd), false);
	assert.equal(isReadOnlyShellCommand("read", { command: "cat notes.md" }, work, cwd), false);
	// 未设工作区 → 无法证明"在自己文件里"，保守照常问。
	assert.equal(isReadOnlyShellCommand("bash", { command: "cat notes.md" }, null, cwd), false);
	// 参数不合法 → 不放行。
	assert.equal(isReadOnlyShellCommand("bash", {}, work, cwd), false);
	assert.equal(isReadOnlyShellCommand("bash", { command: "   " }, work, cwd), false);
});
