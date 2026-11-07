# lifediary-harness

**一个人的通用 Agent。** 跑在自己机器上：模型、记忆、会话、密钥都不外流。

记录（日记、流水账、随手的想法）是它用得最多的场景，但**不是它的边界** ——
同一个 Agent 也能读文件、翻历史、按你的要求动手把事情做完。

手机端是独立仓库的原生 Android 工程（Kotlin + Compose），通过 HTTP + SSE 连过来。

## 定位

| | |
|---|---|
| **通用**，不是某个 App 的后端插件 | 今天记一整天，明天整理文件夹、查资料、跑个命令，用的是同一个 Agent 和同一份记忆 |
| **个人**，不是平台 | 一个用户、一台机器、一份数据。不做多租户、不做账号体系、不做计费 |
| **自有** | 记忆、会话、密钥全在本机；模型与供应商在界面里配，密钥仍只走环境变量 |

「记录」是重点方向，因为它决定了三件事，而这三件事对通用 Agent 同样成立：

- 记忆要按**时间**切分（不是按项目）
- 工具要能**写**（只读的 Agent 记不下东西）
- 交互成本要**极低**（随手一句就能记，否则没人用）

## 结构

```
ts/
├── packages/shared/     契约 + SSE 编解码（服务端与客户端共用）
├── packages/memory/     记忆四层：存储 / 抽取 / 巩固 / 召回
├── apps/server/         Hono + SSE，持有 LLM key，装配 Harness
└── README.md            ← 从这里开始
```

内核是 npm 上的 **pi-durable**（MIT，锁 1.4.0，不 vendored）。
2026-10-28 从 pi-agent-core 0.78.1 换过来 —— 那条线上游已经删了，
新家把会话存储、崩溃恢复、压缩、定时任务、权限钩子都包了。

## 状态

| 能力 | 状态 |
|---|---|
| SSE 流式对话 | ✅ 已通（mock / faux / 真实模型三条路都验证过） |
| Agent 内核 | ✅ pi-durable，会话落 SQLite，崩溃后可恢复 |
| 后台执行 | ✅ 客户端关掉界面不中止任务，跑完自动落库，可回读 |
| 失控保护 | ✅ 工具回合上限 100（`AGENT_MAX_TURNS`），撞上限给提示并硬停 |
| 上下文压缩 | ✅ 阈值 + overflow 兜底，策略用默认 |
| 记忆框架 | ✅ 四层通了；策略（抽取/巩固/召回质量）刻意留空 |
| 工具调用 | ✅ 10 个（读/写/改/跑 + 记住/回忆/提醒 + `skill` + `delegate` / `propose_project`；另有条件注册的 5 个，清单见接口文档 §4） |
| 定时提醒 | ✅ `sleepUntil`，睡眠状态落库，重启不丢 |
| 权限闸门 | ✅ 三档（`read-only` / `no-shell` / 黑名单 `AGENT_BLOCKED_TOOLS`）＋ 独立确认轴 `AGENT_CONFIRM_WRITES`（默认关，2026-11-04 批次二） |
| 鉴权 | ✅ 共享令牌 ＋ 配对设备凭据（2026-11-04）＋ 本机页面 cookie（2026-11-03）；仍**不带用户身份**（D1） |
| 执事 | ✅（2026-11-05 批次B） |
| 群组 | ✅（2026-11-06，`GROUPS_ENABLED`） |
| 长期课题跟进 | ✅（2026-11-07） |

## 工具与信任

已注册工具 15 个（10 个基线 + 5 个条件注册，现行清单以接口文档 §4 为准）：

| 工具 | 能力 | 风险 |
|---|---|---|
| `read` | 读文件（带输出分页） | 只读 |
| `write` | 写文件 | **不可撤销** |
| `edit` | 按片段替换改写 | **不可撤销** |
| `bash` | 执行 shell 命令 | **等价于你的账号权限** |
| `remember` | 写一条长期记忆 | 可撤回（删库记录） |
| `recall` | 检索旧记忆 | 只读 |
| `set_reminder` | 定一个到点提醒 | 可取消 |
| `skill` | 按需取一份技能手册正文 | 只读 |
| `delegate` | 把多步的活派给外部 worker | **不可撤销**（起 worker 写文件 / 跑命令） |
| `propose_project` | 提交新建项目待确认请求 | 只写 proposal 行，不建目录 |
| `partner_skill_write` | 写当前执事的技能库（写盘即生效） | **不可撤销**（写盘） |
| `partner_manage` | 总管建 / 停 / 列执事 | **不可撤销**（改角色与领域目录） |
| `group_manage` | 总管建群 / 列群 | 新建常驻多成员会话 |
| `web_search` | 查公开网络资料 | 只读（纯网络读） |
| `propose_topic` | 提议长期跟进一个课题 | 只写内部提议（语义同 `remember`） |

注册条件：`read` / `write` / `edit` / `bash` 来自 pi 自带的 `CodingTools`；`skill` 需技能目录
（`AGENT_SKILLS_DIR`）非空；`CHANCELLOR_ENABLED=false` 时 `delegate` / `propose_project` 都不上（回到 8 个）；
`COMPANIONS_ENABLED=false` 时 `partner_skill_write` / `partner_manage` 都不上；`group_manage` 另需
`GROUPS_ENABLED`（双闸，任一关即不上）；`TOPICS_ENABLED=false` 或课题存储 / 搜索适配层缺失时
`web_search` / `propose_topic` 都不上。后五个是条件注册，不计入 10 个基线。

**闸门只是骨架。** pi 自己不带权限系统，只在 `beforeTool` 留了一个钩子；
我们在 `apps/server/src/agent.ts` 里挂了一层：

- `AGENT_TOOL_POLICY=read-only`：拦住写文件 / 改文件 / 跑命令
- `AGENT_BLOCKED_TOOLS=bash,powershell`：拉黑具体工具

默认仍是全放行，等价于 pi 的默认行为 —— 可信边界等于
**你愿意让自己的账号在这台机器上做什么**。
本地自用没问题；接 IM 网关、暴露到局域网、或者让它跑无人值守任务之前，
这层要升级成"逐次等人确认"，那才算真的闸门。
2026-11-07 复核：现行已不止骨架——访问档三档（`read-only` / `no-shell` / 黑名单 `AGENT_BLOCKED_TOOLS`）＋ 独立确认轴 `AGENT_CONFIRM_WRITES`（默认关，2026-11-04 批次二）已落地，界面改完立刻生效、不用重启。

## 已退役

- **Java / Spring 实现**：2026-10-28 移除，代码在 git 历史里。
- **Expo 客户端**：2026-10-28 移除，已有成熟的原生 Android App，不再维护第二套客户端。
- **vendored `pi-agent-core@0.78.1`**：2026-10-28 移除，改用 npm 上的 `pi-durable@1.4.0`。
  上游 1.0.0 把 `AgentHarness` / `JsonlSessionRepo` 整体删了，vendored 的那份已经跑不通。

`docs/基线文档/` 已于 **2026-10-29 按 TS 实现重写**（`接口文档.md` 是现行契约、`系统架构.md` 是现行架构）；
`docs/变更记录/` 里 2026-10-25 ~ 27 的三篇是 Java 版迁移期记录，其中的「无状态 / JWT 同 backend / 先扣额 / signal 四问」口径**均已作废**，仅作历史。
