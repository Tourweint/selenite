# 群组参考调查（四仓库，2026-11-06）

> 方法：Qoder CLI 只读调查（dont_ask · DeepSeek-Flash），逐仓库独立跑，任务书与原始输出在
> `%LOCALAPPDATA%/Temp/group-inv/`（临时目录，随系统清理）。结论已蒸馏进同日群组方案 §一；
> 本文保留细节（文件路径:行号）供后续写实施任务书引用，冲突以方案为准。

## Cindy（UI 蓝本）

（is_error=False, permission_denials=1）

# Cindy「群组 / 多 agent 会话」调查报告

## 结论速览

- Cindy 有**完整的群聊子系统**（伙伴群聊 bot-group-chat），形态正是"一个会话里多个 AI 成员 + 用户"，Desktop、Mobile、Chat Server 三端共用同一份 wire 契约。
- 它与 Orca 的 lead/worker 协同是两套东西：Orca 是单任务的内部多 agent（`sessions.orca_role`），群聊才是"多成员对等聊天"。产品文档明确"协同"指 Orca、"协作"指共享任务，群聊里用的是"分工"。
- 核心设计：**宿主确定性编排发言**（不是让模型互相 @），每条群消息只带**作者快照**，每个 bot 的私有过程走**隐藏的 group lane Session**，群里只放一个定位卡片。

---

## 1. 有没有"群组 / 多 agent 同一会话"

有，而且是产品级一等对象。

**权威规格**：`docs/product-rules/bot-group-chat.md`（1273 行）
- §2 用户心智：群在侧栏与伙伴并列，按活跃排序；"+"菜单可建群；私聊里可"添加到群"。
- §4 发言编排；§5 UI；§7 分工；§10 Chat Server 多账号群（引用、话题、已读、未读）。

**共享 wire 契约**：`packages/maker-shared/src/botGroupChat.ts`
- 成员上下限：`BOT_GROUP_MIN_MEMBERS = 2` / `BOT_GROUP_MAX_MEMBERS = 6`（:13-31），消息上限 8000 字、单页 100 条、分工最多 6 步。
- 群成员视图 `BotGroupMemberView`（:126-150）：`botId / name / avatar / avatarColor / status`，外加 `actorId / actorKind / role / ownerActorId / ownerName / isOwned / isSelf / guestAccess / homeDeviceId`。
- 群消息视图 `BotGroupMessageView`（:152-202）：

```ts
kind: 'message' | 'round-end' | 'notice' | 'plan' | 'plan-end'
authorKind: 'user' | 'bot' | 'system'
authorBotId: string | null
authorName: string           // 名字快照，成员改名/离群后历史不变
mentions: { all: boolean; allBots?: boolean; botIds: string[] }
noticeCode / planId / quote? / task? / process? / reactions? / threadRootId?
```

**发言编排（关键，和"让模型自己互相 @` 完全不同）**
- 回复模式 `replyMode: 'all' | 'mentioned'`、发言顺序 `speakingMode: 'auto' | 'sequential'`；Chat Server 侧 `groupSingleSpeaker` 保证同一时刻只有一个发言者。
- 排队卡 `talk` 与分工卡 `work` 是两种意图；前 5 轮自动继续，第 6 轮起停在 `round-end` 等用户点「继续讨论」；bot 可用 `NO_REPLY` 哨兵静默（`botGroupChat.ts:13-31`）。
- 发言者活动视图 `BotGroupSpeaker` / `BotGroupRoundView`（:449-472）：`activity: 'reply' | 'planning' | 'step'`、`executionStatus: 'queued' | 'running' | 'needs_input' | 'stopping'`、`{ status, speakers, canContinue }`。

**隐藏的 group lane Session**（不是每个 bot 一份群聊历史）
- `packages/maker-shared/src/botGroupChat.ts:800-857`：`chatGroupLaneRouteKey`、`chatGroupTalkRouteKey`、`chatGroupThreadRouteKey`、`botGroupPlanRouteKey`，route key 形如 `group:<groupId>`、`:access:<mode>:<rev>`、`:plan:<planId>`、`:thread:<rootId>`、`:talk:<planId>`。
- `apps/desktop/src/main/localDb/schema.ts:444-470`：`bot_session_links.role` 枚举 `canonical | history | delegation | group | channel | thread | routine`，每 bot 仅一个 canonical。
- 过程不落群消息：`packages/maker-shared/src/botGroupProcess.ts` 定义 `cindy.work-record` 卡片（schemaRevision 1），只存定位 `{ groupId, executionId, sessionId, clientId, deviceId?, durationMs? }`；`readBotGroupProcessMessages` 按 `clientId` 沿有限历史窗口回读，遇到本轮结束即停。渲染方 `apps/desktop/src/renderer/features/bots/BotGroupProcess.tsx:1-72` 用 `WorkGroupBlock` + `TeammateWorkSegment` 把 thinking/tool 折叠展示，正文用 Markdown。

**存储（本地 SQLite，服务端群以 Chat Server 为准）**
- `schema.ts:655-679` `bot_groups`：`name / reply_mode / speaking_mode / organizer_bot_id / project_dir`。
- `schema.ts:681-700` `bot_group_members`：`group_id / bot_id / position / last_seen_sequence / joined_at`。
- `schema.ts:702-735` `bot_group_messages`：`sequence / kind / author_kind(user|bot|system) / author_bot_id（无外键，消息寿命长于作者）/ author_name 快照 / content / mentions_json / notice_code / client_id（幂等）/ plan_id / files_json / attachments_json`。

---

## 2. 会话 / 对话数据模型

**两层：Session（执行）与 Message（展示）。**

`schema.ts:123-230` `sessions`：`workspaceKind / model / permissionMode / orcaRole / ...`。
`schema.ts:895-965` `messages`：`role` 枚举 `user | assistant | tool_use | tool_result | ask_user | plan_review | thinking | error | agent_switch | context_rebuild | message_tombstone`，`content` 为 JSON，另有 `tool_use_id / agent_meta / rewind_at`。

**群消息归属**完全由 `bot_group_messages` 的四个字段表达：`author_kind`、`author_bot_id`、`author_name`、`client_id`。服务端消息映射见 `apps/desktop/src/main/maker-ipc/chatServer.ts:1410-1490` 的 `messageView()`：

```ts
authorKind = m.author.kind === 'human' ? 'user' : 'bot'
isSelf = m.authorId === selfId
authorName = legacy?.authorName ?? (member ? memberName(member, ownerMembers) : m.author.name)
origin === 'system'            → kind: 'notice'
cindy.plan 卡                  → kind: 'plan'
cindy.work-record 卡           → process（定位卡）
cindy.group-notice 卡          → noticeCode: member-failed | member-timeout | plan-failed
```

要点：
- **名字是快照**，不是 join 出来的实时名；`botGroupMemberDisplayName`（`BotGroupTimelineModel.ts:293-315`）只在"别人的伙伴"上追加 ` (主人昵称)`，自己账号下的 bot 不追加。
- **`authorBotId` 可为 null，但消息保留**——成员被移出/机器人被删后，历史仍然可显示作者名。
- 展示谓词集中在 `packages/maker-shared/src/botGroupPresentation.ts`：`chatGroupMemberName`（:34-37）、活跃判断（:40-42）、权限（:45-55）、同作者合并（:117-124）、执行失败投影成合成 notice 行（:135-152）。

---

## 3. 消息 UI

时间线按 `kind` 分流，而不是按"是不是 AI"硬编码。

**四种行形态**（`apps/desktop/src/renderer/features/bots/BotGroupTimelineItem.tsx`）
- 自己：右对齐 `justify-end`，`ChatBubble speaker="user"`，附件在气泡内，已读尾巴右下（:480-523）。
- 别人（bot 或他人）：左对齐，固定 `w-7`（28px）头像列 + 名字行 + 气泡（:559-644）。
  - 名字行：`text-13 font-medium`、`text-11` 时间、`BotGroupNameTag` 药丸（:263-269）：

```tsx
<span className="inline-flex min-h-[18px] items-center rounded-full bg-[var(--surface-chip)] px-1.5 text-11 …">
```

  药丸内容：`负责人` / `第 k 步` / `某某的主人`。
- 系统/公告：居中 `SystemLine`，两侧发丝线 + `text-12` 三级字色；回合结束（`round-end`）带「继续讨论」按钮（:363-424）。
- plan 卡与 process 卡：独立卡片，不走气泡。

**分组规则**（`BotGroupTimelineModel.ts`）
- `BOT_GROUP_MERGE_WINDOW_MS = 5 * 60 * 1_000`，同作者 5 分钟内连发合并，后条省略头像与名字。
- 跨天插入日期分割线；`authorKey` 对 plan/notice 永远强制新块。
- `layoutBotGroupTimeline`（:256-289）产出 `{ continued, dateDivider }` 传给行组件，行组件本身无状态。

**@ 高亮**（`BotGroupTimelineItem.tsx:65-127`）
- 用 CSS Custom Highlight API，不改 DOM：

```css
::highlight(bot-group-mention) { color: var(--msg-link); background-color: transparent; }
```

- 在 Markdown 渲染后的文本节点上做 Range 收集，`MutationObserver` 重新同步（流式输出时仍生效）；悬停 250ms 打开 `BotGroupMentionCard`（:229-246）。
- 已读尾巴用 `placeReadTail` + `READ_TAIL_WIDTH = 22` 预留尾部空间，避免出现"已读"时气泡跳动（:132-168）。

