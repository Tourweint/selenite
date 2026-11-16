# B 任务书：人设页工具勾选（CodeBuddy）

**给谁**：CodeBuddy（`--model hy4flash-free`）。
**仓库**：`<repo>`。**不要提交 git**，只改下面点名的文件。
**先读**：`AGENTS.md`、`docs/设计方案/2026-11-16-工具裁剪与工具选择（A+B）.md` §3。
**前提**：A（delegate 手册 + core 技能）已由另一批完成；不要改 A 的文件（`core-skills.ts`、
`skills.ts`、`skills-api.ts`、`skills-list.js`、`skills-actions.js`、`skills-settings.js`、`delegate.md`、`tools.ts`）。
**范围**：只做 B，不做 C（`deferred` / `tool_search`），不做 worker 角色勾选。
**工作树提醒**：仓库里有别人未提交的改动。`partner-profile.js` / `style-22-partner-profile.css`
等文件可能已有在途修改；只做**定点编辑**（读原文件 → 改指定区域），不要整文件重写、不要格式化、
不要动与本任务无关的段落。**不要 git add / commit / push。**

## 一、目标

人设页（总管 / 每个执事）能逐项勾选“这个模型能看到哪些工具”；默认全开，取消勾选后
**下一轮起**该工具从模型上下文里消失。存“取消名单”，以后新增工具默认可见。

## 二、存储（`partner-store.ts` / `partner-rows.ts` / `partner-types.ts`）

1. `partners` 表新增列 `disabled_tools TEXT`：
   - 新库 `CREATE TABLE` 加上；
   - 老库补列沿用文件里 `ensureColumn` 的既有写法（`ALTER TABLE partners ADD COLUMN disabled_tools TEXT`）。
2. `PartnerRow` 新增 `disabledTools: string[]`（注释：JSON 数组，只存被取消的工具名；空 = 全开；不版本化）。
3. `partner-rows.ts` 的 `toPartner` 加 `disabledTools: toDisabledTools(row.disabled_tools)`；
   新增解析函数（参照 `toProjectIds`）：非数组 / 坏 JSON / 非字符串项 → 当空数组。
4. `partnersStore` 新增 `setDisabledTools(id, names: string[]): PartnerRow | null`：
   - 不存在返回 null；
   - 只写 `disabled_tools` + `updated_at`，不 bump 身份版本、不碰 SOUL / 契约；
   - 调用方保证 names 已去重且是已知工具名（端点是入口）。
5. 团队包（`partner-bundle.ts`）**不改**：和 `personaModules` / `projectIds` 一样，不随包迁移。

## 三、工具目录与运行时（新建 `ts/apps/server/src/partner-tools.ts`）

### 3.1 目录

```ts
export interface PartnerToolItem {
  name: string;
  group: string;
  summary: string;   // 首句 / 首行，≤80 字
  enabled: boolean;  // 该人当前是否可用
}
export interface PartnerToolsView {
  enabled: boolean;          // 全局开关
  disabled: string[];
  groups: string[];          // 固定顺序
  tools: PartnerToolItem[];
}
```

- `partnerToolsEnabled(env = process.env)`：`PARTNER_TOOLS_ENABLED` 为 `false` / `0` / `off` 时关；
  缺省 / 其它 = 开。
- `modelToolCatalog(): ToolRegistration[]`：
  - 取 `CodingTools.tools`（`@earendil-works/pi-durable/tools`）+ `lifediaryExt?.tools`（`./agent/lifecycle-harness.ts`）；
  - 过滤 `tool.deferred === true`、过滤 `callers` 不含 `model` 的（`callers` 缺省 = model + tools）；
  - 按 `name` 去重（先到先得）、保持注册顺序；
  - 不要手抄工具清单。
