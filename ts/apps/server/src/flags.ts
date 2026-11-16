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

/**
 * 对话历史分页开关（2026-11-13）。
 * 缺省开；显式 false/0/off 才关（与其它"新能力默认开"的开关同口径）。
 */
export function chatHistoryPagingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("CHAT_HISTORY_PAGING_ENABLED", env);
}

export function flagsUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AGENT_FLAGS_UI ?? "").trim().toLowerCase() !== "false";
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
}
