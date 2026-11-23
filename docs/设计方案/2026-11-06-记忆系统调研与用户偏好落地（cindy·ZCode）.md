# 记忆系统调研与「用户偏好」落地（cindy · ZCode）
> 状态：调研/调查留档（非契约，2026-11-06）。结论已消化进后续批次；现行口径以基线文档为准。


> 2026-11-06。用户口径：先自己调查 Cindy 的记忆系统怎么实现（"咱们也要做一个"），
> 同时看 ZCode；重点是**运行时怎么看待/记住用户偏好**；**已经存好的记忆后期再接入**。
> 核实方式：两个参考仓库逐文件实读（`<reference>\cindy`、`<reference>\ZCode`，
> 均以 2026-11-06 本地克隆为准），本仓库以代码为事实源。
> 状态：**已落地**（2026-11-06）。下沉落点表：
>
> | 内容 | 落点 |
> |---|---|
> | 三个记忆端点、列表口径、错误码 | `docs/基线文档/接口文档.md` §2.15 |
> | 记忆与工具的关系（不注册新工具） | `接口文档.md` §4 |
> | `MEMORY_EXTRACT` 三档 | `接口文档.md` §6 |
> | 抽取两套实现、偏好 scope、注入分组、已知缺口 | `docs/基线文档/系统架构.md` §7 |
> | 偏好落宽 scope / 不自动判冲突 | `系统架构.md` 决策表 D17 / D18 |
> | 实际改了什么、验了什么、不确定项 | `docs/变更记录/2026-11-06-用户偏好记忆落地.md` |
>
> **与长期文档冲突时，以 `docs/基线文档/` 为准。**

## 〇、人话版结论

三句话：

1. **Cindy 与 ZCode 都不是"向量库记忆"，而是"文件分片 + 索引 + 模型自己写"**。Cindy 走
   `MCP 工具 + MEMORY.md 自动重建 + FTS5`，ZCode 走 `Write 工具直写事实文件 + MEMORY.md 索引注入 +
   后台抽取子 Agent`。两家都刻意**不做** embedding：靠"小文件、一行 hook、按需读取"控制预算。
2. **我们已经有四层框架，但抽取是规则版**（`extract.ts` 全文只有一句 `kind: "episode"` 的 TODO），
   所以"用户偏好"实际上从来没被识别出来过——所有话都记成 episode，`preference` 这个 kind 是死值。
   这是本次要补的真缺口。
3. **本次只补"偏好"这一条最窄的闭环**：会话结束 → LLM/规则抽取 → 落 `preference` → 下一轮召回注入；
   加一个只读+可删的设置页（学 Cindy 的"记忆页"）。**已存记忆的迁移、合并、导入统一不做**，
   留 `imported` 口径与 `source` 字段给后期接。

## 一、cindy 的实现（实读）

### 1.1 存储形状：一条事实一个 `.md`

`packages/maker-core/src/memory/`（977 行 manager + 698 行 storage + 269 行 fts + 395 行 store）。

```text
<userData>/maker-memory/<sanitizeWorkdir(workdir)>/
  MEMORY.md                    # 索引：一行一条 hook，LLM 不直接改
  user_prefers_concise.md      # 分片：<type>_<slug>.md
  feedback_no_emoji.md
  project_deadline_q4.md
  fts.db                       # SQLite：FTS5 全文索引 + meta
  meta.json
```

分片 frontmatter 只有四个字段（`types.ts:47-62`）：

```yaml
---
title: 用户偏好
description: 一行 hook，用作 MEMORY.md 索引行
type: user            # user / feedback / project / reference（+ 内部 digest）
updatedAt: 2026-05-10T12:34:56.000Z
---
```

几个关键取舍：

| 决定 | 实现 | 为什么 |
|---|---|---|
| 索引自动重建 | `write()/delete()` 后同步 `rebuildIndex()`（`storage.ts:13-18` 注释） | 明说这是**反 Claude Code 的 pattern**：让 LLM 手写索引会"分片改了索引没同步" |
| 大小护栏 | 分片软 2048 / 硬 8192 字节；索引软 4096（`DEFAULT_MEMORY_CONFIG`） | 超软限返 `warning + warningDetail`，让模型自己判断"不动/微剪/consolidate" |
| 类型 | `user / feedback / project / reference` + 内部 `digest` | 照搬 Claude Code auto-memory；`digest` 是 Pi 压缩沉淀，**不进索引、不进 prompt** 但可检索 |
| 作用域 | 按 **workdir** 分库（`buildMemoryScopeKey`），SSH 用 `ssh:<host>:<path>` 复合键 | 同仓库不同目录 = 不同记忆；worktree 做归一化（`scope-resolver.ts`）避免拆碎 |
| 伙伴记忆 | `bot:<botId>` 独立键空间 | 不同 Bot 在同一项目里不互相污染 |

