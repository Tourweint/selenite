/**
 * 纯判定函数的小回归集（2026-11-10 批 20 §三）。
 *
 * 这是**测试资产**，不是运行时功能：服务端不 import 本模块，也没有开关。
 *
 * 为什么单独成池：`needsApproval()` 与 `resolveUnattendedVerdict()` 决定"谁会被拦 /
 * 被问 / 被跳过"，改一个 if 就可能把安全语义改反；但它们没有任何外部依赖，适合用
 * 一份小而全的案例表钉住。tune / holdout 两池用来防"照着测试改代码"：
 *   - `tune`：日常开发跟着改，允许在需求变化时更新期望；
 *   - `holdout`：**只在发布前跑**，平时不改；如果它突然红了，先怀疑实现而不是改期望。
 *
 * 2026-11-10 批两个池都跑（任务书 §3.2），但用途按上面的口径标清楚。
 *
 * 2026-11-12 扩容（总账 #34"其余函数待补"）：新增三个池，照同款 12 条 6/6 分法——
 *   - `resolveDelegateRouting`（执事直派四象限 + 总闸回滚，`delegate-routing.ts`）；
 *   - `autonomyEscalationBlockReason`（自主轮结构性拒绝：扩权表 / 遥控设备 / project，`autonomy-risk.ts`）；
 *   - `delegationRunSource`（派单来源优先级：测试 > 设备 > 例行轮 > 人，`run-source.ts`）。
 * 入选口径：同输入同输出、无 IO、无时钟；env / 开关一律显式传，不读开发机环境。
 * 调查过但**没有**入池的：`LoopGuard`（状态类且读 `Date.now()`，不是纯函数）、
 * `readOnlyBlockReason`（读模块级可变 `policy`，import 时读盘 / env）。
 */

/* 2026-11-14 按职责整段切到同目录的多个文件；本文件只做 re-export，保持原路径的导入方零改动。 */

export type { ApprovalEvalInput, DelegateRoutingEvalInput, EvalCase, EvalOutcome, EvalPoolName, UnattendedEvalInput } from "./eval-pool-approval-cases.ts";
export type { EscalationEvalInput, RunSourceEvalInput } from "./eval-pool-delegate-routing-cases.ts";
export { evalCases, runApprovalPool, runAutonomyEscalationPool, runDelegateRoutingPool, runRunSourcePool, runUnattendedPool } from "./eval-pool-run-source-cases.ts";
