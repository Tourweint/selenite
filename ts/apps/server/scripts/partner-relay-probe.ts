import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSseDecoder } from "@lifediary/shared";

/**
 * 执事间消息通道探针（2026-11-08 扫尾批 8d）。
 *
 * 假模型 + 真 durable：`LLM_PROVIDER=faux` 让 faux 一轮一轮地调 `send_to_agent`
 * （`LLM_FAUX_TOOL` / `LLM_FAUX_ARGS`），但落库、提交、队列、闸门、transcript 全是真的。
 * 覆盖方案 §三 的六个场景：
 *   ① A→B 递话落 B 会话 + 主人对话有通知
 *   ② B 忙时 followUp 排队不丢
 *   ③ B 回合内 send_to_agent 被拦（防乒乓实证）
 *   ④ 单 run 第 4 次递话被引导（上限）
 *   ⑤ 重名 / 不存在目标 → 引导（不猜）
 *   ⑥ PARTNER_RELAY_ENABLED=false → 工具不上架（tool_unavailable）
 *
 *   pnpm --filter @lifediary/server partner-relay
 */

const PORT = 8197;
const ROOT = mkdtempSync(join(tmpdir(), "lifediary-partner-relay-probe-"));
/** 每一段用自己的库目录：共用一份 SQLite 会把上一段的执事带进下一段（重名 400）。 */
let phaseRoot = ROOT;
/** 阶段序号：只用 ASCII 做目录名，避免各平台文件系统对中文的差异 */
let labelSlug = 0;
const RELAY_FROM_NAME = "信使甲";
/** 2026-11-15 作者标记：模型侧那三段说明回读时被剥掉，正文里不该再出现 */
const RELAY_MODEL_TAG = "[relay hop=1]";
const RELAY_FROM_TAG = "[来自执事";
const HOP_BLOCK_HINT = "只允许一跳";
const CAP_HINT = "上限就是 3 条";

function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 读 transcript 的小工具（探针只看工具结果与正文）──
interface Step {
	name?: string;
	output?: string;
	ok?: boolean;
}
interface Msg {
	role?: string;
	text?: string;
	steps?: Step[];
	/** 可寻址 id：只有主人自己的输入才有（来信没有 → 不可编辑重发） */
	id?: string;
	/** 来信作者（2026-11-15 作者标记） */
	author?: { kind?: string; id?: string; name?: string; domain?: string; hop?: number };
}

function stepOutputs(messages: Msg[], tool: string): string[] {
	return messages
		.flatMap((message) => message.steps ?? [])
		.filter((step) => step.name === tool)
		.map((step) => String(step.output ?? ""));
}

function userTexts(messages: Msg[]): string[] {
	return messages.filter((m) => m.role === "user").map((m) => String(m.text ?? ""));
}

async function readMessages(externalId: string): Promise<Msg[]> {
	const out = await api("GET", `/api/v1/agent/chat/${encodeURIComponent(externalId)}/messages?limit=200`, null);
	return Array.isArray(out.body?.messages) ? (out.body.messages as Msg[]) : [];
}

/** 轮询到断言成立（递话是异步的：目标忙时会排在后面） */
async function waitFor(
	label: string,
	probe: () => Promise<boolean>,
	timeoutMs = 25_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probe().catch(() => false)) return true;
		if (Date.now() > deadline) {
			console.log(`  （等待超时：${label}）`);
			return false;
		}
		await sleep(400);
	}
}

// ── 场景 ─────────────────────────────────────────────────

