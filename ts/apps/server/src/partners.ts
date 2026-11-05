import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryScope } from "@lifediary/memory";

/**
 * 固定 id 例外（2026-11-05 批次D D1）：总管的 partnerId 是固定字面量 `"chief"`，**不是 uuid**。
 * 理由：总管是每台一个的主对话本体，是 SOUL 版本 / 家目录 / 记忆键空间 / 技能落点的内部锚点，
 * 不是一条可枚举的执事记录，因此不需要（也不该）随机化。这个 id 只在本仓内部使用；
 * **聊天/会话身份对外仍用会话 uuid**，总管不新增对外端点、不把 "chief" 当会话 id 用
 * （`GET /api/v1/partners` 只是既有管理端点里自然多出一行，不是新身份入口）。
 * 这是 AGENTS.md「对外 id 一律 uuid」的一处刻意例外，登记在此防止后来者当成疏漏去"改回 uuid"。
 */
/**
 * 执事档案：DB 只存索引与版本快照，磁盘才是内容的家（2026-11-05 批次B B2）。
 *
 * 参考 cindy 的"文件=当前值、DB 版本行=冻结快照"双层契约：
 *   - `SOUL.md` 在磁盘上是**当前值**，谁都能改（设置页 / 宿主）；
 *   - `partner_versions` 是**冻结快照**：执事轮次启动认版本号，整轮身份不变；
 *     改完 SOUL 不当场变身，下一轮生效——这是设计出来的不一致，别"修"成即时生效。
 *
 * 家目录 `.data/partner-homes/<uuid>/`：
 *   SOUL.md（身份，播种时最后写 = 家建好的标志）/ memories/USER.md（主人画像）/
 *   workspace/（唯一默认可写区）/ memories/ / skills/。
 * 单槽 64KB 上限；全部原子写（临时文件 + rename）。
 *
 * 权限边界：模型的原始文件工具只挂 workspace/（agent.ts 的 pathGuard 指过来）；
 * memories/skills 的写只能走宿主类型化接口（remember 落执事 scope / partner_skill_write）。
 * 本模块**只做存储**，不 import agent.ts——装配方向 partners ← agent，防循环。
 */

export const COMPANIONS_ENABLED =
	(process.env.COMPANIONS_ENABLED?.trim() || "true").toLowerCase() !== "false";

const DEFAULT_DB_PATH = ".data/partners.sqlite";
const DEFAULT_HOMES_ROOT = ".data/partner-homes";

/** 单槽上限（SOUL.md / USER.md / 技能文件同口径，cindy 同款） */
export const PARTNER_SLOT_LIMIT = 64 * 1024;

// ── 总管（批次D D1）─────────────────────────────────────
/** 总管固定 partnerId。内部字面量、非 uuid；例外理由见文件头注释。 */
export const CHIEF_PARTNER_ID = "chief";
const CHIEF_PARTNER_NAME = "总管";

