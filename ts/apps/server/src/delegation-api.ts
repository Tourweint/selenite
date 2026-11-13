/** delegation-api.ts */

/* 2026-11-13 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { acceptanceChecksEnabled, buildTicketGates, delegationCancelEnabled, fanoutGroupEnabled, ticketGatesEnabled } from "./delegation-gates.ts";
export type { TicketGate } from "./delegation-gates.ts";
export { projectAcceptanceChecks, projectTicketBgJobs, ticketBgJobsEnabled } from "./delegation-checks.ts";
export type { AcceptanceCheck, AcceptanceCheckStatus, ActionStatus, TicketActionResult, TicketBgJob } from "./delegation-checks.ts";
export { applyCancelProjection } from "./delegation-jobs.ts";
export type { DelegationApiOptions } from "./delegation-summary.ts";
export { mountDelegationApi } from "./delegation-mount.ts";
export { cancelTicketAction, projectHasInFlightTickets, retryTicketAction } from "./delegation-actions.ts";
