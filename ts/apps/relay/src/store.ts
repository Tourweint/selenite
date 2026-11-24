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

/** 设备描述上限（2026-11-05 主机优先制方案 §1.3）。 */
export const MAX_DESCRIPTION_LENGTH = 200;

/** 客户端 hardwareId 的长度上限（2026-11-24 C-10）：超了当"没带"，不当错误。 */
export const MAX_HARDWARE_ID_LENGTH = 128;

/**
 * 硬件归并开关（2026-11-24 C-10）：默认开。
 * 中继进程**自己的** env（与 harness 的配对库各自独立，两份库不合并）；
 * `DEVICE_HARDWARE_MERGE=false` → 完全忽略请求里的 `hardwareId`，逐字回到旧行为。
 */
export function deviceHardwareMergeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.DEVICE_HARDWARE_MERGE ?? "").trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * 请求里的 `hardwareId` → 中继只存的二次 hash（2026-11-24 C-10）。
 * 非字符串 / 空 / 超过 128 字符一律当"没带"：这是纯增量字段，老客户端缺字段 = 旧行为。
 */
export function hardwareHashOf(hardwareId: unknown): string | undefined {
	if (typeof hardwareId !== "string") return undefined;
	const trimmed = hardwareId.trim();
	if (!trimmed || trimmed.length > MAX_HARDWARE_ID_LENGTH) return undefined;
	return sha256(trimmed);
}

/** 开关 + 形状一起判（两条兑换路由共用）。undefined = 本次按旧行为（每次新建一条）。 */
export function hardwareHashForRequest(
	hardwareId: unknown,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return deviceHardwareMergeEnabled(env) ? hardwareHashOf(hardwareId) : undefined;
}

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
	/**
	 * 硬件归并键（2026-11-24 C-10）：客户端 `hardwareId` 的**二次** sha256。
	 * 只作内部归并键——不进 `listDevices()` 投影（`RelayDeviceView` 没这个字段）、不进日志；
	 * 同一 hash 的未撤销记录在加入/兑换时复用原 id（主机位 / 描述 / 路由引用都挂在 id 上）。
	 */
	hardwareHash?: string;
	/**
	 * 设备描述（≤200 字，如"存储机"）。**只给人看**，
	 * 自动挑机决策器不读它（2026-11-05 主机优先制方案 §1.3）。
	 */
	description?: string;
}

export interface StoredCode {
	hash: string;
	expiresAt: number;
	usedAt?: number;
	attempts: number;
}

/**
 * 一次性加入码（2026-11-11 批R R2，扫码加入）。
 *
 * 与 `StoredCode`（6 位配对码，同刻一枚）刻意分开：加入码是 256 位随机串、
 * 10 分钟 TTL、最多 5 个并发——扫码场景要"电脑出码、手机扫完即用"，
 * 短码那套"新码顶旧码 + 错 5 次作废"的防爆破逻辑用不上（256 位猜不了）。
 * 两套都只存 sha256，明文只在签发那一刻存在。
 */
