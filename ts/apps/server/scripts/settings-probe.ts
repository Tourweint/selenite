/**
 * 批次六探针：设置页「项目」分区 + 全局审批待办（2026-11-04）。
 *
 * 两段各自真起服务、真 HTTP：
 *   A. 项目端到端：临时工作区 → 提案 202 → 确认建目录 / 拒绝不建 → 校验矩阵 → 重启仍在；
 *      确认路由按统一后的 `/projects/:id/confirm|reject` 断言（接口文档 §2.7 已勘误）。
 *   B. 全局审批：两个会话**同时**挂一条 pending（不串行 await 第一条流），
 *      断言无参 GET 两条带对外 uuid + 标题、带参 GET 原语义、空串按全局、未知 uuid 404、
 *      deviceToken 可用、隐藏会话仍出现、任务会话无审批、批准一条拒绝一条后清零、未配 LLM 503。
 *
 * 卫生：所有落点都在 `.data/probe-settings-*`，工作区在系统临时目录，跑完即删；
 * 不碰真实 `.data`、不写 providers.json（faux 不播种，仍显式隔离路径）。
 *
 *   pnpm --filter @lifediary/server settings
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8108);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "probe-settings-token";

const DB = ".data/probe-settings.sqlite";
const APPROVALS = ".data/probe-settings-approvals.json";
const CHAT_META = ".data/probe-settings-chat-meta.json";
const POLICY = ".data/probe-settings-policy.json";
const PROJECTS_DB = ".data/probe-settings-projects.sqlite";
const PAIRING = ".data/probe-settings-pairing.json";
const PROVIDERS = ".data/probe-settings-providers.json";
const RUNTIME = ".data/probe-settings-runtime.json";

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
		AGENT_DB_PATH: DB,
		MEMORY_ENABLED: "false",
		AGENT_APPROVALS_PATH: APPROVALS,
		AGENT_CHAT_META_PATH: CHAT_META,
		AGENT_POLICY_PATH: POLICY,
		PROJECTS_DB_PATH: PROJECTS_DB,
		PAIRING_STORE_PATH: PAIRING,
		PROVIDERS_PATH: PROVIDERS,
		MODEL_RUNTIME_PATH: RUNTIME,
		CHANCELLOR_ENABLED: "false",
		// faux 每次都发 bash 工具调用，保证一轮里能挂住审批
		LLM_FAUX_TOOL: "bash",
		AGENT_CONFIRM_WRITES: "1",
		AGENT_APPROVAL_TIMEOUT_S: "60",
		AGENT_BASH_TIMEOUT_S: "900",
		AGENT_TOOL_POLICY: "full",
		AGENT_MAX_TURNS: "100",
		NODE_OPTIONS: "",
		...extra,
	};
}

function startServer(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: baseEnv(extraEnv),
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [server] ${text}`);
	});
	return child;
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

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...init,
		headers: authHeaders({
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers as Record<string, string> | undefined),
		}),
	});
}

async function apiJson(
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await api(path, init);
	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		/* 空体 / 非 JSON：留空对象，断言自然看出 */
	}
	return { status: response.status, body };
}

// ── 聊天的 SSE 读取（照 approval-probe）────────────────────
type SseEvent = { type: string; [key: string]: unknown };

interface ApprovalEvent extends SseEvent {
	type: "approval";
	callId: string;
	tool: string;
	args: string;
	deadlineAt: string;
}

class ChatStream {
	readonly events: SseEvent[] = [];
	conversationId?: string;
	private cursor = 0;
	private finished = false;
	private readonly waiters = new Set<() => void>();
	private readonly controller = new AbortController();

	constructor(text: string) {
		void this.pump(text);
	}

