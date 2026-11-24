/**
 * 技能管理探针（2026-11-08 扫尾批 9-S；批 10-A 加 .agents 只读来源）。
 *
 * 真起服务、真 HTTP、真文件，五段：
 *   A. 用户目录：首访自动建 `%USERPROFILE%/.lifediary/skills` → 列表（含内置手册）→ 新建 → 读 → 覆盖 → 删除；
 *      名字白名单 / 两行结构 / 64KB 上限三组 400；无令牌 403 空体。
 *   B. AGENT_SKILLS_DIR 显式优先：origin=env，目录由写入时创建。
 *   C. 用户目录建不出来（用文件冒充 USERPROFILE）→ origin=app，内置手册全部可见，且只读不写。
 *   D. 标准用户技能目录 `%USERPROFILE%/.agents/skills`：两种形态进列表并标 origin=agents / writable=false；
 *      可读、不可写、不可删。
 *   E. SKILLS_ADMIN=false → 路由不挂（404，= 未启用）。
 *   F. 技能分类建议（2026-11-10 批 30）：无快照空形状 / faux POST 503 / 差集标注 /
 *      PUT 采纳生效 + 伪造 400 / SKILL_ADVICE=false 回滚。
 *
 * 卫生：所有落点都在系统临时目录 + `.data/probe-skills-*`，跑完即删；不碰真实用户目录与内置手册。
 *
 *   pnpm --filter @lifediary/server skills
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8118);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "probe-skills-token";

const DB = ".data/probe-skills.sqlite";
const CHAT_META = ".data/probe-skills-chat-meta.json";
const POLICY = ".data/probe-skills-policy.json";
const PAIRING = ".data/probe-skills-pairing.json";
const PROVIDERS = ".data/probe-skills-providers.json";
const RUNTIME = ".data/probe-skills-runtime.json";

/**
 * 内置手册全集：跟 `apps/server/skills/` 目录走，不硬编码条数。
 * 批 11 把内置手册从 2 条扩到 6 条后没人重跑本探针，断言停在 `length === 2` 被绊住
 * （2026-11-10 接入 ego-browser 技能时撞见，改为按目录自同步）。
 */
const BUILTIN_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const BUILTIN_NAMES = existsSync(BUILTIN_DIR)
	? readdirSync(BUILTIN_DIR)
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -3))
			.sort()
	: [];

const ROOT = mkdtempSync(join(tmpdir(), "lifediary-skills-probe-"));
const HOME = join(ROOT, "home");
const HOME_AGENTS = join(ROOT, "home-agents");
const ENV_DIR = join(ROOT, "env-skills");
const BLOCKER = join(ROOT, "home-blocked");

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		PORT: String(PORT),
		AGENT_TOKEN: TOKEN,
		LLM_PROVIDER: "faux",
		LLM_API_KEY: "",
		PROVIDERS_CONFIG: "false",
		AGENT_DB_PATH: DB,
		MEMORY_ENABLED: "false",
		AGENT_CHAT_META_PATH: CHAT_META,
		AGENT_POLICY_PATH: POLICY,
		PAIRING_STORE_PATH: PAIRING,
		PROVIDERS_PATH: PROVIDERS,
		MODEL_RUNTIME_PATH: RUNTIME,
		// 启停位 / 建议快照也锁进临时目录：F 段采纳会写启停位，漏了就会污染生产
		// .data/skills-state.json（2026-11-10 批 30 实测踩中：advice-keep 漏进了生产 state）
		AGENT_SKILLS_STATE_PATH: join(ROOT, "skills-state.json"),
		AGENT_SKILLS_ADVICE_PATH: join(ROOT, "skills-advice.json"),
		CHANCELLOR_ENABLED: "false",
		AUTONOMY_ENABLED: "false",
		AGENT_TOOL_POLICY: "full",
		AGENT_SKILLS_DIR: "",
		// 自加位置登记表（2026-11-23）：指到临时目录，探针不会读 / 写开发机真实的 .data
		AGENT_SKILLS_DIRS_PATH: join(ROOT, "skills-dirs.json"),
		SKILLS_ADMIN: "",
		NODE_OPTIONS: "",
		...extra,
	};
}

