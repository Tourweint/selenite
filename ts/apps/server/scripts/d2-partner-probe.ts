import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listManagers } from "../../../packages/chancellor/src/manager/registry.ts";
import type {
	ChancellorEvent,
	ChancellorRequest,
	TicketResult,
} from "../../../packages/chancellor/src/index.ts";
import { buildManagerIdentity, startDelegation } from "../src/delegation.ts";

/**
 * 执事 = chancellor 宰相 探针（批次D D2）：真起服务 + 真 HTTP + faux 链路。
 *
 * 覆盖（任务书 §验证要求 3）：
 *   1. POST /api/v1/partners 带 domain 建执事 → GET /:id 回显 domain + SOUL 播种；
 *      domain 校验（非法 / 重复 / PATCH 改 domain）与普通执事行为不变；
 *   2. 宰相目录 meta.json 的 partner_id == 执事 id，listManagers 带出；
 *   3. delegate 走一次 domain 派单：宿主注入点的可测缝（buildManagerIdentity +
 *      startDelegation 的 identityHitFor）断言 ChancellorRequest 含 managerIdentity；
 *      再真跑一次 chancellor faux 分管派单，验证整条透传链不报错、partner_id 不被冲掉；
 *   4. DELETE 执事 → 目录改名 .archived- 前缀、listManagers 不再列出、runs 历史保留。
 *
 *   pnpm --filter @lifediary/server d2
 */

const PORT = 8197;
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

