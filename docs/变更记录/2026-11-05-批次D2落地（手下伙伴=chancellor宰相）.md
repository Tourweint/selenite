# 变更记录：批次D2 落地——手下伙伴 = chancellor 分管宰相（跨仓）

- 日期：2026-11-05
- 范围：宿主仓 `ts/packages/shared/src/index.ts`、`ts/apps/server/src/{partners,companion-api,delegation,tools}.ts`、`ts/apps/server/package.json`、`docs/基线文档/{接口文档,系统架构}.md`、设计方案文首状态；新增 `ts/apps/server/src/partner-delegation.test.ts`、`ts/apps/server/scripts/d2-partner-probe.ts`。chancellor 仓改动见其仓库 `docs/变更记录/2026-11-05-手下伙伴身份注入（批次D D2）.md`
- 依据：`docs/设计方案/2026-11-05-身份体系合并方案（总管与手下伙伴=chancellor一体化·批次D）.md` §四；`.data/mission-briefs/D2-ministers-as-partners.md`

## 背景

批次D 把「总管 / 手下伙伴」与 chancellor 分管宰相捏成一个身份体系。D1（总管身份化）开工前已在工作区落地，本批只做 D2：让带 `domain` 的伙伴 = 该领域的分管宰相，派单时把伙伴身份注入 chancellor，删手下时归档领域目录。D3 不做。

## 改了什么

**契约（先文档后代码，§7 顺序）**
1. `docs/基线文档/接口文档.md` §2.11 补「手下伙伴」语义、POST 可选 `domain` / 投影带 `domain` / DELETE 归档 / PATCH 不改 domain。
2. `ts/packages/shared/src/index.ts` 的 `PartnerProfileSchema` 加可选 `domain`（正则同 chancellor `DOMAIN_PATTERN`），纯增量、App 零改动。

**宿主实现**
3. `partners.ts`：`partners` 表加 `domain` 列（`CREATE TABLE` + 沿用 `delegation-receipts.ts` 的 `PRAGMA table_info` → `ALTER TABLE` 旧库补列）；`PartnerRow.domain`、`PartnerSessionLinkRow.role` 扩 `'delegation'`；`create(name, opts?)` 支持 domain + 一句话 SOUL 播种 + `linkDelegation`（`session_id=0` 占位）；`partnerIdByDomain`、`partnerIdentityForDomain`（**取当前版本快照，不读磁盘当前值**）、`delegationSoulSeed`；`partnerIdOfSession` 加 `session_id > 0` 过滤占位行；`toPartner` 投影 domain。既有 `UNIQUE (partner_id, role, route_key)` 已覆盖 delegation 组合，无约束变更。
4. `companion-api.ts`：POST 校验 `DOMAIN_PATTERN` + 重复 domain 400 + `ensureManager(chancellorWorkRoot(), domain, { partnerId })`（失败回滚刚建档案）；PATCH 带 domain 一律 400；DELETE 手下先 `archiveManager` 再删档案（归档失败只 warn、不挡删除）；`projection` 纯增量带 domain（普通伙伴响应不含该字段，行为零变化）。
5. `delegation.ts`：导出纯函数 `buildManagerIdentity`（按 UTF-8 字节截 ≤4KB、不切坏多字节字符）+ `MANAGER_SOUL_LIMIT_BYTES`；`DelegationRuntime.identityHitFor` 测试/装配缝；`startDelegation` 在派单开始时取一次身份快照并写入两张新派请求。
6. `tools.ts`：`localIdentityHit` 只在本机 delegate 装配（`COMPANIONS_ENABLED` 关 / 库不可用返回 null 兼容旧领域）；relay-matrix 远程锚点不装配 → 「不做跨电脑手下」在装配层成立。
7. `package.json`：`test` 列表加新单测；新增 `d2` 探针脚本。

**chancellor 仓**（详见其变更记录）：`ChancellorRequest.managerIdentity`、`buildManagerPrompt` 第三参、`worker-main.ts` / `employee/manager.ts` / `index.ts` 透传、`ManagerMeta.partner_id` + `ensureManager opts`、`archiveManager`、单测、`test` 脚本；并补 `childTickets` 的 `Store.close()`（Windows 归档 EPERM 的根因修复，不改闸门语义）。

## 验证