/** 总管身份化总开关：false/0 = 不播种、persona 常量直读，回到改动前形态（D1 回滚开关）。 */
export function chiefPartnerEnabled(): boolean {
	const raw = process.env.CHIEF_PARTNER?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

/** 总管技能目录（纯路径，不打开 DB）；与 store.skillsDirOf("chief") 同址。 */
export function chiefSkillsDir(): string {
	const homesRoot = process.env.PARTNER_HOMES_ROOT?.trim() || DEFAULT_HOMES_ROOT;
	return join(homesRoot, CHIEF_PARTNER_ID, "skills");
}

export type PartnerStatus = "active" | "paused" | "archived";

export interface PartnerRow {
	id: string;
	name: string;
	status: PartnerStatus;
	/** 当前身份快照版本号；还没建过版本 = null */
	currentVersion: number | null;
	createdAt: string;
	updatedAt: string;
	/** 执事的领域名（批次D D2）；普通执事为 null。小写 ASCII，同 chancellor DOMAIN_PATTERN。 */
	domain: string | null;
}

export interface PartnerVersionRow {
	partnerId: string;
	version: number;
	/** SOUL.md 正文快照（冻结） */
	soulSource: string;
	/** 能力 JSON：模型候选链（B4）+ 预留位；只允许存引用（keyEnv 名），不允许存值 */
	capabilities: string | null;
	createdAt: string;
}

export interface PartnerSessionLinkRow {
	partnerId: string;
	/** `delegation` = 执事的领域路由（批次D D2）；这类链接没有宿主会话，sessionId 为占位 0。 */
	role: "canonical" | "routine" | "topic" | "delegation";
	routeKey: string | null;
	/** durable 内部自增会话 id（不外泄） */
	sessionId: number;
	/** 该会话最近一次应用过的身份版本（下一轮生效契约的记账位） */
	appliedVersion: number | null;
	createdAt: string;
}

/** 模型链项的最小形状（真类型在 model-chain.ts，这里解耦避免存储层依赖判定层） */
export interface ModelChainItemLike {
	providerId: string;
	modelId: string;
	keyEnv: string;
	thinkingLevel?: string;
}

/** 例行任务触发器（B3）。cron 为 5 段标准式；event 的 match 是字段等值过滤。 */
export type RoutineTrigger =
	| { type: "cron"; expr: string }
	| { type: "interval"; seconds: number }
	| { type: "once"; at: string }
	| { type: "event"; kind: "delegation" | "tool" | "phase"; match?: Record<string, string> };

export interface RoutineDef {
	id: string;
	partnerId: string;
	name: string;
	/** 每次触发的指令正文（≤100k，cindy 同款上限） */
	prompt: string;
	triggers: RoutineTrigger[];
	/** persistent = 复用主会话（跟进类保上下文）；fresh = 每次全新专线（检查类防污染） */
	sessionMode: "persistent" | "fresh";
	enabled: boolean;
	/** 每次修改 +1：durable 任务带着旧 revision 醒来时据此作废（替代"取消任务"） */
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export class PartnersStore {
	private readonly db: DatabaseSync;
	readonly homesRoot: string;

	constructor(
		path: string = process.env.PARTNERS_DB_PATH?.trim() || DEFAULT_DB_PATH,
		homesRoot: string = process.env.PARTNER_HOMES_ROOT?.trim() || DEFAULT_HOMES_ROOT,
	) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.homesRoot = homesRoot;
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS partners (
				id              TEXT PRIMARY KEY,
				name            TEXT NOT NULL,
				status          TEXT NOT NULL DEFAULT 'active',
				current_version INTEGER,
				created_at      TEXT NOT NULL,
				updated_at      TEXT NOT NULL,
				domain          TEXT
			);
			CREATE TABLE IF NOT EXISTS partner_versions (
				partner_id   TEXT NOT NULL,
				version      INTEGER NOT NULL,
				soul_source  TEXT NOT NULL,
				capabilities TEXT,
				created_at   TEXT NOT NULL,
				PRIMARY KEY (partner_id, version)
			);
			CREATE TABLE IF NOT EXISTS partner_session_links (
				partner_id      TEXT NOT NULL,
				role            TEXT NOT NULL,
				route_key       TEXT,
				session_id      INTEGER NOT NULL,
				applied_version INTEGER,
				created_at      TEXT NOT NULL,
				UNIQUE (partner_id, role, route_key)
			);
			CREATE TABLE IF NOT EXISTS routines (
				id           TEXT PRIMARY KEY,
				partner_id   TEXT NOT NULL,
				name         TEXT NOT NULL,
				prompt       TEXT NOT NULL,
				triggers     TEXT NOT NULL,
				session_mode TEXT NOT NULL DEFAULT 'persistent',
				enabled      INTEGER NOT NULL DEFAULT 1,
				revision     INTEGER NOT NULL DEFAULT 1,
				created_at   TEXT NOT NULL,
				updated_at   TEXT NOT NULL
			);
		`);
		this.migrate();
	}

	/** 旧库补列（批次D D2）：沿用 delegation-receipts.ts 的 PRAGMA + ALTER TABLE 惯例。 */
	private migrate(): void {
		const columns = this.db.prepare("PRAGMA table_info(partners)").all() as Array<{
			name?: unknown;
		}>;
		if (!columns.some((column) => column.name === "domain")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN domain TEXT");
		}
	}

	close(): void {
		this.db.close();
	}

	// ── 档案 CRUD ─────────────────────────────────────────
	create(name: string, opts?: { domain?: string; soulSeed?: string }): PartnerRow {
		const id = randomUUID();
		const now = new Date().toISOString();
		const domain = opts?.domain ?? null;
		this.db
			.prepare(
				"INSERT INTO partners (id, name, status, current_version, created_at, updated_at, domain) VALUES (?, ?, 'active', NULL, ?, ?, ?)",
			)
			.run(id, name, now, now, domain);
		// 建档案即建家 + 首个身份版本：执事生下来就有身份。
		// 执事用「一句话版本」SOUL 播种（批次D D2），普通执事用默认模板。
		this.ensureHome(id, name, opts?.soulSeed);
		const soul = this.readSoulFromHome(id) ?? defaultSoul(name);
		this.pushVersion(id, soul, null);
		this.ensureHome(id, name, opts?.soulSeed);
		// 执事：在链接表登记领域路由（role 枚举扩一型 'delegation'）。
		// 既有 UNIQUE (partner_id, role, route_key) 已覆盖这个组合，无需改约束。
		if (domain) this.linkDelegation(id, domain);
		return this.get(id) as PartnerRow;
	}

	/**
	 * 总管专用播种（批次D D1）：固定 id `"chief"`，首次启动建档案 + 家 + v1 身份快照。
	 * **幂等**：档案 / SOUL.md / 版本任一已存在都不动——二次启动绝不覆盖用户改过的 SOUL
	 * （含通过 PATCH/bumpSoul 推进过的新版本）。
	 * 播种正文 = 传入的 PERSONA 原文（运行时值），保证首启 persona 与改动前逐字一致。
	 */
	ensureChief(seedSoul: string): void {
		if (!this.get(CHIEF_PARTNER_ID)) {
			const now = new Date().toISOString();
			this.db
				.prepare(
					"INSERT INTO partners (id, name, status, current_version, created_at, updated_at) VALUES (?, ?, 'active', NULL, ?, ?)",
				)
				.run(CHIEF_PARTNER_ID, CHIEF_PARTNER_NAME, now, now);
		}
		this.ensureHome(CHIEF_PARTNER_ID, CHIEF_PARTNER_NAME, seedSoul);
		if (!this.currentVersion(CHIEF_PARTNER_ID)) {
			this.pushVersion(
				CHIEF_PARTNER_ID,
				this.readSoulFromHome(CHIEF_PARTNER_ID) ?? seedSoul,
				null,
			);
		}
	}

	get(id: string): PartnerRow | null {
		const row = this.db.prepare("SELECT * FROM partners WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? toPartner(row) : null;
	}

	list(): PartnerRow[] {
		const rows = this.db
			.prepare("SELECT * FROM partners ORDER BY created_at")
			.all() as Array<Record<string, unknown>>;
		return rows.map(toPartner);
	}

	/** 改名 / 暂停 / 归档。身份内容的修改走 bumpSoul（版本化），不走这里。 */
	update(
		id: string,
		patch: { name?: string; status?: PartnerStatus },
	): PartnerRow | null {
		const existing = this.get(id);
		if (!existing) return null;
		const now = new Date().toISOString();
		if (patch.name !== undefined && patch.name.trim()) {
			this.db
				.prepare("UPDATE partners SET name = ?, updated_at = ? WHERE id = ?")
				.run(patch.name.trim(), now, id);
		}
		if (patch.status !== undefined) {
			this.db
				.prepare("UPDATE partners SET status = ?, updated_at = ? WHERE id = ?")
				.run(patch.status, now, id);
		}
		return this.get(id);
	}

	/** 删除：档案行 + 版本行 + 链接行 + 家目录整体。家目录没了身份就没了，二次确认在端点层。 */
	delete(id: string): boolean {
		const existing = this.get(id);
		if (!existing) return false;
		this.db.prepare("DELETE FROM partners WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM partner_versions WHERE partner_id = ?").run(id);
		this.db.prepare("DELETE FROM partner_session_links WHERE partner_id = ?").run(id);
		// 例行任务定义跟着走：不清理会留孤儿（任务醒来 runPartnerTurn 报"执事不存在"）
		this.db.prepare("DELETE FROM routines WHERE partner_id = ?").run(id);
		try {
			rmSync(this.homeOf(id), { recursive: true, force: true });
		} catch {
			// 目录删不掉不挡档案删除（可能本来就没建成）；warn 留给调用方
		}
		return true;
	}

	// ── 身份版本 ─────────────────────────────────────────
	/** 新增一个身份版本（冻结快照），current_version 指过去。 */
	pushVersion(partnerId: string, soulSource: string, capabilities: string | null): number {
		const partner = this.get(partnerId);
		if (!partner) throw new Error(`执事不存在：${partnerId}`);
		const version = (partner.currentVersion ?? 0) + 1;
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO partner_versions (partner_id, version, soul_source, capabilities, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(partnerId, version, soulSource, capabilities, now);
		this.db
			.prepare("UPDATE partners SET current_version = ?, updated_at = ? WHERE id = ?")
			.run(version, now, partnerId);
		return version;
	}

	getVersion(partnerId: string, version: number): PartnerVersionRow | null {
		const row = this.db
			.prepare(
				"SELECT * FROM partner_versions WHERE partner_id = ? AND version = ?",
			)
			.get(partnerId, version) as Record<string, unknown> | undefined;
		return row
			? {
					partnerId: String(row.partner_id),
					version: Number(row.version),
					soulSource: String(row.soul_source ?? ""),
					capabilities: row.capabilities === null || row.capabilities === undefined ? null : String(row.capabilities),
					createdAt: String(row.created_at ?? ""),
				}
			: null;
	}

	currentVersion(partnerId: string): PartnerVersionRow | null {
		const partner = this.get(partnerId);
		if (!partner?.currentVersion) return null;
		return this.getVersion(partnerId, partner.currentVersion);
	}

	// ── 家目录 ───────────────────────────────────────────
	homeOf(partnerId: string): string {
		return join(this.homesRoot, partnerId);
	}

	workspaceOf(partnerId: string): string {
		return join(this.homeOf(partnerId), "workspace");
	}

	skillsDirOf(partnerId: string): string {
		return join(this.homeOf(partnerId), "skills");
	}

	/**
	 * 播种家目录（幂等）：缺什么补什么，已有内容绝不覆盖。
	 * SOUL.md **最后写**——它的存在代表"家已建好"（cindy 同款约定）。
	 */
	ensureHome(partnerId: string, name: string, soulSeed?: string): void {
		const home = this.homeOf(partnerId);
		for (const dir of [
			home,
			join(home, "memories"),
			join(home, "workspace"),
			this.skillsDirOf(partnerId),
		]) {
			mkdirSync(dir, { recursive: true });
		}
		const userMd = join(home, "memories", "USER.md");
		if (!existsSync(userMd)) {
			this.atomicWrite(userMd, `# 主人画像\n\n（执事相处中自行补充；只记事实，不记猜测。）\n`);
		}
		const soulMd = join(home, "SOUL.md");
		if (!existsSync(soulMd)) {
			this.atomicWrite(soulMd, soulSeed ?? defaultSoul(name));
		}
	}

	/** 原子写：临时文件 + rename；超上限直接拒（64KB 是给身份文件的护栏，不是摆设）。 */
	atomicWrite(path: string, content: string): void {
		if (Buffer.byteLength(content, "utf8") > PARTNER_SLOT_LIMIT) {
			throw new Error(`内容超过 ${PARTNER_SLOT_LIMIT} 字节上限（槽位护栏）`);
		}
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, content, "utf8");
		try {
			renameSync(tmp, path);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* 清理失败就算了 */
			}
			throw error;
		}
	}

	readSoulFromHome(partnerId: string): string | null {
		return this.readHomeFile(partnerId, "SOUL.md");
	}

	readUserMd(partnerId: string): string | null {
		return this.readHomeFile(partnerId, join("memories", "USER.md"));
	}

	readHomeFile(partnerId: string, relative: string): string | null {
		const path = join(this.homeOf(partnerId), relative);
		if (!existsSync(path)) return null;
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}

	/** 改 SOUL.md（磁盘当前值）+ 落新版本快照，返回新版本号。能力（候选链）随版本延续，不被冲掉。 */
	bumpSoul(partnerId: string, soulSource: string): number {
		if (!this.get(partnerId)) throw new Error(`执事不存在：${partnerId}`);
		this.atomicWrite(join(this.homeOf(partnerId), "SOUL.md"), soulSource);
		return this.pushVersion(partnerId, soulSource, this.currentVersion(partnerId)?.capabilities ?? null);
	}

	/** 模型候选链（B4）随版本存取；只挂引用不挂值，校验在 model-chain.ts。 */
	getModelChain(partnerId: string): ModelChainItemLike[] {
		const current = this.currentVersion(partnerId);
		if (!current?.capabilities) return [];
		try {
			const parsed = JSON.parse(current.capabilities) as { modelChain?: ModelChainItemLike[] };
			return Array.isArray(parsed.modelChain) ? parsed.modelChain : [];
		} catch {
			return [];
		}
	}

	setModelChain(partnerId: string, chain: ModelChainItemLike[]): number {
		return this.pushVersion(partnerId, this.readSoulFromHome(partnerId) ?? "", JSON.stringify({ modelChain: chain }));
	}

	// ── 会话链接 ─────────────────────────────────────────
	/**
	 * 找执事的专线会话链接；没有就返回 null（调用方建好会话后 linkSession 补记）。
	 * routeKey 例：canonical 用固定 "canonical"，例行专线用 `routine:<id>`。
	 */
	findSessionLink(
		partnerId: string,
		role: PartnerSessionLinkRow["role"],
		routeKey: string | null,
	): PartnerSessionLinkRow | null {
		const row = this.db
			.prepare(
				"SELECT * FROM partner_session_links WHERE partner_id = ? AND role = ? AND route_key IS ?",
			)
			.get(partnerId, role, routeKey) as Record<string, unknown> | undefined;
		return row ? toLink(row) : null;
	}

	linkSession(input: {
		partnerId: string;
		role: PartnerSessionLinkRow["role"];
		routeKey: string | null;
		sessionId: number;
		appliedVersion?: number | null;
	}): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO partner_session_links (partner_id, role, route_key, session_id, applied_version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				input.partnerId,
				input.role,
				input.routeKey,
				input.sessionId,
				input.appliedVersion ?? null,
				new Date().toISOString(),
			);
	}

	/**
	 * 执事的领域路由链接（批次D D2）：`role='delegation', routeKey=domain`。
	 * 宰相的会话在 chancellor 自己的库里，宿主没有对应 durable 会话，
	 * 所以 `session_id` 用占位 0（不是真实会话 id，见 partnerIdOfSession 的过滤）。
	 */
	linkDelegation(partnerId: string, domain: string): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO partner_session_links (partner_id, role, route_key, session_id, applied_version, created_at) VALUES (?, 'delegation', ?, 0, NULL, ?)",
			)
			.run(partnerId, domain, new Date().toISOString());
	}

	/** 按领域名反查执事 id；查不到返回 null（兼容旧领域，派单照旧不带身份）。 */
	partnerIdByDomain(domain: string): string | null {
		const row = this.db
			.prepare("SELECT id FROM partners WHERE domain = ? LIMIT 1")
			.get(domain) as { id?: unknown } | undefined;
		return row?.id ? String(row.id) : null;
	}

	/** 记账位：这条会话最近一次应用的身份版本（下一轮生效契约靠它判断要不要重配）。 */
	appliedVersionOf(partnerId: string, sessionId: number): number | null {
		const row = this.db
			.prepare(
				"SELECT applied_version FROM partner_session_links WHERE partner_id = ? AND session_id = ?",
			)
			.get(partnerId, sessionId) as { applied_version?: unknown } | undefined;
		return row?.applied_version === null || row?.applied_version === undefined
			? null
			: Number(row.applied_version);
	}

	setAppliedVersion(partnerId: string, sessionId: number, version: number): void {
		this.db
			.prepare(
				"UPDATE partner_session_links SET applied_version = ? WHERE partner_id = ? AND session_id = ?",
			)
			.run(version, partnerId, sessionId);
	}

	/** 内部会话 id → 拥有它的执事（反向查链接表）。没链接 = null（普通主人会话）。 */
	partnerIdOfSession(sessionId: number): string | null {
		// `session_id > 0` 滤掉执事的 delegation 占位行（session_id=0）：
		// 它登记的是领域路由，不是任何真实会话，不能让 0 号会话被误认成执事专线。
		const row = this.db
			.prepare(
				"SELECT partner_id FROM partner_session_links WHERE session_id = ? AND session_id > 0 ORDER BY created_at LIMIT 1",
			)
			.get(sessionId) as { partner_id?: unknown } | undefined;
		return row?.partner_id ? String(row.partner_id) : null;
	}

	// ── 例行任务定义（B3）────────────────────────────────
	createRoutine(input: {
		partnerId: string;
		name: string;
		prompt: string;
		triggers: RoutineTrigger[];
		sessionMode: "persistent" | "fresh";
		enabled: boolean;
	}): RoutineDef {
		if (!this.get(input.partnerId)) throw new Error(`执事不存在：${input.partnerId}`);
		const id = randomUUID();
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO routines (id, partner_id, name, prompt, triggers, session_mode, enabled, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
			)
			.run(
				id,
				input.partnerId,
				input.name,
				input.prompt,
				JSON.stringify(input.triggers),
				input.sessionMode,
				input.enabled ? 1 : 0,
				now,
				now,
			);
		return this.getRoutine(id) as RoutineDef;
	}

	getRoutine(id: string): RoutineDef | null {
		const row = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? toRoutine(row) : null;
	}

	listRoutines(partnerId?: string): RoutineDef[] {
		const rows = (
			partnerId
				? this.db
						.prepare("SELECT * FROM routines WHERE partner_id = ? ORDER BY created_at")
						.all(partnerId)
				: this.db.prepare("SELECT * FROM routines ORDER BY created_at").all()
		) as Array<Record<string, unknown>>;
		return rows.map(toRoutine);
	}

	/** revision 每次 +1：在飞的 durable 任务醒来时对不上号就自动作废（没有取消 API 的替代）。 */
	updateRoutine(
		id: string,
		patch: {
			name?: string;
			prompt?: string;
			triggers?: RoutineTrigger[];
			sessionMode?: "persistent" | "fresh";
			enabled?: boolean;
		},
	): RoutineDef | null {
		const existing = this.getRoutine(id);
		if (!existing) return null;
		const now = new Date().toISOString();
		this.db
			.prepare(
				"UPDATE routines SET name = ?, prompt = ?, triggers = ?, session_mode = ?, enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
			)
			.run(
				patch.name ?? existing.name,
				patch.prompt ?? existing.prompt,
				JSON.stringify(patch.triggers ?? existing.triggers),
				patch.sessionMode ?? existing.sessionMode,
				(patch.enabled ?? existing.enabled) ? 1 : 0,
				now,
				id,
			);
		return this.getRoutine(id);
	}

	deleteRoutine(id: string): boolean {
		const result = this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
		return Number(result.changes) > 0;
	}
}

