import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

/**
 * 运行时开关层（2026-11-09 用户拍板：设置尽量在界面里控制，不逼人碰服务端 env）。
 *
 * 清单（2026-11-16 用户拍板：从 JSON 读）：`src/plugins.json` 提供有哪些开关、中文名 /
 * 说明 / 分组 / 类型 / 档位 / 默认值 / scope / requires；前端不再维护 key、label、group、
 * choice 四张写死的表。清单是运行期输入：启动时校验，运行中按 mtime + size 重新装载，
 * 改清单不需要重启（坏清单保留上一版并 warn）。
 *
 * 配置（2026-11-16 再续：plugin 以 JSON 为真源）：`.data/agent-flags.json` 存界面改过的值
 * （{ KEY: "value" }）。`scope=plugin` 的读写在运行时直接走这份 JSON（带 mtime 缓存），
 * 不再把值写回 process.env；env 只作文件缺省时的部署回落。`scope=core`（记忆总闸 / 执事体系 /
 * 派活 / 自主轮）仍按部署 env 为主，`setFlag` 保持落盘 + 同步写 env。
 * `hot: true` 的开关当场生效；`hot: false` 的（路由挂载 / 工具注册 / 模块常量在启动时冻结）
 * 重启后生效，文件保证重启后仍是用户选的值。
 * - 界面回滚：`AGENT_FLAGS_UI=false` → 端点不挂（GET 留着只读无妨，一并关）。
 *
 * 刻意不做：不在这一层做权限分级（写端点在 /api/v1 鉴权后面，与其它设置同权）；
 * 不做文件锁（单进程 + 原子写足够）。
 */

export type FlagScope = "core" | "plugin";
export type FlagType = "boolean" | "enum" | "number";
export type FlagSurface = "flags" | "settings";
export interface FlagChoice {
	value: string;
	label: string;
}
export interface FlagGroupDef {
	id: string;
	title: string;
	desc: string;
	keys: string[];
}
interface FlagManifest {
	groups: FlagGroupDef[];
	flags: FlagDef[];
}

export interface FlagDef {
	key: string;
	values: string[];
	/** 缺省值（env 未设时界面显示的形态） */
	defaultValue: string;
	/**
	 * true = 消费处函数内懒读 env（改完即生效）；
	 * false = 启动时冻结（路由挂载 / 工具注册 / 模块常量），重启后生效。
	 */
	hot: boolean;
	/** 界面名称 / 卡片说明；从 plugins.json 来，不再写死在前端。 */
	label?: string;
	summary?: string;
	/** 所属分组 id；普通卡必填，专属卡可留空。 */
	group?: string;
	/** 控件类型；不写时按 values 推断（true/false = 布尔，其余 = 枚举）。 */
	type?: FlagType;
	/** 枚举控件的中文档位；布尔不需要。 */
	choices?: FlagChoice[];
	/**
	 * 多档插件的「关」是哪个取值（2026-11-18）：界面据此画开关（开 = 其余档位，关 = 这个值）。
	 * 关不一定是布尔 false——`CHANCELLOR_INTERNAL` 的关是 `qoder`（外部 CLI），
	 * `AGENT_TOOL_POLICY` 的关是 `full`（完全访问）。必须在 `values` 里。
	 */
	offValue?: string;
	/** flags = 插件页普通卡；settings = 设置 → 会话等专属卡，不在插件页重复。 */
	surface?: FlagSurface;
	/**
	 * `core` = 系统核心：记忆 / 执事体系 / 派活 / 自主轮这类决定子系统边界的开关，
	 * 默认由部署 env 兜底；界面仍可读写，但前端要打「系统核心」标，不当普通插件。
	 * `plugin` = 普通功能插件（不写时按这个算）。
	 */
	scope?: FlagScope;
	/**
	 * 父子门（2026-11-16 用户拍板，非破坏性）：任一父开关为 `false` 时，
	 * 本项在界面显示「关」、控件锁住、PUT 返回 400 `flag_locked`；
	 * **本项自己的存储值保留**，父重开就恢复，不清零。
	 * 允许多父（任一关即锁），也允许嵌套（子本身还可以是别人的父）。
	 */
	requires?: string[];
	/**
	 * 数值型开关（2026-11-13 自动归档天数）：`values` 留空且给了 `min` 时，
	 * 取值按「≥min 的整数」校验，不再查枚举表。只有界面真的要自由数值才用。
	 */
	min?: number;
	/** 数值型开关的上界（2026-11-14 压缩百分比）：给了就按「min–max 的整数」校验。 */
	max?: number;
}

/** 取值校验收口：枚举表命中，或数值型开关按整数 ≥min（≤max）校验（loadFlagOverrides / setFlag 共用）。 */
function flagValueAllowed(def: FlagDef, value: string): boolean {
	if (def.values.includes(value)) return true;
	if (def.values.length === 0 && def.min !== undefined) {
		const parsed = Number(value);
		if (!Number.isInteger(parsed)) return false;
		if (parsed < def.min) return false;
		if (def.max !== undefined && parsed > def.max) return false;
		return true;
	}
	return false;
}

/** 进界面的白名单：清单来自 plugins.json；只收"用户行为开关"，路径/令牌类一律不收。
 *  下面是可热更新的运行时视图；`FLAG_DEFS` / `FLAG_GROUPS` 仍导出，测试与旧调用方无感。 */
