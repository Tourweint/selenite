/**
 * 工具超时策略（2026-11-24 M0–M2，方案 `docs/设计方案/2026-11-24-工具异常处理与超时转后台.md`）。
 *
 * 一句话：给「有真实等待面」的工具一条可解释的异常路径（限时 / 失败 / 转后台 / 取消），
 * 不是给每个工具配一个数字。本模块只做**配置面**：读写 `.data/tool-policy.json`、
 * 消毒、优先级解析；执行挂点在各自的工具链路上（lifecycle-harness / memory-bank / search）。
 *
 * 落点：`.data/tool-policy.json`（`TOOL_POLICY_PATH` 可覆盖，探针 / 测试隔离用）。
 * **写**：同目录临时文件 + rename 的原子写；**读**：mtime + size 缓存（照 `tool-pool.ts`）。
 *
 * 优先级（每层只覆盖显式给了的字段）：
 *   `tools.<name>` > `groups.<id>` > 旧配置（`AGENT_BASH_TIMEOUT_S` / `memory-bank.json` 的
 *   `timeouts.askMs` / `lightMs`，由调用方作为 legacy 传入）> 代码默认。
 *
 * 总开关 `TOOL_TIMEOUT_POLICY`（`plugins.json`，默认关）：
 *   关 = 本模块不读文件、解析结果 `enabled:false`，所有消费点走今天的老路径（逐字节不变）。
 *
 * catalog 住在代码里（工具名 / 能力是代码事实）：能力组、类别、capabilities、锁定原因、范围。
 * 改工具就要改这份表；不放 `plugins.json`，避免「清单」与「注册表」两处漂移。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bashBackgroundEnabled } from "./bash-background.ts";
import { flagEnabled } from "./flags.ts";
import { bashTimeoutSeconds } from "./reliability.ts";

/* ── 类型 ─────────────────────────────────────────────────── */

export type ToolTimeoutAction = "fail" | "background" | "cancel";

/** 单条策略：三个字段都可缺省；全空 = 删除该条（回继承）。 */
export interface ToolPolicy {
	timeoutMs?: number;
	onTimeout?: ToolTimeoutAction;
	notify?: boolean;
}

/** 文件形状（`v` 预留给未来迁移；读旧版时按已知字段归一）。 */
export interface ToolPolicyConfig {
	v: number;
	tools: Record<string, ToolPolicy>;
	groups: Record<string, ToolPolicy>;
	injections: Record<string, ToolPolicy>;
}

export interface ToolPolicyCapabilities {
	/** 能中止手里的活（kill 子进程 / abort fetch）。 */
	abortable: boolean;
	/** 有作业句柄，超时可以转后台继续（v1 只有 bash / powershell）。 */
	backgroundable: boolean;
	/** 界面上有输入框；false = 锁定行，只写原因。 */
	configurable: boolean;
}

/** A 当轮证据 / B 可后台 / C 必须前台 / D 副作用不可撤销。 */
export type ToolPolicyCategory = "evidence" | "backgroundable" | "interactive" | "side-effect";

export interface ToolPolicyGroup {
	id: string;
	title: string;
	desc: string;
}

export interface ToolPolicyCatalogEntry {
	name: string;
	label: string;
	group: string;
	category: ToolPolicyCategory;
	capabilities: ToolPolicyCapabilities;
	/** 锁定行的一句原因；可配工具为 null。 */
	lockedReason: string | null;
	/** 可配工具的 clamp 范围（毫秒）；锁定工具为 null。 */
	min: number | null;
	max: number | null;
	/** 可配工具的代码默认（毫秒）；锁定工具为 null。 */
	defaultTimeoutMs: number | null;
	/**
	 * 本批能**真正结算**的 onTimeout 取值。`fail` 恒在；`background` 只给有作业句柄的；
	 * `cancel` 只给实现了取消结算的（v1 = bash / powershell）。
	 * 不在这里的值 PUT 一律 `on_timeout_unsupported`（配置层不许写假能力）。
	 */
	allowedOnTimeout: readonly ToolTimeoutAction[];
}

export interface ToolPolicyInjectionEntry {
	name: string;
	label: string;
	desc: string;
	min: number;
	max: number;
	defaultTimeoutMs: number;
}

export type ToolPolicySource = "tool" | "group" | "legacy" | "default";

