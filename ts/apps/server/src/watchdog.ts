/**
 * stream_stalled 看门狗（2026-11-09 任务书 T3 §4）。
 *
 * 口径："卡死也是事件"。一条 SSE 流里超过 N 秒（缺省 180，`AGENT_STALL_TIMEOUT_S`）
 * 没有任何事件 → 记一条审计。
 *
 * **不改行为、不中断**：只记账，不 abort、不补帧、不通知模型。
 *
 * 记账口径（只有三样，绝不含对话内容）：会话/群 id、已耗时、最后一个事件类型。
 * 落 `.data/stall-audit.jsonl`（追加，一行一条）。开关 `AGENT_STALL_AUDIT` 缺省 true。
 *
 * 覆盖面（2026-11-12 全量清点后扩面，总账 #43"只覆盖 /chat 一条"的差注记收口）：
 * - POST /api/v1/agent/chat 真实链路（index.ts streamSSE）—— 批 11 既有覆盖，行为逐字节不变。
 * - POST /api/v1/llm/chat/completions 流式分支（openai-compat.ts）—— 与 /chat 同一
 *   chatStream 引擎、同一结构性阻塞点（上游 LLM 无响应），停滞同样算异常。
 * - POST /api/v1/groups/:id/chat 群回合 SSE（group-api.ts）—— 成员发言轮走同一
 *   chatStream，回合卡住 = SSE 无帧；同群并发被 409 闸住，键（群 uuid）不会打架。
 *
 * 清点后明确**不盖**的（如实口径，不硬凑）：
 * - /chat 的 mock 分支（streamMock）：不建会话、无上游，18ms/字符回显，卡死不可能。
 * - /api/v1/worker/poll：长轮询不是 SSE，且自带 timeoutS（≤60s）硬上限。
 * - /api/v1/worker/model：SSE 是上游响应原样透传，fetch 挂 300s AbortSignal 硬上限，
 *   停滞必在 5 分钟内终结；手机 worker 另有自己的观察面（批 31 三层）。
 * - compat 非流式分支：无 SSE 帧，停滞表现为请求不返回；X-Task 通道有任务卡/心跳观察面。
 * - relay events/subscribe：不是 HTTP SSE——250ms 轮询重放库经中继 WS 推帧；
 *   /chat 卡死时它是同一停滞的下游镜像（同一会话同一段无帧），单独记账只会重复。
 * - relay-client 出站 WebSocket：出站客户端自带重连，不是本进程服务的端点。
 *
 * 记账键：/chat 与 compat 用内部自增 conversationId（审计文件只落服务端，不是对外契约）；
 * 群回合用群 uuid。两类同落一个文件，字段同名类型不同（number | string）。
 *
 * 为什么单独成模块：`index.ts` 顶层就 `serve`，单测 import 它等于顺手起服务。
 * 这里不 import 任何 agent / 服务装配，可直接单测（定时器可关、时钟可注入）。
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_FILE = ".data/stall-audit.jsonl";
const DEFAULT_TIMEOUT_S = 180;
const SCAN_INTERVAL_MS = 30_000;

/** 缺省开；只有明确 false / 0 / off 才关。 */
export function stallAuditEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env.AGENT_STALL_AUDIT?.trim().toLowerCase();
	return !(raw === "false" || raw === "0" || raw === "off");
}

/** 多少秒没有事件算卡住。非法值 / 0 回落 180（配错不制造"永不记录"）。 */
export function stallTimeoutSeconds(env: Record<string, string | undefined> = process.env): number {
	const raw = Number(env.AGENT_STALL_TIMEOUT_S?.trim());
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_S;
}

export interface StallRecord {
	at: string;
	/** /chat 与 compat 是内部自增 id；群回合是群 uuid（见头注释"记账键"）。 */
	conversationId: number | string;
	elapsedMs: number;
	lastEvent: string;
}

interface Tracked {
	startedAt: number;
	lastEventAt: number;
	lastEvent: string;
	/** 本轮已经记过一条（同一段卡死不刷屏；下一个事件会重置） */
	reported: boolean;
}

export interface StallWatchdogOptions {
	filePath?: string;
	timeoutS?: number;
	/** 测试关掉定时器，直接调 scan() */
	startTimer?: boolean;
	now?: () => number;
	env?: Record<string, string | undefined>;
}

export class StallWatchdog {
	private readonly tracked = new Map<number | string, Tracked>();
	private readonly filePath: string;
	private readonly timeoutMs: number;
	private readonly now: () => number;
	private timer: NodeJS.Timeout | undefined;

	constructor(options: StallWatchdogOptions = {}) {
		const env = options.env ?? process.env;
		this.filePath = options.filePath ?? DEFAULT_FILE;
		this.timeoutMs = (options.timeoutS ?? stallTimeoutSeconds(env)) * 1000;
		this.now = options.now ?? (() => Date.now());
		if (options.startTimer !== false && stallAuditEnabled(env)) {
			this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
			this.timer.unref?.();
		}
	}

	/** 每推一帧 SSE 调一次（/chat 收口函数、compat 与群回合的推送循环里）。 */
	note(conversationId: number | string, eventType: string): void {
		const at = this.now();
		const existing = this.tracked.get(conversationId);
		if (existing) {
			existing.lastEventAt = at;
			existing.lastEvent = eventType;
			existing.reported = false;
			return;
		}
		this.tracked.set(conversationId, {
			startedAt: at,
			lastEventAt: at,
			lastEvent: eventType,
			reported: false,
		});
	}

	/** 这条流结束（正常 / 报错 / 客户端断开都算），移出跟踪。 */
	finish(conversationId: number | string): void {
		this.tracked.delete(conversationId);
	}

	/** 扫一遍，把超时的会话记一条。定时器与单测共用。 */
	scan(): StallRecord[] {
		const at = this.now();
		const written: StallRecord[] = [];
		for (const [conversationId, entry] of this.tracked) {
			if (entry.reported) continue;
			const elapsedMs = at - entry.lastEventAt;
			if (elapsedMs < this.timeoutMs) continue;
			entry.reported = true;
			const record: StallRecord = {
				at: new Date(at).toISOString(),
				conversationId,
				elapsedMs,
				lastEvent: entry.lastEvent,
			};
			this.append(record);
			written.push(record);
		}
		return written;
	}

	private append(record: StallRecord): void {
		try {
			const path = resolve(this.filePath);
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			// 审计写不进去不能影响对话（只 warn 计数，不带内容）
			console.warn(
				`[watchdog] 写 ${this.filePath} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	close(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.tracked.clear();
	}
}

let singleton: StallWatchdog | undefined;

/** 进程级单例（`index.ts` 的 SSE 收口函数用）。 */
export function stallWatchdog(): StallWatchdog {
	singleton ??= new StallWatchdog();
	return singleton;
}
