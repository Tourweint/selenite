import {
	RELAY_MAX_FRAME_BYTES,
	RELAY_PROTOCOL_VERSION,
	type RelayDeliver,
	type RelayErrorFrame,
	type RelayHello,
	type RelayMetaRequest,
	type RelayResult,
} from "@lifediary/shared";
import type { WebSocket } from "ws";
import type { RelayStore } from "./store.ts";

/**
 * 中继枢纽（2026-11-05 多端同步方案块0）。
 *
 * 只做四件事：认人（hello）、按 dst 转发（deliver/result，覆写 src）、
 * 同设备顶替（新连接踢旧连接）、在场维护。channel/payload 对中继不透明——
 * 语义校验全部在被控端的通道白名单里，这里只看信封形状与帧长。
 *
 * 关闭码：4400 协议版本不符 / 4401 鉴权失败 / 4402 握手超时 / 4409 同设备顶替。
 */

const HELLO_TIMEOUT_MS = 15_000;
const CLEANUP_INTERVAL_MS = 60_000;

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

export class RelayHub {
	/** deviceId → 当前连接（同设备重连顶替，旧连接以 4409 关闭） */
	private conns = new Map<string, WebSocket & { hubInfo?: HubConnectionInfo }>();
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
		}
	}

	private sweep(): void {
		// 半开连接兜底：readyState 不是 OPEN 的清出名册（close 事件迟到的场景）
		for (const [deviceId, ws] of this.conns) {
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
