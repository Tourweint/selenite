# 参考项目多 agent 机制调研：cindy 四层与 DS-Bot 派活树

> 2026-11-05。用户口径：cindy 不止单 agent，疑似有"伙伴"机制；三家参考项目横向对比，
> 择优落实到本项目。**状态（2026-11-05 终）：调研完成，未落地任何代码；施工批次与取舍
> 见 `2026-11-05-多agent能力施工蓝图（批次A通用件·批次B伙伴·批次C主动性）.md`，
> 每批开工前仍须单独立方案。** 冲突以 `docs/基线文档/` 为准。

## 〇、一句话

cindy 的"多 agent"不是一套机制，是**三套平行产品叠在同一个底座上**（Orca 团队 / 子代理 / 伙伴 Bot），
各自有独立派活通道、边界写死互不混用；DS-Bot 用消息派活并给出教科书级幂等回执；
dsh-superagent 与我们 chancellor 模式同构。**总体架构不用动**，可抄的是一批具体部件
（防打转守卫、欠回报账本、Profile 双层存储、例行任务引擎、跟进观察层、回执三态）。

## 一、调研来源与方法（审计日期 2026-11-05）

| 来源 | 定位 | 本轮深挖范围 |
|---|---|---|
| `<reference>\cindy` | XD 开源 AI Agent 桌面端（Electron+React），多 agent 是产品核心卖点（README："One agent not enough? Let her lead a team."） | 四层逐层深挖（Orca / 子代理 / 伙伴 Bot / maker-core 底座） |
| `<reference>\DS-Bot` | DeepSeek Harness 插件，一群长寿 Bot 消息派活 | 派活树 / 幂等回执 / 断点结算 / 群 Goal |
| `<reference>\dsh-superagent-prototype` | DSH 插件："守着 GitHub 仓库的全自动程序员"，1 路由者 + 每工单 1 执行者 | 第一轮已覆盖（与 chancellor 同构），本轮未再深挖 |

调研方式：4 路并行探索代理，逐项带 文件:行号。**行号未逐条人工复核，作为线索用**；
文档与代码冲突处均已按代码为准标注（见 §2.2"文档虚报"）。"我们现状"的对照基于本仓库
基线文档与代码（delegation-receipts 父/子单、WRITE_TOOLS 闸门、手机审批、记忆四层、SSE seq 重放）。

## 二、cindy 总览

### 2.1 三套产品 + 一个底座

| 层 | 是什么 | 派活通道 | 与我们的对应 |
|---|---|---|---|
| ① 引擎底座 | Claude/Codex/Pi 三执行器可互换，`Session`/`Maker` 抽象（`packages/maker-core/src/session.ts:453`、`maker.ts:494`） | — | 我们单引擎，不需要互换；底座两件通用件值得抄（§3） |
| ② Orca 团队 | Lead + Worker，Worker 是**完整会话**（自带模型/上下文/历史） | MCP `cindy_orca` 21 工具（`packages/lizi-mcps/src/orca/server.ts`） | ≈ chancellor 派活（§4） |
| ③ 子代理 | 一次性后台任务，4 角色并行/后台 | `subagent` 工具（Pi 引擎专属） | 我们没有（§5） |
| ④ 伙伴 Bot | 长期数字同事（身份+记忆+例行任务+主动跟进） | 例行任务引擎 / 事件唤醒 | 我们没有（§6） |

关键认知：三套是**平行的，不是嵌套的**。边界写死在代码：worker 不能冒充子代理
（`create_worker.ts:268-274` `WORKER_CANNOT_NEST` 拒绝），子代理不能再套娃
（MAX_DEPTH=1，子进程根本不注册 subagent 工具）。混用会污染状态机——我们将来若同时有
派单与子任务形态，这条边界要照抄。

术语澄清（免得日后猜错）：Ghost=插件的模型侧叫法，不是 agent；Errand=插件后台一次性差事；
Agent Island=桌面任务活动条；Fleet=子代理运行面板；Teammate=伙伴在通知语境的称呼。

### 2.2 文档虚报三处（择优时以代码为准）

