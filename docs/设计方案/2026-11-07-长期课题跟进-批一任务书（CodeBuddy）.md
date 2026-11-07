# 长期课题跟进 · 批一（服务端底座）实施任务书（CodeBuddy）

- 日期：2026-11-07
- 派发人：总管（ZCode 会话）。验收归总管，你负责按本任务书实施并自验到绿。
- 上位方案：`docs/设计方案/2026-11-07-长期课题跟进.md`（**先通读一遍**，本文与其冲突时以本文为准——本文按 2026-11-07 代码锚点写实）。

## 〇、范围红线（先读，越线即返工）

1. **只做服务端**：`ts/apps/server/src/**`、`ts/apps/server/scripts/**`、`ts/apps/server/package.json`。
2. **不碰**：`ts/apps/server/web/**`（界面是批二）、`ts/packages/shared/**`（一期零契约改动）、`desktop/**`、`docs/基线文档/**`、`.env`、`.data/` 真实数据、`ts/apps/server/skills/**`。
3. 工作区里**已有别人的未提交改动**（delegation*、partner-manage、desktop 等）。编辑 `tools.ts` / `agent.ts` / `index.ts` / `package.json` 时**只做本任务需要的最小插入，绝不动、不重排、不"顺手整理"任何无关代码**。
4. **禁止一切 git 写操作**（不 commit / 不 stash / 不 branch / 不 checkout）。
5. 对外 id 一律 `randomUUID()`；密钥与搜索原文不进任何 `console.log`；日志只许记条数/字数/耗时/枚举。

## 一、交付物总览

| 文件 | 新/改 | 内容 |
|---|---|---|
| `src/search.ts` | 新 | DeepSeek 搜索适配层 |
| `src/topics.ts` | 新 | 课题存储 + 纯逻辑 |
| `src/topic-runtime.ts` | 新 | TopicTask（durable 闹钟）+ 研究回合引擎 |
| `src/topic-api.ts` | 新 | REST 端点注册 |
| `src/tools.ts` | 改 | `web_search` + `propose_topic` 两个工具（deps 注入） |
| `src/agent.ts` | 改 | 课题 section（清单 + 嗅探判据 + 感知推送） |
| `src/index.ts` | 改 | topic-api 接线 |
| `src/search.test.ts`、`src/topics.test.ts` | 新 | 单测 |
| `scripts/topic-probe.ts` | 新 | 真起服务探针 |
| `package.json` | 改 | 加一条 script `"topic"` |

## 二、搜索适配层 `src/search.ts`

锚点：密钥两路落点见 `src/provider-secrets.ts`（启动全量注入 process.env，已有 env 优先）；"测试连接"语义照 `src/provider.ts:1724-1750`（test 分支：只验证"key 有值 + 端点可访问"，不写文件）。

```ts
export interface SearchHit { title: string; url: string; summary: string; }
export type SearchResult =
  | { ok: true; hits: SearchHit[] }
  | { ok: false; error: "search_not_configured" | "upstream_error" | "bad_response"; message: string };
export function searchConfigured(): boolean;            // process.env.DEEPSEEK_SEARCH_API_KEY 非空
export function searchKeyEnv(): "DEEPSEEK_SEARCH_API_KEY"; // 给设置页/文档展示用，只回变量名
export async function webSearch(query: string, count?: number): Promise<SearchResult>;
```

- 端点：`${process.env.SEARCH_BASE_URL?.trim() || "https://api.deepseek.com"}/v1/tools/search`，`POST`，头 `Authorization: Bearer <key>`，体 `{ query, count, need_content: true }`。`SEARCH_BASE_URL` 只给探针指本地 stub 用（这是测试开关，不是供应商抽象）。
- `count` 收敛到 1..10（默认 5）；query 去空白、空串直接返回参数错误。
- 20 秒超时（`AbortSignal.timeout(20_000)`）；非 2xx → `upstream_error`（message 只写状态码，不写上游返回原文——原文可能含敏感内容）；响应 JSON 没有 `results` 数组 → `bad_response`。
- `search_not_configured` 的 message 必须是引导文案：「搜索还没配置：去 设置 → 服务页 填 DEEPSEEK_SEARCH_API_KEY（可在 .env 直接写）。」
- 未配 key 时**必须**返回这个错误，不许返回假结果、不许空转（mock 纪律）。
- 日志（如需）：只许 `query 字数` 与 `结果条数`，禁止打印 key、URL query 原文、响应体。

