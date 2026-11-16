# 2026-11-17 写记忆库工具（persona_write：明确让写才写）

## 改了什么（跨仓：lifediary-harness + persona-metric）

**背景**：2026-11-17 用户拍板细化记忆口径——自动提取的记忆**不送**大记忆库（现状本来就不送，维持）；
但主人**明确让写**时要能写，典型场景=大记忆库记错了，主人纠正一句落进去。

**核实出的真缺口**：persona-metric 已有 `user_statement` 表（用户口述事实，设计上优先级压过模型推断）
与 `repair.py`（每刀强制 `--why` 进 `change_log`，旧记录不删只降权），但 `user_statement`
**只有写入方、没有任何检索方读它**——写进去是黑洞。本批把两头接通：

### persona-metric 侧（单文件改动）

- `analysis/ask.py`：新增 `g_statement()`；`g_memory_fact()` 把口述确认条目排在事实组头部
  （`title="用户亲口确认"`、`why="用户亲口确认·最高优先（压过模型推断）"`）；
  且 `ask()` **任何题型都查**口述确认（表极小，一次 like），命中塞进既有 fact 组——
  **不新增第七组，harness 六组 schema 与渲染零改动**。
- 冒烟：临时库（真库拷贝）写入 statement → `ask.py --json` 全链路，fact 组头部正确出现该条。

### lifediary-harness 侧

- 新文件 `persona-write.ts`：照抄 persona-ask 壳（argv 数组传参不用 shell、15s 超时、失败降级
  `ok:false` 不抛、日志只记字数/耗时/ok）。路径：`PERSONA_REPAIR` 显式优先，缺省从
  `PERSONA_MEMORY_ASK` 同目录推导 `repair.py`（零新增 env 配置）。文本字段超限直接拒绝不截断。
- 工具 `persona_write` 条件注册（`tools.ts` + `lifecycle-harness.ts` 注入 `deps.personaWrite`）：
  双闸 = `PERSONA_WRITE_ENABLED`（新插件页开关「口述落库（写）」，persona 分组，**默认关**）+ 路径可用。
- 闸门与审批：进 `WRITE_TOOLS`（起进程）**且**进 `DEFAULT_CRITICAL_TOOLS`（字面常量 + capability
  critical 双份对账）——**每写必弹审批**，主人点确认才落字，这是「明确让写了才写」的技术 enforcement。
- 描述写死三条铁律：只在主人明确要求时用；body 一字不动存原话；自动提取的记忆绝不往这里送。
- 人设页工具勾选分类（partner-tools.ts）补「记忆」组一行。
- 小记 SOUL v2.1 补一条「大记忆库只读不写，主人明确让写才落字」。

## 测试

- 新增 `persona-write.test.ts`（双闸/长度校验/argv 拼死/statementId 同式计算/非零退出降级）；
- `approval-policy.test.ts` 补 persona_write 闸门与审批档断言；
- `tool-capability.test.ts`（EXPECTED_TOOLS + 注册桩）、`tool-schema-guard.test.ts`（注册顺序快照 +
  personaWrite 桩）、`arch-guard.test.ts`（闸门完整性桩）对齐本工具。
- `pnpm typecheck`：本批文件零错误（另有 executor-probe.ts / flags.test.ts 两处错误属并行在途）。

## 前缀资产声明

`persona_write` 插在 `persona_recall` 之后注册——**工具清单与顺序变动会打掉上游 prompt cache**，
本次是有意变更（新工具上架）。tool_search 的顺序漂移属并行在途批次，未动。

## 回滚

`PERSONA_WRITE_ENABLED=false`（插件页拨回关）；或清 `PERSONA_MEMORY_ASK`（连 persona_recall 一起退场）；
persona-metric 侧 ask.py 单文件 revert，不动任何表结构与写入方。

## 未做 / 边界

- `repair.py` 的 conflict / synonym / downgrade 子命令不开放给工具（要记忆 id，误伤面大，v1 只 statement）。
- 真写一条纠正等主人真实口述（每次写都有审批拦着）；测试不碰真库（repair.py 支持 `--db` 临时库）。
- 冲突的旧记录降权（confidence='low'）目前仍走 persona-metric 侧手工 `repair.py`，工具只负责「写对的话」。
