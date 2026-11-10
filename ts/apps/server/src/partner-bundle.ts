import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
	redactSecrets,
	scopeKey,
	type MemoryEngine,
	type MemoryKind,
} from "@lifediary/memory";
import { PARTNER_SLOT_LIMIT, partnersStore, type PartnerRow, type PartnersStore } from "./partners.ts";
import { memoryEngine } from "./agent/assist.ts";

/**
 * 团队包（2026-11-10 批 25 §二）：把一位执事导出成单文件 JSON，再在另一台机器导入。
 *
 * 三件必须守住的事：
 *   1. **只导能带走的东西**：SOUL / CONTRACT / 技能 / 偏好与经验记忆；
 *      `work` 是这台机器上的履历，换台机器没有意义，不导。规则（routines）也**不导**——
 *      它们的触发器绑着这台机器的会话与时钟。
 *   2. **双重脱敏**：字段级先打一遍码，序列化成 JSON 后再整串打一遍。第二遍防的是
 *      "秘密被 JSON 转义或跨字段拼出来"这类第一遍看不见的形态。导入时记忆库自己还会
 *      再打一次（存储层既有口径）。
 *   3. **到货默认安全态**：包里带 `safety` 只是给读包的人看的；导入**不信**包里的
 *      任何开关值，一律落成 `SAFE_ARRIVAL`。领域标签也不随包迁移——它连着 chancellor
 *      的分管目录与派活路由，贸然继承等于让一个没被审过的人直接接单。
 *
 * 端点（companion-api.ts）只做 HTTP 形状映射，核心逻辑都在这里，与 partner-manage /
 * group-manage 同款分层。存储与记忆引擎通过 `BundleContext` 注入，单测用临时库。
 */

export const PARTNER_BUNDLE_FORMAT = "lifediary-partner-bundle";
export const PARTNER_BUNDLE_VERSION = 1;

/** 回滚开关（2026-11-10 批 25 §2.4）：false → 两个端点都 404（视作能力未启用）。 */
export function partnerBundleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.PARTNER_BUNDLE?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0";
}

/**
 * 到货安全态（2026-11-10 批 25 §2.3）。三个值都是"最保守"的那一档：
 *   - `ask-all`：任何写操作都要人确认；
 *   - `skillsEnabled: false`：技能文件落盘但不进任何提示词（执事处于 paused，不会跑回合）；
 *   - `routinesPaused: true`：团队包不导规则，到货没有任何会被自动触发的活。
 */
export interface BundleSafety {
	approvalLevel: "ask-all";
	skillsEnabled: false;
	routinesPaused: true;
}

export const SAFE_ARRIVAL: BundleSafety = Object.freeze({
	approvalLevel: "ask-all",
	skillsEnabled: false,
	routinesPaused: true,
});

export interface BundleSkill {
	name: string;
	content: string;
}

export interface BundleMemory {
	kind: "preference" | "experience";
	content: string;
	importance: number;
	createdAt: string;
}

export interface PartnerBundle {
	format: typeof PARTNER_BUNDLE_FORMAT;
	version: number;
	exportedAt: string;
	partner: { name: string; domain: string | null; status: string };
	soul: string;
	contract: string;
	skills: BundleSkill[];
	memories: BundleMemory[];
	safety: BundleSafety;
}

export interface BundleContext {
	store: PartnersStore;
	/** 记忆引擎（MEMORY_ENABLED=false 时为 null：导出空记忆、导入跳过并如实报告） */
	memory: Pick<MemoryEngine, "list" | "remember"> | null;
}

export function defaultBundleContext(): BundleContext {
	return { store: partnersStore(), memory: memoryEngine };
}

/** 只导这两种：偏好是"怎么相处"，经验是"这类活怎么做"；work 是本地履历。 */
const EXPORTED_MEMORY_KINDS: ReadonlySet<string> = new Set(["preference", "experience"]);
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const MAX_MEMORY_ITEMS = 2000;

