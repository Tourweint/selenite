import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 技能分类建议（2026-11-10 批 30）：Agent 给技能分三栏 + 预计使用频率，**人确认后**才改启停。
 *
 * 口径（任务书 `docs/设计方案/2026-11-10-批30任务书（技能分类与开启建议）.md`）：
 * - 三栏：`keep`（建议开启：基础设施/常用）/ `scene`（按场景）/ `skip`（建议不开：面向别的
 *   agent 平台、本机跑不起来、几乎用不上）。
 * - 技能是手册不是定时器，`frequency` 是"预计多久用上一次"的展示信息，不代表会自动运行。
 * - 建议归建议（本文件快照），开关归开关（`skill-state.ts`）：采纳那一刻才写启停位，
 *   本文件**永不写** `skills-state.json`——两份状态不能混。
 * - 建议是**快照**：用户点"重新评估"才重算；装新技能后快照缺这条 = `unevaluated`，不硬凑栏。
 * - 回滚：`SKILL_ADVICE=false` → 路由不挂（同 `SKILLS_ADMIN` 口径）。
 */

export type SkillAdviceBucket = "keep" | "scene" | "skip";
export type SkillAdviceFrequency = "daily" | "weekly" | "monthly" | "rare";

export interface SkillAdviceEntry {
	bucket: SkillAdviceBucket;
	frequency: SkillAdviceFrequency;
	/** 一句话理由（给用户看；生成时截到 40 字符） */
	reason: string;
}

export interface SkillAdviceSnapshot {
	generatedAt: string;
	/** 生成时用的模型（provider/modelId），展示用 */
	model: string;
	items: Record<string, SkillAdviceEntry>;
}

/** GET 返回形状：快照 + 差集标注（消失的清掉、新增的标 unevaluated） */
export interface SkillAdviceView {
	generatedAt: string | null;
	model: string | null;
	stale: boolean;
	/** true = 快照生成后技能目录发生过变化（有新增或消失），徽章口径见任务书 */
	items: Record<string, SkillAdviceEntry>;
	unevaluated: string[];
}

export function skillAdvicePath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.AGENT_SKILLS_ADVICE_PATH?.trim() || ".data/skills-advice.json");
}

/** 回滚开关：false/0/off = 端点不挂（设置页不显示评估入口），一行退回纯手工启停 */
export function skillAdviceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.SKILL_ADVICE?.trim().toLowerCase();
	if (!raw) return true;
	return raw !== "false" && raw !== "0" && raw !== "off";
}

const BUCKETS: readonly SkillAdviceBucket[] = ["keep", "scene", "skip"];
const FREQUENCIES: readonly SkillAdviceFrequency[] = ["daily", "weekly", "monthly", "rare"];

/**
 * 模型输出单条校验：接受对象形态与紧凑数组形态（[bucket, frequency, reason]）两种；
 * 非法 bucket/frequency / 缺字段 → 丢弃该条（不是丢弃整份）。
 * 宁可少评一条也不把猜出来的值写进快照——错误值会变成界面上理直气壮的假话。
 */
export function sanitizeAdviceItem(raw: unknown): SkillAdviceEntry | null {
	// 紧凑数组形态：["keep", "daily", "理由"]（批 30 实测：122 条对象形态输出撑爆 maxTokens）
	if (Array.isArray(raw)) {
		const [bucket, frequency, reason] = raw;
		if (typeof bucket !== "string" || !BUCKETS.includes(bucket as SkillAdviceBucket)) return null;
		if (typeof frequency !== "string" || !FREQUENCIES.includes(frequency as SkillAdviceFrequency)) {
			return null;
		}
		return {
			bucket: bucket as SkillAdviceBucket,
			frequency: frequency as SkillAdviceFrequency,
			reason: String(reason ?? "").trim().slice(0, 40),
		};
	}
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const bucket = obj.bucket;
	const frequency = obj.frequency;
	if (typeof bucket !== "string" || !BUCKETS.includes(bucket as SkillAdviceBucket)) return null;
	if (typeof frequency !== "string" || !FREQUENCIES.includes(frequency as SkillAdviceFrequency)) {
		return null;
	}
	const reason = String(obj.reason ?? "").trim().slice(0, 40);
	return {
		bucket: bucket as SkillAdviceBucket,
		frequency: frequency as SkillAdviceFrequency,
		reason,
	};
}

