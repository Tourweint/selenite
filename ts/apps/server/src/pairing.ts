import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";

/**
 * 一次性配对码 + 设备凭据（2026-10-29）。
 *
 * 背景：App 端去掉了账号体系，但 harness 仍需要回答"这台手机是不是被允许的"。
 * 设计取舍（详见 App 仓库 `docs/设计方案/2026-10-29-去账号化与改连Harness改造方案.md` §4.6）：
 *
 * - **码里不放长期密钥**：二维码只含 6 位短码（默认 300 秒、单次、错 5 次作废），
 *   手机拿码换一个长期 `deviceToken`。截图泄露的是废码，不是凭据。
 * - **落库不落明文**：码与设备令牌都只存 sha256；库文件泄露 ≠ 凭据可用。
 * - **只存文件不建表**：数据量极小（一枚码 + 几台设备），不值得为它开一个 SQLite schema；
 *   也刻意不混进 pi-durable 的存储（那边的表由内核管，外部表混进去升级会痛）。
 */

const CODE_TTL_SECONDS = Number(process.env.PAIR_CODE_TTL_SECONDS ?? 300);
const MAX_CODE_ATTEMPTS = 5;
const MAX_DEVICES = 32;

const STORE_PATH =
	process.env.PAIRING_STORE_PATH?.trim() || ".data/pairing.json";

interface StoredCode {
	/** sha256(code)，不存明文 */
	hash: string;
	expiresAt: number;
	usedAt?: number;
	attempts: number;
}

interface StoredDevice {
	id: string;
	name: string;
	/** sha256(deviceToken) */
	tokenHash: string;
	createdAt: number;
	lastSeenAt?: number;
	revokedAt?: number;
}

interface Store {
	code?: StoredCode;
	devices: StoredDevice[];
}

export type RedeemError =
	| "unknown_code"
	| "code_used"
	| "code_expired"
	| "too_many_attempts";

export interface RedeemResult {
	deviceToken: string;
	deviceId: string;
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

function load(): Store {
	try {
		if (!existsSync(STORE_PATH)) return { devices: [] };
		const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Store;
		return { code: parsed.code, devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
	} catch (error) {
		// 文件损坏就当作没有配对过（设备得重新扫一次），而不是让服务起不来
		console.warn(
			`[pairing] 读取 ${STORE_PATH} 失败，按空状态继续: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { devices: [] };
	}
}

function save(store: Store): void {
	mkdirSync(dirname(STORE_PATH), { recursive: true });
	const tmp = `${STORE_PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
	renameSync(tmp, STORE_PATH);
}

export class PairingStore {
	private store: Store = load();

	/** 生成一枚新码（同一时刻只保留一枚；新码顶掉旧码）。返回明文码，只在此刻存在。 */
	issueCode(now = Date.now()): { code: string; expiresAt: number } {
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		const expiresAt = now + CODE_TTL_SECONDS * 1000;
		this.store.code = { hash: sha256(code), expiresAt, attempts: 0 };
		save(this.store);
		return { code, expiresAt };
	}

	/** 当前是否还有一枚可用码（调试页据此显示"生成/等待扫码"） */
	hasLiveCode(now = Date.now()): boolean {
		const code = this.store.code;
		return !!code && !code.usedAt && code.expiresAt > now && code.attempts < MAX_CODE_ATTEMPTS;
	}

	/** 用码换设备凭据。失败会累计尝试次数（撞上限即作废这枚码）。 */
	redeem(code: string, deviceName: string, now = Date.now()): RedeemResult | RedeemError {
		const current = this.store.code;
		if (!current) return "unknown_code";
		if (current.usedAt) return "code_used";
		if (current.expiresAt <= now) return "code_expired";
		if (current.attempts >= MAX_CODE_ATTEMPTS) return "too_many_attempts";

		if (!hashEquals(current.hash, sha256(code.trim()))) {
			current.attempts += 1;
			save(this.store);
			return current.attempts >= MAX_CODE_ATTEMPTS ? "too_many_attempts" : "unknown_code";
		}

		const deviceToken = randomBytes(32).toString("base64url");
		const device: StoredDevice = {
			id: randomBytes(8).toString("hex"),
			name: deviceName.trim().slice(0, 40) || "手机",
			tokenHash: sha256(deviceToken),
			createdAt: now,
		};
		current.usedAt = now;
		// 设备上限：踢掉最久没用过的那台（防无限堆积）
		this.store.devices = [...this.store.devices, device]
			.filter((item) => !item.revokedAt)
			.sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt))
			.slice(0, MAX_DEVICES);
		save(this.store);
		return { deviceToken, deviceId: device.id };
	}

	/** 设备凭据是否有效（每次请求都会走一次；命中即刷新 lastSeenAt，但最多每分钟落一次盘） */
	verifyDeviceToken(token: string, now = Date.now()): boolean {
		const hash = sha256(token);
		let touched = false;
		for (const device of this.store.devices) {
			if (device.revokedAt) continue;
			if (!hashEquals(device.tokenHash, hash)) continue;
			if (!device.lastSeenAt || now - device.lastSeenAt > 60_000) {
				device.lastSeenAt = now;
				touched = true;
			}
			if (touched) save(this.store);
			return true;
		}
		return false;
	}

	listDevices(): Array<Omit<StoredDevice, "tokenHash">> {
		return this.store.devices.map(({ tokenHash: _hidden, ...rest }) => rest);
	}

	revokeDevice(id: string, now = Date.now()): boolean {
		const device = this.store.devices.find((item) => item.id === id && !item.revokedAt);
		if (!device) return false;
		device.revokedAt = now;
		save(this.store);
		return true;
	}

	/** 调试页展示：当前码还剩多少秒（没有可用码返回 0） */
	codeRemainingSeconds(now = Date.now()): number {
		const code = this.store.code;
		if (!code || code.usedAt || code.expiresAt <= now) return 0;
		return Math.max(0, Math.ceil((code.expiresAt - now) / 1000));
	}
}

/** 配对链接：手机扫出来的就是这一行（自定义 scheme，App 自己 parse） */
export function buildPairUrl(base: string, code: string): string {
	const url = new URL(base.startsWith("http") ? base : `http://${base}`);
	return `lifediary-pair://v1?base=${encodeURIComponent(url.origin)}&code=${code}`;
}

/**
 * 手机该连的地址：显式 `PAIR_BASE_URL` 优先，否则取首个非内网回环的 IPv4 + 端口。
 * 手机经 USB 反代时也可能填 127.0.0.1，所以这里只负责"给一个大概率可用的默认值"。
 */
export function resolvePairBase(port: number): string {
	const explicit = process.env.PAIR_BASE_URL?.trim();
	if (explicit) return explicit.replace(/\/+$/, "");
	const interfaces = networkInterfaces();
	for (const group of Object.values(interfaces)) {
		for (const item of group ?? []) {
			if (item.family === "IPv4" && !item.internal) return `http://${item.address}:${port}`;
		}
	}
	return `http://127.0.0.1:${port}`;
}