```
> pnpm typecheck
> node node_modules/typescript/bin/tsc --noEmit
（无输出，exit 0）

> pnpm --filter @lifediary/server test
ℹ tests 193 / ℹ pass 193 / ℹ fail 0
（开工前基准 186 过；新增 partner-delegation.test.ts 7 条：domain 校验 / 旧库补列 /
 身份快照不读磁盘 / buildManagerIdentity 4KB 截断 / startDelegation 命中与不命中 / archive 幂等）

> pnpm --filter @lifediary/server companion
✓ 建伙伴 / 详情身份版本 / 跑一轮 / 改 SOUL / 候选链 keyEnv / 例行任务 / 删伙伴 …全绿

> pnpm --filter @lifediary/server d2   （新增探针：真起服务 + faux）
✓ 非法 domain → 400 / 普通伙伴行为不变 / 建手下 201 + domain 回显 / 重复 domain 400
✓ GET /:id domain 回显 + SOUL 一句话播种 / PATCH 改 domain 400
✓ 宰相目录 meta.json 的 partner_id == 伙伴 id / listManagers 带出
✓ buildManagerIdentity 纯函数 / startDelegation 请求含 managerIdentity（可测缝）
✓ chancellor faux domain 派单整链不报错（ticketId=… status=done）
✓ chancellor 自己的 ensureManager 不冲掉 partner_id
✓ DELETE 200 / 原目录不在 / .archived- 前缀 / runs 历史保留 / listManagers 不再列出
✓ 普通伙伴仍在 / 服务日志无异常
✓ D2 手下伙伴探针全部通过（18 项）
```

chancellor 仓：`npm run typecheck` 0 错、`npm test` 6/6、`npm run probe` 全绿。

## 没验证到的 / 已知预存问题

- **`pnpm --filter @lifediary/server http` 有 2 项红**：`工作区内相对路径放行` 与 `模型收到的工具结果含「路径越出最大工作区」`（§14.4/14.5 路径守卫）。在**干净的 HEAD worktree**（`2df8271`）上该探针 `✓ 端到端全部通过`；把本批 D2-only 的 4 个源文件（tools / companion-api / delegation / shared）回退到 HEAD 后两项仍红；`CHIEF_PARTNER=false`、`COMPANIONS_ENABLED=false` 两个回滚开关也都不能消除。D2 未触碰 `agent.ts` / `path-guard.ts` / `projects.ts` / 系统提示 / 工具注册，`partners.ts` 里的 D2 改动是纯增量（新列 / 新方法 / 查询守卫，均未进入路径守卫链路），因此判为**开工前就存在的未提交改动**（D1 / 界面第九轮）引入；未做「`partners.ts` 也单独回退」的完全隔离，这一层单列为不确定。此探针不在任务书验证要求内；覆盖 D2 端点改动的 `companion` 探针全绿、单测 193/193 全绿。**单列，不假装覆盖**。
- **App 适配说明**（`接口文档.md` §7 要求同步的外部仓 `<lifediary 手机仓>` §4.5 差异表）未改：任务书限定只改两个仓库、且明确「App 零改动」。改在宿主侧 `接口文档.md` §2.11 记了「纯增量、老客户端忽略未知字段」一行代替。
- 真实模型下分管宰相是否**照着**注入的 `## 你是谁` 行事未验证（faux 不读提示词）；只验了提示词里有该节、整条透传链不报错、请求含 `managerIdentity`。
- `partner_session_links` 的 `session_id=0` 是占位（宰相会话在 chancellor 自己的库里，宿主无对应 durable 会话）；已加 `session_id > 0` 过滤防误认，未做真实会话 id 为 0 的实测。
- 任务书头标注 chancellor「基线 `9587482`」：该提交实际是**宿主仓**的提交（`docs: 中继与设备矩阵契约…批次A/B/C回写`），chancellor 仓 HEAD 为 `f22ca08` 且有一批开工前未提交改动（恢复链路单笔回滚 / 验收临时窗口）。两仓文件级前置事实均核对无误，故按当前工作树增量施工、未 reset、未覆盖既有未提交改动；基线哈希与现状的出处差异单列于此。
- 任务书 A.3「不加删除/归档（不在本批）」与 B.2 / 验证要求 3「新增 `archiveManager`」字面冲突。按 B.2 + 设计方案 §4.3 + 验收要求（删手下必须断言 `.archived-` 前缀）实现 `archiveManager`；A.3 解释为「不给 `ManagerMeta` 加删除/归档**状态字段**」——归档用目录改名表达，不加字段。