async function startServer(): Promise<Phase> {
	const root = mkdtempSync(join(tmpdir(), "lifediary-d2-probe-"));
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
			// 让 delegate 上架；项目前置不铺工作区（本探针不靠聊天触发派单）。
			CHANCELLOR_ENABLED: "true",
			DELEGATION_PROJECT_REQUIRED: "false",
			// 把 chancellor 的 runs / managers 落进隔离根目录，探针可直接读文件断言。
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
			if (res.ok) return { root, workRoot, managers: join(root, "managers"), child: proc, logs };
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

async function stopServer(phase: Phase): Promise<void> {
	phase.child.kill();
	await new Promise((resolve) => setTimeout(resolve, 400));
	try {
		rmSync(phase.root, { recursive: true, force: true });
	} catch {
		/* Windows 句柄延迟：留着下轮清 */
	}
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

function logsClean(phase: Phase): boolean {
	const all = phase.logs.join("");
	return !all.includes("Uncaught") && !all.includes("建执事失败");
}

async function main(): Promise<void> {
	const phase = await startServer();
	try {
		// ── 1. 建执事 + domain 校验 + 普通执事行为不变 ──
		const bad = await api("POST", "/api/v1/partners", { name: "坏领域", domain: "前端" });
		check("非法 domain（中文）→ 400", bad.status === 400, `status=${bad.status}`);

		const plain = await api("POST", "/api/v1/partners", { name: "小澈" });
		check(
			"普通执事（不带 domain）行为不变：201 且响应不含 domain",
			plain.status === 201 && plain.body?.partner?.domain === undefined,
			`status=${plain.status} domain=${JSON.stringify(plain.body?.partner?.domain)}`,
		);

		const created = await api("POST", "/api/v1/partners", { name: HAND_NAME, domain: DOMAIN });
		const id: string = created.body?.partner?.id ?? "";
		check(
			"POST /api/v1/partners 带 domain 建执事 → 201 + domain 回显",
			created.status === 201 && created.body?.partner?.domain === DOMAIN && id.length > 0,
			`status=${created.status} partner=${JSON.stringify(created.body?.partner ?? {}).slice(0, 160)}`,
		);

		const dup = await api("POST", "/api/v1/partners", { name: "抢领域", domain: DOMAIN });
		check("重复 domain → 400", dup.status === 400, `status=${dup.status}`);

		const detail = await api("GET", `/api/v1/partners/${id}`, null);
		check(
			"GET /api/v1/partners/:id → domain 回显 + SOUL 一句话播种",
			detail.status === 200 &&
				detail.body?.partner?.domain === DOMAIN &&
				String(detail.body?.soul ?? "").includes(`你是${HAND_NAME}，${DOMAIN} 领域的负责人`),
			`status=${detail.status} soul=${String(detail.body?.soul ?? "").slice(0, 60)}`,
		);

		const patch = await api("PATCH", `/api/v1/partners/${id}`, { domain: "other" });
		check("PATCH 改 domain → 400（建后固定）", patch.status === 400, `status=${patch.status}`);

		// ── 2. 宰相目录 meta.json 的 partner_id ──
		const metaPath = join(phase.managers, DOMAIN, "meta.json");
		let meta: any = null;
		try {
			meta = JSON.parse(readFileSync(metaPath, "utf8"));
		} catch {
			/* 下面断言会报 */
		}
		check(
			"宰相目录 managers/finance/meta.json 的 partner_id == 执事 id",
			meta?.partner_id === id,
			`meta=${JSON.stringify(meta ?? {}).slice(0, 160)}`,
		);
		const listed = listManagers(phase.workRoot).find((e) => e.domain === DOMAIN);
		check(
			"listManagers 列出该领域并带出 partner_id",
			listed?.meta?.partner_id === id,
			`domain=${listed?.domain} partner_id=${listed?.meta?.partner_id}`,
		);

		// ── 3. 派单注入：宿主注入点的可测缝 ──
		const soulSnapshot = String(detail.body?.soul ?? "");
		const identity = buildManagerIdentity({ name: HAND_NAME, soul: soulSnapshot });
		check(
			"纯函数 buildManagerIdentity 组装出 {name, soul}",
			identity?.name === HAND_NAME && identity?.soul === soulSnapshot,
			`identity=${JSON.stringify(identity ?? {}).slice(0, 120)}`,
		);

		let seen: ChancellorRequest | undefined;
		const finish: Promise<TicketResult> = Promise.resolve({
			ticketId: "T-d2",
			status: "done",
			line: "faux 收到",
			tasks: [],
		});
		const kick = startDelegation(
			{ conversationId: 1, domain: DOMAIN, requirement: "报个平安" },
			{
				// 与 tools.ts 的 localIdentityHit 同款：按 domain 命中执事。
				identityHitFor: (d) =>
					d === DOMAIN ? { name: HAND_NAME, soul: soulSnapshot } : null,
				run: (request, options: { onEvent?: (e: ChancellorEvent) => void }) => {
					seen = request;
					options.onEvent?.({ type: "ticket", ticketId: "T-d2", message: "已受理" });
					return finish;
				},
				emit: () => undefined,
				autoReport: false,
			},
		);
		check(
			"startDelegation 组请求带 domain + managerIdentity（宿主注入点可测缝）",
			seen?.domain === DOMAIN &&
				seen?.managerIdentity?.name === HAND_NAME &&
				seen?.managerIdentity?.soul === soulSnapshot,
			`request=${JSON.stringify(seen ?? {}).slice(0, 220)}`,
		);
		await kick.outcome;

		// 真跑一次 chancellor faux 分管派单：验证整条身份透传链（index → employee/manager
		// → worker-main → section 闭包）不报错，且 chancellor 自己的 ensureManager 不冲掉 partner_id。
		process.env.LLM_PROVIDER = "faux";
		process.env.LLM_API_KEY = "";
		process.env.CHANCELLOR_FAUX_MANAGER_REPLY = "done：faux 分管宰相收到身份";
		process.env.CHANCELLOR_MANAGER_TIMEOUT_MS = "30000";
		let fauxResult: TicketResult | null = null;
		let fauxError = "";
		try {
			const { runChancellor } = await import("../../../packages/chancellor/src/index.ts");
			fauxResult = await runChancellor({
				requirement: "报个平安",
				domain: DOMAIN,
				managerIdentity: identity,
				workRoot: phase.workRoot,
			});
		} catch (error) {
			fauxError = error instanceof Error ? error.message : String(error);
		}
		check(
			"chancellor faux domain 派单（带 managerIdentity）整链不报错",
			fauxResult !== null && !!fauxResult.ticketId,
			fauxResult
				? `ticketId=${fauxResult.ticketId} status=${fauxResult.status} line=${fauxResult.line.slice(0, 40)}`
				: `error=${fauxError.slice(0, 200)}`,
		);
		let metaAfter: any = null;
		try {
			metaAfter = JSON.parse(readFileSync(metaPath, "utf8"));
		} catch {
			/* 下面断言会报 */
		}
		check(
			"chancellor 自己的 ensureManager 不冲掉宿主写入的 partner_id",
			metaAfter?.partner_id === id,
			`partner_id=${metaAfter?.partner_id}`,
		);

		// ── 4. 删执事 → 归档 ──
		// 先造一点工单历史，验证「不物理删」。
		const runsDir = join(phase.managers, DOMAIN, "runs");
		writeFileSync(join(runsDir, "probe-ticket.json"), "{\"probe\":true}");
		const removed = await api("DELETE", `/api/v1/partners/${id}`, null);
		check("DELETE /api/v1/partners/:id → 200", removed.status === 200, `status=${removed.status}`);

		check(
			"原领域目录已不在 managers/finance",
			!existsSync(join(phase.managers, DOMAIN)),
		);
		const archivedDirs = existsSync(phase.managers)
			? readdirSync(phase.managers).filter((name) => name.startsWith(`.archived-${DOMAIN}-`))
			: [];
		check(
			"目录改名成 .archived- 前缀（不是物理删）",
			archivedDirs.length === 1,
			`archivedDirs=${JSON.stringify(archivedDirs)}`,
		);
		check(
			"归档目录里 runs 工单历史保留",
			archivedDirs.length === 1 &&
				existsSync(join(phase.managers, archivedDirs[0]!, "runs", "probe-ticket.json")),
		);
		check(
			"listManagers 不再列出该领域",
			!listManagers(phase.workRoot).some((e) => e.domain === DOMAIN),
			`domains=${JSON.stringify(listManagers(phase.workRoot).map((e) => e.domain))}`,
		);
		check("普通执事仍在（删执事不影响它）", (await api("GET", `/api/v1/partners/${plain.body?.partner?.id}`, null)).status === 200);
		check("服务日志无未捕获异常 / 建执事失败", logsClean(phase));
	} finally {
		await stopServer(phase);
	}
	console.log(failed === 0 ? "\n✓ D2 执事探针全部通过" : `\n✗ D2 探针有 ${failed} 项失败`);
}

main().catch((error) => {
	console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
