import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RelayDeviceView } from "@lifediary/shared";

/**
 * 中继的名册与配对存储（2026-11-05 多端同步方案块0）。
 *
 * 取舍与 harness 的 pairing.ts 同口径：码与设备令牌都只存 sha256，
 * 明文只在签发那一刻存在；只存文件不建表（数据量极小，不值得开 SQLite schema）。
 *
 * 中继存的只有"路由元数据"：设备身份、在场、能力位。会话正文 / 密钥 / 记忆
 * 永远不进这个文件（多端同步方案 §五）。
 */

export const CODE_TTL_SECONDS = Number(process.env.RELAY_CODE_TTL_SECONDS ?? 300);
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_DEVICES = Number(process.env.RELAY_MAX_DEVICES ?? 32);

export const STORE_PATH =
	process.env.RELAY_STORE_PATH?.trim() || ".data/relay-state.json";

export interface StoredDevice {
	id: string;
	name: string;
	platform: string;
	/** sha256(deviceToken)，明文只存在于签发那一刻 */
	tokenHash: string;
	createdAt: number;
	capabilities: string[];
	lastSeenAt?: number;
	revokedAt?: number;
}

export interface StoredCode {
	hash: string;
	expiresAt: number;
	usedAt?: number;
	attempts: number;
}

export interface StoredActor {
	actorId: string;
	name: string;
	homeDeviceId: string | null;
	updatedAt: number;
}

export interface Store {
	code?: StoredCode;
	devices: StoredDevice[];
	/** 伙伴 → 主机路由表（阶段三）：路由元数据，中继仲裁的唯一状态 */
	actors?: StoredActor[];
}

export type RedeemError =
	| "unknown_code"
	| "code_used"
	| "code_expired"
	| "too_many_attempts";

export interface RedeemSuccess {
	deviceId: string;
	deviceToken: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** 定长比较（两个 sha256 hex 等长），避免把"前缀对了"泄露给计时攻击 */
function hashEquals(a: string, b: string): boolean {
	const bufferA = Buffer.from(a);
	const bufferB = Buffer.from(b);
	if (bufferA.length !== bufferB.length) return false;
	return timingSafeEqual(bufferA, bufferB);
}

export class RelayStore {
	private data: Store;

	constructor(path: string = STORE_PATH) {
		this.path = path;
		this.data = this.load();
	}

	readonly path: string;

