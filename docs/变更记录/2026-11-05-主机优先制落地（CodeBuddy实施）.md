# 主机优先制落地（CodeBuddy 实施）

日期：2026-11-05
类型：功能升级（自动分发 v1 → v2；中继路由元数据新增主机位与设备描述）
依据：`docs/设计方案/2026-11-05-主机优先制方案（先主机·满溢外流·设备描述）.md` +
`docs/设计方案/2026-11-05-主机优先制实施任务书（CodeBuddy）.md`

## 背景

自动分发 v1 的口径是"全员挑最闲"，但用户的实际用法是**大部分工作都在主机上做**：
一台机器应当是默认落点，别的机器只在主机忙不过来或不在线时接单。本次把 `auto` 升级为 v2：

- 中继上可设**唯一任务主机位**（用户手动设，不自动抢占）；
- `auto` 决策：主机在线且未满载 → **永远选主机**（哪怕别的机器更闲）；主机满载 → 剔除主机后
  按 busy 升序外流；主机离线/未设 → 回落 v1；
- 设备加可选 `description`（≤200 字，如"存储机"），**只给人看**（名册 / overview / delegate 回话），
  决策器不读。

没设主机时输出与 v1 完全一致——这是回归红线，单测与探针各钉了一次。

## 改动清单

| 文件 | 改动 |
|---|---|
| `ts/packages/shared/src/index.ts` | `RelayDeviceViewSchema` 加可选 `isHome` / `description`（注释写明描述只给人看、决策器不读）；`RelayMetaActionSchema` 加 `set-home` / `set-description`。 |
| `ts/apps/relay/src/store.ts` | `StoredDevice.description?`；`Store.homeDeviceId?: string \| null`（全矩阵唯一主机位，与伙伴归属同层不同义）；`load()` 恢复 `homeDeviceId`（否则重启丢主机位）；`setHomeDevice` / `homeDeviceId()` / `setDescription`；`listDevices` 投影带 `isHome`（同刻唯一）与 `description`；`MAX_DESCRIPTION_LENGTH=200`。 |
| `ts/apps/relay/src/hub.ts` | meta 动作 `set-home`（`{deviceId: string \| null}`，非法 id 回错误帧）、`set-description`（`{deviceId, description}`，>200 字拒绝）；`welcome` / meta `devices` 快照因走 `store.listDevices` 自动带 `isHome` / `description`。 |
| `ts/apps/relay/src/server.ts` | `POST /api/relay/home-device`、`POST /api/relay/devices/:id/description`：owner 或设备令牌（复用 `isOwner` / `deviceIdOf`），鉴权失败 403 空体、业务拒绝 400 带说明。 |
| `ts/apps/server/src/relay-auto.ts` | `AutoPickInput.homeDeviceId`；`selectAutoDevice` v2（主机优先 / 满载外流 / 离线未设回落 v1），返回加 `pickedHome`；排序抽成局部 `rank()` 供两路共用，tie-break 链一字未改；注释点明"主机未满载时 busy 不参与比较"是产品口径。 |
| `ts/apps/server/src/relay-matrix.ts` | 自动分支从 `client.devices` 的 `isHome` 取主机位（复用 refreshDevices 的现成快照，不开新通道）；`RemoteRow` 加 `pickedHome?`（auto 行落 true/false）；`RemoteDispatchResult` 加 `pickedHome?` / `deviceDescription?`。 |
| `ts/apps/server/src/relay-mobile-proxy.ts` | 加 `POST /api/v1/relay/home-device`、`POST /api/v1/relay/devices/:id/description`：body 透传中继 meta，中继未连 502 `relay_unavailable`；overview 的 `devices` 本来就透传名册，`isHome` / `description` 自动带出。 |
| `ts/apps/server/src/tools.ts` | delegate 远程成功回话带主机位与描述（如「乙机」（主机，存储机））；`targetDevice` 描述改为"优先主机、主机满载/离线才外流"。 |
| `ts/apps/server/src/relay-auto.test.ts` | v1 用例全部保留并补 `homeDeviceId: null` / `pickedHome: false`；新增 v2 七条：主机优先（别的更闲也不换）、主机满载外流、主机满载且其余全满 `all_busy`、主机离线外流、主机无 matrix 外流、主机 id 不存在/空串与 v1 同结果、描述不参与决策；台账旧行无 `pickedHome` 仍可读。 |
| `ts/apps/relay/src/store.test.ts` | 新增五条：`setHomeDevice` 设/清/非法 id 不动现状、名册投影 `isHome`+`description`、`setDescription` 截断/清除/未知设备、重启后主机位与描述仍在、主机被撤销后按"没设"处理。 |
| `ts/apps/server/scripts/matrix-probe.ts` | 加三场景：设主机 → auto 永选主机（台账 `pickedHome=true`）+ overview 透传 `isHome`/`description`；杀主机 → 外流到丙机（`pickedHome=false`）；未设主机时 `pickedHome=false`（v1 回归）。原有"无可用远端 fallback"改为杀掉丙机后再验。`DEVICE_MAX_ACTIVE_PER_DEVICE=50` 仅探针内抬高，避免历史 busy 累积误判满载。 |
| 文档 | `接口文档.md` §2.13 补四个端点、名册投影字段、auto v2 语义；`系统架构.md` 补"主机优先制"机制登记。 |

### 与任务书文件清单的两处必要补充

