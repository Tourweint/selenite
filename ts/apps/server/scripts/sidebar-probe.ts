import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createSession,
	defineDoc,
	InboxDoc,
	type ConversationId,
	type Cursor,
	type JsonObject,
	type Session,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * 侧栏调整 B 批探针（2026-11-06）：真起服务 + 真 HTTP + faux 模型 + 独立临时库。
 *
 * 覆盖方案 §B 的验收点：
 *   1. worker / chief 身份落 durable：新建指定 worker → 重启仍是 worker；续话不能改种类；
 *      列表与历史都带回 chatKind；旧调用方不带字段仍 chief。
 *   2. 头像：坏图 400 且不半写名字；合法 PNG 保存 / 重启保留 / null 清除。
 *   3. 首次问候：首次 open 单条 assistant；重复 open / 并发 open / 重启不重复；
 *      已有历史 existing；暂停 409；关闭开关 disabled；无模型 503 不伪造成功。
 *   4. 崩溃恢复（2026-11-06 返修）：用真实 durable 事务构造明确的 pending / ready 现场，
 *      关掉本探针自己起的子进程再重开，断言复用同一 attempt / requestId / 生成会话，
 *      canonical 最终只有 1 条 assistant、没有伪造 user。
 *   5. 投递前已有用户输入：queued（InboxDoc）必须 skipped；placed pi.user 必须不投递。
 *      placed 现场的 doc 终态目前是 ready + greeting=existing（与方案 §B3 的 skipped 口径冲突），
 *      该断言保留为红项，作为产品语义差异的证据，不在探针里放宽。
 *   6. persona 内容：本进程内起假 OpenAI 上游，捕获真实模型请求的 messages，
 *      断言 worker 无总管 SOUL、chief 有、普通执事与问候生成只带自己的 SOUL。
 *
 * 隔离口径（2026-11-06 返修）：
 *   - 子进程 cwd = 本次 mkdtemp 的 ROOT，故 index.ts 首行 loadEnvFile() 读的是
 *     ROOT/.env（不存在），不会读到项目 .env；所有相对 `.data/*` 默认值也落 ROOT。
 *   - tsx / src/index.ts 都用 import.meta.url 解析成绝对路径，不依赖启动 cwd。
 *   - 子进程环境只给 Windows/Node 必需 OS 变量 + baseEnv + 阶段 extraEnv，
 *     不继承宿主的真实密钥、代理、中继等业务变量；也不改动宿主的权限 / hook 环境。
 *   - 端口启动前由 OS 分配（bind :0）并全程复用；就绪判定除了 healthz 还要过
 *     probe-token 鉴权，端口上已有别的服务时直接中止，绝不冒认成功。
 *   - 监听 spawn error / exit；main 的 finally 等自己起的子进程真正退出后才删 ROOT。
 *
 *   pnpm --filter @lifediary/server exec tsx scripts/sidebar-probe.ts
 */

/** 启动前由 OS 分配；后续所有阶段复用同一个端口 */
let PORT = 0;
/** 假 OpenAI 上游端口：只用来捕获 persona 请求与制造「生成中崩溃」 */
let UPSTREAM_PORT = 0;
const ROOT = mkdtempSync(join(tmpdir(), "lifediary-sidebar-probe-"));

/** 与 partner-runtime.ts 同一个后台上下文（durable 的 commit 需要它，不是请求上下文） */
const CTX = BACKGROUND_CONTEXT;

/**
 * 探针侧的 durable 文档定义：kind / version / scope / history / fork 必须与产品一致，
 * 否则 tx.doc() 会按「不同定义」拒绝。这里只用来读状态、构造明确的 pending/ready 崩溃现场。
 */
const ChatsDoc = defineDoc<{ byExternal: Record<string, number> }>({
	kind: "lifediary.chats",
	version: 1,
	scope: "session",
	initial: () => ({ byExternal: {} }),
	checkpointWhen: () => false,
});

type GreetingStatus = "idle" | "pending" | "ready" | "sent" | "skipped" | "failed";
interface GreetingState extends JsonObject {
	attempt: number;
	status: GreetingStatus;
	generationExternalId: string;
	requestId: string;
	text: string;
	updatedAt: string;
}

const GreetingDoc = defineDoc<GreetingState>({
	kind: "lifediary.partner-greeting",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({
		attempt: 0,
		status: "idle",
		generationExternalId: "",
		requestId: "",
		text: "",
		updatedAt: "",
	}),
	checkpointWhen: () => false,
});

/** 假上游的固定回复：断言「落库的是模型输出」时用它 */
let upstreamText = "（假上游）链路已通。";
type UpstreamMode = "respond" | "hold";
/** hold = 记录请求但不回包，用来把问候卡在真实的 pending 状态 */
let upstreamMode: UpstreamMode = "respond";
interface UpstreamRequest {
	body: Record<string, unknown>;
	at: number;
}
const upstreamRequests: UpstreamRequest[] = [];
const heldResponses = new Set<ServerResponse>();

const TSX_CLI = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** 一张真实的 1×1 PNG（透明像素） */
const VALID_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) {
		failures += 1;
		process.exitCode = 1;
	}
}

// ── 跨阶段保留的状态 ─────────────────────────────────────
const state: {
	workerChat?: string;
	chiefChat?: string;
	avatarPartner?: string;
	greetingPartner?: string;
	greetingChat?: string;
	disabledPartner?: string;
	disabledChat?: string;
	queuedPartner?: string;
	queuedChat?: string;
	placedPartner?: string;
	placedChat?: string;
} = {};

async function main(): Promise<void> {
	PORT = await allocatePort();
	// 两次 bind :0 之间端口可能被再次分配；错开再取一次即可（仍由 OS 决定）
	do {
		UPSTREAM_PORT = await allocatePort();
	} while (UPSTREAM_PORT === PORT);
	console.log(`探针临时根目录: ${ROOT}`);
	console.log(`探针端口: ${PORT}（OS 分配，重启复用）`);
	console.log(`假上游端口: ${UPSTREAM_PORT}（只在本进程内监听）`);
	const upstream = await startUpstream();
	try {
		await runPhases();
	} finally {
		// startServer 失败时 server 局部变量可能还没赋值，但 child 已在 spawn 后立刻登记
		if (child) await stopServer(child);
		for (const response of heldResponses) response.destroy();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	}
}

