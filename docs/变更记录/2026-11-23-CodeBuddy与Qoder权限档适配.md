# 2026-11-23 CodeBuddy 与 Qoder 权限档适配

方案：`docs/设计方案/2026-11-23-CodeBuddy与Qoder权限档适配.md`（D1–D4）。
用户口径：CodeBuddy / Qoder 界面原来是「固定全权」，CLI 原生支持 `--permission-mode`，接上，按厂商给啥用啥。

## 改了什么

| 文件 | 改动 |
|---|---|
| `ts/packages/chancellor/src/employee/codebuddy.ts` | `CodeBuddyCall.permission?`；新增 `codeBuddyPermissionMode()`（`read→dontAsk`、`edit→acceptEdits`、`full→bypassPermissions`）；`buildCodeBuddyInvocation` 第 4 参接 `permission`（默认 `full`），argv 由 `-y` 改为 `--permission-mode <档>`；`createCodeBuddyEmployee` 把 `resolveProfile("codebuddy", …).permission` 下传（缺省 `full`） |
| `ts/packages/chancellor/src/employee/qoder.ts` | `QoderCall.permission?` 与 `tools` 解耦；新增 `qoderPermissionMode()`（`read→dont_ask`、`edit→accept_edits`、`full→bypass_permissions`）；`buildQoderInvocation` 里 `tools:"none"`（纯问答 / probe）仍固定 `dont_ask`，`tools:"all"` 按权限档；`createQoderEmployee` 全链下传 `permission` |
| `ts/packages/chancellor/src/config.ts` | 新增 `CHANCELLOR_CODEBUDDY_PERMISSION` / `CHANCELLOR_QODER_PERMISSION` / `CHANCELLOR_QODER_CN_PERMISSION`（缺省 `full`）；`defaultProfileFor` / `resolveProfile`（权限档生效列表）/ `profileEnv` 三处纳入这三档 |
| `ts/apps/server/src/executor-config.ts` | CodeBuddy / Qoder 国际 / Qoder 国内 `permissions` 从 `null` 改为 `["read","edit","full"]`，加 `permissionOptions`（厂商原生档名与实测语义）；`envProfile` 补 permission 缺省；卡片 note 去掉「固定全权」并写明拒绝不进 `permission_denials` 的边界 |
| `ts/apps/server/src/executor-probe.ts` | CodeBuddy 检测调用补 `permission:"read"`（与 Claude / Codex / OpenCode / 豆包一致；Qoder 本就走 `tools:"none"`） |
| `ts/apps/server/src/tools.ts` | `delegate.permission` 描述的「生效」清单加 CodeBuddy / Qoder——**工具描述属缓存前缀资产，这次改动会打掉一次上游 prompt cache** |
| `ts/apps/server/skills/delegate.md` | 新增「权限（permission）」段：三档含义、各 CLI 实测差别、生效范围 |
| `ts/packages/chancellor/src/types.ts` | `EmployeeProfile` 注释改成「CodeBuddy / Qoder 也吃 permission」 |
| `ts/apps/server/src/codebuddy.test.ts` | argv 形状（无 `-y`、`--permission-mode`）、三档映射、`resolveProfile` / `profileEnv`、employee 透传（含旧配置 = full） |
| `ts/apps/server/src/qoder.test.ts` | 三档映射、纯问答固定 `dont_ask`、`resolveProfile` / `profileEnv`、employee 透传 |
| `ts/apps/server/src/executor-config.test.ts` | 三档 `permissions` + `permissionOptions` 形状与标签；env 缺省进 profile；旧配置无字段 = full；`executorSummary` 不再显示「固定全权」 |

## 真机实测矩阵（2026-11-23）

环境：Qoder 国际 `qodercli 1.1.81`（`C:/Users/Tourweint/.qoder/bin/qodercli/qodercli.exe`）、
Qoder 国内 `qoderclicn 1.1.81`、CodeBuddy `2.179.3`。
每个格子一个空目录（系统临时目录），两件事各跑一次：

- 写文件：`用 Write 工具在当前目录创建文件 pw.txt，内容一行 hello`
- 跑命令：`用 Bash 工具在当前目录执行：echo hi > pc.txt`

命令模板：Qoder `-p <提示> -w <目录> --permission-mode <档> -o json -m DeepSeek-Flash --max-turns 10`；
CodeBuddy `-p <提示> --output-format json --permission-mode <档> --model deepseek-v4.1-flash [-y]`。
全部 `< /dev/null`，每格 7–17 秒，**没有卡住 / 超时**（Qoder 国内本机已登录，未复现首调 100 秒冷启动）。

### Qoder 国际

| 权限档 | 写文件 | 跑命令 | 证据 |
|---|---|---|---|
| `dont_ask` | 拒 | 拒 | 正文「Write 工具被权限模式拦截」；`permission_denials` 分别 1 / 2 条 |
| `accept_edits` | 成 | 拒 | `pw.txt` 落盘；命令「被权限拦截，未执行」，`permission_denials` **0** |
| `bypass_permissions` | 成 | 成 | `pw.txt` 与 `pc.txt` 都落盘 |

