# 任务书 P1：persona_recall——接入 persona-metric 记忆库的按需检索工具

> 上位方案：`docs/设计方案/2026-11-09-persona记忆库接入（检索工具+对话中转归档）.md`
> （关键决策 D-甲/D-乙/D-丙/D-己 都在里面，先读）。
> 执行：CodeBuddy。派单人：总管。**独立 worktree，不 commit**。
> 本批只做**读**；写入链（导出器 + voicevault）是批二，本批不做。

## 一句话

给总管加一个**按需查询工具** `persona_recall`：本地短记忆（`recall`）想不起来、
或用户问很久以前的事、或要原文出处时，调它去查 `<persona-metric>`
的个人记忆库（经它的检索门 `ask.py`，只读子进程），返回带出处的证据条目。

## 背景（读方案后可直接跳到改动项）

- persona-metric 是独立仓库，**本批零改动它的任何文件**。我们只用它的两个既有事实：
  - `analysis/ask.py`：检索门，`python analysis/ask.py "问题" --json` 输出稳定 JSON
    （六组证据 `groups`：memory_day/event/segment/fact/entity/tension，另有
    `window/keywords/coverage/unknown/next`）。**mode=ro 只读打开、纯本地 SQL、零模型零网络**。
    超时预算 ~10s 足够（实测 0.7s 检索 + Python 启动）。
  - `<persona-metric>\data\persona.db`：它的库（约 232MB，WAL）。
    我们**绝不直接打开它**，一切查询都经 ask.py。
- lifediary 侧的注入链与既有工具**都不改**：`recall`（本地短记忆）保持原样，
  `persona_recall` 是它旁边的"大库深查"，两者互补不互替。

## 改动项

### 1. 新模块 `ts/apps/server/src/persona-ask.ts`（核心，纯函数化便于测试）

1.1 导出 `askPersona(question: string, options?: { limit?: number }): Promise<PersonaAskResult>`。
1.2 实现：`spawn(PERSONA_PYTHON, [ASK_SCRIPT, question, "--json", "--limit", String(limit)], ...)`
   —— **argv 数组传参，不用 shell**（模型只能影响 question 文本本身，没有注入面）；
   `windowsHide: true`；收集 stdout；**timeout 15s**（超时 kill 并返回结构化失败，见 1.6）。
1.3 路径解析：
   - 脚本路径 = `PERSONA_MEMORY_ASK` env（**未配置 → 整个功能关闭**，工具不上架——这是默认态，
     生产要 .env 显式配置才启用；样例值 `<persona-metric>\analysis\ask.py`）；
   - Python 命令 = `PERSONA_PYTHON` env，默认 `python`；
   - 两者都 trim 后非空才启用。
1.4 返回类型 `PersonaAskResult`（自己定义，够用就行）：
   ```ts
   interface PersonaAskResult {
     ok: boolean;
     question: string;
     qtype?: string;            // ask.py 判出的问题类型
     groups?: {                 // 只保留有内容的组，格式见 2.2 渲染要求
       memory_day?: PersonaHit[];
       event?: PersonaHit[];
       segment?: PersonaHit[];
       fact?: PersonaHit[];
       entity?: PersonaHit[];
       tension?: PersonaHit[];
     };
     unknown?: string;          // ask.py 自己说"查不到时该说什么"
     coverage?: { not_searched?: string[]; not_indexed?: string[]; gaps?: string[] };
     error?: string;            // ok=false 时的失败原因（不含 stderr 原文，见 1.7）
   }
   ```
   `PersonaHit` 至少含 `{ id, date?, title?, text?, why? }`——按 ask.py 实际 JSON 字段映射
   （先真跑一次 `python ask.py "四级考了几次" --json` 看真实字段再定，**以实测为准，不猜**）。
1.5 stdout 解析失败（非 JSON / 结构不符）→ `ok:false` + 失败原因；**吞错不抛**——
   检索失败绝不能让对话失败（与 `recallContext` 的降级口径一致）。
