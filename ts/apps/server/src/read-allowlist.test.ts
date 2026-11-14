import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReadOnlyShellCommand, isViewOnlyShellCommand, readAllowlistEnabled } from "./read-allowlist.ts";

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
	return isReadOnlyShellCommand("bash", { command }, [work], cwd);
}

function view(command: string, roots: string[] = [work], where: string = cwd): boolean {
	return isViewOnlyShellCommand("bash", { command }, roots, where);
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
	assert.equal(isReadOnlyShellCommand("powershell", { command: "cat notes.md" }, [work], cwd), true);
	// 多根（2026-11-12）：另一个已登记目录里的只读命令也放行。
	assert.equal(
		isReadOnlyShellCommand("bash", { command: `cat ${join(outside, "secret.txt")}` }, [work, outside], cwd),
		true,
	);
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
	assert.equal(isReadOnlyShellCommand("write", { command: "cat notes.md" }, [work], cwd), false);
	assert.equal(isReadOnlyShellCommand("read", { command: "cat notes.md" }, [work], cwd), false);
	// 未设工作区 → 无法证明"在自己文件里"，保守照常问。
	assert.equal(isReadOnlyShellCommand("bash", { command: "cat notes.md" }, [], cwd), false);
	// 参数不合法 → 不放行。
	assert.equal(isReadOnlyShellCommand("bash", {}, [work], cwd), false);
	assert.equal(isReadOnlyShellCommand("bash", { command: "   " }, [work], cwd), false);
});

// ── 权限档位口径（2026-11-14）：只读 / 在工作区内修改 两档放行的就是这一份 ──
test("查看命令（权限口径）：正例——真在「看」的写法放行", () => {
	const positives = [
		"ls",
		"ls -la",
		"ls src",
		"dir",
		"cat notes.md",
		"cat notes.md src/a.ts",
		"type notes.md",
		"head -n 20 notes.md",
		"tail notes.md",
		"grep -rn hello .",
		"rg hello src",
		"find . -name notes.md",
		"wc -l notes.md",
		"stat notes.md",
		"file notes.md",
		`cat ${join(work, "notes.md")}`,
	];
	for (const command of positives) {
		assert.equal(view(command), true, `应放行却拦了：${command}`);
	}
	assert.equal(isViewOnlyShellCommand("powershell", { command: "ls -Force" }, [work], cwd), true);
	// 多根：另一个已登记目录里的查看同样放行。
	assert.equal(isViewOnlyShellCommand("bash", { command: `cat ${join(outside, "secret.txt")}` }, [work, outside], cwd), true);
});

test("查看命令（权限口径）：反例——看着像查看，其实在动手", () => {
	const negatives = [
		// 会删 / 会执行 / 会往文件里写
		"find . -delete",
		"find . -exec rm {} ;",
		"find . -execdir rm {} ;",
		"find . -ok rm {} ;",
		"find . -fprint out.txt",
		"find . -fls out.txt",
		"rg --pre ./x hello",
		"rg --pre=./x hello",
		// 旧降噪词表里有、这里刻意不算的（sort -o 写盘 / uniq 第二位置参数就是输出）
		"sort -o out.txt notes.md",
		"uniq notes.md out.txt",
		"where notes.md",
		// 词表外的通用命令
		"rm notes.md",
		"mv notes.md src/",
		"echo hi > notes.md",
		"npm install",
		"git status",
		"curl https://example.com",
		// 路径 / 逃逸
		"cat ../outside/secret.txt",
		"cat /etc/passwd",
		"cat ~/notes.md",
		"cat *.md",
		"cat notes.md | grep hello",
		// 首 token 带路径 = 让模型指定可执行文件
		"./cat notes.md",
	];
	for (const command of negatives) {
		assert.equal(view(command), false, `应拦却放行了：${command}`);
	}
	// 语境外置：cwd 不在根里、根集合为空、参数缺失，一律不算查看。
	assert.equal(view("ls", [work], outside), false, "cwd 在根外时 `ls` 看的是别人家");
	assert.equal(view("ls", []), false);
	assert.equal(isViewOnlyShellCommand("bash", {}, [work], cwd), false);
	assert.equal(isViewOnlyShellCommand("bash", { command: "ls" }, [work], ""), false);
	assert.equal(isViewOnlyShellCommand("write", { command: "ls" }, [work], cwd), false);
});