// ── 懒建单例（projects.ts 同款纪律：进程启动不碰磁盘）────────
let store: PartnersStore | null = null;

export function partnersStore(): PartnersStore {
	store ??= new PartnersStore();
	return store;
}

// ── 总管（D1）解析与播种 ─────────────────────────────────

/**
 * 进程启动时调一次：CHIEF_PARTNER=false 或执事能力整体关闭时不播种
 * （两处旁路都 = 回到改动前形态，不在执事体系关掉时偷偷建库）。
 */
export function ensureChiefPartner(seedSoul: string): void {
	if (!chiefPartnerEnabled() || !COMPANIONS_ENABLED) return;
	partnersStore().ensureChief(seedSoul);
}

/** 总管 SOUL 当前身份正文：当前版本快照优先（版本冻结口径），磁盘当前值兜底；不可读返回 null。 */
export function chiefSoul(store: PartnersStore): string | null {
	if (!store.get(CHIEF_PARTNER_ID)) return null;
	const snapshot = store.currentVersion(CHIEF_PARTNER_ID)?.soulSource;
	const soul = snapshot?.trim() ? snapshot : store.readSoulFromHome(CHIEF_PARTNER_ID);
	return soul?.trim() ? soul : null;
}

/**
 * persona 正文：总管存在且 SOUL 可读时用 SOUL 当前版本快照，否则回落 fallback(=PERSONA)。
 * 兜底存在的原因：执事库初始化失败 / 查询抛错时**主对话不能哑**，必须还有人格。
 */
