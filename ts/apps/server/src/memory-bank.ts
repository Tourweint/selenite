import type { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { flagEnabled } from "./flags.ts";
import {
	askPersona,
	askPersonaCatalog,
	personaAskEnabled,
	type PersonaAskResult,
} from "./persona-ask.ts";
import {
	personaWrite,
	type PersonaWriteInput,
	type PersonaWriteResult,
} from "./persona-write.ts";
import {
	clearPersonaLightRecall,
	personaCatalogTrim,
	personaInjectGatesClosed,
} from "./persona-inject.ts";
import { resolveToolPolicy } from "./tool-policy.ts";

/**
 * 记忆库槽位（2026-11-23 外部记忆库接入，方案见
 * docs/设计方案/2026-11-23-外部记忆库接入任务书（一读一写·槽位与前端）.md）。
 *
 * 一句话：`recall` / `remember` 的工具名不变，后面挂哪个库由槽位决定：
 *   - `builtin`：今天的内置记忆引擎（`engine.recall` / `engine.remember`）；
 *   - `external`：用户自己的记忆库，只经两个 Python 文件——`ask.py` 读、`repair.py` 写。
 *
 * 边界（硬约束，见《2026-11-23 外部记忆库接入边界（一读一写·两文件）》）：
 *   - **不打开 persona.db、不跑 SQL、不知道表名**；外部库路径只以 argv 形式交给子进程；
 *   - 子进程 argv 数组传参、不经 shell；工具调用按 `timeouts.askMs`（默认 15s）超时，
 *     轻召回按 `timeouts.lightMs`（默认 8s）；失败一律 `ok:false`，不抛、不回落另一个库；
 *   - 日志只记状态 / 条数 / 字数 / 耗时，不记 query / body / 正文 / 路径。
 *
 * 装配方向：本模块不 import `agent/*` 与 `tools.ts`（避免环）。它只给
 * `tools.ts`（经 ToolDeps 注入）与 `lifecycle-harness.ts`（注入 / 闸门）提供能力。
 *
 * 配置（`.data/memory-bank.json`，`MEMORY_BANK_PATH` 可覆盖；原子写）：
 *   { v: 1, active: "builtin"|"external",
 *     external: {id,name,root,ask,repair,python,origin,addedAt,vector} | null,
 *     timeouts: {lightMs, askMs} }
 *
 * 本批只支持**一个**外接库：不做多候选列表。`recall` / `remember` 恒按槽位分发
 * （2026-11-24 旧形态 `MEMORY_BANK=false` + `persona_recall` / `persona_write` 已退役）。
 */

export const MEMORY_BANK_FILE_DEFAULT = ".data/memory-bank.json";
/** 目录探测与 catalog 沿用这一档；工具 / 轻召回两档见 `timeouts`（2026-11-24）。 */
const CONFIG_VERSION = 1;

export type MemoryBankActive = "builtin" | "external";
export type MemoryBankStatus = "ok" | "missing_ask" | "missing_repair" | "error";
export type MemoryBankOrigin = "env" | "user";

/** 记忆工具两档超时（2026-11-24）：轻召回短、工具调用长，超时行为按调用形态分开。 */
export interface MemoryBankTimeouts {
	/** 每轮轻召回的单次预算（500..30000）。 */
	lightMs: number;
	/** 工具调用（recall 外部槽）的单次预算（1000..120000）。 */
	askMs: number;
}

export const DEFAULT_MEMORY_BANK_TIMEOUTS: Readonly<MemoryBankTimeouts> = {
	lightMs: 8_000,
	askMs: 15_000,
};

/** clamp 边界（写配置与 API 保存共用）：0 / 非数字回落默认，越界收进边界。 */
export const MEMORY_BANK_TIMEOUT_RANGES = {
	lightMs: { min: 500, max: 30_000 },
	askMs: { min: 1_000, max: 120_000 },
} as const;

export interface ExternalBankRecord {
	id: string;
	name: string;
	/** 绝对路径（外部库根目录）。 */
	root: string;
	/** 相对 root 的 ask.py 路径（存 `/` 分隔；`root/ask.py` 或 `root/analysis/ask.py`）。 */
	ask: string;
	/** 相对 root 的 repair.py 路径；缺文件 = 只读库。 */
	repair: string;
	/** 库自带的 Python 命令覆盖；空 = 回落 `PERSONA_PYTHON` / `python`。 */
	python: string;
	origin: MemoryBankOrigin;
	addedAt: string;
	/**
	 * 向量检索（2026-11-24 命名统一，原名「深检索 deep」）：true = 检索调用（recall 外部槽 /
	 * 页面搜索）在 argv 末尾追加 `--vector`（见 persona-ask.ts）。默认 false = 与旧调用逐字节相同。
	 * 轻召回永远不带；旧字段 `deep` 直接忽略（不做别名）。
	 */
	vector: boolean;
}

export interface MemoryBankConfig {
	v: number;
	active: MemoryBankActive;
	external: ExternalBankRecord | null;
	timeouts: MemoryBankTimeouts;
}

export interface MemoryBankCapabilities {
	read: boolean;
	write: boolean;
	catalog: boolean;
}

export interface ExternalBankView extends ExternalBankRecord {
	status: MemoryBankStatus;
	capabilities: MemoryBankCapabilities;
}

export interface MemoryBankState {
	enabled: boolean;
	active: MemoryBankActive;
	external: ExternalBankView | null;
	/** 两档超时（2026-11-24）：前端「记忆工具时长」展示 / 编辑。 */
	timeouts: MemoryBankTimeouts;
	/** 当前记忆工具面（只列名字；注册发生在 createTools 的装配期）。 */
	tools: string[];
}

export interface ExternalBankResolution {
	/** 路径解析合法（root 存在、入口都在 root 内）。 */
	ok: boolean;
	root: string;
	rootExists: boolean;
	askPath: string;
	repairPath: string;
	askExists: boolean;
	repairExists: boolean;
	/** 读/写入口的启动 argv（2026-11-23 多语言入口）：`["node", ".../ask.js"]` 等。 */
	askCommand: string[] | null;
	repairCommand: string[] | null;
	error?: string;
}

export interface BankProbeResult {
	ok: boolean;
	status: MemoryBankStatus;
	root: string;
	/** 相对 root 的脚本路径（`/` 分隔）；没找到 ask.py 时为 undefined。 */
	ask?: string;
	repair?: string;
	catalog?: { ok: boolean; lines: string[] };
	/** 给人看的短说明（不含绝对路径细节，页面可展示）。 */
	message?: string;
	error?: string;
}

export interface BankSwitchResult {
	ok: boolean;
	active: MemoryBankActive;
	status?: 400 | 404 | 409;
	error?: string;
	message?: string;
}

export interface BankSaveResult {
	ok: boolean;
	active: MemoryBankActive;
	external?: ExternalBankRecord;
	probe?: BankProbeResult;
	status?: 400 | 404 | 409;
	error?: string;
	message?: string;
}

export interface BankDeleteResult {
	ok: boolean;
	deleted?: string;
	active: MemoryBankActive;
	status?: 404;
	error?: string;
	message?: string;
}

export interface BankTimeoutsResult {
	ok: boolean;
	timeouts: MemoryBankTimeouts;
	status?: 400;
	error?: string;
	message?: string;
}

export interface BankDeps {
	env?: NodeJS.ProcessEnv;
	spawnFn?: typeof spawn;
}

/** 配置文件落点（`MEMORY_BANK_PATH` 可覆盖；每次现读 env，测试可换临时文件）。 */
export function memoryBankConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.MEMORY_BANK_PATH?.trim() || MEMORY_BANK_FILE_DEFAULT);
}

