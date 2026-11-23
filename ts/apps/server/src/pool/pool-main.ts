import path from "node:path";
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { serve } from "@hono/node-server";

import { RunQueue, type QueuedRun, type RunHandle, type RunResult, type TicketEvent } from "./run-queue.ts";
import { createPoolServer } from "./pool-server.ts";
import { buildPoolRegistry } from "./pool-tools.ts";
import { buildTaskProfile } from "./task-profile.ts";
import { bashTimeoutSeconds, poolEscalationWaitMs, poolHarnessSettings } from "./pool-settings.ts";
import { createPoolModels, configurePoolModel, poolFauxResponseFactory } from "./pool-models.ts";
import { readWorkerPersona } from "../worker-persona.ts";
// 续行预算 / 无进展保险丝 / REPORT 状态解析：与 native worker 共用同一套纯函数
// （`worker-continue.ts` 是 chancellor 的零 IO 模块，宿主 import 它不破依赖方向）。
import {
	NO_PROGRESS_FUSE,
	buildContinueInput,
	countToolCallsSince,
	markReportBlocked,
	nextNoProgressStreak,
	planNextRound,
} from "../../../../packages/chancellor/src/worker-continue.ts";
import { workerTurnBudget } from "../../../../packages/chancellor/src/escalation-payload.ts";

/**
 * 池进程入口（P2 骨架，设计文档 §4.3 / §5.2 / §5.9）。
 *
 * 一个进程 = 一条长度 1 的队列 + 一个常开 Harness：每票建独立会话、跑完关会话，
 * 下一票来了串行接着跑。HTTP 面在 `pool-server.ts`、队列状态机在 `run-queue.ts`，
 * 这里只做装配：env 读数、storage / models / registry / harness 的接线、续行主循环、优雅退出。
 *
 * 崩溃后**不** resume 半截会话（由宿主按票重派，方案 §4.5）。
 */

const CTX = BACKGROUND_CONTEXT;

const poolIndex = Number(process.env.WORKER_POOL_INDEX ?? 0) || 0;
const dbDir = process.env.WORKER_POOL_DB_DIR?.trim() || ".data/worker-pool";
const token = process.env.WORKER_POOL_TOKEN?.trim() ?? "";
const port = Number(process.env.WORKER_POOL_PORT ?? 0) || 0;

interface CurrentTicket {
	ticketId: string;
	dir: string;
	workDir: string;
	emit: (event: TicketEvent) => void;
	/** escalate 被调用时打个标记：主循环据此进入"等答复"，不接续轮。 */
	noteEscalation: () => void;
}
/** 正在跑的那一票；工具边界、faux 脚本、escalate 出口都靠它取"当前"。 */
let current: CurrentTicket | null = null;

