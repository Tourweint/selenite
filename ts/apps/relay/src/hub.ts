import { randomUUID } from "node:crypto";
import {
	RELAY_MAX_FRAME_BYTES,
	RELAY_PROTOCOL_VERSION,
	RelayInvokeResultFrameSchema,
	type RelayDeliver,
	type RelayErrorFrame,
	type RelayHello,
	type RelayInvokeFrame,
	type RelayInvokePayload,
	type RelayMetaRequest,
	type RelayPresenceFrame,
	type RelayResult,
} from "@lifediary/shared";
import type { WebSocket } from "ws";
import { MAX_DESCRIPTION_LENGTH, type RelayStore } from "./store.ts";

/**
 * 中继枢纽（2026-11-05 多端同步方案块0）。
 *
 * 只做四件事：认人（hello）、按 dst 转发（deliver/result，覆写 src）、
 * 同设备顶替（新连接踢旧连接）、在场维护。channel/payload 对中继不透明——
 * 语义校验全部在被控端的通道白名单里，这里只看信封形状与帧长。
 *
 * 2026-11-11 批R 补两件：名册变更广播（presence）、反向 HTTP 代理的
 * invoke/invoke_result 往返（中继只补路由，HTTP 语义原样透传）。
 *
 * 关闭码：4400 协议版本不符 / 4401 鉴权失败 / 4402 握手超时 / 4409 同设备顶替。
 */

const HELLO_TIMEOUT_MS = 15_000;
const CLEANUP_INTERVAL_MS = 60_000;
/**
 * 入站活跃度判定（2026-11-11 抄 cindy hub.ts:348-353）：任何合法入站帧刷新 lastInboundAt，
 * 超过 IDLE_TIMEOUT_MS 没有任何入站 → 连接已是半开死链（对端断网未挥手），terminate 清位。
 * 为什么不用 ping 探测：我们与 cindy 都没有客户端周期 ping（harness 只回 pong 不发 ping），
 * 主动 ping 要新增客户端协议；入站 idle 判定零协议改动，语义等价（cindy 同款 90s）。
 */
const IDLE_TIMEOUT_MS = 90_000;
/**
 * 出站背压闸门（2026-11-11 抄 cindy hub.ts:367-377）：send 前查 ws.bufferedAmount，
 * 慢消费者（对端卡死/弱网不读）会把内核 ws 缓冲无界堆高——1.6G 小机上这是 OOM 主通道。
 * 超阈以 1013 Try Again Later 主动关闭，客户端按重连退避自愈。
 */
const BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;

export interface HubConnectionInfo {
	deviceId: string;
	deviceName: string;
	platform: string;
	capabilities: string[];
	connectedAt: number;
}

export interface RouteOutcome {
	forwarded: boolean;
	reason?: "unknown_device" | "device_offline" | "payload_too_large" | "bad_request";
}

/** 反代一次 invoke 的结果：拿到主机的 HTTP 回包，或"发不出去/没等到"。 */
export type InvokeOutcome =
	| { ok: true; status: number; body: string }
	| { ok: false; reason: "device_offline" | "timeout" | "payload_too_large" };

export class RelayHub {
	/** deviceId → 当前连接（同设备重连顶替，旧连接以 4409 关闭） */
	private conns = new Map<string, WebSocket & { hubInfo?: HubConnectionInfo }>();
	/** invoke id → 等回包的 HTTP 请求（2026-11-11 批R R1） */
	private invokes = new Map<
		string,
		{ resolve: (outcome: InvokeOutcome) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly store: RelayStore,
		private readonly log: (message: string) => void = (m) => console.log(m),
	) {}

