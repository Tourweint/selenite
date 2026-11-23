# Agent 全景调研二：核心 harness 对照（ZCode · codex · opencode · DSH · hermes）
> 状态：调研/调查留档（非契约，2026-11-09）。结论已消化进后续批次；现行口径以基线文档为准。


> 2026-11-09。用户口径："主要看大厂的实现方案，人家写得就是比较好，比如 zcode"——并质疑
> "zcode 没有多 Agent 协作，所以效率不算特别高"。本文对五家大厂系 harness 逐仓深挖（全部完成）。
> 已有调研（2026-11-04）覆盖过它们的**运行时模块**（compaction/重试/排队/审批/超时），本文不重复，全部是新角度：
> 多 agent、计划与验收、主动询问、工具工程、UX。**冲突以 `docs/基线文档/` 为准。**

## 〇、人话版结论

1. **"ZCode 没有多 Agent 协作"不属实**（v3.17.2 三套并存：Agent 工具 spawn subagent、agent 间消息
   SendMessage/RespondToCoordinator/steerTurn、Workflow DAG 编排）；但"效率不算特别高"**部分属实**：
   expert 默认并发只有 2、workflow 必须用户显式点名才触发（代码注释明令禁止模型自作主张上工作流）。
   ——我们的 chancellor 派活在"自主派活"上反而更激进（模型可 delegate），ZCode 把编排权留给人是它的保守面。
2. **四家"保证实现"的路线分化**：ZCode=五层纵深（clarify→plan→todo→依赖图→final_critic 循环）；
   **opencode=/goal 证据裁判循环**（"模型自称完成不是证据"，独立 reviewer 模型按目标判 done/continue/blocked/paused）；
   codex=审查式（review 子命令起 one-shot 独立评审 agent，findings 结构化回写）+ Guardian（审批决定外包给隔离模型，
   服务端货，个人 harness 不抄）。**共同点：完成由第三方证据定义，不由执行者自报**——与我们 D13 同哲学，
   他们多出"循环"（不合格自动返工）与"独立评审者"。
3. **结构化提问工具已经行业趋同**（codex request_user_input / opencode question / ZCode AskUserQuestion 三家形态一致）：
   2-3 个互斥选项+推荐项置顶标 "(Recommended)"+自动带自由输入+答案直回工具结果流。我们审批 pending 管线现成，
   加一个 `ask_user` 工具是小工作量——这是"主动式询问"的机械底座。
4. **工具工程三家都远比我们讲究**：ZCode 工具能力声明 13 个结构化字段（权限系统读声明不靠猜）+ schema 是
   缓存前缀资产；opencode subagent 工具描述**动态注入可选角色列表**、派活本身有按 agent 粒度的权限沉淀；
   codex 工具描述自带使用纪律文案。我们 WRITE_TOOLS 是布尔清单——差距明确且可补。
5. **无人值守权限的第三种解法**（opencode `Permission.Unattended`）：无人值守时本应 ask 的请求按专门规则集结算，
   不满足→**显式 deny 带原因，绝不挂起**。比我们的"自主轮一律高危审批"（批次C）和"审批三档"多一个正交轴。

## 一、调研来源（审计日期 2026-11-09）

| 来源 | 是什么 | 深挖方式 |
|---|---|---|
| `<reference>\ZCode`（v3.17.2） | 智谱 AI 编程工作台（桌面+浏览器+终端） | 子智能体 112 次工具调用，报告 300 行：`.research/zcode-deep.md` |
| `<reference>\codex`（2026-11-08 HEAD） | OpenAI Codex CLI（codex-rs/ Rust） | 子智能体报告：`.research/codex-opencode-agents.md` |
| `<reference>\opencode`（2026-11-08 HEAD） | 开源编码 agent（packages/core） | 同上 |
| 旧调研（2026-11-04） | 两仓运行时模块对比矩阵 | 结论引用 |

## 二、ZCode（v3.17.2）

### 2.1 多 Agent 三件套（专项验证）

