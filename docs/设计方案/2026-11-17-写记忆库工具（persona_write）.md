# 2026-11-17 方案：写记忆库工具（persona_write，明确让写才写）

**状态：落地中。下沉落点：工具清单与 env 表 → `接口文档.md`；闸门 → `接口-端点7-权限技能与开关.md`；
persona-metric 侧契约 → 本文件「跨仓契约」节。冲突以基线文档为准。**

## 背景（用户口径，2026-11-17）

- 自动提取的记忆**不送**大记忆库（voicevault/persona.db）——现状本来就不送（导出管只送主对话原文轮），维持。
- 但**主人明确让写时要能写**：典型场景=大记忆库内容记错了，主人纠正一句，把纠正写进去。
- persona-metric 已有承载表与回改工具（本次核实）：`user_statement` 表（用户口述事实，设计上优先级压过模型推断）
  + `analysis/repair.py`（每刀强制 `--why` 进 `change_log`，旧记录不删只降权，`raw_source` 触发器拦着永不改）。
- **核实出的真缺口**：`user_statement` 只有写入方，没有任何检索方读它——写进去是黑洞。
  所以本批两半：persona-metric 补检索 + harness 补写入工具。

## 跨仓契约（只有一份）

**写入**：harness `persona_write` 工具 → `python <repair.py> statement <body> [--about <时间>] [--tag <标签>] --why <原因>`
- `body` = **主人原话**，不改写不总结（repair.py 按 sha1(body) 幂等，同原话重跑 REPLACE 同一行）；
- `--why` 必填 = 为什么写这条（进 change_log），模型组织、写纠正理由；
- 输出：stdout 一行 `已记：<body[:50]>`，退出码 0 = 成功；失败一律降级 `ok:false` 不抛（同 persona-ask 纪律）。
- 不做：`conflict / synonym / downgrade` 子命令不开放给工具（要记忆 id，误伤面大；v1 只开放 statement）。

**读回**：`ask.py` 的 `fact` 证据组头部插入命中的 `user_statement`（不新增第七组、不动共享 schema）：
- 每条映射成既有 fact 形状，`title="用户亲口确认"`、`why="用户亲口确认·最高优先（压过模型推断）"`；
- 关键词匹配 body/about/tag，按 date_stated 倒序，条数随 limit；
- 模型侧看到「用户亲口确认」的字样自然压过同题的推断事实（冲突时旧记录还在，但带着降权与陈述并存，不删留痕）。

## harness 侧设计

- 新文件 `persona-write.ts`：完整照抄 `persona-ask.ts` 的子进程壳（argv 数组传参不用 shell、15s 超时、
  失败降级、日志只记字数/耗时/ok，不记 body 原文）。
- 路径解析：`PERSONA_REPAIR` 显式配置优先；否则从 `PERSONA_MEMORY_ASK`（ask.py）同目录推导 `repair.py`——
  零新增 env 配置；都不存在 = 工具不上架。
- 双闸注册（同 persona_recall 模式）：`PERSONA_WRITE_ENABLED`（新插件页开关，persona 分组，hot，**默认关**）
  + 路径可用。lifecycle-harness 注入 deps.personaWrite，tools.ts 条件注册。
- **审批=硬闸**：capability `needsApproval: "critical"` → 每次写都弹审批，主人点确认才执行——
  「明确让写了才写」的技术 enforcement，不只靠提示词自觉。
- 闸门：起 python = 起进程，按硬约束字面进 `WRITE_TOOLS`（同 persona_recall）。
- 工具描述写死三条纪律：只在主人明确要求时用；只存主人原话；自动提取的记忆绝不往这里送。

## 明确不做

- 不做自动同步：提取记忆、日记原文一概不进大记忆库（维持 2026-11-17 拍板）。
- 不做 conflict/synonym/downgrade 的工具化（v1 只 statement）。
- 不改 voicevault.py 主体与 raw_source（触发器拦着）。
- 不做批量回改 UI。

## 回滚

`PERSONA_WRITE_ENABLED=false`（插件页拨回关）或清掉 `PERSONA_MEMORY_ASK`（连 persona_recall 一起退场）；
persona-metric 侧 ask.py 改动单文件可 revert（不改任何表结构与写入方）。

## 验证

- persona-metric：临时库冒烟——repair.py statement 写入 → ask.py --json 检索，确认 fact 组头部出现该条。
- harness：persona-write.test.ts（argv/降级/双闸/幂等语义）；typecheck；工具清单类既有测试如实报（并行在途红与本批交集部分对齐）。
- 真写一条纠正必须等主人真实口述，测试不碰真库（repair.py 支持 --db 临时库）。
