# 任务书：扫尾批 8g——任务即对话（专线会话 + 双写 + 回话直通）

> 派单人：总管。执行人：CodeBuddy。日期：2026-11-08。
> 上位方案：`docs/设计方案/2026-11-08-扫尾批8g方案（任务即对话）.md`（语义以它为准）。
> 范围：`ts/apps/server/src/`（delegation.ts / 新 task-conversation.ts / index.ts / web 任务详情）+ 文档。**chancellor 仓零改动**（发现必须动它就停下汇报）；手机端不动。

## 铁律

不许 `git commit`；完成后 `pnpm typecheck`、单测（含新增）、`concurrent` + `resume` + `http` 探针全绿、`pnpm probe`。

## 前置事实

- 专线会话先例：研究回合 `task-topic-`（`task-conversation` 相关实现自己定位——建会话、跳过侧栏/任务卡/记忆三处的判定点全在）。
- 留言：`delegation.ts` settle/进度路径调 `recordMessage`（留言表）；事件订阅 `watchAllDelegationEvents`。
- 写条目范式：`sayInChat`（`submit({type:"write", entry:{kind:"pi.assistant", ...}})`）；主人回话范式：`sayInChat` user 形态 / `chatStream`。
- resume：`resumeTicket`（tools.ts）；任务详情页：`web/app.js renderTicketDetail`。

## 逐项

1. **专线会话**：新 `task-conversation.ts`——`ensureTaskConversation(ticketId)`（`task-<ticketId>` 前缀，幂等：同单复用同会话）、`appendTaskEvent(ticketId, entry)`（write submission）、`getTaskConversation(ticketId)`（uuid 换算给前端）。三处跳过判定（侧栏/任务卡/记忆）以"task- 前缀"复用既有机制（研究回合怎么跳过，这里怎么跳过）。
2. **双写**：delegation 事件路径（进度/REPORT/留言 recordMessage 处）在留言表之外同步 appendTaskEvent——进度节流照事件原样（不额外合并）；留言表继续写（过渡期兜底视图不删）。
3. **回话直通**：任务详情页输入框 → 新端点 `POST /api/v1/tickets/:id/say` body `{text}` → ensureTaskConversation + submit（忙时 followUp）→ 触发既有 resumeTicket 链路（把执行端需要的东西送过去）→ 202 返回；详情页回话区接该端点，回读走专线会话。
4. **回滚**：`TASK_AS_CONVERSATION=false` 全部旁路（不建会话、双写只写留言表、回话端点 404）。
5. **文档**：接口文档任务中心节补 `say` 端点与专线会话口径；系统架构 delegation 行注记；变更记录《2026-11-08-扫尾批8g（任务即对话）.md》。

## 明确不做

留言迁移、侧栏展示、会话归档、chancellor 改动、手机端、专线会话的压缩策略定制。

## 汇报格式

1. 逐项：落点（文件:行）、跳过判定复用结论、双写顺序保证。
2. 验证原文：typecheck / 单测 / 三探针关键行 / 新场景逐条。
3. 文档清单。4. 不确定点（发现必须动 chancellor 立即停下写明）。