/** 阶段 1–6：每阶段自己 stop，异常时由 main 兜底收掉当前子进程 */
async function runPhases(): Promise<void> {
	// ── 阶段 1：faux 全链路（身份 / 头像 / 问候基础）──
	let server = await startServer({ LLM_PROVIDER: "faux" });
	try {
		// 1a. 新建 worker
		const worker = await chat({
			messages: [{ role: "user", content: "你好" }],
			chatKind: "worker",
		});
		check("新建 worker：SSE 正常且拿到 conversationId", worker.status === 200 && !!worker.conversationId);
		state.workerChat = worker.conversationId;

		const workerMessages = await api("GET", `/api/v1/agent/chat/${state.workerChat}/messages`);
		check(
			"历史响应带 chatKind=worker",
			workerMessages.status === 200 && workerMessages.body.chatKind === "worker",
			`chatKind=${workerMessages.body?.chatKind}`,
		);

		const list = await api("GET", "/api/v1/agent/chats?limit=50");
		const workerEntry = (list.body.chats ?? []).find(
			(entry: { conversationId?: string }) => entry.conversationId === state.workerChat,
		);
		check(
			"会话列表恢复 chatKind=worker",
			list.status === 200 && workerEntry?.chatKind === "worker",
			`chatKind=${workerEntry?.chatKind}`,
		);

		// 1b. 不带 chatKind = 旧调用方，仍然 chief
		const chief = await chat({ messages: [{ role: "user", content: "默认身份" }] });
		state.chiefChat = chief.conversationId;
		const chiefMessages = await api("GET", `/api/v1/agent/chat/${state.chiefChat}/messages`);
		check(
			"不带 chatKind 的新会话仍是 chief（手机/旧调用方零改动）",
			chiefMessages.status === 200 && chiefMessages.body.chatKind === "chief",
			`chatKind=${chiefMessages.body?.chatKind}`,
		);

		// 1c. 续话不能改种类
		const mismatch = await api("POST", "/api/v1/agent/chat", {
			conversationId: state.workerChat,
			chatKind: "chief",
			messages: [{ role: "user", content: "改身份" }],
		});
		check(
			"续话带不匹配 chatKind：400（不隐式改身份）",
			mismatch.status === 400 && mismatch.body?.error === "chat_kind_mismatch",
			`status=${mismatch.status} error=${mismatch.body?.error}`,
		);

		const continued = await chat({
			conversationId: state.workerChat,
			messages: [{ role: "user", content: "继续聊" }],
		});
		check("worker 续话（不带 chatKind）正常", continued.status === 200 && !!continued.conversationId);
		const continuedExplicit = await chat({
			conversationId: state.workerChat,
			chatKind: "worker",
			messages: [{ role: "user", content: "再继续" }],
		});
		check("worker 续话（带匹配 chatKind）正常", continuedExplicit.status === 200);
		const afterContinue = await api("GET", `/api/v1/agent/chat/${state.workerChat}/messages`);
		check("续话后种类仍是 worker", afterContinue.body?.chatKind === "worker");

		// 1d. 头像：坏图不半写
		const created = await api("POST", "/api/v1/partners", { name: "头像执事" });
		state.avatarPartner = created.body?.partner?.id;
		check("建执事：avatar 投影为 null", created.status === 201 && created.body?.partner?.avatar === null);

		const badAvatar = await api("PATCH", `/api/v1/partners/${state.avatarPartner}`, {
			name: "不该生效",
			avatar: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
		});
		check("坏头像：400", badAvatar.status === 400, `status=${badAvatar.status}`);
		const afterBad = await api("GET", `/api/v1/partners/${state.avatarPartner}`);
		check(
			"坏头像不半写名字 / 不覆盖原头像",
			afterBad.body?.partner?.name === "头像执事" && afterBad.body?.partner?.avatar === null,
			`name=${afterBad.body?.partner?.name} avatar=${afterBad.body?.partner?.avatar === null ? "null" : "set"}`,
		);

		const savedAvatar = await api("PATCH", `/api/v1/partners/${state.avatarPartner}`, { avatar: VALID_PNG });
		check("合法 PNG：保存成功且投影回显", savedAvatar.status === 200 && savedAvatar.body?.partner?.avatar === VALID_PNG);

		// 1e. 首次问候
		const greetingPartner = await api("POST", "/api/v1/partners", { name: "问候执事" });
		state.greetingPartner = greetingPartner.body?.partner?.id;
		const opened = await api("POST", `/api/v1/partners/${state.greetingPartner}/open`, null);
		state.greetingChat = opened.body?.conversationId;
		check(
			"首次 open：greeting=sent 且返回 canonical id",
			opened.status === 200 && opened.body?.greeting === "sent" && String(state.greetingChat).startsWith("partner-"),
			`status=${opened.status} greeting=${opened.body?.greeting}`,
		);
		const greetingMessages = await api("GET", `/api/v1/agent/chat/${state.greetingChat}/messages`);
		const firstMessages = greetingMessages.body?.messages ?? [];
		check(
			"首次问候只有一条 assistant（不伪造 user）",
			firstMessages.length === 1 && firstMessages[0]?.role === "assistant",
			`messages=${JSON.stringify(firstMessages.map((m: { role: string }) => m.role))}`,
		);
		check(
			"问候走真实生成链路（faux 应答）",
			String(firstMessages[0]?.text ?? "").includes("faux"),
			`text=${String(firstMessages[0]?.text ?? "").slice(0, 24)}`,
		);
		check(
			"执事 canonical 的历史 chatKind=partner（链接优先于记录）",
			greetingMessages.body?.chatKind === "partner",
			`chatKind=${greetingMessages.body?.chatKind}`,
		);

		const reopened = await api("POST", `/api/v1/partners/${state.greetingPartner}/open`, null);
		const afterReopen = await api("GET", `/api/v1/agent/chat/${state.greetingChat}/messages`);
		check(
			"重复 open：existing 且消息不增加",
			reopened.body?.greeting === "existing" && (afterReopen.body?.messages ?? []).length === 1,
			`greeting=${reopened.body?.greeting} messages=${(afterReopen.body?.messages ?? []).length}`,
		);

		// 1f. 并发 open（同进程单飞 + 事务认领）
		const concurrentPartner = await api("POST", "/api/v1/partners", { name: "并发执事" });
		const concurrentId = concurrentPartner.body?.partner?.id;
		const [a, b, c] = await Promise.all([
			api("POST", `/api/v1/partners/${concurrentId}/open`, null),
			api("POST", `/api/v1/partners/${concurrentId}/open`, null),
			api("POST", `/api/v1/partners/${concurrentId}/open`, null),
		]);
		const concurrentChat = a.body?.conversationId;
		const concurrentMessages = await api("GET", `/api/v1/agent/chat/${concurrentChat}/messages`);
		const outcomes = [a.body?.greeting, b.body?.greeting, c.body?.greeting].sort();
		check(
			"并发 open：三次都成功、同一个 canonical、只有一条问候",
			[a.status, b.status, c.status].every((status) => status === 200) &&
				b.body?.conversationId === concurrentChat &&
				c.body?.conversationId === concurrentChat &&
				(concurrentMessages.body?.messages ?? []).length === 1,
			`outcomes=${outcomes.join(",")} messages=${(concurrentMessages.body?.messages ?? []).length}`,
		);

		// 1g. 已有历史 → existing（不生成）
		const historyPartner = await api("POST", "/api/v1/partners", { name: "有历史执事" });
		const historyId = historyPartner.body?.partner?.id;
		await api("POST", `/api/v1/partners/${historyId}/run`, { text: "报个平安" });
		const openWithHistory = await api("POST", `/api/v1/partners/${historyId}/open`, null);
		const historyMessages = await api(
			"GET",
			`/api/v1/agent/chat/${openWithHistory.body?.conversationId}/messages`,
		);
		check(
			"已有历史：existing，且没有再追加问候",
			openWithHistory.status === 200 &&
				openWithHistory.body?.greeting === "existing" &&
				(historyMessages.body?.messages ?? []).length === 2,
			`greeting=${openWithHistory.body?.greeting} messages=${(historyMessages.body?.messages ?? []).length}`,
		);

		// 1h. 暂停 → 409；chief → 400；不存在 → 404
		const pausedPartner = await api("POST", "/api/v1/partners", { name: "暂停执事" });
		const pausedId = pausedPartner.body?.partner?.id;
		await api("PATCH", `/api/v1/partners/${pausedId}`, { status: "paused" });
		const pausedOpen = await api("POST", `/api/v1/partners/${pausedId}/open`, null);
		check("暂停执事 open：409", pausedOpen.status === 409, `status=${pausedOpen.status}`);

		const chiefOpen = await api("POST", "/api/v1/partners/chief/open", null);
		check("总管 open：400（不走这个入口）", chiefOpen.status === 400, `status=${chiefOpen.status}`);

		const missingOpen = await api("POST", "/api/v1/partners/00000000-0000-4000-8000-000000000000/open", null);
		check("不存在执事 open：404", missingOpen.status === 404, `status=${missingOpen.status}`);
	} finally {
		await stopServer(server);
	}

	// ── 阶段 2：重启后身份 / 头像 / 问候去重 ──
	server = await startServer({ LLM_PROVIDER: "faux" });
	try {
		const workerMessages = await api("GET", `/api/v1/agent/chat/${state.workerChat}/messages`);
		check("重启后 worker 仍是 worker", workerMessages.body?.chatKind === "worker", `chatKind=${workerMessages.body?.chatKind}`);

		const chiefMessages = await api("GET", `/api/v1/agent/chat/${state.chiefChat}/messages`);
		check("重启后 chief 仍是 chief", chiefMessages.body?.chatKind === "chief");

		const avatar = await api("GET", `/api/v1/partners/${state.avatarPartner}`);
		check("重启后头像仍在（服务端持久化，不是浏览器本地）", avatar.body?.partner?.avatar === VALID_PNG);

		const reopen = await api("POST", `/api/v1/partners/${state.greetingPartner}/open`, null);
		const messages = await api("GET", `/api/v1/agent/chat/${state.greetingChat}/messages`);
		check(
			"重启后重复 open：existing 且仍只有一条问候",
			reopen.body?.greeting === "existing" && (messages.body?.messages ?? []).length === 1,
			`greeting=${reopen.body?.greeting} messages=${(messages.body?.messages ?? []).length}`,
		);

		const cleared = await api("PATCH", `/api/v1/partners/${state.avatarPartner}`, { avatar: null });
		const afterClear = await api("GET", `/api/v1/partners/${state.avatarPartner}`);
		check(
			"avatar=null 清除（投影回 null，前端恢复首字）",
			cleared.status === 200 && afterClear.body?.partner?.avatar === null,
		);
	} finally {
		await stopServer(server);
	}

	// ── 阶段 3：WORKER_CHAT_ENABLED=false 只拦新建 ──
	server = await startServer({ LLM_PROVIDER: "faux", WORKER_CHAT_ENABLED: "false" });
	try {
		const blocked = await chat({
			messages: [{ role: "user", content: "新建 worker" }],
			chatKind: "worker",
		});
		check(
			"开关关闭：新建 worker 被业务拒绝（400）",
			blocked.status === 400,
			`status=${blocked.status} body=${blocked.raw.slice(0, 80)}`,
		);

		const existing = await chat({
			conversationId: state.workerChat,
			messages: [{ role: "user", content: "旧 worker 继续" }],
		});
		check("开关关闭：已落盘 worker 保持身份、可继续聊", existing.status === 200);
		const kindAfter = await api("GET", `/api/v1/agent/chat/${state.workerChat}/messages`);
		check("开关关闭：旧 worker 不被重解释成 chief", kindAfter.body?.chatKind === "worker");
	} finally {
		await stopServer(server);
	}

	// ── 阶段 4：PARTNER_GREETING_ENABLED=false → 建空会话、不生成 ──
	// 同时为阶段 5 准备三个空 canonical（ready 崩溃 / 已入队 / 已放置 user 三种现场）。
	server = await startServer({ LLM_PROVIDER: "faux", PARTNER_GREETING_ENABLED: "false" });
	try {
		const partner = await api("POST", "/api/v1/partners", { name: "问候关闭执事" });
		state.disabledPartner = partner.body?.partner?.id;
		const opened = await api("POST", `/api/v1/partners/${state.disabledPartner}/open`, null);
		state.disabledChat = opened.body?.conversationId;
		check(
			"问候开关关闭：仍建/打开会话，greeting=disabled",
			opened.status === 200 && opened.body?.greeting === "disabled" && !!state.disabledChat,
			`greeting=${opened.body?.greeting}`,
		);
		const messages = await api("GET", `/api/v1/agent/chat/${state.disabledChat}/messages`);
		check("问候开关关闭：会话为空（没有伪造问候）", (messages.body?.messages ?? []).length === 0);

		const queued = await api("POST", "/api/v1/partners", { name: "排队执事" });
		state.queuedPartner = queued.body?.partner?.id;
		const queuedOpen = await api("POST", `/api/v1/partners/${state.queuedPartner}/open`, null);
		state.queuedChat = queuedOpen.body?.conversationId;
		check("排队现场：已建空 canonical", queuedOpen.body?.greeting === "disabled" && !!state.queuedChat);

		const placed = await api("POST", "/api/v1/partners", { name: "已说话执事" });
		state.placedPartner = placed.body?.partner?.id;
		const placedOpen = await api("POST", `/api/v1/partners/${state.placedPartner}/open`, null);
		state.placedChat = placedOpen.body?.conversationId;
		check("已放置现场：已建空 canonical", placedOpen.body?.greeting === "disabled" && !!state.placedChat);
	} finally {
		await stopServer(server);
	}

	// ── 阶段 5：ready 崩溃恢复 / 已入队 / 已放置 ────────────────
	// 不靠 sleep 制造竞态：服务已停，直接用真实 durable 存储把 doc 写成 ready，
	// 或写入真实 submission + InboxDoc / pi.user，再起服务看 open 的行为。
	{
		const readyText = "预先落盘的问候。";
		const seeded = await seedCrashStates({
			readyChat: state.disabledChat!,
			readyText,
			queuedChat: state.queuedChat!,
			queuedText: "我已经排在队列里了",
			placedChat: state.placedChat!,
			placedText: "我已经说过话了",
		});
		check(
			"durable 现场构造成功：ready / queued / placed 三种 canonical 都已落盘",
			seeded.readyInternal > 0 && seeded.queuedInternal > 0 && seeded.placedInternal > 0,
			`ready=${seeded.readyInternal} queued=${seeded.queuedInternal} placed=${seeded.placedInternal}`,
		);
		check(
			"重启前 ready doc 状态就是 ready（不是跑完才写）",
			seeded.ready.status === "ready" && seeded.ready.text === readyText,
			`status=${seeded.ready.status} text=${seeded.ready.text}`,
		);
		check(
			"重启前 queued / placed 现场确实带用户输入",
			seeded.queuedInboxItems >= 1 && seeded.placedUserEntries >= 1,
			`inbox=${seeded.queuedInboxItems} userEntries=${seeded.placedUserEntries}`,
		);

		server = await startServer({ LLM_PROVIDER: "faux" });

		// 5a. ready 崩溃：重启后只需投递，不再生成
		const readyOpen = await api("POST", `/api/v1/partners/${state.disabledPartner}/open`, null);
		const readyMessages = await api("GET", `/api/v1/agent/chat/${state.disabledChat}/messages`);
		const readyList = (readyMessages.body?.messages ?? []) as Array<{ role: string; text: string }>;
		const readyState = await readGreetingStateForExternal(state.disabledChat!);
		check(
			"ready 崩溃恢复：open 直接投递（sent），只 1 条 assistant",
			readyOpen.status === 200 &&
				readyOpen.body?.greeting === "sent" &&
				readyList.length === 1 &&
				readyList[0]?.role === "assistant",
			`greeting=${readyOpen.body?.greeting} types=${readyList.map((m) => m.role).join(",")}`,
		);
		check(
			"ready 崩溃恢复：投递的是预先落盘的文本（没有重新生成）",
			readyList[0]?.text === readyText,
			`text=${String(readyList[0]?.text ?? "").slice(0, 24)}`,
		);
		check(
			"ready 崩溃恢复：doc 终态 sent，attempt/requestId 不变",
			readyState?.status === "sent" && readyState?.attempt === 1 && readyState?.requestId === seeded.ready.requestId,
			`status=${readyState?.status} attempt=${readyState?.attempt}`,
		);
		const readyReopen = await api("POST", `/api/v1/partners/${state.disabledPartner}/open`, null);
		check(
			"ready 崩溃恢复：再次 open = existing，不重复投递",
			readyReopen.body?.greeting === "existing" &&
				(await api("GET", `/api/v1/agent/chat/${state.disabledChat}/messages`)).body?.messages?.length === 1,
			`greeting=${readyReopen.body?.greeting}`,
		);

		// 5b. 已受理但未落 entry 的输入（queued）→ 投递时标 skipped
		const queuedOpen = await api("POST", `/api/v1/partners/${state.queuedPartner}/open`, null);
		const queuedMessages = await api("GET", `/api/v1/agent/chat/${state.queuedChat}/messages`);
		const queuedState = await readGreetingStateForExternal(state.queuedChat!);
		check(
			"queued input：不投递问候，greeting=skipped",
			queuedOpen.status === 200 && queuedOpen.body?.greeting === "skipped",
			`greeting=${queuedOpen.body?.greeting}`,
		);
		check(
			"queued input：canonical 没有 assistant 问候、没有伪造 user",
			(queuedMessages.body?.messages ?? []).length === 0,
			`messages=${(queuedMessages.body?.messages ?? []).length}`,
		);
		check(
			"queued input：doc 状态是 skipped（不是 sent/ready）",
			queuedState?.status === "skipped",
			`status=${queuedState?.status}`,
		);

		// 5c. 已放置的 pi.user：已有历史，claim 阶段就应短路
		const placedOpen = await api("POST", `/api/v1/partners/${state.placedPartner}/open`, null);
		const placedMessages = await api("GET", `/api/v1/agent/chat/${state.placedChat}/messages`);
		const placedState = await readGreetingStateForExternal(state.placedChat!);
		const placedList = (placedMessages.body?.messages ?? []) as Array<{ role: string }>;
		check(
			"placed+pi.user：不投递问候（没有 assistant 问候）",
			placedOpen.status === 200 &&
				placedList.filter((m) => m.role === "assistant").length === 0 &&
				placedList.some((m) => m.role === "user"),
			`greeting=${placedOpen.body?.greeting} types=${placedList.map((m) => m.role).join(",")}`,
		);
		check(
			"placed+pi.user：doc 状态按设计应为 skipped",
			placedState?.status === "skipped",
			`status=${placedState?.status} greeting=${placedOpen.body?.greeting}`,
		);

		await stopServer(server);
	}

	// ── 阶段 6：没有模型 → 503，不伪造成功 ──
	server = await startServer({ LLM_PROVIDER: "", LLM_API_KEY: "", LLM_MODELS: "" });
	try {
		const partner = await api("POST", "/api/v1/partners", { name: "无模型执事" });
		const partnerId = partner.body?.partner?.id;
		const opened = await api("POST", `/api/v1/partners/${partnerId}/open`, null);
		check(
			"无模型：open 明确 503（不返回 ok）",
			opened.status === 503 && opened.body?.ok !== true,
			`status=${opened.status} error=${opened.body?.error}`,
		);
		check(
			"无模型：错误文案不带上游/密钥信息",
			!/sk-|api key|http/i.test(JSON.stringify(opened.body ?? {})),
			JSON.stringify(opened.body ?? {}).slice(0, 80),
		);
	} finally {
		await stopServer(server);
	}

	// ── 阶段 7：真实模型请求的 persona 分流 + pending 崩溃恢复 ──
	// 用本进程里的假 OpenAI 上游捕获 messages，直接断言 system 里到底注入了谁的 SOUL。
	upstreamMode = "respond";
	upstreamText = "（假上游）例行回复。";
	server = await startServer(fakeLlmEnv());
	try {
		// 7a. worker：普通任务助手，不读总管 SOUL
		const worker = await chat({
			messages: [{ role: "user", content: "persona probe worker" }],
			chatKind: "worker",
		});
		const workerSystem = lastSystemPrompt();
		check("persona worker：真实模型请求里是普通任务助手提示", workerSystem.includes("你是一个普通任务助手"), preview(workerSystem));
		check(
			"persona worker：没有总管 SOUL 标记",
			!workerSystem.includes("你是一个个人助手，和一个具体的人长期相处"),
			preview(workerSystem),
		);

		// 7b. chief：总管 SOUL 仍在
		const chief = await chat({ messages: [{ role: "user", content: "persona probe chief" }] });
		const chiefSystem = lastSystemPrompt();
		check(
			"persona chief：真实模型请求里有总管 SOUL",
			chiefSystem.includes("你是一个个人助手，和一个具体的人长期相处"),
			preview(chiefSystem),
		);
		check(
			"persona chief：没有 worker 提示（身份不串台）",
			!chiefSystem.includes("你是一个普通任务助手"),
			preview(chiefSystem),
		);

		// 7c. 普通执事：只有自己的 SOUL，没有总管 / worker 提示
		const partner = await api("POST", "/api/v1/partners", { name: "人格执事" });
		const partnerId = partner.body?.partner?.id;
		const ran = await api("POST", `/api/v1/partners/${partnerId}/run`, { text: "persona probe partner" });
		const partnerSystem = lastSystemPrompt();
		check("persona partner：/run 正常完成", ran.status === 200, `status=${ran.status}`);
		check(
			"persona partner：带自己的 SOUL",
			partnerSystem.includes("你是人格执事"),
			preview(partnerSystem),
		);
		check(
			"persona partner：没有总管 SOUL",
			!partnerSystem.includes("你是一个个人助手，和一个具体的人长期相处"),
			preview(partnerSystem),
		);
		check(
			"persona partner：没有 worker 提示",
			!partnerSystem.includes("你是一个普通任务助手"),
			preview(partnerSystem),
		);

		// 7d. 问候生成（task- 会话）同样只用执事自己的 SOUL
		const greetingPartner = await api("POST", "/api/v1/partners", { name: "问候人格执事" });
		const greetingPartnerId = greetingPartner.body?.partner?.id;
		const greetingOpen = await api("POST", `/api/v1/partners/${greetingPartnerId}/open`, null);
		const greetingSystem = lastSystemPrompt();
		check(
			"persona 问候生成：open 正常",
			greetingOpen.status === 200 && greetingOpen.body?.greeting === "sent",
			`status=${greetingOpen.status}`,
		);
		check(
			"persona 问候生成：带执事自己的 SOUL",
			greetingSystem.includes("你是问候人格执事"),
			preview(greetingSystem),
		);
		check(
			"persona 问候生成：没有总管 SOUL / worker 提示",
			!greetingSystem.includes("你是一个个人助手，和一个具体的人长期相处") &&
				!greetingSystem.includes("你是一个普通任务助手"),
			preview(greetingSystem),
		);
		check(
			"persona 问候生成：没有工具（configureTaskChat 生效）",
			Array.isArray((upstreamRequests.at(-1)?.body as { tools?: unknown })?.tools)
				? ((upstreamRequests.at(-1)?.body as { tools?: unknown[] }).tools ?? []).length === 0
				: true,
			`tools=${JSON.stringify((upstreamRequests.at(-1)?.body as { tools?: unknown })?.tools ?? null).slice(0, 40)}`,
		);

		// 7e. pending 崩溃：上游请求已到（pending 已提交），杀掉服务再重开
		const crash = await api("POST", "/api/v1/partners", { name: "崩溃待定执事" });
		const crashId = crash.body?.partner?.id;
		const beforeHold = upstreamRequests.length;
		upstreamMode = "hold";
		const pendingOpen = api("POST", `/api/v1/partners/${crashId}/open`, null).catch((error: unknown) => ({
			status: 0,
			body: { error: String(error) },
		}));
		await waitForUpstream(beforeHold + 1, "pending 生成请求");
		// 此刻 claim 的 pending 已提交，生成 submission 已发出，上游正被 hold
		await stopServer(server, "SIGKILL");
		await pendingOpen;

		const pendingState = await readGreetingStateForPartner(crashId);
		check(
			"pending 崩溃现场：doc 确实是 pending，带稳定 requestId",
			pendingState?.status === "pending" &&
				pendingState?.attempt === 1 &&
				!!pendingState?.requestId &&
				pendingState.generationExternalId.startsWith("task-greeting-"),
			`status=${pendingState?.status} attempt=${pendingState?.attempt} requestId=${pendingState?.requestId?.slice(0, 8)}`,
		);

		// 重开：上游改成回包，open 必须复用同一 attempt / requestId，而不是另起一轮
		upstreamMode = "respond";
		upstreamText = "（假上游）崩溃后恢复的问候。";
		server = await startServer(fakeLlmEnv());
		const recovered = await api("POST", `/api/v1/partners/${crashId}/open`, null);
		const recoveredChat = recovered.body?.conversationId;
		const recoveredMessages = await api("GET", `/api/v1/agent/chat/${recoveredChat}/messages`);
		const recoveredList = (recoveredMessages.body?.messages ?? []) as Array<{ role: string; text: string }>;
		const recoveredState = await readGreetingStateForPartner(crashId);
		check(
			"pending 崩溃恢复：open 成功且最终 sent",
			recovered.status === 200 && recovered.body?.greeting === "sent",
			`status=${recovered.status} greeting=${recovered.body?.greeting}`,
		);
		check(
			"pending 崩溃恢复：canonical 仅 1 条 assistant、没有伪造 user",
			recoveredList.length === 1 &&
				recoveredList[0]?.role === "assistant" &&
				!recoveredList.some((m) => m.role === "user"),
			`types=${recoveredList.map((m) => m.role).join(",")}`,
		);
		check(
			"pending 崩溃恢复：复用同一 attempt / requestId / 生成会话（没有重开一轮）",
			recoveredState?.status === "sent" &&
				recoveredState?.attempt === 1 &&
				recoveredState?.requestId === pendingState?.requestId &&
				recoveredState?.generationExternalId === pendingState?.generationExternalId,
			`attempt=${recoveredState?.attempt} requestId同=${recoveredState?.requestId === pendingState?.requestId}`,
		);
		check(
			"pending 崩溃恢复：落库的是恢复后模型输出",
			recoveredList[0]?.text === upstreamText,
			`text=${String(recoveredList[0]?.text ?? "").slice(0, 24)}`,
		);
		const recoveredReopen = await api("POST", `/api/v1/partners/${crashId}/open`, null);
		check(
			"pending 崩溃恢复：再次 open = existing，不重复",
			recoveredReopen.body?.greeting === "existing" &&
				(await api("GET", `/api/v1/agent/chat/${recoveredChat}/messages`)).body?.messages?.length === 1,
			`greeting=${recoveredReopen.body?.greeting}`,
		);
	} finally {
		await stopServer(server);
	}
}

