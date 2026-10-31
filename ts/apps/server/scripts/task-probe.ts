/**
 * 任务通道（`X-Task`）端到端探针 —— 2026-10-30。
 *
 * 为什么不用 `LLM_PROVIDER=faux`：本轮要证明的是"参数真的到了上游请求体里"
 * （temperature / max_tokens / response_format）以及"模板在服务端渲染"。
 * faux 不产生 HTTP 请求，什么都看不见。所以这里起一个**假上游**，
 * 把收到的请求体记下来，逐条断言；再由它回一段固定的 SSE。
 *
 * 覆盖：
 *   1. 四个任务（converge / weekly / segment / interview）各自落成一条 durable 会话，且能回读；
 *   2. 参数透传生效（假上游看到的 body 里就有）；
 *   3. system 段 = 服务端渲染的模板（不是客户端给的、也不是人格）；
 *   4. 任务会话没有工具（`tools` 为空或缺失）；
 *   5. 通用聊天（无 `X-Task`）行为没变：人格在、带 L1 技能索引与 skill 工具（方案步骤 2）、
 *      走思考关变体（2026-10-31 方案 D2）、没有 response_format；
 *   6. 未知 `X-Task` → 400 `unknown_task`；
 *   7. 模板变量缺失 → 500 `task_render_failed`，且**不留半条会话**；
 *   8. 黄金用例：模板与 App 侧资产逐字节一致（App 目录不在时明确跳过，不算通过也不算失败）。
 *
 *   pnpm --filter @lifediary/server tasks
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { allTasks, renderTask, templateOf, type TaskSpec } from "../src/tasks.ts";

const PORT = Number(process.env.PROBE_PORT ?? 8097);
const UPSTREAM_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = ".data/probe-task.sqlite";
const MEMORY_DB = ".data/probe-task-memory.db";

/** App 仓库的 prompt 资产目录（黄金用例的对照源；跨仓只读） */
const APP_PROMPTS_DIR = "<lifediary 手机仓>/core/ai/src/main/assets/prompts";

let failures = 0;
let skips = 0;
function check(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}
function skip(label: string): void {
	skips += 1;
	console.log(`  – 跳过 ${label}`);
}

// ── 假上游：记账 + 回一段固定 SSE ─────────────────────────
interface Recorded {
	body: Record<string, unknown>;
	at: number;
}
const recorded: Recorded[] = [];

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => resolve(raw));
	});
}

function sseChunk(res: ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 上游回复的固定正文：探针靠它证明"落库的是模型输出" */
const UPSTREAM_TEXT = "（假上游）今天挺好的。";

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
		/* 记成空对象，断言自然会挂 */
	}
	recorded.push({ body, at: Date.now() });

	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const base = {
		id: "chatcmpl-probe",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: String(body.model ?? "fake"),
	};
	sseChunk(response, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
	for (const piece of [UPSTREAM_TEXT.slice(0, 6), UPSTREAM_TEXT.slice(6)]) {
		sseChunk(response, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
	}
	sseChunk(response, {
		...base,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	});
	response.write("data: [DONE]\n\n");
	response.end();
});

