import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { InMemoryStore, MemoryEngine } from "@lifediary/memory";
import { classifySourceKind, collectSourceEntries, listMemoryImportSources } from "./memory-import-sources.ts";

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

test("导入分类：按单条内容区分偏好 / 事实 / 经历，不把整份文件压成 fact", () => {
	// 同一份项目记忆里也能出现用户偏好；不能因为文件级 fallback=fact 就把它压成事实
	assert.equal(
		classifySourceKind("用户不喜欢紫色，偏好深蓝 / 青色，紫色只做少量点缀。", "fact"),
		"preference",
	);
	// 项目约束、实现细节仍然是事实
	assert.equal(
		classifySourceKind("APP 锁设置密码的弹层必须实现为独立全屏 Dialog，usePlatformDefaultWidth=false。", "fact"),
		"fact",
	);
	// 技术设计里的「风格一致」不是用户偏好
	assert.equal(
		classifySourceKind("Android 按钮统一用超椭圆，避免默认胶囊形状，以保持组件风格一致。", "fact"),
		"fact",
	);
	// 有任务描述 / 执行过程 / mermaid 的会话记录是经历
	assert.equal(
		classifySourceKind("## 任务描述\n实现登录页\n## 执行过程\n```mermaid\ngraph TD\nA-->B\n```", "fact"),
		"episode",
	);
	// WorkBuddy / 每日记忆的完成情况也是经历
	assert.equal(
		classifySourceKind("【完成情况】 - 处理了 20 个文件，已归档 18 个。", "fact"),
		"episode",
	);
	// USER.md 这类文件优先当偏好
	assert.equal(classifySourceKind("项目技术栈用 Kotlin + Compose。", "fact", { file: "USER.md" }), "preference");
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

test("qwen-awareness：与 Qoder 同构，.qwenworkcn 有货就收", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".qwenworkcn", "awareness", "main");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "小程序登录角色白名单在后端 AuthServiceImpl。\n§\nprobe-2\n");
		writeFileSync(join(dir, "USER.md"), "偏好深蓝/青色主题。\n");

		const entries = collectSourceEntries("qwen-awareness", home);
		assert.ok(entries);
		assert.equal(entries.length, 3);
		assert.equal(entries.find((entry) => entry.text === "probe-2")?.kind, "fact");
		assert.equal(entries.find((entry) => entry.text.startsWith("偏好深蓝"))?.kind, "preference");
	} finally {
		cleanup(home);
	}
});

test("zcode-projects：项目名前缀 + metadata.type 映射，MEMORY.md 索引不收", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".zcode", "cli", "memories", "projects", "lifediary-harness-a914f932a11d9f44", "memory");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "backend-dev-env.md"),
			"---\nname: backend-dev-env\ndescription: 本机启动口径\nmetadata:\n  node_type: memory\n  type: project\n---\n\nlifediary-backend 本机联调口径：上游 key 用 DASHSCOPE。\n",
		);
		writeFileSync(
			join(dir, "汇报风格.md"),
			"---\nmetadata:\n  type: feedback\n---\n\n汇报要大白话。\n",
		);
		writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n- backend-dev-env — 索引行不算条目\n");
		writeFileSync(join(dir, "笔记.txt"), "不是 md 不收");

		const entries = collectSourceEntries("zcode-projects", home);
		assert.ok(entries);
		assert.equal(entries.length, 2, "MEMORY.md 与非 md 不收");
		const env = entries.find((entry) => entry.text.includes("DASHSCOPE"));
		assert.ok(env);
		assert.equal(env.text.startsWith("【"), false, "前缀在导入时按匹配结果加，解析层是纯文本");
		assert.equal(env.projectLabel, "lifediary-harness", "项目名兜底标签，尾巴哈希剥掉");
		assert.deepEqual(env.projectHint, { name: "lifediary-harness" });
		assert.equal(env.kind, "fact", "metadata.type: project → fact");
		assert.equal(entries.find((entry) => entry.text.includes("大白话"))?.kind, "preference", "feedback → preference");
	} finally {
		cleanup(home);
	}
});

