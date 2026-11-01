// 整链路探针：harness 主 agent → delegate → chancellor → worker，真模型。
//
// 需要 `LLM_API_KEY`（或 `DASHSCOPE_API_KEY`）。没有就跳过，不假装跑过。
//
// 验的是这条链能不能通：主 agent 自己决定调 delegate、chancellor 收单派活、
// 结论以一句话回到会话。**不验**主 agent 的判断力好不好（那是 description 的事）。
//
// 用法：`pnpm --filter @lifediary/server chain`
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const PORT = 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = join(import.meta.dirname, "..");
const DB = join(DIR, ".data/chain-probe-agent.sqlite");
const MEMORY_DB = join(DIR, ".data/chain-probe-memory.db");

const apiKey = (process.env.LLM_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "").trim();
if (!apiKey) {
	console.error("跳过：没有 LLM_API_KEY / DASHSCOPE_API_KEY，整链路跑不了真模型。");
	process.exit(0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: DIR,
		env: {
			...process.env,
			PORT: String(PORT),
			LLM_PROVIDER: "",
			LLM_API_KEY: apiKey,
			LLM_MODEL: process.env.LLM_MODEL?.trim() || "deepseek-v4.1-flash",
			LLM_BASE_URL:
				process.env.LLM_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1",
			AGENT_TOKEN: "",
			AGENT_DB_PATH: DB,
			MEMORY_DB_PATH: MEMORY_DB,
			NODE_OPTIONS: "",
			CHANCELLOR_ENABLED: "true",
			CHANCELLOR_EMPLOYEE: process.env.CHANCELLOR_EMPLOYEE?.trim() || "native",
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
	for (let attempt = 0; attempt < 80; attempt += 1) {
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

rmSync(DB, { force: true });
rmSync(MEMORY_DB, { force: true });
const server = startServer();

// 默认这个任务要读 6 份设计方案、提炼、再写一份文件——不是一条命令能答的，
// 主 agent 要么自己啃很久，要么派出去。用 `CHAIN_PROMPT` 可以换。
const PROMPT =
	process.env.CHAIN_PROMPT?.trim() ||
	"读 <chancellor>/docs/设计方案 下所有 .md 文件，" +
		"把里面提到的「踩过的坑 / 失败教训」提炼成一份清单，写到 " +
		"<chancellor>/PITFALLS.md，每条注明来自哪个文件。要真读，不要猜。";

try {
	await waitForReady();
	const started = Date.now();
	const response = await fetch(`${BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			messages: [{ role: "user", content: PROMPT }],
		}),
	});
	const raw = await response.text();
	const seconds = ((Date.now() - started) / 1000).toFixed(1);

	let conversationId: string | undefined;
	let text = "";
	let error: string | undefined;
	const eventTypes: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = JSON.parse(line.slice(5).trim()) as {
			type: string;
			text?: string;
			message?: string;
			conversationId?: string;
		};
		eventTypes.push(payload.type);
		if (payload.type === "start") conversationId = payload.conversationId;
		if (payload.type === "delta") text += payload.text ?? "";
		if (payload.type === "error") error = payload.message;
	}

	console.log(`\n耗时 ${seconds}s，conversation=${conversationId ?? "（无）"}`);
	console.log(`事件流：${eventTypes.join(" → ")}`);
	console.log(`回复：${text.trim() || "（空）"}`);
	if (error) console.log(`error 事件：${error}`);

	if (!conversationId) {
		console.log("\n✗ 没拿到 conversationId");
		process.exitCode = 1;
	} else {
		// 从会话回读里找 delegate 的痕迹：tool 调用名会落在 entries 里
		const messages = await (
			await fetch(`${BASE}/api/v1/agent/chat/${conversationId}/messages`)
		).text();
		const calledDelegate = messages.includes("delegate");
		console.log(
			calledDelegate
				? "✓ 会话里出现了 delegate —— 主 agent 真的把活派出去了"
				: "⚠ 会话里没看到 delegate —— 主 agent 可能自己干了，也可能判断不需要派",
		);
	}
} finally {
	server.kill();
	await sleep(500);
	rmSync(DB, { force: true });
	rmSync(MEMORY_DB, { force: true });
}
