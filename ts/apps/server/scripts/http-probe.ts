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

let server = startServer();

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
	server = startServer();
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
	server = startServer({ LLM_FAUX_TOOL: "recall", AGENT_MAX_TURNS: "3" });
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

	const switched = await fetch(`${BASE}/api/v1/agent/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "probe-b" }),
	});
	check(switched.status === 200, "切换成功", String(switched.status));
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
} finally {
	server.kill();
	await sleep(300);
	// 探针产物不留
	rmSync(DB, { force: true });
	rmSync(`${DB}-wal`, { force: true });
	rmSync(`${DB}-shm`, { force: true });
	rmSync(MEMORY_DB, { force: true });
	rmSync(".data/probe-http-model.json", { force: true });
}

console.log(failures === 0 ? "\n✓ 端到端全部通过" : `\n✗ 有 ${failures} 项没通过`);
process.exit(failures === 0 ? 0 : 1);