**颜色与头像**
- `BotAvatar.tsx:51-61` 九个 hue token：red/orange/amber/green/teal/blue/violet/pink/graphite，映射到 `--bot-avatar-*-bg`；尺寸 `xs 20 / sm 28 / md 40 / row 44 / strip 36 / lg 56 / xl 64`（:69-79）。底色先铺色相再加载图片，避免白闪。
- 群头像（`BotGroupAvatars.tsx:15-102`）：1 人直出；2 人第二个在左上（26/30px），第一个右下带 2px 描边；3–5 人取 `slice(0,5).reverse()`，直径 60/55/50%，半径 `(100-diameter)/2`，起始角 `-3π/4`，用 cos/sin 绝对定位，全部 2px 与表面同色描边。

**工作指示**
- 群内 `BotGroupLiveStatus.tsx:57-109`：头像 + 名字 + 呼吸 `Sparkles` + `BotGenerationLabel` 阶段文案 + "查看过程"，下方可挂待确认交互。
- 发言超过 3s（`BOT_GROUP_PROGRESS_STRIP_DELAY_MS = 3_000`）或分工步骤执行时出现进度条（:125-252），每个发言者一行，"第 k/n 步 · 任务"，行尾可"停止我的/全部停止"。
- 头部状态优先级 `botGroupHeaderStatus`（:255-292）：排队 > 步骤执行 > 规划 > 发言；文案用 `--status-bar-accent` + 呼吸 Sparkles。
- 侧栏行（`BotGroupSidebarRow.tsx:82-237`）：副标题单行 12px，按优先级显示最后一条消息（`作者：内容` / `你：内容`）→ 分工状态（`正在安排…`、`分工 k/n · 谁 正在做`、失败/等待）→ 正在运行（呼吸 Sparkles）；右上时间、未读数 `NavigationCountBadge`，被 @ 时额外显示 `@`。

---

## 4. 成员 / 联系人列表 UI

Cindy 没有"上下文环"，用**状态点 + 复合头像 + 药丸**三件套，另有三个可复用列表形态。

1. **侧栏行**（`BotGroupSidebarRow.tsx`）：IM 几何 `rounded-xl px-2.5 py-2`，左复合头像 + `TeammateStatusDot`，右两行（名字 `text-14`、副标题 12px 单行截断），右上时间，右下未读/`@`。
2. **群头部**（`BotGroupChatView.tsx:821-865`）：头像叠放（`BotGroupAvatars.tsx:105-132`，`-ml-2`/`-ml-3` 叠压 + `border-[var(--surface)]`）+ 群名 + 第二行**要么是实时状态，要么是成员数**——不堆成员名字，名字放 tooltip。右侧邀请图标与设置齿轮。
3. **群设置 · 成员页**（`ChatGroupMembersTab.tsx:29-89`）：搜索 `Input` + `SettingsCard` 行；每行头像、显示名、`配合 · 权限` 或角色、自己标"你"；行尾 `⋯` 且右键同行打开同一菜单，菜单项按权限动态出现（`自己的伙伴权限` / 设为或取消管理员 / 转让群主（只转给人）/ 移出）。
4. **@ 悬停名片**（`BotGroupMentionCard.tsx:13-74`）：头像、显示名（昵称不同才显示全名）、身份行（"谁的伙伴"/群主/管理员/成员/访客）+ 暂停/不可用状态；身份解析优先用显式 mention id，**绝不猜**广播标签或重名。

药丸复用处除名字标签外，还有分组/权限标签统一走 `--surface-chip` + `text-11`，高度 18px。

---

## 5. Composer：有没有"指定对谁说"

有，这是群里最核心的交互，但实现是**纯文本 + 发送时重解析**，不是富文本 mention 节点。

**选择器**：`apps/desktop/src/renderer/features/bots/useBotGroupMentionPicker.tsx`
- 候选顺序：`所有人` → 可选 `所有伙伴` → 活跃成员（排除自己）（:89-110）。
- 键盘：↑/↓ 移动，Enter/Tab 选中，Esc 只关掉本次 `@`（:188-210）；选完恢复光标。
- `tracked` 记录"选中的 botId + label + `@` 的 UTF-16 下标"，文本未变才继续有效（:138-164、:201-234）——用来消歧重名、并让离群成员仍保留显式目标，由宿主拒绝。
- 面板：`role="listbox"`，`absolute bottom-full left-0 mb-2 max-h-72 w-64 bg-[var(--cmd-palette-bg)]`，成员行用头像、`所有人` 用 Users 图标（:233-278）。

**解析器**：`packages/maker-shared/src/botGroupMentions.ts`
- 最长标签优先，`@小满满` 不会被 `@小满` 截走（:98）。
- `@` 前是邮箱/标识符字符则不认为是点名（:46-58）；中文名后不必跟空格，拉丁名结尾要求词边界（`endsAtBoundary`）。
- 返回的 `botIds` **按正文出现顺序**，宿主直接按此顺序轮流发言（:133-159）。

**发送**：`apps/desktop/src/renderer/features/bots/BotGroupComposer.tsx`
- 发送时从正文重新解析 mentions（手打和点选一致），同时带 `division` 标志；`clientId` 复用签名做乐观发送与幂等（:446-505）。
- 运行中且输入为空 → 发送键变停止键；有引用时显示引用预览；"+"菜单含附件与「安排分工」（:692-755）。
- 占位文案随状态变化：分工里、以及"没有 @ 时这段话会发给谁"（:562-574）。
- 草稿按群持久化（`composerDraftStore`，:304-320）。

---

## 6. 最值得抄的 5 个实现点

1. **消息行 + 合并 + 日期分割**（UI 层）
   `apps/desktop/src/renderer/features/bots/BotGroupTimelineItem.tsx:480-644` + `BotGroupTimelineModel.ts:256-289`
   值得抄：右自己/左别人、28px 头像列、5 分钟同作者合并、跨天分割、`memo` 行组件。数据与布局分离，行组件无状态，新增发言来源不用改行组件。

2. **复合群头像几何**（纯 CSS/定位）
   `apps/desktop/src/renderer/features/bots/BotGroupAvatars.tsx:15-102`
   值得抄：1/2/3–5 人三套规则、直径 60/55/50%、起始角 `-3π/4`、2px 同表面描边消除叠压毛边。逻辑不足 100 行，可原样移植。

3. **@ 选择器 + 纯文本解析 + tracked 消歧**（交互 + 纯函数）
   `useBotGroupMentionPicker.tsx` 全部 + `packages/maker-shared/src/botGroupMentions.ts:133-159`
   值得抄：不引入富文本编辑器，textarea 上叠浮层；"正文是真相，发送时重解析"；选中记录 botId 解决重名；返回顺序即发言顺序。对 lifediary 这种原生 HTML/JS 前端改造成本最低。

4. **作者快照 + kind 驱动渲染**（数据层）
   `schema.ts:702-735` 的 `author_kind / author_bot_id / author_name / client_id` + `chatServer.ts:1410-1490` 的 `messageView()`
   值得抄：消息不 join 作者表，改名/离群/删成员后历史不变；`kind` 决定行形态（message / notice / round-end / plan），而不是在组件里判断"是不是 AI"。

5. **"谁在干什么"三层指示**（状态表达）
   `BotGroupLiveStatus.tsx:57-109 / 125-252 / 255-292` + `BotGroupSidebarRow.tsx:82-237`
   值得抄：群内呼吸 Sparkles + 阶段文案；超过 3s 才出进度条（避免闪一下）；头部一句话状态；侧栏副标题同一套优先级。SSE 场景可直接把事件映射到这三层，不用做 typing 动画。

补充可抄但优先级低：系统/公告居中发丝线行（`BotGroupTimelineItem.tsx:363-424`）、@ 悬停名片（`BotGroupMentionCard.tsx`）、process 定位卡（`botGroupProcess.ts`，把工具过程折叠到"查看过程"里）。

---

## 对本项目的启示

lifediary-harness 现有的"总管/执事/工人"是**层级 + 单对话 SSE**，Cindy 的群聊是**对等成员 + 宿主编排**。两者可以复用同一套消息/UI 模型，但不要照抄编排逻辑。

1. **成员模型直接映射**：执事 = `BotGroupMemberView` 的精简版（`botId / name / avatar / avatarColor / status / isSelf / isOwned`）。总管不要当成"群主角色"硬编码，Cindy 的做法是 `role: owner|admin|member|guest` 与 `isSelf` 正交，便于将来换群主。
2. **消息归属必须落快照**：`authorKind + authorId + authorName + clientId` 四件套。执事改名、被停用、被删除后历史仍要能渲染；`clientId` 用于 SSE 重连去重与乐观发送回填。这是最低成本、最高收益的一条。
3. **发言由 harness 决定，不让模型互相 @**：lifediary 已有总管，最自然的做法是总管/编排器产出"下一个发言者是谁"，前端只渲染 `speakers` 与 `running` 状态。Cindy 的 `NO_REPLY` 哨兵（沉默也是一种发言）和"第 5 轮后停下等继续"值得抄，避免群里无限自嗨刷屏。
4. **@ 指定对象用纯文本**：在现有 textarea/input 上叠浮层即可，不必上富文本。建议直接移植"最长标签优先 + 中文名不要求尾空格 + 发送时按正文重解析"，并保留 `botIds` 顺序作为发言顺序。未 @ 时的默认收件人要在 placeholder 里说清楚（Cindy 就是这么做的）。
5. **UI 先做四件事**：左别人/右自己的时间线（28px 头像 + 名字 + 时间）、5 分钟合并与日期分割、系统/公告居中行、每个执事一行"呼吸点 + 正在做什么"。这四件到位，群聊的"多人在场感"就有了；复合头像、@ 悬停名片、进度条属于第二阶段。
6. **不要抄的部分**：多设备 group lane、`device-link` 回读、Chat Server 权威同步、plan/分工卡、话题（threads）、已读回执。这些是 Cindy 为多端与多账号付的复杂度，lifediary 单服务单端不需要；但"工具过程只放定位卡、群消息只放结论"这个边界要保留——否则工人日志会污染群聊。
7. **可先落的最小闭环**：① 成员表 + 消息表（含 author 快照）② 群消息 SSE 事件 `speaker_start / speaker_delta / speaker_end / notice` ③ 时间线四形态渲染 ④ composer @ 解析 + 顺序发言。跑通后再加"继续讨论"、分工、过程折叠。

