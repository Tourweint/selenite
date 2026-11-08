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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Ticket } from "../../../../../chancellor/src/types.ts";

const PORT = Number(process.env.PROBE_PORT ?? 8098);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = ".data/probe-http.sqlite";
const MEMORY_DB = ".data/probe-http-memory.db";
/** 项目登记表必须隔离：本探针会建工作区/项目，绝不能碰真实 .data/projects.sqlite */
const PROJECTS_DB = ".data/probe-http-projects.sqlite";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function startServer(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
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
			PROJECTS_DB_PATH: PROJECTS_DB,
			// 显式清空：别让开发机上的 env 混进探针（§15 会单独打开 false）
			CURRENT_PROJECT: "",
			// 播种会写 providers.json；探针必须隔离，别碰真实 .data
			PROVIDERS_PATH: ".data/probe-http-providers.json",
			// 执事库 / 家目录隔离：§18 会播种一个带 domain 的执事，绝不能碰真实 .data/partners.sqlite
			PARTNERS_DB_PATH: ".data/probe-http-partners.sqlite",
			PARTNER_HOMES_ROOT: ".data/probe-http-partner-homes",
			// 本机开发实例可能把权限档切成 read-only（.data/policy.json）；探针要验写工具链路，必须隔离
			AGENT_POLICY_PATH: ".data/probe-http-policy.json",
			// 本机 cookie 密钥（auth.ts 落盘保底）：探针起停多次服务，别碰真实 .data/local-secret
			AGENT_LOCAL_SECRET_PATH: ".data/probe-http-local-secret",
			NODE_OPTIONS: "",
			...extraEnv,
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
	/** SSE 里 error 事件的文本（撞工具上限走这条） */
	error?: string;
}

/** 收一条完整 SSE 流的全部帧（含 seq 与原始 JSON），给 seq 探针段用。 */
async function chatRaw(body: unknown): Promise<{
	status: number;
	frames: { type: string; seq?: number; raw: Record<string, unknown> }[];
	conversationId?: string;
}> {
	const response = await fetch(`${BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status !== 200) return { status: response.status, frames: [] };
	const raw = await response.text();
	const frames: { type: string; seq?: number; raw: Record<string, unknown> }[] = [];
	let conversationId: string | undefined;
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const parsed = JSON.parse(line.slice(5).trim()) as Record<string, unknown> & {
			type: string;
			seq?: number;
			conversationId?: string;
		};
		frames.push({ type: parsed.type, seq: parsed.seq, raw: parsed });
		if (parsed.type === "start") conversationId = parsed.conversationId;
	}
	return { status: response.status, frames, conversationId };
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
			message?: string;
			conversationId?: string;
		};
		result.events.push(payload.type);
		if (payload.type === "start") result.conversationId = payload.conversationId;
		if (payload.type === "delta") result.text += payload.text ?? "";
		if (payload.type === "error") result.error = payload.message;
		if (payload.type === "done") result.done = true;
	}
	return { status: response.status, result };
}

rmSync(DB, { force: true });
rmSync(MEMORY_DB, { force: true });
rmSync(PROJECTS_DB, { force: true });
// seq 事件库也走探针路径，别污染真实 .data/chat-events.sqlite
const SEQ_DB = ".data/probe-http-chat-events.sqlite";
rmSync(SEQ_DB, { force: true });

// ── 当前项目 / 路径守卫用的假上游 ─────────────────────────
// faux 发不出带参数的 write 调用（LLM_FAUX_TOOL 只会给空对象），所以这里起一个
// 真 HTTP 假上游：第一轮回一个 write 工具调用（路径由 gateWritePath 控制），
// 工具结果回来后的第二轮回文本。路径守卫是真装配、真工具、真 SSE 验的。
const UPSTREAM_PORT = PORT + 1;
const UPSTREAM_BASE = `http://127.0.0.1:${UPSTREAM_PORT}`;
const WORKSPACE_A = resolve(".data/probe-http-workspace-a");
const WORKSPACE_B = resolve(".data/probe-http-workspace-b");
const GATE_PROJECT_NAME = "探针项目";
const GATE_PROJECT_REL = "demo";
const GATE_PROJECT_DIR = join(WORKSPACE_A, GATE_PROJECT_REL);
const GATE_INSIDE_REL = "inside-guard.txt";
const GATE_OUTSIDE_DIR = resolve(".data/probe-http-outside");
const GATE_OUTSIDE_FILE = join(GATE_OUTSIDE_DIR, "escape.txt");

interface GateRequest {
	body: Record<string, unknown>;
	at: number;
}
const gateRequests: GateRequest[] = [];
/** 假上游收到的 GET /models 的 Authorization 头（§16 密钥热注入验证） */
const gateModelsAuth: string[] = [];
/** 假上游下一轮 write 要写哪（空字符串 = 只回文本） */
let gateWritePath = "";

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((done) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => done(raw));
	});
}

function sseChunk(response: ServerResponse, payload: unknown): void {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function contentTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
}

const gateUpstream: Server = createServer(async (request, response) => {
	if (request.method === "GET") {
		// §16 密钥探针：modelsUrl 代拉清单。这里只关心 Authorization 是否等于刚填的 key。
		if (request.url?.endsWith("/models")) {
			gateModelsAuth.push(request.headers.authorization ?? "");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "probe-secret-model" }] }));
			return;
		}
		response.writeHead(404).end();
		return;
	}
	if (request.method !== "POST") {
		response.writeHead(404).end();
		return;
	}
	const raw = await readRequestBody(request);
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		/* 记空对象，断言自然会挂 */
	}
	gateRequests.push({ body, at: Date.now() });

	const messages = messagesOf(body);
	// 已经有工具结果 → 这是同一轮的第二跳，回文本收尾（否则会一直调工具到上限）
	const hasToolResult = messages.some((message) => message.role === "tool");
	const base = {
		id: "chatcmpl-gate",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: String(body.model ?? "probe-gate"),
	};
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	if (!hasToolResult && gateWritePath) {
		sseChunk(response, {
			...base,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call_gate_1",
								type: "function",
								function: {
									name: "write",
									arguments: JSON.stringify({ path: gateWritePath, content: "probe" }),
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		});
		sseChunk(response, {
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});
	} else {
		sseChunk(response, {
			...base,
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		});
		sseChunk(response, {
			...base,
			choices: [{ index: 0, delta: { content: "（假上游）已处理。" }, finish_reason: null }],
		});
		sseChunk(response, {
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});
	}
	response.write("data: [DONE]\n\n");
	response.end();
});

let server = startServer({ AGENT_SSE_SEQ_DB_PATH: SEQ_DB });