/** 模型输出的 JSON 解析 + 全量清洗：输出不是合法 JSON / 不是对象 → null（调用方判 503） */
export function parseAdviceResponse(text: string): Record<string, SkillAdviceEntry> | null {
	const trimmed = text.trim();
	// 容忍 markdown 代码栅栏：模型偶尔会 ```json ... ``` 包一层
	const unfenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
	const json = unfenced ? unfenced[1] : trimmed;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const rawItems = (parsed as Record<string, unknown>).items;
	if (!rawItems || typeof rawItems !== "object" || Array.isArray(rawItems)) return null;
	const out: Record<string, SkillAdviceEntry> = {};
	for (const [name, raw] of Object.entries(rawItems as Record<string, unknown>)) {
		const entry = sanitizeAdviceItem(raw);
		if (entry) out[name] = entry;
	}
	// 一条合法的都没有 = 这次输出整体不可信，按失败处理而不是空快照
	return Object.keys(out).length > 0 ? out : null;
}

export function readAdviceSnapshot(path: string): SkillAdviceSnapshot | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		const items = obj.items;
		if (!items || typeof items !== "object" || Array.isArray(items)) return null;
		const out: Record<string, SkillAdviceEntry> = {};
		for (const [name, raw] of Object.entries(items as Record<string, unknown>)) {
			const entry = sanitizeAdviceItem(raw);
			if (entry) out[name] = entry;
		}
		return {
			generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : "",
			model: typeof obj.model === "string" ? obj.model : "",
			items: out,
		};
	} catch {
		return null;
	}
}

export function writeAdviceSnapshot(path: string, snapshot: SkillAdviceSnapshot): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * 快照与当前技能名集合做差集（GET 时现算，不改快照文件）：
 * - 消失的技能：从视图里去掉（下次重新评估时快照里也清掉——见 `pruneAdviceSnapshot`）；
 * - 新增的技能：进 `unevaluated`，前端标"未评估"，不硬凑三栏。
 */
export function adviceViewOf(
	snapshot: SkillAdviceSnapshot | null,
	currentNames: readonly string[],
): SkillAdviceView {
	if (!snapshot) {
		return { generatedAt: null, model: null, stale: false, items: {}, unevaluated: [...currentNames] };
	}
	const current = new Set(currentNames);
	const items: Record<string, SkillAdviceEntry> = {};
	const unevaluated: string[] = [];
	for (const name of currentNames) {
		const entry = snapshot.items[name];
		if (entry) items[name] = entry;
		else unevaluated.push(name);
	}
	// currentNames 本身来自技能目录扫描，天然去重；这里只挡快照里指向已消失技能的脏数据
	void current;
	return {
		generatedAt: snapshot.generatedAt || null,
		model: snapshot.model || null,
		stale: unevaluated.length > 0,
		items,
		unevaluated,
	};
}

/** 把快照里已消失的技能条目清掉（重新评估成功写入前也可以先修快照，避免越攒越脏） */
export function pruneAdviceSnapshot(
	snapshot: SkillAdviceSnapshot,
	currentNames: readonly string[],
): SkillAdviceSnapshot {
	const current = new Set(currentNames);
	const items: Record<string, SkillAdviceEntry> = {};
	for (const [name, entry] of Object.entries(snapshot.items)) {
		if (current.has(name)) items[name] = entry;
	}
	return { ...snapshot, items };
}

/**
 * 采纳闸门（PUT）：每条 action 的 name 必须来自快照 items（防"伪造建议直接开技能"）。
 * 返回非法名字清单；空数组 = 全部合法。启停位的存在性校验（技能目录里有没有）由调用方
 * 复用启停端点的既有逻辑。
 */
export function illegalAdviceActions(
	actions: readonly { name: string; enabled: boolean }[],
	snapshot: SkillAdviceSnapshot | null,
): string[] {
	if (!snapshot) return actions.map((action) => action.name);
	return actions.filter((action) => !(action.name in snapshot.items)).map((action) => action.name);
}

/* ── 评估提示词与快照落盘（2026-11-10 批 30 修订版）────────────────────────
 * 评估**不在服务端后端跑**（v1 的候选链盲扫被用户否了：不知道会撞上哪个模型，
 * 万一能力低但计费高就亏了）。流程改为：设置页按钮 → 跳到总管对话并预填提示词 →
 * 总管在用户眼皮底下（用户自己选的模型）枚举技能清单逐条评估 → 调
 * `save_skill_advice` 工具把结果写进快照 → 用户回设置页分栏采纳。 */

