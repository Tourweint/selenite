/**
 * 员工人格模块（2026-11-14 方案 §三–§五，批1）
 *
 * 一个员工 = **必选核心（不可关）** + **可开关模块** + **预设**。
 * 这一层只做"开关怎么算、内容怎么读写、静态模块怎么渲染"三件事，不碰 HTTP（companion-api）
 * 也不碰每轮 system 的装配（agent/partner-context）：
 *
 *   - 开关：`effectivePersonaModules` = 预设默认 + 行上显式值的合并；`personaModuleOn` 在
 *     `PARTNER_PERSONA_MODULES=false` 时一律 true（= 旧行为，谁也不裁）。
 *   - 内容：伙伴家目录 `persona/style.json` / `values.json` / `scenario.json`，字段级 JSON。
 *     **SOUL.md 不动**——身份节仍在 SOUL；这里只装"口吻 / 里子 / 处境"。
 *   - 渲染：固定顺序 口吻 → 里子 → 处境，空模块 / 空字段跳过；整段拼进 instructions
 *     （`renderPartnerIdentity` 在 SOUL 之后调用），会话级稳定，利于缓存前缀。
 *
 * 必选核心（身份节 / 主人数据红线 / 教诲通道）不在本模块的开关范围内：
 * 红线由 `partner-context.ts` 单独强制（`discipline` 关掉时只留红线段），SOUL 与
 * remember / preference 通道都不经过这里（2026-11-14 批1 口径）。
 */

import {
	PARTNER_PERSONA_LIMITS,
	PartnerPersonaScenarioSchema,
	PartnerPersonaStyleSchema,
	PartnerPersonaValuesSchema,
	PartnerPersonaModuleIds,
	type PartnerPersonaContents,
	type PartnerPersonaModule,
	type PartnerPersonaPreset,
	type PartnerPersonaScenario,
	type PartnerPersonaStyle,
	type PartnerPersonaValues,
} from "@lifediary/shared";
import { join } from "node:path";
import { flagEnabled } from "./flags.ts";

/** 回滚开关：默认开；`PARTNER_PERSONA_MODULES=false` → 不读开关、不注静态模块、端点回默认值。 */
export function personaModulesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("PARTNER_PERSONA_MODULES", env);
}

/**
 * 预设 → 模块开关（2026-11-14 任务书"预设映射"，改动同步 `docs/变更记录/`）。
 *
 * work（建档默认）：只留岗位相关；口吻 / 里子 / 处境关——"干活执事没有情感是设定本身"。
 * companion：口吻 / 里子 / 处境 + 目标开；岗位类（契约 / 纪律）关，
 *   **主人数据红线照旧强制注入**（不在开关范围内）。impression / mood / heart 在这里置 true，
 *   但批1 还不注入（批2 生效）。
 * allrounder / apprentice：2026-11-15 人设页打磨新增（全才 = 岗位+内心全开；学徒 = 学习观察型）。
 * custom：全关起步，用户自己开；服务端只强制红线。
 * 保存时按最终开关表 `derivePresetFromModules` 推导预设名，预设名与表永远一致。
 */
export const PERSONA_PRESETS: Record<PartnerPersonaPreset, Record<PartnerPersonaModule, boolean>> = {
	work: {
		expression: false,
		values: false,
		scenario: false,
		contract: true,
		discipline: true,
		goal: true,
		workHistory: true,
		currentWork: true,
		impression: false,
		mood: false,
		heart: false,
		learning: false,
		proactivity: false,
		profiles: false,
	},
	companion: {
		expression: true,
		values: true,
		scenario: true,
		contract: false,
		discipline: false,
		goal: true,
		workHistory: false,
		currentWork: false,
		impression: true,
		mood: true,
		heart: true,
		learning: false,
		proactivity: false,
		profiles: false,
	},
	// 全才（2026-11-15 人设页打磨）：岗位类 + 口吻 / 里子 / 处境 + 内心三件全开——
	// 干活也有感情的执事；学习 / 挂念 / 人设库仍默认关（学习存数据、挂念发消息，别默认开）。
	allrounder: {
		expression: true,
		values: true,
		scenario: true,
		contract: true,
		discipline: true,
		goal: true,
		workHistory: true,
		currentWork: true,
		impression: true,
		mood: true,
		heart: true,
		learning: false,
		proactivity: false,
		profiles: false,
	},
	// 学徒：在学主人说话习惯的实验位——口吻 / 学习 / 挂念 / 人设库开，其余最小。
	apprentice: {
		expression: true,
		values: false,
		scenario: false,
		contract: false,
		discipline: false,
		goal: false,
		workHistory: true,
		currentWork: true,
		impression: false,
		mood: false,
		heart: false,
		learning: true,
		proactivity: true,
		profiles: true,
	},
	custom: {
		expression: false,
		values: false,
		scenario: false,
		contract: false,
		discipline: false,
		goal: false,
		workHistory: false,
		currentWork: false,
		impression: false,
		mood: false,
		heart: false,
		learning: false,
		proactivity: false,
		profiles: false,
	},
};