function emptyConfig(): MemoryBankConfig {
	return {
		v: CONFIG_VERSION,
		active: "builtin",
		external: null,
		timeouts: { ...DEFAULT_MEMORY_BANK_TIMEOUTS },
	};
}

function nowIsoWithOffset(): string {
	const d = new Date();
	const pad = (n: number): string => String(n).padStart(2, "0");
	const offset = -d.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function newBankId(): string {
	return `bank_${randomBytes(4).toString("hex")}`;
}

/** 存盘用 `/` 分隔的相对路径（与契约示例一致；Windows 反斜杠只在解析时兼容）。 */
function toPosixRel(path: string): string {
	return path.split(/[\\/]+/).filter(Boolean).join("/");
}

function fromPosixRel(path: string): string {
	return path.split("/").join(sep);
}

/** target 是否在 root 内（含等于）。realpath 版的越界检查在其上再做一层。 */
function pathWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realPathWithin(root: string, target: string): boolean {
	try {
		return pathWithin(realpathSync(root), realpathSync(target));
	} catch {
		return false;
	}
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

/**
 * 单个超时的归一（2026-11-24）：缺失 / 非数字 → 默认；数字越界 → clamp；小数取整。
 * 刻意不支持 0 = 不超时——超时是防"一轮对话僵死"的护栏，不允许关。
 */
function clampTimeout(value: unknown, range: { min: number; max: number }, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function sanitizeTimeouts(raw: unknown): MemoryBankTimeouts {
	const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		lightMs: clampTimeout(
			row.lightMs,
			MEMORY_BANK_TIMEOUT_RANGES.lightMs,
			DEFAULT_MEMORY_BANK_TIMEOUTS.lightMs,
		),
		askMs: clampTimeout(row.askMs, MEMORY_BANK_TIMEOUT_RANGES.askMs, DEFAULT_MEMORY_BANK_TIMEOUTS.askMs),
	};
}

function sanitizeExternal(raw: unknown): ExternalBankRecord | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const row = raw as Record<string, unknown>;
	const root = isString(row.root) ? row.root.trim() : "";
	const ask = isString(row.ask) ? row.ask.trim() : "";
	const repair = isString(row.repair) ? row.repair.trim() : "";
	// 绝对路径 / 空 ask / 越界相对路径（含 `..`）一律按无效处理：配置坏了宁可当未接入，
	// 也不把越界路径交给子进程。repair 允许为空（只读库）。
	if (!root || !isAbsolute(root) || !ask || isAbsolute(ask) || isAbsolute(repair)) return null;
	const normalizedRoot = resolve(root);
	for (const rel of [ask, repair].filter(Boolean)) {
		const abs = resolve(normalizedRoot, fromPosixRel(rel));
		if (!pathWithin(normalizedRoot, abs)) return null;
	}
	return {
		id: isString(row.id) && row.id.trim() ? row.id.trim() : "bank_unknown",
		name: isString(row.name) && row.name.trim() ? row.name.trim().slice(0, 60) : "外部记忆库",
		root: normalizedRoot,
		ask: toPosixRel(ask),
		repair: repair ? toPosixRel(repair) : "",
		python: isString(row.python) ? row.python.trim() : "",
		origin: row.origin === "env" ? "env" : "user",
		addedAt: isString(row.addedAt) && row.addedAt.trim() ? row.addedAt.trim() : nowIsoWithOffset(),
		// 只认真正的 true；缺字段 / 字符串 "true" / 其它垃圾值一律按关（默认 = 旧调用）。
		// 旧字段 `deep`（未发布的过渡名）刻意不认：直接忽略，按默认 false。
		vector: row.vector === true,
	};
}

function sanitizeConfig(raw: unknown): MemoryBankConfig {
	const base = emptyConfig();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
	const row = raw as Record<string, unknown>;
	const external = sanitizeExternal(row.external);
	// active=external 但 external 无效 = 配置坏了：按内置库处理，别把页面卡在一个不存在的库上。
	const active: MemoryBankActive =
		row.active === "external" && external ? "external" : "builtin";
	return { v: CONFIG_VERSION, active, external, timeouts: sanitizeTimeouts(row.timeouts) };
}

interface ConfigCache {
	path: string;
	mtimeMs: number;
	size: number;
	config: MemoryBankConfig;
}
let configCache: ConfigCache | null = null;

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, content, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** 首次启动且文件不存在：`PERSONA_MEMORY_ASK` 已配置时按它播种 external（active 仍为 builtin）。 */
function seedFromEnv(env: NodeJS.ProcessEnv): MemoryBankConfig | null {
	const rawAsk = env.PERSONA_MEMORY_ASK?.trim();
	if (!rawAsk || !isAbsolute(rawAsk)) return null;
	const askAbs = resolve(rawAsk);
	const askDir = dirname(askAbs);
	// persona-metric 的惯例是 <root>/analysis/ask.py；别把它播成 root=analysis。
	// 其它形状（<root>/ask.py）直接把脚本目录当 root。
	const analysisLayout = basename(askDir).toLowerCase() === "analysis";
	const root = analysisLayout ? dirname(askDir) : askDir;
	const askRel = analysisLayout ? `analysis/${basename(askAbs)}` : basename(askAbs);
	// 写入口按同一套多扩展名规则找；没有 = 只读库（repair 留空）。
	const repair = findEntry(root, "repair", dirname(askAbs));
	return {
		v: CONFIG_VERSION,
		active: "builtin",
		external: {
			id: newBankId(),
			name: "外部记忆库",
			root,
			ask: askRel,
			repair: repair ? repair.rel : "",
			python: "",
			origin: "env",
			addedAt: nowIsoWithOffset(),
			vector: false,
		},
		timeouts: { ...DEFAULT_MEMORY_BANK_TIMEOUTS },
	};
}

function errorCodeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "unknown";
}

