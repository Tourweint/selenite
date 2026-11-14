import { hostname, userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	normalizeRelayHttpBase,
	relayCapabilities,
	type RelaySettings,
} from "./relay-config.ts";

/**
 * 本机接入中继的凭据（2026-11-14 连接页三步方案）。
 *
 * 之前只有一条路：手写 `.env`（RELAY_URL / RELAY_TOKEN）再重启。结果是连接页上
 * 「接入中继」这一步**没有入口**——用户看到"未连上"，页面上却只有一段教程和一个
 * 置灰的出码按钮。本文件把这一步搬进页面：给地址 + 主令牌，换回本机自己的设备令牌。
 *
 * 落点 `.data/relay-link.json`（0600）：和 `provider-keys.json` 同一套"界面直填密钥"
 * 口径——写本机、绝不回显、绝不进日志。一个文件里两枚令牌：
 *
 * - `deviceToken`：本机日常连中继用（90% 的场景只用它）
 * - `ownerToken`：只用于**替主人签发加入码**（relay `join-code` 是 owner-only），
 *   以及下次换地址时重新加入
 *
 * 优先级：`.env` 里配齐的那份永远压过本文件（部署环境说了算，页面不偷偷覆盖）。
 */

export interface RelayLink {
	/** 中继的对外 HTTP 地址（`http(s)://host[:port]`，不带 `/ws`） */
	base: string;
	/** 本机在中继名册上的设备令牌 */
	deviceToken: string;
	/** 主令牌（VPS 上的 `RELAY_OWNER_TOKEN`）；中继没配时为空串 */
	ownerToken: string;
	deviceName: string;
}

/** 接入失败的分类（页面按 code 出不同的话，不共用一句"失败了"）。 */
export class RelayLinkError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: 400 | 502 = 502,
	) {
		super(message);
	}
}

export function relayLinkPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.RELAY_LINK_PATH?.trim() || ".data/relay-link.json";
}

export function readRelayLink(env: NodeJS.ProcessEnv = process.env): RelayLink | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(relayLinkPath(env), "utf8"));
	} catch {
		return null;
	}
	const file = raw as Partial<RelayLink>;
	if (typeof file?.base !== "string" || typeof file?.deviceToken !== "string") return null;
	const base = normalizeRelayHttpBase(file.base);
	if (!base || !file.deviceToken.trim()) return null;
	return {
		base,
		deviceToken: file.deviceToken.trim(),
		ownerToken: typeof file.ownerToken === "string" ? file.ownerToken.trim() : "",
		deviceName: typeof file.deviceName === "string" ? file.deviceName.trim() : "",
	};
}

/**
 * 收紧文件 ACL（2026-11-14 安全补丁）。
 *
 * `mode: 0o600` 只在 POSIX 生效；Windows 上 Node 会忽略它，文件沿用目录继承的 ACL，
 * 同一台机器的其他本机账户照样能读到两枚令牌。这里用 icacls 断继承、只留当前用户。
 * 失败不抛：真起不来的是"读不到凭据"，不是"ACL 没收到最紧"。
 */
function tightenAcl(path: string): void {
	if (process.platform !== "win32") return;
	const user = userInfo().username;
	if (!user) return;
	try {
		spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], {
			windowsHide: true,
			stdio: "ignore",
			timeout: 5_000,
		});
	} catch {
		/* ACL 收紧失败不影响使用 */
	}
}