test("qoder-cli-projects：项目 slug 取尾段当标签，projects/ 半边只在这里收", () => {
	const home = fakeHome();
	try {
		const base = join(home, ".qoder", "memories", "2bf0390e");
		mkdirSync(join(base, "projects", "d-GitWarehouse-konwlegdecard", "history_task_workflow"), { recursive: true });
		writeFileSync(
			join(base, "projects", "d-GitWarehouse-konwlegdecard", "history_task_workflow", "卡片搭建流程.md"),
			"---\ntitle: 知识卡片功能模块搭建流程\n---\n\n先搭骨架再逐节点填充。\n",
		);
		const entries = collectSourceEntries("qoder-cli-projects", home);
		assert.ok(entries);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].text, "先搭骨架再逐节点填充。", "解析层不带前缀，导入时按匹配结果决定");
		assert.equal(entries[0].projectLabel, "konwlegdecard");
		assert.equal(entries[0].projectHint?.slug, "d-gitwarehouse-konwlegdecard", "slug 是匹配线索");
		assert.equal(entries[0].kind, "fact");
		// global 半边不属于这个来源
		assert.equal(collectSourceEntries("qoder-cli", join(home))?.length, 0);
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

test("claude-code：MEMORY.md 索引跳过，条目文件按 metadata.type 映射，项目名带多词", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".claude", "projects", "D--Projects-projects-student-milk-order", "memory");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "MEMORY.md"),
			"- [user_communication](user_communication.md) — 汇报要大白话\n- [project_build](project_build.md) — JDK21\n",
		);
		writeFileSync(
			join(dir, "user_communication.md"),
			"---\nname: user_communication\ndescription: 汇报风格\nmetadata:\n  type: user\n---\n\n汇报要大白话，结论先行。\n",
		);
		writeFileSync(
			join(dir, "project_build.md"),
			"---\nname: project_build\ndescription: 构建口径\nmetadata:\n  type: project\n---\n\n后端构建用 JDK 21。\n",
		);

		const entries = collectSourceEntries("claude-code", home);
		assert.ok(entries);
		assert.equal(entries.length, 2, "同目录有条目文件时，MEMORY.md 索引不重复收");
		assert.equal(entries.find((entry) => entry.text.includes("大白话"))?.kind, "preference");
		assert.equal(entries.find((entry) => entry.text.includes("JDK 21"))?.kind, "fact");
		assert.equal(entries[0].projectLabel, "student-milk-order", "多词项目名取 -projects- 之后整段");
		assert.deepEqual(entries[0].projectHint, { name: "student-milk-order", slug: "d--projects-projects-student-milk-order" });
	} finally {
		cleanup(home);
	}
});

test("qoder-ide：.qoder / .qoder-cn 两变体都收，MEMORY.md 索引跳过", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".qoder", "memory");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "- [m1](m1.md) — 索引摘要\n");
		writeFileSync(
			join(dir, "qoderwork-memory-10740c6cd844.md"),
			"---\nname: qoderwork-memory\ndescription: 模板库\nmetadata:\n  type: feedback\n---\n\nreport-video-agent 用模板库生成版式。\n",
		);
		const cn = join(home, ".qoder-cn", "memory");
		mkdirSync(cn, { recursive: true });
		writeFileSync(
			join(cn, "ui-preference.md"),
			"---\nmetadata:\n  type: user\n---\n\n界面不要紫色。\n",
		);

		const entries = collectSourceEntries("qoder-ide", home);
		assert.ok(entries);
		assert.equal(entries.length, 2);
		assert.equal(entries.find((entry) => entry.text.includes("模板库"))?.kind, "preference");
		assert.equal(entries.find((entry) => entry.text.includes("紫色"))?.kind, "preference");
	} finally {
		cleanup(home);
	}
});

test("qoder-ide-projects：多词项目 slug 解码成 student-milk-order", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".qoder", "projects", "D--Projects-projects-student-milk-order", "memory");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "# 索引\n- [x](x.md) — 不该收\n");
		writeFileSync(join(dir, "feedback_report_style.md"), "汇报先给结论，再展开。\n");

		const entries = collectSourceEntries("qoder-ide-projects", home);
		assert.ok(entries);
		assert.equal(entries.length, 1, "索引跳过");
		assert.equal(entries[0].projectLabel, "student-milk-order");
		assert.equal(entries[0].projectHint?.slug, "d--projects-projects-student-milk-order");
		assert.equal(entries[0].kind, "preference");
	} finally {
		cleanup(home);
	}
});

test("codebuddy-projects：项目记忆按目录收，user_ / project_ 文件名分 kind", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".codebuddy", "projects", "D--Projects-projects-student-milk-order", "memory");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "- [项目](project_x.md) — 索引\n");
		writeFileSync(join(dir, "user_role.md"), "用户是计算机专业师范生。\n");
		writeFileSync(join(dir, "project_build.md"), "后端构建用 JDK 21。\n");

		const entries = collectSourceEntries("codebuddy-projects", home);
		assert.ok(entries);
		assert.equal(entries.length, 2);
		assert.equal(entries.find((entry) => entry.text.includes("师范生"))?.kind, "preference");
		assert.equal(entries.find((entry) => entry.text.includes("JDK"))?.kind, "fact");
		assert.equal(entries[0].projectLabel, "student-milk-order");
	} finally {
		cleanup(home);
	}
});

