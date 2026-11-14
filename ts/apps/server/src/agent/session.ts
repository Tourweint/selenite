/** session.ts */

/* 2026-11-13 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { applyChatMode, chatKindOf, chatKindOfInternal, configureJudgeChat, configureResearchChat, configureTaskChat, conversationThinkingLevel, externalChatIds, forkForEdit, openChat, openOrCreateChat, startChatCompaction, waitChatCompaction } from "./session-open.ts";
export type { CompactTaskId } from "./session-open.ts";
export { chatStream, conversationIsBusy, stopChat } from "./session-stream.ts";
export type { ChatStreamEvent, ChatStreamInput } from "./session-stream.ts";
export { addReminder, cancelReminder, contextUsageOf, continueConversation, foldTranscriptEntries, listReminders, messageIdOf, readTranscript, rescheduleReminder, usageSummary } from "./session-transcript.ts";
export type { ReminderSummary, TranscriptMessage, UsageSummary } from "./session-transcript.ts";
export { archiveChat, archiveChatGuarded, chatMetaSummary, hideChat, pinChat, pruneChatMetaOrphans, purgeChatMetaEntries, readChatMeta, renameChat, restoreArchivedChats, restoreChats, unarchiveChat } from "./session-meta.ts";
export type { ChatIndexEntry, ChatMeta } from "./session-meta.ts";
export { archiveChatsOfProject, archivedChatPairs, chatTitles, forgetMemory, listChats, listChatsForExport, memoryOverview, projectChatExternalIds, readChatStats, supersedeMemory } from "./session-index.ts";
export type { ChatStats, MemoryOverview, MemoryView } from "./session-index.ts";
export { findEvidence, listArchivedChats, searchTranscripts } from "./session-evidence.ts";
export type { EvidenceHit, SearchHit } from "./session-evidence.ts";
