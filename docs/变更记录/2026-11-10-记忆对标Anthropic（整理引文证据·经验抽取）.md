# 2026-11-10 记忆对标 Anthropic（整理引文证据 · 经验抽取）

方案：`docs/设计方案/2026-11-10-记忆对标Anthropic（整理引文证据·经验抽取）.md`。
本次不走 CodeBuddy 派活，由主会话直接实施 + 自验收（用户拍板"这次特殊"）。

## 背景

Anthropic 2026-11-06 发文拆解其智能体记忆（四层 + "做梦"后台整理）。对标结论（方案文内已全）：
咱们四层结构与"只建议不自动改"的克制已对齐；真缺口两个——
①整理建议只看记忆库、回不到原始对话，记错的笔记没有证据能发现；
②`experience` 只有派单结算一条写入路，对话里的"用户纠正过的做法"抽不出来。

## 改动一：整理建议带证据引文（`MEMORY_REVIEW_EVIDENCE`，默认开）

- `agent/session.ts`：新增 `findEvidence(needles)` —— 单遍扫 `listChats(200)` × `readTranscript(200)`，
  每条记忆正文找第一处原始出处即记，全部命中即早停；任务专线与隐藏会话天然不在列表内。
- `packages/memory/extract.ts`：新增 `normalizeForGroundingWithMap`（归一化 + 原文位置映射）与
  `locateEvidence`（4~12 字归一化锚点从长到短试，命中摘原文 ±40/80 字；正文首行为准、
  Why/How 不参与匹配）。与抽取侧 `groundedInUserText` 共用同一套剥除正则（`GROUNDING_STRIP`），防口径漂移。
- `memory-consolidate.ts`：`reviewScope` 在模型成功、id 复核之后给每条建议的 drop 端查证据，
  挂到新字段 `evidence`（`{conversationId, at, role, text}`）；查不到 = `null`（不挡应用）；
  查找失败降级全 null（建议照常返回）；开关关着时字段整个不下发（undefined，JSON 自动丢弃）。
  `options.findEvidence` 可注入（测试/探针）。日志只加 `证据=N` 条数，不含正文（D8）。
- `memory-api.ts`：`MemoryApiDeps.findEvidence` 透传。
- 前端 `web/app.js` + `style.css`：建议卡渲染引文块——命中 = 可点回原对话（`openConversation`
  单入口）；null = "未找到原始出处（导入或日记来源的记录不在对话里），不挡应用"；
  字段不存在 = 整块不渲染（开关关着的老形状）。

**D18 一条没动**：仍然只建议、人逐条应用、无自动触发。补的是证据，不是自动化。

## 改动二：经验抽取补管线（`MEMORY_EXTRACT_EXPERIENCE`，默认开）

- `packages/memory/extract.ts`：
  - `PreferenceExtractor` 更名 `DialogueExtractor`（一次调用出偏好 + 经验两类，更名副其实），
    `options.experience` 控制档位：关 = 发旧 `PREFERENCE_PROMPT`（**逐字节未动**）、解析出的
    经验栏整段丢弃。
  - `parseExtractionJson` 出两类（旧形状裸数组 / `{preferences}` 逐字节兼容，`parsePreferenceJson`
    委托保留）；`{preferences, experiences}` 新形状，经验上限 `MAX_EXPERIENCES_PER_TURN = 3`。
  - 合并提示词 `EXTRACTION_PROMPT_COMBINED`：经验判据收窄为"用户纠正过且说明原因 / 验证过有效"
    （Anthropic 的教训：判据太宽等于抄对话）；经验与偏好同过引文校验、同形状 Why/How。
- `engine.ts ingestTurn`：经验与偏好同样重挂宽 scope（主对话 → `global`、执事 → `partner:<id>`）。
- `memory-extract.ts`：装配层改用 `DialogueExtractor`，日志改"偏好/经验抽取 +N 条（偏好 a/经验 b…）"。
- 派单结算那条 `work-record.ts` 写入路零改动（scope / 来源 / 稳定 id 都不同，刻意不合并）。

## 测试

