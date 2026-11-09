# persona 记忆库接入批一：persona_recall 检索工具

日期：2026-11-09 · 上位方案 `docs/设计方案/2026-11-09-persona记忆库接入（检索工具+对话中转归档）.md`
（决策 D-甲 / D-乙 / D-丙 / D-己）。**本批只做读**；写入链（导出器 + voicevault）是批二。

## 改了什么

- 新增 `ts/apps/server/src/persona-ask.ts`：`askPersona()` 以 **argv 数组**起子进程
  `python analysis/ask.py <question> --json --limit N`（不经 shell，`windowsHide`，15s 超时），
  把 ask.py 的六组证据映射成 `PersonaAskResult` / `PersonaHit`（实测字段见下），
  非 JSON / 结构不符 / 超时 / 非零退出 / 启动失败一律 `ok:false` 降级、不抛。
  日志只记问题字数 / 耗时 / ok / 组数，不记 query 原文与 stderr 全文。
- `tools.ts` 条件注册 `persona_recall`（`deps.personaAsk` 注入，tools 不 import persona-ask）：
  按组渲染 `- [组名] 日期｜标题：正文摘要（出处 id）`，正文单条截 160 字；`unknown`
  原文附「注意：」；coverage `gaps` / `gap_months` 附「记忆库在这些时段没有记录」；
  全空给固定文案；`ok:false` 给固定文案（不透内部错误）；群会话与 `recall` 同款跳过。
- `approval-policy.ts`：`WRITE_TOOLS` 加 `persona_recall`（起进程按字面进闸门），
  **不进** `DEFAULT_CRITICAL_TOOLS`。
- `agent/lifecycle.ts`：`personaAskEnabled() && askPersonaAvailable()` 双闸通过才注入。
  默认 `PERSONA_MEMORY_ASK` 未配置 → 工具不上架；`PERSONA_MEMORY_ENABLED=false` 显式关。
  **不改** `recall` / `recallContext` / `buildContext`：本批只走按需工具，不进每轮注入。
- `tool-capability.ts` 登记 `persona_recall`（`destructive: true`、`sideEffectScope: process`、
  `needsApproval: never`），并同步 arch-guard / tool-capability 的工具全集断言。

## 为什么

本地短记忆（`recall`，1200 字符预算）只覆盖近期；问"去年 / 2024 年"或要原文出处时，
需要去 persona 的一生记忆库深查。persona-metric 的 `ask.py` 是它唯一的检索门（`mode=ro`
只读、纯本地 SQL、零模型零网络），子进程调用是改动面最小、无注入面的接法（方案 D-甲 / D-丙）。
persona 仓库本批**零改动**。

## ask.py 实测字段与本任务书 `PersonaHit` 的差异（如实记录）

2026-11-09 真跑 `python analysis/ask.py "四级考了几次" --json --limit 5`：

- `memory_day`：`{id, date, title, body, conf, n_seg, why}` → `title=title, text=body`。
- `fact`：`{id, date, title, body, conf, why}` → 同上。
- `event`：`{id, title, object, span, arc_n, outcome, why}`（**无 date / text/title 口径不同**）
  → `title=title`，`text=span · outcome`。
- `segment`：`{id, date, module, text, kind, conf, why}` → `text=text`，另存 `kind` / `source=module`。
- `entity`：`{id, name, type, role, n_mention, why}`（**无 date**）→ `title=name`，`text=role，提及 N`。
- `tension`：`{id, name, trigger, trigger_type, side_a, side_b, why}`（**无 date**）→
  `title=name`，`text=触发：trigger`。
- coverage 实测还多一个 **`gap_months`**（整月无记录列表，任务书未列）。
  已一并透传，并和 `gaps` 合并渲染成「记忆库在这些时段没有记录」——这条对
  "查不到 ≠ 没有这事" 的提醒比空 `gaps` 有用。`not_searched` / `not_indexed` 只送进结果对象。

## 验证

- `pnpm typecheck`：0 错。
- `pnpm --filter @lifediary/server test`：480 pass / 0 fail（新增 `persona-ask.test.ts`
  7 条；`approval-policy.test.ts` 加 persona 闸门 2 条；arch-guard / tool-capability 全集断言通过）。
- `pnpm --filter @lifediary/server http`：端到端全绿。
- **真探针**（真起服务 + 本地假上游捕获模型侧工具清单 + 真 ask.py）：
  - A `PERSONA_MEMORY_ASK` 配置 + full：工具清单含 `persona_recall: true`，
    模型发起调用，返回 `mem-day-2024-11-24` 等 2024 年证据（含 id / 日期 / 标题 / 摘要）。
  - B 同配置 + `AGENT_TOOL_POLICY=read-only`：工具在清单里，但调用被闸门拦，
    闸门审计落 `{"tool":"persona_recall","reason":"policy"}`。
  - C `PERSONA_MEMORY_ASK` 未配置：模型侧工具清单含 `persona_recall: false`。
  - D `PERSONA_MEMORY_ENABLED=false`（ASK 已配）：同样 `false`。
- **没跑**：真模型（如 qwen/deepseek）端到端问答；本批用假上游只验工具面与契约面。

## 刻意没做

- 不写 persona 任何文件 / 表（探针只读 ask.py）。
- 不改 `recall` / 注入链 / shared / memory 包 / `web/app.js` / `web/style.css`。
- 不做导出器与 voicevault 导入（批二）。
