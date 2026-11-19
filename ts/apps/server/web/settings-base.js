/**
 * 设置页骨架与分区导航
 *
 * 2026-11-13 从 web/app.js（25,467 行单文件）按职责拆出；正文是原文搬运，未改写行为。
 * 原文件只有一个作用域、函数互调没有固定方向，拆开后模块之间必然互相 import（环）。
 * ESM 允许循环引用，前提是模块顶层求值时不向别的模块取值；本层把启动代码全放在入口
 * app.js 文末，各模块顶层只做声明、常量与事件监听注册。
 */

import { el } from "./dom.js";
import { esc } from "./markdown.js";
import { go } from "./route.js";

/* ── 设置页 ───────────────────────────────────────────── */

/* 主题色（2026-11-14 从 3 档扩到 10 档 + 自定义取色）。
   前 3 档是手机端色板原色，不动；后面 7 档按同一套明度重排：
   浅底用深一档、夜主题用提亮一档（成对值写在 style-01-tokens.css 里）。
   chip 只用来画圆点本身，不参与计算。 */
const ACCENTS = [
  { id: "indigo", name: "靛蓝", chip: "#3e4a8c" },
  { id: "gold", name: "暖金", chip: "#b89b6e" },
  { id: "amber", name: "琥珀", chip: "#e0a84a" },
  { id: "rose", name: "玫瑰", chip: "#b4556a" },
  { id: "pine", name: "松绿", chip: "#3f6f5a" },
  { id: "azure", name: "石青", chip: "#2f6b8f" },
  { id: "clay", name: "赭石", chip: "#9c5a3c" },
  { id: "lilac", name: "藤紫", chip: "#6b5b95" },
  { id: "slate", name: "墨灰", chip: "#4a505a" },
  { id: "coral", name: "珊瑚", chip: "#c06a4f" },
];

/** 自定义取色的默认值（用户没选过时色盘停在这里） */
const DEFAULT_CUSTOM_ACCENT = "#3e4a8c";


// 每项 icon 是 Lucide 0.468 官方图标的内部图元（24 视框，外层 svg 统一给属性），
// 不再只存一条 path：Lucide 里 bells/server 等多图元图标拼不出来。
// 2026-11-18：本表只是**注册表**（id / label / icon / desc），不再决定左栏顺序；
// 顺序与分组在下面 SETTINGS_GROUPS 里。
const SETTINGS_SECTIONS = [
  {
    id: "appearance",
    label: "外观",
    desc: "主题、字体、气泡与动效",
    icon: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  },
  {
    id: "chats",
    label: "会话",
    desc: "搜索、归档、回车发送与上下文压缩",
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  },
  {
    /**
     * Agent 合并分区（2026-11-17 用户口径）：人设 / 上下文 / 工具 / 派活 四页收成一个入口，
     * 左栏只占一行，内容顶部用一条四分段 tab 切换。四页原来的 hash 各自保留
     * （#/settings/partners、/context、/tools、/executor），老书签与跨页跳转不用改；
     * 分区 → tab 的映射表在下面 AGENT_TABS，currentSettingsPage() 把四个旧 id 都认成 agent。
     * Lucide bot：机器人头 = 「这个 Agent 本身」，比四个旧图标里任何一个都更像总入口。
     */
    id: "agent",
    label: "Agent",
    desc: "人设、上下文、工具与派活：发出去的那条消息由谁、带什么、谁来干",
    icon: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  },
  {
    id: "projects",
    label: "项目",
    desc: "工作区与项目容器：一个项目可以带多个文件夹",
    icon: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  },
  {
    id: "reminders",
    label: "定时任务",
    desc: "周期任务与到点提醒；页面开着才有桌面通知",
    icon: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  },
  {
    /**
     * 本机合并分区（2026-11-18 用户口径）：连接 + 服务 + 关于 三页收成一个入口——
     * 配对/中继/设备、通知/鉴权、Node 运行时、版本，说的都是「这台电脑这件事」。
     * 三页竖排一页（连接是操作顺序流，服务与关于只是几张小卡，不值得再挂 tab）。
     * id 保留 connect：连接页的两个轮询守卫、旧书签都不用动；旧 /service、/about 由
     * SETTINGS_ALIASES 别名到这里。Lucide monitor：这台机器本身。
     */
    id: "connect",
    label: "本机",
    desc: "连接手机 / 平板、通知与鉴权、Node 运行时、版本",
    icon: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  },
  {
    id: "models",
    label: "模型",
    desc: "默认模型、供应商与 API Key",
    // Lucide sparkles 0.468 完整五图元：模型/生成的通用记号（2026-11-09 从服务页拆出）
    icon: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  },
  {
    id: "plugins",
    label: "插件",
    desc: "功能开关中心：默认开，按需关",
    // Lucide puzzle 0.468 完整图元：插件 = 一块拼进来的能力，和「卡片墙 + 开关」同义。
    icon: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  },
  {
    id: "usage",
    label: "用量",
    desc: "token 用量：累计、按模型占比、按天明细",
    // 2026-11-13 从服务页独立：累计 token 一行标签撑不起「总量 / 按模型 / 明细」三层信息。
    // Lucide chart-column：一眼认出是统计，不用把「用量」读成才懂。
    icon: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  },
  {
    id: "memory",
    label: "记忆",
    desc: "长期记忆：看过什么、记住什么",
    // Lucide brain 0.468 完整八图元（2026-11-06）：只取左右两瓣会画成「（ ）」，
    // 内部的沟回才是让它在 15px 下仍认得出是「脑」的部分。
    icon: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  },
  // 2026-11-17：「人设」并入 Agent 分区（见上）；旧路由 #/settings/partners 仍可达，
  // 由 currentSettingsPage() 别名到 agent、currentAgentTab() 认回「人设」这个 tab。
  {
    id: "skills",
    label: "技能",
    desc: "给 AI 的操作手册：可开关、可导入",
    // 2026-11-08 扫尾批 9-S：技能 = 给 AI 的操作手册，用 book-open 比拼图更贴"手册"这件事
    icon: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  },
];