export interface AdviceSkillRow {
	name: string;
	summary: string;
	enabled: boolean;
	usageCount: number | null;
	stale: boolean;
	origin: string;
}

/** 组装 user 输入：JSON 行清单（全量不截断——123 条摘要远不到上下文上限） */
export function renderAdviceUserInput(rows: readonly AdviceSkillRow[]): string {
	const lines = rows.map((row) =>
		JSON.stringify({
			name: row.name,
			summary: row.summary.slice(0, 200),
			enabled: row.enabled,
			usageCount: row.usageCount,
			stale: row.stale,
			origin: row.origin,
		}),
	);
	return lines.join("\n");
}

/**
 * 总管对话用的评估提示词（前端预填）。清单由服务端拼好嵌进去，
 * 总管只需要：逐条评估 → 调 save_skill_advice 一次性落盘 → 回用户一句摘要。
 */
export function renderAdvicePrompt(rows: readonly AdviceSkillRow[]): string {
	return `帮我评估技能库：逐条判断下面每份技能手册对咱们的价值，分三栏，然后把结果一次性存起来（调 save_skill_advice 工具），最后用两三句话告诉我：建议开启哪些、你把哪些放进了"按场景"、哪些不建议开。

评估对象是**我**——Windows 本机单人 agent（bash/read/write/edit 工具面 + ego lite 浏览器；不是 Claude Code / ZCode / Cursor）。技能是操作手册，不会定时运行；frequency 是预估我多久用上一次。

三栏判据：
- keep（建议开启）：基础设施 / 常用能力，对我和这个环境有用且跑得起来。
- scene（按场景）：特定任务才用得上，开着也行，交给主人逐条决定。
- skip（建议不开）：面向别的 agent 平台或环境（如依赖 Claude Code / ZCode 特有机制）、面向别的发布渠道（公众号/微博等）、在这个环境根本用不上、或几乎永远用不到。

频率口径：daily=基础设施/几乎每天可用；weekly=常规任务会用；monthly=偶尔的场景；rare=几乎用不上。rare 一律配 skip。

参考信息（不强制）：usageCount≥3 且 stale=false 且当前 enabled=true 的技能，说明主人实际在用，倾向 keep。

技能清单（JSON 行，每行一条）：
${renderAdviceUserInput(rows)}`;
}

/** 工具/导入入口共用的快照写入：整份替换 items（先与现有快照按当前清单合并语义由调用方定）。 */
export function saveAdviceItems(
	path: string,
	items: Record<string, SkillAdviceEntry>,
	model: string,
): SkillAdviceSnapshot {
	const previous = readAdviceSnapshot(path);
	const snapshot: SkillAdviceSnapshot = {
		generatedAt: new Date().toISOString(),
		model: model || previous?.model || "",
		items: { ...(previous?.items ?? {}), ...items },
	};
	writeAdviceSnapshot(path, snapshot);
	return snapshot;
}

/** `save_skill_advice` 工具的结果：saved=本次落盘条数，kept=快照里未被本次清单覆盖的原有条数 */
export type SkillAdviceSaveResult =
	| { ok: true; saved: number; kept: number }
	| { ok: false; error: string; message: string; hint?: string };

/**
 * 工具入口（lifecycle 注入给 tools.ts；包住清洗 + 落盘）：
 * 输入是模型给的原始 `名 → [bucket, frequency, reason]` 映射，非法条目丢弃不报错
 * （清单大，个别笔误不该让整份作废）；一条合法都没有才算失败。
 */
export function makeSkillAdviceSaver(
	path: string,
): (items: Record<string, string[]>) => SkillAdviceSaveResult {
	return (rawItems) => {
		const items: Record<string, SkillAdviceEntry> = {};
		for (const [name, raw] of Object.entries(rawItems ?? {})) {
			const entry = sanitizeAdviceItem(raw);
			if (entry) items[name] = entry;
		}
		if (Object.keys(items).length === 0) {
			return {
				ok: false,
				error: "no_valid_items",
				message:
					"items 里没有一条合法建议（每条要是 [bucket, frequency, reason] 三元素数组，bucket/frequency 按口径取值）",
				hint: "对照口径重给：bucket=keep|scene|skip，frequency=daily|weekly|monthly|rare。",
			};
		}
		const previous = readAdviceSnapshot(path);
		const kept = Object.keys(previous?.items ?? {}).filter((name) => !(name in items)).length;
		saveAdviceItems(path, items, "chief-conversation");
		return { ok: true, saved: Object.keys(items).length, kept };
	};
}
