/**
 * 连接页「接入中继」的接入链路探针（2026-11-14 连接页三步方案）。
 *
 * 真起一个假中继 HTTP 服务（同三端点形状），走 joinRelay 的真实分支：
 * 地址错 / 连不上 / 令牌错 / 成功换令牌，再把「写盘 → 读回 → 转客户端配置」验一遍。
 *
 * 用独立 `RELAY_LINK_PATH`，不碰真仓库的 `.data/relay-link.json`。
 * 连不上分支用一个**临时监听过又关掉**的端口，保证是 ECONNREFUSED 而不是被防火墙拒。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RelayLinkError,
  clearRelayLink,
  joinRelay,
  readRelayLink,
  relaySettingsFromLink,
  writeRelayLink,
} from "../src/relay-link.ts";

const OWNER = "owner-token-for-probe";
const CODE = "R-probe-code-0123456789";
const DEVICE = "设备令牌-probe-device-token";
const DEVICE_NAME = "书房主机（探针）";

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address === "object" && address) resolve(address.port);
			else reject(new Error("端口未知"));
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** 假中继：只实现 joinRelay 用到的三端点。 */
function fakeRelay(): Server {
	return createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (req.method === "GET" && url.pathname === "/api/relay/info") {
			send(200, { name: "fake-relay", protocolVersion: 1, pairing: true, onlineDevices: 0 });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/relay/join-code") {
			if (req.headers.authorization !== `Bearer ${OWNER}`) {
				res.writeHead(403);
				res.end();
				return;
			}
			send(200, { joinCode: CODE, expiresAt: Date.now() + 600_000 });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/relay/join") {
			let text = "";
			req.on("data", (chunk) => {
				text += String(chunk);
			});
			req.on("end", () => {
				const body = JSON.parse(text || "{}") as { joinCode?: string; deviceName?: string };
				if (body.joinCode !== CODE) {
					res.writeHead(403);
					res.end();
					return;
				}
				send(200, { deviceId: "probe-device-id", deviceToken: DEVICE, protocolVersion: 1 });
			});
			return;
		}
		send(404, { error: "not_found" });
	});
}

async function main(): Promise<void> {
	const relay = fakeRelay();
	const port = await listen(relay);
	const base = `http://127.0.0.1:${port}`;
	let pass = 0;

	// 0. 拿一个"已经关掉"的端口，用来验证连不上
	const deadServer = createServer(() => undefined);
	const deadPort = await listen(deadServer);
	await close(deadServer);

	// 1. 地址不合法
	await assert.rejects(
		joinRelay({ address: "随便写的", ownerToken: OWNER }),
		(error: unknown) => error instanceof RelayLinkError && error.code === "bad_address",
	);
	console.log("ok 1 - 地址不合法 → bad_address");
	pass += 1;

	// 2. 地址上没有中继
	await assert.rejects(
		joinRelay({ address: `http://127.0.0.1:${deadPort}`, ownerToken: OWNER }),
		(error: unknown) => error instanceof RelayLinkError && error.code === "relay_unreachable",
	);
	console.log("ok 2 - 端口不通 → relay_unreachable");
	pass += 1;

	// 3. 主令牌不对
	await assert.rejects(
		joinRelay({ address: base, ownerToken: "wrong-token" }),
		(error: unknown) => error instanceof RelayLinkError && error.code === "relay_forbidden",
	);
	console.log("ok 3 - 主令牌不对 → relay_forbidden");
	pass += 1;

	// 4. 缺令牌（本地就拦下，不发请求）
	await assert.rejects(
		joinRelay({ address: base, ownerToken: "  " }),
		(error: unknown) => error instanceof RelayLinkError && error.code === "bad_token",
	);
	console.log("ok 4 - 没填主令牌 → bad_token");
	pass += 1;

	// 5. 成功：换到设备令牌
	const link = await joinRelay({ address: base, ownerToken: OWNER, deviceName: DEVICE_NAME });
	assert.equal(link.base, base);
	assert.equal(link.deviceToken, DEVICE);
	assert.equal(link.deviceName, DEVICE_NAME);
	console.log("ok 5 - 接入成功且拿到设备令牌");
	pass += 1;

	// 6. 写盘 → 读回（0600，且改过的地址会被规范化）
	const dir = mkdtempSync(join(tmpdir(), "relay-link-probe-"));
	const path = join(dir, "relay-link.json");
	const env = { RELAY_LINK_PATH: path } as NodeJS.ProcessEnv;
	try {
		writeRelayLink(link, env);
		const back = readRelayLink(env);
		assert.ok(back, "读回失败");
		assert.equal(back.deviceToken, DEVICE);
		assert.equal(back.ownerToken, OWNER);
		assert.equal(back.base, base);
		console.log("ok 6 - 落盘/读回一致");
		pass += 1;

		// 7. 转客户端配置：http → ws，且补 /ws
		const settings = relaySettingsFromLink(back);
		assert.equal(settings.url, `ws://127.0.0.1:${port}/ws`);
		assert.equal(settings.token, DEVICE);
		console.log("ok 7 - 客户端配置 http→ws 正确");
		pass += 1;

		// 8. 清掉
		clearRelayLink(env);
		assert.equal(readRelayLink(env), null);
		console.log("ok 8 - 断开后文件已删除");
		pass += 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	await close(relay);
	console.log(`\n# relay-link probe: ${pass}/8 通过`);
}

await main();
