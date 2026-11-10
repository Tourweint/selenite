# 批 28 变更记录：两段式配对 · 旧事找回 UI · auxiliary 收口

日期：2026-11-10
上位：任务书 `docs/设计方案/2026-11-10-批28任务书（剩下三条）.md`（本批三节全做）。
状态：已落地（**未 commit**；所有读写都在 `lh-b28` worktree 内；零 `shared` / 零 chancellor 改动）。
铁律核对（2026-11-10）：**未碰** `agent/injection.ts`、`agent/lifecycle.ts`（批 27 在改）、
`delegation-judge.ts`、总账文件（`2026-11-09-全景调研落地总账（逐条状态表）.md`）；未 commit。
影响面：
- `ts/apps/server/src/pairing.ts` + `pairing.test.ts`
- `ts/apps/server/src/index.ts`（端点 / 鉴权开放面 / 开关）
- `ts/apps/server/src/agent/session-search.ts` + `session-search.test.ts`
- `ts/apps/server/src/auxiliary.ts` + `auxiliary.test.ts`
- `ts/apps/server/web/app.js` + `style.css`
- `ts/apps/server/scripts/http-probe.ts`（§30 适配 + 新增 §31）
- `docs/基线文档/接口文档.md`（§2.5 / §5 / §6）

## 一、两段式配对（#26 剩余，服务端接口先就位）

- `pairing.ts`：新增 `pairTwoStepEnabled()`（默认 `true`）、`begin()`、`confirm()`；
  `StoredCode` 加 `confirmHash`（sha256(confirmToken)）。`begin()` 出 `{code, expiresAt, confirmToken}`——
  `code` 给手机扫（进二维码）、`confirmToken` 只回电脑端，**不随二维码下发**；两者同记录、同 `expiresAt`
  （默认 5 分钟 / `PAIR_CODE_TTL_SECONDS=300`）、只存哈希、明文只在签发那一刻返回。
  `confirm()` 要 `code` + `confirmToken` 同时正确才发令牌：只给 code → `confirm_required`、
  令牌错 → `bad_confirm`、重放 → `code_used`、过期 → `code_expired`；**失败计入既有 `attempts`**
  （与 `redeem` 共用一个计数器 / 5 次上限）。设备发放抽成 `issueDevice()`，`redeem()` / `confirm()` 共用，
  `redeem()` 行为逐字节不变（额外兜一层：带 `confirmHash` 的两段式码从单段视角不可兑）。
- `index.ts`：新增 `POST /api/v1/pairing/begin`（需鉴权，电脑端）、`POST /api/v1/pairing/confirm`
  （`PAIR_OPEN_PATHS` 免鉴权，手机此刻无凭据，与 `pair/redeem` 同口径 + 同 IP 限流）。
  **`PAIR_TWO_STEP=true`（默认）时单段 `POST /api/v1/pair/redeem` 返回 `410 two_step_required`**——
  否则"只扫码拿到 code 就能兑凭据"会让两段式形同虚设；`false` → `begin`/`confirm` 404、`redeem` 恢复旧单段。
- 契约口径（2026-11-10 全量审计）：两段式新端点用任务书指定的 `/api/v1/pairing/*` 前缀，
  与旧单段 `/api/v1/pair/*` 并存；**手机端两段式 UI / 电脑端 confirmToken 展示未做（另说）**，
  本批只交付服务端契约与端点（接口先行）。
- 单测 `pairing.test.ts` 新增 6 组：成功 / 只有 code 不能完成 / confirmToken 错 / 过期 / 重放 /
  开关回滚；外加"明文不落盘""失败计入 attempts"两条硬约束断言。
- http 探针新增 §31（真起服务、`PAIR_TWO_STEP=true`）：begin 形状、只扫码 400、令牌错 400、
  单段 redeem 410、都交齐才发令牌、重放 409；§30（验指纹）显式设 `PAIR_TWO_STEP=false` 回到单段。

## 二、旧会话定点找回 UI（六§七#6 剩余，只读不 fork）

- 后端新增只读 `GET /api/v1/agent/sessions/search?q=&days=&limit=`（`index.ts`）：复用
  `recall_sessions` 的 `searchSessions`（覆盖全部会话、snippet ≤200 且脱敏），给每条命中补一个
  `aroundIndex`——按 `readTranscript(chat, 0)`（与批 20 定点找回同下标口径）用「时间 + 命中词」
  精确定位（`findAroundIndex`）。空 / 短查询 → 400；`days` / `limit` 交检索核心收敛。
  回滚开关 `AGENT_SESSIONS_SEARCH=false` → 整组 404（与工具开关 `AGENT_RECALL_SESSIONS` 刻意分开）。
