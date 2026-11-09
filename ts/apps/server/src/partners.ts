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

/**
 * 岗位契约总开关（2026-11-08 员工人格化刀一 E1）：`PARTNER_CONTRACT=false` → 不播种
 * `CONTRACT.md`、不注入、写端点 400；SOUL 侧行为零变化（一行 env 回到纯 SOUL 形态）。
 * 与其它开关同一读法：只有明确写 false/0 才关，拼错一个值不会把能力误关。
 */
export function partnerContractEnabled(): boolean {
	const raw = process.env.PARTNER_CONTRACT?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

/**
 * 岗位契约的固定四节（2026-11-08 E1）。**标题逐字**：契约文件按这四个二级标题分节，
 * 渲染时只认这四节，其余内容忽略；空节连标题一起省略。
 * 新建执事播种的模板 = 这四个标题（「决策分级」自 2026-11-10 起带默认正文；
 * 存量执事不自动补文件，缺失 = 该节为空）。
 */
export const PARTNER_CONTRACT_SECTIONS = [
	"职责范围",
	"决策分级",
	"验收标准",
	"汇报对象",
] as const;

/**
 * 「决策分级」的默认正文（2026-11-10 批 12 §一.5，三#2 调查铁律）。
 *
 * 为什么只在新建执事时播种：契约是执事自己的文件，存量执事的 CONTRACT.md
 * 一律不动（不越权改人家的家目录）；新执事从第一天起就带着这条调查纪律。
 * 标题四节不变，正文只落「决策分级」——它管的是"什么时候可以自己动手"。
 */
export const PARTNER_CONTRACT_DECISION_DEFAULTS = [
	"- 没有调查不许改：先复现、再看现象、再动手；猜着改三次不如查一次。",
	"- 同一条思路连修 3 次还不行 → 停下，把已查明的事写成一段话交上去，别继续硬修。",
	"- 交付物要自带验收证据：说「做完了」要能指出凭什么。",
].join("\n");

/** 新建执事的契约模板：四节标题不变；「决策分级」带调查铁律默认正文。 */
export function partnerContractTemplate(): string {
	return PARTNER_CONTRACT_SECTIONS.map((section) =>
		section === "决策分级"
			? `## ${section}\n${PARTNER_CONTRACT_DECISION_DEFAULTS}`
			: `## ${section}`,
	).join("\n\n");
}

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
	/**
	 * 头像（2026-11-06 侧栏调整 B1）：有界 PNG data URL，或 null（未设置 → 前端用名字首字）。
	 * 只供 `<img>` 渲染；服务端不存路径、不收外部 URL、不收 SVG（理由见 shared 的 PartnerAvatarSchema）。
	 */
	avatar: string | null;
	/**
	 * 派发权（2026-11-06 执事派发权开关）：带 domain 的执事是否作为分管负责人接单。
	 * 默认关。只对带 domain 的执事有意义。
	 */
	dispatchAuthority: boolean;
	/**
	 * 当前目标（2026-11-08 员工人格化刀二 E4）：这一阵子在奔什么，用户 / 总管可改。
	 * **不版本化**（不是身份，是现取现用的状态），只进 detail 端点与 PATCH，
	 * 列表形状不变（字段经 shared 暴露在刀三）。空串 / null = 清除。
	 */
	currentGoal: string | null;
}

export interface PartnerVersionRow {
	partnerId: string;
	version: number;
	/** SOUL.md 正文快照（冻结） */
	soulSource: string;
	/**
	 * CONTRACT.md 正文快照（2026-11-08 员工人格化刀一 E1，冻结）。
	 * 一个身份版本 = 当时的 SOUL + CONTRACT 对；改任一文本都 bump 版本并落双快照。
	 * `null` = 该版本没有契约快照（老库 / 总管 / 开关关着时建的家）。
	 */
	contractSource: string | null;
	/** 能力 JSON：模型候选链（B4）+ 预留位；只允许存引用（keyEnv 名），不允许存值 */
	capabilities: string | null;
	createdAt: string;
}

