import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 任务模板（2026-10-30，设计文档 §4 方案 A：模板上移）。
 *
 * 为什么模板在服务端：日记任务（收敛 / 周报 / 分段 / 题目 / 回忆）原先由 App 把整份 prompt
 * 塞进 `system` 走"直通"路径 —— 直通不建会话、不落库，那段对话过完即弃。
 * 要让"说过的话"归位 harness（手机只留索引），任务必须走 Agent 通道；
 * 而 Agent 通道只吃最后一条用户消息，所以整份 prompt 必须由服务端按任务名渲染。
 *
 * 形态（本轮自选，理由见变更记录）：
 * - 一份任务 = 一个 `.md` 资产文件，文件名带版本号（`diary_convergence_v2.md`）；
 * - **资产字节与 App 侧 `core/ai/src/main/assets/prompts/` 完全一致**（逐字节复制），
 *   这样"上移"不会偷偷改动 prompt 内容，黄金用例可以直接断言字节相等；
 * - 变量占位是 App 同款 `{{key}}`；与 App 的差别只有一条：**缺变量直接报错**，
 *   因为 App 那边漏注入会留下 `{{x}}` 进模型、很难发现。
 *
 * 版本号 = 文件名去掉 `.md`（`diary_convergence_v2`），回退 = 改一张表 + 文件还在。
 */

const PROMPT_DIR = new URL("../prompts/", import.meta.url);

/** 任务通道上一次渲染所需的输入。变量为空的模板不需要 `vars`。 */
export interface TaskSpec {
	/** 对外的任务名（`X-Task` 取值，大小写不敏感） */
	name: string;
	/** 资产文件名（带版本号，也是日志/留痕里的版本标识） */
	asset: string;
	/** 模板里允许出现的变量名；缺一个就渲染失败 */
	vars: readonly string[];
	/**
	 * 落进 durable 会话的那句"用户输入"。
	 *
	 * 为什么不把整份 prompt 当输入：它是 system 指令，不是用户说的话；
	 * 写进 transcript 会让回读出来的历史变成一大段规则，用户看不懂。
	 */
	input: string;
}

const SPECS: readonly TaskSpec[] = [
	{
		name: "converge",
		asset: "diary_convergence_v2.md",
		vars: ["user_messages", "entry_types"],
		input: "请整理成稿",
	},
	{
		name: "weekly",
		asset: "weekly_report_v2.md",
		vars: ["positive_facts", "profile_markdown"],
		input: "请按上面的约束写这一周的回顾",
	},
	{
		name: "segment",
		asset: "entry_segmentation_v1.md",
		vars: ["entry_text"],
		input: "请按上面的格式只输出 JSON",
	},
	{
		name: "interview",
		asset: "recall_interview_v2.md",
		vars: ["last_session_digest", "recent_messages"],
		input: "继续引导下一句",
	},
	{
		name: "chapter",
		asset: "recall_chapter_v2.md",
		vars: ["user_messages"],
		input: "请整理成章",
	},
	{
		name: "question",
		asset: "question_generation_v1.md",
		vars: ["tone", "question_length", "depth"],
		input: "请按上面的语气与规范，生成今天的一个问题。",
	},
	// ── 2026-10-31 方案 §6 步骤 3 批次（App 补齐剩余任务）──────────────
	// 变量名跟模板资产走（方案 §5 表里的 entry_text 等是示意，实际以资产占位符为准）。
	{
		name: "entry_view_polish",
		asset: "entry_view_polish_v1.md",
		vars: ["original_text"],
		input: "请照上面的格式输出",
	},
	{
		name: "entry_view_digest",
		asset: "entry_view_digest_v1.md",
		vars: ["original_text"],
		input: "请照上面的格式输出",
	},
	{
		name: "emotion_deep_dive",
		asset: "emotion_deep_dive_v1.md",
		vars: ["recent_messages", "style_constraints"],
		input: "给我一个往下走一层的问题",
	},
	{
		name: "memory_curation",
		asset: "memory_curation_v2.md",
		vars: ["entry_text", "current_memory"],
		input: "请按 Default Deny 维护记忆",
	},
	{
		name: "memory_merge",
		asset: "memory_merge_v2.md",
		vars: ["blocks_json", "new_facts", "word_limit"],
		input: "请合并画像",
	},
	{
		// 2026-10-31 方案 §10（v1.2）：日记回顾小模式。模板生在 harness（App 侧没有旧资产），
		// 黄金用例走内容断言而非字节对照（probe 的 harnessOnly 分支）。
		name: "diary_review",
		asset: "diary_review_v1.md",
		vars: ["recent_entries"],
		input: "请做这次回顾",
	},
];

/** 渲染失败（缺变量 / 资产缺失）：调用方据此回 500，且**不落半条会话** */
export class TaskRenderError extends Error {
	constructor(
		readonly task: string,
		readonly reason: string,
	) {
		super(`任务 ${task} 渲染失败：${reason}`);
	}
}

const templates = new Map<string, string>();

function readTemplate(asset: string): string {
	const cached = templates.get(asset);
	if (cached !== undefined) return cached;
	try {
		const text = readFileSync(fileURLToPath(new URL(asset, PROMPT_DIR)), "utf8");
		templates.set(asset, text);
		return text;
	} catch (error) {
		throw new TaskRenderError(asset, `模板资产读不到（${error instanceof Error ? error.message : String(error)}）`);
	}
}

/** 任务名（大小写不敏感）→ 定义；未知任务返回 undefined（HTTP 层回 400） */
export function resolveTask(name: string): TaskSpec | undefined {
	const wanted = name.trim().toLowerCase();
	return SPECS.find((spec) => spec.name === wanted);
}

/** 未知任务的合法取值，写进 400 的提示里，省得客户端猜 */
export function taskNames(): string[] {
	return SPECS.map((spec) => spec.name);
}

/** 版本标识：`converge@diary_convergence_v2`（日志/留痕用） */
export function taskLabel(spec: TaskSpec): string {
	return `${spec.name}@${spec.asset.replace(/\.md$/, "")}`;
}

/**
 * 渲染：`{{key}}` 字面替换（与 App 的 `PromptAssets.render` 同算法）。
 *
 * 与 App 的唯一差别：**变量缺失/非字符串 → 抛错**。App 那边未注入的占位符会原样进模型，
 * 输出看起来"有点怪"但不报错，排查成本很高；这里宁可 500。
 */
export function renderTask(spec: TaskSpec, vars: Record<string, unknown>): string {
	const missing: string[] = [];
	let prompt = readTemplate(spec.asset);
	for (const key of spec.vars) {
		const value = vars[key];
		if (typeof value !== "string") {
			missing.push(key);
			continue;
		}
		prompt = prompt.split(`{{${key}}}`).join(value);
	}
	if (missing.length > 0) {
		throw new TaskRenderError(spec.name, `缺少变量 ${missing.join(", ")}`);
	}
	// 兜底：模板里写了未声明的占位符（改模板时忘了登记）同样算渲染失败
	const leftover = /\{\{[a-z_][a-z0-9_]*\}\}/.exec(prompt);
	if (leftover) {
		throw new TaskRenderError(spec.name, `模板里有未声明的占位符 ${leftover[0]}`);
	}
	return prompt;
}

/** 读取模板原文（黄金用例用：断言与 App 侧资产逐字节一致） */
export function templateOf(spec: TaskSpec): string {
	return readTemplate(spec.asset);
}

/** 全部任务的模板快照（探针遍历用） */
export function allTasks(): readonly TaskSpec[] {
	return SPECS;
}