1. 子代理宣称 7 角色（scout/reviewer/planner/worker/oracle/researcher/delegate），
   **代码只有 4 个**（`cindy-subagent-source.ts:181-205`），oracle/researcher/delegate 全仓无实现；
2. chain/workflow DAG 编排宣称已实现，runner 侧调度器存在（`cindy-subagent-runner-source.ts:1038-1105`）
   但**工具 schema 未暴露 dependsOn/mode**，`normalizeInvocation` 只产出 single|parallel（`:1374`）——DAG 是死代码；
3. PermissionMode 6 档，但**子代理边界只认 2 档**：非 bypassPermissions 一律按 ask（`:537-548`）。

## 三、层①：底座通用件

### 3.1 ToolLoopGuard 防打转（最值得整体移植，~200 行纯类零依赖）

`packages/maker-core/src/agents/pi/../../agents/shared/loop-guard.ts:279-694`，规则（踩坑调出）：

| 层 | 判据 | 处置 |
|---|---|---|
| 疑似1 | 连续 4 次 name+input+output 完全相同 | 交辅助模型复核（每 turn 限 3 次、20s 超时） |
| 疑似2 | 12 次滑窗 distinct≤2（pingpong） | 同上 |
| 疑似3 | 16 次滑窗 distinct≤4（轮转；实锤案例：某模型 4 个 Grep 轮转 1000+ 次） | 同上 |
| 铁证直断 | 完全相同连续 30 次 / 同结果持续 60min / 128 读窗口长轮转 | 直接中断 |
| 豁免 | 等待/轮询类工具（TaskOutput/sleep/tail log）；距上次调用 ≥30s 的节奏轮询不计 | — |
| 已废 | "同类契约错误连续 3 次"判据运行时已关（同类错误不能证明模型没在修正） | — |

我们 agent.ts 现无此机制。它是防"模型原地烧钱"的通用保险，与伙伴层无关。

### 3.2 动态权限闸门

权限档**每次 tool_call 现读**（`cindy-bridge-source.ts:5128`），读不到按 ask fail-closed；
带修改放行（updatedInput）+ 会话级授权累积；**Full Access 也拦一类特例**——写 agentHome
配置目录（防模型改 baseUrl 劫持自己）。对比：我们是静态名单（AGENT_TOOL_POLICY 一刀切），
cindy 是"黑白名单（spawn 参数 --tools）+ 调用时审批"两层叠加。

### 3.3 其他底座件

- turn 零事件看门狗：45min 无产品进展即 abort（`session.ts:92-107`），等交互/有后台任务时暂停计时；
- InteractionResolver：权限/提问/计划审批三合一抽象，**没接 listener 一律 deny**（fail-closed，
  `session.ts:645-657`）；
- Maker 资源租约：启动 singleflight 防双进程、Codex thread 独占租约防串线（`maker.ts:506-622`）。

## 四、层②：Orca 团队（≈ chancellor 派活）

### 4.1 结构与状态机

- DB 三件套：`orca_teams` / `orca_workers` / `sessions.orca_role`（`localDb/schema.ts:793/822/226`）；
- **"每 Lead 一个活跃团队"靠 DB 不靠纪律**：partial unique index `uniq_active_team_per_lead`
  只约束 `status='active'` 行（`schema.ts:808-810`）——不能用全表 unique（旧 team 会占住索引）；
- start_team 已有 active 就复用（`orcaLifecycleService.ts:369-400`），Lead 反复调不炸；
- Worker 创建=一条普通 maker session + 关联行 + orca_role + 注入回报 MCP 与系统提示，
  参数表含 role/label（team 内唯一）/agent/model/effort/working_dir/execution_device_id；
  **权限档不继承 Lead**，创建时单选；
- 人数 soft=5 / hard=8（超软限返回 warning 交 Lead 自决）；并发创建靠 5 分钟短租约表
  `orca_worker_creation_reservations` 原子占位（`schema.ts:875-893`）。

### 4.2 auto-bridge（干完自动回传）——全仓库最值得抄的状态机

内存账本 `autoBridge: Map<sessionId, AutoBridgeState>`（`orcaTeamService.ts:595`）：