/** 单条策略解析后的生效值（GET 直接透出，界面解释「这个值从哪来」）。 */
export interface EffectiveToolPolicy {
	/** null = 显式不设默认（仅 `AGENT_BASH_TIMEOUT_S=0` 的 legacy 层会出现）。 */
	timeoutMs: number | null;
	onTimeout: ToolTimeoutAction;
	notify: boolean;
	/** 指 timeoutMs 的来源（onTimeout / notify 没有 legacy 层）。 */
	source: ToolPolicySource;
}

/**
 * 旧配置层的覆盖值（毫秒）。`undefined` = 调用方没提供（继续往下）；`null` = 显式不设
 * （bash 的 `AGENT_BASH_TIMEOUT_S=0`）。recall / memoryLight 的 legacy 由调用方从
 * `memory-bank.json` 取（本模块不 import memory-bank，避免环）。
 */
export interface ToolPolicyLegacyOverrides {
	bash?: number | null;
	recall?: number | null;
	memoryLight?: number | null;
}

export interface ResolvedToolPolicy {
	/** 总开关关 = false，且不读文件。 */
	enabled: boolean;
	config: ToolPolicyConfig;
	/** 只有可配工具（锁定行不参与解析）。 */
	tools: Record<string, { effective: EffectiveToolPolicy }>;
	/** 组自身的显式配置（未配置的组不出现）。组没有 legacy / default 层。 */
	groupPolicies: Record<string, ToolPolicy>;
	injections: Record<string, { effective: EffectiveToolPolicy }>;
}

/* ── catalog（静态表）────────────────────────────────────── */

export const TOOL_POLICY_GROUPS: readonly ToolPolicyGroup[] = [
	{
		id: "shell",
		title: "命令与文件",
		desc: "bash / PowerShell 这类会起进程的命令；超时后可转后台继续。文件读写是本地同步，不提供超时。",
	},
	{
		id: "memory",
		title: "记忆",
		desc: "外部记忆库检索。检索结果是当轮回答的证据，超时只能失败 / 更短预算，不能转后台。",
	},
	{
		id: "search",
		title: "搜索",
		desc: "公开网络搜索。这里配的是**整次调用**的总预算，不是每个搜索源各一份。",
	},
	{
		id: "collaborate",
		title: "派活与协作",
		desc: "派活、递话、执事 / 群组 / 例行管理。都是落盘或花钱动作，不提供超时。",
	},
	{
		id: "interaction",
		title: "交互确认",
		desc: "必须人回答的动作；到点是人的决定，不是机器的决定。",
	},
	{
		id: "skills",
		title: "技能与提醒",
		desc: "本地小操作（读技能手册 / 写建议 / 提醒）。",
	},
	{
		id: "meta",
		title: "元工具",
		desc: "工具面自身的查询与进度播报。",
	},
];

const SHELL_BG: ToolPolicyCatalogEntry["allowedOnTimeout"] = ["fail", "background", "cancel"];
const FAIL_ONLY: ToolPolicyCatalogEntry["allowedOnTimeout"] = ["fail"];

