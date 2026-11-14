import type { Hono } from "hono";
import QRCode from "qrcode";
import type { RelayClient } from "./relay-client.ts";
import {
	listRemoteDelegations,
	dispatchRemoteDelegation,
} from "./relay-matrix.ts";
import { RelayInvokeError } from "./relay-client.ts";
import {
	companionHomeController,
	type CompanionHomeController,
} from "./relay-home.ts";
import {
	companionHomeEnabled,
	deviceAutoDispatchEnabled,
	deviceMatrixEnabled,
	normalizeRelayHttpBase,
	relayHttpBase,
	relayMobileProxyEnabled,
} from "./relay-config.ts";
import { externalChatIds, sayInConversation } from "./agent.ts";
import type { ChatIndexEntry } from "./agent.ts";
import { relayLinkHttpBase, relayOwnerToken } from "./relay-link.ts";

/**
 * 中继的手机代理面（2026-11-05 手机端对接，方案 §四阶段一/二客户端）。
 *
 * 取舍：v1 手机**不直接连中继 WS**——Kotlin 侧信封/重连/顶替是一整套新链路，
 * 而手机与自家 harness 之间已有走稳的 HTTP+Bearer 通道。所以跨设备信息
 * （名册 / 中继状态 / 远端单 / 执事归属）由 harness 经本文件代理成普通
 * REST（复用 `/api/v1` 鉴权与 403 口径），手机零新协议。WS 直连中继是
 * 手机端后续演进项，不是缺口。
 *
 * 派活入口也在这里：`/relay/matrix/agent-delegate` 用手机发来的
 * `conversationId` 当发起会话（电脑替手机派活，进度事件/终态汇报自然
 * 回到该会话，手机回读 transcript 就能看到）。
 */

export interface RelayMobileProxyDeps {
	relayClient: () => RelayClient | null;
	home: () => CompanionHomeController | null;
	listChats: (limit?: number) => Promise<ChatIndexEntry[]>;
}