| 机制 | 内容 | 证据 |
|---|---|---|
| **Agent 工具** | spawn subagent：前台/后台；内置 Explore + general-purpose + `.zcode/agents/*.md` 自定义 profile | `tool/handlers/agent.ts` |
| **agent 间消息** | SendMessage 可**恢复已结束**的子 agent（上下文还在）；RespondToCoordinator 运行中回话；父对子 steerTurn 中途引导 | `tool/handlers/{send-message,respond-to-coordinator}.ts` |
| **Workflow 编排** | DAG 调度器 + 内置 expert 8 阶段定义 + DynamicWorkflow TS 脚本引擎（子 agent 用普通控制流编排） | `packages/core/src/workflow/{definition,scheduler}.ts` |

效率争议的判定：expert 默认 `maxConcurrentLoops=2`、`frontierTarget=3`（definition.ts:20）；**workflow 必须用户显式
点名触发**（agent.ts:111 注释禁止模型自作主张）——编排能力在，但默认路径是"单 agent 前台串行"。
**子 agent 权限红线**（2026-10-31 修复）：内置 Explore 原来固定 yolo，"提示注入后模型可经 Agent(Explore)
免审批执行任意 Bash"——修复后**子 agent 权限必须走父会话判定器**。这条对我们将来启用内核 subagent 是保命条款。

### 2.2 保证实现五层纵深

clarify（confidence<0.8 必问、最多 3 轮、选项带推荐）→ plan mode（闸门只收紧+计划文件落盘）→ todo 提醒注入 →
分解产物是"实现+验证节点"依赖图 → **final_critic 循环 maxIterations=3 自动返工**。
另有无回合上限哲学（turn-loop.ts while(true)，AGENTS.md 明文"不用 tool call 次数做硬停止"）——
它靠条件终止清单（compact/取消/权限拒绝/超时/输出截断/重试上限）兜底；我们的 100 回合护栏是另一种哲学，
**它的"条件终止清单"值得对照补齐我们的终止条件覆盖面**。

### 2.3 骨架级发明：system-reminder 持久化附件框架

所有运行时注入（todo/plan 退出/模式/输出风格/工具增量/agent 名单/记忆更新）统一为**持久化 attachment entry**：
source 标记去重、先落盘再提交、resume 后前缀不变（turn-loop.ts:257-364 每条注入都带"修复原因"注释）。
→ 对我们的直译：记忆注入/课题推送/身份标记/审批状态目前是散落的字符串拼接（assist.ts/settled.ts 各一处），
统一成"注入条目"框架是 L 级工程，收益是**注入可审计、可去重、resume 稳定**（详见系列七 #7）。

### 2.4 工具与诚实性纪律

- 工具能力声明 13 字段（tool/types.ts:71-107）：readOnly/destructive/concurrentSafe/sideEffectScope/
  workspace|git|network/riskLevel/needsApproval/timeoutMs/maxOutputBytes/stopTurnOnSuccess/shouldDefer/allowedInPlanMode；
- **工具 schema=缓存前缀资产**：schema/顺序/描述固定字节、与语言设置无关（00-tool-change-chain.md）——
  中文界面下描述改一个字会打掉全部提示词缓存，这条纪律我们没有；
- 诚实的产品边界：工具描述只写已支持能力（未支持的不出现在描述里，防模型撞 tool_not_found）；
  防伪造写进工具描述（"Never fabricate or predict a pending agent's results"）；
- 文档弱于代码是健康信号：worktree 隔离在 contracts 声明但实现 throw "not implemented yet"（bootstrap/script-workflow-runtime.ts:347）。

## 三、codex（openai/codex）

### 3.1 保证实现：审查式路线

- **review 子命令**（core/src/tasks/review.rs）：起 one-shot 子 agent、注入 REVIEW_PROMPT、**禁 collab 防递归**、
  findings 结构化解析回写——"验收=另起一个干净上下文的评审者"，与 security-audit 的猎手/验证者分离同构；
- **Guardian**（core/src/guardian/，约 10k 行）：把审批决定外包给隔离审核模型——企业货，个人 harness 不抄，
  但"审批可以外包给便宜模型先判一层"的思想与 cindy 的"辅助模型复核"同族；
