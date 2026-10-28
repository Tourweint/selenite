# lifediary-harness

Lifediary 的 **Agent 服务端**：模型、记忆、密钥都在自己手里。

手机端是独立仓库的原生 Android 工程（Kotlin + Compose），通过 HTTP + SSE 连到这里。

## 结构

```
ts/
├── packages/shared/     契约 + SSE 编解码（服务端与客户端共用）
├── apps/server/         Hono + SSE，持有 LLM key，跑 Agent
├── vendor/pi/           内嵌的 pi 内核（ai + agent-core，MIT）
└── README.md            ← 从这里开始
```

## 状态

| 能力 | 状态 |
|---|---|
| SSE 流式对话 | ✅ 已通（mock / 真实模型两条路都验证过） |
| pi 内核接入 | ✅ vendored，`probe` 用假模型验证过真实事件流 |
| 记忆 / 会话落库 | ❌ 未做（最终落在服务端） |
| 工具调用 | ❌ 未做 |
| 鉴权 | ❌ 未做，**上公网前必须补** |

## 已退役

- **Java / Spring 实现**：2026-10-28 移除，代码在 git 历史里。
- **Expo 客户端**：2026-10-28 移除，已有成熟的原生 Android App，不再维护第二套客户端。

`docs/` 下是 Java 版归档文档，**不再维护**，其中「无状态、不建库」等约束随实现一并作废。