test("workbuddy：MEMORY.md 按标题分节，正文自带【小节】", () => {
	const home = fakeHome();
	try {
		const dir = join(home, "WorkBuddy", "2026-09-24-19-49-07", ".workbuddy", "memory");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "MEMORY.md"),
			"# MEMORY.md - 长期记忆\n\n## 本机环境\n- ADB 不在 PATH，要用绝对路径。\n\n## 构建\n- 后端用 JDK 21。\n",
		);
		const entries = collectSourceEntries("workbuddy", home);
		assert.ok(entries);
		assert.equal(entries.length, 2);
		assert.ok(entries[0].text.startsWith("【本机环境】"));
		assert.ok(entries[0].text.includes("ADB"));
		assert.equal(entries[0].kind, "fact");
	} finally {
		cleanup(home);
	}
});

test("openclaw：USER.md 的空模板不当记忆，MEMORY.md 的正文照收", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".openclaw", "workspace");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "USER.md"),
			"# USER.md - About Your Human\n\n_Learn about the person you're helping. Update this as you go._\n\n- **Name:** _(What do they care about? What projects are they working on?)_\n",
		);
		writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n\n## 偏好\n- 不喜欢紫色。\n");
		const entries = collectSourceEntries("openclaw", home);
		assert.ok(entries);
		assert.equal(entries.length, 1, "模板 USER.md 被占位过滤");
		assert.ok(entries[0].text.includes("不喜欢紫色"));
		assert.equal(entries[0].kind, "preference");
	} finally {
		cleanup(home);
	}
});

test("codex：stage1_outputs 有行就按 episode 收，空库返回空", () => {
	const home = fakeHome();
	try {
		const dir = join(home, ".codex");
		mkdirSync(dir, { recursive: true });
		const dbPath = join(dir, "memories_1.sqlite");
		const db = new DatabaseSync(dbPath);
		db.exec("CREATE TABLE stage1_outputs(raw_memory TEXT, rollout_summary TEXT, generated_at INTEGER)");
		db.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?)").run(
			"用户偏好结论先行的汇报。",
			"这轮聊了记忆导入。",
			1760000000000,
		);
		db.close();

		const entries = collectSourceEntries("codex", home);
		assert.ok(entries);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].kind, "episode");
		assert.ok(entries[0].text.includes("结论先行"));
		assert.ok(entries[0].text.includes("摘要：这轮聊了记忆导入。"));
		assert.equal(entries[0].createdAt, new Date(1760000000000).toISOString());
	} finally {
		cleanup(home);
	}
});

test("没检测到的来源 count=0（前端灰态），全部 Agent 都出现在清单里", () => {
	const home = fakeHome();
	try {
		const sources = listMemoryImportSources(home);
		assert.ok(sources.length >= 30, "第二轮扩到全量清单");
		const ids = sources.map((source) => source.id);
		for (const id of [
			"qoder-cli",
			"qoder-cli-projects",
			"qoder-ide",
			"qoder-ide-projects",
			"qoder-awareness",
			"qwen-awareness",
			"codebuddy",
			"codebuddy-projects",
			"zcode-projects",
			"claude-code",
			"copilot",
			"workbuddy",
			"workbuddy-ai",
			"cindy",
			"trae-cn",
			"qianfan",
			"codex",
			"cherrystudio",
			"ima",
			"doubao",
		]) {
			assert.ok(ids.includes(id), `${id} 应在清单里`);
		}
		for (const id of ["cursor", "gemini-cli", "kimi", "zed"]) {
			const source = sources.find((item) => item.id === id);
			assert.ok(source, `${id} 应以灰态列出`);
			assert.equal(source?.count, 0, `${id} 空家目录应 0 条`);
		}
		for (const id of ["chatgpt-desktop", "claude-desktop"]) {
			assert.ok(!ids.includes(id), `${id} 已从云端来源清单删除`);
		}
		for (const source of sources) {
			assert.equal(source.count, 0, `空家目录下 ${source.id} 应为 0 条`);
		}
	} finally {
		cleanup(home);
	}
});

test("来源导入跨 global / project 去重：同一句只进一次", () => {
	const engine = new MemoryEngine({ store: new InMemoryStore({ redact: false }) });
	engine.remember({
		scope: { type: "global" },
		kind: "fact",
		content: "用户不喜欢在导入时重复落一份记忆。",
		source: "user",
	});
	const result = engine.importItems({
		scope: { type: "project", id: "test-project" },
		items: [{ text: "  用户不喜欢在导入时重复落一份记忆。 ", kind: "fact" }],
		dedupeScopes: ["global"],
	});
	assert.equal(result.added.length, 0, "global 已有的规范化等价条目应跳过");
	assert.equal(result.skipped, 1);
	assert.equal(result.total, 1);
});