export const TOOL_POLICY_CATALOG: readonly ToolPolicyCatalogEntry[] = [
	{
		name: "bash",
		label: "bash",
		group: "shell",
		category: "backgroundable",
		capabilities: { abortable: true, backgroundable: true, configurable: true },
		lockedReason: null,
		min: 5_000,
		max: 3_600_000,
		defaultTimeoutMs: 900_000,
		allowedOnTimeout: SHELL_BG,
	},
	{
		name: "powershell",
		label: "PowerShell",
		group: "shell",
		category: "backgroundable",
		capabilities: { abortable: true, backgroundable: true, configurable: true },
		lockedReason: null,
		min: 5_000,
		max: 3_600_000,
		defaultTimeoutMs: 900_000,
		allowedOnTimeout: SHELL_BG,
	},
	{
		name: "read",
		label: "读取文件",
		group: "shell",
		category: "evidence",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "本地同步读：加超时只能不再等，文件读仍会跑完。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "write",
		label: "写文件",
		group: "shell",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "写到一半说「超时失败」，模型会以为没写、再写一遍；超时不能撤销已写入。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "edit",
		label: "编辑文件",
		group: "shell",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "同写文件：改到一半不能说「没改」。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "recall",
		label: "记忆检索",
		group: "memory",
		category: "evidence",
		capabilities: { abortable: true, backgroundable: false, configurable: true },
		lockedReason: null,
		min: 1_000,
		max: 120_000,
		defaultTimeoutMs: 15_000,
		// 本批 only fail：外部库检索超时只能失败 / 降级（任务书 M1）；background 在 PUT 直接拒。
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "recall_sessions",
		label: "会话考古",
		group: "memory",
		category: "evidence",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "本地读取 + 同步子串扫描，没有中止点；超时只能不再等，不能停扫描。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "remember",
		label: "记住",
		group: "memory",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "写操作；外部库已有实现级预算（PERSONA_WRITE_TIMEOUT_MS）。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "web_search",
		label: "网络搜索",
		group: "search",
		category: "evidence",
		capabilities: { abortable: true, backgroundable: false, configurable: true },
		lockedReason: null,
		min: 5_000,
		max: 120_000,
		defaultTimeoutMs: 20_000,
		// 本批 only fail：整次调用超时返回稳定错误，不装后台、不换结算语义。
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "delegate",
		label: "派活",
		group: "collaborate",
		category: "backgroundable",
		capabilities: { abortable: false, backgroundable: true, configurable: false },
		lockedReason: "派活本身就是后台（返回任务单号）；worker 超时在 设置 → 派活（CHANCELLOR_WORKER_*）。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "send_to_agent",
		label: "执事间递话",
		group: "collaborate",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "会起对方模型轮，属于花钱动作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "partner_manage",
		label: "执事管理",
		group: "collaborate",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "改执事档案 / 关系，落盘动作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "partner_skill_write",
		label: "执事技能落盘",
		group: "collaborate",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "写执事技能，落盘动作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "group_manage",
		label: "群组管理",
		group: "collaborate",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "建群 / 改群，落盘动作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "routine_manage",
		label: "例行管理",
		group: "collaborate",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "建 / 停常驻例行规则，落盘动作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "propose_project",
		label: "提议项目",
		group: "collaborate",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "登记项目，落盘动作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "respond_escalation",
		label: "答复上报",
		group: "collaborate",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "答复决策上报，落盘动作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "ask_user",
		label: "结构化提问",
		group: "interaction",
		category: "interactive",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "必须人答；120s 只是卡片过期展示，不等于工具调用超时。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "skill",
		label: "读技能手册",
		group: "skills",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "本地读文件，小操作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "save_skill_advice",
		label: "技能建议落盘",
		group: "skills",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "本地小文件写入。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "set_reminder",
		label: "设置提醒",
		group: "skills",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "本地小操作。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "save_reminder_advice",
		label: "提醒建议落盘",
		group: "skills",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "本地小文件写入。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "tool_search",
		label: "按需工具加载",
		group: "meta",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "本地注册表查询，无等待面。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
	{
		name: "report_progress",
		label: "进度播报",
		group: "meta",
		category: "side-effect",
		capabilities: { abortable: false, backgroundable: false, configurable: false },
		lockedReason: "本地写一条进度记录，无等待面。",
		min: null,
		max: null,
		defaultTimeoutMs: null,
		allowedOnTimeout: FAIL_ONLY,
	},
];

export const TOOL_POLICY_INJECTIONS: readonly ToolPolicyInjectionEntry[] = [
	{
		name: "memoryLight",
		label: "每轮记忆轻召回（不是工具调用）",
		desc: "每轮对话自动从外部记忆库带一点背景的单次预算；超时静默返回空，不打断对话轮。",
		min: 500,
		max: 30_000,
		defaultTimeoutMs: 8_000,
	},
];

const CONFIG_VERSION = 1;

export function toolPolicyCatalogEntry(name: string): ToolPolicyCatalogEntry | null {
	return TOOL_POLICY_CATALOG.find((entry) => entry.name === name) ?? null;
}

export function toolPolicyInjectionEntry(name: string): ToolPolicyInjectionEntry | null {
	return TOOL_POLICY_INJECTIONS.find((entry) => entry.name === name) ?? null;
}

/* ── 校验规格 ────────────────────────────────────────────── */

interface EntrySpec {
	name: string;
	min: number;
	max: number;
	allowedOnTimeout: readonly ToolTimeoutAction[];
	backgroundable: boolean;
}

function toolSpec(name: string): EntrySpec | null {
	const entry = toolPolicyCatalogEntry(name);
	if (!entry || !entry.capabilities.configurable || entry.min === null || entry.max === null) return null;
	return {
		name,
		min: entry.min,
		max: entry.max,
		allowedOnTimeout: entry.allowedOnTimeout,
		backgroundable: entry.capabilities.backgroundable,
	};
}

/** 组默认只对组内**可配**工具生效；没有可配工具的组没有规格（组策略不收）。 */
function groupSpec(id: string): EntrySpec | null {
	const members = TOOL_POLICY_CATALOG.filter(
		(entry) => entry.group === id && entry.capabilities.configurable && entry.min !== null,
	);
	if (members.length === 0) return null;
	const min = Math.max(...members.map((entry) => entry.min as number));
	const max = Math.min(...members.map((entry) => entry.max as number));
	const allowedOnTimeout = members
		.map((entry) => entry.allowedOnTimeout)
		.reduce((acc, list) => acc.filter((action) => list.includes(action)));
	return { name: id, min, max, allowedOnTimeout, backgroundable: members.every((e) => e.capabilities.backgroundable) };
}

function injectionSpec(name: string): EntrySpec | null {
	const entry = toolPolicyInjectionEntry(name);
	if (!entry) return null;
	return {
		name,
		min: entry.min,
		max: entry.max,
		allowedOnTimeout: ["fail"],
		backgroundable: false,
	};
}

/* ── 小工具 ──────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampTimeout(value: number, spec: EntrySpec): number {
	return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

function defaultWarn(message: string): void {
	console.warn(`[tool-policy] ${message}`);
}

export function emptyToolPolicyConfig(): ToolPolicyConfig {
	return { v: CONFIG_VERSION, tools: {}, groups: {}, injections: {} };
}

function cloneConfig(config: ToolPolicyConfig): ToolPolicyConfig {
	return {
		v: config.v,
		tools: { ...config.tools },
		groups: { ...config.groups },
		injections: { ...config.injections },
	};
}

/* ── 消毒（读盘）─────────────────────────────────────────── */

/**
 * 读盘消毒：未知顶层键 / 未知名字直接丢；`timeoutMs` 非有限数丢、越界 clamp、小数取整；
 * `onTimeout` 不认识丢；不可后台 / 不可取消的取值记一条 `on_timeout_unsupported` 后丢；
 * `notify` 非布尔丢；三个字段全空 = 删除该条。
 */
export function sanitizeToolPolicyConfig(
	raw: unknown,
	warn: (message: string) => void = defaultWarn,
): ToolPolicyConfig {
	const config = emptyToolPolicyConfig();
	if (!isRecord(raw)) return config;

	const sanitizeNamespace = (
		value: unknown,
		specOf: (name: string) => EntrySpec | null,
		kind: "tool" | "group" | "injection",
		apply: (name: string, policy: ToolPolicy) => void,
	): void => {
		if (!isRecord(value)) return;
		for (const [name, entry] of Object.entries(value)) {
			const spec = specOf(name);
			if (!spec) continue;
			const policy = sanitizeEntry(entry, spec, kind, warn);
			if (policy) apply(name, policy);
		}
	};

	sanitizeNamespace(raw.tools, toolSpec, "tool", (name, policy) => {
		config.tools[name] = policy;
	});
	sanitizeNamespace(raw.groups, groupSpec, "group", (name, policy) => {
		config.groups[name] = policy;
	});
	sanitizeNamespace(raw.injections, injectionSpec, "injection", (name, policy) => {
		config.injections[name] = policy;
	});
	return config;
}

function sanitizeEntry(
	raw: unknown,
	spec: EntrySpec,
	kind: "tool" | "group" | "injection",
	warn: (message: string) => void,
): ToolPolicy | null {
	if (!isRecord(raw)) return null;
	const policy: ToolPolicy = {};
	if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)) {
		policy.timeoutMs = clampTimeout(raw.timeoutMs, spec);
	}
	if (typeof raw.onTimeout === "string" && isTimeoutAction(raw.onTimeout)) {
		if (spec.allowedOnTimeout.includes(raw.onTimeout)) {
			policy.onTimeout = raw.onTimeout;
		} else {
			warn(`${kind}=${spec.name} onTimeout=${raw.onTimeout} 不受支持（on_timeout_unsupported），已忽略`);
		}
	}
	if (typeof raw.notify === "boolean") policy.notify = raw.notify;
	return Object.keys(policy).length > 0 ? policy : null;
}

