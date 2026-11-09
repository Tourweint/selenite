/**
 * 杂活模型（auxiliary LLM）一等化（2026-11-10 批 20 §二）。
 *
 * 问题：偏好抽取已经用"独立的一次性模型调用"，但"用哪个模型"是按当前会话模型隐式决定的，
 * 散的。标题 / 压缩 / 裁判这些同样"短输入短输出"的活以后也需要能单独指定一个小模型。
 *
 * 这一层只回答一个问题：**某用途该用哪个模型**。
 *   - 用途枚举是固定的四种（`title` / `compact` / `review` / `extract`）；
 *   - 每个用途可以用 `AUX_MODEL_<USE>` pin 一个模型 id；
 *   - 没配 / 配的名字不在目录里 → 回落当前会话模型（行为与改动前一致）；
 *   - `AUX_LLM=false` → 全部回落当前模型（一行回滚）。
 *
 * 本批只接线 `extract`（`memory-extract.ts`）；`title` 因为当前没有自动标题而**不接线**，
 * 其余用途留接口不接。这一层不做模型调用本身——调用方自己决定超时 / 重试 / 失败语义。
 */

import type { ModelRef } from "./provider.ts";
import { currentModels, readLlmConfig } from "./provider.ts";

export type AuxUse = "title" | "compact" | "review" | "extract";

/** 用途清单（文档 / 探针用；新增用途时这里与 `AuxUse` 一起改）。 */
export const AUX_USES: readonly AuxUse[] = ["title", "compact", "review", "extract"];

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
