/**
 * 模型辅助巩固 + 已存记忆导入的**装配层**（2026-11-08 扫尾批 6 §二/§三）。
 *
 * 分工照 `memory-extract.ts` 的先例：
 * - `@lifediary/memory` 只管"规范化去重 / 只增不改地入库"这些纯规则；
 * - 这里负责"用哪个模型、超时多久、失败怎么说、建议落到哪"。
 *
 * **D18 底线（不可动摇）**：自动化只做强化 / 衰减 / 确定性同义收敛。
 * 本模块的模型调用**只产出建议**——一条都不执行；执行必须由人在设置页逐条点"应用"，
 * 走既有 `supersede()`（旧记录保留可追溯）。没有"全部应用"。
 *
 * 红线（AGENTS.md）：日志只记条数 / 字数 / 耗时 / 枚举；正文不进日志，
 * 原始错误只留摘要（可能带上游地址）。
 */

/* 2026-11-14 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { CONSOLIDATE_PROMPT, MAX_PROPOSALS, MAX_REVIEW_RECORDS, consolidateJobEnabled, consolidateLlmEnabled, memoryImportEnabled, parseProposalJson, renderReviewInput, reviewModelAvailable, validTargetScope } from "./memory-consolidate-parse-proposal-json.ts";
export type { ConsolidateProposal, ProposalDraft, ProposalSide, ReviewGenerator, ReviewResult } from "./memory-consolidate-parse-proposal-json.ts";
export { MAX_IMPORT_ITEMS, applyProposal, importMemory, pendingProposalCount, readPendingProposals, reviewScope } from "./memory-consolidate-review-scope.ts";
export type { ApplyResult, ImportResult, ReviewJobHandle, ReviewState, StartReviewOptions } from "./memory-consolidate-review-scope.ts";
export { dismissProposal, reviewState, startReview } from "./memory-consolidate-start-review.ts";
