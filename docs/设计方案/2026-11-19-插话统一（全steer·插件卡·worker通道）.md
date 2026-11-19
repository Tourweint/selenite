# 插话统一：忙时消息全走 steer（2026-11-19）

**状态**：设计已拍板（用户 2026-11-19 口头拍板：全改插话、followUp 进插件卡、多条件生效、加标记、worker 可被人和任何 agent 插话）。
**下沉落点**：落地后「会话输入时机语义」→ `接口文档.md` 端点2（chat）与 `系统架构.md` 主动性段。

## 背景与拍板

现状：忙时普通 Enter = `followUp`（排队到本轮收尾开下一轮），Ctrl/⌘+Enter = `steer`（插进当前轮）。
用户拍板：**默认全部插话**；followUp 想保留就放进插件卡让人自己调；多条插话都要生效；插话要带标记；worker 打手必须能被插话（被人和被任何 agent），"做歪了要有插话功能"。

## 现状（2026-11-18 代码级核实）

| 事实 | 位置 |
|---|---|
| 缺省 `DEFAULT_USER_INPUT_WHEN_BUSY = "followUp"` | `ts/apps/server/src/agent/user-input.ts:13` |
| chat 入口透传 `request.whenBusy`，不传 = followUp | `ts/apps/server/src/index.ts:1505-1516` |
| 忙时 Enter=followUp、Ctrl/⌘+Enter=steerIntoTurn | `ts/apps/server/web/composer-send.js:64-126`、`web/plus-menu.js:386-397` |
| steer 诚实回执 `notice.steer="inserted"/"new-turn"` | `ts/apps/server/src/agent/session-stream.ts:378-389` |
| 内核 `steeringMode` 可配 `"all"`，应用未设（吃缺省 one-at-a-time） | pi-durable `types.d.ts:495/533`；`src/reliability.ts:14` |
| native worker 是独立 pi-durable 子进程（stdin/stdout 通信），无外部消息注入口 | `ts/packages/chancellor/src/employee/native.ts:69-80`、`worker-main.ts` |
| 外部 CLI（claude/codex/qoder）非交互锁死全放行，无 inbox | `executor-config.ts:95` |

ZCode 参考（`D:\Projects\reference\ZCode/docs/conversation-product-protocol.md`）三条原则照抄：
1. **不可引导时优雅回退**：引导条件不满足自动回退排队，绝不报错丢消息；
2. **引导消息有状态生命周期**，人看得见（提交→确认注入/回退）；
3. **引导消息在对话流有投影**（带标记，与普通消息可区分）。

## 方案

### 1. 人的消息忙时默认 steer
- `DEFAULT_USER_INPUT_WHEN_BUSY` 翻为 `"steer"`；`user-input.ts` 头注释同步改口径（产品承诺从"排队到收尾"改为"插进当前轮，收不到边界就排队"）。
- composer 忙时 Enter 直接 `whenBusy="steer"`；Ctrl/⌘+Enter 保留不删（同义快捷键）。

### 2. followUp 降级为插件卡选项
- 插件中心（`plugins.json` + 插件页）加一项"忙时消息怎么投"：`插话（默认）/ 排队` 两档。
- 前端 composer 发消息时读这档决定 `whenBusy`；服务端缺省 steer，不依赖前端传值。

### 3. 多条插话全生效
- 会话装配设内核 `steeringMode: "all"`（`reliability.ts` 统一装配处）。
- 回滚 env：`AGENT_STEERING_MODE`（未设 = all）。

### 4. 插话标记
- steer 提交文本第一行加 `[插话]` 标记（模型知道这是半路引导；历史/回放可见；UI 检测该前缀渲染成"插话"徽标）。
- 明确不做内核元数据改造——标记进消息文本，durable 重放天然存活。

### 5. 不可插话时优雅回退
- steer 提交永远被内核 inbox 收下（无拒绝路径），应用层把"本轮已结束才被消费"的情况如实回执（沿用 inserted/new-turn 诚实回执），不新增状态机。

### 6. worker 插话通道
- **native worker**：`worker-main.ts` stdin 加一行 JSON 消息通道 `{type:"message", mode:"steer"|"followUp", text}` → `conversation.submit`；`native.ts` 宿主侧封装转发。
- **端点**：`POST /agent/delegations/:ticketId/message`（mode 默认 steer）。
- **人**：任务中心打手手风琴加"插话"输入（走上述端点）。
- **agent**：扩展 `send_to_agent` 工具加 `mode` 参数（steer 默认）——工具描述变更进 `docs/变更记录/`（缓存前缀资产）。
- 谁能插：沿用任务专线发言权判断；插话内容经该通道进 worker 上下文。
- **外部 CLI 明确不做**（stdin 无 inbox），边界如实写。

## 回滚

- `AGENT_STEER_DEFAULT=false` → 缺省回 followUp；
- `AGENT_STEERING_MODE=one-at-a-time` → 回单条；
- `WORKER_STEER_ENABLED=false` → worker 通道下架（工具不注册、端点 400）。

## 验收

1. `pnpm typecheck` + 服务端单测全量；
2. http 探针：忙时 steer → inserted 回执 → 边界生效且模型输入带 `[插话]` 标记；连发两条都进上下文；
3. 浏览器：Enter 忙时插话、插件卡切"排队"回旧行为、插话消息带徽标；
4. 真派一单：总管 `send_to_agent(mode=steer)` 改道打手，打手收话后续跑（TASK.md 端到端欠账顺手补上）；
5. pre-commit 契约快照（whenBusy 字段无新增，只是语义与缺省变化）。
