import { randomUUID } from "node:crypto";
import {
	RELAY_MAX_FRAME_BYTES,
	RELAY_PROTOCOL_VERSION,
	RelayErrorFrameSchema,
	RelayInvokeFrameSchema,
	type RelayErrorFrame,
	type RelayErrorCode,
	type RelayHello,
	type RelayInvokeFrame,
	type RelayInvokePayload,
	type RelayMetaAction,
	type RelayResult,
	type RelayRouted,
	type RelayWelcome,
} from "@lifediary/shared";

/**
 * harness 的中继客户端（2026-11-05 多端同步方案块1，阶段一）。
 *
 * 只管传输：出站长连（指数退避 1s→30s，稳定 10s 归零）、hello 握手、
 * invoke 超时回执、把 routed 帧分发给上层 handler。通道语义在
 * relay-channels.ts（白名单默认拒绝）；本文件不认识任何业务通道。
 *
 * 2026-11-14 稳定性补丁（"时而连上时而连不上"）：
 * ① **应用层心跳**：客户端每 20s 发 `{kind:"ping"}`，中继回 `{kind:"pong"}`
 *    （hub 早已支持这一帧，老版本中继也认，不需要协议变更）。为什么必须发：
 *    握手后到下一次调用之间可能几分钟没有出站帧，家用宽带 / 运营商 NAT 对
 *    "静默长连接"的空闲回收常在 30–90s，连接会被中间设备静默掐掉——表现就是
 *    连上几十秒又掉。心跳把这条链路从"空闲"变成"有流量"。
 * ② **半开检测**：45s 没有任何入站 → 判定死链，主动 terminate 重连
 *    （TCP 半开时 readyState 可能仍显示 OPEN，只等 close 事件会卡很久）。
 * ③ **断开原因入日志**：close code/reason、存活时长、入站静默时长、下次延迟。
 *    以前只记"已连接"，掉线原因完全不可见（2026-11-14 日志里 891 行"已连接"、
 *    零行"断开"就是这个问题）。
 * ④ 退避加 ±20% 抖动：多设备/多实例同时掉线时不要挤在同一秒重连。
 *
 * 回滚开关：RELAY_ENABLED=false（默认）→ 不连接、不装通道，回局域网直连形态。
 */

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_RESET_MS = 10_000;
/** 客户端心跳间隔（远小于运营商 NAT 常见的 30–90s 空闲回收） */
const HEARTBEAT_MS = 20_000;
/** 连续这么久没有任何入站帧 = 死链（3 个心跳周期收不到 pong 就该断） */
const LIVENESS_MS = 45_000;

export interface RelayClientOptions {
	url: string;
	token: string;
	deviceName: string;
	platform: string;
	version?: string;
	capabilities: string[];
	/** 被控端通道分发器（relay-channels 提供） */
	onInvoke: (src: string, channel: string, payload: unknown) => Promise<unknown>;
	/**
	 * 中继反代（2026-11-11 批H H1）：收到 `invoke` 帧 → 本进程执行 → 回 `invoke_result`。
	 * 不传时一律回 404（通道未注册）；抛错折成 500，绝不让中继干等超时。
	 */
	onInvokeHttp?: (payload: RelayInvokePayload) => Promise<{ status: number; body: string }>;
	/** 重连后恢复订阅等状态 */
	onReconnected?: (deviceId: string) => void;
	onDisconnected?: () => void;
	/** 心跳间隔（测试用；默认 HEARTBEAT_MS） */
	heartbeatMs?: number;
	/** 入站静默判死阈值（测试用；默认 LIVENESS_MS） */
	livenessMs?: number;
	log?: (message: string) => void;
}

/** 连接面统计（只给状态页看，不含任何令牌） */
export interface RelayClientStats {
	connected: boolean;
	reconnects: number;
	lastConnectedAt: number | null;
	lastCloseAt: number | null;
	lastCloseCode: number | null;
	lastCloseReason: string;
	lastPongAt: number | null;
}

export interface RelayInvokeFailure {
	code: string;
	message: string;
}

export class RelayInvokeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

