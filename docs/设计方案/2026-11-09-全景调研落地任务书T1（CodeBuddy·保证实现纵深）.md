# 任务书 T1：保证实现纵深（验收循环 · 计划附件 · 结构化提问 · 拒绝带反馈 · 闸门留痕）
> 状态：已执行（任务书，2026-11-09）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


> 上位：`docs/设计方案/2026-11-09-Agent全景调研七（方法论技能与保证实现综合）.md` §六 #1/#3/#15/#16/#43/#36，
> 系列二 §三（ZCode final_critic / codex review）与 §四（opencode 拒绝带反馈、goal judge）。
> 执行：CodeBuddy。派单人：总管。基线 `2b4708a`（工作区有未提交的 app.js/style.css/系统架构.md，**别碰**）。
> 前置：已有一份 T0 勘察回报（派单人会在派活消息里贴给你；与代码冲突时**以代码为准**）。
> **不 commit**。四件事各自独立可回滚；做完一起交，变更记录写一份。

## 一句话

行业把"提出要求 → 保证实现"收敛成五层纵深（问清 → 计划 → 计划显式化 → 执行 → 验收循环）；
我们已有"结果验收快照"但**只核对一次、没有循环**，也**没有结构化提问**。本批补齐这两个洞 + 两个便宜件。

---

## 改动项

### 1. 验收快照升级为"核对-修复循环"（本轮最值，P0）

现状：chancellor 验收快照（D13）核对一次，不合格 → `needs_you` 交人。
目标：不合格 → **自动派一次修复** → 再核，最多 N 轮（默认 **1**，env `DELEGATION_ACCEPT_ROUNDS`，0 = 关闭＝旧行为）。

要求：
1.1 判定点只改一处：把"验收失败 → needs_you"改成"验收失败且还有轮次 → 重建一张**修复单**"。
   修复单的 requirement = `上一单验收结论 + 声明路径逐项状态（哪些没变） + 要求：只修这些，别重做`，
   其余字段（project / domain / 发起会话 / requestId 派生）沿用原单。
   实现方式**优先**用 chancellor 已有的"续跑"入口（T0 A3 会给出签名）；若续跑语义（同一张单再跑一轮）不可用，
   走"新派一张同 project 同 domain 的子单"路线——由 T0 结论决定，在变更记录里写明选了哪条。
1.2 轮次记账：修复单上必须可查"这是第几轮修复"，上限到了仍失败 → 照旧 `needs_you`，文案带"已自动修 N 轮仍失败，
   原文：<最后一轮验收结论>"。
1.3 **防死循环**：同一张单的修复轮数、修复单再失败不得再开新单；`DELEGATION_ACCEPT_ROUNDS=0` 时行为与今天逐字节一致
   （单测断言：0 轮时走旧路径）。
1.4 失败要**带反馈**（见 4）：修复单的 requirement 里必须包含验收原话，不许只写"请修一下"。
1.5 事件投影：任务中心详情能看到"返工次数"（`repairRound` 数字，可选字段，缺省不出现）。接口文档 §2.9 补一行。

### 2. 任务单计划附件与 steps（P1）

2.1 `delegate` 参数新增**可选** `steps: string[]`（≤12 条，每条 ≤200 字，纯增量、不传 = 旧行为）。
   语义 = "这条要求拆成的可核对动作序列"，写进任务单（走 chancellor 现有任务单结构能落哪就落哪，T0 A1/A3 给结论；
   落不进去就退化为 requirement 尾部的 `## 步骤` 段，**必须让任务详情读得到**）。
2.2 `delegate` 描述补一段"什么时候该写 steps"：**多步活（≥3 个动作或跨文件）必写**，一句话的小活不写。
   与已有四段任务书（目标 / 怎么算好 / 可自主范围 / 必须请示）并列，不替换。
