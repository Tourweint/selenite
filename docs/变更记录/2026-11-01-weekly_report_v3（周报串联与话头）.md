# weekly_report_v3：周报串联 + 输出话头

- 日期：2026-11-01
- 来源：App 侧需求方拍板「C 案」（回顾页合并为一个区块），配套 App 变更记录
  `lifediary/docs/变更记录/2026-11-01-周报串联与话头合并（C 案）.md`

## 背景

`weekly` 任务原用 `weekly_report_v2.md`（本周事实 + 画像）。回顾页原先还有一个独立的
`diary_review`（近 7 天回顾）并排展示，两个时间轴在同一页上打架（固定"最近 7 天"却不跟周切换器走），
页面上还并排出现两段 AI 散文。App 侧决定把话头并进周报，并让周报自己串联上一周。

## 决策

- `weekly` 切到 **v3**（`prompts/weekly_report_v3.md`），变量从 2 个变 3 个：
  `positive_facts` / `profile_markdown` / **`previous_week_context`**（上一周的整段回顾，或上周事实摘要）。
- 模板在 v2 基础上只加两处：①上周回顾作为**背景**（明确写"不是本周事实"、接不上就跳过、
  **不许为串联编造因果**）；②输出追加 2~3 行 `▶` 话头（来自本周事实或上周没说完的话，没有就一行都不输出）。
- `diary_review` 任务**保留**（模板与变量不变），App 侧只是不再调用；未来「回忆模式」可复用。
- v2 资产保留可回退；回退 = 改 `tasks.ts` 一行。

## 变更清单

- 新增 `apps/server/prompts/weekly_report_v3.md`（与 App `core/ai/src/main/assets/prompts/` 逐字节一致）
- `apps/server/src/tasks.ts`：`weekly` → `weekly_report_v3.md`，`vars` 加 `previous_week_context`
- `apps/server/scripts/task-probe.ts`：`VARS.weekly` 补 `previous_week_context`

## 影响范围

- 多传变量不报错，**少传才 500 `task_render_failed`**；因此 App 必须先升级（或两边同进同退）。
- 无端点、无鉴权、无存储结构变更。

## 验证

- `pnpm typecheck` 通过
- `pnpm --filter @lifediary/server tasks` 全绿，含
  `✓ weekly_report_v3.md 与 App 现版逐字节一致（weekly） — 792 / 792 字符`
