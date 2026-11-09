# 任务书 T0：全景调研落地 · 前置勘察（只读，不改任何文件）

> 上位：`docs/设计方案/2026-11-09-Agent全景调研一~七.md`（七篇，2026-11-09）。
> 执行：CodeBuddy。派单人：总管。基线：`2b4708a`（工作区有未提交的 web/app.js、style.css 与系统架构.md 改动，**别碰**）。
> **本任务只读**：不写文件、不 commit、不改代码。产出 = 一份结论回报（发给派单人）。

## 目标

接下来的 4 个实现任务（T1 保证实现纵深、T2 主动性与例行、T3 底座与权限语义、T4 技能与记忆）要落在真实代码上。
先把下面这些**事实**核实清楚（以代码为准，给"文件:行号"证据），避免实现时猜。

## 要回答的问题（逐条给结论 + 文件:行号）

### A. 任务单 / 验收快照
1. chancellor 仓库（`<repo>\..\chancellor`，实际路径见 `ts/apps/server/src/delegation.ts` 的 import）里：任务单（Ticket）的持久化结构在哪、字段有哪些、`writes` 怎么声明？验收快照（D13）在哪个文件哪个函数？
2. "验收不合格 → 交人（needs_you）"的那段判定代码在哪？要改成"自动派修复 N 轮"，最小改动点在哪几个函数？
3. 派单的 requirement 是**怎么流进 chancellor 的**（哪个事件/哪个文件），中途能不能追加一段系统提示？是否允许"同一张单再跑一轮"（续跑）？续跑的入口函数签名是什么？

### B. 阶段计划 / 任务单进度
4. `delegate` 工具在 `ts/apps/server/src/tools.ts` 的完整实现（行号区间）、参数 schema、参数校验函数在哪？
5. 任务中心详情端点 `GET /api/v1/tickets/:id` 的响应结构（`delegation-api.ts` 里的映射函数），加字段最小改动是哪处？
6. 任务单上已有的 `writes` / `artifacts` 从哪来（worker 回报还是 chancellor 计划）？

### C. 工具闸门与权限
7. `WRITE_TOOLS`（`approval-policy.ts`）与 `readOnlyBlockReason()`（`agent.ts`）的完整消费链：还有谁在按工具名做判断（grep 全仓：`READ_TOOLS`、`CRITICAL_TOOLS`、`RISK_TOOLS`、`autonomy-risk.ts`、`loop-guard.ts`）？列全。
8. 审批拒绝的三条路（reject / timeout / aborted）分别在哪个函数落地？「模型看到的拒绝理由」是哪个常量/函数（`denialReason`）？要加「拒绝 + 指导语」第四路，最小改动在哪？
9. `beforeTool` 钩子里"被拦下"的返回值（`{ block: ... }`）之后有没有任何落账（事件/DB/日志）？列出现有全部"拦下"分支（行号）。
10. `approvals.ts` 的表结构与答复路径（用户答复后怎么触发续跑），加一个「指导语」字段最小改动在哪？

### D. 注入面与提示词缓存
11. 系统提示的 section 渲染面在哪（`agent/lifecycle.ts` 的 `sections` 数组）：现有 section 有哪些 key，各自"每轮现渲染/按会话冻结"？
12. 现有"每轮变化的注入"是怎么进模型的：system 消息（`extra.push`）还是 section？分别在哪些行？会不会破坏前缀缓存？
13. `delegation.ts` 里 `ATTENTION_REPLY_GUIDANCE` / `WORK_REVIEW_GUIDANCE` 的消费点在哪、怎么进提示词？

### E. 例行任务 / 主动性
14. `routines.ts` 的规则结构与调度机制（cron / interval / once / event 各怎么落），`lastOutcome` 有没有这个概念？
15. `AUTONOMY_ENABLED` 的全部消费点（grep），`isAutonomyTurn` 的事实源在哪；要加 `observe` 档，最小改动点。
16. 例行轮"结果回报"路径（`routine-runtime`? `partner-runtime.runPartnerTurn`?），安静轮（无值得报的内容）现在会发生什么？

### F. 技能库
17. 技能文件的实际形态（`skills.ts` `scanSkillDir`）：frontmatter 支持哪些字段？`apps/server/skills/*.md` 两个样例的完整格式。
18. 技能索引注入（`skills` section）与 `skill(name)` 工具的实现位置、上限（字符数/条数）有没有。

### G. 记忆
19. 记忆 kind 的枚举定义在哪（`packages/memory/src/types.ts`），加一个 `intention` 要改哪些地方（存/取/召回/前端标签）？grep 列全。
20. `remember` 工具写记忆的路径与「凭据打码」最适合插入的点（落盘前的唯一收口函数在哪）。

### H. 验证基线
21. `pnpm typecheck`、`pnpm --filter @lifediary/server test`、`pnpm --filter @lifediary/server http` 现在是否全绿？跑一遍报结果（有失败列出名字与原因）。
22. 现有单测文件的命名/风格（挑 2 个读一下，总结：用 node:test? 断言库? 中文注释?）。

## 交付格式

回报一篇 markdown（**直接在回复正文里**，不写文件），按 A~H 分节，每条给"结论 + 证据（文件:行号）"。
不确定的写"未核实"，**不要猜**。总量控制：每问 1-6 行，重点问题（1/2/7/8/11/15/19）可以多写。

## 铁律

- 只读。不写文件、不 commit。
- 不改任何代码，不跑会写 `.data/` 的命令（探针都不跑；`test` 可以跑，它用临时库）。
- 结论里**不要贴大段代码**，给行号和一句话描述。
