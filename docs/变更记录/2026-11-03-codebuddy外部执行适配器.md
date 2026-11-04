# CodeBuddy 外部执行适配器（§5.6 第一步）

- 日期：2026-11-03
- 范围：`<chancellor>\src\employee\codebuddy.ts`（新）、
  `src/employee/task-prompt.ts`（新，从 `mercenary.ts` 抽出）、
  `src/employee/{index,mercenary}.ts`、`src/{types,config,index,main}.ts`；
  harness 的 `ts/apps/server/src/codebuddy.test.ts`（新）、`scripts/codebuddy-probe.ts`（新）、
  `ts/apps/server/package.json`、`ts/apps/server/.env.example`
- 依据：`docs/设计方案/2026-11-03-宰相层（分管子代理）.md` §5.6

## 背景

方案 §5.6 定了三个外部执行的顺序：**CodeBuddy → Qoder 国际版 → Qoder CN**。
本次只接第一个，把"域负责人派活 → 执行者真跑 → 交回报告"这段跑通；
Qoder 国际版 / Qoder CN 适配、`-r` 续接、worktree 租约、任务中心前端、上下文换段都**没做**。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 新增雇员类型 `codebuddy`，用 `CHANCELLOR_EMPLOYEE=codebuddy` 选中 | 与现有 `native / mercenary / mcp / phone` 并列；回滚只改这一行 env |
| 2 | 失败判定统一为：退出码 0 + 有 `result` + `is_error=false` + `permission_denials` 为空 | 只看 `is_error` 会让"被拒"冒充"完成" |
| 3 | `--output-format json` 按**数组**解析，取最后一个 `type=result` | 2026-11-03 实测输出是 JSON 数组，不是单个对象 |
| 4 | 参数固定 `-p … --output-format json -y --model <全拼>` | `-y` 缺少会卡授权；`-m` 在 npm shim 下报 unknown option |
| 5 | 提示超过 8000 字符走 stdin（`-p` 不带值） | 避开命令行长度上限；已实测 `-p` 无位置参数时读 stdin |
| 6 | 清空所有 `CODEBUDDY_*` / `WORKBUDDY_*` 环境变量 | 宿主变量会让 CLI 把自己认成 WorkBuddy 客户端并挂起 |
| 7 | 超时沿用 `CHANCELLOR_WORKER_TIMEOUT_MS`（默认 10 分钟），超时 `killTree` + 失败终态 | 与方案的执行者预算一致 |
| 8 | Windows 上把 npm 的 `.cmd/.ps1` 壳解回 Node 入口，用 `node bin/codebuddy` 起进程 | 直接 `spawn("codebuddy")` 实测 ENOENT；不经过 cmd.exe 也就没有命令行注入面 |
| 9 | TASK.md 的读取抽到 `employee/task-prompt.ts`，两个 CLI 共用 | 后续 Qoder 适配必须拿同一份交付契约，避免验收口径漂移 |

## 改了什么

- `chancellor/src/employee/codebuddy.ts`（新）：`buildCodeBuddyInvocation`（参数/stdin）、
  `buildCodeBuddyEnv`（清宿主变量）、`parseCodeBuddyStdout`（数组/单对象/逐行）、
  `isCodeBuddySuccess`（四条件）、`runCodeBuddy`（超时/abort/退出码）、
  `createCodeBuddyEmployee`（REPORT.md 回读）、`resolveCodeBuddyLauncher`（npm shim）。
- `chancellor/src/employee/task-prompt.ts`（新）：`readTaskPrompt`；`mercenary.ts` 改为 import。
- `chancellor/src/employee/index.ts`：`capabilitiesOf`、`createEmployee` 接 `codebuddy`，并导出适配器函数。
- `chancellor/src/{types,config,index,main}.ts`：`EmployeeKind` / `CodeBuddyResult` / env 默认值 /
  `workerKindOf` / doctor 与 usage 同步。
- harness `ts/apps/server/src/codebuddy.test.ts`（新）：参数、stdin 阈值、env 清理、三种输出形状、
  成功判定矩阵、npm shim 解析。
- harness `ts/apps/server/scripts/codebuddy-probe.ts`（新）：不经过拆单，直接真跑适配器的最小任务。
- `ts/apps/server/package.json`：`test` 纳入 `codebuddy.test.ts`。
- `ts/apps/server/.env.example`：补 `CHANCELLOR_EMPLOYEE=codebuddy`、`CHANCELLOR_CODEBUDDY_BIN`、
  `CHANCELLOR_CODEBUDDY_MODEL`，并注明回滚方式。

## 验证

```
> pnpm typecheck                         → exit 0
> pnpm --filter @lifediary/server test   → 33 tests / 33 pass
> pnpm --filter @lifediary/server exec tsx scripts/codebuddy-probe.ts
    → ok=true, exitCode=0, result="收到", isError=false,
      permissionDenials=0, sessionId=01a1a1de-…, elapsedMs=8424
> CHANCELLOR_EMPLOYEE=codebuddy node src/main.ts doctor
    → 雇员：codebuddy；artifacts=taskDir canWriteFiles=true
> CHANCELLOR_EMPLOYEE=codebuddy node src/main.ts run "写 hello.txt …" --max-tasks 1
    → 1/1 过；status 显示 done / codebuddy / t-20261103-224515-kr98
```

真实链路没有使用 mock：执行者进程是真 CodeBuddy，报告由 qoder 验收读取。

## 没验证到的

1. **拒绝场景**：没有构造一次 `permission_denials` 非空的任务；判定逻辑只有单测覆盖。
2. **超时与 abort**：没有真跑到 10 分钟，也没有中途取消；逻辑沿用现有 `killTree` 模式。
3. **长提示走 stdin 的端到端**：shell 里验过 `codebuddy -p` 读 stdin，适配器只用单测覆盖了参数切换。
4. **负责人（domain）链路**：真跑的是一次不带 domain 的直接派 worker；负责人子进程会继承同一个
   `CHANCELLOR_EMPLOYEE`，但没单独验证。
5. **harness 的异步回灌**：没有起 server + 真模型跑 `delegate`，本次只验到执行者这一层。
6. **路径边界**：CodeBuddy 目前在任务目录里直接写，未接 worktree 租约与越权检测。
7. **`-r` 续接**：`session_id` 已解析并返回，但没有用于续跑；留给后续。

## 回滚

`CHANCELLOR_EMPLOYEE=native`（或 `mercenary`）即退回上一形态，不需要改代码。
