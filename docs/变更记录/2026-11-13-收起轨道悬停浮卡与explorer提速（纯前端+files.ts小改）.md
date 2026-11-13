# 2026-11-13 收起轨道悬停浮卡 + explorer 打开提速 + 悬停说明与项目弹层减字

用户四件事，一次落地。纯前端为主，服务端只动 `files.ts` 的打开方式。

## 改了什么

### ① explorer 打开提速（ts/apps/server/src/files.ts）
- **根因**：Windows 焦点式打开（2026-11-11 拍板「直接弹到顶层」）把整条链串行跑完窗口才出现：
  PowerShell 启动 → COM 开窗 → 轮询句柄 → Add-Type 编译 → SwitchToThisWindow，点完要等 1~2s。
- **改法**：拆成两步并行——先裸 `spawn("explorer")`（~200ms 出窗），再并行起 PowerShell
  只做「按 LocationURL 认领窗口 + 切前台」。窗口出现到切前台之间有零点几秒可能垫底，终态仍在顶层。
- 轮询 30×100ms → 50×100ms（explorer 先开窗、脚本后起，认领窗口期放宽到 5s）。
- 切前台加了复核重试环（切 1 次 → 120ms 后查 GetForegroundWindow，没拿住再切，最多 6 次）：
  窗口刚创建还在开屏动画时 SwitchToThisWindow 会被顶回来（2026-11-13 实测踩到，加环后两连 FOREGROUND_OK）。
- 回滚开关不变：`EXPLORER_FOCUS=false` 退回裸 spawn（窗口可能垫底）；`EXPLORER_OPEN=false` 关端点。

### ② 收起轨道悬停浮卡（index.html / app.js / style.css）
- 项目 / 群组 / 执事三个轨道钮统一「悬停 ~350ms 浮出总览卡、指针离开按钮+卡 220ms 后收、
  点击是同一个开关」（项目卡数据现拉、群组/执事卡用缓存现渲）。
- 项目卡复用既有 #proj-menu；群组/执事是两张新卡（#rail-groups-menu / #rail-partners-menu，
  同 .proj-pop 壳），行渲染复用展开态同一份函数（renderGroupRows / renderRoster 加了容器参数）。
- 群组卡底部带「所有群聊 →」；执事卡就是花名册（头像/领域/派发权/在办单全带，可交互）。
- 定位从 placeProjectMenu 泛化成 placeRailMenu(menu, trigger)。
- 边界处理：点收卡片后指针仍停在按钮上时压住悬停重弹（suppress，指针真离开才解除）——
  否则紧跟点击派发的边界 enter 会把刚收掉的卡立刻弹回去（验收时实测踩到）。
  离开按钮再进，悬停照常弹出。
- **注意**：2026-11-08 当天退役的「侧栏悬停 peek」是整块侧栏扫过就压内容（用户拍板难受）；
  这次是单张小卡 + 离开即收，不是那个形态的回归。轨道钮点击行为变化：
  群组不再直接进群组页（入口在卡的「所有群聊 →」），执事不再展开侧栏（花名册就在卡里）。

### ③ 悬停说明文字退役（「两个浮起的解释性文字」）
- 轨道按钮原来同时挂原生 `title` + 自定义 `data-tip`，悬停出两层。全部摘掉（aria-label 保留给读屏）：
  总管/任务中心/项目/执事/群组/课题/设置七个钮，HTML 属性与 JS 写入点（setStatus、
  syncRailProject、applyGroupsAvailability）一并清掉。服务状态看顶栏状态灯。
- 全局 data-tip 悬停提示机制保留（展开态分区头 / 设置页 ⓘ 等还在用）。

### ④ 项目弹层与项目分区减字
- 弹层底部「工作区根和项目是平级目录…」说明行（.proj-legend）与「管理项目 → 设置」按钮退役；
  展开态项目分区底部的「管理项目 → 设置」链接行同步删除。说明收进展开态分区头的 data-tip。
- 弹层底部只剩「添加项目 / 设置工作区根目录」两个动作。

### ⑤ 侧栏底行状态带字（追加小件）
- 展开侧栏底行的服务状态原来是「齿轮 + 一颗裸点」（文字藏在 status-text 只给读屏），
  用户口径「不放字就不知道点是什么意思」：文字常驻亮出，**字在点左边**（DOM 换序），
  连接态文案「服务在线」→「已连接」（mock 仍带 · mock 后缀；离线/需要令牌/连接中不变）。
- 整行压低 4px（side-foot padding-bottom 10→6；底边 sticky 钉死，分隔线与整行一起下移），
  行在上方分隔线与底边之间保持大致居中（实测上线 19px / 底边 16px）。

## 明确不做
- 任务中心、课题、总管、设置轨道钮不出悬停卡（用户点名任务中心不用；其余没有可总览的内容）。
- 悬停卡不做键盘悬停等效（Tab 聚焦 + Enter 走点击路径，行为一致）。

## 验证
- `pnpm typecheck` 绿；`pnpm --filter @lifediary/server test` 793 全绿（files 单测不真弹窗，opener 注入）。
- explorer 独立验证（不动在跑的服务）：从 files.ts 原样取脚本 → 裸 spawn explorer（~10ms 返回）
  → 并行焦点脚本 → 断言窗口 HWND == GetForegroundWindow()，两连 FOREGROUND_OK（含目录已开着的情况）。
- 浏览器验收（内嵌浏览器，生产源码刷新即得）：悬停项目/群组/执事三张卡均自动浮出（真实指针 +
  合成事件双路）、指针挪进卡不收、卡间切换、离开按钮/卡即收、点击同开关、Esc 收、
  展开侧栏后轨道 inert 不出卡、轨道钮 title/data-tip 全空、项目卡无说明行无管理按钮、
  展开态项目分区无「管理项目 → 设置」。
