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

## 端点

| 端点 | 用途 |
|---|---|
| `POST /api/v1/agent/chat` | 自有协议：SSE 事件 + 服务端下发 `conversationId` |
| `POST /api/v1/llm/chat/completions` | **OpenAI 兼容**，给现有手机 App 用（零改动接入） |
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
| 没配 `LLM_API_KEY` | 走 mock 流，逐字回显 —— 验证链路够用 |
| 配了 | 走 pi 的 `AgentHarness`，OpenAI 兼容端点，换 provider 只改 env |

```bash
cp apps/server/.env.example apps/server/.env
```

## 验证

```bash
pnpm typecheck    # 全部包一次过（含 vendored pi）
pnpm probe        # 内核可用：Agent 循环 + 事件桥接 + 压缩阈值（无需 key）
pnpm tools-probe  # 工具链路：模型调用 → 执行 → 结果回灌（无需 key）
pnpm memtest      # 记忆四层串跑：抽取→巩固→召回→注入
pnpm smoke        # 端到端 SSE（需先 pnpm dev）
```

## 工具

`apps/server/src/tools.ts`，6 个：`read_file` / `list_dir` / `write_file` /
`run_command` / `remember` / `recall`。

接口照 pi 的 `AgentTool`，但**实现是自己的** —— pi 那套 `coding-agent/core/tools/`
和 TUI 深度耦合（连主题和按键提示都 import 了），搬不过来。

**没有权限闸门**，和 pi 一致：以当前用户权限运行。风险见根 README「工具与信任」。

## 当前边界

- **鉴权是第一档**：一个共享令牌 `AGENT_TOKEN`，失败 403 空响应体；不配则只放行本机回环。
  够个人自用，不够多设备/多用户 —— 第二档（JWT）见 `docs/auth.md`。
- **会话 id 由服务端下发**：不带 = 新建（UUID 通过 `start` 事件返回），编造的 id 会 404。
  但会话**还没记 owner** —— 多用户时要加，见 `docs/auth.md` 的「会话归属」。
- **会话落盘**：历史存在 `.data/sessions/*.jsonl`，重启可恢复。
- **压缩只有阈值触发**：overflow 兜底（超窗报错 → 压缩 → 重试）还没做。
- **记忆只有框架**：四层流水线通了，但抽取是规则版、巩固只做去重、召回是加权打分。
- **日志不含对话内容**：只记条数 / 字数 / 耗时。

## 下一步

1. 会话管理：列出 / 重命名 / 删除（照 `coding-agent` 的 `session-manager`）
2. 记忆的召回质量：FTS5 + 中文分词（现在是 `LIKE`，中文近乎失效）
3. 工具自检：`run_command` 的输出裁剪、`write_file` 的 diff 展示
