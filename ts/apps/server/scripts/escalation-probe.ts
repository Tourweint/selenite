/**
 * 决策上报链端到端探针（2026-11-19 批2：worker→总管→用户上报链）。
 *
 * 真起服务 + 真 HTTP + faux 模型（真 durable 链路、真本机池 worker 进程）：
 *
 *   1. 总管会话派一单（faux 调 delegate）→ chancellor 拆单（探针替身放行第一单）
 *      → 池 worker 真起 → worker 的 faux 脚本调 `escalate` 上报；
 *   2. 上报沿池 SSE `escalation` 事件 → chancellor 事件 → 宿主路由（escalation.ts）：
 *      活跃登记 + 唤醒总管 canonical 会话（批3 agent-message 信封，[Escalation
 *      wake context] 提示词）；
 *   3. 派活方会话收到上报卡数据：GET /agent/escalations 活跃列表可查；
 *   4. worker 挂起不退（单不终态）；升级给用户（POST route action=user）→
 *      现有 ask_user 管线出问题卡 → POST /agent/approvals/:callId/answer 答复；
 *   5. 答复经批1 插话通道（steer）投回 worker → worker 续跑 → REPORT 变终态
 *      → worker 退场 → 验收（替身 pass）→ 单到 done；
 *   6. 审计：谁答的（主人）在任务详情留言表里带署名可查；活跃上报答完即清。
 *
 * 拆单替身只放行第一单：上报唤醒的代答轮会再派一单，计划失败 = 不派 worker =
 * 不会再 escalation，链自然断开。（原用 DELEGATION_WAKE_ENABLED=false 隔离旧汇报
 * 唤醒；该回滚开关 2026-11-21 退役，唤醒恒开——多出来的汇报唤醒轮同样走到"再派
 * 一单被替身拒绝"，对断链断言无影响。）
 *
 * 用法：`pnpm --filter @lifediary/server escalation`
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8197;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = join(import.meta.dirname, "..");
const CHIEF_SESSION = "partner-chief";
const TOKEN = "escalation-probe-token";

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

async function startServer(): Promise<Phase> {
	const root = mkdtempSync(join(tmpdir(), "lifediary-escalation-probe-"));
	mkdirSync(join(root, "runs"), { recursive: true });
	const logs: string[] = [];
	const child = spawn(
		process.execPath,
		["../../node_modules/tsx/dist/cli.mjs", "scripts/escalation-probe-server.ts"],
		{
			cwd: DIR,
			env: {
				...process.env,
				PORT: String(PORT),
				AGENT_TOKEN: TOKEN,
				LLM_PROVIDER: "faux",
				LLM_API_KEY: "",
				// 总管的 faux 只会调 delegate（一轮一次）：派单 + 唤醒代答轮各派一单；
				// 第二单起拆单替身拒绝，链断。
				LLM_FAUX_TOOL: "delegate",
				LLM_FAUX_ARGS: JSON.stringify({ requirement: "escalate-probe 探针任务" }),
				AGENT_MAX_TURNS: "1",
				AGENT_DB_PATH: join(root, "agent.sqlite"),
				MEMORY_ENABLED: "false",
				MEMORY_DB_PATH: join(root, "memory.db"),
				PROJECTS_DB_PATH: join(root, "projects.sqlite"),
				PROVIDERS_PATH: join(root, "providers.json"),
				DELEGATIONS_DB_PATH: join(root, "delegations.sqlite"),
				AGENT_SSE_SEQ_DB_PATH: join(root, "chat-events.sqlite"),
				AUTONOMY_ENABLED: "false",
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
				CHANCELLOR_EMPLOYEE: "pool",
				CHANCELLOR_LLM_PROVIDER: "faux",
				CHANCELLOR_WORK_ROOT: join(root, "runs"),
				// 池进程隔离到临时目录，别碰真实 .data/worker-pool（2026-11-23）。
				WORKER_POOL_DB_DIR: join(root, "worker-pool"),
				SUPERVISOR_POOL_SIZE: "1",
				// AGENT_MAX_TURNS=1 是压宿主 faux 的；池单独放开，否则上报脚本第二步写
				// REPORT 会被 "工具调用已达上限（1 次）" 拦掉（2026-11-23 实测）。
				WORKER_POOL_MAX_TURNS: "100",
				DELEGATION_PROJECT_REQUIRED: "false",
				// 池 worker 的 faux 上报脚本：escalate → waiting 的 REPORT → 等答复；
				// 答复（steer）进来后写 ready 的 REPORT 收尾。
				WORKER_POOL_FAUX_MODE: "escalate",
				NODE_OPTIONS: "",
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
	// worker 子进程的 parentAlive 轮询（5s）会让它们跟着退；临时目录留着的无害。
	await sleep(1500);
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
}

const TERMINAL = new Set(["done", "failed", "aborted", "canceled", "needs_you"]);

async function readChiefTranscript(): Promise<string> {
	const response = await api("GET", `/api/v1/agent/chat/${CHIEF_SESSION}/messages?limit=200`);
	return response.raw;
}

async function poll(
	timeoutMs: number,
	probe: () => Promise<string | null>,
): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = await probe();
		if (found !== null) return found;
		await sleep(400);
	}
	return null;
}

async function run(): Promise<void> {
	const phase = await startServer();
	try {
		// 1. 总管派单（faux delegate → 拆单替身放行 → 本机池 worker 真起）
		const run = await api("POST", "/api/v1/partners/chief/run", {
			text: "派出去办一件事，完了汇报。",
		});
		check(run.status === 200, "总管会话跑完一轮（派单已发出）", `status=${run.status}`);

		const ticket = await poll(30_000, async () => {
			const response = await api("GET", "/api/v1/tickets?limit=20");
			const tickets = (response.json?.tickets ?? []) as TicketRow[];
			return tickets[0]?.id ?? null;
		});
		check(Boolean(ticket), "派出的单已受理", ticket ?? "");
		if (!ticket) return;
		const prefix = ticket.slice(0, 6);

		// 2. worker 调 escalate → 宿主路由 → 活跃上报可查（上报卡的数据源）
		const escalation = await poll(40_000, async () => {
			const response = await api("GET", "/api/v1/agent/escalations");
			const list = (response.json?.escalations ?? []) as Array<Record<string, unknown>>;
			const hit = list.find((item) => item.ticketId === ticket);
			return hit ? JSON.stringify(hit) : null;
		});
		if (!escalation) {
			// 诊断：单据现场（processError / 任务状态 / stderr 尾部），失败时看得见原因。
			const detail = await api("GET", `/api/v1/tickets/${ticket}`);
			console.log(
				`  [probe] 上报未到达时的单据现场：${JSON.stringify(detail.json?.ticket ?? detail.json).slice(0, 2000)}`,
			);
			const tasks = (detail.json?.tasks ?? []) as Array<Record<string, unknown>>;
			for (const task of tasks) console.log(`  [probe] task: ${JSON.stringify(task).slice(0, 600)}`);
		}
		check(Boolean(escalation), "worker 上报已到达宿主（活跃上报列表可查 = 上报卡数据）", escalation ?? "");
		check(
			Boolean(escalation?.includes("目录结构选 A 还是 B？") && escalation?.includes('"urgency":"normal"')),
			"上报卡带问题与紧急度",
		);

		// 3. 上报路由已唤醒总管 canonical 会话（代答轮，[Escalation wake context]）
		const wake = await poll(30_000, async () => {
			const raw = await readChiefTranscript();
			return raw.includes("[Escalation wake context]") && raw.includes(`- 单 ${prefix}`) ? "ok" : null;
		});
		check(Boolean(wake), "总管会话收到上报唤醒（respond_escalation 纪律 + 单号）");

		// 4. worker 挂起不退：单在等待期间不进终态
		await sleep(4_000);
		const still = await api("GET", `/api/v1/tickets/${ticket}`);
		const statusWhileWaiting = String(still.json?.ticket?.status ?? "");
		check(
			!TERMINAL.has(statusWhileWaiting),
			"worker 等答复期间挂起不退（单未终态）",
			`status=${statusWhileWaiting}`,
		);

		// 5. 升级给用户（上报卡动作）→ 现有 ask_user 管线出问题卡
		const routed = await api("POST", `/api/v1/agent/escalations/${ticket}/route`, { action: "user" });
		check(routed.status === 200 && routed.json?.ok === true, "上报卡「升级给我」受理", `status=${routed.status}`);
		const callId = String(routed.json?.callId ?? "");
		check(Boolean(callId), "升级返回 ask 的 callId", callId);

		const askCard = await poll(15_000, async () => {
			const response = await api("GET", "/api/v1/agent/approvals");
			const approvals = (response.json?.approvals ?? []) as Array<Record<string, unknown>>;
			const hit = approvals.find((item) => item.callId === callId && item.kind === "ask_user");
			return hit ? JSON.stringify(hit) : null;
		});
		check(Boolean(askCard), "ask 卡已挂（现有问答渲染管线）", askCard ?? "");

		// 6. 用户答复 → 同路投回 worker（批1 steer）→ worker 续跑到终态 → 单 done
		const answered = await api("POST", `/api/v1/agent/approvals/${callId}/answer`, { answer: "用 A。" });
		check(answered.status === 200 && answered.json?.ok === true, "用户答复受理", `status=${answered.status}`);

		const settled = await poll(60_000, async () => {
			const response = await api("GET", `/api/v1/tickets/${ticket}`);
			const status = String(response.json?.ticket?.status ?? "");
			return TERMINAL.has(status) ? status : null;
		});
		check(settled === "done", "worker 收到答复续跑，单到 done", `终态=${settled ?? "(超时)"}`);

		// 7. 审计：谁答的在任务详情留言表里带署名；活跃上报已清
		const detail = await api("GET", `/api/v1/tickets/${ticket}`);
		const messages = JSON.stringify(detail.json?.messages ?? []);
		check(messages.includes("[上报答复·主人]"), "台账带答复署名（谁答的写进留言表）");
		const afterAnswer = await api("GET", "/api/v1/agent/escalations");
		const remaining = ((afterAnswer.json?.escalations ?? []) as Array<Record<string, unknown>>).filter(
			(item) => item.ticketId === ticket,
		);
		check(remaining.length === 0, "活跃上报答完即清");

		check(!phase.logs.join("").includes("Uncaught"), "服务日志没有未捕获异常");
	} finally {
		await stopServer(phase);
	}
}

try {
	await run();
	console.log(failures === 0 ? "\n✓ 决策上报链探针全部通过" : `\n✗ 决策上报链探针有 ${failures} 项不对`);
} catch (error) {
	console.error(`\n✗ 探针异常：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	if (failures > 0) process.exitCode = 1;
}