本次调查全程只读，未修改、创建或删除任何文件。

## DS-Bot（DeepSeek 社区桌面 bot）

（is_error=False, permission_denials=2）

只读调查完成，未改动任何文件。结论：**DS Bot 有完整、可运行的群聊实现**，而且它的架构选择比 UI 更值得参考——群不是“一个模型会话里多个 persona”，而是“一个共享时间线 + 每个成员一条隔离会话 + 确定性路由器”。

---

## 1. 有没有群组/多 agent 同聊形态

有，且是产品主路径，不是 demo。核心对象叫 `room`（群），成员是 Bot，有管理员和两种回答模式。

**数据模型**（`ds-bot/src/host/roster.js:503-513`）：

```js
const room = {
  id, name,
  ...(custom ? { named: true } : {}),
  members: live,              // Bot id 数组，2–12 个
  admin: lead,                // Bot id 或 null
  mode: mode ?? 'admin',      // 'admin' | 'everyone'
  notice: cleanNotice(notice),
  createdAt: Date.now(),
  createdBy: createdBy ?? null,
}
```

约束：至少 2 个、最多 12 个成员；管理员必须是成员；Main Bot 默认当管理员（`roster.js:471-486`）。运行时还会在 room 上挂 `sessions`、`segments`、`parts`、`log`、`seen`、`seq`（`store.js:413-424`）。

**交互流**：

1. 用户往群的 Session 发消息（不是直接发给某个 Bot）。
2. 群的 Session 是 **relay-only**：`llm/stream` 钩子拦截模型流，不真正请求模型，而是合成一次 `group_relay` 工具调用（`groups.js:1421-1465`）。
3. `group_relay` 把排队的用户消息写进群日志，选出发言人，建一轮 round（`groups.js:869-1025`）。
4. 每个被选中的成员在自己的隐藏群会话里跑一轮，回复写回群日志和 `round.replies`。
5. 客户端轮询 `room-progress`，实时画“谁在打字/谁在干活”；工具结果返回后一次性渲染结构化回复。

**谁回答**（`groups.js:1120-1139`，规则见 `docs/plans/2026-10-07-group-chat.md:17-30`）：

- `@名字` 只叫被点名的人；同一条消息点到的人**并行**开工。
- 不带 `@` 的普通消息：`admin` 模式只给管理员；`everyone` 模式全员按顺序回答，管理员第一。
- 成员可 `[PASS]`；被点名者只回“收到”且没调工具，宿主会续推一次。
- 成员之间 `@` 接力；连续 6 轮无工具、只重复/客套才暂停。
- 长任务 15 秒后本轮先往下走，做完再“迟到回复”补进群。

设计文档明确写了两个根本难题：**排序不能交给模型**，**每个成员都带全上下文跑一次，成本线性增长**（`docs/plans/2026-10-07-group-chat.md:10-11`）。所以默认少叫人，由管理员决定点谁。

---

## 2. 会话/对话数据模型

**存储分两层：**

- **消息本体在 DSH Session 里**，DS Bot 不自己存一份消息库。插件只在 `state.json` 里存 Bot/群/指针。`state.json` 整文件写、带 `state.lock`，另一个 host 持锁时本进程只读（`store.js:21-22`、`store.js:344-398`）。
- **搜索索引**另建 SQLite FTS5，从 Session 日志派生，删了可重建；中文用 trigram 分词（`chat-index.js:1-9`、`chat-index.js:108-112`）。

`state.json` 顶层形状（`store.js:21-22`）：

```js
{ version:1, workspaceId?, mainBotIds[], bots{}, privateArchives[],
  rooms{}, agents{}, capabilities:{items}, exchanges[], exchangeTurns{},
  works{}, requests{}, questions{}, views{}, prefs{}, switching{}, revision }
```

**消息归属字段。** 关键点：Bot 发给 Bot 的消息，在接收方 Session 里是 **`role: 'user'`**，靠 `source` 区分谁发的；Bot 自己的输出才是 `assistant`。投递时构造（`delivery.js:66-94`）：

```js
const source = {
  kind: 'bot',            // SOURCE_KIND
  form: 'relay',
  role,                   // request / reply / room / report / kickoff / ...
  exchangeId,
  senderName: fromName,
  ...(fromId ? { senderSessionId: fromId } : {}),
  ...(roomId ? { roomId } : {}),
  ...(audience === 'user' ? { audience } : {}),
  ...(askedBy ? { askedBy } : {}),
  ...(fromRoomId ? { senderRoomId } : {}),
}
const message = createUserMessage({
  content: [{ type: 'text', text: `${headerFor(...)}\n${text}` }, ...files],
  source,
})
```

所以“谁发的”不是靠 `role`，而是靠 `source.kind + senderName + senderSessionId + roomId`；`role` 表示这条消息在协作协议里的语义（请求/回复/群回合/回报等）。文本前面还会加人类可读头：

```text
[Message from X]
[Reply from X]
[Group chat "G" · note]
[Group chat "G" · replies to your post]
```

（`delivery.js:17-40`）

**群内日志行**（`groups.js:235-240`、`groups.js:451-455`）：

```js
{ seq, who: 'User' | member.name, botId?, text, files?, length?, kind? }
// 成员回复同时进 round.replies：
{ botId, name, color, text, time, duration? }
```

`seq` 单调递增，每个成员在 `room.seen[botId]` 记自己读到哪一条，用来算“这轮以来新增了什么”。长文本会溢出到 `group-lines/<roomId>/<seq>.txt`，内存日志只留最近 60 条（`groups.js:194-240`）。

---

## 3. 多 agent / 多 persona 机制

### 人格定义

人格就是 Bot 记录本身（`roster.js:165-179`）：

```js
{ id, name, role /* ≤24 字 */, color?, avatar?, model?, effort?,
  workDir?, instructions, createdAt, createdBy, capabilities: [] }
```

系统提示词由 `prompt.js` 拼：身份（名字、角色、自定义 instructions）+ 团队规则；Main Bot 追加管理规则。**私聊和群聊共用同一份系统提示词**，目的就是让提供方的前缀缓存命中（`prompt.js:44-65`）。群自己的 Session 则是另一段提示词：

```text
# Group chat relay
This conversation is a group chat between the user and several Bots.
You are only the relay, not a participant.
For every new user message: call group_relay exactly once...
```

（`prompt.js:56-63`）

头像/颜色也不是自由文本：30 个内置 SVG 角色，按 Bot id 确定性选默认形状和颜色（`characters.js:10, 53-68`）。

### 路由

路由完全确定性，不靠模型决定顺序：

- 入口：`openingCall(room, opener)` 根据 `opener.kickoff / goal / progress / late / member / @mention / mode` 算出 `speakers` 和是否 `ordered`（`groups.js:1120-1139`）。
- 并行 vs 顺序：同一条消息点名的成员 `ordered:false`，同时开工；全员轮流的普通消息 `ordered:true`，上一个人发完下一个才开始。
- 批次：同一条消息叫的人是一个 batch，各自完成就发群，等整批落地后统一唤醒派活者（`groups.js:397-419`、文档 46-52 行）。
- 空转守卫：连续 6 轮 0 工具且只是重复/客套，暂停；“收到/开工”但没调工具的回合自动续推一次（`groups.js:37-50`、`groups.js:676-714`）。

### 上下文隔离

这是最核心的设计：

- **每个 Bot 在每个群有一条自己的隐藏 Session**，标题 `<Bot> · <Group>`，懒创建；首次创建时把该 Bot 的私聊 brief 作为第一条消息，后续前缀稳定可缓存（`groups.js:266-300`）。
- 群里的隐藏 Session **不读该 Bot 的私聊内容**；要带私聊事实进群，只能显式调用 `read_own_chat`，而且群里会显示“它查了自己的私聊”（`groups.js:1028-1081`）。
- **群记忆独立**：`memory/groups/<roomId>/`，只在这个群的成员群会话里读，不进私聊、不进别的群；成员被移出群后立即读不到也写不了（`memory.js:1-26`、`docs/plans/2026-10-09-context-and-memory.md:106`）。
- **每个 Session 首次渲染时冻结记忆段**，保证提示词逐字节不变、前缀缓存命中；换段或检查点后重新冻结（`memory.js:120-125`）。
- 长对话由“段 + 交接”管理：上下文满了不是硬切，而是由轻量管家判断“原地压缩”还是“换到新段”，旧段归档仍可搜（`parts.js`、`docs/plans/2026-10-09-context-and-memory.md:22-26`）。
- 群自己也有段：群身份 `room.id` 不变，`room.sessionId` 是当前段，换工作文件夹时换到新段（`store.js:406-424`）。

---

## 4. 消息流呈现

### 消息头归属

`GroupMessage`（`client/cells.js:361-381`）：

```js
h('div', { className: 'bt-group-msg', 'data-bot-id': bot.id },
  h('span', { className: 'bt-group-name', style: { color: inkText(colorOf(bot)) } },
    lead, bot.name,
    room?.admin === bot.id ? h('span', { className: 'bt-group-role' }, 'Admin') : null,
    Number.isFinite(time) ? h('span', { className: 'bt-group-time' }, messageClock(time)) : null,
    took ? h('span', { className: 'bt-group-took' }, took) : null),
  h('Bubbles', { texts, roster, selfId: bot.id, ... }))
```

