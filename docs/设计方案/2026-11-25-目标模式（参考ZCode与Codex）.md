# 目标模式（参考 ZCode 与 Codex）

> **状态：已落地 2026-11-25**（方案 B：显式启动的续跑 + 确定性结算，不设裁判轮；`GOAL_MODE` 默认关）。
> 落地记录见 `变更记录/2026-11-25-目标模式.md`；落地时相对本文的几处细化集中在文末「落地补记」。
>
> | 内容 | 长期落点（落地后下沉） |
> |---|---|
> | 状态机与结算规则、与 D13 的关系 | `基线文档/系统架构.md` §7（决策表 + 已知边界） |
> | 端点与字段 | `基线文档/接口-端点4-执事例行与自主轮.md` §2.11 |
> | 环境变量 | `基线文档/接口文档.md` §6 |
> | 落地记录 | `变更记录/2026-11-25-目标模式.md` |
>
> 冲突以长期文档为准。取证报告（证据清单 + 未决问题）在
> `.box-agent-scratch/reports/2026-11-25-goal-mode-research.md`（不入库）。

## 0. 结论先行

1. **我们现在的"目标"只是一行文本。** `partners.current_goal` 每轮以 `【当前目标】` 注入一次，
   除此之外没有任何代码读它——没有状态、没有推进、没有结算（2026-11-25 全量 grep 核对，见 §1）。
2. **ZCode 与 Codex 的目标都是"会话级任务"，我们的是"岗位级方向"。** 两家都是一会话一目标、
   目标跟着会话走；我们的目标挂在执事人格上、跨会话常驻（例文案本身就是"这个月先不碰其他需求"这种方向）。
   这个差别决定了不能照抄任何一家的完成判定。
3. **两家真正的防空转手段都是确定性的代码规则，不是模型自觉。** ZCode：校验器自己失败就不续跑；
   Codex：连续 3 个"自动轮且无任何工具活动"判阻塞。原对比表对 Codex 这条描述不准，见 §2.3。
4. **推荐方案 B：显式启动的续跑 + 确定性结算，不设裁判轮。** 完成由执行方自报（沿用例行任务
   `[[routine-done]]` 的既有约定），宿主只管三件硬闸：轮数上限、零工具连击、暂停恢复。
5. **需要你拍板一件事**（§4）：ZCode 式"每轮再发一次无工具请求判完成"与本仓 D13（2026-11-19 删除
   验收层）和拒绝概念表里"常驻 `/goal` 每空闲判一次"直接冲突。推荐方案不碰这条，所以不需要翻案；
   如果你想要方案 C，得先明确推翻 D13。

## 1. 现状（我们，2026-11-25 核对）

行号基于当前工作区（含未提交改动）。

| 事实 | 位置 |
|---|---|
| 存储：`partners.current_goal TEXT`，缺列时迁移补列 | `ts/apps/server/src/partner-store.ts:46`、`:153-154` |
| 写入：一条 UPDATE，只写目标与 `updated_at`，不 bump 身份版本 | `partner-store.ts:412-423` |
| 类型：`currentGoal: string \| null`，"不版本化，只进 detail 端点与 PATCH" | `partner-types.ts:43-48` |
| 校验：trim 后 ≤ 1000 字（`PARTNER_GOAL_LIMIT`），空串 = 清除 | `companion-api.ts:103`、`:888-902`、`:974-975` |
| 注入：有目标才出 `【当前目标】` 一段，空 = 整段省略 | `agent/partner-context.ts:397-409` |
| 加号菜单「新建目标」→ PATCH `currentGoal`；只有总管 / 执事会话有目标位 | `web/plus-menu.js:77-88`、`:107-113`、`:161-164` |
| 执事档案「岗位」卡的当前目标编辑弹层 → 同一个 PATCH | `web/partner-profile.js:59`、`:713-757`、`:3141-3142` |
| 列表投影不带 `currentGoal`（探针断言守着） | `ts/apps/server/scripts/http-probe.ts:3380-3381` |
| `currentGoal` 不在 shared 契约里（shared 只在 `index.ts:1339` 有 `tagline` 一类的投影字段） | `ts/packages/shared/src/index.ts`（全文件 grep 无命中） |

**没有任何推进 / 结算机制的依据**：对 `ts/apps/server/src` 与 `ts/packages/shared/src` 做不分大小写的
`currentGoal|current_goal` 检索（排除测试），非测试命中只有上表的存储、行映射、端点、注入、导出五类
（`partner-rows.ts:85-88`、`export-bundle-collect-conversations.ts:276` 是上表没列的两处）。

**一处文案与实现不符**：加号菜单的悬停说明写"后续派活、进度和结果都记在它下面"
（`web/plus-menu.js:85`），但没有任何代码把派活、进度、结果与目标关联。弹层正文"保存后每轮都会
带上，下一轮起生效"（`:133`）是准确的。