export interface PartnerSessionLinkRow {
	partnerId: string;
	/**
	 * `delegation` = 执事的领域路由（批次D D2），这类链接没有宿主会话，sessionId 为占位 0；
	 * `group` = 执事在某群的成员会话（2026-11-06 群组方案），routeKey = `group:<群id>`。
	 */
	role: "canonical" | "routine" | "topic" | "delegation" | "group";
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
	| {
			type: "event";
			kind: "delegation" | "tool" | "phase";
			match?: Record<string, string>;
			/**
			 * 三件门（2026-11-10 批 15 §一，`ROUTINE_TRIGGER_GATES` 默认开）：
			 * 只对 event 触发器生效，三个可选字段可组合。判定在 routine-conditions.ts。
			 */
			baseline?: { key: string; delta: number };
			edge?: true;
			cooldownSec?: number;
	  };

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
	/**
	 * 完成条件（2026-11-10 批 13 §四.1）：一句**文字条件**，每轮跑完由模型自己判断
	 * 达成没有；判达成 → `enabled=false`（不删，保留历史）。不做表达式引擎。
	 * `ROUTINE_CONDITIONAL=false` 时忽略（老规则不受影响）。
	 */
	until?: { note: string };
	/** 跑满 N 次自动停（同上开关；比 ends={after,at,times} 全套便宜）。 */
	maxRuns?: number;
	/** 每次修改 +1：durable 任务带着旧 revision 醒来时据此作废（替代"取消任务"） */
	revision: number;
	createdAt: string;
	updatedAt: string;
}

// ── 群组行类型（2026-11-06 群组方案）────────────────────────

export type GroupResponderKind = "member" | "everyone" | "mentions";

export interface GroupRow {
	id: string;
	name: string;
	/** 群公告（≤500 字），随每轮输入注入成员会话 */
	notice: string;
	responderKind: GroupResponderKind;
	/** kind=member 时的值日执事；必须是群成员 */
	responderPartnerId: string | null;
	/**
	 * 成员按 position 升序；只存引用，人格 = 各自 SOUL。
	 * avatar / domain 是**实时 join 档案表**得出的展示字段（不落 group_members）：
	 * 头像给群复合头像用，domain 给 @名字·domain 长标签消歧用（2026-11-08 批三）。
	 */
	members: Array<{
		partnerId: string;
		name: string;
		position: number;
		status: PartnerStatus;
		avatar: string | null;
		domain: string | null;
	}>;
	createdAt: string;
	updatedAt: string;
}

