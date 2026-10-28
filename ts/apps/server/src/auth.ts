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

export function createAuthMiddleware(expectedToken: string | null) {
	return async (c: Context, next: Next) => {
		// 没配令牌：只让本机访问。这样开发时不用配，但也不会裸奔到局域网。
		if (!expectedToken) {
			if (isLoopback(c)) return next();
			return c.body(null, 403);
		}

		const header = c.req.header("Authorization") ?? "";
		const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

		if (provided && safeEqual(provided, expectedToken)) {
			return next();
		}
		return c.body(null, 403);
	};
}