- `PARTNER_TOOL_GROUPS`：按工具名映射到固定组，未知 = `其他`。建议：
  - `文件与命令`：read / write / edit / bash / powershell；
  - `记忆`：remember / recall / recall_sessions / persona_recall；
  - `派活与任务`：delegate / propose_project / propose_topic / routine_manage / set_reminder / report_progress / ask_user；
  - `资料与技能`：web_search / skill / save_skill_advice / partner_skill_write；
  - `执事与群组`：partner_manage / group_manage / send_to_agent；
  - 组顺序：文件与命令 → 记忆 → 派活与任务 → 资料与技能 → 执事与群组 → 其他。
- `toolSummaryOf(description)`：取第一行 / 第一句（`。！？\n` 切），trim，超 80 字截断加 `…`。
- `partnerToolsView(partner: PartnerRow): PartnerToolsView`：用 `disabledTools` 计算每项 `enabled`。
- `sanitizeDisabledTools(input: unknown, known: ReadonlySet<string>): { ok: true; disabled: string[] } | { ok: false; message: string; unknown?: string[] }`：
  - 必须是数组、元素必须是字符串、≤64 个；
  - 去重、只保留 known（未知名返回 400 列表，不静默吞）；
  - 空数组合法（= 全开）。

### 3.2 运行时应用

```ts
export async function applyPartnerToolSelection(
  conversation: Conversation,
  partner: PartnerRow,
): Promise<void>
```

- `partnerToolsEnabled()` 关 → 直接 return。
- `catalog = modelToolCatalog()`；`catalogNames = new Set(catalog.map(name))`；
  `disabled = new Set(partner.disabledTools)`；
  `desired = catalog.filter(t => !disabled.has(t.name)).map(t => t.name)`。
- `agent = await conversation.agent(CTX).catch(() => null)`；
  `current = agent?.tools.filter(t => catalogNames.has(t.name)).map(t => t.name) ?? []`。
- 两个集合按**集合**比较（不看顺序）：相同 → return（不写任何东西）。
- 不同时：
  - `disabled.size === 0` → `conversation.configure({ modelTools: null }, CTX)`（恢复默认）；
  - 否则 `const remove = catalog.filter(t => disabled.has(t.name));`
    `conversation.configure({ modelTools: { remove } }, CTX)`。
- 整段 try/catch：失败 `console.warn("[partner-tools] …")`，**绝不向上抛**（不能挡对话）。
- 只影响模型可见工具；不要动 extension、工具实现、审批闸门。

### 3.3 在哪调用

`ts/apps/server/src/agent/session-stream.ts` 的 `chatStream` 里、`input.conversation.submit(...)` **之前**：

```ts
// 人设页工具勾选：下一轮起生效；worker / task 不参与。
try {
  const linked = partnersStore().partnerIdOfSession(conversationId);
  const kind = linked ? null : await chatKindOfInternal(conversationId).catch(() => null);
  const ownerId = linked ?? (kind === "chief" ? CHIEF_PARTNER_ID : null);
  const owner = ownerId ? partnersStore().get(ownerId) : null;
  if (owner) await applyPartnerToolSelection(input.conversation, owner);
} catch {
  // 工具面读不到不该挡对话
}
```

- `partnersStore` / `CHIEF_PARTNER_ID` 从 `../partners.ts` 引；`chatKindOfInternal` 文件里已经引入了。
- 只需这一处：总管主会话、执事专线、执事群会话、例行会话都会走 `chatStream`。
- `worker` 开发会话 / `task-*` 任务专线没有链接且 kind 不是 chief → 不处理。
- 不要把这个逻辑放进 `openChat`（读端点不该有副作用）；不要改 `openPartnerConversation` / 群运行时。

## 四、端点（`companion-api.ts`）

### 4.1 `GET /api/v1/partners/:id/tools`

- 未知执事 → 404 `{ok:false,error:"not_found"}`。
- `await getHarness()` 确保真实 extension 已装；失败 → 503 `{error:"tools_unavailable"}`。
- `partnerToolsEnabled() === false` → **200** `{ok:true, enabled:false, disabled:[], groups:[], tools:[]}`（页面据此隐藏卡）。
- 正常 → `{ok:true, enabled:true, disabled:[...], groups:[...], tools:[{name,group,summary,enabled}]}`。
- `cache-control: no-store`。

