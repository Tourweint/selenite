# lifediary-ts

**一个人的通用 Agent 的服务端。** 手机端是独立的原生 Android 工程
（`<lifediary 手机仓>`），通过 HTTP + SSE 连到这里；
模型、记忆、会话、密钥全在这台机器上。

记录是它最常用的场景，但定位是通用的 —— 同一个 Agent 也会读文件、翻历史、
按指令动手。区别只在工具集，不在内核。

## 为什么是 TypeScript

1. **契约只有一份**：`packages/shared` 同时被服务端和调用方 import，字段增删时对面编译期报错。
2. **内核现成**：pi 是 TS 写的，`pi-durable` 把会话、任务、压缩、崩溃恢复都做好了。

性能不是理由 —— JVM 跑编排不是瓶颈，上游首 token 就要 1~2 秒。

## 内核：pi-durable

2026-10-28 从 vendored 的 `pi-agent-core@0.78.1` 换到 npm 上的 **`pi-durable@1.4.0`**。

不是升级，是换基座：`AgentHarness` / `JsonlSessionRepo` / `NodeExecutionEnv`
在 pi 1.0.0 被整体删掉，搬去了 `pi-durable`。旧的 vendored 代码已经删了，
`@earendil-works/*` 现在是普通 npm 依赖（锁版本，不跟 main）。

换完拿到的是这些**不用再自己写**的东西：

| 能力 | 以前 | 现在 |
|---|---|---|
| 会话存储 | 自己维护 jsonl | SQLite（`node:sqlite`，零三方 DB 依赖） |
| 崩溃恢复 | 无 | 每个任务原子提交，重开进程接着跑 |
| 流式出口 | 订阅事件流自己桥 | `watch()` 拿已提交状态，断线重连不丢 |
| 客户端重试 | 会重复扣 token | `requestId` 幂等 |
| 压缩 | 抄来的阈值判断，overflow 没做 | 阈值 + overflow 兜底 + 后台预压 |
| 定时任务 | 无 | `sleepUntil()`，睡眠状态落库 |
| 权限闸门 | 无 | `beforeTool` 钩子 |
| 用量 | 无 | `harness.usage()`，按模型/工具累计 |

代价说清楚：`pi-durable` 标着 **Experimental**，1.4.0 的 `[Unreleased]` 里还挂着
几条 breaking change。所以**锁版本、不跟 main**；真跳版本时改动面也就
`src/agent.ts` 一个文件（外加工具签名）。

## 结构

```
ts/
├── packages/shared/     契约 + SSE 编解码（单文件，两端共用）
├── packages/memory/     记忆四层：存储 / 抽取 / 巩固 / 召回 + 引擎装配
├── apps/server/         Hono + SSE，持有 LLM key，装配 Harness
│   ├── src/agent.ts     ★ 从这里看：Harness / 会话 / 流 / 提醒
│   ├── src/provider.ts  模型接入（百炼 OpenAI 兼容 / faux）
│   ├── src/tools.ts     remember / recall / set_reminder
│   └── src/reminder.ts  定时提醒任务（sleepUntil）
└── docs/                memory-framework.md
```

## 端点

| 端点 | 用途 |
|---|---|
| `POST /api/v1/agent/chat` | 自有协议：SSE 事件 + 服务端下发 `conversationId` |
| `POST /api/v1/llm/chat/completions` | **OpenAI 兼容**，给现有手机 App 用（零改动接入） |
| `GET /api/v1/agent/usage` | 按模型累计的 token |
| `GET/POST /api/v1/agent/reminders` | 待触发的提醒 / 直接加一个提醒 |
| `GET /healthz` | 健康检查（含当前是 mock 还是真实上游） |

兼容端点内部走的还是 agent 路径（记忆、工具都在），不是无状态透传。
会话 id 从请求内容推导：同一段对话首条用户消息相同 → 映射到同一个会话；
要精确控制可以带 `X-Conversation-Id` 头。

## 跑起来

```bash
cd ts
pnpm install
pnpm dev        # 服务端 :8082，调试页在 http://127.0.0.1:8082/
```

### 配不配 key 都能跑

| 情况 | 行为 |
|---|---|
| 没配 `LLM_API_KEY` | 走 mock 流，逐字回显 —— 只验证 SSE 通路 |
| `LLM_PROVIDER=faux` | **走真实 durable 链路**，只是模型换成一撮假回答（不花钱） |
| 配了 | 真实上游；换模型只改 `LLM_MODEL` / `LLM_BASE_URL` |

```bash
cp apps/server/.env.example apps/server/.env
```

## 验证

```bash
pnpm typecheck    # 全部包一次过
pnpm probe        # 内核语义：提交 / 流式 / 闸门 / 睡眠 / 重启续跑（faux，无需 key）
pnpm --filter @lifediary/server http   # 端到端：真起服务，走 HTTP 验全部接口
pnpm memtest      # 记忆四层串跑：抽取→巩固→召回→注入
pnpm smoke        # 端到端 SSE（需先 pnpm dev）
```

## 工具

`CodingTools`（pi 自带：`read` / `write` / `edit` / `bash`，走执行环境、带输出分页）
\+ 自己的三个：

| 工具 | 说明 |
|---|---|
| `remember` | 写一条长期记忆 |
| `recall` | 检索旧记忆 |
| `set_reminder` | 定一个到点提醒，落库，重启不丢 |

**闸门有了，但只是骨架**，在 `src/agent.ts` 的 `beforeTool` 钩子里：

- `AGENT_TOOL_POLICY=read-only` → 拦住 `write` / `edit` / `bash` / `powershell`
- `AGENT_BLOCKED_TOOLS=bash,powershell` → 拉黑具体工具

默认仍是 `full`（等于 pi 的默认行为：以当前用户权限运行）。要做"每次动手前问一句"
那种审批，得把钩子改成异步等待外部确认 —— 那是下一步，不是现在。

## 当前边界

- **鉴权就一套共享令牌**：`AGENT_TOKEN`，失败 403 空响应体；不配则只放行本机回环。
  **不做用户隔离** —— 单用户自用；多用户是另一套系统，见 `docs/auth.md`。
- **对外 id 仍是 uuid**：durable 内部是自增整数，猜得到，所以外面套了一层映射，
  编造的 id 照样 404。映射存在 session 文档 `lifediary.chats` 里。
- **会话落盘**：`.data/agent.sqlite`（可用 `AGENT_DB_PATH` 改）。
- **压缩**：默认策略（阈值 + overflow 兜底）够用，没有按模型调预算。
- **记忆只有框架**：四层流水线通了，但抽取是规则版、巩固只做去重、召回是加权打分。
- **日志不含对话内容**：只记条数 / 字数 / 耗时。

## 下一步

1. 会话管理：列出 / 重命名 / 删除（durable 有 `entries()` 分页和 `fork()`，底子是够的）
2. 记忆的召回质量：FTS5 + 中文分词（现在是 `LIKE`，中文近乎失效）
3. 闸门升级：危险工具改成"等确认"，配合手机端推送
