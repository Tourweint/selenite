# 批3a 任务书：从回答分支（复制引擎 + 端点）（CodeBuddy）
> 状态：已执行（任务书，2026-11-17）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


**给谁**：CodeBuddy（`--model hy4flash-free`）。
**仓库**：`<repo>`。**不要 git add / commit / push。**
**先读**：
- `docs/设计方案/2026-11-17-一人多会话（一主多副·插件）.md`（第 6 条：分支接 side）
- `docs/设计方案/2026-11-17-会话分叉（从某条回答另开一支）.md` §"复制的技术口径"
- `AGENTS.md`
**前提**：批1/批2 已落地并验收（side 会话、`createPartnerSideSession`、`ChatIndexEntry` 增量字段）。
**范围**：只做服务端复制引擎 + `POST /agent/chat/:id/branches` + 测试/探针 + 契约文档。
**不做**：UI 入口、来源行、列表标记（批3b）；不做"接替主线 / retired"（有 side 就不需要）。

**工作树提醒**：仓库里有别人未提交的改动。只做定点编辑；不整文件重写、不格式化、不动无关段落。
不要碰 `web/`（批3b）、手机端、`shared`（本批不需要改 shared 契约；`ChatOrigins` 是服务端 durable 文档）。

---

## 一、assistant 消息补可寻址 id（纯增量）

`ts/apps/server/src/agent/session-transcript.ts`：

- `TranscriptMessage.id` 的注释从"只给 user"改成"user 与 assistant 都给；带 `author` 的来信仍不给"。
- assistant 分支（`outgoing: TranscriptMessage = { role: "assistant", text, at }`）补：
  `outgoing.id = messageIdOf(externalId, Number(entry.id));`
  包括最后那个"只有步骤、正文为空"的兜底 assistant 也要给 id（客户端目前不用，但分支端点要能指到它；
  正文为空的 assistant 不能作为分叉点，见 §三）。
- `author` 与 `id` 互斥的规则不变（relay 来信不给 id）。

## 二、`ChatOrigins`（durable 文档）

`ts/apps/server/src/agent/shared.ts` 照 `ChatProjects` 的写法加：

```ts
/** 分支来源（2026-11-17 从回答分支）：对外会话 id → 来源快照，只用于展示与回跳。 */
export const ChatOrigins = defineDoc<{
  byExternal: Record<string, { source: string; sourceTitle?: string; at: number }>;
}>({
  kind: "lifediary.chat-origins",
  version: 1,
  scope: "session",
  initial: () => ({ byExternal: {} }),
  checkpointWhen: () => false,
});
```

- `source` = 来源会话的对外 id；`at` = 分支创建时间；**不参与历史解析**。
- 新库/旧库都靠 durable 的文档迁移，不需要 ALTER。

## 三、复制计划（纯函数，可单测）

新建 `ts/apps/server/src/agent/branch-copy.ts`：

```ts
export interface BranchPlan {
  entries: Array<Record<string, unknown>>; // 已处理：usage 清零 / 压缩 head 重映射后的条目
  count: number;
}

export type BranchPlanResult =
  | { ok: true; plan: BranchPlan }
  | { ok: false; reason: "not_assistant" | "empty" | "too_large"; message: string };

/** sourceEntries 是源会话从 1 到分叉点的全部条目（含 id），按原顺序。 */
export function planBranchCopy(
  sourceEntries: ReadonlyArray<{ id: number; kind: string; model?: any[]; data?: any }>,
  targetIndex: number, // 指向 pi.assistant 条目
): BranchPlanResult;
```

规则：

1. `targetIndex` 越界 / 不是 `pi.assistant` / 正文为空 → `not_assistant` / `empty`。
   正文判空用 `contentText(message.content).trim()`（`session-transcript.ts` 已导出）。
2. 复制 `0..targetIndex`（含）**全部条目**，不挑 kind（未知 kind 也照抄，保住上下文一致性）。
3. **usage 清零**：每条 `model[]` 里的消息，把 `usage` 换成全 0 同形对象
   （`input/output/cacheRead/cacheWrite/totalTokens/cost` 全 0），避免副本把账单翻倍。
   没有 `usage` 的不补。
4. **压缩条目 `pi.compaction` 的 `head` 重映射**：`head` 是源条目数字 id。
   - 先建立 `oldId → 新下标`（复制顺序）的映射；
   - `head` 命中映射 → 换成"新会话里该条目追加后拿到的 id"。
     **注意**：新 id 要等真正 `appendEntry` 时才知道，所以纯函数只能把 `head` 换成
     `{ __branchHeadIndex: n }` 这种占位，或者返回 `headIndex` 让调用方在追加后改写。
     选一种实现（推荐返回 `headIndex`，由调用方在 tx 里 `entry.data.head = 新id` 再 append）。
   - `head` 不在复制范围（理论上不会，因为从 1 开始复制）→ 丢掉这条 `pi.compaction`，
     并在返回里记录 `droppedCompaction: number`（写日志，不向客户端报错）。
5. **上限**：条目数 > 400 或 `JSON.stringify(entries).length` > 64 * 1024 * 1024 → `too_large`，
   文案「这条太长了，先压缩再复制」，不悄悄截断。
6. **不设 durable `parent`**（设了历史会两遍），也不用 `conversation.fork`。

