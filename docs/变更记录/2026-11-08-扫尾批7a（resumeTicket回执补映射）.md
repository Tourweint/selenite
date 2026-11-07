# 变更记录：扫尾批 7a（resumeTicket 回执补映射）

- 日期：2026-11-08
- 范围：`ts/apps/server/src/{delegation-receipts.ts,tools.ts,delegation-receipts.test.ts}`、
  `ts/apps/server/scripts/delegate-resume-probe.ts`、`docs/基线文档/系统架构.md` §7
- 依据：`docs/设计方案/2026-11-08-扫尾批7a任务书（CodeBuddy·resumeTicket回执）.md`
  （上位：扫尾计划 A6；缺口登记见 `docs/变更记录/2026-11-04-批次四落地（恢复回灌）.md`）

## 背景

A3a/A3b 的会话回灌靠受理回执里的 ticket→conversation 映射。`delegate` 的 resume 分支
（`tools.ts` 里 `resumeTicketId !== undefined` 那条）**整段不碰回执**：续跑沿用原单、不建新单，
于是也没有新回执，重启恢复只能按最初派单那行回灌——用户后来在别的对话里回答过这张单，
结算那行仍然落回原对话。本批只补这一半；"续跑中单的完成不实时回灌"维持登记。

## 改了什么

1. **`delegation-receipts.ts` 新增 `recordResume(ticketId, conversationId)` + `countResumes(ticketId)`**：
   写一行 `requestId = resume:<原单id>:<次数>` 的回执，`ticket_id` 仍是原单号，`outcome = accepted`，
   `conversation_id` = 这次发起 resume 的会话。实现走既有 `begin()` + `accept()`，不新增列、不改行格式。
2. **`tools.ts` 受理后补映射**：`startDelegation` 返回后、常规回执那段之前，加
   `if (resumeTicketId !== undefined && !fellBack) receiptsOf(deps).recordResume(resumeTicketId, conversationId)`。
   键取 `resumeTicketId` 而不是 `ticketId`（后者靠事件同步段填，且 chancellor `resumeTicket()` 返回的就是
   `ticket.id`）；改派新单（`fellBack`）不写，否则记的是一张不存在的续跑。
3. **回执单测**：`delegation-receipts.test.ts` 增一例（两次 resume 各一行、反查取最新、
   `DELEGATION_MAP_PERSIST=false` 时一行不落、空单号不落）。
4. **探针**：`delegate-resume-probe.ts` 新增第 7 组（原 7/8 顺延为 8/9），`makeFake` 加 `prefix`、
   `makeTools` 加 `requestId` 入参，用"同一显式 requestId 从另一条会话再提 → 冲突分支交出原单指针
   → 该会话 resume"这条真实路径构造"续跑会话 ≠ 原派单会话"。
5. **文档**：`系统架构.md` §7 该条改写（resume 过的单已回灌、恢复端取数口径、回滚开关、
   仍登记观察的那半）。

## 幂等键取法与理由

`resume:<原单id>:<次数>`，与重试的 `retry:<原单id>:<次数>` 同构：

- **带次数**：同一张单可能被反复 resume（问一次、答一次、再问再答）。固定成 `resume:<单号>`
  的话第二次 `begin()` 会走 `explicit → existing` 直接返回，**映射停在第一次那个会话**，
  最新一次 resume 反而丢了。次数从已有行数推（`countResumes`），每次都落新行、幂等键不撞。
- **前缀精确匹配**：`countResumes` 用 `substr(request_id, 1, ?) = ?` 而不是 `LIKE`
  （单号里可能有 `%` / `_`），与 `countRetries` 一致。
- **重启后能读到**：映射落在 SQLite（`.data/delegations.sqlite`），恢复端只认
  `lookupByTicket(ticketId)`，所以键怎么起名不重要，**行的 ticket_id 与 conversation_id 才是契约**——
  写法就是按"恢复消费端怎么查"反推的。
- **并发撞车**：同一毫秒内两次算到同一个次数时，`begin()` 返回 `existing`，直接返回不覆盖，
  不抛错（先去的那行说了算）。

## 恢复端取数口径结论（未改代码）

`lookupByTicket` 的 SQL 是 `WHERE ticket_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`，
即 **latest-wins**（同毫秒并列看 rowid）。resume 行总是后写、rowid 更大，所以"原始单 + resume 单
两条回执"时天然取到 resume 那行；多次 resume 取最近一次。**恢复端 `recovery-report.ts` 一个字没改**，
探针把这条行为钉死（7.3 换成第三条会话后仍指最新）。

## 验证