export interface StoredJoinCode {
	/** sha256(joinCode) */
	hash: string;
	expiresAt: number;
	createdAt: number;
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
	/** 扫码加入码（2026-11-11 批R）：只存 sha256，10 分钟 TTL、一次性 */
	joinCodes?: StoredJoinCode[];
	/**
	 * 任务主机位（2026-11-05 主机优先制）：**全矩阵唯一**，同刻只有一台。
	 * 与上面的伙伴归属 `actors[].homeDeviceId` 是**两个概念**（任务主机位 vs 伙伴归属），
	 * 刻意不合并；未设 = null / 缺省。
	 */
	homeDeviceId?: string | null;
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

/** sha256 十六进制摘要。配对码 / 设备令牌 / 加入码共用（pairing.ts 也用它）。 */
export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** 定长比较（两个 sha256 hex 等长），避免把"前缀对了"泄露给计时攻击 */
export function hashEquals(a: string, b: string): boolean {
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
				joinCodes: Array.isArray(parsed.joinCodes) ? parsed.joinCodes : [],
				// 主机位必须随盘走：重启后名册还在、主机位却丢了，等于用户静默被改配置
				homeDeviceId: typeof parsed.homeDeviceId === "string" ? parsed.homeDeviceId : null,
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
		// Windows 上 rename 撞文件锁（杀毒/索引/并发读写）会抛 EPERM——不接住的话，
		// 异常会沿 WS 消息回调把整个中继进程干掉（2026-11-05 真机联调实测崩过）。
		// 重试仍失败就放弃这次落盘：内存态照常工作，丢的只是 lastSeenAt 级别的更新，
		// 下一次 save 会把完整状态补上。崩溃的代价远大于丢一次写盘。
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				renameSync(tmp, this.path);
				return;
			} catch (error) {
				if (attempt === 2) {
					console.warn(
						`[relay] 落盘失败（内存态继续）: ${error instanceof Error ? error.message : String(error)}`,
					);
					return;
				}
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
			}
		}
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

	/**
	 * 有效加入码（未过期）。过期条目读时过滤、落盘时自然消失——不需要独立的清扫器。
	 * 策略（TTL / 并发上限 / 一次性）在 pairing.ts，这里只管持久化口径。
	 */
	readJoinCodes(now = Date.now()): StoredJoinCode[] {
		return (this.data.joinCodes ?? []).filter((item) => item.expiresAt > now);
	}

	writeJoinCodes(codes: StoredJoinCode[]): void {
		this.data.joinCodes = codes;
		this.save();
	}

	/**
	 * 签发一台新设备（2026-11-11 批R 从 `redeem` 抽出）：配对码兑换与扫码加入
	 * 共用同一套令牌生成 / 名字截断 / 设备上限淘汰逻辑，两条路不发散。
	 * 明文 deviceToken 只在这里返回一次，落盘的是 sha256。
	 *
	 * `hardwareHash`（2026-11-24 C-10）：同一 hash 的**未撤销**记录存在时**复用原 id**——
	 * 覆盖 tokenHash（旧令牌因此自然失效）、刷新名字 / 平台 / 能力位 / 最近上线。
	 * id 不变，任务主机位（`homeDeviceId`）、设备描述、伙伴归属（`actors[].homeDeviceId`）
	 * 都还指着这条记录，不用迁移。已撤销的记录**不复活**；缺省 = 旧行为（每次新建）。
	 */
	createDevice(
		deviceName: string,
		platform: string,
		capabilities: string[],
		now = Date.now(),
		hardwareHash?: string,
	): RedeemSuccess {
		const deviceToken = randomBytes(32).toString("base64url");
		const tokenHash = sha256(deviceToken);
		const name = deviceName.trim().slice(0, 40) || "未命名设备";
		const cleanPlatform = platform.trim().slice(0, 20) || "unknown";
		const reusable = hardwareHash
			? this.data.devices.find((item) => !item.revokedAt && item.hardwareHash === hardwareHash)
			: undefined;
		let device: StoredDevice;
		if (reusable) {
			reusable.tokenHash = tokenHash;
			reusable.name = name;
			reusable.platform = cleanPlatform;
			reusable.capabilities = capabilities.slice(0, 16);
			reusable.lastSeenAt = now;
			device = reusable;
		} else {
			device = {
				id: randomBytes(8).toString("hex"),
				name,
				platform: cleanPlatform,
				tokenHash,
				createdAt: now,
				capabilities: capabilities.slice(0, 16),
				...(hardwareHash ? { hardwareHash } : {}),
			};
		}
		// 设备上限：踢掉最久没上线的（防无限堆积），与 harness pairing 同口径。复用时先摘旧位置再排。
		this.data.devices = [...this.data.devices.filter((item) => item !== device), device]
			.filter((item) => !item.revokedAt)
			.sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt))
			.slice(0, MAX_DEVICES);
		this.save();
		return { deviceId: device.id, deviceToken };
	}

	/** 用加入码换设备凭据。错码累计尝试次数，撞上限作废。 */
	redeem(
		code: string,
		deviceName: string,
		platform: string,
		capabilities: string[],
		now = Date.now(),
		hardwareHash?: string,
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

		current.usedAt = now;
		// createDevice 内落盘，usedAt 同一次写盘持久化（不再单独 save）
		return this.createDevice(deviceName, platform, capabilities, now, hardwareHash);
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

	/** 全量名册投影（不含 tokenHash）。isHome / description 随投影带出（2026-11-05）。 */
	listDevices(now = Date.now(), onlineIds: ReadonlySet<string> = new Set()): RelayDeviceView[] {
		const homeId = this.homeDeviceId();
		return this.data.devices
			.filter((item) => !item.revokedAt)
			.map((item) => ({
				id: item.id,
				name: item.name,
				platform: item.platform,
				online: onlineIds.has(item.id),
				...(item.lastSeenAt ? { lastSeenAt: item.lastSeenAt } : {}),
				capabilities: item.capabilities,
				isHome: item.id === homeId,
				...(item.description ? { description: item.description } : {}),
			}));
	}

	/** 改设备名（≤40 字）。设备不存在/已撤销 → false。UTF-8 安全：名字来自 JSON 解析后的字符串。 */
	renameDevice(id: string, name: string, now = Date.now()): boolean {
		const device = this.data.devices.find((item) => item.id === id && !item.revokedAt);
		if (!device) return false;
		const clean = name.trim().slice(0, 40);
		if (clean) device.name = clean;
		this.save();
		return true;
	}

	revokeDevice(id: string, now = Date.now()): boolean {
		const device = this.data.devices.find((item) => item.id === id && !item.revokedAt);
		if (!device) return false;
		device.revokedAt = now;
		this.save();
		return true;
	}

	// ── 任务主机位 / 设备描述（2026-11-05 主机优先制）──────────────

	/**
	 * 设 / 清任务主机位（唯一主机位）。
	 * `null` = 清除；其余必须落在有效名册里（未知或已撤销返回 false，现状不变）。
	 * 不做自动抢占：主机位只能由用户显式指定（方案 §三）。
	 */
	setHomeDevice(deviceId: string | null): boolean {
		if (deviceId === null) {
			this.data.homeDeviceId = null;
			this.save();
			return true;
		}
		const device = this.data.devices.find((item) => item.id === deviceId && !item.revokedAt);
		if (!device) return false;
		this.data.homeDeviceId = deviceId;
		this.save();
		return true;
	}

	/** 当前任务主机 id；存的是已撤销 / 已不在名册的旧值时按"没设"处理。 */
	homeDeviceId(): string | null {
		const id = this.data.homeDeviceId ?? null;
		if (!id) return null;
		const alive = this.data.devices.some((item) => item.id === id && !item.revokedAt);
		return alive ? id : null;
	}

	/**
	 * 写设备描述。超长按 200 字截断（描述只给人看，不是契约校验面；
	 * 调用方 REST/meta 会先拒超长，这里兜底保证落盘形状稳定）。
	 * 空串 = 清除描述。设备不在有效名册返回 false。
	 */
	setDescription(deviceId: string, text: string): boolean {
		const device = this.data.devices.find((item) => item.id === deviceId && !item.revokedAt);
		if (!device) return false;
		const trimmed = text.trim().slice(0, MAX_DESCRIPTION_LENGTH);
		if (trimmed) device.description = trimmed;
		else delete device.description;
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