2.3 任务详情端点加 `steps` 与 `repairRound`（都是可选字段，不出现时前端零影响）。
2.4 前端（`web/app.js` 任务中心详情）：顶部一行"现在到哪一步"（`steps[repairRound 之后的当前项]` 或最后一条）；
   点开才展开全部 steps；没有 steps 时不显示这一行。**只加这一块，别顺手改别的。**

### 3. 结构化提问工具 `ask_user`（P1）

3.1 新工具 `ask_user`：参数 `{ question: string, options?: string[] (2-3 个互斥选项), recommended?: number }`。
   行为 = 走**既有审批 pending 管线**（T0 C10）：落一条 pending（tool=`ask_user`，args=问题的简短摘要），
   本轮收尾，人答复后 followUp 续跑；模型从工具结果里读到答复原文。
3.2 一次一问：`question` ≤ 200 字；`options` 2-3 个、每个 ≤ 60 字；超限直接返回校验错误（不建 pending）。
3.3 进 `WRITE_TOOLS` 吗？**不进**（它不写盘、不起进程），但**要进** `DEFAULT_CRITICAL_TOOLS`？**不进**——
   它本来就必然等一个人答复，再套一层审批是套娃。在 `approval-policy.ts` 注释里写明这个判断（T0 会指出所有按名判断的地方，逐一确认不会误判）。
3.4 开关 `AGENT_ASK_USER`（默认 **true**，false → 工具不上架，一行回滚）。进 `flags.ts` 白名单（`hot: false`，工具注册是启动冻结）。
3.5 工具描述里写清三句纪律："只在真有分叉时问""一次只问一个""能从文件/记忆查到的事实先自己查，别问人"。
3.6 接口文档 §4 收录；手机端零改动（pending 走全局待办端点，T0 会确认）。

### 4. 拒绝带反馈（"拒绝 + 指导语"，P1）

4.1 审批答复增加第三形态：**reject 时可以带一句 `feedback`**（≤500 字）。带 feedback 时，回给模型的
   **不是**现有那句 `denialReason("rejected")`，而是 `你拒绝了这次 <tool> 调用。主人的要求：<feedback>`。
   不带 feedback 时**逐字节等于今天的文案**（单测断言）。
4.2 端到端：`POST /api/v1/agent/approvals/:callId` 的 body 增加可选 `feedback`；`approvals.ts` 存一列（可空）；
   续跑时把 feedback 拼进拒绝理由。旧客户端不带 = 旧行为。
4.3 前端审批浮窗：拒绝按钮长按/展开出一个可选输入框（"告诉他怎么改"），不填就是普通拒绝。
   **保守实现**：默认折叠，只有一个"带说明拒绝"小字入口。手机上不做（手机端另行）。
4.4 与 `ask_user` 兼容：`ask_user` 的 pending 答复走"答复正文"而不是 approval 的 approve/reject——
   T0 会给现有答复路径；如果现有管线只有 approve/reject 二分，**给 ask_user 单开一条答复路径**（同一张表，加一列 `kind`），
   在变更记录里写清取舍。

### 5. 闸门拒绝留痕（P2，便宜件）

5.1 现状：工具被 `{ block }` 拦下时，模型看得到、SSE 有事件，但**账上没有**。
   目标：每次拦下写一行**审计**（不是对话内容）：`{ at, conversationId, tool, reason类别, 来源: which-gate }`。
5.2 落点：`.data/gate-blocks.jsonl`（追加写，单文件，行 JSON；**不存参数**，只存工具名 + 类别枚举 + 会话 id）。
   类别枚举：`policy`（只读/黑名单）/ `approval`（被拒）/ `path`（越界）/ `loop-guard` / `turn-limit` / `relay` / `routines`。
5.3 开关 `AGENT_GATE_AUDIT`（默认 true；false → 一行不写）。**日志纪律照旧**：不写参数、不写对话内容。
5.4 不做界面。只落盘 + 一条单测（写一行、字段齐全、不含参数）。

---

## 铁律

