# Agent 全景调研三：多 Agent 协作专题（gstack 深挖 + 全景对照）
> 状态：调研/调查留档（非契约，2026-11-09）。结论已消化进后续批次；现行口径以基线文档为准。


> 2026-11-09。用户口径："有多个 Agent 协作的项目，咱们都仔细调查一下"。
> 本文主角：**gstack**（YC CEO Garry Tan 的开源"软件工厂"，18 专家角色 + 7 工具，纯 Markdown 斜杠命令）——
> 它是**用流程而非用消息总线**做多 Agent 协作的代表，与 cindy/DS-Bot 的"消息派活"路线完全互补。
> cindy 四层 / DS-Bot 派活树 / lobehub supervisor / OpenMausBot 路由已有三篇深调研（2026-11-05/06，结论维持），
> 本文只做横向对照与增量；DS-Bot 桌面 App 形态与 DSH bots 由 DeepSeek 家族调查补入 §五。
> **冲突以 `docs/基线文档/` 为准。**

## 〇、人话版结论

1. **多 Agent 协作有两种正交路线**，行业里两家各自做到了极致：
   - **消息派活路线**（cindy Orca / DS-Bot / dsh-superagent）：主管↔工人互发消息，靠回执/账本/树保证不丢——
     解决"**活怎么分下去、结果怎么收回来**"；
   - **流程流水线路线**（gstack / superpowers）：没有消息总线，靠**每一步的产出物喂给下一步**
     （office-hours 产出设计文档 → plan 三评审消费它 → eng-review 产出测试计划 → qa 消费它）——
     解决"**活按什么顺序、以什么质量标准经过哪些关口**"。
   - 我们已有前者（chancellor 派活）；**后者是我们没有的第二条腿**，而且它恰恰是"提出要求→保证实现"的骨架。
2. gstack 证明：**"18 个专家"不需要 18 套基建**——全部是 Markdown 角色提示词 + 一条"产物交接链" +
   少数硬工具（长驻浏览器 daemon）。多 Agent 的成本大头在**流程设计**，不在运行时。
3. gstack 的**浏览器人机交接**（`$B handoff` 把有登录态的页面原样交给用户处理验证码/MFA，`$B resume` 接着干，
   连续 3 次失败自动建议）与我们"要人接管（resume 提示与反馈）"同构——**验证了我们的方向，且给了自动化建议时机的判据**。
4. gstack 的**调查铁律**（/investigate："没有调查不许修；3 次修复失败必须停"）是防打转守卫的**流程版**——
   我们的 loop-guard 是运行时保险，这条是让模型自己守纪律的契约。

## 一、调研来源（审计日期 2026-11-09）

| 来源 | 是什么 | 深挖范围 |
|---|---|---|
| `<reference>\gstack-main` | 本地解压版（无 .git），18 专家 + 7 工具 + 长驻浏览器 daemon（Bun 编译二进制） | README（263 行）+ ARCHITECTURE（359 行）全文实读；目录清单（25 个 skill 目录） |
| 已有调研 | cindy 四层与 DS-Bot（11-05）、群组四家（11-06）、运行时模块（11-04） | 结论引用，不重复 |

注：gstack 是 YC CEO 的个人工作流开源，纯提示词工程 + 一个 Bun 工具，无 agent 框架——**这本身就是发现**。

## 二、gstack 的多 Agent 模型：角色 = 流程阶段

### 2.1 冲刺流水线（Think → Plan → Build → Review → Test → Ship → Reflect）

