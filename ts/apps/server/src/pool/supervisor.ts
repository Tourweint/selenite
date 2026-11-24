import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";

import type { TicketEvent, QueuedRun } from "./run-queue.ts";
import {
	backoffDelayMs,
	DEFAULT_SUPERVISOR_CONFIG,
	parseReadyLine,
	pickIdleSlot,
	recycleReason,
	runTimeoutReason,
	slotOfTicket,
	type SlotState,
	type SupervisorConfig,
} from "./supervisor-core.ts";

/**
 * 宿主侧的池进程管理器（P2 骨架 G2，设计文档 §5.3）。
 *
 * 起进程、等 ready、POST 票、转 SSE、探心跳、回收、崩溃重拉。判断逻辑全在
 * `supervisor-core.ts`，这里只做动作。不 import `pool-main.ts`（会立刻执行），
 * 只按路径起进程；也不碰 Harness / chancellor。
 *
 * 硬规则：SSE 断开且没收到 settled = 这票失败，槽位进程要杀（方案 §八.4）。
 */

export interface PoolRunResult {
	ok: boolean;
	reason: string;
	/** 实际跑这票的池序号 */
	poolIndex: number | null;
}

export interface PoolClient {
	run(
		run: QueuedRun,
		onEvent: (event: TicketEvent) => void,
		signal?: AbortSignal,
	): Promise<PoolRunResult>;
	say(
		ticketId: string,
		text: string,
		mode?: "steer" | "followUp",
	): Promise<{ ok: boolean; message?: string }>;
	abort(ticketId: string): Promise<{ ok: boolean; message?: string }>;
	snapshot(): { slots: readonly SlotState[]; running: string[] };
}

export interface ChildLike {
	pid?: number;
	stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
	stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
	on(event: string, cb: (...args: unknown[]) => void): void;
	kill(signal?: string): boolean;
}

export interface SupervisorOptions {
	config?: Partial<SupervisorConfig>;
	/** 池进程入口（默认 <repo>/ts/apps/server/src/pool/pool-main.ts，用 tsx 跑） */
	entryPath?: string;
	/** 库目录（默认 .data/worker-pool） */
	dbDir?: string;
	/** 观测文件（默认 .data/worker-pool.jsonl） */
	logPath?: string;
	/** 可注入，测试用 */
	spawn?: (index: number, env: Record<string, string>) => ChildLike;
	fetchFn?: typeof fetch;
	now?: () => number;
	/** 池进程 stdout/stderr 行（默认 console.error） */
	onLog?: (line: string) => void;
}

const READY_TIMEOUT_MS = 30_000;
const IDLE_POLL_MS = 200;
const IDLE_WAIT_LIMIT_MS = 10 * 60_000;
const HEALTH_INTERVAL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 10_000;
const ABORT_SETTLE_GRACE_MS = 10_000;
const RECYCLE_KILL_GRACE_MS = 3_000;
const STOP_GRACE_MS = 3_000;
/**
 * 单票超时（M2a，2026-11-22）：池内一票以前没有任何单票超时，可以无限跑。
 * 默认值只在这里给；env 写 0 / 负数 = 该项不限（CHANCELLOR_WORKER_{IDLE,MAX}_MS）。
 * 判定不能挂在 15s 的心跳间隔上：静默 10 分钟的误杀窗口会抖到 10 分 15 秒。
 */
const RUN_IDLE_TIMEOUT_MS = 10 * 60_000;
const RUN_MAX_TIMEOUT_MS = 60 * 60_000;
const RUN_TIMEOUT_POLL_MS = 1_000;

type ObservationKind = "spawn" | "ready" | "recycle" | "crash" | "dispatch" | "settle";

interface Observation {
	kind: ObservationKind;
	poolIndex: number;
	ticketId?: string;
	reason?: string;
	rssMb?: number;
}

