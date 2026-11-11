# 记忆对标 Anthropic「智能体记忆组件」（2026-11-10）

状态：**已落地（2026-11-10 当日，主会话直接实施 + 自验收，未走 CodeBuddy 派活——用户拍板"这次特殊"）**
落地记录：`docs/变更记录/2026-11-10-记忆对标Anthropic（整理引文证据·经验抽取）.md`
下沉落点：契约 → `接口文档.md` §2.15.1（`evidence` 字段）+ §6（`MEMORY_REVIEW_EVIDENCE` /
`MEMORY_EXTRACT_EXPERIENCE`）；机制 → `系统架构.md` §7 记忆节；冲突以长期文档为准。
落地偏差：无方案级偏差；实现细节四处与方案文比有出入——①经验段关闭时解析结果也按开关
丢弃（方案只写了提示词逐字节，自测抓到解析层漏网，见变更记录"自测抓到一个真 bug"）；
②抽取器类名由 `PreferenceExtractor` 更名 `DialogueExtractor`（一次出两类后旧名撒谎）；
③证据锚点从方案文"首个 ≥8 字片段"改为 12/8/6/4 字窗口从长到短滑（特异性强的锚点优先，
4 字与引文校验同判据兜底）；④前端引文块从"可折叠"改为"可点回原对话"（核对出处需要
上下文，跳转比折叠有用）。另：验收（子智能体独立审查）抓出两项 P1 已修——emoji 代理对
下标域错位、evidence 落待决文件与"只存"口径冲突（改为只进响应）；细节见变更记录。

## 背景

Anthropic 工程团队 2026-11-06 发文（https://www.anthropic.com/research/components-of-agent-memory），
拆解他们给 Claude 做的跨会话记忆：四层结构（原始记录 → 记忆笔记 → 链接结构 → 自动加载层），
外加一个后台"做梦"步骤——**回头翻原始对话记录**，改掉记错的笔记、把零散笔记整理成好找的形式。

拿文章逐条对咱们的四层（`ts/packages/memory/`）与 D18 口径，结论：

**已经对齐、不用动的**（2026-11-10 核对代码确认）：

| Anthropic 经验 | 咱们现状 |
|---|---|
| 自动加载层要小，错一条带进每个会话 | 注入预算 1200 字、偏好单独成组（`engine.ts buildContext`） |
| 多 agent 别写同一文件 | 作用域按会话/执事隔离，群会话整个不进记忆引擎（D16） |
| 做梦要克制，误删比脏记忆代价大 | D18：模型只出建议、人逐条应用、没有"全部应用" |
| 引文接地防编造 | 批 21 `groundedInUserText`（偏好必须能在用户原话找到依据） |
| 答错被告知后更新记忆 | 显式 `supersede()` + 巩固审计（批 17） |

**真缺口两个**（本文要做的）：

1. **"做梦"看不到原始对话**。整理建议（`memory-consolidate.ts reviewScope`）只看记忆库里
   最近 ≤200 条，回不到当初的对话——抽取时记错的内容，模型复查时手里只有记忆本身，
   没有任何证据能发现它错；人看建议卡同样缺证据。Anthropic 纠正月见山那条错笔记，
   靠的正是回头翻原始记录。
2. **学习循环有壳没肉**。Opus 5 赢在笔记里写了"规则 + 怎么验证 + 踩过的坑"。批 17 加了
   `experience` kind，但写入只有派单结算一条路（`work-record.ts`，且只认结果行）；从对话里
   抽不出经验——`extract.ts` 里 LLM 通道只判偏好，规则版只记 episode（2026-11-04 的 TODO 还挂着）。
   和 2026-11-06 偏好的老毛病一模一样：kind 是死值，全靠 `remember` 工具模型自觉，实测基本不记。

## 做什么（两件）

### 一、整理建议带原文引文（证据上卡）

给"整理记忆"的建议卡补一副眼镜：**每条建议附一条从原始会话记录里摘的引文**，人拍板前能核对
"这条记忆当初真是这么说的吗"。

改动点：

- `agent/session.ts` 加 `findEvidence(needles: string[]): Promise<Map<string, SearchHit>>`——
  **单遍**扫 `listChats(200)` × `readTranscript(200)`，对每条 needle（取自建议 drop 端正文，
  归一化后的首个 ≥8 字片段）找第一处命中即记，全部命中或扫完即止。与 `searchTranscripts`
  同口径：**显式动作，慢一点可接受**（人点了"整理"按钮才会跑这一次）。
- `memory-consolidate.ts`：`reviewScope` 在模型返回建议、id 复核之后，对 ≤50 条建议的 drop
  端做一次 `findEvidence`，命中挂到新字段 `evidence`：
  ```jsonc
  "evidence": { "conversationId": "…", "at": 1699…, "role": "user", "text": "命中处 ±40/80 字" }
  ```
  没找到 = `evidence: null`，卡片显示"未找到原始出处"——**不挡应用**（引文是证据，不是门槛）。
- 前端（设置页记忆整理卡）：有 evidence 就渲染引文块（可折叠），没有就维持现状。
- `applyProposal` 不动：应用语义照旧走 `supersede()`。

**不改变 D18 的任何一条**：仍然只建议、人逐条应用、没有自动触发。这次只是把"做梦"里
"回头翻原始记录"这半步搬进现有的人工触发流程。

**契约**：整理建议响应体加可选字段 `evidence`（缺省 null，老前端忽略即可）——按 §7 顺序先改
`接口文档.md` 再改实现；只影响本服务内置界面，不进 `shared` 包、不涉手机端。