export function writeRelayLink(link: RelayLink, env: NodeJS.ProcessEnv = process.env): void {
	const path = relayLinkPath(env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
	tightenAcl(path);
}

export function clearRelayLink(env: NodeJS.ProcessEnv = process.env): void {
	try {
		rmSync(relayLinkPath(env), { force: true });
	} catch {
		/* 没有文件也算清掉了 */
	}
}

/** 主令牌的来源：`.env` 优先，其次页面里填过的那份。 */
export function relayOwnerToken(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = (env.RELAY_OWNER_TOKEN ?? "").trim();
	if (fromEnv) return fromEnv;
	return readRelayLink(env)?.ownerToken ?? "";
}

/** 已接入的中继对外地址；没接过返回空串（页面据此显示"未接入"）。 */
export function relayLinkHttpBase(env: NodeJS.ProcessEnv = process.env): string {
	return readRelayLink(env)?.base ?? "";
}

/** 文件里的接入信息 → 客户端配置（`ws(s)://host:port/ws`）。 */
export function relaySettingsFromLink(link: RelayLink, env: NodeJS.ProcessEnv = process.env): RelaySettings {
	const ws = link.base.replace(/^http(s?):/, (_all, secure: string) => (secure ? "wss:" : "ws:"));
	return {
		url: `${ws}/ws`,
		token: link.deviceToken,
		deviceName: link.deviceName || hostname(),
		capabilities: relayCapabilities(env),
	};
}

const JOIN_TIMEOUT_MS = 8_000;

async function relayFetch(url: string, init: RequestInit): Promise<Response | null> {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(JOIN_TIMEOUT_MS) });
	} catch {
		return null;
	}
}

/**
 * 用「地址 + 主令牌」让这台电脑在中继上登记。
 *
 * 三步走，每步失败都说清是哪一步：
 * 1. `GET /api/relay/info`（免鉴权）→ 地址上真的有中继吗
 * 2. `POST /api/relay/join-code`（owner）→ 主令牌对不对
 * 3. `POST /api/relay/join`（用刚签的码）→ 换本机设备令牌
 */
export async function joinRelay(input: {
	address: string;
	ownerToken: string;
	deviceName?: string;
}): Promise<RelayLink> {
	const base = normalizeRelayHttpBase(input.address);
	if (!base) throw new RelayLinkError("bad_address", "中继地址要写成 http://主机:端口 或 https://域名", 400);
	const ownerToken = input.ownerToken.trim();
	if (!ownerToken) throw new RelayLinkError("bad_token", "还缺主令牌（VPS 上的 RELAY_OWNER_TOKEN）", 400);
	const deviceName = input.deviceName?.trim() || hostname();

	const info = await relayFetch(`${base}/api/relay/info`, { method: "GET" });
	if (!info || !info.ok) {
		throw new RelayLinkError("relay_unreachable", `地址 ${base} 上没有中继应答，检查 IP、端口和防火墙`);
	}

	const issued = await relayFetch(`${base}/api/relay/join-code`, {
		method: "POST",
		headers: { authorization: `Bearer ${ownerToken}` },
	});
	if (!issued) throw new RelayLinkError("relay_unreachable", "中继连上了但签发加入码超时");
	if (issued.status === 403) throw new RelayLinkError("relay_forbidden", "中继不认这枚主令牌");
	if (!issued.ok) throw new RelayLinkError("relay_error", `中继拒绝了签发加入码：HTTP ${issued.status}`);
	const code = ((await issued.json().catch(() => null)) as { joinCode?: unknown } | null)?.joinCode;
	if (typeof code !== "string" || !code) throw new RelayLinkError("relay_error", "中继回包里没有加入码");

	const joined = await relayFetch(`${base}/api/relay/join`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ joinCode: code, deviceName, platform: "desktop" }),
	});
	if (!joined) throw new RelayLinkError("join_failed", "换设备令牌时超时");
	if (!joined.ok) throw new RelayLinkError("join_failed", `中继拒绝加入：HTTP ${joined.status}`);
	const deviceToken = ((await joined.json().catch(() => null)) as { deviceToken?: unknown } | null)?.deviceToken;
	if (typeof deviceToken !== "string" || !deviceToken) {
		throw new RelayLinkError("join_failed", "中继没有回设备令牌");
	}

	return { base, deviceToken, ownerToken, deviceName };
}