async function main(): Promise<void> {
	// ══ 阶段一：通道开（faux 每轮调 send_to_agent → 目标 B）══
	// ①送达 + 主人通知；③B 回合内被拦；④A 单轮上限
	await phase("①③④", {
		LLM_FAUX_TOOL: "send_to_agent",
		LLM_FAUX_ARGS: JSON.stringify({ target: "信使乙", message: "帮我看下明天上午的日程" }),
	}, async () => {
		const a = await createPartner("信使甲", "inbox");
		const b = await createPartner("信使乙", "calendar");
		// 先把 B 的会话建出来（/run 会走 ensurePartnerSession）：没有会话的执事递不进去。
		// 用 /open 建 B 的会话（走产品正门：建会话 + 身份对齐），不跑一轮空转
		const seed = await api("POST", `/api/v1/partners/${b}/open`, null);
		check("前置：B 的会话已建（open 200）", seed.status === 200, `status=${seed.status}`);

		// 主人对话挂一条流（递话发生时它会收到 notice）
		const chiefStream = postSse("/api/v1/agent/chat", {
			messages: [{ role: "user", content: "在吗" }],
		});
		// 等这条流订阅上（chatStream 先订阅再提交；几十毫秒足够）
		await sleep(120);
		const aRun = await api("POST", `/api/v1/partners/${a}/run`, { text: "转告乙一下" });
		check("①A 跑一轮 200", aRun.status === 200, `status=${aRun.status}`);
		const chief = await chiefStream;

		// ①B 的会话里出现这条来信（作者进结构，正文是原话）
		const bExternal = `partner-${b}`;
		const landed = await waitFor("B 会话出现来信", async () => {
			const messages = await readMessages(bExternal);
			return messages.some(
				(message) =>
					message.role === "user" &&
					message.author?.name === RELAY_FROM_NAME &&
					String(message.text ?? "").includes("帮我看下明天上午的日程"),
			);
		});
		const bMessages = await readMessages(bExternal);
		const relayed =
			bMessages.find(
				(message) =>
					message.role === "user" && message.author?.name === RELAY_FROM_NAME,
			) ?? ({} as Msg);
		check(
			"①A→B 递话落进 B 的会话（真 durable：一条输入，作者是甲）",
			landed,
			String(relayed.text ?? "").slice(0, 40),
		);
		// 2026-11-15 口径：作者进结构；模型侧那三段说明剥掉（界面抬头已经写了谁发来的）；
		// 来信没有可寻址 id → 主人能看不能改。
		const relayText = String(relayed.text ?? "");
		check(
			"①来信带作者结构、剥掉模型侧说明、没有可编辑 id",
			relayed.author?.kind === "partner" &&
				relayed.author?.domain === "inbox" &&
				relayed.id === undefined &&
				!relayText.includes(RELAY_MODEL_TAG) &&
				!relayText.includes(RELAY_FROM_TAG),
			`author=${JSON.stringify(relayed.author)} id=${String(relayed.id)}`,
		);

		// ①主人对话收到通知（只报谁→谁，不带正文）
		const notices = chief.events.filter((event) => event.type === "notice");
		const relayNotice = notices.find((event) => String(event.text ?? "").includes("递了一条话"));
		check(
			"①主人对话收到 notice（执事 甲 → 乙）",
			Boolean(relayNotice),
			`notice=${notices.map((n) => n.text).join(" | ").slice(0, 80)}`,
		);
		check(
			"①通知不含递话正文（防刷屏 / 隐私）",
			Boolean(relayNotice) && !String(relayNotice?.text ?? "").includes("明天上午的日程"),
		);

		// 主人对话里这把工具是"不挂"的：真调了也由通道闸拦下（不是模型自觉）。
		// 注意拦截发生在 emitTool 之前，所以 SSE 里没有工具帧——证据在 transcript 的工具结果里。
		const chiefId = String(chief.events.find((event) => event.type === "start")?.conversationId ?? "");
		const chiefBlocks = chiefId ? stepOutputs(await readMessages(chiefId), "send_to_agent") : [];
		check(
			"①主人对话调 send_to_agent 被拦（只有执事会话能用）",
			chiefBlocks.some((out) => out.includes("主人的对话")),
			chiefBlocks[0]?.slice(0, 60),
		);

		// ③B 是被递话触发的那一轮：send_to_agent 被结构性摘掉
		const blocked = await waitFor("B 回合内出现防乒乓拦截", async () => {
			const messages = await readMessages(`partner-${b}`);
			return stepOutputs(messages, "send_to_agent").some((out) => out.includes(HOP_BLOCK_HINT));
		});
		const bBlocks = stepOutputs(await readMessages(`partner-${b}`), "send_to_agent");
		check(
			"③B 的回合里 send_to_agent 被拦（防乒乓实证：结构摘工具，不是提示词）",
			blocked,
			bBlocks.find((out) => out.includes(HOP_BLOCK_HINT))?.slice(0, 60),
		);

		// ④A 的同一个 run 第 4 次起被引导合并
		const capped = await waitFor("A 出现单轮上限引导", async () => {
			const messages = await readMessages(`partner-${a}`);
			return stepOutputs(messages, "send_to_agent").some((out) => out.includes(CAP_HINT));
		});
		const aOuts = stepOutputs(await readMessages(`partner-${a}`), "send_to_agent");
		const deliveredCount = aOuts.filter((out) => out.startsWith("已递给")).length;
		check("④单 run 第 4 次递话被引导（合并成一条）", capped);
		check("④放行的正好是 3 条（前 3 次成功、之后全是引导）", deliveredCount === 3, `已递=${deliveredCount}`);
	});

	// ══ 阶段二：B 正忙时递话（followUp 排队不丢）══
	//
	// 这一段是探针里唯一需要"B 的一轮正常收尾"的场景，faux 做不到（它只会一直调工具）：
	//  - 正常配置下 B 会撞回合上限被硬停，而 abort 会撤回排队输入（内核语义，不是本功能丢的）；
	//  - 所以这里关掉回合上限与防打转守卫，让 B 这轮在 faux 响应耗尽后以 model_error 收尾，
	//    并让失败后的排队输入继续跑（`AGENT_AFTER_FAILED_RUN=continue`）—— 递话正是在
	//    那个 final 边界被放置，验证的仍是产品语义"忙时排队、收尾后落地"。
	await phase("②busy", {
		LLM_FAUX_TOOL: "send_to_agent",
		LLM_FAUX_ARGS: JSON.stringify({ target: "信使乙", message: "你忙完之后看下这份清单" }),
		AGENT_MAX_TURNS: "0",
		TOOL_LOOP_GUARD: "false",
		AGENT_AFTER_FAILED_RUN: "continue",
	}, async () => {
		const a = await createPartner("信使甲", "inbox");
		const b = await createPartner("信使乙", "calendar");
		// 用 /open 建 B 的会话（走产品正门：建会话 + 身份对齐），不跑一轮空转
		const seed = await api("POST", `/api/v1/partners/${b}/open`, null);
		check("前置：B 的会话已建（open 200）", seed.status === 200, `status=${seed.status}`);

		// B 先忙起来；A 的一轮不等它跑完（我们要的就是"中途递话"）
		void api("POST", `/api/v1/partners/${b}/run`, { text: "先忙一会儿" }).catch(() => undefined);
		await sleep(150);
		void api("POST", `/api/v1/partners/${a}/run`, { text: "转告乙一下" }).catch(() => undefined);

		const busyReported = await waitFor("A 的工具结果出现「对方正在忙」", async () => {
			const outs = stepOutputs(await readMessages(`partner-${a}`), "send_to_agent");
			return outs.some((out) => out.includes("对方正在忙"));
		}, 20_000);
		check(
			"②A 递话时 B 正忙 → 工具如实说明排在它本轮之后",
			busyReported,
			stepOutputs(await readMessages(`partner-${a}`), "send_to_agent")[0]?.slice(0, 50),
		);

		const landed = await waitFor("B 收尾后会话里出现递话", async () => {
			const messages = await readMessages(`partner-${b}`);
			return userTexts(messages).some((text) => text.includes("你忙完之后看下这份清单"));
		}, 40_000);
		check("②followUp 排队不丢：递话正文在 B 收尾后落进它的会话", landed);
	});

	// ══ 阶段三：目标不存在 ══
	await phase("⑤missing", {
		LLM_FAUX_TOOL: "send_to_agent",
		LLM_FAUX_ARGS: JSON.stringify({ target: "查无此人", message: "在吗" }),
	}, async () => {
		const a = await createPartner("信使甲", "inbox");
		await api("POST", `/api/v1/partners/${a}/run`, { text: "找个人" });
		const outs = stepOutputs(await readMessages(`partner-${a}`), "send_to_agent");
		check(
			"⑤目标不存在：引导列出可用执事，不静默失败",
			outs.some((out) => out.includes("没有叫「查无此人」的执事") && out.includes("信使甲")),
			outs[0]?.slice(0, 60),
		);
	});

	// ══ 阶段三：重名 ══
	await phase("⑤ambiguous", {
		LLM_FAUX_TOOL: "send_to_agent",
		LLM_FAUX_ARGS: JSON.stringify({ target: "同名", message: "在吗" }),
	}, async () => {
		const a = await createPartner("信使甲", "inbox");
		await createPartner("同名", "alpha");
		await createPartner("同名", "beta");
		await api("POST", `/api/v1/partners/${a}/run`, { text: "找个人" });
		const outs = stepOutputs(await readMessages(`partner-${a}`), "send_to_agent");
		const ambiguous = outs.find((out) => out.includes("不猜是哪一个")) ?? "";
		check(
			"⑤重名：拒绝猜，给「名字·领域」候选",
			ambiguous.includes("同名·alpha") && ambiguous.includes("同名·beta"),
			ambiguous.slice(0, 70),
		);
	});

	// ══ 阶段四：回滚开关 ══
	await phase("⑥回滚", {
		LLM_FAUX_TOOL: "send_to_agent",
		LLM_FAUX_ARGS: JSON.stringify({ target: "信使乙", message: "在吗" }),
		PARTNER_RELAY_ENABLED: "false",
	}, async () => {
		const a = await createPartner("信使甲", "inbox");
		await api("POST", `/api/v1/partners/${a}/run`, { text: "转告一下" });
		const outs = stepOutputs(await readMessages(`partner-${a}`), "send_to_agent");
		check(
			"⑥PARTNER_RELAY_ENABLED=false：工具不上架（tool_unavailable）",
			outs.some((out) => out.includes("is not available")),
			outs[0]?.slice(0, 60),
		);
	});
}

