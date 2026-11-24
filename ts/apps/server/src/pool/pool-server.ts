import { Hono, type Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { QueuedRun, RunQueue, TicketEvent } from "./run-queue.ts";
import { parsePoolRoots } from "./run-queue.ts";

/**
 * 池进程的 HTTP 面（设计文档 §5.2 IPC 契约；P2 骨架）。
 *
 * 这一层**不碰 Harness**：`RunQueue` 由装配层（pool-main）注入，单测塞 fake runner。
 * 它能做的事只有三件——鉴权、拼参数、把队列事件翻译成 SSE——全部无状态、可单测。
 *
 * 鉴权口径跟仓库一致：除 `/health` 外全部要 `Authorization: Bearer <token>`，
 * 失败一律 403 **空体**（不区分"没带"和"带错"，不给探测者任何反馈）；
 * `token` 为空串时跳过校验，那是单测 / 本机调试形态，生产必须给。
 *
 * 事件流不自己缓冲：`RunQueue.subscribe` 已做到"先同步回放、再接实时"，
 * 路由层重复做一份就是两套缓冲、两套淘汰规则（`run-queue.ts` 头注释里写明了
 * 这是队列的职责）。这里唯一要处理的是"票到底存不存在"——
 * 队列没有 `has()`，用"快照里的在跑/排队 + 订阅时同步回放"两件事合起来判：
 * 已结算的票缓冲里必有 `settled`，被淘汰的票才真正不存在。
 */

export interface PoolServerDeps {
	queue: RunQueue;
	/** 一次性 token；空串 = 不校验（单测方便，生产必须给） */
	token: string;
	/** 池序号，进 /health */
	poolIndex: number;
	/** 当前 RSS（MB），进 /health；不传就返回 0 */
	rssMb?: () => number;
	/** /run 的 instruction 长度上限（字符数），默认 200_000；超了 400，防一票撑爆池内存 */
	maxInstructionChars?: number;
}

/** 单条 SSE 连接的收尾把手：退订、关流、唤醒路由回调。 */
interface Connection {
	close: () => void;
}

const DEFAULT_MAX_INSTRUCTION_CHARS = 200_000;

const REQUIRED_RUN_FIELDS = ["ticketId", "dir", "workDir", "instruction", "doneWhen"] as const;

export function createPoolServer(deps: PoolServerDeps): { app: Hono; close: () => void } {
	const app = new Hono();
	const maxInstructionChars = deps.maxInstructionChars ?? DEFAULT_MAX_INSTRUCTION_CHARS;
	const connections = new Set<Connection>();
	let closing = false;

	const authorized = (c: Context): boolean =>
		deps.token === "" || c.req.header("Authorization") === `Bearer ${deps.token}`;

	app.get("/health", (c) => {
		const snapshot = deps.queue.snapshot();
		return c.json({
			ok: true,
			poolIndex: deps.poolIndex,
			rssMb: deps.rssMb?.() ?? 0,
			activeTicket: snapshot.activeTicket,
			queued: snapshot.queued,
			finishedTickets: snapshot.finishedTickets,
		});
	});

	app.post("/run", async (c) => {
		if (!authorized(c)) return c.body(null, 403);
		const parsed = parseRun(await readJson(c), maxInstructionChars);
		if (!parsed.ok) {
			return c.json({ ok: false, error: "bad_request", message: parsed.message }, 400);
		}
		const result = deps.queue.enqueue(parsed.run);
		if (result.accepted) {
			return c.json({ accepted: true, ticketId: result.ticketId });
		}
		if (result.reason === "queue_full") {
			return c.json({ accepted: false, error: "queue_full" }, 429);
		}
		return c.json({ accepted: false, error: "duplicate" }, 409);
	});

	app.get("/run/:ticketId/events", (c) => {
		if (!authorized(c)) return c.body(null, 403);
		if (closing) return c.json({ ok: false, error: "closing", message: "池进程正在退出" }, 503);
		const ticketId = c.req.param("ticketId");

		// `subscribe` 先同步回放缓冲：走到下面时 backlog 只含"订阅前已发生"的事件。
		// 因而"票不存在"可以在写任何 SSE 帧之前判定掉，404 是真 JSON 而不是空流。
		const snapshot = deps.queue.snapshot();
		const known = snapshot.activeTicket === ticketId || snapshot.queued.includes(ticketId);
		const backlog: TicketEvent[] = [];
		let push: ((event: TicketEvent) => void) | undefined;
		const unsubscribe = deps.queue.subscribe(ticketId, (event) => {
			if (push) push(event);
			else backlog.push(event);
		});
		if (!known && backlog.length === 0) {
			unsubscribe();
			return c.json({ ok: false, error: "not_found", message: `票 ${ticketId} 不存在` }, 404);
		}

		return streamSSE(c, async (stream) => {
			let closed = false;
			let resolveFinished: () => void = () => {};
			const finished = new Promise<void>((resolve) => {
				resolveFinished = resolve;
			});
			const connection: Connection = { close: () => finish() };
			// 写事件串行化：队列的实时推送与回放可能交错，直接并发写会让 SSE 帧交错。
			let chain: Promise<void> = Promise.resolve();

			function finish(): void {
				if (closed) return;
				closed = true;
				push = undefined;
				unsubscribe();
				connections.delete(connection);
				resolveFinished();
				void safeClose(stream);
			}

			const emit = (event: TicketEvent): void => {
				chain = chain.then(async () => {
					if (closed) return;
					try {
						await stream.writeSSE({ data: JSON.stringify(event) });
					} catch {
						// 客户端断开：静默退订，不让异常冒到进程顶层
						finish();
						return;
					}
					if (event.type === "settled") finish();
				});
				chain.catch(finish);
			};

			connections.add(connection);
			stream.onAbort(finish);
			push = emit;
			for (const event of backlog.splice(0)) emit(event);
			await finished;
		});
	});

	app.post("/run/:ticketId/say", async (c) => {
		if (!authorized(c)) return c.body(null, 403);
		const ticketId = c.req.param("ticketId");
		const parsed = parseSay(await readJson(c));
		if (!parsed.ok) {
			return c.json({ ok: false, error: "bad_request", message: parsed.message }, 400);
		}
		const result = deps.queue.say(ticketId, parsed.text, parsed.mode);
		if (!result.ok) {
			return c.json({ ok: false, message: result.message ?? `票 ${ticketId} 当前不在跑` }, 409);
		}
		return c.json({ ok: true });
	});

	app.post("/run/:ticketId/abort", (c) => {
		if (!authorized(c)) return c.body(null, 403);
		const ticketId = c.req.param("ticketId");
		const result = deps.queue.abort(ticketId);
		if (!result.ok) {
			return c.json({ ok: false, message: result.message ?? `票 ${ticketId} 不在跑也不在队列` }, 409);
		}
		return c.json({ ok: true });
	});

	/** 进程退出前调：逐个关掉活着的 SSE 流（并挡住之后新开的订阅）。 */
	const close = (): void => {
		closing = true;
		for (const connection of [...connections]) connection.close();
	};

	return { app, close };
}

async function safeClose(stream: SSEStreamingApi): Promise<void> {
	try {
		await stream.close();
	} catch {
		// 流已关 / 已断：close 的语义就是"别再来帧了"，失败无需处理
	}
}

/** 请求体必须是 JSON 对象；空体 / 坏 JSON / 数组一律当 null 交给校验器报 400。 */
async function readJson(c: Context): Promise<unknown> {
	return c.req.json().catch(() => null);
}

function parseRun(
	body: unknown,
	maxInstructionChars: number,
): { ok: true; run: QueuedRun } | { ok: false; message: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, message: "body 必须是 JSON 对象" };
	}
	const raw = body as Record<string, unknown>;
	for (const field of REQUIRED_RUN_FIELDS) {
		const value = raw[field];
		if (typeof value !== "string" || value.trim() === "") {
			return { ok: false, message: `${field} 必须是非空字符串` };
		}
	}
	for (const field of ["upstream", "model"] as const) {
		const value = raw[field];
		if (value !== undefined && typeof value !== "string") {
			return { ok: false, message: `${field} 必须是字符串` };
		}
	}
	const tools = raw.tools;
	if (tools !== undefined && (!Array.isArray(tools) || tools.some((item) => typeof item !== "string"))) {
		return { ok: false, message: "tools 必须是字符串数组" };
	}
	const writes = raw.writes;
	if (
		writes !== undefined &&
		(!Array.isArray(writes) ||
			writes.length > 200 ||
			writes.some((item) => typeof item !== "string"))
	) {
		return { ok: false, message: "writes 必须是字符串数组（最多 200 条）" };
	}
	const roots = parsePoolRoots(raw.roots);
	if (!roots.ok) return { ok: false, message: roots.message };
	// 供应商 route：只收 baseUrl + keyEnv 两个字符串。**密钥值不走这条路**——
	// keyEnv 是变量名，池进程从自己的 env 里取。
	let modelRoute: { baseUrl: string; keyEnv: string } | undefined;
	if (raw.modelRoute !== undefined) {
		const route = raw.modelRoute;
		if (!route || typeof route !== "object" || Array.isArray(route)) {
			return { ok: false, message: "modelRoute 必须是对象" };
		}
		const record = route as Record<string, unknown>;
		const baseUrl = record.baseUrl;
		const keyEnv = record.keyEnv;
		if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
			return { ok: false, message: "modelRoute.baseUrl 必须是非空字符串" };
		}
		if (typeof keyEnv !== "string" || keyEnv.trim() === "") {
			return { ok: false, message: "modelRoute.keyEnv 必须是非空字符串" };
		}
		modelRoute = { baseUrl: baseUrl.trim().replace(/\/+$/, ""), keyEnv: keyEnv.trim() };
	}
	const instruction = raw.instruction as string;
	if (instruction.length > maxInstructionChars) {
		return {
			ok: false,
			message: `instruction 超过上限（${instruction.length} > ${maxInstructionChars} 字符）`,
		};
	}
	// 只挑已知字段进队列：请求体里的多余键不进 durable 状态（也不进日志）。
	return {
		ok: true,
		run: {
			ticketId: raw.ticketId as string,
			dir: raw.dir as string,
			workDir: raw.workDir as string,
			instruction,
			doneWhen: raw.doneWhen as string,
			...(typeof raw.upstream === "string" ? { upstream: raw.upstream } : {}),
			...(typeof raw.model === "string" ? { model: raw.model } : {}),
			...(modelRoute ? { modelRoute } : {}),
			...(Array.isArray(tools) ? { tools: tools as string[] } : {}),
			...(Array.isArray(writes) ? { writes: writes as string[] } : {}),
			...(roots.roots ? { roots: roots.roots } : {}),
		},
	};
}

function parseSay(
	body: unknown,
): { ok: true; text: string; mode: "steer" | "followUp" } | { ok: false; message: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, message: "body 必须是 JSON 对象" };
	}
	const raw = body as Record<string, unknown>;
	if (typeof raw.text !== "string" || raw.text.trim() === "") {
		return { ok: false, message: "text 必须是非空字符串" };
	}
	const mode = raw.mode;
	if (mode !== undefined && mode !== "steer" && mode !== "followUp") {
		return { ok: false, message: "mode 只能是 steer 或 followUp" };
	}
	return { ok: true, text: raw.text, mode: mode ?? "steer" };
}