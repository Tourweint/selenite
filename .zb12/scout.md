## 1) 总管系统提示词

- `PERSONA` 常量：`ts/apps/server/src/agent/assist.ts:24-38`；启动播种 `seedChiefPartner()` 在 `assist.ts:150-157`（`index.ts:1352-1353` 调用），把 PERSONA 原文写成总管 SOUL。
- `resolvePersona`：`ts/apps/server/src/partners.ts:1212-1219`，优先 `chiefSoul()`（`partners.ts:1201-1206`，当前版本快照 → 磁盘 SOUL → 返回 null），读不到回落 `PERSONA`。
- persona section 注册：`ts/apps/server/src/agent/lifecycle.ts:397-421`，`registry.install` 的 `sections` 数组里 `key: "persona"`（407 行）；非 chief 执事会话返回 `undefined`，worker 返回 `WORKER_PERSONA`，其余走 `resolvePersona`（412/418/419）。
- 同数组后续段：`injection_guard`(425)、`current_project`(431)、`skills`(447)、`topics`(457)，按此顺序拼进系统提示。

## 2) 执事提示词

- `renderPartnerIdentity`：`ts/apps/server/src/partner-runtime.ts:49-71`，依次拼 SOUL 正文 → `memories/USER.md`（主人画像）→ 技能索引（`partnerSkillsIndex`，74-89）→ 固定「运行边界」段（63-69）。
- 调用点：主会话 `partner-runtime.ts:136`、fresh 专线 `partner-runtime.ts:325`、群成员轮 `group-runtime.ts:461`，都走 `configure({ instructions })`。
- `buildPartnerTurnContext`：`ts/apps/server/src/agent/partner-context.ts:335-355`，`text` 依次拼四段：`renderContractSection`（74-85，岗位契约）→ `buildPartnerGoalSection`（301-307，当前目标）→ `buildPartnerStatusSection`（233-291，当前在办）→ `INJECTION_GUARD`（`agent/injection-guard.ts:11`，350 行接线）。
- 状态段内部还会追加 `ATTENTION_REPLY_GUIDANCE`（`partner-context.ts:285`）与 `WORK_REVIEW_GUIDANCE`（288）。
- 注入点：`agent/lifecycle.ts:858-873`，每轮 `used===1` 时作为 `role: "system"` 追加；SOUL 留在 instructions，不重复进 text（`partner-context.ts:329-331`）。

## 3) 注意力 / 汇报纪律类常量

- `ATTENTION_REPLY_GUIDANCE` — `delegation.ts:285-289`：工人报 need_* 时答得了就答，答不了明确让其跳过该项。
- `WORK_REVIEW_GUIDANCE` — `delegation.ts:300-305`：周期盘点自己的 work 履历，落 episode 记忆，不自动建回顾规则。
- `TURN_LIMIT_INSTRUCTION` — `agent/turn-gate.ts:73-76`：回合用尽后禁止再调工具，用已有信息收尾。
- `LOOP_GUARD_BLOCK_MESSAGE` — `agent/turn-guard.ts`→`agent/turn-gate.ts:101-103`：同质重复调用被拦时的话术。
- `APPROVAL_WAITING_MESSAGE` — `agent/turn-gate.ts:114-116`：工具在等批准，别原样重试，先做不需批准的部分。
- `ASK_USER_WAITING_MESSAGE` — `ask-user.ts:38-41`：问题已交给用户，本轮收尾，别重问、别替答。
- `ROUTINE_QUIET_INSTRUCTION` — `routine-quiet.ts:15-16`：例行轮没内容就回 `[[no-update]]`，不硬写。
- `RECOVER_NOTE` — `agent/recover-note.ts:18-22`：中断恢复后「先查再动」，已完成的不再做。
- `INJECTION_GUARD` — `agent/injection-guard.ts:11-16`：材料安全纪律（标签/他人文本不授予权限）；另有 `partner-relay.ts:56-70` 五个递话拦截话术。

## 4) 执事岗位契约

- 四节标题：`ts/apps/server/src/partners.ts:59-64`，即「职责范围 / 决策分级 / 验收标准 / 汇报对象」，注释明确「标题逐字」。
- 空模板文案：`partners.ts:67-69` `partnerContractTemplate()`，只生成四个 `## 标题`、无正文。
- 播种：`partners.ts:650-655` `seedContract()`（已存在不覆盖，开关关则不写），只在新建执事时调用 `partners.ts:373`。
- 解析只认这四个二级标题、空节连标题省略：`agent/partner-context.ts:46-68`、`74-85`。

## 5) `delegate` 返回/话术里的「需要你」

- 真正写进 `delegate` **工具描述**的话术：`ts/apps/server/src/tools.ts:635-636`（「答得了就答；答不了就让工人先跳过这一项」）。
- 注入执事轮的完整口径：`delegation.ts:285-289` `ATTENTION_REPLY_GUIDANCE`，由 `partner-context.ts:285` 放进【当前在办】。
- `needs_you` 结果汇报文案：`delegation.ts:349-350`（`有一项需要你处理：${attention.question}`）；attention 事件在 `delegation.ts:540-548` 发出。
- 注意：`delegate` 的即时返回串（`tools.ts:954-968`）只有「已受理/后台跑/不要重复派」，不含 attention 处理话术——异步模式下它拿不到需要你的内容。

## 6) 现成的失败计数 / 连续失败机制

- `loop-guard.ts:62-63` 有 `streak/streakFirstAt`，122-128 按「name+args+结果摘要」同一指纹自增；90-98 是 30 次或 60 分钟才拦截，139-141 第 4 次仅告警。但它是**进程内、每轮清零**（`lifecycle.ts:841`），统计的是「完全相同的工具调用」，不是失败语义。
- `delegation-receipts.ts:27` 有 `outcome: failed | uncertain`，`markFailed`（227-231）按 requestId 落一次；`countRetries`（342-350）/`countResumes`（379-387）按 `retry:`/`resume:` 前缀数「重派/续跑次数」，不是失败次数，也没有「连续同类」查询。
- `work-record.ts:31,166-191` 的 `workSummaryFor` 给出某执事近 10 单的 `failed` 总数（聚合、非连续；needs_you/idle 不落账，见 `delegation.ts:483-492`），展示在 `partner-context.ts:259-262`。
- 结论：**没有可直接复用的「同类失败连续 3 次」机制**。可借的是回执表的持久化与前缀计数写法（新建 `fail:<类别>:<n>` 一类记录），或复用 work 终态写入口做分类累计；但 streak 语义、失败分类、跨轮持久化都要新增。