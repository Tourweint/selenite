# lifediary-harness

Lifediary 的 **AI 编排者**（2026-10-25 拆分，见 backend 仓库
`docs/设计方案/2026-10-25-Lifediary-Harness拆分方案.md`）：
信号评估、prompt 组装、提问策略、收尾决策都长在这里；上游 LLM key 与 Jev 出口代理也在这里。

职责边界一句话：**backend 管"是谁、有没有钱、数据存哪"，harness 管"AI 怎么说、什么时候说"。**

## 硬边界（写死在架构里的铁律）

- **无状态（D3）**：对话上下文由 App 每轮带来，即用即丢。不建库、不建用户表、不写任何镜像表、不做任何持久化；
- **不写正文日志（D3）**：日志只记行数/字数/耗时/枚举结果/configVersion，绝不含消息内容；
- **不碰 backend 的库（D6）**：账号与配置经 backend 内部接口取（`X-Internal-Token`，仅内网）；
- **鉴权同源（D2）**：与 backend 共用同一把 HS256 JWT 签名密钥（`JWT_SECRET`），不另造账号体系；
  密钥未配置/过短 = 一切请求 403（fail-closed）；
- **自带频控（D4/§8）**：按来源 IP 的频次 + 并发闸门，不因为"打的是 AI 通道"就免闸；
- **密钥只走环境变量**：上游 key 与出口代理绝不入库、绝不进 ai-config 下发。

## 当前状态（P2，2026-10-27）

| 端点 | 状态 |
|---|---|
| `POST /api/v1/signal/session` | ✅ P1 已迁入（契约与 backend 逐字一致） |
| `POST /api/v1/llm/chat/completions` | ✅ P2 已迁入（先扣再转发 + SSE 透传） |
| `POST /api/v1/agent/chat` | P3 新增（未实现） |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8081 | 监听端口 |
| `JWT_SECRET` | —（必配） | 与 backend 同源的 HS256 签名密钥（≥32 字节）；**未配置 = 全 403** |
| `SIGNAL_JEV_ENABLED` | true | 信号评估总开关；false 时端点返回 `available=false` |
| `TYPESAFE_API_KEY` | — | TypeSafe Jev key；**未配置 = `available=false`（不报错）** |
| `TYPESAFE_URL` | `https://api.typesafe.ai/v1/systemone` | Jev 端点 |
| `TYPESAFE_MODEL` | `jev-latest` | Jev 模型 |
| `TYPESAFE_PROXY` | 空（直连） | Xray 出口代理（451 区域封锁解法）：`socks5://127.0.0.1:10808` 或 `http://host:port` |
| `BACKEND_INTERNAL_URL` | `http://127.0.0.1:8080` | backend 内部接口基址（同机/同 VPC） |
| `INTERNAL_TOKEN` | — | backend 的 `X-Internal-Token` 同值；拉取 ai-config 与扣额用 |
| `LLM_BASE_URL` | 百炼兼容端点 | 上游 OpenAI 兼容端点（P2 起由 harness 持有） |
| `LLM_API_KEY` | — | 上游 key；**只走环境变量**，绝不入库/绝不下发 |
| `LLM_MODEL` | 空（原样透传） | 非空时转发前覆盖请求体 model 字段（调优归服务端） |
| `RATE_LIMIT_ENABLED` | true | 频控总开关 |
| `RATE_LIMIT_SIGNAL_PER_MINUTE` | 30 | 信号评估按 IP 每分钟上限 |
| `RATE_LIMIT_MAX_CONCURRENT` | 4 | 同 IP 并发上限 |

## 配置拉取（D5/D7）

启动后从 backend `GET /api/v1/internal/ai-config?since=<version>` 增量拉取 `ai.*` 策略参数：
60s 缓存；失败**沿用上次成功值**；从未成功过用内置默认（P1 为空表）。
每次上游调用的日志都带 `configVersion`（审计闭环：后台能回答"当时生效的是什么值"）。
`ai.*` 键**永不含密钥**——key 与代理只走环境变量。

## 运行

```bash
mvn spring-boot:run          # 或 mvn package && java -jar target/lifediary-harness-0.1.0.jar
mvn test                     # 18 个测试
```

部署要求（拆分方案 §9）：与 backend **同机或同 VPC**（内部接口延迟是 D1 的前提）；
内部接口只走内网；`JWT_SECRET` 两端同源注入、换密钥必须同时换。

## 相关文档

- `docs/基线文档/接口文档.md` —— 对外契约（与 backend 接口文档 §7 同源）
- `docs/基线文档/系统架构.md` —— harness 视角的架构与决策
- `docs/变更记录/` —— 变更只新增、不修改
- backend 仓库 `docs/设计方案/2026-10-25-Lifediary-Harness拆分方案.md` —— 总方案（D1~D8）
