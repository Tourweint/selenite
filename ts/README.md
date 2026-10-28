# lifediary-ts

**一个人的通用 Agent 的服务端。** 手机端是独立的原生 Android 工程
（`<lifediary 手机仓>`），通过 HTTP + SSE 连到这里；
模型、记忆、会话、密钥全在这台机器上。

记录是它最常用的场景，但定位是通用的 —— 同一个 Agent 也会读文件、翻历史、
按指令动手。区别只在工具集，不在内核。

## 为什么是 TypeScript

1. **契约只有一份**：`packages/shared` 同时被服务端和调用方 import，字段增删时对面编译期报错。
2. **内核现成**：pi 是 TS 写的，会话循环、压缩、多 provider 都能直接复用（见 `vendor/pi/README.md`）。

性能不是理由 —— JVM 跑编排不是瓶颈，上游首 token 就要 1~2 秒。

## 结构

```
ts/
├── packages/shared/     契约 + SSE 编解码（单文件，两端共用）
├── packages/memory/     记忆四层：存储 / 抽取 / 巩固 / 召回 + 引擎装配
├── apps/server/         Hono + SSE，持有 LLM key
├── vendor/pi/ai/        vendored pi-ai —— 统一多 provider LLM API
├── vendor/pi/agent/     vendored pi-agent-core —— Agent 循环 / 会话 / 压缩
└── docs/                memory-framework.md
```

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
| 配了 | 走 pi 的 `AgentHarness`，OpenAI 兼容端点，换 provider 只改 env |

```bash
cp apps/server/.env.example apps/server/.env
```

## 验证

```bash
pnpm typecheck    # 全部包一次过（含 vendored pi）
pnpm probe        # 内核可用：Agent 循环 + 事件桥接 + 压缩阈值（无需 key）
pnpm memtest      # 记忆四层串跑：抽取→巩固→召回→注入
pnpm smoke        # 端到端 SSE（需先 pnpm dev）
```

## 当前边界

- **没有鉴权**：`/api/v1/agent/chat` 谁都能打；CORS 全开是为了真机调试。
  **暴露到局域网或公网前必须补** —— 否则拿到 `conversationId` 就能读别人的历史。
- **会话落盘**：历史存在 `.data/sessions/*.jsonl`，重启可恢复。
- **压缩只有阈值触发**：overflow 兜底（超窗报错 → 压缩 → 重试）还没做。
- **没有工具**：这是有意的，见根 README「工具与信任」——先有闸门再给能力。
- **记忆只有框架**：四层流水线通了，但抽取是规则版、巩固只做去重、召回是加权打分。
- **日志不含对话内容**：只记条数 / 字数 / 耗时。

## 下一步

1. 会话管理：列出 / 重命名 / 删除（照 `coding-agent` 的 `session-manager`）
2. 工具层：注册 + 权限闸门，先只给只读工具
3. 记忆的召回质量：FTS5 + 中文分词（现在是 `LIKE`，中文近乎失效）
