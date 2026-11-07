# 长期课题跟进 · 批二（搜索设置 + 提议卡 + 侧栏课题区）实施任务书（CodeBuddy）

- 日期：2026-11-07
- 派发人：总管（ZCode 会话）。批一（服务端底座）已验收通过：search/topics/topic-runtime/topic-api 已在，端点见 §三。
- 上位方案：`docs/设计方案/2026-11-07-长期课题跟进.md`。

## 〇、范围红线（先读）

1. **只碰**：`ts/apps/server/web/{app.js,index.html,style.css}`、新增 `src/search-api.ts`、`src/index.ts` 接线一行。
2. **不碰**：`ts/packages/shared/**`、`desktop/**`、`docs/**`、批一已验收的 src 文件（search/topics/topic-runtime/topic-api/tools/agent 的既有逻辑不改，最多 import）。
3. **工作区有并行未提交改动**：设置→服务页正在被另一个会话加"运行时起停"卡，app.js 里还有群组导航与派活留言的新代码。你**只做插入式编辑**：动手前先重读目标区域拿最新锚点，绝不动运行时卡/群组/派活留言的任何代码，不顺手重构、不重排、不改无关行。
4. **禁止一切 git 写操作**。**密钥纪律**：key 值不进任何 console.log、不进 DOM 属性/title/localStorage；响应与界面只出现变量名 `DEEPSEEK_SEARCH_API_KEY`。
5. style.css 新增样式统一追加在文件尾部（新增媒体查询必须排在本体定义之后——历史教训）。

## 一、服务端：搜索配置端点（新 `src/search-api.ts`）

注册形态照 `src/group-api.ts`（拿 app），`index.ts` 在 `mountTopics(app)` 附近加一行接线。鉴权走全局中间件，不单独处理。

```text
GET    /api/v1/agent/search   → { ok:true, keyEnv:"DEEPSEEK_SEARCH_API_KEY", hasKey:boolean }
PUT    /api/v1/agent/search   → body { apiKey:string }；空串 400 bad_request；非空 →
                                writeProviderKey("DEEPSEEK_SEARCH_API_KEY", v) 并热注入 process.env
                                （语义照 index.ts:563 的 PUT /providers/:id/secret：响应只回 { ok, keyEnv }，
                                绝不回显值；PROVIDER_SECRETS=false 时照同款返回 secrets_disabled）
DELETE /api/v1/agent/search   → removeProviderKeys(["DEEPSEEK_SEARCH_API_KEY"]) → { ok, hasKey:false }
POST   /api/v1/agent/search/test → 真调一次 webSearch("连接测试", 1)：
                                成功 { ok:true, hits:<n>, message:"搜索通了，返回 n 条" }；
                                失败 { ok:false, error:<枚举同 search.ts>, message:<引导文案> }
```

- 热注入后 `searchConfigured()` 必须立刻变 true（批一 search.ts 读的就是 process.env）。
- 日志只许记"测试成功/失败 + 枚举"，不记 query 原文与 key。

## 二、设置页「搜索」区块（服务页，插入式）

- 位置：设置 → 服务页，紧挨现有区块放一张「搜索（课题研究用）」卡。**先重读当前服务页 DOM 结构再插**（并行会话可能已加了运行时卡）。
- 内容与行为：
  - 一行说明：「DeepSeek 搜索，给长期课题的每周研究查资料用。」
  - 变量名展示 `DEEPSEEK_SEARCH_API_KEY` + 当前状态（进页 GET 一次：已配置 / 未配置）。
  - 直填框：照密钥直填形态（`secret-wrap` + `secret-eye`，app.js:10002 范式；type=password 切换只换 type，不落值；留空 = 不改）。
  - 「保存」→ PUT；「测试连接」→ POST test；结果文案化（通了返回条数 / 未配置提示先保存 / 上游错误枚举）。
  - `PROVIDER_SECRETS=false` 或 PUT 404/secrets_disabled → 退回"只展示变量名 + 提示手写进 .env"的老形态（照 app.js:10385 的 api/env 双形态先例）。
- 「删除 key」不提供（要换就覆盖填新的）——刻意没有，不问为什么。