1. **不许 commit**。变更记录：`docs/变更记录/2026-11-09-保证实现纵深（验收循环·计划附件·结构化提问·拒绝反馈·闸门留痕）.md`，
   格式照 `docs/变更记录/2026-11-09-员工档案页…md`。
2. **零 `shared` 改动**（手机端不动）；chancellor 仓库尽量不改，非改不可时单列一节说明改了什么、为什么、怎么回滚。
3. 契约改动先改代码再同步 `接口文档.md`（§2.9 任务详情字段、§4 工具清单、§2.5 审批答复 body、§6 env 新增项）。
4. 密钥不进 git/日志；日志不含对话内容；`ask_user` 的问题正文进 pending 摘要要截断（与 tool args 同口径）。
5. 新能力一律带 env 回滚开关，默认值选"行为不变"。
6. 不做与本次无关的重构。`agent.ts` 是桶，新逻辑进 `agent/` 子模块或新模块。

## 验证（最小充分，都要看输出）

- `pnpm typecheck` 0 错。
- `pnpm --filter @lifediary/server test` 全绿；新增至少覆盖：
  - 验收 0 轮 = 旧行为（字节级文案）；1 轮 = 失败后建修复单且带验收原话；上限后再失败 = needs_you 带轮数；
  - `steps` 参数校验与落点；`repairRound` 投影；
  - `ask_user` 校验（题长/选项数/recommended 越界）；
  - 拒绝带 feedback 的文案 vs 不带 feedback 的文案；
  - 闸门审计一行落盘、字段齐全、不含参数。
- `pnpm --filter @lifediary/server http` 全绿（新字段与新 body 参数进探针）。
- 界面手验归派单人（浏览器真点：任务详情 steps 一行 + 展开、审批浮窗"带说明拒绝"）。

## 交付物

代码（不 commit）+ 变更记录 + 接口文档同步 + 单测/探针。变更记录里如实写：改了什么 / 验了什么 / 已知边界 / 没跑的验证。

---

## 附：T0 勘察结论（2026-11-09，CodeBuddy 回报，已由派单人抽查复核；行号是快照，以代码为准）

- **delegate 工具**：`tools.ts:478-823`（execute `557-822`，注册 `855`）；参数 schema `508-556`，
  **不是 zod，是 TypeBox 的 `Type.Object`**（`Type` 来自 `@earendil-works/pi-ai`）；description `480-507`。
- **审批 pending**：不是数据库表，是 `.data/approvals.json`；记录字段 `approvals.ts:26-49`；
  `create()` `178-205`（同 callId 旧记录先按 aborted 结算，再建 waiter + 落盘）；
  答复入口 `approval-api.ts:80-112`，`decide()` 后 `98-108` 调 `continueConversation()`，
  批准/拒绝指令在 `turn-gate.ts:131/141`；blocking 形态由 `lifecycle.ts:560` 的 `waitForApproval` 自己醒。
  → **「拒绝 + 指导语」的落点 = `denialReason()`（`approval-policy.ts` 末尾）+ 答复 body + approvals 记录加一列，
  续跑指令走 `turn-gate.ts:141` 那一支**（带 feedback 时换一句文案，不带时逐字节不变）。
- **`beforeTool` 的 `{ block }` 分支（`agent/lifecycle.ts`）**：`463` 回合上限 / `470` 递话通道闸 /
  `481` 策略拦（readOnlyBlockReason 经 needsApproval）/ `492` 工作区越界 / `502` 防打转铁证 /
  `551` 放行后复判只读 / `558` 放行后复判路径 / `562` blocking 审批被拒·超时·中止 / `566`+`573` blocking 批准后复判 /
  `580` async 挂 pending 后结束本轮（`APPROVAL_WAITING_MESSAGE`）。
  → **闸门留痕（§5）只需在这 10 处统一收口**：建议包一个 `auditGateBlock(api.conversationId, call.name, category, detail?)`，
  **在函数里做**而不是每处手写；`580` 不算"拦下"（那是正常等待），记 `approval-wait` 可选、默认不记。