**已经存在、可直接复用的相邻机制**：

| 机制 | 口径 | 位置 |
|---|---|---|
| 例行任务完成条件 | `until.note` 一句文字条件；模型判断达成后在回复末行写 `[[routine-done]]`，服务端置停规则 | `接口-端点4:490-493`；`routines.ts:469`、`:805` |
| 例行任务轮数上限 | `maxRuns`（`ends.after` 是别名），跑满即停 | `接口-端点4:493`；`routines.ts:757-758` |
| 工人自主续行 | `WORKER_TURN_BUDGET` 默认 3；连续 3 个续行轮零工具调用强制停 | `ts/packages/chancellor/src/worker-continue.ts:9-11`、`:27`、`:49-65` |
| 工具调用计数 | 只认 `toolResult` 角色条目 | `worker-continue.ts:129-143` |
| 自主轮标记 | 进程内 Set，按会话；C2 风险判定读它 | `autonomy-state.ts:1-31`；`agent/lifecycle-harness.ts:842` |
| 忙时退避 | `runPartnerTurn` 的 autonomous 标记是会话级的，所以忙时退避而不排队 | `delegation-wake.ts:14` |
| 例行规则串行 | 每规则一条 lane，上一轮没跑完下一次 deferred | `routines.ts:217-220`、`:635-671`；`接口-端点4:463` |
| 重启不重放 | 重启时 running 一律记 interrupted，不自动重放 | `routines.ts:503-505`；`接口-端点4:464` |
| 小模型一次性判断 | 例行触发器 `if` 用独立 `completeSimple` 调用，走 `AUX_MODEL_REVIEW`，失败即跳过 | `接口-端点4:499-504` |
| 流里已有的信号 | `tool`（start/end 成对）与 `done.usage`（读不到就不带） | `ts/packages/shared/src/index.ts:574-592` |

**缺口**：`runPartnerTurn` 的返回值只有正文、quiet、工具报错、跳过清单
（`partner-runtime-run-partner-turn.ts:315-333`），不带工具调用数，也不带 token 用量——结算需要的两个数
现在拿不到，但流里有（见上表末行）。

## 2. 参考实现的事实

路径前缀：`Z/` = `D:\Projects\reference\ZCode\apps\zcode-cli\packages`，`C/` = `D:\Projects\reference\codex\codex-rs`。
均为 2026-11-25 只读核对。标「推断」的是我的判断，不是代码里写的。

### 2.1 ZCode（内部叫 target / goal，一会话一目标）

| 维度 | 事实 | 位置 |
|---|---|---|
| 数据 | `session_target` 表，状态四值 `active / paused / budget_limited / complete`；字段含 `objective`、`tokenBudget`、`tokensUsed`、`timeUsedSeconds`、活跃轮标记 | `Z/adapters/src/storage/session-store/migrations.ts:197`；`Z/contracts/src/tools/target.ts:9-14`、`:46-63` |
| 目标上限 | `objective` ≤ 4000 字符 | `Z/contracts/src/tools/target.ts:18`、`:37-44` |
| 续跑触发 | 三种入口：普通用户消息后、后台任务通知后、`/goal` 创建后的首次续跑；前两种先校验再续，第三种首轮不校验 | `D:\Projects\reference\ZCode\apps\zcode-cli\docs\design\v2\loop\runtime-active-target-loop-plan.md:67-69`；`Z/core/src/runtime/methods/target-continuation-loop.ts:65`、`:96` |
| 续跑条件 | 非计划模式、无在跑轮、会话已落盘、目标 `status === "active"`；队列里有待处理命令就让位 | `target.ts:189-201`；`target-continuation-loop.ts:71-73` |
| 完成判定 | 轮末另发一次请求：读完整历史、`tools: []`、要求只回 `{"passed","reason","nextAction"}`；用的是会话当前默认模型 | `Z/core/src/runtime/methods/target-completion-verification.ts:100-103`、`:137-145`；`target.ts:196-245` |
| 校验失败处置 | 校验器试图调工具 → 按"通过"处理；请求报错 / 坏 JSON → 也按"通过"处理（代码注释称 fail-open）；**但没给出 `nextAction` 时不续跑** | `target-completion-verification.ts:202-207`、`:264-294`；`target.ts:116-127`、`:313-330` |
| 校验可关 | 配置项 `targetCompletionVerification.enabled`，关了返回 null | `Z/core/src/runtime/types.ts:149`；`target-completion-verification.ts:49` |
| 续跑轮形态 | 作为一次对模型可见、对用户不可见的轮次提交（`inputSource: "goal-continuation"`、`inputVisibility: "model-only"`）；续跑前重读目标状态，变了就不续 | `target.ts:128-145`、`:167-178` |
| 预算 | 轮末记账 SQL 里判：`status='active'` 且 `tokens_used + 本轮 >= token_budget` → `budget_limited` | `Z/adapters/src/storage/session-target.ts:262-282` |
| 预算入口 | 门面层支持 `tokenBudget`；但已检索的入口 `/goal` 建目标时只传 `objective` 与 `status` | `Z/bootstrap/src/app/session-facade.ts:187-222`；`Z/cli/src/command-center/handlers/goal.ts:85` |
| 暂停 | 用户 Stop 取消当前轮 → 目标置 `paused`；校验请求被打断时同样置 `paused` | `Z/core/src/runtime/methods/turn.ts:1062-1063`；`target.ts:385-419`；`target-completion-verification.ts:236-263` |
| 恢复 | 命令有 pause / resume / clear；冷恢复不把 paused 自动改回 active，必须显式 resume | `goal.ts:38-61`；`target.ts:421-431` |
| 后台任务在跑 | 有后台任务时推迟校验（不推迟首轮手动续跑） | `target.ts:85-97` |