- **memories 两阶段管线**（memories/README.md）：startup 租约认领 → per-rollout 抽取 → 全局锁 +
  **usage_count/last_usage 排序**巩固 → 产物落 git 基线目录、生成 workspace diff 给无网络整合 agent 消化。
  → 我们巩固层（D18 确定性三条）可借**排序/淘汰/审计 diff**三件（审计 diff=巩固前后差异给人过目，与
  D18"语义整理只出建议"兼容）。

### 3.2 主动询问与中途播报

- `request_user_input`（handlers/request_user_input.rs + protocol/…/request_user_input.rs:9-29）：结构化提问，
  答案留存为 **VerifiedAnswer 长期上下文**（"这个问题主人已经答过"下次不用再问）；
- `send_message_to_user_async`（handlers/send_message_to_user_async.rs）：**长任务中途主动向用户发消息、
  不结束回合**，回复作为新输入进来。与我们忙时 steer 正交（steer=人→agent，这个=agent→人）——
  执事长跑时"进度播报/中途求确认"的现成形态。

### 3.3 plan 模板（collaboration-mode-templates/templates/plan.md）

三阶段 + **"decision complete" 门**（所有决策点闭环才算计划完成）+ **两种未知二分**：
可发现的事实→先探索再写计划；偏好类未知→直接问人。→ 任务单"计划附件"的模板骨架。

## 四、opencode

### 4.1 /goal 证据裁判循环（本轮 opencode 最大发现）

`packages/core/src/plugin/goal.ts`（494 行）+ goal/judge.txt：
- 会话**空闲时** idle 钩子触发**独立 reviewer 模型**判 `{done, continue, blocked, paused, wait}`；
- judge prompt 核心句："**The assistant claiming the goal is met is not evidence**"；
- objective 用 `<untrusted_objective>` 包裹防注入（目标文本本身可能是用户粘贴的外部内容）；
- **防打转三判据**：MAX_ROUNDS=50、同 reason stall、本轮无工具调用 stall（MAX_STALLS=3）；
- WAIT_LIMIT=30min 活锁自动 paused；**boot UUID**：重启后 goal 降级 paused（与我们 delegation 回执 bootId 同构，互证设计正确）。
→ 对我们的直译：验收快照=结果核对（一次性、确定性）；/goal judge=过程证据（持续、模型判断）。
**两者互补**：任务单可加"目标裁判"层——派单完成前由独立模型轮按原目标判"真完成了吗"，配合验收快照的落盘核对。
量级 M，收益最大（系列七 #14）。

### 4.2 权限系统的三个精修件

- **Permission.Unattended**（permission.ts:59-65,199-209）：无人值守时本应 ask 的请求按专门规则集结算，
  不满足→显式 deny 带"无人审批"原因，**绝不挂起**——比"自主轮开关"细，是审批轴与无人值守的正交组合；
- **审批批处理语义**（permission.ts:317-363）：reject 整批拒+共享 feedback（并行 ask 不逐条打断人）；
  "always" 落库后**立即重评其余 pending 级联放行**；**拒绝带反馈（CorrectedError）≠ 拒绝**——反馈变成
  ToolFailure 让模型读到原因继续改进。→ 我们审批答复只有批准/拒绝两路；"拒绝+指导"是第三路，
  对"模型重发"机制（D6）是天然配合：拒绝理由放进重发的工具结果里，模型就知道怎么改。
- **subagent 工具工程**（tool/plugin/subagent.ts）：子 agent=真子 Session 可续聊（sessionID 回传即 follow-up）；
  background:true 立即返回+完成自动通知+**描述里明令禁止轮询**；派活本身走按 agent 粒度的权限沉淀
  （action:"subagent", resources:[agent.id]）；工具描述**动态注入可选角色列表**；深度限制默认 1。

### 4.3 plan 模式与例行任务

- plan 模式 = 权限规则组合（edit 全拒、仅计划目录放行、question 放行）+ context 钩子每请求补插被
  compaction 剥掉的 system-reminder——"只读模式不是新引擎，是权限投影"；