| 阶段 | 斜杠命令 | 专家角色 | 产出 → 下游 |
|---|---|---|---|
| Think | `/office-hours` | YC 办公时间 | **设计文档**（重构问题、挑战前提、三方案带工作量）→ 喂给全部 plan 审查 |
| Plan | `/plan-ceo-review` | CEO | 范围四模式（扩张/选择性扩张/守住/收缩）→ 修订设计文档 |
| Plan | `/plan-eng-review` | 工程经理 | 架构 ASCII 图/数据流/状态机/错误路径/**测试计划** → 喂给 /qa |
| Plan | `/plan-design-review` | 高级设计师 | 每个设计维度 0-10 打分 + "10 分长什么样" + AI slop 检测，交互式逐项问 |
| Build | （普通编码） | — | 按 plan 实现 |
| Review | `/review` | 资深工程师 | 抓"过 CI 但生产炸"的 bug；**明显的自动修**，拿不准的 [ASK] 逐个人批 |
| Debug | `/investigate` | 调试专家 | **铁律：没调查不许修**；追数据流/验证假设/3 次修复失败必须停；自动 /freeze 锁定调查模块 |
| Test | `/qa` | QA 主管 | 真浏览器点击；修 bug 用原子提交 + 自动生成回归测试 + 复验；`/qa-only` 纯报告不改码 |
| Ship | `/ship` | 发布工程师 | 同步 main/跑测试/覆盖率审计/推送/开 PR；**没有测试框架就现场搭一个** |
| Ship | `/land-and-deploy` | 发布工程师 | 合 PR→等 CI→部署→生产健康验证→坏了给回滚 |
| Reflect | `/canary` `/benchmark` `/retro` `/document-release` | SRE/性能/EM/文档 | 上线监控循环、性能基线对比、周回顾、文档对齐（/ship 自动带） |

**关键机制：评审路由**——"像运转良好的创业公司：CEO 不用看 infra bug 修复，后端改动不需要设计评审"。
gstack 追踪哪些评审跑过了、判断什么改动该过哪一关，**Review Readiness Dashboard** 在 /ship 前告诉你缺口在哪。

### 2.2 与 lifediary 的执事体系对照

| 维度 | gstack | lifediary 现状 | 判词 |
|---|---|---|---|
| Agent 形态 | 18 个角色 = 18 段提示词，**同一条 Claude Code 会话换角色跑** | 执事 = 独立会话 + SOUL 身份 + 记忆隔离 | 我们的"人"更真（有身份有记忆），他们的"岗"更流程化——**互补不冲突** |
| 协作介质 | **产物文件**（设计文档/测试计划/评审结论） | 消息/任务单/专线会话 | 他们天然防"上下文丢失"（产物落盘），我们的任务单已有同效；**差异在"下一角色读什么"是结构化的** |
| 质量关口 | 每阶段有明确"过关条件"（评审通过/覆盖率审计/回归测试） | D13 验收快照（按落盘结果核对） | 我们有"结果验收"，缺**"过程关口"**（多角色过目） |
| 并行 | Conductor 多工作区，10-15 个冲刺并行；"冲刺结构让并行可控" | 派单并发 + 文件租约 | 同构；他们多一个"并行靠流程不靠互锁"的论断 |
| 人机分工 | [ASK] 逐项批 + 评审仪表盘 + 浏览器 handoff | 审批三档 + attention 卡 + 要人接管 | 高度同构；**handoff 的"3 次失败自动建议"时机判据可抄** |
| 成本 | 零基建（Markdown），浏览器 daemon 是唯一硬工具 | pi-durable + chancellor 全套基建 | 我们的重基建买的是"长期记忆/恢复/多设备"——不同目标，不算过度设计 |

### 2.3 gstack 的硬工程件（跟多 Agent 无关但对"保证实现"重要，详见系列七）

- **长驻浏览器 daemon**：首次 ~3s、之后 ~100-200ms/命令；状态文件（pid/port/token）+ 版本不匹配自动重启；
- **ref 系统**：@e1/@c2 代替 CSS 选择器（走 ARIA 树 + Playwright Locator，不注 DOM——CSP/框架/Shadow DOM 全绕开）；
  导航清 ref + **使用前 count() 检查**（5ms 内报"ref 过期，请重新 snapshot"，而不是等 30s 超时）；
- **错误信息写给 AI 看的**：每条错误必须可行动（"Selector 匹配多个元素 → 请用 snapshot 的 @refs"）；
- **SKILL.md 模板生成**：文档占位符从源码生成 + CI 校验新鲜度（文档漂移=构建红）；
- 三层测试：静态校验（免费）/真 agent E2E/LLM 评审——"免费层抓 95% 问题"。

## 三、全景对照：五种多 Agent 协作形态（含已有调研结论）

| 形态 | 代表 | 协作介质 | 可靠性支柱 | 我们对应 |
|---|---|---|---|---|
| 跨进程派活 | chancellor（自有）、dsh-superagent | 工单+回执+状态机 | 幂等三态/死信/恢复结算 | ✅ 已有 |
| 消息派活树 | DS-Bot | handoff tree（parent/open[] 两字段） | 回执先写后发/uncertain | ✅ 已有（借鉴源） |
| 团队会话 | cindy Orca、lobehub、OpenMausBot | MCP 工具/群聊路由 | auto-bridge 欠回报账本/@纯函数路由 | ✅ 群组已有 |
| 流程流水线 | **gstack、superpowers** | **产物文件 + 关口** | 评审路由/覆盖审计/回归测试 | ⚠️ **缺**——本专题主增量 |
| 群聊分工 | cindy botGroupDivision（宿主判+模型填 JSON） | 交接消息+文件清单 | 2h 上限/辅助模型预算 | 刻意没有（chancellor 已覆盖单主多子） |

**结构性判词（维持旧调研，2026-11-05 结论）**：三套多 agent 形态（派单/子任务/伙伴）边界必须写死在宿主代码，
互不冒充——gstack 从另一个方向证明了同一件事：它**只有一种形态**（角色会话），所以不需要防混用。
形态越少越稳；要扩形态时先抄 cindy 的"边界写死"三件套（WORKER_CANNOT_NEST / MAX_DEPTH=1 / 权限档不继承）。

## 四、对 lifediary 的建议（本专题增量）

| # | 建议 | 量级 | 依据 |
|---|---|---|---|
| 1 | **给执事加"产物交接"习惯**：多执事接力时，产出物落盘（文件/任务单附件），下一棒从产物开始而不是从转述开始——现在 8e 已注入"上游产物路径清单"，把"产物优先"写成岗位契约条款 | S | §2.2 产物介质 |
| 2 | **执事契约加调查铁律**："没有调查不许修；连续 3 次修复失败停下转 attention"（loop-guard 是运行时兜底，这是模型自律层） | S | §2.1 /investigate |
| 3 | **任务中心加"过程关口"投影**：一张单除"结果验收"外，可展示"过了哪些关"（评审/测试/复核）——先只在 chancellor 验收快照里加"谁看过"字段，界面后置 | M | §2.1 评审路由 |
| 4 | 浏览器自动化若将来引入：抄 ref 系统（ARIA ref + 使用前 count() 校验）与"错误信息写给 AI 看" | 备忘 | §2.3 |
| 5 | "要人接管"补时机判据：同类失败连续 3 次 → 主动建议人接管（我们已有 resume 链路，缺自动建议） | S | §2.2 handoff |

## 五、DS-Bot 桌面 App：多 bot 协作的产品呈现层

> 机制本体（派活树/幂等回执/断点结算/防空转/群 Goal）2026-11-05 已调研；本节只补**桌面产品形态**。
> 完整报告：`.research/deepseek-family.md` §DS-Bot。

DS-Bot 桌面是"壳插件给 DSH Web 加料"——**数据都在 DSH，壳只做呈现**。四个呈现件：

1. **Goal 岛**（goal.js:9-60）：群目标卡=阶段分段（drafting/active/pass）+成员头像+验收证据+返工次数——
   我们群组没有 Goal 语义，但**任务单详情可借"阶段分段+证据+返工次数"的呈现**（chancellor 验收快照数据现成）；
2. **成员忙碌胶囊**：群成员行的忙碌状态胶囊，**"等审批"排最前**——审批等待是用户最该先看的忙因。
   我们执事列表的状态点（绿点）可升级为"忙因排序"（等审批 > 跑任务 > 空闲）；
3. **browser handoff 三按钮卡**：人机交接的按钮卡（对应 gstack handoff，系列三 §2.2 同构）；
4. **queue dock 只列用户自己的行**（#663 教训写进了注释）：插话队列面板只显示当前用户自己的条目，
   防止"别人的队列干扰我"——我们插话队列服务端化（8a）时注意同样口径；
5. **computer 指示条用 `setContentProtection` 防进模型截图**——共享屏幕/截图时排除敏感条，防模型"看到不该看的"。
   我们桌面壳无此需求，登记为多屏演示场景的备忘。

## 六、OpenMausBot：把 bot 当联系人的产品形态（2026-11-09 补查）

> 完整报告：`.research/openmausbot-bots.md`。群聊机制（响应者路由等）2026-11-06 已调研，此处只收
> "bot 形态"增量。它是**执事体系最接近的公开竞品**（"聊天 App 里养一队真 agent"）。

- **架构同构互证**：两进程（App 零 transport + Harness server 持有全部 agent 进程、fan-in 事件总线→SSE、
  Permission broker）——与我们"壳只连 HTTP/SSE + 服务端装配闸门"同构；Driver registry"未知驱动降级
  unavailable 永不 crash 车队"；
- **审批五档透传**（Ask / Auto-accept edits / **Approve for me=用 provider 自带自动评审** / Full access /
  Custom 仅 Codex 且只能从打包桌面 App 进出走私有通道——**防 bot 自己改自己的权限**）；
  **"bot 读自己的文件永不问"是机械白名单**：目录圈定+纯读词表（cat/head/tail/grep/rg/…）+
  **命令含 pipe/redirect/第二命令/变量/glob 即照常问**；客人回合的读永远问；
- **主动性=单例看护例行**（无第二个 watcher bot；watch.json 保证"交接只交一次、同一时刻至多一个开着"）+
  四升级件：**checks 纯代码先行（安静 tick 零 AI 成本）**、**安静也结构化（{"quiet":true}，读不懂=失败不发布）**、
  read-and-draft 档（服务端直接拒绝不出卡）、**游标只在 AI 答案被保留后才推进**；
- **Brief 卡三规则**：每天一张、**没有值得报的就不发**、只在"今天首开/离开三小时后"出现、永不抢屏；
- **记忆三条红线**：每轮只注入 MEMORY.md 前 200 行/24KB、0600+原子写、**"像凭据的先打码再落盘"**；
  **团队包共享**=单文件导出+双重脱敏（导出前+上传时各跑一遍凭据检测）+**到货默认安全态**（Ask 档/技能关/
  例行暂停）——"格式里没有字段"而不是"记得别填"；
- 对外 MCP 控制面**刻意小**：不暴露审批授权/删除/凭据/电脑生命周期——外部接口比对内界面更小。

### 对 lifediary 的建议（并入系列七排序）

| # | 建议 | 量级 | 出处 |
|---|---|---|---|
| A | 记忆写入**凭据打码**（像 key/token/password 的内容落盘前 `«redacted»`） | S | §6 |
| B | 例行任务升级件：安静 `{"quiet":true}` 契约 + **游标只在答案保留后推进** + 读失败不当"无新" | S×3 | §4 |
| C | brief/日报卡三规则：无新不发、就地编辑、不抢屏 | S | §4 |
| D | "读自己文件永不问"白名单（路径圈定+纯读词表+杂字符即问）补强只读判定 | S-M | §3 |
| E | 审批级别"作用半径"分层口径（按谁执行工具分三类即时/锁定） | S | §3 |
| F | 团队包（执事导出+双重脱敏+到货默认关）——换机/备份时立项 | M | §6 |

## 七、两家 openbot：agent 通信策略与治理（2026-11-09 补查）

> 完整报告：`.research/openbots.md`。nightly-labs/openbot（持久 AI 队友工作台，12 后端 ACP）与
> CopilotKit/OpenBot（企业 AI 同事，AG-UI 作者）。⚠️ 前者默认 `danger-full-access`（抄机制不抄默认值）。

- **nightly-labs 的 Agent 通信策略**（与 D21 递话最对口）：共享开发者指令双端注入（thread start+resume，
  各引擎按各自通道；ACP 只在会话缺它时注入——新会话/变更后/压缩后/失败后/无上下文报告每 10 轮）；
  "**不拒绝任务先试每条路**"→超 profile 先 `list_agents` 读队友 description/status/队列→委派；
  **回报四行格式：Status / Result / Evidence / Unblock:**（队友阻塞时第四行给解锁动作）、
  回报开头是队友名字、**"不把任务发回给它的来源"**；**多副本对齐**（同一请求发 ≥2 队友：请求方等最后一个
  副本结束一起消费，人的消息不等立即进）；**interrupt 边界**（"agent 不能停用户、例行或另一个 agent 的活"）；
- **quiet 例行**：`routine_no_update` 工具为主路径 + `[[no-update]]` 标记兜底，纯安静轮把标记/思考/计划
  **从会话清掉**、`quiet:true` 事件让各端不响——与 OpenMausBot `{"quiet":true}` 两家独立收敛，**已是行业契约**；
- **CopilotKit 的治理**：audit trail 是产品骨架（每行同时 OTLP 外发）；两条教训值得抄——
  **"闸门拒绝必须留痕"**（token 缺失时 MCP 工具被拒但 transcript 里看不见、bot 只会"报无结果"）与
  **`AGENT_STALL_TIMEOUT_MS`**（审计 trail 唯一记"没发生的事"：流停滞补一行 `agent.stream_stalled`——
  "卡死也是事件"）；"两种坏配置组合**启动时拒绝**，而不是写进文档祈祷"；
- **可借小件**：run_source（test/script/webhook）触发来源落历史；automation-server 的小时配额防脚本刷爆；
  CLI 退出码表把"3=在等人"与"4=超时但工作继续"分开；消息删除全链路 scrub（我们维持 append-only，仅备案）。

### 对 lifediary 的建议（并入系列七排序）

| # | 建议 | 量级 | 出处 |
|---|---|---|---|
| G | 委派回报**四行格式**（Status/Result/Evidence/**Unblock:**）+ "不把任务发回来源" | S | §7 |
| H | **闸门拒绝留痕**（拒绝有 SSE 还要有账）+ **stream_stalled 看门狗**（卡死也是事件） | S-M | §7 |
| I | 派单/例行回执加 **run_source 触发来源列** | S | §7 |
| J | 多副本对齐（同请求多队友等最后一个、人的消息不等）——等派活扇出场景 | M | §7 |

## 八、不建议抄 / 暂不抄

| 机制 | 理由 |
|---|---|
| gstack 的 18 角色全套 | 域不同：它是编码冲刺流水线；我们的执事按生活/工作领域分工。**抄的是"阶段+关口+产物交接"形状，不抄角色清单** |
| Conductor 多工作区并行 | 编码特有；我们的并行=派单 |
| 浏览器 daemon 全套 | 我们无浏览器自动化需求；将来做"帮用户查资料/办事"时按 §2.3 抄件 |
| 遥测（Supabase opt-in） | 隐私红线（D8）相反方向 |
| 评审仪表盘大做 | 单人自用没有"漏关"压力；批次化（建议 #3）已够 |
| OpenMausBot：云电脑/Composio/12 引擎驱动层/语音通话/新 bot 默认 Full access | 外部服务依赖与"全本机"冲突；ACP 观望；默认全开与我们"自主默认关"相反（详见 `.research/openmausbot-bots.md` §10） |
| nightly-labs：danger-full-access 默认/12 后端驱动层/云账户 Signal | 默认全开与我们相反；ACP 观望；单机无账户体系 |
| CopilotKit：多租户/SSO/SCIM/Recorder/15 框架适配层/Intelligence | 企业货形态；单人场景 audit trail 降级为"拒绝留痕+状态跃迁落账"即可 |

## 九、审计记录

- 2026-11-09：gstack README/ARCHITECTURE 全文实读（ETHOS/BROWSER/docs/skills.md 未逐字读，要点已从两文引用）；
  目录清单核对（25 个 skill 目录：office-hours/plan-×3/design-×2/review/investigate/qa/qa-only/ship/land-and-deploy/canary/benchmark/document-release/retro/codex/careful/freeze/guard/unfreeze/browse/setup-×2/gstack-upgrade）。
- 2026-11-09（补）：OpenMausBot README 全文 + approval-levels/decision-model/memory/proactive-routines/routine-schedules/team-sharing/files 七篇 docs 实读（`.research/openmausbot-bots.md`，用户点名补查；配额原因由本会话直读完成）；
  两家 openbot 读 nightly-labs README + docs/{messaging,automation,architecture/agents}、CopilotKit README + docs/configuration 治理段（`.research/openbots.md`，2026-11-09 新克隆）。
- cindy/DS-Bot/lobehub/OpenMausBot 的机制结论全部引自 2026-11-05/06 已有调研，本轮未重读源码；其活跃度复核见《2026-11-06-参考项目状态复审》。
- gstack-main 为本地解压版无 .git，版本对不上游为常态；引用以本地文件为准。