单测 `ts/apps/server/src/branch-copy.test.ts`：

- user + assistant + tool-result + compaction 的合成序列，分叉点在 assistant：
  复制条数正确、usage 全 0、compaction headIndex 指向正确的复制下标。
- 分叉点不是 assistant / assistant 正文为空 → 对应 reason。
- 超过 400 条 → `too_large`。
- 未知 kind 原样复制。

## 四、端点 `POST /api/v1/agent/chat/:conversationId/branches`

`ts/apps/server/src/index.ts`，放在 `/edit` 附近：

body：`{ atMessageId: string, title?: string }`（title ≤80 字，可忽略先不写）。

流程：

1. `openChat(conversationId)` → 404 `unknown_conversation`。
2. `conversationIsBusy(chat.conversation)` → 409 `conversation_busy`（照 `forkForEdit` 的文案）。
3. `const view = await chat.conversation.context(CTX)`；扫描 `view.entries`，用
   `messageIdOf(chat.externalId, Number(entry.id)) === atMessageId` 定位（只认 assistant）；
   找不到 → 400 `branch_point_not_found`。
4. `planBranchCopy(view.entries, index)`：失败按 reason 返回 400（`branch_point_not_found` /
   `branch_point_empty` / `branch_too_large`）。
5. 目标会话：
   - **执事会话（链接 role = canonical / side）**：
     - `const partnerId = store.linkOfSession(chat.internalId)?.partnerId`；
     - `const dest = await createPartnerSideSession(partnerId)`（`partner-runtime-run-partner-turn.ts` 已导出；
       它负责新 side id、链接、身份对齐、钉工作目录）；
     - 在 `dest.conversation.commit(tx => ...)` 里逐条 append（compaction 的 head 用新 id 回填）；
     - 写 `ChatOrigins.byExternal[dest.externalId] = { source: chat.externalId, sourceTitle, at: Date.now() }`；
       `sourceTitle` 取源会话的 `chat-meta` 标题或首句（`readChatStats` / `chatTitles()` 任选，读不到就不带）。
   - **worker / chief**：
     - 用 `harness.createConversation` 手动建（照 `forkForEdit` 的 init 写法）：
       externalId = `crypto.randomUUID()`；
       `Chats.byExternal`、`ChatKinds.byInternal`（worker/chief）、
       worker 继承 `ChatProjects`、`configure(tx, id, { cwd: sourceAgent.cwd })`（读得到才写）、
       `ChatOrigins`、**以及在同一 init 事务里逐条 append 复制条目**（原子）。
     - `agent.model` = 源会话当前 model（含思考档后缀），不要回到默认。
6. 返回 `{ ok: true, conversationId: dest.externalId, entries: count }`。
7. **不改源会话**（只读它的 context）；不写 `ChatOrigins` 到源会话。

新增导入注意：
- `createPartnerSideSession` 从 `./partner-runtime-run-partner-turn.ts`；
- `ChatOrigins` 放 `./agent/shared.ts`；
- `messageIdOf` 从 `./agent/session-transcript.ts`；
- `conversationIsBusy` 从 `./agent/session-stream.ts`（`forkForEdit` 已用）。

## 五、探针（`scripts/http-probe.ts` 新增 §34）

用现有 faux 链路：

1. 建一条 worker 会话，发两轮（探针已有 chat 调用助手）；
2. 从第一轮的 assistant 消息取 `id`，`POST .../branches {atMessageId}`；
3. 断言：
   - 200，`conversationId` 是新 id；
   - `GET .../messages` 里只有第一轮 user + assistant（不含第二轮）；
   - 新会话 `chatKind=worker`、项目归属继承；
   - 源会话消息数不变。
4. 执事分支：
   - 用 §18 的执事/ §33 的 side 环境，从 canonical 的一条 assistant 分叉；
   - 断言返回的 id 含 `-side-`；`GET /partners/:id/sessions` 能看到它（role=side）。
5. 错误分支：不存在的 atMessageId → 400；会话忙 → 409（可用假上游闸，照现有探针写法，
   做不到就只测 400，并在交付说明里写"忙态未测"）。

## 六、文档

1. `docs/基线文档/接口-端点1-对话与兼容层.md`：
   - `GET /agent/chat/:id/messages` 的 `TranscriptMessage` 补一句"assistant 也有 id"；
   - 新增 `POST /agent/chat/:id/branches` 小节（请求/响应/错误码/复制口径）。
2. `docs/基线文档/系统架构.md`：D29 行补一句"分支 = 复制到同一人设的 side 会话"；
   或新增 D30（分支复制）——按现有决策表密度选一个，不要两处重复。
3. `docs/变更记录/2026-11-17-一人多会话批3a（分支复制引擎）.md`：改了什么 / 为什么 /
   验了什么 / 明确没做（UI、接替主线、画板）。

## 七、验证

```bash
cd <repo>/ts
pnpm typecheck
pnpm --filter @lifediary/server test
pnpm --filter @lifediary/server http   # 至少 §34 全绿；已知 tool-usage 那 1 红与本批无关
```

- 新增单测 + §34 必须全绿；既有 5 红照旧（arch-guard 3、auxiliary split、partner-work EPERM）。
- 交付说明写：改了哪些文件、复制口径的取舍、哪些没测（例如压缩条目的真实现场）。
- 不提交、不 push、不动别人的在途改动。