### 1.2 工具面：两个入口 + 7 个内部工具

`packages/lizi-mcps/src/cindy_memoryMcpServer.ts`：

- MCP server 只暴露 **`list_tools` / `call_tool`** 两个常驻工具（约 200 token），
  内部 7 个（`memory_read/list/search/write/delete/consolidate/review` + 可选 `session_search`）
  通过 `list_tools(category)` 渐进发现。
- 这是个很值得抄的**省 token 手法**：工具多的时候，常驻 schema 很贵。

`call_tool` 的参数校验用 `z.strictObject`（`cindy_memoryToolRegistry.ts:95`）：未知字段直接失败，
并在错误里回显 `received` 顶层 keys —— 注释写明"实测三个会话因多包一层信封连续盲试"。

### 1.3 写入是**模型主动**，不是后台自动抽取

`system-prompt.md` 是注入到 agent system prompt 的一段规则，核心四问：

- **何时存**：持久且未来会用到。四类按"内容是什么"分，不按来源分。
- **何时不存**：代码模式/文件路径/项目结构（去读代码）、git 历史、已在 `CLAUDE.md`/`AGENTS.md`
  里的、进行中的临时状态、工具输出原文。
- **判据**：`"I prefer X" / "don't X" / "always X" / "never X" / "remember X" / "我希望" / "别再" / "记住"`。
- **`feedback` 类必须写 `**Why:**` 与 `**How to apply:**`** —— 强制把"为什么"和"何时生效"一起存。

还有一条**"如果写不出一行 description hook，这条就不值得存"**——用索引可写性当质量闸门。

手动触发：用户消息以 `Save in memory:` / `记到 memory:` 开头则强制写。

### 1.4 读：索引常驻 + 全文按需

- `MEMORY.md` 在 session 启动时快照拼进 system prompt（静态规则 + 索引两段）。
- 详情走 `memory_read(filename)`；找内容走 `memory_search(query)`（FTS5 bm25 + snippet）。
- `memory_review()` 起一次**便宜的辅助模型**做一致性审查，只返回 ≤200 字建议，
  **不自动删/合**——让调用方模型自己决定，保留可观测性。

### 1.5 伙伴工作记忆：另一套（语义账本）

`maker-ipc/botWorkingMemory.ts`（813 行）是**工作记忆**，不是长期记忆：分五区
`threads / commitments / waiting / corrections / recentlyDone`，每区有上限（8/10/6/8/8 条），
单条 240 字，渲染预算 6000 字；由回复后的"学习复盘"顺手维护，**只在换窗/压缩后注入一次**。
关键设计：**账本只存语义状态**；任务状态、改动文件这类"宿主有真相"的内容渲染时从数据库现读，
不信模型写的文本。**账本是摘要，不是授权**——历史授权不是新的执行许可。

这条对我们很相关：它解决的正是"压缩之后看起来忘事"，而我们的 `session` scope 也面临同样问题。

## 二、ZCode 的实现（实读）

### 2.1 也是文件，但更"硬"：provider-visible 契约

`docs/design/v2/memory/README.md`（940 行）是一份**验收级 spec**，验收对象是"最终 provider request body"，
不是中间对象。存储形状：

```text
<cli-storage-root>/memories/projects/<workspace-key>/memory/
  MEMORY.md
  <fact-name>.md
```

事实文件 frontmatter：

```yaml
---
name: concise-memory-name
description: one-line recall description
metadata:
  node_type: memory
  type: user | feedback | project | reference
  originSessionId: sess_0123456789abcdef
---
One durable fact.
```

与 Cindy 的三处关键差异：

1. **`originSessionId` 由运行时补，不由模型生成**：Write/Edit 边界在字段缺失时补一次
   `node_type` + 当前 session id。这是"可追溯"的最小实现。
2. **`MEMORY.md` 由模型维护**（写事实后同步加一行 pointer），Dream 负责整理裁剪。
   —— 与 Cindy 正好相反。ZCode 的理由是"LLM 写时能顺手写 hook"；Cindy 的理由是"模型会忘"。
   两家都自洽，我们的取舍见 §四。
