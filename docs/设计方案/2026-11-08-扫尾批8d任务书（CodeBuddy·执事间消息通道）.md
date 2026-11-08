# 任务书：扫尾批 8d——执事间消息通道（send_to_agent，防乒乓）

> 派单人：总管。执行人：CodeBuddy。日期：2026-11-08。
> 上位方案：`docs/设计方案/2026-11-08-扫尾批8d方案（执事间消息通道）.md`（**语义以它为准**，防乒乓三闸一条不改）。
> 范围：`ts/apps/server/src/agent/`（新工具装配+闸门）+ 新 `partner-relay.ts` + 探针 + 文档。不碰手机仓、chancellor。

## 铁律

不许 `git commit`；防乒乓是**结构保证**（目标轮摘工具），不是提示词保证；完成后 `pnpm typecheck`、单测（含新增）、`companion` + `chief` + `http` 探针全绿。

## 前置事实

- 执事会话：`partner-runtime.ts`（身份会话与跑一轮）、`partners.ts`（档案与 partner_session_links）；工具装配在 `agent/lifecycle.ts`（8b 新结构）；事件口 `agent/shared.ts`；主人对话通知可参照 delegate 事件的 emit 形态。
- 递话送达 = `conversation.submit({type:"input", content: 包装正文, whenBusy:"followUp"})`（目标忙时排队、空闲触发一轮——批 8a 验证过的 durable 语义）；目标执事会话的 internalId 从 partner_session_links 取（`partnerIdOfSession` 反向：`sessionIdOfPartner` 若无则新增只读助手）。
- 工具注册与条件上架范式：`COMPANIONS_ENABLED`/`GROUPS_ENABLED` 双闸先例（group_manage）。

## 逐项

1. **`partner-relay.ts`**（新）：目标解析（名/domain，重名歧义返回候选）、包装正文模板（照方案 §一.3）、hop 标记、每 run 计数（进程内 Map，key=run id）、提交送达。
2. **工具装配**（`agent/lifecycle.ts`）：`send_to_agent` 挂 `PARTNER_RELAY_ENABLED`（缺省开）；仅执事会话可调（主人对话不挂——主人直接说让谁干嘛就行）；**递话触发的 run 摘除该工具**（beforeTool 拦 + 一次性标记，实现口径照方案 §一.5）；例行触发轮（autonomy）拦。参数 schema `{target, message}`，message 上限 4000 字。
3. **主人知情**（方案 §一.6）：递话成功后向 chief 对话 emit 一条轻量通知（形态参照既有 notice 事件；正文不递原文）。
4. **探针**（新 `partner-relay-probe.ts`，假 runner/真 durable）：方案 §三六场景逐条。
5. **文档**：接口文档工具清单 + 新小节（防乒乓口径写清）；系统架构工具行与 D16 相邻处补一句；变更记录《2026-11-08-扫尾批8d（执事间消息通道）.md》。

## 明确不做

不做信箱 UI/已读回执/自动谈判/跨机递话/两跳；不改群组；不做执事再建执事。

## 汇报格式

1. 逐项：工具 schema、摘除实现、通知形态、解析规则。
2. 验证原文：typecheck / 单测 / companion+chief+http 探针关键行 / 新探针六场景。
3. 文档清单。4. 不确定点（语义对不上停下写明）。