	private load(): Store {
		try {
			if (!existsSync(this.path)) return { devices: [] };
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Store;
			return {
				code: parsed.code,
				devices: Array.isArray(parsed.devices) ? parsed.devices : [],
			};
		} catch (error) {
			console.warn(
				`[relay] 读取 ${this.path} 失败，按空名册继续: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { devices: [] };
		}
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
		renameSync(tmp, this.path);
	}

	/** 管理员身份（签发配对码 / 看名册 / 撤销设备）。空 = 只放行 loopback。 */
	get ownerToken(): string {
		return process.env.RELAY_OWNER_TOKEN?.trim() ?? "";
	}

	/** 生成一枚新加入码（同刻只留一枚，新码顶掉旧码）。明文只在此刻存在。 */
	issueCode(now = Date.now()): { code: string; expiresAt: number } {
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		const expiresAt = now + CODE_TTL_SECONDS * 1000;
		this.data.code = { hash: sha256(code), expiresAt, attempts: 0 };
		this.save();
		return { code, expiresAt };
	}

	hasLiveCode(now = Date.now()): boolean {
		const code = this.data.code;
		return (
			!!code && !code.usedAt && code.expiresAt > now && code.attempts < MAX_CODE_ATTEMPTS
		);
	}

	/** 用加入码换设备凭据。错码累计尝试次数，撞上限作废。 */
	redeem(
		code: string,
		deviceName: string,
		platform: string,
		capabilities: string[],
		now = Date.now(),
	): RedeemSuccess | RedeemError {
		const current = this.data.code;
		if (!current) return "unknown_code";
		if (current.usedAt) return "code_used";
		if (current.expiresAt <= now) return "code_expired";
		if (current.attempts >= MAX_CODE_ATTEMPTS) return "too_many_attempts";

		if (!hashEquals(current.hash, sha256(code.trim()))) {
			current.attempts += 1;
			this.save();
			return current.attempts >= MAX_CODE_ATTEMPTS ? "too_many_attempts" : "unknown_code";
		}

		const deviceToken = randomBytes(32).toString("base64url");
		const device: StoredDevice = {
			id: randomBytes(8).toString("hex"),
			name: deviceName.trim().slice(0, 40) || "未命名设备",
			platform: platform.trim().slice(0, 20) || "unknown",
			tokenHash: sha256(deviceToken),
			createdAt: now,
			capabilities: capabilities.slice(0, 16),
		};
		current.usedAt = now;
		// 设备上限：踢掉最久没上线的（防无限堆积），与 harness pairing 同口径
		this.data.devices = [...this.data.devices, device]
			.filter((item) => !item.revokedAt)
			.sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt))
			.slice(0, MAX_DEVICES);
		this.save();
		return { deviceId: device.id, deviceToken };
	}

	/** 设备令牌 → deviceId（连接鉴权每次都走；lastSeenAt 最多每分钟落一次盘）。 */
	verifyDeviceToken(token: string, now = Date.now()): string | null {
		const hash = sha256(token);
		for (const device of this.data.devices) {
			if (device.revokedAt) continue;
			if (!hashEquals(device.tokenHash, hash)) continue;
			if (!device.lastSeenAt || now - device.lastSeenAt > 60_000) {
				device.lastSeenAt = now;
				this.save();
			}
			return device.id;
		}
		return null;
	}

	touch(deviceId: string, now = Date.now()): void {
		const device = this.data.devices.find((item) => item.id === deviceId && !item.revokedAt);
		if (!device) return;
		device.lastSeenAt = now;
		this.save();
	}

	/** 全量名册投影（不含 tokenHash）。 */
	listDevices(now = Date.now(), onlineIds: ReadonlySet<string> = new Set()): RelayDeviceView[] {
		return this.data.devices
			.filter((item) => !item.revokedAt)
			.map((item) => ({
				id: item.id,
				name: item.name,
				platform: item.platform,
				online: onlineIds.has(item.id),
				...(item.lastSeenAt ? { lastSeenAt: item.lastSeenAt } : {}),
				capabilities: item.capabilities,
			}));
	}

	revokeDevice(id: string, now = Date.now()): boolean {
		const device = this.data.devices.find((item) => item.id === id && !item.revokedAt);
		if (!device) return false;
		device.revokedAt = now;
		this.save();
		return true;
	}

	// ── 伙伴路由表（阶段三）────────────────────────────────────

	listActors(): StoredActor[] {
		return [...(this.data.actors ?? [])];
	}

	actorHome(actorId: string): StoredActor | null {
		return this.data.actors?.find((item) => item.actorId === actorId) ?? null;
	}

	/**
	 * CAS 认主机：expected 与当前一致（含"两边都空"）才落位；
	 * 不一致返回冲突并**带回实际值**。actorId 未知时视为空位直接抢占。
	 */
	claimActorHome(
		actorId: string,
		name: string,
		expectedHomeDeviceId: string | null,
		deviceId: string,
		now = Date.now(),
	): { ok: true; actor: StoredActor } | { ok: false; code: "home_conflict"; actual: string | null } {
		this.data.actors ??= [];
		const current = this.data.actors.find((item) => item.actorId === actorId);
		if (!current) {
			const actor: StoredActor = { actorId, name: name.slice(0, 40) || "伙伴", homeDeviceId: deviceId, updatedAt: now };
			this.data.actors.push(actor);
			this.save();
			return { ok: true, actor };
		}
		if ((current.homeDeviceId ?? null) !== (expectedHomeDeviceId ?? null)) {
			return { ok: false, code: "home_conflict", actual: current.homeDeviceId };
		}
		current.homeDeviceId = deviceId;
		if (name.trim()) current.name = name.trim().slice(0, 40);
		current.updatedAt = now;
		this.save();
		return { ok: true, actor: current };
	}

	/** 交出主机位（只有当前主机自己能交）。 */
	releaseActorHome(actorId: string, deviceId: string, now = Date.now()): boolean {
		const current = this.data.actors?.find((item) => item.actorId === actorId);
		if (!current || current.homeDeviceId !== deviceId) return false;
		current.homeDeviceId = null;
		current.updatedAt = now;
		this.save();
		return true;
	}
}