	start(): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
		this.cleanupTimer.unref?.();
	}

	stop(): void {
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		this.cleanupTimer = null;
	}

	get onlineCount(): number {
		return this.conns.size;
	}

	get onlineIds(): Set<string> {
		return new Set(this.conns.keys());
	}

	isOnline(deviceId: string): boolean {
		return this.conns.has(deviceId);
	}

	/** 名册撤销时强制下线（4401）。连接不在则返回 false。 */
	disconnectDevice(deviceId: string): boolean {
		const ws = this.conns.get(deviceId);
		if (!ws) return false;
		this.conns.delete(deviceId);
		try {
			ws.close(4401, "revoked");
		} catch {
			/* 已在关闭途中 */
		}
		return true;
	}

	/**
	 * 反向 HTTP 代理（2026-11-11 批R R1）：把一条 HTTP 请求作为 invoke 帧投给目标设备，
	 * 等它的 invoke_result。**不排队**：目标不在线立刻返回，超时按调用方口径回 504。
	 *
	 * 中继不解析、不改写 status/body——它只是把"手机发来的 HTTP"运到主机再运回来。
	 */
	invoke(deviceId: string, payload: RelayInvokePayload, timeoutMs = 15_000): Promise<InvokeOutcome> {
		const conn = this.conns.get(deviceId);
		if (!conn || conn.readyState !== 1 /* OPEN */) {
			return Promise.resolve({ ok: false, reason: "device_offline" });
		}
		const frame: RelayInvokeFrame = { kind: "invoke", id: randomUUID(), payload };
		// 帧长沿用中继上限：超了不发（HTTP 侧翻成 413），别让目标端 ws 静默丢帧。
		if (Buffer.byteLength(JSON.stringify(frame)) > RELAY_MAX_FRAME_BYTES) {
			return Promise.resolve({ ok: false, reason: "payload_too_large" });
		}
		if ((conn.bufferedAmount ?? 0) > BACKPRESSURE_LIMIT_BYTES) {
			return Promise.resolve({ ok: false, reason: "device_offline" });
		}
		return new Promise<InvokeOutcome>((resolve) => {
			const timer = setTimeout(() => {
				this.invokes.delete(frame.id);
				resolve({ ok: false, reason: "timeout" });
			}, timeoutMs);
			timer.unref?.();
			this.invokes.set(frame.id, { resolve, timer });
			try {
				conn.send(JSON.stringify(frame));
				this.log(`[relay] invoke device=${deviceId} id=${frame.id}`);
			} catch {
				this.invokes.delete(frame.id);
				clearTimeout(timer);
				resolve({ ok: false, reason: "device_offline" });
			}
		});
	}

	/** 名册变更广播（R3）：hello 成功 / 连接关闭后推全量投影给所有在线连接。 */
	private broadcastPresence(): void {
		const frame: RelayPresenceFrame = {
			kind: "presence",
			devices: this.store.listDevices(Date.now(), this.onlineIds),
		};
		const text = JSON.stringify(frame);
		for (const conn of this.conns.values()) {
			if (conn.readyState !== 1) continue;
			// 慢消费者不为一条名册帧触发 1013（那是 deliver 的保命闸门），跳过即可：
			// 下次 hello/bye 还会再广播，名册最终一致。
			if ((conn.bufferedAmount ?? 0) > BACKPRESSURE_LIMIT_BYTES) continue;
			try {
				conn.send(text);
			} catch {
				/* 已在关闭途中 */
			}
		}
	}

	/** 接管一条刚 upgrade 的连接：第一帧必须是 hello（15 秒）。 */
	attach(ws: WebSocket): void {
		let hello: RelayHello | null = null;
		const helloTimer = setTimeout(() => {
			if (!hello) {
				this.sendError(ws, undefined, "unauthorized", "握手超时：15 秒内未收到 hello");
				ws.close(4402, "handshake timeout");
			}
		}, HELLO_TIMEOUT_MS);
		helloTimer.unref?.();

		ws.on("message", (raw: Buffer) => {
			if (raw.length > RELAY_MAX_FRAME_BYTES) {
				this.sendError(ws, undefined, "payload_too_large", "帧超过上限，不解析不转发");
				return;
			}
			// 入站活跃度（cindy 同款）：任何合法帧（哪怕之后解析失败）都算"对端活着"
			(ws as WebSocket & { hubInfo?: HubConnectionInfo; lastInboundAt?: number }).lastInboundAt = Date.now();
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw.toString("utf8"));
			} catch {
				this.sendError(ws, undefined, "bad_request", "帧不是合法 JSON");
				return;
			}

			if (!hello) {
				const outcome = this.acceptHello(ws, parsed);
				if (outcome) {
					hello = outcome;
					clearTimeout(helloTimer);
				}
				return;
			}
			this.route(ws, parsed);
		});

		ws.on("close", () => {
			clearTimeout(helloTimer);
			// 顶替场景旧连接的 close 不会抢新连接的位（onClose 按当前连接比对）
			this.onClose(ws);
		});
		ws.on("error", () => {
			/* close 事件随后必到，这里只防 crash */
		});
	}

	/** hello 鉴权 + 顶替。失败时已回错误帧并关连接；成功返回 null，成功赋值由调用方持有。 */
	private acceptHello(ws: WebSocket, parsed: unknown): RelayHello | null {
		const hello = parsed as RelayHello;
		if (
			!hello ||
			typeof hello !== "object" ||
			(hello as RelayHello).kind !== "hello" ||
			(hello as RelayHello).v !== RELAY_PROTOCOL_VERSION
		) {
			this.sendError(ws, undefined, "version_mismatch", `只支持协议 v${RELAY_PROTOCOL_VERSION}，首帧必须是 hello`);
			ws.close(4400, "version mismatch");
			return null;
		}
		const deviceId = this.store.verifyDeviceToken(hello.token ?? "");
		if (!deviceId) {
			this.sendError(ws, undefined, "unauthorized", "令牌无效或已撤销");
			ws.close(4401, "unauthorized");
			return null;
		}
		// 同设备顶替：新连接进门，旧连接出门（cindy 4409 同款语义）
		const existing = this.conns.get(deviceId);
		if (existing && existing !== ws) {
			existing.close(4409, "superseded");
		}
		const info: HubConnectionInfo = {
			deviceId,
			deviceName: hello.deviceName,
			platform: hello.platform,
			capabilities: hello.capabilities ?? [],
			connectedAt: Date.now(),
		};
		(ws as WebSocket & { hubInfo?: HubConnectionInfo }).hubInfo = info;
		this.conns.set(deviceId, ws as WebSocket & { hubInfo?: HubConnectionInfo });
		this.store.touch(deviceId);
		this.log(
			`[relay] hello device=${deviceId} platform=${info.platform} caps=${info.capabilities.length} online=${this.conns.size}`,
		);
		ws.send(
			JSON.stringify({
				kind: "welcome",
				deviceId,
				devices: this.store.listDevices(Date.now(), this.onlineIds),
			}),
		);
		// 名册变了：推给所有人（含刚连上的这台——welcome 只是它自己的快照）。
		this.broadcastPresence();
		return hello;
	}

	/** deliver / result / ping 的统一路由。src 由中继盖章，不信任连接自报。 */
	private route(ws: WebSocket, parsed: unknown): void {
		const frame = parsed as { kind?: string };
		if (frame?.kind === "ping") {
			ws.send(JSON.stringify({ kind: "pong", at: Date.now() }));
			return;
		}
		// meta 帧：中继自答不转发（伙伴路由表仲裁，阶段三）。
		// 这是信封里唯一的"中继看得懂"的业务帧——存的是路由元数据，方案 §六备选。
		if (frame?.kind === "meta") {
			this.handleMeta(ws, parsed as RelayMetaRequest);
			return;
		}
		if (frame?.kind === "invoke_result") {
			// 反代回包（2026-11-11 批R R1）：只认中继自己发出去的 id，不做转发。
			this.settleInvoke(parsed);
			return;
		}
		if (frame?.kind === "deliver") {
			const deliver = parsed as RelayDeliver;
			const src = (ws as WebSocket & { hubInfo?: HubConnectionInfo }).hubInfo?.deviceId;
			if (!src) return;
			if (deliver.dst === src) {
				this.sendError(ws, deliver.id, "bad_request", "dst 不能是发起设备自己");
				return;
			}
			const outcome = this.forward(deliver.id, src, deliver.dst, {
				kind: "routed",
				id: deliver.id,
				src,
				channel: deliver.channel,
				payload: deliver.payload,
			});
			if (!outcome.forwarded) {
				this.sendError(ws, deliver.id, outcome.reason ?? "unknown_device", routeFailMessage(outcome.reason));
			}
			return;
		}
		if (frame?.kind === "result") {
			const result = parsed as RelayResult;
			const src = (ws as WebSocket & { hubInfo?: HubConnectionInfo }).hubInfo?.deviceId;
			if (!src) return;
			// result 的 dst = 发起端；同样不允许自环
			if (result.dst === src) return;
			this.forward(result.id, src, result.dst, result);
			return;
		}
		this.sendError(ws, undefined, "bad_request", "未知帧类型");
	}

	/** invoke_result：按 id 兑现等回包的 HTTP 请求；认不出的 id 静默忽略。 */
	private settleInvoke(parsed: unknown): void {
		const result = RelayInvokeResultFrameSchema.safeParse(parsed);
		if (!result.success) return;
		const pending = this.invokes.get(result.data.id);
		if (!pending) return;
		this.invokes.delete(result.data.id);
		clearTimeout(pending.timer);
		pending.resolve({ ok: true, status: result.data.payload.status, body: result.data.payload.body });
	}

	private handleMeta(ws: WebSocket, meta: RelayMetaRequest): void {
		const src = (ws as WebSocket & { hubInfo?: HubConnectionInfo }).hubInfo?.deviceId;
		if (!src) return;
		const reply = (ok: boolean, result?: unknown, message?: string): void => {
			const frame = ok
				? { kind: "result", id: meta.id, dst: src, ok: true, result }
				: { kind: "result", id: meta.id, dst: src, ok: false, error: { code: "bad_request", message: (message ?? "meta 处理失败").slice(0, 300) } };
			try {
				ws.send(JSON.stringify(frame));
			} catch {
				/* 已在关闭途中 */
			}
		};
		try {
			switch (meta.action) {
				case "actors":
					reply(true, { actors: this.store.listActors() });
					return;
				case "devices":
					// 名册实时快照（连接期间的 welcome 只反映连上那一刻；
					// 中间上线的设备靠这里拉新——v1 无 presence 广播的补位）。
					// isHome / description 由 store.listDevices 投影带出（2026-11-05）。
					reply(true, { devices: this.store.listDevices(Date.now(), this.onlineIds) });
					return;
				case "set-home": {
					// 设 / 清任务主机位（2026-11-05 主机优先制）：payload {deviceId: string | null}
					const raw = (meta.payload as { deviceId?: unknown } | null)?.deviceId;
					if (raw !== null && raw !== undefined && typeof raw !== "string") {
						reply(false, undefined, "deviceId 需要字符串或 null");
						return;
					}
					// 传了 null（或省略）就是清除；不能把 undefined 当"设成空串"
					const target = typeof raw === "string" ? raw : null;
					if (!this.store.setHomeDevice(target)) {
						reply(false, undefined, "deviceId 不在名册里");
						return;
					}
					reply(true, { ok: true, homeDeviceId: this.store.homeDeviceId() });
					return;
				}
				case "set-description": {
					// 设备描述（只给人看）：payload {deviceId, description}
					const body = meta.payload as { deviceId?: unknown; description?: unknown } | null;
					if (typeof body?.deviceId !== "string" || !body.deviceId) {
						reply(false, undefined, "需要 deviceId");
						return;
					}
					if (typeof body.description !== "string") {
						reply(false, undefined, "需要 description 字符串");
						return;
					}
					const text = body.description.trim();
					if (text.length > MAX_DESCRIPTION_LENGTH) {
						reply(false, undefined, `描述最多 ${MAX_DESCRIPTION_LENGTH} 字`);
						return;
					}
					if (!this.store.setDescription(body.deviceId, text)) {
						reply(false, undefined, "deviceId 不在名册里");
						return;
					}
					reply(true, { ok: true, deviceId: body.deviceId, description: text });
					return;
				}
				case "actor-home": {
					const actorId = (meta.payload as { actorId?: unknown } | null)?.actorId;
					if (typeof actorId !== "string" || !actorId) {
						reply(false, undefined, "需要 actorId");
						return;
					}
					const actor = this.store.actorHome(actorId);
					reply(true, {
						actorId,
						name: actor?.name ?? null,
						homeDeviceId: actor?.homeDeviceId ?? null,
						online: actor?.homeDeviceId ? this.isOnline(actor.homeDeviceId) : null,
					});
					return;
				}
				case "actor-claim": {
					const body = meta.payload as { actorId?: unknown; name?: unknown; expectedHomeDeviceId?: unknown } | null;
					if (typeof body?.actorId !== "string" || !body.actorId) {
						reply(false, undefined, "需要 actorId");
						return;
					}
					const outcome = this.store.claimActorHome(
						body.actorId,
						typeof body.name === "string" ? body.name : "",
						(body.expectedHomeDeviceId ?? null) as string | null,
						src,
					);
					reply(
						true,
						outcome.ok
							? { ok: true, actorId: outcome.actor.actorId, name: outcome.actor.name, homeDeviceId: outcome.actor.homeDeviceId }
							: { ok: false, code: outcome.code, actorId: body.actorId, homeDeviceId: outcome.actual },
					);
					return;
				}
				case "actor-release": {
					const actorId = (meta.payload as { actorId?: unknown } | null)?.actorId;
					if (typeof actorId !== "string" || !actorId) {
						reply(false, undefined, "需要 actorId");
						return;
					}
					reply(true, { ok: this.store.releaseActorHome(actorId, src) });
					return;
				}
				default:
					reply(false, undefined, `未知 meta 动作：${String(meta.action)}`);
			}
		} catch (error) {
			reply(false, undefined, error instanceof Error ? error.message : "meta 处理失败");
		}
	}

	private forward(id: string, src: string, dst: string, frame: unknown): RouteOutcome {
		const dstConn = this.conns.get(dst);
		if (!dstConn) {
			const known = this.store.listDevices().some((device) => device.id === dst);
			return { forwarded: false, reason: known ? "device_offline" : "unknown_device" };
		}
		if (dstConn.readyState !== 1 /* OPEN */) return { forwarded: false, reason: "device_offline" };
		// 出站背压（cindy 同款）：缓冲超限 = 对端不读，再堆就是 OOM。1013 关掉让它重连。
		const buffered = (dstConn as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0;
		if (buffered > BACKPRESSURE_LIMIT_BYTES) {
			this.log(`[relay] backpressure device=${dst} buffered=${buffered} -> close 1013`);
			try {
				dstConn.close(1013, "try again later");
			} catch {
				/* 已在关闭途中 */
			}
			this.conns.delete(dst);
			return { forwarded: false, reason: "device_offline" };
		}
		dstConn.send(JSON.stringify(frame));
		this.log(`[relay] forward id=${id} src=${src} dst=${dst}`);
		return { forwarded: true };
	}

	private onClose(ws: WebSocket): void {
		const info = (ws as WebSocket & { hubInfo?: HubConnectionInfo }).hubInfo;
		if (!info) return;
		if (this.conns.get(info.deviceId) === ws) {
			this.conns.delete(info.deviceId);
			this.store.touch(info.deviceId);
			this.log(`[relay] bye device=${info.deviceId} online=${this.conns.size}`);
			this.broadcastPresence();
		}
	}

	private sweep(): void {
		// 半开连接兜底（两道）：
		// ① readyState 不是 OPEN 的清出名册（close 事件迟到的场景，原有）；
		// ② 入站 idle 超限的 terminate（cindy 同款 2026-11-11）：对端断网未挥手时
		//    readyState 仍是 OPEN 但永远是死链，占着名册让对端一直"在线"。
		const now = Date.now();
		for (const [deviceId, ws] of this.conns) {
			const last = (ws as WebSocket & { lastInboundAt?: number }).lastInboundAt;
			if (last !== undefined && now - last > IDLE_TIMEOUT_MS) {
				this.log(`[relay] idle device=${deviceId} lastInbound=${Math.round((now - last) / 1000)}s -> terminate`);
				this.conns.delete(deviceId);
				try {
					ws.terminate();
				} catch {
					/* 已在关闭途中 */
				}
				continue;
			}
			if (ws.readyState !== 1) this.conns.delete(deviceId);
		}
	}

	private sendError(ws: WebSocket, id: string | undefined, code: RelayErrorFrame["code"], message: string): void {
		const frame: RelayErrorFrame = { kind: "error", code, message, ...(id ? { id } : {}) };
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			/* 连接已在关闭途中 */
		}
	}
}

function routeFailMessage(reason?: string): string {
	switch (reason) {
		case "device_offline":
			return "目标设备在名册但不在线";
		case "unknown_device":
			return "目标设备不在名册";
		case "payload_too_large":
			return "帧超过上限";
		default:
			return "无法转发";
	}
}
