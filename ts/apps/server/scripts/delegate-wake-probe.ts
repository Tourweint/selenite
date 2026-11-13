/**
 * 派活完成即唤醒探针（2026-11-10 批 29）。
 *
 * 真起服务 + 真 HTTP + faux 模型（真 durable 链路、假模型）：
 *   A. 默认开：从总管会话派一单 → 等终态 → 汇报写回 → **会话自动多一轮**唤醒，
 *      唤醒提示词里带该单号前 6 位；
 *   B. `DELEGATION_WAKE_ENABLED=false`：同场景 → 汇报仍写回，但没有唤醒轮。
 *
 * 为什么用 `LLM_FAUX_TOOL=delegate`：服务端 faux 只会"调工具不收尾"，把回合上限压到 1，
 * 一轮只派一单；chancellor 的 native worker 走自己的 faux 给出结论（本探针实测终态是
 * `needs_you`——同属会写汇报的终态，正好覆盖"需要主人拿主意"那条），不依赖外网、不碰真实 key。
 *
 * 用法：`pnpm --filter @lifediary/server delegate-wake`
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8194;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = join(import.meta.dirname, "..");
/** 总管主会话的对外 id 约定（partnerCanonicalExternalId("chief")），读出唤醒轮用它 */
const CHIEF_SESSION = "partner-chief";
const TOKEN = "delegate-wake-probe-token";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

interface Phase {
	root: string;
	child: ChildProcess;
	logs: string[];
}

