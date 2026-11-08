# 任务书：员工人格化 · 刀一（契约注入 · 状态感 · 教诲口径）

> 上位方案：《2026-11-08-员工人格化（岗位契约·履历·成长）.md》（同目录，先读 §三 E1/E5/E3 与 §四/§五/§六）。
> 执行：CodeBuddy（deepseek-v4.1-flash）。派单人：总管。基线提交 `dc1fed9`（工作区干净）。
> 刀一只做本任务书列出的四件事；E2 履历 / E4 目标回顾 / 界面编辑区 / shared 暴露**都不在本次范围**。

## 背景（两句话）

执事现在的"身份"只有一份 SOUL.md，改岗位=改人格，也没有"自己正在忙什么"的状态感。本刀给执事加**岗位契约（CONTRACT.md，与 SOUL 并列、同版本化语义）**、轮次输入的**当前在办段**、以及"被教诲要落偏好"的口径。

## 前置事实（2026-11-08 核对，行号是快照，以代码为准）

- 执事家目录 `.data/partner-homes/<uuid>/`：SOUL.md（当前值）+ `partner_versions` 表（冻结快照，`partners.ts` PartnerVersionRow）；"下一轮生效"契约=执事轮启动认版本号、appliedVersion 记账。单槽上限 64KB（PARTNER_SLOT_LIMIT）。
- 总管 = 固定 id `"chief"`（partners.ts 文件头注释，刻意例外，别动）。
- 执事轮输入组装两处：`agent/lifecycle.ts` runPartnerTurn（私聊/例行）与 `group-runtime.ts` buildMemberInput（群组成员轮）。两处都要注入。
- delegate 工具描述与 requirement 参数：`tools.ts:411-455`（requirement 现为"一句话说清+怎么算做完了"）。
- remember 工具在 `tools.ts`；记忆 store 有 kind（fact/episode/preference/entity）与导入 source=imported 先例（批 6，`packages/memory/src/store.ts`）。
- attention 通道：`delegation.ts`（need_input/need_decision/need_action；8g 后行号漂移，自查）。
- 审批 async 文案**已含**"先做不需要批准的部分"（批 8c turn-gate.ts）——**不要重复做**。
- 8g 后一张派活单自带专线会话（`task-conversation.ts`，TASK_AS_CONVERSATION=false 全旁路）。
- 8b 规矩：agent.ts 是桶，新逻辑写 `agent/` 子模块；partners.ts 只做存储，**不 import agent**。

## 改动项

### 1. E1 服务端契约（主体）

1.1 家目录新增 `CONTRACT.md`，固定四节（标题逐字）：`## 职责范围`、`## 决策分级`、`## 验收标准`、`## 汇报对象`。新执事播种时写一份**只有四节标题的空模板**；存量执事不自动补文件（不越权），读取时缺失=该节为空。

1.2 存储：`partner_versions` 表加 `contract_source` 列（SQLite ALTER TABLE ADD COLUMN，可空；老库启动迁移，null=无契约快照）。`PartnerVersionRow` 加 `contractSource: string | null`。**契约与 SOUL 共用版本号**：一个身份版本=当时的 SOUL+CONTRACT 对，改任一文本都 bump 版本并落双快照；"下一轮生效"语义与 SOUL 完全一致（改完不当场变身）。

1.3 写路径与端点：新增宿主写接口（写 CONTRACT.md 当前值 + 落版本快照，原子写、64KB 上限与 SOUL 同口径）+ 一个 HTTP 端点（形态照抄现有 SOUL 编辑端点）。**GET /api/v1/partners 响应形状不得变化**（不动 shared、不动手机端）。新端点写进 `docs/基线文档/接口文档.md`（新增小节，注明 PARTNER_CONTRACT 开关）。

1.4 注入：执事轮输入 = SOUL +「【岗位契约】」段（四节全文，空节省略该节标题）。两处装配（lifecycle + group-runtime）都要；建议抽一个共用的装配小函数放 agent/ 子模块，两边调用。