export function resolvePersona(getStore: () => PartnersStore, fallback: string): string {
	if (!chiefPartnerEnabled()) return fallback;
	try {
		return chiefSoul(getStore()) ?? fallback;
	} catch {
		return fallback;
	}
}

/**
 * 会话 → 有效执事 id（含总管）。
 * 行为零变化要点：**不复用 / 不修改 partnerIdOfSession**——autonomy / routines 靠
 * "partnerIdOfSession === null 就是主人会话" 做防自环，它们继续用原始函数。
 * CHIEF 开时，没挂链接表的主人会话解析为固定 id `"chief"`；执事会话返回真实 uuid。
 */
export function effectivePartnerIdOfSession(store: PartnersStore, sessionId: number): string | null {
	const linked = store.partnerIdOfSession(sessionId);
	if (linked !== null) return linked;
	return chiefPartnerEnabled() ? CHIEF_PARTNER_ID : null;
}

/**
 * 执事记忆 scope：总管（chief）刻意返回 null —— 他继续读写 `global + session`，
 * 不吃 `partner:<id>` 键空间（系统架构将记 D15）。其余执事照旧返回 partner scope。
 * 这是与普通执事的**刻意差异**，别"修"成一致。
 */
export function resolvePartnerScope(store: PartnersStore, sessionId: number): MemoryScope | null {
	const id = effectivePartnerIdOfSession(store, sessionId);
	if (id === CHIEF_PARTNER_ID) return null;
	return id ? { type: "partner", id } : null;
}

