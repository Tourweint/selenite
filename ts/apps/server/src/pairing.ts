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
	/**
	 * 两段式配对（2026-11-10 批 28 §一）：sha256(confirmToken)，只存哈希。
	 * 只有 `begin()` 签发的码带这一位；`confirm()` 认它，`redeem()` 不认——
	 * 保证「只扫码（拿到 code）不能完成配对」。confirmToken 与 code 同记录、同 expiresAt，
	 * 即"与 code 绑定、同生共死"（默认 5 分钟，随 `PAIR_CODE_TTL_SECONDS`）。
	 */
	confirmHash?: string;
}

interface StoredDevice {
	id: string;
	name: string;
	/** sha256(deviceToken) */
	tokenHash: string;
	/** 指纹（2026-11-10 批 26 §四）：sha256(id + tokenHash) 的短摘要，人眼可核。 */
	fingerprint?: string;
	/** 键被换过（文件里的 tokenHash 与指纹对不上）：该设备的凭据一律 fail-closed。 */
	keyChangedAt?: number;
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
	/** 人眼可核的设备指纹（批 26 §四）；开关关着时不出现。 */
	fingerprint?: string;
}

/**
 * 两段式确认（`confirm`）的错误口径（2026-11-10 批 28 §一）。
 * 与 `RedeemError` 分开：单段 `redeem` 的契约一个字不改，新增错误只服务两段式。
 *   - `confirm_required`：只给了 code、没给 confirmToken（"只有 code 不能完成"）；
 *   - `bad_confirm`：confirmToken 错了；
 *   - `code_used`：重放（code / confirmToken 一次性，成功即作废）。
 * 其余 `unknown_code` / `code_expired` / `too_many_attempts` 与单段同义。
 */
export type ConfirmError =
	| "unknown_code"
	| "confirm_required"
	| "bad_confirm"
	| "code_used"
	| "code_expired"
	| "too_many_attempts";

/** 两段式开关（2026-11-10 批 28 §一）：默认 true（收紧）。false / 0 / off → 回到旧单段。 */
export function pairTwoStepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.PAIR_TWO_STEP ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * 指纹开关（2026-11-10 批 26 §四）：默认开。
 * `PAIR_DEVICE_FINGERPRINT=false` → 不生成 / 不下发指纹，也不做键变更判定（一行回滚）。
 */
export function deviceFingerprintEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.PAIR_DEVICE_FINGERPRINT ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * 设备指纹：`sha256("lifediary-device-v1|id|tokenHash")` 前 12 位十六进制，4-4-4 分组。
 *
 * 只回答一个问题——"手机上和电脑上显示的是不是同一台"。48 bit 够人眼核对，
 * **不可反推令牌**，也不当凭据用（鉴权仍只认 deviceToken 的 sha256）。
 */