**推断**：校验器没有工具，证据只有对话（`target.ts:238-241` 明写"用校验请求之前的对话上下文作证据源"），
它无法去看文件是否真的落了。这是对比表里"已核对的实现仍可能继续给下一步"的结构性来源。

**没找到**：ZCode 里没有"续跑轮无工具调用 → 抑制下次续跑"这类规则（检索词 `no tool / idle / suppress`，
范围 `Z/core/src`、`Z/contracts/src` 非测试文件）。

### 2.2 Codex（goal 是个扩展，一线程一目标）

| 维度 | 事实 | 位置 |
|---|---|---|
| 数据 | `thread_goals` 表，`thread_id` 为主键；状态六值 `active / paused / blocked / usage_limited / budget_limited / complete`；终态只有 `budget_limited` 与 `complete` | `C/state/src/model/thread_goal.rs:12-21`、`:35-42`、`:60-71`；迁移 `C/state/migrations/0029`、`0033`、`0034`，`C/state/goals_migrations/0001`、`0002` |
| 对外协议 | `ThreadGoalSetParams`：`objective`、`status`、`token_budget`（可显式传 null 清除）、`origin`（用户 / 自动） | `C/app-server-protocol/src/protocol/v2/thread.rs:858-867`、`:908-933` |
| 持久化入口 | app-server 有 set / get / clear；临时线程不支持目标 | `C/app-server/src/request_processors/thread_goal_processor.rs:60`、`:70`、`:79`、`:323-334` |
| 续跑触发 | 线程空闲钩子里调 `continue_if_idle`：目标非 active 就清活跃标记并返回；否则 `start_turn_if_idle` 起一轮，被拒或提交失败只记日志 | `C/ext/goal/src/extension.rs:179-202`；`runtime.rs:434-531` |
| 完成判定 | 执行模型自己调 `update_goal(status="complete")`；提示词要求先做完成审计（逐项找文件 / 命令输出 / 测试结果等证据） | `C/ext/goal/src/spec.rs:72-83`；`templates/goals/continuation.md:31-42` |
| 工具权限 | `update_goal` 只能置 `complete / blocked / paused`，不能 resume、不能置 budget_limited；`paused` 须用户明确要求 | `C/ext/goal/src/tool.rs:271-275`；`spec.rs:60-70` |
| 阻塞 | 提示词层：同一阻塞连续 ≥ 3 个目标轮且无用户介入就无法推进才置 `blocked`；resume 后重新计数 | `continuation.md:44-50`；`spec.rs:77-79` |
| 空转（代码层） | "自动轮 且 本轮无任何工具活动 且（末条回复为空 或 本轮被打断）"连续 ≥ 3 → `blocked`；任何工具调用都清零 | `C/ext/goal/src/accounting.rs:121-153`、`:229-246`；`runtime.rs:322-333` |
| 其他停因 | 轮内报错 → `blocked`（防压缩错误等循环烧 token）；额度用尽 → `usage_limited`；连续执行失败 → `blocked` | `extension.rs:422-447`；`runtime.rs:313-339` |
| 预算 | `token_budget` 可选，另有配置上限 `max_goal_token_budget`；记账后超限 → `budget_limited`，并向在跑的轮注入一条"收尾、别开新活"的提示 | `tool.rs:219-220`、`:447-459`；`extension.rs:540-550`；`templates/goals/budget_limit.md:14` |
| 恢复语义 | 请求置 `active` 但已用 token 仍 ≥ 预算 → 仍是 `budget_limited`；已是 `budget_limited` 时请求 paused / blocked 不生效 | `C/state/src/runtime/goals.rs:287-322` |
| 改目标文本 | 同一目标改 `objective`：向在跑的轮注入一条"目标已更新"，用量不清零 | `runtime.rs:220-238` |
| 续跑提示词 | 带已用 / 预算 / 剩余三个数；目标正文以"不可信上下文"附带 | `C/ext/goal/src/steering.rs:59-70`、`:79-104` |

