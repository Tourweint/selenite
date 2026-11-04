import { hostname } from "node:os";
import type { RelayClient } from "./relay-client.ts";

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

/** 伙伴认主机（阶段三）：harness 注册/领取伙伴归属。依赖中继。 */
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
