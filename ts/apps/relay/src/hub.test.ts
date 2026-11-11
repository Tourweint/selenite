import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WebSocket } from "ws";
import type { RelayErrorFrame, RelayResult, RelayRouted, RelayWelcome } from "@lifediary/shared";
import { createRelayServer, type RelayServer } from "./server.ts";
import { RelayStore } from "./store.ts";

interface Client {
	deviceId: string;
	opened: Promise<void>;
	next: (timeoutMs?: number) => Promise<unknown>;
	closed: Promise<{ code: number; reason: string }>;
	send: (frame: unknown) => void;
	close: () => void;
}

const servers: RelayServer[] = [];

function startRelay(): { relay: RelayServer; port: number } {
	const store = new RelayStore(join(mkdtempSync(join(tmpdir(), "relay-hub-")), `${randomUUID()}.json`));
	const relay = createRelayServer({ store });
	relay.server.listen(0);
	const address = relay.server.address();
	assert.ok(address && typeof address === "object");
	const port = address.port;
	servers.push(relay);
	return { relay, port };
}

async function pairDevice(relay: RelayServer, port: number, name: string, platform = "test"): Promise<string> {
	const codeRes = await fetch(`http://127.0.0.1:${port}/api/relay/pair/code`, { method: "POST" });
	assert.equal(codeRes.status, 200);
	const { code } = (await codeRes.json()) as { code: string };
	const redeemRes = await fetch(`http://127.0.0.1:${port}/api/relay/pair/redeem`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, deviceName: name, platform, capabilities: ["test"] }),
	});
	assert.equal(redeemRes.status, 200);
	const body = (await redeemRes.json()) as { deviceToken: string; deviceId: string };
	assert.ok(body.deviceToken);
	return body.deviceToken;
}

function connectClient(port: number, token: string): Client {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const queue: unknown[] = [];
	const waiters: Array<(value: unknown) => void> = [];
	ws.on("message", (raw: Buffer) => {
		const message = JSON.parse(raw.toString("utf8")) as unknown;
		// 2026-11-11 批R R3：presence 是纯增量帧，老客户端按协议约定静默忽略。
		// 这里照同一个语义跳过——否则每条既有用例都要多吞一帧欢迎后的名册广播。
		if ((message as { kind?: string } | null)?.kind === "presence") return;
		const waiter = waiters.shift();
		if (waiter) waiter(message);
		else queue.push(message);
	});
	const opened = new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
	});
	return {
		deviceId: "",
		opened,
		next: (timeoutMs = 2_000) =>
			new Promise<unknown>((resolve, reject) => {
				if (queue.length > 0) {
					resolve(queue.shift());
					return;
				}
				const timer = setTimeout(() => reject(new Error("等待消息超时")), timeoutMs);
				waiters.push((value) => {
					clearTimeout(timer);
					resolve(value);
				});
			}),
		closed,
		send: (frame: unknown) => ws.send(JSON.stringify(frame)),
		close: () => ws.close(),
	};
}

/** 连接并完成 hello 握手，回填 welcome。 */
async function handshake(port: number, token: string): Promise<Client> {
	const client = connectClient(port, token);
	await client.opened;
	client.send({ kind: "hello", v: 1, token, deviceName: "测试机", platform: "test", capabilities: ["test"] });
	const welcome = (await client.next()) as RelayWelcome;
	assert.equal(welcome.kind, "welcome");
	client.deviceId = welcome.deviceId;
	return client;
}

afterEach(() => {
	for (const relay of servers.splice(0)) {
		relay.hub.stop();
		relay.server.close();
	}
});

