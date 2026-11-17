# 侧栏调整计划与验收（CodeBuddy）

状态：2026-11-06 A/B/C 功能已实现并完成多轮返修；Qoder 最终独立复跑类型检查和侧栏探针（66 项通过）。接口文档已回写；系统架构与独立变更记录尚未收尾。下方原始复选框保留计划记录，不代表逐项独立验收全部完成。
> 2026-11-07 复核："系统架构与独立变更记录尚未收尾"已过时——均已随 11-07 侧栏系列批次回写提交；下方复选框保留为历史计划记录。

验收记录（2026-11-06）：Qoder 独立运行头像/伙伴/模型链/shared 测试 24 项通过；浏览器验证普通 worker 与总管分流、项目菜单、头像保存与刷新及取消、四主题轴线、窄屏隐藏层不可聚焦和短窗口底栏。前端延迟响应竞态的 13 项模拟测试由 CodeBuddy 执行，Qoder 已核对关键实现，但未逐项独立复跑；完整回归套件亦未在最终修复后全部复跑。

已知边界：pending 重启探针显式登记了 `#think-*` 模型变体；真实供应商重启时派生变体可能尚未注册的问题未在本任务修复，因此不能将探针通过解释为所有真实模型重启场景均已保证。未提交、未推送，未重启用户服务。
> 2026-11-07 复核：上面这条"派生变体可能尚未注册"**已由扫尾批 2 修复**（注册表重建时预派生全部思考变体，`MODEL_VARIANT_PRESEEDED` 回滚；见《2026-11-07-扫尾批2（重启丢旧会话模型绑定修复）》与接口文档 §2.8 注记）。
分工：Qoder 制定计划与独立验收；CodeBuddy 修改代码和补测试；不自动提交、推送或重启用户正在使用的服务。

## 目标与范围

1. 展开和收起使用相同导航顺序、图标及水平轴线；顶部均为新建对话，其次总管。保留最近会话、任务、项目、执事和群组能力。
2. 图标适当放大，补齐展开态主项目文件夹图标；项目弹层展示主项目和子项目，子项目有明确的层级与图标。项目仍为总览，不引入当前项目切换。
3. 所有相关入口、提示与弹窗将“添加主项目”改为“设置主项目”；保留“添加子项目”“管理项目”。
4. 总管与执事头像可选择本地图片、预览、保存和清除，未设置时用名字首字；持久化在服务端，不仅存在浏览器中。范围不包含新增用户账号头像系统。
5. 总管与执事状态点移到行右侧。可用状态显示明确绿色；暂停、归档和服务失联不得伪装在线。忙碌与可用性分别表达，不再以是否正在回复决定总管是否可用。
6. 顶部“新建对话”进入普通 worker 对话，总管仍有独立入口；必须验证身份和会话归属，不能只改按钮文字。
7. 第一次点击没有历史的执事时打开其专线会话并主动问候；问候持久化，重复点击、刷新、并发打开及重启不重复发送；已有历史直接打开。问候不调用工具、不自动开始工作；失败明确显示，可重试但不自动重复派发结果不确定的轮次。
8. 展开态底部一行显示服务状态及右侧齿轮图标，不显示“设置”文字；保留提示、无障碍标签与键盘操作。收起态保留可点击齿轮和状态点，避免横向拥挤。

## 已核对证据

- web/index.html:91–145：展开与收起顶端顺序不一致；183 行项目入口没有文件夹图标；213–222 行底部设置与状态分为两行。
- web/style.css:393、560、585：轨道图标18px、展开导航图标15px、头像21px。实现建议统一导航图标22px、头像28px，配36–40px行高；具体以浏览器截图复核，不扩大整个页面字号。
- web/app.js:2087–2090：总管点由 state.sending 决定；2182–2195：执事点由 active 状态决定且在左侧。两者不是同一种状态语义。
- web/app.js:2242–2262：首次打开执事的空历史只提示并返回，无首次问候。
- web/app.js:2839–2848：新建仅清空前端会话。src/agent.ts:600–602 默认 persona 使用总管身份，因此不能依据前端没有绑定 chief 就宣称普通 worker 已独立。
- src/partners.ts:69–79 无头像字段；web/app.js:7403 起编辑模态没有头像设置。
- CiNDY apps/desktop/src/renderer/components/sidebar/Sidebar.tsx:124–148：内容层定宽避免展开收起时连续文字重排。参考思路，不直接照搬其三态与宽度。
- CiNDY apps/desktop/src/main/maker-ipc/botInvitation.ts:330–359：邀请后生成身份化问候；固定 clientId、队列凭据与 ready 状态防重，toolsDisabled=true。不是已证实的“首次点击”触发；本项目按用户要求改为首次点击触发。

