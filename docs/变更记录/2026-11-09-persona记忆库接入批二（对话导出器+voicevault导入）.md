# 变更记录：persona 记忆库接入批二（对话导出器 + voicevault 导入）

日期：2026-11-09。任务书：P2（派单说明随会话下发的任务书全文）。
上位方案：`docs/设计方案/2026-11-09-persona记忆库接入（检索工具+对话中转归档）.md`（契约节 + D-丁 / D-戊 / D-己）。
基线 `10bbe20`，独立 worktree `persona/p2-export-import`，本批**不 commit**（派单人验收后 cherry-pick）。

## 改了什么

### 1. lifediary：`ts/apps/server/src/persona-export.ts`（新）

- `appendPersonaExport(chat, plain, model?, deps?)`：settled done 轮追加一行
  `{v:1, conversationId, turnId, ts, userText, assistantText, model}` 到
  `PERSONA_EXPORT_DIR`（默认 `.data/persona-export`）的 `<yyyy-mm>.jsonl`。
  同步返回"排队行数"（0/1），写盘走 `appendFile`、**不 await**、失败只 warn。
- `appendPersonaExportAsync(...)`：同一实现的异步核心，单测直接 await（同步门面只是 fire-and-forget 包装）。
- 过滤（D-丁）：`task-` 前缀（`TASK_CONVERSATION_PREFIX`，与 `settled.ts:56` 同判断）、
  `partnersStore().isGroupSession(internalId)`、`resolvePartnerScope(store, id) !== null`（执事）。
  过滤查询抛错一律按"该跳过"处理——宁可少导，不把群聊 / 执事对话写进主人语料。
- `ts`：ISO 8601 **带本地时区偏移**（`+08:00`），按月文件也按本地时间；`turnId` 取 settled
  record 的 `id`，拿不到回落 `<conversationId>:<ts>`。
- 开关（D-己）：`PERSONA_EXPORT_ENABLED` 只有 `true`/`1`/`on` 才导，未配置 / false / 0 = 不导；
  `PERSONA_EXPORT_DIR` 可改落点（探针与自定义目录用）。
- 日志只记 `轮数 / 字数 / 文件名`，不记原文：`[persona-export] 1轮 user=12字 asst=340字 → persona-export/2026-11.jsonl`。

### 2. lifediary：接线（`agent/settled.ts` + `agent/session.ts`）

- `settled.ts` 在 done 分支、记忆抽取**之前**加约 6 行：开关过了才调 `appendPersonaExport`，
  传 `turnId: String(record.id)` 与最终回复的懒读取。放记忆引擎判断之前，是让导出不依赖
  `memoryEngine`（`MEMORY_ENABLED=false` 时照样导出）；记忆逻辑顺序未动。
- **偏离任务书字面的一处（必要）**：任务书说 assistant 从 `plain` 里取"最后一条 assistant"。
  实际 `plain` 是**请求时刻**的消息快照：web 端 `POST /agent/chat` 只带这一句 user
  （`web/app.js:5598`），编辑重发 / 审批续跑也只带 `[{role:"user"}]`——本轮新生成的回复
  根本不在里面；若照字面取，会把**上一轮**的 assistant 配给本轮 user（或永远为空）。
  处置：`ChatStreamInput.onSettled` 增加可选的第二参 `() => Promise<string>`（懒读取），
  `session.ts` 在 `submission.wait()` 兑现后传 `() => answerText(conversation)`
  （durable 里本轮最后一条 assistant 的纯文本，与流式补齐用的是同一个函数）。
  懒读取只在导出开关打开、且 `plain` 里没有尾随 assistant 时调用——默认关 = 零额外 durable 读。
  `turnSettledHandler(chat, messages)` 的签名不变。

### 3. lifediary：单测 `ts/apps/server/src/persona-export.test.ts`（新，已进 `test` 脚本）

临时目录 + 注入会话过滤替身（不碰真实 `.data` / `partners.sqlite`）覆盖：行格式与字段、
本轮最终回复（`reply` 懒读取）、task-/群/执事三项过滤、全空轮不写、开关默认关与显式开、
同月追加两行 / 跨月两文件、`turnId` 回落。8 条全绿。

### 4. voicevault：`experiments/import_lifediary.py`（新，只新增这一个文件）

- 读 `LIFEDIARY_EXPORT_DIR`（或 `--dir`）下全部 `*.jsonl`（按文件名排序），逐行按契约解析；
  `v != 1` / JSON 坏 / 缺 ts 记坏行，user 空的孤儿 assistant 记孤立回复（丢弃，与 voicevault 解析层同纪律）。