/** 文件名只保留可读部分；真正的 Content-Disposition 编码在端点层做。 */
function bundleFilename(name: string): string {
	const safe = name
		.trim()
		.replace(/[^\p{L}\p{N}_-]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${safe || "partner"}-bundle.json`;
}

function readSkillFiles(store: PartnersStore, partnerId: string): BundleSkill[] {
	const dir = store.skillsDirOf(partnerId);
	let entries: Array<{ name: string }> = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
			.map((entry) => ({ name: entry.name }));
	} catch {
		// 目录不存在 / 读不到 = 没有技能（同 skills 清单端点口径）
		return [];
	}
	const skills: BundleSkill[] = [];
	for (const entry of entries) {
		const content = store.readHomeFile(partnerId, join("skills", entry.name));
		if (content === null) continue;
		skills.push({
			name: entry.name.replace(/\.md$/i, ""),
			content: redactSecrets(content),
		});
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return skills;
}

/**
 * 第二遍脱敏：序列化 → 解回来 → 逐字符串值再打一遍 → 重新序列化。
 *
 * **为什么不在整串 JSON 上直接跑 `redactSecrets`**：键值规则会把 JSON 的结尾引号
 * 当成值的一部分（`api_key=«redacted»"` → 结尾引号被吃掉），输出就不是合法 JSON 了。
 * 先序列化再按值打码，既保住"序列化之后再跑一遍"的语义，也保证附件始终可解析。
 */
function redactDeep(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map(redactDeep);
	if (value !== null && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			output[key] = redactDeep(item);
		}
		return output;
	}
	return value;
}

/**
 * 导出一位执事。返回 `null` = 执事不存在（端点映射 404）。
 *
 * `exportedAt` 取当前时间：它不参与任何逻辑，只用于人读。
 */
export function exportPartnerBundle(
	partnerId: string,
	ctx: BundleContext = defaultBundleContext(),
): { filename: string; content: string } | null {
	const { store, memory } = ctx;
	const partner = store.get(partnerId);
	if (!partner) return null;
	const current = store.currentVersion(partnerId);
	const soul = store.readSoulFromHome(partnerId) ?? current?.soulSource ?? "";
	const contract = store.readContractFromHome(partnerId) ?? current?.contractSource ?? "";

	const memories: BundleMemory[] =
		memory === null
			? []
			: memory
					.list({
						scopes: [scopeKey({ type: "partner", id: partnerId })],
						limit: MAX_MEMORY_ITEMS,
					})
					.filter(
						(record) =>
							EXPORTED_MEMORY_KINDS.has(record.kind) && record.content.trim().length > 0,
					)
					.map((record) => ({
						kind: record.kind as BundleMemory["kind"],
						// 第一遍：逐条打码（读记忆的人仍能看到"这里原来是个 key"）
						content: redactSecrets(record.content),
						importance: record.importance,
						createdAt: record.createdAt,
					}));

	const bundle: PartnerBundle = {
		format: PARTNER_BUNDLE_FORMAT,
		version: PARTNER_BUNDLE_VERSION,
		exportedAt: new Date().toISOString(),
		partner: {
			name: partner.name,
			domain: partner.domain,
			status: partner.status,
		},
		soul: redactSecrets(soul),
		contract: redactSecrets(contract),
		skills: readSkillFiles(store, partnerId),
		memories,
		safety: SAFE_ARRIVAL,
	};

	// 第一遍：逐字段打码（导出前）；第二遍在序列化之后按值再跑一次。
	const serialized = JSON.stringify(bundle, null, 2);
	const content = JSON.stringify(redactDeep(JSON.parse(serialized)), null, 2);
	return { filename: bundleFilename(partner.name), content };
}

export interface BundleImportOk {
	ok: true;
	partner: PartnerRow;
	imported: { skills: number; memories: number; skipped: number };
	safety: BundleSafety;
	warnings: string[];
}

export interface BundleImportErr {
	ok: false;
	code: "invalid_bundle" | "duplicate_name" | "create_failed";
	message: string;
}

export type BundleImportResult = BundleImportOk | BundleImportErr;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * 导入团队包。**输入的 `safety` 一个字段都不读**——只按 `SAFE_ARRIVAL` 落。
 *
 * 失败时不留半个执事：建档案之后的任何写盘错误都会回滚档案（家目录一起删）。
 * 重名一律 400，不覆盖（团队包不是"恢复备份"，覆盖等于不可逆地毁掉现有执事）。
 */
export function importPartnerBundle(
	raw: unknown,
	ctx: BundleContext = defaultBundleContext(),
): BundleImportResult {
	const { store, memory } = ctx;
	const record = asRecord(raw);
	if (!record) return { ok: false, code: "invalid_bundle", message: "团队包必须是一个 JSON 对象" };
	if (record.format !== PARTNER_BUNDLE_FORMAT) {
		return { ok: false, code: "invalid_bundle", message: "不是团队包（format 不匹配）" };
	}
	if (record.version !== PARTNER_BUNDLE_VERSION) {
		return {
			ok: false,
			code: "invalid_bundle",
			message: `团队包版本不支持（只认 ${PARTNER_BUNDLE_VERSION}）`,
		};
	}
	const partnerMeta = asRecord(record.partner);
	const name = asString(partnerMeta?.name).trim();
	if (!name || name.length > 40) {
		return { ok: false, code: "invalid_bundle", message: "partner.name 必填且不超过 40 字" };
	}
	const soul = asString(record.soul);
	const contract = asString(record.contract);
	const skillsRaw = Array.isArray(record.skills) ? record.skills : [];
	const memoriesRaw = Array.isArray(record.memories) ? record.memories : [];

	const duplicate = store
		.list()
		.some((partner) => partner.name.trim().toLowerCase() === name.toLowerCase());
	if (duplicate) {
		return {
			ok: false,
			code: "duplicate_name",
			message: `已经有一位叫「${name}」的执事，团队包不覆盖现有执事。`,
		};
	}

	const warnings: string[] = [];
	if (partnerMeta?.domain) {
		// 领域标签连着 chancellor 的分管目录与派活路由：不随包继承，避免"导入即接单"。
		warnings.push("领域标签未随包迁移：到货不带分管路由，确认后再在设置里单独设置。");
	}

	let partner: PartnerRow | null = null;
	try {
		partner = store.create(name, soul.trim() ? { soulSeed: soul } : {});
		// 到货即暂停：确认之前不跑任何回合（技能与记忆都只是落盘，不会进提示词）。
		store.update(partner.id, { status: "paused" });
		if (contract.trim()) store.bumpContract(partner.id, contract);
	} catch (error) {
		// 建档案之后的失败要回滚，别留半个执事（同 createMinisterPartner 的口径）。
		if (partner) {
			try {
				store.delete(partner.id);
			} catch {
				/* 回滚失败也不能改变"导入失败"的结论 */
			}
		}
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, code: "create_failed", message: `导入失败：${detail}` };
	}

	let skillCount = 0;
	let skipped = 0;
	for (const entry of skillsRaw) {
		const skill = asRecord(entry);
		const skillName = asString(skill?.name);
		const content = asString(skill?.content);
		if (!SKILL_NAME_PATTERN.test(skillName) || Buffer.byteLength(content, "utf8") > PARTNER_SLOT_LIMIT) {
			skipped += 1;
			continue;
		}
		try {
			store.atomicWrite(join(store.skillsDirOf(partner.id), `${skillName}.md`), content);
			skillCount += 1;
		} catch {
			skipped += 1;
		}
	}

	let memoryCount = 0;
	if (memory === null) {
		if (memoriesRaw.length > 0) {
			warnings.push(`记忆引擎未启用，${memoriesRaw.length} 条记忆没有导入。`);
		}
		skipped += memoriesRaw.length;
	} else {
		for (const entry of memoriesRaw) {
			const item = asRecord(entry);
			const kind = asString(item?.kind) as MemoryKind;
			const content = asString(item?.content).trim();
			if (!EXPORTED_MEMORY_KINDS.has(kind) || !content) {
				skipped += 1;
				continue;
			}
			const importance = Number(item?.importance);
			try {
				memory.remember({
					kind,
					scope: { type: "partner", id: partner.id },
					content,
					importance:
						Number.isFinite(importance) && importance >= 0 && importance <= 1
							? importance
							: 0.7,
					// 来源如实标 imported：日后审计能分出"这条是带过来的"。
					veracity: "imported",
					source: "import",
				});
				memoryCount += 1;
			} catch {
				skipped += 1;
			}
		}
	}

	return {
		ok: true,
		partner: store.get(partner.id) ?? partner,
		imported: { skills: skillCount, memories: memoryCount, skipped },
		safety: SAFE_ARRIVAL,
		warnings,
	};
}