- **`ts/apps/server/src/relay-client.ts`**：`meta()` 的 action 参数原来是手写联合类型字面量，新增
  `set-home` / `set-description` 必须同步，否则手机代理面无法透传。顺手改成引用 shared 的
  `RelayMetaAction`，以后 shared 加动作时编译器会直接点名两端。
- **`ts/apps/relay/src/store.ts` 的 `load()`**：任务书只写"加字段"，但该函数是白名单式重建对象
  （只挑 `code` / `devices`），不把 `homeDeviceId` 加进去就会"设完重启即丢"。这条不是重构，
  属于让新字段真正生效的必要一格。

任务书列了 `ts/apps/server/src/index.ts`，实际**无需改动**：两个新端点都在
`mountRelayMobileProxy` 内注册，而它已在 `index.ts` 挂载；`/api/v1/*` 鉴权中间件对该前缀统一生效。

## 验证结果

执行目录均为 `ts/`：

1. `pnpm typecheck` —— 0 错（每步改动后都跑过）。
2. `pnpm --filter @lifediary/server test` —— **225 通过 / 0 失败**；新增/改写的 v2 用例：

```text
▶ selectAutoDevice：主机优先（v2）
  ✔ 主机未满载 → 永远选主机，哪怕别的机器更闲、更近
  ✔ 主机满载 → 外流：按 busy 升序挑其余最闲，pickedHome=false
  ✔ 主机满载且其余也满载 → all_busy（不硬塞回主机）
  ✔ 主机离线（不在候选）→ 按其余最闲挑，pickedHome=false
  ✔ 主机没有 matrix 能力（不在候选）→ 同样外流
  ✔ 主机位指向已不在名册的 id / 空串 → 与 v1 完全一致
  ✔ 描述字段不参与决策（同一名册只加 description，结果不变）
ℹ tests 225 / pass 225 / fail 0
```

3. `pnpm --filter @lifediary/relay test` —— **18 通过 / 0 失败**（新增五条主机位/描述用例；
   该包不在 `@lifediary/server test` 清单里，单独跑）。
4. `pnpm --filter @lifediary/server matrix` —— 全绿（真四进程：中继 + 甲乙丙）：

```text
  ✓ A 用 auto 自动挑机派活（202） — 乙机
  ✓ 自动挑机的台账记录 pickedBy=auto 与 busy 依据 — auto/busy=1
  ✓ 未设主机 → 台账 pickedHome=false（v1 回归） — false
  ✓ 中继设乙机为主机（POST /api/relay/home-device） — 2c3922e7
  ✓ 中继写乙机描述（POST …/description）
  ✓ overview 透传 isHome 与 description — isHome=true/desc=存储机
  ✓ 设了主机 → auto 永选主机（202） — 乙机
  ✓ 主机优先的台账记录 pickedHome=true — auto/true
  ✓ 乙机下线后名册确认其不再在线
  ✓ 主机离线 → auto 外流到丙机（202） — 丙机
  ✓ 外流的台账记录 pickedHome=false — auto/false
  ✓ DEVICE_AUTO_DISPATCH 未设 → auto_disabled（400） — auto_disabled
  ✓ 丙机下线后名册确认其不再在线
  ✓ 无可用远端 → fallback 本机（202，reason=no_candidate） — no_candidate

✓ 设备矩阵全通过
```

## 硬约束自查

- 决策器仍是**纯函数**：只读入参（devices / busyMap / 上限 / 主机 id），不读 env、不碰 IO。
- **描述不进决策路径**：`selectAutoDevice` 与候选过滤里没有任何 `description` 引用；有单测断言。
- **没设主机时与 v1 一致**：v1 的 13 条用例原样保留（只补 `pickedHome:false` 与新入参），
  另有一条"主机位指向不存在 id / 空串 → 与 v1 deepEqual"。
- **鉴权口径**：中继两个新端点与 `GET /api/relay/devices` 同源（owner 或设备令牌），失败 403 空体；
  harness 侧走既有 `/api/v1/*` 中间件，中继没连 502 并带说明。
- **密钥纪律**：未新增任何密钥读写；描述经名册落盘，属可公开的展示元数据。

## 回滚

一条开关：`DEVICE_AUTO_DISPATCH=false`（原本就默认关）——`auto` 直接 400 `auto_disabled`，
不会走到主机优先分支；点名派活与本机派活完全不变。

主机位本身是纯增量元数据：不清也能留着（不设 / 清空 = 回落 v1）；`relay-state.json` 多出的
`homeDeviceId` 与设备条目里的 `description` 对旧客户端不可见（字段可选，投影里 `isHome` 总是布尔）。
不需要改代码、不需要迁移存储。

## 未验 / 已知边界

- **主机"满载"外流只在单测覆盖**：探针里单机 busy 会随历史单累积（回执口径 `accepted` 不转终态，
  v1 落地时已登记），直接构造"正好满载"不可靠；按任务书允许，探针用**杀主机进程**验外流。
- **手机端（`<lifediary 手机仓>`）未改**：服务端契约与两个代理端点是就绪的，
  设置页要显示/设置主机与描述需手机仓另行对接（本仓纪律：只改本仓）。
- **配对时不带描述**：方案 §1.3 允许"配对时带或事后改"，任务书只列了事后改；本次只做
  `POST /api/relay/devices/:id/description`。
- **描述长度按 UTF-16 计数**：超长截断按 200 个 code unit（emoji 占 2），中文场景无差异。
