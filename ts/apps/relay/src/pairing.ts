import { randomBytes } from "node:crypto";
import { hashEquals, sha256, type RelayStore, type StoredJoinCode } from "./store.ts";

/**
 * 扫码加入（2026-11-11 批R R2）。
 *
 * 电脑「添加设备」出一枚一次性加入码（二维码 `lifediary://relay/join?u=…&c=…`），
 * 手机扫码提交 → 换 deviceToken。与 6 位配对码（`store.issueCode`）刻意分开：
 *
 * - **256 位随机**（32 字节 base64url，43 字符）：扫到的码就是凭证，猜不了，
 *   所以不需要"错 N 次作废"那套防爆破状态机；
 * - **10 分钟 TTL、一次性、最多 5 个并发**（对齐 cindy pairing.ts:25-30）：
 *   用户可以连扫几台设备，过期/用掉即删；
 * - 只存 sha256，明文只在签发那一刻出现（密钥纪律）。
 *
 * 失败一律由调用方回 403 空体：验码失败不区分"不存在 / 过期 / 已用"，
 * 不给调用方任何可枚举的 oracle。
 */

export const JOIN_CODE_TTL_MS = 10 * 60_000;
export const MAX_LIVE_JOIN_CODES = 5;

export interface IssuedJoinCode {
	joinCode: string;
	expiresAt: number;
}

export interface JoinSuccess {
	deviceId: string;
	deviceToken: string;
}

export class RelayPairing {
	constructor(private readonly store: RelayStore) {}

	/** 签发一枚加入码。超过并发上限时丢最旧的（新码优先，用户手上的总是最新的）。 */
	issue(now = Date.now()): IssuedJoinCode {
		const joinCode = randomBytes(32).toString("base64url");
		const expiresAt = now + JOIN_CODE_TTL_MS;
		const live = this.store.readJoinCodes(now).slice(-(MAX_LIVE_JOIN_CODES - 1));
		const record: StoredJoinCode = { hash: sha256(joinCode), expiresAt, createdAt: now };
		this.store.writeJoinCodes([...live, record]);
		return { joinCode, expiresAt };
	}

	/**
	 * 验码并签发设备。成功返回明文 deviceToken（只此一次）。
	 * 码不存在 / 过期 / 已用过 → null（对外同一口径）。
	 */
	redeem(joinCode: string, deviceName: string, platform: string, now = Date.now()): JoinSuccess | null {
		const live = this.store.readJoinCodes(now);
		const hash = sha256(joinCode.trim());
		const index = live.findIndex((item) => hashEquals(item.hash, hash));
		if (index < 0) return null;
		// 先删码再签发：一次性语义不依赖后续步骤是否成功（失败也不留可重放的码）。
		live.splice(index, 1);
		this.store.writeJoinCodes(live);
		return this.store.createDevice(deviceName, platform, [], now);
	}
}
