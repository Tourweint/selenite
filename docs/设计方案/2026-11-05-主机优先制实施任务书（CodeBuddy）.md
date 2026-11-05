# 实施任务书：主机优先制（CodeBuddy · deepseek-v4.1-flash）

> 日期：2026-11-05。方案：同目录《2026-11-05-主机优先制方案（先主机·满溢外流·设备描述）.md》。
> 上一次实施（自动分发 v1）已在库：`relay-auto.ts` 的决策器、`delegation/busy` 通道、
> `DEVICE_AUTO_DISPATCH` 开关都在。本任务是**升级**，不是重来。
> 仓库：`<repo>`（一切改动只在此仓）。

## 〇、你要做什么（一段话）

给自动分发加"主机优先"：用户在中继上指定一台**主机**（home device），`auto` 派活时
只要主机在线且未满载就**永远选主机**（哪怕别的机器更闲）；主机满载或离线才按忙碌度挑
其余设备；没设主机回落现有"全员挑最闲"。另外给设备加可选**描述**（≤200 字，如"存储机"/"计算用"），
只在名册/工具输出里给人看，**决策器不读它**。

## 一、开工前必读（按序）

1. `AGENTS.md`（仓库根）；
2. `docs/设计方案/2026-11-05-主机优先制方案（先主机·满溢外流·设备描述）.md`；
3. 现有实现：
   - `ts/apps/server/src/relay-auto.ts` —— v1 决策器（**本任务主要升级对象**）；
   - `ts/apps/relay/src/store.ts` / `hub.ts` —— 名册与 meta 动作（加 homeDeviceId/description）；
   - `ts/apps/server/src/relay-matrix.ts` —— dispatch 里调 selectAutoDevice 与 queryBusyMap 的位置；
   - `ts/apps/server/src/relay-mobile-proxy.ts` —— 手机代理面（加两个透传端点）。

## 二、改动清单（按序，每步 typecheck）

### 1. `ts/packages/shared/src/index.ts`

`RelayDeviceView` 加两个可选字段：`isHome?: boolean`、`description?: string`（注释写明：
描述只给人看，决策器不读）。

### 2. `ts/apps/relay/src/store.ts`

- `StoredDevice` 加 `description?: string`；
- `Store` 顶层加 `homeDeviceId?: string | null`（**唯一主机位**，与伙伴路由表 `actors` 同层）；
- 方法：`setHomeDevice(deviceId | null)`（设/清；id 不在名册时返回 false）、
  `homeDeviceId(): string | null`、`setDescription(deviceId, text ≤200)`。

### 3. `ts/apps/relay/src/hub.ts`

- meta 新动作：`set-home`（payload `{deviceId: string | null}`，deviceId 为 null 即清除；
  非法 id 返回错误帧）、`set-description`（payload `{deviceId, description}`）；
- `devices` 快照（`case "devices"` 与 welcome）投影时带 `isHome`（store.homeDeviceId 比对）
  与 `description`。

### 4. `ts/apps/relay/src/server.ts`

REST：`POST /api/relay/home-device`（owner 或设备令牌；body `{deviceId}`）、
`POST /api/relay/devices/:id/description`（owner 或设备令牌；body `{description ≤200}`）。
owner 判定复用 `isOwner` 现有实现。

### 5. `ts/apps/server/src/relay-auto.ts`

`selectAutoDevice` 入参加 `homeDeviceId: string | null`，v2 规则：

```
candidates 过滤（不变）
若 homeDeviceId 非空且在 candidates 里：
  主机 busy < maxActivePerDevice → 返回主机（不看别的机器多闲）
  否则 → 从 candidates 里去掉主机，按 busy 升序（tie-break 不变）挑；全满 → all_busy
homeDeviceId 空 / 不在候选（离线）→ 现有 v1 逻辑原样
返回形状扩展：{ picked, busy, pickedHome: boolean }（pickedHome 便于台账与探针断言）
```

注释必须写明"主机未满载时 busy 不参与比较"是产品口径（用户定调：大部分工作都是主机用），
不是实现偷懒。

### 6. `ts/apps/server/src/relay-matrix.ts`

- `queryBusyMap` 之前/同时从中继拉 `homeDeviceId`：复用 `client.meta("devices", {})`
  的快照（devices 里有 isHome）取 `id`，或直接读 `client.devices`——**用现成路径，别开新通道**；
- dispatch 的 `"auto"` 分支把 homeDeviceId 传给 selectAutoDevice；
- 台账 `RemoteRow` 加可选 `pickedHome?: boolean`。

### 7. `ts/apps/server/src/relay-mobile-proxy.ts` 与 `index.ts`

- overview 透传（devices 已含 isHome/description 自动带出）；
- harness 侧加两个端点（走 `/api/v1` 鉴权，body 透传给中继 meta 或 REST）：
  `POST /api/v1/relay/home-device`、`POST /api/v1/relay/devices/:id/description`——
  **手机/设置页由此设主机与描述**。中继未连时 502。
- delegate 工具（tools.ts）：远程分支返回的设备信息里带描述与 isHome（点名参考）。

### 8. 测试（必须写）

- `relay-auto.test.ts` 扩 v2 分支：有主机永选主机（即使它 busy 比 别人高）/ 主机满载外流
  （pickedHome=false 且挑的是最闲的）/ 主机离线外流 / 无主机回落 v1 / 描述字段不影响结果 /
  pickedHome 断言；
- relay store 测试：setHomeDevice 的设/清/非法 id。

### 9. 探针 `matrix-probe.ts` 加三场景

- 设主机（`POST :8410/api/relay/home-device`，loopback 免 owner）→ auto 永选主机
  （断言台账 pickedHome=true）；
- 把主机 busy 打满（不好直接构造就跳过 busy 打满场景，改为：**杀主机进程**）→
  auto 外流到另一台（pickedHome=false）；
- overview 断言 isHome / description 透传。

## 三、验收标准（我做，你要自检到能过）

1. `cd ts && pnpm typecheck` 零错；
2. `pnpm --filter @lifediary/server test` 全绿（含新测试）；
3. `pnpm --filter @lifediary/server matrix` 探针含三新场景全过；
4. 硬约束自查：决策器仍纯函数；描述字段不进决策路径；没设主机时行为与 v1 完全一致
   （回归红线）；中继 REST 新端点鉴权口径与现有 `isOwner` 一致。

## 四、纪律

同上一份任务书：只改列出的文件；不引入新依赖；中文注释；每步 typecheck；
完成后写 `docs/变更记录/2026-11-05-主机优先制落地（CodeBuddy实施）.md`
（背景 / 改动清单 / 验证结果 / 回滚说明）。
