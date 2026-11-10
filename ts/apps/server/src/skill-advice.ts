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

/* ── 评估的模型调用与提示词 ────────────────────────────────────────────────
 * 独立请求、不进主会话（范式同 memory-extract 的 generateOnce：completeSimple、
 * faux 当作没有模型、超时宁可丢也不挂着）。 */

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
	return `以下是本机 agent 技能库的全量清单（JSON 行）：\n${lines.join("\n")}\n`;
}

export const ADVICE_TIMEOUT_MS = 90_000;

/**
 * 一次性模型调用：独立请求、不进主会话（范式同 memory-extract 的 generateOnce）。
 * 返回 null = 没拿到可用文本（无任何可用模型 / faux / 报错 / 超时 / 输出解析失败）。
 *
 * 模型挑选是**候选链**（批 30 实测教训：当前模型 ≠ 可用模型——界面切到某 provider
 * 但该 provider 的 keyEnv 没配时，"回落当前模型"整条死）。顺序：
 *   1. auxiliaryModel("advice") pin 的模型（AUX_MODEL_ADVICE 显式指定，最高优先）；
 *   2. 当前会话模型；
 *   3. modelCatalog 里 hasKey=true 的 provider×model 逐个试（配置文件顺序）。
 * 每个候选一次机会（报错就换下一个），全部失败才 null。
 *
 * provider 依赖在这里就地 import（与 memory-extract 同款）——本模块的纯函数部分
 * 仍然可以脱离 provider 单测。
 */
export async function generateAdvice(rows: readonly AdviceSkillRow[]): Promise<string | null> {
	const { modelCatalog, currentModels, isFaux, readLlmConfig } = await import("./provider.ts");
	const { auxiliaryModel } = await import("./auxiliary.ts");
	if (isFaux()) return null;

	const models = currentModels();
	const candidates: { provider: string; modelId: string }[] = [];
	const push = (ref: { provider: string; modelId: string } | null) => {
		if (ref && !candidates.some((c) => c.provider === ref.provider && c.modelId === ref.modelId)) {
			candidates.push({ provider: ref.provider, modelId: ref.modelId });
		}
	};
	push(auxiliaryModel("advice", { current: readLlmConfig()?.model }));
	push(readLlmConfig()?.model ?? null);
	for (const provider of modelCatalog().providers) {
		if (!provider.hasKey) continue;
		for (const model of provider.models) push({ provider: provider.id, modelId: model.id });
	}

	for (const candidate of candidates) {
		const model = models.getModel(candidate.provider, candidate.modelId);
		if (!model) continue;
		const text = await adviceOnce(models, model, rows);
		if (text !== null) return text;
	}
	return null;
}

/** 单个候选模型的一次调用；失败（报错 / 超时 / 输出不可解析）返回 null，由调用方换下一个 */
async function adviceOnce(
	models: Awaited<ReturnType<typeof import("./provider.ts").currentModels>>,
	model: Parameters<typeof models.completeSimple>[0],
	rows: readonly AdviceSkillRow[],
): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ADVICE_TIMEOUT_MS);
	try {
		const response = await models.completeSimple(
			model,
			{
				systemPrompt: adviceSystemPrompt(),
				messages: [
					{
						role: "user" as const,
						content: renderAdviceUserInput(rows),
						timestamp: Date.now(),
					},
				],
			},
			// 分类活不需要深思：minimal 思考档，把 token 全留给 122 条 JSON 输出
			{ signal: controller.signal, maxTokens: 16000, temperature: 0, reasoning: "minimal" },
		);
		if (response.stopReason !== "stop") {
			// aborted 大多是超时中止，error 多是供应商没配 key：静默 null 会让"评估没跑成"查不到原因
			console.warn(
				`[skills] 分类建议调用未出结果: stop=${response.stopReason}，输入 ${rows.length} 条技能`,
			);
			return null;
		}
		const text = contentText(response.content);
		// 输出必须能解析成合法建议才算成功——半截 JSON 当作没跑成，调用方换下一个模型
		return text && parseAdviceResponse(text) ? text : null;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// 只有错误摘要，没有对话内容
		console.warn(`[skills] 分类建议调用失败: ${detail.slice(0, 200)}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** contentText 的本地实现（provider 的同名函数未导出；这里只需要拼纯文本） */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

export function adviceSystemPrompt(): string {
	return `你是本机 agent 的技能库管家。技能库里有大量第三方技能（装的时候面向的是别的 agent 工具），你的任务是逐条判断它们对这个 agent 的价值，输出三栏分类。

你评估的 agent 是：Windows 本机单人 agent（Hono 服务 + bash/read/write/edit 工具面，不是 Claude Code / ZCode / Cursor）。技能的"运行环境"是本机 Windows + ego lite 浏览器（Chromium，可复用用户登录态）。技能本身是操作手册，不会定时运行；"frequency"是你预估 agent 多久会用上一次。

三栏判据：
- keep（建议开启）：基础设施 / 常用能力，本机 agent 有用且能跑起来。
- scene（按场景）：特定任务才用得上，开着也行，交给用户逐条决定。
- skip（建议不开）：面向别的 agent 平台或环境（如依赖 Claude Code / ZCode 特有机制）、面向别的发布渠道（公众号/微博等）、本机 agent 根本用不上、或几乎永远用不到。

频率口径：daily=基础设施/几乎每天可用；weekly=常规任务会用；monthly=偶尔的场景；rare=几乎用不上。rare 一律配 skip。

参考信息（不强制）：usageCount≥3 且 stale=false 且当前 enabled=true 的技能，说明用户实际在用，倾向 keep。

输出格式（紧凑，为了装下上百条）：items 的每条值是**三元素数组** [bucket, frequency, reason]：
{"items": {"<技能名>": ["keep", "daily", "≤20字理由"], ...}}
清单里的每一条都要出现在 items 里；reason ≤20 字；不要输出 JSON 以外的任何文字。`;
}
