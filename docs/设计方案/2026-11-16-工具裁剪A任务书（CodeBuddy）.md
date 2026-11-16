# A 任务书：delegate 政策进内置技能（CodeBuddy）

**给谁**：CodeBuddy（`--model hy4flash-free`）。
**仓库**：`<repo>`（工作目录）。**不要提交 git**，只改下面点名的文件。
**先读**：`AGENTS.md`、`docs/设计方案/2026-11-16-工具裁剪与工具选择（A+B）.md` §2。
**范围**：只做 A（delegate 手册 + core 技能机制），不做 B（人设页工具勾选），不做 C。

## 一、目标

把 `delegate` 工具描述里的大段流程政策挪进一份**内置技能手册**，让每轮固定前缀少 ~1,000 token；
手册必须**始终可用**，不能受“技能默认全关”的启停位影响。

## 二、改哪些文件

### 1. 新增 `ts/apps/server/src/core-skills.ts`

```ts
/** 代码内置的技能名：始终进索引、始终可 skill(name) 取到，不受启停位影响。 */
export const CORE_SKILL_NAMES = new Set(["delegate"]);
export function isCoreSkill(name: string): boolean {
  return CORE_SKILL_NAMES.has(name);
}
```
注释里写清：只认代码名单，不认 frontmatter 自封；普通技能行为不变。

### 2. 改 `ts/apps/server/src/skills.ts`

- `createSkillStore` 的 options 加可选 `isCore?: (name: string) => boolean`（默认 `() => false`，旧测试零改动）。
- `canSee(name, partnerId)` 改成：`isCore?.(name) === true || (partnerId && visibleFor ? visibleFor(...) : visible(...))`。
  索引、`names()`、`manual()` 都走 `canSee`，三处自动一致。
- 不改文件格式、不改冻结逻辑、不改摘要截断。

### 3. 改 `ts/apps/server/src/agent/assist.ts`

两个 `createSkillStore(...)` 调用（总管链 + 全局链）都传 `isCore: isCoreSkill`。
`skillVisible` / `skillVisibleFor` 保持原样（core 由 store 内部短路，不走这两个函数）。

### 4. 新增 `ts/apps/server/skills/delegate.md`

- 扁平形态：第 1 行 = 索引摘要（≤80 字），空一行后是完整手册。
- 第 1 行建议：`派活：任务书四段 / steps / resume / 四行回报 / 裁决纪律的完整手册`
- 正文从 `ts/apps/server/src/tools.ts` 的 `delegate` 描述里**原文搬运**这些段落（不要改写意思）：
  - 任务书四段的完整说明与岗位契约对应；
  - `steps` 的完整规则；
  - 工人回报 `need_input / need_decision / need_action` 的处理；
  - `resume` 的全部细节（“对方这句话本身就是要交回的内容”等）；
  - `REPORT_FOUR_LINES` 原文（四行：状态 / 结果 / 证据 / 解锁），并写明“回报开头写「给<你的名字>：」”；
  - `RULING_DISCIPLINE` 原文（四停 / 记一行账 / 裁决格式）；
  - 设备 / 手机 caveat 的完整说明（相对路径、runs/<ticket>/、手机工人碰不到电脑文件、只回一句话）。
- 手册开头写一句：“第一次派活前读这一份；工具描述只讲何时用、怎么调。”

### 5. 改 `ts/apps/server/src/tools.ts`

只改 `delegate` 的 `description`，参数 schema / 工具顺序 / 其它工具一个字不动。
保留（必须仍在描述里）：
- 做什么 / 适合 / 不适合；
- 派出去立即返回、后台汇报，**不要等结果 / 不要反复查询 / 不要重复派**；
- `project` 必填与 `needs_project` 流程；手机/设备活可省；
- `resume:true` 只写用户那句回答、不要重述、不要重派；
- `domain` 小写 ASCII；当前领域清单；
- `steps` 一句（≤12 条）；
- 相对路径一句 + 手机工人碰不到电脑文件一句；
- **“第一次派活前先调 `skill` 读 `delegate` 手册”**（写清工具名与技能名，例如
  `**第一次派活前先调 skill({name:"delegate"}) 读完整手册**：任务书四段 / steps / resume / 四行回报 / 裁决纪律。`）。

删掉（已进手册的逐字大段）：任务书四段展开、steps 完整规则、need_input 处理、resume 全部细节、
`REPORT_FOUR_LINES` 拼接、`RULING_DISCIPLINE` 拼接。
如果 `REPORT_FOUR_LINES` / `RULING_DISCIPLINE` 在 `tools.ts` 里再无其它用途，删掉对应 import
（`RULING_DISCIPLINE` 仍被 partner-context 用，别删那个文件里的）。

