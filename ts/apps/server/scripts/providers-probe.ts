/**
 * 多供应商与切模型 v2 探针（2026-11-04 批次五）。
 *
 * 为什么必须起**多个假上游**：本轮要证明"换供应商 / 换地址 / 换 keyEnv"真的到了下一轮请求，
 * 以及"同名模型跨供应商"不是空操作（审查 S1）。faux 不发 HTTP，看不见这些。
 *
 * 覆盖（图纸 §五 十条）：
 *   1. 只有 A：一轮打到 A，Authorization 是 keyA；
 *   2. 不重启加 B：GET /model 立即可见 → 切到 B → 下一轮打到 B、key 变 keyB；
 *   3. 在 A 上建的会话切到 B 的同名模型 → 下一轮打 B（专抓 S1）；
 *   4. 改 B 的 baseUrl → 同进程下一轮即新地址；
 *   5. 改 B 的 keyEnv → 下一轮 Authorization 变新值（请求前一刻读 env）；
 *   6. hasKey:false 的供应商：投影正确；选中后请求报正常错误事件、服务不崩；
 *   7. 删除保护与旧会话回退：默认 / 当前选中 400；删非默认后消失；旧会话回退默认供应商；
 *   8. 旧 `{model}` 与旧 runtime.json 裸 id 都落默认供应商；
 *   9. 播种矩阵：env → 文件；重启改 env → 文件为准；删文件 → env 为准；PROVIDERS_CONFIG=false → env 为准；
 *  10. faux：CRUD 可用、POST /model 400、不播种、不污染真实 .data。
 * 另断言：派生变体 id 不漏到上游 body.model。
 *
 *   pnpm --filter @lifediary/server providers
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8106);
const BASE = `http://127.0.0.1:${PORT}`;
const A_PORT = PORT + 1;
const B_PORT = PORT + 2;
const C_PORT = PORT + 3;
const FAUX_PORT = PORT + 4;
const FAUX_BASE = `http://127.0.0.1:${FAUX_PORT}`;

const MODEL = "same-model";
const KEY_A = "keyA";
const KEY_B = "keyB";
const KEY_B2 = "keyB2";

const DB = ".data/probe-providers.sqlite";
const MEMORY_DB = ".data/probe-providers-memory.db";
/** 必须隔离：播种会写文件，绝不能落到真实 .data/providers.json */
const PROVIDERS = ".data/probe-providers.json";
const RUNTIME = ".data/probe-providers-runtime.json";
const FAUX_PROVIDERS = ".data/probe-providers-faux.json";
const REAL_PROVIDERS = ".data/providers.json";
/** §11 自带一套隔离数据：重启前后只碰这些文件，不干扰 §1–§10 的既有断言 */
const RESTART_DB = ".data/probe-restart.sqlite";
const RESTART_MEMORY = ".data/probe-restart-memory.db";
const RESTART_PROVIDERS = ".data/probe-restart-providers.json";
const RESTART_RUNTIME = ".data/probe-restart-runtime.json";

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
interface Recorded {
	body: Record<string, unknown>;
	authorization: string;
	at: number;
}

interface FakeUpstream {
	label: string;
	server: Server;
	received: Recorded[];
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => resolve(raw));
	});
}