export const FLAG_DEFS: FlagDef[] = [];
export const FLAG_GROUPS: FlagGroupDef[] = [];
const FLAG_BY_KEY = new Map<string, FlagDef>();
const DEFAULT_PLUGIN_MANIFEST_PATH = fileURLToPath(new URL("./plugins.json", import.meta.url));

interface ManifestSnapshot {
	path: string;
	mtimeMs: number;
	size: number;
}
let manifestSnapshot: ManifestSnapshot | null = null;

export function pluginManifestPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_PLUGINS_PATH?.trim() || DEFAULT_PLUGIN_MANIFEST_PATH);
}

interface LoadedManifest {
	manifest: FlagManifest;
	byKey: Map<string, FlagDef>;
	mtimeMs: number;
	size: number;
}

/** plugins.json 是运行期输入：启动即校验「键唯一 / 取值 / 分组引用 / requires 图」；
 *  运行中读到坏清单时打 warn 并保留上一版，避免一次手滑把服务打挂。 */
function validateFlagManifest(manifest: FlagManifest): Map<string, FlagDef> {
	const seenKeys = new Set<string>();
	for (const def of manifest.flags) {
		if (!def.key || seenKeys.has(def.key)) throw new Error(`[flags] 清单键重复或为空：${def.key}`);
		seenKeys.add(def.key);
		if (def.type && !["boolean", "enum", "number"].includes(def.type)) {
			throw new Error(`[flags] ${def.key} 的 type 非法：${def.type}`);
		}
		if (def.scope && !["core", "plugin"].includes(def.scope)) {
			throw new Error(`[flags] ${def.key} 的 scope 非法：${def.scope}`);
		}
		if (def.surface && !["flags", "settings"].includes(def.surface)) {
			throw new Error(`[flags] ${def.key} 的 surface 非法：${def.surface}`);
		}
		// 数值型开关允许空值 = 回默认；其它项默认值必须能通过正式取值校验。
		const emptyNumber = def.values.length === 0 && def.defaultValue === "";
		if (!emptyNumber && !flagValueAllowed(def, def.defaultValue)) {
			throw new Error(`[flags] ${def.key} 的默认值非法：${def.defaultValue}`);
		}
		for (const choice of def.choices ?? []) {
			if (!def.values.includes(choice.value)) throw new Error(`[flags] ${def.key} 的选项不在 values 里：${choice.value}`);
			if (!choice.label) throw new Error(`[flags] ${def.key} 的选项缺少中文名：${choice.value}`);
		}
		// 关值必须是正式取值：界面会把它写进 PUT，消费处也会拿它比较，错一个字符就是假开关。
		if (def.offValue !== undefined && !def.values.includes(def.offValue)) {
			throw new Error(`[flags] ${def.key} 的 offValue 不在 values 里：${def.offValue}`);
		}
	}
	const byKey = new Map(manifest.flags.map((def) => [def.key, def]));
	const seenGroups = new Set<string>();
	const seenGroupKeys = new Set<string>();
	for (const group of manifest.groups) {
		if (!group.id || seenGroups.has(group.id)) throw new Error(`[flags] 分组 id 重复或为空：${group.id}`);
		seenGroups.add(group.id);
		for (const key of group.keys) {
			if (!byKey.has(key)) throw new Error(`[flags] 分组 ${group.id} 指向不存在的开关：${key}`);
			if (seenGroupKeys.has(key)) throw new Error(`[flags] 分组键重复：${key}`);
			seenGroupKeys.add(key);
		}
	}
	validateFlagRequires(manifest.flags, byKey);
	return byKey;
}

/** 校验 requires 图：父键必须存在、不许自指 / 成环。坏配置直接 throw，
 *  不要留到运行期表现成「某个开关永远锁着」。 */
function validateFlagRequires(defs: FlagDef[], byKey: Map<string, FlagDef>): void {
	const done = new Set<string>();
	const visiting = new Set<string>();
	const walk = (key: string): void => {
		if (done.has(key)) return;
		if (visiting.has(key)) throw new Error(`[flags] requires 成环：${[...visiting, key].join(" → ")}`);
		const def = byKey.get(key);
		if (!def) throw new Error(`[flags] requires 指向不存在的开关：${key}`);
		visiting.add(key);
		for (const req of def.requires ?? []) {
			if (!byKey.has(req)) throw new Error(`[flags] ${key} 的 requires 指向不存在的开关：${req}`);
			walk(req);
		}
		visiting.delete(key);
		done.add(key);
	};
	for (const def of defs) walk(def.key);
}