1. 派活 accepted → `setPending`（欠回报 +1）；
2. Worker 主动 `send_to_lead` → **只结清 pending，不写终态**（`:2065-2096`）；
3. Worker turn 真终态（done/error）时若无人报过 → 补报**原文**：尾 8192 字符 + 一行头
   `[Auto-bridged: worker 已完成，系统自动回传结果]`（`:808-816`）；经普通 dispatcher 发 Lead，
   **Lead 忙就排进 Lead 自己的输入队列**；
4. Lead 手动叫停的 turn **不**回传（`:2244-2250`）；
5. 陈旧检测：终态事件带 capture 身份 + turnGeneration，对不上（Lead 已派新活）当 stale 丢弃（`:2153-2220`）；
6. 投递失败标记 `retryAfterRejectedDelivery`，等下一个 terminal 边界重试。

防刷爆不靠防抖靠**提示词纪律**（`orca-bridge-prompt.ts:24-97` 整篇可参考）：Worker"报告一次，
不发进度，每轮只调一次 send_to_lead"；Lead"派发成功即零输出结束、禁止 sleep/poll/轮询"；
诊断工具描述写明 "EMERGENCY DIAGNOSTIC ONLY"。**没有提示词纪律，异步机制会被模型自己打穿。**

### 4.3 完成暂缓与回收

- `hasPendingWorkerReports`（欠回报数）接入完成判定：Lead 那轮只要还有欠账，UI 不出完成卡
  （`register.ts:21026-21031`）；最后一份回报落地补发完成通知。
  **对我们的直译：派单回执升级"欠回报账本"，Lead 收工 = 账本清零。**
- **刻意没有"全部收齐才继续"原语**（契约 #2）：先到先处理，后到自动唤醒，不许主动等。

### 4.4 派发器不变量

`orcaInterAgentDispatcher.ts:357-731`：空闲直发 / 忙排队 / 直发撞 SESSION_RUNNING 竞态→回滚改排队；
**accepted 之前零副作用；回滚不许覆盖已落终态**（`:919-948`）。排队条目六管理工具
（改写/撤回/合并/转插话/调序/看队列）——高频多 worker 场景才需要，第一版可砍。

### 4.5 跨设备与重启

- 跨设备 worker：Lead 侧留代理行（不跑 agent），执行设备上是普通任务；
  回报靠**轮询**（快 2s/闲 15s，15 轮无回复判 error）非订阅；`last_bridged_message_id` 去重；
  派活时设备离线**直接失败不排队**；
- 重启：身份全在 DB，resume 前懒合成重建挂载（`orcaSessionStartOptions.ts:44-106`）；
  auto-bridge 账本内存态**重启即丢**（跨设备才有 `pending_remote_report` 持久层）；
- worker 跑一半挂了：turn 时间戳判疑似中断→自动续跑（续跑期间 vendor 终态不当产品错误）；
  空 worker 有 ready placeholder 保证可 resume；60s 空闲释放 watcher（无损休眠非删除）。

### 4.6 坑清单（文档"运行时行为契约"每条都是真实事故）

- done 落库早于进程真空闲（settle 竞态，#3153）；
- auto-resume 期间的 vendor 终态不是产品终态，别拿它收账（5a）；
- 本地 auto-bridge 账本重启丢 → 要么落库要么接受 DB 重建；
- 空 worker 无法 resume（ready placeholder 教训）；
- worker≠subagent 边界必须在 handler 与 prompt 双写死。

## 五、层③：子代理

### 5.1 工具面（`cindy-subagent-source.ts:1527-1587`）

单发 `{agent,task}` / 并行 `{tasks[]}`（上限 8）/ `async:true` 转后台立即返回启动回执
（回执是精确字符串，被用来判"已启动≠已完成"）/ `notify` 默认 true（父 turn 结束前自动收）/
`timeoutSeconds` 10s~24h 默认 1800s / `isolation:require-worktree`（只检查父已在 worktree，
不创建）/ `context:fresh|fork` / 管理动作 8 个（capabilities/list/get/wait/stop/steer/follow_up/resume）。

### 5.2 四个真实角色（只读三个 + 工人）