let server: ChildProcess | undefined;

async function startServer(extra: NodeJS.ProcessEnv = {}): Promise<void> {
	server = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: baseEnv(extra),
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [server] ${text}`);
	});
	await waitForReady();
}

async function stopServer(): Promise<void> {
	server?.kill();
	server = undefined;
	await sleep(700);
}

async function waitForReady(): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`${BASE}/healthz`);
			if (response.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("服务没能启动");
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

async function apiJson(
	path: string,
	init: RequestInit = {},
	withToken = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${BASE}${path}`, {
		...init,
		headers: withToken
			? authHeaders({
					...(init.body ? { "content-type": "application/json" } : {}),
					...(init.headers as Record<string, string> | undefined),
				})
			: (init.headers as Record<string, string> | undefined),
	});
	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		/* 空体（403 的语义就是空体）留空对象 */
	}
	return { status: response.status, body };
}

const put = (name: string, content: unknown) =>
	apiJson(`/api/v1/agent/skills/${name}`, {
		method: "PUT",
		body: JSON.stringify({ content }),
	});

try {
	// ── A. 用户目录：首访自动建 + CRUD ─────────────────────────
	console.log("\nA. 用户目录（%USERPROFILE%/.lifediary/skills）");
	await startServer({ USERPROFILE: HOME, HOME });

	const noToken = await apiJson("/api/v1/agent/skills", {}, false);
	check(noToken.status === 403, "无令牌 → 403", `HTTP ${noToken.status}`);

	const userDir = join(HOME, ".lifediary", "skills");
	const initial = await apiJson("/api/v1/agent/skills");
	check(initial.status === 200, "GET 列表 200", `HTTP ${initial.status}`);
	check(initial.body.origin === "user", "origin=user", String(initial.body.origin));
	check(initial.body.dir === userDir, "dir 指向用户目录", String(initial.body.dir));
	check(existsSync(userDir), "用户目录首访已自动创建");
	const initialItems = (initial.body.items ?? []) as {
		name: string;
		origin: string;
		writable: boolean;
	}[];
	const initialNames = initialItems.map((item) => item.name).sort();
	check(
		initialItems.length === BUILTIN_NAMES.length &&
			BUILTIN_NAMES.every((name) => initialNames.includes(name)) &&
			initialNames.every((name) => BUILTIN_NAMES.includes(name)),
		"初始列表 = 内置手册全集（用户目录为空）",
		`${initialNames.join("、")}（内置 ${BUILTIN_NAMES.length} 条）`,
	);
	check(
		initialItems.every((item) => item.origin === "app" && item.writable === false),
		"内置手册标 origin=app、只读",
		JSON.stringify(initialItems.map((item) => [item.origin, item.writable])),
	);
	const initialDirs = (initial.body.dirs ?? []) as { dir: string; origin: string }[];
	check(
		initialDirs.map((source) => source.origin).join(",") === "user,agents,app",
		"读取链 = user → agents → app",
		initialDirs.map((source) => source.origin).join(","),
	);

	const content = "每天的简报流程\n按项目分组列出变化，超过三条才细说。";
	const created = await put("daily-brief", content);
	check(created.status === 200 && created.body.created === true, "PUT 新建 → created=true", JSON.stringify(created.body));
	check(readFileSync(join(userDir, "daily-brief.md"), "utf8") === content, "文件内容与请求一致");

	const listed = await apiJson("/api/v1/agent/skills");
	const items = (listed.body.items ?? []) as {
		name: string;
		summary: string;
		size: number;
		origin: string;
		writable: boolean;
	}[];
	const brief = items.find((item) => item.name === "daily-brief");
	check(Boolean(brief), "列表出现新技能", items.map((item) => item.name).join("、"));
	check(brief?.summary === "每天的简报流程", "首行 = 索引摘要", String(brief?.summary));
	check(Number(brief?.size) > 0, "size > 0", String(brief?.size));
	check(brief?.origin === "user" && brief?.writable === true, "用户目录技能可写", JSON.stringify(brief));

	const read = await apiJson("/api/v1/agent/skills/daily-brief");
	check(read.status === 200 && read.body.content === content, "GET 单条正文一致");

	const overwritten = await put("daily-brief", "新的摘要\n新的正文");
	check(overwritten.body.created === false, "同名字再 PUT → created=false");
	check(readFileSync(join(userDir, "daily-brief.md"), "utf8") === "新的摘要\n新的正文", "覆盖已落盘");

	check((await put("Upper", "摘要\n正文")).status === 400, "大写名 → 400");
	check((await put("..%2Fescape", "摘要\n正文")).status === 400, "穿越名 → 400");
	check((await put("one-line", "只有一行")).status === 400, "只有一行 → 400（不会进索引）");
	check((await put("huge", `${"a".repeat(64 * 1024)}\n正文`)).status === 400, "超 64KB → 400");

	const removed = await apiJson("/api/v1/agent/skills/daily-brief", { method: "DELETE" });
	check(removed.status === 200, "DELETE 200", `HTTP ${removed.status}`);
	check(!existsSync(join(userDir, "daily-brief.md")), "文件已从磁盘删除");
	check((await apiJson("/api/v1/agent/skills/daily-brief")).status === 404, "删除后 GET → 404");
	check((await apiJson("/api/v1/agent/skills/daily-brief", { method: "DELETE" })).status === 404, "重复删除 → 404");

	await stopServer();

	// ── B. AGENT_SKILLS_DIR 显式优先 ───────────────────────────
	console.log("\nB. AGENT_SKILLS_DIR 显式优先");
	await startServer({ AGENT_SKILLS_DIR: ENV_DIR, USERPROFILE: HOME, HOME });
	const envList = await apiJson("/api/v1/agent/skills");
	check(envList.body.origin === "env", "origin=env", String(envList.body.origin));
	check(envList.body.dir === ENV_DIR, "dir 指向 AGENT_SKILLS_DIR", String(envList.body.dir));
	const envPut = await put("env-only", "环境目录技能\n正文");
	check(envPut.status === 200, "写入显式目录 200", `HTTP ${envPut.status}`);
	check(existsSync(join(ENV_DIR, "env-only.md")), "写入时自动创建了显式目录");
	await stopServer();

	// ── C. 应用目录兜底 ────────────────────────────────────────
	console.log("\nC. 用户目录不可用 → 应用目录兜底");
	writeFileSync(BLOCKER, "not a directory");
	await startServer({ USERPROFILE: BLOCKER, HOME: BLOCKER });
	const appList = await apiJson("/api/v1/agent/skills");
	const appItems = (appList.body.items ?? []) as { name: string }[];
	check(appList.body.origin === "app", "origin=app", String(appList.body.origin));
	const names = appItems.map((item) => item.name).sort();
	check(
		BUILTIN_NAMES.every((name) => names.includes(name)),
		"内置手册全部可见",
		names.join("、"),
	);
	const appRead = await apiJson("/api/v1/agent/skills/meeting_guide");
	check(appRead.status === 200 && String(appRead.body.content).length > 0, "内置手册可读");
	await stopServer();

	// ── D. 标准用户技能目录（.agents/skills，只读）──────────────
	console.log("\nD. %USERPROFILE%/.agents/skills（跨工具用户技能，只读）");
	const agentsSkills = join(HOME_AGENTS, ".agents", "skills");
	mkdirSync(join(agentsSkills, "agents-dir"), { recursive: true });
	writeFileSync(
		join(agentsSkills, "agents-dir", "SKILL.md"),
		"---\nname: agents-dir\ndescription: 标准目录形态的摘要\n---\n标准目录形态的正文",
	);
	writeFileSync(join(agentsSkills, "agents-flat.md"), "扁平形态的摘要\n扁平形态的正文");
	await startServer({ USERPROFILE: HOME_AGENTS, HOME: HOME_AGENTS });

	const agentsList = await apiJson("/api/v1/agent/skills");
	const agentsItems = (agentsList.body.items ?? []) as {
		name: string;
		summary: string;
		origin: string;
		writable: boolean;
	}[];
	const agentDir = agentsItems.find((item) => item.name === "agents-dir");
	const agentFlat = agentsItems.find((item) => item.name === "agents-flat");
	check(Boolean(agentDir && agentFlat), "两种形态都进了列表", agentsItems.map((item) => item.name).join("、"));
	check(
		agentDir?.summary === "标准目录形态的摘要",
		"目录形态：frontmatter description 作摘要",
		String(agentDir?.summary),
	);
	check(
		agentDir?.origin === "agents" && agentDir?.writable === false && agentFlat?.writable === false,
		".agents 技能标 origin=agents、只读",
		JSON.stringify([agentDir?.origin, agentDir?.writable, agentFlat?.writable]),
	);
	const agentsRead = await apiJson("/api/v1/agent/skills/agents-dir");
	check(
		agentsRead.status === 200 && String(agentsRead.body.content).includes("标准目录形态的正文"),
		".agents 技能可读（正文全文）",
		`HTTP ${agentsRead.status}`,
	);
	check((await put("agents-flat", "改摘要\n改正文")).status === 400, "只读来源 PUT → 400");
	check(
		(await apiJson("/api/v1/agent/skills/agents-flat", { method: "DELETE" })).status === 400,
		"只读来源 DELETE → 400",
	);
	check(!existsSync(join(HOME_AGENTS, ".lifediary", "skills", "agents-flat.md")), "没有落影子副本");
	await stopServer();

	// ── E. 回滚开关 ────────────────────────────────────────────
	console.log("\nE. SKILLS_ADMIN=false");
	await startServer({ SKILLS_ADMIN: "false", USERPROFILE: HOME, HOME });
	check((await apiJson("/api/v1/agent/skills")).status === 404, "列表 404（= 未启用）");
	check((await put("whatever", "摘要\n正文")).status === 404, "写入 404");
	await stopServer();

	// ── F. 技能分类建议（2026-11-10 批 30 修订：评估在总管对话里做）──
	// GET 带预填提示词；POST = 导入总管评估完的 JSON（工具同款清洗）；PUT = 采纳启停位。
	console.log("\nF. 技能分类建议（advice 三端点）");
	await startServer({ USERPROFILE: HOME, HOME });
	// F1. 无快照：GET 空形状 + 预填提示词（有技能就有 prompt）、PUT 全被闸（名字不在快照）
	const adviceEmpty = await apiJson("/api/v1/agent/skills/advice");
	check(
		adviceEmpty.status === 200 &&
			adviceEmpty.body.ok === true &&
			Object.keys(adviceEmpty.body.items ?? {}).length === 0 &&
			Array.isArray(adviceEmpty.body.unevaluated) &&
			typeof adviceEmpty.body.prompt === "string" &&
			(adviceEmpty.body.prompt as string).includes("save_skill_advice"),
		"GET 无快照 → 空形状 + 预填提示词（教总管调工具）",
		`HTTP ${adviceEmpty.status} prompt=${typeof adviceEmpty.body.prompt}`,
	);
	// F2. POST 导入：合法条目落盘、非法条目丢弃（评估 JSON 来自总管对话，同工具清洗口径）
	await put("advice-keep", "建议开启的技能\n正文");
	const adviceImport = await apiJson("/api/v1/agent/skills/advice", {
		method: "POST",
		body: JSON.stringify({
			items: {
				"advice-keep": ["keep", "daily", "基础设施"],
				"advice-bad": ["nope", "daily", "坏栏位"],
			},
			model: "chief-conversation",
		}),
	});
	const importItems = (adviceImport.body.items ?? {}) as Record<string, { bucket?: string }>;
	check(
		adviceImport.status === 200 &&
			importItems["advice-keep"]?.bucket === "keep" &&
			importItems["advice-bad"] === undefined,
		"POST 导入 → 合法条目落盘、非法条目丢弃",
		`HTTP ${adviceImport.status} items=${JSON.stringify(importItems)}`,
	);
	// F2b. POST 全非法 → 400（一条合法都没有 = 整份不可信）
	const adviceBad = await apiJson("/api/v1/agent/skills/advice", {
		method: "POST",
		body: JSON.stringify({ items: { x: ["bad", "bad", "bad"] } }),
	});
	check(adviceBad.status === 400, "POST 全非法 → 400", `HTTP ${adviceBad.status}`);
	// F3. 手写一份快照（含一条指向已消失技能的脏数据），GET 应差集标注
	const snapshotPath = join(ROOT, "skills-advice.json");
	writeFileSync(
		snapshotPath,
		JSON.stringify({
			generatedAt: "2026-11-10T00:00:00.000Z",
			model: "probe/model",
			items: {
				"advice-keep": { bucket: "keep", frequency: "daily", reason: "基础设施" },
				"advice-gone": { bucket: "skip", frequency: "rare", reason: "已删除的技能" },
			},
		}),
		"utf8",
	);
	const adviceDirty = await apiJson("/api/v1/agent/skills/advice");
	const dirtyItems = (adviceDirty.body.items ?? {}) as Record<string, { bucket?: string }>;
	const dirtyUnevaluated = (adviceDirty.body.unevaluated ?? []) as string[];
	check(
		adviceDirty.status === 200 &&
			dirtyItems["advice-keep"]?.bucket === "keep" &&
			dirtyItems["advice-gone"] === undefined &&
			adviceDirty.body.stale === true &&
			dirtyUnevaluated.includes("agents-flat") === false,
		"GET 差集：消失技能剔除、真实技能保留、stale 标注",
		JSON.stringify(adviceDirty.body.items),
	);
	// F4. PUT 采纳：快照内名字生效、伪造名字 400
	const adoptOk = await apiJson("/api/v1/agent/skills/advice", {
		method: "PUT",
		body: JSON.stringify({ actions: [{ name: "advice-keep", enabled: true }] }),
	});
	check(
		adoptOk.status === 200 && adoptOk.body.applied === 1,
		"PUT 采纳（快照内名字）→ 生效",
		`HTTP ${adoptOk.status} applied=${adoptOk.body.applied}`,
	);
	const forge = await apiJson("/api/v1/agent/skills/advice", {
		method: "PUT",
		body: JSON.stringify({ actions: [{ name: "not-in-snapshot", enabled: true }] }),
	});
	check(forge.status === 400, "PUT 伪造建议（不在快照）→ 400", `HTTP ${forge.status}`);
	// F5. 采纳真的写了启停位（读启停端点核账）
	const enabledList = await apiJson("/api/v1/agent/skills");
	const enabledItems = (enabledList.body.items ?? []) as { name: string; enabled: boolean }[];
	const enabledEntry = enabledItems.find((item) => item.name === "advice-keep");
	check(enabledEntry?.enabled === true, "采纳后启停位真的开了", `enabled=${enabledEntry?.enabled}`);
	// F6. 回滚开关：SKILL_ADVICE=false → advice 路由不挂（其余技能路由照常）
	await stopServer();
	await startServer({
		SKILL_ADVICE: "false",
		USERPROFILE: HOME,
		HOME,
	});
	check((await apiJson("/api/v1/agent/skills/advice")).status === 404, "SKILL_ADVICE=false → advice 404");
	check((await apiJson("/api/v1/agent/skills")).status === 200, "技能列表不受影响");
	await stopServer();

	// ── G. 多位置（2026-11-23）──────────────────────────────────
	console.log("\nG. 技能库多位置（自加目录 + 按位置读写）");
	const extraDir = join(ROOT, "extra-skills");
	mkdirSync(extraDir, { recursive: true });
	// .agents 来源也备一份：G 段验证「移除内置来源」
	const homeAgents = join(HOME, ".agents", "skills");
	mkdirSync(homeAgents, { recursive: true });
	writeFileSync(join(homeAgents, "probe-agents.md"), "探针 agents 摘要\n探针 agents 正文");
	await startServer({ USERPROFILE: HOME, HOME });

	const addBad = await apiJson("/api/v1/agent/skill-dirs", {
		method: "POST",
		body: JSON.stringify({ path: "relative-skills" }),
	});
	check(addBad.status === 400, "相对路径 → 400", `HTTP ${addBad.status}`);
	const addMissing = await apiJson("/api/v1/agent/skill-dirs", {
		method: "POST",
		body: JSON.stringify({ path: join(ROOT, "no-such-skills") }),
	});
	check(addMissing.status === 400, "目录不存在 → 400", `HTTP ${addMissing.status}`);

	const addOk = await apiJson("/api/v1/agent/skill-dirs", {
		method: "POST",
		body: JSON.stringify({ path: extraDir, label: "探针自加" }),
	});
	check(addOk.status === 200 && addOk.body.label === "探针自加", "登记自加位置 200", JSON.stringify(addOk.body));

	const dirsList = await apiJson("/api/v1/agent/skills");
	const dirRows = (dirsList.body.dirs ?? []) as { dir: string; origin: string; label?: string; removable: boolean }[];
	const customRow = dirRows.find((row) => row.dir === extraDir);
	check(dirsList.body.extraDirs === true, "extraDirs=true");
	check(
		customRow?.origin === "custom" && customRow?.label === "探针自加" && customRow?.removable === true,
		"列表带出 origin=custom / label / removable",
		JSON.stringify(customRow),
	);
	check(
		dirRows.map((row) => row.origin).join(",") === "user,custom,agents,app",
		"读取链 = user → custom → agents → app",
		dirRows.map((row) => row.origin).join(","),
	);

	const extraContent = "自加位置的技能\n正文也在这里。";
	const extraPut = await apiJson("/api/v1/agent/skills/extra-note", {
		method: "PUT",
		body: JSON.stringify({ content: extraContent, dir: extraDir }),
	});
	check(extraPut.status === 200 && extraPut.body.dir === extraDir, "PUT 带 dir → 落在自加位置", JSON.stringify(extraPut.body));
	check(readFileSync(join(extraDir, "extra-note.md"), "utf8") === extraContent, "自加位置文件已落盘");
	check(!existsSync(join(HOME, ".lifediary", "skills", "extra-note.md")), "没有同时落主目录");

	const extraRead = await apiJson(`/api/v1/agent/skills/extra-note?dir=${encodeURIComponent(extraDir)}`);
	check(extraRead.status === 200 && extraRead.body.content === extraContent, "GET 带 dir 读到那一份");

	const roPut = await apiJson("/api/v1/agent/skills/extra-note", {
		method: "PUT",
		body: JSON.stringify({ content: "改\n正文", dir: join(ROOT, "not-in-chain") }),
	});
	check(roPut.status === 400, "不在链里的目录当写目标 → 400", `HTTP ${roPut.status}`);

	const drop = await apiJson(`/api/v1/agent/skill-dirs?path=${encodeURIComponent(extraDir)}`, {
		method: "DELETE",
	});
	check(drop.status === 200, "移除位置 200", `HTTP ${drop.status}`);
	check(existsSync(join(extraDir, "extra-note.md")), "移除位置不删磁盘文件");
	const afterDrop = await apiJson("/api/v1/agent/skills");
	check(
		((afterDrop.body.dirs ?? []) as { origin: string }[]).every((row) => row.origin !== "custom"),
		"移除后读取链回到 user → agents → app",
	);
	// G2. 内置来源可移除：.agents 记排除名单；主目录不可移除；重新添加同路径即恢复
	const chainRows = (afterDrop.body.dirs ?? []) as { dir: string; origin: string; removable: boolean }[];
	check(
		chainRows.find((row) => row.origin === "agents")?.removable === true,
		".agents 行可移除",
		JSON.stringify(chainRows.find((row) => row.origin === "agents")),
	);
	check(
		chainRows.find((row) => row.origin === "user")?.removable === false,
		"主目录行不提供移除",
	);
	const dropMain = await apiJson(
		`/api/v1/agent/skill-dirs?path=${encodeURIComponent(join(HOME, ".lifediary", "skills"))}`,
		{ method: "DELETE" },
	);
	check(dropMain.status === 400, "移除主目录 → 400", `HTTP ${dropMain.status}`);
	const dropAgents = await apiJson(`/api/v1/agent/skill-dirs?path=${encodeURIComponent(homeAgents)}`, {
		method: "DELETE",
	});
	check(
		dropAgents.status === 200 && dropAgents.body.removed === "excluded",
		".agents 移除 → 记排除名单",
		JSON.stringify(dropAgents.body),
	);
	check(existsSync(join(homeAgents, "probe-agents.md")), "移除来源不删磁盘文件");
	const afterAgents = await apiJson("/api/v1/agent/skills");
	check(
		((afterAgents.body.dirs ?? []) as { origin: string }[]).every((row) => row.origin !== "agents"),
		"移除后 .agents 不再在链里",
	);
	check(
		!((afterAgents.body.items ?? []) as { name: string }[]).some((item) => item.name === "probe-agents"),
		"移除后 .agents 的技能不再出现",
	);
	const restore = await apiJson("/api/v1/agent/skill-dirs", {
		method: "POST",
		body: JSON.stringify({ path: homeAgents }),
	});
	check(restore.status === 200, "重新添加同一路径 → 200", `HTTP ${restore.status}`);
	const restoredList = await apiJson("/api/v1/agent/skills");
	const restoredRow = ((restoredList.body.dirs ?? []) as { dir: string; origin: string }[]).find(
		(row) => row.dir === homeAgents,
	);
	check(restoredRow?.origin === "custom", "恢复后以自加位置身份回到链里", JSON.stringify(restoredRow));
	check(
		((restoredList.body.items ?? []) as { name: string }[]).some((item) => item.name === "probe-agents"),
		"恢复后技能重新可见",
	);
	await apiJson(`/api/v1/agent/skill-dirs?path=${encodeURIComponent(homeAgents)}`, { method: "DELETE" });
	await stopServer();

	await startServer({ USERPROFILE: HOME, HOME, SKILLS_EXTRA_DIRS: "false" });
	check(
		(await apiJson("/api/v1/agent/skill-dirs", {
			method: "POST",
			body: JSON.stringify({ path: extraDir }),
		})).status === 404,
		"SKILLS_EXTRA_DIRS=false → 登记端点 404",
	);
	check((await apiJson("/api/v1/agent/skills")).body.extraDirs === false, "extraDirs=false");
	await stopServer();
} finally {
	server?.kill();
	await sleep(300);
	for (const path of [DB, `${DB}-wal`, `${DB}-shm`, CHAT_META, POLICY, PAIRING, PROVIDERS, RUNTIME]) {
		rmSync(path, { force: true });
	}
	rmSync(ROOT, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✓ 技能管理探针全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