/** 现有配置文件的原始对象（只为"写回保留未知字段"；坏 JSON / 不存在 = null）。 */
function readRawConfigObject(path: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * 写盘前的合并（2026-11-24）：保留本模块不认识的顶层字段与 external 行上的扩展字段。
 * 只继承**同一个库**（id 相同）的扩展字段——换了库不该把上一个库的私有配置带过去。
 * 已知字段一律以 `config` 为准。
 */
function configForWrite(config: MemoryBankConfig, path: string): Record<string, unknown> {
	const raw = readRawConfigObject(path) ?? {};
	const rawExternal = raw.external;
	const sameBank =
		config.external &&
		rawExternal &&
		typeof rawExternal === "object" &&
		!Array.isArray(rawExternal) &&
		(rawExternal as Record<string, unknown>).id === config.external.id;
	const external = config.external
		? { ...(sameBank ? (rawExternal as Record<string, unknown>) : {}), ...config.external }
		: null;
	return { ...raw, v: config.v, active: config.active, external, timeouts: config.timeouts };
}

function writeConfigFile(config: MemoryBankConfig, env: NodeJS.ProcessEnv): boolean {
	try {
		const path = memoryBankConfigPath(env);
		atomicWrite(path, `${JSON.stringify(configForWrite(config, path), null, 2)}\n`);
		return true;
	} catch (error) {
		// 只记错误码：fs 错误消息里带完整路径（日志纪律不记路径）。
		console.warn(`[memory-bank] 配置写入失败（本次仍按内存值生效）: ${errorCodeOf(error)}`);
		return false;
	}
}

/**
 * 读配置。文件是唯一事实源（存在时 env 不再改写它）；文件不存在才按 env 播种。
 * mtime + size 缓存：PUT /bank 与页面轮询不反复读盘。
 */
export function readMemoryBankConfig(env: NodeJS.ProcessEnv = process.env): MemoryBankConfig {
	const path = memoryBankConfigPath(env);
	let mtimeMs = 0;
	let size = 0;
	let exists = false;
	try {
		const stat = statSync(path);
		mtimeMs = stat.mtimeMs;
		size = stat.size;
		exists = true;
	} catch {
		/* 文件不存在：走播种 / 空配置 */
	}
	if (configCache && configCache.path === path && configCache.mtimeMs === mtimeMs && configCache.size === size) {
		return configCache.config;
	}
	if (!exists) {
		const seeded = seedFromEnv(env);
		const config = seeded ?? emptyConfig();
		if (seeded) {
			writeConfigFile(seeded, env);
			console.log("[memory-bank] 首次启动：已按 PERSONA_MEMORY_ASK 播种外部库（active=builtin）");
		}
		configCache = { path, mtimeMs: 0, size: 0, config };
		return config;
	}
	let config = emptyConfig();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		config = sanitizeConfig(parsed);
		if (config.active === "builtin" && (parsed as { active?: unknown })?.active === "external") {
			console.warn("[memory-bank] 外部库配置不完整（active=external 但 external 无效），按内置库处理");
		}
	} catch (error) {
		// 只记错误码（fs 错误消息可能带路径）；坏 JSON 也不把文件内容带进日志。
		console.warn(`[memory-bank] 配置文件无法解析，按内置库处理: ${errorCodeOf(error)}`);
	}
	configCache = { path, mtimeMs, size, config };
	return config;
}