**回滚开关**：`MEMORY_REVIEW_EVIDENCE=false` 一行关掉（建议卡回到无引文形态）。

### 二、经验抽取补管线（对话里的"用户纠正"落成 experience）

照偏好抽取的现成管线抄一份窄口径：LLM 抽取调用从"只抽偏好"扩成"偏好 + 经验"两段输出。

改动点：

- `packages/memory/extract.ts`：
  - `PREFERENCE_PROMPT` 扩成一次调用出两类（同一 transcript、同一预算，不加第二次模型调用）：
    **经验判据照文章的"完整学习循环"收窄**——只有"用户纠正了做法、且说明了为什么或验证过
    有效"才算；单次任务要求、事实、闲聊不算。输出每条带 `content / why / howToApply / confidence`
    （与偏好同形状，`howToApply` = 什么场景按这条做）。
  - 新增 `MAX_EXPERIENCES_PER_TURN = 3`（比偏好更窄：经验是把教训炼成做法，不是抄对话）；
    引文校验 `groundedInUserText` **同样作用于经验**（防把模型自己的总结安到用户头上）；
    超置信度门槛的落 `kind=experience`，`importance` 与偏好同档（0.72 + confidence×0.2）。
  - 解析保持"永不抛错"，认不出的形状 = 这轮没抽到。
- `engine.ts ingestTurn`：**经验与偏好同样重挂到宽 scope**（主对话 → `global`、执事 →
  `partner:<id>`）。"下次这类活怎么做"换会话不该失效——与 D17 的偏好同理，重挂在装配层做，
  抽取器只回答"是不是经验"。
- 装配层 `memory-extract.ts`：`LayeredExtractor` 不变结构，日志多记一个条数枚举。
- 与派单结算写的 experience（`work-record.ts`）**互不干扰**：那边 id 稳定
  （`experience:<ticketId>`）、veracity=`tool`；这边随机 uuid、veracity=`stated`（用户自己说的）。
  巩固层对 experience 是"规范化等价可合并"——两边撞车自然收敛，符合批 17 §一.3 的口径。

**契约**：`MemoryCandidate` / `MemoryRecord` 契约零改动（experience kind 批 17 已存在）；
不动 `shared` 包、不涉手机端。

**回滚开关**：`MEMORY_EXTRACT_EXPERIENCE=false` 只关经验段（偏好照抽）；`MEMORY_EXTRACT=rule`
仍是整条链路回到旧行为的总闸。

## 备选与取舍

**证据为什么做成"审时现查"而不是"写时记源"**（cindy 的 `originSessionId` 做法）：
写时记源要动 `MemoryRecord` 契约 = 动 store schema、导出、设置页、手机端全套（批 21 渲染
Why/How 时就为避开 `MemoryRecord` 改字段绕过过一次）；而审时现查零 schema 改动、旧记忆
（导入的、日记摄入的）同样能查到出处。代价是每次整理多一遍扫描——显式动作，可接受。
若将来"做梦"自动化了，再把 origin 下沉成字段不迟。

**经验为什么并进偏好那一次调用而不是单独一发**：独立调用 = 每轮多一次模型钱 + 多一个
超时面；两段输出在同一个 prompt 里判据写清（"算偏好"vs"算经验"）互不污染，且 kind 不相交
不会打架（与 LayeredExtractor 现有论证同构）。若实测混判率高，再拆开（接口不变、换实现）。

**经验为什么不进派单侧**：派单结算那条路（`work-record.ts`）记的是执事的活，判据是确定性
的结果行；本方案记的是**主人对话里**的纠正。两条写入路 scope 不同（partner vs global）、
来源不同（tool vs stated），刻意不合并。

## 明确不做（同步登记进 `系统架构.md` §7）

1. **wiki / 互相链接的结构层不做**：Anthropic 自测数据里，wiki 只在"跨多文档拼信息"场景
   有增益（87% vs 73%），答案在单文件能搜到的场景无明显帮助，还可能膨胀到比原文还大
   （203KB vs 115KB）；且多 agent 并行写同一结构会互相覆盖（57 条只留 41）。咱们是单人
   场景，已有 FTS 候选集 + 加权召回 + 巩固审计，现阶段建 wiki 是持续花算力买不到东西。
   将来"跨会话综合"类需求真出现再立项。
2. **"做梦"自动 cron 不做**（D18 重申）：Anthropic 自己说"记忆该多久复查一次还没有定论"；
   ZCode 把 Dream 设计完整也故意不接自动触发。语义整理保持"人点按钮 → 出建议 → 逐条应用"。
   本方案只补证据，不改触发方式。
3. **规则抽取器"每句都记 episode"不在本批收**：有 `MEMORY_SESSION_CAP=200` 封顶 +
   90 天未用淘汰兜底，膨胀有界；等抽取层下一次立项（fact/entity 识别，`extract.ts` 的
   TODO）一起收，不单开一批。

## 验证

- 单测：`findEvidence` 命中/未命中/多 needle 早停；经验解析（合法 JSON / 围栏 / 混判 /
  引文校验拒收）；`ingestTurn` 经验重挂 scope；`ConsolidateProposal.evidence` 序列化形状。
- `pnpm typecheck` + `pnpm --filter @lifediary/server test` + `pnpm memtest`。
- 探针：`pnpm --filter @lifediary/server providers`（auxiliary 解析不受影响）；真模型手验
  一轮"整理记忆"看引文卡（faux 会因 `isFaux()` 直接没有建议，探针只能验形状）。
