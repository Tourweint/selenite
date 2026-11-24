/**
 * 记忆库槽位探针（2026-11-23 外部记忆库接入）。
 *
 * 真起服务、真 HTTP、真子进程：
 *   - 假 ask.py / repair.py 用 JS 写，`PERSONA_PYTHON` 指向 `process.execPath`
 *     （node 把 `.py` 当 CommonJS 跑）——不需要本机 python，也不碰 persona-metric；
 *   - 每个实例的数据目录都在系统临时目录里，跑完清掉。
 *
 * 验两件事（任务书 §五；2026-11-24 旧形态退役后）：
 *   1. 无 bank env 的隔离实例：active=builtin、external=null，端点可用；
 *   2. 接入链：probe → 保存 → 切 external → recall 返回假命中 → remember 写假文件 → 切回 builtin。
 *  （旧形态实例 C「MEMORY_BANK=false → 端点 404 / persona_recall」已随退役删除。）
 *
 *   pnpm --filter @lifediary/server memory-bank
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER_ROOT = join(import.meta.dirname, "..");
const TSX = join(SERVER_ROOT, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const ROOT = mkdtempSync(join(tmpdir(), "lifediary-bank-probe-"));
const BANK = join(ROOT, "bank");
const DATA = join(ROOT, "data");
const CONFIG = join(ROOT, "memory-bank.json");
const ASK_LOG = join(BANK, "ask.log");
const REPAIR_LOG = join(BANK, "repair.log");

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

mkdirSync(BANK, { recursive: true });
mkdirSync(DATA, { recursive: true });

// 假外接库：读 = ask.py（catalog / 检索两种模式），写 = repair.py（追加一行 + exit 0）。
writeFileSync(
	join(BANK, "ask.py"),
	`const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "ask.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--catalog-only")) {
  console.log("探针库：2 条记录");
  console.log("人物：姥姥");
  process.exit(0);
}
console.log(JSON.stringify({
  groups: {
    memory_day: [{ id: "mem-bank-1", date: "2024-10-06", title: "旧事", body: "探针假命中正文", why: "关键词命中" }]
  },
  coverage: { gaps: ["2022-03"] },
  unknown: "查不到 ≠ 没有这回事"
}));
`,
	"utf8",
);
writeFileSync(
	join(BANK, "repair.py"),
	`const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "repair.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("已记：ok");
`,
	"utf8",
);

// 多语言入口（2026-11-23）：.js 入口按扩展名选 node，证明「不一定是 Python」。
const JSBANK = join(ROOT, "bank-js");
mkdirSync(JSBANK, { recursive: true });
writeFileSync(
	join(JSBANK, "ask.js"),
	`if (process.argv.includes("--catalog-only")) {
  console.log("JS 探针库：1 条记录");
  process.exit(0);
}
console.log(JSON.stringify({ groups: { notes: [{ id: "js-1", text: "JS 入口命中" }] }, unknown: "" }));
`,
	"utf8",
);
writeFileSync(join(JSBANK, "repair.js"), `console.log("已记：ok");`, "utf8");

function isolateEnv(port: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		PORT: String(port),
		LLM_PROVIDER: "faux",
		LLM_API_KEY: "",
		AGENT_TOKEN: "",
		AGENT_DB_PATH: join(DATA, "agent.sqlite"),
		MEMORY_DB_PATH: join(DATA, "memory.db"),
		PROJECTS_DB_PATH: join(DATA, "projects.sqlite"),
		AGENT_CHAT_META_PATH: join(DATA, "chat-meta.json"),
		CURRENT_PROJECT: "",
		CHAT_PROJECT_LABEL: "",
		PROVIDERS_PATH: join(DATA, "providers.json"),
		PARTNERS_DB_PATH: join(DATA, "partners.sqlite"),
		PARTNER_HOMES_ROOT: join(DATA, "partner-homes"),
		AGENT_POLICY_PATH: join(DATA, "policy.json"),
		AGENT_LOCAL_SECRET_PATH: join(DATA, "local-secret"),
		ATTACHMENTS_DIR: join(DATA, "attachments"),
		AGENT_FLAGS_PATH: join(DATA, "agent-flags.json"),
		AGENT_SKILLS_STATE_PATH: join(DATA, "skill-state.json"),
		AUTONOMY_ENABLED: "false",
		AUTONOMY_OBSERVE_PATH: join(DATA, "autonomy-observe.jsonl"),
		AUTONOMY_STATE_PATH: join(DATA, "autonomy-state.json"),
		AGENT_APPROVALS_PATH: join(DATA, "approvals.json"),
		AGENT_GATE_AUDIT_PATH: join(DATA, "gate-blocks.jsonl"),
		AGENT_TOOL_USAGE_PATH: join(DATA, "tool-usage.json"),
		AGENT_TURN_TIMELINE_PATH: join(DATA, "turn-timeline.jsonl"),
		PAIRING_STORE_PATH: join(DATA, "pairing.json"),
		USER_PROFILE_PATH: join(DATA, "user-profile.md"),
		MEMORY_PROPOSALS_PATH: join(DATA, "memory-proposals.json"),
		MEMORY_CONSOLIDATE_DIFF_PATH: join(DATA, "memory-consolidate-diff.json"),
		DELEGATIONS_DB_PATH: join(DATA, "delegations.sqlite"),
		AGENT_SSE_SEQ_DB_PATH: join(DATA, "chat-events.sqlite"),
		ROUTINES_STATE_PATH: join(DATA, "routines.json"),
		CHANCELLOR_ENABLED: "false",
		COMPANIONS_ENABLED: "false",
		PARTNER_MEMORY_RECALL: "true",
		MEMORY_ENABLED: "true",
		MEMORY_EXTRACT: "rule",
		MEMORY_BANK_PATH: CONFIG,
		PERSONA_MEMORY_ASK: "",
		PERSONA_MEMORY_ENABLED: "true",
		PERSONA_MEMORY_INJECT: "true",
		PERSONA_WRITE_ENABLED: "true",
		PERSONA_PYTHON: process.execPath,
		NODE_OPTIONS: "",
		...extra,
	};
}

function startServer(port: number, extra: NodeJS.ProcessEnv = {}): ChildProcess {
	const child = spawn(process.execPath, [TSX, "src/index.ts"], {
		cwd: SERVER_ROOT,
		env: isolateEnv(port, extra),
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [server:${port}] ${text}`);
	});
	return child;
}

async function stopServer(child: ChildProcess | null): Promise<void> {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill();
	await Promise.race([exited, sleep(3000)]);
}

async function waitForReady(port: number): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`);
			if (response.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error(`服务没能在端口 ${port} 启动`);
}

interface JsonResult {
	status: number;
	body: any;
}

async function api(port: number, path: string, init?: RequestInit): Promise<JsonResult> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, body };
}

function jsonInit(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

/**
 * 发一轮对话，收到指定工具的 end 帧就掐掉流（faux 会一直调工具，不掐会跑满回合）。
 * 返回该帧的 output（工具结果正文）。
 */