### 4.2 `PUT /api/v1/partners/:id/tools`

- body `{disabled: string[]}`；用 `sanitizeDisabledTools` 校验，未知名字 → 400：
  `{error:"bad_request", message:"未知工具：a、b"}`。
- `partnerToolsEnabled() === false` → 400 `{error:"bad_request", message:"工具选择未启用（PARTNER_TOOLS_ENABLED=false）"}`。
- 未知执事 → 404；成功 → 写 `setDisabledTools`，返回**同 GET 的形状**（前端直接回填）。
- 只写这一列；不 bump 身份版本、不重启会话、不影响当前正在跑的那一轮（下一轮生效）。

### 4.3 `context-defaults`

`ts/apps/server/src/context-defaults.ts` 的 `defaultTools()` / `contextDefaultPayload`：
- `role.kind === "chief"` → 取 `partnersStore().get(CHIEF_PARTNER_ID)`；
  `role.kind === "partner"` → 取该执事行；
  `worker` → 不过滤；
- 该行存在且 `partnerToolsEnabled()` 开时，按 `disabledTools` 过滤工具列表；
- 读执事库失败 → 不过滤，别让整页 503。
- 目的：默认开销页看到的就是这个人真实能看到的工具面。

## 五、人设页 UI（`web/partner-profile.js` + `web/style-22-partner-profile.css`）

### 5.1 位置

在 `#pf-recall`（按相关度召回）之后、`#pf-advanced`（高级开关）之前新增：

```html
<section class="pf-sec" id="pf-tools">
  <div class="pf-sec-head">
    <h2 class="pf-sec-title" data-tip="勾上 = 他看得到、调得动；取消 = 下一轮起看不到；默认全开">能用的工具</h2>
  </div>
  <div class="card pf-panel">
    <div class="pf-mod-cards" id="pf-tools-cards"></div>
  </div>
</section>
```

卡片（参照 `pf-mod-cards` 里现有卡）：
- 标题「工具」；摘要 `已开 N / M`；副标题可写「下一轮生效」但**不要长篇解释**（标题悬停已说明）。
- 点击打开弹层；`GET /partners/:id/tools` 失败时卡片显示一句失败原因 + 可重试（点击重开）。
- `enabled:false` → 整段 `#pf-tools` 隐藏。

### 5.2 弹层

`openModal("工具 · " + partnerName, ...)`，结构：

```html
<div class="pf-tool-groups">
  <div class="pf-tool-group">
    <div class="pf-tool-group-title">文件与命令</div>
    <label class="pf-tool-row">
      <input type="checkbox" data-tool="read" checked />
      <span class="pf-tool-name">read</span>
      <span class="pf-tool-sum">读取文件…</span>
    </label>
    ...
  </div>
</div>
<p class="pf-hint" id="pf-tools-hint"></p>
<div class="modal-actions">
  <button class="ghost" data-modal-cancel>关闭</button>
  <button class="ghost" id="pf-tools-all">全选</button>
  <button class="ghost" id="pf-tools-none">全不选</button>
  <button class="btn-primary" id="pf-tools-save" disabled>保存</button>
</div>
```

- 勾选 = `enabled`；保存时收集**未勾选**的名字发 `PUT {disabled}`。
- 全选 / 全不选只改勾选态；有改动才 enable 保存。
- 保存中禁用按钮；成功 `toast("已保存，下一轮生效")`、`closeModal()`、回写卡片 `已开 N / M`；
  失败在 `#pf-tools-hint` 显示 `没存成：…`，不关弹层。