3. **`[[other-memory-name]]` 双向链接**：允许指向还不存在的记忆（"标记以后该写"），不做引用校验。

### 2.2 检索有两条**互斥**分支

`project-memory-retrieval-branch.ts` 是唯一常量 `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED=false`：

| branch | Main pointer | 加载 MEMORY.md | Selector | relevant_memory |
|---|---|---|---|---|
| `default-index`（当前） | 是 | 是 | 否 | 否 |
| `semantic-recall` | 否 | 否 | 是 | 是 |

- **default-index**：索引在 session 初始化时读一次，进 `context_prefix`（不是 system），
  上限 200 行 / 25000 字符；运行中不刷新，冷恢复/rewind 才原位刷新。
- **semantic-recall**：每个 session 扫 manifest（最多 200 个文件，只读前 30 行），
  用 **Lite model + 结构化输出**做 selector（`max_tokens=256`，返回文件名数组），
  取前 5 个读正文（200 行 / 4096 字节上限），累计 61440 字符后停止。
  **没有关键词 fallback、没有 timeout、没有 retry**——error/abort/无效 JSON 一律"空选择"。

这是个很干净的"二选一"设计：**索引常驻**简单可预测；**selector** 省上下文但多一次模型调用
且不可解释。ZCode 把默认值押在简单那一边。

### 2.3 后台抽取：fire-and-forget 的子 Agent

`memory/extraction.ts` + `runtime/helpers/project-memory-extraction.ts`：

```text
成功 Main turn（非 remote、无 child agentId）
   |
   +-- 本段已有 Memory Write/Edit → 跳过并推进 cursor（模型自己写过了）
   +-- 没有 ≥3 words 的独立 user text block → 跳过并推进 cursor
   |
   +-- running 为空 → 立即跑；非空 → 覆盖 latest pending（只有 1 running + 1 pending，不排队）
   |
   +-- 独立 executor：Read/Grep/Glob + 只读 Bash + root 内 .md Write/Edit + 窄 rm
   +-- 最多 5 个 model turn；失败不重试
   +-- 无操作时逐字返回 `Nothing to save.`
```

prompt 的核心约束值得抄：

- **"只能使用最近 ~N 条消息的内容"**，明确禁止去 grep 源码、读代码"验证"；
- **"turn 1 并行发所有 Read，turn 2 并行发所有 Write/Edit"**——因为 Edit 需要先 Read，
  交错会烧完预算；
- 索引清单（manifest）直接放进 prompt，要求先查重再写。

### 2.4 Dream：巩固但**不自动触发**

`memory/dream.ts`（239 行）：

- gate：10 分钟最多扫一次；距上次成功 ≥24h；当前 project ≥5 个（排除当前 session）
  transcript mtime 晚于上次 consolidation。
- lock：`.consolidate-lock` 写 PID + read-back 校验所有权；<1h 且 PID 存活则跳过；
  error/abort 时删除新 lock、恢复旧 lock 空内容与原 mtime。
- 复用抽取的受限执行策略，最多 50 turn；prompt 固定四阶段
  orient → signal → consolidate → prune/index，要求最终 `MEMORY.md` < 200 行 / ~25KB。
- **当前产品链路不自动触发**（没有 `/dream`）；`memory_update` 附件也只为 Dream 产生。

也就是说：**ZCode 把"整理"设计完整了，但故意没接自动触发**——等 transcript 隔离方案定了再开。
这个克制值得学：巩固逻辑一旦自动跑，误删的代价远高于"记忆脏一点"。

### 2.5 开关层级

三层 AND：`features.memory`（能力）→ `memory.use`（行为）→ Desktop app-global `memoryEnabled`
（kill switch，默认 **false**，只在根 Runtime 创建时读一次，会话内切换不热更新）。

## 三、两家对比与我们现状