/** 让 OS 分配一个空闲端口：bind 到 :0 拿到端口后立刻释放，全程只用一个 */
async function allocatePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createNetServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => {
				if (error) reject(error);
				else if (port > 0) resolve(port);
				else reject(new Error("OS 没有分配端口"));
			});
		});
	});
}

// ── 假 OpenAI 上游（persona 捕获 + pending 卡点）───────────
function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => resolve(raw));
	});
}

function sseChunk(response: ServerResponse, payload: unknown): void {
	if (response.destroyed || response.writableEnded) return;
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startUpstream(): Promise<Server> {
	const server = createHttpServer(async (request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const raw = await readRequestBody(request);
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			/* 解析失败也记账，后面的断言自然会挂 */
		}
		upstreamRequests.push({ body, at: Date.now() });

		if (upstreamMode === "hold") {
			// 不回包：服务端会停在「等待模型」，此时 pending 已在 durable 里提交。
			heldResponses.add(response);
			const forget = () => heldResponses.delete(response);
			request.once("close", forget);
			response.once("close", forget);
			return;
		}

		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const base = {
			id: `chatcmpl-${randomUUID()}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: String(body.model ?? "fake"),
		};
		sseChunk(response, {
			...base,
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		});
		sseChunk(response, {
			...base,
			choices: [{ index: 0, delta: { content: upstreamText }, finish_reason: null }],
		});
		sseChunk(response, {
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
		});
		response.write("data: [DONE]\n\n");
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve());
	});
	return server;
}

function fakeLlmEnv(): Record<string, string> {
	return {
		LLM_PROVIDER: "",
		LLM_API_KEY: "probe-key",
		LLM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
		LLM_MODEL: "fake-probe",
		// 把对话用的思考变体也声明成目录模型：durable 在 Harness 打开时会先恢复未完成任务，
		// 那时还没有任何 chatStream 去登记进程内派生的 #think-* 变体；不声明就会以 no_model 终结。
		LLM_MODELS:
			"fake-probe,fake-probe#think-off,fake-probe#think-low,fake-probe#think-medium,fake-probe#think-high",
		PROVIDERS_CONFIG: "false",
	};
}

/** 等到上游真的收到第 N 个请求；等不到就明确失败，不用固定 sleep 猜。 */
async function waitForUpstream(count: number, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (upstreamRequests.length < count) {
		if (Date.now() > deadline) {
			throw new Error(`${label}：${timeoutMs}ms 内上游没有收到请求（已收到 ${upstreamRequests.length} 个）`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** 最近一次模型请求里的 system 正文（persona / instructions 都在这里）。 */
function lastSystemPrompt(): string {
	const body = upstreamRequests.at(-1)?.body;
	const messages = Array.isArray(body?.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
	return messages
		.filter((message) => message?.role === "system")
		.map((message) => {
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return (content as Array<Record<string, unknown>>)
					.map((block) => (typeof block?.text === "string" ? block.text : ""))
					.join("\n");
			}
			return "";
		})
		.join("\n");
}

function preview(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 64);
}

// ── durable 现场构造（只读/写测试库，不碰产品进程）──────────
/** 与产品相同的打开方式；子进程刚 SIGKILL 后可能短暂拿不到锁，做有界重试。 */
async function withDurable<T>(work: (session: Session) => Promise<T>): Promise<T> {
	let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | null = null;
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 20 && !storage; attempt += 1) {
		try {
			storage = await openNodeSqliteStorage(join(ROOT, "agent.sqlite"));
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	if (!storage) throw lastError instanceof Error ? lastError : new Error(String(lastError));
	const session = createSession(storage);
	try {
		return await work(session);
	} finally {
		await session.close(CTX);
	}
}

/** durable 的 ConversationId 是品牌类型；探针从 SQLite 读回来的是裸数字。 */
function cid(internal: number): ConversationId {
	return internal as ConversationId;
}

async function internalIdOfExternal(session: Session, externalId: string): Promise<number> {
	const chats = await session.snapshot(ChatsDoc, CTX);
	const internal = chats?.byExternal?.[externalId];
	if (typeof internal !== "number") throw new Error(`durable 里找不到会话 ${externalId} 的内部 id`);
	return internal;
}

async function internalIdOfPartner(session: Session, partnerId: string): Promise<number> {
	return await internalIdOfExternal(session, `partner-${partnerId}`);
}

interface SeedCrashInput {
	readyChat: string;
	readyText: string;
	queuedChat: string;
	queuedText: string;
	placedChat: string;
	placedText: string;
}

/**
 * 用真实 durable 事务把三种现场落盘：
 *   ready  = doc 文本已生成、投递前崩溃；
 *   queued = 已有受理但未落成 entry 的用户输入（InboxDoc）；
 *   placed = 已放置的 pi.user 历史。
 * 不新增任何生产测试开关。
 */
async function seedCrashStates(input: SeedCrashInput): Promise<{
	readyInternal: number;
	queuedInternal: number;
	placedInternal: number;
	ready: Readonly<GreetingState>;
	queuedInboxItems: number;
	placedUserEntries: number;
}> {
	return await withDurable(async (session) => {
		const readyInternal = await internalIdOfExternal(session, input.readyChat);
		const queuedInternal = await internalIdOfExternal(session, input.queuedChat);
		const placedInternal = await internalIdOfExternal(session, input.placedChat);
		const readyRequestId = randomUUID();

		await session.commit(async (tx) => {
			const ready = await tx.doc(GreetingDoc, cid(readyInternal));
			ready.attempt = 1;
			ready.status = "ready";
			ready.generationExternalId = `task-greeting-${readyInternal}-1`;
			ready.requestId = readyRequestId;
			ready.text = input.readyText;
			ready.updatedAt = new Date().toISOString();

			const queued = await tx.doc(GreetingDoc, cid(queuedInternal));
			queued.attempt = 1;
			queued.status = "ready";
			queued.generationExternalId = `task-greeting-${queuedInternal}-1`;
			queued.requestId = randomUUID();
			queued.text = "排队现场不应投递的问候";
			queued.updatedAt = new Date().toISOString();

			const placed = await tx.doc(GreetingDoc, cid(placedInternal));
			placed.attempt = 1;
			placed.status = "ready";
			placed.generationExternalId = `task-greeting-${placedInternal}-1`;
			placed.requestId = randomUUID();
			placed.text = "已说话现场不应投递的问候";
			placed.updatedAt = new Date().toISOString();
		}, CTX);

		// queued：真实 submission 记录 + 内核自己的 InboxDoc（mode != write 即用户输入）
		await session.commit(async (tx) => {
			const content = [{ type: "text", text: input.queuedText }];
			const submission = await tx.createSubmission({
				type: "input",
				conversationId: cid(queuedInternal),
				status: "queued",
				requestId: "probe-queued-input",
			});
			const inbox = await tx.doc(InboxDoc, cid(queuedInternal));
			inbox.items.push({
				id: submission.id,
				mode: "followUp",
				content: content as never,
			});
		}, CTX);

		// placed：一条合法的 pi.user entry（与提交落盘后的形状一致）
		await session.commit(async (tx) => {
			await tx.appendEntry(cid(placedInternal), {
				kind: "pi.user",
				model: [
					{
						role: "user",
						content: [{ type: "text", text: input.placedText }],
						timestamp: Date.now(),
					},
				],
			} as never);
		}, CTX);

		const ready = await session.snapshot(GreetingDoc, cid(readyInternal), CTX);
		if (!ready) throw new Error("ready doc 没有落盘");
		const inbox = await session.snapshot(InboxDoc, cid(queuedInternal), CTX);
		const placedUserEntries = await session.commit(async (tx) => {
			let count = 0;
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanEntries({ conversationId: cid(placedInternal), order: "ascending" }, 200, cursor);
				count += page.items.filter((entry) => entry.kind === "pi.user").length;
				cursor = page.next;
			} while (cursor !== undefined);
			return count;
		}, CTX);

		return {
			readyInternal,
			queuedInternal,
			placedInternal,
			ready,
			queuedInboxItems: inbox?.items.length ?? 0,
			placedUserEntries,
		};
	});
}

async function readGreetingStateForExternal(chatExternalId: string): Promise<Readonly<GreetingState> | undefined> {
	return await withDurable(async (session) => {
		const internal = await internalIdOfExternal(session, chatExternalId);
		return await session.snapshot(GreetingDoc, cid(internal), CTX);
	});
}

async function readGreetingStateForPartner(partnerId: string): Promise<Readonly<GreetingState> | undefined> {
	return await withDurable(async (session) => {
		const internal = await internalIdOfPartner(session, partnerId);
		return await session.snapshot(GreetingDoc, cid(internal), CTX);
	});
}

// ── 起服务 / 请求辅助 ────────────────────────────────────
let child: ReturnType<typeof spawn> | null = null;

function authHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: "Bearer probe-token" };
}

/**
 * 子进程只继承 Windows / Node 跑起来必需的 OS 变量。
 * 宿主的密钥、代理、中继、模型配置一律不带；也不去改宿主的权限 / hook 环境。
 */
const OS_ENV_KEYS = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"SYSTEMROOT",
	"SystemDrive",
	"windir",
	"COMSPEC",
	"ComSpec",
	"TEMP",
	"TMP",
	"TMPDIR",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"CommonProgramFiles",
	"CommonProgramFiles(x86)",
	"ALLUSERSPROFILE",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"OS",
	"LANG",
	"LC_ALL",
];

function osEnv(): Record<string, string> {
	const picked: Record<string, string> = {};
	for (const key of OS_ENV_KEYS) {
		const value = process.env[key];
		if (typeof value === "string" && value !== "") picked[key] = value;
	}
	return picked;
}

function baseEnv(): Record<string, string> {
	return {
		PORT: String(PORT),
		AGENT_TOKEN: "probe-token",
		// 工作目录固定为 ROOT：相对默认值（.data/*、runs/*）也只能落在临时目录
		AGENT_WORKDIR: ROOT,
		AGENT_DB_PATH: join(ROOT, "agent.sqlite"),
		MEMORY_DB_PATH: join(ROOT, "memory.db"),
		MEMORY_ENABLED: "false",
		PROJECTS_DB_PATH: join(ROOT, "projects.sqlite"),
		PROVIDERS_PATH: join(ROOT, "providers.json"),
		// 探针不落供应商文件：每个阶段都按显式 env 起，避免上一阶段的选择串到下一阶段
		PROVIDERS_CONFIG: "false",
		PROVIDER_KEYS_PATH: join(ROOT, "provider-keys.json"),
		MODEL_RUNTIME_PATH: join(ROOT, "runtime.json"),
		DELEGATIONS_DB_PATH: join(ROOT, "delegations.sqlite"),
		AGENT_SSE_SEQ_DB_PATH: join(ROOT, "chat-events.sqlite"),
		AGENT_APPROVALS_PATH: join(ROOT, "approvals.json"),
		AGENT_POLICY_PATH: join(ROOT, "policy.json"),
		AGENT_CHAT_META_PATH: join(ROOT, "chat-meta.json"),
		AGENT_LOCAL_SECRET_PATH: join(ROOT, "local-secret"),
		PARTNERS_DB_PATH: join(ROOT, "partners.sqlite"),
		PARTNER_HOMES_ROOT: join(ROOT, "partner-homes"),
		ROUTINES_STATE_PATH: join(ROOT, "routines.json"),
		AUTONOMY_STATE_PATH: join(ROOT, "autonomy-state.json"),
		DIARY_DB_PATH: join(ROOT, "diary.sqlite"),
		PAIRING_STORE_PATH: join(ROOT, "pairing.json"),
		COMPANION_HOMES_PATH: join(ROOT, "companion-homes.json"),
		REMOTE_DELEGATIONS_PATH: join(ROOT, "remote-delegations.json"),
		CHANCELLOR_WORK_ROOT: join(ROOT, "runs"),
		// 关掉一切自动后台调度：自主轮 / 模型档位探测 / 派活恢复回灌
		AUTONOMY_ENABLED: "false",
		MODEL_PROBE_LEVELS: "false",
		DELEGATION_RECOVER_REPORT: "false",
		CHANCELLOR_ENABLED: "false",
		// 探针绝不能碰用户正在用的中继 / 设备矩阵（宿主 env 里可能有真实配置）
		RELAY_ENABLED: "false",
		RELAY_URL: "",
		RELAY_TOKEN: "",
		DEVICE_MATRIX_ENABLED: "false",
		COMPANION_HOME_ENABLED: "false",
	};
}

async function startServer(extraEnv: Record<string, string>): Promise<ReturnType<typeof spawn>> {
	const proc = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
		// 从临时 ROOT 启动：index.ts 的 loadEnvFile() 读 ROOT/.env（不存在），
		// 相对 .data/* 默认值也落 ROOT，而不是 server 目录。
		cwd: ROOT,
		env: {
			...osEnv(),
			...baseEnv(),
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	child = proc;

	const lifecycle: {
		spawnError: Error | null;
		exit: { code: number | null; signal: NodeJS.Signals | null } | null;
	} = { spawnError: null, exit: null };
	proc.once("error", (error) => {
		lifecycle.spawnError = error;
	});
	proc.once("exit", (code, signal) => {
		lifecycle.exit = { code, signal };
	});
	proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`  [server] ${chunk}`));
	proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`  [server!] ${chunk}`));

	const deadline = Date.now() + 30_000;
	for (;;) {
		if (lifecycle.spawnError) throw new Error(`服务进程启动失败：${lifecycle.spawnError.message}`);
		if (lifecycle.exit) {
			throw new Error(
				`服务进程提前退出（code=${lifecycle.exit.code} signal=${lifecycle.exit.signal}）`,
			);
		}
		const health = await fetch(`http://127.0.0.1:${PORT}/healthz`).catch(() => null);
		if (health?.ok) {
			// healthz 是免鉴权的：端口上可能蹲着用户正在跑的服务。
			// 用本次探针独有的 token 再敲一次受保护端点，认不出自己就中止。
			const identity = await fetch(`http://127.0.0.1:${PORT}/api/v1/agent/policy`, {
				headers: authHeaders(),
			}).catch(() => null);
			if (!identity?.ok) {
				throw new Error(
					`端口 ${PORT} 上的服务不是本探针进程（healthz 可通但 probe-token 鉴权不通过），已中止`,
				);
			}
			return proc;
		}
		if (Date.now() > deadline) throw new Error("服务 30 秒没起来（看上面的 [server!] 输出）");
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
}

/** 只关自己起的那个子进程；等它真正 exit（不是等 healthz 消失）再交给下一阶段 */
async function stopServer(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
	if (child !== proc) return;
	// spawn 失败（'error' 且没有 pid）时没有进程可等，也不会再发 'exit'
	if (proc.pid === undefined) {
		child = null;
		return;
	}
	if (proc.exitCode !== null || proc.signalCode !== null) {
		child = null;
		await waitPortFree();
		return;
	}

	const exited = new Promise<void>((resolve) => {
		if (proc.exitCode !== null || proc.signalCode !== null) resolve();
		else proc.once("exit", () => resolve());
	});
	proc.kill(signal);
	const force = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			/* 已经退出 */
		}
	}, 5_000);
	force.unref();
	// SIGKILL 后仍拿不到 exit 属于异常：不把活进程当作已结束，直接报出来让上层保留现场
	const ended = await Promise.race([
		exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
	]);
	clearTimeout(force);
	if (!ended) throw new Error(`服务子进程 pid=${proc.pid} 在 SIGKILL 后仍未退出`);
	child = null;
	await waitPortFree();
}

