import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";

/**
 * 第一档鉴权：一个共享令牌。
 *
 * 它是**密码**，不是通行证 —— 只能回答"你知道这个密钥吗"，
 * 不能回答"你是谁"。个人自用够了，多设备/多用户要换 JWT。
 *
 * 口径刻意对齐 Java 版的 D2：
 *   - 失败一律 **403 空响应体**（App 不用区分是哪个服务拒绝的）
 *   - fail-closed：没配令牌时**不裸奔**
 */

const LOCAL_ADDRESSES = new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1",
]);

/**
 * 本机页面凭据（2026-11-03）：服务启动时随机生成一枚“本机 cookie”。
 *
 * 目的：桌面壳 / 本机浏览器打开 `/` 时自动连上，不再手填 AGENT_TOKEN。
 * 只在 loopback 请求且带这枚 cookie 时直通；curl、探针、别的本地脚本没有
 * 这枚 cookie，仍走令牌校验 —— 没有把“本机”变成无条件的后门。
 * HttpOnly：页面 JS 读不到；SameSite=Strict：别的网站发起的请求带不上。
 *
 * 落盘保底（2026-11-05）：密钥原本只在进程里，后端一重启就换，一直开着的
 * 页面立刻 403、被踢回令牌框。现在首用时落盘 `.data/local-secret`
 * （`AGENT_LOCAL_SECRET_PATH` 可改），重启复用同一枚。安全边界没变宽：
 * 能读这个文件的本机进程本来就读得到 .env 里的 AGENT_TOKEN。
 */
const LOCAL_COOKIE = "lifediary_local";

let localSecretCache: string | null = null;

/** 只认 48 位 hex（24 字节，与 randomBytes(24) 同形）；缺失或损坏都当没有 */
function readLocalSecretFile(path: string): string | null {
	try {
		const value = readFileSync(path, "utf8").trim();
		return /^[0-9a-f]{48}$/.test(value) ? value : null;
	} catch {
		return null;
	}
}

