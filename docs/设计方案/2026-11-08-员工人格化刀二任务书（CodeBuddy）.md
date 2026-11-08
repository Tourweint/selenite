# 任务书：员工人格化 · 刀二（工作履历 · 当前目标 · 自建巡逻）

> 上位方案：《2026-11-08-员工人格化（岗位契约·履历·成长）》§三 E2/E4（同目录，先读）。
> 执行：CodeBuddy（hy4free）。派单人：总管。基线 `4f8e784`（工作区干净）。
> 刀一（契约注入/状态感/教诲口径）已验收入库；刀二只做本任务书两件事；
> E3 技能层 / 界面编辑区 / shared 暴露在刀三，**都不在本次范围**。

## 背景（三句话）

执事现在没有履历：干过的活散在 chancellor runs/ 里，结算完就"忘了"，问它"最近干得怎么样"答不上。刀二给记忆引擎加**工作记录形态**（每单结算落一条，append-only），并给执事**当前目标**字段与**自建巡逻**能力（自己建周期性规则，如"每周五自己盘点"）。

## 前置事实（2026-11-08 21:16 核对，以代码为准）

- 刀一落点（先读再动手）：`agent/partner-context.ts`（装配单一入口：契约+在办）、`partners.ts`（CONTRACT/版本化/PARTNER_CONTRACT）、`lifecycle.ts` beforeRequest（used===1 注入 system 消息）。
- 记忆包：`ts/packages/memory/src/types.ts:48` MemoryKind = fact/episode/preference/entity；store 有 kind/scope/content/source 列；protectKinds=偏好永不删；批 6 导入 source=imported。**10-C 刚落地审批三档（approvalLevel）**，WRITE_TOOLS 与风险分级以 `approval-policy.ts` 现行代码为准。
- 例行任务：`routines.ts`（RoutineTrigger cron/interval/once/event；durable 闹钟；**自我事件不触发自我**防自环已有）；创建目前只有 HTTP `POST /api/v1/routines`。
- chancellor：`runs/<ticket>/ticket.json` 有 `originConversationId`；`TicketResult.tasks[].dir` 给子任务目录路径（产物文件清单**不透传**——履历的"产物"列记目录路径即可）。
- delegate 调用方=执事会话（origin 落在他的会话链接）；无领域执事 managed 路由可派。

## 改动项

### 1. E2 工作履历（记忆 kind="work"）

1.1 `packages/memory`：MemoryKind 加 `"work"`。**逐处核对按 kind 分支的代码并列清单**（store 写入校验、巩固、召回、导入、cap 修剪、测试），work 行为按下面的 ledger 语义定：

- **不合并**：巩固的语义去重跳过 work（"整理纪要"干十次是十条履历，合并=篡改履历）；
- **不衰减**：时间衰减不作用于 work（三个月前干过什么仍是事实）；
- **cap 修剪**：每 scope 上限 200 条，超出删最旧（沿用现有修剪机制加 kind 规则）；
- **召回默认排除**：主人对话的召回不返回 work（不污染日常记忆）；执事轮装配与盘点用**结构化查询**（按 scope+kind 按时间倒序），不走语义召回；
- store 需要一个"按 scope+kind 列最近 N 条"的查询口（现有 filter 支持 kinds，确认够用即可，别造第二套）。

1.2 写入点：harness 侧派单**终态结算**处（delegation 终态落账，executor 自查 TERMINAL 语义落点；取消/中止也结算）。每单一条：`kind=work`、content 一行（单号 + 任务一句话摘要 + 终态 + 结果一行 + 产物目录路径有则带）、`source="work"`、落到**发起执事**的 scope（按 origin 会话认执事，复用刀一的 partnerIdOfSession 逻辑）。**终态写一次**，中间态不写。写失败只 warn 不影响结算主流程。

1.3 履历摘要注入：`partner-context.ts` 的【当前在办】段末尾加一行"近 10 单：完成 X、失败 Y、中止 Z"（work 记录聚合；零记录不加）。在办=现在时（runs 扫描，刀一已做），履历=过去时（work 记录），两层互补别混。

