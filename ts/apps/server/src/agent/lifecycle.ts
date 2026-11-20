/** lifecycle.ts */

/* 2026-11-13 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { LIFECYCLE_SECTIONS, beginHarnessMaintenance, closeHarnessForMaintenance, endHarnessMaintenance, getHarness, getHarnessForMaintenance, harnessMaintenanceActive, lifediaryExt, runExclusiveMaintenance } from "./lifecycle-harness.ts";
export { rememberLevel, reportDelegationResult, sayInChat, sayInConversation, stickyThinkingLevel } from "./lifecycle-thinking.ts";
