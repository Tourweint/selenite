# CodeBuddy 与 Qoder 权限档适配（2026-11-23）

**状态**：已落地（2026-11-23）。
**冲突口径**：落地后以 `docs/基线文档/接口文档.md`、`docs/基线文档/接口-端点7-权限技能与开关.md` 为准。

**下沉落点**（设计期结论已进长期文档，本文件只留"当时怎么想的"）：

| 结论 | 落点 |
|---|---|
| 三档映射与各档实测边界 | `接口文档.md` §6 env 表（三条 `*_PERMISSION`）、`接口-端点7-权限技能与开关.md` §2.23 权限档表 |
| 架构决策（含实现位置、回滚、已知边界） | `系统架构.md` D42（原计划排 D41，落地时 D41 已被同批「供应商删除不设保护」占用） |
| 落地清单、真机矩阵、验证数字 | `docs/变更记录/2026-11-23-CodeBuddy与Qoder权限档适配.md` |
| 工具描述 / 提示词改动（缓存前缀资产） | `ts/apps/server/src/tools.ts`、`ts/apps/server/skills/delegate.md`，变更记录里有登记 |

**与方案的差异**：CodeBuddy 不再保留 `-y`（实测不改变档位效果）；只读档取 `dontAsk` 而非 `plan`
（`plan` 会写自己的计划文件）；`acceptEdits` 实测同样拒 Bash（只放文件写入）。

## 1. 背景与用户口径

用户指出：CodeBuddy 和两个 Qoder（国际 / 国内）的权限相关没有处理，现在界面上是「固定全权」。
按「厂商给啥咱们就用啥」的口径，这三档既然 CLI 原生支持权限参数，就应该接上，而不是写死。

## 2. 调查（2026-11-23 本机 `--help`）

- **Qoder 国际 / 国内**：`--permission-mode` 支持
  `default / accept_edits / bypass_permissions / dont_ask / auto`。
  现有适配器只用了两档：纯问答 `dont_ask`、worker 固定 `bypass_permissions`；
  `accept_edits` 没接。
- **CodeBuddy**：`--permission-mode` 支持
  `acceptEdits / bypassPermissions / default / plan / dontAsk / auto`；
  另有 `-y`（`dangerously-skip-permissions`，HIGH/CRITICAL 仍会问）。
  现有适配器固定 `-y`，权限档没接。

## 3. 方案

### D1. 三档映射（以真机实测为准）

| 内部档 | Qoder 国际 / 国内 | CodeBuddy |
|---|---|---|
| `read` | `--permission-mode dont_ask` | 实测选 `dontAsk` 或 `plan`（以「写文件被拒 / 不写」为准） |
| `edit` | `--permission-mode accept_edits` | `--permission-mode acceptEdits` |
| `full` | `--permission-mode bypass_permissions` | `--permission-mode bypassPermissions`（是否保留 `-y` 按实测：若 `-y` 会覆盖档位则不保留） |

实测矩阵（每档跑「建文件」与「跑命令」各一次）：

- Qoder：`dont_ask` / `accept_edits` / `bypass_permissions` × 写文件 / 跑命令；
- CodeBuddy：`dontAsk` / `plan` / `acceptEdits` / `bypassPermissions`（含/不含 `-y`）× 写文件 / 跑命令。

判定标准：能被拒或不被执行 = 该档不具备该能力；卡住 = headless 不可用；成功 = 具备。
实测结果写进变更记录；映射与表不一致时以实测为准并说明。

### D2. 契约与配置

- `EmployeeProfile.permission` 的适用范围从 Claude / Codex / OpenCode / 豆包扩到
  **CodeBuddy / Qoder 国际 / Qoder 国内**；内部三值不变。
- `resolveProfile` / `defaultProfileFor` / `profileEnv` 三处补这三档；
  新增 env `CHANCELLOR_CODEBUDDY_PERMISSION` / `CHANCELLOR_QODER_PERMISSION` /
  `CHANCELLOR_QODER_CN_PERMISSION`，缺省 `full`。
- `.data/executor.json` 的 `profiles.codebuddy` / `qoder-intl` / `qoder-cn` 开始写 `permission`；
  旧配置没有该字段 = `full`（行为不变）。

### D3. 界面

`EXECUTOR_KIND_INFO` 里 CodeBuddy / Qoder 的 `permissions` 从 `null` 改成
`["read","edit","full"]`，并用 `permissionOptions` 显示厂商原生档名：

- Qoder：只读（dont_ask）/ 可改（accept_edits）/ 全权（bypass_permissions）
- CodeBuddy：只读（按实测）/ 可改（acceptEdits）/ 全权（bypassPermissions）

### D4. 工具与提示词

`delegate.permission` 的描述把 CodeBuddy / Qoder 加进「生效」清单（缓存前缀资产，记录变更）。
`skills/delegate.md` 的权限说明同步。

## 4. 明确不做

- 不改纯问答 / probe 路径：probe 仍用 `read` 档（`dont_ask` / CodeBuddy 的只读档）。
- 不假装有只读沙箱：实测该档仍能写就按实测标注，不写"只读"。
- 不做按单执行器、不改领域关入口（平行批次）。

## 5. 验证

- `pnpm typecheck`；`cli-employees` / `executor-config` / `qoder.test.ts` / `codebuddy.test.ts` 定向；
  全套 `pnpm --filter @lifediary/server test`。
- 真机：Qoder 国际 / CodeBuddy 各跑三档的写文件 / 跑命令矩阵（Qoder 国内可只验关键档，慢则标注未验）。
- 派单真跑：一张 `read` 档单确认写操作被拒或未执行，一张 `full` 单确认能写。