function isTimeoutAction(value: string): value is ToolTimeoutAction {
	return value === "fail" || value === "background" || value === "cancel";
}

/* ── 落点 / 读写 ─────────────────────────────────────────── */

export function toolPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.TOOL_POLICY_PATH?.trim() || ".data/tool-policy.json");
}

interface ConfigCache {
	path: string;
	mtimeMs: number;
	size: number;
	config: ToolPolicyConfig;
}
let configCache: ConfigCache | null = null;

/** mtime + size 缓存：每轮工具面判断会读几次，别每次都解析文件。 */
export function readToolPolicyConfig(env: NodeJS.ProcessEnv = process.env): ToolPolicyConfig {
	const path = toolPolicyPath(env);
	let mtimeMs = 0;
	let size = 0;
	let exists = false;
	try {
		const stat = statSync(path);
		mtimeMs = stat.mtimeMs;
		size = stat.size;
		exists = true;
	} catch {
		/* 文件不存在 = 全部走继承 / 默认 */
	}
	if (configCache && configCache.path === path && configCache.mtimeMs === mtimeMs && configCache.size === size) {
		return cloneConfig(configCache.config);
	}
	let config = emptyToolPolicyConfig();
	if (exists) {
		try {
			config = sanitizeToolPolicyConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
		} catch {
			// 坏 JSON：按未配置处理（与 tool-pool / memory-bank 同口径），不把内容带进日志。
			defaultWarn("配置文件无法解析，按未配置处理");
		}
	}
	configCache = { path, mtimeMs, size, config };
	return cloneConfig(config);
}

