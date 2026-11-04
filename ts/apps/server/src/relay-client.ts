import { randomUUID } from "node:crypto";
import {
	RELAY_MAX_FRAME_BYTES,
	RELAY_PROTOCOL_VERSION,
	RelayErrorFrameSchema,
	type RelayErrorFrame,
	type RelayErrorCode,
	type RelayHello,
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
 * 回滚开关：RELAY_ENABLED=false（默认）→ 不连接、不装通道，回局域网直连形态。
 */

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_RESET_MS = 10_000;

export interface RelayClientOptions {
	url: string;
	token: string;
	deviceName: string;
	platform: string;
	version?: string;
	capabilities: string[];
	/** 被控端通道分发器（relay-channels 提供） */
	onInvoke: (src: string, channel: string, payload: unknown) => Promise<unknown>;
	/** 重连后恢复订阅等状态 */
	onReconnected?: (deviceId: string) => void;
	onDisconnected?: () => void;
	log?: (message: string) => void;
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
	/** 自报身份：进程启动时间，info/probe 用 */
	readonly startedAt = Date.now();

	constructor(private readonly options: RelayClientOptions) {}

	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === 1 && this.deviceId !== null;
	}

	get selfDeviceId(): string | null {
		return this.deviceId;
	}

	get devices(): RelayWelcome["devices"] {
		return this.onlineDevices;
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

	/** 中继元数据操作（伙伴路由表仲裁等）：meta 帧，中继自答。 */
	meta(action: "actors" | "actor-home" | "actor-claim" | "actor-release", payload: unknown, timeoutMs = 10_000): Promise<unknown> {
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
				this.log(`[relay] 已连接 device=${welcome.deviceId} 名册=${welcome.devices.length}`);
				this.options.onReconnected?.(welcome.deviceId);
				return;
			}
			if (kind === "routed") {
				const routed = frame as RelayRouted;
				void this.dispatch(routed);
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
			if (kind === "ping") {
				ws.send(JSON.stringify({ kind: "pong", at: Date.now() }));
			}
		});

		ws.on("close", () => {
			const wasHello = helloDone;
			if (this.ws === ws) {
				this.ws = null;
				this.deviceId = null;
			}
			this.failAllPending("device_offline", wasHello ? "中继连接断开" : "连接未完成握手");
			if (wasHello) this.options.onDisconnected?.();
			if (this.stopped) return;
			this.attempts += 1;
			const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempts - 1), BACKOFF_MAX_MS);
			this.scheduleConnect(delay);
		});

		ws.on("error", () => {
			/* close 随后必到 */
		});
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