// ── 被测服务 ──────────────────────────────────────────────
function startServer(): ChildProcess {
	const child = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
		cwd: import.meta.dirname ? `${import.meta.dirname}/..` : ".",
		env: {
			...process.env,
			PORT: String(PORT),
			LLM_PROVIDER: "",
			LLM_API_KEY: "probe-key",
			LLM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
			LLM_MODEL: "fake-deep",
			LLM_MODEL_FAST: "fake-fast",
			AGENT_TOKEN: "",
			AGENT_DB_PATH: DB,
			MEMORY_DB_PATH: MEMORY_DB,
			JEV_ROUTE: "off",
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

interface TaskCall {
	status: number;
	json: Record<string, unknown>;
}

/** 发一次任务请求（非流式：收敛这类本来就是一次要完整 JSON） */
async function callTask(
	name: string,
	vars: Record<string, unknown> | undefined,
	input: string,
	params: { temperature?: number; max_tokens?: number; response_format?: unknown },
): Promise<TaskCall> {
	const response = await fetch(`${BASE}/api/v1/llm/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", "X-Task": name },
		body: JSON.stringify({
			model: "whatever",
			messages: [{ role: "user", content: input }],
			...(vars ? { task_vars: vars } : {}),
			...params,
		}),
	});
	const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: response.status, json };
}

async function readMessages(conversationId: string) {
	const response = await fetch(`${BASE}/api/v1/agent/chat/${conversationId}/messages`);
	const json = (await response.json()) as { messages?: { role: string; text: string }[] };
	return json.messages ?? [];
}

async function chatIndexCount(): Promise<number> {
	const response = await fetch(`${BASE}/api/v1/agent/chats`);
	const json = (await response.json()) as { chats?: unknown[] };
	return json.chats?.length ?? 0;
}

/** 变量样例：每个任务一套，值里带标记串，便于在 system 里定位"渲染进去了" */
const VARS: Record<string, Record<string, string>> = {
	converge: { user_messages: "- 今天把方案重写了一遍", entry_types: "（待用户确认）" },
	weekly: { positive_facts: "- 本周聊了 5 天", profile_markdown: "（画像占位）" },
	segment: { entry_text: "今天把方案重写了一遍。" },
	interview: { last_session_digest: "", recent_messages: "" },
	chapter: { user_messages: "- 那年夏天" },
	question: { tone: "温和", question_length: "一句话", depth: "浅" },
};

/** 各任务的参数：照抄 App 现版（LlmRequest 的 temperature / maxTokens / expectJson） */
const PARAMS: Record<string, { temperature?: number; max_tokens?: number; response_format?: unknown }> = {
	converge: { temperature: 0.4, max_tokens: 4000 },
	weekly: { temperature: 0.5, max_tokens: 4000 },
	segment: { temperature: 0.2, max_tokens: 3000, response_format: { type: "json_object" } },
	interview: { temperature: 0.6, max_tokens: 2000 },
	chapter: { temperature: 0.6, max_tokens: 4000 },
	question: { temperature: 0.8, max_tokens: 2000 },
};

function systemMessageOf(body: Record<string, unknown>): string {
	const messages = (body.messages ?? []) as { role?: string; content?: unknown }[];
	return messages
		.filter((message) => message.role === "system")
		.map((message) => String(message.content ?? ""))
		.join("\n");
}

rmSync(DB, { force: true });
rmSync(MEMORY_DB, { force: true });

await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));
let server = startServer();

try {
	await waitForReady();

	// ── 1. 四个任务：各自一条会话、可回读、参数透传 ──────────
	console.log("\n· 1. 四个任务各跑一遍（X-Task → Agent 会话 → 落库 → 回读）");
	const anchors: Record<string, string> = {};
	for (const name of ["converge", "weekly", "segment", "interview"] as const) {
		const spec = allTasks().find((task) => task.name === name);
		if (!spec) {
			check(false, `${name} 在任务表里`, "tasks.ts 缺这张表");
			continue;
		}
		const before = recorded.length;
		const call = await callTask(name, VARS[name], spec.input, PARAMS[name] ?? {});
		const id = String(call.json.id ?? "");
		check(call.status === 200, `${name} 返回 200`, String(call.status));
		check(id.length > 0, `${name} 下发了 conversationId`, id);

		const sent = recorded[before]?.body;
		check(Boolean(sent), `${name} 真的打到了上游`);
		if (sent) {
			const system = systemMessageOf(sent);
			const expected = renderTask(spec, VARS[name] ?? {});
			// 整份渲染结果都必须在 system 里（不是只看开头）：变量替换也要跟着进去
			check(
				system.includes(expected),
				`${name} 的 system = 服务端渲染的完整模板`,
				`${system.length} 字符，期望 ${expected.length}`,
			);
			check(
				!system.includes("你是一个个人助手"),
				`${name} 没混进人格（任务会话摘掉了扩展）`,
			);
			const params = PARAMS[name] ?? {};
			check(
				typeof params.temperature !== "number" || sent.temperature === params.temperature,
				`${name} temperature 透传`,
				`${String(sent.temperature)} / 期望 ${String(params.temperature)}`,
			);
			check(
				typeof params.max_tokens !== "number" || sent.max_tokens === params.max_tokens,
				`${name} max_tokens 透传`,
				`${String(sent.max_tokens)} / 期望 ${String(params.max_tokens)}`,
			);
			if (params.response_format) {
				check(
					JSON.stringify(sent.response_format) === JSON.stringify(params.response_format),
					`${name} response_format 透传`,
					JSON.stringify(sent.response_format),
				);
			} else {
				check(sent.response_format === undefined, `${name} 没被硬塞 response_format`);
			}
			const tools = sent.tools as unknown[] | undefined;
			check(!tools || tools.length === 0, `${name} 没有给模型工具`, `${tools?.length ?? 0} 个`);
			// 必须是**真实模型名**、一个字符都不能多：派生 id（`fake-deep#t0.4m4000r-`）
			// 只活在 harness 目录里，漏到请求体上游就 404（2026-10-30 真实模型联调踩到，
			// 当时写的是 startsWith，假上游把带后缀的 id 也放过了 —— 改成全等）。
			check(
				String(sent.model ?? "") === "fake-deep",
				`${name} 走深档模型且上游拿到的是真实模型名`,
				String(sent.model),
			);
		}

		const messages = id ? await readMessages(id) : [];
		check(messages.length >= 2, `${name} 的会话能回读（≥2 条）`, `${messages.length} 条`);
		check(
			messages.at(-1)?.role === "assistant" && (messages.at(-1)?.text ?? "").includes("假上游"),
			`${name} 回读到的是模型输出`,
			(messages.at(-1)?.text ?? "").slice(0, 12),
		);
		anchors[name] = id;
	}

	// ── 2. 未知任务 → 400 ───────────────────────────────────
	console.log("\n· 2. 未知任务名");
	const beforeUnknown = await chatIndexCount();
	const bogus = await callTask("labubu", {}, "随便", {});
	check(bogus.status === 400, "未知 X-Task 返回 400", String(bogus.status));
	const bogusError = (bogus.json.error ?? {}) as Record<string, unknown>;
	check(bogusError.code === "unknown_task", "错误码是 unknown_task", String(bogusError.code));
	check(
		(await chatIndexCount()) === beforeUnknown,
		"未知任务没留下会话",
		`${beforeUnknown} → ${await chatIndexCount()}`,
	);

	// ── 3. 渲染失败 → 500 且不留半条会话 ─────────────────────
	console.log("\n· 3. 模板变量缺失");
	const beforeRender = await chatIndexCount();
	const broken = await callTask("segment", { entry_text: 42 as unknown as string }, "请按上面的格式只输出 JSON", {
		temperature: 0.2,
	});
	check(broken.status === 500, "渲染失败返回 500", String(broken.status));
	const brokenError = (broken.json.error ?? {}) as Record<string, unknown>;
	check(
		brokenError.code === "task_render_failed",
		"错误码是 task_render_failed",
		String(brokenError.code),
	);
	check(
		(await chatIndexCount()) === beforeRender,
		"渲染失败没落半条会话",
		`${beforeRender} → ${await chatIndexCount()}`,
	);

	// ── 4. 通用聊天没被顺手改掉 ─────────────────────────────
	console.log("\n· 4. 通用聊天（无 X-Task）回归");
	const beforeChat = recorded.length;
	const general = await fetch(`${BASE}/api/v1/llm/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messages: [{ role: "user", content: "今天有点累" }] }),
	});
	const generalJson = (await general.json()) as Record<string, unknown>;
	check(general.status === 200, "通用聊天返回 200", String(general.status));
	check(typeof generalJson.id === "string", "通用聊天仍回会话 id", String(generalJson.id));
	const generalBody = recorded[beforeChat]?.body;
	if (generalBody) {
		check(
			systemMessageOf(generalBody).includes("你是一个个人助手"),
			"通用聊天仍有人格",
		);
		check(
			systemMessageOf(generalBody).includes("可用技能") &&
				systemMessageOf(generalBody).includes("meeting_guide") &&
				systemMessageOf(generalBody).includes("recall_guide"),
			"通用聊天带 L1 技能索引（2026-10-31 方案步骤 2）",
		);
		const generalTools = (generalBody.tools ?? []) as { function?: { name?: string } }[];
		check(
			generalTools.some((tool) => tool?.function?.name === "skill"),
			"skill 工具在工具清单里",
			generalTools.map((tool) => tool?.function?.name).join("、"),
		);
		check(
			generalBody.model === "fake-deep" && generalBody.enable_thinking === false,
			"通用聊天走思考关变体（真实模型名 + enable_thinking=false）",
			`model=${String(generalBody.model)} enable_thinking=${String(generalBody.enable_thinking)}`,
		);
		check(generalBody.response_format === undefined, "通用聊天没被塞 response_format");
	}

	// ── 5. 黄金用例：模板与 App 侧资产逐字节一致 ─────────────
	console.log("\n· 5. 黄金用例（模板 ↔ App 现版资产）");
	if (!existsSync(APP_PROMPTS_DIR)) {
		skip(`App prompt 目录不在（${APP_PROMPTS_DIR}），模板字节对照未执行`);
	} else {
		for (const spec of allTasks()) {
			checkAssetMatchesApp(spec);
		}
	}

	// ── 6. 重启后任务会话仍可回读 ────────────────────────────
	console.log("\n· 6. 重启进程，任务会话还在");
	server.kill();
	await sleep(900);
	server = startServer();
	await waitForReady();
	const convergeId = anchors.converge;
	if (convergeId) {
		const messages = await readMessages(convergeId);
		check(messages.length >= 2, "重启后任务会话仍能回读", `${messages.length} 条`);
	} else {
		check(false, "重启前没拿到 converge 的会话 id");
	}

	// ── 7. 每次调用一个会话；任务会话不进"历史对话" ──────────
	console.log("\n· 7. 任务会话：一次调用一条、不进列表");
	const first = await callTask("converge", VARS.converge, "请整理成稿", PARAMS.converge);
	const second = await callTask("converge", VARS.converge, "请整理成稿", PARAMS.converge);
	const firstId = String(first.json.id ?? "");
	const secondId = String(second.json.id ?? "");
	check(firstId !== secondId, "同样的任务调两次 → 两条不同会话", `${firstId} / ${secondId}`);
	check(
		firstId.startsWith("task-") && secondId.startsWith("task-"),
		"任务会话 id 带 task- 前缀（列表据此过滤）",
		`${firstId} / ${secondId}`,
	);
	const listed = (await (await fetch(`${BASE}/api/v1/agent/chats`)).json()) as {
		chats?: { conversationId?: string }[];
	};
	const leaked = (listed.chats ?? []).filter((chat) => (chat.conversationId ?? "").startsWith("task-"));
	check(leaked.length === 0, "历史对话列表里没有任务会话", `${leaked.length} 条混进来`);
	const fresh = await readMessages(firstId);
	check(fresh.length >= 2, "任务会话本身仍可按 id 回读", `${fresh.length} 条`);
} finally {
	server.kill();
	await sleep(300);
	upstream.close();
	rmSync(DB, { force: true });
	rmSync(`${DB}-wal`, { force: true });
	rmSync(`${DB}-shm`, { force: true });
	rmSync(MEMORY_DB, { force: true });
}

/** 逐字节对照：harness 的资产必须与 App 的同一份资产完全一样（允许 App 用 CRLF） */
function checkAssetMatchesApp(spec: TaskSpec): void {
	const appPath = join(APP_PROMPTS_DIR, spec.asset);
	if (!existsSync(appPath)) {
		check(false, `${spec.asset} 在 App 侧存在`, appPath);
		return;
	}
	const normalize = (text: string) => text.replace(/\r\n/g, "\n");
	const app = normalize(readFileSync(appPath, "utf8"));
	const ours = normalize(templateOf(spec));
	check(
		app === ours,
		`${spec.asset} 与 App 现版逐字节一致（${spec.name}）`,
		`${app.length} / ${ours.length} 字符`,
	);
}

console.log(
	failures === 0
		? `\n✓ 任务通道全部通过${skips > 0 ? `（${skips} 项跳过）` : ""}`
		: `\n✗ 有 ${failures} 项没通过`,
);
process.exit(failures === 0 ? 0 : 1);