/** 惰性解析：模块加载零副作用（单测红线：不碰 .data/），首个请求才落盘。 */
function localSecret(): string {
	if (localSecretCache) return localSecretCache;
	const path = process.env.AGENT_LOCAL_SECRET_PATH?.trim() || ".data/local-secret";
	const existing = readLocalSecretFile(path);
	if (existing) return (localSecretCache = existing);
	const fresh = randomBytes(24).toString("hex");
	localSecretCache = fresh;
	try {
		mkdirSync(dirname(path), { recursive: true });
		// wx = 别覆盖并发实例刚写好的那枚；EEXIST 时读回来对齐
		writeFileSync(path, `${fresh}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			const raced = readLocalSecretFile(path);
			if (raced) {
				// 并发实例抢先落了盘：跟它对齐，别各持一枚互相踢
				localSecretCache = raced;
			} else {
				// 盘上是坏文件：覆盖它才算自愈（到这里没有可对齐的好值）
				try {
					writeFileSync(path, `${fresh}\n`, { mode: 0o600 });
				} catch {
					/* 写不回去：退回进程内随机（旧口径），下次启动再试 */
				}
			}
		}
		// 其余失败（只读盘等）：缓存住 fresh，同进程内始终一致 ——
		// 等价旧口径（进程内随机，重启后要重填令牌），下次启动再试落盘
	}
	return localSecretCache;
}

export function isLoopback(c: Context): boolean {
	try {
		const address = getConnInfo(c).remote.address;
		return address ? LOCAL_ADDRESSES.has(address) : false;
	} catch {
		// 拿不到连接信息时按"非本机"处理 —— 宁可拒绝
		return false;
	}
}

/** 连接方式（2026-11-14 连接页两分）：只由对端地址推出来，不接受客户端自报。 */
export type PeerTransport = "local" | "usb" | "direct";

/** 内网 / 链路本地（IPv4 三段私网 + 169.254，IPv6 ULA/link-local；`::ffff:` 映射形式先剥壳） */
function isPrivateAddress(raw: string): boolean {
	const address = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
	if (/^10\./.test(address) || /^192\.168\./.test(address) || /^169\.254\./.test(address)) return true;
	const match = /^172\.(\d+)\./.exec(address);
	if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
	// IPv6：fc00::/7（ULA）、fe80::/10（链路本地）
	return /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe[89ab][0-9a-f]:/i.test(address);
}

export function peerAddress(c: Context): string | null {
	try {
		return getConnInfo(c).remote.address ?? null;
	} catch {
		return null;
	}
}

/**
 * 这条请求算哪种连接：回环 = 数据线/本机转发（`adb reverse`），私网 = 同一 WiFi / USB 共享网络，
 * 其余 = 公网直连。拿不到对端信息时按 `direct`（最保守的那种说法）。
 */
export function peerTransportOf(c: Context): PeerTransport {
	const address = peerAddress(c);
	if (!address) return "direct";
	if (LOCAL_ADDRESSES.has(address)) return "usb";
	return isPrivateAddress(address) ? "local" : "direct";
}

/** 定长比较，避免把令牌长度泄露给计时攻击 */
function safeEqual(a: string, b: string): boolean {
	const bufferA = Buffer.from(a);
	const bufferB = Buffer.from(b);
	if (bufferA.length !== bufferB.length) return false;
	return timingSafeEqual(bufferA, bufferB);
}

export interface AuthOptions {
	/**
	 * 设备凭据校验（2026-10-29 配对）：`Bearer` 里也可能是扫码换来的 deviceToken。
	 * 不传 = 只认共享令牌。
	 */
	verifyDeviceToken?: (token: string) => boolean;
	/**
	 * 设备凭据通过时的回调（2026-11-14 连接方式）：带上按对端地址推出来的方式，
	 * 由调用方记进设备记录（`page` 要显示"它是怎么连的、上次怎么连的"）。
	 */
	onDeviceSeen?: (token: string, transport: PeerTransport) => void;
	/**
	 * **共享令牌从非本机地址**进来时的回调（2026-11-14）：这是"没走配对、也没走中继"的
	 * 外部设备（典型：手机里直接填了 AGENT_TOKEN）。它不进任何名册，页面上原本一片空白，
	 * 用户就会说"平板连上了但我看不到"。这里只记地址类别与时间，不记 IP 明文。
	 */
	onForeignPeer?: (info: { transport: PeerTransport; path: string; address: string | null }) => void;
	/**
	 * 凭据没过时也会喊一声（2026-11-14 连接页三次打磨）：设备拿着**已撤销 / 未知**的令牌来敲门时，
	 * 页面上原本什么都看不见——用户看到的是"平板明明在用，列表里却没有它"。
	 * 这里只上报"有个请求被拒了、对端算哪种方式"，不记 IP 明文、不参与鉴权结论。
	 */
	onAuthFail?: (info: { token: string | null; transport: PeerTransport; path: string; address: string | null }) => void;
}

/** 本机页面加载时发一枚进程内凭据；非本机请求不发光，避免把 cookie 扩散出去。 */
export function attachLocalCredential(c: Context): void {
	if (!isLoopback(c)) return;
	setCookie(c, LOCAL_COOKIE, localSecret(), {
		path: "/",
		httpOnly: true,
		sameSite: "Strict",
	});
}

function hasLocalCredential(c: Context): boolean {
	if (!isLoopback(c)) return false;
	const provided = getCookie(c, LOCAL_COOKIE);
	return typeof provided === "string" && safeEqual(provided, localSecret());
}

export function createAuthMiddleware(expectedToken: string | null, options: AuthOptions = {}) {
	return async (c: Context, next: Next) => {
		// 没配共享令牌：只让本机访问（但**扫码配对的设备**仍可从局域网进来）。
		if (!expectedToken) {
			if (isLoopback(c)) return next();
			const provided = bearerOf(c);
			if (provided && options.verifyDeviceToken?.(provided)) {
				options.onDeviceSeen?.(provided, peerTransportOf(c));
				return next();
			}
			options.onAuthFail?.({
				token: provided || null,
				transport: peerTransportOf(c),
				path: c.req.path,
				address: peerAddress(c),
			});
			return c.body(null, 403);
		}

		// 本机页面（桌面壳 / 本机浏览器）由 `/` 下发的 cookie 自动放行。
		if (hasLocalCredential(c)) return next();

		const provided = bearerOf(c);
		if (provided) {
			if (safeEqual(provided, expectedToken)) {
				// 主令牌从外面进来 = 没配对的外部设备（2026-11-14）。本机请求不算。
				if (!isLoopback(c)) {
					options.onForeignPeer?.({ transport: peerTransportOf(c), path: c.req.path, address: peerAddress(c) });
				}
				return next();
			}
			if (options.verifyDeviceToken?.(provided)) {
				options.onDeviceSeen?.(provided, peerTransportOf(c));
				return next();
			}
		}
		options.onAuthFail?.({
			token: provided || null,
			transport: peerTransportOf(c),
			path: c.req.path,
			address: peerAddress(c),
		});
		return c.body(null, 403);
	};
}

function bearerOf(c: Context): string {
	const header = c.req.header("Authorization") ?? "";
	return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
