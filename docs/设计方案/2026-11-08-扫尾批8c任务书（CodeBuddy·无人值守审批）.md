# 任务书：扫尾批 8c——无人值守审批（等待态落库，答复触发续跑）
> 状态：已执行（任务书，2026-11-08）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


> 派单人：总管。执行人：CodeBuddy。日期：2026-11-08。
> 上位方案：`docs/设计方案/2026-11-08-扫尾批8c方案（无人值守审批）.md`（**语义以它为准**，含"模型重发调用而非结果回填"的取舍）。
> 范围：`ts/apps/server/src/agent/policy.ts` + `turn-gate.ts` + `session.ts` + `approvals*.ts` + web 审批卡文案。8b 已把 agent.ts 拆成 `agent/` 六模块——在新结构上干活。
> 注意：agent.ts 现在是桶 89 行，改逻辑去 `agent/` 子模块，别往桶里写。

## 铁律

不许 `git commit`；语义以方案为界（放行清单防骗、pending 永不过期、回滚开关三个要素一条不改）；完成后 `pnpm typecheck`、单测（含新增）、`approval` + `settings` + `http` 探针全绿。

## 逐项

### 1. 审批不阻塞本轮（方案 §二.1-2）

- `agent/turn-gate.ts` 的 `waitForApproval` 阻塞等待退役：beforeTool 拦到需审批工具 → 落 pending（既有 approvals 设施，**带 toolName + args 与 args 哈希**）→ 对该调用回拒绝性答复（人话："该操作等待用户批准，批准后我会继续"）→ 本轮照常收尾。
- **pending 永不过期**：`approvals.ts` 启动遗留置 timeout 的行为取消（保留可答）；`AGENT_APPROVAL_TIMEOUT_S` 退役为回滚形态专用（blocking 模式用）。

### 2. 放行清单 + 答复触发续跑（方案 §二.3-5）

- 新增一次性放行清单（approvals 存储内）：`approve` → 记 `{toolName, argsHash}` → 服务端向该会话自动提交 followUp 指令（人话模板照方案：告知已批准 + 要求**立即重新发起同一个工具调用**）。
- 闸门查放行清单：命中同 toolName + 同 argsHash → 放行并**核销**；同 tool 不同 args → 不放行（重新走审批，防"批了 A 执行 B"）。
- `reject` → 同样 followUp（"用户拒绝了 X：请继续其余工作"）。
- args 哈希 = 稳定序列化后 sha256（json 键排序），放 `agent/` 内纯函数 + 单测。

### 3. 回滚开关（方案 §三）

`AGENT_APPROVAL_MODE=blocking` → 完整回到旧阻塞形态（120s 等待、启动遗留置 timeout、倒计时 UI），旧代码路径保留不删；缺省 = 新形态。开关判定进 `agent/policy.ts` 并经 `/agent/policy` 投影（前端据此切换文案：新形态无倒计时显示"等待处理"）。

### 4. 前端（web，小改）

审批卡：blocking 模式保留倒计时；新形态显示"等待处理"（无倒计时）；其余（来源标注/手机端）不动。

### 5. 探针与测试（方案 §四逐条）

approval 探针扩展六场景（不阻塞收尾 / approve→followUp→重发→核销放行→执行 / 换 args 重新审批 / reject→继续 / 重启 pending 可答 / blocking 回滚全绿）；单测：argsHash 稳定性、核销幂等、清单清理。

## 明确不做

不做"全部批准"；不做工具结果回填（内核无口，登记）；不改手机端；不动审批来源标注（批 5 刚做）。

## 汇报格式

1. 逐项：改动落点（新结构下的文件）、followUp 指令最终文案、放行清单实现。
2. 验证原文：typecheck / 单测数 / approval+settings+http 探针关键行（六场景逐条）。
3. 文档回写清单（接口文档 §2.5/§2.18 + 系统架构 D6 + 变更记录《2026-11-08-扫尾批8c》）。
4. 不确定点（发现方案语义对不上就停下写明）。