async function chatUntilToolEnd(
	port: number,
	text: string,
	toolName: string,
	timeoutMs = 45_000,
): Promise<{ output?: string; conversationId?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/v1/agent/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
			signal: controller.signal,
		});
		assertHealthy(response.status, "chat");
		const reader = response.body?.getReader();
		if (!reader) return {};
		const decoder = new TextDecoder();
		let buffer = "";
		let conversationId: string | undefined;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line.startsWith("data:")) continue;
				let frame: { type?: string; conversationId?: string; name?: string; status?: string; output?: string };
				try {
					frame = JSON.parse(line.slice(5).trim());
				} catch {
					continue;
				}
				if (frame.type === "start" && frame.conversationId) conversationId = frame.conversationId;
				if (frame.type === "tool" && frame.name === toolName && frame.status === "end") {
					await reader.cancel();
					return { output: frame.output, conversationId };
				}
			}
		}
		return { conversationId };
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

function assertHealthy(status: number, label: string): void {
	if (status !== 200) throw new Error(`${label} 返回 ${status}`);
}

function askCalls(): string[][] {
	if (!existsSync(ASK_LOG)) return [];
	return readFileSync(ASK_LOG, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);
}

function repairCalls(): string[][] {
	if (!existsSync(REPAIR_LOG)) return [];
	return readFileSync(REPAIR_LOG, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);
}

let serverA: ChildProcess | null = null;
let serverB: ChildProcess | null = null;
let serverB2: ChildProcess | null = null;