/** 原子写：先写临时文件再改名，读到的永远是整份配置。 */
export function writeToolPolicyConfig(config: ToolPolicyConfig, env: NodeJS.ProcessEnv = process.env): void {
	const path = toolPolicyPath(env);
	const body: ToolPolicyConfig = {
		v: CONFIG_VERSION,
		tools: config.tools,
		groups: config.groups,
		injections: config.injections,
	};
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, `${JSON.stringify(body, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
		configCache = null;
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** 测试 / 探针：清缓存（同一文件被外部改写或换 `TOOL_POLICY_PATH` 后）。 */
export function resetToolPolicyCacheForTests(): void {
	configCache = null;
}

/* ── 总开关 ──────────────────────────────────────────────── */

/** `TOOL_TIMEOUT_POLICY`（默认关）：关 = 今天行为，policy 文件存在也不读。 */
export function toolTimeoutPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return flagEnabled("TOOL_TIMEOUT_POLICY", env);
}

/* ── 解析 ────────────────────────────────────────────────── */

function bashLegacyMs(env: NodeJS.ProcessEnv, overrides: ToolPolicyLegacyOverrides): number | null {
	if (overrides.bash !== undefined) return overrides.bash;
	const seconds = bashTimeoutSeconds(env);
	// 0 / 非法 = 老口径「不设默认超时」；用 null 表达，避免掉回代码默认 900s。
	return seconds > 0 ? seconds * 1000 : null;
}

function legacyMsOf(
	name: string,
	env: NodeJS.ProcessEnv,
	overrides: ToolPolicyLegacyOverrides,
): number | null | undefined {
	switch (name) {
		case "bash":
			return bashLegacyMs(env, overrides);
		case "recall":
			return overrides.recall !== undefined && overrides.recall !== null ? overrides.recall : undefined;
		// powershell 今天没有默认注入；web_search 今天只有每源 20s（不是整次预算）。
		default:
			return undefined;
	}
}

function effectiveToolPolicy(
	entry: ToolPolicyCatalogEntry,
	config: ToolPolicyConfig,
	legacyMs: number | null | undefined,
): EffectiveToolPolicy {
	const own = config.tools[entry.name];
	const group = config.groups[entry.group];
	let timeoutMs: number | null;
	let source: ToolPolicySource;
	if (own?.timeoutMs !== undefined) {
		timeoutMs = own.timeoutMs;
		source = "tool";
	} else if (group?.timeoutMs !== undefined) {
		timeoutMs = group.timeoutMs;
		source = "group";
	} else if (legacyMs !== undefined) {
		timeoutMs = legacyMs;
		source = "legacy";
	} else {
		timeoutMs = entry.defaultTimeoutMs;
		source = "default";
	}
	const onTimeout = own?.onTimeout ?? group?.onTimeout ?? "fail";
	const notify = own?.notify ?? group?.notify ?? onTimeout === "background";
	return { timeoutMs, onTimeout, notify, source };
}

function effectiveInjectionPolicy(
	entry: ToolPolicyInjectionEntry,
	config: ToolPolicyConfig,
	legacyMs: number | null | undefined,
): EffectiveToolPolicy {
	const own = config.injections[entry.name];
	let timeoutMs: number;
	let source: ToolPolicySource;
	if (own?.timeoutMs !== undefined) {
		timeoutMs = own.timeoutMs;
		source = "tool";
	} else if (legacyMs !== undefined && legacyMs !== null) {
		timeoutMs = legacyMs;
		source = "legacy";
	} else {
		timeoutMs = entry.defaultTimeoutMs;
		source = "default";
	}
	return { timeoutMs, onTimeout: "fail", notify: false, source };
}

/**
 * 解析当前生效策略。总开关关：`enabled:false`、不读文件、`tools/injections` 为空。
 * `legacy` 覆盖值以毫秒计；没给的层按 env / 默认继续往下。
 */
export function resolveToolPolicy(
	env: NodeJS.ProcessEnv = process.env,
	legacy: ToolPolicyLegacyOverrides = {},
): ResolvedToolPolicy {
	if (!toolTimeoutPolicyEnabled(env)) {
		return {
			enabled: false,
			config: emptyToolPolicyConfig(),
			tools: {},
			groupPolicies: {},
			injections: {},
		};
	}
	const config = readToolPolicyConfig(env);
	const tools: Record<string, { effective: EffectiveToolPolicy }> = {};
	for (const entry of TOOL_POLICY_CATALOG) {
		if (!entry.capabilities.configurable) continue;
		tools[entry.name] = { effective: effectiveToolPolicy(entry, config, legacyMsOf(entry.name, env, legacy)) };
	}
	const injections: Record<string, { effective: EffectiveToolPolicy }> = {};
	for (const entry of TOOL_POLICY_INJECTIONS) {
		const legacyMs = entry.name === "memoryLight" ? legacy.memoryLight : undefined;
		injections[entry.name] = { effective: effectiveInjectionPolicy(entry, config, legacyMs) };
	}
	return { enabled: true, config, tools, groupPolicies: { ...config.groups }, injections };
}

/** 任一可配工具解析后选了 background（bg-jobs 管理面挂载条件用）。 */
export function anyBackgroundToolPolicy(env: NodeJS.ProcessEnv = process.env): boolean {
	const resolved = resolveToolPolicy(env);
	if (!resolved.enabled) return false;
	return Object.values(resolved.tools).some((entry) => entry.effective.onTimeout === "background");
}

/* ── shell 执行挂点（beforeTool / afterTool 共用）─────────── */

/**
 * `beforeTool` 的默认超时注入值（秒）；0 = 不注入（内核 timeout 必须 > 0）。
 *
 * - 总开关关：**今天的行为**——只给 bash 注入，值来自 `AGENT_BASH_TIMEOUT_S`
 *   （调用方传模块常量 `BASH_TIMEOUT_S` 作为 legacy.bash，保证逐字节一致）；
 *   powershell 恒 0（今天没有默认注入）。
 * - 总开关开：读 policy 的 `tools.<name>.timeoutMs`（含 legacy 兜底 / 默认），bash 与
 *   powershell 都注入。policy 的 timeoutMs 是**默认注入值**，模型显式传了 timeout 时
 *   调用方不覆盖（§3.4）。
 */
export function shellTimeoutInjectionSeconds(
	toolName: "bash" | "powershell",
	env: NodeJS.ProcessEnv = process.env,
	legacy: ToolPolicyLegacyOverrides = {},
): number {
	const resolved = resolveToolPolicy(env, legacy);
	if (!resolved.enabled) {
		if (toolName !== "bash") return 0;
		const ms = bashLegacyMs(env, legacy);
		return ms !== null && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0;
	}
	const ms = resolved.tools[toolName]?.effective.timeoutMs;
	return ms === null || ms === undefined ? 0 : Math.max(1, Math.round(ms / 1000));
}

export type ShellTimeoutAction = "fail" | "background" | "cancel";

export interface ShellTimeoutDecision {
	action: ShellTimeoutAction;
	/** 只有 background 有意义；false = 只留 index / log，不写会话、不唤醒。 */
	notify: boolean;
}

/**
 * `afterTool` 认出内核超时文案后的结算动作（只有 bash / powershell 会调）。
 *
 * - 总开关关：**今天的行为**——`AGENT_BASH_BG_TIMEOUT` 开 = background（恒通知），
 *   否则 fail（内核错误原样透出）。
 * - 总开关开：由 policy 的 `onTimeout` 决定（默认 fail）；notify 由 policy 决定
 *   （background 默认 true，fail / cancel 默认 false）。
 */
export function shellTimeoutDecision(
	toolName: "bash" | "powershell",
	env: NodeJS.ProcessEnv = process.env,
): ShellTimeoutDecision {
	const resolved = resolveToolPolicy(env);
	if (!resolved.enabled) {
		return bashBackgroundEnabled(env)
			? { action: "background", notify: true }
			: { action: "fail", notify: false };
	}
	const effective = resolved.tools[toolName]?.effective;
	const action = effective?.onTimeout ?? "fail";
	return { action, notify: effective?.notify ?? action === "background" };
}

/**
 * 每轮记忆轻召回的生效预算（毫秒）——`injections.memoryLight` 的**消费点**（2026-11-24 M1 补齐）。
 *
 * - 总开关开：取 `injections.memoryLight.timeoutMs`（显式条目 > legacy > 代码默认 8s）。
 * - 总开关关：原样返回调用方传入的 `legacyLightMs`（`memory-bank.json` 的 `timeouts.lightMs`，
 *   今天的行为逐字节不变）。
 *
 * 调用方：`agent/lifecycle-harness.ts` 的轻召回接线（`personaLightRecall.timeoutMs`）。
 * 轻召回是每轮注入、不是工具调用，所以单独放 `injections` 分区；它永远不能转后台 / 取消。
 */
export function memoryLightTimeoutMs(
	legacyLightMs: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const resolved = resolveToolPolicy(env, { memoryLight: legacyLightMs });
	if (!resolved.enabled) return legacyLightMs;
	return resolved.injections.memoryLight?.effective.timeoutMs ?? legacyLightMs;
}

/* ── PUT 局部更新（严格校验）──────────────────────────────── */

export type ToolPolicyPatchErrorCode =
	| "bad_request"
	| "unknown_tool"
	| "unknown_group"
	| "unknown_injection"
	| "tool_locked"
	| "on_timeout_unsupported"
	| "bad_timeout"
	| "bad_notify";

export type ToolPolicyPatchResult =
	| { ok: true; config: ToolPolicyConfig }
	| { ok: false; status: 400; error: ToolPolicyPatchErrorCode; message: string };

const NAMESPACES = ["tools", "groups", "injections"] as const;

function badRequest(message: string): ToolPolicyPatchResult {
	return { ok: false, status: 400, error: "bad_request", message };
}

function validateEntryStrict(
	raw: unknown,
	spec: EntrySpec,
	kind: "tool" | "group" | "injection",
): { ok: true; policy: ToolPolicy | null } | { ok: false; status: 400; error: ToolPolicyPatchErrorCode; message: string } {
	if (!isRecord(raw)) return { ok: false, status: 400, error: "bad_request", message: `${spec.name} 的 policy 必须是对象` };
	const policy: ToolPolicy = {};
	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs)) {
			return { ok: false, status: 400, error: "bad_timeout", message: `${spec.name} 的 timeoutMs 必须是有限数字` };
		}
		policy.timeoutMs = clampTimeout(raw.timeoutMs, spec);
	}
	if (raw.onTimeout !== undefined) {
		if (typeof raw.onTimeout !== "string" || !isTimeoutAction(raw.onTimeout)) {
			return {
				ok: false,
				status: 400,
				error: "on_timeout_unsupported",
				message: `${spec.name} 的 onTimeout 只能是 fail / background / cancel`,
			};
		}
		if (!spec.allowedOnTimeout.includes(raw.onTimeout)) {
			const reason =
				raw.onTimeout === "background"
					? spec.backgroundable
						? "本批不支持把超时转后台"
						: "没有后台作业句柄，不能把超时转后台"
					: `${kind === "injection" ? "注入" : "该工具"}没有实现超时取消结算`;
			return {
				ok: false,
				status: 400,
				error: "on_timeout_unsupported",
				message: `${spec.name} 不支持 onTimeout=${raw.onTimeout}：${reason}`,
			};
		}
		policy.onTimeout = raw.onTimeout;
	}
	if (raw.notify !== undefined) {
		if (typeof raw.notify !== "boolean") {
			return { ok: false, status: 400, error: "bad_notify", message: `${spec.name} 的 notify 必须是布尔值` };
		}
		policy.notify = raw.notify;
	}
	return { ok: true, policy: Object.keys(policy).length > 0 ? policy : null };
}

/**
 * PUT 局部更新（`null` = 删除该条，回继承）：
 *   - 只处理出现了的命名空间；命名空间内只处理出现了的名字；
 *   - 工具条目为**替换**（不是深合并）：卡片保存时总是发完整三字段；
 *   - 未知名报错（用户拼错要当场知道，不静默丢）；锁定工具 `tool_locked`；
 *   - 不可后台写 background / 不可取消写 cancel `on_timeout_unsupported`；
 *   - 越界 timeout 按范围 clamp（不报错），非数字 / 非有限数 `bad_timeout`。
 */
export function applyToolPolicyPatch(current: ToolPolicyConfig, patch: unknown): ToolPolicyPatchResult {
	if (!isRecord(patch)) return badRequest("请求体必须是对象");
	if (!NAMESPACES.some((namespace) => namespace in patch)) {
		return badRequest("至少要给 tools / groups / injections 中的一个");
	}
	const next = cloneConfig(current);

	// tools
	if ("tools" in patch) {
		if (!isRecord(patch.tools)) return badRequest("tools 必须是对象");
		for (const [name, raw] of Object.entries(patch.tools)) {
			const entry = toolPolicyCatalogEntry(name);
			if (!entry) {
				return { ok: false, status: 400, error: "unknown_tool", message: `未知工具：${name}` };
			}
			if (!entry.capabilities.configurable) {
				return {
					ok: false,
					status: 400,
					error: "tool_locked",
					message: `${name} 不提供超时配置：${entry.lockedReason ?? "该工具没有可配的等待面"}`,
				};
			}
			if (raw === null) {
				delete next.tools[name];
				continue;
			}
			const validated = validateEntryStrict(raw, toolSpec(name) as EntrySpec, "tool");
			if (!validated.ok) return validated;
			if (validated.policy) next.tools[name] = validated.policy;
			else delete next.tools[name];
		}
	}

	// groups
	if ("groups" in patch) {
		if (!isRecord(patch.groups)) return badRequest("groups 必须是对象");
		for (const [id, raw] of Object.entries(patch.groups)) {
			if (!TOOL_POLICY_GROUPS.some((group) => group.id === id)) {
				return { ok: false, status: 400, error: "unknown_group", message: `未知能力组：${id}` };
			}
			const spec = groupSpec(id);
			if (!spec) {
				return {
					ok: false,
					status: 400,
					error: "bad_request",
					message: `${id} 组里没有可配工具，组默认不会生效`,
				};
			}
			if (raw === null) {
				delete next.groups[id];
				continue;
			}
			const validated = validateEntryStrict(raw, spec, "group");
			if (!validated.ok) return validated;
			if (validated.policy) next.groups[id] = validated.policy;
			else delete next.groups[id];
		}
	}

	// injections
	if ("injections" in patch) {
		if (!isRecord(patch.injections)) return badRequest("injections 必须是对象");
		for (const [name, raw] of Object.entries(patch.injections)) {
			if (!toolPolicyInjectionEntry(name)) {
				return { ok: false, status: 400, error: "unknown_injection", message: `未知注入预算：${name}` };
			}
			if (raw === null) {
				delete next.injections[name];
				continue;
			}
			const validated = validateEntryStrict(raw, injectionSpec(name) as EntrySpec, "injection");
			if (!validated.ok) return validated;
			if (validated.policy) next.injections[name] = validated.policy;
			else delete next.injections[name];
		}
	}

	return { ok: true, config: next };
}
