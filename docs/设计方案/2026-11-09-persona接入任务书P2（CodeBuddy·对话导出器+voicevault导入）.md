# 任务书 P2：对话导出器（lifediary）+ voicevault 导入脚本（中转归档批二）
> 状态：已执行（任务书，2026-11-09）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


> 上位方案：`docs/设计方案/2026-11-09-persona记忆库接入（检索工具+对话中转归档）.md`
> （契约一节 + D-丁 / D-戊 / D-己 是本任务的口径来源，先读）。
> 执行：CodeBuddy。派单人：总管。**独立 worktree，不 commit**（派完我验收后 cherry-pick）。
> 基线：`10bbe20`（批一已并入）。

## 一句话

两件独立的事，按顺序做：
**① lifediary 导出器**——每轮主对话真正收尾后，把用户原话+助手最终回复追加写进
`ts/apps/server/.data/persona-export/<yyyy-mm>.jsonl`（一行一轮，格式见方案契约节）；
**② voicevault 导入脚本**——`experiments/import_lifediary.py` 读那个目录增量导入 voice.db
（照 `import_qclaw_wechat.py` 的构造 Turn → ingest 模式），走通"lifediary → voicevault"这一跳。
persona 侧（gateway 收件箱 + 入库）本批**不做**，那是批三的存量回填与手动两跳。

## 改动项一：lifediary 导出器（仓库 lifediary-harness）

### 1. 新模块 `ts/apps/server/src/persona-export.ts`

1.1 导出 `appendPersonaExport(chat: { externalId: string }, plain: { role: string; content: string }[], model?: string): number`
   —— 返回写入行数（0 = 没写）。
1.2 触发点：`agent/settled.ts` 的 `turnSettledHandler` 里，`record.status === "done"` 分支、
   记忆抽取之前/之后都行（**不 await**，与记忆同款"写慢不拖东西"）。
   **注意 settled.ts 在 `agent/` 子目录**，而 persona-export.ts 放 `src/` 下——import 路径写对
   （`settled.ts` 已有 import `../memory-prune.ts` 的先例，照抄形状）。
1.3 会话过滤（方案 D-丁，硬口径，照 `settled.ts:56` 的现有判断写）：
   - `task-` 前缀会话 → 不导出；
   - **群会话**（`partnersStore().isGroupSession(chat.internalId)`）→ 不导出；
   - **执事会话**（`partnerScopeOf(chat.internalId)` 非 null，即 partner:<id> 键空间的会话）→ 不导出。
   只有主人的主对话（总管会话）导出。
1.4 行格式（**契约只有一份**，以方案文档契约节为准）：
   ```json
   {"v":1,"conversationId":"<externalId uuid>","turnId":"<durable 内部轮 id，record 里有>","ts":"<ISO 带时区>","userText":"...","assistantText":"...","model":"..."}
   ```
   - 一轮一条 user→assistant：从 `plain`（settled.ts 已转好的文本消息数组）里提取
     **最后一条 user** 与**最后一条 assistant**（assistant 只取最终回复，中间过程天然不在 settled 口径里）；
     user/assistant 全空的轮不写（至少一个非空）；
   - `turnId`：`SettledSubmissionRecord` 里有什么用什么（subId/id），拿不到就用
     `chat.externalId + ":" + ts`，**目的是幂等重放**；
   - `model`：拿得到就写（当前配置的模型名），拿不到写空串；
   - 追加写（`fs.appendFile`），按月文件 `<yyyy-mm>.jsonl`（本地时间），目录不存在就建；
   - UTF-8、一行一个 JSON、`\n` 结尾；写失败只 warn 不抛（导出绝不能打断对话）。
1.5 开关（方案 D-己）：`PERSONA_EXPORT_ENABLED`，**默认 false**——未配置/false/0 一律不导出
   （对外送数据默认不动，启用要 .env 显式写 true）。函数 `personaExportEnabled(env)` 放本模块。
1.6 日志纪律：只记 `轮数/字数/文件名`，**不记对话原文**（硬约束）。
   例：`[persona-export] 1轮 user=12字 asst=340字 → persona-export/2026-11.jsonl`。
1.7 单测 `persona-export.test.ts`（临时目录，不碰真实 .data）：
   - 正常一轮写一行、JSON 可解析、字段齐；
   - task-/群/执事会话不写；
   - 全空轮不写；
   - 开关默认关不写、true 才写；
   - 同月追加两轮 → 文件两行；跨月两个文件。

### 2. 装配接线（改动最小化）

2.1 `settled.ts` import `appendPersonaExport` + `personaExportEnabled`，在 done 分支里加
   约 5 行（含三项会话过滤）。**不改**函数签名、不动记忆逻辑顺序。
2.2 单测：settled 现有测试如有要补口径（先 grep `turnSettledHandler` 的测试）；没有就靠
   persona-export.test.ts + 探针覆盖。

## 改动项二：voicevault 导入脚本（仓库 voicevault，只新增一个文件）