头像可点，直接打开该 Bot 的私聊；名字用 Bot 自己的颜色；管理员带 `Admin` 标签；有时间和本轮耗时。flat 布局时头像移到名字行。

### 流式与“工具/思考态”

群回复不是直接透传某个成员的 token 流，而是**两层**：

1. **进行中**：`GroupReplies` 每 1 秒（页面隐藏时 5 秒）轮询 `room-progress`，拿到 `{ replies, speaking }`；`speaking` 里的成员渲染成打字行：

   ```js
   h(BotMark, { bot, size: 22, state: tool ? toolState(tool) : 'thinking' }),
   h(Shimmer, null, phrase ? `${bot.name} · ${phrase}…` : `${bot.name} is typing…`)
   ```

   （`client/cells.js:952-1015`）

2. **结束后**：解析 `group_relay` 工具结果里的 JSON，用 `stackReplies` 合并同一 Bot 连续的多条短消息，再渲染成正式消息、用户气泡和事件行。

非消息状态是**一等公民**，由 `RelayEvent` 渲染（`cells.js:906-950`）：失败、查私聊、超时未答、管理员跳过、重启续跑、等待审批、开始干活、换文件夹、被用户停止、完成。这样用户不会面对“黑箱”。

### 成员状态与审批

输入框上方有状态胶囊 `MemberDock`：最多 3 张成员脸，等审批的排前面，点开进群详情；`ApprovalCard` 直接给“允许一次 / 拒绝”（`client/member-status.js:105-153`）。群详情里可逐个停成员，也可“全部停止”（`member-status.js:154-190`）。

### @ 菜单

群里 `@` 列出成员和“所有人”；私聊里 `@` 列出其他 Bot；引用其他对话放在 `+` 菜单。提及文本会转成 DSH 规范引用 `@[label](dsh-session:<base64url>)`（`client/at-menu.js:25-41, 65-105`）。

### 提及渲染

客户端和服务端共用同一套匹配规则，只有 `@名字` 才算提及并渲染成链接；邮箱、路径、代码、链接里的 `@` 不算；长名字优先（`client/text.js:11-21`、`src/shared/mentions.js`）。

---

## 5. browser-plugins 跟会话的关系

浏览器能力在 `ds-bot/src/host/browser-plugins.js` + `src/host/browser/`。它跟群聊是**正交的工具能力**，不是群机制的组成部分：

- 整个团队共用一个浏览器插件实现，但**每个 Bot 有独立 profile 目录** `<home>/browser-profiles/<botId>`（`browser-plugins.js:1-8, 90-110`）。
- 写操作（post/upload/download/delete）按站点授权，没授权就走审批卡片；支付类直接拒绝并让 Bot 转 `browser_handoff`（`browser-plugins.js:45-95`）。
- 身份解析靠 `rt.selfOf(sessionId)`：无论在私聊还是某个群的隐藏会话里，都能映射回同一个 Bot（`browser-plugins.js:148-160`）。
- handoff 卡片只回 Bot 自己的私聊；群回合没有卡片（`browser-plugins.js:50-54`）。

**值不值得参考：** 浏览器本身不值得为群聊抄；值得抄的只有两个模式——**“从 sessionId 反查成员身份”** 和 **“每成员独立资源目录 + 授权/审批”**。如果你的群组功能不涉及浏览器自动化，这层可以完全跳过。

---

## 6. 最值得抄的 5 个实现点

1. **群会话只做 relay，路由确定性化**
   `groups.js:1421-1465` + `groups.js:1120-1139`
   为什么：让模型决定“下一个谁说话”在多方场景必乱；把排序、并行、批次、跳过全部写成代码，模型只负责“被叫到时怎么答”。这是整个设计的地基。

2. **每成员每群一条隐藏 Session，懒创建 + 共用系统提示词前缀**
   `groups.js:266-300`、`prompt.js:44-65`、`store.js:413-424`
   为什么：群 UI 是“一个对话”，但每个成员有独立上下文；私聊内容不会意外泄漏进群；系统提示词逐字节相同，能吃到前缀缓存。

3. **群日志 `seq` + 每成员 `seen` 游标 + 结构化 replies**
   `groups.js:235-240`、`groups.js:451-455`、`src/shared/group-replies.js`
   为什么：数据模型极简但够用——能回答“每个成员这轮看到了什么”、支持迟到回复、支持客户端重放和合并短消息。

4. **“实时进度轮询 + 最终结构化结果”双层呈现**
   `client/cells.js:952-1015`、`cells.js:906-950`、`member-status.js:105-190`
   为什么：长任务期间用户能看到谁在想、谁在调工具、谁等审批；结束后又能得到稳定、可回溯的消息块。失败/超时/审批/停止都有专门事件行，不是静默。

5. **上下文与记忆分层：私聊 / 群 / 团队三套作用域，按 Session 冻结**
   `memory.js:1-26`、`docs/plans/2026-10-09-context-and-memory.md:106, 120-125`
   为什么：长期运行的 agent 必须有界上下文，同时不能把 A 群的秘密带进 B 群；冻结记忆段又保住了缓存。`parts.js` 的“压缩 vs 换段”可以后置，但作用域隔离应该一开始就做。

---

## 对本项目的启示

**1. 不要把“群组”做成一次多 persona 的模型调用。**
lifediary-harness 现在是单对话 SSE；加群组时，最自然的错误是“在同一个 prompt 里塞多个执事的人格，让模型分角色输出”。DS Bot 的经验是反过来：**群是一个共享时间线，每个执事仍是独立 agent 上下文，另有一个确定性调度器决定谁发言**。总管最适合当这个调度器（对应 `admin` 模式），但调度逻辑应落在代码里，而不是让总管模型自由发挥。

**2. 数据模型建议**
```ts
Group { id, name, memberIds[], adminId, mode: 'admin'|'everyone', notice }
GroupMessage { seq, senderType: 'user'|'member'|'system', senderId, text, ts, roundId? }
MemberView { groupId, memberId, lastSeenSeq }
Round { id, triggerSeq, speakerIds[], status }
```
成员的“私有上下文”不要塞进 Group；Group 只存共享时间线。每个执事第一次进群时，用“群公告 + 最近 N 条群消息 + 自己的角色说明”起一条独立上下文；之后只增量喂 `lastSeenSeq` 之后的新消息。

**3. SSE 协议**
你们已经有单对话 SSE，比 DS Bot 的轮询条件更好，不要照抄轮询。建议一条群级 SSE，多路复用并带 `seq` 以便断线续传：
```text
round_start { roundId, speakerIds }
member_start { memberId }
delta { memberId, text }
tool  { memberId, name, state }
member_end { memberId, messageSeq }
event { kind: 'approval'|'timeout'|'pass'|'stopped'|'late', memberId }
round_end { roundId }
```
每个 `delta` 必须带 `memberId`，否则前端无法把 token 流归到正确的人。若某个执事的模型调用是独立的，就为每个成员开一条子流，再在群流里做多路复用。

**4. 路由先做最小闭环**
MVP 只做：`@执事` 点名 + 默认“总管先答”（admin 模式）+ 同一条消息点名的并行 + `[PASS]` + 一轮结束。先不要做：全员轮流、Bot 之间无限接力、迟到回复、批次回收、子代理。这些是 DS Bot 在真实使用中一层层补出来的（看 `docs/plans/2026-10-07-group-chat.md` 的“变更”一节，从 10-07 到 11-03 改了几十次），一开始全做会拖垮进度。

**5. 成本与延迟要前置设计**
每个发言成员 = 一次完整模型调用。默认只让总管回答、由它 `@` 执事，是成本控制的关键；不要让“一条普通消息触发全员”。同时给群设成员上限（DS Bot 是 12）、给 Bot 间接力设空转守卫，避免两个执事互相客套刷 token。

**6. UI 上必须有的四件事**
- 消息头：头像 + 名字 + 角色/管理员标签 + 颜色 + 时间 + 本轮耗时；
- 打字行：成员头像 + “正在思考/正在用工具”短语；
- 事件行：超时、失败、等待审批、被停止，单独一行，不要静默；
- 成员状态胶囊：输入框上方显示谁在忙、谁等审批，点开能停。

**7. 不建议照抄的部分**
`llm/stream` 合成工具调用是 DSH 特有的无奈之举（群 Session 不能直接调模型），你们有服务端编排，不需要这层；`state.json` 整文件写、1466 行的 `groups.js`、browser plugin 的授权体系，都不适合直接搬。真正值得拿的是**“共享时间线 + 独立成员上下文 + 确定性调度 + 结构化事件”**这四个架构决策。

## LobeHub（agent 团队）

（is_error=False, permission_denials=6）

## 结论先行

LobeHub 的“群聊”不是一个让多个 agent 自由抢话的聊天室，而是**一个由 supervisor（虚拟 supervisor agent）用 LLM + 工具调用做路由的编排器**：用户发言 → supervisor 决定“让谁说 / 广播 / 派异步任务 / 结束” → 被选中的 agent 在群上下文里发言 → 结果回灌给 supervisor → 下一轮。真正的“群”只是 `chat_groups` + `chat_groups_agents` + 真实 `agents` 表，消息靠 `agentId/groupId/targetId` 归属。

---

## 1. 群组数据模型

**群 + 成员表**：`packages/database/src/schemas/chatGroup.ts`