/** 测试 / 探针：清配置缓存（换 MEMORY_BANK_PATH 或同一文件被外部改写后）。 */
export function resetMemoryBankCacheForTests(): void {
	configCache = null;
	bankCatalogCache = null;
	bankCatalogFailedAt = 0;
	lastProbe.clear();
}

/** 当前槽位：external 只在「配置里有 external」且 active=external 时成立。 */
export function activeBank(env: NodeJS.ProcessEnv = process.env): MemoryBankActive {
	const config = readMemoryBankConfig(env);
	return config.active === "external" && config.external ? "external" : "builtin";
}

export function isExternalBankActive(env: NodeJS.ProcessEnv = process.env): boolean {
	return activeBank(env) === "external";
}

export function isBuiltinBankActive(env: NodeJS.ProcessEnv = process.env): boolean {
	return !isExternalBankActive(env);
}

/**
 * 解析外接库路径：root 必须存在；入口必须落在 root 内（先按 `..` 判，存在时再 realpath 判）。
 * 不 spawn、不改配置；`askExists` / `repairExists` 各自如实给。repair 为空 = 只读库。
 */
export function resolveExternalBank(
	external: ExternalBankRecord,
	env: NodeJS.ProcessEnv = process.env,
): ExternalBankResolution {
	const root = resolve(external.root);
	const rootExists = isAbsolute(external.root) && existsSync(root) && statSync(root).isDirectory();
	const askRel = external.ask;
	const repairRel = external.repair;
	const askPath = askRel ? resolve(root, fromPosixRel(askRel)) : "";
	const repairPath = repairRel ? resolve(root, fromPosixRel(repairRel)) : "";
	const askInside =
		Boolean(askRel) &&
		pathWithin(root, askPath) &&
		(!existsSync(askPath) || realPathWithin(root, askPath));
	const repairInside =
		!repairRel ||
		(pathWithin(root, repairPath) && (!existsSync(repairPath) || realPathWithin(root, repairPath)));
	const askExists = askInside && existsSync(askPath) && statSync(askPath).isFile();
	const repairExists =
		Boolean(repairRel) && repairInside && existsSync(repairPath) && statSync(repairPath).isFile();
	const ok = rootExists && askInside && repairInside;
	const pythonRunner = pythonOf(external, env);
	return {
		ok,
		root,
		rootExists,
		askPath,
		repairPath,
		askExists,
		repairExists,
		askCommand: askExists ? entryCommand(askRel, askPath, pythonRunner) : null,
		repairCommand: repairExists ? entryCommand(repairRel, repairPath, pythonRunner) : null,
		...(ok ? {} : { error: rootExists ? "outside_root" : "root_missing" }),
	};
}

interface EntryRef {
	rel: string;
	abs: string;
}

/** 入口扩展名顺序（2026-11-23 多语言入口）：先 .py（兼容 persona），再 JS / Bash / PS / exe / 无扩展名。 */
const ENTRY_EXTS = [".py", ".js", ".mjs", ".cjs", ".sh", ".ps1", ".exe", ""] as const;

/** 查找顺序：给了 preferredDir（ask 所在目录）就只找同目录；否则 `<root>` → `<root>/analysis`。 */
function findEntry(root: string, base: "ask" | "repair", preferredDir?: string): EntryRef | null {
	const dirs = preferredDir ? [preferredDir] : [root, join(root, "analysis")];
	for (const dir of dirs) {
		for (const ext of ENTRY_EXTS) {
			const abs = join(dir, `${base}${ext}`);
			if (existsSync(abs) && statSync(abs).isFile() && pathWithin(root, abs)) {
				return { rel: toPosixRel(relative(root, abs)), abs };
			}
		}
	}
	return null;
}

/** 按扩展名选运行器；无法识别的扩展名 / 无扩展名按可执行文件直接起。
 *  `.js` 用当前进程的 node（`process.execPath`）：不依赖 PATH，版本也跟宿主一致。 */
function entryCommand(rel: string, abs: string, pythonRunner: string): string[] {
	const ext = extname(rel).toLowerCase();
	if (ext === ".py") return [pythonRunner || "python", abs];
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return [process.execPath, abs];
	if (ext === ".sh") return ["bash", abs];
	if (ext === ".ps1") {
		return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", abs];
	}
	return [abs];
}

interface LastProbe {
	status: MemoryBankStatus;
	at: number;
}
const lastProbe = new Map<string, LastProbe>();

function probeKey(root: string, ask: string, repair: string): string {
	return `${resolve(root)}\u0000${ask}\u0000${repair}`.toLowerCase();
}

function rememberProbe(root: string, ask: string, repair: string, status: MemoryBankStatus): void {
	lastProbe.set(probeKey(root, ask, repair), { status, at: Date.now() });
}

function lastProbeStatus(root: string, ask: string, repair: string): MemoryBankStatus | null {
	return lastProbe.get(probeKey(root, ask, repair))?.status ?? null;
}

