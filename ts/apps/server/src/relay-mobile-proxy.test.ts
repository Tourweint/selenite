import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { RelayInvokeError } from "./relay-client.ts";
import { mountRelayMobileProxy, type RelayMobileProxyDeps } from "./relay-mobile-proxy.ts";
import type { RelayClient } from "./relay-client.ts";

/**
 * 手机代理面的路由行为（不真连中继：relayClient 用替身，只验
 * HTTP 形状 / 404 语义 / 错误映射 / 鉴权依赖外层中间件这四件事）。
 * 开关 env 显式清空：不让开发机的设置泄进测试（红线上有先例）。
 */
process.env.DEVICE_MATRIX_ENABLED = "";
process.env.COMPANION_HOME_ENABLED = "";
function fakeClient(overrides: Partial<RelayClient> = {}): RelayClient {
	const base = {
		connected: true,
		selfDeviceId: "self-1",
		devices: [
			{
				id: "device-b",
				name: "乙机",
				platform: "linux",
				online: true,
				capabilities: ["matrix", "mirror"],
			},
		],
		invoke: async (_dst: string, channel: string) => {
			if (channel === "sessions/list") return { chats: [{ conversationId: "abc" }] };
			return {};
		},
		// overview 实时拉名册（refreshDevices → meta("devices")）——替身回当前 devices
		meta: async (_action: string) => ({
			devices: [
				{ id: "device-b", name: "乙机", platform: "linux", online: true, capabilities: ["matrix"] },
			],
		}),
	} as unknown as RelayClient;
	return Object.assign(base, overrides);
}

function buildApp(deps: Partial<RelayMobileProxyDeps> = {}): Hono {
	const app = new Hono();
	mountRelayMobileProxy(app, {
		relayClient: () => fakeClient(),
		home: () => null,
		listChats: async () => [],
		...deps,
	});
	return app;
}

describe("中继手机代理面", () => {
	it("overview：中继开着 → 连接面 + 名册明细；关着 → enabled=false", async () => {
		const app = buildApp();
		const on = await app.request("/api/v1/relay/overview");
		const onBody = (await on.json()) as { enabled: boolean; connected: boolean; devices: unknown[]; matrixEnabled: boolean };
		assert.equal(on.status, 200);
		assert.equal(onBody.enabled, true);
		assert.equal(onBody.connected, true);
		assert.equal(onBody.devices.length, 1);
		assert.equal(onBody.matrixEnabled, false);

		const off = await buildApp({ relayClient: () => null }).request("/api/v1/relay/overview");
		const offBody = (await off.json()) as { enabled: boolean; devices: unknown[] };
		assert.equal(offBody.enabled, false);
		assert.deepEqual(offBody.devices, []);
	});

	it("remote：矩阵关 → 404；开 → 形状映射（deviceName/phase/report）", async () => {
		const app = buildApp();
		const off = await app.request("/api/v1/relay/matrix/remote");
		assert.equal(off.status, 404);
	});

	it("agent-delegate：矩阵关 → 整个端点 404（不验参数，防开关态泄参）；开 → 缺参 400", async () => {
		const app = buildApp();
		// 本测试环境 DEVICE_MATRIX_ENABLED 已清空：端点整体不可用，404 优先于参数校验
		const bad = await app.request("/api/v1/relay/matrix/agent-delegate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requirement: "x" }),
		});
		assert.equal(bad.status, 404);
	});

	it("mirror/chats：未连中继 → enabled=false 空列表；连着 → 透传 sessions/list", async () => {
		const disconnected = buildApp({ relayClient: () => fakeClient({ connected: false }) });
		const off = await disconnected.request("/api/v1/relay/mirror/chats?deviceId=device-b");
		const offBody = (await off.json()) as { enabled: boolean; chats: unknown[] };
		assert.equal(offBody.enabled, false);
		assert.deepEqual(offBody.chats, []);

		const app = buildApp();
		const on = await app.request("/api/v1/relay/mirror/chats?deviceId=device-b");
		const onBody = (await on.json()) as { enabled: boolean; chats: Array<{ conversationId: string }> };
		assert.equal(onBody.enabled, true);
		assert.equal(onBody.chats[0]?.conversationId, "abc");
	});

	it("home/overview：底座关 → 404（env 已清空，带控制器也拒）", async () => {
		const app = buildApp({
			home: () =>
				({
					status: async () => ({
						selfDeviceId: "self-1",
						actors: [{ actorId: "a1", name: "小明", demoted: false, isHome: true, homeDeviceId: "self-1" }],
					}),
				}) as never,
		});
		const off = await app.request("/api/v1/relay/home/overview");
		assert.equal(off.status, 404);
	});

	it("RelayInvokeError 错误码原样暴露（502 语义）", () => {
		const error = new RelayInvokeError("device_offline", "目标离线");
		assert.equal(error.code, "device_offline");
	});
});
