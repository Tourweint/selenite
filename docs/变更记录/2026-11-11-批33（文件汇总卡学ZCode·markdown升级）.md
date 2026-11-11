# 批 33：文件变更汇总卡（学 ZCode）+ markdown 渲染升级

日期：2026-11-11（凌晨，接批 32 同一晚）
状态：已落地（typecheck ✅ / 745 单测 ✅ / 浏览器逐项实测 ✅）

## 起因

用户口径（2026-11-10 深夜，接批 32）："**他底下有这个文件吧，就是动了哪些文件的提示……他这个 MD 的渲染也是非常好的，就学他吧，都做一下就行了，就是 ZCode。**" 两件事：

1. **文件变更汇总卡**：一轮跑完，对话框下方提示"动了哪些文件"。
2. **markdown 渲染**：把 ZCode 的观感搬过来。

## 学 ZCode 学到什么（`<reference>\ZCode`，2026-11-11 核对）

- **`ConversationFileSummaryPanel`（packages/ui/src/v4/）**：折叠行「N files changed +A -B」，
  点开逐文件列表（路径 + 每文件 +/- 行数），行尾还有「Review」/「Open split」与**回退**按钮。
  挂在 turn 级（ConversationTurnGroup.tsx:1622），数据来自服务端 fileChanges 摘要。
- **markdown 栈（components/ai-elements/message.tsx）**：`streamdown`（shiki 高亮 + CJK 友好 +
  表格 + mermaid + math）。重依赖 React 生态，**不照搬依赖，只对齐观感**——MyGo 是零构建三件套。

## 改了什么

### 契约（纯增量一处）

- `tool` 事件加 `diff?`：编辑类工具（`edit`，结果 `details.diff`）的 unified diff，end 帧携带，
  截断 2000 字符。**修了一处历史不一致**：以前 diff 只在历史 `steps[].diff` 有、现场 tool 帧没有，
  「现场看到的」与「回头翻到的」不是同一份事实。`agent/shared.ts` 的 `ToolEvent` + `toolDiff()`
  与 `session.ts` 的 `ChatStreamEvent.tool` 同步加字段，lifecycle 的 end 帧接线。

### 前端（web/ 三件套）

- **文件变更汇总卡（`mountFileSummary`）**：正文下方、工作过程之后——折叠行
  「改了 N 个文件 +A -B」，点开逐文件列表（路径 + 每文件 +/-，时间序）。
  数据源 = 现场攒 + 历史从 steps 收（`collectFileChangesFromSteps`），两边同口径：
  - 只认 `edit` / `write`（`bash` 改的文件事件里没有路径，**编不出来就不编**）；
  - 同一文件多次编辑聚合一条、行数累加（`diffStats` 数 diff 前缀行）；
  - `write` 无 diff（内核 write 工具不产 diff）→ 只列路径不带数字，不编 0。
  - **刻意没有**：ZCode 的逐文件 diff 查看器 / 回退按钮——MyGo 没有 code viewer 与 rewind
    机制；完整改动在工作过程折叠区里点 edit 步骤就能看，这里只做"动了哪些"的提示。
- **markdown 渲染升级（`renderMarkdown` / `inline`）**：
  - **嵌套列表**：列表从单层变量改成栈（缩进 ≥2 空格开子列表、浅了逐层收），
    有序/无序混排切换正确收口；
  - **任务清单**：`- [ ]` / `- [x]` → 只读勾选框（`.md-task`，accent-color 跟主题）；
  - **删除线**：`~~text~~` → `<del>`；
  - **引用块**：连续 `>` 行合成一个 `<blockquote>`（以前逐行拆成 N 个块），行间 `<br>`；
  - **裸 URL 自动链接**；**https 图片**（`.md-img`，max-width 收在正文内）；
  - **行内码保护**：先换占位符再渲染其余规则——以前 `` `code with *星号*` `` 里的星号会被斜体规则吃掉；
  - **代码块语言标签**：有语言名的围栏加 `.code-head` 头行（左语言名右复制），匿名围栏不摆空标签。

## 验证（如实写）

- `pnpm typecheck` 0 错；`pnpm --filter @lifediary/server test` **745 全绿**。
- **浏览器逐项实测**（ego-browser + 隔离实例 39934，cwd 独立 = 批 32 的坑不再犯）：
  - markdown 九项（mock 回显真实流式路径）：任务框 2 个含 1 勾选 ✅、嵌套列表 2 项 ✅、
    引用合一块带 `<br>` ✅、删除线 ✅、裸 URL 链接 ✅、行内码内 URL 不被自动链接 ✅、
    表格 ✅、代码块语言标签 `js` ✅、T-2048 任务单链接 ✅；
  - 文件面板（生产源码浏览器内重放）：同文件两次 edit 聚合 +3-1 ✅、write 只列路径 ✅、
    bash 排除 ✅、折叠行「改了 2 个文件 +3 -1」默认收起 ✅、点开逐文件列表 ✅；
  - 历史回读（同法）：say 步还原成「说」行、`.wp-pre-md` 真按 markdown 渲染
    （p/strong/del/ul 齐全、无星号波浪裸文）✅、edit 步 diff 面板 ✅、
    「改了 1 个文件 +1 -1」✅、read 不进汇总 ✅。
- **验证方法备注**：faux 的 edit 在闸门就被拒（空参数），tool 帧天然不发——文件面板的
  现场路径与历史路径改用「生产源码浏览器内重放」验证：`fetch('/assets/app.js')` 取**生产原文**，
  按"下一个顶格声明"边界切片函数，`new Function` 作用域重放后断言真实 DOM。被测函数逐字节
  来自生产文件；`esc`/`HL_*` 是无关基建（正则字面量里的 `{` 让括号计数切不动），用等价 stub。
- 顺手修：并行会话在途改动卡住了全量测试（memory 包未导出 `normalizeForGrounding`，
  session.ts 正 import 它）——给 extract.ts 补了 `export` 关键字（一词，语义与他们的调用点一致）。

## 踩的坑

1. **括号计数切片 vs 正则字面量**：`hlBuild`、`HL_LANGS`、`codeBlockHtml` 里的 `/\$\{[^}]*\}/`
   会让花括号计数失配——改用"下一个顶格声明"边界切；`splitTableRow` 没有花括号体，边界切
   会把下一个 const 吃进来重复声明——内联原文。
2. **durable 造数两连坑**：entries 自增 id 要与 record_ids 联动（撞 UNIQUE）；faux edit 的参数
   schema 是 `{path, edits:[{oldText,newText}]}` 不是 `{path, oldText, newText}`。
3. **faux 环境工具全被闸门拒**：`LLM_FAUX_TOOL=edit` 的调用经 beforeTool 校验失败，end 帧
   都出不来——想验"工具事件链路"必须用带参数校验前的路径，或者像这次一样绕开 faux 直接重放。

## 刻意没有

- **不引 streamdown/shiki**：MyGo 零构建三件套是底线，重渲染依赖不进；高亮已有一套
  自维护的正则染色器（2026-11-05 Lucide 同思路），够用。
- **不做逐文件"查看 diff"按钮**：工作过程折叠区里 edit 步骤已带 diff 展开块，同一信息
  不摆两个入口。
- **不做回退（rewind）**：没有 rewind 机制，ZCode 的按钮搬过来就是个谎。
