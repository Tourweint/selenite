/**
 * 杂活模型（auxiliary LLM）一等化（2026-11-10 批 20 §二）。
 *
 * 问题：偏好抽取已经用"独立的一次性模型调用"，但"用哪个模型"是按当前会话模型隐式决定的，
 * 散的。标题 / 压缩 / 裁判这些同样"短输入短输出"的活以后也需要能单独指定一个小模型。
 *
 * 这一层只回答一个问题：**某用途该用哪个模型**。
 *   - 用途枚举是固定的五种（`title` / `compact` / `vision` / `review` / `extract`）；
 *   - 每个用途可以用 `AUX_MODEL_<USE>` pin 一个模型 id；
 *   - 没配 / 配的名字不在目录里 → 回落当前会话模型（行为与改动前一致）；
 *   - `AUX_LLM=false` → 全部回落当前模型（一行回滚）。
 *
 * 接线状态（2026-11-10 批 23b §三 / 批 28 §三）：
 *   - 已接：`extract`（`memory-extract.ts` 偏好抽取）、`review`（`routine-gate.ts` 例行条件判定
 *     + `memory-consolidate.ts` 的语义整理建议，后一处是批 23b 补的）；
 *   - `compact`：内核 `Conversation.compact()` 只收 `instructions` + `Context`，压缩模型由当前
 *     会话模型与 compaction policy 决定，**无法指定单独的压缩模型**——批 26b 起配置照常能解析，
 *     `startChatCompaction` 会记一条"内核不支持指定压缩模型"日志，不静默失效；
 *   - **当前无调用点**：`title`（没有自动标题）、`vision`（没有 vision / 图片理解场景）——
 *     见下方 `NO_CALL_SITE_USES`。两者保留接口是为了将来做会话自动命名 / 图片理解时直接用，
 *     调用 `auxiliaryModel()` 时会打一条 warn 提醒"配了不会生效"（2026-11-10 批 28 §三）。
 *
 * 这一层不做模型调用本身——调用方自己决定超时 / 重试 / 失败语义。
 */

import type { ModelRef } from "./provider.ts";
import { currentModels, readLlmConfig } from "./provider.ts";

export type AuxUse = "title" | "compact" | "vision" | "review" | "extract" | "advice" | "split";

/** 用途清单（文档 / 探针用；新增用途时这里与 `AuxUse` 一起改）。 */
export const AUX_USES: readonly AuxUse[] = [
	"title",
	"compact",
	"vision",
	"review",
	"extract",
	"advice",
	"split",
];

/**
 * 当前**无调用点**的用途（2026-11-10 批 28 §三）：把"没有调用点"写进代码，不只在变更记录里。
 *
 * - `title`：没有自动标题功能。保留接口，是因为将来做**会话自动命名**时直接有一个
 *   `AUX_MODEL_TITLE` 可用，不必再改这一层。
 * - `vision`：当前没有 vision 场景（图片理解尚未接入）。保留接口，是因为将来做
 *   **图片理解**时直接用 `AUX_MODEL_VISION`，不必再改这一层。
 *
 * 两者都"配了也不会生效"——没有任何生产代码会拿它们去发模型调用。为避免有人配了
 * `AUX_MODEL_TITLE` / `AUX_MODEL_VISION` 以为生效，`auxiliaryModel()` 被调用到这两个用途时
 * 打一条 warn（进程内只一次，见 `warnedNoCallSite`），提示"该用途当前无调用方，配置不会生效"。
 * `compact` 不在此列：批 26b 已由 `startChatCompaction` 单独记"内核不支持指定压缩模型"日志，
 * 属另一条已登记的口径；`review` / `extract` 是已接线的正常用途；
 * `advice`（批 30）由技能分类建议接线的正常用途。
 */
const NO_CALL_SITE_USES: ReadonlySet<AuxUse> = new Set<AuxUse>(["title", "vision"]);

/** 进程内"只告警一次"记账；单测可注入独立 Set 隔离，避免用例互相吃掉告警。 */
const warnedNoCallSite = new Set<AuxUse>();

/**
 * 总开关：默认开；只有显式 `false` 才关（与仓库里其它"默认开"的开关同口径）。
 * 关掉 = 所有用途都回到当前会话模型，行为与引入本模块之前逐字节一致。
 */
export function auxiliaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.AUX_LLM ?? "").trim().toLowerCase() !== "false";
}

/** 某用途 pin 的模型 id；没配 / 空白 → null（不是"配了空串"，是没配）。 */
export function auxPinnedModelId(use: AuxUse, env: NodeJS.ProcessEnv = process.env): string | null {
	const raw = env[`AUX_MODEL_${use.toUpperCase()}`]?.trim();
	return raw || null;
}

/** 只依赖 Models 的查询面，单测可传替身，不用真起 provider 目录。 */
interface AuxModelLookup {
	getModel(provider: string, id: string): unknown;
	getProviders(): readonly { id: string }[];
}

export interface AuxiliaryDeps {
	env?: NodeJS.ProcessEnv;
	/** 当前会话模型；不传就读 `readLlmConfig()`（拿不到 = 没有可用模型） */
	current?: ModelRef | null;
	models?: AuxModelLookup;
	/** 注入 warn 以便单测断言（2026-11-10 批 28 §三）；缺省 console.warn。 */
	warn?: (message: string) => void;
	/** 注入"已告警用途"集合以便单测隔离；缺省进程内单例（每个用途只告警一次）。 */
	warned?: Set<AuxUse>;
}

/**
 * 某用途实际该用的模型引用。
 *
 * 解析顺序：
 *   1. 没有当前模型 → null（调用方按"没有模型"处理）；
 *   2. `AUX_LLM=false` 或该用途没 pin → 当前模型；
 *   3. pin 的名字先在当前供应商里找，再按目录顺序找同名模型（同名跨供应商不能猜，
 *      先认当前这一家）；找不到 → **回落当前模型并 warn**，不静默换一家不存在的模型。
 *
 * 返回 null 只表示"没有可用的 LLM"，不表示"pin 配错了"。
 */
export function auxiliaryModel(use: AuxUse, deps: AuxiliaryDeps = {}): ModelRef | null {
	const env = deps.env ?? process.env;

	// 无调用点用途（title / vision）：调用即提示"配了也不会生效"，进程内只一次。
	// 仍照常往下走、返回解析结果——不因为"没接线"就改变模型解析契约（§3.3 配了返回配置值）。
	if (NO_CALL_SITE_USES.has(use)) {
		const warned = deps.warned ?? warnedNoCallSite;
		if (!warned.has(use)) {
			warned.add(use);
			(deps.warn ?? console.warn)(
				`[aux] ${use} 用途当前无调用方，AUX_MODEL_${use.toUpperCase()} 配置不会生效`,
			);
		}
	}

	const current = deps.current === undefined ? (readLlmConfig()?.model ?? null) : deps.current;
	if (!current) return null;
	if (!auxiliaryEnabled(env)) return current;

	const pinned = auxPinnedModelId(use, env);
	if (!pinned) return current;

	const models = deps.models ?? currentModels();
	if (models.getModel(current.provider, pinned)) {
		return { provider: current.provider, modelId: pinned };
	}
	for (const provider of models.getProviders()) {
		if (models.getModel(provider.id, pinned)) {
			return { provider: provider.id, modelId: pinned };
		}
	}

	// 配错不换路由：回落当前模型，只记用途枚举与模型名（没有对话内容）
	console.warn(
		`[aux] AUX_MODEL_${use.toUpperCase()}=${pinned} 不在模型目录里，回落当前模型`,
	);
	return current;
}
