/**
 * 契约包入口（2026-11-13 从 1,335 行单文件拆成 7 个分区文件；本文件只剩 re-export）。
 *
 * 拆之前这里是一份单文件契约：服务端用 tsx、App 用 Metro，两边对相对导入的扩展名解析不完全一致，
 * 单文件最不容易出岔子。拆开后按分区拆文件、本文件统一出口，导入路径仍是 @lifediary/shared。
 * 分区之间的依赖必须无环（构建期用依赖图断言），否则 const 求值会踩 TDZ。
 */

export { ChatKindSchema, ChatMessageSchema, ContentPartSchema, FilePartSchema, ImagePartSchema, NewChatKindSchema, RoleSchema, TextPartSchema, ThinkingLevelSchema, chatContentText } from "./chat-base.ts";
export type { ChatKind, ChatMessage, ContentPart, FilePart, ImagePart, NewChatKind, Role, TextPart, ThinkingLevel } from "./chat-base.ts";
export { ChatRequestSchema, ChatTranscriptSchema, FILE_MANIFEST_HINT, FILE_MANIFEST_PREFIX, MAX_FILES_PER_MESSAGE, TranscriptFileSchema, TranscriptImageSchema, TranscriptMessageSchema, TranscriptStepSchema, parseFileManifest, renderFileManifest } from "./chat-schemas.ts";
export type { ChatRequest, ChatTranscript, TranscriptFile, TranscriptImage, TranscriptMessage, TranscriptStep } from "./chat-schemas.ts";
export { FinishReasonSchema, GROUP_MEMBER_MAX, GROUP_MEMBER_MIN, GROUP_MESSAGE_LIMIT, GroupChatRequestSchema, GroupMemberSchema, GroupMessageSchema, GroupMetaSchema, GroupResponderKindSchema, GroupRoundSchema, PartnerStatusSchema } from "./group-schemas.ts";
export type { FinishReason, GroupChatRequest, GroupMember, GroupMessage, GroupMeta, GroupResponderKind, GroupRound, GroupSender, PartnerStatus, TurnUsage } from "./group-schemas.ts";
export type { ChatEvent, ReplayEvent, StreamErrorCode, TurnPhase } from "./chat-events.ts";
export { createSseDecoder, encodeSseEvent } from "./chat-codec.ts";
export { DelegationPhaseSchema, PARTNER_AVATAR_MAX_BYTES, PARTNER_AVATAR_MAX_CHARS, PARTNER_AVATAR_MAX_DIMENSION, PARTNER_AVATAR_PREFIX, RELAY_MAX_FRAME_BYTES, RELAY_PROTOCOL_VERSION, RELAY_PUSH_CHANNEL_PREFIX, RelayActorClaimResultSchema, RelayDeliverSchema, RelayDeviceViewSchema, RelayErrorCodeSchema, RelayErrorFrameSchema, RelayHelloSchema, RelayInvokeFrameSchema, RelayInvokePayloadSchema, RelayInvokeResultFrameSchema, RelayJoinRequestSchema, RelayJoinResponseSchema, RelayMetaActionSchema, RelayMetaRequestSchema, RelayPingSchema, RelayPongSchema, RelayPresenceFrameSchema, RelayResultSchema, RelayRoutedSchema, RelayWelcomeSchema, RemoteDelegationAcceptSchema, RemoteDelegationStatusSchema } from "./relay-schemas.ts";
export type { DelegationPhase, RelayActorClaimResult, RelayActorMeta, RelayDeliver, RelayDeviceView, RelayErrorCode, RelayErrorFrame, RelayHello, RelayInvokeFrame, RelayInvokePayload, RelayInvokeResultFrame, RelayJoinRequest, RelayJoinResponse, RelayMetaAction, RelayMetaRequest, RelayPresenceFrame, RelayResult, RelayRouted, RelayWelcome, RemoteDelegationAccept, RemoteDelegationStatus } from "./relay-schemas.ts";
export { PartnerAvatarPatchSchema, PartnerAvatarSchema, partnerAvatarProblem } from "./avatar-png.ts";
export type { PartnerAvatar, PartnerAvatarPatch } from "./avatar-png.ts";
export { FileContentResponseSchema, FileEntrySchema, FileListResponseSchema, ModelChainItemSchema, OpenExplorerRequestSchema, PartnerProfileSchema, RoutineDefSchema, RoutineRunRecordSchema, RoutineRunStatusSchema, RoutineTriggerSchema } from "./partner-schemas.ts";
export type { FileContentResponse, FileEntry, FileListResponse, ModelChainItem, OpenExplorerRequest, PartnerProfile, RoutineDef, RoutineRunRecord, RoutineRunStatus, RoutineTrigger } from "./partner-schemas.ts";