以上 web/ 与 src/ 均相对 ts/apps/server/；CiNDY 根为 <reference>/cindy。

## 执行分批

### A：纯侧栏改动

CodeBuddy 修改 web/index.html、style.css、app.js 中已定位区域：统一导航顺序与几何、增加线描 SVG 图标、项目层级与文案、状态点位置和底栏齿轮。保留现有弹层定位、主题、收起状态持久化和全部入口。用同一组静态 SVG 定义或现有方式复用，不加图标依赖或远程图片。

### B：补齐契约设计后再实现行为

头像存储、问候去重、普通 worker 与总管分流涉及契约/状态/身份，不能按纯前端任务派发。Qoder 先核对以下接缝并补充精确字段、端点与迁移设计，由用户确认后交 CodeBuddy：

- shared/src/index.ts、companion-api.ts、partners.ts：头像采用本地文件或受限内嵌图片的取舍、大小/格式校验、清除语义、旧记录默认值。禁止服务端抓取任意外部头像 URL；不能让头像暴露本地任意路径或执行 SVG 内容。
- partner-runtime.ts、agent.ts：问候如何通过现有 durable 回合保存，稳定请求标识、持久去重与恢复、用户先发消息时跳过问候。不能把自动提示伪装成用户消息，不能只在 DOM 或 localStorage 记“问候过”。
- 新建对话与总管的区分：先查明默认身份注入、会话元数据与历史过滤；为新建普通会话显式记录归属，旧会话继续按既有身份处理，避免总管入口误开普通 worker 会话。保留当前权限闸门，不新增执行权限或另造 C2/CLI 调度层。
- 新能力回滚按仓库约定设计；修改契约先同步 shared 与接口文档。外部手机端兼容影响必须明确，不擅自修改其它仓库。

以上研究已完成主要接缝核对，下方细化取代本节未决事项；CodeBuddy 只按明确范围实现，不自行扩大产品功能。

### B 实施细化（2026-11-06）

目标：头像可保存、普通 worker 身份独立、空历史执事首次打开收到一次身份化问候。
架构：保留 Hono + 原生前端 + SQLite + pi-durable；头像使用伙伴 SQLite 列；会话种类与问候状态使用 durable doc，避免把身份放进容易丢失的前端存储。不增加依赖、不改手机端、不提交 git。

#### B1：头像契约与存储

修改 ts/packages/shared/src/index.ts、ts/apps/server/src/partners.ts、companion-api.ts、src/partners.test.ts、docs/基线文档/接口文档.md。

- [ ] 先写失败测试：头像可保存/清除，重开存储保留，旧库读取 null；非法数据、超限图片拒绝且原头像不变。
- [ ] shared 新增 PartnerAvatarSchema 与 PartnerAvatarPatchSchema。avatar 字段为 null 或 `data:image/png;base64,...`，最大字符串长度 180000；服务端只接收 PNG，不接受 SVG、外部 URL、任意本地路径。校验 base64 格式、PNG signature、IHDR 和尺寸（1–256px），校验解码字节数不超过128KiB。字段遗漏表示不改，null 表示清除。PNG只供浏览器 img 渲染，不执行。
- [ ] partners 表增 avatar TEXT nullable，用现有 PRAGMA/ALTER 迁移模式；PartnerRow.avatar 为 string|null；新增 setAvatar(id,avatar) 原子更新。GET partner projection 新增 avatar，PATCH body 新字段在任何更新前先校验，不因图片错误部分写入名字或状态。
- [ ] POST 创建可不提供头像，此次先支持已有头像编辑。chief 走同一存储与编辑入口；不得改总管 SOUL 版本来保存头像。
- [ ] 单元测试通过；接口文档写具体格式/尺寸/清除语义。旧客户端省略字段行为不变。

#### B2：普通 worker 与总管分流

修改 shared/src/index.ts、server/src/agent.ts、index.ts、现有 http 探针（必要时新建 scripts/sidebar-probe.ts，不改 package.json）。

