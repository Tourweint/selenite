/** durable-delete.ts */

/* 2026-11-14 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { buildForkChildrenIndex, chatHardDeleteEnabled, deleteSubtreeRows, estimateSubtree, forkSubtreeOf } from "./durable-delete-delete-subtree-rows.ts";
export type { ConversationRow, DeletionBlocked, DeletionBlockedReason, DeletionEstimate, DeletionFailure, DeletionPreview, DeletionPreviewNode } from "./durable-delete-delete-subtree-rows.ts";
export { deleteChatForever, previewChatDeletion } from "./durable-delete-plan-chat-deletion.ts";
export { mountDurableDelete } from "./durable-delete-mount-durable-delete.ts";
