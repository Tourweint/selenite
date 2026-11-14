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
    id: "projects",
    label: "项目",
    desc: "工作区与项目容器：一个项目可以带多个文件夹",
    icon: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  },
  {
    id: "archive",
    label: "归档",
    desc: "已归档的会话：可恢复，也可永久删除",
    // Lucide archive：会话与项目目录共用同一个「收起、可恢复」的说法（2026-11-12 归档模块）
    icon: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  },
  {
    id: "reminders",
    label: "定时任务",
    desc: "周期任务与到点提醒；页面开着才有桌面通知",
    icon: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  },
  {
    id: "connect",
    label: "连接",
    desc: "手机 / 平板配对与链路：本地直连或经中继",
    icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  },
  {
    id: "models",
    label: "模型",
    desc: "默认模型、供应商与 API Key",
    // Lucide sparkles 0.468 完整五图元：模型/生成的通用记号（2026-11-09 从服务页拆出）
    icon: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  },
  {
    id: "service",
    label: "服务",
    desc: "桌面通知、鉴权与运行时",
    icon: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
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
  // 2026-11-07：「头像」不再单开分区——头像并进「人设」（执事页的编辑弹窗），
  // 因为它和 SOUL 回答的是同一个问题「这个角色是谁」。旧路由 #/settings/avatars
  // 由 currentSettingsPage() 做别名落到 partners，老书签不会 404 成空页。
  {
    id: "partners",
    label: "人设",
    desc: "总管 / 执事 / 领域负责人的设定与头像",
    // Lucide user-round-pen 族：人形 + 笔，表示「改这个角色的设定」
    icon: '<circle cx="10" cy="8" r="5"/><path d="M2 21a8 8 0 0 1 12.9-6.3"/><path d="M18 15l3 3-6 6-3.5.5.5-3.5z"/>',
  },
  {
    id: "skills",
    label: "技能",
    desc: "给 AI 的操作手册：可开关、可导入",
    // 2026-11-08 扫尾批 9-S：技能 = 给 AI 的操作手册，用 book-open 比拼图更贴"手册"这件事
    icon: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  },
  {
    id: "about",
    label: "关于",
    desc: "版本、开源协议与致谢",
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  },
];

/**
 * 设置页左侧分区导航：点击真切页（hash 子路由），一次只渲染当前分区。
 * 形态同 cindy 的 SettingsSidebarNav：36px 胶囊行 + 15px 图标，选中走中性底。
 */
function renderSettingsNav(page) {
  el.settingsNav.replaceChildren();
  el.settingsNav.setAttribute("role", "tablist");
  for (const section of SETTINGS_SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `settings-tab-${section.id}`;
    button.dataset.section = section.id;
    // 左栏分区不做悬停浮签（2026-11-14 用户拍板：没人会看，标签本身已经说清去哪）。
    // 左栏分区不做悬停浮签（用户 2026-11-14 口径：「没人会看」）；
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

export { ACCENTS, DEFAULT_CUSTOM_ACCENT, SETTINGS_SECTIONS, markQuery, renderSettingsNav };