async function main(): Promise<void> {
	if (!token) {
		console.error("[pool] WORKER_POOL_TOKEN 为空：只监听回环、不校验鉴权（仅本机调试）");
	}

	await mkdir(dbDir, { recursive: true });
	const storage = await openNodeSqliteStorage(path.join(dbDir, `pool-${poolIndex}.sqlite`));

	// faux 脚本按票现取 taskDir：工厂里读 current，不能烘焙成启动时的 cwd。
	// `armFaux` 每票开工前重装一次——faux 的 setResponses 不重置 callCount，
	// 跨票复用会让第二票跳到"收尾话"分支（2026-11-22 冒烟实测）。
	const { models, armFaux } = createPoolModels(process.env);

	let currentModel = { provider: "pool-bailian", modelId: "" };
	let currentContextWindow = 131_072;

	const registry = buildPoolRegistry({
		currentDirs: () => (current ? [current.dir, current.workDir] : []),
		bashTimeoutSeconds: bashTimeoutSeconds(process.env),
		submitEscalation: (input) => {
			if (!current) return { ok: false, message: "当前没有在跑的票" };
			current.emit({
				type: "escalation",
				escalation: { ...input, escalationId: randomUUID() },
			});
			// 主循环看到这个标记就停在"等答复"，不自动接续轮（与 native worker 同语义）。
			current.noteEscalation();
			return { ok: true };
		},
	});

	const harness = await Harness.open(
		storage,
		{
			models: () => models,
			registry,
			env: () => new NodeExecutionEnv({ cwd: current?.workDir ?? process.cwd() }),
			// 函数形态：同进程串行跑下一票时按那一票的模型窗口重算，而不是沿用上一票的。
			settings: () =>
				poolHarnessSettings(
					process.env,
					currentContextWindow,
					`${currentModel.provider}/${currentModel.modelId}`,
				),
			onReport: (error, info) => {
				const detail = error instanceof Error ? error.message : String(error);
				console.error(`[pool] ${info.type}: ${detail}`);
			},
		},
		CTX,
	);
	// 刻意不调 harness.resume()：崩溃后由宿主 supervisor 按票重派，见方案 §4.5。

	const runTicket = async (run: QueuedRun, handle: RunHandle): Promise<RunResult> => {
		// 上报等待：escalate 之后这一票不接续轮，等答复（say）到了再继续。
		// 与 native worker 的 stdin 等待同语义，只是通道换成 HTTP/SSE。
		let escalationPending = false;
		let wakeEscalation: (() => void) | null = null;
		current = {
			ticketId: run.ticketId,
			dir: run.dir,
			workDir: run.workDir,
			emit: handle.emit,
			noteEscalation: () => {
				escalationPending = true;
			},
		};
		try {
			// 跨供应商：route 只带 baseUrl + keyEnv，密钥从本进程 env 现读（值不过 HTTP）。
			// 上下文窗口按**这一票的模型**取供应商目录元数据（写死 131072 会让小窗口模型
			// 永远压不到、最后撞 400）。目录读不到才回落 131072。
			const windowModelId =
				(run.model ?? "").trim() ||
				(process.env.CHANCELLOR_LLM_MODEL ?? process.env.LLM_MODEL ?? "deepseek-v4.1-flash").trim();
			currentContextWindow = contextWindowOf(windowModelId);
			currentModel = configurePoolModel(
				models,
				run.model,
				process.env,
				run.modelRoute,
				currentContextWindow,
			);
			// faux 自测：每票换一份新脚本（步数从 1 起）。
			armFaux?.(poolFauxResponseFactory(() => run.dir));

			const profile = buildTaskProfile({
				persona: readWorkerPersona(process.env),
				instruction: run.instruction,
				doneWhen: run.doneWhen,
				...(run.upstream ? { upstream: run.upstream } : {}),
				taskDir: run.dir,
				workDir: run.workDir,
			});

			// 工具面（2026-11-22）：宿主把 worker 勾选（canonical 四件）随票带下来。
			// 没带 = 池默认五件全开（旧行为）；带了就按交集，但 escalate 恒开——
			// 它是池工人的上报 / 等答复通道，不能被“取消勾选”掉。
			const wanted = Array.isArray(run.tools) ? new Set(run.tools) : null;
			const registrations = registry
				.snapshot()
				.tools()
				.map((entry) => entry.tool)
				.filter(
					(tool) =>
						profile.tools.includes(tool.name) &&
						(wanted === null || wanted.has(tool.name) || tool.name === "escalate"),
				);

			const conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: currentModel, tools: registrations, instructions: profile.systemPrompt },
				},
				CTX,
			);

			const submitAndWait = async (content: string, whenBusy?: "steer" | "followUp"): Promise<void> => {
				const submission = await conversation.submit(
					whenBusy === undefined
						? { type: "input", content }
						: { type: "input", content, whenBusy },
					CTX,
				);
				await submission.wait(CTX);
			};

			const first = submitAndWait("开始");

			// 插话走队列 → runTicket 的 onSay → 同一会话（steer 打断当前输出 / followUp 排后面）。
			// 上报等待中的第一条消息即答复：解除等待，主循环接着判断要不要续轮。
			handle.onSay((text, mode) => {
				if (escalationPending) {
					escalationPending = false;
					wakeEscalation?.();
					wakeEscalation = null;
				}
				void conversation
					.submit({ type: "input", content: text, whenBusy: mode }, CTX)
					.catch((error: unknown) => {
						console.error(
							`[pool] 插话没有进会话: ${error instanceof Error ? error.message : String(error)}`,
						);
					});
			});

			handle.signal.addEventListener(
				"abort",
				() => {
					wakeEscalation?.();
					wakeEscalation = null;
					void conversation.abort(CTX).catch(() => undefined);
				},
				{ once: true },
			);

			await first;

			// ── 续行主循环（与 native worker 同口径，2026-11-22 P6）─────────
			// 上报等待中：不接续轮；答复（say）或 abort 唤醒后再判断。
			// 2026-11-23 M4：等待有上限（默认 10 分钟）。超时把 REPORT 改 blocked 后正常退场，
			// 槽位让给下一票；人回来在任务线程回话走宿主既有 resume 链路续跑。
			const maxBudget = workerTurnBudget(process.env);
			const escalationWaitMs = poolEscalationWaitMs(process.env);
			let usedBudget = 0;
			let noProgressStreak = 0;
			while (true) {
				if (handle.signal.aborted) break;
				if (escalationPending) {
					console.log(`[pool] ticket=${run.ticketId} 上报等待答复中`);
					const timedOut = await new Promise<boolean>((resolve) => {
						let settled = false;
						let timer: NodeJS.Timeout | null = null;
						const finish = (value: boolean): void => {
							if (settled) return;
							settled = true;
							if (timer !== null) clearTimeout(timer);
							resolve(value);
						};
						wakeEscalation = () => finish(false);
						if (escalationWaitMs > 0) {
							timer = setTimeout(() => finish(true), escalationWaitMs);
							timer.unref?.();
						}
						if (handle.signal.aborted) finish(false);
					});
					if (timedOut) {
						escalationPending = false;
						ensureBlockedReport(
							run.dir,
							`等待答复超过 ${Math.round(escalationWaitMs / 60_000)} 分钟，已释放池槽位；回答后从任务线程续跑。`,
						);
						console.log(`[pool] ticket=${run.ticketId} 上报等待超时，已释放槽位`);
						break;
					}
					continue;
				}
				const report = readReportJson(run.dir);
				const decision = planNextRound({
					reportStatus: report.status,
					usedBudget,
					maxBudget,
					noProgressStreak,
				});
				if (decision.kind === "stop") {
					if (decision.reason === "fuse") {
						markReportBlocked(
							run.dir,
							`续行保险丝触发：连续 ${NO_PROGRESS_FUSE} 个续行轮没有一次工具调用，停止续行（需要人接管）。`,
						);
						console.log(`[pool] ticket=${run.ticketId} 续行保险丝触发，REPORT 已改 blocked`);
					} else if (decision.reason === "budget") {
						console.log(`[pool] ticket=${run.ticketId} 续行预算用尽（${usedBudget}/${maxBudget}）`);
					}
					break;
				}
				usedBudget += 1;
				const before = (await conversation.context(CTX)).messages.length;
				await submitAndWait(buildContinueInput(usedBudget, report.summary), "followUp");
				const messages = (await conversation.context(CTX)).messages;
				noProgressStreak = nextNoProgressStreak(
					noProgressStreak,
					countToolCallsSince(messages, before),
				);
				console.log(
					`[pool] ticket=${run.ticketId} 续行轮 ${usedBudget}/${maxBudget} 无进展连击=${noProgressStreak}`,
				);
			}

			// 读 REPORT 发给宿主；正文只进事件与宿主日志，这里只记字数。
			const reportPath = path.join(run.dir, "REPORT.md");
			const raw = await readFileOrNull(reportPath);
			if (raw !== null) handle.emit({ type: "report", raw });
			console.log(
				`[pool] ticket=${run.ticketId} settled report=${raw === null ? "missing" : `${raw.length}字`}`,
			);
			return { ok: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[pool] ticket=${run.ticketId} failed: ${message.slice(0, 200)}`);
			return { ok: false, reason: message.slice(0, 200) };
		} finally {
			current = null;
		}
	};

	const queue = new RunQueue({
		runTicket,
		maxQueue: Number(process.env.WORKER_POOL_QUEUE_MAX ?? 64) || 64,
	});
	const { app, close } = createPoolServer({
		queue,
		token,
		poolIndex,
		rssMb: () => Math.round(process.memoryUsage().rss / 1048576),
	});

	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
		process.stdout.write(`[pool] ready port=${info.port} index=${poolIndex}\n`);
	});

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[pool] ${signal} 收到，收尾退出`);
		try {
			close();
			server.close();
			await harness.close(CTX);
		} catch (error) {
			console.error(`[pool] 关闭失败: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));

	// 孤儿保护：宿主被强杀（Windows 上 taskkill / 壳崩溃很常见）时子进程不会自动退出，
	// 池进程会一直占着 pool-<n>.sqlite。每 5 秒确认父进程还在，父没了立即自退
	// （与 worker-main 的 parentAlive 同口径）。
	const parentWatch = setInterval(() => {
		try {
			if (process.ppid <= 0) throw new Error("no parent");
			process.kill(process.ppid, 0);
		} catch {
			clearInterval(parentWatch);
			void shutdown("parent-gone");
		}
	}, 5_000);
	parentWatch.unref?.();
}

/**
 * 这一票模型的上下文窗口（读 `.data/providers.json` 的 `modelMeta`）。
 *
 * 池进程 cwd 可能是 `apps/server`（桌面壳）也可能是 `ts/`（手工起），三种落点都试。
 * 读不到 / 模型未登记 → 回落 131072（与宿主 `CUSTOM_CONTEXT_WINDOW` 同值）。
 * 缓存一次：同一池进程里 providers.json 不会每票变。
 */
let contextCatalog: Array<Record<string, unknown>> | null = null;

function contextWindowOf(modelId: string): number {
	if (contextCatalog === null) {
		contextCatalog = [];
		for (const candidate of [
			".data/providers.json",
			"apps/server/.data/providers.json",
			"../.data/providers.json",
		]) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
				const list = Array.isArray(parsed)
					? parsed
					: (parsed as { providers?: unknown })?.providers;
				if (Array.isArray(list)) {
					contextCatalog = list as Array<Record<string, unknown>>;
					break;
				}
			} catch {
				// 试下一个落点
			}
		}
	}
	for (const entry of contextCatalog) {
		const metas = entry.modelMeta as Record<string, { contextWindow?: unknown }> | undefined;
		const window = metas?.[modelId]?.contextWindow;
		if (typeof window === "number" && Number.isFinite(window) && window > 0) return window;
	}
	return 131_072;
}

async function readFileOrNull(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * 读 REPORT.md 的第一个 ```json 块，取 status / summary。
 * 读不到 / 没有 json 块 → `{status:null, summary:null}`（续行判定把 null 当"还想干"，
 * 与 worker-continue 的 `planNextRound` 同口径）。
 */
function readReportJson(taskDir: string): { status: string | null; summary: string | null } {
	try {
		const raw = readFileSync(path.join(taskDir, "REPORT.md"), "utf8");
		const match = /```json\s*([\s\S]*?)```/i.exec(raw);
		if (!match?.[1]) return { status: null, summary: null };
		const data = JSON.parse(match[1]) as { status?: unknown; summary?: unknown };
		return {
			status: typeof data.status === "string" ? (data.status === "done" ? "ready" : data.status) : null,
			summary: typeof data.summary === "string" ? data.summary : null,
		};
	} catch {
		return { status: null, summary: null };
	}
}

/**
 * 上报等待超时：把结论改成 blocked 后正常退场（2026-11-23 M4）。
 *
 * 有合法 REPORT 就沿用 `markReportBlocked` 保留 worker 写的 summary/artifacts；
 * 没有 REPORT（worker 上报后还没写交付物）就补一份最小 blocked 报告——
 * 不能让调度层把"等待超时"误判成 report_missing 失败。
 */
function ensureBlockedReport(taskDir: string, note: string): void {
	const existing = readReportJson(taskDir);
	if (existing.status !== null) {
		markReportBlocked(taskDir, note);
		return;
	}
	const json = JSON.stringify(
		{
			status: "blocked",
			summary: note,
			artifacts: [],
			attention: {
				kind: "need_input",
				question: "任务在等你的答复；回答后从任务线程继续。",
			},
		},
		null,
		2,
	);
	try {
		writeFileSync(path.join(taskDir, "REPORT.md"), `## 结论\n\n${note}\n\n\`\`\`json\n${json}\n\`\`\`\n`, "utf8");
	} catch {
		// 写不进去就按原 REPORT 结论走；不能因为兜底报告让池进程崩掉。
	}
}

main().catch((error: unknown) => {
	console.error(
		`[pool] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
	);
	process.exitCode = 1;
});