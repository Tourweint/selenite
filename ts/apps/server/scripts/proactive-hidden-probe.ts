/**
 * 定时主动轮端到端探针（2026-11-17）。
 *
 * 真起一个隔离服务（faux 模型 + 独立库），建一个定时任务，到点后验证：
 *  - 目标执事会话里冒出一条模型回复；
 *  - 那条带 [lifediary.proactive] 标记的触发"用户消息"对客户端不可见（回读不含它）。
 * 再以 SCHEDULED_TASK_MODEL_RUN=false 重起一次，确认回到旧闹钟（写死消息、不调模型）。
 *
 *   npx tsx scripts/proactive-hidden-probe.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "proactive-probe-token";
const PFX = ".data/probe-proactive";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
}

function startServer(extraEnv: Record<string, string>): ChildProcess {
	const cleanEnv = { ...process.env };
	// 不继承开发机上可能设过的 faux 工具模式；faux 只要纯文本回复，不调工具。
	delete cleanEnv.LLM_FAUX_TOOL;
	delete cleanEnv.LLM_FAUX_ARGS;
	return spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: {
			...cleanEnv,
			PORT: String(PORT),
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_TOKEN: TOKEN,
			AGENT_DB_PATH: `${PFX}-agent.sqlite`,
			MEMORY_DB_PATH: `${PFX}-memory.db`,
			PROJECTS_DB_PATH: `${PFX}-projects.sqlite`,
			AGENT_CHAT_META_PATH: `${PFX}-chat-meta.json`,
			PROVIDERS_PATH: `${PFX}-providers.json`,
			PARTNERS_DB_PATH: `${PFX}-partners.sqlite`,
			PARTNER_HOMES_ROOT: `${PFX}-homes`,
			AGENT_FLAGS_PATH: `${PFX}-flags.json`,
			AGENT_SKILLS_STATE_PATH: `${PFX}-skill-state.json`,
			AGENT_POLICY_PATH: `${PFX}-policy.json`,
			AGENT_LOCAL_SECRET_PATH: `${PFX}-local-secret`,
			AGENT_APPROVALS_PATH: `${PFX}-approvals.json`,
			AGENT_GATE_AUDIT_PATH: `${PFX}-gate.jsonl`,
			AUTONOMY_OBSERVE_PATH: `${PFX}-autonomy.jsonl`,
			PAIRING_STORE_PATH: `${PFX}-pairing.json`,
			REMINDER_RUNS_STATE_PATH: `${PFX}-reminder-runs.json`,
			ATTACHMENTS_DIR: `${PFX}-attachments`,
			CURRENT_PROJECT: "",
			AUTONOMY_ENABLED: "false",
			NODE_OPTIONS: "",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function watchLogs(child: ChildProcess): void {
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (/\[reminder\]|\[scheduled-run\]|\[partner|error|Error|失败|warn/i.test(text)) {
			process.stderr.write(`  [server] ${text}`);
		}
	});
}

async function waitForReady(): Promise<void> {
	for (let i = 0; i < 80; i += 1) {
		try {
			const res = await fetch(`${BASE}/healthz`);
			if (res.ok) return;
		} catch {
			/* not up */
		}
		await sleep(250);
	}
	throw new Error("服务没能启动");
}

async function stopServer(child: ChildProcess): Promise<void> {
	child.kill("SIGTERM");
	await sleep(400);
	if (!child.killed) child.kill("SIGKILL");
}

function authHeaders(): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
}

interface TranscriptMessage {
	role: string;
	text: string;
	steps?: unknown[];
	workMs?: number;
}

async function readChiefTranscript(): Promise<TranscriptMessage[]> {
	// 执事主会话的外部 id 固定为 partner-<id>（partnerCanonicalExternalId），chief 即 partner-chief。
	const externalId = "partner-chief";
	const tr = (await (
		await fetch(`${BASE}/api/v1/agent/chat/${encodeURIComponent(externalId)}/messages`, {
			headers: authHeaders(),
		})
	).json()) as { messages?: TranscriptMessage[] };
	return tr.messages ?? [];
}

async function phase(
	runModel: "true" | "false",
	visibility: "hidden" | "visible" = "hidden",
): Promise<void> {
	console.log(`\n=== 相位 SCHEDULED_TASK_MODEL_RUN=${runModel} · visibility=${visibility} ===`);
	for (const suffix of [
		"-agent.sqlite", "-memory.db", "-projects.sqlite", "-chat-meta.json", "-providers.json",
		"-partners.sqlite", "-flags.json", "-skill-state.json", "-policy.json", "-local-secret",
		"-approvals.json", "-gate.jsonl", "-autonomy.jsonl", "-pairing.json", "-reminder-runs.json",
	]) {
		try {
			rmSync(`${PFX}${suffix}`, { force: true, recursive: true });
		} catch {
			/* ignore */
		}
	}
	try {
		rmSync(`${PFX}-homes`, { force: true, recursive: true });
	} catch {
		/* ignore */
	}

	const child = startServer({ SCHEDULED_TASK_MODEL_RUN: runModel });
	mainChild = child;
	watchLogs(child);
	try {
		await waitForReady();
		// 建定时任务：3 秒后触发，目标 chief
		const at = Date.now() + 3_000;
		const created = await fetch(`${BASE}/api/v1/agent/reminders`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				text: "到点自主播报：今天没什么事",
				at,
				partnerId: "chief",
				visibility,
			}),
		});
		check(created.status === 201, "定时任务创建成功", String(created.status));

		await sleep(8_000); // 等触发 + 模型跑完

		const messages = await readChiefTranscript();
		const userMessages = messages.filter((message) => message.role === "user");
		const hasTrigger = userMessages.some((message) => message.text.includes("[lifediary.proactive]"));
		const hasVisibleInstruction = userMessages.some((message) =>
			message.text.includes("到点自主播报：今天没什么事"),
		);
		const leaksHeader = userMessages.some((message) =>
			message.text.includes("[Scheduled run context]"),
		);
		const hasAssistant = messages.some((message) => message.role === "assistant" && message.text.length > 0);
		const hasFallbackWrite = messages.some(
			(message) => message.role === "assistant" && message.text.includes("到点自主播报：今天没什么事"),
		);

		if (runModel === "true") {
			if (visibility === "visible") {
				check(hasVisibleInstruction, "可见触发：用户指令留在会话里");
				check(!hasTrigger, "可见触发：不带隐藏标记");
				check(!leaksHeader, "可见触发：技术头已剥掉（回读只有用户指令）");
			} else {
				check(!hasTrigger, "隐藏触发：触发指令对用户隐藏（回读无 user 触发消息）");
			}
			check(hasAssistant, "到点冒出一条模型回复");
		} else {
			check(hasFallbackWrite, "回滚行为：到点写一条写死的提醒消息（逐字含原文）");
		}
	} finally {
		await stopServer(child);
	}
}

let mainChild: ChildProcess | null = null;
process.on("exit", () => {
	if (mainChild && !mainChild.killed) mainChild.kill("SIGKILL");
});

async function main(): Promise<void> {
	try {
		await phase("true");
		await phase("true", "visible");
		await phase("false");
	} catch (error) {
		console.error("探针异常:", error);
		failures += 1;
	}
	console.log(`\n结果：${failures === 0 ? "全通过" : `${failures} 项失败`}`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
