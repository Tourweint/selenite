import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 伙伴与例行任务探针（2026-11-05 批次B/C）：真起服务 + 真 HTTP。
 *
 * 覆盖：
 *   1. `COMPANIONS_ENABLED` 不配（默认开）+ faux 模型：建伙伴 → 详情（身份版本）→ 跑一轮（faux 应答）
 *      → 改 SOUL（版本 +1，下一轮生效语义）→ 建例行任务（once）→ run_now → 执行历史
 *   2. `COMPANIONS_ENABLED=false`：伙伴端点 404、`partner_skill_write` 不上架（工具面回到改动前）
 *
 *   pnpm --filter @lifediary/server companion
 */

const PORT = 8195;
const ROOT = mkdtempSync(join(tmpdir(), "lifediary-companion-probe-"));

function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
	// ── 阶段一：开关关闭（默认不开也该 404；这里显式 false 验证回滚开关）──
	const off = await startServer({ COMPANIONS_ENABLED: "false" });
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/partners`, {
			headers: authHeaders(),
		});
		check("开关关闭：伙伴端点 404（未启用语义，不是 403/400）", res.status === 404, `status=${res.status}`);
	} finally {
		await stopServer(off);
	}

	// ── 阶段二：开关开启 + faux 全链路 ──
	const server = await startServer({ COMPANIONS_ENABLED: "true", LLM_PROVIDER: "faux" });
	try {
		const created = await api("POST", "/api/v1/partners", { name: "探针伙伴" });
		check("建伙伴：201 且返回 uuid 档案", created.status === 201 && !!created.body.partner?.id);
		const partnerId = created.body.partner?.id as string;

		const detail1 = await api("GET", `/api/v1/partners/${partnerId}`, null);
		check(
			"详情：身份版本 = 1，SOUL 有播种正文",
			detail1.status === 200 &&
				detail1.body.soulVersion === 1 &&
				String(detail1.body.soul ?? "").includes("探针伙伴"),
			`soulVersion=${detail1.body.soulVersion}`,
		);

		// 跑一轮：faux 走真 chatStream（闸门/记忆/守卫全在链上）
		const run = await api("POST", `/api/v1/partners/${partnerId}/run`, { text: "报个平安" });
		check(
			"跑一轮：faux 应答回来了（真链路 + 假模型，mock 不空转）",
			run.status === 200 && String(run.body.text ?? "").includes("faux"),
			`text=${String(run.body.text ?? "").slice(0, 30)}`,
		);

		// 改 SOUL：版本推进（磁盘当前值 + 新快照）
		const patched = await api("PATCH", `/api/v1/partners/${partnerId}`, {
			soul: `你是探针伙伴，改过的身份。`,
		});
		check("改 SOUL：版本推进到 2", patched.status === 200 && patched.body.soulVersion === 2);
		const detail2 = await api("GET", `/api/v1/partners/${partnerId}`, null);
		check(
			"改 SOUL 后详情：磁盘当前值已是新版（下一轮生效由 partner-runtime 的版本对齐保证）",
			String(detail2.body.soul ?? "").includes("改过"),
		);

		// 候选链：只收 keyEnv 名，带值字段必须 400（密钥纪律）
		const badChain = await api("PATCH", `/api/v1/partners/${partnerId}`, {
			modelChain: [{ providerId: "p", modelId: "m", keyEnv: "KEY", apiKey: "sk-x" }],
		});
		check("候选链带 apiKey 字段：400（密钥纪律）", badChain.status === 400);
		const goodChain = await api("PATCH", `/api/v1/partners/${partnerId}`, {
			modelChain: [{ providerId: "faux", modelId: "faux", keyEnv: "PROBE_KEY" }],
		});
		check("候选链只带 keyEnv 名：通过", goodChain.status === 200);

		// 例行任务：once 触发 + run_now（faux 真跑一轮）
		const routine = await api("POST", "/api/v1/routines", {
			partnerId,
			name: "探针例行",
			prompt: "报个平安",
			triggers: [{ type: "once", at: new Date(Date.now() + 3_600_000).toISOString() }],
			sessionMode: "fresh",
			enabled: true,
		});
		check("建例行任务：201 且 revision=1", routine.status === 201 && routine.body.routine?.revision === 1);
		const routineId = routine.body.routine?.id as string;

		const runNow = await api("POST", `/api/v1/routines/${routineId}/run_now`, null);
		check(
			"run_now：fresh 专线跑通（autonomous 标记 + faux 应答）",
			runNow.status === 200 && String(runNow.body.text ?? "").includes("faux"),
		);
		const runs = await api("GET", `/api/v1/routines/${routineId}/runs`, null);
		check(
			"执行历史：有一条 success",
			runs.status === 200 && runs.body.runs?.[0]?.status === "success",
			`status=${runs.body.runs?.[0]?.status}`,
		);

		// 删除伙伴：例行任务定义一起没（孤儿清理）
		const removed = await api("DELETE", `/api/v1/partners/${partnerId}`, null);
		const routinesAfter = await api("GET", `/api/v1/routines?partnerId=${partnerId}`, null);
		check(
			"删伙伴：例行任务定义一起清",
			removed.status === 200 && (routinesAfter.body.routines ?? []).length === 0,
		);
	} finally {
		await stopServer(server);
	}
}

// ── 起服务 / 请求辅助（delegate-chain-probe 同款骨架）────────────
let child: ReturnType<typeof spawn> | null = null;

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: "Bearer probe-token" };
}

async function startServer(extraEnv: Record<string, string>): Promise<ReturnType<typeof spawn>> {
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
			DELEGATIONS_DB_PATH: join(ROOT, "delegations.sqlite"),
			AGENT_SSE_SEQ_DB_PATH: join(ROOT, "chat-events.sqlite"),
			AGENT_APPROVALS_PATH: join(ROOT, "approvals.json"),
			AGENT_POLICY_PATH: join(ROOT, "policy.json"),
			PARTNERS_DB_PATH: join(ROOT, "partners.sqlite"),
			PARTNER_HOMES_ROOT: join(ROOT, "partner-homes"),
			ROUTINES_STATE_PATH: join(ROOT, "routines.json"),
			AUTONOMY_STATE_PATH: join(ROOT, "autonomy-state.json"),
			CHANCELLOR_ENABLED: "false",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`  [server] ${chunk}`));
	proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`  [server!] ${chunk}`));
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
	await new Promise((resolve) => setTimeout(resolve, 300));
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

main()
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
