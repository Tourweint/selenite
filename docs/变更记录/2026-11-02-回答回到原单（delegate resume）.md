# 回答回到原单：delegate 的 resume

- 日期：2026-11-02
- 范围：`ts/apps/server/src/tools.ts`、新增 `scripts/delegate-resume-probe.ts`、`package.json`、
  `docs/基线文档/接口文档.md`
- 依据：`docs/设计方案/2026-11-02-v0.6-回答回到原单.md`、chancellor v1.2 的 `resumeTicketId` / `answer`

## 背景

派活链路断在最后一环：worker 卡住问「验证码是啥？」→ 单子进 `needs_you` → 用户回「1234」，
这句话却只是对话里的一条普通消息。主 agent 手里没有原单，只能重新派一张新单；
对方那边的老 task 还在跑，两个任务抢同一个屏幕。

chancellor v1.2 已经有 `runChancellor({ resumeTicketId, answer })`，这次把 harness 这头的路由接上。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | `delegate` 加可选 `resume: boolean` | 是否续跑必须由模型显式判断，不按「这句像回答」自动猜；猜错会把新需求塞进老单 |
| 2 | 按会话记 `lastTicketId`，内存 Map，**不落库** | resume 只发生在同一轮对话；进程重启后会话已断，老单本来也接不上，落库只换来迁移/过期/清理的常态成本 |
| 3 | resume 时 `requirement` 只放用户那句回答 | 重述整个任务会让 worker 以为什么都要重做；`answer` 直接就是 `requirement` |
| 4 | 没单可续时**不报错**，按新活派并加一句说明 | 模型判断失误不该给用户看红色错误；但必须告诉模型「没续上」，否则它会以为接上了 |
| 5 | Map 留在 `createTools` 的闭包里，不模块级 | 进程重启自然清空，与「会话已断」的语义一致；探针也能用新实例模拟重启 |

### 为什么单子完成后不清 `lastTicketId`

留着。续跑一张已完成/找不到的单时，chancellor 会在**派活之前**拒绝（此时 worker 没动过），
harness 捕获后走同一条「没单可续」兜底：按新活派，返回里带说明。这样既不用维护「什么时候该清」，
也不会出现「以为续上了、实际派了新单却没说」的静默错误。

## 改了什么

- `src/tools.ts`
  - `delegate` 加 `resume` 可选参数；description 写清「用户回答了问题才用、`requirement` 只写回答、不要重派」
  - 按 `conversationId` 记最后一张单（`Map<number, string>`），每次派活成功后更新
  - `resume: true` 且有单 → `runChancellor({ resumeTicketId, answer })`
  - 没有单 / 续跑被拒 → 普通派活，返回文本追加「（没有可续的单，已按新活派）」
  - 进度帧与 attention 帧的发射逻辑不变
  - `ToolDeps` 加测试用 `delegateRun` 注入点（生产不传，默认 `runChancellor`）
- `scripts/delegate-resume-probe.ts`（新增）：不碰真模型和 chancellor 磁盘，用假入口验六组路由
- `package.json`：加 `resume` 脚本
- `docs/基线文档/接口文档.md`：工具清单补 resume 语义

## 验证

```
> pnpm --filter @lifediary/server resume
  ✓ 不带 resume 连派两次 → 两张单
  ✓ resume 后 ticket 数不变 — 新单数=1
  ✓ resume 带上原单 id
  ✓ answer 就是用户那句回答
  ✓ 进度帧照旧要发
  ✓ attention 帧照旧要发
  ✓ 空会话 resume → 按新活派 + 兜底说明
  ✓ B 不会续到 A 的单 / A 仍能续自己的单
  ✓ 重启后走没单可续分支 / 按新活派
  ✓ 续跑被拒后返回兜底说明 / 派了新单
✓ 续跑路由全部通过
```

回归：

```
> pnpm --filter @lifediary/server tasks   → ✓ 任务通道全部通过
> pnpm --filter @lifediary/server http    → ✓ 端到端全部通过
> pnpm --filter @lifediary/server diary   → 全部通过 ✅
> pnpm --filter @lifediary/server gate read-only / full → ✓ 闸门正确
> npm run typecheck                       → exit 0
```

## 没验证到的

1. **真模型下的 resume 整链路**：探针用假入口验证路由，没有真跑「worker 卡住 → 用户回答 → 同一 task 继续」。
   需要构造一个必然卡住的活并配 `DASHSCOPE_API_KEY`。
2. **App 侧的「需要你」交互**：这头只保证回答能回到原单，客户端把回答发回来仍走普通消息。
3. **多张单并行**：一个会话只记最后一张单；如果同一轮派了两张、先卡住的是前一张，`resume` 会指向后一张。
   当前主 agent 一次只派一张，未处理该情形。