interface SlotRuntime extends SlotState {
	child: ChildLike | null;
	ready: boolean;
	failures: number;
	launching: boolean;
	recycling: boolean;
	readyTimer: ReturnType<typeof setTimeout> | null;
	restartTimer: ReturnType<typeof setTimeout> | null;
	/** 主动杀进程时记下原因，交给 exit 观测用 */
	exitReason: string | null;
	readyWaiters: Array<() => void>;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function unref(timer: ReturnType<typeof setTimeout>): void {
	(timer as { unref?: () => void }).unref?.();
}

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 超时类 env：0 / 负数本身是"不限"的合法写法，不能像 envNumber 那样当坏值回落默认。
 * 只有空值或非数字才回落默认。
 */
function envTimeoutNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

/**
 * 池大小 env：`WORKER_POOL_SIZE` 优先，旧名 `SUPERVISOR_POOL_SIZE` 仍兼容，都没有用 fallback。
 */
function envPoolSize(fallback: number): number {
	const primary = process.env.WORKER_POOL_SIZE;
	const legacy = process.env.SUPERVISOR_POOL_SIZE;
	const raw = primary !== undefined && primary.trim() !== "" ? primary : legacy;
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function resolveConfig(overrides?: Partial<SupervisorConfig>): SupervisorConfig {
	const base = DEFAULT_SUPERVISOR_CONFIG;
	return {
		poolSize: Math.max(1, Math.floor(overrides?.poolSize ?? envPoolSize(base.poolSize))),
		recycleTickets: Math.max(
			1,
			Math.floor(overrides?.recycleTickets ?? envNumber("SUPERVISOR_RECYCLE_TICKETS", base.recycleTickets)),
		),
		rssLimitMb: Math.max(0, overrides?.rssLimitMb ?? envNumber("SUPERVISOR_RSS_LIMIT_MB", base.rssLimitMb)),
		backoffBaseMs: Math.max(
			0,
			overrides?.backoffBaseMs ?? envNumber("SUPERVISOR_BACKOFF_BASE_MS", base.backoffBaseMs),
		),
		backoffMaxMs: Math.max(
			0,
			overrides?.backoffMaxMs ?? envNumber("SUPERVISOR_BACKOFF_MAX_MS", base.backoffMaxMs),
		),
		heartbeatTimeoutMs: Math.max(
			0,
			overrides?.heartbeatTimeoutMs ?? envNumber("SUPERVISOR_HEARTBEAT_TIMEOUT_MS", base.heartbeatTimeoutMs),
		),
	};
}

function defaultEntryPath(): string {
	const cwd = process.cwd();
	// 三种真实启动 cwd 都要认（2026-11-22 实测：桌面壳把 cwd 设成 `ts/apps/server`，
	// 旧逻辑会拼出 `ts/apps/server/apps/server/...` 这个不存在的路径 → 池一票都起不来）：
	//   - 仓库根：      cwd/ts/apps/server/src/pool/pool-main.ts
	//   - ts/：         cwd/apps/server/src/pool/pool-main.ts
	//   - apps/server： cwd/src/pool/pool-main.ts   ← 桌面壳
	const candidates = [
		path.resolve(cwd, "ts/apps/server/src/pool/pool-main.ts"),
		path.resolve(cwd, "apps/server/src/pool/pool-main.ts"),
		path.resolve(cwd, "src/pool/pool-main.ts"),
	];
	return candidates.find((file) => existsSync(file)) ?? candidates[2]!;
}

function defaultSpawn(entryPath: string, env: Record<string, string>): ChildLike {
	const child = nodeSpawn(process.execPath, ["--import", "tsx", entryPath], {
		env: { ...process.env, ...env },
		stdio: "pipe",
		windowsHide: true,
	});
	return child as unknown as ChildLike;
}

function makeSlot(index: number): SlotRuntime {
	return {
		index,
		pid: null,
		port: null,
		finishedTickets: 0,
		rssMb: null,
		ticketId: null,
		lastSeenAt: 0,
		child: null,
		ready: false,
		failures: 0,
		launching: false,
		recycling: false,
		readyTimer: null,
		restartTimer: null,
		exitReason: null,
		readyWaiters: [],
	};
}

function describeExit(code: unknown, signal: unknown): string {
	if (typeof signal === "string" && signal !== "") return `signal=${signal}`;
	if (typeof code === "number") return `code=${code}`;
	return "exit_unknown";
}

function optionalNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRunBody(run: QueuedRun): Record<string, unknown> {
	const body: Record<string, unknown> = {
		ticketId: run.ticketId,
		dir: run.dir,
		workDir: run.workDir,
		instruction: run.instruction,
		doneWhen: run.doneWhen,
	};
	if (run.upstream !== undefined) body.upstream = run.upstream;
	if (run.model !== undefined) body.model = run.model;
	if (run.modelRoute !== undefined) body.modelRoute = run.modelRoute;
	if (run.tools !== undefined) body.tools = run.tools;
	if (run.writes !== undefined) body.writes = run.writes;
	if (run.roots !== undefined) body.roots = run.roots;
	return body;
}

/** 解析一帧 SSE 的 `data:` 内容；非事件帧返回 null。 */
function parseEventFrame(frame: string): TicketEvent | null {
	let data = "";
	for (const line of frame.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const value = line.slice(5).replace(/^ /, "");
		data = data === "" ? value : `${data}\n${value}`;
	}
	if (data === "") return null;
	try {
		const parsed = JSON.parse(data) as TicketEvent;
		if (parsed === null || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

export class WorkerPoolSupervisor implements PoolClient {
	private readonly config: SupervisorConfig;
	private readonly token: string;
	private readonly entryPath: string;
	private readonly dbDir: string;
	private readonly logPath: string;
	private readonly spawnFn: (index: number, env: Record<string, string>) => ChildLike;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private readonly onLog: (line: string) => void;
	private readonly slots: SlotRuntime[];
	/** 单票空闲 / 最大超时；<= 0 = 该项不限 */
	private readonly runIdleTimeoutMs: number;
	private readonly runMaxTimeoutMs: number;

	private stopping = false;
	private logChain: Promise<void> = Promise.resolve();
	private logDirReady: Promise<void> | null = null;

	constructor(options: SupervisorOptions = {}) {
		this.config = resolveConfig(options.config);
		this.token = randomUUID();
		this.entryPath = options.entryPath ?? defaultEntryPath();
		this.dbDir = path.resolve(
			process.cwd(),
			// 探针 / 多实例隔离用（2026-11-23）：默认仍是 .data/worker-pool。
			options.dbDir ?? process.env.WORKER_POOL_DB_DIR?.trim() ?? ".data/worker-pool",
		);
		this.logPath = path.resolve(process.cwd(), options.logPath ?? ".data/worker-pool.jsonl");
		this.spawnFn = options.spawn ?? ((_index, env) => defaultSpawn(this.entryPath, env));
		this.fetchFn = options.fetchFn ?? fetch;
		this.now = options.now ?? Date.now;
		this.onLog = options.onLog ?? ((line) => console.error(line));
		this.runIdleTimeoutMs = envTimeoutNumber("CHANCELLOR_WORKER_IDLE_MS", RUN_IDLE_TIMEOUT_MS);
		this.runMaxTimeoutMs = envTimeoutNumber("CHANCELLOR_WORKER_MAX_MS", RUN_MAX_TIMEOUT_MS);
		this.slots = Array.from({ length: this.config.poolSize }, (_, index) => makeSlot(index));
	}

	/**
	 * 这个部署能不能跑池：池进程入口是**源码 `.ts`**（用 `node --import tsx` 起），
	 * 所以 `dist` 单文件产物里跑不了。入口不存在 = 不能跑，宿主据此**不注入 PoolClient**；
	 * 2026-11-23 native 退役后，这一态下单票会如实报「池执行器未接线」
	 * （不把单子派进一个起不来的进程）。
	 */
	available(): boolean {
		return existsSync(this.entryPath);
	}

	/** 按需拉起：确保 poolSize 个进程都 ready（幂等） */
	async start(): Promise<void> {
		if (this.stopping) return;
		await Promise.all(this.slots.map((slot) => this.ensureSlotReady(slot)));
	}

	async run(
		run: QueuedRun,
		onEvent: (event: TicketEvent) => void,
		signal?: AbortSignal,
	): Promise<PoolRunResult> {
		await this.start();
		const deadline = this.now() + IDLE_WAIT_LIMIT_MS;
		for (;;) {
			if (this.stopping) return { ok: false, reason: "supervisor_stopped", poolIndex: null };
			if (signal?.aborted) return { ok: false, reason: "aborted", poolIndex: null };

			const slot = pickIdleSlot(this.slots, this.config) as SlotRuntime | null;
			if (slot === null) {
				if (this.now() >= deadline) return { ok: false, reason: "no_idle_slot", poolIndex: null };
				await sleep(IDLE_POLL_MS);
				this.pumpMissingSlots();
				continue;
			}

			// 先绑定再 await，避免并发 run() 抢到同一个槽位。
			slot.ticketId = run.ticketId;
			this.observe({ kind: "dispatch", poolIndex: slot.index, ticketId: run.ticketId });

			const outcome = await this.dispatch(slot, run, onEvent, signal);
			if (!outcome.retry) return outcome.result;
			if (this.now() >= deadline) return { ok: false, reason: "no_idle_slot", poolIndex: null };
			await sleep(IDLE_POLL_MS);
			this.pumpMissingSlots();
		}
	}

	async say(
		ticketId: string,
		text: string,
		mode: "steer" | "followUp" = "steer",
	): Promise<{ ok: boolean; message?: string }> {
		const slot = slotOfTicket(this.slots, ticketId) as SlotRuntime | null;
		if (slot === null || slot.port === null) {
			return { ok: false, message: `票 ${ticketId} 不在跑` };
		}
		return this.postJson(`http://127.0.0.1:${slot.port}/run/${encodeURIComponent(ticketId)}/say`, {
			ticketId,
			text,
			mode,
		});
	}

	async abort(ticketId: string): Promise<{ ok: boolean; message?: string }> {
		const slot = slotOfTicket(this.slots, ticketId) as SlotRuntime | null;
		if (slot === null || slot.port === null) {
			return { ok: false, message: `票 ${ticketId} 不在跑` };
		}
		return this.postJson(`http://127.0.0.1:${slot.port}/run/${encodeURIComponent(ticketId)}/abort`, {
			ticketId,
		});
	}

	snapshot(): { slots: readonly SlotState[]; running: string[] } {
		const slots: SlotState[] = this.slots.map((slot) => ({
			index: slot.index,
			pid: slot.pid,
			port: slot.port,
			finishedTickets: slot.finishedTickets,
			rssMb: slot.rssMb,
			ticketId: slot.ticketId,
			lastSeenAt: slot.lastSeenAt,
		}));
		const running = this.slots
			.map((slot) => slot.ticketId)
			.filter((ticketId): ticketId is string => ticketId !== null);
		return { slots, running };
	}

	/** 停所有进程（SIGTERM，给 3 秒再 SIGKILL） */
	async stop(): Promise<void> {
		this.stopping = true;
		for (const slot of this.slots) {
			if (slot.readyTimer !== null) {
				clearTimeout(slot.readyTimer);
				slot.readyTimer = null;
			}
			if (slot.restartTimer !== null) {
				clearTimeout(slot.restartTimer);
				slot.restartTimer = null;
			}
			const child = slot.child;
			if (child !== null) {
				try {
					child.kill("SIGTERM");
				} catch {
					// 已退出
				}
			}
			this.resolveReady(slot);
		}
		await sleep(STOP_GRACE_MS);
		for (const slot of this.slots) {
			const child = slot.child;
			if (child !== null) {
				try {
					child.kill("SIGKILL");
				} catch {
					// 已退出
				}
			}
		}
		for (const slot of this.slots) {
			slot.child = null;
			slot.pid = null;
			slot.port = null;
			slot.ready = false;
			slot.launching = false;
			slot.recycling = false;
			slot.rssMb = null;
		}
	}

	// ---- 进程生命周期 -------------------------------------------------------

	private async ensureSlotReady(slot: SlotRuntime): Promise<void> {
		if (slot.ready && slot.child !== null) return;
		if (slot.child === null && slot.restartTimer === null && !this.stopping) {
			this.launch(slot);
		}
		if (slot.ready) return;
		await new Promise<void>((resolve) => {
			slot.readyWaiters.push(resolve);
		});
	}

	private resolveReady(slot: SlotRuntime): void {
		for (const resolve of slot.readyWaiters.splice(0)) resolve();
	}

	private launch(slot: SlotRuntime): void {
		if (this.stopping || slot.launching || slot.child !== null) return;
		slot.launching = true;
		slot.ready = false;
		slot.port = null;
		slot.lastSeenAt = 0;
		slot.rssMb = null;
		slot.finishedTickets = 0;
		slot.recycling = false;

		let child: ChildLike;
		try {
			child = this.spawnFn(slot.index, {
				WORKER_POOL_INDEX: String(slot.index),
				WORKER_POOL_DB_DIR: this.dbDir,
				WORKER_POOL_TOKEN: this.token,
				WORKER_POOL_PORT: "0",
			});
		} catch {
			slot.launching = false;
			slot.failures += 1;
			slot.exitReason = null;
			this.observe({ kind: "crash", poolIndex: slot.index, reason: "spawn_error" });
			this.scheduleRestart(slot);
			return;
		}

		slot.child = child;
		this.observe({ kind: "spawn", poolIndex: slot.index });

		const wire = (stream: "out" | "err") => {
			const decoder = new StringDecoder("utf8");
			let buffer = "";
			return (chunk: Buffer | string): void => {
				buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline).replace(/\r$/, "");
					buffer = buffer.slice(newline + 1);
					this.handleLine(slot, child, line, stream);
				}
			};
		};
		child.stdout?.on("data", wire("out"));
		child.stderr?.on("data", wire("err"));

		child.on("exit", (code, signal) => this.handleExit(slot, child, code, signal));
		child.on("error", (_error) => this.handleChildError(slot, child));

		slot.readyTimer = setTimeout(() => {
			slot.readyTimer = null;
			if (slot.child === child && !slot.ready) {
				slot.exitReason = "ready_timeout";
				this.observe({ kind: "crash", poolIndex: slot.index, reason: "ready_timeout" });
				try {
					child.kill("SIGKILL");
				} catch {
					// 已退出
				}
			}
		}, READY_TIMEOUT_MS);
		unref(slot.readyTimer);
	}

	private handleLine(slot: SlotRuntime, child: ChildLike, line: string, _stream: "out" | "err"): void {
		try {
			this.onLog(line);
		} catch {
			// 日志回调不能反噬监督者
		}
		if (slot.child !== child) return;
		const ready = parseReadyLine(line);
		if (ready === null) return;
		slot.port = ready.port;
		slot.pid = child.pid ?? null;
		slot.ready = true;
		slot.launching = false;
		slot.failures = 0;
		slot.lastSeenAt = this.now();
		if (slot.readyTimer !== null) {
			clearTimeout(slot.readyTimer);
			slot.readyTimer = null;
		}
		this.observe({ kind: "ready", poolIndex: slot.index });
		this.resolveReady(slot);
	}

	private handleExit(slot: SlotRuntime, child: ChildLike, code: unknown, signal: unknown): void {
		if (slot.child !== child) return;
		this.detachChild(slot);
		if (this.stopping) return;
		if (slot.recycling) {
			slot.recycling = false;
			this.launch(slot);
			return;
		}
		slot.failures += 1;
		const reason = slot.exitReason ?? describeExit(code, signal);
		slot.exitReason = null;
		this.observe({ kind: "crash", poolIndex: slot.index, reason });
		this.scheduleRestart(slot);
	}

	private handleChildError(slot: SlotRuntime, child: ChildLike): void {
		if (slot.child !== child) return;
		this.detachChild(slot);
		if (this.stopping) return;
		slot.failures += 1;
		slot.exitReason = null;
		this.observe({ kind: "crash", poolIndex: slot.index, reason: "spawn_error" });
		this.scheduleRestart(slot);
	}

	private detachChild(slot: SlotRuntime): void {
		if (slot.readyTimer !== null) {
			clearTimeout(slot.readyTimer);
			slot.readyTimer = null;
		}
		slot.child = null;
		slot.pid = null;
		slot.port = null;
		slot.ready = false;
		slot.launching = false;
		slot.rssMb = null;
	}

	private scheduleRestart(slot: SlotRuntime): void {
		if (this.stopping || slot.restartTimer !== null) return;
		const delay = backoffDelayMs(this.config, slot.failures);
		slot.restartTimer = setTimeout(() => {
			slot.restartTimer = null;
			this.launch(slot);
		}, delay);
		unref(slot.restartTimer);
	}

	/** 等待空闲槽位期间，把既没子进程也没重拉定时器的槽位补起来。 */
	private pumpMissingSlots(): void {
		if (this.stopping) return;
		for (const slot of this.slots) {
			if (slot.child === null && slot.restartTimer === null && !slot.launching) {
				this.launch(slot);
			}
		}
	}

	private killSlot(slot: SlotRuntime, reason: string): void {
		const child = slot.child;
		if (child === null) return;
		slot.exitReason = reason;
		try {
			child.kill("SIGKILL");
		} catch {
			// 已退出
		}
	}

	private recycleSlot(slot: SlotRuntime, reason: "tickets" | "rss" | "heartbeat"): void {
		const child = slot.child;
		if (child === null) return;
		this.observe({
			kind: "recycle",
			poolIndex: slot.index,
			reason,
			...(slot.rssMb !== null ? { rssMb: slot.rssMb } : {}),
		});
		slot.recycling = true;
		try {
			child.kill(reason === "heartbeat" ? "SIGKILL" : "SIGTERM");
		} catch {
			// 已退出；exit 事件会接手重拉
		}
		const escalation = setTimeout(() => {
			if (slot.child === child) {
				try {
					child.kill("SIGKILL");
				} catch {
					// 已退出
				}
			}
		}, RECYCLE_KILL_GRACE_MS);
		unref(escalation);
	}

	private recycleIdleSlots(): void {
		const now = this.now();
		for (const slot of this.slots) {
			if (this.stopping || slot.child === null) continue;
			const reason = recycleReason(slot, this.config, now);
			if (reason !== null) this.recycleSlot(slot, reason);
		}
	}

	// ---- 派票 --------------------------------------------------------------

	private async dispatch(
		slot: SlotRuntime,
		run: QueuedRun,
		onEvent: (event: TicketEvent) => void,
		signal?: AbortSignal,
	): Promise<{ retry: true } | { retry: false; result: PoolRunResult }> {
		const ticketId = run.ticketId;
		const port = slot.port;
		if (port === null) {
			this.release(slot, ticketId);
			this.killSlot(slot, "no_port");
			return { retry: true };
		}

		const posted = await this.postRun(port, run, signal);
		if (posted === "aborted") {
			await this.postAbort(port, ticketId);
			this.release(slot, ticketId);
			this.killSlot(slot, "aborted");
			return { retry: false, result: { ok: false, reason: "aborted", poolIndex: slot.index } };
		}
		if (posted === "duplicate") {
			this.release(slot, ticketId);
			return { retry: false, result: { ok: false, reason: "duplicate", poolIndex: slot.index } };
		}
		if (posted === "busy") {
			// 429：换槽重试
			this.release(slot, ticketId);
			return { retry: true };
		}
		if (posted !== "ok") {
			this.release(slot, ticketId);
			this.killSlot(slot, posted);
			return { retry: true };
		}

		const result = await this.followEvents(slot, ticketId, onEvent, signal);
		return { retry: false, result };
	}

	/** 返回 "ok" / "busy"(429) / "duplicate"(409) / "aborted" / 其他失败原因 */
	private async postRun(port: number, run: QueuedRun, callerSignal?: AbortSignal): Promise<string> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
		unref(timer);
		const onAbort = (): void => controller.abort();
		callerSignal?.addEventListener("abort", onAbort, { once: true });
		try {
			const res = await this.fetchFn(`http://127.0.0.1:${port}/run`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(toRunBody(run)),
				signal: controller.signal,
			});
			if (res.status === 429) return "busy";
			if (res.status === 409) return "duplicate";
			if (!res.ok) return `http_${res.status}`;
			return "ok";
		} catch {
			return callerSignal?.aborted ? "aborted" : "run_post_failed";
		} finally {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onAbort);
		}
	}