- **schedule 条件门控**（tool/plugin/schedule.ts + schedule/check.ts）：`until`（条件达成即提前结束，已满足则
  立即 done）、`if`（触发前无模型检查+state 传递）、`ends={after,at,times}`、lastOutcome/lastOutput 透出给模型。
  → 我们例行任务引擎（ RoutineEngine 移植版）的增强模板：课题跟进的"研究到无新进展即止"就是 `until` 的用例。

## 五、与 lifediary 对照表（harness 级）

| 能力 | ZCode | codex | opencode | dim | 我们 | 差距判词 |
|---|---|---|---|---|---|---|
| 多 agent | subagent+消息+Workflow 三套 | review 子 agent/Guardian | subagent（真子会话可续聊） | 分支（并行线）≠member（真 subagent） | chancellor 派活+群组+递话 | **自主派活我们有优势**；同进程 subagent 双方都是现成备胎 |
| 完成判定 | final_critic 循环 | review 独立评审 | /goal judge 循环 | Pursuit evaluator 裁判分支 | 验收快照一次 | **缺循环与独立裁判**（七 #1/#14/#36） |
| 提问 | AskUserQuestion | request_user_input+VerifiedAnswer | question | attention 卡（无结构化） | 形态趋同，**补工具是小活**（七 #15） |
| agent→人播报 | notice 事件 | send_message_to_user_async | — | 派活进度帧 | 执事长跑可补（七 #18） |
| 无人值守权限 | — | — | Unattended 规则集 | 自主轮一律审批 | 补正交轴（七 #17） |
| 拒绝语义 | — | — | 拒绝带反馈+级联 | 批准/拒绝两路 | 补第三路（七 #16） |
| 工具声明 | 13 字段结构化 | 描述带纪律文案 | 动态角色注入 | 布尔清单 | 七 #8 |
| 例行任务 | — | — | until/if/ends 门控 | RoutineEngine+回执去重 | 七 #19 |
| 记忆巩固 | Dream（不自动触发） | usage_count 排序+审计 diff | — | 确定性三条+建议制 | 七 #21 |
| 回合终止 | 条件终止清单 | — | — | 回合上限 100 | 对照补终止条件覆盖面 |

## 六、三家"有、我们没有"清单（逐条带出处）

见系列七 §六 #1-#22（已合并排序，此处不重复）；本篇补充两条细节位：
- **VerifiedAnswer 模式**：结构化提问的答案留为长期上下文——与偏好记忆不同，它是"问答对"形态；
  可入记忆（kind 待议）或 task-meta；
- **goal judge 的 `<untrusted_objective>`**：目标文本防注入包裹——我们课题跟进的"课题问题"与派单的"任务描述"
  都是用户/他人可控文本，注入同款包裹是 S 级改动。

## 七、UX 亮点速记

- ZCode：审批 UI 选项裁剪（optionsPolicy 按策略隐藏"始终允许"）+ 权限规则可沉淀；后台任务 output file + TaskOutput/TaskStop 统一管理；**后台 bash 超时转后台而非杀掉**（超时≠失败）；
- codex：TUI 计划面板；两仓共有的"任务一行进度摘要"手法（详情收进 steps）；
- opencode：权限规则沉淀在会话内即时生效；subagent 完成自动通知+禁止轮询的描述文案。
→ 与系列七 #5/#6/#20 交叉引用。

## 八、deepseek-harness（DSH 平台）

> 完整报告：`.research/deepseek-family.md`（350 行，含 DS-Bot 桌面/DSH-Android/dsh-Go，本节只取平台面）。
> 已有调研（2026-11-04）已覆盖 approval seam（fail-closed + per-session ask/never）、"Model-visible means logged"、
> 持久 inbox、schedule——不重复。

### 8.1 插件机制的三条定性（对"要不要做插件系统"最有价值）

1. **插件=信任代码，不是沙箱**：官方口径"Installed Host code executes in-process outside the workspace sandbox"
   （plugin-manager README.md:22）——隔离对象是**工具执行**（sandbox 三档+三平台后端），不是插件本身。
   我们"不做插件系统、只做 md 技能库"的观望决定与此一致：一旦做插件，就得先回答"插件代码凭什么可信"；
