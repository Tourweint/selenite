import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 技能启停位（2026-11-09 用户拍板：技能库默认**全关**，界面上逐条/批量开关）。
 *
 * 存储：`.data/skills-state.json` = `{ "enabled": { "<skill-name>": true } }`。
 * **名单外一律视为关**——文件里没有的名字不进索引、`skill` 工具也取不到（默认全关的口径）。
 * 服务端管理面写它；agent 侧注入（assist.ts 的 skillStore filter）按它过滤。
 *
 * 刻意不做：不把启停位写进技能目录本身（`.agents/skills` 可能是别的工具的家，不掺文件）；
 * 不做按执事的独立启停（技能索引本来就是全局一份，D5）。
 * 回滚：删文件 = 全关（默认态）；要回到"全开不过滤"的旧行为，`SKILL_STATE=false` 一行。
 */
export interface SkillState {
	isEnabled(name: string): boolean;
	setEnabled(name: string, enabled: boolean): void;
	setAll(enabled: boolean, names: string[]): void;
	path(): string;
}

let singleton: SkillState | null = null;

export function skillStatePath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_SKILLS_STATE_PATH?.trim() || ".data/skills-state.json");
}

/** 旧的"全部进索引"行为逃生门（正常情况不用） */
export function skillStateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.SKILL_STATE ?? "").trim().toLowerCase() !== "false";
}

function readMap(path: string): Record<string, boolean> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		const enabled = (parsed as { enabled?: unknown })?.enabled;
		if (enabled && typeof enabled === "object" && !Array.isArray(enabled)) {
			const out: Record<string, boolean> = {};
			for (const [name, on] of Object.entries(enabled as Record<string, unknown>)) {
				if (typeof on === "boolean") out[name] = on;
			}
			return out;
		}
	} catch {
		/* 文件不存在 / 坏 JSON：全部视为关（默认态） */
	}
	return {};
}

function writeMap(path: string, enabled: Record<string, boolean>): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, `${JSON.stringify({ enabled }, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export function createSkillState(path: string): SkillState {
	return {
		isEnabled(name) {
			return readMap(path)[name] === true;
		},
		setEnabled(name, enabled) {
			const map = readMap(path);
			if (enabled) map[name] = true;
			else delete map[name]; // 关 = 从名单里拿掉，文件只存"开着"的
			writeMap(path, map);
		},
		setAll(enabled, names) {
			const map = readMap(path);
			if (enabled) {
				for (const name of names) map[name] = true;
			} else {
				for (const name of names) delete map[name];
			}
			writeMap(path, map);
		},
		path: () => path,
	};
}

/** 懒建单例：路径在第一次调用时才解析（.env 已由 index.ts 主体装好） */
export function getSkillState(): SkillState {
	if (!singleton) singleton = createSkillState(skillStatePath());
	return singleton;
}
