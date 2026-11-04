# 参考项目架构调研：agent-autoloop 与 Kun

> 2026-11-04。用户口径：看这两个参考项目对总体架构有什么建议。**状态（2026-11-04 终）：
> ①⑤已落地并验收（13 条断言挂进 `pnpm test` 全过 132，落地记录 `docs/变更记录/2026-11-04-架构守卫与契约快照测试落地.md`）；
> ④已补进批次二方案 §六；③已落地（用户批准，方案 = `2026-11-04-SSE事件流seq与断点重放.md` 含偏差表，
> 落地记录 `docs/变更记录/2026-11-04-SSE事件流seq与断点重放落地.md`）；
> ②维持"拆分立项时引用本文"——agent.ts 拆分本身待单独立项（AGENTS.md 已有口径，不抢跑）**。冲突以 `docs/基线文档/` 为准。

## 〇、一句话

两个参考项目独立收敛到了与本项目相同的形态（壳只连 HTTP/SSE 服务、有状态单机 SQLite、
受理先落回执再入队），**总体架构不用动**；可借鉴的是四件小事：把架构红线写成机器守卫、
agent.ts 拆分按端口切、SSE 加 seq 游标重放、契约加快照测试防漂移。

## 一、调研来源（审计日期 2026-11-04）

| 来源 | 是什么 | 对本文的价值 |
|---|---|---|
| `<reference>\agent-autoloop` | 命令行 Agent 自动化中台：事件→按规则派活给本机 CLI Agent→干完一轮退出→拿不准发卡片等人→回答后续接。内核约 1650 行、零运行时依赖 | 派活可靠性 / 闸门语义 / 事件溯源的参考实现 |
| `<reference>\Kun` | Electron 桌面 Agent：GUI 壳 + 独立 `kun serve` 运行时（本地 HTTP/SSE），内核按 contracts/domain/ports/adapters/loop/server 分层 | 桌面壳与服务端边界 / 六边形分层 / SSE 工程细节 / 契约工程的参考实现 |

调研方式：两个并行探索代理分别通读两仓库（含源码、文档、测试），报告的 文件:行号 未逐条复核，
作为线索用。**所有"我们现状"的结论都按本仓库代码与基线文档重新核实过**（核实点见各条目）。

## 二、先说验证：它们证实了我们已有的决策（不用动）

1. **壳不内嵌 agent 循环**。Kun 最核心决策是"GUI 不跑 agent loop，壳只连本地 HTTP+SSE"
   （其 `AGENTS.md` 与 `docs/kun-architecture.md`）。我们 MyGo 壳 + Hono 服务端正是这个结构。
2. **派单可靠性同构**。autoloop 的核心链路"entry.json 先落盘再启动、结果先落盘再上交、
   失败不自动重做"，与我们 `delegation-receipts.ts` 的 `requestId` 幂等、先落回执再入队是同一套
   （2026-11-04 批次一已落地）。
3. **有状态单机 SQLite 没有天花板**。autoloop 用 1651 行内核 + SQLite 撑起个人自动化全量
   （实测：派活 p99 1.8ms、110 万条事实冷启动重建 100ms、2394 条/秒逐条提交）。我们"不上云、
   不上消息队列"的选型在这个量级（日均几十~几百轮）没有压力。
4. **反面教材**：Kun 的 700 行文件门禁把 `src/main` 撑到 500+ 平铺文件。印证 AGENTS.md
   "刻意不写行数上限、按职责拆"是对的。

## 三、建议采纳的（按优先级）

### 建议① 把架构红线写成机器守卫（可直接做，半天级）

autoloop 的 `tests/purity.test.ts` 用测试强制："内核目录不得出现产品名（claude/codex/feishu/github）、
不得出现 `fetch|child_process|setTimeout|process.env`、只有指定文件能写投影、指定文件能 INSERT"。
把架构写成测试，违规即红。

我们有三条目前只靠人肉审查的硬约束可以机器化：

- **闸门完整性**：测试反射遍历 `tools.ts` 注册表，凡带写/执行能力的工具必须出现在 `WRITE_TOOLS`，
  否则 `AGENT_TOOL_POLICY=read-only` 就是谎（AGENTS.md 硬约束"新工具要进闸门"的机器化）；
- **依赖方向**：`shared` 不 import 包内实现、`memory` 不 import `server`（现在是口头规矩，
  可用 import 扫描测试或 eslint no-restricted-imports）;
- 产出形态：`pnpm --filter @lifediary/server test` 里加架构守卫用例，或独立 `pnpm guard` script。
  这类测试本身就是文档。

### 建议② agent.ts 拆分时按端口切，不是按文件切（给将来拆分方案定形状）

AGENTS.md 已定"agent.ts 按 Harness/会话/闸门/派活拆、单独立方案"。Kun 的六边形分层是现成参考形状：

- `kun/src/ports/` 约 20 个端口接口（ModelClient / ToolHost / ApprovalGate / EventBus /
  SessionStore / ThreadStore / ContextWindowStore…），`loop/` 只依赖端口；
- 新 provider、新存储 = 加 `adapters/` 实现，不改 loop。

落到我们：先定端口接口（ToolGate / Broadcaster / DelegationGateway / SessionStore——最后这个
pi-durable 已经是了），再按端口拆文件。判断拆对了的标准：每块能独立单测（不 import 其他三块），
而不是"四个文件互相 import"。**立项写拆分方案时对着 `kun/src/ports/` 目录抄形状即可。**

### 建议③ SSE 事件流加单调 seq + 游标重放（需立项，动契约）