### 3. `experiments/import_lifediary.py`（新文件，照 import_qclaw_wechat.py 的骨架）

3.1 常量：`SOURCE = "lifediary"`；导出目录默认
   `<repo>\ts\apps\server\.data\persona-export`（可用
   `LIFEDIARY_EXPORT_DIR` env 覆盖）；`--since YYYY-MM-DD` 增量、`--dry-run`、`--dir`。
3.2 读目录下全部 `*.jsonl`（按文件名排序），逐行解析方案契约的行格式（`v` 不是 1 的行跳过并计数）。
3.3 构造 Turn（**voicevault 的建模：一轮 = 一 user + 其后 assistants**）：
   - `vv.Turn("lifediary", session=<conversationId>, cwd=None, ts=<解析 ts>, user_raw=<userText>)`；
   - `turn.assistant.append(<assistantText>)`（非空才 append）；
   - assistantText 空但 userText 非空的轮照建（voicevault 允许 empty reply）；
   - userText 空但 assistantText 非空 → **孤儿 assistant，跳过并计数**（voicevault 解析层同款纪律）。
3.4 幂等：`vv.ingest()` 内部 uid 去重（`sha1(source|sid|ts|text)[:20]` + INSERT OR IGNORE），
   同一批重跑不多行。**不要**写 import_run 台账（那是 chat_import 的表，qclaw 脚本也没写），
   打印统计即可：`解析 N 行 → M 轮；入库 新增=x 重复=y 跳过=z 孤立回复=o`。
3.5 session 归组：voicevault 的 `session.sid = "lifediary:<conversationId>"` 自动生成；
   title 留空（batch 三批之后可人工补）。
3.6 **不做**的事：不改 voicevault.py 主体、不加 SOURCES 条目（scan 不适用 lifediary 的导出文件形态，
   走定制导入先例）、不碰 persona-metric。
3.7 验证（在 voicevault 仓库根）：
   - 先造 fixture：在临时目录手写 3 行 jsonl（一轮正常、一轮 assistantText 空、一行 v=2 脏数据）；
   - `python experiments/import_lifediary.py --dir <fixture目录> --dry-run` 看统计输出正确；
   - **真跑一遍**（真写 voice.db，导入 fixture 的 2 轮）→ 再跑第二遍确认 `重复=2 新增=0`（幂等）；
   - 真跑后查库：
     ```bash
     python -c "import sqlite3;con=sqlite3.connect('data/voice.db');print(con.execute(\"select source,sid,ts,user_text from turn where source='lifediary'\").fetchall())"
     ```
     确认 sid 形如 `<conversationId>`、ts 非空；
   - 跑完把 fixture 的 2 轮**留在库里**（真数据无害；不提供删除功能——只增不改纪律）。
   - ⚠️ 真跑写入的是**真 voice.db**：fixture 的 conversationId 用 `test-` 前缀（如
     `test-fixture-0001`），与真实 uuid 区分开，以后要清理能一眼认出来。

## 铁律

1. **不许 commit**。lifediary 侧变更记录：
   `docs/变更记录/2026-11-09-persona记忆库接入批二（对话导出器+voicevault导入）.md`。
2. lifediary 侧：不改 shared 包、memory 包、注入链、recall / persona-ask（批一产物）；不碰 web/。
3. voicevault 侧：**只新增** `experiments/import_lifediary.py` 一个文件；voicevault.py 主文件
   与 docs/ 一行都不许动；不直接 UPDATE/DELETE voice.db 任何行（只 INSERT OR IGNORE）。
4. persona-metric 一个文件都不碰。
5. 日志不含对话原文（两边同一条纪律）。
6. 导出文件含对话原文，是隐私产物：**只在 .data 下**（.gitignore 已覆盖 .data，确认一下没把
   persona-export 漏进 git——`git check-ignore ts/apps/server/.data/persona-export/test.jsonl`）。

## 验证（最小充分，都要看输出）

1. lifediary 侧：`pnpm typecheck` 0 错；`pnpm --filter @lifediary/server test` 全绿。
2. lifediary 侧真探针：临时环境起服务（faux + `PERSONA_EXPORT_ENABLED=true` + 临时导出目录），
   发两轮对话 → 断言导出文件出现两行、字段齐、task 会话不在（可以不做这步探针，但要在
   交付说明写清为什么——例如 faux 轮 settled 路径已被单测覆盖）。
3. voicevault 侧：§3.7 的 fixture 三步（dry-run → 真跑 → 重跑幂等）输出贴进交付说明。
4. `git check-ignore` 输出贴进交付说明（证明导出文件不进 git）。

## 交付物

lifediary：persona-export.ts + 单测 + settled.ts 五行 + 变更记录（不 commit）。
voicevault：experiments/import_lifediary.py（不 commit——voicevault 仓库的提交由派单人验收后处理）。
交付说明：做了什么 / 验了什么 / 拿不准的（尤其 ts 与 assistantText 空轮的取舍）。