### 2.3 原对比表需要校正的地方

| 原表说法 | 代码实际 |
|---|---|
| Codex「续跑轮没有工具调用 → 抑制下次自动续跑」 | 不是一次就抑制。要同时满足"自动轮 + 无任何工具活动 + 末条回复为空或被打断"，且**连续 3 次**才置 `blocked`（`accounting.rs:229-246`）。只回复文字、没调工具但末条非空的轮**不算**空转。 |
| ZCode「已核对的实现仍可能继续给下一步」 | 成立，且代码里另有一道你没列的闸：校验器失败且没给 `nextAction` 时不续跑（`target.ts:116-127`）。空转来自校验器"自信地给错下一步"，不是来自没有闸。 |
| ZCode「有预算字段，但公开入口未传入」 | 在已检索范围内成立（`goal.ts:85`）。`Z/packages/desktop`、`Z/packages/ui` 没查，不能说"所有入口都没传"。 |
| ZCode「停止会暂停，保留轮次和产物」 | 成立（`turn.ts:1062-1063`）。补充：冷恢复也不会自动转回 active（`target.ts:421-431`）。 |
| Codex「执行模型依据文件、测试、日志等证据判断」 | 成立，但这是**提示词要求**，宿主不核验证据是否真的看过（`continuation.md:31-42`）。 |

## 3. 机制对照

| 维度 | ZCode | Codex | 我们（现状） |
|---|---|---|---|
| 目标归属 | 会话（`session_target`） | 线程（`thread_goals`） | 执事人格（`partners.current_goal`），跨会话常驻 |
| 怎么持续推进 | 轮末校验 → 未过则带 `nextAction` 续跑 | 线程空闲且 active → 起一轮 | 无 |
| 谁判断完成 | 另一次无工具请求读对话 | 执行模型调 `update_goal` | 无 |
| 做不到怎么办 | 校验器写"最小解困步骤"进 `nextAction`，目标保持 active | 3 轮同一阻塞 → `blocked`，等人 | 无 |
| 防空转 | 校验器失败无 `nextAction` → 不续跑 | 自动轮零活动连续 3 次 → `blocked` | 无（例行的 `maxRuns` 与工人的续行保险丝只管各自那条线） |
| 限开销 | `tokenBudget`（入口未传） | `token_budget` + 配置上限 | 无 |
| 暂停恢复 | Stop 即暂停；显式 resume；可 clear | 六态；可暂停 / 恢复 / 编辑 / 清除，落库 | 只有"设 / 清"两个动作 |

## 4. 动手前必须先对齐：本仓已有一条相反的决定

- **D13**（`系统架构.md:194`）：2026-11-19 验收层整体删除——"验收快照、文件变更比对、返工轮、证据裁判全部退役"，
  理由写的是"宿主验收的负面效果（误判阻塞、返工循环、快照成本）"，口径是"自报即终局，语义验收交回 Agent"。
- **拒绝概念表**（`系统架构.md:1050`）：「常驻 `/goal` 每空闲判一次——我们没有长跑目标会话，收益 < 成本；
  2026-11-19 起连"派单收尾时判一次"也没有了」。
- **同表相邻口径**：「静默自动轮 = 意外账单」（`系统架构.md:900`、`:1044`）。

ZCode 式完成判定就是"每轮空闲再判一次"的裁判轮，落在这条拒绝记录的正中。按 AGENTS.md
"看着别扭的设计往往有没写下来的约束"，这里约束是写下来的，所以：

- 方案 A、B 都不引入裁判轮，**不需要动 D13**；
- 方案 C 需要 ZCode 式校验器，**必须先由你明确推翻 `系统架构.md:1050` 那一行**，并在 D13 旁补一条翻案记录
  （说清与已删除的"证据裁判"为什么不重蹈"误判阻塞、返工循环"）。

另有一处前提变了，值得你知道：拒绝理由之一是"我们没有长跑目标会话"。现在加了「新建目标」入口之后，
用户预期已经有了（悬停文案还写了"进度和结果都记在它下面"）。前提是否还成立，是你判断，不是我在这里改。

## 5. 三个方案

