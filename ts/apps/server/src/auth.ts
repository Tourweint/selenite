import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
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

function isLoopback(c: Context): boolean {
	try {
		const address = getConnInfo(c).remote.address;
		return address ? LOCAL_ADDRESSES.has(address) : false;
	} catch {
		// 拿不到连接信息时按"非本机"处理 —— 宁可拒绝
		return false;
	}
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
}

export function createAuthMiddleware(expectedToken: string | null, options: AuthOptions = {}) {
	return async (c: Context, next: Next) => {
		// 没配共享令牌：只让本机访问（但**扫码配对的设备**仍可从局域网进来）。
		if (!expectedToken) {
			if (isLoopback(c)) return next();
			const provided = bearerOf(c);
			if (provided && options.verifyDeviceToken?.(provided)) return next();
			return c.body(null, 403);
		}

		const provided = bearerOf(c);
		if (provided) {
			if (safeEqual(provided, expectedToken)) return next();
			if (options.verifyDeviceToken?.(provided)) return next();
		}
		return c.body(null, 403);
	};
}

function bearerOf(c: Context): string {
	const header = c.req.header("Authorization") ?? "";
	return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
