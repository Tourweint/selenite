/**
 * 派活的进度与「需要你」事件（2026-11-02；2026-11-03 补异步任务单字段）。
 *
 * 为什么单独一个模块：发事件的是工具（`tools.ts` 里的 `delegate`），
 * 收事件的是对话流（`agent.ts` 的 `chatStream`）。这两个文件本来就互相引用，
 * 再把通道塞进其中一边就会成环。放中间，两边都只依赖它。
 *
 * 2026-11-03：派单改成"立即受理、后台执行"。`startDelegation` 是这一段的最小骨架：
 * 同步返回任务单号，后台跑完再发事件 / 写汇报。真正的进程管理仍然在 chancellor 里。
 *
 * 2026-11-04：审批事件**借道本通道**（`type: "approval"`），因为它与派活同样是
 * "工具钩子写、对话流读"的一对多通道。只是借传输，与派活语义无关。
 */

/* 2026-11-14 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export { ATTENTION_ONE_QUESTION, ATTENTION_REPLY_GUIDANCE, CLARIFY_CONTRACT, DELEGATION_STEPS_MAX, DELEGATION_STEP_MAX_CHARS, GROUNDING_DISCIPLINE, MANAGER_SOUL_LIMIT_BYTES, REPORT_FOUR_LINES, WORK_REVIEW_GUIDANCE, WORK_SILENCE_DISCIPLINE, buildManagerIdentity, chancellorWorkRoot, clarifyContractEnabled, clarifyContractFor, emitDelegation, formatMessageLine, formatProgressLine, formatReport, normalizeDelegationIsolation, normalizeDelegationSteps, truncate, watchAllDelegationEvents, watchDelegation } from "./delegation-delegation-kickoff.ts";
export type { DelegationEvent, DelegationIsolation, DelegationKickoff, DelegationMirrorEntry, DelegationReport, DelegationRuntime } from "./delegation-delegation-kickoff.ts";
export { startDelegation } from "./delegation-start-delegation.ts";