## 三、课题存储 `src/topics.ts`

范式照抄：`src/routines.ts` 的 `load()/save()`（tmp + `renameSync` 原子替换、坏文件当空账）与 once 加载；状态文件 `.data/topics.json`，环境变量 **`TOPICS_STATE_PATH`** 可覆盖（探针用，同 `ROUTINES_STATE_PATH` 先例）。存储类导出单例 getter（风格照 `partnersStore()`）。

数据结构（方案 §二 T1，照此落）：

```ts
interface TopicFinding { id: string; date: string; summary: string; body: string; noNew: boolean; runConversationId?: string; }
interface Topic {
  id: string; question: string; flavor: "watch" | "dig";
  cron: string;                    // 例 "0 9 * * 1"
  status: "active" | "paused" | "closed";
  revision: number;                // 任何 patch +1
  origin: "user" | "proposal";
  findings: TopicFinding[];
  pendingPush: boolean;
  noNewStreak: number;
  lastRunAt?: string; lastError?: string;
  createdAt: string; closedAt?: string; closeReason?: string;
}
interface TopicProposal {
  id: string; question: string; flavor: "watch" | "dig"; cron: string;
  origin: "user" | "proposal";     // user=直说, proposal=总管嗅探
  status: "pending" | "accepted" | "declined" | "expired";
  createdAt: string; expiresAt: string;   // 72h
  decidedAt?: string;
}
```

导出方法（全部走内存态 + save）：

- `proposeTopic(input: { question; flavor; cron?; origin }): { ok: true; proposal } | { ok: false; reason: "exists" | "limit" | "search_not_configured"; existingTopicId?; message }`
  - `cron` 缺省 `"0 9 * * 1"`（每周一 09:00）；合法性用 `cron.ts` 的 `nextCronFire(expr, new Date()) !== null` 校验。
  - 查重：question 归一化（trim + 压缩连续空白）后与任一 `active|paused` 课题相同 → `exists`（带 existingTopicId）。
  - 上限：`active|paused` 课题数 ≥ 5（常量 `TOPIC_MAX = 5`）→ `limit`。
  - **硬前提**：`searchConfigured()` 为假 → `search_not_configured`（方案 S4：没搜索开不了课题）。
- `acceptProposal(id): { ok: true; topic } | { ok: false; reason: "not_found" | "expired" }`——建 Topic（uuid、revision 1、active、origin 继承）、proposal → accepted。**排程不在存储层做**（runtime 层 ensureScheduled）。
- `declineProposal(id)`、`expireProposals()`（扫描 pending 且过 72h → expired，可在任意读路径顺带调）。
- `appendFinding(topicId, { summary, body, noNew, runConversationId? })` → unshift 进 findings、`pendingPush = true`、`noNewStreak = noNew ? noNewStreak+1 : 0`、`lastRunAt = now`。
- `markPushed(topicId)`、`listActive()`、`get(id)`、`patch(id, { cron?, status? })`（revision+1；status 允许 active⇄paused）、`close(id, reason)`。
- 摘要 helper：`digestForInjection()` → 给 agent section 用的紧凑文本（见 §六）。

## 四、定时与研究回合 `src/topic-runtime.ts`

### TopicTask（照抄 `routines.ts:87-110` RoutineTask 范式）