## 三、批一已有端点（你的调用面，不要改它们）

```text
GET    /api/v1/topics              列表 { topics:[{id,question,flavor,cron,status,nextFireAt?,latestFinding?}], activeCount }
GET    /api/v1/topics/:id          详情（findings 全量，倒序）
PATCH  /api/v1/topics/:id          { cron?, status?("active"|"paused") }
POST   /api/v1/topics/:id/close    { reason? }
POST   /api/v1/topics/:id/run_now
GET    /api/v1/topics/proposals/:id          { proposal: { id, question, flavor, cron, status, expiresAt } }
POST   /api/v1/topics/proposals/:id/accept   → { ok, topic }（400: search_not_configured/topic_limit/exists/expired/not_found）
POST   /api/v1/topics/proposals/:id/decline
```

（字段名以 `src/topic-api.ts` 实际实现为准——动手前先读它，别按本文猜。）

## 四、对话流「课题提议」卡

- `TOOL_KINDS`（app.js:3107）加两行：`propose_topic`（verb「提议课题」）、`web_search`（verb「搜索」）。图标优先复用 `TOOL_ICON_PATHS` 现有条目；确实没有才照 Lucide 官方比例新增内联 path（历史教训：stroke 随视框折算，别手画）。
- 渲染：transcript 里识别 `propose_topic` 工具结果 JSON（含 proposalId/question/flavor/cron）→ 渲染一张卡，样式照审批卡的挂法（app.js:4045 区域的 attention 卡构建思路），位置就在该工具消息处（对话末尾自然出现，满足"对话结束放底下"）。
- 卡内容：题目、口味人话（watch=盯梢型·盯变化 / dig=啃题型·每周推进）、节奏 cron 转人话（"每周一 09:00"；转不了的原文展示）、提议有效期。
- 四态（渲前先 `GET proposals/:id` 定态；同一 callId 只渲一次，照 approvalCards 的 Map 防重）：
  - pending：两按钮「开课题」「不用了」→ accept / decline；accept 成功 → 卡变「已开课题」态；decline → 灰化「已谢绝」。400 时按钮旁显示错误文案（search_not_configured 引导去设置页）。
  - accepted / declined / expired：对应灰化文案，无按钮。
- 请求失败不弹全局错误，卡内行内提示即可。

## 五、rail 入口 + 侧栏课题区

- rail（index.html:92-126 区域）加「课题」按钮，结构照 `rail-tasks`，tooltip「课题（展开侧栏查看）」。
- 侧栏展开区新增「课题」分区（照执事/群组分区的现有结构与开关风格）：
  - 列表项：题目 + 口味角标 + 下次研究时间（有 nextFireAt 才显示）。
  - 点击项展开 = 时间线：每次研究一条（日期 / 摘要 / 相比上次 / 正文默认折叠可展开）；`GET /topics/:id` 按需拉。
  - 操作：改节奏（每周几 + 时段两个下拉拼 cron → PATCH）、暂停/恢复（PATCH status）、关闭（先行内确认，POST close）。
  - 数据策略：侧栏展开时拉 `GET /topics`；任何操作成功后局部刷新。
  - 空状态一句话：「还没有在跟的课题。聊到值得长期跟进的问题，总管会提议。」
- rail 上不要求未读徽章（刻意没有）。

## 六、自验（全绿才算完）

```bash
cd ts
pnpm typecheck
pnpm --filter @lifediary/server test          # 存量不许变红
node --check apps/server/web/app.js           # 前端无构建，语法自查
```

- 界面行为你无法起浏览器验收（归总管），但要把每个交互的触发条件与预期写清（§七）。

## 七、汇报格式（最后一屏）

1. 新增/修改文件清单。
2. 服务页插入点与运行时卡的距离（证明没碰它）。
3. 每个新交互的"触发 → 请求 → 预期界面变化"清单（我来浏览器实测）。
4. 三条验证命令结论。
5. 遗留/不确定点；最后一行 JSON：`{"batch":"topics-2","files":<n>,"typecheck":"pass|fail","tests":"pass|fail","syntax":"pass|fail"}`。