export interface GroupMessageRow {
	id: string;
	groupId: string;
	/** 群内单调序号（从 1 起），回读分页用 beforeSeq */
	seq: number;
	kind: "message" | "system";
	authorKind: "user" | "partner" | "system";
	authorId: string | null;
	/** 作者名快照：不 join 成员表，改名/离群后历史不变（cindy 四件套） */
	authorName: string;
	content: string;
	at: string;
	roundId: string | null;
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
				domain          TEXT,
				avatar          TEXT,
			dispatch_authority INTEGER NOT NULL DEFAULT 0,
			current_goal    TEXT
			);
			CREATE TABLE IF NOT EXISTS partner_versions (
				partner_id   TEXT NOT NULL,
				version      INTEGER NOT NULL,
				soul_source  TEXT NOT NULL,
				contract_source TEXT,
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
		// 当前目标列（2026-11-08 员工人格化刀二 E4）：旧库补 nullable 列，
		// 老记录读出来是 null（= 没设目标），不炸、不补数据、不版本化。
		if (!columns.some((column) => column.name === "current_goal")) {
			this.db.exec("ALTER TABLE partners ADD COLUMN current_goal TEXT");
		}
		// 岗位契约快照列（2026-11-08 员工人格化刀一 E1）：旧库补 nullable 列，
		// 老版本读出来是 null（= 无契约快照），不炸、不补数据、不越权回填。
		const versionColumns = this.db.prepare("PRAGMA table_info(partner_versions)").all() as Array<{
			name?: unknown;
		}>;
		if (!versionColumns.some((column) => column.name === "contract_source")) {
			this.db.exec("ALTER TABLE partner_versions ADD COLUMN contract_source TEXT");
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
		// 岗位契约（2026-11-08 E1）：**只在新建时**播种空模板；存量执事不自动补文件
		// （不越权——它没见过这份契约，凭空出现一个文件比没有更让人困惑）。
		this.seedContract(id);
		this.pushVersion(id, soul, null, this.readContractFromHome(id));
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
				// 总管刻意不播种岗位契约（他是主人本体，不是被派的执事）；
				// 有人手工放了 CONTRACT.md 才读得到，读不到就是 null。
				this.readContractFromHome(CHIEF_PARTNER_ID),
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

	/** 删除：档案行 + 版本行 + 链接行 + 家目录整体。家目录没了身份就没了，二次确认在端点层。 */
	delete(id: string): boolean {
		const existing = this.get(id);
		if (!existing) return false;
		this.db.prepare("DELETE FROM partners WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM partner_versions WHERE partner_id = ?").run(id);
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

	// ── 身份版本 ─────────────────────────────────────────
	/**
	 * 新增一个身份版本（冻结快照），current_version 指过去。
	 *
	 * 2026-11-08 员工人格化刀一 E1：一个身份版本 = 当时的 SOUL + CONTRACT 对。
	 * `contractSource` 缺省 = null（老调用方 / 没有契约的档案），语义等同"该版本没有契约"。
	 * 改任一文本都要走本函数并带上另一份的当前快照，别只更新一份。
	 */
	pushVersion(
		partnerId: string,
		soulSource: string,
		capabilities: string | null,
		contractSource: string | null = null,
	): number {
		const partner = this.get(partnerId);
		if (!partner) throw new Error(`执事不存在：${partnerId}`);
		const version = (partner.currentVersion ?? 0) + 1;
		const now = new Date().toISOString();
		this.db
			.prepare(
				"INSERT INTO partner_versions (partner_id, version, soul_source, contract_source, capabilities, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(partnerId, version, soulSource, contractSource, capabilities, now);
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
					contractSource:
						row.contract_source === null || row.contract_source === undefined
							? null
							: String(row.contract_source),
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

	/**
	 * 岗位契约当前值（磁盘）。缺失 = null（旧执事没有这个文件，读取方按"四节全空"处理）。
	 * 与 SOUL 同址同权限：64KB 单槽、原子写。
	 */
	readContractFromHome(partnerId: string): string | null {
		return this.readHomeFile(partnerId, "CONTRACT.md");
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
	 * 改 SOUL.md（磁盘当前值）+ 落新版本快照，返回新版本号。能力（候选链）随版本延续，不被冲掉。
	 * 2026-11-08 E1：契约快照同时落一份（身份版本 = SOUL + CONTRACT 对），
	 * 取磁盘当前值（它是"当前值"的家），取不到再退当前快照。
	 */
	bumpSoul(partnerId: string, soulSource: string): number {
		if (!this.get(partnerId)) throw new Error(`执事不存在：${partnerId}`);
		this.atomicWrite(join(this.homeOf(partnerId), "SOUL.md"), soulSource);
		const current = this.currentVersion(partnerId);
		const contract = this.readContractFromHome(partnerId) ?? current?.contractSource ?? null;
		return this.pushVersion(partnerId, soulSource, current?.capabilities ?? null, contract);
	}

	/**
	 * 改 CONTRACT.md（磁盘当前值）+ 落新版本快照，返回新版本号（2026-11-08 E1）。
	 *
	 * 与 bumpSoul 完全同构：调岗是低频慎重的事，但"下一轮生效"的口径与 SOUL 一致——
	 * 改完不当场变身。SOUL 侧取磁盘当前值（同上），能力随版本延续。
	 */
	bumpContract(partnerId: string, contractSource: string): number {
		if (!this.get(partnerId)) throw new Error(`执事不存在：${partnerId}`);
		this.atomicWrite(join(this.homeOf(partnerId), "CONTRACT.md"), contractSource);
		const current = this.currentVersion(partnerId);
		const soul = this.readSoulFromHome(partnerId) ?? current?.soulSource ?? "";
		return this.pushVersion(partnerId, soul, current?.capabilities ?? null, contractSource);
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
		const current = this.currentVersion(partnerId);
		// 2026-11-08 E1：切模型也是新身份版本，契约快照跟着延续（不冲成 null）。
		// 取法同 bumpSoul：磁盘当前值优先，取不到再退当前快照。
		const contract = this.readContractFromHome(partnerId) ?? current?.contractSource ?? null;
		return this.pushVersion(
			partnerId,
			this.readSoulFromHome(partnerId) ?? "",
			JSON.stringify({ modelChain: chain }),
			contract,
		);
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
		avatar: row.avatar === null || row.avatar === undefined ? null : String(row.avatar),
		dispatchAuthority: Number(row.dispatch_authority ?? 0) !== 0,
		currentGoal:
			row.current_goal === null || row.current_goal === undefined
				? null
				: String(row.current_goal),
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
	const untilNote =
		row.until_note === null || row.until_note === undefined ? "" : String(row.until_note).trim();
	const maxRunsRaw = Number(row.max_runs);
	return {
		id: String(row.id),
		partnerId: String(row.partner_id),
		name: String(row.name),
		prompt: String(row.prompt ?? ""),
		triggers,
		sessionMode: row.session_mode === "fresh" ? "fresh" : "persistent",
		enabled: Number(row.enabled ?? 0) === 1,
		...(untilNote ? { until: { note: untilNote } } : {}),
		...(Number.isFinite(maxRunsRaw) && maxRunsRaw > 0
			? { maxRuns: Math.floor(maxRunsRaw) }
			: {}),
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

function toGroup(
	row: Record<string, unknown>,
	members: GroupRow["members"],
): GroupRow {
	const kind = String(row.responder_kind ?? "member") as GroupResponderKind;
	return {
		id: String(row.id),
		name: String(row.name),
		notice: String(row.notice ?? ""),
		responderKind: kind === "everyone" || kind === "mentions" ? kind : "member",
		responderPartnerId:
			row.responder_partner_id === null || row.responder_partner_id === undefined
				? null
				: String(row.responder_partner_id),
		members,
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
	};
}

function toGroupMessage(row: Record<string, unknown>): GroupMessageRow {
	return {
		id: String(row.id),
		groupId: String(row.group_id),
		seq: Number(row.seq),
		kind: String(row.kind) === "system" ? "system" : "message",
		authorKind: ((): "user" | "partner" | "system" => {
			const raw = String(row.author_kind ?? "system");
			return raw === "user" || raw === "partner" ? raw : "system";
		})(),
		authorId: row.author_id === null || row.author_id === undefined ? null : String(row.author_id),
		authorName: String(row.author_name ?? ""),
		content: String(row.content ?? ""),
		at: String(row.at ?? ""),
		roundId: row.round_id === null || row.round_id === undefined ? null : String(row.round_id),
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
	// 没有领域标签时（2026-11-07 起 domain 可空）给一句通用身份，不硬编一个领域名——
	// 编一个"general 领域"会让用户在界面上看到一个自己没选过的东西。
	return domain
		? `你是${name}，${domain} 领域的负责人；总管把这一领域的事交给你，你带工人把活办完，只回一行结论。\n`
		: `你是${name}；总管把事交给你，你带工人把活办完，只回一行结论。\n`;
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

/**
 * 派发权总闸（2026-11-06 执事派发权开关）：只有明确写 false/0 才关，避免拼错一个值
 * 把功能误关掉（与 CHANCELLOR_ENABLED 同读法）。关 = 所有执事一律视为无派发权，
 * 一行 env 回到本改动前形态（回滚开关）。
 */
export function ministerDispatchMasterEnabled(): boolean {
	const raw = process.env.MINISTER_DISPATCH_AUTHORITY?.trim().toLowerCase();
	return raw !== "false" && raw !== "0";
}

/**
 * 按 domain 判定派发权是否放行（2026-11-06 执事派发权开关）。
 * 总闸关 / 查无执事 / 该执事开关关 → false。派单装配层（tools.ts 的 localIdentityHit）
 * 先过这道闸，再查身份——关着时返回 null，请求不带 managerIdentity，
 * chancellor 以默认路径（总管直派）办完这张单，行为等同旧领域。
 */
export function ministerDispatchAllowed(store: PartnersStore, domain: string): boolean {
	if (!ministerDispatchMasterEnabled()) return false;
	const id = store.partnerIdByDomain(domain);
	if (!id) return false;
	return store.get(id)?.dispatchAuthority === true;
}
