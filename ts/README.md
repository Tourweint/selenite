# lifediary-ts

Lifediary 的 **Agent 服务端**。手机端是独立的原生 Android 工程（`<lifediary 手机仓>`），
它通过 HTTP + SSE 连到这里；模型、记忆、密钥都在这台机器上。

选 TS 不是为了性能 —— JVM 跑编排不是瓶颈。理由有两条：

1. **契约只有一份**。`packages/shared` 同时被服务端和调用方 import，字段增删时对面编译期报错。
2. **AI 生态在 TS 这边**，而且 pi 本身就是 TS 写的，可以直接复用它的内核。

## 结构

```
ts/
├── packages/shared/     契约 + SSE 编解码（单文件，两端共用）
├── packages/memory/     记忆：存储 / 抽取 / 巩固 / 召回 四层 + 引擎装配
├── apps/server/         Hono + SSE，持有 LLM key，跑 Agent
├── vendor/pi/ai/        vendored pi-ai —— 统一多 provider LLM API
├── vendor/pi/agent/     vendored pi-agent-core —— Agent 循环 / 压缩 / 会话
└── docs/                memory-framework.md（记忆的分层与边界）
```

`vendor/` 是复制进来的 pi 源码（MIT），不是 `npm i` 装的。原因、改动范围、升级方式见
[`vendor/pi/README.md`](vendor/pi/README.md)。记忆为什么这样分层，见
[`docs/memory-framework.md`](docs/memory-framework.md)。

## 跑起来

```bash
cd ts
pnpm install
pnpm dev        # 服务端 :8082，调试页在 http://127.0.0.1:8082/
```

### 配不配 key 都能跑

| 情况 | 行为 |
|---|---|
| 没配 `LLM_API_KEY` | 走 mock 流，逐字回显 —— 验证链路够用 |
| 配了 | 走 pi-ai，OpenAI 兼容端点，换 provider 只改 env |

```bash
cp apps/server/.env.example apps/server/.env
```

## 验证

```bash
pnpm typecheck    # 全部包一次过（含 vendored pi）
pnpm probe        # pi 内核能用（无需 key，用假模型跑真实事件流）
pnpm memtest      # 记忆四层串跑：抽取→巩固→召回→注入
pnpm smoke        # 端到端 SSE（需先 pnpm dev）
```

## 当前边界

- **没有鉴权**：`/api/v1/agent/chat` 谁都能打；CORS 全开是为了真机调试。**上公网前必须补。**
- **会话落盘**：走 pi 的 `AgentHarness` + `JsonlSessionRepo`，历史存在 `.data/sessions/*.jsonl`，
  重启可恢复。没有鉴权意味着任何人拿到 conversationId 就能续上别人的会话。
- **压缩有入口没触发**：`harness.compact()` 能用，但还没加"什么时候该压"的判断。
- **记忆只有框架**：四层流水线通了，但抽取是规则版、巩固只做去重、召回是加权打分。
  策略部分刻意留空，见 `docs/memory-framework.md` 的 TODO。
- **日志不含对话内容**：只记条数 / 字数 / 耗时。

## 下一步

1. 会话按天收敛（`day:<date>` 作用域）—— 日记场景的核心；
2. 抽取换成 LLM 提炼，区分 fact / entity / preference；
3. 裁掉用不上的 provider（pi-ai 现在装齐了 60+ 家，只留 OpenAI 兼容即可）。