| | A 最小可用 | B 中等（推荐） | C 完整 |
|---|---|---|---|
| 目标状态 | 三态 `paused / active / done`，全部由用户点 | 四态 `active / paused / budget_limited / done` + 原因字段 | 同 B，另加独立 `blocked`，阻塞升级给用户 |
| 持续推进 | 无自动续跑；「继续」按钮发一条续跑消息（同一会话） | 轮末结算通过 → 自动续跑一轮；有轮数上限 | 同 B |
| 完成判定 | 用户点「标记完成」 | 执行方回复末行写 `[[goal-done]]`；用户也可手动标记 | B + 可选校验器（ZCode 式，需翻 D13） |
| 防空转 | 不适用（没有自动轮） | 续跑轮零工具调用连续 3 次 → 暂停 | B + 阻塞审计 |
| 预算 | 无 | 续跑轮数上限（硬闸）+ 可选 token 预算 | 同 B |
| 暂停恢复编辑清除 | 暂停 / 完成 / 清除 | 全有，落库，重启不续 | 全有 |
| 新增请求开销 | 0 | 仅在目标 active 时每轮多一次模型调用（就是续跑那轮本身） | 每轮额外 +1 次校验请求 |
| 契约改动 | 详情加 1 个状态字段 | 详情加状态对象 + 1 个动作端点 | B + SSE 事件 + 可能进 shared |
| 能交付「持续推进」 | 否 | 是 | 是，且对"做不到"有交代 |

## 6. 推荐与取舍

**推荐 B，默认关，显式启动。**

- 为什么不是 A：A 解决不了你要的"持续推进"，只是把文本字段换成带状态的文本字段。
- 为什么不是 C：校验器与 D13 冲突（§4）；每轮多一次全历史请求，对单人自用是实打实的成本；
  ZCode 的空转案例说明校验器"读对话判完成"本身就不可靠，加了它并不会让"做不到"这件事变好。
- 为什么自报完成可以接受：这是本仓现行口径（D13"自报即终局"；例行 `[[routine-done]]` 从 2026-11-10
  用到现在）。目标模式的风险由确定性硬闸兜：轮数上限保证最坏开销有界，零工具连击保证不会原地打转。
- 代价要说清：目标会被过早标成 done（模型说完成就完成）。补救是"完成可撤销"——done 之后保留一键
  「没完成，继续」，回到 active 且连击清零。

三个我替你做了、但你可以改的默认：

| 默认 | 取值 | 理由 |
|---|---|---|
| 新建目标后是否自动开跑 | **不自动**，状态为 `paused`，点「开始推进」才 active | ZCode / Codex 都是建完即跑；但本仓口径是"静默自动轮 = 意外账单"，且用户的输入框草稿会被当默认目标（`plus-menu.js:126`、`:151`），误建率不低 |
| 续跑轮的身份 | `authority: "autonomous"` | 用户不在场，高危工具应过 C2 审批而不是直接放行 |
| 零工具连击阈值 | 3，复用工人续行的同一个数 | 一个概念一个数；worker-continue 已有纯函数与单测形态可照搬 |

## 7. 方案 B 细化

### 7.1 数据

目标正文仍是 `partners.current_goal`（唯一文本事实源，注入逻辑不动）。新增一张状态表，只存状态，一个执事最多一行：

`partner_goals(partner_id 主键, status, reason, rounds_used, max_rounds, token_budget 可空, tokens_used, no_progress_streak, updated_at)`

- 清除目标 = 删这一行 + `current_goal` 置空（同一个事务）。
- 为什么不往 `partners` 加列：目标"不是身份、不版本化"（`partner-store.ts:415`），而状态有自己的生命周期；
  分表后导出包（现不带目标，`docs/员工模板-我的执事.md:121`）不用改。
- 为什么不把正文搬进新表：会让 PATCH、导出、行映射、探针一起动，换不来东西。

### 7.2 状态机

| 当前 | 事件 | 下一个 | 附带 |
|---|---|---|---|
| （无） | 新建目标 | `paused` | reason = `not_started` |
| 任意 | 清除目标 | （无） | 删行 |
| `paused` / `budget_limited` | 用户点开始 / 继续 | `active` | 连击清零；可同时上调轮数上限 / token 预算，不上调则下一次结算又回到 `budget_limited`（与 Codex `goals.rs:294-297` 同向） |
| `active` | 用户点暂停 | `paused` | reason = `user` |
| `active` | 用户 Stop 中断目标轮 | `paused` | reason = `stopped` |
| `active` | 回复末行 `[[goal-done]]` | `done` | reason = `self_report` |
| `active` | 续跑轮零工具调用，连击 ≥ 3 | `paused` | reason = `no_progress` |
| `active` | `rounds_used ≥ max_rounds` | `budget_limited` | reason = `rounds` |
| `active` | `tokens_used ≥ token_budget`（设了才有） | `budget_limited` | reason = `tokens` |
| `done` | 用户点「没完成，继续」 | `active` | 连击清零 |

