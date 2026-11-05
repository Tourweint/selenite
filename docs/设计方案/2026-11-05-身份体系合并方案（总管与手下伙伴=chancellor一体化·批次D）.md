# 身份体系合并方案：总管 + 手下伙伴 = chancellor 一体化（批次D）

> 2026-11-05。用户定调：**主伙伴=总管**（cindy Main Bot 同款，每台一个、权限最高、用户日常只跟他说话）；
> **其他伙伴就是 chancellor 里可以创建的领域角色**（分管宰相），不是另起炉灶的新东西——两套要捏合成
> 一个身份体系。上游：批次A/B/C 已落地（`docs/变更记录/2026-11-05-多agent三批落地….md`）、
> 参考调研（cindy Main Bot / bot-runtime）。
> **状态：D1 已落地（开工前已在工作区）、D2 已实现（2026-11-05）、D3 未开工。** 冲突以 `docs/基线文档/` 与 chancellor 仓库 AGENTS.md 为准。
>
> 下沉落点表（方案只读，结论已下沉；冲突以长期文档为准）：
>
> | 本方案 | 落点 | 状态 |
> |---|---|---|
> | §三 总管身份化（chief / SOUL / 记忆键空间） | `系统架构.md` D15、`接口文档.md` §2.11 | D1 已落地（本任务书范围外，勿动） |
> | §四 D2 `PartnerProfile.domain`、`managerIdentity`、`partner_id`、`archiveManager`、派单注入 | `接口文档.md` §2.11 / `系统架构.md` §7；chancellor `系统架构.md` §六 | **D2 已实现 2026-11-05**，落地记录 `docs/变更记录/2026-11-05-批次D2落地（手下伙伴=chancellor宰相）.md` |
> | §五 D3 `partner_manage` 工具 + C2 高危审批 | 待落地 | **未开工（明确不做）** |

## 〇、一句话

三层身份一体：**总管** = 主对话本体 + SOUL（每台一个）；**手下伙伴** = chancellor 分管宰相穿上
伙伴身份（可创建、有记忆、干的是带工单/worktree/文件验收的真活）；总管管手下（建/停）走高危审批。
批次A/B/C 的产出全部复用，不推翻。

## 一、两边的现状与互补（2026-11-05 双侧核实）

| 能力 | 伙伴体系（宿主，已落地） | chancellor 宰相（已存在） | 捏合后 |
|---|---|---|---|
| 身份 | SOUL.md 版本快照 + 家目录（64KB/原子写/下一轮生效） | **无身份字段**（ManagerMeta 只有 domain/路径/会话id） | 宰相档案 = partner 行 + 领域目录 |
| 会话 | canonical 会话 + 版本记账 | **pi-durable 会话续用**（meta.conversation_id）+ 60% 换段 handoff.md | 宰相继续用自己的会话库（干活的上下文不挪窝） |
| 记忆 | partner:`<id>` 键空间四层 | 隐式（会话续用 + handoff.md + 模型自写 workspace 文件，无代码约定） | v1：宰相记忆留在 chancellor（会话+handoff）；SOUL/USER.md 以文件注入 |
| 干活 | 全工具链但工单体系无 | **工单/worktree/租约/文件验收/恢复全套**（D10-D13） | 手下干真活走 chancellor 全链 |
| 自主 | 例行任务 + 自主轮审批（C） | **全部被动**（无 cron/无审批概念） | 手下的自主触发在宿主侧（例行任务引擎），宰相保持被动 |
| 派活 | delegate 工具（domain 路由） | ensureManager 懒建、manager 子进程 | 总管 delegate domain=派给对应手下 |

**chancellor 侧事实缺口**（决定方案形状）：① `ChancellorRequest` 无 persona 注入点，manager 提示词是
`buildManagerPrompt(meta, project)` 闭包纯函数（worker-main.ts:420 挂载）；② `ManagerMeta` 无身份字段；
③ 领域管理只有 ensure/list，无删除/归档；④ domain 强制小写 ASCII（DOMAIN_PATTERN）；⑤ worker 雇员是
全局 env（角色不能自带手）；⑥ chancellor **不 import 宿主**（AGENTS.md 硬约束，方向必须保持单向）。

## 二、目标形态

```
用户 ──只跟总管说话──▶ 总管（主对话，SOUL 可编辑，global 记忆，delegate 在手）
                          │
                          ├─ delegate(domain=x) ──▶ 手下伙伴 x（= chancellor 宰相 x）
                          │                            ├─ 身份：partner 档案 + SOUL 注入提示词
                          │                            ├─ 干活：工单/worktree/验收（chancellor 原样）
                          │                            └─ 记忆：自己的会话续用 + handoff（chancellor 原样）
                          └─ 例行任务（宿主引擎）──▶ 总管或手下的自主轮（C2 审批把关）
```

## 三、批次D1：总管身份化（宿主内，先行）

1. **主对话 = 总管**：建一个保留 partnerId（`MANAGER_PARTNER_ID` 固定语义，如常量 `chief`），
   canonical 会话链接指向**主对话路径产生的会话**——实现上不迁移旧会话：`partner_session_links`
   记 `role='canonical'` 指向新建总管会话，聊天端点对总管会话照常走现有 chatStream（总管就是一条
   普通会话 + 身份提示词，批次B 已验证的形态）；
