/**
 * 端到端探针：真起一个服务进程，用假模型（LLM_PROVIDER=faux）跑完整链路。
 *
 * 和 durable-probe 的分工：
 *   durable-probe  验 pi-durable 的 API 语义（提交/流式/闸门/睡眠/重启）
 *   这个           验我们自己的装配（路由、会话映射、记忆、用量、提醒接口）
 *
 * 全程走 HTTP，不碰内部函数；跑完把临时库删掉。
 *
 *   pnpm --filter @lifediary/server http
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8098);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = ".data/probe-http.sqlite";
const MEMORY_DB = ".data/probe-http-memory.db";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function startServer(): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: {
			...process.env,
			PORT: String(PORT),
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			AGENT_TOKEN: "",
			AGENT_DB_PATH: DB,
			MEMORY_DB_PATH: MEMORY_DB,
			NODE_OPTIONS: "",
		},
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

interface ChatResult {
	conversationId?: string;
	text: string;
	events: string[];
	done: boolean;
}

async function chat(body: unknown): Promise<{ status: number; result: ChatResult }> {
	const response = await fetch(`${BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status !== 200) return { status: response.status, result: { text: "", events: [], done: false } };

	const raw = await response.text();
	const result: ChatResult = { text: "", events: [], done: false };
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = JSON.parse(line.slice(5).trim()) as {
			type: string;
			text?: string;
			conversationId?: string;
		};
		result.events.push(payload.type);
		if (payload.type === "start") result.conversationId = payload.conversationId;
		if (payload.type === "delta") result.text += payload.text ?? "";
		if (payload.type === "done") result.done = true;
	}
	return { status: response.status, result };
}

rmSync(DB, { force: true });
rmSync(MEMORY_DB, { force: true });

let server = startServer();

try {
	await waitForReady();

	// ── 1. 新建会话 ───────────────────────────────────
	console.log("\n· 1. 首轮对话（新建会话）");
	const first = await chat({ messages: [{ role: "user", content: "我养了一只叫团子的猫" }] });
	const externalId = first.result.conversationId;
	check(first.status === 200, "HTTP 200", String(first.status));
	check(Boolean(externalId), "服务端下发了 conversationId", externalId);
	check(first.result.done, "收到 done 事件");
	check(first.result.text.includes("链路已通"), "拿到模型输出", first.result.text.slice(0, 20));

	// ── 2. 续同一会话 ─────────────────────────────────
	console.log("\n· 2. 带上 conversationId 继续");
	const second = await chat({
		conversationId: externalId,
		messages: [{ role: "user", content: "我刚才说了什么？" }],
	});
	check(second.status === 200, "续会话成功", String(second.status));
	check(second.result.conversationId === externalId, "same id 没变");

	// ── 3. 编造的 id ─────────────────────────────────
	console.log("\n· 3. 编一个 id");
	const bogus = await chat({
		conversationId: "00000000-0000-4000-8000-000000000000",
		messages: [{ role: "user", content: "偷看一下别人的会话" }],
	});
	check(bogus.status === 404, "不存在的会话返回 404", String(bogus.status));

	// ── 4. 用量 ───────────────────────────────────────
	console.log("\n· 4. 用量接口");
	const usageResponse = await fetch(`${BASE}/api/v1/agent/usage`);
	const usage = (await usageResponse.json()) as {
		models: { model: string; totalTokens: number }[];
	};
	check(usage.models.length > 0, "有用量记录", JSON.stringify(usage.models[0]));

	// ── 5. 提醒 ───────────────────────────────────────
	console.log("\n· 5. 提醒接口");
	const at = Date.now() + 1_200;
	const created = await fetch(`${BASE}/api/v1/agent/reminders`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversationId: externalId, text: "该写日记了", at }),
	});
	check(created.status === 201, "提醒创建成功", String(created.status));

	const pending = (await (await fetch(`${BASE}/api/v1/agent/reminders`)).json()) as {
		reminders: { text: string; status: string }[];
	};
	check(pending.reminders.length === 1, "列表里有一条待触发", JSON.stringify(pending.reminders[0]));

	await sleep(1_600);
	const afterFire = (await (await fetch(`${BASE}/api/v1/agent/reminders`)).json()) as {
		reminders: unknown[];
	};
	check(afterFire.reminders.length === 0, "到点后不再挂在待触发里");

	// ── 6. 重启后会话还在 ─────────────────────────────
	console.log("\n· 6. 重启进程，历史还在");
	server.kill();
	await sleep(800);
	server = startServer();
	await waitForReady();

	const resumed = await chat({
		conversationId: externalId,
		messages: [{ role: "user", content: "还记得我吗？" }],
	});
	check(resumed.status === 200, "重启后同一 conversationId 仍可用", String(resumed.status));
	check(resumed.result.conversationId === externalId, "id 一致");
} finally {
	server.kill();
	await sleep(300);
	// 探针产物不留
	rmSync(DB, { force: true });
	rmSync(`${DB}-wal`, { force: true });
	rmSync(`${DB}-shm`, { force: true });
	rmSync(MEMORY_DB, { force: true });
}

console.log(failures === 0 ? "\n✓ 端到端全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