| 角色 | 工具白名单（spawn 参数 --tools） | 要点 |
|---|---|---|
| scout | read,grep,find,ls | 结论带 file:line，只给发现不给过程 |
| reviewer | 同上 | 按严重度报可执行缺陷，不复述代码 |
| planner | 同上 | 产出实现计划，不写代码 |
| worker | WRITE_TOOLS = read,grep,find,ls,edit,write,bash | 最小改动+自行验证，不扩范围 |

只读角色**结构上**拿不到写工具；worker 的写操作在 Ask 档还要过子进程逐次审批。

### 5.3 durable 实现

- 后台任务=**独立 OS 进程**（utilityProcess.fork），run 目录全落盘：`status.json`（2s 心跳、
  原子写 tmp+rename+0600+Windows 共享冲突有界重试）、config/transcript/result（256KiB 上限）/permission；
  **终态 status 用更宽重试预算**（中间态丢了下 tick 重写，终态丢了永远显示 running）；
- 控制走**文件信箱**非 socket：`controls/<uuid>.json` 每 200ms 扫，**stop 永远优先消费**，
  回执 5min TTL，requestId LRU 256 防重放；
- 看门狗两层：子进程 2s `kill(pid,0)` 探父（EPERM=活；**node 看门狗别注册 SIGTERM 处理器**，
  会抑制默认终止）；runner 盯父实例用 pid+启动时间防 pid 复用；
- MAX_DEPTH=1：子进程根本不注册 subagent 工具——**代码级禁套娃**；
- 权限快照冻结进 run 目录；Ask/Auto 写操作走 child RPC→审批 UI 往返，**送达失败 fail closed**；
  并发审批按 child 排队、只公布队头（单槽替换会永久挂起——不变量 11 的来历）。

### 5.4 必抄小件

- 派发前 fail-closed 顺序：先发一帧 failed 进度**再** throw（卡片状态机会把"有工具结果"兜底成完成）；
- 输出双预算：单任务 16k + 整批 32k，均分+让额+保头截断；
- 进度帧带标记键 `__cindySubagent` + `isAgentTaskToolName` 统一识别（防其他工具流式误认）；
- 子代理用量并回父会话记账（delegatedUsage），否则 token/cost 全漏；
- "live update + 持久终态谁说了算"优先级链（`agentTask.ts:177-209`）——与 SSE seq 重放同类问题。

## 六、层④：伙伴 Bot（长期数字同事）

### 6.1 存储双层（最值得照抄的设计）

- `bot_profiles`（身份索引/状态/canonicalSessionId 唯一外键）+ `bot_profile_versions`
  （**SOUL 正文冻结快照**：任务启动认版本号，整轮身份不变；改 SOUL.md **下一轮生效**——
  这是设计出来的不一致，别修成即时生效；`botProfileFolder.ts:16-25`）；
- `bot_session_links`：一条会话按角色挂到伙伴（canonical/history/delegation/group/channel/thread/routine），
  每 bot 唯一 canonical；
- 磁盘家目录 `<ownerRoot>/bots/<botId>/`：SOUL.md / memories/USER.md / system_prompt.md /
  workspace/（唯一默认可写区）/ memories/ / skills/；单槽上限 64KB；全原子写；播种幂等，
  **SOUL.md 最后写 = 家建好的标志**；
- 权限边界：原始文件工具只挂 workspace/，memories/skills 走宿主类型化接口（防 symlink 逃逸
  与内部文件泄漏）。

### 6.2 记忆（对我们的直译 = memory 包加一个 scope key）

伙伴记忆 = 现有 MakerMemoryStore 换 key：`bot:<encodeURIComponent(botId)>`
（`maker-core/src/memory/storage.ts:91-93`）——同一套存储/索引/FTS，键空间隔离。
编辑乐观锁；启动冻结快照；**整理唯一入口"夜间学习"**（辅助模型提议、宿主逐条校验落盘、
每条带撤销备份，不进伙伴对话上下文）；**回复后复盘被明确废除**。
不注入项目/全局记忆与其它 Bot 记忆。

### 6.3 模型候选链（~100 行纯函数，`botModelChain.ts`）