	async next<T extends SseEvent>(
		predicate: (event: SseEvent) => boolean,
		timeoutMs = 10_000,
	): Promise<T | null> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			while (this.cursor < this.events.length) {
				const event = this.events[this.cursor];
				this.cursor += 1;
				if (event && predicate(event)) return event as T;
			}
			const left = deadline - Date.now();
			if (left <= 0 || this.finished) return null;
			await Promise.race([this.changed(), sleep(left)]);
		}
	}

	abort(): void {
		this.controller.abort();
	}

	private changed(): Promise<void> {
		return new Promise((resolve) => this.waiters.add(resolve));
	}

	private push(event: SseEvent): void {
		if (event.type === "start" && typeof event.conversationId === "string") {
			this.conversationId = event.conversationId;
		}
		this.events.push(event);
		for (const wake of this.waiters) wake();
		this.waiters.clear();
	}

	private async pump(text: string): Promise<void> {
		try {
			const response = await fetch(`${BASE}/api/v1/agent/chat`, {
				method: "POST",
				headers: authHeaders({ "content-type": "application/json" }),
				body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
				signal: this.controller.signal,
			});
			if (!response.ok || !response.body) return;
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += value;
				let index = buffer.indexOf("\n\n");
				while (index >= 0) {
					const chunk = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					for (const line of chunk.split("\n")) {
						if (!line.startsWith("data:")) continue;
						try {
							this.push(JSON.parse(line.slice(5).trim()) as SseEvent);
						} catch {
							/* 畸形帧忽略 */
						}
					}
					index = buffer.indexOf("\n\n");
				}
			}
		} catch {
			/* 主动 abort / 断线都当流结束 */
		} finally {
			this.finished = true;
			for (const wake of this.waiters) wake();
			this.waiters.clear();
		}
	}
}

async function stop(conversationId: string): Promise<void> {
	await api(`/api/v1/agent/chat/${encodeURIComponent(conversationId)}/stop`, { method: "POST" }).catch(
		() => undefined,
	);
}

interface GlobalApproval {
	conversationId: string;
	chatTitle?: string;
	callId: string;
	tool: string;
	args: string;
	deadlineAt: string;
	createdAt: number;
	/** E2 #0：自主轮标记纯增量透出，普通轮不带键 */
	origin?: "autonomous";
}

async function globalApprovals(): Promise<{ status: number; approvals: GlobalApproval[]; limit?: number }> {
	const { status, body } = await apiJson("/api/v1/agent/approvals");
	return {
		status,
		approvals: Array.isArray(body.approvals) ? (body.approvals as GlobalApproval[]) : [],
		limit: typeof body.limit === "number" ? body.limit : undefined,
	};
}

async function perChatApprovals(conversationId: string): Promise<Record<string, unknown>[]> {
	const { body } = await apiJson(
		`/api/v1/agent/approvals?conversationId=${encodeURIComponent(conversationId)}`,
	);
	return Array.isArray(body.approvals) ? (body.approvals as Record<string, unknown>[]) : [];
}

async function decide(callId: string, decision: "approve" | "reject"): Promise<number> {
	const { status } = await apiJson(`/api/v1/agent/approvals/${encodeURIComponent(callId)}`, {
		method: "POST",
		body: JSON.stringify({ decision }),
	});
	return status;
}

// ── 清理与启动 ───────────────────────────────────────────
const WORKSPACE = mkdtempSync(join(tmpdir(), "lifediary-settings-ws-"));

for (const path of [DB, `${DB}-wal`, `${DB}-shm`, APPROVALS, CHAT_META, POLICY, PROJECTS_DB, PAIRING, PROVIDERS, RUNTIME]) {
	rmSync(path, { force: true });
}

let server = startServer();