1.5 回滚开关 `PARTNER_CONTRACT=false`：不读文件、不注入、写端点返回 400 带说明；SOUL 侧行为零变化。缺省开启。

1.6 delegate 任务书四段：`tools.ts` delegate 的 description 与 requirement 参数描述升级——requirement 要求按四段组织：**目标 / 怎么算好 / 可自主范围 / 必须请示**；执事带契约时按其「决策分级」「验收标准」两节填写后两段。**参数结构不变（仍是 string），chancellor 零改动。**接口文档中 delegate 工具描述若有收录则同步。

### 2. E5 状态感（纯装配）

2.1 执事轮输入再注入「【当前在办】」段：①该执事发起且未终态的派活单（含 8g 专线；记账以 delegation.ts 最新实现为准，终态判定复用既有 TERMINAL 语义）；②该会话待审批 pending（approvals.findPending，注明明细≤3 条+超出数）；③最近一单结果（最近回执一行）。全部现查现拼，**零新存储**；三项皆空则整段省略。

2.2 与契约段合并装配：执事轮输入尾部依次=【岗位契约】+【当前在办】。装配内容写单测断言（SOUL/契约/在办三段各自可见、空态省略、开关旁路）。

### 3. E3 教诲口径（提示词层）

3.1 remember 工具描述加一条：用户以「以后 / 记住 / 下次」句式纠正或立规矩时，必须调用 remember 落一条 `preference`；来源标记 taught（store 支持 source 字段就写 `taught`，照 imported 先例；不支持就内容前缀 `[taught] `）。不改存量执事的 SOUL/CONTRACT/记忆内容。

### 4. B2 受阻口径（提示词层，最小）

4.1 执事侧 attention 应答口径：收到 need_input/need_decision/need_action 时，答得了就答；一时答不了 → 明确告诉工人"该项先跳过，继续其余部分，这项回头再补"。落点=attention 处理的话术指引/工具描述（delegation.ts 侧），轻改。审批侧已有同款文案，别动 8c 的东西。

## 铁律

1. **不许 commit**（派单人验收后统一提交）；变更记录写 `docs/变更记录/2026-11-08-员工人格化刀一（契约注入·状态感·教诲口径）.md`，格式照批 8c 记录。
2. **零 shared 改动、零 chancellor 改动**；`GET /api/v1/partners` 响应形状不变。
3. 契约红线照旧：密钥不进 git/日志/客户端；日志不含对话内容。
4. 接口文档与实现同步（新端点 + delegate 描述收录处）；系统架构.md 若涉及"刻意没有"登记（工人不建档等）由派单人落，执行者不写基线架构文档。
5. 不做多租户/账号/推送；不动群组路由、不动记忆引擎 schema（store 的 source 字段若需加枚举值按包内既有模式，改前先看巩固/召回对 source 的判断）。
6. 文件行数不设硬上限，按职责拆；新装配逻辑进 agent/ 子模块。

## 验证（最小充分，都要看输出不是只看退出码）

- `pnpm typecheck`：0 错。
- 单测：`pnpm --filter @lifediary/server test` 全绿；新增至少覆盖——契约写入+双快照 bump / 老库迁移（无 contract_source 列的旧库打开不炸）/ 开关旁路（false 时注入与端点）/ 装配三段断言（契约+在办+SOUL）/ 空态省略 / attention 口径文案存在。
- `pnpm --filter @lifediary/server http`：全绿（新端点进探针场景：写入→读到→开关关 400）。
- `pnpm memtest`：跑一次确认不受影响（E3 不应动巩固/召回语义）。
- 附属探针（companion 若有）跑一遍确认无回归。
- **真模型手验归派单人**，执行者不做。

## 交付物

- 代码（不 commit）+ 变更记录 + 接口文档小节 + 单测/探针更新。
- 完成后在变更记录里如实写：改了什么 / 验了什么 / 已知边界 / 没跑的验证。