≤5 项完整路由存 capabilities；不可用（连接/鉴权/配额/容量/模型缺失）才切**用户显式配置的**
下一项，绝不从目录发明路由；**三种情况故意不切**：账号额度耗尽（切了同死）、用户主动断开、
权限拒绝/参数错误/上下文超限（切了掩盖真因）；fallback 只改当前任务，不暗改 Profile。
（我们落地时路由里的 key 必须仍是 keyEnv 纪律，见蓝图。）

### 6.4 例行任务引擎（783 行纯逻辑，`routine-engine.ts`，零依赖可整包移植）

- RoutineRun 7 态（queued/running/success/failed/interrupted/cancelled/skipped）+ 单快照
  RoutineState 宿主原子提交；
- 触发四种：cron（游标比对）/ interval / once / **event**（24h 回执去重 + originRoutineId 防自环
  + 条件 equals/contains/not-equals）；多条件 OR 命中**合并同一个 run**；队列满 100 抛错让发布方重试；
- 每规则串行 lane；派发异常 retryAfter 30s；伙伴忙 deferred 回队 30s；
- **终态落盘失败：结果留 pendingSettlements 每 tick 重试，期间后续触发只能排队不能执行**
  （宁可漏跑不可丢账）；
- **重启 running→interrupted，不自动重放**（外部副作用无法断言是否已发生）；
- `sessionMode`：persistent（固定专线会话，跟进类用，保上下文）/ fresh（每次新会话跑完关，
  检查类用，空壳当轮回收）；
- 内置规则 ensureBuiltin 幂等：不存在就建、与模板不同就重写、**保留用户的暂停选择**；
  内容禁改、删除一律拒绝。

### 6.5 自主跟进（bot-autonomy/，~2000 行，"产品级主动性"）

- 层 0 状态表 taskWatch（纯程序级）盯：活动订阅（运行/等交互/完成/出错）+ 输入协调器投影
  （errorReason/工具循环/用量上限）+ 挂起交互 + DB 兜底（24h 内最多 50 条被打断任务）；
- 六类事件与阈值：stuck（10min 无活动；前台工具在途放宽 45min）/ waiting（等审批 5min）/
  errored / usage-limit / finished（**须模型主动报"有最终交付"+绑定当前执行代次**）/ sweep 兜底；
- **防风暴三件套**：事件 id = `类型:任务:进入状态时刻`（跨重启稳定，同状态只发一次）；
  同任务同类事件 24h 最多 6 次（第 7 次只记日志）；sweep 按 2h 时间桶分 id；
  引擎层另有 24h 持久回执去重兜底重启；
- **伙伴主任务永远不是自己的事件对象**（否则出错会自己叫醒自己）；
  远程任务只在显式看一眼时拉取（60s 节流）且**不发事件**（防两台电脑各跟一遍）；
  共享给访客的任务没人跟（有外人的内容不能叫醒以主人权限跑的伙伴）；
- 30s sweep 定时器**按需存在**：无跟进需求就 clearInterval；
- 内置"跟进"规则跑在 persistent routine 专线（与主会话共享身份记忆、上下文独立）；
  没人跟的"等你"任务由宿主**直接**提醒主人（不经模型）——对我们即手机审批扩展点；
- **默认关闭，用户显式开启**（文档原话：这条决定功能是惊喜还是惊吓）。

### 6.6 权限风险表（50 行纯函数，`taskActionAuthorization.ts:178-226`）

自主轮触发时六类操作**必须弹卡**：调度命令 / 新建完全访问任务 / 授予常驻指令 / 删除自动化 /
代主人回答权限请求 / 恢复暂停执行。许可一次性消费；确认期间定义变更旧许可失效；
自主身份（autonomous/entrusted）以一行 turnAuthority 注入上下文。
判定只输出风险类别，执行仍按当前权限档（Full 免审/Auto 意图审/Ask 问用户/Plan 不执行）。

### 6.7 群聊分工 / 云漫游（可砍，留判词）

- 分工：宿主用辅助模型判"要不要分工"（8s 预算、结构化 JSON、校验不合格换下一候选，
  `botGroupDivision.ts:137-162`）；每步一条分工 session（同一伙伴多步共用）；交接消息+
  文件清单（git diff）；2h 上限。通用件是"宿主固定判断+模型只填 JSON"模式与
  untrustedJsonBlock 低信任块；
