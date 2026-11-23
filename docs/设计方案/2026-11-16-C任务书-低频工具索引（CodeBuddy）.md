# C 任务书：低频工具索引（deferred + tool_search）（CodeBuddy）
> 状态：已执行（任务书，2026-11-16）。落地明细见 docs/变更记录/ 同期批次记录；实施以代码为准，冲突以长期文档（接口文档.md / 系统架构.md）为准。


**给谁**：CodeBuddy（`--model hy4flash-free`）。
**仓库**：`<repo>`。**不要提交 git**。
**先读**：`AGENTS.md`、`docs/设计方案/2026-11-16-Worker人设与低频工具索引.md` §2。
**前提**：W（Worker 人设）由另一批完成；不要改 `worker-persona.ts` / `worker-profile.js` / `partner-modals.js` 里 W 的段落。
**范围**：只做 §2（C）。不做 Worker 人设。

## 一、机制（内核原生，别自己发明）

- 注册时给低频工具加 `deferred: true` → 内核**不把它放进请求**。
- `tool_search` 工具返回 `control: { addTools: [name] }` → 内核在本轮工具跑完后
  把名字追加进会话 `modelTools.add`；**下一轮起**完整 schema 才进请求。
- 已加载的 deferred 工具由 `AgentState.modelTools.add` 记着，`agent.tools` 里能看到；
  没加载的在 `agent.deferred` 里。

## 二、低频清单（8 个，代码常量）

`routine_manage` / `partner_manage` / `group_manage` / `save_skill_advice` /
`partner_skill_write` / `propose_project` / `propose_topic` / `send_to_agent`

## 三、服务端改动

### 1. 新增 `ts/apps/server/src/tool-index.ts`

```ts
export const DEFERRED_TOOL_NAMES: ReadonlySet<string>   // 上面 8 个
export function toolIndexEnabled(env = process.env): boolean
  // AGENT_TOOL_INDEX=false/0/off → 关；缺省开
export function isDeferredTool(name: string, enabled = toolIndexEnabled()): boolean
export function markDeferred<T extends ToolRegistration>(tools: readonly T[], enabled?: boolean): T[]
  // enabled 时给 DEFERRED_TOOL_NAMES 里的工具补 { deferred: true }（浅拷贝，不改原对象）
export function toolIndexText(available: readonly { name: string; description: string }[]): string | undefined
  // 标题 + 每个工具一行「- name：一句话摘要」+ 一句「先调 tool_search({name}) 取完整定义」
  // 摘要复用 partner-tools.ts 的 toolSummaryOf；空列表 → undefined
```

- 摘要函数从 `partner-tools.ts` import（`toolSummaryOf` 已存在，别复制一份）。
- 标题固定：
  ```
  按需工具（初始不加载）：要用下面某个工具时，先调 tool_search({name:"工具名"}) 取完整定义，下一轮起它才可用。
  ```

### 2. 改 `ts/apps/server/src/agent/lifecycle-harness.ts`

- 在 `lifediaryTools` 生成之后套一层：`const tools = markDeferred(createTools({...}))`
  —— 实际写法：先 `const raw = createTools({...})`，再 `const lifediaryTools = markDeferred(raw)`。
- **不要改工具注册顺序**；`markDeferred` 只加属性。

### 3. 新增 `tool_search` 工具

放在 `createTools` 的**末尾**（`return tools;` 之前），且仅当 `toolIndexEnabled()` 且
存在至少一个 deferred 工具时注册：

```ts
defineTool({
  name: "tool_search",
  description:
    "按名字取一个低频工具的完整定义并加载它。系统提示词里的「按需工具」清单只给名字和一句话；" +
    "要用其中某个工具，先调本工具，下一轮起它就能正常调用。只接受清单里出现过的名字。",
  parameters: Type.Object({
    name: Type.String({ description: "工具名，必须是「按需工具」清单里列出的名字" }),
  }),
  execute: async (args, api) => {
    const name = String(args.name ?? "").trim();
    const agent = await api.agent(context); // 按现有工具里拿 agent 的写法
    const available = agent.deferred.filter((t) => t.name === name);
    if (available.length === 0) {
      return { output: [...], isError: true } // 用既有 err(...) 形状，列出当前可加载的名字
    }
    const tool = available[0];
    return {
      output: [{ type: "text", text: <完整定义文本> }],
      control: { addTools: [name] },
    };
  },
})
```

