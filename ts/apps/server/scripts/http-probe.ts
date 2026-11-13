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
import { inflateRawSync } from "node:zlib";
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
			// 归档 / 永久删除都写 chat-meta：必须隔离，绝不碰真实 .data/chat-meta.json
			// （2026-11-13 实测：§14.7/§14.8 归档的探针会话 id 写进了生产文件，
			//  清库后全成孤儿，归档页显示 120 条却一条取不出）
			AGENT_CHAT_META_PATH: ".data/probe-http-chat-meta.json",
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
			// 附件上传落点（2026-11-13 附件走路径）：探针收的文件只写这里，结束即清
			ATTACHMENTS_DIR: ".data/probe-http-attachments",
			// 高级开关 / 技能启停位（2026-11-09）：探针隔离，别写真实 .data 的开关文件
			AGENT_FLAGS_PATH: ".data/probe-http-flags.json",
			AGENT_SKILLS_STATE_PATH: ".data/probe-http-skill-state.json",
			// 主动性三档 / 观察记录（2026-11-09 T2）：探针显式关掉（缺省已是开，2026-11-13 起），
			// 别读开发机 env、别写真实账本
			AUTONOMY_ENABLED: "false",
			AUTONOMY_OBSERVE_PATH: ".data/probe-http-autonomy-observe.jsonl",
			// 审批 / 闸门审计（2026-11-09）：同样隔离，绝不碰真实 .data/approvals.json
			AGENT_APPROVALS_PATH: ".data/probe-http-approvals.json",
			AGENT_GATE_AUDIT_PATH: ".data/probe-http-gate-blocks.jsonl",
			NODE_OPTIONS: "",
			// 配对库隔离（批 26 §四的指纹探针会真的配对一台设备）：绝不碰真实 .data/pairing.json
			PAIRING_STORE_PATH: ".data/probe-http-pairing.json",
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

/**
 * 最小 zip 读取（只给探针用）：读中央目录里的文件名 + 取某一条的内容。
 * 压缩流本身对不对由 src/zip.test.ts 自己解包验；这里要的是"包里真有这些文件、
 * manifest 能读出来、明文里没有密钥"。
 */
function zipNames(buffer: Buffer): string[] {
	const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocd < 0) return [];
	const count = buffer.readUInt16LE(eocd + 10);
	let cursor = buffer.readUInt32LE(eocd + 16);
	const names: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