- 弹层打开时再拉一次 GET（不要用页面加载时的旧数据）。
- 复选框与行样式自己加最小 CSS（`.pf-tool-groups` / `.pf-tool-group` / `.pf-tool-group-title` /
  `.pf-tool-row` / `.pf-tool-name` / `.pf-tool-sum`），沿用现有 `pf-*` 字号与间距；不要改无关样式。

### 5.3 页面接线

- 在 `wirePartnerProfile` 里加 `void pfWireTools(root, partnerId)`（或等价命名），与其它 `pfWire*` 同风格。
- 页面加载时拉一次 GET 更新卡片计数；点击卡片再拉一次打开弹层。
- 总管（`partnerId === "chief"`）同样显示，不做特殊隐藏；它的变化作用于总管主会话。

## 六、开关与文档

- `PARTNER_TOOLS_ENABLED`（默认开）：
  - 加进 `ts/apps/server/.env.example`（注释：人设页工具勾选 / 运行时过滤的回滚开关，`0`/`false`/`off` 关闭）；
  - `docs/基线文档/接口文档.md` §6 环境变量表加一行；
  - `docs/基线文档/系统架构.md` 模块表加 `partner-tools.ts`（目录/组/apply/回滚），
    并在设置页数据源或执事章节补一句“工具面按人设勾选过滤，下一轮生效”。
- `docs/基线文档/接口-端点4-执事例行与自主轮.md`：新增两行端点（GET/PUT tools），写清
  body、400/404/503、`enabled:false` 形状、`setDisabledTools` 不版本化、下一轮生效。
- `docs/基线文档/接口-端点1-对话与兼容层.md` §2.2.5：默认工具面按 role 的 `disabledTools` 过滤。
- `docs/变更记录/2026-11-16-工具裁剪（delegate 手册与工具勾选）.md`：追加 B 段
  （改了什么、为什么、验证、没做/不确定）。A 段已存在，不要覆盖。

## 七、测试（必须真跑）

- 新增 `ts/apps/server/src/partner-tools.test.ts`：
  - `modelToolCatalog` 过滤 deferred / 去重；组与摘要函数；
  - `sanitizeDisabledTools`：非数组、非字符串、重复、未知、空数组；
  - `applyPartnerToolSelection`：构造假 conversation（`agent()` 返回带 tools 的对象、
    `configure()` 记录调用）→ 名单相同不写；不同写 `{remove:[…]}`；清空写 `null`；
    只比较目录内工具（额外 extension 工具不会导致误写）。
- `ts/apps/server/src/partners.test.ts`（或现有 store 测试）：`setDisabledTools` 往返、坏 JSON 当空、不 bump 身份版本。
- `ts/apps/server/src/companion-api.test.ts`：GET 默认全开；PUT 未知名 400；PUT 正常保存并回读；
  `PARTNER_TOOLS_ENABLED=false` 时 GET `enabled:false`、PUT 400；未知执事 404。
- `ts/apps/server/src/context-defaults.test.ts`：给一个 partner 行设 `disabledTools`，
  partner 角色的工具列表少一项；chief 同理；worker 不受影响。
- 把 `partner-tools.test.ts` 加进 `ts/apps/server/package.json` 的 `test` 脚本文件清单
  （清单是显式列文件的；加在 `context-inspect.test.ts` 附近）。
- 前端 `node --check web/partner-profile.js`。

验证命令：
```bash
cd ts && pnpm typecheck
cd ts/apps/server && pnpm exec tsx --test src/partner-tools.test.ts src/partners.test.ts src/companion-api.test.ts src/context-defaults.test.ts
node --check web/partner-profile.js
```
不要跑全量 `pnpm test`；不要启动/重启 39847 活服务，不要碰 `.data`（测试用临时目录）。

## 八、完成标准

- 只改上面点名的文件 + 新建 `partner-tools.ts` / `partner-tools.test.ts`；
- `pnpm typecheck` 通过，四个测试文件通过；
- 报告：改了哪些文件、GET/PUT 的形状、apply 的写入条件、验证输出、没做/不确定的点；
- **不要 git add / commit / push**。