- `session-search.ts` 新增纯函数 `sessionSearchApiEnabled` / `parseSessionSearchQuery` /
  `findAroundIndex`，单测不必起 Hono；`session-search.test.ts` 新增形状、空查询 400、
  snippet ≤200 不含整段正文、aroundIndex 同源、就近兜底等用例。
- 前端只改 `web/app.js` + `style.css`：设置 → 会话加「找旧事」入口 → `openRecallModal()`
  （`modal-wide`）：输入关键词调搜索端点、结果列表、点一条用 `aroundIndex` 拉
  `GET /agent/chat/:id/context?aroundIndex=&radius=5` 在弹窗里只读展示前后文。
  **不做 fork、不开新会话、不改任何数据**；两个后端端点也都只读。
  所有正文用 `esc()` 转译，不拼不可信 HTML。`node --check`（拷 `.mjs`）通过。
- 明确不做（任务书 §2.2）：不做 fork、不做季度复盘。

## 三、auxiliary title / vision 显式"无调用点"

- `auxiliary.ts`：`AuxUse` / `AUX_USES` 增 `vision`（任务书 §3 与总账 #32「标题/压缩/vision/评审」
  口径；原实现只有 title/compact/review/extract，没有 vision 用途，本批按任务书补为保留用途，纯增量）。
  给 `title` / `vision` 加**显式注释**：当前无调用点，保留接口为将来做**会话自动命名 / 图片理解**；
  `compact` 不在此列（批 26b 已由 `startChatCompaction` 单独记"内核不支持指定压缩模型"日志）。
- `auxiliaryModel("title")` / `("vision")` 调用时打一条 warn（进程内**只一次**，
  `warn` / `warned` 可注入以便断言）："该用途当前无调用方，配置不会生效"，
  避免有人配了 `AUX_MODEL_TITLE` / `AUX_MODEL_VISION` 以为生效；**配了仍照常返回配置值**，
  不改变模型解析契约。`compact` / `review` / `extract` 行为逐字节不变。
- `auxiliary.test.ts`：`AUX_USES` 断言更新为五种；新增 title/vision 返回配置值但打 warn（只一次、
  可注入）与"已接用途不误报"两组用例。

## 验证（命令都在 `ts/` 下，2026-11-10 实跑）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 0 错 |
| `pnpm --filter @lifediary/server test` | **710 条全绿**（含本批新增 11 条：配对 6 / 搜索 3 / auxiliary 2；0 失败） |
| `pnpm --filter @lifediary/server http` | **端到端全部通过**（§30 单段回滚 + 新增 §31 两段式 / 搜索端点全绿，0 项没通过） |
| 前端 `node --check`（拷 `/tmp/*.mjs`）+ `node --check app.js` | 语法通过 |

## 已知边界 / 没做（如实登记）

- **默认 `PAIR_TWO_STEP=true` 会收紧单段 redeem**：旧的 `/pair` 扫码页与旧手机端单段流程
  在默认态**不再能完成配对**——需 `PAIR_TWO_STEP=false` 回滚，或后续接两段式 UI。
  这是"为了安全默认开"的代价，任务书 §1.5 / 铁律 4 明确认可；电脑端 confirmToken 展示与
  手机端两段式交互**不在本批**（接口先行，手机端另说）。
- **两段式端点路径**：按任务书字面用 `/api/v1/pairing/begin|confirm`，与旧 `/api/v1/pair/*`
  并存两个前缀；手机仓适配说明按"所有读写都在这个 worktree 内 / 零跨仓改动"口径**未写**，
  契约已落 `接口文档.md` §5，接入时对齐即可。
- **`aroundIndex` 定位**：`sessions/search` 按 `readTranscript` 精确算下标（时间 + 命中词，
  取不到按时间就近），与批 20 定点找回端点同源；单次搜索读全部会话 context，命中再按会话读一次
  transcript，会话多时慢（同 `listChats` 已知代价，FTS 后置）。未做缓存 / 索引。
- **vision 是新增的保留用途**：当前没有任何调用点（与 title 同），配置 inert；本批只补"显式标注 +
  warn"，没有接图片理解场景（那需要附件 / 多模态契约，属另一件事）。
- **未跑**：`pnpm probe` / `memtest` / `providers` / `diary` / `tasks` / `phone`
  （本批没动这些链路；按 AGENTS.md「最小充分验证」）。
- 前端交互（弹窗里点结果、返回列表、高亮命中条）只做了 `node --check` 语法校验，
  **没有真机 / 浏览器点过**——纯 DOM 逻辑，未做端到端 UI 自动化。