/** 预设默认开关（拷贝一份，调用方随便改）。 */
export function defaultPersonaModules(
	preset: PartnerPersonaPreset,
): Record<PartnerPersonaModule, boolean> {
	return { ...PERSONA_PRESETS[preset] };
}

/**
 * 有效开关 = 预设默认 + 行上显式值。
 * 只认 14 个 id 且值为布尔的键；磁盘被手改成脏值也不让进来。
 *
 * `workHistory` / `currentWork` 自 2026-11-15 人设页打磨起**固定注入**（不再是闸）：
 * 行上显式 `false` 保留在存储里但不再生效——两段都是现查现拼，没活干时整段本来
 * 就不出现，常开零成本（"记忆全注入"口径）。预设推导也不比较这两个 id。
 */
export function effectivePersonaModules(row: {
	personaPreset: PartnerPersonaPreset;
	personaModules: Partial<Record<PartnerPersonaModule, boolean>>;
}): Record<PartnerPersonaModule, boolean> {
	const merged = defaultPersonaModules(row.personaPreset);
	for (const id of PartnerPersonaModuleIds) {
		const value = row.personaModules[id];
		if (typeof value === "boolean") merged[id] = value;
	}
	merged.workHistory = true;
	merged.currentWork = true;
	return merged;
}

/** 固定注入、不再作为闸的两个模块 id（预设推导跳过它们）。 */
export const PERSONA_FIXED_ON_IDS = ["workHistory", "currentWork"] as const;

/** 参与预设推导比较的模块 id = 全部 id 去掉固定注入的两个。 */
export const PERSONA_PRESET_MATCH_IDS = PartnerPersonaModuleIds.filter(
	(id): id is PartnerPersonaModule => !(PERSONA_FIXED_ON_IDS as readonly string[]).includes(id),
);

/**
 * 按最终开关表推导预设名（2026-11-15 人设页打磨）：与某张预设表一致就标该预设，
 * 否则「自定义」。只比较可配置的 12 个 id；`workHistory` / `currentWork` 固定注入不参与。
 * 预设名从此永远是开关表的真话——改了任一开关自动跳「自定义」，改回来自动跳回预设。
 */
export function derivePresetFromModules(
	modules: Record<PartnerPersonaModule, boolean>,
): PartnerPersonaPreset {
	const candidates = ["work", "companion", "allrounder", "apprentice"] as const;
	for (const preset of candidates) {
		const table = PERSONA_PRESETS[preset];
		if (PERSONA_PRESET_MATCH_IDS.every((id) => modules[id] === table[id])) return preset;
	}
	return "custom";
}

/**
 * 单个模块是否生效。`PARTNER_PERSONA_MODULES=false` → 一律 true（旧行为：
 * 契约 / 目标 / 纪律 / 在办全照旧注入），静态模块另由 `renderPersonaSection` 跳过。
 */
export function personaModuleOn(
	row: {
		personaPreset: PartnerPersonaPreset;
		personaModules: Partial<Record<PartnerPersonaModule, boolean>>;
	},
	id: PartnerPersonaModule,
): boolean {
	if (!personaModulesEnabled()) return true;
	return effectivePersonaModules(row)[id] === true;
}

/** 静态模块的键（= 家目录里的文件名去扩展）。 */
export const PERSONA_CONTENT_KEYS = ["style", "values", "scenario"] as const;
export type PersonaContentKey = (typeof PERSONA_CONTENT_KEYS)[number];

/** 静态模块 → 模块 id：开关关掉的那一份不读、不渲染。 */
const CONTENT_MODULE: Record<PersonaContentKey, PartnerPersonaModule> = {
	style: "expression",
	values: "values",
	scenario: "scenario",
};