/** 合成子进程 env：把当前库的路径与已生效的开关钉进去（避免 `flagEnabled` 读到别的库）。 */
function pinnedEnv(
	env: NodeJS.ProcessEnv,
	paths: { ask: string; repair: string; python: string },
	overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	return {
		...env,
		PERSONA_MEMORY_ASK: paths.ask,
		PERSONA_REPAIR: paths.repair,
		PERSONA_PYTHON: paths.python || env.PERSONA_PYTHON?.trim() || "python",
		...overrides,
	};
}

function pythonOf(external: ExternalBankRecord, env: NodeJS.ProcessEnv): string {
	return external.python.trim() || env.PERSONA_PYTHON?.trim() || "python";
}

/**
 * 探测一个目录（不落盘）：
 *   - root 必须是绝对路径且存在；
 *   - 按多扩展名找读入口（ask.py / ask.js / ask.sh / ask.exe / ask）与写入口（repair 同理）；
 *   - 真跑一次读入口 `--catalog-only`（≤20 行，15s 超时）。
 *
 * 没读入口 = `missing_ask`（不能接入）；没写入口 = `missing_repair`（只读库，仍可接入）；
 * catalog 失败 = `error`。`ok` 只在读入口存在且 catalog 跑通时为 true。
 */
export async function probeBank(rootInput: string, deps: BankDeps = {}): Promise<BankProbeResult> {
	const env = deps.env ?? process.env;
	const raw = rootInput?.trim() ?? "";
	if (!raw) {
		return { ok: false, status: "error", root: raw, message: "目录不能为空", error: "root_empty" };
	}
	if (!isAbsolute(raw)) {
		return { ok: false, status: "error", root: raw, message: "目录必须是绝对路径", error: "root_not_absolute" };
	}
	const root = resolve(raw);
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		return { ok: false, status: "error", root, message: "目录不存在或不是文件夹", error: "root_missing" };
	}
	const ask = findEntry(root, "ask");
	if (!ask) {
		return {
			ok: false,
			status: "missing_ask",
			root,
			message: "没有找到读入口（支持 ask.py / ask.js / ask.sh / ask.exe / ask）",
			error: "missing_ask",
		};
	}
	const repair = findEntry(root, "repair", dirname(ask.abs));
	const pythonRunner = env.PERSONA_PYTHON?.trim() || "python";
	const askCommand = entryCommand(ask.rel, ask.abs, pythonRunner);
	const repairCommand = repair ? entryCommand(repair.rel, repair.abs, pythonRunner) : null;
	const catalog = await askPersonaCatalog({
		env: pinnedEnv(
			env,
			{ ask: ask.abs, repair: repair?.abs ?? "", python: pythonRunner },
			{ PERSONA_MEMORY_ENABLED: "true", PERSONA_MEMORY_INJECT: "true" },
		),
		command: askCommand,
		cwd: root,
		...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
	});
	const status: MemoryBankStatus = !catalog.ok ? "error" : repairCommand ? "ok" : "missing_repair";
	rememberProbe(root, ask.rel, repair?.rel ?? "", status);
	if (!catalog.ok) {
		return {
			ok: false,
			status,
			root,
			ask: ask.rel,
			...(repair ? { repair: repair.rel } : {}),
			catalog: { ok: false, lines: [] },
			message: "读入口 --catalog-only 没跑通（检查入口与运行器）",
			...(catalog.error ? { error: catalog.error } : {}),
		};
	}
	return {
		ok: true,
		status,
		root,
		ask: ask.rel,
		...(repair ? { repair: repair.rel } : {}),
		catalog: { ok: true, lines: catalog.lines },
		...(repairCommand ? {} : { message: "没有写入口：这个库只读" }),
	};
}

export interface BankSaveInput {
	root: string;
	name?: string;
	/** 向量检索（2026-11-24）：缺省 = 不勾（false），与旧调用逐字节相同。 */
	vector?: boolean;
}

/**
 * 接入 / 更换外接库：探测通过才保存；**不自动切换**（切换仍走 `setActiveBank`）。
 * 只读库（无写入口）也允许保存——它只是多了个"切过去不能写"的形态。
 */
export async function setExternalBank(
	input: BankSaveInput,
	deps: BankDeps = {},
): Promise<BankSaveResult> {
	const env = deps.env ?? process.env;
	const probe = await probeBank(input.root, deps);
	if (!probe.ok || !probe.ask) {
		return {
			ok: false,
			active: activeBank(env),
			status: 400,
			error: "probe_failed",
			message: probe.message ?? "探测未通过",
			probe,
		};
	}
	const config = readMemoryBankConfig(env);
	const external: ExternalBankRecord = {
		id: config.external?.id ?? newBankId(),
		name: input.name?.trim().slice(0, 60) || config.external?.name || "外部记忆库",
		root: probe.root,
		ask: probe.ask,
		repair: probe.repair ?? "",
		python: "",
		origin: "user",
		addedAt: nowIsoWithOffset(),
		// 换库 PUT 未带 vector = 按未勾处理：新目录可能不认识 --vector，默认不追加更安全。
		vector: input.vector === true,
	};
	const next: MemoryBankConfig = { ...config, external };
	writeConfigFile(next, env);
	configCache = null;
	invalidateBankCatalog();
	// 当前正在用外接库时换了目录：立刻拉一次新目录，别让注入段等到下一个 10 分钟 tick。
	if (activeBank(env) === "external") void refreshBankCatalogInjection(env);
	console.log(`[memory-bank] 外部库已保存 status=${probe.status}`);
	return { ok: true, active: activeBank(env), external, probe };
}

