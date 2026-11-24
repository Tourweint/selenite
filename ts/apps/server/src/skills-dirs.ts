import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 自加技能库位置（2026-11-23 用户口径：技能库能添加多个位置，选不同的位置）。
 *
 * 存储：`.data/skills-dirs.json`
 * ```
 * {
 *   "dirs": [ { "path": "D:\\shared-skills", "label": "团队手册" } ],
 *   "excluded": ["C:\\Users\\me\\.agents\\skills"]
 * }
 * ```
 * - `dirs` = 自加位置（可写、按登记顺序排）。
 * - `excluded` = 从读取链里移除的来源（2026-11-24）：`.agents/skills` / 内置目录这类
 *   **不是登记进来的**来源，没法靠删 `dirs` 行移除，就记在这里；读取链按路径跳过。
 *   主目录 / `AGENT_SKILLS_DIR` 是新建技能的落点，**不允许**进这张名单。
 *
 * `AGENT_SKILLS_DIRS_PATH` 可换路径（单测 / 探针指临时目录）。
 *
 * 口径：
 * - 只登记 / 排除，不碰目录里的文件；移除位置只删这一行、移除来源只加一行。
 * - 登记顺序 = 读取链里的优先级（主目录之后，`.agents` 之前，先到先得）。
 * - 目录必须由调用方先建好（这里不替用户 mkdir，避免打错路径生成一个空目录）。
 * - 重新登记同一个路径（`addCustomSkillDir`）会顺手把它从 `excluded` 里摘掉，
 *   所以「移除过再添加回来」不需要额外的恢复动作。
 * - 回滚开关 `SKILLS_EXTRA_DIRS=false/0/off`：读取链忽略自加位置与排除名单，管理端点 404；
 *   已存的 dirs.json 保留，重开即恢复。
 *
 * 刻意不做：不排序（顺序靠移除后重加维护）、不递归子目录（与 `scanSkillDir` 同一层）。
 */

export interface CustomSkillDir {
	/** 绝对路径（登记时已 resolve） */
	path: string;
	/** 界面显示名；不填 = 取目录名 */
	label?: string;
}

/** 最多登记多少个自加位置（防止一次塞进一整个盘符目录树） */
export const SKILL_DIRS_MAX = 20;

/** 回滚开关：显式 false / 0 / off = 关 */
export function extraSkillDirsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.SKILLS_EXTRA_DIRS ?? "").trim().toLowerCase();
	return !(raw === "false" || raw === "0" || raw === "off");
}

export function skillDirsConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_SKILLS_DIRS_PATH?.trim() || ".data/skills-dirs.json");
}

/** 路径去重键：Windows 大小写不敏感 */
export function skillDirKey(dir: string): string {
	const absolute = resolve(dir);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function labelOf(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const label = value.trim().slice(0, 40);
	return label || undefined;
}

interface SkillDirsConfig {
	dirs: CustomSkillDir[];
	/** 从读取链里移除的来源（绝对路径，按 skillDirKey 去重） */
	excluded: string[];
}

/** 读整份登记表；文件不存在 / 坏 JSON 一律按空表（与启停位同一条兜底纪律）。 */
function readConfig(env: NodeJS.ProcessEnv): SkillDirsConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(skillDirsConfigPath(env), "utf8"));
	} catch {
		return { dirs: [], excluded: [] };
	}
	// 旧格式是裸数组（只有 dirs），继续认
	const container = Array.isArray(parsed) ? null : (parsed as { dirs?: unknown; excluded?: unknown } | null);
	const rawDirs = Array.isArray(parsed) ? parsed : container?.dirs;
	const rawExcluded = container?.excluded;
	const dirs: CustomSkillDir[] = [];
	const seen = new Set<string>();
	if (Array.isArray(rawDirs)) {
		for (const item of rawDirs) {
			const value = typeof item === "string" ? { path: item } : item;
			const path = (value as { path?: unknown } | null)?.path;
			if (typeof path !== "string" || !path.trim()) continue;
			const absolute = resolve(path.trim());
			const key = skillDirKey(absolute);
			if (seen.has(key)) continue;
			seen.add(key);
			const label = labelOf((value as { label?: unknown } | null)?.label);
			dirs.push(label ? { path: absolute, label } : { path: absolute });
		}
	}
	const excluded: string[] = [];
	const excludedSeen = new Set<string>();
	if (Array.isArray(rawExcluded)) {
		for (const item of rawExcluded) {
			if (typeof item !== "string" || !item.trim()) continue;
			const absolute = resolve(item.trim());
			const key = skillDirKey(absolute);
			if (excludedSeen.has(key)) continue;
			excludedSeen.add(key);
			excluded.push(absolute);
		}
	}
	return { dirs, excluded };
}

function writeConfig(config: SkillDirsConfig, env: NodeJS.ProcessEnv): void {
	const path = skillDirsConfigPath(env);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	const payload: { dirs: unknown[]; excluded?: string[] } = {
		dirs: config.dirs.map((entry) => (entry.label ? { path: entry.path, label: entry.label } : { path: entry.path })),
	};
	// 空名单不落字段：文件保持"只有自加位置"的最小形态
	if (config.excluded.length) payload.excluded = config.excluded;
	try {
		writeFileSync(temp, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** 自加位置登记表（不含排除名单） */
export function readCustomSkillDirs(env: NodeJS.ProcessEnv = process.env): CustomSkillDir[] {
	return readConfig(env).dirs;
}

/** 被移除的来源（2026-11-24）：读取链按路径跳过这些目录 */
export function readExcludedSkillDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	return readConfig(env).excluded;
}

/**
 * 登记一个位置；已存在（同路径）则原样返回，不重复写。
 * 同一路径之前被排除过（excluded）也一并解排除——「移除过再加回来」就是这条路径。
 */
export function addCustomSkillDir(
	dir: string,
	label?: string,
	env: NodeJS.ProcessEnv = process.env,
): CustomSkillDir[] {
	const absolute = resolve(dir.trim());
	const config = readConfig(env);
	const key = skillDirKey(absolute);
	const excluded = config.excluded.filter((entry) => skillDirKey(entry) !== key);
	let changed = excluded.length !== config.excluded.length;
	if (!config.dirs.some((entry) => skillDirKey(entry.path) === key)) {
		const cleanLabel = labelOf(label);
		config.dirs.push(cleanLabel ? { path: absolute, label: cleanLabel } : { path: absolute });
		changed = true;
	}
	if (changed) writeConfig({ dirs: config.dirs, excluded }, env);
	return config.dirs;
}

/** 移除登记；返回是否真的删掉了一行。磁盘文件一个不动。 */
export function removeCustomSkillDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const key = skillDirKey(dir.trim());
	const config = readConfig(env);
	const next = config.dirs.filter((entry) => skillDirKey(entry.path) !== key);
	if (next.length === config.dirs.length) return false;
	writeConfig({ dirs: next, excluded: config.excluded }, env);
	return true;
}

/**
 * 移除一个**不是自加登记**的来源（`.agents/skills` / 内置目录）：记进排除名单，读取链跳过。
 * 返回是否新增了一条（已经在名单里 = false）。磁盘文件一个不动；重新 addCustomSkillDir 即恢复。
 */
export function excludeSkillDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const absolute = resolve(dir.trim());
	const key = skillDirKey(absolute);
	const config = readConfig(env);
	if (config.excluded.some((entry) => skillDirKey(entry) === key)) return false;
	config.excluded.push(absolute);
	writeConfig(config, env);
	return true;
}