```ts
export const chatGroups = pgTable('chat_groups', {
  id, title, description, avatar, backgroundColor, marketIdentifier, content, // content = 群级 systemPrompt
  editorData: jsonb('editor_data'),
  config: jsonb('config').$type<ChatGroupConfig>(),
  clientId, userId, workspaceId, groupId /* 文件夹, 不是群 */, pinned,
  visibility: text('visibility', { enum: ['private','public'] }).default('public').notNull(),
  ...softDeleteColumns(), ...timestamps,
});

export const chatGroupsAgents = pgTable('chat_groups_agents', {
  chatGroupId, agentId, userId, workspaceId,
  enabled: boolean('enabled').default(true),
  order: integer('order').default(0),
  role: text('role').default('participant'), // 'supervisor' | 'participant'
}, t => ({ pk: primaryKey({ columns: [t.chatGroupId, t.agentId] }) }));
```

关键点：**成员不是“群内角色”而是真实 agent 行**，成员表只存 `order + role + enabled`。supervisor 也是一个真实的 agent 行（`agents.virtual = true`），以 `role='supervisor', order=-1` 挂在成员表里。创建逻辑见 `packages/database/src/repositories/agentGroup/index.ts::createGroupWithSupervisor`（约 239–347 行）：一个事务里建虚拟 supervisor agent、建群、插 supervisor 成员 + 各 participant 成员。批量建群见 `apps/server/src/routers/lambda/agentGroup/lifecycle.ts::createGroupWithMembers`（先建虚拟成员 agent，再 `createGroupWithSupervisor`，返回 `{agentIds, groupId, supervisorAgentId}`）。

**消息归属**：`packages/database/src/schemas/message.ts`

```ts
role, content, editorData, metadata, model, provider, tools,
sessionId, topicId, threadId, parentId, quotaId,
agentId:  text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
groupId:  text('group_id').references(() => chatGroups.id, { onDelete: 'set null' }),
targetId: text('target_id'),   // agent id / "user" / null，无 FK
messageGroupId, workspaceId, ...softDeleteColumns(), ...timestamps,
```

所以一条群消息的说话人由 `role + agentId` 决定，`targetId` 表达“说给谁”（公开说给群 / 私聊某人）。另外还有 `messageGroups` 表（`type: 'parallel' | 'compression'`）承载多模型并行回复、压缩历史。

**角色分工**：只有两档——`supervisor`（路由者/主持人）与 `participant`（执事）。`packages/database/src/models/chatGroup/index.ts::getGroupAgentsWithMeta` 返回 `{agentId, name, role, title}` 且**把 supervisor 从 participants 里剔除**、过滤 disabled；`membership.ts::updateAgentInGroup` 只允许“群自建成员”升格为 supervisor。supervisor 本身是内置 agent：`packages/builtin-agents/src/agents/group-supervisor/`，挂 `GroupManagementIdentifier` + `GroupAgentBuilderIdentifier` 两个插件。

---

## 2. 发言触发机制（重点）

**没有启发式 speaker selection，全靠 supervisor 的 LLM 决策 + 工具调用。** 三层：

### (a) supervisor 提示词（决定“谁下一个说”）

`packages/prompts/src/prompts/groupChat/index.ts::buildSupervisorPrompt`：输入 `group_role / group_members（含 user）/ conversation_history / todo_list`，规则段包含 `RULES`、`WHEN ASKING AGENTS TO SPEAK`、DM 规则、productive-scene 的 todo 规则（“instruction 不超过 10 个词、最多 5 条 todo”）。群内 agent 的人格提示见同文件 `buildGroupChatSystemPrompt`：保持人设、简短、由 supervisor 决定公开发言还是私聊、**不要自报名字**。

`packages/prompts/src/contexts/supervisor/makeDecision.ts::contextSupervisorMakeDecision({ allowDM, scene, systemPrompt, availableAgents, todoList, userName, messages })`，`temperature: 0.3`，工具集按 scene/DM 裁剪；工具 schema 在 `packages/prompts/src/contexts/supervisor/tools.ts`：

```ts
trigger_agent(id: string, instruction: string) // instruction ≤10 words, always English
trigger_agent_dm(target, instruction)
wait_for_user_input()
create_todo(assignee, content) / finish_todo(index)
```

（这条 `GroupChatSupervisor.makeDecision` 路径目前在 `src/store/chat/slices/message/supervisor.ts`，主要被自身测试引用，属旧一代实现。）

### (b) 新编排器的状态机（实际在跑的）

`packages/agent-runtime/src/groupOrchestration/GroupOrchestrationSupervisor.ts` 是一张显式决策表：

- `init → call_supervisor`
- `supervisor_decided`：`speak → call_agent`、`broadcast → parallel_call_agents`、`delegate → delegate`、`execute_task → exec_async_task / exec_client_async_task`、`execute_tasks → batch_exec_async_tasks`、`finish → finish`
- `agent_spoke / agents_broadcasted / task_completed / tasks_completed`：`skipCallSupervisor ? finish : (round++ ; round >= config.maxRounds ? finish : call_supervisor)`
- `delegated → finish`

驱动循环在 `GroupOrchestrationRuntime.ts`：`stepCount++`、`state.maxSteps`、每步检查 `abortController`。

### (c) 编排工具（supervisor 的“动作”）

`packages/builtin-tool-group-management/src/manifest.ts` + `systemRole.ts`：工具集 `speak / broadcast / delegate / executeAgentTask / executeAgentTasks / vote / summarize / createWorkflow / interrupt`（后几个是 stub）。`executor.ts` 的模式是“**注册回调 + 立刻 stop**”：

```ts
ctx.registerAfterCompletion(() => ctx.groupOrchestration!.triggerSpeak(...));
return { stop: true };
```

即工具不阻塞模型，落库后触发下一段编排。`systemRole.ts` 是那段很长的决策框架：何时 speak vs broadcast vs executeAgentTask(s)、意图信号、clarify 最多 2 轮、workflow 模式。

服务端镜像在 `apps/server/src/services/toolExecution/serverRuntimes/groupManagement.ts`：`speak/broadcast/delegate → mode:'in_group'`，`executeAgentTask(s) → mode:'isolated'`，`onComplete: skipCallSupervisor ? 'finish' : 'resume'`，返回 `deferred: true` 把 supervisor 挂起；broadcast 强制 `disableTools: true`。

### (d) 用户 @提及

只有一条：`src/store/chat/slices/agentRun/actions/entries/commandBus/parseCommands.ts`

- `parseMentionedAgentsFromEditorData`：只认 `metadata.type === 'agent'`，去重
- `parseSingleAgentMentionDirectRoute`：**恰好一个 @、且是首节点** → 直接路由

生效条件在 `conversationLifecycle/index.ts`：`directMentionRoute` 仅在 `!context.groupId` 时成立；`hasMentionedAgents = !context.groupId && !directMentionRoute && mentionedAgents.length > 0`。**群聊里 @ 不直接选人**，@ 只是文本上下文，选谁仍归 supervisor。单 @ 直连走 `dispatch/directMentionExecutor.ts`：开 isolated thread 跑一次，把最终答案投影回源 assistant 消息。

---

## 3. 防打转

| 机制 | 位置 |
|---|---|
| 轮数上限 `DEFAULT_MAX_ROUNDS = 10` | `src/store/chat/slices/aiAgent/actions/groupOrchestration.ts` |
| 步数上限 `state.maxSteps` | `GroupOrchestrationRuntime.ts` |
| `maxRounds` 到顶直接 finish | `GroupOrchestrationSupervisor.ts` |
| `wait_for_user_input`（交接回用户） | supervisor tools |
| `skipCallSupervisor`（成员说完不再请 supervisor） | executor / server runtime `onComplete` |
| 用户打断 / 取消：`abortController` + `operation cancelled` 检查 | Runtime + `internal_execGroupOrchestration` |
| 异步任务超时（默认 30min）+ QStash watchdog + 超时即 interrupt | `exec_async_task` (`1_800_000`)、`AgentRuntimeService/groupMember.ts::scheduleGroupMemberTimeout / handleGroupMemberTimeout` |
| 并行成员 K=N 屏障（全部锚点落地才恢复父任务，CAS 续跑） | `groupMember.ts::completeGroupActionMember / completeGroupMemberBarrier` |
| 防复读（bot 通道）：`NO_REPLY[:reason]` / `STAND_DOWN` | `packages/types/src/signal.ts` |

`signal.ts` 那段很值得看（205–293 行）：

```ts
export const BOT_WAKE_KINDS = ['mention', 'followup'] as const;
export const BOT_NO_REPLY_TOKEN = 'NO_REPLY';
export const BOT_STAND_DOWN_TOKEN = 'STAND_DOWN';
export const BOT_STAND_DOWN_MINUTES = 30;
export const BOT_NO_REPLY_REASONS = [
  'not_addressed','off_topic','nothing_to_add','duplicate',
  'already_handled','stand_down','unspecified','empty_completion',
] as const;
```

配合 `BOT_NO_REPLY_PATTERN`（容忍反引号/括号/句号）与 `BOT_NO_REPLY_LABELS`（每种沉默归到 `false_wake / dup_wake / correct` 做信号评估）。另有 `apps/server/src/services/bot/isWholeGroupChatThreadId.ts`：飞书/Lark 群主线程不播“多人在聊”提示，避免刷屏。

---

## 4. 上下文组装（重点）

核心思想：**同一个库里的一份消息，按“当前是谁在看”做不同投影**。管线顺序见 `packages/context-engine/src/engine/messages/MessagesEngine.ts`（约 280–600 行），关键几个 processor：

**(a) 身份与群描述注入** —— `packages/context-engine/src/providers/GroupContextInjector.ts`，模板在 `packages/prompts/src/prompts/agentGroup/groupContext.ts`：

