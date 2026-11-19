/**
 * 提醒沉淀探针（2026-11-19 批4）。
 *
 * 真起服务、真 HTTP、真 durable + 真记忆库（faux 模型），四段：
 *   A. 收集段：发几条带提醒词 / 无提醒词的用户消息 → GET /agent/reminder-candidates
 *      返回聚合候选（同句计数、无提醒词不收）、prompt 内嵌清单、工具进目录；
 *      无令牌 403。
 *   B. 教诲段（LLM_FAUX_TOOL=remember）：立一条 taught 偏好 → 候选清单 ② 段出现它。
 *   C. 落盘与采纳段（LLM_FAUX_TOOL=save_reminder_advice + 工具池全常驻）：
 *      总管调 save_reminder_advice → 快照可读 → PUT 采纳写偏好（taught、global）→
 *      再采纳（清单已摘除）400；伪造条目 400；GET memory 可见该偏好。
 *   D. 回滚段：REMINDER_DISTILL_ENABLED=false → 候选 / 建议端点 404、工具不在目录。
 *
 * 卫生：所有落点都在 `.data/probe-reminder-*`，跑完即删；不碰真实 .data。
 *
 *   pnpm --filter @lifediary/server reminder-distill
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8121);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "probe-reminder-token";
const PFX = ".data/probe-reminder";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
	console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
}

function cleanArtifacts(): void {
	for (const suffix of [
		"-agent.sqlite", "-agent.sqlite-wal", "-agent.sqlite-shm",
		"-memory.db", "-projects.sqlite", "-chat-meta.json", "-providers.json",
		"-partners.sqlite", "-flags.json", "-skill-state.json", "-policy.json",
		"-local-secret", "-approvals.json", "-gate.jsonl", "-autonomy.jsonl",
		"-pairing.json", "-reminder-runs.json", "-reminder-advice.json", "-tool-pool.json",
		"-skills-advice.json", "-skills-state.json", "-runtime.json", "-attachments",
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
}

function startServer(extraEnv: Record<string, string>): ChildProcess {
	const cleanEnv = { ...process.env };
	// 不继承开发机上可能设过的 faux 工具模式；探针按段显式给。
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
			MEMORY_ENABLED: "true",
			PROJECTS_DB_PATH: `${PFX}-projects.sqlite`,
			AGENT_CHAT_META_PATH: `${PFX}-chat-meta.json`,
			PROVIDERS_PATH: `${PFX}-providers.json`,
			PROVIDERS_CONFIG: "false",
			PARTNERS_DB_PATH: `${PFX}-partners.sqlite`,
			PARTNER_HOMES_ROOT: `${PFX}-homes`,
			AGENT_FLAGS_PATH: `${PFX}-flags.json`,
			AGENT_SKILLS_STATE_PATH: `${PFX}-skill-state.json`,
			AGENT_SKILLS_ADVICE_PATH: `${PFX}-skills-advice.json`,
			AGENT_POLICY_PATH: `${PFX}-policy.json`,
			AGENT_LOCAL_SECRET_PATH: `${PFX}-local-secret`,
			AGENT_APPROVALS_PATH: `${PFX}-approvals.json`,
			AGENT_GATE_AUDIT_PATH: `${PFX}-gate.jsonl`,
			AUTONOMY_OBSERVE_PATH: `${PFX}-autonomy.jsonl`,
			PAIRING_STORE_PATH: `${PFX}-pairing.json`,
			REMINDER_RUNS_STATE_PATH: `${PFX}-reminder-runs.json`,
			AGENT_REMINDER_ADVICE_PATH: `${PFX}-reminder-advice.json`,
			AGENT_TOOL_POOL_PATH: `${PFX}-tool-pool.json`,
			ATTACHMENTS_DIR: `${PFX}-attachments`,
			MODEL_RUNTIME_PATH: `${PFX}-runtime.json`,
			CURRENT_PROJECT: "",
			AUTONOMY_ENABLED: "false",
			CHANCELLOR_ENABLED: "false",
			NODE_OPTIONS: "",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function watchLogs(child: ChildProcess): void {
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		if (/\[reminder|\[memory|error|Error|失败|warn/i.test(text)) {
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
	await sleep(500);
	if (!child.killed) child.kill("SIGKILL");
	await sleep(300);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...extra };
}

async function apiJson(
	path: string,
	init: RequestInit = {},
	withToken = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${BASE}${path}`, {
		...init,
		headers: withToken
			? authHeaders((init.headers as Record<string, string> | undefined) ?? {})
			: ((init.headers as Record<string, string> | undefined) ?? {}),
	});
	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		/* 空体（403 的语义就是空体）留空对象 */
	}
	return { status: response.status, body };
}