`blocked` 不单独设状态：执行方写 `[[goal-blocked: 一句话]]` → `paused` + reason = `blocked`。它和"用户自己
暂停"在"要不要人来"上不同，但处理方式相同（都是等人、都显式恢复），用原因字段区分即可，对外枚举少一个。

### 7.3 结算规则（每轮收尾时，顺序固定）

| 序 | 判断 | 不通过则 |
|---|---|---|
| 1 | 目标存在且 `status === "active"` | 结束 |
| 2 | 本轮末行有 `[[goal-done]]` / `[[goal-blocked:…]]` | 置 done / paused，结束 |
| 3 | 记账：`rounds_used +1`；`tokens_used += done.usage`（读不到就不加，只记一条枚举日志） | — |
| 4 | `rounds_used ≥ max_rounds`，或设了预算且 `tokens_used ≥ token_budget` | 置 `budget_limited`，结束 |
| 5 | 本轮工具调用数：> 0 → 连击清零；= 0 且**本轮是续跑轮** → 连击 +1 | 连击 ≥ 3 → 置 `paused(no_progress)`，结束 |
| 6 | 会话忙 / 有待批审批 / 进程正在退出 | 不排续跑，状态不变，等下一个轮末再结算 |
| 7 | 以上都过 | 排一次续跑 |

说明：

- **首次（用户亲手发起的）那一轮不计零工具连击**——用户可能只是问一句"你觉得这目标怎么拆"，那是正常对话。
  Codex 同样只数自动轮（`accounting.rs:235-238`）。
- **续跑是 durable 任务，不是进程内循环**：到点走 `runPartnerTurn` 同一条路；重启后在飞的续跑按例行任务口径
  记 interrupted、不自动重放（`接口-端点4:464`）。最坏情况是重启后目标停在 active 但没人推——用户点一次
  「继续」即可，不做启动时自动恢复。
- 续跑提示词只追加在那一轮的尾部（与 `ROUTINE_QUIET_INSTRUCTION` 同一位置，`partner-runtime-run-partner-turn.ts:363-367`），
  **不进固定前缀**：不动系统提示词，非目标轮的缓存前缀一字不变。内容三件事：目标正文（标为用户数据）、
  已用轮数 / 上限、末行标记的三种写法。

### 7.4 与工具循环的耦合点

| 位置 | 要接的东西 |
|---|---|
| 主对话轮收尾（发 `done` 处）`ts/apps/server/src/index.ts:1951-1956` | 调结算；从这里能看到 `turnUsage` |
| 执事轮收尾 `partner-runtime-run-partner-turn.ts:444-491` | 调结算；需要从流里累计 `tool start` 次数与 `done.usage` 并带进返回值 |
| 自主轮标记 `autonomy-state.ts:20-23` | 续跑轮登记为 autonomous（C2 判定才认） |
| 忙时退避 `delegation-wake.ts:14` | 续跑排期沿用"忙则退避"的口径，不另造排队 |
| 中断钩子（Stop） | 置 `paused(stopped)`——服务端能否观察到用户 Stop **没验证**，见 §10 |

### 7.5 契约与模块

| 改什么 | 哪里 | 说明 |
|---|---|---|
| 详情多一个 `goal` 对象 | `companion-api.ts` 详情端点（`:503` 一带） | `{status, reason, roundsUsed, maxRounds, tokensUsed, tokenBudget}` 或 `null`；列表投影不带（同 `currentGoal` 口径） |
| 一个动作端点 | 新路由 | `{action: start \| pause \| resume \| clear \| reopen, maxRounds?, tokenBudget?}`；业务拒绝 400 带说明，鉴权失败 403 空体 |
| 状态存取 | `partner-store.ts` 旁新增一个 store | 一张表、一组方法；结算判定写成纯函数（照 `worker-continue.ts` 的形态） |
| 前端 | `web/plus-menu.js`、`web/partner-profile.js` | 弹层加状态行与三个按钮；**改掉 `plus-menu.js:85` 的悬停文案** |
| 文档 | `接口-端点4` §2.11、`接口文档` §6、`系统架构` §7、`变更记录` | 按 `接口文档.md:371-374`：先改文档，再改代码 |

**是否进 shared**：`currentGoal` 现在不在 shared 里（服务端本地契约，手机端不消费）。B 的字段沿用这个口径，
先不进 shared、手机端不动。只有当你要求手机端也显示目标状态、或要新增 SSE 事件时才进 shared 并同步手机仓。

### 7.6 开关

| 开关 | 默认 | 关掉时 |
|---|---|---|
| `GOAL_MODE` | 关 | 不结算、不排续跑、动作端点 404、界面不出状态行；目标回到"只是一行文本"；状态表保留 |
| `GOAL_MAX_ROUNDS` | 10 | 单个目标续跑轮数上限的缺省值（没经真实使用校准，见 §10） |