- `defineTask`：`wait` = `runtime.sleepUntil(input.fireAt, { phase: "deliver" })`；`deliver` = **同一个 commit 事务里先排下一次**（`nextCronFire(cron, now)`，无下一次说明课题到期不排）再 fire-and-forget 触发研究引擎；醒来先核对 `revision` 与课题 `status === "active"`，对不上就作废不排下一次。
- ownership 用 `{ kind: "conversation" }`，commit 挂在**总管主会话**上——取法照 `routines.ts:292-309` ensureScheduled 用 `ensurePartnerSession(...)` 的写法，但传总管的规范 id：`CHIEF_PARTNER_ID`（agent.ts 的 persona render 在用它判"非总管执事"，定义位置自查 `src/partners.ts`，用 `ensurePartnerSession(CHIEF_PARTNER_ID)` 拿总管会话再 `chat.conversation.commit(..., CTX)`）。`CTX = BACKGROUND_CONTEXT`（照 routines.ts:453 注释先例——它只是必须穿传的调用上下文，不携带内容）。
- `ensureScheduled(topicId)`：幂等——先跑 `expireProposals()` 无关；按当前 cron 算下一次 `createTask`。`patch` 了 cron / 暂停后恢复时重排；paused 不排。
- `TOPICS_ENABLED`（envFlag 范式照 `tools.ts:206`）：false 时 `ensureScheduled` no-op、Task 不触发、工具不注册、API 路由 404。

### 研究回合 `runResearchTurn(topicId, { trigger })`

1. 串行：同一课题上一次没跑完 → 本次跳过并在 lastError 记 "deferred"（照 routines.ts 的 lanes/deferred 思路，进程内 Map 足够，课题只有 5 个）。
2. 建专线会话：仿 `partner-runtime.ts:285-305` fresh session——`openOrCreateChat(\`task-topic-${topic.id.slice(0,8)}-${Date.now()}\`)`，不 linkSession（课题归属记在自己 topics.json 的 runConversationId 里即可）。
3. `conversation.configure({ instructions: 研究提示词 }, CTX)`。提示词按 flavor 两段模板（常量写在 topic-runtime.ts）：
   - 公共头：你是总管的研究分身，正在执行一次定时研究；只做调查与综合，不改文件、不派活。
   - 注入：课题问题、口味说明、**全部 findings 日志**（倒序，最多最近 20 条，每条带日期）。
   - watch 段：重点是"与上次相比有什么变化"；查不到新东西就明说。
   - dig 段：重点是"接着上次往下啃一小块"；说明这次推进了哪一块。
   - **收尾格式（硬约定）**：最后一行必须是 `相比上次：<变化描述>` 或 `相比上次：无新进展`；再上一行 `结论：<一句话>`。运行时按"最后一行含『无新进展』"确定性判定 noNew（解析失败当有进展）。
4. **工具面收敛（必做，两案选一落地）**：目标 = 只读 + web_search，禁 write/edit/bash/delegate/skill/partner_*。
   - 首选：仿 `agent.ts:1056-1068` `configureTaskChat` 的 `configure({ tools })` 白名单（若能引用 lifediaryExt 里的 `web_search` 就用它）；
   - 备选：保留全局 registry，在 `agent.ts` 的 beforeTool hook（`agent.ts:772-800`）里按"本会话是否课题专线"（运行时 Map：topicRuntime 登记自己的 runConversationId → 暴露 `isTopicRun(conversationId)`）拦截——`WRITE_TOOLS ∪ SHELL_TOOLS ∪ {delegate, skill, partner_skill_write, partner_manage, group_manage, propose_project, propose_topic, remember}` 在课题会话一律 block（理由文本写清"研究回合是只读的"）。
   - 选了哪案写进汇报。