目标：`delegate` 描述从约 1,300 token 降到约 300–400 token；不要为了短而改写关键约束。

### 6. 管理面：`ts/apps/server/src/skills-api.ts`

- `GET /api/v1/agent/skills` 的每个 item 增 `core: boolean`（用 `isCoreSkill(entry.name)`）；
  `core=true` 时 `enabled` 一律给 `true`（即使启停位里没有）。
- `PUT /api/v1/agent/skills/:name/enabled`：core → **400**，
  `{error:"bad_request", message:"系统内置技能，始终可用，不能关闭"}`。
- `PUT /api/v1/agent/skills/enabled-all`：core 名字**不参与**全开/全关统计与写入
  （`count` 也只算普通技能），避免界面显示“已全关”但内置还在。
- 带 `partnerId` 时 `partnerEnabled` 对 core 也给 `true`。

### 7. 技能页 UI：`ts/apps/server/web/skills-list.js` / `skills-actions.js`

- `skills-list.js`：`core === true` 的行不渲染可点开关；改成一个只读标记
  （小字「内置」+ `data-tip="系统内置技能，始终可用"`）。不要改变其它行的布局/顺序/分组。
  参考现有 `switchMarkup` 与 `.skill-switch` 样式；只加最小 CSS（可写在 `style-14-settings-pages.css`
  或该页已有样式文件里），别动无关样式。
- `skills-actions.js`：`toggleSkillEnabled` 入口先判 `core`，直接 return（UI 已不可点，防御留一层）。
- `skills-settings.js` 的批量全开/全关：请求前过滤掉 `core` 名字（服务端也会跳，双保险）。

### 8. 测试

- 新增/补充 `ts/apps/server/src/skills.test.ts`：
  - 让 `createSkillStore` 带 `isCore: (name) => name === "delegate"`，启停位全关时：
    索引含 `delegate`、`names()` 含、`manual("delegate")` 有正文；普通技能仍不出现。
  - 不带 `isCore` 时行为与旧测试一致。
- 改 `ts/apps/server/src/prompt-discipline.test.ts` 的 “delegate 描述：尾部带四行回报与裁决纪律”：
  - 描述里**不再**包含 `REPORT_FOUR_LINES` / `RULING_DISCIPLINE`；
  - 描述包含 `skill` 与 `delegate` 的指路句；
  - 新增断言：读 `ts/apps/server/skills/delegate.md`（用 `new URL("../skills/delegate.md", import.meta.url)`），
    正文包含 `REPORT_FOUR_LINES` 与 `RULING_DISCIPLINE` 原文。
- 如果 `skills-api` 有现成测试（`skills.test.ts` 或 `skills-api` 相关），补 core 的 400 与 `enabled-all` 跳过。
- 不要为了测试改生产语义；测试用临时目录。

### 9. 文档

- `docs/基线文档/接口-端点7-权限技能与开关.md`：补 core 技能语义（始终在索引 / 可按名取手册 /
  启停端点 400 / `enabled-all` 跳过 / `GET` item 增 `core`）。
- `docs/基线文档/系统架构.md`：技能层补一句 core 名单（`core-skills.ts`），说明只认代码常量。
- `docs/变更记录/2026-11-16-工具裁剪（delegate 手册与工具勾选）.md`：先写 A 段（改了什么、为什么、
  delegate 描述前后 token、core 机制、验证结果；B 段留给下一批）。**新建这个文件**，B 任务书会追加。

## 三、验证（必须真跑）

```bash
cd ts && pnpm typecheck
cd ts/apps/server && pnpm exec tsx --test src/skills.test.ts src/prompt-discipline.test.ts
node --check web/skills-list.js && node --check web/skills-actions.js && node --check web/skills-settings.js
```
另外用一段小脚本或单测打印 `delegate` 描述的字符数，确认比改前短（改前约 2,996 字）。
不要跑全量 `pnpm test`（脚本有重复前缀的历史问题）；不要启动/重启 39847 活服务，不要碰 `.data`。

## 四、完成标准

- 所有改动只落在上面点名的文件 + 新建的 core-skills.ts / delegate.md / 变更记录；
- `pnpm typecheck` 通过，两个测试文件通过；
- 报告：改了哪些文件、delegate 描述前后字符数、core 技能验证结果、没做/不确定的点。
- **不要 git add / commit / push**。