- `vv.Turn("lifediary", session=<conversationId>, cwd=None, ts=<本地 naive>, user_raw=<userText>)`，
  assistant 非空才 `append`；`--since YYYY-MM-DD` 逐轮过滤（在脚本内筛，dry-run 统计一致）。
- `vv.ingest()` 自带 uid 幂等（`sha1(source|sid|ts|user_text)[:20]` + INSERT OR IGNORE）；
  不写 import_run 台账、不加 SOURCES、不改 `voicevault.py`；脚本自身不 UPDATE / DELETE。
- `--dry-run` 只打印统计不打开库。日志只有计数，不含对话原文。

### 5. 文档下沉

- `接口文档.md` §3 补导出文件契约（行格式 / 幂等链 / 过滤 / 隐私），§6 补
  `PERSONA_EXPORT_ENABLED` / `PERSONA_EXPORT_DIR` 两行。
- `系统架构.md` §3 模块表补 `persona-export.ts` 一行，§7 补该能力的已知边界
  （纯增量、审批续跑轮的 user 侧是服务端指令、voicevault 既有丢弃规则）。

## 验了什么

- `pnpm typecheck`：0 错。
- `pnpm --filter @lifediary/server test`：488 pass / 0 fail（含新增 8 条）。
- `pnpm probe`：退出码 0，无 `✗`。
- 真探针（临时脚本，未入库）：faux + `PERSONA_EXPORT_ENABLED=true` + 临时导出目录，
  `AGENT_DB_PATH` 等全部隔离到 tmp；连发两轮 → `2026-11.jsonl` 两行，
  字段齐、`ts=2026-11-09T21:40:01+08:00`、`turnId` 分别为 11/16、`model=faux`、
  `assistantText` 两行都是 `（faux 模型）链路已通。`、userText 分别是两轮原话。
  （这条探针验证了"本轮回复"而不是上一轮——若按 plain 字面实现，assistantText 会是空串。）
- voicevault（fixture 3 行：正常 / assistant 空 / `v=2` 脏数据）：
  - `--dry-run`：`解析 3 行 → 2 轮；坏行=1 空轮=0；孤立回复=0`
  - 真跑：`入库 新增=2 重复=0 跳过=0`
  - 重跑：`入库 新增=0 重复=2 跳过=0`
  - 查库：`turn` 两行 `source=lifediary, sid=test-fixture-0001`，ts 非空；
    `session.sid=lifediary:test-fixture-0001`、`turns=2`。fixture 数据留在真库里（`test-` 前缀可辨识）。
  - `--since 2026-11-09 --dry-run` → `0 轮 / 早于since=2`；孤儿 assistant 行 → `孤立回复=1`。
- `git check-ignore -v ts/apps/server/.data/persona-export/test.jsonl` →
  命中 `ts/.gitignore:9:.data/`，导出文件不进 git。

## 拿不准 / 刻意没做

- **审批续跑轮会导出**：`continueConversation` 的 user 文本是「已批准 / 已拒绝」这类服务端指令，
  会作为 userText 落进导出文件。按任务书"续跑轮共用同一个 settled handler"的口径保留；
  它确实进了模型上下文，但不是主人原话。批三回填前若要剔除，需要一个可识别的标记（当前没有）。
- **插话（steer）可能多导一行**：忙时插话是独立提交，它也会走同一个 settle 回调；若这句话被并进
  正在跑的那一轮，导出会得到一条 `userText=插话`、`assistantText=该轮最终回复` 的行（主轮那条已导过）。
  数据不算错（插话确实是这一轮里的一条 user 消息），但会让 voicevault 里同一段回复出现两次；
  本轮没有专门处理（需要把 `whenBusy` 透到 settle 回调，超出"五行接线"的范围）。
- **`ts` 用本地时区偏移**：契约示例是 `+08:00`。`import_lifediary.py` 按 voicevault 既有 `_ts`
  口径统一转成本地 naive 存库，所以库里看不到偏移量（`2026-11-08T10:00:00`）。
- **userText 空、assistantText 非空的轮**：导出器照契约写（至少一个非空），但 voicevault
  的一轮必须由 user 锚定，导入时按孤儿丢弃并计数——这类轮实际进不了 persona。
  图片消息（纯文本化后 user 为空）属于此类。
- **不做**：导出侧去重（同 turnId 重放会再写一行，靠导入方 uid 幂等兜底）；
  存量回填、persona 侧收件箱 / 入库、voicevault→persona 两跳（批三）。
- **不动**：`shared` / `memory` 包、注入链、`recall` / persona-ask（批一产物）、`web/`、
  persona-metric；voicevault 除新增脚本外的任何文件。
