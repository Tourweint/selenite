# 任务书：员工人格化 · 刀三（界面契约卡 · 目标编辑 · 技能口径）
> 状态：已执行（任务书，2026-11-08）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


> 上位方案：《2026-11-08-员工人格化（岗位契约·履历·成长）》§三 E1 界面部分 + E3 技能层（同目录，先读）。
> 执行：CodeBuddy（hy4free）。派单人：总管。基线 `82cd000`（工作区干净）。
> 服务端能力**刀一/刀二已全部就绪**，本刀是收尾：web 界面 + 工具描述口径 + 文档小补。

## 前置事实（2026-11-08 23:0x 核对，以代码为准）

- 服务端已有（勿重复实现）：
  - `PUT /api/v1/partners/:id/contract`（写契约+版本 bump，64KB 上限，`PARTNER_CONTRACT=false` → 400 带说明）；
  - `GET /api/v1/partners/:id` detail 带 `contract` / `contractVersion`（开关关时没有这两列）与 `currentGoal`；
  - `PATCH /api/v1/partners/:id` 接受 `currentGoal`（字符串/null，空=清除，≤1000 字）；
  - `GET /api/v1/partners` **列表没有** contract/currentGoal（别从列表读）。
- web/app.js 已有执事设置区：`csDetail`（详情缓存）、`csCard(...)` 卡片模式、`cs-field`/`cs-textarea is-soul`（SOUL 编辑卡，约 6609 行一带）——照这个模式加卡，别另起炉灶。
- 工具：`remember`（刀一已加 taught 口径）、`partner_skill_write`（执事写自己技能文件，家目录 skills/，第一行=索引用摘要）——都在 `tools.ts`。
- 9-P 手机端已有角色管理屏；**手机侧编辑 UI 不在本次**（那是 lifediary 仓的活），别动 shared、别动 Kotlin。

## 改动项

### 1. 执事设置区加「岗位契约」卡（web/app.js）

- 卡标题「岗位契约」+ 说明文字"调岗用：职责/决策分级/验收标准/汇报对象，改完下一轮生效"；
- textarea 载入 detail 的 `contract`（四节模板与 SOUL 卡同款交互）；保存 → `PUT .../contract` → 成功后刷新 `contractVersion` 显示"v2 · 下一轮生效"；
- `PARTNER_CONTRACT` 关闭时（PUT 回 400 且 message 含"未启用"）卡片降级为只读提示或隐藏——与 detail 无契约列时的空态合并处理；
- 64KB 超限 400 的报错原样透出（服务端文案已是中文）；
- 顺带在 SOUL 卡与契约卡之间保持视觉一致（同 csCard/cs-field 类名）。

### 2. 执事设置区加「当前目标」编辑

- 单行 input（或小 textarea，≤1000 字）载入 detail 的 `currentGoal`，空=无目标；
- 保存 → `PATCH .../currentGoal` → 成功提示"下一轮对话起生效"（目标不版本化，现取现用——提示写"下次对话生效"即可，别写版本号）；
- 清空保存 = 清除目标。

### 3. E3 技能层口径（tools.ts 两处描述）

- `remember` 描述补一句：教的是**方法/步骤**（"这类活怎么做"）而非规矩时，另用 `partner_skill_write` 沉淀成技能文件（有该工具时），规矩本身仍落 preference——两件事不互斥：规矩进偏好（永不删），方法进技能（按需取用）。
- `partner_skill_write` 描述补：被主人教了新方法、或自己总结出可复用的做法时，写成技能文件（文件名=活的名字，第一行=一句索引用摘要），下次同类任务书可直接引用。

### 4. 文档小补

- 接口文档：确认 §2.11 detail 已含 `contract`/`contractVersion`（刀一写过）与 `currentGoal`（刀二写过）；若缺补上，若已在就不动——**只补缺，不重写**。
- README：不动（工具清单刀二已更）。

## 铁律

1. **不许 commit**；变更记录《docs/变更记录/2026-11-08-员工人格化刀三（界面契约卡·目标编辑·技能口径）.md》。
2. **零 shared、零 chancellor、零 Kotlin**；不改服务端行为（只动 web/app.js + tools.ts 描述 + 文档）。
3. web 样式照既有 csCard 模式，不引新依赖、不加全局样式污染（沿用 is-soul 等既有类）。
4. 密钥/日志红线照旧。

## 验证

- `pnpm typecheck` 0 错（app.js 不进 tsc 就以 node --check 或等同语法检查代替，说明用了哪种）。
- `pnpm --filter @lifediary/server test` 全绿（描述改动不破既有用例）。
- `pnpm --filter @lifediary/server http` 全绿（端点没动，纯回归确认）。
- 界面手验归派单人（浏览器真点：改契约→版本 bump→刷新读回；改目标→保存→读回）。

## 交付物

代码（不 commit）+ 变更记录（如实写改了什么/验了什么/没跑什么）。
