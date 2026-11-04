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

/**
 * 伙伴档案：DB 只存索引与版本快照，磁盘才是内容的家（2026-11-05 批次B B2）。
 *
 * 参考 cindy 的"文件=当前值、DB 版本行=冻结快照"双层契约：
 *   - `SOUL.md` 在磁盘上是**当前值**，谁都能改（设置页 / 宿主）；
 *   - `partner_versions` 是**冻结快照**：伙伴轮次启动认版本号，整轮身份不变；
 *     改完 SOUL 不当场变身，下一轮生效——这是设计出来的不一致，别"修"成即时生效。
 *
 * 家目录 `.data/partner-homes/<uuid>/`：
 *   SOUL.md（身份，播种时最后写 = 家建好的标志）/ memories/USER.md（主人画像）/
 *   workspace/（唯一默认可写区）/ memories/ / skills/。
 * 单槽 64KB 上限；全部原子写（临时文件 + rename）。
 *
 * 权限边界：模型的原始文件工具只挂 workspace/（agent.ts 的 pathGuard 指过来）；
 * memories/skills 的写只能走宿主类型化接口（remember 落伙伴 scope / partner_skill_write）。
 * 本模块**只做存储**，不 import agent.ts——装配方向 partners ← agent，防循环。
 */

export const COMPANIONS_ENABLED =
	(process.env.COMPANIONS_ENABLED?.trim() || "true").toLowerCase() !== "false";

const DEFAULT_DB_PATH = ".data/partners.sqlite";
const DEFAULT_HOMES_ROOT = ".data/partner-homes";

/** 单槽上限（SOUL.md / USER.md / 技能文件同口径，cindy 同款） */
export const PARTNER_SLOT_LIMIT = 64 * 1024;

export type PartnerStatus = "active" | "paused" | "archived";

export interface PartnerRow {
	id: string;
	name: string;
	status: PartnerStatus;
	/** 当前身份快照版本号；还没建过版本 = null */
	currentVersion: number | null;
	createdAt: string;
	updatedAt: string;
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
	role: "canonical" | "routine" | "topic";
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
				updated_at      TEXT NOT NULL
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
	}

	close(): void {
		this.db.close();
	}

	// ── 档案 CRUD ─────────────────────────────────────────
	create(name: string): PartnerRow {
		const id = randomUUID();
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO partners (id, name, status, current_version, created_at, updated_at) VALUES (?, ?, 'active', NULL, ?, ?)",
			)
			.run(id, name, now, now);
		// 建档案即建家 + 首个身份版本：伙伴生下来就有身份
		this.ensureHome(id, name);
		const soul = this.readSoulFromHome(id) ?? defaultSoul(name);
		this.pushVersion(id, soul, null);
		this.ensureHome(id, name);
		return this.get(id) as PartnerRow;
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
		// 例行任务定义跟着走：不清理会留孤儿（任务醒来 runPartnerTurn 报"伙伴不存在"）
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
		if (!partner) throw new Error(`伙伴不存在：${partnerId}`);
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
	ensureHome(partnerId: string, name: string): void {
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
			this.atomicWrite(userMd, `# 主人画像\n\n（伙伴相处中自行补充；只记事实，不记猜测。）\n`);
		}
		const soulMd = join(home, "SOUL.md");
		if (!existsSync(soulMd)) {
			this.atomicWrite(soulMd, defaultSoul(name));
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
		if (!this.get(partnerId)) throw new Error(`伙伴不存在：${partnerId}`);
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
	 * 找伙伴的专线会话链接；没有就返回 null（调用方建好会话后 linkSession 补记）。
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

	/** 内部会话 id → 拥有它的伙伴（反向查链接表）。没链接 = null（普通主人会话）。 */
	partnerIdOfSession(sessionId: number): string | null {
		const row = this.db
			.prepare(
				"SELECT partner_id FROM partner_session_links WHERE session_id = ? ORDER BY created_at LIMIT 1",
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
		if (!this.get(input.partnerId)) throw new Error(`伙伴不存在：${input.partnerId}`);
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
		"<!-- SOUL.md：这个伙伴是谁。改这里的正文，下一轮生效（版本快照在 partners.sqlite）。",
		"     写什么：性格、说话方式、在意的边界、长期在做的事。单文件 64KB 上限。 -->",
		"",
		`你是${name}，一个和一个具体的人长期相处的伙伴。`,
		"说话直接、克制、就事论事；不堆情绪词，不说教。",
		"涉及真实文件、数据、日程的事先用工具去看，不许凭印象编造。",
	].join("\n");
}