### 2. E4 当前目标 + 自建巡逻

2.1 `PartnerRow` 加 `currentGoal: string | null`（SQLite 列迁移，PRAGMA 探列再 ALTER，老库兼容）。**只进 detail 端点与 PATCH**：`PATCH /api/v1/partners/:id` 接受 currentGoal（字符串可空，空=清除）；`GET /api/v1/partners` **列表形状不变**（shared 暴露在刀三）。目标不版本化（不是身份），现取现用。

2.2 目标注入：`partner-context.ts` 装配在【岗位契约】段后加"【当前目标】…"一行（有目标才出现）。

2.3 自建巡逻工具 `routine_manage`：执事给自己建/停/删例行规则。
- 参数：action=create|disable|enable|delete + name/prompt/triggers/sessionMode（create 必填，其余带 id）。内部走 routines.ts 既有引擎与校验（revision、durable 闹钟、防自环原样生效）。
- **只能动自己的**：partnerId 绑定调用者会话认出的执事，动别人的一律 not_found（不泄存在性）。
- 上限：每执事活动规则 ≤10 条，超出 400 带说明。
- 进 WRITE_TOOLS 过闸门；10-C 三档分级里归**高危类**（与 partner_manage 同档——让模型在后台自主跑轮的事，第一次要人点头）。
- 回滚开关 `ROUTINE_SELF_SERVICE=false`：工具不上架（照 partner_manage 的条件注册先例）。README/接口文档的工具清单同步。

2.4 盘点口径（提示词层）：routine_manage 工具描述 + 装配段给口径——执事按周期盘点时：读自己 work 履历 → 一段自然语言总结（几单、成几单、什么教训）→ 总结落一条 episode 记忆 → 向主人汇报。**不打分不搞 KPI 数字**（方案 §五.5）。

2.5 刻意不做：不给执事**自动**创建周回顾规则（静默的自动轮=意外 token 账单）；回顾规则由用户配，或主人说一句"你每周五自己盘点"后执事经 routine_manage 自建（人点头过一次）。

## 铁律

1. **不许 commit**；变更记录《docs/变更记录/2026-11-08-员工人格化刀二（履历·目标·自建巡逻）.md》，格式照刀一。
2. **零 shared 改动、零 chancellor 改动**；`GET /api/v1/partners` 列表形状不变。
3. packages/memory 允许改（MemoryKind/巩固/修剪/查询），但改前先列 kind 分支清单进变更记录；memtest 必须扩 work 用例。
4. 密钥/日志红线照旧；日志不含对话内容。
5. 接口文档同步（PATCH currentGoal、routine_manage 工具、ROUTINE_SELF_SERVICE）；系统架构"刻意没有"（不自动建回顾规则等）由派单人落，执行者不写基线架构文档。
6. 与刀一同一装配点扩展（partner-context.ts），别开第二条注入通道。

## 验证（最小充分，看输出不看退出码）

- `pnpm typecheck` 0 错。
- `pnpm memtest`：全绿 + 新增 work 用例（写入 / 不合并不衰减 / cap 修剪 / 召回排除 / 结构化查询）。
- `pnpm --filter @lifediary/server test` 全绿；新增至少覆盖——currentGoal 迁移与 PATCH / 列表形状不变 / routine_manage 只动自己 / 上限 400 / 开关关工具不上架 / 履历摘要装配 / 结算落 work（终态一次）。
- `pnpm --filter @lifediary/server http` 全绿（PATCH currentGoal→detail 读回→列表无字段；routine_manage 场景）。
- `companion` 探针复跑无回归。
- 真模型手验归派单人。

## 交付物

代码（不 commit）+ 变更记录 + 接口文档小节 + README 工具清单 + 单测/探针/记忆测试更新。变更记录如实写：改了什么 / 验了什么 / kind 分支清单 / 已知边界 / 没跑的验证。
