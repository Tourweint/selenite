# 个人长期记忆检索技能（persona_memory）· 2026-11-16

**背景**：用户把 `persona-metric` 定位为"比较全面的个人记忆库"（不是医生记忆），希望 Agent 能检索它。
工具 `persona_recall` 早已存在（`persona-ask.ts` → `ask.py --json`，`PERSONA_MEMORY_ASK` 已配置），
但模型只看到一句工具描述，不知道怎么问、怎么读六组证据、什么时候该说"没查到"。

## 改了什么

- 新增技能手册 `ts/apps/server/skills/persona_memory.md`（文件名 = 技能名，第 1 行 = 索引摘要）：
  - 分工：最近/偏好先用 `recall`；很久以前/要出处用 `persona_recall`。
  - 提问：一次只问一件事；把时间、人物、项目名放进 query；查不到换锚点，最多两三次。
  - 读返回：`memory_day → event → fact → segment → entity → tension`；重点看 `coverage / unknown / gaps`，
    不把"没查到"说成"没发生"。
  - 回答：先说结论，再给日期/证据；别人说的话只转述释义，不假装原话；查库失败如实说。
- 没有改工具契约、没有新增端点、没有改 `ask.py`。技能只在索引里多一行摘要，正文按需 `skill` 取。

## 验证

- 直接跑 `ask.py "2024年秋天我在忙什么" --json`：返回六组证据与 coverage（含 gap_months），链路正常。
- `PERSONA_MEMORY_ASK` 已配置 → `persona_recall` 工具上架。
- 服务重启后，技能索引出现 `persona_memory`；已通过 `PUT /agent/skills/persona_memory/enabled` 打开
  （技能默认全关，用户要它可用）。技能索引按会话冻结：**新会话生效**，老会话保持原索引。

## 边界

- 技能只是"怎么用工具"的说明书，不自动检索；模型判断何时调用。
- 大库仍是只读；不通过技能写回 persona.db。
- 群聊 / 别人私聊不进个人记忆库。