/**
 * 切换槽位。切 external 前校验 ask.py 存在（repair.py 缺失 = 只读库，允许切）。
 * 切成功后清目录缓存与轻召回节流账本（别拿上一个库的旧行撑 60 秒）。
 */
export function setActiveBank(active: MemoryBankActive, env: NodeJS.ProcessEnv = process.env): BankSwitchResult {
	if (active !== "builtin" && active !== "external") {
		return { ok: false, active: activeBank(env), status: 400, error: "bad_active", message: "active 只能是 builtin 或 external" };
	}
	const config = readMemoryBankConfig(env);
	if (active === "external") {
		if (!config.external) {
			return { ok: false, active: config.active, status: 400, error: "no_external_bank", message: "还没有接入外部记忆库" };
		}
		const resolution = resolveExternalBank(config.external, env);
		if (!resolution.rootExists || !resolution.askExists) {
			return {
				ok: false,
				active: config.active,
				status: 400,
				error: "missing_ask",
				message: "外部记忆库的 ask.py 不存在，先「检测」目录再切换",
			};
		}
	}
	const next: MemoryBankConfig = { ...config, active };
	writeConfigFile(next, env);
	configCache = null;
	invalidateBankCatalog();
	// 切到外接库：立刻拉一次目录，否则 persona_catalog 注入要等 10 分钟才出现。
	if (active === "external") void refreshBankCatalogInjection(env);
	console.log(`[memory-bank] 槽位切换：${active}`);
	return { ok: true, active };
}

/** 移除外接库；若当前正用着它，先切回 builtin。 */
export function deleteExternalBank(env: NodeJS.ProcessEnv = process.env): BankDeleteResult {
	const config = readMemoryBankConfig(env);
	if (!config.external) {
		return { ok: false, active: config.active, status: 404, error: "not_found", message: "还没有接入外部记忆库" };
	}
	const deleted = config.external.id;
	const next: MemoryBankConfig = {
		v: CONFIG_VERSION,
		active: config.active === "external" ? "builtin" : config.active,
		external: null,
		timeouts: config.timeouts,
	};
	writeConfigFile(next, env);
	configCache = null;
	invalidateBankCatalog();
	console.log("[memory-bank] 外部库已移除");
	return { ok: true, deleted, active: next.active };
}

/**
 * 保存两档超时（2026-11-24，局部更新）：只改给了的字段，缺省字段保持当前值。
 * 类型校验在 API 层做（必须是数字）；这里只做 clamp——越界收进边界，0 / 负数按最小值。
 * 写回走原子写 + 未知字段保留；不改 active、不动 external。
 */
export function setMemoryBankTimeouts(
	input: { lightMs?: number; askMs?: number },
	env: NodeJS.ProcessEnv = process.env,
): BankTimeoutsResult {
	const config = readMemoryBankConfig(env);
	const timeouts = sanitizeTimeouts({
		lightMs: input.lightMs !== undefined ? input.lightMs : config.timeouts.lightMs,
		askMs: input.askMs !== undefined ? input.askMs : config.timeouts.askMs,
	});
	const next: MemoryBankConfig = { ...config, timeouts };
	writeConfigFile(next, env);
	configCache = null;
	console.log(`[memory-bank] 超时已保存 light=${timeouts.lightMs}ms ask=${timeouts.askMs}ms`);
	return { ok: true, timeouts };
}

// ── 目录缓存（10 分钟，注入用）──────────────────────────────
//
// `askPersonaCatalog` 自己已有 10 分钟成功缓存；这一层是给同步 render 用的文本快照，
// 与 persona-inject 的同款设计：失败保留旧文本、60s 冷却，别让坏库把每个请求都拖慢。

let bankCatalogCache: string | null = null;
let bankCatalogFailedAt = 0;
const BANK_CATALOG_FAILURE_COOLDOWN_MS = 60_000;
const BANK_CATALOG_REFRESH_MS = 10 * 60_000;
let bankCatalogTimer: ReturnType<typeof setInterval> | null = null;

/** 当前外接库的（裁剪后）目录文本；没成功拉过 = null（整段不注）。 */
export function bankCatalogCachedText(): string | null {
	return bankCatalogCache;
}

function invalidateBankCatalog(): void {
	bankCatalogCache = null;
	bankCatalogFailedAt = 0;
	clearPersonaLightRecall();
}

/**
 * 给子进程用的合成 env（当前外接库 + 已生效开关）。外部库不可用 / 槽位不是 external 时 null。
 * 消费处：`personaLightRecall` 的闸门与 ask、注入时的 `personaInjectGatesClosed`。
 */
export function bankSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | null {
	if (activeBank(env) !== "external") return null;
	const config = readMemoryBankConfig(env);
	const external = config.external;
	if (!external) return null;
	const resolution = resolveExternalBank(external, env);
	if (!resolution.ok || !resolution.askExists) return null;
	return pinnedEnv(
		env,
		{ ask: resolution.askPath, repair: resolution.repairPath, python: pythonOf(external, env) },
		{
			PERSONA_MEMORY_ENABLED: flagEnabled("PERSONA_MEMORY_ENABLED", env) ? "true" : "false",
			PERSONA_MEMORY_INJECT: flagEnabled("PERSONA_MEMORY_INJECT", env) ? "true" : "false",
			PERSONA_WRITE_ENABLED: flagEnabled("PERSONA_WRITE_ENABLED", env) ? "true" : "false",
		},
	);
}

/**
 * 当前外接库读入口的启动命令（2026-11-23 多语言入口）；注入轻召回 / 目录刷新用。
 * 槽位不是 external / 入口不可用时 null。
 */