回滚 = 一个 env，不改代码。

## 8. 明确不做

- **裁判轮**（每轮再发无工具请求判完成）——D13 未翻案前不做。
- **多目标并存、目标历史页**——一个执事同一时刻一个目标。
- **目标跨副会话推进**——只在总管主会话 / 执事主会话结算。
- **空闲时常驻检查**（没有轮次也定时看一眼要不要续）——这正是 `系统架构.md:1050` 拒绝的形态。
- **把派活、进度、结果记到目标下面**——悬停文案提了但从未实现；要做单独立项，不夹在这里。
- **手机端目标状态界面**——见 §7.5。
- **按目标选模型、按目标配权限档**——同 `系统架构.md:1038`、`:1040` 的口径。
- **重启后自动恢复续跑**。
- **只靠 token 预算限开销**——`done.usage` 读不到就不带（`shared/src/index.ts:592`），预算必须有一条不依赖用量的硬闸。
- **顺手改例行任务与工人续行的任何口径**——只复用常数与形态。

## 9. 验证计划（落地时按此跑，没跑的如实写）

- 任意 TS → `pnpm typecheck`
- 新端点与详情字段 → `pnpm probe` / `pnpm --filter @lifediary/server http`（看输出，不只看 exit code）
- 结算纯函数单测 → `pnpm --filter @lifediary/server test`，至少覆盖 §7.2 每一行与 §7.3 每个序号
- 真模型走查三条：① 首轮零工具不暂停、续跑轮零工具 3 次暂停；② 写 `[[goal-done]]` 即 done，reopen 后能续；
  ③ 跑满轮数进 `budget_limited`，resume 后再跑
- 回滚：`GOAL_MODE=false` 后发一轮普通消息，确认没有续跑、提示词尾部没有目标段

## 10. 未验证与未决问题

**没读到的（写"没验证"，不是"没有"）**

- 服务端能否观察到用户 Stop，以及中断时轮末结算会不会照常跑——中断钩子没读。
- 用户在执事会话里发消息，走的是主对话 SSE 那条路还是别的入口——没读 `index.ts` 的路由分派。
- `agent.ts` 的 `chatStream` 是否把 `tool` 事件与 `done.usage` 原样交给 `runPartnerTurn` 的 `for await`——没读 `chatStream`。
- 审批待答时轮末结算的行为——审批流与 `runPartnerTurn` 的交互没读。
- Codex：谁写入"续跑推迟"标记（`goals.rs:113`）、TUI 里 Esc 中断是否置 paused、记账 SQL 全文——只看了检索命中行。
- ZCode：`Z/packages/desktop`、`Z/packages/ui` 是否有传 `tokenBudget` 的入口；`record_item` 里 `empty_final` 的全部置位条件（这条是 Codex 的，ZCode 对应项无）。

**要你定的**

1. **是否需要裁判轮**（§4）。推荐不要；要的话先翻 D13。
2. **"方向"与"在办目标"要不要拆成两个字段**。现在的文案把目标定位成"这一阵在奔什么"，而这种方向往往没有可判定的完成。
   B 的做法是同一个文本、加一个"开始推进"的动作，用户自己决定哪条值得推进；另一种是另设「在办目标」，
   `currentGoal` 保持纯方向。推荐前者（少一个概念），但如果你发现推起来的目标多数是"持续改进"类，就该拆。
3. **新建后是否自动开跑**。推荐不自动（§6）。
4. **续跑轮算不算自主轮**（过不过 C2 审批）。推荐算。
5. `GOAL_MAX_ROUNDS` 的缺省值 10 是拍的，需要真实用过一轮再定。

## 11. 落地补记（2026-11-25）

落地按 §7 实现；下面是落地时相对 §7 的细化、§10 里已经核实的项、以及仍然没验证的项。
长期口径以 `基线文档/系统架构.md` §7「目标模式」与 `接口-端点4` §2.11 为准，本节只记"当时怎么落的"。

### 11.1 相对 §7 的细化

1. **上限已满时 `resume` 直接 400**，不先进 active 再被结算打回（省一轮模型调用）。
   `maxRounds` / `tokenBudget` 先落、再判状态；两道上限都满要各自上调（`goal-settlement.ts` `planGoalAction`）。
   界面侧对应：`budget_limited` 时那颗按钮自动带上 `maxRounds:+10` 或 `tokenBudget` 翻倍——
   界面里没有别的地方能改上限，不带就只会收到一句"先上调"。
2. **总管的续跑轮跑在 `partner-chief` 执事主会话**，不在首页主对话里。首页主对话只做轮末结算
   （`chatKindOf` 对它返回 `chief`，`goalOwnerOfChat` 归到 `CHIEF_PARTNER_ID`）。这是推断出的形态，没在真模型上走过。
