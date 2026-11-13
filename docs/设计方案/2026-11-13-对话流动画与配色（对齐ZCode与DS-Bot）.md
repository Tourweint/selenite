# 对话流动画与配色（对齐 ZCode / DS-Bot）

- **状态**：已落地（2026-11-13）。本文件记录设计期取舍；落地后的长期口径见下表。冲突时以长期文档为准。
- **下沉落点**：

| 内容 | 落点 |
|---|---|
| 已知边界（只做电脑单聊 / 长文退回静态 / flag 回滚） | `docs/基线文档/系统架构.md`「对话流逐字浮现的已知边界」 |
| 落地细节与验证结果 | `docs/变更记录/2026-11-13-对话流逐字浮现与配色收敛.md` |
| 契约 | **无变化**（不改 shared、不改 HTTP、不改存储） |

## 一、问题

电脑端 `web/app.js` 的流式回答每帧执行 `body.innerHTML = renderMarkdown(answer)`。整段 DOM 被替换，任何挂在正文子节点上的入场动画都会在下一帧被杀掉，所以文字只能"成块蹦出"；再好的配色也像贴上去的，不像长出来的。

另外两处让观感显得廉价：

1. 历史回读和新消息共用 `.msg.user/.msg.assistant` 的入场动画——打开一条 200 条的旧会话会整屏同时入场；
2. 正文尾部是 6px 的方块闪烁 caret；用户气泡是淡紫主题色，强调色进了气泡。

## 二、参考项目看到的东西

### ZCode（`<reference>\ZCode`，2026-11-13 快照）

- **逐字/逐词浮现**：`packages/ui/src/components/ai-elements/message.tsx:845-1154`、`packages/ui/src/styles.css:1111-1169`。
  - 正文 DOM 第一帧就是完整的，只让 opacity 变；不生成第二份逐步变长的正文（否则高度逐帧增长，撞滚动跟随）。
  - 每个非空白单元包一个 span；中日文按单字，拉丁文按词；`pre/svg/math` 跳过；行内 `code` 整体一个单元。
  - 跨帧浮现时钟：`rate/gap` EWMA；`lag = clamp(max(6*perUnit, 1.5*gap), 80, 250)`；`interval ≤ 40ms`；只写 `transition-delay`，不跑 rAF。
  - CSS 用 `transition + @starting-style`，不用 keyframes——词在下一帧从 new 变 settled，keyframes 会因选择器失配被移除。
  - 固定 300ms ease-out；不按速度缩短时长（能否看出淡入只取决于单个字有几帧在渐变）。
- **其他值得借的**：思考中的渐变扫光（`styles.css:957-1004`）、工具进度条不确定扫光（`styles.css:1007-1028`）、260ms 整块入场（`styles.css:1048-1056`）。
- **设计原则**：`DESIGN.md:589-594` —— fast / low-drama；motion 解释状态变化而不是装饰；主工作区避免长、弹、玩闹的动画。

### DS-Bot（`<reference>\DS-Bot`）

- **弹簧系统**：`ds-bot/src/client/motion.js:29-62` 的 `SPRING_SHAPE/TAP/LIST/POP/STRETCH`、`useFlip/useMorph/useLinger`；`mark.js:14-18` 的 thinking/searching/working/done 状态。
- **值得借**：状态感（新行入场、状态点落定、状态短语）与弹簧手感。
- **刻意不借**：idle fidget（9 秒一次的东张西望）、悬停蹭、点击转 360°、头顶「?」骑跳——放在咱们的执事/派活卡上会显得玩具化。

## 三、取舍

1. **配色保留纸感**：四主题、宋体、靛蓝强调色都不动；只把用户气泡从淡紫改中性墨色，工作卡/代码块改用 hairline + inset 面。借 ZCode 的"克制"（大面积中性、单一强调色、气泡几乎无色），不抄它的灰白蓝。
2. **范围 = 电脑端单聊 + 执事/派活卡**：不做全站微动效，不做手机端，不改群聊流式。
3. **普通回答不加头像**：身份感放在派活行的 domain chip 上；不给每条回答加头像，避免单聊变重。
4. **不重写 markdown 解析器**：`renderMarkdown` 仍是唯一正文渲染源；逐字只在其输出上做 DOM 增量。

## 四、实现

### 1. 逐字浮现（`web/stream-reveal.js`）