2. **扩展点决定生态位**：DS-Bot 硬规则 "Build on DSH; never patch it"（AGENTS.md:22）、DSH-Android 用
   profile+插件+17 个补丁、dsh-Go 干脆只连 Web API——**三家没有一家 fork DSH**，说明扩展面够用。
   我们没有外部生态压力，`pi-durable extension` + 技能库已经覆盖自己的扩展需求；
3. **配置组合的最小完备原语**：profile → bundles → cordis.patch.yml → home → `--patch` 五层层序，
   patch 按 row id **整行替换不合并**（architecture.md:25）、profile patch 只记录对 bundles 的偏离、
   `!!js` 动态代码只许进 config/disabled 两处。
   → 对照我们：providers.json（keyEnv 无密钥结构）+ env 覆盖 + 回滚开关已是同族思想；"patch 整行替换"
   是防"合并出半新半旧配置"的简单纪律，值得登记。

### 8.2 工具契约三条（ENGINE-CONTRACT.md，同一文件里的省钱/安全组合拳）

- **工具描述静态化**：变更工具描述=重算 prompt 缓存（:405-408）——与 ZCode "schema 是缓存前缀资产"互相印证，
  **两家大厂同一条纪律**（系列七 #9）；
- **动手前 ensureCallActive 再查**（:413-438）：工具执行前确认调用还活着，**取消的调用永不产生副作用**——
  我们的审批"一次性放行清单"（8c 参数指纹）是同族思想（授权要跟当前调用绑定），但"执行前重验调用状态"
  这一步我们没有显式化；
- **超时单一真源 + App 侧 deadline−5s 必答**：超时配置一处定义，客户端比服务端早 5 秒兜底应答。
  → 手机 worker 通道直接适用（系列七新增条目）。

### 8.3 延迟加载工具（deferred tools + load_tools）

全量设备工具组时一句"Hi"要 ~19k 输入 token（**90% 是工具 schema**）；deferred tools + `load_tools` 按需加载后
降到 ~5k（ENGINE-CONTRACT.md:320-345）。我们 17 个工具尚未到痛感，**但已登记为"工具过 20 必上"的阈值**——
这正是 cindy"MCP 常驻只暴露 2 个工具+渐进发现"（2026-11-06 记忆调研）的同族方案，两家独立收敛。

### 8.4 诚实产品学（四条，直接可用为我们的产品话术）

遥测默认 FEEDBACK_ONLY（用户反馈才释放日志前缀）；E2EE "does not protect against a malicious Server on first
contact" 写进 README；上下文环标注窗口来源；网络诊断"未测量的不冒充已知"。
→ 与 D8（日志不含对话内容）同族的**"边界写脸上"**风格，我们的 README/接口文档可吸收（如 CORS `*` 的警告
已经这么做，风格一致，保持）。

## 九、hermes-agent（Nous Research）

> 完整报告：`.research/hermes-mika.md`（300 行）。要点：

### 9.1 名词澄清：SOUL ≠ 我们的 SOUL

hermes 的 SOUL.md 只是 667 字节的**语气人格文件**（`hermes_cli/default_soul.py`），无版本快照/例行任务/记忆隔离。
真正对应我们"执事"的是它的 **Bot Mode = profile**：SOUL/记忆/技能/凭据/模型 pin 全隔离 + Routines 挂 cron +
**永久 canonical chat**（每 bot 一条固定会话）。我们的执事（SOUL 版本快照+家目录+记忆 partner:<id> 隔离+例行任务）
与 Bot Mode 是同构竞品，**我们的"版本快照"是它没有的**，它的"canonical chat /new→/compact 改写"（用户在固定
会话里说 /new，系统改写成 compact，保住会话连续性）是我们没有的小巧思（<30 行）。

### 9.2 Bot Mode 社交层：执事递话的强化版

- **message_agent 带投递回执**：queued≠settled 两态、outcome 句式约定、**回执落发送方转录**（"我发过、送达没有"双证据）——
  我们的 send_to_agent（D21）只有"递到"，没有回执语义，这是 D21 后续升级的现成形状（M）；