function zipEntryText(buffer: Buffer, name: string): string | null {
	const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocd < 0) return null;
	const count = buffer.readUInt16LE(eocd + 10);
	let cursor = buffer.readUInt32LE(eocd + 16);
	for (let index = 0; index < count; index += 1) {
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const method = buffer.readUInt16LE(cursor + 10);
		const compressed = buffer.readUInt32LE(cursor + 20);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const entryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		if (entryName === name) {
			const localNameLength = buffer.readUInt16LE(localOffset + 26);
			const localExtraLength = buffer.readUInt16LE(localOffset + 28);
			const start = localOffset + 30 + localNameLength + localExtraLength;
			const body = buffer.subarray(start, start + compressed);
			return (method === 8 ? inflateRawSync(body) : body).toString("utf8");
		}
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return null;
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
/** 闸门审计 / 审批落点（2026-11-09）：与 startServer 的 env 一致，探针隔离 */
const GATE_AUDIT_FILE = ".data/probe-http-gate-blocks.jsonl";
const APPROVALS_FILE = ".data/probe-http-approvals.json";

interface GateRequest {
	body: Record<string, unknown>;
	at: number;
}
const gateRequests: GateRequest[] = [];
/** 假上游收到的 GET /models 的 Authorization 头（§16 密钥热注入验证） */
const gateModelsAuth: string[] = [];
/** 假上游下一轮 write 要写哪（空字符串 = 只回文本） */
let gateWritePath = "";
/** 假上游下一轮改回 ask_user 调用（2026-11-09 §3 探针）；null = 不改 */
let gateAskUserArgs: Record<string, unknown> | null = null;
/**
 * §14.8 忙时归档：探针把假上游的模型响应压住（闸开着）＝服务端这轮真的在跑
 * （pi.live.run 由内核在 generation 启动时置位，必然先于模型请求到达这里）。
 * 探针断言完把闸放开。批A 试过"发完立刻归档"的窄窗口，faux 下不稳定（Windows）；
 * 闸控窗口是确定性的，且忙态语义仍是内核自有的 run 字段，不是探针记的布尔。
 */
let gateUpstreamHold = false;
let gateUpstreamRelease: (() => void) | null = null;
const releaseHeldUpstream = (): void => {
	gateUpstreamRelease?.();
	gateUpstreamRelease = null;
};

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

	// §14.8 忙时归档的闸：请求已到达（gateRequests 已记）＝这轮的 pi.live.run 已置位。
	// 压住响应，等探针断言完 busy 400 再放行（探针负责复位两个变量）。
	if (gateUpstreamHold) {
		await new Promise<void>((done) => {
			gateUpstreamRelease = done;
		});
	}

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
	if (!hasToolResult && gateAskUserArgs) {
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
								id: "call_gate_ask_1",
								type: "function",
								function: {
									name: "ask_user",
									arguments: JSON.stringify(gateAskUserArgs),
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
	} else if (!hasToolResult && gateWritePath) {
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
	// ── 4.5 注入审计端点（2026-11-10 批 26b §二 / 批 27 §四）──────────
	// 真 HTTP 验：只回元数据、不回正文；批 27 起全部注入都进清单（source 区分来源模块）。
	console.log("\n· 4.5 注入审计端点（只回元数据，不回正文）");
	const injectionsRes = await fetch(`${BASE}/api/v1/agent/chat/${externalId}/injections`);
	check(injectionsRes.status === 200, "GET .../injections → 200", String(injectionsRes.status));
	const injections = (await injectionsRes.json()) as Array<Record<string, unknown>>;
	const injectionIds = injections.map((row) => String(row.id));
	check(
		Array.isArray(injections) && injectionIds.length >= 5,
		"全部注入条目已登记（批 27 B/C/D 接管后不再是 1 条）",
		JSON.stringify(injectionIds),
	);
	check(
		["persona", "injection_guard", "current_project", "topics"].every((id) =>
			injectionIds.includes(id),
		),
		"section 注入都在清单里",
		JSON.stringify(injectionIds),
	);
	const injRow = injections.find((row) => row.id === "injection_guard") ?? {};
	check(
		injRow.source === "lifecycle" &&
			injRow.scope === "session" &&
			injRow.channel === "system" &&
			typeof injRow.length === "number" &&
			(injRow.length as number) > 0,
		"审计行形状 {id,source,scope,channel,length}",
		JSON.stringify(injRow),
	);
	check(
		injections.every((row) => !("text" in row)) &&
			!JSON.stringify(injections).includes("【材料安全】"),
		"审计不返正文（无 text 字段、无实文片段）",
	);

	console.log("\n· 5. 提醒接口");
	const at = Date.now() + 1_200;
	const created = await fetch(`${BASE}/api/v1/agent/reminders`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversationId: externalId, text: "该写日记了", at }),
	});
	check(created.status === 201, "提醒创建成功", String(created.status));

	const pending = (await (await fetch(`${BASE}/api/v1/agent/reminders`)).json()) as {
		reminders: { id: number; reminderId: string; text: string; status: string; repeat: string; until?: number }[];
	};
	check(pending.reminders.length === 1, "列表里有一条待触发", JSON.stringify(pending.reminders[0]));

	await sleep(1_600);
	const afterFire = (await (await fetch(`${BASE}/api/v1/agent/reminders`)).json()) as {
		reminders: unknown[];
	};
	check(afterFire.reminders.length === 0, "到点后不再挂在待触发里");

	// 每日提醒 + 取消（2026-11-12）：repeat=daily 标记出来；DELETE 后列表清掉。
	const dailyAt = Date.now() + 60_000;
	const dailyCreated = await fetch(`${BASE}/api/v1/agent/reminders`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversationId: externalId, text: "每天写日记", at: dailyAt, repeat: "daily" }),
	});
	check(dailyCreated.status === 201, "每日提醒创建成功", String(dailyCreated.status));
	const withDaily = (await (await fetch(`${BASE}/api/v1/agent/reminders`)).json()) as {
		reminders: { id: number; reminderId: string; text: string; repeat: string; until?: number }[];
	};
	const daily = withDaily.reminders.find((row) => row.text === "每天写日记");
	check(Boolean(daily && daily.repeat === "daily"), "提醒带 repeat=daily", JSON.stringify(daily));
	const cancelled = await fetch(`${BASE}/api/v1/agent/reminders/${daily!.id}`, { method: "DELETE" });
	check(cancelled.status === 200, "取消提醒成功", String(cancelled.status));
	const afterCancel = (await (await fetch(`${BASE}/api/v1/agent/reminders`)).json()) as {
		reminders: { reminderId: string }[];
	};
	check(
		!afterCancel.reminders.some((row) => row.reminderId === daily!.reminderId),
		"取消后不再出现在列表里",
	);

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

	// §8.1 历史分页（2026-11-13 按天分组·上滑加载）：page/before 只增不改老契约。
	type PagedTranscript = {
		messages: { role: string; text: string }[];
		hasMore?: boolean;
		nextBefore?: string;
	};
	const legacyAll = (await (
		await fetch(`${BASE}/api/v1/agent/chat/${externalId}/messages?limit=0`)
	).json()) as PagedTranscript;
	const firstPage = (await (
		await fetch(`${BASE}/api/v1/agent/chat/${externalId}/messages?page=1&limit=4`)
	).json()) as PagedTranscript;
	check(
		(firstPage.messages?.length ?? 0) > 0 && (firstPage.messages?.length ?? 0) <= 4,
		"分页第一页不超过 limit（不切轮，可能少一条）",
		String(firstPage.messages?.length),
	);
	check(
		firstPage.messages?.[0]?.role === "user",
		"一页从用户提问开头（不切轮）",
		String(firstPage.messages?.[0]?.role),
	);
	check(
		firstPage.hasMore === true && typeof firstPage.nextBefore === "string",
		"还有更早时给 hasMore + nextBefore",
		`hasMore=${String(firstPage.hasMore)} nextBefore=${Boolean(firstPage.nextBefore)}`,
	);
	// 顺着游标翻到最早：每页 ≤limit、页首是 user、拼起来与全量逐条一致。
	const pagedTexts: string[] = [];
	let cursor: string | undefined = firstPage.nextBefore;
	let lastPage: PagedTranscript = firstPage;
	pagedTexts.unshift(...(firstPage.messages ?? []).map((m) => m.text));
	for (let index = 0; index < 20 && cursor; index += 1) {
		const page = (await (
			await fetch(
				`${BASE}/api/v1/agent/chat/${externalId}/messages?page=1&limit=4&before=${encodeURIComponent(cursor)}`,
			)
		).json()) as PagedTranscript;
		check(
			(page.messages?.length ?? 0) <= 4,
			"后续页也不超过 limit",
			String(page.messages?.length),
		);
		check(
			page.messages?.[0]?.role === "user" || page.messages?.length === 0,
			"后续页也从用户提问开头（不切轮）",
			String(page.messages?.[0]?.role),
		);
		pagedTexts.unshift(...(page.messages ?? []).map((m) => m.text));
		lastPage = page;
		cursor = page.nextBefore;
		if (!page.hasMore) break;
	}
	check(
		lastPage.hasMore === false && lastPage.nextBefore === undefined,
		"最后一页 hasMore=false 且不带游标",
		`hasMore=${String(lastPage.hasMore)} nextBefore=${Boolean(lastPage.nextBefore)}`,
	);
	check(
		pagedTexts.join("\n") === legacyAll.messages.map((m) => m.text).join("\n"),
		"逐页翻完与全量逐条一致（无重叠无遗漏）",
		`${pagedTexts.length} vs ${legacyAll.messages.length}`,
	);
	const badCursor = await fetch(
		`${BASE}/api/v1/agent/chat/${externalId}/messages?page=1&limit=4&before=not-a-cursor`,
	);
	check(badCursor.status === 400, "非法游标回 400", String(badCursor.status));
	const crossCursor = await fetch(
		`${BASE}/api/v1/agent/chat/${newId}/messages?page=1&limit=4&before=${encodeURIComponent(firstPage.nextBefore ?? "")}`,
	);
	check(crossCursor.status === 400, "跨会话游标回 400", String(crossCursor.status));
	const badLimit = await fetch(`${BASE}/api/v1/agent/chat/${externalId}/messages?page=1&limit=0`);
	check(badLimit.status === 400, "分页 limit 越界回 400", String(badLimit.status));
	const legacyShape = (await (
		await fetch(`${BASE}/api/v1/agent/chat/${externalId}/messages`)
	).json()) as Record<string, unknown>;
	check(
		!("hasMore" in legacyShape) && !("nextBefore" in legacyShape),
		"不带 page/before 时响应形状与旧版一致（无分页字段）",
		Object.keys(legacyShape).join(","),
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
		autonomy?: { mode?: string; observeCount24h?: number };
	};
	check(fauxHealth.model === "faux", "faux 下 healthz 报 faux", JSON.stringify(fauxHealth));
	check(fauxHealth.models.length === 0, "faux 没有可切清单");
	// 2026-11-09 T2：autonomy 从布尔扩成 { mode, observeCount24h }（纯增量；探针 env 显式关，见 spawn env）
	check(fauxHealth.autonomy?.mode === "off", "healthz autonomy.mode = off", JSON.stringify(fauxHealth.autonomy));
	check(fauxHealth.autonomy?.observeCount24h === 0, "healthz autonomy.observeCount24h = 0");

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
	rmSync(GATE_AUDIT_FILE, { force: true });
	rmSync(APPROVALS_FILE, { force: true });
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
	check(workspaceBSet.status === 200, "换工作区 B（项目是独立根，仍在根集合里）");
	const outsideResponse = await putCurrentProject(projectId);
	const outsideJson = (await outsideResponse.json()) as {
		ok?: boolean;
		projectId?: string | null;
		error?: string;
	};
	check(
		outsideResponse.status === 200 && outsideJson.projectId === projectId,
		"换工作区后旧项目仍可选（多根平级）",
		`${outsideResponse.status} ${outsideJson.error ?? ""}`,
	);
	const backToA = await setWorkspace(WORKSPACE_A);
	check(backToA.status === 200, "切回工作区 A");
	const reselected = await putCurrentProject(projectId);
	check(reselected.status === 200, "切回工作区后可再次选中", String(reselected.status));

	// 14.3.1 改路径 / 移除 / 恢复（2026-11-12 多根）
	const patchRoot = await fetch(`${BASE}/api/v1/projects/${projectId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ rootPath: GATE_PROJECT_DIR }),
	});
	check(patchRoot.status === 200, "PATCH rootPath 改项目路径", String(patchRoot.status));
	const removeProject = await fetch(`${BASE}/api/v1/projects/${projectId}/remove`, {
		method: "POST",
	});
	const removeJson = (await removeProject.json()) as { project?: { archived?: boolean } };
	check(
		removeProject.status === 200 && removeJson.project?.archived === true,
		"移除项目（软删除）",
		String(removeProject.status),
	);
	const removedSelect = await putCurrentProject(projectId);
	const removedJson = (await removedSelect.json()) as { error?: string };
	check(
		removedSelect.status === 400 && removedJson.error === "unknown_project",
		"移除后不能再选为当前项目",
		`${removedSelect.status} ${removedJson.error}`,
	);
	const restoreProject = await fetch(`${BASE}/api/v1/projects/${projectId}/restore`, {
		method: "POST",
	});
	check(restoreProject.status === 200, "恢复项目", String(restoreProject.status));
	const reselectAfterRestore = await putCurrentProject(projectId);
	check(reselectAfterRestore.status === 200, "恢复后可再次选中", String(reselectAfterRestore.status));

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
		!toolMessagesOf(insideBody).includes("不在已登记的工作区/项目目录内"),
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
		outsideToolText.includes("不在已登记的工作区/项目目录内"),
		"模型收到的工具结果含「不在已登记的工作区/项目目录内」",
		outsideToolText.slice(0, 160),
	);

	// 14.5.1 闸门留痕（2026-11-09 §5）：越界拦下要落一行账，但不含参数 / 路径。
	const auditRaw = existsSync(GATE_AUDIT_FILE) ? readFileSync(GATE_AUDIT_FILE, "utf8") : "";
	const auditRows = auditRaw
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return {} as Record<string, unknown>;
			}
		});
	check(
		auditRows.some((row) => row.reason === "path" && row.tool === "write"),
		"闸门留痕：越界写落一行 path 审计",
		`${auditRows.length} 行`,
	);
	check(!auditRaw.includes("escape.txt"), "闸门审计不含参数 / 目标路径");

	// ── 14.6 拒绝带反馈 + ask_user（2026-11-09 §3 / §4，真 pending / 真续跑）──
	console.log("\n· 14.6 拒绝带反馈 + 结构化提问（ask_user）");
	const setApprovalLevel = (level: string) =>
		fetch(`${BASE}/api/v1/agent/policy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approvalLevel: level }),
		});
	check((await setApprovalLevel("ask-all")).status === 200, "切审批档 ask-all");

	type PendingItem = { callId: string; tool: string; args: string; kind?: string };
	const pendingOf = async (conversationId: string): Promise<PendingItem[]> => {
		const response = await fetch(
			`${BASE}/api/v1/agent/approvals?conversationId=${encodeURIComponent(conversationId)}`,
		);
		if (!response.ok) return [];
		const data = (await response.json()) as { approvals?: PendingItem[] };
		return data.approvals ?? [];
	};
	const conversationTextOf = async (conversationId: string): Promise<string> => {
		const response = await fetch(
			`${BASE}/api/v1/agent/chat/${encodeURIComponent(conversationId)}/messages?limit=200`,
		);
		if (!response.ok) return "";
		const data = (await response.json()) as {
			messages?: Array<{ role?: string; text?: string }>;
		};
		return (data.messages ?? []).map((message) => String(message.text ?? "")).join("\n");
	};
	const waitForText = async (conversationId: string, needle: string): Promise<boolean> => {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if ((await conversationTextOf(conversationId)).includes(needle)) return true;
			await sleep(100);
		}
		return false;
	};

	// 14.6.1 写工具被挂起 → 拒绝时带一句指导语 → 续跑把它交给模型
	gateWritePath = GATE_INSIDE_REL;
	gateRequests.length = 0;
	const approvalRun = await chat({ messages: [{ role: "user", content: "在项目里写个文件" }] });
	const approvalConversationId = approvalRun.result.conversationId ?? "";
	check(
		approvalRun.status === 200 && approvalRun.result.done,
		"写工具挂起后本轮正常收尾",
		String(approvalRun.status),
	);
	check(approvalRun.result.events.includes("approval"), "SSE 有 approval 事件（待确认卡）");
	const writePending = (await pendingOf(approvalConversationId)).find(
		(item) => item.tool === "write",
	);
	check(Boolean(writePending?.callId), "GET approvals 补挂这条 pending");
	const decideApproval = (callId: string, body: Record<string, unknown>) =>
		fetch(`${BASE}/api/v1/agent/approvals/${encodeURIComponent(callId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const tooLongFeedback = await decideApproval(writePending?.callId ?? "?", {
		decision: "reject",
		feedback: "x".repeat(501),
	});
	check(tooLongFeedback.status === 400, "feedback 超 500 字 → 400", String(tooLongFeedback.status));
	const rejectFeedback = "只改 README.md，别动其他文件";
	const rejectResponse = await decideApproval(writePending?.callId ?? "?", {
		decision: "reject",
		feedback: rejectFeedback,
	});
	const rejectBody = (await rejectResponse.json().catch(() => ({}))) as { status?: string };
	check(
		rejectResponse.status === 200 && rejectBody.status === "rejected",
		"拒绝带 feedback → 200 rejected",
		`${rejectResponse.status} ${rejectBody.status}`,
	);
	check(
		await waitForText(approvalConversationId, `主人的要求：${rejectFeedback}`),
		"拒绝理由带进续跑（模型收到「主人的要求：…」）",
	);

	// 14.6.2 ask_user：问题落 pending（kind=ask_user）→ 单独答复路径 → followUp 交回
	gateWritePath = "";
	gateAskUserArgs = {
		question: "先改哪个文件？",
		options: ["src/app.ts", "src/main.ts"],
		recommended: 0,
	};
	gateRequests.length = 0;
	const askRun = await chat({ messages: [{ role: "user", content: "我该先改哪个" }] });
	const askConversationId = askRun.result.conversationId ?? "";
	check(
		askRun.status === 200 && askRun.result.done,
		"ask_user 挂起后本轮收尾",
		String(askRun.status),
	);
	check(askRun.result.events.includes("approval"), "ask_user 借审批通道发事件");
	const question = (await pendingOf(askConversationId)).find(
		(item) => item.tool === "ask_user",
	);
	check(question?.kind === "ask_user", "pending 带 kind=ask_user", String(question?.kind));
	check(
		String(question?.args ?? "").includes("先改哪个文件？"),
		"pending.args 带问题原文",
	);
	const wrongDecision = await decideApproval(question?.callId ?? "?", { decision: "approve" });
	check(wrongDecision.status === 400, "ask_user 走 approve → 400", String(wrongDecision.status));
	const answerResponse = await fetch(
		`${BASE}/api/v1/agent/approvals/${encodeURIComponent(question?.callId ?? "?")}/answer`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ answer: "src/app.ts" }),
		},
	);
	const answerBody = (await answerResponse.json().catch(() => ({}))) as { status?: string };
	check(
		answerResponse.status === 200 && answerBody.status === "answered",
		"提问答复 → 200 answered",
		`${answerResponse.status} ${answerBody.status}`,
	);
	check(
		await waitForText(askConversationId, "主人回答了你刚才的问题"),
		"答复作为 followUp 交回模型",
	);
	gateAskUserArgs = null;
	check((await setApprovalLevel("none")).status === 200, "恢复审批档 none");

	// ── 14.7 归档模块（2026-11-12，接口文档 §2.5 / §2.7）──
	console.log("\n· 14.7 归档模块（会话 + 项目连带）");
	type ArchivedChat = {
		conversationId?: string;
		archived?: boolean;
		archivedAt?: number;
		projectName?: string;
	};
	const archivedCountOf = async (): Promise<number> => {
		const response = await fetch(`${BASE}/api/v1/agent/chats?limit=5`);
		const body = (await response.json()) as { archived?: number; removed?: number };
		check(!("removed" in body), "GET /agent/chats 不再返回 removed");
		return Number(body.archived) || 0;
	};
	const archivedListOf = async (): Promise<ArchivedChat[]> => {
		const response = await fetch(`${BASE}/api/v1/agent/chats/archived?limit=200`);
		const body = (await response.json()) as { chats?: ArchivedChat[]; total?: number };
		return body.chats ?? [];
	};
	const archiveOne = (conversationId: string, action = "archive") =>
		fetch(`${BASE}/api/v1/agent/chat/${encodeURIComponent(conversationId)}/${action}`, {
			method: "POST",
		});

	const archiveBaseline = await archivedCountOf();
	const archiveChatRun = await chat({
		chatKind: "worker",
		messages: [{ role: "user", content: "归档探针：这条不要了" }],
	});
	const archiveChatId = archiveChatRun.result.conversationId ?? "";
	check(Boolean(archiveChatId), "建一条普通会话", String(archiveChatRun.status));
	const archiveResponse = await archiveOne(archiveChatId, "archive");
	check(archiveResponse.status === 200, "POST /chat/:id/archive → 200", String(archiveResponse.status));
	check((await archivedCountOf()) === archiveBaseline + 1, "归档计数 +1");
	let archivedList = await archivedListOf();
	const archivedEntry = archivedList.find((chat) => chat.conversationId === archiveChatId);
	check(Boolean(archivedEntry?.archived), "归档清单包含该会话且 archived=true");
	check(
		typeof archivedEntry?.archivedAt === "number" && archivedEntry.archivedAt > 0,
		"归档清单带 archivedAt",
		String(archivedEntry?.archivedAt),
	);

	const unarchiveResponse = await archiveOne(archiveChatId, "unarchive");
	check(unarchiveResponse.status === 200, "POST /chat/:id/unarchive → 200");
	check((await archivedCountOf()) === archiveBaseline, "单条恢复后归档计数回落");
	check(
		!(await archivedListOf()).some((chat) => chat.conversationId === archiveChatId),
		"单条恢复后不在归档清单",
	);

	const hideAliasResponse = await archiveOne(archiveChatId, "hide");
	check(hideAliasResponse.status === 200, "/hide 兼容别名仍可用");
	await archiveOne(archiveChatId, "unarchive");

	// 项目连带：当前项目仍选中；新建 worker 会话会记 projectId
	const ownedChatRun = await chat({
		chatKind: "worker",
		messages: [{ role: "user", content: "项目归档连带探针" }],
	});
	const ownedChatId = ownedChatRun.result.conversationId ?? "";
	check(Boolean(ownedChatId), "在当前项目下建一条普通会话", String(ownedChatRun.status));
	const archiveProjectResponse = await fetch(`${BASE}/api/v1/projects/${projectId}/archive`, {
		method: "POST",
	});
	const archiveProjectBody = (await archiveProjectResponse.json().catch(() => ({}))) as {
		archivedChats?: number;
		project?: { archived?: boolean };
	};
	check(
		archiveProjectResponse.status === 200 && archiveProjectBody.project?.archived === true,
		"项目归档 → 200 archived=true",
		String(archiveProjectResponse.status),
	);
	check(
		Number(archiveProjectBody.archivedChats) >= 1,
		"项目归档连带归档该项目下新建的会话",
		`archivedChats=${archiveProjectBody.archivedChats}`,
	);
	archivedList = await archivedListOf();
	check(
		archivedList.some(
			(chat) => chat.conversationId === ownedChatId && chat.projectName === GATE_PROJECT_NAME,
		),
		"连带归档的会话带项目名",
	);
	const restoreProjectResponse = await fetch(`${BASE}/api/v1/projects/${projectId}/restore`, {
		method: "POST",
	});
	check(restoreProjectResponse.status === 200, "恢复项目 → 200", String(restoreProjectResponse.status));
	check(
		(await archivedListOf()).some((chat) => chat.conversationId === ownedChatId),
		"恢复项目不自动恢复会话（仍在归档）",
	);
	await archiveOne(ownedChatId, "unarchive");
	check(
		!(await archivedListOf()).some((chat) => chat.conversationId === ownedChatId),
		"会话可单独恢复",
	);

	// ── 14.8 永久删除 + 忙时归档（2026-11-13 归档管理对齐 ZCode，接口文档 §2.5）──
	console.log("\n· 14.8 永久删除（预检/执行/回滚开关）+ 忙时归档 400");
	type DeletePreviewNode = { conversationId?: string; title?: string; rounds?: number; lastAt?: number };
	type DeletePreviewBody = {
		conversationId?: string;
		title?: string;
		rounds?: number;
		lastAt?: number;
		archivedAt?: number;
		blocked?: { reason?: string; detail?: string };
		subtree?: DeletePreviewNode[];
		estimate?: { conversations?: number; entries?: number; tasks?: number; submissions?: number };
	};
	const deletionPreviewOf = (conversationId: string) =>
		fetch(`${BASE}/api/v1/agent/chat/${encodeURIComponent(conversationId)}/deletion-preview`);
	const deletionDeleteOf = (conversationId: string) =>
		fetch(`${BASE}/api/v1/agent/chat/${encodeURIComponent(conversationId)}/delete`, { method: "POST" });
	/** sessions/search 枚举面 = Chats 全量映射（含归档）：删除后映射清了，搜索自动不含它。 */
	const sessionSearchIds = async (q: string): Promise<string[]> => {
		const response = await fetch(
			`${BASE}/api/v1/agent/sessions/search?q=${encodeURIComponent(q)}&days=365&limit=20`,
		);
		const body = (await response.json()) as { hits?: { conversationId?: string }[] };
		return (body.hits ?? []).map((hit) => String(hit.conversationId));
	};
	const putFlag = (key: string, value: string) =>
		fetch(`${BASE}/api/v1/agent/flags/${key}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value }),
		});

	// 回滚开关先归位：flags 文件跨探针轮次留存（上一轮异常退出可能留下 false），
	// 别让上轮残留污染本轮的正常态断言。
	const hardDeleteReset = await putFlag("CHAT_HARD_DELETE", "true");
	check(hardDeleteReset.status === 200, "CHAT_HARD_DELETE 归位 true", String(hardDeleteReset.status));

	// 正常态：建会话 → 归档 → 预检形状（subtree / estimate）
	const DEL_ANCHOR = "zqk77";
	const delChatRun = await chat({
		chatKind: "worker",
		messages: [{ role: "user", content: `归档探针：删除锚点${DEL_ANCHOR}，这条要连根删掉` }],
	});
	const delChatId = delChatRun.result.conversationId ?? "";
	check(Boolean(delChatId), "建一条待删除的普通会话", String(delChatRun.status));

	const freshPreviewRes = await deletionPreviewOf(delChatId);
	const freshPreview = (await freshPreviewRes.json().catch(() => ({}))) as DeletePreviewBody;
	check(
		freshPreviewRes.status === 200 && freshPreview.blocked?.reason === "not-archived",
		"未归档 preview → 200 + blocked not-archived（门槛是字段不是错误码）",
		`${freshPreviewRes.status} ${freshPreview.blocked?.reason}`,
	);
	check(
		Array.isArray(freshPreview.subtree) && freshPreview.subtree.length === 0,
		"blocked 时 subtree 为空数组（不给名单）",
	);
	check(
		(freshPreview.estimate?.conversations ?? 0) >= 1,
		"blocked 时 estimate 仍给出（SQL COUNT）",
		JSON.stringify(freshPreview.estimate),
	);

	check((await archiveOne(delChatId, "archive")).status === 200, "归档待删除会话 → 200");
	const delPreviewRes = await deletionPreviewOf(delChatId);
	const delPreview = (await delPreviewRes.json().catch(() => ({}))) as DeletePreviewBody;
	check(
		delPreviewRes.status === 200 && delPreview.blocked === undefined,
		"归档后 preview 不再 blocked",
		`${delPreviewRes.status}`,
	);
	check(delPreview.conversationId === delChatId, "preview.conversationId = 目标");
	check(
		typeof delPreview.archivedAt === "number" && delPreview.archivedAt > 0,
		"preview 带 archivedAt",
		String(delPreview.archivedAt),
	);
	check(
		delPreview.rounds === 1 && typeof delPreview.lastAt === "number" && delPreview.lastAt > 0,
		"preview.rounds / lastAt 有值",
		`rounds=${delPreview.rounds}`,
	);
	check(
		delPreview.subtree?.some((node) => node.conversationId === delChatId) === true &&
			delPreview.subtree.every(
				(node) =>
					typeof node.conversationId === "string" &&
					typeof node.rounds === "number" &&
					typeof node.lastAt === "number",
			),
		"subtree 名单含目标且节点形状 {conversationId,title,rounds,lastAt}",
	);
	check(
		delPreview.estimate?.conversations === 1 &&
			(delPreview.estimate.entries ?? 0) >= 2 &&
			(delPreview.estimate.submissions ?? 0) >= 1,
		"estimate 计数与内容对得上",
		JSON.stringify(delPreview.estimate),
	);

	// 正向对照：sessions/search（枚举面 = Chats 全量映射，含归档）此刻搜得到
	const hitsBeforeDelete = await sessionSearchIds(DEL_ANCHOR);
	check(hitsBeforeDelete.includes(delChatId), "删除前 sessions/search 能搜到（对照）");

	const delDeleteRes = await deletionDeleteOf(delChatId);
	const delDeleteBody = (await delDeleteRes.json().catch(() => ({}))) as {
		ok?: boolean;
		deleted?: { conversations?: number; entries?: number; tasks?: number; submissions?: number };
		error?: string;
	};
	check(
		delDeleteRes.status === 200 && delDeleteBody.ok === true,
		"POST delete → 200 {ok:true}",
		`${delDeleteRes.status} ${delDeleteBody.error ?? ""}`,
	);
	check(
		(delDeleteBody.deleted?.conversations ?? 0) >= 1 &&
			(delDeleteBody.deleted?.entries ?? 0) >= 2 &&
			(delDeleteBody.deleted?.submissions ?? 0) >= 1,
		"deleted 计数全 >0（conversations/entries/submissions）",
		JSON.stringify(delDeleteBody.deleted),
	);
	check(
		!(await archivedListOf()).some((chat) => chat.conversationId === delChatId),
		"删后归档清单不含它",
	);
	const activeListAfter = (await (
		await fetch(`${BASE}/api/v1/agent/chats?limit=200`)
	).json()) as { chats?: { conversationId?: string }[] };
	check(
		!(activeListAfter.chats ?? []).some((chat) => chat.conversationId === delChatId),
		"删后活跃清单不含它",
	);
	check(
		!(await sessionSearchIds(DEL_ANCHOR)).includes(delChatId),
		"删后内容搜索（sessions/search）不含它",
	);
	check(
		(await deletionPreviewOf(delChatId)).status === 404,
		"删后 preview → 404 unknown_chat",
	);

	// kind 门槛：主对话（chief，缺项即 chief）归档了也拒
	const chiefArchivedCount = await archivedCountOf();
	check(
		(await archiveOne(externalId, "archive")).status === 200,
		"归档主对话（chief）",
	);
	const chiefPreviewRes = await deletionPreviewOf(externalId);
	const chiefPreview = (await chiefPreviewRes.json().catch(() => ({}))) as DeletePreviewBody;
	check(
		chiefPreviewRes.status === 200 && chiefPreview.blocked?.reason === "kind",
		"chief preview → blocked kind",
		chiefPreview.blocked?.detail ?? "",
	);
	const chiefDeleteRes = await deletionDeleteOf(externalId);
	const chiefDeleteBody = (await chiefDeleteRes.json().catch(() => ({}))) as {
		error?: string;
		blocked?: { reason?: string };
	};
	check(
		chiefDeleteRes.status === 400 &&
			chiefDeleteBody.error === "delete_blocked" &&
			chiefDeleteBody.blocked?.reason === "kind",
		"chief delete → 400 delete_blocked/kind",
		`${chiefDeleteRes.status} ${chiefDeleteBody.error}`,
	);
	await archiveOne(externalId, "unarchive");
	check(
		(await archivedCountOf()) === chiefArchivedCount,
		"chief 预检完恢复原状（unarchive，不留下归档）",
	);

	// 忙时归档 400：闸住假上游的模型响应 = 这轮真在跑（pi.live.run 是内核自有状态）。
	// 等到模型请求**到达假上游**再归档：generation 先于模型请求置 run，此刻必忙，无竞态。
	const holdArchivedBaseline = await archivedCountOf();
	const holdRequestBaseline = gateRequests.length;
	gateUpstreamHold = true;
	const holdResponse = await fetch(`${BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messages: [{ role: "user", content: "归档探针：趁我跑着归档试试" }] }),
	});
	const holdReader = holdResponse.body?.getReader();
	const holdDecoder = new TextDecoder();
	let holdConvId = "";
	let holdBuffer = "";
	while (holdReader && !holdConvId) {
		const chunk = await holdReader.read();
		if (chunk.done) break;
		holdBuffer += holdDecoder.decode(chunk.value, { stream: true });
		holdConvId = /"conversationId":"([^"]+)"/.exec(holdBuffer)?.[1] ?? "";
	}
	for (let attempt = 0; attempt < 100 && gateRequests.length <= holdRequestBaseline; attempt += 1) {
		await sleep(50);
	}
	check(Boolean(holdConvId), "busy 会话已开跑", holdConvId);
	check(
		gateRequests.length > holdRequestBaseline,
		"busy 轮的模型请求已到达假上游（run 必已置位）",
	);
	const holdArchiveRes = await fetch(
		`${BASE}/api/v1/agent/chat/${encodeURIComponent(holdConvId)}/archive`,
		{ method: "POST" },
	);
	const holdArchiveBody = (await holdArchiveRes.json().catch(() => ({}))) as {
		error?: string;
		message?: string;
	};
	check(
		holdArchiveRes.status === 400 &&
			holdArchiveBody.error === "conversation_busy" &&
			holdArchiveBody.message === "会话正在运行，请先停止再归档",
		"运行中归档 → 400 conversation_busy 带说明",
		`${holdArchiveRes.status} ${holdArchiveBody.error}`,
	);
	check((await archivedCountOf()) === holdArchivedBaseline, "忙时归档被拒：归档计数不变");
	gateUpstreamHold = false;
	releaseHeldUpstream();
	// 放闸后把这一轮读到 done：不留挂着的一轮给后面的段落（§15 重启前核账干净）
	let holdDone = false;
	while (holdReader && !holdDone) {
		const chunk = await holdReader.read();
		if (chunk.done) break;
		holdDone = holdDecoder.decode(chunk.value, { stream: true }).includes('"type":"done"');
	}
	check(holdDone, "放开闸后 busy 轮正常收尾", holdConvId);
	await archiveOne(holdConvId, "archive");
	await archiveOne(holdConvId, "unarchive"); // 预检段结束恢复原状，不留下归档

	// 回滚开关：CHAT_HARD_DELETE=false → 两端点 400「永久删除已关闭」
	check((await putFlag("CHAT_HARD_DELETE", "false")).status === 200, "PUT CHAT_HARD_DELETE=false");
	const offPreviewRes = await deletionPreviewOf("probe-disabled-id");
	const offPreviewBody = (await offPreviewRes.json().catch(() => ({}))) as { message?: string };
	check(
		offPreviewRes.status === 400 && offPreviewBody.message === "永久删除已关闭",
		"开关关：preview → 400 永久删除已关闭",
		`${offPreviewRes.status} ${offPreviewBody.message}`,
	);
	check((await deletionDeleteOf("probe-disabled-id")).status === 400, "开关关：delete → 400");
	check((await putFlag("CHAT_HARD_DELETE", "true")).status === 200, "改回 CHAT_HARD_DELETE=true");
	check(
		(await deletionPreviewOf("probe-disabled-id")).status === 404,
		"开关开回：preview 恢复查 404（unknown_chat，不再是开关 400）",
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

	// 2026-11-13 导出升级（接口文档 §2.5）：可选块 / 多文件 / 压缩包
	const zipResponse = await fetch(`${BASE}/api/v1/agent/export?format=zip`);
	const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
	check(zipResponse.status === 200, "GET /agent/export?format=zip → 200", String(zipResponse.status));
	check(
		(zipResponse.headers.get("content-type") ?? "").includes("application/zip"),
		"响应是 application/zip",
		zipResponse.headers.get("content-type") ?? "",
	);
	const zipDisposition = zipResponse.headers.get("content-disposition") ?? "";
	check(
		/attachment/.test(zipDisposition) && /selenite-export-\d{4}-\d{2}-\d{2}-\d{4}\.zip/.test(zipDisposition),
		"Content-Disposition = attachment + 日期时分文件名",
		zipDisposition,
	);
	check(
		zipBuffer.subarray(0, 2).toString("binary") === "PK" && zipBuffer.length > 22,
		"响应体是 zip 字节",
		String(zipBuffer.length),
	);

	const zipFiles = zipNames(zipBuffer);
	check(zipFiles.length > 0, "zip 里有文件", String(zipFiles.length));
	check(zipFiles.some((name) => name.endsWith("/README.md")), "包根有 README.md");
	check(zipFiles.some((name) => name.endsWith("/manifest.json")), "包根有 manifest.json");
	check(
		zipFiles.some((name) => name.endsWith("/conversations/index.json")),
		"默认选全部块：conversations/index.json 在包里",
	);
	check(
		zipFiles.some((name) => /\/conversations\/[^/]+\/transcript\.md$/.test(name)),
		"每段会话一个文件夹（transcript.md）",
		zipFiles.find((name) => name.endsWith("/transcript.md")) ?? "",
	);

	const manifestName = zipFiles.find((name) => name.endsWith("/manifest.json")) ?? "";
	const manifestText = manifestName ? zipEntryText(zipBuffer, manifestName) ?? "" : "";
	const readmeName = zipFiles.find((name) => name.endsWith("/README.md")) ?? "";
	const readmeText = readmeName ? zipEntryText(zipBuffer, readmeName) ?? "" : "";
	const zipManifest = manifestText ? (JSON.parse(manifestText) as Record<string, unknown>) : {};
	const zipParts = (zipManifest["parts"] as { id?: string; status?: string; counts?: unknown }[] | undefined) ?? [];
	check(zipManifest["format"] === "lifediary-export", "manifest.format 正确", String(zipManifest["format"]));
	check(zipManifest["formatVersion"] === 1, "manifest.formatVersion = 1");
	check(zipParts.length === 5, "manifest 有五个块", String(zipParts.length));
	check(
		zipParts.every((part) => typeof part.status === "string" && typeof part.id === "string"),
		"每块都带 id 与 status",
	);
	check(Boolean(readmeText.includes("不是可一键恢复的备份格式")), "README 说明「这不是备份」");
	check(!manifestText.includes(SECRET_KEY) && !readmeText.includes(SECRET_KEY), "zip 清单/说明无密钥明文");

	// 只选一块 + 不带图片
	const memoryOnly = await fetch(`${BASE}/api/v1/agent/export?format=zip&parts=memory&images=0`);
	const memoryOnlyBuffer = Buffer.from(await memoryOnly.arrayBuffer());
	const memoryOnlyNames = zipNames(memoryOnlyBuffer);
	check(memoryOnly.status === 200, "parts=memory → 200", String(memoryOnly.status));
	const memoryManifestName = memoryOnlyNames.find((name) => name.endsWith("/manifest.json")) ?? "";
	const memoryManifestText = memoryManifestName ? zipEntryText(memoryOnlyBuffer, memoryManifestName) ?? "" : "";
	const memoryPart = (
		JSON.parse(memoryManifestText) as { parts?: { id?: string; status?: string; notes?: string[] }[] }
	).parts?.[0];
	check(memoryPart?.id === "memory", "只选一块时 manifest 只有这一块", String(memoryPart?.id ?? "?"));
	check(
		memoryPart?.status === "ok"
			? memoryOnlyNames.some((name) => name.endsWith("/memory/records.jsonl"))
			: memoryPart?.status === "empty",
		"记忆块：有数据就带 records.jsonl，没有就如实标 empty",
		`${memoryPart?.status ?? "?"} ${(memoryPart?.notes ?? []).join("；")}`,
	);
	check(
		memoryOnlyNames.every((name) => !name.includes("/conversations/")),
		"没选的块不建目录",
		memoryOnlyNames.filter((name) => name.includes("/conversations/")).join(","),
	);

	const badParts = await fetch(`${BASE}/api/v1/agent/export?format=zip&parts=nope`);
	check(badParts.status === 400, "未知 parts → 400", String(badParts.status));
	const badImages = await fetch(`${BASE}/api/v1/agent/export?format=zip&images=2`);
	check(badImages.status === 400, "images 只认 0/1 → 400", String(badImages.status));

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
	// 计划附件 / 返工轮次夹具（2026-11-09 §2.3 / §1.5）：详情必须读得到，缺省不出现。
	store.saveTicket(
		fixture("T-steps", {
			steps: ["读 src/a.ts", "改 src/b.ts"],
			repairRound: 1,
		}),
	);
	// 任务专线夹具（8g）：非终态 + 有宿主会话，但**没有 plan.json**——
	// 续跑会在派活前被 chancellor 拒掉，正好验 resumeOnly（不偷偷改派新单）。
	store.saveTicket(
		fixture("T-say", {
			status: "needs_you",
			originConversationId: String(internalId),
			// 键控基线（批 21 §四）：steps 进专线的验收标准块（没有 plan.json → writes 为空）。
			steps: ["确认需求", "给出方案"],
		}),
	);
	// 多副本聚合夹具（批 26 §二）：groupId 就是 ticket.idempotencyKey。
	// 同一个库里 idempotency_key 有唯一约束，所以同组的两张必须分散在不同 runs 目录
	// （真实扇出也是按领域分目录落的）—— 这里放一张在顶层，另一张放到下面领域目录。
	store.saveTicket(
		fixture("T-group-a", { idempotencyKey: "probe-group-1", status: "done" }),
	);
	store.saveTicket(
		fixture("T-group-c", { idempotencyKey: "probe-group-2", status: "done" }),
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
	// 聚合组的另一半（批 26 §二）：同组副本落在领域目录，聚合端点必须跨目录数齐。
	domainStore.saveTicket(
		fixture("T-group-b", {
			idempotencyKey: "probe-group-1",
			options: { dry: true, maxTasks: 8, workRoot: TICKETS_ROOT, domain: "probe-domain" },
		}),
	);
	domainStore.saveTicket(
		fixture("T-group-d", {
			idempotencyKey: "probe-group-2",
			status: "failed",
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
	// 计划附件 / 返工轮次（2026-11-09 §2.3 / §1.5）：有则下发，无则不出现。
	const stepsDetail = (await (await fetch(`${BASE}/api/v1/tickets/T-steps`)).json()) as {
		steps?: string[];
		repairRound?: number;
		childTicket?: unknown;
	};
	check(
		Array.isArray(stepsDetail.steps) &&
			stepsDetail.steps.length === 2 &&
			stepsDetail.steps[1] === "改 src/b.ts",
		"详情下发 steps（顺序原样）",
		JSON.stringify(stepsDetail.steps),
	);
	check(stepsDetail.repairRound === 1, "详情下发 repairRound", String(stepsDetail.repairRound));
	const plainDetail = (await (await fetch(`${BASE}/api/v1/tickets/T-child`)).json()) as Record<
		string,
		unknown
	>;
	check(
		!("steps" in plainDetail) && !("repairRound" in plainDetail),
		"没有 steps / repairRound 的单不带这两个键（前端零影响）",
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

	// ── 18.6 多副本聚合（2026-11-10 批 26 §二，接口文档 §2.9）──────
	// 两个组：g-1 一终态一在办 → pending；g-2 两张都终态 → settled；未知组 → 404。
	console.log("\n· 18.6 多副本聚合：GET /tickets/groups/:groupId");
	const groupPending = await fetch(`${BASE}/api/v1/tickets/groups/probe-group-1`);
	const groupPendingBody = (await groupPending.json()) as {
		ok?: boolean;
		groupId?: string;
		total?: number;
		done?: number;
		pending?: number;
		status?: string;
	};
	check(
		groupPending.status === 200 &&
			groupPendingBody.total === 2 &&
			groupPendingBody.done === 1 &&
			groupPendingBody.pending === 1 &&
			groupPendingBody.status === "pending",
		"一终态一在办 → pending（2/1/1）",
		JSON.stringify(groupPendingBody),
	);
	const groupSettled = (await (
		await fetch(`${BASE}/api/v1/tickets/groups/probe-group-2`)
	).json()) as { total?: number; done?: number; pending?: number; status?: string };
	check(
		groupSettled.total === 2 &&
			groupSettled.done === 2 &&
			groupSettled.pending === 0 &&
			groupSettled.status === "settled",
		"全部终态 → settled（2/2/0）",
		JSON.stringify(groupSettled),
	);
	const groupUnknown = await fetch(`${BASE}/api/v1/tickets/groups/probe-group-nobody`);
	check(groupUnknown.status === 404, "未知组 → 404", String(groupUnknown.status));

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
	check(
		sayTexts.some(
			(text) =>
				text.includes("[[keyed:task:acceptance]]") &&
				text.includes("确认需求") &&
				text.includes("给出方案"),
		),
		"键控基线：验收标准（steps）随专线双写",
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
					files?: { path: string; name: string; mimeType?: string; bytes?: number }[];
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

	// ── 20b. 附件走路径（2026-11-13）────────────────────────
	// 浏览器没有真实路径 → 上传落盘拿服务端路径；消息里只带 path，durable 不存文件内容。
	console.log("\n· 20b. 附件走路径：上传拿服务端路径 → 消息只带 path");
	const upload = await fetch(`${BASE}/api/v1/agent/attachments`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "探针附件.txt",
			mimeType: "text/plain",
			data: Buffer.from("附件正文").toString("base64"),
		}),
	});
	const uploadBody = (await upload.json()) as {
		ok?: boolean;
		file?: { path: string; name: string; bytes: number };
	};
	check(
		upload.status === 200 && uploadBody.file?.name === "探针附件.txt",
		"上传落盘 → 200 + 文件名",
		`${String(upload.status)} ${uploadBody.file?.name ?? ""}`,
	);
	const uploadedPath = uploadBody.file?.path ?? "";
	check(Boolean(uploadedPath) && existsSync(uploadedPath), "回传的是服务端可读绝对路径", uploadedPath);
	check(
		uploadBody.file?.bytes === Buffer.byteLength("附件正文"),
		"字节数一致",
		String(uploadBody.file?.bytes),
	);

	const withFile = await chat({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "看看这个文件" },
					{ type: "file", path: uploadedPath, name: "探针附件.txt", mimeType: "text/plain" },
				],
			},
		],
	});
	const fileConv = withFile.result.conversationId ?? "";
	check(
		withFile.status === 200 && withFile.result.done,
		"带文件消息被受理并收尾",
		String(withFile.status),
	);
	const fileUser = (await readDetailed(fileConv)).find((message) => message.role === "user");
	check(
		fileUser?.files?.[0]?.path === uploadedPath && fileUser?.files?.[0]?.name === "探针附件.txt",
		"回读带 files（路径 + 名字）",
		JSON.stringify(fileUser?.files),
	);
	check(fileUser?.text === "看看这个文件", "正文与文件分开落，text 仍可读");

	const pathMissing = await chat({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "坏路径" },
					{ type: "file", path: "D:\\不存在\\a.txt", name: "a.txt" },
				],
			},
		],
	});
	check(pathMissing.status === 400, "路径不存在 → 400 带说明", String(pathMissing.status));

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

	// ── 23b. 团队包（2026-11-10 批 25 §二）────────────────────
	// 导出 → 改名导入 → 重名 400；开关关掉的两个 404 放在下面同一轮重启里验。
	console.log("\n· 23b. 团队包：导出附件 / 导入落安全态 / 重名 400");
	const bundleResponse = await fetch(`${BASE}/api/v1/partners/${contractPartnerId}/bundle`);
	const bundleDisposition = bundleResponse.headers.get("content-disposition") ?? "";
	const bundleBody = (await bundleResponse.text()).trim();
	let bundleJson: Record<string, any> | null = null;
	try {
		bundleJson = JSON.parse(bundleBody) as Record<string, any>;
	} catch {
		bundleJson = null;
	}
	check(
		bundleResponse.status === 200 &&
			/^attachment; filename=".*\.json"/.test(bundleDisposition) &&
			bundleJson?.format === "lifediary-partner-bundle" &&
			bundleJson?.partner?.name === "契约探针" &&
			typeof bundleJson?.contract === "string" &&
			bundleJson.contract.includes("## 职责范围") &&
			bundleJson?.safety?.approvalLevel === "ask-all",
		"GET /partners/:id/bundle：JSON 附件，含档案 / SOUL / 契约 / safety",
		String(bundleResponse.status),
	);

	const importPayload = JSON.parse(JSON.stringify(bundleJson ?? {})) as Record<string, any>;
	if (importPayload.partner) importPayload.partner.name = "导入探针";
	// 故意把包里的开关改成"最松"：导入必须无视，落成安全态。
	importPayload.safety = { approvalLevel: "none", skillsEnabled: true, routinesPaused: false };
	if (importPayload.partner) importPayload.partner.status = "active";
	const imported = await fetch(`${BASE}/api/v1/partners/import-bundle`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(importPayload),
	});
	const importedBody = (await imported.json()) as {
		partner?: { name?: string; status?: string; domain?: string | null };
		safety?: { approvalLevel?: string };
	};
	check(
		imported.status === 201 &&
			importedBody.partner?.name === "导入探针" &&
			importedBody.partner.status === "paused" &&
			!importedBody.partner.domain &&
			importedBody.safety?.approvalLevel === "ask-all",
		"POST import-bundle：201，到货 paused + safety 全保守（不信包里的开关）",
		`${String(imported.status)} / ${String(importedBody.partner?.status)}`,
	);

	const duplicateImport = await fetch(`${BASE}/api/v1/partners/import-bundle`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(importPayload),
	});
	const duplicateBody = (await duplicateImport.json()) as { code?: string };
	check(
		duplicateImport.status === 400 && duplicateBody.code === "duplicate_name",
		"重名导入 → 400 duplicate_name，不覆盖",
		String(duplicateImport.status),
	);

	// 两个开关同一次重启里验完：edit → 404；parts → 400；纯字符串照常
	// 再加 8g 的 TASK_AS_CONVERSATION=false：回话端点同样 404（未启用）。
	server.kill();
	await sleep(800);
	server = startServer({
		AGENT_ATTACHMENTS: "false",
		// 2026-11-13 附件走路径：任意文件入口的上传端点单独一个开关
		AGENT_FILE_ATTACHMENTS: "false",
		AGENT_EDIT_RESEND: "false",
		TASK_AS_CONVERSATION: "false",
		// 2026-11-08 员工人格化刀一 E1 的回滚开关：写端点 400 带说明（不是 404）
		PARTNER_CONTRACT: "false",
		// 2026-11-10 批 25 §2.4：团队包整体关掉 → 两个端点都 404
		PARTNER_BUNDLE: "false",
		COMPANIONS_ENABLED: "true",
		AGENT_SSE_SEQ_DB_PATH: SEQ_DB,
	});
	await waitForReady();

	const policyOff = (await (await fetch(`${BASE}/api/v1/agent/policy`)).json()) as {
		attachments?: boolean;
		fileAttachments?: boolean;
		editResend?: boolean;
	};
	check(
		policyOff.attachments === false && policyOff.editResend === false,
		"policy 投影如实给出两个开关（前端据此不渲染入口）",
		JSON.stringify(policyOff),
	);
	check(
		policyOff.fileAttachments === false,
		"AGENT_FILE_ATTACHMENTS=false：policy 的 fileAttachments=false",
		String(policyOff.fileAttachments),
	);

	const uploadOff = await fetch(`${BASE}/api/v1/agent/attachments`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "x.txt", data: Buffer.from("x").toString("base64") }),
	});
	check(
		uploadOff.status === 404,
		"AGENT_FILE_ATTACHMENTS=false：上传端点 404",
		String(uploadOff.status),
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

	// 团队包回滚开关（批 25 §2.4）：关掉 = 两个端点都 404（能力未启用）。
	const bundleOff = await fetch(`${BASE}/api/v1/partners/${contractPartnerId}/bundle`);
	const importOff = await fetch(`${BASE}/api/v1/partners/import-bundle`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	check(
		bundleOff.status === 404 && importOff.status === 404,
		"PARTNER_BUNDLE=false：导出 / 导入两个端点都 404",
		`${bundleOff.status} / ${importOff.status}`,
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

	// ── 26. 高级开关 + 技能启停位（2026-11-09）────────────────────
	console.log("\n· 26. 高级开关读写 / 技能默认全关·启停·批量");
	const flagsList = (await (await fetch(`${BASE}/api/v1/agent/flags`)).json()) as {
		flags: { key: string; value: string; hot: boolean; defaultValue: string }[];
	};
	check(
		flagsList.flags.some((flag) => flag.key === "AUTONOMY_ENABLED" && flag.hot) &&
			flagsList.flags.some((flag) => flag.key === "COMPANIONS_ENABLED" && !flag.hot) &&
			// 对话逐字浮现（2026-11-13）：web 开新消息时懒读，默认开。
			flagsList.flags.some(
				(flag) =>
					flag.key === "CHAT_STREAM_REVEAL" && flag.hot && flag.defaultValue === "true",
			),
		"GET /agent/flags：白名单齐全且 hot 标注正确",
	);
	const flagPut = await fetch(`${BASE}/api/v1/agent/flags/AGENT_ATTACHMENTS`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "false" }),
	});
	const flagPutJson = (await flagPut.json()) as { ok?: boolean; hot?: boolean };
	check(flagPut.status === 200 && flagPutJson.ok === true && flagPutJson.hot === true, "PUT 开关成功且标热");
	const flagBad = await fetch(`${BASE}/api/v1/agent/flags/MEMORY_EXTRACT`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "bogus" }),
	});
	check(flagBad.status === 400, "非法取值 400", String(flagBad.status));
	// 热语义实证：attachmentsEnabled 懒读 env——关掉后 capabilities 投影立刻变（同进程内）
	const flagsAfter = (await (await fetch(`${BASE}/api/v1/agent/flags`)).json()) as {
		flags: { key: string; value: string; overridden: boolean }[];
	};
	check(
		flagsAfter.flags.find((flag) => flag.key === "AGENT_ATTACHMENTS")?.value === "false" &&
			flagsAfter.flags.find((flag) => flag.key === "AGENT_ATTACHMENTS")?.overridden === true,
		"GET 回读：值与 overridden 都对",
	);
	await fetch(`${BASE}/api/v1/agent/flags/AGENT_ATTACHMENTS`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: "true" }),
	});

	// 技能：建一条 → 默认关 → 单条开 → 批量关（默认全关是 2026-11-09 用户口径）
	const skillPut = await fetch(`${BASE}/api/v1/agent/skills/probe-skill`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content: "探针技能摘要\n探针技能正文" }),
	});
	check(skillPut.status === 200 || skillPut.status === 201, "探针技能已写入", String(skillPut.status));
	const skillList = (await (await fetch(`${BASE}/api/v1/agent/skills`)).json()) as {
		items: { name: string; enabled: boolean }[];
	};
	const probeSkill = skillList.items.find((item) => item.name === "probe-skill");
	check(probeSkill?.enabled === false, "新建技能默认全关", String(probeSkill?.enabled));
	await fetch(`${BASE}/api/v1/agent/skills/probe-skill/enabled`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: true }),
	});
	const skillList2 = (await (await fetch(`${BASE}/api/v1/agent/skills`)).json()) as {
		items: { name: string; enabled: boolean }[];
	};
	check(
		skillList2.items.find((item) => item.name === "probe-skill")?.enabled === true,
		"单条开启后 enabled=true",
	);
	const skillAllOff = await fetch(`${BASE}/api/v1/agent/skills/enabled-all`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	const skillAllOffJson = (await skillAllOff.json()) as { ok?: boolean; count?: number };
	check(skillAllOff.status === 200 && skillAllOffJson.ok === true && (skillAllOffJson.count ?? 0) >= 1, "批量全关成功");

	// ── 27. 员工档案 · 技能清单（2026-11-09）──────────────────
	console.log("\n· 27. 员工档案：GET /partners/:id/skills（只读技能清单）");
	// §18 起探针进程把 COMPANIONS_ENABLED 置了 false（为了 import agent 不碰执事库），
	// §25/26 的服务没显式开回来。执事端点要真挂着，这里单独起一轮开着的进程。
	server.kill();
	await sleep(800);
	server = startServer({ COMPANIONS_ENABLED: "true", LIFEDIARY_DEFAULT_WORKSPACE: seedWs });
	await waitForReady();

	const skillsPartner = await fetch(`${BASE}/api/v1/partners`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "技能清单探针" }),
	});
	const skillsPartnerBody = (await skillsPartner.json()) as { ok?: boolean; partner?: { id?: string } };
	const skillsPartnerId = skillsPartnerBody.partner?.id ?? "";
	check(
		skillsPartner.status === 201 && Boolean(skillsPartnerId),
		"建一个用来验技能清单的执事",
		String(skillsPartner.status),
	);

	const skillsEmpty = (await (
		await fetch(`${BASE}/api/v1/partners/${skillsPartnerId}/skills`)
	).json()) as { ok?: boolean; skills?: unknown[] };
	check(
		skillsEmpty.ok === true && Array.isArray(skillsEmpty.skills) && skillsEmpty.skills.length === 0,
		"空技能目录 → skills: []",
	);

	// 直接写家目录（同 partner_skill_write 的形态：skills/<slug>.md，第 1 行 = 摘要）
	const skillsDir = join(".data/probe-http-partner-homes", skillsPartnerId, "skills");
	mkdirSync(skillsDir, { recursive: true });
	writeFileSync(join(skillsDir, "probe-record.md"), "探针技能：一页看全的摘要\n这是正文，不进 summary。\n", "utf8");
	writeFileSync(join(skillsDir, "ignore.txt"), "不是 md，不该出现", "utf8");

	const skillsList = (await (
		await fetch(`${BASE}/api/v1/partners/${skillsPartnerId}/skills`)
	).json()) as {
		ok?: boolean;
		skills?: { name: string; summary: string; updatedAt: string }[];
	};
	const oneSkill = skillsList.skills?.find((skill) => skill.name === "probe-record");
	check(
		skillsList.ok === true &&
			oneSkill?.summary === "探针技能：一页看全的摘要" &&
			!Number.isNaN(Date.parse(oneSkill?.updatedAt ?? "")),
		"GET skills 读回 name / 首行 summary / mtime",
		oneSkill ? `${oneSkill.name} · ${oneSkill.summary}` : "读不到",
	);
	check(
		skillsList.skills?.every((skill) => skill.name !== "ignore") === true,
		"非 .md 文件不进清单",
	);

	const skillsMissing = await fetch(`${BASE}/api/v1/partners/no-such-partner/skills`);
	check(skillsMissing.status === 404, "未知执事 → 404", String(skillsMissing.status));

	// ── 28. 导出「接续文件」/ 旧会话定点找回（2026-11-10 批 20）────
	console.log("\n· 28. 会话导出「接续文件」与旧会话定点找回");
	const handoffResponse = await fetch(
		`${BASE}/api/v1/agent/chat/${externalId}/export?format=handoff&limit=2`,
	);
	const exportType = handoffResponse.headers.get("content-type") ?? "";
	const exportBody = await handoffResponse.text();
	check(handoffResponse.status === 200, "导出端点可用", String(handoffResponse.status));
	check(exportType.includes("text/markdown"), "返回 markdown", exportType);
	check(
		handoffResponse.headers.get("content-disposition")?.includes("attachment") === true,
		"按附件下载",
	);
	check(exportBody.includes("这份文件可以直接粘给任何 AI 继续聊"), "带读取说明");
	check(exportBody.includes("你是主人身边的 AI 助手"), "带角色说明");
	check(exportBody.includes("## 记忆摘要"), "带记忆摘要段");
	check(exportBody.includes("## 最近 2 轮对话"), "limit 生效（2 轮）");
	check(
		(exportBody.match(/^\*\*主人\*\*/gm) ?? []).length === 2,
		"只含最近 2 轮的用户原文",
		String((exportBody.match(/^\*\*主人\*\*/gm) ?? []).length),
	);
	const exportBadFormat = await fetch(`${BASE}/api/v1/agent/chat/${externalId}/export?format=json`);
	check(exportBadFormat.status === 400, "不支持的 format → 400", String(exportBadFormat.status));
	const exportBadLimit = await fetch(`${BASE}/api/v1/agent/chat/${externalId}/export?limit=0`);
	check(exportBadLimit.status === 400, "limit 越界 → 400", String(exportBadLimit.status));
	const exportMissing = await fetch(
		`${BASE}/api/v1/agent/chat/00000000-0000-4000-8000-000000000000/export`,
	);
	check(exportMissing.status === 404, "未知会话 → 404", String(exportMissing.status));

	const allMessages = (await (
		await fetch(`${BASE}/api/v1/agent/chat/${externalId}/messages`)
	).json()) as { messages: { role: string; text: string }[] };
	const mid = Math.min(2, allMessages.messages.length - 1);
	const contextResponse = await fetch(
		`${BASE}/api/v1/agent/chat/${externalId}/context?aroundIndex=${mid}&radius=1`,
	);
	const contextBody = (await contextResponse.json()) as {
		total?: number;
		from?: number;
		to?: number;
		messages?: { index: number; role: string }[];
	};
	check(contextResponse.status === 200, "定点找回可用", String(contextResponse.status));
	check(
		contextBody.total === allMessages.messages.length,
		"total 与 /messages 一致",
		`${contextBody.total} vs ${allMessages.messages.length}`,
	);
	check(
		contextBody.messages?.length === 3 &&
			contextBody.from === mid - 1 &&
			contextBody.to === mid + 1,
		"中心前后各 1 条",
		`${contextBody.from}–${contextBody.to}`,
	);
	check(
		contextBody.messages?.every((message, offset) => message.index === mid - 1 + offset) === true,
		"每条带绝对下标",
	);
	const contextOut = await fetch(
		`${BASE}/api/v1/agent/chat/${externalId}/context?aroundIndex=9999&radius=1`,
	);
	const contextOutBody = (await contextOut.json()) as { total?: number };
	check(
		contextOut.status === 400 && contextOutBody.total === allMessages.messages.length,
		"越界 → 400 且带 total",
	);
	const contextBadRadius = await fetch(
		`${BASE}/api/v1/agent/chat/${externalId}/context?aroundIndex=0&radius=999`,
	);
	check(contextBadRadius.status === 400, "radius 越界 → 400", String(contextBadRadius.status));
	const contextBadIndex = await fetch(
		`${BASE}/api/v1/agent/chat/${externalId}/context?aroundIndex=abc`,
	);
	check(contextBadIndex.status === 400, "aroundIndex 非法 → 400", String(contextBadIndex.status));

	// ── 29. bash 后台任务管理面（2026-11-10 批 21 §二）──────────
	console.log("\n· 29. bash 后台任务：列表 / 日志尾部 / kill / 开关 404");
	server.kill();
	await sleep(800);
	// 预置索引：一条已结束、一条"running"（不是本进程起的 → kill 必须拒绝）。
	// 真跑后台任务要等一次真实超时，探针里不值当；这里验的是管理面读的文件口径。
	const bgDir = ".data/probe-http-bg-jobs";
	rmSync(bgDir, { recursive: true, force: true });
	mkdirSync(bgDir, { recursive: true });
	writeFileSync(
		join(bgDir, "index.json"),
		JSON.stringify(
			[
				{
					id: "bg-probe1-aaaaaa",
					commandSummary: "npm run build",
					startedAt: "2026-11-10T01:00:00.000Z",
					endedAt: "2026-11-10T01:02:00.000Z",
					exitCode: 0,
					status: "done",
				},
				{
					id: "bg-probe2-bbbbbb",
					commandSummary: "npm run dev",
					startedAt: "2026-11-10T01:03:00.000Z",
					status: "running",
				},
			],
			null,
			2,
		),
		"utf8",
	);
	writeFileSync(
		join(bgDir, "bg-probe1-aaaaaa.log"),
		Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join("\n"),
		"utf8",
	);
	server = startServer({
		COMPANIONS_ENABLED: "true",
		AGENT_BASH_BG_TIMEOUT: "1",
		AGENT_BG_JOBS_DIR: bgDir,
	});
	await waitForReady();

	const bgList = await fetch(`${BASE}/api/v1/agent/bg-jobs`);
	const bgListBody = (await bgList.json()) as {
		ok?: boolean;
		jobs?: { id: string; commandSummary: string; status: string; exitCode: number | null; endedAt: string | null }[];
	};
	const doneJob = bgListBody.jobs?.find((job) => job.id === "bg-probe1-aaaaaa");
	const runningJob = bgListBody.jobs?.find((job) => job.id === "bg-probe2-bbbbbb");
	check(bgList.status === 200 && bgListBody.ok === true, "列表端点可用", String(bgList.status));
	check(
		doneJob?.status === "done" && doneJob.exitCode === 0 && doneJob.endedAt !== null,
		"已结束任务带退出码与结束时间",
		JSON.stringify(doneJob),
	);
	check(
		runningJob?.status === "running" && runningJob.endedAt === null && runningJob.exitCode === null,
		"在跑任务不带结束字段",
	);

	const bgLog = await fetch(`${BASE}/api/v1/agent/bg-jobs/bg-probe1-aaaaaa/log`);
	const bgLogBody = (await bgLog.json()) as { ok?: boolean; lines?: number; log?: string };
	const logLines = (bgLogBody.log ?? "").split("\n");
	check(bgLog.status === 200 && bgLogBody.lines === 250, "日志端点报告总行数", String(bgLogBody.lines));
	check(
		logLines.length === 200 && logLines[logLines.length - 1] === "line-250",
		"只回最后 200 行，且以最新一行结尾",
		String(logLines.length),
	);
	const bgLogMissing = await fetch(`${BASE}/api/v1/agent/bg-jobs/bg-nope-xxxxxx/log`);
	check(bgLogMissing.status === 404, "未知任务日志 → 404", String(bgLogMissing.status));

	const killNotOwned = await fetch(`${BASE}/api/v1/agent/bg-jobs/bg-probe2-bbbbbb/kill`, {
		method: "POST",
	});
	const killNotOwnedBody = (await killNotOwned.json()) as { error?: string };
	check(
		killNotOwned.status === 409 && killNotOwnedBody.error === "not_owned_process",
		"不是本进程起的任务 → 409 拒绝",
		String(killNotOwned.status),
	);
	const killDone = await fetch(`${BASE}/api/v1/agent/bg-jobs/bg-probe1-aaaaaa/kill`, {
		method: "POST",
	});
	check(killDone.status === 409, "已结束任务 → 409", String(killDone.status));
	const killUnknown = await fetch(`${BASE}/api/v1/agent/bg-jobs/bg-nope-xxxxxx/kill`, {
		method: "POST",
	});
	check(killUnknown.status === 404, "未知任务 kill → 404", String(killUnknown.status));

	server.kill();
	await sleep(800);
	// §30 走的是旧单段 redeem（验指纹），两段式默认开会把 redeem 收紧关闭，这里显式回滚。
	server = startServer({
		COMPANIONS_ENABLED: "true",
		AGENT_BASH_BG_TIMEOUT: "",
		PAIR_TWO_STEP: "false",
	});
	await waitForReady();
	const bgOff = await fetch(`${BASE}/api/v1/agent/bg-jobs`);
	check(bgOff.status === 404, "开关关着 → 三个端点整组 404", String(bgOff.status));

	// ── 30. 配对设备指纹（2026-11-10 批 26 §四，接口文档 §5）──
	// 真走一遍裸码配对：redeem 下发指纹 → 设备清单同一指纹 → 清单不含哈希 → 撤销。
	console.log("\n· 30. 配对设备指纹：redeem 下发 + 设备清单人眼可核");
	const pairCode = (await (
		await fetch(`${BASE}/api/v1/pair/code`, { method: "POST" })
	).json()) as { code?: string };
	const redeemed = await fetch(`${BASE}/api/v1/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: pairCode.code, deviceName: "探针手机" }),
	});
	const redeemedBody = (await redeemed.json()) as {
		deviceToken?: string;
		deviceId?: string;
		fingerprint?: string;
	};
	check(
		redeemed.status === 200 &&
			/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(redeemedBody.fingerprint ?? ""),
		"redeem 下发人眼可核指纹（4-4-4）",
		String(redeemedBody.fingerprint),
	);
	const devicesBody = (await (await fetch(`${BASE}/api/v1/pair/devices`)).json()) as {
		devices?: Array<{ id: string; fingerprint?: string; keyChanged?: boolean }>;
	};
	const mine = (devicesBody.devices ?? []).find((device) => device.id === redeemedBody.deviceId);
	check(
		mine?.fingerprint === redeemedBody.fingerprint,
		"设备清单上的指纹与 redeem 一致",
		String(mine?.fingerprint),
	);
	check(
		mine !== undefined && !("tokenHash" in (mine as Record<string, unknown>)),
		"设备清单不含凭据哈希",
	);
	check(mine?.keyChanged !== true, "正常设备不带键变更标记");
	if (redeemedBody.deviceId) {
		await fetch(`${BASE}/api/v1/pair/devices/${redeemedBody.deviceId}/revoke`, { method: "POST" });
	}

	// ── 31. 两段式配对 + 找旧事搜索端点（2026-11-10 批 28）──
	// 真起一个 PAIR_TWO_STEP=true 的服务：验「只扫码不能完成」、confirm 才发令牌、重放失效、
	// 单段 redeem 被收紧关闭；顺带验只读搜索端点的 400 / 形状。
	console.log("\n· 31. 两段式配对 + 找旧事只读搜索端点（批 28）");
	server.kill();
	await sleep(800);
	server = startServer({
		PAIR_TWO_STEP: "true",
		PAIRING_STORE_PATH: ".data/probe-http-pairing-2step.json",
	});
	await waitForReady();

	const beginResp = await fetch(`${BASE}/api/v1/pairing/begin`, { method: "POST" });
	const begun = (await beginResp.json()) as {
		code?: string;
		expiresAt?: number;
		confirmToken?: string;
	};
	check(
		beginResp.status === 200 &&
			typeof begun.code === "string" &&
			typeof begun.expiresAt === "number" &&
			typeof begun.confirmToken === "string" &&
			begun.confirmToken.length >= 20,
		"begin 返回 code + expiresAt + confirmToken（confirmToken 不随二维码下发）",
		`${beginResp.status} ct=${begun.confirmToken?.length}`,
	);

	// 只给 code（不输 confirmToken）→ 不能完成配对
	const onlyCode = await fetch(`${BASE}/api/v1/pairing/confirm`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: begun.code }),
	});
	const onlyCodeBody = (await onlyCode.json()) as { error?: string; deviceToken?: string };
	check(
		onlyCode.status === 400 &&
			onlyCodeBody.error === "confirm_required" &&
			!onlyCodeBody.deviceToken,
		"只扫码（只有 code）不能完成配对",
		`${onlyCode.status} ${onlyCodeBody.error}`,
	);

	const badConfirm = await fetch(`${BASE}/api/v1/pairing/confirm`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: begun.code, confirmToken: "错的令牌" }),
	});
	const badConfirmBody = (await badConfirm.json()) as { error?: string };
	check(
		badConfirm.status === 400 && badConfirmBody.error === "bad_confirm",
		"confirmToken 错 → 400 bad_confirm",
		`${badConfirm.status} ${badConfirmBody.error}`,
	);

	// 单段 redeem 在两段式默认开时被收紧关闭（不能凭 code 单段兑到凭据）
	const oldRedeem = await fetch(`${BASE}/api/v1/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: begun.code, deviceName: "探针手机" }),
	});
	const oldRedeemBody = (await oldRedeem.json()) as { error?: string };
	check(
		oldRedeem.status === 410 && oldRedeemBody.error === "two_step_required",
		"PAIR_TWO_STEP=true 时单段 redeem 关闭（只扫码兑不到）",
		`${oldRedeem.status} ${oldRedeemBody.error}`,
	);

	// code + confirmToken 都交齐 → 才发令牌
	const confirmResp = await fetch(`${BASE}/api/v1/pairing/confirm`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			code: begun.code,
			confirmToken: begun.confirmToken,
			deviceName: "探针手机",
		}),
	});
	const confirmBody = (await confirmResp.json()) as { deviceToken?: string; deviceId?: string };
	check(
		confirmResp.status === 200 && typeof confirmBody.deviceToken === "string",
		"两段式都交齐才发设备令牌",
		String(confirmResp.status),
	);

	// 重放 → code_used（confirmToken 一次性）
	const replay = await fetch(`${BASE}/api/v1/pairing/confirm`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: begun.code, confirmToken: begun.confirmToken }),
	});
	const replayBody = (await replay.json()) as { error?: string };
	check(
		replay.status === 409 && replayBody.error === "code_used",
		"confirmToken 一次性：重放 → 409 code_used",
		`${replay.status} ${replayBody.error}`,
	);

	// 找旧事只读搜索端点：空 / 短查询 400，正常查询形状 {hits:[]}（无命中给空）
	const ssEmpty = await fetch(`${BASE}/api/v1/agent/sessions/search?q=`);
	check(ssEmpty.status === 400, "sessions/search 空查询 → 400", String(ssEmpty.status));
	const ssShort = await fetch(`${BASE}/api/v1/agent/sessions/search?q=%E7%88%AC`);
	check(ssShort.status === 400, "sessions/search 短查询 → 400", String(ssShort.status));
	const ssOk = await fetch(
		`${BASE}/api/v1/agent/sessions/search?q=${encodeURIComponent("不存在的词xyz")}&days=365&limit=5`,
	);
	const ssBody = (await ssOk.json()) as { hits?: unknown[] };
	check(
		ssOk.status === 200 && Array.isArray(ssBody.hits),
		"sessions/search 正常查询 → 200 {hits:[]}",
		`${ssOk.status} ${JSON.stringify(ssBody).slice(0, 60)}`,
	);

} finally {
	server.kill();
	await sleep(300);
	gateUpstream.close();
	// 探针产物不留。Windows 上目录句柄回收比进程退出慢半拍，清理失败不该把"断言全过"
	// 判成失败（测试里同样的口径），逐条兜住。
	const leftovers: Array<[string, Parameters<typeof rmSync>[1]]> = [
		[DB, { force: true }],
		[`${DB}-wal`, { force: true }],
		[`${DB}-shm`, { force: true }],
		[MEMORY_DB, { force: true }],
		[PROJECTS_DB, { force: true }],
		[`${PROJECTS_DB}-wal`, { force: true }],
		[`${PROJECTS_DB}-shm`, { force: true }],
		[WORKSPACE_A, { recursive: true, force: true }],
		[WORKSPACE_B, { recursive: true, force: true }],
		[GATE_OUTSIDE_DIR, { recursive: true, force: true }],
		[".data/probe-http-default-ws", { recursive: true, force: true }],
		[".data/probe-http-flags.json", { force: true }],
		[".data/probe-http-skill-state.json", { force: true }],
		[".data/probe-http-gate-providers.json", { force: true }],
		[".data/probe-http-gate-runtime.json", { force: true }],
		[GATE_AUDIT_FILE, { force: true }],
		[APPROVALS_FILE, { force: true }],
		[".data/probe-http-chat-events.sqlite", { force: true }],
		[".data/probe-http-bg-jobs", { recursive: true, force: true }],
		// 2026-11-13 附件走路径：上传的探针文件也只留在探针目录
		[".data/probe-http-attachments", { recursive: true, force: true }],
		[".data/probe-http-providers.json", { force: true }],
		[".data/probe-http-policy.json", { force: true }],
		[".data/probe-http-secret-providers.json", { force: true }],
		[".data/probe-http-provider-keys.json", { force: true }],
		[".data/probe-http-secret-runtime.json", { force: true }],
		[".data/probe-http-tickets", { recursive: true, force: true }],
		[".data/probe-http-delegations.sqlite", { force: true }],
		[".data/probe-http-partners.sqlite", { force: true }],
		[".data/probe-http-partners.sqlite-wal", { force: true }],
		[".data/probe-http-partners.sqlite-shm", { force: true }],
		[".data/probe-http-partner-homes", { recursive: true, force: true }],
		[".data/probe-http-pairing.json", { force: true }],
		[".data/probe-http-pairing.json.tmp", { force: true }],
		[".data/probe-http-pairing-2step.json", { force: true }],
		[".data/probe-http-pairing-2step.json.tmp", { force: true }],
	];
	for (const [path, options] of leftovers) {
		try {
			rmSync(path, options);
		} catch {
			/* 句柄由 OS 在进程退出时回收 */
		}
	}
}

console.log(failures === 0 ? "\n✓ 端到端全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