/** 固定端口要跨阶段复用：等监听从内核真正释放，避免下一轮 bind 撞车 */
async function waitPortFree(): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const free = await new Promise<boolean>((resolve) => {
			const probe = createNetServer();
			probe.once("error", () => resolve(false));
			probe.listen(PORT, () => probe.close(() => resolve(true)));
		});
		if (free) return;
		if (Date.now() > deadline) throw new Error(`端口 ${PORT} 在子进程退出后仍未释放`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function api(
	method: string,
	path: string,
	body: unknown = null,
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

/** 走 §2.1 的 SSE 端点，读完整个流再返回（探针不需要逐帧） */
async function chat(body: unknown): Promise<{
	status: number;
	conversationId?: string;
	raw: string;
}> {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/agent/chat`, {
		method: "POST",
		headers: { ...authHeaders(), Accept: "text/event-stream" },
		body: JSON.stringify(body),
	});
	const raw = await res.text();
	const matched = /"conversationId":"([^"]+)"/.exec(raw);
	return { status: res.status, conversationId: matched?.[1], raw };
}

main()
	.catch((error) => {
		console.error(`✗ 探针异常: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	})
	.finally(() => {
		// main 的 finally 已确认子进程退出；这里再兜一层：没退就不删，别让活进程用着被删的目录
		if (child) {
			console.error(`！子进程未确认退出，保留临时目录以便排查: ${ROOT}`);
			return;
		}
		try {
			rmSync(ROOT, { recursive: true, force: true });
		} catch {
			/* Windows 句柄延迟：留着下轮清 */
		}
	});