/**
 * Agent 分区里的四个 tab（2026-11-17 合并）。
 *
 * `id` 是 tab 标识（currentAgentTab() 的返回值），`route` 是它保留的**旧设置子路由**：
 * tab 切换就是切到那条旧 hash，这样老书签、抽屉里的「去编辑这个人」、上下文页里的人设链接
 * 全都不用改。顺序 = 左到右：先「是谁」，再「看到什么 / 能用什么」，最后「活派给谁」。
 * 第一个 tab 是人设，也是 #/settings/agent（不带子路由）的默认落点。
 */
const AGENT_TABS = [
  {
    id: "personas",
    label: "人设",
    blurb: "是谁",
    route: "partners",
    icon: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  },
  {
    id: "context",
    label: "上下文",
    blurb: "看到什么",
    route: "context",
    icon: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  },
  {
    id: "tools",
    label: "工具",
    blurb: "能做什么",
    route: "tools",
    icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  },
  {
    id: "executor",
    label: "派活",
    blurb: "谁去干",
    route: "executor",
    icon: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  },
];

/**
 * 旧分区 id → 现在的落点（合并后的别名账，currentSettingsPage() 与 app.js 深链共用一份）。
 * 2026-11-07 sessions→chats、avatars→agent；2026-11-18 归档并入会话、服务与关于并入本机。
 * 别名只管「落到哪个分区」，具体 tab / 子页由各自的判断函数再从 hash 认。
 */
const SETTINGS_ALIASES = {
  sessions: "chats",
  avatars: "agent",
  archive: "chats",
  service: "connect",
  about: "connect",
};

/**
 * 内容顶部的四分区导航（2026-11-18 改版）。
 *
 * 四张卡是「这个 Agent 的四个侧面」：是谁 / 看到什么 / 能做什么 / 谁去干。
 * 每张卡 = 图标 + 名称 + 一句两三个字的注脚；选中卡走强调色描边 + 图标底，
 * 不再是四个挤在一起的小文字按钮。点击仍由 wireAgentTabs() 接（走旧 hash 子路由）。
 */