```
You are "{{AGENT_NAME}}", acting as a {{AGENT_ROLE}} in the multi-agent group "{{GROUP_TITLE}}"…
<group_description>…</group_description>
<group_participants><member name="..." id="..." you="true"/></group_participants>
<identity_rules>never expose agent IDs</identity_rules>
```

注意 `MessagesEngine` 里 `AgentIdentityInjector({ enabled: !isGroupContextEnabled })`——**群聊时关掉通用身份注入，改由 GroupContextInjector 统一建立身份**，避免两套身份提示打架。客户端构建 `AgentGroupConfig` 在 `src/services/chat/mecha/contextEngineering.ts`（约 149–190 行），`role = agent.isSupervisor ? 'supervisor' : 'participant'`，`systemPrompt: groupDetail.content`（群级 prompt 与成员自身人格**并存**：成员 systemRole 来自 agent 行，群 prompt 来自群行）。

**(b) 别人说的话怎么表示** —— `packages/context-engine/src/processors/GroupRoleTransform.ts`：

- 其他 agent 的 assistant 消息 → **降级为 `role:'user'`**，前缀 `<speaker name="X" />`，正文后接 `<tool_use>`
- 其他 agent 的 tool 消息 → `role:'user'`，`<speaker name="X" /><tool_result id=... name=...>`
- 当前 agent 自己的消息**原样不动**

降级为 user 是刻意的：不让模型把自己的输出当成“助手语气模板”去模仿其他成员，同时用 `<speaker>` 保住“谁说的”。

**(c) supervisor 编排过程对成员不可见** —— `GroupOrchestrationFilter.ts`：对 participant 过滤掉 `lobe-group-management` 的编排 assistant/tool 消息（默认动作 `broadcast / speak / executeTask / executeTasks`）；当前 agent 是 supervisor 时跳过过滤。

**(d) 嵌套消息拍平 / 压缩历史** —— `GroupMessageFlatten.ts`（assistantGroup/supervisor 子树拍平成 assistant + tool）、`CompressedGroupRoleTransform.ts`（`compressedGroup → role:'user'`，包 `<compressed_history_summary>`，并写 metadata 计数）。

**(e) 记忆**：群内**共享同一份消息流**（按 `groupId/topicId` 查），没有“各自私有记忆库”；隔离靠的是“投影”——isolated 线程（`threadId`）的私有上下文 + 主群只回灌摘要/最终答案。DM 由 `packages/prompts/src/prompts/chatMessages/index.ts::filterMessagesForAgent` 处理，非参与者看到 `***`。

---

## 5. agent 团队 / 调度（hire / schedule / 7×24）

必须说清：**“7×24 团队”在当前代码里不是群聊的一个模式，而是另一条线。**

- **hire（招人）**：`packages/builtin-tool-group-agent-builder/src/manifest.ts`——`searchAgent / createAgent（并加入群）/ createGroup（自动带 supervisor）/ getAgentInfo`，支持 `targetGroupId`。也就是 supervisor 可以在对话里“新建一个成员并拉进群”。
- **派活与汇报**：异步任务 = **开独立线程 + 轮询状态**。客户端 `createGroupOrchestrationExecutors.ts::exec_async_task`（`execSubAgentTask` + 3s 轮询，超时 1.8e6 ms）、`exec_client_async_task`（`createClientGroupAgentTaskThread` + 在隔离线程 `executeClientAgent`）；批量 `batch_exec_async_tasks` 并行起、统一轮询、聚合结果文本。服务端 `groupMember.ts` 负责“成员完成 → 回填锚点 → K=N 屏障 → 恢复/结束父任务（CAS）”。这**就是**“派活—状态—汇报”的骨架。
- **schedule / 7×24**：`packages/database/src/schemas/agentCronJob.ts` 顶部明确 `@deprecated`，被 `tasks.automation_mode='schedule'` 取代；`packages/business-server/src/lambda-routers/workspaceTeam.ts` 是空壳（注释：开源侧无 UI 消费 workspace team）。因此**定时/团队运营能力主要在闭源云侧**，开源仓库里只留下了任务调度与群编排两块地基。
- `packages/agent-manager-runtime/src/AgentManagerRuntime/index.ts` 是 agent 的 CRUD/search runtime，**不是**调度器。

另外 `docs/usage/agent/agent-team.mdx` 描述的“顺序/并行/迭代/辩论”四模式，与当前实现已经对不齐（更像旧版产品文档），**别当规范读**，以代码为准。

---

## 6. 群组 UI

- **群在会话列表里**：`src/features/MessageList/GroupConversation.tsx`，`GROUP_CHAT_URL(id)`，头像用成员拼图 `AgentGroupAvatar`。
- **supervisor 发言有身份标记**：`src/features/Conversation/Messages/AssistantGroup/index.tsx`——
  ```ts
  const isSupervisor = metadata?.orchestrationRole === 'supervisor' || !!metadata?.isSupervisor;
  ```
  supervisor 渲染群头像 + 群标题 + `<Tag>{t('supervisor.label')}</Tag>`。
- **谁在说话（防误归属）**：`src/features/Conversation/Messages/User/resolveSenderIdentity.ts`，从 `metadata.agentSender`（agent 发的用户视角消息）/ `botSender`（或遗留 `<speaker>` 标签）解析说话人。
- **成员管理**：`src/routes/(main)/group/_layout/Sidebar/GroupConfig/GroupMember.tsx`——用户本人一行 + 成员列表（`AgentProfilePopup`、双击跳 `/group/{id}/profile?tab=agentId`、移除成员、`AddGroupMemberModal`），带权限判断。建群走 `CreateGroupModal` / `ChatGroupWizard`。
- **“正在干活”指示**：`packages/builtin-tool-group-management/src/client/`
  - `Streaming/Speak/index.tsx`：supervisor 让谁说话时，`instruction` 直接 `<Markdown animated>` 流式显示（“点了名、正在交代”）。
  - `MemberProgress/index.tsx`：`useMemberAnchors` 从工具调用下挂的子消息聚合成 `anchor`；`useMemberProgress` 用 `resolveMemberStatus` + `useEnablePollingTaskStatus(threadId, anchor.id, isProcessingStatus(status))` **只对运行中的成员轮询其隔离线程**（注释明确：已完成成员不轮询，否则状态接口会把时长按“请求时刻”盖章，显示错误的运行时长）；`MemberTaskTitle` = `TaskStatusIndicator` + `MetricsDisplay`（duration / llmCalls / toolCalls / startTime）；`MemberTaskDetail` 运行中显示 live thread，结束后显示 anchor 的最终内容（失败则是失败原因）。
  - 走查细节：`MemberProgress/memberAnchor.ts` 的 `selectMemberAnchors / resolveMemberStatus / resolveMemberThreadId`。

---

## 7. 最值得抄的 5 个实现点

1. **supervisor 作为“真 agent + 显式决策表”** — `packages/agent-runtime/src/groupOrchestration/GroupOrchestrationSupervisor.ts`
   把“下一个谁说话”变成一张 `state × event → action` 的表，而不是散落在 if/else 里的启发式。可测、可回放、可加新模式（broadcast / 异步 / delegate）而不改主循环。**这是整个设计最值得抄的一处。**

2. **`<speaker>` + “他人消息降级为 user”** — `packages/context-engine/src/processors/GroupRoleTransform.ts`
   一条消息两用：既保住“谁说的”，又不污染 assistant 语气。多 agent 共用一个 prompt 时最省事、最稳的归属方案。

3. **“写库即触发”的工具执行模型** — `packages/builtin-tool-group-management/src/executor.ts`（`registerAfterCompletion(...) + return { stop: true }`）+ 服务端 `deferred: true` 挂起 supervisor
   工具=意图，编排=状态机。客户端能跑、服务端也能持久化续跑（QStash），同一套语义两处实现。**把“模型决策”和“系统推进”彻底解耦。**

4. **isolated thread + 锚点回填 + K=N 屏障** — `src/store/chat/agents/GroupOrchestration/createGroupOrchestrationExecutors.ts` + `apps/server/src/services/agentRuntime/AgentRuntimeService/groupMember.ts`
   成员干活时上下文独立（不污染群），完成后把“锚点”写回父工具调用，并行成员全齐才恢复父任务（CAS 防重入）。UI 与上下文都从这个锚点取数据，天然一致。

5. **沉默协议 `NO_REPLY` / `STAND_DOWN` + 原因分类** — `packages/types/src/signal.ts`
   多 agent 群里最大的噪声是“没话找话”。给 agent 一个**显式的、可解析的、带原因的闭嘴出口**，再把每种原因映射成信号标签（false_wake / dup_wake / correct），既治复读，又能反过来评估调度质量。

（备选第 6：`MemberProgress` 的“**只对运行中成员轮询、完成即停**”——`useEnablePollingTaskStatus(threadId, anchor.id, isProcessingStatus(status))`，一个 `isProcessing` 开关同时解决“实时感”和“错误时长”，很细但很值。）

---

## 对本项目的启示

结合 lifediary-harness 现状（总管/执事/工人 + 单对话 SSE），给几条**按优先级**的落地建议：

1. **先定“谁是路由者”，再谈群聊。** LobeHub 的群聊本质是 supervisor 路由，不是多 agent 自由讨论。你已经有“总管”，最自然的映射就是：**总管 = 群内 supervisor**，执事 = participant。不要让多个执事互相抢话——那是复读和跑题的源头。

2. **路由决策做成显式状态机，别写进 prompt 里靠模型自觉。** 抄 `GroupOrchestrationSupervisor` 的 `state × event → action`：`user_spoke / agent_spoke / task_done / timeout / cancelled` 五种事件足够。上限设 `maxRounds`（LobeHub 用 10）+ `maxSteps`，再加一个 `wait_for_user_input` 作为“把话筒还给用户”的显式出口。