export function deviceFingerprint(deviceId: string, tokenHash: string): string {
	const digest = createHash("sha256")
		.update(`lifediary-device-v1|${deviceId}|${tokenHash}`)
		.digest("hex")
		.slice(0, 12)
		.toUpperCase();
	return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
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

function load(storePath: string): Store {
	try {
		if (!existsSync(storePath)) return { devices: [] };
		const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Store;
		return { code: parsed.code, devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
	} catch (error) {
		// 文件损坏就当作没有配对过（设备得重新扫一次），而不是让服务起不来
		console.warn(
			`[pairing] 读取 ${storePath} 失败，按空状态继续: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { devices: [] };
	}
}

function save(storePath: string, store: Store): void {
	mkdirSync(dirname(storePath), { recursive: true });
	const tmp = `${storePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
	renameSync(tmp, storePath);
}

export class PairingStore {
	private readonly store: Store;

	constructor(private readonly storePath: string = STORE_PATH) {
		this.store = load(storePath);
		// 迁移 + 键变更判定都在构造时做一次：指纹缺失补算，指纹对不上 → 标记 fail-closed。
		if (deviceFingerprintEnabled()) this.sealFingerprints();
	}

	/**
	 * 给每台设备补/核指纹（2026-11-10 批 26 §四）。
	 *
	 * - 老记录没有指纹 → 补算写入（一次性迁移，不算键变更）；
	 * - 有指纹但对不上 → **标记 keyChangedAt**，该设备凭据 failed closed。
	 *   键只会在配对时生成、正常路径不会变；对不上说明文件被改过 / 从别的机器搬了过来，
	 *   这时"静默按新键认"等于把别人换进来的键当成主人。
	 */
	private sealFingerprints(now = Date.now()): void {
		let dirty = false;
		for (const device of this.store.devices) {
			const expected = deviceFingerprint(device.id, device.tokenHash);
			if (device.fingerprint === undefined) {
				device.fingerprint = expected;
				dirty = true;
				continue;
			}
			if (device.fingerprint !== expected && device.keyChangedAt === undefined) {
				device.keyChangedAt = now;
				dirty = true;
				console.warn(
					`[pairing] 设备 ${device.id.slice(0, 8)} 的凭据指纹不匹配，已按 fail-closed 停用`,
				);
			}
		}
		if (dirty) this.persist();
	}

	/** 落盘失败只 warn：配对库写不进去不该让服务起不来（与 load 同口径）。 */
	private persist(): void {
		try {
			save(this.storePath, this.store);
		} catch (error) {
			console.warn(
				`[pairing] 写入 ${this.storePath} 失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** 生成一枚新码（同一时刻只保留一枚；新码顶掉旧码）。返回明文码，只在此刻存在。 */
	issueCode(now = Date.now()): { code: string; expiresAt: number } {
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		const expiresAt = now + CODE_TTL_SECONDS * 1000;
		this.store.code = { hash: sha256(code), expiresAt, attempts: 0 };
		this.persist();
		return { code, expiresAt };
	}

	/**
	 * 两段式第一段（2026-11-10 批 28 §一）：出一枚带 `confirmToken` 的码。
	 *
	 * `code` 给手机扫（进二维码），`confirmToken` 给**电脑端**确认（不随二维码下发）。
	 * 两者都只在此刻以明文返回一次，落盘都只有 sha256；同一记录、同一过期时刻。
	 * 语义：**只拿到 code 不能换凭据**，必须 `confirm()` 同时交出 code + confirmToken。
	 */
	begin(now = Date.now()): { code: string; expiresAt: number; confirmToken: string } {
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		const confirmToken = randomBytes(24).toString("base64url");
		const expiresAt = now + CODE_TTL_SECONDS * 1000;
		this.store.code = {
			hash: sha256(code),
			expiresAt,
			attempts: 0,
			confirmHash: sha256(confirmToken),
		};
		this.persist();
		return { code, expiresAt, confirmToken };
	}

	/** 当前是否还有一枚可用码（调试页据此显示"生成/等待扫码"） */
	hasLiveCode(now = Date.now()): boolean {
		const code = this.store.code;
		return !!code && !code.usedAt && code.expiresAt > now && code.attempts < MAX_CODE_ATTEMPTS;
	}

	/**
	 * 发设备凭据（单段 redeem / 两段式 confirm 共用）：生成令牌、登记设备、把码标记为已用。
	 * 抽出来是为了两段式与单段逐字节共用同一套设备语义（指纹 / 上限 / 落盘），不改 `redeem` 行为。
	 */
	private issueDevice(deviceName: string, now: number): RedeemResult {
		const deviceToken = randomBytes(32).toString("base64url");
		const tokenHash = sha256(deviceToken);
		const id = randomBytes(8).toString("hex");
		const device: StoredDevice = {
			id,
			name: deviceName.trim().slice(0, 40) || "手机",
			tokenHash,
			createdAt: now,
			...(deviceFingerprintEnabled() ? { fingerprint: deviceFingerprint(id, tokenHash) } : {}),
		};
		const current = this.store.code;
		if (current) current.usedAt = now;
		// 设备上限：踢掉最久没用过的那台（防无限堆积）
		this.store.devices = [...this.store.devices, device]
			.filter((item) => !item.revokedAt)
			.sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt))
			.slice(0, MAX_DEVICES);
		this.persist();
		return {
			deviceToken,
			deviceId: device.id,
			...(device.fingerprint ? { fingerprint: device.fingerprint } : {}),
		};
	}

	/** 用码换设备凭据（单段 / 回滚通道）。失败会累计尝试次数（撞上限即作废这枚码）。 */
	redeem(code: string, deviceName: string, now = Date.now()): RedeemResult | RedeemError {
		const current = this.store.code;
		if (!current) return "unknown_code";
		if (current.usedAt) return "code_used";
		if (current.expiresAt <= now) return "code_expired";
		if (current.attempts >= MAX_CODE_ATTEMPTS) return "too_many_attempts";
		// 两段式码带 confirmHash：从**单段视角**它不是一枚可兑的码。服务端在
		// PAIR_TWO_STEP=true 时直接关掉 /pair/redeem 路由；这里再兜一层，避免任何
		// 其它调用面绕过开关把两段式码单段兑掉（"只扫码不能完成"）。
		if (current.confirmHash) return "unknown_code";

		if (!hashEquals(current.hash, sha256(code.trim()))) {
			current.attempts += 1;
			this.persist();
			return current.attempts >= MAX_CODE_ATTEMPTS ? "too_many_attempts" : "unknown_code";
		}

		return this.issueDevice(deviceName, now);
	}

	/**
	 * 两段式第二段（2026-11-10 批 28 §一）：code + confirmToken 同时正确才发凭据。
	 *
	 * - `confirmToken` 一次性、随 code 一起 5 分钟过期、与 code 绑定（同一记录）；
	 * - 只给 code（无 confirmToken）→ `confirm_required`；confirmToken 错 → `bad_confirm`；
	 * - **失败一律计入既有 `attempts`**（与 `redeem` 共用一个计数器、共用 MAX_CODE_ATTEMPTS）；
	 * - 成功即把码标记已用，重放第二次 → `code_used`。
	 */
	confirm(
		code: string,
		confirmToken: string,
		deviceName: string,
		now = Date.now(),
	): RedeemResult | ConfirmError {
		const current = this.store.code;
		// 不是两段式码（普通 issueCode 出的）→ 不走这里，按"没有待确认的码"处理。
		if (!current || !current.confirmHash) return "unknown_code";
		if (current.usedAt) return "code_used";
		if (current.expiresAt <= now) return "code_expired";
		if (current.attempts >= MAX_CODE_ATTEMPTS) return "too_many_attempts";

		if (!hashEquals(current.hash, sha256(code.trim()))) {
			current.attempts += 1;
			this.persist();
			return current.attempts >= MAX_CODE_ATTEMPTS ? "too_many_attempts" : "unknown_code";
		}

		const supplied = (confirmToken ?? "").trim();
		if (!supplied || !hashEquals(current.confirmHash, sha256(supplied))) {
			current.attempts += 1;
			this.persist();
			if (current.attempts >= MAX_CODE_ATTEMPTS) return "too_many_attempts";
			return supplied ? "bad_confirm" : "confirm_required";
		}

		return this.issueDevice(deviceName, now);
	}

	/** 设备凭据是否有效（每次请求都会走一次；命中即刷新 lastSeenAt，但最多每分钟落一次盘） */
	verifyDeviceToken(token: string, now = Date.now()): boolean {
		const hash = sha256(token);
		let touched = false;
		for (const device of this.store.devices) {
			if (device.revokedAt) continue;
			// 键变更 fail-closed（批 26 §四）：指纹对不上的设备不再接受任何凭据，
			// 直到主人在电脑上撤销 / 重新配对。宁可多要求一次配对，不静默认一把被换掉的键。
			if (device.keyChangedAt) continue;
			if (!hashEquals(device.tokenHash, hash)) continue;
			if (!device.lastSeenAt || now - device.lastSeenAt > 60_000) {
				device.lastSeenAt = now;
				touched = true;
			}
			if (touched) this.persist();
			return true;
		}
		return false;
	}

	/** 对外设备清单：始终不含 tokenHash；开关关着时连指纹 / 键变更位也不出现（回滚）。 */
	listDevices(): Array<Omit<StoredDevice, "tokenHash">> {
		const withFingerprint = deviceFingerprintEnabled();
		return this.store.devices.map(({ tokenHash: _hidden, ...rest }) => {
			if (withFingerprint) return rest;
			const { fingerprint: _fingerprint, keyChangedAt: _keyChanged, ...legacy } = rest;
			return legacy;
		});
	}

	revokeDevice(id: string, now = Date.now()): boolean {
		const device = this.store.devices.find((item) => item.id === id && !item.revokedAt);
		if (!device) return false;
		device.revokedAt = now;
		this.persist();
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
