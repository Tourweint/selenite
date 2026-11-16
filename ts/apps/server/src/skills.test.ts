import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { mountSkills, SKILL_SLOT_LIMIT } from "./skills-api.ts";
import {
	APP_SKILLS_DIR,
	createSkillStore,
	resolveSkillsDir,
	scanSkillDir,
	skillsIndexClipEnabled,
	skillsIndexSummaryChars,
	type ResolvedSkillsDir,
} from "./skills.ts";

/**
 * 技能（2026-11-08 扫尾批 9-S；批 10-A 加标准用户目录与两种文件形态）单测。
 *
 * 三段：
 *   1. 目录解析优先级：env 显式 → 用户目录（自动建）→ `~/.agents/skills`（只读）→ 应用目录兜底；
 *   2. 加载器：扁平 `<名>.md` + 目录 `<名>/SKILL.md`，同名先到先得、坏文件占名不顶替；
 *   3. 端点 CRUD 与边界：名字白名单、64KB 上限、两行结构、越界（含符号链接）拒绝、只读来源不可写删。
 *
 * 全部落在系统临时目录，跑完即删；不碰真实 `.data` 与用户主目录。
 */

let root = "";
let previousStatePath: string | undefined;
test.before(() => {
	root = mkdtempSync(join(tmpdir(), "lifediary-skills-"));
	// 启停位单例在第一次 mountSkills 时按这个 env 解析；指到临时目录，测试不碰真实 .data。
	previousStatePath = process.env.AGENT_SKILLS_STATE_PATH;
	process.env.AGENT_SKILLS_STATE_PATH = join(root, "skills-state.json");
});
test.after(() => {
	if (previousStatePath === undefined) delete process.env.AGENT_SKILLS_STATE_PATH;
	else process.env.AGENT_SKILLS_STATE_PATH = previousStatePath;
	if (root) rmSync(root, { recursive: true, force: true });
});

