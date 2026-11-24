<p align="center">
  <img src="ts/apps/server/web/crystal-mark.png" alt="Selenite" width="110">
</p>

# Selenite

**一个跑在自己机器上的通用 Agent。** 没有账号，没有云端服务——除了你自己配的模型接口，东西都留在这台电脑上。

随手说一句就能记日记、记流水账、记突然冒出来的想法；也能让它读文件、翻历史、跑命令，把一件多步的活从头干到尾。记东西是它用得最多的场景，但不是它的边界。

## 为什么是它

- **通用**：今天记一整天，明天整理文件夹、查资料、跑个命令，用的是同一个 Agent 和同一份记忆——不是某个 App 的后端插件。
- **个人**：一个用户、一台机器、一份数据。不做多租户，不做账号体系，不做计费。
- **自己的**：模型与供应商在界面里配，密钥走环境变量（`.env` 是主落点），界面直填的 key 落服务端热注入文件；两路都不入库、不下发客户端。记忆和会话存在本机 SQLite。

## 跑起来

需要 Node 20+ 和 pnpm。

```bash
cd ts
pnpm install
cd apps/server
cp .env.example .env
pnpm dev          # 打开 http://127.0.0.1:39847
```

什么都不配也能跑：默认走 mock 流，HTTP 链路是真的，只是模型回答是假的。想接真模型，在 `.env` 里填 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（任何 OpenAI 兼容端点都行）。`LLM_PROVIDER=faux` 是中间档——真会话落库、假模型，用来不花钱先把链路走通。

光用浏览器就是完整可用的。另有 Go 桌面壳在 `desktop/`；手机端是另一个未开源的原生 Android 工程，通过 HTTP + SSE 连过来。

## 能拿它做什么

- **随手记**：日记、流水账、一闪而过的念头——一句话记下，回头按时间翻。交互成本压到最低，否则没人愿意记。
- **真动手**：读写文件、改代码、跑命令；多步的活自己推进，不用你一步一步盯。
- **记得住**：记忆分几层——原样存、抽要点、定期巩固、用到时召回；按时间切而不是按项目切，因为记日子本来就是按时间的。
- **分身与群聊**：建几个不同性格的"执事"，各有各的记忆和职责；也能拉群让它们一起聊、互相递话。
- **派活**：把复杂的多步任务拆给外部 CLI（Claude Code / Codex / OpenCode 等）去干，回来再验收。
- **提醒与后台**：到点提醒；关掉界面任务也不停，跑完自动落库，回来能回读。

## 数据与信任

- **密钥**：只落环境变量或服务端热注入文件，不进 git、不进日志、不下发客户端；文档与示例里只有变量名。配对码和设备令牌只存 sha256。
- **权限**：工具闸门三档——只读 / 禁 shell / 按名单拉黑（`AGENT_TOOL_POLICY`、`AGENT_BLOCKED_TOOLS`），外加一条独立的"写操作要确认"（`AGENT_CONFIRM_WRITES`，默认关）。改完立即生效，不用重启。默认全放行，可信边界等于你愿意让自己的账号在这台机器上做什么。
- **身份与安全**：没有账号体系，对外 id 一律 uuid（猜不到就读不了别人的历史）；鉴权失败一律 403 空体。日志只记条数、字数、耗时和枚举，不记对话内容。

> 本地自用上面这些够了。真要接 IM 网关、暴露到局域网或跑无人值守任务之前，把权限那层升级成逐次人工确认，才算完整的闸门。

## 目录

```
ts/
├── packages/shared/     契约 + SSE 编解码（服务端和客户端共用同一份）
├── packages/memory/     记忆四层：存储 / 抽取 / 巩固 / 召回
├── packages/chancellor/ 派活执行器：拆单 / 派工 / 外雇 CLI / 验收
├── apps/server/         Hono + SSE，持有 LLM key，装配 Harness
└── apps/relay/          自建中继（哑路由 + 名册 + 扫码加入）

desktop/                 Go 桌面壳，基于 mygo
docs/                    基线文档 / 设计方案 / 变更记录
```

依赖方向单向：`shared` ← `memory` ← `server`。

## 用的东西

都是现成的开源件，本仓不 vendor 内核：

| 件 | 干什么 |
|---|---|
| [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)（MIT，锁 1.4.0） | 会话内核：存储、崩溃恢复、压缩、定时任务、权限钩子 |
| [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) | 统一 LLM API（模型发现 + 供应商配置） |
| [chord](https://www.npmjs.com/package/@earendil-works/chord) | 跨进程对象运行时（chancellor 用） |
| [Hono](https://hono.dev/) | HTTP + SSE |
| [mygo](https://github.com/egoist/mygo) | Go 桌面壳框架 |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | chancellor 的 MCP 工具通道 |

外雇工人可以是现成的 CLI：Claude Code、Codex、OpenCode、Qoder、CodeBuddy、豆包 等（在 `ts/packages/chancellor/src/employee/`）。

## 文档

- `docs/基线文档/接口文档.md` —— 现行契约：请求 / 事件 schema、SSE 编解码、环境变量表、工具清单。
- `docs/基线文档/系统架构.md` —— 模块边界、关键决策、已知边界与"刻意没有的"。
- `docs/设计方案/` —— 当时为什么这么设计；落地后结论下沉到上面两篇，方案本身保留不删。
- `docs/变更记录/` —— 改了什么、为什么。

文档里偶尔会看到 `<repo>` / `<chancellor>` / `<主工作区>` 这类尖括号占位符，是开源时替换掉的本机路径：`<repo>` = 本仓根，`<chancellor>` = `ts/packages/chancellor`（已 vendor 进本仓），`<主工作区>` = 用户自选的工作区根目录。

## 现在到哪了

SSE 流式对话、pi-durable 会话落库与崩溃恢复、关掉界面后后台任务继续跑、上下文压缩、四层记忆、权限闸门，以及执事 / 群组 / 定时提醒——这些主链路都通了，mock / faux / 真模型三条路都验过。

记忆的"质量"（抽取、巩固、召回得准不准）是刻意留白的地方，不是做完了。完整工具清单以 `docs/基线文档/接口文档.md` §4 为准。

## 参考过

[dsh-synapse](https://github.com/Tourweint/dsh-synapse)（会话画板）、[cindy](https://github.com/makecindy/cindy)（中继与设置页）、ZCode（工具执行流与错误卡）、[magpie](https://github.com/yetone/magpie)（供应商图标）、[agent-desktop](https://github.com/lobehub/agent-desktop)（电脑操作技能手册）……借的是交互和思路，代码是自己的。更多调研在 `docs/调研/`。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