describe("RelayHub 信封路由", () => {
	it("hello→welcome；deliver 盖章转发；result 原路送回", async () => {
		const { relay, port } = startRelay();
		const tokenA = await pairDevice(relay, port, "A");
		const tokenB = await pairDevice(relay, port, "B");
		const a = await handshake(port, tokenA);
		const b = await handshake(port, tokenB);

		a.send({ kind: "deliver", id: "m1", dst: b.deviceId, channel: "test/echo", payload: { n: 42 } });
		const routed = (await b.next()) as RelayRouted;
		assert.equal(routed.kind, "routed");
		assert.equal(routed.src, a.deviceId);
		assert.equal(routed.channel, "test/echo");
		assert.deepEqual(routed.payload, { n: 42 });

		b.send({ kind: "result", id: "m1", dst: a.deviceId, ok: true, result: { echoed: 42 } });
		const result = (await a.next()) as RelayResult;
		assert.equal(result.kind, "result");
		assert.equal(result.ok, true);
		assert.deepEqual(result.result, { echoed: 42 });

		a.close();
		b.close();
	});

	it("目标离线 / 不在名册 → 同步错误帧", async () => {
		const { relay, port } = startRelay();
		const tokenA = await pairDevice(relay, port, "A");
		const tokenGhost = await pairDevice(relay, port, "幽灵"); // 配了对但从不上线
		const a = await handshake(port, tokenA);

		a.send({ kind: "deliver", id: "m2", dst: "00000000", channel: "test/x", payload: null });
		const unknown = (await a.next()) as RelayErrorFrame;
		assert.equal(unknown.code, "unknown_device");

		const ghostToken = tokenGhost;
		void ghostToken;
		// 幽灵设备在名册但不在线：先拿它的 deviceId（靠 A 的 welcome 快照）
		// —— 通过管理面（loopback 免 owner）查名册
		const devicesRes = await fetch(`http://127.0.0.1:${port}/api/relay/devices`);
		assert.equal(devicesRes.status, 200);
		const { devices } = (await devicesRes.json()) as { devices: Array<{ id: string; online: boolean }> };
		const ghostId = devices.find((d) => d.online === false)!.id;
		a.send({ kind: "deliver", id: "m3", dst: ghostId, channel: "test/x", payload: null });
		const offline = (await a.next()) as RelayErrorFrame;
		assert.equal(offline.code, "device_offline");
		a.close();
	});

	it("同设备重连顶替旧连接（4409）", async () => {
		const { relay, port } = startRelay();
		const token = await pairDevice(relay, port, "顶替机");
		const first = await handshake(port, token);
		const second = await handshake(port, token);
		const closed = await first.closed;
		assert.equal(closed.code, 4409);
		assert.equal(relay.hub.isOnline(second.deviceId), true);
		second.close();
	});

	it("坏令牌 hello → 4401 关闭", async () => {
		const { port } = startRelay();
		const client = connectClient(port, "not-a-token");
		await client.opened;
		client.send({ kind: "hello", v: 1, token: "not-a-token", deviceName: "x", platform: "test" });
		const closed = await client.closed;
		assert.equal(closed.code, 4401);
	});

	it("dst 指向自己 → bad_request 不自环", async () => {
		const { relay, port } = startRelay();
		const token = await pairDevice(relay, port, "自环机");
		const a = await handshake(port, token);
		a.send({ kind: "deliver", id: "m4", dst: a.deviceId, channel: "test/x", payload: null });
		const error = (await a.next()) as RelayErrorFrame;
		assert.equal(error.code, "bad_request");
		a.close();
		void relay;
	});

	it("撤销设备 → 在线连接被踢（4401），令牌失效", async () => {
		const { relay, port } = startRelay();
		const token = await pairDevice(relay, port, "待撤机");
		const a = await handshake(port, token);
		const revokeRes = await fetch(`http://127.0.0.1:${port}/api/relay/devices/${a.deviceId}/revoke`, {
			method: "POST",
		});
		assert.equal(revokeRes.status, 200);
		const closed = await a.closed;
		assert.equal(closed.code, 4401);
		assert.equal(relay.store.verifyDeviceToken(token), null);
	});

	it("兑换限流：同 IP 每分钟超 30 次 → 429", async () => {
		const { relay, port } = startRelay();
		let last = 0;
		for (let i = 0; i < 31; i += 1) {
			const res = await fetch(`http://127.0.0.1:${port}/api/relay/pair/redeem`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code: "000000", deviceName: "x", platform: "test" }),
			});
			last = res.status;
		}
		assert.equal(last, 429);
		void relay;
	});
});