- 纯函数：`segmentRevealUnits`（Segmenter 缓存 + 中日文拆字）、`isIncrementalRevealSource`（纯追加且 ≤600 字符）、`planRevealSchedule`（跨帧时钟）。
- DOM：`buildRevealTree` 把 `renderMarkdown` 输出变成"每个单元一个 span（settled + 绝对偏移）"；`createStreamRevealer` 与本轮旧 DOM 做递归 diff：
  - 同标签/同属性的元素递归；
  - 连续的文本/span 视为 text run；新 run 是旧 run 的前缀 → 保留旧节点，只把增量作为新 span 追加；
  - 拉丁词续写（`wor` → `world`）只改旧 span 文本，不新建；**只认 `[A-Za-z0-9_]`**——中文没有空格，按"非空白"合并会把整段吸进一个 span（实测抓到的 bug）；
  - 非前缀（如 `**` 闭合导致结构变化）只替换该 run，偏移越过上一轮长度的单元才淡入。
- 收尾 `finish` 完整重渲染一次去掉所有 span。
- 边界：非前缀 / 单帧 >600 字符 / 源文本 >8000 字符 / 连续三次更新耗时 >28ms（慢机器或超长单段）/ `prefers-reduced-motion` / flag=false → 静态渲染。

### 2. 接入 `web/app.js`

- `send()` 的 `paint()` 改走 `streamView.update(answer)`；中间话折叠时 `streamView.reset()`；`finally` 用 `streamView.finish(answer)`。
- 开 reveal 时不建 6px caret；flag 关闭时保留旧路径。
- `addMessage(..., options={fresh})`：只有 `send` / `followUp` / `steer` 传 `fresh:true`；`openChat` 历史回读不传。
- 思考卡：彗星环 + 扫光文案，`data-live` 定格后停。
- 工作过程：`.is-live` 面板头行加 2px 不确定进度扫光；新步骤行 220ms 入场；状态点落定弹一下；历史面板不加。
- 派活行：`event.domain` 首字做 16px chip，运行中 accent 环。

### 3. 配色（`web/style.css`）

- 四主题新增 `--chat-bubble` / `--chat-hairline` / `--chat-inset`（paper/white 墨 5/9/4%，indigo/black 白 8/10/6%）。
- 用户气泡、工作卡、文件汇总卡、代码块/参数面全部走新 token；强调色只留链接、运行态、选中态、思考卡左侧线。

### 4. 回滚

`CHAT_STREAM_REVEAL=false`（`src/flags.ts`，默认 `true`，`hot:true`）→ web 开新消息时读不到 true 就走旧路径。系统「减少动态效果」同样回旧路径。

## 五、明确不做

- 不换掉纸感/宋体/四主题，不全站对齐 ZCode 灰白蓝。
- 不搬 DS-Bot 的 mascot idle/fidget/poke。
- 不重写 `renderMarkdown`，不改契约、不加依赖、不加构建步骤。
- 不做逐帧高度/宽度动画（只动 opacity/transform）。
- 不动手机端仓库；群聊流式这轮不接 reveal。
- 不做 ZCode 的 105 点 orb；思考卡用 14px conic 彗星环，够用且便宜。

## 六、验证

- `node --check web/app.js` / `web/stream-reveal.js`。
- `pnpm typecheck`（clean）。
- `pnpm --filter @lifediary/server test`：809 通过（新增 `src/web-stream-reveal.test.mjs` 3 条；`flags.test.ts` 补新开关断言）。
- `pnpm --filter @lifediary/server http`：端到端全部通过；§26 新增 `CHAT_STREAM_REVEAL` 默认开且 hot。
- 浏览器（IAB，39847）：
  - 真发 196 字中文回答：196 个 span；新 span 第一帧 computed opacity=0，`transition-duration:0.3s`，延迟 0–40ms；收尾 span 清零、正文完整。
  - 历史回读：12 条消息 0 个 `.is-new`、0 个 reveal span、0 个运行中动画、0 个 caret。
  - 四主题 token 计算值正确。
  - 结构 smoke：加粗闭合、列表、拉丁词续写、reset，文本不重不漏；代码块不被逐字包住。
- 没验的：`prefers-reduced-motion` 只做了 CSS 规则与代码分支核对，没在 IAB 里模拟系统级 reduce；flag=false 的浏览器路径没切换实测（旧路径代码未改）；手机端不在范围。
