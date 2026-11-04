/**
 * 模型思考档自动探活探针（2026-11-04 D1）。
 *
 * 为什么不用 faux：faux 不发 HTTP，看不到"服务端真去问上游能不能用 medium"。
 * 这里起一个**假上游**，按模型/档位回不同状态，再断言 providers.json 的落盘结果。
 *
 * 覆盖（任务书 §2.7 / §2.8）：
 *   1. 未声明模型切过去 → 后台发 low/medium/high 三个请求（≤16 tokens、串行），
 *      medium 400 invalid_parameter → 落盘 ["off","low","high"]，且响应里不带探活结果；
 *   2. 同模型并发切换只探一次（3 个请求，不是 6 个）；
 *   3. 已声明模型永不重探（请求计数 0，声明原样保留）；
 *   4. 未知（5xx）不写声明（UI 走缺省域）；
 *   5. 同时探活的模型数 ≤ 2（第三个排队）；
 *   6. MODEL_PROBE_LEVELS=false → 不发请求、不落盘；
 *   7. 日志只含枚举/状态码，不含消息内容与密钥。
 *
 *   pnpm --filter @lifediary/server exec tsx scripts/thinking-probe.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8110);
const UPSTREAM_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;

const PROVIDERS = ".data/probe-thinking-providers.json";
const RUNTIME = ".data/probe-thinking-runtime.json";
const DB = ".data/probe-thinking.sqlite";
const MEMORY_DB = ".data/probe-thinking-memory.db";
const EVENTS_DB = ".data/probe-thinking-events.sqlite";

const KEY = "probe-key";
const PROVIDER_ID = "bailian";
const MODELS = [
	"glm-5.3",
	"declared-model",
	"same-model",
	"unknown-model",
	"conc-a",
	"conc-b",
	"off-model",
];

/** 假上游延迟：让第三个模型的探活真的排队（否则并发上限测不出来） */
const PROBE_DELAY_MS = 200;

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── 假上游 ────────────────────────────────────────────────
interface ProbeRequest {
	model: string;
	level: string;
	status: number;
	authorization: string;
	at: number;
}
const probes: ProbeRequest[] = [];
let probeInFlight = 0;
let maxProbeInFlight = 0;

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => resolve(raw));
	});
}

function json(response: ServerResponse, status: number, payload: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(payload));
}

const upstream: Server = createServer(async (request, response) => {
	if (request.method !== "POST") {
		response.writeHead(404).end();
		return;
	}
	const raw = await readBody(request);
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		/* 记空对象，断言自然会挂 */
	}

	const isProbe = body.stream === false && typeof body.reasoning_effort === "string";
	if (!isProbe) {
		response.writeHead(404).end();
		return;
	}

	const model = String(body.model ?? "");
	const level = String(body.reasoning_effort ?? "");
	probeInFlight += 1;
	maxProbeInFlight = Math.max(maxProbeInFlight, probeInFlight);
	await sleep(PROBE_DELAY_MS);

	let status = 200;
	if (model === "unknown-model" && level === "low") {
		// 5xx = 未知：不能当成"不支持"
		status = 500;
	} else if (level === "medium") {
		// glm-5.3 的真实行为：medium 直接 400
		status = 400;
	}
	probes.push({
		model,
		level,
		status,
		authorization: String(request.headers.authorization ?? ""),
		at: Date.now(),
	});
	probeInFlight -= 1;

	if (status === 400) {
		json(response, 400, {
			error: {
				message: "invalid parameter: reasoning_effort medium is not supported",
				type: "invalid_parameter_error",
				code: "invalid_parameter",
			},
		});
		return;
	}
	if (status === 500) {
		json(response, 500, { error: { message: "upstream exploded" } });
		return;
	}
	json(response, 200, {
		id: "chatcmpl-probe",
		object: "chat.completion",
		model,
		choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
	});
});

// ── 被测服务 ──────────────────────────────────────────────
let serverLog = "";

function serverEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		PORT: String(PORT),
		LLM_PROVIDER: "",
		LLM_API_KEY: KEY,
		LLM_BASE_URL: `${UPSTREAM_BASE}/v1`,
		LLM_MODEL: "glm-5.3",
		LLM_MODELS: "",
		AGENT_TOKEN: "",
		AGENT_DB_PATH: DB,
		MEMORY_DB_PATH: MEMORY_DB,
		MEMORY_ENABLED: "false",
		CHANCELLOR_ENABLED: "false",
		JEV_ROUTE: "off",
		PROVIDERS_PATH: PROVIDERS,
		MODEL_RUNTIME_PATH: RUNTIME,
		AGENT_SSE_SEQ_DB_PATH: EVENTS_DB,
		MODEL_PROBE_LEVELS: "",
		NODE_OPTIONS: "",
		...extra,
	};
}

