# 变更记录：批次D3 落地——总管管手下（partner_manage 工具 + 自主轮审批）

- 日期：2026-11-05
- 范围：新增 `ts/apps/server/src/{partner-manage.ts,partner-manage.test.ts}`、`ts/apps/server/scripts/d3-partner-manage-probe.ts`；改 `ts/apps/server/src/{companion-api,tools,approval-policy,autonomy-risk,provider}.ts`、`autonomy-risk.test.ts`、`ts/apps/server/package.json`。**不碰 chancellor、不改 shared 契约、不动 HTTP 端点对外形状**。
- 依据：`docs/设计方案/2026-11-05-身份体系合并方案（总管与手下伙伴=chancellor一体化·批次D）.md` §五；`.data/mission-briefs/D3-partner-manage.md`（唯一口径）。

## 背景

D1（总管身份化）、D2（手下伙伴 = chancellor 宰相，建/删已有 HTTP 端点）已交付。本批只做 D3：给模型侧一个 `partner_manage` 入口（create/stop/list 手下），并把它纳入写类闸门与自主轮强制审批（D14 备忘兑现）。核心建/删逻辑**复用 D2，不重写**。

## 改了什么

1. **抽核心（唯一实现）**：新增 `partner-manage.ts` 的 `createMinisterPartner` / `stopMinisterPartner` / `listMinisterPartners` + `MinisterContext`（注入 store/workRoot，生产默认 `partnersStore()` + `chancellorWorkRoot()`，单测传临时目录）。`companion-api.ts` 的 POST（带 domain 分支）与 DELETE 改为调这些函数，端点对外 400/201/404 消息逐字保留、普通伙伴路径行为不变。
2. **新工具 `partner_manage`**（`tools.ts`）：`action=create|stop|list`，create 复用建手下（校验 + 回滚都在核心里，工具只做必填校验与模型友好文案「手下 X 已就位，domain=y，之后派活用 domain」）；stop 复用删手下（archiveManager 归档 + 档案删除）且**拒停 chief**；list 只投影名字/domain/状态、不回显内部会话 id / uuid。权限闸：`effectivePartnerIdOfSession` 落到非 chief 的伙伴会话直接拒「只有总管可以管理手下」，主对话（owner）放行。挂在 `deps.partners ?? COMPANIONS_ENABLED` 下——`COMPANIONS_ENABLED=false` 一行回滚（与伙伴技能工具同开关）。
3. **进闸门 + 自主轮审批**：`approval-policy.ts` 的 `WRITE_TOOLS` 加 `partner_manage`（建/停角色属「授予常驻指令/新建任务」类）；`autonomy-risk.ts` 的 `AUTONOMY_RISK_TOOLS` 加 `partner_manage: "new_task"`（与 delegate/propose_project 并列，自主轮强制 ask、禁记住绕过）。arch-guard 闸门完整性测试自然覆盖（注册全集 = WRITE_TOOLS ∪ READ_TOOLS）。
4. **faux 探针缝**：`provider.ts` 的 `fauxConfig` 支持 `LLM_FAUX_ARGS`（JSON 对象给 faux 工具调用塞参数）；不配时行为与改动前逐字一致，仅测试用。
5. **单测/探针/脚本**：`partner-manage.test.ts`（临时目录）覆盖 create 成功/非法 domain/重复 domain/非总管会话拒、stop 正常/拒 chief、list 投影；`autonomy-risk.test.ts` 补自主轮 verdict 断言；`package.json` 把新单测加进 `test` 列表、新增 `d3` 脚本。

## 验证

```
> pnpm typecheck                              （无输出，exit 0）
> pnpm --filter @lifediary/server test       ℹ tests 203 / pass 203 / fail 0（基准 193 + 新增 10）
> pnpm --filter @lifediary/server d2         ✓ D2 手下伙伴探针全部通过（端点复用零回归，18 项）
> pnpm --filter @lifediary/server d3         ✓ D3 partner_manage 探针全部通过（11 项）
> pnpm --filter @lifediary/server companion  ✓ 全绿（companion-api 重构回归）
> pnpm --filter @lifediary/server chief      ✓ 全绿（默认工具集回归）
```

D3 探针：真起服务 + faux + `LLM_FAUX_TOOL=partner_manage`，阶段一驱动一轮真实对话让 faux 调 create → 断言 partners 表 + 宰相目录 `meta.partner_id` + SOUL 播种；复用同隔离根目录重启服务、阶段二驱动 stop → 断言档案 404 + 领域目录 `.archived-` 归档 + `listManagers` 不再列出。任务书注：faux 走默认 policy（confirmWrites 关），create 不弹审批是预期；自主轮弹卡由单测覆盖 verdict，未端到端。

## 没验证到的 / 刻意没有

- 自主轮**真实弹卡交互**未端到端：按任务书只覆盖 `autonomyRiskVerdict` 的 forceAsk/category 断言，未驱动一轮带 `AUTONOMY_ENABLED` 的真对话看审批卡。
- 任务书明确不做：不改 chancellor、不做跨电脑手下、不给 worker 身份、不改 shared 契约、工具不进对外契约、PERSONA/SOUL 体系不动——均未触碰；HTTP 端点只抽函数复用、对外形状零变化。
- `soul` 长度在工具侧设了 4000 字符护栏（核心的 64KB 槽位护栏在 partners.ts 仍在）；超长 `soul` 的真实模型输入未做端到端验证。
- 设计方案文首「D3 未开工」状态行未改：设计方案按仓库口径只读留「当时怎么想的」，本落地结论以本记录 + 长期基线文档为准。