export function bankAskCommand(
	env: NodeJS.ProcessEnv = process.env,
): { command: string[]; cwd: string } | null {
	if (activeBank(env) !== "external") return null;
	const config = readMemoryBankConfig(env);
	const external = config.external;
	if (!external) return null;
	const resolution = resolveExternalBank(external, env);
	if (!resolution.ok || !resolution.askCommand) return null;
	return { command: resolution.askCommand, cwd: resolution.root };
}

/**
 * 两档超时（2026-11-24）：轻召回调用方（lifecycle）从这里取 lightMs 传给 personaLightRecall；
 * 工具调用由 bankAsk 内部取 askMs。缺配置 / 非法值已在读配置时归一成默认。
 */
export function bankTimeouts(env: NodeJS.ProcessEnv = process.env): MemoryBankTimeouts {
	return readMemoryBankConfig(env).timeouts;
}

/**
 * 当前外接库的目录（读入口 `--catalog-only`，≤20 行；persona-ask 内有 10 分钟缓存）。
 * builtin / 未接入 / 不可用时返回 ok:false（不抛）。
 */
export async function bankCatalog(deps: BankDeps = {}): Promise<{ ok: boolean; lines: string[]; error?: string }> {
	const env = deps.env ?? process.env;
	if (activeBank(env) !== "external") return { ok: false, lines: [], error: "bank_builtin" };
	const spawnEnv = bankSpawnEnv(env);
	const command = bankAskCommand(env);
	if (!spawnEnv || !command) return { ok: false, lines: [], error: "bank_unavailable" };
	if (!personaAskEnabled(spawnEnv)) {
		return { ok: false, lines: [], error: "外部记忆库已关闭（PERSONA_MEMORY_ENABLED=false）" };
	}
	return askPersonaCatalog({
		env: spawnEnv,
		command: command.command,
		cwd: command.cwd,
		...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
	});
}

/**
 * 拉一次目录并落裁剪缓存（注入定时器调；失败保留旧文本）。
 * 槽位不是 external / 闸门关：不动缓存、不抛。
 */
export async function refreshBankCatalogInjection(
	env: NodeJS.ProcessEnv = process.env,
	deps: BankDeps = {},
): Promise<void> {
	if (activeBank(env) !== "external") return;
	const spawnEnv = bankSpawnEnv(env);
	const command = bankAskCommand(env);
	if (!spawnEnv || !command || personaInjectGatesClosed(spawnEnv)) return;
	if (Date.now() - bankCatalogFailedAt < BANK_CATALOG_FAILURE_COOLDOWN_MS) return;
	try {
		const result = await askPersonaCatalog({
			env: spawnEnv,
			command: command.command,
			cwd: command.cwd,
			...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
		});
		if (!result.ok || result.lines.length === 0) {
			bankCatalogFailedAt = Date.now();
			return;
		}
		bankCatalogCache = personaCatalogTrim(result.lines);
		bankCatalogFailedAt = 0;
	} catch {
		bankCatalogFailedAt = Date.now();
	}
}

/** 启动外接库目录的定期刷新（unref；槽位不是 external 的 tick 直接空转）。 */
export function startBankCatalogRefresh(): void {
	if (bankCatalogTimer) return;
	void refreshBankCatalogInjection();
	bankCatalogTimer = setInterval(() => void refreshBankCatalogInjection(), BANK_CATALOG_REFRESH_MS);
	bankCatalogTimer.unref?.();
}

export function stopBankCatalogTimer(): void {
	if (bankCatalogTimer) {
		clearInterval(bankCatalogTimer);
		bankCatalogTimer = null;
	}
}

// ── 读 / 写路由 ────────────────────────────────────────────

/** 外接库是否可读（ask.py 在 + PERSONA_MEMORY_ENABLED 未关）。不 spawn。 */
export function bankReadable(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!isExternalBankActive(env)) return false;
	const config = readMemoryBankConfig(env);
	if (!config.external) return false;
	const resolution = resolveExternalBank(config.external, env);
	return resolution.ok && resolution.askExists && flagEnabled("PERSONA_MEMORY_ENABLED", env);
}

/** 外接库是否可写（ask.py + repair.py 在 + PERSONA_WRITE_ENABLED=true）。不 spawn。
 *  刻意不与 `PERSONA_MEMORY_ENABLED`（读闸）耦合：契约里写总闸只有 `PERSONA_WRITE_ENABLED`。 */
export function bankWritable(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!isExternalBankActive(env)) return false;
	const config = readMemoryBankConfig(env);
	if (!config.external) return false;
	const resolution = resolveExternalBank(config.external, env);
	return (
		resolution.ok &&
		resolution.askExists &&
		resolution.repairExists &&
		flagEnabled("PERSONA_WRITE_ENABLED", env)
	);
}

/**
 * 经当前外接库的 `ask.py` 检索。失败一律 `ok:false`（不抛、不回落内置库）。
 * 关闭态返回固定文案「外部记忆库已关闭」，供工具层原样转告模型。
 * 2026-11-24：工具调用按 configured `timeouts.askMs` 超时；`vector=true` 时 argv 末尾带 `--vector`。
 */
