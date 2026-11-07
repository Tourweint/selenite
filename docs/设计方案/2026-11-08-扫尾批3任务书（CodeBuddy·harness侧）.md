# 任务书：扫尾批 3-H（harness 侧）——设备活豁免项目前置 + relay 投影带 dispatchAuthority

> 派单人：总管（ZCode）。执行人：CodeBuddy（hy4free）。日期：2026-11-08。
> 上位方案：`docs/设计方案/2026-11-08-扫尾批3方案（手机端接入·跨仓契约）.md`（语义以它为准）。
> 范围：本仓 `ts/` + 基线文档。**不碰手机仓**。

## 铁律

1. 不许 `git commit`；只改本任务书范围；不做无关重构；语义以方案为界。
2. 完成后跑：`pnpm typecheck`、`pnpm --filter @lifediary/server test`、你扩展的探针、`pnpm --filter @lifediary/server phone`（设备链路回归）。

## 逐项

### 1. B3 设备活豁免项目前置（方案 §一）

- 先定位"执行体类型"的判别字段：`delegate` 工具入参里设备 worker 怎么表达（worker 类型 / targetDevice / domain 路由，查 `tools.ts` 的 delegate execute、`delegate-routing.ts`、`resolveDelegationProject` 的调用点；2026-11-03《外部执行三档统一适配》里 codebuddy/qoder/phone 是三档雇员）。
- 规则：执行体 = 设备 worker（phone / 带明确 targetDevice 的设备派发）→ 项目前置豁免：`project` 可省，走无项目单受理（设备活不进 worktree/租约）；本机执行体照旧 `needs_project`。
- 回滚：`DELEGATION_DEVICE_PROJECT_EXEMPT=false` → 设备活也要项目（回到现行为）。env 读法与相邻 `DELEGATION_PROJECT_REQUIRED` 一致。
- 探针：在覆盖 delegate 前置的既有探针里补场景——设备活无项目受理 ✓；本机活无项目仍 `needs_project` ✓；开关关后设备活也 `needs_project` ✓。env-before-import 纪律照旧。
- 注意豁免只放行**前置**，别把 `resolveDelegationProject` 的 realpath 校验等本地路径逻辑误伤（设备活根本不该进那段）。

### 2. relay 设备投影补 `dispatchAuthority`（为后批手机执事管理铺底）

- 找到执事档案 `dispatch_authority`（partners.ts / 执事派发权开关 2026-11-06）在 relay 侧对外投影的合理落点（`/api/v1/relay/overview` 的设备/执事段），补字段 + 投影测试/探针断言。**只加字段不改既有形状**（消费方后批才来）。
- 若投影结构上放不进（比如 relay 名册根本不认识执事 id），不硬塞：汇报里写清结构原因与建议落点，留后批。

### 3. 文档回写

- 接口文档：delegate 工具节补豁免规则与回滚 env；env 表补 `DELEGATION_DEVICE_PROJECT_EXEMPT`；relay 投影若加了字段，对应节补字段说明。
- 系统架构：D10 行注记设备豁免规则（一行）。
- 变更记录：《2026-11-08-扫尾批3-H（设备活豁免与relay投影字段）.md》。

## 明确不做

不碰手机仓；不做手机侧任何 UI；不动 worktree/租约语义；不做设备活的项目"建议"提示。

## 汇报格式

1. 逐项：判别字段最终用什么（代码证据）、豁免落点、投影落点（或放不进的原因）。
2. 验证原文：typecheck / 单测 / 探针关键行。
3. 文档回写清单。4. 不确定点。