/** 发一轮对话并收完 SSE：返回 conversationId（首轮新建时才有意义）。 */
async function chat(body: unknown): Promise<{ conversationId?: string }> {
	const response = await fetch(`${BASE}/api/v1/agent/chat`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(body),
	});
	if (response.status !== 200) {
		process.stderr.write(`  [chat] HTTP ${response.status}: ${await response.text()}\n`);
		return {};
	}
	const raw = await response.text();
	let conversationId: string | undefined;
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			const payload = JSON.parse(line.slice(5).trim()) as { type?: string; conversationId?: string };
			if (payload.type === "start" && payload.conversationId) conversationId = payload.conversationId;
		} catch {
			/* 非JSON行忽略 */
		}
	}
	return { conversationId };
}

interface ReminderCandidate {
	kind: string;
	text: string;
	count?: number;
}

async function stop(child: ChildProcess): Promise<void> {
	await stopServer(child);
}

const REMINDER_TEXT = "以后汇报先给结论";
const REMINDER_TEXT_2 = "记住：别再重复问我要 key";
const NO_PATTERN_TEXT = "今天天气不错，出去走了走";

try {
	/* ── A. 收集段 ─────────────────────────────────────── */
	console.log("\nA. 收集段（0 token：faux 纯文本回复，代码确定性收集）");
	cleanArtifacts();
	const childA = startServer({});
	watchLogs(childA);
	await waitForReady();

	const noToken = await apiJson("/api/v1/agent/reminder-candidates", {}, false);
	check(noToken.status === 403, "无令牌 → 403 空体", `HTTP ${noToken.status}`);

	const first = await chat({ messages: [{ role: "user", content: `${REMINDER_TEXT}。具体数字放后面。` }] });
	check(Boolean(first.conversationId), "第 1 轮对话落库（新建会话）", first.conversationId ?? "");
	const second = await chat({ conversationId: first.conversationId, messages: [{ role: "user", content: REMINDER_TEXT }] });
	check(Boolean(second.conversationId), "第 2 轮同句复述（聚合素材）");
	await chat({ conversationId: first.conversationId, messages: [{ role: "user", content: REMINDER_TEXT_2 }] });
	await chat({ conversationId: first.conversationId, messages: [{ role: "user", content: NO_PATTERN_TEXT }] });

	const candidates = await apiJson("/api/v1/agent/reminder-candidates");
	check(candidates.status === 200 && candidates.body.ok === true, "GET 候选 200", `HTTP ${candidates.status}`);
	const list = (candidates.body.candidates ?? []) as ReminderCandidate[];
	const counts = (candidates.body.counts ?? {}) as Record<string, number>;
	const utterances = list.filter((item) => item.kind === "utterance");
	const aggregated = utterances.find((item) => item.text === REMINDER_TEXT);
	check(Boolean(aggregated), "同句原文进候选", utterances.map((item) => item.text).join(" / ").slice(0, 80));
	check(aggregated?.count === 2, "同句跨轮聚合 count=2", String(aggregated?.count));
	check(
		utterances.some((item) => item.text === REMINDER_TEXT_2),
		"第二条提醒句进候选",
	);
	check(
		!list.some((item) => item.text?.includes(NO_PATTERN_TEXT)),
		"无提醒词的句子不收",
	);
	check((counts.utterances ?? 0) >= 2, "分段计数 counts.utterances ≥2", JSON.stringify(counts));
	const prompt = String(candidates.body.prompt ?? "");
	check(prompt.includes(REMINDER_TEXT) && prompt.includes('"count":2'), "prompt 内嵌候选清单（带次数）");
	check(prompt.includes("save_reminder_advice"), "prompt 指引调 save_reminder_advice");
	check(prompt.includes("已经记下的教诲"), "prompt 含已有教诲参照段");

	const poolA = await apiJson("/api/v1/agent/tool-pool");
	const poolNamesA = ((poolA.body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
	check(poolNamesA.includes("save_reminder_advice"), "开关开：save_reminder_advice 在工具目录", `共 ${poolNamesA.length} 个`);

	await stop(childA);

	/* ── B. 教诲段（faux 只会调 remember）──────────────── */
	console.log("\nB. 教诲段（faux 调 remember 立一条 taught 偏好）");
	const childB = startServer({
		LLM_FAUX_TOOL: "remember",
		// taught 要给真布尔：内核按 schema 校验工具参数，字符串 "true" 会被整单拒掉
		LLM_FAUX_ARGS: JSON.stringify({
			content: "汇报先给结论，细节放后面",
			kind: "preference",
			taught: true,
		}),
		// faux 只会调工具不收尾：1 回合 = 调一次就停
		AGENT_MAX_TURNS: "1",
	});
	watchLogs(childB);
	await waitForReady();
	await chat({ messages: [{ role: "user", content: "顺便记一下刚才的规矩" }] });

	const candidatesB = await apiJson("/api/v1/agent/reminder-candidates");
	const listB = (candidatesB.body.candidates ?? []) as ReminderCandidate[];
	check(
		candidatesB.status === 200 && listB.some((item) => item.kind === "taught" && item.text.includes("汇报先给结论")),
		"taught 偏好进候选 ② 段",
		listB.filter((item) => item.kind === "taught").map((item) => item.text).join(" / "),
	);
	await stop(childB);

	/* ── C. 落盘与采纳段（faux 只会调 save_reminder_advice）── */
	console.log("\nC. 落盘与采纳段（工具池全常驻，faux 调 save_reminder_advice）");
	// 空按需名单 = 全部常驻：save_reminder_advice 初始就在请求里，faux 一步直调
	writeFileSync(
		`${PFX}-tool-pool.json`,
		JSON.stringify({ deferred: [] }, null, "\t"),
		"utf8",
	);
	const adviceItems = ["以后汇报先给结论，细节放后面", "不要再重复问 key，要用时自己翻 providers"];
	const childC = startServer({
		LLM_FAUX_TOOL: "save_reminder_advice",
		LLM_FAUX_ARGS: JSON.stringify({ items: adviceItems }),
		// faux 只会调工具不收尾：1 回合 = 调一次就停
		AGENT_MAX_TURNS: "1",
	});
	watchLogs(childC);
	await waitForReady();

	const adviceBefore = await apiJson("/api/v1/agent/reminder-advice");
	check(adviceBefore.status === 200 && adviceBefore.body.ok === true, "GET 建议 200（空清单）", `HTTP ${adviceBefore.status}`);
	check(((adviceBefore.body.items ?? []) as unknown[]).length === 0, "蒸馏前清单为空");

	await chat({ messages: [{ role: "user", content: "把蒸馏结果存一下" }] });

	const advice = await apiJson("/api/v1/agent/reminder-advice");
	const items = (advice.body.items ?? []) as string[];
	check(items.length === adviceItems.length, "save_reminder_advice 落盘条数", JSON.stringify(items));
	check(items[0] === adviceItems[0], "快照原文一致");

	// 伪造条目（不在快照里）→ 400
	const fabricated = await apiJson("/api/v1/agent/reminder-advice", {
		method: "PUT",
		body: JSON.stringify({ actions: [{ text: "伪造的建议", action: "adopt" }] }),
	});
	check(fabricated.status === 400, "伪造条目采纳 → 400", `HTTP ${fabricated.status}`);

	// 采纳第一条 → 写偏好
	const adopt = await apiJson("/api/v1/agent/reminder-advice", {
		method: "PUT",
		body: JSON.stringify({ actions: [{ text: adviceItems[0], action: "adopt" }] }),
	});
	check(adopt.status === 200 && adopt.body.ok === true, "采纳 200", `HTTP ${adopt.status} ${JSON.stringify(adopt.body)}`);
	check(adopt.body.adopted === 1, "采纳计数 1", JSON.stringify(adopt.body));

	const memory = await apiJson("/api/v1/agent/memory?scope=global&kind=preference&limit=200");
	const memoryItems = (memory.body.items ?? []) as { content: string; source: string; kind: string }[];
	const adoptedRecord = memoryItems.find((record) => record.content === adviceItems[0]);
	check(Boolean(adoptedRecord), "采纳后偏好可查（GET /agent/memory）", memoryItems.map((record) => record.content).join(" / ").slice(0, 60));
	check(adoptedRecord?.source === "taught", "来源 = taught（永不删保护层）", String(adoptedRecord?.source));
	check(adoptedRecord?.kind === "preference", "类型 = preference", String(adoptedRecord?.kind));

	// 同一条再采纳 → 已从清单摘除 → 400
	const reAdopt = await apiJson("/api/v1/agent/reminder-advice", {
		method: "PUT",
		body: JSON.stringify({ actions: [{ text: adviceItems[0], action: "adopt" }] }),
	});
	check(reAdopt.status === 400, "重复采纳（已摘除）→ 400", `HTTP ${reAdopt.status}`);

	// 忽略第二条 → 只摘除不写库
	const dismiss = await apiJson("/api/v1/agent/reminder-advice", {
		method: "PUT",
		body: JSON.stringify({ actions: [{ text: adviceItems[1], action: "dismiss" }] }),
	});
	check(dismiss.status === 200 && dismiss.body.dismissed === 1, "忽略 200", JSON.stringify(dismiss.body));
	const memoryAfter = await apiJson("/api/v1/agent/memory?scope=global&kind=preference&limit=200");
	const afterItems = (memoryAfter.body.items ?? []) as { content: string }[];
	check(
		!afterItems.some((record) => record.content === adviceItems[1]),
		"忽略的不落库",
	);
	check(((dismiss.body.remaining ?? 0) as number) === 0, "清单摘空 remaining=0", JSON.stringify(dismiss.body));

	await stop(childC);

	/* ── D. 回滚段 ─────────────────────────────────────── */
	console.log("\nD. 回滚段（REMINDER_DISTILL_ENABLED=false）");
	const childD = startServer({ REMINDER_DISTILL_ENABLED: "false" });
	watchLogs(childD);
	await waitForReady();
	check((await apiJson("/api/v1/agent/reminder-candidates")).status === 404, "候选端点 404");
	check((await apiJson("/api/v1/agent/reminder-advice")).status === 404, "建议端点 404");
	const poolD = await apiJson("/api/v1/agent/tool-pool");
	const poolNamesD = ((poolD.body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
	check(!poolNamesD.includes("save_reminder_advice"), "工具不上架", `共 ${poolNamesD.length} 个`);
	await stop(childD);
} catch (error) {
	failures += 1;
	console.error(`探针异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
	console.log(`\n${failures === 0 ? "全部通过" : `${failures} 处失败`}`);
	process.exit(failures === 0 ? 0 : 1);
}