- 「完整定义文本」= `工具名` + 换行 + `description` 原文 + 换行 + `参数：` + 紧凑 JSON 的 `parameters`
  （`JSON.stringify(tool.parameters)`），再加一句「已加载，下一轮起可直接调用」。
- 找不到 → 用现有 `err("tool_not_loaded", ...)` 风格返回错误文本（含可加载名字清单），**不要抛异常**。
- 如果 `api.agent(...)` 在当前 `ToolExecutionApi` 上不方便，可改为在 execute 里用
  `api.registry` 快照 + 会话 agent 的现有读法（参照 `tools.ts` 里别的工具怎么拿 conversationId / agent）；
  **不要新加全局可变状态**。

### 4. 新 prompt section `tool_index`

- `INJECTION_ORDER` 加 `tool_index: 70`（在 `topics: 60` 之后；消息注入从 95 起，不冲突）。
- 新 provider（放 `agent/lifecycle-injections.ts`）：
  - 开关关 → undefined；
  - 读当前会话 agent 的 `deferred` 列表（已启用但没加载的），映射成 `{name, description}`；
  - 空 → undefined。
- `LIFECYCLE_SECTIONS` **末尾追加** `{ key: "tool_index", render }`。
  这是缓存前缀的字节变化，属预期；记进变更记录。
- `injection.test.ts` 的「section 顺序快照」同步加 `tool_index`。

### 5. 与工具勾选（B）的交互（关键，别漏）

`ts/apps/server/src/partner-tools.ts`：

1. `modelToolCatalog()` 现在 `if (tool.deferred === true) continue;` —— 改成**包含** deferred，
   并在返回项上标出来（新增可选字段 `deferred: boolean` 或复用 tool 自身属性）。
   人设页工具列表要能看到这些工具并允许取消。
2. `partnerToolsView()` 的 `tools[]` 每项加 `deferred: boolean`（前端可显示「按需加载」小字，可选）。
3. `applyPartnerToolSelection()`：
   - 比较时**只比非 deferred 工具**：`catalog.filter(t => t.deferred !== true)` 的名字集合 vs
     `agent.tools` 里属于该子集的名字集合；
   - 写入时**保留已加载的 deferred**：
     ```ts
     const loaded = agent.tools.filter(t => isDeferredTool(t.name)).map(t => t.name);
     const remove = catalog.filter(t => t.deferred !== true && disabled.has(t.name));
     // disabled 为空 且 loaded 为空 → configure({modelTools: null})
     // 否则 → configure({ modelTools: { ...(remove.length ? {remove} : {}), ...(loaded.length ? {add: loaded} : {}) } })
     ```
     （`configure` 的 `modelTools` 是**整体替换**，漏掉 `add` 会把 tool_search 加载过的工具抹掉。）
   - 关掉某个已加载的 deferred 工具时，它要进 `remove` 且**不能**出现在 `add` 里
     （`remove` 优先于 `add`：内核 `offeredTools` 里 `removed.has(name)` 会把它剔掉，但仍要别写进 add）。

### 6. 默认开销页 `context-defaults.ts`

- `defaultTools()` 保持**不含** deferred（新会话初始前缀确实没有它们）；
- 但要把 `tool_index` 段算进默认基线：在 `buildDefaultSections` 里追加
  `pushSection(sections, "tool_index", toolIndexText(<该角色可见的 deferred 列表>))`。
  - 该角色的 deferred 列表 = `markDeferred` 后的目录里 `deferred === true` 且不在该人 `disabledTools` 里的工具。
  - worker / chief / 执事都算同一份（工具面本来就一样，只有勾选差异）。