	private async followEvents(
		slot: SlotRuntime,
		ticketId: string,
		onEvent: (event: TicketEvent) => void,
		callerSignal?: AbortSignal,
	): Promise<PoolRunResult> {
		const port = slot.port;
		if (port === null) {
			this.release(slot, ticketId);
			this.killSlot(slot, "no_port");
			return { ok: false, reason: "stream_closed", poolIndex: slot.index };
		}

		const controller = new AbortController();
		let abortTimer: ReturnType<typeof setTimeout> | null = null;
		const onAbort = (): void => {
			void this.postAbort(port, ticketId);
			if (abortTimer === null) {
				abortTimer = setTimeout(() => controller.abort(), ABORT_SETTLE_GRACE_MS);
				unref(abortTimer);
			}
		};
		if (callerSignal?.aborted) onAbort();
		else callerSignal?.addEventListener("abort", onAbort, { once: true });

		const healthTimer = setInterval(() => {
			void this.probeHealth(slot);
		}, HEALTH_INTERVAL_MS);
		unref(healthTimer);

		let settled: { ok: boolean; reason: string } | null = null;
		let cancelReader: (() => void) | null = null;

		// 单票超时（M2a）：池内一票以前没有单票上限。每来一条 SSE 事件都算活动
		// （progress / escalation / report / settled），lastActivityAt 据此顺延；
		// 判定放在 1s 的轮询里，不能用 15s 的健康心跳当节拍（超时窗口会抖）。
		const startedAt = this.now();
		let lastActivityAt = startedAt;
		let timedOut = false;
		let timeoutTimer: ReturnType<typeof setInterval> | null = null;
		let graceTimer: ReturnType<typeof setTimeout> | null = null;
		if (this.runIdleTimeoutMs > 0 || this.runMaxTimeoutMs > 0) {
			timeoutTimer = setInterval(() => {
				// 调用方已经取消时不再判超时：取消语义走既有 aborted / 断流分支，不抢它的账。
				if (timedOut || settled !== null || callerSignal?.aborted === true) return;
				const reason = runTimeoutReason({
					startedAt,
					lastActivityAt,
					now: this.now(),
					idleMs: this.runIdleTimeoutMs,
					maxMs: this.runMaxTimeoutMs,
				});
				if (reason === null) return;
				if (timeoutTimer !== null) {
					clearInterval(timeoutTimer);
					timeoutTimer = null;
				}
				timedOut = true;
				// 先按正常取消请 worker 自己收尾；宽限期内还不 settled，
				// 就在下面的收尾分支按"非崩溃也要杀槽"处理（进程里可能还挂着这票的循环）。
				void this.postAbort(port, ticketId);
				graceTimer = setTimeout(() => controller.abort(), ABORT_SETTLE_GRACE_MS);
				unref(graceTimer);
			}, RUN_TIMEOUT_POLL_MS);
			unref(timeoutTimer);
		}

		try {
			const res = await this.fetchFn(
				`http://127.0.0.1:${port}/run/${encodeURIComponent(ticketId)}/events`,
				{
					headers: {
						authorization: `Bearer ${this.token}`,
						accept: "text/event-stream",
					},
					signal: controller.signal,
				},
			);
			if (!res.ok || res.body === null) throw new Error(`events_http_${res.status}`);
			const reader = res.body.getReader();
			cancelReader = () => {
				void reader.cancel().catch(() => undefined);
			};
			const decoder = new TextDecoder();
			let buffer = "";
			while (settled === null) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary: number;
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const event = parseEventFrame(frame);
					if (event === null) continue;
					lastActivityAt = this.now();
					try {
						onEvent(event);
					} catch {
						// 订阅者异常不能反噬监督者
					}
					if (event.type === "settled") {
						settled = { ok: event.ok, reason: event.reason };
						break;
					}
				}
			}
			if (settled === null && buffer.trim() !== "") {
				const event = parseEventFrame(buffer);
				if (event !== null) {
					lastActivityAt = this.now();
					try {
						onEvent(event);
					} catch {
						// 同上
					}
					if (event.type === "settled") settled = { ok: event.ok, reason: event.reason };
				}
			}
		} catch {
			// 传输层失败：落到下面的 SSE 断开收尾
		} finally {
			clearInterval(healthTimer);
			if (timeoutTimer !== null) clearInterval(timeoutTimer);
			if (graceTimer !== null) clearTimeout(graceTimer);
			if (abortTimer !== null) clearTimeout(abortTimer);
			callerSignal?.removeEventListener("abort", onAbort);
			cancelReader?.();
		}

		if (settled !== null) {
			this.release(slot, ticketId);
			slot.finishedTickets += 1;
			this.observe({
				kind: "settle",
				poolIndex: slot.index,
				ticketId,
				reason: timedOut ? "timeout" : settled.reason,
				...(slot.rssMb !== null ? { rssMb: slot.rssMb } : {}),
			});
			this.recycleIdleSlots();
			// 超时判定不因 worker 随后自己发来 settled 改口（这票已经判死，调度层据此重派）；
			// 但它确实收尾了，槽位照常释放、finishedTickets 只在这里加一次。
			if (timedOut) return { ok: false, reason: "timeout", poolIndex: slot.index };
			return { ok: settled.ok, reason: settled.reason, poolIndex: slot.index };
		}

		// 超时宽限到期仍没 settled：非崩溃也要杀槽——池进程里可能还挂着这票的循环，
		// 留着会把下一票和上一票搅在一起。
		if (timedOut) {
			this.killSlot(slot, "run_timeout");
			this.release(slot, ticketId);
			this.observe({
				kind: "settle",
				poolIndex: slot.index,
				ticketId,
				reason: "timeout",
				...(slot.rssMb !== null ? { rssMb: slot.rssMb } : {}),
			});
			this.recycleIdleSlots();
			return { ok: false, reason: "timeout", poolIndex: slot.index };
		}

		// 硬规则：SSE 断了却没 settled，这票失败；进程若已崩则是 pool_crashed，否则杀掉。
		const crashed = slot.child === null || slot.port !== port;
		if (!crashed) this.killSlot(slot, "stream_closed");
		this.release(slot, ticketId);
		const reason = crashed ? "pool_crashed" : "stream_closed";
		this.observe({
			kind: "settle",
			poolIndex: slot.index,
			ticketId,
			reason,
			...(slot.rssMb !== null ? { rssMb: slot.rssMb } : {}),
		});
		this.recycleIdleSlots();
		return { ok: false, reason, poolIndex: slot.index };
	}

	private async probeHealth(slot: SlotRuntime): Promise<void> {
		const port = slot.port;
		const child = slot.child;
		if (port === null || child === null) return;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
		unref(timer);
		try {
			const res = await this.fetchFn(`http://127.0.0.1:${port}/health`, {
				headers: { authorization: `Bearer ${this.token}` },
				signal: controller.signal,
			});
			if (!res.ok) return;
			const body = (await res.json()) as unknown;
			if (typeof body !== "object" || body === null) return;
			if (slot.child !== child || slot.port !== port) return;
			const record = body as Record<string, unknown>;
			slot.lastSeenAt = this.now();
			const rssMb = optionalNumber(record.rssMb);
			if (rssMb !== null) slot.rssMb = rssMb;
			const finished = optionalNumber(record.finishedTickets);
			if (finished !== null) slot.finishedTickets = finished;
		} catch {
			// 心跳没探到：不更新 lastSeenAt，交给 recycleReason 判
		} finally {
			clearTimeout(timer);
		}
	}

	private postAbort(port: number, ticketId: string): Promise<{ ok: boolean; message?: string }> {
		// 2026-11-22 修：池服务端路由是 `/run/:ticketId/abort`；打 `/abort` 会 404，
		// 取消只能等 10 秒断流杀进程（探针抓到过）。
		return this.postJson(
			`http://127.0.0.1:${port}/run/${encodeURIComponent(ticketId)}/abort`,
			{ ticketId },
		);
	}

	private async postJson(
		url: string,
		payload: Record<string, unknown>,
	): Promise<{ ok: boolean; message?: string }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
		unref(timer);
		try {
			const res = await this.fetchFn(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			let body: unknown = null;
			try {
				body = await res.json();
			} catch {
				body = null;
			}
			const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
			if (!res.ok) {
				const message = typeof record?.message === "string" ? record.message : `http_${res.status}`;
				return { ok: false, message };
			}
			if (record !== null && typeof record.ok === "boolean") {
				return typeof record.message === "string"
					? { ok: record.ok, message: record.message }
					: { ok: record.ok };
			}
			return { ok: true };
		} catch {
			return { ok: false, message: "请求失败" };
		} finally {
			clearTimeout(timer);
		}
	}

	private release(slot: SlotRuntime, ticketId: string): void {
		if (slot.ticketId === ticketId) slot.ticketId = null;
	}

	// ---- 观测 --------------------------------------------------------------

	private observe(entry: Observation): void {
		const line = `${JSON.stringify({ at: this.now(), ...entry })}\n`;
		const write = async (): Promise<void> => {
			this.logDirReady ??= mkdir(path.dirname(this.logPath), { recursive: true }).then(() => undefined);
			await this.logDirReady;
			await writeFile(this.logPath, line, { flag: "a" });
		};
		this.logChain = this.logChain.then(write, write).catch((error: unknown) => {
			console.error(
				`[pool-supervisor] 观测写入失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
}