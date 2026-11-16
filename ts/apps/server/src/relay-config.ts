import { hostname } from "node:os";
import type { RelayClient } from "./relay-client.ts";
import { flagEnabled } from "./flags.ts";

/**
 * 中继客户端配置（2026-11-05 多端同步方案）。
 *
 * 回滚开关：RELAY_ENABLED 默认 **off**——off 时完全不连接、不装通道，
 * 回局域网直连形态（硬约束"新能力给回滚开关"）。
 *
 * harness 以"设备"身份加入中继：RELAY_TOKEN 是中继配对签发的 deviceToken
 * （env 下发，不落库不进日志——密钥纪律同 AGENT_TOKEN）。
 */

export interface RelaySettings {
	url: string;
	token: string;
	deviceName: string;
	capabilities: string[];
}

export function relayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.RELAY_ENABLED ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

/** 设备矩阵（阶段二）：delegate 可点名远端设备。依赖中继。 */
export function deviceMatrixEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.DEVICE_MATRIX_ENABLED ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

/**
 * 自动挑机（2026-11-05 自动分发方案）：delegate 的 targetDevice="auto"。
 * 默认 **关**——关时 "auto" 按非法参数拒绝，回到纯点名/本机两态。
 */
export function deviceAutoDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("DEVICE_AUTO_DISPATCH", env);
}

/** 自动挑机的单机满载阈值；非法值（含 0 / 负数 / 非数字）回落默认 3。 */
export function deviceMaxActivePerDevice(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number((env.DEVICE_MAX_ACTIVE_PER_DEVICE ?? "").trim());
	return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
}

/**
 * 中继手机代理面（2026-11-11 批H H1）：`mobile/proxy` 通道与「添加设备」加入码。
 * 默认**开**（与中继侧同名开关同口径，批R 已按默认开部署）；只有显式 `off/false/0` 才关。
 * 关 = 被控端不注册该通道（fail-closed，中继发来的 invoke 一律回 404），
 * 同时 harness 的 `POST /api/v1/relay/join-code` 也 404。
 */
export function relayMobileProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.RELAY_MOBILE_PROXY_ENABLED ?? "").trim().toLowerCase();
	return raw !== "off" && raw !== "false" && raw !== "0";
}

/**
 * 中继的对外 HTTP 形态（2026-11-11 批H H2）：由 `RELAY_URL` 推出来给二维码用。
 *
 * `RELAY_URL` 是本进程连 WS 用的地址（`ws(s)://host:port[/ws]`，见 relaySettings），
 * 手机要的是 `http(s)://host:port`。非 http(s)/ws(s) 或解析失败 → 空串（调用方要求手填）。
 * 传入任意用户填的地址也走这一支：只放行 http(s)，顺带拒绝带账号密码的 URL。
 */
export function normalizeRelayHttpBase(raw: string): string {
	const text = raw.trim();
	if (!text) return "";
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return "";
	}
	if (url.username || url.password) return "";
	if (url.protocol === "ws:") url.protocol = "http:";
	else if (url.protocol === "wss:") url.protocol = "https:";
	else if (url.protocol !== "http:" && url.protocol !== "https:") return "";
	url.pathname = url.pathname.replace(/\/ws\/?$/, "").replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

/** 默认中继 HTTP 地址（`RELAY_URL` 的对外形态）；没配就空串，让弹窗里手填。 */
export function relayHttpBase(env: NodeJS.ProcessEnv = process.env): string {
	return normalizeRelayHttpBase(env.RELAY_URL ?? "");
}

/**
 * 连接页「接入中继」（2026-11-14 连接页三步方案）：允许从页面里填地址与主令牌，
 * 换回本机设备令牌并热起客户端。默认**开**——关掉即回 2026-11-13 形态
 * （只认 `.env`，页面上只有教程）：`RELAY_LINK_UI=off`。
 */
export function relayLinkUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.RELAY_LINK_UI ?? "").trim().toLowerCase();
	return raw !== "off" && raw !== "false" && raw !== "0";
}

/** 执事认主机（阶段三）：harness 注册/领取执事归属。依赖中继。 */
export function companionHomeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.COMPANION_HOME_ENABLED ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on";
}

export function relayCapabilities(env: NodeJS.ProcessEnv = process.env): string[] {
	const caps = ["mirror"];
	if (deviceMatrixEnabled(env)) caps.push("matrix");
	if (companionHomeEnabled(env)) caps.push("companion-home");
	return caps;
}

// ── 晚绑定注册表 ────────────────────────────────────────────────
// 工具层（tools.ts）在 getHarness 里装配，早于 index.ts 启动中继客户端；
// 双方都经这里的 getter 取，避免初始化顺序耦合（工具在运行期才取值）。

let activeRelayClient: RelayClient | null = null;

export function setRelayClient(client: RelayClient | null): void {
	activeRelayClient = client;
}

export function currentRelayClient(): RelayClient | null {
	return activeRelayClient;
}

/** 配置不全时返回 null 并让调用方拒绝启动（不静默降级，错了要看得见）。 */
export function relaySettings(env: NodeJS.ProcessEnv = process.env): RelaySettings | null {
	if (!relayEnabled(env)) return null;
	const url = env.RELAY_URL?.trim() ?? "";
	const token = env.RELAY_TOKEN?.trim() ?? "";
	if (!url || !token) return null;
	return {
		url: url.replace(/\/+$/, "").replace(/\/ws$/, "") + "/ws",
		token,
		deviceName: env.RELAY_DEVICE_NAME?.trim() || hostname(),
		capabilities: relayCapabilities(env),
	};
}
