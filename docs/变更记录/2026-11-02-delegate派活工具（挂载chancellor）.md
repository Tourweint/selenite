# delegate 派活工具（挂载 chancellor）

- 日期：2026-11-02
- 范围：`ts/apps/server/src/tools.ts`、`src/agent.ts`、`scripts/task-probe.ts`、
  新增 `scripts/delegate-gate-probe.ts`、`.env.example`、`docs/基线文档/接口文档.md`
- 依据：`<chancellor>\docs\设计方案\2026-11-01-v1-挂载实现.md`

## 背景

harness 的主 agent 一直是"我让它干什么它就干什么"——它会自己 read、自己 write、自己 bash。
一件事要动五个文件，它就在同一个会话里来回五次，上下文越滚越长，中途我离开电脑它也没法继续。

缺的不是"它不会干"，是"它不能把活交出去"。这次给它装一只手：`delegate`。

装上去之后主 agent 的分工是：**它自己不动手，把多步的活交给外面的 worker，只拿回一句话。**

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 挂成**工具**，不是任务通道 | 任务通道（`X-Task`）是"无工具、无人格、一次性出文本"，用来跑日记模板；派活要的是主 agent 主动决定，只能是工具 |
| 2 | `delegate` 加进 `WRITE_TOOLS` | 它本身不写文件，但**会起 worker 去写**。不拦它，`AGENT_TOOL_POLICY=read-only` 就是个谎 |
| 3 | 默认开，`CHANCELLOR_ENABLED=false` 关 | 这是**回滚开关**不是功能开关：出问题改一行环境变量就退回 8 个工具，不用改代码 |
| 4 | 相对路径 import chancellor | chancellor 是独立仓库、跑 `.ts` 源码；装进 node_modules 后 node 不给里面的 `.ts` 剥类型（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。只有 `tools.ts` 一处引用，挪仓库改一行 |
| 5 | 只传 `context.abortSignal` 进去 | harness 有 `/stop`；不传的话用户按停止只停 UI，worker 在后台继续烧额度 |
| 6 | 把只读判定提成 `readOnlyBlockReason()` | 安全规则埋在 hook 里没法测——faux 给的工具参数是空对象，`delegate` 的必填参数校验就过不去，走不到闸门。提出来才能直接断言 |

### 为什么 `delegate` 的 description 写那么细

"不适合"那半句比"适合"更重要。写宽了，主 agent 会把一次 read 就能答的事也派出去，
每次都起 worker，比不用还贵。所以明确写了：不适合回答问题、闲聊、一次 read 能答的事、
需要边做边问的事；并且告诉它"派出去之后你看不到过程，中途不能追问"。

## 改了什么

- `src/tools.ts`：新增 `delegate` 工具；`ToolDeps` 加 `delegate?: boolean`；
  返回值从"提前 return 两个数组"改成"先攒 `tools` 数组再按需 push"（这样 skill 和 delegate 互不牵连）
- `src/agent.ts`：`createTools({...})` 传 `delegate: CHANCELLOR_ENABLED`；
  `WRITE_TOOLS` 加 `"delegate"`；新增 `CHANCELLOR_ENABLED` 常量与 `readOnlyBlockReason()`；
  hook 里那段只读判定改为调 `readOnlyBlockReason()`
- `scripts/task-probe.ts`：§5 新增「delegate 在工具清单里」断言（工具清单 8→9）
- `scripts/delegate-gate-probe.ts`（新增）：`read-only` / `full` 两种模式断言闸门
- `package.json`：加 `gate` 脚本
- `.env.example`：`CHANCELLOR_*` 五个变量
- `docs/基线文档/接口文档.md`：工具数 8→9

## 验证

```
> npm run typecheck
（无输出，exit 0）

> pnpm --filter @lifediary/server tasks
  ✓ skill 工具在工具清单里 — read、write、edit、bash、remember、recall、set_reminder、skill、delegate
  ✓ delegate 工具在工具清单里（派活能力） — 9 个：read、write、edit、bash、remember、recall、set_reminder、skill、delegate
  ...
✓ 任务通道全部通过

> pnpm --filter @lifediary/server gate read-only
  ✓ write 被拦 — 当前是只读模式（AGENT_TOOL_POLICY=read-only）
  ✓ edit 被拦 — ...
  ✓ bash 被拦 — ...
  ✓ powershell 被拦 — ...
  ✓ delegate 被拦 — 当前是只读模式（AGENT_TOOL_POLICY=read-only）
  ✓ read / remember / recall / set_reminder / skill 放行
✓ read-only 闸门正确

> pnpm --filter @lifediary/server gate full
  ✓ 十个工具全部放行
✓ full 闸门正确

> pnpm --filter @lifediary/server http
✓ 端到端全部通过

> pnpm --filter @lifediary/server diary
全部通过 ✅
```

回滚开关的反向验证：

```
> CHANCELLOR_ENABLED=false pnpm --filter @lifediary/server tasks
  ✗ delegate 工具在工具清单里（派活能力） — 8 个：read、write、edit、bash、remember、recall、set_reminder、skill
✗ 有 1 项没通过
```

只有 delegate 那一条断言失败，其余全过——说明开关只摘掉了这一个工具，没动别的。

## 没验证到的

1. **真机派活**：本机 `.env` 没有 `LLM_API_KEY`，harness 跑的是 mock 模式，主 agent 不会真的调工具。
   所以"主 agent 会不会自己想到调 delegate"这条**没验**——那是 description 写得好不好的问题，得真机看。
2. **`/stop` 传到 worker 子进程**：`context.abortSignal` 已经传进去了，但没做"派活中途按停止、
   确认 qodercli 进程消失"的端到端验证（需要真模型跑一个长任务）。
3. **真实 worker 产出**：同上，没 key 跑不了原生 worker；雇佣兵（qoder）能跑但这次没在 harness 里驱动。
4. **存量会话的缓存成本**：工具清单 8→9 会给存量会话追加一条 `pi.system` 补丁，一次性重算
   （同 2026-10-31 技能通道那次）。没有实测耗时。

## 回滚建议

单提交回滚；或者不改代码，设 `CHANCELLOR_ENABLED=false`——工具清单回到 8 个，
行为与改动前完全一致（上面那条反向验证就是证据）。