function sseChunk(response: ServerResponse, payload: unknown): void {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startUpstream(port: number, label: string): Promise<FakeUpstream> {
	const received: Recorded[] = [];
	const server = createServer(async (request, response) => {
		// 供「测试钥匙 / 拉取清单」用（本轮不强制断言，但真实链路要用得到）
		if (request.method === "GET" && request.url?.includes("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			// 带上下文字段：检测端点要从上游 /models 抽 contextWindow / maxTokens
			response.end(
				JSON.stringify({
					data: [
						{ id: MODEL, context_length: 200000, max_output_tokens: 8192 },
						{ id: "b-only", max_model_len: 32768, max_completion_tokens: 4096 },
					],
				}),
			);
			return;
		}
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
		received.push({
			body,
			authorization: String(request.headers.authorization ?? ""),
			at: Date.now(),
		});

		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const base = {
			id: `chatcmpl-${label}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: String(body.model ?? "fake"),
		};
		const text = `（假上游 ${label}）好。`;
		sseChunk(response, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
		sseChunk(response, { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
		sseChunk(response, {
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});
		response.write("data: [DONE]\n\n");
		response.end();
	});
	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => resolve({ label, server, received }));
	});
}

// ── 被测服务 ──────────────────────────────────────────────
function serverEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		PORT: String(PORT),
		LLM_PROVIDER: "",
		LLM_API_KEY: KEY_A,
		LLM_BASE_URL: `http://127.0.0.1:${A_PORT}/v1`,
		LLM_MODEL: MODEL,
		LLM_MODELS: "",
		LLM_MODEL_FAST: "",
		AGENT_TOKEN: "",
		AGENT_DB_PATH: DB,
		MEMORY_DB_PATH: MEMORY_DB,
		MEMORY_ENABLED: "false",
		CHANCELLOR_ENABLED: "false",
		JEV_ROUTE: "off",
		PROVIDERS_PATH: PROVIDERS,
		MODEL_RUNTIME_PATH: RUNTIME,
		PROVIDERS_CONFIG: "",
		MODEL_RUNTIME_OVERRIDE: "",
		B_KEY: KEY_B,
		B_KEY2: KEY_B2,
		NODE_OPTIONS: "",
		...extra,
	};
}

function startServer(extra: NodeJS.ProcessEnv = {}, port = PORT): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: { ...serverEnv(extra), PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (!text.includes("ExperimentalWarning")) process.stderr.write(`  [server] ${text}`);
	});
	return child;
}

async function waitForReady(base = BASE): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(`${base}/healthz`);
			if (response.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("服务没能启动");
}

interface ChatResult {
	status: number;
	conversationId?: string;
	text: string;
	events: string[];
	error?: string;
	done: boolean;
}

async function chat(base: string, conversationId?: string): Promise<ChatResult> {
	const response = await fetch(`${base}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...(conversationId ? { conversationId } : {}),
			messages: [{ role: "user", content: "在吗" }],
		}),
	});
	const result: ChatResult = { status: response.status, text: "", events: [], done: false };
	if (response.status !== 200) return result;
	const raw = await response.text();
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = JSON.parse(line.slice(5).trim()) as {
			type: string;
			text?: string;
			message?: string;
			conversationId?: string;
		};
		result.events.push(payload.type);
		if (payload.type === "start") result.conversationId = payload.conversationId;
		if (payload.type === "delta") result.text += payload.text ?? "";
		if (payload.type === "error") result.error = payload.message;
		if (payload.type === "done") result.done = true;
	}
	return result;
}

async function getJson(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await fetch(`${BASE}${path}`);
	return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

async function postJson(
	path: string,
	body: unknown,
	base = BASE,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

async function deletePath(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await fetch(`${BASE}${path}`, { method: "DELETE" });
	return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

function lastBody(received: Recorded[]): Record<string, unknown> | undefined {
	return received.at(-1)?.body;
}

// ── 准备 ─────────────────────────────────────────────────
const upstreamA = await startUpstream(A_PORT, "A");
const upstreamB = await startUpstream(B_PORT, "B");
const upstreamC = await startUpstream(C_PORT, "C");

rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });
rmSync(MEMORY_DB, { force: true });
rmSync(PROVIDERS, { force: true });
rmSync(RUNTIME, { force: true });
rmSync(FAUX_PROVIDERS, { force: true });

/** 真实配置文件的指纹：整轮跑完必须一个字都没变 */
const realBefore = existsSync(REAL_PROVIDERS)
	? `${statSync(REAL_PROVIDERS).mtimeMs}:${statSync(REAL_PROVIDERS).size}`
	: "missing";

let server = startServer();
let fauxServer: ChildProcess | null = null;

try {
	await waitForReady();

	// ── 1. 只有 A ─────────────────────────────────────────
	console.log("\n· 1. 首启：env 播种出 A，一轮打到 A");
	check(existsSync(PROVIDERS), "providers.json 已按 env 播种", PROVIDERS);
	const seeded = existsSync(PROVIDERS)
		? (JSON.parse(readFileSync(PROVIDERS, "utf8")) as Record<string, unknown>)
		: {};
	const seededProviders = (seeded.providers ?? []) as { id: string; baseUrl: string; keyEnv: string }[];
	check(seededProviders.length === 1, "播种只有默认供应商", String(seededProviders.length));
	check(seededProviders[0]?.baseUrl === `http://127.0.0.1:${A_PORT}/v1`, "播种 baseUrl 来自 env", String(seededProviders[0]?.baseUrl));
	check(seededProviders[0]?.keyEnv === "LLM_API_KEY", "种子只存 keyEnv 变量名", String(seededProviders[0]?.keyEnv));
	check(
		!readFileSync(PROVIDERS, "utf8").includes('"apiKey"'),
		"种子文件不含 apiKey 字段",
	);

	const first = await chat(BASE);
	check(first.status === 200 && first.done, "首轮完成", first.events.join(","));
	const conv1 = first.conversationId;
	check(Boolean(conv1), "拿到 conversationId", String(conv1));
	const aFirst = upstreamA.received.at(-1);
	check(Boolean(aFirst), "A 收到了请求", `${upstreamA.received.length} 次`);
	check(aFirst?.authorization === `Bearer ${KEY_A}`, "Authorization 是 keyA", String(aFirst?.authorization));
	check(String(aFirst?.body.model ?? "") === MODEL, "上游拿到真实模型名", String(aFirst?.body.model));
	check(!String(aFirst?.body.model ?? "").includes("#"), "派生变体 id 没漏到上游 body.model");

	// ── 2. 不重启加 B ──────────────────────────────────────
	console.log("\n· 2. 不重启添加 B，立即可见并切换");
	const added = await postJson("/api/v1/agent/providers", {
		id: "b",
		name: "B 供应商",
		baseUrl: `http://127.0.0.1:${B_PORT}/v1`,
		keyEnv: "B_KEY",
		models: [MODEL, "b-only"],
	});
	check(added.status === 200, "POST /providers 新增 B", String(added.status));
	const catalogAfterAdd = await getJson("/api/v1/agent/model");
	const providerIds = ((catalogAfterAdd.json.providers ?? []) as { id: string }[]).map((item) => item.id);
	check(providerIds.includes("b"), "GET /agent/model 立即可见 B", providerIds.join("、"));
	const switchedB = await postJson("/api/v1/agent/model", { providerId: "b", modelId: MODEL });
	check(switchedB.status === 200 && switchedB.json.provider === "b", "切到 B", JSON.stringify(switchedB.json));
	const conv2Result = await chat(BASE);
	const conv2 = conv2Result.conversationId;
	const bFirst = upstreamB.received.at(-1);
	check(bFirst?.authorization === `Bearer ${KEY_B}`, "B 收到 keyB", String(bFirst?.authorization));
	check(String(bFirst?.body.model ?? "") === MODEL, "B 收到的仍是真实模型名", String(bFirst?.body.model));
	check((upstreamA.received.length ?? 0) === 1, "这一轮没有回落到 A", String(upstreamA.received.length));

	// ── 2b. 逐模型元数据 + 检测（2026-11-05）────────────────
	console.log("\n· 2b. 逐模型元数据 / 空清单建档 / 检测端点");
	const metaSaved = await postJson("/api/v1/agent/providers", {
		id: "b",
		previousId: "b",
		name: "B 供应商",
		baseUrl: `http://127.0.0.1:${B_PORT}/v1`,
		keyEnv: "B_KEY",
		models: [MODEL, "b-only"],
		modelMeta: { [MODEL]: { contextWindow: 262144, maxTokens: 16384 } },
		modelThinkingLevels: { [MODEL]: ["off", "low", "high"] },
	});
	const metaEntry = (metaSaved.json.provider ?? {}) as {
		modelMeta?: Record<string, { contextWindow?: number; maxTokens?: number }>;
		modelThinkingLevels?: Record<string, string[]>;
	};
	check(metaSaved.status === 200, "带着 modelMeta 保存供应商", String(metaSaved.status));
	check(metaEntry.modelMeta?.[MODEL]?.contextWindow === 262144, "modelMeta 回读上下文", JSON.stringify(metaEntry.modelMeta?.[MODEL]));
	check(metaEntry.modelMeta?.[MODEL]?.maxTokens === 16384, "modelMeta 回读最大输出");
	check(
		JSON.stringify(metaEntry.modelThinkingLevels?.[MODEL]) === JSON.stringify(["off", "low", "high"]),
		"modelThinkingLevels 回读",
		JSON.stringify(metaEntry.modelThinkingLevels?.[MODEL]),
	);
	const catalogMeta = await getJson("/api/v1/agent/model");
	const catalogRow = ((catalogMeta.json.providers ?? []) as { id: string; models: unknown[] }[])
		.find((item) => item.id === "b")
		?.models.find((row) => (row as { id?: string }).id === MODEL) as
		| { contextWindow?: number; maxTokens?: number }
		| undefined;
	check(catalogRow?.contextWindow === 262144 && catalogRow?.maxTokens === 16384, "composer 投影带上下文/输出", JSON.stringify(catalogRow));

	const detected = await postJson("/api/v1/agent/providers/b/models/detect", { modelId: "b-only" });
	const detection = (detected.json.detection ?? {}) as {
		reachable?: boolean;
		contextWindow?: number | null;
		maxTokens?: number | null;
		thinkingLevels?: string[];
	};
	check(detected.status === 200 && detection.reachable === true, "检测端点真打上游", JSON.stringify(detection));
	check(detection.contextWindow === 32768, "从 max_model_len 抽到上下文", String(detection.contextWindow));
	check(detection.maxTokens === 4096, "从 max_completion_tokens 抽到输出上限", String(detection.maxTokens));
	check(Boolean(detection.thinkingLevels?.includes("high")), "探出思考档", JSON.stringify(detection.thinkingLevels));
	const detectUnknown = await postJson("/api/v1/agent/providers/nope/models/detect", { modelId: MODEL });
	check(detectUnknown.status === 404 && detectUnknown.json.error === "unknown_provider", "未知供应商 404", JSON.stringify(detectUnknown.json));
	const detectEmpty = await postJson("/api/v1/agent/providers/b/models/detect", { modelId: "" });
	check(detectEmpty.status === 400 && detectEmpty.json.error === "bad_request", "空模型 id 400", JSON.stringify(detectEmpty.json));

	const emptyCreate = await postJson("/api/v1/agent/providers", {
		id: "e",
		name: "E 空清单",
		baseUrl: `http://127.0.0.1:${B_PORT}/v1`,
		keyEnv: "B_KEY",
		models: [],
		allowEmptyModels: true,
	});
	check(emptyCreate.status === 200, "allowEmptyModels 允许先建空清单", String(emptyCreate.status));
	const emptyReject = await postJson("/api/v1/agent/providers", {
		id: "e2",
		name: "E2",
		baseUrl: `http://127.0.0.1:${B_PORT}/v1`,
		keyEnv: "B_KEY",
		models: [],
	});
	check(emptyReject.status === 400 && emptyReject.json.error === "bad_models", "不带开关时仍拒绝空清单（老语义）", JSON.stringify(emptyReject.json));
	// 非法数值丢弃（与思考档同口径），非对象形状才 400
	const badValueMeta = await postJson("/api/v1/agent/providers", {
		id: "b",
		previousId: "b",
		name: "B 供应商",
		baseUrl: `http://127.0.0.1:${B_PORT}/v1`,
		keyEnv: "B_KEY",
		models: [MODEL, "b-only"],
		modelMeta: { [MODEL]: { contextWindow: -1 } },
	});
	const badValueEntry = (badValueMeta.json.provider ?? {}) as { modelMeta?: Record<string, unknown> };
	check(
		badValueMeta.status === 200 && !badValueEntry.modelMeta?.[MODEL],
		"非法数值的 modelMeta 被丢弃",
		JSON.stringify(badValueEntry.modelMeta),
	);
	const badShapeMeta = await postJson("/api/v1/agent/providers", {
		id: "b",
		previousId: "b",
		name: "B 供应商",
		baseUrl: `http://127.0.0.1:${B_PORT}/v1`,
		keyEnv: "B_KEY",
		models: [MODEL, "b-only"],
		modelMeta: "nope",
	});
	check(badShapeMeta.status === 400 && badShapeMeta.json.error === "bad_model_meta", "非对象 modelMeta 400", JSON.stringify(badShapeMeta.json));

	// ── 3. 旧会话切同名模型（S1）────────────────────────────
	console.log("\n· 3. A 上建的会话切到 B 的同名模型");
	const bBefore = upstreamB.received.length;
	const aBefore = upstreamA.received.length;
	const crossProvider = await chat(BASE, conv1);
	check(crossProvider.status === 200 && crossProvider.done, "旧会话这一轮完成", crossProvider.events.join(","));
	check(upstreamB.received.length === bBefore + 1, "下一轮打到了 B（不是 A）", `B ${upstreamB.received.length} / A ${upstreamA.received.length}`);
	check(upstreamA.received.length === aBefore, "A 没有收到这一轮");

	// ── 4. 改 B 的 baseUrl ────────────────────────────────
	console.log("\n· 4. 改 B 的 baseUrl 到第三个上游");
	const editedBase = await postJson("/api/v1/agent/providers", {
		id: "b",
		previousId: "b",
		name: "B 供应商",
		baseUrl: `http://127.0.0.1:${C_PORT}/v1`,
		keyEnv: "B_KEY",
		models: [MODEL, "b-only"],
	});
	check(editedBase.status === 200, "更新 B 的 baseUrl", String(editedBase.status));
	const cBefore = upstreamC.received.length;
	const bCountBefore = upstreamB.received.length;
	const afterBase = await chat(BASE, conv2);
	check(afterBase.status === 200 && afterBase.done, "改址后这一轮完成", afterBase.events.join(","));
	check(upstreamC.received.length === cBefore + 1, "同进程下一轮即打到新地址", `C ${upstreamC.received.length}`);
	check(upstreamB.received.length === bCountBefore, "旧地址没有再收到请求");

	// ── 5. 改 B 的 keyEnv ─────────────────────────────────
	console.log("\n· 5. 改 B 的 keyEnv（请求前一刻读 env）");
	const editedKey = await postJson("/api/v1/agent/providers", {
		id: "b",
		previousId: "b",
		name: "B 供应商",
		baseUrl: `http://127.0.0.1:${C_PORT}/v1`,
		keyEnv: "B_KEY2",
		models: [MODEL, "b-only"],
	});
	check(editedKey.status === 200, "更新 B 的 keyEnv", String(editedKey.status));
	const cBeforeKey = upstreamC.received.length;
	const afterKey = await chat(BASE, conv2);
	check(afterKey.status === 200 && afterKey.done, "改 keyEnv 后这一轮完成", afterKey.events.join(","));
	const keyed = upstreamC.received.at(-1);
	check(upstreamC.received.length === cBeforeKey + 1, "请求到了新地址");
	check(keyed?.authorization === `Bearer ${KEY_B2}`, "Authorization 变成 keyB2", String(keyed?.authorization));

	// ── 6. hasKey:false 的 C ──────────────────────────────
	console.log("\n· 6. keyEnv 指向缺失变量的供应商");
	const addedC = await postJson("/api/v1/agent/providers", {
		id: "c",
		name: "C 缺钥匙",
		baseUrl: `http://127.0.0.1:${C_PORT}/v1`,
		keyEnv: "C_MISSING_KEY",
		models: ["c-model"],
	});
	check(addedC.status === 200, "缺 env 的供应商允许保存", String(addedC.status));
	const detail = await getJson("/api/v1/agent/providers");
	const cEntry = ((detail.json.providers ?? []) as { id: string; hasKey: boolean; keyEnv: string }[]).find(
		(item) => item.id === "c",
	);
	check(cEntry?.hasKey === false, "投影 hasKey=false");
	check(cEntry?.keyEnv === "C_MISSING_KEY", "投影只给变量名", String(cEntry?.keyEnv));
	const selectC = await postJson("/api/v1/agent/model", { providerId: "c", modelId: "c-model" });
	check(selectC.status === 200, "能选中缺钥匙的供应商", String(selectC.status));
	const cChat = await chat(BASE);
	check(cChat.status === 200, "请求本身没有崩（HTTP 200 流）", String(cChat.status));
	check(cChat.events.includes("error"), "吐出正常错误事件", cChat.events.join(","));
	check(cChat.done, "流正常收尾");
	const alive = await fetch(`${BASE}/healthz`);
	check(alive.ok, "服务还活着");

	// ── 7. 删除保护与旧会话回退 ────────────────────────────
	console.log("\n· 7. 删除保护 / 删非默认 / 旧会话回退");
	const delDefault = await deletePath("/api/v1/agent/providers/bailian");
	check(delDefault.status === 400 && delDefault.json.error === "provider_is_default", "默认供应商不能删", JSON.stringify(delDefault.json));
	const delCurrent = await deletePath("/api/v1/agent/providers/c");
	check(delCurrent.status === 400 && delCurrent.json.error === "provider_in_use", "当前选中的供应商不能删", JSON.stringify(delCurrent.json));
	await postJson("/api/v1/agent/model", { providerId: "bailian", modelId: MODEL });
	const delC = await deletePath("/api/v1/agent/providers/c");
	check(delC.status === 200, "删掉非默认 / 非当前供应商", String(delC.status));
	const afterDel = await getJson("/api/v1/agent/providers");
	const idsAfterDel = ((afterDel.json.providers ?? []) as { id: string }[]).map((item) => item.id);
	check(!idsAfterDel.includes("c"), "供应商列表里已消失", idsAfterDel.join("、"));
	const delB = await deletePath("/api/v1/agent/providers/b");
	check(delB.status === 200, "删掉被旧会话引用的 B", String(delB.status));
	const aBeforeFallback = upstreamA.received.length;
	const cBeforeFallback = upstreamC.received.length;
	const fallback = await chat(BASE, conv2);
	// 排除后台思考档探活的噪音（max_tokens 小、单条消息、无 tools），只看真正的对话请求
	const fallbackChats = upstreamA.received
		.slice(aBeforeFallback)
		.filter((item) => Array.isArray(item.body.tools));
	check(fallback.status === 200 && fallback.done, "旧会话这一轮完成", fallback.events.join(","));
	check(
		fallbackChats.length === 1,
		"旧会话回退到默认供应商 A",
		`A 对话请求 ${aBeforeFallback} → ${aBeforeFallback + fallbackChats.length}`,
	);
	check(upstreamC.received.length === cBeforeFallback, "没有再拿旧引用打已删地址");

	// ── 8. 旧形状兼容 ─────────────────────────────────────
	console.log("\n· 8. 旧 {model} 与旧 runtime.json 裸 id");
	const legacyPost = await postJson("/api/v1/agent/model", { model: MODEL });
	check(legacyPost.status === 200 && legacyPost.json.provider === "bailian", "旧 {model} 落在默认供应商", JSON.stringify(legacyPost.json));
	const addedD = await postJson("/api/v1/agent/providers", {
		id: "d",
		name: "D",
		baseUrl: `http://127.0.0.1:${C_PORT}/v1`,
		keyEnv: "B_KEY",
		models: [MODEL],
	});
	check(addedD.status === 200, "再加一个非默认供应商 D", String(addedD.status));
	await postJson("/api/v1/agent/model", { providerId: "d", modelId: MODEL });
	writeFileSync(RUNTIME, `${JSON.stringify({ model: MODEL })}\n`);
	const legacyRuntime = await getJson("/api/v1/agent/model");
	const current = legacyRuntime.json.current as { providerId?: string; modelId?: string } | undefined;
	check(
		current?.providerId === "bailian" && current.modelId === MODEL,
		"旧裸 id 映射到默认供应商",
		JSON.stringify(current),
	);
	await postJson("/api/v1/agent/model", { providerId: "bailian", modelId: MODEL });

	// ── 9. 播种矩阵 ───────────────────────────────────────
	console.log("\n· 9. 播种矩阵");
	const fileBeforeRestart = readFileSync(PROVIDERS, "utf8");
	server.kill();
	await sleep(700);
	server = startServer({ LLM_MODEL: "env-other" });
	await waitForReady();
	const healthFileWins = (await (await fetch(`${BASE}/healthz`)).json()) as { model?: string };
	check(healthFileWins.model === MODEL, "重启改 env → 文件为准", String(healthFileWins.model));
	check(readFileSync(PROVIDERS, "utf8") === fileBeforeRestart, "文件内容没被 env 覆盖");

	server.kill();
	await sleep(700);
	rmSync(PROVIDERS, { force: true });
	server = startServer({ LLM_MODEL: "env-other" });
	await waitForReady();
	const healthEnvWins = (await (await fetch(`${BASE}/healthz`)).json()) as { model?: string };
	check(healthEnvWins.model === "env-other", "删文件 → env 为准（并重新播种）", String(healthEnvWins.model));
	check(existsSync(PROVIDERS), "删掉后重新播种出文件");

	server.kill();
	await sleep(700);
	// 放一份"看起来很像"的文件：若 PROVIDERS_CONFIG=false 没生效，当前模型会是 file-model
	writeFileSync(
		PROVIDERS,
		`${JSON.stringify({
			schemaVersion: 1,
			providers: [
				{
					id: "fileonly",
					name: "文件里的供应商",
					baseUrl: `http://127.0.0.1:${A_PORT}/v1`,
					keyEnv: "LLM_API_KEY",
					models: ["file-model"],
					createdAt: "2026-11-04T00:00:00.000Z",
				},
			],
			defaultSelection: { providerId: "fileonly", modelId: "file-model" },
		})}\n`,
	);
	const fileSnapshot = readFileSync(PROVIDERS, "utf8");
	server = startServer({ LLM_MODEL: "env-other", PROVIDERS_CONFIG: "false" });
	await waitForReady();
	const healthDisabled = (await (await fetch(`${BASE}/healthz`)).json()) as { model?: string };
	check(healthDisabled.model === "env-other", "PROVIDERS_CONFIG=false → 纯 env", String(healthDisabled.model));
	check(readFileSync(PROVIDERS, "utf8") === fileSnapshot, "关闭时完全不读也不写文件");
	const disabledWrite = await postJson("/api/v1/agent/providers", {
		id: "x",
		name: "X",
		baseUrl: `http://127.0.0.1:${A_PORT}/v1`,
		keyEnv: "LLM_API_KEY",
		models: [MODEL],
	});
	check(disabledWrite.status === 400 && disabledWrite.json.error === "providers_disabled", "关闭时 CRUD 一律 400", JSON.stringify(disabledWrite.json));
	const disabledDetect = await postJson("/api/v1/agent/providers/bailian/models/detect", { modelId: MODEL });
	check(
		disabledDetect.status === 400 && disabledDetect.json.error === "providers_disabled",
		"关闭时检测端点也 400",
		JSON.stringify(disabledDetect.json),
	);

	// 请求体里带密钥字段也要显式拒收（不是静默忽略）
	const secretBody = await postJson("/api/v1/agent/providers", {
		id: "x",
		name: "X",
		baseUrl: `http://127.0.0.1:${A_PORT}/v1`,
		keyEnv: "LLM_API_KEY",
		models: [MODEL],
		apiKey: "should-not-be-accepted",
	});
	check(secretBody.status === 400 && secretBody.json.error === "secret_field_forbidden", "请求体 apiKey 显式拒收", JSON.stringify(secretBody.json));

	// ── 10. faux ─────────────────────────────────────────
	console.log("\n· 10. faux：CRUD 可用、不播种、切模型 400");
	server.kill();
	await sleep(700);
	rmSync(FAUX_PROVIDERS, { force: true });
	fauxServer = startServer(
		{
			LLM_PROVIDER: "faux",
			LLM_API_KEY: "",
			PROVIDERS_CONFIG: "",
			PROVIDERS_PATH: FAUX_PROVIDERS,
			AGENT_DB_PATH: ".data/probe-providers-faux.sqlite",
			MEMORY_DB_PATH: ".data/probe-providers-faux-memory.db",
		},
		FAUX_PORT,
	);
	await waitForReady(FAUX_BASE);
	check(!existsSync(FAUX_PROVIDERS), "faux 不播种 providers.json");
	const addX = await postJson(
		"/api/v1/agent/providers",
		{ id: "x", name: "X", baseUrl: `http://127.0.0.1:${A_PORT}/v1`, keyEnv: "LLM_API_KEY", models: ["m1"] },
		FAUX_BASE,
	);
	check(addX.status === 200, "faux 下 CRUD 可用（新增）", String(addX.status));
	const addY = await postJson(
		"/api/v1/agent/providers",
		{ id: "y", name: "Y", baseUrl: `http://127.0.0.1:${A_PORT}/v1`, keyEnv: "LLM_API_KEY", models: ["m2"] },
		FAUX_BASE,
	);
	check(addY.status === 200, "faux 下 CRUD 可用（再加一个）", String(addY.status));
	const fauxCatalog = await (await fetch(`${FAUX_BASE}/api/v1/agent/model`)).json() as Record<string, unknown>;
	const fauxCurrent = fauxCatalog.current as { providerId?: string } | undefined;
	check(fauxCurrent?.providerId === "faux", "faux 的 current 是 faux", JSON.stringify(fauxCurrent));
	const fauxSwitch = await postJson("/api/v1/agent/model", { providerId: "x", modelId: "m1" }, FAUX_BASE);
	check(fauxSwitch.status === 400 && fauxSwitch.json.error === "faux", "faux 下切模型 400", JSON.stringify(fauxSwitch.json));
	const delFauxDefault = await fetch(`${FAUX_BASE}/api/v1/agent/providers/x`, { method: "DELETE" });
	check(delFauxDefault.status === 400, "faux 下默认供应商仍不能删", String(delFauxDefault.status));
	const delFauxY = await fetch(`${FAUX_BASE}/api/v1/agent/providers/y`, { method: "DELETE" });
	check(delFauxY.status === 200, "faux 下删非默认供应商", String(delFauxY.status));

	const realAfter = existsSync(REAL_PROVIDERS)
		? `${statSync(REAL_PROVIDERS).mtimeMs}:${statSync(REAL_PROVIDERS).size}`
		: "missing";
	check(realAfter === realBefore, "没有碰真实 .data/providers.json", realAfter);

	// ── 11. 重启后旧会话模型绑定（2026-11-07 扫尾批 2 / A2）────
	// 真起服务 → 真重启（provider.ts 模块重新求值、注册表重建）→ 旧会话 resume 续聊。
	// 修复前这一轮会报 no_model / not available；修复后变体随重建预注册，直接可解析。
	console.log("\n· 11. 重启（注册表重建）后旧会话模型引用直接可解析");
	fauxServer?.kill();
	fauxServer = null;
	await sleep(700);
	for (const path of [
		RESTART_DB,
		`${RESTART_DB}-wal`,
		`${RESTART_DB}-shm`,
		RESTART_MEMORY,
		RESTART_PROVIDERS,
		RESTART_RUNTIME,
	]) {
		rmSync(path, { force: true });
	}
	const restartEnv: NodeJS.ProcessEnv = {
		AGENT_DB_PATH: RESTART_DB,
		MEMORY_DB_PATH: RESTART_MEMORY,
		PROVIDERS_PATH: RESTART_PROVIDERS,
		MODEL_RUNTIME_PATH: RESTART_RUNTIME,
		// 目录里留一个从未被 chatModelRef 碰过的模型，验证预注册覆盖全目录（不只看当前选中）
		LLM_MODELS: `${MODEL},unused-model`,
	};
	server = startServer(restartEnv);
	await waitForReady();
	const oldSession = await chat(BASE);
	const oldId = oldSession.conversationId;
	check(Boolean(oldId), "建好一条旧会话（绑定派生变体 id）", String(oldId));

	server.kill();
	await sleep(700);
	server = startServer(restartEnv); // 真重启 → 注册表重建
	await waitForReady();
	const aBeforeResume = upstreamA.received.length;
	const resumed = await chat(BASE, oldId); // 旧会话 resume：不走创建路径、也不切档
	check(resumed.status === 200 && resumed.done, "重启后旧会话这一轮收尾", resumed.events.join(","));
	check(!resumed.events.includes("error"), "没有 no_model / not available 错误事件", resumed.error ?? "");
	check(resumed.text.includes("假上游"), "旧会话拿到了模型回复", resumed.text);
	check(
		upstreamA.received.length === aBeforeResume + 1,
		"这一轮真打到了 A",
		`A ${aBeforeResume} → ${upstreamA.received.length}`,
	);

	// 回滚开关：MODEL_VARIANT_PRESEEDED=false → 回到懒注册旧行为（用例能表达即可）
	server.kill();
	await sleep(700);
	server = startServer({ ...restartEnv, MODEL_VARIANT_PRESEEDED: "false" });
	await waitForReady();
	const rolledBack = await chat(BASE, oldId);
	check(rolledBack.status === 200, "回滚开关下请求本身不崩", String(rolledBack.status));
	check(
		rolledBack.events.includes("error") || !rolledBack.text,
		"MODEL_VARIANT_PRESEEDED=false 回到懒注册旧行为（旧会话模型不可用）",
		rolledBack.events.join(","),
	);
} finally {
	server.kill();
	fauxServer?.kill();
	await sleep(300);
	upstreamA.server.close();
	upstreamB.server.close();
	upstreamC.server.close();
	rmSync(DB, { force: true });
	rmSync(`${DB}-wal`, { force: true });
	rmSync(`${DB}-shm`, { force: true });
	rmSync(MEMORY_DB, { force: true });
	rmSync(PROVIDERS, { force: true });
	rmSync(RUNTIME, { force: true });
	rmSync(FAUX_PROVIDERS, { force: true });
	rmSync(".data/probe-providers-faux.sqlite", { force: true });
	rmSync(".data/probe-providers-faux-memory.db", { force: true });
	rmSync(RESTART_DB, { force: true });
	rmSync(`${RESTART_DB}-wal`, { force: true });
	rmSync(`${RESTART_DB}-shm`, { force: true });
	rmSync(RESTART_MEMORY, { force: true });
	rmSync(RESTART_PROVIDERS, { force: true });
	rmSync(RESTART_RUNTIME, { force: true });
}

console.log(failures === 0 ? "\n✓ 多供应商全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
