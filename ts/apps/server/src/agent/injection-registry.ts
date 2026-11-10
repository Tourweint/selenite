/**
 * 注入登记表（2026-11-10 批 27 §四）。
 *
 * **显式列全，不自动扫描**：顺序稳定才谈得上缓存前缀；自动发现会让"谁先谁后"
 * 取决于 import 顺序。
 *
 * `source` 只用于审计区分来源模块（`lifecycle` / `assist` / `partner-context`），
 * 不进正文、不下发正文。`settled.ts` 没有提示词注入（只有记忆写入 / 导出 / 观察层），
 * 因此这里没有它的条目——2026-11-10 批 27 核对确认。
 */

import { guardProvider, type RegisteredInjection } from "./injection.ts";
import {
	clarifyContractProvider,
	currentProjectProvider,
	personaProvider,
	recoverNoteProvider,
	skillSlashProvider,
	skillsProvider,
	topicsProvider,
	turnLimitProvider,
	verificationIronLawProvider,
} from "./lifecycle-injections.ts";
import { memoryRecallProvider, taskMemoryProvider } from "./assist.ts";
import { partnerContextInjectionProvider } from "./partner-context.ts";

export const INJECTION_REGISTRY: readonly RegisteredInjection[] = [
	// ── lifecycle：7 个 section + 4 处消息注入 ──────────────
	{ source: "lifecycle", provider: personaProvider },
	{ source: "lifecycle", provider: verificationIronLawProvider },
	{ source: "lifecycle", provider: clarifyContractProvider },
	{ source: "lifecycle", provider: guardProvider },
	{ source: "lifecycle", provider: currentProjectProvider },
	{ source: "lifecycle", provider: skillsProvider },
	{ source: "lifecycle", provider: topicsProvider },
	{ source: "lifecycle", provider: skillSlashProvider },
	{ source: "lifecycle", provider: recoverNoteProvider },
	{ source: "lifecycle", provider: turnLimitProvider },
	// 执事上下文（第 5 处 extra.push）的实际段来自 partner-context，单独挂在下面：
	// 那里按段（契约 / 目标 / 纪律 / 在办）展开，审计粒度更细；live 路径仍拼成一条消息。
	// ── assist：记忆召回 + 任务近况 ───────────────────────
	{ source: "assist", provider: memoryRecallProvider },
	{ source: "assist", provider: taskMemoryProvider },
	// ── partner-context：执事轮各段纪律 ───────────────────
	{ source: "partner-context", provider: partnerContextInjectionProvider },
];
