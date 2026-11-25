/** partner-runtime.ts */

/* 2026-11-14 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { ensurePartnerSession, partnerCanonicalExternalId, partnerGreetingEnabled, renderPartnerIdentity, runPartnerTurn, setGoalTurnSink } from "./partner-runtime-run-partner-turn.ts";
export type { GoalTurnSignal, OpenPartnerConversationResult, PartnerGreetingOutcome, PartnerTurnOptions, PartnerTurnResult } from "./partner-runtime-run-partner-turn.ts";
export { openPartnerConversation } from "./partner-runtime-do-open-partner-conversation.ts";