```
$ cd ts && pnpm typecheck
> tsc --noEmit
exit=0

$ pnpm --filter @lifediary/server exec tsx --test src/delegation-receipts.test.ts
ℹ tests 11 / pass 11 / fail 0
✔ 续跑回执：每次 resume 各一行，反查取最新；开关关掉一行都不落 (27.0151ms)

$ pnpm --filter @lifediary/server resume
  ✓ 原单回执仍挂在派单会话 802 — 802
  ✓ 冲突分支把原单指针交给 803 — 该请求号已受理过，返回原单 R1，没有重复派。后台跑完会汇报。
  ✓ 803 续跑的是原单 R1 — 续上了：验证码 1234 / （已把用户的回答交回原单，它在接着做。）
  ✓ resume 回执存在并指向发起会话 803 — requestId=resume:R1:1 conversationId=803
  ✓ 最新回执不再指向原派单会话
  ✓ 重启恢复回灌落到 resume 会话 803（不是原会话 802） — [[803,"上一进程留下的派活单 R1 已终态：done"]]
  ✓ 同一单第二次 resume 不报错 — 续上了：再答一次 / （已把用户的回答交回原单，它在接着做。）
  ✓ 两次 resume 各留一行（resume:R1:1 / :2），反查取最新 — resume:R1:2
  ✓ resume 次数累计为 2 — 2
  ✓ 再次换会话 resume → 最新回执指向 804（latest-wins） — requestId=resume:R1:3 conversationId=804
  ✓ DELEGATION_MAP_PERSIST=false → 不落 resume 回执，映射保持原样 — count=3
✓ 续跑路由 / 取消重试全部通过

$ pnpm --filter @lifediary/server concurrent
✓ 同会话并发派单全部通过（10 项全绿）

$ pnpm --filter @lifediary/server test
ℹ tests 315 / pass 314 / fail 1
✖ 父单：子单全终态且没有失败/中止时保持 done（`src/delegation-closure.test.ts:71`，'idle' !== 'done'）
```

最后那条**与本批无关，且不是本批引入**：把本批 4 个改动文件 `git stash` 后在干净工作区复跑
`src/delegation-closure.test.ts`，同一条照旧失败（stash 前后断言语句、实际值 `idle` / 期望值 `done`
完全一致）。它验的是 chancellor 的 `enforceChildClosure`，而 `<chancellor>` 现有一批
未提交改动（非本批、本批未触碰）。按"不动 chancellor 仓"的铁律本批不修，留给 chancellor 侧处理。

## 没验证到的 / 不确定点

- **`DELEGATION_MAP_PERSIST=false` 的真实回滚端到端**：只验了"回执库一行不落"，没跑真重启；
  按代码路径它与改动前等价（resume 分支此前完全不碰回执）。
- **`fellBack`（续跑被拒 → 改派新单）仍没有回执**：这条路径本来就绕开回执段（`receipts` 为 null），
  本批按任务书范围没有顺带补——改派出的**新单**重启后依旧回灌不到。属于另一个缺口，登记在这里。
- **并发同毫秒两次 resume**：代码里"撞到 existing 就不覆盖、不抛错"，但没有专门造并发用例；
  真实场景是一句一句答，撞车概率低。
- **`countActive()` 会被 resume 行抬一点**：它按 `outcome IN ('accepting','accepted')` 计数，
  而回执从不到终态（旧行也一样），所以"在跑单数"本来就是累计受理数；同单多次 resume 每次 +1。
  只影响设备矩阵的忙碌提示口径，未改（改它等于动不相干的语义）。
- 真机端到端（真实重启 + 手机端看那行状态）没有观测，与批次四同口径。

## 验收结论（2026-11-08，派单人验收后补）

- 验收通过。独立复跑：typecheck 0 错、resume/concurrent 探针全绿、单测 **316/316**。
- **跨仓联动一处（派单人处理）**：本批在 chancellor 仓同步修了 `enforceChildClosure`（idle 子单
  不再算终态，chancellor 提交 516979e），harness 侧直测 chancellor 行为的
  `delegation-closure.test.ts` 随之更新语义断言（idle 子单 → 父单 idle 不谎报 done；全真终态
  才保持 done）。执行者汇报里"该失败与本批无关"的判断不准确——失败根源正是 chancellor 那刀，
  属跨仓联动的预期回声，已按新语义修绿。
- 幂等键 `resume:<原单id>:<次数>` 与恢复端 latest-wins 的推导正确（执行者还主动纠正了探针
  初稿把映射写到假单号上的坑）；`fellBack` 改派路径仍无回执，登记为剩余缺口。