function freshDir(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("resolveSkillsDir：AGENT_SKILLS_DIR 显式最高优先，且不替用户建目录；链里仍带 .agents 与应用目录", () => {
	const envDir = join(root, "env-skills");
	const home = join(root, "home-env");
	const appDir = join(root, "app-env");
	const result = resolveSkillsDir({
		env: { AGENT_SKILLS_DIR: envDir, USERPROFILE: home },
		home,
		appDir,
	});
	assert.equal(result.dir, envDir);
	assert.equal(result.origin, "env");
	assert.equal(existsSync(envDir), false, "显式目录不存在时不该被自动创建");
	assert.equal(existsSync(join(home, ".lifediary", "skills")), false, "显式模式下不建用户目录");
	assert.deepEqual(
		result.dirs.map((source) => [source.origin, source.writable]),
		[
			["env", true],
			["agents", false],
			["app", false],
		],
		"读取链 = env → .agents → 应用目录，只有主目录可写",
	);
	assert.equal(result.dirs[1]?.dir, join(home, ".agents", "skills"));
	assert.equal(result.dirs[2]?.dir, appDir);
});

test("resolveSkillsDir：无显式配置时落用户目录，并首次访问自动建目录", () => {
	const home = join(root, "home-user");
	const result = resolveSkillsDir({ env: {}, home });
	assert.equal(result.origin, "user");
	assert.equal(result.dir, join(home, ".lifediary", "skills"));
	assert.equal(existsSync(result.dir), true, "用户目录应被自动创建");
	assert.deepEqual(
		result.dirs.map((source) => source.origin),
		["user", "agents", "app"],
	);
	assert.equal(result.dirs[0]?.writable, true);
	assert.equal(result.dirs[1]?.exists, false, ".agents/skills 不存在时如实标 false（加载器跳过）");
});

test("resolveSkillsDir：用户目录建不出来时回落应用目录，且链里不留重复项", () => {
	// 用文件冒充主目录：join(file, ".lifediary", "skills") 的 mkdir 必然失败（ENOTDIR/EEXIST）
	const blocker = join(root, "home-blocked");
	writeFileSync(blocker, "not a directory");
	const appDir = join(root, "app-skills");
	const result = resolveSkillsDir({ env: {}, home: blocker, appDir });
	assert.equal(result.origin, "app");
	assert.equal(result.dir, appDir);
	assert.equal(result.dirs[0]?.dir, appDir, "主目录排第一");
	assert.equal(
		result.dirs.filter((source) => source.origin === "app").length,
		1,
		"应用目录既是主目录又是兜底时只留一项",
	);
});

test("加载器：扁平 .md 与 目录/SKILL.md 两种形态并存，同名时扁平优先", () => {
	const dir = freshDir("loader-forms");
	writeFileSync(join(dir, "alpha.md"), "摘要 A\n正文 A");
	mkdirSync(join(dir, "beta"));
	writeFileSync(
		join(dir, "beta", "SKILL.md"),
		"---\nname: beta\ndescription: 摘要 B\ntools: [x]\n---\n\n正文 B\n",
	);
	mkdirSync(join(dir, "alpha-dir"));
	writeFileSync(join(dir, "alpha-dir", "SKILL.md"), "---\ndescription: 目录摘要\n---\n目录正文");
	mkdirSync(join(dir, "same"));
	writeFileSync(join(dir, "same", "SKILL.md"), "---\ndescription: 目录版同名\n---\n目录正文");
	writeFileSync(join(dir, "same.md"), "扁平版同名\n扁平正文");
	// 格式不对：没有 frontmatter description → 不上索引，但仍占名
	mkdirSync(join(dir, "broken"));
	writeFileSync(join(dir, "broken", "SKILL.md"), "只有正文，没有 frontmatter");
	// 多行块标量（2026-11-11 起 description: > 折叠块正常解析，不再整条跳过）
	mkdirSync(join(dir, "block"));
	writeFileSync(join(dir, "block", "SKILL.md"), "---\ndescription: >\n  多行描述\n---\n正文");

	const store = createSkillStore(dir);
	assert.ok(store);
	assert.deepEqual(store.names().sort(), ["alpha", "alpha-dir", "beta", "block", "same"]);
	assert.equal(store.manual("alpha"), "正文 A");
	assert.equal(store.manual("beta"), "正文 B", "frontmatter 之后的正文，忽略其余字段");
	assert.equal(store.manual("alpha-dir"), "目录正文");
	assert.equal(store.manual("same"), "扁平正文", "同目录同名时扁平 .md 先到先得");
	assert.equal(store.manual("broken"), undefined);
	assert.equal(store.manual("block"), "正文", "多行块 description 不再挡住整条技能");
	const index = store.indexFor(1) ?? "";
	assert.match(index, /alpha：摘要 A/);
	assert.match(index, /beta：摘要 B/);
	assert.match(index, /block：多行描述/);
	assert.doesNotMatch(index, /broken/);
});

test("previewIndex：按当前可见性现渲染，不把预览结果冻进会话快照（默认开销页用）", () => {
	const dir = freshDir("preview-no-freeze");
	writeFileSync(join(dir, "alpha.md"), "摘要 A\n正文 A");
	let visible = true;
	const store = createSkillStore(dir, {
		visibleFor: (_partnerId, _name) => visible,
	});
	assert.ok(store);
	const frozen = store.indexFor(11, "preview-partner") ?? "";
	assert.match(frozen, /alpha：摘要 A/, "首次 indexFor 按当时可见性冻结");
	visible = false;
	assert.equal(store.previewIndex?.("preview-partner"), undefined, "预览按当前可见性现渲染，不读 frozen");
	assert.match(store.indexFor(11, "preview-partner") ?? "", /alpha：摘要 A/, "indexFor 仍用第一轮快照，未被预览污染");
});

test("索引摘要截断（2026-11-15 上下文预算批）：截断只改索引那一行，正文手册完整", () => {
	const dir = freshDir("index-clip");
	const longSummary = "长".repeat(300);
	mkdirSync(join(dir, "long"));
	writeFileSync(
		join(dir, "long", "SKILL.md"),
		`---\ndescription: ${longSummary}\n---\n完整正文不能被截`,
	);

	// 传 120：索引行截到 120 字（含省略号），手册仍是全文
	const clipped = createSkillStore(dir, { indexSummaryChars: 120 });
	assert.ok(clipped);
	const line = (clipped.indexFor(1) ?? "")
		.split("\n")
		.find((row) => row.startsWith("- long："));
	assert.ok(line, "索引里应有这条技能");
	const summary = line.slice("- long：".length);
	assert.equal(summary.length, 120, "摘要截断到 120 字");
	assert.ok(summary.endsWith("…"), "截断后带省略号");
	assert.equal(clipped.manual("long"), "完整正文不能被截", "手册取的是全文，不受截断影响");

	// 0 / 不传 = 不截断（一行回滚 / 旧行为）
	const off = createSkillStore(dir, { indexSummaryChars: 0 });
	assert.ok((off?.indexFor(2) ?? "").includes(longSummary), "0 = 不截断");
	const legacy = createSkillStore(dir);
	assert.ok((legacy?.indexFor(3) ?? "").includes(longSummary), "不传 = 旧行为不截断");

	// 摘要没超长时原样（不补省略号）
	mkdirSync(join(dir, "short"));
	writeFileSync(join(dir, "short", "SKILL.md"), "---\ndescription: 短摘要\n---\n正文");
	const shortStore = createSkillStore(dir, { indexSummaryChars: 120 });
	assert.ok((shortStore?.indexFor(4) ?? "").includes("- short：短摘要"));
});

test("SKILLS_INDEX_SUMMARY_CHARS：默认 120，0 关，非法回落默认，越界 clamp", () => {
	assert.equal(skillsIndexSummaryChars({} as unknown as NodeJS.ProcessEnv), 120);
	assert.equal(
		skillsIndexSummaryChars({ SKILLS_INDEX_SUMMARY_CHARS: "0" } as unknown as NodeJS.ProcessEnv),
		0,
	);
	assert.equal(
		skillsIndexSummaryChars({ SKILLS_INDEX_SUMMARY_CHARS: "abc" } as unknown as NodeJS.ProcessEnv),
		120,
	);
	assert.equal(
		skillsIndexSummaryChars({ SKILLS_INDEX_SUMMARY_CHARS: "-5" } as unknown as NodeJS.ProcessEnv),
		0,
	);
	assert.equal(
		skillsIndexSummaryChars({ SKILLS_INDEX_SUMMARY_CHARS: "99999" } as unknown as NodeJS.ProcessEnv),
		2000,
	);
});

test("SKILLS_INDEX_CLIP 总开关（界面「行为开关」）：关 = 不截断，压过字数配置", () => {
	const env = (pairs: Record<string, string> = {}): NodeJS.ProcessEnv =>
		pairs as unknown as NodeJS.ProcessEnv;
	// 缺省开
	assert.equal(skillsIndexClipEnabled(env()), true);
	assert.equal(skillsIndexClipEnabled(env({ SKILLS_INDEX_CLIP: "false" })), false);
	assert.equal(skillsIndexClipEnabled(env({ SKILLS_INDEX_CLIP: "0" })), false);
	assert.equal(skillsIndexClipEnabled(env({ SKILLS_INDEX_CLIP: "off" })), false);
	// 关掉后不管字数配多少都返回 0（不截断）
	assert.equal(
		skillsIndexSummaryChars(env({ SKILLS_INDEX_CLIP: "false", SKILLS_INDEX_SUMMARY_CHARS: "120" })),
		0,
	);
	assert.equal(skillsIndexSummaryChars(env({ SKILLS_INDEX_CLIP: "true" })), 120);
});

test("indexSummaryChars 收函数：每次渲染现读（界面改开关后新会话即时生效）", () => {
	const dir = freshDir("index-clip-hot");
	mkdirSync(join(dir, "long"));
	writeFileSync(
		join(dir, "long", "SKILL.md"),
		`---\ndescription: ${"长".repeat(300)}\n---\n正文`,
	);
	let limit = 120;
	const store = createSkillStore(dir, { indexSummaryChars: () => limit });
	assert.ok(store);
	const clippedLine = (store.indexFor(1) ?? "").split("\n").find((row) => row.startsWith("- long："))!;
	assert.equal(clippedLine.slice("- long：".length).length, 120, "首次渲染按 120 截断");
	// 改成 0 后，新会话（新 conversationId）按新值渲染 → 完整摘要
	limit = 0;
	const fullLine = (store.indexFor(2) ?? "").split("\n").find((row) => row.startsWith("- long："))!;
	assert.ok(fullLine.includes("长".repeat(300)), "开关关掉后新会话显示完整摘要");
	// 老会话仍按第一次冻结的结果（按会话冻结的既有口径）
	const oldLine = (store.indexFor(1) ?? "").split("\n").find((row) => row.startsWith("- long："))!;
	assert.equal(oldLine.slice("- long：".length).length, 120, "老会话保持冻结，不中途改索引");
});

test("frontmatter 多行块标量：折叠 / 字面 / `-` 变体 / 缩进 / CRLF，块后正文与后续 key 照常", () => {
	const dir = freshDir("loader-block-scalar");
	const add = (name: string, content: string) => {
		mkdirSync(join(dir, name));
		writeFileSync(join(dir, name, "SKILL.md"), content);
	};
	// 折叠式 `>`：换行折成空格，frontmatter 结束符紧贴块后（正文分隔照常）
	add("fold", "---\nname: fold\ndescription: >\n  第一行\n  第二行\n---\n折叠正文");
	// 折叠收尾变体 `>-`：不补尾换行（摘要本身会 trim，语义与 `>` 一致）
	add("fold-strip", "---\ndescription: >-\n  A\n  B\n---\n正文");
	// 字面式 `|`：保留换行
	add("literal", "---\ndescription: |\n  line1\n  line2\n---\n正文");
	// 字面收尾变体 `|-`：同样保留内部换行
	add("literal-strip", "---\ndescription: |-\n  L1\n  L2\n---\n正文");
	// 块缩进按第一条非空行定（这里 4 空格）；缩进回退后的 key 正常解析、其余字段忽略
	add("indent", "---\ndescription: >\n    深缩进摘要\nversion: 1.2.3\n---\n正文");
	// 折叠式里的空行 = 段落换行
	add("paragraph", "---\ndescription: >\n  段一\n\n  段二\n---\n正文");
	// CRLF 行尾：整份文件都是 \r\n
	add("crlf", "---\r\ndescription: >\r\n  win 摘要一\r\n  win 摘要二\r\n---\r\nwin 正文\r\n");
	// 空块（标记后没有内容行）= 没有摘要，走 valid=false 占名
	add("empty-block", "---\ndescription: >\n---\n正文");

	const scanned = new Map(scanSkillDir(dir).map((item) => [item.name, item]));
	assert.equal(scanned.get("fold")?.summary, "第一行 第二行");
	assert.equal(scanned.get("fold")?.manual, "折叠正文", "块后的 `---` 照样分隔出正文");
	assert.equal(scanned.get("fold-strip")?.summary, "A B");
	assert.equal(scanned.get("literal")?.summary, "line1\nline2");
	assert.equal(scanned.get("literal-strip")?.summary, "L1\nL2");
	assert.equal(scanned.get("indent")?.summary, "深缩进摘要", "缩进按第一条非空行归属");
	assert.equal(scanned.get("paragraph")?.summary, "段一\n段二");
	assert.equal(scanned.get("crlf")?.summary, "win 摘要一 win 摘要二", "CRLF 行尾不破坏块解析");
	assert.equal(scanned.get("crlf")?.manual, "win 正文");
	assert.equal(scanned.get("empty-block")?.valid, false, "空块 = 没有摘要，仍占名");
	assert.ok(scanned.get("empty-block"), "invalid 条目仍出现在扫描结果里");

	const store = createSkillStore(dir);
	assert.ok(store);
	const index = store.indexFor(1) ?? "";
	assert.match(index, /fold：第一行 第二行/);
	assert.match(index, /literal：line1\nline2/);
	assert.equal(store.names().includes("empty-block"), false, "空块技能不进索引");
});

test("内置方法论技能：scanSkillDir 能读到 4 个新技能，摘要取自第 1 行", () => {
	// 2026-11-09 T4 §1：方法论技能包是纯内容，靠既有扁平 md 加载器直接生效。
	const scanned = new Map(scanSkillDir(APP_SKILLS_DIR).map((item) => [item.name, item]));
	for (const [name, summary] of [
		["writing_plan", "写计划：把要求拆成能一条条核对的动作"],
		["executing_plan", "执行计划：一次只做一步，做完先自检再进下一步"],
		["verifying_done", "验证完成：这一轮没真的跑过，就不能说完成了"],
		["debugging", "系统化调试：先复现再定位，没有调查不许改"],
	] as const) {
		const skill = scanned.get(name);
		assert.ok(skill, `应扫到内置技能 ${name}`);
		assert.equal(skill.valid, true, `${name} 应是有效技能（有摘要与正文）`);
		assert.equal(skill.summary, summary, `${name} 摘要应取第 1 行`);
		assert.ok(skill.manual.length > 100, `${name} 正文应有可执行内容`);
	}
});

test("加载器：多目录先到先得；坏文件占名，不被低优先级同名顶掉", () => {
	const high = freshDir("loader-high");
	const low = freshDir("loader-low");
	writeFileSync(join(high, "shared.md"), "高管摘要\n高管正文");
	writeFileSync(join(low, "shared.md"), "全局摘要\n全局正文");
	writeFileSync(join(low, "only-low.md"), "低优先摘要\n低优先正文");
	// 高优先级目录里同名但格式不对：应占名并让这个名字整个失效
	mkdirSync(join(high, "broken"));
	writeFileSync(join(high, "broken", "SKILL.md"), "没有 description");
	writeFileSync(join(low, "broken.md"), "低优先坏同名\n正文");

	const store = createSkillStore([high, low]);
	assert.ok(store);
	assert.equal(store.manual("shared"), "高管正文");
	assert.equal(store.manual("only-low"), "低优先正文");
	assert.equal(store.manual("broken"), undefined, "坏文件占名：低优先级的同名不该顶上来");
});

function resolved(
	main: string,
	extra: { dir: string; origin: "agents" | "app"; writable: boolean }[] = [],
): ResolvedSkillsDir {
	return {
		dir: main,
		origin: "user",
		dirs: [
			{ dir: main, origin: "user", writable: true, exists: existsSync(main) },
			...extra.map((source) => ({ ...source, exists: existsSync(source.dir) })),
		],
	};
}

function apiApp(target: ResolvedSkillsDir | string) {
	const app = new Hono();
	mountSkills(app, {
		resolve: () => (typeof target === "string" ? resolved(target) : target),
		enabled: true,
	});
	return app;
}

async function json(response: Response) {
	return (await response.json()) as Record<string, unknown>;
}

const put = (app: Hono, name: string, content: unknown) =>
	app.request(`/api/v1/agent/skills/${name}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content }),
	});

test("技能端点：列表 → 新建 → 读 → 覆盖 → 删除 全链路", async () => {
	const dir = freshDir("api-crud");
	const app = apiApp(dir);

	const empty = await app.request("/api/v1/agent/skills");
	assert.equal(empty.status, 200);
	const emptyBody = await json(empty);
	assert.equal(emptyBody.ok, true);
	assert.equal(emptyBody.dir, dir);
	assert.equal(emptyBody.origin, "user");
	assert.deepEqual(emptyBody.items, []);

	const created = await put(app, "daily-brief", "每天早上的简报流程\n按项目分组列出变化。");
	assert.equal(created.status, 200);
	const createdBody = await json(created);
	assert.equal(createdBody.created, true);
	const file = join(dir, "daily-brief.md");
	assert.equal(readFileSync(file, "utf8"), "每天早上的简报流程\n按项目分组列出变化。");

	const list = await json(await app.request("/api/v1/agent/skills"));
	const items = list.items as { name: string; summary: string; size: number; updatedAt: string }[];
	assert.equal(items.length, 1);
	assert.equal(items[0]?.name, "daily-brief");
	assert.equal(items[0]?.summary, "每天早上的简报流程");
	assert.ok((items[0]?.size ?? 0) > 0);
	assert.ok(Number.isFinite(Date.parse(String(items[0]?.updatedAt))));

	const one = await json(await app.request("/api/v1/agent/skills/daily-brief"));
	assert.equal(one.content, "每天早上的简报流程\n按项目分组列出变化。");

	const updated = await json(await put(app, "daily-brief", "新的摘要\n新的正文"));
	assert.equal(updated.created, false);
	assert.equal(readFileSync(file, "utf8"), "新的摘要\n新的正文");

	const removed = await app.request("/api/v1/agent/skills/daily-brief", { method: "DELETE" });
	assert.equal(removed.status, 200);
	assert.equal((await app.request("/api/v1/agent/skills/daily-brief")).status, 404);
	assert.equal((await app.request("/api/v1/agent/skills/daily-brief", { method: "DELETE" })).status, 404);
});

test("技能端点：名字白名单与正文结构/大小校验", async () => {
	const app = apiApp(freshDir("api-bounds"));

	for (const name of ["Upper", "-lead", "_lead", "with%20space", "..%2Fescape"]) {
		const response = await put(app, name, "摘要\n正文");
		assert.equal(response.status, 400, `${name} 应被名字白名单拒绝`);
	}

	assert.equal((await put(app, "one-line", "只有一行摘要")).status, 400, "没有正文的技能不该落盘");
	assert.equal((await put(app, "empty", "   \n  ")).status, 400);
	assert.equal((await put(app, "huge", `${"a".repeat(SKILL_SLOT_LIMIT)}\n正文`)).status, 400);
	assert.equal((await app.request("/api/v1/agent/skills/ok", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content: 123 }),
	})).status, 400);
});

test("技能端点：列表合并只读来源并标 origin；.agents 技能可读、不可写/删", async () => {
	const main = freshDir("api-ro-main");
	const agents = freshDir("api-ro-agents");
	// .agents 里的标准形态：<名>/SKILL.md
	mkdirSync(join(agents, "from-agents"));
	writeFileSync(
		join(agents, "from-agents", "SKILL.md"),
		"---\nname: from-agents\ndescription: 只读来源的摘要\n---\n只读来源的正文",
	);
	// 扁平形态也认
	writeFileSync(join(agents, "agent-flat.md"), "扁平只读摘要\n扁平只读正文");
	// 主目录有一份同名：主目录先到先得，列表只出一条
	writeFileSync(join(main, "agent-flat.md"), "主目录摘要\n主目录正文");

	const app = apiApp(resolved(main, [{ dir: agents, origin: "agents", writable: false }]));
	const listed = await json(await app.request("/api/v1/agent/skills"));
	const items = listed.items as {
		name: string;
		summary: string;
		origin: string;
		writable: boolean;
		form: string;
	}[];
	const byName = new Map(items.map((item) => [item.name, item]));
	assert.equal(byName.get("from-agents")?.origin, "agents");
	assert.equal(byName.get("from-agents")?.writable, false);
	assert.equal(byName.get("from-agents")?.form, "dir");
	assert.equal(byName.get("agent-flat")?.origin, "user", "同名时主目录先到先得");
	assert.equal(items.length, 2, "同名只出一条");

	const dirs = listed.dirs as { dir: string; origin: string; writable: boolean }[];
	assert.equal(dirs.length, 2);
	assert.deepEqual(
		dirs.map((source) => source.origin),
		["user", "agents"],
	);

	const read = await json(await app.request("/api/v1/agent/skills/from-agents"));
	assert.equal(read.origin, "agents");
	assert.equal(read.writable, false);
	assert.match(String(read.content), /description: 只读来源的摘要/);

	const writeReadOnly = await put(app, "from-agents", "改摘要\n改正文");
	assert.equal(writeReadOnly.status, 400, "只读来源不给写");
	assert.match(String((await json(writeReadOnly)).message), /只读用户技能目录/);
	assert.equal(existsSync(join(main, "from-agents.md")), false, "不落影子副本");

	const deleteReadOnly = await app.request("/api/v1/agent/skills/from-agents", { method: "DELETE" });
	assert.equal(deleteReadOnly.status, 400, "只读来源不给删");
	assert.equal(existsSync(join(agents, "from-agents", "SKILL.md")), true);
});

test("技能端点：应用目录内置手册仍可在主目录写同名覆盖（9-S 合并语义保留）", async () => {
	const main = freshDir("api-app-main");
	const appDir = freshDir("api-app-builtin");
	writeFileSync(join(appDir, "meeting_guide.md"), "内置摘要\n内置正文");
	const app = apiApp(resolved(main, [{ dir: appDir, origin: "app", writable: false }]));

	const before = await json(await app.request("/api/v1/agent/skills"));
	assert.equal((before.items as { name: string }[])[0]?.name, "meeting_guide");

	const created = await put(app, "meeting_guide", "我的摘要\n我的正文");
	assert.equal(created.status, 200, "内置手册允许被主目录同名覆盖");
	const after = await json(await app.request("/api/v1/agent/skills"));
	const items = after.items as { name: string; origin: string; summary: string }[];
	assert.equal(items.length, 1, "覆盖后仍只出一条");
	assert.equal(items[0]?.origin, "user");
	assert.equal(items[0]?.summary, "我的摘要");
});

test("技能端点：目录内符号链接指向外部时读写一律 400", async (t) => {
	const dir = freshDir("api-symlink");
	const outside = join(root, "outside-secret.md");
	writeFileSync(outside, "外面的文件\n不该被读到");
	try {
		symlinkSync(outside, join(dir, "evil.md"));
	} catch {
		t.skip("当前系统不允许创建符号链接（Windows 需开发者模式）");
		return;
	}
	const app = apiApp(dir);
	assert.equal((await app.request("/api/v1/agent/skills/evil")).status, 400);
	const list = await json(await app.request("/api/v1/agent/skills"));
	assert.deepEqual(list.items, [], "越界的符号链接不该出现在管理列表里");
});

test("技能端点：列表带 usageCount / lastUsedAt；>90 天未用标 stale（只标记，不删不移）", async () => {
	const dir = freshDir("api-usage");
	const app = apiApp(dir);
	await put(app, "used-skill", "常用技能\n正文");
	await put(app, "stale-skill", "很久没用的技能\n正文");

	const usagePath = join(root, "skill-usage.json");
	writeFileSync(
		usagePath,
		JSON.stringify({
			usage: {
				"used-skill": { count: 3, lastUsedAt: new Date().toISOString() },
				"stale-skill": {
					count: 1,
					lastUsedAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
				},
			},
		}),
		"utf8",
	);
	const previousUsage = process.env.AGENT_SKILL_USAGE_PATH;
	process.env.AGENT_SKILL_USAGE_PATH = usagePath;
	try {
		const body = await json(await app.request("/api/v1/agent/skills"));
		const items = body.items as Array<{
			name: string;
			usageCount?: number;
			lastUsedAt?: string | null;
			stale: boolean;
		}>;
		const used = items.find((item) => item.name === "used-skill")!;
		const stale = items.find((item) => item.name === "stale-skill")!;
		assert.equal(used.usageCount, 3);
		assert.equal(used.stale, false, "最近用过不标 stale");
		assert.equal(stale.usageCount, 1);
		assert.equal(stale.stale, true, "超过 90 天未用应标 stale");
		assert.ok(existsSync(join(dir, "stale-skill.md")), "只标记，不删文件");

		// 回滚开关：SKILL_USAGE=false → 不吐用量字段，也不标 stale
		process.env.SKILL_USAGE = "false";
		const offBody = await json(await app.request("/api/v1/agent/skills"));
		const offItems = offBody.items as Array<Record<string, unknown>>;
		assert.equal("usageCount" in offItems[0]!, false, "关着时不吐用量字段");
		assert.equal(offItems[0]!.stale, false);
	} finally {
		if (previousUsage === undefined) delete process.env.AGENT_SKILL_USAGE_PATH;
		else process.env.AGENT_SKILL_USAGE_PATH = previousUsage;
		delete process.env.SKILL_USAGE;
	}
});

/* ── 内置技能 core（2026-11-16 工具裁剪 A）────────────────── */

test("core 名单只认代码常量：delegate 是 core，普通技能不是", async () => {
	const { CORE_SKILL_NAMES, isCoreSkill } = await import("./core-skills.ts");
	assert.deepEqual([...CORE_SKILL_NAMES], ["delegate"]);
	assert.equal(isCoreSkill("delegate"), true);
	assert.equal(isCoreSkill("normal"), false);
	assert.equal(isCoreSkill("Delegate"), false, "大小写敏感，不认 frontmatter 自封");
});

test("createSkillStore + isCore：启停位全关时 core 仍进索引 / names() / 可取手册；普通技能仍不出现", () => {
	const dir = freshDir("core-store");
	writeFileSync(join(dir, "delegate.md"), "派活手册摘要\n派活手册正文");
	writeFileSync(join(dir, "normal.md"), "普通摘要\n普通正文");
	const store = createSkillStore(dir, {
		visible: () => false,
		visibleFor: () => false,
		isCore: (name) => name === "delegate",
	});
	assert.ok(store);
	// 全局关
	assert.ok(store.names().includes("delegate"), "core 进 names()");
	assert.equal(store.names().includes("normal"), false, "普通技能全关不出现");
	assert.equal(store.manual("delegate"), "派活手册正文", "core 可按名取手册");
	assert.equal(store.manual("normal"), undefined);
	assert.match(store.indexFor(1) ?? "", /delegate：派活手册摘要/, "core 进索引");
	assert.doesNotMatch(store.indexFor(1) ?? "", /normal/);
	// 带 partnerId（按人可见也关）走同一条短路
	assert.ok(store.names("p1").includes("delegate"));
	assert.equal(store.manual("delegate", "p1"), "派活手册正文");

	// 不带 isCore = 旧行为：全关时什么都看不到
	const legacy = createSkillStore(dir, { visible: () => false, visibleFor: () => false });
	assert.ok(legacy);
	assert.deepEqual(legacy.names(), []);
	assert.equal(legacy.manual("delegate"), undefined);
	assert.equal(legacy.indexFor(2), undefined);
});

test("技能端点：core 始终可用（GET core/enabled/partnerEnabled），启停端点 400，enabled-all 跳过 core", async () => {
	const dir = freshDir("api-core");
	writeFileSync(join(dir, "delegate.md"), "派活摘要\n派活正文");
	writeFileSync(join(dir, "normal.md"), "普通摘要\n普通正文");
	const app = apiApp(dir);

	const list = await json(await app.request("/api/v1/agent/skills?partnerId=p1"));
	const items = list.items as Array<Record<string, unknown>>;
	const delegate = items.find((item) => item.name === "delegate")!;
	assert.equal(delegate.core, true, "GET item 增 core: true");
	assert.equal(delegate.enabled, true, "即使启停位全关也报 enabled=true");
	assert.equal(delegate.partnerEnabled, true, "带 partnerId 时 core 也报可用");
	assert.equal(delegate.partnerOverride, false);
	const normal = items.find((item) => item.name === "normal")!;
	assert.equal(normal.core, false);
	assert.equal(normal.enabled, false, "普通技能默认全关");

	const off = await app.request("/api/v1/agent/skills/delegate/enabled", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	assert.equal(off.status, 400, "core 不能关闭");
	const offBody = await json(off);
	assert.equal(offBody.error, "bad_request");
	assert.match(String(offBody.message), /系统内置技能，始终可用，不能关闭/);

	const allOff = await json(await app.request("/api/v1/agent/skills/enabled-all", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	}));
	assert.equal(allOff.ok, true);
	assert.equal(allOff.count, 1, "count 只算普通技能，不含 core");
	const state = JSON.parse(readFileSync(process.env.AGENT_SKILLS_STATE_PATH!, "utf8"));
	assert.equal(state.enabled?.delegate, undefined, "core 不参与写入");

	// 带 partnerId 的 GET 形状：core 也始终可用
	const p2 = await json(await app.request("/api/v1/agent/skills?partnerId=p2"));
	const delegate2 = (p2.items as Array<Record<string, unknown>>).find((item) => item.name === "delegate")!;
	assert.equal(delegate2.partnerEnabled, true);
});