- `selftest.ts` 新增 §18：合并解析（新形状 / 旧形状 / 坏输入）、一次调用两类且偏好在前、
  经验重挂 global、开关回滚（提示词逐字节）、经验引文校验拒收、上限、`locateEvidence`
  （逐字 / 转述 4 字锚点 / 未命中 / 长文本截断 / 标点容忍 / Why 段不参与）。
- `memory-api.test.ts` 新增：命中挂 evidence / 查不到 = null / 开关关 = 字段不下发
  （既有用例顶部锁 `MEMORY_REVIEW_EVIDENCE=false`，避免真扫跨会话记录）。
- **自测抓到一个真 bug 并已修**：`experience:false` 时开关只管了提示词、没管解析结果，
  模型不守提示词回新形状时经验照样落库——现在解析后按开关再丢一遍。

## 验证（2026-11-10）

- `pnpm memtest` 全绿（含新 §18）；`pnpm --filter @lifediary/server test` 745 全绿 0 失败；
- `pnpm typecheck`：**本批文件零错误**。仓库现存 1 个类型错误在
  `agent/lifecycle.ts:930`（`toolDiff` 展开进 `{details?}`），属**另一会话批 33 在途改动**
  （lifecycle/shared/delegation 一族同批未提交，非本批文件，未碰）。
- 真模型手验整理引文卡未做（faux 环境不出建议；等下次真模型对话时顺手看一眼卡片）。

## 子智能体独立验收与复验（2026-11-10）

按用户要求派独立子智能体只读审查（方案符合度 / D18 / 日志红线 / 开关语义 / 兼容性 /
测试诚实性 / 文档一致性八项）。八项里六项干净，抓出两项 P1，修完复验：

- **P1-1（已修）`locateEvidence` 下标域混用**：map 按码点建、归一化串按 UTF-16 单元索引，
  含 emoji（代理对）的文本上 `map[at]` 错位，引文摘到文本开头一串 emoji——比 null 更糟
  （假证据误导）。修法：map 改按 UTF-16 单元对齐（每个码点的每个单元都映到该码点的
  起始下标），不变式 `map.length === norm.length` 对任意文本成立；selftest §18 补
  emoji 用例（含 200 个 emoji 前缀的最坏情况）与同长不变式断言。
- **P1-2（已修）evidence 落待决文件与"只存"口径冲突**：evidence 挂上后随 proposal 一起
  `writePending`，对话片段多落一份盘、两处"只存 id/理由/两端正文快照"文档失真。修法：
  写待决文件前剥掉 evidence（只进响应），测试补"待决文件里无 evidence"断言。
- **P2 顺手带上的四件**：①引文过 `redactSecrets` 凭据打码（与记忆正文同一政策）；
  ②前端 `data-conv` 改用仓库现成 `attr()` 转义；③`memory-extract.ts` 头注释残留旧类名
  已改；④接口文档 `MEMORY_EXTRACT_EXPERIENCE` 行补"重启生效"。
- **P2 登记不修的两件**：①两套归一化在极端 Unicode 下不同（`normalizeForGrounding`
  整串 toLowerCase vs WithMap 逐字符——希腊语终位 Σ 一类；中文产品域外，改了反而动
  `groundedInUserText` 的既有行为）；②开关生效时机差异（`MEMORY_EXTRACT_EXPERIENCE`
  模块加载读一次、`MEMORY_REVIEW_EVIDENCE` 每请求读）——前者已在 §6 写明，后者测试
  依赖每请求读的语义，都是刻意的。

## 已知边界（如实）

- `findEvidence` 每次整理单遍扫 ≤200 会话 × ≤200 条，全部命中即早停——显式动作，慢一点可接受
  （与跨会话搜索同口径）；会话极多时是最慢路径，真变慢再上 FTS（同 `searchTranscripts` 的口径）。
- 偏好是模型转述，4 字锚点命中可能截到"相似句"而非"原句"——证据是给人核对的，误挂由人眼把关。
- 证据只查 drop 端（被收编那条的依据）；keep 端不查（它是要留下的，争议在 drop）。