### 7. 能力声明 `ts/apps/server/src/tool-capability.ts`

`tool_search` 登记：`readOnly: true`、`destructive: false`、`sideEffectScope: "none"`、
`riskLevel: "low"`、`needsApproval: "never"`、`concurrentSafe: true`，
notes 写「只把已注册的延迟工具加载进本会话工具面；不动工作区、不起进程、不写盘」。
**不进 `WRITE_TOOLS`**（`approval-policy.ts` 不动）。

## 四、开关

`AGENT_TOOL_INDEX`（默认开）：`false`/`0`/`off` →
不注册 `tool_search`、不给任何工具加 `deferred`、不渲染 `tool_index` 段、默认页也不含该段
（回到 22 个全量工具）。

## 五、测试

- 新增 `ts/apps/server/src/tool-index.test.ts`：
  - `toolIndexEnabled` 默认开 / 三个关值；
  - `markDeferred` 只给名单内工具加属性、不改原对象、保持顺序；
  - `toolIndexText` 空列表 undefined、有列表时含标题与每个名字；
  - `isDeferredTool`。
- `ts/apps/server/src/tool-capability.test.ts`：双向集合等值会因 `tool_search` 变红 → 已登记后应变绿。
- `ts/apps/server/src/partner-tools.test.ts` 补：
  - `modelToolCatalog` 现在**包含** deferred（原断言过滤 deferred 的那条要改）；
  - `applyPartnerToolSelection`：disabled 为空但 agent 有已加载 deferred → 写 `{add:[...]}` 而不是 `null`；
  - 关掉一个已加载 deferred → `remove` 含它、`add` 不含它；
  - 只有 deferred 集合变化时不写（比较只看非 deferred）。
- `ts/apps/server/src/agent/injection.test.ts`：section 顺序加 `tool_index`；
  新增一条 `toolIndexProvider` 的开关 / 空列表断言。
- `ts/apps/server/src/context-defaults.test.ts`：默认页 section 里出现 `tool_index`，且 `tools` 不含 deferred 名字。
- `ts/apps/server/package.json` 的 `test` 清单加 `src/tool-index.test.ts`。

## 六、验证命令

```bash
cd ts && pnpm typecheck
cd ts/apps/server && pnpm exec tsx --test src/tool-index.test.ts src/partner-tools.test.ts src/tool-capability.test.ts src/agent/injection.test.ts src/context-defaults.test.ts
node --check web/partner-profile.js
```
不要跑全量 `pnpm test`；不要启动 / 重启 39847 活服务；不要碰真实 `.data`。

## 七、文档

- `docs/基线文档/接口-端点7-权限技能与开关.md`：`tool_search` 能力声明、`tool_index` 段、`AGENT_TOOL_INDEX` 语义。
- `docs/基线文档/接口-端点1-对话与兼容层.md` §2.2.5：默认工具面**不含** deferred，但含 `tool_index` 段。
- `docs/基线文档/接口-端点4-执事例行与自主轮.md`：`GET /partners/:id/tools` 的 `tools[]` 增 `deferred` 字段；
  `modelToolCatalog` 现在包含 deferred。
- `docs/基线文档/接口文档.md` §6：`AGENT_TOOL_INDEX`。
- `docs/基线文档/系统架构.md`：`tool-index.ts` 模块、`tool_index` 段（追加在末尾，缓存前缀变化一次）、
  `tool_search` 的加载语义（下一轮生效、追加在末尾不动前缀）。
- `docs/变更记录/2026-11-16-Worker人设与低频工具索引.md`：**追加 C 段**（W 段已存在，不要覆盖）。

## 八、完成标准

- 只改上面点名的文件 + 新建 `tool-index.ts` / `tool-index.test.ts`；
- `pnpm typecheck` 通过，五个测试文件通过；
- 报告：改了哪些文件、`tool_index` 段渲染出的实际文本、apply 的四种写入条件、验证输出、没做/不确定的点；
- **不要 git add / commit / push**。