const CONTENT_FILE: Record<PersonaContentKey, string> = {
	style: "style.json",
	values: "values.json",
	scenario: "scenario.json",
};

const CONTENT_SCHEMA = {
	style: PartnerPersonaStyleSchema,
	values: PartnerPersonaValuesSchema,
	scenario: PartnerPersonaScenarioSchema,
} as const;

/** 人格内容所需的存储面（只用到这三件，单测可以塞桩）。 */
export interface PersonaStoreLike {
	homeOf(partnerId: string): string;
	readHomeFile(partnerId: string, relative: string): string | null;
	atomicWrite(path: string, content: string): void;
}

export function personaDirOf(store: PersonaStoreLike, partnerId: string): string {
	return join(store.homeOf(partnerId), "persona");
}

/**
 * 读一份静态内容。文件缺失 / JSON 坏 / 字段越界 → 一律当"没填"（空对象）。
 * 手改磁盘留下的脏文本不许进提示词（与端点写时同一份 zod schema）。
 */
function readContentModule<K extends PersonaContentKey>(
	store: PersonaStoreLike,
	partnerId: string,
	key: K,
): PartnerPersonaContents[K] {
	const raw = store.readHomeFile(partnerId, join("persona", CONTENT_FILE[key]));
	if (!raw?.trim()) return {} as PartnerPersonaContents[K];
	try {
		const parsed = CONTENT_SCHEMA[key].safeParse(JSON.parse(raw));
		return (parsed.success ? parsed.data : {}) as PartnerPersonaContents[K];
	} catch {
		return {} as PartnerPersonaContents[K];
	}
}

/** 三份静态内容（缺文件给空对象，调用方不用判空）。 */
export function readPersonaContents(
	store: PersonaStoreLike,
	partnerId: string,
): PartnerPersonaContents {
	return {
		style: readContentModule(store, partnerId, "style"),
		values: readContentModule(store, partnerId, "values"),
		scenario: readContentModule(store, partnerId, "scenario"),
	};
}

/** 合并一个静态模块：只覆盖给出的字段；`undefined` 不动，空串 / 空数组合法（存着，渲染时跳过）。 */
function mergeContentModule<T extends object>(base: T, patch: T | undefined): T {
	if (!patch) return base;
	const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [field, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		next[field] = value;
	}
	return next as T;
}

/**
 * 整份替换三份静态内容（人设库应用快照用）。
 *
 * 与 `writePersonaContents` 的区别：那个按字段合并（省略不动），这个**逐文件整份覆盖**——
 * 人设库应用是"回到保存当时"，保存后新加的字段必须一起消失，否则不叫快照。
 */
export function replacePersonaContents(
	store: PersonaStoreLike,
	partnerId: string,
	contents: PartnerPersonaContents,
): void {
	for (const key of PERSONA_CONTENT_KEYS) {
		store.atomicWrite(
			join(personaDirOf(store, partnerId), CONTENT_FILE[key]),
			`${JSON.stringify(contents[key], null, 2)}\n`,
		);
	}
}

/**
 * 写静态内容（按模块部分更新），返回写完的完整三份。
 * 校验在端点（shared 的 PartnerPersonaPatchSchema 已过一遍）；落盘是整份 JSON 原子写，
 * 单文件远小于 64KB 槽位护栏（字段上限合计不到 10KB）。
 */
export function writePersonaContents(
	store: PersonaStoreLike,
	partnerId: string,
	patch: Partial<PartnerPersonaContents>,
): PartnerPersonaContents {
	const current = readPersonaContents(store, partnerId);
	const next: PartnerPersonaContents = {
		style: mergeContentModule<PartnerPersonaStyle>(current.style, patch.style),
		values: mergeContentModule<PartnerPersonaValues>(current.values, patch.values),
		scenario: mergeContentModule<PartnerPersonaScenario>(current.scenario, patch.scenario),
	};
	for (const key of PERSONA_CONTENT_KEYS) {
		if (!patch[key]) continue;
		store.atomicWrite(
			join(personaDirOf(store, partnerId), CONTENT_FILE[key]),
			`${JSON.stringify(next[key], null, 2)}\n`,
		);
	}
	return next;
}

/* ── 渲染 ──────────────────────────────────────────────── */

/** 清单行：去空、trim。 */
function cleanList(values: string[] | undefined): string[] {
	if (!values) return [];
	return values.map((value) => value.trim()).filter(Boolean);
}