- 云漫游整套单机砍；留两条边界判词：**能力引用随行、配置凭证不随行；权限档不随行**。

### 6.8 刻意没有（他们的红线，值得我们登记同款）

生命周期/fallback/所有权判定必须在宿主代码，不许只写在 prompt；上下文维护三不
（不按空闲提前重建、不做伙伴专属压缩、回复后不复盘）；不做公网触发；事件数据最小化
（标题+一句话≤140 字+分钟数）；"自动跟进所有任务"账号内唯一且默认关；
**抄歪教训**：曾照别人清单放 todo.json/knowledge/ 空槽位，后全删——
"列名字不给路径，等于开一张模型打不开的空头支票"。

## 七、DS-Bot：派活树与幂等回执

### 7.1 派活树（handoff tree）

- 账本三字段建树：work = `{from, to, parent, open[], results[]}`（`host/handoffs.js:101-106`）；
  parent = 发活时父正在做的活；open[] = 未收子活列表。树的全部查询（谁在等我/我在等谁）由
  这两字段推出，**不存嵌套树**；
- **收齐判在父下一回合结束**（`turns.js:994` waitsWork→holdWork 分支），所以父可中途继续派新活，
  "等式可以追加"；
- 两段式收活：结果先 holdWork 存住，open 清空后的下一回合才拼 answerText 上行
  （模板 `handoffs.js:224-237`：自己的话 + `[Handed back to X]` + 每子结果全文，
  失败子结果换 "could not send its reply; what it had answered"）；
- 上行消息头改写（`delivery.js:19`）："for the work X asked you for; your answer goes to X…"——
  **父模型零协议即可接上**；
- 长结果先落盘 `handoff-results/<id>.txt` 再记账（先写临时文件再 rename，state 只存
  前 2000 字+总长+文件名），**读回校验长度**——截断常量是耦合组（2000/1000/20000/200000），
  只抄一半会出现"装作完整"的假结果；
- 拒绝"给正在等我结果的上游发消息"：拦向上方向，返回**普通结果字符串**不抛错：
  "你的答案会自己回到它那里，干完活结束回合即可"（`tools.js:227`）。

### 7.2 幂等回执（`host/requests.js`，教科书）

- 身份 = 发活方 + 场合 + request_id；内容 sha256 指纹；同 id 同内容→replay（**原样返回第一次
  的回执**）；同 id 不同内容→conflict 拒绝；**uncertain（发送途中死）→永不自动重发，交人判断**；
- **回执先写 state 再发消息**（admit()，`:73-101`）："回执存不下来就拦不住第二次发送"；
  pending 记录带 runId，重启后看到上个进程的 pending 一律 uncertain——防重复派活的核心；
- 回执**永不过期**（过期会让旧重试重复副作用）；
- 与派活树是**两套账**：requests 管投递幂等，works 管结果上行，互不引用。

### 7.3 断点结算（`host/resume.js`）

inflight.json 记"在跑回合 + 已投未读消息"（**发送前先记**，丢消息窗口≈0）；重启后对每张单
看 session 持久日志：回合已写出答案→走与正常收活**完全相同**的上行路径（树不需要自己的恢复
逻辑：等待关系持久在 state.json，回合状态用日志现算）；"答案已交上去过"（查 asker 日志）→
只结账不重发；日志读不出→明说 unknown，不当成功也不当失败。
**承认的重发窗口**：回合读走消息后、防抖落盘前崩溃→重启重发一次→对策=所有派单强制带 request_id。

### 7.4 防空转三件套

群接力 6 轮零工具纯客套→暂停，**只有用户发言解锁**；"只承诺不干活"（0 工具+客套话正则）
自动续推一次；Goal 空转 2 次 nudge 无进展→停下等用户。
注意：客套判定是硬编码中文/英文词表，移植应改用"0 工具调用+与前 N 条归一化重复"判据。

### 7.5 群 Goal（多阶段验收，可后置）

