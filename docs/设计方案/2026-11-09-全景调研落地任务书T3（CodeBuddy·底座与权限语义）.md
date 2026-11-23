# 任务书 T3：底座与权限语义（工具能力声明 · 只读白名单 · 后台化 · 看门狗 · 恢复注记）
> 状态：已执行（任务书，2026-11-09）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


> 上位：`docs/设计方案/2026-11-09-Agent全景调研二` §2.4/§4.2（ZCode 13 字段声明、opencode Unattended、
> bash 超时转后台）、`调研三` §七（CopilotKit 闸门留痕与 stream_stalled 看门狗）、
> `调研四` §五.3（恢复注记先查后动）、`调研七` §六 #5/#8/#43/#45。
> 执行：CodeBuddy。派单人：总管。基线 `2b4708a`。你在独立 worktree 里干。**不 commit**。
> **注意**：本批与另外两批（T1 保证实现纵深 / T2 主动性与例行）并行，**可能都碰到 `agent/lifecycle.ts`
> 与 `approval-policy.ts`**。做法见「并行纪律」。

## 并行纪律（先读）

- 你的改动尽量落在**新文件**：`tool-capabilities.ts` / `gate-audit.ts`（若 T1 也在建同名文件，**用 `tool-capability.ts`
  与 `watchdog.ts` 避开**）/ `agent/recover-note.ts`。
- 对 `lifecycle.ts`、`approval-policy.ts`、`tools.ts` 的改动**尽量只增不改**：新函数 + 一两行调用点。
- 不要重排、不要格式化整文件（会让合并变成地狱）。

## 改动项

### 1. 工具能力声明结构化（P0，本轮的地基）

1.1 新建 `ts/apps/server/src/tool-capability.ts`：为每个已注册工具登记一份声明：

```ts
export interface ToolCapability {
  name: string;
  readOnly: boolean;          // 纯读，无副作用
  destructive: boolean;       // 不可撤销（写盘 / 起进程 / 派活）
  sideEffectScope: "none" | "memory" | "workspace" | "process" | "external";
  riskLevel: "low" | "medium" | "high";
  needsApproval: "never" | "critical" | "always";   // 与审批三档对齐的"下限"
  concurrentSafe: boolean;    // 同一会话内可否并发
  notes?: string;             // 一句话说明（中文）
}
export const TOOL_CAPABILITIES: Record<string, ToolCapability> = {...};
export function capabilityOf(name: string): ToolCapability | undefined;
```

1.2 **覆盖全部现行工具**（10 基线 + 条件注册的 7 个 + 本批之后的 `ask_user`，见 README 清单与接口文档 §4）。
1.3 **一致性守卫（这是本项真正的价值）**：新增单测断言
   `WRITE_TOOLS` 里的每个工具其 `destructive === true`；不在 `WRITE_TOOLS` 的每个工具 `destructive === false`；
   反向亦然。**任何一处不一致就让测试红**——以后新增工具漏登记会立刻暴露。
   同理断言 `DEFAULT_CRITICAL_TOOLS ⊂ {capability.needsApproval !== "never"}` 的集合相等（或明确列例外并写注释）。
1.4 **不改任何现有判定逻辑**（这是"登记，不是接管"）：`needsApproval()` 仍读老的 `WRITE_TOOLS`。
   在文件头注释里写清："本批只把口径显式化并对齐为可测断言；下一批再让闸门读声明。"

### 2. 只读白名单：读自己文件永不问（P1）

2.1 新建 `ts/apps/server/src/read-allowlist.ts`：
   - 纯读词表：`cat head tail grep rg ls dir type where file stat wc sort uniq find`（不含任何写/删/改/网络词）；
   - **命令里出现下列任一就照常问**：管道 `|`、重定向 `<` `>`、命令分隔 `;` `&`、变量 `$`、通配 `*` `?`、
     反引号、`$(`
   - 路径必须在**当前工作区根**内（用既有 `path-guard.ts` 的 realpath 口径），越界 → 照常问；
   - 只对 `bash`/`powershell` 生效。
2.2 接口：`isReadOnlyShellCommand(toolName, args, workspaceRoot, cwd): boolean`。纯函数，可单测。
2.3 **它只用于"降噪"，绝不放宽已有拦截**：判定顺序必须是 既有 `readOnlyBlockReason` → 审批判定 → **本白名单
   只能把 `ask` 变 `allow`，永远不能把 `block` 变 `allow`**。在 `lifecycle.ts` 的 `verdict.kind === "ask"` 分支前
   加一句 `if (allowlisted) verdict = {kind:"allow"}`，别动别的分支。