- **bot_loop_guard 互聊熔断**：max_hops=4，**计数活在投递里**（不靠全局状态）——比我们"一跳单向留言"（D21）
  多出"受控多跳"的路线：如果将来要开两跳，这就是防乒乓的现成方案（S）；
- 群聊硬顶（10 条/3 轮 + Continue×5）与 `[SILENT]` 静默令牌（模型可主动选择本轮闭嘴）——群组防空转的补充件。

### 9.3 auxiliary LLM 体系（全库唯一的杂活模型路由结构）

curator/标题/压缩/vision/群聊路由/smart-approval **各自 pin 小模型**（agent/auxiliary_client.py）。
我们的偏好抽取（独立模型调用）已是第一个 auxiliary 用例；"auxiliary 客户端"把杂活模型变成一等配置是升级方向。
**smart approval**：aux LLM 当安全评审员，**命令文本当不可信输入处理**——与"审批决定外包"（codex Guardian）
同族的个人版（缓抄，见它的不抄清单）。

### 9.4 三个可直接搬的小机制

- **cron 的 context_from 作业链**：上一次 cron 轮的产出作为下一次的注入上下文（作业链）——长期课题跟进的
  "接着上次往下查"我们已同构（findings 全量注入），context_from 是更通用的形状；
- **cron 不活动看门狗**：看"空闲"不是看墙钟——连续 N 次轮次无产出/无工具调用才停，防止"每 5 分钟白跑一次"；
- **技能 curator**：usage 计数 + stale 归档 + **永不删除**——我们技能库管理（9-S）只有增删，无用量账；
- **记忆"满→报错让 agent 自己腾"**：不做静默淘汰，报错让模型自己决定删哪条（与我们"封顶修剪最旧优先"（D20）
  是两种哲学，它更尊重模型自主权，可作 env 可选项）。

### 9.5 缓存前缀铁律（两库互证）

hermes AGENTS.md L18-27 与 Mika ToolGroups **独立得出同一条纪律**："缓存前缀神圣，中途注入走 user 消息/
工具结果，不改系统提示"——与 ZCode 工具 schema 缓存资产、DSH 工具描述静态化**四方互证**。
我们的注入面（记忆/课题/身份标记）目前全部拼在系统提示里——**这是提示词缓存效率的真实损失点**，
系列七 #7 的注入框架立项时必须带上这条。

## 十、不抄清单

| 机制 | 理由 |
|---|---|
| ZCode：插件商店全链路、多端投影、飞书 bot、闲时 model-binding、fork subagent（spec 有实现无） | 依赖商业体系/未实现 |
| ZCode 无回合上限哲学 | 它有 150+ E2E 与多重兜底；我们无人值守保守上限是对的 |
| codex Guardian 全套 | 服务端规模；个人 harness 审批轴+（将来）辅助模型复核已够 |
| codex V1/V2 双 collab 并存 | 历史包袱 |
| opencode Effect-TS/Location 框架 | 学概念不学框架 |
| opencode plan mode 机制 | 我们课题/项目前置已承担该语义 |

## 十一、审计记录

- 2026-11-09：ZCode 报告由子智能体产出（112 工具调用/约 6.8M tokens，300 行带文件证据，存 `.research/zcode-deep.md`）；
  codex/opencode 报告同法（88 工具调用/340 行，存 `.research/codex-opencode-agents.md`）；
  DSH 家族报告（130 工具调用/350 行，存 `.research/deepseek-family.md`）；hermes/Mika 报告（100 工具调用/300 行，
  存 `.research/hermes-mika.md`）。行号级证据未逐条人工复核，作为线索用；**所有"抄不抄"判断已按 lifediary
  基线文档过筛**（见系列七排序清单）。
- 各仓 HEAD：codex 9ba7a3df52（2026-11-08）、opencode c73ca453a1（2026-11-08）、ZCode a9fe401e（v3.17.2，2026-11-03）、
  deepseek-harness fcc0ad4621（11-04）、hermes-agent 10d25f8ad6（11-08）、dim 870d6bb76（11-05）。
- dim（2026-11-09 补查，用户点名）：报告 `.research/dim-deep.md`（378 行）；本篇只收对照表两行，深挖内容在系列四 §九（主动性）与系列七 #35-#38。
