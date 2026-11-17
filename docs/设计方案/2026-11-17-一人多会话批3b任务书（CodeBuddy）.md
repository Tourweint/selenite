# 批3b 任务书：分支入口 + 来源行（CodeBuddy）

**给谁**：CodeBuddy（`--model deepseek-v4.1-flash`；hy4flash-free 额度已满到 2026-11-18）。
**仓库**：`<repo>`。**不要 git add / commit / push。**
**先读**：
- `docs/设计方案/2026-11-17-一人多会话（一主多副·插件）.md` 第 6 条
- `docs/设计方案/2026-11-17-会话分叉（从某条回答另开一支）.md` §界面（这一版）
- `docs/变更记录/2026-11-17-一人多会话批3a（分支复制引擎）.md`
**前提**：批3a 已落地并验收（`POST /agent/chat/:id/branches`、assistant 消息 id、`ChatOrigins`）。
**范围**：电脑端分支入口 + 来源行 + `/messages` 响应补 `origin` + 小单测。**不改复制引擎**（除本节点名的 group 拒绝）。

**工作树提醒**：仓库里有别人未提交的改动。只做定点编辑；不整文件重写、不格式化。
不要碰手机端、`shared`、批1/批2 的 side 会话逻辑。

---

## 一、服务端：`/messages` 响应补 `origin`（只增不改）

`ts/apps/server/src/index.ts` 的 `GET /api/v1/agent/chat/:conversationId/messages`：

- 读一次 `ChatOrigins` 快照：`(await harness.snapshot(ChatOrigins, CTX))?.byExternal?.[chat.externalId]`
  （`getHarness` / `ChatOrigins` 已在文件里 import；没有就补）；
- 有值才带：`...(origin ? { origin } : {})`；`origin` 形状
  `{ source: string; sourceTitle?: string; at: number }`；
- **分页与全量两个响应都带**（`pageFields` 之外并列），老客户端忽略即可。

## 二、服务端：group / routine 会话不允许分支

`POST /agent/chat/:id/branches` 里，拿到 `link = linkOfSession(chat.internalId)` 后：

- 若 `link` 存在且 `role` 不是 `canonical` / `side`（即 `group` / `routine` / `topic`）：
  `400 { error: "branch_not_supported", message: "这类会话不能分支" }`。
  否则会落到"worker/chief"分支，把群成员会话复制成一条总管会话，身份就丢了。
- canonical/side 的 `side_sessions_disabled` 400 保持现状。

## 三、新建 `web/branch.js`（纯函数，无 DOM）

```js
/** 来源行文案：{text, source}；没有 origin 返回 null。 */
export function formatBranchOrigin(origin) {}
// text = `副本 · 来自 ${sourceTitle || "一条会话"} · ${formatMessageClock(at)}`
// formatMessageClock 从 "./msg-clock.js" import（纯函数）；at 无效时省略时间。

/** 分支失败 → 一句人话（未知码给通用句）。 */
export function branchErrorText(code) {}
// conversation_busy / branch_point_empty / branch_too_large /
// side_sessions_disabled / branch_not_supported / 其它
```

新建 `ts/apps/server/src/web-branch.test.mjs`（node:test，直接 import 上面的模块）：

- 有 sourceTitle + 有效时间 → 文案含两者；
- 无 sourceTitle → 「来自 一条会话」；
- at=0 / 非数字 → 不出现时间；
- origin 为空 / 缺 source → null；
- 已知错误码映射到预期中文；未知码给通用句。

把测试加进 `apps/server/package.json` 的 `test` 清单。

## 四、回答脚注加「从这里分支」

`web/chat-thread.js`：

1. `foot` 里复制按钮之后、时钟之前，加一枚分支按钮（同一套 `footSvg` 图标）：
   Lucide git-branch 路径：
   `<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`
   `className = "branch-btn"`，`aria-label/title = "从这里分支"`。
2. **只在有正文的回答上出现**（`text.trim()` 非空）；空正文（只有步骤）不挂。
3. **可见性**：
   - worker / chief：显示；
   - `parsePartnerExternalId(state.conversationId)`：`canonical` / `side` → 仅 `state.sideSessionsEnabled` 时显示；
   - `group` / 其它（`task-` 等）→ 不显示。
4. 点击：
   - `const id = wrap.dataset.messageId || await resolveMessageId(wrap)`；拿不到 → toast「这条回答还没落盘，稍后再试」；
   - `POST /api/v1/agent/chat/${state.conversationId}/branches` body `{ atMessageId: id }`；
   - 成功 → toast「已另开一支」+ `void openChat(data.conversationId)`；
   - 失败 → `toast(branchErrorText(data.error))`；
   - 期间 `branch.disabled = true`，finally 恢复。
5. `resolveMessageId(root)` 现在只回填 user。扩成按角色回填：
   - `const all = (data.messages || []).filter(m => m.id)`；
   - 对 `user` / `assistant` 分别取同角色的 `msgs` 与 `el.thread.querySelectorAll('.msg.' + role)`，从末尾对齐写 `dataset.messageId`；
   - 注意 `.msg.letter`（来信）不是 `.msg.user`，且来信无 id，两边都自然排除；
   - 返回 `root.dataset.messageId || ""`。
   `startEditing` 的既有行为不变。

## 五、新会话顶部的来源行

`web/chat-open.js`：

1. 模块初始化时创建来源条并插到 `el.thread` 之前（**不改 index.html**，避免与在途改动冲突）：

```js
const originBar = document.createElement("div");
originBar.id = "branch-origin";
originBar.className = "branch-origin";
originBar.hidden = true;
el.thread.before(originBar);
```

2. `renderBranchOrigin(origin)`：
   - `formatBranchOrigin(origin)` 返回 null → `hidden = true` + `replaceChildren()`；
   - 否则写入文案（`textContent`，不拼 HTML），`title="回到原会话"`，点击 → 若 `origin.source` 不是当前会话则 `void openChat(origin.source)`；hidden = false。
3. `openConversation` 拿到响应后调 `renderBranchOrigin(data.origin || null)`（分页/全量两条路都走同一个收尾）；
   `startNewChat` / 404 重开时调 `renderBranchOrigin(null)`。
4. 样式加在 `web/style-04-chat-base.css`：`#branch-origin` 一行小字、muted、`padding: 4px 24px 0`、
   可点（hover 变 `--text`），不要占太多高度；主题变量沿用现有。

## 六、契约文档

1. `docs/基线文档/接口-端点1-对话与兼容层.md`：
   - `GET /agent/chat/:id/messages` 响应补 `origin?`（形状 + 只有分支副本才有 + 分页/全量都带）；
   - `POST .../branches` 错误码补 `branch_not_supported`、`side_sessions_disabled`（批3a 已写一半，补齐）。
2. 新建 `docs/变更记录/2026-11-17-一人多会话批3b（分支入口与来源行）.md`：
   改了什么 / 为什么 / 验了什么 / 没做（列表"副本"徽标、画板、压缩现场真机）。

## 七、验证

```bash
cd <repo>/ts
pnpm typecheck
pnpm --filter @lifediary/server test
node --check apps/server/web/branch.js apps/server/web/chat-thread.js apps/server/web/chat-open.js
```

- 新增 web-branch 测试 + `web-imports.test.mjs` 必须过；既有 5 红照旧。
- `pnpm --filter @lifediary/server http` 至少 §34 不回归（已知 tool-usage 1 红无关）。
- 浏览器人工验收由验收方做（真点分支 → 新会话 → 来源行）。
- 不提交、不 push、不动别人的在途改动。