function styleLines(style: PartnerPersonaStyle): string[] {
	const lines: string[] = [];
	if (style.speakStyle?.trim()) lines.push(`- 说话风格：${style.speakStyle.trim()}`);
	if (style.sentenceLength) lines.push(`- 句子长度：${style.sentenceLength}`);
	const catchphrases = cleanList(style.catchphrases);
	if (catchphrases.length) {
		lines.push(`- 口癖：${catchphrases.map((item) => `「${item}」`).join("")}`);
	}
	const taboos = cleanList(style.taboos);
	if (taboos.length) lines.push(`- 忌用语：${taboos.join("、")}`);
	const dialogues = cleanList(style.exampleDialogues);
	if (dialogues.length) {
		lines.push(`- 示例对话：\n${dialogues.map((item) => `  · ${item}`).join("\n")}`);
	}
	// 备用风格与切换概率是一组：没写备用风格时一行「切换概率」没有意义，整组跳过。
	if (style.altStyle?.trim()) {
		const probability =
			typeof style.switchProbability === "number" ? `（切换概率 ${style.switchProbability}%）` : "";
		lines.push(`- 备用风格：${style.altStyle.trim()}${probability}`);
	}
	if (style.emojiHabit?.trim()) lines.push(`- 表情习惯：${style.emojiHabit.trim()}`);
	if (style.openingLine?.trim()) lines.push(`- 开场白：${style.openingLine.trim()}`);
	return lines;
}

function valuesLines(values: PartnerPersonaValues): string[] {
	const lines: string[] = [];
	if (values.cares?.trim()) lines.push(`- 在乎：${values.cares.trim()}`);
	if (values.bottomLines?.trim()) lines.push(`- 底线：${values.bottomLines.trim()}`);
	if (values.fears?.trim()) lines.push(`- 怕：${values.fears.trim()}`);
	const likes = cleanList(values.likes);
	if (likes.length) lines.push(`- 喜欢：${likes.join("、")}`);
	const dislikes = cleanList(values.dislikes);
	if (dislikes.length) lines.push(`- 厌恶：${dislikes.join("、")}`);
	if (values.motivator?.trim()) lines.push(`- 来劲的事：${values.motivator.trim()}`);
	const keywords = cleanList(values.valueKeywords);
	if (keywords.length) lines.push(`- 关键词：${keywords.join("、")}`);
	return lines;
}

function scenarioLines(scenario: PartnerPersonaScenario): string[] {
	const lines: string[] = [];
	if (scenario.situation?.trim()) lines.push(`- 眼下处境：${scenario.situation.trim()}`);
	if (scenario.knowledgeBoundary?.trim()) {
		lines.push(`- 知道与不知道：${scenario.knowledgeBoundary.trim()}`);
	}
	const relations = cleanList(scenario.relations);
	if (relations.length) {
		lines.push(`- 人物关系：\n${relations.map((item) => `  · ${item}`).join("\n")}`);
	}
	return lines;
}

/**
 * 静态人格的可展示字段（2026-11-16 追加）：默认上下文页要把「口吻 / 里子 / 处境」
 * 从身份大块里拆出来单独成行；空模块也保留 text=""，页面显示 0 字槽位。
 *
 * 注意：这里只负责“展示字段”，真实 instructions 仍由 renderPersonaBlocks 按
 * 空模块 / 空字段跳过，避免给模型带空标题。
 */
export interface PersonaFieldBlock {
	/** 默认页 section key */
	id: "partner_voice" | "partner_values" | "partner_scenario";
	/** 页面上的字段名 */
	title: string;
	/** 原始块正文（带 `【口吻】` 第一行）；空模块为 "" */
	text: string;
}

