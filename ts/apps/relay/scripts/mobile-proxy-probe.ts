import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
	RELAY_PROTOCOL_VERSION,
	type RelayInvokeFrame,
	type RelayInvokePayload,
	type RelayWelcome,
} from "@lifediary/shared";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { RelayStore } from "../src/store.ts";

/**
 * 中继手机代理面探针（2026-11-11 批R）。
 *
 * 真起 relay（随机端口 + 临时名册），用一条 WS 连接冒充"书房主机"应答 invoke，
 * 逐项验：反代透传 / 离线 502 / 超时 504 / 扫码加入全流程 / presence 广播 / 回滚开关。
 * 不是 mock 单测——HTTP、WS、鉴权、落盘全部走真实路径。
 *
 * 跑法：pnpm --filter @lifediary/relay exec tsx scripts/mobile-proxy-probe.ts
 */

let failures = 0;

function check(ok: boolean, label: string, detail = ""): void {
	const line = `${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`;
	if (ok) console.log(line);
	else {
		failures += 1;
		console.error(line);
	}
}

interface Frame {
	kind?: string;
	[key: string]: unknown;
}

interface Waiter {
	test: (frame: Frame) => boolean;
	resolve: (frame: Frame) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class Client {
	deviceId = "";
	/** 收到每一帧时的旁路钩子（探针用它冒充主机应答 invoke） */
	onFrame: ((frame: Frame) => void) | null = null;
	private frames: Frame[] = [];
	private waiters: Waiter[] = [];

	private constructor(
		readonly ws: WebSocket,
		readonly label: string,
	) {
		ws.on("message", (raw: Buffer) => {
			let frame: Frame;
			try {
				frame = JSON.parse(raw.toString("utf8")) as Frame;
			} catch {
				return;
			}
			this.onFrame?.(frame);
			const index = this.waiters.findIndex((waiter) => waiter.test(frame));
			if (index >= 0) {
				const [waiter] = this.waiters.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(frame);
				return;
			}
			this.frames.push(frame);
		});
	}

	static async connect(
		port: number,
		token: string,
		deviceName: string,
		platform: string,
	): Promise<Client> {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const client = new Client(ws, deviceName);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		ws.send(
			JSON.stringify({
				kind: "hello",
				v: RELAY_PROTOCOL_VERSION,
				token,
				deviceName,
				platform,
				capabilities: [],
			}),
		);
		const welcome = (await client.waitFor("welcome")) as unknown as RelayWelcome;
		client.deviceId = welcome.deviceId;
		return client;
	}

	send(frame: unknown): void {
		this.ws.send(JSON.stringify(frame));
	}

	waitFor(kind: string, test: (frame: Frame) => boolean = () => true, timeoutMs = 4_000): Promise<Frame> {
		const predicate = (frame: Frame) => frame.kind === kind && test(frame);
		const index = this.frames.findIndex(predicate);
		if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);
		return new Promise<Frame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((item) => item.timer !== timer);
				reject(new Error(`${this.label} 等待 ${kind} 超时`));
			}, timeoutMs);
			this.waiters.push({
				test: predicate,
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
				reject,
				timer,
			});
		});
	}

	async close(): Promise<void> {
		if (this.ws.readyState === WebSocket.CLOSED) return;
		const closed = new Promise<void>((resolve) => this.ws.once("close", () => resolve()));
		this.ws.close();
		await closed;
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const storeDir = mkdtempSync(join(tmpdir(), "relay-mobile-proxy-"));
	const relay: RelayServer = createRelayServer({
		store: new RelayStore(join(storeDir, "relay-state.json")),
	});
	relay.server.listen(0);
	const address = relay.server.address();
	assert.ok(address && typeof address === "object");
	const port = address.port;
	const base = `http://127.0.0.1:${port}`;

	const request = async (
		path: string,
		init: RequestInit = {},
		token?: string,
	): Promise<{ status: number; text: string; json: () => unknown }> => {
		const headers = new Headers(init.headers);
		if (token) headers.set("authorization", `Bearer ${token}`);
		const res = await fetch(`${base}${path}`, { ...init, headers });
		const text = await res.text();
		return {
			status: res.status,
			text,
			json: () => JSON.parse(text) as unknown,
		};
	};

	try {
		// ── 准备：一台"书房主机"（旧配对码路径，与批R 无关，只为造设备）────
		const codeRes = await request("/api/relay/pair/code", { method: "POST" });
		assert.equal(codeRes.status, 200);
		const pairCode = (codeRes.json() as { code: string }).code;
		const redeemRes = await request("/api/relay/pair/redeem", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: pairCode, deviceName: "书房主机", platform: "windows" }),
		});
		assert.equal(redeemRes.status, 200);
		const hostAuth = redeemRes.json() as { deviceId: string; deviceToken: string };

		const host = await Client.connect(port, hostAuth.deviceToken, "书房主机", "windows");
		check(host.deviceId === hostAuth.deviceId, "主机 WS hello → welcome", `deviceId=${host.deviceId}`);

		const homeRes = await request(
			"/api/relay/home-device",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deviceId: host.deviceId }),
			},
			hostAuth.deviceToken,
		);
		check(
			homeRes.status === 200 && (homeRes.json() as { homeDeviceId?: string }).homeDeviceId === host.deviceId,
			"设任务主机位（反代默认路由目标）",
		);

		// 主机应答 invoke：/echo 回 201，其余 200；silent 模式不回（验 504）
		let hostMode: "reply" | "silent" = "reply";
		const invocations: RelayInvokePayload[] = [];
		host.onFrame = (frame) => {
			if (frame.kind !== "invoke") return;
			const invoke = frame as unknown as RelayInvokeFrame;
			invocations.push(invoke.payload);
			if (hostMode === "silent") return;
			const status = invoke.payload.path.endsWith("/echo") ? 201 : 200;
			const body = JSON.stringify({
				ok: true,
				method: invoke.payload.method,
				path: invoke.payload.path,
				query: invoke.payload.query,
				auth: invoke.payload.headers.authorization ?? null,
				received: invoke.payload.body,
			});
			host.send({ kind: "invoke_result", id: invoke.id, payload: { status, body } });
		};

		// ── R1：鉴权 / 离线 / 透传 ───────────────────────────────
		const noAuth = await request("/api/v1/healthz");
		check(noAuth.status === 403 && noAuth.text === "", "反代无令牌 → 403 空体");

		const badToken = await request("/api/v1/healthz", {}, "not-a-device-token");
		check(badToken.status === 403, "反代坏令牌 → 403 空体");

		// ── R2：加入码 → join → 第二次用 403 ─────────────────────
		const joinCodeRes = await request("/api/relay/join-code", { method: "POST" });
		const issued = joinCodeRes.json() as { joinCode: string; expiresAt: number };
		check(joinCodeRes.status === 200 && issued.joinCode.length === 43, "join-code 签发（256 位 base64url）", `len=${issued.joinCode.length}`);
		const ttlMs = issued.expiresAt - Date.now();
		check(ttlMs > 590_000 && ttlMs <= 600_000, "join-code TTL = 10 分钟", `ttl=${Math.round(ttlMs / 1000)}s`);

		const joinRes = await request("/api/relay/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ joinCode: issued.joinCode, deviceName: "手机", platform: "android" }),
		});
		const joined = joinRes.json() as { deviceId: string; deviceToken: string; protocolVersion: number };
		check(
			joinRes.status === 200 && !!joined.deviceToken && joined.protocolVersion === RELAY_PROTOCOL_VERSION,
			"join 换 deviceToken（只回一次）",
			`deviceId=${joined.deviceId}`,
		);

		const reuse = await request("/api/relay/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ joinCode: issued.joinCode, deviceName: "手机2", platform: "android" }),
		});
		check(reuse.status === 403 && reuse.text === "", "同一加入码第二次用 → 403 空体");

		const phone = await Client.connect(port, joined.deviceToken, "手机", "android");
		check(phone.deviceId === joined.deviceId, "join 拿到的 deviceToken 可连 WS（hello 验证）");

		const presenceRes = await host.waitFor(
			"presence",
			(frame) => (frame.devices as Array<{ id: string; online: boolean }>).some((d) => d.id === phone.deviceId && d.online),
			4_000,
		);
		const presenceDevices = presenceRes.devices as Array<{ id: string; online: boolean }>;
		check(presenceDevices.length >= 2, "手机 hello → 其他连接收到 presence（在线位）", `devices=${presenceDevices.length}`);

		const getRes = await request("/api/v1/healthz?probe=1", {}, joined.deviceToken);
		const getBody = getRes.json() as {
			method: string;
			path: string;
			query: string;
			auth: string;
			received: string | null;
		};
		check(getRes.status === 200, "反代 GET 透传 200");
		check(
			getBody.method === "GET" && getBody.path === "/api/v1/healthz" && getBody.query === "?probe=1",
			"invoke 帧路径/查询串原文",
			`${getBody.method} ${getBody.path}${getBody.query}`,
		);
		check(
			getBody.received === null && getBody.auth === `Bearer ${joined.deviceToken}`,
			"invoke 帧 body=null、authorization 原样（不替换成 harness 令牌）",
		);

		const postRes = await request(
			"/api/v1/echo",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ hello: "世界" }),
			},
			joined.deviceToken,
		);
		const postBody = postRes.json() as { received: string | null };
		check(
			postRes.status === 201 && postBody.received === JSON.stringify({ hello: "世界" }),
			"反代 POST 原样透传 status/正文（含 UTF-8）",
			`status=${postRes.status}`,
		);
		check(invocations.length === 2, "主机实际收到 2 条 invoke", `count=${invocations.length}`);

		// ── 超时 504 ────────────────────────────────────────────
		hostMode = "silent";
		const timeoutStartedAt = Date.now();
		const timeoutRes = await request("/api/v1/healthz", {}, joined.deviceToken);
		const elapsedMs = Date.now() - timeoutStartedAt;
		check(
			timeoutRes.status === 504 && (timeoutRes.json() as { error?: string }).error === "device_timeout",
			"主机不回应 → 504 device_timeout",
			`${elapsedMs}ms`,
		);
		check(elapsedMs >= 14_500, "超时口径 15 秒", `${elapsedMs}ms`);
		hostMode = "reply";

		// ── presence：手机下线 ─────────────────────────────────
		await phone.close();
		const byePresence = await host.waitFor(
			"presence",
			(frame) => (frame.devices as Array<{ id: string; online: boolean }>).some((d) => d.id === joined.deviceId && !d.online),
			4_000,
		);
		check(!!byePresence.kind, "手机断开 → presence 带在线位 false");

		// ── 目标主机离线 → 502 ─────────────────────────────────
		await host.close();
		for (let i = 0; i < 80 && relay.hub.isOnline(host.deviceId); i += 1) await sleep(25);
		check(!relay.hub.isOnline(host.deviceId), "主机连接已断开");
		const offlineRes = await request("/api/v1/healthz", {}, joined.deviceToken);
		check(
			offlineRes.status === 502 && (offlineRes.json() as { error?: string }).error === "device_offline",
			"主机不在线 → 502 device_offline",
			`status=${offlineRes.status}`,
		);

		// ── 回滚开关：RELAY_MOBILE_PROXY_ENABLED=off → 整段 404 ─
		process.env.RELAY_MOBILE_PROXY_ENABLED = "off";
		const flaggedProxy = await request("/api/v1/healthz", {}, joined.deviceToken);
		const flaggedJoinCode = await request("/api/relay/join-code", { method: "POST" });
		delete process.env.RELAY_MOBILE_PROXY_ENABLED;
		check(flaggedProxy.status === 404 && flaggedJoinCode.status === 404, "RELAY_MOBILE_PROXY_ENABLED=off → 反代与加入码都 404");
	} finally {
		relay.hub.stop();
		relay.server.close();
		delete process.env.RELAY_MOBILE_PROXY_ENABLED;
	}

	if (failures > 0) {
		console.error(`\n[probe] 失败 ${failures} 项`);
		process.exitCode = 1;
		return;
	}
	console.log("\n[probe] 全项通过");
}

await main();