3. **上下文用“投影”而非“拼接”。** 你现在的单对话 SSE 应该是“全量 history 直塞”。群聊后建议：一条消息按 `senderId / targetId` 存，给每个执事组装 prompt 时——自己的话保留 assistant，别人的话降级为 user 并加 `<speaker name="..."/>`，总管的内部编排（选谁、为何选）对执事**过滤掉**。这三条 LobeHub 都有现成实现（`GroupRoleTransform` / `GroupOrchestrationFilter`），可以直接照抄思路。

4. **异步/长任务走“隔离线程 + 锚点回填”，不要塞进群上下文。** 执事跑一个长任务时，让它在一个独立会话里跑，完成后只把“结论 + 状态 + 耗时”作为一条消息回灌群。LobeHub 的 `anchor + K=N 屏障 + 只轮询运行中成员` 是成熟做法；对你更是刚需——SSE 单流里塞长任务的中间过程会直接把体验拖垮。

5. **一定要抄“沉默协议”。** 你的场景是“多个 AI 执事 + 用户一起聊”，噪声问题会比 LobeHub 更严重。给每个被唤醒的执事一个 `NO_REPLY[:reason]` 出口（reason 至少要有 `duplicate / off_topic / nothing_to_add / already_handled`），并记录“谁被唤醒但没说”——这比调 prompt 有效得多。

6. **@提及的语义要提前定死。** LobeHub 的选择是：**非群聊里单 @ = 直连，群聊里 @ 不改变路由**。你若想让“用户 @ 某执事 = 强制它回答”，需要显式加一条“mention 优先级高于 supervisor 决策”的规则，否则会出现“用户点了名、总管却派了别人”的割裂感。

7. **别把“7×24 / 定时 / 雇佣”和群聊混在一起设计。** LobeHub 在这块是断开的（cron 已废弃、workspace team 是闭源空壳），说明“群聊编排”和“任务调度”是两个正交子系统。你的“总管/执事/工人”本身已经是调度层了，群聊只该负责**一次会话内的多 agent 协作**，长任务交给调度层去开线程。

8. **数据模型尽量少加表。** LobeHub 只有两张表（群 + 成员关系），成员是真实 agent 行，supervisor 也只是 `virtual` agent。**不要**为“群内角色”“群内人格”另建表——群级 prompt 放在 `chat_groups.content`，成员人格复用 agent 自身 `systemRole`，二者在组装时合并即可。这样“一个执事属于多个群”“同一个执事在不同群不同分工”都不会炸。

一句话总结：**抄 LobeHub 的“supervisor 决策表 + 上下文投影 + 隔离线程锚点 + 沉默协议”这四件套，比抄它的群聊 UI 重要一个数量级。**

## OpenMausBot（一队 AI bot 当联系人）

（is_error=False, permission_denials=3）

## 结论先行

OpenMausBot 有第一等的群组形态，不是“bot 只是一对一联系人”。它有两层：

- **直聊（direct chat）**：默认 1 bot + 1 人，一个 thread。
- **房间/频道（room/channel，内部仍叫 group）**：`WireGroup.memberIds` 多 bot + 人，共用一段房间记录，每个 bot 仍保留自己的 provider session、人格、记忆和上下文计量。见 `shared/wire.ts:844-902`、`server/store.ts:841-879`。

群聊不是把多个 bot 塞进一个 prompt，而是：**共享一份带说话人标签的记录 + 每个成员各自跑一轮 + 一个显式的“谁发言”决策层**。

---

## 1. 数据模型

**Bot 定义**（`shared/wire.ts:276-405`）：

```ts
interface WireBot {
  id; name; title?; description?;
  soul: string;                 // 人格正文
  modelSelection;               // 模型 + reasoning effort
  computer?;                    // 云端电脑
  approvalMode; alwaysAllow;
  memoryEnabled; peers;         // 可对话的 bot 白名单
  chiefOfStaff?; connectorTools?;
  toolScope?: { allow?: string[]; deny?: string[] };
}
```

人格的安全边界在 `server/bot-folder.ts:1-2`：`SOUL.md` 只是 `BotRecord.soul` 的镜像，且放在 bot 可写 workspace 之外——bot 读到不可信内容也无法把注入文本写进自己的人格；漂移只展示、不自动应用。

**消息存储**（`server/message-db.ts:44-67`）：SQLite（WAL，文件 0600），核心表：

```sql
messages(thread_id, id, at, role, kind, text, json, PRIMARY KEY(thread_id,id))
thread_state(thread_id, active_leaf_id)
```

`thread_id + parentId` 支持分支和 active leaf；`kind` 区分 text/digest/roomRequest/card 等。

**多 bot 成员**（`shared/wire.ts:844-921`）：

```ts
interface WireGroup {
  id; threadId; tasks: GroupTask[];
  name; memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;             // 全房间共享指令
  dm?: boolean;
  busyBotId; working; queue: RoomQueueEntry[];
  holds: RoomHold[]; heldMessages: RoomHeldMessage[];
  turnTimeoutMinutes?;
}
```

创建见 `server/store.ts:841-879`：`dm` 房间固定 `{ kind: "mentions" }` 且没有 tasks；普通房间自动生成首个 `GroupTask`。

**消息归属**（`shared/wire.ts:453-579`）：

```ts
interface WireMessage {
  role: "bot" | "user";
  kind: ...; text: string;
  sender?: ResolvedSender;
  from?: { botId: string; name: string; color: string };
  routedBy?: { provider: "jev" | "workersai" | "openrouter"; probability: number };
}
```

`from` 是群聊归属的关键：同一 `role: "bot"` 下靠 `from.botId/name/color` 区分是谁说的；`routedBy` 记录这条消息由哪个路由器选中。

---

## 2. 发言触发

没有轮流。优先级是**显式 @ > @everyone > 默认响应者**，默认响应者可以是固定成员、所有人、仅提及、或自动选人。

`shared/wire.ts:811-815`：

```ts
export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" }
  | { kind: "auto"; fallbackBotId?: string };
```

解析逻辑 `server/store.ts:241-272`（`roomResponders`）：

1. 文本含 `@everyone` → 全体成员；
2. `resolveMentions` 命中 → 被提及者（重名且未从 @ 列表点选则拒绝，不猜）；
3. 否则按 `defaultResponder`：`everyone` / `member(botId)` / 仅 `mentions` 时无人 / `auto` 走决策模型；
4. 直聊默认 `mentions`，无提及时回落到最后发言者（`server/index.ts:10894-10900`）。

`@` 解析在 `shared/room-mentions.ts:18-39`：按名字长度倒序匹配、要求词边界、同名多 bot 时返回 `ambiguous`，由前端拒绝发送或要求从 @ 列表点选（`MENTION_PICKS_MAX = 20`），点选只用于消歧，不会凭空添加未被 @ 的 bot。

**自动选人**（仅用户消息、非 dm、`kind: "auto"`）：`server/decider/room-routing.ts:4-12, 83-104`。

```ts
timeout 1500ms; minProbability 0.6;
__everyone__ 选项;
状态: room / humans_in_room / bots_in_room / recent_messages / new_message
```

低于置信度、未知 id、超时、异常 → 全部回落到 `fallbackBotId`。即“自动”永远有确定性兜底，不会出现无人应答。

**bot 之间连续对话**：只有 bot 回复里显式 @ 了另一个成员才会链式触发（`server/index.ts:10554-10612`），且最多一跳（见下节）。没有 round-robin，也没有“所有成员依次发言”的默认行为——`everyone` 只表示这一轮所有成员都收到同一条请求，执行仍是串行的。

---

## 3. 防打转 / 防刷屏 / 打断

四层硬约束：

**① 链式提及最多一跳**（`server/index.ts:9611`）：

```ts
const MAX_GROUP_HOPS = 1;
```

只有根消息（`parentId === undefined`）的 bot 回复可以再 @ 下一个 bot；第二跳的回复不再触发第三人。链式调用时 brief 变成：

```ts
`Mentioned by ${mention.from.name} (hop ${hop}): ${mention.text}`
```

（`server/index.ts:9656-9662`）

**② 单次操作内去重**（`server/index.ts:10989, 11002`）：`const spoken = new Set<string>()`，同一轮里已经说过话的 bot 不会再被选中。

**③ 每 thread 串行 + 可见队列**（`server/index.ts:10958-10959`）：

```ts
const prev = groupQueues.get(threadId) ?? Promise.resolve();
const next = prev.then(async () => { ... });
```

队列模型 `server/room-queue.ts:10-51`：running 在前，queued 在后，每条带 `position / of / waitingForBotId`；UI 显示 “Queued · waiting for X (2 of 3)”。另有一把 per-member 锁 `server/room-member-lock.ts:5-57`（botId → threadId），防止同一 bot 被两个入口同时唤醒后都以为自己空闲。

**④ 超时与停顿看门狗分离**（`server/room-turn-timeout.ts:56-165`）：  
- 房间回合超时默认 5 分钟，可全局/单任务覆盖 1–1440 分钟；
- 另有基于活动的 stall watchdog：等待用户审批时暂停计时，工具静默过久才判停；
- 超时与“卡住”是两种不同结局，分别落 `timed_out` 等状态。

**用户打断**：  
- 发送 “stop @Bot” 等指令（多语言）把某成员置为 hold（`server/room-holds.ts:100-146`），被 hold 的成员不再获得回合，直到再次 @ 或恢复；被 hold 期间的消息会保留并在恢复时回放（`MAX_HELD_MESSAGES = 20`）。  
- `server/index.ts:4324-4335` 在收消息时应用 hold；`4337-4347` 设置 hold；`4349-4367` 计算回放。  
- 队列中若发言人仍在停止过程中，会记一条活动并返回，不强行开新回合（`10961-10970`）。