两个项目互不知情地收敛到同一套 SSE 工程细节：

- autoloop `/v1/stream`：`id: seq / event: fact / data: JSON`，`Last-Event-ID` 断点续传，
  按订阅者速度逐条发不预缓存；
- Kun：先持久化再发布（"Persist-before-publish is load-bearing"）、重连先订阅后重放（防间隙丢事件）、
  有界重放缓冲（超限断流让客户端带 cursor 重连）、心跳复用高水位 seq（防重启后 seq 回卷导致全量重放）、
  `replay_synchronized` 帧标记追平点。

我们现状：**SSE 无游标**（2026-11-04 核对 `ts/packages/shared/src/index.ts` 与接口文档，均无
Last-Event-ID / seq）。今天不是正确性漏洞（D4 断开≠取消 + 事件写回会话兜住了），但随着事件种类
变多（approval、delegate、attention、心跳），没有续传意味着客户端重连要么丢事件、要么全量重拉。

**落点建议**：在批次二（审批事件上线）或批次四（回灌）时一并立项；契约加 `seq` 字段 +
`Last-Event-ID` 重放语义。**这是契约改动，按接口文档 §7 走方案。**

### 建议④ 批次二审批方案补一条"升级路径"注记（文档注记，可并入批次二）

autoloop 的闸门形态与我们的审批设计不同：**等待态只是一行数据库记录（带 session id），
回答变成事件触发续接，等待期间零进程零 token**。我们批次二已写的方案是"in-flight await +
120s 超时 fail-closed"（`2026-11-04-批次二细化（审批ask流）.md`）。

两种都成立，适用时长不同：in-flight 适合分钟级确认；等"人几小时后回来"就该换 autoloop 形态。
**建议在批次二方案"刻意没有/不做"一节补写这条升级路径**，避免将来把现有设计误判为缺陷，
或反过来在人不在场场景硬用 in-flight。

### 建议⑤ 契约快照测试防漂移（可直接做，很便宜）

Kun 的契约工程：contracts/ 全 Zod → `z.infer` 派生类型 → 生成 JSON Schema 给其他语言
（extension-api 有 `schema:generate` 先例）。我们 `shared` 单文件已是 Zod 单源，**不必加生成链**；
但可加一个**契约快照测试**：把 schema 字段形状序列化成快照文件，任何字段增删改都会在 review
里显形——这是接口文档 §7"文档滞后即 bug"口径的机器化版。比手写 Kotlin 侧生成划算得多。

### 顺带记一条（原则，暂无落点）

autoloop 把"派活上下文用资料文件注入、外部文字永不进指令通道"作为结构性防提示注入
（其协议第 6 原则，subject/link 走字符串白名单）。我们 delegation 的 prompt 组装在 chancellor 侧，
当前无此暴露面；**将来加"外部内容进派活提示"能力时（如网页摘要派活）应沿用该原则**。

## 四、明确不建议抄的

| 机制 | 出处 | 为什么不抄 |
|---|---|---|
| 事件溯源全套（facts 只追加日志 + 投影可丢弃重建 + 格式指纹代替迁移） | autoloop | 我们有 pi-durable 管会话、回执库管派活；全量重构收益配不上风险。其"单事务提交"思想已体现在 delegation-receipts 的先落回执再入队 |
| worker 多机接单 / detached 进程组 / ps 找回 / systemd 安装 | autoloop | 我们的派活是进程内调用 + chancellor 仓库，没有多机 |
| 卡片链接表单页、飞书/钉钉/Slack 通道 | autoloop | 我们的通道是 SSE 推两个壳 + 手机 |
| sim/ 20 万步模糊测试、8! 穷举、delivery 流水线 | autoloop | 场景特化，工程投入极大；保留 crash 测试思路即可 |
| runtime 所有权治理（单数据目录 fencing、buildId 探测、退出 barrier、进程树回收） | Kun | 为"单机多实例 + 常驻 + 自更新"特化；我们壳单实例，探活守护已够（架构 §3 desktop 行） |
| preload/contextBridge/electron-builder 更新器 | Kun | Electron 特有 |
| 多 provider 路由池/故障转移、三种 wire 格式分 decoder | Kun | 单用户单 provider；将来接第二种 wire 格式时再参考其"按 endpoint-format 分叉"的做法 |
| IM 桥 / 订阅账号 / computer-use | Kun | 产品功能，非架构 |
| 700 行文件门禁 | Kun | 文件数爆炸（src/main 500+ 平铺）；AGENTS.md 已明确不写行数上限 |

## 五、待办与排期

| 条目 | 性质 | 排期建议 |
|---|---|---|
| ① 架构守卫测试 | 纯测试，无契约改动 | ✅ 已落地（2026-11-04，`arch-guard.test.ts` 7 条，已挂进 `pnpm test`） |
| ⑤ 契约快照测试 | 纯测试，无契约改动 | ✅ 已落地（2026-11-04，`snapshot.test.ts` 6 条，已挂进 `pnpm test`） |
| ② 拆分形状 | 方法论，无代码 | agent.ts 拆分立项时引用本文（拆分本身待单独立项，AGENTS.md 口径已有） |
| ③ SSE seq 重放 | **契约改动** | ✅ 已落地（2026-11-04，用户批准后实施；方案含偏差表，落地记录见变更记录） |
| ④ 审批升级路径注记 | 文档注记 | ✅ 已补进批次二方案 §六（2026-11-04） |
| 顺带：外部内容不进指令通道 | 原则 | 派活提示引入外部内容时引用 |