2.4 开关 `AGENT_READ_ALLOWLIST`（默认 **false**，先观望；开了才生效）。**默认关**是刻意的：这是放宽行为。
2.5 单测：10 个正例（纯读、路径在工作区）与 15 个反例（管道/重定向/变量/glob/工作区外/写命令混入）。

### 3. bash 超时转后台（P1）

3.1 现状：`AGENT_BASH_TIMEOUT_S` 注入默认超时，超时 = 工具失败。
3.2 目标：**超时 ≠ 失败**。超时的 bash 转成后台任务继续跑，工具结果回一句
   `命令超过 N 秒仍在跑，已转到后台（任务 <id>），完成后会告诉你结果。别再重复执行同一条命令。`
3.3 实现约束：**不要改内核**。做法 = 在 `beforeTool` 注入的 timeout 之外，另在 `afterTool` 捕获超时错误
   （T0 会给错误形状；不确定就先写一个探针确认错误长什么样，**探针结论写进变更记录**），
   捕获后由服务端自己 `spawn` 同一个命令（用 `child_process`，detached、输出落
   `.data/bg-jobs/<id>.log`），并把结果**作为一条系统消息注入会话**（走 `sayInConversation` 同族路径，
   与新的一轮无关，不打断）。任务记录落 `.data/bg-jobs/index.json`（id / 命令摘要≤120 字 / 起止 / 退出码）。
3.4 开关 `AGENT_BASH_BG_TIMEOUT`（默认 **false**，先观望）。开了才转。
3.5 **安全**：后台任务与前台同权限边界（不做额外放宽）；命令摘要进 index，**完整命令不落 json**（只落 log，
   与今天的 bash 输出同待遇）；不把 log 内容写进日志。
3.6 单测：超时错误识别 + 转后台 + index 落一条。（真起进程的用例要能秒过：用一个 `node -e "setTimeout(...)"`
   的短命令，超时设 1 秒。）

### 4. stream_stalled 看门狗（P2）

4.1 口径："卡死也是事件"。一轮对话里，如果**超过 N 秒没有任何 SSE 事件**（默认 180 秒，`AGENT_STALL_TIMEOUT_S`），
   记一条审计 `agent.stream_stalled`（只记会话 id、已耗时、最后一个事件类型），**不改行为、不中断**。
4.2 落点：那个把事件推到 SSE 的收口函数（T0 会给），包一层"最后事件时刻"表 + 一个 30 秒的定时器扫描。
4.3 记录落 `.data/stall-audit.jsonl`（追加）。开关 `AGENT_STALL_AUDIT`（默认 true）。
4.4 单测：模拟两分钟无事件 → 一条记录；有事件 → 不记。

### 5. 恢复注记：先查后动（P2）

5.1 恢复/续跑（`harness-resume`、`resumeTicket`、崩溃续跑的自动唤醒）时，给模型注入**一段固定文案**（≤300 字）：

> 你刚从一次中断里恢复。**先查再动**：先看目录里已有什么、`git log` / `git status` 有什么、
> 任务单上已经完成了哪几件，再决定下一步。已经成功做过的事**不要再做一遍**。
> 恢复注记每张单最多用一次。

5.2 落点：`agent/` 下新文件 `recover-note.ts` + 在续跑入口拼一条 system 消息。**每单只注入一次**（记账落在
   既有 resumeCount 语义旁边，不新建存储）。
5.3 开关 `AGENT_RECOVER_NOTE`（默认 true）。
5.4 单测：注入一次 + 第二次不再注入。

---

## 铁律

1. **不许 commit**。变更记录 `docs/变更记录/2026-11-09-底座与权限语义（工具声明·只读白名单·后台化·看门狗·恢复注记）.md`。
2. **不放宽任何现有安全边界**：§2 的默认关、§3 的默认关、§4/§5 不改行为。任何一处默认值犹豫 → 选"行为不变"。
3. 零 `shared` 改动；chancellor 仓库零改动。
4. 日志不含对话内容与完整命令；新文件写盘用原子写（与 `.data/` 既有习惯一致）。
5. `agent.ts` 是桶，新逻辑进新模块；`partners.ts` 之类只做存储的模块不要 import agent。

## 验证（最小充分，都要看输出）

- `pnpm typecheck` 0 错。
- `pnpm --filter @lifediary/server test` 全绿；新增覆盖 §1.3 一致性守卫、§2.5、§3.6、§4.4、§5.4。
- `pnpm --filter @lifediary/server http` 全绿（确认无回归）。
- `pnpm gate`（`delegate-gate-probe.ts`）两档都跑，确认闸门行为没变。
- 真模型手验归派单人。

## 交付物

代码（不 commit）+ 变更记录 + 接口文档（§6 新 env 五项 + §4 一句话说明能力声明）+ 单测/探针。
