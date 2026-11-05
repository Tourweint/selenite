# 设备矩阵自动分发（CodeBuddy 实施）

日期：2026-11-05
类型：功能落地（设备矩阵阶段二增量；跨机契约新增通道与两个 env）
依据：`docs/设计方案/2026-11-05-设备矩阵自动分发方案（busy位·决策器·auto值）.md` +
`docs/设计方案/2026-11-05-自动分发实施任务书（CodeBuddy）.md`

## 背景

`delegate` 的 `targetDevice` 原来只有两态：点名远端设备、不填走本机。本次加第三态 `"auto"`：
由发起端按「在线 + `matrix` 能力 + 非本机 + 非手机 + 未满载」自动挑一台最闲的远端电脑；
挑不出就落本机执行，并把原因写回工具回话 / HTTP 响应。总开关 `DEVICE_AUTO_DISPATCH`
**默认关**；关着时 `"auto"` 按非法参数拒绝（工具与 HTTP 都是 `auto_disabled`），其余行为零变化。

决策在发起端，中继保持哑：忙碌度由发起端并发 invoke 目标机的 `delegation/busy` 查询，
目标机只读自己的回执库回答。

## 改动清单

| 文件 | 改动 |
|---|---|
| `ts/apps/server/src/relay-auto.ts`（新） | `selectAutoDevice` 纯函数（过滤 / busy 升序 / lastSeenAt 新者优先 / id 字典序 / 满载剔除 / 两类 fallback）；`queryBusyMap` 并发查忙碌度，任何失败记 1；`autoCandidates` 供查询与决策共用同一份过滤。 |
| `ts/apps/server/src/relay-channels.ts` | `RELAY_MATRIX_CHANNELS` 加 `delegation/busy`（仍只在 `DEVICE_MATRIX_ENABLED` 时进白名单）；分发到 `matrix.busy()`。 |
| `ts/apps/server/src/relay-matrix.ts` | `dispatchRemoteDelegation` 支持 `targetDeviceId === "auto"`：拉新名册 → 查 busy → 决策；fallback 返回 `{ fallbackToLocal: true, reason }` 不抛错；台账 `RemoteRow` 加可选 `pickedBy` / `pickReason`；`MatrixChannels` 加 `busy()`。 |
| `ts/apps/server/src/delegation-receipts.ts` | 加 `countActive()`：`outcome IN ('accepting','accepted')` 的条数（`delegation/busy` 的数据源）。 |
| `ts/apps/server/src/relay-config.ts` | 加 `deviceAutoDispatchEnabled()`（默认 false）与 `deviceMaxActivePerDevice()`（非法/小于 1 回落 3）。 |
| `ts/apps/server/src/tools.ts` | `targetDevice` 描述补 `"auto"`；开关关 → `{"ok":false,"error":"auto_disabled"}`；fallback 时继续走本机派活，并在回话前缀「自动挑机未成（原因），已在本机执行」。 |
| `ts/apps/server/src/index.ts` | `POST /api/v1/relay/matrix/delegate`：开关关 → 400 `auto_disabled`；fallback → 202 `{ ok:true, fallbackToLocal:true, reason }`（不 502）。 |
| `ts/apps/server/src/relay-mobile-proxy.ts` | 手机代理面 `agent-delegate` 同上语义（202 带 fallback 决策结果）。 |
| `ts/apps/server/src/relay-auto.test.ts`（新） | 13 条：候选过滤全分支、busy/lastSeenAt/id 三级排序、满载与全满载、忙碌度缺失按 0、busy 查询一半成功一半超时/坏回包、台账旧行无新字段仍可读。 |
| `ts/apps/server/scripts/matrix-probe.ts` | 加三场景：两台在线 auto 挑机且 `pickedBy=auto`；只剩本机 fallback `no_candidate`；未设 `DEVICE_AUTO_DISPATCH` 的丙机返回 400 `auto_disabled`。 |
| `ts/apps/server/package.json` | 仅把 `src/relay-auto.test.ts` 加进 `test` 脚本（脚本是显式文件清单，不加则新测试不参与全量）。 |

### 与任务书文件清单的两处必要补充

任务书未列 `delegation-receipts.ts` 与 `package.json`，但：

