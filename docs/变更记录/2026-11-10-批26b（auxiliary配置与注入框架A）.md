# 批 26b 变更记录：auxiliary compact 配置 + 注入框架批 A

日期：2026-11-10
上位：`docs/设计方案/2026-11-10-批26b任务书（auxiliary与注入框架）.md` §一 / §二
状态：已落地（**未 commit**；零 `shared` / 零 chancellor 改动；未碰 `delegation-judge.ts` /
`phone-worker.ts` / `delegation-api.ts` / `pairing.ts` / 总账文件）
影响面：`ts/apps/server/src/agent/{session,injection,lifecycle}.ts`（`injection.ts` 新建）、
`ts/apps/server/src/{auxiliary.test.ts, index.ts}`、`ts/apps/server/src/agent/injection.test.ts`（新建）、
`ts/apps/server/scripts/http-probe.ts`、`ts/apps/server/package.json`（test 清单加一条）、
`docs/基线文档/接口文档.md`

## 一、auxiliary compact（#32 剩余）：配置不静默失效

核对（2026-11-10）：`Conversation.compact(instructions, context)` 无模型参数（批 23b 已确认），
内核不支持指定压缩模型，`startChatCompaction` 没有可转交模型的入口——**这不是漏接，是内核没这个口**。

- 配置解析本就能用：`auxiliaryModel("compact")` 走 `AUX_MODEL_COMPACT` / 回落当前模型 / 跨供应商
  那套现有逻辑，未改 `auxiliary.ts` 一行。
- `startChatCompaction`（`agent/session.ts`）新增一次"未生效"日志：配了 `AUX_MODEL_COMPACT`
  且 `AUX_LLM` 开着时，记
  `[aux] 当前内核不支持指定压缩模型，AUX_MODEL_COMPACT 未生效`。模块级标记 `compactModelIgnoredWarned`
  保证**只记一次、不刷屏**；日志只含用途枚举与变量名，不含对话内容。开关沿用 `AUX_LLM`。
- **压缩调用本身逐字节不变**：仍 `return chat.conversation.compact(instructions, CTX)`。
  `AUX_LLM=false` / 没配 compact 时不记日志。
- 单测（`auxiliary.test.ts`）：新增「compact 用途能解析：配了返回 pin 的模型，没配回落当前模型」。

## 二、注入框架批 A（#7）：建框架 + 审计 + 只接管 injection_guard 一个

### 1. 新建 `agent/injection.ts`

- `InjectionEntry { id, text, order, scope: session|once|turn, channel: system|message }`；
  `InjectionProvider = (ctx) => Entry | Entry[] | undefined`；`InjectionContext { conversationId }`。
- `collectInjections(providers, ctx)`：收集（undefined 忽略、数组摊平）→ 排序（`order` 升序，
  同 `order` 按 `id` 字典序；`order`/`id` 都相同时再按 `channel`/`scope`/`text` 补成全序，
  保证打乱输入顺序输出恒定）→ 按 `id` 去重（后者覆盖：保留规范序里最后一次出现，输出仍有序）
  → 按 `channel` 分流为 `{ system, message }`。
- `guardProvider`：开了 `AGENT_INJECTION_GUARD`（默认开）就产出 `{id:"injection_guard",
  text: INJECTION_GUARD, order:0, scope:"session", channel:"system"}`，关时 `undefined`。
- `INJECTION_REGISTRY`：**只登记 `injection_guard` 一个**（`source` 是审计用的来源标识）。
- `injectionAuditEnabled()`：`AGENT_INJECTION_AUDIT` 默认开，显式 `false` 关。
- `auditInjections(ctx)`：产出 `[{id, source, scope, length}]`，**绝不返回 `text` / 正文**。

### 2. 接管 `injection_guard`（逐字节一致）

- `lifecycle.ts` 的 `injection_guard` section **留在 `sections` 数组原下标**（位置不变，
  prompt cache 前缀不动），`render` 从直返 `INJECTION_GUARD` 改为
  `collectInjections([guardProvider], { conversationId: input.conversationId }).system[0]?.text`。
  取回的是同一段 `INJECTION_GUARD` 实文（内容不变）；关时 `system` 为空 → `undefined`（整段省略，不变）。