drafting（goal-grill 技能只问真分叉）→ active（阶段任务 @ 派发）→ pass **必须附证据，
没证据工具层直接拒绝、状态零改动**；rework 须 reason；`<group_goal>` 账本每轮注入
（放 prompt 拼接不进系统提示，保缓存）；空闲自动推进挂回合结束（无独立定时器），
连续 2 次无进展停下等用户。

## 八、对照我们：有什么 / 缺什么

| 能力 | 我们现状 | cindy | DS-Bot | dsh-superagent |
|---|---|---|---|---|
| 派活+回执 | chancellor + delegation-receipts（父/子单、aborted 拦截、文件验收） | Orca MCP 21 工具 + auto-bridge 账本 | 消息派活 + handoff tree + 三态回执 | 路由者 + 工单 + 回执最重 |
| 干完自动回传/收齐继续 | 无 | auto-bridge + 完成暂缓 | 结果自动上行 + 批次收口 | relay |
| 模型派子任务 | 无 | subagent 工具（4 角色、后台、进度流） | **废除**（三理由：不可见/不可停/换段丢结论） | worker 可再派 |
| 防打转 | 无 | ToolLoopGuard 四层+复核 | 6 轮零工具暂停 | — |
| 长期身份/记忆 | 记忆四层（无角色维度） | 伙伴 Profile+scope key+夜间学习 | Bot 分段+交接包+三层记忆 | 无 |
| 例行任务/主动性 | 无 | RoutineEngine+taskWatch 六事件+防风暴 | Goal 自动推进 | observe 三档 |
| 高危操作审批 | 手机审批（已落地） | 六类风险表自主轮必弹 | 各专项闸门 | observe 模式 |
| 断点恢复 | SSE seq 重放+快照 | durable 文件协议+看门狗 | resume.js 日志结算 | Mandate 版本快照 |
| 重启幂等 | 回执表 | 内存账本会丢（教训） | 先写回执再发+uncertain | 效果队列+退避 |

## 九、词汇对照（他们的话 → 我们的话）

| cindy / DS-Bot 术语 | 大白话 |
|---|---|
| auto-bridge | 工人干完系统自动把结果塞回主管队列 |
| 欠回报账本 / pending | 派活回执升级版：主管收工=账本清零 |
| Lead / Worker | 主管会话 / 工人会话 |
| durable run | 状态全落盘、独立进程、父死了也能跑完的后台任务 |
| Profile / SOUL.md | 伙伴档案 / 身份文件 |
| 版本快照 | 任务启动时冻结的身份，改了下一轮生效 |
| RoutineEngine | 例行任务引擎（cron+事件双触发） |
| taskWatch / sweep | 任务观察表 / 兜底扫描 |
| scope key | 记忆隔离键（bot:<id>） |
| handoff tree / open[] | 派活树 / 未收回子活列表 |
| replay / conflict / uncertain | 回执三态：重放 / 冲突 / 结果未知不重发 |
| holdWork | 结果先存住，等收齐再上行 |

## 十、择优结论

**必抄（按性价比）**：① ToolLoopGuard 整体移植；② 派单回执三态加固（先写后发、uncertain
不重发、pending 带 runId、强制 requestId）；③ taskActionRisk 六类风险接手机审批；
④ 记忆 `bot:<id>` 隔离；⑤ Profile 双层（DB 行+SOUL.md+版本快照）；⑥ RoutineEngine 整包；
⑦ 模型候选链；⑧ taskWatch 跟进层（默认关闭）；⑨ auto-bridge 思路（欠回报账本+完成暂缓，
后置）；⑩ 子代理工具（同进程+status.json 起步，后置）。

**可以砍**：云漫游整套（单机）；群聊分工（chancellor 已覆盖单主多子）；Orca 排队六管理工具
（留 FIFO+撤回）；子代理 fork 上下文快照与跨代恢复；launch fence/凭证租借（单进程不需要）；
DS-Bot 客套词表正则（改用归一化判据）。

**结构性原则（比任何单件都重要）**：代码不用提示词（禁套娃/生命周期/去重全部宿主实现）；
fail-closed；先落盘再记账；中断不自动重放；边界写死（worker≠subagent）；
新主动性能力默认关闭。

施工批次与每批的改哪些文件、契约影响、回滚开关、验证方式见施工蓝图文档。
