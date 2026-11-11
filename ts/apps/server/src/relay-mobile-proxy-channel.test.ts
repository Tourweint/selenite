import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ApprovalStore } from "./approvals.ts";
import {
	RELAY_INVOKE_CHANNELS,
	RELAY_MOBILE_PROXY_CHANNEL,
	RelayChannelHub,
	type RelayHttpRequest,
} from "./relay-channels.ts";

/**
 * mobile/proxy 通道（2026-11-11 批H H1）。
 *
 * 只验通道层的契约：白名单、原样转发、失败折成 HTTP 状态、开关关掉 = 通道不存在。
 * 真正的"app.request 内部调用"在 index.ts 装配，端到端由 scripts/mobile-proxy-probe.ts 覆盖。
 */

const approvals = {
	pendingOf: () => [],
	pendingAll: () => [],
	decide: () => null,
} as unknown as ApprovalStore;

function newHub(dispatch?: (request: RelayHttpRequest) => Promise<{ status: number; body: string }>) {
	const calls: RelayHttpRequest[] = [];
	const hub = new RelayChannelHub(
		{
			version: "test",
			listChats: async () => [],
			resolveInternalId: async () => null,
			externalOf: async () => null,
			sayInConversation: async () => true,
			eventStore: null,
			approvals: () => approvals,
			dispatchHttp: dispatch
				? async (request) => {
						calls.push(request);
						return dispatch(request);
					}
				: undefined,
		},
		() => {},
	);
	return { hub, calls };
}

const SAMPLE = {
	method: "GET",
	path: "/api/v1/agent/chats",
	query: "?limit=5",
	headers: { authorization: "Bearer phone-relay-token" },
	body: null,
};

afterEach(() => {
	delete process.env.RELAY_MOBILE_PROXY_ENABLED;
});

describe("mobile/proxy 通道", () => {
	it("白名单显式列出 mobile/proxy；未列出的通道仍被拒", async () => {
		assert.ok((RELAY_INVOKE_CHANNELS as readonly string[]).includes(RELAY_MOBILE_PROXY_CHANNEL));
		const { hub } = newHub(async () => ({ status: 200, body: "{}" }));
		await assert.rejects(
			() => hub.handle("peer-1", "admin/nuke", {}),
			(error: Error & { code?: string }) => error.code === "channel_not_allowed",
		);
	});

	it("原样把 method/path/query/headers/body 交给内部执行体，status 与正文原样回", async () => {
		const { hub, calls } = newHub(async () => ({ status: 200, body: '{"chats":[]}' }));
		const outcome = await hub.handleHttpInvoke({ ...SAMPLE, method: "POST", body: '{"text":"你好"}' });
		assert.equal(outcome.status, 200);
		assert.equal(outcome.body, '{"chats":[]}');
		assert.deepEqual(calls[0], { ...SAMPLE, method: "POST", body: '{"text":"你好"}' });
	});

	it("routed 帧走同一通道也返回 {status,body}", async () => {
		const { hub } = newHub(async () => ({ status: 201, body: "ok" }));
		const result = await hub.handle("peer-1", RELAY_MOBILE_PROXY_CHANNEL, SAMPLE);
		assert.deepEqual(result, { status: 201, body: "ok" });
	});

	it("RELAY_MOBILE_PROXY_ENABLED=off → 404 且不执行内部调用（fail-closed）", async () => {
		process.env.RELAY_MOBILE_PROXY_ENABLED = "off";
		const { hub, calls } = newHub(async () => ({ status: 200, body: "should-not-run" }));
		const outcome = await hub.handleHttpInvoke(SAMPLE);
		assert.equal(outcome.status, 404);
		assert.equal(JSON.parse(outcome.body).error, "not_found");
		assert.equal(calls.length, 0);
		await assert.rejects(
			() => hub.handle("peer-1", RELAY_MOBILE_PROXY_CHANNEL, SAMPLE),
			(error: Error & { code?: string }) => error.code === "channel_not_allowed",
		);
	});

	it("装配层没给执行体（= 通道未注册）→ 404", async () => {
		const { hub } = newHub();
		const outcome = await hub.handleHttpInvoke(SAMPLE);
		assert.equal(outcome.status, 404);
	});

	it("只放行 /api/v1 前缀；形状不对 → 400", async () => {
		const { hub, calls } = newHub(async () => ({ status: 200, body: "{}" }));
		const outside = await hub.handleHttpInvoke({ ...SAMPLE, path: "/pair" });
		assert.equal(outside.status, 400);
		const malformed = await hub.handleHttpInvoke({ method: "GET" });
		assert.equal(malformed.status, 400);
		assert.equal(calls.length, 0);
	});

	it("手机反代不许碰 join-code（否则任一已加入设备可继续发码拉新设备）", async () => {
		const { hub, calls } = newHub(async () => ({ status: 200, body: "should-not-run" }));
		const outcome = await hub.handleHttpInvoke({ ...SAMPLE, method: "POST", path: "/api/v1/relay/join-code" });
		assert.equal(outcome.status, 404);
		assert.equal(JSON.parse(outcome.body).error, "not_found");
		assert.equal(calls.length, 0);
	});

	it("内部执行抛错 → 500（不把异常细节带出去）", async () => {
		const { hub } = newHub(async () => {
			throw new Error("boom: /secret/path");
		});
		const outcome = await hub.handleHttpInvoke(SAMPLE);
		assert.equal(outcome.status, 500);
		assert.equal(outcome.body, '{"error":"internal_error"}');
	});
});