function loadManifestFile(path: string, initial: boolean): LoadedManifest {
	let mtimeMs = 0;
	let size = 0;
	try {
		const stat = statSync(path);
		mtimeMs = stat.mtimeMs;
		size = stat.size;
	} catch (error) {
		if (initial) throw new Error(`[flags] 插件清单不存在：${path}`);
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`[flags] 插件清单不是合法 JSON（${path}）：${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`[flags] 插件清单根节点必须是对象：${path}`);
	}
	const manifest = parsed as FlagManifest;
	if (!Array.isArray(manifest.flags) || !Array.isArray(manifest.groups)) {
		throw new Error(`[flags] 插件清单缺少 flags / groups 数组：${path}`);
	}
	return { manifest, byKey: validateFlagManifest(manifest), mtimeMs, size };
}

function applyManifest(loaded: LoadedManifest, path: string): void {
	FLAG_DEFS.splice(0, FLAG_DEFS.length, ...loaded.manifest.flags);
	FLAG_GROUPS.splice(0, FLAG_GROUPS.length, ...loaded.manifest.groups);
	FLAG_BY_KEY.clear();
	for (const [key, def] of loaded.byKey) FLAG_BY_KEY.set(key, def);
	manifestSnapshot = { path, mtimeMs: loaded.mtimeMs, size: loaded.size };
}

/** 运行中按 mtime + size 热更新清单；文件不存在或坏 JSON 时保留上一版。 */
function refreshManifest(env: NodeJS.ProcessEnv = process.env): void {
	const path = pluginManifestPath(env);
	let stat;
	try {
		stat = statSync(path);
	} catch {
		if (!manifestSnapshot) throw new Error(`[flags] 插件清单不存在：${path}`);
		return;
	}
	if (
		manifestSnapshot &&
		manifestSnapshot.path === path &&
		manifestSnapshot.mtimeMs === stat.mtimeMs &&
		manifestSnapshot.size === stat.size
	) {
		return;
	}
	try {
		applyManifest(loadManifestFile(path, false), path);
	} catch (error) {
		console.warn(`[flags] 插件清单加载失败，继续使用上一版：${error instanceof Error ? error.message : String(error)}`);
	}
}

const initialManifest = loadManifestFile(DEFAULT_PLUGIN_MANIFEST_PATH, true);
FLAG_DEFS.push(...initialManifest.manifest.flags);
FLAG_GROUPS.push(...initialManifest.manifest.groups);
for (const [key, def] of initialManifest.byKey) FLAG_BY_KEY.set(key, def);
manifestSnapshot = { path: DEFAULT_PLUGIN_MANIFEST_PATH, mtimeMs: initialManifest.mtimeMs, size: initialManifest.size };

/** 只有进程级 env 或显式指定了配置文件时才读 JSON。
 *  单测 / 探针传入的普通 env 对象应当保持"纯 env 夹具"语义，不能被开发机真实 `.data` 串味。 */
function pluginStoreApplies(env: NodeJS.ProcessEnv): boolean {
	return env === process.env || Boolean(env.AGENT_FLAGS_PATH?.trim());
}

/** 盘上 / env 里真正存下来的值（不是锁后的展示值）。
 *  plugin：以 `.data/agent-flags.json` 为真源；文件没写才回 env / 清单默认值。
 *  core：仍以部署 env 为主（界面覆盖仍由 setFlag 同步进 env，历史行为不变）。 */
function storedFlagValue(def: FlagDef, env: NodeJS.ProcessEnv): string {
	if ((def.scope ?? "plugin") === "plugin" && pluginStoreApplies(env)) {
		const map = readOverrideMap(flagsPath(env));
		const raw = map[def.key];
		if (raw !== undefined && flagValueAllowed(def, raw)) return raw;
	}
	return env[def.key]?.trim() || def.defaultValue;
}

/** 给消费代码读原始值（枚举 / 数值型也适用）；plugin 走 JSON，core 走 env。 */
export function flagValue(key: string, env: NodeJS.ProcessEnv = process.env): string {
	refreshManifest(env);
	const def = FLAG_BY_KEY.get(key);
	return def ? storedFlagValue(def, env) : "";
}

/** false / 0 / off 都算关（父子门和消费处共用同一份判据）。 */
function flagIsOff(raw: string): boolean {
	const value = raw.trim().toLowerCase();
	return value === "false" || value === "0" || value === "off";
}

/** 非破坏性父子门的生效值：自己有值，但任一父关着就显示 / 按 `false` 处理。
 *  存储值一个字都不动，父重开自动恢复。 */
function effectiveFlagValue(key: string, env: NodeJS.ProcessEnv, stack = new Set<string>()): string {
	const def = FLAG_BY_KEY.get(key);
	if (!def) return "false";
	if (stack.has(key)) return storedFlagValue(def, env); // 图已校验无环，这层只是兜底
	stack.add(key);
	const own = storedFlagValue(def, env);
	if (flagIsOff(own)) return "false";
	for (const req of def.requires ?? []) {
		if (flagIsOff(effectiveFlagValue(req, env, stack))) return "false";
	}
	return own;
}

/** 第一个关着的直接父；没有就 null。用于界面文案「由 XX 关闭」。 */
function lockingFlag(def: FlagDef, env: NodeJS.ProcessEnv): string | null {
	for (const req of def.requires ?? []) {
		if (flagIsOff(effectiveFlagValue(req, env))) return req;
	}
	return null;
}

function flagLabel(key: string): string {
	return FLAG_BY_KEY.get(key)?.label || key;
}

/** 给消费代码用的活读布尔：父关 / 显式 false / 0 / off 都算关。只适合 true/false 型开关。 */
export function flagEnabled(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
	refreshManifest(env);
	if (!FLAG_BY_KEY.has(key)) return false;
	return !flagIsOff(effectiveFlagValue(key, env));
}

/** 启动装载后每个键当时真正生效的值。用来判断 hot:false 的改动是否还没重启——
 *  文件里的值和启动时不一样 → 界面标「待重启」；重启装载后两者相等，标自动消失。 */
const bootValues = new Map<string, string>();
let bootCaptured = false;

function captureBootValues(env: NodeJS.ProcessEnv): void {
	if (bootCaptured) return;
	bootCaptured = true;
	for (const def of FLAG_DEFS) bootValues.set(def.key, storedFlagValue(def, env));
}

export function flagsUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_FLAGS_UI ?? "").trim().toLowerCase() !== "false";
}

/**
 * 会话工作归属标签（2026-11-18）。
 * 缺省开：worker 会话回读带 `chatWorkdir`，前端在输入框左下角常显只读标签；
 * 显式 false：服务端不下发该字段、policy 投影为 false，前端收起标签。
 */
export function chatProjectLabelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("CHAT_PROJECT_LABEL", env);
}

/**
 * 领域派活入口（2026-11-23 关闭领域派活入口·代码保留）。
 * 默认关：`delegate` 不暴露 `domain`，旧调用 / 旧会话带的 `domain` 也在执行层忽略，
 * 一律无领域直派 worker；开：恢复领域负责人（分管宰相）路径。manager 模块一行没删。
 */
export function domainDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("CHANCELLOR_DOMAIN_DISPATCH", env);
}

export function flagsPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_FLAGS_PATH?.trim() || ".data/agent-flags.json");
}

interface OverrideSnapshot {
	mtimeMs: number;
	size: number;
	map: Record<string, string>;
}
const overrideCache = new Map<string, OverrideSnapshot>();

function readOverrideMap(path: string): Record<string, string> {
	let mtimeMs = 0;
	let size = 0;
	try {
		const stat = statSync(path);
		mtimeMs = stat.mtimeMs;
		size = stat.size;
	} catch {
		/* 文件不存在：按空覆盖走；下次写入后会重新 stat */
	}
	const cached = overrideCache.get(path);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.map;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === "string") out[key] = value;
			}
			overrideCache.set(path, { mtimeMs, size, map: out });
			return out;
		}
	} catch {
		/* 文件不存在 / 坏 JSON：当作没有覆盖 */
	}
	const empty: Record<string, string> = {};
	overrideCache.set(path, { mtimeMs, size, map: empty });
	return empty;
}

function writeOverrideMap(path: string, map: Record<string, string>): void {
	atomicWrite(path, `${JSON.stringify(map, null, "\t")}\n`);
	overrideCache.delete(path);
}

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

/** 启动装载（index.ts 在 loadEnvFile / injectProviderKeys 之后调一次）：
 *  plugin 以 `.data/agent-flags.json` 为真源，不再把配置写回 env；
 *  core 仍把文件覆盖写进 env，作为历史部署路径。 */
export function loadFlagOverrides(env: NodeJS.ProcessEnv = process.env): number {
	refreshManifest(env);
	const map = readOverrideMap(flagsPath(env));
	let applied = 0;
	for (const [key, value] of Object.entries(map)) {
		const def = FLAG_BY_KEY.get(key);
		if (!def || !flagValueAllowed(def, value)) {
			console.warn(`[flags] 跳过无效开关：${key}=${value}`);
			continue;
		}
		if ((def.scope ?? "plugin") !== "core") continue;
		env[key] = value;
		applied += 1;
	}
	if (applied) console.log(`[flags] 已应用 ${applied} 项核心覆盖（${flagsPath(env)}）`);
	// 只有主进程启动装载才有"启动值"；测试传临时 env 时不记录，避免跨用例污染。
	if (env === process.env) captureBootValues(env);
	return applied;
}

/** 当前形态：plugin JSON / core env 现值（缺省回落 defaultValue）+ 是否被文件覆盖过 + 是否待重启
 *  + 父子门（effectiveValue / lockedBy / requires，2026-11-16）
 *  + 界面元数据（label / summary / group / type / choices / surface）与分层标签（scope）。 */
export function listFlags(env: NodeJS.ProcessEnv = process.env): {
	flags: {
		key: string;
		label: string;
		summary: string;
		group: string;
		type: FlagType;
		choices: FlagChoice[];
		offValue?: string;
		surface: FlagSurface;
		value: string;
		effectiveValue: string;
		lockedBy: string | null;
		lockedByLabel: string | null;
		requires: string[];
		scope: FlagScope;
		defaultValue: string;
		hot: boolean;
		overridden: boolean;
		pendingRestart: boolean;
	}[];
	groups: FlagGroupDef[];
} {
	refreshManifest(env);
	const map = pluginStoreApplies(env) ? readOverrideMap(flagsPath(env)) : {};
	return {
		groups: FLAG_GROUPS,
		flags: FLAG_DEFS.map((def) => {
			const lockedBy = lockingFlag(def, env);
			const current = storedFlagValue(def, env);
			return {
				key: def.key,
				label: def.label || def.key,
				summary: def.summary || "",
				group: def.group || "",
				type: def.type || (def.values.length === 2 && def.values.includes("true") ? "boolean" : "enum"),
				choices: def.choices || [],
				...(def.offValue ? { offValue: def.offValue } : {}),
				surface: def.surface || "flags",
				value: current,
				effectiveValue: lockedBy ? "false" : effectiveFlagValue(def.key, env),
				lockedBy,
				lockedByLabel: lockedBy ? flagLabel(lockedBy) : null,
				requires: def.requires ?? [],
				scope: def.scope ?? "plugin",
				defaultValue: def.defaultValue,
				hot: def.hot,
				overridden: Boolean(map[def.key]),
				pendingRestart:
					env === process.env &&
					!def.hot &&
					bootCaptured &&
					current !== (bootValues.get(def.key) ?? def.defaultValue),
			};
		}),
	};
}

/** 界面写一个开关：校验 → 落盘；plugin 只写 JSON（运行时直读），core 仍同步写 env。 */
export function setFlag(
	key: string,
	value: string,
	env: NodeJS.ProcessEnv = process.env,
): { ok: true; hot: boolean } | { ok: false; status: 400 | 404; code?: "flag_locked"; message: string } {
	refreshManifest(env);
	const def = FLAG_BY_KEY.get(key);
	if (!def) return { ok: false, status: 404, message: `没有叫 ${key} 的开关` };
	// 父子门（2026-11-16 用户拍板）：父关着时子项只读，存储值保留。
	// 必须在落盘 / 写 env 之前拦——只在界面灰控件挡不住直接打 API。
	const lockedBy = lockingFlag(def, env);
	if (lockedBy) {
		return {
			ok: false,
			status: 400,
			code: "flag_locked",
			message: `「${flagLabel(lockedBy)}」关闭时，这个开关不能单独打开；先打开总闸，原设置会保留。`,
		};
	}
	const path = flagsPath(env);
	const scope = def.scope ?? "plugin";
	// 数值型开关的空值 = "回到默认"（2026-11-14 上下文压缩）：删掉覆盖行；core 再删 env，
	// 消费处下一次懒读就拿到"没设"，回落内核默认。枚举型开关没有"空"这一档，照旧拒收。
	if (value.trim() === "" && def.values.length === 0) {
		const map = readOverrideMap(path);
		if (Object.hasOwn(map, key)) {
			delete map[key];
			writeOverrideMap(path, map);
		}
		if (scope === "core") delete env[key];
		return { ok: true, hot: def.hot };
	}
	if (!flagValueAllowed(def, value)) {
		const allowed =
			def.values.length > 0
				? `：${def.values.join(" / ")}`
				: def.max !== undefined
					? `：${def.min ?? 1}–${def.max} 的整数`
					: `：≥${def.min ?? 1} 的整数`;
		return { ok: false, status: 400, message: `${key} 的取值只能是${allowed}` };
	}
	const map = readOverrideMap(path);
	map[key] = value;
	writeOverrideMap(path, map);
	if (scope === "core") env[key] = value;
	return { ok: true, hot: def.hot };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 前置连开 / 父项连带关（2026-11-25）
 *
 * 问题：父子门是非破坏性的（父关 → 子只读、存储值保留），所以界面点「开」一个被锁住的
 * 子项时，用户实际上要先把整条祖先链逐个打开；而关父项时，下游一片子项会静默失效。
 * 这一层只做「离线拼图 + 按拼图写值」，不改既有 PUT 语义：
 *  - GET  .../:key/enable-plan  只读：算出缺哪些祖先、写什么值、会顺带复活谁。
 *  - POST .../:key/enable       按同一套推演在服务端重算，再按拓扑序逐键 setFlag。
 *  - GET  .../:key/disable-plan 只读：算关值 + 会被连带关掉的后代。
 *  - POST .../:key/disable      写关值（只动父，子项存储值一个字不动）。
 *
 * 回滚门：`FLAG_CASCADE_ENABLE=false|0|off` → 四条端点整组不挂（404），回到原来的一键 PUT。
 *
 * 与旧 PUT 的差异（故意保留旧行为，不改一个字节）：未知键在 PUT 走 setFlag 的 404 分支、
 * 响应体是 `{error:"bad_request"}`；这四条新端点统一 `{error:"flag_not_found"}`。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 级联层开关：缺省开；false / 0 / off 算关（与父子门同一份判据）。 */
export function flagCascadeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.FLAG_CASCADE_ENABLE ?? "").trim().toLowerCase();
	return !(raw === "false" || raw === "0" || raw === "off");
}

interface CascadeNode {
	key: string;
	label: string;
	/** 计划写入值；null = 需要用户挑一档 */
	value: string | null;
	hot: boolean;
	/** true = 自身存储值就是关值，必须写；false = 只是被父锁着，父开了它自己就恢复 */
	willWrite: boolean;
}

interface CascadeNeed {
	key: string;
	label: string;
	choices: FlagChoice[];
}

interface CascadeRevive {
	key: string;
	label: string;
	value: string;
	hot: boolean;
	/** 恒 false：复活是父开了之后自己恢复，本轮不写它自己的值（与 missing 的 willWrite 区分）。 */
	willWrite: false;
}

/** 开关的「关」是哪一档：显式 offValue 优先；否则 values 里 true / false 齐全的布尔键按 false 算；
 *  其余（纯枚举 / 数值）没有关档 → null（不可连带关，也不可被计划打开）。 */
function offValueOf(def: FlagDef): string | null {
	if (def.offValue !== undefined) return def.offValue;
	if (def.values.includes("true") && def.values.includes("false")) return "false";
	return null;
}

/** 某个存储值是不是这个开关的关值。offValue 不一定在 false/0/off 之列
 *  （AGENT_TOOL_POLICY 的关是 full），所以按各自清单判，不能只看 flagIsOff。 */
function isOffValueOf(def: FlagDef, value: string): boolean {
	const off = offValueOf(def);
	if (off !== null && value === off) return true;
	return flagIsOff(value);
}

/** 当前「真的关着」：存储值本身就是这个开关的关值，或被任一父锁住（effective 已是 false）。
 *  级联层的「现在关不关」统一走这里，不要再各处手写 `flagIsOff(effectiveFlagValue(...))`——
 *  那种写法对 `offValue="full"` 这类键（AGENT_TOOL_POLICY）会把「关」认成「开」。 */
function isEffectivelyOff(def: FlagDef, env: NodeJS.ProcessEnv = process.env): boolean {
	return isOffValueOf(def, effectiveFlagValue(def.key, env));
}

/** 控件形态：清单写了 type 就用它；没写时按 values 推断（与 listFlags 的口径一致）。 */
function flagKindOf(def: FlagDef): FlagType {
	if (def.type) return def.type;
	return def.values.length === 2 && def.values.includes("true") && def.values.includes("false")
		? "boolean"
		: "enum";
}

/** 打开这个键时要写什么值：布尔键一律 true；枚举 / 数值键优先保留自己的存储值，
 *  存储值本身是关的才回落到默认值；默认值也是关的（或没有可写值）→ null，交给用户选。 */
function plannedValueOf(def: FlagDef, stored: string): string | null {
	if (flagKindOf(def) === "boolean" && flagValueAllowed(def, "true")) return "true";
	if (!isOffValueOf(def, stored)) return stored;
	const fallback = def.defaultValue;
	if (fallback !== "" && !isOffValueOf(def, fallback) && flagValueAllowed(def, fallback)) return fallback;
	return null;
}

/** 档位列表：清单里的 choices 优先，values 里没写中文名的补一条 value=label 的兜底项。 */
function cascadeChoices(def: FlagDef): FlagChoice[] {
	const declared = def.choices ?? [];
	const covered = new Set(declared.map((choice) => choice.value));
	const out: FlagChoice[] = [...declared];
	for (const value of def.values) if (!covered.has(value)) out.push({ value, label: value });
	return out;
}

/** 祖先链的拓扑序（最深祖先在前、父在子前），不含 key 自身。图已在装载时校验无环。 */
function collectAncestorKeys(key: string): string[] {
	const ordered: string[] = [];
	const visited = new Set<string>();
	const walk = (current: string): void => {
		const def = FLAG_BY_KEY.get(current);
		if (!def) return;
		for (const req of def.requires ?? []) walk(req);
		if (current === key || visited.has(current)) return;
		visited.add(current);
		ordered.push(current);
	};
	walk(key);
	return ordered;
}

/** 某键的 requires 闭包里是否含 target（用来找「父项连带关」的后代）。 */
function requiresClosureContains(key: string, target: string): boolean {
	const visited = new Set<string>();
	const walk = (current: string): boolean => {
		const def = FLAG_BY_KEY.get(current);
		if (!def || visited.has(current)) return false;
		visited.add(current);
		for (const req of def.requires ?? []) {
			if (req === target) return true;
			if (walk(req)) return true;
		}
		return false;
	};
	return walk(key);
}

/** 打开 key 时要补开哪些祖先：只收当前 effective 为关的（含被更上层锁住的）。
 *  willWrite 只看自己的存储值——被父锁住但自己本来开着的，父一开就恢复，不用写。 */
function collectMissing(key: string, env: NodeJS.ProcessEnv): CascadeNode[] {
	const out: CascadeNode[] = [];
	for (const ancestor of collectAncestorKeys(key)) {
		const def = FLAG_BY_KEY.get(ancestor);
		if (!def) continue;
		if (!isEffectivelyOff(def, env)) continue;
		const stored = storedFlagValue(def, env);
		out.push({
			key: ancestor,
			label: flagLabel(ancestor),
			value: plannedValueOf(def, stored),
			hot: def.hot,
			willWrite: isOffValueOf(def, stored),
		});
	}
	return out;
}

/** 「计划写完」之后，候选是否真的会生效开。
 *  所有父都按**写后状态**递归推演：planKeys 内按计划值，planKeys 外按存储值 + 它自己的父
 *  （存储值是开、只是被更上层锁住的中间父，父一开就跟着恢复，它的孩子也会恢复）。
 *  stack 只表示「当前这条递归路径」，返回前必须删掉：DAG 里多个父共享同一个祖先，
 *  上一支残留的标记会把下一支的共享祖先误判成关。 */
function simulateOn(
	candidate: string,
	planKeys: Set<string>,
	env: NodeJS.ProcessEnv,
	stack = new Set<string>(),
): boolean {
	const def = FLAG_BY_KEY.get(candidate);
	if (!def) return false;
	if (stack.has(candidate)) return false; // 图已校验无环，这层只是兜底
	stack.add(candidate);
	const stored = storedFlagValue(def, env);
	const selfOn = planKeys.has(candidate)
		? (() => {
				const planned = plannedValueOf(def, stored);
				return planned === null || !isOffValueOf(def, planned); // 待用户选值 → 按会在
			})()
		: !isOffValueOf(def, stored);
	if (!selfOn) {
		stack.delete(candidate);
		return false;
	}
	for (const req of def.requires ?? []) {
		if (!simulateOn(req, planKeys, env, stack)) {
			stack.delete(candidate);
			return false;
		}
	}
	stack.delete(candidate); // 关键：回溯，DAG 共享祖先不能被上一支污染
	return true;
}

/** 计划写完后会「顺带复活」的开关：现在 effective 关、自己存储值不是关、
 *  且按计划写完组合后能开；排除计划内的键与目标自身。按 FLAG_DEFS 顺序。 */
function collectRevive(
	excludeKey: string,
	planKeys: Set<string>,
	env: NodeJS.ProcessEnv,
): CascadeRevive[] {
	const out: CascadeRevive[] = [];
	for (const def of FLAG_DEFS) {
		if (def.key === excludeKey || planKeys.has(def.key)) continue;
		const stored = storedFlagValue(def, env);
		if (isOffValueOf(def, stored)) continue;
		if (!isEffectivelyOff(def, env)) continue;
		if (!simulateOn(def.key, planKeys, env)) continue;
		out.push({
			key: def.key,
			label: flagLabel(def.key),
			value: plannedValueOf(def, stored) ?? stored,
			hot: def.hot,
			willWrite: false,
		});
	}
	return out;
}

/** 关 key 会连带失效的后代：requires 闭包含 key、当前 effective 为开。
 *  已被别的父关掉的不算（它们现在就是关的，本来就不在受影响范围里）。 */
function collectAffected(key: string, env: NodeJS.ProcessEnv): { key: string; label: string }[] {
	const out: { key: string; label: string }[] = [];
	for (const def of FLAG_DEFS) {
		if (def.key === key) continue;
		if (!requiresClosureContains(def.key, key)) continue;
		if (isEffectivelyOff(def, env)) continue;
		out.push({ key: def.key, label: flagLabel(def.key) });
	}
	return out;
}

/** 离线拼图：只读，不写任何值。POST 也重新调它，不信任客户端拿着的旧 plan。 */
function deriveEnablePlan(
	key: string,
	env: NodeJS.ProcessEnv = process.env,
): {
	key: string;
	label: string;
	missing: CascadeNode[];
	revive: CascadeRevive[];
	needsValue: CascadeNeed[];
	target: CascadeNode;
} {
	refreshManifest(env);
	const def = FLAG_BY_KEY.get(key);
	const stored = def ? storedFlagValue(def, env) : "";
	const missing = collectMissing(key, env);
	const needsValue: CascadeNeed[] = [];
	for (const node of missing) {
		if (!node.willWrite || node.value !== null) continue;
		const nodeDef = FLAG_BY_KEY.get(node.key);
		if (nodeDef) needsValue.push({ key: node.key, label: node.label, choices: cascadeChoices(nodeDef) });
	}
	const target: CascadeNode = {
		key,
		label: flagLabel(key),
		value: def ? plannedValueOf(def, stored) : null,
		hot: def?.hot ?? false,
		willWrite: def ? isOffValueOf(def, stored) : false,
	};
	if (def && target.willWrite && target.value === null) {
		needsValue.push({ key, label: target.label, choices: cascadeChoices(def) });
	}
	const planKeys = new Set<string>([...missing.map((node) => node.key), key]);
	return {
		key,
		label: target.label,
		missing,
		revive: collectRevive(key, planKeys, env),
		needsValue,
		target,
	};
}

export function mountFlags(
	app: Hono,
	deps: {
		enabled?: boolean;
		/** 开关写成功后的回调（2026-11-13）：自动归档调度器靠它动态开停定时器，否则运行中打开开关要等重启。 */
		onChange?: (key: string, value: string) => void;
	} = {},
): void {
	if (!(deps.enabled ?? flagsUiEnabled())) return;

	app.get("/api/v1/agent/flags", (c) => c.json(listFlags()));

	app.put("/api/v1/agent/flags/:key", async (c) => {
		const key = c.req.param("key");
		const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
		if (typeof body?.value !== "string") {
			return c.json({ error: "bad_request", message: "value 必须是字符串" }, 400);
		}
		const result = setFlag(key, body.value);
		if (!result.ok) {
			return c.json({ error: result.code ?? "bad_request", message: result.message }, result.status);
		}
		deps.onChange?.(key, body.value);
		return c.json({ ok: true, key, value: body.value, hot: result.hot });
	});

	// 级联层（前置连开 / 父项连带关）：门关着就整组不挂，前端继续用上面的 PUT。
	if (!flagCascadeEnabled()) return;

	app.get("/api/v1/agent/flags/:key/enable-plan", (c) => {
		const key = c.req.param("key");
		refreshManifest();
		if (!FLAG_BY_KEY.has(key)) return c.json({ error: "flag_not_found" }, 404);
		return c.json(deriveEnablePlan(key));
	});

	app.post("/api/v1/agent/flags/:key/enable", async (c) => {
		const key = c.req.param("key");
		const body = (await c.req.json().catch(() => null)) as {
			confirm?: unknown;
			values?: unknown;
		} | null;
		if (body?.confirm !== true) return c.json({ error: "needs_confirm" }, 400);
		refreshManifest();
		if (!FLAG_BY_KEY.has(key)) return c.json({ error: "flag_not_found" }, 404);

		// 不信任客户端手里的旧 plan：每次按当前状态重算。
		const plan = deriveEnablePlan(key);
		const rawValues =
			body.values && typeof body.values === "object" && !Array.isArray(body.values)
				? (body.values as Record<string, unknown>)
				: {};
		const resolved = new Map<string, string>();
		const unresolved: CascadeNeed[] = [];
		for (const need of plan.needsValue) {
			const raw = rawValues[need.key];
			const needDef = FLAG_BY_KEY.get(need.key);
			// 取值必须合法，且必须真的能把它打开（挑「关」档等于没开）。
			if (
				typeof raw !== "string" ||
				!needDef ||
				!flagValueAllowed(needDef, raw) ||
				isOffValueOf(needDef, raw)
			) {
				unresolved.push(need);
				continue;
			}
			resolved.set(need.key, raw);
		}
		if (unresolved.length > 0) return c.json({ error: "needs_value", keys: unresolved }, 400);

		// 写入清单：missing 按拓扑序在前，target 最后；只写 willWrite 的键。
		const writes: { key: string; value: string }[] = [];
		for (const node of plan.missing) {
			if (!node.willWrite) continue;
			const value = resolved.get(node.key) ?? node.value;
			if (value === null) {
				const nodeDef = FLAG_BY_KEY.get(node.key);
				unresolved.push({
					key: node.key,
					label: node.label,
					choices: nodeDef ? cascadeChoices(nodeDef) : [],
				});
				continue;
			}
			writes.push({ key: node.key, value });
		}
		if (plan.target.willWrite) {
			const value = resolved.get(key) ?? plan.target.value;
			if (value === null) {
				const targetDef = FLAG_BY_KEY.get(key);
				unresolved.push({
					key,
					label: plan.target.label,
					choices: targetDef ? cascadeChoices(targetDef) : [],
				});
			} else {
				writes.push({ key, value });
			}
		}
		if (unresolved.length > 0) return c.json({ error: "needs_value", keys: unresolved }, 400);

		if (writes.length === 0) {
			return c.json({ ok: true, changed: [], revived: [], alreadyOn: true });
		}

		// 复活判定要「写前关、写后开」两侧：先按写前状态取候选（写后状态由计划推演保证会开）。
		const planKeys = new Set<string>([...plan.missing.map((node) => node.key), key]);
		const preCandidates = collectRevive(key, planKeys, process.env);

		const changed: { key: string; value: string; hot: boolean }[] = [];
		for (const write of writes) {
			const result = setFlag(write.key, write.value);
			if (!result.ok) {
				// 中途失败：如实报出已成功写入的前缀，不假装整体成功。
				return c.json({ error: "partial", changed }, 500);
			}
			changed.push({ key: write.key, value: write.value, hot: result.hot });
			deps.onChange?.(write.key, write.value);
		}
		const changedKeys = new Set(changed.map((item) => item.key));
		const revived = preCandidates
			.filter((candidate) => !changedKeys.has(candidate.key))
			.filter((candidate) => {
				const candidateDef = FLAG_BY_KEY.get(candidate.key);
				return candidateDef ? !isEffectivelyOff(candidateDef, process.env) : false;
			})
			.map((candidate) => ({
				key: candidate.key,
				value: candidate.value,
				hot: candidate.hot,
				willWrite: candidate.willWrite,
			}));
		return c.json({ ok: true, changed, revived });
	});

	app.get("/api/v1/agent/flags/:key/disable-plan", (c) => {
		const key = c.req.param("key");
		refreshManifest();
		const def = FLAG_BY_KEY.get(key);
		if (!def) return c.json({ error: "flag_not_found" }, 404);
		const offValue = offValueOf(def);
		if (offValue === null) {
			// 没有「关」这一档（纯枚举 / 数值）：200 而不是 400，前端好渲染成「不可关」。
			return c.json({ key, label: flagLabel(key), disableable: false, affected: [] });
		}
		return c.json({
			key,
			label: flagLabel(key),
			disableable: true,
			offValue,
			affected: collectAffected(key, process.env),
		});
	});

	app.post("/api/v1/agent/flags/:key/disable", async (c) => {
		const key = c.req.param("key");
		const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
		if (body?.confirm !== true) return c.json({ error: "needs_confirm" }, 400);
		refreshManifest();
		const def = FLAG_BY_KEY.get(key);
		if (!def) return c.json({ error: "flag_not_found" }, 404);
		const offValue = offValueOf(def);
		if (offValue === null) return c.json({ error: "flag_not_disableable" }, 400);
		// 已经被父锁着（或本来就是关的）：不再写值，子项也无所谓连带。
		// 判据按各自清单的关档算：AGENT_TOOL_POLICY 存储 "full"（界面显示关）也算关，不能重写同一个值。
		if (isEffectivelyOff(def, process.env)) {
			return c.json({ ok: true, changed: [], affected: [], alreadyOff: true });
		}
		const affected = collectAffected(key, process.env);
		const result = setFlag(key, offValue);
		if (!result.ok) return c.json({ error: "partial", changed: [] }, 500);
		deps.onChange?.(key, offValue);
		return c.json({
			ok: true,
			changed: [{ key, value: offValue, hot: result.hot }],
			affected,
		});
	});
}
