/**
 * lifediary 的界面。刻意不引任何依赖：
 *
 * - 服务端就是同源，所以路径全是相对的，换端口/换主机都不用改；
 * - 没有构建步骤，改完刷新就见效——这一层不值得为它上一条打包链；
 * - 所有网络请求只从这里出去（见 request），别的地方不许自己 fetch。
 *
 * 2026-11-13：这里原本是 25,467 行的单文件，现按职责拆成 78 个兄弟模块（同目录）。
 * 本文件只剩入口职责：side-effect import 全部兄弟模块 + 文末的启动代码。
 * 分层与取舍见 docs/设计方案/2026-11-13-web-app.js 按职责拆分.md。
 */

// 按职责拆出的兄弟模块。side-effect import：每个模块顶层的监听器 / 首帧逻辑都在这里注册。
import "./dom.js";
import "./theme.js";
import "./shell.js";
import "./route.js";
import "./nav-history.js";
import "./context-menu.js";
import "./state.js";
import "./tasks-model.js";
import "./tasks-cards.js";
import "./tasks-board.js";
import "./tasks-redesign.js";
import "./tasks-review.js";
import "./tasks-kanban.js";
import "./tasks-detail.js";
import "./tasks-live.js";
import "./domains.js";
import "./net.js";
import "./chats-list.js";
import "./partners-status.js";
import "./avatar.js";
import "./partner-roster.js";
import { syncEmptyMark } from "./partners-status.js";
import "./tool-flow.js";
import { setChipPagingEnabled } from "./tool-chips.js";
import { mountCtxCard } from "./chat-notice.js";
import "./markdown.js";
import { initHtmlCards } from "./html-cards.js";
import { setHtmlCardsEnabled } from "./markdown.js";
import "./chat-open.js";
import "./composer-send.js";
import "./approval-card.js";
import "./ui-atoms.js";
import "./hover-tip.js";
import "./icons.js";
import "./settings-drawer.js";
import "./settings-employee.js";
import "./settings-contract.js";
import "./settings-model.js";
import "./settings-permission.js";
import "./project-switch.js";
import "./project-browser.js";
import "./project-modal.js";
import "./rail-card.js";
import "./attachments.js";
import "./plus-menu.js";
import "./export-data.js";
import "./settings-base.js";
import "./search-page.js";
import "./settings-atoms.js";
import "./settings-router.js";
import "./skills-settings.js";
import "./skills-list.js";
import "./skills-modals.js";
import "./settings-switches.js";
import "./skills-actions.js";
import "./skill-picker.js";
import "./settings-memory.js";
import "./memory-page.js";
import "./memory-items.js";
import "./settings-projects.js";
import "./archive-page.js";
import "./archive-delete.js";
import "./approval-pop.js";
import "./settings-connection.js";
import "./settings-reminders.js";
import "./settings-usage.js";
import "./providers.js";
import "./provider-form.js";
import "./search-sources.js";
import "./provider-save.js";
import "./shell-window.js";
import "./partner-modals.js";
import "./partner-editor.js";
import "./partner-routines.js";
import "./groups-base.js";
import "./groups-list.js";
import "./groups-thread.js";
import "./groups-composer.js";
import "./groups-create.js";
import "./groups-settings.js";
import "./groups-settings-panels.js";
// 会话画板（2026-11-17 画板批）：路由 #/map/<id>、顶栏入口、画布交互都在这一个模块里
import "./chat-map.js";