- [ ] 先写失败用例：新会话指定 worker 后重启仍 worker；已有旧会话仍 chief；续话请求不能改变种类；列表和历史响应能恢复种类。
- [ ] ChatRequestSchema 新增可选 chatKind: enum chief|worker，只在不带 conversationId 时采用；已有会话带不匹配值返回400，不隐式改身份。默认仍chief，保住手机和旧调用方。
- [ ] agent.ts 新增 ChatKinds session doc（kind=lifediary.chat-kinds，version1，初值 byInternal:{}），存内部id到 chief|worker；openChat 新建分支增加可选第三参数 kind，创建与doc写入同一init事务。不要允许客户端自造会话id，也不要破坏 openOrCreateChat 既有调用。
- [ ] export chatKindOf(chat:ResolvedChat):Promise<chief|worker|partner>：执事链接优先partner；无记录旧会话chief。列表/历史响应新增 chatKind（列表接口现为手写类型，shared补充 ChatKindSchema 作为唯一枚举来源）。
- [ ] persona section render(input) 按内部 conversationId 读 ChatKinds；worker 返回独立的简短普通任务助手提示，不读总管 SOUL；链接到非chief执事时不注入总管 persona，保留其 configure instructions。worker 不冒称总管、不默认建立执事档案、不获得新权限；依旧经过现有工具闸门与路径约束。
- [ ] WORKER_CHAT_ENABLED=false 时拒绝创建新的worker（业务提示），已经落盘worker保持身份，不把旧worker重解释为总管。环境变量表记录；默认启用。
- [ ] 主聊天续执事 canonical 时在提交前调用 ensurePartnerSession 对齐身份，暂停/归档不许继续跑。index.ts 可以 import partner-runtime（后者已依赖agent）；agent.ts 不能反向import它。
- [ ] 验证上述用例与旧HTTP探针。

#### B3：首次问候（真实模型生成，canonical 只写助手消息）

修改 server/src/partner-runtime.ts、agent.ts、companion-api.ts、shared/src/index.ts、新增 scripts/sidebar-probe.ts；不得调用真实用户数据或真实外部工具。

接口：POST /api/v1/partners/:id/open，不带正文；返回 {ok:true,conversationId,greeting: sent|existing|skipped|disabled}；模型不可用/生成失败为503、暂停/归档409、不存在404，鉴权仍403空体。错误给通用中文，不回传上游原文。chief 不走此接口，返回400。

- [ ] 先写探针失败用例：首次open获得单条assistant；并发open、重复open及服务重启后只有一条；已有user/assistant历史直接existing；暂停拒绝；问候期间用户先说则skipped；无模型明确失败，不伪造成功。
- [ ] export openPartnerConversation(partnerId:string) 执行ensurePartnerSession并检查历史。给 ensurePartnerSession 的同partner并发创建加入单飞，避免两个canonical孤儿；这是现有 check-then-create 的必要修正，不扩大为全局调度。
- [ ] PARTNER_GREETING_ENABLED=false：仍创建并打开空会话，返回disabled，不生成问候；默认启用。
- [ ] 生成用隔离 task- 前缀 durable 会话；configureTaskChat 将工具清空并移除扩展，身份仅使用当前 SOUL 快照与简短中文问候要求：2–3句，最多一个问题，不编造经历、不宣称外部服务已接通，不调用工具。不读私人项目/历史，不在 canonical 写自动user prompt。
- [ ] canonical 的 conversation-scope durable doc（kind lifediary.partner-greeting，version1）保存 attempt、generationExternalId、requestId、status（pending|ready|sent|skipped|failed）、text；在事务里认领，稳定 task id 和 requestId；重启 pending 复用同一生成会话/同一submission，不另跑模型；终态失败后显式再次点击才 attempt+1。保存 ready 文本后再投递。
- [ ] 生成requestId通过 chatStream传入；模型请求异常无法确认结果时保持pending，不能直接换id重派。同进程open请求复用promise；终态unanswered才标failed并返回503。
- [ ] 在 canonical.conversation.commit 的一个事务内扫描所有历史pi.user/pi.assistant与已受理input submissions（包括queued/placed）；只要用户已说或已入队就标skipped；否则 appendEntry pi.assistant 并把doc标sent同一提交。复用sayInChat的合法entry形状，但不要先读历史后调用普通sayInChat形成竞态。只在commit回调用tx读取，不能用harness.snapshot造成死锁。已sent直接existing。
- [x] 2026-11-06 依赖复核纠正：Tx 不提供 scanSubmissions。实现使用事务内分页 scanEntries 检查 pi.user/pi.assistant，加 InboxDoc 检查已受理且 mode 非 write 的输入；queued 输入和 inbox 原子写入，placed 输入落成 pi.user 时原子移出 inbox。canonical 初始只有配置 entry 不算已有对话。
- [ ] endpoint仅在写入提交完成后返回，前端随后可立刻回读；已有历史不再走生成。失败不阻止稍后打开空会话手工聊天（前端错误态提供继续对话/重试）。
- [ ] pnpm typecheck；pnpm --filter @lifediary/server test/http/companion；pnpm probe；新增sidebar探针覆盖以上并检查真实输出。