function startServer(extra: NodeJS.ProcessEnv = {}): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: serverEnv(extra),
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		serverLog += text;
		for (const line of text.split("\n")) {
			if (line.includes("[probe]")) process.stdout.write(`  [server] ${line}\n`);
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [server] ${text}`);
	});
	return child;
}

async function waitForReady(): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(`${BASE}/healthz`);
			if (response.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("服务没能启动");
}

interface SwitchResult {
	status: number;
	json: Record<string, unknown>;
}

async function switchModel(modelId: string): Promise<SwitchResult> {
	const response = await fetch(`${BASE}/api/v1/agent/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ providerId: PROVIDER_ID, modelId }),
	});
	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: response.status, json: payload };
}

function declaredLevels(modelId: string): string[] | undefined {
	const document = JSON.parse(readFileSync(PROVIDERS, "utf8")) as {
		providers?: { id?: string; modelThinkingLevels?: Record<string, string[]> }[];
	};
	const entry = (document.providers ?? []).find((provider) => provider.id === PROVIDER_ID);
	return entry?.modelThinkingLevels?.[modelId];
}

function probeCount(modelId: string): number {
	return probes.filter((probe) => probe.model === modelId).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await sleep(50);
	}
	return predicate();
}

// ── 准备 ──────────────────────────────────────────────────
for (const file of [PROVIDERS, RUNTIME, DB, `${DB}-wal`, `${DB}-shm`, MEMORY_DB, EVENTS_DB]) {
	rmSync(file, { force: true });
}
writeFileSync(
	PROVIDERS,
	`${JSON.stringify(
		{
			schemaVersion: 1,
			providers: [
				{
					id: PROVIDER_ID,
					name: "百炼",
					baseUrl: `${UPSTREAM_BASE}/v1`,
					keyEnv: "LLM_API_KEY",
					models: MODELS,
					// 已声明模型：声明即事实源，切过去也不该再发请求
					modelThinkingLevels: { "declared-model": ["off", "low", "medium", "high"] },
					createdAt: new Date().toISOString(),
				},
			],
			defaultSelection: { providerId: PROVIDER_ID, modelId: "glm-5.3" },
		},
		null,
		2,
	)}\n`,
);

await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));
let server = startServer();

