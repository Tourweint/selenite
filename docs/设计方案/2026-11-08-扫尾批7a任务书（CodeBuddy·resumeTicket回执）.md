# 任务书：扫尾批 7a（harness）——resumeTicket 补写回执，堵住回灌覆盖缺口
> 状态：已执行（任务书，2026-11-08）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


> 派单人：总管。执行人：CodeBuddy。日期：2026-11-08。
> 上位：扫尾计划 A6。缺口登记：批次四落地记录 + `系统架构.md` §7"用户 resume 过的单、续跑中单的完成都不回灌（观察后再议）"。
> 本批只做前半：**resume 过的单补回执映射**（后半"续跑中单实时回灌"维持登记，不动）。

## 铁律

不许 `git commit`；只改本任务书范围；回执语义只增不改（不改既有行格式）；完成后 `pnpm typecheck`、单测、`resume` + `concurrent` 探针全绿。

## 前置事实

- `tools.ts` 的 resumeTicket 路径（2026-11-04 记录指 tools.ts:333 附近，行号自己核）受理续跑但**不写回执**；`delegation-receipts.ts` 的 `accept(requestId, ticketId, conversationId?)` 是幂等登记口；批次四 A3b 恢复回灌按回执里的 ticket→conversation 映射找宿主会话。
- 探针：`scripts/delegate-resume-probe.ts`（假 runner，已有取消/重试场景）。

## 逐项

1. **补映射**：resumeTicket 受理成功后写回执，把该单映射到**发起 resume 的会话**（后续完成回灌进这条对话）。requestId 取幂等键（如 `resume:<原单号>` 或带次数，读 `delegation-receipts.ts` 的幂等实现后定，保证同单重复 resume 不炸、重启后恢复逻辑能读到映射——以"恢复消费端怎么查"为准反推写法）。
2. **恢复端核对**：确认 A3b 启动恢复在"同一 ticketId 有原始单+resume 单两条回执"时的取数口径（latest-wins 还是 first——按现状如实，若现有查询天然取到 resume 行就直接用；需要小改就最小改），探针钉死行为。
3. **探针**（delegate-resume-probe 增场景）：①resume 后该单回执存在且指向 resume 发起会话；②模拟重启恢复（按 A3b 现有测试形态）→ 完成回灌落到 resume 会话而非原会话；③同一单二次 resume → 不炸，映射按实现口径断言。
4. **文档**：`系统架构.md` §7 该缺口段改写（resume 过的单已回灌；"续跑中单实时回灌"仍登记观察）；变更记录《2026-11-08-扫尾批7a（resumeTicket回执补映射）.md》。

## 明确不做

不做续跑中单的实时回灌；不改回执表结构；不动 chancellor 仓。

## 汇报格式

逐项落点、幂等键最终取法与理由、恢复端取数口径结论、验证原文、文档清单、不确定点。