interface PendingInvoke {
	resolve: (value: unknown) => void;
	reject: (error: RelayInvokeError) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class RelayClient {
	private ws: import("ws").WebSocket | null = null;
	private deviceId: string | null = null;
	private onlineDevices: RelayWelcome["devices"] = [];
	private pending = new Map<string, PendingInvoke>();
	private attempts = 0;
	private stopped = false;
	private connectTimer: ReturnType<typeof setTimeout> | null = null;
	private openedAt = 0;
	/** 心跳与存活判定（2026-11-14） */
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private lastInboundAt = 0;
	private reconnects = 0;
	private lastConnectedAt: number | null = null;
	private lastCloseAt: number | null = null;
	private lastCloseCode: number | null = null;
	private lastCloseReason = "";
	private lastPongAt: number | null = null;
	/** 自报身份：进程启动时间，info/probe 用 */
	readonly startedAt = Date.now();

	constructor(private readonly options: RelayClientOptions) {}

	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === 1 && this.deviceId !== null;
	}

	/** 状态页用：连接面统计（`connected` 是"WS 打开"，不等于"链路是活的"） */
	get stats(): RelayClientStats {
		return {
			connected: this.connected,
			reconnects: this.reconnects,
			lastConnectedAt: this.lastConnectedAt,
			lastCloseAt: this.lastCloseAt,
			lastCloseCode: this.lastCloseCode,
			lastCloseReason: this.lastCloseReason,
			lastPongAt: this.lastPongAt,
		};
	}

	get selfDeviceId(): string | null {
		return this.deviceId;
	}

	get devices(): RelayWelcome["devices"] {
		return this.onlineDevices;
	}

	/** 向中继要一次实时名册（welcome 快照只反映连上那一刻；新上线设备靠它拉新）。 */
	async refreshDevices(): Promise<void> {
		if (!this.connected) return;
		try {
			const result = (await this.meta("devices", {})) as { devices?: RelayWelcome["devices"] };
			if (result.devices) this.onlineDevices = result.devices;
		} catch {
			/* 拉不到就用旧快照 */
		}
	}

	get uptimeMs(): number {
		return Date.now() - this.startedAt;
	}

	start(): void {
		this.stopped = false;
		this.scheduleConnect(0);
	}

	stop(): void {
		this.stopped = true;
		this.stopHeartbeat();
		if (this.connectTimer) clearTimeout(this.connectTimer);
		this.connectTimer = null;
		this.failAllPending("device_offline", "中继连接已停");
		this.ws?.close(1000, "client stop");
		this.ws = null;
	}

