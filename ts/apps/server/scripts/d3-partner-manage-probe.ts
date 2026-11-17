import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listManagers } from "../../../packages/chancellor/src/manager/registry.ts";

/**
 * 总管管执事探针（批次D D3）：faux + 真起服务 + 真 HTTP + 真一轮对话。
 *
 * 用 `LLM_FAUX_TOOL=partner_manage`（配合 provider.ts 的 `LLM_FAUX_ARGS`）让 faux
 * 模型在真实对话里调用 partner_manage：
 *   阶段一 create → 断言执事真的建出来（partners 表 + 宰相目录 meta.partner_id + SOUL）；
 *   阶段二 stop → 断言档案删除 + 领域目录改名 .archived- 归档（listManagers 不再列出）。
 *
 * 两个动作的参数不同，故复用同一个隔离根目录、按顺序重启服务（端口不变）。
 * 任务书注：faux 链路走默认 policy（confirmWrites 关），create 不弹审批是预期；
 * 自主轮弹卡行为由 autonomy-risk.test.ts 的 verdict 断言覆盖，不在本探针端到端。
 *
 *   pnpm --filter @lifediary/server d3
 */

const PORT = 8198;
const DOMAIN = "finance";
const HAND_NAME = "阿岚";
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) {
		failed += 1;
		process.exitCode = 1;
	}
}

interface Phase {
	root: string;
	workRoot: string;
	managers: string;
	child: ChildProcess;
	logs: string[];
}

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: "Bearer probe-token" };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在指定隔离根目录起服务；fauxArgs 决定这一轮 faux 模型调 partner_manage 的参数。 */
async function startServer(root: string, fauxArgs: Record<string, unknown>): Promise<Phase> {
	const workRoot = join(root, "runs");
	const logs: string[] = [];
	const proc = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		env: {
			...process.env,
			PORT: String(PORT),
			AGENT_TOKEN: "probe-token",
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			LLM_FAUX_TOOL: "partner_manage",
			LLM_FAUX_ARGS: JSON.stringify(fauxArgs),
			// faux 只会调工具、永不收尾：压低回合上限让流正常收尾（http-probe §10 同款）。
			AGENT_MAX_TURNS: "3",
			// 同一工具被反复调用：本探针只关心首次真实执行，关掉防打转守卫免得截断。
			TOOL_LOOP_GUARD: "false",
			// 全部落进隔离根目录，不碰真实 .data/。
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
			PARTNERS_DB_PATH: join(root, "partners.sqlite"),
			PARTNER_HOMES_ROOT: join(root, "partner-homes"),
			ROUTINES_STATE_PATH: join(root, "routines.json"),
			AUTONOMY_STATE_PATH: join(root, "autonomy-state.json"),
			COMPANIONS_ENABLED: "true",
			CHANCELLOR_ENABLED: "true",
			DELEGATION_PROJECT_REQUIRED: "false",
			CHANCELLOR_WORK_ROOT: workRoot,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout?.on("data", (chunk: Buffer) => {
		const line = chunk.toString();
		logs.push(line);
		process.stdout.write(`  [server] ${line}`);
	});
	proc.stderr?.on("data", (chunk: Buffer) => {
		const line = chunk.toString();
		logs.push(line);
		process.stderr.write(`  [server!] ${line}`);
	});

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const res = await fetch(`${BASE}/healthz`);
			if (res.ok) {
				return { root, workRoot, managers: join(root, "managers"), child: proc, logs };
			}
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		await sleep(300);
	}
}

/** 杀干净并等端口释放（下一阶段复用同端口重启前必须确保旧进程已退）。 */
async function stopServer(phase: Phase): Promise<void> {
	const exited = new Promise<void>((resolve) => {
		if (phase.child.exitCode !== null) {
			resolve();
			return;
		}
		phase.child.once("exit", () => resolve());
	});
	phase.child.kill();
	await exited;
	await sleep(400);
}

async function api(
	method: string,
	path: string,
	body: unknown,
): Promise<{ status: number; body: any }> {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: authHeaders(),
		...(body === null ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	let parsed: any = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = { raw: text.slice(0, 200) };
	}
	return { status: res.status, body: parsed };
}

interface SseEvent {
	type?: string;
	name?: string;
	status?: string;
	output?: string;
	message?: string;
	[key: string]: unknown;
}