- **sections**（`lifecycle.ts`）：`persona`（`367-382`，每轮现算）/ `current_project`（`385-397`，每轮现渲染）/
  `skills`（`401-404`，**按会话冻结**，见 `skills.ts:334-337`）/ `topics`（`411-456`，每轮现渲染 + drain）。
  → **新注入一律"每轮现渲染 section 或 extra system 消息"，不要碰 skills 的冻结语义**。
- **其他按工具名判断的位置**：`agent/policy.ts:144` SHELL_TOOLS；`autonomy-risk.ts:23-35` AUTONOMY_RISK_TOOLS；
  `path-guard.ts:15` GUARDED_TOOLS；`loop-guard.ts:42` READ_TOOLS；`lifecycle.ts:468/509/747`；
  `agent/session.ts:184`（研究专线只留 read）；`approvals.ts:284/300/394`（按 tool 名匹配 pending/放行）。
  → **`ask_user` 加工具时这 8 处逐一确认不会被误判**（它既不写盘也不起进程，不该进任何 WRITE/RISK/GUARD 清单；
  但 `approvals.ts` 的按名匹配要确认能容纳它）。
- **`AUTONOMY_ENABLED`**：判定 `autonomy.ts:46-50 autonomyEnabled()`；消费 `72/81/154`；状态出口 `index.ts:584`；
  `autonomy-state.ts:15-19` 还有一个 `autonomyGate()` 只守自主轮标记。
- **记忆 kind**：`packages/memory/src/types.ts:48-64`，现 5 个：`fact/episode/preference/entity/work`
  （`work` 2026-11-08 加，不进巩固/召回/衰减）。
- **chancellor 侧**：验收快照 `chancellor/src/isolation.ts`（`snapshotDeclaredPaths` `295-360`、
  `writePathSnapshot` `375`、`readPathSnapshot` `380`）；执行前拍照 `scheduler.ts:358-366`；
  **验收结论 `review.ts` 的 `reviewTask()`（`review.ts:33` 起；判定分支 `41-140`，`verdict: "fail"` 的关键分支是
  `changed.length === 0` 那条）**；整单决策 `stage.ts:100 decideAfterReview()`（**`fail` → `{status:"failed"}`**）；
  任务单结构 `types.ts:147-177 Ticket`（`TicketOptions` `137-145`）、`Task` `179-190`、`Review` `275-285`；
  落盘 `store.ts:116/187`；入口 `index.ts:114 runChancellor`（续跑分支 `resumeTicket()`）。
- **验收循环的正确落点（派单人判断，执行时按此走）**：
  `decideAfterReview` 是**纯函数**（输入 reviews + goal），**不要在那里调派单**。
  循环应放在 `chancellor/src/index.ts` 的 `runChancellor` 收尾处：`decided.status === "failed"`（或
  `reviews` 里存在 `verdict==="fail"`）且**本单修复轮数 < 上限**时，不 setTicketStatus("failed")，
  而是以**同一 ticket 目录**再跑一轮：把失败的 review 原因拼成新 prompt（`## 上轮验收未通过`+原文），
  重跑 `planTicket → 执行 → reviewTask`。**修复轮必须是同一张单**（不改单号、不新建父/子单），
  `ticket.repairRound` 落盘数字，`TicketResult` 带 `repairRound` 透出到宿主。
  这样不需要改 `delegate`、不需要宿主二次派单、验收结论天然带反馈。
  上限读 `DELEGATION_ACCEPT_ROUNDS`（默认 1，0=旧行为）。**若这条路线在实现中被证明不可行**（例如
  runChancellor 结构不支持重入计划段），退回"宿主侧二次派单"，但**必须**在变更记录里写清为什么，
  并保证 0 轮时行为与今天逐字节一致。
- **验证基线**：`pnpm typecheck` / `test` / `http` 三项派单人会自己先跑一遍；你交付前必须都跑绿。
