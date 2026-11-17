import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { flagEnabled } from "./flags.ts";

/**
 * 技能启停位（2026-11-09 用户拍板：技能库默认**全关**，界面上逐条/批量开关）。
 *
 * 存储：`.data/skills-state.json`
 * ```
 * {
 *   "enabled": { "<skill-name>": true },
 *   "partners": { "<partner-id>": { "enabled": { "<skill-name>": true } } }
 * }
 * ```
 * **名单外一律视为关**——文件里没有的名字不进索引、`skill` 工具也取不到（默认全关的口径）。
 * 服务端管理面写它；agent 侧注入（assist.ts 的 skillStore filter）按它过滤。
 *
 * 2026-11-15（个人技能可见性）：加了按执事覆盖层。语义是**全局优先**：
 *   - 全局开 → 所有人可见，个人页锁死，不能按人关；
 *   - 全局关 + 该人覆盖开 → 只对这个人的会话可见；
 *   - 全局关 + 无覆盖 → 不可见。
 * 覆盖层只存"全局没开、但这个人要开"的技能；全局开时覆盖位不参与判定。
 *
 * 刻意不做：不把启停位写进技能目录本身（`.agents/skills` 可能是别的工具的家，不掺文件）；
 * 不把按人状态拆成独立文件（一份状态、一次原子写，避免两个文件打架）。
 * 回滚：删文件 = 全关（默认态）；要回到"全开不过滤"的旧行为，`SKILL_STATE=false` 一行。
 */
export interface SkillState {
	isEnabled(name: string): boolean;
	setEnabled(name: string, enabled: boolean): void;
	setAll(enabled: boolean, names: string[]): void;
	/** 该执事实效可见：全局开 || 该人覆盖开 */
	isEnabledFor(partnerId: string, name: string): boolean;
	/** 全局没开、但该人单独开 */
	isOverridden(partnerId: string, name: string): boolean;
	/** 全局开时锁死（no-op）；否则写/删该人的覆盖位 */
	setEnabledFor(partnerId: string, name: string, enabled: boolean): void;
	/** 该人单独开的技能名（不含全局开的） */
	partnerNames(partnerId: string): string[];
	path(): string;
}

interface SkillStateFile {
	enabled: Record<string, boolean>;
	partners: Record<string, Record<string, boolean>>;
}

let singleton: SkillState | null = null;

export function skillStatePath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_SKILLS_STATE_PATH?.trim() || ".data/skills-state.json");
}

/** 旧的"全部进索引"行为逃生门（正常情况不用） */
export function skillStateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("SKILL_STATE", env);
}

function readBoolMap(value: unknown): Record<string, boolean> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, boolean> = {};
	for (const [name, on] of Object.entries(value as Record<string, unknown>)) {
		if (typeof on === "boolean") out[name] = on;
	}
	return out;
}

function readState(path: string): SkillStateFile {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		const obj = parsed as { enabled?: unknown; partners?: unknown } | null;
		const partners: Record<string, Record<string, boolean>> = {};
		if (obj?.partners && typeof obj.partners === "object" && !Array.isArray(obj.partners)) {
			for (const [partnerId, value] of Object.entries(obj.partners as Record<string, unknown>)) {
				// 规范形状是 partners.<id>.enabled.<name>；同时兼容早先误写成的扁平形状
				// partners.<id>.<name>，否则已点过的开关会在重读时全部丢掉。
				const raw = value as Record<string, unknown> | null;
				const source =
					raw && typeof raw === "object" && "enabled" in raw ? raw.enabled : raw;
				const map = readBoolMap(source);
				const on = Object.keys(map).filter((name) => map[name] === true);
				// 只留"开着"的名字；空对象不落盘
				if (on.length > 0) {
					partners[partnerId] = Object.fromEntries(on.map((name) => [name, true]));
				}
			}
		}
		return { enabled: readBoolMap(obj?.enabled), partners };
	} catch {
		/* 文件不存在 / 坏 JSON：全部视为关（默认态） */
	}
	return { enabled: {}, partners: {} };
}

function writeState(path: string, state: SkillStateFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	// 内部用扁平 map 方便判定；落盘按约定收成 partners.<id>.enabled，别把内部形状泄漏到文件。
	const partnersOut: Record<string, { enabled: Record<string, boolean> }> = {};
	for (const [partnerId, map] of Object.entries(state.partners)) {
		const on = Object.keys(map).filter((name) => map[name] === true);
		if (on.length > 0) partnersOut[partnerId] = { enabled: Object.fromEntries(on.map((name) => [name, true])) };
	}
	const payload: { enabled: Record<string, boolean>; partners?: Record<string, { enabled: Record<string, boolean> }> } = {
		enabled: state.enabled,
	};
	// 没有按人覆盖时保持旧形状（老客户端/老备份少一个字段）
	if (Object.keys(partnersOut).length > 0) payload.partners = partnersOut;
	try {
		writeFileSync(temp, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export function createSkillState(path: string): SkillState {
	return {
		isEnabled(name) {
			return readState(path).enabled[name] === true;
		},
		setEnabled(name, enabled) {
			const state = readState(path);
			if (enabled) state.enabled[name] = true;
			else delete state.enabled[name]; // 关 = 从名单里拿掉，文件只存"开着"的
			writeState(path, state);
		},
		setAll(enabled, names) {
			const state = readState(path);
			if (enabled) {
				for (const name of names) state.enabled[name] = true;
			} else {
				for (const name of names) delete state.enabled[name];
			}
			writeState(path, state);
		},
		isEnabledFor(partnerId, name) {
			const state = readState(path);
			return state.enabled[name] === true || state.partners[partnerId]?.[name] === true;
		},
		isOverridden(partnerId, name) {
			const state = readState(path);
			return state.enabled[name] !== true && state.partners[partnerId]?.[name] === true;
		},
		setEnabledFor(partnerId, name, enabled) {
			const state = readState(path);
			// 全局开 = 所有人都有，个人页锁死；这里静默 no-op，防绕过
			if (state.enabled[name] === true) return;
			if (enabled) {
				state.partners[partnerId] = { ...(state.partners[partnerId] ?? {}), [name]: true };
			} else {
				const map = state.partners[partnerId];
				if (map) {
					delete map[name];
					if (Object.keys(map).length === 0) delete state.partners[partnerId];
				}
			}
			writeState(path, state);
		},
		partnerNames(partnerId) {
			const state = readState(path);
			return Object.keys(state.partners[partnerId] ?? {}).filter(
				(name) => state.partners[partnerId]?.[name] === true,
			);
		},
		path: () => path,
	};
}

/** 懒建单例：路径在第一次调用时才解析（.env 已由 index.ts 主体装好） */
export function getSkillState(): SkillState {
	if (!singleton) singleton = createSkillState(skillStatePath());
	return singleton;
}