// 启动代码用到、来自各模块的绑定
import { refreshApprovalPopups, startApprovalPopWatch } from "./approval-pop.js";
import { openChat } from "./chat-open.js";
import { loadChats } from "./chats-list.js";
import { el } from "./dom.js";
import { initGroups } from "./groups-base.js";
import { adoptAllTitleTips, refreshModelPill, watchTitleAttribute } from "./hover-tip.js";
import { installNavHistory } from "./nav-history.js";
import { checkHealth } from "./net.js";
import { chiefDisplayName, loadRoster, syncChiefDot } from "./partners-status.js";
import { loadCapabilities } from "./plus-menu.js";
import { refreshProjectPill } from "./project-modal.js";
import { applyRoute, currentRoute, go } from "./route.js";
import { initSelectMenus } from "./select-menu.js";
import { wireSearchPage } from "./search-page.js";
import { INJECT_TABS, SETTINGS_ALIASES, SETTINGS_SECTIONS } from "./settings-base.js";
import { applySections, applySidebarA11y, syncGreeting, updateHomeMode } from "./shell.js";
import { state } from "./state.js";
import { loadTickets } from "./tasks-kanban.js";
import { autoSyncTick } from "./tasks-live.js";
import { ensureFlag } from "./tasks-redesign.js";
import { applyFontSettings, applyTheme, currentThemeChoice, loadFontSettings } from "./theme.js";


/* ── 启动 ─────────────────────────────────────────────── */