	/** 向另一台设备发起 invoke；解析 result 帧 / error 帧 / 超时。 */
	invoke(dst: string, channel: string, payload: unknown, timeoutMs = 30_000): Promise<unknown> {
		if (!this.connected || !this.deviceId) {
			return Promise.reject(new RelayInvokeError("device_offline", "中继未连接"));
		}
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RelayInvokeError("timeout", `invoke ${channel} 超过 ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			this.rawSend({
				kind: "deliver",
				id,
				dst,
				channel,
				payload,
			});
		});
	}

	/** 单向推送（事件流等"尽力而为"的帧），不等待回执。 */
	pushTo(dst: string, channel: string, payload: unknown): void {
		if (!this.connected) return;
		this.rawSend({
			kind: "deliver",
			id: randomUUID(),
			dst,
			channel,
			payload,
		});
	}

	/** 中继元数据操作（执事路由表仲裁、名册快照、主机位/描述等）：meta 帧，中继自答。 */
	meta(action: RelayMetaAction, payload: unknown, timeoutMs = 10_000): Promise<unknown> {
		if (!this.connected) {
			return Promise.reject(new RelayInvokeError("device_offline", "中继未连接"));
		}
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RelayInvokeError("timeout", `meta ${action} 超过 ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			this.rawSend({ kind: "meta", id, action, payload });
		});
	}

	private scheduleConnect(delayMs: number): void {
		if (this.stopped) return;
		if (this.connectTimer) clearTimeout(this.connectTimer);
		this.connectTimer = setTimeout(() => this.connect(), delayMs);
		this.connectTimer.unref?.();
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		const { WebSocket } = await import("ws");
		const ws = new WebSocket(this.options.url, { maxPayload: RELAY_MAX_FRAME_BYTES });
		this.ws = ws;
		let helloDone = false;

		ws.on("open", () => {
			// NS-01：连接一建立就开始计算"入站静默"，并挂上心跳（见文件头 ①②）。
			this.lastInboundAt = Date.now();
			this.startHeartbeat(ws);
			const hello: RelayHello = {
				kind: "hello",
				v: RELAY_PROTOCOL_VERSION,
				token: this.options.token,
				deviceName: this.options.deviceName,
				platform: this.options.platform,
				...(this.options.version ? { version: this.options.version } : {}),
				capabilities: this.options.capabilities,
			};
			ws.send(JSON.stringify(hello));
		});

		ws.on("message", (raw: Buffer) => {
			// 任何入站帧都算"链路活着"（pong / welcome / routed / invoke_result 一律）
			this.lastInboundAt = Date.now();
			if (raw.length > RELAY_MAX_FRAME_BYTES) return;
			let frame: unknown;
			try {
				frame = JSON.parse(raw.toString("utf8"));
			} catch {
				return;
			}
			const kind = (frame as { kind?: string })?.kind;
			if (kind === "welcome") {
				const welcome = frame as RelayWelcome;
				this.deviceId = welcome.deviceId;
				this.onlineDevices = welcome.devices;
				helloDone = true;
				const stableFor = Date.now() - this.openedAt;
				this.attempts = stableFor >= STABLE_RESET_MS ? 0 : Math.max(0, this.attempts - 1);
				this.openedAt = Date.now();
				this.lastConnectedAt = this.openedAt;
				this.log(`[relay] 已连接 device=${welcome.deviceId} 名册=${welcome.devices.length}${this.reconnects ? `（第 ${this.reconnects + 1} 次）` : ""}`);
				this.options.onReconnected?.(welcome.deviceId);
				return;
			}
			if (kind === "routed") {
				const routed = frame as RelayRouted;
				void this.dispatch(routed);
				return;
			}
			if (kind === "invoke") {
				// 中继反代（2026-11-11 批H）：中继 R1 直接投帧，不走 deliver/routed。
				const invoke = RelayInvokeFrameSchema.safeParse(frame);
				if (!invoke.success) return;
				void this.dispatchHttp(invoke.data);
				return;
			}
			if (kind === "result") {
				const result = frame as RelayResult;
				const pending = this.pending.get(result.id);
				if (!pending) return;
				this.pending.delete(result.id);
				clearTimeout(pending.timer);
				if (result.ok) pending.resolve(result.result);
				else
					pending.reject(
						new RelayInvokeError(result.error?.code ?? "internal", result.error?.message ?? "invoke 失败"),
					);
				return;
			}
			if (kind === "error") {
				const error = RelayErrorFrameSchema.safeParse(frame);
				if (!error.success) return;
				const data: RelayErrorFrame = error.data;
				if (data.id) {
					const pending = this.pending.get(data.id);
					if (pending) {
						this.pending.delete(data.id);
						clearTimeout(pending.timer);
						pending.reject(new RelayInvokeError(data.code, data.message));
					}
				} else {
					this.log(`[relay] 错误帧 code=${data.code} message=${data.message}`);
				}
				return;
			}
			if (kind === "pong") {
				// 我们发出去的心跳得到了回应：链路确实是通的（不是 TCP 假活）
				this.lastPongAt = Date.now();
				return;
			}
			if (kind === "ping") {
				ws.send(JSON.stringify({ kind: "pong", at: Date.now() }));
			}
		});

		ws.on("close", (code: number, reason: Buffer) => {
			this.stopHeartbeat();
			const wasHello = helloDone;
			const livedMs = this.openedAt ? Date.now() - this.openedAt : 0;
			const silentMs = this.lastInboundAt ? Date.now() - this.lastInboundAt : 0;
			if (this.ws === ws) {
				this.ws = null;
				this.deviceId = null;
			}
			this.lastCloseAt = Date.now();
			this.lastCloseCode = code;
			this.lastCloseReason = reason?.toString("utf8").slice(0, 120) ?? "";
			this.failAllPending("device_offline", wasHello ? "中继连接断开" : "连接未完成握手");
			if (wasHello) this.options.onDisconnected?.();
			if (this.stopped) {
				this.log(`[relay] 已停止（code=${code}）`);
				return;
			}
			this.reconnects += 1;
			this.attempts += 1;
			const base = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempts - 1), BACKOFF_MAX_MS);
			// ±20% 抖动：多实例/多设备同时掉线时不要在同一秒挤回来
			const delay = Math.round(base * (0.8 + Math.random() * 0.4));
			this.log(
				`[relay] 断开 code=${code}${this.lastCloseReason ? ` reason=${this.lastCloseReason}` : ""} 存活=${Math.round(livedMs / 1000)}s 入站静默=${Math.round(silentMs / 1000)}s → ${delay}ms 后重连（第 ${this.reconnects} 次）`,
			);
			this.scheduleConnect(delay);
		});

		ws.on("error", () => {
			/* close 随后必到 */
		});
	}

	/**
	 * 应用层心跳（NS-01）。为什么不是 ws 协议级 ping：
	 * 协议级 ping 由 `ws` 库自动回 pong，中间的 NAT/代理往往直接吞掉（或提前掐断），
	 * 只能证明"两个库在对话"；应用层 ping 走的是同一条业务帧路径，能证明"这条链路真能送帧"。
	 */
	private startHeartbeat(ws: import("ws").WebSocket): void {
		this.stopHeartbeat();
		const interval = this.options.heartbeatMs ?? HEARTBEAT_MS;
		const liveness = this.options.livenessMs ?? LIVENESS_MS;
		// 0 = 显式关闭（回滚开关 RELAY_HEARTBEAT_MS=0）：不挂定时器、也不做半开判定
		if (interval <= 0 || liveness <= 0) return;
		this.heartbeatTimer = setInterval(() => {
			if (this.ws !== ws || ws.readyState !== 1) return;
			const silentMs = Date.now() - this.lastInboundAt;
			if (silentMs >= liveness) {
				// 半开死链：发送缓冲里可能还有积压，等 close 事件可能要等到超时。直接掐。
				this.log(`[relay] 心跳超时（入站静默 ${Math.round(silentMs / 1000)}s）→ 主动重连`);
				try {
					ws.terminate();
				} catch {
					/* 已在关闭途中 */
				}
				return;
			}
			try {
				ws.send(JSON.stringify({ kind: "ping", at: Date.now() }));
			} catch {
				/* 发不出去就等 close */
			}
		}, interval);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	private async dispatch(routed: RelayRouted): Promise<void> {
		const self = this.deviceId;
		if (!self) return;
		try {
			const result = await this.options.onInvoke(routed.src, routed.channel, routed.payload);
			this.rawSend({
				kind: "result",
				id: routed.id,
				dst: routed.src,
				ok: true,
				result,
			});
		} catch (error) {
			const code = error instanceof RelayInvokeError ? error.code : "internal";
			const message = error instanceof Error ? error.message.slice(0, 300) : "处理失败";
			this.rawSend({
				kind: "result",
				id: routed.id,
				dst: routed.src,
				ok: false,
				error: { code: code as RelayErrorCode, message },
			});
		}
	}

	/** 反代帧：执行完回 `invoke_result`（中继只认这一种回包）。 */
	private async dispatchHttp(frame: RelayInvokeFrame): Promise<void> {
		let outcome: { status: number; body: string };
		try {
			outcome = this.options.onInvokeHttp
				? await this.options.onInvokeHttp(frame.payload)
				: { status: 404, body: JSON.stringify({ error: "not_found" }) };
		} catch {
			outcome = { status: 500, body: JSON.stringify({ error: "internal_error" }) };
		}
		// 日志纪律：只记状态，不记路径 / 正文 / 令牌
		this.log(`[relay] invoke_result status=${outcome.status}`);
		this.rawSend({ kind: "invoke_result", id: frame.id, payload: outcome });
	}

	private rawSend(frame: unknown): void {
		if (this.ws && this.ws.readyState === 1) {
			this.ws.send(JSON.stringify(frame));
		}
	}

	private failAllPending(code: string, message: string): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new RelayInvokeError(code, message));
		}
		this.pending.clear();
	}

	private log(message: string): void {
		this.options.log?.(message);
	}
}