- import 收口：`INJECTION_GUARD` / `injectionGuardEnabled` 不再被 lifecycle 直接引用，
  改由 `injection.ts` 持有；`guardRelayDelivery` / `wrapUntrustedObjective` 仍在 lifecycle 用。
- **其余 6 个 section 与 beforeRequest 里 5 处 `extra.push` 一行未动**。
- 硬标准单测（`agent/injection.test.ts`）：
  `collectInjections([guardProvider], ctx).system[0].text === INJECTION_GUARD`。

### 3. 审计端点 `GET /api/v1/agent/chat/:conversationId/injections`

- 参考 `index.ts` 其它 `/chat/:conversationId/*` 写法。返回裸数组 `[{id,source,scope,length}]`，
  不返正文；开关 `AGENT_INJECTION_AUDIT=false` → `404`（一行回滚）。
- `:conversationId` 只作上下文：批 A 的注入是框架级静态清单，不按会话变化，故不解析 durable
  会话、不依赖 LLM 配置、不校验会话存在（诊断端点，非会话数据接口）。
- `http-probe.ts` §4.5 加了真 HTTP 断言：200 / 只一行 / 形状齐 / 无 `text`、无「【材料安全】」实文片段。

### 4. 单测（`agent/injection.test.ts`，9 条）

条目形状（恰好 5 字段）/ 排序稳定（打乱 providers 顺序 `deepEqual`）/ 同 id 去重（后者覆盖，
跨 provider 打乱仍确定）/ 按 channel 分流 / 只接管了一个（`INJECTION_REGISTRY.length===1`、
审计只一行）/ guard 关时省略整段 / 审计不返正文 / 审计开关默认开 +
硬标准逐字节一致。已登记进 `package.json` 的 `test` 清单。

## 验证

- 每完成一节各跑一次 `pnpm typecheck`（0 错）+ `pnpm --filter @lifediary/server test`：
  - §一后：690 条全绿；§二后：**699 条全绿**（新增 1 条 auxiliary compact + 9 条注入框架）。
- `pnpm --filter @lifediary/server http`：**端到端全部通过**（287 个检查、0 失败；
  含本批新增 §4.5 的 4 个审计端点断言）。真起服务 + 真 HTTP，复跑确认注入链路零回归。
- 逐字节一致额外佐证：http 探针里系统提示相关断言（§14.4 当前项目注入等）全绿，
  说明接管没改动 `injection_guard` 之外的任何 section / 额外注入。
- 单跑 `src/agent/injection.test.ts`：9/9 通过，含硬标准。
- 未跑：`pnpm probe`、`memtest`、`providers`、`diary`、`tasks`、`phone`（本批没动这些链路）。

## 已知边界 / 刻意没做

- `compact` 的辅助模型**没做**：内核 `Conversation.compact()` 不收模型，要接得先改 durable 的
  压缩契约（跨仓库）。本批只做到"配置能解析 + 配了但没生效记一条明确日志"，不用旁路拼凑。
- 注入框架**批 A 只接管 `injection_guard` 一个**：其余 6 个 section（persona / 验证铁律 /
  开工前问清 / 当前项目 / 技能索引 / 课题）与 5 处 `extra.push`（记忆 / 技能斜杠 / 恢复注记 /
  工具上限 / 执事轮上下文）仍在原处，未进框架、未进审计。分批接，别一次扩成无法验证的审查面。
- `collectInjections` 的去重"后者覆盖"指**规范序里最后一次出现**（等同 order / 字典序更大者胜出），
  不是"注册更晚的 provider 胜出"——这样"打乱输入顺序输出一致"才无条件成立。
- 审计端点的 `source` 当前与 `id` 同为 `injection_guard`（批 A 只有一个源）；后续批次接别的源时
  `source` 用于区分来源。
- 审计按源逐个 `collectInjections`，批 A 只有一个源故与整表收集等价；跨源去重/排序是后续批次的事。
