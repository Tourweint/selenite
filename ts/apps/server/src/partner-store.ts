/**
 * PartnersStore（SQLite 落库：伙伴 / 版本 / 例行任务 / 群聊）
 *
 * 2026-11-13 从 partners.ts 的 L294–L1350 整段切出；正文原文搬运，未改一行实现。
 */

import { randomUUID } from "node:crypto";
import type {
	PartnerMood,
	PartnerOwnerTier,
	PartnerPersonaModule,
	PartnerPersonaPreset,
	PartnerPersonaSwitches,
} from "@lifediary/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHIEF_PARTNER_ID, CHIEF_PARTNER_NAME, DEFAULT_DB_PATH, DEFAULT_HOMES_ROOT, PARTNER_SLOT_LIMIT, partnerContractEnabled, partnerContractTemplate } from "./partner-contract.ts";
import type { GroupMessageRow, GroupRow, ModelChainItemLike, PartnerRow, PartnerSessionLinkRow, PartnerStatus, RoutineDef, RoutineTrigger } from "./partner-types.ts";
import { defaultSoul, toGroup, toGroupMessage, toLink, toPartner, toProjectIds, toRoutine } from "./partner-rows.ts";

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
				domain          TEXT,
				avatar          TEXT,
				dispatch_authority INTEGER NOT NULL DEFAULT 0,
				-- 工具结果投影三态（2026-11-13 工具层结果契约化 §5.2）：NULL = 跟随默认；1 = 强制开；0 = 强制关。
				tool_projection  INTEGER,
			current_goal    TEXT,
				tagline         TEXT,
				diary           INTEGER NOT NULL DEFAULT 0,
				-- 项目记忆挂载（2026-11-15 多挂载方案）：JSON 数组。上线首日的单值列
				-- project_id 只在旧库存在，migrate() 搬进本列后不再读写。
				project_ids     TEXT,
			persona_preset  TEXT,
			persona_modules TEXT,
			persona_switches TEXT,
			owner_tier      TEXT,
			nearby          TEXT,
			mood            TEXT,
			mood_reason     TEXT,
			mood_updated_at TEXT,
			mood_source     TEXT,
			-- 人设页工具勾选（2026-11-16 工具裁剪 B）：JSON 数组，只存被取消的工具名；空 = 全开。
			disabled_tools  TEXT,
				-- 按人常驻（2026-11-17）：JSON 数组，只存被提升的 deferred 工具名；空 = 全按需。
				promoted_tools TEXT,
				-- 关于我（2026-11-19）：1 / NULL = 读全局「关于我」，0 = 不读。不版本化。
				user_profile_read INTEGER NOT NULL DEFAULT 1
				);
			/* partner_versions 表已退役（2026-11-15 人设停存版本快照方案）：快照历史只写不读，
			 * 新库不再建表；老库启动时由 migrate() 搬走候选链后 DROP。 */
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
				until_note   TEXT,
				max_runs     INTEGER,
				created_at   TEXT NOT NULL,
				updated_at   TEXT NOT NULL
			);
			/* ── 群组（2026-11-06 群组方案 §2.1）────────────────
			 * 群 = 共享时间线 + 成员表；成员各自独立上下文。
			 * 消息作者落快照（改名/离群/删档后历史不烂）；成员表只存引用不复制人格。
			 * 硬删口径：删群 = 群 + 成员关系 + 消息一起没（方案 §六登记，不可恢复）。 */
			CREATE TABLE IF NOT EXISTS groups (
				id                   TEXT PRIMARY KEY,
				name                 TEXT NOT NULL,
				notice               TEXT NOT NULL DEFAULT '',
				responder_kind       TEXT NOT NULL DEFAULT 'member',
				responder_partner_id TEXT,
				created_at           TEXT NOT NULL,
				updated_at           TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS group_members (
				group_id   TEXT NOT NULL,
				partner_id TEXT NOT NULL,
				position   INTEGER NOT NULL,
				joined_at  TEXT NOT NULL,
				PRIMARY KEY (group_id, partner_id)
			);
			CREATE TABLE IF NOT EXISTS group_messages (
				id          TEXT PRIMARY KEY,
				group_id    TEXT NOT NULL,
				seq         INTEGER NOT NULL,
				kind        TEXT NOT NULL,
				author_kind TEXT NOT NULL,
				author_id   TEXT,
				author_name TEXT NOT NULL,
				content     TEXT NOT NULL,
				at          TEXT NOT NULL,
				round_id    TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_group_messages_group_seq ON group_messages (group_id, seq);
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
		// 头像列（2026-11-06 侧栏调整 B1）：旧库补 nullable 列，旧记录读出来是 null（前端首字兜底）。
		if (!columns.some((column) => column.name === "avatar")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN avatar TEXT");
		}
		// 派发权列（2026-11-06 执事派发权开关）：旧库补列，旧记录读出来是 false（默认关）。
		if (!columns.some((column) => column.name === "dispatch_authority")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN dispatch_authority INTEGER NOT NULL DEFAULT 0");
		}
		// 工具结果投影三态列（2026-11-13 工具层结果契约化 §5.2）：旧库补 nullable 列，
		// 老记录读出来是 null（= 跟随默认判定）。照 dispatch_authority 的补列先例。
		if (!columns.some((column) => column.name === "tool_projection")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN tool_projection INTEGER");
		}
		// 当前目标列（2026-11-08 员工人格化刀二 E4）：旧库补 nullable 列，
		// 老记录读出来是 null（= 没设目标），不炸、不补数据、不版本化。
		if (!columns.some((column) => column.name === "current_goal")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN current_goal TEXT");
		}
		// 口头禅列（2026-11-12 手机对话身份方案 §四）：旧库补 nullable 列，
		// 老记录读出来是 null（= 没设口头禅），不炸、不补数据、不版本化。
		if (!columns.some((column) => column.name === "tagline")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN tagline TEXT");
		}
		// 日记执事列（2026-11-12 日记 v2）：旧库补 INTEGER 默认 0；老记录读出来是 false。
		if (!columns.some((column) => column.name === "diary")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN diary INTEGER NOT NULL DEFAULT 0");
		}
		// 项目记忆挂载列（2026-11-15 多挂载方案）：JSON 数组。上线首日的单值列
		// project_id（跟人走方案，只活了半天、手机端未消费）搬进本列后不再读写；
		// 搬家只在"本列刚补上"时做一次，幂等重跑不会拿旧单值覆盖新数组。
		// 旧列保留不 DROP（SQLite 老库 DROP COLUMN 兼容面，没必要冒险）。
		if (!columns.some((column) => column.name === "project_ids")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN project_ids TEXT");
			if (columns.some((column) => column.name === "project_id")) {
				const singles = this.db
					.prepare("SELECT id, project_id FROM partners WHERE project_id IS NOT NULL")
					.all() as Array<{ id: unknown; project_id: unknown }>;
				for (const row of singles) {
					this.db
						.prepare("UPDATE partners SET project_ids = ? WHERE id = ?")
						.run(JSON.stringify([String(row.project_id)]), String(row.id));
				}
			}
		}
		// 人格预设 / 开关（2026-11-14 人格模块 §四）：旧库补两个 nullable 列，
		// 老记录读出来是 null —— 预设按默认 `work`、开关按预设默认算（不是"全关"）。
		if (!columns.some((column) => column.name === "persona_preset")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN persona_preset TEXT");
		}
		if (!columns.some((column) => column.name === "persona_modules")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN persona_modules TEXT");
		}
		// 人格子开关 + 活状态（2026-11-15 批2）：旧库补 nullable 列，老行读 null ——
		// 子开关按默认关、温度按 `生疏`、心情按 `平静`（`toPartner` 统一兜底）。
		for (const column of [
			"persona_switches",
			"owner_tier",
			"nearby",
			"mood",
			"mood_reason",
			"mood_updated_at",
			"mood_source",
		]) {
			if (!columns.some((existing) => existing.name === column)) {
				this.db.exec(`ALTER TABLE partners ADD COLUMN ${column} TEXT`);
			}
		}
		// 人设页工具勾选（2026-11-16 工具裁剪 B）：旧库补 nullable 列，老行读出来是 null
		// （= 没取消任何工具 = 全开），不炸、不补数据、不版本化。照 dispatch_authority 的补列先例。
		if (!columns.some((column) => column.name === "disabled_tools")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN disabled_tools TEXT");
		}
		// 按人常驻（2026-11-17）：旧库补 nullable 列，老行读 null = 全按需（现状），不炸、不补数据。
		if (!columns.some((column) => column.name === "promoted_tools")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN promoted_tools TEXT");
		}
		// 关于我读取开关（2026-11-19）：旧库补列，默认 1 = 读（新能力净增类默认开）；
		// 不版本化、不补数据。普通 worker 不在这张表，固定不读。
		if (!columns.some((column) => column.name === "user_profile_read")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN user_profile_read INTEGER NOT NULL DEFAULT 1");
		}
		// 例行任务条件门控（2026-11-10 批 13 §四）：旧库补两个 nullable 列，
		// 老规则读出来是 null（= 无完成条件 / 不限次数），不炸、不补数据。
		const routineColumns = this.db.prepare("PRAGMA table_info(routines)").all() as Array<{
			name?: unknown;
		}>;
		if (!routineColumns.some((column) => column.name === "until_note")) {
			this.db.exec("ALTER TABLE routines ADD COLUMN until_note TEXT");
		}
		if (!routineColumns.some((column) => column.name === "max_runs")) {
			this.db.exec("ALTER TABLE routines ADD COLUMN max_runs INTEGER");
		}
		// 版本快照表退役（2026-11-15 人设停存版本快照方案）：快照历史只写不读
		// （2026-11-15 全量消费方核对），唯一还有价值的 capabilities.modelChain 搬到
		// 执事家目录 model-chain.json，随后整表 DROP。SOUL / CONTRACT 当前值本来就在盘上，
		// 无数据丢失面；新库从来不会建这张表。
		if (this.tableExists("partner_versions")) {
			this.migrateModelChainOutOfVersions();
			this.db.exec("DROP TABLE partner_versions");
		}
	}

	/** sqlite_master 探表：迁移只关心"表在不在"，不用 PRAGMA 逐列看。 */
	private tableExists(name: string): boolean {
		const row = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(name);
		return row != null;
	}

	/** 老库候选链搬家：当前版本行 capabilities.modelChain → 家目录 model-chain.json（幂等，文件已在就跳过）。 */
	private migrateModelChainOutOfVersions(): void {
		const partners = this.db.prepare("SELECT id, current_version FROM partners").all() as Array<{
			id: unknown;
			current_version: unknown;
		}>;
		for (const partner of partners) {
			if (partner.current_version == null) continue;
			const row = this.db
				.prepare("SELECT capabilities FROM partner_versions WHERE partner_id = ? AND version = ?")
				.get(String(partner.id), Number(partner.current_version)) as { capabilities?: unknown } | undefined;
			if (!row?.capabilities) continue;
			try {
				const parsed = JSON.parse(String(row.capabilities)) as { modelChain?: unknown };
				if (!Array.isArray(parsed.modelChain) || parsed.modelChain.length === 0) continue;
				const target = join(this.homeOf(String(partner.id)), "model-chain.json");
				if (existsSync(target)) continue;
				this.atomicWrite(target, `${JSON.stringify(parsed.modelChain, null, 2)}\n`);
			} catch {
				// capabilities 不是合法 JSON 就当没有候选链，搬家失败不挡启动
			}
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
		// 建档案即建家 + 身份计数从 1 起（2026-11-15 快照退役）：执事生下来就有身份。
		// 执事用「一句话版本」SOUL 播种（批次D D2），普通执事用默认模板。
		this.ensureHome(id, name, opts?.soulSeed);
		// 岗位契约（2026-11-08 E1）：**只在新建时**播种空模板；存量执事不自动补文件
		// （不越权——它没见过这份契约，凭空出现一个文件比没有更让人困惑）。
		this.seedContract(id);
		this.bumpIdentityEpoch(id);
		this.ensureHome(id, name, opts?.soulSeed);
		// 执事：在链接表登记领域路由（role 枚举扩一型 'delegation'）。
		// 既有 UNIQUE (partner_id, role, route_key) 已覆盖这个组合，无需改约束。
		if (domain) this.linkDelegation(id, domain);
		return this.get(id) as PartnerRow;
	}

	/**
	 * 总管专用播种（批次D D1）：固定 id `"chief"`，首次启动建档案 + 家 + 身份计数置 1
	 * （2026-11-15 快照退役：计数只是「下一轮生效」的记账位，不再落快照）。
	 * **幂等**：档案 / SOUL.md / 计数任一已存在都不动——二次启动绝不覆盖用户改过的 SOUL
	 * （含通过 PATCH/bumpSoul 推进过的保存）。
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
		const chief = this.get(CHIEF_PARTNER_ID);
		if (chief && chief.currentVersion == null) this.bumpIdentityEpoch(CHIEF_PARTNER_ID);
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

	/**
	 * 设置 / 清除头像（2026-11-06 侧栏调整 B1）：一条 UPDATE 原子落地。
	 * 只写 avatar（与 updated_at），不碰名字 / 状态 / 身份版本——坏图不该带出别的写入。
	 * 校验在端点（shared 的 PartnerAvatarPatchSchema）；这里假设值已合法。
	 */
	setAvatar(id: string, avatar: string | null): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET avatar = ?, updated_at = ? WHERE id = ?")
			.run(avatar, new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 设置派发权（2026-11-06 执事派发权开关）：一条 UPDATE 原子落地。
	 * 只写 dispatch_authority（与 updated_at）；不存在返回 null，由调用方映射 404。
	 */
	/**
	 * 改 domain 标签（2026-11-07）。
	 *
	 * 语义变化：domain 从"派活路由主键"降级为**可选展示标签**——派活路由按执事 id /
	 * 会话链接，不再靠这个字符串，所以改名不会让历史单找不到负责人。
	 * `null` = 清掉标签（回到"普通执事"）。
	 *
	 * 不加唯一约束：已有表结构里 domain 没有唯一索引，历史上也允许空值；
	 * 占用冲突由调用方（端点 / 工具）先查后写，保持与创建路径同一套校验。
	 */
	setDomain(id: string, domain: string | null): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET domain = ?, updated_at = ? WHERE id = ?")
			.run(domain, new Date().toISOString(), id);
		return this.get(id);
	}

	setDispatchAuthority(id: string, enabled: boolean): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET dispatch_authority = ?, updated_at = ? WHERE id = ?")
			.run(enabled ? 1 : 0, new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 设置工具结果投影三态（2026-11-13 工具层结果契约化 §5.2）：与 setDispatchAuthority 同构，
	 * 但值可空——null = 恢复跟随默认（§5.3）。形状归一（非 0/1 一律当 null）在这里收口。
	 * 不存在返回 null，由调用方映射 404。
	 */
	setToolProjection(id: string, value: 1 | 0 | null): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET tool_projection = ?, updated_at = ? WHERE id = ?")
			.run(value === 1 || value === 0 ? value : null, new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 设置 / 清除当前目标（2026-11-08 员工人格化刀二 E4）：一条 UPDATE 原子落地。
	 * 形状校验在端点（字符串 / null / 空 = 清除）；这里假设值已合法。
	 * 只写 current_goal 与 updated_at，不碰身份版本——目标不是身份，不 bump。
	 */
	setCurrentGoal(id: string, goal: string | null): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET current_goal = ?, updated_at = ? WHERE id = ?")
			.run(goal, new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 设置 / 清除口头禅（2026-11-12 手机对话身份方案 §四）：一条 UPDATE 原子落地。
	 * 形状校验（≤40 字、trim、空 = 清除）在端点；这里假设值已合法。
	 * 只写 tagline 与 updated_at，不碰身份版本——口头禅不是身份，不 bump。
	 */
	setTagline(id: string, tagline: string | null): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET tagline = ?, updated_at = ? WHERE id = ?")
			.run(tagline, new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 人格预设 + 模块开关（2026-11-14 人格模块 §四）：一条 UPDATE 原子落地。
	 * 两个值都已是合法形状（端点过 zod、缺省键按预设默认补全后传进来）；
	 * **不版本化**——人格模块不是身份，不动 SOUL / 契约、不推身份计数。
	 */
	setPersona(
		id: string,
		patch: {
			preset: PartnerPersonaPreset;
			modules: Record<PartnerPersonaModule, boolean>;
			/** 2026-11-15 批2 子开关；省略 = 保持原值（别的调用方零改动）。 */
			switches?: PartnerPersonaSwitches;
		},
	): PartnerRow | null {
		const existing = this.get(id);
		if (!existing) return null;
		const switches = patch.switches ?? existing.personaSwitches;
		this.db
			.prepare(
				"UPDATE partners SET persona_preset = ?, persona_modules = ?, persona_switches = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				patch.preset,
				JSON.stringify(patch.modules),
				JSON.stringify(switches),
				new Date().toISOString(),
				id,
			);
		return this.get(id);
	}

	/**
	 * 关系温度（2026-11-15 批2）：一条 UPDATE，不版本化。
	 * 跨档的"可解释事件"由调用方先写进印象账（带 `tierChange` 的记录），这里只落当前档。
	 */
	setOwnerTier(id: string, tier: PartnerOwnerTier): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET owner_tier = ?, updated_at = ? WHERE id = ?")
			.run(tier, new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 心情 / 近况（2026-11-15 批2）：一条 UPDATE，不版本化。
	 * 省略的字段保持原值（心情与近况各自可单独改）；`source` 记 `rule` / `manual`。
	 */
	setLivingState(
		id: string,
		patch: {
			nearby?: string | null;
			mood?: PartnerMood;
			moodReason?: string | null;
			moodSource?: "rule" | "manual";
		},
	): PartnerRow | null {
		const existing = this.get(id);
		if (!existing) return null;
		const touchedMood =
			patch.mood !== undefined || patch.moodReason !== undefined || patch.moodSource !== undefined;
		this.db
			.prepare(
				"UPDATE partners SET nearby = ?, mood = ?, mood_reason = ?, mood_updated_at = ?, mood_source = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				patch.nearby !== undefined ? patch.nearby : existing.nearby,
				patch.mood ?? existing.mood,
				patch.moodReason !== undefined ? patch.moodReason : existing.moodReason,
				touchedMood ? new Date().toISOString() : existing.moodUpdatedAt,
				patch.moodSource !== undefined ? patch.moodSource : existing.moodSource,
				new Date().toISOString(),
				id,
			);
		return this.get(id);
	}

	/**
	 * 设置 / 清除日记执事（2026-11-12 日记 v2）：全局至多一个。
	 * 置 true 时同事务把其他执事的 diary 清掉——不允许两个"日记执事"，也不靠调用方自己保证。
	 * 不碰身份版本（不是身份）。
	 */
	setDiary(id: string, enabled: boolean): PartnerRow | null {
		if (!this.get(id)) return null;
		const now = new Date().toISOString();
		// node:sqlite 的 DatabaseSync 没有 better-sqlite3 的 db.transaction()，显式事务。
		this.db.exec("BEGIN");
		try {
			if (enabled) {
				this.db
					.prepare("UPDATE partners SET diary = 0, updated_at = ? WHERE id <> ? AND diary = 1")
					.run(now, id);
			}
		this.db
			.prepare("UPDATE partners SET diary = ?, updated_at = ? WHERE id = ?")
			.run(enabled ? 1 : 0, now, id);
		this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return this.get(id);
	}

	/**
	 * 设置 / 清除项目记忆挂载（2026-11-15 项目记忆多挂载方案）：uuid 数组（[] = 不挂）。
	 * 项目是否存在由端点层校验（业务 400）；这里只落库。不碰身份版本（不是身份）。
	 */
	setProjectIds(id: string, projectIds: string[]): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET project_ids = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(projectIds), new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 设置工具取消名单（2026-11-16 工具裁剪 B）：一条 UPDATE，只写 disabled_tools 与 updated_at。
	 * 存"被取消的工具名"而不是"被勾选的"——以后新增工具默认可见。调用方（端点）保证 names
	 * 已去重且都是已知工具名（sanitizeDisabledTools 收口）。**不版本化**：不 bump 身份计数、
	 * 不动 SOUL / 契约，也不重启会话（下一轮才生效）。不存在返回 null，由调用方映射 404。
	 */
	setDisabledTools(id: string, names: string[]): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET disabled_tools = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(names), new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 设置按人常驻名单（2026-11-17 按人常驻方案）：一条 UPDATE，只写 promoted_tools 与
	 * updated_at。存"被提升成常驻的 deferred 工具名"，空数组 = 全部按需（= 现状）。
	 * 调用方（端点）保证去重、都是已知 deferred 工具、且不与取消名单冲突。
	 * **不版本化**、不重启会话；下一轮由 applyPartnerToolSelection 写进 modelTools.add。
	 */
	setPromotedTools(id: string, names: string[]): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET promoted_tools = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(names), new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 设置「关于我」读取开关（2026-11-19）：一条 UPDATE，只写 user_profile_read 与 updated_at。
	 * `true` = 读（1），`false` = 不读（0）。**不版本化**（不是身份），不动 SOUL / 契约，
	 * 下一轮注入生效（provider 每轮现读）。不存在返回 null，由端点映射 404。
	 */
	setUserProfileRead(id: string, read: boolean): PartnerRow | null {
		if (!this.get(id)) return null;
		this.db
			.prepare("UPDATE partners SET user_profile_read = ?, updated_at = ? WHERE id = ?")
			.run(read ? 1 : 0, new Date().toISOString(), id);
		return this.get(id);
	}

	/**
	 * 项目登记删除时的连带解除（2026-11-15 删除项目界面入口恢复）：清掉所有指向
	 * 该项目的挂载，返回解除条数给界面提示。挂载顺序在端点层保证"先解除、后删登记"——
	 * 反过来登记删了就没人负责清这些悬空引用了。不碰身份版本（不是身份）。
	 * 多挂载后挂载是 JSON 数组，SQL 端改不了 JSON：读出来在 JS 里过滤再写回
	 * （partners 表量级是个位数到几十，全表扫没有压力）。
	 */
	detachProject(projectId: string): number {
		const rows = this.db
			.prepare("SELECT id, project_ids FROM partners")
			.all() as Array<{ id: unknown; project_ids: unknown }>;
		let detached = 0;
		for (const row of rows) {
			const ids = toProjectIds(row.project_ids);
			const next = ids.filter((id) => id !== projectId);
			if (next.length === ids.length) continue;
			detached += ids.length - next.length;
			this.db
				.prepare("UPDATE partners SET project_ids = ?, updated_at = ? WHERE id = ?")
				.run(JSON.stringify(next), new Date().toISOString(), String(row.id));
		}
		return detached;
	}

	/**
	 * 把挂载从源项目改挂到目标项目（2026-11-17 项目合并）。
	 *
	 * 与 `detachProject` 同一套"读出来在 JS 里改再写回"（JSON 数组 SQL 端改不了）。
	 * 去重：原本同时挂了两边的执事，合并后只挂一条。返回改动的挂载条数。
	 */
	reparentProject(sourceProjectId: string, targetProjectId: string): number {
		if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId) return 0;
		const rows = this.db
			.prepare("SELECT id, project_ids FROM partners")
			.all() as Array<{ id: unknown; project_ids: unknown }>;
		let reparented = 0;
		for (const row of rows) {
			const ids = toProjectIds(row.project_ids);
			if (!ids.includes(sourceProjectId)) continue;
			const next: string[] = [];
			for (const id of ids) {
				const mapped = id === sourceProjectId ? targetProjectId : id;
				if (next.includes(mapped)) continue;
				next.push(mapped);
			}
			reparented += 1;
			this.db
				.prepare("UPDATE partners SET project_ids = ?, updated_at = ? WHERE id = ?")
				.run(JSON.stringify(next), new Date().toISOString(), String(row.id));
		}
		return reparented;
	}

	/** 删除：档案行 + 版本行 + 链接行 + 家目录整体。家目录没了身份就没了，二次确认在端点层。 */
	delete(id: string): boolean {
		const existing = this.get(id);
		if (!existing) return false;
		this.db.prepare("DELETE FROM partners WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM partner_session_links WHERE partner_id = ?").run(id);
		// 例行任务定义跟着走：不清理会留孤儿（任务醒来 runPartnerTurn 报"执事不存在"）
		this.db.prepare("DELETE FROM routines WHERE partner_id = ?").run(id);
		// 群成员关系级联清（群组方案 §2.1）：群历史靠作者快照照常渲染，
		// 正在跑的该执事发言由回合编排器跳过并落 system 行。
		this.db.prepare("DELETE FROM group_members WHERE partner_id = ?").run(id);
		try {
			rmSync(this.homeOf(id), { recursive: true, force: true });
		} catch {
			// 目录删不掉不挡档案删除（可能本来就没建成）；warn 留给调用方
		}
		return true;
	}

	// ── 身份计数（2026-11-15 快照退役）──────────────────────
	/**
	 * 身份计数 +1，返回新值。快照退役后它只剩一个活：**「下一轮生效」的记账位**——
	 * 会话侧比对 `applied_version ≠ current_version` 才重配 instructions。
	 * 号不再对应任何存档；正文当前值的唯一事实源是家目录文件。
	 */
	private bumpIdentityEpoch(partnerId: string): number {
		const partner = this.get(partnerId);
		if (!partner) throw new Error(`执事不存在：${partnerId}`);
		const version = (partner.currentVersion ?? 0) + 1;
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE partners SET current_version = ?, updated_at = ? WHERE id = ?")
			.run(version, now, partnerId);
		return version;
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

	/**
	 * 岗位契约当前值（磁盘）。缺失 = null（旧执事没有这个文件，读取方按"四节全空"处理）。
	 * 与 SOUL 同址同权限：64KB 单槽、原子写。
	 */
	readContractFromHome(partnerId: string): string | null {
		return this.readHomeFile(partnerId, "CONTRACT.md");
	}

	/**
	 * 执事纪律覆盖当前值（2026-11-16）。缺失 = null（按宿主默认纪律渲染）。
	 * 只由人写（档案页），模型工具不碰；空内容 = 恢复宿主默认（文件删掉）。
	 */
	readDisciplineFromHome(partnerId: string): string | null {
		return this.readHomeFile(partnerId, "DISCIPLINE.md");
	}

	/** 写 `DISCIPLINE.md`；空内容删文件，回到宿主默认。与 SOUL / 契约共用 64KB 槽位护栏。 */
	writeDisciplineToHome(partnerId: string, source: string): void {
		if (!this.get(partnerId)) throw new Error(`执事不存在：${partnerId}`);
		const path = join(this.homeOf(partnerId), "DISCIPLINE.md");
		if (!source.trim()) {
			rmSync(path, { force: true });
			return;
		}
		this.atomicWrite(path, source);
	}

	/**
	 * 播种空契约模板（只在新建执事时调用；幂等，已有内容绝不覆盖）。
	 * 开关关着 = 一个字节都不写（回滚后与改动前逐字节一致）。
	 */
	seedContract(partnerId: string): void {
		if (!partnerContractEnabled()) return;
		const path = join(this.homeOf(partnerId), "CONTRACT.md");
		if (existsSync(path)) return;
		this.atomicWrite(path, partnerContractTemplate());
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

	/**
	 * 改 SOUL.md（磁盘当前值），返回身份计数。快照退役（2026-11-15 方案）：
	 * 写盘前把当前值存进 `SOUL.prev.md`（单槽），`rollbackSoul` 与它交换；
	 * 计数只当「下一轮生效」的记账位。
	 */
	bumpSoul(partnerId: string, soulSource: string): number {
		if (!this.get(partnerId)) throw new Error(`执事不存在：${partnerId}`);
		const home = this.homeOf(partnerId);
		const previous = this.readHomeFile(partnerId, "SOUL.md");
		if (previous != null) this.atomicWrite(join(home, "SOUL.prev.md"), previous);
		this.atomicWrite(join(home, "SOUL.md"), soulSource);
		return this.bumpIdentityEpoch(partnerId);
	}

	/**
	 * 回滚到上一份：SOUL.md 与 SOUL.prev.md **交换**（再按一次 = 撤销回滚），
	 * 计数 +1 维持「下一轮生效」。没有上一份（从未保存过）返回 null。
	 */
	rollbackSoul(partnerId: string): string | null {
		if (!this.get(partnerId)) throw new Error(`执事不存在：${partnerId}`);
		const home = this.homeOf(partnerId);
		const current = this.readHomeFile(partnerId, "SOUL.md");
		const previous = this.readHomeFile(partnerId, "SOUL.prev.md");
		if (previous == null) return null;
		this.atomicWrite(join(home, "SOUL.prev.md"), current ?? "");
		this.atomicWrite(join(home, "SOUL.md"), previous);
		this.bumpIdentityEpoch(partnerId);
		return previous;
	}

	/**
	 * 改 CONTRACT.md（磁盘当前值），返回身份计数（2026-11-08 E1）。
	 *
	 * 调岗是低频慎重的事，但"下一轮生效"的口径与 SOUL 一致——改完不当场变身。
	 * 刻意不做上一份/回滚（2026-11-15 方案「明确不做」）：低频操作有弹窗确认兜着。
	 */
	bumpContract(partnerId: string, contractSource: string): number {
		if (!this.get(partnerId)) throw new Error(`执事不存在：${partnerId}`);
		this.atomicWrite(join(this.homeOf(partnerId), "CONTRACT.md"), contractSource);
		return this.bumpIdentityEpoch(partnerId);
	}

	/** 模型候选链（B4）：家目录 `model-chain.json` 是唯一事实源（2026-11-15 从版本行搬家）。 */
	getModelChain(partnerId: string): ModelChainItemLike[] {
		const raw = this.readHomeFile(partnerId, "model-chain.json");
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw) as ModelChainItemLike[] | { modelChain?: ModelChainItemLike[] };
			const chain = Array.isArray(parsed) ? parsed : parsed.modelChain;
			return Array.isArray(chain) ? chain : [];
		} catch {
			return [];
		}
	}

	setModelChain(partnerId: string, chain: ModelChainItemLike[]): number {
		// 候选链搬家（2026-11-15）：写家目录文件，不再寄存版本行。
		// 计数照旧 +1（沿用「切模型也是新身份版本」的旧口径，不改行为只换落点）。
		this.atomicWrite(join(this.homeOf(partnerId), "model-chain.json"), `${JSON.stringify(chain, null, 2)}\n`);
		return this.bumpIdentityEpoch(partnerId);
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

	/**
	 * 内部会话 id → 该 id **只作为 canonical 主会话**时的执事（2026-11-10 批 29 返工）。
	 *
	 * 与 `partnerIdOfSession` 同表同法，只多一条 `role = 'canonical'`：
	 * 群成员（role='group'）、例行专线（role='routine'）、课题专线（role='topic'）
	 * 都不算"这个执事的门面会话"。**刻意不合并进原函数**——原函数的语义是
	 * "这条会话归谁"，记忆 / 自环判定依赖它把群成员与专线也认成执事；
	 * 唤醒要的是更窄的"派活会话是不是主对话"，所以单独一个方法。
	 */
	canonicalPartnerIdOfSession(sessionId: number): string | null {
		// session_id > 0 同款：滤掉 delegation 领域路由的占位行。
		const row = this.db
			.prepare(
				"SELECT partner_id FROM partner_session_links WHERE session_id = ? AND session_id > 0 AND role = 'canonical' ORDER BY created_at LIMIT 1",
			)
			.get(sessionId) as { partner_id?: unknown } | undefined;
		return row?.partner_id ? String(row.partner_id) : null;
	}

	/**
	 * 该执事名下所有**真实**会话的内部 id（2026-11-08 员工人格化刀一 E5）。
	 *
	 * 用途：判断"这张派活单是不是他发起的"——派单时 `originConversationId` 落的就是
	 * 发起会话的内部 id。canonical / routine / group 都算；`session_id > 0` 滤掉
	 * delegation 占位行（领域路由不是会话）。只读，不建链接。
	 */
	sessionIdsOf(partnerId: string): number[] {
		const rows = this.db
			.prepare(
				"SELECT session_id FROM partner_session_links WHERE partner_id = ? AND session_id > 0",
			)
			.all(partnerId) as Array<{ session_id?: unknown }>;
		return rows
			.map((row) => Number(row.session_id))
			.filter((id) => Number.isInteger(id) && id > 0);
	}

	/** 按内部会话 id 反查链接（任意 role）；多行时取 created_at 最早一条。没有 = null。 */
	linkOfSession(sessionId: number): PartnerSessionLinkRow | null {
		const row = this.db
			.prepare(
				"SELECT * FROM partner_session_links WHERE session_id = ? AND session_id > 0 ORDER BY created_at LIMIT 1",
			)
			.get(sessionId) as Record<string, unknown> | undefined;
		return row ? toLink(row) : null;
	}

	/** 某执事的全部副会话链接，按 created_at 升序。 */
	sideLinksOf(partnerId: string): PartnerSessionLinkRow[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM partner_session_links WHERE partner_id = ? AND role = 'side' AND session_id > 0 ORDER BY created_at",
			)
			.all(partnerId) as Array<Record<string, unknown>>;
		return rows.map(toLink);
	}

	/**
	 * 删除一条副会话链接（2026-11-18 分支会话删除）。
	 * 只删 `role = 'side'`：canonical / routine / topic / group / delegation 不能从这里消失。
	 * 返回受影响行数；没有命中 = 0（删除幂等，端点不把它当失败）。
	 */
	deleteSideLinkBySessionId(sessionId: number): number {
		if (!Number.isInteger(sessionId) || sessionId <= 0) return 0;
		const info = this.db
			.prepare("DELETE FROM partner_session_links WHERE session_id = ? AND role = 'side'")
			.run(sessionId);
		return Number(info.changes ?? 0);
	}

	/**
	 * 一次取全表链接（session_id > 0），给 /agent/chats 批量标注用，避免 N+1。
	 * 同一 session 有多行时取 created_at 最早的一条（与 linkOfSession 同口径）。
	 */
	sessionLinksMap(): Map<
		number,
		{ partnerId: string; role: PartnerSessionLinkRow["role"]; routeKey: string | null }
	> {
		const rows = this.db
			.prepare(
				"SELECT partner_id, role, route_key, session_id FROM partner_session_links WHERE session_id > 0 ORDER BY created_at",
			)
			.all() as Array<{
			partner_id: unknown;
			role: unknown;
			route_key: unknown;
			session_id: unknown;
		}>;
		const map = new Map<
			number,
			{ partnerId: string; role: PartnerSessionLinkRow["role"]; routeKey: string | null }
		>();
		for (const row of rows) {
			const sessionId = Number(row.session_id);
			if (!Number.isInteger(sessionId) || sessionId <= 0 || map.has(sessionId)) continue;
			map.set(sessionId, {
				partnerId: String(row.partner_id),
				role: String(row.role) as PartnerSessionLinkRow["role"],
				routeKey:
					row.route_key === null || row.route_key === undefined ? null : String(row.route_key),
			});
		}
		return map;
	}

	/**
	 * `partnerIdOfSession` 的反向只读助手（2026-11-08 扫尾批 8d 执事间递话）：
	 * 执事**主会话**的内部 id；还没建过会话 = null。
	 *
	 * 只看 `canonical`（执事主会话）。例行专线 / 群成员会话 / 领域路由都不是"递话该落的会话"：
	 * 前者跑完即弃、后者没有对外的入口。**只读**：不建会话、不改身份版本——
	 * 建会话要跑身份对齐（partner-runtime，import agent），那是装配层的事，不塞进存储层。
	 */
	sessionIdOfPartner(partnerId: string): number | null {
		return this.findSessionLink(partnerId, "canonical", "canonical")?.sessionId ?? null;
	}

	// ── 例行任务定义（B3）────────────────────────────────
	createRoutine(input: {
		partnerId: string;
		name: string;
		prompt: string;
		triggers: RoutineTrigger[];
		sessionMode: "persistent" | "fresh";
		enabled: boolean;
		/** 完成条件（2026-11-10 批 13 §四）：文字条件，达成即停 */
		until?: { note: string };
		/** 跑满 N 次自动停 */
		maxRuns?: number;
	}): RoutineDef {
		if (!this.get(input.partnerId)) throw new Error(`执事不存在：${input.partnerId}`);
		const id = randomUUID();
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO routines (id, partner_id, name, prompt, triggers, session_mode, enabled, revision, until_note, max_runs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
			)
			.run(
				id,
				input.partnerId,
				input.name,
				input.prompt,
				JSON.stringify(input.triggers),
				input.sessionMode,
				input.enabled ? 1 : 0,
				input.until?.note.trim() || null,
				typeof input.maxRuns === "number" && input.maxRuns > 0
					? Math.floor(input.maxRuns)
					: null,
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
			/** `null` = 清掉完成条件；`undefined` = 不动 */
			until?: { note: string } | null;
			/** `null` = 取消次数上限；`undefined` = 不动 */
			maxRuns?: number | null;
		},
	): RoutineDef | null {
		const existing = this.getRoutine(id);
		if (!existing) return null;
		const now = new Date().toISOString();
		const untilNote =
			patch.until === undefined
				? (existing.until?.note ?? null)
				: (patch.until?.note.trim() || null);
		const maxRuns =
			patch.maxRuns === undefined
				? (existing.maxRuns ?? null)
				: (typeof patch.maxRuns === "number" && patch.maxRuns > 0
						? Math.floor(patch.maxRuns)
						: null);
		this.db
			.prepare(
				"UPDATE routines SET name = ?, prompt = ?, triggers = ?, session_mode = ?, enabled = ?, until_note = ?, max_runs = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
			)
			.run(
				patch.name ?? existing.name,
				patch.prompt ?? existing.prompt,
				JSON.stringify(patch.triggers ?? existing.triggers),
				patch.sessionMode ?? existing.sessionMode,
				(patch.enabled ?? existing.enabled) ? 1 : 0,
				untilNote,
				maxRuns,
				now,
				id,
			);
		return this.getRoutine(id);
	}

	deleteRoutine(id: string): boolean {
		const result = this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
		return Number(result.changes) > 0;
	}

	// ── 群组（2026-11-06 群组方案 §2.1）────────────────────
	/** 建群。成员 2–6、值日必须是成员的校验在端点层；这里只管落库。 */
	createGroup(input: {
		name: string;
		notice?: string;
		responderKind?: "member" | "everyone" | "mentions";
		responderPartnerId?: string | null;
		memberIds: string[];
	}): GroupRow {
		const id = randomUUID();
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO groups (id, name, notice, responder_kind, responder_partner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				input.name,
				input.notice ?? "",
				input.responderKind ?? "member",
				input.responderPartnerId ?? null,
				now,
				now,
			);
		input.memberIds.forEach((partnerId, index) => {
			this.db
				.prepare(
					"INSERT INTO group_members (group_id, partner_id, position, joined_at) VALUES (?, ?, ?, ?)",
				)
				.run(id, partnerId, index, now);
		});
		return this.getGroup(id) as GroupRow;
	}

	getGroup(id: string): GroupRow | null {
		const row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? toGroup(row, this.membersOf(id)) : null;
	}

	listGroups(): GroupRow[] {
		const rows = this.db
			.prepare("SELECT * FROM groups ORDER BY updated_at")
			.all() as Array<Record<string, unknown>>;
		return rows.map((row) => toGroup(row, this.membersOf(String(row.id))));
	}

	/** 群成员（position 升序）。名字/状态/头像/领域实时 join 档案表；档案没了给占位（渲染靠消息快照）。 */
	membersOf(groupId: string): GroupRow["members"] {
		const rows = this.db
			.prepare(
				`SELECT m.partner_id, m.position, p.name, p.status, p.avatar, p.domain
				 FROM group_members m LEFT JOIN partners p ON p.id = m.partner_id
				 WHERE m.group_id = ? ORDER BY m.position`,
			)
			.all(groupId) as Array<Record<string, unknown>>;
		return rows.map((m) => ({
			partnerId: String(m.partner_id),
			name: m.name === null || m.name === undefined ? "（已离开）" : String(m.name),
			position: Number(m.position),
			status: (m.status === null || m.status === undefined
				? "archived"
				: String(m.status)) as PartnerStatus,
			avatar: m.avatar === null || m.avatar === undefined ? null : String(m.avatar),
			domain: m.domain === null || m.domain === undefined ? null : String(m.domain),
		}));
	}

	/** 改群：名称/公告/应答口径/值日 + 增删成员。人数 2–6 的校验在端点层（改前改后都要满足）。 */
	updateGroup(
		id: string,
		patch: {
			name?: string;
			notice?: string;
			responderKind?: "member" | "everyone" | "mentions";
			responderPartnerId?: string | null;
			addMemberIds?: string[];
			removeMemberIds?: string[];
		},
	): GroupRow | null {
		const existing = this.getGroup(id);
		if (!existing) return null;
		const now = new Date().toISOString();
		if (patch.name !== undefined && patch.name.trim()) {
			this.db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(patch.name.trim(), id);
		}
		if (patch.notice !== undefined) {
			this.db.prepare("UPDATE groups SET notice = ? WHERE id = ?").run(patch.notice, id);
		}
		if (patch.responderKind !== undefined) {
			this.db
				.prepare("UPDATE groups SET responder_kind = ? WHERE id = ?")
				.run(patch.responderKind, id);
		}
		if (patch.responderPartnerId !== undefined) {
			this.db
				.prepare("UPDATE groups SET responder_partner_id = ? WHERE id = ?")
				.run(patch.responderPartnerId, id);
		}
		for (const partnerId of patch.removeMemberIds ?? []) {
			this.db
				.prepare("DELETE FROM group_members WHERE group_id = ? AND partner_id = ?")
				.run(id, partnerId);
		}
		if (patch.addMemberIds?.length) {
			const max = this.db
				.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM group_members WHERE group_id = ?")
				.get(id) as { p?: unknown };
			let position = Number(max?.p ?? -1);
			for (const partnerId of patch.addMemberIds) {
				position += 1;
				this.db
					.prepare(
						"INSERT OR IGNORE INTO group_members (group_id, partner_id, position, joined_at) VALUES (?, ?, ?, ?)",
					)
					.run(id, partnerId, position, now);
			}
		}
		this.db.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").run(now, id);
		return this.getGroup(id);
	}

	/** 硬删：群 + 成员关系 + 消息一起没（方案 §六：删群可恢复刻意不做）。 */
	deleteGroup(id: string): boolean {
		const existing = this.getGroup(id);
		if (!existing) return false;
		this.db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
		this.db.prepare("DELETE FROM group_messages WHERE group_id = ?").run(id);
		this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
		return true;
	}

	/** 群时间线追加一条，seq = 群内当前最大值 + 1（从 1 起，单调）。 */
	appendGroupMessage(input: {
		groupId: string;
		kind: "message" | "system";
		authorKind: "user" | "partner" | "system";
		authorId: string | null;
		authorName: string;
		content: string;
		roundId?: string;
	}): GroupMessageRow {
		const maxRow = this.db
			.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM group_messages WHERE group_id = ?")
			.get(input.groupId) as { s?: unknown };
		const seq = Number(maxRow?.s ?? 0) + 1;
		const id = randomUUID();
		const at = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO group_messages (id, group_id, seq, kind, author_kind, author_id, author_name, content, at, round_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				input.groupId,
				seq,
				input.kind,
				input.authorKind,
				input.authorId,
				input.authorName,
				input.content,
				at,
				input.roundId ?? null,
			);
		this.db.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").run(at, input.groupId);
		return {
			id,
			groupId: input.groupId,
			seq,
			kind: input.kind,
			authorKind: input.authorKind,
			authorId: input.authorId,
			authorName: input.authorName,
			content: input.content,
			at,
			roundId: input.roundId ?? null,
		};
	}

	/**
	 * 时间线查询。升序返回。
	 * - `afterSeq`：只取该序号**之后**的（增量投递用，DS-Bot seen 游标）；
	 * - `beforeSeq`：只取该序号**之前**的（回读分页）；
	 * - 都不带：取最后 limit 条。
	 */
	listGroupMessages(
		groupId: string,
		opts?: { afterSeq?: number; beforeSeq?: number; limit?: number },
	): GroupMessageRow[] {
		const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
		let rows: Array<Record<string, unknown>>;
		if (opts?.afterSeq !== undefined) {
			rows = this.db
				.prepare(
					"SELECT * FROM group_messages WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?",
				)
				.all(groupId, opts.afterSeq, limit) as Array<Record<string, unknown>>;
			return rows.map(toGroupMessage);
		}
		if (opts?.beforeSeq !== undefined) {
			rows = this.db
				.prepare(
					"SELECT * FROM group_messages WHERE group_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
				)
				.all(groupId, opts.beforeSeq, limit) as Array<Record<string, unknown>>;
		} else {
			rows = this.db
				.prepare("SELECT * FROM group_messages WHERE group_id = ? ORDER BY seq DESC LIMIT ?")
				.all(groupId, limit) as Array<Record<string, unknown>>;
		}
		return rows.map(toGroupMessage).reverse();
	}

	lastGroupSeq(groupId: string): number {
		const row = this.db
			.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM group_messages WHERE group_id = ?")
			.get(groupId) as { s?: unknown };
		return Number(row?.s ?? 0);
	}

	/**
	 * 该成员上次发言的 seq（增量投递游标，DS-Bot seen 思想）。
	 * 从没发过言 = 0（首建走最近 30 条窗口）。
	 */
	lastSpokenSeq(groupId: string, partnerId: string): number {
		const row = this.db
			.prepare(
				"SELECT COALESCE(MAX(seq), 0) AS s FROM group_messages WHERE group_id = ? AND author_kind = 'partner' AND author_id = ?",
			)
			.get(groupId, partnerId) as { s?: unknown };
		return Number(row?.s ?? 0);
	}

	/**
	 * 这条内部会话是不是某群的成员会话（role='group' 链接行存在）。
	 * 群会话不参与记忆引擎的判定就靠它（群组方案 §2.2）——查失败当普通会话，记忆永不卡对话。
	 */
	isGroupSession(sessionId: number): boolean {
		if (sessionId <= 0) return false;
		try {
			const row = this.db
				.prepare(
					"SELECT 1 FROM partner_session_links WHERE session_id = ? AND role = 'group' LIMIT 1",
				)
				.get(sessionId);
			return row !== undefined;
		} catch {
			return false;
		}
	}
}