3. **Stop → `paused / stopped` 钩在 `/stop` 端点**（`index.ts`，`stopChat` 之前）。
   首页主对话只在 `streamEnd === "stop"` 时结算；出错或被打断的那一轮不结算，等下一次轮末。
   用户亲手发的那一轮不算续跑轮，所以不记零工具连击。
4. **`rounds_used` 计所有 active 期间结算的轮**（用户亲手发的 + 续跑的），不是只数续跑轮。
   token 口径 = `input + output + cacheRead`，与时间线一致。读不到 usage 就不加，只记一条枚举日志。
5. **`[[goal-blocked: …]]` 的说明文字不入库**，只落 `reason=blocked`。标记从回复里剔掉后才给用户看——
   所以那句话主人看不到，只看到状态行"等你介入才能继续"。（这是个已知的不顺手，见 11.3。）
6. **`partner_goals.updated_at` 兼作续跑任务的 token**：任务醒来时对不上（状态被改过）即作废。
7. **`runPartnerTurn` 的返回值**：目标模式开着时多带 `toolCalls` / `usage`（哪怕目标不在 active）；关着时形状一字不变。
8. **暂停后的恢复全靠显式动作**：`user` / `stopped` / `blocked` / `no_progress` 四种 reason 都不会自己回到 active。
9. **重启不重放靠启动号保证，不靠 durable 的恢复行为**：续跑任务带着排它时的进程启动号
   （`goal-mode.ts` `BOOT_ID`），任务醒来时启动号对不上即作废（`isSameBoot`）。这样 §7.3 那句
   "重启后在飞的续跑不自动重放"由代码成立，不需要知道任务图重启后会不会把没醒的任务接着跑
   （这一点我没验证，也不需要了）。进程退出本身没有专门钩子：全仓没找到退出标志
   （grep `shutting down|isShutdown|shutdownRequested|closing` 无命中，2026-11-25）。
10. **前端共用一个小模块** `web/goal-status.js`（状态文案、按钮判定、请求），加号菜单的目标弹层与
    人设页的当前目标弹层各接一份，避免两处口径写歪。
11. **续跑任务必须登记进 Harness 的任务注册表**（`agent/lifecycle-harness.ts` 的 `tasks` 表）。落地时先漏了：
    任务建得出来、提交也不报错，但不进表就是"缺定义"，排上不会醒。是探针（`pnpm --filter @lifediary/server goal`）
    第一遍跑出来的——单测全绿、typecheck 全过，只有真起服务才看得见。排查中试过"建完任务后再踢一下调度"
    （`conversation.waitForIdle()`），注册表补上后实测**不需要**，已撤掉，没留在代码里。
12. **动作端点的成功响应过同一个投影**：一开始直接回了内部状态行（带 `partnerId` 与 `updatedAt`），
    与文档写的六字段不符；`updatedAt` 兼作续跑 token，不该外发。已改为 `goalView(...)`。

### 11.2 §10 里落地时核实了的

- **Stop 能不能观察到**：能，`/stop` 端点是一处确定的入口。
- **`chatStream` 是否把 `tool` / `usage` 事件交给 `runPartnerTurn`**：事件循环里本来就在读
  `event.type === "tool" && status === "start"` 与 `event.type === "usage"`，结算直接累计这两个事件。

### 11.3 仍然没验证的

- 真模型三条走查（§9）——**没跑，需真机验**。faux 模型下的全链路（真起服务 + 真 HTTP：排 → 醒 → 跑 → 结算）
  已由 `pnpm --filter @lifediary/server goal` 跑通（2026-11-25，34 项全过），但 faux 不调工具、不会写末行标记，
  所以下面这几样它盖不到：`[[goal-done]]` / `[[goal-blocked]]` 在真实回复里是否稳定落在最后一行、
  真实工具调用让连击清零、总管的续跑轮跑在 `partner-chief` 这个推断出的形态。
- `GOAL_MODE=false` 的回滚：开关关时详情 / PATCH 不带 `goal`、动作端点 404、不结算，探针已验；
  "发一轮普通消息、提示词尾部没有目标段"在**真模型**上的手验没跑（目标段只在续跑轮追加，关着时不会排续跑）。
- 用户在执事会话里发消息走哪条路（主对话 SSE 还是别的入口）——没读 `index.ts` 的路由分派，结算入口按"主对话 SSE 一条"接的。
- 审批待答时轮末结算的行为——只做了"有 pending 审批就不跑续跑"这一道，审批流与 `runPartnerTurn` 的交互没读。
- `blocked` 的说明文字被剔掉后主人看不到——要不要留成一条消息，没做，待定。