function agentTabsMarkup(activeTab) {
  return `<div class="set-tabs" role="tablist" aria-label="Agent 分区">
    ${AGENT_TABS.map(
      (tab) =>
        `<button class="set-tab" type="button" role="tab"
           data-agent-tab="${tab.id}" aria-selected="${tab.id === activeTab}">
           <span class="set-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${tab.icon}</svg></span>
           <span class="set-tab-text">
             <span class="set-tab-label">${tab.label}</span>
             <span class="set-tab-blurb">${tab.blurb}</span>
           </span>
         </button>`,
    ).join("")}
  </div>`;
}

/**
 * 左栏一级菜单的分组与顺序（2026-11-18 用户口径：把一级菜单的排序理一理）。
 *
 * 分组只决定**怎么读**，不决定权限或路由：三个标题把 11 项分成
 * 「日常（每天碰的界面与工作流）/ Agent（这个 Agent 本身）/ 系统（计量、开关与这台机器）」。
 * 数组顺序 = 显示顺序；SETTINGS_SECTIONS 退成纯注册表（id / label / icon / desc）。
 * 新加分区忘了写进这里也不会消失：会落在末尾的「其他」组里（见 renderSettingsNav）。
 */
const SETTINGS_GROUPS = [
  { label: "日常", ids: ["appearance", "chats", "projects", "reminders"] },
  { label: "Agent", ids: ["agent", "models", "skills", "memory"] },
  { label: "系统", ids: ["usage", "plugins", "connect"] },
];

/**
 * 设置页左侧分区导航：点击真切页（hash 子路由），一次只渲染当前分区。
 * 形态同 cindy 的 SettingsSidebarNav：36px 胶囊行 + 15px 图标，选中走中性底。
 * 2026-11-18 起按 SETTINGS_GROUPS 分组，组前一行小标题；标题只当分隔，不可点。
 */
function renderSettingsNav(page) {
  el.settingsNav.replaceChildren();
  el.settingsNav.setAttribute("role", "tablist");
  const sectionById = new Map(SETTINGS_SECTIONS.map((section) => [section.id, section]));
  const groups = SETTINGS_GROUPS.map((group) => ({ ...group }));
  const ungrouped = SETTINGS_SECTIONS.filter(
    (section) => !groups.some((group) => group.ids.includes(section.id)),
  );
  if (ungrouped.length) groups.push({ label: "其他", ids: ungrouped.map((section) => section.id) });

  for (const group of groups) {
    const caption = document.createElement("div");
    caption.className = "set-nav-group";
    // tablist 里只该有 tab；标题是纯展示，交给读屏跳过
    caption.setAttribute("role", "presentation");
    caption.textContent = group.label;
    el.settingsNav.append(caption);
    for (const id of group.ids) {
      const section = sectionById.get(id);
      if (!section) continue; // 分组表写错 id 时不静默丢项：其余照常渲染
      const button = document.createElement("button");
      button.type = "button";
      button.id = `settings-tab-${section.id}`;
      button.dataset.section = section.id;
      // 左栏分区不做悬停浮签（2026-11-14 用户拍板：没人会看，标签本身已经说清去哪）。
      // desc 仍留在分区表里，留给以后可能用到的说明文案。
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(section.id === page));
      button.setAttribute("aria-controls", "settings-inner");
      button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${section.icon}</svg><span>${section.label}</span>`;
      button.addEventListener("click", () => {
        // 同页再点不重渲染（cindy 同款早退）；跨页改 hash，applyRoute 接手渲染
        if (section.id !== page) go("settings", section.id);
      });
      el.settingsNav.append(button);
    }
  }
}

/**
 * 把查询词在原文里标出来（先按原文切片再转义，别把 & < > 卷进正则）。
 * 大小写不敏感；空查询原样转义返回。
 */
function markQuery(text, query) {
  const raw = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) return esc(raw);
  const lower = raw.toLowerCase();
  const target = needle.toLowerCase();
  let out = "";
  let from = 0;
  let at = lower.indexOf(target);
  while (at !== -1) {
    out += `${esc(raw.slice(from, at))}<mark>${esc(raw.slice(at, at + target.length))}</mark>`;
    from = at + target.length;
    at = lower.indexOf(target, from);
  }
  return out + esc(raw.slice(from));
}

export { ACCENTS, AGENT_TABS, DEFAULT_CUSTOM_ACCENT, SETTINGS_ALIASES, SETTINGS_SECTIONS, agentTabsMarkup, markQuery, renderSettingsNav };