- `delegation/busy` 要读「本机非终态单数」，现有 `DelegationReceipts` 没有聚合查询，只能在回执库上补
  `countActive()`；否则要么在 relay 层重开 SQLite，要么重复实现 SQL，破坏「回执库唯一入口」。
- `package.json` 的 `test` 是逐文件枚举，不把新测试加进去，`pnpm --filter @lifediary/server test`
  不会跑它，验收第 2 条无法成立。

## 验证结果

执行目录均为 `ts/`：

1. `pnpm typecheck` —— 0 错（含 `relay-auto.test.ts` 与 `matrix-probe.ts`）。
2. `pnpm --filter @lifediary/server test` —— **216 通过 / 0 失败**，其中新增 13 条：

```text
▶ selectAutoDevice：候选过滤
  ✔ 零设备 → no_candidate
  ✔ 离线 / 无 matrix / 本机 / 手机 全部不算候选
  ✔ 非手机 platform 大小写不敏感地保留（Desktop / win32 都可候选）
▶ selectAutoDevice：排序与满载
  ✔ busy 升序：挑最闲的一台，并把 busy 带回去
  ✔ busy 并列：lastSeenAt 新者优先；undefined 当 0
  ✔ busy 与 lastSeenAt 都并列：id 字典序收敛（同输入同输出）
  ✔ 满载剔除：busy ≥ 阈值的不参与，哪怕它 lastSeenAt 最新
  ✔ 全部满载 → all_busy
  ✔ 忙碌度缺失按 0（不因为名册里没有记录就漏掉候选）
▶ queryBusyMap：容错
  ✔ 成功取 active；超时/错误一律记 1
  ✔ 回包形状不对（缺 active / 负数）同样记 1
  ✔ 真超时：单台拖过 timeoutMs 也不拖垮其它结果
✔ relay-matrix 台账：旧行没有 pickedBy / pickReason 仍可读
ℹ tests 216 / pass 216 / fail 0
```

3. `pnpm --filter @lifediary/server matrix` —— 全绿（真四进程：中继 + 甲乙丙）：

```text
  ✓ 离线目标 fail-fast（502 device_offline）
  ✓ A 点名乙机派活（202） — auto-288…
  ✓ 远端单到达终态（done/failed 均可，视有无 key） — needs_you
  ✓ 终态汇报写回 A 的发起会话
  ✓ A 用 auto 自动挑机派活（202） — 乙机
  ✓ 自动挑机的台账记录 pickedBy=auto 与 busy 依据 — auto/busy=1
  ✓ 乙机下线后名册确认其不再在线
  ✓ 无可用远端 → fallback 本机（202，reason=no_candidate） — no_candidate
  ✓ DEVICE_AUTO_DISPATCH 未设 → auto_disabled（400） — auto_disabled

✓ 设备矩阵全通过
```

auto 场景实际走通了 `delegation/busy` 通道（乙机 alive 时应答、台账 `pickReason=busy=1`）；
fallback 场景 `no_candidate` 与开关关闭场景均按预期。

## 回滚

`DEVICE_AUTO_DISPATCH=false`（默认）即可：

- `delegate targetDevice="auto"` → `auto_disabled`，不建单、不查忙碌度；
- HTTP 两个派活端点同语义（400），其余字段与旧行为一致；
- 新增的 `delegation/busy` 只是白名单多一个通道，没有调用方时零副作用；
- 台账新字段均为可选，旧 JSON 行原样可读（测试已断言）。

不需要改代码、不需要迁移存储。

## 已知边界与未做

- **忙碌位口径的局限**：任务书规定「非终态 = outcome 为 accepting / accepted」；当前回执库的
  `accepted` 不会在任务完成后转终态（回执是幂等凭据，生命周期比任务长）。因此 `delegation/busy`
  返回的是**累计受理数**，会随该机历史派单单调增长，最终可能触发 `all_busy`。
  本次严格按任务书口径实现，未擅自改回执状态机；建议后续用 ticket.json 终态做二次过滤，
  单独立项。
- 自动派活**不排队、不换机重派**（方案 §2.4 明确不做）。
- 基线文档 `接口文档.md` 的通道表 / env 表、`系统架构.md` 的机制说明**尚未回写**：
  任务书纪律要求只改列出的文件，故留待验收方下沉。
- 手机端（`lifediary` 仓）未改：`agent-delegate` 的 `auto` 透传由手机侧自行发起，
  本次只保证服务端契约。
