# 实施任务书：设备矩阵自动分发（CodeBuddy · deepseek-v4.1-flash）

> 日期：2026-11-05。方案：同目录《2026-11-05-设备矩阵自动分发方案（busy位·决策器·auto值）.md》。
> 仓库：`<repo>`（一切改动只在此仓）。

## 〇、你要做什么（一段话）

`ts/apps/server` 里已有"点名派活"（`delegate` 工具带 `targetDevice`，经中继投到目标机）。
给它加第三态：`targetDevice: "auto"` 时**自动挑一台**在线、有能力位（`capabilities` 含
`matrix`）、非手机、未满载的远端电脑；挑不出就落本机执行并在返回文本里写明原因。
总开关 `DEVICE_AUTO_DISPATCH`，**默认关**（关时 `"auto"` 按非法参数拒绝）。

## 一、开工前必读（按序，别跳）

1. `AGENTS.md`（仓库根）——硬约束：新通道要过闸门、回滚开关一行 env、密钥纪律、对外 id uuid；
2. `docs/设计方案/2026-11-05-设备矩阵自动分发方案（busy位·决策器·auto值）.md`——本任务书的依据；
3. 现有实现（读这三个文件再动手）：
   - `ts/apps/server/src/relay-matrix.ts` —— `dispatchRemoteDelegation`（点名派活全链路）；
   - `ts/apps/server/src/relay-channels.ts` —— 通道白名单与处理（`delegation/accept|status` 在这）；
   - `ts/apps/server/src/tools.ts` —— delegate 工具的 `targetDevice` 远程分支（搜 `targetDevice`）。

## 二、改动清单（按序做，每步做完 typecheck）

### 1. 新文件 `ts/apps/server/src/relay-auto.ts`

```ts
export interface AutoPickInput {
  devices: RelayDeviceView[];      // 来自 shared 契约
  selfDeviceId: string;
  busyMap: Record<string, number>; // 设备id → 在跑单数
  maxActivePerDevice: number;      // 来自 env DEVICE_MAX_ACTIVE_PER_DEVICE，默认 3
}
export type AutoPickResult =
  | { picked: string; busy: number }
  | { fallback: "local"; reason: "no_candidate" | "all_busy" };
export function selectAutoDevice(input: AutoPickInput): AutoPickResult;
```

规则（**纯函数、决策确定性**）：
- 过滤：`online === true` && `capabilities` 含 `"matrix"` && `id !== selfDeviceId` &&
  platform 不含 `android`/`ios`（手机）；
- 排序：busy 升序 → `lastSeenAt` 新者优先（undefined 当 0）→ id 字典序；
- 剔除 busy ≥ maxActivePerDevice；全剔除 → `all_busy`；零候选 → `no_candidate`；
- **同输入同输出**（并列必须由 tie-break 收敛），这是可测性的硬要求。

再加 `queryBusyMap(client, devices, timeoutMs)`：并发对每台候选 invoke 新通道
`delegation/busy`，成功取 `result.active`；**任何失败（超时/错误帧/离线）该机记 1**
（宁可低估忙碌，不把活派给查无响应的机器）。

### 2. `ts/apps/server/src/relay-channels.ts`

- `RELAY_MATRIX_CHANNELS` 加 `"delegation/busy"`；
- handler：读**本机** `DelegationReceipts`（`receiptsOf` 模式已在 relay-matrix.ts 有先例），
  返回 `{ active: <非终态单计数> }`。非终态 = outcome 是 `accepting` 或 `accepted`。

### 3. `ts/apps/server/src/relay-matrix.ts`

`dispatchRemoteDelegation`：`input.targetDeviceId === "auto"` 时——
1. `await client.refreshDevices()`（已有方法）；
2. `selectAutoDevice` + `queryBusyMap`；
3. `picked` → 按现有点名路径继续（后续代码不动）；
4. `fallback` → 返回 `{ fallbackToLocal: true, reason }`（不抛错）；
5. 台账 `RemoteRow` 加可选字段 `pickedBy?: "explicit" | "auto"` 与 `pickReason?: string`
   （JSON 文件存储，加可选字段零迁移）。

### 4. `ts/apps/server/src/tools.ts` delegate 工具

- `targetDevice` 参数描述补一句：`"auto" = 电脑自己挑一台（DEVICE_AUTO_DISPATCH 开启时）`；
- 远程分支开头：`"auto"` 且开关关 → 返回 `{"ok":false,"error":"auto_disabled"}`（400 语义的文本）；
- 开关开 → 调改造后的 dispatch；`fallbackToLocal` 时**继续走本机派活路径**（把 targetDevice
  视为未传），并在返回文本前缀一行说明：「自动挑机未成（原因），已在本机执行」。

### 5. `ts/apps/server/src/index.ts` 与 `relay-mobile-proxy.ts`

- 两处 HTTP 端点同样支持 `"auto"`：开关关 → 400 `auto_disabled`；fallback → 200/202 带
  `{ fallbackToLocal: true, reason }`（不要 502——这不是失败，是决策结果）；
- `relay-config.ts` 加 `deviceAutoDispatchEnabled(env)`，默认 false；
  `DEVICE_MAX_ACTIVE_PER_DEVICE` 解析（非法值回落 3）。

### 6. 测试（必须写）

- `ts/apps/server/src/relay-auto.test.ts`：selectAutoDevice 全分支（零候选 / 在线过滤 /
  手机过滤 / busy 排序 / lastSeenAt tie-break / id tie-break / 满载剔除 / 全满载）+
  queryBusyMap 容错（替身 client，一半超时一半成功）；
- `relay-matrix` 台账新字段可选性断言（旧行无新字段仍可读）。

### 7. 探针扩展 `ts/apps/server/scripts/matrix-probe.ts`

加三场景（沿用现有 startRelay/startHarness 骨架，不重构）：
- 两台在线，A 用 `"auto"` 派 → 202 且台账 `pickedBy: "auto"`；
- 只留本机（把远端配对全撤销或杀掉）→ `"auto"` fallback 本机，返回文本含 fallback 原因；
- `DEVICE_AUTO_DISPATCH` 未设 → `"auto"` 返回 `auto_disabled`。

## 三、验收标准（我做，你要自检到能过）

1. `cd ts && pnpm typecheck` 零错；
2. `pnpm --filter @lifediary/server test` 全绿（含你的新测试）；
3. `pnpm --filter @lifediary/server matrix` 探针含三新场景全过；
4. 硬约束自查：新通道过了白名单；`"auto"` 不改"不填=本机"的现状；开关关时零行为变化；
   决策函数无 IO（busy 查询独立于决策）。

## 四、纪律

- **只改本任务书列出的文件**；发现别的文件"顺手也想改"时停下，写进结果汇报，不要动；
- 注释风格贴着周围代码（该密的密：决策器的确定性 tie-break 必须注释为什么）；
- 不引入新依赖；`import` 只用仓内已有模块与 `@lifediary/shared`；
- 中文注释；汇报里写清"改了什么、验了什么、没验什么"。

## 五、完成后输出

在仓库根写 `docs/变更记录/2026-11-05-设备矩阵自动分发（CodeBuddy实施）.md`：
背景 / 改动清单 / 验证结果（命令+输出摘录）/ 回滚说明。