**目标模式另有一套硬上限**（`server/group-goal-run.ts:5-9, 212-337`）：13 回合、等待耗尽 3 次、同一 assignment 重复 3 次即 blocked、总等待 30 分钟；协调者通过私有控制信封给出下一步，避免“为了讨论而讨论”。

---

## 4. 上下文组装

**共享的是记录，不是 session。** 每个成员有自己的原生 provider session、记忆层和上下文计量；房间只提供一份“最近发生了什么”的窗口。

**房间窗口**（`server/host/room-transcript.ts:11, 25-77`）：

```ts
GROUP_CONTEXT_MESSAGES = 30;  // 最近 30 条可读消息
```

- 只取 `text / digest / roomRequest result`，排除中间叙述（narration）；
- 每条渲染为 `说话人: 正文`：人是 person name，bot 是 `from.name`；
- webhook 正文做 JSON 转义；带 peer 来源注记和 reaction 摘要；
- 这样 bot A 看到的是“B: …”“C: …”，而不是把自己的话当成 assistant 历史。

**增量会话**（`server/host/room-sessions.ts:99, 225-258`）：支持原生 session 的引擎（当前 `claudeAgent`）只注入自上次发言以来的新行：

```ts
"[Messages this conversation received since your last turn in this room,
  oldest first. Your session already holds the conversation before them.]"
```

`unseenLines` 会校验 instance、adapter、config、idle 时间、是否临近压缩；任何不确定都退回完整窗口。同一 session 被另一个成员复用时，其他成员的记录会失效（`151-157`），避免串台。

**上下文计量/压缩**（`server/room-context.ts`）：`RoomContextTracker` 按 thread→bot 记录 tokens/window，默认 0.9 触发压缩；同引擎实例下其他成员的读数会被丢弃。

**系统提示拼装**（`server/index.ts:10151-10167, 10188-10189, 10202-10248`）：

- 房间层：`You are ${bot.name}, a bot in the room ...`、角色/简介、成员与人类名册、`Room bulletin`、回复规范（“以自己的身份回复”“@ 协议”“reaction”）、peer 名册、凭据/线程提示、`coordinate_bots` 说明；
- 尾部：`(Reply to the conversation above as ${bot.name}.)` + learn/held/card/coordination/实时名册；
- 最终 `text = roomContext + roomTail`；
- 每个 bot 自己的 memory 通过 `roomMemory`（`10202`）注入；
- `buildSystemPrompt`（`server/system-prompt.ts:61-83`）顺序是 persona → soul → tool bridge → reply style → 各 parts → reply habits，并拆 stable/volatile 两半以利缓存。

**隔离要点**：私聊内容不会自动进入房间上下文（`server/index.ts:10357-10358`）；每个 bot 的人格、记忆、模型、工具权限各自独立；共享的只有房间 bulletin 和最近记录窗口。

---

## 5. 执行态呈现

**数据层**（`shared/wire.ts:844-927`）：`busyBotId`、`working`、每任务 `working/busyBotId`、`queue[]`、`holds[]`、`heldMessages[]`、`activity: "waiting-on-you"`。这让前端不需要猜“谁在干活”。

**前端派生**（`src/lib/room-threads.ts:16-57`）：

```ts
roomThreadWorking / roomThreadSpeakerId / roomSpeakerIds
roomQueueLabel     // "Queued · waiting for X (2 of 3)"
roomWorkingPreview // "First is working… · 2 queued"
```

`src/lib/turn-tail.ts:7-29` 提供 working dots 和 `awaitedMemberId`。

**群聊视图**（`src/components/GroupView.tsx`）：

- `speaker = members.find(b => b.id === group.busyBotId)`（`911`），说话人头像/颜色跟随发言者；
- 每个成员的审批/提问/密钥/登录/连接器卡片按 `from.botId` 找到成员并渲染（`408-440`），群聊里能明确“这是 Bolt 在问你”；
- 等待态 `awaited/waiting`（`922-926`），底部显示谁在等谁；
- 活动行也是消息，带 `from` 和工具名（`server/index.ts:10309`），进度以房间内可见的行流式出现，而不是独立的“任务面板”。

**审批不冻结房间**：开放卡片会把该 thread 标成 `activity: "waiting-on-you"`（`server/host/person-waits.ts:37-49`），但房间其他 thread/成员仍可用；回答后卡片关闭、活动状态清除。

**Stop 的作用域**是单个对话/成员，不是全局 kill；被 hold 的成员不再排队，恢复后补上错过的消息。

---

## 6. 最值得抄的 5 个点

1. **纯函数化的响应者决策 + 歧义拒绝**  
   `shared/room-mentions.ts:18-39`、`server/store.ts:241-272`、`src/lib/group-routing.ts:58-92`  
   前后端共用同一套 @ 解析与优先级，重名不猜、自动选人有确定性兜底。这是群聊最容易被写乱的地方，它被做成了可测试的纯逻辑。

2. **bot→bot 仅显式 @ + 一跳上限 + spoken 去重**  
   `server/index.ts:9611, 10554-10612, 10989`  
   不做轮询、不做“让它们自由讨论”，从机制上消灭无限互聊；需要多步协作时改用有预算的目标模式，而不是放开聊天。

3. **每 thread 串行队列 + per-member 锁 + 可见排队信息**  
   `server/index.ts:10958-10959`、`server/room-queue.ts:10-51`、`server/room-member-lock.ts:5-57`  
   群聊的并发 bug 大多来自“两个回合同时写同一段记录”。串行化 + 显式队列 + 锁，既保证一致性，也直接产出可展示的“谁在跑、谁在等”。

4. **共享记录窗口 + 每成员独立 session/记忆/上下文计量**  
   `server/host/room-transcript.ts:25-77`、`server/host/room-sessions.ts:99-117, 225-258`、`server/room-context.ts`  
   不要把多个 bot 塞进一个对话历史；让每个成员以自己的 session 增量读取“别人说了什么”，并各自压缩。这是人格隔离和成本控制的关键。

5. **有界目标运行协议（可选的“协作模式”）**  
   `server/group-goal-run.ts:5-9, 56-141, 212-337`  
   协调者/工人回合、13 回合硬顶、重复 assignment 检测、等待耗尽、控制信封与终止状态。想从“群聊”升级到“多 agent 完成一件事”时，这是比自由互聊可靠得多的形态。

---

## 对本项目的启示

lifediary-harness 已有总管/执事/工人层级和单对话 SSE，建议按以下方式落地群组：

**数据模型**
- 新增 `conversations`（已有）与 `conversation_members(conversation_id, agent_id, role, joined_at)`；不要用“多个 assistant 消息”表达多成员。
- `messages` 增加 `sender_type`（user/agent/system）与 `sender_agent_id`；所有群聊消息必须带发送者，SSE 帧里原样带出。
- 会话级 `default_responder` 枚举可直接借鉴：`steward | everyone | mentions | auto(fallback)`。总管天然是 `steward` 默认响应者。

**发言触发**
- 第一版只做：显式 @执事 > @all > 默认总管；重名执事要求前端从 @ 列表点选，后端拒绝歧义，不猜。
- 自动选人（小模型路由）作为第二版，必须带 1–2 秒超时、置信度阈值和确定性 fallback；不要把“自动”做成唯一路径。
- 执事之间只允许显式 @ 触发，且最多一跳；工人由执事通过现有委派机制调用，不进入群聊发言池。

**防打转**
- 每个会话一条串行回合队列（总管/执事回合不并行写历史），队列状态通过 SSE 推给前端。
- 单次用户消息内 `spoken` 去重；执事→执事最多一跳；用户 `stop @执事` 即 hold，恢复后回放错过的消息。
- 回合超时与“无活动卡住”分开计时；等待用户审批时暂停计时。
- 如果以后要“多执事协作完成一件事”，另建有回合上限和终止状态的 goal run，不要放开自由互聊。

**上下文**
- 群聊 prompt = 最近 N 条 `说话人: 正文`（建议 30 条，排除内部旁白）+ 该执事自己的人格/记忆/技能 + 会话共享公告；其他执事的消息以“对话记录”进入，不要伪装成该执事的 assistant 历史。
- 每个执事保留独立 session/上下文计量；共享的只有记录窗口和公告。私聊内容不自动进群聊。

**SSE 与 UI**
- 一条会话一个 SSE 流，帧类型扩展为 `message`（带 sender）、`member.state`（working/queued/held）、`queue`、`approval`（带 agent_id），不要为每个执事开一条流。
- UI 必须有：发言者头像/颜色、当前回合者、“X 正在工作 · 2 人排队”、按成员归属的审批卡片、`@执事 stop` 入口。
- 审批卡片挂起时只标记该线程 waiting-on-you，不要冻结整个群聊。

**不建议照抄**
- OpenMausBot 的 `coordinate_bots` durable runtime（深度 4、请求/执行配额、跨线程工作树）很重，lifediary 第一阶段不需要；先把“共享记录 + 串行回合 + 显式路由”做扎实。
- 它的原生 session 增量注入依赖具体引擎能力，若 lifediary 的执事没有可复用 session，直接用“窗口重放 + 每成员 system prompt”即可，复杂度低得多。

**一句话**：把群组建成“一个会话 + 成员表 + 明确的响应者策略 + 串行回合队列”，而不是“多个 agent 共用一个 prompt 自由聊天”；防打转靠机制（@ + 一跳 + 去重 + 队列），不靠提示词。