function toPartner(row: Record<string, unknown>): PartnerRow {
	return {
		id: String(row.id),
		name: String(row.name),
		status: (String(row.status) as PartnerStatus) || "active",
		currentVersion:
			row.current_version === null || row.current_version === undefined
				? null
				: Number(row.current_version),
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
		domain: row.domain === null || row.domain === undefined ? null : String(row.domain),
	};
}

function toRoutine(row: Record<string, unknown>): RoutineDef {
	let triggers: RoutineTrigger[] = [];
	try {
		const parsed: unknown = JSON.parse(String(row.triggers ?? "[]"));
		if (Array.isArray(parsed)) triggers = parsed as RoutineTrigger[];
	} catch {
		// 坏 JSON 当无触发器：任务不会响，但档案可改
	}
	return {
		id: String(row.id),
		partnerId: String(row.partner_id),
		name: String(row.name),
		prompt: String(row.prompt ?? ""),
		triggers,
		sessionMode: row.session_mode === "fresh" ? "fresh" : "persistent",
		enabled: Number(row.enabled ?? 0) === 1,
		revision: Number(row.revision ?? 1),
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
	};
}

function toLink(row: Record<string, unknown>): PartnerSessionLinkRow {
	return {
		partnerId: String(row.partner_id),
		role: String(row.role) as PartnerSessionLinkRow["role"],
		routeKey: row.route_key === null || row.route_key === undefined ? null : String(row.route_key),
		sessionId: Number(row.session_id),
		appliedVersion:
			row.applied_version === null || row.applied_version === undefined
				? null
				: Number(row.applied_version),
		createdAt: String(row.created_at ?? ""),
	};
}