1.6 超时/子进程出错 → `ok:false, error:"persona 检索超时（15s）"` 或带退出码的简述。
1.7 日志纪律：只记 `问题字数 / 耗时ms / ok / 命中组数`，**不记 question 原文、不记 stderr 全文**
   （stderr 可能含本机路径，最多取第一行 120 字进 error 说明）。
1.8 单测（`persona-ask.test.ts`）：注入假 python（或注入 spawn 替身）验证：
   正常 JSON 解析 / 非 JSON 降级 / 超时降级 / 未配置 env 时返回禁用 / argv 拼装正确（capture spawn 参数断言）。

### 2. 工具注册 `ts/apps/server/src/tools.ts`

2.1 `ToolDeps` 加可选注入 `personaAsk?: ((question: string, options?: { limit?: number }) => Promise<PersonaAskResult>) | null`——
   实现由 lifecycle 注入（照 `recallSessions` 的注入模式，`tools.ts:245` 样板），
   **tools.ts 不 import persona-ask.ts**（避免单测环境依赖真实路径；测试注入替身）。
2.2 条件注册（照 `recall_sessions` 整块，`tools.ts:881-925` 模板）：
   `deps.personaAsk` 存在才 `tools.push(...)`；否则不注册（模型侧 tool_unavailable，一行回滚）。
2.3 工具定义：
   - `name: "persona_recall"`；
   - description（给模型的用法说明，要点全在这）：
     "在**主人的个人记忆库**（跨越很多年的原始记录与分析）里检索证据条目，每条带出处 id。"
     "适用：本地记忆想不起来 / 查很久以前（如去年、2024 年）的事 / 主人要求给原文出处。"
     "**查不到 ≠ 没有这回事**：返回里有『不确定』说明时照转述，不要编。与 recall 分工："
     "recall 查最近与偏好，persona_recall 查一生；先 recall 再 persona_recall。";
   - 参数：`{ query: string, limit?: number (默认 5, ≤20) }`；
   - execute：调 `deps.personaAsk`，`ok:false` → 返回固定文案
     "个人记忆库暂时查不了（原因已记日志），你可以说说想确认什么，我换个方式找。"
     （不把内部错误细节透给模型）；渲染规则见 §2.2 下一条：
   - **渲染**：按组列条目，格式 `- [组名] 日期｜标题/正文摘要（出处 id）`，正文单条截 160 字；
     组间空行；`unknown` 有值时**原文附上**（前缀"注意："）；coverage.gaps 非空时附一句
     "记忆库在这些时段没有记录：..."。全空 → "个人记忆库里没有查到相关记录。"。
   - **群会话跳过**（与 `recall` 同款判断 `partnersStore().isGroupSession`，文案同款）。
2.4 单测：注入替身 personaAsk → 正常渲染 / 空结果文案 / ok:false 文案 / deps 不传时工具不注册
   （`createTools` 返回清单断言，照 `session-search` 注册测试的写法）。

### 3. 闸门登记 `ts/apps/server/src/approval-policy.ts`

3.1 `WRITE_TOOLS` 加 `"persona_recall"`——**这是硬约束字面要求**（AGENTS.md："会写文件 /
   起进程 / 派活的工具必须加进 WRITE_TOOLS 并过 readOnlyBlockReason"，persona_recall 起 python
   子进程，属于"起进程"一类，不许用"它其实只读"当理由豁免）。
3.2 在 `WRITE_TOOLS` 定义处按现有注释惯例加一行出处注释：
   `// persona_recall（2026-11-09 persona接入批一）：起 python 子进程查 persona-metric，按字面进闸门；命令行拼死（python + 固定脚本），模型自由度只有 query 文本。`
3.3 **不进** `DEFAULT_CRITICAL_TOOLS`（审批三档里"只问重要的"不必为它打断用户；
   read-only 档被 WRITE_TOOLS 拦、no-shell 档也不拦它——两层语义都自然成立，无需改 `readOnlyBlockReason`）。
3.4 单测（加进现有 `approval-policy.test.ts`）：`WRITE_TOOLS.has("persona_recall")` 为真；
   `needsApproval` 在 ask-all 档会 ask、none 档放行；`readOnlyBlockReason` 在 read-only 档拦截。

