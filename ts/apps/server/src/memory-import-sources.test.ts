import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSourceEntries, listMemoryImportSources } from "./memory-import-sources.ts";

/** 造一个假家目录，按真实来源的目录形状铺样本文件（形状 2026-11-15 逐家核实过）。 */
function fakeHome(): string {
	return mkdtempSync(join(tmpdir(), "mem-import-sources-"));
}

function cleanup(home: string): void {
	rmSync(home, { recursive: true, force: true });
}

test("未知来源 id 返回 null（调用方转 400）", () => {
	assert.equal(collectSourceEntries("chatgpt-desktop", "/nonexistent"), null);
	assert.equal(collectSourceEntries("../../etc/passwd", "/nonexistent"), null);
});

test("qoder-cli：global 分类解析条目，projects 子树不碰", () => {
	const home = fakeHome();
	try {
		const base = join(home, ".qoder", "memories", "abc123");
		mkdirSync(join(base, "global", "user_hobby"), { recursive: true });
		mkdirSync(join(base, "global", "project_tech_stack"), { recursive: true });
		mkdirSync(join(base, "projects", "d-foo"), { recursive: true });
		writeFileSync(
			join(base, "global", "user_hobby", "UI主题偏好.md"),
			'---\ntitle: "UI主题偏好"\nkeywords:\n    - "简约"\n---\n\n偏好简约风格，不要花哨的渐变。\n',
		);
		writeFileSync(
			join(base, "global", "project_tech_stack", "技术栈.md"),
			"没有 frontmatter 的文件也当记忆正文，整段收录。\n",
		);
		writeFileSync(join(base, "projects", "d-foo", "该不该收.md"), "项目级记忆，不该出现在 global 导入里。");

		const entries = collectSourceEntries("qoder-cli", home);
		assert.ok(entries, "来源应被识别");
		assert.equal(entries.length, 2, "projects/ 下的文件不收");
		const hobby = entries.find((entry) => entry.text.includes("简约风格"));
		assert.ok(hobby);
		assert.equal(hobby.kind, "preference", "user_* 分类映射偏好");
		assert.equal(hobby.text, "偏好简约风格，不要花哨的渐变。", "frontmatter 剥掉，正文留整段");
		const tech = entries.find((entry) => entry.text.includes("没有 frontmatter"));
		assert.equal(tech?.kind, "fact", "其余分类映射事实");
	} finally {
		cleanup(home);
	}
});

test("qoder-awareness：MEMORY.md 与 USER.md 按 § 分节，分别落 fact / preference", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".qoderworkcn", "awareness", "main");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "HF项目约定：HTML写根目录index.html。\n§\nLLM输出校验两层架构：L1结构→L2多样性。\n");
		writeFileSync(join(dir, "USER.md"), "配色不喜欢紫色过多，偏好深蓝/青色。\n§\n主要用DeepSeek API，默认模型deepseek-chat。\n");

		const entries = collectSourceEntries("qoder-awareness", home);
		assert.ok(entries);
		assert.equal(entries.length, 4, "两个文件各两节");
		const fromMemory = entries.find((entry) => entry.text.startsWith("HF项目约定"));
		assert.equal(fromMemory?.kind, "fact");
		const fromUser = entries.find((entry) => entry.text.startsWith("配色不喜欢"));
		assert.equal(fromUser?.kind, "preference", "USER.md 整个算偏好");
		assert.ok(entries.every((entry) => !entry.text.includes("§")), "分隔符不进正文");
	} finally {
		cleanup(home);
	}
});

test("qoder-awareness：.qoderwork 变体同构收进来，没有则不算条目", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".qoderwork", "awareness", "main");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "变体目录的一条。");
		const entries = collectSourceEntries("qoder-awareness", home);
		assert.ok(entries);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].text, "变体目录的一条。");
	} finally {
		cleanup(home);
	}
});

test("codebuddy：enabled: false 的条目跳过，updatedAt 优先于 mtime", () => {
	const home = fakeHome();
	try {
		const dir = join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", ".memories");
		mkdirSync(dir, { recursive: true });
		const active = join(dir, "81240803.mdc");
		writeFileSync(
			active,
			"---\nenabled: true\nupdatedAt: 2026-10-29T12:48:03.897Z\n---\n\n用户反对在 UI 上给手动模式开关。\n",
		);
		writeFileSync(
			join(dir, "disabled.mdc"),
			"---\nenabled: false\nupdatedAt: 2026-10-01T00:00:00.000Z\n---\n\n这条关掉了，不该收。\n",
		);
		writeFileSync(join(dir, ".memory-global-config.json"), "{}");
		// mtime 拨到 2020：createdAt 没跟 frontmatter 走就会露馅
		utimesSync(active, new Date("2020-01-01"), new Date("2020-01-01"));

		const entries = collectSourceEntries("codebuddy", home);
		assert.ok(entries);
		assert.equal(entries.length, 1, "enabled:false 与非 .mdc 都不收");
		assert.equal(entries[0].text, "用户反对在 UI 上给手动模式开关。");
		assert.equal(entries[0].createdAt, "2026-10-29T12:48:03.897Z", "frontmatter 时间优先于文件 mtime");
	} finally {
		cleanup(home);
	}
});

test("没检测到的来源 count=0（前端灰态），found 与否都出现在清单里", () => {
	const home = fakeHome();
	try {
		const sources = listMemoryImportSources(home);
		assert.equal(sources.length, 3, "白名单三个来源都列出");
		const ids = sources.map((source) => source.id);
		assert.deepEqual(ids, ["qoder-cli", "qoder-awareness", "codebuddy"]);
		for (const source of sources) {
			assert.equal(source.count, 0, `空家目录下 ${source.id} 应为 0 条`);
		}
	} finally {
		cleanup(home);
	}
});
