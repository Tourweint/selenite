import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 总管身份化探针（批次D D1）：真起服务 + 真 HTTP + faux 固定应答。
 *
 * 覆盖（任务书 §4）：
 *   阶段一（默认 CHIEF_PARTNER 开）：起服务 → 首轮对话（faux 真链路）→ 断言
 *     · 服务日志不报错、无播种失败；
 *     · SOUL 文件已生成且正文 = 旧 PERSONA 原文（行为零变化）；
 *     · GET /api/v1/partners 列表里有 chief（含 v1 快照）；
 *     · 首轮对话有 done、无 error、文本含 faux 固定应答。
 *   阶段二（CHIEF_PARTNER=false 回滚）：不生成 SOUL、列表无 chief、首轮对话照常（PERSONA 常量直读）。
 *
 *   pnpm --filter @lifediary/server chief
 */

const PORT = 8196;
const PERSONA_FIRST_LINE = "你是一个个人助手";

function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) process.exitCode = 1;
}

interface Phase {
	root: string;
	child: ChildProcess;
	logs: string[];
}

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: "Bearer probe-token" };
}

async function startServer(extraEnv: Record<string, string>): Promise<Phase> {
	const root = mkdtempSync(join(tmpdir(), "lifediary-chief-probe-"));
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
			CHANCELLOR_ENABLED: "false",
			...extraEnv,
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
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (res.ok) return { root, child: proc, logs };
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) {
			throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

async function stopServer(phase: Phase): Promise<void> {
	phase.child.kill();
	await new Promise((resolve) => setTimeout(resolve, 300));
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

/** 收一条完整 SSE 流：status / 聚合文本 / 事件类型 / conversationId。 */
async function firstChat(text: string): Promise<{
	status: number;
	text: string;
	types: string[];
	conversationId?: string;
}> {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/agent/chat`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
	});
	const raw = await res.text();
	const out = { status: res.status, text: "", types: [] as string[], conversationId: undefined as string | undefined };
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const ev = JSON.parse(line.slice(5).trim()) as {
			type: string;
			text?: string;
			message?: string;
			conversationId?: string;
		};
		out.types.push(ev.type);
		if (ev.type === "delta") out.text += ev.text ?? "";
		if (ev.type === "start") out.conversationId = ev.conversationId;
	}
	return out;
}

function logsClean(phase: Phase): boolean {
	const all = phase.logs.join("");
	return (
		!all.includes("总管播种失败") &&
		!all.includes("Uncaught") &&
		!all.includes("[chat] 打开会话失败")
	);
}

async function soulPath(root: string): Promise<string | null> {
	const path = join(root, "partner-homes", "chief", "SOUL.md");
	const deadline = Date.now() + 5_000;
	for (;;) {
		if (existsSync(path)) return path;
		if (Date.now() > deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function main(): Promise<void> {
	// ── 阶段一：总管开启（默认）──
	const on = await startServer({ CHIEF_PARTNER: "true" });
	try {
		const soul = await soulPath(on.root);
		check("SOUL 文件已生成（partner-homes/chief/SOUL.md）", soul !== null, soul ?? "未生成");
		if (soul) {
			const content = readFileSync(soul, "utf8");
			check(
				"SOUL 正文 = 旧 PERSONA 原文（行为零变化）",
				content.startsWith(PERSONA_FIRST_LINE) &&
					content.includes("说话直接、克制、就事论事") &&
					!content.startsWith("# 总管"),
				`前 30 字=${content.slice(0, 30)}`,
			);
		}

		const chat = await firstChat("报个平安");
		check(
			"首轮对话：200 + done + 无 error + faux 固定应答（真链路不报错）",
			chat.status === 200 &&
				chat.types.includes("done") &&
				!chat.types.includes("error") &&
				chat.text.includes("faux"),
			`status=${chat.status} events=${chat.types.join(",")} text=${chat.text.slice(0, 30)}`,
		);

		const list = await api("GET", "/api/v1/partners", null);
		const chief = (list.body?.partners ?? []).find(
			(p: any) => p.id === "chief" || p.name === "总管",
		);
		check(
			"GET /api/v1/partners 列表里有 chief",
			list.status === 200 && !!chief,
			`status=${list.status} partners=${JSON.stringify(list.body?.partners ?? []).slice(0, 120)}`,
		);
		check("chief 身份计数 = 1（2026-11-15 快照退役，计数是记账位）", chief?.soulVersion === 1, `soulVersion=${chief?.soulVersion}`);

		const detail = await api("GET", "/api/v1/partners/chief", null);
		check(
			"GET /api/v1/partners/chief：SOUL 当前值 = PERSONA 原文",
			detail.status === 200 && String(detail.body?.soul ?? "").startsWith(PERSONA_FIRST_LINE),
			`status=${detail.status}`,
		);

		check("服务日志无播种失败 / 未捕获异常 / 打开会话失败", logsClean(on));
	} finally {
		await stopServer(on);
	}

	// ── 阶段二：CHIEF_PARTNER=false 回滚 ──
	const off = await startServer({ CHIEF_PARTNER: "false" });
	try {
		const soul = await soulPath(off.root);
		check("回滚：不生成 SOUL 文件（回到改动前）", soul === null, soul ?? "未生成");

		const list = await api("GET", "/api/v1/partners", null);
		const hasChief = (list.body?.partners ?? []).some(
			(p: any) => p.id === "chief" || p.name === "总管",
		);
		check("回滚：列表里没有 chief（不播种）", list.status === 200 && !hasChief, `partners=${JSON.stringify(list.body?.partners ?? []).slice(0, 80)}`);

		const chat = await firstChat("报个平安");
		check(
			"回滚：首轮对话照常（PERSONA 常量直读，faux 应答）",
			chat.status === 200 && chat.types.includes("done") && chat.text.includes("faux"),
			`status=${chat.status} events=${chat.types.join(",")}`,
		);
		check("回滚：服务日志不报错", logsClean(off));
	} finally {
		await stopServer(off);
	}
}

main()
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