export async function bankAsk(
	question: string,
	options: { limit?: number } = {},
	deps: BankDeps = {},
): Promise<PersonaAskResult> {
	const env = deps.env ?? process.env;
	if (!isExternalBankActive(env)) {
		return { ok: false, question, error: "当前不在外部记忆库模式" };
	}
	const config = readMemoryBankConfig(env);
	if (!config.external) return { ok: false, question, error: "外部记忆库未配置" };
	if (!flagEnabled("PERSONA_MEMORY_ENABLED", env)) {
		return { ok: false, question, error: "外部记忆库已关闭（PERSONA_MEMORY_ENABLED=false）" };
	}
	const resolution = resolveExternalBank(config.external, env);
	if (!resolution.ok || !resolution.askExists || !resolution.askCommand) {
		return { ok: false, question, error: "外部记忆库不可用（读入口未找到）" };
	}
	// 工具超时策略（2026-11-24 M1）：policy.tools.recall.timeoutMs 覆盖旧 timeouts.askMs；
	// 总开关关 = 只读 memory-bank.json 的 askMs（今天的行为逐字节不变）。
	// recall 是当轮证据，onTimeout 只允许 fail（background 在 PUT 已拒），这里不再分支。
	const policy = resolveToolPolicy(env, { recall: config.timeouts.askMs });
	const timeoutMs = policy.enabled
		? (policy.tools.recall?.effective.timeoutMs ?? config.timeouts.askMs)
		: config.timeouts.askMs;
	return askPersona(
		question,
		{ ...options, anyGroups: true, vector: config.external.vector === true },
		{
			env: pinnedEnv(
				env,
				{ ask: resolution.askPath, repair: resolution.repairPath, python: pythonOf(config.external, env) },
				{ PERSONA_MEMORY_ENABLED: "true" },
			),
			command: resolution.askCommand,
			cwd: resolution.root,
			timeoutMs,
			...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
		},
	);
}

/**
 * 经当前外接库的 `repair.py statement` 写一条原话。失败返回 ok:false（不回落内置库）。
 * `PERSONA_WRITE_ENABLED=false` / 无 repair.py 在这里也再挡一次（工具层先挡，属纵深）。
 */
export async function bankWrite(
	input: PersonaWriteInput,
	deps: BankDeps = {},
): Promise<PersonaWriteResult> {
	const env = deps.env ?? process.env;
	if (!isExternalBankActive(env)) {
		return { ok: false, error: "当前不在外部记忆库模式" };
	}
	if (!flagEnabled("PERSONA_WRITE_ENABLED", env)) {
		return { ok: false, error: "写入未开启（PERSONA_WRITE_ENABLED=false）" };
	}
	const config = readMemoryBankConfig(env);
	if (!config.external) return { ok: false, error: "外部记忆库未配置" };
	const resolution = resolveExternalBank(config.external, env);
	if (!resolution.ok || !resolution.askExists) {
		return { ok: false, error: "外部记忆库不可用（读入口未找到）" };
	}
	if (!resolution.repairCommand) {
		return { ok: false, error: "这个外部记忆库只读（没有可用的写入口）" };
	}
	return personaWrite(input, {
		env: pinnedEnv(
			env,
			{ ask: resolution.askPath, repair: resolution.repairPath, python: pythonOf(config.external, env) },
			{ PERSONA_WRITE_ENABLED: "true" },
		),
		command: resolution.repairCommand,
		cwd: resolution.root,
		...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
	});
}

// ── 状态投影（GET /bank）──────────────────────────────────

function statusOf(external: ExternalBankRecord, env: NodeJS.ProcessEnv): MemoryBankStatus {
	const resolution = resolveExternalBank(external, env);
	if (!resolution.ok && resolution.rootExists) return "error"; // 路径越界
	if (!resolution.rootExists || !resolution.askExists) return "missing_ask";
	if (lastProbeStatus(resolution.root, external.ask, external.repair) === "error") return "error";
	if (!resolution.repairExists) return "missing_repair";
	return "ok";
}

function capabilitiesOf(
	external: ExternalBankRecord,
	status: MemoryBankStatus,
	env: NodeJS.ProcessEnv,
): MemoryBankCapabilities {
	const resolution = resolveExternalBank(external, env);
	// 「只看文件存在性 + 上次 probe 结果」：这里不 spawn、不探活。
	const askReady = resolution.askExists && flagEnabled("PERSONA_MEMORY_ENABLED", env);
	const read = askReady && status !== "error";
	// 写能力只认写总闸（与读闸解耦，契约 §1.2：write 还要求 PERSONA_WRITE_ENABLED=true）。
	const write =
		resolution.ok &&
		resolution.askExists &&
		resolution.repairExists &&
		flagEnabled("PERSONA_WRITE_ENABLED", env) &&
		status !== "error";
	return {
		read,
		write,
		catalog: read,
	};
}

/** 记忆工具面恒为两个（2026-11-24 旧形态退役）：槽位只决定挂哪个库，不改工具名。 */
const MEMORY_BANK_TOOLS = ["recall", "remember"] as const;

/** GET /bank 的状态投影（不 spawn）。 */
export function memoryBankState(env: NodeJS.ProcessEnv = process.env): MemoryBankState {
	const config = readMemoryBankConfig(env);
	const external = config.external
		? (() => {
				const status = statusOf(config.external, env);
				return { ...config.external, status, capabilities: capabilitiesOf(config.external, status, env) };
			})()
		: null;
	const active: MemoryBankActive = config.active === "external" && external ? "external" : "builtin";
	return {
		// 槽位模块恒开（旧总闸已退役）；字段保留给页面 / 老客户端读，语义固定为 true。
		enabled: true,
		active,
		external,
		timeouts: config.timeouts,
		tools: [...MEMORY_BANK_TOOLS],
	};
}