| 维度 | Cindy | ZCode | 我们（2026-11-06 前） |
|---|---|---|---|
| 存储 | 文件分片 + `MEMORY.md` 自动重建 + FTS5 | 文件分片 + `MEMORY.md` 模型维护 | **SQLite 单表**（kind/scope/content/importance/…） |
| 写入者 | 模型（MCP 工具，主动） | 模型（Write 工具）+ 后台抽取 Agent | 规则抽取（每句都记）+ `remember` 工具 |
| 类型 | 4 类 + digest | 4 类 | 4 类，但抽取恒为 `episode` |
| 检索 | 索引常驻 + FTS 按需 | 索引常驻（默认）/ selector（未启用） | 加权打分：importance .45 + recency .3 + keyword .2 + recallCount .05；FTS 只做候选集 |
| 整理 | `memory_review` 出建议，模型自己动手 | Dream（不自动触发） | 同 scope 字符串全等 → importance +0.1 |
| 作用域 | workdir / bot | workspace / agent | global / day / topic / session / partner |
| 去重 | 撞名拒绝 + 明确 update 语义 | 文件名即事实，覆盖同文件 | 字符串全等 |

**我们的真实缺口**（`docs/基线文档/系统架构.md:123` 已登记）：

- 抽取是 `HeuristicExtractor`：只按句切、只记 `episode`、`importance = min(1, len/60)*0.6+0.2`。
- `preference` / `fact` / `entity` 三个 kind **从抽取层永远产不出来**（只有 `remember` 工具能写）。
- 于是"用户偏好"这件事：模型得主动调 `remember(kind="preference")` 才会存在。而 `remember`
  的描述里没有"何时该记偏好"的判据，全靠模型自觉 —— 实测就是基本不记。

## 四、本次落地的取舍

### 4.1 只做"偏好"，不重做架构

**不做**：换文件存储、上 embedding、做 Dream/巩固 cron、做 MCP 渐进工具、迁移历史记忆。

**做**：把"抽取层识别偏好"这条补上，让 `preference` 从死值变成活路径；配一个能看能删的页面。
理由：

- 存储换文件的收益在"人可读可编辑"，代价是并发/事务/迁移全套重来 —— 我们的 SQLite 本来
  就支持事务，personal agent 规模也没到需要手改文件的地步。
- 用户明确说了"已经存好的记忆后期再接入"：现在动存储形状，等于把后期接入变成一次数据迁移。

### 4.2 抽取：LLM 优先，规则兜底，**默认不改变现有行为**

新增 `PreferenceExtractor`（memory 包内），两条路：

```text
会话结束（onSettled status=done）
   |
   +-- MEMORY_EXTRACT=llm 且当前模型可用 → 一次小请求（独立 from 主会话）
   |      失败/超时/非法 JSON → 静默回落到规则
   |
   +-- 否则 → HeuristicExtractor（原行为原样）
```

**关键约束：只抽偏好，不抽别的。** 一次请求只要 JSON 数组，每项 `{content, why, howToApply, confidence}`，
上限 5 条。这样：

- 抽取的增量成本可预算（一条小 prompt，不进主上下文）；
- 不会把主对话内容整段送去第二次（只送最近 N 轮的用户消息 + 助手回复的首句）；
- 结果可解释（每条带 why/howToApply，正是 Cindy `feedback` 类要求的形状）。

**为什么不学 ZCode 的"完整子 Agent"**：那需要工具、多轮、受限执行策略、cursor、pending 槽，
是"跨仓库契约级"工程量；而我们真正缺的只是"偏好识别"这一个判断。等抽取质量真的成为瓶颈再升级，
路径是通的（`Extractor` 接口不变）。

### 4.3 偏好必须有 `why` / `howToApply`

Cindy 对 `feedback` 强制 `**Why:**` 与 `**How to apply:**`；ZCode 同样要求。我们照做：

- 存储上不新增列（`MemoryRecord` 契约不动），把两段写进 `content` 的固定形状：
  `偏好本身\nWhy: …\nHow: …`。召回注入时按行渲染，预算按整条算。
- 为什么不做成结构化字段：那要动 `MemoryRecord` → durable/手机端/导出全跟着动，
  而这两段**只给人看和给模型读**，不是查询维度。属于"用文案解决的问题不要动 schema"。

### 4.4 冲突处理：只做"显式取代"，不猜语义

新增 `supersedeMemory(id, byId)` 的引擎方法 + 页面上的"这条已过时"入口（可选 byId 为空 =
仅下线）。**不做**自动语义去重/冲突消解：

- 语义冲突判断要么靠 LLM（贵、且会误杀），要么靠规则（必然误杀）。
- 现有 `supersededBy` 字段本来就是为这个留的，手工/模型显式取代已经够用。

### 4.5 注入：偏好单独成段，优先级最高

`buildContext` 现在把所有命中拼成一段 `- [kind] content`。改为：