try {
	await waitForReady();

	// ── 1. 未声明模型：探三个档，medium 被拒 → 写 ["off","low","high"] ──
	console.log("\n· 1. 未声明模型（glm-5.3）：自动探活并落盘");
	const [first, second] = await Promise.all([switchModel("glm-5.3"), switchModel("glm-5.3")]);
	check(first.status === 200 && second.status === 200, "POST /agent/model 返回 200（两次并发）");
	check(
		!("thinkingLevels" in first.json) && !("probe" in first.json),
		"切换响应里不带探活结果",
		Object.keys(first.json).join(","),
	);
	check(
		await waitFor(() => probeCount("glm-5.3") >= 3),
		"三个档都问过上游",
		String(probeCount("glm-5.3")),
	);
	// 等落盘完成再读文件：Windows 上并发 rename 与外部读同一文件会撞 EPERM
	await sleep(300);
	check(
		declaredLevels("glm-5.3") !== undefined,
		"探完写进 providers.json",
		JSON.stringify(declaredLevels("glm-5.3")),
	);
	check(
		JSON.stringify(declaredLevels("glm-5.3")) === JSON.stringify(["off", "low", "high"]),
		"落盘 = [off, low, high]（medium 被判不支持）",
		JSON.stringify(declaredLevels("glm-5.3")),
	);
	check(probeCount("glm-5.3") === 3, "同模型并发切换只探一次（3 个请求）", String(probeCount("glm-5.3")));
	const glmProbes = probes.filter((probe) => probe.model === "glm-5.3");
	check(
		glmProbes.map((probe) => probe.level).join(",") === "low,medium,high",
		"探活顺序 low → medium → high（串行）",
		glmProbes.map((probe) => probe.level).join(","),
	);
	check(
		glmProbes.every((probe) => probe.authorization === `Bearer ${KEY}`),
		"探活请求带供应商 keyEnv 的 Bearer key",
		glmProbes[0]?.authorization ?? "",
	);

	// ── 2. 已声明模型：不探、不写 ───────────────────────────
	console.log("\n· 2. 已声明模型（declared-model）：永不重探");
	const declaredBefore = JSON.stringify(declaredLevels("declared-model"));
	const declaredSwitch = await switchModel("declared-model");
	check(declaredSwitch.status === 200, "切换成功", String(declaredSwitch.status));
	await sleep(900);
	check(probeCount("declared-model") === 0, "请求计数为 0", String(probeCount("declared-model")));
	check(
		JSON.stringify(declaredLevels("declared-model")) === declaredBefore,
		"声明原样保留（不被覆盖）",
		JSON.stringify(declaredLevels("declared-model")),
	);

	// ── 3. 未知（5xx）不写声明 ──────────────────────────────
	console.log("\n· 3. 未知结果（unknown-model 的 low 回 500）：不写声明");
	const unknownSwitch = await switchModel("unknown-model");
	check(unknownSwitch.status === 200, "切换成功", String(unknownSwitch.status));
	check(
		await waitFor(() => probeCount("unknown-model") === 3),
		"三个档都试过",
		String(probeCount("unknown-model")),
	);
	await sleep(200);
	check(declaredLevels("unknown-model") === undefined, "未知不落盘（UI 走缺省域）");

	// ── 4. 并发上限 ≤ 2 ────────────────────────────────────
	console.log("\n· 4. 同时探活模型数 ≤ 2（第三个排队）");
	maxProbeInFlight = 0;
	await Promise.all([
		switchModel("conc-a"),
		switchModel("conc-b"),
		switchModel("same-model"),
		switchModel("same-model"),
	]);
	check(
		await waitFor(
			() =>
				probeCount("conc-a") === 3 &&
				probeCount("conc-b") === 3 &&
				probeCount("same-model") === 3,
		),
		"三个模型都探过上游",
		`${probeCount("same-model")} / ${probeCount("conc-a")} / ${probeCount("conc-b")}`,
	);
	await sleep(300);
	check(
		declaredLevels("conc-a") !== undefined &&
			declaredLevels("conc-b") !== undefined &&
			declaredLevels("same-model") !== undefined,
		"三个模型都落盘",
		`${JSON.stringify(declaredLevels("same-model"))} / ${JSON.stringify(declaredLevels("conc-a"))} / ${JSON.stringify(declaredLevels("conc-b"))}`,
	);
	check(maxProbeInFlight <= 2, "假上游观测到的并发 ≤ 2", String(maxProbeInFlight));
	check(
		probeCount("same-model") === 3,
		"同模型并发切换仍只探一次",
		String(probeCount("same-model")),
	);
	check(
		probeCount("conc-a") === 3 && probeCount("conc-b") === 3,
		"排队不等于跳过：另两个模型各探 3 次",
		`${probeCount("conc-a")} / ${probeCount("conc-b")}`,
	);

	// ── 5. 日志：枚举 + 状态码，不含内容/密钥 ───────────────
	console.log("\n· 5. 日志口径");
	check(
		serverLog.includes("[probe] bailian/glm-5.3 low=ok medium=rejected(400 invalid_parameter) high=ok"),
		"日志形如 low=ok medium=rejected(400 invalid_parameter) high=ok",
		serverLog.split("\n").find((line) => line.includes("[probe] bailian/glm-5.3")) ?? "",
	);
	check(!serverLog.includes(KEY), "日志不含密钥值");
	check(!serverLog.includes('"ping"') && !serverLog.includes("pong"), "日志不含消息内容");

	// ── 6. 回滚开关：MODEL_PROBE_LEVELS=false 不探不写 ──────
	console.log("\n· 6. MODEL_PROBE_LEVELS=false：完全不探");
	server.kill();
	await sleep(700);
	server = startServer({ MODEL_PROBE_LEVELS: "false" });
	await waitForReady();

	const beforeOff = probeCount("off-model");
	const offSwitch = await switchModel("off-model");
	check(offSwitch.status === 200, "切换本身仍成功", String(offSwitch.status));
	await sleep(900);
	check(probeCount("off-model") === beforeOff, "没发任何探活请求", String(probeCount("off-model") - beforeOff));
	check(declaredLevels("off-model") === undefined, "没写声明");
} finally {
	server.kill();
	await sleep(300);
	upstream.close();
	for (const file of [PROVIDERS, RUNTIME, DB, `${DB}-wal`, `${DB}-shm`, MEMORY_DB, EVENTS_DB]) {
		rmSync(file, { force: true });
	}
}

console.log(failures === 0 ? "\n✓ 思考档探活全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