try {
	// ── 实例 A：无 bank env → builtin / external=null；跑完整接入链 ──
	const PORT_A = Number(process.env.PROBE_PORT ?? 8117);
	serverA = startServer(PORT_A);
	await waitForReady(PORT_A);
	console.log("\n[1] 无外部库 env：builtin 空态 + 接入链");
	{
		const state = await api(PORT_A, "/api/v1/agent/memory/bank");
		check(state.status === 200 && state.body.active === "builtin", "GET /bank：active=builtin");
		check(state.body.external === null, "GET /bank：external=null");
		check(
			Array.isArray(state.body.tools) && state.body.tools.includes("recall") && state.body.tools.includes("remember"),
			"GET /bank：工具面 recall + remember",
			JSON.stringify(state.body.tools),
		);

		const probe = await api(PORT_A, "/api/v1/agent/memory/bank/probe", jsonInit("POST", { root: BANK }));
		check(probe.status === 200 && probe.body.ok === true, "POST /bank/probe：探测通过", probe.body.status);
		check(probe.body.ask === "ask.py" && probe.body.repair === "repair.py", "probe：识别 ask.py + repair.py");
		check(
			(probe.body.catalog?.lines ?? []).some((line: string) => line.includes("探针库")),
			"probe：catalog-only 真跑出了库边界",
		);
		const afterProbe = await api(PORT_A, "/api/v1/agent/memory/bank");
		check(afterProbe.body.external === null, "probe 不落盘");

		const saved = await api(
			PORT_A,
			"/api/v1/agent/memory/bank/external",
			jsonInit("PUT", { root: BANK, name: "探针库" }),
		);
		check(saved.status === 200 && saved.body.external?.name === "探针库", "PUT /bank/external：保存成功");
		check(saved.body.bank.active === "builtin", "保存不自动切换");

		const switched = await api(PORT_A, "/api/v1/agent/memory/bank", jsonInit("PUT", { active: "external" }));
		check(switched.status === 200 && switched.body.active === "external", "PUT /bank：切到 external");
		const stateExternal = await api(PORT_A, "/api/v1/agent/memory/bank");
		check(stateExternal.body.external?.status === "ok", "GET /bank：external status=ok");
		check(stateExternal.body.external?.capabilities.read === true, "capabilities.read=true");
		check(stateExternal.body.external?.capabilities.write === true, "capabilities.write=true（写开关已开）");

		const catalog = await api(PORT_A, "/api/v1/agent/memory/bank/catalog");
		check(catalog.status === 200 && (catalog.body.lines ?? []).some((l: string) => l.includes("姥姥")), "GET /bank/catalog");

		const search = await api(
			PORT_A,
			"/api/v1/agent/memory/bank/search",
			jsonInit("POST", { query: "旧事", limit: 5 }),
		);
		check(search.status === 200 && search.body.count === 1, "POST /bank/search：1 条命中");
		check(search.body.hits?.[0]?.text === "探针假命中正文", "search：命中带 text / group", JSON.stringify(search.body.hits?.[0]?.group));
		check(search.body.unknown === "查不到 ≠ 没有这回事", "search：unknown 透传");

		// 多语言入口（2026-11-23）：.js 目录按扩展名选 node 跑，catalog 真通。
		const jsProbe = await api(PORT_A, "/api/v1/agent/memory/bank/probe", jsonInit("POST", { root: JSBANK }));
		check(jsProbe.status === 200 && jsProbe.body.ok === true, "JS 入口：probe 通过", jsProbe.body.status);
		check(
			jsProbe.body.ask === "ask.js" && jsProbe.body.repair === "repair.js",
			"JS 入口：识别 ask.js / repair.js",
			`${jsProbe.body.ask}/${jsProbe.body.repair}`,
		);
		check(
			(jsProbe.body.catalog?.lines ?? []).some((line: string) => line.includes("JS 探针库")),
			"JS 入口：node 真跑出了 catalog",
		);
		const jsSave = await api(PORT_A, "/api/v1/agent/memory/bank/external", jsonInit("PUT", { root: JSBANK }));
		check(jsSave.status === 200 && jsSave.body.external?.ask === "ask.js", "JS 入口：接入保存");
		const jsSearch = await api(
			PORT_A,
			"/api/v1/agent/memory/bank/search",
			jsonInit("POST", { query: "JS", limit: 5 }),
		);
		check(
			jsSearch.status === 200 && jsSearch.body.hits?.[0]?.text === "JS 入口命中",
			"JS 入口：search 走 node 入口",
			JSON.stringify(jsSearch.body.hits?.[0] ?? jsSearch.body),
		);
		// 复原成 .py 探针库，后面的实例还要用。
		const restore = await api(PORT_A, "/api/v1/agent/memory/bank/external", jsonInit("PUT", { root: BANK }));
		check(restore.status === 200 && restore.body.external?.ask === "ask.py", "复原为 .py 探针库");
	}
	await stopServer(serverA);
	serverA = null;

	// ── 实例 B：external + faux 只会调 recall → 工具真走 bank 的 ask.py ──
	const PORT_B = Number(process.env.PROBE_PORT_B ?? 8118);
	serverB = startServer(PORT_B, { LLM_FAUX_TOOL: "recall", LLM_FAUX_ARGS: '{"query":"旧事","limit":3}' });
	await waitForReady(PORT_B);
	console.log("\n[2] 外部槽位：recall / remember 真走 ask.py / repair.py");
	{
		const before = askCalls().length;
		const recalled = await chatUntilToolEnd(PORT_B, "帮我回忆一下旧事", "recall");
		const calls = askCalls();
		check((recalled.output ?? "").includes("探针假命中正文"), "recall：返回外接库命中（renderPersonaAsk）", (recalled.output ?? "").slice(0, 60));
		check((recalled.output ?? "").includes("查不到 ≠ 没有这回事"), "recall：unknown 透传");
		const searchCall = calls.slice(before).find((args) => args[0] === "旧事");
		check(Boolean(searchCall), "recall：ask.py 收到 query", JSON.stringify(searchCall));
		check(
			Boolean(searchCall && searchCall.includes("--json") && searchCall.includes("--limit")),
			"recall：argv 带 --json / --limit",
		);
		check(!calls.some((args) => args.some((arg) => arg.includes("persona.db"))), "ask.py argv 不出现 persona.db");
	}
	await stopServer(serverB);
	serverB = null;

	// ── 实例 B2：faux 只会调 remember → 工具真写 repair.py ──
	const PORT_B2 = Number(process.env.PROBE_PORT_B2 ?? 8119);
	serverB2 = startServer(PORT_B2, {
		LLM_FAUX_TOOL: "remember",
		LLM_FAUX_ARGS: '{"content":"住院的是我姥姥"}',
	});
	await waitForReady(PORT_B2);
	{
		const before = repairCalls().length;
		const remembered = await chatUntilToolEnd(PORT_B2, "记一下：住院的是我姥姥", "remember");
		const calls = repairCalls();
		check((remembered.output ?? "").includes("外部记忆库只收原话"), "remember：返回「参数未生效」提示", (remembered.output ?? "").slice(0, 80));
		const writeCall = calls.slice(before).find((args) => args[1] === "住院的是我姥姥");
		check(Boolean(writeCall), "remember：repair.py 收到 statement", JSON.stringify(writeCall));
		check(
			Boolean(writeCall && writeCall[0] === "statement" && writeCall.includes("--why")),
			"remember：argv = statement <body> --why <原因>",
		);
	}
	await stopServer(serverB2);
	serverB2 = null;

	// 切回 builtin（直接打端点，用一个新实例省得复用已被 kill 的）
	const PORT_A2 = Number(process.env.PROBE_PORT_A2 ?? 8120);
	serverA = startServer(PORT_A2);
	await waitForReady(PORT_A2);
	{
		const switched = await api(PORT_A2, "/api/v1/agent/memory/bank", jsonInit("PUT", { active: "builtin" }));
		check(switched.status === 200 && switched.body.active === "builtin", "切回 builtin");
		const catalog = await api(PORT_A2, "/api/v1/agent/memory/bank/catalog");
		check(catalog.status === 400 && catalog.body.error === "bank_builtin", "builtin 时 catalog 400");
	}
	await stopServer(serverA);
	serverA = null;
} catch (error) {
	failures += 1;
	console.error(`\n✗ 探针异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
	await stopServer(serverA);
	await stopServer(serverB);
	await stopServer(serverB2);
	rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

console.log(failures === 0 ? "\n✓ 记忆库槽位探针全部通过" : `\n✗ 记忆库槽位探针有 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