```text
以下是你记得的关于这个人的信息（按相关度排序）。自然使用，不要逐条复述，也不要提及「记忆」这个词：
【偏好】…（最多 6 条，先排）
【其它】…
```

理由：偏好是**稳定且高价值**的，不该跟"今天面试挂了"抢同一段预算的排序。但这只是排序分组，
**不改变召回算法**（同一批 hits，按 kind 稳定分组），所以 `RecallHit`/`Retriever` 契约不动。

### 4.6 页面：只读 + 删除 + 取代

设置页新增「记忆」分区（照 Cindy 的 Memory 页）：

- 列表：分组（偏好 / 事实 / 经历 / 人事物）、条数、正文前 80 字、来源与时间；
- 操作：删除（软删？不，硬删 —— 记忆是私人物，删就是删）、标记过时（取代）；
- **不做编辑**：编辑记忆等于让它变成第二个人格；宁可删了重记。
- **不做搜索**：条数规模是千级，先给分组滚动；等真的过千再加（与设置页"不做全局搜索"同口径）。

## 五、契约与实现清单

| 层 | 文件 | 改动 |
|---|---|---|
| memory 包 | `src/extract.ts` | 新增 `PreferenceExtractor`（LLM 一次请求）+ `parsePreferenceJson` 纯函数；`HeuristicExtractor` 不动 |
| memory 包 | `src/recall.ts` | 新增 `rankedHits`（分组排序），`recall` 行为不变 |
| memory 包 | `src/engine.ts` | `buildContext` 分组渲染；新增 `supersede()` |
| memory 包 | `src/store.ts` | 无需改动（`patch` 已支持 `supersededBy`） |
| server | `src/memory-extract.ts`（新） | 装配：选 LLM/规则、裁剪输入、超时、失败回落 |
| server | `src/agent.ts` | `ingestTurn` 改为带抽取器的调用；新增 `memoryOverview/delete/supersede` 导出 |
| server | `src/memory-api.ts`（新） | `GET /api/v1/agent/memory`、`DELETE /api/v1/agent/memory/:id`、`POST …/:id/supersede` |
| server | `src/index.ts` | `mountMemoryApi(app)` |
| web | `web/app.js` + `style.css` | 设置页「记忆」分区 |
| 契约 | `docs/基线文档/接口文档.md` | §2.15 三个端点 + §4 工具表 + §6 两个 env |
| 机制 | `docs/基线文档/系统架构.md` | §7 已知边界改写、D17 新决策 |

回滚开关：

- `MEMORY_EXTRACT=rule`（默认 `auto` = 有模型则 LLM、无则规则）→ **逐字节回到 2026-11-06 之前**。
- `MEMORY_ENABLED=false` 既有总闸不动。

## 六、明确不做

- 不换文件存储、不引入 embedding/向量库；
- 不做自动巩固（Dream/cron）、不做语义去重、不做跨设备同步；
- 不做历史记忆迁移/导入（等"后期接入"单独一轮）；
- 不做记忆编辑、不做全文搜索、不做导出；
- 不改 `MemoryRecord` / `MemoryCandidate` 契约形状（`why/how` 走 content 文案）；
- 不加"记忆"工具给模型（`remember`/`recall` 已够，且 MCP 渐进发现对单机没必要）；
- 不改 `partner:<id>` 键空间、不改群会话跳过记忆的四处判定。

## 七、验收

| 范围 | 断言 |
|---|---|
| 抽取 | 规则档：同一段对话产出的记录与 2026-11-06 前**逐字段一致**（kind 仍 episode） |
| 抽取 | LLM 档：非法 JSON / 超时 / 上游报错 → 回落到规则，且日志不含对话内容 |
| 抽取 | 只抽 `preference`；`confidence < 0.6` 丢弃；超过 5 条截断；同一 scope 相同 content 只强化 |
| 注入 | 有偏好时偏好段在前；无偏好时输出与旧版**逐字节一致** |
| 取代 | `supersede` 后旧记录不再进召回候选，`includeSuperseded` 仍可查 |
| API | 三个端点：403 空体（未鉴权）、关闭记忆时 404、删除不存在 id 404、正常路径投影正确 |
| 页面 | 记忆分区可渲染、空态文案、删除需 confirm、开关关闭时显示"未启用" |
| 回归 | `pnpm typecheck`、`pnpm memtest`、`pnpm --filter @lifediary/server test`、`pnpm probe` |