/** 起一个独立服务进程跑一个阶段（临时库按阶段隔离，互不污染） */
async function phase(
	label: string,
	env: Record<string, string>,
	body: () => Promise<void>,
): Promise<void> {
	// 每段一套库：共用一份 SQLite 会把上一段的执事带进来（症状是"建执事 400 重名"）
	phaseRoot = join(ROOT, `phase-${labelSlug++}`);	console.log(`\n── ${label} ──`);
	const server = await startServer(env);
	try {
		await body();
	} finally {
		await stopServer(server);
	}
}

async function createPartner(name: string, domain?: string): Promise<string> {
	const res = await api("POST", "/api/v1/partners", domain ? { name, domain } : { name });
	check(`建执事 ${name}${domain ? `·${domain}` : ""}`, res.status === 201, `status=${res.status}`);
	return String(res.body?.partner?.id ?? "");
}

// ── 起服务 / 请求辅助（companion-probe 同款骨架）────────────
let child: ReturnType<typeof spawn> | null = null;

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: "Bearer probe-token" };
}

async function startServer(extraEnv: Record<string, string>): Promise<ReturnType<typeof spawn>> {
	// 端口护栏：已经有东西在这个端口上，探针会连到别人的服务上（症状极难认出）
	// —— 与其"每项检查都莫名其妙地红"，不如开局就说清楚。
	const preexisting = await fetch(`http://127.0.0.1:${PORT}/healthz`)
		.then(() => true)
		.catch(() => false);
	if (preexisting) throw new Error(`端口 ${PORT} 已被占用：先关掉占用的服务再跑探针`);

	// 直接 `node --import tsx`：tsx 的 CLI 会再起一个子进程跑 app，kill 父进程会留下
	// 占着端口的孤儿（实测：下一段探针全连到上一段的服务上，症状是"建执事 400 重名"）。
	const proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
		cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		env: {
			...process.env,
			PORT: String(PORT),
			AGENT_TOKEN: "probe-token",
			AGENT_DB_PATH: join(phaseRoot, "agent.sqlite"),
			MEMORY_DB_PATH: join(phaseRoot, "memory.db"),
			MEMORY_ENABLED: "false",
			PROJECTS_DB_PATH: join(phaseRoot, "projects.sqlite"),
			PROVIDERS_PATH: join(phaseRoot, "providers.json"),
			DELEGATIONS_DB_PATH: join(phaseRoot, "delegations.sqlite"),
			AGENT_SSE_SEQ_DB_PATH: join(phaseRoot, "chat-events.sqlite"),
			AUTONOMY_ENABLED: "false", // 探针显式关（默认已于 2026-11-13 翻成开）
			AGENT_APPROVALS_PATH: join(phaseRoot, "approvals.json"),
			AGENT_POLICY_PATH: join(phaseRoot, "policy.json"),
			PARTNERS_DB_PATH: join(phaseRoot, "partners.sqlite"),
			PARTNER_HOMES_ROOT: join(phaseRoot, "partner-homes"),
			ROUTINES_STATE_PATH: join(phaseRoot, "routines.json"),
			AUTONOMY_STATE_PATH: join(phaseRoot, "autonomy-state.json"),
			TOPICS_STATE_PATH: join(phaseRoot, "topics.json"),
			CHANCELLOR_ENABLED: "false",
			LLM_PROVIDER: "faux",
			// 首次问候要真生成（faux 下会跑一轮模型），与本批无关且白耗一轮；关掉只建会话。
			PARTNER_GREETING_ENABLED: "false",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`  [server] ${chunk}`));
	proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`  [server!] ${chunk}`));
	child = proc;

	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
			if (res.ok) return proc;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() > deadline) throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		await sleep(300);
	}
}

