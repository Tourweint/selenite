# 批 23b 变更记录：auxiliary 再接两处 + delegate 迁统一契约

日期：2026-11-10
上位：`docs/设计方案/2026-11-10-批23任务书（补齐四条欠账）.md` §三 / §四（§一 / §二 已在批 23a 落地）
状态：已落地（**未 commit**；零 `shared` / 零 chancellor 改动；未碰 `delegation-judge.ts` /
`delegation-judge.test.ts` / 总账文件）
影响面：`ts/apps/server/src/{auxiliary,memory-consolidate,tools,tool-result}.ts`、
`apps/server/src/{auxiliary,tool-result}.test.ts`、
`docs/基线文档/{接口文档,系统架构}.md`

## 一、#32：auxiliary 再接两处（§三）

### 1. `review`：已接（记忆巩固的语义整理建议）

- 调用点就是 `memory-consolidate.ts` 的 `generateReview()`——「找重复 / 更正的记忆条目、
  只出建议不执行」那一次独立模型调用（`completeSimple`，不进主会话）。
- 改法：模型引用从 `config.model` 换成 `auxiliaryModel("review", { current: config.model }) ?? config.model`；
  `AUX_MODEL_REVIEW` 可以给这活单独 pin 一个模型，没配 / `AUX_LLM=false` 逐字节回落当前会话模型。
- 注意：`review` 原本已用于 `routine-gate.ts` 的例行条件判定（批 21 §三）。两处都是
  「短输入短输出的一次性判断」，共用同一个用途 pin 是原设计意图；本次只是把第二条消费点也接上。
- 单测：`auxiliary.test.ts` 新增「已接用途：pin 了用 pin 的模型，没配回落当前模型」，
  对 `extract` / `review` 两个已接用途各断言一次。

### 2. `compact`：**跳过，内核不支持指定压缩模型**

核对（2026-11-10）：`Conversation.compact` 的签名是
`compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>>`
（`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:693`）——只有 `instructions` 与
`Context`，没有模型参数；摘要模型由会话当前模型 + `compactionPolicy(settings, model)` 决定
（`harness/compaction.d.ts:39`）。`startChatCompaction`（`agent/session.ts:101`）也无处转交模型。
**不是这里不接，是内核没有这个入口**；要接得先改 durable 的压缩契约（跨仓库，本批明确不做）。

`title` 仍不接：当前没有自动标题，没有调用点可接（不为接线硬造）。

## 二、五§八#1：只迁 `delegate`（§四）

- 外层从裸文本 / 裸 JSON 改成 `ToolResult`：成功 `{ok:true,data:{message,…}}`，
  真正的失败 `{ok:false,error:{code,message}}`；**所有人读文案逐字未改**。
- **业务分支原样进 `data`**（不塞 `error`）：
  - `needs_project` → `data: {error:"needs_project", message, projects}`（连字段名一起保留，
    只去掉原先内层的 `ok`；候选项目清单不丢）；
  - `invalid_steps` / `uncertain`（带 `ticketId`）→ 同样按业务分支放 `data`；
  - 已受理 / 续跑 / 幂等命中 → `data` 额外带 `ticketId`（有领域时带 `domain`）；
  - 远端派发成功 → `data` 带 `deviceName` / `requestId`（`pickedHome` 时有该标记）。
- **真正的失败走 `err`**：路由拒绝（`delegate_rejected`）、自动挑机关（`auto_disabled`）、
  设备矩阵不可用（`device_matrix_unavailable`）、远端续跑不支持（`remote_resume_unsupported`）、
  非法领域名（`invalid_domain`）、中继异常（沿用原 code）、同步派单失败（`delegate_failed`）。
- 回执链路不受影响：回执 / 恢复读的是 `startDelegation` 的落库记录，不解析工具输出文本
  （`delegation-receipts.test.ts` 全绿佐证）。
- `tool-result.ts` 的迁移清单已更新：`delegate` 移入「已迁」，未迁清单移除它。
- 其他写类工具（`remember` / `set_reminder` / `propose_project` / `partner_*` / `group_manage` /
  `routine_manage`）一个没动。
- 单测（`tool-result.test.ts`）：成功形状 + `ticketId` + message 逐字比对；
  `needs_project` 仍在 `data`、`projects` 清单在、且不起 worker。

## 验证

- `pnpm typecheck`：0 错。
- `pnpm --filter @lifediary/server test`：**663 条全绿**（新增 3 条：auxiliary 已接用途 /
  delegate 成功形状 / delegate needs_project）。
- `pnpm --filter @lifediary/server http`：**端到端全部通过**（本批未改端点，复跑确认零回归）。
- 未跑：`pnpm probe`、`memtest`、`providers`、`diary`、`tasks`、`phone`（本批没动这些链路）。

## 已知边界 / 没做

- `compact` 的辅助模型支持**没做**：需要 durable 侧先给压缩任务一个模型入参（跨仓库契约），
  本批只如实记录"内核不支持"，不用旁路拼凑。
- `delegate` 的业务分支 `data` 里仍带 `error` 字段名（如 `needs_project` / `uncertain`）：
  为保持迁移前读取方与文案口径不变，刻意不改成 `code`；将来若统一，需连消费方一起改。
- 远端派发的 `fallbackNotice` 仍只在 `message` 前缀里（未单列结构化字段），与迁移前一致。
- 本批只迁 `delegate` 一个写类工具；其余按 `tool-result.ts` 的清单逐批走。