async function startServer(extra: Record<string, string>): Promise<Phase> {
	const root = mkdtempSync(join(tmpdir(), "lifediary-wake-probe-"));
	mkdirSync(join(root, "runs"), { recursive: true });
	const logs: string[] = [];
	const child = spawn(
		process.execPath,
		["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"],
		{
			cwd: DIR,
			env: {
				...process.env,
				PORT: String(PORT),
				AGENT_TOKEN: TOKEN,
				LLM_PROVIDER: "faux",
				LLM_API_KEY: "",
				LLM_FAUX_TOOL: "delegate",
				LLM_FAUX_ARGS: JSON.stringify({
					requirement: "探针：把这件事办完，然后写一句结论",
				}),
				// faux 只会调工具、永不收尾：一轮最多一次工具调用，流能正常收尾。
				AGENT_MAX_TURNS: "1",
				AGENT_DB_PATH: join(root, "agent.sqlite"),
				MEMORY_ENABLED: "false",
				MEMORY_DB_PATH: join(root, "memory.db"),
				PROJECTS_DB_PATH: join(root, "projects.sqlite"),
				PROVIDERS_PATH: join(root, "providers.json"),
				DELEGATIONS_DB_PATH: join(root, "delegations.sqlite"),
				AGENT_SSE_SEQ_DB_PATH: join(root, "chat-events.sqlite"),
				AUTONOMY_ENABLED: "false", // 探针显式关（默认已于 2026-11-13 翻成开）
				AGENT_APPROVALS_PATH: join(root, "approvals.json"),
				AGENT_POLICY_PATH: join(root, "policy.json"),
				AGENT_FLAGS_PATH: join(root, "agent-flags.json"),
				PARTNERS_DB_PATH: join(root, "partners.sqlite"),
				PARTNER_HOMES_ROOT: join(root, "partner-homes"),
				ROUTINES_STATE_PATH: join(root, "routines.json"),
				AUTONOMY_STATE_PATH: join(root, "autonomy-state.json"),
				COMPANIONS_ENABLED: "true",
				CHIEF_PARTNER: "true",
				CHANCELLOR_ENABLED: "true",
				CHANCELLOR_EMPLOYEE: "native",
				CHANCELLOR_LLM_PROVIDER: "faux",
				CHANCELLOR_WORK_ROOT: join(root, "runs"),
				DELEGATION_PROJECT_REQUIRED: "false",
				NODE_OPTIONS: "",
				...extra,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout?.on("data", (chunk: Buffer) => {
		const line = chunk.toString();
		logs.push(line);
		for (const item of line.split("\n")) {
			if (item.trim()) console.log(`  [server] ${item}`);
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		logs.push(text);
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [server!] ${text}`);
	});

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const response = await fetch(`${BASE}/healthz`);
			if (response.ok) return { root, child, logs };
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		await sleep(250);
	}
}

async function stopServer(phase: Phase): Promise<void> {
	phase.child.kill();
	await sleep(500);
	try {
		rmSync(phase.root, { recursive: true, force: true });
	} catch {
		/* Windows 句柄延迟：临时目录留着无害 */
	}
}

async function api(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: any; raw: string }> {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const raw = await response.text();
	let json: any = null;
	try {
		json = raw ? JSON.parse(raw) : null;
	} catch {
		json = { raw: raw.slice(0, 300) };
	}
	return { status: response.status, json, raw };
}

interface TicketRow {
	id: string;
	status: string;
	updated_at?: string;
}

const TERMINAL = new Set(["done", "failed", "aborted", "canceled", "needs_you"]);

/** 等这张单到终态（只认事实，超时如实失败） */
async function waitForTerminal(timeoutMs: number): Promise<TicketRow | null> {
	const deadline = Date.now() + timeoutMs;
	let last: TicketRow[] = [];
	while (Date.now() < deadline) {
		const response = await api("GET", "/api/v1/tickets?limit=20");
		last = (response.json?.tickets ?? []) as TicketRow[];
		const settled = last.find((ticket) => TERMINAL.has(ticket.status));
		if (settled) return settled;
		await sleep(400);
	}
	console.log(`  [probe] 超时前最后看到的单：${JSON.stringify(last.map((t) => `${t.id}:${t.status}`))}`);
	return null;
}

/** 读总管会话 transcript 的原始 JSON 文本（唤醒提示词是一条 user 消息，能直接搜） */
async function readChiefTranscript(): Promise<string> {
	const response = await api("GET", `/api/v1/agent/chat/${CHIEF_SESSION}/messages?limit=200`);
	return response.raw;
}

async function waitForWake(timeoutMs: number): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const raw = await readChiefTranscript();
		if (raw.includes("[Delegation wake context]")) return raw;
		await sleep(400);
	}
	return null;
}

async function runPhase(label: string, wakeEnabled: boolean): Promise<void> {
	console.log(`\n· ${label}（DELEGATION_WAKE_ENABLED=${wakeEnabled ? "true(默认)" : "false"}）`);
	const phase = await startServer(
		wakeEnabled ? {} : { DELEGATION_WAKE_ENABLED: "false" },
	);
	try {
		// 从总管会话派一单（partner-chief 走 ensurePartnerSession，链接表里有它 → 有资格唤醒）
		const run = await api("POST", "/api/v1/partners/chief/run", {
			text: "在后台把这件事派出去，完了把结果告诉我。",
		});
		check(run.status === 200, "总管会话跑完一轮（派单已发出）", `status=${run.status}`);

		const ticket = await waitForTerminal(90_000);
		check(Boolean(ticket), "派出的单到达终态（faux worker 真跑）", ticket ? `${ticket.id} = ${ticket.status}` : "");
		if (!ticket) return;
		const prefix = ticket.id.slice(0, 6);

		// 汇报写回：report.text 是 `【任务 <单号>…】…`（不额外调模型）
		let reported = false;
		for (let i = 0; i < 50 && !reported; i += 1) {
			reported = (await readChiefTranscript()).includes(`【任务 ${ticket.id}`);
			if (!reported) await sleep(300);
		}
		check(reported, "执行端汇报已写回总管会话", `ticket=${ticket.id}`);

		if (wakeEnabled) {
			const transcript = await waitForWake(45_000);
			check(Boolean(transcript), "总管会话随后自动多了一轮（唤醒轮）");
			check(
				Boolean(transcript?.includes(`- 单 ${prefix}（`)),
				"唤醒提示词提到该单号前 6 位",
				`前缀=${prefix}`,
			);
			check(
				Boolean(transcript?.includes("turnAuthority: autonomous")),
				"唤醒轮带 autonomous 文本头",
			);
		} else {
			// 防抖 2 秒 + 富余：确认这段时间里没有唤醒痕迹
			await sleep(6_000);
			const transcript = await readChiefTranscript();
			check(
				!transcript.includes("[Delegation wake context]"),
				"开关关：汇报照写，但没有唤醒轮（改动前行为）",
			);
		}

		check(
			!phase.logs.join("").includes("Uncaught"),
			"服务日志没有未捕获异常",
		);
	} finally {
		await stopServer(phase);
	}
}

try {
	await runPhase("A. 默认开：完成即唤醒", true);
	await runPhase("B. 回滚：只写汇报不唤醒", false);
	console.log(
		failures === 0
			? "\n✓ 派活完成即唤醒探针全部通过"
			: `\n✗ 派活完成即唤醒有 ${failures} 项不对`,
	);
} finally {
	process.exitCode = failures === 0 ? 0 : 1;
}