### 4. 开关与装配 `ts/apps/server/src/agent/lifecycle.ts`

4.1 新函数 `personaAskEnabled(env)` 放 **persona-ask.ts** 里（照 `session-search.ts:67-71`
   的 `recallSessionsEnabled` 模板）：`PERSONA_MEMORY_ENABLED` 未配置 = 开（**但工具仍不上架，
   除非 PERSONA_MEMORY_ASK 也配置了**——两个开关的语义：ASK 配置=启用，ENABLED=false=显式关，
   双闸都过才注册）。
4.2 lifecycle 的 `createTools({...})` 加：
   ```ts
   personaAsk: personaAskEnabled() && askPersonaAvailable()
       ? (question, options) => askPersona(question, options)
       : null,
   ```
   （`askPersonaAvailable()` = env 路径非空判断；同处加一行注释引用方案文档。）
4.3 **不改** `recallContext` / `buildContext` / 任何注入链——本批 persona 只走工具，不进每轮注入。

### 5. 文档回写（两处，按 AGENTS.md 契约同步规矩）

5.1 `docs/基线文档/接口文档.md`：
   - §4 工具清单：加条件注册工具 `persona_recall`（照 `recall_sessions` 在 §4/§9 的登记格式：
     参数、行为、开关、上架条件）；
   - §6 env 表加两行：`PERSONA_MEMORY_ASK`（默认未配置；= ask.py 绝对路径时启用工具）与
     `PERSONA_MEMORY_ENABLED`（默认开；false 显式关闭，即使 ASK 已配置）、
     `PERSONA_PYTHON`（默认 `python`）；
   - §7 如有"工具数量"类计数口径一并校准（先 grep 再改，不多改）。
5.2 `docs/变更记录/2026-11-09-persona记忆库接入批一（persona_recall检索工具）.md`：
   改了什么 / 为什么 / 验了什么，几段话即可。
5.3 `.env.example`：如果仓库根或 ts/ 下存在该文件则补 3 行注释样例；**不存在就跳过**（不要新建）。

## 铁律

1. **不许 commit**。
2. **persona-metric 仓库一个文件都不许动**（只许读，探针跑它的 ask.py 属于"读"）。
3. spawn 必须 argv 数组、不用 shell；不把 query 进任何 shell 字符串拼接。
4. 日志不含 question 原文与对话内容（硬约束）。
5. 失败一律降级返回，不抛异常打断对话轮。
6. 不改 recall / recallContext / 注入链 / shared 包 / memory 包。
7. 不做无关重构；`web/app.js`、`web/style.css` 本批**不许碰**（有并行改动在途）。

## 验证（最小充分，都要看输出，不只看 exit code）

1. `pnpm typecheck` 0 错。
2. `pnpm --filter @lifediary/server test` 全绿（新增 persona-ask / 工具注册 / 闸门三组测试）。
3. **真探针**（在仓库 ts/ 目录）：
   ```bash
   PERSONA_MEMORY_ASK="<persona-metric>\analysis\ask.py" \
   LLM_PROVIDER=faux pnpm --filter @lifediary/server dev
   ```
   起服务后从 web 界面或 http 探针发一句"查一下我 2024 年秋天在忙什么"，确认：
   - 模型发起 `persona_recall` 调用、返回有条目（库里有 2024 年数据，正常应命中）；
   - `AGENT_TOOL_POLICY=read-only` 环境下同问题被拦（闸门真的拦）；
   - `PERSONA_MEMORY_ASK` 未配置时工具不在清单（faux 工具快照确认）。
   探针输出贴进交付说明。
4. `pnpm --filter @lifediary/server http` 全绿（契约面没被动过）。

## 交付物

代码（不 commit）+ 单测 + 接口文档 §4/§6 回写 + 变更记录 + 探针输出摘录。
交付说明里写清：做了什么、验了什么、哪些拿不准（尤其 ask.py 实测 JSON 字段与本任务书
`PersonaHit` 映射的差异，如实记，验收时我对）。
