import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayClient } from "./relay-client.ts";

/**
 * 中继客户端的心跳与半开检测（2026-11-14 稳定性补丁）。
 *
 * 背景见 relay-client.ts 文件头：握手后长时间没有出站帧时，家用宽带 / 运营商 NAT
 * 会在几十秒内回收"静默连接"，表现成"连上几十秒又掉、掉完又连上"。
 * 这组测试用假中继（本机 ws 服务，端口 0）验证两件事：
 * 1. 心跳真的在发，且链路一直活着（不产生重连）；
 * 2. 对端不回应（半开）时，客户端会按 livenessMs 主动断开并重连，而不是干等到超时。
 *
 * 不碰真中继、不落盘、不读 env：纯传输层行为。
 */

interface FakeRelay {
	url: string;
	close: () => Promise<void>;
	pings: () => number;
	pongs: () => number;
}

/** 假中继：hello → welcome；`replyPing=false` 时装死（模拟半开死链）。 */
async function startFakeRelay(options: { replyPing: boolean }): Promise<FakeRelay> {
	const wss = new WebSocketServer({ port: 0 });
	let pingCount = 0;
	let pongCount = 0;
	const sockets = new Set<WebSocket>();

	wss.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("message", (raw: Buffer) => {
			let frame: { kind?: string; token?: string } = {};
			try {
				frame = JSON.parse(raw.toString("utf8")) as { kind?: string; token?: string };
			} catch {
				return;
			}
			if (frame.kind === "ping") {
				pingCount += 1;
				if (options.replyPing) socket.send(JSON.stringify({ kind: "pong", at: Date.now() }));
				return;
			}
			if (frame.kind === "hello") {
				socket.send(JSON.stringify({ kind: "welcome", deviceId: "fake-device", devices: [] }));
			}
		});
		socket.on("close", () => {
			pongCount += 1;
			sockets.delete(socket);
		});
	});

	await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
	const port = (wss.address() as { port: number }).port;
	return {
		url: `ws://127.0.0.1:${port}`,
		pings: () => pingCount,
		pongs: () => pongCount,
		close: async () => {
			for (const socket of sockets) {
				try {
					socket.terminate();
				} catch {
					/* 已在关闭途中 */
				}
			}
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		},
	};
}

function makeClient(url: string, overrides: { heartbeatMs: number; livenessMs: number }): RelayClient {
	return new RelayClient({
		url,
		token: "secret-token",
		deviceName: "test-host",
		platform: "win32",
		capabilities: [],
		onInvoke: async () => null,
		heartbeatMs: overrides.heartbeatMs,
		livenessMs: overrides.livenessMs,
		log: () => {
			/* 测试里不刷屏 */
		},
	});
}

test("心跳：对端回 pong 时链路一直活着，不触发重连", async () => {
	const relay = await startFakeRelay({ replyPing: true });
	const client = makeClient(relay.url, { heartbeatMs: 40, livenessMs: 400 });
	try {
		client.start();
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(client.connected, true, "心跳正常时应保持连接");
		assert.equal(client.stats.reconnects, 0, "不应发生重连");
		assert.equal(client.stats.lastCloseCode, null, "不应有断开记录");
		assert.ok(relay.pings() >= 5, `心跳至少发 5 次，实际 ${relay.pings()} 次`);
		assert.ok(client.stats.lastPongAt !== null, "应收到过 pong");
	} finally {
		client.stop();
		await relay.close();
	}
});

test("半开检测：对端不回应时按 livenessMs 主动断开并重连", async () => {
	const relay = await startFakeRelay({ replyPing: false });
	const client = makeClient(relay.url, { heartbeatMs: 40, livenessMs: 120 });
	try {
		client.start();
		// 先等握手完成，再等一个 liveness 窗口（不回应 → 判死）
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.ok(client.stats.reconnects >= 1, "静默应被判成死链并重连");
		assert.notEqual(client.stats.lastCloseCode, null, "应记录关闭码");
	} finally {
		client.stop();
		await relay.close();
	}
});