2. **PERSONA → SOUL**：agent.ts 的 PERSONA 常量迁为总管 SOUL.md 播种正文（原文照抄，一行不改），
   提示词经 partner-runtime 的版本对齐注入（改 SOUL 下一轮生效；**总管首次升级时 SOUL 默认=旧
   PERSONA，行为零变化**）；
3. **记忆键空间（关键取舍，写死）**：总管**继续读写 `global + session`**（主人现有记忆一条不动，
   他是主人第一人称助手）；`partner:<id>` 只给手下。总管不进伙伴隔离——这是与普通伙伴的刻意差异，
   落系统架构 D15；
4. `partner_skill_write` 对总管会话同样可用（写总管技能库）；
5. 回滚：`CHIEF_PARTNER=false` 一行退回 PERSONA 常量形态。

## 四、批次D2：手下伙伴 = chancellor 宰相（跨仓，契约改动）

### 4.1 契约改动顺序（硬约束"契约只有一份"）

1. **chancellor**：`ChancellorRequest` 加可选 `managerIdentity?: { name: string; soul: string }`
   （≤4KB，宿主侧截断）；`buildManagerPrompt` 加第三参 identity，有值则在「你的身份」段后追加
   `## 你是谁`（SOUL 正文原文）；`ManagerMeta` 加可选 `partner_id`（透记，chancellor 不解读）。
   不 import 宿主、不加依赖——只收两个字符串；
2. **宿主 shared + 接口文档**：`PartnerProfile` 加可选 `domain`（手下伙伴的唯一领域名，小写 ASCII）；
   接口文档 §2.11 补"手下伙伴"语义；App 适配说明加一行（纯增量）；
3. 两端实现。

### 4.2 宿主侧改动

- **建手下伙伴**（`POST /api/v1/partners` 扩展）：body 带 `domain` 时走手下路径——`ensureManager(domain)`
  建宰相目录 + partner 档案（SOUL 播种含"你是 X 领域的负责人"模板）+ `partner_session_links` 记
  `role='delegation', routeKey=<domain>`（链接表 role 枚举扩一型）；删除手下 = 档案删除 + 领域目录
  归档（chancellor 加 `archiveManager`，不物理删——runs 里的工单历史还在）；
- **delegate 注入**：`startDelegation` 按 domain 反查伙伴档案，命中则 `managerIdentity={name, soul}`
  随请求下发（soul 取**当前版本快照**，单次派单内不变）；没档案的 domain 照旧（兼容旧领域）；
- **结果回流**：已有 `reportDelegationResult` 写回"发起派单的会话"——总管派的写回总管会话，手下
  例行轮派的写回手下专线（无需新机制，验证即可）；
- **宰相记忆 v1 边界**：不把宿主记忆引擎塞进 manager 子进程（它是独立 harness）。SOUL/USER.md 以
  文件内容随 identity 注入；宰相的长期记忆仍靠会话续用 + handoff.md（chancellor 已有，够用）。
  宿主 partner:`<id>` 键空间 v1 **不**给宰相用——登记"刻意没有"，防两套记忆互相污染。

### 4.3 chancellor 侧改动清单（保持依赖单向）

`types.ts`（Request/ManagerMeta 可选字段）、`manager-prompt.ts`（第三参）、`index.ts`（透传）、
`worker-main.ts`（挂载处传参）、`manager/registry.ts`（archiveManager + meta.partner_id 读写）。
**不加依赖、不 import 宿主、不改工单/验收/恢复链路。**

## 五、批次D3：总管管手下（工具上架）

- 新工具 `partner_manage`（create/stop/list 手下，**只针对手下**，不能动总管自己）；
- **上架前先进 C2 的 `AUTONOMY_RISK_TOOLS`**（"授予常驻指令/新建完全访问任务"类）——D14 备忘的
  兑现：自主轮里总管建/停手下必弹卡，普通轮按 AGENT_CONFIRM_WRITES 口径；
- domain 命名闸：伙伴名（中文随意）≠ domain（小写 ASCII），建手下时由宿主生成/校验 domain，
  展示名走 partner.name。

## 六、验证

- D1：typecheck + 既有全量回归（PERSONA 行为零变化：探针比对升级前后主对话首轮 system 差异为空）；
- D2：chancellor 侧单测（identity 注入进 prompt 的纯函数断言 + meta.partner_id 读写）+ 宿主探针扩
  （建手下伙伴 → delegate(domain) → 断言宰相目录 meta.partner_id 与提示词含 SOUL 首行 → 结果回流向
  总管会话）；跨仓探针跑 `pnpm --filter @lifediary/server chain` 不回归；
- D3：approval-probe 扩自主轮 partner_manage 弹卡场景。

## 七、明确不做（登记"刻意没有"）

- 宰相不接宿主记忆引擎（两套记忆不混）；worker（codebuddy/qoder/phone）**不是角色**、不给身份
  （它们是手，宰相才是脸）；雇员档位保持全局 env（角色自带手后置）；不做跨电脑手下（等中继矩阵
  那条线）；总管不进 `partner:<id>` 键空间。

## 八、实施顺序

D1（宿主内，半天级）→ D2（跨仓契约，1-2 天）→ D3（工具+审批，半天）。每批落地记
`docs/变更记录/`；chancellor 侧改动在其仓库按其 AGENTS.md 单独记；系统架构 D15
（总管记忆口径）+ D14 备注兑现（RISK_TOOLS）随批回写。