5. 跑：照 `runPartnerTurn` 的 chatStream 聚合写法（`partner-runtime.ts:163-238`）：`for await chatStream({ conversation, text: 用户态的研究指令（"开始本次研究"即可，材料都在 instructions 里）, requestId: randomUUID(), onSettled })` 收 delta。模型用当前默认链（不传 model 覆盖）。
6. 收尾：最终 assistant 文本 → 提取「结论：」行当 summary（缺失就取全文前 80 字）；`appendFinding(...)`（runConversationId 记专线会话 internalId）；失败/异常 → `lastError` 记枚举原因，不抛出进程。
7. `runNow(topicId)`：跳过 cron 直接触发一次（entrusted 语义，探针与后续界面用）。

## 五、工具 `src/tools.ts`（最小插入）

- `ToolDeps` 增两个可空依赖：`topics?: TopicsStore`、`search?: SearchModule`（照 `deps.projects` 的可选注入风格）。`createTools` 内 `TOPICS_ENABLED=false` 或依赖缺失 → 不注册这两个工具。
- `web_search`：
  - description：查公开网络资料拿事实（新闻/行情/论文/文档），适合课题研究与实时性问题；不适合内部文件（用 read）、不适合闲聊、一次搜索能答的别多搜。
  - parameters：`query`（必填）、`count`（可选 1..10）。execute 调 `deps.search.webSearch`，结果渲染成 `标题 — url\n摘要` 列表文本；失败返回结构化 JSON（照 propose_project 的 JSON 风格）含 error/message。
  - **不进 `WRITE_TOOLS`**（纯网络读，approval-policy.ts:27 不动）。
- `propose_topic`：
  - description 写清判据（从严）：开放性问题 + 今天给不了定论 + 值得隔几天回头看 + 用户显出兴趣；**只提交提议，不创建课题**；同一话题别重复提；用户直说"长期跟进/每周研究"时也用它。
  - parameters：`question`（≤200 字，一句话问题）、`flavor`（"watch"|"dig"，描述里解释两种口味）、`cron`（可选，默认每周一 09:00）。
  - execute：群组会话拒绝（照 `remember` 的 `partnersStore().isGroupSession(api.conversationId)` 守卫，tools.ts:247 附近）；然后 `deps.topics.proposeTopic({ ..., origin: 按语境 user/proposal })`；返回 JSON 含 proposalId/question/flavor/cron/状态提示（照 propose_project 的 message 提示语风格："已提交待确认：用户确认后才会建课题并开始每周研究"）。
- 注册位置：`tools.ts:689` 的 tools 数组，随现有开关段一起 push。

## 六、上下文注入 `src/agent.ts`（最小插入）

1. **课题 section**：`agent.ts:727-770` 的 extension `sections` 数组追加 `{ key: "topics", render }`：
   - `TOPICS_ENABLED=false` 或非总管主对话（照 persona section 的判定：COMPANIONS 下 `partnerIdOfSession` 非 CHIEF_PARTNER_ID 的执事会话、worker 会话都返回空）→ 返回 undefined。
   - 输出紧凑文本（≤12 行）：「在跟的课题」清单（题目 / 口味 / 下次研究时间 / 最新发现一句）+ 嗅探判据段（把 propose_topic description 里的判据在这里再压成两行，提示词从严、宁缺毋滥、同话题单会话最多提一次、永不自动创建）。
   - **感知推送**：若存在 `pendingPush` 课题，render 里追加「课题简报（攒着的，随本轮自然汇报给用户，别复述全文）」块（课题名 + 最新 finding 的 summary）。随后对这几条调 `markPushed`——**渲染即视为已通知**。若实现中发现 section 有缓存/不每轮重渲导致"二次活跃还报"，备选方案：把推送检查挪到 `index.ts:587` chat 路由（openChat 之后、chatStream 之前）注入。选了哪案、section 是否每轮重渲，写进汇报。探针必须覆盖"第二次活跃不再报"。
2. 不动 persona / current_project / skills 三个现有 section 的任何行为。

## 七、HTTP 端点 `src/topic-api.ts` + `index.ts` 接线