try {
	await waitForReady();

	// ══════════════════════════════════════════════════════
	// A. 项目端到端
	// ══════════════════════════════════════════════════════
	console.log("\n· A1. 未设工作区 → 提案被拒；设定后 202 提案不建目录");
	let result = await apiJson("/api/v1/projects", {
		method: "POST",
		body: JSON.stringify({ name: "demo", path: "demo" }),
	});
	check(result.status === 400 && result.body.error === "no_workspace", "未设工作区 → no_workspace", JSON.stringify(result));

	result = await apiJson("/api/v1/workspaces", {
		method: "POST",
		body: JSON.stringify({ rootPath: WORKSPACE }),
	});
	check(result.status === 200 && Boolean(result.body.workspace), "设定临时工作区", WORKSPACE);

	result = await apiJson("/api/v1/projects", {
		method: "POST",
		body: JSON.stringify({ name: "demo", path: "demo" }),
	});
	const demoProposal = result.body.proposal as { id?: string; relativePath?: string; status?: string } | undefined;
	check(result.status === 202 && demoProposal?.status === "pending", "新建项目返回 202 提案", JSON.stringify(result.body));
	check(!existsSync(join(WORKSPACE, "demo")), "提案阶段不建目录");

	// ── A2. 校验矩阵 ──
	const cases: { label: string; name: string; path: string; error: string }[] = [
		{ label: "绝对路径", name: "absolute", path: join(WORKSPACE, "absolute"), error: "bad_path" },
		{ label: "含 ..", name: "escape", path: "../outside", error: "outside_workspace" },
	];
	for (const item of cases) {
		const response = await apiJson("/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: item.name, path: item.path }),
		});
		check(
			response.status === 400 && response.body.error === item.error,
			`${item.label} → ${item.error}`,
			JSON.stringify(response.body),
		);
	}

	// ── A3. 确认：建目录 + 登记（路由是 /projects/:id/confirm）──
	result = await apiJson(`/api/v1/projects/${encodeURIComponent(demoProposal!.id!)}/confirm`, {
		method: "POST",
	});
	const demoProject = result.body.project as
		| { id?: string; name?: string; rootPath?: string; vcs?: string; head?: unknown }
		| undefined;
	check(result.status === 200 && demoProject?.name === "demo", "确认提案 → 登记项目", JSON.stringify(result.body));
	check(existsSync(join(WORKSPACE, "demo")), "确认之后目录才建出来");
	check(demoProject?.vcs === "none" && demoProject?.head === null, "vcs/head 记录正确", JSON.stringify(demoProject));

	result = await apiJson("/api/v1/projects");
	const projects = (result.body.projects ?? []) as {
		name: string;
		rootPath: string;
		exists: boolean;
		insideWorkspace: boolean;
	}[];
	check(
		projects.some(
			(project) =>
				project.name === "demo" && project.exists === true && project.insideWorkspace === true,
		),
		"GET /projects 出现且 exists/insideWorkspace 为真",
		JSON.stringify(projects),
	);

	// 已确认的不能再确认
	result = await apiJson(`/api/v1/projects/${encodeURIComponent(demoProposal!.id!)}/confirm`, {
		method: "POST",
	});
	check(result.status === 409 && result.body.error === "already_decided", "重复确认 → 409", JSON.stringify(result.body));

	// 工作区内、但已经是项目子目录
	result = await apiJson("/api/v1/projects", {
		method: "POST",
		body: JSON.stringify({ name: "child", path: "demo/sub" }),
	});
	check(
		result.status === 400 && result.body.error === "inside_existing_project",
		"项目内子目录 → inside_existing_project",
		JSON.stringify(result.body),
	);

	// 项目名重复
	result = await apiJson("/api/v1/projects", {
		method: "POST",
		body: JSON.stringify({ name: "demo", path: "other" }),
	});
	check(result.status === 400 && result.body.error === "duplicate_project", "项目名重复 → duplicate_project", JSON.stringify(result.body));

	// ── A4. 拒绝流：不建目录、状态进 rejected ──
	result = await apiJson("/api/v1/projects", {
		method: "POST",
		body: JSON.stringify({ name: "later", path: "later" }),
	});
	const laterProposal = result.body.proposal as { id?: string } | undefined;
	const rejected = await apiJson(`/api/v1/projects/${encodeURIComponent(laterProposal!.id!)}/reject`, {
		method: "POST",
	});
	check(rejected.status === 200, "拒绝提案成功", JSON.stringify(rejected.body));
	check(!existsSync(join(WORKSPACE, "later")), "拒绝后不建目录");
	const rejectedList = await apiJson("/api/v1/projects/proposals?status=rejected");
	check(
		((rejectedList.body.proposals ?? []) as { id?: string }[]).some(
			(proposal) => proposal.id === laterProposal?.id,
		),
		"拒绝的提案出现在 rejected 列表",
		JSON.stringify(rejectedList.body),
	);

	// ── A5. 重启：登记仍在 ──
	server.kill();
	await sleep(700);
	server = startServer();
	await waitForReady();
	result = await apiJson("/api/v1/projects");
	const afterRestart = (result.body.projects ?? []) as { name: string; exists: boolean }[];
	check(
		afterRestart.some((project) => project.name === "demo" && project.exists),
		"重启后项目仍在且 exists=true",
		JSON.stringify(afterRestart),
	);

	// ══════════════════════════════════════════════════════
	// B. 全局审批待办
	// ══════════════════════════════════════════════════════
	console.log("\n· B1. 两个会话同时挂审批（并行，不串行 await 第一条流）");
	const first = new ChatStream("跑个命令 A");
	const second = new ChatStream("跑个命令 B");
	const [startA, startB] = await Promise.all([
		first.next((event) => event.type === "start"),
		second.next((event) => event.type === "start"),
	]);
	check(Boolean(startA && startB), "两个会话都建立");
	const [approvalA, approvalB] = await Promise.all([
		first.next<ApprovalEvent>((event) => event.type === "approval", 15_000),
		second.next<ApprovalEvent>((event) => event.type === "approval", 15_000),
	]);
	check(Boolean(approvalA && approvalB), "两条会话各自挂住一条审批");

	// 改名一条；另一条保持无标题
	const rename = await apiJson(
		`/api/v1/agent/chat/${encodeURIComponent(first.conversationId!)}/rename`,
		{ method: "POST", body: JSON.stringify({ title: "探针改名会话" }) },
	);
	check(rename.status === 200, "改名接口可用", JSON.stringify(rename.body));

	// 隐藏另一条：全局待办仍应出现（隐藏只管列表，不删会话）
	const hide = await apiJson(
		`/api/v1/agent/chat/${encodeURIComponent(second.conversationId!)}/hide`,
		{ method: "POST" },
	);
	check(hide.status === 200, "隐藏第二个会话", JSON.stringify(hide.body));

	// ── B2. 无参 GET = 全局 ──
	const global = await globalApprovals();
	check(global.status === 200 && global.limit === 50, "无参 GET 200 且 limit=50", `limit=${global.limit}`);
	check(global.approvals.length === 2, "返回两条（跨会话）", String(global.approvals.length));
	const byCallId = new Map(global.approvals.map((item) => [item.callId, item]));
	check(
		Boolean(byCallId.get(approvalA!.callId) && byCallId.get(approvalB!.callId)),
		"两条 callId 都在",
		JSON.stringify(global.approvals.map((item) => item.callId)),
	);
	const titleA = byCallId.get(approvalA!.callId)?.chatTitle;
	const titleB = byCallId.get(approvalB!.callId)?.chatTitle;
	check(titleA === "探针改名会话", "改名的那条带 chatTitle", String(titleA));
	check(titleB === undefined, "未命名会话省略 chatTitle（前端显示未命名会话）", String(titleB));
	check(
		global.approvals.every((item) => item.conversationId && !/^\d+$/.test(item.conversationId)),
		"conversationId 是对外 uuid（不是内部整数）",
		JSON.stringify(global.approvals.map((item) => item.conversationId)),
	);
	check(
		global.approvals.some((item) => item.conversationId === second.conversationId),
		"隐藏会话仍出现在全局待办",
	);
	check(
		global.approvals.every((item) => !item.conversationId.startsWith("task-")),
		"任务会话不出现在待办（天然无工具）",
	);
	// E2 #0：普通轮（非自主轮）的投影不带 origin 键 —— "undefined 不带键"
	check(
		global.approvals.every((item) => !("origin" in item)),
		"普通轮全局待办不带 origin 键",
		JSON.stringify(global.approvals.map((item) => item.origin)),
	);

	// ── B3. 空串按全局；带参是原语义；未知 uuid 404 ──
	const emptyParam = await apiJson("/api/v1/agent/approvals?conversationId=");
	check(
		emptyParam.status === 200 && ((emptyParam.body.approvals ?? []) as unknown[]).length === 2,
		"conversationId= 空串按全局处理",
		JSON.stringify(emptyParam.body),
	);
	const perChat = await perChatApprovals(first.conversationId!);
	check(
		perChat.length === 1 && perChat[0]?.callId === approvalA!.callId,
		"带参 GET 仍是原语义（只回该会话）",
		JSON.stringify(perChat),
	);
	check(
		perChat[0] &&
			// 2026-11-08 批三：按会话投影也带对外 conversationId（前端给审批卡标「来自 …」）
			perChat[0].conversationId === first.conversationId &&
			!("chatTitle" in perChat[0]) &&
			!("origin" in perChat[0]),
		"带参 GET 不塞全局走查字段、普通轮不带 origin（只多 conversationId）",
		JSON.stringify(perChat[0]),
	);
	const unknown = await apiJson("/api/v1/agent/approvals?conversationId=00000000-0000-4000-8000-000000000000");
	check(unknown.status === 404 && unknown.body.error === "unknown_conversation", "未知 uuid → 404", JSON.stringify(unknown.body));

	// ── B4. deviceToken 也能调全局 GET ──
	const code = await apiJson("/api/v1/pair/code", { method: "POST" });
	const pairCode = String(code.body.code ?? "");
	const redeem = await fetch(`${BASE}/api/v1/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: pairCode, deviceName: "probe" }),
	});
	const redeemed = (await redeem.json()) as { deviceToken?: string };
	const deviceToken = redeemed.deviceToken ?? "";
	check(Boolean(deviceToken), "配对换到 deviceToken");
	const withDevice = await fetch(`${BASE}/api/v1/agent/approvals`, {
		headers: { Authorization: `Bearer ${deviceToken}` },
	});
	const deviceBody = (await withDevice.json()) as { approvals?: unknown[] };
	check(
		withDevice.status === 200 && (deviceBody.approvals ?? []).length === 2,
		"deviceToken 调 GET /approvals 可用（不只 loopback cookie）",
		`HTTP ${withDevice.status}`,
	);

	// ── B5. 批准一条、拒绝一条 → 清零 ──
	check((await decide(approvalA!.callId, "approve")) === 200, "批准 A");
	check((await decide(approvalB!.callId, "reject")) === 200, "拒绝 B");
	// faux 会一直发起下一次工具调用；停掉两条，别让新审批补位
	await Promise.all([stop(first.conversationId!), stop(second.conversationId!)]);
	first.abort();
	second.abort();
	let cleared = await globalApprovals();
	for (let attempt = 0; attempt < 10 && cleared.approvals.length > 0; attempt += 1) {
		await Promise.all([stop(first.conversationId!), stop(second.conversationId!)]);
		await sleep(200);
		cleared = await globalApprovals();
	}
	check(cleared.approvals.length === 0, "批准一条 + 拒绝一条后全局清零", String(cleared.approvals.length));

	// ── B6. 未配 LLM → 503 ──
	server.kill();
	await sleep(700);
	server = startServer({ LLM_PROVIDER: "", LLM_API_KEY: "", PROVIDERS_CONFIG: "false" });
	await waitForReady();
	const noLlm = await apiJson("/api/v1/agent/approvals");
	check(noLlm.status === 503, "未配 LLM → GET /approvals 503", `HTTP ${noLlm.status} ${JSON.stringify(noLlm.body)}`);
} finally {
	server.kill();
	await sleep(300);
	for (const path of [
		DB,
		`${DB}-wal`,
		`${DB}-shm`,
		APPROVALS,
		CHAT_META,
		POLICY,
		PROJECTS_DB,
		PAIRING,
		PROVIDERS,
		RUNTIME,
	]) {
		rmSync(path, { force: true });
	}
	rmSync(WORKSPACE, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✓ 批次六探针全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