void (async () => {
  // 悬停提示统一（2026-11-14）：静态 title 收编成 data-tip，之后动态改 title 也接住。
  // 放在最前：首屏渲染前就把默认小框清掉，用户不会先看到一帧原生的。
  adoptAllTitleTips();
  watchTitleAttribute();
  // 上下文环的容量卡（2026-11-14）：挂上悬停/聚焦/点击，环本身不再走 data-tip
  mountCtxCard();
  // 返回上一页 / 前进（2026-11-14）：栈要在首帧路由之前就在，深链（?view=settings）
  // 进来也算「从对话跨过去的一步」，返回能原路退回。
  installNavHistory();
  // 显式初始化一次，别指望 HTML 的 disabled 属性活到脚本跑完
  el.send.disabled = true;
  applyTheme(currentThemeChoice());
  applyFontSettings(loadFontSettings());
  // 侧栏分区折叠态（localStorage）与总管状态点初值
  applySections();
  syncChiefDot();
  // 隐藏层不作为 Tab 焦点：首帧按真实可见性定（窄屏只看轨道）
  applySidebarA11y();
  // 没有落盘会话 = 首屏普通 worker 空会话；表头要跟身份一致
  if (!state.conversationId) {
    el.title.textContent = state.chatKind === "chief" ? chiefDisplayName() : "普通对话";
    el.title.dataset.chatKind = state.chatKind;
    // 首屏空态的起首图标（2026-11-16）：这条启动路径没有经过 clearThread/startNewChat，
    // 不在这里补一次，第一屏就只剩水晶、没人回答「在跟谁说话」。
    syncEmptyMark();
  }

  // 深链：`?view=settings`（或 `?view=settings/连接页 id`）落设置页，
  // `?view=new` 开一个新对话（壳的托盘/快捷方式用得上）
  const deepView = new URLSearchParams(location.search).get("view");
  if (deepView && (deepView.startsWith("settings") || deepView.startsWith("new"))) {
    if (deepView.startsWith("settings")) {
      if (currentRoute() !== "settings") {
        const sub = deepView.slice("settings".length).replace(/^\//, "");
        // 旧深链（?view=settings/context 等）也要继续落对页：注入分区与别名账
        // （archive/service/about、avatars/executor…）都算已知，渲染时由 currentSettingsPage() 认回落点。
        const known =
          SETTINGS_SECTIONS.some((section) => section.id === sub) ||
          INJECT_TABS.some((tab) => tab.route === sub) ||
          sub in SETTINGS_ALIASES;
        go("settings", known ? sub : undefined);
      }
    } else {
      // 普通助手（worker）2026-11-23 退役：`?view=new` 曾经是「开一个新对话」，
      // 现在只剩一种新建——建一张派给池的任务票（弹窗与侧栏 ⋯ / Ctrl+K 同一份）。
      go("chat");
      void import("./tasks-create.js").then((module) => module.openCreateTaskModal());
    }
    // 用掉就清掉，否则以后每次刷新都被它拽回同一个地方
    const clean = new URL(location.href);
    clean.searchParams.delete("view");
    history.replaceState(null, "", clean.toString());
  }

  await checkHealth();
  await loadChats();
  // 对话逐字浮现开关（2026-11-13）：首屏拉一次，没回来前按默认开跑。
  void ensureFlag("CHAT_STREAM_REVEAL", true).then((value) => {
    state.chatRevealFlag = value;
  });
  // 布局调试（2026-11-24）：盒树探针恒定挂上（只读、不渲染，agent 量测随时可用）；
  // 描边由插件中心「布局调试描边」控制，开着才加 class，刷新页面生效。
  void import("./dev-inspect.js").then((module) => {
    module.initDevInspect();
  });
  void ensureFlag("DEV_LAYOUT_INSPECT", false).then((enabled) => {
    if (enabled) document.documentElement.classList.add("dev-box");
  });
  // 工具块分页展开（2026-11-24）：首屏拉一次；模块内默认开，关掉回到旧形态
  // （展开就是全部、跑动行没有「+N」）。排版时读模块变量，下一次交互生效。
  void ensureFlag("TOOL_CHIP_PAGING", true).then((value) => {
    state.toolChipPagingFlag = value;
    setChipPagingEnabled(value);
  });
  // 交互卡片开关（2026-11-21）：首屏拉一次；渲染期读的是模块内默认值，
  // 开关晚到只影响之后的消息（回滚 CHAT_HTML_CARDS）。
  void ensureFlag("CHAT_HTML_CARDS", true).then((value) => {
    setHtmlCardsEnabled(value);
  });
  initHtmlCards(); // 占位符观察 + 报高监听，全局一份
  // 统一下拉（2026-11-23 样式统一批）：原生 select 渐进增强成自绘面板，选中态 C 版。
  // 等开关回来再启动，关闭时（UI_SELECT_MENU=false）页面就是原生下拉，不做先绘后撤。
  void ensureFlag("UI_SELECT_MENU", true).then((enabled) => {
    if (enabled) initSelectMenus();
  });
  void loadCapabilities(); // 附件 / 编辑重发的开关投影（2026-11-08 4a）
  void loadRoster(); // E4：执事花名册首帧
  void initGroups(); // 群组（2026-11-06 批二）：可用性探测 + 侧栏节首帧
  void refreshModelPill();
  // 侧栏项目区：拿不到工作区就保持隐藏（没根目录谈何项目）
  void refreshProjectPill();
  if (state.conversationId) await openChat(state.conversationId);
  // 首屏落位不走动画（2026-11-19）：刷新后输入框应该已经在最终位置，
  // 而不是从底部升到中间 / 从中间落回底部。
  updateHomeMode({ animate: false });
  // 侧栏「任务中心」的进行中徽标：静默拉一次，读不到就只当没有；
  // 之后由 autoSyncTick 低频兜底（看板 20s / 对话页 60s），SSE 事件到达时直接增量更新。
  void loadTickets({ silent: true, render: false });
  wireSearchPage();
  applyRoute();
  setInterval(checkHealth, 8000);
  setInterval(autoSyncTick, 5000);
  // 审批浮窗（2026-11-08）：全局待审批 5 秒一拉，右下角常驻——人在哪都能当场批
  void refreshApprovalPopups();
  startApprovalPopWatch();
  // 问候语跨段自动换（2026-11-07）：窗口常开着过夜也不能一直挂着「晚安」。
  // 一分钟查一次就够——换段是整点的事，没人会盯着这一秒；
  // 换句带淡出淡入（2026-11-19，见 shell.js 的 swapGreetingText）：只改文本、
  // 不重建 DOM，动画从头到尾是它自己的事，不会闪、也不会被打断。
  setInterval(() => {
    if (el.viewChat.dataset.home === "1") syncGreeting();
  }, 60_000);
})();
