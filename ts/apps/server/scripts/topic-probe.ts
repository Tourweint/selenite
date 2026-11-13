import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 长期课题跟进探针（2026-11-07 批次一）：真起服务 + 真 HTTP。
 *
 * 覆盖：
 *   1. TOPICS_ENABLED=false → 课题路由 404（回滚开关）
 *   2. 确认提议 → 建 active 课题 + durable 排上（accept 200 且 nextFireAt 非空）
 *   3. run_now → 研究回合跑完（faux）→ finding 落库 + pendingPush
 *   4. 感知推送：主对话来一条用户消息 → 简报注入一次；再来一条 → 不再注入
 *   5. 串联：改 cron → 暂停 → 恢复 → 关闭 → 列表状态
 *   6. 上限 / 查重：5 个 active 后 accept → topic_limit；同题 accept → exists
 *   7. 未配搜索：accept → 400 search_not_configured
 *
 * 提议没有 HTTP 入口（只来自 propose_topic 工具），所以这里**直接写 topics.json**
 * 造 pending 提议；存储层语义由 src/topics.test.ts 覆盖。
 *
 *   pnpm --filter @lifediary/server topic
 */

const PORT = 8197;
const ROOT = mkdtempSync(join(tmpdir(), "lifediary-topic-probe-"));
const CRON_WEEKLY = "0 9 * * 1";

function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) process.exitCode = 1;
}