async function stopServer(proc: ReturnType<typeof spawn>): Promise<void> {
	if (child !== proc) return;
	child = null;
	// tsx 的 CLI 会再起一个子进程跑 app：只 kill 直接子进程会把它留成孤儿占着端口
	// （实测：下一次跑探针直接 EADDRINUSE）。Windows 用 taskkill /T 收整棵树。
	if (process.platform === "win32" && proc.pid) {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
				stdio: "ignore",
			});
			killer.on("exit", () => resolve());
			killer.on("error", () => resolve());
		});
	} else {
		proc.kill();
	}
	await sleep(400);
}

async function api(
	method: string,
	path: string,
	body: unknown,
): Promise<{ status: number; body: any }> {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
		method,
		headers: authHeaders(),
		...(body === null ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	let parsed: any = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = { raw: text.slice(0, 200) };
	}
	return { status: res.status, body: parsed };
}

/** POST SSE：读完整条流（帧解析用共享解码器，与服务端同源） */
async function postSse(path: string, body: unknown): Promise<{ status: number; events: any[] }> {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(body),
	});
	if (res.status !== 200 || !res.body) return { status: res.status, events: [] };
	const decoder = createSseDecoder();
	const reader = res.body.getReader();
	const textDecoder = new TextDecoder();
	const events: any[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		for (const event of decoder.push(textDecoder.decode(value, { stream: true }))) {
			events.push(event);
		}
	}
	return { status: 200, events };
}

main()
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			rmSync(ROOT, { recursive: true, force: true });
		} catch {
			/* Windows 上服务进程刚死可能还占着目录，清不掉就算了 */
		}
	});
