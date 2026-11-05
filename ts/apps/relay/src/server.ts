import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { RELAY_PROTOCOL_VERSION } from "@lifediary/shared";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayHub } from "./hub.ts";
import { MAX_DEVICES, MAX_DESCRIPTION_LENGTH, RelayStore, type RedeemError } from "./store.ts";

/**
 * 中继服务装配（2026-11-05 多端同步方案块0）：HTTP(S) 同端口承载
 * REST 管理面 + WS `/ws` 信封隧道。REST 与 WS 共用一套 Bearer 凭证
 * （owner 令牌 / 设备令牌），鉴权失败一律 403 空体，业务拒绝才 400 带说明。
 */

const REDEEM_RATE_LIMIT_PER_MIN = 30;

export interface RelayServer {
	app: Hono;
	hub: RelayHub;
	store: RelayStore;
	server: Server;
	wss: WebSocketServer;
}

export interface RelayServerOptions {
	store?: RelayStore;
	hub?: RelayHub;
}

export function createRelayApp(store: RelayStore, hub: RelayHub): Hono {
	const app = new Hono();

	const isLoopback = (info: { address?: string; remote?: string }): boolean => {
		const raw = info.address ?? info.remote ?? "";
		return raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1";
	};

	const bearerOf = (header: string | undefined): string =>
		header?.startsWith("Bearer ") ? header.slice(7).trim() : "";

	/** owner：显式 RELAY_OWNER_TOKEN 匹配；未配令牌时 loopback 直通（同 AGENT_TOKEN 口径）。 */
	const isOwner = (c: { req: { header: (k: string) => string | undefined } }): boolean => {
		const ownerToken = store.ownerToken;
		if (!ownerToken) return isLoopback({ address: c.req.header("x-forwarded-for") ?? "127.0.0.1" });
		return bearerOf(c.req.header("authorization")) === ownerToken;
	};

	/** 设备凭证：deviceToken（verify 命中即刷新 lastSeenAt）。 */
	const deviceIdOf = (header: string | undefined): string | null => {
		const token = bearerOf(header);
		if (!token) return null;
		return store.verifyDeviceToken(token);
	};

	// 免鉴权探活（不含任何密钥）
	app.get("/api/relay/info", (c) =>
		c.json({
			name: "lifediary-relay",
			protocolVersion: RELAY_PROTOCOL_VERSION,
			pairing: true,
			onlineDevices: hub.onlineCount,
		}),
	);

	// 镜像控制台（2026-11-05 阶段一）：纯静态两件套，token 存 localStorage，
	// 通道与手机/CLI 控制端同一套白名单语义——这里是"控制端"的活样例。
	const wwwFile = (name: string): string =>
		readFileSync(new URL(`../www/${name}`, import.meta.url), "utf8");
	const wwwType: Record<string, string> = {
		"index.html": "text/html; charset=utf-8",
		"app.js": "text/javascript; charset=utf-8",
	};
	for (const name of Object.keys(wwwType)) {
		app.get(name === "index.html" ? "/" : `/${name}`, (c) =>
			c.body(wwwFile(name), 200, { "content-type": wwwType[name] }),
		);
	}

	// 加入码签发：owner only
	app.post("/api/relay/pair/code", (c) => {
		if (!isOwner(c)) return c.body(null, 403);
		const { code, expiresAt } = store.issueCode();
		return c.json({ code, expiresAt, ttlSecondsHint: expiresAt - Date.now() });
	});

	// 加入码兑换：免（码本身即凭证）
	const redeemAttempts = new Map<string, { count: number; resetAt: number }>();
	app.post("/api/relay/pair/redeem", async (c) => {
		const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
		const now = Date.now();
		const entry = redeemAttempts.get(ip);
		if (!entry || entry.resetAt <= now) {
			redeemAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
		} else if (entry.count >= REDEEM_RATE_LIMIT_PER_MIN) {
			return c.json({ error: "too_many_attempts" }, 429);
		} else {
			entry.count += 1;
		}

		let body: { code?: unknown; deviceName?: unknown; platform?: unknown; capabilities?: unknown };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "bad_request" }, 400);
		}
		const code = typeof body.code === "string" ? body.code : "";
		if (!code) return c.json({ error: "bad_request" }, 400);
		const deviceName = typeof body.deviceName === "string" ? body.deviceName : "";
		const platform = typeof body.platform === "string" ? body.platform : "unknown";
		const capabilities = Array.isArray(body.capabilities)
			? body.capabilities.filter((item): item is string => typeof item === "string").slice(0, 16)
			: [];

		const outcome = store.redeem(code, deviceName, platform, capabilities);
		if (typeof outcome === "string") {
			const status: Record<RedeemError, 404 | 409 | 410 | 429> = {
				unknown_code: 404,
				code_used: 409,
				code_expired: 410,
				too_many_attempts: 429,
			};
			return c.json({ error: outcome }, status[outcome]);
		}
		return c.json({
			deviceId: outcome.deviceId,
			deviceToken: outcome.deviceToken,
			protocolVersion: RELAY_PROTOCOL_VERSION,
		});
	});

	// 名册：owner 或已配设备可看（不含任何令牌哈希）
	app.get("/api/relay/devices", (c) => {
		const asOwner = isOwner(c);
		const deviceId = asOwner ? null : deviceIdOf(c.req.header("authorization"));
		if (!asOwner && !deviceId) return c.body(null, 403);
		return c.json({ devices: store.listDevices(Date.now(), hub.onlineIds) });
	});

	// 改名：owner 或该设备自己（改名自己的名字）。UTF-8 由 JSON 解析保证，GBA 终端直发中文会坏是客户端的坑
	app.post("/api/relay/devices/:id/name", async (c) => {
		const asOwner = isOwner(c);
		const selfId = asOwner ? null : deviceIdOf(c.req.header("authorization"));
		const id = c.req.param("id");
		if (!asOwner && selfId !== id) return c.body(null, 403);
		const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
		const name = typeof body?.name === "string" ? body.name : "";
		if (!name.trim()) return c.json({ error: "bad_request", message: "需要 name" }, 400);
		return c.json({ ok: store.renameDevice(id, name) });
	});

	// 撤销：owner only；撤销后该设备令牌立即失效且在线连接被踢
	app.post("/api/relay/devices/:id/revoke", (c) => {
		if (!isOwner(c)) return c.body(null, 403);
		const id = c.req.param("id");
		const ok = store.revokeDevice(id);
		hub.disconnectDevice(id);
		return c.json({ ok });
	});

	// ── 任务主机位 / 设备描述（2026-11-05 主机优先制）──────────────
	// 鉴权口径与名册一致：owner 或任一已配对设备令牌（管理面 / 手机设置页都能设）。
	// 非法 id 是业务拒绝（400 带说明），不混进 403（403 只给鉴权失败）。
	const allowOwnerOrDevice = (c: Parameters<typeof isOwner>[0]): boolean => {
		if (isOwner(c)) return true;
		return deviceIdOf(c.req.header("authorization")) !== null;
	};

	app.post("/api/relay/home-device", async (c) => {
		if (!allowOwnerOrDevice(c)) return c.body(null, 403);
		const body = (await c.req.json().catch(() => null)) as { deviceId?: unknown } | null;
		const raw = body?.deviceId;
		// null = 清除；字符串 = 设成这台。缺字段/类型不对按坏请求拒。
		if (raw !== null && typeof raw !== "string") {
			return c.json({ error: "bad_request", message: "deviceId 需要字符串或 null" }, 400);
		}
		if (!store.setHomeDevice(raw)) {
			return c.json({ error: "unknown_device", message: "deviceId 不在名册里" }, 400);
		}
		return c.json({ ok: true, homeDeviceId: store.homeDeviceId() });
	});

	app.post("/api/relay/devices/:id/description", async (c) => {
		if (!allowOwnerOrDevice(c)) return c.body(null, 403);
		const body = (await c.req.json().catch(() => null)) as { description?: unknown } | null;
		if (typeof body?.description !== "string") {
			return c.json({ error: "bad_request", message: "需要 description 字符串" }, 400);
		}
		const text = body.description.trim();
		if (text.length > MAX_DESCRIPTION_LENGTH) {
			return c.json({ error: "bad_request", message: `描述最多 ${MAX_DESCRIPTION_LENGTH} 字` }, 400);
		}
		const id = c.req.param("id");
		if (!store.setDescription(id, text)) {
			return c.json({ error: "unknown_device", message: "deviceId 不在名册里" }, 400);
		}
		return c.json({ ok: true, deviceId: id, description: text });
	});

	return app;
}

/** HTTP + WS 同端口装配。不 listen——由 index.ts / 测试各自决定端口。 */
export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
	const store = options.store ?? new RelayStore();
	const hub = options.hub ?? new RelayHub(store);
	const app = createRelayApp(store, hub);
	const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
	const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket as never, head, (ws: WebSocket) => hub.attach(ws));
	});

	hub.start();
	return { app, hub, store, server, wss };
}

export { MAX_DEVICES };
