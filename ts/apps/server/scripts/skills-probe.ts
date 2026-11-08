/**
 * 技能管理探针（2026-11-08 扫尾批 9-S）。
 *
 * 真起服务、真 HTTP、真文件，四段：
 *   A. 用户目录：首访自动建 `%USERPROFILE%/.lifediary/skills` → 列表 → 新建 → 读 → 覆盖 → 删除；
 *      名字白名单 / 两行结构 / 64KB 上限三组 400；无令牌 403 空体。
 *   B. AGENT_SKILLS_DIR 显式优先：origin=env，目录由写入时创建。
 *   C. 用户目录建不出来（用文件冒充 USERPROFILE）→ origin=app，两条内置手册可见，且只读不写。
 *   D. SKILLS_ADMIN=false → 路由不挂（404，= 未启用）。
 *
 * 卫生：所有落点都在系统临时目录 + `.data/probe-skills-*`，跑完即删；不碰真实用户目录与内置手册。
 *
 *   pnpm --filter @lifediary/server skills
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const ROOT = mkdtempSync(join(tmpdir(), "lifediary-skills-probe-"));
const HOME = join(ROOT, "home");
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
		CHANCELLOR_ENABLED: "false",
		AUTONOMY_ENABLED: "false",
		AGENT_TOOL_POLICY: "full",
		AGENT_SKILLS_DIR: "",
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
	check(Array.isArray(initial.body.items) && initial.body.items.length === 0, "初始技能为空");

	const content = "每天的简报流程\n按项目分组列出变化，超过三条才细说。";
	const created = await put("daily-brief", content);
	check(created.status === 200 && created.body.created === true, "PUT 新建 → created=true", JSON.stringify(created.body));
	check(readFileSync(join(userDir, "daily-brief.md"), "utf8") === content, "文件内容与请求一致");

	const listed = await apiJson("/api/v1/agent/skills");
	const items = (listed.body.items ?? []) as { name: string; summary: string; size: number }[];
	check(items.length === 1 && items[0]?.name === "daily-brief", "列表出现新技能", JSON.stringify(items));
	check(items[0]?.summary === "每天的简报流程", "首行 = 索引摘要", String(items[0]?.summary));
	check(Number(items[0]?.size) > 0, "size > 0", String(items[0]?.size));

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
		names.includes("meeting_guide") && names.includes("recall_guide"),
		"两条内置手册可见",
		names.join("、"),
	);
	const appRead = await apiJson("/api/v1/agent/skills/meeting_guide");
	check(appRead.status === 200 && String(appRead.body.content).length > 0, "内置手册可读");
	await stopServer();

	// ── D. 回滚开关 ────────────────────────────────────────────
	console.log("\nD. SKILLS_ADMIN=false");
	await startServer({ SKILLS_ADMIN: "false", USERPROFILE: HOME, HOME });
	check((await apiJson("/api/v1/agent/skills")).status === 404, "列表 404（= 未启用）");
	check((await put("whatever", "摘要\n正文")).status === 404, "写入 404");
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