/** 收一条完整 SSE 流，返回解析出的事件。 */
async function driveChat(text: string): Promise<{ status: number; events: SseEvent[] }> {
	const res = await fetch(`${BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
		signal: AbortSignal.timeout(60_000),
	});
	const raw = await res.text();
	const events: SseEvent[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			events.push(JSON.parse(line.slice(5).trim()) as SseEvent);
		} catch {
			/* 忽略非 JSON 行 */
		}
	}
	return { status: res.status, events };
}

/** faux 真链路里 partner_manage 的工具结果文案（status=end 的 output）。 */
function toolOutputs(chat: { events: SseEvent[] }): string[] {
	return chat.events
		.filter(
			(event) =>
				event.type === "tool" &&
				event.name === "partner_manage" &&
				event.status === "end",
		)
		.map((event) => String(event.output ?? ""));
}

function metaOf(managers: string): any {
	try {
		return JSON.parse(readFileSync(join(managers, DOMAIN, "meta.json"), "utf8"));
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "lifediary-d3-probe-"));
	const collectedLogs: string[] = [];
	try {
		// ── 阶段一：faux 调 partner_manage create ──
		const p1 = await startServer(root, { action: "create", name: HAND_NAME, domain: DOMAIN });
		let handId = "";
		try {
			const chat = await driveChat("建一个管账的执事");
			const outputs = toolOutputs(chat);
			check(
				"create：chat 流 200 且正常收尾（done）",
				chat.status === 200 && chat.events.some((event) => event.type === "done"),
				`status=${chat.status} events=${chat.events.map((e) => e.type).join(",")}`,
			);
			check(
				"faux 真链路调了 partner_manage create，拿到「已就位」文案",
				outputs.some((out) => out.includes("已就位") && out.includes(DOMAIN)),
				`outputs=${JSON.stringify(outputs).slice(0, 200)}`,
			);

			const list = await api("GET", "/api/v1/partners", null);
			const hand = (list.body?.partners ?? []).find((partner: any) => partner.domain === DOMAIN);
			handId = hand?.id ?? "";
			check(
				"partners 表里有该执事（GET /api/v1/partners 带 domain）",
				list.status === 200 && !!hand && handId.length > 0,
				`partners=${JSON.stringify(list.body?.partners ?? []).slice(0, 160)}`,
			);

			const meta = metaOf(p1.managers);
			check(
				"宰相目录 managers/finance/meta.json 的 partner_id == 执事 id",
				meta?.partner_id === handId && handId.length > 0,
				`meta=${JSON.stringify(meta ?? {}).slice(0, 160)}`,
			);
			check(
				"listManagers 列出该领域",
				listManagers(p1.workRoot).some((entry) => entry.domain === DOMAIN),
				`domains=${JSON.stringify(listManagers(p1.workRoot).map((e) => e.domain))}`,
			);

			const detail = await api("GET", `/api/v1/partners/${handId}`, null);
			check(
				"SOUL 用 delegationSoulSeed 一句话播种",
				String(detail.body?.soul ?? "").includes(`你是${HAND_NAME}，${DOMAIN} 领域的负责人`),
				`soul=${String(detail.body?.soul ?? "").slice(0, 60)}`,
			);
			collectedLogs.push(...p1.logs);
		} finally {
			await stopServer(p1);
		}

		// ── 阶段二：复用同 root 重启，faux 调 partner_manage stop ──
		const p2 = await startServer(root, { action: "stop", partnerId: handId });
		try {
			const chat = await driveChat("停用这个执事");
			const outputs = toolOutputs(chat);
			check(
				"faux 真链路调了 partner_manage stop，拿到「已停用并归档」文案",
				outputs.some((out) => out.includes("已停用")),
				`outputs=${JSON.stringify(outputs).slice(0, 200)}`,
			);

			const gone = await api("GET", `/api/v1/partners/${handId}`, null);
			check("GET /api/v1/partners/:id → 404（档案已删）", gone.status === 404, `status=${gone.status}`);
			check(
				"原领域目录已不在 managers/finance",
				!existsSync(join(p2.managers, DOMAIN)),
			);
			const archivedDirs = existsSync(p2.managers)
				? readdirSync(p2.managers).filter((name) => name.startsWith(`.archived-${DOMAIN}-`))
				: [];
			check(
				"目录改名成 .archived- 前缀（不是物理删）",
				archivedDirs.length === 1,
				`archivedDirs=${JSON.stringify(archivedDirs)}`,
			);
			check(
				"listManagers 不再列出该领域",
				!listManagers(p2.workRoot).some((entry) => entry.domain === DOMAIN),
				`domains=${JSON.stringify(listManagers(p2.workRoot).map((e) => e.domain))}`,
			);
			collectedLogs.push(...p2.logs);
		} finally {
			await stopServer(p2);
		}

		const allLogs = collectedLogs.join("");
		check(
			"服务日志无未捕获异常 / 建执事失败",
			!allLogs.includes("Uncaught") && !allLogs.includes("建执事失败"),
		);
	} finally {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* Windows 句柄延迟：留着下轮清 */
		}
	}
	console.log(failed === 0 ? "\n✓ D3 partner_manage 探针全部通过" : `\n✗ D3 探针有 ${failed} 项失败`);
}

main().catch((error) => {
	console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