#### C：接上前端与独立验收

A/B不可同时写web；B只写后端、shared、测试、接口文档，A结束后再派C修改web。

- [ ] 编辑执事模态加头像选择/预览/保存/清除；客户端读取PNG/JPEG/WebP，解码后canvas缩至最长边256，输出PNG dataURL。输入源最多5MiB，不合规/损坏/输出超限明确提示；提交成功再替换当前头像，取消不改。总管和执事同一入口，侧栏头像点击打开编辑（stopPropagation），行其余部分仍打开会话。
- [ ] 所有头像 img 使用DOM属性赋值而非拼接不可信HTML；同步总管展开/轨道、花名册与设置，显示28px、object-fit cover，未设置首字。清除后刷新仍首字。
- [ ] 新建按钮/轨道/Ctrl+K都startNewChat('worker')并go chat；初始普通空会话默认worker；总管入口仅从chatKind=chief的历史里找，找不到startNewChat('chief')。续话从messages响应恢复chatKind，不依靠ID猜身份。提交新会话带chatKind；续话不带或使用已存种类；header文案符合当前身份。
- [ ] 执事open调用新接口后openChat。请求在飞防双击，切换会话/路由后旧响应不得抢回页面；失败显示重试与继续空会话聊天入口，不能只toast然后无路可走。
- [ ] 总管/执事在线点=服务连通且对应伙伴active；忙碌另用现有数量/文案，不改变在线色。各入口可键盘操作，隐藏侧栏层不能成为Tab焦点。
- [ ] 更新基线架构相关口径和变更记录。独立浏览器验收按原清单执行，截图只含测试数据；不宣称审美替用户验收。

审查重点：身份串台、问候和用户先说的竞争、头像坏数据覆盖旧值、短窗口底栏被挤走、快速切换会话被旧请求抢回。每项必须有对应测试或浏览器实测证据。

### C：独立验收与返修

CodeBuddy 完成后交回修改文件、测试命令及输出、服务启动方式、未验证项。Qoder 自己看实际 diff、运行必要测试并在浏览器操作；不以执行者的“已完成”判定通过。发现缺陷给具体复现和预期，再交 CodeBuddy 修复。

## 验收清单

- [ ] 展开/收起导航顺序一致，图标水平轴线稳定，不因缺图标造成文本错位。
- [ ] 四套主题、短窗口、长名字、多个执事/群组下不挤压或裁掉底部操作。
- [ ] 有主项目、无主项目、有/无子项目、目录异常均清楚展示；文案统一；添加与管理仍可用。
- [ ] 头像保存、刷新、重新进入均生效；取消不改变原头像，清除恢复首字；坏图片/超限不覆盖已有头像。
- [ ] 总管和执事状态点在右侧，绿色与主题强调色无关；暂停/断线/忙碌不混淆。
- [ ] 两态新建入口及快捷键均进入普通 worker；总管入口不误开 worker 历史；普通聊天可连续收发。
- [ ] 空历史执事第一次点击真实出现助手问候，随后可以正常对话；双击、多标签页、刷新、重启不重复。
- [ ] 问候失败可见且可重试；用户先发消息不被问候打断或重复回复；切到另一会话不会串入问候。
- [ ] 齿轮位于服务状态右边，只有图标但可聚焦、有提示，设置返回和收起态入口正常。
- [ ] 群组、最近会话、改名标题、任务中心、项目菜单、发送/停止无回归。
- [ ] 按涉及范围运行 pnpm typecheck、server test/http、伙伴相关探针；若改 durable 语义则 pnpm probe；检查输出而非仅退出码。
- [ ] 使用隔离测试数据和独立端口，不读取私人对话、不修改用户工作区配置、不停止现有服务；无浏览器验证必须明确报告未验收。
- [ ] 契约与基线文档回写，落地写变更记录；不顺手修复无关历史文档。

## CodeBuddy 调用约束

按用户提供的 <local-docs>/CLI工具更新/非交互模式调用说明.md：codebuddy -p 配合 -y、--model deepseek-v4.1-flash、--output-format json；NO_PROXY=127.0.0.1,localhost，stdin 为 /dev/null。先记录当前 git status，仅在明确范围内写文件；不改权限配置、不使用沙箱环境变量绕过检查、不提交、不推送、不删除用户数据。核对实际产物和 permission_denials，拒绝或结果不确定时不得声称完成。
