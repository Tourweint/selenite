// 桶状再导出（2026-11-08 扫尾批 8b）：实现按职责拆到 `agent/` 下，对外导出面不变。
//
// 依赖方向：shared ← policy / assist / turn-gate ← lifecycle ← session ← 本文件。
// 引用方（index / approval-api / group-runtime / autonomy / memory-* / partner-runtime /
// relay-* / openai-compat / routines / topic-runtime / delegation-api）的 import 一律不动。

export {
	getPolicy,
	readOnlyBlockReason,
	setPolicy,
} from "./agent/policy.ts";
export type { ToolAccess } from "./agent/policy.ts";

export { TURN_LIMIT_MESSAGE } from "./agent/turn-gate.ts";

export {
	memoryEngine,
	preferenceScopeOf,
	seedChiefPartner,
	skillStore,
	taskMemoryBlock,
	workerChatEnabled,
} from "./agent/assist.ts";

export {
	TASK_CONVERSATION_PREFIX,
	watchAllEvents,
	watchPhase,
	watchTool,
} from "./agent/shared.ts";
export type {
	GlobalAgentEvent,
	ResolvedChat,
	ToolEvent,
	TurnPhase,
} from "./agent/shared.ts";

// 轮次收尾（2026-11-08 批 10-A 下沉）：普通轮 / 编辑重发 / 审批续跑共用同一套
// 观察层 + 记忆抽取 + 会话记忆修剪。观察层由 index.ts 启动时注入，避免 agent/ 内部成环。
export { setTurnSettledObserver, turnSettledHandler } from "./agent/settled.ts";
export type { SettledChat, TurnSettledObserver } from "./agent/settled.ts";

export {
	getHarness,
	reportDelegationResult,
	sayInChat,
	sayInConversation,
	stickyThinkingLevel,
} from "./agent/lifecycle.ts";

export {
	addReminder,
	applyChatMode,
	chatKindOf,
	chatMetaSummary,
	chatStream,
	chatTitles,
	configureResearchChat,
	configureTaskChat,
	contextUsageOf,
	conversationThinkingLevel,
	externalChatIds,
	forkForEdit,
	forgetMemory,
	hideChat,
	listChats,
	listReminders,
	memoryOverview,
	messageIdOf,
	openChat,
	openOrCreateChat,
	pinChat,
	readTranscript,
	renameChat,
	restoreChats,
	searchTranscripts,
	startChatCompaction,
	stopChat,
	supersedeMemory,
	usageSummary,
	waitChatCompaction,
} from "./agent/session.ts";
export type {
	ChatIndexEntry,
	ChatStreamEvent,
	ChatStreamInput,
	CompactTaskId,
	MemoryOverview,
	MemoryView,
	ReminderSummary,
	SearchHit,
	TranscriptMessage,
	UsageSummary,
} from "./agent/session.ts";