// ── 假的搜索上游（随机端口，固定 3 条）────────────────────
async function startSearchStub(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/tools/search") {
			res.statusCode = 404;
			res.end();
			return;
		}
		req.resume();
		req.on("end", () => {
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({
					results: [
						{ title: "探针结果一", url: "https://example.com/1", summary: "摘要一" },
						{ title: "探针结果二", url: "https://example.com/2", summary: "摘要二" },
						{ title: "探针结果三", url: "https://example.com/3", summary: "摘要三" },
					],
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address !== "object") throw new Error("假上游端口取不到");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

// ── 造状态文件（关服务后调用）────────────────────────────
interface SeedTopic {
	id: string;
	question: string;
}

function seedState(
	name: string,
	input: { topics?: SeedTopic[]; proposals?: Array<{ id: string; question: string }> },
): string {
	const now = new Date();
	const path = join(ROOT, `${name}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			topics: (input.topics ?? []).map((topic) => ({
				id: topic.id,
				question: topic.question,
				flavor: "watch",
				cron: CRON_WEEKLY,
				status: "active",
				revision: 1,
				origin: "user",
				findings: [],
				pendingPush: false,
				noNewStreak: 0,
				createdAt: now.toISOString(),
			})),
			proposals: (input.proposals ?? []).map((proposal) => ({
				id: proposal.id,
				question: proposal.question,
				flavor: "watch",
				cron: CRON_WEEKLY,
				origin: "user",
				status: "pending",
				createdAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + 72 * 3_600_000).toISOString(),
			})),
		}),
		"utf8",
	);
	return path;
}

async function main(): Promise<void> {
	{
		// ── 阶段一：回滚开关关闭 → 404 ─────────────────────
		{
			const statePath = seedState("off", {});
			const server = await startServer({
				statePath,
				extra: { TOPICS_ENABLED: "false" },
			});
			try {
				const res = await api("GET", "/api/v1/topics", null);
				check("开关关闭：课题路由 404（未启用语义）", res.status === 404, `status=${res.status}`);
			} finally {
				await stopServer(server);
			}
		}

		// ── 阶段二：确认 → 研究 → 推送 → 状态机 ─────────────
		{
			const proposalId = randomUUID();
			const statePath = seedState("main", {
				proposals: [{ id: proposalId, question: "探针课题：利率怎么走" }],
			});
			const server = await startServer({ statePath, extra: {} });
			try {
				const accepted = await api("POST", `/api/v1/topics/proposals/${proposalId}/accept`, null);
				check(
					"确认提议：201/200 + active 课题 + nextFireAt 已排",
					accepted.status === 200 &&
						accepted.body?.topic?.status === "active" &&
						typeof accepted.body?.topic?.nextFireAt === "string",
					`status=${accepted.status} nextFireAt=${accepted.body?.topic?.nextFireAt ?? "null"}`,
				);
				const topicId = String(accepted.body?.topic?.id ?? "");

				const list1 = await api("GET", "/api/v1/topics", null);
				check(
					"列表：1 个进行中，且不展开 finding 正文",
					list1.status === 200 &&
						list1.body?.activeCount === 1 &&
						list1.body?.topics?.[0]?.findings === undefined,
					`activeCount=${list1.body?.activeCount}`,
				);

				const runNow = await api("POST", `/api/v1/topics/${topicId}/run_now`, null);
				check(
					"run_now：faux 研究回合跑完（真链路 + 假模型）",
					runNow.status === 200 &&
						runNow.body?.run?.ok === true &&
						String(runNow.body?.run?.text ?? "").includes("faux"),
					`ok=${runNow.body?.run?.ok}`,
				);

				const detail1 = await api("GET", `/api/v1/topics/${topicId}`, null);
				const finding = detail1.body?.topic?.findings?.[0];
				check(
					"研究产出：finding 落库 + pendingPush + noNewStreak 按输出解析",
					detail1.status === 200 &&
						detail1.body?.topic?.findings?.length === 1 &&
						detail1.body?.topic?.pendingPush === true &&
						detail1.body?.topic?.noNewStreak === 0 &&
						typeof finding?.summary === "string",
					`summary=${String(finding?.summary ?? "").slice(0, 24)}`,
				);

				// 感知推送：第一次活跃报一次，第二次不再报
				const before = pushLogCount();
				const chat1 = await chat("早");
				const afterFirst = pushLogCount();
				check(
					"感知推送：主对话第一次活跃带简报",
					chat1.status === 200 && afterFirst === before + 1,
					`简报次数 ${before}→${afterFirst}`,
				);
				const detail2 = await api("GET", `/api/v1/topics/${topicId}`, null);
				check("感知推送：注入即标记已推送（pendingPush=false）", detail2.body?.topic?.pendingPush === false);

				const chat2 = await chat("再说一句");
				const afterSecond = pushLogCount();
				check(
					"感知推送：第二次活跃不再报（markPushed 生效）",
					chat2.status === 200 && afterSecond === afterFirst,
					`简报次数 ${afterFirst}→${afterSecond}`,
				);

				const patched = await api("PATCH", `/api/v1/topics/${topicId}`, { cron: "0 8 * * 3" });
				check(
					"改节奏：cron 更新 + revision +1",
					patched.status === 200 &&
						patched.body?.topic?.cron === "0 8 * * 3" &&
						patched.body?.topic?.revision === 2,
					`revision=${patched.body?.topic?.revision}`,
				);

				const paused = await api("PATCH", `/api/v1/topics/${topicId}`, { status: "paused" });
				check("暂停：status=paused", paused.status === 200 && paused.body?.topic?.status === "paused");
				const resumed = await api("PATCH", `/api/v1/topics/${topicId}`, { status: "active" });
				check("恢复：status=active 且重排", resumed.status === 200 && resumed.body?.topic?.status === "active");

				const closed = await api("POST", `/api/v1/topics/${topicId}/close`, { reason: "探针收尾" });
				check(
					"关闭：closed + 留原因",
					closed.status === 200 &&
						closed.body?.topic?.status === "closed" &&
						closed.body?.topic?.closeReason === "探针收尾",
				);
				const list2 = await api("GET", "/api/v1/topics", null);
				check(
					"列表：关闭后 activeCount=0",
					list2.status === 200 && list2.body?.activeCount === 0,
					`activeCount=${list2.body?.activeCount}`,
				);
			} finally {
				await stopServer(server);
			}
		}

		// ── 阶段三：上限 / 查重 ─────────────────────────────
		{
			const dup = randomUUID();
			const sixth = randomUUID();
			const statePath = seedState("limit", {
				topics: Array.from({ length: 5 }, (_, index) => ({
					id: randomUUID(),
					question: `已有课题 ${index + 1}`,
				})),
				proposals: [
					{ id: dup, question: "已有课题 1" },
					{ id: sixth, question: "第六个课题" },
				],
			});
			const server = await startServer({ statePath, extra: {} });
			try {
				const dupRes = await api("POST", `/api/v1/topics/proposals/${dup}/accept`, null);
				check(
					"查重：同题确认 400 exists（带已有课题）",
					dupRes.status === 400 &&
						dupRes.body?.error === "exists" &&
						typeof dupRes.body?.existingTopicId === "string",
					`error=${dupRes.body?.error}`,
				);
				const limitRes = await api("POST", `/api/v1/topics/proposals/${sixth}/accept`, null);
				check(
					"上限：第 6 个确认 400 topic_limit",
					limitRes.status === 400 && limitRes.body?.error === "topic_limit",
					`error=${limitRes.body?.error}`,
				);
			} finally {
				await stopServer(server);
			}
		}

		// ── 阶段四：未配搜索 → 拒绝 ─────────────────────────
		{
			const proposalId = randomUUID();
			const statePath = seedState("no-search", {
				proposals: [{ id: proposalId, question: "没搜索也想开工" }],
			});
			const server = await startServer({
				statePath,
				extra: { DEEPSEEK_SEARCH_API_KEY: "" },
			});
			try {
				const res = await api("POST", `/api/v1/topics/proposals/${proposalId}/accept`, null);
				check(
					"搜索未配置：确认 400 search_not_configured",
					res.status === 400 && res.body?.error === "search_not_configured",
					`error=${res.body?.error}`,
				);
			} finally {
				await stopServer(server);
			}
		}
	}
}

// ── 起服务 / 请求辅助（companion-probe 同款骨架）────────────
let child: ReturnType<typeof spawn> | null = null;
let serverLog = "";

function pushLogCount(): number {
	return (serverLog.match(/\[topics\] 简报注入/g) ?? []).length;
}

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: "Bearer probe-token" };
}

async function startServer(input: {
	statePath: string;
	extra: Record<string, string>;
}): Promise<ReturnType<typeof spawn>> {
	serverLog = "";
	const proc = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		env: {
			...process.env,
			PORT: String(PORT),
			AGENT_TOKEN: "probe-token",
			AGENT_DB_PATH: join(ROOT, "agent.sqlite"),
			MEMORY_DB_PATH: join(ROOT, "memory.db"),
			MEMORY_ENABLED: "false",
			PROJECTS_DB_PATH: join(ROOT, "projects.sqlite"),
			PROVIDERS_PATH: join(ROOT, "providers.json"),
			PROVIDER_KEYS_PATH: join(ROOT, "provider-keys.json"),
			SEARCH_CONFIG_PATH: join(ROOT, "search.json"),
			DELEGATIONS_DB_PATH: join(ROOT, "delegations.sqlite"),
			AGENT_SSE_SEQ_DB_PATH: join(ROOT, "chat-events.sqlite"),
			AUTONOMY_ENABLED: "false", // 探针显式关（默认已于 2026-11-13 翻成开）
			AGENT_APPROVALS_PATH: join(ROOT, "approvals.json"),
			AGENT_POLICY_PATH: join(ROOT, "policy.json"),
			PARTNERS_DB_PATH: join(ROOT, "partners.sqlite"),
			PARTNER_HOMES_ROOT: join(ROOT, "partner-homes"),
			ROUTINES_STATE_PATH: join(ROOT, "routines.json"),
			AUTONOMY_STATE_PATH: join(ROOT, "autonomy-state.json"),
			CHANCELLOR_ENABLED: "false",
			LLM_PROVIDER: "faux",
			TOPICS_ENABLED: "true",
			TOPICS_STATE_PATH: input.statePath,
			SEARCH_BASE_URL: searchStubUrl,
			DEEPSEEK_SEARCH_API_KEY: "probe-key",
			...input.extra,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const capture = (prefix: string) => (chunk: Buffer) => {
		const text = String(chunk);
		serverLog += text;
		process.stdout.write(`${prefix}${text}`);
	};
	proc.stdout?.on("data", capture("  [server] "));
	proc.stderr?.on("data", capture("  [server!] "));
	child = proc;

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (res.ok) return proc;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) {
			throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

async function stopServer(proc: ReturnType<typeof spawn>): Promise<void> {
	if (child !== proc) return;
	child = null;
	proc.kill();
	await new Promise((resolve) => setTimeout(resolve, 500));
}

async function api(
	method: string,
	path: string,
	body: unknown,
): Promise<{ status: number; body: any }> {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
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

/** 发一条用户消息（全链路 SSE），等这一轮收尾。 */
async function chat(text: string): Promise<{ status: number }> {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/agent/chat`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
	});
	// 读完整个流：done 帧之后流才关闭
	await res.text();
	return { status: res.status };
}

let searchStubUrl = "";

startSearchStub()
	.then(async (stub) => {
		searchStubUrl = stub.url;
		try {
			await main();
		} finally {
			await stub.close();
		}
	})
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			rmSync(ROOT, { recursive: true, force: true });
		} catch {
			/* Windows 句柄延迟：留着下轮清 */
		}
	});