try {
	await waitForReady();

	// ── 1. 新建会话 ───────────────────────────────────
	console.log("\n· 1. 首轮对话（新建会话）");
	const first = await chat({ messages: [{ role: "user", content: "我养了一只叫团子的猫" }] });
	const externalId = first.result.conversationId;
	check(first.status === 200, "HTTP 200", String(first.status));
	check(Boolean(externalId), "服务端下发了 conversationId", externalId);
	if (!externalId) throw new Error("首轮对话没拿到 conversationId，后面的检查没法做");
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

	// ── 6. 客户端跑掉，那一轮还得跑完 ─────────────────
	console.log("\n· 6. 客户端中途断开，服务端继续跑完并落库");

	const readMessages = async (id: string) =>
		(
			(await (await fetch(`${BASE}/api/v1/agent/chat/${id}/messages`)).json()) as {
				messages: { role: string; text: string }[];
			}
		).messages;

	const before = await readMessages(externalId);

	const runaway = new AbortController();
	const dropped = fetch(`${BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			conversationId: externalId,
			messages: [{ role: "user", content: "关掉界面也别停" }],
		}),
		signal: runaway.signal,
	}).then((response) => response.text());
	await sleep(40);
	runaway.abort();
	await dropped.catch(() => undefined);

	// 断线时对话还没生成完。接下来不给任何"继续"的指令，只是读——
	// 如果服务端跟着 socket 一起 abort 了，这里永远等不到新的回答。
	let after = before;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await sleep(100);
		after = await readMessages(externalId);
		if (after.length > before.length) break;
	}
	check(
		after.length === before.length + 2,
		"客户端断开后，服务端仍把这一轮跑完并入库",
		`${before.length} → ${after.length} 条`,
	);
	check(
		after.at(-1)?.role === "assistant",
		"补上了那条回答",
		after.at(-1)?.text.slice(0, 12),
	);

	// ── 7. 手动停止 ───────────────────────────────────
	console.log("\n· 7. 手动停止（这是人的意图，不是断线的副作用）");
	const stopped = await fetch(`${BASE}/api/v1/agent/chat/${externalId}/stop`, { method: "POST" });
	check(stopped.status === 200, "停止接口可用", String(stopped.status));

	const afterStop = await chat({
		conversationId: externalId,
		messages: [{ role: "user", content: "停完再聊一句" }],
	});
	check(afterStop.status === 200, "停完之后还能开新一轮", String(afterStop.status));

	// ── 7.5 让助手说一句（回顾页钩子，2026-11-01）───────
	console.log("\n· 7.5 让助手主动说一句（不调模型）");
	const sayText = "新版本装好之后的回读，结果跟预期一样吗？";
	const said = await fetch(`${BASE}/api/v1/agent/chat/${externalId}/say`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: sayText }),
	});
	check(said.status === 201, "/say 写入成功", String(said.status));
	const afterSay = await readMessages(externalId);
	check(
		afterSay.at(-1)?.role === "assistant" && afterSay.at(-1)?.text === sayText,
		"回读能看到这条 assistant 消息",
		afterSay.at(-1)?.text.slice(0, 12),
	);
	const sayBad = await fetch(`${BASE}/api/v1/agent/chat/${externalId}/say`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "   " }),
	});
	check(sayBad.status === 400, "空文本 → 400", String(sayBad.status));

	// 新对话开一句（回顾页钩子的现行口径）
	const newSay = await fetch(`${BASE}/api/v1/agent/say`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "这个新对话的第一句" }),
	});
	check(newSay.status === 201, "/say 新建会话成功", String(newSay.status));
	const newId = ((await newSay.json()) as { conversationId?: string }).conversationId ?? "";
	const newMessages = await readMessages(newId);
	check(
		newMessages.length === 1 && newMessages[0]?.role === "assistant",
		"新会话里只有助手这一句",
		`${newMessages.length} 条 / ${newMessages[0]?.role}`,
	);

	// ── 8. 读历史 ─────────────────────────────────────
	console.log("\n· 8. 读历史接口");
	const transcript = (await (
		await fetch(`${BASE}/api/v1/agent/chat/${externalId}/messages`)
	).json()) as { messages: { role: string; text: string }[] };
	check(
		transcript.messages.length >= 6,
		"历史条数对得上（3 问 3 答）",
		String(transcript.messages.length),
	);
	check(
		transcript.messages.some((message) => message.role === "assistant" && message.text.length > 0),
		"有模型回答",
	);

	// ── 9. 重启后会话还在 ─────────────────────────────
	console.log("\n· 9. 重启进程，历史还在");
	server.kill();
	await sleep(800);
	server = startServer({ AGENT_SSE_SEQ_DB_PATH: SEQ_DB });
	await waitForReady();

	const resumed = await chat({
		conversationId: externalId,
		messages: [{ role: "user", content: "还记得我吗？" }],
	});
	check(resumed.status === 200, "重启后同一 conversationId 仍可用", String(resumed.status));
	check(resumed.result.conversationId === externalId, "id 一致");

	// ── 10. 工具回合上限 ──────────────────────────────
	// 换一个"只会调工具、永远不收尾"的假模型，上限压到 3 轮，
	// 验证撞上限之后既不无限跑，又能给出人话提示。
	console.log("\n· 10. 工具调用撞上限");
	server.kill();
	await sleep(800);
	server = startServer({ LLM_FAUX_TOOL: "recall", AGENT_MAX_TURNS: "3", AGENT_SSE_SEQ_DB_PATH: SEQ_DB });
	await waitForReady();

	const startedAt = Date.now();
	const limited = await chat({ messages: [{ role: "user", content: "一直调工具试试" }] });
	const costMs = Date.now() - startedAt;

	check(limited.result.done, "流正常收尾（没有挂死）", `${costMs}ms`);
	check(
		limited.result.error === "工具调用已达到上限，请重新发送请求。",
		"给出了约定的提示",
		limited.result.error ?? "(没有 error 事件)",
	);
	check(costMs < 15_000, "没有无限跑下去", `${costMs}ms`);

	// 撞上限不是死路：再发一句就是新一轮，预算重新算
	const afterLimit = await chat({
		conversationId: limited.result.conversationId,
		messages: [{ role: "user", content: "再来一轮" }],
	});
	check(afterLimit.status === 200, "撞上限之后还能继续发", String(afterLimit.status));
	check(
		afterLimit.result.done && afterLimit.result.events.includes("start"),
		"新一轮拿到了新预算（不是直接被拒）",
		afterLimit.result.events.join(","),
	);

	// ── 11. 运行时切模型（2026-11-04，接口文档 §2.8）──
	// faux / mock 没有可切的真实模型 → 400；真实配置下可切、可持久、可一键回滚。
	console.log("\n· 11. 运行时切模型");
	const fauxHealth = (await (await fetch(`${BASE}/healthz`)).json()) as {
		llm: string;
		model: string | null;
		models: string[];
	};
	check(fauxHealth.model === "faux", "faux 下 healthz 报 faux", JSON.stringify(fauxHealth));
	check(fauxHealth.models.length === 0, "faux 没有可切清单");

	// faux 下 /mode 是空操作但仍返回 ok（chatModelRef 原样返回，不派生思考变体）
	const fauxMode = await fetch(
		`${BASE}/api/v1/agent/chat/${limited.result.conversationId}/mode`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ thinking: "high" }),
		},
	);
	const fauxModeJson = (await fauxMode.json().catch(() => ({}))) as Record<string, unknown>;
	check(
		fauxMode.status === 200 && fauxModeJson.ok === true && fauxModeJson.thinking === "high",
		"faux 下 /mode 空操作仍 ok",
		`${fauxMode.status} ${JSON.stringify(fauxModeJson)}`,
	);

	const fauxSwitch = await fetch(`${BASE}/api/v1/agent/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "whatever" }),
	});
	check(fauxSwitch.status === 400, "faux 下切换被拒", String(fauxSwitch.status));

	const modelState = ".data/probe-http-model.json";
	const modelEnv = {
		LLM_PROVIDER: "",
		LLM_API_KEY: "dummy-key-for-model-probe",
		LLM_MODEL: "probe-default",
		LLM_MODELS: "probe-a,probe-b",
		MODEL_RUNTIME_PATH: modelState,
		// 后面 §13 的 seq 探针还在这批重启出来的服务上跑：seq 库路径必须一路带下去，
		// 否则回落默认路径，§13 的 seq 会从其他段落留下的帧接着数（实测踩过）。
		AGENT_SSE_SEQ_DB_PATH: SEQ_DB,
	};
	rmSync(modelState, { force: true });
	server.kill();
	await sleep(800);
	server = startServer(modelEnv);
	await waitForReady();

	interface ModelHealth {
		llm: string;
		model: string | null;
		models: string[];
	}
	const health2 = (await (await fetch(`${BASE}/healthz`)).json()) as ModelHealth;
	check(health2.model === "probe-default", "默认模型来自 env", String(health2.model));
	check(
		JSON.stringify([...health2.models].sort()) ===
			JSON.stringify(["probe-a", "probe-b", "probe-default"]),
		"清单 = LLM_MODELS ∪ 当前模型",
		JSON.stringify(health2.models),
	);

	// 2026-11-04 思考档位：composer 的 models 行升级为对象；POST 响应保持扁平字符串（旧字段兼容）
	const catalog = (await (await fetch(`${BASE}/api/v1/agent/model`)).json()) as {
		providers?: { models?: { id?: string; thinkingLevels?: string[] }[] }[];
	};
	const catalogModels = catalog.providers?.[0]?.models ?? [];
	check(
		catalogModels.length > 0 && catalogModels.every((row) => Array.isArray(row?.thinkingLevels)),
		"GET /agent/model 的 models 是 {id, thinkingLevels} 对象行",
		JSON.stringify(catalogModels[0]),
	);
	check(
		JSON.stringify(catalogModels[0]?.thinkingLevels) === JSON.stringify(["off", "low", "high"]),
		"没声明 modelThinkingLevels 的模型缺省域 = off/low/high",
		JSON.stringify(catalogModels[0]?.thinkingLevels),
	);

	const switched = await fetch(`${BASE}/api/v1/agent/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "probe-b" }),
	});
	check(switched.status === 200, "切换成功", String(switched.status));
	const switchedJson = (await switched.json().catch(() => ({}))) as { models?: unknown };
	check(
		Array.isArray(switchedJson.models) && switchedJson.models.every((row) => typeof row === "string"),
		"POST /agent/model 的 models 仍是扁平字符串（旧字段兼容）",
		JSON.stringify(switchedJson.models),
	);
	const health3 = (await (await fetch(`${BASE}/healthz`)).json()) as ModelHealth;
	check(health3.model === "probe-b", "healthz 跟着变", String(health3.model));

	const unknown = await fetch(`${BASE}/api/v1/agent/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "not-in-list" }),
	});
	check(unknown.status === 400, "不在清单里 → 400", String(unknown.status));

	// 重启后覆盖值还在（文件里只存模型 id，无密钥）
	server.kill();
	await sleep(800);
	server = startServer(modelEnv);
	await waitForReady();
	const health4 = (await (await fetch(`${BASE}/healthz`)).json()) as ModelHealth;
	check(health4.model === "probe-b", "重启后覆盖值还在", String(health4.model));

	// 回滚开关：MODEL_RUNTIME_OVERRIDE=false 时启动忽略覆盖值、接口一律拒绝
	server.kill();
	await sleep(800);
	server = startServer({ ...modelEnv, MODEL_RUNTIME_OVERRIDE: "false" });
	await waitForReady();
	const health5 = (await (await fetch(`${BASE}/healthz`)).json()) as ModelHealth;
	check(health5.model === "probe-default", "开关关掉时回到 env 默认", String(health5.model));
	check(health5.models.length === 0, "开关关掉时清单为空");
	const denied = await fetch(`${BASE}/api/v1/agent/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "probe-a" }),
	});
	check(denied.status === 400, "开关关掉时切换被拒", String(denied.status));
	rmSync(modelState, { force: true });

	// ── 12. 上下文占用与内容搜索（批次二）──
	console.log("\n· 12. 上下文占用与内容搜索");
	// faux 也给 usage（前面日志口径），所以 used 应该是真实测量值
	const ctxResponse = await fetch(`${BASE}/api/v1/agent/chat/${externalId}/context`);
	check(ctxResponse.status === 200, "context 端点可用", String(ctxResponse.status));
	const ctx = (await ctxResponse.json()) as { used: number | null; window: number | null };
	check(typeof ctx.used === "number" && ctx.used > 0, "used 来自最后一次请求的 usage", JSON.stringify(ctx));
	check(
		typeof ctx.window === "number" && ctx.window > 0,
		"window 来自模型目录",
		String(ctx.window),
	);
	const ctxMissing = await fetch(
		`${BASE}/api/v1/agent/chat/00000000-0000-4000-8000-000000000000/context`,
	);
	check(ctxMissing.status === 404, "未知会话 → 404", String(ctxMissing.status));

	const searchResponse = await fetch(`${BASE}/api/v1/agent/search?q=${encodeURIComponent("团子")}`);
	check(searchResponse.status === 200, "search 端点可用", String(searchResponse.status));
	const search = (await searchResponse.json()) as {
		hits: { conversationId: string; text: string }[];
	};
	check(
		search.hits.some((hit) => hit.conversationId === externalId),
		"搜到首轮那句「团子」",
		JSON.stringify(search.hits[0] ?? null).slice(0, 90),
	);
	const searchShort = await fetch(`${BASE}/api/v1/agent/search?q=${encodeURIComponent("团")}`);
	const shortBody = (await searchShort.json()) as { hits: unknown[] };
	check(shortBody.hits.length === 0, "单字符 → 空结果（防全表扫）");

	// ── 13. SSE seq 与断点重放（2026-11-04，接口文档 §2.1/§2.2）──
	console.log("\n· 13. SSE seq 与断点重放");
	// 13.1 新会话跑一轮，帧带 seq 且从 1 单调递增
	const seqRound = await chatRaw({
		messages: [{ role: "user", content: "seq 探针第一轮" }],
	});
	check(seqRound.status === 200, "seq 轮建流成功", String(seqRound.status));
	const seqs = seqRound.frames.map((frame) => frame.seq);
	check(
		seqs.every((value) => typeof value === "number"),
		"每一帧都带 seq",
		JSON.stringify(seqs),
	);
	const monotonic = seqs.every(
		(value, index) => index === 0 || (typeof value === "number" && typeof seqs[index - 1] === "number" && value === (seqs[index - 1] as number) + 1),
	);
	check(monotonic, "seq 严格连续 +1（会话内单调）", `${seqs[0]}..${seqs.at(-1)}`);
	check(seqs[0] === 1, "从 1 起");
	const seqConversationId = seqRound.conversationId ?? "";

	// 13.2 sinceSeq 补帧：sinceSeq=0 → 全量重放，fromSeq=1
	const fullReplay = await fetch(
		`${BASE}/api/v1/agent/chat/${seqConversationId}/messages?sinceSeq=0`,
	);
	check(fullReplay.status === 200, "带 sinceSeq 回读成功", String(fullReplay.status));
	const fullBody = (await fullReplay.json()) as {
		messages: unknown[];
		fromSeq: number;
		events: { event: { type: string; seq?: number } }[];
	};
	check(Array.isArray(fullBody.messages), "messages 字段还在（不破坏老形状；faux 上游报错时可为空）");
	check(fullBody.fromSeq === 1, "fromSeq=1（无缺口）", String(fullBody.fromSeq));
	check(
		fullBody.events.length === seqs.length,
		"重放帧数与实发一致",
		`${fullBody.events.length} vs ${seqs.length}`,
	);
	check(
		fullBody.events.every((item, index) => item.event.seq === seqs[index]),
		"重放 seq 与实发一一对应",
	);
	// 13.3 从中段补：sinceSeq=3 → 只剩 4..N
	const midReplay = (await (
		await fetch(`${BASE}/api/v1/agent/chat/${seqConversationId}/messages?sinceSeq=3`)
	).json()) as { fromSeq: number; events: { event: { seq?: number } }[] };
	check(midReplay.fromSeq === 4, "中段重放 fromSeq=4", String(midReplay.fromSeq));
	check(
		midReplay.events.length === Math.max(0, seqs.length - 3),
		"中段重放只取缺帧",
		String(midReplay.events.length),
	);
	// 13.4 不带 sinceSeq → 响应没有 events 字段（老形状）
	const plain = (await (
		await fetch(`${BASE}/api/v1/agent/chat/${seqConversationId}/messages`)
	).json()) as { events?: unknown };
	check(!("events" in plain), "不带 sinceSeq 无 events 字段（老客户端零感知）");

	// 13.5 非法 sinceSeq → 400
	const badReplay = await fetch(
		`${BASE}/api/v1/agent/chat/${seqConversationId}/messages?sinceSeq=-1`,
	);
	check(badReplay.status === 400, "非法 sinceSeq → 400", String(badReplay.status));

	// ── 14. 当前项目（2026-11-04 侧边栏方案，接口文档 §2.7）──
	console.log("\n· 14. 当前项目：切换 / 校验 / 系统提示 / 路径守卫");
	rmSync(WORKSPACE_A, { recursive: true, force: true });
	rmSync(WORKSPACE_B, { recursive: true, force: true });
	rmSync(GATE_OUTSIDE_DIR, { recursive: true, force: true });
	mkdirSync(WORKSPACE_A, { recursive: true });
	mkdirSync(WORKSPACE_B, { recursive: true });
	mkdirSync(GATE_OUTSIDE_DIR, { recursive: true });
	rmSync(".data/probe-http-gate-providers.json", { force: true });
	rmSync(".data/probe-http-gate-runtime.json", { force: true });
	await new Promise<void>((done) => gateUpstream.listen(UPSTREAM_PORT, "127.0.0.1", () => done()));

	// 真供应商 + 假上游：能发带 path 参数的 write 调用
	const gateEnv: NodeJS.ProcessEnv = {
		LLM_PROVIDER: "",
		LLM_API_KEY: "probe-gate-key",
		LLM_BASE_URL: `${UPSTREAM_BASE}/v1`,
		LLM_MODEL: "probe-gate",
		LLM_MODELS: "",
		LLM_MODEL_FAST: "",
		PROVIDERS_PATH: ".data/probe-http-gate-providers.json",
		MODEL_RUNTIME_PATH: ".data/probe-http-gate-runtime.json",
		MEMORY_ENABLED: "false",
		CHANCELLOR_ENABLED: "false",
		AGENT_CONFIRM_WRITES: "",
		AGENT_SSE_SEQ_DB_PATH: SEQ_DB,
	};
	server.kill();
	await sleep(800);
	server = startServer(gateEnv);
	await waitForReady();

	const putCurrentProject = (projectId: string | null) =>
		fetch(`${BASE}/api/v1/workspaces/current-project`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId }),
		});
	const readWorkspaceState = async () =>
		(await (await fetch(`${BASE}/api/v1/workspaces`)).json()) as {
			workspace: { rootPath: string } | null;
			currentProjectId: string | null;
		};
	const setWorkspace = (rootPath: string) =>
		fetch(`${BASE}/api/v1/workspaces`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rootPath }),
		});
	const toolMessagesOf = (body: Record<string, unknown>) =>
		messagesOf(body)
			.filter((message) => message.role === "tool")
			.map((message) => contentTextOf(message.content))
			.join("\n");
	const systemMessagesOf = (body: Record<string, unknown>) =>
		messagesOf(body)
			.filter((message) => message.role === "system")
			.map((message) => contentTextOf(message.content))
			.join("\n");

	// 14.1 建工作区 → 登记项目
	const workspaceSet = await setWorkspace(WORKSPACE_A);
	check(workspaceSet.status === 200, "设置工作区 A", String(workspaceSet.status));
	const proposalResponse = await fetch(`${BASE}/api/v1/projects`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: GATE_PROJECT_NAME, path: GATE_PROJECT_REL }),
	});
	const proposalJson = (await proposalResponse.json()) as { proposal?: { id?: string } };
	const proposalId = proposalJson.proposal?.id ?? "";
	check(
		proposalResponse.status === 202 && Boolean(proposalId),
		"提交项目 proposal",
		`${proposalResponse.status} ${proposalId}`,
	);
	const confirmResponse = await fetch(`${BASE}/api/v1/projects/${proposalId}/confirm`, {
		method: "POST",
	});
	const confirmJson = (await confirmResponse.json()) as { project?: { id?: string } };
	const projectId = confirmJson.project?.id ?? "";
	check(
		confirmResponse.status === 200 && Boolean(projectId),
		"确认后登记项目",
		projectId,
	);
	check(existsSync(GATE_PROJECT_DIR), "项目目录已建在工作区内");

	// 14.2 切换成功 + 回读 + null 回主工作区
	const initial = await readWorkspaceState();
	check(initial.currentProjectId === null, "初始 currentProjectId=null（主工作区）");
	const projectSwitched = await putCurrentProject(projectId);
	const projectSwitchedJson = (await projectSwitched.json()) as {
		ok?: boolean;
		projectId?: string | null;
	};
	check(
		projectSwitched.status === 200 &&
			projectSwitchedJson.ok === true &&
			projectSwitchedJson.projectId === projectId,
		"PUT 切换当前项目成功",
		`${projectSwitched.status} ${JSON.stringify(projectSwitchedJson)}`,
	);
	check(
		(await readWorkspaceState()).currentProjectId === projectId,
		"GET /workspaces 回读 currentProjectId 正确",
	);
	const cleared = await putCurrentProject(null);
	const clearedJson = (await cleared.json()) as { ok?: boolean; projectId?: string | null };
	check(
		cleared.status === 200 && clearedJson.ok === true && clearedJson.projectId === null,
		"projectId=null 回主工作区",
	);

	// 14.3 校验错误码（逐条按契约）
	const unknownResponse = await putCurrentProject("00000000-0000-4000-8000-000000000001");
	const unknownJson = (await unknownResponse.json()) as { error?: string };
	check(
		unknownResponse.status === 400 && unknownJson.error === "unknown_project",
		"未登记项目 → 400 unknown_project",
		`${unknownResponse.status} ${unknownJson.error}`,
	);

	rmSync(GATE_PROJECT_DIR, { recursive: true, force: true });
	const missingResponse = await putCurrentProject(projectId);
	const missingJson = (await missingResponse.json()) as { error?: string };
	check(
		missingResponse.status === 400 && missingJson.error === "project_missing",
		"目录不存在 → 400 project_missing",
		`${missingResponse.status} ${missingJson.error}`,
	);
	mkdirSync(GATE_PROJECT_DIR, { recursive: true });

	const workspaceBSet = await setWorkspace(WORKSPACE_B);
	check(workspaceBSet.status === 200, "换工作区 B（旧项目落在新根外）");
	const outsideResponse = await putCurrentProject(projectId);
	const outsideJson = (await outsideResponse.json()) as { error?: string };
	check(
		outsideResponse.status === 400 && outsideJson.error === "outside_workspace",
		"工作区外 → 400 outside_workspace",
		`${outsideResponse.status} ${outsideJson.error}`,
	);
	const backToA = await setWorkspace(WORKSPACE_A);
	check(backToA.status === 200, "切回工作区 A");
	const reselected = await putCurrentProject(projectId);
	check(reselected.status === 200, "切回工作区后可再次选中", String(reselected.status));

	// 14.4 系统提示注入 + 工作区内写入放行（相对路径按项目根解析）
	gateWritePath = GATE_INSIDE_REL;
	gateRequests.length = 0;
	const insideRun = await chat({ messages: [{ role: "user", content: "在项目里写个文件" }] });
	check(
		insideRun.status === 200 && insideRun.result.done,
		"假上游 + 当前项目链路跑完",
		insideRun.result.events.join(","),
	);
	check(
		existsSync(join(GATE_PROJECT_DIR, GATE_INSIDE_REL)),
		"工作区内相对路径放行（落在当前项目根）",
		join(GATE_PROJECT_DIR, GATE_INSIDE_REL),
	);
	const insideBody = gateRequests.at(-1)?.body ?? {};
	check(
		!toolMessagesOf(insideBody).includes("最大工作区"),
		"放行时没有越界提示",
	);
	const insideSystem = systemMessagesOf(insideBody);
	check(
		insideSystem.includes(`当前项目：${GATE_PROJECT_NAME}`),
		"系统提示注入了当前项目（项目名）",
		insideSystem.includes("当前项目") ? "含当前项目节" : "缺当前项目节",
	);
	check(insideSystem.includes("根路径："), "系统提示带项目根路径");

	// 14.5 路径守卫：越界写被拒（真工具，不是 mock）
	gateWritePath = GATE_OUTSIDE_FILE;
	gateRequests.length = 0;
	const outsideRun = await chat({ messages: [{ role: "user", content: "写到工作区外面去" }] });
	check(
		outsideRun.status === 200 && outsideRun.result.done,
		"越界调用不会挂死这一轮",
		outsideRun.result.events.join(","),
	);
	check(!existsSync(GATE_OUTSIDE_FILE), "越界写入没有落盘", GATE_OUTSIDE_FILE);
	const outsideToolText = toolMessagesOf(gateRequests.at(-1)?.body ?? {});
	check(
		outsideToolText.includes("路径越出最大工作区"),
		"模型收到的工具结果含「路径越出最大工作区」",
		outsideToolText.slice(0, 120),
	);

	// ── 15. CURRENT_PROJECT=false 回滚（接口文档 §2.7）──
	console.log("\n· 15. CURRENT_PROJECT=false 回滚");
	server.kill();
	await sleep(800);
	server = startServer({ ...gateEnv, CURRENT_PROJECT: "false" });
	await waitForReady();
	check(
		(await readWorkspaceState()).currentProjectId === null,
		"回滚时 GET 的 currentProjectId 恒 null（库里的值不外露）",
	);
	const disabledResponse = await putCurrentProject(projectId);
	const disabledJson = (await disabledResponse.json()) as { error?: string };
	check(
		disabledResponse.status === 400 && disabledJson.error === "current_project_disabled",
		"回滚时 PUT 一律 400 current_project_disabled",
		`${disabledResponse.status} ${disabledJson.error}`,
	);
	gateWritePath = "";
	gateRequests.length = 0;
	await chat({ messages: [{ role: "user", content: "回滚形态还能正常聊" }] });
	check(
		!systemMessagesOf(gateRequests.at(-1)?.body ?? {}).includes("当前项目："),
		"回滚时系统提示不注入当前项目节",
	);
	// ── 16. 密钥直填（2026-11-05 H2，接口文档 §2.10）──
	console.log("\n· 16. 密钥直填：PUT secret → 密钥文件 + 热注入");
	const SECRET_KEY = "probe-plain-secret-9f3a7c";
	const SECRET_PROVIDERS = ".data/probe-http-secret-providers.json";
	const SECRET_KEYS = ".data/probe-http-provider-keys.json";
	const SECRET_RUNTIME = ".data/probe-http-secret-runtime.json";
	rmSync(SECRET_PROVIDERS, { force: true });
	rmSync(SECRET_KEYS, { force: true });
	rmSync(SECRET_RUNTIME, { force: true });
	const secretEnv: NodeJS.ProcessEnv = {
		LLM_PROVIDER: "",
		LLM_API_KEY: "probe-seed-key",
		LLM_BASE_URL: `${UPSTREAM_BASE}/v1/seed`,
		LLM_MODEL: "probe-secret-default",
		LLM_MODELS: "",
		LLM_MODEL_FAST: "",
		PROVIDERS_CONFIG: "true",
		PROVIDER_SECRETS: "true",
		PROVIDERS_PATH: SECRET_PROVIDERS,
		PROVIDER_KEYS_PATH: SECRET_KEYS,
		MODEL_RUNTIME_PATH: SECRET_RUNTIME,
		MEMORY_ENABLED: "false",
		CHANCELLOR_ENABLED: "false",
		AGENT_SSE_SEQ_DB_PATH: SEQ_DB,
		// 父进程若碰巧有同名变量会遮住密钥文件；先清空，保证断言验的是热注入
		LIFEDIARY_KEY_SECRET_PROBE: "",
		LIFEDIARY_KEY_ALIAS_PROBE: "",
	};
	server.kill();
	await sleep(800);
	server = startServer(secretEnv);
	await waitForReady();

	const putSecret = (id: string, apiKey: unknown) =>
		fetch(`${BASE}/api/v1/agent/providers/${id}/secret`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ apiKey }),
		});
	const readProviders = async () =>
		(await (await fetch(`${BASE}/api/v1/agent/providers`)).json()) as {
			providers: { id: string; keyEnv: string; hasKey: boolean }[];
		};

	// 16.1 准备一个 keyEnv 还没值的供应商
	const createdSecret = await fetch(`${BASE}/api/v1/agent/providers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			id: "secret-probe",
			name: "密钥探针",
			baseUrl: `${UPSTREAM_BASE}/v1/secret`,
			keyEnv: "PROBE_SECRET_PLACEHOLDER",
			models: ["probe-secret-model"],
		}),
	});
	check(createdSecret.status === 200, "新建待填密钥的供应商", String(createdSecret.status));
	const beforeSecret = await readProviders();
	check(
		beforeSecret.providers.find((provider) => provider.id === "secret-probe")?.hasKey === false,
		"填之前 hasKey=false",
	);

	// 16.2 校验错误码
	const unknownSecret = await putSecret("no-such-provider", SECRET_KEY);
	const unknownSecretJson = (await unknownSecret.json()) as { error?: string };
	check(
		unknownSecret.status === 404 && unknownSecretJson.error === "unknown_provider",
		"未知供应商 → 404 unknown_provider",
		`${unknownSecret.status} ${unknownSecretJson.error}`,
	);
	const emptySecret = await putSecret("secret-probe", "   ");
	check(emptySecret.status === 400, "空密钥 → 400", String(emptySecret.status));
	const longSecret = await putSecret("secret-probe", "k".repeat(513));
	check(longSecret.status === 400, "超过 512 字符 → 400", String(longSecret.status));

	// 16.3 成功：只回 keyEnv，不回密钥；三处落点都对
	const okSecret = await putSecret("secret-probe", `  ${SECRET_KEY}  `);
	const okSecretText = await okSecret.text();
	const okSecretJson = JSON.parse(okSecretText) as { ok?: boolean; keyEnv?: string };
	check(okSecret.status === 200 && okSecretJson.ok === true, "PUT secret 成功", String(okSecret.status));
	check(
		okSecretJson.keyEnv === "LIFEDIARY_KEY_SECRET_PROBE",
		"绑定 keyEnv = LIFEDIARY_KEY_<ID大写>",
		String(okSecretJson.keyEnv),
	);
	check(!okSecretText.includes(SECRET_KEY), "PUT 响应不含密钥值（trim 后落盘）");

	const providersResponse = await fetch(`${BASE}/api/v1/agent/providers`);
	const providersRaw = await providersResponse.text();
	const providersJson = JSON.parse(providersRaw) as {
		providers: { id: string; keyEnv: string; hasKey: boolean }[];
	};
	check(
		providersJson.providers.find((provider) => provider.id === "secret-probe")?.hasKey === true,
		"GET /agent/providers 的 hasKey 变 true",
	);
	check(
		providersJson.providers.find((provider) => provider.id === "secret-probe")?.keyEnv ===
			"LIFEDIARY_KEY_SECRET_PROBE",
		"provider 的 keyEnv 已同步",
	);
	check(!providersRaw.includes(SECRET_KEY), "GET /agent/providers 全文无密钥明文");

	const providersFileText = readFileSync(SECRET_PROVIDERS, "utf8");
	check(!providersFileText.includes(SECRET_KEY), "providers.json 全文无密钥明文");
	check(
		providersFileText.includes("LIFEDIARY_KEY_SECRET_PROBE"),
		"providers.json 仍只存变量名",
	);
	check(existsSync(SECRET_KEYS), "密钥文件已生成", SECRET_KEYS);
	const keyFile = JSON.parse(readFileSync(SECRET_KEYS, "utf8")) as Record<string, string>;
	check(
		keyFile.LIFEDIARY_KEY_SECRET_PROBE === SECRET_KEY,
		"密钥文件含该条目（keyEnv → 明文）",
		"LIFEDIARY_KEY_SECRET_PROBE",
	);

	// 16.4 热注入生效：modelsUrl 代拉清单时，假上游收到刚填的 key
	gateModelsAuth.length = 0;
	const secretTest = await fetch(`${BASE}/api/v1/agent/providers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			id: "secret-probe",
			name: "密钥探针",
			baseUrl: `${UPSTREAM_BASE}/v1/secret`,
			keyEnv: "LIFEDIARY_KEY_SECRET_PROBE",
			modelsUrl: "1",
			test: true,
		}),
	});
	check(secretTest.status === 200, "test:true 用热注入的 key 拉到上游", String(secretTest.status));
	check(
		gateModelsAuth.at(-1) === `Bearer ${SECRET_KEY}`,
		"假上游收到 Authorization: Bearer <刚填的key>",
		gateModelsAuth.length > 0 ? "Bearer <redacted>" : "假上游没收到请求",
	);

	// 16.5 空清单放行（2026-11-05 H2.1）：带 modelsUrl 时代拉，不带仍拒
	const emptyWithUrl = await fetch(`${BASE}/api/v1/agent/providers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			id: "empty-models-probe",
			name: "空清单代拉探针",
			baseUrl: `${UPSTREAM_BASE}/v1/secret`,
			keyEnv: "LIFEDIARY_KEY_SECRET_PROBE",
			models: [],
			modelsUrl: "1",
		}),
	});
	const emptyWithUrlJson = (await emptyWithUrl.json()) as {
		ok?: boolean;
		provider?: { models?: string[] };
	};
	check(
		emptyWithUrl.status === 200 &&
			emptyWithUrlJson.provider?.models?.join(",") === "probe-secret-model",
		"空清单 + modelsUrl + 已存 Key → 200 且用上游清单建档",
		`${emptyWithUrl.status} ${JSON.stringify(emptyWithUrlJson.provider?.models ?? null)}`,
	);
	const emptyWithoutUrl = await fetch(`${BASE}/api/v1/agent/providers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			id: "empty-models-reject",
			name: "空清单拒绝探针",
			baseUrl: `${UPSTREAM_BASE}/v1/secret`,
			keyEnv: "LIFEDIARY_KEY_SECRET_PROBE",
			models: [],
		}),
	});
	const emptyWithoutUrlJson = (await emptyWithoutUrl.json()) as { error?: string };
	check(
		emptyWithoutUrl.status === 400 && emptyWithoutUrlJson.error === "bad_models",
		"空清单且没有 modelsUrl → 仍 400 bad_models",
		`${emptyWithoutUrl.status} ${emptyWithoutUrlJson.error}`,
	);

	// 16.6 删除联动：providers.json 删掉，密钥文件条目也清掉
	const deleteSecret = await fetch(`${BASE}/api/v1/agent/providers/secret-probe`, {
		method: "DELETE",
	});
	check(deleteSecret.status === 200, "删除供应商成功", String(deleteSecret.status));
	const afterDeleteKeys = JSON.parse(readFileSync(SECRET_KEYS, "utf8")) as Record<string, string>;
	check(
		!("LIFEDIARY_KEY_SECRET_PROBE" in afterDeleteKeys),
		"密钥文件条目已被联动清除",
	);

	// 16.7 回滚开关：端点 400，但启动注入照旧
	const createdAlias = await fetch(`${BASE}/api/v1/agent/providers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			id: "alias-probe",
			name: "别名探针",
			baseUrl: `${UPSTREAM_BASE}/v1/alias`,
			keyEnv: "LIFEDIARY_KEY_ALIAS_PROBE",
			models: ["probe-secret-model"],
		}),
	});
	check(createdAlias.status === 200, "新建回滚探针供应商", String(createdAlias.status));

	server.kill();
	await sleep(800);
	// 手工放一条密钥进文件：重启后即使端点关着，启动注入也必须生效
	writeFileSync(
		SECRET_KEYS,
		`${JSON.stringify({ LIFEDIARY_KEY_ALIAS_PROBE: SECRET_KEY }, null, 2)}\n`,
	);
	server = startServer({ ...secretEnv, PROVIDER_SECRETS: "false" });
	await waitForReady();
	const aliasProviders = await readProviders();
	check(
		aliasProviders.providers.find((provider) => provider.id === "alias-probe")?.hasKey === true,
		"PROVIDER_SECRETS=false 时启动注入仍执行（文件里的 key 生效）",
	);
	const disabledSecret = await putSecret("alias-probe", "another-key");
	const disabledSecretJson = (await disabledSecret.json()) as { error?: string };
	check(
		disabledSecret.status === 400 && disabledSecretJson.error === "secrets_disabled",
		"回滚时 PUT secret → 400 secrets_disabled",
		`${disabledSecret.status} ${disabledSecretJson.error}`,
	);

	// ── 17. 全部数据导出（2026-11-05 J1，接口文档 §2.5）──
	console.log("\n· 17. 全部数据导出");
	const exportA = await chat({ messages: [{ role: "user", content: "导出探针甲：今天整理书架" }] });
	const exportB = await chat({ messages: [{ role: "user", content: "导出探针乙：明天去跑步" }] });
	const exportHidden = await chat({ messages: [{ role: "user", content: "导出探针丙：这条要被移除" }] });
	check(
		exportA.status === 200 && Boolean(exportA.result.conversationId),
		"导出探针甲建会话",
		String(exportA.status),
	);
	check(
		exportB.status === 200 && Boolean(exportB.result.conversationId),
		"导出探针乙建会话",
		String(exportB.status),
	);
	const hiddenId = exportHidden.result.conversationId;
	check(
		exportHidden.status === 200 && Boolean(hiddenId),
		"导出探针丙建会话（随后 hide）",
		String(exportHidden.status),
	);
	if (hiddenId) {
		const hideResponse = await fetch(`${BASE}/api/v1/agent/chat/${hiddenId}/hide`, {
			method: "POST",
		});
		check(hideResponse.status === 200, "hide 探针丙", String(hideResponse.status));
	}

	const exportResponse = await fetch(`${BASE}/api/v1/agent/export`);
	const exportRaw = await exportResponse.text();
	check(exportResponse.status === 200, "GET /agent/export → 200", String(exportResponse.status));
	check(
		(exportResponse.headers.get("content-type") ?? "").includes("application/json"),
		"响应是 JSON",
		exportResponse.headers.get("content-type") ?? "",
	);
	const disposition = exportResponse.headers.get("content-disposition") ?? "";
	check(
		/attachment/.test(disposition) &&
			/selenite-export-\d{4}-\d{2}-\d{2}\.json/.test(disposition),
		"Content-Disposition = attachment + 日期文件名",
		disposition,
	);

	type ExportMessage = { role: string; at: number; text: string };
	type ExportConversation = {
		id: string;
		title: string;
		pinned: boolean;
		messages: ExportMessage[];
	};
	const exported = JSON.parse(exportRaw) as {
		exportedAt?: string;
		conversations?: ExportConversation[];
		providers?: { id?: string; hasKey?: boolean; keyEnv?: string }[];
		modelSelection?: { providerId?: string; modelId?: string } | null;
		usage?: { models?: unknown[] };
	};
	const conversations = exported.conversations ?? [];
	check(
		typeof exported.exportedAt === "string" && !Number.isNaN(Date.parse(exported.exportedAt)),
		"exportedAt 是 ISO 时间",
		String(exported.exportedAt),
	);
	check(conversations.length >= 2, "conversations 数组非空", String(conversations.length));
	check(
		conversations.every(
			(conversation) =>
				typeof conversation.id === "string" &&
				typeof conversation.title === "string" &&
				typeof conversation.pinned === "boolean" &&
				Array.isArray(conversation.messages) &&
				conversation.messages.every(
					(message) =>
						typeof message.role === "string" &&
						typeof message.at === "number" &&
						typeof message.text === "string",
				),
		),
		"每条会话结构齐（id/title/pinned/messages）",
	);

	const sameMessages = (a: ExportMessage[], b: ExportMessage[]): boolean =>
		a.length === b.length &&
		a.every(
			(message, index) =>
				message.role === b[index]?.role &&
				message.at === b[index]?.at &&
				message.text === b[index]?.text,
		);
	for (const [label, probe] of [
		["甲", exportA],
		["乙", exportB],
	] as const) {
		const id = probe.result.conversationId;
		if (!id) continue;
		const exportedChat = conversations.find((conversation) => conversation.id === id);
		check(Boolean(exportedChat), `探针${label}在导出里`, id);
		const history = (await (
			await fetch(`${BASE}/api/v1/agent/chat/${id}/messages?limit=500`)
		).json()) as { messages?: ExportMessage[] };
		check(
			Boolean(exportedChat) && sameMessages(exportedChat!.messages, history.messages ?? []),
			`探针${label}的 messages 与建库一致`,
			`${exportedChat?.messages.length ?? 0} vs ${history.messages?.length ?? 0}`,
		);
	}
	check(
		hiddenId ? !conversations.some((conversation) => conversation.id === hiddenId) : false,
		"被 hide 的会话不在导出里",
		hiddenId ?? "",
	);

	const providerList = exported.providers ?? [];
	check(providerList.length > 0, "providers 非空", String(providerList.length));
	check(
		providerList.every((provider) => typeof provider.hasKey === "boolean"),
		"providers 带 hasKey",
	);
	check(!exportRaw.includes("keyEnv"), "providers 投影无 keyEnv 字样");
	check(!exportRaw.includes(SECRET_KEY), "导出全文无密钥明文");
	check(
		exported.modelSelection === null ||
			(typeof exported.modelSelection?.providerId === "string" &&
				typeof exported.modelSelection?.modelId === "string"),
		"modelSelection 形状正确",
		JSON.stringify(exported.modelSelection?.["providerId"] ?? null),
	);
	check(Array.isArray(exported.usage?.models), "usage 原样带 models");

	// ── 18. 任务单来源对话（L1，2026-11-05，接口文档 §2.9）──
	console.log("\n· 18. 任务单来源对话（conversationId）");
	const TICKETS_BASE = resolve(".data/probe-http-tickets");
	// workRoot 的 managers/ 在同级：必须把工作根再下沉一层，别碰到真实的 .data/managers。
	const TICKETS_ROOT = join(TICKETS_BASE, "runs");
	const TICKETS_DB = resolve(".data/probe-http-delegations.sqlite");
	const PARTNER_DB = resolve(".data/probe-http-partners.sqlite");
	const PARTNER_HOMES = resolve(".data/probe-http-partner-homes");
	rmSync(TICKETS_BASE, { recursive: true, force: true });
	rmSync(TICKETS_DB, { force: true });
	server.kill();
	await sleep(800);
	// 执事库要等旧进程完全退出再删：Windows 上打开着的 sqlite 删不掉。
	rmSync(PARTNER_DB, { force: true });
	rmSync(`${PARTNER_DB}-wal`, { force: true });
	rmSync(`${PARTNER_DB}-shm`, { force: true });
	rmSync(PARTNER_HOMES, { recursive: true, force: true });
	server = startServer({
		...secretEnv,
		CHANCELLOR_ENABLED: "false",
		CHANCELLOR_WORK_ROOT: TICKETS_ROOT,
		DELEGATIONS_DB_PATH: TICKETS_DB,
	});
	await waitForReady();

	// 一张真实会话：它是所有来源对话断言的对照物。
	const sourceChat = await chat({ messages: [{ role: "user", content: "来源对话探针" }] });
	const sourceConversationId = sourceChat.result.conversationId ?? "";
	check(Boolean(sourceConversationId), "建一条来源对话", sourceConversationId);

	// ticket.json / 回执里存的是宿主内部会话 id；用同一份 durable 库拿到内→外映射。
	process.env.AGENT_DB_PATH = resolve(DB);
	process.env.MEMORY_DB_PATH = resolve(MEMORY_DB);
	process.env.MEMORY_ENABLED = "false";
	process.env.LLM_PROVIDER = "faux";
	process.env.PROVIDERS_PATH = resolve(".data/probe-http-providers.json");
	process.env.PARTNERS_DB_PATH = resolve(".data/probe-http-partners.sqlite");
	process.env.COMPANIONS_ENABLED = "false";
	process.env.CHANCELLOR_ENABLED = "false";
	const { externalChatIds, getHarness } = await import("../src/agent.ts");
	const idMap = await externalChatIds();
	const internalId = [...idMap.entries()].find(
		([, external]) => external === sourceConversationId,
	)?.[0];
	check(internalId !== undefined, "拿到会话的内外 id 映射", `${internalId} -> ${sourceConversationId}`);
	// 探针只借一次映射；不关掉的话 Windows 上 finally 删不掉服务端库（句柄还在）。
	await (await getHarness()).close(BACKGROUND_CONTEXT);

	const { Store } = await import("../../../../../chancellor/src/store.ts");
	const { DelegationReceipts } = await import("../src/delegation-receipts.ts");
	const nowIso = new Date().toISOString();
	const fixture = (id: string, extra: Record<string, unknown> = {}) =>
		({
			id,
			prompt: `来源对话夹具 ${id}`,
			status: "dispatching",
			created_at: nowIso,
			updated_at: nowIso,
			options: { dry: true, maxTasks: 8, workRoot: TICKETS_ROOT },
			...extra,
		}) as Ticket;
	const store = new Store(TICKETS_ROOT);
	// 新单：宿主派单时写进来的内部 id（子单继承同值）。
	store.saveTicket(fixture("T-source", { originConversationId: String(internalId) }));
	store.saveTicket(
		fixture("T-child", {
			parentTicketId: "T-source",
			originConversationId: String(internalId),
		}),
	);
	// 历史单：ticket.json 没有字段，靠派单回执反查；以及一张既没字段也没回执的（→ null）。
	store.saveTicket(fixture("T-legacy"));
	store.saveTicket(fixture("T-orphan"));
	// 任务专线夹具（8g）：非终态 + 有宿主会话，但**没有 plan.json**——
	// 续跑会在派活前被 chancellor 拒掉，正好验 resumeOnly（不偷偷改派新单）。
	store.saveTicket(
		fixture("T-say", {
			status: "needs_you",
			originConversationId: String(internalId),
		}),
	);
	store.close();
	const receipts = new DelegationReceipts(TICKETS_DB);
	receipts.begin("probe-legacy", "probe-fingerprint", { explicit: true });
	receipts.accept("probe-legacy", "T-legacy", internalId);
	receipts.close();

	// 领域单：chiefName 按 ticket.options.domain 反查 partners 表的执事名（L1 §2.2）。
	const { ensureManager } = await import("../../../../../chancellor/src/manager/registry.ts");
	const { PartnersStore } = await import("../src/partners.ts");
	const domainRunsDir = ensureManager(TICKETS_ROOT, "probe-domain").runs_dir;
	const domainStore = new Store(domainRunsDir);
	domainStore.saveTicket(
		fixture("T-domain", {
			options: { dry: true, maxTasks: 8, workRoot: TICKETS_ROOT, domain: "probe-domain" },
		}),
	);
	domainStore.close();
	const seededChiefName = "探针总管";
	const partnerStore = new PartnersStore(PARTNER_DB, PARTNER_HOMES);
	partnerStore.create(seededChiefName, {
		domain: "probe-domain",
		soulSeed: "探针播种的领域执事",
	});
	partnerStore.close();

	const ticketsJson = (await (await fetch(`${BASE}/api/v1/tickets?limit=100`)).json()) as {
		tickets: Array<{
			id: string;
			conversationId: string | null;
			conversationTitle: string | null;
			chiefName: string | null;
		}>;
	};
	const ticketRows = new Map(ticketsJson.tickets.map((ticket) => [ticket.id, ticket]));
	check(
		ticketRows.get("T-source")?.conversationId === sourceConversationId,
		"首层单的 conversationId = 发起对话 uuid",
		String(ticketRows.get("T-source")?.conversationId),
	);
	check(
		ticketRows.get("T-child")?.conversationId === sourceConversationId,
		"子单继承父单的来源对话",
		String(ticketRows.get("T-child")?.conversationId),
	);
	check(
		ticketRows.get("T-legacy")?.conversationId === sourceConversationId,
		"历史单回查回执兜底",
		String(ticketRows.get("T-legacy")?.conversationId),
	);
	const childDetail = (await (await fetch(`${BASE}/api/v1/tickets/T-child`)).json()) as {
		conversationId?: string | null;
		ticket?: Record<string, unknown>;
	};
	check(childDetail.conversationId === sourceConversationId, "详情接口也给来源对话");
	check(
		childDetail.ticket !== undefined && !("originConversationId" in childDetail.ticket),
		"详情不下发内部 id 原文",
	);
	check(
		ticketRows.get("T-orphan")?.conversationId === null,
		"无映射的历史单为 null",
		String(ticketRows.get("T-orphan")?.conversationId),
	);
	// 对话标题：没改过名时取首句（listChats 的 firstText 截 40 字）。
	check(
		ticketRows.get("T-source")?.conversationTitle === "来源对话探针",
		"列表行 conversationTitle = 来源对话首句",
		String(ticketRows.get("T-source")?.conversationTitle),
	);
	check(
		ticketRows.get("T-orphan")?.conversationTitle === null,
		"无来源对话的单 conversationTitle 为 null",
		String(ticketRows.get("T-orphan")?.conversationTitle),
	);
	// 总管名：domain 单取该领域执事名，直派单（options.domain 空）为 null。
	check(
		ticketRows.get("T-domain")?.chiefName === seededChiefName,
		"domain 单的 chiefName = 该领域执事名",
		String(ticketRows.get("T-domain")?.chiefName),
	);
	check(
		ticketRows.get("T-source")?.chiefName === null,
		"直派单（无 domain）chiefName 为 null",
		String(ticketRows.get("T-source")?.chiefName),
	);
	const domainDetail = (await (await fetch(`${BASE}/api/v1/tickets/T-domain`)).json()) as {
		conversationTitle?: string | null;
		chiefName?: string | null;
	};
	check(domainDetail.chiefName === seededChiefName, "详情接口也给总管名", String(domainDetail.chiefName));
	const childTitleDetail = (await (await fetch(`${BASE}/api/v1/tickets/T-child`)).json()) as {
		conversationTitle?: string | null;
	};
	check(
		childTitleDetail.conversationTitle === "来源对话探针",
		"详情接口也给对话标题",
		String(childTitleDetail.conversationTitle),
	);

	// ── 18.5 任务即对话（2026-11-08 扫尾批 8g，接口文档 §2.9）──────
	// 验：回话端点 202 → 建 `task-<票号>` 专线 → 用户条目落进去 → 续跑被拒走 resumeOnly
	// （不建新单）→ 专线里留下说明；专线不进侧栏。三处"跳过"里，
	// 任务卡由"专线不产单据"结构性保证、记忆由 configureTaskChat 摘扩展保证（见方案 §四）。
	console.log("\n· 18.5 任务即对话：回话直通 + 双写 + 隔离");
	const sayResponse = await fetch(`${BASE}/api/v1/tickets/T-say/say`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "收到，继续" }),
	});
	const sayBody = (await sayResponse.json().catch(() => ({}))) as {
		ok?: boolean;
		conversationId?: string;
		ticketId?: string;
	};
	check(sayResponse.status === 202, "回话受理 → 202", String(sayResponse.status));
	check(
		sayBody.conversationId === "task-T-say",
		"专线会话 id = task-<票号>",
		String(sayBody.conversationId),
	);

	const sayDetail = (await (await fetch(`${BASE}/api/v1/tickets/T-say`)).json()) as {
		taskConversationEnabled?: boolean;
		taskConversationId?: string | null;
	};
	check(
		sayDetail.taskConversationEnabled === true && sayDetail.taskConversationId === "task-T-say",
		"详情下发专线开关与确定性 id",
		`${sayDetail.taskConversationEnabled} / ${sayDetail.taskConversationId}`,
	);

	// 专线回读：等用户条目 + 失败说明都落盘（续跑被拒是异步收口的）。
	let sayTexts: string[] = [];
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const response = await fetch(
			`${BASE}/api/v1/agent/chat/task-T-say/messages?limit=200`,
		);
		if (response.ok) {
			const data = (await response.json()) as { messages?: Array<{ text?: string }> };
			sayTexts = (data.messages ?? []).map((message) => String(message.text ?? ""));
		}
		if (
			sayTexts.includes("收到，继续") &&
			sayTexts.some((text) => text.includes("已经不在等回答"))
		) {
			break;
		}
		await sleep(100);
	}
	check(sayTexts.includes("收到，继续"), "主人的回话以用户条目进了专线");
	check(
		sayTexts.some((text) => text.includes("已经不在等回答")),
		"续跑被拒：专线如实说明，没有改派新单",
	);

	const sideChats = (await (await fetch(`${BASE}/api/v1/agent/chats?limit=300`)).json()) as {
		chats?: Array<{ conversationId?: string }>;
	};
	check(
		!(sideChats.chats ?? []).some((chat) => chat.conversationId === "task-T-say"),
		"专线不进侧栏（沿用 task- 前缀过滤）",
	);

	// ── 19. 忙时投递方式（2026-11-07 消息即引导）────────────────
	// 契约层只验"字段被接受 + 语义没走偏"：faux 回答很快，这里不追真实插话时序
	// （那由 browser 验收与 agent 的 notice 断言覆盖），只钉住三种输入的形状。
	const dmConv = await (async () => {
		const res = await fetch(`${BASE}/api/v1/agent/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "投递方式探针" }] }),
		});
		const text = await res.text();
		return /"conversationId":"([^"]+)"/.exec(text)?.[1] ?? "";
	})();
	console.log("\n· 19. 忙时投递方式（whenBusy）");
	check(Boolean(dmConv), "建一条会话", dmConv);

	const sendWhen = async (whenBusy: unknown): Promise<number> => {
		const res = await fetch(`${BASE}/api/v1/agent/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				conversationId: dmConv,
				messages: [{ role: "user", content: "再说一句" }],
				...(whenBusy === undefined ? {} : { whenBusy }),
			}),
		});
		// 读完整条流，确保服务端把这一轮跑完（否则下一条会撞上"忙"）
		await res.text();
		return res.status;
	};

	check((await sendWhen(undefined)) === 200, "不带 whenBusy：与改动前一致（200）");
	check((await sendWhen("followUp")) === 200, "whenBusy=followUp 被接受");
	check((await sendWhen("steer")) === 200, "whenBusy=steer 被接受");
	check((await sendWhen("bogus")) === 400, "非法 whenBusy → 400（不静默降级）");

	const dmHistory = (await (await fetch(`${BASE}/api/v1/agent/chat/${dmConv}/messages`)).json()) as {
		messages?: unknown[];
	};
	check(
		(dmHistory.messages?.length ?? 0) >= 8,
		"三次合法投递都落库（每轮 user+assistant）",
		String(dmHistory.messages?.length),
	);

	// ── 20. 附件（2026-11-08 扫尾批 4a）────────────────────────
	// 图片 base64 直进 durable（不做 blob 存储）；这条链路要验的是：受理 → 落库 →
	// 回读带 images/messageId → faux 正常回，以及两条限制与一个回滚开关。
	const TINY_PNG =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const readDetailed = async (id: string) =>
		(
			(await (await fetch(`${BASE}/api/v1/agent/chat/${id}/messages?limit=200`)).json()) as {
				messages: {
					role: string;
					text: string;
					id?: string;
					images?: { mimeType: string; data: string }[];
				}[];
			}
		).messages;

	console.log("\n· 20. 附件：带一条 base64 小图的消息（全链路）");
	const withImage = await chat({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "看看这张图" },
					{ type: "image", mimeType: "image/png", data: TINY_PNG },
				],
			},
		],
	});
	const imageConv = withImage.result.conversationId ?? "";
	check(withImage.status === 200, "带图消息被受理（200）", String(withImage.status));
	check(withImage.result.done, "faux 正常收尾");
	check(Boolean(imageConv), "下发 conversationId", imageConv);
	const imageHistory = await readDetailed(imageConv);
	const imageUser = imageHistory.find((message) => message.role === "user");
	check(
		imageUser?.images?.[0]?.data === TINY_PNG && imageUser?.images?.[0]?.mimeType === "image/png",
		"回读带 images（原样 base64 + mimeType）",
		`${imageUser?.images?.length ?? 0} 张`,
	);
	check(imageUser?.text === "看看这张图", "文本与图片分开落，text 仍可读");
	check(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(imageUser?.id ?? ""),
		"用户消息带 uuid 形状的 messageId（不是内部自增 id）",
		imageUser?.id ?? "(无)",
	);

	const tooMany = await chat({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "五张" },
					...Array.from({ length: 5 }, () => ({
						type: "image" as const,
						mimeType: "image/png",
						data: TINY_PNG,
					})),
				],
			},
		],
	});
	check(tooMany.status === 400, "超过 4 张图 → 400", String(tooMany.status));

	const hugeImage = "A".repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3) * 4);
	const tooBig = await chat({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "一张大图" },
					{ type: "image", mimeType: "image/png", data: hugeImage },
				],
			},
		],
	});
	check(tooBig.status === 400, "单图解码后超 8MB → 400", String(tooBig.status));

	// ── 21. 编辑重发（2026-11-08 扫尾批 4a）──────────────────
	console.log("\n· 21. 编辑重发：fork 出新会话，老会话完好");
	const editSeed = await chat({ messages: [{ role: "user", content: "第一句话" }] });
	const editConv = editSeed.result.conversationId ?? "";
	await chat({ conversationId: editConv, messages: [{ role: "user", content: "第二句话" }] });
	const beforeEdit = await readDetailed(editConv);
	check(beforeEdit.length >= 4, "老会话有两条问答", `${beforeEdit.length} 条`);
	const secondUser = [...beforeEdit].reverse().find((message) => message.role === "user");
	check(Boolean(secondUser?.id), "最后一条 user 有 messageId", secondUser?.id ?? "(无)");

	const editResponse = await fetch(`${BASE}/api/v1/agent/chat/${editConv}/edit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messageId: secondUser?.id, text: "改过的第二句" }),
	});
	const edited = (await editResponse.json().catch(() => ({}))) as { conversationId?: string };
	check(editResponse.status === 202, "受理即回 202", String(editResponse.status));
	check(
		Boolean(edited.conversationId) && edited.conversationId !== editConv,
		"返回的是**新** conversationId",
		`${edited.conversationId} ≠ ${editConv}`,
	);

	/** 后台轮询直到新会话里出现第 expectAnswers 条回答（编辑端点是 202 + 后台跑） */
	const waitAnswers = async (id: string, expectAnswers: number, timeoutMs = 8000) => {
		const deadline = Date.now() + timeoutMs;
		let history = await readDetailed(id);
		while (Date.now() < deadline) {
			if (history.filter((message) => message.role === "assistant").length >= expectAnswers) break;
			await sleep(150);
			history = await readDetailed(id);
		}
		return history;
	};
	const forkedHistory = edited.conversationId
		? await waitAnswers(edited.conversationId, 2)
		: [];
	const forkedUsers = forkedHistory.filter((message) => message.role === "user");
	check(
		forkedHistory.length >= 4 && forkedHistory[0]?.text === "第一句话",
		"分叉点之前的历史完整（第一条 user 仍是原文）",
		forkedHistory.map((message) => message.role).join(","),
	);
	check(
		forkedUsers.at(-1)?.text === "改过的第二句",
		"新会话最后一条 user 是新文本",
		forkedUsers.at(-1)?.text ?? "(无)",
	);
	check(
		forkedHistory.filter((message) => message.role === "assistant").length >= 2,
		"新会话跑完了一轮（faux 正常回）",
		`${forkedHistory.filter((message) => message.role === "assistant").length} 条回答`,
	);
	const oldAfter = await readDetailed(editConv);
	check(
		oldAfter.length === beforeEdit.length && oldAfter[3]?.text === beforeEdit[3]?.text,
		"老会话原样保留（条数/内容都没被改）",
		`${beforeEdit.length} → ${oldAfter.length} 条`,
	);

	// 编辑第一条：没有"之前"可分叉 → 走同形态的新会话，首条 user 就是新文本
	const firstUser = beforeEdit.find((message) => message.role === "user");
	const editFirst = await fetch(`${BASE}/api/v1/agent/chat/${editConv}/edit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messageId: firstUser?.id, text: "换一个开头" }),
	});
	const editedFirst = (await editFirst.json().catch(() => ({}))) as { conversationId?: string };
	check(editFirst.status === 202, "编辑第一条也受理", String(editFirst.status));
	const firstHistory = editedFirst.conversationId
		? await waitAnswers(editedFirst.conversationId, 1)
		: [];
	check(
		firstHistory[0]?.role === "user" && firstHistory[0]?.text === "换一个开头",
		"新会话首条 user 就是新文本（旧历史不带过来）",
		firstHistory[0]?.text ?? "(无)",
	);

	// 不属于本会话 / 不是 user：400
	const crossEdit = await fetch(`${BASE}/api/v1/agent/chat/${editConv}/edit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messageId: "00000000-0000-4000-8000-000000000000", text: "乱指一条" }),
	});
	check(crossEdit.status === 400, "messageId 不属于本会话 → 400", String(crossEdit.status));

	// ── 22. 编辑的忙时口径 + 两个回滚开关 ─────────────────────
	console.log("\n· 22. 会话在跑时编辑 → 409；两个回滚开关");
	server.kill();
	await sleep(800);
	// 换一个"永远在调工具"的 faux，并把回合上限拉高：这一轮会跑得足够久，
	// 以便在它跑着的时候发编辑请求（409 的口径来自 pi.live.run，不是自记的布尔）。
	// 会话必须在这个进程里新建：旧会话的模型绑定跨进程重启后不一定还解析得到，
	// 那不是本项要验的东西。
	server = startServer({
		LLM_FAUX_TOOL: "recall",
		AGENT_MAX_TURNS: "80",
		AGENT_SSE_SEQ_DB_PATH: SEQ_DB,
		// §18 起在探针进程内把 COMPANIONS_ENABLED 置了 false（为了 import agent 不碰执事库），
		// startServer 继承 process.env，这里必须显式打开——§23 要验执事端点。
		COMPANIONS_ENABLED: "true",
	});
	await waitForReady();

	// 直接读 SSE 的第一段拿 conversationId（start 帧在提交之前就发出去了）
	const busyResponse = await fetch(`${BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messages: [{ role: "user", content: "跑一会儿" }] }),
	});
	const busyReader = busyResponse.body?.getReader();
	let busyConv = "";
	let busyBuffer = "";
	while (busyReader && !busyConv) {
		const chunk = await busyReader.read();
		if (chunk.done) break;
		busyBuffer += new TextDecoder().decode(chunk.value);
		busyConv = /"conversationId":"([^"]+)"/.exec(busyBuffer)?.[1] ?? "";
	}
	check(Boolean(busyConv), "长轮次会话已开跑", busyConv);

	let busyUser: { id?: string } | undefined;
	for (let attempt = 0; attempt < 40 && !busyUser?.id; attempt += 1) {
		await sleep(50);
		const history = await readDetailed(busyConv);
		busyUser = [...history].reverse().find((message) => message.text === "跑一会儿");
	}
	const busyEdit = await fetch(`${BASE}/api/v1/agent/chat/${busyConv}/edit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messageId: busyUser?.id, text: "趁跑着改" }),
	});
	check(busyEdit.status === 409, "会话在跑时编辑 → 409", String(busyEdit.status));
	await fetch(`${BASE}/api/v1/agent/chat/${busyConv}/stop`, { method: "POST" }).catch(
		() => undefined,
	);
	await busyReader?.cancel().catch(() => undefined);

	// ── 23. 岗位契约（2026-11-08 员工人格化刀一 E1）──────────────
	// 写入 → 读到 → 列表形状不变；开关关着时的 400 放到下面同一轮重启里验。
	console.log("\n· 23. 岗位契约：写入 → 读到；GET /partners 形状不变");
	const partnerCreated = await fetch(`${BASE}/api/v1/partners`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "契约探针" }),
	});
	const partnerCreatedBody = (await partnerCreated.json()) as {
		ok?: boolean;
		partner?: { id?: string };
	};
	const contractPartnerId = partnerCreatedBody.partner?.id ?? "";
	check(
		partnerCreated.status === 201 && Boolean(contractPartnerId),
		"建一个用来验契约的执事",
		String(partnerCreated.status),
	);

	const contractBefore = (await (
		await fetch(`${BASE}/api/v1/partners/${contractPartnerId}`)
	).json()) as { contract?: string; contractVersion?: number };
	check(
		typeof contractBefore.contract === "string" &&
			contractBefore.contract.includes("## 职责范围") &&
			contractBefore.contractVersion === 1,
		"详情：新建执事带四节空模板，版本 = 1",
		`v=${String(contractBefore.contractVersion)}`,
	);

	const contractText = [
		"## 职责范围",
		"桌面壳与安装包。",
		"",
		"## 决策分级",
		"文案自己定；动安装流程先申请。",
		"",
		"## 验收标准",
		"能装能卸，探针全绿。",
		"",
		"## 汇报对象",
		"向总管汇报。",
	].join("\n");
	const contractPut = await fetch(`${BASE}/api/v1/partners/${contractPartnerId}/contract`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ contract: contractText }),
	});
	const contractPutBody = (await contractPut.json()) as { contractVersion?: number };
	check(
		contractPut.status === 200 && contractPutBody.contractVersion === 2,
		"PUT 契约：落新版本（与 SOUL 共用版本号，v2）",
		String(contractPutBody.contractVersion),
	);

	const contractAfter = (await (
		await fetch(`${BASE}/api/v1/partners/${contractPartnerId}`)
	).json()) as { contract?: string; contractVersion?: number; soulVersion?: number };
	check(
		contractAfter.contract === contractText && contractAfter.contractVersion === 2,
		"详情：写进去的契约逐字读回（磁盘当前值）",
		`v=${String(contractAfter.contractVersion)}`,
	);

	const partnerList = (await (await fetch(`${BASE}/api/v1/partners`)).json()) as {
		partners?: Array<Record<string, unknown>>;
	};
	check(
		Array.isArray(partnerList.partners) &&
			partnerList.partners.every((row) => !("contract" in row) && !("soul" in row)),
		"GET /partners 列表形状不变（不夹带契约 / SOUL 正文）",
		`${partnerList.partners?.length ?? 0} 行`,
	);

	// 两个开关同一次重启里验完：edit → 404；parts → 400；纯字符串照常
	// 再加 8g 的 TASK_AS_CONVERSATION=false：回话端点同样 404（未启用）。
	server.kill();
	await sleep(800);
	server = startServer({
		AGENT_ATTACHMENTS: "false",
		AGENT_EDIT_RESEND: "false",
		TASK_AS_CONVERSATION: "false",
		// 2026-11-08 员工人格化刀一 E1 的回滚开关：写端点 400 带说明（不是 404）
		PARTNER_CONTRACT: "false",
		COMPANIONS_ENABLED: "true",
		AGENT_SSE_SEQ_DB_PATH: SEQ_DB,
	});
	await waitForReady();

	const policyOff = (await (await fetch(`${BASE}/api/v1/agent/policy`)).json()) as {
		attachments?: boolean;
		editResend?: boolean;
	};
	check(
		policyOff.attachments === false && policyOff.editResend === false,
		"policy 投影如实给出两个开关（前端据此不渲染入口）",
		JSON.stringify(policyOff),
	);

	const partsOff = await chat({
		messages: [
			{
				role: "user",
				content: [{ type: "image", mimeType: "image/png", data: TINY_PNG }],
			},
		],
	});
	check(partsOff.status === 400, "AGENT_ATTACHMENTS=false：分段请求 → 400", String(partsOff.status));
	const stringOn = await chat({ messages: [{ role: "user", content: "纯文字照常" }] });
	check(stringOn.status === 200, "同一开关下纯字符串照常（200）", String(stringOn.status));

	const editOff = await fetch(`${BASE}/api/v1/agent/chat/${editConv}/edit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messageId: secondUser?.id, text: "关着还想改" }),
	});
	check(editOff.status === 404, "AGENT_EDIT_RESEND=false：端点 404", String(editOff.status));

	const sayOff = await fetch(`${BASE}/api/v1/tickets/T-any/say`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "在吗" }),
	});
	check(
		sayOff.status === 404,
		"TASK_AS_CONVERSATION=false：回话端点 404（未启用）",
		String(sayOff.status),
	);

	const contractOff = await fetch(`${BASE}/api/v1/partners/${contractPartnerId}/contract`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ contract: "## 职责范围\n关了还想写" }),
	});
	const contractOffBody = (await contractOff.json()) as { message?: string };
	check(
		contractOff.status === 400 && (contractOffBody.message ?? "").includes("PARTNER_CONTRACT"),
		"PARTNER_CONTRACT=false：写端点 400 带说明（不是 404）",
		`${contractOff.status} ${contractOffBody.message ?? ""}`,
	);
	const contractDetailOff = (await (
		await fetch(`${BASE}/api/v1/partners/${contractPartnerId}`)
	).json()) as Record<string, unknown>;
	check(
		!("contract" in contractDetailOff) && !("contractVersion" in contractDetailOff),
		"PARTNER_CONTRACT=false：详情不带契约字段（回纯 SOUL 形态）",
	);

	// ── 24. 员工人格化刀二：currentGoal / 自建巡逻上架（2026-11-08）──────
	console.log("\n· 24. 刀二：PATCH currentGoal → 详情读回 → 列表形状；routine_manage 上架 / 回滚");
	// 24.1 当前目标（纯端点；当前这轮服务 COMPANIONS_ENABLED=true）。
	const goalSet = await fetch(`${BASE}/api/v1/partners/${contractPartnerId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ currentGoal: "本季度把安装包做稳" }),
	});
	const goalSetBody = (await goalSet.json()) as { currentGoal?: unknown };
	check(
		goalSet.status === 200 && goalSetBody.currentGoal === "本季度把安装包做稳",
		"PATCH currentGoal 写进去",
		String(goalSet.status),
	);
	const goalDetail = (await (
		await fetch(`${BASE}/api/v1/partners/${contractPartnerId}`)
	).json()) as { currentGoal?: unknown };
	check(goalDetail.currentGoal === "本季度把安装包做稳", "detail 端点逐字读回 currentGoal");
	const goalList = (await (await fetch(`${BASE}/api/v1/partners`)).json()) as {
		partners?: Array<Record<string, unknown>>;
	};
	check(
		Array.isArray(goalList.partners) && goalList.partners.every((row) => !("currentGoal" in row)),
		"GET /partners 列表形状不变（不夹带 currentGoal）",
		`${goalList.partners?.length ?? 0} 行`,
	);
	const goalClear = await fetch(`${BASE}/api/v1/partners/${contractPartnerId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ currentGoal: "" }),
	});
	const goalClearBody = (await goalClear.json()) as { currentGoal?: unknown };
	check(goalClearBody.currentGoal === null, "空串清除 currentGoal（PATCH 回显 null）");

	// 24.2 routine_manage 场景：faux 真链路调工具，开关开 → 工具上架且执事真建出自己的规则。
	const routineEnv = {
		COMPANIONS_ENABLED: "true",
		PARTNER_GREETING_ENABLED: "false",
		AGENT_SSE_SEQ_DB_PATH: SEQ_DB,
		LLM_FAUX_TOOL: "routine_manage",
		LLM_FAUX_ARGS: JSON.stringify({
			action: "create",
			name: "每周五自己盘点",
			prompt: "读自己的工作履历，写一段自然语言总结，向主人汇报",
			triggers: [{ type: "cron", expr: "0 18 * * 5" }],
			sessionMode: "fresh",
		}),
		// faux 只会调工具、永不收尾：压低回合上限让流正常收尾（§10 同款）。
		AGENT_MAX_TURNS: "3",
		TOOL_LOOP_GUARD: "false",
	};
	server.kill();
	await sleep(800);
	server = startServer(routineEnv);
	await waitForReady();

	// 打开执事专线（问候生成关掉，避免 faux 干扰），拿到执事会话的对外 uuid。
	const opened = await fetch(`${BASE}/api/v1/partners/${contractPartnerId}/open`, {
		method: "POST",
	});
	const openedBody = (await opened.json()) as { conversationId?: string; greeting?: string };
	const partnerConversationId = openedBody.conversationId ?? "";
	check(
		opened.status === 200 && Boolean(partnerConversationId),
		"打开执事专线（PARTNER_GREETING_ENABLED=false）",
		`${opened.status} ${openedBody.greeting ?? ""}`,
	);

	const routineChat = await chatRaw({
		conversationId: partnerConversationId,
		messages: [{ role: "user", content: "给自己建一条每周五的盘点规则" }],
	});
	const toolFrames = routineChat.frames.filter(
		(frame) => frame.type === "tool" && (frame.raw as { name?: string }).name === "routine_manage",
	);
	check(
		toolFrames.length > 0,
		"ROUTINE_SELF_SERVICE 开：routine_manage 工具已上架并被真调用",
		`${toolFrames.length} 帧`,
	);
	const routinesOn = (await (
		await fetch(`${BASE}/api/v1/routines?partnerId=${contractPartnerId}`)
	).json()) as { routines?: Array<{ name?: string; partnerId?: string }> };
	check(
		(routinesOn.routines ?? []).some(
			(row) => row.name === "每周五自己盘点" && row.partnerId === contractPartnerId,
		),
		"执事在自己的会话里真建出规则，且落到自己名下",
		`${routinesOn.routines?.length ?? 0} 条`,
	);
	const ruleCountOn = routinesOn.routines?.length ?? 0;

	// 24.3 回滚：ROUTINE_SELF_SERVICE=false → 工具不上架，模型侧够不到，也不新建规则。
	server.kill();
	await sleep(800);
	server = startServer({ ...routineEnv, ROUTINE_SELF_SERVICE: "false" });
	await waitForReady();
	const offChat = await chatRaw({
		conversationId: partnerConversationId,
		messages: [{ role: "user", content: "再给自己建一条规则" }],
	});
	check(
		offChat.frames.every(
			(frame) => frame.type !== "tool" || (frame.raw as { name?: string }).name !== "routine_manage",
		),
		"ROUTINE_SELF_SERVICE=false：routine_manage 不上架（没有它的工具帧）",
	);
	const routinesOff = (await (
		await fetch(`${BASE}/api/v1/routines?partnerId=${contractPartnerId}`)
	).json()) as { routines?: Array<unknown> };
	check(
		(routinesOff.routines?.length ?? 0) === ruleCountOn,
		"开关关着：规则数不增加（没有偷偷新建）",
		`${ruleCountOn} → ${routinesOff.routines?.length ?? 0}`,
	);

	// ── 25. 默认工作区播种（2026-11-08）：没设过 → 静默落指定目录；已设过不动 ──
	console.log("\n· 25. 默认工作区播种（LIFEDIARY_DEFAULT_WORKSPACE）");
	server.kill();
	await sleep(800);
	// 全新项目库：§14 建过工作区 A，得清掉才能验「没设过」这条路
	rmSync(PROJECTS_DB, { force: true });
	rmSync(`${PROJECTS_DB}-wal`, { force: true });
	rmSync(`${PROJECTS_DB}-shm`, { force: true });
	const seedWs = resolve(".data/probe-http-default-ws");
	rmSync(seedWs, { recursive: true, force: true });
	server = startServer({ LIFEDIARY_DEFAULT_WORKSPACE: seedWs });
	await waitForReady();
	const seededState = (await (await fetch(`${BASE}/api/v1/workspaces`)).json()) as {
		workspace: { rootPath: string } | null;
	};
	check(
		seededState.workspace?.rootPath === seedWs,
		"没设过工作区：启动即静默播种默认目录",
		seededState.workspace?.rootPath ?? "null",
	);
	check(existsSync(seedWs), "默认工作区目录已创建");
	const reseed = await fetch(`${BASE}/api/v1/workspaces`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ rootPath: WORKSPACE_A }),
	});
	check(reseed.status === 200, "用户随后改根目录仍然可行", String(reseed.status));
	server.kill();
	await sleep(800);
	server = startServer({ LIFEDIARY_DEFAULT_WORKSPACE: seedWs });
	await waitForReady();
	const keptState = (await (await fetch(`${BASE}/api/v1/workspaces`)).json()) as {
		workspace: { rootPath: string } | null;
	};
	check(
		keptState.workspace?.rootPath === WORKSPACE_A,
		"重启后已设的根目录保留（播种不覆盖用户选择）",
		keptState.workspace?.rootPath ?? "null",
	);

} finally {
	server.kill();
	await sleep(300);
	gateUpstream.close();
	// 探针产物不留
	rmSync(DB, { force: true });
	rmSync(`${DB}-wal`, { force: true });
	rmSync(`${DB}-shm`, { force: true });
	rmSync(MEMORY_DB, { force: true });
	rmSync(PROJECTS_DB, { force: true });
	rmSync(`${PROJECTS_DB}-wal`, { force: true });
	rmSync(`${PROJECTS_DB}-shm`, { force: true });
	rmSync(WORKSPACE_A, { recursive: true, force: true });
	rmSync(WORKSPACE_B, { recursive: true, force: true });
	rmSync(GATE_OUTSIDE_DIR, { recursive: true, force: true });
	rmSync(".data/probe-http-default-ws", { recursive: true, force: true });
	rmSync(".data/probe-http-gate-providers.json", { force: true });
	rmSync(".data/probe-http-gate-runtime.json", { force: true });
	rmSync(".data/probe-http-chat-events.sqlite", { force: true });
	rmSync(".data/probe-http-providers.json", { force: true });
	rmSync(".data/probe-http-policy.json", { force: true });
	rmSync(".data/probe-http-secret-providers.json", { force: true });
	rmSync(".data/probe-http-provider-keys.json", { force: true });
	rmSync(".data/probe-http-secret-runtime.json", { force: true });
	rmSync(".data/probe-http-tickets", { recursive: true, force: true });
	rmSync(".data/probe-http-delegations.sqlite", { force: true });
	rmSync(".data/probe-http-partners.sqlite", { force: true });
	rmSync(".data/probe-http-partners.sqlite-wal", { force: true });
	rmSync(".data/probe-http-partners.sqlite-shm", { force: true });
	rmSync(".data/probe-http-partner-homes", { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✓ 端到端全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