- 注册函数形态照 `src/group-api.ts` / `src/companion-api.ts`（拿 app + 依赖，index.ts 一行接线）。鉴权走全局中间件，**不单独处理**；业务拒绝 400 `{ ok:false, error, message }`；TOPICS_ENABLED=false 时整组路由 404（照 COMPANIONS 两阶段口径）。

```text
GET    /api/v1/topics                        列表（全部课题 + 进行中计数；不展开 finding 全文，给 summary）
GET    /api/v1/topics/:id                    详情（findings 全量）
PATCH  /api/v1/topics/:id                    { cron?, status? }（重排/暂停/恢复）
POST   /api/v1/topics/:id/close              { reason? }
POST   /api/v1/topics/:id/run_now            立即研究一次（探针用）
GET    /api/v1/topics/proposals/:id          提议状态（批二卡片刷新用）
POST   /api/v1/topics/proposals/:id/accept   建课题 + ensureScheduled
POST   /api/v1/topics/proposals/:id/decline
```

- accept 里 search 未配置 / 超限 / 提议过期 → 400 对应 error 码（`search_not_configured` / `topic_limit` / `expired` / `not_found`）。
- 响应里课题/提议/finding 全 uuid，无内部计数外泄。

## 八、探针 `scripts/topic-probe.ts`

照 `scripts/companion-probe.ts` 的骨架（真 spawn 服务 + 临时目录全套 env + fetch 断言 + ✓/✗ check）：

- env：`TOPICS_STATE_PATH`、`SEARCH_BASE_URL` 指向本地 stub（node http 随机端口返回固定 3 条 results）、`DEEPSEEK_SEARCH_API_KEY=probe-key`、`LLM_PROVIDER=faux`、`TOPICS_ENABLED=true`，其余持久化路径照 companion-probe 全套指临时目录。
- 用例（faux 模型下全部可跑，不依赖真模型）：
  1. 直发提议：`POST /api/v1/topics/proposals` 不存在——提议只来自工具；探针改为先在单测覆盖 `proposeTopic`，HTTP 探针直接造一条 pending proposal（写 topics.json 或提供 test 钩子都行，写清用的哪招）→ `accept` → `GET /topics` 出现 active 课题 + cron 已排（durable 侧看得到任务，或 runtime 暴露 nextFire 查询）。
  2. `run_now` → 研究回合跑完（faux 文本）→ finding 落库、`pendingPush=true`、noNewStreak 按 faux 输出解析。
  3. 感知推送：主对话发一条用户消息（`POST /api/v1/agent/chat` 全链路）→ 响应/事件流里出现简报 → 再发一条 → **不再出现**（markPushed 生效）。
  4. 未配搜索拒绝：另起一例 env 不给 key → accept → 400 `search_not_configured`。
  5. 上限/查重：连开 5 个后再 accept → 400 `topic_limit`；同题 → `exists`。
  6. 串联：PATCH 改 cron → 暂停 → 恢复 → close → 列表状态正确；`TOPICS_ENABLED=false` 重启一例 → 路由 404。
- package.json 加 `"topic": "tsx scripts/topic-probe.ts"`（照同文件其他探针条目样式，不加进根 probe 串联——总管验收时手动跑）。

## 九、自验（全绿才算完）

```bash
cd ts
pnpm typecheck
pnpm --filter @lifediary/server test
pnpm --filter @lifediary/server topic
```

- typecheck 必须零新增错误；test 全过（含存量）；探针逐条 ✓。
- 跑不动的项**如实写明**卡在哪，不许谎报（这是铁律，谎报比失败严重得多）。

## 十、汇报格式（最后一屏）

1. 新增/修改文件清单（分开列）。
2. 工具面收敛选了哪案；感知推送挂在哪、section 是否每轮重渲。
3. 三条验证命令各自的结论与关键输出行。
4. 遗留/不确定点（没有就写"无"）。
5. 最后一行输出 JSON：`{"batch":"topics-1","files":<n>,"typecheck":"pass|fail","tests":"pass|fail","probe":"pass|fail"}`。