function defaultSoul(name: string): string {
	return [
		`# ${name}`,
		"",
		"<!-- SOUL.md：这个执事是谁。改这里的正文，下一轮生效（版本快照在 partners.sqlite）。",
		"     写什么：性格、说话方式、在意的边界、长期在做的事。单文件 64KB 上限。 -->",
		"",
		`你是${name}，一个和一个具体的人长期相处的执事。`,
		"说话直接、克制、就事论事；不堆情绪词，不说教。",
		"涉及真实文件、数据、日程的事先用工具去看，不许凭印象编造。",
	].join("\n");
}

/**
 * 执事的 SOUL 播种（批次D D2）：一句话版本，不是普通执事的多行模板。
 * 宰相的「性格」由 chancellor 分管提示词给，这里只交代它是谁、管哪块。
 */
export function delegationSoulSeed(name: string, domain: string): string {
	return `你是${name}，${domain} 领域的负责人；总管把这一领域的事交给你，你带工人把活办完，只回一行结论。\n`;
}

/**
 * 按 domain 反查执事的派单身份（批次D D2）。
 * soul **取当前版本快照正文，不读磁盘当前值**——版本化语义：单次派单内不变，
 * 改了 SOUL 下一轮才生效。没命中 / 没有快照都返回 null（兼容旧领域）。
 */
export function partnerIdentityForDomain(
	store: PartnersStore,
	domain: string,
): { name: string; soul: string } | null {
	const id = store.partnerIdByDomain(domain);
	if (!id) return null;
	const partner = store.get(id);
	if (!partner) return null;
	const soul = store.currentVersion(id)?.soulSource;
	if (!soul?.trim()) return null;
	return { name: partner.name, soul };
}