export function renderPersonaFieldBlocks(
	store: PersonaStoreLike,
	partner: {
		id: string;
		personaPreset: PartnerPersonaPreset;
		personaModules: Partial<Record<PartnerPersonaModule, boolean>>;
	},
): PersonaFieldBlock[] {
	const empty: PersonaFieldBlock[] = [
		{ id: "partner_voice", title: "说话方式（口吻）", text: "" },
		{ id: "partner_values", title: "里子", text: "" },
		{ id: "partner_scenario", title: "处境", text: "" },
	];
	// 回滚开关关闭 = 静态人格整段不注入；上下文页仍保留三个 0 字槽位。
	if (!personaModulesEnabled()) return empty;
	const modules = effectivePersonaModules(partner);
	const contents = readPersonaContents(store, partner.id);
	const enabled = (key: PersonaContentKey) => modules[CONTENT_MODULE[key]] === true;

	const style = enabled("style") ? styleLines(contents.style) : [];
	const values = enabled("values") ? valuesLines(contents.values) : [];
	const scenario = enabled("scenario") ? scenarioLines(contents.scenario) : [];
	const block = (heading: string, lines: string[]) =>
		lines.length ? [`【${heading}】`, ...lines].join("\n") : "";
	return [
		{ id: "partner_voice", title: "说话方式（口吻）", text: block("口吻", style) },
		{ id: "partner_values", title: "里子", text: block("里子", values) },
		{ id: "partner_scenario", title: "处境", text: block("处境", scenario) },
	];
}

/**
 * 静态人格段：固定顺序 **口吻 → 里子 → 处境**，空模块 / 空字段整段 / 整行跳过。
 * 全部为空（或开关关着）→ undefined（instructions 里不留空壳标题）。
 */
export function renderPersonaBlocks(
	contents: PartnerPersonaContents,
	modules?: Record<PartnerPersonaModule, boolean>,
): string | undefined {
	const blocks: string[] = [];
	const enabled = (key: PersonaContentKey) => modules === undefined || modules[CONTENT_MODULE[key]] === true;
	if (enabled("style")) {
		const lines = styleLines(contents.style);
		if (lines.length) blocks.push(["【口吻】", ...lines].join("\n"));
	}
	if (enabled("values")) {
		const lines = valuesLines(contents.values);
		if (lines.length) blocks.push(["【里子】", ...lines].join("\n"));
	}
	if (enabled("scenario")) {
		const lines = scenarioLines(contents.scenario);
		if (lines.length) blocks.push(["【处境】", ...lines].join("\n"));
	}
	return blocks.length ? blocks.join("\n\n") : undefined;
}

/**
 * `renderPartnerIdentity` 用的门面：`PARTNER_PERSONA_MODULES=false` → undefined（旧行为）；
 * 开关关掉的模块不读也不渲染。
 */
export function renderPersonaSection(
	store: PersonaStoreLike,
	partner: {
		id: string;
		personaPreset: PartnerPersonaPreset;
		personaModules: Partial<Record<PartnerPersonaModule, boolean>>;
	},
): string | undefined {
	if (!personaModulesEnabled()) return undefined;
	const modules = effectivePersonaModules(partner);
	const anyStatic =
		modules.expression || modules.values || modules.scenario;
	if (!anyStatic) return undefined;
	return renderPersonaBlocks(readPersonaContents(store, partner.id), modules);
}

/**
 * 静态人格在 instructions 里的签名：内容或开关一变就得重配会话。
 *
 * 为什么要它：`applied_version` 只记身份版本，改人格不 bump 版本（人格不是身份），
 * 光靠版本比对会让新填的口吻永远等不到下一次 SOUL / 契约变更。签名放进程内 Map，
 * 重启后第一次打开会话会重配一次（无害），不落库、不加存储。
 */
export function personaSignature(
	store: PersonaStoreLike,
	partner: {
		id: string;
		personaPreset: PartnerPersonaPreset;
		personaModules: Partial<Record<PartnerPersonaModule, boolean>>;
	},
): string {
	if (!personaModulesEnabled()) return "off";
	return `${JSON.stringify(effectivePersonaModules(partner))}|${JSON.stringify(
		readPersonaContents(store, partner.id),
	)}`;
}

const PERSONA_APPLIED_LIMIT = 500;
const personaApplied = new Map<number, string>();

/** 记下这条会话应用过的签名；返回 true = 变了（调用方要重配 instructions）。 */
export function personaRefreshNeeded(sessionId: number, signature: string): boolean {
	if (personaApplied.get(sessionId) === signature) return false;
	if (personaApplied.size >= PERSONA_APPLIED_LIMIT) personaApplied.clear();
	personaApplied.set(sessionId, signature);
	return true;
}

/** 单测用：清空进程内记账。 */
export function resetPersonaApplied(): void {
	personaApplied.clear();
}

/** 端点 `limits` 的回显（共享常量直出，前端不另抄数字）。 */
export { PARTNER_PERSONA_LIMITS };