export function mountRelayMobileProxy(app: Hono, deps: RelayMobileProxyDeps): void {
	// 中继连接状态（与 /relay/status 同源，但加设备名册明细）
	app.get("/api/v1/relay/overview", async (c) => {
		const client = deps.relayClient();
		if (!client) return c.json({ enabled: false, connected: false, devices: [] });
		// 设置页每次打开都看到当下：实时拉名册（welcome 快照会过期）；
		// refreshDevices 是客户端实例方法，替身/老实现没有时静默跳过用旧快照
		if (typeof client.refreshDevices === "function") {
			await client.refreshDevices().catch(() => {});
		}
		return c.json({
			enabled: true,
			connected: client.connected,
			selfDeviceId: client.selfDeviceId,
			devices: client.devices,
			matrixEnabled: deviceMatrixEnabled(),
			homeEnabled: companionHomeEnabled(),
		});
	});

	// 远端单列表（发起端视角；手机任务中心/设置页用）
	app.get("/api/v1/relay/matrix/remote", (c) => {
		if (!deviceMatrixEnabled()) return c.json({ error: "not_available" }, 404);
		const rows = listRemoteDelegations();
		return c.json({
			delegations: rows.map((row) => ({
				requestId: row.requestId,
				deviceName: row.targetDeviceName,
				ticketId: row.targetTicketId,
				phase: row.phase,
				report: row.report ?? null,
				updatedAt: row.updatedAt,
			})),
		});
	});

	// 手机跨机派活：手机给出自己会话的 uuid，电脑替它点名远端设备；
	// 进度事件与终态汇报写进该会话（手机回读 transcript 即见）。
	app.post("/api/v1/relay/matrix/agent-delegate", async (c) => {
		const client = deps.relayClient();
		if (!client || !deviceMatrixEnabled()) return c.json({ error: "not_available" }, 404);
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const targetDeviceId = typeof body?.targetDeviceId === "string" ? body.targetDeviceId : "";
		const requirement = typeof body?.requirement === "string" ? body.requirement.trim() : "";
		const conversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
		const project = typeof body?.project === "string" ? body.project : undefined;
		const domain = typeof body?.domain === "string" ? body.domain : undefined;
		if (!targetDeviceId || !requirement || !conversationId) {
			return c.json({ error: "bad_request", message: "需要 targetDeviceId / requirement / conversationId" }, 400);
		}
		// "auto" 第三态（2026-11-05 自动分发）：开关关着按非法参数拒绝。
		if (targetDeviceId === "auto" && !deviceAutoDispatchEnabled()) {
			return c.json({ error: "auto_disabled", message: "自动挑机未开启（DEVICE_AUTO_DISPATCH）" }, 400);
		}
		let originInternalId: number | null = null;
		for (const [internal, external] of await externalChatIds()) {
			if (external === conversationId) originInternalId = internal;
		}
		if (originInternalId === null) return c.json({ error: "unknown_conversation" }, 404);
		try {
			const result = await dispatchRemoteDelegation(client, {
				targetDeviceId,
				requirement,
				project,
				domain,
				originInternalId,
			});
			// 挑不出不是失败：202 + 决策结果（手机侧据此决定是否本机执行）。
			if ("fallbackToLocal" in result) {
				return c.json({ ok: true, fallbackToLocal: true, reason: result.reason }, 202);
			}
			return c.json({ ok: true, requestId: result.requestId, deviceName: result.deviceName }, 202);
		} catch (error) {
			const code = error instanceof RelayInvokeError ? error.code : "internal";
			const message = error instanceof Error ? error.message : "派发失败";
			return c.json({ error: code, message }, 502);
		}
	});

	// ── 「添加设备」加入码（2026-11-11 批H H2）────────────────────
	//
	// 浏览器**不直连中继**：跨源没开 CORS，owner 令牌也绝不能下发客户端（密钥纪律）。
	// 这里由 harness 代调中继 `POST /api/relay/join-code`，只把加入码/二维码/地址交给页面。
	// owner 令牌只从本进程 env 读（RELAY_OWNER_TOKEN，与中继侧同名）；没配就不带——
	// 中继在"未配 owner 令牌"时按自有口径放行（部署机 loopback 直调那条）。
	//
	// relayUrl 可由弹窗覆盖（内网/域名等对外形态不同）；只放行 http(s)，防被当成任意 SSRF 跳板。
	app.post("/api/v1/relay/join-code", async (c) => {
		if (!relayMobileProxyEnabled()) return c.json({ error: "not_available" }, 404);
		const body = (await c.req.json().catch(() => null)) as { relayUrl?: unknown } | null;
		const requested = typeof body?.relayUrl === "string" ? body.relayUrl.trim() : "";
		const base = normalizeRelayHttpBase(requested || relayHttpBase() || relayLinkHttpBase());
		if (!base) {
			return c.json({ error: "bad_request", message: "中继地址需要 http(s)://host[:端口]" }, 400);
		}
		// 2026-11-14：主令牌也认页面里接入时填的那份（`relay-link.json`），
		// 否则从页面接入的用户一签发加入码就被中继回 403，等于修了第一步、断在第二步。
		const ownerToken = relayOwnerToken();
		let response: Response;
		try {
			response = await fetch(`${base}/api/relay/join-code`, {
				method: "POST",
				...(ownerToken ? { headers: { authorization: `Bearer ${ownerToken}` } } : {}),
				signal: AbortSignal.timeout(8_000),
			});
		} catch {
			return c.json({ error: "relay_unreachable", message: "连不上中继，检查地址与网络" }, 502);
		}
		if (response.status === 403) {
			return c.json(
				{ error: "relay_forbidden", message: "中继拒绝了 owner 鉴权；在本机 .env 配 RELAY_OWNER_TOKEN 后重启" },
				502,
			);
		}
		if (!response.ok) {
			return c.json({ error: "relay_error", message: `中继返回 HTTP ${response.status}` }, 502);
		}
		const issued = (await response.json().catch(() => null)) as {
			joinCode?: unknown;
			expiresAt?: unknown;
		} | null;
		const joinCode = typeof issued?.joinCode === "string" ? issued.joinCode : "";
		const expiresAt = typeof issued?.expiresAt === "number" ? issued.expiresAt : 0;
		if (!joinCode || !expiresAt) {
			return c.json({ error: "relay_error", message: "中继回包缺少 joinCode / expiresAt" }, 502);
		}
		// 二维码内容 = 手机端深链；地址做百分号编码，手机侧按查询参数解码（Android Uri 默认解码）。
		const url = `lifediary://relay/join?u=${encodeURIComponent(base)}&c=${encodeURIComponent(joinCode)}`;
		const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360 });
		c.header("Cache-Control", "no-store");
		return c.json({ joinCode, expiresAt, relayUrl: base, url, dataUrl });
	});

	// ── 移除经中继进来的设备（2026-11-14）────────────────────────────
	//
	// 与加入码同一条纪律：浏览器不直连中继，owner 令牌不下发客户端。这里由 harness 代调
	// 中继 `POST /api/relay/devices/:id/revoke`——中继侧把凭据作废并踢掉在线连接（4401）。
	// 之前电脑上只能移除"本地配对"的设备，经中继加进来的手机躺在中继名册里，页面上没有入口。
	app.post("/api/v1/relay/devices/:id/revoke", async (c) => {
		if (!relayMobileProxyEnabled()) return c.json({ error: "not_available" }, 404);
		const client = deps.relayClient();
		if (!client || !client.connected) {
			return c.json({ error: "relay_unavailable", message: "中继未连接，暂时移除不了设备" }, 502);
		}
		const base = normalizeRelayHttpBase(relayHttpBase() || relayLinkHttpBase());
		if (!base) return c.json({ error: "bad_request", message: "还没有中继地址" }, 400);
		const ownerToken = relayOwnerToken();
		if (!ownerToken) {
			return c.json({ error: "relay_forbidden", message: "没有 owner 主令牌，改不了中继名册" }, 502);
		}
		let response: Response;
		try {
			response = await fetch(`${base}/api/relay/devices/${encodeURIComponent(c.req.param("id"))}/revoke`, {
				method: "POST",
				headers: { authorization: `Bearer ${ownerToken}` },
				signal: AbortSignal.timeout(8_000),
			});
		} catch {
			return c.json({ error: "relay_unreachable", message: "连不上中继，检查地址与网络" }, 502);
		}
		if (response.status === 403) {
			return c.json({ error: "relay_forbidden", message: "中继拒绝了 owner 鉴权" }, 502);
		}
		if (response.status === 404) {
			return c.json({ error: "unknown_device", message: "中继名册里没有这台设备（可能已被移除）" }, 404);
		}
		if (!response.ok) {
			return c.json({ error: "relay_error", message: `中继返回 HTTP ${response.status}` }, 502);
		}
		// 名册改了，本机快照立刻重拉一次：下一次轮询看到的必须是新名册
		if (typeof client.refreshDevices === "function") void client.refreshDevices().catch(() => {});
		return c.json({ ok: true });
	});

	// 会话列表透传（手机现有 GET /agent/chats 的同形状；不经此端点也能用）
	app.get("/api/v1/relay/mirror/chats", async (c) => {
		const client = deps.relayClient();
		if (!client) return c.json({ enabled: false, chats: [] });
		const target = c.req.query("deviceId");
		const limitRaw = Number(c.req.query("limit") ?? 50);
		const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 200) : 50;
		if (!target || !client.connected) return c.json({ enabled: client.connected, chats: [] });
		try {
			const result = (await client.invoke(target, "sessions/list", { limit }, 15_000)) as {
				chats?: ChatIndexEntry[];
			};
			return c.json({ enabled: true, chats: result.chats ?? [] });
		} catch (error) {
			const code = error instanceof RelayInvokeError ? error.code : "internal";
			return c.json({ error: code, message: error instanceof Error ? error.message : "拉取失败" }, 502);
		}
	});

	// 执事归属状态（阶段三；手机设置页的"执事在哪台电脑"）
	app.get("/api/v1/relay/home/overview", async (c) => {
		const home = deps.home();
		if (!companionHomeEnabled() || !home) return c.json({ error: "not_available" }, 404);
		return c.json(await home.status());
	});

	// ── 任务主机位 / 设备描述（2026-11-05 主机优先制）──────────────
	// 手机设置页由此设主机与描述：本机只是透传，真正落盘在中继名册
	// （中继没连上就没法改，502 而不是悄悄存本地——否则两端会各说各话）。

	app.post("/api/v1/relay/home-device", async (c) => {
		const client = deps.relayClient();
		if (!client || !client.connected) {
			return c.json({ error: "relay_unavailable", message: "中继未连接，暂时改不了设备设置" }, 502);
		}
		const body = (await c.req.json().catch(() => null)) as { deviceId?: unknown } | null;
		const deviceId = body?.deviceId;
		// null = 清除主机位；字符串 = 设成这台
		if (deviceId !== null && typeof deviceId !== "string") {
			return c.json({ error: "bad_request", message: "deviceId 需要字符串或 null" }, 400);
		}
		try {
			const result = await client.meta("set-home", { deviceId });
			return c.json(result);
		} catch (error) {
			const code = error instanceof RelayInvokeError ? error.code : "internal";
			const message = error instanceof Error ? error.message : "设置主机失败";
			return c.json({ error: code, message }, 502);
		}
	});

	app.post("/api/v1/relay/devices/:id/description", async (c) => {
		const client = deps.relayClient();
		if (!client || !client.connected) {
			return c.json({ error: "relay_unavailable", message: "中继未连接，暂时改不了设备设置" }, 502);
		}
		const body = (await c.req.json().catch(() => null)) as { description?: unknown } | null;
		if (typeof body?.description !== "string") {
			return c.json({ error: "bad_request", message: "需要 description 字符串" }, 400);
		}
		try {
			const result = await client.meta("set-description", {
				deviceId: c.req.param("id"),
				description: body.description,
			});
			return c.json(result);
		} catch (error) {
			const code = error instanceof RelayInvokeError ? error.code : "internal";
			const message = error instanceof Error ? error.message : "设置描述失败";
			return c.json({ error: code, message }, 502);
		}
	});

	void sayInConversation; // 保留导入面（sayInConversation 由 matrix 代理内部链路使用）
}
