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
			// 播种会写 providers.json；探针必须隔离，别碰真实 .data
			PROVIDERS_PATH: ".data/chain-probe-providers.json",
			NODE_OPTIONS: "",
			CHANCELLOR_ENABLED: "true",
			AUTONOMY_ENABLED: "false", // 探针显式关（默认已于 2026-11-13 翻成开）
			CHANCELLOR_EMPLOYEE: process.env.CHANCELLOR_EMPLOYEE?.trim() || "native",
			// 这个探针只验「主 agent 会不会派、 chancellor 能不能干完」；
			// 项目前置由 src/projects.test.ts 单独覆盖，这里不铺工作区。
			DELEGATION_PROJECT_REQUIRED: "false",
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
// chancellor 是独立私有仓，本机路径用 PROBE_CHANCELLOR_ROOT 传入，不写死。
const CH_ROOT = process.env.PROBE_CHANCELLOR_ROOT ?? "<chancellor 仓路径（设 PROBE_CHANCELLOR_ROOT）>";
const PROMPT =
	process.env.CHAIN_PROMPT?.trim() ||
	`读 ${CH_ROOT}/docs/设计方案 下所有 .md 文件，` +
		`把里面提到的「踩过的坑 / 失败教训」提炼成一份清单，写到 ${CH_ROOT}/PITFALLS.md，每条注明来自哪个文件。要真读，不要猜。`;

try {
	await waitForReady();
	const started = Date.now();
	// 走兼容层而不是自有端点：App 用的是这个，派活进度/需要人这两帧也只在这里出现。
	const response = await fetch(`${BASE}/api/v1/llm/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "lifediary",
			stream: true,
			messages: [{ role: "user", content: PROMPT }],
		}),
	});
	const raw = await response.text();
	const seconds = ((Date.now() - started) / 1000).toFixed(1);

	let conversationId: string | undefined;
	let text = "";
	let error: string | undefined;
	const eventTypes: string[] = [];
	const delegateFrames: string[] = [];
	const attentionFrames: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const body = line.slice(5).trim();
		if (body === "[DONE]") continue;
		const payload = JSON.parse(body) as {
			id?: string;
			choices?: Array<{ delta?: { content?: string } }>;
			lifediary_progress?: string;
			lifediary_delegate?: { done: number; total: number; current: string };
			lifediary_attention?: { kind: string; question: string };
		};
		if (payload.id) conversationId = payload.id;
		const content = payload.choices?.[0]?.delta?.content;
		if (content) {
			text += content;
			eventTypes.push("delta");
		}
		if (payload.lifediary_progress) eventTypes.push(`progress:${payload.lifediary_progress}`);
		if (payload.lifediary_delegate) {
			const d = payload.lifediary_delegate;
			delegateFrames.push(`${d.done}/${d.total} ${d.current}`);
			eventTypes.push("delegate");
		}
		if (payload.lifediary_attention) {
			attentionFrames.push(`${payload.lifediary_attention.kind}：${payload.lifediary_attention.question}`);
			eventTypes.push("attention");
		}
	}

	console.log(`\n耗时 ${seconds}s，conversation=${conversationId ?? "（无）"}`);
	console.log(`事件流：${eventTypes.join(" → ")}`);
	if (delegateFrames.length > 0) {
		console.log(`派活进度帧（${delegateFrames.length}）：${delegateFrames.join(" | ")}`);
	}
	if (attentionFrames.length > 0) {
		console.log(`需要你帧（${attentionFrames.length}）：${attentionFrames.join(" | ")}`);
	}
	console.log(`回复：${text.trim() || "（空）"}`);
	if (error) console.log(`error 事件：${error}`);

	if (!conversationId) {
		console.log("\n✗ 没拿到 conversationId");
		process.exitCode = 1;
	} else {
		const calledDelegate = delegateFrames.length > 0 || attentionFrames.length > 0;
		console.log(
			calledDelegate
				? "✓ 客户端收到了派活帧 —— 手机上能看到「正在办 2/3」了"
				: "⚠ 没收到派活帧 —— 主 agent 可能自己干了，也可能判断不需要派",
		);
	}
} finally {
	server.kill();
	await sleep(500);
	rmSync(DB, { force: true });
	rmSync(MEMORY_DB, { force: true });
	rmSync(".data/chain-probe-providers.json", { force: true });
}