### Qoder 国内

| 权限档 | 写文件 | 跑命令 | 证据 |
|---|---|---|---|
| `dont_ask` | 拒 | 拒 | `permission_denials` 各 1 条 |
| `accept_edits` | 成 | 拒 | `pw.txt` 落盘；命令「被权限提示拦截」，`permission_denials` **0** |
| `bypass_permissions` | 成 | 成 | 两件都落盘 |

### CodeBuddy

| 权限档 | `-y` | 写文件 | 跑命令 | 证据 |
|---|---|---|---|---|
| `dontAsk` | 无 | 拒 | 拒 | Write / Bash 均「权限被拒绝」；`permission_denials` 0，`subtype=success` |
| `dontAsk` | 有 | 拒 | 拒 | 同上——**加 `-y` 不改变结果** |
| `plan` | 无 | 拒 | 拒 | 拒写；额外生成 `~/.codebuddy/plans/*.md` 并尝试 `ExitPlanMode`（被拒） |
| `plan` | 有 | 拒 | 拒 | 同上——加 `-y` 不改变结果 |
| `acceptEdits` | 无 | 成 | 拒 | `Bash` 明确 denied（`Permission to use Bash has been denied`）；模型自行改用 Write 兜底把 `pc.txt` 写出来 |
| `acceptEdits` | 有 | 成 | 拒 | 同上——加 `-y` 不改变结果 |
| `bypassPermissions` | 无 | 成 | 成 | `Bash completed`，`pc.txt` 落盘 |
| `bypassPermissions` | 有 | 成 | 成 | 同上 |

### 实测结论（与方案表的差异）

1. **CodeBuddy 的 `-y` 不改变任何档位效果**（`dontAsk` / `plan` 加了 `-y` 仍拒写，`acceptEdits` 加了 `-y` 仍拒 Bash），
   所以不再固定带 `-y`，权限只由 `--permission-mode` 决定。方案 D1 里「是否保留 `-y` 按实测」→ **不保留**。
2. **CodeBuddy 只读档选 `dontAsk`**：`plan` 也能拒写，但会写自己的计划文件并尝试 `ExitPlanMode`，
   与「只读」语义相比噪声更大；`dontAsk` 与 Qoder `dont_ask` 语义一致。
3. **CodeBuddy `acceptEdits` 与 Qoder `accept_edits` 同形**：只放文件写入、Bash 被拒；
   方案表里「edit = acceptEdits」成立。
4. **拒绝不一定进 `permission_denials`**：CodeBuddy `dontAsk` / `plan` 与 Qoder `accept_edits` 的拒绝
   都出现过 `denials=0`，只写在正文里。裁决 / 验收不能只依赖这个字段（原有判据不改，只登记边界）。

## 权限档口径（落地后）

| 内部档 | CodeBuddy | Qoder 国际 / 国内 |
|---|---|---|
| `read` | `--permission-mode dontAsk` | `--permission-mode dont_ask` |
| `edit` | `--permission-mode acceptEdits` | `--permission-mode accept_edits` |
| `full` | `--permission-mode bypassPermissions` | `--permission-mode bypass_permissions` |

- 旧 `.data/executor.json` 里没有 `permission` 字段 = `full`，与改动前行为一致（改动前就是固定全权）。
- 纯问答 / probe：Qoder 仍 `tools:"none"` + `dont_ask`；CodeBuddy 检测显式 `permission:"read"`。
- 界面 `permissionOptions` 标签：只读 / 可改 / 全权，hint 写原生档名与实测差别。

## 验证

- `cd ts && pnpm typecheck`：通过。
- 定向：`codebuddy` / `qoder` / `executor-config` 共 39 条，全过。
- 全套：`pnpm --filter @lifediary/server test` 1456 条，**全过**。
  （首次跑时有 2 条 `provider.test.ts` 红，是同批供应商删除改动正在编辑该文件造成的瞬时状态；
  改完后重跑全绿。）
- 真机矩阵：Qoder 国际 3 档 × 2 件事、Qoder 国内 3 档 × 2 件事、CodeBuddy 4 档 × 带/不带 `-y` × 2 件事，
  共 26 格，全部跑通，无卡住。
- 检测路径冒烟：CodeBuddy `--permission-mode dontAsk` + 「只回复 OK」→ 正常返回 `OK`（`subtype=success`），
  read 档不影响一句话问答。

## 未验 / 已知边界

- 未做「派单层真跑」（任务中心建一张 `read` 单、一张 `full` 单）：需要起服务并写 `.data/`，本批按约束未动；
  CLI 级矩阵 + 单元测试已覆盖参数映射。
- 只验了「写文件」与「简单命令（echo 重定向）」；**高风险命令**（`-y` 文档里说 HIGH/CRITICAL 仍会问）
  在 `acceptEdits` / `bypassPermissions` 下的行为没验。
- CodeBuddy `plan` 会写 `~/.codebuddy/plans/` 下的计划文件，本批只把它排除在只读档候选之外，没有清理该目录。
- `permission_denials` 漏报拒绝的边界见上；本批不改成功判定逻辑（属另一条线）。
